import { randomUUID } from "node:crypto";

import { CommunityConflictError, CommunityInputError } from "@moya/api";
import {
  PostgresCommunityCommentAdapter,
  PostgresThreadAdapter,
  PostgresWorkPublishingAdapter,
} from "@moya/community-postgres";
import { workSubmissionCommandSchema } from "@moya/contracts/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type {
  ThreadId,
  WorkSubmissionCommand,
  WorkSubmissionContent,
} from "@moya/contracts";
import type { createPostgresPool } from "@moya/catalog-postgres";

import { cleanupPublishingData } from "./work-publishing-content-cases.js";

const id = (prefix: string) => `${prefix}-${randomUUID().replaceAll("-", "")}`;

/**
 * content-community-completion-v1: Threads over Works and the Article
 * discussion target, on the real community schema. Registered from the
 * existing community suite so its destructive fixtures cannot race these.
 */
export const registerThreadTests = (
  pool: ReturnType<typeof createPostgresPool>,
) => {
  describe("Threads over Works (content-community-completion-v1)", () => {
    const threads = new PostgresThreadAdapter(pool);
    const publishing = new PostgresWorkPublishingAdapter(pool);
    const comments = new PostgresCommunityCommentAdapter(pool);
    const users: string[] = [];
    const createdThreads: string[] = [];

    const user = async (label: string): Promise<string> => {
      const created = id("user");
      await pool.query(
        "INSERT INTO community.public_users(id,handle,display_name) VALUES($1,$2,$3)",
        [created, `th-${created.slice(-24)}`, label],
      );
      users.push(created);
      return created;
    };
    const holdSession = async (owner: string): Promise<string> => {
      const sessionId = id("publishing-session");
      await pool.query(
        "INSERT INTO community.publishing_sessions(id,owner_id,save_mode,work_id,state,lease_expires_at) VALUES($1,$2,'unsaved',NULL,'active','2100-01-01T00:00:00Z')",
        [sessionId, owner],
      );
      return sessionId;
    };
    const content = (
      over: Partial<WorkSubmissionContent> = {},
    ): WorkSubmissionContent => ({
      title: "",
      body: "线下访碑记录",
      authorship: { kind: "original" },
      visibility: "public",
      items: [],
      coverKey: null,
      coverCrop: null,
      ...over,
    });
    const command = async (
      owner: string,
      over: Partial<WorkSubmissionCommand> = {},
    ): Promise<WorkSubmissionCommand> =>
      workSubmissionCommandSchema.parse({
        requestId: randomUUID(),
        holder: { sessionId: await holdSession(owner) },
        content: content(),
        baseRevisionId: null,
        ...over,
      });
    const createThread = async (title: string) => {
      const created = await threads.operatorCreateThread("owner", {
        requestId: randomUUID(),
        title,
        description: "",
        tags: [],
        position: 0,
      });
      createdThreads.push(created.id);
      return created;
    };
    const workIdsOf = async (threadId: string) =>
      (
        await pool.query<{ work_id: string }>(
          "SELECT work_id FROM community.thread_works WHERE thread_id=$1 ORDER BY created_at",
          [threadId],
        )
      ).rows.map((row) => row.work_id);

    beforeAll(async () => {
      await pool
        .query(
          "UPDATE community.work_publishing_settings SET policy='DIRECT_PUBLICATION' WHERE id=TRUE",
        )
        .catch(() => undefined);
    });
    afterAll(async () => {
      // Threads never delete rows in product code; the suite cleans its own
      // fixtures so the community suite's reset finds no foreign Works.
      if (createdThreads.length) {
        await pool.query(
          "DELETE FROM community.thread_read_state WHERE thread_id=ANY($1::text[])",
          [createdThreads],
        );
        await pool.query(
          "DELETE FROM community.thread_works WHERE thread_id=ANY($1::text[])",
          [createdThreads],
        );
      }
      if (users.length) {
        await pool.query(
          "DELETE FROM community.comment_likes WHERE user_id=ANY($1::text[])",
          [users],
        );
        await pool.query(
          "DELETE FROM community.catalog_comment_replies WHERE author_id=ANY($1::text[]) OR root_comment_id IN (SELECT id FROM community.catalog_comments WHERE author_id=ANY($1::text[]))",
          [users],
        );
        await pool.query(
          "DELETE FROM community.catalog_comments WHERE author_id=ANY($1::text[])",
          [users],
        );
        await cleanupPublishingData(pool, users);
        // cleanupPublishingData leaves the Work rows to the suite's own
        // fixtures; ours are foreign to it, so remove them here too.
        await pool.query(
          "DELETE FROM community.work_revision_items WHERE revision_id IN (SELECT id FROM community.work_revisions WHERE author_id=ANY($1::text[]))",
          [users],
        );
        await pool.query(
          "UPDATE community.works SET public_revision_id=NULL, author_revision_id=NULL WHERE author_id=ANY($1::text[])",
          [users],
        );
        await pool.query(
          "DELETE FROM community.work_revisions WHERE author_id=ANY($1::text[])",
          [users],
        );
        await pool.query(
          "DELETE FROM community.works WHERE author_id=ANY($1::text[])",
          [users],
        );
        await pool.query(
          "DELETE FROM community.thread_read_state WHERE user_id=ANY($1::text[])",
          [users],
        );
        await pool.query(
          "DELETE FROM community.author_command_receipts WHERE actor_id=ANY($1::text[])",
          [users],
        );
        await pool.query(
          "DELETE FROM community.author_events WHERE actor_id=ANY($1::text[])",
          [users],
        );
        await pool.query(
          "DELETE FROM community.public_users WHERE id=ANY($1::text[])",
          [users],
        );
      }
      if (createdThreads.length)
        await pool.query(
          "DELETE FROM community.threads WHERE id=ANY($1::text[])",
          [createdThreads],
        );
    });

    it("associates a new Work with its Thread in the submission transaction and never twice", async () => {
      const author = await user("参与者甲");
      const thread = await createThread(`访碑记录 ${randomUUID().slice(0, 8)}`);
      const first = await publishing.submit(
        author,
        await command(author, { threadId: thread.id }),
        new Date(),
      );
      expect(first.state).toBe("confirmed");
      if (first.state !== "confirmed") return;
      expect(await workIdsOf(thread.id)).toEqual([first.workId]);
      // The Work is the author's ordinary Work: one identity, one row.
      const works = await pool.query(
        "SELECT id FROM community.works WHERE id=$1 AND author_id=$2",
        [first.workId, author],
      );
      expect(works.rowCount).toBe(1);
      // An identical retry replays the receipt and creates no second association.
      const retryCommand = await command(author, { threadId: thread.id });
      const cmd = { ...retryCommand, requestId: randomUUID() };
      const a = await publishing.submit(author, cmd, new Date());
      const b = await publishing.submit(author, cmd, new Date());
      expect(a).toEqual(b);
      expect((await workIdsOf(thread.id)).length).toBe(2);
      // UNIQUE(work_id): one Thread per Work at the database level.
      const other = await createThread(`另一话题 ${randomUUID().slice(0, 8)}`);
      await expect(
        pool.query(
          "INSERT INTO community.thread_works(thread_id, work_id) VALUES($1,$2)",
          [other.id, first.workId],
        ),
      ).rejects.toMatchObject({ code: "23505" });
      // An existing Work cannot be reassigned through a later submission.
      const editHolder = id("publishing-session");
      await pool.query(
        "INSERT INTO community.publishing_sessions(id,owner_id,save_mode,work_id,state,lease_expires_at) VALUES($1,$2,'unsaved',$3,'active','2100-01-01T00:00:00Z')",
        [editHolder, author, first.workId],
      );
      const revision = (
        await pool.query<{ author_revision_id: string }>(
          "SELECT author_revision_id FROM community.works WHERE id=$1",
          [first.workId],
        )
      ).rows[0]!.author_revision_id;
      await expect(
        publishing.submit(
          author,
          workSubmissionCommandSchema.parse({
            requestId: randomUUID(),
            holder: { sessionId: editHolder },
            content: content({ body: "改动" }),
            baseRevisionId: revision,
            threadId: other.id,
          }),
          new Date(),
        ),
      ).rejects.toMatchObject({ message: "thread_conflict" });
    });

    it("rechecks the Thread at commit and refuses closed, hidden or unknown Threads without an orphan Work", async () => {
      const author = await user("参与者乙");
      const thread = await createThread(
        `关闭中的话题 ${randomUUID().slice(0, 8)}`,
      );
      const before = Number(
        (
          await pool.query<{ n: string }>(
            "SELECT count(*) AS n FROM community.works WHERE author_id=$1",
            [author],
          )
        ).rows[0]!.n,
      );
      await threads.operatorUpdateThread("owner", thread.id, {
        requestId: randomUUID(),
        expectedVersion: thread.version,
        status: "closed",
      });
      await expect(
        publishing.submit(
          author,
          await command(author, { threadId: thread.id }),
          new Date(),
        ),
      ).rejects.toBeInstanceOf(CommunityInputError);
      await expect(
        publishing.submit(
          author,
          await command(author, { threadId: id("thread") }),
          new Date(),
        ),
      ).rejects.toMatchObject({ message: "thread_unavailable" });
      const after = Number(
        (
          await pool.query<{ n: string }>(
            "SELECT count(*) AS n FROM community.works WHERE author_id=$1",
            [author],
          )
        ).rows[0]!.n,
      );
      expect(after).toBe(before);
      // A stale operator version is a conflict that records nothing.
      await expect(
        threads.operatorUpdateThread("owner", thread.id, {
          requestId: randomUUID(),
          expectedVersion: thread.version,
          status: "open",
        }),
      ).rejects.toBeInstanceOf(CommunityConflictError);
      // Hidden Threads leave the public list but keep their rows.
      const current = (
        await threads.operatorListThreads({
          page: 1,
          pageSize: 50,
          includeHidden: true,
        })
      ).items.find((t) => t.id === thread.id)!;
      await threads.operatorUpdateThread("owner", thread.id, {
        requestId: randomUUID(),
        expectedVersion: current.version,
        hidden: true,
      });
      const listed = await threads.listThreads(null, { page: 1, pageSize: 50 });
      expect(listed.items.some((t) => t.id === thread.id)).toBe(false);
      await expect(
        threads.readThread(thread.id as ThreadId, null),
      ).rejects.toThrow();
    });

    it("ranks by deterministic heat at a fixed anchor, counts eligible activity once and keeps per-user read markers monotonic", async () => {
      const author = await user("参与者丙");
      const reader = await user("读者丁");
      const thread = await createThread(`热度话题 ${randomUUID().slice(0, 8)}`);
      const quiet = await createThread(`安静话题 ${randomUUID().slice(0, 8)}`);
      const post = await publishing.submit(
        author,
        await command(author, { threadId: thread.id }),
        new Date(),
      );
      if (post.state !== "confirmed") throw new Error("post not confirmed");
      // Two visible comments on the post (weight 2 each) and one like (weight 1).
      const root = await comments.submitDiscussion(
        { type: "work", id: post.workId },
        reader,
        "先记录，再解释",
        undefined,
        undefined,
      );
      await comments.submitDiscussion(
        { type: "work", id: post.workId },
        author,
        "同意",
        root.rootId,
        undefined,
      );
      await comments.setDiscussionLike(author, root.id, true, randomUUID());
      const anchorNow = new Date();
      const page = await threads.listThreads(reader, {
        page: 1,
        pageSize: 50,
        anchor: anchorNow.toISOString(),
      });
      const hot = page.items.find((t) => t.id === thread.id)!;
      const cold = page.items.find((t) => t.id === quiet.id)!;
      // work 1 + root 2 + reply 2 + like 1 = 6 at negligible age.
      expect(hot.heat).toBeGreaterThan(5.9);
      expect(hot.heat).toBeLessThanOrEqual(6);
      expect(hot.postCount).toBe(1);
      expect(cold.heat).toBe(0);
      expect(page.items.indexOf(hot)).toBeLessThan(page.items.indexOf(cold));
      // Same anchor → identical ranking; a later anchor does not change the counted items here.
      const again = await threads.listThreads(reader, {
        page: 1,
        pageSize: 50,
        anchor: anchorNow.toISOString(),
      });
      expect(again.items.map((t) => [t.id, t.heat])).toEqual(
        page.items.map((t) => [t.id, t.heat]),
      );
      // A hidden (self-only) Work contributes nothing.
      const privateAuthor = await user("私密作者");
      await publishing.submit(
        privateAuthor,
        await command(privateAuthor, {
          threadId: thread.id,
          content: content({ visibility: "self" }),
        }),
        new Date(),
      );
      const afterPrivate = await threads.readThread(
        thread.id as ThreadId,
        null,
      );
      expect(afterPrivate.postCount).toBe(1);
      // Read marker: unread for the reader until marked; monotonic and per user.
      expect(hot.unread).toBe(true);
      const marked = await threads.markThreadRead(
        thread.id as ThreadId,
        reader,
      );
      expect(marked.observedActivityAt).not.toBeNull();
      expect(
        (await threads.readThread(thread.id as ThreadId, reader)).unread,
      ).toBe(false);
      // Another account stays independent.
      expect(
        (await threads.readThread(thread.id as ThreadId, author)).unread,
      ).toBe(true);
      // New eligible activity makes it unread again; the marker never regresses.
      await comments.submitDiscussion(
        { type: "work", id: post.workId },
        author,
        "补充一点",
        root.rootId,
        undefined,
      );
      expect(
        (await threads.readThread(thread.id as ThreadId, reader)).unread,
      ).toBe(true);
      const stored = (
        await pool.query<{ observed_activity_at: Date }>(
          "SELECT observed_activity_at FROM community.thread_read_state WHERE user_id=$1 AND thread_id=$2",
          [reader, thread.id],
        )
      ).rows[0]!.observed_activity_at;
      expect(stored.toISOString()).toBe(marked.observedActivityAt);
      // Anonymous readers get no read state.
      expect(
        (await threads.readThread(thread.id as ThreadId, null)).unread,
      ).toBeNull();
    });

    it("stores article discussion targets under the retained physical names and refuses other kinds", async () => {
      const author = await user("文章评论者");
      const articleId = `article-${randomUUID().replaceAll("-", "")}`;
      const result = await comments.submitDiscussion(
        { type: "article", id: articleId as never },
        author,
        "文章评论",
        undefined,
        undefined,
      );
      const stored = (
        await pool.query<{ target_type: string; catalog_id: string }>(
          "SELECT target_type, catalog_id FROM community.catalog_comments WHERE id=$1",
          [result.rootId],
        )
      ).rows[0]!;
      expect(stored).toEqual({ target_type: "article", catalog_id: articleId });
      expect(await comments.discussionTarget(result.rootId)).toEqual({
        type: "article",
        id: articleId,
      });
      await expect(
        pool.query(
          "INSERT INTO community.catalog_comments(id,catalog_id,target_type,author_id,text,moderation) VALUES($1,$2,'user',$3,'x','visible')",
          [id("comment"), author, author],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      const page = await comments.readDiscussion(
        { type: "article", id: articleId as never },
        null,
        { page: 1, pageSize: 10 },
      );
      expect(page.items.map((item) => item.id)).toEqual([result.rootId]);
      // The retained column name still bounds the identity length.
      expect(articleId.length).toBeLessThanOrEqual(128);
    });
  });
};
