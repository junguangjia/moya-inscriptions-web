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
 * without re-rendering); `viewer@1` is new, and so are the four profile image
 * roles (increment 3a). This is the only copy of the parameters and digests:
 * the community store records the identity the processor names and only
 * validates its form, and a unit test pins the literal digests migration
 * 20261004010000 adopts to this registry. Changing a parameter without
 * bumping the version fails the pinned digests.
 */

export const STILL_ROLES = [
  "thumb",
  "cover",
  "display",
  "viewer",
  "full",
] as const;
export type StillRole = (typeof STILL_ROLES)[number];

/**
 * Profile image roles (increment 3a): WebP stills of an avatar or a profile
 * background, rendered only by the `profile` plan. The contracts' public
 * rendition path and the community store name the same roles (a unit test
 * reconciles the three lists; this package does not depend on the contracts).
 */
export const PROFILE_ROLES = [
  "avatar-128",
  "avatar-512",
  "background-960",
  "background-1600",
] as const;
export type ProfileRole = (typeof PROFILE_ROLES)[number];

/**
 * The profile families: each renders all its roles in one job, and its
 * anchor is always rendered (a family is ready when its anchor is).
 */
export const PROFILE_FAMILIES = {
  avatar: { anchor: "avatar-128", roles: ["avatar-128", "avatar-512"] },
  background: {
    anchor: "background-960",
    roles: ["background-960", "background-1600"],
  },
} as const satisfies Record<
  string,
  { readonly anchor: ProfileRole; readonly roles: readonly ProfileRole[] }
>;
export type ProfileFamily = keyof typeof PROFILE_FAMILIES;

/** A role rendered as a WebP still by the sandboxed renderer. */
export type RenderedStillRole = StillRole | ProfileRole;

/**
 * Every rendition role: a work or Catalog job's roles in the order it renders
 * them (smallest first), then the profile roles.
 */
export const RENDITION_ROLES = [
  ...STILL_ROLES,
  "motion",
  ...PROFILE_ROLES,
] as const;
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
 * The larger role of a profile family is skipped when its size equals the
 * anchor's (a source no larger than the anchor's long edge).
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
  "avatar-128": {
    role: "avatar-128",
    version: 1,
    pipeline: STILL_PIPELINE_V1,
    framing: "complete",
    quality: 80,
    maxLongEdge: 128,
    maxPixels: null,
    longScroll: null,
  },
  "avatar-512": {
    role: "avatar-512",
    version: 1,
    pipeline: STILL_PIPELINE_V1,
    framing: "complete",
    quality: 82,
    maxLongEdge: 512,
    maxPixels: null,
    longScroll: null,
    skip: { whenEqualTo: "avatar-128" },
  },
  "background-960": {
    role: "background-960",
    version: 1,
    pipeline: STILL_PIPELINE_V1,
    framing: "complete",
    quality: 82,
    maxLongEdge: 960,
    maxPixels: null,
    longScroll: null,
  },
  "background-1600": {
    role: "background-1600",
    version: 1,
    pipeline: STILL_PIPELINE_V1,
    framing: "complete",
    quality: 84,
    maxLongEdge: 1600,
    maxPixels: null,
    longScroll: null,
    skip: { whenEqualTo: "background-960" },
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
    "avatar-128": "a127cd6992900e4a",
    "avatar-512": "15a60d75ab0b9da9",
    "background-960": "f6e1093c931edcef",
    "background-1600": "fdc0f14fbb0a2677",
  });

/**
 * Catalog blocks (catalog-deep-zoom-v1): one level of JPEG cells cut from a
 * private display master scaled to its frame L (at most 8192 px on the long
 * edge). Block roles are `block-00` … `block-99`, row-major; every block of a
 * set carries the same recipe identity. The edge, overlap and cell bound
 * mirror the public contract's `CATALOG_ZOOM_*` constants, which this package
 * does not import (a unit test reconciles them).
 */
export const BLOCK_RECIPE_V1 = {
  role: "block",
  version: 1,
  decode: STILL_INPUT_LIMITS,
  orientation: "exif-once",
  colour: "icc-to-srgb-untagged",
  metadata: "strip-all",
  alpha: "refuse",
  kernel: "lanczos3",
  frame: { maxLongEdge: 8192, upscale: false },
  grid: { edge: 1024, overlap: 2, maxCells: 100, order: "row-major" },
  encoder: {
    format: "jpeg",
    quality: 85,
    chromaSubsampling: "4:4:4",
    progressive: false,
    optimiseCoding: true,
  },
} as const;

/** Pinned digest of {@link BLOCK_RECIPE_V1}; a test recomputes it. */
export const BLOCK_RECIPE_DIGEST_V1 = "cfd656eff0fbba40";

/**
 * The block job's check that a master is the approved image: the frame,
 * resized to the asset's `display` rendition and both brought to a 512 px
 * long edge, must match it within these bounds (luma PSNR in dB, largest
 * per-channel mean difference in 8-bit levels), else the job fails with
 * `master_mismatch`. The coarse compare ignores the display encoding's fine
 * noise on dense rubbings, yet still refuses a frame shifted by 0.25 % of
 * its size or another image. It decides only whether a set is cut, never a
 * byte of it, so it is not in the digest. Calibrated on 125 local originals
 * (genuine, 0.25 % and 0.5 % shifted, a different image) and 24 real master
 * and approved pairs (catalog-deep-zoom-v1 PR B; the numbers are kept
 * privately): the PSNR bound sits more than 2 dB from either side.
 */
export const BLOCK_ALIGNMENT = {
  reference: "display",
  compareLongEdge: 512,
  minLumaPsnr: 40,
  maxMeanDelta: 2,
} as const;

const BLOCK_ROLE = /^block-([0-9]{2})$/u;

/** `block-NN` of a cell, or the cell of a block role (null for any other role). */
export const blockRole = (cell: number): string =>
  `block-${String(cell).padStart(2, "0")}`;
export const blockCellOf = (role: string): number | null => {
  const match = BLOCK_ROLE.exec(role);
  return match?.[1] === undefined ? null : Number(match[1]);
};

/** Columns, rows and cells of a frame's one level of blocks. */
export const blockGrid = (frameWidth: number, frameHeight: number) => {
  const edge = BLOCK_RECIPE_V1.grid.edge;
  const columns = Math.ceil(frameWidth / edge);
  const rows = Math.ceil(frameHeight / edge);
  return { columns, rows, cells: columns * rows };
};

/** The pixel region of one row-major cell, with the right and bottom overlap. */
export const blockCellRegion = (
  frameWidth: number,
  frameHeight: number,
  cell: number,
): PixelRegion => {
  const { edge, overlap } = BLOCK_RECIPE_V1.grid;
  const { columns, cells } = blockGrid(frameWidth, frameHeight);
  if (!Number.isSafeInteger(cell) || cell < 0 || cell >= cells)
    throw new RangeError("A block cell lies inside its frame's grid");
  const left = (cell % columns) * edge;
  const top = Math.floor(cell / columns) * edge;
  return {
    left,
    top,
    width: Math.min(edge + overlap, frameWidth - left),
    height: Math.min(edge + overlap, frameHeight - top),
  };
};

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
 * included), a Catalog asset (no `full` in increment 1) or a profile image
 * (the profile roles only). A plan names the roles it may ask for and decides
 * only whether the optional `viewer` is worth rendering (see
 * {@link plannedStillSize}); it changes no rendered byte and no recipe digest.
 */
export const RENDITION_PLANS = {
  work: { full: true, roles: "still" },
  catalog: { full: false, roles: "still" },
  profile: { full: false, roles: "profile" },
} as const;
export type RenditionPlan = keyof typeof RENDITION_PLANS;

export const isRenditionPlan = (value: unknown): value is RenditionPlan =>
  typeof value === "string" && Object.hasOwn(RENDITION_PLANS, value);

/** The roles a plan may ask for, in the order a job renders them. */
export const planRoles = (plan: RenditionPlan): readonly RenderedStillRole[] =>
  RENDITION_PLANS[plan].roles === "profile" ? PROFILE_ROLES : STILL_ROLES;

export const isStillRole = (value: unknown): value is StillRole =>
  typeof value === "string" &&
  (STILL_ROLES as readonly string[]).includes(value);

export const isProfileRole = (value: unknown): value is ProfileRole =>
  typeof value === "string" &&
  (PROFILE_ROLES as readonly string[]).includes(value);

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
export const recipeFraming = (role: RenderedStillRole): "card" | "complete" =>
  RECIPE_PARAMETERS_V1[role].framing;

/** WebP quality of a still role. */
export const recipeQuality = (role: RenderedStillRole): number =>
  RECIPE_PARAMETERS_V1[role].quality;

/**
 * The output size of a still role for a frame, never upscaled. Long scrolls
 * follow the role's short-edge-aware rule instead of the long-edge cap.
 */
export function stillOutputSize(
  role: RenderedStillRole,
  frame: FrameSize,
): FrameSize {
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
 * is not rendered. Every role but `viewer` and the larger role of a profile
 * family is always rendered; that profile role is skipped when its size
 * equals its family anchor's. `viewer` is skipped by its recipe when it would
 * equal `display` or exceed `full` on either side, and by a plan that renders
 * `full` when it would be at least as large as `full` on both sides (the same
 * size, as for any frame of at most 4096 px on its long edge, or a long
 * scroll within the viewer's bounds), so no plan stores one size twice. Long
 * scrolls compare their long-scroll geometry. A plan without `full` keeps
 * every viewer that differs from `display`: it is that plan's largest image.
 */
export function plannedStillSize(
  role: RenderedStillRole,
  frame: FrameSize,
  plan: RenditionPlan,
): FrameSize | null {
  const size = stillOutputSize(role, frame);
  if (isProfileRole(role)) {
    const recipe = RECIPE_PARAMETERS_V1[role];
    if (!("skip" in recipe)) return size;
    const anchor = stillOutputSize(recipe.skip.whenEqualTo, frame);
    return size.width === anchor.width && size.height === anchor.height
      ? null
      : size;
  }
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
  role: RenderedStillRole,
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
  role: RenderedStillRole,
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
