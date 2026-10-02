// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type {
  ArticleConsentReview,
  CreateArticleAuthoringGrantCommand,
} from "@moya/contracts";
const identity = vi.hoisted(() => ({
  owner: "synthetic-owner",
  epoch: 1,
  checking: false,
}));
const client = vi.hoisted(() => ({
  consent:
    vi.fn<
      (uid: string, signal: AbortSignal) => Promise<ArticleConsentReview>
    >(),
  decide:
    vi.fn<
      (
        decision: "approve" | "deny",
        command: CreateArticleAuthoringGrantCommand,
      ) => Promise<{ decision: "approve" | "deny"; resumeUrl: string }>
    >(),
}));
vi.mock("../../authors/author-context", () => ({
  useAuthors: () => ({
    viewer: { id: identity.owner, displayName: "Synthetic owner" },
    checking: identity.checking,
  }),
}));
vi.mock("../../../lib/public-api/article-delegation-client", () => ({
  articleDelegationClient: client,
}));
vi.mock("../../../lib/public-api/author-community-client", () => ({
  AuthorRequestError: class extends Error {
    constructor(
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  },
  authorClient: {
    account: () => identity.owner,
    accountEpoch: () => identity.epoch,
  },
}));
import { ArticleAgentConsent } from "./article-delegation";
const review = (uid = "synthetic-interaction"): ArticleConsentReview => ({
  interactionUid: uid,
  clientId: "synthetic-client",
  clientLabel: "Synthetic assistant",
  redirectUris: ["https://example.invalid/callback"],
  resource: "https://example.invalid/mcp",
  scopes: ["artvenn:article:draft"],
  expiresAt: "2026-10-01T00:00:00Z",
  consentTicket: "SYNTHETIC_REVIEW_PLACEHOLDER_ONLY_123456",
});
let root: Root, node: HTMLDivElement;
const render = async () =>
  act(async () =>
    root.render(
      <StrictMode>
        <ArticleAgentConsent interactionUid="synthetic-interaction" />
      </StrictMode>,
    ),
  );
const click = async (text: string) => {
  const button = [...node.querySelectorAll("button")].find(
    (item) => item.textContent === text,
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
};
beforeEach(() => {
  // Exercise actual consent receipts on the Owner's LAN HTTP origin.
  vi.stubGlobal("crypto", {
    getRandomValues: crypto.getRandomValues.bind(crypto),
  });
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  identity.owner = "synthetic-owner";
  identity.epoch = 1;
  identity.checking = false;
  client.consent.mockReset().mockImplementation(async (uid) => review(uid));
  client.decide.mockReset();
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
  vi.unstubAllGlobals();
});
describe("human consent retry UI", () => {
  it("preserves the exact unknown command through account revalidation and offers only the previous decision", async () => {
    client.decide
      .mockRejectedValueOnce(new TypeError("synthetic lost response"))
      .mockImplementation(() => new Promise(() => {}));
    await render();
    await click("同意这些权限");
    const first = client.decide.mock.calls[0]![1];
    expect(node.textContent).toContain("结果尚未确认");
    expect(node.textContent).not.toContain("拒绝");
    const reviews = client.consent.mock.calls.length;
    identity.checking = true;
    await render();
    expect(node.textContent).toContain("正在确认当前作者账户");
    identity.checking = false;
    await render();
    expect(client.consent).toHaveBeenCalledTimes(reviews);
    await click("重试上次同意决定");
    expect(client.decide.mock.calls[1]![1]).toBe(first);
    expect(client.decide.mock.calls[1]![0]).toBe("approve");
  });
  it("discards an old account receipt and starts a new reviewed interaction after an epoch change", async () => {
    client.decide.mockRejectedValue(new TypeError("synthetic lost response"));
    await render();
    await click("同意这些权限");
    const first = client.decide.mock.calls[0]![1];
    const reviews = client.consent.mock.calls.length;
    identity.owner = "synthetic-other";
    identity.epoch++;
    await render();
    expect(client.consent.mock.calls.length).toBeGreaterThan(reviews);
    expect(node.textContent).not.toContain("重试上次");
    await click("拒绝");
    expect(client.decide.mock.calls[1]![1].requestId).not.toBe(first.requestId);
    expect(client.decide.mock.calls[1]![0]).toBe("deny");
  });
  it("does not restore a late consent review after another account has taken over", async () => {
    let finish!: (value: ArticleConsentReview) => void;
    client.consent.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    // StrictMode's second lifetime intentionally issues the current account read.
    client.consent.mockResolvedValue(review());
    await render();
    identity.owner = "synthetic-other";
    identity.epoch++;
    await render();
    await act(async () =>
      finish({ ...review(), clientLabel: "Late old assistant" }),
    );
    expect(node.textContent).not.toContain("Late old assistant");
  });
});
