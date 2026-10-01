"use client";
import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { Icon, Spinner } from "@moya/ui";
import styles from "./notifications.module.css";

// Gesture distances, not shared visual spacing. The visible pull has resistance.
const threshold = 60;
const maximum = 80;
const slop = 8;
const edge = 24;
type Phase = "idle" | "pulling" | "ready" | "refreshing";
export function NotificationRefresher({
  scrollRef,
  loading,
  onRefresh,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  loading: boolean;
  onRefresh: () => Promise<void>;
}) {
  const latest = useRef({ loading, onRefresh });
  latest.current = { loading, onRefresh };
  const trigger = useRef(() => {});
  const [phase, setPhase] = useState<Phase>("idle");
  const [distance, setDistance] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    let alive = true,
      refreshing = false,
      consumed = false,
      pulled = 0;
    let origin: { x: number; y: number; id: number } | null = null;
    const reset = () => {
      origin = null;
      pulled = 0;
      setDistance(0);
      if (!refreshing) setPhase("idle");
    };
    const run = async () => {
      if (refreshing || latest.current.loading) return;
      refreshing = true;
      origin = null;
      setFailed(false);
      setPhase("refreshing");
      try {
        await latest.current.onRefresh();
      } catch {
        if (alive) setFailed(true);
      } finally {
        if (alive) {
          refreshing = false;
          reset();
        }
      }
    };
    trigger.current = () => void run();
    const start = (event: TouchEvent) => {
      consumed = false;
      if (refreshing) return;
      reset();
      if (
        latest.current.loading ||
        event.touches.length !== 1 ||
        scroll.scrollTop > 0
      )
        return;
      if (
        event.target instanceof Element &&
        event.target.closest(
          'input, textarea, select, [contenteditable="true"], [role="tab"]',
        )
      )
        return;
      const point = event.touches[0]!;
      const bounds = scroll.getBoundingClientRect();
      if (
        point.clientX < bounds.left + edge ||
        point.clientX > bounds.right - edge
      )
        return;
      origin = { x: point.clientX, y: point.clientY, id: point.identifier };
    };
    const move = (event: TouchEvent) => {
      if (!origin || refreshing) return;
      const point = Array.from(event.touches).find(
        (touch) => touch.identifier === origin!.id,
      );
      if (event.touches.length !== 1 || !point || scroll.scrollTop > 0) {
        reset();
        return;
      }
      const x = point.clientX - origin.x,
        y = point.clientY - origin.y;
      if (!consumed && Math.max(Math.abs(x), Math.abs(y)) < slop) return;
      if (!consumed && (y <= 0 || Math.abs(x) >= y)) {
        reset();
        return;
      }
      if (!event.cancelable) {
        reset();
        return;
      }
      event.preventDefault();
      consumed = true;
      pulled = Math.min(maximum, Math.max(0, (y - slop) * 0.5));
      setDistance(pulled);
      setPhase(pulled >= threshold ? "ready" : "pulling");
    };
    const end = () => {
      if (!origin) return;
      const ready = pulled >= threshold;
      reset();
      if (ready) void run();
    };
    const click = (event: MouseEvent) => {
      // Do not let a consumed drag activate the underlying notification row.
      if (consumed && event.detail > 0) {
        consumed = false;
        event.preventDefault();
        event.stopPropagation();
      }
    };
    scroll.addEventListener("touchstart", start, { passive: true });
    scroll.addEventListener("touchmove", move, { passive: false });
    scroll.addEventListener("touchend", end);
    scroll.addEventListener("touchcancel", reset);
    scroll.addEventListener("click", click, true);
    return () => {
      alive = false;
      trigger.current = () => {};
      scroll.removeEventListener("touchstart", start);
      scroll.removeEventListener("touchmove", move);
      scroll.removeEventListener("touchend", end);
      scroll.removeEventListener("touchcancel", reset);
      scroll.removeEventListener("click", click, true);
    };
  }, [scrollRef]);
  const label =
    phase === "refreshing"
      ? "正在刷新消息"
      : phase === "ready"
        ? "松开刷新"
        : phase === "pulling"
          ? "下拉刷新"
          : "";
  return (
    <>
      <button
        type="button"
        className={styles.accessibleRefresh}
        disabled={loading || phase === "refreshing"}
        onClick={() => trigger.current()}
      >
        刷新消息
      </button>
      <div
        className={styles.pullIndicator}
        data-notification-refresh={phase}
        style={{
          height: phase === "refreshing" ? "var(--yoyi-space-10)" : distance,
        }}
        aria-hidden="true"
      >
        {phase === "refreshing" ? (
          <Spinner size="sm" />
        ) : (
          <span
            className={styles.pullProgress}
            style={{
              transform: `rotate(${Math.min(distance / threshold, 1) * 270}deg)`,
              opacity: Math.min(distance / threshold, 1),
            }}
          >
            <Icon name="loading" />
          </span>
        )}
      </div>
      <span
        className={styles.refreshAnnouncement}
        role="status"
        aria-live="polite"
      >
        {label}
      </span>
      {failed && (
        <p className={styles.status} role="alert">
          刷新失败，请下拉重试。
        </p>
      )}
    </>
  );
}
