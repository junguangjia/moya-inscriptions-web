import { describe, expect, it } from "vitest";

import { setItemEdit } from "../media/media-order";
import { applyRatioToAll } from "./apply-to-all";

import type { Size } from "../media/media-geometry";
import type { MediaValue } from "../media/media-order";
import type { MediaEdit, WorkDraftItem } from "@moya/contracts";

const item = (
  key: string,
  edit: MediaEdit = { rotation: 0, crop: null },
  qualityMode: WorkDraftItem["qualityMode"] = "standard",
) => ({ key, edit, qualityMode });

const landscape: Size = { width: 4000, height: 3000 };

describe("applyRatioToAll", () => {
  it("gives every photo the centred crop of the ratio inside its own frame", () => {
    const changes = applyRatioToAll(
      [item("wide"), item("turned", { rotation: 90, crop: null })],
      new Map([
        ["wide", landscape],
        ["turned", landscape],
      ]),
      "4:5",
    );
    expect(changes).toEqual([
      // 4000 × 3000: a 4:5 box is 60 % of the width, centred.
      {
        key: "wide",
        edit: { rotation: 0, crop: { x: 0.2, y: 0, width: 0.6, height: 1 } },
      },
      // Turned, the frame is 3000 × 4000: the box takes 93.75 % of the height.
      {
        key: "turned",
        edit: {
          rotation: 90,
          crop: { x: 0, y: 0.03125, width: 1, height: 0.9375 },
        },
      },
    ]);
  });

  it("keeps a photo's own position when its crop already has the shape", () => {
    // A 4:5 crop of a 4000 × 3000 frame placed off centre by its author.
    const placed = { x: 0.1, y: 0.4, width: 0.3, height: 0.5 };
    const square = { x: 0.125, y: 0, width: 0.75, height: 1 };
    const changes = applyRatioToAll(
      [
        item("placed", { rotation: 0, crop: placed }),
        item("square", { rotation: 0, crop: square }),
      ],
      new Map([
        ["placed", landscape],
        ["square", landscape],
      ]),
      "4:5",
    );
    expect(changes).toEqual([
      {
        key: "square",
        edit: { rotation: 0, crop: { x: 0.2, y: 0, width: 0.6, height: 1 } },
      },
    ]);
  });

  it("leaves a whole frame that already has the shape uncropped", () => {
    expect(
      applyRatioToAll(
        [item("portrait")],
        new Map([["portrait", { width: 1080, height: 1350 }]]),
        "4:5",
      ),
    ).toEqual([]);
  });

  it("skips photos it cannot measure or edit, and unknown ratios", () => {
    const sizes = new Map([
      ["legacy", landscape],
      ["empty", { width: 0, height: 0 }],
    ]);
    expect(
      applyRatioToAll(
        [item("legacy", undefined, "legacy"), item("unknown"), item("empty")],
        sizes,
        "1:1",
      ),
    ).toEqual([]);
    expect(
      applyRatioToAll(
        [item("wide")],
        new Map([["wide", landscape]]),
        "4:5",
        [],
      ),
    ).toEqual([]);
  });

  it("returns cropped photos to the whole frame for 原始比例 and never turns them", () => {
    const changes = applyRatioToAll(
      [
        item("cropped", {
          rotation: 180,
          crop: { x: 0.2, y: 0, width: 0.6, height: 1 },
        }),
        item("whole", { rotation: 270, crop: null }),
      ],
      new Map([
        ["cropped", landscape],
        ["whole", landscape],
      ]),
      "original",
    );
    expect(changes).toEqual([
      { key: "cropped", edit: { rotation: 180, crop: null } },
    ]);
  });

  it("never touches a photo's feed framing, applied or undone (#341)", () => {
    const placed = { x: 0.1, y: 0.4, width: 0.3, height: 0.5 };
    const album: MediaValue = {
      items: (
        [
          [
            "region",
            { rotation: 0, crop: null, feed: { fit: "cover", y: 0.2 } },
          ],
          ["whole", { rotation: 0, crop: placed, feed: { fit: "contain" } }],
          ["plain", { rotation: 90, crop: null }],
        ] as const
      ).map(([key, edit]): WorkDraftItem => ({
        key,
        itemId: null,
        kind: "static",
        qualityMode: "standard",
        edit,
        pendingLabel: "photo",
      })),
      coverKey: null,
      coverCrop: null,
    };
    const sizes = new Map(album.items.map((entry) => [entry.key, landscape]));
    const changes = applyRatioToAll(album.items, sizes, "4:5");
    // The ratio is all it sets: "whole" already has the shape and keeps it.
    expect(changes.map((change) => change.key)).toEqual(["region", "plain"]);
    expect(changes.every((change) => !("feed" in change.edit))).toBe(true);

    // Folded like the edit screen does, then undone with each photo's edit.
    const applied = changes.reduce(
      (value, change) => setItemEdit(value, change.key, change.edit).value,
      album,
    );
    const feeds = (value: MediaValue) =>
      value.items.map((entry) => entry.edit.feed);
    expect(feeds(applied)).toEqual(feeds(album));
    expect(applied.items[0]!.edit.crop).toEqual({
      x: 0.2,
      y: 0,
      width: 0.6,
      height: 1,
    });
    const undone = changes.reduce(
      (value, change) =>
        setItemEdit(
          value,
          change.key,
          album.items.find((entry) => entry.key === change.key)!.edit,
        ).value,
      applied,
    );
    expect(undone.items).toEqual(album.items);
  });
});
