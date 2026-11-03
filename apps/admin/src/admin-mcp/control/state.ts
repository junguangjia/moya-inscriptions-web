import { sql, type PostgresAdapter } from "@payloadcms/db-postgres";
import type { AdminMcpSensitiveCategory } from "@moya/contracts/internal/admin-mcp";
import type { Payload, PayloadRequest } from "payload";

export interface AdminMcpControl extends Readonly<
  Record<AdminMcpSensitiveCategory, boolean>
> {
  readonly pause: boolean;
  readonly threshold: number;
}

/**
 * The one row the migration seeds and a singleton index keeps alone, uncached, on
 * the pool: never a business transaction. A missing row throws, so the door stays
 * shut rather than reading it as not paused.
 */
export const readMcpControl = async (
  payload: Payload,
): Promise<AdminMcpControl> => {
  const { drizzle } = payload.db as unknown as Pick<PostgresAdapter, "drizzle">;
  const { rows } = await drizzle.execute(sql`
    SELECT pause, threshold, dm, evidence, raw_ip, self_only FROM mcp_control`);
  const row = rows[0];
  if (row === undefined) throw new Error("MCP_CONTROL_ROW_MISSING");
  return {
    pause: row.pause === true,
    threshold: Number(row.threshold),
    dm: row.dm === true,
    evidence: row.evidence === true,
    rawIp: row.raw_ip === true,
    selfOnly: row.self_only === true,
  };
};

const requestControls = new WeakMap<PayloadRequest, AdminMcpControl>();

/**
 * Read once per request: the door decides, and a tool sees the same answer. A pause
 * saved after that read stops the next request, not this one, so anything that must
 * see it mid-request, such as a run between targets, calls readMcpControl.
 */
export const controlFor = async (
  req: PayloadRequest,
): Promise<AdminMcpControl> => {
  const known = requestControls.get(req);
  if (known !== undefined) return known;
  const control = await readMcpControl(req.payload);
  requestControls.set(req, control);
  return control;
};
