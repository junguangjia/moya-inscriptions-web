import { createHash, randomUUID } from "node:crypto";

import { CommunityConflictError, CommunityNotFoundError } from "@moya/api";
import {
  operatorAccountCapacitySchema,
  workPublishingSettingsSchema,
} from "@moya/contracts/internal/community-operator";
import type {
  AccountCapacityClass,
  OperatorAccountCapacity,
  WorkPublishingSettings,
} from "@moya/contracts/internal/community-operator";
import { WORK_ITEMS_CONFIGURABLE_MAXIMUM } from "@moya/contracts/schemas";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import { asCommunityOperationError } from "../availability.js";

/**
 * Shared transaction, receipt, identity and clock helpers for the work
 * publishing adapters (publishing/*.ts). Author commands keep the exact
 * semantics of PostgresAuthorCommunityAdapter.mutate; operator commands keep
 * those of PostgresCommunityContentOperatorAdapter.mutate. Every stored time
 * comes from the injected clock (`now`), never the database clock.
 */

export type PublishingDb = PoolClient;
export type PublishingRun<T> = (db: PublishingDb) => Promise<T>;

/** Opaque id prefixes (contract regexes `^<prefix>-[0-9a-f]{32}$`). */
export const publishingIdPrefixes = [
  "author-event",
  "media-blob",
  "media-component",
  "media-item",
  "publishing-job",
  "publishing-session",
  "work",
  "work-draft",
  "work-revision",
  "work-snapshot",
] as const;
export type PublishingIdPrefix = (typeof publishingIdPrefixes)[number];

/** `<prefix>-<32 lowercase hex>` from a random UUID, as the Phase 4 adapters do. */
export const opaqueId = (prefix: PublishingIdPrefix): string =>
  `${prefix}-${randomUUID().replaceAll("-", "")}`;

/** Author command actions (audit `author_events.action` and receipt fingerprints). */
export const publishingAuthorActions = {
  createSession: "publishing.session.create",
  discardSession: "publishing.session.discard",
  createDraft: "publishing.draft.create",
  deleteDraft: "publishing.draft.delete",
  restoreSnapshot: "publishing.draft.restore",
  resolveConflict: "publishing.draft.resolve",
  openEditDraft: "publishing.draft.open_edit",
  registerItem: "publishing.item.register",
  cancelItem: "publishing.item.cancel",
  resetComponent: "publishing.component.reset",
  submit: "publishing.submit",
  setVisibility: "publishing.work.visibility",
  deleteWork: "publishing.work.delete",
} as const;

/** Operator command actions (`content_operator_events.action`). */
export const publishingOperatorActions = {
  setSettings: "publishing.settings.set",
  moderateSubmission: "publishing.submission.moderate",
  setCapacity: "publishing.capacity.set",
  retryJob: "publishing.job.retry",
  abandonJob: "publishing.job.abandon",
} as const;

/**
 * The injected clock as a `$n::timestamptz` parameter. An invalid Date is a
 * programming error and throws before any statement runs.
 */
export const nowParam = (now: Date): string => {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
    throw new TypeError("A valid clock time is required");
  return now.toISOString();
};

/** SQL for the America/New_York calendar date of a timestamptz parameter (tz database, DST-aware). */
export const newYorkDateSql = (placeholder: string): string =>
  `((${placeholder})::timestamptz AT TIME ZONE 'America/New_York')::date`;

/**
 * SQL for the lowercase hex SHA-256 of a jsonb parameter's canonical text
 * (for `work_drafts.content_sha256`). Revision content identity is
 * `community.work_content_sha256` only.
 */
export const jsonbSha256Sql = (placeholder: string): string =>
  `encode(sha256(convert_to(((${placeholder})::jsonb)::text, 'UTF8')), 'hex')`;

export const iso = (value: Date): string => value.toISOString();
export const isoOrNull = (value: Date | null): string | null =>
  value === null ? null : value.toISOString();

/** BIGINT columns arrive as strings; byte counters stay within safe integers. */
export const safeInteger = (value: string | number | bigint): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed))
    throw new RangeError("Stored counter is outside the safe integer range");
  return parsed;
};

export interface PublishingPageWindow {
  readonly page: number;
  readonly pageSize: number;
}

/** `LIMIT` and `OFFSET` parameters for a 1-based page. */
export const pageBounds = (
  query: PublishingPageWindow,
): { readonly limit: number; readonly offset: number } => ({
  limit: query.pageSize,
  offset: (query.page - 1) * query.pageSize,
});

/** The shared page envelope of publishing and operator page contracts. */
export const pageOf = <T>(
  items: readonly T[],
  total: number,
  query: PublishingPageWindow,
): {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
} => ({
  items: [...items],
  total,
  page: query.page,
  pageSize: query.pageSize,
  totalPages: total === 0 ? 0 : Math.ceil(total / query.pageSize),
});

const connect = (pool: Pool): Promise<PoolClient> =>
  pool.connect().catch((error: unknown) => {
    throw asCommunityOperationError(error, "connect");
  });

const inTransaction = async <T>(
  pool: Pool,
  begin: string,
  run: PublishingRun<T>,
): Promise<T> => {
  const db = await connect(pool);
  try {
    await db.query(begin);
    const result = await run(db);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw asCommunityOperationError(error, "query");
  } finally {
    db.release();
  }
};

/** One consistent read-only snapshot (REPEATABLE READ READ ONLY). */
export const readTransaction = <T>(
  pool: Pool,
  run: PublishingRun<T>,
): Promise<T> =>
  inTransaction(pool, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", run);

/** A READ COMMITTED write transaction for worker and system transitions. */
export const writeTransaction = <T>(
  pool: Pool,
  run: PublishingRun<T>,
): Promise<T> => inTransaction(pool, "BEGIN", run);

/**
 * Locks the active actor row (`FOR NO KEY UPDATE`) so one account's devices,
 * retries and uploads serialize. Inactive or unknown: `CommunityNotFoundError`.
 */
export const lockActor = async (
  db: PublishingDb,
  actorId: string,
): Promise<void> => {
  const locked = await db.query(
    "SELECT id FROM community.public_users WHERE id=$1 AND status='active' FOR NO KEY UPDATE",
    [actorId],
  );
  if (locked.rowCount !== 1) throw new CommunityNotFoundError();
};

/** A write transaction under the actor lock, without receipt or audit (autosave, heartbeat, uploads). */
export const actorTransaction = <T>(
  pool: Pool,
  actorId: string,
  run: PublishingRun<T>,
): Promise<T> =>
  writeTransaction(pool, async (db) => {
    await lockActor(db, actorId);
    return run(db);
  });

const commandFingerprint = (
  action: string,
  subject: unknown,
  input: unknown,
): string =>
  createHash("sha256")
    .update(JSON.stringify([action, subject, input]))
    .digest("hex");

export interface AuthorCommandSpec {
  readonly actorId: string;
  readonly requestId: string;
  /** One of `publishingAuthorActions`. */
  readonly action: string;
  /** Fingerprinted with the input; also the audit subject unless `auditSubject` says otherwise. */
  readonly subjectId: string;
  /** The parsed command (and any route ids not already in `subjectId`). */
  readonly input: unknown;
  readonly now: Date;
}

export interface AuthorCommandOptions<T> {
  /** Recheck a current delegated capability before replaying a command receipt. */
  readonly beforeReceipt?: (db: PublishingDb) => Promise<void>;
  /**
   * Return false to roll the whole transaction back and return the result
   * without receipt or audit (for example a `not_ready` submission).
   */
  readonly record?: (result: T) => boolean;
  /** The audit subject derived from the result (for example a created id). */
  readonly auditSubject?: (result: T) => string;
}

/**
 * An idempotent author command: BEGIN, actor lock, receipt lookup (same
 * fingerprint returns the stored JSON result; a different one throws
 * `CommunityConflictError`), `run`, one `author_events` row, the receipt,
 * COMMIT. Thrown errors roll back. Results must be JSON-safe.
 */
export const authorCommand = async <T>(
  pool: Pool,
  spec: AuthorCommandSpec,
  run: PublishingRun<T>,
  options: AuthorCommandOptions<T> = {},
): Promise<T> => {
  const at = nowParam(spec.now);
  const fingerprint = commandFingerprint(
    spec.action,
    spec.subjectId,
    spec.input,
  );
  const db = await connect(pool);
  try {
    await db.query("BEGIN");
    await lockActor(db, spec.actorId);
    await options.beforeReceipt?.(db);
    const receipt = (
      await db.query<{ fingerprint: string; result: T }>(
        "SELECT fingerprint,result FROM community.author_command_receipts WHERE actor_id=$1 AND request_id=$2",
        [spec.actorId, spec.requestId],
      )
    ).rows[0];
    if (receipt !== undefined) {
      if (receipt.fingerprint !== fingerprint)
        throw new CommunityConflictError(
          "Request identity was already used for different content",
        );
      if (
        receipt.result !== null &&
        typeof receipt.result === "object" &&
        "permanentlyDeleted" in receipt.result
      )
        throw new CommunityNotFoundError();
      await db.query("COMMIT");
      return receipt.result;
    }
    const result = await run(db);
    if (options.record !== undefined && !options.record(result)) {
      await db.query("ROLLBACK");
      return result;
    }
    await db.query(
      "INSERT INTO community.author_events(id,actor_id,action,subject_id,occurred_at) VALUES($1,$2,$3,$4,$5::timestamptz)",
      [
        opaqueId("author-event"),
        spec.actorId,
        spec.action,
        options.auditSubject?.(result) ?? spec.subjectId,
        at,
      ],
    );
    await db.query(
      "INSERT INTO community.author_command_receipts(actor_id,request_id,fingerprint,result,created_at) VALUES($1,$2,$3,$4::jsonb,$5::timestamptz)",
      [
        spec.actorId,
        spec.requestId,
        fingerprint,
        JSON.stringify(result ?? null),
        at,
      ],
    );
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw asCommunityOperationError(error, "query");
  } finally {
    db.release();
  }
};

/** The stored result of an author receipt, or undefined (for receipt queries). */
export const readAuthorReceipt = async (
  db: PublishingDb,
  actorId: string,
  requestId: string,
): Promise<unknown> =>
  (
    await db.query<{ result: unknown }>(
      "SELECT result FROM community.author_command_receipts WHERE actor_id=$1 AND request_id=$2",
      [actorId, requestId],
    )
  ).rows[0]?.result;

export interface OperatorCommandSpec {
  /** The server-fixed operator label. */
  readonly operator: string;
  readonly requestId: string;
  /** One of `publishingOperatorActions`. */
  readonly action: string;
  /** Recorded as `content_type`/`content_id`; fingerprinted with the input. */
  readonly target: { readonly type: string; readonly id: string } | null;
  readonly input: unknown;
  readonly now: Date;
}

/**
 * An idempotent operator command serialized with every other content operator
 * command (the same advisory lock as the Phase 4 content operator adapter,
 * so both share `content_operator_receipts` safely): receipt lookup, `change`,
 * one `content_operator_events` row with `{command, result}` and the receipt.
 * Results must be JSON-safe and content-free.
 */
export const operatorCommand = <T>(
  pool: Pool,
  spec: OperatorCommandSpec,
  change: PublishingRun<T>,
): Promise<T> => {
  const at = nowParam(spec.now);
  const fingerprint = commandFingerprint(spec.action, spec.target, spec.input);
  return writeTransaction(pool, async (db) => {
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('phase4-content-operator',0))",
    );
    const old = (
      await db.query<{ fingerprint: string; result: T }>(
        "SELECT fingerprint,result FROM community.content_operator_receipts WHERE operator_label=$1 AND request_id=$2",
        [spec.operator, spec.requestId],
      )
    ).rows[0];
    if (old !== undefined) {
      if (old.fingerprint !== fingerprint)
        throw new CommunityConflictError("Request identity already used");
      return old.result;
    }
    const result = await change(db);
    await db.query(
      "INSERT INTO community.content_operator_events(id,operator_label,action,content_type,content_id,occurred_at,detail) VALUES($1,$2,$3,$4,$5,$6::timestamptz,$7::jsonb)",
      [
        randomUUID(),
        spec.operator,
        spec.action,
        spec.target?.type ?? null,
        spec.target?.id ?? null,
        at,
        JSON.stringify({ command: spec.input, result }),
      ],
    );
    // The receipt carries the same clock as the audit row above.
    await db.query(
      "INSERT INTO community.content_operator_receipts(operator_label,request_id,fingerprint,result,created_at) VALUES($1,$2,$3,$4::jsonb,$5::timestamptz)",
      [spec.operator, spec.requestId, fingerprint, JSON.stringify(result), at],
    );
    return result;
  });
};

interface SettingsRow extends QueryResultRow {
  publication_policy: string;
  max_items_per_work: number;
  original_item_max_bytes: string;
  standard_component_max_bytes: string;
  ordinary_account_capacity_bytes: string;
  owner_account_capacity_bytes: string;
  max_active_drafts: number;
  daily_new_work_limit: number;
  history_limit: number;
  trash_retention_days: number;
  orphan_grace_days: number;
  unsaved_session_lease_minutes: number;
  version: number;
  updated_at: Date;
  updated_by: string;
}

/**
 * The single settings row as the operator contract. `lock` adds `FOR SHARE`
 * (a decision that must not race a settings change) or `FOR UPDATE` (the
 * settings command itself). The storage constraint still admits an item
 * maximum up to 500; a stored value above the configurable maximum (100, the
 * bound that keeps full draft saves within the JSON command limit) is
 * enforced as that maximum.
 */
export const selectSettings = async (
  db: PublishingDb,
  lock: "share" | "update" | null = null,
): Promise<WorkPublishingSettings> => {
  const row = (
    await db.query<SettingsRow>(
      `SELECT * FROM community.work_publishing_settings WHERE id='settings'${lock === "share" ? " FOR SHARE" : lock === "update" ? " FOR UPDATE" : ""}`,
    )
  ).rows[0];
  if (row === undefined)
    throw new Error("Work publishing settings are not initialized");
  return workPublishingSettingsSchema.parse({
    policy: row.publication_policy,
    maxItemsPerWork: Math.min(
      row.max_items_per_work,
      WORK_ITEMS_CONFIGURABLE_MAXIMUM,
    ),
    originalItemMaxBytes: safeInteger(row.original_item_max_bytes),
    standardComponentMaxBytes: safeInteger(row.standard_component_max_bytes),
    ordinaryAccountCapacityBytes: safeInteger(
      row.ordinary_account_capacity_bytes,
    ),
    ownerAccountCapacityBytes: safeInteger(row.owner_account_capacity_bytes),
    maxActiveDrafts: row.max_active_drafts,
    dailyNewWorkLimit: row.daily_new_work_limit,
    historyLimit: row.history_limit,
    trashRetentionDays: row.trash_retention_days,
    orphanGraceDays: row.orphan_grace_days,
    unsavedSessionLeaseMinutes: row.unsaved_session_lease_minutes,
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
    updatedBy: row.updated_by,
  });
};

/** One account's capacity facts; `version` 0 and `updatedAt` null when no row exists yet. */
export interface PublishingCapacityState {
  readonly accountId: string;
  readonly capacityClass: AccountCapacityClass;
  readonly capacityBytes: number;
  readonly committedBytes: number;
  readonly reservedBytes: number;
  readonly version: number;
  readonly updatedAt: Date | null;
}

interface CapacityRow extends QueryResultRow {
  account_id: string;
  capacity_class: AccountCapacityClass | null;
  committed_bytes: string | null;
  reserved_bytes: string | null;
  version: number | null;
  updated_at: Date | null;
  capacity_bytes: string;
}

const capacityProjection = (lockRow: boolean): string =>
  `SELECT u.id AS account_id,c.capacity_class,c.committed_bytes,c.reserved_bytes,c.version,c.updated_at,
  CASE COALESCE(c.capacity_class,'ordinary') WHEN 'owner' THEN s.owner_account_capacity_bytes ELSE s.ordinary_account_capacity_bytes END AS capacity_bytes
  FROM community.public_users u
  CROSS JOIN community.work_publishing_settings s
  ${lockRow ? "JOIN" : "LEFT JOIN"} community.account_publishing_capacity c ON c.account_id=u.id
  WHERE u.id=$1 AND s.id='settings'${lockRow ? " FOR UPDATE OF c" : ""}`;

const capacityState = (row: CapacityRow): PublishingCapacityState => ({
  accountId: row.account_id,
  capacityClass: row.capacity_class ?? "ordinary",
  capacityBytes: safeInteger(row.capacity_bytes),
  committedBytes: safeInteger(row.committed_bytes ?? 0),
  reservedBytes: safeInteger(row.reserved_bytes ?? 0),
  version: row.version ?? 0,
  updatedAt: row.updated_at,
});

/** Reads capacity without creating a row. Unknown account: `CommunityNotFoundError`. */
export const selectCapacity = async (
  db: PublishingDb,
  accountId: string,
): Promise<PublishingCapacityState> => {
  const row = (
    await db.query<CapacityRow>(capacityProjection(false), [accountId])
  ).rows[0];
  if (row === undefined) throw new CommunityNotFoundError();
  return capacityState(row);
};

/**
 * Creates the account's capacity row on first use (ordinary, zero counters,
 * `updated_at` = `now`) and locks it `FOR UPDATE` for reservation and
 * accounting decisions. Unknown account: `CommunityNotFoundError`.
 */
export const lockCapacity = async (
  db: PublishingDb,
  accountId: string,
  now: Date,
): Promise<PublishingCapacityState> => {
  await db.query(
    `INSERT INTO community.account_publishing_capacity(account_id,updated_at)
     SELECT id,$2::timestamptz FROM community.public_users WHERE id=$1
     ON CONFLICT (account_id) DO NOTHING`,
    [accountId, nowParam(now)],
  );
  const row = (
    await db.query<CapacityRow>(capacityProjection(true), [accountId])
  ).rows[0];
  if (row === undefined) throw new CommunityNotFoundError();
  return capacityState(row);
};

/** The operator capacity contract for a capacity state. */
export const capacityDto = (
  state: PublishingCapacityState,
): OperatorAccountCapacity =>
  operatorAccountCapacitySchema.parse({
    accountId: state.accountId,
    capacityClass: state.capacityClass,
    capacityBytes: state.capacityBytes,
    committedBytes: state.committedBytes,
    reservedBytes: state.reservedBytes,
    version: state.version,
    updatedAt: isoOrNull(state.updatedAt),
  });
