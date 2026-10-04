// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { coverCard, decoded } from "./profile-cover-colors";

/** WCAG relative luminance of an sRGB colour (0–255 channels). */
const luminance = (channels: readonly number[]) => {
  const [red, green, blue] = channels.map((value) => {
    const unit = value / 255;
    return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
};
const channels = (color: string) => color.match(/\d+/gu)!.map(Number);
/** `veil` of `tint` over `photo`, in whole channels as painted. */
const veiled = (photo: number[], tint: number[], veil: number) =>
  photo.map((value, index) =>
    Math.round(value * (1 - veil) + tint[index]! * veil),
  );

type Color = [number, number, number];
const PAPER: Color = [36, 35, 31];
/**
 * A photo drawn through a stubbed 2D canvas: the box colour until the photo
 * is drawn, then `color` at each canvas pixel (or one colour throughout).
 */
const photo = (
  color: Color | ((x: number, y: number) => Color),
  draws = true,
) => {
  let drawn = false;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    fillStyle: "",
    fillRect: vi.fn(),
    drawImage: () => {
      drawn = draws;
    },
    getImageData: (_x: number, _y: number, width: number, height: number) => {
      const data = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const pixel = !drawn
            ? PAPER
            : typeof color === "function"
              ? color(x, y)
              : color;
          data.set([...pixel, 255], (y * width + x) * 4);
        }
      return { data };
    },
  } as unknown as CanvasRenderingContext2D);
  const image = document.createElement("img");
  Object.defineProperty(image, "naturalWidth", { value: 1600 });
  Object.defineProperty(image, "naturalHeight", { value: 1200 });
  return image;
};

// A phone's compact cover: the card under the top bar, the name and the
// counts on it (both below the card's top sheen).
const layout = {
  width: 390,
  coverHeight: 844,
  card: { x: 10, y: 54, width: 370, height: 150 },
  texts: [
    { x: 108, y: 80, width: 200, height: 52 },
    { x: 18, y: 166, width: 140, height: 28 },
  ],
};

describe("coverCard", () => {
  afterEach(() => vi.restoreAllMocks());

  it("tints a bright photo just enough for the identity's text", () => {
    const result = coverCard(photo([230, 226, 214]), layout)!;
    const tint = channels(result.tint);
    // The photo's own hue, darkened into a shade.
    expect(luminance(tint)).toBeLessThanOrEqual(0.014);
    expect(tint[0]).toBeGreaterThanOrEqual(tint[2]!);
    // #e7e1d6 reads at 4.5:1 over the glass, and no thinner tint would do.
    expect(
      luminance(veiled([230, 226, 214], tint, result.alpha)),
    ).toBeLessThanOrEqual(0.115);
    expect(
      luminance(veiled([230, 226, 214], tint, result.alpha - 0.02)),
    ).toBeGreaterThan(0.115);
  });

  it("counts the frost's saturation over a vivid red photo", () => {
    // saturate(1.15), as browsers apply it in sRGB, brightens the red.
    const red = [220, 40, 40];
    const matrix = [
      [0.213 + 0.787 * 1.15, 0.715 - 0.715 * 1.15, 0.072 - 0.072 * 1.15],
      [0.213 - 0.213 * 1.15, 0.715 + 0.285 * 1.15, 0.072 - 0.072 * 1.15],
      [0.213 - 0.213 * 1.15, 0.715 - 0.715 * 1.15, 0.072 + 0.928 * 1.15],
    ];
    const saturated = matrix.map((weights) =>
      Math.min(
        255,
        Math.max(
          0,
          weights.reduce(
            (sum, weight, column) => sum + weight * red[column]!,
            0,
          ),
        ),
      ),
    );
    const result = coverCard(photo([220, 40, 40]), layout)!;
    const tint = channels(result.tint);
    expect(
      luminance(veiled(saturated, tint, result.alpha)),
    ).toBeLessThanOrEqual(0.115);
    // Without the saturation the same tint would look thicker than needed.
    expect(luminance(veiled(red, tint, result.alpha))).toBeLessThan(
      luminance(veiled(saturated, tint, result.alpha)),
    );
  });

  it("keeps the thinnest tint over a mid-dark photo", () => {
    const result = coverCard(photo([70, 74, 68]), layout)!;
    // The floor, 0.18, rounded up to a step browsers paint (46/255).
    expect(result.alpha).toBe(0.1804);
  });

  it("frosts a dark photo with a faint milky light instead", () => {
    const result = coverCard(photo([22, 22, 24]), layout)!;
    expect(result.alpha).toBe(0.1);
    expect(luminance(channels(result.tint))).toBeGreaterThan(0.5);
  });

  it("judges a line by its brightest point, not by most of its box", () => {
    // A bright carved stroke behind the first glyphs of the name, on mid-grey
    // stone. Canvas pixel (0, 0) is the card's corner less the blur's reach.
    const stone: Color = [90, 92, 86];
    const plain = coverCard(photo(stone), layout)!;
    vi.restoreAllMocks();
    const stroke = coverCard(
      photo((x, y) =>
        x >= 113 && x < 127 && y >= 41 && y < 71 ? [252, 250, 244] : stone,
      ),
      layout,
    )!;
    expect(plain.alpha).toBe(0.1804);
    expect(stroke.alpha).toBeGreaterThan(0.45);
  });

  it("keeps the default tint when the photo draws blank", () => {
    expect(coverCard(photo([230, 226, 214], false), layout)).toBeNull();
  });

  it("gives up without a decoded image or a card", () => {
    expect(coverCard(document.createElement("img"), layout)).toBeNull();
    expect(
      coverCard(photo([230, 226, 214]), {
        ...layout,
        card: { ...layout.card, width: 0 },
      }),
    ).toBeNull();
  });
});

describe("decoded", () => {
  it("resolves whether or not the image can decode", async () => {
    const image = document.createElement("img");
    Object.defineProperty(image, "decode", {
      value: () => Promise.reject(new Error("broken")),
    });
    await expect(decoded(image)).resolves.toBeUndefined();
    await expect(
      decoded(document.createElement("img")),
    ).resolves.toBeUndefined();
  });
});
