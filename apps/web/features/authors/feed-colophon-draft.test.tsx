// @vitest-environment jsdom
import { act, Profiler, StrictMode } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommentUserPresentation } from "../comments/comment-types";
import {
  colophonDraftBand,
  colophonDraftTail,
  ColophonDraftReply,
  ColophonDraftSheet,
  createColophonDraftSource,
  DRAFT_TAIL_CHARS,
  draftStatusLabel,
} from "./feed-colophon-draft";
import type { ColophonDraftSource } from "./feed-colophon-draft";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const reader: CommentUserPresentation = {
  id: "reader",
  name: "读者",
  studioName: "听雨斋",
  avatarSrc: "/avatars/reader.png",
};

let host: HTMLDivElement;
let root: Root;
const render = (node: ReactNode) =>
  act(() => {
    root.render(node);
  });

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the draft source", () => {
  it("holds the text, tells its listeners, skips equal values and lets go", () => {
    const source = createColophonDraftSource();
    const listener = vi.fn();
    const stop = source.subscribe(listener);
    expect(source.get()).toBe("");
    source.set("寒山");
    expect(source.get()).toBe("寒山");
    expect(listener).toHaveBeenCalledTimes(1);
    source.set("寒山");
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    source.set("寒山寺");
    expect(source.get()).toBe("寒山寺");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("draft helpers", () => {
  it("keeps the last 600 characters of a long draft after 「…」", () => {
    const text = `${"甲".repeat(100)}${"乙".repeat(600)}`;
    const tail = colophonDraftTail(text);
    expect(DRAFT_TAIL_CHARS).toBe(600);
    expect(tail).toBe(`…${"乙".repeat(600)}`);
    expect(colophonDraftTail("短")).toBe("短");
  });

  it("measures the band above the composer within six characters and the column", () => {
    const at = (formTop: number | null) =>
      colophonDraftBand({ rootTop: 100, formTop, gap: 4, min: 96, full: 400 });
    // The whole column fits above the bar.
    expect(at(700)).toBe(400);
    // The keyboard pushed the bar up: the column ends above it.
    expect(at(400)).toBe(296);
    // Never under the minimum (the nudge brings the rest in).
    expect(at(150)).toBe(96);
    // No bar, no band.
    expect(at(null)).toBeNull();
  });

  it("names each state", () => {
    expect(draftStatusLabel("draft")).toBe("草稿");
    expect(draftStatusLabel("sending")).toBe("发送中");
    expect(draftStatusLabel("failed")).toBe("未发出");
  });
});

const sheetOf = (
  source: ColophonDraftSource,
  composerForm: HTMLFormElement | null = null,
  state: "draft" | "sending" | "failed" = "draft",
) => (
  <ColophonDraftSheet
    composerForm={composerForm}
    slot="head"
    source={source}
    state={state}
    user={reader}
  />
);

describe("ColophonDraftSheet", () => {
  it("previews the draft vertically, signed by the reader and marked as a draft", () => {
    const source = createColophonDraftSource();
    render(sheetOf(source));
    const sheet = host.querySelector<HTMLElement>(
      '[data-colophon-draft="head"]',
    );
    expect(sheet?.textContent).toContain("在下方书写，此处竖排预览");
    act(() => source.set("“欧体” 10月9日"));
    expect(sheet?.textContent).toContain("「欧体」");
    expect(
      [...(sheet?.querySelectorAll('[class*="tcy"]') ?? [])].map(
        (node) => node.textContent,
      ),
    ).toEqual(["10", "9"]);
    expect(sheet?.querySelector("img")?.getAttribute("src")).toBe(
      "/avatars/reader.png",
    );
    expect(sheet?.textContent).toContain("读者");
    expect(sheet?.querySelector("[data-studio-name]")).not.toBeNull();
    expect(
      sheet?.querySelector("[data-colophon-draft-status]")?.textContent,
    ).toBe("草稿");
    expect(sheet?.getAttribute("aria-hidden")).toBe("true");
    // Nothing a reading anchor, a row count or a nested control would see.
    for (const selector of [
      "button",
      "[data-colophon-anchor]",
      "[data-colophon-text]",
      "[data-colophon-entry]",
      "[data-comment-id]",
    ])
      expect(sheet?.querySelector(selector)).toBeNull();
    expect(sheet?.querySelector("footer, div, p")).toBeNull();
  });

  it("marks sending and failure in the time slot", () => {
    const source = createColophonDraftSource();
    render(sheetOf(source, null, "sending"));
    const sheet = host.querySelector<HTMLElement>("[data-colophon-draft]");
    expect(sheet?.dataset.draftState).toBe("sending");
    expect(
      sheet?.querySelector("[data-colophon-draft-status]")?.textContent,
    ).toBe("发送中");
    render(sheetOf(source, null, "failed"));
    expect(
      sheet?.querySelector("[data-colophon-draft-status]")?.textContent,
    ).toBe("未发出");
  });

  it("re-renders only its ink while the reader types", () => {
    const source = createColophonDraftSource();
    let parentRenders = 0;
    const siblingCommits = vi.fn();
    const Sibling = () => <span>旁</span>;
    const Parent = () => {
      parentRenders += 1;
      return (
        <>
          <Profiler id="sibling" onRender={siblingCommits}>
            <Sibling />
          </Profiler>
          {sheetOf(source)}
        </>
      );
    };
    render(<Parent />);
    const rendersBefore = parentRenders;
    const commitsBefore = siblingCommits.mock.calls.length;
    for (let index = 1; index <= 20; index += 1)
      act(() => source.set("字".repeat(index)));
    expect(parentRenders).toBe(rendersBefore);
    expect(siblingCommits.mock.calls.length).toBe(commitsBefore);
    expect(
      host.querySelector("[data-colophon-draft-text]")?.textContent,
    ).toContain("字".repeat(20));
  });

  it("blinks its pen only while the composer has focus", () => {
    const form = document.createElement("form");
    const box = document.createElement("textarea");
    form.append(box);
    document.body.append(form);
    const source = createColophonDraftSource();
    render(sheetOf(source, form));
    const pen = host.querySelector<HTMLElement>("[data-colophon-draft-pen]");
    expect(pen?.hasAttribute("data-focused")).toBe(false);
    act(() => box.focus());
    expect(pen?.hasAttribute("data-focused")).toBe(true);
    act(() => box.blur());
    expect(pen?.hasAttribute("data-focused")).toBe(false);
  });

  it("stands the pen before the placeholder and after the written text", () => {
    const source = createColophonDraftSource();
    render(sheetOf(source));
    const ink = () =>
      host.querySelector<HTMLElement>("[data-colophon-draft-text]")!
        .firstElementChild!;
    expect(ink().firstElementChild?.matches("[data-colophon-draft-pen]")).toBe(
      true,
    );
    act(() => source.set("题"));
    expect(ink().lastElementChild?.matches("[data-colophon-draft-pen]")).toBe(
      true,
    );
  });

  it("drops 未发出 once the failed text is changed", () => {
    const source = createColophonDraftSource();
    source.set("发不出");
    render(sheetOf(source, null, "failed"));
    const mark = () =>
      host.querySelector("[data-colophon-draft-status]")?.textContent;
    expect(mark()).toBe("未发出");
    act(() => source.set("发不出了"));
    expect(mark()).toBe("草稿");
    act(() => source.set("发不出"));
    expect(mark()).toBe("未发出");
  });

  it("marks the cut edge once the ink outgrows its column", () => {
    let report: ResizeObserverCallback = () => undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          report = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    const source = createColophonDraftSource();
    render(sheetOf(source));
    const text = host.querySelector<HTMLElement>("[data-colophon-draft-text]")!;
    const ink = text.firstElementChild as HTMLElement;
    vi.spyOn(text, "getBoundingClientRect").mockReturnValue({
      width: 200,
    } as DOMRect);
    text.style.fontSize = "16px";
    let width = 120;
    vi.spyOn(ink, "getBoundingClientRect").mockImplementation(
      () => ({ width }) as DOMRect,
    );
    act(() => report([], {} as ResizeObserver));
    expect(text.dataset.overflow).toBeUndefined();
    // A sub-pixel (or one-pixel) excess cuts nothing off.
    width = 201;
    act(() => report([], {} as ResizeObserver));
    expect(text.dataset.overflow).toBeUndefined();
    width = 260;
    act(() => report([], {} as ResizeObserver));
    expect(text.dataset.overflow).toBe("true");
    width = 180;
    act(() => report([], {} as ResizeObserver));
    expect(text.dataset.overflow).toBeUndefined();
  });
});

describe("the band and the one-time nudge", () => {
  /** A feed scroller holding a stage, a fixed composer bar at `barTop`. */
  const scene = (barTop: number) => {
    const scroller = document.createElement("div");
    scroller.style.overflowY = "auto";
    const scrollBy = vi.fn();
    scroller.scrollBy = scrollBy as unknown as typeof scroller.scrollBy;
    const stage = document.createElement("div");
    stage.dataset.feedStage = "";
    const mount = document.createElement("div");
    stage.append(mount);
    scroller.append(stage);
    document.body.append(scroller);
    const form = document.createElement("form");
    document.body.append(form);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        const box = (top: number, height: number) =>
          ({ top, height, bottom: top + height, width: 300 }) as DOMRect;
        if (this === form) return box(barTop, 120);
        if (this === stage) return box(120, 500);
        if (this === scroller) return box(60, 700);
        if (this.parentElement?.matches("[data-colophon-draft]"))
          return box(140, 400);
        return box(0, 0);
      },
    );
    return { scroller, scrollBy, mount, form };
  };
  const viewport = () => {
    const target = new EventTarget() as EventTarget & {
      offsetTop: number;
      height: number;
    };
    target.offsetTop = 0;
    target.height = 800;
    const add = vi.spyOn(target, "addEventListener");
    const remove = vi.spyOn(target, "removeEventListener");
    vi.stubGlobal("visualViewport", target);
    return { target, add, remove };
  };
  const reduced = (matches: boolean) =>
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches }) as MediaQueryList),
    );
  const mountSheet = (mount: HTMLElement, form: HTMLFormElement) => {
    const sheetRoot = createRoot(mount);
    act(() =>
      sheetRoot.render(
        <StrictMode>
          <div style={{ fontSize: "16px" }}>
            {sheetOf(createColophonDraftSource(), form)}
          </div>
        </StrictMode>,
      ),
    );
    return sheetRoot;
  };

  it("writes the band to the sheet and nudges the feed once, gently", () => {
    vi.useFakeTimers();
    reduced(false);
    const { target } = viewport();
    // The bar sits 40 px under the column's top: less than six characters.
    const { scrollBy, mount, form } = scene(184);
    const sheetRoot = mountSheet(mount, form);
    const sheet = mount.querySelector<HTMLElement>("[data-colophon-draft]")!;
    expect(sheet.style.getPropertyValue("--colophon-draft-band")).not.toBe("");
    act(() => {
      target.dispatchEvent(new Event("resize"));
      vi.advanceTimersByTime(1000);
      target.dispatchEvent(new Event("resize"));
      vi.advanceTimersByTime(1000);
    });
    expect(scrollBy).toHaveBeenCalledTimes(1);
    // Just enough for six characters (96 px) above the bar: 52 px of the
    // 60 px the stage's top may still rise to the scroller's.
    const [{ top, behavior }] = scrollBy.mock.calls[0] as [ScrollToOptions];
    expect(top).toBe(52);
    expect(behavior).toBe("smooth");
    act(() => sheetRoot.unmount());
  });

  it("jumps under reduced motion and stays put when the band is long enough", () => {
    vi.useFakeTimers();
    reduced(true);
    viewport();
    const near = scene(184);
    const first = mountSheet(near.mount, near.form);
    act(() => vi.advanceTimersByTime(1000));
    expect(near.scrollBy).toHaveBeenCalledTimes(1);
    expect((near.scrollBy.mock.calls[0] as [ScrollToOptions])[0].behavior).toBe(
      "auto",
    );
    act(() => first.unmount());
    vi.restoreAllMocks();
    const far = scene(700);
    const second = mountSheet(far.mount, far.form);
    act(() => vi.advanceTimersByTime(1000));
    expect(far.scrollBy).not.toHaveBeenCalled();
    act(() => second.unmount());
  });

  it("leaves no listener behind", () => {
    vi.useFakeTimers();
    reduced(false);
    const { add, remove } = viewport();
    const documentAdd = vi.spyOn(document, "addEventListener");
    const documentRemove = vi.spyOn(document, "removeEventListener");
    const { mount, form } = scene(700);
    const sheetRoot = mountSheet(mount, form);
    act(() => sheetRoot.unmount());
    const pairs = (
      added: typeof add | typeof documentAdd,
      removed: typeof remove | typeof documentRemove,
    ) => {
      const count = (calls: unknown[][]) =>
        calls.filter(([type]) => type === "scroll" || type === "resize").length;
      return [count(added.mock.calls), count(removed.mock.calls)];
    };
    const [viewportAdded, viewportRemoved] = pairs(add, remove);
    expect(viewportAdded).toBeGreaterThan(0);
    expect(viewportRemoved).toBe(viewportAdded);
    const [documentAdded, documentRemoved] = pairs(documentAdd, documentRemove);
    expect(documentAdded).toBeGreaterThan(0);
    expect(documentRemoved).toBe(documentAdded);
  });
});

describe("ColophonDraftReply", () => {
  it("leads with 回复 X： and brings the keyboard back on a tap", () => {
    const source = createColophonDraftSource();
    const onRefocus = vi.fn();
    render(
      <ColophonDraftReply
        composerForm={null}
        onRefocus={onRefocus}
        replyTo="乙"
        source={source}
        state="draft"
        user={reader}
      />,
    );
    const sheet = host.querySelector<HTMLElement>(
      '[data-colophon-draft="reply"]',
    );
    expect(
      sheet
        ?.closest("[data-colophon-draft-replies]")
        ?.getAttribute("aria-hidden"),
    ).toBe("true");
    expect(sheet?.textContent).toContain("回复 乙：");
    expect(sheet?.textContent).toContain("在下方书写…");
    act(() => source.set("同感"));
    expect(sheet?.textContent).toContain("回复 乙：同感");
    act(() => {
      sheet?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onRefocus).toHaveBeenCalledTimes(1);
    expect(sheet?.querySelector("[data-colophon-anchor], button")).toBeNull();
  });
});
