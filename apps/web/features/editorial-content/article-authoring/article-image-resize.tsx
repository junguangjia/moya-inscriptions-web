"use client";

import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps, ReactNode } from "react";
import { ResizableFileBlockWrapper } from "@blocknote/react";
import type { ArticleBlock } from "@moya/contracts";
import styles from "./article-media.module.css";

type NativeResizeProps = ComponentProps<typeof ResizableFileBlockWrapper>;
type ImageBlock = Pick<
  Extract<ArticleBlock, { type: "managedImage" }>,
  "id" | "props"
>;
const boundedWidth = (width: number) => Math.min(1, Math.max(0.15, width));
// Hex escapes keep native IDs and React instance IDs within a CSS string,
// including unusual Unicode, without inserting author text into a style rule.
const cssString = (value: string) =>
  `"${[...value].map((character) => `\\${character.codePointAt(0)!.toString(16)} `).join("")}"`;

/** Native handles are a rendering adapter; no URL/file props enter the document. */
export const ArticleImageResize = ({
  editor,
  block,
  disabled,
  onApply,
  children,
}: {
  readonly editor: {
    readonly domElement: HTMLElement | undefined;
    readonly isEditable: boolean;
    readonly getBlock: (id: string) => unknown;
  };
  readonly block: ImageBlock;
  readonly disabled: boolean;
  readonly onApply: (width: number) => boolean;
  readonly children: ReactNode;
}) => {
  const host = useRef<HTMLDivElement>(null);
  const instanceId = useId();
  const [previewRatio, setPreviewRatio] = useState<number | null>(null);
  const [columnWidth, setColumnWidth] = useState(0);
  const [interruption, setInterruption] = useState(0);
  const basis = JSON.stringify([block.id, block.props]);
  const latest = useRef({ basis, disabled, onApply });
  latest.current = { basis, disabled, onApply };
  const gesture = useRef<string | null>(null);
  const lastRelease = useRef(-Infinity);
  const width = boundedWidth(block.props.displayWidth ?? 1);

  useLayoutEffect(() => {
    const column = editor.domElement?.firstElementChild;
    if (!(column instanceof HTMLElement)) return;
    const measure = () => setColumnWidth(column.clientWidth);
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(column);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [editor]);

  useLayoutEffect(() => {
    const cancel = () => {
      if (gesture.current === null) return;
      gesture.current = null;
      lastRelease.current = performance.now();
      setInterruption((value) => value + 1);
    };
    const multitouch = (event: TouchEvent) => {
      if (event.touches.length !== 1) cancel();
    };
    window.addEventListener("blur", cancel);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("touchcancel", cancel);
    window.addEventListener("touchstart", multitouch, true);
    return () => {
      gesture.current = null;
      window.removeEventListener("blur", cancel);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("touchcancel", cancel);
      window.removeEventListener("touchstart", multitouch, true);
    };
  }, [basis, disabled]);

  const nativeEditor = useMemo(
    () =>
      new Proxy(editor, {
        get(target, property) {
          if (property === "isEditable")
            return !latest.current.disabled && target.isEditable;
          if (property === "updateBlock")
            return (
              _block: unknown,
              update: { props?: { previewWidth?: number } },
            ) => {
              const next = update.props?.previewWidth;
              const valid =
                gesture.current === basis &&
                latest.current.basis === basis &&
                !latest.current.disabled;
              gesture.current = null;
              lastRelease.current = performance.now();
              if (
                valid &&
                typeof next === "number" &&
                Number.isFinite(next) &&
                columnWidth > 0
              )
                latest.current.onApply(boundedWidth(next / columnWidth));
              setInterruption((value) => value + 1);
              return target.getBlock(block.id);
            };
          return Reflect.get(target, property, target);
        },
        // The native wrapper's erased editor type includes its file schema. Its
        // reads are delegated to the actual editor; only the one width write is
        // intercepted above and revalidated by the Article owner callback.
      }) as unknown as NativeResizeProps["editor"],
    [editor, basis, block.id, columnWidth],
  );

  useLayoutEffect(() => {
    const root = host.current;
    if (root === null) return;
    const wrapper = root.querySelector<HTMLElement>(
      ".bn-file-block-content-wrapper",
    );
    if (wrapper !== null && columnWidth > 0)
      wrapper.style.minWidth = `${columnWidth * 0.15}px`;
    for (const [index, handle] of [
      ...root.querySelectorAll<HTMLElement>(".bn-resize-handle"),
    ].entries()) {
      handle.setAttribute("role", "slider");
      handle.tabIndex = disabled ? -1 : 0;
      handle.setAttribute(
        "aria-label",
        index === 0 ? "从左边调整图片大小" : "从右边调整图片大小",
      );
      handle.setAttribute("aria-valuemin", "15");
      handle.setAttribute("aria-valuemax", "100");
      handle.setAttribute("aria-valuenow", String(Math.round(width * 100)));
    }
    const present = () => {
      const pixels =
        wrapper === null ? NaN : Number.parseFloat(wrapper.style.width);
      const ratio =
        columnWidth > 0 && Number.isFinite(pixels)
          ? boundedWidth(pixels / columnWidth)
          : width;
      setPreviewRatio(ratio);
    };
    present();
    const observer = wrapper === null ? null : new MutationObserver(present);
    observer?.observe(wrapper!, {
      attributes: true,
      attributeFilter: ["style"],
    });
    return () => {
      observer?.disconnect();
    };
  }, [block.id, columnWidth, width, disabled, basis, interruption]);

  const nativeBlock: NativeResizeProps["block"] = {
    id: block.id,
    type: "file",
    content: undefined,
    children: [],
    props: {
      name: "",
      url: "managed-reference",
      caption: "",
      backgroundColor: "default",
      textAlignment: "left",
      showPreview: true,
      previewWidth: columnWidth * width,
    },
  };
  return (
    <div
      ref={host}
      className={styles.resizeHost}
      data-article-image-resizable=""
      data-article-resize-owner={instanceId}
      data-disabled={disabled ? "true" : "false"}
      onPointerDownCapture={(event) => {
        if (
          !disabled &&
          event.button === 0 &&
          event.target instanceof Element &&
          event.target.closest(".bn-resize-handle")
        )
          gesture.current = basis;
      }}
      onMouseDownCapture={(event) => {
        if (
          !disabled &&
          event.button === 0 &&
          event.target instanceof Element &&
          event.target.closest(".bn-resize-handle")
        )
          gesture.current = basis;
      }}
      onTouchStartCapture={(event) => {
        if (
          !disabled &&
          event.touches.length === 1 &&
          event.target instanceof Element &&
          event.target.closest(".bn-resize-handle")
        )
          gesture.current = basis;
      }}
      onClickCapture={(event) => {
        if (performance.now() - lastRelease.current < 300) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onKeyDownCapture={(event) => {
        if (
          disabled ||
          !(event.target instanceof Element) ||
          !event.target.closest(".bn-resize-handle")
        )
          return;
        const next =
          event.key === "Home"
            ? 0.15
            : event.key === "End"
              ? 1
              : event.key === "ArrowLeft"
                ? width - 0.05
                : event.key === "ArrowRight"
                  ? width + 0.05
                  : null;
        if (next === null) return;
        event.preventDefault();
        event.stopPropagation();
        latest.current.onApply(boundedWidth(next));
      }}
    >
      {/* The BlockContainer ancestor belongs to ProseMirror. Styling it via
          a scoped rule avoids attribute writes that would cause reparsing. */}
      <style data-article-image-layout-rule="">{`.bn-block-outer[data-id=${cssString(block.id)}]:has([data-article-resize-owner=${cssString(instanceId)}]) { width: ${(previewRatio ?? width) * 100}%; float: ${(previewRatio ?? width) < 0.99 ? "inline-start" : "none"}; margin-inline-end: ${(previewRatio ?? width) < 0.99 ? "var(--yoyi-space-6)" : "0"}; clear: ${(previewRatio ?? width) < 0.99 ? "none" : "both"}; }`}</style>
      {columnWidth > 0 ? (
        <ResizableFileBlockWrapper
          key={`${basis}/${columnWidth}/${disabled}/${interruption}`}
          editor={nativeEditor}
          block={nativeBlock}
        >
          {children}
        </ResizableFileBlockWrapper>
      ) : (
        children
      )}
    </div>
  );
};
