import { describe, expect, it, vi } from "vitest";
import type { ArticleConsentReview } from "@moya/contracts";
import { AuthorRequestError } from "../../../lib/public-api/author-community-client";
import { createArticleConsentAttempt } from "./article-consent-attempt";

const review = (): ArticleConsentReview => ({
  interactionUid: "synthetic-interaction",
  clientId: "synthetic-client",
  clientLabel: "Synthetic editor",
  redirectUris: ["https://example.invalid/callback"],
  resource: "https://example.invalid/mcp",
  scopes: ["artvenn:article:draft"],
  expiresAt: "2026-10-01T00:00:00Z",
  consentTicket: "SYNTHETIC_REVIEW_PLACEHOLDER_ONLY_123456",
});
const setup = (
  decide: Parameters<typeof createArticleConsentAttempt>[0]["decide"],
) => {
  const identity = { account: "synthetic-owner" as string | null, epoch: 1 };
  const requestId = vi.fn(() => "11111111-1111-4111-8111-111111111111");
  const attempt = createArticleConsentAttempt({
    ownerId: identity.account!,
    interactionUid: review().interactionUid,
    currentAccount: () => identity.account,
    accountEpoch: () => identity.epoch,
    requestId,
    decide,
  });
  return { attempt, identity, requestId };
};
describe("one-use human consent receipts", () => {
  it("recovers a committed decision with a lost response using exactly the same command and resume URL", async () => {
    const receipts = new Map<string, string>();
    const decide = vi.fn<
      Parameters<typeof createArticleConsentAttempt>[0]["decide"]
    >(async (_decision, command) => {
      const body = JSON.stringify(command);
      if (!receipts.has(command.requestId)) {
        receipts.set(command.requestId, body);
        throw new TypeError("synthetic lost committed response");
      }
      expect(body).toBe(receipts.get(command.requestId));
      return {
        decision: "approve",
        resumeUrl: "https://example.invalid/resume",
      };
    });
    const { attempt, requestId } = setup(decide);
    await expect(attempt.submit("approve", review())).rejects.toThrow();
    expect(attempt.unconfirmed()).toBe(true);
    const first = decide.mock.calls[0]![1];
    const reply = await attempt.submit("approve", review());
    expect(reply.resumeUrl).toBe("https://example.invalid/resume");
    expect(decide.mock.calls[1]![1]).toBe(first);
    expect(requestId).toHaveBeenCalledTimes(1);
    expect(attempt.pending()).toBeNull();
  });
  it("keeps an unknown decision bound to its ticket, scopes and chosen approval", async () => {
    const decide = vi
      .fn<Parameters<typeof createArticleConsentAttempt>[0]["decide"]>()
      .mockRejectedValue(
        new AuthorRequestError(502, "synthetic uncertain gateway"),
      );
    const { attempt } = setup(decide);
    const original = review();
    await expect(attempt.submit("approve", original)).rejects.toThrow();
    original.scopes.push("artvenn:article:publish");
    expect(attempt.pending()?.command.scopes).toEqual([
      "artvenn:article:draft",
    ]);
    await expect(attempt.submit("deny", review())).rejects.toThrow();
    await expect(
      attempt.submit("approve", {
        ...review(),
        consentTicket: "SYNTHETIC_CHANGED_PLACEHOLDER_ONLY_123456",
      }),
    ).rejects.toThrow();
    await expect(attempt.submit("approve", original)).rejects.toThrow();
    expect(decide).toHaveBeenCalledTimes(1);
    expect(attempt.unconfirmed()).toBe(true);
  });
  it("rejects late answers across A to B to A and releases the old session receipt", async () => {
    let finish!: (reply: { decision: "approve"; resumeUrl: string }) => void;
    const decide = vi.fn<
      Parameters<typeof createArticleConsentAttempt>[0]["decide"]
    >(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { attempt, identity } = setup(decide);
    const pending = attempt.submit("approve", review());
    await Promise.resolve();
    identity.account = "synthetic-other";
    identity.epoch++;
    identity.account = "synthetic-owner";
    identity.epoch++;
    attempt.dispose();
    finish({
      decision: "approve",
      resumeUrl: "https://example.invalid/resume",
    });
    await expect(pending).rejects.toBeInstanceOf(AuthorRequestError);
    expect(attempt.pending()).toBeNull();
    expect(attempt.isCurrent()).toBe(false);
  });
  it("releases a definitive refusal and preserves an invalid decision acknowledgement", async () => {
    const decide = vi
      .fn<Parameters<typeof createArticleConsentAttempt>[0]["decide"]>()
      .mockRejectedValueOnce(new AuthorRequestError(403, "synthetic refusal"))
      .mockResolvedValueOnce({
        decision: "deny",
        resumeUrl: "https://example.invalid/resume",
      });
    const { attempt, requestId } = setup(decide);
    await expect(attempt.submit("approve", review())).rejects.toThrow();
    expect(attempt.pending()).toBeNull();
    await expect(attempt.submit("approve", review())).rejects.toThrow();
    expect(attempt.unconfirmed()).toBe(true);
    expect(requestId).toHaveBeenCalledTimes(2);
  });
});
