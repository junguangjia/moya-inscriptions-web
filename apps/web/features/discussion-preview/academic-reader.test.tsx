// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcademicReader, academicViewFromSpecial } from "./academic-reader";
import { previewSpecials } from "./preview-data";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let node: HTMLDivElement;
let root: Root;
let reducedMotion = false;
const scrollTo = vi.fn();
const reader = () =>
  node.querySelector<HTMLElement>(
    "[data-test-reading-panel], [data-academic-scroll]",
  )!;
const rail = () => node.querySelector<HTMLElement>("[data-academic-rail]")!;
const preview = () =>
  node.querySelector<HTMLElement>("[data-academic-rail-preview]");
const bounds = (left: number, top: number, width: number, height: number) =>
  ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  }) as DOMRect;

const scroll = async (top: number) =>
  act(async () => {
    reader().scrollTop = top;
    reader().dispatchEvent(new Event("scroll", { bubbles: true }));
  });

const pointer = async (
  type: string,
  x: number,
  y: number,
  id = 1,
  target: HTMLElement = rail(),
) =>
  act(async () => {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button: 0,
    });
    Object.defineProperties(event, {
      pointerId: { value: id },
      isPrimary: { value: true },
      pointerType: { value: "touch" },
    });
    target.dispatchEvent(event);
  });

function EmbeddedReader({ active = true }: { active?: boolean }) {
  const [owner, setOwner] = useState<HTMLDivElement | null>(null);
  const [outlet, setOutlet] = useState<HTMLDivElement | null>(null);
  return (
    <>
      <div ref={setOwner} data-test-reading-panel="">
        <AcademicReader
          article={academicViewFromSpecial(previewSpecials[0]!)}
          scrollElement={owner}
          active={active}
          railPortalTarget={outlet}
        />
        <div data-test-inline-comments="">Inline comments</div>
      </div>
      <div ref={setOutlet} data-test-rail-outlet="" />
    </>
  );
}

beforeEach(async () => {
  reducedMotion = false;
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: reducedMotion })),
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (
        this.hasAttribute("data-academic-scroll") ||
        this.hasAttribute("data-test-reading-panel")
      )
        return bounds(0, 0, 390, 600);
      if (this.hasAttribute("data-academic-rail"))
        return bounds(326, 228, 64, 144);
      const top =
        node.querySelector<HTMLElement>(
          "[data-test-reading-panel], [data-academic-scroll]",
        )?.scrollTop ?? 0;
      if (this.tagName === "ARTICLE") return bounds(20, -top, 322, 3600);
      if (this.hasAttribute("data-academic-body"))
        return bounds(20, 1000 - top, 322, 2400);
      if (this.hasAttribute("data-academic-chapter"))
        return bounds(
          20,
          1000 + Number(this.dataset.academicChapter) * 400 - top,
          322,
          400,
        );
      return bounds(0, 0, 0, 0);
    },
  );
  scrollTo.mockReset();
  scrollTo.mockImplementation(function (
    this: HTMLElement,
    options: ScrollToOptions,
  ) {
    this.scrollTop = options.top ?? 0;
    this.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  vi.stubGlobal("ResizeObserver", undefined);
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () =>
    root.render(
      <AcademicReader article={academicViewFromSpecial(previewSpecials[0]!)} />,
    ),
  );
  reader().scrollTo = scrollTo;
});

afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AcademicReader", () => {
  it.each([
    ["special-album", "册页作为连续的观看对象"],
    ["special-trace", "残损材料与研究问题的边界"],
    ["special-landscape", "文字如何进入山水空间"],
  ])("renders distinct full article copy for %s", async (id, firstHeading) => {
    const special = previewSpecials.find((entry) => entry.id === id)!;
    await act(async () =>
      root.render(
        <AcademicReader article={academicViewFromSpecial(special)} />,
      ),
    );
    expect(node.querySelectorAll("[data-academic-chapter]")).toHaveLength(6);
    expect(node.querySelector("[data-academic-chapter] h3")?.textContent).toBe(
      firstHeading,
    );
    expect(
      node.querySelector("[data-academic-citation]")?.textContent,
    ).toContain(special.title);
  });

  it("replaces the inline directory with the rail in the body and restores it above the body", async () => {
    expect(node.querySelectorAll("[data-academic-chapter]")).toHaveLength(6);
    expect(
      node.querySelector("[data-academic-citation]")?.textContent,
    ).toContain("前端示例版");
    expect(
      node.querySelector("[data-academic-toc]")?.getAttribute("data-collapsed"),
    ).toBe("false");
    expect(rail()).toBeNull();
    await scroll(1200);
    expect(rail()).not.toBeNull();
    expect(
      node.querySelector("[data-academic-toc]")?.getAttribute("aria-hidden"),
    ).toBe("true");
    await scroll(800);
    expect(rail()).toBeNull();
    expect(
      node.querySelector("[data-academic-toc]")?.getAttribute("data-collapsed"),
    ).toBe("false");
    expect(reader().scrollTop).toBe(800);
  });

  it("previews during a scrub and jumps only when released inside the rail", async () => {
    await scroll(1200);
    await pointer("pointerdown", 374, 240);
    await pointer("pointermove", 374, 288);
    expect(preview()?.textContent).toContain("从原石到纸");
    expect(scrollTo).not.toHaveBeenCalled();
    await pointer("pointerup", 374, 288);
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({
      top: 1800,
      behavior: "smooth",
    });
    expect(preview()).toBeNull();
    expect(rail().getAttribute("data-active-chapter")).toBe("2");
  });

  it.each([0, 1, 2, 3, 4, 5])(
    "starts previewing immediately from chapter dot %i before any movement",
    async (index) => {
      await scroll(1800);
      const dot = rail().querySelector<HTMLElement>(
        `[data-academic-rail-index="${index}"] > span`,
      )!;
      const y = 240 + index * 24;
      await pointer("pointerdown", 374, y, 1, dot);
      expect(rail().getAttribute("data-preview-chapter")).toBe(String(index));
      expect(
        rail()
          .querySelector(`[data-academic-rail-label="${index}"]`)
          ?.getAttribute("data-visible"),
      ).toBe("true");
      expect(scrollTo).not.toHaveBeenCalled();
      await pointer("pointerup", 374, y);
      expect(scrollTo).toHaveBeenCalledExactlyOnceWith({
        top: 1000 + index * 400,
        behavior: "smooth",
      });
    },
  );

  it.each([
    [327, 252, 1],
    [359, 229, 0],
    [360, 252, 1],
    [389, 300, 3],
    [389, 371, 5],
  ])(
    "starts previewing from rail background at (%i, %i)",
    async (x, y, index) => {
      await scroll(1800);
      await pointer("pointerdown", x, y);
      expect(rail().getAttribute("data-preview-chapter")).toBe(String(index));
      expect(preview()).not.toBeNull();
      expect(scrollTo).not.toHaveBeenCalled();
      await pointer("pointermove", 325, y);
      expect(preview()).toBeNull();
      await pointer("pointerup", x, y);
      expect(scrollTo).not.toHaveBeenCalled();
    },
  );

  it("ignores another pointer leaving during a primary scrub", async () => {
    await scroll(1200);
    await pointer("pointerdown", 374, 240, 1);
    await pointer("pointermove", 374, 288, 1);
    await pointer("pointerout", 340, 240, 2);
    expect(preview()).not.toBeNull();
    await pointer("pointerup", 374, 288, 1);
    expect(scrollTo).toHaveBeenCalledOnce();
  });

  it("cancels when leaving the rail, including a later re-entry before release", async () => {
    await scroll(1200);
    await pointer("pointerdown", 374, 240);
    await pointer("pointermove", 320, 288);
    expect(preview()).toBeNull();
    await pointer("pointermove", 374, 312);
    await pointer("pointerup", 374, 312);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(reader().scrollTop).toBe(1200);
  });

  it("does not jump on pointer cancellation or an outside release", async () => {
    await scroll(1200);
    await pointer("pointerdown", 374, 240);
    await pointer("pointercancel", 374, 288);
    await pointer("pointerup", 374, 288);
    expect(scrollTo).not.toHaveBeenCalled();
    await pointer("pointerdown", 374, 240);
    await pointer("pointerup", 320, 288);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(preview()).toBeNull();
  });

  it("supports keyboard navigation and honors reduced motion when activating a chapter", async () => {
    reducedMotion = true;
    await scroll(1200);
    const buttons = rail().querySelectorAll<HTMLButtonElement>("button");
    await act(async () => {
      buttons[0]!.focus();
      buttons[0]!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(buttons[1]);
    expect(scrollTo).not.toHaveBeenCalled();
    await act(async () => buttons[1]!.click());
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({
      top: 1400,
      behavior: "auto",
    });
    expect(document.activeElement?.id).toBe("special-stone-chapter-2-heading");
  });
  it("reveals a larger active title and its adjacent titles while scrubbing", async () => {
    await scroll(1200);
    expect(
      rail().querySelectorAll(
        '[data-academic-rail-label][data-visible="true"]',
      ),
    ).toHaveLength(0);
    await pointer("pointerdown", 374, 288);
    const labels = rail().querySelectorAll<HTMLElement>(
      '[data-academic-rail-label][data-visible="true"]',
    );
    expect([...labels].map((label) => label.dataset.academicRailLabel)).toEqual(
      ["1", "2", "3"],
    );
    const buttons = rail().querySelectorAll<HTMLButtonElement>("button");
    expect(
      Number(buttons[2]!.style.getPropertyValue("--chapter-label-scale")),
    ).toBeGreaterThan(
      Number(buttons[1]!.style.getPropertyValue("--chapter-label-scale")),
    );
    await pointer("pointermove", 374, 312);
    expect(preview()?.textContent).toContain("局部比较与释读边界");
    expect(
      rail()
        .querySelector('[data-academic-rail-label="4"]')
        ?.getAttribute("data-visible"),
    ).toBe("true");
    expect(scrollTo).not.toHaveBeenCalled();
    await pointer("pointerup", 374, 312);
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({
      top: 2200,
      behavior: "smooth",
    });
  });

  it("keeps one largest preview while adjacent labels follow the finger continuously", async () => {
    await scroll(1200);
    await pointer("pointerdown", 374, 288);
    const assertScale = (selected: number) => {
      const scales = [
        ...rail().querySelectorAll<HTMLButtonElement>("button"),
      ].map((button) =>
        Number(button.style.getPropertyValue("--chapter-label-scale")),
      );
      const largest = Math.max(...scales);
      expect(rail().getAttribute("data-preview-chapter")).toBe(
        String(selected),
      );
      expect(scales[selected]).toBe(largest);
      expect(scales.filter((scale) => scale === largest)).toHaveLength(1);
      expect(
        [
          ...rail().querySelectorAll<HTMLElement>(
            '[data-academic-rail-label][data-visible="true"]',
          ),
        ].map((label) => Number(label.dataset.academicRailLabel)),
      ).toEqual([selected - 1, selected, selected + 1]);
      return scales;
    };
    const chapterTwoScales = assertScale(2);
    expect(chapterTwoScales[1]).toBe(chapterTwoScales[3]);
    await pointer("pointermove", 374, 299);
    const approachingChapterThree = assertScale(2);
    expect(approachingChapterThree[3]).toBeGreaterThan(chapterTwoScales[3]!);
    expect(approachingChapterThree[1]).toBeLessThan(chapterTwoScales[1]!);
    await pointer("pointermove", 374, 300);
    const chapterThreeScales = assertScale(3);
    expect(chapterThreeScales[3]).toBe(chapterTwoScales[2]);
    await pointer("pointermove", 374, 310);
    const approachingChapterFour = assertScale(3);
    expect(approachingChapterFour[4]).toBeGreaterThan(chapterThreeScales[4]!);
    expect(approachingChapterFour[2]).toBeLessThan(chapterThreeScales[2]!);
    expect(scrollTo).not.toHaveBeenCalled();
    await pointer("pointerup", 374, 310);
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({
      top: 2200,
      behavior: "smooth",
    });
  });

  it("commits the release coordinate when the browser coalesces the final pointer move", async () => {
    await scroll(1200);
    await pointer("pointerdown", 374, 240);
    await pointer("pointerup", 374, 336);
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({
      top: 2600,
      behavior: "smooth",
    });
    expect(preview()).toBeNull();
  });

  it("cancels a visible preview when pointer capture is lost", async () => {
    await scroll(1200);
    await pointer("pointerdown", 374, 288);
    await pointer("lostpointercapture", 374, 288);
    await pointer("pointerup", 374, 288);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(preview()).toBeNull();
  });

  it("keeps scrubbing when a nested button transfers implicit capture to the rail", async () => {
    await scroll(1200);
    const button = rail().querySelector<HTMLButtonElement>("button")!;
    await pointer("pointerdown", 374, 240, 1, button);
    expect(preview()).not.toBeNull();
    await pointer("lostpointercapture", 374, 240, 1, button);
    expect(preview()).not.toBeNull();
    await pointer("pointermove", 374, 288);
    expect(preview()?.textContent).toContain("从原石到纸");
    expect(scrollTo).not.toHaveBeenCalled();
    await pointer("pointerup", 374, 288);
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({
      top: 1800,
      behavior: "smooth",
    });
    expect(preview()).toBeNull();
  });

  it("contains captioned body illustrations and enlarged section-number hooks", () => {
    const figures = node.querySelectorAll("[data-academic-body] figure");
    expect(figures).toHaveLength(2);
    for (const figure of figures) {
      expect(figure.querySelector("img")?.getAttribute("src")).toMatch(
        /^\/docs\/design-system\/assets\/demo\//,
      );
      expect(figure.querySelector("img")?.getAttribute("alt")).toBeTruthy();
      expect(figure.querySelector("figcaption")?.textContent).toContain("示意");
    }
    expect(
      node.querySelectorAll("[data-academic-section-number]"),
    ).toHaveLength(6);
  });

  it("uses the shared reading panel and portals its rail outside that panel", async () => {
    await act(async () => root.render(<EmbeddedReader />));
    reader().scrollTo = scrollTo;
    expect(node.querySelector("[data-academic-scroll]")).toBeNull();
    expect(
      node
        .querySelector("[data-academic-content]")
        ?.getAttribute("data-academic-embedded"),
    ).toBe("true");
    await scroll(1400);
    expect(
      node.querySelector("[data-test-rail-outlet]")?.contains(rail()),
    ).toBe(true);
    expect(reader().contains(rail())).toBe(false);
    await pointer("pointerdown", 374, 288);
    await pointer("pointerup", 374, 288);
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({
      top: 1800,
      behavior: "smooth",
    });
    expect(reader().scrollTop).toBe(1800);
  });

  it("retains shared reading position and cancels navigation while the comment page is active", async () => {
    await act(async () => root.render(<EmbeddedReader />));
    reader().scrollTo = scrollTo;
    await scroll(1410);
    await pointer("pointerdown", 374, 288);
    expect(preview()).not.toBeNull();
    await act(async () => root.render(<EmbeddedReader active={false} />));
    expect(rail()).toBeNull();
    expect(reader().scrollTop).toBe(1410);
    await act(async () => root.render(<EmbeddedReader />));
    expect(reader().scrollTop).toBe(1410);
    expect(preview()).toBeNull();
    await pointer("pointerup", 374, 288);
    expect(scrollTo).not.toHaveBeenCalled();
    await scroll(3700);
    expect(rail()).toBeNull();
  });
});
