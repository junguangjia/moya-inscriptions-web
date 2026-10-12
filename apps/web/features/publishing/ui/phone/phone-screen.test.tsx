// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import hostStyles from "../../publishing-entry.module.css";
import { PhoneBarCaption, PhoneNextButton, PhoneScreen } from "./phone-screen";
import phoneStyles from "./phone-screen.module.css";
// @ts-expect-error -- Vite serves the stylesheet's own text for a ?raw import.
import phoneCss from "./phone-screen.module.css?raw";

import type { PhoneScreenProps } from "./phone-screen";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** CSS module class names without the test build's `_name_hash` wrapping. */
const names = (element: Element) =>
  [...element.classList].map((name) =>
    name.replace(/^_(.+)_[0-9a-f]+$/u, "$1"),
  );
const byClass = (root: ParentNode, name: string) =>
  [...root.querySelectorAll("*")].find((element) =>
    names(element).includes(name),
  ) ?? null;

/** The stylesheet without comments, its whitespace collapsed. */
const css = (phoneCss as string)
  .replace(/\/\*[\s\S]*?\*\//gu, "")
  .replace(/\s+/gu, " ");
/** The declarations of the rule whose selector list is exactly `selector`. */
const rule = (selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(
    `(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`,
    "u",
  ).exec(css);
  return match === null ? null : match[1]!.trim();
};

const roots: Root[] = [];
const mount = (node: ReactNode) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(node));
  return container;
};
const render = (overrides: Partial<PhoneScreenProps> = {}) => {
  const props: PhoneScreenProps = {
    screen: "select",
    title: "发布作品",
    backLabel: "返回",
    onBack: vi.fn(),
    children: <p data-screen-body="">内容</p>,
    ...overrides,
  };
  const container = mount(<PhoneScreen {...props} />);
  const screen = container.firstElementChild as HTMLElement;
  const bar = screen.querySelector<HTMLElement>("[data-editor-bar]")!;
  const scroller = screen.querySelector<HTMLElement>("[data-editor-scroller]");
  return { container, screen, bar, scroller, props };
};

const scrollTo = (scroller: HTMLElement, top: number) =>
  act(() => {
    scroller.scrollTop = top;
    scroller.dispatchEvent(new Event("scroll"));
  });

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

describe("PhoneScreen", () => {
  it("names the screen and draws its own bar with an icon-only Back", () => {
    const onBack = vi.fn();
    const backButtonRef = createRef<HTMLButtonElement>();
    const { screen, bar } = render({
      screen: "edit",
      backLabel: "返回选择照片",
      onBack,
      backButtonRef,
    });
    expect(screen.getAttribute("data-editor-layout")).toBe("phone");
    expect(screen.getAttribute("data-editor-screen")).toBe("edit");
    expect(names(screen)).toEqual(["phone", "screen"]);
    expect(bar.tagName).toBe("HEADER");
    // `.detailHeader` (44px icon targets) and the editor's `.bar` (text
    // actions, menus) stay; the phone bar replaces the host bar's padding.
    expect(names(bar)).toEqual(["detailHeader", "bar", "bar"]);
    expect(bar.classList.contains(phoneStyles.bar!)).toBe(true);
    expect(bar.classList.contains(hostStyles.bar!)).toBe(false);
    expect(bar.firstElementChild).toBe(backButtonRef.current);
    const back = backButtonRef.current!;
    expect(back.type).toBe("button");
    expect(back.getAttribute("aria-label")).toBe("返回选择照片");
    expect(back.textContent).toBe("");
    expect(
      back.querySelector('[data-icon="back"]')!.getAttribute("aria-hidden"),
    ).toBe("true");
    act(() => back.click());
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("leaves Back plain unless it is held", () => {
    const { bar } = render();
    const back = bar.querySelector<HTMLButtonElement>("button")!;
    expect(back.hasAttribute("aria-disabled")).toBe(false);
    expect(back.disabled).toBe(false);
  });

  it("holds Back while the screen says so: aria-disabled, focus kept, the click does nothing", () => {
    const onBack = vi.fn();
    const backButtonRef = createRef<HTMLButtonElement>();
    const { container, props } = render({
      backHeld: true,
      onBack,
      backButtonRef,
    });
    const back = backButtonRef.current!;
    expect(back.getAttribute("aria-disabled")).toBe("true");
    // Not `disabled`: it stays in the tab order and keeps focus.
    expect(back.disabled).toBe(false);
    act(() => back.focus({ preventScroll: true }));
    act(() => back.click());
    expect(onBack).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(back);

    // Released (专题 ended): Back works again on the same button.
    act(() => {
      roots
        .at(-1)!
        .render(
          <PhoneScreen
            {...props}
            backButtonRef={backButtonRef}
            backHeld={false}
          />,
        );
    });
    expect(container.querySelector("button")).toBe(back);
    expect(back.hasAttribute("aria-disabled")).toBe(false);
    act(() => back.click());
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("draws the bar both mockups share: 52px, no permanent border, B's gap or A's on 发布", () => {
    const bar = rule(".screen > .bar")!;
    expect(bar).toContain("position: relative;");
    expect(bar).toContain("min-height: calc(52px + env(safe-area-inset-top));");
    expect(bar).toContain("gap: var(--yoyi-space-2);");
    expect(bar).toContain(
      "padding: calc(var(--yoyi-space-2) + env(safe-area-inset-top)) max(var(--yoyi-space-4), env(safe-area-inset-right)) var(--yoyi-space-2) max(var(--yoyi-space-2), env(safe-area-inset-left));",
    );
    expect(bar).toContain("border-bottom: 0;");
    expect(rule('.screen[data-editor-screen="publish"] > .bar')).toBe(
      "gap: var(--yoyi-space-3);",
    );
    expect(
      rule(
        ".screen > .bar > button:active:not(:disabled), .screen > .bar > :last-child > button:active:not(:disabled)",
      ),
    ).toBe("background: var(--yoyi-color-background-muted);");
    // The screen is the positioning box of its toasts and sheets.
    expect(rule(".screen")).toBe("position: relative; isolation: isolate;");
  });

  it("makes the title the focusable step heading, start-aligned in the title block", () => {
    const { bar } = render({ title: "编辑作品" });
    const heading = bar.querySelector<HTMLElement>("h2")!;
    expect(heading.textContent).toBe("编辑作品");
    expect(heading.tabIndex).toBe(-1);
    expect(heading.hasAttribute("data-editor-step-heading")).toBe(true);
    expect(names(heading)).toEqual(["heading"]);
    expect(names(heading.parentElement!)).toEqual(["barTitle"]);
    act(() => heading.focus({ preventScroll: true }));
    expect(document.activeElement).toBe(heading);
  });

  it("draws a counter title with steady digits and reads its label instead", () => {
    const { bar } = render({
      screen: "edit",
      title: "3 / 6",
      titleLabel: "第 3 项，共 6 项",
    });
    const heading = bar.querySelector("h2")!;
    const [counter, label] = [...heading.children] as HTMLElement[];
    expect(counter!.textContent).toBe("3 / 6");
    expect(counter!.getAttribute("aria-hidden")).toBe("true");
    expect(names(counter!)).toEqual(["barCounter"]);
    expect(label!.textContent).toBe("第 3 项，共 6 项");
    expect(names(label!)).toEqual(["visuallyHidden"]);
    expect(rule(".barCounter")).toBe(
      "font-variant-numeric: tabular-nums; letter-spacing: 0.02em;",
    );
  });

  it("puts a string second line in the bar caption and draws a node as given", () => {
    const caption = byClass(
      render({ secondLine: "选择照片 · 已选 3 项 · 最多 50 项" }).bar,
      "caption",
    )!;
    expect(caption.tagName).toBe("SPAN");
    expect(caption.textContent).toBe("选择照片 · 已选 3 项 · 最多 50 项");
    expect(caption.previousElementSibling!.tagName).toBe("H2");
    expect(rule(".caption")).toContain(
      "color: var(--yoyi-color-text-secondary);",
    );
    expect(rule(".caption")).toContain("text-overflow: ellipsis;");

    // A screen draws the caption itself to carry a hook.
    const hooked = render({
      secondLine: (
        <PhoneBarCaption data-select-count="">
          至少选择 1 张照片才能下一步
        </PhoneBarCaption>
      ),
    }).bar.querySelector("[data-select-count]")!;
    expect(names(hooked)).toEqual(["caption"]);
    expect(hooked.textContent).toBe("至少选择 1 张照片才能下一步");

    const status = render({
      secondLine: <span data-save-status="error">保存失败</span>,
    }).bar;
    expect(byClass(status, "caption")).toBe(null);
    const saved = status.querySelector("[data-save-status]")!;
    expect(saved.textContent).toBe("保存失败");
    expect(names(saved.parentElement!)).toEqual(["barTitle"]);

    expect(byClass(render().bar, "barTitle")!.children).toHaveLength(1);
    expect(
      byClass(render({ secondLine: "" }).bar, "barTitle")!.children,
    ).toHaveLength(1);
  });

  it("keeps the bar balanced without an action and holds one when given", () => {
    const empty = byClass(render().bar, "barActions")!;
    expect(empty.children).toHaveLength(1);
    expect(names(empty.firstElementChild!)).toEqual(["balance"]);
    expect(empty.firstElementChild!.getAttribute("aria-hidden")).toBe("true");
    // A condition that leaves `false` behind still balances the bar.
    expect(byClass(render({ action: false }).bar, "balance")).not.toBe(null);

    const next = render({
      action: (
        <button disabled type="button">
          下一步
        </button>
      ),
    }).bar;
    expect(byClass(next, "balance")).toBe(null);
    const action = next.querySelectorAll("button")[1]!;
    expect(action.textContent).toBe("下一步");
    expect(names(action.parentElement!)).toEqual(["barActions"]);
    expect(next.lastElementChild).toBe(action.parentElement);
  });

  it("draws the hairline once the content scrolls under the bar", () => {
    const { bar, scroller } = render();
    expect(bar.getAttribute("data-bar-line")).toBe("scrolled");
    expect(bar.getAttribute("data-scrolled")).toBe("false");
    scrollTo(scroller!, 2);
    expect(bar.getAttribute("data-scrolled")).toBe("false");
    scrollTo(scroller!, 3);
    expect(bar.getAttribute("data-scrolled")).toBe("true");
    scrollTo(scroller!, 0);
    expect(bar.getAttribute("data-scrolled")).toBe("false");

    // The edge-to-edge scroller is followed the same way.
    const bleed = render({ scroll: "bleed" });
    expect(bleed.bar.getAttribute("data-bar-line")).toBe("scrolled");
    scrollTo(bleed.scroller!, 40);
    expect(bleed.bar.getAttribute("data-scrolled")).toBe("true");

    // No scroller (the edit stage draws its own edge): no hairline.
    const fixed = render({ scroll: false, children: <div /> }).bar;
    expect(fixed.getAttribute("data-bar-line")).toBe("none");
    expect(fixed.hasAttribute("data-scrolled")).toBe(false);

    const always = render({ barLine: "always" });
    expect(always.bar.getAttribute("data-bar-line")).toBe("always");
    scrollTo(always.scroller!, 40);
    expect(always.bar.hasAttribute("data-scrolled")).toBe(false);
    expect(render({ barLine: "none" }).bar.getAttribute("data-bar-line")).toBe(
      "none",
    );

    const line = rule(".screen > .bar::after")!;
    expect(line).toContain("bottom: 0;");
    expect(line).toContain("height: 1px;");
    expect(line).toContain("background: var(--yoyi-color-border-subtle);");
    expect(line).toContain("opacity: 0;");
    expect(line).toContain(
      "transition: opacity var(--yoyi-duration-fast) var(--yoyi-easing-standard);",
    );
    expect(
      rule(
        '.screen > .bar[data-bar-line="always"]::after, .screen > .bar[data-scrolled="true"]::after',
      ),
    ).toBe("opacity: 1;");
  });

  it("scrolls the reading column, an edge-to-edge body, or none", () => {
    const scrollerRef = createRef<HTMLDivElement>();
    const column = render({ scrollerRef, contentClassName: "content" });
    const body = column.screen.querySelector("[data-screen-body]")!;
    expect(names(body.parentElement!)).toEqual(["stepContent", "content"]);
    expect(body.parentElement!.parentElement).toBe(column.scroller);
    expect(names(column.scroller!)).toEqual(["stepScroller", "scroller"]);
    expect(column.scroller!.parentElement).toBe(column.screen);
    expect(scrollerRef.current).toBe(column.scroller);
    expect(rule(".scroller")).toBe(
      "overflow-x: hidden; scrollbar-width: none;",
    );

    const attached = vi.fn();
    const bleed = render({
      scroll: "bleed",
      scrollerRef: attached,
      children: <div data-media-picker="" />,
    });
    const picker = bleed.screen.querySelector("[data-media-picker]")!;
    expect(picker.parentElement).toBe(bleed.scroller);
    expect(byClass(bleed.screen, "stepContent")).toBe(null);
    expect(attached).toHaveBeenCalledWith(bleed.scroller);

    const fixed = render({
      scroll: false,
      children: <div data-edit-body="" />,
    }).screen;
    expect(fixed.querySelector("[data-editor-scroller]")).toBe(null);
    expect(byClass(fixed, "stepScroller")).toBe(null);
    expect(fixed.querySelector("[data-edit-body]")!.parentElement).toBe(fixed);
    expect(fixed.lastElementChild!.hasAttribute("data-edit-body")).toBe(true);
  });

  it("pins the bottom bar after the body, hides it at once and lays it out per screen", () => {
    expect(render().screen.querySelector("[data-editor-footer]")).toBe(null);

    const shown = render({ footer: <p>长按拖动可排序</p> }).screen;
    const footer = shown.querySelector<HTMLElement>("[data-editor-footer]")!;
    expect(shown.lastElementChild).toBe(footer);
    expect(names(footer)).toEqual(["stepFooter", "footer"]);
    expect(footer.hidden).toBe(false);
    expect(footer.textContent).toBe("长按拖动可排序");

    const typing = render({ footer: <p />, footerHidden: true }).screen;
    expect(
      typing.querySelector<HTMLElement>("[data-editor-footer]")!.hidden,
    ).toBe(true);

    const footerOf = (overrides: Partial<PhoneScreenProps>) =>
      names(
        render({
          footer: <button type="button" />,
          ...overrides,
        }).screen.querySelector("[data-editor-footer]")!,
      );
    expect(footerOf({ screen: "publish", footerStacked: true })).toEqual([
      "stepFooter",
      "footer",
      "stepFooterStacked",
    ]);
    expect(footerOf({ footerLayout: "stacked" })).toEqual([
      "stepFooter",
      "footer",
      "stepFooterStacked",
    ]);
    expect(footerOf({ footerLayout: "toolbar" })).toEqual([
      "footer",
      "toolbar",
    ]);
    expect(footerOf({ footerLayout: "spread", footerStacked: true })).toEqual([
      "stepFooter",
      "footer",
    ]);

    // `.stepFooter` and `.toolbar` set a display; only the attribute rule hides the bar.
    expect(rule(".footer[hidden]")).toBe("display: none;");
    // B's 选择照片 bar: a packed row, narrow start inset, top hairline.
    const toolbar = rule(".toolbar")!;
    expect(toolbar).toContain("display: flex;");
    expect(toolbar).toContain("gap: var(--yoyi-space-3);");
    expect(toolbar).toContain(
      "padding: var(--yoyi-space-3) max(var(--yoyi-space-5), env(safe-area-inset-right)) calc(var(--yoyi-space-3) + var(--editor-bottom-safe-area)) max(var(--yoyi-space-2), env(safe-area-inset-left));",
    );
    expect(toolbar).toContain(
      "border-top: 1px solid var(--yoyi-color-border-subtle);",
    );
    expect(toolbar).not.toContain("justify-content");
    // A's 发布 bar: reason over one full-width button, no hairline.
    expect(rule(".footer.stepFooterStacked")).toBe(
      "flex-direction: column; align-items: stretch; gap: var(--yoyi-space-3); padding-bottom: max(var(--yoyi-space-3), var(--editor-bottom-safe-area)); border-top: 0;",
    );
  });

  it("draws the screen's own layers last, over the bars", () => {
    const { screen } = render({
      footer: <p />,
      overlay: (
        <>
          <div data-toast-host="" />
          <div data-sheet-host="" />
        </>
      ),
    });
    const [toasts, sheets] = [...screen.children].slice(-2);
    expect(toasts!.hasAttribute("data-toast-host")).toBe(true);
    expect(sheets!.hasAttribute("data-sheet-host")).toBe(true);
    expect(sheets!.previousElementSibling).toBe(toasts);
    expect(
      toasts!.previousElementSibling!.hasAttribute("data-editor-footer"),
    ).toBe(true);
  });

  it("draws 下一步 as B's bolder outlined button and passes its hooks", () => {
    const onClick = vi.fn();
    const container = mount(
      <>
        <PhoneNextButton data-edit-next="" onClick={onClick} />
        <PhoneNextButton data-select-next="" disabled />
      </>,
    );
    const [next, blocked] = [
      ...container.querySelectorAll("button"),
    ] as HTMLButtonElement[];
    expect(next!.type).toBe("button");
    expect(next!.textContent).toBe("下一步");
    expect(names(next!)).toEqual(["textButton", "next"]);
    expect(next!.hasAttribute("data-edit-next")).toBe(true);
    act(() => next!.click());
    expect(onClick).toHaveBeenCalledOnce();
    expect(blocked!.disabled).toBe(true);
    expect(blocked!.hasAttribute("data-select-next")).toBe(true);
    expect(rule(".screen button.next")).toBe(
      "padding: 0 var(--yoyi-space-6); font-weight: 650; transition: background-color var(--yoyi-duration-fast) var(--yoyi-easing-standard);",
    );
    expect(rule(".screen button.next:active:not(:disabled)")).toBe(
      "background: var(--yoyi-color-background-muted);",
    );
  });

  it("declares only tokens, the safe-area insets and shape values", () => {
    const values = [...css.matchAll(/:\s*([^;{}]+);/gu)].map((match) =>
      match[1]!.trim(),
    );
    expect(values.length).toBeGreaterThan(40);
    const shapes = new Set([
      "0",
      "1",
      "6",
      "1px",
      "2px",
      "52px",
      "0.02em",
      "1.35",
      "600",
      "650",
      "100%",
      '""',
      "auto",
      "absolute",
      "relative",
      "isolate",
      "block",
      "flex",
      "column",
      "center",
      "stretch",
      "none",
      "hidden",
      "solid",
      "ellipsis",
      "nowrap",
      "tabular-nums",
      "opacity",
      "background-color",
      "calc",
      "max",
      // Touch screens drop the inherited hover tint (no sticky grey circle).
      "transparent",
    ]);
    for (const value of values) {
      const rest = value
        .replace(/var\(--(?:yoyi-[a-z0-9-]+|editor-bottom-safe-area)\)/gu, " ")
        .replace(/env\(safe-area-inset-(?:top|right|bottom|left)\)/gu, " ")
        .split(/[\s(),+]+/u)
        .filter((part) => part !== "");
      for (const part of rest) expect(shapes, `${value}`).toContain(part);
    }
  });
});
