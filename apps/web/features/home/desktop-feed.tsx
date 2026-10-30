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
  height: number;
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
  // An active empty list legitimately measures zero height. Only its width
  // and cover state determine whether its presentation can accept new data.
  return !(top && !top.contains(node)) && box.width > 0;
};
const ready = (node: HTMLElement) =>
  eligible(node) && !node.closest("[data-scroll-restoring]");
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
  const [measuredWidth, setWidth] = useState(0);
  const [holding, setHolding] = useState(false);
  const holdingRef = useRef(false);
  // Presentation references only: pending data stays with its existing owner.
  const displayed = useRef({ items, getKey, renderItem, width: 0 });
  const visible = holding
    ? displayed.current
    : { items, getKey, renderItem, width: measuredWidth };
  const width = visible.width;
  const keys = visible.items.map(visible.getKey);
  const keySignature = keys.join("\u0000");
  const committed = useRef({ keys, width: 0 });
  const anchor = useRef<ViewportAnchor | null>(null);
  const capture = useRef<() => void>(() => undefined);
  const inputRevision = useRef(0);
  const followup = useRef<number | null>(null);
  const visibilityFrame = useRef<number | null>(null);
  const checkVisibility = useRef<() => void>(() => undefined);
  const hold = () => {
    if (visibilityFrame.current !== null)
      window.cancelAnimationFrame(visibilityFrame.current);
    visibilityFrame.current = null;
    if (!holdingRef.current) {
      holdingRef.current = true;
      setHolding(true);
    }
  };
  const pendingLayout = useMemo(
    () => layoutDesktopFeed(items.map(desktopFeedMedia), measuredWidth),
    [items, measuredWidth],
  );
  const layout = useMemo(
    () =>
      holding
        ? layoutDesktopFeed(visible.items.map(desktopFeedMedia), width)
        : pendingLayout,
    [holding, visible.items, width, pendingLayout],
  );
  // Advance an existing pagination footer without mounting covered cards.
  // Never shrink the old extent while the shell restores its physical offset.
  const height = holding
    ? Math.max(layout.height, pendingLayout.height)
    : layout.height;

  useLayoutEffect(() => {
    const remember = () => {
      const root = host.current;
      if (!root || !ready(root)) return;
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
      const box = selected?.node.getBoundingClientRect();
      anchor.current =
        selected && box
          ? {
              key: selected.key,
              offset: box.top - frame.top,
              height: box.height,
              owner,
            }
          : null;
    };
    capture.current = remember;
    const queueVisibility = () => {
      if (visibilityFrame.current !== null) return;
      visibilityFrame.current = window.requestAnimationFrame(() => {
        visibilityFrame.current = null;
        const root = host.current;
        if (!root || !ready(root)) {
          if (root) hold();
          return;
        }
        if (!holdingRef.current) return;
        // The shell's physical restore owns its complete, bounded lifecycle.
        // Only after its marker clears do two quiet frames settle focus/layout.
        visibilityFrame.current = window.requestAnimationFrame(() => {
          visibilityFrame.current = null;
          const current = host.current;
          if (!current || !ready(current)) {
            if (current) hold();
            return;
          }
          remember();
          holdingRef.current = false;
          setHolding(false);
        });
      });
    };
    checkVisibility.current = queueVisibility;
    const visibilityObserver = new MutationObserver(queueVisibility);
    visibilityObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: [
        "hidden",
        "inert",
        "aria-hidden",
        "open",
        "data-scroll-restoring",
      ],
      childList: true,
      subtree: true,
    });
    const measure = () => {
      remember();
      const next = host.current?.getBoundingClientRect().width ?? 0;
      if (next > 0)
        setWidth((current) =>
          Math.abs(next - current) > 0.5 ? next : current,
        );
      // CSS can reveal the same measured width without an attribute mutation
      // or a React state change; release its held presentation then as well.
      queueVisibility();
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
      visibilityObserver.disconnect();
      if (visibilityFrame.current !== null)
        window.cancelAnimationFrame(visibilityFrame.current);
      visibilityFrame.current = null;
      checkVisibility.current = () => undefined;
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
    if (!root || !ready(root) || holdingRef.current) {
      if (followup.current !== null)
        window.cancelAnimationFrame(followup.current);
      followup.current = null;
      if (root && !ready(root)) hold();
      else checkVisibility.current();
      // A modal and append can commit together. Re-render the last eligible
      // snapshot synchronously before paint; never commit the covered geometry.
      return;
    }
    const previous = committed.current;
    const sameSourcePrefix =
      keys.length >= previous.keys.length &&
      previous.keys.every((key, index) => keys[index] === key);
    const saved = anchor.current;
    const canRestore =
      root &&
      ready(root) &&
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
          !ready(host.current) ||
          scrollOwner(host.current) !== saved.owner
        )
          return false;
        const node = nodes.current.get(saved.key);
        if (!node) return false;
        const box = node.getBoundingClientRect();
        // A much shorter row must not leave the previously visible card
        // wholly above the viewport. Keep its clipped reading proportion then;
        // otherwise retain the existing exact top offset.
        const offset =
          saved.offset < 0 && box.height + saved.offset <= 0 && saved.height > 0
            ? (saved.offset * box.height) / saved.height
            : saved.offset;
        const delta = box.top - viewport(saved.owner).top - offset;
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
    }
    committed.current = { keys, width };
    displayed.current = visible;
    capture.current();
  }, [layout, width, keySignature, holding]);

  return (
    <div
      ref={host}
      role="list"
      className={styles.feed}
      data-desktop-feed=""
      data-layout-ready={width > 0 ? "true" : "false"}
      style={width > 0 ? { height } : undefined}
    >
      {visible.items.map((item, index) => {
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
        const key = visible.getKey(item);
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
            {visible.renderItem(item, index, position)}
          </div>
        );
      })}
    </div>
  );
};
