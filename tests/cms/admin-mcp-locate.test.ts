import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  createBackendApplication,
  createBackendServer,
  startServer,
  stopServer,
} from "@moya/backend-runtime";
import { MappedStorageUrlResolver } from "@moya/image";
import {
  ADMIN_FIND_SKIP_MAX,
  ADMIN_MCP_TEXT_CAP_BYTES,
  ADMIN_MCP_TOKEN_BUDGET,
  ADMIN_VIEW_MEDIA_MAX_BYTES,
  adminFindDataSchema,
  adminGetDataSchema,
  adminMcpEnvelopeSchema,
  adminReadCountDataSchema,
  adminReadRowsDataSchema,
  adminViewMediaDataSchema,
  type AdminMcpEnvelope,
} from "@moya/contracts/internal/admin-mcp";
import { editorialSaveDraftSchema } from "@moya/contracts/internal/editorial";
import { sql, type PostgresAdapter } from "@payloadcms/db-postgres";
import {
  createLocalReq,
  getPayload,
  type Payload,
  type TypedUser,
} from "payload";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { saveDraft } from "admin/editorial";
import { textHash, withinBudget } from "admin/admin-mcp";

import { InMemoryCommunityCommentPort } from "../unit/backend/community-comment-fixture.js";
import { InMemoryCommunityIdentityPort } from "../unit/backend/community-identity-fixture.js";
import {
  connectClient,
  serveRoutes,
  syntheticCatalogDraft,
} from "./admin-mcp-wire.js";

// Behavior Matrix rows on locating and reading, driven as real JSON-RPC over a real
// socket with the official client, which validates each result against the schema
// tools/list advertised and throws where they disagree: "admin_find with an id, URL,
// @handle", "admin_find with free text", "Catalog missing transcription", "admin_get
// with no view", "Draft preview, structured", "Text result over the size cap",
// "admin_view_media result", "Catalog thumbnails and master ops with the community
// token absent", "Community tools before the policy is live".

if (process.env.CMS_ENVIRONMENT !== "synthetic")
  throw new Error("SYNTHETIC_CMS_TARGET_REQUIRED");

const run = randomUUID().replaceAll("-", "");
const email = (name: string) => `locate-${name}-${run}@example.invalid`;
const password = randomBytes(24).toString("hex");
const hex32 = (digit: string) => digit.repeat(32);
const dynastyA = `朝代甲${run}`;
const dynastyB = `朝代乙${run}`;

let payload: Payload;
let server: Awaited<ReturnType<typeof serveRoutes>>;
let owner: TypedUser;
let aiOperator: TypedUser;
const secrets: Record<string, string> = {};
const clients: Record<string, Client> = {};

const db = () =>
  (payload.db as unknown as Pick<PostgresAdapter, "drizzle">).drizzle;

const makeKey = async (name: string, toolProfile: string) => {
  const secret = randomBytes(32).toString("hex");
  await payload.create({
    collection: "payload-mcp-api-keys",
    overrideAccess: true,
    data: {
      user: aiOperator.id,
      label: `synthetic-locate-${name}`,
      enableAPIKey: true,
      apiKey: secret,
      toolProfile,
    } as never,
  });
  secrets[name] = secret;
};

const ownerReq = () => createLocalReq({ user: owner }, payload);

const saveCatalog = async (
  suffix: string,
  content: Record<string, unknown> = {},
) =>
  saveDraft(await ownerReq(), {
    idempotencyKey: `${run}:${suffix}`,
    content: {
      ...syntheticCatalogDraft(
        `locate-${run}-${suffix}`,
        `source-${run}-${suffix}`,
      ),
      ...content,
    },
  });

const publish = async (id: number, revision: number) =>
  payload.update({
    collection: "catalogs",
    id,
    data: { revision, _status: "published" },
    req: await ownerReq(),
    user: owner,
    overrideAccess: false,
    overrideLock: false,
  });

const editDraft = async (
  suffix: string,
  id: number,
  expectedRevision: number,
  content: Record<string, unknown>,
) =>
  saveDraft(await ownerReq(), {
    id,
    expectedRevision,
    idempotencyKey: `${run}:${suffix}`,
    content: {
      catalogId: `locate-${run}-${suffix.split(":")[0]}`,
      sourceId: `source-${run}-${suffix.split(":")[0]}`,
      kind: "calligraphy",
      ...content,
    },
  });

const asEnvelope = (result: Awaited<ReturnType<Client["callTool"]>>) => {
  const text = (result.content as { type: string; text: string }[])[0]!.text;
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(ADMIN_MCP_TEXT_CAP_BYTES);
  const envelope = adminMcpEnvelopeSchema.parse(JSON.parse(text));
  return { envelope, text };
};

const call = async (
  tool: string,
  args: Record<string, unknown>,
  key = "full",
): Promise<AdminMcpEnvelope> => {
  const result = await clients[key]!.callTool({ name: tool, arguments: args });
  const { envelope } = asEnvelope(result);
  // The JSON travels in both places, and isError exactly when ok is false.
  expect(result.structuredContent).toEqual(envelope);
  expect(result.isError === true).toBe(!envelope.ok);
  return envelope;
};

/** Follows `next` to the end: what a client does with a cut or paged answer. */
const followAll = async (
  tool: string,
  args: Record<string, unknown>,
): Promise<AdminMcpEnvelope[]> => {
  const pages: AdminMcpEnvelope[] = [];
  let current: { tool: string; args: Record<string, unknown> } | undefined = {
    tool,
    args,
  };
  while (current !== undefined) {
    const envelope = await call(current.tool, current.args);
    expect(envelope.ok).toBe(true);
    pages.push(envelope);
    current = envelope.next;
    expect(pages.length).toBeLessThan(500);
  }
  return pages;
};

const findData = (envelope: AdminMcpEnvelope) =>
  adminFindDataSchema.parse(envelope.data);
const getData = (envelope: AdminMcpEnvelope) =>
  adminGetDataSchema.parse(envelope.data) as Record<string, unknown> &
    ReturnType<typeof adminGetDataSchema.parse>;

beforeAll(async () => {
  const config = await (await import("admin/config")).default;
  payload = await getPayload({ config });
  const account = async (name: string, role: "owner" | "automation") => ({
    ...(await payload.create({
      collection: "users",
      overrideAccess: true,
      data: { email: email(name), password, role, scopeCatalogIds: [] },
    })),
    collection: "users" as const,
  });
  owner = await account("owner", "owner");
  const automation = await account("ai", "automation");
  aiOperator = {
    ...(await payload.update({
      collection: "users",
      id: automation.id,
      overrideAccess: true,
      data: { role: "ai_operator" },
    })),
    collection: "users",
  };
  await makeKey("read", "read");
  await makeKey("full", "full");
  server = await serveRoutes(config);
  for (const name of ["read", "full"])
    clients[name] = (
      await connectClient(server.endpoint, {
        authorization: `Bearer ${secrets[name]}`,
      })
    ).client;
});

afterAll(async () => {
  await Promise.all(Object.values(clients).map((client) => client.close()));
  await server?.close();
  await payload?.db?.destroy?.();
});

describe("tools/list and the size budgets, over the wire", () => {
  it.each(["read", "full"])("keeps %s within its token budget", async (key) => {
    const { tools } = await clients[key]!.listTools();
    const names = tools.map(({ name }) => name);
    for (const name of [
      "admin_find",
      "admin_get",
      "admin_read",
      "admin_view_media",
    ])
      expect(names).toContain(name);
    expect(Buffer.byteLength(JSON.stringify(tools)) / 3).toBeLessThanOrEqual(
      ADMIN_MCP_TOKEN_BUDGET,
    );
    for (const tool of tools) {
      expect(tool.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      // Matrix "admin_view_media result": the one exception, by name.
      if (tool.name === "admin_view_media")
        expect(tool.outputSchema).toBeUndefined();
      else expect(tool.outputSchema?.type).toBe("object");
    }
  });

  it("names every read op on admin_read, so a valid name costs no round trip", async () => {
    const { tools } = await clients.read!.listTools();
    const read = tools.find(({ name }) => name === "admin_read")!;
    const op = (
      read.inputSchema.properties as Record<string, { enum?: string[] }>
    ).op!;
    expect(op.enum).toContain("list.catalogs");
    expect(op.enum).not.toContain("catalog.publish");
  });

  it("keeps the admin_actions index within budget, and shows what is built", async () => {
    const result = await clients.full!.callTool({ name: "admin_actions" });
    const { envelope, text } = asEnvelope(result);
    expect(Buffer.byteLength(text) / 3).toBeLessThanOrEqual(
      ADMIN_MCP_TOKEN_BUDGET,
    );
    const { groups } = envelope.data as {
      groups: {
        tool: string;
        ops: string[];
        unavailable?: Record<string, string[]>;
      }[];
    };
    const read = groups.find(({ tool }) => tool === "admin_read")!;
    expect(read.ops.join(" ")).toContain("list.catalogs");
    expect(read.unavailable?.not_available?.join(" ")).toContain("list.works");
  });
});

describe("Catalog missing transcription", () => {
  const ids: Record<string, number> = {};
  const expected = {
    // Both absent states count.
    a1: { transcription: { state: "UNSUPPLIED" } },
    a2: { transcription: { state: "CLEAR" } },
    a3: { transcription: { state: "UNSUPPLIED" } },
  };

  beforeAll(async () => {
    for (const [suffix, content] of Object.entries(expected))
      ids[suffix] = (
        await saveCatalog(`missing-${suffix}`, {
          ...content,
          dynasty: { state: "VALUE", value: dynastyA },
        })
      ).id;
    ids.b1 = (
      await saveCatalog("missing-b1", {
        transcription: { state: "UNSUPPLIED" },
        dynasty: { state: "VALUE", value: dynastyB },
      })
    ).id;
    // No dynasty: the count below keeps it in a row of its own.
    await saveCatalog("missing-no-dynasty", {
      transcription: { state: "UNSUPPLIED" },
      dynasty: { state: "UNSUPPLIED" },
    });
    // Has its text: not missing.
    ids.present = (
      await saveCatalog("missing-present", {
        transcription: { state: "VALUE", value: `释文canary${run}` },
        dynasty: { state: "VALUE", value: dynastyA },
      })
    ).id;
    // Published and missing: not a draft.
    const published = await saveCatalog("missing-published", {
      transcription: { state: "UNSUPPLIED" },
      dynasty: { state: "VALUE", value: dynastyA },
    });
    ids.published = published.id;
    await publish(published.id, published.revision);
  });

  it("answers matching drafts only, as compact rows with no extra read per row", async () => {
    const pages = await followAll("admin_read", {
      op: "list.catalogs",
      input: { filter: { missing: ["transcription"], dynasty: dynastyA } },
      pageSize: 2,
    });
    expect(pages.length).toBeGreaterThan(1);
    const rows = pages.flatMap(
      (page) => adminReadRowsDataSchema.parse(page.data).rows,
    );
    expect(rows.map(({ id }) => id).sort()).toEqual(
      [ids.a1, ids.a2, ids.a3].sort(),
    );
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(
        ["catalogId", "id", "state", "title", "updatedAt", "version"].sort(),
      );
      expect(row.state).toBe("draft");
    }
    expect(adminReadRowsDataSchema.parse(pages[0]!.data).filter).toEqual({
      status: "draft",
      missing: ["transcription"],
      dynasty: dynastyA,
    });
  });

  it("counts by dynasty in SQL, sending no rows to the model", async () => {
    const pages = await followAll("admin_read", {
      op: "list.catalogs",
      view: "count",
      groupBy: "dynasty",
      input: { filter: { missing: ["transcription"] } },
    });
    const parsed = pages.map((page) =>
      adminReadCountDataSchema.parse(page.data),
    );
    expect(pages[0]!.data).not.toHaveProperty("rows");
    const groups = parsed.flatMap(({ groups: page }) => page ?? []);
    expect(groups.find(({ value }) => value === dynastyA)).toEqual({
      value: dynastyA,
      state: "VALUE",
      count: 3,
    });
    expect(groups.find(({ value }) => value === dynastyB)?.count).toBe(1);
    // Unsupplied keeps its own row: it never reads as a dynasty, or as zero.
    expect(
      groups.find(({ state }) => state === "UNSUPPLIED")?.value,
    ).toBeNull();
    expect(parsed[0]!.total).toBe(
      groups.reduce((sum, { count }) => sum + count, 0),
    );
  });

  it("gives the same answer through both translations of each filter", async () => {
    const filters: Record<string, unknown>[] = [
      { status: "all", dynasty: dynastyA },
      { status: "published", dynasty: dynastyA },
      { status: "draft", dynasty: dynastyA, kind: "calligraphy" },
      { status: "draft", dynasty: dynastyA, kind: "inscription" },
      { missing: ["transcription"], dynasty: dynastyB },
      { missing: ["transcription", "description"], dynasty: dynastyA },
      { missing: ["periodLabel"], dynasty: dynastyA },
      { missing: ["title"], dynasty: dynastyA },
      { status: "all", dynasty: dynastyA, province: `省${run}` },
    ];
    for (const filter of filters) {
      const rows = (
        await followAll("admin_read", {
          op: "list.catalogs",
          input: { filter },
          pageSize: 100,
        })
      ).flatMap((page) => adminReadRowsDataSchema.parse(page.data).rows);
      const counted = adminReadCountDataSchema.parse(
        (
          await call("admin_read", {
            op: "list.catalogs",
            view: "count",
            input: { filter },
          })
        ).data,
      );
      expect({ filter, total: counted.total }).toEqual({
        filter,
        total: rows.length,
      });
    }
  });

  it("projects a whitelist, and long text only ever by state, length and hash", async () => {
    const envelope = await call("admin_read", {
      op: "list.catalogs",
      input: { filter: { dynasty: dynastyA, status: "all" } },
      fields: ["transcription", "dynasty", "mediaCount"],
    });
    const { rows } = adminReadRowsDataSchema.parse(envelope.data);
    const present = rows.find(({ id }) => id === ids.present)!;
    expect(present.transcription).toEqual({
      state: "VALUE",
      length: Array.from(`释文canary${run}`).length,
      hash: textHash(`释文canary${run}`),
    });
    expect(present.dynasty).toEqual({ state: "VALUE", value: dynastyA });
    expect(present.mediaCount).toBe(0);
    expect(JSON.stringify(envelope)).not.toContain(`canary${run}`);
    expect(envelope.untrusted).toContain("/data/rows");
  });

  it("names what it accepts on an unknown field, group or cursor, never the value", async () => {
    const field = await call("admin_read", {
      op: "list.catalogs",
      fields: ["objectKey"],
    });
    expect(field).toMatchObject({ ok: false, code: "INPUT_INVALID" });
    expect(field.issues?.[0]?.allowedKeys).toContain("transcription");
    expect(JSON.stringify(field)).not.toContain("objectKey");
    const group = await call("admin_read", {
      op: "list.catalogs",
      view: "count",
      groupBy: "title",
    });
    expect(group.issues?.[0]?.allowedKeys).toContain("dynasty");
    const cursor = await call("admin_read", {
      op: "list.catalogs",
      cursor: "1; DROP TABLE catalogs",
    });
    expect(cursor).toMatchObject({ ok: false, code: "INPUT_INVALID" });
    const filter = await call("admin_read", {
      op: "list.catalogs",
      input: { filter: { missing: ["not_a_field"] } },
    });
    expect(filter).toMatchObject({ ok: false, code: "INPUT_INVALID" });
    expect(filter.issues?.[0]?.path.slice(0, 2)).toEqual(["input", "filter"]);
  });
});

describe("the other CMS sources", () => {
  it("reads and counts Articles, collections, media, approvals and receipts", async () => {
    for (const op of [
      "list.articles",
      "list.collections",
      "list.media",
      "list.approvals",
      "list.article_approvals",
      "list.receipts",
    ]) {
      const rows = await call("admin_read", { op, pageSize: 3 });
      expect({ op, ok: rows.ok }).toEqual({ op, ok: true });
      adminReadRowsDataSchema.parse(rows.data);
      const counted = await call("admin_read", { op, view: "count" });
      expect({ op, ok: counted.ok }).toEqual({ op, ok: true });
      adminReadCountDataSchema.parse(counted.data);
    }
  });

  it("relays the review page, and gives a key an outline for read-draft", async () => {
    const { id } = await saveCatalog("relay");
    const review = await call("admin_read", {
      op: "list.review_page",
      input: { page: 1, pageSize: 2 },
    });
    expect(review.ok).toBe(true);
    const draft = await call("admin_read", {
      op: "editorial.read-draft",
      input: { id },
    });
    expect(draft.ok).toBe(true);
    expect(getData(draft).readFrom).toBe("draft");
    expect(getData(draft)).toHaveProperty("fields");
  });

  it("goes on from a cut page the route numbers itself, losing no row and repeating none", async () => {
    // Two full pages of its own, so page 2 is cut on an empty database too.
    for (let index = 0; index < 100; index += 1)
      await saveCatalog(`relay-wide-${index}`);
    const idsOf = (envelope: AdminMcpEnvelope) =>
      (envelope.data as { docs: { id: number }[] }).docs.map(({ id }) => id);
    const order: number[] = [];
    for (let page = 1; page <= 25; page += 1) {
      const whole = await call("admin_read", {
        op: "list.review_page",
        input: { page, pageSize: 5 },
      });
      expect(whole.meta.truncated).toBeUndefined();
      order.push(...idsOf(whole));
    }
    for (const op of ["list.review_page", "editorial.owner-drafts"]) {
      for (const page of [1, 2]) {
        const asked = { op, input: { page, pageSize: 50 } };
        const cut = await call("admin_read", asked);
        expect(cut.ok).toBe(true);
        expect(cut.meta.truncated).toBe(true);
        const kept = idsOf(cut);
        expect(kept.length + cut.remaining!).toBe(50);
        expect(cut.next?.tool).toBe("admin_read");
        const after = await call(cut.next!.tool, cut.next!.args);
        expect(after.ok).toBe(true);
        const start = (page - 1) * 50;
        expect([...kept, ...idsOf(after)]).toEqual(
          order.slice(start, start + kept.length + idsOf(after).length),
        );
      }
    }
  });

  it("refuses an argument the op does not read, rather than dropping it", async () => {
    for (const extra of [
      { cursor: "9" },
      { pageSize: 5 },
      { view: "count" },
      { fields: ["kind"] },
      { groupBy: "kind" },
    ]) {
      const envelope = await call("admin_read", {
        op: "list.review_page",
        ...extra,
      });
      expect(envelope).toMatchObject({ ok: false, code: "INPUT_INVALID" });
      expect(envelope.issues).toEqual([
        { path: Object.keys(extra), code: "not_for_this_op" },
      ]);
    }
  });

  it("answers NOT_AVAILABLE on a community read, never an empty page", async () => {
    for (const op of ["list.works", "list.reports", "community.read-users"]) {
      const answer = await call("admin_read", { op });
      expect({ op, code: answer.code }).toEqual({ op, code: "NOT_AVAILABLE" });
      expect(answer).not.toHaveProperty("data");
    }
  });

  it("answers UNKNOWN_OP with near names for a typo, and for a write named here", async () => {
    const typo = await call("admin_read", { op: "list.catalog" });
    expect(typo).toMatchObject({ ok: false, code: "UNKNOWN_OP" });
    expect((typo.data as { nearest: string[] }).nearest).toContain(
      "list.catalogs",
    );
    const write = await call("admin_read", { op: "catalog.publish" });
    expect(write).toMatchObject({ ok: false, code: "UNKNOWN_OP" });
  });
});

describe("admin_find: id, link, sourceId", () => {
  const catalogId = `locate-${run}-exact`;
  const sourceId = `source-${run}-exact`;
  const provenanceId = `provenance-${run}-exact`;
  const mediaId = `media-locate-${run}`;
  let catalogRow: number;
  let articleRow: number;
  let articleId: string;
  let collectionRow: number;
  let collectionId: string;
  let mediaRow: number;

  beforeAll(async () => {
    const saved = await saveCatalog("exact", {
      title: "精确定位",
      dynasty: { state: "VALUE", value: dynastyA },
      province: { state: "VALUE", value: "山东" },
      provenance: [{ sourceId: provenanceId }],
    });
    catalogRow = saved.id;
    const article = await payload.create({
      collection: "articles",
      draft: true,
      overrideAccess: false,
      req: await ownerReq(),
      user: owner,
      data: {
        presentation: "news",
        title: `定位文章${run}`,
        byline: `署名${run}`,
      } as never,
    });
    articleRow = article.id;
    articleId = String(article.articleId);
    const collection = await payload.create({
      collection: "article-collections",
      draft: true,
      overrideAccess: false,
      req: await ownerReq(),
      user: owner,
      data: { title: `定位合集${run}` } as never,
    });
    collectionRow = collection.id;
    collectionId = String(collection.collectionId);
    // Bytes of this run alone: media can share a sha256, and then it is not unique.
    const bytes = await sharp({
      create: {
        width: 40,
        height: 20,
        channels: 3,
        background: `#${run.slice(0, 6)}`,
      },
    })
      .jpeg()
      .toBuffer();
    const media = await payload.create({
      collection: "media",
      overrideAccess: false,
      req: await ownerReq(),
      data: {
        mediaId,
        catalogId,
        alt: `定位图片${run}`,
        origin: "upload",
      } as never,
      file: {
        name: "synthetic.jpg",
        data: bytes,
        mimetype: "image/jpeg",
        size: bytes.length,
      },
    });
    mediaRow = media.id;
  });

  const exactOf = async (query: string, type?: string) => {
    const envelope = await call("admin_find", {
      query,
      ...(type === undefined ? {} : { type }),
    });
    const data = findData(envelope);
    expect({ query, status: data.resolution.status }).toEqual({
      query,
      status: "exact",
    });
    expect(data.resolution.uniqueIdentity).toBe(true);
    expect(data.items).toHaveLength(1);
    const [item] = data.items;
    expect(item!.match.kind).toBe("identity");
    expect(item!.adminPath).toMatch(/^\/admin\/collections\//u);
    expect(JSON.stringify(item)).not.toMatch(/https?:\/\//u);
    expect(item!.actions?.length).toBeGreaterThan(0);
    return { data, item: item!, envelope };
  };

  it.each([
    ["a bare catalogId", () => catalogId, "catalogId"],
    ["a public path", () => `/catalog/${catalogId}`, "catalogId"],
    [
      "a full link, whatever its domain",
      () => `https://any-host.example/catalog/${catalogId}`,
      "catalogId",
    ],
    [
      "a catalogId parameter",
      () => `/?catalogId=${catalogId}#detail`,
      "catalogId",
    ],
    ["a bare sourceId", () => sourceId, "sourceId"],
    ["a sourceId in provenance", () => provenanceId, "provenance.sourceId"],
  ])("resolves %s to the one Catalog", async (_name, query, field) => {
    const { data, item } = await exactOf(query());
    expect(data.resolution.ref).toEqual({ type: "catalog", id: catalogRow });
    expect(item.match.field).toBe(field);
    expect(item.disambiguators).toMatchObject({
      catalogId,
      sourceId,
      kind: "calligraphy",
      dynasty: dynastyA,
      province: "山东",
      mediaCount: 0,
    });
    expect(item.state).toBe("draft");
    expect(item.lock).toEqual({ held: false });
  });

  it("resolves an Admin path, with op skeletons that are prefilled and callable", async () => {
    const { data, item } = await exactOf(
      `/admin/collections/catalogs/${catalogRow}`,
    );
    expect(data.resolution.ref).toEqual({ type: "catalog", id: catalogRow });
    expect(item.adminPath).toBe(`/admin/collections/catalogs/${catalogRow}`);
    const listed = (await clients.full!.listTools()).tools.map(
      ({ name }) => name,
    );
    for (const action of item.actions!) {
      expect(listed).toContain(action.tool);
      const answer = await call(action.tool, action.args);
      expect({ action, ok: answer.ok }).toEqual({ action, ok: true });
    }
  });

  it("resolves an Article link through ?articleId=", async () => {
    const { data, item, envelope } = await exactOf(
      `https://elsewhere.example/?articleId=${articleId}`,
    );
    expect(data.resolution.ref).toEqual({ type: "article", id: articleRow });
    expect(item.match.field).toBe("articleId");
    expect(item.disambiguators).toMatchObject({ articleId });
    // Settled in the CMS, so the community side is not named as unanswered.
    expect(envelope.meta.partial).toBeUndefined();
    expect(envelope.meta.sources).toEqual({ articles: "ok" });
    expect((await exactOf(articleId)).data.resolution.ref).toEqual({
      type: "article",
      id: articleRow,
    });
  });

  it("names the community side when an Article link misses in the CMS", async () => {
    const envelope = await call("admin_find", {
      query: `/?articleId=article-${hex32("e")}`,
    });
    expect(findData(envelope).resolution.status).toBe("none");
    expect(envelope.meta).toMatchObject({
      partial: true,
      sources: { articles: "ok", article_documents: "not_available" },
    });
  });

  it("resolves a collection id, a media id and an image link", async () => {
    expect((await exactOf(collectionId)).data.resolution.ref).toEqual({
      type: "collection",
      id: collectionRow,
    });
    expect((await exactOf(mediaId)).data.resolution.ref).toEqual({
      type: "media",
      id: mediaRow,
    });
    expect(
      (await exactOf(`/admin/collections/media/${mediaRow}`)).item.match.field,
    ).toBe("id");
    const viewer = await exactOf(
      `/?catalogId=${catalogId}&image=${mediaId}#viewer`,
    );
    expect(viewer.data.resolution.ref).toEqual({
      type: "catalog",
      id: catalogRow,
    });
    expect(viewer.data.focus).toEqual({ mediaId });
    const alone = await exactOf(`/?image=${mediaId}`);
    expect(alone.data.resolution.ref).toEqual({ type: "media", id: mediaRow });
    const sha = await payload.findByID({ collection: "media", id: mediaRow });
    expect((await exactOf(String(sha.sha256))).data.resolution.ref).toEqual({
      type: "media",
      id: mediaRow,
    });
  });

  it("pages every record sharing one sha256, past any one page of them", async () => {
    const bytes = await sharp({
      create: {
        width: 41,
        height: 21,
        channels: 3,
        background: `#${run.slice(6, 12)}`,
      },
    })
      .jpeg()
      .toBuffer();
    const saved = new Set<number>();
    let sha256: unknown;
    for (let index = 0; index < 27; index += 1) {
      const media = await payload.create({
        collection: "media",
        overrideAccess: false,
        req: await ownerReq(),
        data: {
          mediaId: `media-shared-${run}-${index}`,
          catalogId,
          alt: `共用图片${run}`,
          origin: "upload",
        } as never,
        file: {
          name: "synthetic.jpg",
          data: bytes,
          mimetype: "image/jpeg",
          size: bytes.length,
        },
      });
      saved.add(media.id);
      sha256 = media.sha256;
    }
    const pages = await followAll("admin_find", { query: String(sha256) });
    const seen = pages.flatMap((page) =>
      findData(page).items.map(({ id }) => id),
    );
    expect(seen).toHaveLength(saved.size);
    expect(new Set(seen)).toEqual(saved);
  });

  it("resolves a row id when told the family, and never guesses across families", async () => {
    expect(
      (await exactOf(String(catalogRow), "catalog")).data.resolution.ref,
    ).toEqual({ type: "catalog", id: catalogRow });
    // Each family numbers its own rows, so a bare number can name several.
    const { rows } = await db().execute(
      sql`SELECT c.id FROM catalogs c JOIN articles a ON a.id = c.id LIMIT 1`,
    );
    const shared = rows[0]!.id as number;
    const bare = findData(await call("admin_find", { query: String(shared) }));
    expect(bare.items.length).toBeGreaterThan(1);
    expect(bare.resolution).toEqual({
      status: "candidates",
      uniqueIdentity: false,
    });
  });

  it("reads an impossible row id as a miss, not a failure", async () => {
    const envelope = await call("admin_find", {
      query: "/admin/collections/catalogs/3000000000",
    });
    expect(findData(envelope).resolution.status).toBe("none");
    const bare = await call("admin_find", { query: "9007199254740991" });
    expect(findData(bare).resolution.status).toBe("none");
  });

  it("reports community references as not_available, never as nothing there", async () => {
    for (const [query, source] of [
      [`user-${hex32("a")}`, "users"],
      [`work-${hex32("a")}`, "works"],
      [`comment-${hex32("a")}`, "comments"],
      [`thread-${hex32("a")}`, "threads"],
      [`report-${hex32("a")}`, "reports"],
      [`publishing-job-${hex32("a")}`, "publishing_jobs"],
      [`work-revision-${hex32("a")}`, "work_revisions"],
      [`media-item-${hex32("a")}`, "media_items"],
      [`invitation-${hex32("a")}`, "invitations"],
      [`feedback-${hex32("a")}`, "feedback"],
      [`article-${hex32("a")}`, "article_documents"],
      ["@lishu_test", "users"],
      [`/?workId=work-${hex32("a")}`, "works"],
      [`https://x.example/?authorId=user-${hex32("a")}#profile`, "users"],
      [`/?topic=${hex32("a")}`, "threads"],
      [`/#topic-${hex32("a")}`, "threads"],
    ] as const) {
      const envelope = await call("admin_find", { query });
      expect({ query, data: findData(envelope).resolution }).toEqual({
        query,
        data: { status: "none", uniqueIdentity: false },
      });
      expect(envelope.meta.partial).toBe(true);
      expect(envelope.meta.sources?.[source]).toBe("not_available");
    }
  });

  it("does not call a link with an unanswered part unique", async () => {
    const data = findData(
      await call("admin_find", {
        query: `/?catalogId=${catalogId}&workId=work-${hex32("b")}`,
      }),
    );
    expect(data.resolution).toEqual({
      status: "candidates",
      uniqueIdentity: false,
    });
    expect(data.items[0]!.actions).toEqual([
      { tool: "admin_get", args: { type: "catalog", id: catalogRow } },
    ]);
  });

  it("never searches direct messages or a private draft id", async () => {
    for (const [query, category] of [
      [`dm-${hex32("a")}`, "dm"],
      [`dmsg-${hex32("a")}`, "dm"],
      [`/?draftId=work-draft-${hex32("a")}`, "private_draft"],
      [`work-draft-${hex32("a")}`, "private_draft"],
    ] as const) {
      const envelope = await call("admin_find", { query });
      expect(findData(envelope).resolution.status).toBe("none");
      expect(envelope.meta.excluded).toEqual([category]);
      expect(envelope.meta.sources).toEqual({});
    }
  });

  it("narrows to the family asked for", async () => {
    const data = findData(
      await call("admin_find", { query: catalogId, type: "media" }),
    );
    expect(data.resolution.status).toBe("none");
    const work = await call("admin_find", {
      query: `work-${hex32("a")}`,
      type: "work",
    });
    expect(work.meta.sources).toEqual({ works: "not_available" });
  });

  it("is on the read profile too", async () => {
    const envelope = await call("admin_find", { query: catalogId }, "read");
    expect(findData(envelope).resolution.status).toBe("exact");
  });
});

describe("admin_find: free text", () => {
  const traditional = `蘭亭集序${run}`;
  const simplified = `兰亭集序${run}`;
  let publishedRow: number;
  let draftRow: number;

  beforeAll(async () => {
    const saved = await saveCatalog("text-published", {
      title: traditional,
      aliases: [{ alias: `別名${run}`, aliasType: "alternate" }],
    });
    publishedRow = saved.id;
    await publish(saved.id, saved.revision);
    draftRow = (
      await saveCatalog("text-draft", {
        title: `草稿题名${run}`,
      })
    ).id;
  });

  it("never yields a unique identity from a t2s hit, even when it is the only hit", async () => {
    const envelope = await call("admin_find", {
      query: simplified,
      type: "catalog",
    });
    const data = findData(envelope);
    expect(data.items.map(({ id }) => id)).toEqual([publishedRow]);
    expect(data.items[0]!.match.kind).toBe("t2s");
    expect(data.resolution).toEqual({
      status: "candidates",
      uniqueIdentity: false,
    });
    expect(data.resolution).not.toHaveProperty("ref");
  });

  it("never yields one from a raw title hit either: only identity fields can", async () => {
    const data = findData(
      await call("admin_find", { query: traditional, type: "catalog" }),
    );
    expect(data.items.map(({ id }) => id)).toEqual([publishedRow]);
    expect(data.items[0]!.match).toMatchObject({ field: "title", kind: "raw" });
    expect(data.resolution.status).toBe("candidates");
    expect(data.resolution.uniqueIdentity).toBe(false);
    const alias = findData(
      await call("admin_find", { query: `別名${run}`, type: "catalog" }),
    );
    expect(alias.items[0]!.match).toMatchObject({
      field: "aliases",
      kind: "raw",
    });
    expect(alias.resolution.uniqueIdentity).toBe(false);
  });

  it("finds a close spelling by trigram only when nothing contains the words, and says so", async () => {
    const title = `Inscription of Mount Tai ${run}`;
    const saved = await saveCatalog("text-trigram", { title });
    await publish(saved.id, saved.revision);
    const typed = title.replace("Mount", "Munt");
    const data = findData(
      await call("admin_find", { query: typed, type: "catalog" }),
    );
    const hit = data.items.find(({ id }) => id === saved.id);
    expect(hit?.match.kind).toBe("trigram");
    expect(data.resolution.uniqueIdentity).toBe(false);
  });

  it("finds a draft by its title, with only an admin_get action and no adminPath", async () => {
    const data = findData(
      await call("admin_find", { query: `草稿题名${run}` }),
    );
    expect(data.items.map(({ id }) => id)).toEqual([draftRow]);
    for (const item of data.items) {
      expect(item.match.kind).toBe("raw");
      expect(item.adminPath).toBeUndefined();
      expect(item.actions).toEqual([
        { tool: "admin_get", args: { type: item.type, id: item.id } },
      ]);
    }
    expect(data.resolution.status).toBe("candidates");
  });

  it("carries no mutation skeleton on any candidate, on any family", async () => {
    const shared = `共同词${run}`;
    await saveCatalog("text-shared", { title: `${shared}甲` });
    await payload.create({
      collection: "articles",
      draft: true,
      overrideAccess: false,
      req: await ownerReq(),
      user: owner,
      data: {
        presentation: "news",
        title: `${shared}乙`,
        byline: "署名",
      } as never,
    });
    await payload.create({
      collection: "article-collections",
      draft: true,
      overrideAccess: false,
      req: await ownerReq(),
      user: owner,
      data: { title: `${shared}丙` } as never,
    });
    const envelope = await call("admin_find", { query: shared });
    const data = findData(envelope);
    expect(data.items.map(({ type }) => type).sort()).toEqual(
      ["article", "catalog", "collection"].sort(),
    );
    expect(data.resolution).toEqual({
      status: "candidates",
      uniqueIdentity: false,
    });
    for (const item of data.items)
      expect(item.actions).toEqual([
        { tool: "admin_get", args: { type: item.type, id: item.id } },
      ]);
    expect(envelope.untrusted).toContain("/data/items/*/title");
  });

  it("pages every candidate through next, and never stops short with no word of it", async () => {
    const shared = `翻页词${run}`;
    const saved = new Set<number>();
    for (let index = 0; index < 34; index += 1)
      saved.add(
        (
          await saveCatalog(`text-page-${index}`, {
            title: `${shared}${index}`,
          })
        ).id,
      );
    const pages = await followAll("admin_find", {
      query: shared,
      type: "catalog",
    });
    const seen = pages.flatMap((page) =>
      findData(page).items.map(({ id }) => id),
    );
    expect(seen).toHaveLength(saved.size);
    expect(new Set(seen)).toEqual(saved);
  });

  it("says so where paging stops, and every next it offers is a call it accepts", async () => {
    const shared = `尽头词${run}`;
    const beyond = ADMIN_FIND_SKIP_MAX + 2;
    for (let index = 0; index < beyond; index += 1)
      await saveCatalog(`text-end-${index}`, { title: `${shared}${index}` });
    const asked = { query: shared, type: "catalog", limit: 1 };
    const last = await call("admin_find", {
      ...asked,
      skip: ADMIN_FIND_SKIP_MAX - 1,
    });
    expect(last.next?.args).toEqual({ ...asked, skip: ADMIN_FIND_SKIP_MAX });
    const stopped = await call("admin_find", last.next!.args);
    expect(stopped.ok).toBe(true);
    expect(findData(stopped).items).toHaveLength(1);
    expect(stopped.next).toBeUndefined();
    expect(stopped.meta.truncated).toBe(true);
    expect(stopped.hint).toMatch(/cannot continue/u);
    expect(
      await call("admin_find", { ...asked, skip: ADMIN_FIND_SKIP_MAX + 1 }),
    ).toMatchObject({ ok: false, code: "INPUT_INVALID" });
  });

  it("names each branch, and the community branches as not_available", async () => {
    const envelope = await call("admin_find", { query: `草稿题名${run}` });
    expect(envelope.meta.partial).toBe(true);
    expect(envelope.meta.sources).toEqual({
      // The exact lookups ran first, on what has an identity.
      catalogs: "ok",
      catalogs_published: "ok",
      catalogs_draft: "ok",
      articles: "ok",
      collections: "ok",
      media: "ok",
      users: "not_available",
      works: "not_available",
      comments: "not_available",
      threads: "not_available",
      reports: "not_available",
    });
  });

  it("answers none with every branch named when nothing matches", async () => {
    const envelope = await call("admin_find", {
      query: `查无此物 ${randomUUID()}`,
      type: "catalog",
    });
    expect(findData(envelope).resolution.status).toBe("none");
    expect(envelope.meta.sources).toEqual({
      catalogs_published: "ok",
      catalogs_draft: "ok",
      catalogs_similar: "ok",
    });
    expect(envelope.meta.partial).toBeUndefined();
  });

  it("names a branch that ran out of its budget, and never reads it as zero", async () => {
    const shared = `共同词${run}`;
    // A table lock holds the Articles branch past its statement timeout.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = db().transaction(async (tx) => {
      await tx.execute(sql`LOCK TABLE "_articles_v" IN ACCESS EXCLUSIVE MODE`);
      locked();
      await held;
    });
    await lockTaken;
    try {
      const started = performance.now();
      const envelope = await call("admin_find", { query: shared });
      const elapsed = performance.now() - started;
      expect(envelope.meta.sources?.articles).toBe("timed_out");
      expect(envelope.meta.partial).toBe(true);
      expect(envelope.meta.sources?.catalogs_draft).toBe("ok");
      expect(findData(envelope).items.map(({ type }) => type)).toContain(
        "catalog",
      );
      expect(findData(envelope).items.map(({ type }) => type)).not.toContain(
        "article",
      );
      expect(elapsed).toBeGreaterThanOrEqual(1_900);
      expect(elapsed).toBeLessThan(15_000);
    } finally {
      release();
      await holder;
    }
  });
});

describe("a search branch's budget", () => {
  it("runs read only, so a branch cannot write however it is written", async () => {
    const req = await createLocalReq({ user: aiOperator }, payload);
    const answer = await withinBudget(req, (_branch, branchDb) =>
      branchDb.execute(sql`UPDATE mcp_control SET threshold = threshold`),
    );
    expect(answer).toEqual({ status: "failed" });
    expect(
      await withinBudget(req, (_branch, branchDb) =>
        branchDb.execute(sql`SELECT 1 AS one`),
      ),
    ).toMatchObject({ status: "ok" });
  });

  it("stops a statement past its time, and leaves the connection usable", async () => {
    const req = await createLocalReq({ user: aiOperator }, payload);
    expect(
      await withinBudget(req, (_branch, branchDb) =>
        branchDb.execute(sql`SELECT pg_sleep(5)`),
      ),
    ).toEqual({ status: "timed_out" });
    const { rows } = await db().execute(sql`SELECT 1 AS one`);
    expect(rows[0]!.one).toBe(1);
  });
});

describe("the lock block", () => {
  const lockOn = async (id: number) =>
    payload.create({
      collection: "payload-locked-documents",
      overrideAccess: true,
      data: {
        document: { relationTo: "catalogs", value: id },
        user: { relationTo: "users", value: owner.id },
      },
    });

  it("says who holds a document and until when, on find and get", async () => {
    const { id } = await saveCatalog("locked");
    const row = await lockOn(id);
    const found = findData(
      await call("admin_find", { query: `locate-${run}-locked` }),
    ).items[0]!;
    expect(found.lock).toMatchObject({ held: true, by: "owner" });
    expect(
      Date.parse(found.lock!.expiresAt!) -
        Date.parse(found.lock!.lastEditedAt!),
    ).toBe(300_000);
    const got = getData(await call("admin_get", { type: "catalog", id }));
    expect(got.lock).toMatchObject({ held: true, by: "owner" });
    // Past its time a lock does not hold, as Payload's own check reads it.
    await db().execute(
      sql`UPDATE payload_locked_documents SET updated_at = now() - interval '301 seconds' WHERE id = ${row.id}`,
    );
    expect(
      getData(await call("admin_get", { type: "catalog", id })).lock,
    ).toEqual({ held: false });
  });
});

describe("admin_get", () => {
  const longText = `${"𠮷".repeat(2_500)}中段文字${"𠀀a".repeat(2_500)}`;
  let id: number;
  let revision: number;
  const suffix = "get";

  beforeAll(async () => {
    const saved = await saveCatalog(suffix, {
      title: "读取测试",
      transcription: { state: "VALUE", value: longText },
      description: { state: "VALUE", value: "短简介" },
    });
    ({ id, revision } = saved);
  });

  it("defaults to an outline: state, length, hash, which version, and no long text", async () => {
    const envelope = await call("admin_get", { type: "catalog", id });
    const data = getData(envelope);
    expect(data).toMatchObject({
      view: "outline",
      readFrom: "draft",
      state: "draft",
      revision,
      publishedRevision: null,
      hasUnpublishedChanges: true,
      lengthUnit: "codePoint",
    });
    expect(data.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    const fields = data.fields as {
      name: string;
      state: string;
      length?: number;
      hash?: string;
      value?: unknown;
    }[];
    const transcription = fields.find(({ name }) => name === "transcription")!;
    expect(transcription).toEqual({
      name: "transcription",
      state: "VALUE",
      length: Array.from(longText).length,
      hash: textHash(longText),
    });
    expect(fields.find(({ name }) => name === "historicalContext")).toEqual({
      name: "historicalContext",
      state: "UNSUPPLIED",
    });
    expect(fields.find(({ name }) => name === "catalogId")?.value).toBe(
      `locate-${run}-${suffix}`,
    );
    expect(JSON.stringify(envelope)).not.toContain("中段文字");
    expect(data.deepZoom).toBe("not_available");
  });

  it("accepts the public identity as a string, and row id as a number", async () => {
    const byIdentity = getData(
      await call("admin_get", {
        type: "catalog",
        id: `locate-${run}-${suffix}`,
      }),
    );
    expect(byIdentity.id).toBe(id);
  });

  it("answers NOT_FOUND for a miss, and NOT_AVAILABLE for a community type", async () => {
    for (const missing of [2_147_000_000, 3_000_000_000, "no-such-catalog"])
      expect(
        await call("admin_get", { type: "catalog", id: missing }),
      ).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(
      await call("admin_get", { type: "work", id: `work-${hex32("a")}` }),
    ).toMatchObject({ ok: false, code: "NOT_AVAILABLE" });
  });

  it("walks a whole field in windows on code points, every piece valid to re-submit", async () => {
    const pages = await followAll("admin_get", {
      type: "catalog",
      id,
      field: "transcription",
    });
    expect(pages.length).toBeGreaterThan(1);
    const pieces = pages.map((page) => (page.data as { text: string }).text);
    expect(pieces.join("")).toBe(longText);
    let offset = 0;
    for (const [index, page] of pages.entries()) {
      const data = page.data as {
        offset: number;
        nextOffset?: number;
        totalLength: number;
        fieldHash: string;
        offsetUnit: string;
        text: string;
      };
      expect(data.offset).toBe(offset);
      expect(data.offsetUnit).toBe("codePoint");
      expect(data.totalLength).toBe(Array.from(longText).length);
      expect(data.fieldHash).toBe(textHash(longText));
      expect(/\p{Cs}/u.test(data.text)).toBe(false);
      expect(data.text).not.toContain("�");
      offset += Array.from(data.text).length;
      expect(data.nextOffset).toBe(
        index === pages.length - 1 ? undefined : offset,
      );
      expect(page.untrusted).toContain("/data/text");
    }
  });

  it("keeps a window valid wherever it is cut, including one code point at a time", async () => {
    // Offsets count code points, so these can only land between surrogate pairs.
    for (const [offset, maxChars] of [
      [0, 1],
      [1, 1],
      [2_499, 2],
      [2_504, 3],
      [2_505, 5],
      [7_000, 1],
    ] as const) {
      const data = (
        await call("admin_get", {
          type: "catalog",
          id,
          field: "transcription",
          offset,
          maxChars,
        })
      ).data as { text: string };
      expect({
        offset,
        text: data.text,
      }).toEqual({
        offset,
        text: Array.from(longText)
          .slice(offset, offset + maxChars)
          .join(""),
      });
      expect(/\p{Cs}/u.test(data.text)).toBe(false);
    }
  });

  it("re-submits its windows through the real write contract and lands on the same content", async () => {
    const pages = await followAll("admin_get", {
      type: "catalog",
      id,
      field: "transcription",
    });
    const rebuilt = pages
      .map((page) => (page.data as { text: string }).text)
      .join("");
    const first = (pages[0]!.data as { text: string }).text;
    expect(
      editorialSaveDraftSchema.safeParse({
        idempotencyKey: `${run}:window-contract`,
        content: {
          ...syntheticCatalogDraft(
            `locate-${run}-window`,
            `source-${run}-window`,
          ),
          transcription: { state: "VALUE", value: first },
        },
      }).success,
    ).toBe(true);
    const before = getData(await call("admin_get", { type: "catalog", id }));
    const saved = await editDraft(
      `${suffix}:rebuild`,
      id,
      Number(before.revision),
      {
        transcription: { state: "VALUE", value: rebuilt },
      },
    );
    expect(saved.fingerprint).toBe(before.fingerprint);
    ({ revision } = saved);
  });

  it("finds inside one field in code points, raw by default", async () => {
    const envelope = await call("admin_get", {
      type: "catalog",
      id,
      field: "transcription",
      find: { text: "中段", context: 2 },
    });
    expect(envelope.data).toMatchObject({
      mode: "raw",
      count: 1,
      fieldHash: textHash(longText),
      matches: [
        {
          offset: 2_500,
          length: 2,
          before: "𠮷𠮷",
          match: "中段",
          after: "文字",
        },
      ],
    });
  });

  it("merges traditional forms only when asked, so an edit never matches on it", async () => {
    const saved = await saveCatalog("get-normalized", {
      transcription: { state: "VALUE", value: "𠮷蘭亭集序，蘭亭" },
    });
    const raw = await call("admin_get", {
      type: "catalog",
      id: saved.id,
      field: "transcription",
      find: { text: "兰亭" },
    });
    expect((raw.data as { count: number }).count).toBe(0);
    const normalized = await call("admin_get", {
      type: "catalog",
      id: saved.id,
      field: "transcription",
      find: { text: "兰亭", mode: "normalized", context: 1 },
    });
    expect(normalized.data).toMatchObject({
      mode: "normalized",
      count: 2,
      matches: [
        { offset: 1, match: "蘭亭", before: "𠮷", after: "集" },
        { offset: 6, match: "蘭亭", before: "，", after: "" },
      ],
    });
  });

  it("names what an unknown filter key could have been", async () => {
    const envelope = await call("admin_read", {
      op: "list.catalogs",
      input: { filter: { missng: ["transcription"] } },
    });
    expect(envelope).toMatchObject({ ok: false, code: "INPUT_INVALID" });
    expect(envelope.issues?.[0]).toMatchObject({
      path: ["input", "filter"],
      allowedKeys: expect.arrayContaining(["missing", "status", "dynasty"]),
    });
  });

  it("refuses a field it cannot window, naming what it can", async () => {
    const envelope = await call("admin_get", {
      type: "catalog",
      id,
      field: "objectKey",
    });
    expect(envelope).toMatchObject({ ok: false, code: "INPUT_INVALID" });
    expect(envelope.issues?.[0]?.allowedKeys).toContain("transcription");
    expect(
      await call("admin_get", { type: "catalog", id, view: "field" }),
    ).toMatchObject({ ok: false, code: "INPUT_INVALID" });
  });

  it("states published and draft apart, on a record with a newer draft", async () => {
    const saved = await saveCatalog("get-published", {
      title: "已发布题名",
      transcription: { state: "VALUE", value: "已发布的释文𠮷" },
    });
    const live = await publish(saved.id, saved.revision);
    const unchanged = getData(
      await call("admin_get", { type: "catalog", id: saved.id }),
    );
    expect(unchanged).toMatchObject({
      state: "published",
      publishedRevision: live.revision,
      hasUnpublishedChanges: false,
    });
    const edited = await editDraft(
      "get-published:edit",
      saved.id,
      Number(live.revision),
      {
        title: "新草稿题名",
        transcription: { state: "VALUE", value: "新草稿的释文𠮷" },
      },
    );
    const draft = getData(
      await call("admin_get", { type: "catalog", id: saved.id }),
    );
    expect(draft).toMatchObject({
      readFrom: "draft",
      state: "draft_over_published",
      title: "新草稿题名",
      revision: edited.revision,
      publishedRevision: live.revision,
      hasUnpublishedChanges: true,
    });
    const published = getData(
      await call("admin_get", {
        type: "catalog",
        id: saved.id,
        view: "published",
      }),
    );
    expect(published).toMatchObject({
      readFrom: "published",
      published: true,
      title: "已发布题名",
      revision: live.revision,
    });
    const window = await call("admin_get", {
      type: "catalog",
      id: saved.id,
      view: "published",
      field: "transcription",
    });
    expect(window.data).toMatchObject({
      readFrom: "published",
      text: "已发布的释文𠮷",
    });
  });

  it("says published:false rather than an empty record", async () => {
    const data = getData(
      await call("admin_get", { type: "catalog", id, view: "published" }),
    );
    expect(data).toMatchObject({
      readFrom: "published",
      published: false,
      revision: null,
      fingerprint: null,
    });
    expect(data).not.toHaveProperty("fields");
  });

  it("shows field-level history with the actor, and a diff with where it first differs", async () => {
    const saved = await saveCatalog("get-history", {
      transcription: { state: "VALUE", value: "第一版𠮷末尾" },
    });
    const second = await editDraft(
      "get-history:second",
      saved.id,
      saved.revision,
      {
        title: "第二版题名",
        transcription: { state: "VALUE", value: "第一版𠮷改过" },
      },
    );
    const history = await call("admin_get", {
      type: "catalog",
      id: saved.id,
      view: "history",
    });
    const { versions } = history.data as {
      versions: {
        versionId: number;
        revision: number;
        changedFields: string[];
        editor?: { id: number; kind: string };
        oldest?: boolean;
      }[];
    };
    expect(versions).toHaveLength(2);
    expect(versions[0]).toMatchObject({
      revision: second.revision,
      changedFields: expect.arrayContaining(["title", "transcription"]),
      editor: { id: owner.id, kind: "owner" },
    });
    expect(versions[0]!.changedFields).not.toContain("summary");
    expect(versions[1]!.oldest).toBe(true);
    const diff = await call("admin_get", {
      type: "catalog",
      id: saved.id,
      view: "diff",
      from: versions[1]!.versionId,
      to: versions[0]!.versionId,
    });
    expect(diff.data).toMatchObject({
      from: { version: versions[1]!.versionId, revision: saved.revision },
      to: { version: versions[0]!.versionId, revision: second.revision },
    });
    const change = (
      diff.data as {
        changes: {
          name: string;
          firstDiffOffset?: number;
          from: Record<string, unknown>;
          to: Record<string, unknown>;
        }[];
      }
    ).changes.find(({ name }) => name === "transcription")!;
    // After 第一版𠮷: four code points, though five UTF-16 units.
    expect(change.firstDiffOffset).toBe(4);
    expect(change.from.hash).toBe(textHash("第一版𠮷末尾"));
    expect(change.to.hash).toBe(textHash("第一版𠮷改过"));
    expect(JSON.stringify(diff)).not.toContain("改过");
    // A version of another record is no version of this one.
    const other = await saveCatalog("get-history-other");
    const foreign = (
      await call("admin_get", {
        type: "catalog",
        id: other.id,
        view: "history",
      })
    ).data as { versions: { versionId: number }[] };
    expect(
      await call("admin_get", {
        type: "catalog",
        id: saved.id,
        view: "diff",
        from: foreign.versions[0]!.versionId,
      }),
    ).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("reads Articles and collections, and windows a section of an Article", async () => {
    const created = await payload.create({
      collection: "articles",
      draft: true,
      overrideAccess: false,
      req: await ownerReq(),
      user: owner,
      data: {
        presentation: "news",
        title: "文章读取",
        byline: "署名",
        sections: [{ heading: "第一节", body: `正文${"𠮷".repeat(300)}` }],
      } as never,
    });
    const outline = getData(
      await call("admin_get", { type: "article", id: created.id }),
    );
    expect(outline.state).toBe("draft");
    expect(outline.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    const full = getData(
      await call("admin_get", {
        type: "article",
        id: created.id,
        view: "full",
      }),
    );
    const sections = (
      full.fields as { name: string; value?: Record<string, unknown>[] }[]
    ).find(({ name }) => name === "sections")!;
    expect(sections.value?.[0]?.body).toMatchObject({
      length: 302,
      windowed: "sections.0.body",
    });
    expect(
      (
        await call("admin_get", {
          type: "article",
          id: created.id,
          field: "sections.0.body",
          maxChars: 3,
        })
      ).data,
    ).toMatchObject({ text: "正文𠮷", totalLength: 302 });
    const collection = await payload.create({
      collection: "article-collections",
      draft: true,
      overrideAccess: false,
      req: await ownerReq(),
      user: owner,
      data: { title: "合集读取" } as never,
    });
    expect(
      getData(
        await call("admin_get", { type: "collection", id: collection.id }),
      ),
    ).toMatchObject({ title: "合集读取", state: "draft" });
  });

  it("refuses views media has no version of, and never shows its object key", async () => {
    const media = await payload.find({
      collection: "media",
      limit: 1,
      overrideAccess: true,
      depth: 0,
    });
    const row = media.docs[0]!;
    const outline = await call("admin_get", { type: "media", id: row.id });
    expect(getData(outline)).toMatchObject({
      readFrom: "live",
      state: "registered",
    });
    expect(JSON.stringify(outline)).not.toContain(row.objectKey);
    const full = await call("admin_get", {
      type: "media",
      id: row.id,
      view: "full",
    });
    expect(JSON.stringify(full)).not.toContain(row.objectKey);
    expect(
      await call("admin_get", { type: "media", id: row.id, view: "history" }),
    ).toMatchObject({ ok: false, code: "INPUT_INVALID" });
  });
});

describe("admin_get view=preview", () => {
  const webOrigin = "http://localhost:3000/";
  const cmsOrigin = "http://localhost:3002/";

  const previewOf = async (id: number) => {
    const envelope = await call("admin_get", {
      type: "catalog",
      id,
      view: "preview",
    });
    return {
      envelope,
      data: getData(envelope),
      text: JSON.stringify(envelope),
    };
  };

  it("gives the page's projection, issues, media ids and a relative path, and no absolute URL", async () => {
    vi.stubEnv("CMS_PREVIEW_WEB_URL", webOrigin);
    vi.stubEnv("CMS_PUBLIC_URL", cmsOrigin);
    try {
      const catalogId = `locate-${run}-preview`;
      const bytes = await sharp({
        create: { width: 30, height: 60, channels: 3, background: "#222222" },
      })
        .jpeg()
        .toBuffer();
      const mediaId = `media-preview-${run}`;
      const media = await payload.create({
        collection: "media",
        overrideAccess: false,
        req: await ownerReq(),
        data: { mediaId, catalogId, alt: "预览图", origin: "upload" } as never,
        file: {
          name: "synthetic.jpg",
          data: bytes,
          mimetype: "image/jpeg",
          size: bytes.length,
        },
      });
      const saved = await saveCatalog("preview", {
        title: "预览题名",
        transcription: { state: "VALUE", value: `${"碑".repeat(500)}${run}` },
        sourceCitations: [
          { label: "出处", url: "https://citation.example/book" },
        ],
        media: [
          {
            mediaId,
            objectKey: media.objectKey,
            width: 30,
            height: 60,
            alt: "预览图",
            position: 0,
            isRepresentative: true,
          },
        ],
      });
      const { data, text } = await previewOf(saved.id);
      expect(data).toMatchObject({
        view: "preview",
        readFrom: "draft",
        renderAvailable: true,
        renderPath: `/editorial-preview/${saved.id}`,
        revision: saved.revision,
        publishedRevision: null,
      });
      expect(text).not.toMatch(/https?:\/\//u);
      expect(text).not.toContain("localhost");
      expect(text).not.toContain("preview.invalid");
      expect(text).not.toContain("/api/media/file");
      expect(text).not.toContain(media.objectKey);
      const full = JSON.stringify(
        await call("admin_get", {
          type: "catalog",
          id: saved.id,
          view: "full",
        }),
      );
      expect(full).toContain(mediaId);
      expect(full).not.toContain(media.objectKey);
      expect(full).not.toContain("objectKey");
      expect(
        await call("admin_get", {
          type: "catalog",
          id: saved.id,
          field: "media.0.objectKey",
        }),
      ).toMatchObject({ ok: false, code: "INPUT_INVALID" });
      // Full is where a citation's link can be read.
      expect(full).toContain("https://citation.example/book");
      const projection = data.projection as Record<string, unknown>;
      expect(projection).toMatchObject({
        title: "预览题名",
        representativeMediaId: mediaId,
        media: [{ mediaId, width: 30, height: 60, alt: "预览图" }],
        sourceCitations: [{ label: "出处", hasUrl: true }],
        transcription: { length: 500 + run.length, windowed: "transcription" },
      });
      expect(text).not.toContain(run.slice(0, 8) + '"');
      // A diff against published, which here is everything that is set.
      expect(
        (data.diff as { changedFields: string[] }).changedFields,
      ).toContain("transcription");
      expect(Array.isArray(data.issues)).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    ["no origins set", {}, "PREVIEW_ORIGIN_NOT_CONFIGURED"],
    [
      "a Web origin that is not https",
      { CMS_PREVIEW_WEB_URL: "ftp://x.example/", CMS_PUBLIC_URL: cmsOrigin },
      "PREVIEW_ORIGIN_NOT_CONFIGURED",
    ],
    [
      "hosts that differ, so a session cookie cannot cross",
      {
        CMS_PREVIEW_WEB_URL: "http://127.0.0.1:3000/",
        CMS_PUBLIC_URL: cmsOrigin,
      },
      "PREVIEW_HOST_MISMATCH",
    ],
  ])(
    "reports renderAvailable false with a reason for %s, and still gives the projection",
    async (_name, environment, reason) => {
      vi.stubEnv("CMS_PREVIEW_WEB_URL", "");
      vi.stubEnv("CMS_PUBLIC_URL", "");
      for (const [name, value] of Object.entries(environment))
        vi.stubEnv(name, value);
      try {
        const saved = await saveCatalog(`preview-${reason}-${_name.length}`, {
          title: "没有渲染地址",
        });
        const { data, text } = await previewOf(saved.id);
        expect(data).toMatchObject({ renderAvailable: false, reason });
        expect(data).not.toHaveProperty("renderPath");
        expect((data.projection as { title: string }).title).toBe(
          "没有渲染地址",
        );
        expect(text).not.toMatch(/https?:\/\//u);
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it("opens the Web's preview route for the Owner's session, and for no MCP key", async () => {
    const saved = await saveCatalog("preview-route");
    const route = `${server.origin}/api/editorial/preview/${saved.id}`;
    for (const name of ["read", "full"]) {
      const secret = secrets[name]!;
      for (const [form, headers] of [
        ["bearer", { authorization: `Bearer ${secret}` }],
        ["jwt", { authorization: `JWT ${secret}` }],
        ["cookie", { cookie: `payload-token=${secret}` }],
      ] as const) {
        const response = await fetch(route, { headers });
        expect({ name, form, status: response.status }).toEqual({
          name,
          form,
          status: 403,
        });
        expect(await response.json()).toEqual({
          error: "PREVIEW_AUTHORIZATION_REQUIRED",
        });
      }
    }
    const { token } = await payload.login({
      collection: "users",
      data: { email: email("owner"), password },
    });
    const opened = await fetch(route, {
      headers: { cookie: `payload-token=${token}` },
    });
    expect(opened.status).toBe(200);
  });

  it("says a draft with no title cannot be previewed, and why", async () => {
    const saved = await saveCatalog("preview-untitled", { title: undefined });
    const { data } = await previewOf(saved.id);
    expect(data).toMatchObject({
      renderAvailable: false,
      reason: "PREVIEW_INCOMPLETE",
    });
    expect(data.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ["title"] })]),
    );
    expect(data).not.toHaveProperty("projection");
  });

  it("reads an Article's draft as its preview, with NO_PREVIEW_PAGE", async () => {
    const created = await payload.create({
      collection: "articles",
      draft: true,
      overrideAccess: false,
      req: await ownerReq(),
      user: owner,
      data: {
        presentation: "news",
        title: "文章预览",
        byline: "署名",
      } as never,
    });
    const data = getData(
      await call("admin_get", {
        type: "article",
        id: created.id,
        view: "preview",
      }),
    );
    expect(data).toMatchObject({
      renderAvailable: false,
      reason: "NO_PREVIEW_PAGE",
      readFrom: "draft",
    });
    expect(data).not.toHaveProperty("renderPath");
    expect(
      (data.fields as { name: string; value?: unknown }[]).find(
        ({ name }) => name === "title",
      )?.value,
    ).toBe("文章预览");
  });
});

describe("the same failure three times", () => {
  it.each([
    ["admin_find", { query: "x" }],
    ["admin_read", { op: "list.catalogs" }],
  ])(
    "sets meta.repeat on %s, and its answer holds nothing the caller typed",
    async (tool, good) => {
      const canary = `canary${run}`;
      expect((await call(tool, good)).ok).toBe(true);
      const bad = { ...good, [canary]: canary };
      const answers = [
        await call(tool, bad),
        await call(tool, bad),
        await call(tool, bad),
      ];
      expect(answers.map(({ code }) => code)).toEqual([
        "INPUT_INVALID",
        "INPUT_INVALID",
        "INPUT_INVALID",
      ]);
      expect(answers.map(({ meta }) => meta.repeat)).toEqual([
        undefined,
        undefined,
        3,
      ]);
      expect(JSON.stringify(answers)).not.toContain(canary);
      expect(answers[2]!.hint).toMatch(/Repeating the call unchanged/u);
      // A success clears it, so the next failure starts over.
      expect((await call(tool, good)).ok).toBe(true);
      expect((await call(tool, bad)).meta.repeat).toBeUndefined();
      expect((await call(tool, good)).ok).toBe(true);
    },
  );
});

describe("text results stay under the cap", () => {
  it("cuts a wide page into whole rows that parse, and next loses no row", async () => {
    const dynasty = `宽页朝代${run}`;
    const created: number[] = [];
    for (let index = 0; index < 8; index += 1)
      created.push(
        (
          await saveCatalog(`wide-${index}`, {
            title: `长题名${"文".repeat(400)}${index}`,
            dynasty: { state: "VALUE", value: dynasty },
            province: { state: "VALUE", value: "省".repeat(300) },
            prefecture: { state: "VALUE", value: "府".repeat(300) },
          })
        ).id,
      );
    const first = await call("admin_read", {
      op: "list.catalogs",
      view: "full",
      input: { filter: { dynasty } },
      pageSize: 8,
    });
    expect(first.meta.truncated).toBe(true);
    expect(first.next?.tool).toBe("admin_read");
    expect((first.remaining ?? 0) > 0).toBe(true);
    const pages = await followAll("admin_read", {
      op: "list.catalogs",
      view: "full",
      input: { filter: { dynasty } },
      pageSize: 8,
    });
    expect(pages.length).toBeGreaterThan(1);
    const ids = pages.flatMap((page) =>
      adminReadRowsDataSchema.parse(page.data).rows.map(({ id }) => id),
    );
    expect(ids.sort()).toEqual([...created].sort());
  });

  it("cuts view=full by whole fields, and next reaches the rest", async () => {
    const saved = await saveCatalog("full-cut", {
      title: "文".repeat(200),
      summary: "概".repeat(200),
      dynasty: { state: "VALUE", value: "朝".repeat(200) },
      dateText: { state: "VALUE", value: "年".repeat(200) },
      province: { state: "VALUE", value: "省".repeat(200) },
      prefecture: { state: "VALUE", value: "府".repeat(200) },
      county: { state: "VALUE", value: "县".repeat(200) },
      currentLocation: { state: "VALUE", value: "地".repeat(200) },
      currentCustodian: { state: "VALUE", value: "藏".repeat(200) },
      description: { state: "VALUE", value: "简".repeat(200) },
      scriptStyle: { state: "VALUE", value: "书".repeat(200) },
    });
    const pages = await followAll("admin_get", {
      type: "catalog",
      id: saved.id,
      view: "full",
    });
    expect(pages[0]!.meta.truncated).toBe(true);
    const names = pages.flatMap((page) =>
      (page.data as { fields: { name: string }[] }).fields.map(
        ({ name }) => name,
      ),
    );
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(
      expect.arrayContaining(["catalogId", "scriptStyle", "media"]),
    );
  });

  it("cuts a long list of matches and continues from the last one kept", async () => {
    const saved = await saveCatalog("find-cut", {
      transcription: { state: "VALUE", value: "碑文段落。".repeat(400) },
    });
    const pages = await followAll("admin_get", {
      type: "catalog",
      id: saved.id,
      field: "transcription",
      find: { text: "段落", context: 40 },
    });
    expect(pages.length).toBeGreaterThan(1);
    const offsets = pages.flatMap((page) =>
      (page.data as { matches: { offset: number }[] }).matches.map(
        ({ offset }) => offset,
      ),
    );
    expect(offsets).toEqual(
      Array.from({ length: 400 }, (_, index) => index * 5 + 2),
    );
    expect((pages[0]!.data as { count: number }).count).toBe(400);
  });

  it("gives a window that fits with room to spare, even of escaped text", async () => {
    const saved = await saveCatalog("escaped", {
      transcription: { state: "VALUE", value: `${'"\\\n'.repeat(4_000)}末` },
    });
    const envelope = await call("admin_get", {
      type: "catalog",
      id: saved.id,
      field: "transcription",
    });
    expect(envelope.meta.truncated).toBeUndefined();
    expect(envelope.next).toBeDefined();
  });
});

describe("admin_view_media", () => {
  const baseToken = randomBytes(32).toString("base64url");
  const ownerToken = randomBytes(32).toString("base64url");
  const mediaId = `media-view-${run}`;
  const catalogId = `locate-${run}-view`;
  let backend: Server;
  let backendOrigin: string;
  let thumbnail: Buffer;
  let source: { width: number; height: number };
  let directory: string;
  const catalogThumbnail = vi.fn();

  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "admin-mcp-locate-"));
    source = { width: 600, height: 400 };
    const original = await sharp({
      create: { ...source, channels: 3, background: "#777777" },
    })
      .composite([
        {
          input: await sharp({
            create: {
              width: 100,
              height: 100,
              channels: 3,
              background: "#ff0000",
            },
          })
            .png()
            .toBuffer(),
          left: 200,
          top: 100,
        },
      ])
      .jpeg()
      .toBuffer();
    await payload.create({
      collection: "media",
      overrideAccess: false,
      req: await ownerReq(),
      data: { mediaId, catalogId, alt: "查看图", origin: "upload" } as never,
      file: {
        name: "synthetic.jpg",
        data: original,
        mimetype: "image/jpeg",
        size: original.length,
      },
    });
    thumbnail = await sharp({
      create: { width: 60, height: 40, channels: 3, background: "#123456" },
    })
      .webp()
      .toBuffer();
    catalogThumbnail.mockImplementation(async () => ({
      bytes: thumbnail,
      mimeType: "image/webp",
    }));
    const application = createBackendApplication({
      nodeEnv: "development",
      communityIdentityPort: new InMemoryCommunityIdentityPort(),
      storageUrlResolver: new MappedStorageUrlResolver(new Map()),
      communityCommentPort: new InMemoryCommunityCommentPort(),
      communityOperatorCredential: ownerToken,
      operatorAiBaseCredential: baseToken,
      catalogThumbnail,
    });
    backend = createBackendServer(application);
    const address = await startServer(backend, { host: "127.0.0.1", port: 0 });
    backendOrigin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await stopServer(backend);
    await rm(directory, { recursive: true, force: true });
  });

  /** The Matrix's Production order: the community token is not placed. */
  const withBaseOnly = () => {
    vi.stubEnv("COMMUNITY_OPERATOR_BASE_URL", backendOrigin);
    vi.stubEnv("COMMUNITY_OPERATOR_TOKEN", "");
    vi.stubEnv("COMMUNITY_OPERATOR_AI_TOKEN", "");
    vi.stubEnv("OPERATOR_AI_BASE_TOKEN", baseToken);
  };

  const view = async (args: Record<string, unknown>) => {
    const result = await clients.read!.callTool({
      name: "admin_view_media",
      arguments: args,
    });
    const content = result.content as {
      type: string;
      text?: string;
      data?: string;
      mimeType?: string;
    }[];
    const envelope = adminMcpEnvelopeSchema.parse(
      JSON.parse(content[0]!.text!),
    );
    // Matrix "admin_view_media result": no structuredContent, ever.
    expect(result.structuredContent).toBeUndefined();
    expect(result.isError === true).toBe(!envelope.ok);
    return { content, envelope };
  };

  it("works with the community token absent, and the official client accepts it", async () => {
    withBaseOnly();
    try {
      const { content, envelope } = await view({
        kind: "catalog_thumb",
        mediaId,
      });
      expect(envelope).toMatchObject({ ok: true, code: "OK" });
      const data = adminViewMediaDataSchema.parse(envelope.data);
      expect(data).toMatchObject({
        kind: "catalog_thumb",
        mediaId,
        original: source,
        rendered: { width: 60, height: 40, format: "webp" },
      });
      expect(content[1]).toMatchObject({
        type: "image",
        mimeType: "image/webp",
      });
      const bytes = Buffer.from(content[1]!.data!, "base64");
      expect(bytes.equals(thumbnail)).toBe(true);
      expect(data.rendered.bytes).toBe(bytes.byteLength);
      expect(content[0]!.text).not.toContain("objectKey");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("answers AI_CREDENTIAL_NOT_CONFIGURED with the base token absent, even with the Owner's placed", async () => {
    vi.stubEnv("COMMUNITY_OPERATOR_BASE_URL", backendOrigin);
    vi.stubEnv("COMMUNITY_OPERATOR_TOKEN", ownerToken);
    vi.stubEnv("OPERATOR_AI_BASE_TOKEN", "");
    const calls = catalogThumbnail.mock.calls.length;
    try {
      const { content, envelope } = await view({
        kind: "catalog_thumb",
        mediaId,
      });
      expect(envelope).toMatchObject({
        ok: false,
        code: "AI_CREDENTIAL_NOT_CONFIGURED",
      });
      expect(content).toHaveLength(1);
      expect(catalogThumbnail.mock.calls.length).toBe(calls);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    [403, "AI_ROUTE_FORBIDDEN", "AI_ROUTE_FORBIDDEN"],
    [404, "NOT_FOUND", "NOT_FOUND"],
    [503, "CATALOG_DELIVERY_NOT_CONFIGURED", "MEDIA_UNAVAILABLE"],
  ])(
    "names a Backend %i by a code of its own, and carries no image",
    async (status, backendCode, code) => {
      const stub = createServer((_incoming, outgoing) => {
        outgoing.writeHead(status, { "content-type": "application/json" });
        outgoing.end(JSON.stringify({ error: { code: backendCode } }));
      });
      await new Promise<void>((resolve) =>
        stub.listen(0, "127.0.0.1", resolve),
      );
      const { port } = stub.address() as AddressInfo;
      vi.stubEnv("COMMUNITY_OPERATOR_BASE_URL", `http://127.0.0.1:${port}`);
      vi.stubEnv("OPERATOR_AI_BASE_TOKEN", baseToken);
      try {
        const { content, envelope } = await view({
          kind: "catalog_thumb",
          mediaId,
        });
        expect(envelope).toMatchObject({ ok: false, code });
        expect(content).toHaveLength(1);
      } finally {
        vi.unstubAllEnvs();
        stub.closeAllConnections();
        await new Promise((resolve) => stub.close(resolve));
      }
    },
  );

  it("answers a miss and a bad argument in the same shape", async () => {
    expect(
      (await view({ kind: "catalog_thumb", mediaId: "media-no-such" }))
        .envelope,
    ).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(
      (await view({ kind: "work_media", mediaId })).envelope,
    ).toMatchObject({ ok: false, code: "INPUT_INVALID" });
  });

  it("cuts a thumbnail to a smaller edge and reports the size it rendered", async () => {
    withBaseOnly();
    try {
      const { content, envelope } = await view({
        kind: "catalog_thumb",
        mediaId,
        maxEdge: 64,
        region: { left: 10, top: 10, width: 30, height: 20 },
      });
      const data = adminViewMediaDataSchema.parse(envelope.data);
      expect(data.rendered).toMatchObject({ width: 30, height: 20 });
      const metadata = await sharp(
        Buffer.from(content[1]!.data!, "base64"),
      ).metadata();
      expect(metadata).toMatchObject({ format: "webp", width: 30, height: 20 });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("crops one passage of the original to a WebP within the bound, reading local storage", async () => {
    const { content, envelope } = await view({
      kind: "catalog_original",
      mediaId,
      region: { left: 200, top: 100, width: 100, height: 100 },
    });
    expect(envelope).toMatchObject({ ok: true, code: "OK" });
    const data = adminViewMediaDataSchema.parse(envelope.data);
    expect(data).toMatchObject({
      original: source,
      region: { left: 200, top: 100, width: 100, height: 100 },
      rendered: { width: 100, height: 100, format: "webp" },
    });
    const bytes = Buffer.from(content[1]!.data!, "base64");
    expect(bytes.byteLength).toBeLessThanOrEqual(ADMIN_VIEW_MEDIA_MAX_BYTES);
    const { dominant } = await sharp(bytes).stats();
    expect(dominant.r).toBeGreaterThan(200);
    expect(dominant.g).toBeLessThan(60);
  });

  it("keeps a noisy passage within the bound by giving up quality, then size", async () => {
    const catalog = `locate-${run}-noisy`;
    const noisyId = `media-noisy-${run}`;
    const raw = randomBytes(2_400 * 2_400 * 3);
    const noisy = await sharp(raw, {
      raw: { width: 2_400, height: 2_400, channels: 3 },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();
    await payload.create({
      collection: "media",
      overrideAccess: false,
      req: await ownerReq(),
      data: {
        mediaId: noisyId,
        catalogId: catalog,
        alt: "噪点",
        origin: "upload",
      } as never,
      file: {
        name: "synthetic.png",
        data: noisy,
        mimetype: "image/png",
        size: noisy.length,
      },
    });
    const { content, envelope } = await view({
      kind: "catalog_original",
      mediaId: noisyId,
      region: { left: 0, top: 0, width: 2_400, height: 2_400 },
      maxEdge: 2_048,
    });
    expect(envelope).toMatchObject({ ok: true, code: "OK" });
    const data = adminViewMediaDataSchema.parse(envelope.data);
    const bytes = Buffer.from(content[1]!.data!, "base64");
    expect(bytes.byteLength).toBeLessThanOrEqual(ADMIN_VIEW_MEDIA_MAX_BYTES);
    expect(data.rendered.bytes).toBe(bytes.byteLength);
    expect(data.rendered.width).toBeLessThan(2_048);
  }, 60_000);

  it("requires a region inside the image for an original", async () => {
    for (const [region, code] of [
      [undefined, "required"],
      [{ left: 590, top: 0, width: 20, height: 20 }, "outside_image"],
      [{ left: 0, top: 390, width: 20, height: 20 }, "outside_image"],
    ] as const) {
      const { envelope } = await view({
        kind: "catalog_original",
        mediaId,
        ...(region === undefined ? {} : { region }),
      });
      expect(envelope).toMatchObject({ ok: false, code: "INPUT_INVALID" });
      expect(envelope.issues?.[0]?.code).toBe(code);
    }
  });

  it("decodes one original at a time", async () => {
    const upload = payload.collections.media.config.upload;
    const original = upload.handlers;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    upload.handlers = [
      async () => {
        entered();
        await held;
        return undefined;
      },
    ];
    try {
      const region = { left: 0, top: 0, width: 50, height: 50 };
      const first = view({ kind: "catalog_original", mediaId, region });
      await started;
      const second = await view({ kind: "catalog_original", mediaId, region });
      expect(second.envelope).toMatchObject({
        ok: false,
        code: "CONCURRENT_OPERATION_BUSY",
      });
      release();
      expect((await first).envelope).toMatchObject({ ok: true, code: "OK" });
    } finally {
      release();
      upload.handlers = original ?? [];
    }
  });
});
