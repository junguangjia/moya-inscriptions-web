"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import {
  catalogZoomGrid,
  fetchSameOriginCatalogZoomBlocks,
} from "../../lib/public-api/catalog-zoom-blocks-client";
import { VIEWER_UPGRADE_SETTLE_MS } from "../media/responsive-media";
import styles from "./catalog-detail.module.css";
import {
  ZOOM_BLOCK_IN_FLIGHT,
  ZOOM_BLOCK_MOUNT_RATIO,
  ZOOM_BLOCK_USABLE_VISIBLE,
  countZoomBlockFailure,
  shouldMountZoomBlocks,
  snapZoomRect,
  visibleZoomBlocks,
  zoomBlockEvictions,
  zoomBlockRect,
  zoomBlockRing,
  zoomBlocksFallenBack,
  zoomScreenRect,
} from "./zoom-blocks";

import type { DetailMediaPresentation } from "./catalog-detail-presentation";
import type { ZoomFrame, ZoomView } from "./zoom-blocks";
import type { ReactNode } from "react";

/*
 * Catalog deep zoom (catalog-deep-zoom-v1): the block layer of the Viewer's
 * current slide, for images whose Catalog Detail entry carries a `zoom`
 * frame. On its first mount for an image it reads that image's block list
 * once (abortable); while the zoom rests it loads the visible blocks nearest
 * the centre first, inserts each only once decoded, and draws them at
 * device-pixel rects over the base image; while the transform changes the
 * drawn blocks follow it. Paging away or closing aborts everything for the
 * old image. A list read that answers anything but 200, or a list the
 * contract refuses, leaves the image on today's Viewer without counting a
 * failure.
 */

/** The block-list read's answer (its types follow the client module). */
type ZoomBlocksResult = Awaited<
  ReturnType<typeof fetchSameOriginCatalogZoomBlocks>
>;
type ZoomBlockList = Extract<ZoomBlocksResult, { state: "success" }>["blocks"];

export type ZoomBlockLayerState =
  "none" | "unusable" | "idle" | "loading" | "ready" | "fallback";

export interface ZoomBlockLayerInput {
  /** The Viewer's current item. */
  readonly item: DetailMediaPresentation | undefined;
  readonly open: boolean;
  /** Where the current item sits, or null before the stage is measured. */
  readonly view: ZoomView | null;
  readonly pixelRatio: number;
  /** The widest base candidate the Viewer can show for the item. */
  readonly baseWidth: number;
  /** Test seam: the block-list read. */
  readonly load?: (
    catalogId: string,
    mediaId: string,
    signal: AbortSignal,
  ) => Promise<ZoomBlocksResult>;
}

export interface ZoomBlockLayer {
  readonly state: ZoomBlockLayerState;
  /** Whether the current item may use blocks (and their zoom ceiling). */
  readonly usable: boolean;
  /** The layer for the current slide, or null. */
  readonly node: ReactNode;
}

type ListValue = ZoomBlockList | "unusable";

/** Completed block-list reads of this page, by record and image. */
const lists = new Map<string, ListValue>();

/** Test seam: forget every block-list read. */
export const resetZoomBlockLists = (): void => {
  lists.clear();
};

const loadList = (catalogId: string, mediaId: string, signal: AbortSignal) =>
  fetchSameOriginCatalogZoomBlocks(catalogId, mediaId, signal);

/** Whether more than 24 blocks would be visible at the mount (today's ladder then). */
const crowdedAtMount = (
  frame: ZoomFrame,
  view: ZoomView,
  pixelRatio: number,
  baseWidth: number,
): boolean => {
  const scale = Math.max(
    1,
    (ZOOM_BLOCK_MOUNT_RATIO * baseWidth) / (view.fitWidth * pixelRatio),
  );
  return (
    visibleZoomBlocks(frame, { ...view, scale, x: 0, y: 0 }).length >
    ZOOM_BLOCK_USABLE_VISIBLE
  );
};

export const useZoomBlockLayer = ({
  item,
  open,
  view,
  pixelRatio,
  baseWidth,
  load = loadList,
}: ZoomBlockLayerInput): ZoomBlockLayer => {
  const deepZoom = item?.deepZoom;
  const key =
    item === undefined || deepZoom === undefined
      ? null
      : JSON.stringify([deepZoom.catalogId, item.id]);
  const [listVersion, setListVersion] = useState(0);
  const [resting, setResting] = useState(true);
  const [decoded, setDecoded] = useState<{
    readonly key: string | null;
    readonly cells: readonly number[];
  }>({ key: null, cells: [] });
  const [inFlight, setInFlight] = useState(0);
  const [fallback, setFallback] = useState(zoomBlocksFallenBack);
  const loadsRef = useRef(new Map<number, HTMLImageElement>());
  const failedRef = useRef(new Set<number>());
  const visibleRef = useRef<readonly number[]>([]);
  const listAbortRef = useRef<AbortController | null>(null);
  const keyRef = useRef(key);
  keyRef.current = key;

  const list = key === null ? undefined : lists.get(key);
  void listVersion;
  // The frame with its grid: the list's once read, else the contract's.
  const zoom = useMemo(
    () =>
      deepZoom === undefined
        ? undefined
        : {
            width: deepZoom.width,
            height: deepZoom.height,
            catalogId: deepZoom.catalogId,
            ...(typeof list === "object"
              ? { edge: list.edge, overlap: list.overlap }
              : catalogZoomGrid),
          },
    [deepZoom, list],
  );
  const usable =
    zoom !== undefined &&
    !fallback &&
    list !== "unusable" &&
    (view === null || !crowdedAtMount(zoom, view, pixelRatio, baseWidth));
  const active =
    usable &&
    open &&
    view !== null &&
    shouldMountZoomBlocks(view, pixelRatio, baseWidth);
  const blocks = typeof list === "object" ? list : undefined;
  const viewKey =
    view === null
      ? ""
      : `${view.scale} ${view.x} ${view.y} ${view.fitWidth} ${view.fitHeight} ${view.stageWidth} ${view.stageHeight}`;

  /** Drops in-flight loads (never counted as failures). */
  const abortLoads = (keep: (cell: number) => boolean = () => false) => {
    let changed = false;
    for (const [cell, image] of loadsRef.current)
      if (!keep(cell)) {
        loadsRef.current.delete(cell);
        image.removeAttribute("src");
        changed = true;
      }
    if (changed) setInFlight(loadsRef.current.size);
  };

  // The zoom rests 120 ms after its last change, as the base upgrade does.
  useEffect(() => {
    setResting(false);
    const timer = window.setTimeout(
      () => setResting(true),
      VIEWER_UPGRADE_SETTLE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [viewKey]);

  // Another image, closing or reopening start over: the old image's loads
  // and list read are aborted and it requests nothing more.
  useEffect(
    () => () => {
      listAbortRef.current?.abort();
      listAbortRef.current = null;
      abortLoads();
      failedRef.current = new Set();
      setDecoded({ key: null, cells: [] });
    },
    // abortLoads only touches refs and a setter.
    [key, open],
  );

  // The one block-list read of an image, on its first mount.
  useEffect(() => {
    if (!active || key === null || zoom === undefined || item === undefined)
      return;
    if (lists.has(key) || listAbortRef.current !== null) return;
    const controller = new AbortController();
    listAbortRef.current = controller;
    load(zoom.catalogId, item.id, controller.signal).then(
      (result) => {
        if (listAbortRef.current === controller) listAbortRef.current = null;
        if (controller.signal.aborted) return;
        lists.set(
          key,
          result.state === "success" &&
            result.blocks.width === zoom.width &&
            result.blocks.height === zoom.height
            ? result.blocks
            : "unusable",
        );
        setListVersion((version) => version + 1);
      },
      () => {
        if (listAbortRef.current === controller) listAbortRef.current = null;
      },
    );
  }, [active, item, key, load, zoom]);

  // At rest, the visible blocks nearest the centre first, four at a time.
  useEffect(() => {
    if (fallback) {
      abortLoads();
      return;
    }
    if (
      !active ||
      blocks === undefined ||
      zoom === undefined ||
      view === null
    ) {
      abortLoads();
      return;
    }
    if (!resting) return;
    const visible = visibleZoomBlocks(zoom, view);
    visibleRef.current = visible;
    const ring = zoomBlockRing(zoom, visible);
    const wanted = new Set(visible);
    abortLoads((cell) => wanted.has(cell) || ring.has(cell));
    const shown = new Set(decoded.key === key ? decoded.cells : []);
    for (const cell of visible) {
      if (loadsRef.current.size >= ZOOM_BLOCK_IN_FLIGHT) break;
      if (
        shown.has(cell) ||
        loadsRef.current.has(cell) ||
        failedRef.current.has(cell)
      )
        continue;
      const src = blocks.srcs[cell];
      if (src === undefined) continue;
      const image = new Image();
      image.decoding = "async";
      loadsRef.current.set(cell, image);
      const settle = (ok: boolean) => {
        // Aborted, or another image now: never counted.
        if (loadsRef.current.get(cell) !== image || keyRef.current !== key)
          return;
        loadsRef.current.delete(cell);
        setInFlight(loadsRef.current.size);
        if (!ok) {
          failedRef.current.add(cell);
          countZoomBlockFailure();
          if (zoomBlocksFallenBack()) setFallback(true);
          return;
        }
        setDecoded((present) => {
          const cells = [
            ...(present.key === key ? present.cells : []).filter(
              (entry) => entry !== cell,
            ),
            cell,
          ];
          const drop = new Set(
            zoomBlockEvictions(
              cells,
              visibleRef.current,
              zoomBlockRing(zoom, visibleRef.current),
            ),
          );
          return { key, cells: cells.filter((entry) => !drop.has(entry)) };
        });
      };
      image.src = src;
      (typeof image.decode === "function"
        ? image.decode()
        : new Promise<void>((resolve, reject) => {
            image.addEventListener("load", () => resolve(), { once: true });
            image.addEventListener("error", reject, { once: true });
          })
      ).then(
        () => settle(true),
        () => settle(false),
      );
    }
    setInFlight(loadsRef.current.size);
    // viewKey stands for view; abortLoads only touches refs and a setter.
  }, [active, blocks, decoded, fallback, key, resting, viewKey, zoom]);

  const state: ZoomBlockLayerState =
    zoom === undefined
      ? "none"
      : fallback
        ? "fallback"
        : !usable
          ? "unusable"
          : !active
            ? "idle"
            : blocks === undefined || inFlight > 0
              ? "loading"
              : "ready";

  const cells =
    active && blocks !== undefined && decoded.key === key ? decoded.cells : [];
  const node =
    cells.length === 0 ||
    zoom === undefined ||
    view === null ||
    blocks === undefined ? null : (
      <div aria-hidden="true" className={styles.viewerZoomLayer}>
        {cells.map((cell) => {
          const onScreen = zoomScreenRect(
            zoom,
            view,
            zoomBlockRect(zoom, cell),
          );
          const rect = resting ? snapZoomRect(onScreen, pixelRatio) : onScreen;
          return (
            <img
              alt=""
              className={styles.viewerZoomBlock}
              data-viewer-zoom-block={cell}
              decoding="async"
              draggable={false}
              key={cell}
              src={blocks.srcs[cell]}
              style={{
                height: `${rect.height}px`,
                left: `${rect.x}px`,
                top: `${rect.y}px`,
                width: `${rect.width}px`,
              }}
            />
          );
        })}
      </div>
    );

  return { node, state, usable };
};
