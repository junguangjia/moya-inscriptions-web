import { randomUUID } from "node:crypto";
import {
  CatalogCommentService,
  CommunityAuthService,
  CommunityConflictError,
  createMemoryCommunityAuthPort,
} from "@moya/api";
import {
  asCommunityOperationError,
  mapCommentRow,
  mapOperatorCommentRow,
  mapPublicUserRow,
  mapReplyRow,
} from "@moya/community-postgres";
import {
  agentUserCandidateSchema,
  operatorAuthorSchema,
  operatorDmConversationSchema,
  operatorUserSchema,
  operatorWorkSchema,
  operatorWorkSubmissionSchema,
  publishingJobKindSchema,
  userModerationResultSchema,
} from "@moya/contracts/internal/community-operator";
import {
  authAccountDeletionRequestSchema,
  authAccountDeletionResultSchema,
  catalogCommentReplySchema,
  commentAuthorSchema,
} from "@moya/contracts/schemas";
import { authJsonSchemas } from "@moya/contracts/json-schema";
import { describe, expect, it } from "vitest";

import {
  FixtureCatalogPublicationPort,
  InMemoryCommunityCommentPort,
  publishedCatalogId,
} from "./community-comment-fixture.js";
import { fixtureUsers } from "./community-identity-fixture.js";
import {
  registerPasswordCase,
  sendAnonymousSignInCase,
  type PasswordHarness,
} from "./password-auth-cases.js";

/*
 * account-deletion-v1 foundation (D1): the shared contracts D2-D4 consume,
 * the `deleted` status plumbing that keeps every reader from throwing, the
 * comment author marker, and the appeal paths that never admit a deleted
 * account. All accounts, contacts and tokens are synthetic.
 */

const userId = `user-${"d".repeat(32)}`;
const commentId = (n: number) => `comment-${String(n).repeat(32)}`;

describe("account deletion contracts", () => {
  it("binds a deletion request to a re-verification token and an idempotency key only", () => {
    const request = {
      reauthToken: "R".repeat(43),
      idempotencyKey: randomUUID(),
    };
    expect(authAccountDeletionRequestSchema.parse(request)).toEqual(request);
    for (const invalid of [
      { ...request, reauthToken: "short" },
      { ...request, idempotencyKey: "not-a-uuid" },
      { idempotencyKey: request.idempotencyKey },
      // No account is ever named by identifier.
      { ...request, userId },
      { ...request, handle: "someone" },
    ])
      expect(authAccountDeletionRequestSchema.safeParse(invalid).success).toBe(
        false,
      );
    const result = {
      outcome: "deleted",
      deletedAt: "2026-10-27T01:00:00.000Z",
    };
    expect(authAccountDeletionResultSchema.parse(result)).toEqual(result);
    for (const invalid of [
      { ...result, outcome: "pending" },
      { ...result, deletedAt: "2026-10-27T09:00:00+08:00" },
      { ...result, userId },
    ])
      expect(authAccountDeletionResultSchema.safeParse(invalid).success).toBe(
        false,
      );
    expect(Object.keys(authJsonSchemas)).toEqual(
      expect.arrayContaining([
        "AuthAccountDeletionRequest",
        "AuthAccountDeletionResult",
      ]),
    );
  });

  it("marks only a deleted comment author, and only as true", () => {
    const author = { id: userId, displayName: "已注销用户" };
    expect(commentAuthorSchema.parse({ ...author, deleted: true })).toEqual({
      ...author,
      deleted: true,
    });
    expect(commentAuthorSchema.parse(author)).toEqual(author);
    for (const deleted of [false, "true", 1])
      expect(
        commentAuthorSchema.safeParse({ ...author, deleted }).success,
      ).toBe(false);
    // Still no status or handle on the public author shape.
    expect(
      commentAuthorSchema.safeParse({ ...author, status: "deleted" }).success,
    ).toBe(false);
  });

  it("lets every strict operator status read carry a deleted account", () => {
    const base = { id: userId, handle: "deleted-account" };
    expect(
      operatorAuthorSchema.parse({
        ...base,
        displayName: "已注销用户",
        status: "deleted",
      }).status,
    ).toBe("deleted");
    expect(operatorUserSchema.shape.status.parse("deleted")).toBe("deleted");
    expect(operatorWorkSchema.shape.authorStatus.parse("deleted")).toBe(
      "deleted",
    );
    expect(agentUserCandidateSchema.shape.status.parse("deleted")).toBe(
      "deleted",
    );
    expect(userModerationResultSchema.shape.status.parse("deleted")).toBe(
      "deleted",
    );
    expect(
      operatorDmConversationSchema.shape.participants.element.shape.status.parse(
        "deleted",
      ),
    ).toBe("deleted");
    expect(
      operatorWorkSubmissionSchema.shape.author.shape.status.parse("deleted"),
    ).toBe("deleted");
    for (const schema of [
      operatorUserSchema.shape.status,
      operatorWorkSchema.shape.authorStatus,
      agentUserCandidateSchema.shape.status,
    ])
      expect(schema.safeParse("closed").success).toBe(false);
  });

  it("lists the account purge as a durable job kind", () => {
    expect(publishingJobKindSchema.options).toContain("purge_deleted_account");
    expect(publishingJobKindSchema.options.at(-1)).toBe(
      "purge_deleted_account",
    );
  });
});

describe("deleted status plumbing", () => {
  const row = {
    id: commentId(1),
    catalog_id: "synthetic-deletion",
    root_comment_id: commentId(2),
    text: "合成评论",
    created_at: new Date("2026-10-27T01:00:00.000Z"),
    moderation: "visible",
    author_id: userId,
    author_display_name: "已注销用户",
    author_studio_name: "",
    author_status: "deleted",
    reply_to_author_id: fixtureUsers.second.id,
    reply_to_display_name: fixtureUsers.second.displayName,
    reply_to_studio_name: "",
    reply_to_status: "active",
  };

  it("maps a deleted account's session user instead of failing closed", () => {
    expect(
      mapPublicUserRow({
        id: userId,
        handle: "deleted-account",
        display_name: "已注销用户",
        studio_name: "",
        status: "deleted",
      }),
    ).toMatchObject({ id: userId, status: "deleted" });
    expect(() =>
      mapPublicUserRow({
        id: userId,
        handle: "deleted-account",
        display_name: "已注销用户",
        status: "closed",
      }),
    ).toThrow("Invalid PostgreSQL public user row");
  });

  it("marks a deleted comment or reply author and leaves others unmarked", () => {
    expect(mapCommentRow(row).author).toEqual({
      id: userId,
      displayName: "已注销用户",
      studioName: "",
      deleted: true,
    });
    const reply = mapReplyRow(row);
    expect(reply.author.deleted).toBe(true);
    expect(reply.replyTo).toEqual({
      id: fixtureUsers.second.id,
      displayName: fixtureUsers.second.displayName,
      studioName: "",
    });
    const answered = mapReplyRow({
      ...row,
      author_status: "suspended",
      reply_to_status: "deleted",
    });
    expect(answered.author).not.toHaveProperty("deleted");
    expect(answered.replyTo?.deleted).toBe(true);
    // Queries that select no status keep their earlier shape.
    expect(
      mapCommentRow({ ...row, author_status: undefined }).author,
    ).not.toHaveProperty("deleted");
    expect(() => mapCommentRow({ ...row, author_status: "closed" })).toThrow();
  });

  it("reads a deleted author in the operator comment queue", () => {
    expect(
      mapOperatorCommentRow({
        ...row,
        kind: "comment",
        author_handle: "deleted-account",
      }).author,
    ).toEqual({
      id: userId,
      handle: "deleted-account",
      displayName: "已注销用户",
      status: "deleted",
    });
  });

  it("carries the marker through the public comment DTOs", async () => {
    const comments = new InMemoryCommunityCommentPort();
    const service = new CatalogCommentService(
      comments,
      new FixtureCatalogPublicationPort(),
    );
    const root = (
      await service.createComment(publishedCatalogId, fixtureUsers.active.id, {
        text: "合成根评论",
      })
    ).item;
    const first = (
      await service.createReply(
        publishedCatalogId,
        root.id,
        fixtureUsers.second.id,
        { text: "合成回复" },
      )
    ).item;
    const second = (
      await service.createReply(
        publishedCatalogId,
        root.id,
        fixtureUsers.active.id,
        { text: "合成追问", replyTo: first.id },
      )
    ).item;
    // The account behind the root and first reply is deleted afterwards.
    const deleted = { id: fixtureUsers.second.id, displayName: "已注销用户" };
    comments.comments.set(root.id, {
      ...comments.comments.get(root.id)!,
      author: { ...deleted, deleted: true },
    });
    for (const [id, reply] of comments.replies)
      comments.replies.set(id, {
        ...reply,
        ...(id === first.id ? { author: { ...deleted, deleted: true } } : {}),
        ...(reply.replyTo === undefined
          ? {}
          : { replyTo: { ...deleted, deleted: true } }),
      });
    const page = await service.readComments(publishedCatalogId, {
      page: 1,
      pageSize: 20,
    });
    const listed = [...page.hot, ...page.items].find(
      (item) => item.id === root.id,
    )!;
    expect(listed.author).toEqual({ ...deleted, deleted: true });
    expect(listed.text).toBe("合成根评论");
    const answer = listed.replies.find((reply) => reply.id === first.id);
    const followUp = listed.replies.find((reply) => reply.id === second.id);
    expect(answer?.author.deleted).toBe(true);
    expect(followUp?.author).not.toHaveProperty("deleted");
    expect(followUp?.replyTo?.deleted).toBe(true);
    expect(catalogCommentReplySchema.parse(followUp)).toEqual(followUp);
  });

  it("reports the database's terminal-status refusal as a conflict", () => {
    const refused = asCommunityOperationError(
      Object.assign(new Error("deleted account is terminal"), {
        code: "23514",
        constraint: "public_users_status_terminal",
      }),
      "query",
    );
    expect(refused).toBeInstanceOf(CommunityConflictError);
    const other = Object.assign(new Error("check"), {
      code: "23514",
      constraint: "public_users_status_valid",
    });
    expect(asCommunityOperationError(other, "query")).toBe(other);
  });
});

describe("appeal paths never admit a deleted account", () => {
  const harness = (): PasswordHarness & {
    setStatus: (id: string, status: "deleted" | "suspended") => void;
  } => {
    let now = new Date("2026-10-27T01:00:00Z");
    let code = "";
    const port = createMemoryCommunityAuthPort();
    const serviceForPort: PasswordHarness["serviceForPort"] = (
      authPort,
      delivery,
    ) =>
      new CommunityAuthService(authPort, {
        environment: "development",
        profile: "full-local",
        keys: {
          version: 1,
          lookupKey: Buffer.alloc(32, 1),
          encryptionKey: Buffer.alloc(32, 2),
          otpKey: Buffer.alloc(32, 3),
        },
        emailMode: "local_capture",
        phoneMode: "simulated",
        clock: () => now,
        delivery: delivery ?? {
          sendEmail: async (input) => {
            code = input.code;
            return { state: "accepted", correlation: "synthetic" };
          },
          sendPhone: async () => ({ state: "failed" }),
          checkPhone: async () => "fail",
        },
      });
    return {
      service: serviceForPort(port),
      port,
      serviceForPort,
      suspend: async (id) => port.setStatus(id, "suspended"),
      setStatus: (id, status) => port.setStatus(id, status),
      latestCode: () => code,
      advance: (ms) => {
        now = new Date(now.getTime() + ms);
      },
    };
  };
  const appealLogin = (h: PasswordHarness, email: string) =>
    h.service.passwordLogin({
      channel: "email",
      identifier: email,
      password: "SYNTHETIC_A1",
      idempotencyKey: randomUUID(),
      source: "synthetic-deletion-case",
      appealOnly: true,
    });

  it("refuses password and OTP appeal sign-in while stale rows still name it", async () => {
    const h = harness();
    const email = `${randomUUID()}@example.invalid`;
    const account = await registerPasswordCase(h, email);
    // Suspended owners keep their appeal path.
    h.setStatus(account.session.profile.id, "suspended");
    const appeal = await appealLogin(h, email);
    expect(appeal.ok).toBe(true);
    if (!appeal.ok) throw Error("Synthetic appeal login refused");
    expect((await h.service.readAppealSession(appeal.value.token)).ok).toBe(
      true,
    );

    // Deletion normally erases the identity and credential; even without
    // that, the terminal status alone refuses every appeal.
    h.setStatus(account.session.profile.id, "deleted");
    expect(await h.service.readAppealSession(appeal.value.token)).toMatchObject(
      { ok: false, reason: "AUTH_UNAUTHENTICATED" },
    );
    expect(await appealLogin(h, email)).toMatchObject({
      ok: false,
      reason: "AUTH_INVALID_CREDENTIALS",
    });
    const challenge = await sendAnonymousSignInCase(h, email);
    expect(
      await h.service.verifyChallenge({
        ...challenge.command,
        appealOnly: true,
      }),
    ).toMatchObject({ ok: false, reason: "AUTH_ACCOUNT_SUSPENDED" });
    const ordinary = await sendAnonymousSignInCase(h, email);
    expect(await h.service.verifyChallenge(ordinary.command)).toMatchObject({
      ok: false,
      reason: "AUTH_ACCOUNT_SUSPENDED",
    });
  });
});
