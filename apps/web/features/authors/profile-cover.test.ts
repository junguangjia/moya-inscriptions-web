import { describe, expect, it, vi } from "vitest";
import { AuthorRequestError, authorClient } from "./author-data";
import {
  COVER_ASPECT,
  COVER_HARD_BYTES,
  COVER_SAFE_RECT,
  COVER_SOFT_BYTES,
  CoverError,
  REFERENCE_HEADERS,
  coverErrorMessage,
  coverWindow,
  deviceForWidth,
  exportProfileCover,
  guidesFor,
  isLowResolution,
  needsFreshIntent,
  readProfileCoverImage,
  sameCoverArea,
} from "./profile-cover";
import type { CoverExportDeps, CoverReadEnvironment } from "./profile-cover";

const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 3);

describe("cover geometry", () => {
  it("shows a centred full-height strip on portrait phones", () => {
    const window = coverWindow(390 / 569);
    close(window.width, 390 / 569 / COVER_ASPECT);
    close(window.x, (1 - window.width) / 2);
    expect(window).toMatchObject({ y: 0, height: 1 });
  });

  it("shows the full width from the top on wide desktops", () => {
    const window = coverWindow(960 / 556);
    close(window.height, COVER_ASPECT / (960 / 556));
    expect(window).toMatchObject({ x: 0, y: 0, width: 1 });
    expect(coverWindow(COVER_ASPECT)).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
  });

  it("keeps the safe area inside every supported window and above the fade", () => {
    // Measured header aspects: portrait phones up to three bio lines,
    // tablets, and desktop windows from 1366×657 with an empty bio.
    for (const aspect of [
      0.63, 0.639, 0.657, 0.678, 0.717, 0.815, 0.871, 1.107, 1.194, 1.43, 1.651,
      1.807, 1.954, 2.087,
    ]) {
      const window = coverWindow(aspect);
      const safe = COVER_SAFE_RECT;
      expect(safe.x).toBeGreaterThanOrEqual(window.x);
      expect(safe.x + safe.width).toBeLessThanOrEqual(window.x + window.width);
      expect(safe.y + safe.height).toBeLessThanOrEqual(
        window.y + 0.35 * window.height,
      );
    }
  });

  it("places the identity like the header CSS", () => {
    const phone = guidesFor(REFERENCE_HEADERS.phone);
    close(phone.avatarTop, 330 / 569);
    close(phone.avatarSize, 80 / 390);
    close(phone.nameTop, 414 / 569);
    close(phone.nameSize, 24 / 390);
    close(phone.pencil.x, (390 - 56) / 390);
    const desktop = guidesFor(REFERENCE_HEADERS.desktop);
    close(desktop.nameSize, 32 / 960);
    expect(deviceForWidth(390)).toBe("phone");
    expect(deviceForWidth(768)).toBe("desktop");
  });

  it("flags low resolution and tolerates sub-pixel re-reports", () => {
    const area = { x: 10, y: 0, width: 25, height: 50 };
    expect(isLowResolution(area, 4000)).toBe(true);
    expect(isLowResolution(area, 4096)).toBe(false);
    const size = { width: 4000, height: 3000 };
    expect(sameCoverArea(area, { ...area, x: 10.02 }, size)).toBe(true);
    expect(sameCoverArea(area, { ...area, x: 10.1 }, size)).toBe(false);
  });
});

const file = (name: string, type: string, bytes = 10) =>
  new File([new Uint8Array(bytes)], name, { type });

const bitmap = (width: number, height: number) => ({
  width,
  height,
  close: vi.fn(),
});

const environment = (
  size: { width: number; height: number },
  overrides: Partial<CoverReadEnvironment> = {},
) => {
  const env = {
    measure: vi.fn(async () => size),
    decode: vi.fn(
      async (_: Blob, options: ImageBitmapOptions) =>
        bitmap(
          options.resizeWidth ?? size.width,
          options.resizeWidth
            ? Math.round((options.resizeWidth * size.height) / size.width)
            : size.height,
        ) as unknown as ImageBitmap,
    ),
    display: vi.fn(async () => ({
      blob: new Blob(["display"]),
      size: { width: 2048, height: 1536 },
    })),
    createObjectURL: vi.fn(() => "blob:display"),
    revokeObjectURL: vi.fn(),
    ...overrides,
  };
  return env;
};

const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error instanceof CoverError ? error.code : error;
  }
  return "resolved";
};

describe("readProfileCoverImage", () => {
  it("refuses HEIC, other types, empty and oversized files before decoding", async () => {
    const env = environment({ width: 10, height: 10 });
    expect(await codeOf(readProfileCoverImage(file("a.HEIC", ""), env))).toBe(
      "heic",
    );
    expect(
      await codeOf(readProfileCoverImage(file("a", "image/heif"), env)),
    ).toBe("heic");
    expect(
      await codeOf(readProfileCoverImage(file("a.gif", "image/gif"), env)),
    ).toBe("type");
    expect(
      await codeOf(readProfileCoverImage(file("a.png", "image/png", 0), env)),
    ).toBe("decode");
    const big = file("a.jpg", "image/jpeg");
    Object.defineProperty(big, "size", { value: 25 * 1024 * 1024 + 1 });
    expect(await codeOf(readProfileCoverImage(big, env))).toBe("bytes");
    expect(env.measure).not.toHaveBeenCalled();
  });

  it("refuses more than 50 megapixels and undecodable files", async () => {
    expect(
      await codeOf(
        readProfileCoverImage(
          file("a.jpg", "image/jpeg"),
          environment({ width: 10000, height: 5001 }),
        ),
      ),
    ).toBe("pixels");
    expect(
      await codeOf(
        readProfileCoverImage(
          file("a.jpg", "image/jpeg"),
          environment(
            { width: 10, height: 10 },
            { measure: () => Promise.reject(Error("x")) },
          ),
        ),
      ),
    ).toBe("decode");
  });

  it("accepts a 24 MP photo with a bounded export source and display copy", async () => {
    const env = environment({ width: 5712, height: 4284 });
    const source = await readProfileCoverImage(
      file("IMG.jpg", "image/jpeg"),
      env,
    );
    const options = vi.mocked(env.decode).mock.calls[0]![1];
    expect(options).toMatchObject({
      imageOrientation: "from-image",
      resizeQuality: "high",
    });
    expect(source.pixels.width * source.pixels.height).toBeLessThanOrEqual(
      16 * 1024 * 1024 * 1.05,
    );
    expect(source).toMatchObject({
      width: 5712,
      height: 4284,
      opaque: true,
      display: { url: "blob:display", width: 2048, height: 1536 },
    });
    source.release();
    source.release();
    expect(source.pixels.close).toHaveBeenCalledOnce();
    expect(env.revokeObjectURL).toHaveBeenCalledOnce();
  });

  it("decodes small photos at full size and keeps PNG transparency undecided", async () => {
    const env = environment({ width: 1200, height: 900 });
    const source = await readProfileCoverImage(file("a.png", "image/png"), env);
    expect(vi.mocked(env.decode).mock.calls[0]![1]).toEqual({
      imageOrientation: "from-image",
    });
    expect(source.opaque).toBe(false);
  });

  it("re-decodes smaller when an engine resizes the pre-rotation width", async () => {
    const size = { width: 4284, height: 5712 };
    let calls = 0;
    const env = environment(size, {
      decode: vi.fn(async (_: Blob, options: ImageBitmapOptions) => {
        calls += 1;
        // First answer: the resize was applied to the other side.
        const w =
          calls === 1
            ? Math.round(((options.resizeWidth ?? 0) * 5712) / 4284)
            : (options.resizeWidth ?? 0);
        return bitmap(
          w,
          Math.round((w * 5712) / 4284),
        ) as unknown as ImageBitmap;
      }),
    });
    const source = await readProfileCoverImage(
      file("a.jpg", "image/jpeg"),
      env,
    );
    expect(calls).toBe(2);
    expect(source.pixels.width * source.pixels.height).toBeLessThanOrEqual(
      16 * 1024 * 1024 * 1.05,
    );
  });

  it("closes the decoded source when the display copy fails or the shape is wrong", async () => {
    const failed = bitmap(100, 100);
    const env = environment(
      { width: 100, height: 100 },
      {
        decode: vi.fn(async () => failed as unknown as ImageBitmap),
        display: () => Promise.reject(Error("no canvas")),
      },
    );
    expect(
      await codeOf(readProfileCoverImage(file("a.jpg", "image/jpeg"), env)),
    ).toBe("decode");
    expect(failed.close).toHaveBeenCalled();
    const skewed = bitmap(100, 50);
    expect(
      await codeOf(
        readProfileCoverImage(
          file("a.jpg", "image/jpeg"),
          environment(
            { width: 100, height: 100 },
            { decode: vi.fn(async () => skewed as unknown as ImageBitmap) },
          ),
        ),
      ),
    ).toBe("decode");
    expect(skewed.close).toHaveBeenCalled();
  });
});

/** A structurally valid PNG with an eXIf chunk the Backend would refuse. */
const png = (extra = 0) => {
  const chunk = (type: string, length: number) => {
    const bytes = new Uint8Array(12 + length);
    new DataView(bytes.buffer).setUint32(0, length);
    bytes.set(
      Array.from(type, (c) => c.charCodeAt(0)),
      4,
    );
    return bytes;
  };
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", 13),
    chunk("eXIf", 4),
    chunk("IDAT", 8 + extra),
    chunk("IEND", 0),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

interface FakeContext {
  imageSmoothingEnabled: boolean;
  imageSmoothingQuality: string;
  drawImage: ReturnType<typeof vi.fn>;
  getImageData: (
    x: number,
    y: number,
    w: number,
    h: number,
  ) => { data: Uint8ClampedArray };
  options: CanvasRenderingContext2DSettings | undefined;
}

const exportDeps = ({
  sizeFor = () => 1000,
  alpha = 255,
  type = "image/png",
}: {
  sizeFor?: (width: number) => number;
  alpha?: number;
  type?: string;
} = {}) => {
  const canvases: {
    width: number;
    height: number;
    context: FakeContext | null;
    encoded: boolean;
  }[] = [];
  const deps: CoverExportDeps = {
    createCanvas: () => {
      const canvas = {
        width: 300,
        height: 150,
        context: null as FakeContext | null,
        encoded: false,
        getContext(_: "2d", options?: CanvasRenderingContext2DSettings) {
          canvas.context = {
            imageSmoothingEnabled: false,
            imageSmoothingQuality: "low",
            drawImage: vi.fn(),
            getImageData: (_x, _y, w, h) => {
              const data = new Uint8ClampedArray(w * h * 4);
              for (let i = 3; i < data.length; i += 4) data[i] = alpha;
              return { data };
            },
            options,
          };
          return canvas.context as unknown as CanvasRenderingContext2D;
        },
        toBlob(callback: BlobCallback) {
          canvas.encoded = true;
          const bytes = png();
          const blob = new Blob([bytes], { type });
          Object.defineProperty(blob, "size", {
            value: sizeFor(canvas.width),
          });
          callback(blob);
        },
      };
      canvases.push(canvas);
      return canvas;
    },
  };
  return { deps, canvases };
};

const source = (width = 4000, height = 3000, opaque = true) => ({
  pixels: { width, height } as unknown as ImageBitmap,
  opaque,
});
const full = { x: 0, y: 0, width: 100, height: 100 };

describe("exportProfileCover", () => {
  it("exports the widest rung as an opaque RGB PNG with high-quality smoothing", async () => {
    const { deps, canvases } = exportDeps();
    const result = await exportProfileCover(
      source(),
      { x: 10, y: 20, width: 50, height: 50 },
      deps,
    );
    expect(result).toMatchObject({ width: 1600, height: 1200 });
    const [drawn, flat] = canvases;
    expect(drawn!.context!.options).toMatchObject({ alpha: true });
    expect(drawn!.context!.imageSmoothingQuality).toBe("high");
    expect(drawn!.context!.drawImage).toHaveBeenCalledWith(
      expect.anything(),
      400,
      600,
      2000,
      1500,
      0,
      0,
      1600,
      1200,
    );
    expect(flat!.context!.options).toMatchObject({ alpha: false });
    expect(flat!.encoded).toBe(true);
    // Released backing stores.
    expect(canvases.every((c) => c.width === 0 && c.height === 0)).toBe(true);
    // Only Backend-accepted chunks remain.
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    expect(new TextDecoder().decode(bytes)).not.toContain("eXIf");
    expect(result.blob.type).toBe("image/png");
  });

  it("never exports wider than the chosen source pixels", async () => {
    const { deps } = exportDeps();
    const result = await exportProfileCover(
      source(1200, 900),
      { x: 12.5, y: 0, width: 75, height: 100 },
      deps,
    );
    expect(result).toMatchObject({ width: 900, height: 675 });
    // A full-width crop reported as 99.99…% still uses every source pixel.
    const whole = await exportProfileCover(
      source(1600, 1200),
      { x: 0, y: 0, width: 99.9993, height: 99.9993 },
      deps,
    );
    expect(whole).toMatchObject({ width: 1600, height: 1200 });
  });

  it("steps down under the soft cap, else keeps the first rung under the hard cap", async () => {
    const soft = await exportProfileCover(
      source(),
      full,
      exportDeps({
        sizeFor: (w) => (w > 1280 ? COVER_SOFT_BYTES + 10 : 2_000_000),
      }).deps,
    );
    expect(soft.width).toBe(1280);
    const hard = await exportProfileCover(
      source(),
      full,
      exportDeps({
        sizeFor: (w) =>
          w === 1600 ? COVER_HARD_BYTES + 1 : COVER_SOFT_BYTES + 10,
      }).deps,
    );
    expect(hard.width).toBe(1440);
    expect(
      await codeOf(
        exportProfileCover(
          source(),
          full,
          exportDeps({ sizeFor: () => COVER_HARD_BYTES + 1 }).deps,
        ),
      ),
    ).toBe("too-large");
  });

  it("detects a silently blank canvas for opaque sources only", async () => {
    expect(
      await codeOf(
        exportProfileCover(source(), full, exportDeps({ alpha: 0 }).deps),
      ),
    ).toBe("blank");
    // A transparent PNG keeps its alpha canvas.
    const { deps, canvases } = exportDeps({ alpha: 0 });
    await exportProfileCover(source(4000, 3000, false), full, deps);
    expect(canvases).toHaveLength(1);
    expect(canvases[0]!.encoded).toBe(true);
  });

  it("refuses an encoder that substitutes another type", async () => {
    expect(
      await codeOf(
        exportProfileCover(
          source(),
          full,
          exportDeps({ type: "image/jpeg" }).deps,
        ),
      ),
    ).toBe("export");
  });
});

describe("coverErrorMessage", () => {
  it("maps each failure to copy that says whether the background changed", () => {
    expect(coverErrorMessage(new CoverError("heic"))).toContain("HEIC");
    expect(
      coverErrorMessage(new DOMException("t", "TimeoutError"), "upload"),
    ).toBe("上传超时，背景尚未更改，请检查网络后重试");
    expect(coverErrorMessage(new TypeError("Failed to fetch"), "upload")).toBe(
      "网络连接失败，背景尚未更改，请重试",
    );
    expect(coverErrorMessage(new TypeError("Load failed"), "bind")).toBe(
      "无法确认是否已保存，请重试（不会重复保存）",
    );
    expect(
      coverErrorMessage(new AuthorRequestError(422, "bad"), "upload"),
    ).toContain("服务器未接受这张图片");
    expect(
      coverErrorMessage(new AuthorRequestError(503, "x"), "upload"),
    ).toContain("服务暂时不可用");
    authorClient.setAccount(null);
    expect(coverErrorMessage(new AuthorRequestError(401, "x"))).toBe(
      "暂时无法确认账户，照片和裁剪已保留",
    );
    authorClient.setAccount("author");
    expect(coverErrorMessage(new AuthorRequestError(401, "x"))).toContain(
      "登录状态已失效",
    );
    authorClient.setAccount(null);
    const conflict = new AuthorRequestError(409, "Request identity reused");
    expect(coverErrorMessage(conflict, "bind")).not.toContain("Request");
    expect(needsFreshIntent(conflict)).toBe(true);
    expect(needsFreshIntent(new AuthorRequestError(503, "x"))).toBe(false);
  });
});
