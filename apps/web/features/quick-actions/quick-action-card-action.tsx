"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  resolveQuickActionCandidate,
  resolveQuickActionLayout,
} from "./quick-action-layout";
import styles from "./quick-action-menu.module.css";

import type { CSSProperties, ReactNode } from "react";
import { quickActionContentKey } from "./quick-action-types";
import type {
  ContentQuickActionEnvironment,
  QuickActionContent,
  QuickActionName,
} from "./quick-action-types";
import type {
  QuickActionLayout,
  QuickActionPoint,
} from "./quick-action-layout";

interface Session {
  readonly pointerId: number;
  readonly anchor: QuickActionPoint;
  layout: QuickActionLayout | null;
  candidate: QuickActionName | null;
  dispose: () => void;
}

export const QUICK_ACTION_GESTURE_TIMING = {
  longPressMs: 400,
  holdingFeedbackMs: 220,
  movementTolerance: 10,
} as const;

export const QuickActionCardAction = ({
  className,
  content,
  environment,
  onActivate,
  children,
  topicKind,
}: {
  readonly className: string | undefined;
  readonly content: QuickActionContent;
  readonly children?: ReactNode;
  readonly topicKind?: string;
  readonly environment: ContentQuickActionEnvironment;
  readonly onActivate?: (opener: HTMLButtonElement) => void;
}) => {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const sessionRef = useRef<Session | null>(null);
  const suppressPointerClick = useRef(false);
  const latest = useRef({ content, environment });
  latest.current = { content, environment };
  const contentKey = quickActionContentKey(content);
  const [view, setView] = useState<{
    layout: QuickActionLayout;
    candidate: QuickActionName | null;
  } | null>(null);
  const [holding, setHolding] = useState(false);
  const [shareFeedback, setShareFeedback] = useState(false);

  const finish = (suppress = true) => {
    const session = sessionRef.current;
    sessionRef.current = null;
    session?.dispose();
    if (suppress && session) suppressPointerClick.current = true;
    setView(null);
    setHolding(false);
  };

  useEffect(() => {
    setView(null);
    setHolding(false);
    setShareFeedback(false);
    return () => {
      const session = sessionRef.current;
      sessionRef.current = null;
      session?.dispose();
      if (session) suppressPointerClick.current = true;
    };
  }, [contentKey]);

  useEffect(() => {
    if (!shareFeedback) return;
    const timer = window.setTimeout(() => setShareFeedback(false), 1800);
    return () => window.clearTimeout(timer);
  }, [shareFeedback]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={className}
        aria-label={
          onActivate
            ? `打开${content.title}`
            : `长按${content.title}使用快捷操作`
        }
        data-open-catalog={content.kind === "catalog" ? "" : undefined}
        data-topic-card={content.kind === "topic" ? "" : undefined}
        data-topic-id={content.kind === "topic" ? content.id : undefined}
        data-topic-kind={topicKind}
        data-quick-action-content-kind={content.kind}
        data-quick-actions="enabled"
        data-quick-action-phase={
          view ? "menu-open" : holding ? "holding" : "idle"
        }
        onClick={(event) => {
          if (event.detail !== 0 && suppressPointerClick.current) {
            suppressPointerClick.current = false;
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          finish(false);
          suppressPointerClick.current = false;
          onActivate?.(event.currentTarget);
        }}
        onKeyDown={() => {
          finish();
        }}
        onContextMenu={(event) => event.preventDefault()}
        onDragStart={(event) => event.preventDefault()}
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0) return;
          finish(false);
          suppressPointerClick.current = false;
          setShareFeedback(false);
          const button = event.currentTarget;
          const inverseScale = 1 / (window.visualViewport?.scale ?? 1);
          const session: Session = {
            pointerId: event.pointerId,
            anchor: { x: event.clientX, y: event.clientY },
            layout: null,
            candidate: null,
            dispose: () => undefined,
          };
          sessionRef.current = session;
          const active = () => sessionRef.current === session;
          const cancel = () => {
            if (active()) finish();
          };
          const interactive = () =>
            button.isConnected &&
            button.closest('[hidden], [inert], [aria-hidden="true"]') === null;
          const feedbackTimer = window.setTimeout(() => {
            if (active()) setHolding(true);
          }, QUICK_ACTION_GESTURE_TIMING.holdingFeedbackMs);
          const timer = window.setTimeout(() => {
            if (
              !active() ||
              !interactive() ||
              document.visibilityState === "hidden"
            ) {
              cancel();
              return;
            }
            const viewport = window.visualViewport;
            const style = getComputedStyle(button);
            const inset = (side: string) =>
              Number.parseFloat(
                style.getPropertyValue(`--quick-action-safe-${side}`),
              ) || 0;
            session.layout = resolveQuickActionLayout(session.anchor, {
              scale: viewport?.scale ?? 1,
              width: viewport?.width ?? window.innerWidth,
              height: viewport?.height ?? window.innerHeight,
              offsetLeft: viewport?.offsetLeft ?? 0,
              offsetTop: viewport?.offsetTop ?? 0,
              insets: {
                top: inset("top"),
                right: inset("right"),
                bottom: inset("bottom"),
                left: inset("left"),
              },
            });
            try {
              button.setPointerCapture(session.pointerId);
            } catch {
              /* Browser may already have cancelled. */
            }
            setView({ layout: session.layout, candidate: null });
          }, QUICK_ACTION_GESTURE_TIMING.longPressMs);
          const move = (e: PointerEvent) => {
            if (!active() || e.pointerId !== session.pointerId) return;
            const point = { x: e.clientX, y: e.clientY };
            if (!session.layout) {
              if (
                Math.hypot(
                  point.x - session.anchor.x,
                  point.y - session.anchor.y,
                ) >
                QUICK_ACTION_GESTURE_TIMING.movementTolerance * inverseScale
              )
                cancel();
              return;
            }
            session.candidate = resolveQuickActionCandidate(
              point,
              session.layout,
              session.candidate,
            );
            setView({ layout: session.layout, candidate: session.candidate });
          };
          const up = (e: PointerEvent) => {
            if (!active() || e.pointerId !== session.pointerId) return;
            const layout = session.layout;
            const action = layout
              ? resolveQuickActionCandidate(
                  { x: e.clientX, y: e.clientY },
                  layout,
                  session.candidate,
                )
              : null;
            finish(layout !== null);
            if (action) {
              const result = latest.current.environment.onAction(
                action,
                latest.current.content,
              );
              if (action === "share" && result === undefined)
                setShareFeedback(true);
              if (result instanceof Promise) void result.catch(() => undefined);
            }
          };
          const pointerCancel = (e: PointerEvent) => {
            if (e.pointerId === session.pointerId) cancel();
          };
          const additionalPointer = (e: PointerEvent) => {
            if (e.pointerId !== session.pointerId) cancel();
          };
          const touchStart = (e: TouchEvent) => {
            if (e.touches.length > 1) cancel();
          };
          const touchMove = (e: TouchEvent) => {
            if (e.touches.length > 1) {
              cancel();
              return;
            }
            if (active() && session.layout && e.cancelable) e.preventDefault();
          };
          const blur = (e: FocusEvent) => {
            // Focusing this button after pointerdown blurs the previous
            // control. Only this card or the window losing focus cancels it.
            if (e.target === e.currentTarget || e.target === button) cancel();
          };
          const visibility = () => {
            if (document.visibilityState !== "visible") cancel();
          };
          const observer = new MutationObserver(() => {
            if (!interactive()) cancel();
          });
          for (
            let node: HTMLElement | null = button;
            node;
            node = node.parentElement
          ) {
            observer.observe(node, {
              attributes: true,
              attributeFilter: ["hidden", "inert", "aria-hidden"],
              childList: true,
            });
          }
          window.addEventListener("pointermove", move, true);
          window.addEventListener("pointerup", up, true);
          window.addEventListener("pointercancel", pointerCancel, true);
          window.addEventListener("pointerdown", additionalPointer, true);
          window.addEventListener("touchstart", touchStart, {
            capture: true,
            passive: true,
          });
          button.addEventListener("touchmove", touchMove, { passive: false });
          button.addEventListener("lostpointercapture", pointerCancel);
          document.addEventListener("visibilitychange", visibility);
          window.addEventListener("blur", blur, true);
          const interruptions = [
            "pagehide",
            "resize",
            "orientationchange",
            "scroll",
            "wheel",
            "keydown",
          ] as const;
          for (const type of interruptions)
            window.addEventListener(type, cancel, true);
          window.visualViewport?.addEventListener("resize", cancel);
          window.visualViewport?.addEventListener("scroll", cancel);
          session.dispose = () => {
            window.clearTimeout(timer);
            window.clearTimeout(feedbackTimer);
            observer.disconnect();
            window.removeEventListener("pointermove", move, true);
            window.removeEventListener("pointerup", up, true);
            window.removeEventListener("pointercancel", pointerCancel, true);
            window.removeEventListener("pointerdown", additionalPointer, true);
            window.removeEventListener("touchstart", touchStart, true);
            button.removeEventListener("touchmove", touchMove);
            button.removeEventListener("lostpointercapture", pointerCancel);
            document.removeEventListener("visibilitychange", visibility);
            window.removeEventListener("blur", blur, true);
            for (const type of interruptions)
              window.removeEventListener(type, cancel, true);
            window.visualViewport?.removeEventListener("resize", cancel);
            window.visualViewport?.removeEventListener("scroll", cancel);
            if (button.hasPointerCapture?.(session.pointerId))
              button.releasePointerCapture(session.pointerId);
          };
        }}
      >
        {children}
      </button>
      {view &&
        createPortal(
          <div
            className={styles.overlay}
            style={
              {
                "--quick-action-inverse-scale": view.layout.inverseScale,
              } as CSSProperties
            }
            data-quick-action-menu=""
            role="group"
            aria-label="QA 内容快捷操作"
          >
            <span
              className={styles.center}
              style={{ left: view.layout.anchor.x, top: view.layout.anchor.y }}
            />
            {view.layout.positions.map((p) => {
              const selected = p.action === view.candidate;
              const active =
                p.action === "like"
                  ? environment.likedIds.includes(contentKey)
                  : p.action === "favorite"
                    ? environment.favoriteIds.includes(contentKey)
                    : false;
              const label =
                p.action === "like"
                  ? "喜欢"
                  : p.action === "favorite"
                    ? "收藏"
                    : "分享";
              return (
                <span
                  key={p.action}
                  className={styles.target}
                  style={{ left: p.x, top: p.y }}
                  data-quick-action={p.action}
                  data-candidate={selected}
                  data-state-active={active}
                  aria-label={`${active ? "取消" : ""}${label}`}
                >
                  <span className={`${styles.bubble} yoyi-functional-glass`}>
                    <QuickActionIcon
                      action={p.action}
                      filled={
                        p.action !== "share" && (selected ? !active : active)
                      }
                    />
                  </span>
                </span>
              );
            })}
          </div>,
          document.body,
        )}
      {shareFeedback && (
        <span
          className={styles.feedback}
          role="status"
          data-quick-action-feedback=""
        >
          QA：分享动作已触发（未分享）
        </span>
      )}
    </>
  );
};

/** The heart of the like action, also drawn by a post's double-tap burst. */
export const QUICK_ACTION_LIKE_PATH =
  "M12 20.4 4.5 13.2C1.1 9.9 3 4.5 7.5 4.5c1.9 0 3.5 1 4.5 2.4 1-1.4 2.6-2.4 4.5-2.4 4.5 0 6.4 5.4 3 8.7L12 20.4Z";

/** Shared with Detail so action symbols remain identical to the long-press menu. */
export const QuickActionIcon = ({
  action,
  filled = false,
}: {
  readonly action: QuickActionName;
  readonly filled?: boolean;
}) => (
  <svg
    aria-hidden="true"
    className={styles.icon}
    data-filled={filled}
    viewBox="0 0 24 24"
  >
    <path
      d={
        action === "like"
          ? QUICK_ACTION_LIKE_PATH
          : action === "favorite"
            ? "m12 3.2 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9L6.6 20l1-6.1-4.4-4.3 6.1-.9L12 3.2Z"
            : "M20.5 6.4 14.8 2v3.3C8.3 5.8 4.5 9 3.5 15.5c2.2-3.2 5.8-4.8 11.3-4.8V14l5.7-4.4V6.4Z"
      }
    />
  </svg>
);
