// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => window.location.pathname,
}));

import { AuthReturnProvider, useAuthReturn } from "../auth/auth-return";
import { CommentSection, type CommentViewerState } from "./comment-section";
import { createQaCommentFixture } from "./comment-scenarios";
import type { CommentItem } from "./comment-types";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const contentId = "synthetic-auth-return-catalog";
const sourcePath = `/?catalogId=${contentId}#detail`;
const authPath = `/login?return=${encodeURIComponent(sourcePath)}`;
const ownerA = { id: "synthetic-owner-a", name: "合成原账户", avatarSrc: null };
const ownerB = {
  id: "synthetic-owner-b",
  name: "合成其他账户",
  avatarSrc: null,
};
const guest = { id: "checking-guest", name: "访客", avatarSrc: null };
const draft = "尚未提交的合成第二页回复";
const fixtures = createQaCommentFixture("comment-default", contentId);
const laterPageTarget = fixtures[0]!;
const firstPageItem = fixtures[1]!;
const nativeReplace = window.history.replaceState;

describe("CommentSection authentication return", () => {
  let container: HTMLDivElement;
  let root: Root;
  let context: ReturnType<typeof useAuthReturn>;
  let onSendComment: ReturnType<typeof vi.fn<() => void>>;
  let onSendReply: ReturnType<typeof vi.fn<() => void>>;

  const Probe = () => {
    context = useAuthReturn();
    return null;
  };
  const state = () => {
    if (!context) throw new Error("Auth return provider was not mounted");
    return context;
  };
  const render = async ({
    user = ownerA,
    viewer = { state: "signed-in" },
    items = [laterPageTarget],
    loading = false,
    mounted = true,
  }: {
    user?: typeof ownerA;
    viewer?: CommentViewerState;
    items?: readonly CommentItem[];
    loading?: boolean;
    mounted?: boolean;
  } = {}) => {
    await act(async () =>
      root.render(
        <AuthReturnProvider>
          <Probe />
          {mounted && (
            <CommentSection
              key={user.id}
              catalogId={contentId}
              currentUser={user}
              viewer={viewer}
              items={items}
              loading={loading}
              presentation="live"
              totalCount={2}
              onSendComment={onSendComment}
              onSendReply={onSendReply}
            />
          )}
        </AuthReturnProvider>,
      ),
    );
  };

  beforeEach(() => {
    window.history.replaceState(
      { __NA: true, __artvennEntry: "synthetic-source-entry" },
      "",
      sourcePath,
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    context = null;
    onSendComment = vi.fn();
    onSendReply = vi.fn();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  const captureUnsentReply = async () => {
    await render();
    const replyAction = container.querySelector<HTMLElement>(
      `[data-comment-id="${laterPageTarget.id}"] [data-comment-reply-action]`,
    );
    if (!replyAction) throw new Error("Synthetic reply action was unavailable");
    await act(async () => replyAction.click());
    const textarea = container.querySelector("textarea");
    if (!textarea) throw new Error("Synthetic reply composer was unavailable");
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      setter?.call(textarea, draft);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(textarea.value).toBe(draft);
    expect(textarea.getAttribute("aria-label")).toBe(
      `回复 ${laterPageTarget.user.name}`,
    );
    state().capture(sourcePath, null);
    const sourceEntry: unknown = window.history.state;
    await act(async () =>
      window.history.pushState({ __NA: true }, "", authPath),
    );
    expect(state().hasSource()).toBe(true);
    await render({ mounted: false });
    return sourceEntry;
  };
  const returnWhileChecking = async (sourceEntry: unknown) => {
    await act(async () => {
      // Native browser traversal bypasses the provider's push/replace wrappers.
      nativeReplace.call(window.history, sourceEntry, "", sourcePath);
      window.dispatchEvent(
        new PopStateEvent("popstate", { state: sourceEntry }),
      );
    });
    expect(state().isRestoring()).toBe(true);
    const take = vi.spyOn(state(), "take");
    await render({
      user: guest,
      viewer: { state: "checking" },
      items: [],
      loading: true,
    });
    expect(container.querySelector("textarea")).toBeNull();
    expect(take).not.toHaveBeenCalled();
    return take;
  };
  const expectNoAutomaticWrite = () => {
    expect(onSendComment).not.toHaveBeenCalled();
    expect(onSendReply).not.toHaveBeenCalled();
  };

  it("restores the confirmed owner's reply to a later-page root after checking and page-one loading", async () => {
    const sourceEntry = await captureUnsentReply();
    const take = await returnWhileChecking(sourceEntry);
    state().identify(ownerA.id);
    await render({ items: [], loading: true });
    expect(take).toHaveBeenCalledTimes(1);
    expect(take).toHaveBeenCalledWith(ownerA.id, contentId);
    expectNoAutomaticWrite();

    // An absent row in page one does not prove a captured page-two root was deleted.
    await render({ items: [firstPageItem], loading: false });
    expect(
      container.querySelector(`[data-comment-id="${laterPageTarget.id}"]`),
    ).toBeNull();
    expect(container.querySelector("textarea")?.value).toBe(draft);
    expect(
      container.querySelector("textarea")?.getAttribute("aria-label"),
    ).toBe(`回复 ${laterPageTarget.user.name}`);
    expect(
      container.querySelector("[data-comment-reply-mode]")?.textContent,
    ).toContain(laterPageTarget.user.name);
    expectNoAutomaticWrite();

    await render({ items: [firstPageItem, laterPageTarget], loading: false });
    expect(container.querySelector("textarea")?.value).toBe(draft);
    expect(
      container.querySelector("textarea")?.getAttribute("aria-label"),
    ).toBe(`回复 ${laterPageTarget.user.name}`);
    expect(take).toHaveBeenCalledTimes(1);
    expectNoAutomaticWrite();
  });

  it("does not expose the source owner's draft or reply target to a different confirmed account", async () => {
    const sourceEntry = await captureUnsentReply();
    const take = await returnWhileChecking(sourceEntry);
    state().identify(ownerB.id);
    await render({ user: ownerB, items: [], loading: true });
    expect(take).toHaveBeenCalledWith(ownerB.id, contentId);
    await render({ user: ownerB, items: [firstPageItem], loading: false });
    expect(container.querySelector("textarea")?.value).toBe("");
    expect(
      container.querySelector("textarea")?.getAttribute("aria-label"),
    ).toBe("写下你的评论");
    expect(container.querySelector("[data-comment-reply-mode]")).toBeNull();
    expect(
      container.querySelector<HTMLButtonElement>('button[type="submit"]')
        ?.disabled,
    ).toBe(true);
    expect(state().take(ownerA.id, contentId)).toBeUndefined();
    expectNoAutomaticWrite();
  });
});
