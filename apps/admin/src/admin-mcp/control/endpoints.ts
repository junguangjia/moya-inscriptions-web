import { randomUUID } from "node:crypto";

import { ADMIN_MCP_KEY_LIFETIME_MS } from "@moya/contracts/internal/admin-mcp";
import type { Endpoint, PayloadRequest } from "payload";

import { isHumanOwner } from "../../editorial/access";
import { writeAuditEvent } from "../audit";
import { cancelRun, confirmRun } from "../runs/ledger";
import type { LedgerRefusal, Settled } from "../runs/ledger";

const privateHeaders = { "cache-control": "private, no-store" };

const refuse = (error: string, status: number) =>
  Response.json({ error }, { status, headers: privateHeaders });

/**
 * The Owner browser session alone, from the Admin's own origin. The session cookie is
 * SameSite=Strict; the Origin check is the same second net as analytics/endpoints.ts.
 */
const ownerRefusal = (req: PayloadRequest): Response | undefined => {
  if (!isHumanOwner(req)) return refuse("OWNER_ONLY", 403);
  // Next may normalize req.url to its internal HTTP origin behind Nginx.
  const publicUrl = process.env.CMS_PUBLIC_URL ?? req.url;
  if (!publicUrl || req.headers.get("origin") !== new URL(publicUrl).origin)
    return refuse("ORIGIN_REQUIRED", 403);
  return undefined;
};

const RUN_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SEAL_HASH = /^[a-f0-9]{64}$/u;

/** What the page says of a refusal, by fixed name: the run as the ledger found it. */
const runRefusal = ({ code, issues }: LedgerRefusal): Response => {
  if (code === "NOT_FOUND") return refuse("NOT_FOUND", 404);
  if (code === "CONCURRENT_OPERATION_BUSY")
    return refuse("CONCURRENT_OPERATION_BUSY", 409);
  if (code === "PREVIEW_EXPIRED") return refuse("RUN_EXPIRED", 409);
  if (code === "PREVIEW_STALE") return refuse("RUN_STALE", 409);
  if (code === "RUN_CANCELLED") return refuse("RUN_CANCELLED", 409);
  if (issues?.some(({ code: issue }) => issue === "seal_hash_changed"))
    return refuse("SEAL_HASH_MISMATCH", 409);
  return refuse("RUN_NOT_AWAITING", 409);
};

const bodyOf = async (
  req: PayloadRequest,
): Promise<Readonly<Record<string, unknown>>> => {
  const body = (await req.json?.().catch(() => null)) as unknown;
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
};

/**
 * A run's confirmation or cancel by the Owner (admin-mcp-completion-v1 section 13).
 * What the request says is checked first; then a reserved start row, so a change the
 * ledger cannot record never happens; then the run's own compare-and-set; then the
 * finish row. A finish that cannot be written leaves the start: outcome unknown.
 */
const ownerRunAction =
  <Sent>(
    op: "mcp-control.confirm-run" | "mcp-control.cancel-run",
    read: (body: Readonly<Record<string, unknown>>) => Sent | Response,
    act: (
      req: PayloadRequest,
      runId: string,
      sent: Sent,
    ) => Promise<Settled | LedgerRefusal>,
  ): Endpoint["handler"] =>
  async (req) => {
    const refused = ownerRefusal(req);
    if (refused !== undefined) return refused;
    const runId = String(req.routeParams?.id ?? "");
    if (!RUN_ID.test(runId)) return refuse("NOT_FOUND", 404);
    const sent = read(await bodyOf(req));
    if (sent instanceof Response) return sent;
    const row = {
      callId: randomUUID(),
      class: "reserved" as const,
      op,
      targetType: "mcp-run",
      targetId: runId,
      runId,
      userId: String(req.user!.id),
    };
    try {
      await writeAuditEvent(req.payload, { ...row, phase: "start" });
    } catch {
      req.payload.logger.error({ category: "ADMIN_MCP_AUDIT_WRITE_FAILED" });
      return refuse("AUDIT_UNAVAILABLE", 503);
    }
    let outcome: Settled | LedgerRefusal | undefined;
    try {
      outcome = await act(req, runId, sent);
    } catch {
      // The trigger's second net, or a lost compare-and-set: nothing moved.
      outcome = undefined;
    }
    try {
      await writeAuditEvent(req.payload, {
        ...row,
        phase: "finish",
        ok: outcome?.ok === true,
        code:
          outcome === undefined
            ? "OPERATION_REFUSED"
            : outcome.ok
              ? "OK"
              : outcome.code,
      });
    } catch {
      req.payload.logger.error({ category: "ADMIN_MCP_AUDIT_WRITE_FAILED" });
    }
    if (outcome === undefined) return refuse("RUN_ACTION_FAILED", 409);
    if (!outcome.ok) return runRefusal(outcome);
    return Response.json(
      {
        state: outcome.run.state,
        ...(outcome.already ? { already: true } : {}),
      },
      { headers: privateHeaders },
    );
  };

/**
 * The control page's routes. A key renews by one click, and the server sets the date,
 * so a browser clock running ahead cannot trip the 30-day cap. A run past the Owner's
 * threshold is confirmed once, bound to the seal the page showed, or it is cancelled.
 */
export const mcpControlEndpoints: Endpoint[] = [
  {
    path: "/mcp-control/keys/:id/renew",
    method: "post",
    handler: async (req) => {
      const refused = ownerRefusal(req);
      if (refused !== undefined) return refused;
      const id = Number(req.routeParams?.id);
      if (!Number.isSafeInteger(id) || id < 1) return refuse("NOT_FOUND", 404);
      try {
        const { expiresAt } = await req.payload.update({
          collection: "payload-mcp-api-keys",
          id,
          req,
          overrideAccess: false,
          depth: 0,
          select: { expiresAt: true },
          data: {
            expiresAt: new Date(
              Date.now() + ADMIN_MCP_KEY_LIFETIME_MS,
            ).toISOString(),
          },
        });
        return Response.json({ expiresAt }, { headers: privateHeaders });
      } catch {
        return refuse("RENEW_FAILED", 409);
      }
    },
  },
  {
    path: "/mcp-control/runs/:id/confirm",
    method: "post",
    handler: ownerRunAction(
      "mcp-control.confirm-run",
      ({ expectedSealHash }) =>
        typeof expectedSealHash === "string" && SEAL_HASH.test(expectedSealHash)
          ? expectedSealHash
          : refuse("SEAL_HASH_REQUIRED", 400),
      (req, runId, expectedSealHash) =>
        confirmRun(req.payload, {
          runId,
          ownerId: Number(req.user!.id),
          expectedSealHash,
        }),
    ),
  },
  {
    path: "/mcp-control/runs/:id/cancel",
    method: "post",
    handler: ownerRunAction(
      "mcp-control.cancel-run",
      () => null,
      (req, runId) => cancelRun(req.payload, "owner", runId),
    ),
  },
];
