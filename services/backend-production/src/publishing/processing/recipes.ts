import { createHash } from "node:crypto";

import { composeRegion, pixelRegion, rotatedSize } from "./edits.js";

import type { MediaEdit, NormalizedCrop, PixelRegion } from "./edits.js";

/*
 * The one rendition recipe registry and geometry (unified media pipeline,
 * increment 1). Pure: no image library, no I/O. The coordinator plans and
 * validates with it, and the sandboxed renderer renders with it, so both
 * sides compute every output size with the same function.
 *
 * A recipe is `{role, version, digest}`; the digest is the first 16 hex
 * characters of the SHA-256 of the canonical JSON of the role's parameters.
 * Version 1 of thumb, cover, display, full and motion is the pre-task
 * processing profile exactly (existing derivative rows are adopted as v1
 * without re-rendering); `viewer@1` is new. This is the only copy of the
 * parameters and digests: the community store records the identity the
 * processor names and only validates its form, and a unit test pins the
 * literal digests migration 20261004010000 adopts to this registry.
 * Changing a parameter without bumping the version fails the pinned digests.
 */

export const STILL_ROLES = [
  "thumb",
  "cover",
  "display",
  "viewer",
  "full",
] as const;
export type StillRole = (typeof STILL_ROLES)[number];

/** Every rendition role, in the order a job renders them (smallest first). */
export const RENDITION_ROLES = [...STILL_ROLES, "motion"] as const;
export type RenditionRole = (typeof RENDITION_ROLES)[number];

/** Tall or wide frames (long edge > 2.5 × short edge) are long scrolls. */
export const LONG_SCROLL_ASPECT_RATIO = 2.5;

/** Largest output side any still recipe may produce (the WebP format limit). */
export const MAX_OUTPUT_EDGE = 16_383;

/**
 * Still pipeline version 1, shared by every still role: strict bounded decode,
 * source orientation applied once, edit rotation then crop (then the card
 * cover crop) before the resize, ICC-aware conversion to untagged sRGB, every
 * metadata chunk stripped, alpha kept, Lanczos3, rounding to at least one
 * pixel, never upscaled, every byte re-encoded (no source passthrough).
 */
export const STILL_PIPELINE_V1 = {
  version: 1,
  decode: { limitInputPixels: 120_000_000, failOn: "error", pages: 1 },
  orientation: "exif-once",
  order: ["orient", "rotate", "crop", "resize"],
  colour: "icc-to-srgb-untagged",
  metadata: "strip-all",
  alpha: "preserve",
  kernel: "lanczos3",
  rounding: "round-min-1",
  upscale: false,
  passthrough: false,
  maxOutputEdge: MAX_OUTPUT_EDGE,
  encoder: {
    format: "webp",
    effort: 4,
    smartSubsample: false,
    alphaQuality: 100,
  },
} as const;

/** sharp input safety: pixel ceiling, strict decoding, first page only. */
export const STILL_INPUT_LIMITS = STILL_PIPELINE_V1.decode;

/**
 * Version 1 parameters per role. `card` framing applies the cover crop when
 * the reference has one (thumb and cover); `complete` framing never does.
 * `viewer` is skipped (not rendered) when its size equals `display`'s or
 * exceeds `full`'s; a plan that renders `full` also skips it when it would be
 * at least as large as `full` ({@link RENDITION_PLANS}). That plan rule decides
 * only whether a viewer exists, never its bytes, so it is not in the digest.
 */
export const RECIPE_PARAMETERS_V1 = {
  thumb: {
    role: "thumb",
    version: 1,
    pipeline: STILL_PIPELINE_V1,
    framing: "card",
    quality: 80,
    maxLongEdge: 480,
    maxPixels: null,
    longScroll: null,
  },
  cover: {
    role: "cover",
    version: 1,
    pipeline: STILL_PIPELINE_V1,
    framing: "card",
    quality: 86,
    maxLongEdge: 1080,
    maxPixels: null,
    longScroll: null,
  },
  display: {
    role: "display",
    version: 1,
    pipeline: STILL_PIPELINE_V1,
    framing: "complete",
    quality: 86,
    maxLongEdge: 2048,
    maxPixels: null,
    longScroll: {
      aspectRatio: LONG_SCROLL_ASPECT_RATIO,
      maxShortEdge: 1280,
      maxLongEdge: 16_000,
      maxPixels: 20_000_000,
    },
  },
  viewer: {
    role: "viewer",
    version: 1,
    pipeline: STILL_PIPELINE_V1,
    framing: "complete",
    quality: 88,
    maxLongEdge: 4096,
    maxPixels: 16_777_216,
    longScroll: {
      aspectRatio: LONG_SCROLL_ASPECT_RATIO,
      maxShortEdge: 2048,
      maxLongEdge: 16_000,
      maxPixels: 20_000_000,
    },
    skip: { whenEqualTo: "display", whenLargerThan: "full" },
  },
  full: {
    role: "full",
    version: 1,
    pipeline: STILL_PIPELINE_V1,
    framing: "complete",
    quality: 90,
    maxLongEdge: 8192,
    maxPixels: null,
    longScroll: {
      aspectRatio: LONG_SCROLL_ASPECT_RATIO,
      maxShortEdge: null,
      maxLongEdge: 16_000,
      maxPixels: 40_000_000,
    },
  },
  motion: {
    role: "motion",
    version: 1,
    video: {
      codec: "libx264",
      profile: "high",
      preset: "veryfast",
      crf: 21,
      pixelFormat: "yuv420p",
      maxLongEdge: 1920,
      rotation: "baked",
    },
    audio: { codec: "aac", bitrate: "128k", channels: "source" },
    container: { format: "mp4", faststart: true, metadata: "strip-all" },
    colour: {
      outputPrimaries: "bt709",
      outputTransfer: "bt709",
      outputMatrix: "bt709",
      outputRange: "tv",
      untagged: "bt709",
      hdrTransfers: ["arib-std-b67", "smpte2084"],
      toneMapOperator: "hable",
      nominalPeakNits: 100,
    },
  },
} as const;

/** Pinned digests of {@link RECIPE_PARAMETERS_V1}; tests recompute them. */
export const RECIPE_DIGESTS_V1: Readonly<Record<RenditionRole, string>> =
  Object.freeze({
    thumb: "02deba84f648b4c8",
    cover: "6eca59397e187bee",
    display: "fa0cc28bb9865f16",
    viewer: "041a35a85fbbded3",
    full: "acb3027f6e2affec",
    motion: "61403d6585d07f92",
  });

export interface RecipeIdentity {
  readonly role: RenditionRole;
  /** Integer ≥ 1, bumped by hand whenever an output-affecting parameter changes. */
  readonly version: number;
  /** First 16 lowercase hex characters of the parameter digest. */
  readonly digest: string;
}

/** The recipe every new rendition of a role is rendered with. */
export const currentRecipe = (role: RenditionRole): RecipeIdentity => ({
  role,
  version: RECIPE_PARAMETERS_V1[role].version,
  digest: RECIPE_DIGESTS_V1[role],
});

/** True when `identity` names the current recipe of its role exactly. */
export const isCurrentRecipe = (identity: {
  readonly role: string;
  readonly version: number;
  readonly digest: string;
}): boolean =>
  isRenditionRole(identity.role) &&
  identity.version === RECIPE_PARAMETERS_V1[identity.role].version &&
  identity.digest === RECIPE_DIGESTS_V1[identity.role];

/**
 * What a job renders for: an edit of a work item (every role it needs, `full`
 * included) or a Catalog asset (no `full` in increment 1). A plan decides only
 * whether the optional `viewer` is worth rendering (see
 * {@link plannedStillSize}); it changes no rendered byte and no recipe digest.
 */
export const RENDITION_PLANS = {
  work: { full: true },
  catalog: { full: false },
} as const;
export type RenditionPlan = keyof typeof RENDITION_PLANS;

export const isRenditionPlan = (value: unknown): value is RenditionPlan =>
  typeof value === "string" && Object.hasOwn(RENDITION_PLANS, value);

export const isStillRole = (value: unknown): value is StillRole =>
  typeof value === "string" &&
  (STILL_ROLES as readonly string[]).includes(value);

export const isRenditionRole = (value: unknown): value is RenditionRole =>
  typeof value === "string" &&
  (RENDITION_ROLES as readonly string[]).includes(value);

type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

/**
 * Canonical JSON: object keys sorted by code unit at every level, arrays in
 * order, no whitespace, finite numbers only.
 */
export const canonicalRecipeJson = (value: CanonicalValue): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("Recipe parameters must be finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value))
    return `[${value.map((entry: CanonicalValue) => canonicalRecipeJson(entry)).join(",")}]`;
  const record = value as { readonly [key: string]: CanonicalValue };
  return `{${Object.keys(record)
    .sort()
    .map((key) => {
      const entry = record[key];
      if (entry === undefined)
        throw new TypeError("Recipe parameters must not be undefined");
      return `${JSON.stringify(key)}:${canonicalRecipeJson(entry)}`;
    })
    .join(",")}}`;
};

/** The digest of one parameter object (first 16 hex of its SHA-256). */
export const recipeDigest = (parameters: CanonicalValue): string =>
  createHash("sha256")
    .update(canonicalRecipeJson(parameters), "utf8")
    .digest("hex")
    .slice(0, 16);

export interface FrameSize {
  readonly width: number;
  readonly height: number;
}

const assertFrame = (frame: FrameSize) => {
  if (
    !Number.isSafeInteger(frame.width) ||
    !Number.isSafeInteger(frame.height) ||
    frame.width < 1 ||
    frame.height < 1
  )
    throw new TypeError("A rendition frame has positive integer sides");
};

/** `card` roles take the reference's cover crop; `complete` roles never do. */
export const recipeFraming = (role: StillRole): "card" | "complete" =>
  RECIPE_PARAMETERS_V1[role].framing;

/** WebP quality of a still role. */
export const recipeQuality = (role: StillRole): number =>
  RECIPE_PARAMETERS_V1[role].quality;

/**
 * The output size of a still role for a frame, never upscaled. Long scrolls
 * follow the role's short-edge-aware rule instead of the long-edge cap.
 */
export function stillOutputSize(role: StillRole, frame: FrameSize): FrameSize {
  assertFrame(frame);
  const recipe = RECIPE_PARAMETERS_V1[role];
  const { width, height } = frame;
  const longEdge = Math.max(width, height);
  const shortEdge = Math.min(width, height);
  const pixels = width * height;
  const longScroll = longEdge > LONG_SCROLL_ASPECT_RATIO * shortEdge;
  let scale = Math.min(1, recipe.maxLongEdge / longEdge);
  if (recipe.maxPixels !== null) {
    scale = Math.min(scale, Math.sqrt(recipe.maxPixels / pixels));
  }
  if (longScroll && recipe.longScroll !== null) {
    const rule = recipe.longScroll;
    scale = Math.min(
      1,
      ...(rule.maxShortEdge === null ? [] : [rule.maxShortEdge / shortEdge]),
      rule.maxLongEdge / longEdge,
      Math.sqrt(rule.maxPixels / pixels),
    );
  }
  const size = {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
  if (size.width > MAX_OUTPUT_EDGE || size.height > MAX_OUTPUT_EDGE)
    throw new RangeError("A still rendition exceeds the output edge limit");
  return size;
}

/**
 * The size a planned still role is rendered at for `plan`, or `null` when it
 * is not rendered. Every role but `viewer` is always rendered. `viewer` is
 * skipped by its recipe when it would equal `display` or exceed `full` on
 * either side, and by a plan that renders `full` when it would be at least as
 * large as `full` on both sides (the same size, as for any frame of at most
 * 4096 px on its long edge, or a long scroll within the viewer's bounds), so
 * no plan stores one size twice. Long scrolls compare their long-scroll
 * geometry. A plan without `full` keeps every viewer that differs from
 * `display`: it is that plan's largest image.
 */
export function plannedStillSize(
  role: StillRole,
  frame: FrameSize,
  plan: RenditionPlan,
): FrameSize | null {
  const size = stillOutputSize(role, frame);
  if (role !== "viewer") return size;
  const display = stillOutputSize("display", frame);
  const full = stillOutputSize("full", frame);
  if (
    (size.width === display.width && size.height === display.height) ||
    size.width > full.width ||
    size.height > full.height ||
    (RENDITION_PLANS[plan].full &&
      size.width >= full.width &&
      size.height >= full.height)
  )
    return null;
  return size;
}

/**
 * Pixel region of the edited frame of an oriented source; with a cover crop,
 * the cover-cropped part of it. `frame` is the rotated source frame.
 */
export function editRegion(
  source: FrameSize,
  edit: MediaEdit,
  coverCrop: NormalizedCrop | null,
): { frame: FrameSize; region: PixelRegion } {
  assertFrame(source);
  const frame = rotatedSize(source.width, source.height, edit.rotation);
  const edited = pixelRegion(edit.crop, frame.width, frame.height);
  const region = coverCrop
    ? composeRegion(edited, pixelRegion(coverCrop, edited.width, edited.height))
    : edited;
  return { frame, region };
}

/** The region a still role renders from: card roles apply the cover crop. */
export const renditionRegion = (
  role: StillRole,
  source: FrameSize,
  edit: MediaEdit,
  coverCrop: NormalizedCrop | null,
): { frame: FrameSize; region: PixelRegion } =>
  editRegion(source, edit, recipeFraming(role) === "card" ? coverCrop : null);

/**
 * The exact output size of a planned still role for an oriented source, an
 * edit, the reference's cover crop and the job's plan, or `null` when the role
 * is not rendered. The renderer renders with this size and the coordinator
 * requires it.
 */
export const expectedStillSize = (
  role: StillRole,
  source: FrameSize,
  edit: MediaEdit,
  coverCrop: NormalizedCrop | null,
  plan: RenditionPlan,
): FrameSize | null =>
  plannedStillSize(
    role,
    renditionRegion(role, source, edit, coverCrop).region,
    plan,
  );
