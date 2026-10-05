// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Owner acceptance (2026-09-26): as in the accepted discussion preview, a post
 * opens inside its Thread as a 帖子 page with the Work's comments; header Back
 * or browser Back (a swipe) returns to the Thread without closing it.
 */
const work = {
  id: `work-${"1".repeat(32)}`,
  authorId: `user-${"3".repeat(32)}`,
  authorName: "书法学徒",
  canEdit: false,
  firstPublishedAt: "2026-09-24T00:00:00.000Z",
  title: "打卡第2天：两张（合成示例）",
  text: "今天临了两张。",
  media: [
    { id: "m1", src: "/api/community/publishing/media/m1/display/base" },
    { id: "m2", src: "/api/community/publishing/media/m2/display/base" },
  ],
};
const populated = {
  state: "populated",
  thread: {
    title: "示例话题：九宫格临帖打卡（示例）",
    description: "每天上传一到三张临帖照片。",
    tags: ["临帖"],
    heat: 14,
    postCount: 1,
    status: "open",
    latestActivityAt: null,
  },
};
const fixture: { thread: object; items: object[] } = {
  thread: populated,
  items: [work],
};
vi.mock("./use-threads", () => ({
  useThread: () => ({ state: fixture.thread, retry: vi.fn() }),
  useThreadPosts: () => ({
    state: { state: "populated", items: fixture.items, hasMore: false },
    busy: false,
    loadMore: vi.fn(),
  }),
}));
vi.mock("./thread-data", () => ({
  authorClient: { threads: { markRead: vi.fn(async () => undefined) } },
}));
vi.mock("../authors/author-context", () => ({
  useAuthors: () => ({ viewer: null }),
}));
vi.mock("../publishing/publishing-entry", () => ({
  usePublishingEntry: () => ({ openEditor: vi.fn(), checking: false }),
}));
vi.mock("../publishing/publishing-provider", () => ({
  useSubmission: () => ({ state: { status: "idle" } }),
}));
import { ThreadDetail } from "./thread-detail";
import { readOwnWorkAudience } from "../authors/own-work-audience";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let node: HTMLDivElement;
const onClose = vi.fn();
const renderComments = vi.fn((workId: string) => (
  <p data-live-discussion={workId}>评论区</p>
));
const heading = () => node.querySelector("h1")?.textContent;
const back = () => node.querySelector<HTMLButtonElement>("header button")!;
const openPost = async (id = work.id) =>
  act(async () =>
    node
      .querySelector<HTMLButtonElement>(`[data-thread-post="${id}"] button`)!
      .click(),
  );
const element = () => (
  <ThreadDetail
    id={`thread-${"2".repeat(32)}`}
    backButtonRef={createRef<HTMLButtonElement>()}
    onClose={onClose}
    renderComments={renderComments}
  />
);
beforeEach(async () => {
  window.history.replaceState(null, "", "/");
  fixture.thread = populated;
  fixture.items = [work];
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  onClose.mockReset();
  renderComments.mockClear();
  await act(async () => root!.render(element()));
});
afterEach(async () => {
  await act(async () => root?.unmount());
  // Let the unmounted post page consume its own history entry first.
  await new Promise((resolve) => setTimeout(resolve, 30));
  root = null;
  document.body.replaceChildren();
});

describe("ThreadDetail posts", () => {
  it("opens a post inside the Thread with its images and the Work's comments", async () => {
    expect(heading()).toBe("话题");
    await openPost();
    expect(heading()).toBe("帖子");
    expect(back().getAttribute("aria-label")).toBe("返回话题");
    const detail = node.querySelector(`[data-thread-post-detail="${work.id}"]`);
    expect(detail?.textContent).toContain("示例话题：九宫格临帖打卡（示例）");
    expect(detail?.textContent).toContain("今天临了两张。");
    expect(detail?.querySelectorAll("img")).toHaveLength(2);
    expect(renderComments).toHaveBeenCalledWith(work.id);
    expect(
      node.querySelector(`[data-live-discussion="${work.id}"]`),
    ).not.toBeNull();
  });

  it("returns to the Thread on header Back without closing it", async () => {
    await openPost();
    await act(async () => {
      back().click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(heading()).toBe("话题");
    expect(
      node.querySelector(`[data-thread-post="${work.id}"]`),
    ).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("returns to the Thread on browser Back (a swipe) without closing it", async () => {
    await openPost();
    expect(heading()).toBe("帖子");
    await act(async () => {
      window.history.back();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(heading()).toBe("话题");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("records the author's own audience, so a self-only post shows its closed note", async () => {
    // DiscussionSection reads this record to replace the composer with
    // 此作品当前仅你可见 for a Work nobody else can see, as Work Detail does.
    const own = {
      ...work,
      id: `work-${"4".repeat(32)}`,
      canEdit: true,
      visibility: "self",
      publiclyVisible: false,
    };
    fixture.items = [own];
    await act(async () => root!.render(element()));
    expect(readOwnWorkAudience(own.authorId, own.id)).toBeNull();
    await openPost(own.id);
    expect(readOwnWorkAudience(own.authorId, own.id)).toEqual({
      publiclyVisible: false,
      visibility: "self",
    });
  });

  it("keeps the open post page when its Thread reloads", async () => {
    await openPost();
    fixture.thread = { state: "loading" };
    await act(async () => root!.render(element()));
    expect(heading()).toBe("帖子");
    expect(
      node.querySelector(`[data-thread-post-detail="${work.id}"]`),
    ).not.toBeNull();
  });

  it("closes from the Thread itself through header Back", async () => {
    await act(async () => back().click());
    expect(onClose).toHaveBeenCalledOnce();
  });
});

/*
 * unified-media-pipeline-v1 (CW13): post images pick small inline candidates
 * and reserve their size; both layouts letterbox, so no placeholder colour.
 */
describe("ThreadDetail post images", () => {
  const item = `media-item-${"5".repeat(32)}`;
  const path = (variant: string) =>
    `/api/community/publishing/media/${item}/${variant}/base`;
  const candidate = (variant: string, width: number, height: number) => ({
    src: path(variant),
    width,
    height,
    contentType: "image/webp",
  });
  const responsive = {
    ...work,
    id: `work-${"8".repeat(32)}`,
    media: [
      {
        id: item,
        src: path("display"),
        width: 2048,
        height: 1536,
        placeholderColor: "#575049",
        renditions: [
          candidate("thumb", 480, 360),
          candidate("display", 2048, 1536),
          candidate("full", 4032, 3024),
        ],
      },
    ],
  };

  it("offers inline candidates up to the anchor in thumbnails and the gallery", async () => {
    fixture.items = [responsive];
    await act(async () => root!.render(element()));
    const thumbnail = node.querySelector<HTMLImageElement>(
      `[data-thread-post="${responsive.id}"] img`,
    )!;
    expect(thumbnail.getAttribute("src")).toBe(path("display"));
    expect(thumbnail.getAttribute("srcset")).toBe(
      `${path("thumb")} 480w, ${path("display")} 2048w`,
    );
    expect(thumbnail.getAttribute("sizes")).toBe(
      "(min-width: 760px) 238px, calc(33.34vw - 16px)",
    );
    expect(thumbnail.getAttribute("width")).toBe("2048");
    expect(thumbnail.getAttribute("height")).toBe("1536");
    expect(thumbnail.style.backgroundColor).toBe("");
    await openPost(responsive.id);
    const gallery = node.querySelector<HTMLImageElement>(
      `[data-thread-post-detail="${responsive.id}"] img`,
    )!;
    expect(gallery.getAttribute("srcset")).toBe(
      `${path("thumb")} 480w, ${path("display")} 2048w`,
    );
    expect(gallery.getAttribute("sizes")).toBe(
      "(min-width: 768px) 656px, calc(100vw - 40px)",
    );
    expect(gallery.getAttribute("width")).toBe("2048");
    expect(gallery.getAttribute("height")).toBe("1536");
    expect(gallery.style.backgroundColor).toBe("");
  });
});
