import { describe, expect, it, vi } from "vitest";
import type {
  ArticleDraft,
  ArticlePublishResult,
  UpdateArticleDraftCommand,
} from "@moya/contracts";
import { ArticleRequestError } from "../../../lib/public-api/article-authoring-client";
import { createArticleAutosave } from "./article-autosave";
import { createArticlePublicationAttempt } from "./article-publication-attempt";

const initial: ArticleDraft = {
  id: `article-${"1".repeat(32)}` as ArticleDraft["id"],
  ownerId: `user-${"2".repeat(32)}` as ArticleDraft["ownerId"],
  version: 2,
  title: "提交候选𠮷",
  coverRefId: null,
  status: "draft",
  publicVersion: null,
  document: {
    format: "blocknote",
    version: 1,
    blocks: [
      {
        id: "p1",
        type: "paragraph",
        props: {},
        content: [{ type: "text", text: "保留候选\\n原样", styles: {} }],
        children: [],
      },
    ],
    references: {},
    galleries: {},
  },
  updatedAt: "2026-09-30T00:00:00.000Z",
  fingerprint: "a".repeat(64),
};
const checkpoint = {
  version: 2,
  fingerprint: initial.fingerprint,
  generation: 0,
};
const receipt = (requestId: string): ArticlePublishResult => ({
  requestId,
  status: "pending",
  draft: { ...initial, status: "pending", version: 3 },
});
const requestIds = () => {
  let sequence = 0;
  return () =>
    `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
};
type Publish = Parameters<typeof createArticlePublicationAttempt>[0]["publish"];
const create = (
  publish: Parameters<typeof createArticlePublicationAttempt>[0]["publish"],
) =>
  createArticlePublicationAttempt({
    ownerId: initial.ownerId,
    currentAccount: () => initial.ownerId,
    accountEpoch: () => 1,
    publish,
    requestId: requestIds(),
  });

describe("exact Article publication receipts", () => {
  it("recovers a committed publication after the response was lost with the identical receipt intent", async () => {
    const commands: unknown[] = [];
    const publish = vi.fn<Publish>(async (_id, command) => {
      commands.push(structuredClone(command));
      if (commands.length === 1) throw new ArticleRequestError(0, null, true);
      return receipt(command.requestId);
    });
    const attempt = create(publish);
    await expect(
      attempt.submit(initial, checkpoint, new AbortController().signal),
    ).rejects.toMatchObject({ outcomeUnknown: true });
    expect(attempt.unconfirmed()).toBe(true);
    const recovered = await attempt.submit(
      initial,
      checkpoint,
      new AbortController().signal,
    );
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
    expect(recovered.result.draft.version).toBe(3);
    expect(attempt.pending()).toBeNull();
  });
  it("keeps later dirty browser input while adopting the verified old publication candidate", async () => {
    let title = initial.title;
    const save = vi.fn(
      async (_id: ArticleDraft["id"], command: UpdateArticleDraftCommand) => ({
        ...initial,
        ...command,
        version: command.expectedVersion + 1,
      }),
    );
    const auto = createArticleAutosave({
      initial,
      client: { save, read: async () => initial },
      currentAccount: () => initial.ownerId,
      accountEpoch: () => 1,
      capture: () => ({ title, document: initial.document, coverRefId: null }),
      requestId: requestIds(),
      classifyFailure: (error) =>
        error instanceof ArticleRequestError
          ? error
          : { status: 0, reason: null, outcomeUnknown: true },
    });
    let count = 0;
    const attempt = create(async (_id, command) => {
      if (++count === 1) throw new ArticleRequestError(0, null, true);
      return receipt(command.requestId);
    });
    const exact = auto.publicationCheckpoint();
    await expect(
      attempt.submit(initial, exact, new AbortController().signal),
    ).rejects.toMatchObject({ outcomeUnknown: true });
    title = "回应丢失以后𠮷的新输入";
    auto.changed();
    const recovered = await attempt.submit(
      initial,
      exact,
      new AbortController().signal,
    );
    auto.adoptPublicationResult(recovered.result.draft, recovered.checkpoint);
    expect(auto.isDirty()).toBe(true);
    expect(title).toBe("回应丢失以后𠮷的新输入");
    await auto.flush();
    expect(save.mock.calls[0]![1]).toMatchObject({ expectedVersion: 3, title });
    auto.dispose();
  });
  it("keeps an unconfirmed intent when a different candidate is proposed", async () => {
    const publish = vi.fn<Publish>(async () => {
      throw new ArticleRequestError(0, null, true);
    });
    const attempt = create(publish);
    await expect(
      attempt.submit(initial, checkpoint, new AbortController().signal),
    ).rejects.toMatchObject({ outcomeUnknown: true });
    await expect(
      attempt.submit(
        { ...initial, version: 4 },
        { ...checkpoint, version: 4 },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ reason: "article_publication_unconfirmed" });
    expect(publish).toHaveBeenCalledOnce();
    expect(attempt.pending()?.command.expectedVersion).toBe(2);
  });
  it("creates a fresh intent only after a definitive refusal", async () => {
    const publish = vi.fn<Publish>(async (_id, command) => {
      if (publish.mock.calls.length === 1)
        throw new ArticleRequestError(422, "title_required", false);
      return receipt(command.requestId);
    });
    const attempt = create(publish);
    await expect(
      attempt.submit(initial, checkpoint, new AbortController().signal),
    ).rejects.toMatchObject({ outcomeUnknown: false });
    expect(attempt.pending()).toBeNull();
    await attempt.submit(initial, checkpoint, new AbortController().signal);
    expect(publish.mock.calls[1]![1].requestId).not.toBe(
      publish.mock.calls[0]![1].requestId,
    );
  });
});
