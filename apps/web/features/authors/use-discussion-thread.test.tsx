// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type { DiscussionComment, DiscussionReply } from "@moya/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  profile,
  discussion,
  replies,
  send,
  command,
  locate,
  publish,
  enterAuth,
  returnView,
  context,
} = vi.hoisted(() => ({
  profile: vi.fn(),
  discussion: vi.fn(),
  replies: vi.fn(),
  send: vi.fn(),
  command: vi.fn(),
  locate: vi.fn(),
  publish: vi.fn(),
  enterAuth: vi.fn(),
  returnView: vi.fn(),
  context: {
    viewer: { id: "owner", displayName: "自己" } as {
      id: string;
      displayName: string;
    } | null,
    avatarSrc: null as string | null,
    checking: false,
    sessionError: false,
    revision: 0,
    cache: new Map<string, unknown>(),
    signInHref: "/login",
  },
}));
vi.mock("./author-data", () => ({
  authorClient: { profile, discussion, replies, send, command, locate },
  AuthorRequestError: class extends Error {},
}));
vi.mock("./author-context", () => ({
  useAuthors: () => context,
  contentKey: (target: { type: string; id: string }) =>
    `${target.type}:${target.id}`,
}));
vi.mock("./content-state-bus", () => ({ publishCommentCount: publish }));
vi.mock("../auth/auth-return", () => ({
  useAuthEntry: () => enterAuth,
  useAuthReturnView: returnView,
}));
import {
  useDiscussionThread,
  type DiscussionThread,
  type DiscussionThreadOptions,
} from "./use-discussion-thread";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const target = { type: "catalog", id: "synthetic-catalog" } as const;
const reply = (id: string, likeCount = 0): DiscussionReply => ({
  id: id as DiscussionReply["id"],
  author: { id: "other" as DiscussionReply["author"]["id"], displayName: "他" },
  text: id,
  createdAt: "2026-09-13T12:00:00.000Z",
  likeCount,
  liked: false,
  deleted: false,
});
const comment = (
  id: string,
  children: DiscussionReply[] = [],
  replyTotal = children.length,
): DiscussionComment => ({
  ...reply(id, 2),
  target,
  replies: children,
  replyTotal,
  replyPageTotal: replyTotal,
});
const listing = (
  items: DiscussionComment[],
  {
    hot = [],
    page = 1,
    totalPages = 1,
    visibleTotal,
  }: {
    hot?: DiscussionComment[];
    page?: number;
    totalPages?: number;
    visibleTotal?: number;
  } = {},
) => ({
  items,
  hot,
  visibleTotal: visibleTotal ?? items.length + hot.length,
  total: items.length,
  page,
  pageSize: 10,
  totalPages,
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

let root: Root;
let thread: DiscussionThread;
let renders: DiscussionThread[];
const Probe = (options: DiscussionThreadOptions) => {
  thread = useDiscussionThread(options);
  renders.push(thread);
  return null;
};
const render = (options: Partial<DiscussionThreadOptions> = {}) =>
  act(async () => root.render(<Probe target={target} {...options} />));
const colophon = (options: Partial<DiscussionThreadOptions> = {}) =>
  render({
    mode: "colophon",
    authReturnSlot: `feed-colophon:catalog:${target.id}`,
    consumeLocation: false,
    ...options,
  });
const ids = (rows: readonly { id: string }[]) => rows.map((r) => r.id);

beforeEach(() => {
  vi.resetAllMocks();
  Object.assign(context, {
    viewer: { id: "owner", displayName: "自己" },
    checking: false,
    sessionError: false,
    cache: new Map(),
  });
  renders = [];
  profile.mockResolvedValue({ avatar: null });
  discussion.mockResolvedValue(
    listing([comment("latest")], { hot: [comment("hot")] }),
  );
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(async () => root.unmount());
});

describe("useDiscussionThread gating", () => {
  it("reads nothing while disabled, once when enabled, and keeps the rows when disabled again", async () => {
    await colophon({ enabled: false });
    expect(discussion).not.toHaveBeenCalled();
    expect(thread.loading).toBe(true);
    await colophon({ enabled: true });
    expect(discussion).toHaveBeenCalledOnce();
    expect(discussion).toHaveBeenCalledWith(target, 1, undefined);
    expect(ids(thread.items)).toEqual(["latest"]);
    await colophon({ enabled: false });
    await colophon({ enabled: true });
    expect(discussion).toHaveBeenCalledOnce();
    expect(ids(thread.hot)).toEqual(["hot"]);
    expect(thread.page).toBe(1);
  });

  it("leaves a notification location for Detail when consumeLocation is false", async () => {
    const location = { target, id: "latest" };
    context.cache.set("discussion-location", location);
    await colophon();
    expect(thread.page).toBe(1);
    expect(context.cache.get("discussion-location")).toBe(location);
    expect(locate).not.toHaveBeenCalled();
  });

  it("registers the given auth-return slot, and the Detail slot by default", async () => {
    await colophon();
    expect(returnView).toHaveBeenCalledWith(
      "feed-colophon:catalog:synthetic-catalog",
      expect.any(Function),
    );
    expect(returnView.mock.calls.map(([slot]) => slot)).not.toContain(
      "comments-window:catalog:synthetic-catalog",
    );
    await act(async () => root.unmount());
    root = createRoot(document.createElement("div"));
    await render();
    expect(returnView).toHaveBeenLastCalledWith(
      "comments-window:catalog:synthetic-catalog",
      expect.any(Function),
    );
  });

  it("keeps the raw time next to the label and stable operations across renders", async () => {
    await colophon();
    expect(thread.items[0]!.createdAt).toBe("2026-09-13T12:00:00.000Z");
    const { loadMore, toggleLike } = thread;
    await colophon();
    expect(thread.loadMore).toBe(loadMore);
    expect(thread.toggleLike).toBe(toggleLike);
  });
});

describe("useDiscussionThread colophon mode", () => {
  it("likes optimistically without a re-read and reverts on failure", async () => {
    await colophon();
    const pending = deferred<unknown>();
    command.mockReturnValueOnce(pending.promise);
    await act(async () => thread.toggleLike("latest"));
    expect(thread.items[0]).toMatchObject({ liked: true, likeCount: 3 });
    expect(command).toHaveBeenCalledWith("discussion/items/latest/like", {
      requestId: expect.any(String),
      enabled: true,
    });
    await act(async () => pending.resolve({ saved: true }));
    expect(thread.items[0]).toMatchObject({ liked: true, likeCount: 3 });
    expect(discussion).toHaveBeenCalledOnce();

    command.mockRejectedValueOnce(new Error("点赞未完成"));
    await act(async () => thread.toggleLike("latest"));
    expect(thread.items[0]).toMatchObject({ liked: true, likeCount: 3 });
    expect(thread.actionError).toEqual({ id: "latest", message: "点赞未完成" });
    expect(thread.error).toBeNull();
    expect(thread.readError).toBeNull();
    expect(discussion).toHaveBeenCalledOnce();
  });

  it("patches a reply like in both hot and latest rows", async () => {
    discussion.mockResolvedValue(
      listing([comment("latest", [reply("r1", 4)])], { hot: [comment("hot")] }),
    );
    await colophon();
    command.mockResolvedValueOnce({ saved: true });
    await act(async () => thread.toggleLike("latest", "r1"));
    expect(thread.items[0]!.replies[0]).toMatchObject({
      liked: true,
      likeCount: 5,
    });
    expect(thread.items[0]).toMatchObject({ liked: false, likeCount: 2 });
  });

  it("sends a guest to sign-in with the opener instead of liking", async () => {
    context.viewer = null;
    await colophon();
    const opener = document.createElement("button");
    await act(async () => thread.toggleLike("latest", undefined, opener));
    expect(enterAuth).toHaveBeenCalledWith("/login", opener);
    expect(command).not.toHaveBeenCalled();
  });

  it("refreshes in place after a delete: re-reads pages 1..N with the new pinned ids and commits once", async () => {
    discussion
      .mockResolvedValueOnce(
        listing([comment("a")], { hot: [comment("hot")], totalPages: 2 }),
      )
      .mockResolvedValueOnce(
        listing([comment("b")], { page: 2, totalPages: 2 }),
      );
    await colophon();
    await act(async () => thread.loadMore());
    expect(ids(thread.items)).toEqual(["a", "b"]);
    expect(thread.page).toBe(2);

    command.mockResolvedValueOnce({ deleted: true });
    discussion
      .mockResolvedValueOnce(
        listing([comment("hot")], {
          hot: [comment("new-hot")],
          totalPages: 2,
          visibleTotal: 7,
        }),
      )
      .mockResolvedValueOnce(
        listing([comment("a"), comment("b")], {
          page: 2,
          totalPages: 2,
          visibleTotal: 7,
        }),
      );
    const before = renders.length;
    await act(async () => thread.deleteBody("a"));
    expect(command).toHaveBeenCalledWith(
      "discussion/items/a/body",
      { requestId: expect.any(String) },
      "DELETE",
    );
    expect(discussion.mock.calls.slice(2)).toEqual([
      [target, 1, undefined],
      [target, 2, ["new-hot"]],
    ]);
    expect(ids(thread.hot)).toEqual(["new-hot"]);
    expect(ids(thread.items)).toEqual(["hot", "a", "b"]);
    expect(thread.page).toBe(2);
    expect(thread.visibleTotal).toBe(7);
    // The strip never shrinks to page 1 on the way.
    for (const seen of renders.slice(before))
      expect(seen.page === 2 && seen.items.length >= 2).toBe(true);
    expect(publish).toHaveBeenLastCalledWith("owner", target, 7);
  });

  it("re-reads reply pages the reader had opened when it refreshes", async () => {
    discussion.mockResolvedValue(
      listing([comment("latest", [reply("r1")], 12)]),
    );
    replies.mockResolvedValue({
      items: [reply("r1"), reply("r2")],
      page: 1,
      pageSize: 10,
      total: 12,
      totalPages: 2,
      visibleTotal: 12,
    });
    await colophon();
    await act(async () => thread.loadReplies("latest"));
    expect(ids(thread.items[0]!.replies)).toEqual(["r1", "r2"]);
    command.mockResolvedValueOnce({ deleted: true });
    await act(async () => thread.deleteBody("latest"));
    expect(replies).toHaveBeenLastCalledWith(target, "latest", 1);
    expect(ids(thread.items[0]!.replies)).toEqual(["r1", "r2"]);
  });

  it("says 已发送 for a comment awaiting approval without inserting or reading", async () => {
    await colophon();
    send.mockResolvedValueOnce({
      id: "pending",
      rootId: "pending",
      item: reply("pending"),
      awaitingApproval: true,
    });
    let sent: boolean | undefined;
    await act(async () => {
      sent = await thread.sendComment("一条题跋");
    });
    expect(sent).toBe(true);
    expect(send).toHaveBeenCalledWith(target, "一条题跋", undefined, undefined);
    expect(thread.notice).toBe("已发送");
    expect(thread.lastSubmit).toEqual({
      id: "pending",
      rootId: "pending",
      awaitingApproval: true,
    });
    expect(thread.highlightId).toBeUndefined();
    expect(discussion).toHaveBeenCalledOnce();
  });

  it("refreshes in place and highlights a published reply", async () => {
    await colophon();
    send.mockResolvedValueOnce({
      id: "new-reply",
      rootId: "latest",
      item: reply("new-reply"),
      awaitingApproval: false,
    });
    discussion.mockResolvedValueOnce(
      listing([comment("latest", [reply("new-reply")])], {
        hot: [comment("hot")],
        visibleTotal: 3,
      }),
    );
    await act(async () => {
      await thread.sendReply(
        { rootCommentId: "latest", user: { id: "other", name: "他" } },
        "回一句",
      );
    });
    expect(send).toHaveBeenCalledWith(target, "回一句", "latest", undefined);
    expect(discussion).toHaveBeenLastCalledWith(target, 1, undefined);
    expect(thread.highlightId).toBe("new-reply");
    expect(thread.notice).toBe("已发送");
    expect(thread.lastSubmit).toMatchObject({ awaitingApproval: false });
    expect(ids(thread.items[0]!.replies)).toEqual(["new-reply"]);
    expect(publish).toHaveBeenLastCalledWith("owner", target, 3);
  });

  it("keeps a failed send in actionError and returns false", async () => {
    await colophon();
    send.mockRejectedValueOnce(new Error("发送失败"));
    let sent: boolean | undefined;
    await act(async () => {
      sent = await thread.sendComment("留着");
    });
    expect(sent).toBe(false);
    expect(thread.actionError).toEqual({ id: null, message: "发送失败" });
    expect(thread.error).toBeNull();
  });

  it("reports a list-read failure as readError only, and retry replays it", async () => {
    discussion.mockRejectedValueOnce(new Error("评论加载失败"));
    await colophon();
    expect(thread.readError).toBe("评论加载失败");
    expect(thread.actionError).toBeNull();
    expect(thread.loading).toBe(false);
    expect(discussion).toHaveBeenCalledOnce();
    await act(async () => thread.retry());
    expect(discussion).toHaveBeenCalledTimes(2);
    expect(thread.readError).toBeNull();
    expect(ids(thread.items)).toEqual(["latest"]);
  });

  it("mirrors a reply read in repliesLoading", async () => {
    discussion.mockResolvedValue(listing([comment("latest", [], 4)]));
    await colophon();
    const pending = deferred<unknown>();
    replies.mockReturnValueOnce(pending.promise);
    await act(async () => thread.loadReplies("latest"));
    expect([...thread.repliesLoading]).toEqual(["latest"]);
    await act(async () =>
      pending.resolve({
        items: [reply("r1")],
        page: 1,
        pageSize: 10,
        total: 1,
        totalPages: 1,
        visibleTotal: 1,
      }),
    );
    expect(thread.repliesLoading.size).toBe(0);
    expect(ids(thread.items[0]!.replies)).toEqual(["r1"]);
  });

  it("retries a failed in-place refresh in place, keeping the depth", async () => {
    discussion
      .mockResolvedValueOnce(listing([comment("a")], { totalPages: 2 }))
      .mockResolvedValueOnce(
        listing([comment("b")], { page: 2, totalPages: 2 }),
      );
    await colophon();
    await act(async () => thread.loadMore());
    command.mockResolvedValueOnce({ deleted: true });
    discussion.mockRejectedValueOnce(new Error("评论加载失败"));
    await act(async () => thread.deleteBody("a"));
    expect(thread.readError).toBe("评论加载失败");
    expect(ids(thread.items)).toEqual(["a", "b"]);

    discussion
      .mockResolvedValueOnce(listing([comment("a")], { totalPages: 2 }))
      .mockResolvedValueOnce(
        listing([comment("b")], { page: 2, totalPages: 2 }),
      );
    await act(async () => thread.retry());
    expect(discussion.mock.calls.slice(-2)).toEqual([
      [target, 1, undefined],
      [target, 2, []],
    ]);
    expect(thread.readError).toBeNull();
    expect(thread.page).toBe(2);
    expect(ids(thread.items)).toEqual(["a", "b"]);
  });

  it("marks no comment when the refresh after a send fails", async () => {
    await colophon();
    send.mockResolvedValueOnce({
      id: "new",
      rootId: "new",
      item: reply("new"),
      awaitingApproval: false,
    });
    discussion.mockRejectedValueOnce(new Error("评论加载失败"));
    await act(async () => {
      await thread.sendComment("一条题跋");
    });
    expect(thread.notice).toBe("已发送");
    expect(thread.highlightId).toBeUndefined();
    expect(thread.readError).toBe("评论加载失败");
  });

  it("refreshes without a mark when a published send names no id", async () => {
    await colophon();
    send.mockResolvedValueOnce({ awaitingApproval: false });
    await act(async () => {
      await thread.sendComment("一条题跋");
    });
    expect(discussion).toHaveBeenCalledTimes(2);
    expect(thread.notice).toBe("已发送");
    expect(thread.highlightId).toBeUndefined();
  });

  it("keeps opened replies through a refresh until their re-read replaces them", async () => {
    discussion.mockResolvedValue(
      listing([comment("latest", [reply("r1")], 12)]),
    );
    replies.mockResolvedValueOnce({
      items: [reply("r1"), reply("r2")],
      page: 1,
      pageSize: 10,
      total: 12,
      totalPages: 2,
      visibleTotal: 12,
    });
    await colophon();
    await act(async () => thread.loadReplies("latest"));
    const pending = deferred<unknown>();
    replies.mockReturnValueOnce(pending.promise);
    command.mockResolvedValueOnce({ deleted: true });
    const before = renders.length;
    await act(async () => thread.deleteBody("r2"));
    expect(ids(thread.items[0]!.replies)).toEqual(["r1", "r2"]);
    expect(thread.items[0]!.replyRemaining).toBe(2);
    await act(async () =>
      pending.resolve({
        items: [reply("r1"), reply("r3")],
        page: 1,
        pageSize: 10,
        total: 11,
        totalPages: 2,
        visibleTotal: 11,
      }),
    );
    expect(ids(thread.items[0]!.replies)).toEqual(["r1", "r3"]);
    // The opened replies never fall back to the list's preview on the way.
    for (const seen of renders.slice(before))
      expect(seen.items[0]!.replies.length).toBe(2);
  });

  it("keeps a like made while a refresh reads, and drops it once a later read carries it", async () => {
    await colophon();
    const read = deferred<unknown>();
    command.mockResolvedValueOnce({ deleted: true });
    discussion.mockReturnValueOnce(read.promise);
    await act(async () => thread.deleteBody("hot"));
    command.mockResolvedValueOnce({ saved: true });
    await act(async () => thread.toggleLike("latest"));
    expect(thread.items[0]).toMatchObject({ liked: true, likeCount: 3 });
    // The refresh read the rows before the like.
    await act(async () =>
      read.resolve(listing([comment("latest")], { hot: [comment("hot")] })),
    );
    expect(thread.items[0]).toMatchObject({ liked: true, likeCount: 3 });

    command.mockResolvedValueOnce({ deleted: true });
    discussion.mockResolvedValueOnce(
      listing([{ ...comment("latest"), liked: true, likeCount: 3 }]),
    );
    await act(async () => thread.deleteBody("hot"));
    expect(thread.items[0]).toMatchObject({ liked: true, likeCount: 3 });
    command.mockResolvedValueOnce({ deleted: true });
    discussion.mockResolvedValueOnce(listing([comment("latest")]));
    await act(async () => thread.deleteBody("hot"));
    // Another reader's unlike shows; the settled like is not re-applied.
    expect(thread.items[0]).toMatchObject({ liked: false, likeCount: 2 });
  });
});

describe("useDiscussionThread detail mode", () => {
  it("keeps the shared error channel and reloads page 1 after a like", async () => {
    await render();
    command.mockResolvedValueOnce({ saved: true });
    await act(async () => thread.toggleLike("latest"));
    expect(discussion).toHaveBeenCalledTimes(2);
    expect(discussion).toHaveBeenLastCalledWith(target, 1, undefined);
    command.mockRejectedValueOnce(new Error("操作失败"));
    await act(async () => thread.deleteBody("latest"));
    expect(thread.error).toBe("操作失败");
    expect(thread.actionError).toBeNull();
    expect(thread.readError).toBeNull();
  });
});
