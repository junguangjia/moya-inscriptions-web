/**
 * admin-mcp-completion-v1 S8-09: a previewed run's execution, on admin_execute for a
 * reversible run and admin_execute_irreversible for an irreversible one, real JSON-RPC
 * over HTTP with the official client, through the real door and guard, to the real
 * Backend on a disposable community database. The fault matrix of S8 plan 2.6: the
 * threshold read fresh, the Owner's wait, one lease, pause, budget, expiry, staleness,
 * a ledger that stops, an effect that committed before its outcome landed, a target
 * that moved since its preview, and the 24-hour figure counting each target once.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { sql } from "@payloadcms/db-postgres";
import { createLocalReq, type PayloadRequest, type TypedUser } from "payload";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  acquireLease,
  EXECUTE_BUDGET_MS,
  readControlPage,
  releaseLease,
} from "admin/admin-mcp";
import { approveBatch, saveDraft } from "admin/editorial";

import { syntheticCatalogDraft } from "./admin-mcp-wire.js";
import {
  callTool,
  communitySeeds,
  startRunsHarness,
  type RunsHarness,
} from "./admin-mcp-runs-harness.js";

if (process.env.CMS_ENVIRONMENT !== "synthetic")
  throw new Error("SYNTHETIC_CMS_TARGET_REQUIRED");

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let harness: RunsHarness;
let seeds: ReturnType<typeof communitySeeds>;
let automation: TypedUser;
const scoped: string[] = [];

beforeAll(async () => {
  harness = await startRunsHarness("runs_exec");
  seeds = communitySeeds(harness);
  automation = (await harness.payload.create({
    collection: "users",
    overrideAccess: true,
    data: {
      email: `runs-exec-automation-${harness.run}@example.invalid`,
      password: randomBytes(24).toString("hex"),
      role: "automation",
      scopeCatalogIds: [],
    } as never,
  })) as unknown as TypedUser;
}, 180_000);

beforeEach(() => harness.stubEnv());
afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await harness?.stop();
});

const full = () => harness.clients.full;
const call = async (
  name: "admin_preview" | "admin_execute" | "admin_execute_irreversible",
  args: Json,
  profile: "operate" | "full" = "full",
): Promise<Json> =>
  (await callTool(harness.clients[profile], name, args)).envelope;
const preview = (args: Json, profile: "operate" | "full" = "full") =>
  call("admin_preview", { requestId: randomUUID(), ...args }, profile);
const follow = (next: Json) => call(next.tool, next.args);

const runRow = async (runId: string) =>
  (
    await harness.cms(sql`
      SELECT state, counts, next_index, lease_owner, common_input FROM mcp_runs
      WHERE run_id = ${runId}::uuid`)
  )[0]!;
const targetRows = async (runId: string) =>
  harness.cms(sql`
    SELECT idx, state, code, frozen_input, attempted_at FROM mcp_run_targets
    WHERE run_id = ${runId}::uuid ORDER BY idx`);

const control = async () =>
  (await harness.cms(sql`SELECT threshold, pause FROM mcp_control`))[0]!;
const withThreshold = async <T>(
  threshold: number,
  work: () => Promise<T>,
): Promise<T> => {
  const before = Number((await control()).threshold);
  await harness.cms(sql`UPDATE mcp_control SET threshold = ${threshold}`);
  try {
    return await work();
  } finally {
    await harness.cms(sql`UPDATE mcp_control SET threshold = ${before}`);
  }
};
const setPause = (on: boolean) =>
  harness.cms(sql`UPDATE mcp_control SET pause = ${on}`);

const reqFor = (user: TypedUser) => createLocalReq({ user }, harness.payload);
let seeded = 0;
const seedDraft = async () => {
  seeded += 1;
  const catalogId = `runs-${seeded}-${harness.run}`;
  const sourceId = `runs-source-${seeded}-${harness.run}`;
  const saved = await saveDraft(await reqFor(harness.owner), {
    idempotencyKey: `${harness.run}:seed:${seeded}`,
    content: syntheticCatalogDraft(catalogId, sourceId),
  });
  return { ...saved, catalogId, sourceId };
};
const draftOf = (id: number) =>
  harness.payload.findByID({
    collection: "catalogs",
    id,
    draft: true,
    depth: 0,
    overrideAccess: true,
  });
const editOf = (
  draft: Awaited<ReturnType<typeof seedDraft>>,
  title: string,
) => ({
  id: draft.id,
  expectedRevision: draft.revision,
  content: {
    catalogId: draft.catalogId,
    sourceId: draft.sourceId,
    kind: "calligraphy",
    title,
  },
});
const newRecord = () => {
  const catalogId = `runs-new-${randomUUID()}`;
  return {
    catalogId,
    target: {
      content: syntheticCatalogDraft(
        catalogId,
        `runs-new-source-${randomUUID()}`,
      ),
    },
  };
};
const recordsNamed = async (catalogId: string) =>
  (
    await harness.payload.find({
      collection: "catalogs",
      draft: true,
      overrideAccess: true,
      depth: 0,
      limit: 5,
      where: { catalogId: { equals: catalogId } },
    })
  ).totalDocs;

const comments = async (count: number) => {
  const author = await seeds.newUser();
  const work = await seeds.newWork(author);
  return Promise.all(
    Array.from({ length: count }, () => seeds.newComment(work, author)),
  );
};
const hide = { action: "hide", reason: "Synthetic reason" };
const moderationOf = async (ids: readonly string[]) =>
  (
    await harness.setup.query(
      "SELECT id,moderation FROM community.catalog_comments WHERE id=ANY($1::text[])",
      [ids],
    )
  ).rows.reduce<Record<string, string>>(
    (all, row) => ({ ...all, [row.id]: row.moderation }),
    {},
  );

/** Runs `after` once, when the first target's Payload transaction has committed. */
const afterFirstCommit = async <T>(
  after: () => Promise<void> | void,
  work: () => Promise<T>,
): Promise<T> => {
  const commit = harness.payload.db.commitTransaction.bind(harness.payload.db);
  let spent = false;
  const spy = vi
    .spyOn(harness.payload.db, "commitTransaction")
    .mockImplementation((async (id: never) => {
      await commit(id);
      if (!spent) {
        spent = true;
        await after();
      }
    }) as never);
  try {
    return await work();
  } finally {
    spy.mockRestore();
  }
};

/**
 * The effect commits and its outcome never lands: the ledger refuses every target's
 * move out of pending, as a crash between the two would leave it.
 */
const withOutcomesRefused = async <T>(work: () => Promise<T>): Promise<T> => {
  await harness.cms(sql`
    CREATE OR REPLACE FUNCTION runs_exec_refuse_outcome() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic crash'; END $$`);
  await harness.cms(sql`
    CREATE TRIGGER runs_exec_refuse_outcome BEFORE UPDATE ON mcp_run_targets
    FOR EACH ROW WHEN (OLD.state = 'pending' AND NEW.state <> 'pending')
    EXECUTE FUNCTION runs_exec_refuse_outcome()`);
  try {
    return await work();
  } finally {
    await harness.cms(
      sql`DROP TRIGGER runs_exec_refuse_outcome ON mcp_run_targets`,
    );
    await harness.cms(sql`DROP FUNCTION runs_exec_refuse_outcome()`);
  }
};
const crashed = (name: string, args: Json) =>
  expect(full().callTool({ name, arguments: args })).rejects.toMatchObject({
    code: -32603,
  });

/** The ledger refuses one run's per-target rows, and only those. */
const withRunRowsRefused = async <T>(
  runId: string,
  work: () => Promise<T>,
): Promise<T> => {
  await harness.cms(sql`
    CREATE OR REPLACE FUNCTION runs_exec_refuse_audit() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic ledger failure'; END $$`);
  await harness.cms(
    sql.raw(`
    CREATE TRIGGER runs_exec_refuse_audit BEFORE INSERT ON mcp_audit_events
    FOR EACH ROW WHEN (NEW.tool IS NULL AND NEW.run_id = '${runId}')
    EXECUTE FUNCTION runs_exec_refuse_audit()`),
  );
  try {
    return await work();
  } finally {
    await harness.cms(
      sql`DROP TRIGGER runs_exec_refuse_audit ON mcp_audit_events`,
    );
    await harness.cms(sql`DROP FUNCTION runs_exec_refuse_audit()`);
  }
};

const ownerSession = (): Promise<PayloadRequest> =>
  createLocalReq(
    {
      user: {
        ...harness.owner,
        collection: "users",
        _strategy: "local-jwt",
      } as unknown as TypedUser,
      req: { headers: new Headers({ cookie: "payload-token=synthetic" }) },
    },
    harness.payload,
  );

describe("the tools on the wire", () => {
  it("lists admin_execute_irreversible on full alone, true of an irreversible tool", async () => {
    const tool = (await full().listTools()).tools.find(
      ({ name }) => name === "admin_execute_irreversible",
    );
    expect(tool?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(Object.keys(tool!.inputSchema.properties ?? {})).toEqual([
      "requestId",
      "previewId",
      "runId",
    ]);
    expect(
      (await harness.clients.operate.listTools()).tools.map(({ name }) => name),
    ).not.toContain("admin_execute_irreversible");
    const execute = (await full().listTools()).tools.find(
      ({ name }) => name === "admin_execute",
    );
    expect(execute!.inputSchema.required).toEqual(["requestId"]);
    expect(Object.keys(execute!.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(["previewId", "runId", "op"]),
    );
  });

  it("takes a run by one id and nothing else, and another key's run as none", async () => {
    const [id] = await comments(1);
    const made = await preview({
      op: "community.moderate-comment",
      input: hide,
      targets: [{ id }],
    });
    expect(
      await call("admin_execute", {
        requestId: randomUUID(),
        previewId: made.runId,
        op: "community.moderate-comment",
      }),
    ).toMatchObject({ ok: false, code: "INPUT_INVALID" });
    expect(
      await call("admin_execute", {
        requestId: randomUUID(),
        previewId: made.runId,
        runId: made.runId,
      }),
    ).toMatchObject({ ok: false, code: "INPUT_INVALID" });
    expect(
      await call(
        "admin_execute",
        { requestId: randomUUID(), runId: made.runId },
        "operate",
      ),
    ).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(
      await call("admin_execute", {
        requestId: randomUUID(),
        runId: randomUUID(),
      }),
    ).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect((await moderationOf([id!]))[id!]).toBe("visible");
  });

  it("sends a call that needs a preview to admin_preview, with what it sent while that fits", async () => {
    const requestId = randomUUID();
    const answer = await call("admin_execute", {
      requestId,
      op: "editorial.save-draft",
      targets: [newRecord().target],
    });
    expect(answer).toMatchObject({
      ok: false,
      code: "PREVIEW_REQUIRED",
      next: {
        tool: "admin_preview",
        args: { requestId, op: "editorial.save-draft", targets: [{}] },
      },
    });
    const ids = await comments(101);
    const over = await call("admin_execute", {
      requestId: randomUUID(),
      op: "community.moderate-comment",
      input: hide,
      targets: ids.map((id) => ({ id })),
    });
    // Past what a next carries, it names the call and asks for the same body again.
    expect(over).toMatchObject({
      ok: false,
      code: "USE_PREVIEW",
      next: {
        tool: "admin_preview",
        args: { op: "community.moderate-comment" },
      },
    });
    expect(Object.keys(over.next.args).sort()).toEqual(["op", "requestId"]);
    expect(over.hint).toContain("send the same ones to admin_preview");
  });
});

describe("a reversible run", () => {
  it("runs 101 frozen targets to the end on admin_execute, each once, with a row for each", async () => {
    const ids = await comments(101);
    const made = await preview({
      op: "community.moderate-comment",
      input: hide,
      targets: ids.map((id) => ({ id })),
    });
    expect(made.next.tool).toBe("admin_execute");
    const answer = await follow(made.next);
    expect(answer).toMatchObject({
      ok: true,
      code: "OK",
      runId: made.runId,
      state: "succeeded",
      done: 101,
      total: 101,
      data: { moderationCases: 101 },
    });
    expect(answer.data.applied).toHaveLength(101);
    expect(new Set(Object.values(await moderationOf(ids)))).toEqual(
      new Set(["hidden"]),
    );
    expect(await runRow(made.runId)).toMatchObject({
      state: "succeeded",
      common_input: null,
      lease_owner: null,
    });
    expect(
      (await targetRows(made.runId)).every(
        ({ state, frozen_input }) =>
          state === "applied" && frozen_input === null,
      ),
    ).toBe(true);
    const audit = await harness.cms(sql`
      SELECT count(*)::int AS n FROM mcp_audit_events
      WHERE run_id = ${made.runId} AND tool IS NULL AND class = 'reversible' AND ok`);
    expect(audit[0]!.n).toBe(101);
    // Done: the same call again answers the run as it ended, and runs nothing.
    const again = await follow(made.next);
    expect(again).toMatchObject({
      ok: true,
      state: "succeeded",
      meta: { replayed: true },
    });
  });

  it("is refused by admin_execute_irreversible, which names the tool it runs on", async () => {
    const [id] = await comments(1);
    const made = await preview({
      op: "community.moderate-comment",
      input: hide,
      targets: [{ id }],
    });
    expect(
      await call("admin_execute_irreversible", {
        requestId: randomUUID(),
        previewId: made.runId,
      }),
    ).toMatchObject({
      ok: false,
      code: "WRONG_TOOL",
      data: { tool: "admin_execute" },
    });
    expect(await runRow(made.runId)).toMatchObject({ state: "previewed" });
  });

  it("checks each target's stamp once before it runs: one moved since its preview is a conflict, and the rest run", async () => {
    const ids = await comments(3);
    const made = await preview({
      op: "community.moderate-comment",
      input: hide,
      targets: ids.map((id) => ({ id })),
    });
    // The Owner hides one and shows it again after the preview: it reads as it did,
    // and only its counter says it moved, so only the stamp check can stop it.
    for (const moderation of ["hidden", "visible"])
      await harness.setup.query(
        "UPDATE community.catalog_comments SET moderation=$2 WHERE id=$1",
        [ids[1], moderation],
      );
    const answer = await follow(made.next);
    expect(answer).toMatchObject({
      ok: false,
      code: "PARTIAL",
      state: "partial",
      data: {
        applied: [ids[0], ids[2]],
        conflict: [{ index: 1, id: ids[1], code: "STATE_CONFLICT" }],
      },
      meta: { partial: true },
    });
    expect(await moderationOf(ids)).toEqual({
      [ids[0]!]: "hidden",
      [ids[1]!]: "visible",
      [ids[2]!]: "hidden",
    });
  });

  it("replays a target it tried before without its stamp check, though its own effect moved the stamp", async () => {
    const ids = await comments(2);
    const made = await preview({
      op: "community.moderate-comment",
      input: hide,
      targets: ids.map((id) => ({ id })),
    });
    await withOutcomesRefused(() => crashed("admin_execute", made.next.args));
    expect(await moderationOf([ids[0]!])).toEqual({ [ids[0]!]: "hidden" });
    const rows = await targetRows(made.runId);
    expect(rows[0]).toMatchObject({ state: "pending" });
    expect(rows[0]!.attempted_at).not.toBeNull();
    const answer = await call("admin_execute", {
      requestId: randomUUID(),
      runId: made.runId,
    });
    expect(answer).toMatchObject({ ok: true, state: "succeeded" });
    expect(answer.data.already_applied).toEqual([ids[0]]);
    expect(answer.data.applied).toEqual([ids[1]]);
    const cases = await harness.setup.query(
      "SELECT count(*)::int AS n FROM community.report_cases WHERE target_id=$1",
      [ids[0]],
    );
    expect(cases.rows[0].n).toBe(1);
  });

  it("stops at the budget with next, and a new requestId goes on with nothing run twice", async () => {
    const drafts = [await seedDraft(), await seedDraft(), await seedDraft()];
    const made = await preview({
      op: "editorial.save-draft",
      targets: drafts.map((draft) => editOf(draft, "Budgeted")),
    });
    const real = performance.now.bind(performance);
    let offset = 0;
    const clock = vi
      .spyOn(performance, "now")
      .mockImplementation(() => real() + offset);
    let first: Json;
    try {
      first = await afterFirstCommit(
        () => {
          offset = EXECUTE_BUDGET_MS + 1;
        },
        () => follow(made.next),
      );
    } finally {
      clock.mockRestore();
    }
    expect(first).toMatchObject({
      ok: false,
      code: "IN_PROGRESS",
      done: 1,
      total: 3,
      remaining: 2,
      next: { tool: "admin_execute", args: { runId: made.runId } },
    });
    const rest = await call("admin_execute", {
      requestId: randomUUID(),
      runId: made.runId,
    });
    expect(rest).toMatchObject({ ok: true, state: "succeeded", done: 3 });
    for (const draft of drafts)
      expect((await draftOf(draft.id)).revision).toBe(draft.revision + 1);
  });

  it("stops at the next target when the Owner pauses mid-run", async () => {
    const drafts = [await seedDraft(), await seedDraft()];
    const made = await preview({
      op: "editorial.save-draft",
      targets: drafts.map((draft) => editOf(draft, "Paused")),
    });
    let paused: Json;
    try {
      paused = await afterFirstCommit(
        () => setPause(true).then(() => undefined),
        () => follow(made.next),
      );
    } finally {
      await setPause(false);
    }
    expect(paused).toMatchObject({
      ok: false,
      code: "MCP_PAUSED",
      done: 1,
      remaining: 1,
      next: { tool: "admin_execute" },
    });
    expect((await draftOf(drafts[1]!.id)).revision).toBe(drafts[1]!.revision);
    expect(await follow(paused.next)).toMatchObject({ ok: true });
  });

  it("stops where the ledger could not record a target, and goes on once it can", async () => {
    const drafts = [await seedDraft(), await seedDraft()];
    const made = await preview({
      op: "editorial.save-draft",
      targets: drafts.map((draft) => editOf(draft, "Ledgered")),
    });
    const stopped = await withRunRowsRefused(made.runId, () =>
      follow(made.next),
    );
    expect(stopped).toMatchObject({
      ok: false,
      code: "AUDIT_UNAVAILABLE",
      data: { applied: [drafts[0]!.id] },
      next: { tool: "admin_execute" },
    });
    expect((await draftOf(drafts[1]!.id)).revision).toBe(drafts[1]!.revision);
    expect(await follow(stopped.next)).toMatchObject({ ok: true });
    for (const draft of drafts)
      expect((await draftOf(draft.id)).revision).toBe(draft.revision + 1);
  });

  it("settles a target that waits on its media jobs on a later call, and only then ends", async () => {
    const author = await seeds.newUser();
    const work = await seeds.newWork(author);
    const item = `media-item-${randomUUID().replaceAll("-", "")}`;
    const revision = `work-revision-${randomUUID().replaceAll("-", "")}`;
    const job = `publishing-job-${randomUUID().replaceAll("-", "")}`;
    await harness.setup.query(
      "INSERT INTO community.media_items(id,owner_id,kind,quality_mode,source,state,declared_total_bytes) VALUES($1,$2,'static','standard','upload','awaiting_upload',1000)",
      [item, author],
    );
    await harness.setup.query(
      `INSERT INTO community.work_revisions(id,work_id,author_id,sequence,origin,title,body,authorship_kind,requested_visibility,content_sha256,disposition,submitted_at)
       VALUES($1,$2,$3,50,'submission','Revision','Body','original','public',$4,'approved',CURRENT_TIMESTAMP)`,
      [revision, work, author, "a".repeat(64)],
    );
    await harness.setup.query(
      `INSERT INTO community.work_revision_items(revision_id,item_id,position,edit) VALUES($1,$2,1,'{"rotation":0,"crop":null}'::jsonb)`,
      [revision, item],
    );
    // A withdrawal still to run on the work's one item: what the run waits on.
    await harness.setup.query(
      "INSERT INTO community.publishing_jobs(id,kind,subject_id,state,run_after) VALUES($1,'withdraw_media',$2,'queued',CURRENT_TIMESTAMP)",
      [job, item],
    );
    const { rows } = await harness.setup.query(
      "SELECT version FROM community.works WHERE id=$1",
      [work],
    );
    const made = await preview({
      op: "community.moderate-work",
      targets: [
        {
          id: work,
          state: "hidden",
          expectedVersion: Number(rows[0].version),
          reason: "Synthetic reason",
        },
      ],
    });
    const waiting = await follow(made.next);
    expect(waiting).toMatchObject({
      ok: false,
      code: "QUEUED",
      state: "settling",
      data: { queued: [{ index: 0, id: work, state: "media_jobs_open" }] },
      next: { tool: "admin_execute", args: { runId: made.runId } },
    });
    expect(waiting.next.afterMs).toBeGreaterThan(0);
    // The work's echo holds its title, which is the author's, so the answer says so.
    expect(waiting.data.results).toEqual([
      expect.objectContaining({ index: 0, id: work }),
    ]);
    expect(waiting.untrusted).toEqual(["/data/results/*/title"]);
    expect(await follow(waiting.next)).toMatchObject({
      code: "QUEUED",
      state: "settling",
    });
    await harness.setup.query(
      "UPDATE community.publishing_jobs SET state='succeeded',finished_at=CURRENT_TIMESTAMP WHERE id=$1",
      [job],
    );
    expect(await follow(waiting.next)).toMatchObject({
      ok: true,
      state: "succeeded",
      data: { applied: [work] },
    });
    expect((await targetRows(made.runId)).map(({ state }) => state)).toEqual([
      "applied",
    ]);
  });

  it("answers a held lease with when it ends", async () => {
    const [id] = await comments(1);
    const made = await preview({
      op: "community.moderate-comment",
      input: hide,
      targets: [{ id }],
    });
    const owner = randomUUID();
    expect(
      await acquireLease(harness.payload, {
        credential: `key:${harness.keyIds.full}`,
        runId: made.runId,
        owner,
      }),
    ).toMatchObject({ ok: true });
    const busy = await follow(made.next);
    expect(busy).toMatchObject({
      ok: false,
      code: "CONCURRENT_OPERATION_BUSY",
      retryable: true,
      next: { tool: "admin_execute", args: { runId: made.runId } },
    });
    expect(busy.next.afterMs).toBeGreaterThan(0);
    await releaseLease(harness.payload, { runId: made.runId, owner });
    expect(await follow(made.next)).toMatchObject({ ok: true });
  });

  it("answers an expired run and a stale one by name, and runs neither", async () => {
    const [first, second] = await comments(2);
    const expired = await preview({
      op: "community.moderate-comment",
      input: hide,
      targets: [{ id: first }],
    });
    await harness.cms(sql`
      UPDATE mcp_runs SET expires_at = now() - interval '1 minute'
      WHERE run_id = ${expired.runId}::uuid`);
    expect(await follow(expired.next)).toMatchObject({
      ok: false,
      code: "PREVIEW_EXPIRED",
    });
    expect(await runRow(expired.runId)).toMatchObject({
      state: "expired",
      common_input: null,
    });
    const stale = await preview({
      op: "community.moderate-comment",
      input: hide,
      targets: [{ id: second }],
    });
    // As a release that changed the op's schema would leave it.
    await harness.cms(sql`ALTER TABLE mcp_runs DISABLE TRIGGER mcp_runs_guard`);
    try {
      await harness.cms(sql`
        UPDATE mcp_runs SET op_schema_hash = ${"0".repeat(64)}
        WHERE run_id = ${stale.runId}::uuid`);
    } finally {
      await harness.cms(
        sql`ALTER TABLE mcp_runs ENABLE TRIGGER mcp_runs_guard`,
      );
    }
    expect(await follow(stale.next)).toMatchObject({
      ok: false,
      code: "PREVIEW_STALE",
    });
    expect(await moderationOf([first!, second!])).toEqual({
      [first!]: "visible",
      [second!]: "visible",
    });
  });
});

describe("an irreversible run", () => {
  it("is refused by admin_execute with no way on, and runs at or under the threshold on its own tool", async () => {
    await withThreshold(2, async () => {
      const records = [newRecord(), newRecord()];
      const made = await preview({
        op: "editorial.save-draft",
        targets: records.map(({ target }) => target),
      });
      const refused = await call("admin_execute", {
        requestId: randomUUID(),
        previewId: made.runId,
      });
      expect(refused).toMatchObject({
        ok: false,
        code: "USE_EXECUTE_IRREVERSIBLE",
      });
      expect(refused.next).toBeUndefined();
      const ran = await call("admin_execute_irreversible", {
        requestId: randomUUID(),
        previewId: made.runId,
      });
      expect(ran).toMatchObject({ ok: true, state: "succeeded", done: 2 });
      for (const { catalogId } of records)
        expect(await recordsNamed(catalogId)).toBe(1);
    });
  });

  it("waits for the Owner past the threshold, also when lowered after the preview, and runs once confirmed", async () => {
    const records = [newRecord(), newRecord(), newRecord()];
    const made = await withThreshold(5, () =>
      preview({
        op: "editorial.save-draft",
        targets: records.map(({ target }) => target),
      }),
    );
    expect(made.data.needsOwnerConfirmation).toBe(false);
    const waiting = await withThreshold(2, () =>
      call("admin_execute_irreversible", {
        requestId: randomUUID(),
        previewId: made.runId,
      }),
    );
    expect(waiting).toMatchObject({
      ok: false,
      code: "AWAITING_OWNER",
      state: "awaiting_owner",
      data: { awaiting: { path: "/admin/mcp-control" } },
    });
    expect(Date.parse(waiting.data.awaiting.expiresAt)).toBeGreaterThan(
      Date.now() + 23 * 60 * 60 * 1000,
    );
    expect(waiting.next).toBeUndefined();
    expect(
      await call("admin_execute_irreversible", {
        requestId: randomUUID(),
        runId: made.runId,
      }),
    ).toMatchObject({ code: "AWAITING_OWNER" });
    for (const { catalogId } of records)
      expect(await recordsNamed(catalogId)).toBe(0);
    // The control page's confirmation (S8-11), as its trigger takes it: an Owner row,
    // the sealed hash, from awaiting_owner.
    await harness.cms(sql`
      UPDATE mcp_runs SET state = 'confirmed', confirmed_by = ${harness.owner.id},
        confirmed_at = now(), confirmed_seal_hash = seal_hash
      WHERE run_id = ${made.runId}::uuid`);
    expect(
      await call("admin_execute_irreversible", {
        requestId: randomUUID(),
        runId: made.runId,
      }),
    ).toMatchObject({ ok: true, state: "succeeded", done: 3 });
    for (const { catalogId } of records)
      expect(await recordsNamed(catalogId)).toBe(1);
  });

  it("releases a legal hold through a run, which the Backend lets through", async () => {
    const author = await seeds.newUser();
    const reporter = await seeds.newUser();
    const report = await seeds.newRightsNotice(
      await seeds.newWork(author),
      reporter,
    );
    const held = await fetch(
      `${harness.backendOrigin}internal/community/reports/${report}/metadata`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${harness.ownerToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          expectedVersion: await seeds.versionOfReport(report),
          legalHold: true,
        }),
      },
    );
    expect(held.status).toBe(200);
    const made = await preview({
      op: "community.set-report-metadata",
      targets: [
        {
          id: report,
          expectedVersion: await seeds.versionOfReport(report),
          legalHold: false,
        },
      ],
    });
    expect(made.data).toMatchObject({
      class: "irreversible",
      consequences: ["legal_hold_released"],
    });
    expect(
      await call("admin_execute_irreversible", {
        requestId: randomUUID(),
        previewId: made.runId,
      }),
    ).toMatchObject({ ok: true, data: { applied: [report] } });
    const { rows } = await harness.setup.query(
      "SELECT legal_hold FROM community.report_cases WHERE id=$1",
      [report],
    );
    expect(rows[0].legal_hold).toBe(false);
  });

  it("counts a run of 25 targets 25 times in the 24-hour figure, by its credential", async () => {
    const credential = `key:${harness.keyIds.full}`;
    const figure = async () =>
      (
        await readControlPage(await ownerSession())
      ).figures?.irreversibleByCredential.find(
        (row) => row.credential === credential,
      )?.targets ?? 0;
    const before = await figure();
    await withThreshold(30, async () => {
      const made = await preview({
        op: "editorial.save-draft",
        targets: Array.from({ length: 25 }, () => newRecord().target),
      });
      expect(
        await call("admin_execute_irreversible", {
          requestId: randomUUID(),
          previewId: made.runId,
        }),
      ).toMatchObject({ ok: true, done: 25 });
    });
    // Each target once: not again for the call's own row, which holds all 25.
    expect((await figure()) - before).toBe(25);
  });
});

describe("an effect that committed before its outcome landed", () => {
  it("replays a receipt: a Catalog created once", async () => {
    const record = newRecord();
    const made = await preview({
      op: "editorial.save-draft",
      targets: [record.target],
    });
    const args = { requestId: randomUUID(), previewId: made.runId };
    await withOutcomesRefused(() =>
      crashed("admin_execute_irreversible", args),
    );
    expect(await recordsNamed(record.catalogId)).toBe(1);
    const answer = await call("admin_execute_irreversible", args);
    expect(answer).toMatchObject({ ok: true, state: "succeeded" });
    expect(answer.data.already_applied).toHaveLength(1);
    expect(await recordsNamed(record.catalogId)).toBe(1);
  });

  it("reads back a version-checked write: a hold released once", async () => {
    const author = await seeds.newUser();
    const reporter = await seeds.newUser();
    const report = await seeds.newRightsNotice(
      await seeds.newWork(author),
      reporter,
    );
    await fetch(
      `${harness.backendOrigin}internal/community/reports/${report}/metadata`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${harness.ownerToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          expectedVersion: await seeds.versionOfReport(report),
          legalHold: true,
        }),
      },
    );
    const made = await preview({
      op: "community.set-report-metadata",
      targets: [
        {
          id: report,
          expectedVersion: await seeds.versionOfReport(report),
          legalHold: false,
        },
      ],
    });
    const args = { requestId: randomUUID(), previewId: made.runId };
    await withOutcomesRefused(() =>
      crashed("admin_execute_irreversible", args),
    );
    const answer = await call("admin_execute_irreversible", args);
    expect(answer).toMatchObject({ ok: true, state: "succeeded" });
    expect(answer.data.already_applied).toEqual([report]);
    const { rows } = await harness.setup.query(
      "SELECT count(*)::int AS n FROM community.report_audit WHERE case_id=$1 AND operator_label='ai-admin' AND action='metadata'",
      [report],
    );
    expect(rows[0].n).toBe(1);
  });

  it("finds a state already in place: an approval revoked once", async () => {
    const draft = await seedDraft();
    scoped.push(draft.catalogId);
    await harness.payload.update({
      collection: "users",
      id: automation.id,
      overrideAccess: true,
      data: { scopeCatalogIds: scoped } as never,
    });
    const { approvalId } = await approveBatch(await reqFor(harness.owner), {
      automationUserId: automation.id,
      items: [{ id: draft.id, revision: draft.revision }],
    });
    const made = await preview({
      op: "approval.revoke",
      targets: [{ approvalId, type: "catalog" }],
    });
    await withOutcomesRefused(() => crashed("admin_execute", made.next.args));
    const answer = await follow(made.next);
    expect(answer).toMatchObject({ ok: true, state: "succeeded" });
    expect(answer.data.already_applied).toEqual([approvalId]);
  });
});

// S8-10: the engine's own read and cancel, over the wire, on the key that made each run.
describe("list.runs and run.cancel", () => {
  const read = async (
    args: Json,
    profile: "read" | "operate" | "full" = "full",
  ) => callTool(harness.clients[profile], "admin_read", args);
  const cancel = (runId: string, profile: "operate" | "full" = "full") =>
    call(
      "admin_execute",
      { requestId: randomUUID(), op: "run.cancel", input: { runId } },
      profile,
    );

  it("lists this key's runs newest first, a run's targets by index and never its input, and another key's as none", async () => {
    const ids = await comments(3);
    const first = await preview({
      op: "community.moderate-comment",
      input: hide,
      targets: ids.map((id) => ({ id })),
    });
    const second = await preview({
      op: "community.moderate-comment",
      input: hide,
      targets: [{ id: ids[0] }],
    });
    const { envelope: listed } = await read({ op: "list.runs" });
    const order = (listed.data.rows as Json[]).map(({ runId }) => runId);
    expect(order).toEqual(expect.arrayContaining([first.runId, second.runId]));
    expect(order.indexOf(second.runId)).toBeLessThan(
      order.indexOf(first.runId),
    );
    expect(listed.data.rows[order.indexOf(first.runId)]).toMatchObject({
      op: "community.moderate-comment",
      class: "reversible",
      state: "previewed",
      count: 3,
      done: 0,
      counts: { pending: 3 },
      needsOwnerConfirmation: false,
    });
    for (const profile of ["read", "operate"] as const) {
      const { envelope } = await read({ op: "list.runs" }, profile);
      expect(
        (envelope.data.rows as Json[]).map(({ runId }) => runId),
      ).not.toEqual(expect.arrayContaining([first.runId]));
      expect(
        (
          await read(
            { op: "list.runs", input: { runId: first.runId } },
            profile,
          )
        ).envelope,
      ).toMatchObject({ ok: false, code: "NOT_FOUND" });
    }
    const page = await read({
      op: "list.runs",
      input: { runId: first.runId },
      pageSize: 2,
    });
    expect(page.envelope).toMatchObject({
      ok: true,
      untrusted: ["/data/about/reason"],
      data: {
        rows: [
          { index: 0, id: ids[0], state: "pending" },
          { index: 1, id: ids[1], state: "pending" },
        ],
        total: 3,
        about: {
          runId: first.runId,
          state: "previewed",
          reason: "Synthetic reason",
        },
      },
      next: { tool: "admin_read" },
    });
    const rest = await read(page.envelope.next.args);
    expect(rest.envelope.data.rows).toEqual([
      { index: 2, id: ids[2], state: "pending" },
    ]);
    expect(rest.envelope.next).toBeUndefined();
    // The frozen input, which holds the action, never comes back.
    for (const { text } of [page, rest]) expect(text).not.toContain('"action"');
  });

  it("cancels a run that waits for the Owner, once; the run then answers RUN_CANCELLED", async () => {
    const records = [newRecord(), newRecord()];
    const made = await preview({
      op: "editorial.save-draft",
      targets: records.map(({ target }) => target),
    });
    const waiting = await withThreshold(1, () =>
      call("admin_execute_irreversible", {
        requestId: randomUUID(),
        previewId: made.runId,
      }),
    );
    expect(waiting).toMatchObject({ code: "AWAITING_OWNER" });
    // Another key's cancel finds no run, and stops nothing.
    expect(await cancel(made.runId, "operate")).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
    const cancelled = await cancel(made.runId);
    expect(cancelled).toMatchObject({
      ok: true,
      data: {
        applied: [made.runId],
        results: [
          {
            index: 0,
            runId: made.runId,
            state: "cancelled",
            counts: { cancelled: 2 },
          },
        ],
      },
    });
    expect(await cancel(made.runId)).toMatchObject({
      ok: true,
      data: { already_applied: [made.runId] },
    });
    expect(
      await call("admin_execute_irreversible", {
        requestId: randomUUID(),
        runId: made.runId,
      }),
    ).toMatchObject({ ok: false, code: "RUN_CANCELLED" });
    for (const { catalogId } of records)
      expect(await recordsNamed(catalogId)).toBe(0);
    expect(await runRow(made.runId)).toMatchObject({
      state: "cancelled",
      common_input: null,
    });
    // Filed with the run it ended.
    const rows = await harness.cms(sql`
      SELECT count(*)::int AS n FROM mcp_audit_events
      WHERE op = 'run.cancel' AND run_id = ${made.runId} AND phase = 'finish' AND ok`);
    expect(rows[0]!.n).toBe(2);
  });

  it("cancels a run stopped part way: what ran stays, the rest never runs", async () => {
    const drafts = [await seedDraft(), await seedDraft(), await seedDraft()];
    const made = await preview({
      op: "editorial.save-draft",
      targets: drafts.map((draft) => editOf(draft, "Cancelled")),
    });
    const real = performance.now.bind(performance);
    let offset = 0;
    const clock = vi
      .spyOn(performance, "now")
      .mockImplementation(() => real() + offset);
    let first: Json;
    try {
      first = await afterFirstCommit(
        () => {
          offset = EXECUTE_BUDGET_MS + 1;
        },
        () => follow(made.next),
      );
    } finally {
      clock.mockRestore();
    }
    expect(first).toMatchObject({ code: "IN_PROGRESS", done: 1 });
    expect(await cancel(made.runId)).toMatchObject({
      ok: true,
      data: {
        results: [{ state: "cancelled", counts: { applied: 1, cancelled: 2 } }],
      },
    });
    expect(await follow(first.next)).toMatchObject({
      ok: false,
      code: "RUN_CANCELLED",
    });
    expect((await draftOf(drafts[0]!.id)).revision).toBe(
      drafts[0]!.revision + 1,
    );
    for (const draft of drafts.slice(1))
      expect((await draftOf(draft.id)).revision).toBe(draft.revision);
    const { envelope } = await read({
      op: "list.runs",
      input: { runId: made.runId },
    });
    expect(
      (envelope.data.rows as Json[]).map(({ index, state }) => ({
        index,
        state,
      })),
    ).toEqual([
      { index: 0, state: "applied" },
      { index: 1, state: "cancelled" },
      { index: 2, state: "cancelled" },
    ]);
  });

  it("refuses to cancel a run another call holds, with a way on", async () => {
    const [id] = await comments(1);
    const made = await preview({
      op: "community.moderate-comment",
      input: hide,
      targets: [{ id }],
    });
    const owner = randomUUID();
    await acquireLease(harness.payload, {
      credential: `key:${harness.keyIds.full}`,
      runId: made.runId,
      owner,
    });
    const busy = await cancel(made.runId);
    expect(busy).toMatchObject({
      ok: false,
      code: "CONCURRENT_OPERATION_BUSY",
      retryable: true,
      next: { tool: "admin_execute", args: { op: "run.cancel" } },
    });
    expect(await runRow(made.runId)).toMatchObject({ state: "previewed" });
    await releaseLease(harness.payload, { runId: made.runId, owner });
    expect(await follow(busy.next)).toMatchObject({ ok: true });
    expect(await runRow(made.runId)).toMatchObject({ state: "cancelled" });
  });
});
