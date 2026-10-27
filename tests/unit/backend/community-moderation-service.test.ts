import { CommunityModerationService, CatalogCommentService } from "@moya/api";
import {
  BULK_MODERATION_MAXIMUM,
  moderationSummarySchema,
  operatorCommentDetailSchema,
  operatorCommentPageSchema,
} from "@moya/contracts/internal/community-operator";
import { describe, expect, it } from "vitest";

import {
  FixtureCatalogPublicationPort,
  InMemoryCommunityCommentPort,
  publishedCatalogId,
} from "./community-comment-fixture.js";
import {
  InMemoryCommunityIdentityPort,
  fixtureUsers,
} from "./community-identity-fixture.js";

import type { CommentAnalysisPort } from "@moya/api";
import type { CatalogCommentId } from "@moya/contracts";
import type { CommentAnalysisState } from "@moya/contracts/internal/community-operator";

const createHarness = (
  options: { readonly analysisPort?: CommentAnalysisPort } = {},
) => {
  const commentPort = new InMemoryCommunityCommentPort();
  // User transitions audit into the same log the comment port reads back.
  const identityPort = new InMemoryCommunityIdentityPort(
    undefined,
    undefined,
    commentPort.events,
  );
  const catalogPort = new FixtureCatalogPublicationPort();
  let now = new Date("2026-09-12T16:00:00.000Z");
  let counter = 0;
  const randomBytes = () => {
    counter += 1;
    return Uint8Array.from({ length: 16 }, (_value, index) =>
      index === 15 ? counter % 256 : Math.floor(counter / 256),
    );
  };
  const comments = new CatalogCommentService(commentPort, catalogPort, {
    clock: () => now,
    randomBytes,
  });
  const moderation = new CommunityModerationService(
    commentPort,
    identityPort,
    catalogPort,
    { clock: () => now, randomBytes, ...options },
  );
  const submit = async (text: string, authorId = fixtureUsers.active.id) =>
    (await comments.createComment(publishedCatalogId, authorId, { text })).item
      .id;
  const reply = async (
    rootId: CatalogCommentId,
    text: string,
    replyTo?: CatalogCommentId,
  ) =>
    (
      await comments.createReply(
        publishedCatalogId,
        rootId,
        fixtureUsers.second.id,
        replyTo === undefined ? { text } : { replyTo, text },
      )
    ).item.id;
  return {
    commentPort,
    identityPort,
    comments,
    moderation,
    submit,
    reply,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
  };
};

describe("CommunityModerationService", () => {
  it("rejects a pending item as its own audited edge and refuses every other edge from there", async () => {
    const harness = createHarness();
    harness.commentPort.policy = "PRE_MODERATION";
    const id = await harness.submit("待审核");
    expect(
      await harness.moderation.moderateComment(id, { action: "reject" }),
    ).toEqual({ id, moderation: "hidden" });
    expect(harness.commentPort.events.at(-1)).toMatchObject({
      action: "reject",
      subjectKind: "comment",
      subjectId: id,
      operatorLabel: "owner",
    });
    // Approving a rejected item is a conflict, not a silent republish.
    const audited = harness.commentPort.events.length;
    await expect(
      harness.moderation.moderateComment(id, { action: "approve" }),
    ).rejects.toMatchObject({ name: "CommunityConflictError" });
    await expect(
      harness.moderation.moderateComment(id, { action: "reject" }),
    ).rejects.toMatchObject({ name: "CommunityConflictError" });
    expect(harness.commentPort.events).toHaveLength(audited);
    // A rejected item can still be restored explicitly.
    expect(
      await harness.moderation.moderateComment(id, { action: "unhide" }),
    ).toEqual({ id, moderation: "visible" });
    await expect(
      harness.moderation.moderateComment(
        "comment-ffffffffffffffffffffffffffffffff" as CatalogCommentId,
        { action: "approve" },
      ),
    ).rejects.toMatchObject({ name: "CommunityNotFoundError" });
  });

  it("validates the command body strictly and never takes an actor label from it", async () => {
    const harness = createHarness();
    const id = await harness.submit("公开");
    for (const body of [
      { action: "hide", id },
      { action: "hide", operatorLabel: "attacker" },
      { action: "delete" },
      {},
      "hide",
    ])
      await expect(
        harness.moderation.moderateComment(id, body),
      ).rejects.toMatchObject({ name: "CommunityInputError" });
    expect(harness.commentPort.comments.get(id)?.moderation).toBe("visible");
    expect(harness.commentPort.events).toHaveLength(0);
  });

  it("applies a bounded selection one item at a time and reports each outcome truthfully", async () => {
    const harness = createHarness();
    harness.commentPort.policy = "PRE_MODERATION";
    const pendingA = await harness.submit("A");
    const pendingB = await harness.submit("B");
    harness.commentPort.policy = "DIRECT_PUBLICATION";
    const visible = await harness.submit("C");
    const unknown =
      "comment-ffffffffffffffffffffffffffffffff" as CatalogCommentId;
    harness.commentPort.failNextModeration = new Set([pendingB]);

    const first = await harness.moderation.moderateComments({
      action: "approve",
      ids: [pendingA, visible, unknown, pendingB],
    });
    expect(first).toEqual({
      action: "approve",
      results: [
        { id: pendingA, outcome: "applied", moderation: "visible" },
        { id: visible, outcome: "conflict" },
        { id: unknown, outcome: "not_found" },
        { id: pendingB, outcome: "failed" },
      ],
      applied: 1,
      conflicts: 1,
      notFound: 1,
      failed: 1,
    });
    expect(
      harness.commentPort.events.filter((event) => event.action === "approve"),
    ).toHaveLength(1);

    // Retrying only the failed item succeeds; retrying the applied one is a
    // conflict and records nothing more.
    const retry = await harness.moderation.moderateComments({
      action: "approve",
      ids: [pendingB, pendingA],
    });
    expect(retry.results).toEqual([
      { id: pendingB, outcome: "applied", moderation: "visible" },
      { id: pendingA, outcome: "conflict" },
    ]);
    expect(
      harness.commentPort.events.filter((event) => event.action === "approve"),
    ).toHaveLength(2);

    await expect(
      harness.moderation.moderateComments({
        action: "hide",
        ids: Array.from(
          { length: BULK_MODERATION_MAXIMUM + 1 },
          (_value, index) => `comment-${index.toString(16).padStart(32, "0")}`,
        ),
      }),
    ).rejects.toMatchObject({ name: "CommunityInputError" });
    await expect(
      harness.moderation.moderateComments({
        action: "hide",
        ids: [pendingA, pendingA],
      }),
    ).rejects.toMatchObject({ name: "CommunityInputError" });
  });

  it("reads the queue with search, filters, counts, review order and Catalog titles", async () => {
    const harness = createHarness();
    const root = await harness.submit("字口清晰");
    harness.advance(1_000);
    const other = await harness.submit("另一条", fixtureUsers.second.id);
    harness.advance(1_000);
    const replyId = await harness.reply(root, "回复字口");
    await harness.moderation.moderateComment(replyId, { action: "hide" });

    const page = await harness.moderation.readComments({});
    expect(operatorCommentPageSchema.parse(page)).toEqual(page);
    expect(page.items.map((item) => item.id)).toEqual([replyId, other, root]);
    expect(page.counts).toEqual({ pending: 0, visible: 2, hidden: 1, all: 3 });
    expect(page.items[0]?.catalogTitle).toBe(`资料 ${publishedCatalogId}`);

    expect(
      (await harness.moderation.readComments({ order: "oldest" })).items.map(
        (item) => item.id,
      ),
    ).toEqual([root, other, replyId]);
    expect(
      (await harness.moderation.readComments({ search: "字口" })).items.map(
        (item) => item.id,
      ),
    ).toEqual([replyId, root]);
    expect(
      (
        await harness.moderation.readComments({
          search: fixtureUsers.second.handle,
        })
      ).items.map((item) => item.id),
    ).toEqual([replyId, other]);
    expect(
      (
        await harness.moderation.readComments({
          kind: "reply",
          moderation: "hidden",
        })
      ).items.map((item) => item.id),
    ).toEqual([replyId]);
    for (const query of [
      { search: "x".repeat(101) },
      { order: "hot" },
      { pageSize: 51 },
      { unknown: true },
    ])
      await expect(
        harness.moderation.readComments(query),
      ).rejects.toMatchObject({ name: "CommunityInputError" });
  });

  it("assembles item detail with thread context, parent restriction, history and the analysis state", async () => {
    const harness = createHarness();
    const root = await harness.submit("根评论");
    const first = await harness.reply(root, "第一条回复");
    const second = await harness.reply(root, "回复第一条", first);
    await harness.moderation.moderateComment(root, { action: "hide" });

    const detail = await harness.moderation.readCommentDetail(second);
    expect(operatorCommentDetailSchema.parse(detail)).toEqual(detail);
    expect(detail.item).toMatchObject({
      id: second,
      kind: "reply",
      replyToId: first,
    });
    expect(detail.root?.id).toBe(root);
    expect(detail.replyTo?.id).toBe(first);
    expect(detail.parentRestriction).toBe("root_hidden");
    expect(detail.history).toEqual([]);
    expect(detail.analysis).toEqual({ status: "not_connected" });

    const rootDetail = await harness.moderation.readCommentDetail(root);
    expect(rootDetail.root).toBeNull();
    expect(rootDetail.parentRestriction).toBe("none");
    expect(rootDetail.history.map((event) => event.action)).toEqual(["hide"]);
    await expect(
      harness.moderation.readCommentDetail(
        "comment-ffffffffffffffffffffffffffffffff" as CatalogCommentId,
      ),
    ).rejects.toMatchObject({ name: "CommunityNotFoundError" });
  });

  it("surfaces a connected analyzer's advisory result without letting it act", async () => {
    const result: CommentAnalysisState = {
      targetId: "comment-00000000000000000000000000000001" as CatalogCommentId,
      targetKind: "comment",
      contentHash: "a".repeat(64),
      analyzer: { name: "test-rules", version: "0.0.1" },
      runId: "run-1",
      occurredAt: "2026-09-12T16:00:00.000Z",
      status: "completed",
      reasonCodes: ["TEST_RULE"],
      explanation: "test adapter recommendation only",
      recommendation: "review",
    };
    const analysisPort: CommentAnalysisPort = {
      connected: true,
      readLatest: async (target) => ({ ...result, targetId: target.id }),
    };
    const harness = createHarness({ analysisPort });
    const id = await harness.submit("待分析");
    const detail = await harness.moderation.readCommentDetail(id);
    expect(detail.analysis).toMatchObject({
      status: "completed",
      recommendation: "review",
      targetId: id,
    });
    // The recommendation changed nothing and recorded nothing.
    expect(harness.commentPort.comments.get(id)?.moderation).toBe("visible");
    expect(harness.commentPort.events).toHaveLength(0);
    expect((await harness.moderation.readSummary({})).analysis).toEqual({
      connected: true,
    });
  });

  it("records a policy switch once and never a no-op choice", async () => {
    const harness = createHarness();
    const same = await harness.moderation.setPublicationPolicy({
      policy: "DIRECT_PUBLICATION",
    });
    expect(same.policy).toBe("DIRECT_PUBLICATION");
    expect(harness.commentPort.events).toHaveLength(0);
    await harness.moderation.setPublicationPolicy({ policy: "PRE_MODERATION" });
    expect(harness.commentPort.events.map((event) => event.action)).toEqual([
      "set_publication_policy",
    ]);
  });

  it("records a user transition with its status change once, and never for a repeated command", async () => {
    const harness = createHarness();
    const id = fixtureUsers.active.id;
    const first = await harness.moderation.moderateUser(id, {
      action: "suspend",
    });
    expect(first.status).toBe("suspended");
    // A retried suspend finds the user already suspended: same answer, no
    // second audit row.
    const again = await harness.moderation.moderateUser(id, {
      action: "suspend",
    });
    expect(again).toMatchObject({ id, status: "suspended" });
    expect(harness.commentPort.events.map((event) => event.action)).toEqual([
      "suspend",
    ]);
    expect(harness.commentPort.events[0]).toMatchObject({
      subjectKind: "user",
      subjectId: id,
      operatorLabel: "owner",
    });
    await harness.moderation.moderateUser(id, { action: "reinstate" });
    expect(harness.commentPort.events.map((event) => event.action)).toEqual([
      "suspend",
      "reinstate",
    ]);
  });

  it("refuses to suspend or reinstate a deleted account and records nothing", async () => {
    const harness = createHarness();
    const id = fixtureUsers.active.id;
    harness.identityPort.setStatus(id, "deleted");
    for (const action of ["suspend", "reinstate"] as const)
      await expect(
        harness.moderation.moderateUser(id, { action }),
      ).rejects.toMatchObject({ name: "CommunityConflictError" });
    expect(harness.identityPort.users.get(id)?.status).toBe("deleted");
    expect(harness.commentPort.events).toHaveLength(0);
  });

  it("leaves the user status unchanged when the audit row cannot be written", async () => {
    const harness = createHarness();
    const id = fixtureUsers.active.id;
    harness.identityPort.failNextAudit = true;
    await expect(
      harness.moderation.moderateUser(id, { action: "suspend" }),
    ).rejects.toThrow("Simulated audit insert failure");
    expect(harness.identityPort.users.get(id)?.status).toBe("active");
    expect(harness.commentPort.events).toHaveLength(0);
    // The next attempt succeeds and records exactly once.
    await harness.moderation.moderateUser(id, { action: "suspend" });
    expect(harness.identityPort.users.get(id)?.status).toBe("suspended");
    expect(harness.commentPort.events.map((event) => event.action)).toEqual([
      "suspend",
    ]);
  });

  it("leaves the publication policy unchanged when the audit row cannot be written", async () => {
    const harness = createHarness();
    harness.commentPort.failNextAudit = true;
    await expect(
      harness.moderation.setPublicationPolicy({ policy: "PRE_MODERATION" }),
    ).rejects.toThrow("Simulated audit insert failure");
    expect(harness.commentPort.policy).toBe("DIRECT_PUBLICATION");
    expect(harness.commentPort.events).toHaveLength(0);
    const switched = await harness.moderation.setPublicationPolicy({
      policy: "PRE_MODERATION",
    });
    expect(switched.policy).toBe("PRE_MODERATION");
    expect(harness.commentPort.events).toEqual([
      expect.objectContaining({
        action: "set_publication_policy",
        subjectKind: "setting",
        subjectId: "publication",
        detail: "PRE_MODERATION",
      }),
    ]);
  });

  it("reads the history and a ranged summary with explicit numbers", async () => {
    const harness = createHarness();
    harness.commentPort.policy = "PRE_MODERATION";
    const a = await harness.submit("甲");
    const b = await harness.submit("乙");
    await harness.moderation.moderateComment(a, { action: "approve" });
    await harness.moderation.moderateComment(b, { action: "reject" });
    await harness.moderation.setPublicationPolicy({
      policy: "DIRECT_PUBLICATION",
    });
    await harness.moderation.moderateUser(fixtureUsers.active.id, {
      action: "suspend",
    });
    // The range is half-open [from, to): events strictly before "now" count.
    harness.advance(1_000);

    const events = await harness.moderation.readModerationEvents({});
    expect(events.total).toBe(4);
    expect(events.items.map((event) => event.action)).toEqual([
      "suspend",
      "set_publication_policy",
      "reject",
      "approve",
    ]);
    expect(
      (await harness.moderation.readModerationEvents({ subjectId: b })).items,
    ).toHaveLength(1);
    await expect(
      harness.moderation.readModerationEvents({ action: "delete" }),
    ).rejects.toMatchObject({ name: "CommunityInputError" });

    const summary = await harness.moderation.readSummary({ range: "24h" });
    expect(moderationSummarySchema.parse(summary)).toEqual(summary);
    expect(summary.queue).toEqual({
      pending: 0,
      visible: 1,
      hidden: 1,
      all: 2,
    });
    expect(summary.actions).toEqual({
      delete_body: 0,
      remove_thread: 0,
      approve: 1,
      reject: 1,
      hide: 0,
      unhide: 0,
      suspend: 1,
      reinstate: 0,
      set_publication_policy: 1,
    });
    expect(summary.range.key).toBe("24h");
    expect(summary.policy.policy).toBe("DIRECT_PUBLICATION");
    expect(summary.recentEvents).toHaveLength(4);
    expect(summary.analysis).toEqual({ connected: false });
  });
});
