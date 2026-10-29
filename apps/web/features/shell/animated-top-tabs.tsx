"use client";

import { useId, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import styles from "./animated-top-tabs.module.css";

export interface AnimatedTopTab<Key extends string> {
  readonly id: Key;
  readonly label: string;
  readonly icon?: ReactNode;
}

export interface AnimatedTopTabsProps<Key extends string> {
  readonly orientation?: "horizontal" | "vertical";
  readonly items: readonly AnimatedTopTab<Key>[];
  readonly activeKey: Key;
  /** Continuous pager position; omit for click-only tab groups. */
  readonly progress?: number;
  readonly onSelect: (key: Key) => void;
  readonly ariaLabel: string;
  readonly idPrefix?: string;
  readonly tabId?: (key: Key) => string;
  readonly panelId?: (key: Key) => string;
  readonly className?: string;
}

export const AnimatedTopTabs = <Key extends string>({
  orientation = "horizontal",
  items,
  activeKey,
  progress,
  onSelect,
  ariaLabel,
  idPrefix,
  tabId,
  panelId,
  className,
}: AnimatedTopTabsProps<Key>) => {
  const generatedId = useId();
  const viewport = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const buttons = useRef(new Map<Key, HTMLButtonElement>());
  const selectedIndex = Math.max(
    0,
    items.findIndex((item) => item.id === activeKey),
  );
  const position = Math.min(
    Math.max(Number.isFinite(progress) ? progress! : selectedIndex, 0),
    Math.max(0, items.length - 1),
  );
  const progressDriven = progress !== undefined && Number.isFinite(progress);
  const settled = Math.abs(position - selectedIndex) < 0.0001;
  const [indicator, setIndicator] = useState({ left: 0, width: 0 });
  const [labelState, setLabelState] = useState<{
    active: Key;
    expanded: Key | null;
  }>({ active: activeKey, expanded: null });
  let expandedKey = labelState.expanded;
  if (labelState.active !== activeKey) {
    expandedKey = expandedKey === activeKey ? activeKey : null;
    setLabelState({ active: activeKey, expanded: expandedKey });
  }
  const select = (key: Key) => {
    if (orientation === "vertical")
      setLabelState((current) => ({ ...current, expanded: key }));
    onSelect(key);
  };

  useLayoutEffect(() => {
    const measure = () => {
      const container = track.current;
      const left = buttons.current.get(items[Math.floor(position)]?.id as Key);
      const right = buttons.current.get(items[Math.ceil(position)]?.id as Key);
      if (!container || !left || !right) return;
      const start = left.getBoundingClientRect();
      const end = right.getBoundingClientRect();
      const origin = container.getBoundingClientRect().left;
      const fraction = position % 1;
      const next = {
        left: start.left - origin + (end.left - start.left) * fraction,
        width: start.width + (end.width - start.width) * fraction,
      };
      setIndicator((old) =>
        Math.abs(old.left - next.left) < 0.1 &&
        Math.abs(old.width - next.width) < 0.1
          ? old
          : next,
      );
    };
    measure();
    // Width changes during the icon's transition also move neighboring tabs.
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    if (track.current) observer?.observe(track.current);
    buttons.current.forEach((button) => observer?.observe(button));
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [items, position]);

  useLayoutEffect(() => {
    // Do not move the tab strip toward the old selected tab during a swipe.
    if (!settled) return;
    const container = viewport.current;
    const button = buttons.current.get(activeKey);
    if (!container || !button) return;
    const reveal = () => {
      const frame = container.getBoundingClientRect();
      const item = button.getBoundingClientRect();
      // Scroll only this strip. Resize observation also reveals the part that
      // expands after a click, without reacting to manual horizontal scrolling.
      const delta =
        orientation === "vertical"
          ? item.top < frame.top
            ? item.top - frame.top
            : item.bottom > frame.bottom
              ? item.bottom - frame.bottom
              : 0
          : item.left < frame.left
            ? item.left - frame.left
            : item.right > frame.right
              ? item.right - frame.right
              : 0;
      if (delta) {
        if (orientation === "vertical") container.scrollTop += delta;
        else container.scrollLeft += delta;
      }
    };
    reveal();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(reveal);
    observer?.observe(container);
    observer?.observe(button);
    return () => observer?.disconnect();
  }, [activeKey, items, settled, orientation]);

  return (
    <div
      ref={viewport}
      className={`${styles.viewport}${className ? ` ${className}` : ""}`}
      data-animated-top-tabs=""
      data-orientation={orientation}
    >
      <div
        ref={track}
        className={styles.track}
        role="tablist"
        aria-label={ariaLabel}
        aria-orientation={orientation}
        data-progress-driven={progressDriven ? "true" : "false"}
      >
        {items.map(({ id, label, icon }, index) => {
          const selected = id === activeKey;
          const activation = Math.max(0, 1 - Math.abs(index - position));
          return (
            <button
              key={id}
              ref={(node) => {
                if (node) buttons.current.set(id, node);
                else buttons.current.delete(id);
              }}
              type="button"
              role="tab"
              id={tabId?.(id) ?? `${idPrefix ?? generatedId}-tab-${id}`}
              aria-controls={
                panelId?.(id) ??
                (idPrefix ? `${idPrefix}-panel-${id}` : undefined)
              }
              aria-selected={selected}
              aria-label={label}
              title={label}
              tabIndex={selected ? 0 : -1}
              className={styles.tab}
              data-tab-key={id}
              data-label-expanded={
                orientation === "vertical" && expandedKey === id
                  ? "true"
                  : undefined
              }
              style={{ "--top-tab-activation": activation } as CSSProperties}
              onClick={() => select(id)}
              onKeyDown={(event) => {
                const next =
                  event.key ===
                  (orientation === "vertical" ? "ArrowDown" : "ArrowRight")
                    ? (index + 1) % items.length
                    : event.key ===
                        (orientation === "vertical" ? "ArrowUp" : "ArrowLeft")
                      ? (index + items.length - 1) % items.length
                      : event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? items.length - 1
                          : null;
                if (next === null) return;
                const item = items[next];
                if (!item) return;
                event.preventDefault();
                select(item.id);
                buttons.current.get(item.id)?.focus({ preventScroll: true });
              }}
            >
              {icon && (
                <span className={styles.iconSlot} aria-hidden="true">
                  <span className={styles.icon}>{icon}</span>
                </span>
              )}
              <span
                className={styles.labelSlot}
                data-tab-label-slot=""
                aria-hidden={orientation === "vertical" ? true : undefined}
              >
                <span className={styles.label}>{label}</span>
              </span>
            </button>
          );
        })}
        <span
          aria-hidden="true"
          className={styles.indicator}
          data-top-tab-indicator=""
          style={{
            width: indicator.width,
            transform: `translateX(${indicator.left}px)`,
          }}
        />
      </div>
    </div>
  );
};
