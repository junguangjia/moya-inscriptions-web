import { randomUUID } from "node:crypto";

import { sql, type PostgresAdapter } from "@payloadcms/db-postgres";
import {
  ADMIN_MCP_CONTRACT_VERSION,
  ADMIN_RUN_FORMAT_VERSION,
  ADMIN_RUN_LEASE_MS,
  ADMIN_RUN_REASON_MAX,
  ADMIN_RUN_STALLED_MS,
} from "@moya/contracts/internal/admin-mcp";
import type {
  AdminMcpCode,
  AdminOpClass,
  AdminRunState,
  AdminRunTargetState,
} from "@moya/contracts/internal/admin-mcp";
import type { Payload } from "payload";

import type { RunKeyset } from "../cursor";
import { fingerprintOf, opSchemaHash, sealHasher } from "./hash";
import type { RunCredential } from "./keys";
import {
  canTransition,
  deadlineOnEntering,
  isStale,
  isStalled,
  isTerminal,
  pastDeadline,
} from "./state";

/**
 * The run ledger (admin-mcp-completion-v1 section 8): the one way the engine reads and
 * writes mcp_runs and mcp_run_targets. Every write is a compare-and-set on the state it
 * read, on a connection and a short transaction of its own, never a request's
 * `req.transactionID`, so a business rollback never takes a ledger row with it. The
 * table triggers hold the same rules a second time.
 */

type Row = Record<string, unknown>;
type Query = ReturnType<typeof sql>;

interface Executor {
  readonly execute: (query: Query) => PromiseLike<{ readonly rows: Row[] }>;
}

const drizzleOf = (payload: Payload) =>
  (payload.db as unknown as Pick<PostgresAdapter, "drizzle">).drizzle;

/** A lock held past this answers busy: another call of the same run is mid-write. */
const inTransaction = <T>(
  payload: Payload,
  work: (tx: Executor) => Promise<T>,
): Promise<T> =>
  drizzleOf(payload).transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
    return work(tx as unknown as Executor);
  });

const onPool = (payload: Payload) => drizzleOf(payload) as unknown as Executor;

export interface LedgerRun {
  readonly runId: string;
  readonly formatVersion: number;
  readonly contractVersion: string;
  readonly opSchemaHash: string;
  readonly credential: string;
  readonly userId: number;
  readonly op: string;
  readonly klass: AdminOpClass;
  readonly requestId: string | null;
  readonly fingerprint: string;
  readonly reason: string | null;
  readonly commonInput: Readonly<Record<string, unknown>> | null;
  readonly selection: Readonly<Record<string, unknown>>;
  readonly planningCursor: string | null;
  readonly expectedCount: number | null;
  readonly targetCount: number;
  readonly sealedAt: Date | null;
  readonly sealHash: string | null;
  readonly preview: unknown;
  readonly impact: Readonly<Record<string, number>> | null;
  readonly state: AdminRunState;
  readonly nextIndex: number;
  readonly counts: Readonly<Partial<Record<AdminRunTargetState, number>>>;
  readonly lastChunkSeq: number;
  readonly lastChunkHash: string | null;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: Date | null;
  readonly expiresAt: Date;
  readonly confirmedBy: number | null;
  readonly confirmedAt: Date | null;
  readonly confirmedSealHash: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface LedgerTarget {
  readonly index: number;
  readonly ref: Readonly<Record<string, unknown>>;
  readonly refKey: string;
  readonly frozenInput: Readonly<Record<string, unknown>> | null;
  readonly stamp: string | null;
  readonly state: AdminRunTargetState;
  readonly code: string | null;
  readonly result: unknown;
  readonly attemptedAt: Date | null;
}

/** A timestamp as the driver hands it over: text from a raw query, or a Date. */
const dateOf = (value: unknown): Date => new Date(value as string | Date);
const dateOrNull = (value: unknown): Date | null =>
  value === null || value === undefined ? null : dateOf(value);
const textOrNull = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const runOf = (row: Row): LedgerRun => ({
  runId: String(row.run_id),
  formatVersion: Number(row.format_version),
  contractVersion: String(row.contract_version),
  opSchemaHash: String(row.op_schema_hash),
  credential: String(row.credential),
  userId: Number(row.user_id),
  op: String(row.op),
  klass: row.class as AdminOpClass,
  requestId: textOrNull(row.request_id),
  fingerprint: String(row.fingerprint),
  reason: textOrNull(row.reason),
  commonInput: (row.common_input ?? null) as LedgerRun["commonInput"],
  selection: row.selection as LedgerRun["selection"],
  planningCursor: textOrNull(row.planning_cursor),
  expectedCount:
    row.expected_count === null ? null : Number(row.expected_count),
  targetCount: Number(row.target_count),
  sealedAt: dateOrNull(row.sealed_at),
  sealHash: textOrNull(row.seal_hash),
  preview: row.preview ?? null,
  impact: (row.impact ?? null) as LedgerRun["impact"],
  state: row.state as AdminRunState,
  nextIndex: Number(row.next_index),
  counts: row.counts as LedgerRun["counts"],
  lastChunkSeq: Number(row.last_chunk_seq),
  lastChunkHash: textOrNull(row.last_chunk_hash),
  leaseOwner: textOrNull(row.lease_owner),
  leaseExpiresAt: dateOrNull(row.lease_expires_at),
  expiresAt: dateOf(row.expires_at),
  confirmedBy:
    row.confirmed_by === null || row.confirmed_by === undefined
      ? null
      : Number(row.confirmed_by),
  confirmedAt: dateOrNull(row.confirmed_at),
  confirmedSealHash: textOrNull(row.confirmed_seal_hash),
  createdAt: dateOf(row.created_at),
  updatedAt: dateOf(row.updated_at),
});

const targetOf = (row: Row): LedgerTarget => ({
  index: Number(row.idx),
  ref: row.ref as LedgerTarget["ref"],
  refKey: String(row.ref_key),
  frozenInput: (row.frozen_input ?? null) as LedgerTarget["frozenInput"],
  stamp: textOrNull(row.stamp),
  state: row.state as AdminRunTargetState,
  code: textOrNull(row.code),
  result: row.result ?? null,
  attemptedAt: dateOrNull(row.attempted_at),
});

export interface LedgerIssue {
  readonly path: readonly (string | number)[];
  readonly code: string;
}

/** What the ledger refuses, by the code the tool answers; nothing has been written. */
export interface LedgerRefusal {
  readonly ok: false;
  readonly code: Exclude<AdminMcpCode, "OK">;
  readonly issues?: readonly LedgerIssue[];
  /** On CONCURRENT_OPERATION_BUSY: when the lease that holds the run ends. */
  readonly afterMs?: number;
  /** On STATE_CONFLICT: the state that holds no lease. */
  readonly state?: AdminRunState;
}

/** A run as read now, its expiry decided. `stale` holds after it expired by staleness. */
export interface LedgerRead {
  readonly run: LedgerRun;
  readonly stale: boolean;
}

export interface Planned extends LedgerRead {
  readonly ok: true;
  /** The same call arrived before: nothing changed, and this is the run's answer now. */
  readonly replayed: boolean;
}

export interface LedgerOptions {
  readonly now?: Date;
  /** The op's schema hash as this process builds it; the tests pass another one. */
  readonly schemaHashOf?: (op: string) => string | undefined;
}

const refused = (
  code: LedgerRefusal["code"],
  fields: Omit<LedgerRefusal, "ok" | "code"> = {},
): LedgerRefusal => ({ ok: false, code, ...fields });

const NOT_FOUND = refused("NOT_FOUND");
const LOCK_RETRY_MS = 1_000;

// lock_not_available and deadlock_detected: another call held the run past the wait.
const LOCK_BUSY: ReadonlySet<unknown> = new Set(["55P03", "40P01"]);

/** Drizzle keeps the driver's error, with its SQLSTATE, as `cause`. */
const sqlStateOf = (error: unknown): unknown =>
  (error as { cause?: { code?: unknown } } | null)?.cause?.code ??
  (error as { code?: unknown } | null)?.code;

const orBusy = async <T>(
  work: () => Promise<T>,
): Promise<T | LedgerRefusal> => {
  try {
    return await work();
  } catch (error) {
    if (LOCK_BUSY.has(sqlStateOf(error)))
      return refused("CONCURRENT_OPERATION_BUSY", { afterMs: LOCK_RETRY_MS });
    throw error;
  }
};

const iso = (date: Date) => date.toISOString();
const json = (value: unknown) =>
  value === undefined || value === null ? null : JSON.stringify(value);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** By code point, as mcp_runs counts it, so a cut never splits a character. */
const reasonOf = (reason: string | undefined) =>
  reason === undefined
    ? null
    : Array.from(reason).slice(0, ADMIN_RUN_REASON_MAX).join("");

/**
 * The count and each state's tally, from the targets as they stand: the trigger seals
 * only when the stored count is the rows'.
 */
const tally = async (db: Executor, runId: string): Promise<Row> => {
  const { rows } = await db.execute(sql`
    UPDATE mcp_runs SET
      target_count = (SELECT count(*)::int FROM mcp_run_targets WHERE run_id = ${runId}::uuid),
      counts = coalesce((SELECT jsonb_object_agg(state, n) FROM (
          SELECT state, count(*)::int AS n FROM mcp_run_targets
          WHERE run_id = ${runId}::uuid GROUP BY state) AS tallied), '{}'::jsonb),
      updated_at = now()
    WHERE run_id = ${runId}::uuid
    RETURNING *`);
  return rows[0]!;
};

/**
 * A terminal state, by compare-and-set on the one it was read in. What was frozen goes:
 * the common input, the selection's filter and each target's input (amendment section
 * 2). A cancel marks the targets that never ran; one tried with no outcome landed may
 * have committed, so it is unknown, never cancelled.
 */
const end = async (
  db: Executor,
  runId: string,
  from: AdminRunState,
  to: AdminRunState,
  fence: Query = sql``,
): Promise<LedgerRun | undefined> => {
  const { rows } = await db.execute(sql`
    UPDATE mcp_runs SET state = ${to}, common_input = NULL, selection = selection - 'filter',
      lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
    WHERE run_id = ${runId}::uuid AND state = ${from}${fence}
    RETURNING *`);
  if (rows[0] === undefined) return undefined;
  if (to === "cancelled")
    await db.execute(sql`
      UPDATE mcp_run_targets SET
        state = CASE WHEN attempted_at IS NULL THEN 'cancelled' ELSE 'unknown' END,
        code = CASE WHEN attempted_at IS NULL THEN code ELSE 'OUTCOME_UNKNOWN' END,
        updated_at = now()
      WHERE run_id = ${runId}::uuid AND state = 'pending'`);
  await db.execute(sql`
    UPDATE mcp_run_targets SET frozen_input = NULL, updated_at = now()
    WHERE run_id = ${runId}::uuid AND frozen_input IS NOT NULL`);
  return runOf(await tally(db, runId));
};

/**
 * A read decides expiry: a timed state past its deadline, or any live state frozen in
 * another format or under another op schema, expires here and now.
 */
const observed = async (
  db: Executor,
  row: Row,
  now: Date,
  schemaHashOf: (op: string) => string | undefined,
): Promise<LedgerRead> => {
  const run = runOf(row);
  const stale = isStale(run, schemaHashOf(run.op));
  if (isTerminal(run.state) || !(stale || pastDeadline(run, now)))
    return { run, stale };
  return {
    run: (await end(db, run.runId, run.state, "expired")) ?? run,
    stale,
  };
};

/** A run that ended answers why, before any other check. */
const endedRefusal = ({ run, stale }: LedgerRead): LedgerRefusal | undefined =>
  run.state === "expired"
    ? refused(stale ? "PREVIEW_STALE" : "PREVIEW_EXPIRED")
    : run.state === "cancelled"
      ? refused("RUN_CANCELLED")
      : undefined;

export interface NewTarget {
  /** What the target is, in a shape no text fits in: shown, and seen by the Owner. */
  readonly ref: Readonly<Record<string, unknown>>;
  /** Unique in its run: a second target under the same key refuses its whole chunk. */
  readonly refKey: string;
  readonly frozenInput?: Readonly<Record<string, unknown>>;
  /** Its frozen state; a run seals only once every target holds one. */
  readonly stamp?: string;
  /** A conflict found at preview never runs and never counts as one that will. */
  readonly state?: "pending" | "conflict";
  readonly code?: string;
}

const MAX_ISSUES = 20;

/** Refused whole: a slip in one target leaves the count where it was. */
const chunkRefusal = (
  targets: readonly NewTarget[],
  field: string,
  expected: number | null,
  held: number,
): LedgerRefusal | undefined => {
  if (expected !== null && held + targets.length > expected)
    return refused("INPUT_INVALID", {
      issues: [{ path: [field], code: "past_expected_count" }],
    });
  const seen = new Set<string>();
  const issues: LedgerIssue[] = [];
  targets.forEach(({ refKey }, index) => {
    if (typeof refKey !== "string" || refKey === "")
      throw new Error("RUN_TARGET_KEY_INVALID");
    if (seen.has(refKey) && issues.length < MAX_ISSUES)
      issues.push({ path: [field, index], code: "duplicate_target" });
    seen.add(refKey);
  });
  return issues.length > 0 ? refused("INPUT_INVALID", { issues }) : undefined;
};

const insertTargets = async (
  db: Executor,
  runId: string,
  from: number,
  targets: readonly NewTarget[],
) => {
  if (targets.length === 0) return;
  const rows = targets.map((target, index) => ({
    idx: from + index,
    ref: target.ref,
    ref_key: target.refKey,
    frozen_input: target.frozenInput,
    stamp: target.stamp,
    state: target.state,
    code: target.code,
  }));
  await db.execute(sql`
    INSERT INTO mcp_run_targets (run_id, idx, ref, ref_key, frozen_input, stamp, state, code)
    SELECT ${runId}::uuid, t.idx, t.ref, t.ref_key, t.frozen_input, t.stamp,
      coalesce(t.state, 'pending'), t.code
    FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS t(idx integer, ref jsonb,
      ref_key varchar, frozen_input jsonb, stamp varchar, state varchar, code varchar)
    ORDER BY t.idx`);
};

const SEAL_PAGE = 1_000;

/**
 * Sealed once the count is the expected one, or the selection has ended, and every
 * target holds its stamp. The hash reads what is stored, so it binds what will run.
 */
const sealIfComplete = async (
  db: Executor,
  row: Row,
  final: boolean,
  now: Date,
): Promise<LedgerRun> => {
  const run = runOf(row);
  if (run.state !== "planning") return run;
  if (
    run.expectedCount === null ? !final : run.targetCount !== run.expectedCount
  )
    return run;
  const { rows: unstamped } = await db.execute(sql`
    SELECT 1 FROM mcp_run_targets WHERE run_id = ${run.runId}::uuid AND stamp IS NULL LIMIT 1`);
  if (unstamped.length > 0) return run;
  const seal = sealHasher({
    format: run.formatVersion,
    op: run.op,
    klass: run.klass,
    commonInput: run.commonInput,
  });
  for (let after = -1; ;) {
    const { rows } = await db.execute(sql`
      SELECT idx, ref_key, frozen_input, stamp FROM mcp_run_targets
      WHERE run_id = ${run.runId}::uuid AND idx > ${after}
      ORDER BY idx LIMIT ${SEAL_PAGE}`);
    for (const target of rows)
      seal.add({
        refKey: String(target.ref_key),
        frozenInput: target.frozen_input ?? null,
        stamp: textOrNull(target.stamp),
      });
    if (rows.length < SEAL_PAGE) break;
    after = Number(rows.at(-1)!.idx);
  }
  const { rows } = await db.execute(sql`
    UPDATE mcp_runs SET state = 'previewed', sealed_at = ${iso(now)}::timestamptz,
      seal_hash = ${seal.digest()},
      expires_at = ${iso(deadlineOnEntering("previewed", now)!)}::timestamptz,
      updated_at = now()
    WHERE run_id = ${run.runId}::uuid AND state = 'planning'
    RETURNING *`);
  return runOf(rows[0]!);
};

const lockedRun = async (db: Executor, credential: string, runId: string) =>
  UUID.test(runId)
    ? (
        await db.execute(sql`
          SELECT * FROM mcp_runs WHERE run_id = ${runId}::uuid AND credential = ${credential}
          FOR UPDATE`)
      ).rows[0]
    : undefined;

export interface NewRun {
  readonly credential: RunCredential;
  readonly userId: number;
  readonly op: string;
  readonly klass: AdminOpClass;
  /** The run's own key in its credential's scope; only a read ticket has none. */
  readonly requestId?: string;
  /** What the f1 fingerprint covers: the same requestId with the same one replays. */
  readonly sent: unknown;
  readonly reason?: string;
  readonly commonInput?: Readonly<Record<string, unknown>>;
  readonly selection: Readonly<Record<string, unknown>>;
  /** Given targets seal at this count; a selector seals when its planning ends. */
  readonly expectedCount?: number;
}

export interface PlanningOptions extends LedgerOptions {
  /** This call ends a selection: the run seals once every target holds its stamp. */
  readonly final?: boolean;
}

/**
 * A new run, planning, with its first targets. The same requestId with the same f1
 * fingerprint in the same credential replays the run as it is now; another payload
 * answers IDEMPOTENCY_CONFLICT. The run and its first targets commit together.
 */
export const createRun = async (
  payload: Payload,
  run: NewRun,
  targets: readonly NewTarget[],
  options: PlanningOptions = {},
): Promise<Planned | LedgerRefusal> => {
  const now = options.now ?? new Date();
  const schemaHashOf = options.schemaHashOf ?? opSchemaHash;
  const schemaHash = schemaHashOf(run.op);
  if (schemaHash === undefined) throw new Error("RUN_OP_UNKNOWN");
  if (run.klass !== "read" && run.requestId === undefined)
    throw new Error("RUN_REQUEST_ID_REQUIRED");
  const slip = chunkRefusal(targets, "targets", run.expectedCount ?? null, 0);
  if (slip !== undefined) return slip;
  const fingerprint = fingerprintOf(run.sent);
  const { credential, keyId, connectionId } = run.credential;
  return orBusy(() =>
    inTransaction(payload, async (tx): Promise<Planned | LedgerRefusal> => {
      const { rows } = await tx.execute(sql`
        INSERT INTO mcp_runs (run_id, format_version, contract_version, op_schema_hash,
          credential, key_id, connection_id, user_id, op, class, request_id, fingerprint, reason,
          common_input, selection, expected_count, state, expires_at)
        VALUES (${randomUUID()}::uuid, ${ADMIN_RUN_FORMAT_VERSION}, ${ADMIN_MCP_CONTRACT_VERSION},
          ${schemaHash}, ${credential}, ${keyId ?? null}, ${connectionId ?? null}, ${run.userId},
          ${run.op}, ${run.klass}, ${run.requestId ?? null}, ${fingerprint},
          ${reasonOf(run.reason)}, ${json(run.commonInput)}::jsonb, ${json(run.selection)}::jsonb,
          ${run.expectedCount ?? null}, 'planning',
          ${iso(deadlineOnEntering("planning", now)!)}::timestamptz)
        ON CONFLICT (credential, request_id) DO NOTHING
        RETURNING *`);
      const created = rows[0];
      if (created === undefined) {
        const { rows: found } = await tx.execute(sql`
          SELECT * FROM mcp_runs WHERE credential = ${credential} AND request_id = ${run.requestId!}
          FOR UPDATE`);
        const existing = found[0]!;
        if (existing.fingerprint !== fingerprint)
          return refused("IDEMPOTENCY_CONFLICT", {
            issues: [{ path: ["requestId"], code: "different_payload" }],
          });
        return {
          ok: true,
          ...(await observed(tx, existing, now, schemaHashOf)),
          replayed: true,
        };
      }
      const runId = String(created.run_id);
      await insertTargets(tx, runId, 0, targets);
      return {
        ok: true,
        run: await sealIfComplete(
          tx,
          await tally(tx, runId),
          options.final === true,
          now,
        ),
        stale: false,
        replayed: false,
      };
    }),
  );
};

/**
 * The run this credential's requestId already made, before a planning call does the
 * work of a new one: its replay with the same f1 fingerprint, IDEMPOTENCY_CONFLICT with
 * another, and undefined when there is none yet.
 */
export const findRun = async (
  payload: Payload,
  credential: string,
  requestId: string,
  sent: unknown,
  options: LedgerOptions = {},
): Promise<Planned | LedgerRefusal | undefined> => {
  const { rows } = await onPool(payload).execute(sql`
    SELECT run_id, fingerprint FROM mcp_runs
    WHERE credential = ${credential} AND request_id = ${requestId}`);
  const found = rows[0];
  if (found === undefined) return undefined;
  if (found.fingerprint !== fingerprintOf(sent))
    return refused("IDEMPOTENCY_CONFLICT", {
      issues: [{ path: ["requestId"], code: "different_payload" }],
    });
  const read = await readRun(
    payload,
    credential,
    String(found.run_id),
    options,
  );
  return read === undefined ? undefined : { ok: true, ...read, replayed: true };
};

/** What a preview shows of a run's targets, summed where the targets were frozen. */
export interface PreviewFacts {
  /** The first targets that will run, in index order. */
  readonly sample: readonly {
    readonly index: number;
    readonly ref: Readonly<Record<string, unknown>>;
  }[];
  readonly conflicts: {
    readonly count: number;
    readonly rows: readonly {
      readonly index: number;
      readonly ref: Readonly<Record<string, unknown>>;
      readonly code: string;
    }[];
  };
  readonly notified: number;
  readonly consequences: readonly string[];
  readonly impact: Readonly<Record<string, number>>;
  readonly newIdentities: {
    readonly count: number;
    readonly first: readonly {
      readonly index: number;
      readonly field: string;
      readonly value: string;
    }[];
  };
}

/**
 * Read from each target's `ref`, which its planning call wrote once with what the op's
 * hooks said of it, so an answer never reads a frozen input back. Only targets that
 * will run count: a conflict is listed and never summed.
 */
export const readPreviewFacts = async (
  payload: Payload,
  runId: string,
  limits: { readonly sample: number; readonly rows: number },
): Promise<PreviewFacts> => {
  const db = onPool(payload);
  const { rows: sample } = await db.execute(sql`
    SELECT idx, ref FROM mcp_run_targets
    WHERE run_id = ${runId}::uuid AND state <> 'conflict'
    ORDER BY idx LIMIT ${limits.sample}`);
  const { rows: conflicts } = await db.execute(sql`
    SELECT idx, ref, code, count(*) OVER ()::int AS total FROM mcp_run_targets
    WHERE run_id = ${runId}::uuid AND state = 'conflict'
    ORDER BY idx LIMIT ${limits.rows}`);
  const { rows: sums } = await db.execute(sql`
    SELECT count(*) FILTER (WHERE ref ? 'notifies')::int AS notified,
      coalesce(sum(jsonb_array_length(coalesce(ref->'newIdentities', '[]'::jsonb))), 0)::int AS identities,
      coalesce((SELECT jsonb_agg(DISTINCT named.consequence) FROM mcp_run_targets t,
          jsonb_array_elements_text(coalesce(t.ref->'consequences', '[]'::jsonb)) AS named(consequence)
        WHERE t.run_id = ${runId}::uuid AND t.state <> 'conflict'), '[]'::jsonb) AS consequences,
      coalesce((SELECT jsonb_object_agg(key, total) FROM (
          SELECT key, sum(value::numeric)::int AS total FROM mcp_run_targets t,
            jsonb_each_text(coalesce(t.ref->'impact', '{}'::jsonb))
          WHERE t.run_id = ${runId}::uuid AND t.state <> 'conflict' GROUP BY key) AS summed),
        '{}'::jsonb) AS impact
    FROM mcp_run_targets WHERE run_id = ${runId}::uuid AND state <> 'conflict'`);
  const { rows: identities } = await db.execute(sql`
    SELECT t.idx, entry->>'field' AS field, entry->>'value' AS value
    FROM mcp_run_targets t, jsonb_array_elements(t.ref->'newIdentities') WITH ORDINALITY AS e(entry, n)
    WHERE t.run_id = ${runId}::uuid AND t.state <> 'conflict' AND t.ref ? 'newIdentities'
    ORDER BY t.idx, e.n LIMIT ${limits.rows}`);
  const summed = sums[0] ?? {};
  return {
    sample: sample.map((row) => ({
      index: Number(row.idx),
      ref: row.ref as Record<string, unknown>,
    })),
    conflicts: {
      count: Number(conflicts[0]?.total ?? 0),
      rows: conflicts.map((row) => ({
        index: Number(row.idx),
        ref: row.ref as Record<string, unknown>,
        code: String(row.code),
      })),
    },
    notified: Number(summed.notified ?? 0),
    consequences: (summed.consequences ?? []) as string[],
    impact: (summed.impact ?? {}) as Record<string, number>,
    newIdentities: {
      count: Number(summed.identities ?? 0),
      first: identities.map((row) => ({
        index: Number(row.idx),
        field: String(row.field),
        value: String(row.value),
      })),
    },
  };
};

/**
 * What the control page shows of a sealed run, written once beside the seal's own
 * columns: the preview as it was answered, and its impact.
 */
export const recordPreview = async (
  payload: Payload,
  runId: string,
  preview: unknown,
  impact: Readonly<Record<string, number>> | undefined,
): Promise<void> => {
  await onPool(payload).execute(sql`
    UPDATE mcp_runs SET preview = ${json(preview)}::jsonb, impact = ${json(impact)}::jsonb
    WHERE run_id = ${runId}::uuid AND sealed_at IS NOT NULL AND preview IS NULL`);
};

export interface Chunk {
  readonly credential: string;
  readonly runId: string;
  /** The run's own: a chunk under another requestId never lands on this run. */
  readonly requestId: string;
  readonly chunkSeq: number;
  /** What the f1 fingerprint covers: the same number with the same one replays. */
  readonly sent: unknown;
  readonly targets: readonly NewTarget[];
  /** A target classed irreversible raises the run's class; nothing lowers it. */
  readonly klass?: AdminOpClass;
}

/**
 * One planning call after the first (section 8). The next number applies; the same
 * number with the same payload answers the run as it is now and changes nothing; the
 * same number with another payload answers IDEMPOTENCY_CONFLICT; any other number
 * answers INPUT_INVALID. A chunk lands whole or not at all, so the count stays true.
 */
export const appendChunk = async (
  payload: Payload,
  chunk: Chunk,
  options: PlanningOptions = {},
): Promise<Planned | LedgerRefusal> => {
  const now = options.now ?? new Date();
  const schemaHashOf = options.schemaHashOf ?? opSchemaHash;
  const hash = fingerprintOf(chunk.sent);
  return orBusy(() =>
    inTransaction(payload, async (tx): Promise<Planned | LedgerRefusal> => {
      const row = await lockedRun(tx, chunk.credential, chunk.runId);
      if (row === undefined) return NOT_FOUND;
      const read = await observed(tx, row, now, schemaHashOf);
      const { run } = read;
      if (run.requestId !== chunk.requestId)
        return refused("IDEMPOTENCY_CONFLICT", {
          issues: [{ path: ["requestId"], code: "not_this_run" }],
        });
      if (run.lastChunkSeq > 0 && chunk.chunkSeq === run.lastChunkSeq)
        return run.lastChunkHash === hash
          ? { ok: true, ...read, replayed: true }
          : refused("IDEMPOTENCY_CONFLICT", {
              issues: [{ path: ["chunkSeq"], code: "different_payload" }],
            });
      const ended = endedRefusal(read);
      if (ended !== undefined) return ended;
      if (chunk.chunkSeq !== run.lastChunkSeq + 1 || run.state !== "planning")
        return refused("INPUT_INVALID", {
          issues: [
            {
              path: ["chunkSeq"],
              code: run.state === "planning" ? "not_next" : "sealed",
            },
          ],
        });
      const slip = chunkRefusal(
        chunk.targets,
        "appendTargets",
        run.expectedCount,
        run.targetCount,
      );
      if (slip !== undefined) return slip;
      const { rows: taken } = await tx.execute(sql`
        SELECT ref_key FROM mcp_run_targets WHERE run_id = ${run.runId}::uuid
          AND ref_key IN (SELECT jsonb_array_elements_text(${JSON.stringify(chunk.targets.map(({ refKey }) => refKey))}::jsonb))`);
      if (taken.length > 0) {
        const held = new Set(taken.map(({ ref_key }) => String(ref_key)));
        return refused("INPUT_INVALID", {
          issues: chunk.targets
            .flatMap(({ refKey }, index) =>
              held.has(refKey)
                ? [{ path: ["appendTargets", index], code: "duplicate_target" }]
                : [],
            )
            .slice(0, MAX_ISSUES),
        });
      }
      await insertTargets(tx, run.runId, run.targetCount, chunk.targets);
      const klass =
        run.klass === "reversible" && chunk.klass === "irreversible"
          ? "irreversible"
          : run.klass;
      await tx.execute(sql`
        UPDATE mcp_runs SET last_chunk_seq = ${chunk.chunkSeq}, last_chunk_hash = ${hash},
          class = ${klass},
          expires_at = ${iso(deadlineOnEntering("planning", now)!)}::timestamptz
        WHERE run_id = ${run.runId}::uuid`);
      return {
        ok: true,
        run: await sealIfComplete(
          tx,
          await tally(tx, run.runId),
          options.final === true,
          now,
        ),
        stale: false,
        replayed: false,
      };
    }),
  );
};

export interface StampedTarget {
  readonly index: number;
  readonly stamp: string;
  /** The input as the stamp fills it, written with the stamp, before the seal. */
  readonly frozenInput?: Readonly<Record<string, unknown>>;
  readonly state?: "pending" | "conflict";
  readonly code?: string;
}

/**
 * Stamps for targets frozen without one, when a planning call ran out of time: each is
 * written once, with what it fills in, and the run seals when the last one lands.
 */
export const recordStamps = async (
  payload: Payload,
  stamped: {
    readonly credential: string;
    readonly runId: string;
    readonly targets: readonly StampedTarget[];
  },
  options: PlanningOptions = {},
): Promise<Planned | LedgerRefusal> => {
  const now = options.now ?? new Date();
  const schemaHashOf = options.schemaHashOf ?? opSchemaHash;
  return orBusy(() =>
    inTransaction(payload, async (tx): Promise<Planned | LedgerRefusal> => {
      const row = await lockedRun(tx, stamped.credential, stamped.runId);
      if (row === undefined) return NOT_FOUND;
      const read = await observed(tx, row, now, schemaHashOf);
      const ended = endedRefusal(read);
      if (ended !== undefined) return ended;
      if (read.run.state !== "planning")
        return refused("INPUT_INVALID", {
          issues: [{ path: ["previewId"], code: "sealed" }],
        });
      const rows = stamped.targets.map((target) => ({
        idx: target.index,
        stamp: target.stamp,
        frozen_input: target.frozenInput,
        state: target.state,
        code: target.code,
      }));
      await tx.execute(sql`
        UPDATE mcp_run_targets AS t SET stamp = s.stamp,
          frozen_input = coalesce(s.frozen_input, t.frozen_input),
          state = coalesce(s.state, t.state), code = coalesce(s.code, t.code), updated_at = now()
        FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS s(idx integer, stamp varchar,
          frozen_input jsonb, state varchar, code varchar)
        WHERE t.run_id = ${read.run.runId}::uuid AND t.idx = s.idx AND t.stamp IS NULL`);
      await tx.execute(sql`
        UPDATE mcp_runs SET expires_at = ${iso(deadlineOnEntering("planning", now)!)}::timestamptz
        WHERE run_id = ${read.run.runId}::uuid`);
      return {
        ok: true,
        run: await sealIfComplete(
          tx,
          await tally(tx, read.run.runId),
          options.final === true,
          now,
        ),
        stale: false,
        replayed: false,
      };
    }),
  );
};

/**
 * A run of this credential, its expiry decided by this read; another credential's
 * reads as none, so a runId tells nothing about runs it does not hold.
 */
export const readRun = async (
  payload: Payload,
  credential: string,
  runId: string,
  options: LedgerOptions = {},
): Promise<LedgerRead | undefined> => {
  if (!UUID.test(runId)) return undefined;
  const now = options.now ?? new Date();
  const schemaHashOf = options.schemaHashOf ?? opSchemaHash;
  const { rows } = await onPool(payload).execute(sql`
    SELECT * FROM mcp_runs WHERE run_id = ${runId}::uuid AND credential = ${credential}`);
  const row = rows[0];
  if (row === undefined) return undefined;
  const run = runOf(row);
  const stale = isStale(run, schemaHashOf(run.op));
  if (isTerminal(run.state) || !(stale || pastDeadline(run, now)))
    return { run, stale };
  return inTransaction(payload, async (tx) => {
    const locked = await lockedRun(tx, credential, runId);
    return observed(tx, locked!, now, schemaHashOf);
  });
};

/**
 * One move of the state table, by compare-and-set on `from`. A terminal move clears
 * what was frozen. With `leaseOwner`, only the call that holds the lease moves it. A
 * confirmation is the Owner's, on the control page, and never moves through here.
 */
export const moveRun = async (
  payload: Payload,
  move: {
    readonly credential: string;
    readonly runId: string;
    readonly from: AdminRunState;
    readonly to: AdminRunState;
    readonly leaseOwner?: string;
  },
  options: LedgerOptions = {},
): Promise<LedgerRun | undefined> => {
  const { credential, runId, from, to, leaseOwner } = move;
  if (!canTransition(from, to) || to === "confirmed")
    throw new Error("RUN_TRANSITION_INVALID");
  const now = options.now ?? new Date();
  const fence = sql` AND credential = ${credential}${
    leaseOwner === undefined
      ? sql``
      : sql` AND lease_owner = ${leaseOwner}::uuid AND lease_expires_at > ${iso(now)}::timestamptz`
  }`;
  if (isTerminal(to))
    return inTransaction(payload, (tx) => end(tx, runId, from, to, fence));
  const deadline = deadlineOnEntering(to, now);
  const { rows } = await onPool(payload).execute(sql`
    UPDATE mcp_runs SET state = ${to},
      expires_at = coalesce(${deadline === undefined ? null : iso(deadline)}::timestamptz, expires_at),
      updated_at = now()
    WHERE run_id = ${runId}::uuid AND state = ${from}${fence}
    RETURNING *`);
  return rows[0] === undefined ? undefined : runOf(rows[0]);
};

/** States a call may hold a lease in: planning more, or running. */
const LEASABLE: ReadonlySet<AdminRunState> = new Set([
  "planning",
  "previewed",
  "confirmed",
  "running",
  "settling",
]);

/**
 * The run's lease for one call: taken when free, expired, or this call's own, and only
 * while the run's deadline holds. Held by another call, it answers when that ends.
 */
export const acquireLease = async (
  payload: Payload,
  lease: {
    readonly credential: string;
    readonly runId: string;
    readonly owner: string;
  },
  options: LedgerOptions = {},
): Promise<{ readonly ok: true; readonly run: LedgerRun } | LedgerRefusal> => {
  const { credential, runId, owner } = lease;
  if (!UUID.test(runId)) return NOT_FOUND;
  const now = options.now ?? new Date();
  const db = onPool(payload);
  const { rows } = await db.execute(sql`
    UPDATE mcp_runs SET lease_owner = ${owner}::uuid,
      lease_expires_at = ${iso(new Date(now.getTime() + ADMIN_RUN_LEASE_MS))}::timestamptz,
      updated_at = now()
    WHERE run_id = ${runId}::uuid AND credential = ${credential}
      AND state IN ('planning', 'previewed', 'confirmed', 'running', 'settling')
      AND (state IN ('running', 'settling') OR expires_at > ${iso(now)}::timestamptz)
      AND (lease_owner IS NULL OR lease_expires_at <= ${iso(now)}::timestamptz
        OR lease_owner = ${owner}::uuid)
    RETURNING *`);
  if (rows[0] !== undefined) return { ok: true, run: runOf(rows[0]) };
  const { rows: found } = await db.execute(sql`
    SELECT * FROM mcp_runs WHERE run_id = ${runId}::uuid AND credential = ${credential}`);
  if (found[0] === undefined) return NOT_FOUND;
  const run = runOf(found[0]);
  if (!LEASABLE.has(run.state))
    return refused("STATE_CONFLICT", { state: run.state });
  if (pastDeadline(run, now)) return refused("PREVIEW_EXPIRED");
  return refused("CONCURRENT_OPERATION_BUSY", {
    afterMs: Math.max(
      0,
      (run.leaseExpiresAt?.getTime() ?? now.getTime()) - now.getTime(),
    ),
  });
};

/** Another minute for the call that holds it; false once it is lost. */
export const renewLease = async (
  payload: Payload,
  lease: { readonly runId: string; readonly owner: string },
  options: LedgerOptions = {},
): Promise<boolean> => {
  const now = options.now ?? new Date();
  const { rows } = await onPool(payload).execute(sql`
    UPDATE mcp_runs SET
      lease_expires_at = ${iso(new Date(now.getTime() + ADMIN_RUN_LEASE_MS))}::timestamptz
    WHERE run_id = ${lease.runId}::uuid AND lease_owner = ${lease.owner}::uuid
      AND lease_expires_at > ${iso(now)}::timestamptz
    RETURNING run_id`);
  return rows.length > 0;
};

export const releaseLease = async (
  payload: Payload,
  lease: { readonly runId: string; readonly owner: string },
): Promise<boolean> => {
  const { rows } = await onPool(payload).execute(sql`
    UPDATE mcp_runs SET lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
    WHERE run_id = ${lease.runId}::uuid AND lease_owner = ${lease.owner}::uuid
    RETURNING run_id`);
  return rows.length > 0;
};

/** Targets in index order from `from`, at most `limit`: one execute call's block. */
export const readTargets = async (
  payload: Payload,
  runId: string,
  from: number,
  limit: number,
): Promise<LedgerTarget[]> => {
  const { rows } = await onPool(payload).execute(sql`
    SELECT idx, ref, ref_key, frozen_input, stamp, state, code, result, attempted_at
    FROM mcp_run_targets WHERE run_id = ${runId}::uuid AND idx >= ${from}
    ORDER BY idx LIMIT ${limit}`);
  return rows.map(targetOf);
};

/**
 * The targets still to run, in index order, at most `limit`: a conflict frozen at
 * preview is never among them, and one attempted with no outcome yet still is.
 */
export const readPendingTargets = async (
  payload: Payload,
  runId: string,
  limit: number,
): Promise<LedgerTarget[]> => {
  const { rows } = await onPool(payload).execute(sql`
    SELECT idx, ref, ref_key, frozen_input, stamp, state, code, result, attempted_at
    FROM mcp_run_targets WHERE run_id = ${runId}::uuid AND state = 'pending'
    ORDER BY idx LIMIT ${limit}`);
  return rows.map(targetOf);
};

/** Targets that did not complete, in index order: what a run's last answer names. */
export const readUnfinishedTargets = async (
  payload: Payload,
  runId: string,
  limit: number,
): Promise<LedgerTarget[]> => {
  const { rows } = await onPool(payload).execute(sql`
    SELECT idx, ref, ref_key, NULL AS frozen_input, stamp, state, code, result, attempted_at
    FROM mcp_run_targets WHERE run_id = ${runId}::uuid
      AND state IN ('conflict', 'failed', 'unknown', 'cancelled')
    ORDER BY idx LIMIT ${limit}`);
  return rows.map(targetOf);
};

/** Targets waiting on their jobs, in index order: what a settling call reads again. */
export const readQueuedTargets = async (
  payload: Payload,
  runId: string,
  limit: number,
): Promise<LedgerTarget[]> => {
  const { rows } = await onPool(payload).execute(sql`
    SELECT idx, ref, ref_key, frozen_input, stamp, state, code, result, attempted_at
    FROM mcp_run_targets WHERE run_id = ${runId}::uuid AND state = 'queued'
    ORDER BY idx LIMIT ${limit}`);
  return rows.map(targetOf);
};

/** Only the call that holds a live lease writes a target. */
const leaseHeld = (runId: string, owner: string, now: Date) => sql`
  EXISTS (SELECT 1 FROM mcp_runs WHERE run_id = ${runId}::uuid
    AND lease_owner = ${owner}::uuid AND lease_expires_at > ${iso(now)}::timestamptz)`;

/**
 * Written before the target's effect, so a crash between the two leaves a target that
 * replays under its own key and is never stamp-checked again. False: the lease is gone.
 */
export const markAttempted = async (
  payload: Payload,
  target: {
    readonly runId: string;
    readonly index: number;
    readonly leaseOwner: string;
  },
  options: LedgerOptions = {},
): Promise<boolean> => {
  const now = options.now ?? new Date();
  const { rows } = await onPool(payload).execute(sql`
    UPDATE mcp_run_targets SET attempted_at = coalesce(attempted_at, ${iso(now)}::timestamptz),
      updated_at = now()
    WHERE run_id = ${target.runId}::uuid AND idx = ${target.index} AND state = 'pending'
      AND ${leaseHeld(target.runId, target.leaseOwner, now)}
    RETURNING idx`);
  return rows.length > 0;
};

/**
 * A target's outcome, landed before the next target starts, with the run's tally and
 * its next index in the same transaction. `result` holds ids, states, versions and a
 * job ref, never content. Undefined: the lease is gone, and nothing was written.
 */
export const recordOutcome = async (
  payload: Payload,
  outcome: {
    readonly runId: string;
    readonly index: number;
    readonly leaseOwner: string;
    readonly state: Exclude<AdminRunTargetState, "pending">;
    readonly code?: string;
    readonly result?: unknown;
  },
  options: LedgerOptions = {},
): Promise<LedgerRun | undefined> => {
  const now = options.now ?? new Date();
  const { runId, index, leaseOwner, state } = outcome;
  return inTransaction(payload, async (tx) => {
    const { rows: runs } = await tx.execute(sql`
      SELECT counts FROM mcp_runs WHERE run_id = ${runId}::uuid
        AND lease_owner = ${leaseOwner}::uuid AND lease_expires_at > ${iso(now)}::timestamptz
      FOR UPDATE`);
    if (runs[0] === undefined) return undefined;
    const { rows: targets } = await tx.execute(sql`
      SELECT state FROM mcp_run_targets WHERE run_id = ${runId}::uuid AND idx = ${index}
      FOR UPDATE`);
    if (targets[0] === undefined) throw new Error("RUN_TARGET_NOT_FOUND");
    const was = targets[0].state as AdminRunTargetState;
    await tx.execute(sql`
      UPDATE mcp_run_targets SET state = ${state}, code = ${outcome.code ?? null},
        result = ${json(outcome.result)}::jsonb, updated_at = now()
      WHERE run_id = ${runId}::uuid AND idx = ${index}`);
    const counts: Partial<Record<AdminRunTargetState, number>> = {
      ...(runs[0].counts as LedgerRun["counts"]),
    };
    counts[was] = (counts[was] ?? 0) - 1;
    if (counts[was] === 0) delete counts[was];
    counts[state] = (counts[state] ?? 0) + 1;
    const { rows } = await tx.execute(sql`
      UPDATE mcp_runs SET counts = ${JSON.stringify(counts)}::jsonb,
        next_index = GREATEST(next_index, ${index + 1}), updated_at = now()
      WHERE run_id = ${runId}::uuid
      RETURNING *`);
    return runOf(rows[0]!);
  });
};

/** A run as list.runs pages it, beside its place in the keyset. */
export interface ListedRun extends LedgerRead {
  readonly keyset: RunKeyset;
}

/**
 * A page of this credential's runs, newest first, in the order of its index; a read
 * ticket is no run here. Each run's expiry is decided as it is read, as readRun does.
 * The keyset reads the creation time as PostgreSQL keeps it, to the microsecond, so no
 * run between two pages is skipped.
 */
export const listRuns = async (
  payload: Payload,
  credential: string,
  page: { readonly after?: RunKeyset; readonly limit: number },
  options: LedgerOptions = {},
): Promise<ListedRun[]> => {
  const now = options.now ?? new Date();
  const schemaHashOf = options.schemaHashOf ?? opSchemaHash;
  const { after, limit } = page;
  const { rows } = await onPool(payload).execute(sql`
    SELECT *, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_key
    FROM mcp_runs WHERE credential = ${credential} AND class <> 'read'${
      after === undefined
        ? sql``
        : sql` AND (created_at < ${after.at}::timestamptz
          OR (created_at = ${after.at}::timestamptz AND run_id > ${after.id}::uuid))`
    }
    ORDER BY created_at DESC, run_id
    LIMIT ${limit}`);
  const listed: ListedRun[] = [];
  for (const row of rows) {
    const keyset = { at: String(row.created_key), id: String(row.run_id) };
    const run = runOf(row);
    const stale = isStale(run, schemaHashOf(run.op));
    const read =
      isTerminal(run.state) || !(stale || pastDeadline(run, now))
        ? { run, stale }
        : ((await readRun(payload, credential, run.runId, options)) ?? {
            run,
            stale,
          });
    listed.push({ ...read, keyset });
  }
  return listed;
};

/** Targets in index order after `after`, as list.runs shows them: never a frozen input. */
export const readTargetStates = async (
  payload: Payload,
  runId: string,
  after: number,
  limit: number,
): Promise<LedgerTarget[]> => {
  const { rows } = await onPool(payload).execute(sql`
    SELECT idx, ref, ref_key, NULL AS frozen_input, NULL AS stamp, state, code, result, attempted_at
    FROM mcp_run_targets WHERE run_id = ${runId}::uuid AND idx > ${after}
    ORDER BY idx LIMIT ${limit}`);
  return rows.map(targetOf);
};

/**
 * Who acts on a run: the credential that made it, which finds no other, or the Owner on
 * the control page, which finds any. Only control/endpoints.ts passes "owner".
 */
export type RunScope = { readonly credential: string } | "owner";

const lockedFor = async (db: Executor, scope: RunScope, runId: string) => {
  if (!UUID.test(runId)) return undefined;
  if (scope !== "owner") return lockedRun(db, scope.credential, runId);
  const { rows } = await db.execute(sql`
    SELECT * FROM mcp_runs WHERE run_id = ${runId}::uuid FOR UPDATE`);
  return rows[0];
};

export interface Settled {
  readonly ok: true;
  readonly run: LedgerRun;
  /** It was already so: nothing changed. */
  readonly already: boolean;
}

/**
 * run.cancel, and the Owner's cancel on the control page: the run ends at once unless a
 * call holds its lease. Its targets that never ran are cancelled, what ran stays as it
 * landed, and what was frozen goes. A run that already ended answers as it is.
 */
export const cancelRun = async (
  payload: Payload,
  scope: RunScope,
  runId: string,
  options: LedgerOptions = {},
): Promise<Settled | LedgerRefusal> => {
  const now = options.now ?? new Date();
  const schemaHashOf = options.schemaHashOf ?? opSchemaHash;
  return orBusy(() =>
    inTransaction(payload, async (tx): Promise<Settled | LedgerRefusal> => {
      const row = await lockedFor(tx, scope, runId);
      if (row === undefined || row.class === "read") return NOT_FOUND;
      const { run } = await observed(tx, row, now, schemaHashOf);
      if (isTerminal(run.state)) return { ok: true, run, already: true };
      const leaseLeft = (run.leaseExpiresAt?.getTime() ?? 0) - now.getTime();
      if (run.leaseOwner !== null && leaseLeft > 0)
        return refused("CONCURRENT_OPERATION_BUSY", { afterMs: leaseLeft });
      const ended = await end(tx, run.runId, run.state, "cancelled");
      if (ended === undefined) throw new Error("RUN_CANCEL_LOST");
      return { ok: true, run: ended, already: false };
    }),
  );
};

/**
 * The Owner's one confirmation of a run that waits for it (section 13), bound to the
 * seal the control page showed. Confirmed before under the same seal, it answers as it
 * is. An ended run, another state or another seal refuses, and nothing moves. The
 * trigger holds each rule a second time, and takes a confirmation only from an Owner
 * row. Only control/endpoints.ts calls this.
 */
export const confirmRun = async (
  payload: Payload,
  confirmation: {
    readonly runId: string;
    readonly ownerId: number;
    readonly expectedSealHash: string;
  },
  options: LedgerOptions = {},
): Promise<Settled | LedgerRefusal> => {
  const { runId, ownerId, expectedSealHash } = confirmation;
  const now = options.now ?? new Date();
  const schemaHashOf = options.schemaHashOf ?? opSchemaHash;
  const sealChanged = refused("STATE_CONFLICT", {
    issues: [{ path: ["expectedSealHash"], code: "seal_hash_changed" }],
  });
  return orBusy(() =>
    inTransaction(payload, async (tx): Promise<Settled | LedgerRefusal> => {
      const row = await lockedFor(tx, "owner", runId);
      if (row === undefined || row.class === "read") return NOT_FOUND;
      const read = await observed(tx, row, now, schemaHashOf);
      const ended = endedRefusal(read);
      if (ended !== undefined) return ended;
      const { run } = read;
      if (run.confirmedAt !== null)
        return run.confirmedSealHash === expectedSealHash
          ? { ok: true, run, already: true }
          : sealChanged;
      if (run.state !== "awaiting_owner")
        return refused("STATE_CONFLICT", { state: run.state });
      if (run.sealHash !== expectedSealHash) return sealChanged;
      const { rows } = await tx.execute(sql`
        UPDATE mcp_runs SET state = 'confirmed', confirmed_by = ${ownerId},
          confirmed_at = ${iso(now)}::timestamptz, confirmed_seal_hash = ${expectedSealHash},
          expires_at = ${iso(deadlineOnEntering("confirmed", now)!)}::timestamptz,
          updated_at = now()
        WHERE run_id = ${run.runId}::uuid AND state = 'awaiting_owner'
          AND seal_hash = ${expectedSealHash}
        RETURNING *`);
      if (rows[0] === undefined) throw new Error("RUN_CONFIRM_LOST");
      return { ok: true, run: runOf(rows[0]), already: false };
    }),
  );
};

/**
 * What the control page lists: runs waiting for the Owner, soonest to expire first, and
 * runs left with no live lease for a while. Each run's expiry is decided as it is read,
 * so an expired or stale one is never offered for a confirmation.
 */
export const readOwnerRuns = async (
  payload: Payload,
  limit: number,
  options: LedgerOptions = {},
): Promise<{
  readonly awaiting: readonly LedgerRun[];
  readonly stalled: readonly LedgerRun[];
}> => {
  const now = options.now ?? new Date();
  const schemaHashOf = options.schemaHashOf ?? opSchemaHash;
  const db = onPool(payload);
  const decided = async (rows: readonly Row[]) => {
    const runs: LedgerRun[] = [];
    for (const row of rows) {
      const run = runOf(row);
      if (!(isStale(run, schemaHashOf(run.op)) || pastDeadline(run, now))) {
        runs.push(run);
        continue;
      }
      runs.push(
        await inTransaction(payload, async (tx) => {
          const locked = await lockedFor(tx, "owner", run.runId);
          return (await observed(tx, locked!, now, schemaHashOf)).run;
        }),
      );
    }
    return runs;
  };
  const { rows: waiting } = await db.execute(sql`
    SELECT * FROM mcp_runs WHERE state = 'awaiting_owner'
    ORDER BY expires_at, run_id LIMIT ${limit}`);
  const { rows: left } = await db.execute(sql`
    SELECT * FROM mcp_runs WHERE state IN ('planning', 'running', 'settling')
      AND (lease_expires_at IS NULL OR lease_expires_at <= ${iso(now)}::timestamptz)
      AND updated_at <= ${iso(new Date(now.getTime() - ADMIN_RUN_STALLED_MS))}::timestamptz
    ORDER BY updated_at, run_id LIMIT ${limit}`);
  return {
    awaiting: (await decided(waiting)).filter(
      ({ state }) => state === "awaiting_owner",
    ),
    stalled: (await decided(left)).filter((run) => isStalled(run, now)),
  };
};
