"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { desktopFeedMedia, layoutDesktopFeed } from "./desktop-feed-layout";
import { desktopLayout } from "@moya/design-tokens";
import styles from "./desktop-feed.module.css";
import type { ReactNode } from "react";
import type { DesktopFeedPosition } from "./desktop-feed-layout";

interface ViewportAnchor {
  key: string;
  offset: number;
  owner: HTMLElement;
}
const documentScroller = () =>
  (document.scrollingElement ?? document.documentElement) as HTMLElement;
/** Match the browser's existing owner, including an author's independently scrolling profile. */
const scrollOwner = (node: HTMLElement) => {
  for (
    let parent = node.parentElement;
    parent && parent !== document.body;
    parent = parent.parentElement
  )
    if (/^(auto|scroll)$/.test(getComputedStyle(parent).overflowY))
      return parent;
  return documentScroller();
};
const eligible = (node: HTMLElement) => {
  if (node.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  const dialogs = document.querySelectorAll<HTMLDialogElement>("dialog[open]");
  const top = dialogs.item(dialogs.length - 1);
  const box = node.getBoundingClientRect();
  return !(top && !top.contains(node)) && box.width > 0 && box.height > 0;
};
const viewport = (owner: HTMLElement) =>
  owner === documentScroller()
    ? { top: 0, bottom: window.innerHeight }
    : {
        top: owner.getBoundingClientRect().top + owner.clientTop,
        bottom:
          owner.getBoundingClientRect().top +
          owner.clientTop +
          owner.clientHeight,
      };

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
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const [width, setWidth] = useState(0);
  const keys = items.map(getKey);
  const keySignature = keys.join("\u0000");
  const committed = useRef({ keys, width: 0 });
  const anchor = useRef<ViewportAnchor | null>(null);
  const capture = useRef<() => void>(() => undefined);
  const inputRevision = useRef(0);
  const followup = useRef<number | null>(null);
  const layout = useMemo(
    () => layoutDesktopFeed(items.map(desktopFeedMedia), width),
    [items, width],
  );

  useLayoutEffect(() => {
    const remember = () => {
      const root = host.current;
      if (!root || !eligible(root)) return;
      const owner = scrollOwner(root),
        frame = viewport(owner);
      const available = committed.current.keys
        .map((key) => ({ key, node: nodes.current.get(key) }))
        .filter(
          (entry): entry is { key: string; node: HTMLDivElement } =>
            !!entry.node,
        )
        .filter(({ node }) => {
          const box = node.getBoundingClientRect();
          return box.bottom > frame.top && box.top < frame.bottom;
        });
      const selected =
        available.find(({ node }) => node.contains(document.activeElement)) ??
        available[0];
      anchor.current = selected
        ? {
            key: selected.key,
            offset: selected.node.getBoundingClientRect().top - frame.top,
            owner,
          }
        : null;
    };
    capture.current = remember;
    const measure = () => {
      remember();
      const next = host.current?.getBoundingClientRect().width ?? 0;
      if (next > 0)
        setWidth((current) =>
          Math.abs(next - current) > 0.5 ? next : current,
        );
    };
    const input = () => {
      inputRevision.current += 1;
    };
    window.addEventListener("scroll", remember, {
      capture: true,
      passive: true,
    });
    for (const name of [
      "wheel",
      "pointerdown",
      "touchstart",
      "keydown",
    ] as const)
      window.addEventListener(name, input, { capture: true, passive: true });
    measure();
    const observer =
      typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    if (host.current) observer?.observe(host.current);
    return () => {
      observer?.disconnect();
      window.removeEventListener("scroll", remember, true);
      for (const name of [
        "wheel",
        "pointerdown",
        "touchstart",
        "keydown",
      ] as const)
        window.removeEventListener(name, input, true);
      if (followup.current !== null)
        window.cancelAnimationFrame(followup.current);
    };
  }, []);

  useLayoutEffect(() => {
    const root = host.current;
    const previous = committed.current;
    const sameSourcePrefix =
      keys.length >= previous.keys.length &&
      previous.keys.every((key, index) => keys[index] === key);
    const saved = anchor.current;
    const canRestore =
      root &&
      eligible(root) &&
      previous.width > 0 &&
      width > 0 &&
      sameSourcePrefix &&
      saved &&
      saved.owner === scrollOwner(root);
    if (followup.current !== null)
      window.cancelAnimationFrame(followup.current);
    followup.current = null;
    if (canRestore) {
      const restore = () => {
        if (
          !host.current ||
          !eligible(host.current) ||
          scrollOwner(host.current) !== saved.owner
        )
          return false;
        const node = nodes.current.get(saved.key);
        if (!node) return false;
        const delta =
          node.getBoundingClientRect().top -
          viewport(saved.owner).top -
          saved.offset;
        if (Math.abs(delta) <= 0.5) return false;
        const desired = saved.owner.scrollTop + delta;
        const maximum = Math.max(
          0,
          saved.owner.scrollHeight - saved.owner.clientHeight,
        );
        saved.owner.scrollTop = Math.min(maximum, Math.max(0, desired));
        return Math.abs(saved.owner.scrollTop - desired) > 0.75;
      };
      // Do not compete with browser anchoring: compensate only the remaining measured delta.
      const clamped = restore();
      if (clamped) {
        const revision = inputRevision.current;
        followup.current = window.requestAnimationFrame(() => {
          followup.current = null;
          if (inputRevision.current === revision) restore();
          capture.current();
        });
      }
    } else if (!root || !eligible(root)) anchor.current = null;
    committed.current = { keys, width };
    capture.current();
  }, [layout, width, keySignature]);

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
        const key = getKey(item);
        return (
          <div
            key={key}
            ref={(node) => {
              if (node) nodes.current.set(key, node);
              else nodes.current.delete(key);
            }}
            className={styles.item}
            data-desktop-feed-item=""
            data-desktop-feed-key={key}
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
        );
      })}
    </div>
  );
};
