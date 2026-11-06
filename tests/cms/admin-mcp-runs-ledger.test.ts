import { randomBytes, randomUUID } from "node:crypto";

import {
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import {
  ADMIN_MCP_OPERATOR_ROW_EMAIL,
  ADMIN_PREVIEW_TTL_MS,
  ADMIN_RUN_AWAITING_TTL_MS,
  ADMIN_RUN_FORMAT_VERSION,
  ADMIN_RUN_LEASE_MS,
  ADMIN_RUN_STALLED_MS,
} from "@moya/contracts/internal/admin-mcp";
import type { AdminMcpEnvelope } from "@moya/contracts/internal/admin-mcp";
import {
  acquireLease,
  adminOpMeta,
  appendChunk,
  cancelRun,
  confirmRun,
  createRun,
  listRuns,
  markAttempted,
  moveRun,
  readOwnerRuns,
  readRun,
  readTargets,
  readTargetStates,
  recordOutcome,
  recordStamps,
  releaseLease,
  renewLease,
  rowCursor,
  runCredentialOf,
  sealHasher,
  type LedgerRefusal,
  type NewRun,
  type NewTarget,
  type Planned,
  type RunCredential,
} from "admin/admin-mcp";
import { createLocalReq, getPayload, type Payload } from "payload";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assertSyntheticTestDatabaseUrl } from "../integration/postgres/synthetic-test-database.js";

// The run ledger (admin-mcp-completion-v1 S8-06) on the migrated synthetic database,
// through the Admin's own Payload pool: replay by credential, the four chunk rules, a
// seal that binds what is stored, one lease at a time, fenced target writes, and an
// expiry decided by the read that finds it. The rows it commits are removed at the end.

const connection = process.env.CMS_TEST_DATABASE_URL ?? "";
if (process.env.CMS_ENVIRONMENT !== "synthetic" || !connection)
  throw new Error("SYNTHETIC_CMS_TARGET_REQUIRED");
assertSyntheticTestDatabaseUrl(connection, "CMS_TEST_DATABASE_URL");

const pool = createPostgresPool(
  parsePostgresConfig({ DATABASE_URL: connection }),
);
let payload: Payload;
let ai: number;

const OP = "community.delete-body";
const suffix = randomBytes(6).toString("hex");
// One users row behind both, as every connection shares the AI row.
const key = runCredentialOf({
  id: 900_000 + Number.parseInt(suffix.slice(0, 4), 16),
});
const connectionCredential = runCredentialOf({
  id: `conn-${suffix}`,
  connection: {
    id: `conn-${suffix}`,
    authorizedById: 1,
    authorizedByEmail: "owner@example.invalid",
  },
});
const created = new Set<string>();

/** A target frozen with no stamp yet, as a planning call that ran out of time leaves it. */
const unstamped = (n: number): NewTarget => ({
  ref: { type: "comment", id: `comment-${String(n).padStart(32, "0")}` },
  refKey: `comment:${n}`,
  frozenInput: { id: `comment-${String(n).padStart(32, "0")}` },
});
const target = (n: number): NewTarget => ({ ...unstamped(n), stamp: `r${n}` });

const newRun = (fields: Partial<NewRun> = {}): NewRun => ({
  credential: key,
  userId: ai,
  op: OP,
  klass: "irreversible",
  requestId: `ledger-${randomUUID()}`,
  sent: { op: OP, marker: randomUUID() },
  reason: "Synthetic reason",
  commonInput: { reason: "Synthetic reason" },
  selection: { kind: "targets" },
  ...fields,
});

const planned = (answer: Planned | LedgerRefusal): Planned => {
  if (!answer.ok) throw new Error(`refused ${answer.code}`);
  created.add(answer.run.runId);
  return answer;
};

/** Given targets seal at their own count unless the fields say otherwise. */
const make = async (
  targets: readonly NewTarget[],
  fields: Partial<NewRun> = {},
) =>
  planned(
    await createRun(
      payload,
      newRun({ expectedCount: targets.length, ...fields }),
      targets,
    ),
  );

const later = (ms: number) => new Date(Date.now() + ms);

/** The seal as recomputed from what the table holds, in index order. */
const resealed = async (runId: string) => {
  const { rows: runs } = await pool.query<{
    op: string;
    class: "irreversible";
    format_version: number;
    common_input: unknown;
  }>(
    "SELECT op, class, format_version, common_input FROM mcp_runs WHERE run_id = $1",
    [runId],
  );
  const run = runs[0]!;
  const seal = sealHasher({
    format: run.format_version,
    op: run.op,
    klass: run.class,
    commonInput: run.common_input,
  });
  const { rows } = await pool.query<{
    ref_key: string;
    frozen_input: unknown;
    stamp: string | null;
  }>(
    "SELECT ref_key, frozen_input, stamp FROM mcp_run_targets WHERE run_id = $1 ORDER BY idx",
    [runId],
  );
  for (const row of rows)
    seal.add({
      refKey: row.ref_key,
      frozenInput: row.frozen_input,
      stamp: row.stamp,
    });
  return seal.digest();
};

beforeAll(async () => {
  payload = await getPayload({
    config: await (await import("admin/config")).default,
  });
  ai = (
    await pool.query<{ id: number }>("SELECT id FROM users WHERE email = $1", [
      ADMIN_MCP_OPERATOR_ROW_EMAIL,
    ])
  ).rows[0]!.id;
});

afterAll(async () => {
  if (created.size > 0) {
    await pool.query(
      "DELETE FROM mcp_run_targets WHERE run_id = ANY($1::uuid[])",
      [[...created]],
    );
    await pool.query("DELETE FROM mcp_runs WHERE run_id = ANY($1::uuid[])", [
      [...created],
    ]);
  }
  await payload?.destroy();
  await pool.end();
});

describe("a run's requestId", () => {
  it("replays within its credential, conflicts on another payload, and never meets another credential's", async () => {
    const requestId = `ledger-${randomUUID()}`;
    const sent = { op: OP, targets: ["comment:1"] };
    const mine = await make([target(1)], { requestId, sent });
    expect(mine).toMatchObject({ replayed: false, stale: false });
    expect(mine.run).toMatchObject({
      credential: key.credential,
      formatVersion: ADMIN_RUN_FORMAT_VERSION,
      state: "previewed",
      targetCount: 1,
    });
    const theirs = await make([target(1)], {
      requestId,
      sent,
      credential: connectionCredential,
    });
    expect(theirs.replayed).toBe(false);
    expect(theirs.run.runId).not.toBe(mine.run.runId);
    expect(theirs.run.credential).toBe(connectionCredential.credential);
    const again = await make([target(1)], { requestId, sent });
    expect(again.replayed).toBe(true);
    expect(again.run.runId).toBe(mine.run.runId);
    expect(
      await createRun(
        payload,
        newRun({ requestId, sent: { ...sent, targets: ["comment:2"] } }),
        [target(2)],
      ),
    ).toMatchObject({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
    const { rows } = await pool.query(
      "SELECT key_id, connection_id FROM mcp_runs WHERE run_id = ANY($1::uuid[]) ORDER BY key_id NULLS LAST",
      [[mine.run.runId, theirs.run.runId]],
    );
    expect(rows).toEqual([
      { key_id: key.keyId, connection_id: null },
      { key_id: null, connection_id: connectionCredential.connectionId },
    ]);
  });

  it("finds a run only in its own credential, and tells nothing of another's", async () => {
    const { run } = await make([target(1)]);
    expect((await readRun(payload, key.credential, run.runId))?.run.runId).toBe(
      run.runId,
    );
    expect(
      await readRun(payload, connectionCredential.credential, run.runId),
    ).toBeUndefined();
    expect(
      await readRun(payload, key.credential, randomUUID()),
    ).toBeUndefined();
    expect(await readRun(payload, key.credential, "not-a-run")).toBeUndefined();
  });
});

describe("a planning chunk", () => {
  const counted = async (runId: string) =>
    (await readRun(payload, key.credential, runId))!.run;

  it("follows the four rules and lands whole or not at all", async () => {
    const first = await make([target(0), target(1)], { expectedCount: 6 });
    const { runId, requestId } = first.run;
    expect(first.run).toMatchObject({
      state: "planning",
      targetCount: 2,
      lastChunkSeq: 0,
    });
    const chunk = (
      chunkSeq: number,
      targets: readonly NewTarget[],
      fields: { requestId?: string } = {},
    ) =>
      appendChunk(payload, {
        credential: key.credential,
        runId,
        requestId: fields.requestId ?? requestId!,
        chunkSeq,
        sent: targets.map(({ refKey }) => refKey),
        targets,
      });

    // The next number applies.
    expect(await chunk(1, [target(2), target(3)])).toMatchObject({
      ok: true,
      replayed: false,
      run: { targetCount: 4, lastChunkSeq: 1, state: "planning" },
    });
    // The same number with the same payload replays and changes nothing.
    expect(await chunk(1, [target(2), target(3)])).toMatchObject({
      ok: true,
      replayed: true,
      run: { targetCount: 4, lastChunkSeq: 1 },
    });
    // The same number with another payload conflicts.
    expect(await chunk(1, [target(8), target(9)])).toMatchObject({
      ok: false,
      code: "IDEMPOTENCY_CONFLICT",
      issues: [{ path: ["chunkSeq"], code: "different_payload" }],
    });
    // Any other number is refused.
    for (const seq of [0, 3, 7])
      expect(await chunk(seq, [target(4)]), String(seq)).toMatchObject({
        ok: false,
        code: "INPUT_INVALID",
        issues: [{ path: ["chunkSeq"], code: "not_next" }],
      });
    // Another requestId never lands a chunk on this run.
    expect(
      await chunk(2, [target(4)], { requestId: `ledger-${randomUUID()}` }),
    ).toMatchObject({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
    // A target already held, or one twice in the chunk, refuses the chunk whole.
    expect(await chunk(2, [target(4), target(0)])).toMatchObject({
      ok: false,
      code: "INPUT_INVALID",
      issues: [{ path: ["appendTargets", 1], code: "duplicate_target" }],
    });
    expect(await chunk(2, [target(4), target(4)])).toMatchObject({
      ok: false,
      code: "INPUT_INVALID",
      issues: [{ path: ["appendTargets", 1], code: "duplicate_target" }],
    });
    // So does one past the expected count.
    expect(await chunk(2, [target(4), target(5), target(6)])).toMatchObject({
      ok: false,
      code: "INPUT_INVALID",
      issues: [{ path: ["appendTargets"], code: "past_expected_count" }],
    });
    expect(await counted(runId)).toMatchObject({
      targetCount: 4,
      lastChunkSeq: 1,
      state: "planning",
    });
    expect(await chunk(2, [target(4)])).toMatchObject({
      ok: true,
      run: { state: "planning", targetCount: 5, lastChunkSeq: 2 },
    });
    // At the expected count it seals, on what the table holds.
    const sealed = await chunk(3, [target(5)]);
    expect(sealed).toMatchObject({
      ok: true,
      run: { state: "previewed", targetCount: 6, lastChunkSeq: 3 },
    });
    const run = (sealed as Planned).run;
    expect(run.sealHash).toBe(await resealed(runId));
    expect(run.counts).toEqual({ pending: 6 });
    expect(await chunk(3, [target(5)])).toMatchObject({
      ok: true,
      replayed: true,
      run: { state: "previewed" },
    });
    expect(await chunk(4, [target(6)])).toMatchObject({
      ok: false,
      code: "INPUT_INVALID",
      issues: [{ path: ["chunkSeq"], code: "sealed" }],
    });
    expect(
      await appendChunk(payload, {
        credential: connectionCredential.credential,
        runId,
        requestId: requestId!,
        chunkSeq: 4,
        sent: [],
        targets: [target(6)],
      }),
    ).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("refuses a first chunk that holds one target twice, and leaves no run", async () => {
    const requestId = `ledger-${randomUUID()}`;
    expect(
      await createRun(payload, newRun({ requestId }), [target(1), target(1)]),
    ).toMatchObject({
      ok: false,
      code: "INPUT_INVALID",
      issues: [{ path: ["targets", 1], code: "duplicate_target" }],
    });
    const { rows } = await pool.query(
      "SELECT 1 FROM mcp_runs WHERE credential = $1 AND request_id = $2",
      [key.credential, requestId],
    );
    expect(rows).toEqual([]);
  });

  it("seals only once every target holds its stamp, and a selection when it ends", async () => {
    const waiting = await make([unstamped(0), unstamped(1)]);
    expect(waiting.run).toMatchObject({ state: "planning", targetCount: 2 });
    const half = await recordStamps(payload, {
      credential: key.credential,
      runId: waiting.run.runId,
      targets: [{ index: 0, stamp: "r0" }],
    });
    expect(half).toMatchObject({ ok: true, run: { state: "planning" } });
    const whole = await recordStamps(payload, {
      credential: key.credential,
      runId: waiting.run.runId,
      targets: [
        {
          index: 1,
          stamp: "gone",
          state: "conflict",
          code: "NOT_FOUND",
          frozenInput: { id: "comment-filled" },
        },
      ],
    });
    expect(whole).toMatchObject({
      ok: true,
      run: { state: "previewed", counts: { pending: 1, conflict: 1 } },
    });
    expect((whole as Planned).run.sealHash).toBe(
      await resealed(waiting.run.runId),
    );
    expect(
      (await readTargets(payload, waiting.run.runId, 0, 10)).map(
        ({ stamp, state, frozenInput }) => ({ stamp, state, frozenInput }),
      ),
    ).toEqual([
      { stamp: "r0", state: "pending", frozenInput: target(0).frozenInput },
      {
        stamp: "gone",
        state: "conflict",
        frozenInput: { id: "comment-filled" },
      },
    ]);

    const selection = { kind: "selector", listOp: "list.comments" };
    const open = planned(
      await createRun(payload, newRun({ selection }), [target(0)]),
    );
    expect(open.run).toMatchObject({ state: "planning", expectedCount: null });
    const ended = planned(
      await appendChunk(
        payload,
        {
          credential: key.credential,
          runId: open.run.runId,
          requestId: open.run.requestId!,
          chunkSeq: 1,
          sent: { continuePlanning: true },
          targets: [target(1)],
        },
        { final: true },
      ),
    );
    expect(ended.run).toMatchObject({ state: "previewed", targetCount: 2 });
  });

  it("raises a reversible run's class when an irreversible target joins, and never lowers one", async () => {
    const run = await make([target(0)], {
      klass: "reversible",
      expectedCount: 3,
    });
    const append = (
      chunkSeq: number,
      n: number,
      klass: "reversible" | "irreversible",
    ) =>
      appendChunk(payload, {
        credential: key.credential,
        runId: run.run.runId,
        requestId: run.run.requestId!,
        chunkSeq,
        sent: [n],
        targets: [target(n)],
        klass,
      });
    expect(await append(1, 1, "irreversible")).toMatchObject({
      run: { klass: "irreversible" },
    });
    expect(await append(2, 2, "reversible")).toMatchObject({
      run: { klass: "irreversible", state: "previewed" },
    });
  });
});

describe("a run's lease", () => {
  it("goes to one of two calls at once, and the other is told when it ends", async () => {
    const { run } = await make([target(0), target(1)]);
    const owners = [randomUUID(), randomUUID()];
    const answers = await Promise.all(
      owners.map((owner) =>
        acquireLease(payload, {
          credential: key.credential,
          runId: run.runId,
          owner,
        }),
      ),
    );
    expect(answers.filter(({ ok }) => ok)).toHaveLength(1);
    const winner = owners[answers.findIndex(({ ok }) => ok)]!;
    const loser = owners.find((owner) => owner !== winner)!;
    const busy = answers.find(({ ok }) => !ok) as LedgerRefusal;
    expect(busy.code).toBe("CONCURRENT_OPERATION_BUSY");
    expect(busy.afterMs).toBeGreaterThan(0);
    expect(busy.afterMs).toBeLessThanOrEqual(ADMIN_RUN_LEASE_MS);
    // The holder takes it again; the other cannot renew what it never held.
    expect(
      await acquireLease(payload, {
        credential: key.credential,
        runId: run.runId,
        owner: winner,
      }),
    ).toMatchObject({ ok: true, run: { leaseOwner: winner } });
    expect(await renewLease(payload, { runId: run.runId, owner: loser })).toBe(
      false,
    );
    expect(await renewLease(payload, { runId: run.runId, owner: winner })).toBe(
      true,
    );
    expect(
      await acquireLease(payload, {
        credential: connectionCredential.credential,
        runId: run.runId,
        owner: loser,
      }),
    ).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("is taken over once it lapses, and fences the call that lost it", async () => {
    const { run } = await make([target(0), target(1)]);
    const first = randomUUID();
    const second = randomUUID();
    const lapsed = { now: later(ADMIN_RUN_LEASE_MS + 1_000) };
    expect(
      await acquireLease(payload, {
        credential: key.credential,
        runId: run.runId,
        owner: first,
      }),
    ).toMatchObject({ ok: true });
    expect(
      await moveRun(payload, {
        credential: key.credential,
        runId: run.runId,
        from: "previewed",
        to: "running",
        leaseOwner: first,
      }),
    ).toMatchObject({ state: "running" });
    expect(
      await markAttempted(payload, {
        runId: run.runId,
        index: 0,
        leaseOwner: first,
      }),
    ).toBe(true);
    expect(
      await acquireLease(
        payload,
        { credential: key.credential, runId: run.runId, owner: second },
        lapsed,
      ),
    ).toMatchObject({ ok: true, run: { leaseOwner: second } });
    // The first call's lease is gone: it writes no target and moves no state.
    expect(
      await markAttempted(payload, {
        runId: run.runId,
        index: 1,
        leaseOwner: first,
      }),
    ).toBe(false);
    expect(
      await recordOutcome(payload, {
        runId: run.runId,
        index: 0,
        leaseOwner: first,
        state: "applied",
      }),
    ).toBeUndefined();
    expect(
      await moveRun(payload, {
        credential: key.credential,
        runId: run.runId,
        from: "running",
        to: "succeeded",
        leaseOwner: first,
      }),
    ).toBeUndefined();
    expect(
      (await readTargets(payload, run.runId, 0, 2)).map(({ state }) => state),
    ).toEqual(["pending", "pending"]);
    expect(
      await releaseLease(payload, { runId: run.runId, owner: second }),
    ).toBe(true);
  });

  it("is never taken on a run past its deadline", async () => {
    const { run } = await make([target(0)]);
    expect(
      await acquireLease(
        payload,
        { credential: key.credential, runId: run.runId, owner: randomUUID() },
        { now: later(ADMIN_PREVIEW_TTL_MS + 1_000) },
      ),
    ).toMatchObject({ ok: false, code: "PREVIEW_EXPIRED" });
  });
});

describe("a target's outcome", () => {
  it("lands with the run's tally and next index, and a terminal state clears what was frozen", async () => {
    const { run } = await make([target(0), target(1), target(2)]);
    const owner = randomUUID();
    await acquireLease(payload, {
      credential: key.credential,
      runId: run.runId,
      owner,
    });
    await moveRun(payload, {
      credential: key.credential,
      runId: run.runId,
      from: "previewed",
      to: "running",
      leaseOwner: owner,
    });
    expect(
      await recordOutcome(payload, {
        runId: run.runId,
        index: 0,
        leaseOwner: owner,
        state: "applied",
        code: "OK",
        result: { id: "comment-0", state: "deleted" },
      }),
    ).toMatchObject({ nextIndex: 1, counts: { pending: 2, applied: 1 } });
    expect(
      await recordOutcome(payload, {
        runId: run.runId,
        index: 1,
        leaseOwner: owner,
        state: "conflict",
        code: "STATE_CONFLICT",
      }),
    ).toMatchObject({
      nextIndex: 2,
      counts: { pending: 1, applied: 1, conflict: 1 },
    });
    const ended = await moveRun(payload, {
      credential: key.credential,
      runId: run.runId,
      from: "running",
      to: "cancelled",
      leaseOwner: owner,
    });
    expect(ended).toMatchObject({
      state: "cancelled",
      commonInput: null,
      leaseOwner: null,
      counts: { applied: 1, conflict: 1, cancelled: 1 },
      selection: { kind: "targets" },
    });
    expect(await readTargets(payload, run.runId, 0, 10)).toMatchObject([
      {
        index: 0,
        state: "applied",
        code: "OK",
        frozenInput: null,
        result: { id: "comment-0", state: "deleted" },
      },
      {
        index: 1,
        state: "conflict",
        code: "STATE_CONFLICT",
        frozenInput: null,
      },
      { index: 2, state: "cancelled", frozenInput: null },
    ]);
  });

  it("moves only along the state table, and never to a confirmation", async () => {
    const { run } = await make([target(0)]);
    for (const [from, to] of [
      ["previewed", "succeeded"],
      ["previewed", "planning"],
      ["awaiting_owner", "confirmed"],
    ] as const)
      await expect(
        moveRun(payload, {
          credential: key.credential,
          runId: run.runId,
          from,
          to,
        }),
        `${from} -> ${to}`,
      ).rejects.toThrow("RUN_TRANSITION_INVALID");
    // A state it is not in moves nothing.
    expect(
      await moveRun(payload, {
        credential: key.credential,
        runId: run.runId,
        from: "planning",
        to: "previewed",
      }),
    ).toBeUndefined();
  });
});

describe("a run's expiry", () => {
  it("is decided by the read that finds it past its deadline", async () => {
    const { run } = await make([target(0), target(1)], { expectedCount: 3 });
    const past = { now: later(ADMIN_PREVIEW_TTL_MS + 1_000) };
    expect((await readRun(payload, key.credential, run.runId))?.run.state).toBe(
      "planning",
    );
    expect(
      await readRun(payload, key.credential, run.runId, past),
    ).toMatchObject({
      stale: false,
      run: { state: "expired", commonInput: null },
    });
    expect(
      (await readTargets(payload, run.runId, 0, 10)).map(
        ({ frozenInput }) => frozenInput,
      ),
    ).toEqual([null, null]);
    expect(
      await appendChunk(payload, {
        credential: key.credential,
        runId: run.runId,
        requestId: run.requestId!,
        chunkSeq: 1,
        sent: [2],
        targets: [target(2)],
      }),
    ).toMatchObject({ ok: false, code: "PREVIEW_EXPIRED" });
    expect(
      await acquireLease(payload, {
        credential: key.credential,
        runId: run.runId,
        owner: randomUUID(),
      }),
    ).toMatchObject({ ok: false, code: "STATE_CONFLICT", state: "expired" });
  });

  it("comes at once when the op's schema has moved, and says so", async () => {
    const { run } = await make([target(0)], { expectedCount: 2 });
    const moved = { schemaHashOf: () => "0".repeat(64) };
    expect(
      await appendChunk(
        payload,
        {
          credential: key.credential,
          runId: run.runId,
          requestId: run.requestId!,
          chunkSeq: 1,
          sent: [1],
          targets: [target(1)],
        },
        moved,
      ),
    ).toMatchObject({ ok: false, code: "PREVIEW_STALE" });
    expect(
      await readRun(payload, key.credential, run.runId, moved),
    ).toMatchObject({ stale: true, run: { state: "expired", targetCount: 1 } });
    const sealed = await make([target(0)]);
    expect(
      await readRun(payload, key.credential, sealed.run.runId, moved),
    ).toMatchObject({ stale: true, run: { state: "expired" } });
  });
});

// S8-10: list.runs and run.cancel, through the ledger and through each op's own body,
// on a credential of their own so another test's runs never read as theirs.
describe("list.runs and run.cancel", () => {
  const credentialOf = (): RunCredential =>
    runCredentialOf({ id: 700_000 + (randomBytes(2).readUInt16BE() % 99_999) });
  /** As the door admits one: the op reads the credential and the account. */
  const keyOf = (credential: RunCredential) =>
    (credential.connectionId === undefined
      ? { id: credential.keyId, user: { id: ai, role: "ai_operator" } }
      : {
          id: credential.connectionId,
          connection: {
            id: credential.connectionId,
            authorizedById: 1,
            authorizedByEmail: "owner@example.invalid",
          },
          user: { id: ai, role: "ai_operator" },
        }) as never;
  const marked = (n: number): NewTarget => ({
    ...target(n),
    frozenInput: {
      id: `comment-${String(n).padStart(32, "0")}`,
      note: "frozen-marker",
    },
  });
  const listRunsOp = async (
    credential: RunCredential,
    input: Record<string, unknown>,
    read: Record<string, unknown> = {},
  ): Promise<AdminMcpEnvelope> =>
    adminOpMeta["list.runs"].run!(input, {
      req: await createLocalReq({}, payload),
      key: keyOf(credential),
      read: { op: "list.runs", input, ...read },
    }) as Promise<AdminMcpEnvelope>;
  const cancelOp = async (credential: RunCredential, runId: string) =>
    adminOpMeta["run.cancel"].run!(
      { runId },
      { req: await createLocalReq({}, payload), key: keyOf(credential) },
    ) as Promise<AdminMcpEnvelope>;
  /** Sealed, then moved to wait for the Owner, as an execute call past the threshold leaves it. */
  const awaiting = async (credential: RunCredential, count = 3) => {
    const { run } = await make(
      Array.from({ length: count }, (_, n) => marked(n)),
      { credential },
    );
    const owner = randomUUID();
    await acquireLease(payload, {
      credential: credential.credential,
      runId: run.runId,
      owner,
    });
    const moved = await moveRun(payload, {
      credential: credential.credential,
      runId: run.runId,
      from: "previewed",
      to: "awaiting_owner",
      leaseOwner: owner,
    });
    await releaseLease(payload, { runId: run.runId, owner });
    return moved!;
  };

  it("lists only this credential's runs, newest first, a page at a time, none skipped on a tie", async () => {
    const mine = credentialOf();
    const theirs = connectionCredential;
    const template = (
      await make([marked(0)], { credential: mine, expectedCount: 2 })
    ).run;
    // Three more created at the very same microsecond: only the run id orders them.
    const ties = [randomUUID(), randomUUID(), randomUUID()];
    for (const runId of ties) {
      await pool.query(
        `INSERT INTO mcp_runs (run_id, format_version, contract_version, op_schema_hash, credential,
           key_id, connection_id, user_id, op, class, request_id, fingerprint, reason, common_input,
           selection, expected_count, state, expires_at, created_at)
         SELECT $2, format_version, contract_version, op_schema_hash, credential, key_id,
           connection_id, user_id, op, class, $3, fingerprint, reason, common_input, selection,
           expected_count, state, expires_at, created_at
         FROM mcp_runs WHERE run_id = $1`,
        [template.runId, runId, `ledger-${randomUUID()}`],
      );
      created.add(runId);
    }
    const newest = (await make([marked(0)], { credential: mine })).run;
    const other = (await make([marked(0)], { credential: theirs })).run;
    const walked: string[] = [];
    let after:
      Awaited<ReturnType<typeof listRuns>>[number]["keyset"] | undefined;
    for (let page = 0; page < 10; page += 1) {
      const listed = await listRuns(payload, mine.credential, {
        ...(after === undefined ? {} : { after }),
        limit: 2,
      });
      walked.push(...listed.map(({ run }) => run.runId));
      if (listed.length < 2) break;
      after = listed.at(-1)!.keyset;
      expect(after.at).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u,
      );
    }
    expect(walked).toEqual([newest.runId, ...[template.runId, ...ties].sort()]);
    expect(walked).not.toContain(other.runId);
    expect(
      (await listRuns(payload, theirs.credential, { limit: 100 })).map(
        ({ run }) => run.runId,
      ),
    ).not.toEqual(expect.arrayContaining([newest.runId]));
    // Through the op: each row its states and counts, and `next` from the last it holds.
    const first = await listRunsOp(mine, {}, { pageSize: 2 });
    expect(first).toMatchObject({ ok: true, data: { filter: {} } });
    const rows = (first.data as { rows: Record<string, unknown>[] }).rows;
    expect(rows.map(({ runId }) => runId)).toEqual(walked.slice(0, 2));
    expect(rows[0]).toEqual({
      runId: newest.runId,
      op: OP,
      class: "irreversible",
      state: "previewed",
      count: 1,
      done: 0,
      counts: { pending: 1 },
      needsOwnerConfirmation: false,
      expiresAt: newest.expiresAt.toISOString(),
      createdAt: newest.createdAt.toISOString(),
    });
    const rest = await listRunsOp(
      mine,
      {},
      {
        pageSize: 2,
        cursor: first.next!.args.cursor,
      },
    );
    expect(
      (rest.data as { rows: { runId: string }[] }).rows.map(
        ({ runId }) => runId,
      ),
    ).toEqual(walked.slice(2, 4));
    expect(JSON.stringify([first, rest])).not.toContain("frozen-marker");
    expect(await listRunsOp(mine, {}, { cursor: rowCursor(42) })).toMatchObject(
      {
        ok: false,
        code: "INPUT_INVALID",
        issues: [{ path: ["cursor"], code: "invalid_cursor" }],
      },
    );
    expect(await listRunsOp(mine, {}, { view: "count" })).toMatchObject({
      ok: false,
      code: "INPUT_INVALID",
      issues: [{ path: ["view"], code: "not_for_this_op" }],
    });
  });

  it("shows one run's targets by index and never its input, and another credential's as none", async () => {
    const mine = credentialOf();
    const { run } = await make([marked(0), marked(1), marked(2)], {
      credential: mine,
      reason: "Synthetic reason",
    });
    const first = await listRunsOp(mine, { runId: run.runId }, { pageSize: 2 });
    expect(first).toMatchObject({
      ok: true,
      untrusted: ["/data/about/reason"],
      data: {
        rows: [
          {
            index: 0,
            id: "comment-00000000000000000000000000000000",
            state: "pending",
          },
          {
            index: 1,
            id: "comment-00000000000000000000000000000001",
            state: "pending",
          },
        ],
        filter: { runId: run.runId },
        total: 3,
        about: {
          runId: run.runId,
          state: "previewed",
          reason: "Synthetic reason",
        },
      },
    });
    const rest = await listRunsOp(
      mine,
      { runId: run.runId },
      { pageSize: 2, cursor: first.next!.args.cursor },
    );
    expect(rest).toMatchObject({ ok: true, data: { rows: [{ index: 2 }] } });
    expect(rest.next).toBeUndefined();
    expect(JSON.stringify([first, rest])).not.toContain("frozen-marker");
    expect(
      (await readTargetStates(payload, run.runId, 0, 10)).map(
        ({ index, frozenInput }) => ({ index, frozenInput }),
      ),
    ).toEqual([
      { index: 1, frozenInput: null },
      { index: 2, frozenInput: null },
    ]);
    // Another credential's run, a read cursor of another kind, a run that is none.
    expect(
      await listRunsOp(connectionCredential, { runId: run.runId }),
    ).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await listRunsOp(mine, { runId: randomUUID() })).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
    expect(
      await listRunsOp(mine, { runId: run.runId }, { cursor: rowCursor(1) }),
    ).toMatchObject({
      ok: false,
      code: "INPUT_INVALID",
      issues: [{ path: ["cursor"], code: "invalid_cursor" }],
    });
  });

  it("cancels a run that waits for the Owner, and a second cancel changes nothing", async () => {
    const mine = credentialOf();
    const run = await awaiting(mine);
    expect(run.state).toBe("awaiting_owner");
    // Another credential's cancel finds nothing, and moves nothing.
    expect(await cancelOp(connectionCredential, run.runId)).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
    const cancelled = await cancelOp(mine, run.runId);
    expect(cancelled).toEqual({
      ok: true,
      code: "OK",
      data: {
        runId: run.runId,
        state: "cancelled",
        counts: { cancelled: 3 },
      },
      untrusted: [],
      meta: {},
    });
    expect(await cancelOp(mine, run.runId)).toMatchObject({
      ok: true,
      data: { state: "cancelled", replayed: true },
    });
    expect(
      (await readTargets(payload, run.runId, 0, 10)).map(
        ({ state, frozenInput }) => ({ state, frozenInput }),
      ),
    ).toEqual(Array(3).fill({ state: "cancelled", frozenInput: null }));
    expect(
      (await readRun(payload, mine.credential, run.runId))?.run,
    ).toMatchObject({
      state: "cancelled",
      commonInput: null,
    });
  });

  it("cancels a run part way: what ran stays, what was tried is unknown, the rest never runs, never under a live lease", async () => {
    const mine = credentialOf();
    const { run } = await make([marked(0), marked(1), marked(2)], {
      credential: mine,
    });
    const owner = randomUUID();
    await acquireLease(payload, {
      credential: mine.credential,
      runId: run.runId,
      owner,
    });
    await moveRun(payload, {
      credential: mine.credential,
      runId: run.runId,
      from: "previewed",
      to: "running",
      leaseOwner: owner,
    });
    await recordOutcome(payload, {
      runId: run.runId,
      index: 0,
      leaseOwner: owner,
      state: "applied",
      code: "OK",
    });
    await markAttempted(payload, {
      runId: run.runId,
      index: 1,
      leaseOwner: owner,
    });
    const busy = await cancelRun(payload, mine, run.runId);
    expect(busy).toMatchObject({
      ok: false,
      code: "CONCURRENT_OPERATION_BUSY",
    });
    expect((busy as LedgerRefusal).afterMs).toBeGreaterThan(0);
    expect((busy as LedgerRefusal).afterMs).toBeLessThanOrEqual(
      ADMIN_RUN_LEASE_MS,
    );
    expect(await cancelOp(mine, run.runId)).toMatchObject({
      ok: false,
      code: "CONCURRENT_OPERATION_BUSY",
    });
    await releaseLease(payload, { runId: run.runId, owner });
    expect(await cancelOp(mine, run.runId)).toMatchObject({
      ok: true,
      data: {
        state: "cancelled",
        counts: { applied: 1, unknown: 1, cancelled: 1 },
      },
    });
    expect(
      (await readTargets(payload, run.runId, 0, 10)).map(({ state, code }) => ({
        state,
        code,
      })),
    ).toEqual([
      { state: "applied", code: "OK" },
      { state: "unknown", code: "OUTCOME_UNKNOWN" },
      { state: "cancelled", code: null },
    ]);
    // The Owner's cancel finds any credential's run; a finished one answers as it is.
    const theirs = await make([marked(0)], {
      credential: connectionCredential,
    });
    expect(await cancelRun(payload, "owner", theirs.run.runId)).toMatchObject({
      ok: true,
      already: false,
      run: { state: "cancelled", credential: connectionCredential.credential },
    });
    expect(await cancelRun(payload, "owner", run.runId)).toMatchObject({
      ok: true,
      already: true,
    });
  });
});

// S8-11: the Owner's side of a run, through the ledger the control page's routes call.
describe("the Owner's confirmation and the control page's runs", () => {
  let ownerRow: number;
  beforeAll(async () => {
    ownerRow = (
      await payload.create({
        collection: "users",
        overrideAccess: true,
        data: {
          email: `ledger-owner-${suffix}@example.invalid`,
          password: randomBytes(24).toString("hex"),
          role: "owner",
          scopeCatalogIds: [],
        } as never,
      })
    ).id as number;
  });

  const waiting = async () => {
    const { run } = await make([target(0), target(1)]);
    const owner = randomUUID();
    await acquireLease(payload, {
      credential: key.credential,
      runId: run.runId,
      owner,
    });
    await moveRun(payload, {
      credential: key.credential,
      runId: run.runId,
      from: "previewed",
      to: "awaiting_owner",
      leaseOwner: owner,
    });
    await releaseLease(payload, { runId: run.runId, owner });
    return (await readRun(payload, key.credential, run.runId))!.run;
  };

  it("binds to the seal it was shown, once, by an Owner row, and only from awaiting_owner", async () => {
    const run = await waiting();
    const confirm = (fields: Partial<Parameters<typeof confirmRun>[1]> = {}) =>
      confirmRun(payload, {
        runId: run.runId,
        ownerId: ownerRow,
        expectedSealHash: run.sealHash!,
        ...fields,
      });
    expect(await confirm({ expectedSealHash: "b".repeat(64) })).toMatchObject({
      ok: false,
      code: "STATE_CONFLICT",
      issues: [{ path: ["expectedSealHash"], code: "seal_hash_changed" }],
    });
    // The trigger takes no confirmation from the AI row, whoever calls.
    await expect(confirm({ ownerId: ai })).rejects.toThrow();
    const confirmed = await confirm();
    expect(confirmed).toMatchObject({
      ok: true,
      already: false,
      run: {
        state: "confirmed",
        confirmedBy: ownerRow,
        confirmedSealHash: run.sealHash,
      },
    });
    const { expiresAt } = (confirmed as { run: { expiresAt: Date } }).run;
    expect(expiresAt.getTime()).toBeGreaterThan(
      Date.now() + ADMIN_RUN_AWAITING_TTL_MS - 60_000,
    );
    expect(await confirm()).toMatchObject({ ok: true, already: true });
    expect(await confirm({ expectedSealHash: "b".repeat(64) })).toMatchObject({
      ok: false,
      code: "STATE_CONFLICT",
    });
    const previewed = (await make([target(0)])).run;
    expect(
      await confirmRun(payload, {
        runId: previewed.runId,
        ownerId: ownerRow,
        expectedSealHash: previewed.sealHash!,
      }),
    ).toMatchObject({ ok: false, code: "STATE_CONFLICT", state: "previewed" });
    expect(
      await confirmRun(payload, {
        runId: randomUUID(),
        ownerId: ownerRow,
        expectedSealHash: run.sealHash!,
      }),
    ).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("refuses a run past its wait or frozen under another schema, and expires it", async () => {
    const late = await waiting();
    expect(
      await confirmRun(
        payload,
        {
          runId: late.runId,
          ownerId: ownerRow,
          expectedSealHash: late.sealHash!,
        },
        { now: later(ADMIN_RUN_AWAITING_TTL_MS + 1_000) },
      ),
    ).toMatchObject({ ok: false, code: "PREVIEW_EXPIRED" });
    const stale = await waiting();
    expect(
      await confirmRun(
        payload,
        {
          runId: stale.runId,
          ownerId: ownerRow,
          expectedSealHash: stale.sealHash!,
        },
        { schemaHashOf: () => "0".repeat(64) },
      ),
    ).toMatchObject({ ok: false, code: "PREVIEW_STALE" });
    for (const { runId } of [late, stale])
      expect((await readRun(payload, key.credential, runId))?.run.state).toBe(
        "expired",
      );
  });

  it("lists the runs that wait and the runs left stalled, each expiry decided as it is read", async () => {
    const wait = await waiting();
    const { run } = await make([target(0), target(1)]);
    const owner = randomUUID();
    await acquireLease(payload, {
      credential: key.credential,
      runId: run.runId,
      owner,
    });
    await moveRun(payload, {
      credential: key.credential,
      runId: run.runId,
      from: "previewed",
      to: "running",
      leaseOwner: owner,
    });
    await releaseLease(payload, { runId: run.runId, owner });
    const ids = (runs: readonly { runId: string }[]) =>
      runs.map(({ runId }) => runId);
    const now = await readOwnerRuns(payload, 200);
    expect(ids(now.awaiting)).toContain(wait.runId);
    expect(ids(now.stalled)).not.toContain(run.runId);
    const quiet = await readOwnerRuns(payload, 200, {
      now: later(ADMIN_RUN_STALLED_MS + 60_000),
    });
    expect(ids(quiet.stalled)).toContain(run.runId);
    expect(ids(quiet.awaiting)).toContain(wait.runId);
    const gone = await readOwnerRuns(payload, 200, {
      now: later(ADMIN_RUN_AWAITING_TTL_MS + 1_000),
    });
    expect(ids(gone.awaiting)).not.toContain(wait.runId);
    expect(
      (await readRun(payload, key.credential, wait.runId))?.run.state,
    ).toBe("expired");
    // Running never expires by time: still stalled, and still resumable.
    expect(ids(gone.stalled)).toContain(run.runId);
  });
});
