import { sql, type PostgresAdapter } from "@payloadcms/db-postgres";
import { Forbidden, Locked, NotFound, type PayloadRequest } from "payload";

import { EditorialError } from "./errors";

/** Uses the exact Payload transaction; falling back to the pool is unsafe. */
export const editorialTransaction = async (req: PayloadRequest) => {
  const transactionID = await req.transactionID;
  if (!transactionID) throw new EditorialError("TRANSACTION_REQUIRED", 503);
  const adapter = req.payload.db as unknown as Pick<
    PostgresAdapter,
    "sessions"
  >;
  const session = adapter.sessions?.[String(transactionID)];
  if (!session) throw new EditorialError("TRANSACTION_REQUIRED", 503);
  return session.db;
};

// lock_not_available, deadlock_detected and query_canceled: another transaction
// held the key too long. Any other failure did not meet a busy key.
const BUSY_SQLSTATES: ReadonlySet<unknown> = new Set([
  "55P03",
  "40P01",
  "57014",
]);

/** Drizzle keeps the driver's error, with its SQLSTATE, as `cause`. */
const sqlState = (error: unknown): unknown =>
  (error as { cause?: { code?: unknown } } | null)?.cause?.code;

export const lockEditorialKey = async (
  req: PayloadRequest,
  key: string,
): Promise<void> => {
  const db = await editorialTransaction(req);
  try {
    await db.execute(sql`SET LOCAL lock_timeout = '5s'`);
    await db.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`moya-editorial:${key}`}, 0))`,
    );
  } catch (error) {
    if (BUSY_SQLSTATES.has(sqlState(error)))
      throw new EditorialError("CONCURRENT_OPERATION_BUSY", 409);
    throw error;
  }
};

/**
 * A failed COMMIT never reaches the caller: drizzle rethrows it into a promise
 * beginTransaction has already swallowed (@payloadcms/drizzle
 * dist/transactions/beginTransaction.js), and commitTransaction returns quietly for
 * a session Payload already rolled back after a failed read inside the work. So
 * PostgreSQL is asked, on a connection of its own. Anything but `committed`,
 * including no answer, is unknown: the same key can be retried either way.
 */
const assertCommitted = async (req: PayloadRequest, xid: unknown) => {
  const { drizzle } = req.payload.db as unknown as Pick<
    PostgresAdapter,
    "drizzle"
  >;
  let status: unknown;
  try {
    const { rows } = await drizzle.execute(
      sql`SELECT pg_xact_status(${String(xid)}::xid8) AS status`,
    );
    status = rows[0]?.status;
  } catch {
    // No answer is not a failed commit: it stays unknown.
  }
  if (status !== "committed") {
    req.payload.logger.error({ category: "EDITORIAL_COMMIT_UNCONFIRMED" });
    throw new EditorialError("OUTCOME_UNKNOWN", 503);
  }
};

export const withEditorialTransaction = async <T>(
  req: PayloadRequest,
  work: () => Promise<T>,
): Promise<T> => {
  if (req.transactionID) return work();
  const transactionID = await req.payload.db.beginTransaction();
  if (!transactionID) throw new EditorialError("TRANSACTION_REQUIRED", 503);
  req.transactionID = transactionID;
  try {
    const db = await editorialTransaction(req);
    const { rows } = await db.execute(
      sql`SELECT pg_current_xact_id()::text AS xid`,
    );
    const result = await work();
    await req.payload.db.commitTransaction(transactionID);
    await assertCommitted(req, rows[0]?.xid);
    return result;
  } catch (error) {
    await req.payload.db.rollbackTransaction(transactionID);
    // Payload's Locked carries a sentence, not a code. The same refusal on the
    // native REST path stays Payload's own 423.
    throw error instanceof Locked
      ? new EditorialError("DOCUMENT_LOCKED", 423)
      : error;
  } finally {
    delete req.transactionID;
  }
};

// numeric_value_out_of_range and invalid_text_representation: an id the integer
// column cannot hold, such as 3000000000 or "12.5", so no such record can exist.
const IMPOSSIBLE_ID_SQLSTATES: ReadonlySet<unknown> = new Set([
  "22003",
  "22P02",
]);

/** A read that truly found nothing. Any other failure stays what it is. */
export const isMissingRecord = (error: unknown): boolean =>
  error instanceof NotFound ||
  error instanceof Forbidden ||
  IMPOSSIBLE_ID_SQLSTATES.has(sqlState(error));

/** Answered from a stored rejected receipt, not from a new attempt. */
export class ReplayedEditorialError extends EditorialError {
  readonly replayed = true;

  constructor(code: string) {
    super(code, 409);
  }
}

// Refusals the same command can get past once something else changes: the key,
// the Owner's open document, the account's scope, the images, the record or what
// it references. Payload refusals, which are not EditorialError, write no receipt
// either.
const RETRYABLE_REFUSALS: ReadonlySet<string> = new Set([
  "ALREADY_PUBLISHED",
  "CATALOG_DELIVERY_PREPARATION_REQUIRED",
  "CATALOG_OUT_OF_SCOPE",
  "CONCURRENT_OPERATION_BUSY",
  "DOCUMENT_LOCKED",
  "RECORD_UNAVAILABLE",
  "REFERENCE_NOT_FOUND",
  "REFERENCE_NOT_PUBLISHED",
]);

/**
 * A rejected receipt answers its key forever, so only a refusal the command would
 * meet again earns one. Status 5xx says the server failed, not the command. A
 * receipt written before this rule stays, because a key's receipt cannot be replaced.
 */
export const writesRejectedReceipt = (
  error: unknown,
): error is EditorialError =>
  error instanceof EditorialError &&
  !(error instanceof ReplayedEditorialError) &&
  error.status < 500 &&
  error.code !== "IDEMPOTENCY_CONFLICT" &&
  !RETRYABLE_REFUSALS.has(error.code);

const supersededIntents = new WeakMap<object, string[]>();

export const noteSupersededIntents = (
  req: PayloadRequest,
  ids: readonly string[],
) => {
  supersededIntents.get(req)?.push(...ids);
};

/** The delivery intents a save's afterChange hook ended, for that save's answer. */
export const collectingSupersededIntents = async <T>(
  req: PayloadRequest,
  save: () => Promise<T>,
): Promise<{ readonly saved: T; readonly superseded: readonly string[] }> => {
  const superseded: string[] = [];
  supersededIntents.set(req, superseded);
  try {
    return { saved: await save(), superseded };
  } finally {
    supersededIntents.delete(req);
  }
};
