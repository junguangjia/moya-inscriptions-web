// @vitest-environment jsdom
import { act } from "react";
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
vi.mock("../../authors/author-data", () => ({ authorClient: client }));
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

  it("names the section, uploads to the entry and learns its name", async () => {
    authors.value = {
      checking: false,
      viewer: { id: `user-${"a".repeat(32)}` },
    };
    const { detail, session } = await load();
    data.readContentTimelineEntry.mockResolvedValue(yongping);
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
    const upload = container.querySelector("[data-timeline-upload]");
    click(upload);
    expect(shell.openEditor).toHaveBeenCalledWith(
      { type: "new", timelineEntryId: "row-yongping" },
      upload,
    );
    // 关联词条 can name the entry without reading the whole timeline.
    let named: ReturnType<typeof session.useTimelineEntryName> | null = null;
    const Probe = () => {
      named = session.useTimelineEntryName("row-yongping");
      return null;
    };
    act(() => root.render(<Probe />));
    await flush();
    expect(named!.name).toEqual({ state: "named", name: "永平碑" });
    expect(client.timeline).not.toHaveBeenCalled();
  });

  it("sends a guest's upload to sign-in and hides it when browse-only", async () => {
    const { detail } = await load();
    data.readContentTimelineEntry.mockResolvedValue(yongping);
    act(() =>
      root.render(<detail.CatalogTimelinePosts catalogId="catalog-linked" />),
    );
    await flush();
    const upload = container.querySelector("[data-timeline-upload]");
    click(upload);
    expect(shell.openEditor).not.toHaveBeenCalled();
    expect(shell.openProfile).toHaveBeenCalledWith(null, upload);

    shell.browseOnly = true;
    act(() =>
      root.render(<detail.CatalogTimelinePosts catalogId="catalog-linked" />),
    );
    expect(container.querySelector("[data-timeline-upload]")).toBeNull();
    expect(container.querySelector("[data-timeline-posts]")).not.toBeNull();
  });
});

describe("a work's 收录于", () => {
  it("opens the 词条卡, reading the timeline only on the tap", async () => {
    authors.value = {
      checking: false,
      viewer: { id: `user-${"a".repeat(32)}` },
    };
    const { detail } = await load();
    client.timeline.mockResolvedValue({ entries: [fullEntry] });
    act(() => root.render(<detail.WorkTimelineEntryLine entry={yongping} />));
    const line = container.querySelector<HTMLElement>(
      "[data-work-timeline-entry]",
    );
    expect(line?.textContent).toBe("收录于 · 北魏虚构永平碑");
    expect(client.timeline).not.toHaveBeenCalled();
    click(line);
    await flush();
    expect(client.timeline).toHaveBeenCalledOnce();
    const dialog = container.querySelector("dialog");
    expect(
      dialog?.querySelector("[data-timeline-card]")?.textContent,
    ).toContain("虚构碑林");
    // The card's upload closes the sheet first, then acts from the line.
    click(dialog?.querySelector("[data-timeline-upload]"));
    await vi.waitFor(
      () => expect(container.querySelector("dialog")).toBeNull(),
      {
        timeout: 5000,
      },
    );
    expect(shell.openEditor).toHaveBeenCalledWith(
      { type: "new", timelineEntryId: "row-yongping" },
      line,
    );
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
