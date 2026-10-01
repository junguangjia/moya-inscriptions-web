// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type { DiscussionComment, DiscussionReply } from "@moya/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { profile, discussion, replies, send, context, openProfile } = vi.hoisted(
  () => ({
    profile: vi.fn(),
    discussion: vi.fn(),
    replies: vi.fn(),
    send: vi.fn(),
    openProfile: vi.fn(),
    context: {
      viewer: { id: "owner", displayName: "自己" } as {
        id: string;
        displayName: string;
      } | null,
      avatarSrc: "/api/community/media/owner-before" as string | null,
      checking: false,
      sessionError: false,
      revision: 0,
      cache: new Map<string, unknown>(),
      signInHref: "/dev/community",
    },
  }),
);
vi.mock("./author-data", () => ({
  authorClient: { profile, discussion, replies, send },
  AuthorRequestError: class extends Error {},
}));
vi.mock("./author-context", () => ({
  useAuthors: () => context,
  contentKey: (target: { type: string; id: string }) =>
    `${target.type}:${target.id}`,
}));
vi.mock("../product-shell/product-shell", () => ({
  useProductShell: () => ({ openProfile }),
}));
import { DiscussionSection } from "./discussion-section";
import { resetOwnWorkAudiences, setOwnWorkAudience } from "./own-work-audience";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const target = { type: "catalog", id: "synthetic-catalog" } as const;
const reply = (id: string, authorId: string): DiscussionReply => ({
  id: id as DiscussionReply["id"],
  author: {
    id: authorId as DiscussionReply["author"]["id"],
    displayName: authorId === "owner" ? "自己" : authorId,
  },
  text: id,
  createdAt: "2026-09-13T12:00:00.000Z",
  likeCount: 0,
  liked: false,
  deleted: false,
});
const comment = (
  id: string,
  authorId: string,
  children: DiscussionReply[] = [],
): DiscussionComment => ({
  ...reply(id, authorId),
  target,
  replies: children,
  replyTotal: children.length,
  replyPageTotal: children.length,
});
const listing = (
  items: DiscussionComment[],
  hot: DiscussionComment[] = [],
) => ({
  items,
  hot,
  visibleTotal: items.length + hot.length,
  total: items.length,
  page: 1,
  pageSize: 10,
  totalPages: 1,
});
const avatar = (id: string) => ({
  avatar: { src: `/api/community/media/${id}` },
});
let root: Root;
let node: HTMLDivElement;
const render = () =>
  act(async () => root.render(<DiscussionSection target={target} />));
const click = async (selector: string) => {
  const button = node.querySelector<HTMLButtonElement>(selector);
  if (!button) throw Error(`Missing ${selector}`);
  await act(async () => button.click());
};
const src = (selector: string) =>
  node
    .querySelector(`${selector} [data-comment-avatar]`)
    ?.querySelector("img")
    ?.getAttribute("src");
const deferred = () => {
  let resolve!: (value: ReturnType<typeof avatar>) => void;
  const promise = new Promise<ReturnType<typeof avatar>>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

beforeEach(() => {
  vi.resetAllMocks();
  Object.assign(context, {
    viewer: { id: "owner", displayName: "自己" },
    avatarSrc: "/api/community/media/owner-before",
    checking: false,
    sessionError: false,
    revision: 0,
    cache: new Map(),
  });
  profile.mockImplementation(async (id: string) => avatar(id));
  discussion.mockResolvedValue(
    listing(
      [comment("latest", "other", [reply("self-reply", "owner")])],
      [comment("hot", "owner", [reply("other-reply", "other")])],
    ),
  );
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.unmount());
  resetOwnWorkAudiences();
  document.body.replaceChildren();
});

describe("Phase 4 comment avatar synchronization", () => {
  it("updates own roots and replies immediately without losing an unsent draft or reloading comments", async () => {
    await render();
    expect(src('[data-comment-id="hot"]')).toBe(context.avatarSrc);
    expect(src('[data-comment-reply="self-reply"]')).toBe(context.avatarSrc);
    // Owner acceptance (2026-09-25): the composer is a box and a send button,
    // with no avatar of its own.
    expect(node.querySelector("[data-comment-composer] img")).toBeNull();
    const textarea = node.querySelector("textarea")!;
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(textarea, "尚未发送");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    context.avatarSrc = "/api/community/media/owner-saved";
    context.revision++;
    await render();
    for (const selector of [
      '[data-comment-id="hot"]',
      '[data-comment-reply="self-reply"]',
    ])
      expect(src(selector)).toBe(context.avatarSrc);
    expect(node.querySelector("textarea")?.value).toBe("尚未发送");
    expect(discussion).toHaveBeenCalledOnce();
    expect(profile.mock.calls.some(([id]) => id === "owner")).toBe(false);
    await click('[data-comment-id="hot"] > button');
    expect(openProfile).toHaveBeenCalledWith("owner", expect.any(HTMLElement));
  });

  it("deduplicates other authors across hot/latest/replies and resolves newly paged authors without refetching known ones", async () => {
    const page = listing(
      [comment("latest", "other", [])],
      [comment("hot", "other", [reply("preview", "other")])],
    );
    page.hot[0]!.replyPageTotal = 4;
    page.hot[0]!.replyTotal = 4;
    page.totalPages = 2;
    discussion.mockResolvedValueOnce(page).mockResolvedValueOnce({
      ...listing([comment("page2", "third")]),
      page: 2,
      totalPages: 2,
    });
    replies.mockResolvedValue({
      items: [reply("paged-reply", "fourth")],
      page: 1,
      pageSize: 10,
      total: 1,
    });
    await render();
    expect(src('[data-comment-id="latest"]')).toBe(
      "/api/community/media/other",
    );
    expect(src('[data-comment-reply="preview"]')).toBe(
      "/api/community/media/other",
    );
    expect(profile).toHaveBeenCalledOnce();
    await click("[data-comment-load-more]");
    expect(src('[data-comment-id="page2"]')).toBe("/api/community/media/third");
    await click("[data-comment-load-more-replies]");
    expect(src('[data-comment-reply="paged-reply"]')).toBe(
      "/api/community/media/fourth",
    );
    expect(profile.mock.calls.map(([id]) => id)).toEqual([
      "other",
      "third",
      "fourth",
    ]);
    expect(node.querySelector('[data-comment-id="page2"]')).not.toBeNull();
  });

  it("revalidates other profiles on revision, discards unavailable avatars and recovers on a later refresh", async () => {
    await render();
    profile.mockResolvedValueOnce(avatar("other-new"));
    context.revision++;
    await render();
    expect(src('[data-comment-id="latest"]')).toBe(
      "/api/community/media/other-new",
    );
    profile.mockRejectedValueOnce(Error("unavailable"));
    context.revision++;
    await render();
    expect(src('[data-comment-id="latest"]')).toBeUndefined();
    expect(
      node.querySelector('[data-comment-id="latest"] [data-comment-avatar]')
        ?.textContent,
    ).toBe("o");
    context.revision++;
    await render();
    expect(src('[data-comment-id="latest"]')).toBe(
      "/api/community/media/other",
    );
    expect(discussion).toHaveBeenCalledOnce();
  });

  it("cancels obsolete profile reads during a failed session check and ignores late responses", async () => {
    const old = deferred();
    profile.mockReturnValueOnce(old.promise);
    await render();
    const signal = profile.mock.calls[0]![1] as AbortSignal;
    context.checking = true;
    await render();
    expect(signal.aborted).toBe(true);
    context.checking = false;
    context.sessionError = true;
    await render();
    await act(async () => old.resolve(avatar("obsolete")));
    expect(node.querySelectorAll("[data-comment-avatar] img")).toHaveLength(0);
    expect(profile).toHaveBeenCalledOnce();
    context.sessionError = false;
    context.revision++;
    await render();
    expect(src('[data-comment-id="latest"]')).toBe(
      "/api/community/media/other",
    );
  });

  it("isolates account switches and permits only fresh public profile reads after logout", async () => {
    const old = deferred();
    profile.mockReturnValueOnce(old.promise);
    await render();
    context.viewer = { id: "other", displayName: "other" };
    context.avatarSrc = "/api/community/media/other-self";
    await render();
    await act(async () => old.resolve(avatar("old-account-response")));
    expect(src('[data-comment-id="latest"]')).toBe(context.avatarSrc);
    expect(src('[data-comment-id="hot"]')).toBe("/api/community/media/owner");
    context.viewer = null;
    context.avatarSrc = null;
    profile.mockResolvedValue({ avatar: null });
    await render();
    expect(node.querySelectorAll("[data-comment-avatar] img")).toHaveLength(0);
    expect(node.querySelector("[data-comment-signed-out]")).not.toBeNull();
    expect(
      profile.mock.calls
        .slice(-2)
        .map(([id]) => id)
        .sort(),
    ).toEqual(["other", "owner"]);
  });

  it("bounds simultaneous profile reads while loading many distinct authors", async () => {
    discussion.mockResolvedValue(
      listing(
        Array.from({ length: 7 }, (_, n) =>
          comment(`root-${n}`, `author-${n}`),
        ),
      ),
    );
    const pending = Array.from({ length: 7 }, deferred);
    profile.mockImplementation(
      (id: string) => pending[Number(id.split("-")[1])]!.promise,
    );
    await render();
    expect(profile).toHaveBeenCalledTimes(4);
    await act(async () => pending[0]!.resolve(avatar("first")));
    expect(profile).toHaveBeenCalledTimes(5);
    expect(src('[data-comment-id="root-0"]')).toBe(
      "/api/community/media/first",
    );
  });
});

describe("Discussion composer on the author's own work", () => {
  const work = { type: "work", id: `work-${"c".repeat(32)}` } as const;
  const renderWork = () =>
    act(async () => root.render(<DiscussionSection target={work} />));
  const composer = () => node.querySelector("[data-comment-composer]");
  const note = () =>
    node.querySelector("[data-discussion-closed]")?.textContent ?? null;

  it("gives way to a truthful note while only the author can see the work", async () => {
    setOwnWorkAudience("owner", work.id, {
      publiclyVisible: false,
      visibility: "self",
    });
    await renderWork();
    expect(composer()).toBeNull();
    expect(note()).toBe("此作品当前仅你可见，暂时无法发表评论。");
    // Said once, not repeated in the section's own notice line.
    expect(node.querySelector("[data-comment-notice]")).toBeNull();
    // Existing comments stay readable.
    expect(node.querySelector('[data-comment-id="hot"]')).not.toBeNull();
    expect(node.textContent).not.toMatch(/审核|待发布|等待/u);
  });

  it("uses neutral wording for a public work others cannot see yet", async () => {
    setOwnWorkAudience("owner", work.id, {
      publiclyVisible: false,
      visibility: "public",
    });
    await renderWork();
    expect(composer()).toBeNull();
    expect(note()).toBe("此作品当前不对其他人显示，暂时无法发表评论。");
    expect(node.textContent).not.toMatch(/审核|待发布|等待/u);
  });

  it("follows the record: closed without a claim while unknown, open once others can see the work", async () => {
    setOwnWorkAudience("owner", work.id, {
      publiclyVisible: null,
      visibility: "public",
    });
    await renderWork();
    expect(composer()).toBeNull();
    expect(note()).toBeNull();
    await act(async () =>
      setOwnWorkAudience("owner", work.id, {
        publiclyVisible: true,
        visibility: "public",
      }),
    );
    expect(composer()).not.toBeNull();
    expect(note()).toBeNull();
    await act(async () =>
      setOwnWorkAudience("owner", work.id, {
        publiclyVisible: false,
        visibility: "self",
      }),
    );
    expect(composer()).toBeNull();
    expect(note()).toBe("此作品当前仅你可见，暂时无法发表评论。");
  });

  it("says only that it cannot tell once reading the work again failed", async () => {
    setOwnWorkAudience("owner", work.id, {
      publiclyVisible: null,
      visibility: "public",
      unconfirmed: true,
    });
    await renderWork();
    expect(composer()).toBeNull();
    expect(note()).toBe("暂时无法确认其他人能否看到此作品，暂时无法发表评论。");
    expect(node.textContent).not.toMatch(/审核|待发布|等待/u);
  });

  it("keeps the note beside a comment loading error", async () => {
    setOwnWorkAudience("owner", work.id, {
      publiclyVisible: false,
      visibility: "self",
    });
    discussion.mockReset();
    discussion.mockRejectedValue(new Error("评论加载失败"));
    await renderWork();
    expect(
      node.querySelector('[data-comment-notice="error"]')?.textContent,
    ).toBe("评论加载失败");
    expect(note()).toBe("此作品当前仅你可见，暂时无法发表评论。");
    expect(composer()).toBeNull();
  });

  it("starts no reply while the comment box is closed, and does not reopen in reply mode", async () => {
    // 回复 is still a control inside CommentSection, which has no prop for a
    // closed box: the composer's place is empty, so nothing of a reply target
    // is rendered and no reply can be started here.
    setOwnWorkAudience("owner", work.id, {
      publiclyVisible: false,
      visibility: "self",
    });
    await renderWork();
    const reply = node.querySelector<HTMLButtonElement>(
      "[data-comment-reply-action]",
    );
    expect(reply).not.toBeNull();
    await act(async () => reply!.click());
    expect(composer()).toBeNull();
    expect(node.querySelector("[data-comment-reply-mode]")).toBeNull();
    expect(node.querySelector("textarea")).toBeNull();
    expect(node.textContent).not.toContain("回复 ");
    expect(note()).toBe("此作品当前仅你可见，暂时无法发表评论。");

    // Others can see the work again: the box comes back empty, never already
    // answering the comment the closed box could not reply to.
    await act(async () =>
      setOwnWorkAudience("owner", work.id, {
        publiclyVisible: true,
        visibility: "public",
      }),
    );
    expect(composer()).not.toBeNull();
    expect(note()).toBeNull();
    expect(node.querySelector("[data-comment-reply-mode]")).toBeNull();
    expect(node.querySelector("textarea")?.getAttribute("aria-label")).toBe(
      "写下你的评论",
    );
  });

  it("keeps the composer for other accounts, works without a record and catalog items", async () => {
    setOwnWorkAudience("someone-else", work.id, {
      publiclyVisible: false,
      visibility: "self",
    });
    await renderWork();
    expect(composer()).not.toBeNull();
    expect(note()).toBeNull();
    await act(async () => root.unmount());
    root = createRoot(node);
    setOwnWorkAudience("owner", target.id, {
      publiclyVisible: false,
      visibility: "self",
    });
    await render();
    expect(composer()).not.toBeNull();
  });
});

describe("Discussion total after posting", () => {
  it("keeps zero hidden and only refreshes the total after an actual successful post", async () => {
    discussion.mockResolvedValue(listing([]));
    await render();
    expect(node.querySelector("h2")!.textContent).toBe("评论");
    await render();
    expect(node.querySelector("h2")!.textContent).toBe("评论");
    const textarea = node.querySelector("textarea")!;
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(textarea, "真的发一条评论");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    send.mockRejectedValueOnce(new Error("发送失败"));
    await click('button[type="submit"]');
    expect(node.querySelector("h2")!.textContent).toBe("评论");
    expect(discussion).toHaveBeenCalledTimes(1);
    send.mockResolvedValueOnce({});
    discussion.mockResolvedValue(listing([comment("posted", "owner")]));
    await click('button[type="submit"]');
    expect(send).toHaveBeenCalledWith(
      target,
      "真的发一条评论",
      undefined,
      undefined,
    );
    expect(node.querySelector("h2")!.textContent).toBe("评论 1");
    expect(discussion).toHaveBeenCalledTimes(2);
  });
});
