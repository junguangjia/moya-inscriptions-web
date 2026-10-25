// @vitest-environment jsdom
import { act, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  contentOf,
  createEditorSessionStore,
  localIssues,
} from "../editor/editor-session-state";
import { KEYBOARD_ATTRIBUTE } from "../editor/editor-layout";
import { FeedPostStage } from "../../../authors/feed-post-stage";
import { FeedStagePreview } from "../../../media-composer/feed-stage-preview";
import { publishReason } from "./publish-bar";
import {
  PublishPreviewStrip,
  PublishScreen,
  publishChipGlyph,
  stripCardIndex,
} from "./publish-screen";
// @ts-expect-error -- Vite serves the stylesheet's own text for a ?raw import.
import editorCss from "../editor/editor.module.css?raw";
// @ts-expect-error -- Vite serves the stylesheet's own text for a ?raw import.
import publishCss from "./publish-screen.module.css?raw";

import type {
  EditorSessionStore,
  Readiness,
} from "../editor/editor-session-state";
import type { PublishReasonInput } from "./publish-bar";
import type {
  PublishPreview,
  PublishPreviewSlide,
  PublishScreenProps,
} from "./publish-screen";
import type {
  MediaFeedFraming,
  MentionReference,
  WorkDraftItem,
} from "@moya/contracts";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * The shared mention control needs notifications and an account; a stand-in
 * with its trigger's shape shows where the screen puts it and what it wires.
 */
vi.mock("../../../notifications/mention-control", () => ({
  MentionControl: ({
    text,
    onChange,
  }: {
    readonly text: string;
    readonly onChange: (
      text: string,
      refs: readonly MentionReference[],
    ) => void;
  }) => (
    <div data-mention-stub="">
      <button
        aria-controls="mention-panel"
        aria-expanded={false}
        onClick={() =>
          onChange(`${text}@lan`, [
            {
              userId: "user-lan",
              handle: "lan",
              start: text.length,
              end: text.length + 4,
            },
          ])
        }
        type="button"
      >
        @ 提醒用户
      </button>
    </div>
  ),
}));

const ACCOUNT = `user-${"a".repeat(32)}`;

const ready: Readiness = {
  total: 0,
  ready: 0,
  blocking: 0,
  text: null,
  confirmed: true,
  unknownItemIds: [],
};

const item = (key: string): WorkDraftItem => ({
  key,
  itemId: null,
  kind: "static",
  qualityMode: "standard",
  edit: { rotation: 0, crop: null },
  pendingLabel: "photo",
});

const slide = (
  key: string,
  extra: Partial<PublishPreviewSlide> = {},
): PublishPreviewSlide => ({
  key,
  alt: `第 ${key} 项`,
  src: `blob:${key}`,
  size: { width: 600, height: 800 },
  status: "ready",
  ...extra,
});

/** CSS module class names without the test build's `_name_hash` wrapping. */
const names = (element: Element) =>
  [...element.classList].map((name) =>
    name.replace(/^_(.+)_[0-9a-f]+$/u, "$1"),
  );

type Overrides = Partial<
  Omit<PublishScreenProps, "editor" | "textProps" | "confirmation">
> & {
  readonly confirmation?: Partial<PublishScreenProps["confirmation"]>;
};

/** The screen over a live store, wired as the editor wires it. */
const Harness = ({
  store,
  overrides,
}: {
  readonly store: EditorSessionStore;
  readonly overrides: Overrides;
}) => {
  const state = useSyncExternalStore(store.subscribe, store.get);
  const { confirmation, ...rest } = overrides;
  return (
    <PublishScreen
      editor={{ state, content: contentOf(state), actions: store }}
      onBack={() => undefined}
      onOpenPreview={() => undefined}
      onReferences={() => undefined}
      preview={null}
      publish={{
        label: state.kind === "edit" ? "保存更新" : "发布",
        busy: false,
        onSubmit: () => undefined,
      }}
      saveStatus={<span data-save-status="saved">已保存</span>}
      textProps={{ state, store }}
      title="发布作品"
      confirmation={{
        state,
        readiness: ready,
        cover: null,
        issues: localIssues(state),
        submission: { status: "idle" },
        unconfirmedFiles: 0,
        onSubmit: () => undefined,
        onGoToField: () => undefined,
        onCheckAgain: () => undefined,
        onRetry: () => undefined,
        ...confirmation,
      }}
      references={null}
      {...rest}
    />
  );
};

const roots: Root[] = [];
const render = (overrides: Overrides = {}) => {
  const store = createEditorSessionStore(ACCOUNT, { type: "new" });
  const container = document.createElement("div");
  // The editor host, as its viewport frame marks it (no keyboard yet).
  container.setAttribute(KEYBOARD_ATTRIBUTE, "false");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const draw = (next: Overrides = overrides) =>
    act(() => root.render(<Harness overrides={next} store={store} />));
  draw();
  const screen = container.firstElementChild as HTMLElement;
  const footer = () =>
    screen.querySelector<HTMLElement>("[data-editor-footer]")!;
  const submit = () =>
    screen.querySelector<HTMLButtonElement>("[data-editor-submit]")!;
  const choice = (value: string) =>
    screen.querySelector<HTMLButtonElement>(
      `[data-publish-choice="${value}"]`,
    )!;
  const input = <T extends HTMLElement>(field: string) =>
    document.querySelector<T>(`[data-editor-input="${field}"]`)!;
  /** The on-screen keyboard comes up or goes down (the host's mark changes). */
  const keyboard = (up: boolean) =>
    act(async () => {
      container.setAttribute(KEYBOARD_ATTRIBUTE, String(up));
      await Promise.resolve();
    });
  return { store, screen, draw, footer, submit, choice, input, keyboard };
};

/** Types into a controlled field the way React hears it. */
const type = (element: HTMLInputElement | HTMLTextAreaElement, value: string) =>
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(element) as object,
      "value",
    )!.set!;
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("PublishScreen", () => {
  it("draws the bar with the save status and ≡ 更多操作 alone, Back named for where it goes", () => {
    const onBack = vi.fn();
    const { screen, store, draw, footer } = render({
      onBack,
      saveAction: (
        <button data-editor-save-now="" type="button">
          保存草稿
        </button>
      ),
      menu: <button aria-label="更多操作" data-editor-menu="" type="button" />,
    });
    expect(screen.getAttribute("data-editor-screen")).toBe("publish");
    const bar = screen.querySelector("[data-editor-bar]")!;
    // The hairline appears only once the content scrolls under the bar.
    expect(bar.getAttribute("data-bar-line")).toBe("scrolled");
    expect(bar.querySelector("h2")!.textContent).toBe("发布作品");
    expect(bar.querySelector("[data-save-status]")!.textContent).toBe("已保存");
    // Inside the 发布 screen, where 有未保存的更改 takes the warning dot
    // (editor.module.css, tested below).
    expect(
      bar
        .querySelector("[data-save-status]")!
        .closest('[data-editor-screen="publish"]'),
    ).toBe(screen);
    // Mockup A: the bar ends in ≡ alone; 保存草稿 is in the bottom bar.
    expect(bar.querySelector("[data-editor-menu]")).not.toBe(null);
    expect(bar.querySelector("[data-editor-save-now]")).toBe(null);
    expect(footer().querySelector("[data-editor-save-now]")).not.toBe(null);
    expect(bar.querySelector("[data-publish-done]")).toBe(null);
    const back = bar.querySelector<HTMLButtonElement>("button")!;
    // No photos: Back returns to 选择照片.
    expect(back.getAttribute("aria-label")).toBe("返回选择照片");
    act(() => back.click());
    expect(onBack).toHaveBeenCalledOnce();

    act(() =>
      store.setMedia({ items: [item("a")], coverKey: null, coverCrop: null }),
    );
    draw();
    expect(back.getAttribute("aria-label")).toBe("返回编辑照片");
  });

  it("keeps notices first, then the strip, the writing area, one line, 作品性质, 可见范围 and the sheet", () => {
    const { screen } = render({
      notices: <p data-editor-notice="">已恢复本机未完成的编辑</p>,
      preview: {
        slides: [slide("a")],
        total: 1,
        activeIndex: 0,
        onActiveIndexChange: () => undefined,
        onOpenItem: () => undefined,
      },
    });
    const content = screen.querySelector("[data-editor-scroller] > div")!;
    expect(names(content)).toEqual(["stepContent", "content"]);
    const status = screen.querySelector("[data-publish-status]")!;
    expect(status.children).toHaveLength(1);
    expect(status.firstElementChild!.hasAttribute("data-editor-notice")).toBe(
      true,
    );
    // Notices are lines of text there, never boxes (mockup A).
    expect(publishCss as string).toMatch(
      /\.status > p,\s*\.status > div \{\s*padding: 0;\s*background: transparent;\s*border-radius: 0;/u,
    );
    const order = [
      "[data-publish-status]",
      "[data-publish-preview]",
      '[data-editor-input="title"]',
      '[data-editor-input="body"]',
      "[data-publish-divider]",
      '[data-publish-option="authorship"]',
      '[data-publish-option="visibility"]',
      "[data-editor-confirmation]",
    ].map((selector) => screen.querySelector(selector)!);
    for (const [index, element] of order.entries()) {
      expect(element).not.toBe(null);
      if (index > 0)
        expect(
          order[index - 1]!.compareDocumentPosition(element) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
    }
    // The page's only line; no rows, no 预览作品页 in the scroll area.
    expect(screen.querySelectorAll("hr")).toHaveLength(1);
    expect(screen.querySelector("[data-disclosure-row]")).toBe(null);
    expect(
      screen
        .querySelector("[data-editor-scroller]")!
        .querySelector("[data-editor-preview-open]"),
    ).toBe(null);
    // The writing area keeps the editor's hook.
    expect(
      screen
        .querySelector('[data-editor-input="title"]')!
        .closest("[data-editor-text-settings]"),
    ).not.toBe(null);
  });

  it("writes 标题 and 正文 without boxes, with hidden labels and counters that show near the limit", () => {
    const { screen, store, input } = render();
    const title = input<HTMLInputElement>("title");
    const body = input<HTMLTextAreaElement>("body");
    expect(title.placeholder).toBe("添加标题");
    expect(body.placeholder).toBe("写下作品的说明、释文或心得");
    expect(names(title)).toEqual(["titleInput"]);
    expect(names(body)).toEqual(["bodyInput"]);
    expect(body.rows).toBe(4);
    expect(names(title.closest("[data-editor-field]")!)).toEqual(["bareField"]);
    // The labels are read, not drawn.
    const label = screen.querySelector<HTMLLabelElement>(
      `label[for="${title.id}"]`,
    )!;
    expect(label.textContent).toBe("标题（必填）");
    expect(title.getAttribute("aria-required")).toBe("true");
    expect(names(label)).toEqual(["visuallyHidden"]);
    expect(screen.querySelector(`label[for="${body.id}"]`)!.textContent).toBe(
      "正文（可选）",
    );

    // The counter is announced always, drawn only from 80% of the limit.
    const counterOf = (element: HTMLElement) =>
      document.getElementById(
        element.getAttribute("aria-describedby")!.split(" ")[0]!,
      )!;
    const titleCounter = counterOf(title);
    expect(names(titleCounter)).toEqual(["counter"]);
    expect(titleCounter.parentElement).toBe(title.parentElement);
    expect(titleCounter.textContent).toBe("0/200已输入 0 字，最多 200 字");
    expect(
      titleCounter.querySelector<HTMLElement>("[aria-hidden]")!.hidden,
    ).toBe(true);
    type(title, "临".repeat(159));
    expect(store.get().title).toBe("临".repeat(159));
    expect(
      titleCounter.querySelector<HTMLElement>("[aria-hidden]")!.hidden,
    ).toBe(true);
    type(title, "临".repeat(160));
    expect(
      titleCounter.querySelector<HTMLElement>("[aria-hidden]")!.hidden,
    ).toBe(false);
    expect(titleCounter.hasAttribute("data-over")).toBe(false);
    expect(title.hasAttribute("aria-invalid")).toBe(false);
    // Past the limit: red, invalid and said at the field.
    type(title, "临".repeat(201));
    expect(titleCounter.getAttribute("data-over")).toBe("true");
    expect(title.getAttribute("aria-invalid")).toBe("true");
    const [, errorId] = title.getAttribute("aria-describedby")!.split(" ");
    const error = document.getElementById(errorId!)!;
    expect(names(error)).toEqual(["error", "bareError"]);
    expect(error.textContent).toContain("200");

    // 正文: the hint is described, and its counter sits after the tools.
    const [bodyCounterId, bodyHintId] = body
      .getAttribute("aria-describedby")!
      .split(" ");
    const hint = document.getElementById(bodyHintId!)!;
    expect(names(hint)).toEqual(["bareHint"]);
    expect(hint.textContent).toBe("保留换行；首尾的空白不计入字数");
    const tools = document.getElementById(bodyCounterId!)!.parentElement!;
    expect(names(tools)).toEqual(["bodyTools"]);
    expect(tools.firstElementChild!.hasAttribute("data-mention-stub")).toBe(
      true,
    );
    type(body, "第一行\n第二行");
    expect(store.get().body).toBe("第一行\n第二行");

    // A line break that came with a paste: 移除换行 ends the message, drawn
    // small like every inline action on 发布.
    act(() => store.setTitle("临\n兰亭"));
    const [, breakId] = title.getAttribute("aria-describedby")!.split(" ");
    const breakError = document.getElementById(breakId!)!;
    expect(breakError.textContent).toBe("标题不能换行移除换行");
    const join = breakError.querySelector("button")!;
    expect(names(join)).toEqual(["inlineAction", "lineAction"]);
    act(() => join.click());
    expect(store.get().title).toBe("临 兰亭");
  });

  it("offers 「@ 提醒用户」 under 正文 with the shared control's own behaviour", () => {
    const { screen, store, input } = render();
    type(input<HTMLTextAreaElement>("body"), "临兰亭 ");
    const mention = screen.querySelector<HTMLButtonElement>(
      "[data-mention-stub] button",
    )!;
    expect(mention.textContent).toBe("@ 提醒用户");
    act(() => mention.click());
    expect(store.get().body).toBe("临兰亭 @lan");
    expect(store.get().mentions).toEqual([
      { userId: "user-lan", handle: "lan", start: 4, end: 8 },
    ]);
  });

  it("draws 作品性质 as chips under its heading, with 可选, a description and 清除选择", () => {
    const { screen, store, choice } = render();
    const section = screen.querySelector<HTMLElement>(
      '[data-publish-option="authorship"]',
    )!;
    expect(section.tagName).toBe("SECTION");
    expect(names(section)).toEqual(["optSection"]);
    expect(section.getAttribute("data-editor-field")).toBe("authorship");
    const heading = section.querySelector("h3")!;
    expect(heading.textContent).toBe("作品性质");
    expect(section.getAttribute("aria-labelledby")).toBe(heading.id);
    expect(names(heading.parentElement!)).toEqual(["optHead"]);
    expect(heading.nextElementSibling!.textContent).toBe("可选");
    const group = section.querySelector<HTMLElement>('[role="radiogroup"]')!;
    expect(names(group)).toEqual(["chips"]);
    expect(group.getAttribute("aria-labelledby")).toBe(heading.id);
    const chips = [
      ...group.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
    ];
    expect(chips.map((chip) => chip.textContent)).toEqual([
      "原创",
      "临摹或练习",
      "素材分享",
    ]);
    expect(names(chips[0]!)).toEqual(["chip"]);
    expect(names(chips[0]!.firstElementChild!)).toEqual(["chipFace"]);
    // C05: nothing is chosen for the author; the first chip is the tab stop.
    expect(chips.map((chip) => chip.getAttribute("aria-checked"))).toEqual([
      "false",
      "false",
      "false",
    ]);
    expect(chips.map((chip) => chip.tabIndex)).toEqual([0, -1, -1]);
    const description = document.getElementById(
      group.getAttribute("aria-describedby")!,
    )!;
    expect(names(description)).toEqual(["optDescription"]);
    expect(description.textContent).toBe("未设置");
    expect(description.hasAttribute("data-unset")).toBe(true);
    expect(section.querySelector("[data-editor-authorship-clear]")).toBe(null);
    expect(section.querySelector("[data-publish-references]")).toBe(null);

    act(() => choice("original").click());
    expect(store.get().authorshipKind).toBe("original");
    expect(choice("original").getAttribute("aria-checked")).toBe("true");
    expect(choice("original").tabIndex).toBe(0);
    expect(description.textContent).toBe("自己创作的作品");
    expect(description.hasAttribute("data-unset")).toBe(false);
    // 原创 has no references to note.
    expect(section.querySelector("[data-publish-references]")).toBe(null);
    // The chosen chip pressed again clears it (mockup A).
    act(() => choice("original").click());
    expect(store.get().authorshipKind).toBe(null);

    act(() => choice("copy_practice").click());
    const clear = section.querySelector<HTMLButtonElement>(
      "[data-editor-authorship-clear]",
    )!;
    expect(clear.textContent).toBe("清除选择");
    // 发布's own small inline action, not the editor's 32px one: the head
    // keeps its 24px and the chips under it stay put.
    expect(names(clear)).toEqual(["inlineAction", "optClear"]);
    const css = publishCss as string;
    const inline = /\n\.inlineAction \{([^}]*)\}/u.exec(css)![1]!;
    expect(inline).not.toMatch(/min-height|min-width|height:/u);
    expect(inline).toMatch(/display: inline-flex;/u);
    expect(inline).toMatch(/padding: 0 var\(--yoyi-space-1\);/u);
    expect(css).toMatch(
      /\.inlineAction::before \{[^}]*height: 44px;[^}]*transform: translateY\(-50%\);/u,
    );
    expect(css).toMatch(/\.optHead \{[^}]*min-height: 24px;/u);
    expect(css).toMatch(/button\.optClear \{[^}]*margin-left: auto;/u);
    act(() => clear.click());
    expect(store.get().authorshipKind).toBe(null);
    // The keyboard stays in the group instead of falling to the page.
    expect(document.activeElement).toBe(choice("original"));
  });

  it("moves 作品性质 and 可见范围 with the arrow keys, focus following the choice", () => {
    const { store, choice } = render();
    const key = (target: HTMLElement, name: string) =>
      act(() => {
        target.dispatchEvent(
          new KeyboardEvent("keydown", { key: name, bubbles: true }),
        );
      });
    act(() => choice("original").focus());
    key(choice("original"), "ArrowRight");
    expect(store.get().authorshipKind).toBe("copy_practice");
    expect(document.activeElement).toBe(choice("copy_practice"));
    key(choice("copy_practice"), "End");
    expect(store.get().authorshipKind).toBe("material_sharing");
    key(choice("material_sharing"), "ArrowDown");
    expect(store.get().authorshipKind).toBe("original");
    key(choice("original"), "ArrowLeft");
    expect(store.get().authorshipKind).toBe("material_sharing");

    act(() => choice("public").focus());
    key(choice("public"), "ArrowRight");
    expect(store.get().visibility).toBe("self");
    expect(document.activeElement).toBe(choice("self"));
    key(choice("self"), "Home");
    expect(store.get().visibility).toBe("public");
  });

  it("names the references on one line that opens their sheet", () => {
    const onReferences = vi.fn();
    const { screen, store, choice, draw } = render({ onReferences });
    act(() => choice("material_sharing").click());
    const line = screen.querySelector<HTMLButtonElement>(
      "[data-publish-references]",
    )!;
    expect(names(line)).toEqual(["refLine"]);
    expect(line.getAttribute("aria-haspopup")).toBe("dialog");
    expect(line.querySelector("b")!.textContent).toBe(
      "参考作品 · 原作者 · 来源",
    );
    expect(line.querySelector("small")!.textContent).toBe("可选");
    const chevron = line.querySelector('[data-icon="next"]')!;
    // The shared icon is a span: its class carries the tertiary colour.
    expect(names(chevron)).toContain("refChevron");
    expect(publishCss as string).toMatch(
      /\.refLine > \.refChevron \{\s*flex: none;\s*color: var\(--yoyi-color-text-tertiary\);/u,
    );
    act(() => line.click());
    expect(onReferences).toHaveBeenCalledExactlyOnceWith("referenceTitle");

    act(() => {
      store.setReference("referenceTitle", "兰亭序");
      store.setReference("sourceNote", "故宫博物院");
    });
    draw({ onReferences });
    expect(line.querySelector("small")!.textContent).toBe(
      "兰亭序 · 故宫博物院",
    );
    // A field's problem shows on the line, in the error colour.
    act(() => store.setReference("originalAuthor", "王".repeat(101)));
    draw({ onReferences });
    expect(line.querySelector("small")!.textContent).toContain("100");
    expect(line.querySelector("small")!.hasAttribute("data-error")).toBe(true);
  });

  it("opens the reference sheet at the named field, writing every keystroke, closed by 完成", () => {
    const onReferences = vi.fn();
    const { store, choice, draw, input } = render({ onReferences });
    act(() => choice("copy_practice").click());
    draw({ onReferences, references: "originalAuthor" });
    const sheet = document.querySelector<HTMLDialogElement>(
      'dialog[data-phone-sheet="references"]',
    )!;
    expect(sheet.open).toBe(true);
    expect(sheet.querySelector("h2")!.textContent).toBe("临摹或练习");
    expect(sheet.querySelector("h2")!.nextElementSibling!.textContent).toBe(
      "临摹、仿写或练习，可注明参考作品",
    );
    expect(document.activeElement).toBe(input("originalAuthor"));
    const fields = [...sheet.querySelectorAll("[data-editor-field]")];
    expect(
      fields.map((field) => field.getAttribute("data-editor-field")),
    ).toEqual(["referenceTitle", "originalAuthor", "sourceNote"]);
    expect(
      fields.map((field) => field.querySelector("label")!.textContent),
    ).toEqual(["参考作品可选", "原作者可选", "来源可选"]);
    expect(names(input("referenceTitle"))).toEqual(["fieldInput"]);
    // Mockup A's sheet (the grab bar is select-screen.module.css's, keyed on
    // the sheet's name): the form flush under the header, clear of a notch.
    expect(names(sheet.querySelector("[data-editor-references]")!)).toEqual([
      "sheetForm",
    ]);
    expect(publishCss as string).toMatch(
      /\.sheetForm \{[^}]*padding: 0 max\(var\(--yoyi-space-5\), env\(safe-area-inset-right\)\)\s+var\(--yoyi-space-2\) max\(var\(--yoyi-space-5\), env\(safe-area-inset-left\)\);/u,
    );
    expect(input("sourceNote").tagName).toBe("TEXTAREA");
    type(input<HTMLInputElement>("referenceTitle"), "兰亭序");
    expect(store.get().reference.referenceTitle).toBe("兰亭序");
    const done = sheet.querySelector<HTMLButtonElement>(
      "[data-publish-references-done]",
    )!;
    expect(done.textContent).toBe("完成");
    act(() => done.click());
    expect(onReferences).toHaveBeenLastCalledWith(null);
    // Escape closes it the same way.
    act(() => {
      sheet.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(onReferences).toHaveBeenCalledTimes(2);

    // No references to fill: no sheet, whatever the flow asked.
    act(() => choice("original").click());
    draw({ onReferences, references: "originalAuthor" });
    expect(
      document.querySelector('dialog[data-phone-sheet="references"]'),
    ).toBe(null);
  });

  it("keeps the focused reference field in view while the keyboard shortens the sheet, moving only the sheet", () => {
    // The browser's visual viewport, and frames that run at once.
    const viewport = new EventTarget();
    vi.stubGlobal("visualViewport", viewport);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    const boxes = new Map<Element, { top: number; bottom: number }>();
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        const box = boxes.get(this) ?? { top: 0, bottom: 0 };
        return { ...box, height: box.bottom - box.top } as DOMRect;
      },
    );
    const { store, choice, draw, input, screen } = render();
    act(() => choice("copy_practice").click());
    draw({ references: "sourceNote" });
    const form = document.querySelector<HTMLElement>(
      "[data-editor-references]",
    )!;
    // The form is drawn straight in the scrolling sheet.
    const sheet = form.parentElement!;
    const field = input<HTMLTextAreaElement>("sourceNote");
    expect(document.activeElement).toBe(field);
    const scroller = screen.querySelector<HTMLElement>(
      "[data-editor-scroller]",
    )!;
    scroller.scrollTop = 0;
    // The keyboard rises: the sheet now ends at 400, the field below it.
    boxes.set(sheet, { top: 120, bottom: 400 });
    boxes.set(field, { top: 430, bottom: 490 });
    sheet.scrollTop = 0;
    act(() => {
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(sheet.scrollTop).toBe(90);
    // Already in view: nothing moves.
    boxes.set(field, { top: 340, bottom: 400 });
    act(() => {
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(sheet.scrollTop).toBe(90);
    // Focus moving to a field above the visible part brings it down.
    const title = input<HTMLInputElement>("referenceTitle");
    boxes.set(title, { top: 60, bottom: 104 });
    act(() => title.focus());
    expect(sheet.scrollTop).toBe(30);
    // The screen under the sheet never scrolls for it.
    expect(scroller.scrollTop).toBe(0);
    expect(store.get().authorshipKind).toBe("copy_practice");
  });

  it("draws 可见范围 as a two-way segment with what the choice means", () => {
    const { screen, store, choice, draw } = render();
    const section = screen.querySelector<HTMLElement>(
      '[data-publish-option="visibility"]',
    )!;
    expect(section.getAttribute("data-editor-field")).toBe("visibility");
    expect(section.querySelector("h3")!.textContent).toBe("可见范围");
    const group = section.querySelector<HTMLElement>('[role="radiogroup"]')!;
    expect(names(group)).toEqual(["segment"]);
    expect(
      [...group.querySelectorAll('[role="radio"]')].map((entry) => [
        entry.textContent,
        entry.getAttribute("aria-checked"),
      ]),
    ).toEqual([
      ["公开", "true"],
      ["仅自己可见", "false"],
    ]);
    expect(names(choice("public"))).toEqual(["segmentButton"]);
    const description = () =>
      document.getElementById(group.getAttribute("aria-describedby")!)!;
    expect(description().textContent).toBe("允许其他人浏览");
    act(() => choice("self").click());
    expect(store.get().visibility).toBe("self");
    expect(description().textContent).toBe("只有你能看到");
    // The checked half pressed again stays chosen.
    act(() => choice("self").click());
    expect(store.get().visibility).toBe("self");
    draw();
  });

  it("keeps 发布 unavailable with its reason above it, nudges the reason on a press, and submits once the work can go", () => {
    const onSubmit = vi.fn();
    const publish = { label: "发布", busy: false, onSubmit };
    const { screen, store, footer, submit, draw } = render({ publish });
    expect(names(footer())).toContain("stepFooterStacked");
    expect(submit().textContent).toBe("发布");
    // Still focusable and named, so the reason can be heard on it.
    expect(submit().disabled).toBe(false);
    expect(submit().getAttribute("aria-disabled")).toBe("true");
    expect(names(submit())).toEqual(["primaryButton", "publishButton"]);
    const reason = () =>
      footer().querySelector<HTMLElement>("[data-publish-reason]")!;
    expect(reason().textContent).toBe("请填写标题并至少添加一张图片");
    expect(reason().getAttribute("data-publish-reason")).toBe("error");
    expect(names(reason())).toEqual(["reason"]);
    // Mockup A's row under the line: 预览, then 发布 taking the rest (no
    // 保存草稿 outside saved mode).
    const actions = reason().nextElementSibling!;
    expect(names(actions)).toEqual(["actions"]);
    // A `.pubActions`' 2px, over the editor's `.stepFooter > div` gap.
    expect(actions.hasAttribute("data-publish-actions")).toBe(true);
    expect(publishCss as string).toMatch(
      /\.actions\[data-publish-actions\] \{[^}]*gap: var\(--yoyi-space-1\);/u,
    );
    expect([...actions.children].map((child) => child.textContent)).toEqual([
      "预览",
      "发布",
    ]);
    expect(actions.lastElementChild).toBe(submit());
    expect(submit().getAttribute("aria-describedby")).toBe(reason().id);
    // Not a second live region: the sheet in the scroll area announces.
    expect(reason().hasAttribute("aria-live")).toBe(false);
    // The bar is the only 发布 on the screen, and the line is not repeated.
    expect(screen.querySelectorAll("[data-editor-submit]")).toHaveLength(1);
    expect(screen.querySelector("[data-editor-summary]")).toBe(null);
    expect(reason().hasAttribute("data-nudge")).toBe(false);
    const first = reason();
    act(() => submit().click());
    expect(onSubmit).not.toHaveBeenCalled();
    expect(reason().getAttribute("data-nudge")).toBe("true");
    // Each press restarts the shake on a fresh line with the same id.
    expect(reason()).not.toBe(first);
    expect(reason().id).toBe(first.id);
    act(() => {
      // React listens for the prefixed name where the engine lacks the plain one.
      for (const name of ["animationend", "webkitAnimationEnd"])
        reason().dispatchEvent(new Event(name, { bubbles: true }));
    });
    expect(reason().hasAttribute("data-nudge")).toBe(false);

    act(() => store.setTitle("临兰亭"));
    draw({ publish });
    expect(submit().getAttribute("aria-disabled")).toBe("true");
    expect(reason().textContent).toBe("请至少添加一张图片");
    act(() => submit().click());
    expect(onSubmit).not.toHaveBeenCalled();
    act(() => {
      for (const name of ["animationend", "webkitAnimationEnd"])
        reason().dispatchEvent(new Event(name, { bubbles: true }));
    });
    act(() =>
      store.setMedia({ items: [item("a")], coverKey: null, coverCrop: null }),
    );
    draw({
      publish,
      confirmation: { readiness: { ...ready, total: 1, ready: 1 } },
    });
    expect(submit().hasAttribute("aria-disabled")).toBe(false);
    expect(reason().textContent).toBe("全部 1 项已就绪");
    act(() => submit().click());
    expect(onSubmit).toHaveBeenCalledOnce();

    // Uploads still running: the readiness reason in the warning tone.
    act(() =>
      store.setMedia({ items: [item("a")], coverKey: null, coverCrop: null }),
    );
    const onResolveMedia = vi.fn();
    const blockedBy = {
      readiness: {
        ...ready,
        total: 1,
        blocking: 1,
        text: "1 项仍在上传",
        confirmed: false,
      },
    };
    draw({ publish, confirmation: blockedBy });
    expect(submit().getAttribute("aria-disabled")).toBe("true");
    expect(reason().textContent).toBe("1 项仍在上传。全部就绪或移除后才能发布");
    expect(reason().getAttribute("data-publish-reason")).toBe("blocking");
    expect(reason().getAttribute("data-blocking")).toBe("true");
    expect(reason().querySelector("[data-editor-resolve-media]")).toBe(null);
    // A photo needs the author: 前往处理 ends the line, not the sheet.
    draw({ publish, confirmation: { ...blockedBy, onResolveMedia } });
    const resolve = reason().querySelector<HTMLButtonElement>(
      "[data-editor-resolve-media]",
    )!;
    expect(resolve.textContent).toBe("前往处理");
    // Drawn small at the line's text height (no 32px minimum).
    expect(names(resolve)).toEqual(["inlineAction", "lineAction"]);
    expect(screen.querySelectorAll("[data-editor-resolve-media]")).toHaveLength(
      1,
    );
    act(() => resolve.click());
    expect(onResolveMedia).toHaveBeenCalledOnce();
    // The sheet still announces readiness, drawn by the line instead.
    expect(
      screen.querySelector(
        "[data-editor-confirmation] [data-editor-readiness]",
      )!.textContent,
    ).toBe("1 项仍在上传。全部就绪或移除后才能发布");

    // Submitting: the label stays, the line says what is happening, no nudge.
    draw({
      publish: { ...publish, busy: true },
      confirmation: { resolving: true },
    });
    expect(submit().textContent).toBe("发布");
    expect(submit().getAttribute("aria-disabled")).toBe("true");
    expect(submit().getAttribute("aria-busy")).toBe("true");
    expect(reason().textContent).toBe("正在发布…");
    expect(reason().getAttribute("data-publish-reason")).toBe("status");
    act(() => submit().click());
    expect(reason().hasAttribute("data-nudge")).toBe(false);
    expect(onSubmit).toHaveBeenCalledOnce();

    // The caller's own reason blocks it too.
    draw({ publish: { ...publish, disabled: true } });
    expect(submit().getAttribute("aria-disabled")).toBe("true");
    act(() => submit().click());
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("offers 预览 and 保存草稿 beside 发布, and says when every photo is ready", () => {
    const onOpenPreview = vi.fn();
    const saveAction = (
      <button data-editor-save-now="" type="button">
        保存草稿
      </button>
    );
    const { store, footer, submit, draw } = render({
      onOpenPreview,
      saveAction,
    });
    const actions = footer().querySelector("[data-publish-actions]")!;
    expect([...actions.children].map((child) => child.textContent)).toEqual([
      "预览",
      "保存草稿",
      "发布",
    ]);
    const preview = actions.querySelector<HTMLButtonElement>(
      "[data-editor-preview-open]",
    )!;
    expect(names(preview)).toEqual(["footAction"]);
    expect(names(actions.children[1]!)).toEqual(["footSave"]);
    act(() => preview.click());
    expect(onOpenPreview).toHaveBeenCalledExactlyOnceWith(preview);

    // Every photo ready: the line says so in the quiet tone, and 发布 goes.
    act(() => {
      store.setTitle("临兰亭");
      store.setMedia({ items: [item("a")], coverKey: null, coverCrop: null });
    });
    draw({
      onOpenPreview,
      saveAction,
      confirmation: { readiness: { ...ready, total: 1, ready: 1 } },
    });
    const line = footer().querySelector<HTMLElement>("[data-publish-reason]")!;
    expect(line.textContent).toBe("全部 1 项已就绪");
    expect(line.getAttribute("data-publish-reason")).toBe("ok");
    expect(submit().hasAttribute("aria-disabled")).toBe(false);
    expect(submit().getAttribute("aria-describedby")).toBe(line.id);
  });

  it("hides the bar while a text field has the keyboard, never for focus alone, with 完成 in its place", async () => {
    const { screen, footer, choice, input, keyboard } = render({
      menu: <button aria-label="更多操作" data-editor-menu="" type="button" />,
    });
    const title = input<HTMLInputElement>("title");
    const body = input<HTMLTextAreaElement>("body");
    const done = () =>
      screen.querySelector<HTMLButtonElement>("[data-publish-done]");
    const menu = () => screen.querySelector("[data-editor-menu]");
    expect(footer().hidden).toBe(false);
    // Focus with no on-screen keyboard (a hardware keyboard, or 标题
    // focused on the way in before the keyboard rises): the bar stays.
    act(() => title.focus());
    expect(footer().hidden).toBe(false);
    expect(done()).toBe(null);
    await keyboard(true);
    expect(footer().hidden).toBe(true);
    // 完成 replaces 更多操作 at the bar's end.
    expect(done()!.textContent).toBe("完成");
    expect(names(done()!)).toEqual(["done"]);
    expect(menu()).toBe(null);
    act(() => body.focus());
    expect(footer().hidden).toBe(true);
    // A chip, a segment or a button never brings up the keyboard.
    act(() => choice("original").focus());
    expect(footer().hidden).toBe(false);
    expect(done()).toBe(null);
    expect(menu()).not.toBe(null);
    act(() => title.focus());
    expect(footer().hidden).toBe(true);
    // The system Back dismissed the keyboard; focus stayed in 标题.
    await keyboard(false);
    expect(document.activeElement).toBe(title);
    expect(footer().hidden).toBe(false);
    await keyboard(true);
    expect(footer().hidden).toBe(true);
    // 完成 never takes focus on its press; its click closes the keyboard by
    // moving focus to the heading, and the bar comes back.
    const press = new Event("pointerdown", { bubbles: true, cancelable: true });
    act(() => done()!.dispatchEvent(press));
    expect(press.defaultPrevented).toBe(true);
    act(() => done()!.click());
    expect(document.activeElement).toBe(
      screen.querySelector("[data-editor-step-heading]"),
    );
    expect(footer().hidden).toBe(false);
    expect(done()).toBe(null);
  });

  it("shows the work as cards at the feed ratio that open 编辑 at a tapped photo", () => {
    expect(render().screen.querySelector("[data-publish-preview]")).toBe(null);

    const onOpenItem = vi.fn();
    const onActiveIndexChange = vi.fn();
    const { screen } = render({
      preview: {
        slides: [
          slide("a"),
          slide("b", {
            src: null,
            status: "loading",
            chip: {
              label: "上传中 42%",
              attention: false,
              glyph: { kind: "progress", percent: 42 },
            },
            statusText: "上传中 42%",
          }),
          slide("c", {
            chip: {
              label: "处理中",
              attention: false,
              glyph: { kind: "loading" },
            },
            statusText: "处理中",
          }),
          slide("d", {
            chip: { label: "处理失败", attention: true },
            statusText: "处理失败",
          }),
        ],
        total: 12,
        activeIndex: 0,
        onActiveIndexChange,
        onOpenItem,
      },
    });
    const strip = screen.querySelector<HTMLElement>("[data-publish-strip]")!;
    expect(names(strip)).toEqual(["strip"]);
    expect(strip.getAttribute("role")).toBe("group");
    expect(strip.getAttribute("aria-label")).toBe("动态预览");
    expect(strip.getAttribute("data-count")).toBe("4");
    // A 3:4 first image: the feed stage's 4:5 cap sets the ratio.
    expect(strip.style.getPropertyValue("--publish-stage-aspect")).toBe("1.25");
    const cards = [
      ...strip.querySelectorAll<HTMLButtonElement>("[data-publish-card]"),
    ];
    // Content order in the DOM; the strip reads right to left.
    expect(
      cards.map((card) => card.getAttribute("data-feed-slide-edit")),
    ).toEqual(["0", "1", "2", "3"]);
    expect(cards.map((card) => card.getAttribute("aria-label"))).toEqual([
      "编辑第 1 张，首图",
      "编辑第 2 张，上传中 42%",
      "编辑第 3 张，处理中",
      "编辑第 4 张，处理失败",
    ]);
    expect(cards.map((card) => card.type)).toEqual([
      "button",
      "button",
      "button",
      "button",
    ]);
    // 首图 as mockup A's 22px seal pill (`.firstBadge`).
    const badge = cards[0]!.querySelector("[aria-hidden] span")!;
    expect(badge.textContent).toBe("首图");
    expect(names(badge)).toEqual(["firstBadge"]);
    expect(
      cards.slice(1).map((card) => card.textContent!.includes("首图")),
    ).toEqual([false, false, false]);
    expect(cards[1]!.textContent).toContain("准备中");
    expect(cards[0]!.querySelector("[data-publish-chip]")).toBe(null);
    // Each chip is 选择照片's, led by a 14px glyph (mockup A `chipHtml`).
    const chipOf = (index: number) =>
      cards[index]!.querySelector<HTMLElement>("[data-publish-chip]")!;
    const glyphOf = (index: number) =>
      chipOf(index).querySelector<Element>("[data-publish-glyph]")!;
    expect([1, 2, 3].map((index) => names(chipOf(index)))).toEqual([
      ["tileChip"],
      ["tileChip"],
      ["tileChip"],
    ]);
    expect([1, 2, 3].map((index) => chipOf(index).textContent)).toEqual([
      "上传中 42%",
      "处理中",
      "处理失败",
    ]);
    expect(
      [1, 2, 3].map((index) =>
        glyphOf(index).getAttribute("data-publish-glyph"),
      ),
    ).toEqual(["progress", "loading", "error"]);
    for (const index of [1, 2, 3]) {
      expect(names(glyphOf(index))).toContain("chipGlyph");
      // The glyph comes first, the words after it.
      expect(chipOf(index).firstElementChild).toBe(glyphOf(index));
    }
    // 上传中: a ring of the upload's share, drawn from the top.
    const ring = glyphOf(1);
    expect(ring.tagName.toLowerCase()).toBe("svg");
    expect(ring.getAttribute("viewBox")).toBe("0 0 24 24");
    const [track, bar] = [...ring.querySelectorAll("circle")];
    expect(names(track!)).toEqual(["ringTrack"]);
    expect(names(bar!)).toEqual(["ringBar"]);
    const length = 2 * Math.PI * 9;
    expect(Number(bar!.getAttribute("stroke-dasharray"))).toBeCloseTo(length);
    expect(Number(bar!.getAttribute("stroke-dashoffset"))).toBeCloseTo(
      length * 0.58,
    );
    expect(bar!.getAttribute("transform")).toBe("rotate(-90 12 12)");
    // 处理中: the loading glyph (it turns, see the stylesheet); a failure:
    // the error glyph, also when the caller names no glyph.
    expect(glyphOf(2).getAttribute("data-icon")).toBe("loading");
    expect(glyphOf(3).getAttribute("data-icon")).toBe("error");
    expect(chipOf(3).getAttribute("data-attention")).toBe("true");
    expect(chipOf(2).hasAttribute("data-attention")).toBe(false);
    const caption = screen.querySelector("[data-feed-preview-caption]")!;
    expect(caption.textContent).toBe(
      "第 1 张在最右，向右滑看下一张；动态最多显示前 4 张，其余 8 张仅在作品页显示",
    );
    expect(strip.getAttribute("aria-describedby")).toBe(caption.id);
    // Every card opens 编辑, a placeholder too, and becomes the shown card,
    // so 发布 comes back at it.
    act(() => cards[1]!.click());
    expect(onActiveIndexChange).toHaveBeenCalledExactlyOnceWith(1);
    expect(onOpenItem).toHaveBeenCalledExactlyOnceWith(1);
    expect(onActiveIndexChange.mock.invocationCallOrder[0]).toBeLessThan(
      onOpenItem.mock.invocationCallOrder[0]!,
    );
    // The shown card itself has nothing new to report.
    act(() => cards[1]!.click());
    expect(onActiveIndexChange).toHaveBeenCalledOnce();
    expect(onOpenItem).toHaveBeenCalledTimes(2);
    // A picture that fails to load says so on its card.
    act(() => {
      cards[0]!.querySelector("img")!.dispatchEvent(new Event("error"));
    });
    expect(cards[0]!.querySelector("img")).toBe(null);
    expect(cards[0]!.textContent).toContain("图像无法加载");
    expect(cards[0]!.getAttribute("aria-label")).toBe(
      "编辑第 1 张，首图，图像无法加载",
    );
  });

  it("leads each status with mockup A's glyph: the ring, the turning loading glyph, the error glyph", () => {
    expect(
      publishChipGlyph({ kind: "uploading", label: "上传中 42%", percent: 42 }),
    ).toEqual({ kind: "progress", percent: 42 });
    expect(publishChipGlyph({ kind: "processing", label: "处理中" })).toEqual({
      kind: "loading",
    });
    expect(
      publishChipGlyph({
        kind: "failed",
        label: "上传失败",
        message: "网络中断",
        retry: null,
      }),
    ).toEqual({ kind: "error" });
    expect(
      publishChipGlyph({
        kind: "missing_local",
        label: "缺少文件",
        message: "找不到原文件",
      }),
    ).toEqual({ kind: "error" });
    // The quieter waits carry no glyph.
    for (const kind of ["queued", "preparing", "uploaded", "loading"] as const)
      expect(publishChipGlyph({ kind, label: "等待" })).toBe(null);

    const css = publishCss as string;
    expect(css).toMatch(
      /\.cardStatus \.chipGlyph \{\s*display: block;\s*width: 14px;\s*height: 14px;/u,
    );
    expect(css).toMatch(
      /\.cardStatus \.chipGlyph\[data-icon="loading"\] \{\s*animation-name: chip-turn;\s*animation-duration: var\(--yoyi-duration-loading-logo\);\s*animation-iteration-count: infinite;/u,
    );
    // No turning (or ring easing) under reduced motion.
    const reduced =
      /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*)\}\s*$/u.exec(
        css.trim(),
      )![1]!;
    expect(reduced).toMatch(
      /\.cardStatus \.chipGlyph\[data-icon="loading"\] \{\s*animation: none;/u,
    );
    expect(reduced).toMatch(/\.ringBar \{\s*transition: none;/u);
    // 首图 as A `.firstBadge`.
    expect(css).toMatch(
      /\.firstBadge \{[^}]*height: 22px;[^}]*color: var\(--yoyi-color-seal-red\);\s*background: var\(--yoyi-color-seal-red-muted\);\s*border-radius: var\(--yoyi-radius-full\);/u,
    );
  });

  it("puts a single card at the strip's start with its caption, and offers 添加照片 at the column's start when there are no photos", () => {
    const { screen } = render({
      preview: {
        slides: [slide("a")],
        total: 1,
        activeIndex: 0,
        onActiveIndexChange: () => undefined,
        onOpenItem: () => undefined,
      },
    });
    const strip = screen.querySelector("[data-publish-strip]")!;
    expect(strip.getAttribute("data-count")).toBe("1");
    const caption = screen.querySelector("[data-feed-preview-caption]")!;
    expect(caption.textContent).toBe("第 1 张在最右，向右滑看下一张");
    expect(strip.getAttribute("aria-describedby")).toBe(caption.id);
    expect(screen.querySelector("[data-publish-add]")).toBe(null);
    // One card keeps photo 1's place (mockup A `.hs`), never centred.
    expect(publishCss as string).not.toMatch(/data-count/u);

    const onBack = vi.fn();
    const empty = render({ onBack }).screen;
    const add = empty.querySelector<HTMLButtonElement>(
      "[data-publish-add] button",
    )!;
    expect(add.textContent).toBe("添加照片");
    expect(names(add)).toEqual(["addTile"]);
    expect(names(add.parentElement!)).toEqual(["addRow"]);
    // A `.textOnly`: the tile starts at the reading column's left edge.
    expect(publishCss as string).toMatch(
      /\.addRow \{\s*display: flex;\s*justify-content: flex-start;/u,
    );
    act(() => add.click());
    expect(onBack).toHaveBeenCalledOnce();

    // Photos without a preview yet: neither the strip nor 添加照片.
    const { screen: waiting, store, draw } = render();
    act(() =>
      store.setMedia({ items: [item("a")], coverKey: null, coverCrop: null }),
    );
    draw();
    expect(waiting.querySelector("[data-publish-add]")).toBe(null);
    expect(waiting.querySelector("[data-publish-strip]")).toBe(null);
  });
});

describe("PublishPreviewStrip", () => {
  const CARD = 260;
  const three = [slide("a"), slide("b"), slide("c")];

  /** The strip with cards CARD px wide and no gap (jsdom draws nothing). */
  const mount = (overrides: Partial<PublishPreview> = {}) => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        return {
          width: this.hasAttribute("data-publish-card") ? CARD : 0,
        } as DOMRect;
      },
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const props: PublishPreview = {
      slides: three,
      total: three.length,
      activeIndex: 0,
      onActiveIndexChange: vi.fn(),
      onOpenItem: vi.fn(),
      ...overrides,
    };
    const draw = (next: Partial<PublishPreview> = {}) =>
      act(() => root.render(<PublishPreviewStrip {...props} {...next} />));
    draw();
    const strip = container.querySelector<HTMLElement>("[data-publish-strip]")!;
    const scrollTo = vi.fn((options: ScrollToOptions) => {
      strip.scrollLeft = options.left ?? strip.scrollLeft;
    });
    Object.defineProperty(strip, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });
    const card = (index: number) =>
      strip.querySelector<HTMLButtonElement>(`[data-publish-card="${index}"]`)!;
    return { container, strip, scrollTo, draw, card, props };
  };

  it("opens at the owner's card, so returning from 编辑 at photo 3 shows photo 3", () => {
    const { strip } = mount({ activeIndex: 2 });
    // Right to left: the start is 0 and the end is negative.
    expect(strip.scrollLeft).toBe(-2 * CARD);
  });

  it("comes back at the card a tap opened in 编辑, without a swipe first", () => {
    const onActiveIndexChange = vi.fn();
    const onOpenItem = vi.fn();
    const { card, strip, scrollTo } = mount({
      onActiveIndexChange,
      onOpenItem,
    });
    // The peeking card 3, tapped without swiping to it.
    act(() => card(2).click());
    expect(onActiveIndexChange).toHaveBeenCalledExactlyOnceWith(2);
    expect(onOpenItem).toHaveBeenCalledExactlyOnceWith(2);
    // Reported, not scrolled: 编辑 takes the screen at once.
    expect(scrollTo).not.toHaveBeenCalled();
    expect(strip.scrollLeft).toBe(0);
    // Back from 编辑, the owner's index is that card.
    const back = mount({ activeIndex: 2 });
    expect(back.strip.scrollLeft).toBe(-2 * CARD);
  });

  it("follows the owner's index and honours reduced motion", () => {
    const { draw, scrollTo } = mount();
    draw({ activeIndex: 2 });
    expect(scrollTo).toHaveBeenLastCalledWith({
      left: -2 * CARD,
      behavior: "smooth",
    });
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })) as unknown as typeof window.matchMedia,
    );
    draw({ activeIndex: 1 });
    expect(scrollTo).toHaveBeenLastCalledWith({
      left: -CARD,
      behavior: "auto",
    });
  });

  it("reports the card a swipe settles on, the far end as the last card", () => {
    vi.useFakeTimers();
    const onActiveIndexChange = vi.fn();
    const { strip } = mount({ onActiveIndexChange });
    const settleAt = (offset: number) =>
      act(() => {
        strip.scrollLeft = -offset;
        strip.dispatchEvent(new Event("scroll"));
        vi.advanceTimersByTime(120);
      });
    settleAt(CARD + 20);
    expect(onActiveIndexChange).toHaveBeenLastCalledWith(1);
    settleAt(CARD - 20);
    expect(onActiveIndexChange).toHaveBeenCalledTimes(1);
    // Cards narrower than the strip cannot reach its start: the end is the last.
    Object.defineProperties(strip, {
      clientWidth: { configurable: true, get: () => 390 },
      scrollWidth: { configurable: true, get: () => 3 * CARD + 16 + 16 },
    });
    settleAt(3 * CARD + 32 - 390);
    expect(onActiveIndexChange).toHaveBeenLastCalledWith(2);
  });

  it("treats a tap that moved the strip as part of the swipe, never a keyboard press", () => {
    const onOpenItem = vi.fn();
    const { strip, card } = mount({ onOpenItem });
    const tap = (detail: number) =>
      act(() => {
        card(0).dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true, detail }),
        );
      });
    act(() => {
      strip.dispatchEvent(
        new TouchEvent("touchstart", {
          bubbles: true,
          touches: [{ identifier: 0 } as Touch],
        }),
      );
    });
    strip.scrollLeft = -40;
    act(() => {
      strip.dispatchEvent(new Event("scroll"));
    });
    tap(1);
    expect(onOpenItem).not.toHaveBeenCalled();
    tap(0);
    expect(onOpenItem).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("moves between cards with the arrow keys the way the strip reads", () => {
    const onActiveIndexChange = vi.fn();
    const { card, scrollTo } = mount({ onActiveIndexChange });
    const key = (value: string) =>
      act(() => {
        document.activeElement!.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: value,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    // Every card is in the tab order.
    expect([0, 1, 2].map((index) => card(index).tabIndex)).toEqual([0, 0, 0]);
    act(() => card(0).focus());
    key("ArrowLeft");
    expect(document.activeElement).toBe(card(1));
    expect(onActiveIndexChange).toHaveBeenLastCalledWith(1);
    expect(scrollTo).toHaveBeenLastCalledWith({
      left: -CARD,
      behavior: "smooth",
    });
    key("ArrowRight");
    expect(document.activeElement).toBe(card(0));
    expect(onActiveIndexChange).toHaveBeenLastCalledWith(0);
    key("End");
    expect(document.activeElement).toBe(card(2));
    expect(onActiveIndexChange).toHaveBeenLastCalledWith(2);
    key("ArrowLeft");
    expect(document.activeElement).toBe(card(2));
    key("Home");
    expect(document.activeElement).toBe(card(0));
    expect(onActiveIndexChange).toHaveBeenLastCalledWith(0);
    // At the last card, ArrowLeft stays put and reports nothing.
    expect(onActiveIndexChange).toHaveBeenCalledTimes(4);
  });

  // #341: 发布's cards, the desktop preview and the feed itself frame every
  // picture alike: the same fit, the author's region or the whole image.
  it("frames each picture exactly as the feed stage and the desktop preview do", () => {
    const tall = { width: 600, height: 1800 };
    const pictures: readonly {
      readonly size: { readonly width: number; readonly height: number };
      readonly feed?: MediaFeedFraming;
    }[] = [
      { size: tall, feed: { fit: "cover", y: 0 } },
      { size: { width: 800, height: 600 }, feed: { fit: "contain" } },
      { size: tall, feed: { fit: "contain" } },
      { size: tall, feed: { fit: "cover", y: 0.75 } },
      { size: tall, feed: { fit: "cover", y: 0.5 } },
      { size: tall },
    ];
    const slides = pictures.map(({ size, feed }, index) =>
      slide(`p${index}`, {
        size,
        placeholderColor: "#4a4038",
        ...(feed === undefined ? {} : { feed }),
      }),
    );
    const drawn = (nodes: NodeListOf<HTMLElement>) =>
      [...nodes].map((node) => [
        node.getAttribute("data-fit"),
        node.getAttribute("data-feed-framing"),
        node.style.getPropertyValue("--feed-slide-y"),
      ]);
    const { strip } = mount({ slides, total: slides.length });
    const cards = drawn(
      strip.querySelectorAll<HTMLElement>("[data-publish-card]"),
    );
    expect(cards).toEqual([
      ["cover", "region", "0%"],
      ["contain", null, ""],
      ["contain", "whole", ""],
      ["cover", "region", "75%"],
      ["cover", null, ""],
      ["cover", null, ""],
    ]);
    // A whole picture's blank sides stay the card's own (the feed's page).
    const tint = (index: number) =>
      strip.querySelector<HTMLElement>(`[data-publish-card="${index}"] img`)!
        .style.backgroundColor;
    expect([0, 1, 2].map(tint)).toEqual(["rgb(74, 64, 56)", "", ""]);

    const elsewhere = (node: ReactNode) => {
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      roots.push(root);
      act(() => root.render(node));
      return container;
    };
    const preview = elsewhere(
      <FeedStagePreview
        activeIndex={0}
        layout="desktop"
        onActiveIndexChange={vi.fn()}
        slides={slides}
        total={slides.length}
      />,
    );
    expect(
      drawn(preview.querySelectorAll<HTMLElement>("[data-feed-slide]")),
    ).toEqual(cards);
    const feed = elsewhere(
      <FeedPostStage
        burstEnabled={false}
        media={pictures.map(({ size, feed }, index) => ({
          id: `p${index}`,
          src: `/media/p${index}.webp`,
          alt: "临兰亭",
          ...size,
          ...(feed === undefined ? {} : { feed }),
        }))}
        onDoubleTap={vi.fn()}
        onOpenViewer={vi.fn()}
        viewerOpen={false}
      />,
    );
    expect(
      drawn(feed.querySelectorAll<HTMLElement>("[data-feed-slide]")),
    ).toEqual(cards);
  });

  it("rests on the nearest card, never past either end", () => {
    expect(stripCardIndex(0, 500, 268, 3)).toBe(0);
    expect(stripCardIndex(150, 500, 268, 3)).toBe(1);
    expect(stripCardIndex(499.5, 500, 268, 3)).toBe(2);
    expect(stripCardIndex(900, 0, 268, 3)).toBe(2);
    expect(stripCardIndex(100, 0, 0, 3)).toBe(0);
    expect(stripCardIndex(300, 600, 268, 1)).toBe(0);
  });
});

describe("publishReason", () => {
  const store = createEditorSessionStore(ACCOUNT, { type: "new" });
  store.setTitle("临兰亭");
  store.setMedia({ items: [item("a")], coverKey: null, coverCrop: null });
  const input: PublishReasonInput = {
    state: store.get(),
    readiness: ready,
    issues: [],
    submission: { status: "idle" },
  };

  it("requires a photo even with a title, and reports ready photos otherwise", () => {
    expect(
      publishReason(
        { ...input, state: { ...input.state, items: [] } },
        "发布",
        true,
      ),
    ).toEqual({ text: "请至少添加一张图片", tone: "error" });
    const withPhotos = {
      ...input,
      state: {
        ...input.state,
        items: [
          {
            key: "a",
            itemId: null,
            kind: "static",
            qualityMode: "standard",
            edit: { rotation: 0, crop: null },
          },
        ],
      },
      readiness: { ...ready, total: 1, ready: 1 },
    } satisfies PublishReasonInput;
    expect(publishReason(withPhotos, "发布", false)).toEqual({
      text: "全部 1 项已就绪",
      tone: "ok",
    });
  });

  it("puts the submission first, then the first blocking reason", () => {
    expect(
      publishReason(
        {
          ...input,
          submission: { status: "reconciling", requestId: "r" },
        },
        "发布",
        true,
      ),
    ).toEqual({ text: "正在确认结果…", tone: "status" });
    expect(
      publishReason(
        { ...input, state: { ...input.state, kind: "edit" }, resolving: true },
        "保存更新",
        true,
      ),
    ).toEqual({ text: "正在保存更新…", tone: "status" });
    expect(
      publishReason(
        {
          ...input,
          readiness: { ...ready, blocking: 2, text: "2 项正在处理" },
          submission: { status: "not_ready", itemKeys: ["a", "b"] },
        },
        "发布",
        true,
      ),
    ).toEqual({ text: "2 项正在处理，完成后可再发布", tone: "status" });
    expect(
      publishReason(
        {
          ...input,
          issues: [
            {
              field: "title",
              label: "标题",
              length: 120,
              maximum: 100,
              message: "标题最多 100 字",
            },
          ],
        },
        "发布",
        true,
      ),
    ).toEqual({ text: "标题最多 100 字", tone: "error" });
    expect(
      publishReason(
        {
          ...input,
          submission: {
            status: "unconfirmed",
            requestId: "r",
            message: "还没有收到结果",
          },
        },
        "发布",
        true,
      ),
    ).toEqual({ text: "还没有收到结果", tone: "error" });
    expect(
      publishReason(
        {
          ...input,
          state: { ...input.state, items: [item("a")] },
          readiness: { ...ready, total: 1, confirmed: false },
        },
        "发布",
        true,
      ),
    ).toEqual({ text: "正在确认图片状态…", tone: "pending" });
  });
});

describe("publish-screen.module.css", () => {
  const css = (publishCss as string).replace(/\/\*[\s\S]*?\*\//gu, "");
  const declarations = [...css.matchAll(/([a-z-]+)\s*:\s*([^;{}]+);/gu)].map(
    (match) => [match[1]!, match[2]!.replace(/\s+/gu, " ").trim()] as const,
  );

  it("takes every colour, type size, radius and timing from the tokens", () => {
    expect(declarations.length).toBeGreaterThan(0);
    for (const [property, value] of declarations) {
      expect(value).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/iu);
      expect(value).not.toMatch(/(^|[\s(])\d+(\.\d+)?m?s\b/u);
      if (/^(color|background|background-color|border-color)$/u.test(property))
        expect(value).toMatch(
          /^(var\(--yoyi-color-[a-z-]+\)|transparent|inherit)$/u,
        );
      if (property === "font-size")
        expect(value).toMatch(/^var\(--yoyi-type-[a-z-]+-size\)$/u);
      if (property === "border-radius")
        expect(value).toMatch(/^(var\(--yoyi-radius-[a-z]+\)|0)$/u);
      if (property === "transition" || property === "animation")
        expect(value).toMatch(
          /^(none|.* var\(--yoyi-duration-[a-z]+\) var\(--yoyi-easing-[a-z]+\))$/u,
        );
      // Spacing is a token; a literal size only inside a calc() that names it.
      if (/^(gap|margin|padding)/u.test(property))
        expect(value.replace(/calc\(.*\)/gu, "")).not.toMatch(
          /(^|[\s(])\d+(\.\d+)?px/u,
        );
    }
  });

  // #341: a contained picture's blank margins read as the feed's.
  it("draws a card on the feed stage's page background, its placeholders muted and a cover at the author's region", () => {
    expect(css).toMatch(
      /\n\.card \{[^}]*background: var\(--yoyi-color-background-page\);/u,
    );
    expect(css).toMatch(
      /\n\.cardPlaceholder \{[^}]*background: var\(--yoyi-color-background-muted\);/u,
    );
    expect(css).toMatch(
      /\n\.card\[data-fit="cover"\] \.cardImage \{\s*object-fit: cover;\s*object-position: 50% var\(--feed-slide-y, 50%\);\s*\}/u,
    );
  });

  it("uses literal px only for the sizes without a token", () => {
    const pixels = new Set(
      declarations.flatMap(
        ([, value]) => value.match(/-?\d+(\.\d+)?px/gu) ?? [],
      ),
    );
    for (const px of pixels)
      expect([
        "1px",
        "-1px",
        "2px",
        "-2px",
        "3px",
        "-3px",
        "14px",
        "22px",
        "24px",
        "36px",
        "38px",
        "44px",
        "52px",
        "96px",
        "120px",
        "320px",
      ]).toContain(px);
  });
});

describe("editor.module.css on the phone's 发布", () => {
  /** The stylesheet without comments, every run of white space one space. */
  const css = (editorCss as string)
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/\s+/gu, " ");
  const rule = (selector: string) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    return new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, "u").exec(
      css,
    )?.[1];
  };

  it("marks unsaved changes in the warning colour after a 6px dot, on 发布 only", () => {
    expect(
      rule(
        '[data-editor-screen="publish"] .saveStatus[data-save-status="pending"]',
      ),
    ).toMatch(/^\s*color: var\(--yoyi-color-warning\);\s*$/u);
    const dot = rule(
      '[data-editor-screen="publish"] .saveStatus[data-save-status="pending"]::before',
    )!;
    expect(dot).toMatch(/width: 6px;\s*height: 6px;/u);
    expect(dot).toMatch(/background: currentColor;/u);
    expect(dot).toMatch(/border-radius: var\(--yoyi-radius-full\);/u);
    // The shared line (the desktop bar's) stays secondary.
    expect(rule(".saveStatus")).toMatch(
      /color: var\(--yoyi-color-text-secondary\);/u,
    );
    expect(css).not.toMatch(
      /(?:^|\})\s*\.saveStatus\[data-save-status="pending"\]/u,
    );
  });

  it("draws ≡ 更多操作's menu as mockup A's: no outline, 168px wide, 44px rows", () => {
    const menu = rule('[data-editor-screen="publish"] .menu')!;
    expect(menu).toMatch(/min-width: 168px;/u);
    expect(menu).toMatch(/border: 0;/u);
    expect(menu).toMatch(
      /padding: calc\(var\(--yoyi-space-1\) \+ var\(--yoyi-space-2\)\);/u,
    );
    // The panel itself: elevated, large radius, the dialog shadow.
    const shared = rule(".menu")!;
    expect(shared).toMatch(
      /background: var\(--yoyi-color-background-elevated\);/u,
    );
    expect(shared).toMatch(/border-radius: var\(--yoyi-radius-lg\);/u);
    expect(shared).toMatch(/box-shadow: var\(--yoyi-shadow-dialog\);/u);
    expect(rule(".bar .menu button, .menu button")).toMatch(
      /min-height: 44px;/u,
    );
    expect(rule('[data-editor-screen="publish"] .menu button:active')).toMatch(
      /background: var\(--yoyi-color-background-muted\);/u,
    );
    // The desktop menu keeps its outline.
    expect(shared).toMatch(
      /border: 1px solid var\(--yoyi-color-border-subtle\);/u,
    );
  });
});
