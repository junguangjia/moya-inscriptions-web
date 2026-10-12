import { describe, expect, it, vi } from "vitest";

import {
  moveBy,
  moveToIndex,
  removeItem,
  setCover,
  setCoverCrop,
} from "../media/media-order";
import {
  COVER_RESET_NOTICE,
  keepCoverAround,
  keepCoverOnFirst,
} from "./cover-rule";

import type { MediaValue } from "../media/media-order";
import type { WorkDraftItem } from "@moya/contracts";

const item = (key: string): WorkDraftItem => ({
  key,
  itemId: `media-item-${key.padStart(32, "0")}`,
  kind: "static",
  qualityMode: "standard",
  edit: { rotation: 0, crop: null },
});

const album = (...keys: string[]): MediaValue => ({
  items: keys.map(item),
  coverKey: null,
  coverCrop: null,
});

const crop = { x: 0, y: 0, width: 0.5, height: 0.5 };
const keys = (value: MediaValue) => value.items.map((entry) => entry.key);

describe("keepCoverOnFirst", () => {
  it("drops a chosen cover and its composition when another item becomes 首图", () => {
    const before = setCoverCrop(album("a", "b", "c"), "a", crop);
    const after = moveBy(before, "a", 1);
    const result = keepCoverOnFirst(before, after);
    expect(keys(result.value)).toEqual(["b", "a", "c"]);
    expect(result.value.coverKey).toBe(null);
    expect(result.value.coverCrop).toBe(null);
    expect(result.value.items).toBe(after.items);
    expect(result.coverReset).toBe(true);
  });

  it("drops it when removing item 1 hands position 1 to an item that is not the cover", () => {
    const before = setCoverCrop(album("a", "b", "c"), "c", crop);
    const after = removeItem(before, "a").value;
    expect(after.coverKey).toBe("c");
    const result = keepCoverOnFirst(before, after);
    expect(keys(result.value)).toEqual(["b", "c"]);
    expect(result.value.coverKey).toBe(null);
    expect(result.value.coverCrop).toBe(null);
    expect(result.coverReset).toBe(true);
  });

  it("keeps the cover that becomes 首图 itself (设为首图 on the cover)", () => {
    const before = setCoverCrop(album("a", "b", "c"), "c", crop);
    const after = moveToIndex(before, "c", 0);
    const result = keepCoverOnFirst(before, after);
    expect(result.value).toBe(after);
    expect(result.value.coverCrop).toEqual(crop);
    expect(result.coverReset).toBe(false);
  });

  it("leaves an older draft's cover alone while position 1 stays the same", () => {
    const before = setCover(album("a", "b", "c"), "c");
    const after = moveBy(before, "b", 1);
    expect(keys(after)).toEqual(["a", "c", "b"]);
    const result = keepCoverOnFirst(before, after);
    expect(result.value).toBe(after);
    expect(result.value.coverKey).toBe("c");
    expect(result.coverReset).toBe(false);
  });

  it("has nothing to reset without a chosen cover", () => {
    const before = album("a", "b");
    const after = moveBy(before, "b", -1);
    const result = keepCoverOnFirst(before, after);
    expect(result.value).toBe(after);
    expect(result.coverReset).toBe(false);
  });

  it("reuses the editor's existing reset wording", () => {
    expect(COVER_RESET_NOTICE).toBe("封面构图已恢复为完整画面");
  });
});

describe("keepCoverAround", () => {
  /** The editor's album as `media()` / `setMedia()` see it. */
  const albumStore = (initial: MediaValue) => {
    let value = initial;
    const setMedia = vi.fn((next: MediaValue) => {
      value = next;
    });
    return {
      media: () => value,
      setMedia,
      set: (next: MediaValue) => (value = next),
    };
  };

  it("resets a chosen cover and its composition when the change gives position 1 to another item", () => {
    const store = albumStore(setCoverCrop(album("a", "b", "c"), "a", crop));
    const moved = moveToIndex(store.media(), "c", 0);
    const change = vi.fn(() => store.set(moved));
    expect(keepCoverAround(store, change)).toBe(true);
    expect(change).toHaveBeenCalledOnce();
    expect(store.setMedia).toHaveBeenCalledOnce();
    expect(keys(store.media())).toEqual(["c", "a", "b"]);
    expect(store.media().coverKey).toBe(null);
    expect(store.media().coverCrop).toBe(null);
    expect(store.media().items).toBe(moved.items);
  });

  it("leaves the album as the change made it while position 1 stays, or the cover becomes 首图", () => {
    const kept = albumStore(setCoverCrop(album("a", "b", "c"), "a", crop));
    const later = moveBy(kept.media(), "b", 1);
    expect(keepCoverAround(kept, () => kept.set(later))).toBe(false);
    expect(kept.setMedia).not.toHaveBeenCalled();
    expect(kept.media()).toBe(later);
    expect(kept.media().coverCrop).toEqual(crop);

    const promoted = albumStore(setCoverCrop(album("a", "b", "c"), "c", crop));
    const first = moveToIndex(promoted.media(), "c", 0);
    expect(keepCoverAround(promoted, () => promoted.set(first))).toBe(false);
    expect(promoted.setMedia).not.toHaveBeenCalled();
    expect(promoted.media()).toBe(first);
  });

  it("has nothing to reset without a chosen cover, or when the change did nothing", () => {
    const plain = albumStore(album("a", "b"));
    const swapped = moveBy(plain.media(), "b", -1);
    expect(keepCoverAround(plain, () => plain.set(swapped))).toBe(false);
    expect(plain.setMedia).not.toHaveBeenCalled();

    const covered = albumStore(setCover(album("a", "b"), "b"));
    const before = covered.media();
    expect(keepCoverAround(covered, () => undefined)).toBe(false);
    expect(covered.setMedia).not.toHaveBeenCalled();
    expect(covered.media()).toBe(before);
  });

  it("applies the rule to a removal that hands position 1 on", () => {
    const store = albumStore(setCoverCrop(album("a", "b", "c"), "c", crop));
    expect(
      keepCoverAround(store, () =>
        store.set(removeItem(store.media(), "a").value),
      ),
    ).toBe(true);
    expect(keys(store.media())).toEqual(["b", "c"]);
    expect(store.media().coverKey).toBe(null);
  });
});
