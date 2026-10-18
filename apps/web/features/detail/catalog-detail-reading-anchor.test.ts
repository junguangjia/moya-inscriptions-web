// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureDetailReadingAnchor,
  detailReadingAnchorOffset,
} from "./catalog-detail-reading-anchor";

const box = (left: number, right: number) =>
  ({
    left,
    right,
    top: 0,
    bottom: 300,
    width: right - left,
    height: 300,
  }) as DOMRect;
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("vertical Detail reading anchors", () => {
  it("restores a character and its right-edge gap after columns reflow", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<section data-detail-reading-anchor="section"><p data-detail-reading-anchor="description">甲乙丙丁戊己庚辛壬癸</p></section>';
    document.body.append(root);
    const p = root.querySelector("p")!;
    vi.spyOn(p, "getBoundingClientRect").mockReturnValue(box(-100, 400));
    let shift = 0;
    vi.spyOn(document, "createRange").mockImplementation(() => {
      let index = 0;
      return {
        setStart: (_: Node, offset: number) => {
          index = offset;
        },
        setEnd: () => {},
        getBoundingClientRect: () =>
          box(380 - index * 30 + shift, 400 - index * 30 + shift),
      } as unknown as Range;
    });
    const anchor = captureDetailReadingAnchor(root, box(0, 300));
    expect(anchor).toEqual({ id: "description", character: 4, rightDelta: 20 });
    shift = -40;
    expect(detailReadingAnchorOffset(root, box(0, 300), 100, anchor!)).toBe(
      140,
    );
  });

  it("keeps Unicode character offsets at complete code-point boundaries", () => {
    const root = document.createElement("div");
    root.innerHTML = '<p data-detail-reading-anchor="body">甲😀乙</p>';
    vi.spyOn(root.firstElementChild!, "getBoundingClientRect").mockReturnValue(
      box(-100, 400),
    );
    const ranges: [number, number][] = [];
    vi.spyOn(document, "createRange").mockImplementation(() => {
      let start = 0;
      return {
        setStart: (_: Node, offset: number) => {
          start = offset;
        },
        setEnd: (_: Node, end: number) => {
          ranges.push([start, end]);
        },
        getBoundingClientRect: () =>
          box(start === 0 ? 380 : 260, start === 0 ? 400 : 280),
      } as unknown as Range;
    });
    expect(captureDetailReadingAnchor(root, box(0, 300))).toEqual({
      id: "body",
      character: 1,
      rightDelta: 20,
    });
    expect(ranges).toContainEqual([1, 3]);
    expect(ranges).not.toContainEqual([2, 3]);
  });

  it("falls back to paragraph geometry and reports a removed anchor", () => {
    const root = document.createElement("div");
    root.innerHTML = '<p data-detail-reading-anchor="body">正文</p>';
    vi.spyOn(root.firstElementChild!, "getBoundingClientRect").mockReturnValue(
      box(0, 260),
    );
    const anchor = captureDetailReadingAnchor(root, box(0, 300));
    expect(anchor).toEqual({ id: "body", character: 0, rightDelta: 40 });
    expect(detailReadingAnchorOffset(root, box(0, 320), 50, anchor!)).toBe(70);
    root.replaceChildren();
    expect(
      detailReadingAnchorOffset(root, box(0, 300), 50, anchor!),
    ).toBeNull();
  });
});
