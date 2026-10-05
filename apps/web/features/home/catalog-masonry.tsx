"use client";

import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import styles from "./home-screen.module.css";
import {
  layoutHomeMasonry,
  resolveHomeMasonryColumns,
} from "./catalog-masonry-layout";

import type { CSSProperties, ReactNode } from "react";
import type { MediaSlot } from "../media/responsive-media";
import type { FeedLayoutPreference } from "../product-shell/preferences";
import type { PresentationPlatform } from "../shell/device-platform";

/**
 * The slot of the item being rendered, so its image can name the width it is
 * drawn at (`sizes`) without each list passing layout facts down.
 */
const MasonrySlotContext = createContext<MediaSlot | null>(null);

/** The masonry slot of the nearest enclosing item, or null outside a masonry list. */
export const useMasonrySlot = (): MediaSlot | null =>
  useContext(MasonrySlotContext);

interface RenderedLayout {
  readonly height: number;
  readonly keys: readonly string[];
  readonly positions: readonly {
    readonly height: number;
    readonly width: number;
    readonly x: number;
    readonly y: number;
  }[];
  readonly signature: string;
}

export interface CatalogMasonryProps<T> {
  readonly feedLayout: FeedLayoutPreference;
  readonly getKey: (item: T) => string;
  readonly isFullSpan?: (item: T) => boolean;
  readonly spanAtAlignedRows?: boolean;
  readonly items: readonly T[];
  readonly platform: PresentationPlatform;
  /** `index` is the item's list position (the first visible cards load first). */
  readonly renderItem: (
    item: T,
    onMediaSettled: () => void,
    index: number,
  ) => ReactNode;
}

const layoutSignature = (
  width: number,
  columns: number,
  heights: readonly number[],
  spans: readonly boolean[],
  spanAtAlignedRows: boolean,
) =>
  `${width}:${columns}:${heights.join(",")}:${spans.join(",")}:${spanAtAlignedRows}`;

export const CatalogMasonry = <T,>({
  feedLayout,
  getKey,
  isFullSpan = () => false,
  spanAtAlignedRows = false,
  items,
  platform,
  renderItem,
}: CatalogMasonryProps<T>) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<string, HTMLDivElement>());
  const settleFrameRef = useRef<number | null>(null);
  const measurementAvailableRef = useRef(false);
  const [width, setWidth] = useState(0);
  const [revision, setRevision] = useState(0);
  const [renderedLayout, setRenderedLayout] = useState<RenderedLayout | null>(
    null,
  );

  const gap = platform === "tablet" ? 20 : platform === "pc" ? 20 : 12;
  const columns = useMemo(
    () => resolveHomeMasonryColumns(width, gap, platform, feedLayout),
    [feedLayout, gap, platform, width],
  );
  const columnWidth =
    width > 0 ? (width - gap * Math.max(0, columns - 1)) / columns : 0;
  const spans = useMemo(
    () =>
      items.map(
        (item) =>
          platform !== "pc" && feedLayout === "double" && isFullSpan(item),
      ),
    [feedLayout, isFullSpan, items, platform],
  );

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (container === null) return undefined;
    let disposed = false;
    const measure = () => {
      if (disposed || !container.isConnected) return;
      const nextWidth = container.getBoundingClientRect().width;
      if (!Number.isFinite(nextWidth) || nextWidth < 32) {
        measurementAvailableRef.current = false;
        return;
      }
      const becameAvailable = !measurementAvailableRef.current;
      measurementAvailableRef.current = true;
      setWidth((current) =>
        Math.abs(current - nextWidth) <= 0.5 ? current : nextWidth,
      );
      if (becameAvailable) setRevision((current) => current + 1);
    };

    measure();
    const observer =
      typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(container);
    return () => {
      disposed = true;
      observer?.disconnect();
    };
  }, []);

  useLayoutEffect(() => {
    if (width < 32 || columnWidth <= 0) return;
    const measuredWidth = containerRef.current?.getBoundingClientRect().width;
    if (
      measuredWidth === undefined ||
      !Number.isFinite(measuredWidth) ||
      measuredWidth < 32
    ) {
      measurementAvailableRef.current = false;
      return;
    }
    if (Math.abs(measuredWidth - width) > 0.5) return;
    const heights = items.map((item) => {
      const element = itemRefs.current.get(getKey(item));
      return element?.getBoundingClientRect().height ?? 0;
    });
    const keys = items.map(getKey);
    const signature = layoutSignature(
      width,
      columns,
      heights,
      spans,
      spanAtAlignedRows,
    );
    const result = layoutHomeMasonry(
      heights.map((height, index) => ({
        height,
        ...(spans[index] ? { spanAll: true } : {}),
      })),
      width,
      columns,
      gap,
      spanAtAlignedRows,
    );
    setRenderedLayout((current) =>
      current?.signature === signature &&
      current.keys.length === keys.length &&
      current.keys.every((key, index) => key === keys[index])
        ? current
        : { ...result, keys, signature },
    );
  }, [
    columnWidth,
    columns,
    gap,
    getKey,
    items,
    revision,
    spans,
    spanAtAlignedRows,
    width,
  ]);

  const onMediaSettled = useCallback(() => {
    if (settleFrameRef.current !== null) {
      window.cancelAnimationFrame(settleFrameRef.current);
    }
    settleFrameRef.current = window.requestAnimationFrame(() => {
      settleFrameRef.current = null;
      setRevision((value) => value + 1);
    });
  }, []);

  // Adaptive span widths can change image/text height after placement.
  useLayoutEffect(() => {
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(onMediaSettled);
    for (const element of itemRefs.current.values()) observer.observe(element);
    return () => observer.disconnect();
  }, [items, onMediaSettled]);

  useLayoutEffect(
    () => () => {
      if (settleFrameRef.current !== null) {
        window.cancelAnimationFrame(settleFrameRef.current);
      }
    },
    [],
  );
  const keys = items.map(getKey);
  const retainsPrefix =
    renderedLayout !== null &&
    renderedLayout.keys.length <= keys.length &&
    renderedLayout.keys.every((key, index) => key === keys[index]);
  const ready =
    renderedLayout !== null &&
    retainsPrefix &&
    renderedLayout.positions.length === items.length &&
    renderedLayout.signature.startsWith(`${width}:${columns}:`);
  // Appending a page must not briefly collapse the scroller to one pixel.
  // Retain only a matching identity prefix while the new items are measured.
  const retainedLayout = retainsPrefix ? renderedLayout : null;

  return (
    <div
      ref={containerRef}
      className={styles.masonry}
      data-home-masonry=""
      data-span-aligned-rows={spanAtAlignedRows ? "" : undefined}
      data-layout-ready={ready ? "true" : "false"}
      data-layout-retained={!ready && retainedLayout !== null ? "" : undefined}
      data-masonry-columns={columns}
      role="list"
      style={{ height: retainedLayout?.height ?? 1 }}
    >
      {items.map((item, index) => {
        const key = getKey(item);
        const position = retainedLayout?.positions[index];
        const startsFull = spanAtAlignedRows && columns === 2 && index === 0;
        const itemWidth = startsFull || spans[index] ? width : columnWidth;
        const spansAll = position?.width === width && columns > 1;
        const style = {
          left: position?.x ?? 0,
          top: position?.y ?? 0,
          visibility: position === undefined ? "hidden" : "visible",
          width: ready ? (position?.width ?? itemWidth) : itemWidth,
        } satisfies CSSProperties;
        return (
          <div
            key={key}
            ref={(element) => {
              if (element === null) itemRefs.current.delete(key);
              else itemRefs.current.set(key, element);
            }}
            className={styles.masonryItem}
            data-home-masonry-item=""
            data-home-masonry-span={spansAll ? "full" : undefined}
            role="presentation"
            style={style}
          >
            <MasonrySlotContext.Provider
              value={{
                platform,
                columns,
                span: startsFull || spans[index] === true || spansAll,
              }}
            >
              {renderItem(item, onMediaSettled, index)}
            </MasonrySlotContext.Provider>
          </div>
        );
      })}
    </div>
  );
};
