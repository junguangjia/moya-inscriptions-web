import type { Area } from "react-easy-crop";
import { CoverError, readProfileCoverImage } from "./profile-cover";
import type { CoverErrorCode } from "./profile-cover";
import { PROFILE_PNG_MAX_BYTES, normalizeAvatarPng } from "./profile-png";

export { normalizeAvatarPng } from "./profile-png";

/**
 * A chosen avatar photo: bounded, oriented pixels the 512 px export draws
 * from, and a small display copy for the cropper (`url`). Any photo the
 * browser can open is accepted (Issue #237); only the 512 px PNG is stored.
 */
export type AvatarImage = {
  readonly pixels: CanvasImageSource & {
    readonly width: number;
    readonly height: number;
  };
  readonly url: string;
  release(): void;
};

const SOURCE_MESSAGES: Record<CoverErrorCode, string> = {
  heic: "当前浏览器无法打开这张 HEIC 照片，请在相册中导出为 JPG 后再选择",
  pixels: "照片像素超出当前设备可处理的范围，请换一张",
  decode: "当前浏览器无法打开这张照片，请换一张",
  blank: "当前设备无法处理这张照片，请换一张",
  export: "当前浏览器无法打开这张照片，请换一张",
};

/** The same bounded reader as the background editor: no type, byte or pixel gate. */
export const readAvatarImage = async (file: File): Promise<AvatarImage> => {
  try {
    const source = await readProfileCoverImage(file);
    return {
      pixels: source.pixels,
      url: source.display.url,
      release: () => source.release(),
    };
  } catch (error) {
    throw new Error(
      error instanceof CoverError
        ? SOURCE_MESSAGES[error.code]
        : SOURCE_MESSAGES.decode,
      { cause: error },
    );
  }
};

/**
 * The crop as the cropper reports it, in percent of the displayed photo,
 * mapped onto the bounded pixels (the display copy has the same shape).
 */
const avatarCanvas = (
  pixels: AvatarImage["pixels"],
  area: Area,
): HTMLCanvasElement => {
  const { width: sourceWidth, height: sourceHeight } = pixels;
  const values = [area.x, area.y, area.width, area.height];
  if (
    !values.every(Number.isFinite) ||
    !(sourceWidth > 0 && sourceHeight > 0) ||
    area.width <= 0 ||
    area.height <= 0
  )
    throw Error("裁剪区域尚未就绪，请重试");
  const x = Math.max(0, (area.x / 100) * sourceWidth),
    y = Math.max(0, (area.y / 100) * sourceHeight),
    width = Math.min(sourceWidth - x, (area.width / 100) * sourceWidth),
    height = Math.min(sourceHeight - y, (area.height / 100) * sourceHeight);
  // A square crop; percentages round, so allow a pixel and a percent.
  if (
    !(width >= 1 && height >= 1) ||
    Math.abs(width - height) > 1 + Math.max(width, height) * 0.01
  )
    throw Error("裁剪区域尚未就绪，请重试");
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 512;
  const context = canvas.getContext("2d", { colorSpace: "srgb" });
  if (!context) throw Error("当前浏览器无法导出图像");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(pixels, x, y, width, height, 0, 0, 512, 512);
  return canvas;
};

/** Synchronous, bounded512px snapshot: Save can durably record intent in the
 * same click handler, before any navigation/unload can interrupt an await. */
export const exportAvatarSnapshot = (
  pixels: AvatarImage["pixels"],
  area: Area,
): string => {
  const data = avatarCanvas(pixels, area).toDataURL("image/png");
  if (!data.startsWith("data:image/png;base64,"))
    throw Error("图像导出失败，请重试");
  const raw = atob(data.slice("data:image/png;base64,".length));
  const bytes = normalizeAvatarPng(
    Uint8Array.from(raw, (c) => c.charCodeAt(0)),
  );
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return `data:image/png;base64,${btoa(binary)}`;
};

export const exportAvatar = async (
  pixels: AvatarImage["pixels"],
  area: Area,
): Promise<Blob> => {
  const canvas = avatarCanvas(pixels, area);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (value) =>
        value ? resolve(value) : reject(Error("图像导出失败，请重试")),
      "image/png",
    ),
  );
  if (blob.type !== "image/png" || blob.size > PROFILE_PNG_MAX_BYTES)
    throw Error("图像导出失败，请重试");
  return new Blob(
    [
      normalizeAvatarPng(
        new Uint8Array(await blob.arrayBuffer()),
      ) as Uint8Array<ArrayBuffer>,
    ],
    { type: "image/png" },
  );
};
