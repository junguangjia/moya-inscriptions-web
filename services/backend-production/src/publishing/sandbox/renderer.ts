import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import {
  contentIdentifierSha256,
  readExifContentIdentifier,
  readHeifExifTiff,
  readQuickTimeContentIdentifier,
} from "../processing/apple-live-photo.js";
import { openFileByteReader } from "../processing/byte-reader.js";
import { MediaParseError, MediaRejectedError } from "../processing/errors.js";
import {
  ISOBMFF_LIMITS,
  readTopLevelBox,
  readTopLevelBoxes,
  readVideoTrackRotation,
} from "../processing/isobmff.js";
import { readJpegExifTiff } from "../processing/jpeg.js";
import {
  probeMotionInput,
  renderMotionDerivative,
} from "../processing/live-processor.js";
import { MediaToolError, heifDecodeToPng } from "../processing/media-tools.js";
import {
  locateMotionPhotoVideo,
  readHeifXmpPackets,
  readJpegXmpPackets,
  readMotionPhotoDirectory,
} from "../processing/motion-photo.js";
import { METADATA_HEAD_BYTES } from "../processing/profiles.js";
import { STILL_ROLES, expectedStillSize } from "../processing/recipes.js";
import {
  SIGNATURE_HEAD_BYTES,
  countGifFrames,
  declaredTypeMatches,
  pngHasAnimationControl,
  sniffSignature,
} from "../processing/signature.js";
import {
  inspectStaticSource,
  placeholderColour,
  renderStaticDerivative,
} from "../processing/static-processor.js";
import { readExifSummary } from "../processing/tiff-exif.js";
import {
  SANDBOX_PROTOCOL_VERSION,
  encodeEndFrame,
  encodeFrameHeader,
} from "./protocol.js";

import type { ByteReader } from "../processing/byte-reader.js";
import type { MediaFailureCode } from "../processing/errors.js";
import type { MotionProbe } from "../processing/live-processor.js";
import type { MediaToolRunner } from "../processing/media-tools.js";
import type { SniffedMediaType } from "../processing/signature.js";
import type {
  StaticInspection,
  StaticSource,
} from "../processing/static-processor.js";
import type {
  SandboxBoundsFacts,
  SandboxDeclaredType,
  SandboxInputRole,
  SandboxIsolationFacts,
  SandboxItemRequest,
  SandboxJob,
  SandboxManifest,
  SandboxOutput,
  SandboxPairing,
  SandboxPairingMethod,
  SandboxRuntime,
} from "./protocol.js";

/*
 * The sandboxed renderer: every byte of an untrusted upload or Catalog
 * source is parsed and decoded here, inside the one no-network container of
 * a job. Container and metadata parsing, pairing, heif-dec, ffprobe, FFmpeg,
 * sharp inspection and rendering and the placeholder colour all run in this
 * module; it writes outputs only below the paths it is given. Paths are
 * parameters so tests can run it in-process outside Docker.
 */

export interface SandboxRendererPaths {
  /** Staged, read-only job input (`/job/in`). */
  readonly input: string;
  /** Writable scratch (`/job/work`). */
  readonly work: string;
  /** Writable outputs (`/job/out`). */
  readonly output: string;
}

/** The manifest of one rendered job, before the runtime and nonce are added. */
export type SandboxRenderBody = Omit<
  SandboxManifest,
  "protocol" | "nonce" | "runtime" | "selfCheck"
>;

const STILL_TYPES = new Set<SniffedMediaType>([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);
const GIF_SCAN_BYTES = 16 * 1024 * 1024;
const FILE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}(?:\.[a-z0-9]{1,8})?$/;

/** Resolves job file names: staged inputs, else the work directory. */
const workspace = (
  paths: SandboxRendererPaths,
  staged: ReadonlySet<string>,
) => ({
  work: paths.work,
  path(name: string): string {
    if (!FILE_NAME_PATTERN.test(name))
      throw new Error("Invalid media sandbox file name");
    return path.join(staged.has(name) ? paths.input : paths.work, name);
  },
});
type Workspace = ReturnType<typeof workspace>;

const readHead = (reader: ByteReader, bytes: number) =>
  reader.read(0, Math.min(bytes, reader.size));

async function copyRange(
  sourcePath: string,
  start: number,
  length: number,
  targetPath: string,
) {
  const handle = await open(targetPath, "wx", 0o600);
  try {
    await pipeline(
      createReadStream(sourcePath, { start, end: start + length - 1 }),
      handle.createWriteStream(),
    );
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Splits a Motion Photo package into the `still` and/or `motion` work files.
 * A package without a Motion Photo directory is unsupported; an inconsistent
 * directory fails decoding.
 */
async function splitMotionPhoto(
  files: Workspace,
  declaredType: string,
  needs: { readonly still: boolean; readonly motion: boolean },
): Promise<"image/jpeg" | "image/heic" | "image/heif"> {
  const packagePath = files.path("package");
  const reader = await openFileByteReader(packagePath);
  try {
    const signature = sniffSignature(
      await readHead(reader, SIGNATURE_HEAD_BYTES),
    );
    if (
      (signature.type !== "image/jpeg" &&
        signature.type !== "image/heic" &&
        signature.type !== "image/heif") ||
      !declaredTypeMatches(declaredType, signature.type)
    ) {
      throw new MediaRejectedError("unsupported_type");
    }
    const packets =
      signature.type === "image/jpeg"
        ? readJpegXmpPackets(await readHead(reader, METADATA_HEAD_BYTES))
        : await readHeifXmpPackets(reader);
    const directory =
      packets.map(readMotionPhotoDirectory).find((items) => items !== null) ??
      null;
    if (!directory) throw new MediaRejectedError("unsupported_type");
    const layout = await locateMotionPhotoVideo(
      reader,
      signature.type,
      directory,
    );
    if (needs.still) {
      await copyRange(
        packagePath,
        0,
        layout.primaryLength,
        files.path("still"),
      );
    }
    if (needs.motion) {
      await copyRange(
        packagePath,
        layout.videoStart,
        layout.videoLength,
        files.path("motion"),
      );
    }
    return signature.type;
  } finally {
    await reader.close();
  }
}

interface StillContainer {
  readonly detectedType: SandboxDeclaredType;
  readonly contentIdentifier: string | null;
  /** EXIF Orientation from a HEIF Exif item (other formats use the decoder). */
  readonly heifExifOrientation: number | null;
}

const parsedOrNull = async <T>(read: () => Promise<T | null>) => {
  try {
    return await read();
  } catch (error) {
    if (error instanceof MediaParseError) return null;
    throw error;
  }
};

/** Container checks and metadata reads of the still; no tool runs. */
async function inspectStillContainer(
  stillPath: string,
  declaredType: string,
  facts: { readonly identifier: boolean; readonly orientation: boolean },
): Promise<StillContainer> {
  const reader = await openFileByteReader(stillPath);
  try {
    const signature = sniffSignature(
      await readHead(reader, SIGNATURE_HEAD_BYTES),
    );
    if (signature.type === "image/gif") {
      let frames = 1;
      try {
        frames = countGifFrames(await readHead(reader, GIF_SCAN_BYTES));
      } catch {
        // Malformed or oversized GIFs are unsupported either way.
      }
      throw new MediaRejectedError(
        frames > 1 ? "animated_image_unsupported" : "unsupported_type",
      );
    }
    if (!STILL_TYPES.has(signature.type)) {
      throw new MediaRejectedError("unsupported_type");
    }
    if (signature.animated) {
      throw new MediaRejectedError("animated_image_unsupported");
    }
    if (!declaredTypeMatches(declaredType, signature.type)) {
      throw new MediaRejectedError("unsupported_type");
    }
    const detectedType = signature.type as SandboxDeclaredType;
    const heif = detectedType === "image/heic" || detectedType === "image/heif";
    if (
      detectedType === "image/png" &&
      (await pngHasAnimationControl(reader))
    ) {
      throw new MediaRejectedError("animated_image_unsupported");
    }
    if (
      heif &&
      (await readTopLevelBoxes(reader)).some((b) => b.type === "moov")
    ) {
      throw new MediaRejectedError("animated_image_unsupported");
    }
    let tiff: Uint8Array | null = null;
    if (facts.identifier && detectedType === "image/jpeg") {
      const head = await readHead(reader, METADATA_HEAD_BYTES);
      tiff = await parsedOrNull(async () => readJpegExifTiff(head));
    } else if (heif && (facts.identifier || facts.orientation)) {
      tiff = await parsedOrNull(() => readHeifExifTiff(reader));
    }
    const exif = tiff;
    return {
      detectedType,
      contentIdentifier:
        facts.identifier && exif
          ? await parsedOrNull(async () => readExifContentIdentifier(exif))
          : null,
      heifExifOrientation:
        facts.orientation && heif && exif
          ? await parsedOrNull(async () => readExifSummary(exif).orientation)
          : null,
    };
  } finally {
    await reader.close();
  }
}

interface MotionContainer {
  readonly detectedType: SandboxDeclaredType;
  readonly contentIdentifier: string | null;
  readonly trackRotation: number | null;
}

/** Container checks and metadata reads of the motion; no tool runs. */
async function inspectMotionContainer(
  motionPath: string,
  declaredType: string,
  readIdentifier: boolean,
): Promise<MotionContainer> {
  const reader = await openFileByteReader(motionPath);
  try {
    const signature = sniffSignature(
      await readHead(reader, SIGNATURE_HEAD_BYTES),
    );
    if (
      (signature.type !== "video/quicktime" &&
        signature.type !== "video/mp4") ||
      !declaredTypeMatches(declaredType, signature.type)
    ) {
      throw new MediaRejectedError("unsupported_type");
    }
    const moov = await readTopLevelBox(
      reader,
      "moov",
      ISOBMFF_LIMITS.maxMovieBoxBytes,
    );
    if (!moov) throw new MediaRejectedError("decode_failed");
    return {
      detectedType: signature.type,
      trackRotation: readVideoTrackRotation(moov.bytes),
      contentIdentifier: readIdentifier
        ? await parsedOrNull(async () =>
            readQuickTimeContentIdentifier(moov.bytes),
          )
        : null,
    };
  } finally {
    await reader.close();
  }
}

interface DecodedStill {
  readonly source: StaticSource;
  readonly inspection: StaticInspection;
}

async function decodeStill(
  tools: MediaToolRunner,
  files: Workspace,
  container: StillContainer,
  limits: SandboxJob["limits"],
): Promise<DecodedStill> {
  let source: StaticSource;
  if (
    container.detectedType === "image/heic" ||
    container.detectedType === "image/heif"
  ) {
    let decoded;
    try {
      decoded = await heifDecodeToPng(tools, files.path("still"), files.work);
    } catch (error) {
      if (error instanceof MediaToolError && error.code === "tool_failed") {
        throw new MediaRejectedError("decode_failed");
      }
      throw error;
    }
    source = { input: decoded.path, autoOrient: false, expectedFormat: "png" };
  } else {
    source = {
      input: files.path("still"),
      autoOrient: true,
      expectedFormat: container.detectedType.slice("image/".length) as
        "jpeg" | "png" | "webp",
    };
  }
  return {
    source,
    inspection: await inspectStaticSource(source, {
      maxPixels: limits.maxPixels,
      maxDecodedBytes: limits.maxDecodedBytes,
    }),
  };
}

const mismatch = () => new MediaRejectedError("pairing_mismatch");

/**
 * Decides the pairing before any tool runs. Server-read Apple identifiers
 * win; a client claim that contradicts them, or a container claim next to an
 * Apple identifier, is a mismatch. Only Standard items may rely on a client
 * proof, because optimization strips the identifiers.
 */
const decidePairing = (
  item: SandboxItemRequest,
  packaged: boolean,
  stillId: string | null,
  motionId: string | null,
): SandboxPairing | null => {
  if (item.kind === "static") return null;
  const client = item.clientPairing;
  const stillTime = (method: SandboxPairingMethod) =>
    client?.method === method && client.stillTimeMs !== undefined
      ? { stillTimeMs: client.stillTimeMs }
      : {};
  if (packaged) {
    if (client?.method === "apple-content-identifier") throw mismatch();
    return {
      method: "motion-photo-container",
      verifiedBy: "server",
      identifierSha256: null,
      ...stillTime("motion-photo-container"),
    };
  }
  if (stillId !== null && motionId !== null) {
    if (stillId !== motionId) throw mismatch();
    const digest = contentIdentifierSha256(stillId);
    if (
      client &&
      client.method !== "none" &&
      (client.method !== "apple-content-identifier" ||
        client.identifierSha256 !== digest)
    ) {
      throw mismatch();
    }
    return {
      method: "apple-content-identifier",
      verifiedBy: "server",
      identifierSha256: digest,
      ...stillTime("apple-content-identifier"),
    };
  }
  if (item.qualityMode === "original" || !client || client.method === "none") {
    throw mismatch();
  }
  const surviving = stillId ?? motionId;
  if (
    surviving !== null &&
    (client.method !== "apple-content-identifier" ||
      contentIdentifierSha256(surviving) !== client.identifierSha256)
  ) {
    throw mismatch();
  }
  return {
    method: client.method,
    verifiedBy: "client",
    identifierSha256:
      client.method === "apple-content-identifier"
        ? client.identifierSha256
        : null,
    ...stillTime(client.method),
  };
};

/** Size and SHA-256 of a finished output file (opened without following links). */
async function describeFile(filePath: string) {
  const handle = await open(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1) {
      throw new MediaRejectedError("processing_failed");
    }
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk as Buffer);
    }
    return { bytes: info.size, sha256: hash.digest("hex") };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Renders a `process` or `derive` job; content rejections are thrown. */
async function renderItem(
  job: SandboxJob,
  paths: SandboxRendererPaths,
  tools: MediaToolRunner,
): Promise<SandboxRenderBody> {
  const item = job.item!;
  const processing = job.operation === "process";
  const live = item.kind === "live";
  const declared = new Map<SandboxInputRole, SandboxDeclaredType>(
    item.inputs.map((input) => [input.role, input.declaredType]),
  );
  const files = workspace(paths, new Set(declared.keys()));
  const needStill = processing || item.renditions.length > 0;
  const needMotion = live && (processing || item.motion);
  const packaged = declared.has("package");
  let stillDeclared: string | undefined;
  let motionDeclared: string | undefined;
  let packageType: SandboxDeclaredType | null = null;
  if (packaged) {
    packageType = await splitMotionPhoto(files, declared.get("package")!, {
      still: needStill,
      motion: needMotion,
    });
    stillDeclared = packageType;
    motionDeclared = "video/mp4";
  } else {
    stillDeclared = declared.get("still");
    motionDeclared = declared.get("motion");
  }

  // Cheap container and identifier checks first; tools run only after.
  const pairedComponents = processing && live && !packaged;
  const stillContainer = needStill
    ? await inspectStillContainer(files.path("still"), stillDeclared!, {
        identifier: pairedComponents,
        orientation: processing,
      })
    : null;
  const motionContainer = needMotion
    ? await inspectMotionContainer(
        files.path("motion"),
        motionDeclared!,
        pairedComponents,
      )
    : null;
  const pairing = processing
    ? decidePairing(
        item,
        packaged,
        stillContainer?.contentIdentifier ?? null,
        motionContainer?.contentIdentifier ?? null,
      )
    : null;

  const still = stillContainer
    ? await decodeStill(tools, files, stillContainer, job.limits)
    : null;
  let motion: MotionProbe | null = null;
  if (motionContainer) {
    motion = await probeMotionInput(tools, files.path("motion"));
    if (
      motionContainer.trackRotation !== null &&
      motionContainer.trackRotation !== motion.rotation
    ) {
      throw new MediaRejectedError("stream_layout_unsupported");
    }
    if (
      pairing?.stillTimeMs !== undefined &&
      pairing.stillTimeMs > motion.durationMs
    ) {
      throw mismatch();
    }
  }

  const outputs: SandboxOutput[] = [];
  let placeholderColor: string | null = null;
  const requested = new Set(item.renditions.map((request) => request.role));
  for (const role of STILL_ROLES) {
    if (!requested.has(role)) continue;
    const size = expectedStillSize(
      role,
      still!.inspection,
      item.edit,
      item.coverCrop,
      item.plan,
    );
    if (size === null) continue;
    const rendered = await renderStaticDerivative(
      still!.source,
      still!.inspection,
      role,
      item.edit,
      item.coverCrop,
      { timeoutSeconds: job.limits.renditionTimeoutSeconds },
    );
    if (rendered.width !== size.width || rendered.height !== size.height) {
      throw new MediaRejectedError("processing_failed");
    }
    const name = `${role}.webp`;
    const filePath = path.join(paths.output, name);
    const handle = await open(filePath, "wx", 0o600);
    try {
      await handle.writeFile(rendered.buffer);
    } finally {
      await handle.close();
    }
    outputs.push({
      name,
      role,
      contentType: "image/webp",
      width: rendered.width,
      height: rendered.height,
      durationMs: null,
      bytes: rendered.buffer.byteLength,
      sha256: createHash("sha256").update(rendered.buffer).digest("hex"),
    });
    if (role === "thumb" && item.placeholder) {
      placeholderColor = await placeholderColour(filePath);
    }
  }
  if (item.motion) {
    const filePath = path.join(paths.output, "motion.mp4");
    const file = await renderMotionDerivative(
      tools,
      files.path("motion"),
      filePath,
      motion!,
      item.edit,
    );
    outputs.push({
      name: "motion.mp4",
      role: "motion",
      contentType: "video/mp4",
      width: file.width,
      height: file.height,
      durationMs: file.durationMs,
      ...(await describeFile(filePath)),
    });
  }

  const inspection = still
    ? {
        width: still.inspection.width,
        height: still.inspection.height,
        hasAlpha: still.inspection.hasAlpha,
      }
    : null;
  if (!processing) {
    return {
      status: "derived",
      failureCode: null,
      inspection,
      detectedTypes: null,
      pairing: null,
      presentation: null,
      stillExifOrientation: null,
      placeholderColor,
      outputs,
    };
  }
  const detectedTypes = packageType
    ? [{ role: "package" as const, contentType: packageType }]
    : [
        { role: "still" as const, contentType: stillContainer!.detectedType },
        ...(motionContainer
          ? [
              {
                role: "motion" as const,
                contentType: motionContainer.detectedType,
              },
            ]
          : []),
      ];
  const heifStill =
    stillContainer!.detectedType === "image/heic" ||
    stillContainer!.detectedType === "image/heif";
  return {
    status: "processed",
    failureCode: null,
    inspection,
    detectedTypes,
    pairing,
    presentation: {
      width: still!.inspection.width,
      height: still!.inspection.height,
      ...(motion
        ? {
            durationMs: motion.durationMs,
            hasAudio: motion.hasAudio,
            displayRotation: motion.rotation,
          }
        : {}),
    },
    stillExifOrientation: heifStill
      ? stillContainer!.heifExifOrientation
      : still!.inspection.orientation,
    placeholderColor,
    outputs,
  };
}

/**
 * Maps a content failure to a rejection; infrastructure failures (a missing
 * tool, an unexpected error) are rethrown so the renderer exits as internal
 * and the coordinator retries.
 */
const rejectionOf = (error: unknown): MediaFailureCode | null => {
  if (error instanceof MediaRejectedError) return error.failureCode;
  if (error instanceof MediaParseError) return "decode_failed";
  if (error instanceof MediaToolError) {
    if (error.code === "timeout") return "processing_timeout";
    if (error.code === "tool_failed" || error.code === "output_limit") {
      return "processing_failed";
    }
    return null;
  }
  // A full output tmpfs is a bounded resource, the same for every retry.
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code: unknown }).code
      : null;
  return code === "ENOSPC" ? "processing_failed" : null;
};

/**
 * Renders one `process` or `derive` job into `paths.output` and returns the
 * manifest body: `processed`/`derived` with every output, or `rejected` with
 * a content-free code. Throws only for infrastructure failures.
 */
export async function renderSandboxJob(
  job: SandboxJob,
  paths: SandboxRendererPaths,
  tools: MediaToolRunner,
): Promise<SandboxRenderBody> {
  if (job.item === null) throw new TypeError("A render job names an item");
  try {
    return await renderItem(job, paths, tools);
  } catch (error) {
    const failureCode = rejectionOf(error);
    if (failureCode === null) throw error;
    return {
      status: "rejected",
      failureCode,
      inspection: null,
      detectedTypes: null,
      pairing: null,
      presentation: null,
      stillExifOrientation: null,
      placeholderColor: null,
      outputs: [],
    };
  }
}

/** The complete manifest of a job. */
export const sandboxManifest = (
  job: SandboxJob,
  runtime: SandboxRuntime,
  body:
    | SandboxRenderBody
    | { readonly selfCheck: SandboxIsolationFacts }
    | { readonly bounds: SandboxBoundsFacts },
): SandboxManifest =>
  "selfCheck" in body || "bounds" in body
    ? {
        protocol: SANDBOX_PROTOCOL_VERSION,
        nonce: job.nonce,
        runtime,
        status: "selfCheck" in body ? "self-check" : "bounds",
        failureCode: null,
        inspection: null,
        detectedTypes: null,
        pairing: null,
        presentation: null,
        stillExifOrientation: null,
        placeholderColor: null,
        outputs: [],
        selfCheck: "selfCheck" in body ? body.selfCheck : null,
        ...("bounds" in body ? { bounds: body.bounds } : {}),
      }
    : {
        protocol: SANDBOX_PROTOCOL_VERSION,
        nonce: job.nonce,
        runtime,
        ...body,
        selfCheck: null,
      };

/**
 * Writes the framed stream: the manifest line, then for each output its
 * header line and exactly its bytes (read back from `outputDirectory`), then
 * the end frame. `write` must resolve once the chunk is accepted.
 */
export async function writeSandboxStream(
  manifest: SandboxManifest,
  outputDirectory: string,
  write: (chunk: Buffer) => Promise<void>,
): Promise<void> {
  await write(Buffer.from(`${JSON.stringify(manifest)}\n`));
  for (const output of manifest.outputs) {
    await write(encodeFrameHeader(output.name, output.bytes, output.sha256));
    const handle = await open(
      path.join(outputDirectory, output.name),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    let sent = 0;
    try {
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        const bytes = chunk as Buffer;
        sent += bytes.byteLength;
        if (sent > output.bytes) throw new Error("Output changed while sent");
        await write(bytes);
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
    if (sent !== output.bytes) throw new Error("Output changed while sent");
  }
  await write(encodeEndFrame(manifest.outputs.length));
}
