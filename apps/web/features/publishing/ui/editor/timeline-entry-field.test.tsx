// @vitest-environment jsdom
import { act, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createEditorSessionStore } from "./editor-session-state";
import { TextSettings } from "./text-settings";

import type { EditorSessionStore } from "./editor-session-state";
import type { EditorTarget } from "../../../product-shell/product-history";
import type { Root } from "react-dom/client";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../../../notifications/mention-control", () => ({
  MentionControl: () => null,
}));
const timeline = vi.hoisted(() => ({
  entries: [
    {
      id: "row-yongping",
      title: "永平碑",
      fullTitle: "北魏虚构永平碑",
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
      holder: null,
      catalogId: null,
      media: null,
    },
  ],
}));
vi.mock("../../../home/timeline/timeline-session", () => ({
  useTimelineEntries: () => ({
    entries: { state: "ready", entries: timeline.entries },
    retry: () => undefined,
  }),
  useTimelineEntryName: (id: string | null) => {
    const found = timeline.entries.find((entry) => entry.id === id);
    return {
      name:
        id === null
          ? { state: "none" }
          : found === undefined
            ? { state: "missing" }
            : { state: "named", name: found.title },
      retry: () => undefined,
    };
  },
}));

const ACCOUNT = `user-${"a".repeat(32)}`;

const Harness = ({ store }: { readonly store: EditorSessionStore }) => {
  const state = useSyncExternalStore(store.subscribe, store.get);
  return <TextSettings state={state} store={store} />;
};

const roots: Root[] = [];
const render = (target: EditorTarget) => {
  const store = createEditorSessionStore(ACCOUNT, target);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(<Harness store={store} />));
  const field = () =>
    container.querySelector<HTMLElement>('[data-editor-field="timelineEntry"]');
  return { container, field, root, store };
};
const click = (element: Element | null | undefined) => {
  if (!element) throw new Error("Nothing to click");
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};
const type = (element: HTMLInputElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

describe("关联词条 in the desktop text settings (timeline-posts-v1)", () => {
  it("follows 可见范围 for a new work and opens the picker in place", () => {
    const { container, field, store } = render({ type: "new" });
    const visibility = container.querySelector(
      '[data-editor-field="visibility"]',
    )!;
    expect(field()).not.toBe(null);
    expect(
      visibility.compareDocumentPosition(field()!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(field()!.querySelector("legend")!.textContent).toBe("关联词条可选");
    expect(field()!.textContent).toContain("发布后会出现在这个词条下。");
    click(field()!.querySelector("[data-editor-timeline-entry-open]"));
    type(
      field()!.querySelector<HTMLInputElement>('input[type="search"]')!,
      "永平",
    );
    click(
      field()!.querySelector('[data-timeline-entry-option="row-yongping"]'),
    );
    expect(store.get().timelineEntryId).toBe("row-yongping");
    expect(field()!.querySelector("[data-timeline-entry-picker]")).toBe(null);
    expect(
      field()!.querySelector("[data-editor-timeline-entry]")!.textContent,
    ).toBe("永平碑");
    click(field()!.querySelector("[data-editor-timeline-entry-clear]"));
    expect(store.get().timelineEntryId).toBe(null);
    expect(field()!.querySelector("[data-editor-timeline-entry]")).toBe(null);
  });

  it("names an entry it was opened with and says when it is gone", () => {
    expect(
      render({ type: "new", timelineEntryId: "row-yongping" })
        .field()!
        .querySelector("[data-editor-timeline-entry]")!.textContent,
    ).toBe("永平碑");
    expect(
      render({ type: "new", timelineEntryId: "row-hidden" })
        .field()!
        .querySelector("[data-editor-timeline-entry]")!.textContent,
    ).toBe("这个词条已不可用，请重新选择");
  });

  it("is not offered when a published work is edited", () => {
    const { field, root, store } = render({
      type: "work",
      id: `work-${"2".repeat(32)}`,
    });
    act(() =>
      store.setLoaded({ kind: "edit", workId: `work-${"2".repeat(32)}` }),
    );
    act(() => root.render(<Harness store={store} />));
    expect(field()).toBe(null);
  });
});
