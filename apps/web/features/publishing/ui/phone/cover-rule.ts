import type { MediaValue } from "../media/media-order";

/**
 * 首图 = 封面 on the phone screens (#244, design-language §6 G6): the cover is
 * item 1. When an order change, 设为首图 or a removal gives position 1 to
 * another item while a chosen cover names a different one, the choice and its
 * composition are dropped, so the cover falls back to the new first item. An
 * older draft whose chosen cover is not item 1 keeps it until position 1
 * changes.
 */

/**
 * The words the editor already uses when a cover composition is dropped
 * (media-section's edit reset: 「图片编辑后，封面构图已恢复为完整画面，可重新调整」).
 */
export const COVER_RESET_NOTICE = "封面构图已恢复为完整画面";

export const keepCoverOnFirst = (
  before: MediaValue,
  after: MediaValue,
): { readonly value: MediaValue; readonly coverReset: boolean } => {
  const first = after.items[0]?.key ?? null;
  if (
    (before.items[0]?.key ?? null) === first ||
    after.coverKey === null ||
    after.coverKey === first
  )
    return { value: after, coverReset: false };
  return {
    value: { ...after, coverKey: null, coverCrop: null },
    coverReset: true,
  };
};

/** What `keepCoverAround` reads and writes: the editor's album. */
export interface CoverRuleStore {
  media(): MediaValue;
  setMedia(value: MediaValue): void;
}

/**
 * One album change under 首图 = 封面 (r4 D12): runs `change` (a reorder, 设为首图,
 * a removal through the media actions), then `keepCoverOnFirst` from the album
 * before it to the album after it, writing the album back only when a chosen
 * cover was dropped. Returns whether it was, so the caller says
 * `COVER_RESET_NOTICE` in its own words (a toast lead, or the notice alone).
 */
export const keepCoverAround = (
  store: CoverRuleStore,
  change: () => void,
): boolean => {
  const before = store.media();
  change();
  const kept = keepCoverOnFirst(before, store.media());
  if (!kept.coverReset) return false;
  store.setMedia(kept.value);
  return true;
};
