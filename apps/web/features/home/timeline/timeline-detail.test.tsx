// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TimelineEntry } from "@moya/contracts";
import type { Root } from "react-dom/client";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const shell = vi.hoisted(() => ({
  browseOnly: false,
  openContent: vi.fn(),
  openEditor: vi.fn(() => true),
  openProfile: vi.fn(),
  platform: "phone" as "phone" | "tablet" | "pc",
}));
vi.mock("../../product-shell/product-shell", () => ({
  useProductShell: () => shell,
}));
const authors = vi.hoisted(() => ({
  value: {
    checking: false,
    viewer: null as { id: string } | null,
  },
}));
vi.mock("../../authors/author-context", () => ({
  useOptionalAuthors: () => authors.value,
}));
const client = vi.hoisted(() => ({
  accountEpoch: vi.fn(() => 0),
  timeline: vi.fn(),
}));
// The deck's post cards use the works grid's helpers from the same module.
vi.mock("../../authors/author-data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../authors/author-data")>()),
  authorClient: client,
}));
const data = vi.hoisted(() => ({
  readContentTimelineEntry: vi.fn(),
  readTimelinePosts: vi.fn(),
  invalidateTimelinePostCounts: vi.fn(),
}));
vi.mock("./timeline-posts-data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./timeline-posts-data")>()),
  ...data,
}));

const yongping = {
  id: "row-yongping",
  title: "永平碑",
  fullTitle: "北魏虚构永平碑",
} as const;
const fullEntry = {
  ...yongping,
  startYear: 511,
  endYear: 511,
  precision: "year",
  dateLabel: "永平四年",
  onAxis: true,
  chapter: "南北朝",
  polity: "北魏",
  disputed: false,
  groupId: null,
  groupTitle: null,
  province: "虚构东州",
  holder: "虚构碑林",
  catalogId: null,
  media: null,
} as unknown as TimelineEntry;

/** The session list and learned names live in modules: import them afresh. */
const load = async () => {
  vi.resetModules();
  return {
    detail: await import("./timeline-detail"),
    session: await import("./timeline-session"),
  };
};

let container: HTMLDivElement;
let root: Root;
const flush = async () => {
  await act(async () => {
    for (let at = 0; at < 6; at += 1) await Promise.resolve();
  });
};
const click = (element: Element | null | undefined) => {
  if (!element) throw new Error("Nothing to click");
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};

beforeEach(() => {
  shell.browseOnly = false;
  shell.platform = "phone";
  authors.value = { checking: false, viewer: null };
  for (const mock of [
    shell.openContent,
    shell.openEditor,
    shell.openProfile,
    client.timeline,
    ...Object.values(data),
  ])
    mock.mockReset();
  data.readTimelinePosts.mockResolvedValue({ items: [], total: 0, page: 1 });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = false;
    },
  });
  window.history.replaceState(null, "", "/");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  act(() => root.unmount());
  container.remove();
  await Promise.resolve();
  await vi.waitFor(
    () => expect(window.history.state?.phase4Dialog).toBeUndefined(),
    { timeout: 5000 },
  );
});

describe("Catalog Detail's 帖子 section (D1-A)", () => {
  it("shows nothing while pending or for a record without an entry", async () => {
    const { detail } = await load();
    let answer: (value: null) => void = () => undefined;
    data.readContentTimelineEntry.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    act(() =>
      root.render(<detail.CatalogTimelinePosts catalogId="catalog-plain" />),
    );
    expect(container.innerHTML).toBe("");
    answer(null);
    await flush();
    expect(data.readContentTimelineEntry).toHaveBeenCalledWith(
      { type: "catalog", id: "catalog-plain" },
      expect.any(AbortSignal),
    );
    expect(container.innerHTML).toBe("");
  });

  it("waits for the account check before reading", async () => {
    authors.value = { checking: true, viewer: null };
    const { detail } = await load();
    data.readContentTimelineEntry.mockResolvedValue(yongping);
    act(() =>
      root.render(<detail.CatalogTimelinePosts catalogId="catalog-linked" />),
    );
    await flush();
    expect(data.readContentTimelineEntry).not.toHaveBeenCalled();
    authors.value = { checking: false, viewer: null };
    act(() =>
      root.render(<detail.CatalogTimelinePosts catalogId="catalog-linked" />),
    );
    await flush();
    expect(data.readContentTimelineEntry).toHaveBeenCalledOnce();
  });

  const sectionPost = {
    id: `work-${"2".repeat(32)}`,
    authorId: `user-${"b".repeat(32)}`,
    authorName: "虚构作者",
    title: "访碑记",
    text: "",
    media: [],
    available: true,
    canEdit: false,
    firstPublishedAt: "2026-11-07T00:00:00.000Z",
  };

  it("names the section and shows the posts with no upload, and learns the entry's name", async () => {
    authors.value = {
      checking: false,
      viewer: { id: `user-${"a".repeat(32)}` },
    };
    const { detail, session } = await load();
    data.readContentTimelineEntry.mockResolvedValue(yongping);
    data.readTimelinePosts.mockResolvedValue({
      items: [sectionPost],
      total: 1,
      page: 1,
    });
    act(() =>
      root.render(<detail.CatalogTimelinePosts catalogId="catalog-linked" />),
    );
    await flush();
    expect(container.querySelector("h2")?.textContent).toBe("帖子");
    expect(
      container
        .querySelector("[data-timeline-posts]")
        ?.getAttribute("data-timeline-posts"),
    ).toBe("row-yongping");
    // Issue #422: a card the deck opened never offers an upload (Owner:
    // 点开某一个卡片后不要再显示上传); the deck's 上传 and the 词条卡 do.
    expect(container.querySelector("[data-timeline-upload]")).toBeNull();
    expect(container.querySelector("[data-timeline-attach]")).toBeNull();
    expect(container.textContent).not.toMatch(
      /上传这件碑帖|发布后会出现在这个词条下|关联我发过的帖子/u,
    );
    expect(container.textContent).toBe("帖子访碑记");
    const cell = container.querySelector("[data-timeline-post]");
    click(cell);
    expect(shell.openContent).toHaveBeenCalledWith(
      { type: "work", id: sectionPost.id },
      cell,
    );
    // 关联词条 can name the entry without reading the whole timeline.
    let named: ReturnType<typeof session.useTimelineEntryName> | null = null;
    const Probe = () => {
      named = session.useTimelineEntryName("row-yongping");
      return null;
    };
    act(() => root.render(<Probe />));
    await flush();
    expect(named!.name).toEqual({ state: "named", name: "北魏虚构永平碑" });
    expect(client.timeline).not.toHaveBeenCalled();
  });

  it("is not there at all for an entry with no posts, nor while they load", async () => {
    const { detail } = await load();
    const { DetailBandContext } = await import("../../detail/detail-band");
    data.readContentTimelineEntry.mockResolvedValue(yongping);
    let answer: (value: unknown) => void = () => undefined;
    data.readTimelinePosts.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const band = document.createElement("div");
    document.body.append(band);
    act(() =>
      root.render(
        <DetailBandContext.Provider value={band}>
          <detail.CatalogTimelinePosts catalogId="catalog-linked" />
        </DetailBandContext.Provider>,
      ),
    );
    await flush();
    expect(data.readTimelinePosts).toHaveBeenCalledOnce();
    expect(data.readTimelinePosts).toHaveBeenCalledWith(
      "row-yongping",
      1,
      6,
      expect.any(AbortSignal),
    );
    // While the posts load it keeps no room.
    expect(band.innerHTML).toBe("");
    expect(container.innerHTML).toBe("");
    answer({ items: [], total: 0, page: 1 });
    await flush();
    // No heading and no section: the band stays empty, so it is not shown.
    expect(band.innerHTML).toBe("");
    expect(container.innerHTML).toBe("");
    expect(data.readTimelinePosts).toHaveBeenCalledOnce();
    band.remove();
  });

  it("still says a failed read of the posts, and reads again on 重试", async () => {
    const { detail } = await load();
    data.readContentTimelineEntry.mockResolvedValue(yongping);
    data.readTimelinePosts.mockRejectedValueOnce(new Error("offline"));
    act(() =>
      root.render(<detail.CatalogTimelinePosts catalogId="catalog-linked" />),
    );
    await flush();
    expect(container.querySelector("h2")?.textContent).toBe("帖子");
    expect(container.textContent).toContain("帖子载入失败");
    data.readTimelinePosts.mockResolvedValue({
      items: [sectionPost],
      total: 1,
      page: 1,
    });
    click(
      [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "重试",
      ),
    );
    await flush();
    expect(container.querySelectorAll("[data-timeline-post]")).toHaveLength(1);
    expect(container.textContent).not.toContain("帖子载入失败");
  });

  it("keeps the grid and 全部 N 篇 with no upload, for a guest and when browse-only", async () => {
    const { detail } = await load();
    data.readContentTimelineEntry.mockResolvedValue(yongping);
    data.readTimelinePosts.mockResolvedValue({
      items: Array.from({ length: 6 }, (_, at) => ({
        ...sectionPost,
        id: `work-${String(at + 1).repeat(32)}`,
      })),
      total: 9,
      page: 1,
    });
    act(() =>
      root.render(<detail.CatalogTimelinePosts catalogId="catalog-linked" />),
    );
    await flush();
    const noUpload = () => {
      expect(container.querySelector("[data-timeline-upload]")).toBeNull();
      expect(container.querySelector("[data-timeline-attach]")).toBeNull();
      expect(container.querySelectorAll("[data-timeline-post]")).toHaveLength(
        6,
      );
      expect(
        container.querySelector("[data-timeline-posts-more]")?.textContent,
      ).toBe("全部 9 篇");
    };
    noUpload();
    expect(shell.openEditor).not.toHaveBeenCalled();
    expect(shell.openProfile).not.toHaveBeenCalled();

    shell.browseOnly = true;
    act(() =>
      root.render(<detail.CatalogTimelinePosts catalogId="catalog-linked" />),
    );
    noUpload();
  });

  it("renders in the desktop Detail's band, never in the actions slot under the image", async () => {
    const { detail } = await load();
    const { DetailBandContext } = await import("../../detail/detail-band");
    data.readContentTimelineEntry.mockResolvedValue(yongping);
    data.readTimelinePosts.mockResolvedValue({
      items: [sectionPost],
      total: 1,
      page: 1,
    });
    // Outside the root's container, as the layout's band is outside the slot.
    const band = document.createElement("div");
    document.body.append(band);
    act(() =>
      root.render(
        <DetailBandContext.Provider value={band}>
          <div data-test-actions-slot="">
            <detail.CatalogTimelinePosts catalogId="catalog-linked" />
          </div>
        </DetailBandContext.Provider>,
      ),
    );
    await flush();
    const section = band.querySelector("[data-detail-timeline-posts]");
    expect(section?.parentElement).toBe(band);
    expect(section?.hasAttribute("data-detail-band-section")).toBe(true);
    expect(
      container.querySelector("[data-test-actions-slot]")?.children,
    ).toHaveLength(0);
    band.remove();
  });
});

describe("a work's 收录于", () => {
  const post = {
    id: `work-${"1".repeat(32)}`,
    authorId: `user-${"b".repeat(32)}`,
    authorName: "虚构作者",
    title: "访碑记",
    text: "",
    media: [],
    available: true,
    canEdit: false,
    firstPublishedAt: "2026-11-07T00:00:00.000Z",
  };
  const closedDialog = () =>
    vi.waitFor(() => expect(container.querySelector("dialog")).toBeNull(), {
      timeout: 5000,
    });

  it("opens the entry's card deck, reading the timeline only on the tap", async () => {
    authors.value = {
      checking: false,
      viewer: { id: `user-${"a".repeat(32)}` },
    };
    const { detail } = await load();
    client.timeline.mockResolvedValue({ entries: [fullEntry] });
    data.readTimelinePosts.mockResolvedValue({
      items: [post],
      total: 1,
      page: 1,
    });
    act(() => root.render(<detail.WorkTimelineEntryLine entry={yongping} />));
    const line = container.querySelector<HTMLElement>(
      "[data-work-timeline-entry]",
    );
    expect(line?.textContent).toBe("收录于 · 北魏虚构永平碑");
    expect(client.timeline).not.toHaveBeenCalled();
    click(line);
    await flush();
    expect(client.timeline).toHaveBeenCalledOnce();
    // The line's work is one of the entry's posts, so no count is read.
    const deck = container.querySelector("dialog [data-timeline-deck]");
    expect(deck?.getAttribute("data-timeline-deck")).toBe("row-yongping");
    expect(
      deck?.querySelector("[data-timeline-deck-header]")?.textContent,
    ).toBe("北魏虚构永平碑511 · 永平四年 · 虚构东州 · 虚构碑林");
    expect(
      deck
        ?.querySelector("[data-deck-current]")
        ?.getAttribute("data-deck-post"),
    ).toBe(post.id);
    // The deck's upload closes it first, then acts from the line.
    click(deck?.querySelector("[data-timeline-deck-upload]"));
    click(deck?.querySelector("[data-timeline-deck-new]"));
    await closedDialog();
    expect(shell.openEditor).toHaveBeenCalledWith(
      { type: "new", timelineEntryId: "row-yongping" },
      line,
    );
  });

  it("opens a card's Detail from the line, the Catalog card first", async () => {
    const { detail } = await load();
    client.timeline.mockResolvedValue({
      entries: [{ ...fullEntry, catalogId: "catalog-yongping" }],
    });
    data.readTimelinePosts.mockResolvedValue({
      items: [post],
      total: 1,
      page: 1,
    });
    act(() => root.render(<detail.WorkTimelineEntryLine entry={yongping} />));
    const line = container.querySelector<HTMLElement>(
      "[data-work-timeline-entry]",
    );
    click(line);
    await flush();
    const cards = [
      ...container.querySelectorAll("dialog button[data-deck-card]"),
    ];
    expect(cards.map((card) => card.getAttribute("data-deck-card"))).toEqual([
      "catalog",
      "post",
    ]);
    click(cards[0]);
    await closedDialog();
    expect(shell.openContent).toHaveBeenCalledWith(
      { type: "catalog", id: "catalog-yongping" },
      line,
    );

    click(line);
    await flush();
    click(container.querySelectorAll("dialog button[data-deck-card]")[1]);
    click(container.querySelector("dialog [data-deck-current]"));
    await closedDialog();
    expect(shell.openContent).toHaveBeenLastCalledWith(
      { type: "work", id: post.id },
      line,
    );
  });
});

describe("a work's 关联词条 sheet", () => {
  const type = (input: HTMLInputElement, value: string) => {
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  /** As the work page hosts it: the sheet goes when it reports closed. */
  const host = (
    Sheet: typeof import("./timeline-detail").TimelineEntryPickerSheet,
    props: {
      onChoose: (entry: TimelineEntry | null) => void;
      onClose: () => void;
      selectedId: string | null;
    },
  ) => {
    const Host = () => {
      const [open, setOpen] = useState(true);
      return open ? (
        <Sheet
          {...props}
          onClose={() => {
            props.onClose();
            setOpen(false);
          }}
        />
      ) : null;
    };
    return <Host />;
  };

  it("closes first, then hands over the choice", async () => {
    const { detail } = await load();
    client.timeline.mockResolvedValue({ entries: [fullEntry] });
    const order: string[] = [];
    const onClose = vi.fn(() => order.push("close"));
    const onChoose = vi.fn((entry: TimelineEntry | null) =>
      order.push(`choose:${entry?.id ?? "none"}`),
    );
    act(() =>
      root.render(
        host(detail.TimelineEntryPickerSheet, {
          onChoose,
          onClose,
          selectedId: null,
        }),
      ),
    );
    await flush();
    const dialog = container.querySelector("dialog")!;
    expect(dialog.querySelector("h2")?.textContent).toBe("关联词条");
    type(
      dialog.querySelector<HTMLInputElement>('input[type="search"]')!,
      "永平",
    );
    await flush();
    click(dialog.querySelector('[data-timeline-entry-option="row-yongping"]'));
    // The choice waits for the sheet to go.
    expect(onChoose).not.toHaveBeenCalled();
    await vi.waitFor(
      () => expect(container.querySelector("dialog")).toBeNull(),
      { timeout: 5000 },
    );
    expect(order).toEqual(["close", "choose:row-yongping"]);
    expect(onChoose).toHaveBeenCalledWith(fullEntry);
  });

  it("only closes on 取消", async () => {
    const { detail } = await load();
    client.timeline.mockResolvedValue({ entries: [fullEntry] });
    const onClose = vi.fn();
    const onChoose = vi.fn();
    act(() =>
      root.render(
        host(detail.TimelineEntryPickerSheet, {
          onChoose,
          onClose,
          selectedId: "row-yongping",
        }),
      ),
    );
    await flush();
    const dialog = container.querySelector("dialog")!;
    const cancel = [...dialog.querySelectorAll("button")].find(
      (button) => button.textContent === "取消",
    );
    click(cancel);
    await vi.waitFor(
      () => expect(container.querySelector("dialog")).toBeNull(),
      { timeout: 5000 },
    );
    expect(onClose).toHaveBeenCalledOnce();
    expect(onChoose).not.toHaveBeenCalled();
  });
});

describe("a late 收录于 answer", () => {
  it("does not stack the deck on a modal opened while the timeline was read", async () => {
    const { detail } = await load();
    let answer: (value: { entries: TimelineEntry[] }) => void = () => {};
    client.timeline.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    act(() => root.render(<detail.WorkTimelineEntryLine entry={yongping} />));
    click(container.querySelector("[data-work-timeline-entry]"));
    // The author opens 关联词条 meanwhile.
    const other = document.createElement("dialog");
    other.setAttribute("open", "");
    document.body.append(other);
    await act(async () => answer({ entries: [fullEntry] }));
    await flush();
    expect(container.querySelector("[data-timeline-deck]")).toBeNull();
    other.remove();
    // A later tap, with nothing open, shows the deck from the session list.
    click(container.querySelector("[data-work-timeline-entry]"));
    await flush();
    expect(container.querySelector("[data-timeline-deck]")).not.toBeNull();
  });
});

describe("useTimelineEntryName", () => {
  it("names an entry by its full title from the session's list", async () => {
    const { session } = await load();
    client.timeline.mockResolvedValue({ entries: [fullEntry] });
    await act(async () => {
      await session.loadTimeline();
    });
    let named: ReturnType<typeof session.useTimelineEntryName> | null = null;
    const Probe = () => {
      named = session.useTimelineEntryName("row-yongping");
      return null;
    };
    act(() => root.render(<Probe />));
    expect(named!.name).toEqual({ state: "named", name: "北魏虚构永平碑" });
    expect(client.timeline).toHaveBeenCalledOnce();
  });
});

describe("useContentTimelineEntry", () => {
  it("reads per target and account, and keeps a replaced answer", async () => {
    const { detail } = await load();
    data.readContentTimelineEntry.mockResolvedValue(yongping);
    let seen: ReturnType<typeof detail.useContentTimelineEntry> | null = null;
    const Probe = ({ id }: { readonly id: string | null }) => {
      seen = detail.useContentTimelineEntry(
        id === null ? null : { type: "work", id },
      );
      return null;
    };
    act(() => root.render(<Probe id={null} />));
    await flush();
    expect(data.readContentTimelineEntry).not.toHaveBeenCalled();
    expect(seen!.entry).toBeUndefined();
    const work = `work-${"1".repeat(32)}`;
    act(() => root.render(<Probe id={work} />));
    expect(seen!.entry).toBeUndefined();
    await flush();
    expect(seen!.entry).toEqual(yongping);
    act(() => seen!.replace(null));
    expect(seen!.entry).toBeNull();
    // Another account reads again.
    authors.value = {
      checking: false,
      viewer: { id: `user-${"b".repeat(32)}` },
    };
    act(() => root.render(<Probe id={work} />));
    await flush();
    expect(data.readContentTimelineEntry).toHaveBeenCalledTimes(2);
    expect(seen!.entry).toEqual(yongping);
  });
});
