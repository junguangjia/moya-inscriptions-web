// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const read = vi.hoisted(() => vi.fn());
vi.mock("./profile-cover", async (original) => ({
  ...(await original<typeof import("./profile-cover")>()),
  readProfileCoverImage: read,
}));
import { CoverError } from "./profile-cover";
import {
  exportAvatar,
  exportAvatarSnapshot,
  normalizeAvatarPng,
  readAvatarImage,
} from "./avatar-image";
const chunk = (type: string, data: number[] = []) => {
  const bytes = new Uint8Array(12 + data.length);
  new DataView(bytes.buffer).setUint32(0, data.length);
  bytes.set(
    Array.from(type, (c) => c.charCodeAt(0)),
    4,
  );
  bytes.set(data, 8);
  return bytes;
};
const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const png = (...chunks: Uint8Array[]) =>
  Uint8Array.from([...signature, ...chunks.flatMap((c) => [...c])]);
const syntheticPng = png(
  chunk("IHDR", [8, 6]),
  chunk("sRGB", [0]),
  chunk("eXIf", [1, 2, 3]),
  chunk("IDAT", [42, 99]),
  chunk("IEND"),
);
const pixels = { width: 4000, height: 3000 } as unknown as ImageBitmap;
let release: ReturnType<typeof vi.fn>;
beforeEach(() => {
  release = vi.fn();
  read.mockReset();
  read.mockResolvedValue({
    display: { url: "blob:avatar-display", width: 2048, height: 1536 },
    width: 8064,
    height: 6048,
    pixels,
    opaque: true,
    release,
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});
it("accepts any photo the browser opens: no type, byte or pixel gate (#237)", async () => {
  // A 48 MP iPhone photo of 12 MB and an HEIC: both were refused before.
  for (const file of [
    new File([new Uint8Array(12 * 1024 * 1024)], "IMG_0001.JPG", {
      type: "image/jpeg",
    }),
    new File(["heic"], "IMG_0002.HEIC", { type: "image/heic" }),
    new File(["unknown"], "photo", { type: "" }),
  ]) {
    const result = await readAvatarImage(file);
    expect(read).toHaveBeenLastCalledWith(file);
    expect(result.url).toBe("blob:avatar-display");
    expect(result.pixels).toBe(pixels);
  }
  const result = await readAvatarImage(new File(["x"], "a.png"));
  result.release();
  expect(release).toHaveBeenCalledOnce();
});
it("words a refusal only for a photo the browser cannot open", async () => {
  for (const [error, text] of [
    [new CoverError("heic"), "HEIC"],
    [new CoverError("decode"), "无法打开"],
    [new CoverError("pixels"), "像素"],
    [Error("raw browser text"), "无法打开"],
  ] as const) {
    read.mockRejectedValueOnce(error);
    const message = await readAvatarImage(new File(["x"], "a.jpg")).then(
      () => "",
      (failure: Error) => failure.message,
    );
    expect(message).toContain(text);
    expect(message).not.toContain("raw browser text");
  }
});
const pngCanvas = (draw: ReturnType<typeof vi.fn>) => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: draw,
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (
    this: HTMLCanvasElement,
    callback,
    type,
  ) {
    expect(this.width).toBe(512);
    expect(this.height).toBe(512);
    expect(type).toBe("image/png");
    const blob = new Blob([syntheticPng], { type: type ?? "image/png" });
    Object.defineProperty(blob, "arrayBuffer", {
      value: async () => syntheticPng.buffer,
    });
    callback(blob);
  });
};
it("maps the percent crop onto the bounded pixels as a 512px PNG", async () => {
  const draw = vi.fn();
  pngCanvas(draw);
  const output = await exportAvatar(pixels, {
    x: 10,
    y: 20,
    width: 30,
    height: 40,
  });
  expect(draw).toHaveBeenCalledWith(
    pixels,
    400,
    600,
    1200,
    1200,
    0,
    0,
    512,
    512,
  );
  expect(output.type).toBe("image/png");
});
it("clamps rounding at the photo's edge and refuses a crop that is not ready", async () => {
  const draw = vi.fn();
  pngCanvas(draw);
  await exportAvatar(pixels, { x: -0.01, y: 0, width: 75, height: 100 });
  expect(draw).toHaveBeenLastCalledWith(
    pixels,
    0,
    0,
    3000,
    3000,
    0,
    0,
    512,
    512,
  );
  for (const area of [
    { x: 90, y: 0, width: 30, height: 40 },
    { x: 0, y: 0, width: 50, height: 10 },
    { x: Number.NaN, y: 0, width: 0, height: 0 },
  ])
    await expect(exportAvatar(pixels, area)).rejects.toThrow("裁剪区域");
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
    (callback) => callback(null),
  );
  await expect(
    exportAvatar(pixels, { x: 0, y: 0, width: 75, height: 100 }),
  ).rejects.toThrow("图像导出失败");
});

it("strips Safari ancillary metadata without changing compressed pixels or retained chunk CRCs", () => {
  const expected = png(
    chunk("IHDR", [8, 6]),
    chunk("sRGB", [0]),
    chunk("IDAT", [42, 99]),
    chunk("IEND"),
  );
  expect(normalizeAvatarPng(syntheticPng)).toEqual(expected);
  expect(normalizeAvatarPng(expected)).toEqual(expected);
  expect(() => normalizeAvatarPng(syntheticPng.subarray(0, -1))).toThrow(
    "导出失败",
  );
  expect(() =>
    normalizeAvatarPng(png(chunk("IHDR"), chunk("PLTE"), chunk("IEND"))),
  ).toThrow("格式不支持");
});
it("creates a synchronous normalized sRGB snapshot for the Save click", () => {
  const context = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
    `data:image/png;base64,${btoa(String.fromCharCode(...syntheticPng))}`,
  );
  const output = exportAvatarSnapshot(pixels, {
    x: 0,
    y: 0,
    width: 75,
    height: 100,
  });
  expect(typeof output).toBe("string");
  expect(context).toHaveBeenCalledWith("2d", { colorSpace: "srgb" });
  expect(
    Uint8Array.from(atob(output.split(",")[1]!), (c) => c.charCodeAt(0)),
  ).toEqual(normalizeAvatarPng(syntheticPng));
});
