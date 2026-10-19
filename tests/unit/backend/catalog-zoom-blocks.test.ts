import { validatePublishedKey } from "@moya/backend-production/internal/publication";
import {
  catalogBlockCell,
  catalogBlockGrid,
  catalogBlockJobPayload,
  catalogBlockJobRanges,
  catalogBlockRole,
  catalogMasterFrame,
} from "@moya/community-postgres";
import {
  CATALOG_ZOOM_BLOCK_EDGE,
  CATALOG_ZOOM_BLOCK_OVERLAP,
  CATALOG_ZOOM_BLOCKS_MAXIMUM,
  CATALOG_ZOOM_MAX_LONG_EDGE,
} from "@moya/contracts/schemas";
import { describe, expect, it } from "vitest";

/*
 * catalog-deep-zoom-v1 (Issue #295) criteria 3 and 6, pure parts: the frame
 * of a master (never upscaled, at most 8192 px on the long edge for every
 * aspect), one level of 1024 px cells with a 2 px right and bottom overlap,
 * block job ranges of at most 16 cells, and the published block key grammar.
 */

describe("Catalog block geometry", () => {
  it("pins the public block constants", () => {
    expect([
      CATALOG_ZOOM_BLOCK_EDGE,
      CATALOG_ZOOM_BLOCK_OVERLAP,
      CATALOG_ZOOM_BLOCKS_MAXIMUM,
      CATALOG_ZOOM_MAX_LONG_EDGE,
    ]).toEqual([1024, 2, 100, 8192]);
  });

  it("scales a master to min(master, limit, 8192) and never upscales", () => {
    expect(catalogMasterFrame(6000, 4000, 8192)).toEqual({ width: 6000, height: 4000 });
    expect(catalogMasterFrame(9504, 6336, 8192)).toEqual({ width: 8192, height: 5461 });
    expect(catalogMasterFrame(4947, 9504, 8192)).toEqual({ width: 4264, height: 8192 });
    expect(catalogMasterFrame(9144, 6083, 6000)).toEqual({ width: 6000, height: 3991 });
    // A long scroll gets the same bound: no long-scroll exception.
    expect(catalogMasterFrame(3168, 19008, 8192)).toEqual({ width: 1365, height: 8192 });
  });

  it("cuts one level of row-major cells with the overlap on the right and bottom", () => {
    expect(catalogBlockGrid(8192, 5461)).toEqual({ columns: 8, rows: 6, cells: 48 });
    expect(catalogBlockGrid(6000, 4000)).toEqual({ columns: 6, rows: 4, cells: 24 });
    expect(catalogBlockCell(6000, 4000, 0)).toEqual({ left: 0, top: 0, width: 1026, height: 1026 });
    expect(catalogBlockCell(6000, 4000, 5)).toEqual({ left: 5120, top: 0, width: 880, height: 1026 });
    expect(catalogBlockCell(6000, 4000, 23)).toEqual({ left: 5120, top: 3072, width: 880, height: 928 });
    expect(() => catalogBlockCell(6000, 4000, 24)).toThrow(TypeError);
    expect(catalogBlockRole(7)).toBe("block-07");
    expect(catalogBlockRole(99)).toBe("block-99");
    expect(() => catalogBlockRole(100)).toThrow(TypeError);
  });

  it("plans block jobs as contiguous runs of at most 16 cells", () => {
    expect(catalogBlockJobRanges(Array.from({ length: 48 }, (_, cell) => cell))).toEqual([
      [0, 15],
      [16, 31],
      [32, 47],
    ]);
    expect(catalogBlockJobRanges([5, 3, 4, 9, 10, 30])).toEqual([
      [3, 5],
      [9, 10],
      [30, 30],
    ]);
  });

  it("parses only well-formed block job payloads", () => {
    const masterId = `catalog-master-${"a".repeat(32)}`;
    expect(catalogBlockJobPayload({ variant: "blocks", masterId, cells: [0, 15] })).toEqual({
      variant: "blocks",
      masterId,
      cells: [0, 15],
    });
    for (const bad of [
      null,
      { variant: "base", masterId, cells: [0, 1] },
      { variant: "blocks", masterId, cells: [0, 16] },
      { variant: "blocks", masterId, cells: [3, 2] },
      { variant: "blocks", masterId, cells: [99, 100] },
      { variant: "blocks", masterId: "x", cells: [0, 1] },
      { variant: "blocks", masterId, cells: [0, 1], extra: 1 },
    ])
      expect(catalogBlockJobPayload(bad)).toBeNull();
  });

  it("admits block keys in the published key grammar and nothing looser", () => {
    const hex = "0".repeat(32);
    expect(validatePublishedKey(`v1/${hex}/${hex}/base/block-07.r1.jpg`)).toContain("block-07");
    for (const bad of [
      `v1/${hex}/${hex}/base/block-7.r1.jpg`,
      `v1/${hex}/${hex}/base/block-100.r1.jpg`,
      `v1/${hex}/${hex}/base/blocks-07.r1.jpg`,
    ])
      expect(() => validatePublishedKey(bad)).toThrow();
  });
});
