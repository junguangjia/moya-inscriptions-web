import type { Area } from "react-easy-crop";
import { CROP_IMAGE_EDGE } from "../publishing/ui/media/bounded-preview";
import {
  canvasHasTransparency,
  canvasLooksBlank,
} from "../publishing/preprocess/static-image";
import type { Drawable2dContext } from "../publishing/preprocess/static-image";
import { normalizeAvatarPng } from "./avatar-image";
import { AuthorRequestError, authorClient } from "./author-data";

/**
 * The profile cover is one derived image shown behind the profile identity.
 * The header's own shape varies (portrait on phones, wide on desktops), so the
 * saved master is 4:3 and the live cover is top-anchored
 * (`user-presentation.module.css`): every device shows a window of the same
 * master that starts at its top edge. The editor draws those windows and the
 * area every device keeps clear (see docs/community/profile-cover-upload-redesign-v1.md).
 */
export const COVER_ASPECT = 4 / 3;

/** Export widths, largest first; the height follows COVER_ASPECT. */
export const COVER_EXPORT_WIDTHS = [1600, 1440, 1280, 1024] as const;
/** Preferred upload size: keeps the unchanged 15 s request budget on slow uplinks. */
export const COVER_SOFT_BYTES = 3 * 1024 * 1024;
/** The Backend's PNG limit. */
export const COVER_HARD_BYTES = 4 * 1024 * 1024;
/** Below this many source pixels across, a wide screen upscales the cover. */
export const COVER_LOW_RESOLUTION_WIDTH = 1024;
/** Background-only source limits (Owner decision, #171 r2). */
export const COVER_SOURCE_BYTES = 25 * 1024 * 1024;
/** 50 Mi px: admits 50 MP camera modes (8192×6144, 8160×6144). */
export const COVER_SOURCE_PIXELS = 50 * 1024 * 1024;
/** Decoded export source bound (the previous source limit). */
const EXPORT_SOURCE_PIXELS = 16 * 1024 * 1024;

export type CoverDevice = "phone" | "desktop";

/** A rectangle in fractions (0–1) of the master or of a header window. */
export interface CoverRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A profile header box in CSS pixels; `identityTop` is the avatar's top edge. */
export interface HeaderBox {
  readonly width: number;
  readonly height: number;
  readonly identityTop: number;
}

/**
 * Typical headers with a one-line bio (390×844 phone, 1280×800 desktop),
 * from the header CSS; the editor measures the owner's own header instead
 * whenever it is laid out.
 */
export const REFERENCE_HEADERS: Readonly<Record<CoverDevice, HeaderBox>> = {
  phone: { width: 390, height: 569, identityTop: 330 },
  desktop: { width: 960, height: 556, identityTop: 308 },
};

/**
 * Visible and above the fade on portrait phones (bio up to three lines) and on
 * desktop windows from 1366×657 up; landscape phones are best effort.
 */
export const COVER_SAFE_RECT: CoverRect = {
  x: 0.27,
  y: 0,
  width: 0.46,
  height: 0.22,
};

export const deviceForWidth = (width: number): CoverDevice =>
  width < 768 ? "phone" : "desktop";

/** The master region a header of `aspect` (width / height) shows. */
export const coverWindow = (
  aspect: number,
  master = COVER_ASPECT,
): CoverRect => {
  if (!(aspect > 0)) return { x: 0, y: 0, width: 1, height: 1 };
  if (aspect <= master) {
    const width = aspect / master;
    return { x: (1 - width) / 2, y: 0, width, height: 1 };
  }
  return { x: 0, y: 0, width: 1, height: master / aspect };
};

export interface CoverGuides {
  /** Region of the master this header shows. */
  readonly window: CoverRect;
  /** The rest below are fractions of that header window. */
  readonly avatarTop: number;
  readonly avatarSize: number;
  readonly nameTop: number;
  readonly nameSize: number;
  readonly pencil: CoverRect;
}

/** Mirrors the header CSS: 80 px avatar + 4 px gap, h1 clamp(24px, 5vw, 32px), 44 px pencil at 8/12 px. */
export const guidesFor = (header: HeaderBox): CoverGuides => {
  const { width, height, identityTop } = header;
  return {
    window: coverWindow(width / height),
    avatarTop: identityTop / height,
    avatarSize: 80 / width,
    nameTop: (identityTop + 84) / height,
    nameSize: Math.min(32, Math.max(24, 0.05 * width)) / width,
    pencil: {
      x: (width - 12 - 44) / width,
      y: 8 / height,
      width: 44 / width,
      height: 44 / height,
    },
  };
};

export const isLowResolution = (area: Area, sourceWidth: number) =>
  (area.width / 100) * sourceWidth < COVER_LOW_RESOLUTION_WIDTH;

/** Same crop, allowing the cropper's sub-pixel re-reports (±1 source px). */
export const sameCoverArea = (
  a: Area,
  b: Area,
  size: { readonly width: number; readonly height: number },
) =>
  Math.abs(a.x - b.x) * size.width <= 100 &&
  Math.abs(a.width - b.width) * size.width <= 100 &&
  Math.abs(a.y - b.y) * size.height <= 100 &&
  Math.abs(a.height - b.height) * size.height <= 100;

export type CoverErrorCode =
  | "type"
  | "heic"
  | "bytes"
  | "pixels"
  | "decode"
  | "blank"
  | "too-large"
  | "export";

export class CoverError extends Error {
  constructor(readonly code: CoverErrorCode) {
    super(code);
  }
}

const SOURCE_MESSAGES: Record<CoverErrorCode, string> = {
  type: "仅支持 JPG、PNG 或 WebP 照片",
  heic: "暂不支持 HEIC 照片，请在相册中导出为 JPG 后再选择",
  bytes: "照片超过 25 MiB，请选择较小的照片",
  pixels: "照片像素过高，请选择较小的照片",
  decode: "这张照片无法打开，请换一张",
  blank: "当前设备无法处理这张照片，请换一张较小的照片",
  "too-large": "照片细节过多，无法压缩到 4 MiB 以内，请换一张",
  export: "图像处理失败，背景尚未更改，请重试",
};

export type CoverSavePhase = "upload" | "bind";

/** User-facing copy for a failure; raw browser or server text is never shown. */
export const coverErrorMessage = (
  error: unknown,
  phase?: CoverSavePhase,
): string => {
  if (error instanceof CoverError) return SOURCE_MESSAGES[error.code];
  const bind = phase === "bind";
  if (error instanceof AuthorRequestError) {
    if (error.status === 401)
      return authorClient.account() === null
        ? "暂时无法确认账户，照片和裁剪已保留"
        : "登录状态已失效，背景尚未更改，请重新登录后再试";
    if (error.status === 409 || error.status === 404)
      return "保存状态已变化，背景尚未更改，请重试";
    if (error.status === 413 || error.status === 422)
      return "服务器未接受这张图片，背景尚未更改，请换一张";
    return bind
      ? "无法确认是否已保存，请重试（不会重复保存）"
      : "服务暂时不可用，背景尚未更改，请稍后重试";
  }
  if (bind) return "无法确认是否已保存，请重试（不会重复保存）";
  if (error instanceof DOMException && error.name === "TimeoutError")
    return "上传超时，背景尚未更改，请检查网络后重试";
  return "网络连接失败，背景尚未更改，请重试";
};

/** A failure after which the same ids would be refused: start a new upload. */
export const needsFreshIntent = (error: unknown) =>
  error instanceof AuthorRequestError &&
  (error.status === 409 || error.status === 404);

/** A decoded source for the cover editor. */
export interface CoverSource {
  /** Bounded display copy for the cropper; never uploaded. */
  readonly display: {
    readonly url: string;
    readonly width: number;
    readonly height: number;
  };
  /** Oriented size of the chosen file. */
  readonly width: number;
  readonly height: number;
  /** Oriented, bounded pixels the export draws from. */
  readonly pixels: ImageBitmap;
  /** JPEG sources are opaque; others are checked when exported. */
  readonly opaque: boolean;
  release(): void;
}

export interface CoverReadEnvironment {
  /** Oriented natural size, without decoding the whole picture. */
  measure(file: Blob): Promise<{ width: number; height: number }>;
  decode(file: Blob, options: ImageBitmapOptions): Promise<ImageBitmap>;
  /** A small display copy drawn from the already bounded pixels. */
  display(
    pixels: ImageBitmap,
    opaque: boolean,
  ): Promise<{
    blob: Blob;
    size: { width: number; height: number };
  }>;
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

export const browserCoverEnvironment = (): CoverReadEnvironment => ({
  measure: (file) =>
    new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        URL.revokeObjectURL(url);
        resolve({ width: image.naturalWidth, height: image.naturalHeight });
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new CoverError("decode"));
      };
      image.src = url;
    }),
  decode: (file, options) => {
    if (typeof createImageBitmap !== "function")
      return Promise.reject(new CoverError("decode"));
    return createImageBitmap(file, options);
  },
  display: async (pixels, opaque) => {
    const scale = Math.min(
      1,
      CROP_IMAGE_EDGE / Math.max(pixels.width, pixels.height),
    );
    const size = {
      width: Math.max(1, Math.round(pixels.width * scale)),
      height: Math.max(1, Math.round(pixels.height * scale)),
    };
    const canvas = document.createElement("canvas");
    try {
      const context = canvas.getContext("2d");
      if (!context) throw new CoverError("decode");
      canvas.width = size.width;
      canvas.height = size.height;
      context.drawImage(pixels, 0, 0, size.width, size.height);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(
          resolve,
          opaque ? "image/jpeg" : "image/png",
          opaque ? 0.85 : undefined,
        ),
      );
      if (!blob) throw new CoverError("decode");
      return { blob, size };
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  },
  createObjectURL: (blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
});

const HEIC = /\.(heic|heif)$/iu;
const ACCEPTED = ["image/jpeg", "image/png", "image/webp"];

const decodeBounded = async (
  environment: CoverReadEnvironment,
  file: Blob,
  size: { width: number; height: number },
): Promise<ImageBitmap> => {
  const oriented = { imageOrientation: "from-image" } as const;
  const scale = Math.sqrt(EXPORT_SOURCE_PIXELS / (size.width * size.height));
  // Requested decode width; null decodes at full size.
  let width: number | null =
    scale < 1 ? Math.max(1, Math.floor(size.width * scale)) : null;
  for (let attempt = 0; ; attempt += 1) {
    let bitmap: ImageBitmap;
    try {
      bitmap = await environment.decode(
        file,
        width === null
          ? oriented
          : { ...oriented, resizeWidth: width, resizeQuality: "high" },
      );
    } catch (error) {
      // Engines that refuse the options decode once at full size.
      if (!(error instanceof TypeError)) throw error;
      return environment.decode(file, {});
    }
    const pixels = bitmap.width * bitmap.height;
    // An engine that applies resizeWidth before EXIF rotation returns too
    // many or too few pixels for a rotated photo: correct the request once.
    if (
      width === null ||
      attempt === 1 ||
      (pixels <= EXPORT_SOURCE_PIXELS * 1.05 &&
        pixels >= EXPORT_SOURCE_PIXELS * 0.8)
    )
      return bitmap;
    bitmap.close();
    width = Math.min(
      Math.max(size.width, size.height),
      Math.max(1, Math.floor(width * Math.sqrt(EXPORT_SOURCE_PIXELS / pixels))),
    );
  }
};

/** Background-only source policy; the avatar and the Backend keep their own limits. */
export const readProfileCoverImage = async (
  file: File,
  environment: CoverReadEnvironment = browserCoverEnvironment(),
): Promise<CoverSource> => {
  if (
    file.type === "image/heic" ||
    file.type === "image/heif" ||
    HEIC.test(file.name)
  )
    throw new CoverError("heic");
  if (!ACCEPTED.includes(file.type)) throw new CoverError("type");
  if (file.size === 0) throw new CoverError("decode");
  if (file.size > COVER_SOURCE_BYTES) throw new CoverError("bytes");
  let size: { width: number; height: number };
  try {
    size = await environment.measure(file);
  } catch {
    throw new CoverError("decode");
  }
  if (!(size.width > 0 && size.height > 0)) throw new CoverError("decode");
  if (size.width * size.height > COVER_SOURCE_PIXELS)
    throw new CoverError("pixels");
  const opaque = file.type === "image/jpeg";
  let bitmap: ImageBitmap;
  try {
    bitmap = await decodeBounded(environment, file, size);
  } catch {
    throw new CoverError("decode");
  }
  // One decode of the photo: the display copy is drawn from the bounded pixels.
  let display: Awaited<ReturnType<CoverReadEnvironment["display"]>>;
  try {
    if (
      Math.abs(bitmap.width / bitmap.height - size.width / size.height) > 0.02
    )
      throw new CoverError("decode");
    display = await environment.display(bitmap, opaque);
  } catch {
    bitmap.close();
    throw new CoverError("decode");
  }
  const url = environment.createObjectURL(display.blob);
  let released = false;
  return {
    display: { url, ...display.size },
    width: size.width,
    height: size.height,
    pixels: bitmap,
    opaque,
    release: () => {
      if (released) return;
      released = true;
      bitmap.close();
      environment.revokeObjectURL(url);
    },
  };
};

export interface CoverExport {
  readonly blob: Blob;
  readonly width: number;
  readonly height: number;
}

interface ExportCanvas {
  width: number;
  height: number;
  getContext(
    type: "2d",
    options?: CanvasRenderingContext2DSettings,
  ): CanvasRenderingContext2D | null;
  toBlob(callback: BlobCallback, type?: string): void;
}

export interface CoverExportDeps {
  createCanvas(): ExportCanvas | null;
}

const browserExportDeps: CoverExportDeps = {
  createCanvas: () =>
    typeof document === "undefined" ? null : document.createElement("canvas"),
};

const release = (canvas: ExportCanvas | null) => {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
};

/** Whether no pixel was drawn at all (every alpha is 0), in bounded strips. */
const canvasIsEmpty = (
  context: Drawable2dContext,
  size: { width: number; height: number },
) => {
  for (let y = 0; y < size.height; y += 256) {
    const rows = Math.min(256, size.height - y);
    const { data } = context.getImageData(0, y, size.width, rows);
    for (let index = 3; index < data.length; index += 4)
      if (data[index] !== 0) return false;
  }
  return true;
};

const encodePng = (canvas: ExportCanvas) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));

/**
 * One resample of the chosen area into a 4:3 PNG: widest rung first, never
 * wider than the area's own source pixels, stepping down until it fits.
 */
export const exportProfileCover = async (
  source: Pick<CoverSource, "pixels" | "opaque">,
  area: Area,
  deps: CoverExportDeps = browserExportDeps,
): Promise<CoverExport> => {
  const { pixels } = source;
  const sx = Math.max(0, (area.x / 100) * pixels.width),
    sy = Math.max(0, (area.y / 100) * pixels.height),
    sw = Math.min(pixels.width - sx, (area.width / 100) * pixels.width),
    sh = Math.min(pixels.height - sy, (area.height / 100) * pixels.height);
  if (!(sw >= 1 && sh >= 1)) throw new CoverError("export");
  // The cropper reports a full-width crop as 99.99…%: round, not floor.
  const available = Math.max(1, Math.round(sw));
  const widths = [
    ...new Set(COVER_EXPORT_WIDTHS.map((w) => Math.min(w, available))),
  ];
  let fallback: CoverExport | null = null;
  for (const width of widths) {
    const height = Math.max(1, Math.round(width / COVER_ASPECT));
    const canvas = deps.createCanvas();
    let flat: ExportCanvas | null = null;
    try {
      const context =
        canvas?.getContext("2d", { alpha: true, colorSpace: "srgb" }) ?? null;
      if (!canvas || !context) throw new CoverError("export");
      canvas.width = width;
      canvas.height = height;
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(pixels, sx, sy, sw, sh, 0, 0, width, height);
      const probe = context as unknown as Drawable2dContext;
      // WebKit may silently draw nothing into a canvas over its memory
      // ceiling; a transparent PNG is only refused when nothing at all shows.
      if (
        source.opaque
          ? canvasLooksBlank(probe, { width, height })
          : canvasIsEmpty(probe, { width, height })
      )
        throw new CoverError("blank");
      let target = canvas;
      if (source.opaque || !canvasHasTransparency(probe, { width, height })) {
        // An opaque canvas encodes as RGB: about an eighth smaller.
        flat = deps.createCanvas();
        const flatContext =
          flat?.getContext("2d", { alpha: false, colorSpace: "srgb" }) ?? null;
        if (flat && flatContext) {
          flat.width = width;
          flat.height = height;
          flatContext.drawImage(canvas as HTMLCanvasElement, 0, 0);
          target = flat;
        }
      }
      const blob = await encodePng(target);
      if (!blob || blob.type !== "image/png") throw new CoverError("export");
      if (blob.size <= COVER_SOFT_BYTES)
        return finalize({ blob, width, height });
      if (blob.size <= COVER_HARD_BYTES && fallback === null)
        fallback = { blob, width, height };
    } finally {
      release(canvas);
      release(flat);
    }
  }
  if (fallback) return finalize(fallback);
  throw new CoverError("too-large");
};

const finalize = async (result: CoverExport): Promise<CoverExport> => {
  let bytes: Uint8Array;
  try {
    bytes = normalizeAvatarPng(new Uint8Array(await result.blob.arrayBuffer()));
  } catch {
    throw new CoverError("export");
  }
  return {
    blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "image/png" }),
    width: result.width,
    height: result.height,
  };
};
