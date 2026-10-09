// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FeedPostDots } from "./feed-post-dots";

import type { ComponentProps } from "react";
import type { Root } from "react-dom/client";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type DotsProps = ComponentProps<typeof FeedPostDots>;

const alts = (count: number) =>
  Array.from({ length: count }, (_, index) => `图${index + 1}`);

const roots: Root[] = [];
const render = async (change: Partial<DotsProps> = {}) => {
  const props: DotsProps = {
    alts: alts(3),
    activeIndex: 0,
    progress: 0,
    region: "media",
    hasComments: true,
    onSelect: vi.fn(),
    onSelectComments: vi.fn(),
    ...change,
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<FeedPostDots {...props} />));
  return { container, props };
};

const dots = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLButtonElement>("[data-feed-post-dot]"),
];
const seal = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>("[data-feed-post-dot-comments]");
const mark = (button: Element) => button.querySelector("span")!;
const weight = (button: Element) =>
  mark(button).style.getPropertyValue("--media-dot-weight");
const size = (button: Element) =>
  mark(button).style.getPropertyValue("--media-dot-size");
const labelIndex = (button: Element) =>
  Number(/第 (\d+) 张/u.exec(button.getAttribute("aria-label") ?? "")?.[1]) - 1;

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

describe("FeedPostDots", () => {
  it("renders nothing for a single image without comments", async () => {
    const { container } = await render({ alts: alts(1), hasComments: false });
    expect(container.childElementCount).toBe(0);
  });

  it("renders only the seal for a single image with comments", async () => {
    const { container } = await render({ alts: alts(1), hasComments: true });
    expect(dots(container)).toHaveLength(0);
    const buttons = container.querySelectorAll("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.getAttribute("aria-label")).toBe("转到评论区");
  });

  it("renders the image dots without a seal when there are no comments", async () => {
    const { container } = await render({ hasComments: false });
    expect(dots(container)).toHaveLength(3);
    expect(seal(container)).toBeNull();
  });

  it("orders the image dots first and the seal last in the DOM", async () => {
    const { container } = await render();
    const group = container.querySelector("[data-feed-post-dots]")!;
    // The row is mirrored visually by CSS; the DOM keeps reading order.
    expect(group.className).toMatch(/postDots/u);
    expect(group.getAttribute("role")).toBe("group");
    expect(group.getAttribute("aria-label")).toBe("选择图像");
    const buttons = [...group.querySelectorAll("button")];
    expect(buttons).toHaveLength(4);
    expect(buttons.slice(0, 3).map(labelIndex)).toEqual([0, 1, 2]);
    expect(buttons[0]!.getAttribute("aria-label")).toBe("第 1 张图像：图1");
    expect(buttons[3]).toBe(seal(container));
    expect(buttons[3]!.getAttribute("aria-label")).toBe("转到评论区");
  });

  it("marks only the active dot as current in the media region", async () => {
    const { container } = await render({ activeIndex: 1, progress: 1 });
    expect(
      dots(container).map((dot) => dot.getAttribute("aria-current")),
    ).toEqual([null, "true", null]);
    expect(seal(container)!.getAttribute("aria-current")).toBeNull();
    expect(seal(container)!.dataset.active).toBe("false");
  });

  it("marks the seal as current in the comments region", async () => {
    const { container } = await render({
      activeIndex: 2,
      progress: 3,
      region: "comments",
    });
    expect(
      dots(container).map((dot) => dot.getAttribute("aria-current")),
    ).toEqual([null, null, null]);
    expect(seal(container)!.getAttribute("aria-current")).toBe("true");
    expect(seal(container)!.dataset.active).toBe("true");
  });

  it("selects an image by its dot and the comments by the seal", async () => {
    const { container, props } = await render();
    await act(async () => dots(container)[2]!.click());
    expect(props.onSelect).toHaveBeenCalledTimes(1);
    expect(props.onSelect).toHaveBeenCalledWith(2);
    expect(props.onSelectComments).not.toHaveBeenCalled();
    await act(async () => seal(container)!.click());
    expect(props.onSelectComments).toHaveBeenCalledTimes(1);
    expect(props.onSelect).toHaveBeenCalledTimes(1);
  });

  it("grows the dot nearest the live progress", async () => {
    const { container } = await render({ progress: 1 });
    const [first, second, third] = dots(container);
    expect(weight(second!)).toBe("100%");
    expect(size(second!)).toBe("8px");
    expect(weight(first!)).toBe("0%");
    expect(size(first!)).toBe("6px");
    expect(weight(third!)).toBe("0%");
    expect(weight(seal(container)!)).toBe("0%");
    expect(size(seal(container)!)).toBe("8px");
    expect(second!.dataset.active).toBe("true");
    expect(first!.dataset.active).toBe("false");
  });

  it("splits the weight between two dots mid-swipe", async () => {
    const { container } = await render({ progress: 0.5 });
    const [first, second, third] = dots(container);
    expect(weight(first!)).toBe("50%");
    expect(weight(second!)).toBe("50%");
    expect(size(first!)).toBe("7px");
    expect(weight(third!)).toBe("0%");
  });

  it("grows the seal as the strip reaches the comments", async () => {
    const { container } = await render({ progress: 3, region: "comments" });
    expect(weight(seal(container)!)).toBe("100%");
    expect(size(seal(container)!)).toBe("10px");
    expect(weight(dots(container)[2]!)).toBe("0%");
    // The indicated dot stays clamped to the last image.
    expect(dots(container)[2]!.dataset.active).toBe("true");
  });

  it("reflects the live progress on the group", async () => {
    const { container } = await render({ progress: 1.25 });
    expect(
      container
        .querySelector("[data-feed-post-dots]")!
        .getAttribute("data-feed-post-progress"),
    ).toBe("1.25");
  });

  describe("with more than five images", () => {
    it("shows a five-dot window with a smaller trailing edge dot at the start", async () => {
      const { container } = await render({ alts: alts(8), progress: 0 });
      const visible = dots(container);
      expect(visible.map(labelIndex)).toEqual([0, 1, 2, 3, 4]);
      expect(visible.map((dot) => dot.dataset.edge ?? null)).toEqual([
        null,
        null,
        null,
        null,
        "true",
      ]);
      expect(size(visible[4]!)).toBe("4px");
      expect(seal(container)).not.toBeNull();
    });

    it("centres the window on the indicated image with edge dots on both sides", async () => {
      const { container } = await render({
        alts: alts(8),
        activeIndex: 4,
        progress: 4,
      });
      const visible = dots(container);
      expect(visible.map(labelIndex)).toEqual([2, 3, 4, 5, 6]);
      expect(visible.map((dot) => dot.dataset.edge ?? null)).toEqual([
        "true",
        null,
        null,
        null,
        "true",
      ]);
      expect(visible[2]!.getAttribute("aria-current")).toBe("true");
      expect(weight(visible[2]!)).toBe("100%");
      expect(size(visible[2]!)).toBe("8px");
    });

    it("clicking a windowed dot selects its real image index", async () => {
      const { container, props } = await render({
        alts: alts(8),
        progress: 4,
      });
      await act(async () => dots(container)[4]!.click());
      expect(props.onSelect).toHaveBeenCalledWith(6);
    });

    it("drops the trailing edge at the last image", async () => {
      const { container } = await render({
        alts: alts(8),
        activeIndex: 7,
        progress: 7,
      });
      const visible = dots(container);
      expect(visible.map(labelIndex)).toEqual([3, 4, 5, 6, 7]);
      expect(visible.map((dot) => dot.dataset.edge ?? null)).toEqual([
        "true",
        null,
        null,
        null,
        null,
      ]);
    });
  });
});
