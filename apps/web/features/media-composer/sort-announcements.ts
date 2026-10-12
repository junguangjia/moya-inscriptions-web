import type { Announcements } from "@dnd-kit/core";

/**
 * What a screen reader hears while composer thumbnails are sorted (#244): the
 * phone 编辑 strip (r4), drawn right to left. Positions are logical (第 1 项
 * is the feed's first image), whatever the visual direction.
 */

export interface SortAnnouncementOptions {
  /**
   * The word for position 1 (r4 ASK-4: 首图). With it, lifting item 1, a move
   * onto position 1 and a move away from it say who is (or becomes) first;
   * without it the wording names positions only.
   */
  readonly first?: string | undefined;
}

/** Announcements in logical positions, worded like the strip's. */
export const sortAnnouncements = (
  keys: readonly string[],
  { first }: SortAnnouncementOptions = {},
): Announcements => {
  const position = (value: string | number) => keys.indexOf(String(value)) + 1;
  const named = first !== undefined && first !== "";
  return {
    onDragStart: ({ active }) => {
      const from = position(active.id);
      return named && from === 1
        ? `已拿起第 1 项（${first}）。`
        : `已拿起第 ${from} 项。`;
    },
    onDragOver: ({ active, over }) => {
      const from = position(active.id);
      if (over === null) return `第 ${from} 项不在可放置的位置。`;
      const to = position(over.id);
      return named && to === 1 && from !== 1
        ? `第 ${from} 项将移到第 1 位，成为${first}。`
        : `第 ${from} 项将移到第 ${to} 位。`;
    },
    onDragEnd: ({ active, over }) => {
      const from = position(active.id);
      if (over === null) return `第 ${from} 项已放回原位。`;
      const to = position(over.id);
      if (named && to === 1 && from !== 1)
        return `第 ${from} 项已移到第 1 位，现在是${first}。`;
      if (named && from === 1 && to !== 1)
        return `第 1 项已移到第 ${to} 位，原第 2 项现在是${first}。`;
      return `第 ${from} 项已移到第 ${to} 位。`;
    },
    onDragCancel: ({ active }) =>
      `已取消移动，第 ${position(active.id)} 项回到原位。`,
  };
};
