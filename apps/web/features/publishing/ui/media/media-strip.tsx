"use client";

import { DndContext, closestCenter } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useEffect, useState } from "react";

import { useMediaSortSensors } from "../../../media-composer/sort-sensors";
import { MediaItemTile } from "./media-item-tile";
import styles from "./media.module.css";

import type { CoverRole, MediaItemTileProps } from "./media-item-tile";
import type { ItemDerivation } from "../../edit-readiness";
import type { UploadItemView } from "../../upload-manager";
import type {
  Announcements,
  DragEndEvent,
  ScreenReaderInstructions,
} from "@dnd-kit/core";
import type { PublishingMediaItem, WorkDraftItem } from "@moya/contracts";

/** The sensors moved to the composer module (#244); the names stay importable here. */
export {
  MousePenSensor,
  TOUCH_SORT_DELAY_MS,
} from "../../../media-composer/sort-sensors";

/**
 * The ordered, sortable media strip (M02): pointer drag for mouse and pen,
 * long-press (~250 ms) drag on touch so a swipe still scrolls, the keyboard
 * sensor with sortable coordinates, and screen-reader announcements in the
 * product language. Order numbers always follow the content order; keys
 * never change.
 */

const screenReaderInstructions: ScreenReaderInstructions = {
  draggable:
    "按空格键或回车键拿起，用方向键移动，再按空格键或回车键放下，按 Esc 取消。也可以按 Alt 加上下方向键，或使用上移、下移按钮。",
};

const usePrefersReducedMotion = (): boolean => {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const change = () => setReduced(query.matches);
    query.addEventListener?.("change", change);
    return () => query.removeEventListener?.("change", change);
  }, []);
  return reduced;
};

export interface MediaStripProps extends Pick<
  MediaItemTileProps,
  | "onMove"
  | "onRemove"
  | "onSetCover"
  | "onComposeCover"
  | "onEdit"
  | "onRetry"
  | "onChooseOriginal"
  | "onReselect"
  | "onToggleSelection"
> {
  readonly selecting: boolean;
  readonly selectedKeys: readonly string[];
  readonly onSelect: (key: string) => void;
  readonly id: string;
  readonly label: string;
  readonly items: readonly WorkDraftItem[];
  readonly views: ReadonlyMap<string, UploadItemView>;
  /** Account views of items this browser's manager does not track, by item id. */
  readonly serverItems: Readonly<Record<string, PublishingMediaItem>>;
  readonly coverKey: string | null;
  readonly localStill: (key: string) => Blob | null;
  /** The editor and upload manager have loaded (see `StatusContext`). */
  readonly loaded: boolean;
  /** Edit derivative state and edited thumbnail per item key (edit-readiness.ts). */
  readonly derivations: ReadonlyMap<
    string,
    { readonly derivation: ItemDerivation; readonly thumbSrc: string | null }
  >;
  /** Moves `key` to the index the drop landed on. */
  readonly onReorder: (key: string, index: number) => void;
}

export const MediaStrip = ({
  id,
  label,
  items,
  views,
  serverItems,
  coverKey,
  localStill,
  loaded,
  derivations,
  onReorder,
  selecting,
  selectedKeys,
  onSelect,
  ...actions
}: MediaStripProps) => {
  const reducedMotion = usePrefersReducedMotion();
  const sensors = useMediaSortSensors();
  const keys = items.map((item) => item.key);
  const position = (value: string | number) => keys.indexOf(String(value)) + 1;
  const announcements: Announcements = {
    onDragStart: ({ active }) => `已拿起第 ${position(active.id)} 项。`,
    onDragOver: ({ active, over }) =>
      over === null
        ? `第 ${position(active.id)} 项不在可放置的位置。`
        : `第 ${position(active.id)} 项将移到第 ${position(over.id)} 位。`,
    onDragEnd: ({ active, over }) =>
      over === null
        ? `第 ${position(active.id)} 项已放回原位。`
        : `第 ${position(active.id)} 项已移到第 ${position(over.id)} 位。`,
    onDragCancel: ({ active }) =>
      `已取消移动，第 ${position(active.id)} 项回到原位。`,
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (over === null || active.id === over.id) return;
    const index = keys.indexOf(String(over.id));
    if (index >= 0) onReorder(String(active.id), index);
  };
  const effectiveCover = coverKey ?? keys[0] ?? null;

  return (
    <DndContext
      accessibility={{ announcements, screenReaderInstructions }}
      collisionDetection={closestCenter}
      id={id}
      onDragStart={({ active, activatorEvent }) => {
        if (activatorEvent.type === "touchstart") onSelect(String(active.id));
      }}
      onDragEnd={onDragEnd}
      sensors={sensors}
    >
      <SortableContext items={keys} strategy={verticalListSortingStrategy}>
        <ol aria-label={label} className={styles.strip} data-media-strip="">
          {items.map((item, index) => {
            const cover: CoverRole =
              item.key !== effectiveCover
                ? null
                : coverKey === null
                  ? "default"
                  : "chosen";
            return (
              <MediaItemTile
                selecting={selecting}
                selected={selectedKeys.includes(item.key)}
                key={item.key}
                count={items.length}
                cover={cover}
                derivation={derivations.get(item.key)?.derivation ?? "none"}
                editedThumbSrc={derivations.get(item.key)?.thumbSrc ?? null}
                index={index}
                item={item}
                loaded={loaded}
                localStill={localStill(item.key)}
                reducedMotion={reducedMotion}
                server={
                  item.itemId === null ? undefined : serverItems[item.itemId]
                }
                view={views.get(item.key)}
                {...actions}
              />
            );
          })}
        </ol>
      </SortableContext>
    </DndContext>
  );
};
