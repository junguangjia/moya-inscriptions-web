import { registerPhase4DiscoveryTests } from "./phase4-discovery-cases.js";
import { registerPhase4AuthorTests } from "./phase4-author-cases.js";
import { registerProfileBackgroundTests } from "./profile-background-cases.js";
import { registerWorkPublishingContentTests } from "./work-publishing-content-cases.js";
import { registerThreadTests } from "./thread-cases.js";
import { registerDirectMessageTests } from "./direct-message-cases.js";
import { registerWorkPublishingMediaTests } from "./work-publishing-media-cases.js";
import { registerAgentAdministrationTests } from "./agent-administration-cases.js";
import { registerAgentAuthorizationFlowTests } from "./agent-authorization-flow-cases.js";
import { registerAgentConnectionConsentTests } from "./agent-connection-consent-cases.js";
import { registerAgentConnectionProviderTests } from "./agent-connection-provider-cases.js";
import { registerAgentConnectionStoreTests } from "./agent-connection-store-cases.js";
import { registerAgentConnectionTenStepTests } from "./agent-connection-ten-step-cases.js";
import { registerAgentConnectionWrapperTests } from "./agent-connection-wrapper-cases.js";
import { registerAgentConnectionTests } from "./agent-connections-cases.js";
import { registerAgentFencingTests } from "./agent-fencing-cases.js";
import { registerAgentRecommendationTests } from "./agent-recommendation-cases.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CommunitySessionService } from "@moya/api";
import {
  createBackendApplication,
  createDevelopmentCatalogFixtureQueryPort,
  startBackendProcess,
} from "@moya/backend-runtime";
import {
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import {
  CommunitySchemaNotReadyError,
  PostgresCommunityCommentAdapter,
  PostgresCommunityIdentityAdapter,
  runCommunityMigrations,
  verifyCommunityMigrationLedger,
} from "@moya/community-postgres";
import {
  developmentSessionSchema,
  publicUserProfileSchema,
} from "@moya/contracts/schemas";
import { UnconfiguredStorageUrlResolver } from "@moya/image";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { requireSyntheticTestDatabaseUrl } from "./synthetic-test-database.js";

import type { BackendProcessHandle } from "@moya/backend-runtime";
import type {
  CatalogCommentId,
  CatalogId,
  PublicUserId,
} from "@moya/contracts";

const testDatabaseUrl = requireSyntheticTestDatabaseUrl();

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const migrationsDirectory = path.join(
  repositoryRoot,
  "database",
  "community-migrations",
);
const seedFile = path.join(
  repositoryRoot,
  "infra",
  "development",
  "community-development-accounts.sql",
);
const pool = createPostgresPool(
  parsePostgresConfig({ DATABASE_URL: testDatabaseUrl }),
);
const processes = new Set<BackendProcessHandle>();
const hour = 60 * 60 * 1_000;

const createService = (
  options: { readonly ttlMs?: number; readonly start?: Date } = {},
) => {
  let now = options.start ?? new Date();
  const service = new CommunitySessionService(
    new PostgresCommunityIdentityAdapter(pool),
    { clock: () => now, sessionTtlMs: options.ttlMs ?? 24 * hour },
  );
  return {
    service,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
  };
};

const startHttp = async (
  nodeEnv: "development" | "production",
): Promise<string> => {
  const handle = await startBackendProcess({
    listen: { host: "127.0.0.1", port: 0 },
    requestListener: createBackendApplication({
      nodeEnv,
      communityIdentityPort: new PostgresCommunityIdentityAdapter(pool),
      ...(nodeEnv === "production"
        ? {
            catalogQueryPort: createDevelopmentCatalogFixtureQueryPort(),
            storageUrlResolver: new UnconfiguredStorageUrlResolver(),
          }
        : {}),
    }),
  });
  processes.add(handle);
  return `http://${handle.address.address}:${handle.address.port}`;
};

beforeAll(async () => {
  // Other suites in this synthetic database only verify the community ledger,
  // so the family is applied idempotently here (never dropped) and the rows
  // are reset before the Development accounts are seeded.
  // `vitest run integration/postgres` runs FILES in parallel, and the
  // publishing worker and app-role files own accounts (with receipts) in this
  // same database while this hook runs. The reset therefore touches only what
  // this file seeds: the Development accounts and the comment/session rows
  // its cases leave behind. Every case here cleans up the accounts it creates.
  await runCommunityMigrations(pool, migrationsDirectory);
  expect(await runCommunityMigrations(pool, migrationsDirectory)).toEqual([]);
  await pool.query(
    "DELETE FROM community.catalog_comment_replies; DELETE FROM community.catalog_comments; DELETE FROM community.sessions; DELETE FROM community.development_accounts",
  );
  await pool.query(
    "DELETE FROM community.public_users WHERE handle LIKE 'dev-user-%'",
  );
  await pool.query(await readFile(seedFile, "utf8"));
  // The Catalog discovery projection, created once for the whole file.
  //
  // It used to be incidental: `phase4-author-cases.ts` creates it in its own
  // `beforeAll` and DROPS it again in `afterAll`, so every later suite in this
  // file saw it only by accident of ordering. That was harmless while nothing
  // else read it — main's `author-adapter.ts` does not.
  //
  // This branch's `relationCount` does (c56d7f4, "bound discovery"), and main
  // then added `profile-background-cases.ts`, which calls `readProfile` after
  // phase4-author has already dropped the table. Neither side is wrong on its
  // own; the dependency is this branch's, so this branch declares it here
  // instead of relying on which suite happens to run first. phase4-author's
  // own probe finds the existing table, records `projectionKind=table` and
  // leaves `createdProjection` false, so it no longer drops what it did not
  // make.
  await pool.query(
    "CREATE TABLE IF NOT EXISTS public.catalog_discovery(catalog_id text PRIMARY KEY,kind text,title text,aliases varchar[],first_published_at timestamptz,filter_metadata jsonb)",
  );
});

afterEach(async () => {
  await Promise.all(
    [...processes].map(async (handle) => {
      await handle.shutdown();
      processes.delete(handle);
    }),
  );
  await pool.query("DELETE FROM community.catalog_comment_replies");
  await pool.query("DELETE FROM community.catalog_comments");
  await pool.query("DELETE FROM community.moderation_events");
  await pool.query("DELETE FROM community.sessions");
  // Back to the initial default the forward migration establishes.
  await pool.query(
    "UPDATE community.publication_setting SET policy = 'DIRECT_PUBLICATION', updated_by = 'platform' WHERE id = 'publication'",
  );
  await pool.query(
    "UPDATE community.public_users SET status = 'active', updated_at = CURRENT_TIMESTAMP",
  );
});

afterAll(async () => {
  await pool.end();
});

describe("community PostgreSQL identity and sessions", () => {
  it("seeds the Development accounts as real public users with Chinese display names", async () => {
    const users = await pool.query<{
      handle: string;
      display_name: string;
      status: string;
    }>(
      `SELECT u.handle, u.display_name, u.status
       FROM community.public_users u
       JOIN community.development_accounts d ON d.user_id = u.id
       ORDER BY u.handle`,
    );
    expect(users.rows).toEqual([
      { handle: "dev-user-01", display_name: "拓片爱好者", status: "active" },
      { handle: "dev-user-02", display_name: "书法学徒", status: "active" },
      { handle: "dev-user-03", display_name: "石刻研究者", status: "active" },
    ]);
    // Re-seeding is idempotent. Counted by the seeded handles: other files in
    // this parallel run own accounts of their own in the same database.
    await pool.query(await readFile(seedFile, "utf8"));
    expect(
      (
        await pool.query(
          "SELECT COUNT(*)::int AS n FROM community.public_users WHERE handle LIKE 'dev-user-%'",
        )
      ).rows[0],
    ).toEqual({ n: 3 });
  });

  it("verifies the ledger read-only and fails closed when it is missing", async () => {
    await expect(verifyCommunityMigrationLedger(pool)).resolves.toBeUndefined();
    // One dedicated client keeps the uncommitted DELETE visible to the check.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM community.schema_migrations");
      const singleClientPool = {
        connect: async () => ({
          query: client.query.bind(client),
          release: () => undefined,
        }),
      } as unknown as typeof pool;
      await expect(
        verifyCommunityMigrationLedger(singleClientPool),
      ).rejects.toBeInstanceOf(CommunitySchemaNotReadyError);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    await expect(verifyCommunityMigrationLedger(pool)).resolves.toBeUndefined();
  });

  it("issues, validates, expires and revokes sessions against real rows", async () => {
    const { service, advance } = createService({ ttlMs: 2 * hour });
    const session = await service.signInDevelopmentAccount("dev-user-01");
    expect(developmentSessionSchema.parse(session)).toEqual(session);
    expect(session?.profile.displayName).toBe("拓片爱好者");

    const stored = await pool.query<{
      token_hash: string;
      user_id: string;
      revoked_at: Date | null;
    }>("SELECT token_hash, user_id, revoked_at FROM community.sessions");
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.rows[0]?.token_hash).not.toBe(session?.token);
    expect(stored.rows[0]?.user_id).toBe(session?.profile.id);

    expect(await service.identify(session!.token)).toEqual(session?.profile);
    advance(2 * hour);
    expect(await service.identify(session!.token)).toBeNull();

    const fresh = await service.signInDevelopmentAccount("dev-user-02");
    expect(await service.signOut(fresh!.token)).toBe(true);
    expect(await service.identify(fresh!.token)).toBeNull();
    expect(await service.signOut(fresh!.token)).toBe(false);
    const revoked = await pool.query<{ revoked_at: Date | null }>(
      "SELECT revoked_at FROM community.sessions WHERE user_id = $1",
      [fresh?.profile.id],
    );
    expect(revoked.rows[0]?.revoked_at).toBeInstanceOf(Date);
  });

  it("isolates accounts and refuses suspended or non-Development users", async () => {
    const { service } = createService();
    const first = await service.signInDevelopmentAccount("dev-user-01");
    const second = await service.signInDevelopmentAccount("dev-user-02");
    expect((await service.identify(first!.token))?.handle).toBe("dev-user-01");
    expect((await service.identify(second!.token))?.handle).toBe("dev-user-02");
    expect(await service.signOut(first!.token)).toBe(true);
    expect((await service.identify(second!.token))?.handle).toBe("dev-user-02");

    await pool.query(
      "UPDATE community.public_users SET status = 'suspended' WHERE handle = 'dev-user-02'",
    );
    expect(await service.identify(second!.token)).toBeNull();
    expect(await service.signInDevelopmentAccount("dev-user-02")).toBeNull();

    await pool.query(
      `INSERT INTO community.public_users (id, handle, display_name)
       VALUES ('user-ffffffffffffffffffffffffffffffff', 'member-99', '拓片爱好者')`,
    );
    expect(await service.signInDevelopmentAccount("member-99")).toBeNull();
    await pool.query(
      "DELETE FROM community.public_users WHERE handle = 'member-99'",
    );
  });

  it("enforces the identity constraints in PostgreSQL", async () => {
    for (const values of [
      ["user-not-opaque", "dev-user-09", "名字"],
      ["user-0123456789abcdef0123456789abcdef", "Dev-User-09", "名字"],
      ["user-0123456789abcdef0123456789abcdef", "dev-user-09", " 名字"],
      ["user-0123456789abcdef0123456789abcdef", "dev-user-01", "重复 handle"],
    ])
      await expect(
        pool.query(
          "INSERT INTO community.public_users (id, handle, display_name) VALUES ($1, $2, $3)",
          values,
        ),
      ).rejects.toThrow();
  });

  it("serves the Development lifecycle over HTTP and excludes it from production composition", async () => {
    const development = await startHttp("development");
    const signedIn = await fetch(`${development}/v1/development/sign-in`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "dev-user-03" }),
    });
    expect(signedIn.status).toBe(201);
    const session = developmentSessionSchema.parse(await signedIn.json());
    const me = await fetch(`${development}/v1/me`, {
      headers: { authorization: `Bearer ${session.token}` },
    });
    expect(me.status).toBe(200);
    expect(publicUserProfileSchema.parse(await me.json())).toEqual(
      session.profile,
    );

    const production = await startHttp("production");
    expect(
      (
        await fetch(`${production}/v1/development/sign-in`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ handle: "dev-user-03" }),
        })
      ).status,
    ).toBe(404);
    // A session issued elsewhere still identifies through the shared store.
    const productionMe = await fetch(`${production}/v1/me`, {
      headers: { authorization: `Bearer ${session.token}` },
    });
    expect(productionMe.status).toBe(200);
    expect(
      (
        await fetch(`${development}/v1/development/sign-out`, {
          method: "POST",
          headers: { authorization: `Bearer ${session.token}` },
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await fetch(`${production}/v1/me`, {
          headers: { authorization: `Bearer ${session.token}` },
        })
      ).status,
    ).toBe(401);
  });
});

const seededAuthor = async (handle: string): Promise<PublicUserId> => {
  const rows = await pool.query<{ id: string }>(
    "SELECT id FROM community.public_users WHERE handle = $1",
    [handle],
  );
  const id = rows.rows[0]?.id;
  if (id === undefined) throw new Error("Seeded Development account missing");
  return id as PublicUserId;
};

const commentAdapter = () => new PostgresCommunityCommentAdapter(pool);

const commentId = (suffix: number): CatalogCommentId =>
  `comment-${suffix.toString(16).padStart(32, "0")}` as CatalogCommentId;

const publishedCatalogId = "catalog-integration-01" as CatalogId;

describe("community PostgreSQL comments and moderation", () => {
  it("stores comments and one level of replies with deterministic order", async () => {
    const port = commentAdapter();
    const author = await seededAuthor("dev-user-01");
    const second = await seededAuthor("dev-user-02");
    const base = new Date("2026-09-12T08:00:00.000Z");

    const root = await port.insertComment({
      id: commentId(1),
      catalogId: publishedCatalogId,
      authorId: author,
      text: "第一条评论",
      moderation: "visible",
      createdAt: base,
    });
    const older = await port.insertComment({
      id: commentId(2),
      catalogId: publishedCatalogId,
      authorId: second,
      text: "更早的评论",
      moderation: "visible",
      createdAt: new Date(base.getTime() - 60_000),
    });
    const replyOne = await port.insertReply({
      id: commentId(3),
      rootCommentId: root.id,
      authorId: second,
      text: "第一条回复",
      moderation: "visible",
      createdAt: new Date(base.getTime() + 1_000),
    });
    const replyTwo = await port.insertReply({
      id: commentId(4),
      rootCommentId: root.id,
      authorId: author,
      text: "第二条回复",
      moderation: "visible",
      createdAt: new Date(base.getTime() + 2_000),
      replyToReplyId: replyOne.id,
    });

    const page = await port.readVisibleComments({
      catalogId: publishedCatalogId,
      page: 1,
      pageSize: 20,
      embeddedReplyLimit: 3,
      hotLimit: 3,
      pinned: [],
    });
    // The replied-to root is hot; the other is the latest list. Replies stay
    // oldest first inside the thread.
    expect(page.hot.map((item) => item.id)).toEqual([root.id]);
    expect(page.items.map((item) => item.id)).toEqual([older.id]);
    expect(page.total).toBe(1);
    expect(page.hot[0]?.replyTotal).toBe(2);
    expect(page.hot[0]?.replies.map((reply) => reply.id)).toEqual([
      replyOne.id,
      replyTwo.id,
    ]);
    expect(page.hot[0]?.replies[1]?.replyTo?.id).toBe(second);
    expect(replyTwo.replyTo?.displayName).toBe("书法学徒");
  });

  it("enforces depth one, same-thread reply pointers and the text bound in PostgreSQL", async () => {
    const port = commentAdapter();
    const author = await seededAuthor("dev-user-01");
    const at = new Date("2026-09-12T09:00:00.000Z");
    const first = await port.insertComment({
      id: commentId(11),
      catalogId: publishedCatalogId,
      authorId: author,
      text: "根评论",
      moderation: "visible",
      createdAt: at,
    });
    const other = await port.insertComment({
      id: commentId(12),
      catalogId: publishedCatalogId,
      authorId: author,
      text: "另一条根评论",
      moderation: "visible",
      createdAt: at,
    });
    const reply = await port.insertReply({
      id: commentId(13),
      rootCommentId: other.id,
      authorId: author,
      text: "另一线程的回复",
      moderation: "visible",
      createdAt: at,
    });

    // A reply-to-reply pointer may not cross threads.
    await expect(
      port.insertReply({
        id: commentId(14),
        rootCommentId: first.id,
        authorId: author,
        text: "跨线程指针",
        moderation: "visible",
        createdAt: at,
        replyToReplyId: reply.id,
      }),
    ).rejects.toThrow();

    // A reply can never become a root, so no tree can form.
    await expect(
      port.insertReply({
        id: commentId(15),
        rootCommentId: reply.id,
        authorId: author,
        text: "回复的回复",
        moderation: "visible",
        createdAt: at,
      }),
    ).rejects.toThrow();

    for (const [text, label] of [
      ["", "empty"],
      [" 前导空白", "untrimmed"],
      ["x".repeat(1_001), "too long"],
    ] as const) {
      await expect(
        pool.query(
          `INSERT INTO community.catalog_comments
             (id, catalog_id, author_id, text, moderation)
           VALUES ($1, $2, $3, $4, 'visible')`,
          [commentId(20), publishedCatalogId, author, text],
        ),
        label,
      ).rejects.toThrow();
    }
    await expect(
      pool.query(
        `INSERT INTO community.catalog_comments
           (id, catalog_id, author_id, text, moderation)
         VALUES ('not-opaque', $1, $2, '文本', 'visible')`,
        [publishedCatalogId, author],
      ),
    ).rejects.toThrow();
    await expect(
      pool.query(
        `INSERT INTO community.catalog_comments
           (id, catalog_id, author_id, text, moderation)
         VALUES ($1, $2, $3, '文本', 'approved')`,
        [commentId(21), publishedCatalogId, author],
      ),
    ).rejects.toThrow();
  });

  it("moderates a comment or a reply and keeps hidden threads out of public reads", async () => {
    const port = commentAdapter();
    const author = await seededAuthor("dev-user-01");
    const at = new Date("2026-09-12T10:00:00.000Z");
    const root = await port.insertComment({
      id: commentId(31),
      catalogId: publishedCatalogId,
      authorId: author,
      text: "待审核的根评论",
      moderation: "pending",
      createdAt: at,
    });
    const reply = await port.insertReply({
      id: commentId(32),
      rootCommentId: root.id,
      authorId: author,
      text: "待审核的回复",
      moderation: "pending",
      createdAt: at,
    });

    expect(
      (
        await port.readVisibleComments({
          catalogId: publishedCatalogId,
          page: 1,
          pageSize: 20,
          embeddedReplyLimit: 3,
          hotLimit: 3,
          pinned: [],
        })
      ).items,
    ).toEqual([]);

    // Unhiding a pending row is not an edge of the machine: no row matches.
    expect(
      await port.applyCommentModeration(
        root.id,
        "visible",
        ["hidden"],
        "owner",
        at,
      ),
    ).toBeNull();

    expect(
      await port.applyCommentModeration(
        root.id,
        "visible",
        ["pending"],
        "owner",
        at,
      ),
    ).toEqual({ id: root.id, kind: "comment", moderation: "visible" });
    expect(
      await port.applyCommentModeration(
        reply.id,
        "visible",
        ["pending"],
        "owner",
        at,
      ),
    ).toEqual({ id: reply.id, kind: "reply", moderation: "visible" });
    expect(
      await port.applyCommentModeration(
        commentId(99),
        "visible",
        ["pending"],
        "owner",
        at,
      ),
    ).toBeNull();

    const visible = await port.readVisibleComments({
      catalogId: publishedCatalogId,
      page: 1,
      pageSize: 20,
      embeddedReplyLimit: 3,
      hotLimit: 3,
      pinned: [],
    });
    // With its one visible reply the root is the hot section.
    expect(visible.items).toEqual([]);
    expect(visible.hot[0]?.replies).toHaveLength(1);

    // Hiding the root removes the thread; the reply row keeps its own state.
    await port.applyCommentModeration(
      root.id,
      "hidden",
      ["visible"],
      "owner",
      at,
    );
    expect(
      (
        await port.readVisibleComments({
          catalogId: publishedCatalogId,
          page: 1,
          pageSize: 20,
          embeddedReplyLimit: 3,
          hotLimit: 3,
          pinned: [],
        })
      ).items,
    ).toEqual([]);
    const stored = await pool.query<{
      moderation: string;
      moderated_by: string;
    }>(
      "SELECT moderation, moderated_by FROM community.catalog_comments WHERE id = $1",
      [root.id],
    );
    expect(stored.rows[0]).toMatchObject({
      moderation: "hidden",
      moderated_by: "owner",
    });
  });

  it("reads the hot section and the latest page in one snapshot and honours pinned ids", async () => {
    const port = commentAdapter();
    const author = await seededAuthor("dev-user-01");
    const replier = await seededAuthor("dev-user-02");
    const base = Date.parse("2026-09-12T12:00:00.000Z");
    const at = (seconds: number) => new Date(base + seconds * 1_000);
    const root = async (n: number, text: string) =>
      port.insertComment({
        id: commentId(n),
        catalogId: publishedCatalogId,
        authorId: author,
        text,
        moderation: "visible",
        createdAt: at(n),
      });
    const reply = async (
      n: number,
      rootCommentId: CatalogCommentId,
      moderation: "visible" | "pending" | "hidden",
    ) =>
      port.insertReply({
        id: commentId(n),
        rootCommentId,
        authorId: replier,
        text: `回复 ${n}`,
        moderation,
        createdAt: at(n),
      });
    const a = await root(41, "甲");
    const b = await root(42, "乙");
    const c = await root(43, "丙");
    const d = await root(44, "丁");
    const e = await root(45, "戊");
    await reply(51, a.id, "visible");
    await reply(52, a.id, "visible");
    await reply(53, b.id, "visible");
    await reply(54, b.id, "hidden");
    await reply(55, b.id, "pending");
    await reply(56, d.id, "visible");
    await reply(57, d.id, "visible");
    await reply(58, d.id, "visible");
    await reply(59, e.id, "visible");

    const first = await port.readVisibleComments({
      catalogId: publishedCatalogId,
      page: 1,
      pageSize: 1,
      embeddedReplyLimit: 3,
      hotLimit: 3,
      pinned: [],
    });
    expect(first.hot.map((item) => item.id)).toEqual([d.id, a.id, e.id]);
    expect(first.hot.map((item) => item.replyTotal)).toEqual([3, 2, 1]);
    expect(first.items.map((item) => item.id)).toEqual([c.id]);
    expect(first.total).toBe(2);

    const second = await port.readVisibleComments({
      catalogId: publishedCatalogId,
      page: 2,
      pageSize: 1,
      embeddedReplyLimit: 3,
      hotLimit: 0,
      pinned: first.hot.map((item) => item.id),
    });
    expect(second.hot).toEqual([]);
    expect(second.items.map((item) => item.id)).toEqual([b.id]);
    // 乙's hidden and pending replies neither count nor embed.
    expect(second.items[0]?.replyTotal).toBe(1);
    expect(second.items[0]?.replies.map((item) => item.id)).toEqual([
      commentId(53),
    ]);
    expect(second.total).toBe(2);

    // Hiding a hot root removes it from the fresh selection; nothing repeats.
    await port.applyCommentModeration(
      d.id,
      "hidden",
      ["visible"],
      "owner",
      at(60),
    );
    const refreshed = await port.readVisibleComments({
      catalogId: publishedCatalogId,
      page: 1,
      pageSize: 20,
      embeddedReplyLimit: 3,
      hotLimit: 3,
      pinned: [],
    });
    expect(refreshed.hot.map((item) => item.id)).toEqual([a.id, e.id, b.id]);
    expect(refreshed.items.map((item) => item.id)).toEqual([c.id]);
  });

  it("flips only the untouched platform seed to DIRECT_PUBLICATION and keeps an Owner choice", async () => {
    const sql = await readFile(
      path.join(
        migrationsDirectory,
        "20260912080000_community_direct_publication_default.sql",
      ),
      "utf8",
    );
    const policy = async () =>
      (
        await pool.query<{ policy: string; updated_by: string }>(
          "SELECT policy, updated_by FROM community.publication_setting WHERE id = 'publication'",
        )
      ).rows[0];

    await pool.query(
      "UPDATE community.publication_setting SET policy = 'PRE_MODERATION', updated_by = 'owner' WHERE id = 'publication'",
    );
    await pool.query(sql);
    expect(await policy()).toEqual({
      policy: "PRE_MODERATION",
      updated_by: "owner",
    });

    await pool.query(
      "UPDATE community.publication_setting SET policy = 'PRE_MODERATION', updated_by = 'platform' WHERE id = 'publication'",
    );
    await pool.query(sql);
    expect(await policy()).toEqual({
      policy: "DIRECT_PUBLICATION",
      updated_by: "platform",
    });
  });

  it("keeps the publication setting a single row and appends every moderation event", async () => {
    const port = commentAdapter();
    const at = new Date("2026-09-12T11:00:00.000Z");
    // A fresh initialization starts in DIRECT_PUBLICATION (forward migration
    // 20260912080000 over the untouched platform seed).
    expect(await port.readPublicationPolicy()).toMatchObject({
      policy: "DIRECT_PUBLICATION",
      updatedBy: "platform",
    });
    await port.writePublicationPolicy("PRE_MODERATION", "owner", at);
    expect(await port.readPublicationPolicy()).toMatchObject({
      policy: "PRE_MODERATION",
      updatedBy: "owner",
    });

    await expect(
      pool.query(
        "INSERT INTO community.publication_setting (id, policy, updated_by) VALUES ('second', 'PRE_MODERATION', 'owner')",
      ),
    ).rejects.toThrow();
    await expect(
      pool.query(
        "UPDATE community.publication_setting SET policy = 'SOMETHING' WHERE id = 'publication'",
      ),
    ).rejects.toThrow();

    await port.recordModerationEvent({
      id: `moderation-${"0".repeat(31)}1`,
      occurredAt: at,
      operatorLabel: "owner",
      action: "approve",
      subjectKind: "comment",
      subjectId: commentId(41),
    });
    const events = await pool.query<{ action: string; operator_label: string }>(
      "SELECT action, operator_label FROM community.moderation_events",
    );
    expect(events.rows).toEqual([
      { action: "approve", operator_label: "owner" },
    ]);
    await expect(
      port.recordModerationEvent({
        id: `moderation-${"0".repeat(31)}2`,
        occurredAt: at,
        operatorLabel: "owner",
        action: "approve" as never,
        subjectKind: "planet" as never,
        subjectId: commentId(41),
      }),
    ).rejects.toThrow();
  });

  it("pages root comments and replies without repeating or dropping a row", async () => {
    const port = commentAdapter();
    const author = await seededAuthor("dev-user-01");
    const base = new Date("2026-09-12T12:00:00.000Z");
    for (let index = 0; index < 5; index += 1) {
      await port.insertComment({
        id: commentId(50 + index),
        catalogId: publishedCatalogId,
        authorId: author,
        text: `评论 ${index}`,
        moderation: "visible",
        createdAt: new Date(base.getTime() + index * 1_000),
      });
    }
    const seen: string[] = [];
    for (const page of [1, 2, 3]) {
      const result = await port.readVisibleComments({
        catalogId: publishedCatalogId,
        page,
        pageSize: 2,
        embeddedReplyLimit: 3,
        hotLimit: 3,
        pinned: [],
      });
      expect(result.total).toBe(5);
      seen.push(...result.items.map((item) => item.id));
    }
    expect(new Set(seen).size).toBe(5);

    const root = commentId(50);
    for (let index = 0; index < 4; index += 1) {
      await port.insertReply({
        id: commentId(60 + index),
        rootCommentId: root,
        authorId: author,
        text: `回复 ${index}`,
        moderation: "visible",
        createdAt: new Date(base.getTime() + index * 1_000),
      });
    }
    const replySeen: string[] = [];
    for (const page of [1, 2]) {
      const result = await port.readVisibleReplies({
        rootCommentId: root,
        page,
        pageSize: 3,
      });
      expect(result.total).toBe(4);
      replySeen.push(...result.items.map((item) => item.id));
    }
    expect(new Set(replySeen).size).toBe(4);
  });

  it("lists the operator queue with author status and moderation state", async () => {
    const port = commentAdapter();
    const author = await seededAuthor("dev-user-03");
    const at = new Date("2026-09-12T13:00:00.000Z");
    await port.insertComment({
      id: commentId(71),
      catalogId: publishedCatalogId,
      authorId: author,
      text: "待审核",
      moderation: "pending",
      createdAt: at,
    });
    await port.insertComment({
      id: commentId(72),
      catalogId: publishedCatalogId,
      authorId: author,
      text: "已公开",
      moderation: "visible",
      createdAt: at,
    });

    const pending = await port.readOperatorComments({
      moderation: "pending",
      order: "newest",
      page: 1,
      pageSize: 20,
    });
    expect(pending.total).toBe(1);
    expect(pending.items[0]).toMatchObject({
      id: commentId(71),
      kind: "comment",
      moderation: "pending",
      author: { handle: "dev-user-03", status: "active" },
    });

    const all = await port.readOperatorComments({
      order: "newest",
      page: 1,
      pageSize: 20,
    });
    expect(all.total).toBe(2);
    expect(all.counts).toEqual({ pending: 1, visible: 1, hidden: 0, all: 2 });
  });

  it("searches, filters, counts and orders the review queue from one snapshot", async () => {
    const port = commentAdapter();
    const one = await seededAuthor("dev-user-01");
    const two = await seededAuthor("dev-user-02");
    const base = Date.parse("2026-09-12T14:00:00.000Z");
    const at = (n: number) => new Date(base + n * 1_000);
    const rootA = await port.insertComment({
      id: commentId(81),
      catalogId: publishedCatalogId,
      authorId: one,
      text: "字口清晰，拓片可见刀痕 100%",
      moderation: "visible",
      createdAt: at(1),
    });
    await port.insertComment({
      id: commentId(82),
      catalogId: "catalog-other-02" as CatalogId,
      authorId: two,
      text: "另一条资料下的评论_下划线",
      moderation: "pending",
      createdAt: at(2),
    });
    const replyA = await port.insertReply({
      id: commentId(83),
      rootCommentId: rootA.id,
      authorId: two,
      text: "回复：同意字口的观察",
      moderation: "hidden",
      createdAt: at(3),
    });
    await port.insertReply({
      id: commentId(84),
      rootCommentId: rootA.id,
      authorId: one,
      text: "再回复",
      moderation: "visible",
      createdAt: at(4),
      replyToReplyId: replyA.id,
    });

    const base1 = { order: "newest" as const, page: 1, pageSize: 20 };
    const everything = await port.readOperatorComments(base1);
    expect(everything.counts).toEqual({
      pending: 1,
      visible: 2,
      hidden: 1,
      all: 4,
    });
    expect(everything.items.map((item) => item.id)).toEqual([
      commentId(84),
      commentId(83),
      commentId(82),
      commentId(81),
    ]);
    expect(everything.items[0]).toMatchObject({
      kind: "reply",
      rootCommentId: rootA.id,
      replyToId: replyA.id,
    });

    const oldest = await port.readOperatorComments({
      ...base1,
      order: "oldest",
    });
    expect(oldest.items.map((item) => item.id)).toEqual([
      commentId(81),
      commentId(82),
      commentId(83),
      commentId(84),
    ]);

    // Search by text, by display name and by handle; counts follow the search.
    const byText = await port.readOperatorComments({
      ...base1,
      search: "字口",
    });
    expect(byText.items.map((item) => item.id)).toEqual([
      commentId(83),
      commentId(81),
    ]);
    expect(byText.counts).toEqual({
      pending: 0,
      visible: 1,
      hidden: 1,
      all: 2,
    });
    const byName = await port.readOperatorComments({
      ...base1,
      search: "书法学徒",
    });
    expect(byName.items.map((item) => item.id)).toEqual([
      commentId(83),
      commentId(82),
    ]);
    const byHandle = await port.readOperatorComments({
      ...base1,
      search: "dev-user-02",
    });
    expect(byHandle.total).toBe(2);
    // Wildcards are literal characters, never patterns.
    expect(
      (await port.readOperatorComments({ ...base1, search: "100%" })).total,
    ).toBe(1);
    expect(
      (await port.readOperatorComments({ ...base1, search: "_下划线" })).total,
    ).toBe(1);
    expect(
      (await port.readOperatorComments({ ...base1, search: "%" })).total,
    ).toBe(1);

    const replies = await port.readOperatorComments({
      ...base1,
      kind: "reply",
      moderation: "visible",
    });
    expect(replies.items.map((item) => item.id)).toEqual([commentId(84)]);
    expect(replies.counts).toEqual({
      pending: 0,
      visible: 1,
      hidden: 1,
      all: 2,
    });
    const otherRecord = await port.readOperatorComments({
      ...base1,
      catalogId: "catalog-other-02" as CatalogId,
    });
    expect(otherRecord.items.map((item) => item.id)).toEqual([commentId(82)]);

    const paged = await port.readOperatorComments({
      order: "newest",
      page: 2,
      pageSize: 3,
    });
    expect(paged.items.map((item) => item.id)).toEqual([commentId(81)]);
    expect(paged.total).toBe(4);

    expect(await port.findOperatorComment(commentId(84))).toMatchObject({
      id: commentId(84),
      kind: "reply",
      replyToId: replyA.id,
      author: { handle: "dev-user-01" },
    });
    expect(await port.findOperatorComment(commentId(99))).toBeNull();
  });

  it("stores the reject action, reads the history by subject and summarizes a range", async () => {
    const port = commentAdapter();
    const base = Date.parse("2026-09-12T15:00:00.000Z");
    const at = (n: number) => new Date(base + n * 60_000);
    const eventId = (n: number) =>
      `moderation-${n.toString(16).padStart(32, "0")}`;
    const subject = commentId(91);
    await port.recordModerationEvent({
      id: eventId(1),
      occurredAt: at(0),
      operatorLabel: "owner",
      action: "reject",
      subjectKind: "comment",
      subjectId: subject,
    });
    await port.recordModerationEvent({
      id: eventId(2),
      occurredAt: at(1),
      operatorLabel: "owner",
      action: "unhide",
      subjectKind: "comment",
      subjectId: subject,
    });
    await port.recordModerationEvent({
      id: eventId(3),
      occurredAt: at(2),
      operatorLabel: "owner",
      action: "set_publication_policy",
      subjectKind: "setting",
      subjectId: "publication",
      detail: "PRE_MODERATION",
    });
    // The migration widened the action set to reject and nothing else.
    await expect(
      pool.query(
        "INSERT INTO community.moderation_events (id, operator_label, action, subject_kind, subject_id) VALUES ($1, 'owner', 'delete', 'comment', $2)",
        [eventId(4), subject],
      ),
    ).rejects.toThrow();

    const history = await port.readModerationEvents({
      subjectId: subject,
      page: 1,
      pageSize: 20,
    });
    expect(history.total).toBe(2);
    expect(history.items.map((event) => event.action)).toEqual([
      "unhide",
      "reject",
    ]);
    const rejections = await port.readModerationEvents({
      action: "reject",
      page: 1,
      pageSize: 20,
    });
    expect(rejections.items.map((event) => event.id)).toEqual([eventId(1)]);

    const summary = await port.readModerationSummary({
      from: at(0),
      to: at(2),
    });
    // [from, to): the policy change at at(2) falls outside the range.
    expect(summary.actions).toMatchObject({
      reject: 1,
      unhide: 1,
      set_publication_policy: 0,
    });
    expect(summary.recentEvents.map((event) => event.id)).toEqual([
      eventId(3),
      eventId(2),
      eventId(1),
    ]);
    expect(summary.queue.all).toBe(
      summary.queue.pending + summary.queue.visible + summary.queue.hidden,
    );
  });
});

registerPhase4AuthorTests(pool);
registerProfileBackgroundTests(pool);

registerPhase4DiscoveryTests(pool);

registerWorkPublishingMediaTests(pool);
registerAgentAdministrationTests(pool);
registerAgentRecommendationTests(pool);
registerAgentFencingTests(pool);
registerAgentConnectionTests(pool);
registerAgentConnectionStoreTests(pool);
registerAgentConnectionWrapperTests(pool);
registerAgentConnectionTenStepTests(pool);
registerAgentConnectionProviderTests(pool);
registerAgentConnectionConsentTests(pool);
registerAgentAuthorizationFlowTests(pool);

registerWorkPublishingContentTests(pool);
registerThreadTests(pool);
registerDirectMessageTests(pool);
