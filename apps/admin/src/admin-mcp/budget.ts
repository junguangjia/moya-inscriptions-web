import { sql, type PostgresAdapter } from "@payloadcms/db-postgres";
import { createLocalReq, type PayloadRequest } from "payload";

const BRANCH_STATEMENT_TIMEOUT = "2000ms";

/**
 * admin_execute, checked before each target, and a target runs to its end. A lock wait
 * is 5 s, so the worst case is about 25 s plus auth and audit (section 9).
 */
export const EXECUTE_BUDGET_MS = 10_000;
const QUERY_CANCELED = "57014";

export interface BranchDb {
  execute(query: ReturnType<typeof sql>): Promise<{
    rows: readonly Record<string, unknown>[];
  }>;
}

/**
 * A read's budget, enforced where the SQL runs: its own READ ONLY transaction, because
 * a timeout aborts the transaction it happens in and an abort on this side would not
 * stop the statement. Each statement gets the budget, and waiting on a lock counts.
 */
export const withinBudget = async <T>(
  req: PayloadRequest,
  work: (branch: PayloadRequest, db: BranchDb) => Promise<T>,
): Promise<
  | { readonly status: "ok"; readonly value: T }
  | { readonly status: "timed_out" | "failed" }
> => {
  const { payload } = req;
  const adapter = payload.db as unknown as Pick<PostgresAdapter, "sessions">;
  let transactionID: number | string | undefined;
  try {
    const started = await payload.db.beginTransaction();
    if (started === null) return { status: "failed" };
    transactionID = started;
    const db = adapter.sessions![String(started)]!.db as BranchDb;
    await db.execute(sql`SET TRANSACTION READ ONLY`);
    await db.execute(
      sql.raw(`SET LOCAL statement_timeout = '${BRANCH_STATEMENT_TIMEOUT}'`),
    );
    const branch = await createLocalReq(
      { user: req.user as NonNullable<PayloadRequest["user"]> },
      payload,
    );
    branch.transactionID = started;
    return { status: "ok", value: await work(branch, db) };
  } catch (error) {
    const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
    return { status: code === QUERY_CANCELED ? "timed_out" : "failed" };
  } finally {
    if (transactionID !== undefined)
      await payload.db
        .rollbackTransaction(transactionID)
        .catch(() => undefined);
  }
};
