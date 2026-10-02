import {
  ArticleAuthoringService,
  CommunityInputError,
  parseArticleId,
  parseArticleDraftCreateCommand,
  parseArticleDraftUpdateCommand,
  parseArticleCandidateCommand,
  parseArticleDraftListQuery,
  parseArticleBlockEditsCommand,
} from "@moya/api";
import type { ArticleAuthoringActor, ArticleAuthoringPort } from "@moya/api";
import type { ArticleDraft, ArticleId, PublicUserId } from "@moya/contracts";
import { emptyArticleDocument } from "@moya/contracts/schemas";
import { describe, expect, it, vi } from "vitest";

const actor: ArticleAuthoringActor = {
  source: "human",
  userId: "user-synthetic-author" as PublicUserId,
};
const articleId = `article-${"1".repeat(32)}` as ArticleId;
const requestId = "10000000-0000-4000-8000-000000000001";
const now = new Date("2026-09-30T10:00:00.000Z");
const content = () => ({
  title: "碑刻𠮷﨑與傳統字形",
  coverRefId: null,
  document: emptyArticleDocument(),
});
const draft = (): ArticleDraft => ({
  id: articleId,
  ownerId: actor.userId,
  version: 1,
  ...content(),
  status: "draft",
  publicVersion: null,
  updatedAt: now.toISOString(),
  fingerprint: "a".repeat(64),
});
const fixture = () => {
  const calls = {
    create: vi.fn(async () => draft()),
    save: vi.fn(async () => draft()),
    editBlocks: vi.fn(async () => draft()),
    publish: vi.fn(async () => draft()),
    listOwnMedia: vi.fn(async () => ({ items: [], nextCursor: null })),
    list: vi.fn(async () => ({ items: [], nextCursor: null })),
    read: vi.fn(async () => draft()),
  };
  const port: ArticleAuthoringPort = {
    ...calls,
    validate: async () => ({
      id: articleId,
      version: 1,
      fingerprint: "a".repeat(64),
      valid: true,
      issues: [],
    }),
    preview: async () => ({
      draft: draft(),
      validation: {
        id: articleId,
        version: 1,
        fingerprint: "a".repeat(64),
        valid: true,
        issues: [],
      },
    }),
    withdraw: async () => draft(),
    deleteDraft: async () => ({
      id: articleId,
      deleted: true,
      publicVersion: null,
    }),
    readPublished: async () => null,
    listPublished: async () => ({ items: [], total: 0 }),
  };
  const application = new ArticleAuthoringService(port, { now: () => now });
  return {
    calls,
    // Mirrors the thin HTTP/MCP boundary: parse, then call the shared service.
    service: {
      create: (who: ArticleAuthoringActor, input: unknown) =>
        application.create(who, parseArticleDraftCreateCommand(input)),
      save: (who: ArticleAuthoringActor, id: unknown, input: unknown) =>
        application.save(
          who,
          parseArticleId(id),
          parseArticleDraftUpdateCommand(input),
        ),
      publish: (who: ArticleAuthoringActor, id: unknown, input: unknown) =>
        application.publish(
          who,
          parseArticleId(id),
          parseArticleCandidateCommand(input),
        ),
      editBlocks: (who: ArticleAuthoringActor, id: unknown, input: unknown) =>
        application.editBlocks(
          who,
          parseArticleId(id),
          parseArticleBlockEditsCommand(input),
        ),
      list: (who: ArticleAuthoringActor, input: unknown) =>
        application.list(who, parseArticleDraftListQuery(input)),
      read: (who: ArticleAuthoringActor, id: unknown) =>
        application.read(who, parseArticleId(id)),
    },
  };
};

describe("Article shared transport parsing and application boundary", () => {
  it("uses transport identity and preserves the canonical Unicode document", async () => {
    const { service, calls } = fixture();
    const command = { requestId, ...content() };
    await service.create(actor, command);
    expect(calls.create).toHaveBeenCalledExactlyOnceWith(actor, command, now);
    expect(command.document.blocks[0]?.id).toBe("start");
    expect(command.title).toBe("碑刻𠮷﨑與傳統字形");
  });

  it.each(["ownerId", "authorId", "source", "byline", "confirmed"])(
    "refuses a public identity/approval override %s",
    (field) => {
      const { service, calls } = fixture();
      expect(() =>
        service.create(actor, {
          requestId,
          ...content(),
          [field]: "synthetic-override",
        }),
      ).toThrow(CommunityInputError);
      expect(calls.create).not.toHaveBeenCalled();
    },
  );

  it("refuses a future document without mutating or sending it to persistence", () => {
    const { service, calls } = fixture();
    const command = {
      requestId,
      ...content(),
      document: { ...emptyArticleDocument(), version: 2, future: "保留𠮷" },
    };
    const before = structuredClone(command);
    expect(() => service.create(actor, command)).toThrow(CommunityInputError);
    expect(command).toEqual(before);
    expect(calls.create).not.toHaveBeenCalled();
  });

  it("requires an expected version on writes", () => {
    const { service, calls } = fixture();
    expect(() =>
      service.save(actor, articleId, { requestId, ...content() }),
    ).toThrow(CommunityInputError);
    expect(calls.save).not.toHaveBeenCalled();
  });

  it("preserves the exact publication candidate and rejects model self-confirmation", async () => {
    const { service, calls } = fixture();
    const command = {
      requestId,
      expectedVersion: 7,
      fingerprint: "b".repeat(64),
    };
    await service.publish(actor, articleId, command);
    expect(calls.publish).toHaveBeenCalledExactlyOnceWith(
      actor,
      articleId,
      command,
      now,
    );
    expect(() =>
      service.publish(actor, articleId, { ...command, confirmed: true }),
    ).toThrow(CommunityInputError);
    expect(calls.publish).toHaveBeenCalledTimes(1);
  });

  it("keeps block edits behind the transactional port rather than a pre-read replay path", async () => {
    const { service, calls } = fixture();
    const command = {
      requestId,
      expectedVersion: 4,
      edits: [{ type: "move", blockId: "photo", afterBlockId: "start" }],
    };
    await service.editBlocks(actor, articleId, command);
    expect(calls.editBlocks).toHaveBeenCalledExactlyOnceWith(
      actor,
      articleId,
      command,
      now,
    );
    expect(calls.read).not.toHaveBeenCalled();
    expect(calls.save).not.toHaveBeenCalled();
  });

  it("bounds list requests and supplies the shared cursor default", async () => {
    const { service, calls } = fixture();
    await service.list(actor, {});
    expect(calls.list).toHaveBeenCalledExactlyOnceWith(
      actor,
      { pageSize: 20 },
      now,
    );
    expect(() => service.list(actor, { pageSize: 51 })).toThrow(
      CommunityInputError,
    );
    expect(() => service.list(actor, { ownerId: "user-other" })).toThrow(
      CommunityInputError,
    );
    expect(calls.list).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-Article identifier without exposing a lookup result", () => {
    const { service, calls } = fixture();
    expect(() => service.read(actor, "work-synthetic")).toThrow(
      CommunityInputError,
    );
    expect(calls.read).not.toHaveBeenCalled();
  });
});
