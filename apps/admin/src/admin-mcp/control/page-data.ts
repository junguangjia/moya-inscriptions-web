import { sql, type PostgresAdapter } from "@payloadcms/db-postgres";
import {
  ADMIN_MCP_COMPLIANCE_PHRASES,
  ADMIN_MCP_SENSITIVE_CATEGORIES,
  ADMIN_PREVIEW_CONSEQUENCE_CODES,
  ADMIN_PREVIEW_ROWS_MAX,
  ADMIN_PREVIEW_SAMPLE_MAX,
  ADMIN_RUN_EXECUTE_MAX,
  AI_POLICY_DISCLOSURE,
  adminPreviewDataSchema,
} from "@moya/contracts/internal/admin-mcp";
import type {
  AdminMcpAwaitingRun,
  AdminMcpControlPage,
  AdminMcpStalledRun,
} from "@moya/contracts/internal/admin-mcp";
import type { Payload, PayloadRequest } from "payload";

import { readOwnerRuns, readPreviewFacts } from "../runs/ledger";
import type { LedgerRun } from "../runs/ledger";
import { CONTROL_SLUG, SWITCH_LABELS } from "./global";

const EXPIRING_WITHIN_MS = 7 * 24 * 60 * 60 * 1000;
/** Runs the page lists in each section; the oldest waits come first. */
const RUNS_LISTED = 50;

/**
 * Section 21's p95 budgets, by the tools that exist. Each slice adds its own. Each is
 * for one call: a batch past what one call holds, and a run's execute call, get a row
 * with no budget.
 */
const TOOL_BUDGET_MS: Readonly<Record<string, number>> = {
  admin_whoami: 100,
  admin_execute: 800,
  // Up to 100 targets; a 5,000-row freeze is L1's 8 s class, not one call's budget.
  admin_preview: 1_500,
};

/** Its budget holds up to 100 targets a call; any other tool's holds one. */
const PREVIEW_TOOL = "admin_preview";

const KIND_ORDER = ["one", "batch", "run"] as const;
type TimingKind = (typeof KIND_ORDER)[number];

const auditFigures = async (
  payload: Payload,
): Promise<AdminMcpControlPage["figures"]> => {
  const { drizzle } = payload.db as unknown as Pick<PostgresAdapter, "drizzle">;
  // A run's execute call names its run and no op: it runs up to 100 targets.
  const { rows: timings } = await drizzle.execute(sql`
    SELECT tool, kind, count(*) AS calls,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_ms
    FROM (
      SELECT tool, duration_ms,
        CASE WHEN run_id IS NOT NULL AND op IS NULL THEN 'run'
          WHEN coalesce(count, 1) > CASE WHEN tool = ${PREVIEW_TOOL}
            THEN ${ADMIN_RUN_EXECUTE_MAX} ELSE 1 END THEN 'batch'
          ELSE 'one' END AS kind
      FROM mcp_audit_events
      WHERE phase = 'finish' AND tool IS NOT NULL
        AND at > now() - interval '7 days') AS finished
    GROUP BY tool, kind`);
  // A run writes one row per target, with its run id and no tool, beside the row of the
  // call that ran it, so only those count, once each, by credential (section 22).
  const { rows: irreversible } = await drizzle.execute(sql`
    SELECT coalesce('conn:' || connection_id, 'key:' || key_id) AS credential,
      count(*) AS targets
    FROM mcp_audit_events
    WHERE class = 'irreversible' AND phase = 'finish' AND ok
      AND run_id IS NOT NULL AND tool IS NULL
      AND at > now() - interval '24 hours'
    GROUP BY 1 ORDER BY 2 DESC, 1`);
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
  const byCredential = irreversible.map((row) => ({
    credential: String(row.credential),
    targets: Number(row.targets),
  }));
  const kindOf = (row: Record<string, unknown>) => row.kind as TimingKind;
  return {
    irreversibleTargets: byCredential.reduce(
      (sum, { targets }) => sum + targets,
      0,
    ),
    irreversibleByCredential: byCredential,
    outcomeUnknown: Number(unknown[0]?.calls ?? 0),
    timings: [...timings]
      .sort(
        (a, b) =>
          String(a.tool).localeCompare(String(b.tool)) ||
          KIND_ORDER.indexOf(kindOf(a)) - KIND_ORDER.indexOf(kindOf(b)),
      )
      .map((row) => ({
        tool:
          kindOf(row) === "one"
            ? String(row.tool)
            : `${String(row.tool)} (${kindOf(row)})`,
        calls: Number(row.calls),
        p95Ms: Math.round(Number(row.p95_ms)),
        budgetMs:
          kindOf(row) === "one"
            ? (TOOL_BUDGET_MS[String(row.tool)] ?? null)
            : null,
      })),
  };
};

/** By the order the contract names them, so the page reads the same each time. */
const inContractOrder = (codes: readonly string[]) =>
  ADMIN_PREVIEW_CONSEQUENCE_CODES.filter((code) => codes.includes(code));

/**
 * What a waiting run's preview froze: as it was answered when it sealed, or, where
 * that was never recorded, summed again from its targets' rows.
 */
const awaitingOf = async (
  payload: Payload,
  run: LedgerRun,
  labels: ReadonlyMap<string, string>,
): Promise<AdminMcpAwaitingRun> => {
  const common = {
    runId: run.runId,
    op: run.op,
    credential: run.credential,
    credentialLabel: labels.get(run.credential) ?? null,
    reason: run.reason,
    expiresAt: run.expiresAt.toISOString(),
    sealHash: run.sealHash!,
  };
  const shown = adminPreviewDataSchema.safeParse(run.preview);
  if (shown.success) {
    const { data } = shown;
    return {
      ...common,
      count: data.count,
      conflicts: data.conflicts.count,
      impact: data.impact ?? null,
      sample: data.sample.map(({ index, ref }) => ({
        index,
        ref: ref ?? null,
      })),
      consequences: data.consequences,
      userNotifications: data.userNotifications,
      newIdentities: data.newIdentities ?? null,
    };
  }
  const facts = await readPreviewFacts(payload, run.runId, {
    sample: ADMIN_PREVIEW_SAMPLE_MAX,
    rows: ADMIN_PREVIEW_ROWS_MAX,
  });
  const refOf = (ref: Readonly<Record<string, unknown>>) =>
    typeof ref.id === "string" || typeof ref.id === "number" ? ref.id : null;
  return {
    ...common,
    count: run.targetCount - facts.conflicts.count,
    conflicts: facts.conflicts.count,
    impact: Object.keys(facts.impact).length > 0 ? facts.impact : null,
    sample: facts.sample.map(({ index, ref }) => ({ index, ref: refOf(ref) })),
    consequences: inContractOrder(facts.consequences),
    userNotifications: facts.notified,
    newIdentities: facts.newIdentities.count === 0 ? null : facts.newIdentities,
  };
};

const stalledOf = (
  run: LedgerRun,
  labels: ReadonlyMap<string, string>,
): AdminMcpStalledRun => ({
  runId: run.runId,
  op: run.op,
  credential: run.credential,
  credentialLabel: labels.get(run.credential) ?? null,
  state: run.state,
  count: run.targetCount,
  done: run.targetCount - (run.counts.pending ?? 0),
  updatedAt: run.updatedAt.toISOString(),
});

/** Runs waiting for the Owner and runs left stalled, with each key's label. */
const ownerRuns = async (
  req: PayloadRequest,
): Promise<AdminMcpControlPage["runs"]> => {
  const { payload } = req;
  const { awaiting, stalled } = await readOwnerRuns(payload, RUNS_LISTED);
  const keyIds = [
    ...new Set(
      [...awaiting, ...stalled].flatMap(({ credential }) =>
        credential.startsWith("key:") ? [Number(credential.slice(4))] : [],
      ),
    ),
  ];
  const { docs: keys } =
    keyIds.length === 0
      ? { docs: [] }
      : await payload.find({
          collection: "payload-mcp-api-keys",
          req,
          overrideAccess: false,
          depth: 0,
          limit: keyIds.length,
          pagination: false,
          select: { label: true },
          where: { id: { in: keyIds } },
        });
  const labels = new Map(
    keys.flatMap(({ id, label }) =>
      typeof label === "string" && label !== "" ? [[`key:${id}`, label]] : [],
    ),
  );
  return {
    awaiting: await Promise.all(
      awaiting.map((run) => awaitingOf(payload, run, labels)),
    ),
    stalled: stalled.map((run) => stalledOf(run, labels)),
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
  let runs: AdminMcpControlPage["runs"] = null;
  try {
    runs = await ownerRuns(req);
  } catch {
    req.payload.logger.error({ category: "ADMIN_MCP_CONTROL_RUNS_FAILED" });
  }
  let figures: AdminMcpControlPage["figures"] = null;
  try {
    figures = await auditFigures(payload);
  } catch {
    req.payload.logger.error({ category: "ADMIN_MCP_CONTROL_READ_FAILED" });
  }
  return {
    pause: control.pause === true,
    threshold: control.threshold,
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
    runs,
    figures,
  };
};
