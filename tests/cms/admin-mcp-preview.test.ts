/**
 * admin-mcp-completion-v1 S8-08: admin_preview with explicit targets, real JSON-RPC
 * over HTTP with the official client, through the real door and guard, to the real
 * Backend's select route on a disposable community database. What it holds to: a
 * preview runs nothing; the same requestId answers the same run; a chunk lands whole
 * or not at all, and the run seals at its expected count; a withheld or missing target
 * is named with its code and never counted; no contact reaches an answer; and a key
 * that could never run an irreversible run never gets one written.
 */
import { randomUUID } from "node:crypto";

import { ADMIN_PREVIEW_ROWS_MAX } from "@moya/contracts/internal/admin-mcp";
import { sql } from "@payloadcms/db-postgres";
import { createLocalReq } from "payload";
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

import { saveDraft } from "admin/editorial";

import { syntheticCatalogDraft } from "./admin-mcp-wire.js";
import {
  callTool,
  communitySeeds,
  opaque,
  startRunsHarness,
  type RunsHarness,
} from "./admin-mcp-runs-harness.js";

if (process.env.CMS_ENVIRONMENT !== "synthetic")
  throw new Error("SYNTHETIC_CMS_TARGET_REQUIRED");

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let harness: RunsHarness;
let seeds: ReturnType<typeof communitySeeds>;

beforeAll(async () => {
  harness = await startRunsHarness("preview");
  seeds = communitySeeds(harness);
}, 180_000);

beforeEach(() => harness.stubEnv());
afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await harness?.stop();
});

const preview = async (
  args: Json,
  profile: "operate" | "full" = "full",
): Promise<Json> =>
  (await callTool(harness.clients[profile], "admin_preview", args)).envelope;

const runRow = async (runId: string) =>
  (
    await harness.cms(sql`
      SELECT state, class, target_count, expected_count, sealed_at, seal_hash, preview,
        last_chunk_seq FROM mcp_runs WHERE run_id = ${runId}::uuid`)
  )[0];
const runsOf = async (requestId: string, profile: "operate" | "full") =>
  harness.cms(sql`
    SELECT run_id FROM mcp_runs
    WHERE request_id = ${requestId} AND credential = ${`key:${harness.keyIds[profile]}`}`);
const targetsOf = async (runId: string) =>
  harness.cms(sql`
    SELECT idx, ref, ref_key, frozen_input, stamp, state, code FROM mcp_run_targets
    WHERE run_id = ${runId}::uuid ORDER BY idx`);

const comments = async (count: number) => {
  const author = await seeds.newUser();
  const work = await seeds.newWork(author);
  return Promise.all(
    Array.from({ length: count }, () => seeds.newComment(work, author)),
  );
};
const hide = { action: "hide", reason: "Synthetic reason" };

let seeded = 0;
const seedDraft = async () => {
  seeded += 1;
  const catalogId = `preview-${seeded}-${harness.run}`;
  const sourceId = `preview-source-${seeded}-${harness.run}`;
  const saved = await saveDraft(
    await createLocalReq({ user: harness.owner }, harness.payload),
    {
      idempotencyKey: `${harness.run}:seed:${seeded}`,
      content: syntheticCatalogDraft(catalogId, sourceId),
    },
  );
  return { ...saved, catalogId, sourceId };
};

describe("the tool on the wire", () => {
  it("lists for operate and full, as a write that only freezes, and a read key has none", async () => {
    for (const profile of ["operate", "full"] as const) {
      const tool = (await harness.clients[profile].listTools()).tools.find(
        ({ name }) => name === "admin_preview",
      );
      expect(tool?.annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      expect(Object.keys(tool!.inputSchema.properties ?? {})).toEqual([
        "requestId",
        "op",
        "input",
        "targets",
        "selector",
        "expectedCount",
        "previewId",
        "chunkSeq",
        "appendTargets",
        "continuePlanning",
      ]);
    }
    expect(
      (await harness.clients.read.listTools()).tools.map(({ name }) => name),
    ).not.toContain("admin_preview");
    await expect(
      harness.clients.read.callTool({
        name: "admin_preview",
        arguments: { requestId: randomUUID(), op: "list.catalogs" },
      }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it("answers a read with the tool it runs on, a selector as not built, and a call of two shapes as invalid", async () => {
    expect(
      await preview({
        requestId: randomUUID(),
        op: "list.catalogs",
        targets: [{}],
      }),
    ).toMatchObject({
      ok: false,
      code: "WRONG_TOOL",
      data: { tool: "admin_read" },
    });
    expect(
      await preview({
        requestId: randomUUID(),
        op: "community.moderate-comment",
        input: hide,
        selector: { listOp: "list.comments" },
      }),
    ).toMatchObject({ ok: false, code: "NOT_AVAILABLE" });
    expect(
      await preview({
        requestId: randomUUID(),
        op: "community.moderate-comment",
        targets: [{ id: opaque("comment") }],
        chunkSeq: 1,
      }),
    ).toMatchObject({
      ok: false,
      code: "INPUT_INVALID",
      issues: [{ path: ["chunkSeq"] }],
    });
  });

  it("records a start and a finish for each call, as a reversible write of this tool", async () => {
    const requestId = randomUUID();
    const [id] = await comments(1);
    await preview({
      requestId,
      op: "community.moderate-comment",
      input: hide,
      targets: [{ id }],
    });
    expect(
      await harness.cms(sql`
        SELECT phase, tool, class, op, count::int AS count FROM mcp_audit_events
        WHERE request_id = ${requestId} ORDER BY id`),
    ).toEqual([
      {
        phase: "start",
        tool: "admin_preview",
        class: "reversible",
        op: "community.moderate-comment",
        count: 1,
      },
      expect.objectContaining({ phase: "finish", tool: "admin_preview" }),
    ]);
  });
});

describe("a reversible batch", () => {
  it("freezes 101 targets in two stamp reads, runs none of them, and seals with a way on", async () => {
    const ids = await comments(101);
    const requestId = randomUUID();
    const answer = await preview({
      requestId,
      op: "community.moderate-comment",
      input: hide,
      targets: ids.map((id) => ({ id })),
    });
    expect(answer).toMatchObject({
      ok: true,
      code: "OK",
      runId: answer.data.previewId,
      state: "previewed",
      data: {
        op: "community.moderate-comment",
        class: "reversible",
        count: 101,
        conflicts: { count: 0, rows: [] },
        consequences: ["subject_notified"],
        userNotifications: 101,
        needsOwnerConfirmation: false,
        sealed: true,
      },
      next: {
        tool: "admin_execute",
        args: { requestId, previewId: answer.data.previewId },
      },
      meta: { excluded: ["self_only"] },
    });
    expect(answer.data.sample).toHaveLength(10);
    expect(answer.data.sample[0]).toEqual({
      index: 0,
      ref: ids[0],
      state: "visible",
    });
    const row = await runRow(answer.data.previewId);
    expect(row).toMatchObject({
      state: "previewed",
      class: "reversible",
      target_count: 101,
      expected_count: 101,
    });
    expect(row!.seal_hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(row!.preview).toMatchObject({ count: 101, sealed: true });
    const frozen = await targetsOf(answer.data.previewId);
    expect(frozen).toHaveLength(101);
    expect(frozen[0]).toMatchObject({
      ref_key: `comment:${ids[0]}`,
      frozen_input: { id: ids[0] },
      stamp: "c0.0",
      state: "pending",
    });
    // Nothing ran: every comment is as it was.
    const { rows } = await harness.setup.query(
      "SELECT count(*)::int AS n FROM community.catalog_comments WHERE id=ANY($1::text[]) AND moderation='visible'",
      [ids],
    );
    expect(rows[0].n).toBe(101);
  });

  it("answers the same requestId with the same run, and another payload under it as a conflict", async () => {
    const ids = await comments(2);
    const call = {
      requestId: randomUUID(),
      op: "community.moderate-comment",
      input: hide,
      targets: ids.map((id) => ({ id })),
    };
    const first = await preview(call);
    const again = await preview(call);
    expect(again).toMatchObject({
      ok: true,
      runId: first.runId,
      meta: { replayed: true },
    });
    expect(again.data).toEqual(first.data);
    expect(await preview({ ...call, targets: [{ id: ids[0] }] })).toMatchObject(
      {
        ok: false,
        code: "IDEMPOTENCY_CONFLICT",
        issues: [{ path: ["requestId"], code: "different_payload" }],
      },
    );
    expect(await runsOf(call.requestId, "full")).toHaveLength(1);
  });

  it("names a missing or self-only target by its code, counts neither, and keeps its text out", async () => {
    const author = await seeds.newUser();
    const hidden = await seeds.newWork(author);
    const selfOnly = await seeds.newComment(hidden, author);
    await seeds.makeSelfOnly(hidden);
    const [visible] = await comments(1);
    const missing = opaque("comment");
    const { envelope, text } = await callTool(
      harness.clients.full,
      "admin_preview",
      {
        requestId: randomUUID(),
        op: "community.moderate-comment",
        input: hide,
        targets: [{ id: visible }, { id: selfOnly }, { id: missing }],
      },
    );
    expect(envelope).toMatchObject({
      ok: true,
      data: {
        count: 1,
        userNotifications: 1,
        conflicts: {
          count: 2,
          rows: [
            { index: 1, ref: selfOnly, code: "SELF_ONLY_OWNER_REVIEW" },
            { index: 2, ref: missing, code: "NOT_FOUND" },
          ],
        },
      },
    });
    expect(envelope.data.sample).toEqual([
      { index: 0, ref: visible, state: "visible" },
    ]);
    expect(text).not.toContain(`Comment ${harness.run}`);
    expect(text).not.toContain(`Work ${harness.run}`);
  });

  it("stays within the text cap however many targets conflict, and counts them all", async () => {
    const missing = Array.from({ length: 40 }, () => opaque("comment"));
    const { envelope, text } = await callTool(
      harness.clients.full,
      "admin_preview",
      {
        requestId: randomUUID(),
        op: "community.moderate-comment",
        input: hide,
        targets: missing.map((id) => ({ id })),
      },
    );
    expect(envelope.data.conflicts.count).toBe(40);
    expect(envelope.data.conflicts.rows).toHaveLength(ADMIN_PREVIEW_ROWS_MAX);
    expect(envelope.data.count).toBe(0);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(9_000);
  });

  it("carries no claimant contact in a preview of a decision on a rights notice", async () => {
    const author = await seeds.newUser();
    const reporter = await seeds.newUser();
    const work = await seeds.newWork(author);
    const report = await seeds.newRightsNotice(work, reporter);
    const { envelope, text } = await callTool(
      harness.clients.full,
      "admin_preview",
      {
        requestId: randomUUID(),
        op: "community.decide-report",
        targets: [
          {
            id: report,
            expectedVersion: await seeds.versionOfReport(report),
            action: "retain",
            reason: "Synthetic reason",
          },
        ],
      },
    );
    expect(envelope).toMatchObject({
      ok: true,
      data: { count: 1, consequences: ["subject_notified"] },
    });
    expect(text).not.toContain(harness.contactCanary);
    const [frozen] = await targetsOf(envelope.data.previewId);
    expect(JSON.stringify(frozen)).not.toContain(harness.contactCanary);
  });
});

describe("chunks", () => {
  it("waits for its expected count, seals at it, and keeps the count true through every refusal", async () => {
    const ids = await comments(4);
    const requestId = randomUUID();
    const first = await preview({
      requestId,
      op: "community.moderate-comment",
      input: hide,
      targets: [{ id: ids[0] }],
      expectedCount: 3,
    });
    expect(first).toMatchObject({
      ok: false,
      code: "IN_PROGRESS",
      done: 1,
      total: 3,
      remaining: 2,
      data: { count: 1, sealed: false },
    });
    expect(first.next).toBeUndefined();
    expect(first.retryable).toBeUndefined();
    expect(first.hint).toContain("chunkSeq 1");
    const previewId = first.runId as string;
    const chunk = (chunkSeq: number, targets: Json[], id = requestId) =>
      preview({ requestId: id, previewId, chunkSeq, appendTargets: targets });

    const second = await chunk(1, [{ id: ids[1] }]);
    expect(second).toMatchObject({
      code: "IN_PROGRESS",
      remaining: 1,
      data: { count: 2 },
    });
    expect(second.hint).toContain("chunkSeq 2");
    // The same number: the same targets replay, others conflict, and nothing moves.
    expect(await chunk(1, [{ id: ids[1] }])).toMatchObject({
      code: "IN_PROGRESS",
      remaining: 1,
      meta: { replayed: true },
    });
    expect(await chunk(1, [{ id: ids[2] }])).toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
    // Any other number, another run's requestId, a duplicate, one too many, a slip.
    expect(await chunk(3, [{ id: ids[2] }])).toMatchObject({
      code: "INPUT_INVALID",
      issues: [{ path: ["chunkSeq"], code: "not_next" }],
    });
    expect(await chunk(2, [{ id: ids[2] }], randomUUID())).toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
      issues: [{ path: ["requestId"], code: "not_this_run" }],
    });
    expect(await chunk(2, [{ id: ids[0] }])).toMatchObject({
      code: "INPUT_INVALID",
      issues: [{ path: ["appendTargets", 0], code: "duplicate_target" }],
    });
    expect(await chunk(2, [{ id: ids[2] }, { id: ids[3] }])).toMatchObject({
      code: "INPUT_INVALID",
      issues: [{ path: ["appendTargets"], code: "past_expected_count" }],
    });
    expect(await chunk(2, [{ id: ids[2], action: "erase" }])).toMatchObject({
      code: "INPUT_INVALID",
    });
    expect(
      await preview({
        requestId,
        previewId,
        chunkSeq: 2,
        continuePlanning: true,
      }),
    ).toMatchObject({
      code: "INPUT_INVALID",
      issues: [{ path: ["continuePlanning"], code: "no_selector" }],
    });
    expect(await runRow(previewId)).toMatchObject({
      state: "planning",
      target_count: 2,
      last_chunk_seq: 1,
      sealed_at: null,
    });

    const sealed = await chunk(2, [{ id: ids[2] }]);
    expect(sealed).toMatchObject({
      ok: true,
      state: "previewed",
      data: { count: 3, sealed: true },
      next: { tool: "admin_execute" },
    });
    expect(await chunk(3, [{ id: ids[3] }])).toMatchObject({
      code: "INPUT_INVALID",
      issues: [{ path: ["chunkSeq"], code: "sealed" }],
    });
    expect(await runRow(previewId)).toMatchObject({ target_count: 3 });
  });

  it("refuses a chunk for a run another key made as if there were none", async () => {
    const [id] = await comments(1);
    const made = await preview({
      requestId: randomUUID(),
      op: "community.moderate-comment",
      input: hide,
      targets: [{ id }],
      expectedCount: 2,
    });
    expect(
      await preview(
        {
          requestId: randomUUID(),
          previewId: made.runId,
          chunkSeq: 1,
          appendTargets: [{ id: opaque("comment") }],
        },
        "operate",
      ),
    ).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });
});

describe("an irreversible write", () => {
  const newRecord = () => ({
    content: syntheticCatalogDraft(
      `preview-new-${randomUUID()}`,
      `preview-new-source-${randomUUID()}`,
    ),
  });

  it("classes a save binding a new identity irreversible, seals it, and gives no way on", async () => {
    const answer = await preview({
      requestId: randomUUID(),
      op: "editorial.save-draft",
      targets: [newRecord()],
    });
    expect(answer).toMatchObject({
      ok: true,
      data: {
        class: "irreversible",
        count: 1,
        needsOwnerConfirmation: false,
        sealed: true,
        threshold: expect.any(Number) as number,
      },
    });
    expect(answer.next).toBeUndefined();
    expect(answer.hint).toContain("admin_execute_irreversible");
    expect(answer.meta.excluded).toBeUndefined();
    const [frozen] = await targetsOf(answer.data.previewId);
    expect(frozen).toMatchObject({ stamp: "none", state: "pending" });
  });

  it("says past the threshold that the Owner confirms, and an edit binding nothing new stays reversible", async () => {
    const threshold = Number(
      (await harness.cms(sql`SELECT threshold FROM mcp_control`))[0]!.threshold,
    );
    const many = await preview({
      requestId: randomUUID(),
      op: "editorial.save-draft",
      targets: Array.from({ length: threshold + 1 }, newRecord),
    });
    expect(many.data).toMatchObject({
      class: "irreversible",
      count: threshold + 1,
      needsOwnerConfirmation: true,
    });
    const draft = await seedDraft();
    const edit = await preview({
      requestId: randomUUID(),
      op: "editorial.save-draft",
      targets: [
        {
          id: draft.id,
          expectedRevision: draft.revision,
          content: {
            catalogId: draft.catalogId,
            sourceId: draft.sourceId,
            kind: "calligraphy",
            title: "Edited",
          },
        },
      ],
    });
    expect(edit).toMatchObject({
      ok: true,
      data: { class: "reversible", count: 1 },
      next: { tool: "admin_execute" },
    });
  });

  it("writes no run for a key that could never execute it", async () => {
    const requestId = randomUUID();
    const answer = await preview(
      { requestId, op: "editorial.save-draft", targets: [newRecord()] },
      "operate",
    );
    expect(answer).toMatchObject({
      ok: false,
      code: "NOT_AVAILABLE",
      data: {
        tool: "admin_execute_irreversible",
        unavailable: "tool_not_listed",
      },
    });
    expect(answer.hint).toContain("no run was written");
    expect(await runsOf(requestId, "operate")).toEqual([]);
    expect(
      await preview(
        {
          requestId: randomUUID(),
          op: "community.set-report-metadata",
          targets: [
            { id: opaque("report"), expectedVersion: 1, legalHold: false },
          ],
        },
        "operate",
      ),
    ).toMatchObject({
      code: "NOT_AVAILABLE",
      data: { unavailable: "tool_not_listed" },
    });
  });
});
