import { sql, type PostgresAdapter } from "@payloadcms/db-postgres";
import { ADMIN_MCP_DEFAULT_THRESHOLD } from "@moya/contracts/internal/admin-mcp";
import type { AdminMcpSensitiveCategory } from "@moya/contracts/internal/admin-mcp";
import type { Payload, PayloadRequest } from "payload";

export interface AdminMcpControl extends Readonly<
  Record<AdminMcpSensitiveCategory, boolean>
> {
  readonly pause: boolean;
  readonly threshold: number;
}

/** A global has no row until its first save, and these are its starting values. */
const UNSAVED: AdminMcpControl = {
  pause: false,
  threshold: ADMIN_MCP_DEFAULT_THRESHOLD,
  dm: false,
  evidence: false,
  rawIp: false,
  selfOnly: false,
};

/** The row by primary key, uncached, on the pool: never a business transaction. */
export const readMcpControl = async (
  payload: Payload,
): Promise<AdminMcpControl> => {
  const { drizzle } = payload.db as unknown as Pick<PostgresAdapter, "drizzle">;
  const { rows } = await drizzle.execute(sql`
    SELECT pause, threshold, dm, evidence, raw_ip, self_only
    FROM mcp_control ORDER BY id LIMIT 1`);
  const row = rows[0];
  return row === undefined
    ? UNSAVED
    : {
        pause: row.pause === true,
        threshold: Number(row.threshold),
        dm: row.dm === true,
        evidence: row.evidence === true,
        rawIp: row.raw_ip === true,
        selfOnly: row.self_only === true,
      };
};

const requestControls = new WeakMap<PayloadRequest, AdminMcpControl>();

/** Read once per request: the door decides, and a tool sees the same answer. */
export const controlFor = async (
  req: PayloadRequest,
): Promise<AdminMcpControl> => {
  const known = requestControls.get(req);
  if (known !== undefined) return known;
  const control = await readMcpControl(req.payload);
  requestControls.set(req, control);
  return control;
};
