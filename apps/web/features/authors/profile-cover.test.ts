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
    const window = coverWindow(390 / 844);
    close(window.width, 390 / 844 / COVER_ASPECT);
    close(window.x, (1 - window.width) / 2);
    expect(window).toMatchObject({ y: 0, height: 1 });
  });

  it("shows the full width from the top on wide desktops", () => {
    const window = coverWindow(1366 / 657);
    close(window.height, COVER_ASPECT / (1366 / 657));
    expect(window).toMatchObject({ x: 0, y: 0, width: 1 });
    expect(coverWindow(COVER_ASPECT)).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
  });

  it("keeps the safe area visible, clear of every control and above the identity panel", () => {
    // Measured covers [width, height, panel top, controls] (the owner's own
    // profile, profile-hero-layout-v1): portrait phones from 360 px and
    // tablets with empty, one- and three-line bios; desktop windows from
    // 1024×768 and 1366×657 with empty and one-line bios.
    const measured: readonly (readonly [
      number,
      number,
      number,
      readonly (readonly [number, number, number, number])[],
    ])[] = [
      [
        360,
        640,
        304,
        [
          [12, 4, 44, 44],
          [304, 4, 44, 44],
          [304, 56, 44, 44],
        ],
      ],
      [
        360,
        648.8,
        282.4,
        [
          [12, 4, 44, 44],
          [304, 4, 44, 44],
          [304, 56, 44, 44],
        ],
      ],
      [
        360,
        716,
        282.4,
        [
          [12, 4, 44, 44],
          [304, 4, 44, 44],
          [304, 56, 44, 44],
        ],
      ],
      [
        375,
        667,
        331,
        [
          [12, 4, 44, 44],
          [319, 4, 44, 44],
          [319, 56, 44, 44],
        ],
      ],
      [
        375,
        667,
        300.6,
        [
          [12, 4, 44, 44],
          [319, 4, 44, 44],
          [319, 56, 44, 44],
        ],
      ],
      [
        375,
        725.7,
        292.1,
        [
          [12, 4, 44, 44],
          [319, 4, 44, 44],
          [319, 56, 44, 44],
        ],
      ],
      [
        390,
        844,
        508,
        [
          [12, 4, 44, 44],
          [334, 4, 44, 44],
          [334, 56, 44, 44],
        ],
      ],
      [
        390,
        844,
        477.6,
        [
          [12, 4, 44, 44],
          [334, 4, 44, 44],
          [334, 56, 44, 44],
        ],
      ],
      [
        390,
        844,
        410.4,
        [
          [12, 4, 44, 44],
          [334, 4, 44, 44],
          [334, 56, 44, 44],
        ],
      ],
      [
        393,
        852,
        516,
        [
          [12, 4, 44, 44],
          [337, 4, 44, 44],
          [337, 56, 44, 44],
        ],
      ],
      [
        393,
        852,
        485.6,
        [
          [12, 4, 44, 44],
          [337, 4, 44, 44],
          [337, 56, 44, 44],
        ],
      ],
      [
        393,
        852,
        418.4,
        [
          [12, 4, 44, 44],
          [337, 4, 44, 44],
          [337, 56, 44, 44],
        ],
      ],
      [
        430,
        932,
        596,
        [
          [12, 4, 44, 44],
          [374, 4, 44, 44],
          [374, 56, 44, 44],
        ],
      ],
      [
        430,
        932,
        565.6,
        [
          [12, 4, 44, 44],
          [374, 4, 44, 44],
          [374, 56, 44, 44],
        ],
      ],
      [
        430,
        932,
        498.4,
        [
          [12, 4, 44, 44],
          [374, 4, 44, 44],
          [374, 56, 44, 44],
        ],
      ],
      [
        768,
        1024,
        688,
        [
          [12, 4, 44, 44],
          [712, 4, 44, 44],
          [712, 56, 44, 44],
        ],
      ],
      [
        768,
        1024,
        657.6,
        [
          [12, 4, 44, 44],
          [712, 4, 44, 44],
          [712, 56, 44, 44],
        ],
      ],
      [
        768,
        1024,
        612.8,
        [
          [12, 4, 44, 44],
          [712, 4, 44, 44],
          [712, 56, 44, 44],
        ],
      ],
      [
        960,
        768,
        432,
        [
          [-20, 4, 44, 44],
          [936, 4, 44, 44],
          [904, 56, 44, 44],
        ],
      ],
      [
        960,
        768,
        401.6,
        [
          [-20, 4, 44, 44],
          [936, 4, 44, 44],
          [904, 56, 44, 44],
        ],
      ],
      [960, 800, 464, [[904, 56, 44, 44]]],
      [960, 800, 433.6, [[904, 56, 44, 44]]],
      [960, 657, 321, [[904, 56, 44, 44]]],
      [960, 657, 290.6, [[904, 56, 44, 44]]],
      [960, 900, 564, [[904, 56, 44, 44]]],
      [960, 900, 533.6, [[904, 56, 44, 44]]],
      [960, 1080, 744, [[904, 56, 44, 44]]],
      [960, 1080, 713.6, [[904, 56, 44, 44]]],
    ];
    const safe = COVER_SAFE_RECT;
    for (const [width, height, panelTop, controls] of measured) {
      const guides = guidesFor({
        ...REFERENCE_HEADERS.phone,
        width,
        height,
        panelTop,
        controls: controls.map(([x, y, w, h]) => ({
          x,
          y,
          width: w,
          height: h,
        })),
      });
      const { window } = guides;
      expect(safe.x).toBeGreaterThanOrEqual(window.x);
      expect(safe.x + safe.width).toBeLessThanOrEqual(window.x + window.width);
      expect(safe.y + safe.height).toBeLessThanOrEqual(
        window.y + guides.panelTop * window.height,
      );
      for (const control of guides.controls) {
        // The control in master fractions.
        const left = window.x + control.x * window.width,
          top = window.y + control.y * window.height,
          right = left + control.width * window.width,
          bottom = top + control.height * window.height;
        expect(
          right <= safe.x ||
            left >= safe.x + safe.width ||
            bottom <= safe.y ||
            top >= safe.y + safe.height,
        ).toBe(true);
      }
    }
  });

  it("reports the measured header as fractions of itself", () => {
    const phone = guidesFor(REFERENCE_HEADERS.phone);
    close(phone.panelTop, 477.6 / 844);
    close(phone.avatar.x, 16 / 390);
    close(phone.avatar.y, 573.6 / 844);
    close(phone.avatar.width, 80 / 390);
    close(phone.avatar.height, 80 / 844);
    close(phone.name.x, 108 / 390);
    close(phone.name.y, 587.7 / 844);
    close(phone.name.size, 24 / 390);
    expect(phone.controls).toHaveLength(3);
    close(phone.controls[2]!.x, 334 / 390);
    close(phone.controls[2]!.y, 56 / 844);
    const desktop = guidesFor(REFERENCE_HEADERS.desktop);
    close(desktop.name.size, 32 / 960);
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
  it("accepts any type and size the browser opens: no gate on the chosen file (#237)", async () => {
    for (const chosen of [
      file("a.HEIC", "image/heic"),
      file("a", "image/heif"),
      file("a.gif", "image/gif"),
      file("photo", ""),
    ]) {
      const env = environment({ width: 4032, height: 3024 });
      expect(await codeOf(readProfileCoverImage(chosen, env))).toBe("resolved");
      expect(env.measure).toHaveBeenCalledWith(chosen);
    }
    // 48 MB, as a 200 MP camera can produce: decoded bounded, not refused.
    const big = file("a.jpg", "image/jpeg");
    Object.defineProperty(big, "size", { value: 48 * 1024 * 1024 });
    const env = environment({ width: 16320, height: 12240 });
    expect(await codeOf(readProfileCoverImage(big, env))).toBe("resolved");
    const [, options] = vi.mocked(env.decode).mock.calls[0]!;
    expect(options.resizeWidth).toBeLessThan(16320);
  });

  it("refuses only what the browser cannot open, or beyond the crash guard", async () => {
    const unreadable = { measure: () => Promise.reject(Error("x")) };
    expect(
      await codeOf(
        readProfileCoverImage(
          file("a.jpg", "image/jpeg"),
          environment({ width: 10, height: 10 }, unreadable),
        ),
      ),
    ).toBe("decode");
    // An HEIC this browser cannot open names the way out.
    expect(
      await codeOf(
        readProfileCoverImage(
          file("IMG.HEIC", ""),
          environment({ width: 10, height: 10 }, unreadable),
        ),
      ),
    ).toBe("heic");
    expect(
      await codeOf(
        readProfileCoverImage(
          file("a.png", "image/png", 0),
          environment({ width: 10, height: 10 }),
        ),
      ),
    ).toBe("decode");
    // Beyond any phone camera (256 Mi px): a crash guard, not a size limit.
    expect(
      await codeOf(
        readProfileCoverImage(
          file("a.jpg", "image/jpeg"),
          environment({ width: 20000, height: 14000 }),
        ),
      ),
    ).toBe("pixels");
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

  /**
   * An engine that applies resizeWidth to the stored (pre-rotation) width:
   * a rotated photo decodes too small (portrait stored landscape) or too
   * large (landscape stored portrait) on the first attempt.
   */
  const preRotationEngine = (stored: { width: number; height: number }) => {
    const calls: number[] = [];
    const decode = vi.fn(async (_: Blob, options: ImageBitmapOptions) => {
      const width = options.resizeWidth ?? stored.width;
      calls.push(width);
      const height = Math.round((width * stored.height) / stored.width);
      // Returned in display orientation (rotated a quarter turn).
      return bitmap(height, width) as unknown as ImageBitmap;
    });
    return { decode, calls };
  };

  it("corrects a pre-rotation resize that returns too few pixels", async () => {
    const engine = preRotationEngine({ width: 5712, height: 4284 });
    const source = await readProfileCoverImage(
      file("a.jpg", "image/jpeg"),
      environment({ width: 4284, height: 5712 }, { decode: engine.decode }),
    );
    expect(engine.calls).toHaveLength(2);
    const pixels = source.pixels.width * source.pixels.height;
    expect(pixels).toBeGreaterThanOrEqual(16 * 1024 * 1024 * 0.8);
    expect(pixels).toBeLessThanOrEqual(16 * 1024 * 1024 * 1.05);
  });

  it("corrects a pre-rotation resize that returns too many pixels", async () => {
    const engine = preRotationEngine({ width: 4284, height: 5712 });
    const source = await readProfileCoverImage(
      file("a.jpg", "image/jpeg"),
      environment({ width: 5712, height: 4284 }, { decode: engine.decode }),
    );
    expect(engine.calls).toHaveLength(2);
    expect(source.pixels.width * source.pixels.height).toBeLessThanOrEqual(
      16 * 1024 * 1024 * 1.05,
    );
  });

  it("decodes the photo once and draws the display copy from those pixels", async () => {
    const env = environment({ width: 4000, height: 3000 });
    const source = await readProfileCoverImage(
      file("a.jpg", "image/jpeg"),
      env,
    );
    expect(env.decode).toHaveBeenCalledOnce();
    expect(env.display).toHaveBeenCalledWith(source.pixels, true);
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
  alpha = () => 255,
  type = "image/png",
}: {
  sizeFor?: (width: number) => number;
  alpha?: (index: number) => number;
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
              for (let i = 3; i < data.length; i += 4) data[i] = alpha(i);
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
      // Unreachable in practice (a 1024 × 768 PNG fits even uncompressed); if
      // an encoder ever overshoots, the save fails as an export error, with no
      // "photo too detailed" refusal (#237).
    ).toBe("export");
  });

  it("refuses a silently blank canvas, but keeps a transparent PNG's alpha", async () => {
    // Opaque source: sampled rows with alpha 0 mean nothing was drawn.
    expect(
      await codeOf(
        exportProfileCover(source(), full, exportDeps({ alpha: () => 0 }).deps),
      ),
    ).toBe("blank");
    // Transparent source: refused only when every pixel is empty.
    expect(
      await codeOf(
        exportProfileCover(
          source(4000, 3000, false),
          full,
          exportDeps({ alpha: () => 0 }).deps,
        ),
      ),
    ).toBe("blank");
    const { deps, canvases } = exportDeps({
      alpha: (index) => (index % 8 === 3 ? 0 : 255),
    });
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
