import { describe, expect, it } from "vitest";

import {
  appendItems,
  effectiveCoverKey,
  moveBy,
  moveToIndex,
  removeItem,
  replaceItem,
  setCover,
  setCoverCrop,
  setItemEdit,
  setItemFeed,
  withValidCover,
} from "./media-order";

import type { MediaValue } from "./media-order";
import type { WorkDraftItem } from "@moya/contracts";

const item = (key: string, itemId: string | null = null): WorkDraftItem =>
  itemId === null
    ? {
        key,
        itemId,
        kind: "static",
        qualityMode: "standard",
        edit: { rotation: 0, crop: null },
        pendingLabel: "photo",
      }
    : {
        key,
        itemId,
        kind: "static",
        qualityMode: "standard",
        edit: { rotation: 0, crop: null },
      };

const album = (...keys: string[]): MediaValue => ({
  items: keys.map((key) => item(key, `media-item-${key.padStart(32, "0")}`)),
  coverKey: null,
  coverCrop: null,
});

const keys = (value: MediaValue) => value.items.map((entry) => entry.key);

describe("media album operations", () => {
  it("moves items with stable keys and identities, clamped at both ends", () => {
    const value = album("a", "b", "c");
    const down = moveBy(value, "a", 1);
    expect(keys(down)).toEqual(["b", "a", "c"]);
    expect(down.items[1]).toBe(value.items[0]);
    expect(moveBy(value, "a", -1)).toBe(value);
    expect(keys(moveToIndex(value, "c", 0))).toEqual(["c", "a", "b"]);
    expect(keys(moveToIndex(value, "a", 99))).toEqual(["b", "c", "a"]);
    expect(moveBy(value, "missing", 1)).toBe(value);
  });

  it("keeps the chosen cover independent of order", () => {
    const value = setCover(album("a", "b", "c"), "c");
    expect(value.coverKey).toBe("c");
    const moved = moveToIndex(value, "c", 0);
    expect(moved.coverKey).toBe("c");
    expect(effectiveCoverKey(moveToIndex(value, "a", 2))).toBe("c");
    expect(effectiveCoverKey(album("a", "b"))).toBe("a");
    expect(effectiveCoverKey(album())).toBe(null);
  });

  it("falls back deterministically when the cover is removed", () => {
    const value = setCoverCrop(album("a", "b"), "b", {
      x: 0.1,
      y: 0,
      width: 0.8,
      height: 1,
    });
    expect(value).toMatchObject({ coverKey: "b" });
    const removed = removeItem(value, "b");
    expect(removed.coverRemoved).toBe(true);
    expect(removed.value).toEqual({
      items: [value.items[0]],
      coverKey: null,
      coverCrop: null,
    });
    expect(effectiveCoverKey(removed.value)).toBe("a");
    const other = removeItem(value, "a");
    expect(other.coverRemoved).toBe(false);
    expect(other.value.coverKey).toBe("b");
    expect(
      withValidCover({ ...album("a"), coverKey: "gone", coverCrop: null }),
    ).toEqual({ value: album("a"), coverRemoved: true });
  });

  it("drops a cover crop when another cover is chosen or the cover's edit changes", () => {
    const crop = { x: 0, y: 0, width: 0.5, height: 0.5 };
    const value = setCoverCrop(album("a", "b"), "a", crop);
    expect(setCover(value, "a")).toBe(value);
    expect(setCover(value, "b")).toMatchObject({
      coverKey: "b",
      coverCrop: null,
    });
    const edited = setItemEdit(value, "a", { rotation: 90, crop: null });
    expect(edited.coverCropReset).toBe(true);
    expect(edited.value.coverCrop).toBe(null);
    expect(edited.value.items[0]!.edit).toEqual({ rotation: 90, crop: null });
    const unchanged = setItemEdit(value, "a", { rotation: 0, crop: null });
    expect(unchanged.value).toBe(value);
    const otherItem = setItemEdit(value, "b", { rotation: 180, crop: null });
    expect(otherItem.coverCropReset).toBe(false);
    expect(otherItem.value.coverCrop).toEqual(crop);
  });

  it("normalizes the stored edit (full frame as null)", () => {
    const result = setItemEdit(album("a"), "a", {
      rotation: 270,
      crop: { x: 0, y: 0, width: 1, height: 1 },
    });
    expect(result.value.items[0]!.edit).toEqual({ rotation: 270, crop: null });
  });

  it("keeps an item's feed framing through rotate/crop edits (#341)", () => {
    const crop = { x: 0, y: 0, width: 0.5, height: 0.5 };
    const framed = setItemFeed(setCoverCrop(album("a", "b"), "a", crop), "a", {
      fit: "cover",
      y: 0.2,
    });
    const turned = setItemEdit(framed, "a", { rotation: 90, crop: null });
    expect(turned.value.items[0]!.edit).toEqual({
      rotation: 90,
      crop: null,
      feed: { fit: "cover", y: 0.2 },
    });
    // The pixels changed: the cover composition is reset as before.
    expect(turned.coverCropReset).toBe(true);
    // The edit's own framing is not the item's: only the pixels apply, and
    // the same pixels are no change at all.
    const same = setItemEdit(framed, "a", {
      rotation: 0,
      crop: null,
      feed: { fit: "contain" },
    });
    expect(same.value).toBe(framed);
    expect(same.coverCropReset).toBe(false);
    expect(
      setItemEdit(album("b"), "b", {
        rotation: 180,
        crop: null,
        feed: { fit: "contain" },
      }).value.items[0]!.edit,
    ).toEqual({ rotation: 180, crop: null });
  });

  it("sets, normalizes and clears feed framing without touching pixels or the cover", () => {
    const crop = { x: 0, y: 0, width: 0.5, height: 0.5 };
    const value = setCoverCrop(
      setItemEdit(album("a", "b"), "a", { rotation: 90, crop }).value,
      "a",
      crop,
    );
    const whole = setItemFeed(value, "a", { fit: "contain" });
    expect(whole.items[0]!.edit).toEqual({
      rotation: 90,
      crop,
      feed: { fit: "contain" },
    });
    expect(whole.items[1]).toBe(value.items[1]);
    expect(whole).toMatchObject({ coverKey: "a", coverCrop: crop });
    expect(setItemFeed(whole, "a", { fit: "contain" })).toBe(whole);

    const region = setItemFeed(whole, "a", { fit: "cover", y: 1 / 3 });
    expect(region.items[0]!.edit.feed).toEqual({ fit: "cover", y: 0.3333 });
    expect(setItemFeed(region, "a", { fit: "cover", y: 0.33331 })).toBe(region);

    // A centred cover is no framing: the key goes.
    const centred = setItemFeed(region, "a", { fit: "cover", y: 0.5 });
    expect(centred.items[0]!.edit).toEqual({ rotation: 90, crop });
    expect("feed" in centred.items[0]!.edit).toBe(false);
    expect(setItemFeed(centred, "a", undefined)).toBe(centred);
    expect(setItemFeed(value, "missing", { fit: "contain" })).toBe(value);
  });

  it("puts re-selected items at the missing item's position and moves its cover role", () => {
    const value = setCover(album("a", "missing", "c"), "missing");
    const next = replaceItem(value, "missing", [item("new")]);
    expect(keys(next)).toEqual(["a", "new", "c"]);
    expect(next.coverKey).toBe("new");
    // Already appended by the manager: moved, not duplicated.
    const appended = appendItems(value, [item("new")]);
    expect(keys(replaceItem(appended, "missing", [item("new")]))).toEqual([
      "a",
      "new",
      "c",
    ]);
    expect(appendItems(value, [value.items[0]!])).toBe(value);
  });
});
