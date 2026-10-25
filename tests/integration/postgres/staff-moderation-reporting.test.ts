import { emptyArticleDocument } from "@moya/contracts/schemas";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { CommunityConflictError, CommunityNotFoundError } from "@moya/api";
import type { ModerationEventDraft } from "@moya/api";
import type {
  ArticleId,
  CatalogCommentId,
  PublicUserId,
} from "@moya/contracts";
import {
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import {
  PostgresCommunityReportingAdapter,
  PostgresCommunityCommentAdapter,
  PostgresCommunityIdentityAdapter,
  PostgresCommunityContentOperatorAdapter,
  PostgresPublishingOperatorAdapter,
  PostgresArticleAuthoringAdapter,
  runCommunityMigrations,
} from "@moya/community-postgres";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { requireSyntheticTestDatabaseUrl } from "./synthetic-test-database.js";
const endpoint = requireSyntheticTestDatabaseUrl(),
  name = `staff_reporting_${randomUUID().replaceAll("-", "")}_synthetic_test`,
  admin = createPostgresPool(parsePostgresConfig({ DATABASE_URL: endpoint }));
const url = new URL(endpoint);
url.pathname = `/${name}`;
const pool = createPostgresPool(
  parsePostgresConfig({ DATABASE_URL: url.toString() }),
);
const reports = new PostgresCommunityReportingAdapter(pool),
  comments = new PostgresCommunityCommentAdapter(pool),
  identities = new PostgresCommunityIdentityAdapter(pool),
  works = new PostgresCommunityContentOperatorAdapter(pool),
  publishing = new PostgresPublishingOperatorAdapter(pool),
  articles = new PostgresArticleAuthoringAdapter(pool);
let created = false;
beforeAll(async () => {
  await admin.query(`CREATE DATABASE "${name}"`);
  created = true;
  await runCommunityMigrations(
    pool,
    fileURLToPath(
      new URL("../../../database/community-migrations", import.meta.url),
    ),
  );
}, 60000);
afterAll(async () => {
  await pool.end();
  if (created) await admin.query(`DROP DATABASE "${name}"`);
  await admin.end();
});
const opaque = (p: string) => `${p}-${randomUUID().replaceAll("-", "")}`;
const user = async () => {
  const id = opaque("user") as PublicUserId;
  await pool.query(
    "INSERT INTO community.public_users(id,handle,display_name) VALUES($1,$2,'Synthetic staff account')",
    [id, `staff-${id.slice(-24)}`],
  );
  return id;
};
const work = async (author: string) => {
  const id = opaque("work");
  await pool.query(
    "INSERT INTO community.works(id,author_id,title,text,first_published_at) VALUES($1,$2,'Prior public title','Prior public text',CURRENT_TIMESTAMP)",
    [id, author],
  );
  return id;
};
const comment = async (author: string, state = "visible") => {
  const id = opaque("comment") as CatalogCommentId;
  await pool.query(
    "INSERT INTO community.catalog_comments(id,catalog_id,author_id,text,moderation) VALUES($1,'catalog-synthetic',$2,'Synthetic comment',$3)",
    [id, author, state],
  );
  return id;
};
const audit = (
  action: ModerationEventDraft["action"],
  reason?: string,
): ModerationEventDraft => ({
  id: opaque("moderation"),
  occurredAt: new Date(),
  operatorLabel: "owner",
  action,
  ...(reason === undefined ? {} : { reason }),
});
const own = async (actor: string) =>
  (await reports.decisions(actor, 1, 100)).items;
const staffCase = async (actor: string, target: string) => {
  const item = (await own(actor)).find((item) => item.target.id === target)!;
  return reports.operatorRead(item.caseId);
};
const appealAndOverturn = async (actor: string, id: string) => {
  let row = await reports.operatorRead(id);
  await reports.appeal(actor, row.decision!.id, {
    text: "Synthetic appeal",
    requestId: randomUUID(),
  });
  row = await reports.operatorRead(id);
  return reports.review("owner", id, {
    expectedVersion: row.version,
    outcome: "overturn",
    reason: "Synthetic correction",
  });
};
const pendingWork = async (author: string) => {
  const id = await work(author),
    revision = opaque("work-revision");
  await pool.query(
    "INSERT INTO community.work_revisions(id,work_id,author_id,sequence,origin,title,body,authorship_kind,requested_visibility,content_sha256,disposition,submitted_at) VALUES($1,$2,$3,2,'submission','Pending exact candidate','Pending body','original','public',$4,'pending',CURRENT_TIMESTAMP)",
    [revision, id, author, "c".repeat(64)],
  );
  await pool.query(
    "UPDATE community.works SET author_revision_id=$2,version=version+1 WHERE id=$1",
    [id, revision],
  );
  return { id, revision };
};
const pendingArticle = async (author: string) => {
  const id = opaque("article") as ArticleId,
    document = JSON.stringify(emptyArticleDocument()),
    fingerprint = "a".repeat(64);
  await pool.query(
    "INSERT INTO community.article_documents(id,owner_id,version,title,document,fingerprint,created_at,updated_at) VALUES($1,$2,1,'Pending Article',$3::jsonb,$4,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
    [id, author, document, fingerprint],
  );
  await pool.query(
    "INSERT INTO community.article_revisions(article_id,version,owner_id,title,document,fingerprint,submitted_policy,submitted_by_source,created_at) VALUES($1,1,$2,'Pending Article',$3::jsonb,$4,'PRE_MODERATION','human',CURRENT_TIMESTAMP)",
    [id, author, document, fingerprint],
  );
  await pool.query(
    "UPDATE community.article_documents SET version=2,status='pending',pending_version=1,updated_at=CURRENT_TIMESTAMP WHERE id=$1",
    [id],
  );
  return { id, fingerprint };
};
describe("current human moderation creates private appealable staff cases", () => {
  it("records each native comment transition, preserves receipt replay, and rejects later-state restoration", async () => {
    const author = await user(),
      id = await comment(author),
      event = audit("hide", "Human comment reason"),
      receipt = { requestId: randomUUID(), fingerprint: "b".repeat(64) };
    await comments.applyCommentModeration(
      id,
      "hidden",
      ["visible"],
      "owner",
      new Date(),
      event,
      receipt,
    );
    await comments.applyCommentModeration(
      id,
      "hidden",
      ["visible"],
      "owner",
      new Date(),
      event,
      receipt,
    );
    let row = await staffCase(author, id);
    expect(row.kind).toBe("moderation");
    expect(row.reporterId).toBeNull();
    expect(row.decision?.reason).toBe("Human comment reason");
    expect(
      (await own(author)).filter((item) => item.target.id === id),
    ).toHaveLength(1);
    await expect(reports.readOwn(author, row.id)).rejects.toBeInstanceOf(
      CommunityNotFoundError,
    );
    await pool.query(
      "UPDATE community.catalog_comments SET body_deleted_at=CURRENT_TIMESTAMP,text='This comment has been deleted' WHERE id=$1",
      [id],
    );
    await appealAndOverturn(author, row.id);
    expect(
      (
        await pool.query(
          "SELECT moderation,body_deleted_at FROM community.catalog_comments WHERE id=$1",
          [id],
        )
      ).rows[0].moderation,
    ).toBe("hidden");
    const pending = await comment(author, "pending");
    await comments.applyCommentModeration(
      pending,
      "hidden",
      ["pending"],
      "owner",
      new Date(),
      audit("reject", "Human rejection"),
    );
    row = await staffCase(author, pending);
    await appealAndOverturn(author, row.id);
    expect(
      (
        await pool.query(
          "SELECT moderation FROM community.catalog_comments WHERE id=$1",
          [pending],
        )
      ).rows[0].moderation,
    ).toBe("pending");
    const approved = await comment(author, "pending");
    await comments.applyCommentModeration(
      approved,
      "visible",
      ["pending"],
      "owner",
      new Date(),
      audit("approve", "Human approval"),
    );
    row = await staffCase(author, approved);
    await reports.appeal(author, row.decision!.id, {
      text: "Synthetic approval appeal",
      requestId: randomUUID(),
    });
    row = await reports.operatorRead(row.id);
    await expect(
      reports.review("owner", row.id, {
        expectedVersion: row.version,
        outcome: "overturn",
        reason: "No destructive rollback",
      }),
    ).rejects.toBeInstanceOf(CommunityConflictError);
    await reports.review("owner", row.id, {
      expectedVersion: row.version,
      outcome: "uphold",
      reason: "Approval confirmed",
    });
    expect(
      (
        await pool.query(
          "SELECT moderation FROM community.catalog_comments WHERE id=$1",
          [approved],
        )
      ).rows[0].moderation,
    ).toBe("visible");
  });
  it("records user status reasons and private notices while optional automated calls remain unchanged", async () => {
    const author = await user();
    await identities.setUserStatus(
      author,
      "suspended",
      new Date(),
      audit("suspend", "Human suspension"),
    );
    let row = await staffCase(author, author);
    expect(row.reporterId).toBeNull();
    expect((await reports.inbox(author)).items).toHaveLength(1);
    await appealAndOverturn(author, row.id);
    expect(
      (
        await pool.query(
          "SELECT status FROM community.public_users WHERE id=$1",
          [author],
        )
      ).rows[0].status,
    ).toBe("active");
    await identities.setUserStatus(
      author,
      "suspended",
      new Date(),
      audit("suspend"),
    );
    expect(await own(author)).toHaveLength(1);
    await identities.setUserStatus(
      author,
      "active",
      new Date(),
      audit("reinstate", "Human reinstatement"),
    );
    expect(await own(author)).toHaveLength(2);
    row = (await reports.operatorList({ page: 1, pageSize: 100 })).items.find(
      (item) =>
        item.target.id === author && item.decision?.action === "restore",
    )!;
    expect(row.decision?.reason).toBe("Human reinstatement");
  });
  it("records Work moderation atomically and restores only its own operator restriction", async () => {
    const author = await user(),
      media = opaque("user-media"),
      id = opaque("work");
    await pool.query(
      "INSERT INTO community.user_media(id,owner_id,mime_type,width,height,sha256,bytes) VALUES($1,$2,'image/png',64,64,$3,$4)",
      [media, author, "f".repeat(64), Buffer.from([137, 80, 78, 71])],
    );
    await pool.query(
      "INSERT INTO community.works(id,author_id,title,text,media_ids,first_published_at) VALUES($1,$2,'Media Work','Media body',ARRAY[$3],CURRENT_TIMESTAMP)",
      [id, author, media],
    );
    const version = (
      await pool.query("SELECT version FROM community.works WHERE id=$1", [id])
    ).rows[0].version;
    const command = {
      requestId: randomUUID(),
      expectedVersion: version,
      state: "removed" as const,
      reason: "Human Work removal",
    };
    await works.moderateWork(id, "owner", command);
    await works.moderateWork(id, "owner", command);
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer n FROM community.media_item_holds WHERE work_id=$1 AND released_at IS NULL",
          [id],
        )
      ).rows[0].n,
    ).toBe(1);
    const row = await staffCase(author, id);
    expect(
      (await own(author)).filter((item) => item.target.id === id),
    ).toHaveLength(1);
    await appealAndOverturn(author, row.id);
    expect(
      (
        await pool.query(
          "SELECT operator_state FROM community.works WHERE id=$1",
          [id],
        )
      ).rows[0].operator_state,
    ).toBe("visible");
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer n FROM community.media_item_holds WHERE work_id=$1 AND released_at IS NOT NULL",
          [id],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await pool.query(
          "SELECT encode(bytes,'hex') AS bytes FROM community.user_media WHERE id=$1",
          [media],
        )
      ).rows[0].bytes,
    ).toBe("89504e47");
  });
  it("requeues only the unchanged exact rejected Work candidate without publishing it", async () => {
    const author = await user(),
      candidate = await pendingWork(author);
    await publishing.moderateSubmission(
      candidate.revision,
      "owner",
      {
        requestId: randomUUID(),
        expectedVersion: 1,
        action: "reject",
        reason: "Human pending Work rejection",
      },
      new Date(),
    );
    const row = await staffCase(author, candidate.id);
    const before = (
      await pool.query(
        "SELECT to_jsonb(w) AS row FROM community.works w WHERE id=$1",
        [candidate.id],
      )
    ).rows[0].row;
    await appealAndOverturn(author, row.id);
    expect(
      (
        await pool.query(
          "SELECT disposition,version,decided_at,decided_by FROM community.work_revisions WHERE id=$1",
          [candidate.revision],
        )
      ).rows[0],
    ).toEqual({
      disposition: "pending",
      version: 3,
      decided_at: null,
      decided_by: null,
    });
    expect(
      (
        await pool.query(
          "SELECT to_jsonb(w) AS row FROM community.works w WHERE id=$1",
          [candidate.id],
        )
      ).rows[0].row,
    ).toEqual(before);
    const drift = await pendingWork(author);
    await publishing.moderateSubmission(
      drift.revision,
      "owner",
      {
        requestId: randomUUID(),
        expectedVersion: 1,
        action: "reject",
        reason: "Another pending rejection",
      },
      new Date(),
    );
    const held = await staffCase(author, drift.id);
    await pool.query(
      "UPDATE community.works SET visibility='self',version=version+1 WHERE id=$1",
      [drift.id],
    );
    await expect(appealAndOverturn(author, held.id)).rejects.toBeInstanceOf(
      CommunityConflictError,
    );
    expect(
      (
        await pool.query(
          "SELECT disposition FROM community.work_revisions WHERE id=$1",
          [drift.revision],
        )
      ).rows[0].disposition,
    ).toBe("rejected");
  });
  it("requeues only the unchanged immutable rejected Article candidate and preserves every public pointer", async () => {
    const author = await user(),
      candidate = await pendingArticle(author);
    await articles.moderatePending(
      "owner",
      candidate.id,
      {
        requestId: randomUUID(),
        expectedVersion: 2,
        candidateVersion: 1,
        fingerprint: candidate.fingerprint,
        action: "reject",
        reason: "Human Article rejection",
      },
      new Date(),
    );
    const row = await staffCase(author, candidate.id);
    const before = (
      await pool.query(
        "SELECT document,fingerprint,title,published_version FROM community.article_documents WHERE id=$1",
        [candidate.id],
      )
    ).rows[0];
    await appealAndOverturn(author, row.id);
    expect(
      (
        await pool.query(
          "SELECT version,status,pending_version,published_version FROM community.article_documents WHERE id=$1",
          [candidate.id],
        )
      ).rows[0],
    ).toEqual({
      version: 4,
      status: "pending",
      pending_version: 1,
      published_version: null,
    });
    expect(
      (
        await pool.query(
          "SELECT document,fingerprint,title,published_version FROM community.article_documents WHERE id=$1",
          [candidate.id],
        )
      ).rows[0],
    ).toEqual(before);
    const drift = await pendingArticle(author);
    await articles.moderatePending(
      "owner",
      drift.id,
      {
        requestId: randomUUID(),
        expectedVersion: 2,
        candidateVersion: 1,
        fingerprint: drift.fingerprint,
        action: "reject",
        reason: "Another Article rejection",
      },
      new Date(),
    );
    const held = await staffCase(author, drift.id);
    await pool.query(
      "UPDATE community.article_documents SET version=version+1,title='Intervening save',updated_at=CURRENT_TIMESTAMP WHERE id=$1",
      [drift.id],
    );
    await expect(appealAndOverturn(author, held.id)).rejects.toBeInstanceOf(
      CommunityConflictError,
    );
    expect(
      (
        await pool.query(
          "SELECT status,pending_version FROM community.article_documents WHERE id=$1",
          [drift.id],
        )
      ).rows[0],
    ).toEqual({ status: "draft", pending_version: null });
  });
  it("corrects an irreversible body-deletion decision without storing or restoring the erased text", async () => {
    const author = await user(),
      id = await comment(author);
    await pool.query(
      "UPDATE community.catalog_comments SET text='Synthetic erased-body-marker' WHERE id=$1",
      [id],
    );
    const request = randomUUID();
    await comments.operatorDeleteBody(
      "owner",
      id,
      request,
      "Human body removal",
    );
    await comments.operatorDeleteBody(
      "owner",
      id,
      request,
      "Human body removal",
    );
    const row = await staffCase(author, id);
    expect(JSON.stringify(row)).not.toContain("Synthetic erased-body-marker");
    expect(row.snapshot["irreversible"]).toBe(true);
    const corrected = await appealAndOverturn(author, row.id);
    expect(corrected.decision?.reviewReason).toContain("无法恢复");
    const stored = (
      await pool.query(
        "SELECT text,body_deleted_at FROM community.catalog_comments WHERE id=$1",
        [id],
      )
    ).rows[0];
    expect(stored.text).toBe("This comment has been deleted");
    expect(stored.body_deleted_at).not.toBeNull();
  });
  it("notifies every distinct thread author privately and restores only after the last effective decision", async () => {
    const a = await user(),
      b = await user(),
      c = await user(),
      root = await comment(a, "hidden");
    for (const [index, author] of [b, b, c].entries())
      await pool.query(
        "INSERT INTO community.catalog_comment_replies(id,root_comment_id,author_id,text,moderation,body_deleted_at) VALUES($1,$2,$3,$4,'visible',$5)",
        [
          opaque("comment"),
          root,
          author,
          index === 2 ? "This comment has been deleted" : "Synthetic reply",
          index === 2 ? new Date() : null,
        ],
      );
    const request = randomUUID();
    await comments.removeDiscussionThread(
      "owner",
      root,
      request,
      4,
      "Human thread removal",
    );
    await comments.removeDiscussionThread(
      "owner",
      root,
      request,
      4,
      "Human thread removal",
    );
    const rows = await Promise.all(
      [a, b, c].map((author) => staffCase(author, root)),
    );
    expect(new Set(rows.map((row) => row.id)).size).toBe(3);
    expect(rows.every((row) => row.reporterId === null)).toBe(true);
    await reports.appeal(b, rows[1]!.decision!.id, {
      text: "Private b appeal",
      requestId: randomUUID(),
    });
    expect(JSON.stringify(await own(c))).not.toContain("Private b appeal");
    const pending = await reports.operatorRead(rows[1]!.id);
    await reports.review("owner", pending.id, {
      expectedVersion: pending.version,
      outcome: "overturn",
      reason: "Correction for b",
    });
    expect(
      (
        await pool.query(
          "SELECT thread_removed_at FROM community.catalog_comments WHERE id=$1",
          [root],
        )
      ).rows[0].thread_removed_at,
    ).not.toBeNull();
    await appealAndOverturn(a, rows[0]!.id);
    await appealAndOverturn(c, rows[2]!.id);
    const restored = (
      await pool.query(
        "SELECT thread_removed_at,moderation FROM community.catalog_comments WHERE id=$1",
        [root],
      )
    ).rows[0];
    expect(restored).toEqual({ thread_removed_at: null, moderation: "hidden" });
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer n FROM community.catalog_comment_replies WHERE root_comment_id=$1 AND body_deleted_at IS NOT NULL AND text='This comment has been deleted'",
          [root],
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it("rolls back a native action and legacy audit if its durable private notice cannot commit", async () => {
    const author = await user(),
      id = await comment(author),
      event = audit("hide", "Synthetic atomic action");
    await pool.query(
      "CREATE FUNCTION community.synthetic_staff_notice_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic notice failure'; END $$; CREATE TRIGGER synthetic_staff_notice_failure BEFORE INSERT ON community.report_messages FOR EACH ROW EXECUTE FUNCTION community.synthetic_staff_notice_failure()",
    );
    try {
      await expect(
        comments.applyCommentModeration(
          id,
          "hidden",
          ["visible"],
          "owner",
          new Date(),
          event,
        ),
      ).rejects.toThrow("synthetic notice failure");
    } finally {
      await pool.query(
        "DROP TRIGGER synthetic_staff_notice_failure ON community.report_messages; DROP FUNCTION community.synthetic_staff_notice_failure()",
      );
    }
    expect(
      (
        await pool.query(
          "SELECT moderation FROM community.catalog_comments WHERE id=$1",
          [id],
        )
      ).rows[0].moderation,
    ).toBe("visible");
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer n FROM community.moderation_events WHERE id=$1",
          [event.id],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(await own(author)).toHaveLength(0);
  });
  it("restores surviving replies after post-removal root-body erasure without resurrecting that body", async () => {
    const a = await user(),
      b = await user(),
      post = await work(a),
      root = opaque("comment") as CatalogCommentId,
      reply = opaque("comment");
    await pool.query(
      "INSERT INTO community.catalog_comments(id,catalog_id,target_type,author_id,text,moderation) VALUES($1,$2,'work',$3,'Synthetic post-removal erased marker','visible')",
      [root, post, a],
    );
    await pool.query(
      "INSERT INTO community.catalog_comment_replies(id,root_comment_id,author_id,text,moderation) VALUES($1,$2,$3,'Surviving reply','visible')",
      [reply, root, b],
    );
    await comments.removeDiscussionThread(
      "owner",
      root,
      randomUUID(),
      2,
      "Human thread removal",
    );
    const removals = await Promise.all(
      [a, b].map((author) => staffCase(author, root)),
    );
    const before = (
      await pool.query(
        "SELECT reporting_revision,reporting_thread_revision FROM community.catalog_comments WHERE id=$1",
        [root],
      )
    ).rows[0];
    // Simulate an independently authorized tombstone without widening the
    // native operator endpoint, which intentionally refuses removed threads.
    await pool.query(
      "UPDATE community.catalog_comments SET text='This comment has been deleted',body_deleted_at=CURRENT_TIMESTAMP WHERE id=$1",
      [root],
    );
    const erased = (
      await pool.query(
        "SELECT reporting_revision,reporting_thread_revision,text,body_deleted_at FROM community.catalog_comments WHERE id=$1",
        [root],
      )
    ).rows[0];
    expect(BigInt(erased.reporting_revision)).toBeGreaterThan(
      BigInt(before.reporting_revision),
    );
    expect(erased.reporting_thread_revision).toBe(
      before.reporting_thread_revision,
    );
    expect(erased.body_deleted_at).not.toBeNull();
    await appealAndOverturn(a, removals[0]!.id);
    await appealAndOverturn(b, removals[1]!.id);
    const restored = (
      await pool.query(
        "SELECT thread_removed_at,text,body_deleted_at,moderation FROM community.catalog_comments WHERE id=$1",
        [root],
      )
    ).rows[0];
    expect(restored.thread_removed_at).toBeNull();
    expect(restored.text).toBe("This comment has been deleted");
    expect(restored.body_deleted_at).toEqual(erased.body_deleted_at);
    expect(restored.moderation).toBe("visible");
    const replies = await comments.readDiscussionReplies(
      { type: "work", id: post },
      root,
      null,
      { page: 1, pageSize: 20 },
    );
    expect(
      replies.items.some(
        (item) => item.id === reply && item.text === "Surviving reply",
      ),
    ).toBe(true);
    expect(
      (await reports.operatorRead(removals[0]!.id)).decision?.reversedAt,
    ).not.toBeNull();
  });
  it("retains full reasons only in staff cases while preserving exact retry fingerprints for all three content audits", async () => {
    const author = await user(),
      id = await work(author),
      version = (
        await pool.query("SELECT version FROM community.works WHERE id=$1", [
          id,
        ])
      ).rows[0].version;
    const wc = {
      requestId: randomUUID(),
      expectedVersion: version,
      state: "hidden" as const,
      reason: "private-staff-reason Work",
    };
    const changed = await works.moderateWork(id, "owner", wc);
    expect(await works.moderateWork(id, "owner", wc)).toEqual(changed);
    await expect(
      works.moderateWork(id, "owner", { ...wc, reason: "Changed Work reason" }),
    ).rejects.toBeInstanceOf(CommunityConflictError);
    const pending = await pendingWork(author),
      pc = {
        requestId: randomUUID(),
        expectedVersion: 1,
        action: "reject" as const,
        reason: "private-staff-reason pending Work",
      };
    const rejected = await publishing.moderateSubmission(
      pending.revision,
      "owner",
      pc,
      new Date(),
    );
    expect(
      await publishing.moderateSubmission(
        pending.revision,
        "owner",
        pc,
        new Date(),
      ),
    ).toEqual(rejected);
    await expect(
      publishing.moderateSubmission(
        pending.revision,
        "owner",
        { ...pc, reason: "Changed pending reason" },
        new Date(),
      ),
    ).rejects.toBeInstanceOf(CommunityConflictError);
    const article = await pendingArticle(author),
      ac = {
        requestId: randomUUID(),
        expectedVersion: 2,
        candidateVersion: 1,
        fingerprint: article.fingerprint,
        action: "reject" as const,
        reason: "private-staff-reason Article",
      };
    const declined = await articles.moderatePending(
      "owner",
      article.id,
      ac,
      new Date(),
    );
    expect(
      await articles.moderatePending("owner", article.id, ac, new Date()),
    ).toEqual(declined);
    await expect(
      articles.moderatePending(
        "owner",
        article.id,
        { ...ac, reason: "Changed Article reason" },
        new Date(),
      ),
    ).rejects.toBeInstanceOf(CommunityConflictError);
    const events = (
      await pool.query(
        "SELECT action,detail FROM community.content_operator_events WHERE content_id=ANY($1::text[]) ORDER BY action",
        [[id, pending.revision, article.id]],
      )
    ).rows;
    expect(events).toHaveLength(3);
    expect(JSON.stringify(events)).not.toContain("private-staff-reason");
    expect(
      events.every((event) => !Object.hasOwn(event.detail.command, "reason")),
    ).toBe(true);
    const cases = await own(author);
    expect(cases).toHaveLength(3);
    expect(
      cases.every((item) =>
        item.decision.reason.startsWith("private-staff-reason"),
      ),
    ).toBe(true);
  });
});
