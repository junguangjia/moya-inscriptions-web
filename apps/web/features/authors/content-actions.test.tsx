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
import { ContentActions } from "./content-actions";
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
