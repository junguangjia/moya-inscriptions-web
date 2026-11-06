import { AI_OPERATOR_LABEL } from "@moya/contracts/internal/admin-mcp";

/**
 * What ends an AI write that waits (admin-mcp-completion-v1 section 7). The Backend does
 * not stop on Admin's abort, so without this a write stuck behind a lock would keep its
 * connection after its slot came free, and retries would take the App pool from the
 * public site. Each statement ends itself inside Admin's 15 s call: the transaction rolls
 * back, the route answers 500 and the client reads OUTCOME_UNKNOWN, which is true and
 * safe to retry. One statement, before any lock. The Owner's label takes no limit.
 */
const AI_WRITE_LIMIT_SQL =
  "SELECT set_config('lock_timeout','8s',true),set_config('statement_timeout','8s',true)";

export const limitAiWrite = async (
  operator: string | undefined,
  query: (sql: string) => Promise<unknown>,
): Promise<void> => {
  if (operator === AI_OPERATOR_LABEL) await query(AI_WRITE_LIMIT_SQL);
};
