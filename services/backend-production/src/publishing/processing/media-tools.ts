import { constants } from "node:fs";
import { mkdtemp, open, readdir } from "node:fs/promises";
import path from "node:path";

import { ffmpegEditFilters } from "./edits.js";
import {
  MEDIA_TOOL_MAX_OUTPUT_FILE_BYTES,
  MEDIA_TOOL_OUTPUT_LIMITS,
  MEDIA_TOOL_TIMEOUTS_MS,
  MOTION_COLOR,
  MOTION_DERIVATIVE,
} from "./profiles.js";

import type { MediaEdit } from "./edits.js";

/*
 * The media tools (heif-dec, ffprobe, FFmpeg) as the sandboxed renderer runs
 * them: local child processes inside the one no-network sandbox container of
 * a job, with per-tool deadlines and output caps. Arguments name absolute
 * paths in the container's job directories; nothing here reaches the host.
 */

export type MediaTool = "heif-dec" | "ffprobe" | "ffmpeg";

/** File name of a decoded HEIC/HEIF still inside its own directory. */
const HEIF_OUTPUT_NAME = "still.png";

export type MediaToolFailure =
  | "spawn_failed"
  | "sandbox_unavailable"
  | "timeout"
  | "output_limit"
  | "aborted"
  | "tool_failed";

/** Tool invocation failure; carries no tool output, paths or input bytes. */
export class MediaToolError extends Error {
  constructor(
    readonly code: MediaToolFailure,
    readonly exitCode: number | null = null,
  ) {
    super(`Publishing media tool failure: ${code}`);
    this.name = "MediaToolError";
  }
}

export interface MediaToolRunOptions {
  readonly timeoutMs: number;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
  readonly signal?: AbortSignal;
}

/** Runs one tool invocation and resolves its (bounded) stdout. */
export interface MediaToolRunner {
  run(
    tool: MediaTool,
    args: readonly string[],
    options: MediaToolRunOptions,
  ): Promise<Buffer>;
}

/**
 * Checks a file a tool wrote: a regular file (opened without following links
 * or blocking on FIFOs) between 1 byte and the tool output ceiling.
 */
export async function assertToolOutput(
  filePath: string,
): Promise<{ path: string; byteSize: number }> {
  let handle;
  try {
    handle = await open(
      filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    throw new MediaToolError("tool_failed");
  }
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.size < 1 ||
      info.size > MEDIA_TOOL_MAX_OUTPUT_FILE_BYTES
    ) {
      throw new MediaToolError("tool_failed");
    }
    return { path: filePath, byteSize: info.size };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Decodes the primary image of a HEIC/HEIF still to PNG with libheif
 * (`irot`/`imir`/`clap` applied) in a fresh directory below `workDirectory`.
 * Auxiliary or multi-image outputs are refused: the directory must hold
 * exactly the one decoded file afterwards.
 */
export async function heifDecodeToPng(
  tools: MediaToolRunner,
  inputPath: string,
  workDirectory: string,
  signal?: AbortSignal,
): Promise<{ path: string; byteSize: number }> {
  const directory = await mkdtemp(path.join(workDirectory, "heif-"));
  const outputPath = path.join(directory, HEIF_OUTPUT_NAME);
  await tools.run("heif-dec", ["--quiet", inputPath, outputPath], {
    timeoutMs: MEDIA_TOOL_TIMEOUTS_MS.heifDecode,
    ...(signal ? { signal } : {}),
  });
  const produced = await readdir(directory);
  if (produced.length !== 1 || produced[0] !== HEIF_OUTPUT_NAME) {
    throw new MediaToolError("tool_failed");
  }
  return assertToolOutput(outputPath);
}

/** `ffprobe -v error -show_streams -show_format -of json` (mov demuxer pinned). */
export async function ffprobeJson(
  tools: MediaToolRunner,
  inputPath: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const stdout = await tools.run(
    "ffprobe",
    [
      "-v",
      "error",
      "-f",
      "mov",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      inputPath,
    ],
    {
      timeoutMs: MEDIA_TOOL_TIMEOUTS_MS.ffprobe,
      maxStdoutBytes: MEDIA_TOOL_OUTPUT_LIMITS.ffprobeStdoutBytes,
      ...(signal ? { signal } : {}),
    },
  );
  try {
    return JSON.parse(stdout.toString("utf8")) as unknown;
  } catch {
    throw new MediaToolError("tool_failed");
  }
}

/**
 * Colour facts of a validated motion source. Values are ffprobe names from
 * the {@link MOTION_COLOR} allowlists, with `unknown` resolved to BT.709.
 */
export interface MotionColor {
  readonly primaries: (typeof MOTION_COLOR.primaries)[number];
  readonly transfer:
    | (typeof MOTION_COLOR.sdrTransfers)[number]
    | (typeof MOTION_COLOR.hdrTransfers)[number];
  readonly matrix: (typeof MOTION_COLOR.matrices)[number];
  readonly range: (typeof MOTION_COLOR.ranges)[number];
  readonly dynamicRange: "sdr" | "hlg" | "pq";
  readonly pixelFormat: string;
}

/** The source facts the motion derivative arguments depend on. */
export interface MotionSource {
  /** Upright display size after the recorded rotation. */
  readonly width: number;
  readonly height: number;
  readonly color: MotionColor;
}

/**
 * Colour filters around the geometry: `setparams` pins the validated source
 * tags first; the tail converts to 8-bit BT.709 limited range (zscale), with
 * tone mapping for HLG/PQ.
 */
export function ffmpegColorFilters(color: MotionColor): {
  readonly head: string[];
  readonly tail: string[];
} {
  const head = [
    `setparams=color_primaries=${color.primaries}:color_trc=${color.transfer}:colorspace=${color.matrix}:range=${color.range}`,
  ];
  if (color.dynamicRange !== "sdr") {
    return {
      head,
      tail: [
        `zscale=transfer=linear:npl=${MOTION_COLOR.nominalPeakNits}`,
        "format=gbrpf32le",
        "zscale=primaries=709",
        `tonemap=tonemap=${MOTION_COLOR.toneMapOperator}:desat=0`,
        "zscale=transfer=709:matrix=709:range=tv",
        `format=${MOTION_DERIVATIVE.pixelFormat}`,
      ],
    };
  }
  const alreadyOutput =
    color.primaries === "bt709" &&
    color.transfer === "bt709" &&
    color.matrix === "bt709" &&
    color.range === "tv" &&
    color.pixelFormat === MOTION_DERIVATIVE.pixelFormat;
  return {
    head,
    tail: alreadyOutput
      ? [`format=${MOTION_DERIVATIVE.pixelFormat}`]
      : [
          "zscale=primaries=709:transfer=709:matrix=709:range=tv",
          `format=${MOTION_DERIVATIVE.pixelFormat}`,
        ],
  };
}

/** FFmpeg arguments for the motion derivative (autorotate stays enabled). */
export function ffmpegMotionArguments(
  inputPath: string,
  outputPath: string,
  edit: MediaEdit,
  source: MotionSource,
): string[] {
  const color = ffmpegColorFilters(source.color);
  return [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-n",
    "-f",
    "mov",
    "-i",
    inputPath,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-map_metadata",
    "-1",
    "-map_chapters",
    "-1",
    "-dn",
    "-sn",
    "-vf",
    [
      ...color.head,
      ...ffmpegEditFilters(edit, source, MOTION_DERIVATIVE.maxLongEdge),
      ...color.tail,
    ].join(","),
    "-c:v",
    MOTION_DERIVATIVE.videoCodec,
    "-profile:v",
    MOTION_DERIVATIVE.videoProfile,
    "-preset",
    MOTION_DERIVATIVE.preset,
    "-crf",
    String(MOTION_DERIVATIVE.crf),
    "-pix_fmt",
    MOTION_DERIVATIVE.pixelFormat,
    "-color_primaries",
    MOTION_COLOR.outputPrimaries,
    "-color_trc",
    MOTION_COLOR.outputTransfer,
    "-colorspace",
    MOTION_COLOR.outputMatrix,
    "-color_range",
    MOTION_COLOR.outputRange,
    "-c:a",
    MOTION_DERIVATIVE.audioCodec,
    "-b:a",
    MOTION_DERIVATIVE.audioBitrate,
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    outputPath,
  ];
}

/** Transcodes a motion component into the MP4 derivative at `outputPath`. */
export async function ffmpegMotionDerivative(
  tools: MediaToolRunner,
  inputPath: string,
  outputPath: string,
  edit: MediaEdit,
  source: MotionSource,
  signal?: AbortSignal,
): Promise<{ path: string; byteSize: number }> {
  await tools.run(
    "ffmpeg",
    ffmpegMotionArguments(inputPath, outputPath, edit, source),
    {
      timeoutMs: MEDIA_TOOL_TIMEOUTS_MS.ffmpegMotion,
      ...(signal ? { signal } : {}),
    },
  );
  return assertToolOutput(outputPath);
}
