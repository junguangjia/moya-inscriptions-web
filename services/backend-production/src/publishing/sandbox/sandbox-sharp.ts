import { randomBytes } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

/*
 * sharp settings of the media sandbox: no operation cache, one libvips
 * thread per operation, and only the JPEG, PNG and WebP file loaders (every
 * other loader, including sharp's own HEIF, SVG, TIFF and buffer loaders, is
 * blocked; `VIPS_BLOCK_UNTRUSTED=1` is also set in the container).
 */

/** libvips loaders the renderer may use; every other loader is blocked. */
export const SANDBOX_ALLOWED_LOADERS = [
  "VipsForeignLoadJpegFile",
  "VipsForeignLoadPngFile",
  "VipsForeignLoadWebpFile",
] as const;

/** One render at a time, no operation cache, file loaders of three formats. */
export function configureSandboxSharp(): void {
  sharp.cache(false);
  sharp.concurrency(1);
  sharp.block({ operation: ["VipsForeignLoad"] });
  sharp.unblock({ operation: [...SANDBOX_ALLOWED_LOADERS] });
}

/** True when a TIFF load is refused while a PNG file still loads. */
export async function loaderAllowlistHolds(
  directory: string,
): Promise<boolean> {
  const tiff = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "#000000" },
  })
    .tiff()
    .toBuffer();
  const png = path.join(
    directory,
    `probe-${randomBytes(8).toString("hex")}.png`,
  );
  await writeFile(
    png,
    await sharp({
      create: { width: 2, height: 2, channels: 3, background: "#000000" },
    })
      .png()
      .toBuffer(),
  );
  try {
    const tiffRefused = await sharp(tiff)
      .metadata()
      .then(
        () => false,
        () => true,
      );
    const pngLoads = await sharp(png)
      .metadata()
      .then(
        () => true,
        () => false,
      );
    return tiffRefused && pngLoads;
  } finally {
    await unlink(png).catch(() => undefined);
  }
}
