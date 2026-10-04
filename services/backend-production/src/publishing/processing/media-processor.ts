import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, open } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { PublishingMediaStoreError } from "../../storage/publishing-media-store.js";
import {
  SANDBOX_PROTOCOL_VERSION,
  SandboxProtocolError,
} from "../sandbox/protocol.js";
import { SANDBOX_JOB_LIMITS, sandboxNonce } from "../sandbox/sandbox-runner.js";
import { openFileByteReader } from "./byte-reader.js";
import { isEditKey, isIdentityEdit, parseCrop, parseEdit } from "./edits.js";
import {
  MediaProcessingInputError,
  MediaProcessingUnavailableError,
  MediaRejectedError,
  systemErrorCode,
} from "./errors.js";
import { MediaToolError } from "./media-tools.js";
import { probeMp4, probeWebp } from "./output-probe.js";
import {
  LEGACY_USER_MEDIA_MAX_BYTES,
  MOTION_DERIVATIVE,
  MOTION_DURATION_TOLERANCE_MS,
  MOTION_INPUT_LIMITS,
  SANDBOX_INPUT_LIMITS,
  SANDBOX_TIMEOUTS_MS,
} from "./profiles.js";
import {
  STILL_ROLES,
  currentRecipe,
  expectedStillSize,
  isStillRole,
  recipeFraming,
} from "./recipes.js";
import { declaredTypeMatches } from "./signature.js";

import type {
  PublishingMediaStoreContentType,
  PublishingMediaStoreRead,
} from "../../storage/publishing-media-store.js";
import type {
  SandboxInput,
  SandboxItemRequest,
  SandboxJob,
  SandboxManifest,
  SandboxOutput,
  SandboxRenditionRequest,
} from "../sandbox/protocol.js";
import type {
  SandboxJobDirectory,
  SandboxRunResult,
  SandboxRunner,
} from "../sandbox/sandbox-runner.js";
import type { MediaEdit, NormalizedCrop } from "./edits.js";
import type { MediaFailureCode } from "./errors.js";
import type { StillRole } from "./recipes.js";

/*
 * The media processing coordinator (unified media pipeline, increment 1).
 * It never parses or decodes untrusted bytes: it stages the item's verified
 * components into a sandbox job, runs the sandboxed renderer once, validates
 * every output it received (manifest, names, exact dimensions recomputed with
 * the recipe registry, sizes, hashes, WebP/MP4 headers) and only then writes
 * the outputs to the media store and hands the outcome to the caller for
 * recording. It never imports sharp.
 */

export type ProcessorMode = "process" | "derive";
export type ProcessorComponentRole = "still" | "motion" | "package";
export type ProcessorVariant =
  "thumb" | "display" | "full" | "motion" | "cover";
/** A recorded rendition role: the variants plus the optional `viewer`. */
export type ProcessorRenditionRole = ProcessorVariant | "viewer";
export type ProcessorPairingMethod =
  "apple-content-identifier" | "motion-photo-container" | "none";

/**
 * A legacy item's source: the user media PNG of an earlier work (structural
 * mirror of the port's `legacy_user_media` processing source).
 */
export interface ProcessorLegacySource {
  readonly kind: "legacy_user_media";
  readonly legacyMediaId: string;
  readonly byteSize: number;
  readonly contentType: "image/png";
}

/** Where an item's source bytes live; uploaded items name no source or `upload`. */
export type ProcessorSource =
  { readonly kind: "upload" } | ProcessorLegacySource;

/** Structural mirror of `PublishingProcessInput` (`@moya/api`). */
export interface ProcessorInput {
  readonly mode: ProcessorMode;
  readonly itemId: string;
  readonly ownerId: string;
  readonly kind: "static" | "live";
  /** Legacy (`legacy_user_media`) edits arrive as `standard`. */
  readonly qualityMode: "standard" | "original";
  /**
   * Uploaded items (no source, or `upload`) read `components` from the media
   * store. A `legacy_user_media` source is valid only for mode `derive` of a
   * static item without components: its still is `legacyStill`.
   */
  readonly source?: ProcessorSource | null;
  /**
   * The legacy PNG, exactly `source.byteSize` bytes, which the worker read
   * from user media for this job only. It is written into the job input and
   * never into the media store or back to user media.
   */
  readonly legacyStill?: Uint8Array;
  readonly components: readonly {
    readonly role: ProcessorComponentRole;
    readonly storageKey: string;
    readonly byteSize: number;
    readonly sha256: string;
    readonly declaredType: PublishingMediaStoreContentType;
  }[];
  readonly clientPairing: {
    readonly method: ProcessorPairingMethod;
    readonly identifierSha256: string | null;
    readonly stillTimeMs?: number;
  } | null;
  /** Opaque upstream key; `base` only for the identity edit. */
  readonly editKey: string;
  readonly edit: MediaEdit;
  readonly coverCrop: NormalizedCrop | null;
  readonly variants: readonly ProcessorVariant[];
  readonly signal?: AbortSignal;
}

export interface ProcessorDerivative {
  readonly variant: ProcessorRenditionRole;
  readonly editKey: string;
  readonly storageKey: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly contentType: "image/webp" | "video/mp4";
  readonly width: number;
  readonly height: number;
  readonly durationMs: number | null;
  /** The recipe the bytes were rendered with. */
  readonly recipeVersion: number;
  readonly recipeDigest: string;
}

export interface ProcessorPairing {
  readonly method: ProcessorPairingMethod;
  readonly verifiedBy: "server" | "client";
  readonly identifierSha256: string | null;
  readonly stillTimeMs?: number;
}

/** Structural mirror of `PublishingProcessOutcome` (`@moya/api`). */
export type ProcessorOutcome =
  | {
      readonly status: "processed";
      readonly detectedTypes: readonly {
        readonly role: ProcessorComponentRole;
        readonly contentType: PublishingMediaStoreContentType;
      }[];
      readonly presentation: {
        readonly width: number;
        readonly height: number;
        readonly durationMs?: number;
        readonly hasAudio?: boolean;
        readonly displayRotation?: 0 | 90 | 180 | 270;
      };
      readonly pairing: ProcessorPairing | null;
      readonly stillExifOrientation: number | null;
      readonly derivatives: readonly ProcessorDerivative[];
      /** Mean colour of the base `thumb`; `null` when not opaque. */
      readonly placeholderColor: string | null;
    }
  | {
      readonly status: "derived";
      readonly derivatives: readonly ProcessorDerivative[];
      /** Only for an edit of key `base` (its `thumb` was rendered). */
      readonly placeholderColor?: string | null;
    }
  | { readonly status: "rejected"; readonly failureCode: MediaFailureCode };

/** The media store operations the coordinator needs. */
export interface ProcessorMediaStore {
  openRead(storageKey: string): Promise<PublishingMediaStoreRead | null>;
  writeStream(
    ownerId: string,
    purpose: "derivative",
    contentType: "image/webp" | "video/mp4",
    maxBytes: number,
    source: AsyncIterable<Uint8Array>,
    options?: {
      readonly signal?: AbortSignal;
      readonly requireExactSize?: boolean;
    },
  ): Promise<{ storageKey: string; byteSize: number; sha256: string }>;
  remove(storageKey: string): Promise<void>;
}

/** Content-free log sink of the coordinator. */
export interface ProcessorLogger {
  error(message: string): void;
}

export interface PublishingMediaProcessorOptions {
  readonly store: ProcessorMediaStore;
  readonly sandbox: Pick<SandboxRunner, "createJob" | "run">;
  readonly logger?: ProcessorLogger;
}

type Component = ProcessorInput["components"][number];

const ITEM_ID_PATTERN = /^media-item-[0-9a-f]{32}$/;
const LEGACY_MEDIA_ID_PATTERN = /^user-media-[0-9a-f]{32}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_STILL_TIME_MS = 60_000;
const VARIANTS = new Set<string>([
  "thumb",
  "display",
  "full",
  "motion",
  "cover",
]);
const PAIRING_METHODS = new Set<string>([
  "apple-content-identifier",
  "motion-photo-container",
  "none",
]);

const withSignal = (signal: AbortSignal | undefined) =>
  signal ? { signal } : {};

const invalidClientPairing = (pairing: ProcessorInput["clientPairing"]) =>
  pairing !== null &&
  (typeof pairing !== "object" ||
    !PAIRING_METHODS.has(pairing.method) ||
    (pairing.method === "apple-content-identifier") !==
      (typeof pairing.identifierSha256 === "string" &&
        SHA256_PATTERN.test(pairing.identifierSha256)) ||
    (pairing.method !== "apple-content-identifier" &&
      pairing.identifierSha256 !== null) ||
    (pairing.stillTimeMs !== undefined &&
      (pairing.method === "none" ||
        !Number.isSafeInteger(pairing.stillTimeMs) ||
        pairing.stillTimeMs < 0 ||
        pairing.stillTimeMs > MAX_STILL_TIME_MS)));

/** The legacy source of a well-formed legacy input; `null` for uploads. */
const legacySourceOf = (
  input: ProcessorInput,
): ProcessorLegacySource | null => {
  const source = input.source;
  if (source === undefined || source === null || source.kind === "upload") {
    if (input.legacyStill !== undefined) throw new MediaProcessingInputError();
    return null;
  }
  const still = input.legacyStill;
  if (
    source.kind !== "legacy_user_media" ||
    typeof source.legacyMediaId !== "string" ||
    !LEGACY_MEDIA_ID_PATTERN.test(source.legacyMediaId) ||
    source.contentType !== "image/png" ||
    !Number.isSafeInteger(source.byteSize) ||
    source.byteSize < 1 ||
    source.byteSize > LEGACY_USER_MEDIA_MAX_BYTES ||
    !(still instanceof Uint8Array) ||
    still.byteLength !== source.byteSize ||
    input.mode !== "derive" ||
    input.kind !== "static" ||
    !Array.isArray(input.components) ||
    input.components.length !== 0
  ) {
    throw new MediaProcessingInputError();
  }
  return source;
};

const assertInput = (input: ProcessorInput) => {
  const roles = input.components.map((component) => component.role);
  if (
    (input.mode !== "process" && input.mode !== "derive") ||
    !ITEM_ID_PATTERN.test(input.itemId) ||
    typeof input.ownerId !== "string" ||
    (input.kind !== "static" && input.kind !== "live") ||
    (input.qualityMode !== "standard" && input.qualityMode !== "original") ||
    !Array.isArray(input.components) ||
    new Set(roles).size !== roles.length ||
    input.components.some(
      (component) =>
        !SHA256_PATTERN.test(component.sha256) ||
        !Number.isSafeInteger(component.byteSize) ||
        component.byteSize < 1,
    ) ||
    invalidClientPairing(input.clientPairing) ||
    !isEditKey(input.editKey) ||
    !Array.isArray(input.variants) ||
    input.variants.length === 0 ||
    new Set(input.variants).size !== input.variants.length ||
    input.variants.some((variant) => !VARIANTS.has(variant)) ||
    (input.kind === "static" && input.variants.includes("motion"))
  ) {
    throw new MediaProcessingInputError();
  }
};

/** Resolves the component layout for the item kind (registration enforces it). */
const componentLayout = (input: ProcessorInput) => {
  const byRole = new Map(input.components.map((c) => [c.role, c]));
  const roles = [...byRole.keys()].sort().join(",");
  if (input.kind === "static" && roles === "still") {
    return { still: byRole.get("still")!, motion: null, pack: null };
  }
  if (input.kind === "live" && roles === "motion,still") {
    return {
      still: byRole.get("still")!,
      motion: byRole.get("motion")!,
      pack: null,
    };
  }
  if (input.kind === "live" && roles === "package") {
    return { still: null, motion: null, pack: byRole.get("package")! };
  }
  throw new MediaProcessingInputError();
};

/**
 * The still renditions a job asks for: the requested still variants, plus the
 * optional bounded `viewer` whenever the job renders the complete framing of
 * its edit (it asks for `display`). The renderer skips the viewer where its
 * recipe or the job's plan says so (`plannedStillSize`): a work item's viewer
 * exists only when it is smaller than its `full`.
 */
export const plannedStillRequests = (
  roles: readonly StillRole[],
): SandboxRenditionRequest[] => {
  const planned = new Set<StillRole>(roles);
  if (planned.has("display")) planned.add("viewer");
  return STILL_ROLES.filter((role) => planned.has(role)).map((role) => {
    const recipe = currentRecipe(role);
    return { role, version: recipe.version, digest: recipe.digest };
  });
};

async function materialize(
  store: ProcessorMediaStore,
  job: SandboxJobDirectory,
  component: Component,
  signal: AbortSignal | undefined,
) {
  const read = await store.openRead(component.storageKey);
  if (read?.status !== "ok") throw new MediaProcessingUnavailableError(null);
  if (read.byteSize !== component.byteSize) {
    await read.close();
    throw new MediaProcessingUnavailableError(null);
  }
  const target = job.inputPath(component.role);
  const handle = await open(target, "wx", 0o644);
  const hash = createHash("sha256");
  try {
    await pipeline(
      read.body,
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          hash.update(chunk);
          callback(null, chunk);
        },
      }),
      handle.createWriteStream(),
      withSignal(signal),
    );
  } finally {
    await read.close();
    await handle.close().catch(() => undefined);
  }
  await chmod(target, 0o644);
  if (hash.digest("hex") !== component.sha256) {
    throw new MediaProcessingUnavailableError(null);
  }
}

/** Writes the worker-read legacy PNG as the job's still input (never a link). */
async function writeLegacyStill(
  job: SandboxJobDirectory,
  bytes: Uint8Array,
  signal: AbortSignal | undefined,
) {
  if (signal?.aborted) throw new MediaToolError("aborted");
  const target = job.inputPath("still");
  const handle = await open(target, "wx", 0o644);
  try {
    await handle.writeFile(bytes, withSignal(signal));
  } finally {
    await handle.close().catch(() => undefined);
  }
  await chmod(target, 0o644);
}

const violation = (
  code: ConstructorParameters<typeof SandboxProtocolError>[0],
) => new SandboxProtocolError(code);

/**
 * Validates a manifest against the job that produced it: the status of the
 * operation, exactly the planned outputs with exactly the sizes the recipe
 * registry computes for the decoded still, motion bounds, and facts
 * consistent with the staged components. Throws `SandboxProtocolError`.
 */
export function validateSandboxManifest(
  manifest: SandboxManifest,
  request: SandboxJob,
): void {
  const item = request.item;
  if (item === null) throw violation("status_mismatch");
  const processing = request.operation === "process";
  if (manifest.status !== (processing ? "processed" : "derived")) {
    throw violation("status_mismatch");
  }
  const inspection = manifest.inspection;
  const stillsDecoded = processing || item.renditions.length > 0;
  if (stillsDecoded !== (inspection !== null)) {
    throw violation("status_mismatch");
  }
  if (
    inspection !== null &&
    inspection.width * inspection.height > request.limits.maxPixels
  ) {
    throw violation("dimensions_mismatch");
  }
  const expected = new Map<
    string,
    { readonly role: StillRole | "motion"; width?: number; height?: number }
  >();
  for (const rendition of item.renditions) {
    const size = expectedStillSize(
      rendition.role,
      inspection!,
      item.edit,
      item.coverCrop,
      item.plan,
    );
    if (size !== null) {
      expected.set(`${rendition.role}.webp`, { role: rendition.role, ...size });
    }
  }
  if (item.motion) expected.set("motion.mp4", { role: "motion" });
  if (
    manifest.outputs.length !== expected.size ||
    manifest.outputs.some(
      (output) => expected.get(output.name)?.role !== output.role,
    )
  ) {
    throw violation("outputs_mismatch");
  }
  for (const output of manifest.outputs) {
    const want = expected.get(output.name)!;
    if (want.role === "motion") {
      if (
        Math.max(output.width, output.height) > MOTION_DERIVATIVE.maxLongEdge ||
        output.width % 2 !== 0 ||
        output.height % 2 !== 0 ||
        output.durationMs === null ||
        output.durationMs >
          MOTION_INPUT_LIMITS.maxDurationMs + MOTION_DURATION_TOLERANCE_MS
      ) {
        throw violation("dimensions_mismatch");
      }
    } else if (output.width !== want.width || output.height !== want.height) {
      throw violation("dimensions_mismatch");
    }
  }
  if (
    manifest.placeholderColor !== null &&
    !(item.placeholder && expected.has("thumb.webp"))
  ) {
    throw violation("status_mismatch");
  }
  if (!processing) {
    if (
      manifest.detectedTypes !== null ||
      manifest.pairing !== null ||
      manifest.presentation !== null ||
      manifest.stillExifOrientation !== null
    ) {
      throw violation("status_mismatch");
    }
    return;
  }
  const declared = new Map(
    item.inputs.map((input) => [input.role, input.declaredType]),
  );
  const detected = manifest.detectedTypes ?? [];
  const presentation = manifest.presentation;
  const live = item.kind === "live";
  if (
    detected.length !== declared.size ||
    detected.some((entry) => {
      const declaredType = declared.get(entry.role);
      return (
        declaredType === undefined ||
        !declaredTypeMatches(declaredType, entry.contentType) ||
        (entry.role !== "motion" && !entry.contentType.startsWith("image/")) ||
        (entry.role === "motion" && !entry.contentType.startsWith("video/"))
      );
    }) ||
    presentation === null ||
    presentation.width !== inspection!.width ||
    presentation.height !== inspection!.height ||
    live !== (manifest.pairing !== null) ||
    live !== (presentation.durationMs !== undefined) ||
    live !== (presentation.hasAudio !== undefined) ||
    live !== (presentation.displayRotation !== undefined) ||
    (presentation.durationMs !== undefined &&
      presentation.durationMs > MOTION_INPUT_LIMITS.maxDurationMs)
  ) {
    throw violation("status_mismatch");
  }
}

/**
 * Header-probes every received output against its manifest entry: a WebP
 * still of exactly its size without metadata chunks, or an MP4 file.
 */
export async function probeSandboxOutputs(result: SandboxRunResult) {
  for (const output of result.manifest.outputs) {
    const file = result.files.get(output.name);
    if (file === undefined || file.bytes !== output.bytes) {
      throw violation("stream_incomplete");
    }
    const reader = await openFileByteReader(file.path);
    try {
      if (reader.size !== output.bytes) throw violation("output_invalid");
      if (output.contentType === "image/webp") {
        const probe = await probeWebp(reader);
        if (
          probe === null ||
          probe.width !== output.width ||
          probe.height !== output.height
        ) {
          throw violation("output_invalid");
        }
      } else if (!(await probeMp4(reader))) {
        throw violation("output_invalid");
      }
    } catch (error) {
      if (error instanceof SandboxProtocolError) throw error;
      throw violation("output_invalid");
    } finally {
      await reader.close();
    }
  }
}

/** Streams a received output file into the media store (exact size). */
export async function storeOutputFile(
  write: (
    body: AsyncIterable<Uint8Array>,
  ) => Promise<{ storageKey: string; byteSize: number; sha256: string }>,
  filePath: string,
  byteSize: number,
) {
  const handle = await open(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let body: ReturnType<typeof handle.createReadStream> | undefined;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size !== byteSize) {
      throw violation("output_invalid");
    }
    body = handle.createReadStream();
    return await write(body);
  } finally {
    // A stream keeps its FileHandle referenced until it is destroyed.
    body?.destroy();
    await handle.close().catch(() => undefined);
  }
}

/** The recipe identity of a received output. */
export const outputRecipe = (output: SandboxOutput) =>
  currentRecipe(isStillRole(output.role) ? output.role : "motion");

/** Content-free log line for a sandbox failure the coordinator rejects. */
export const logSandboxFailure = (
  logger: ProcessorLogger,
  error: SandboxProtocolError,
) => {
  logger.error(
    error.violation === "resource_exceeded"
      ? "[media-sandbox] sandbox_resource_exceeded"
      : `[media-sandbox] sandbox_protocol_violation code=${error.violation}`,
  );
};

/**
 * Maps a failure to a rejection or rethrows it as a retryable, content-free
 * error. Mode `derive` retries timeouts instead of rejecting.
 */
function settleFailure(
  error: unknown,
  input: ProcessorInput,
  logger: ProcessorLogger,
): Extract<ProcessorOutcome, { status: "rejected" }> {
  if (input.signal?.aborted) throw new MediaToolError("aborted");
  let failureCode: MediaFailureCode | null = null;
  if (error instanceof MediaRejectedError) failureCode = error.failureCode;
  else if (error instanceof SandboxProtocolError) {
    logSandboxFailure(logger, error);
    failureCode = "processing_failed";
  } else if (error instanceof MediaToolError && error.code === "timeout") {
    failureCode = "processing_timeout";
  }
  if (failureCode === "processing_timeout" && input.mode === "derive") {
    throw new MediaToolError("timeout");
  }
  if (failureCode !== null) return { status: "rejected", failureCode };
  if (
    error instanceof MediaToolError ||
    error instanceof PublishingMediaStoreError ||
    error instanceof MediaProcessingInputError ||
    error instanceof MediaProcessingUnavailableError
  ) {
    throw error;
  }
  throw new MediaProcessingUnavailableError(systemErrorCode(error));
}

async function processItem(
  { store, sandbox, logger = console }: PublishingMediaProcessorOptions,
  input: ProcessorInput,
): Promise<ProcessorOutcome> {
  const legacy = legacySourceOf(input);
  assertInput(input);
  // A legacy still has no stored components; its bytes come with the input.
  const layout = legacy
    ? { still: null, motion: null, pack: null }
    : componentLayout(input);
  const edit = parseEdit(input.edit);
  const coverCrop = parseCrop(input.coverCrop);
  const stillRoles = input.variants.filter(
    (variant): variant is Exclude<ProcessorVariant, "motion"> =>
      variant !== "motion",
  );
  const usesCoverCrop = stillRoles.some(
    (role) => recipeFraming(role) === "card",
  );
  if (
    input.editKey === "base" &&
    (!isIdentityEdit(edit) || (coverCrop !== null && usesCoverCrop))
  ) {
    throw new MediaProcessingInputError();
  }
  const signal = input.signal;
  const processing = input.mode === "process";
  const live = input.kind === "live";
  const needStill = processing || stillRoles.length > 0;
  const needMotion = live && (processing || input.variants.includes("motion"));
  const renditions = plannedStillRequests(stillRoles);
  const placeholder =
    input.editKey === "base" && renditions.some((r) => r.role === "thumb");
  const written: string[] = [];
  let job: SandboxJobDirectory | undefined;
  try {
    const staged: Component[] = legacy
      ? []
      : layout.pack
        ? [layout.pack]
        : [
            ...(needStill ? [layout.still!] : []),
            ...(needMotion ? [layout.motion!] : []),
          ];
    const stagedBytes =
      (legacy?.byteSize ?? 0) +
      staged.reduce((total, component) => total + component.byteSize, 0);
    if (stagedBytes > SANDBOX_INPUT_LIMITS.maxInputBytes) {
      throw new MediaRejectedError("dimensions_exceeded");
    }
    job = await sandbox.createJob();
    const inputs: SandboxInput[] = [];
    if (legacy) {
      await writeLegacyStill(job, input.legacyStill!, signal);
      inputs.push({
        role: "still",
        declaredType: legacy.contentType,
        byteSize: legacy.byteSize,
        sha256: createHash("sha256").update(input.legacyStill!).digest("hex"),
      });
    }
    for (const component of staged) {
      await materialize(store, job, component, signal);
      inputs.push({
        role: component.role,
        declaredType: component.declaredType,
        byteSize: component.byteSize,
        sha256: component.sha256,
      });
    }
    const item: SandboxItemRequest = {
      kind: input.kind,
      qualityMode: input.qualityMode,
      inputs,
      clientPairing: input.clientPairing,
      edit,
      coverCrop,
      // Every item edit has its `full` (readiness requires it).
      plan: "work",
      renditions,
      motion: input.variants.includes("motion"),
      placeholder,
    };
    const request: SandboxJob = {
      protocol: SANDBOX_PROTOCOL_VERSION,
      nonce: sandboxNonce(),
      operation: input.mode,
      item,
      limits: SANDBOX_JOB_LIMITS,
    };
    const result = await sandbox.run(job, request, {
      timeoutMs: live ? SANDBOX_TIMEOUTS_MS.live : SANDBOX_TIMEOUTS_MS.static,
      ...withSignal(signal),
    });
    const manifest = result.manifest;
    if (manifest.status === "rejected") {
      throw new MediaRejectedError(manifest.failureCode!);
    }
    validateSandboxManifest(manifest, request);
    await probeSandboxOutputs(result);

    const derivatives: ProcessorDerivative[] = [];
    for (const output of manifest.outputs) {
      const file = result.files.get(output.name)!;
      const stored = await storeOutputFile(
        (body) =>
          store.writeStream(
            input.ownerId,
            "derivative",
            output.contentType,
            output.bytes,
            body,
            { requireExactSize: true, ...withSignal(signal) },
          ),
        file.path,
        output.bytes,
      );
      written.push(stored.storageKey);
      if (stored.sha256 !== output.sha256) throw violation("hash_mismatch");
      const recipe = outputRecipe(output);
      derivatives.push({
        ...stored,
        variant: output.role,
        editKey: input.editKey,
        contentType: output.contentType,
        width: output.width,
        height: output.height,
        durationMs: output.durationMs,
        recipeVersion: recipe.version,
        recipeDigest: recipe.digest,
      });
    }
    if (!processing) {
      return {
        status: "derived",
        derivatives,
        ...(placeholder ? { placeholderColor: manifest.placeholderColor } : {}),
      };
    }
    return {
      status: "processed",
      detectedTypes: manifest.detectedTypes!,
      presentation: manifest.presentation!,
      pairing: manifest.pairing,
      stillExifOrientation: manifest.stillExifOrientation,
      derivatives,
      placeholderColor: manifest.placeholderColor,
    };
  } catch (caught) {
    await Promise.all(
      written.map((key) => store.remove(key).catch(() => undefined)),
    );
    return settleFailure(caught, input, logger);
  } finally {
    await job?.dispose().catch(() => undefined);
  }
}

/**
 * Validates received components (signatures, containers, pairing, decode)
 * in the media sandbox and commits the requested renditions to the media
 * store. Implements `PublishingMediaProcessorPort` structurally.
 */
export function createPublishingMediaProcessor(
  options: PublishingMediaProcessorOptions,
): { process(input: ProcessorInput): Promise<ProcessorOutcome> } {
  return { process: (input) => processItem(options, input) };
}
