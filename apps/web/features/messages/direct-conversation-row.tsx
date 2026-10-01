"use client";
import { useId, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent, ReactNode } from "react";
import styles from "../authors/message-preview.module.css";

/*
 * content-community-completion-v1: one real conversation row with the accepted
 * two-action swipe model (authors/message-preview ConversationRow): the front
 * covers the mute and delete actions until a left swipe or ArrowLeft reveals
 * them; ArrowRight, Escape or activating the row closes them again. Only one
 * row is open at a time; the list owns that state.
 */
const TRASH_SNAP = 72;
const FULL_SNAP = 136;

const ActionIcon = ({ kind }: { kind: "trash" | "bell" | "bell-off" }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    {kind === "trash" ? (
      <path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 10v7M14 10v7" />
    ) : kind === "bell-off" ? (
      <path d="M9.7 4.5A5.5 5.5 0 0 1 17.5 10v3.1M6.5 6.5A5.5 5.5 0 0 0 6.5 10v4L4 17h13M10 20h4M3 3l18 18" />
    ) : (
      <path d="M6.5 10a5.5 5.5 0 0 1 11 0v4l2.5 3H4l2.5-3v-4ZM10 20h4M12 3v1.5" />
    )}
  </svg>
);

export const MutedMark = () => (
  <span className={styles.mutedMark} role="img" aria-label="已静音">
    <ActionIcon kind="bell-off" />
  </span>
);

export const DirectConversationRow = ({
  id,
  name,
  avatar,
  muted,
  label,
  expanded,
  onExpand,
  onOpen,
  onOpenProfile,
  onMute,
  onHide,
  children,
}: {
  id: string;
  name: string;
  avatar: ReactNode;
  muted: boolean;
  /** The conversation button's accessible name. */
  label: string;
  expanded: boolean;
  onExpand: (value: boolean) => void;
  onOpen: () => void;
  onOpenProfile: (opener: HTMLElement) => void;
  onMute: () => void;
  onHide: () => void;
  /** Heading and preview inside the conversation button. */
  children: ReactNode;
}) => {
  const instructionsId = useId();
  const actionsId = useId();
  const conversationButton = useRef<HTMLButtonElement>(null);
  const muteButton = useRef<HTMLButtonElement>(null);
  const front = useRef<HTMLDivElement>(null);
  const gesture = useRef<{
    pointerId: number;
    x: number;
    y: number;
    base: number;
    offset: number;
    horizontal: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const [restOffset, setRestOffset] = useState(FULL_SNAP);
  const [dragOffset, setDragOffset] = useState<number | null>(null);
  const dragging = dragOffset !== null;
  const offset = dragOffset ?? (expanded ? restOffset : 0);
  const clamp = (value: number) => Math.max(0, Math.min(FULL_SNAP, value));
  const trashProgress = Math.max(0, Math.min(1, (offset - 8) / 52));
  const muteProgress = Math.max(0, Math.min(1, (offset - 72) / 52));
  const trashAvailable = !dragging && expanded && offset >= TRASH_SNAP;
  const muteAvailable = !dragging && expanded && offset >= FULL_SNAP;

  useLayoutEffect(() => {
    if (expanded || !gesture.current?.horizontal) return;
    const pointerId = gesture.current.pointerId;
    gesture.current = null;
    setDragOffset(null);
    if (front.current?.hasPointerCapture?.(pointerId))
      front.current.releasePointerCapture(pointerId);
  }, [expanded]);

  const settle = (next: number) => {
    setRestOffset(next || FULL_SNAP);
    setDragOffset(null);
    onExpand(next > 0);
  };
  const releaseCapture = (event: PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const cancelGesture = (event: PointerEvent<HTMLDivElement>) => {
    const start = gesture.current;
    if (!start || start.pointerId !== event.pointerId) return;
    gesture.current = null;
    if (start.horizontal) settle(start.base);
    releaseCapture(event);
  };
  const finishGesture = (event: PointerEvent<HTMLDivElement>) => {
    const start = gesture.current;
    if (!start || start.pointerId !== event.pointerId) return;
    gesture.current = null;
    if (start.horizontal) {
      const released = clamp(start.base - (event.clientX - start.x));
      settle(
        released < TRASH_SNAP / 2
          ? 0
          : released < (TRASH_SNAP + FULL_SNAP) / 2
            ? TRASH_SNAP
            : FULL_SNAP,
      );
    }
    releaseCapture(event);
  };

  return (
    <li
      className={styles.swipeRow}
      data-dm-row={id}
      data-dragging={dragging}
      data-reveal={offset}
      style={
        {
          "--conversation-offset": `${offset}px`,
          "--trash-opacity": trashProgress,
          "--trash-scale": 0.55 + trashProgress * 0.45,
          "--mute-opacity": muteProgress,
          "--mute-scale": 0.55 + muteProgress * 0.45,
        } as CSSProperties
      }
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          event.stopPropagation();
          suppressClick.current = false;
          gesture.current = null;
          settle(FULL_SNAP);
          requestAnimationFrame(() => muteButton.current?.focus());
        } else if (
          (event.key === "ArrowRight" || event.key === "Escape") &&
          offset > 0
        ) {
          event.preventDefault();
          event.stopPropagation();
          suppressClick.current = false;
          gesture.current = null;
          settle(0);
          conversationButton.current?.focus();
        }
      }}
    >
      <span id={instructionsId} className={styles.rowInstructions}>
        左方向键展开会话操作，右方向键或 Escape 收起。
      </span>
      <div
        id={actionsId}
        className={styles.rowActions}
        role="group"
        aria-label={`${name}的会话操作`}
        aria-hidden={!trashAvailable}
      >
        <button
          ref={muteButton}
          type="button"
          className={styles.muteAction}
          aria-label={muted ? "取消静音" : "静音"}
          aria-hidden={!muteAvailable}
          disabled={!muteAvailable}
          tabIndex={muteAvailable ? 0 : -1}
          onClick={() => {
            settle(0);
            onMute();
          }}
        >
          <ActionIcon kind={muted ? "bell" : "bell-off"} />
        </button>
        <button
          type="button"
          className={styles.deleteAction}
          aria-label="删除对话"
          aria-hidden={!trashAvailable}
          disabled={!trashAvailable}
          tabIndex={trashAvailable ? 0 : -1}
          onClick={() => {
            settle(0);
            onHide();
          }}
        >
          <ActionIcon kind="trash" />
        </button>
      </div>
      <div
        ref={front}
        className={styles.rowFront}
        data-expanded={expanded}
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0 || gesture.current) return;
          suppressClick.current = false;
          gesture.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            base: offset,
            offset,
            horizontal: false,
          };
        }}
        onPointerMove={(event) => {
          const start = gesture.current;
          if (!start || start.pointerId !== event.pointerId) return;
          const dx = event.clientX - start.x;
          const dy = event.clientY - start.y;
          if (!start.horizontal) {
            if (Math.abs(dy) > 8 && Math.abs(dy) >= Math.abs(dx)) {
              suppressClick.current = true;
              gesture.current = null;
              return;
            }
            if (Math.abs(dx) <= 8 || Math.abs(dx) <= Math.abs(dy) * 1.2) return;
            try {
              event.currentTarget.setPointerCapture?.(event.pointerId);
            } catch {
              gesture.current = null;
              return;
            }
            start.horizontal = true;
            suppressClick.current = true;
            // Close another row as soon as this row takes horizontal ownership.
            if (!expanded) onExpand(true);
          }
          if (event.cancelable) event.preventDefault();
          start.offset = clamp(start.base - dx);
          setDragOffset(start.offset);
        }}
        onPointerUp={finishGesture}
        onPointerCancel={cancelGesture}
        onLostPointerCapture={(event) => {
          // Touch first captures the nested button; only losing capture on the
          // row itself cancels the row gesture.
          if (event.target === event.currentTarget) cancelGesture(event);
        }}
        onClickCapture={(event) => {
          if (!suppressClick.current) return;
          suppressClick.current = false;
          // Keyboard and assistive activation do not produce a pointer click.
          if (event.detail === 0) return;
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <button
          type="button"
          className={styles.conversationAvatar}
          aria-label={`查看${name}的主页`}
          aria-describedby={instructionsId}
          onClick={(event) => onOpenProfile(event.currentTarget)}
        >
          {avatar}
        </button>
        <button
          ref={conversationButton}
          type="button"
          className={styles.conversation}
          aria-label={label}
          aria-describedby={instructionsId}
          aria-controls={actionsId}
          aria-expanded={offset > 0}
          aria-keyshortcuts="ArrowLeft ArrowRight Escape"
          onClick={() => (expanded ? settle(0) : onOpen())}
        >
          <span className={styles.conversationBody}>{children}</span>
        </button>
      </div>
    </li>
  );
};
