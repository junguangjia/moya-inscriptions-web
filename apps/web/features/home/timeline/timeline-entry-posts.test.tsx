// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TimelineEntryPosts } from "./timeline-entry-posts";

import type { UserWork } from "@moya/contracts";
import type { Root } from "react-dom/client";
import type { TimelineEntryPostsActions } from "./timeline-entry-posts";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const data = vi.hoisted(() => ({
  readTimelinePosts: vi.fn(),
  readOwnWorks: vi.fn(),
  readContentTimelineEntry: vi.fn(),
  setWorkTimelineEntry: vi.fn(),
}));
vi.mock("./timeline-posts-data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./timeline-posts-data")>()),
  ...data,
}));
const authors = vi.hoisted(() => ({
  value: null as null | { checking: boolean; viewer: { id: string } | null },
}));
vi.mock("../../authors/author-context", () => ({
  useOptionalAuthors: () => authors.value,
}));

const viewerId = `user-${"a".repeat(32)}`;
const workId = (n: number) => `work-${n.toString(16).padStart(32, "0")}`;
const work = (n: number, overrides: Partial<UserWork> = {}): UserWork =>
  ({
    id: workId(n),
    authorId: viewerId,
    authorName: "虚构作者",
    title: `访碑记${n}`,
    text: "",
    media: [],
    available: true,
    canEdit: true,
    firstPublishedAt: "2026-11-07T00:00:00.000Z",
    ...overrides,
  }) as UserWork;
const page = (items: readonly UserWork[], total: number, at = 1) => ({
  items,
  total,
  page: at,
});

let container: HTMLDivElement;
let root: Root;
let actions: {
  readonly [K in keyof TimelineEntryPostsActions]-?: ReturnType<typeof vi.fn>;
};

const flush = async () => {
  await act(async () => {
    for (let at = 0; at < 6; at += 1) await Promise.resolve();
  });
};
const render = (browseOnly = false) =>
  act(() =>
    root.render(
      <TimelineEntryPosts
        actions={actions as unknown as TimelineEntryPostsActions}
        browseOnly={browseOnly}
        entryId="row-yongping"
        entryTitle="北魏虚构永平碑"
      />,
    ),
  );
const query = (selector: string) => container.querySelector(selector);
const click = (element: Element | null | undefined) => {
  if (!element) throw new Error("Nothing to click");
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};
const button = (text: string) =>
  [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === text,
  );

beforeEach(() => {
  for (const mock of Object.values(data)) mock.mockReset();
  authors.value = { checking: false, viewer: { id: viewerId } };
  actions = {
    upload: vi.fn(),
    openWork: vi.fn(),
    signIn: vi.fn(),
    postsChanged: vi.fn(),
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("an entry's posts", () => {
  it("says only the action and its line when there are none", async () => {
    data.readTimelinePosts.mockResolvedValue(page([], 0));
    render();
    // Loading shows placeholder cells, not words.
    expect(query("[data-timeline-posts]")?.getAttribute("aria-busy")).toBe(
      "true",
    );
    await flush();
    expect(container.textContent).toBe(
      "上传这件碑帖发布后会出现在这个词条下。关联我发过的帖子",
    );
    expect(query("[data-timeline-post-grid]")).toBeNull();
    click(query("[data-timeline-upload]"));
    expect(actions.upload).toHaveBeenCalledWith(
      query("[data-timeline-upload]"),
    );
  });

  it("shows six first, then pages the rest in place after 「全部 N 篇」", async () => {
    data.readTimelinePosts.mockResolvedValueOnce(
      page(
        Array.from({ length: 6 }, (_, at) => work(at + 1)),
        20,
      ),
    );
    render();
    await flush();
    expect(data.readTimelinePosts).toHaveBeenLastCalledWith(
      "row-yongping",
      1,
      6,
      expect.any(AbortSignal),
    );
    expect(container.querySelectorAll("[data-timeline-post]")).toHaveLength(6);
    const all = query("[data-timeline-posts-more]");
    expect(all?.textContent).toBe("全部 20 篇");

    data.readTimelinePosts.mockResolvedValueOnce(
      page(
        Array.from({ length: 18 }, (_, at) => work(at + 1)),
        20,
      ),
    );
    click(all);
    await flush();
    expect(data.readTimelinePosts).toHaveBeenLastCalledWith(
      "row-yongping",
      1,
      18,
    );
    expect(container.querySelectorAll("[data-timeline-post]")).toHaveLength(18);
    expect(query("[data-timeline-posts-more]")?.textContent).toBe("显示更多");

    // A post that moved up a page is listed once.
    data.readTimelinePosts.mockResolvedValueOnce(
      page([work(18), work(19), work(20)], 20, 2),
    );
    click(query("[data-timeline-posts-more]"));
    await flush();
    expect(data.readTimelinePosts).toHaveBeenLastCalledWith(
      "row-yongping",
      2,
      18,
    );
    expect(container.querySelectorAll("[data-timeline-post]")).toHaveLength(20);
    expect(query("[data-timeline-posts-more]")).toBeNull();
  });

  it("opens a post's work and names an untitled one", async () => {
    data.readTimelinePosts.mockResolvedValue(
      page([work(1), work(2, { title: "", text: "碑在山腰" })], 2),
    );
    render();
    await flush();
    const cells = [...container.querySelectorAll("[data-timeline-post]")];
    expect(cells.map((cell) => cell.getAttribute("aria-label"))).toEqual([
      "访碑记1",
      "未命名作品",
    ]);
    expect(cells[1]?.textContent).toBe("碑在山腰");
    click(cells[0]);
    expect(actions.openWork).toHaveBeenCalledWith(workId(1), cells[0]);
  });

  it("marks the author's own posts that others cannot see, with the profile works grid's mark", async () => {
    data.readTimelinePosts.mockResolvedValue(
      page(
        [
          work(1, { visibility: "public", publiclyVisible: true }),
          work(2, { visibility: "self", publiclyVisible: false }),
          // A first public submission still pending, or one taken down.
          work(3, { visibility: "public", publiclyVisible: false }),
          // Another author's post carries no author-only fields.
          work(4, { authorId: `user-${"b".repeat(32)}`, canEdit: false }),
        ],
        4,
      ),
    );
    render();
    await flush();
    const cell = (n: number) =>
      container.querySelector(`[data-timeline-post="${workId(n)}"]`)!;
    expect(
      [1, 2, 3, 4].map(
        (n) =>
          cell(n).querySelector("[data-timeline-post-audience]")?.textContent ??
          null,
      ),
    ).toEqual([null, "仅自己可见", "暂不公开", null]);
    expect(cell(2).getAttribute("aria-label")).toBe("访碑记2，仅自己可见");
    expect(
      cell(2)
        .querySelector("[data-timeline-post-audience]")
        ?.getAttribute("title"),
    ).toBe("此作品当前仅你可见。");
    expect(cell(1).getAttribute("aria-label")).toBe("访碑记1");
  });

  it("says a failed read in its own words and reads again on 重试", async () => {
    data.readTimelinePosts.mockRejectedValueOnce(new Error("offline"));
    render();
    await flush();
    expect(container.textContent).toContain("帖子载入失败");
    data.readTimelinePosts.mockResolvedValueOnce(page([work(1)], 1));
    click(button("重试"));
    await flush();
    expect(container.querySelectorAll("[data-timeline-post]")).toHaveLength(1);
  });

  it("keeps the posts and drops both actions when browse-only", async () => {
    data.readTimelinePosts.mockResolvedValue(page([work(1)], 1));
    render(true);
    await flush();
    expect(query("[data-timeline-upload]")).toBeNull();
    expect(query("[data-timeline-attach]")).toBeNull();
    expect(container.querySelectorAll("[data-timeline-post]")).toHaveLength(1);
  });
});

describe("「关联我发过的帖子」", () => {
  beforeEach(() => {
    data.readTimelinePosts.mockResolvedValue(page([], 0));
    data.readOwnWorks.mockResolvedValue(page([work(1), work(2)], 2));
  });

  const openPicker = async () => {
    render();
    await flush();
    click(query("[data-timeline-attach]"));
    await flush();
  };

  it("sends a guest to sign-in instead of opening the list", async () => {
    authors.value = { checking: false, viewer: null };
    render();
    await flush();
    const attach = query("[data-timeline-attach]");
    click(attach);
    expect(actions.signIn).toHaveBeenCalledWith(attach);
    expect(query("[data-timeline-attach-picker]")).toBeNull();
    expect(data.readOwnWorks).not.toHaveBeenCalled();
  });

  it("keeps the focus in the section: on the list's title when it opens, through the move question, and back on its button when it closes", async () => {
    render();
    await flush();
    const opener = () => query("[data-timeline-attach]") as HTMLButtonElement;
    opener().focus();
    click(opener());
    await flush();
    expect(document.activeElement).toBe(
      query("[data-timeline-attach-picker] h3"),
    );
    // 取消 closes it: the focus is not dropped to the page.
    const cancel = button("取消")!;
    cancel.focus();
    click(cancel);
    expect(query("[data-timeline-attach-picker]")).toBeNull();
    expect(document.activeElement).toBe(opener());

    // The 「已在」 question takes the focus, and its 取消 gives it to 关联.
    click(opener());
    await flush();
    data.readContentTimelineEntry.mockResolvedValueOnce({
      id: "row-other",
      title: "虚构东碑",
      fullTitle: "唐虚构东碑",
    });
    click(query(`[data-timeline-attach-work="${workId(1)}"]`));
    const confirm = () =>
      query("[data-timeline-attach-confirm]") as HTMLButtonElement;
    confirm().focus();
    click(confirm());
    await flush();
    expect(document.activeElement).toBe(
      query("[data-timeline-attach-move] [role='status']"),
    );
    const back = [
      ...query("[data-timeline-attach-move]")!.querySelectorAll("button"),
    ].find((candidate) => candidate.textContent === "取消")!;
    back.focus();
    click(back);
    expect(document.activeElement).toBe(confirm());

    // An attachment closes the list and gives the focus back to its button.
    data.readContentTimelineEntry.mockResolvedValueOnce(null);
    data.setWorkTimelineEntry.mockResolvedValue({
      workId: workId(2),
      entryId: "row-yongping",
      version: 1,
    });
    click(query(`[data-timeline-attach-work="${workId(2)}"]`));
    click(confirm());
    await flush();
    expect(query("[data-timeline-attach-picker]")).toBeNull();
    expect(document.activeElement).toBe(opener());
  });

  it("attaches a chosen work at once and reads the posts again", async () => {
    await openPicker();
    expect(data.readOwnWorks).toHaveBeenCalledWith(viewerId, 1);
    data.readContentTimelineEntry.mockResolvedValue(null);
    data.setWorkTimelineEntry.mockResolvedValue({
      workId: workId(2),
      entryId: "row-yongping",
      version: 1,
    });
    click(query(`[data-timeline-attach-work="${workId(2)}"]`));
    expect(
      query(`[data-timeline-attach-work="${workId(2)}"]`)?.getAttribute(
        "aria-checked",
      ),
    ).toBe("true");
    data.readTimelinePosts.mockResolvedValue(page([work(2)], 1));
    click(query("[data-timeline-attach-confirm]"));
    await flush();
    expect(data.readContentTimelineEntry).toHaveBeenCalledWith({
      type: "work",
      id: workId(2),
    });
    expect(data.setWorkTimelineEntry).toHaveBeenCalledWith(workId(2), {
      requestId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      ),
      entryId: "row-yongping",
    });
    expect(query("[data-timeline-attach-picker]")).toBeNull();
    expect(container.textContent).toContain("已关联到这个词条");
    expect(actions.postsChanged).toHaveBeenCalledOnce();
    expect(container.querySelectorAll("[data-timeline-post]")).toHaveLength(1);
  });

  it("asks before moving a work that is already on another entry", async () => {
    await openPicker();
    data.readContentTimelineEntry.mockResolvedValue({
      id: "row-other",
      title: "虚构东碑",
      fullTitle: "唐虚构东碑",
    });
    click(query(`[data-timeline-attach-work="${workId(1)}"]`));
    click(query("[data-timeline-attach-confirm]"));
    await flush();
    expect(data.setWorkTimelineEntry).not.toHaveBeenCalled();
    expect(query("[data-timeline-attach-move]")?.textContent).toContain(
      "已在：唐虚构东碑。改为关联到「北魏虚构永平碑」？",
    );
    data.setWorkTimelineEntry.mockResolvedValue({
      workId: workId(1),
      entryId: "row-yongping",
      version: 3,
    });
    click(button("改为关联"));
    await flush();
    expect(data.setWorkTimelineEntry).toHaveBeenCalledWith(workId(1), {
      requestId: expect.any(String),
      entryId: "row-yongping",
    });
    expect(container.textContent).toContain("已关联到这个词条");
  });

  it("writes nothing for a work already on this entry", async () => {
    await openPicker();
    data.readContentTimelineEntry.mockResolvedValue({
      id: "row-yongping",
      title: "永平碑",
      fullTitle: "北魏虚构永平碑",
    });
    click(query(`[data-timeline-attach-work="${workId(1)}"]`));
    click(query("[data-timeline-attach-confirm]"));
    await flush();
    expect(data.setWorkTimelineEntry).not.toHaveBeenCalled();
    expect(container.textContent).toContain("这篇帖子已关联到这个词条");
  });

  it("repeats an unconfirmed attachment with the same request", async () => {
    await openPicker();
    data.readContentTimelineEntry.mockResolvedValue(null);
    data.setWorkTimelineEntry.mockRejectedValueOnce(
      Object.assign(new Error("网络连接中断，结果尚未确认"), {
        outcomeUnknown: true,
      }),
    );
    click(query(`[data-timeline-attach-work="${workId(1)}"]`));
    click(query("[data-timeline-attach-confirm]"));
    await flush();
    expect(container.textContent).toContain("网络连接中断，结果尚未确认");
    const first = data.setWorkTimelineEntry.mock.calls[0]![1];
    data.setWorkTimelineEntry.mockResolvedValue({
      workId: workId(1),
      entryId: "row-yongping",
      version: 1,
    });
    click(button("重试"));
    await flush();
    expect(data.setWorkTimelineEntry.mock.calls[1]![1]).toEqual(first);
    expect(container.textContent).toContain("已关联到这个词条");
  });

  it("says a refusal in the account's words and keeps the list", async () => {
    await openPicker();
    data.readContentTimelineEntry.mockResolvedValue(null);
    data.setWorkTimelineEntry.mockRejectedValueOnce(
      new Error("这篇帖子不能再关联到这个词条"),
    );
    click(query(`[data-timeline-attach-work="${workId(1)}"]`));
    click(query("[data-timeline-attach-confirm]"));
    await flush();
    expect(container.textContent).toContain("这篇帖子不能再关联到这个词条");
    expect(query("[data-timeline-attach-picker]")).not.toBeNull();
    expect(button("重试")).toBeUndefined();
  });
});
