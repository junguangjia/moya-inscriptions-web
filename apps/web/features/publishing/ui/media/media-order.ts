import {
  FULL_EDIT,
  cleanFeed,
  effectiveFeed,
  normalizeCrop,
  sameCrop,
  sameEdit,
  sameFeed,
  withFeed,
} from "./media-geometry";

import type { ConfirmedSource } from "../../import-grouping";
import type {
  MediaCrop,
  MediaEdit,
  MediaFeedFraming,
  WorkDraftItem,
} from "@moya/contracts";

/**
 * Pure operations on the media part of the editor content (M02, M03): the
 * ordered items with stable keys, the independent cover and its crop. Item
 * identity never depends on upload completion order; every operation returns
 * the same object when nothing changes. Upload identities are merged by the
 * editor session (`syncManagedItems`), never here.
 */

export interface MediaValue {
  readonly items: readonly WorkDraftItem[];
  readonly coverKey: string | null;
  readonly coverCrop: MediaCrop | null;
}

/** Pending content entries for freshly confirmed staging entries, in order. */
export const confirmedItems = (
  confirmed: readonly ConfirmedSource[],
): WorkDraftItem[] =>
  confirmed.map((entry): WorkDraftItem => ({
    key: entry.key,
    itemId: null,
    kind: entry.source.kind,
    qualityMode: entry.qualityMode,
    edit: FULL_EDIT,
    pendingLabel: entry.source.kind === "live" ? "live" : "photo",
  }));

/** A cover that no longer names an item falls back to the first item. */
export const withValidCover = (
  value: MediaValue,
): { readonly value: MediaValue; readonly coverRemoved: boolean } =>
  value.coverKey !== null &&
  !value.items.some((item) => item.key === value.coverKey)
    ? {
        value: { ...value, coverKey: null, coverCrop: null },
        coverRemoved: true,
      }
    : { value, coverRemoved: false };

export const indexOfKey = (value: MediaValue, key: string): number =>
  value.items.findIndex((item) => item.key === key);

/** Moves one item to a new index (clamped); keys and edits travel with it. */
export const moveToIndex = (
  value: MediaValue,
  key: string,
  target: number,
): MediaValue => {
  const from = indexOfKey(value, key);
  if (from < 0) return value;
  const to = Math.min(value.items.length - 1, Math.max(0, target));
  if (to === from) return value;
  const items = [...value.items];
  const [moved] = items.splice(from, 1);
  items.splice(to, 0, moved!);
  return { ...value, items };
};

export const moveBy = (
  value: MediaValue,
  key: string,
  offset: number,
): MediaValue => {
  const from = indexOfKey(value, key);
  return from < 0 ? value : moveToIndex(value, key, from + offset);
};

/** The cover the card shows: the chosen one, else the first item (deterministic fallback). */
export const effectiveCoverKey = (value: MediaValue): string | null =>
  value.coverKey ?? value.items[0]?.key ?? null;

/**
 * Removes one item from the content. Removing the chosen cover clears it,
 * so the first remaining item becomes the cover (or the work becomes a text
 * card when none remain), and reports it for the notice.
 */
export const removeItem = (
  value: MediaValue,
  key: string,
): { readonly value: MediaValue; readonly coverRemoved: boolean } => {
  if (indexOfKey(value, key) < 0) return { value, coverRemoved: false };
  const items = value.items.filter((item) => item.key !== key);
  const coverRemoved = value.coverKey === key;
  return {
    value: coverRemoved
      ? { items, coverKey: null, coverCrop: null }
      : { ...value, items },
    coverRemoved,
  };
};

/** Chooses the cover independently of order; a different cover drops the old crop. */
export const setCover = (value: MediaValue, key: string): MediaValue => {
  if (indexOfKey(value, key) < 0 || value.coverKey === key) return value;
  return { ...value, coverKey: key, coverCrop: null };
};

/** Sets the card composition of `key`, which becomes the chosen cover. */
export const setCoverCrop = (
  value: MediaValue,
  key: string,
  crop: MediaCrop | null,
): MediaValue => {
  if (indexOfKey(value, key) < 0) return value;
  const coverCrop = normalizeCrop(crop);
  if (value.coverKey === key && sameCrop(value.coverCrop, coverCrop))
    return value;
  return { ...value, coverKey: key, coverCrop };
};

/**
 * Applies a rotate/crop edit; the item keeps its feed framing, which only
 * `setItemFeed` changes, as the new edit stores it: a choice that is the new
 * crop's default (`defaultFeed`) is no longer stored, and an item without
 * one takes the new crop's default. The cover crop is normalized to the
 * item's edited frame, so a changed edit of the cover item resets it.
 */
export const setItemEdit = (
  value: MediaValue,
  key: string,
  edit: MediaEdit,
): { readonly value: MediaValue; readonly coverCropReset: boolean } => {
  const index = indexOfKey(value, key);
  const current = value.items[index];
  if (!current) return { value, coverCropReset: false };
  const next = withFeed(
    { rotation: edit.rotation, crop: normalizeCrop(edit.crop) },
    current.edit.feed,
  );
  if (sameEdit(current.edit, next)) return { value, coverCropReset: false };
  const items = value.items.map((item) =>
    item.key === key ? { ...item, edit: next } : item,
  );
  const coverCropReset =
    effectiveCoverKey(value) === key && value.coverCrop !== null;
  return {
    value: coverCropReset
      ? { ...value, items, coverCrop: null }
      : { ...value, items },
    coverCropReset,
  };
};

/**
 * Sets how the phone feed frames one item (`MediaEdit.feed`, #341). It is
 * presentation only: the item's pixels stay, so its cover composition does
 * too. The item's default (`defaultFeed`: whole when uncropped, else a
 * centred cover) is stored as no framing; absent `feed` asks for it.
 */
export const setItemFeed = (
  value: MediaValue,
  key: string,
  feed: MediaFeedFraming | undefined,
): MediaValue => {
  const current = value.items[indexOfKey(value, key)];
  if (!current || sameFeed(current.edit.feed, feed, current.edit)) return value;
  return {
    ...value,
    items: value.items.map((item) =>
      item.key === key ? { ...item, edit: withFeed(item.edit, feed) } : item,
    ),
  };
};

/**
 * `setItemFeed` ahead of a crop the item does not have yet (#341 r3): the
 * desktop edit dialog's unkept crop, which a layout swap hands to the stage
 * as its draft. The choice stays spelled out even when it is the current
 * crop's default (the photo shows it alike meanwhile), so the stage's
 * `setItemEdit` stores it against the crop it was made with once it keeps
 * that crop.
 */
export const setItemFeedAhead = (
  value: MediaValue,
  key: string,
  feed: MediaFeedFraming,
): MediaValue => {
  const current = value.items[indexOfKey(value, key)];
  const framing = cleanFeed(feed);
  if (!current || framing === undefined) return value;
  if (
    current.edit.feed !== undefined &&
    sameFeed(current.edit.feed, framing, current.edit)
  )
    return value;
  const edit = {
    rotation: current.edit.rotation,
    crop: current.edit.crop,
    feed: framing,
  };
  return {
    ...value,
    items: value.items.map((item) =>
      item.key === key ? { ...item, edit } : item,
    ),
  };
};

/**
 * The framing an item takes back with its edit `before` on 撤销 of a pixel
 * change (a turn, 应用到全部; #341 r3), for `setItemFeed`. The change kept
 * the author's framing, but stores a choice that became the new crop's
 * default as none, so its 撤销 gives `before`'s framing back while the item
 * (`shown`, as it is now) still shows it; one chosen since stays as it
 * shows, rather than turning into the old crop's default.
 */
export const undoneFeed = (
  before: MediaFeedFraming | undefined,
  shown: Pick<WorkDraftItem, "edit"> | undefined,
): MediaFeedFraming | undefined =>
  shown === undefined || sameFeed(shown.edit.feed, before, shown.edit)
    ? before
    : effectiveFeed(shown.edit);

/**
 * Puts re-selected items where a missing one was (its cover role moves to
 * the first replacement, without a crop); replacements already listed are
 * moved rather than duplicated.
 */
export const replaceItem = (
  value: MediaValue,
  targetKey: string,
  replacements: readonly WorkDraftItem[],
): MediaValue => {
  const index = indexOfKey(value, targetKey);
  if (index < 0 || replacements.length === 0) return value;
  const incoming = new Set(replacements.map((item) => item.key));
  const kept = value.items.filter(
    (item) => item.key !== targetKey && !incoming.has(item.key),
  );
  const position = value.items
    .slice(0, index)
    .filter((item) => !incoming.has(item.key)).length;
  kept.splice(position, 0, ...replacements);
  const cover =
    value.coverKey === targetKey
      ? { coverKey: replacements[0]!.key, coverCrop: null }
      : { coverKey: value.coverKey, coverCrop: value.coverCrop };
  return { items: kept, ...cover };
};

/** Appends items whose keys the content does not list yet. */
export const appendItems = (
  value: MediaValue,
  added: readonly WorkDraftItem[],
): MediaValue => {
  const known = new Set(value.items.map((item) => item.key));
  const fresh = added.filter((item) => !known.has(item.key));
  return fresh.length === 0
    ? value
    : { ...value, items: [...value.items, ...fresh] };
};
