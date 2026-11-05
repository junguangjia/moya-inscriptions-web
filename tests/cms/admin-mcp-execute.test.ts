import { randomBytes, randomUUID } from "node:crypto";

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  ADMIN_MCP_TEXT_CAP_BYTES,
  adminExecuteDataSchema,
  adminMcpEnvelopeSchema,
  adminSaveEchoSchema,
  type AdminExecuteData,
  type AdminMcpEnvelope,
} from "@moya/contracts/internal/admin-mcp";
import { sql, type PostgresAdapter } from "@payloadcms/db-postgres";
import {
  createLocalReq,
  getPayload,
  handleEndpoints,
  type Payload,
  type SanitizedConfig,
  type TypedUser,
} from "payload";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { EXECUTE_BUDGET_MS, executeEnvelope } from "admin/admin-mcp";
import { approveBatch, saveDraft } from "admin/editorial";
import { saveArticleDraft } from "admin/editorial-content";
import { selectedMediaSnapshot } from "admin/media-snapshot";

import {
  connectClient,
  serveRoutes,
  syntheticCatalogDraft,
} from "./admin-mcp-wire.js";

// admin_execute direct mode (admin-mcp-completion-v1 section 7), driven as real
// JSON-RPC over a real socket with the official client. Matrix rows: "Reversible op
// on up to 100 targets", "Reversible op on more than 100 targets or by selector",
// "Lost answer or timeout", "Failed COMMIT", "Budget spent during a call", "Pause
// on", "Save that binds a new identity", "Document open by the Owner", "Prepare,
// request-release", "Create or approve an approval batch under an AI key". Every
// test seeds its own rows, so it passes alone on an empty database and on a used one.

if (process.env.CMS_ENVIRONMENT !== "synthetic")
  throw new Error("SYNTHETIC_CMS_TARGET_REQUIRED");

const run = randomUUID();
const password = randomBytes(24).toString("hex");
const SCOPE = `execute-scope-${run}`;

let config: SanitizedConfig;
let payload: Payload;
let server: Awaited<ReturnType<typeof serveRoutes>>;
let owner: TypedUser;
let automation: TypedUser;
let aiUser: TypedUser;
let client: Client;
let readClient: Client;
let keyId: number;
let operateSecret: string;
const scoped: string[] = [SCOPE];

type Answer = AdminMcpEnvelope & { data: AdminExecuteData };

const adapter = () => payload.db as unknown as PostgresAdapter;
const rowsOf = async (query: ReturnType<typeof sql>) =>
  (await adapter().drizzle.execute(query)).rows;
const reqFor = (user: TypedUser) => createLocalReq({ user }, payload);
const requestId = () => randomUUID();

const call = async (args: Record<string, unknown>): Promise<Answer> => {
  const result = await client.callTool({
    name: "admin_execute",
    arguments: args,
  });
  const answer = adminMcpEnvelopeSchema.parse(result.structuredContent);
  expect(result.isError === true).toBe(!answer.ok);
  expect(
    Buffer.byteLength((result.content as { text: string }[])[0]!.text),
  ).toBeLessThanOrEqual(ADMIN_MCP_TEXT_CAP_BYTES);
  return answer as Answer;
};

const follow = (next: AdminMcpEnvelope["next"]) => {
  expect(next?.tool).toBe("admin_execute");
  return call(next!.args);
};

let seeded = 0;
const seedDraft = async (fields: Record<string, unknown> = {}) => {
  seeded += 1;
  const catalogId = `execute-${seeded}-${run}`;
  const sourceId = `execute-source-${seeded}-${run}`;
  const saved = await saveDraft(await reqFor(owner), {
    idempotencyKey: `${run}:seed:${seeded}`,
    content: {
      ...syntheticCatalogDraft(catalogId, sourceId),
      ...fields,
    },
  });
  return {
    ...saved,
    catalogId,
    sourceId,
    identity: { catalogId, sourceId, kind: "calligraphy" },
  };
};

const seedDraftWithMedia = async () => {
  seeded += 1;
  const catalogId = `execute-${seeded}-${run}`;
  const bytes = await sharp({
    create: { width: 3, height: 2, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  const media = await payload.create({
    collection: "media",
    req: await reqFor(owner),
    overrideAccess: false,
    data: {
      mediaId: `execute-media-${seeded}-${run}`,
      catalogId,
      origin: "upload",
      objectKey: "",
      sha256: "",
      alt: "Synthetic original",
      rights: "Synthetic fixture",
      orderConfidence: "HIGH",
    },
    file: {
      name: "synthetic.png",
      data: bytes,
      mimetype: "image/png",
      size: bytes.length,
    },
  });
  const sourceId = `execute-source-${seeded}-${run}`;
  const mediaRow = selectedMediaSnapshot({ ...media }, catalogId, [])!;
  const saved = await saveDraft(await reqFor(owner), {
    idempotencyKey: `${run}:seed:${seeded}`,
    content: {
      ...syntheticCatalogDraft(catalogId, sourceId),
      media: [mediaRow],
    },
  });
  return {
    ...saved,
    catalogId,
    sourceId,
    mediaRow,
    identity: { catalogId, sourceId, kind: "calligraphy" },
  };
};

const draftOf = (id: number) =>
  payload.findByID({ collection: "catalogs", id, draft: true, depth: 0 });

const editOf = (
  draft: Awaited<ReturnType<typeof seedDraft>>,
  content: Record<string, unknown>,
) => ({
  id: draft.id,
  expectedRevision: draft.revision,
  content: { ...draft.identity, ...content },
});

const withCommitFailure = async <T>(work: () => Promise<T>): Promise<T> => {
  const db = adapter().drizzle;
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION execute_refuse_commit() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic commit failure'; END $$`);
  await db.execute(sql`
    CREATE CONSTRAINT TRIGGER execute_refuse_commit
    AFTER INSERT OR UPDATE ON editorial_receipts
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION execute_refuse_commit()`);
  try {
    return await work();
  } finally {
    await db.execute(
      sql`DROP TRIGGER execute_refuse_commit ON editorial_receipts`,
    );
    await db.execute(sql`DROP FUNCTION execute_refuse_commit()`);
  }
};

/** The commit lands and the read that would confirm it fails, once. */
const withStatusReadLost = async <T>(work: () => Promise<T>): Promise<T> => {
  const { drizzle } = adapter();
  const execute = drizzle.execute.bind(drizzle) as (query: never) => unknown;
  let spent = false;
  const spy = vi.spyOn(drizzle, "execute").mockImplementation(((
    query: never,
  ) => {
    const text = JSON.stringify(
      (query as { queryChunks?: { value?: unknown }[] }).queryChunks?.map(
        ({ value }) => value,
      ),
    );
    if (!spent && text?.includes("pg_xact_status")) {
      spent = true;
      return Promise.reject(new Error("synthetic lost connection"));
    }
    return execute(query);
  }) as never);
  try {
    return await work();
  } finally {
    spy.mockRestore();
  }
};

/** Runs `after` once, when the first target has committed. */
const afterFirstCommit = async <T>(
  after: () => Promise<void> | void,
  work: () => Promise<T>,
): Promise<T> => {
  const commit = payload.db.commitTransaction.bind(payload.db);
  let spent = false;
  const spy = vi
    .spyOn(payload.db, "commitTransaction")
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

/** The ledger refuses this request's per-target rows, and only those. */
const withTargetRowsRefused = async <T>(
  id: string,
  work: () => Promise<T>,
): Promise<T> => {
  const db = adapter().drizzle;
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION execute_refuse_audit() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic ledger failure'; END $$`);
  await db.execute(
    sql.raw(`
    CREATE TRIGGER execute_refuse_audit BEFORE INSERT ON mcp_audit_events
    FOR EACH ROW WHEN (NEW.tool IS NULL AND NEW.request_id = '${id}')
    EXECUTE FUNCTION execute_refuse_audit()`),
  );
  try {
    return await work();
  } finally {
    await db.execute(
      sql`DROP TRIGGER execute_refuse_audit ON mcp_audit_events`,
    );
    await db.execute(sql`DROP FUNCTION execute_refuse_audit()`);
  }
};

const auditRowsFor = (id: string) =>
  rowsOf(sql`
    SELECT tool, op, class, phase, ok, code, request_id, target_type, target_id,
      count::int AS count, key_id::int AS key_id
    FROM mcp_audit_events WHERE request_id = ${id} ORDER BY id`);

beforeAll(async () => {
  vi.stubEnv("COMMUNITY_OPERATOR_BASE_URL", "");
  vi.stubEnv("COMMUNITY_OPERATOR_TOKEN", "");
  config = await (await import("admin/config")).default;
  payload = await getPayload({ config });
  const account = (
    name: string,
    role: "owner" | "automation" | "ai_operator",
  ) =>
    payload.create({
      collection: "users",
      overrideAccess: true,
      data: {
        email: `execute-${name}-${run}@example.invalid`,
        password,
        role,
        scopeCatalogIds: [],
      } as never,
    });
  owner = await account("owner", "owner");
  automation = await account("automation", "automation");
  aiUser = await account("ai", "ai_operator");
  const secretOf = async (name: string, toolProfile: string) => {
    const secret = randomBytes(32).toString("hex");
    const created = await payload.create({
      collection: "payload-mcp-api-keys",
      overrideAccess: true,
      data: {
        user: aiUser.id,
        label: `synthetic-execute-${name}`,
        enableAPIKey: true,
        apiKey: secret,
        toolProfile,
      } as never,
    });
    return { secret, id: created.id };
  };
  const operate = await secretOf("operate", "operate");
  const read = await secretOf("read", "read");
  keyId = operate.id;
  operateSecret = operate.secret;
  server = await serveRoutes(config);
  client = (
    await connectClient(server.endpoint, {
      authorization: ["Bearer", operate.secret].join(" "),
    })
  ).client;
  readClient = (
    await connectClient(server.endpoint, {
      authorization: ["Bearer", read.secret].join(" "),
    })
  ).client;
}, 60_000);

afterAll(async () => {
  await client?.close();
  await readClient?.close();
  await server?.close();
  await payload?.destroy();
  vi.unstubAllEnvs();
});

describe("the tool on the wire", () => {
  it("lists for operate and full only, true of a reversible tool, and a read key has none", async () => {
    const listed = await client.listTools();
    const tool = listed.tools.find(({ name }) => name === "admin_execute");
    expect(tool?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(tool!.inputSchema.properties?.targets).toMatchObject({
      maxItems: 100,
    });
    expect(
      (await readClient.listTools()).tools.map(({ name }) => name),
    ).not.toContain("admin_execute");
    await expect(
      readClient.callTool({
        name: "admin_execute",
        arguments: {
          requestId: requestId(),
          op: "editorial.save-draft",
          input: {},
        },
      }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it.each([
    ["a name that does not exist", "editorial.no-such-op"],
    ["an inherited key", "constructor"],
    ["another inherited key", "__proto__"],
    ["a reserved surface", "users.update"],
    ["another reserved surface", "mcp-control.pause"],
    ["a read", "list.catalogs"],
  ])("answers UNKNOWN_OP to %s, with near names", async (_label, op) => {
    const answer = await call({ requestId: requestId(), op, input: {} });
    expect(answer).toMatchObject({ ok: false, code: "UNKNOWN_OP" });
    expect(JSON.stringify(answer)).not.toContain("no-such-op");
    expect((answer.data as { nearest?: unknown }).nearest).toBeInstanceOf(
      Array,
    );
  });

  it("refuses an irreversible op by name, and an op not built yet as not built", async () => {
    expect(
      await call({
        requestId: requestId(),
        op: "community.delete-body",
        input: {},
      }),
    ).toMatchObject({ ok: false, code: "USE_EXECUTE_IRREVERSIBLE" });
    expect(
      await call({
        requestId: requestId(),
        op: "ops.master.requeue",
        input: {},
      }),
    ).toMatchObject({ ok: false, code: "NOT_AVAILABLE" });
  });

  it("routes over 100 targets and a selector to a preview, and writes nothing", async () => {
    const draft = await seedDraft();
    const before = (await draftOf(draft.id)).revision;
    const targets = Array.from({ length: 101 }, () => ({
      id: draft.id,
      expectedRevision: before,
      content: { ...draft.identity, title: "Never" },
    }));
    expect(
      await call({
        requestId: requestId(),
        op: "editorial.save-draft",
        targets,
      }),
    ).toMatchObject({ ok: false, code: "USE_PREVIEW" });
    expect(
      await call({
        requestId: requestId(),
        op: "editorial.save-draft",
        selector: { listOp: "list.catalogs" },
      }),
    ).toMatchObject({ ok: false, code: "USE_PREVIEW" });
    expect((await draftOf(draft.id)).revision).toBe(before);
  });
});

describe("a bad input is named, never echoed, and never an internal error", () => {
  const CANARY = "EXECUTE-CANARY-VALUE";

  it.each<[string, () => Record<string, unknown>, string]>([
    [
      "a NUL in a value",
      () => ({
        input: {
          id: 1,
          expectedRevision: 1,
          content: { title: `${CANARY}\u0000` },
        },
      }),
      "nul_character",
    ],
    [
      "a NUL in a key",
      () => ({ input: { id: 1, content: { [`${CANARY}\u0000`]: 1 } } }),
      "forbidden_key",
    ],
    [
      "__proto__ in an input",
      () => JSON.parse(`{"input":{"__proto__":{"${CANARY}":1}}}`),
      "forbidden_key",
    ],
    [
      "__proto__ in a target",
      () => JSON.parse(`{"targets":[{"__proto__":{"id":1}}]}`),
      "forbidden_key",
    ],
    [
      "a key inherited from Object",
      () => ({ input: { content: {}, constructor: CANARY } }),
      "unrecognized_keys",
    ],
    [
      "an idempotencyKey of its own",
      () => ({ input: { content: {}, idempotencyKey: CANARY } }),
      "unrecognized_keys",
    ],
    [
      "input nested too deep",
      () => ({
        input: JSON.parse(
          `${'{"a":'.repeat(40)}"${CANARY}"${"}".repeat(40)}`,
        ) as object,
      }),
      "too_deep",
    ],
    ["a number that is not a list", () => ({ targets: [7] }), "custom"],
    ["no targets at all", () => ({ targets: [] }), "too_small"],
    ["a startAt past the end", () => ({ input: {}, startAt: 1 }), "too_big"],
    ["a startAt below zero", () => ({ input: {}, startAt: -1 }), "too_small"],
    ["a startAt that is no integer", () => ({ startAt: 0.5 }), "invalid_type"],
  ])("%s", async (_label, args, issue) => {
    const answer = await call({
      requestId: requestId(),
      op: "editorial.save-draft",
      ...args(),
    });
    expect(answer).toMatchObject({ ok: false, code: "INPUT_INVALID" });
    expect(answer.issues?.map(({ code }) => code)).toContain(issue);
    expect(JSON.stringify(answer)).not.toContain(CANARY);
  });

  it("refuses a requestId too long or not of the key's alphabet", async () => {
    for (const bad of ["x".repeat(129), `id with space ${CANARY}`]) {
      const answer = await call({
        requestId: bad,
        op: "editorial.save-draft",
        input: {},
      });
      expect(answer.code).toBe("INPUT_INVALID");
      expect(JSON.stringify(answer)).not.toContain(CANARY);
    }
  });

  it("checks every target first, so a slip in one leaves the batch undone", async () => {
    const first = await seedDraft();
    const answer = await call({
      requestId: requestId(),
      op: "editorial.save-draft",
      targets: [
        editOf(first, { title: "Should not land" }),
        { id: first.id, content: { title: CANARY } },
      ],
    });
    expect(answer.code).toBe("INPUT_INVALID");
    expect(answer.issues?.[0]?.path.slice(0, 2)).toEqual(["targets", "1"]);
    expect(JSON.stringify(answer)).not.toContain(CANARY);
    expect((await draftOf(first.id)).revision).toBe(first.revision);
  });

  it.each([
    ["an id past the integer column", 3_000_000_000],
    ["an id that is no integer", "12.5"],
    ["an id of no record", 2_000_000_000],
  ])("answers NOT_FOUND to %s, with no value back", async (_label, id) => {
    const draft = await seedDraft();
    const answer = await call({
      requestId: requestId(),
      op: "editorial.save-draft",
      input: {
        id,
        expectedRevision: 1,
        content: draft.identity,
      },
    });
    expect(answer).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(answer.data.failed?.[0]?.code).toBe("NOT_FOUND");
    if (typeof id === "string")
      expect(JSON.stringify(answer)).not.toContain(id);
  });

  it("leaves out an id that is not an id", async () => {
    const draft = await seedDraft();
    const answer = await call({
      requestId: requestId(),
      op: "editorial.save-draft",
      input: {
        id: `abc${CANARY}`,
        expectedRevision: 1,
        content: draft.identity,
      },
    });
    expect(answer.code).toBe("NOT_FOUND");
    expect(answer.data.failed).toEqual([{ index: 0, code: "NOT_FOUND" }]);
    expect(JSON.stringify(answer)).not.toContain(CANARY);
  });
});

describe("one save", () => {
  it("edits one field, echoes the record it wrote, and leaves the rest", async () => {
    const draft = await seedDraft({ title: "Before" });
    const id = requestId();
    const answer = await call({
      requestId: id,
      op: "editorial.save-draft",
      input: editOf(draft, { title: "题名已改" }),
    });
    expect(answer).toMatchObject({
      ok: true,
      code: "OK",
      done: 1,
      total: 1,
    });
    adminExecuteDataSchema.parse(answer.data);
    expect(answer.data.applied).toEqual([draft.id]);
    const { index, ...echo } = answer.data.results![0]!;
    expect(index).toBe(0);
    expect(adminSaveEchoSchema.parse(echo)).toEqual({
      id: draft.id,
      catalogId: draft.catalogId,
      title: "题名已改",
      revision: draft.revision + 1,
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u) as string,
      changedFields: ["title"],
      noRereadNeeded: true,
    });
    expect(answer.untrusted).toEqual(
      expect.arrayContaining(["/data/results/*/title"]),
    );
    const stored = await draftOf(draft.id);
    expect(stored).toMatchObject({
      title: "题名已改",
      revision: draft.revision + 1,
      summary: "Synthetic summary",
      transcription: { state: "VALUE", value: "合成" },
    });
    expect(stored.lastEditedBy).toBe(aiUser.id);
  });

  it("audits a start and a finish, with the op, the target and no content", async () => {
    const draft = await seedDraft();
    const id = requestId();
    await call({
      requestId: id,
      op: "editorial.save-draft",
      input: editOf(draft, { title: "AUDIT-CANARY-TITLE" }),
    });
    const rows = await auditRowsFor(id);
    expect(rows).toEqual([
      expect.objectContaining({
        tool: "admin_execute",
        op: "editorial.save-draft",
        class: "reversible",
        phase: "start",
        target_type: "catalog",
        target_id: String(draft.id),
        count: 1,
        key_id: keyId,
      }),
      expect.objectContaining({
        phase: "finish",
        ok: true,
        code: "OK",
        op: "editorial.save-draft",
      }),
    ]);
    expect(JSON.stringify(rows)).not.toContain("AUDIT-CANARY-TITLE");
  });

  it("replays the same requestId, changing nothing, and refuses a changed one", async () => {
    const draft = await seedDraft();
    const id = requestId();
    const input = editOf(draft, { title: "Once" });
    const first = await call({
      requestId: id,
      op: "editorial.save-draft",
      input,
    });
    const replay = await call({
      requestId: id,
      op: "editorial.save-draft",
      input,
    });
    expect(replay).toMatchObject({ ok: true, meta: { replayed: true } });
    expect(replay.data.already_applied).toEqual([draft.id]);
    expect(replay.data.results?.[0]).toMatchObject({
      revision: first.data.results?.[0]?.revision,
      fingerprint: first.data.results?.[0]?.fingerprint,
      noRereadNeeded: true,
    });
    expect(replay.data.results?.[0]).not.toHaveProperty("changedFields");
    expect((await draftOf(draft.id)).revision).toBe(draft.revision + 1);
    const conflict = await call({
      requestId: id,
      op: "editorial.save-draft",
      input: editOf(draft, { title: "Something else" }),
    });
    expect(conflict).toMatchObject({
      ok: false,
      code: "IDEMPOTENCY_CONFLICT",
    });
    expect(conflict.data.conflict?.[0]?.code).toBe("IDEMPOTENCY_CONFLICT");
    expect((await draftOf(draft.id)).title).toBe("Once");
    // The same id on another op of the family is a changed command too.
    expect(
      await call({
        requestId: id,
        op: "editorial.publish-approved",
        input: { approvalId: 1, id: draft.id },
      }),
    ).toMatchObject({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
  });

  it("refuses a stale revision, says which, and stores that answer for the key", async () => {
    const draft = await seedDraft();
    const id = requestId();
    const input = {
      ...editOf(draft, { title: "Stale" }),
      expectedRevision: draft.revision + 5,
    };
    const stale = await call({
      requestId: id,
      op: "editorial.save-draft",
      input,
    });
    expect(stale).toMatchObject({ ok: false, code: "REVISION_CONFLICT" });
    expect(stale.next).toBeUndefined();
    expect(stale.data.conflict).toEqual([
      { index: 0, id: draft.id, code: "REVISION_CONFLICT" },
    ]);
    const replay = await call({
      requestId: id,
      op: "editorial.save-draft",
      input,
    });
    expect(replay).toMatchObject({
      code: "REVISION_CONFLICT",
      meta: { replayed: true },
    });
    expect((await draftOf(draft.id)).revision).toBe(draft.revision);
  });

  it("names what validation refused, by field", async () => {
    const draft = await seedDraft();
    const answer = await call({
      requestId: requestId(),
      op: "editorial.save-draft",
      input: { ...editOf(draft, {}), content: { catalogId: draft.catalogId } },
    });
    expect(answer.code).toBe("INPUT_INVALID");
    expect(answer.issues?.[0]?.path.slice(0, 2)).toEqual(["input", "content"]);
  });

  it("answers IDENTITY_IMMUTABLE to a changed catalogId, not PREVIEW_REQUIRED", async () => {
    const draft = await seedDraft();
    const answer = await call({
      requestId: requestId(),
      op: "editorial.save-draft",
      input: editOf(draft, { catalogId: `other-${draft.catalogId}` }),
    });
    expect(answer).toMatchObject({ ok: false, code: "IDENTITY_IMMUTABLE" });
  });
});

describe("two calls at once, and an answer nobody read", () => {
  it("keeps two spellings of one record on one key: one save lands, the other meets its revision", async () => {
    const draft = await seedDraft();
    const answers = await Promise.all([
      call({
        requestId: requestId(),
        op: "editorial.save-draft",
        input: editOf(draft, { title: "First writer" }),
      }),
      call({
        requestId: requestId(),
        op: "editorial.save-draft",
        input: {
          ...editOf(draft, { summary: "Second writer" }),
          id: `+${draft.id}`,
        },
      }),
    ]);
    expect(answers.map(({ code }) => code).sort()).toEqual([
      "OK",
      "REVISION_CONFLICT",
    ]);
    expect((await draftOf(draft.id)).revision).toBe(draft.revision + 1);
  });

  it("lets one of two identical calls run, and the other replays it", async () => {
    const draft = await seedDraft();
    const args = {
      requestId: requestId(),
      op: "editorial.save-draft",
      input: editOf(draft, { title: "At once" }),
    };
    const answers = await Promise.all([call(args), call(args)]);
    expect(answers.map(({ ok }) => ok)).toEqual([true, true]);
    expect(answers.flatMap(({ data }) => data.applied ?? [])).toEqual([
      draft.id,
    ]);
    expect(answers.flatMap(({ data }) => data.already_applied ?? [])).toEqual([
      draft.id,
    ]);
    expect((await draftOf(draft.id)).revision).toBe(draft.revision + 1);
  });

  it("finishes the work when the client goes away, and the same requestId replays it", async () => {
    const draft = await seedDraft();
    const id = requestId();
    const input = editOf(draft, { title: "Nobody read this" });
    const hangUp = new AbortController();
    const lost = await afterFirstCommit(
      () => {
        hangUp.abort();
      },
      async () => {
        const sent = fetch(server.endpoint, {
          method: "POST",
          signal: hangUp.signal,
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            authorization: ["Bearer", operateSecret].join(" "),
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "admin_execute",
              arguments: {
                requestId: id,
                op: "editorial.save-draft",
                input,
              },
            },
          }),
        }).catch((error: unknown) => error);
        const answer = await sent;
        // The handler outlives the socket: wait for its finish row.
        await vi.waitFor(
          async () => {
            const rows = await auditRowsFor(id);
            expect(rows.map(({ phase }) => phase)).toContain("finish");
          },
          { timeout: 5_000, interval: 50 },
        );
        return answer;
      },
    );
    expect(lost).toBeInstanceOf(Error);
    expect((await draftOf(draft.id)).revision).toBe(draft.revision + 1);
    const retried = await call({
      requestId: id,
      op: "editorial.save-draft",
      input,
    });
    expect(retried).toMatchObject({ ok: true, meta: { replayed: true } });
    expect((await draftOf(draft.id)).revision).toBe(draft.revision + 1);
  });
});

describe("more calls at once than the Admin's share", () => {
  /** Saves on these records wait on their document key until this lets go of it. */
  const holdingKeys = async (ids: readonly number[]) => {
    const connection = await adapter().pool.connect();
    await connection.query("BEGIN");
    for (const id of ids)
      await connection.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`moya-editorial:document:${id}`],
      );
    return async () => {
      await connection.query("ROLLBACK");
      connection.release();
    };
  };
  const stalled = (count: number) =>
    vi.waitFor(
      async () => {
        const [row] = (await rowsOf(sql`
          SELECT count(*)::int AS waiting FROM pg_locks
          WHERE locktype = 'advisory' AND NOT granted`)) as {
          waiting: number;
        }[];
        expect(row!.waiting).toBeGreaterThanOrEqual(count);
      },
      { timeout: 4_000, interval: 10 },
    );
  const save = (
    draft: Awaited<ReturnType<typeof seedDraft>>,
    id = requestId(),
  ) => ({
    requestId: id,
    op: "editorial.save-draft",
    input: editOf(draft, { title: "Within the share" }),
  });

  it("refuses a third at once, runs nothing of it, and the same requestId works after", async () => {
    const [first, second, third] = [
      await seedDraft(),
      await seedDraft(),
      await seedDraft(),
    ];
    const release = await holdingKeys([first.id, second.id]);
    const running = [call(save(first)), call(save(second))];
    const id = requestId();
    try {
      await stalled(2);
      const asked = performance.now();
      const refused = await call(save(third, id));
      expect(performance.now() - asked).toBeLessThan(2_000);
      expect(refused).toMatchObject({
        ok: false,
        code: "EXECUTE_BUSY",
        retryable: true,
      });
      expect(await draftOf(third.id)).toMatchObject({
        revision: third.revision,
      });
      expect((await auditRowsFor(id)).at(-1)).toMatchObject({
        phase: "finish",
        ok: false,
        code: "EXECUTE_BUSY",
      });
    } finally {
      await release();
    }
    for (const answer of await Promise.all(running))
      expect(answer.ok).toBe(true);
    const after = await call(save(third, id));
    expect(after.ok).toBe(true);
    expect(after.data.applied).toEqual([third.id]);
  });

  it("holds a slot while a call whose client left still runs, and not after", async () => {
    const [first, second, third] = [
      await seedDraft(),
      await seedDraft(),
      await seedDraft(),
    ];
    const release = await holdingKeys([first.id, second.id]);
    const gone = save(first);
    const hangUp = new AbortController();
    const sent = fetch(server.endpoint, {
      method: "POST",
      signal: hangUp.signal,
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        authorization: ["Bearer", operateSecret].join(" "),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "admin_execute", arguments: gone },
      }),
    }).catch((error: unknown) => error);
    const running = call(save(second));
    try {
      await stalled(2);
      hangUp.abort();
      expect(await sent).toBeInstanceOf(Error);
      expect((await call(save(third))).code).toBe("EXECUTE_BUSY");
    } finally {
      await release();
    }
    expect((await running).ok).toBe(true);
    await vi.waitFor(
      async () =>
        expect(
          (await auditRowsFor(gone.requestId)).map(({ phase }) => phase),
        ).toContain("finish"),
      { timeout: 5_000, interval: 20 },
    );
    expect((await call(save(third))).ok).toBe(true);
  });

  it("gives its slot back when a call fails or throws", async () => {
    const draft = await seedDraft();
    for (let attempt = 0; attempt < 3; attempt += 1)
      expect((await withCommitFailure(() => call(save(draft)))).code).toBe(
        "OUTCOME_UNKNOWN",
      );
    const throwing = {
      get op(): string {
        throw new Error("synthetic failure");
      },
    };
    for (let attempt = 0; attempt < 3; attempt += 1)
      await expect(
        executeEnvelope(throwing, { key: {} as never, req: {} as never }),
      ).rejects.toThrow("synthetic failure");
    expect((await call(save(draft))).ok).toBe(true);
  });
});

describe("what a commit does not confirm", () => {
  it("answers OUTCOME_UNKNOWN to a failed COMMIT, keeps nothing, and the same requestId then applies", async () => {
    const draft = await seedDraft();
    const id = requestId();
    const input = editOf(draft, { title: "After a failed commit" });
    const unknown = await withCommitFailure(() =>
      call({ requestId: id, op: "editorial.save-draft", input }),
    );
    expect(unknown).toMatchObject({
      ok: false,
      code: "OUTCOME_UNKNOWN",
      retryable: true,
    });
    expect(unknown.data.unknown).toEqual([
      { index: 0, id: draft.id, code: "OUTCOME_UNKNOWN" },
    ]);
    expect(unknown.next?.args).toMatchObject({ requestId: id, input });
    expect((await draftOf(draft.id)).revision).toBe(draft.revision);
    const retried = await follow(unknown.next);
    expect(retried).toMatchObject({ ok: true });
    expect(retried.data.applied).toEqual([draft.id]);
    const [{ finish }] = (await rowsOf(sql`
      SELECT count(*) FILTER (WHERE code = 'OUTCOME_UNKNOWN') AS finish
      FROM mcp_audit_events WHERE request_id = ${id} AND phase = 'finish'`)) as {
      finish: unknown;
    }[] as [{ finish: unknown }];
    expect(Number(finish)).toBe(1);
  });

  it("answers OUTCOME_UNKNOWN when the commit landed unconfirmed, and the retry replays it", async () => {
    const draft = await seedDraft();
    const id = requestId();
    const input = editOf(draft, { title: "Landed unconfirmed" });
    const unknown = await withStatusReadLost(() =>
      call({ requestId: id, op: "editorial.save-draft", input }),
    );
    expect(unknown).toMatchObject({ ok: false, code: "OUTCOME_UNKNOWN" });
    expect((await draftOf(draft.id)).revision).toBe(draft.revision + 1);
    const retried = await follow(unknown.next);
    expect(retried).toMatchObject({ ok: true, meta: { replayed: true } });
    expect(retried.data.already_applied).toEqual([draft.id]);
    expect((await draftOf(draft.id)).revision).toBe(draft.revision + 1);
  });

  it("reads an unclassified failure as unknown, never as a refusal, and never echoes it", async () => {
    const draft = await seedDraft();
    const spy = vi
      .spyOn(payload, "update")
      .mockRejectedValueOnce(new Error("secret internal sentence"));
    try {
      const answer = await call({
        requestId: requestId(),
        op: "editorial.save-draft",
        input: editOf(draft, { title: "Unclassified" }),
      });
      expect(answer).toMatchObject({ ok: false, code: "OUTCOME_UNKNOWN" });
      expect(JSON.stringify(answer)).not.toContain("secret internal");
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps a committed save committed when reading its echo fails", async () => {
    const draft = await seedDraft();
    const findByID = payload.findByID.bind(payload);
    let reads = 0;
    const spy = vi.spyOn(payload, "findByID").mockImplementation(((options: {
      collection: string;
    }) => {
      if (options.collection === "catalogs") {
        reads += 1;
        // The one read before the save, and then the echo's.
        if (reads > 1 && !spent) {
          spent = true;
          return Promise.reject(new Error("synthetic lost connection"));
        }
      }
      return findByID(options as never);
    }) as never);
    let spent = false;
    try {
      const answer = await call({
        requestId: requestId(),
        op: "editorial.save-draft",
        input: editOf(draft, { title: "Echo lost" }),
      });
      expect(spent).toBe(true);
      expect(answer).toMatchObject({ ok: true });
      expect(answer.data.applied).toEqual([draft.id]);
      expect(answer.data.results?.[0]).toMatchObject({
        id: draft.id,
        revision: draft.revision + 1,
        warnings: ["echo_unread"],
      });
      expect(answer.data.results?.[0]).not.toHaveProperty("noRereadNeeded");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("a batch", () => {
  it("runs in order, names what each target did, and a replay repeats nothing", async () => {
    const good = await seedDraft();
    const stale = await seedDraft();
    const other = await seedDraft();
    const id = requestId();
    const targets = [
      editOf(good, { title: "Batch good" }),
      { ...editOf(stale, { title: "Batch stale" }), expectedRevision: 99 },
      {
        id: 2_000_000_001,
        expectedRevision: 1,
        content: other.identity,
      },
      editOf(other, { title: "Batch other" }),
    ];
    const answer = await call({
      requestId: id,
      op: "editorial.save-draft",
      targets,
    });
    expect(answer).toMatchObject({
      ok: false,
      code: "PARTIAL",
      done: 4,
      total: 4,
      meta: { partial: true },
    });
    expect(answer.next).toBeUndefined();
    adminExecuteDataSchema.parse(answer.data);
    expect(answer.data.applied).toEqual([good.id, other.id]);
    expect(answer.data.conflict).toEqual([
      { index: 1, id: stale.id, code: "REVISION_CONFLICT" },
    ]);
    expect(answer.data.failed).toEqual([
      { index: 2, id: 2_000_000_001, code: "NOT_FOUND" },
    ]);
    expect(answer.data.results?.map(({ index }) => index)).toEqual([0, 3]);

    const replay = await call({
      requestId: id,
      op: "editorial.save-draft",
      targets,
    });
    expect(replay.code).toBe("PARTIAL");
    expect(replay.data.already_applied).toEqual([good.id, other.id]);
    expect(replay.data.applied).toBeUndefined();
    expect((await draftOf(good.id)).revision).toBe(good.revision + 1);
    expect((await draftOf(other.id)).revision).toBe(other.revision + 1);
    expect((await draftOf(stale.id)).revision).toBe(stale.revision);
  });

  it("writes one audit row per target beside the call's own two", async () => {
    const first = await seedDraft();
    const second = await seedDraft();
    const id = requestId();
    await call({
      requestId: id,
      op: "editorial.save-draft",
      targets: [
        editOf(first, { title: "One" }),
        { ...editOf(second, { title: "Two" }), expectedRevision: 77 },
      ],
    });
    const rows = await auditRowsFor(id);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ phase: "start", count: 2 });
    expect(rows[0]!.target_id).toBeNull();
    expect(rows.slice(1, 3)).toEqual([
      expect.objectContaining({
        tool: null,
        phase: "finish",
        ok: true,
        code: "OK",
        target_id: String(first.id),
      }),
      expect.objectContaining({
        tool: null,
        phase: "finish",
        ok: false,
        code: "REVISION_CONFLICT",
        target_id: String(second.id),
      }),
    ]);
    expect(rows[3]).toMatchObject({
      tool: "admin_execute",
      phase: "finish",
      ok: false,
      code: "PARTIAL",
    });
  });

  it("merges common input into each target", async () => {
    const draft = await seedDraft();
    const answer = await call({
      requestId: requestId(),
      op: "editorial.save-draft",
      input: { expectedRevision: draft.revision },
      targets: [
        { id: draft.id, content: { ...draft.identity, title: "Merged" } },
      ],
    });
    expect(answer.ok).toBe(true);
    expect((await draftOf(draft.id)).title).toBe("Merged");
  });

  it("stops at the budget with next, and following next finishes the work once", async () => {
    const drafts = [await seedDraft(), await seedDraft(), await seedDraft()];
    const id = requestId();
    const real = performance.now.bind(performance);
    let offset = 0;
    const clock = vi
      .spyOn(performance, "now")
      .mockImplementation(() => real() + offset);
    let first: Answer;
    try {
      first = await afterFirstCommit(
        () => {
          offset = EXECUTE_BUDGET_MS + 1;
        },
        () =>
          call({
            requestId: id,
            op: "editorial.save-draft",
            targets: drafts.map((draft) =>
              editOf(draft, { title: "Budgeted" }),
            ),
          }),
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
      retryable: true,
    });
    expect(first.data.applied).toEqual([drafts[0]!.id]);
    expect(first.next?.args).toMatchObject({ requestId: id, startAt: 1 });
    expect(first.next?.args).not.toHaveProperty("priorIncomplete");
    expect((await draftOf(drafts[1]!.id)).revision).toBe(drafts[1]!.revision);
    const rest = await follow(first.next);
    expect(rest).toMatchObject({ ok: true, done: 2, total: 3 });
    expect(rest.data.applied).toEqual([drafts[1]!.id, drafts[2]!.id]);
    for (const draft of drafts)
      expect((await draftOf(draft.id)).revision).toBe(draft.revision + 1);
  });

  it("counts only its own targets when a caller sets startAt itself, and says so", async () => {
    const drafts = [await seedDraft(), await seedDraft()];
    const answer = await call({
      requestId: requestId(),
      op: "editorial.save-draft",
      targets: drafts.map((draft) => editOf(draft, { title: "From one on" })),
      startAt: 1,
    });
    expect(answer).toMatchObject({ ok: true, done: 1, total: 2 });
    expect(answer.data.applied).toEqual([drafts[1]!.id]);
    expect((await draftOf(drafts[0]!.id)).revision).toBe(drafts[0]!.revision);
    const { tools } = await client.listTools();
    const { inputSchema } = tools.find(({ name }) => name === "admin_execute")!;
    expect(inputSchema.properties?.startAt).toMatchObject({
      description: expect.stringContaining("this call's own count") as string,
    });
  });

  it("stops at the next target when the ledger cannot record one, says what ran, and goes on", async () => {
    const drafts = [await seedDraft(), await seedDraft(), await seedDraft()];
    const id = requestId();
    const args = {
      requestId: id,
      op: "editorial.save-draft",
      targets: drafts.map((draft) => editOf(draft, { title: "Unrecorded" })),
    };
    const stopped = await withTargetRowsRefused(id, () => call(args));
    expect(stopped).toMatchObject({
      ok: false,
      code: "AUDIT_UNAVAILABLE",
      retryable: true,
      done: 1,
      total: 3,
      remaining: 2,
    });
    expect(stopped.hint).toMatch(/named in data did run/u);
    expect(stopped.data.applied).toEqual([drafts[0]!.id]);
    expect(stopped.next?.args).toMatchObject({ requestId: id, startAt: 1 });
    expect((await draftOf(drafts[1]!.id)).revision).toBe(drafts[1]!.revision);
    const rest = await follow(stopped.next);
    expect(rest.ok).toBe(true);
    expect(rest.data.applied).toEqual([drafts[1]!.id, drafts[2]!.id]);
  });

  it("never reads ok:true at the end of a batch whose earlier call left a target undone", async () => {
    const stale = await seedDraft();
    const good = await seedDraft();
    const id = requestId();
    const targets = [
      { ...editOf(stale, { title: "Stale" }), expectedRevision: 44 },
      editOf(good, { title: "Fine" }),
    ];
    const real = performance.now.bind(performance);
    let offset = 0;
    const clock = vi
      .spyOn(performance, "now")
      .mockImplementation(() => real() + offset);
    let first: Answer;
    try {
      first = await afterFirstCommit(
        () => {
          offset = EXECUTE_BUDGET_MS + 1;
        },
        () => call({ requestId: id, op: "editorial.save-draft", targets }),
      );
    } finally {
      clock.mockRestore();
    }
    expect(first.code).toBe("IN_PROGRESS");
    expect(first.data.conflict?.[0]?.id).toBe(stale.id);
    expect(first.next?.args).toMatchObject({
      startAt: 1,
      priorIncomplete: true,
    });
    const rest = await follow(first.next);
    expect(rest).toMatchObject({
      ok: false,
      code: "PARTIAL",
      meta: { partial: true },
    });
    expect(rest.data.applied).toEqual([good.id]);
    // It names no failed target, so it says how to see them, and that works.
    expect(rest.data.conflict).toBeUndefined();
    expect(rest.hint).toMatch(/same requestId and no startAt to see every/u);
    const whole = await call({
      requestId: id,
      op: "editorial.save-draft",
      targets,
    });
    expect(whole.data.conflict?.[0]?.id).toBe(stale.id);
    expect(whole.data.already_applied).toEqual([good.id]);
    // A refusal of its own in that last call leaves the same to say.
    const refused = await call({
      requestId: requestId(),
      op: "editorial.save-draft",
      targets,
      startAt: 0,
      priorIncomplete: true,
    });
    expect(refused.code).toBe("PARTIAL");
    expect(refused.hint).toMatch(/same requestId and no startAt to see every/u);
  });

  it("stops at the next target when the Owner pauses mid-batch, and goes on after", async () => {
    const drafts = [await seedDraft(), await seedDraft()];
    const setPause = (on: boolean) =>
      adapter().drizzle.execute(sql`UPDATE mcp_control SET pause = ${on}`);
    let paused: Answer;
    try {
      paused = await afterFirstCommit(
        async () => {
          await setPause(true);
        },
        () =>
          call({
            requestId: requestId(),
            op: "editorial.save-draft",
            targets: drafts.map((draft) => editOf(draft, { title: "Paused" })),
          }),
      );
    } finally {
      await setPause(false);
    }
    expect(paused).toMatchObject({
      ok: false,
      code: "MCP_PAUSED",
      done: 1,
      remaining: 1,
    });
    expect(paused.data.applied).toEqual([drafts[0]!.id]);
    expect((await draftOf(drafts[1]!.id)).revision).toBe(drafts[1]!.revision);
    const rest = await follow(paused.next);
    expect(rest.ok).toBe(true);
    expect(rest.data.applied).toEqual([drafts[1]!.id]);
  });

  it("cuts the echoes, never the groups, and next reads on from the first one left out", async () => {
    const drafts: Awaited<ReturnType<typeof seedDraft>>[] = [];
    for (let index = 0; index < 30; index += 1)
      drafts.push(await seedDraft({ title: `碑刻${"石".repeat(60)}${index}` }));
    const id = requestId();
    const answer = await call({
      requestId: id,
      op: "editorial.save-draft",
      targets: drafts.map((draft) =>
        editOf(draft, { title: `已改${"石".repeat(60)}` }),
      ),
    });
    expect(answer).toMatchObject({
      ok: true,
      done: 30,
      total: 30,
      meta: { truncated: true },
    });
    expect(answer.data.applied).toEqual(drafts.map(({ id: row }) => row));
    const kept = answer.data.results!.length;
    expect(kept).toBeGreaterThan(5);
    expect(kept).toBeLessThan(30);
    expect(answer.remaining).toBe(30 - kept);
    expect(answer.next?.args).toMatchObject({ requestId: id, startAt: kept });
    const rest = await call({
      requestId: id,
      op: "editorial.save-draft",
      targets: drafts.map((draft) =>
        editOf(draft, { title: `已改${"石".repeat(60)}` }),
      ),
      startAt: kept,
    });
    expect(rest.ok).toBe(true);
    expect(rest.data.results?.[0]?.index).toBe(kept);
    expect(rest.data.already_applied).toEqual(
      drafts.slice(kept).map(({ id: row }) => row),
    );
  }, 60_000);

  it("leaves large targets out of next, and says to send them again", async () => {
    const draft = await seedDraft();
    const stale = {
      ...editOf(draft, {
        transcription: { state: "VALUE", value: "碑".repeat(2_000) },
      }),
    };
    const id = requestId();
    const unknown = await withCommitFailure(() =>
      call({ requestId: id, op: "editorial.save-draft", input: stale }),
    );
    expect(unknown.code).toBe("OUTCOME_UNKNOWN");
    expect(unknown.next?.args).toEqual({
      requestId: id,
      op: "editorial.save-draft",
    });
    expect(unknown.hint).toMatch(/send the same ones again/u);
    // Followed to the letter, it is refused by name, and nothing runs.
    const literal = await follow(unknown.next);
    expect(literal.code).toBe("INPUT_INVALID");
    expect(
      (
        await call({
          requestId: id,
          op: "editorial.save-draft",
          input: stale,
        })
      ).ok,
    ).toBe(true);
  });
});

describe("a save that binds a new identity", () => {
  const provenanceRow = (sourceId: string) => ({ sourceId });

  it("answers PREVIEW_REQUIRED to a new provenance sourceId, and binds nothing", async () => {
    const draft = await seedDraft();
    const sourceId = `execute-new-${randomUUID()}`;
    const answer = await call({
      requestId: requestId(),
      op: "editorial.save-draft",
      input: editOf(draft, { provenance: [provenanceRow(sourceId)] }),
    });
    expect(answer).toMatchObject({ ok: false, code: "PREVIEW_REQUIRED" });
    expect(answer.data.failed).toEqual([
      { index: 0, id: draft.id, code: "PREVIEW_REQUIRED" },
    ]);
    expect((await draftOf(draft.id)).revision).toBe(draft.revision);
    expect(
      await rowsOf(
        sql`SELECT 1 FROM editorial_identities WHERE identity_value = ${sourceId}`,
      ),
    ).toEqual([]);
  });

  it("stays direct when every sourceId is already this record's", async () => {
    const sourceId = `execute-own-${randomUUID()}`;
    const draft = await seedDraft({ provenance: [provenanceRow(sourceId)] });
    const answer = await call({
      requestId: requestId(),
      op: "editorial.save-draft",
      input: editOf(draft, { provenance: [provenanceRow(sourceId)] }),
    });
    expect(answer.ok).toBe(true);
  });

  it("answers IDENTITY_ALREADY_BOUND for one another record holds, and it is no new identity", async () => {
    const sourceId = `execute-other-${randomUUID()}`;
    await seedDraft({ provenance: [provenanceRow(sourceId)] });
    const draft = await seedDraft();
    const answer = await call({
      requestId: requestId(),
      op: "editorial.save-draft",
      input: editOf(draft, { provenance: [provenanceRow(sourceId)] }),
    });
    expect(answer).toMatchObject({
      ok: false,
      code: "IDENTITY_ALREADY_BOUND",
    });
  });

  it("answers PREVIEW_REQUIRED to a create, Catalog or Article, and creates nothing", async () => {
    const catalogId = `execute-create-${randomUUID()}`;
    expect(
      await call({
        requestId: requestId(),
        op: "editorial.save-draft",
        input: { content: syntheticCatalogDraft(catalogId, `s-${catalogId}`) },
      }),
    ).toMatchObject({ ok: false, code: "PREVIEW_REQUIRED" });
    expect(
      await rowsOf(sql`SELECT 1 FROM catalogs WHERE catalog_id = ${catalogId}`),
    ).toEqual([]);
    expect(
      await call({
        requestId: requestId(),
        op: "editorial.save-article-draft",
        input: { content: { title: "New" } },
      }),
    ).toMatchObject({ ok: false, code: "PREVIEW_REQUIRED" });
  });

  it("refuses more provenance than a record holds by name, before the query that would fail on it", async () => {
    const draft = await seedDraft();
    const answer = await call({
      requestId: requestId(),
      op: "editorial.save-draft",
      input: editOf(draft, {
        provenance: Array.from({ length: 70_000 }, (_, index) => ({
          sourceId: `s-${index}`,
        })),
      }),
    });
    expect(answer).toMatchObject({ ok: false, code: "CONTENT_INVALID" });
    expect(answer.next).toBeUndefined();
    expect(answer.data.failed?.[0]?.fields).toEqual(["provenance"]);
    expect((await draftOf(draft.id)).revision).toBe(draft.revision);
  });

  it("runs the rest of a batch, and names the one that needs a preview", async () => {
    const plain = await seedDraft();
    const binding = await seedDraft();
    const answer = await call({
      requestId: requestId(),
      op: "editorial.save-draft",
      targets: [
        editOf(plain, { title: "Plain" }),
        editOf(binding, {
          provenance: [provenanceRow(`execute-new-${randomUUID()}`)],
        }),
      ],
    });
    expect(answer.code).toBe("PARTIAL");
    expect(answer.data.applied).toEqual([plain.id]);
    expect(answer.data.failed).toEqual([
      { index: 1, id: binding.id, code: "PREVIEW_REQUIRED" },
    ]);
  });
});

describe("a save that removes entries", () => {
  it("leaves an omitted array alone, needs allowRemoving to drop media, and reports what went", async () => {
    const draft = await seedDraftWithMedia();
    const omitted = await call({
      requestId: requestId(),
      op: "editorial.save-draft",
      input: editOf(draft, { title: "Media untouched" }),
    });
    expect(omitted.ok).toBe(true);
    expect(omitted.data.results?.[0]?.changedFields).toEqual(["title"]);
    const stored = await draftOf(draft.id);
    expect(stored.media).toHaveLength(1);

    const id = requestId();
    const input = {
      id: draft.id,
      expectedRevision: draft.revision + 1,
      content: { ...draft.identity, media: [] },
    };
    const refused = await call({
      requestId: id,
      op: "editorial.save-draft",
      input,
    });
    expect(refused).toMatchObject({ ok: false, code: "REMOVAL_NOT_ALLOWED" });
    expect(refused.data.failed).toEqual([
      {
        index: 0,
        id: draft.id,
        code: "REMOVAL_NOT_ALLOWED",
        fields: ["media"],
      },
    ]);
    expect((await draftOf(draft.id)).revision).toBe(draft.revision + 1);

    // No receipt holds that answer, so the same requestId can say it means it.
    const allowed = await call({
      requestId: id,
      op: "editorial.save-draft",
      input: { ...input, allowRemoving: true },
    });
    expect(allowed.ok).toBe(true);
    expect(allowed.data.results?.[0]).toMatchObject({
      removedItems: { media: [draft.mediaRow.mediaId] },
      changedFields: ["media"],
    });
    expect(allowed.untrusted).toContain("/data/results/*/removedItems/media/*");
    expect(allowed.untrusted).not.toContain(
      "/data/results/*/removedItems/provenance/*",
    );
    expect((await draftOf(draft.id)).media).toEqual([]);
  });

  /** Built here, so no file holds a link that reads as carrying a credential. */
  const withheldLink = () =>
    `https://example.invalid/source?${["to", "ken"].join("")}=${randomUUID()}`;

  it("asks before clearing a link the caller could not read, and names it without its value", async () => {
    const provenanceLink = withheldLink();
    const citationLink = withheldLink();
    const sourceId = `execute-link-${randomUUID()}`;
    const draft = await seedDraft({
      provenance: [{ sourceId, sourceUrl: provenanceLink }],
      sourceCitations: [
        { label: "Plain", url: "https://example.invalid/plain" },
        { label: "Held", url: citationLink },
      ],
    });
    const id = requestId();
    const input = editOf(draft, {
      provenance: [{ sourceId, sourceNote: "Only a note" }],
      sourceCitations: [{ label: "Plain" }, { label: "Held" }],
    });
    const refused = await call({
      requestId: id,
      op: "editorial.save-draft",
      input,
    });
    expect(refused).toMatchObject({ ok: false, code: "REMOVAL_NOT_ALLOWED" });
    const places = ["provenance.0.sourceUrl", "sourceCitations.1.url"];
    expect(refused.data.failed?.[0]?.fields).toEqual(places);
    const kept = await draftOf(draft.id);
    expect(kept.provenance?.[0]?.sourceUrl).toBe(provenanceLink);
    expect(kept.sourceCitations?.[1]?.url).toBe(citationLink);
    expect(kept.revision).toBe(draft.revision);

    const allowed = await call({
      requestId: id,
      op: "editorial.save-draft",
      input: { ...input, allowRemoving: true },
    });
    expect(allowed.ok).toBe(true);
    expect(allowed.data.results?.[0]).toMatchObject({
      removedItems: { links: places },
    });
    for (const answer of [refused, allowed]) {
      expect(JSON.stringify(answer)).not.toContain(provenanceLink);
      expect(JSON.stringify(answer)).not.toContain(citationLink);
    }
    const cleared = await draftOf(draft.id);
    expect(cleared.provenance?.[0]?.sourceUrl ?? null).toBeNull();
    expect(cleared.sourceCitations?.[1]?.url ?? null).toBeNull();
  });

  it("does not ask when the field is left out, or the link is sent again, or it could be read", async () => {
    const link = withheldLink();
    const draft = await seedDraft({
      sourceCitations: [
        { label: "Plain", url: "https://example.invalid/plain" },
        { label: "Held", url: link },
      ],
    });
    const omitted = await call({
      requestId: requestId(),
      op: "editorial.save-draft",
      input: editOf(draft, { title: "Links untouched" }),
    });
    expect(omitted.ok).toBe(true);
    const resent = await call({
      requestId: requestId(),
      op: "editorial.save-draft",
      input: {
        ...editOf(draft, {
          sourceCitations: [{ label: "Plain" }, { label: "Held", url: link }],
        }),
        expectedRevision: draft.revision + 1,
      },
    });
    expect(resent.ok).toBe(true);
    expect(resent.data.results?.[0]).not.toHaveProperty("removedItems");
    expect((await draftOf(draft.id)).sourceCitations?.[1]?.url).toBe(link);
  });

  it("asks the same of an Article's citation", async () => {
    const link = withheldLink();
    const article = await saveArticleDraft(await reqFor(owner), {
      idempotencyKey: `${run}:article:${randomUUID()}`,
      content: {
        presentation: "news",
        title: "Held citation",
        summary: "Synthetic",
        section: "田野观察",
        byline: "由艺编辑室",
        sections: [{ body: "第一段。" }],
        citations: [{ text: "原引用", url: link }],
      },
    });
    const id = requestId();
    const input = {
      id: article.id,
      expectedRevision: article.revision,
      content: { citations: [{ text: "原引用" }] },
    };
    const refused = await call({
      requestId: id,
      op: "editorial.save-article-draft",
      input,
    });
    expect(refused).toMatchObject({ ok: false, code: "REMOVAL_NOT_ALLOWED" });
    expect(refused.data.failed?.[0]?.fields).toEqual(["citations.0.url"]);
    const allowed = await call({
      requestId: id,
      op: "editorial.save-article-draft",
      input: { ...input, allowRemoving: true },
    });
    expect(allowed.ok).toBe(true);
    expect(allowed.data.results?.[0]).toMatchObject({
      removedItems: { links: ["citations.0.url"] },
    });
    expect(JSON.stringify(allowed)).not.toContain(link);
  });

  it("refuses an Article row sent by its id, so a link it keeps never reads as cleared", async () => {
    const link = withheldLink();
    const article = await saveArticleDraft(await reqFor(owner), {
      idempotencyKey: `${run}:article:${randomUUID()}`,
      content: {
        presentation: "news",
        title: "Held citation",
        summary: "Synthetic",
        section: "田野观察",
        byline: "由艺编辑室",
        sections: [{ body: "第一段。" }],
        citations: [{ text: "原引用", url: link }],
      },
    });
    const stored = () =>
      payload.findByID({
        collection: "articles",
        id: article.id,
        draft: true,
        depth: 0,
      });
    const before = await stored();
    const answer = await call({
      requestId: requestId(),
      op: "editorial.save-article-draft",
      input: {
        id: article.id,
        expectedRevision: article.revision,
        allowRemoving: true,
        content: {
          citations: [{ id: before.citations?.[0]?.id, text: "改了文字" }],
        },
      },
    });
    expect(answer).toMatchObject({ ok: false, code: "INPUT_INVALID" });
    const after = await stored();
    expect(after.revision).toBe(before.revision);
    expect(after.citations).toEqual(before.citations);
  });

  it("names a link an Article's restore drops, without asking first", async () => {
    const content = {
      presentation: "news",
      title: "Restored citation",
      summary: "Synthetic",
      section: "田野观察",
      byline: "由艺编辑室",
      sections: [{ body: "第一段。" }],
    };
    const first = await saveArticleDraft(await reqFor(owner), {
      idempotencyKey: `${run}:article:${randomUUID()}`,
      content: { ...content, citations: [{ text: "原引用" }] },
    });
    const link = withheldLink();
    const second = await saveArticleDraft(await reqFor(owner), {
      idempotencyKey: `${run}:article:${randomUUID()}`,
      id: first.id,
      expectedRevision: first.revision,
      content: { ...content, citations: [{ text: "原引用", url: link }] },
    });
    const { docs } = await payload.findVersions({
      collection: "articles",
      where: { parent: { equals: first.id } },
      sort: "createdAt",
      limit: 1,
      depth: 0,
      overrideAccess: true,
    });
    const restored = await call({
      requestId: requestId(),
      op: "article.restore",
      input: {
        id: first.id,
        versionId: docs[0]!.id,
        expected: { revision: second.revision },
      },
    });
    expect(restored.ok).toBe(true);
    expect(restored.data.results?.[0]).toMatchObject({
      changedFields: ["citations"],
      removedItems: { links: ["citations.0.url"] },
    });
    expect(JSON.stringify(restored)).not.toContain(link);
    const after = await payload.findByID({
      collection: "articles",
      id: first.id,
      draft: true,
      depth: 0,
    });
    expect(after.citations?.[0]?.url ?? null).toBeNull();
  });

  it("keeps a kept entry out of what it calls removed, and reads a stale save as a conflict", async () => {
    const draft = await seedDraftWithMedia();
    const kept = await call({
      requestId: requestId(),
      op: "editorial.save-draft",
      input: editOf(draft, { media: [draft.mediaRow] }),
    });
    expect(kept.ok).toBe(true);
    const stale = await call({
      requestId: requestId(),
      op: "editorial.save-draft",
      input: {
        ...editOf(draft, { media: [] }),
        expectedRevision: draft.revision,
      },
    });
    expect(stale.code).toBe("REVISION_CONFLICT");
  });
});

describe("a document the Owner has open", () => {
  it("answers DOCUMENT_LOCKED with who and until when, and the same requestId works after", async () => {
    const draft = await seedDraft();
    const lock = await payload.create({
      collection: "payload-locked-documents",
      overrideAccess: true,
      data: {
        document: { relationTo: "catalogs", value: draft.id },
        user: { relationTo: "users", value: owner.id },
      } as never,
    });
    const id = requestId();
    const input = editOf(draft, { title: "After the lock" });
    const locked = await call({
      requestId: id,
      op: "editorial.save-draft",
      input,
    });
    expect(locked).toMatchObject({ ok: false, code: "DOCUMENT_LOCKED" });
    const [row] = locked.data.conflict!;
    expect(row).toMatchObject({
      index: 0,
      id: draft.id,
      code: "DOCUMENT_LOCKED",
      lock: { held: true, by: "owner" },
    });
    expect(Date.parse(row!.lock!.expiresAt!)).toBeGreaterThan(Date.now());
    expect(locked.next?.args).toMatchObject({ requestId: id, input });
    expect(locked.next?.afterMs).toBeGreaterThan(0);
    expect(locked.next?.afterMs).toBeLessThanOrEqual(300_000);
    expect((await draftOf(draft.id)).revision).toBe(draft.revision);
    await payload.delete({
      collection: "payload-locked-documents",
      id: lock.id,
      overrideAccess: true,
    });
    const after = await follow(locked.next);
    expect(after.ok).toBe(true);
  });

  it("never offers altered text: a body the strip would change goes unsent, and what is stored keeps it", async () => {
    const draft = await seedDraft();
    const other = await seedDraft();
    const lockOf = (id: number) =>
      payload.create({
        collection: "payload-locked-documents",
        overrideAccess: true,
        data: {
          document: { relationTo: "catalogs", value: id },
          user: { relationTo: "users", value: owner.id },
        } as never,
      });
    const lock = await lockOf(draft.id);
    const text = "甲\u200b乙\u200d丙\u00ad丁";
    const id = requestId();
    const input = editOf(draft, { summary: text });
    const op = "editorial.save-draft";
    const locked = await call({ requestId: id, op, input });
    expect(locked.code).toBe("DOCUMENT_LOCKED");
    expect(locked.next?.args).toEqual({ requestId: id, op });
    expect(locked.hint).toMatch(/send the same ones again/u);

    const batchId = requestId();
    const batch = await call({
      requestId: batchId,
      op,
      targets: [editOf(other, { title: "Clean" }), input],
    });
    expect(batch.code).toBe("PARTIAL");
    expect(batch.next?.args).toEqual({ requestId: batchId, op });

    await payload.delete({
      collection: "payload-locked-documents",
      id: lock.id,
      overrideAccess: true,
    });
    // Followed to the letter it is refused by name, and nothing runs.
    expect((await follow(locked.next)).code).toBe("INPUT_INVALID");
    expect((await draftOf(draft.id)).revision).toBe(draft.revision);
    const same = await call({ requestId: id, op, input });
    expect(same.ok).toBe(true);
    expect((await draftOf(draft.id)).summary).toBe(text);
  });
});

describe("approvals under an AI key", () => {
  const seedScopedDraft = async () => {
    const draft = await seedDraft();
    scoped.push(draft.catalogId);
    await payload.update({
      collection: "users",
      id: automation.id,
      overrideAccess: true,
      data: { scopeCatalogIds: scoped } as never,
    });
    return draft;
  };

  it("approves as itself, and a repeat replays the same batch, not a second one", async () => {
    const draft = await seedScopedDraft();
    const id = requestId();
    const input = {
      automationUserId: automation.id,
      items: [{ id: draft.id, revision: draft.revision }],
    };
    const first = await call({
      requestId: id,
      op: "editorial.approve-batch",
      input,
    });
    expect(first).toMatchObject({ ok: true });
    const answer = first.data.results![0]! as unknown as {
      approvalId: number;
      itemCount: number;
      status: string;
    };
    expect(answer).toMatchObject({ itemCount: 1, status: "active" });
    expect(first.data.applied).toEqual([answer.approvalId]);
    const approval = await payload.findByID({
      collection: "editorial-approvals",
      id: answer.approvalId,
      depth: 0,
    });
    expect(approval.approvedBy).toBe(aiUser.id);

    const replay = await call({
      requestId: id,
      op: "editorial.approve-batch",
      input,
    });
    expect(replay).toMatchObject({ ok: true, meta: { replayed: true } });
    expect(replay.data.results?.[0]).toMatchObject({
      approvalId: answer.approvalId,
    });
    expect(
      await rowsOf(sql`
        SELECT a.id FROM editorial_approvals a
        JOIN editorial_approvals_items i ON i._parent_id = a.id
        WHERE i.catalog_id = ${draft.id}`),
    ).toHaveLength(1);

    // A replay reads what the batch says now.
    await payload.update({
      collection: "editorial-approvals",
      id: answer.approvalId,
      req: await reqFor(owner),
      overrideAccess: false,
      data: { status: "revoked" },
    });
    const later = await call({
      requestId: id,
      op: "editorial.approve-batch",
      input,
    });
    expect(later.data.results?.[0]).toMatchObject({ status: "revoked" });
  });

  it("leaves one approval after an unknown answer, whichever way the commit went", async () => {
    const draft = await seedScopedDraft();
    const approvals = () =>
      rowsOf(sql`
        SELECT a.id FROM editorial_approvals a
        JOIN editorial_approvals_items i ON i._parent_id = a.id
        WHERE i.catalog_id = ${draft.id}`);
    const input = {
      automationUserId: automation.id,
      items: [{ id: draft.id, revision: draft.revision }],
    };
    const refused = requestId();
    const failed = await withCommitFailure(() =>
      call({ requestId: refused, op: "editorial.approve-batch", input }),
    );
    expect(failed.code).toBe("OUTCOME_UNKNOWN");
    expect(await approvals()).toEqual([]);

    const landed = requestId();
    const unknown = await withStatusReadLost(() =>
      call({ requestId: landed, op: "editorial.approve-batch", input }),
    );
    expect(unknown.code).toBe("OUTCOME_UNKNOWN");
    expect(await approvals()).toHaveLength(1);
    const replay = await follow(unknown.next);
    expect(replay).toMatchObject({ ok: true, meta: { replayed: true } });
    expect(await approvals()).toHaveLength(1);
  });

  it("publishes what it approved, and a repeat under a new id says already applied", async () => {
    const draft = await seedScopedDraft();
    const approved = await approveBatch(await reqFor(owner), {
      automationUserId: automation.id,
      items: [{ id: draft.id, revision: draft.revision }],
    });
    const input = { approvalId: approved.approvalId, id: draft.id };
    const published = await call({
      requestId: requestId(),
      op: "editorial.publish-approved",
      input,
    });
    expect(published).toMatchObject({ ok: true });
    expect(published.data.applied).toEqual([draft.id]);
    expect((await draftOf(draft.id))._status).toBe("published");
    const again = await call({
      requestId: requestId(),
      op: "editorial.publish-approved",
      input,
    });
    expect(again).toMatchObject({ ok: true });
    expect(again.data.already_applied).toEqual([draft.id]);
  });

  it("says what a Catalog is now on a replay of its approved publish since withdrawn", async () => {
    const draft = await seedScopedDraft();
    const { approvalId } = await approveBatch(await reqFor(owner), {
      automationUserId: automation.id,
      items: [{ id: draft.id, revision: draft.revision }],
    });
    const id = requestId();
    const input = { approvalId, id: draft.id };
    const op = "editorial.publish-approved";
    const first = await call({ requestId: id, op, input });
    expect(first.data.results?.[0]).toMatchObject({
      id: draft.id,
      status: "published",
      noRereadNeeded: true,
    });
    await call({
      requestId: requestId(),
      op: "catalog.withdraw",
      input: {
        id: draft.id,
        expected: { revision: first.data.results?.[0]?.revision },
      },
    });
    const replay = await call({ requestId: id, op, input });
    expect(replay).toMatchObject({ ok: true, meta: { replayed: true } });
    expect(replay.data.already_applied).toEqual([draft.id]);
    expect(replay.data.results?.[0]).toMatchObject({
      catalogId: draft.catalogId,
      status: "draft",
      warnings: ["moved_since_save"],
    });
    expect(replay.untrusted).toContain("/data/results/*/title");
  });

  it("says what an Article is now on a replay of its approved publish since withdrawn", async () => {
    const article = await saveArticleDraft(await reqFor(owner), {
      idempotencyKey: `${run}:article:${randomUUID()}`,
      content: {
        presentation: "news",
        title: "Approved article",
        summary: "Synthetic",
        section: "田野观察",
        byline: "由艺编辑室",
        sections: [{ body: "第一段。" }],
        citations: [],
      },
    });
    const approved = await call({
      requestId: requestId(),
      op: "editorial.approve-article-batch",
      input: {
        automationUserId: automation.id,
        items: [{ id: article.id, revision: article.revision }],
      },
    });
    const { approvalId } = approved.data.results![0] as unknown as {
      approvalId: number;
    };
    const id = requestId();
    const input = { approvalId, id: article.id };
    const op = "editorial.publish-approved-article";
    const first = await call({ requestId: id, op, input });
    expect(first.data.results?.[0]).toMatchObject({
      articleId: article.articleId,
      status: "published",
      noRereadNeeded: true,
    });
    await call({
      requestId: requestId(),
      op: "article.withdraw",
      input: {
        id: article.id,
        expected: { revision: first.data.results?.[0]?.revision },
      },
    });
    const replay = await call({ requestId: id, op, input });
    expect(replay).toMatchObject({ ok: true, meta: { replayed: true } });
    expect(replay.data.already_applied).toEqual([article.id]);
    expect(replay.data.results?.[0]).toMatchObject({
      title: "Approved article",
      status: "draft",
      warnings: ["moved_since_save"],
    });
    expect(replay.untrusted).toContain("/data/results/*/title");
  });

  it("keeps the Owner's REST route as it was, with no key and a second batch on repeat", async () => {
    const draft = await seedScopedDraft();
    const login = await handleEndpoints({
      config,
      request: new Request("http://localhost/api/users/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: `execute-owner-${run}@example.invalid`,
          password,
        }),
      }),
    });
    const { token } = (await login.json()) as { token: string };
    const post = () =>
      fetch(new URL("/api/editorial/approve-batch", server.origin), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: ["JWT", token].join(" "),
        },
        body: JSON.stringify({
          automationUserId: automation.id,
          items: [{ id: draft.id, revision: draft.revision }],
        }),
      });
    const first = (await (await post()).json()) as {
      result: { approvalId: number };
    };
    const second = (await (await post()).json()) as {
      result: { approvalId: number };
    };
    expect(second.result.approvalId).not.toBe(first.result.approvalId);
  });

  it("answers an unscoped approval by name", async () => {
    const draft = await seedDraft();
    expect(
      await call({
        requestId: requestId(),
        op: "editorial.approve-batch",
        input: {
          automationUserId: automation.id,
          items: [{ id: draft.id, revision: draft.revision }],
        },
      }),
    ).toMatchObject({ ok: false, code: "APPROVAL_SCOPE_INVALID" });
    expect(
      await call({
        requestId: requestId(),
        op: "editorial.approve-batch",
        input: {
          automationUserId: aiUser.id,
          items: [{ id: draft.id, revision: draft.revision }],
        },
      }),
    ).toMatchObject({ ok: false, code: "APPROVAL_ACCOUNT_INVALID" });
  });

  it("approves an Article batch, and it replays too", async () => {
    const article = await saveArticleDraft(await reqFor(owner), {
      idempotencyKey: `${run}:article:${randomUUID()}`,
      content: {
        presentation: "news",
        title: "Synthetic article",
        summary: "Synthetic",
        section: "田野观察",
        byline: "由艺编辑室",
        sections: [{ body: "第一段。" }],
        citations: [],
      },
    });
    const id = requestId();
    const input = {
      automationUserId: automation.id,
      items: [{ id: article.id, revision: article.revision }],
    };
    const first = await call({
      requestId: id,
      op: "editorial.approve-article-batch",
      input,
    });
    expect(first).toMatchObject({ ok: true });
    const replay = await call({
      requestId: id,
      op: "editorial.approve-article-batch",
      input,
    });
    expect(replay).toMatchObject({ ok: true, meta: { replayed: true } });
    expect(replay.data.results?.[0]).toMatchObject({
      approvalId: (first.data.results?.[0] as { approvalId?: number })
        .approvalId,
    });
  });
});

describe("a restore under an AI key", () => {
  it("restores once, and the same requestId replays instead of conflicting", async () => {
    const draft = await seedDraft({ title: "First title" });
    const edited = await call({
      requestId: requestId(),
      op: "editorial.save-draft",
      input: editOf(draft, { title: "Second title" }),
    });
    const revision = Number(edited.data.results?.[0]?.revision);
    const { docs } = await payload.findVersions({
      collection: "catalogs",
      where: { parent: { equals: draft.id } },
      sort: "createdAt",
      limit: 1,
      depth: 0,
      overrideAccess: true,
    });
    const input = { versionId: docs[0]!.id, expectedRevision: revision };
    const id = requestId();
    const unknown = await withStatusReadLost(() =>
      call({ requestId: id, op: "editorial.restore-draft", input }),
    );
    expect(unknown.code).toBe("OUTCOME_UNKNOWN");
    expect((await draftOf(draft.id)).title).toBe("First title");
    const replay = await follow(unknown.next);
    expect(replay).toMatchObject({ ok: true, meta: { replayed: true } });
    expect(replay.data.already_applied).toEqual([docs[0]!.id]);
    expect((await draftOf(draft.id)).revision).toBe(revision + 1);
  });
});

describe("an Article save", () => {
  it("echoes the Article it wrote, and replays", async () => {
    const saved = await saveArticleDraft(await reqFor(owner), {
      idempotencyKey: `${run}:article:${randomUUID()}`,
      content: {
        presentation: "news",
        title: "Before",
        summary: "Synthetic",
        section: "田野观察",
        byline: "由艺编辑室",
        sections: [{ body: "第一段。" }],
        citations: [],
      },
    });
    const id = requestId();
    const input = {
      id: saved.id,
      expectedRevision: saved.revision,
      content: { title: "题名已改" },
    };
    const answer = await call({
      requestId: id,
      op: "editorial.save-article-draft",
      input,
    });
    expect(answer).toMatchObject({ ok: true });
    expect(answer.data.results?.[0]).toMatchObject({
      id: saved.id,
      articleId: saved.articleId,
      title: "题名已改",
      revision: saved.revision + 1,
      changedFields: ["title"],
      noRereadNeeded: true,
    });
    expect(answer.untrusted).toContain("/data/results/*/articleId");
    const replay = await call({
      requestId: id,
      op: "editorial.save-article-draft",
      input,
    });
    expect(replay).toMatchObject({ ok: true, meta: { replayed: true } });
    expect(replay.data.already_applied).toEqual([saved.id]);
  });

  const seedWithRows = async () =>
    saveArticleDraft(await reqFor(owner), {
      idempotencyKey: `${run}:article:${randomUUID()}`,
      content: {
        presentation: "news",
        title: "Before",
        summary: "Synthetic",
        section: "田野观察",
        byline: "由艺编辑室",
        sections: [{ body: "第一段原文。" }, { body: "第二段原文。" }],
        citations: [{ text: "原引用一" }, { text: "原引用二" }],
      },
    });
  const storedArticle = (id: number) =>
    payload.findByID({ collection: "articles", id, draft: true, depth: 0 });

  it("refuses a value of the wrong kind and what the server sets, before any effect", async () => {
    const saved = await seedWithRows();
    const before = await storedArticle(saved.id);
    for (const content of [
      { sections: "第二段全文" },
      { sections: 3 },
      { sections: { body: "x" } },
      { sections: ["第二段全文"] },
      { sections: null },
      { citations: "见《金石录》" },
      { citations: ["见《金石录》"] },
      { citations: null },
      { citations: [{ text: "x", link: "https://example.invalid/" }] },
      { citations: [{ id: "synthetic-row", text: "x" }] },
      { sections: [{ id: "synthetic-row", body: "x" }] },
      { title: { a: 1 } },
      { titel: "错字段" },
      { firstPublishedAt: "2000-01-01T00:00:00.000Z" },
      { publishedAt: "2000-01-01T00:00:00.000Z" },
      { _status: "published" },
      { articleId: "synthetic-other" },
      { revision: 9 },
    ]) {
      const answer = await call({
        requestId: requestId(),
        op: "editorial.save-article-draft",
        input: {
          id: saved.id,
          expectedRevision: saved.revision,
          content,
        },
      });
      expect(answer, JSON.stringify(content)).toMatchObject({
        ok: false,
        code: "INPUT_INVALID",
      });
    }
    const after = await storedArticle(saved.id);
    expect(after.revision).toBe(before.revision);
    expect(after.sections).toEqual(before.sections);
    expect(after.citations).toEqual(before.citations);
    expect(after.firstPublishedAt ?? null).toBeNull();
  });

  it("takes rows as they read, and allowRemoving as its input says", async () => {
    const saved = await seedWithRows();
    const read = await client.callTool({
      name: "admin_get",
      arguments: { type: "article", id: saved.id, view: "full" },
    });
    const rowsOfField = (name: string) =>
      (
        read.structuredContent as {
          data: { fields: { name: string; value?: unknown }[] };
        }
      ).data.fields.find((field) => field.name === name)!.value;
    const sections = rowsOfField("sections");
    const citations = rowsOfField("citations");
    expect(sections).toEqual([
      { body: "第一段原文。" },
      { body: "第二段原文。" },
    ]);
    expect(citations).toEqual([{ text: "原引用一" }, { text: "原引用二" }]);
    const answer = await call({
      requestId: requestId(),
      op: "editorial.save-article-draft",
      input: {
        id: saved.id,
        expectedRevision: saved.revision,
        content: { sections, citations, subtitle: null },
      },
    });
    expect(answer).toMatchObject({ ok: true });
    let revision = Number(answer.data.results?.[0]?.revision);
    for (const allowRemoving of [true, false]) {
      const flagged = await call({
        requestId: requestId(),
        op: "editorial.save-article-draft",
        input: {
          id: saved.id,
          expectedRevision: revision,
          allowRemoving,
          content: { title: `Flag ${allowRemoving}` },
        },
      });
      expect(flagged).toMatchObject({ ok: true });
      revision = Number(flagged.data.results?.[0]?.revision);
    }
    expect((await storedArticle(saved.id)).title).toBe("Flag false");
  });
});

describe("accepted never reads as done", () => {
  // With a Backend, QUEUED and its way on: tests/cms/admin-mcp-editorial-ops.test.ts.
  it("names a prepare no Backend can ever render, on the first call and on a replay", async () => {
    const draft = await seedDraftWithMedia();
    const id = requestId();
    const input = {
      id: draft.id,
      expectedRevision: draft.revision,
      expectedFingerprint: draft.fingerprint,
    };
    const prepared = await call({
      requestId: id,
      op: "editorial.prepare-catalog-delivery",
      input,
    });
    expect(prepared).toMatchObject({
      ok: false,
      code: "CATALOG_DELIVERY_NOT_CONFIGURED",
    });
    expect(prepared.next).toBeUndefined();
    expect(prepared.data.queued).toBeUndefined();
    const { intentId } = prepared.data.results![0]! as unknown as {
      intentId: string;
    };
    const replay = await call({
      requestId: id,
      op: "editorial.prepare-catalog-delivery",
      input,
    });
    expect(replay).toMatchObject({
      ok: false,
      code: "CATALOG_DELIVERY_NOT_CONFIGURED",
      meta: { replayed: true },
    });
    expect(replay.data.results?.[0]).toMatchObject({ intentId });

    const read = await client.callTool({
      name: "admin_read",
      arguments: {
        op: "editorial.read-catalog-delivery",
        input: { intentId },
      },
    });
    expect(read.structuredContent).toMatchObject({
      ok: true,
      data: { intentId, state: "prepared", readiness: "NOT_CONFIGURED" },
    });
  });

  it("says an expired intent expired on a read, with no write, and a command then records it", async () => {
    const draft = await seedDraftWithMedia();
    const prepared = await call({
      requestId: requestId(),
      op: "editorial.prepare-catalog-delivery",
      input: {
        id: draft.id,
        expectedRevision: draft.revision,
        expectedFingerprint: draft.fingerprint,
      },
    });
    const { intentId, stateVersion } = prepared.data
      .results![0]! as unknown as { intentId: string; stateVersion: number };
    await rowsOf(sql`
      UPDATE catalog_delivery_intents SET expires_at = now() - interval '1 minute'
      WHERE id = ${intentId}::uuid`);
    const stored = () =>
      rowsOf(sql`
        SELECT state, state_version::int AS version
        FROM catalog_delivery_intents WHERE id = ${intentId}::uuid`);
    const read = await readClient.callTool({
      name: "admin_read",
      arguments: {
        op: "editorial.read-catalog-delivery",
        input: { intentId },
      },
    });
    expect(read.structuredContent).toMatchObject({
      ok: true,
      data: { intentId, state: "expired", publicCopyAuthorized: false },
    });
    expect(await stored()).toEqual([
      { state: "prepared", version: stateVersion },
    ]);
    expect(
      await call({
        requestId: requestId(),
        op: "editorial.cancel-catalog-delivery",
        input: { intentId, expectedStateVersion: stateVersion },
      }),
    ).toMatchObject({ ok: false, code: "CATALOG_DELIVERY_EXPIRED" });
    expect(await stored()).toEqual([
      { state: "expired", version: stateVersion + 1 },
    ]);
  });

  it("refuses a release that was never requested, and publishes nothing", async () => {
    const draft = await seedDraftWithMedia();
    const prepared = await call({
      requestId: requestId(),
      op: "editorial.prepare-catalog-delivery",
      input: {
        id: draft.id,
        expectedRevision: draft.revision,
        expectedFingerprint: draft.fingerprint,
      },
    });
    const { intentId, stateVersion } = prepared.data
      .results![0]! as unknown as { intentId: string; stateVersion: number };
    const release = await call({
      requestId: requestId(),
      op: "editorial.release-catalog-delivery",
      input: {
        intentId,
        expectedStateVersion: stateVersion,
        expectedRevision: draft.revision,
        expectedFingerprint: draft.fingerprint,
      },
    });
    expect(release.ok).toBe(false);
    expect((await draftOf(draft.id))._status).toBe("draft");
  });

  it("refuses a publish whose images are not ready, with the direct switch on or off", async () => {
    const draft = await seedDraftWithMedia();
    scoped.push(draft.catalogId);
    await payload.update({
      collection: "users",
      id: automation.id,
      overrideAccess: true,
      data: { scopeCatalogIds: scoped } as never,
    });
    const { approvalId } = await approveBatch(await reqFor(owner), {
      automationUserId: automation.id,
      items: [{ id: draft.id, revision: draft.revision }],
    });
    const input = { approvalId, id: draft.id };
    const off = await call({
      requestId: requestId(),
      op: "editorial.publish-approved",
      input,
    });
    expect(off).toMatchObject({
      ok: false,
      code: "CATALOG_DELIVERY_PREPARATION_REQUIRED",
    });
    vi.stubEnv("CMS_CATALOG_DIRECT_PUBLISH", "on");
    try {
      const on = await call({
        requestId: requestId(),
        op: "editorial.publish-approved",
        input,
      });
      expect(on).toMatchObject({
        ok: false,
        code: "CATALOG_DELIVERY_PREPARATION_REQUIRED",
      });
    } finally {
      vi.stubEnv("CMS_CATALOG_DIRECT_PUBLISH", "");
    }
    expect((await draftOf(draft.id))._status).toBe("draft");
  });
});
