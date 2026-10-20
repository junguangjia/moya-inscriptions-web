import { afterEach, describe, expect, it } from "vitest";

import {
  ZOOM_BLOCK_DECODED_BUDGET,
  countZoomBlockFailure,
  resetZoomBlockSession,
  shouldMountZoomBlocks,
  snapZoomRect,
  visibleZoomBlocks,
  zoomBlockEvictions,
  zoomBlockGrid,
  zoomBlockMaxScale,
  zoomBlockRect,
  zoomBlockRing,
  zoomBlocksFallenBack,
  zoomScreenRect,
} from "./zoom-blocks";

import type { ZoomFrame, ZoomView } from "./zoom-blocks";

/*
 * catalog-deep-zoom-v1 (Issue #295), criteria 15–18: the block layer's pure
 * rules. Rectangles come only from the index, the frame, the edge and the
 * overlap; the mount waits for 1.15 × the base; visible blocks come nearest
 * the centre first and are never evicted; the ceiling of a tiled image is
 * min(40, max(today, 1.25 × one-to-one, fill)); three counted failures end
 * the layer for the session.
 */

const frame: ZoomFrame = { width: 8192, height: 4608, edge: 1024, overlap: 2 };
// A 1600 × 900 image on a 400 × 600 stage fits 400 × 225 CSS px.
const view = (extra: Partial<ZoomView> = {}): ZoomView => ({
  fitWidth: 400,
  fitHeight: 225,
  stageWidth: 400,
  stageHeight: 600,
  scale: 1,
  x: 0,
  y: 0,
  ...extra,
});

afterEach(resetZoomBlockSession);

describe("block geometry", () => {
  it("cuts the frame row-major with the right and bottom overlap", () => {
    expect(zoomBlockGrid(frame)).toEqual({ columns: 8, rows: 5, cells: 40 });
    expect(zoomBlockRect(frame, 0)).toEqual({
      x: 0,
      y: 0,
      width: 1026,
      height: 1026,
    });
    expect(zoomBlockRect(frame, 7)).toEqual({
      x: 7168,
      y: 0,
      width: 1024,
      height: 1026,
    });
    expect(zoomBlockRect(frame, 39)).toEqual({
      x: 7168,
      y: 4096,
      width: 1024,
      height: 512,
    });
    const odd: ZoomFrame = {
      width: 5500,
      height: 3667,
      edge: 1024,
      overlap: 2,
    };
    expect(zoomBlockGrid(odd)).toEqual({ columns: 6, rows: 4, cells: 24 });
    expect(zoomBlockRect(odd, 23)).toEqual({
      x: 5120,
      y: 3072,
      width: 380,
      height: 595,
    });
  });

  it("maps a frame rectangle onto the stage and snaps it to device pixels", () => {
    const whole = { x: 0, y: 0, width: 8192, height: 4608 };
    expect(zoomScreenRect(frame, view(), whole)).toEqual({
      x: 0,
      y: 187.5,
      width: 400,
      height: 225,
    });
    const zoomed = zoomScreenRect(
      frame,
      view({ scale: 6, x: 100 }),
      zoomBlockRect(frame, 0),
    );
    expect(zoomed.x).toBeCloseTo(200 + 100 - 1200, 6);
    expect(zoomed.width).toBeCloseTo((1026 * 2400) / 8192, 6);
    const snapped = snapZoomRect(
      { x: 10.26, y: 3.74, width: 100.1, height: 50.2 },
      2,
    );
    expect(snapped).toEqual({ x: 10.5, y: 3.5, width: 100, height: 50.5 });
  });
});

describe("mount and visibility", () => {
  it("mounts only beyond 1.15 × the widest base candidate", () => {
    // 400 CSS px × scale × 2 device px against 1.15 × 3200 = 3680.
    expect(shouldMountZoomBlocks(view({ scale: 4.6 }), 2, 3200)).toBe(false);
    expect(shouldMountZoomBlocks(view({ scale: 4.61 }), 2, 3200)).toBe(true);
  });

  it("lists the visible cells nearest the centre first, and nothing off the frame", () => {
    const cells = visibleZoomBlocks(frame, view({ scale: 6 }));
    expect(cells.length).toBeGreaterThan(0);
    expect(new Set(cells).size).toBe(cells.length);
    // The stage's centre lies on the frame's centre: cells 19, 20, 27 or 28 first.
    expect([19, 20, 27, 28]).toContain(cells[0]);
    expect(visibleZoomBlocks(frame, view({ scale: 6, x: 100_000 }))).toEqual(
      [],
    );
    expect(visibleZoomBlocks(frame, view())).toHaveLength(40);
  });

  it("finds more than 24 visible at the mount on a 1920 × 1080 desktop at DPR 2 (no layer), few on a phone", () => {
    // A 4096-wide base: the mount is at 1.15 × 4096 device px across.
    const desktop = view({
      fitWidth: 1920,
      fitHeight: 1080,
      stageWidth: 1920,
      stageHeight: 1080,
    });
    const mount = (1.15 * 4096) / (1920 * 2);
    expect(
      visibleZoomBlocks(frame, { ...desktop, scale: mount }).length,
    ).toBeGreaterThan(24);
    const phone = view({
      fitWidth: 390,
      fitHeight: 219,
      stageWidth: 390,
      stageHeight: 760,
    });
    expect(
      visibleZoomBlocks(frame, { ...phone, scale: (1.15 * 4096) / (390 * 3) })
        .length,
    ).toBeLessThanOrEqual(24);
  });
});

describe("budget and eviction", () => {
  it("keeps a one-block ring around the visible set", () => {
    expect([...zoomBlockRing(frame, [0])].sort((a, b) => a - b)).toEqual([
      1, 8, 9,
    ]);
    expect(zoomBlockRing(frame, [19, 20]).has(19)).toBe(false);
  });

  it("evicts least recently used blocks outside the visible set and its ring, never a visible one", () => {
    const used = Array.from(
      { length: ZOOM_BLOCK_DECODED_BUDGET + 3 },
      (_, n) => n,
    );
    const visible = [0, 1, 2];
    const evicted = zoomBlockEvictions(
      used,
      visible,
      zoomBlockRing(frame, visible),
    );
    expect(evicted).toHaveLength(3);
    for (const cell of evicted) {
      expect(visible).not.toContain(cell);
      expect(zoomBlockRing(frame, visible).has(cell)).toBe(false);
    }
    expect(zoomBlockEvictions(used.slice(0, 24), visible, new Set())).toEqual(
      [],
    );
    // Even with nothing else to drop, visible blocks stay.
    expect(zoomBlockEvictions([0, 1, 2], [0, 1, 2], new Set(), 1)).toEqual([]);
  });
});

describe("zoom ceiling and session fallback", () => {
  it("allows min(40, max(today, 1.25 × one-to-one, fill))", () => {
    expect(zoomBlockMaxScale(8, frame, view(), 2)).toBeCloseTo(12.8, 6);
    expect(zoomBlockMaxScale(8, { width: 2400 }, view(), 2)).toBe(8);
    expect(
      zoomBlockMaxScale(
        8,
        { width: 8192 },
        view({ fitWidth: 100, fitHeight: 56 }),
        1,
      ),
    ).toBe(40);
    expect(
      zoomBlockMaxScale(
        1,
        { width: 1 },
        view({ fitWidth: 100, fitHeight: 100 }),
        1,
      ),
    ).toBe(6);
  });

  it("falls back after three counted failures until the session resets", () => {
    countZoomBlockFailure();
    countZoomBlockFailure();
    expect(zoomBlocksFallenBack()).toBe(false);
    countZoomBlockFailure();
    expect(zoomBlocksFallenBack()).toBe(true);
    resetZoomBlockSession();
    expect(zoomBlocksFallenBack()).toBe(false);
  });
});
