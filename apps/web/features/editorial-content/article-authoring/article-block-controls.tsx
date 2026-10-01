"use client";

import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { ArticleBlockNoteEditor } from "./article-blocknote-schema";
import { moveArticleBlock, stepArticleBlock } from "./article-block-move";
import { ArticleToolIcon } from "./article-tools";
import styles from "./article-authoring.module.css";

/** Handle-only pointer adapter over native editor transactions; body still scrolls. */
export const ArticleBlockControls = ({
  editor,
  blockId,
  disabled,
  canMutate,
}: {
  readonly editor: ArticleBlockNoteEditor;
  readonly blockId: string;
  readonly disabled: boolean;
  readonly canMutate: () => boolean;
}) => {
  const [announcement, setAnnouncement] = useState("");
  const latest = useRef({ editor, disabled, canMutate });
  latest.current = { editor, disabled, canMutate };
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);
  useEffect(() => {
    if (disabled) cleanup.current?.();
  }, [disabled]);
  const allowed = () =>
    latest.current.editor === editor &&
    !latest.current.disabled &&
    latest.current.canMutate();
  const step = (direction: -1 | 1) => {
    if (allowed() && stepArticleBlock(editor, blockId, direction))
      setAnnouncement(
        direction === -1
          ? "内容已上移，修改会自动保存。"
          : "内容已下移，修改会自动保存。",
      );
  };
  const start = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!allowed() || event.button !== 0) return;
    cleanup.current?.();
    const button = event.currentTarget;
    const root = button.closest<HTMLElement>(".bn-editor");
    if (!root) return;
    const scroller = root.closest<HTMLElement>(`[data-article-scroller]`);
    const original = editor.prosemirrorState.doc;
    const ids = new Set(editor.document.map((block) => block.id));
    const pointerId = event.pointerId;
    const startX = event.clientX,
      startY = event.clientY;
    let active = event.pointerType !== "touch";
    let target: HTMLElement | null = null;
    let placement: "before" | "after" = "before";
    const timer = window.setTimeout(
      () => {
        active = true;
        button.dataset.dragging = "true";
        setAnnouncement("拖动到新位置，松开放下。按 Esc 取消。");
      },
      event.pointerType === "touch" ? 250 : 0,
    );
    const clearTarget = () => {
      if (target) delete target.dataset.articleDrop;
      target = null;
    };
    const stop = () => {
      clearTimeout(timer);
      clearTarget();
      delete button.dataset.dragging;
      button.removeEventListener("pointermove", move);
      button.removeEventListener("pointerup", end);
      button.removeEventListener("pointercancel", cancel);
      button.removeEventListener("lostpointercapture", cancel);
      document.removeEventListener("keydown", escape);
      if (button.hasPointerCapture?.(pointerId))
        button.releasePointerCapture(pointerId);
      cleanup.current = null;
    };
    const cancel = () => {
      stop();
      setAnnouncement("已取消移动。");
    };
    const escape = (key: KeyboardEvent) => {
      if (key.key === "Escape") {
        key.preventDefault();
        cancel();
      }
    };
    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      if (!allowed() || !editor.prosemirrorState.doc.eq(original)) {
        cancel();
        return;
      }
      if (!active) {
        if (Math.hypot(pointer.clientX - startX, pointer.clientY - startY) > 8)
          cancel();
        return;
      }
      pointer.preventDefault();
      if (scroller) {
        const rect = scroller.getBoundingClientRect();
        if (pointer.clientY < rect.top + 48) scroller.scrollTop -= 16;
        if (pointer.clientY > rect.bottom - 48) scroller.scrollTop += 16;
      }
      let nearest: HTMLElement | null = null,
        distance = Infinity;
      for (const node of root.querySelectorAll<HTMLElement>(
        ".bn-block-outer[data-id]",
      )) {
        if (!ids.has(node.dataset.id ?? "") || node.dataset.id === blockId)
          continue;
        const rect = node.getBoundingClientRect();
        const delta = Math.abs(pointer.clientY - (rect.top + rect.bottom) / 2);
        if (delta < distance) {
          nearest = node;
          distance = delta;
        }
      }
      clearTarget();
      target = nearest;
      if (target) {
        const rect = target.getBoundingClientRect();
        placement =
          pointer.clientY < (rect.top + rect.bottom) / 2 ? "before" : "after";
        target.dataset.articleDrop = placement;
      }
    };
    const end = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      const targetId = target?.dataset.id;
      const commit =
        active &&
        targetId !== undefined &&
        allowed() &&
        editor.prosemirrorState.doc.eq(original);
      stop();
      if (commit && moveArticleBlock(editor, blockId, targetId, placement))
        setAnnouncement("位置已调整，修改会自动保存。可撤销。 ");
    };
    button.setPointerCapture?.(pointerId);
    button.addEventListener("pointermove", move);
    button.addEventListener("pointerup", end);
    button.addEventListener("pointercancel", cancel);
    button.addEventListener("lostpointercapture", cancel);
    document.addEventListener("keydown", escape);
    cleanup.current = stop;
  };
  return (
    <div className={styles.blockControls} contentEditable={false}>
      <button
        type="button"
        aria-label="拖动调整位置"
        title="长按拖动；Alt+方向键移动"
        disabled={disabled}
        className={styles.dragHandle}
        onPointerDown={start}
        onKeyDown={(event) => {
          if (
            event.altKey &&
            (event.key === "ArrowUp" || event.key === "ArrowDown")
          ) {
            event.preventDefault();
            step(event.key === "ArrowUp" ? -1 : 1);
          }
        }}
      >
        <ArticleToolIcon name="drag" />
      </button>
      <button
        type="button"
        aria-label="此内容上移"
        disabled={disabled}
        onClick={() => step(-1)}
      >
        <ArticleToolIcon name="up" />
      </button>
      <button
        type="button"
        aria-label="此内容下移"
        disabled={disabled}
        onClick={() => step(1)}
      >
        <ArticleToolIcon name="down" />
      </button>
      <span className={styles.srOnly} role="status">
        {announcement}
      </span>
    </div>
  );
};
