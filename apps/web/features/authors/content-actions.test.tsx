// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Root } from "react-dom/client";
import type { ContentIdentity, ContentState } from "@moya/contracts";

const { author, state } = vi.hoisted(() => ({
  author: {
    viewer: { id: "viewer" } as { id: string } | null,
    checking: false,
    revision: 0,
    guestFavorites: [] as ContentIdentity[],
    notify: vi.fn(),
    favorite: vi.fn(),
    like: vi.fn(),
    signInHref: "/sign-in",
  },
  state: vi.fn(),
}));
vi.mock("./author-context", () => ({
  useAuthors: () => author,
  contentKey: (target: ContentIdentity) => `${target.type}:${target.id}`,
  shareContent: vi.fn(async () => "shared"),
}));
vi.mock("./author-data", () => ({ authorClient: { state } }));
import { ContentActions, useContentActions } from "./content-actions";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const target = { type: "catalog", id: "catalog-test" } as const;
const snapshot = (change: Partial<ContentState> = {}): ContentState => ({
  favorite: false,
  liked: false,
  favoriteCount: 0,
  likeCount: 0,
  commentCount: 0,
  ...change,
});
const mount = async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(<ContentActions target={target} title="测试" />),
  );
};
const button = (label: string) =>
  container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
const count = (action: string) =>
  container.querySelector(`[data-detail-reaction-count="${action}"]`)
    ?.textContent;
beforeEach(() => {
  vi.clearAllMocks();
  author.viewer = { id: "viewer" };
  author.guestFavorites = [];
  state.mockResolvedValue(snapshot());
  author.favorite.mockResolvedValue(true);
  author.like.mockResolvedValue(true);
});
afterEach(() => {
  act(() => root?.unmount());
  document.body.replaceChildren();
});

describe("Detail reaction totals", () => {
  it("hides zero totals and renders exact server totals beside the symbols", async () => {
    state.mockResolvedValue(snapshot({ favoriteCount: 12, likeCount: 1234 }));
    await mount();
    expect(count("favorite")).toBe("12");
    expect(count("like")).toBe("1234");
    expect(button("分享").querySelector("svg")).not.toBeNull();
  });
  it("updates a successful toggle then confirms the actual aggregate, and hides zero again", async () => {
    await mount();
    expect(count("favorite")).toBeUndefined();
    state.mockResolvedValue(snapshot({ favorite: true, favoriteCount: 2 }));
    await act(async () => button("收藏").click());
    expect(count("favorite")).toBe("2");
    expect(button("收藏").getAttribute("aria-pressed")).toBe("true");
    state.mockResolvedValue(snapshot());
    await act(async () => button("收藏").click());
    expect(count("favorite")).toBeUndefined();
  });
  it("never invents a total for a failed toggle or an unavailable read-back", async () => {
    await mount();
    author.like.mockResolvedValueOnce(false);
    await act(async () => button("喜欢").click());
    expect(count("like")).toBeUndefined();
    state.mockRejectedValue(new Error("offline"));
    await act(async () => button("喜欢").click());
    expect(count("like")).toBeUndefined();
    expect(button("喜欢").getAttribute("aria-pressed")).toBe("true");
  });
  it("loads aggregate counts for guests while local favorites do not inflate server totals", async () => {
    author.viewer = null;
    state.mockResolvedValue(snapshot({ favoriteCount: 4, likeCount: 6 }));
    await mount();
    expect(count("favorite")).toBe("4");
    expect(count("like")).toBe("6");
    await act(async () => button("收藏").click());
    expect(count("favorite")).toBe("4");
    expect(button("收藏").getAttribute("aria-pressed")).toBe("true");
  });
});

describe("useContentActions like helpers", () => {
  type Actions = ReturnType<typeof useContentActions>;
  let hook: Actions;
  // A distinct target keeps the module-level comment-count bus apart from the view tests.
  const hookTarget = { type: "catalog", id: "catalog-hook" } as const;
  const Probe = () => {
    hook = useContentActions(hookTarget, "测试");
    return null;
  };
  const mountHook = async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<Probe />));
  };
  const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  };
  beforeEach(() => {
    author.checking = false;
  });
  afterEach(() => {
    author.checking = false;
  });

  it("ensureLiked likes an unliked item once with an explicit true", async () => {
    await mountHook();
    expect(hook.state.liked).toBe(false);
    state.mockResolvedValue(snapshot({ liked: true, likeCount: 1 }));
    let result: boolean | undefined;
    await act(async () => {
      result = await hook.ensureLiked();
    });
    expect(result).toBe(true);
    expect(author.like).toHaveBeenCalledTimes(1);
    expect(author.like).toHaveBeenCalledWith(hookTarget, true);
    expect(author.favorite).not.toHaveBeenCalled();
    expect(hook.state.liked).toBe(true);
    expect(hook.environment.likeCount).toBe(1);

    // A second double tap on the now-liked item sends nothing.
    await act(async () => {
      result = await hook.ensureLiked();
    });
    expect(result).toBe(true);
    expect(author.like).toHaveBeenCalledTimes(1);
  });

  it("ensureLiked never un-likes a liked item and sends nothing", async () => {
    state.mockResolvedValue(snapshot({ liked: true, likeCount: 5 }));
    await mountHook();
    expect(hook.state.liked).toBe(true);
    const reads = state.mock.calls.length;
    let result: boolean | undefined;
    await act(async () => {
      result = await hook.ensureLiked();
    });
    expect(result).toBe(true);
    expect(author.like).not.toHaveBeenCalled();
    expect(state.mock.calls.length).toBe(reads);
    expect(hook.state.liked).toBe(true);
    expect(hook.busy).toBe(false);
  });

  it("ensureLiked for a guest ends at the sign-in notice without a read-back", async () => {
    author.viewer = null;
    // Mirrors the author context's guest guard in `like` (author-context.tsx).
    author.like.mockImplementation(async () => {
      author.notify("登录后可以喜欢内容");
      return false;
    });
    await mountHook();
    expect(hook.canLike).toBe(false);
    let result: boolean | undefined;
    await act(async () => {
      result = await hook.ensureLiked();
    });
    expect(result).toBe(false);
    expect(author.like).toHaveBeenCalledTimes(1);
    expect(author.like).toHaveBeenCalledWith(hookTarget, true);
    expect(author.notify).toHaveBeenCalledWith("登录后可以喜欢内容");
    // A guest without guest counts reads no state, before or after the attempt.
    expect(state).not.toHaveBeenCalled();
    expect(hook.state.liked).toBe(false);
  });

  it("canLike is false for a guest even with a known state", async () => {
    author.viewer = null;
    await mountHook();
    expect(hook.state.known).toBe(true);
    expect(hook.canLike).toBe(false);
  });

  it("canLike waits for the signed-in state to be known", async () => {
    const pending = deferred<ContentState>();
    state.mockReturnValueOnce(pending.promise);
    await mountHook();
    expect(hook.state.known).toBe(false);
    expect(hook.canLike).toBe(false);
    expect(hook.environment.ready).toBe(false);
    await act(async () => pending.resolve(snapshot()));
    expect(hook.state.known).toBe(true);
    expect(hook.canLike).toBe(true);
    expect(hook.environment.ready).toBe(true);
  });

  it("canLike is false while the session is still being checked", async () => {
    author.checking = true;
    await mountHook();
    expect(hook.canLike).toBe(false);
    expect(state).not.toHaveBeenCalled();
  });

  it("canLike is false while a like is in flight", async () => {
    await mountHook();
    expect(hook.canLike).toBe(true);
    const saving = deferred<boolean>();
    author.like.mockReturnValueOnce(saving.promise);
    let done: Promise<boolean> | undefined;
    await act(async () => {
      done = hook.ensureLiked();
    });
    expect(hook.busy).toBe(true);
    expect(hook.canLike).toBe(false);
    expect(hook.environment.ready).toBe(false);
    await act(async () => {
      saving.resolve(true);
      await done;
    });
    expect(hook.busy).toBe(false);
    expect(hook.canLike).toBe(true);
  });

  it("exposes the state's aggregates, including the comment total, on the environment", async () => {
    state.mockResolvedValue(
      snapshot({ commentCount: 7, likeCount: 3, favoriteCount: 2 }),
    );
    await mountHook();
    expect(hook.state.commentCount).toBe(7);
    expect(hook.environment.commentCount).toBe(7);
    expect(hook.environment.likeCount).toBe(3);
    expect(hook.environment.favoriteCount).toBe(2);
    expect(hook.environment.ready).toBe(true);
  });
});
