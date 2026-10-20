/*
 * Catalog deep zoom in the Viewer (catalog-deep-zoom-v1): the pure rules of
 * the block layer. One level of JPEG blocks covers an image's frame (long
 * edge ≤ 8192) in 1024 px cells, row-major, each drawn with its 2 px right
 * and bottom overlap. The layer mounts once the zoom asks for more pixels
 * than the widest base candidate holds, shows only the blocks the stage can
 * see (nearest the centre first), keeps at most 24 decoded and 4 in flight,
 * and never evicts a visible block. Every rectangle is derived from the
 * index, the frame, the edge and the overlap (the contract's, carried with
 * the frame); no URL is ever composed.
 */

/** The layer mounts when the zoom asks for this much more than the base. */
export const ZOOM_BLOCK_MOUNT_RATIO = 1.15;
/** At most this many blocks decoded (in the DOM) per image. */
export const ZOOM_BLOCK_DECODED_BUDGET = 24;
/** At most this many block loads at once. */
export const ZOOM_BLOCK_IN_FLIGHT = 4;
/** Counted failures that switch the layer off for the session. */
export const ZOOM_BLOCK_FAILURE_LIMIT = 3;
/** The highest zoom a tiled image allows. */
export const ZOOM_BLOCK_SCALE_CAP = 40;
/** Above this many visible blocks at the mount, the image keeps today's ladder. */
export const ZOOM_BLOCK_USABLE_VISIBLE = 24;

/** A block frame with its grid: the cell edge and the overlap. */
export interface ZoomFrame {
  readonly width: number;
  readonly height: number;
  readonly edge: number;
  readonly overlap: number;
}

export interface ZoomRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Where the image sits: its fitted box, the stage and the Viewer transform. */
export interface ZoomView {
  /** The image's contained box at scale 1, centred in the stage (CSS px). */
  readonly fitWidth: number;
  readonly fitHeight: number;
  readonly stageWidth: number;
  readonly stageHeight: number;
  readonly scale: number;
  /** Translation of the image's centre from the stage's centre (CSS px). */
  readonly x: number;
  readonly y: number;
}

/** Columns, rows and cells of a frame's grid. */
export const zoomBlockGrid = (frame: ZoomFrame) => {
  const columns = Math.ceil(frame.width / frame.edge);
  const rows = Math.ceil(frame.height / frame.edge);
  return { columns, rows, cells: columns * rows };
};

/** A cell's rectangle in frame pixels, with its right and bottom overlap. */
export const zoomBlockRect = (frame: ZoomFrame, cell: number): ZoomRect => {
  const { columns } = zoomBlockGrid(frame);
  const x = (cell % columns) * frame.edge;
  const y = Math.floor(cell / columns) * frame.edge;
  return {
    x,
    y,
    width: Math.min(frame.edge + frame.overlap, frame.width - x),
    height: Math.min(frame.edge + frame.overlap, frame.height - y),
  };
};

/** Device pixels the image is drawn at across its width. */
export const zoomDemandWidth = (view: ZoomView, pixelRatio: number): number =>
  view.fitWidth * view.scale * pixelRatio;

/** Whether the layer mounts: the zoom asks for more than 1.15 × the base. */
export const shouldMountZoomBlocks = (
  view: ZoomView,
  pixelRatio: number,
  baseWidth: number,
): boolean =>
  zoomDemandWidth(view, pixelRatio) > ZOOM_BLOCK_MOUNT_RATIO * baseWidth;

/** A frame rectangle on the stage (CSS px from the stage's top left). */
export const zoomScreenRect = (
  frame: ZoomFrame,
  view: ZoomView,
  rect: ZoomRect,
): ZoomRect => {
  const sx = (view.fitWidth / frame.width) * view.scale;
  const sy = (view.fitHeight / frame.height) * view.scale;
  const left = view.stageWidth / 2 + view.x - (view.fitWidth * view.scale) / 2;
  const top = view.stageHeight / 2 + view.y - (view.fitHeight * view.scale) / 2;
  return {
    x: left + rect.x * sx,
    y: top + rect.y * sy,
    width: rect.width * sx,
    height: rect.height * sy,
  };
};

/** The same rectangle with its edges on device pixels (at rest). */
export const snapZoomRect = (rect: ZoomRect, pixelRatio: number): ZoomRect => {
  const left = Math.round(rect.x * pixelRatio) / pixelRatio;
  const top = Math.round(rect.y * pixelRatio) / pixelRatio;
  const right = Math.round((rect.x + rect.width) * pixelRatio) / pixelRatio;
  const bottom = Math.round((rect.y + rect.height) * pixelRatio) / pixelRatio;
  return { x: left, y: top, width: right - left, height: bottom - top };
};

/** The stage's visible part of the frame, in frame pixels (may be empty). */
const visibleFrameRect = (frame: ZoomFrame, view: ZoomView): ZoomRect => {
  const origin = zoomScreenRect(frame, view, {
    x: 0,
    y: 0,
    width: frame.width,
    height: frame.height,
  });
  const fx = frame.width / origin.width;
  const fy = frame.height / origin.height;
  const x0 = Math.max(0, (0 - origin.x) * fx);
  const y0 = Math.max(0, (0 - origin.y) * fy);
  const x1 = Math.min(frame.width, (view.stageWidth - origin.x) * fx);
  const y1 = Math.min(frame.height, (view.stageHeight - origin.y) * fy);
  return {
    x: x0,
    y: y0,
    width: Math.max(0, x1 - x0),
    height: Math.max(0, y1 - y0),
  };
};

/** The cells the stage shows, nearest the stage's centre first. */
export const visibleZoomBlocks = (
  frame: ZoomFrame,
  view: ZoomView,
): readonly number[] => {
  const visible = visibleFrameRect(frame, view);
  if (visible.width <= 0 || visible.height <= 0) return [];
  const { columns, rows } = zoomBlockGrid(frame);
  const c0 = Math.floor(visible.x / frame.edge);
  const r0 = Math.floor(visible.y / frame.edge);
  const c1 = Math.min(
    columns - 1,
    Math.ceil((visible.x + visible.width) / frame.edge) - 1,
  );
  const r1 = Math.min(
    rows - 1,
    Math.ceil((visible.y + visible.height) / frame.edge) - 1,
  );
  const cx = visible.x + visible.width / 2;
  const cy = visible.y + visible.height / 2;
  const cells: { cell: number; distance: number }[] = [];
  for (let row = r0; row <= r1; row += 1)
    for (let column = c0; column <= c1; column += 1) {
      const cell = row * columns + column;
      const rect = zoomBlockRect(frame, cell);
      cells.push({
        cell,
        distance: Math.hypot(
          rect.x + rect.width / 2 - cx,
          rect.y + rect.height / 2 - cy,
        ),
      });
    }
  return cells
    .sort((a, b) => a.distance - b.distance || a.cell - b.cell)
    .map(({ cell }) => cell);
};

/** The cells around a visible set, one block deep. */
export const zoomBlockRing = (
  frame: ZoomFrame,
  visible: readonly number[],
): ReadonlySet<number> => {
  const { columns, rows } = zoomBlockGrid(frame);
  const ring = new Set<number>();
  for (const cell of visible) {
    const column = cell % columns;
    const row = Math.floor(cell / columns);
    for (let dy = -1; dy <= 1; dy += 1)
      for (let dx = -1; dx <= 1; dx += 1) {
        const c = column + dx;
        const r = row + dy;
        if (c >= 0 && c < columns && r >= 0 && r < rows)
          ring.add(r * columns + c);
      }
  }
  for (const cell of visible) ring.delete(cell);
  return ring;
};

/**
 * The decoded cells to drop to stay within the budget: least recently used
 * first, and only outside the visible set and its ring. `used` lists decoded
 * cells from least to most recently used.
 */
export const zoomBlockEvictions = (
  used: readonly number[],
  visible: readonly number[],
  ring: ReadonlySet<number>,
  budget = ZOOM_BLOCK_DECODED_BUDGET,
): readonly number[] => {
  const excess = used.length - budget;
  if (excess <= 0) return [];
  const kept = new Set(visible);
  const outside = used.filter((cell) => !kept.has(cell) && !ring.has(cell));
  const beyond = used.filter((cell) => !kept.has(cell) && ring.has(cell));
  return [...outside, ...beyond].slice(0, excess);
};

/**
 * The zoom ceiling of a tiled image: up to 40, at least today's ceiling,
 * 1.25 × the zoom at which one frame pixel meets one device pixel, and the
 * zoom that fills the stage.
 */
export const zoomBlockMaxScale = (
  todayMaxScale: number,
  frame: Pick<ZoomFrame, "width">,
  view: Pick<ZoomView, "fitWidth" | "fitHeight" | "stageWidth" | "stageHeight">,
  pixelRatio: number,
): number => {
  const oneToOne = frame.width / Math.max(1, view.fitWidth * pixelRatio);
  const fill = Math.max(
    view.stageWidth / Math.max(1, view.fitWidth),
    view.stageHeight / Math.max(1, view.fitHeight),
  );
  return Math.min(
    ZOOM_BLOCK_SCALE_CAP,
    Math.max(todayMaxScale, 1.25 * oneToOne, fill),
  );
};

/**
 * The page's block session: counted failures (a block that does not load
 * or decode) switch the layer off until the page reloads. Evictions, aborts
 * and decode rejections after a source change are never counted.
 */
const session = { failures: 0 };
export const countZoomBlockFailure = (): void => {
  session.failures += 1;
};
export const zoomBlocksFallenBack = (): boolean =>
  session.failures >= ZOOM_BLOCK_FAILURE_LIMIT;
/** Test seam: a fresh session. */
export const resetZoomBlockSession = (): void => {
  session.failures = 0;
};
