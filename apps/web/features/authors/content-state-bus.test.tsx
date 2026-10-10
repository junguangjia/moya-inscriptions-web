// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
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

import { useContentActions } from "./content-actions";
import { publishCommentCount } from "./content-state-bus";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const snapshot = (change: Partial<ContentState> = {}): ContentState => ({
  favorite: false,
  liked: false,
  favoriteCount: 0,
  likeCount: 0,
  commentCount: 0,
  ...change,
});

const Probe = ({ target }: { target: ContentIdentity }) => {
  const { state: current } = useContentActions(target, "合成作品");
  return <output>{String(current.commentCount)}</output>;
};

const roots: Root[] = [];
const mount = async (target: ContentIdentity) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<Probe target={target} />));
  return container;
};

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  author.viewer = { id: "viewer" };
  vi.clearAllMocks();
});

describe("comment totals", () => {
  it("shows the state read's total until a discussion read reports a newer one", async () => {
    const target = { type: "work", id: "work-a" } as const;
    state.mockResolvedValue(snapshot({ commentCount: 3 }));
    const first = await mount(target);
    const second = await mount(target);
    expect(first.textContent).toBe("3");
    // Posting a comment re-reads the discussion; every card of the content
    // follows without another state request.
    const reads = state.mock.calls.length;
    await act(async () => publishCommentCount("viewer", target, 4));
    expect(first.textContent).toBe("4");
    expect(second.textContent).toBe("4");
    expect(state.mock.calls.length).toBe(reads);
  });

  it("keeps each reader's total and each content's total apart", async () => {
    const target = { type: "catalog", id: "catalog-b" } as const;
    state.mockResolvedValue(snapshot({ commentCount: 2 }));
    const shown = await mount(target);
    expect(shown.textContent).toBe("2");
    // Another reader's total (blocks change what each sees) and another
    // content's total do not reach this card.
    await act(async () => publishCommentCount("someone-else", target, 9));
    await act(async () =>
      publishCommentCount("viewer", { type: "catalog", id: "catalog-c" }, 7),
    );
    expect(shown.textContent).toBe("2");
    // Articles have no content state.
    await act(async () =>
      publishCommentCount(
        "viewer",
        { type: "article", id: "catalog-b" } as never,
        5,
      ),
    );
    expect(shown.textContent).toBe("2");
  });

  it("knows no total before any read, and a guest without counts stays unknown", async () => {
    author.viewer = null;
    const shown = await mount({ type: "work", id: "work-d" });
    expect(shown.textContent).toBe("null");
    expect(state).not.toHaveBeenCalled();
  });
});
