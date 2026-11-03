import { sql, type PostgresAdapter } from "@payloadcms/db-postgres";
import {
  ADMIN_MCP_COMPLIANCE_PHRASES,
  ADMIN_MCP_DEFAULT_THRESHOLD,
  ADMIN_MCP_SENSITIVE_CATEGORIES,
  AI_POLICY_DISCLOSURE,
} from "@moya/contracts/internal/admin-mcp";
import type { AdminMcpControlPage } from "@moya/contracts/internal/admin-mcp";
import type { Payload, PayloadRequest } from "payload";

import { CONTROL_SLUG, SWITCH_LABELS } from "./global";

const EXPIRING_WITHIN_MS = 7 * 24 * 60 * 60 * 1000;

/** Section 21's p95 budgets, by the tools that exist. Each slice adds its own. */
const TOOL_BUDGET_MS: Readonly<Record<string, number>> = { admin_whoami: 100 };

const auditFigures = async (
  payload: Payload,
): Promise<AdminMcpControlPage["figures"]> => {
  const { drizzle } = payload.db as unknown as Pick<PostgresAdapter, "drizzle">;
  const { rows: timings } = await drizzle.execute(sql`
    SELECT tool, count(*) AS calls,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_ms
    FROM mcp_audit_events
    WHERE phase = 'finish' AND tool IS NOT NULL
      AND at > now() - interval '7 days'
    GROUP BY tool ORDER BY tool`);
  const { rows: irreversible } = await drizzle.execute(sql`
    SELECT coalesce(sum(coalesce(count, 1)), 0) AS targets
    FROM mcp_audit_events
    WHERE class = 'irreversible' AND phase = 'finish' AND ok
      AND at > now() - interval '24 hours'`);
  const { rows: unknown } = await drizzle.execute(sql`
    SELECT count(*) AS calls
    FROM mcp_audit_events AS started
    WHERE started.phase = 'start'
      AND started.at > now() - interval '7 days'
      AND started.at < now() - interval '5 minutes'
      AND NOT EXISTS (
        SELECT 1 FROM mcp_audit_events AS finished
        WHERE finished.call_id = started.call_id AND finished.phase = 'finish'
      )`);
  return {
    irreversibleTargets: Number(irreversible[0]?.targets ?? 0),
    outcomeUnknown: Number(unknown[0]?.calls ?? 0),
    timings: timings.map((row) => ({
      tool: String(row.tool),
      calls: Number(row.calls),
      p95Ms: Math.round(Number(row.p95_ms)),
      budgetMs: TOOL_BUDGET_MS[String(row.tool)] ?? null,
    })),
  };
};

/** Read with the Owner's own session, so the reserved-surface rules still decide. */
export const readControlPage = async (
  req: PayloadRequest,
): Promise<AdminMcpControlPage> => {
  const { payload } = req;
  const control = await payload.findGlobal({
    slug: CONTROL_SLUG,
    req,
    overrideAccess: false,
    depth: 0,
  });
  const { docs: keys } = await payload.find({
    collection: "payload-mcp-api-keys",
    req,
    overrideAccess: false,
    depth: 0,
    limit: 50,
    // The latest 50, so ones long expired never push out a key about to lapse.
    sort: "-expiresAt",
    select: { label: true, expiresAt: true, lastUsedAt: true },
    where: {
      and: [
        { enableAPIKey: { equals: true } },
        {
          or: [
            { expiresAt: { exists: false } },
            {
              expiresAt: {
                less_than: new Date(
                  Date.now() + EXPIRING_WITHIN_MS,
                ).toISOString(),
              },
            },
          ],
        },
      ],
    },
  });
  let figures: AdminMcpControlPage["figures"] = null;
  try {
    figures = await auditFigures(payload);
  } catch {
    req.payload.logger.error({ category: "ADMIN_MCP_CONTROL_READ_FAILED" });
  }
  return {
    pause: control.pause === true,
    threshold: control.threshold ?? ADMIN_MCP_DEFAULT_THRESHOLD,
    switches: ADMIN_MCP_SENSITIVE_CATEGORIES.map((category) => ({
      category,
      label: SWITCH_LABELS[category],
      open: control[category] === true,
      openedAt: control[`${category}OpenedAt` as const] ?? null,
      policyCovers: AI_POLICY_DISCLOSURE[category],
      phrase: ADMIN_MCP_COMPLIANCE_PHRASES[category],
    })),
    expiringKeys: [...keys].reverse().map((key) => ({
      id: key.id,
      label: key.label ?? null,
      expiresAt: key.expiresAt ?? null,
      lastUsedAt: key.lastUsedAt ?? null,
    })),
    figures,
  };
};
