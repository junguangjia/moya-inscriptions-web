import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  handleOperatorRequest,
  type OperatorRouteDependencies,
} from "@moya/backend-runtime/internal/community-operator";
import { currentCatalogRecipePolicy } from "@moya/backend-production/internal/catalog-delivery";
import {
  ADMIN_MCP_TEXT_CAP_BYTES,
  adminMcpEnvelopeSchema,
  type AdminExecuteData,
  type AdminMcpEnvelope,
} from "@moya/contracts/internal/admin-mcp";
import { sql, type PostgresAdapter } from "@payloadcms/db-postgres";
import {
  createLocalReq,
  getPayload,
  type Payload,
  type SanitizedConfig,
  type TypedUser,
} from "payload";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  approveBatch,
  publishApproved,
  restoreDraft,
  saveDraft,
} from "admin/editorial";
import { saveArticleDraft } from "admin/editorial-content";
import { selectedMediaSnapshot } from "admin/media-snapshot";

import {
  connectClient,
  serveRoutes,
  syntheticCatalogDraft,
} from "./admin-mcp-wire.js";

// The CMS ops of admin_execute (admin-mcp-completion-v1 section 10), driven as real
// JSON-RPC over a real socket with the official client. Matrix rows: "Fix one
// character in a long transcription", "Publish record with no new images", "Publish
// record with new images, direct switch on or off", "Prepare, request-release",
// "Release delivery", "Catalog withdraw", "Create or approve an approval batch under
// an AI key", "Document open by the Owner", "Save that binds a new identity". Every
// test seeds its own rows, so it passes alone on an empty database and on a used one.

if (process.env.CMS_ENVIRONMENT !== "synthetic")
  throw new Error("SYNTHETIC_CMS_TARGET_REQUIRED");

const run = randomUUID();
const password = randomBytes(24).toString("hex");

let config: SanitizedConfig;
let payload: Payload;
let server: Awaited<ReturnType<typeof serveRoutes>>;
let owner: TypedUser;
let automation: TypedUser;
let aiUser: TypedUser;
let client: Client;
let ownerRestKey: string;
let automationRestKey: string;
const scoped: string[] = [];

type Answer = AdminMcpEnvelope & { data: AdminExecuteData };
type ResultRow = Record<string, unknown> & { index: number };

const adapter = () => payload.db as unknown as PostgresAdapter;
const rowsOf = async (query: ReturnType<typeof sql>) =>
  (await adapter().drizzle.execute(query)).rows;
const reqFor = (user: TypedUser) => createLocalReq({ user }, payload);
const requestId = () => randomUUID();
const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

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

const execute = (op: string, input: Record<string, unknown>) =>
  call({ requestId: requestId(), op, input });

const resultOf = (answer: Answer) =>
  answer.data.results?.[0] as ResultRow | undefined;

const get = async (args: Record<string, unknown>) => {
  const result = await client.callTool({ name: "admin_get", arguments: args });
  return (result.structuredContent as { data: Record<string, unknown> }).data;
};

let seeded = 0;
const seedDraft = async (fields: Record<string, unknown> = {}) => {
  seeded += 1;
  const catalogId = `ops-${seeded}-${run}`;
  const sourceId = `ops-source-${seeded}-${run}`;
  const saved = await saveDraft(await reqFor(owner), {
    idempotencyKey: `${run}:seed:${seeded}`,
    content: { ...syntheticCatalogDraft(catalogId, sourceId), ...fields },
  });
  return {
    ...saved,
    catalogId,
    sourceId,
    expected: { revision: saved.revision, fingerprint: saved.fingerprint },
  };
};

const seedMediaRow = async (catalogId: string, mediaId: string) => {
  const bytes = await sharp({
    create: { width: 3, height: 2, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  return payload.create({
    collection: "media",
    req: await reqFor(owner),
    overrideAccess: false,
    data: {
      mediaId,
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
};

const seedDraftWithMedia = async () => {
  seeded += 1;
  const catalogId = `ops-${seeded}-${run}`;
  const sourceId = `ops-source-${seeded}-${run}`;
  const media = await seedMediaRow(catalogId, `ops-media-${seeded}-${run}`);
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
    expected: { revision: saved.revision, fingerprint: saved.fingerprint },
  };
};

const seedArticle = (fields: Record<string, unknown> = {}) =>
  saveArticleDraft(reqForArticle, {
    idempotencyKey: `${run}:article:${randomUUID()}`,
    content: {
      presentation: "news",
      title: "Synthetic article",
      summary: "Synthetic",
      section: "田野观察",
      byline: "由艺编辑室",
      sections: [{ body: "第一段。" }],
      citations: [],
      ...fields,
    },
  });
let reqForArticle: Awaited<ReturnType<typeof reqFor>>;

const seedCollection = async (fields: Record<string, unknown> = {}) => {
  const created = await payload.create({
    collection: "article-collections",
    req: await reqFor(owner),
    overrideAccess: false,
    draft: true,
    data: { title: "Synthetic collection", ...fields } as never,
  });
  return created as unknown as { id: number; revision: number };
};

const draftOf = (id: number) =>
  payload.findByID({ collection: "catalogs", id, draft: true, depth: 0 });
const liveOf = (id: number) =>
  payload.findByID({ collection: "catalogs", id, draft: false, depth: 0 });
const inPublicReads = async (catalogId: string) =>
  (
    await rowsOf(
      sql`SELECT 1 FROM catalog_entries WHERE catalog_id = ${catalogId}`,
    )
  ).length === 1;

const lockFor = async (slug: "catalogs" | "media", id: number) =>
  payload.create({
    collection: "payload-locked-documents",
    overrideAccess: true,
    data: {
      document: { relationTo: slug, value: id },
      user: { relationTo: "users", value: owner.id },
    } as never,
  });
const unlock = (id: number) =>
  payload.delete({
    collection: "payload-locked-documents",
    id,
    overrideAccess: true,
  });

const withCommitFailureOn = async <T>(
  table: string,
  work: () => Promise<T>,
  sqlState = "P0001",
): Promise<T> => {
  const db = adapter().drizzle;
  await db.execute(
    sql.raw(`
    CREATE OR REPLACE FUNCTION ops_refuse_commit() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic commit failure' USING ERRCODE = '${sqlState}'; END $$`),
  );
  await db.execute(
    sql.raw(`
    CREATE CONSTRAINT TRIGGER ops_refuse_commit
    AFTER INSERT OR UPDATE ON ${table}
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION ops_refuse_commit()`),
  );
  try {
    return await work();
  } finally {
    await db.execute(sql.raw(`DROP TRIGGER ops_refuse_commit ON ${table}`));
    await db.execute(sql`DROP FUNCTION ops_refuse_commit()`);
  }
};
const withCommitFailure = <T>(work: () => Promise<T>) =>
  withCommitFailureOn("editorial_receipts", work);

/** A Backend that says what the test tells it to, through the real operator route. */
const withOperator = async <T>(
  routes: Partial<OperatorRouteDependencies>,
  work: () => Promise<T>,
): Promise<T> => {
  const credential = randomUUID();
  const operator = createServer((request, response) => {
    void handleOperatorRequest(
      request,
      response,
      new URL(request.url!, "http://127.0.0.1").pathname,
      {
        moderationService: {},
        operatorCredential: credential,
        catalogRecipePolicy: async () => currentCatalogRecipePolicy(),
        ...routes,
      } as OperatorRouteDependencies,
    );
  });
  await new Promise<void>((resolve) =>
    operator.listen(0, "127.0.0.1", resolve),
  );
  vi.stubEnv(
    "COMMUNITY_OPERATOR_BASE_URL",
    `http://127.0.0.1:${(operator.address() as AddressInfo).port}`,
  );
  vi.stubEnv("COMMUNITY_OPERATOR_TOKEN", credential);
  try {
    return await work();
  } finally {
    vi.stubEnv("COMMUNITY_OPERATOR_BASE_URL", "");
    vi.stubEnv("COMMUNITY_OPERATOR_TOKEN", "");
    operator.closeAllConnections();
    await new Promise((resolve) => operator.close(resolve));
  }
};

const renditionsAnswering =
  (
    complete: boolean,
  ): NonNullable<OperatorRouteDependencies["catalogPublishedRenditions"]> =>
  async (media) => ({
    media: media.map(({ mediaId, objectKey }) => ({
      mediaId,
      objectKey,
      complete,
    })),
  });

/** The Backend's two answers about images, by whether the worker has rendered them. */
const proofRoutes = (state: { ready: boolean }) => ({
  catalogPublishedRenditions: renditionsAnswering(false),
  catalogDeliveryReadiness: async (intentId: string) => {
    const [row] = (await rowsOf(sql`
      SELECT media_manifest_sha256, recipe_manifest_sha256, state_version,
        jsonb_array_length(media_manifest) AS media_count
      FROM catalog_delivery_intents WHERE id = ${intentId}::uuid`)) as {
      media_manifest_sha256: string;
      recipe_manifest_sha256: string;
      state_version: number;
      media_count: number;
    }[];
    return {
      intentId,
      manifestSha256: row!.media_manifest_sha256,
      recipeManifestSha256: row!.recipe_manifest_sha256,
      stateVersion: row!.state_version,
      mediaCount: row!.media_count,
      privateReady: state.ready,
      publicReady: state.ready,
      proofSha256: "b".repeat(64),
    };
  },
});

const released = async (
  draft: Awaited<ReturnType<typeof seedDraftWithMedia>>,
) => {
  const state = { ready: false };
  return withOperator(proofRoutes(state), async () => {
    const prepared = await execute("editorial.prepare-catalog-delivery", {
      id: draft.id,
      expectedRevision: draft.revision,
      expectedFingerprint: draft.fingerprint,
    });
    const intent = resultOf(prepared) as unknown as {
      intentId: string;
      stateVersion: number;
      manifestSha256: string;
    };
    const requested = await execute("editorial.request-catalog-release", {
      intentId: intent.intentId,
      expectedStateVersion: intent.stateVersion,
      expectedManifestSha256: intent.manifestSha256,
    });
    const { stateVersion } = resultOf(requested) as unknown as {
      stateVersion: number;
    };
    state.ready = true;
    const release = await execute("editorial.release-catalog-delivery", {
      intentId: intent.intentId,
      expectedStateVersion: stateVersion,
      expectedRevision: draft.revision,
      expectedFingerprint: draft.fingerprint,
    });
    expect(release).toMatchObject({ ok: true });
    const latest = await draftOf(draft.id);
    return {
      id: draft.id,
      catalogId: draft.catalogId,
      expected: {
        revision: latest.revision,
        fingerprint: resultOf(release)?.fingerprint as string,
      },
    };
  });
};

beforeAll(async () => {
  vi.stubEnv("COMMUNITY_OPERATOR_BASE_URL", "");
  vi.stubEnv("COMMUNITY_OPERATOR_TOKEN", "");
  config = await (await import("admin/config")).default;
  payload = await getPayload({ config });
  const account = (
    name: string,
    role: "owner" | "automation" | "ai_operator",
    extra: Record<string, unknown> = {},
  ) =>
    payload.create({
      collection: "users",
      overrideAccess: true,
      data: {
        email: `ops-${name}-${run}@example.invalid`,
        password,
        role,
        scopeCatalogIds: [],
        ...extra,
      } as never,
    });
  ownerRestKey = randomBytes(32).toString("hex");
  automationRestKey = randomBytes(32).toString("hex");
  owner = await account("owner", "owner", {
    enableAPIKey: true,
    apiKey: ownerRestKey,
  });
  automation = await account("automation", "automation", {
    enableAPIKey: true,
    apiKey: automationRestKey,
  });
  aiUser = await account("ai", "ai_operator");
  reqForArticle = await reqFor(owner);
  const secret = randomBytes(32).toString("hex");
  await payload.create({
    collection: "payload-mcp-api-keys",
    overrideAccess: true,
    data: {
      user: aiUser.id,
      label: "synthetic-ops-operate",
      enableAPIKey: true,
      apiKey: secret,
      toolProfile: "operate",
    } as never,
  });
  server = await serveRoutes(config);
  client = (
    await connectClient(server.endpoint, {
      authorization: ["Bearer", secret].join(" "),
    })
  ).client;
}, 60_000);

afterAll(async () => {
  await client?.close();
  await server?.close();
  await payload?.destroy();
  vi.unstubAllEnvs();
});

describe("catalog.patch_text", () => {
  const LONG = `${"碑文第一行，".repeat(400)}發願文𠮷字有誤。${"碑文末行。".repeat(400)}`;
  const patchOf = (
    draft: Awaited<ReturnType<typeof seedDraft>>,
    edits: readonly Record<string, unknown>[],
    field = "transcription",
  ) => ({
    catalogId: draft.id,
    field,
    edits,
    expected: draft.expected,
  });

  it("fixes one character in a long text with no retyping, and touches nothing else", async () => {
    const draft = await seedDraft({
      title: "Stays as it was",
      transcription: { state: "VALUE", value: LONG },
      description: { state: "VALUE", value: "Stays too" },
    });
    const id = requestId();
    const input = patchOf(draft, [{ oldText: "字有誤", newText: "字無誤" }]);
    const answer = await call({
      requestId: id,
      op: "catalog.patch_text",
      input,
    });
    expect(answer).toMatchObject({ ok: true, code: "OK" });
    expect(answer.data.applied).toEqual([draft.id]);
    const after = LONG.replace("字有誤", "字無誤");
    const points = Array.from(after);
    const offset = Array.from(LONG.slice(0, LONG.indexOf("字有誤"))).length;
    expect(resultOf(answer)).toMatchObject({
      id: draft.id,
      catalogId: draft.catalogId,
      title: "Stays as it was",
      revision: draft.revision + 1,
      field: "transcription",
      oldHash: sha256(LONG),
      newHash: sha256(after),
      newTotalLength: Array.from(after).length,
      changedFields: ["transcription"],
      noRereadNeeded: true,
    });
    expect(
      (resultOf(answer)!.ranges as Record<string, unknown>[])[0],
    ).toMatchObject({
      offset,
      oldLength: 3,
      newLength: 3,
      // A supplementary character counts as one, as a read's windows count it.
      before: points.slice(offset - 20, offset).join(""),
      after: points.slice(offset + 3, offset + 23).join(""),
    });
    expect(answer.untrusted).toEqual(
      expect.arrayContaining([
        "/data/results/*/ranges/*/before",
        "/data/results/*/ranges/*/after",
        "/data/results/*/title",
      ]),
    );
    const stored = await draftOf(draft.id);
    expect(stored.transcription?.value).toBe(after);
    expect(stored.title).toBe("Stays as it was");
    expect(stored.description?.value).toBe("Stays too");
    const outline = await get({ type: "catalog", id: draft.id });
    expect(
      (outline.fields as { name: string; hash?: string }[]).find(
        ({ name }) => name === "transcription",
      )?.hash,
    ).toBe(resultOf(answer)!.newHash);

    const replay = await call({
      requestId: id,
      op: "catalog.patch_text",
      input,
    });
    expect(replay).toMatchObject({ ok: true, meta: { replayed: true } });
    expect(replay.data.already_applied).toEqual([draft.id]);
    expect(resultOf(replay)).not.toHaveProperty("oldHash");
    expect((await draftOf(draft.id)).revision).toBe(draft.revision + 1);
    expect(
      await call({
        requestId: id,
        op: "catalog.patch_text",
        input: patchOf(draft, [{ oldText: "碑文", newText: "x" }]),
      }),
    ).toMatchObject({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
  });

  it("applies several edits against the text as it was, in any order", async () => {
    const draft = await seedDraft({
      transcription: { state: "VALUE", value: "甲一乙二丙三" },
    });
    const answer = await execute(
      "catalog.patch_text",
      patchOf(draft, [
        { oldText: "丙", newText: "丁丁" },
        { oldText: "甲", newText: "乙" },
      ]),
    );
    expect(answer.ok).toBe(true);
    expect((await draftOf(draft.id)).transcription?.value).toBe(
      "乙一乙二丁丁三",
    );
    expect(resultOf(answer)!.ranges).toMatchObject([
      { offset: 0, oldLength: 1, newLength: 1 },
      { offset: 4, oldLength: 1, newLength: 2 },
    ]);
  });

  it.each<[string, Record<string, unknown>[], string, string[]]>([
    [
      "one edit of two matches nothing",
      [
        { oldText: "甲", newText: "改" },
        { oldText: "CANARY-NOT-THERE", newText: "改" },
      ],
      "PATCH_NO_MATCH",
      ["edits.1"],
    ],
    [
      "one edit of two matches twice",
      [
        { oldText: "甲", newText: "改" },
        { oldText: "重", newText: "改" },
      ],
      "PATCH_MULTIPLE_MATCHES",
      ["edits.1"],
    ],
    [
      "an occurrence past the last one",
      [{ oldText: "重", newText: "改", occurrence: 3 }],
      "PATCH_NO_MATCH",
      ["edits.0"],
    ],
    [
      "two edits on the same text",
      [
        { oldText: "甲重", newText: "改" },
        { oldText: "重乙", newText: "改" },
      ],
      "PATCH_OVERLAP",
      ["edits.0", "edits.1"],
    ],
    [
      "overlapping occurrences of one string",
      [{ oldText: "aa", newText: "b" }],
      "PATCH_MULTIPLE_MATCHES",
      ["edits.0"],
    ],
  ])(
    "fails the whole patch when %s, and changes nothing",
    async (_label, edits, code, fields) => {
      const draft = await seedDraft({
        transcription: { state: "VALUE", value: "甲重乙重aaa" },
      });
      const answer = await execute("catalog.patch_text", patchOf(draft, edits));
      expect(answer).toMatchObject({ ok: false, code });
      expect(answer.data.failed).toMatchObject([{ index: 0, code, fields }]);
      expect(JSON.stringify(answer)).not.toContain("CANARY");
      expect(answer).not.toHaveProperty("next");
      const stored = await draftOf(draft.id);
      expect(stored.revision).toBe(draft.revision);
      expect(stored.transcription?.value).toBe("甲重乙重aaa");
    },
  );

  it("stays under the text cap at the most edits it takes, and every range says where", async () => {
    const value = Array.from(
      { length: 50 },
      (_, index) => `${"𠮷".repeat(30)}标${index}记`,
    ).join("");
    const draft = await seedDraft({
      transcription: { state: "VALUE", value },
    });
    const answer = await execute(
      "catalog.patch_text",
      patchOf(
        draft,
        Array.from({ length: 50 }, (_, index) => ({
          oldText: `标${index}记`,
          newText: `改${index}`,
        })),
      ),
    );
    expect(answer).toMatchObject({ ok: true });
    expect(answer.meta.truncated).toBeUndefined();
    const ranges = resultOf(answer)!.ranges as Record<string, unknown>[];
    expect(ranges).toHaveLength(50);
    expect(ranges.filter(({ before }) => before !== undefined)).toHaveLength(
      20,
    );
  });

  it("takes the one place an occurrence names", async () => {
    const draft = await seedDraft({
      transcription: { state: "VALUE", value: "甲重乙重丙" },
    });
    const answer = await execute(
      "catalog.patch_text",
      patchOf(draft, [{ oldText: "重", newText: "改", occurrence: 2 }]),
    );
    expect(answer.ok).toBe(true);
    expect((await draftOf(draft.id)).transcription?.value).toBe("甲重乙改丙");
  });

  it("matches raw only: no simplified form, and no other normalization", async () => {
    const composed = "\u00e9";
    const decomposed = "e\u0301";
    const draft = await seedDraft({
      transcription: { state: "VALUE", value: `發願${composed}` },
    });
    for (const oldText of ["发愿", decomposed, "發願 "]) {
      const answer = await execute(
        "catalog.patch_text",
        patchOf(draft, [{ oldText, newText: "改" }]),
      );
      expect(answer, oldText).toMatchObject({
        ok: false,
        code: "PATCH_NO_MATCH",
      });
    }
    expect((await draftOf(draft.id)).revision).toBe(draft.revision);
  });

  it("refuses a revision that moved, and a fingerprint that does not match", async () => {
    const draft = await seedDraft({
      transcription: { state: "VALUE", value: "甲乙丙" },
    });
    const stale = await execute("catalog.patch_text", {
      ...patchOf(draft, [{ oldText: "甲", newText: "改" }]),
      expected: { ...draft.expected, revision: draft.revision + 1 },
    });
    expect(stale).toMatchObject({ ok: false, code: "REVISION_CONFLICT" });
    expect(stale.data.conflict).toMatchObject([{ id: draft.id }]);
    const wrong = await execute("catalog.patch_text", {
      ...patchOf(draft, [{ oldText: "甲", newText: "改" }]),
      expected: { ...draft.expected, fingerprint: "c".repeat(64) },
    });
    expect(wrong).toMatchObject({ ok: false, code: "REVISION_CONFLICT" });
    expect((await draftOf(draft.id)).revision).toBe(draft.revision);
  });

  it("still runs validation: a result the field cannot hold is refused, by field", async () => {
    const draft = await seedDraft({ title: "Title" });
    const answer = await execute(
      "catalog.patch_text",
      patchOf(draft, [{ oldText: "Title", newText: "Title " }], "title"),
    );
    expect(answer).toMatchObject({ ok: false, code: "CONTENT_INVALID" });
    expect(answer.data.failed).toMatchObject([{ fields: ["title"] }]);
    expect((await draftOf(draft.id)).title).toBe("Title");
  });

  it.each<[string, () => Record<string, unknown>]>([
    [
      "a field with no text to patch",
      () => ({ field: "catalogId", edits: [{ oldText: "a", newText: "b" }] }),
    ],
    ["no edits", () => ({ edits: [] })],
    ["an empty oldText", () => ({ edits: [{ oldText: "", newText: "b" }] })],
    [
      "an edit that changes nothing",
      () => ({ edits: [{ oldText: "a", newText: "a" }] }),
    ],
    [
      "half a character",
      () => ({ edits: [{ oldText: "\ud842", newText: "b" }] }),
    ],
    [
      "more text than an edit takes",
      () => ({ edits: [{ oldText: "a", newText: "x".repeat(100_001) }] }),
    ],
    [
      "a fingerprint that is no fingerprint",
      () => ({ expected: { revision: 1, fingerprint: "x" } }),
    ],
    ["no fingerprint", () => ({ expected: { revision: 1 } })],
    ["an unknown key", () => ({ extra: 1 })],
  ])(
    "answers INPUT_INVALID to %s, and echoes nothing",
    async (_label, change) => {
      const draft = await seedDraft();
      const answer = await execute("catalog.patch_text", {
        ...patchOf(draft, [{ oldText: "合", newText: "和" }]),
        ...change(),
      });
      expect(answer).toMatchObject({ ok: false, code: "INPUT_INVALID" });
      expect((await draftOf(draft.id)).revision).toBe(draft.revision);
    },
  );

  it.each([
    ["an id no column can hold", 3_000_000_000],
    ["no such identity", `ops-missing-${run}`],
    ["the largest id a request can hold", 2 ** 53 - 1],
  ])("answers NOT_FOUND to %s", async (_label, catalogId) => {
    const answer = await execute("catalog.patch_text", {
      catalogId,
      field: "transcription",
      edits: [{ oldText: "a", newText: "b" }],
      expected: { revision: 1, fingerprint: "c".repeat(64) },
    });
    expect(answer).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("answers DOCUMENT_LOCKED with the lock block when named by public identity, and the same requestId works after", async () => {
    const draft = await seedDraft();
    const lock = await lockFor("catalogs", draft.id);
    const id = requestId();
    const input = {
      ...patchOf(draft, [{ oldText: "合", newText: "和" }]),
      catalogId: draft.catalogId,
    };
    const locked = await call({
      requestId: id,
      op: "catalog.patch_text",
      input,
    });
    expect(locked).toMatchObject({ ok: false, code: "DOCUMENT_LOCKED" });
    expect(locked.data.conflict).toMatchObject([
      { id: draft.id, lock: { held: true, by: "owner" } },
    ]);
    expect(locked.next?.afterMs).toBeGreaterThan(0);
    await unlock(lock.id);
    expect(
      await call({ requestId: id, op: "catalog.patch_text", input }),
    ).toMatchObject({ ok: true });
  });

  it("offers a skeleton from admin_get that works once edits are filled in", async () => {
    const draft = await seedDraft();
    const { actions } = await get({ type: "catalog", id: draft.id });
    const skeleton = (
      actions as { args: { op?: string; input?: object } }[]
    ).find(({ args }) => args.op === "catalog.patch_text")!;
    const answer = await execute("catalog.patch_text", {
      ...skeleton.args.input,
      edits: [{ oldText: "合", newText: "和" }],
    });
    expect(answer.ok).toBe(true);
  });

  it("answers OUTCOME_UNKNOWN to a failed COMMIT, keeps nothing, and the same requestId applies once", async () => {
    const draft = await seedDraft();
    const id = requestId();
    const input = patchOf(draft, [{ oldText: "合", newText: "和" }]);
    const failed = await withCommitFailure(() =>
      call({ requestId: id, op: "catalog.patch_text", input }),
    );
    expect(failed).toMatchObject({ ok: false, code: "OUTCOME_UNKNOWN" });
    expect((await draftOf(draft.id)).revision).toBe(draft.revision);
    const after = await call({
      requestId: id,
      op: "catalog.patch_text",
      input,
    });
    expect(after).toMatchObject({ ok: true });
    expect((await draftOf(draft.id)).revision).toBe(draft.revision + 1);
  });
});

describe("catalog.publish", () => {
  it("publishes a record with no images, and a repeat changes nothing", async () => {
    const draft = await seedDraft();
    const id = requestId();
    const input = { id: draft.id, expected: draft.expected };
    const answer = await call({ requestId: id, op: "catalog.publish", input });
    expect(answer).toMatchObject({ ok: true, code: "OK" });
    expect(answer.data.applied).toEqual([draft.id]);
    expect(resultOf(answer)).toMatchObject({
      id: draft.id,
      catalogId: draft.catalogId,
      status: "published",
      revision: draft.revision + 1,
      fingerprint: draft.fingerprint,
    });
    expect((await liveOf(draft.id))._status).toBe("published");
    expect(await inPublicReads(draft.catalogId)).toBe(true);

    const replay = await call({ requestId: id, op: "catalog.publish", input });
    expect(replay).toMatchObject({ ok: true, meta: { replayed: true } });
    expect(resultOf(replay)).toMatchObject({ status: "published" });
    const receipts = await client.callTool({
      name: "admin_read",
      arguments: {
        op: "list.receipts",
        input: { filter: { operation: "publish-direct" } },
      },
    });
    expect(receipts.structuredContent).toMatchObject({ ok: true });
    const anotherKey = await execute("catalog.publish", input);
    expect(anotherKey).toMatchObject({ ok: true });
    expect(anotherKey.data.already_applied).toEqual([draft.id]);
    expect((await draftOf(draft.id)).revision).toBe(draft.revision + 1);
    const { totalDocs } = await payload.find({
      collection: "editorial-receipts",
      where: {
        and: [
          { catalog: { equals: draft.id } },
          { operation: { equals: "publish-direct" } },
        ],
      },
      limit: 0,
    });
    expect(totalDocs).toBe(1);
  });

  it("refuses a stale revision, a record missing a required field, and an Owner's open document", async () => {
    const stale = await seedDraft();
    const edited = await execute("editorial.save-draft", {
      id: stale.id,
      expectedRevision: stale.revision,
      content: {
        catalogId: stale.catalogId,
        sourceId: stale.sourceId,
        kind: "calligraphy",
        title: "Moved on",
      },
    });
    expect(edited.ok).toBe(true);
    expect(
      await execute("catalog.publish", {
        id: stale.id,
        expected: stale.expected,
      }),
    ).toMatchObject({ ok: false, code: "REVISION_CONFLICT" });
    expect((await liveOf(stale.id))._status).toBe("draft");

    const bare = await saveDraft(await reqFor(owner), {
      idempotencyKey: `${run}:bare:${randomUUID()}`,
      content: {
        catalogId: `ops-bare-${run}`,
        sourceId: `ops-bare-source-${run}`,
        kind: "calligraphy",
      },
    });
    const incomplete = await execute("catalog.publish", {
      id: bare.id,
      expected: { revision: bare.revision },
    });
    expect(incomplete).toMatchObject({ ok: false, code: "CONTENT_INVALID" });
    expect((incomplete.data.failed![0]!.fields ?? []).length).toBeGreaterThan(
      0,
    );

    const open = await seedDraft();
    const lock = await lockFor("catalogs", open.id);
    const locked = await execute("catalog.publish", {
      id: open.id,
      expected: open.expected,
    });
    expect(locked).toMatchObject({ ok: false, code: "DOCUMENT_LOCKED" });
    expect(locked.data.conflict![0]!.lock).toMatchObject({ by: "owner" });
    await unlock(lock.id);
    expect((await liveOf(open.id))._status).toBe("draft");
  });

  it("refuses images that are not ready, with the direct switch off and on, and the Owner's path keeps the switch", async () => {
    const draft = await seedDraftWithMedia();
    const input = { id: draft.id, expected: draft.expected };
    const off = await execute("catalog.publish", input);
    expect(off).toMatchObject({
      ok: false,
      code: "CATALOG_DELIVERY_PREPARATION_REQUIRED",
    });
    vi.stubEnv("CMS_CATALOG_DIRECT_PUBLISH", "on");
    try {
      const on = await execute("catalog.publish", input);
      expect(on).toMatchObject({
        ok: false,
        code: "CATALOG_DELIVERY_PREPARATION_REQUIRED",
      });
      expect((await liveOf(draft.id))._status).toBe("draft");
      // The Owner's own publish, as the Admin sends it: the switch still covers it.
      const owned = await payload.update({
        collection: "catalogs",
        id: draft.id,
        data: { revision: draft.revision, _status: "published" },
        draft: false,
        req: await reqFor(owner),
        user: owner,
        overrideAccess: false,
        overrideLock: false,
      });
      expect(owned._status).toBe("published");
    } finally {
      vi.stubEnv("CMS_CATALOG_DIRECT_PUBLISH", "");
    }
  });

  it("publishes a text edit of a live record whose images are proved complete, and says so when the proof cannot be read", async () => {
    const live = await released(await seedDraftWithMedia());
    const patched = await execute("catalog.patch_text", {
      catalogId: live.id,
      field: "transcription",
      edits: [{ oldText: "合", newText: "和" }],
      expected: live.expected,
    });
    const expected = {
      revision: resultOf(patched)!.revision,
      fingerprint: resultOf(patched)!.fingerprint,
    };
    const input = { id: live.id, expected };
    // No Backend at all: no proof, so the images read as not ready.
    expect(await execute("catalog.publish", input)).toMatchObject({
      ok: false,
      code: "CATALOG_DELIVERY_PREPARATION_REQUIRED",
    });
    const down = await withOperator(
      {
        catalogPublishedRenditions: async () => {
          throw new Error("synthetic Backend failure");
        },
      },
      () => execute("catalog.publish", input),
    );
    expect(down).toMatchObject({
      ok: false,
      code: "CATALOG_DELIVERY_READINESS_UNAVAILABLE",
      retryable: true,
    });
    const answered = (complete: boolean) =>
      withOperator(
        { catalogPublishedRenditions: renditionsAnswering(complete) },
        () => execute("catalog.publish", input),
      );
    expect(await answered(false)).toMatchObject({
      ok: false,
      code: "CATALOG_DELIVERY_PREPARATION_REQUIRED",
    });
    expect((await draftOf(live.id))._status).toBe("draft");
    expect(await answered(true)).toMatchObject({ ok: true });
    expect((await draftOf(live.id))._status).toBe("published");
  });
});

describe("a record the Owner published ahead of its images", () => {
  const ownerPublishes = async (draft: { id: number; revision: number }) => {
    const owned = await payload.update({
      collection: "catalogs",
      id: draft.id,
      data: { revision: draft.revision, _status: "published" },
      draft: false,
      req: await reqFor(owner),
      user: owner,
      overrideAccess: false,
      overrideLock: false,
    });
    expect(owned._status).toBe("published");
    return Number(owned.revision);
  };
  const answering = (complete: boolean, args: Record<string, unknown>) =>
    withOperator(
      { catalogPublishedRenditions: renditionsAnswering(complete) },
      () => call(args),
    );

  it("does not read as published on catalog.publish until the images are proved, switch on or off", async () => {
    const draft = await seedDraftWithMedia();
    const args = {
      requestId: requestId(),
      op: "catalog.publish",
      input: { id: draft.id, expected: draft.expected },
    };
    vi.stubEnv("CMS_CATALOG_DIRECT_PUBLISH", "on");
    try {
      const revision = await ownerPublishes(draft);
      const refused = {
        ok: false,
        code: "CATALOG_DELIVERY_PREPARATION_REQUIRED",
      };
      expect(await call(args)).toMatchObject(refused);
      expect(await answering(false, args)).toMatchObject(refused);
      vi.stubEnv("CMS_CATALOG_DIRECT_PUBLISH", "");
      expect(await answering(false, args)).toMatchObject(refused);
      // The same requestId, as the refusal's hint says, once they are ready.
      const ready = await answering(true, args);
      expect(ready).toMatchObject({ ok: true });
      expect(ready.data.already_applied).toEqual([draft.id]);
      expect((await draftOf(draft.id)).revision).toBe(revision);
    } finally {
      vi.stubEnv("CMS_CATALOG_DIRECT_PUBLISH", "");
    }
  });

  it("does not on editorial.publish-approved either, and the Owner's own answers stay as they are", async () => {
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
    const args = {
      requestId: requestId(),
      op: "editorial.publish-approved",
      input: { approvalId, id: draft.id },
    };
    vi.stubEnv("CMS_CATALOG_DIRECT_PUBLISH", "on");
    try {
      await ownerPublishes(draft);
      expect(await call(args)).toMatchObject({
        ok: false,
        code: "CATALOG_DELIVERY_PREPARATION_REQUIRED",
      });
      // The Owner's route meets what is live and says so, ready or not, switch on or off.
      const ownerRoute = async (key: string) =>
        publishApproved(await reqFor(owner), {
          id: draft.id,
          approvalId,
          idempotencyKey: `${run}:owner-approved:${key}:${draft.id}`,
        });
      await expect(ownerRoute("on")).rejects.toMatchObject({
        code: "ALREADY_PUBLISHED",
      });
      vi.stubEnv("CMS_CATALOG_DIRECT_PUBLISH", "");
      await expect(ownerRoute("off")).rejects.toMatchObject({
        code: "ALREADY_PUBLISHED",
      });
      const ready = await answering(true, args);
      expect(ready).toMatchObject({ ok: true });
      expect(ready.data.already_applied).toEqual([draft.id]);
    } finally {
      vi.stubEnv("CMS_CATALOG_DIRECT_PUBLISH", "");
    }
  });
});

describe("a record with new images goes out through prepare and release", () => {
  it("answers QUEUED until the release, which alone answers ok:true, and publishes before it answers", async () => {
    const draft = await seedDraftWithMedia();
    const state = { ready: false };
    await withOperator(proofRoutes(state), async () => {
      const prepared = await execute("editorial.prepare-catalog-delivery", {
        id: draft.id,
        expectedRevision: draft.revision,
        expectedFingerprint: draft.fingerprint,
      });
      expect(prepared).toMatchObject({
        ok: false,
        code: "QUEUED",
        state: "prepared",
      });
      const intent = resultOf(prepared) as unknown as {
        intentId: string;
        stateVersion: number;
        manifestSha256: string;
      };
      const read = async () => {
        const result = await client.callTool({
          name: "admin_read",
          arguments: {
            op: "editorial.read-catalog-delivery",
            input: { intentId: intent.intentId },
          },
        });
        return (result.structuredContent as { data: { readiness: string } })
          .data.readiness;
      };
      expect(await read()).toBe("PENDING");
      const requested = await execute("editorial.request-catalog-release", {
        intentId: intent.intentId,
        expectedStateVersion: intent.stateVersion,
        expectedManifestSha256: intent.manifestSha256,
      });
      expect(requested).toMatchObject({
        ok: false,
        code: "QUEUED",
        state: "release_requested",
      });
      const { stateVersion } = resultOf(requested) as unknown as {
        stateVersion: number;
      };
      const release = {
        intentId: intent.intentId,
        expectedStateVersion: stateVersion,
        expectedRevision: draft.revision,
        expectedFingerprint: draft.fingerprint,
      };
      const id = requestId();
      const pending = await call({
        requestId: id,
        op: "editorial.release-catalog-delivery",
        input: release,
      });
      expect(pending).toMatchObject({
        ok: false,
        code: "CATALOG_DELIVERY_PENDING",
        retryable: true,
        next: { tool: "admin_execute", args: { requestId: id } },
      });
      expect((await liveOf(draft.id))._status).toBe("draft");
      // catalog.publish does not get past images a release is still waiting for.
      expect(
        await execute("catalog.publish", {
          id: draft.id,
          expected: draft.expected,
        }),
      ).toMatchObject({
        ok: false,
        code: "CATALOG_DELIVERY_PREPARATION_REQUIRED",
      });

      state.ready = true;
      expect(await read()).toBe("READY");
      // The same requestId: a refusal that said to retry left nothing behind.
      const done = await call(pending.next!.args);
      expect(done).toMatchObject({ ok: true, code: "OK" });
      expect(resultOf(done)).toMatchObject({
        state: "released",
        id: draft.id,
      });
      expect(await inPublicReads(draft.catalogId)).toBe(true);
      expect((await liveOf(draft.id))._status).toBe("published");
      const replay = await call({
        requestId: id,
        op: "editorial.release-catalog-delivery",
        input: release,
      });
      expect(replay).toMatchObject({ ok: true, meta: { replayed: true } });
    });
  });
});

describe("catalog.withdraw", () => {
  it("takes the record out of public reads and stays QUEUED while its images cannot be proved gone", async () => {
    const live = await released(await seedDraftWithMedia());
    expect(await inPublicReads(live.catalogId)).toBe(true);
    const id = requestId();
    const input = { id: live.id, expected: live.expected };
    const answer = await call({ requestId: id, op: "catalog.withdraw", input });
    expect(answer).toMatchObject({
      ok: false,
      code: "QUEUED",
      state: "worker_sync",
      next: { tool: "admin_get", args: { type: "catalog", id: live.id } },
    });
    expect(answer).not.toHaveProperty("retryable");
    expect(answer.hint).toContain("do not report them gone");
    expect(answer.data.queued).toEqual([
      { index: 0, id: live.id, state: "worker_sync" },
    ]);
    expect(await inPublicReads(live.catalogId)).toBe(false);
    const stored = await liveOf(live.id);
    expect(stored._status).toBe("draft");
    expect(stored.revision).toBe(Number(live.expected.revision) + 1);

    // Nothing that happens next says more than this did.
    const replay = await call({ requestId: id, op: "catalog.withdraw", input });
    expect(replay).toMatchObject({ ok: false, code: "QUEUED" });
    expect(replay.meta.replayed).toBe(true);
    const anotherKey = await execute("catalog.withdraw", input);
    expect(anotherKey).toMatchObject({
      ok: false,
      code: "QUEUED",
      state: "worker_sync",
    });
    expect((await liveOf(live.id)).revision).toBe(stored.revision);
    expect(
      await withOperator(
        { catalogPublishedRenditions: renditionsAnswering(false) },
        () => execute("catalog.withdraw", input),
      ),
    ).toMatchObject({ ok: false, code: "QUEUED" });
  });

  it("completes when the record never held an image, and says so again on a repeat", async () => {
    const draft = await seedDraft();
    const published = await execute("catalog.publish", {
      id: draft.id,
      expected: draft.expected,
    });
    const expected = {
      revision: resultOf(published)!.revision as number,
      fingerprint: draft.fingerprint,
    };
    const id = requestId();
    const input = { id: draft.id, expected };
    const answer = await call({ requestId: id, op: "catalog.withdraw", input });
    expect(answer).toMatchObject({ ok: true, code: "OK" });
    expect(answer.data.applied).toEqual([draft.id]);
    expect(await inPublicReads(draft.catalogId)).toBe(false);
    const replay = await call({ requestId: id, op: "catalog.withdraw", input });
    expect(replay).toMatchObject({ ok: true, meta: { replayed: true } });
    const anotherKey = await execute("catalog.withdraw", input);
    expect(anotherKey).toMatchObject({ ok: true });
    expect(anotherKey.data.already_applied).toEqual([draft.id]);
  });

  it("keeps no refusal for a record it found already withdrawn: the same requestId works once it is live", async () => {
    const draft = await seedDraft();
    const id = requestId();
    const first = await call({
      requestId: id,
      op: "catalog.withdraw",
      input: { id: draft.id, expected: draft.expected },
    });
    expect(first.data.already_applied).toEqual([draft.id]);
    const published = await execute("catalog.publish", {
      id: draft.id,
      expected: draft.expected,
    });
    expect(await inPublicReads(draft.catalogId)).toBe(true);
    const second = await call({
      requestId: id,
      op: "catalog.withdraw",
      input: {
        id: draft.id,
        expected: { ...draft.expected, revision: draft.revision },
      },
    });
    // Still the first revision, so this one meets the conflict and not a stored answer.
    expect(second).toMatchObject({ ok: false, code: "REVISION_CONFLICT" });
    expect(second.meta.replayed).toBeUndefined();
    expect(resultOf(published)!.revision).toBe(draft.revision + 1);
  });

  it("stays QUEUED for a record whose version history may have lost its images", async () => {
    const draft = await seedDraft();
    const published = await execute("catalog.publish", {
      id: draft.id,
      expected: draft.expected,
    });
    await rowsOf(sql`
      INSERT INTO _catalogs_v (parent_id, version_catalog_id, version_source_id, version_kind, latest, created_at, updated_at)
      SELECT ${draft.id}, version_catalog_id, version_source_id, version_kind, false,
        now() - n * interval '1 minute', now() - n * interval '1 minute'
      FROM _catalogs_v, generate_series(1, 100) AS n
      WHERE id = (SELECT min(id) FROM _catalogs_v WHERE parent_id = ${draft.id})`);
    const answer = await execute("catalog.withdraw", {
      id: draft.id,
      expected: {
        revision: resultOf(published)!.revision,
        fingerprint: draft.fingerprint,
      },
    });
    expect(answer).toMatchObject({ ok: false, code: "QUEUED" });
    expect(await inPublicReads(draft.catalogId)).toBe(false);
  });

  it("refuses a stale revision and leaves the record public", async () => {
    const draft = await seedDraft();
    await execute("catalog.publish", {
      id: draft.id,
      expected: draft.expected,
    });
    const answer = await execute("catalog.withdraw", {
      id: draft.id,
      expected: { revision: draft.revision },
    });
    expect(answer).toMatchObject({ ok: false, code: "REVISION_CONFLICT" });
    expect(await inPublicReads(draft.catalogId)).toBe(true);
  });

  it("names each target of a batch, and one complete target does not read the batch as done", async () => {
    const text = await seedDraft();
    const textPublished = await execute("catalog.publish", {
      id: text.id,
      expected: text.expected,
    });
    const live = await released(await seedDraftWithMedia());
    const answer = await call({
      requestId: requestId(),
      op: "catalog.withdraw",
      targets: [
        {
          id: text.id,
          expected: { revision: resultOf(textPublished)!.revision },
        },
        { id: live.id, expected: live.expected },
      ],
    });
    expect(answer).toMatchObject({ ok: false, code: "QUEUED" });
    expect(answer.data.applied).toEqual([text.id]);
    expect(answer.data.queued).toMatchObject([{ index: 1, id: live.id }]);
  });
});

describe("catalog.restore", () => {
  const seedTwoVersions = async () => {
    const draft = await seedDraft({ title: "First title" });
    const edited = await execute("editorial.save-draft", {
      id: draft.id,
      expectedRevision: draft.revision,
      content: {
        catalogId: draft.catalogId,
        sourceId: draft.sourceId,
        kind: "calligraphy",
        title: "Second title",
      },
    });
    const { docs } = await payload.findVersions({
      collection: "catalogs",
      where: { parent: { equals: draft.id } },
      sort: "createdAt",
      limit: 1,
      depth: 0,
      overrideAccess: true,
    });
    return {
      ...draft,
      versionId: docs[0]!.id,
      latest: Number(resultOf(edited)!.revision),
    };
  };

  it("restores under the AI key as a new draft, and a repeat replays", async () => {
    const draft = await seedTwoVersions();
    const id = requestId();
    const input = {
      id: draft.id,
      versionId: draft.versionId,
      expected: { revision: draft.latest },
    };
    const answer = await call({ requestId: id, op: "catalog.restore", input });
    expect(answer).toMatchObject({ ok: true, code: "OK" });
    expect(answer.data.applied).toEqual([draft.id]);
    expect(resultOf(answer)).toMatchObject({
      title: "First title",
      revision: draft.latest + 1,
      status: "draft",
      changedFields: ["title"],
      fingerprint: draft.fingerprint,
    });
    const stored = await draftOf(draft.id);
    expect(stored.title).toBe("First title");
    expect(stored._status).toBe("draft");
    const replay = await call({ requestId: id, op: "catalog.restore", input });
    expect(replay).toMatchObject({ ok: true, meta: { replayed: true } });
    expect((await draftOf(draft.id)).revision).toBe(draft.latest + 1);
  });

  it("reports the images a restore drops", async () => {
    const draft = await seedDraftWithMedia();
    const dropped = await saveDraft(await reqFor(owner), {
      id: draft.id,
      expectedRevision: draft.revision,
      idempotencyKey: `${run}:drop:${randomUUID()}`,
      content: {
        ...syntheticCatalogDraft(draft.catalogId, draft.sourceId),
        media: [],
      },
    });
    const kept = await saveDraft(await reqFor(owner), {
      id: draft.id,
      expectedRevision: dropped.revision,
      idempotencyKey: `${run}:add:${randomUUID()}`,
      content: {
        ...syntheticCatalogDraft(draft.catalogId, draft.sourceId),
        media: [draft.mediaRow],
      },
    });
    const { docs } = await payload.findVersions({
      collection: "catalogs",
      where: { parent: { equals: draft.id } },
      sort: "-createdAt",
      limit: 2,
      depth: 0,
      overrideAccess: true,
    });
    const answer = await execute("catalog.restore", {
      id: draft.id,
      versionId: docs[1]!.id,
      expected: { revision: kept.revision },
    });
    expect(answer.ok).toBe(true);
    expect(resultOf(answer)).toMatchObject({
      removedItems: { media: [draft.mediaRow.mediaId] },
    });
  });

  it("names the delivery it ended, and a replay of a publish since withdrawn reads as it is now", async () => {
    const draft = await seedDraftWithMedia();
    const prepared = await execute("editorial.prepare-catalog-delivery", {
      id: draft.id,
      expectedRevision: draft.revision,
      expectedFingerprint: draft.fingerprint,
    });
    const { docs } = await payload.findVersions({
      collection: "catalogs",
      where: { parent: { equals: draft.id } },
      limit: 1,
      depth: 0,
      overrideAccess: true,
    });
    const restored = await execute("catalog.restore", {
      id: draft.id,
      versionId: docs[0]!.id,
      expected: { revision: draft.revision },
    });
    expect(resultOf(restored)).toMatchObject({
      supersededIntents: [resultOf(prepared)!.intentId],
    });

    const text = await seedDraft();
    const id = requestId();
    const input = { id: text.id, expected: text.expected };
    const published = await call({
      requestId: id,
      op: "catalog.publish",
      input,
    });
    await execute("catalog.withdraw", {
      id: text.id,
      expected: { revision: resultOf(published)!.revision },
    });
    const replay = await call({ requestId: id, op: "catalog.publish", input });
    expect(replay).toMatchObject({ ok: true, meta: { replayed: true } });
    expect(resultOf(replay)).toMatchObject({
      status: "draft",
      warnings: ["moved_since_save"],
    });
  });

  it("refuses a version of another record, a stale revision and an impossible version", async () => {
    const draft = await seedTwoVersions();
    const other = await seedTwoVersions();
    expect(
      await execute("catalog.restore", {
        id: draft.id,
        versionId: other.versionId,
        expected: { revision: draft.latest },
      }),
    ).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(
      await execute("catalog.restore", {
        id: draft.id,
        versionId: draft.versionId,
        expected: { revision: draft.latest - 1 },
      }),
    ).toMatchObject({ ok: false, code: "REVISION_CONFLICT" });
    expect(
      await execute("catalog.restore", {
        id: draft.id,
        versionId: 3_000_000_000,
        expected: { revision: draft.latest },
      }),
    ).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect((await draftOf(draft.id)).revision).toBe(draft.latest);
  });

  it("answers DOCUMENT_LOCKED on a document the Owner has open, whichever op restores it", async () => {
    const draft = await seedTwoVersions();
    const lock = await lockFor("catalogs", draft.id);
    const direct = await execute("catalog.restore", {
      id: draft.id,
      versionId: draft.versionId,
      expected: { revision: draft.latest },
    });
    expect(direct).toMatchObject({ ok: false, code: "DOCUMENT_LOCKED" });
    expect(direct.data.conflict![0]!.lock).toMatchObject({ by: "owner" });
    const relayed = await execute("editorial.restore-draft", {
      versionId: draft.versionId,
      expectedRevision: draft.latest,
    });
    expect(relayed).toMatchObject({ ok: false, code: "DOCUMENT_LOCKED" });
    expect((await draftOf(draft.id)).revision).toBe(draft.latest);
    // The Owner's own button is not refused by the Owner's own lock.
    const owned = await restoreDraft(await reqFor(owner), {
      versionId: draft.versionId,
      expectedRevision: draft.latest,
    });
    expect(owned.revision).toBe(draft.latest + 1);
    await unlock(lock.id);
  });

  it("stays closed to automation, on the operation, on REST and on the native route", async () => {
    const draft = await seedTwoVersions();
    await expect(
      restoreDraft(await reqFor(automation), {
        versionId: draft.versionId,
        expectedRevision: draft.latest,
      }),
    ).rejects.toMatchObject({ code: "RESTORE_OWNER_ONLY" });
    const headers = {
      "content-type": "application/json",
      authorization: ["users", "API-Key", automationRestKey].join(" "),
    };
    const rest = await fetch(
      new URL("/api/editorial/restore-draft", server.origin),
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          versionId: draft.versionId,
          expectedRevision: draft.latest,
        }),
      },
    );
    expect(rest.status).toBe(403);
    const native = await fetch(
      new URL(
        `/api/catalogs/versions/${String(draft.versionId)}?draft=true&expectedRevision=${draft.latest}`,
        server.origin,
      ),
      { method: "POST", headers },
    );
    expect(native.ok).toBe(false);
    expect((await draftOf(draft.id)).revision).toBe(draft.latest);
  });

  it("leaves the Owner's restore on REST as it was", async () => {
    const draft = await seedTwoVersions();
    const response = await fetch(
      new URL("/api/editorial/restore-draft", server.origin),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: ["users", "API-Key", ownerRestKey].join(" "),
        },
        body: JSON.stringify({
          versionId: draft.versionId,
          expectedRevision: draft.latest,
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      result: { id: draft.id, revision: draft.latest + 1 },
    });
    expect((await draftOf(draft.id)).title).toBe("First title");
  });
});

describe("approvals", () => {
  const seedScoped = async () => {
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

  it("approve-batch works under an AI key and under an Owner REST key, and each records its own approver", async () => {
    const byAi = await seedScoped();
    const aiAnswer = await execute("editorial.approve-batch", {
      automationUserId: automation.id,
      items: [{ id: byAi.id, revision: byAi.revision }],
    });
    expect(aiAnswer).toMatchObject({ ok: true });
    const aiApproval = await payload.findByID({
      collection: "editorial-approvals",
      id: resultOf(aiAnswer)!.approvalId as number,
      depth: 0,
    });
    expect(aiApproval.approvedBy).toBe(aiUser.id);

    const byOwner = await seedScoped();
    const response = await fetch(
      new URL("/api/editorial/approve-batch", server.origin),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: ["users", "API-Key", ownerRestKey].join(" "),
        },
        body: JSON.stringify({
          automationUserId: automation.id,
          items: [{ id: byOwner.id, revision: byOwner.revision }],
        }),
      },
    );
    expect(response.status).toBe(200);
    const { result } = (await response.json()) as {
      result: { approvalId: number };
    };
    const ownerApproval = await payload.findByID({
      collection: "editorial-approvals",
      id: result.approvalId,
      depth: 0,
    });
    expect(ownerApproval.approvedBy).toBe(owner.id);

    // Automation still cannot approve anything, itself included.
    const refused = await fetch(
      new URL("/api/editorial/approve-batch", server.origin),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: ["users", "API-Key", automationRestKey].join(" "),
        },
        body: JSON.stringify({
          automationUserId: automation.id,
          items: [{ id: byOwner.id, revision: byOwner.revision }],
        }),
      },
    );
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({
      error: { code: "APPROVAL_OWNER_ONLY" },
    });
  });

  it("revokes once, a repeat says already applied, and a publish then refuses by name", async () => {
    const draft = await seedScoped();
    const { approvalId } = await approveBatch(await reqFor(owner), {
      automationUserId: automation.id,
      items: [{ id: draft.id, revision: draft.revision }],
    });
    const input = { approvalId, type: "catalog" };
    const revoked = await execute("approval.revoke", input);
    expect(revoked).toMatchObject({ ok: true });
    expect(revoked.data.applied).toEqual([approvalId]);
    expect(resultOf(revoked)).toMatchObject({
      approvalId,
      status: "revoked",
      itemCount: 1,
    });
    const again = await execute("approval.revoke", input);
    expect(again).toMatchObject({ ok: true });
    expect(again.data.already_applied).toEqual([approvalId]);
    expect(
      await execute("editorial.publish-approved", {
        approvalId,
        id: draft.id,
      }),
    ).toMatchObject({ ok: false, code: "APPROVAL_REVOKED" });
    expect((await liveOf(draft.id))._status).toBe("draft");
  });

  it("keeps Catalog and Article approvals apart, and a missing one is named", async () => {
    const article = await seedArticle();
    const approved = await execute("editorial.approve-article-batch", {
      automationUserId: automation.id,
      items: [{ id: article.id, revision: article.revision }],
    });
    const approvalId = resultOf(approved)!.approvalId as number;
    expect(
      await execute("approval.revoke", { approvalId, type: "article" }),
    ).toMatchObject({ ok: true });
    const stored = await payload.findByID({
      collection: "editorial-article-approvals",
      id: approvalId,
      depth: 0,
    });
    expect(stored.status).toBe("revoked");
    expect(
      await execute("approval.revoke", {
        approvalId: 2_000_000_000,
        type: "catalog",
      }),
    ).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(
      await execute("approval.revoke", {
        approvalId: 3_000_000_000,
        type: "catalog",
      }),
    ).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(
      await execute("approval.revoke", { approvalId, type: "other" }),
    ).toMatchObject({ ok: false, code: "INPUT_INVALID" });
  });
});

describe("an Article", () => {
  const articleOf = (id: number) =>
    payload.findByID({ collection: "articles", id, draft: true, depth: 0 });
  const liveArticle = (id: number) =>
    payload.findByID({ collection: "articles", id, draft: false, depth: 0 });

  it("publishes, replays its own document, and a new requestId says already applied", async () => {
    const article = await seedArticle();
    const id = requestId();
    const input = {
      id: article.id,
      expected: {
        revision: article.revision,
        fingerprint: article.fingerprint,
      },
    };
    const answer = await call({ requestId: id, op: "article.publish", input });
    expect(answer).toMatchObject({ ok: true });
    expect(answer.data.applied).toEqual([article.id]);
    expect(resultOf(answer)).toMatchObject({
      id: article.id,
      articleId: article.articleId,
      status: "published",
    });
    expect(answer.untrusted).toContain("/data/results/*/articleId");
    expect((await liveArticle(article.id))._status).toBe("published");

    const replay = await call({ requestId: id, op: "article.publish", input });
    expect(replay).toMatchObject({ ok: true, meta: { replayed: true } });
    expect(resultOf(replay)).toMatchObject({
      id: article.id,
      articleId: article.articleId,
    });
    const anotherKey = await execute("article.publish", input);
    expect(anotherKey.data.already_applied).toEqual([article.id]);
  });

  it("refuses to publish what its rules refuse, and a cover that is not public", async () => {
    const empty = await seedArticle({ sections: [] });
    const refused = await execute("article.publish", {
      id: empty.id,
      expected: { revision: empty.revision },
    });
    expect(refused).toMatchObject({ ok: false, code: "CONTENT_INVALID" });
    const cover = await seedDraft();
    const covered = await seedArticle({ coverCatalog: cover.id });
    const input = {
      id: covered.id,
      expected: { revision: covered.revision },
    };
    const id = requestId();
    const unpublished = await call({
      requestId: id,
      op: "article.publish",
      input,
    });
    expect(unpublished).toMatchObject({
      ok: false,
      code: "REFERENCE_NOT_PUBLISHED",
    });
    // The hint says this requestId works once the cover is live, and it does.
    await execute("catalog.publish", {
      id: cover.id,
      expected: cover.expected,
    });
    expect(
      await call({ requestId: id, op: "article.publish", input }),
    ).toMatchObject({ ok: true });
  });

  it("withdraws at once, restores a version, and refuses a stale revision", async () => {
    const article = await seedArticle({ title: "First" });
    const published = await execute("article.publish", {
      id: article.id,
      expected: { revision: article.revision },
    });
    const revision = resultOf(published)!.revision as number;
    expect(
      await execute("article.withdraw", {
        id: article.id,
        expected: { revision: article.revision },
      }),
    ).toMatchObject({ ok: false, code: "REVISION_CONFLICT" });
    const withdrawn = await execute("article.withdraw", {
      id: article.id,
      expected: { revision },
    });
    expect(withdrawn).toMatchObject({ ok: true, code: "OK" });
    expect(resultOf(withdrawn)).toMatchObject({ status: "draft" });
    expect((await liveArticle(article.id))._status).toBe("draft");
    const again = await execute("article.withdraw", {
      id: article.id,
      expected: { revision },
    });
    expect(again.data.already_applied).toEqual([article.id]);

    const edited = await execute("editorial.save-article-draft", {
      id: article.id,
      expectedRevision: revision + 1,
      content: { title: "Second" },
    });
    expect(edited.ok).toBe(true);
    const { docs } = await payload.findVersions({
      collection: "articles",
      where: { parent: { equals: article.id } },
      sort: "createdAt",
      limit: 1,
      depth: 0,
      overrideAccess: true,
    });
    const restored = await execute("article.restore", {
      id: article.id,
      versionId: docs[0]!.id,
      expected: { revision: revision + 2 },
    });
    expect(restored).toMatchObject({ ok: true });
    expect((await articleOf(article.id)).title).toBe("First");
    expect(resultOf(restored)).toMatchObject({
      revision: revision + 3,
      changedFields: ["title"],
    });
  });
});

describe("a collection", () => {
  const stored = (id: number) =>
    payload.findByID({
      collection: "article-collections",
      id,
      draft: true,
      depth: 0,
    });

  it("edits by id, echoes what it wrote, and replays its own document", async () => {
    const collection = await seedCollection({ summary: "Stays" });
    const id = requestId();
    const input = {
      id: collection.id,
      expected: { revision: collection.revision },
      content: { title: "Renamed" },
    };
    const answer = await call({ requestId: id, op: "collection.save", input });
    expect(answer).toMatchObject({ ok: true });
    expect(resultOf(answer)).toMatchObject({
      id: collection.id,
      title: "Renamed",
      revision: collection.revision + 1,
      changedFields: ["title"],
      noRereadNeeded: true,
    });
    expect(String(resultOf(answer)!.collectionId)).toMatch(/^collection-/u);
    expect((await stored(collection.id)).summary).toBe("Stays");
    const replay = await call({ requestId: id, op: "collection.save", input });
    expect(replay).toMatchObject({ ok: true, meta: { replayed: true } });
    expect(replay.data.already_applied).toEqual([collection.id]);
    expect((await stored(collection.id)).revision).toBe(
      collection.revision + 1,
    );
    expect(
      await call({
        requestId: id,
        op: "collection.save",
        input: { ...input, content: { title: "Other" } },
      }),
    ).toMatchObject({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
  });

  it("answers PREVIEW_REQUIRED to a create and creates nothing, and refuses a stale edit", async () => {
    const title = `ops-create-${run}`;
    expect(
      await execute("collection.save", { content: { title } }),
    ).toMatchObject({ ok: false, code: "PREVIEW_REQUIRED" });
    const { totalDocs } = await payload.find({
      collection: "article-collections",
      where: { title: { equals: title } },
      limit: 0,
    });
    expect(totalDocs).toBe(0);
    const collection = await seedCollection();
    expect(
      await execute("collection.save", {
        id: collection.id,
        expected: { revision: collection.revision + 1 },
        content: { title: "Never" },
      }),
    ).toMatchObject({ ok: false, code: "REVISION_CONFLICT" });
    expect(
      await execute("collection.save", {
        id: collection.id,
        content: { title: "Never" },
      }),
    ).toMatchObject({ ok: false, code: "REVISION_REQUIRED" });
    expect(
      await execute("collection.save", {
        id: collection.id,
        expected: { revision: collection.revision },
        content: {},
      }),
    ).toMatchObject({ ok: false, code: "INPUT_INVALID" });
    expect(
      await execute("collection.save", {
        id: collection.id,
        expected: { revision: collection.revision },
        content: { title: "x".repeat(121) },
      }),
    ).toMatchObject({ ok: false, code: "INPUT_INVALID" });
  });

  it("publishes, refuses a member that does not exist by name, withdraws and restores", async () => {
    const member = await seedDraft();
    const broken = await seedCollection({
      members: [{ kind: "catalog", catalogId: `ops-missing-${run}` }],
    });
    expect(
      await execute("collection.publish", {
        id: broken.id,
        expected: { revision: broken.revision },
      }),
    ).toMatchObject({ ok: false, code: "REFERENCE_NOT_FOUND" });

    const collection = await seedCollection({ title: "First" });
    const saved = await execute("collection.save", {
      id: collection.id,
      expected: { revision: collection.revision },
      content: {
        members: [{ kind: "catalog", catalogId: member.catalogId }],
      },
    });
    const savedRevision = resultOf(saved)!.revision as number;
    await execute("catalog.publish", {
      id: member.id,
      expected: member.expected,
    });
    const published = await execute("collection.publish", {
      id: collection.id,
      expected: {
        revision: savedRevision,
        fingerprint: resultOf(saved)!.fingerprint,
      },
    });
    expect(published).toMatchObject({ ok: true });
    expect(resultOf(published)).toMatchObject({ status: "published" });
    const entries = () =>
      rowsOf(sql`
        SELECT 1 FROM article_collection_entries
        WHERE collection_id = ${resultOf(published)!.collectionId as string}`);
    expect(await entries()).toHaveLength(1);
    const withdrawn = await execute("collection.withdraw", {
      id: collection.id,
      expected: { revision: resultOf(published)!.revision },
    });
    expect(withdrawn).toMatchObject({ ok: true });
    expect(await entries()).toHaveLength(0);

    const { docs } = await payload.findVersions({
      collection: "article-collections",
      where: { parent: { equals: collection.id } },
      sort: "createdAt",
      limit: 1,
      depth: 0,
      overrideAccess: true,
    });
    const restored = await execute("collection.restore", {
      id: collection.id,
      versionId: docs[0]!.id,
      expected: { revision: resultOf(withdrawn)!.revision },
    });
    expect(restored).toMatchObject({ ok: true });
    expect((await stored(collection.id)).members ?? []).toEqual([]);
  });
});

describe("media metadata", () => {
  const seedRow = async () => {
    seeded += 1;
    const media = await seedMediaRow(
      `ops-${seeded}-${run}`,
      `ops-media-${seeded}-${run}`,
    );
    const read = await get({ type: "media", id: media.id });
    const fingerprint = read.fingerprint as string;
    // What admin_get offers is what this takes, and admin_find offers the same.
    const offered = (actions: unknown) =>
      (actions as { args: { op?: string; input?: object } }[]).find(
        ({ args }) => args.op === "media.update_metadata",
      )?.args.input;
    expect(offered(read.actions)).toEqual({
      id: media.id,
      alt: "",
      expected: { fingerprint },
    });
    const found = await client.callTool({
      name: "admin_find",
      arguments: { query: media.mediaId, type: "media" },
    });
    const { items } = (
      found.structuredContent as { data: { items: { actions: unknown }[] } }
    ).data;
    expect(offered(items[0]!.actions)).toEqual({
      id: media.id,
      alt: "",
      expected: { fingerprint },
    });
    return { media, expected: { fingerprint } };
  };

  it("edits alt, says what a Catalog keeps, and a repeat writes nothing", async () => {
    const { media, expected } = await seedRow();
    const input = { id: media.id, alt: "Corrected caption", expected };
    const answer = await execute("media.update_metadata", input);
    expect(answer).toMatchObject({ ok: true });
    expect(answer.data.applied).toEqual([media.id]);
    expect(resultOf(answer)).toMatchObject({
      id: media.id,
      mediaId: media.mediaId,
      title: "Corrected caption",
      warnings: ["catalog_alt_kept"],
    });
    expect(answer.untrusted).toContain("/data/results/*/title");
    const after = await payload.findByID({
      collection: "media",
      id: media.id,
      depth: 0,
    });
    expect(after.alt).toBe("Corrected caption");
    expect(after.sha256).toBe(media.sha256);
    expect(after.objectKey).toBe(media.objectKey);
    expect(after.rights).toBe(media.rights);

    const again = await execute("media.update_metadata", input);
    expect(again).toMatchObject({ ok: true });
    expect(again.data.already_applied).toEqual([media.id]);
  });

  it("refuses a stale read, an immutable field, an empty alt and a missing row", async () => {
    const { media, expected } = await seedRow();
    await execute("media.update_metadata", {
      id: media.id,
      alt: "Moved on",
      expected,
    });
    expect(
      await execute("media.update_metadata", {
        id: media.id,
        alt: "From a stale read",
        expected,
      }),
    ).toMatchObject({ ok: false, code: "REVISION_CONFLICT" });
    expect(
      await execute("media.update_metadata", {
        id: media.id,
        alt: "x",
        rights: "Changed",
        expected,
      }),
    ).toMatchObject({ ok: false, code: "INPUT_INVALID" });
    expect(
      await execute("media.update_metadata", {
        id: media.id,
        alt: "",
        expected,
      }),
    ).toMatchObject({ ok: false, code: "INPUT_INVALID" });
    expect(
      await execute("media.update_metadata", {
        id: 3_000_000_000,
        alt: "x",
        expected,
      }),
    ).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("answers DOCUMENT_LOCKED with the lock block on a row the Owner has open", async () => {
    const { media, expected } = await seedRow();
    const lock = await lockFor("media", media.id);
    const locked = await execute("media.update_metadata", {
      id: media.id,
      alt: "Never",
      expected,
    });
    expect(locked).toMatchObject({ ok: false, code: "DOCUMENT_LOCKED" });
    expect(locked.data.conflict![0]!.lock).toMatchObject({ by: "owner" });
    await unlock(lock.id);
  });

  it("answers PREVIEW_REQUIRED to registering a new id, and a registered one says so", async () => {
    const { media } = await seedRow();
    const registration = {
      mediaId: media.mediaId,
      catalogId: media.catalogId,
      objectKey: media.objectKey,
      sha256: media.sha256,
      mimeType: "image/png",
      filesize: media.filesize,
      width: media.width,
      height: media.height,
      alt: media.alt,
      rights: media.rights,
      orderConfidence: media.orderConfidence,
    };
    const replay = await execute("media.register_existing", registration);
    expect(replay).toMatchObject({ ok: true });
    expect(replay.data.already_applied).toEqual([media.id]);
    // Only the identical row is a replay: nothing in its answer shows the rest.
    const withoutRights = Object.fromEntries(
      Object.entries(registration).filter(([name]) => name !== "rights"),
    );
    for (const different of [
      { ...registration, sha256: "d".repeat(64) },
      { ...registration, alt: "Another alt" },
      { ...registration, rights: "Other rights" },
      { ...registration, orderConfidence: "LOW" },
      { ...registration, width: 1_000 },
      { ...registration, height: 2_000 },
      { ...registration, filesize: 999 },
      { ...registration, mimeType: "image/jpeg" },
      withoutRights,
    ]) {
      const refused = await execute("media.register_existing", different);
      expect(refused, JSON.stringify(different)).toMatchObject({
        ok: false,
        code: "OPERATION_REFUSED",
      });
      expect(refused.data.failed?.[0]?.code).toBe("MEDIA_IDENTITY_EXISTS");
    }
    const newId = `ops-new-media-${run}`;
    expect(
      await execute("media.register_existing", {
        ...registration,
        mediaId: newId,
      }),
    ).toMatchObject({ ok: false, code: "PREVIEW_REQUIRED" });
    const { totalDocs } = await payload.find({
      collection: "media",
      where: { mediaId: { equals: newId } },
      limit: 0,
    });
    expect(totalDocs).toBe(0);
  });
});

describe("a bad reference is a refusal, and what is truly unknown stays unknown", () => {
  // In the integer column's range, and no row of any table here reaches it.
  const missing = 2_147_483_000;
  const named = { ok: false, code: "REFERENCE_NOT_FOUND" };

  it("answers REFERENCE_NOT_FOUND with no retry on offer, and a batch goes on", async () => {
    const collection = await seedCollection();
    const saveOn = (content: Record<string, unknown>) => ({
      id: collection.id,
      expected: { revision: collection.revision },
      content,
    });
    for (const content of [
      { coverCatalog: missing },
      { members: [{ kind: "article", article: missing }] },
    ]) {
      const answer = await execute("collection.save", saveOn(content));
      expect(answer).toMatchObject(named);
      expect(answer.retryable).toBeUndefined();
      expect(answer.next).toBeUndefined();
      expect(answer.data.unknown).toBeUndefined();
    }
    const article = await seedArticle();
    expect(
      await execute("editorial.save-article-draft", {
        id: article.id,
        expectedRevision: article.revision,
        content: { coverCatalog: missing },
      }),
    ).toMatchObject(named);

    const batch = await call({
      requestId: requestId(),
      op: "collection.save",
      targets: [
        saveOn({ members: [{ kind: "article", article: missing }] }),
        saveOn({ title: "Renamed in a batch" }),
      ],
    });
    expect(batch.code).toBe("PARTIAL");
    expect(batch.data.failed).toEqual([
      { index: 0, id: collection.id, code: "REFERENCE_NOT_FOUND" },
    ]);
    expect(batch.data.applied).toEqual([collection.id]);
  });

  it("keeps OUTCOME_UNKNOWN when that SQLSTATE comes from the COMMIT, which it cannot confirm", async () => {
    const draft = await seedDraft();
    const id = requestId();
    const input = {
      id: draft.id,
      expected: draft.expected,
    };
    const unknown = await withCommitFailureOn(
      "editorial_receipts",
      () => call({ requestId: id, op: "catalog.publish", input }),
      "23503",
    );
    expect(unknown).toMatchObject({
      ok: false,
      code: "OUTCOME_UNKNOWN",
      retryable: true,
    });
    expect((await liveOf(draft.id))._status).toBe("draft");
    const retried = await call({
      requestId: id,
      op: "catalog.publish",
      input,
    });
    expect(retried).toMatchObject({ ok: true });
    expect(retried.data.applied).toEqual([draft.id]);
  });
});

describe("the ledger names a target named by its public identity", () => {
  const targetRows = async (id: string) =>
    (await rowsOf(sql`
      SELECT tool, phase, ok, code, target_type, target_id
      FROM mcp_audit_events WHERE request_id = ${id} ORDER BY id`)) as {
      tool: string | null;
      target_id: string | null;
    }[];

  it("records the row of one write however the caller spelled it, refused or not", async () => {
    const draft = await seedDraft();
    const published = requestId();
    expect(
      await call({
        requestId: published,
        op: "catalog.publish",
        input: { id: draft.catalogId, expected: draft.expected },
      }),
    ).toMatchObject({ ok: true });
    const rows = await targetRows(published);
    expect(rows).toHaveLength(3);
    expect(rows.find(({ tool }) => tool === null)).toMatchObject({
      phase: "finish",
      ok: true,
      code: "OK",
      target_type: "catalog",
      target_id: String(draft.id),
    });

    const other = await seedDraft();
    const refused = requestId();
    const conflict = await call({
      requestId: refused,
      op: "catalog.publish",
      input: { id: other.catalogId, expected: { revision: 99 } },
    });
    expect(conflict.data.conflict?.[0]).toMatchObject({ id: other.id });
    expect(
      (await targetRows(refused)).find(({ tool }) => tool === null),
    ).toMatchObject({
      ok: false,
      code: "REVISION_CONFLICT",
      target_id: String(other.id),
    });

    const held = await seedDraft();
    const lock = await lockFor("catalogs", held.id);
    const read = await get({ type: "catalog", id: held.id });
    const { input: offered } = (
      read.actions as {
        args: { op?: string; input?: Record<string, unknown> };
      }[]
    ).find(({ args }) => args.op === "document.lock_takeover")!.args;
    const takeover = requestId();
    expect(
      await call({
        requestId: takeover,
        op: "document.lock_takeover",
        input: { ...offered, id: held.catalogId, reason: "Synthetic takeover" },
      }),
    ).toMatchObject({ ok: true });
    expect(
      (await targetRows(takeover)).find(({ tool }) => tool === null),
    ).toMatchObject({ ok: true, target_id: String(held.id) });
    await unlock(lock.id);
  });

  it("adds no row when the start row already named it, and resolves a target already in place", async () => {
    const draft = await seedDraft();
    const direct = requestId();
    await call({
      requestId: direct,
      op: "catalog.publish",
      input: { id: draft.id, expected: draft.expected },
    });
    expect(await targetRows(direct)).toHaveLength(2);

    const unpublished = [await seedDraft(), await seedDraft()];
    const batch = requestId();
    const answer = await call({
      requestId: batch,
      op: "catalog.withdraw",
      input: { expected: { revision: 1 } },
      targets: unpublished.map(({ catalogId }) => ({ id: catalogId })),
    });
    const rows = unpublished.map(({ id }) => id);
    expect(answer.data.already_applied).toEqual(rows);
    expect(
      (await targetRows(batch))
        .filter(({ tool }) => tool === null)
        .map(({ target_id }) => target_id),
    ).toEqual(rows.map(String));
  });
});

describe("a document lock", () => {
  const seedOwnerLock = async () => {
    const draft = await seedDraft();
    const lock = await lockFor("catalogs", draft.id);
    return { draft, lock };
  };
  /** What admin_get offers, with the one field a caller decides. */
  const offeredTakeover = async (id: number, type = "catalog") => {
    const read = await get({ type, id });
    const action = (
      read.actions as {
        args: { op?: string; input?: { expected: Record<string, unknown> } };
      }[]
    ).find(({ args }) => args.op === "document.lock_takeover");
    return { ...action!.args.input!, reason: "Synthetic takeover" };
  };
  const lockRows = async (id: number) =>
    (
      await payload.find({
        collection: "payload-locked-documents",
        where: { "document.value": { equals: id } },
        depth: 0,
        overrideAccess: true,
      })
    ).docs.map(({ user, updatedAt }) => ({
      holder: user?.value,
      updatedAt,
    }));
  const ownerSave = (id: number, revision: number) =>
    fetch(new URL(`/api/catalogs/${id}?draft=true&depth=0`, server.origin), {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: ["users", "API-Key", ownerRestKey].join(" "),
      },
      body: JSON.stringify({ revision, title: "The Owner's edit" }),
    });

  it("takes over from the Owner with what admin_get offers, and the save on the fresh revision clears the row", async () => {
    const { draft } = await seedOwnerLock();
    // The holder's edit before the takeover: its revision is the one to save on.
    const edited = await saveDraft(await reqFor(owner), {
      id: draft.id,
      expectedRevision: draft.revision,
      idempotencyKey: `${run}:lock-edit:${draft.id}`,
      content: {
        ...syntheticCatalogDraft(draft.catalogId, draft.sourceId),
        title: "The holder's last autosave",
      },
    });
    await lockFor("catalogs", draft.id);

    const refused = await execute("catalog.patch_text", {
      catalogId: draft.id,
      field: "transcription",
      edits: [{ oldText: "合", newText: "和" }],
      expected: { revision: edited.revision, fingerprint: edited.fingerprint },
    });
    expect(refused).toMatchObject({ ok: false, code: "DOCUMENT_LOCKED" });
    expect(refused.data.conflict![0]!.lock).toMatchObject({
      by: "owner",
      holderUserId: owner.id,
    });

    const id = requestId();
    const takeover = await call({
      requestId: id,
      op: "document.lock_takeover",
      input: await offeredTakeover(draft.id),
    });
    expect(takeover).toMatchObject({
      ok: true,
      code: "OK",
      data: { applied: [draft.id] },
    });
    const echo = resultOf(takeover)!;
    expect(echo).toMatchObject({
      type: "catalog",
      id: draft.id,
      title: "The holder's last autosave",
      revision: edited.revision,
      fingerprint: edited.fingerprint,
    });
    expect(takeover.untrusted).toContain("/data/results/*/title");
    expect((await lockRows(draft.id))[0]!.holder).toBe(aiUser.id);
    expect((await get({ type: "catalog", id: draft.id })).lock).toMatchObject({
      by: "ai",
      holderUserId: aiUser.id,
    });

    // The Owner's save in flight now meets this holder and leaves the record as it was.
    const native = await ownerSave(draft.id, edited.revision);
    expect(native.status).toBe(423);
    expect((await draftOf(draft.id)).title).toBe("The holder's last autosave");

    const saved = await execute("catalog.patch_text", {
      catalogId: draft.id,
      field: "transcription",
      edits: [{ oldText: "合", newText: "和" }],
      expected: {
        revision: echo.revision as number,
        fingerprint: echo.fingerprint as string,
      },
    });
    expect(saved).toMatchObject({ ok: true });
    expect(await lockRows(draft.id)).toEqual([]);
    expect((await draftOf(draft.id)).revision).toBe(edited.revision + 1);

    const ledger = (await rowsOf(sql`
      SELECT phase, op, ok, code, target_type, target_id, user_id
      FROM mcp_audit_events WHERE request_id = ${id} ORDER BY id`)) as {
      phase: string;
      ok: boolean | null;
      code: string | null;
    }[];
    expect(ledger.map(({ phase }) => phase)).toEqual(["start", "finish"]);
    expect(ledger[1]).toMatchObject({
      op: "document.lock_takeover",
      ok: true,
      code: "OK",
      target_type: "catalog",
      target_id: String(draft.id),
      user_id: String(aiUser.id),
    });
  });

  it("refuses a lock that moved, says so when none is held, and leaves the holder in place", async () => {
    const { draft, lock } = await seedOwnerLock();
    const input = await offeredTakeover(draft.id);
    const { expected } = input;
    const refused = async (changes: object) => {
      const answer = await execute("document.lock_takeover", {
        ...input,
        expected: { ...expected, ...changes },
      });
      expect(answer).toMatchObject({
        ok: false,
        code: "LOCK_CHANGED",
        data: { conflict: [{ code: "LOCK_CHANGED" }] },
      });
      expect(answer.retryable).toBeUndefined();
      expect(answer.next).toBeUndefined();
      expect((await lockRows(draft.id))[0]!.holder).toBe(owner.id);
    };
    await refused({ lockId: lock.id + 1_000_000 });
    await refused({ holderUserId: automation.id });
    await refused({ lastEditedAt: "2020-01-01T00:00:00.000Z" });
    // The earliest year PostgreSQL holds still compares, and the one it cannot is named.
    await refused({ lastEditedAt: "0001-01-01T00:00:00.000Z" });
    const impossible = await execute("document.lock_takeover", {
      ...input,
      expected: { ...expected, lastEditedAt: "0000-01-01T00:00:00.000Z" },
    });
    expect(impossible).toMatchObject({ ok: false, code: "INPUT_INVALID" });
    expect(impossible.next).toBeUndefined();
    // Its holder still typing moves it: what the Admin's form state does every 10 s.
    await rowsOf(sql`
      UPDATE payload_locked_documents SET updated_at = updated_at + interval '1 second'
      WHERE id = ${lock.id}`);
    expect(await execute("document.lock_takeover", input)).toMatchObject({
      ok: false,
      code: "LOCK_CHANGED",
    });
    expect((await lockRows(draft.id))[0]!.holder).toBe(owner.id);

    // Another record's lock is not this record's to take.
    const other = await seedOwnerLock();
    expect(
      await execute("document.lock_takeover", {
        ...input,
        expected: { ...expected, lockId: other.lock.id },
      }),
    ).toMatchObject({ ok: false, code: "LOCK_CHANGED" });
    expect((await lockRows(other.draft.id))[0]!.holder).toBe(owner.id);

    const expiredInput = {
      ...(await offeredTakeover(other.draft.id)),
    };
    await rowsOf(sql`
      UPDATE payload_locked_documents SET updated_at = now() - interval '6 minutes'
      WHERE id = ${other.lock.id}`);
    expect(await execute("document.lock_takeover", expiredInput)).toMatchObject(
      {
        ok: false,
        code: "LOCK_NOT_HELD",
      },
    );
    expect((await lockRows(other.draft.id))[0]!.holder).toBe(owner.id);
    await unlock(other.lock.id);
    expect(await execute("document.lock_takeover", expiredInput)).toMatchObject(
      {
        ok: false,
        code: "LOCK_NOT_HELD",
      },
    );
  });

  /** `work` runs while another session's open transaction holds what `query` took. */
  const whileHeld = async (
    [text, values]: [string, unknown[]],
    work: (finish: () => Promise<void>) => Promise<void>,
  ) => {
    const connection = await adapter().pool.connect();
    await connection.query("BEGIN");
    await connection.query(text, values);
    let open = true;
    const finish = async () => {
      if (open) await connection.query("COMMIT");
      open = false;
    };
    try {
      await work(finish);
    } finally {
      // Whatever happened: a lock left held would hold the whole file up.
      await finish();
      connection.release();
    }
  };
  const settledYet = async (work: Promise<unknown>) => {
    const pending = Symbol("pending");
    return (
      (await Promise.race([
        work,
        new Promise((resolve) => setTimeout(() => resolve(pending), 150)),
      ])) !== pending
    );
  };

  it("waits for a save that holds the document, and answers with the revision it left", async () => {
    const { draft } = await seedOwnerLock();
    const input = await offeredTakeover(draft.id);
    await whileHeld(
      [
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`moya-editorial:document:${draft.id}`],
      ],
      async (finish) => {
        const taking = execute("document.lock_takeover", input);
        expect(await settledYet(taking)).toBe(false);
        // Stands in for what that save committed: the revision moved while this waited.
        await rowsOf(
          sql`UPDATE catalogs SET revision = revision + 1 WHERE id = ${draft.id}`,
        );
        await rowsOf(sql`
          UPDATE _catalogs_v SET version_revision = version_revision + 1
          WHERE parent_id = ${draft.id} AND latest`);
        await finish();
        const taken = await taking;
        expect(taken).toMatchObject({ ok: true });
        expect(resultOf(taken)!.revision).toBe(draft.revision + 1);
      },
    );
  });

  it("compares under the row's own lock, so a touch it waited for is a refusal", async () => {
    const { draft, lock } = await seedOwnerLock();
    const input = await offeredTakeover(draft.id);
    // The Admin's form state touches a held row with no editorial key.
    await whileHeld(
      [
        "UPDATE payload_locked_documents SET updated_at = updated_at + interval '1 second' WHERE id = $1",
        [lock.id],
      ],
      async (finish) => {
        const taking = execute("document.lock_takeover", input);
        expect(await settledYet(taking)).toBe(false);
        await finish();
        expect(await taking).toMatchObject({ ok: false, code: "LOCK_CHANGED" });
      },
    );
    expect((await lockRows(draft.id))[0]!.holder).toBe(owner.id);
  });

  it("reads the newest row, as Payload's own check does, when two tabs left two", async () => {
    const draft = await seedDraft();
    const older = await lockFor("catalogs", draft.id);
    await rowsOf(sql`
      UPDATE payload_locked_documents SET updated_at = now() - interval '1 minute'
      WHERE id = ${older.id}`);
    const newer = await payload.create({
      collection: "payload-locked-documents",
      overrideAccess: true,
      data: {
        document: { relationTo: "catalogs", value: draft.id },
        user: { relationTo: "users", value: automation.id },
      } as never,
    });
    expect((await get({ type: "catalog", id: draft.id })).lock).toMatchObject({
      by: "automation",
      lockId: newer.id,
    });
    await unlock(older.id);
    await unlock(newer.id);
  });

  it("answers a repeat from the row itself, safely, and a failed COMMIT reads unknown", async () => {
    const { draft } = await seedOwnerLock();
    const input = await offeredTakeover(draft.id);
    const id = requestId();
    const lost = await withCommitFailureOn("payload_locked_documents", () =>
      call({ requestId: id, op: "document.lock_takeover", input }),
    );
    expect(lost).toMatchObject({
      ok: false,
      code: "OUTCOME_UNKNOWN",
      retryable: true,
    });
    expect((await lockRows(draft.id))[0]!.holder).toBe(owner.id);

    const taken = await call({
      requestId: id,
      op: "document.lock_takeover",
      input,
    });
    expect(taken).toMatchObject({ ok: true, data: { applied: [draft.id] } });
    const [row] = await lockRows(draft.id);
    expect(row!.holder).toBe(aiUser.id);

    // The answer was lost after all: nothing moves, and it still says what to save on.
    const replay = await call({
      requestId: id,
      op: "document.lock_takeover",
      input,
    });
    expect(replay).toMatchObject({
      ok: true,
      data: { already_applied: [draft.id] },
      meta: { replayed: true },
    });
    expect(resultOf(replay)).toMatchObject({
      revision: draft.revision,
      fingerprint: draft.fingerprint,
    });
    expect(await lockRows(draft.id)).toEqual([row]);
  });

  it("lets the Owner take it back, and the AI then answers as locked again", async () => {
    const { draft, lock } = await seedOwnerLock();
    const input = await offeredTakeover(draft.id);
    expect(await execute("document.lock_takeover", input)).toMatchObject({
      ok: true,
    });
    // The Admin's own take-over: the same PATCH of the row's user, by its session.
    const back = await fetch(
      new URL(`/api/payload-locked-documents/${lock.id}`, server.origin),
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          authorization: ["users", "API-Key", ownerRestKey].join(" "),
        },
        body: JSON.stringify({
          user: { relationTo: "users", value: owner.id },
        }),
      },
    );
    expect(back.status).toBe(200);
    expect(await execute("document.lock_takeover", input)).toMatchObject({
      ok: false,
      code: "LOCK_CHANGED",
    });
    expect(
      await execute("catalog.patch_text", {
        catalogId: draft.id,
        field: "transcription",
        edits: [{ oldText: "合", newText: "和" }],
        expected: draft.expected,
      }),
    ).toMatchObject({ ok: false, code: "DOCUMENT_LOCKED" });
    await unlock(lock.id);
  });

  it("works on each family, and a media row has a fingerprint and no revision", async () => {
    const article = await seedArticle();
    const collection = await seedCollection();
    seeded += 1;
    const media = await seedMediaRow(
      `ops-${seeded}-${run}`,
      `ops-media-${seeded}-${run}`,
    );
    for (const [type, slug, id] of [
      ["article", "articles", article.id],
      ["collection", "article-collections", collection.id],
      ["media", "media", media.id],
    ] as const) {
      const lock = await payload.create({
        collection: "payload-locked-documents",
        overrideAccess: true,
        data: {
          document: { relationTo: slug, value: id },
          user: { relationTo: "users", value: owner.id },
        } as never,
      });
      const { updatedAt } = lock as unknown as { updatedAt: string };
      const taken = await execute("document.lock_takeover", {
        type,
        id,
        expected: {
          lockId: lock.id,
          holderUserId: owner.id,
          lastEditedAt: updatedAt,
        },
        reason: "Synthetic takeover",
      });
      expect(taken).toMatchObject({ ok: true, data: { applied: [id] } });
      const echo = resultOf(taken)!;
      expect(echo).toMatchObject({ type, id, fingerprint: expect.any(String) });
      expect("revision" in echo).toBe(type !== "media");
      expect(
        await execute("document.lock_release", { type, id }),
      ).toMatchObject({ ok: true, data: { applied: [id] } });
    }
  });

  it("gives back only this account's own lock, and a repeat says already applied", async () => {
    const { draft } = await seedOwnerLock();
    const release = { type: "catalog", id: draft.id };
    const refused = await execute("document.lock_release", release);
    expect(refused).toMatchObject({ ok: false, code: "DOCUMENT_LOCKED" });
    expect(refused.data.conflict![0]!.lock).toMatchObject({ by: "owner" });
    expect((await lockRows(draft.id))[0]!.holder).toBe(owner.id);

    const input = await offeredTakeover(draft.id);
    expect(await execute("document.lock_takeover", input)).toMatchObject({
      ok: true,
    });
    expect((await lockRows(draft.id))[0]!.holder).toBe(aiUser.id);
    expect(await execute("document.lock_release", release)).toMatchObject({
      ok: true,
      data: { applied: [draft.id] },
    });
    expect(await lockRows(draft.id)).toEqual([]);
    expect(await execute("document.lock_release", release)).toMatchObject({
      ok: true,
      data: { already_applied: [draft.id] },
    });
    // With it given back nothing stands in the Owner's way.
    expect((await ownerSave(draft.id, draft.revision)).status).toBe(200);
  });

  it("names every refusal and echoes no value", async () => {
    const { draft, lock } = await seedOwnerLock();
    const marker = `marker-${randomUUID()}`;
    const input = await offeredTakeover(draft.id);
    const { expected } = input;
    for (const bad of [
      { ...input, reason: undefined },
      { ...input, reason: "" },
      { ...input, reason: `${marker}${"理".repeat(600)}` },
      { ...input, reason: `${marker}\u0000` },
      { ...input, type: marker },
      { ...input, type: "constructor" },
      { ...input, type: "users" },
      { ...input, expected: { ...expected, lastEditedAt: marker } },
      { ...input, expected: { ...expected, lockId: -1 } },
      { ...input, expected: { ...expected, lockId: 2 ** 60 } },
      { ...input, expected: { ...expected, [marker]: 1 } },
      { ...input, expected: undefined },
      { ...input, extra: marker },
    ]) {
      const answer = await execute(
        "document.lock_takeover",
        JSON.parse(JSON.stringify(bad)) as Record<string, unknown>,
      );
      expect(answer).toMatchObject({ ok: false, code: "INPUT_INVALID" });
      expect(JSON.stringify(answer)).not.toContain(marker);
    }
    // The audit row takes its target from what was sent: a known family or nothing.
    const refusedId = requestId();
    await call({
      requestId: refusedId,
      op: "document.lock_takeover",
      input: { ...input, type: marker },
    });
    expect(
      await rowsOf(sql`
        SELECT DISTINCT target_type FROM mcp_audit_events WHERE request_id = ${refusedId}`),
    ).toEqual([{ target_type: "document" }]);
    const prototype = await call({
      requestId: requestId(),
      op: "document.lock_takeover",
      input: JSON.parse(`{"__proto__":{"type":"media"},"id":${draft.id}}`) as {
        id: number;
      },
    });
    expect(prototype).toMatchObject({ ok: false, code: "INPUT_INVALID" });
    for (const id of [3_000_000_000, "3000000000", marker]) {
      const answer = await execute("document.lock_takeover", { ...input, id });
      expect(answer).toMatchObject({ ok: false, code: "NOT_FOUND" });
      expect(JSON.stringify(answer)).not.toContain(marker);
      expect(
        await execute("document.lock_release", { type: "catalog", id }),
      ).toMatchObject({ ok: false, code: "NOT_FOUND" });
    }
    expect((await lockRows(draft.id))[0]!.holder).toBe(owner.id);
    await unlock(lock.id);
  });
});

describe("the delivery tools", () => {
  const read = async (op: string, input: Record<string, unknown>) => {
    const result = await client.callTool({
      name: "admin_read",
      arguments: { op, input },
    });
    return adminMcpEnvelopeSchema.parse(result.structuredContent);
  };
  const prepared = (
    draft: Awaited<ReturnType<typeof seedDraftWithMedia>>,
    id = requestId(),
  ) =>
    call({
      requestId: id,
      op: "editorial.prepare-catalog-delivery",
      input: {
        id: draft.id,
        expectedRevision: draft.revision,
        expectedFingerprint: draft.fingerprint,
      },
    });
  type Intent = {
    intentId: string;
    state: string;
    stateVersion: number;
    manifestSha256: string;
    readiness: string;
  };
  const intentOf = (answer: Answer) => resultOf(answer) as unknown as Intent;
  const requested = async (
    draft: Awaited<ReturnType<typeof seedDraftWithMedia>>,
  ) => {
    const intent = intentOf(await prepared(draft));
    return intentOf(
      await execute("editorial.request-catalog-release", {
        intentId: intent.intentId,
        expectedStateVersion: intent.stateVersion,
        expectedManifestSha256: intent.manifestSha256,
      }),
    );
  };
  const releaseInput = (
    intent: Intent,
    draft: Awaited<ReturnType<typeof seedDraftWithMedia>>,
  ) => ({
    intentId: intent.intentId,
    expectedStateVersion: intent.stateVersion,
    expectedRevision: draft.revision,
    expectedFingerprint: draft.fingerprint,
  });

  it("names how to go on at each step, and accepted never reads as done", async () => {
    const draft = await seedDraftWithMedia();
    await withOperator(proofRoutes({ ready: false }), async () => {
      const id = requestId();
      const first = await prepared(draft, id);
      expect(first).toMatchObject({
        ok: false,
        code: "QUEUED",
        state: "prepared",
        next: { tool: "admin_read" },
      });
      expect(first.retryable).toBeUndefined();
      expect(first.hint).toContain("editorial.request-catalog-release");
      expect(first.data.queued).toEqual([
        { index: 0, id: draft.id, state: "prepared" },
      ]);
      expect(first.next).toEqual({
        tool: "admin_read",
        args: {
          op: "editorial.read-catalog-delivery",
          input: { intentId: intentOf(first).intentId },
        },
      });
      // A new requestId finds the same intent, and the same one replays it.
      const again = await prepared(draft);
      expect(intentOf(again).intentId).toBe(intentOf(first).intentId);
      expect(await prepared(draft, id)).toMatchObject({
        code: "QUEUED",
        meta: { replayed: true },
      });
      const intent = intentOf(first);
      const asked = await execute("editorial.request-catalog-release", {
        intentId: intent.intentId,
        expectedStateVersion: intent.stateVersion,
        expectedManifestSha256: intent.manifestSha256,
      });
      expect(asked).toMatchObject({
        ok: false,
        code: "QUEUED",
        state: "release_requested",
      });
      expect(asked.hint).toContain("editorial.release-catalog-delivery");
      expect((await liveOf(draft.id))._status).toBe("draft");
    });
  });

  it("says when no Backend can ever render it, and what a Backend that is down means", async () => {
    const draft = await seedDraftWithMedia();
    const id = requestId();
    const unconfigured = await prepared(draft, id);
    expect(unconfigured).toMatchObject({
      ok: false,
      code: "CATALOG_DELIVERY_NOT_CONFIGURED",
      data: { failed: [{ code: "CATALOG_DELIVERY_NOT_CONFIGURED" }] },
    });
    expect(unconfigured.next).toBeUndefined();
    const { intentId } = intentOf(unconfigured);
    expect(
      await read("editorial.read-catalog-delivery", { intentId }),
    ).toMatchObject({ ok: true, data: { readiness: "NOT_CONFIGURED" } });
    expect(
      await read("editorial.catalog-delivery-capabilities", {}),
    ).toMatchObject({ ok: true, data: { delivery: "NOT_CONFIGURED" } });
    expect(await read("editorial.catalog-render-backlog", {})).toMatchObject({
      ok: false,
      code: "CATALOG_RENDER_BACKLOG_NOT_CONFIGURED",
    });

    const fresh = await seedDraftWithMedia();
    const retried = requestId();
    await withOperator(
      {
        catalogRecipePolicy: async () => {
          throw new Error("synthetic backend failure");
        },
        catalogRenderBacklog: async () => {
          throw new Error("synthetic backend failure");
        },
      },
      async () => {
        expect(await prepared(fresh, retried)).toMatchObject({
          ok: false,
          code: "CATALOG_RECIPE_POLICY_UNAVAILABLE",
          retryable: true,
          next: { args: { requestId: retried } },
        });
        expect(
          await read("editorial.catalog-delivery-capabilities", {}),
        ).toMatchObject({ ok: true, data: { delivery: "UNAVAILABLE" } });
        expect(
          await read("editorial.catalog-render-backlog", {}),
        ).toMatchObject({
          ok: false,
          code: "CATALOG_RENDER_BACKLOG_UNAVAILABLE",
          retryable: true,
        });
      },
    );
    await withOperator(proofRoutes({ ready: false }), async () => {
      expect(await prepared(fresh, retried)).toMatchObject({
        code: "QUEUED",
        state: "prepared",
      });
      // The readiness route going away is not a refusal of the record.
      vi.stubEnv("COMMUNITY_OPERATOR_BASE_URL", "http://127.0.0.1:9");
      expect(
        await read("editorial.read-catalog-delivery", {
          intentId: intentOf(await prepared(fresh, retried)).intentId,
        }),
      ).toMatchObject({
        ok: false,
        code: "CATALOG_DELIVERY_READINESS_UNAVAILABLE",
        retryable: true,
      });
    });
  });

  it("reads capabilities and the backlog from a Backend that answers", async () => {
    await withOperator(
      {
        catalogDeliveryReadiness: async () => null,
        catalogRenderBacklog: async () => ({
          tiers: null,
          countedAt: null,
          queued: 1,
          running: 1,
        }),
      },
      async () => {
        expect(
          await read("editorial.catalog-delivery-capabilities", {}),
        ).toMatchObject({ ok: true, data: { delivery: "AVAILABLE" } });
        expect(
          await read("editorial.catalog-render-backlog", {}),
        ).toMatchObject({
          ok: true,
          data: { queued: 1, running: 1, preparedSince: 0 },
        });
      },
    );
  });

  it("cancels at once, and a replay of its prepare then says it ended", async () => {
    const draft = await seedDraftWithMedia();
    await withOperator(proofRoutes({ ready: false }), async () => {
      const prepareId = requestId();
      const intent = intentOf(await prepared(draft, prepareId));
      const cancelId = requestId();
      const cancel = {
        intentId: intent.intentId,
        expectedStateVersion: intent.stateVersion,
      };
      const cancelled = await call({
        requestId: cancelId,
        op: "editorial.cancel-catalog-delivery",
        input: cancel,
      });
      expect(cancelled).toMatchObject({ ok: true });
      expect(intentOf(cancelled).state).toBe("cancelled");
      expect(
        await call({
          requestId: cancelId,
          op: "editorial.cancel-catalog-delivery",
          input: cancel,
        }),
      ).toMatchObject({ ok: true, meta: { replayed: true } });

      const replay = await prepared(draft, prepareId);
      expect(replay).toMatchObject({
        ok: false,
        code: "CATALOG_DELIVERY_INACTIVE",
        meta: { replayed: true },
      });
      expect(replay.next).toBeUndefined();
      expect(
        await execute("editorial.request-catalog-release", {
          intentId: intent.intentId,
          expectedStateVersion: intentOf(replay).stateVersion,
          expectedManifestSha256: intent.manifestSha256,
        }),
      ).toMatchObject({ ok: false, code: "CATALOG_DELIVERY_INACTIVE" });
    });
  });

  it("reads released as done on a replay, and ended once the record moves on", async () => {
    const draft = await seedDraftWithMedia();
    const state = { ready: false };
    await withOperator(proofRoutes(state), async () => {
      const prepareId = requestId();
      const intent = intentOf(await prepared(draft, prepareId));
      const asked = intentOf(
        await execute("editorial.request-catalog-release", {
          intentId: intent.intentId,
          expectedStateVersion: intent.stateVersion,
          expectedManifestSha256: intent.manifestSha256,
        }),
      );
      state.ready = true;
      const done = await execute(
        "editorial.release-catalog-delivery",
        releaseInput(asked, draft),
      );
      expect(done).toMatchObject({ ok: true });
      const replay = await prepared(draft, prepareId);
      expect(replay).toMatchObject({ ok: true, meta: { replayed: true } });
      expect(intentOf(replay).state).toBe("released");
      // A cancel of what is released is refused, and nothing moves.
      expect(
        await execute("editorial.cancel-catalog-delivery", {
          intentId: intent.intentId,
          expectedStateVersion: intentOf(done).stateVersion,
        }),
      ).toMatchObject({ ok: false, code: "CATALOG_DELIVERY_INACTIVE" });

      const withdrawn = await execute("catalog.withdraw", {
        id: draft.id,
        expected: { revision: (await draftOf(draft.id)).revision },
      });
      expect(withdrawn).toMatchObject({ code: "QUEUED", state: "worker_sync" });
      expect(await prepared(draft, prepareId)).toMatchObject({
        ok: false,
        code: "CATALOG_DELIVERY_INACTIVE",
      });
    });
  });

  it("says an expired delivery expired, on a replay and on the next step", async () => {
    const draft = await seedDraftWithMedia();
    await withOperator(proofRoutes({ ready: true }), async () => {
      const prepareId = requestId();
      const intent = intentOf(await prepared(draft, prepareId));
      await rowsOf(sql`
        UPDATE catalog_delivery_intents SET expires_at = now() - interval '1 minute'
        WHERE id = ${intent.intentId}::uuid`);
      expect(
        await execute("editorial.request-catalog-release", {
          intentId: intent.intentId,
          expectedStateVersion: intent.stateVersion,
          expectedManifestSha256: intent.manifestSha256,
        }),
      ).toMatchObject({ ok: false, code: "CATALOG_DELIVERY_EXPIRED" });
      expect(
        await read("editorial.read-catalog-delivery", {
          intentId: intent.intentId,
        }),
      ).toMatchObject({ ok: true, data: { state: "expired" } });
      expect(await prepared(draft, prepareId)).toMatchObject({
        ok: false,
        code: "CATALOG_DELIVERY_EXPIRED",
      });
    });
  });

  it("refuses a release on a record the Owner has open with its lock block, and goes through after a takeover", async () => {
    const draft = await seedDraftWithMedia();
    await withOperator(proofRoutes({ ready: true }), async () => {
      const intent = await requested(draft);
      const lock = await lockFor("catalogs", draft.id);
      const id = requestId();
      const input = releaseInput(intent, draft);
      const refused = await call({
        requestId: id,
        op: "editorial.release-catalog-delivery",
        input,
      });
      expect(refused).toMatchObject({ ok: false, code: "DOCUMENT_LOCKED" });
      const row = refused.data.conflict![0]!;
      expect(row).toMatchObject({
        id: draft.id,
        lock: { by: "owner", lockId: lock.id, holderUserId: owner.id },
      });
      expect(refused.next?.afterMs).toBeGreaterThan(0);
      expect((await liveOf(draft.id))._status).toBe("draft");
      expect(
        await execute("document.lock_takeover", {
          type: "catalog",
          id: draft.id,
          expected: {
            lockId: row.lock!.lockId,
            holderUserId: row.lock!.holderUserId,
            lastEditedAt: row.lock!.lastEditedAt,
          },
          reason: "Synthetic takeover",
        }),
      ).toMatchObject({ ok: true });
      // The same requestId: the refusal above left no receipt.
      expect(
        await call({
          requestId: id,
          op: "editorial.release-catalog-delivery",
          input,
        }),
      ).toMatchObject({ ok: true });
      expect((await liveOf(draft.id))._status).toBe("published");
    });
  });

  it("answers OUTCOME_UNKNOWN to a release whose COMMIT failed, and the same requestId publishes once", async () => {
    const draft = await seedDraftWithMedia();
    await withOperator(proofRoutes({ ready: true }), async () => {
      const intent = await requested(draft);
      const id = requestId();
      const input = releaseInput(intent, draft);
      const lost = await withCommitFailureOn("catalog_delivery_receipts", () =>
        call({
          requestId: id,
          op: "editorial.release-catalog-delivery",
          input,
        }),
      );
      expect(lost).toMatchObject({
        ok: false,
        code: "OUTCOME_UNKNOWN",
        retryable: true,
      });
      expect((await liveOf(draft.id))._status).toBe("draft");
      const done = await call({
        requestId: id,
        op: "editorial.release-catalog-delivery",
        input,
      });
      expect(done).toMatchObject({
        ok: true,
        data: { applied: [expect.anything()] },
      });
      const { revision } = await draftOf(draft.id);
      expect(
        await call({
          requestId: id,
          op: "editorial.release-catalog-delivery",
          input,
        }),
      ).toMatchObject({ ok: true, meta: { replayed: true } });
      expect((await draftOf(draft.id)).revision).toBe(revision);
    });
  });

  it("refuses a delivery whose draft moved, and every bad input by name", async () => {
    const draft = await seedDraftWithMedia();
    const marker = `marker-${randomUUID()}`;
    await withOperator(proofRoutes({ ready: true }), async () => {
      expect(
        await execute("editorial.prepare-catalog-delivery", {
          id: draft.id,
          expectedRevision: draft.revision + 1,
          expectedFingerprint: draft.fingerprint,
        }),
      ).toMatchObject({ ok: false, code: "CATALOG_DELIVERY_DRAFT_CHANGED" });
      expect(
        await execute("editorial.prepare-catalog-delivery", {
          id: 3_000_000_000,
          expectedRevision: draft.revision,
          expectedFingerprint: draft.fingerprint,
        }),
      ).toMatchObject({ ok: false, code: "NOT_FOUND" });
      const intent = await requested(draft);
      const saved = await saveDraft(await reqFor(owner), {
        id: draft.id,
        expectedRevision: draft.revision,
        idempotencyKey: `${run}:moved:${draft.id}`,
        content: {
          ...syntheticCatalogDraft(draft.catalogId, draft.sourceId),
          media: [draft.mediaRow],
          title: "Moved after the request",
        },
      });
      expect(saved.revision).toBe(draft.revision + 1);
      expect(
        await execute(
          "editorial.release-catalog-delivery",
          releaseInput(intent, draft),
        ),
      ).toMatchObject({ ok: false, code: "CATALOG_DELIVERY_STATE_CONFLICT" });
      expect((await liveOf(draft.id))._status).toBe("draft");

      for (const answer of [
        await read("editorial.read-catalog-delivery", { intentId: marker }),
        await execute("editorial.release-catalog-delivery", {
          ...releaseInput(intent, draft),
          intentId: marker,
        }),
        await execute("editorial.cancel-catalog-delivery", {
          intentId: intent.intentId,
          expectedStateVersion: 1,
          idempotencyKey: marker,
        }),
        await read("editorial.catalog-render-backlog", { [marker]: 1 }),
      ]) {
        expect(answer).toMatchObject({ ok: false, code: "INPUT_INVALID" });
        expect(JSON.stringify(answer)).not.toContain(marker);
      }
      expect(
        await read("editorial.read-catalog-delivery", {
          intentId: randomUUID(),
        }),
      ).toMatchObject({ ok: false, code: "NOT_FOUND" });
    });
  });
});
