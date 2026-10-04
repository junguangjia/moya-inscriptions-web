/**
 * Colours sampled from a profile's cover photo (profile-hero-layout-v1): the
 * status-bar tint and dark shade of the cover-first header, and the tint of
 * the glass card the identity sits on in the collections stage.
 */
import { lightTheme } from "@moya/design-tokens";

type Channels = [number, number, number];
/** The dark theme's seal-red (#ce6f54) reads at 4.5:1 on a darker shade. */
const COVER_SHADE_MAX_LUMINANCE = 0.016;
/** The card's frost, in CSS px; the stylesheet's blur matches it. */
const COVER_CARD_BLUR = 5;
/**
 * Behind its text the glass stays this dark at most: the dark theme's
 * primary text (#e7e1d6) reads at 4.5:1 up to 0.129.
 */
const COVER_CARD_MAX_LUMINANCE = 0.115;
/** The tint never thins below this, so the card always reads as tinted glass. */
const COVER_CARD_MIN_VEIL = 0.18;
/** The card's tint: its own colour, darkened this far. */
const COVER_CARD_SHADE_LUMINANCE = 0.014;
/** Over a dark photo, a faint milky frost (light at this opacity)… */
const COVER_CARD_FROST = 0.1;
/** …when the glass behind the text stays this dark under it. */
const COVER_CARD_FROST_LUMINANCE = 0.06;
/** The card's top sheen (as in the stylesheet): paper light, fading out. */
const COVER_CARD_SHEEN = 0.06;
const COVER_CARD_SHEEN_HEIGHT = 18;
/** The design tokens' paper light, for the sheen and the frost. */
const COVER_CARD_LIGHT = [1, 3, 5].map((offset) =>
  Number.parseInt(lightTheme["paper-light"].slice(offset, offset + 2), 16),
) as Channels;

/**
 * A region of the master (fractions) drawn onto a small grid of cells, each
 * the average colour of its part, or null.
 */
const sampleCells = (
  image: HTMLImageElement,
  region: { x: number; y: number; width: number; height: number },
  columns: number,
  rows: number,
): Channels[] | null => {
  const { naturalWidth: width, naturalHeight: height } = image;
  if (!width || !height) return null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = columns;
    canvas.height = rows;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.imageSmoothingQuality = "high";
    // A transparent master shows the cover's own colour through it.
    context.fillStyle = image.parentElement
      ? getComputedStyle(image.parentElement).backgroundColor
      : "transparent";
    context.fillRect(0, 0, columns, rows);
    context.drawImage(
      image,
      width * region.x,
      height * region.y,
      width * region.width,
      Math.max(1, height * region.height),
      0,
      0,
      columns,
      rows,
    );
    const data = context.getImageData(0, 0, columns, rows).data;
    const cells: Channels[] = [];
    for (let index = 0; index < data.length; index += 4)
      cells.push([data[index]!, data[index + 1]!, data[index + 2]!]);
    return cells;
  } catch {
    return null;
  }
};
/** Resolves once the image can be drawn (an undecoded one may draw nothing). */
export const decoded = (image: HTMLImageElement) =>
  (typeof image.decode === "function"
    ? image.decode()
    : Promise.resolve()
  ).catch(() => undefined);
/** The average colour of a region of the master (fractions), or null. */
const averageColor = (
  image: HTMLImageElement,
  region: { x: number; y: number; width: number; height: number },
): Channels | null => {
  const cells = sampleCells(image, region, 32, 8);
  if (!cells?.length) return null;
  const sum = cells.reduce<Channels>(
    (total, cell) => [
      total[0] + cell[0],
      total[1] + cell[1],
      total[2] + cell[2],
    ],
    [0, 0, 0],
  );
  return sum.map((value) => value / cells.length) as Channels;
};
const rgb = ([red, green, blue]: readonly number[]) =>
  `rgb(${Math.round(red!)} ${Math.round(green!)} ${Math.round(blue!)})`;
/** WCAG relative luminance of an sRGB colour (0–255 channels). */
const luminance = (channels: readonly number[]) => {
  const [red, green, blue] = channels.map((value) => {
    const unit = value / 255;
    return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
};
/** sRGB channel (0–255, as painted) to linear light. */
const LINEAR = Float64Array.from({ length: 256 }, (_, value) => {
  const unit = value / 255;
  return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
});
/** Luminance of a painted colour: channels rounded to whole values. */
const paintedLuminance = (red: number, green: number, blue: number) =>
  0.2126 * LINEAR[Math.round(red)]! +
  0.7152 * LINEAR[Math.round(green)]! +
  0.0722 * LINEAR[Math.round(blue)]!;
/** `veil` (opacity 0–1) of `over` laid on `under`, as browsers composite. */
const veiled = (under: Channels, over: Channels, veil: number) =>
  under.map(
    (value, index) => value * (1 - veil) + over[index]! * veil,
  ) as Channels;
/**
 * The cover's colours, sampled from the master: the live cover is
 * top-anchored and centred, and on phones shows a centre strip, so the
 * middle half stands for every window without measuring the (possibly
 * hidden) layout. `tint` is its top edge, for Safari's status bar; `shade` is
 * its lower part darkened until the dark theme's text, including the
 * seal-red counts, reads at 4.5:1 or more on it, so the photo sinks into its
 * own dark tone.
 */
export const coverColors = (
  image: HTMLImageElement,
): { tint: string; shade: string } | null => {
  const top = averageColor(image, { x: 0.25, y: 0, width: 0.5, height: 0.03 });
  const low = averageColor(image, {
    x: 0.25,
    y: 0.7,
    width: 0.5,
    height: 0.3,
  });
  if (!top || !low) return null;
  let shade = low;
  for (
    let step = 0;
    step < 60 && luminance(shade) > COVER_SHADE_MAX_LUMINANCE;
    step++
  )
    shade = shade.map((value) => value * 0.9) as Channels;
  return { tint: rgb(top), shade: rgb(shade) };
};

/** A box in the photo's box at the collections stage, in CSS px. */
export interface CoverBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
/** Where the glass card and the identity's text sit at the collections stage. */
export interface CoverCardLayout {
  /** The photo's box: its width, and the image's full-cover height. */
  readonly width: number;
  readonly coverHeight: number;
  readonly card: CoverBox;
  readonly texts: readonly CoverBox[];
}
/**
 * The glass card's tint, sampled from the photo as the card shows it (the
 * photo over the box colour under the card, blurred as the CSS blurs it): the
 * card's own average colour darkened into a shade, so the glass keeps the
 * photo's hue, laid on at the thinnest opacity under which every line of the
 * identity's text (the dark theme's primary text on the glass) reads at 4.5:1
 * or more over the brightest point of the glass behind it, sheen included. A
 * photo already dark enough everywhere behind the text gets a faint milky
 * frost instead, as frosted glass reads over a dark ground. Null when the
 * photo drew nothing (WebKit can draw an image blank), so the stylesheet's
 * default tint, safe for any photo, holds.
 */
export const coverCard = (
  image: HTMLImageElement,
  layout: CoverCardLayout,
): { tint: string; alpha: number } | null => {
  const { naturalWidth: width, naturalHeight: height } = image;
  const { card } = layout;
  if (!width || !height || card.width <= 0 || card.height <= 0) return null;
  try {
    const reach = COVER_CARD_BLUR * 3,
      left = Math.floor(card.x - reach),
      top = Math.floor(card.y - reach),
      columns = Math.ceil(card.width + 2 * reach),
      rows = Math.ceil(card.height + 2 * reach);
    const canvas = document.createElement("canvas");
    canvas.width = columns;
    canvas.height = rows;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.fillStyle = image.parentElement
      ? getComputedStyle(image.parentElement).backgroundColor
      : "transparent";
    context.fillRect(0, 0, columns, rows);
    const fill = context.getImageData(0, 0, 1, 1).data;
    // The sharp image's own layout (object-fit: cover, top-anchored,
    // centred), one canvas pixel per CSS pixel; a destination rectangle
    // only, as Safari rejects source rectangles outside the image.
    const scale = Math.max(layout.width / width, layout.coverHeight / height);
    context.drawImage(
      image,
      (layout.width - width * scale) / 2 - left,
      -top,
      width * scale,
      height * scale,
    );
    const data = context.getImageData(0, 0, columns, rows).data;
    let drawn = false;
    for (let index = 0; index < data.length && !drawn; index += 4)
      drawn =
        Math.abs(data[index]! - fill[0]!) > 1 ||
        Math.abs(data[index + 1]! - fill[1]!) > 1 ||
        Math.abs(data[index + 2]! - fill[2]!) > 1;
    if (!drawn) return null;
    // Three box blurs per channel come close to the CSS Gaussian blur.
    const channels = [0, 1, 2].map((offset) => {
      const plane = new Float32Array(columns * rows);
      for (let index = 0; index < plane.length; index++)
        plane[index] = data[index * 4 + offset]!;
      return plane;
    });
    const radius = COVER_CARD_BLUR,
      span = 2 * radius + 1,
      scratch = new Float32Array(columns * rows);
    const clamp = (value: number, last: number) =>
      value < 0 ? 0 : value > last ? last : value;
    for (const plane of channels)
      for (let pass = 0; pass < 3; pass++) {
        for (let y = 0; y < rows; y++) {
          const row = y * columns;
          let sum = 0;
          for (let x = -radius; x <= radius; x++)
            sum += plane[row + clamp(x, columns - 1)]!;
          for (let x = 0; x < columns; x++) {
            scratch[row + x] = sum / span;
            sum +=
              plane[row + clamp(x + radius + 1, columns - 1)]! -
              plane[row + clamp(x - radius, columns - 1)]!;
          }
        }
        for (let x = 0; x < columns; x++) {
          let sum = 0;
          for (let y = -radius; y <= radius; y++)
            sum += scratch[clamp(y, rows - 1) * columns + x]!;
          for (let y = 0; y < rows; y++) {
            plane[y * columns + x] = sum / span;
            sum +=
              scratch[clamp(y + radius + 1, rows - 1) * columns + x]! -
              scratch[clamp(y - radius, rows - 1) * columns + x]!;
          }
        }
      }
    const glassAt = (x: number, y: number): Channels => {
      const index =
        clamp(Math.round(y) - top, rows - 1) * columns +
        clamp(Math.round(x) - left, columns - 1);
      return [channels[0]![index]!, channels[1]![index]!, channels[2]![index]!];
    };
    const sum: Channels = [0, 0, 0];
    let count = 0;
    for (let y = card.y; y < card.y + card.height; y += 2)
      for (let x = card.x; x < card.x + card.width; x += 2) {
        const color = glassAt(x, y);
        sum[0] += color[0];
        sum[1] += color[1];
        sum[2] += color[2];
        count++;
      }
    if (!count) return null;
    const average = sum.map((value) => value / count) as Channels;
    let shade = average;
    for (
      let step = 0;
      step < 80 && luminance(shade) > COVER_CARD_SHADE_LUMINANCE;
      step++
    )
      shade = shade.map((value) => value * 0.9) as Channels;
    // Solved as the browser paints it: the tint in whole channels.
    shade = shade.map(Math.round) as Channels;
    // The brightest point of the glass behind a line of text, under `veil`
    // of `tint` and the card's top sheen.
    const brightest = (box: CoverBox, tint: Channels, veil: number) => {
      let peak = 0;
      for (
        let y = Math.max(box.y, card.y);
        y < Math.min(box.y + box.height, card.y + card.height);
        y++
      ) {
        const sheen =
          COVER_CARD_SHEEN *
          Math.max(0, 1 - (y - card.y) / COVER_CARD_SHEEN_HEIGHT);
        for (let x = box.x; x < box.x + box.width; x++) {
          const glass = glassAt(x, y);
          const painted = [0, 1, 2].map((channel) => {
            const tinted = glass[channel]! * (1 - veil) + tint[channel]! * veil;
            return tinted * (1 - sheen) + COVER_CARD_LIGHT[channel]! * sheen;
          });
          peak = Math.max(
            peak,
            paintedLuminance(painted[0]!, painted[1]!, painted[2]!),
          );
        }
      }
      return peak;
    };
    const texts = layout.texts.filter((box) => box.width > 0 && box.height > 0);
    const frost = veiled(average, COVER_CARD_LIGHT, 0.85).map(
      Math.round,
    ) as Channels;
    if (
      texts.length &&
      texts.every(
        (box) =>
          brightest(box, frost, COVER_CARD_FROST) <= COVER_CARD_FROST_LUMINANCE,
      )
    )
      return { tint: rgb(frost), alpha: COVER_CARD_FROST };
    let alpha = COVER_CARD_MIN_VEIL;
    for (const box of texts) {
      if (brightest(box, shade, alpha) <= COVER_CARD_MAX_LUMINANCE) continue;
      let [clear, dark] = [alpha, 1];
      for (let step = 0; step < 12; step++) {
        const middle = (clear + dark) / 2;
        if (brightest(box, shade, middle) > COVER_CARD_MAX_LUMINANCE)
          clear = middle;
        else dark = middle;
      }
      alpha = dark;
    }
    // Rounded up, so the painted tint is never thinner than the solved one.
    return { tint: rgb(shade), alpha: Math.ceil(alpha * 1000) / 1000 };
  } catch {
    return null;
  }
};
