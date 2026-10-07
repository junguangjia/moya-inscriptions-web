import { spawn as nodeSpawn } from "node:child_process";

import { MediaToolError } from "../processing/media-tools.js";
import { MEDIA_TOOL_OUTPUT_LIMITS } from "../processing/profiles.js";

import type { Readable } from "node:stream";
import type {
  MediaTool,
  MediaToolFailure,
  MediaToolRunner,
} from "../processing/media-tools.js";

/*
 * The in-sandbox tool runner: heif-dec, ffprobe and FFmpeg run as direct
 * child processes of the renderer (absolute paths, argument arrays, no shell,
 * an empty environment), each under its own deadline and output caps. The
 * container itself is the isolation boundary; this bounds each tool's time
 * and the output the renderer keeps.
 */

/** Tool executables in the media sandbox image. */
export const SANDBOX_TOOL_PATHS: Readonly<Record<MediaTool, string>> = {
  "heif-dec": "/usr/bin/heif-dec",
  ffprobe: "/usr/bin/ffprobe",
  ffmpeg: "/usr/bin/ffmpeg",
};

/** The subset of a spawned child process the runner relies on. */
export interface LocalToolProcess {
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: string, listener: (...args: never[]) => void): unknown;
}

export interface LocalToolSpawnOptions {
  readonly stdio: ["ignore", "pipe", "pipe"];
  readonly shell: false;
  readonly windowsHide: true;
  readonly env: Readonly<Record<string, string>>;
}

export type LocalToolSpawn = (
  command: string,
  args: string[],
  options: LocalToolSpawnOptions,
) => LocalToolProcess;

const TOOLS = new Set<string>(["heif-dec", "ffprobe", "ffmpeg"]);
const MAX_ARGUMENTS = 128;
const MAX_ARGUMENT_CHARS = 4096;

export function createLocalToolRunner(
  options: {
    readonly spawn?: LocalToolSpawn;
    readonly paths?: Readonly<Record<MediaTool, string>>;
  } = {},
): MediaToolRunner {
  const spawn: LocalToolSpawn =
    options.spawn ??
    ((command, args, spawnOptions) =>
      nodeSpawn(command, args, {
        ...spawnOptions,
        env: { ...spawnOptions.env } as NodeJS.ProcessEnv,
      }) as LocalToolProcess);
  const paths = options.paths ?? SANDBOX_TOOL_PATHS;
  return {
    run: (tool, args, runOptions) =>
      new Promise<Buffer>((resolve, reject) => {
        if (
          !TOOLS.has(tool) ||
          !Array.isArray(args) ||
          args.length > MAX_ARGUMENTS ||
          args.some(
            (arg) =>
              typeof arg !== "string" ||
              arg.length > MAX_ARGUMENT_CHARS ||
              arg.includes("\0"),
          ) ||
          !Number.isSafeInteger(runOptions.timeoutMs) ||
          runOptions.timeoutMs < 1
        ) {
          reject(new Error("Invalid media tool invocation"));
          return;
        }
        if (runOptions.signal?.aborted) {
          reject(new MediaToolError("aborted"));
          return;
        }
        const maxStdoutBytes =
          runOptions.maxStdoutBytes ??
          MEDIA_TOOL_OUTPUT_LIMITS.defaultStdoutBytes;
        const maxStderrBytes =
          runOptions.maxStderrBytes ?? MEDIA_TOOL_OUTPUT_LIMITS.stderrBytes;
        let child: LocalToolProcess;
        try {
          child = spawn(paths[tool], [...args], {
            stdio: ["ignore", "pipe", "pipe"],
            shell: false,
            windowsHide: true,
            env: {},
          });
        } catch {
          reject(new MediaToolError("spawn_failed"));
          return;
        }
        const stdout: Buffer[] = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let failure: MediaToolFailure | null = null;
        let settled = false;
        const stop = (code: MediaToolFailure) => {
          if (failure !== null || settled) return;
          failure = code;
          child.kill("SIGKILL");
        };
        const timer = setTimeout(() => stop("timeout"), runOptions.timeoutMs);
        const onAbort = () => stop("aborted");
        runOptions.signal?.addEventListener("abort", onAbort, { once: true });
        const finish = (error: Error | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          runOptions.signal?.removeEventListener("abort", onAbort);
          if (error) reject(error);
          else resolve(Buffer.concat(stdout));
        };
        child.stdout?.on("data", (chunk: Buffer) => {
          stdoutBytes += chunk.byteLength;
          if (stdoutBytes > maxStdoutBytes) stop("output_limit");
          else if (failure === null) stdout.push(chunk);
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          // Diagnostics are counted, never retained or logged.
          stderrBytes += chunk.byteLength;
          if (stderrBytes > maxStderrBytes) stop("output_limit");
        });
        child.on("error", () => {
          finish(new MediaToolError(failure ?? "spawn_failed"));
        });
        child.on("close", (code: number | null) => {
          if (failure !== null) finish(new MediaToolError(failure, code));
          else if (code === 0) finish(null);
          else finish(new MediaToolError("tool_failed", code));
        });
      }),
  };
}
