import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { NotificationService } from "@moya/api";
import {
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import {
  PostgresNotificationAdapter,
  PostgresAuthorCommunityAdapter,
  PostgresCommunityCommentAdapter,
  PostgresWorkPublishingAdapter,
  PostgresPublishingOperatorAdapter,
  runCommunityMigrations,
} from "@moya/community-postgres";
import {
  articleIdSchema,
  catalogCommentIdSchema,
} from "@moya/contracts/schemas";
import type { WorkSubmissionContent } from "@moya/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireSyntheticTestDatabaseUrl } from "./synthetic-test-database.js";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const target = requireSyntheticTestDatabaseUrl();
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(target).hostname))
  throw Error("Loopback synthetic database required");
const poolFor = (url: string) =>
  createPostgresPool(parsePostgresConfig({ DATABASE_URL: url }));
const admin = poolFor(target);
const key = (prefix: string) => `${prefix}-${randomBytes(16).toString("hex")}`;
const now = new Date("2026-09-22T12:00:00Z");
const request = () => ({ requestId: randomUUID() });
const content = (body = ""): WorkSubmissionContent => ({
  title: "通知合成作品",
  body,
  authorship: null,
  visibility: "public",
  items: [],
  coverKey: null,
  coverCrop: null,
});
const guard = await import(
  new URL("../../../scripts/disposable-test-target.mjs", import.meta.url).href
);
afterAll(async () => {
  await admin.end();
});

describe.each(["clean", "upgrade"])("notification App-role %s", (mode) => {
  const suffix = randomBytes(6).toString("hex"),
    database = `notification_${suffix}_synthetic_test`,
    role = `notification_${suffix}`;
  let setup: ReturnType<typeof poolFor> | undefined,
    app: ReturnType<typeof poolFor> | undefined,
    createdDB = false,
    createdRole = false;
  let inbox: PostgresNotificationAdapter,
    service: NotificationService,
    comments: PostgresCommunityCommentAdapter,
    authors: PostgresAuthorCommunityAdapter,
    publishing: PostgresWorkPublishingAdapter;
  const alice = key("user"),
    bob = key("user"),
    cara = key("user"),
    dana = key("user");
  let work = "";
  // parallel-community-integration-qa: C publishes Articles through the
  // published-only public.article_entries projection. A withdrawn or never
  // published Article simply has no row there.
  const articleId = () =>
    articleIdSchema.parse(`article-${randomBytes(16).toString("hex")}`);
  const publishedArticle = articleId(),
    unpublishedArticle = articleId(),
    withdrawnArticle = articleId();
  const pump = async () => {
    for (let i = 0; i < 10; i++) {
      const claims = await inbox.claim("test-worker", 20);
      if (!claims.length) return;
      await Promise.all(claims.map((claim) => inbox.project(claim)));
    }
    throw Error("Unexpected unbounded work");
  };
  const page = (owner: string) => service.list(owner, "all", 50);
  beforeAll(async () => {
    const probe = await admin.query(guard.disposableTestTargetProbeSql);
    guard.assertDisposableTestTarget(
      probe.rows,
      decodeURI(new URL(target).pathname.slice(1)),
    );
    const password = randomBytes(32).toString("hex");
    await admin.query(
      `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`,
    );
    createdRole = true;
    await admin.query(`CREATE DATABASE ${database}`);
    createdDB = true;
    const url = new URL(target);
    url.pathname = `/${database}`;
    setup = poolFor(url.toString());
    await runCommunityMigrations(
      setup,
      `${root}/database/community-migrations`,
      mode === "upgrade" ? { through: "20260921010000" } : {},
    );
    await setup.query(
      "INSERT INTO community.public_users(id,handle,display_name) VALUES($1,'reader-alice','同名读者'),($2,'reader-bob','同名读者'),($3,'reader-cara','读者丙'),($4,'reader-dana','读者丁')",
      [alice, bob, cara, dana],
    );
    if (mode === "upgrade")
      await setup.query(
        "INSERT INTO community.catalog_comments(id,catalog_id,author_id,text,moderation) VALUES($1,'synthetic-catalog',$2,'旧评论','visible')",
        [key("comment"), bob],
      );
    await runCommunityMigrations(
      setup,
      `${root}/database/community-migrations`,
    );
    await setup.query(
      "CREATE TABLE public.catalog_entries(catalog_id text PRIMARY KEY,province text,province_state text); CREATE TABLE public.catalog_discovery(catalog_id text PRIMARY KEY,kind text,title text,aliases varchar[],first_published_at timestamptz,filter_metadata jsonb); CREATE TABLE public.catalog_media(catalog_id text,media_id text,object_key text,width integer,height integer,is_representative boolean); CREATE TABLE public.article_entries(article_id text PRIMARY KEY,title text)",
    );
    await setup.query(
      "INSERT INTO public.catalog_discovery(catalog_id) VALUES('synthetic-catalog')",
    );
    await setup.query(
      "INSERT INTO public.article_entries(article_id,title) VALUES($1,'合成文章'),($2,'待撤回文章')",
      [publishedArticle, withdrawnArticle],
    );
    await setup.query(
      (
        await readFile(
          `${root}/infra/development/work-publishing/grant-runtime.sql`,
          "utf8",
        )
      ).replaceAll(':"app_role"', `"${role}"`),
    );
    url.username = role;
    url.password = password;
    app = poolFor(url.toString());
    inbox = new PostgresNotificationAdapter(app);
    service = new NotificationService(inbox);
    comments = new PostgresCommunityCommentAdapter(app);
    authors = new PostgresAuthorCommunityAdapter(app);
    publishing = new PostgresWorkPublishingAdapter(app);
    expect(
      (
        await app.query(
          "SELECT current_user,rolsuper FROM pg_roles WHERE rolname=current_user",
        )
      ).rows,
    ).toEqual([{ current_user: role, rolsuper: false }]);
    expect(await inbox.claim("initial", 20)).toEqual([]);
    const operator = new PostgresPublishingOperatorAdapter(app),
      settings = await operator.readSettings();
    await operator.setSettings(
      "synthetic-operator",
      {
        ...settings,
        ...request(),
        expectedVersion: settings.version,
        policy: "DIRECT_PUBLICATION",
      },
      now,
    );
    await setup.query(
      "UPDATE community.publication_setting SET policy='DIRECT_PUBLICATION'",
    );
    const draft = await publishing.createDraft(
      alice,
      { ...request(), content: content(), deviceClass: "desktop" },
      now,
    );
    const published = await publishing.submit(
      alice,
      {
        ...request(),
        holder: { draftId: draft.id },
        baseRevisionId: draft.baseRevisionId,
        content: draft.content,
      },
      now,
    );
    if (published.state !== "confirmed")
      throw Error("Expected direct publication");
    work = published.workId;
    await pump();
  }, 30_000);
  afterAll(async () => {
    await app?.end();
    await setup?.end();
    if (createdDB) await admin.query(`DROP DATABASE ${database}`);
    if (createdRole) await admin.query(`DROP ROLE ${role}`);
  });

  it("delivers real likes/comments/replies with overlap deduplication and no self effects", async () => {
    const targetWork = { type: "work" as const, id: work };
    await authors.changeRelation(bob, "like", {
      ...request(),
      target: targetWork,
      enabled: true,
    });
    await authors.changeRelation(cara, "like", {
      ...request(),
      target: targetWork,
      enabled: true,
    });
    await authors.changeRelation(alice, "like", {
      ...request(),
      target: targetWork,
      enabled: true,
    });
    const rootComment = await comments.submitDiscussion(
      targetWork,
      bob,
      "@reader-alice @reader-cara",
      undefined,
      undefined,
      [
        { userId: alice, handle: "reader-alice", start: 0, end: 13 },
        { userId: cara, handle: "reader-cara", start: 14, end: 26 },
      ],
    );
    await comments.submitDiscussion(
      targetWork,
      cara,
      "@reader-bob",
      rootComment.id,
      undefined,
      [{ userId: bob, handle: "reader-bob", start: 0, end: 11 }],
    );
    await comments.setDiscussionLike(dana, rootComment.id, true, randomUUID());
    await pump();
    const a = await page(alice),
      b = await page(bob),
      c = await page(cara);
    expect(a.unread).toEqual({ total: 3, likes: 1, comments: 1, mentions: 1 });
    expect(a.items.find((i) => i.reason === "like")?.actorCount).toBe(2);
    expect(b.items.map((i) => i.reason).sort()).toEqual(["like", "reply"]);
    expect(c.items.map((i) => i.reason)).toEqual(["mention"]);
    expect((await page(dana)).items).toEqual([]);
    expect(
      (
        await setup!.query(
          "SELECT reasons FROM community.notification_deliveries WHERE action_key=$1 AND recipient_id=$2",
          [`comment:${rootComment.id}`, alice],
        )
      ).rows[0]?.reasons,
    ).toEqual(["mention", "comment"]);
    await authors.changeRelation(bob, "like", {
      ...request(),
      target: targetWork,
      enabled: false,
    });
    await pump();
    expect(
      (await page(alice)).items.find((i) => i.reason === "like")?.actorCount,
    ).toBe(1);
    await authors.changeRelation(bob, "like", {
      ...request(),
      target: targetWork,
      enabled: true,
    });
    await pump();
    expect((await page(alice)).unread.total).toBe(3);
  });
  it("scopes signed cursors/reads and leaves newer committed effects unread", async () => {
    const observed = await service.list(alice, "all", 1);
    expect(observed.nextCursor).not.toBeNull();
    await expect(
      service.list(bob, "all", 1, observed.nextCursor!),
    ).rejects.toThrow();
    await expect(
      service.list(alice, "likes", 1, observed.nextCursor!),
    ).rejects.toThrow();
    await expect(service.read(bob, observed.observation)).rejects.toThrow();
    await expect(
      service.read(alice, `${observed.observation}x`),
    ).rejects.toThrow();
    const later = await comments.submitDiscussion(
      { type: "work", id: work },
      dana,
      "较晚提交",
    );
    await pump();
    await service.read(alice, observed.observation);
    expect(
      (await page(alice)).items.filter((i) => i.unread).map((i) => i.commentId),
    ).toEqual([later.id]);
    const tail = await service.list(alice, "all", 50, observed.nextCursor!);
    expect(tail.items.some((i) => i.commentId === later.id)).toBe(false);
    await expect(
      inbox.markRead(alice, "9223372036854775807"),
    ).rejects.toThrow();
  });
  it("recovers an expired worker lease and serializes recipient revisions across out-of-order source delivery", async () => {
    const lower = await comments.submitDiscussion(
      { type: "work", id: work },
      bob,
      "较早行为，较晚投递",
    );
    const olderClaim = (await inbox.claim("crashed", 1))[0]!;
    const higher = await comments.submitDiscussion(
      { type: "work", id: work },
      cara,
      "较晚行为，较早投递",
    );
    const higherClaim = (await inbox.claim("other", 1))[0]!;
    await inbox.project(higherClaim);
    const observed = await page(alice);
    expect(observed.items[0]?.commentId).toBe(higher.id);
    await service.read(alice, observed.observation);
    await setup!.query(
      "UPDATE community.notification_sources SET lease_until=CURRENT_TIMESTAMP-interval '1 second' WHERE action_key=$1",
      [olderClaim.actionKey],
    );
    const reclaimed = (await inbox.claim("recovered", 1))[0]!;
    expect(await inbox.project(olderClaim)).toEqual([]);
    await Promise.all([inbox.project(reclaimed), inbox.project(reclaimed)]);
    expect(
      (await page(alice)).items.filter((i) => i.unread).map((i) => i.commentId),
    ).toEqual([lower.id]);
    const revisions = (
      await app!.query(
        "SELECT revision::integer AS revision FROM community.notification_deliveries WHERE recipient_id=$1 ORDER BY revision",
        [alice],
      )
    ).rows.map((r) => r.revision);
    expect(revisions).toEqual(
      Array.from({ length: revisions.length }, (_, i) => i + 1),
    );
  });
  it("hides pending/private/blocked/suspended/deleted sources at delivery and read time", async () => {
    await setup!.query(
      "UPDATE community.publication_setting SET policy='PRE_MODERATION'",
    );
    const pending = await comments.submitDiscussion(
      { type: "work", id: work },
      bob,
      "待审核内容",
    );
    await pump();
    expect(
      (await page(alice)).items.some((i) => i.commentId === pending.id),
    ).toBe(false);
    await comments.applyCommentModeration(
      catalogCommentIdSchema.parse(pending.id),
      "visible",
      ["pending"],
      "synthetic-operator",
      now,
    );
    await pump();
    expect(
      (await page(alice)).items.some((i) => i.commentId === pending.id),
    ).toBe(true);
    await comments.applyCommentModeration(
      catalogCommentIdSchema.parse(pending.id),
      "hidden",
      ["visible"],
      "synthetic-operator",
      now,
    );
    await pump();
    expect((await page(alice)).items.some((i) => i.text === "待审核内容")).toBe(
      false,
    );
    await setup!.query(
      "UPDATE community.public_users SET status='suspended' WHERE id=$1",
      [bob],
    );
    expect(
      (await page(alice)).items
        .flatMap((i) => i.actors)
        .some((a) => a.id === bob),
    ).toBe(false);
    await setup!.query(
      "UPDATE community.public_users SET status='active' WHERE id=$1",
      [bob],
    );
    await authors.block(alice, { ...request(), targetId: bob, enabled: true });
    expect(
      (await page(alice)).items
        .flatMap((i) => i.actors)
        .some((a) => a.id === bob),
    ).toBe(false);
    await authors.block(alice, { ...request(), targetId: bob, enabled: false });
    await comments.deleteDiscussionBody(
      cara,
      (await page(bob)).items.find((i) => i.reason === "reply")!.commentId!,
      randomUUID(),
    );
    expect(
      (await page(bob)).items.find((i) => i.reason === "reply")?.available,
    ).toBe(false);
    await setup!.query(
      "UPDATE community.publication_setting SET policy='DIRECT_PUBLICATION'",
    );
    const waiting = await comments.submitDiscussion(
      { type: "work", id: work },
      dana,
      "提交后作品暂时私密",
    );
    await publishing.setVisibility(
      alice,
      work,
      { ...request(), visibility: "self" },
      now,
    );
    const hidden = await page(alice);
    expect(hidden.unread.total).toBe(0);
    expect(
      hidden.items.every(
        (i) =>
          !i.available && !i.text && i.target === null && i.actors.length === 0,
      ),
    ).toBe(true);
    await pump();
    expect(
      (await page(alice)).items.some((item) => item.commentId === waiting.id),
    ).toBe(false);
    await publishing.setVisibility(
      alice,
      work,
      { ...request(), visibility: "public" },
      now,
    );
    await pump();
    expect(
      (await page(alice)).items.some(
        (item) => item.commentId === waiting.id && item.available,
      ),
    ).toBe(true);
  });
  it("validates real lookup identities and freezes Work mention references with immutable revisions", async () => {
    expect(
      (await service.lookup(alice, "同名")).items.map((i) => i.id).sort(),
    ).toEqual([alice, bob].sort());
    await expect(
      comments.submitDiscussion(
        { type: "work", id: work },
        bob,
        "@reader-cara",
        undefined,
        undefined,
        [{ userId: dana, handle: "reader-cara", start: 0, end: 12 }],
      ),
    ).rejects.toThrow();
    const draft = await publishing.createDraft(
      alice,
      {
        ...request(),
        content: {
          ...content("@reader-dana"),
          mentions: [
            { userId: dana, handle: "reader-dana", start: 0, end: 12 },
          ],
        },
        deviceClass: "desktop",
      },
      now,
    );
    const published = await publishing.submit(
      alice,
      {
        ...request(),
        holder: { draftId: draft.id },
        baseRevisionId: draft.baseRevisionId,
        content: draft.content,
      },
      now,
    );
    expect(published.state).toBe("confirmed");
    await pump();
    expect((await page(dana)).items.map((i) => i.reason)).toEqual(["mention"]);
    if (published.state !== "confirmed") throw Error("Expected published Work");
    await service.read(dana, (await page(dana)).observation);
    for (const body of ["没有提及", "@reader-dana"]) {
      const edit = (
        await publishing.openEditDraft(
          alice,
          published.workId,
          { ...request(), deviceClass: "desktop" },
          now,
        )
      ).draft;
      await publishing.submit(
        alice,
        {
          ...request(),
          holder: { draftId: edit.id },
          baseRevisionId: edit.baseRevisionId,
          content: {
            ...content(body),
            ...(body.startsWith("@")
              ? {
                  mentions: [
                    { userId: dana, handle: "reader-dana", start: 0, end: 12 },
                  ],
                }
              : {}),
          },
        },
        now,
      );
      await pump();
      expect((await page(dana)).items).toHaveLength(1);
      expect((await page(dana)).unread.total).toBe(0);
      expect((await page(dana)).items[0]!.available).toBe(body.startsWith("@"));
    }
    await setup!.query(
      "UPDATE community.public_users SET handle='renamed-dana' WHERE id=$1",
      [dana],
    );
    expect((await page(dana)).items).toHaveLength(1);
    await expect(
      comments.submitDiscussion(
        { type: "work", id: work },
        bob,
        "@reader-dana",
        undefined,
        undefined,
        [{ userId: dana, handle: "reader-dana", start: 0, end: 12 }],
      ),
    ).rejects.toThrow();
    await expect(
      app!.query("UPDATE community.work_revisions SET mentions='[]'::jsonb"),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      app!.query("DELETE FROM community.notification_deliveries"),
    ).rejects.toMatchObject({ code: "42501" });
  });
  it("uses real Catalog reply, like and mention sources without inventing a Catalog owner", async () => {
    const catalog = { type: "catalog" as const, id: "synthetic-catalog" };
    const root = await comments.submitDiscussion(catalog, bob, "目录评论");
    const reply = await comments.submitDiscussion(
      catalog,
      cara,
      "@reader-alice",
      root.id,
      undefined,
      [{ userId: alice, handle: "reader-alice", start: 0, end: 13 }],
    );
    await comments.setDiscussionLike(alice, root.id, true, randomUUID());
    await pump();
    expect(
      (await page(alice)).items.some(
        (item) => item.commentId === reply.id && item.reason === "mention",
      ),
    ).toBe(true);
    expect(
      (await page(bob)).items
        .filter((item) => item.target?.id === catalog.id)
        .map((item) => item.reason)
        .sort(),
    ).toEqual(["like", "reply"]);
    expect(
      (await page(cara)).items.some((item) => item.commentId === root.id),
    ).toBe(false);
    await setup!.query(
      "DELETE FROM public.catalog_discovery WHERE catalog_id=$1",
      [catalog.id],
    );
    expect(
      (await page(bob)).items
        .filter((item) => item.available)
        .some((item) => item.target?.id === catalog.id),
    ).toBe(false);
  });
  it("does not create notification sources for unchanged historical likes", async () => {
    const old = await comments.submitDiscussion(
      { type: "work", id: work },
      bob,
      "历史点赞目标",
    );
    await pump();
    await setup!.query(
      "INSERT INTO community.comment_likes(comment_id,user_id) VALUES($1,$2)",
      [old.id, cara],
    );
    await comments.setDiscussionLike(cara, old.id, true, randomUUID());
    expect(
      (
        await app!.query(
          "SELECT 1 FROM community.notification_sources WHERE action_key=$1",
          [`comment_like:${old.id}:${cara}`],
        )
      ).rowCount,
    ).toBe(0);
    // A genuinely new unlike/re-like interaction remains a supported task-era source.
    await comments.setDiscussionLike(cara, old.id, false, randomUUID());
    await comments.setDiscussionLike(cara, old.id, true, randomUUID());
    await pump();
    expect(
      (await page(bob)).items.some(
        (item) => item.commentId === old.id && item.reason === "like",
      ),
    ).toBe(true);
  });
  it("keeps a lower preallocated source committed later unread after an observed mark-all", async () => {
    await pump();
    const lateId = "comment-00000000000000000000000000000001";
    const held = await app!.connect();
    try {
      await held.query("BEGIN");
      await held.query(
        "INSERT INTO community.catalog_comments(id,catalog_id,target_type,author_id,text,moderation,was_public) VALUES($1,$2,'work',$3,'较小标识较晚提交','visible',true)",
        [lateId, work, bob],
      );
      await held.query(
        "INSERT INTO community.notification_sources(action_key,kind,subject_id,actor_id) VALUES($1,'comment',$2,$3)",
        [`comment:${lateId}`, lateId, bob],
      );
      const earlier = await comments.submitDiscussion(
        { type: "work", id: work },
        cara,
        "较大标识先提交",
      );
      await pump();
      const observed = await page(alice);
      expect(observed.items[0]!.commentId).toBe(earlier.id);
      expect(observed.items.some((item) => item.commentId === lateId)).toBe(
        false,
      );
      await service.read(alice, observed.observation);
      await held.query("COMMIT");
      await pump();
      await service.read(alice, observed.observation);
      expect(
        (await page(alice)).items
          .filter((item) => item.unread)
          .map((item) => item.commentId),
      ).toEqual([lateId]);
    } finally {
      await held.query("ROLLBACK");
      held.release();
    }
  });
  // parallel-community-integration-qa: C Articles participate in N notifications
  // through the published-only projection. No Article owner is invented; every
  // recipient is a real comment, reply or mention user.
  it("notifies real Article comment recipients without inventing an Article owner", async () => {
    const article = { type: "article" as const, id: publishedArticle };
    // (4) a top-level Article comment has no owner to notify.
    const plain = await comments.submitDiscussion(article, bob, "文章评论");
    await pump();
    expect(
      (
        await setup!.query(
          "SELECT recipient_id FROM community.notification_deliveries WHERE action_key=$1",
          [`comment:${plain.id}`],
        )
      ).rows,
    ).toEqual([]);
    // (1) and (3) a published Article comment mentioning a user notifies exactly
    // that PublicUserId.
    const mentioned = await comments.submitDiscussion(
      article,
      bob,
      "@reader-cara",
      undefined,
      undefined,
      [{ userId: cara, handle: "reader-cara", start: 0, end: 12 }],
    );
    // (2) a reply notifies the root author once, with no duplicate.
    const reply = await comments.submitDiscussion(
      article,
      cara,
      "文章回复",
      plain.id,
    );
    await pump();
    const c = await page(cara);
    const mention = c.items.find((i) => i.commentId === mentioned.id);
    expect(mention?.reason).toBe("mention");
    expect(mention?.available).toBe(true);
    expect(mention?.actors.map((a) => a.id)).toEqual([bob]);
    expect(
      (
        await setup!.query(
          "SELECT recipient_id,reasons FROM community.notification_deliveries WHERE action_key=$1",
          [`comment:${reply.id}`],
        )
      ).rows,
    ).toEqual([{ recipient_id: bob, reasons: ["reply"] }]);
    // (5) the actor is never their own recipient.
    expect(
      (await page(bob)).items.filter((i) => i.actors.some((a) => a.id === bob)),
    ).toEqual([]);
    // (8) exact navigation keeps the Article target and the precise comment.
    const b = await page(bob);
    const navigable = b.items.find((i) => i.commentId === reply.id);
    expect(navigable?.target).toEqual({
      type: "article",
      id: publishedArticle,
    });
    expect(navigable?.commentId).toBe(reply.id);
  });

  it("never delivers or leaks text for an unpublished or withdrawn Article", async () => {
    // (7) an Article with no published projection row delivers nothing.
    const pendingRoot = await comments.submitDiscussion(
      { type: "article", id: unpublishedArticle },
      bob,
      "未发布文章根评论",
    );
    const pendingReply = await comments.submitDiscussion(
      { type: "article", id: unpublishedArticle },
      cara,
      "未发布文章回复",
      pendingRoot.id,
    );
    await pump();
    expect(
      (
        await setup!.query(
          "SELECT recipient_id FROM community.notification_deliveries WHERE action_key=$1",
          [`comment:${pendingReply.id}`],
        )
      ).rows,
    ).toEqual([]);
    // (6) an Article withdrawn after delivery becomes the safe unavailable
    // state: no excerpt, no actor, no navigable target, and not unread.
    const secret = "撤回后不得泄露的评论正文";
    const withdrawnRoot = await comments.submitDiscussion(
      { type: "article", id: withdrawnArticle },
      bob,
      "待撤回文章根评论",
    );
    const live = await comments.submitDiscussion(
      { type: "article", id: withdrawnArticle },
      cara,
      secret,
      withdrawnRoot.id,
    );
    await pump();
    const before = (await page(bob)).items.find((i) => i.commentId === live.id);
    expect(before?.available).toBe(true);
    expect(before?.text).toContain(secret);
    await setup!.query(
      "DELETE FROM public.article_entries WHERE article_id=$1",
      [withdrawnArticle],
    );
    const after = await page(bob);
    const hidden = after.items.find((i) => i.id === before!.id);
    expect(hidden?.available).toBe(false);
    expect(hidden?.text).toBe("");
    expect(hidden?.target).toBeNull();
    expect(hidden?.commentId).toBeNull();
    expect(hidden?.actors).toEqual([]);
    expect(hidden?.unread).toBe(false);
    expect(JSON.stringify(after)).not.toContain(secret);
  });

  it("leaves Catalog and Work notification behaviour unchanged", async () => {
    // (9) the pre-existing targets still resolve exactly as before. An earlier
    // case withdraws 'synthetic-catalog' from the discovery projection on
    // purpose, so this case publishes its own Catalog to observe live
    // behaviour rather than the (also correct) unavailable state.
    const catalogId = key("catalog");
    await setup!.query(
      "INSERT INTO public.catalog_discovery(catalog_id) VALUES($1)",
      [catalogId],
    );
    const catalog = { type: "catalog" as const, id: catalogId };
    const catalogRoot = await comments.submitDiscussion(
      catalog,
      bob,
      "@reader-cara",
      undefined,
      undefined,
      [{ userId: cara, handle: "reader-cara", start: 0, end: 12 }],
    );
    const workRoot = await comments.submitDiscussion(
      { type: "work", id: work },
      bob,
      "作品评论",
    );
    await pump();
    // Deliveries are asserted directly: page items are grouped, so a lookup by
    // commentId is not a stable identity for a single action.
    const deliveries = async (actionKey: string) =>
      (
        await setup!.query<{ recipient_id: string; reasons: string[] }>(
          "SELECT recipient_id,reasons FROM community.notification_deliveries WHERE action_key=$1 ORDER BY recipient_id",
          [actionKey],
        )
      ).rows;
    expect(await deliveries(`comment:${catalogRoot.id}`)).toEqual([
      { recipient_id: cara, reasons: ["mention"] },
    ]);
    expect(await deliveries(`comment:${workRoot.id}`)).toEqual([
      { recipient_id: alice, reasons: ["comment"] },
    ]);
    // Both legacy target kinds still resolve to their own identities.
    const targets = (items: readonly { target: unknown }[]) =>
      items.map((i) => i.target).filter(Boolean);
    expect(targets((await page(cara)).items)).toContainEqual(catalog);
    expect(targets((await page(alice)).items)).toContainEqual({
      type: "work",
      id: work,
    });
  });
});
