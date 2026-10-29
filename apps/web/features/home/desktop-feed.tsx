"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  desktopFeedMedia,
  layoutDesktopFeedBatches,
} from "./desktop-feed-layout";
import { desktopLayout } from "@moya/design-tokens";
import styles from "./desktop-feed.module.css";
import type { ReactNode } from "react";
import type { DesktopFeedPosition } from "./desktop-feed-layout";

export const DesktopFeed = <T,>({
  items,
  getKey,
  renderItem,
}: {
  readonly items: readonly T[];
  readonly getKey: (item: T) => string;
  readonly renderItem: (
    item: T,
    index: number,
    slot: DesktopFeedPosition,
  ) => ReactNode;
}) => {
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const keys = items.map(getKey);
  const [partition, setPartition] = useState({
    keys,
    ends: items.length ? [items.length] : [],
  });
  let ends = partition.ends;
  if (
    keys.length !== partition.keys.length ||
    keys.some((key, index) => key !== partition.keys[index])
  ) {
    const appended =
      keys.length > partition.keys.length &&
      partition.keys.every((key, index) => key === keys[index]);
    ends = appended
      ? [...partition.ends, keys.length]
      : keys.length
        ? [keys.length]
        : [];
    setPartition({ keys, ends });
  }
  useLayoutEffect(() => {
    const measure = () => {
      const next = host.current?.getBoundingClientRect().width ?? 0;
      if (next > 0)
        setWidth((current) =>
          Math.abs(next - current) > 0.5 ? next : current,
        );
    };
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    if (host.current) observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  const layout = useMemo(
    () => layoutDesktopFeedBatches(items.map(desktopFeedMedia), width, ends),
    [items, width, ends],
  );
  return (
    <div
      ref={host}
      role="list"
      className={styles.feed}
      data-desktop-feed=""
      data-layout-ready={width > 0 ? "true" : "false"}
      style={width > 0 ? { height: layout.height } : undefined}
    >
      {items.map((item, index) => {
        const media = desktopFeedMedia(item);
        const mediaWidth = (media.ratio ?? 0) * desktopLayout.feed.rowHeight;
        const position = layout.positions[index] ?? {
          ...media,
          x: 0,
          y: 0,
          width:
            media.ratio === null
              ? desktopLayout.feed.textWidth
              : mediaWidth + desktopLayout.feed.labelWidth,
          height: desktopLayout.feed.rowHeight,
          mediaWidth,
        };
        return position ? (
          <div
            key={getKey(item)}
            className={styles.item}
            data-desktop-feed-item=""
            data-analytics-position={index + 1}
            role="presentation"
            style={{
              left: position.x,
              top: position.y,
              width: position.width,
              height: position.height,
            }}
          >
            {renderItem(item, index, position)}
          </div>
        ) : null;
      })}
    </div>
  );
};
