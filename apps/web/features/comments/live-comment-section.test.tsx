// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LiveCommentSection } from "./live-comment-section";

import type { LiveCommentSource } from "./live-comments";
import type { Root } from "react-dom/client";
import type { CatalogComment, CatalogCommentReply } from "@moya/contracts";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
const now = () => new Date("2026-09-12T12:00:00.000Z");
const catalogId = "catalog-dev-acceptance-01";
const authors = [
  {
    id: "user-0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f01",
    displayName: "拓片爱好者",
    studioName: "听雨斋",
  },
  {
    id: "user-0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f02",
    displayName: "书法学徒",
    studioName: "山水书屋",
  },
] as const;
const profile = { ...authors[0], handle: "dev-user-01" };

const commentId = (n: number) =>
  `comment-${"0".repeat(20)}acce${n.toString(16).padStart(8, "0")}`;

const reply = (n: number, extra: Partial<CatalogCommentReply> = {}) =>
  ({
    id: commentId(100 + n),
    author: authors[1],
    text: `回复 ${n}`,
    createdAt: "2026-09-12T11:00:00.000Z",
    ...extra,
  }) as CatalogCommentReply;

const root = (
  n: number,
  replies: readonly CatalogCommentReply[],
  replyTotal = replies.length,
) =>
  ({
    id: commentId(n),
    catalogId,
    author: authors[0],
    text: `根评论 ${n}`,
    createdAt: "2026-09-12T10:00:00.000Z",
    replies,
    replyTotal,
  }) as CatalogComment;

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const render = async (source: LiveCommentSource) => {
  const container = document.createElement("div");
  document.body.append(container);
  const reactRoot = createRoot(container);
  roots.push(reactRoot);
  await act(async () => {
    reactRoot.render(
      <LiveCommentSection
        catalogId={catalogId}
        now={now}
        signInHref="/dev/community"
        source={source}
      />,
    );
  });
  await flush();
  return container;
};

const click = async (element: Element | null) => {
  if (!(element instanceof HTMLElement)) throw new Error("Missing element");
  await act(async () => element.click());
  await flush();
};

const fill = (textarea: HTMLTextAreaElement | null, value: string) => {
  if (textarea === null) throw new Error("Missing textarea");
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const ids = (container: Element, selector: string) =>
  [...container.querySelectorAll(selector)].map((element) =>
    element.getAttribute("data-comment-id"),
  );
const replyIds = (container: Element) =>
  [...container.querySelectorAll("[data-comment-reply]")].map((element) =>
    element.getAttribute("data-comment-reply"),
  );

const fakeSource = (
  overrides: Partial<LiveCommentSource> = {},
): LiveCommentSource => ({
  readListing: vi.fn().mockResolvedValue({
    state: "success",
    page: {
      hot: [],
      items: [],
      total: 0,
      page: 1,
      pageSize: 10,
      totalPages: 0,
    },
  }),
  readReplies: vi.fn().mockResolvedValue({
    state: "success",
    page: { items: [], total: 0, page: 1, pageSize: 10, totalPages: 0 },
  }),
  submitComment: vi.fn(),
  submitReply: vi.fn(),
  readViewer: vi.fn().mockResolvedValue({ state: "success", profile }),
  ...overrides,
});

afterEach(() => {
  for (const reactRoot of roots.splice(0)) act(() => reactRoot.unmount());
  document.body.replaceChildren();
});

describe("LiveCommentSection", () => {
  it("preserves the live author and reply-target studio names through presentation mapping", async () => {
    const container = await render(
      fakeSource({
        readListing: vi.fn().mockResolvedValue({
          state: "success",
          page: {
            hot: [],
            items: [
              root(1, [
                reply(1, {
                  replyTo: authors[0] as CatalogCommentReply["author"],
                }),
              ]),
            ],
            total: 1,
            page: 1,
            pageSize: 10,
            totalPages: 1,
          },
        }),
      }),
    );
    expect(
      container.querySelector('[data-comment-id] [aria-label="斋号：听雨斋"]'),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-comment-reply] [aria-label="斋号：山水书屋"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-comment-reply] [aria-label="斋号：听雨斋"]',
      ),
    ).not.toBeNull();
  });

  it("renders the Backend's hot section above the latest list, without sort or like controls", async () => {
    const hot = [
      root(1, [reply(1), reply(2), reply(3)], 12),
      root(2, [reply(4)]),
    ];
    const latest = [root(5, []), root(4, []), root(3, [])];
    const container = await render(
      fakeSource({
        readListing: vi.fn().mockResolvedValue({
          state: "success",
          page: {
            hot,
            items: latest,
            total: 3,
            page: 1,
            pageSize: 10,
            totalPages: 1,
          },
        }),
      }),
    );

    expect(
      container
        .querySelector("[data-comment-section]")
        ?.getAttribute("data-comment-presentation"),
    ).toBe("live");
    expect(ids(container, "[data-comment-hot] [data-comment-id]")).toEqual([
      commentId(1),
      commentId(2),
    ]);
    expect(ids(container, "[data-comment-latest] [data-comment-id]")).toEqual([
      commentId(5),
      commentId(4),
      commentId(3),
    ]);
    // Root count from the Backend: two hot plus three latest.
    expect(container.querySelector("h2")?.textContent).toContain("5");
    expect(container.querySelector("[data-comment-sort]")).toBeNull();
    expect(container.querySelector("[data-comment-like]")).toBeNull();
    expect(container.querySelector("[data-comment-load-more]")).toBeNull();
    // Real reply totals drive the load-more affordance, nothing else does.
    expect(
      container.querySelector(
        `[data-comment-id="${commentId(1)}"] [data-comment-load-more-replies]`,
      )?.textContent,
    ).toContain("还有 9 条");
    expect(
      container.querySelector(
        `[data-comment-id="${commentId(2)}"] [data-comment-load-more-replies]`,
      ),
    ).toBeNull();
  });

  it("pins the hot ids on load-more and never repeats a root", async () => {
    const hot = [root(1, [reply(1)])];
    const readListing = vi
      .fn()
      .mockResolvedValueOnce({
        state: "success",
        page: {
          hot,
          items: [root(9, []), root(8, [])],
          total: 4,
          page: 1,
          pageSize: 2,
          totalPages: 2,
        },
      })
      .mockResolvedValueOnce({
        state: "success",
        // A concurrent insert shifted the offset: root 8 repeats and must not show twice.
        page: {
          hot: [],
          items: [root(8, []), root(7, [])],
          total: 4,
          page: 2,
          pageSize: 2,
          totalPages: 2,
        },
      });
    const container = await render(fakeSource({ readListing }));

    await click(container.querySelector("[data-comment-load-more]"));
    expect(readListing).toHaveBeenLastCalledWith(catalogId, {
      page: 2,
      pageSize: 10,
      pinned: [commentId(1)],
    });
    expect(ids(container, "[data-comment-latest] [data-comment-id]")).toEqual([
      commentId(9),
      commentId(8),
      commentId(7),
    ]);
    expect(container.querySelector("[data-comment-load-more]")).toBeNull();
  });

  it("loads further replies through the reply page and deduplicates the embedded ones", async () => {
    const embedded = [reply(1), reply(2), reply(3)];
    const readReplies = vi.fn().mockResolvedValue({
      state: "success",
      page: {
        items: [reply(1), reply(2), reply(3), reply(4)],
        total: 4,
        page: 1,
        pageSize: 10,
        totalPages: 1,
      },
    });
    const container = await render(
      fakeSource({
        readListing: vi.fn().mockResolvedValue({
          state: "success",
          page: {
            hot: [root(1, embedded, 4)],
            items: [],
            total: 0,
            page: 1,
            pageSize: 10,
            totalPages: 0,
          },
        }),
        readReplies,
      }),
    );
    await click(container.querySelector("[data-comment-load-more-replies]"));
    expect(readReplies).toHaveBeenCalledWith(catalogId, commentId(1), {
      page: 1,
      pageSize: 10,
    });
    expect(container.querySelectorAll("[data-comment-reply]")).toHaveLength(4);
    expect(
      container.querySelector("[data-comment-load-more-replies]"),
    ).toBeNull();
  });

  it("replaces the composer with the sign-in link when signed out", async () => {
    const container = await render(
      fakeSource({
        readViewer: vi.fn().mockResolvedValue({ state: "unauthenticated" }),
      }),
    );
    expect(container.querySelector("[data-comment-composer]")).toBeNull();
    expect(
      container
        .querySelector("[data-comment-signed-out] a")
        ?.getAttribute("href"),
    ).toBe("/dev/community");
  });

  it("reports a pending submission truthfully and refreshes after a visible one", async () => {
    const readListing = vi.fn().mockResolvedValue({
      state: "success",
      page: {
        hot: [],
        items: [],
        total: 0,
        page: 1,
        pageSize: 10,
        totalPages: 0,
      },
    });
    const submitComment = vi
      .fn()
      .mockResolvedValueOnce({
        state: "success",
        item: root(1, []),
        awaitingApproval: true,
      })
      .mockResolvedValueOnce({
        state: "success",
        item: root(2, []),
        awaitingApproval: false,
      });
    const container = await render(fakeSource({ readListing, submitComment }));

    fill(container.querySelector("textarea"), "第一条");
    await click(
      container.querySelector("[data-comment-composer] button[type=submit]"),
    );
    expect(submitComment).toHaveBeenCalledWith(catalogId, "第一条");
    expect(
      container.querySelector("[data-comment-notice]")?.textContent,
    ).toContain("待审核");

    fill(container.querySelector("textarea"), "第二条");
    await click(
      container.querySelector("[data-comment-composer] button[type=submit]"),
    );
    expect(
      container.querySelector("[data-comment-notice]")?.textContent,
    ).toContain("已发布");
    // Initial load plus one refresh per submission.
    expect(readListing).toHaveBeenCalledTimes(3);
  });

  it("sends a reply to a sibling with its id and falls back to signed-out on 401", async () => {
    const submitReply = vi.fn().mockResolvedValue({ state: "unauthenticated" });
    const container = await render(
      fakeSource({
        readListing: vi.fn().mockResolvedValue({
          state: "success",
          page: {
            hot: [],
            items: [root(1, [reply(1)])],
            total: 1,
            page: 1,
            pageSize: 10,
            totalPages: 1,
          },
        }),
        submitReply,
      }),
    );
    await click(
      container.querySelector(
        "[data-comment-reply] [data-comment-reply-action]",
      ),
    );
    fill(container.querySelector("textarea"), "回复你");
    await click(
      container.querySelector("[data-comment-composer] button[type=submit]"),
    );
    expect(submitReply).toHaveBeenCalledWith(
      catalogId,
      commentId(1),
      "回复你",
      commentId(101),
    );
    expect(container.querySelector("[data-comment-signed-out]")).not.toBeNull();
    expect(
      container.querySelector("[data-comment-notice]")?.textContent,
    ).toContain("登录");
  });

  it("shows the unavailable state when the Backend cannot serve comments", async () => {
    const container = await render(
      fakeSource({
        readListing: vi.fn().mockResolvedValue({ state: "unavailable" }),
      }),
    );
    expect(
      container
        .querySelector("[data-comment-unavailable]")
        ?.getAttribute("data-comment-unavailable"),
    ).toBe("unavailable");
    expect(container.querySelector("[data-comment-list]")).toBeNull();
    // No count is claimed while the listing could not be read.
    expect(container.querySelector("h2")?.textContent?.trim()).toBe("评论");
  });

  it("keeps the draft in the composer after a failed submission", async () => {
    const submitComment = vi
      .fn()
      .mockResolvedValueOnce({ state: "unavailable" })
      .mockResolvedValueOnce({
        state: "success",
        item: root(1, []),
        awaitingApproval: false,
      });
    const container = await render(fakeSource({ submitComment }));

    fill(container.querySelector("textarea"), "还没发出去");
    await click(
      container.querySelector("[data-comment-composer] button[type=submit]"),
    );
    expect(
      container
        .querySelector("[data-comment-notice]")
        ?.getAttribute("data-comment-notice"),
    ).toBe("error");
    expect(container.querySelector("textarea")?.value).toBe("还没发出去");

    // The same text is sent again untouched; success then clears it.
    await click(
      container.querySelector("[data-comment-composer] button[type=submit]"),
    );
    expect(submitComment).toHaveBeenNthCalledWith(2, catalogId, "还没发出去");
    expect(container.querySelector("textarea")?.value).toBe("");
    expect(
      container.querySelector("[data-comment-notice]")?.textContent,
    ).toContain("已发布");
  });

  it("shows a published reply inside its thread at once, beyond the embedded page", async () => {
    const embedded = [reply(1), reply(2), reply(3)];
    const listingWithTotal = (replyTotal: number) => ({
      state: "success",
      page: {
        hot: [],
        items: [root(1, embedded, replyTotal)],
        total: 1,
        page: 1,
        pageSize: 10,
        totalPages: 1,
      },
    });
    const readListing = vi
      .fn()
      .mockResolvedValueOnce(listingWithTotal(3))
      // The refresh after the submission already counts the new reply.
      .mockResolvedValue(listingWithTotal(4));
    const submitReply = vi.fn().mockResolvedValue({
      state: "success",
      item: reply(9, { text: "第四条回复" }),
      awaitingApproval: false,
    });
    const container = await render(fakeSource({ readListing, submitReply }));

    await click(
      container.querySelector("[data-comment-id] [data-comment-reply-action]"),
    );
    fill(container.querySelector("textarea"), "第四条回复");
    await click(
      container.querySelector("[data-comment-composer] button[type=submit]"),
    );
    // The list refreshed as before (hot may change), and the reply shows.
    expect(readListing).toHaveBeenCalledTimes(2);
    expect(replyIds(container)).toEqual([
      commentId(101),
      commentId(102),
      commentId(103),
      commentId(109),
    ]);
    expect(container.textContent).toContain("第四条回复");
    expect(
      container.querySelector("[data-comment-load-more-replies]"),
    ).toBeNull();
  });

  it("keeps the reader's own reply after the paged ones until a page carries it", async () => {
    const embedded = [reply(1), reply(2), reply(3)];
    const listingWithTotal = (replyTotal: number) => ({
      state: "success",
      page: {
        hot: [],
        items: [root(1, embedded, replyTotal)],
        total: 1,
        page: 1,
        pageSize: 10,
        totalPages: 1,
      },
    });
    const readListing = vi
      .fn()
      .mockResolvedValueOnce(listingWithTotal(11))
      .mockResolvedValue(listingWithTotal(12));
    const submitReply = vi.fn().mockResolvedValue({
      state: "success",
      item: reply(12),
      awaitingApproval: false,
    });
    const readReplies = vi
      .fn()
      .mockResolvedValueOnce({
        state: "success",
        page: {
          items: Array.from({ length: 10 }, (_, i) => reply(i + 1)),
          total: 12,
          page: 1,
          pageSize: 10,
          totalPages: 2,
        },
      })
      .mockResolvedValueOnce({
        state: "success",
        page: {
          items: [reply(11), reply(12)],
          total: 12,
          page: 2,
          pageSize: 10,
          totalPages: 2,
        },
      });
    const container = await render(
      fakeSource({ readListing, readReplies, submitReply }),
    );
    await click(
      container.querySelector("[data-comment-id] [data-comment-reply-action]"),
    );
    fill(container.querySelector("textarea"), "第十二条");
    await click(
      container.querySelector("[data-comment-composer] button[type=submit]"),
    );
    expect(replyIds(container).at(-1)).toBe(commentId(112));

    // Page one lands before the reader's reply, not after it.
    await click(container.querySelector("[data-comment-load-more-replies]"));
    expect(replyIds(container)).toEqual([
      ...Array.from({ length: 10 }, (_, i) => commentId(101 + i)),
      commentId(112),
    ]);
    expect(
      container.querySelector("[data-comment-load-more-replies]")?.textContent,
    ).toContain("还有 1 条");

    // The last page carries the reply itself, in its real position.
    await click(container.querySelector("[data-comment-load-more-replies]"));
    expect(replyIds(container)).toEqual(
      Array.from({ length: 12 }, (_, i) => commentId(101 + i)),
    );
    expect(
      container.querySelector("[data-comment-load-more-replies]"),
    ).toBeNull();
  });

  it("hides the reply load-more once the last reply page was read", async () => {
    // A reply hidden between two loads leaves the total above what can be
    // shown; the exhausted page, not the stale total, ends the affordance.
    const readReplies = vi.fn().mockResolvedValue({
      state: "success",
      page: {
        items: [reply(1), reply(2), reply(3)],
        total: 4,
        page: 1,
        pageSize: 10,
        totalPages: 1,
      },
    });
    const container = await render(
      fakeSource({
        readListing: vi.fn().mockResolvedValue({
          state: "success",
          page: {
            hot: [],
            items: [root(1, [reply(1), reply(2), reply(3)], 5)],
            total: 1,
            page: 1,
            pageSize: 10,
            totalPages: 1,
          },
        }),
        readReplies,
      }),
    );
    await click(container.querySelector("[data-comment-load-more-replies]"));
    expect(container.querySelectorAll("[data-comment-reply]")).toHaveLength(3);
    expect(
      container.querySelector("[data-comment-load-more-replies]"),
    ).toBeNull();
  });

  it("never presents an unanswered session check as signed out", async () => {
    const container = await render(
      fakeSource({
        readViewer: vi.fn().mockResolvedValue({ state: "unavailable" }),
      }),
    );
    expect(container.querySelector("[data-comment-composer]")).toBeNull();
    expect(container.querySelector("[data-comment-signed-out]")).toBeNull();
    expect(
      container.querySelector("[data-comment-viewer-unavailable]")?.textContent,
    ).toContain("无法确认登录状态");
  });
});

it("preserves newly typed text when an earlier send succeeds", async () => {
  type Result = Awaited<ReturnType<LiveCommentSource["submitComment"]>>;
  let resolve!: (result: Result) => void;
  const pending = new Promise<Result>((done) => {
    resolve = done;
  });
  const container = await render(
    fakeSource({ submitComment: vi.fn().mockReturnValue(pending) }),
  );
  fill(container.querySelector("textarea"), "已经发送的版本");
  await click(
    container.querySelector("[data-comment-composer] button[type=submit]"),
  );
  fill(container.querySelector("textarea"), "仍在编辑的新版本");
  await act(async () => {
    resolve({ state: "success", item: root(1, []), awaitingApproval: false });
  });
  await flush();
  expect(container.querySelector("textarea")?.value).toBe("仍在编辑的新版本");
});

it("preserves a sibling reply target selected while an earlier reply is sending", async () => {
  type Result = Awaited<ReturnType<LiveCommentSource["submitReply"]>>;
  let resolve!: (result: Result) => void;
  const pending = new Promise<Result>((done) => {
    resolve = done;
  });
  const submitReply = vi
    .fn()
    .mockReturnValueOnce(pending)
    .mockResolvedValueOnce({ state: "unavailable" });
  const container = await render(
    fakeSource({
      submitReply,
      readListing: vi.fn().mockResolvedValue({
        state: "success",
        page: {
          hot: [],
          items: [root(1, [reply(1), reply(2)])],
          total: 1,
          page: 1,
          pageSize: 10,
          totalPages: 1,
        },
      }),
    }),
  );
  const action = (n: number) =>
    container.querySelector(
      `[data-comment-reply="${commentId(100 + n)}"] [data-comment-reply-action]`,
    );
  const send = () =>
    container.querySelector("[data-comment-composer] button[type=submit]");
  await click(action(1));
  fill(container.querySelector("textarea"), "给这条回复");
  await click(send());
  await click(action(2));
  fill(container.querySelector("textarea"), "给这条回复");
  await act(async () => {
    resolve({ state: "success", item: reply(9), awaitingApproval: false });
  });
  await flush();
  expect(container.querySelector("textarea")?.value).toBe("给这条回复");
  expect(container.querySelector("[data-comment-reply-mode]")).not.toBeNull();
  await click(send());
  expect(submitReply).toHaveBeenNthCalledWith(
    2,
    catalogId,
    commentId(1),
    "给这条回复",
    commentId(102),
  );
});
