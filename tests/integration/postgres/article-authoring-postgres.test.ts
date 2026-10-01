import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { CommunityConflictError, CommunityNotFoundError } from "@moya/api";
import type { ArticleAuthoringActor } from "@moya/api";
import {
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import {
  PostgresArticleAuthoringAdapter,
  resolvePublishedArticleManagedMedia,
  PostgresAuthorCommunityAdapter,
  PostgresCommunityCommentAdapter,
  PostgresNotificationAdapter,
  PostgresWorkPublishingAdapter,
  runCommunityMigrations,
} from "@moya/community-postgres";
import { emptyArticleDocument } from "@moya/contracts/schemas";
import type {
  ArticleAuthoringDocument,
  ArticleBlockEditsCommand,
  ArticleDraft,
  CatalogId,
  MediaId,
  ArticleId,
  PublicUserId,
  WorkDraftContent,
} from "@moya/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sourceFactsSql } from "../../../services/community-postgres/src/notifications/source.js";
import {
  assertSyntheticTestDatabaseUrl,
  requireSyntheticTestDatabaseUrl,
} from "./synthetic-test-database.js";
import { registerArticleDelegationSdkCases } from "./article-delegation-sdk-cases.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const target = requireSyntheticTestDatabaseUrl(),
  endpoint = new URL(target);
if (
  !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
  endpoint.search ||
  endpoint.hash
)
  throw Error(
    "Article persistence tests require a loopback disposable target without overrides",
  );
const guard = (await import(
  new URL("../../../scripts/disposable-test-target.mjs", import.meta.url).href
)) as {
  disposableTestTargetProbeSql: string;
  markCurrentDatabaseDisposableSql: string;
  assertDisposableTestTarget(rows: unknown, database: string): string;
};
const poolFor = (url: string) =>
  createPostgresPool(parsePostgresConfig({ DATABASE_URL: url }));
const administration = poolFor(target);
let setup: ReturnType<typeof poolFor> | undefined,
  app: ReturnType<typeof poolFor> | undefined;
let control: ReturnType<typeof poolFor> | undefined,
  issuer: ReturnType<typeof poolFor> | undefined;
const createdDelegationRoles: string[] = [];
let database: string | undefined,
  role: string | undefined,
  adapter: PostgresArticleAuthoringAdapter;
let createdDatabase = false,
  createdRole = false;
const opaque = (prefix: string) =>
  `${prefix}-${randomUUID().replaceAll("-", "")}`;
const user = opaque("user") as PublicUserId,
  other = opaque("user") as PublicUserId,
  recipient = opaque("user") as PublicUserId;
const actor: ArticleAuthoringActor = { source: "human", userId: user };
const stranger: ArticleAuthoringActor = { source: "human", userId: other };
const now = new Date("2026-09-30T12:00:00Z");
const at = (seconds: number) => new Date(now.getTime() + seconds * 1000);
const commandId = () => ({ requestId: randomUUID() });
const candidate = (draft: ArticleDraft) => ({
  ...commandId(),
  expectedVersion: draft.version,
  fingerprint: draft.fingerprint,
});
const catalog = "article-qa-catalog" as CatalogId,
  media = "article-qa-catalog-image" as MediaId;
let ownMedia: string, foreignMedia: string, unavailableLegacyMedia: string;
const seedMedia = async (ownerId: PublicUserId) => {
  const legacy = opaque("user-media"),
    item = opaque("media-item");
  await setup!.query(
    "INSERT INTO community.user_media(id,owner_id,mime_type,width,height,sha256,bytes) VALUES($1,$2,'image/png',1,1,$3,$4)",
    [legacy, ownerId, "b".repeat(64), Buffer.from([0x89, 0x50, 0x4e, 0x47])],
  );
  await setup!.query(
    `INSERT INTO community.media_items(id,owner_id,kind,quality_mode,source,legacy_media_id,state,declared_total_bytes,received_total_bytes,presentation,ready_at)
    VALUES($1,$2,'static','legacy','legacy_user_media',$3,'ready',4,4,'{"width":1,"height":1}'::jsonb,$4::timestamptz)`,
    [item, ownerId, legacy, now],
  );
  return item;
};

beforeAll(async () => {
  const probe = await administration.query(guard.disposableTestTargetProbeSql);
  guard.assertDisposableTestTarget(
    probe.rows,
    assertSyntheticTestDatabaseUrl(target),
  );
  const suffix = randomBytes(6).toString("hex");
  database = `article_authoring_${suffix}_synthetic_test`;
  role = `article_authoring_${suffix}`;
  expect(
    (
      await administration.query(
        "SELECT 1 FROM pg_database WHERE datname=$1 UNION ALL SELECT 1 FROM pg_roles WHERE rolname=$2",
        [database, role],
      )
    ).rows,
  ).toEqual([]);
  // Ephemeral test material stays in the process and database; never logged.
  const password = randomBytes(32).toString("hex");
  await administration.query(
    `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`,
  );
  createdRole = true;
  await administration.query(`CREATE DATABASE ${database}`);
  createdDatabase = true;
  const setupUrl = new URL(target);
  setupUrl.pathname = `/${database}`;
  setup = poolFor(setupUrl.toString());
  await setup.query(guard.markCurrentDatabaseDisposableSql);
  guard.assertDisposableTestTarget(
    (await setup.query(guard.disposableTestTargetProbeSql)).rows,
    database,
  );
  // Explicit synthetic minimal Payload primary substrate. There is no retained
  // CMS data, and the tables keep the VERIFIED production column names.
  await setup.query(`CREATE TABLE public.catalogs(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,catalog_id text UNIQUE NOT NULL,_status text NOT NULL);
    CREATE TABLE public.catalogs_media(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,_parent_id bigint NOT NULL REFERENCES public.catalogs(id),media_id text NOT NULL);
    CREATE TABLE public.catalog_entries(catalog_id text PRIMARY KEY,province text,province_state text);
    CREATE TABLE public.catalog_discovery(catalog_id text PRIMARY KEY,kind text,title text,aliases varchar[],first_published_at timestamptz,filter_metadata jsonb);
    CREATE TABLE public.catalog_media(catalog_id text,media_id text,object_key text,width integer,height integer,is_representative boolean);
    CREATE TABLE public.article_entries(article_id text PRIMARY KEY,title text);`);
  await runCommunityMigrations(setup, `${root}/database/community-migrations`);
  await setup.query(
    "INSERT INTO community.public_users(id,handle,display_name) VALUES($1,'article-qa-owner','合成作者'),($2,'article-qa-other','合成访客'),($3,'article-qa-recipient','合成接收者')",
    [user, other, recipient],
  );
  await setup.query(
    "INSERT INTO community.development_accounts(user_id,label) VALUES($1,'Synthetic Article SDK owner')",
    [user],
  );
  await setup.query(
    "UPDATE community.work_publishing_settings SET publication_policy='DIRECT_PUBLICATION' WHERE id='settings'",
  );
  await setup.query(
    "INSERT INTO public.catalogs(catalog_id,_status) VALUES($1,'published')",
    [catalog],
  );
  await setup.query(
    "INSERT INTO public.catalogs_media(_parent_id,media_id) SELECT id,$2 FROM public.catalogs WHERE catalog_id=$1",
    [catalog, media],
  );

  ownMedia = await seedMedia(user);
  foreignMedia = await seedMedia(other);
  unavailableLegacyMedia = await seedMedia(user);
  await setup.query(
    "UPDATE community.user_media SET bytes=''::bytea,deleted_at=$2::timestamptz WHERE id=(SELECT legacy_media_id FROM community.media_items WHERE id=$1)",
    [unavailableLegacyMedia, now],
  );
  const grants = (
    await readFile(
      `${root}/infra/development/work-publishing/grant-runtime.sql`,
      "utf8",
    )
  ).replaceAll(':"app_role"', `"${role}"`);
  await setup.query(grants);
  const appUrl = new URL(setupUrl);
  appUrl.username = role;
  appUrl.password = password;
  app = poolFor(appUrl.toString());
  adapter = new PostgresArticleAuthoringAdapter(app);
  const extraRoles: string[] = [];
  for (const purpose of ["control", "issuer"] as const) {
    const roleName = `${role}_${purpose}`;
    const rolePassword = randomBytes(32).toString("hex");
    await administration.query(
      `CREATE ROLE ${roleName} LOGIN PASSWORD '${rolePassword}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`,
    );
    createdDelegationRoles.push(roleName);
    extraRoles.push(roleName);
    const roleUrl = new URL(setupUrl);
    roleUrl.username = roleName;
    roleUrl.password = rolePassword;
    if (purpose === "control") control = poolFor(roleUrl.href);
    else issuer = poolFor(roleUrl.href);
  }
  const grantClient = await setup.connect();
  try {
    await grantClient.query("BEGIN");
    await grantClient.query(
      "SELECT set_config('article_authoring.control_role',$1,true),set_config('article_authoring.issuer_role',$2,true),set_config('article_authoring.resource_role',$3,true)",
      [extraRoles[0], extraRoles[1], role],
    );
    await grantClient.query(
      await readFile(
        `${root}/infra/development/article-authoring/grant-delegation.sql`,
        "utf8",
      ),
    );
    await grantClient.query("COMMIT");
  } catch (error) {
    await grantClient.query("ROLLBACK");
    throw error;
  } finally {
    grantClient.release();
  }
});
afterAll(async () => {
  await app?.end();
  await control?.end();
  await issuer?.end();
  await setup?.end();
  // Only this invocation's successfully created, unpredictable resources.
  if (createdDatabase && database)
    await administration.query(`DROP DATABASE ${database}`);
  for (const roleName of createdDelegationRoles)
    await administration.query(`DROP ROLE ${roleName}`);
  if (createdRole && role) await administration.query(`DROP ROLE ${role}`);
  await administration.end();
});

registerArticleDelegationSdkCases({
  get pool() {
    if (app === undefined) throw Error("Resource pool not prepared");
    return app;
  },
  get controlPool() {
    if (control === undefined) throw Error("Control pool not prepared");
    return control;
  },
  get issuerPool() {
    if (issuer === undefined) throw Error("Issuer pool not prepared");
    return issuer;
  },
  userId: user,
  handle: "article-qa-owner",
});

it("consent UID SQL accepts the complete 256-character ASCII contract and rejects invalid input", async () => {
  const insert = (uid: string) =>
    issuer!.query(
      "INSERT INTO community.article_authoring_consents(interaction_uid,oauth_client_id,resource,scopes,expires_at) VALUES($1,'synthetic-boundary-client','http://127.0.0.1:47461/mcp/article-authoring',ARRAY['artvenn:article:draft']::text[],CURRENT_TIMESTAMP+interval '10 minutes')",
      [uid],
    );
  await insert("a".repeat(256));
  await expect(insert("b".repeat(257))).rejects.toMatchObject({
    code: "23514",
  });
  await expect(insert("bad/input")).rejects.toMatchObject({ code: "23514" });
});

describe("Article persistence through the limited runtime role", () => {
  it("validates distinct Catalog-media tuples even when delimiter-based keys collide", async () => {
    const first = "article-qa",
      second = "article-qa:pair";
    await setup!.query(
      "INSERT INTO public.catalogs(catalog_id,_status) VALUES($1,'published'),($2,'published')",
      [first, second],
    );
    await setup!.query(
      "INSERT INTO public.catalogs_media(_parent_id,media_id) SELECT id,'catalog-image' FROM public.catalogs WHERE catalog_id=$1",
      [second],
    );
    const document: ArticleAuthoringDocument = {
      ...emptyArticleDocument(),
      blocks: [
        {
          id: "invalid-pair",
          type: "managedImage",
          props: { refId: "invalid", caption: "", alt: "" },
          children: [],
        },
        {
          id: "valid-pair",
          type: "managedImage",
          props: { refId: "valid", caption: "", alt: "" },
          children: [],
        },
      ],
      references: {
        invalid: {
          type: "catalog",
          catalogId: first as CatalogId,
          mediaId: "pair:catalog-image" as MediaId,
        },
        valid: {
          type: "catalog",
          catalogId: second as CatalogId,
          mediaId: "catalog-image" as MediaId,
        },
      },
    };
    await expect(
      adapter.create(
        actor,
        {
          ...commandId(),
          title: "每个资料图片须匹配",
          coverRefId: null,
          document,
        },
        at(1),
      ),
    ).rejects.toThrow("article_references_unavailable");
  });
  it("binds ownership, preserves Unicode/stable IDs, and serializes receipt replay and stale human/Agent writes", async () => {
    const create = {
      ...commandId(),
      title: "𠮷字・繁體保留",
      coverRefId: null,
      document: emptyArticleDocument(),
    };
    const first = await adapter.create(actor, create, now);
    expect(await adapter.create(actor, create, at(1))).toEqual(first);
    expect(first.ownerId).toBe(user);
    await expect(adapter.read(stranger, first.id, now)).rejects.toBeInstanceOf(
      CommunityNotFoundError,
    );
    const document: ArticleAuthoringDocument = {
      ...first.document,
      blocks: [
        {
          id: "stable-block",
          type: "paragraph",
          props: {},
          content: [
            {
              type: "text",
              text: "𠮷字\n繁體、异体與🙂",
              styles: { bold: true },
            },
          ],
          children: [],
        },
      ],
    };
    const save = {
      ...commandId(),
      expectedVersion: first.version,
      title: first.title,
      coverRefId: null,
      document,
    };
    const second = await adapter.save(actor, first.id, save, at(2));
    expect(second.version).toBe(first.version + 1);
    expect((await adapter.read(actor, first.id, at(3))).document).toEqual(
      document,
    );
    expect(await adapter.save(actor, first.id, save, at(4))).toEqual(second);
    await expect(
      adapter.save(actor, first.id, { ...save, ...commandId() }, at(5)),
    ).rejects.toBeInstanceOf(CommunityConflictError);
    // Current delegation admission runs before receipt replay, even when a
    // human command's same requestId is supplied through an uncomposed Agent.
    const noGrant: ArticleAuthoringActor = {
      source: "delegated",
      userId: user,
      connectionId: "unconfigured",
      generation: 1,
      grantId: "unconfigured",
      expiresAt: at(3600).toISOString(),
      scopes: [],
    };
    await expect(
      adapter.save(noGrant, first.id, save, at(6)),
    ).rejects.toBeInstanceOf(CommunityNotFoundError);
    const edit: ArticleBlockEditsCommand = {
      ...commandId(),
      expectedVersion: second.version,
      edits: [
        {
          type: "replace",
          block: {
            id: "stable-block",
            type: "paragraph",
            props: {},
            content: [
              { type: "text", text: "同一请求只编辑一次𠮷", styles: {} },
            ],
            children: [],
          },
        },
      ],
    };
    const edited = await adapter.editBlocks(actor, first.id, edit, at(7));
    expect(edited.version).toBe(second.version + 1);
    expect(await adapter.editBlocks(actor, first.id, edit, at(8))).toEqual(
      edited,
    );
    await expect(
      adapter.editBlocks(actor, first.id, { ...edit, ...commandId() }, at(9)),
    ).rejects.toBeInstanceOf(CommunityConflictError);
    expect(
      (
        await setup!.query(
          "SELECT count(*)::text AS n FROM community.author_events WHERE subject_id=$1",
          [first.id],
        )
      ).rows[0]?.n,
    ).toBe("3");
  });
  it("retains the last publication while a replacement is draft/pending, and fences a publish captured before withdrawal", async () => {
    let draft = await adapter.create(
      actor,
      {
        ...commandId(),
        title: "已公开旧版",
        coverRefId: null,
        document: emptyArticleDocument(),
      },
      at(10),
    );
    const publish = candidate(draft),
      published = await adapter.publish(actor, draft.id, publish, at(11));
    expect(published.status).toBe("published");
    expect(published.publicVersion).toBe(draft.version);
    expect(await adapter.publish(actor, draft.id, publish, at(12))).toEqual(
      published,
    );
    expect((await adapter.readPublished(draft.id))?.title).toBe("已公开旧版");
    draft = await adapter.save(
      actor,
      draft.id,
      {
        ...commandId(),
        expectedVersion: published.version,
        title: "尚未公开新版",
        coverRefId: null,
        document: published.document,
      },
      at(13),
    );
    expect((await adapter.readPublished(draft.id))?.title).toBe("已公开旧版");
    await setup!.query(
      "UPDATE community.work_publishing_settings SET publication_policy='PRE_MODERATION' WHERE id='settings'",
    );
    const pending = await adapter.publish(
      actor,
      draft.id,
      candidate(draft),
      at(14),
    );
    expect(pending.status).toBe("pending");
    expect(pending.publicVersion).toBe(published.publicVersion);
    expect((await adapter.readPublished(draft.id))?.title).toBe("已公开旧版");
    const latePublish = candidate(pending);
    const withdrawn = await adapter.withdraw(
      actor,
      draft.id,
      candidate(pending),
      at(15),
    );
    expect(withdrawn.version).toBe(pending.version + 1);
    expect(await adapter.readPublished(draft.id)).toBeNull();
    await expect(
      adapter.publish(actor, draft.id, latePublish, at(16)),
    ).rejects.toBeInstanceOf(CommunityConflictError);
    await setup!.query(
      "UPDATE community.work_publishing_settings SET publication_policy='DIRECT_PUBLICATION' WHERE id='settings'",
    );
  });
  it("denies other-user assets and retains published/history refs after block removal without deleting or recharging media", async () => {
    const withImage = (itemId: string): ArticleAuthoringDocument => ({
      ...emptyArticleDocument(),
      blocks: [
        {
          id: "image-block",
          type: "managedImage",
          props: { refId: "image-ref", caption: "合成圖片", alt: "合成圖片" },
          children: [],
        },
      ],
      references: { "image-ref": { type: "managed", itemId } },
    });
    await expect(
      adapter.create(
        actor,
        {
          ...commandId(),
          title: "不得引用",
          coverRefId: null,
          document: withImage(foreignMedia),
        },
        at(20),
      ),
    ).rejects.toThrow("article_references_unavailable");
    await expect(
      adapter.create(
        actor,
        {
          ...commandId(),
          title: "失效原始媒体",
          coverRefId: null,
          document: withImage(unavailableLegacyMedia),
        },
        at(20),
      ),
    ).rejects.toThrow("article_references_unavailable");
    const first = await adapter.create(
      actor,
      {
        ...commandId(),
        title: "媒体保留",
        coverRefId: "image-ref",
        document: withImage(ownMedia),
      },
      at(21),
    );
    const published = await adapter.publish(
      actor,
      first.id,
      candidate(first),
      at(22),
    );
    await adapter.save(
      actor,
      first.id,
      {
        ...commandId(),
        expectedVersion: published.version,
        title: first.title,
        coverRefId: null,
        document: emptyArticleDocument(),
      },
      at(23),
    );
    const refs = (
      await setup!.query<{ holder_kind: string }>(
        "SELECT holder_kind FROM community.media_item_refs WHERE item_id=$1 ORDER BY holder_kind",
        [ownMedia],
      )
    ).rows.map((row) => row.holder_kind);
    expect(refs).toContain("article_revision");
    expect(refs).not.toContain("article_draft");
    expect(
      (
        await setup!.query(
          "SELECT state,declared_total_bytes,received_total_bytes FROM community.media_items WHERE id=$1",
          [ownMedia],
        )
      ).rows,
    ).toEqual([
      { state: "ready", declared_total_bytes: "4", received_total_bytes: "4" },
    ]);
    const publishing = new PostgresWorkPublishingAdapter(app!);
    expect(await publishing.purgeItem(ownMedia, at(40_000_000))).toEqual({
      status: "referenced",
    });
  });
  it("checks exact published Catalog-media identity through a narrow helper and blocks a concurrent withdrawal until commit", async () => {
    await expect(
      app!.query("SELECT catalog_id FROM public.catalogs"),
    ).rejects.toThrow();
    const doc: ArticleAuthoringDocument = {
      ...emptyArticleDocument(),
      blocks: [
        {
          id: "catalog-image",
          type: "managedImage",
          props: {
            refId: "catalog-ref",
            caption: "合成资料插图",
            alt: "合成资料插图",
          },
          children: [],
        },
      ],
      references: {
        "catalog-ref": { type: "catalog", catalogId: catalog, mediaId: media },
      },
    };
    const draft = await adapter.create(
      actor,
      {
        ...commandId(),
        title: "資料引用",
        coverRefId: "catalog-ref",
        document: doc,
      },
      at(30),
    );
    expect(
      (await adapter.validate(actor, draft.id, candidate(draft), at(31))).valid,
    ).toBe(true);
    const client = await app!.connect(),
      withdrawer = await setup!.connect();
    let withdrawal: Promise<unknown> | undefined;
    try {
      await client.query("BEGIN");
      expect(
        (
          await client.query(
            "SELECT community.article_catalog_references_published($1::text[],$2::text[],$3::text[]) AS allowed",
            [[catalog], [catalog], [media]],
          )
        ).rows[0]?.allowed,
      ).toBe(true);
      const pid = (
        await withdrawer.query<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid",
        )
      ).rows[0]!.pid;
      withdrawal = withdrawer.query(
        "UPDATE public.catalogs SET _status='draft' WHERE catalog_id=$1",
        [catalog],
      );
      let blocked = false;
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        blocked =
          (
            await setup!.query<{ blocked: boolean }>(
              "SELECT wait_event_type='Lock' AS blocked FROM pg_stat_activity WHERE pid=$1",
              [pid],
            )
          ).rows[0]?.blocked === true;
        if (blocked) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      await client.query("COMMIT");
      await withdrawal;
      const check = await adapter.validate(
        actor,
        draft.id,
        candidate(draft),
        at(32),
      );
      expect(check.valid).toBe(false);
      expect(check.issues).toContainEqual({
        code: "catalog_unavailable",
        path: ["document", "references"],
      });
      await expect(
        adapter.publish(actor, draft.id, candidate(draft), at(33)),
      ).rejects.toThrow("article_references_unavailable");
      expect(await adapter.readPublished(draft.id)).toBeNull();
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await withdrawal?.catch(() => undefined);
      client.release();
      withdrawer.release();
      await setup!.query(
        "UPDATE public.catalogs SET _status='published' WHERE catalog_id=$1",
        [catalog],
      );
    }
  });
  it("protects immutable ownership and submission snapshots at SQL level, and never grants the runtime Payload CRUD", async () => {
    const draft = await adapter.create(
      actor,
      {
        ...commandId(),
        title: "不可变所有权",
        coverRefId: null,
        document: emptyArticleDocument(),
      },
      at(40),
    );
    await adapter.publish(actor, draft.id, candidate(draft), at(41));
    await expect(
      setup!.query(
        "UPDATE community.article_documents SET owner_id=$2,version=version+1 WHERE id=$1",
        [draft.id, other],
      ),
    ).rejects.toThrow("immutable");
    await expect(
      setup!.query(
        "UPDATE community.article_revisions SET title='改写' WHERE article_id=$1",
        [draft.id],
      ),
    ).rejects.toThrow("immutable");
    await expect(
      app!.query(
        "DELETE FROM community.article_revisions WHERE article_id=$1",
        [draft.id],
      ),
    ).rejects.toThrow();
    await expect(
      app!.query(
        "UPDATE public.catalogs SET _status='draft' WHERE catalog_id=$1",
        [catalog],
      ),
    ).rejects.toThrow();
    const unicode = await adapter.create(
      actor,
      {
        ...commandId(),
        title: "𠮷".repeat(120),
        coverRefId: null,
        document: emptyArticleDocument(),
      },
      at(42),
    );
    expect([...unicode.title]).toHaveLength(120);
    expect(() =>
      adapter.create(
        actor,
        {
          ...commandId(),
          title: "𠮷".repeat(121),
          coverRefId: null,
          document: emptyArticleDocument(),
        },
        at(43),
      ),
    ).toThrow("article_title_too_long");
    const first = await adapter.list(actor, { pageSize: 2 }, at(44));
    expect(first.items.every((item) => !("document" in item))).toBe(true);
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const next = await adapter.list(
      actor,
      { pageSize: 2, cursor: first.nextCursor! },
      at(42),
    );
    expect(
      next.items.some((item) => first.items.some((old) => old.id === item.id)),
    ).toBe(false);
    expect(
      (await adapter.list(stranger, { pageSize: 50 }, at(42))).items,
    ).toEqual([]);
  });
});

describe("PRE_MODERATION exact Article candidate decisions", () => {
  it("approves the exact pending snapshot once with content-free operator audit", async () => {
    await setup!.query(
      "UPDATE community.work_publishing_settings SET publication_policy='PRE_MODERATION' WHERE id='settings'",
    );
    const draft = await adapter.create(
      actor,
      {
        ...commandId(),
        title: "合成待审专题",
        coverRefId: null,
        document: emptyArticleDocument(),
      },
      at(300),
    );
    const pending = await adapter.publish(
      actor,
      draft.id,
      candidate(draft),
      at(301),
    );
    expect(await adapter.readPublished(draft.id)).toBeNull();
    const queue = await adapter.listPending({ pageSize: 50 });
    const entry = queue.items.find((item) => item.articleId === draft.id)!;
    expect(entry).not.toHaveProperty("document");
    expect(entry.expectedVersion).toBe(pending.version);
    const exact = await adapter.readPending(draft.id);
    expect(exact.document).toEqual(draft.document);
    expect(exact.candidateVersion).toBe(draft.version);
    const command = {
      ...commandId(),
      expectedVersion: exact.expectedVersion,
      candidateVersion: exact.candidateVersion,
      fingerprint: exact.fingerprint,
      action: "approve" as const,
    };
    const approved = await adapter.moderatePending(
      "owner",
      draft.id,
      command,
      at(302),
    );
    expect(approved.publicVersion).toBe(draft.version);
    expect(approved.version).toBe(pending.version + 1);
    expect(
      await adapter.moderatePending("owner", draft.id, command, at(303)),
    ).toEqual(approved);
    expect((await adapter.readPublished(draft.id))?.document).toEqual(
      draft.document,
    );
    await expect(adapter.readPending(draft.id)).rejects.toBeInstanceOf(
      CommunityNotFoundError,
    );
    const audit = (
      await setup!.query(
        "SELECT detail FROM community.content_operator_events WHERE content_type='article' AND content_id=$1 AND action='article.submission.moderate'",
        [draft.id],
      )
    ).rows;
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain("合成待审专题");
    expect(audit[0]?.detail).not.toHaveProperty("document");
    expect(
      (
        await setup!.query(
          "SELECT count(*)::text AS n FROM community.article_revisions WHERE article_id=$1",
          [draft.id],
        )
      ).rows[0]?.n,
    ).toBe("1");
    await setup!.query(
      "UPDATE community.work_publishing_settings SET publication_policy='DIRECT_PUBLICATION' WHERE id='settings'",
    );
  });
  it("rejects a replacement while preserving the old public snapshot", async () => {
    await setup!.query(
      "UPDATE community.work_publishing_settings SET publication_policy='DIRECT_PUBLICATION' WHERE id='settings'",
    );
    const first = await adapter.create(
      actor,
      {
        ...commandId(),
        title: "合成公开旧版",
        coverRefId: null,
        document: emptyArticleDocument(),
      },
      at(310),
    );
    const original = await adapter.publish(
      actor,
      first.id,
      candidate(first),
      at(311),
    );
    const replacement = await adapter.save(
      actor,
      first.id,
      {
        ...commandId(),
        expectedVersion: original.version,
        title: "合成拒绝新版",
        coverRefId: null,
        document: first.document,
      },
      at(312),
    );
    await setup!.query(
      "UPDATE community.work_publishing_settings SET publication_policy='PRE_MODERATION' WHERE id='settings'",
    );
    const pending = await adapter.publish(
      actor,
      first.id,
      candidate(replacement),
      at(313),
    );
    const exact = await adapter.readPending(first.id);
    const result = await adapter.moderatePending(
      "owner",
      first.id,
      {
        ...commandId(),
        expectedVersion: pending.version,
        candidateVersion: exact.candidateVersion,
        fingerprint: exact.fingerprint,
        action: "reject",
      },
      at(314),
    );
    expect(result.status).toBe("draft");
    expect(result.publicVersion).toBe(original.publicVersion);
    expect((await adapter.readPublished(first.id))?.title).toBe("合成公开旧版");
    expect((await adapter.read(actor, first.id, at(315))).title).toBe(
      "合成拒绝新版",
    );
    await expect(adapter.readPending(first.id)).rejects.toBeInstanceOf(
      CommunityNotFoundError,
    );
    await setup!.query(
      "UPDATE community.work_publishing_settings SET publication_policy='DIRECT_PUBLICATION' WHERE id='settings'",
    );
  });
  it("refuses a pending decision after author save or candidate mismatch", async () => {
    await setup!.query(
      "UPDATE community.work_publishing_settings SET publication_policy='PRE_MODERATION' WHERE id='settings'",
    );
    const draft = await adapter.create(
      actor,
      {
        ...commandId(),
        title: "合成并发稿",
        coverRefId: null,
        document: emptyArticleDocument(),
      },
      at(320),
    );
    const pending = await adapter.publish(
      actor,
      draft.id,
      candidate(draft),
      at(321),
    );
    const exact = await adapter.readPending(draft.id);
    const identity = {
      expectedVersion: pending.version,
      candidateVersion: exact.candidateVersion,
      fingerprint: exact.fingerprint,
      action: "approve" as const,
    };
    await expect(
      adapter.moderatePending(
        "owner",
        draft.id,
        { ...commandId(), ...identity, fingerprint: "f".repeat(64) },
        at(322),
      ),
    ).rejects.toBeInstanceOf(CommunityConflictError);
    const saved = await adapter.save(
      actor,
      draft.id,
      {
        ...commandId(),
        expectedVersion: pending.version,
        title: "合成已修改稿",
        coverRefId: null,
        document: draft.document,
      },
      at(323),
    );
    await expect(
      adapter.moderatePending(
        "owner",
        draft.id,
        { ...commandId(), ...identity },
        at(324),
      ),
    ).rejects.toBeInstanceOf(CommunityConflictError);
    expect(saved.status).toBe("draft");
    expect(await adapter.readPublished(draft.id)).toBeNull();
    expect(
      (
        await setup!.query(
          "SELECT count(*)::text AS n FROM community.content_operator_events WHERE content_id=$1",
          [draft.id],
        )
      ).rows[0]?.n,
    ).toBe("0");
    await setup!.query(
      "UPDATE community.work_publishing_settings SET publication_policy='DIRECT_PUBLICATION' WHERE id='settings'",
    );
  });
});

const imageDocument = (itemId: string): ArticleAuthoringDocument => ({
  ...emptyArticleDocument(),
  blocks: [
    {
      id: "retained-picture",
      type: "managedImage",
      props: { refId: "image", caption: "合成图注", alt: "合成图片" },
      children: [],
    },
  ],
  references: {
    image: {
      type: "managed",
      itemId: itemId as NonNullable<
        WorkDraftContent["items"][number]["itemId"]
      >,
    },
  },
});
const legacyId = async (itemId: string): Promise<string> =>
  (
    await setup!.query<{ legacy_media_id: string }>(
      "SELECT legacy_media_id FROM community.media_items WHERE id=$1",
      [itemId],
    )
  ).rows[0]!.legacy_media_id;
const publishArticle = async (document = emptyArticleDocument()) => {
  const draft = await adapter.create(
    actor,
    {
      ...commandId(),
      title: "公开合成文章",
      coverRefId: null,
      document,
    },
    at(400),
  );
  return adapter.publish(actor, draft.id, candidate(draft), at(401));
};
const discussionPage = { page: 1, pageSize: 50 };
const directDiscussion = async (run: () => Promise<void>) => {
  const policy = (
    await setup!.query<{ policy: string }>(
      "SELECT policy FROM community.publication_setting WHERE id='publication'",
    )
  ).rows[0]!.policy;
  await setup!.query(
    "UPDATE community.publication_setting SET policy='DIRECT_PUBLICATION' WHERE id='publication'",
  );
  try {
    await run();
  } finally {
    await setup!.query(
      "UPDATE community.publication_setting SET policy=$1 WHERE id='publication'",
      [policy],
    );
  }
};
const pumpNotifications = async (inbox: PostgresNotificationAdapter) => {
  for (let i = 0; i < 10; i++) {
    const claims = await inbox.claim("article-qa", 20);
    if (!claims.length) return;
    await Promise.all(claims.map((claim) => inbox.project(claim)));
  }
  throw Error("Notification source count exceeded bounded fixture expectation");
};
const inboxPage = (inbox: PostgresNotificationAdapter) =>
  inbox.read(recipient, { filter: "all", limit: 50 });
const mentionRecipient = () => {
  const text = "@article-qa-recipient";
  return {
    text,
    mentions: [
      {
        userId: recipient,
        handle: "article-qa-recipient",
        start: 0,
        end: text.length,
      },
    ],
  };
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
/** Real pg clients; instrumentation pauses only after the actual admission SELECT. */
type TestPool = ReturnType<typeof poolFor>;
const acquireTestClient = () => app!.connect();
type TestClient = Awaited<ReturnType<typeof acquireTestClient>>;
const interposedPool = (
  onQuery: (client: TestClient, sql: string) => Promise<void>,
): TestPool =>
  ({
    connect: async () => {
      const client = await acquireTestClient();
      const query = client.query.bind(client);
      return {
        query: async (sql: string, values?: unknown[]) => {
          const result = await query(sql, values);
          await onQuery(client, sql);
          return result;
        },
        release: () => client.release(),
      } as TestClient;
    },
  }) as unknown as TestPool;
const waitForLock = async (pid: number) => {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const row = (
      await setup!.query<{ waiting: boolean }>(
        "SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1",
        [pid],
      )
    ).rows[0];
    if (row?.waiting) return;
    await new Promise<void>((done) => setTimeout(done, 10));
  }
  throw Error("Expected fixture transaction to wait for the admission lock");
};

describe("authored Article public-media and existing community targets", () => {
  it("exposes only the exact current published legacy PNG, preserving historical retention", async () => {
    const authors = new PostgresAuthorCommunityAdapter(app!);
    const itemId = await seedMedia(user),
      png = await legacyId(itemId);
    const draft = await adapter.create(
      actor,
      {
        ...commandId(),
        title: "非公开合成图片",
        coverRefId: null,
        document: imageDocument(itemId),
      },
      at(410),
    );
    expect(await authors.readMedia(png, null)).toBeNull();
    expect(await authors.readMedia(png, user)).not.toBeNull();
    const published = await adapter.publish(
      actor,
      draft.id,
      candidate(draft),
      at(411),
    );
    expect(await authors.readMedia(png, null)).not.toBeNull();
    expect(await authors.readMedia(png, other)).not.toBeNull();
    const edited = await adapter.save(
      actor,
      published.id,
      {
        ...commandId(),
        expectedVersion: published.version,
        title: "新稿没有图片",
        coverRefId: null,
        document: emptyArticleDocument(),
      },
      at(412),
    );
    // A private newer draft does not revoke the still-current public snapshot.
    expect(await authors.readMedia(png, null)).not.toBeNull();
    await adapter.publish(actor, edited.id, candidate(edited), at(413));
    expect(await authors.readMedia(png, null)).toBeNull();
    expect(
      (
        await setup!.query(
          "SELECT 1 FROM community.media_item_refs WHERE item_id=$1 AND holder_kind='article_revision'",
          [itemId],
        )
      ).rowCount,
    ).toBe(1);
  });
  it("rejects unavailable media, a mismatched owner, blocked viewers, suspended owners and withdrawal", async () => {
    const authors = new PostgresAuthorCommunityAdapter(app!);
    const itemId = await seedMedia(user),
      png = await legacyId(itemId);
    const published = await publishArticle(imageDocument(itemId));
    try {
      for (const state of ["processing", "failed", "cancelled", "purged"]) {
        await setup!.query(
          "UPDATE community.media_items SET state=$2 WHERE id=$1",
          [itemId, state],
        );
        expect(await authors.readMedia(png, null)).toBeNull();
      }
      await setup!.query(
        "UPDATE community.media_items SET state='ready' WHERE id=$1",
        [itemId],
      );
      await setup!.query(
        "UPDATE community.user_media SET deleted_at=CURRENT_TIMESTAMP,bytes=''::bytea WHERE id=$1",
        [png],
      );
      expect(await authors.readMedia(png, null)).toBeNull();
      await setup!.query(
        "UPDATE community.user_media SET deleted_at=NULL,bytes=$2 WHERE id=$1",
        [png, Buffer.from([0x89, 0x50, 0x4e, 0x47])],
      );
      const foreignItem = await seedMedia(other),
        foreignPng = await legacyId(foreignItem);
      // A privileged retained-reference fixture cannot cross ownership even
      // when it points at an otherwise valid published Article holder.
      await setup!.query(
        `INSERT INTO community.media_item_refs(item_id,holder_kind,holder_id)
        SELECT $1,holder_kind,holder_id FROM community.media_item_refs
        WHERE item_id=$2 AND holder_kind='article_revision'`,
        [foreignItem, itemId],
      );
      expect(await authors.readMedia(foreignPng, null)).toBeNull();
      await authors.block(user, {
        ...commandId(),
        targetId: other,
        enabled: true,
      });
      expect(await authors.readMedia(png, other)).toBeNull();
      expect(await authors.readMedia(png, null)).not.toBeNull();
      await authors.block(user, {
        ...commandId(),
        targetId: other,
        enabled: false,
      });
      await setup!.query(
        "UPDATE community.public_users SET status='suspended' WHERE id=$1",
        [user],
      );
      expect(await authors.readMedia(png, null)).toBeNull();
      await setup!.query(
        "UPDATE community.public_users SET status='active' WHERE id=$1",
        [user],
      );
      await adapter.withdraw(
        actor,
        published.id,
        candidate(published),
        at(420),
      );
      expect(await authors.readMedia(png, null)).toBeNull();
      expect(await authors.readMedia(png, user)).not.toBeNull();
    } finally {
      await setup!.query(
        "UPDATE community.media_items SET state='ready' WHERE id=$1",
        [itemId],
      );
      await setup!.query(
        "UPDATE community.user_media SET deleted_at=NULL WHERE id=$1",
        [png],
      );
      await setup!.query(
        "UPDATE community.public_users SET status='active' WHERE id=$1",
        [user],
      );
      await setup!.query(
        "DELETE FROM community.blocks WHERE blocker_id=$1 AND blocked_id=$2",
        [user, other],
      );
    }
  });
  it("preserves native avatar/background and unedited public Work PNG admission and Work discussions", async () => {
    const authors = new PostgresAuthorCommunityAdapter(app!);
    const itemId = await seedMedia(user),
      png = await legacyId(itemId);
    expect(await authors.readMedia(png, null)).toBeNull();
    await authors.updateAvatar(user, { ...commandId(), mediaId: png });
    expect(await authors.readMedia(png, null)).not.toBeNull();
    await setup!.query(
      "UPDATE community.public_users SET avatar_media_id=NULL WHERE id=$1",
      [user],
    );
    expect(await authors.readMedia(png, null)).toBeNull();
    await authors.updateBackground(user, { ...commandId(), mediaId: png });
    expect(await authors.readMedia(png, null)).not.toBeNull();
    await authors.updateBackground(user, { ...commandId(), mediaId: null });
    expect(await authors.readMedia(png, null)).toBeNull();
    const publishing = new PostgresWorkPublishingAdapter(app!);
    const content: WorkDraftContent = {
      title: "合成 Work 保持原发布路径",
      body: "普通作品",
      authorship: { kind: "original" },
      visibility: "public",
      items: [
        {
          key: "work-photo",
          itemId: itemId as NonNullable<
            WorkDraftContent["items"][number]["itemId"]
          >,
          kind: "static",
          qualityMode: "legacy",
          edit: { rotation: 0, crop: null },
        },
      ],
      coverKey: null,
      coverCrop: null,
    };
    const draft = await publishing.createDraft(
      user,
      { ...commandId(), content, deviceClass: "desktop" },
      at(430),
    );
    const submitted = await publishing.submit(
      user,
      {
        ...commandId(),
        holder: { draftId: draft.id },
        content,
        baseRevisionId: draft.baseRevisionId,
      },
      at(431),
    );
    expect(submitted.state).toBe("confirmed");
    if (submitted.state !== "confirmed")
      throw Error("Native Work fixture did not publish");
    expect(await authors.readMedia(png, null)).not.toBeNull();
    const comments = new PostgresCommunityCommentAdapter(app!);
    const target = { type: "work" as const, id: submitted.workId };
    await directDiscussion(async () => {
      const sent = await comments.submitDiscussion(
        target,
        other,
        "普通 Work 评论",
      );
      expect(
        (
          await comments.readDiscussion(target, null, discussionPage)
        ).items.some((i) => i.id === sent.id),
      ).toBe(true);
      await publishing.setVisibility(
        user,
        submitted.workId,
        { ...commandId(), visibility: "self" },
        at(432),
      );
      expect(await authors.readMedia(png, null)).toBeNull();
      await expect(
        comments.readDiscussion(target, other, discussionPage),
      ).rejects.toBeInstanceOf(CommunityNotFoundError);
    });
  });
  it("checks Article availability and owner interactions for reads, replies, likes and receipt replay", async () => {
    const authors = new PostgresAuthorCommunityAdapter(app!),
      comments = new PostgresCommunityCommentAdapter(app!);
    const draft = await adapter.create(
      actor,
      {
        ...commandId(),
        title: "讨论边界",
        coverRefId: null,
        document: emptyArticleDocument(),
      },
      at(440),
    );
    const target = { type: "article" as const, id: draft.id };
    await expect(
      comments.readDiscussion(target, null, discussionPage),
    ).rejects.toBeInstanceOf(CommunityNotFoundError);
    await expect(
      comments.submitDiscussion(target, other, "不可发布"),
    ).rejects.toBeInstanceOf(CommunityNotFoundError);
    // A staff projection with the same id cannot reopen an authored draft.
    await setup!.query(
      "INSERT INTO public.article_entries(article_id,title) VALUES($1,'同 id 合成投影')",
      [draft.id],
    );
    await expect(
      comments.readDiscussion(target, other, discussionPage),
    ).rejects.toBeInstanceOf(CommunityNotFoundError);
    const published = await adapter.publish(
      actor,
      draft.id,
      candidate(draft),
      at(441),
    );
    await directDiscussion(async () => {
      const sent = await comments.submitDiscussion(
        target,
        other,
        "已有读者评论",
      );
      const reply = await comments.submitDiscussion(
        target,
        recipient,
        "已有回复",
        sent.id,
      );
      expect(
        (
          await comments.readDiscussion(target, null, discussionPage)
        ).items.some((i) => i.id === sent.id),
      ).toBe(true);
      expect(
        (
          await comments.readDiscussionReplies(
            target,
            sent.id,
            null,
            discussionPage,
          )
        ).items.some((i) => i.id === reply.id),
      ).toBe(true);
      const request = randomUUID();
      await comments.setDiscussionLike(recipient, sent.id, true, request);
      try {
        await authors.block(user, {
          ...commandId(),
          targetId: other,
          enabled: true,
        });
        await expect(
          comments.readDiscussion(target, other, discussionPage),
        ).rejects.toBeInstanceOf(CommunityNotFoundError);
        await expect(
          comments.submitDiscussion(target, other, "blocked", sent.id),
        ).rejects.toBeInstanceOf(CommunityNotFoundError);
        expect(
          (await comments.ownComments(other, discussionPage)).items.find(
            (i) => i.id === sent.id,
          )?.target,
        ).toBeNull();
        await authors.block(user, {
          ...commandId(),
          targetId: other,
          enabled: false,
        });
        await setup!.query(
          "UPDATE community.public_users SET status='suspended' WHERE id=$1",
          [user],
        );
        await expect(
          comments.readDiscussion(target, null, discussionPage),
        ).rejects.toBeInstanceOf(CommunityNotFoundError);
        await setup!.query(
          "UPDATE community.public_users SET status='active' WHERE id=$1",
          [user],
        );
        await adapter.withdraw(
          actor,
          published.id,
          candidate(published),
          at(442),
        );
        await expect(
          comments.readDiscussion(target, null, discussionPage),
        ).rejects.toBeInstanceOf(CommunityNotFoundError);
        await expect(
          comments.readDiscussionReplies(
            target,
            sent.id,
            recipient,
            discussionPage,
          ),
        ).rejects.toBeInstanceOf(CommunityNotFoundError);
        await expect(
          comments.submitDiscussion(target, recipient, "withdrawn", sent.id),
        ).rejects.toBeInstanceOf(CommunityNotFoundError);
        await expect(
          comments.setDiscussionLike(recipient, sent.id, true, request),
        ).rejects.toBeInstanceOf(CommunityNotFoundError);
        expect(
          (await comments.ownComments(other, discussionPage)).items.find(
            (i) => i.id === sent.id,
          )?.target,
        ).toBeNull();
        // Unavailable targets retain the author's ability to delete their body.
        await comments.deleteDiscussionBody(other, sent.id, randomUUID());
      } finally {
        await setup!.query(
          "UPDATE community.public_users SET status='active' WHERE id=$1",
          [user],
        );
        await setup!.query(
          "DELETE FROM community.blocks WHERE blocker_id=$1 AND blocked_id=$2",
          [user, other],
        );
      }
    });
  });
  it("holds the Article document lock until the actual comment commit, serializing withdrawal", async () => {
    const published = await publishArticle();
    const target = { type: "article" as const, id: published.id };
    const admitted = deferred(),
      release = deferred(),
      withdrawing = deferred();
    let withdrawPid = 0;
    const comments = new PostgresCommunityCommentAdapter(
      interposedPool(async (_client, sql) => {
        if (sql.includes("FOR SHARE OF a")) {
          admitted.resolve();
          await release.promise;
        }
      }),
    );
    const withdrawAdapter = new PostgresArticleAuthoringAdapter(
      interposedPool(async (client, sql) => {
        if (sql === "BEGIN") {
          withdrawPid = (
            await client.query<{ pid: number }>(
              "SELECT pg_backend_pid() AS pid",
            )
          ).rows[0]!.pid;
          withdrawing.resolve();
        }
      }),
    );
    let sent: ReturnType<typeof comments.submitDiscussion> | undefined,
      withdrawn: ReturnType<typeof withdrawAdapter.withdraw> | undefined;
    await directDiscussion(async () => {
      try {
        sent = comments.submitDiscussion(target, other, "锁内合成评论");
        await Promise.race([
          admitted.promise,
          sent.then(() => {
            throw Error("Fixture comment completed before admission hook");
          }),
        ]);
        withdrawn = withdrawAdapter.withdraw(
          actor,
          published.id,
          candidate(published),
          at(450),
        );
        await Promise.race([
          withdrawing.promise,
          withdrawn.then(() => {
            throw Error("Fixture withdrawal completed before transaction hook");
          }),
        ]);
        await waitForLock(withdrawPid);
        release.resolve();
        const result = await sent;
        await withdrawn;
        expect(
          (
            await setup!.query(
              "SELECT 1 FROM community.catalog_comments WHERE id=$1",
              [result.id],
            )
          ).rowCount,
        ).toBe(1);
        await expect(
          new PostgresCommunityCommentAdapter(app!).submitDiscussion(
            target,
            other,
            "withdrawn",
          ),
        ).rejects.toBeInstanceOf(CommunityNotFoundError);
      } finally {
        release.resolve();
        await sent?.catch(() => undefined);
        await withdrawn?.catch(() => undefined);
      }
    });
  });
  it("serializes the native owner block against an admitted Article discussion", async () => {
    const published = await publishArticle(),
      target = { type: "article" as const, id: published.id };
    const admitted = deferred(),
      release = deferred(),
      blocking = deferred();
    let blockPid = 0;
    const comments = new PostgresCommunityCommentAdapter(
      interposedPool(async (_client, sql) => {
        if (sql.includes("FOR SHARE OF a")) {
          admitted.resolve();
          await release.promise;
        }
      }),
    );
    const authors = new PostgresAuthorCommunityAdapter(
      interposedPool(async (client, sql) => {
        if (sql === "BEGIN") {
          blockPid = (
            await client.query<{ pid: number }>(
              "SELECT pg_backend_pid() AS pid",
            )
          ).rows[0]!.pid;
          blocking.resolve();
        }
      }),
    );
    let sent: ReturnType<typeof comments.submitDiscussion> | undefined,
      blocked: ReturnType<typeof authors.block> | undefined;
    await directDiscussion(async () => {
      try {
        sent = comments.submitDiscussion(target, other, "block 前已准入");
        await Promise.race([
          admitted.promise,
          sent.then(() => {
            throw Error("Fixture comment completed before admission hook");
          }),
        ]);
        blocked = authors.block(user, {
          ...commandId(),
          targetId: other,
          enabled: true,
        });
        await Promise.race([
          blocking.promise,
          blocked.then(() => {
            throw Error("Fixture block completed before transaction hook");
          }),
        ]);
        await waitForLock(blockPid);
        release.resolve();
        await sent;
        await blocked;
        await expect(
          new PostgresCommunityCommentAdapter(app!).submitDiscussion(
            target,
            other,
            "blocked",
          ),
        ).rejects.toBeInstanceOf(CommunityNotFoundError);
      } finally {
        release.resolve();
        await sent?.catch(() => undefined);
        await blocked?.catch(() => undefined);
        await setup!.query(
          "DELETE FROM community.blocks WHERE blocker_id=$1 AND blocked_id=$2",
          [user, other],
        );
      }
    });
  });
  it("projects published Article mention notifications and rechecks actor/recipient owner interactions and withdrawal", async () => {
    const published = await publishArticle(),
      target = { type: "article" as const, id: published.id };
    const comments = new PostgresCommunityCommentAdapter(app!),
      authors = new PostgresAuthorCommunityAdapter(app!),
      inbox = new PostgresNotificationAdapter(app!),
      mention = mentionRecipient();
    await directDiscussion(async () => {
      const sent = await comments.submitDiscussion(
        target,
        other,
        mention.text,
        undefined,
        undefined,
        mention.mentions,
      );
      await pumpNotifications(inbox);
      const delivered = (await inboxPage(inbox)).items.find(
        (i) => i.commentId === sent.id,
      );
      expect(delivered).toMatchObject({
        available: true,
        target,
        reason: "mention",
      });
      // Unavailable facts deliberately clear commentId; the private group ID
      // remains the stable identity of the already-delivered notification.
      const visible = () =>
        inboxPage(inbox).then((page) =>
          page.items.find((i) => i.id === delivered!.id),
        );
      const expectUnavailable = async () =>
        expect(await visible()).toMatchObject({
          available: false,
          target: null,
          commentId: null,
          text: "",
          actors: [],
          actorCount: 0,
          unread: false,
        });
      const sourceEligible = async () =>
        (
          await app!.query<{ eligible: boolean }>(
            `SELECT eligible FROM (${sourceFactsSql}) f WHERE action_key=$1`,
            [`comment:${sent.id}`],
          )
        ).rows[0]!.eligible;
      try {
        await authors.block(user, {
          ...commandId(),
          targetId: other,
          enabled: true,
        });
        expect(await sourceEligible()).toBe(false);
        await expectUnavailable();
        await authors.block(user, {
          ...commandId(),
          targetId: other,
          enabled: false,
        });
        await authors.block(user, {
          ...commandId(),
          targetId: recipient,
          enabled: true,
        });
        expect(await sourceEligible()).toBe(true); // Actor and Article owner still interact.
        await expectUnavailable(); // Recipient cannot read the target.
        await authors.block(user, {
          ...commandId(),
          targetId: recipient,
          enabled: false,
        });
        await setup!.query(
          "UPDATE community.public_users SET status='suspended' WHERE id=$1",
          [user],
        );
        expect(await sourceEligible()).toBe(false);
        await expectUnavailable();
        await setup!.query(
          "UPDATE community.public_users SET status='active' WHERE id=$1",
          [user],
        );
        expect((await visible())?.available).toBe(true);
        await adapter.withdraw(
          actor,
          published.id,
          candidate(published),
          at(460),
        );
        expect(await sourceEligible()).toBe(false);
        await expectUnavailable();
      } finally {
        await setup!.query(
          "UPDATE community.public_users SET status='active' WHERE id=$1",
          [user],
        );
        await setup!.query(
          "DELETE FROM community.blocks WHERE blocker_id=$1 AND blocked_id=ANY($2::text[])",
          [user, [other, recipient]],
        );
      }
    });
  });
  it("preserves staff Article and Catalog comment and mention notification behavior", async () => {
    const staffId = opaque("article") as ArticleId,
      catalogId = opaque("catalog") as CatalogId,
      comments = new PostgresCommunityCommentAdapter(app!),
      inbox = new PostgresNotificationAdapter(app!),
      mention = mentionRecipient();
    await setup!.query(
      "INSERT INTO public.article_entries(article_id,title) VALUES($1,'合成管理文章')",
      [staffId],
    );
    // The existing notification source admits Catalogs only through the
    // published discovery projection, not the separate primary CMS table.
    await setup!.query(
      "INSERT INTO public.catalog_discovery(catalog_id) VALUES($1)",
      [catalogId],
    );
    await directDiscussion(async () => {
      for (const target of [
        { type: "article" as const, id: staffId },
        { type: "catalog" as const, id: catalogId },
      ]) {
        const sent = await comments.submitDiscussion(
          target,
          other,
          mention.text,
          undefined,
          undefined,
          mention.mentions,
        );
        expect(
          (
            await comments.readDiscussion(target, null, discussionPage)
          ).items.some((i) => i.id === sent.id),
        ).toBe(true);
        await pumpNotifications(inbox);
        // Delivery is one action; the reader exposes notification groups.
        const deliveries = (
          await setup!.query<{
            recipient_id: string;
            reasons: string[];
            group_id: string;
          }>(
            "SELECT recipient_id,reasons,group_id FROM community.notification_deliveries WHERE action_key=$1 ORDER BY recipient_id",
            [`comment:${sent.id}`],
          )
        ).rows;
        expect(deliveries).toEqual([
          {
            recipient_id: recipient,
            reasons: ["mention"],
            group_id: expect.any(String),
          },
        ]);
        expect(
          (await inboxPage(inbox)).items.find(
            (i) => i.id === deliveries[0]!.group_id,
          ),
        ).toMatchObject({ available: true, target, reason: "mention" });
      }
    });
  });
});

describe("native Article canonical media paging and public resolution", () => {
  it("pages own readable assets without losing SQL microsecond seek precision", async () => {
    const first = await seedMedia(user),
      second = await seedMedia(user);
    await setup!.query(
      "UPDATE community.media_items SET created_at=CASE id WHEN $1 THEN '2026-09-30T23:59:59.123456Z'::timestamptz ELSE '2026-09-30T23:59:59.123455Z'::timestamptz END WHERE id=ANY($2::text[])",
      [first, [first, second]],
    );
    const a = await adapter.listOwnMedia(actor, { pageSize: 1 }, now);
    expect(a.items.map((item) => item.id)).toEqual([first]);
    const b = await adapter.listOwnMedia(
      actor,
      { pageSize: 1, cursor: a.nextCursor! },
      now,
    );
    expect(b.items.map((item) => item.id)).toEqual([second]);
    expect(
      (await adapter.listOwnMedia(stranger, { pageSize: 50 }, now)).items.some(
        (item) => item.id === first,
      ),
    ).toBe(false);
    await setup!.query(
      "UPDATE community.media_items SET state='failed',failure_code='synthetic_failure' WHERE id=$1",
      [first],
    );
    expect(
      (await adapter.listOwnMedia(actor, { pageSize: 50 }, now)).items.some(
        (item) => item.id === first,
      ),
    ).toBe(false);
  });
  it("resolves only current published own references through the actual limited App role", async () => {
    const fresh = await seedMedia(user),
      foreign = await seedMedia(other);
    const document = imageDocument(fresh);
    expect(
      (await resolvePublishedArticleManagedMedia(app!, user, [fresh, foreign]))
        .size,
    ).toBe(0);
    const published = await publishArticle(document);
    expect([
      ...(
        await resolvePublishedArticleManagedMedia(app!, user, [fresh, foreign])
      ).keys(),
    ]).toEqual([fresh]);
    const draft = await adapter.save(
      actor,
      published.id,
      {
        ...commandId(),
        expectedVersion: published.version,
        title: published.title,
        coverRefId: null,
        document: emptyArticleDocument(),
      },
      at(402),
    );
    expect(
      (await resolvePublishedArticleManagedMedia(app!, user, [fresh])).has(
        fresh,
      ),
    ).toBe(true);
    await adapter.withdraw(actor, draft.id, candidate(draft), at(403));
    expect(
      (await resolvePublishedArticleManagedMedia(app!, user, [fresh])).size,
    ).toBe(0);
  });
});
