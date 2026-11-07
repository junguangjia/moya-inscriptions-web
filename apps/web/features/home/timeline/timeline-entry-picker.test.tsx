// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TimelineEntry } from "@moya/contracts";
import type { Root } from "react-dom/client";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const client = vi.hoisted(() => ({
  accountEpoch: vi.fn(() => 0),
  timeline: vi.fn(),
}));
vi.mock("../../authors/author-data", () => ({ authorClient: client }));

const entry = (overrides: Partial<TimelineEntry>): TimelineEntry =>
  ({
    id: "row-1",
    title: "虚构南寺碑",
    fullTitle: "唐虚构南寺碑",
    startYear: 700,
    endYear: 700,
    precision: "year",
    dateLabel: "虚元八年",
    onAxis: true,
    chapter: "唐",
    polity: "唐",
    disputed: false,
    groupId: null,
    groupTitle: null,
    province: "虚构西州",
    holder: "虚构碑林",
    catalogId: null,
    media: null,
    ...overrides,
  }) as TimelineEntry;

const entries = [
  entry({}),
  entry({
    id: "row-yongping",
    title: "永平碑",
    fullTitle: "北魏虚构永平碑",
    startYear: 511,
    endYear: 511,
    dateLabel: "永平四年",
    chapter: "南北朝",
    polity: "北魏",
    province: "虚构东州",
  }),
  entry({
    id: "row-east",
    title: "虚构东碑",
    fullTitle: "唐虚构东碑",
    province: "虚构东州",
  }),
];

/** The session list lives in a module, so each case imports it afresh. */
const load = async () => {
  vi.resetModules();
  return import("./timeline-entry-picker");
};

let container: HTMLDivElement;
let root: Root;

const flush = async () => {
  await act(async () => {
    for (let at = 0; at < 4; at += 1) await Promise.resolve();
  });
};
const type = (value: string) => {
  const input = container.querySelector<HTMLInputElement>("input");
  if (!input) throw new Error("No search field");
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const options = () =>
  [
    ...container.querySelectorAll<HTMLElement>("[data-timeline-entry-option]"),
  ].map((option) => option.dataset.timelineEntryOption);

beforeEach(() => {
  client.accountEpoch.mockReturnValue(0);
  client.timeline.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("searchTimelineEntries", () => {
  it("matches every word against title, 年代 and 地点, in timeline order", async () => {
    const { searchTimelineEntries } = await load();
    expect(searchTimelineEntries(entries, "").matches).toEqual([]);
    expect(searchTimelineEntries(entries, "   ").matches).toEqual([]);
    expect(
      searchTimelineEntries(entries, "东州").matches.map((found) => found.id),
    ).toEqual(["row-yongping", "row-east"]);
    expect(
      searchTimelineEntries(entries, "东州 永平").matches.map(
        (found) => found.id,
      ),
    ).toEqual(["row-yongping"]);
    expect(
      searchTimelineEntries(entries, "511").matches.map((found) => found.id),
    ).toEqual(["row-yongping"]);
    expect(
      searchTimelineEntries(entries, "北魏").matches.map((found) => found.id),
    ).toEqual(["row-yongping"]);
  });

  it("lists at most the limit and says when more match", async () => {
    const { searchTimelineEntries } = await load();
    const found = searchTimelineEntries(entries, "虚构", 2);
    expect(found.matches).toHaveLength(2);
    expect(found.more).toBe(true);
    expect(searchTimelineEntries(entries, "虚构", 3).more).toBe(false);
  });
});

describe("TimelineEntryPicker", () => {
  it("reads the timeline on first use, then searches it locally", async () => {
    client.timeline.mockResolvedValue({ entries });
    const { TimelineEntryPicker } = await load();
    const onChoose = vi.fn();
    act(() =>
      root.render(
        <TimelineEntryPicker onChoose={onChoose} selectedId={null} />,
      ),
    );
    expect(container.textContent).toContain("正在载入词条");
    await flush();
    expect(client.timeline).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("输入题名、年代或地点查找词条。");
    expect(options()).toEqual([]);
    type("永平");
    await flush();
    expect(options()).toEqual(["row-yongping"]);
    act(() => {
      container
        .querySelector("[data-timeline-entry-option]")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onChoose).toHaveBeenCalledWith(entries[1]);
    // No clear action without a choice.
    expect(container.querySelector("[data-timeline-entry-clear]")).toBeNull();
  });

  it("lists the chosen entry first and offers to clear it", async () => {
    client.timeline.mockResolvedValue({ entries });
    const { TimelineEntryPicker } = await load();
    const onChoose = vi.fn();
    act(() =>
      root.render(
        <TimelineEntryPicker onChoose={onChoose} selectedId="row-east" />,
      ),
    );
    await flush();
    expect(options()).toEqual(["row-east"]);
    expect(
      container
        .querySelector('[data-timeline-entry-option="row-east"]')
        ?.getAttribute("aria-checked"),
    ).toBe("true");
    act(() => {
      container
        .querySelector("[data-timeline-entry-clear]")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onChoose).toHaveBeenCalledWith(null);
  });

  it("says a failed read and reads again on 重试", async () => {
    client.timeline.mockRejectedValueOnce(new Error("offline"));
    const { TimelineEntryPicker } = await load();
    act(() =>
      root.render(<TimelineEntryPicker onChoose={vi.fn()} selectedId={null} />),
    );
    await flush();
    expect(container.textContent).toContain("词条载入失败");
    client.timeline.mockResolvedValue({ entries });
    act(() => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "重试")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(client.timeline).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("输入题名、年代或地点查找词条。");
  });
});
