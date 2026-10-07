import { MediaRejectedError } from "./errors.js";
import {
  MediaToolError,
  ffmpegMotionDerivative,
  ffprobeJson,
} from "./media-tools.js";
import {
  MOTION_COLOR,
  MOTION_DERIVATIVE,
  MOTION_DURATION_TOLERANCE_MS,
  MOTION_INPUT_LIMITS,
} from "./profiles.js";

import type { MediaEdit } from "./edits.js";
import type {
  MediaToolRunner,
  MotionColor,
  MotionSource,
} from "./media-tools.js";

/** Raw colour tags of the video stream as ffprobe reported them. */
export interface MotionColorTags {
  readonly primaries: string | null;
  readonly transfer: string | null;
  readonly matrix: string | null;
  readonly range: string | null;
}

export interface MotionProbe extends MotionSource {
  readonly durationMs: number;
  /** Coded dimensions of the single video stream. */
  readonly codedWidth: number;
  readonly codedHeight: number;
  /** Clockwise display rotation recorded in the container. */
  readonly rotation: 0 | 90 | 180 | 270;
  readonly hasAudio: boolean;
  readonly videoCodec: string | null;
  readonly audioCodec: string | null;
  readonly colorTags: MotionColorTags;
}

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const DURATION_PATTERN = /^\d{1,9}(?:\.\d{1,9})?$/;
const NAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,31}$/;

const durationMs = (value: unknown): number | null => {
  if (typeof value !== "string" || !DURATION_PATTERN.test(value)) return null;
  return Math.round(Number(value) * 1000);
};

/** A short lowercase ffprobe name, or null when absent or `unknown`. */
const tag = (value: unknown): string | null => {
  if (value === undefined || value === "unknown" || value === "unspecified") {
    return null;
  }
  if (typeof value !== "string" || !NAME_PATTERN.test(value)) {
    throw new MediaRejectedError("stream_layout_unsupported");
  }
  return value;
};

const allowed = <T extends string>(
  list: readonly T[],
  value: string,
): value is T => (list as readonly string[]).includes(value);

/**
 * Resolves colour tags against the {@link MOTION_COLOR} allowlists: untagged
 * values mean BT.709 limited range; unlisted values reject.
 */
function motionColor(tags: MotionColorTags, pixelFormat: string): MotionColor {
  const primaries = tags.primaries ?? "bt709";
  const transfer = tags.transfer ?? "bt709";
  const matrix = tags.matrix ?? "bt709";
  const range = tags.range ?? "tv";
  if (
    !allowed(MOTION_COLOR.primaries, primaries) ||
    !(
      allowed(MOTION_COLOR.sdrTransfers, transfer) ||
      allowed(MOTION_COLOR.hdrTransfers, transfer)
    ) ||
    !allowed(MOTION_COLOR.matrices, matrix) ||
    !allowed(MOTION_COLOR.ranges, range)
  ) {
    throw new MediaRejectedError("stream_layout_unsupported");
  }
  return {
    primaries,
    transfer,
    matrix,
    range,
    dynamicRange:
      transfer === "arib-std-b67"
        ? "hlg"
        : transfer === "smpte2084"
          ? "pq"
          : "sdr",
    pixelFormat,
  };
}

const clockwiseRotation = (stream: Record<string, unknown>) => {
  let counterClockwise: number | null = null;
  const sideData = stream.side_data_list;
  if (Array.isArray(sideData)) {
    for (const entry of sideData.slice(0, 16)) {
      const item = record(entry);
      if (typeof item?.rotation === "number") counterClockwise = item.rotation;
    }
  }
  const tags = record(stream.tags);
  if (counterClockwise === null && typeof tags?.rotate === "string") {
    // Legacy tag is already clockwise.
    counterClockwise = -Number(tags.rotate);
  }
  if (counterClockwise === null) return 0;
  if (!Number.isFinite(counterClockwise) || counterClockwise % 90 !== 0) {
    throw new MediaRejectedError("stream_layout_unsupported");
  }
  return (((-counterClockwise % 360) + 360) % 360) as 0 | 90 | 180 | 270;
};

/**
 * Validates untrusted ffprobe JSON: exactly one video stream, at most one
 * audio stream, a bounded number of data streams and nothing else; duration
 * ≤ 30 s; each dimension ≤ 8192; allowlisted colour tags. Only content-free
 * facts are returned.
 */
export function validateMotionProbe(json: unknown): MotionProbe {
  const root = record(json);
  const streams = root?.streams;
  const format = record(root?.format);
  if (!Array.isArray(streams) || !format) {
    throw new MediaRejectedError("decode_failed");
  }
  if (streams.length > MOTION_INPUT_LIMITS.maxStreams) {
    throw new MediaRejectedError("stream_layout_unsupported");
  }
  const video: Record<string, unknown>[] = [];
  const audio: Record<string, unknown>[] = [];
  let data = 0;
  for (const entry of streams) {
    const stream = record(entry);
    const type = stream?.codec_type;
    if (type === "video") video.push(stream!);
    else if (type === "audio") audio.push(stream!);
    else if (type === "data") data += 1;
    else throw new MediaRejectedError("stream_layout_unsupported");
  }
  if (
    video.length !== MOTION_INPUT_LIMITS.maxVideoStreams ||
    audio.length > MOTION_INPUT_LIMITS.maxAudioStreams ||
    data > MOTION_INPUT_LIMITS.maxDataStreams
  ) {
    throw new MediaRejectedError("stream_layout_unsupported");
  }
  const stream = video[0]!;
  const codedWidth = stream.width;
  const codedHeight = stream.height;
  if (
    typeof codedWidth !== "number" ||
    typeof codedHeight !== "number" ||
    !Number.isSafeInteger(codedWidth) ||
    !Number.isSafeInteger(codedHeight) ||
    codedWidth < 1 ||
    codedHeight < 1
  ) {
    throw new MediaRejectedError("decode_failed");
  }
  if (
    codedWidth > MOTION_INPUT_LIMITS.maxDimension ||
    codedHeight > MOTION_INPUT_LIMITS.maxDimension
  ) {
    throw new MediaRejectedError("dimensions_exceeded");
  }
  const duration = durationMs(format.duration) ?? durationMs(stream.duration);
  if (duration === null || duration < 1) {
    throw new MediaRejectedError("decode_failed");
  }
  if (duration > MOTION_INPUT_LIMITS.maxDurationMs) {
    throw new MediaRejectedError("duration_exceeded");
  }
  const rotation = clockwiseRotation(stream);
  const quarter = rotation === 90 || rotation === 270;
  const colorTags: MotionColorTags = {
    primaries: tag(stream.color_primaries),
    transfer: tag(stream.color_transfer),
    matrix: tag(stream.color_space),
    range: tag(stream.color_range),
  };
  return {
    durationMs: duration,
    codedWidth,
    codedHeight,
    width: quarter ? codedHeight : codedWidth,
    height: quarter ? codedWidth : codedHeight,
    rotation,
    hasAudio: audio.length === 1,
    videoCodec: tag(stream.codec_name),
    audioCodec: audio.length === 1 ? tag(audio[0]!.codec_name) : null,
    colorTags,
    color: motionColor(colorTags, tag(stream.pix_fmt) ?? ""),
  };
}

function rejectToolFailure(
  error: unknown,
  onToolFailure: "decode_failed" | "processing_failed",
): never {
  if (error instanceof MediaToolError) {
    if (error.code === "timeout")
      throw new MediaRejectedError("processing_timeout");
    if (error.code === "tool_failed")
      throw new MediaRejectedError(onToolFailure);
    if (error.code === "output_limit") {
      throw new MediaRejectedError("processing_failed");
    }
  }
  throw error;
}

/** Probes and validates a motion component of the job. */
export async function probeMotionInput(
  tools: MediaToolRunner,
  inputPath: string,
  signal?: AbortSignal,
): Promise<MotionProbe> {
  let json: unknown;
  try {
    json = await ffprobeJson(tools, inputPath, signal);
  } catch (error) {
    rejectToolFailure(error, "decode_failed");
  }
  return validateMotionProbe(json);
}

export interface MotionDerivativeFile {
  readonly path: string;
  readonly byteSize: number;
  readonly width: number;
  readonly height: number;
  readonly durationMs: number;
}

/**
 * Produces the motion MP4 for an edit and re-probes the written output: it
 * must be H.264 in 8-bit yuv420p tagged BT.709 limited range, upright
 * (rotation baked), keep AAC audio when the source had audio and keep the
 * source duration within {@link MOTION_DURATION_TOLERANCE_MS}.
 */
export async function renderMotionDerivative(
  tools: MediaToolRunner,
  inputPath: string,
  outputPath: string,
  source: MotionProbe,
  edit: MediaEdit,
  signal?: AbortSignal,
): Promise<MotionDerivativeFile> {
  let file: { path: string; byteSize: number };
  let json: unknown;
  try {
    file = await ffmpegMotionDerivative(
      tools,
      inputPath,
      outputPath,
      edit,
      source,
      signal,
    );
    json = await ffprobeJson(tools, outputPath, signal);
  } catch (error) {
    rejectToolFailure(error, "processing_failed");
  }
  let output: MotionProbe;
  try {
    output = validateMotionProbe(json);
  } catch {
    throw new MediaRejectedError("processing_failed");
  }
  const tags = output.colorTags;
  if (
    output.rotation !== 0 ||
    output.videoCodec !== MOTION_DERIVATIVE.outputVideoCodecName ||
    output.color.pixelFormat !== MOTION_DERIVATIVE.pixelFormat ||
    tags.primaries !== MOTION_COLOR.outputPrimaries ||
    tags.transfer !== MOTION_COLOR.outputTransfer ||
    tags.matrix !== MOTION_COLOR.outputMatrix ||
    tags.range !== MOTION_COLOR.outputRange ||
    output.hasAudio !== source.hasAudio ||
    (output.hasAudio &&
      output.audioCodec !== MOTION_DERIVATIVE.outputAudioCodecName) ||
    Math.abs(output.durationMs - source.durationMs) >
      MOTION_DURATION_TOLERANCE_MS
  ) {
    throw new MediaRejectedError("processing_failed");
  }
  return {
    path: file.path,
    byteSize: file.byteSize,
    width: output.width,
    height: output.height,
    durationMs: output.durationMs,
  };
}
