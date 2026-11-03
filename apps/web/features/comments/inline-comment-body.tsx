"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import type { CommentImage } from "@moya/contracts";
import { CatalogViewer } from "../detail/catalog-viewer";
import { acquireDesktopViewportScrollLock } from "../shell/desktop-viewport-scroll-lock";
import { resolveRuntimePresentationPlatform } from "../shell/device-platform";
import { usePreviewNavigationHistory } from "../shell/use-preview-navigation-history";
import type { DetailMediaPresentation } from "../detail/catalog-detail-presentation";
import styles from "./inline-comment-body.module.css";

/** The existing viewer and local-child history owner, scoped to one entry. */
const CommentImageViewer = ({
  images,
  selectedId,
  onSelect,
  onClose,
  vertical,
  open,
}: {
  readonly images: readonly CommentImage[];
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly onClose: () => void;
  readonly vertical: boolean;
  readonly open: boolean;
}) => {
  const history = usePreviewNavigationHistory({
    depth: open ? 1 : 0,
    nativeModal: true,
    stateKey: "commentImageNavigation",
    onBack: onClose,
  });
  useEffect(
    () => (open ? acquireDesktopViewportScrollLock() : undefined),
    [open],
  );
  const media = useMemo<readonly DetailMediaPresentation[]>(
    () =>
      images.map((image, index) => ({
        id: image.id,
        src: image.src,
        ...(image.fullSrc === undefined ? {} : { fullSrc: image.fullSrc }),
        width: image.width,
        height: image.height,
        alt: `评论附图 ${index + 1}`,
      })),
    [images],
  );
  const close = () => {
    if (!history.requestBack()) onClose();
  };
  return !open
    ? null
    : createPortal(
        <div
          className={styles.viewerHost}
          data-comment-image-viewer=""
          // React portals retain their React ancestry. Viewer gestures and keys
          // must never bubble into the underlying comment's reply action.
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <CatalogViewer
            direction={vertical ? "rtl" : "ltr"}
            index={Math.max(
              0,
              images.findIndex((image) => image.id === selectedId),
            )}
            media={media}
            onClose={close}
            onIndexChange={(index) => {
              const image = images[index];
              if (image) onSelect(image.id);
            }}
            open
            platform={resolveRuntimePresentationPlatform(
              navigator,
              window.innerWidth,
            )}
          />
        </div>,
        document.body,
      );
};

/**
 * Render managed images at their normalized UTF-16 offsets without changing
 * the plain-text body. Equal offsets keep the submitted attachment order.
 */
export const InlineCommentBody = ({
  text,
  images = [],
  viewerImages,
  renderText,
  vertical = false,
  disabled = false,
}: {
  readonly text: string;
  readonly images?: readonly CommentImage[] | undefined;
  /** A folded text can hide inline slots without hiding the entry's gallery. */
  readonly viewerImages?: readonly CommentImage[] | undefined;
  readonly renderText?: ((text: string) => ReactNode) | undefined;
  readonly vertical?: boolean;
  readonly disabled?: boolean;
}) => {
  const ordered = useMemo(
    () =>
      images
        .map((image, order) => ({ image, order }))
        .sort((a, b) => a.image.offset - b.image.offset || a.order - b.order)
        .map(({ image }) => image),
    [images],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const gallery = useMemo(
    () =>
      (viewerImages ?? images)
        .map((image, order) => ({ image, order }))
        .sort((a, b) => a.image.offset - b.image.offset || a.order - b.order)
        .map(({ image }) => image),
    [viewerImages, images],
  );
  const [viewerWasOpened, setViewerWasOpened] = useState(false);
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const opener = useRef<HTMLButtonElement | null>(null);
  const pointer = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const textNode = renderText ?? ((value: string) => value);
  const close = () => {
    setSelectedId(null);
    const button = opener.current;
    window.requestAnimationFrame(() => {
      if (
        button?.isConnected &&
        button.closest('[inert], [hidden], [aria-hidden="true"]') === null
      )
        button.focus({ preventScroll: true });
    });
  };
  // Deletion, an account switch or a refreshed permission result may remove
  // the selected attachment. No orphan viewer keeps that private image open.
  const shown =
    !disabled &&
    selectedId !== null &&
    gallery.some((image) => image.id === selectedId);
  useEffect(() => {
    if (selectedId !== null && !shown) setSelectedId(null);
  }, [selectedId, shown]);
  let previous = 0;
  return (
    <>
      {ordered.map((image, index) => {
        const galleryIndex = gallery.findIndex((item) => item.id === image.id);
        const offset = Math.max(previous, Math.min(text.length, image.offset));
        const before = text.slice(previous, offset);
        previous = offset;
        return (
          <Fragment key={image.id}>
            {textNode(before)}
            <button
              aria-label={`${failed.has(image.id) ? "图片加载失败，重试并查看评论附图" : "放大查看评论附图"} ${galleryIndex < 0 ? index + 1 : galleryIndex + 1}，共 ${gallery.length} 张`}
              className={styles.image}
              data-comment-image={image.id}
              data-comment-image-offset={image.offset}
              disabled={disabled}
              onClick={(event) => {
                const moved = pointer.current?.moved ?? false;
                pointer.current = null;
                if (event.defaultPrevented || moved) {
                  event.preventDefault();
                  event.stopPropagation();
                  return;
                }
                event.preventDefault();
                event.stopPropagation();
                opener.current = event.currentTarget;
                setFailed((old) => {
                  const next = new Set(old);
                  next.delete(image.id);
                  return next;
                });
                setSelectedId(image.id);
                setViewerWasOpened(true);
              }}
              onKeyDown={(event) => {
                pointer.current = null;
                if (event.key === "Enter" || event.key === " ")
                  event.stopPropagation();
              }}
              onPointerDown={(event) => {
                // Let the existing horizontal reader own a drag starting on
                // the thumbnail; only the eventual image click is isolated.
                pointer.current = {
                  x: event.clientX,
                  y: event.clientY,
                  moved: false,
                };
              }}
              onPointerMove={(event) => {
                const start = pointer.current;
                if (
                  start &&
                  Math.hypot(event.clientX - start.x, event.clientY - start.y) >
                    8
                )
                  start.moved = true;
              }}
              onPointerCancel={() => {
                if (pointer.current) pointer.current.moved = true;
              }}
              type="button"
            >
              {failed.has(image.id) ? (
                <span
                  className={styles.unavailable}
                  aria-label="图片加载失败，点击重试"
                >
                  重试
                </span>
              ) : (
                <img
                  alt={`附图 ${index + 1}`}
                  decoding="async"
                  draggable={false}
                  height={32}
                  loading="lazy"
                  onError={() => setFailed((old) => new Set(old).add(image.id))}
                  src={image.thumbSrc}
                  width={32}
                />
              )}
            </button>
          </Fragment>
        );
      })}
      {textNode(text.slice(previous))}
      {viewerWasOpened ? (
        <CommentImageViewer
          images={gallery}
          onClose={close}
          onSelect={setSelectedId}
          selectedId={selectedId}
          vertical={vertical}
          open={shown}
        />
      ) : null}
    </>
  );
};
