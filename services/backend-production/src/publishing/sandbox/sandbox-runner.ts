import { spawn as nodeSpawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertPrivateMediaDirectory } from "../../storage/publishing-media-store.js";
import {
  MediaProcessingInputError,
  MediaProcessingUnavailableError,
} from "../processing/errors.js";
import { MediaToolError } from "../processing/media-tools.js";
import {
  MEDIA_TOOL_CONTAINER_TIMEOUT_GRACE_MS,
  SANDBOX_INPUT_LIMITS,
  SANDBOX_LIMITS,
  SANDBOX_NODE_MAJOR,
  SANDBOX_OUTPUT_LIMITS,
  SANDBOX_SHARP_VERSION,
  SANDBOX_TIMEOUTS_MS,
  MEDIA_TOOL_TIMEOUTS_MS,
} from "../processing/profiles.js";
import { isolationMismatches } from "./isolation-probe.js";
import {
  SANDBOX_BOUNDS_PROBES,
  SANDBOX_CONTAINER_PREFIX,
  SANDBOX_ENVIRONMENT,
  SANDBOX_EXIT_CODES,
  SANDBOX_JOB_FILE,
  SANDBOX_PATHS,
  SANDBOX_PROTOCOL_VERSION,
  SandboxProtocolError,
  parseFrameHeader,
  parseSandboxManifest,
} from "./protocol.js";

import type { FileHandle } from "node:fs/promises";
import type { Readable } from "node:stream";
import type { MediaToolFailure } from "../processing/media-tools.js";
import type {
  SandboxBoundsFacts,
  SandboxBoundsProbe,
  SandboxIsolationFacts,
  SandboxJob,
  SandboxLimits,
  SandboxManifest,
  SandboxRuntime,
  SandboxViolation,
} from "./protocol.js";

/*
 * The coordinator side of the media sandbox (W5-W11). One container per job
 * runs the release's own renderer (`dist`, mounted read-only) in the pinned
 * media sandbox image: no network, read-only root, no capabilities, a fixed
 * unprivileged user, bounded memory/CPU/PIDs/files, size-capped tmpfs
 * scratch, no logs and no writable host path. The only host path it sees
 * besides the renderer is the job's read-only input. Outputs come back as a
 * framed, hashed stdout stream that this runner decodes into the job's
 * private output directory under per-file, total and count caps; any
 * violation kills the container. Abort, lease loss, shutdown and the timeout
 * kill the container too. Docker is spawned with an argument array, never a
 * shell, and an allowlisted environment.
 */

/** The subset of a spawned Docker CLI process the runner relies on. */
export interface SandboxProcess {
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: string, listener: (...args: never[]) => void): unknown;
}

export interface SandboxSpawnOptions {
  readonly stdio: ["ignore", "pipe", "pipe"];
  readonly shell: false;
  readonly windowsHide: true;
  readonly env: Readonly<Record<string, string>>;
}

export type SandboxSpawn = (
  command: "docker",
  args: string[],
  options: SandboxSpawnOptions,
) => SandboxProcess;

export interface SandboxJobDirectory {
  readonly id: string;
  /** Host directory mounted read-only at `/job/in`; written only by the host. */
  readonly inputDirectory: string;
  /** Host-only directory receiving the decoded output frames. */
  readonly outputDirectory: string;
  inputPath(name: string): string;
  dispose(): Promise<void>;
}

export interface SandboxReceivedFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface SandboxRunResult {
  readonly manifest: SandboxManifest;
  /** Received output files by name, in manifest order. */
  readonly files: ReadonlyMap<string, SandboxReceivedFile>;
}

export type SandboxSelfCheckReport =
  | {
      readonly status: "ok";
      readonly runtime: SandboxRuntime;
      readonly facts: SandboxIsolationFacts;
    }
  | {
      /** Facts or versions differ from the expected isolation (exit 78). */
      readonly status: "mismatch";
      readonly mismatches: readonly string[];
      readonly runtime: SandboxRuntime | null;
      readonly facts: SandboxIsolationFacts | null;
    }
  | {
      /** The daemon, the image or the renderer could not run (exit 75). */
      readonly status: "unavailable";
      readonly reason: string;
    };

/** One active bound probe as the coordinator observed it (content-free). */
export interface SandboxBoundsProbeResult {
  readonly probe: SandboxBoundsProbe;
  readonly passed: boolean;
  /** The violation, error code or reported count and code that was seen. */
  readonly observed: string;
  readonly elapsedMs: number;
}

export type SandboxBoundsCheckReport =
  | {
      /** `ok` when every probe ended at its bound and nothing was left. */
      readonly status: "ok" | "failed";
      readonly probes: readonly SandboxBoundsProbeResult[];
      /** Sandbox containers still present after the probes (expected 0). */
      readonly leftoverContainers: number;
    }
  | {
      /** The daemon, the image or the renderer could not run. */
      readonly status: "unavailable";
      readonly reason: string;
    };

export interface SandboxRunner {
  createJob(): Promise<SandboxJobDirectory>;
  run(
    job: SandboxJobDirectory,
    request: SandboxJob,
    options: { readonly timeoutMs: number; readonly signal?: AbortSignal },
  ): Promise<SandboxRunResult>;
  /** Version handshake and isolation probe through the same arguments. */
  selfCheck(): Promise<SandboxSelfCheckReport>;
  /**
   * Active bound probes through the same arguments (W11, acceptance only;
   * run with the worker stopped): memory, processes, wall clock, output
   * disk and stdout each end at their sandbox bound.
   */
  boundsCheck(): Promise<SandboxBoundsCheckReport>;
  /** Removes containers a crashed worker left behind (name prefix, bounded). */
  removeOrphanContainers(): Promise<{ readonly removed: number }>;
  /**
   * Removes job directories (crash leftovers) not touched since `olderThan`
   * and not active in this process.
   */
  sweepJobs(olderThan: Date): Promise<{ readonly removed: number }>;
}

export interface SandboxRunnerOptions {
  /** Local image reference with an explicit tag or digest; never pulled. */
  readonly image: string;
  /** Private work directory (same rules as the media store directory). */
  readonly workDirectory: string;
  /** This release's compiled `dist`, mounted read-only into the container. */
  readonly appDist: string;
  /**
   * Source tree of the renderer in Development; a `dist` older than it is
   * refused with an actionable message instead of running stale code.
   */
  readonly sourceDirectory?: string;
  readonly spawn?: SandboxSpawn;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /**
   * Grace before the Docker CLI is SIGKILLed after a container kill; also the
   * delay before the container removal is repeated.
   */
  readonly killGraceMs?: number;
  /** Test seam forwarded to {@link assertPrivateMediaDirectory}. */
  readonly temporaryRoots?: readonly string[];
  readonly logger?: { error(message: string): void };
}

const IMAGE_PATTERN =
  /^[a-z0-9][a-z0-9._/-]{0,127}(?::[A-Za-z0-9._-]{1,128})?(?:@sha256:[0-9a-f]{64})?$|^sha256:[0-9a-f]{64}$/;
const FILE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}(?:\.[a-z0-9]{1,8})?$/;
const JOB_NAME_PATTERN = /^job-[0-9a-f]{32}$/;
const CONTAINER_NAME_PATTERN = /^yoyi-wp-media-[0-9a-f]{24}$/;
const MOUNT_UNSAFE = /[,"\n\r\0]/;
const DOCKER_ENVIRONMENT_KEYS = [
  "PATH",
  "HOME",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
  "XDG_RUNTIME_DIR",
];
const CONTROL_TIMEOUT_MS = 15_000;
const MAX_ORPHANS = 32;
const RENDERER_ENTRY = path.join("publishing", "sandbox", "renderer-main.js");

/** Whole seconds the in-container `timeout` allows for a coordinator limit. */
export const containerTimeoutSeconds = (timeoutMs: number): number =>
  Math.ceil((timeoutMs + MEDIA_TOOL_CONTAINER_TIMEOUT_GRACE_MS) / 1000);

/** The limits every job carries (W8). */
export const SANDBOX_JOB_LIMITS: SandboxLimits = {
  maxPixels: SANDBOX_INPUT_LIMITS.maxPixels,
  maxDecodedBytes: SANDBOX_INPUT_LIMITS.maxDecodedBytes,
  renditionTimeoutSeconds: SANDBOX_TIMEOUTS_MS.rendition / 1000,
  tools: {
    heifDecodeMs: MEDIA_TOOL_TIMEOUTS_MS.heifDecode,
    ffprobeMs: MEDIA_TOOL_TIMEOUTS_MS.ffprobe,
    ffmpegMotionMs: MEDIA_TOOL_TIMEOUTS_MS.ffmpegMotion,
  },
};

/** Coordinator deadline per bound probe; `time` must be stopped by it. */
const BOUNDS_PROBE_TIMEOUTS_MS: Readonly<Record<SandboxBoundsProbe, number>> = {
  memory: 120_000,
  pids: 120_000,
  time: 2_000,
  disk: 120_000,
  stdout: 30_000,
};

/** The configured size of the output tmpfs in MiB (the disk probe's bound). */
const OUTPUT_TMPFS_MIB = Number(
  /size=(\d+)m/.exec(SANDBOX_LIMITS.outputTmpfs)?.[1] ?? Number.NaN,
);

/**
 * Whether one probe ended at its bound: memory and the stdout flood are
 * stopped by a kill or a protocol refusal, `time` by the coordinator's
 * deadline, processes and disk report the refusal they met below the bound.
 */
const judgeBoundsProbe = (
  probe: SandboxBoundsProbe,
  outcome:
    { readonly facts: SandboxBoundsFacts | null } | { readonly error: unknown },
  elapsedMs: number,
  killGraceMs: number,
): { readonly passed: boolean; readonly observed: string } => {
  if ("error" in outcome) {
    const { error } = outcome;
    const observed =
      error instanceof SandboxProtocolError
        ? error.violation
        : error instanceof MediaToolError
          ? error.code
          : "error";
    const passed =
      (probe === "memory" && observed === "resource_exceeded") ||
      (probe === "stdout" && observed === "manifest_too_large") ||
      (probe === "time" &&
        observed === "timeout" &&
        elapsedMs < BOUNDS_PROBE_TIMEOUTS_MS.time + killGraceMs + 5_000);
    return { passed, observed };
  }
  const facts = outcome.facts;
  if (facts === null || facts.probe !== probe)
    return { passed: false, observed: "no_report" };
  const observed = `${facts.count} ${facts.errorCode ?? "none"}`;
  const passed =
    (probe === "pids" &&
      facts.errorCode === "EAGAIN" &&
      facts.count >= 1 &&
      facts.count < Number(SANDBOX_LIMITS.pidsLimit)) ||
    (probe === "disk" &&
      facts.errorCode === "ENOSPC" &&
      facts.count <= OUTPUT_TMPFS_MIB);
  return { passed, observed };
};

/** A fresh 32-hex nonce binding one job's stream to its run. */
export const sandboxNonce = (): string => randomBytes(16).toString("hex");

/**
 * The compiled `dist` of this package (the renderer the container runs) and,
 * when running from source in Development, the source tree beside it.
 */
export function defaultSandboxAppDist(): {
  readonly appDist: string;
  readonly sourceDirectory: string;
} {
  const packageRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
  );
  return {
    appDist: path.join(packageRoot, "dist"),
    sourceDirectory: path.join(packageRoot, "src"),
  };
}

/** Exact `docker run` argument array for one sandbox job (W8, W7). */
export function buildSandboxRunArguments(input: {
  readonly image: string;
  readonly containerName: string;
  readonly inputDirectory: string;
  readonly appDist: string;
  readonly timeoutMs: number;
}): string[] {
  return [
    "run",
    "--rm",
    "--pull",
    "never",
    "--log-driver",
    "none",
    "--name",
    input.containerName,
    "--network",
    "none",
    "--read-only",
    "--tmpfs",
    SANDBOX_LIMITS.tmpTmpfs,
    "--tmpfs",
    SANDBOX_LIMITS.workTmpfs,
    "--tmpfs",
    SANDBOX_LIMITS.outputTmpfs,
    "--memory",
    SANDBOX_LIMITS.memory,
    "--memory-swap",
    SANDBOX_LIMITS.memorySwap,
    "--cpus",
    SANDBOX_LIMITS.cpus,
    "--pids-limit",
    SANDBOX_LIMITS.pidsLimit,
    "--ulimit",
    SANDBOX_LIMITS.nofile,
    "--ulimit",
    SANDBOX_LIMITS.core,
    "--oom-score-adj",
    SANDBOX_LIMITS.oomScoreAdj,
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "--user",
    SANDBOX_LIMITS.user,
    ...Object.entries(SANDBOX_ENVIRONMENT).flatMap(([key, value]) => [
      "--env",
      `${key}=${value}`,
    ]),
    "--mount",
    `type=bind,source=${input.inputDirectory},target=${SANDBOX_PATHS.input},readonly`,
    "--mount",
    `type=bind,source=${input.appDist},target=${SANDBOX_PATHS.app},readonly`,
    "--workdir",
    SANDBOX_PATHS.tmp,
    "--entrypoint",
    SANDBOX_PATHS.timeout,
    input.image,
    "--signal=KILL",
    `${containerTimeoutSeconds(input.timeoutMs)}s`,
    SANDBOX_PATHS.node,
    `--max-old-space-size=${SANDBOX_LIMITS.nodeOldSpaceMb}`,
    "--disallow-code-generation-from-strings",
    SANDBOX_PATHS.renderer,
  ];
}

const filteredEnvironment = (
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> => {
  const environment: Record<string, string> = {};
  for (const key of DOCKER_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
};

/** Newest modification time below `directory` (TypeScript sources only). */
const newestSource = async (directory: string): Promise<number> => {
  let newest = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, await newestSource(entryPath));
    } else if (entry.name.endsWith(".ts")) {
      newest = Math.max(newest, (await stat(entryPath)).mtimeMs);
    }
  }
  return newest;
};

/**
 * Incremental decoder of the framed stdout stream. Writes each frame to its
 * own new file (exclusive create, no links, 0600) in the job's output
 * directory, hashing as it goes; every bound violation throws a
 * `SandboxProtocolError`.
 */
class FrameDecoder {
  private buffer = Buffer.alloc(0);
  private phase: "manifest" | "header" | "body" | "done" = "manifest";
  manifest: SandboxManifest | null = null;
  private next = 0;
  private file: {
    handle: FileHandle;
    name: string;
    path: string;
    remaining: number;
    bytes: number;
    sha256: string;
    hash: ReturnType<typeof createHash>;
  } | null = null;
  private total = 0;
  readonly files = new Map<string, SandboxReceivedFile>();

  constructor(
    private readonly outputDirectory: string,
    private readonly nonce: string,
  ) {}

  get complete(): boolean {
    return this.phase === "done";
  }

  async push(chunk: Buffer): Promise<void> {
    let data = chunk;
    while (data.byteLength > 0) {
      if (this.phase === "done") {
        throw new SandboxProtocolError("stream_trailing_bytes");
      }
      if (this.phase === "body") {
        data = await this.body(data);
        continue;
      }
      const limit =
        this.phase === "manifest"
          ? SANDBOX_OUTPUT_LIMITS.manifestBytes
          : SANDBOX_OUTPUT_LIMITS.frameHeaderBytes;
      const newline = data.indexOf(0x0a);
      if (newline === -1) {
        if (this.buffer.byteLength + data.byteLength > limit) {
          throw new SandboxProtocolError(
            this.phase === "manifest" ? "manifest_too_large" : "frame_invalid",
          );
        }
        this.buffer = Buffer.concat([this.buffer, data]);
        return;
      }
      if (this.buffer.byteLength + newline > limit) {
        throw new SandboxProtocolError(
          this.phase === "manifest" ? "manifest_too_large" : "frame_invalid",
        );
      }
      const line = Buffer.concat([this.buffer, data.subarray(0, newline)]);
      this.buffer = Buffer.alloc(0);
      data = data.subarray(newline + 1);
      if (this.phase === "manifest") this.acceptManifest(line.toString("utf8"));
      else await this.acceptHeader(line.toString("utf8"));
    }
  }

  private acceptManifest(line: string) {
    const manifest = parseSandboxManifest(line);
    if (manifest.nonce !== this.nonce) {
      throw new SandboxProtocolError("nonce_mismatch");
    }
    if (
      manifest.runtime.sharp !== SANDBOX_SHARP_VERSION ||
      Number(manifest.runtime.node.split(".")[0]) !== SANDBOX_NODE_MAJOR
    ) {
      throw new SandboxProtocolError("runtime_mismatch");
    }
    if (manifest.outputs.length > SANDBOX_OUTPUT_LIMITS.files) {
      throw new SandboxProtocolError("frame_too_large");
    }
    let total = 0;
    for (const output of manifest.outputs) {
      if (!FILE_NAME_PATTERN.test(output.name)) {
        throw new SandboxProtocolError("manifest_invalid");
      }
      if (output.bytes > SANDBOX_OUTPUT_LIMITS.fileBytes) {
        throw new SandboxProtocolError("frame_too_large");
      }
      total += output.bytes;
    }
    if (total > SANDBOX_OUTPUT_LIMITS.totalBytes) {
      throw new SandboxProtocolError("frame_too_large");
    }
    this.manifest = manifest;
    this.phase = "header";
  }

  private async acceptHeader(line: string) {
    const header = parseFrameHeader(line);
    const outputs = this.manifest!.outputs;
    if (header.kind === "end") {
      if (header.count !== outputs.length || this.next !== outputs.length) {
        throw new SandboxProtocolError("stream_incomplete");
      }
      this.phase = "done";
      return;
    }
    const expected = outputs[this.next];
    if (
      expected === undefined ||
      header.name !== expected.name ||
      header.bytes !== expected.bytes ||
      header.sha256 !== expected.sha256
    ) {
      throw new SandboxProtocolError("frame_invalid");
    }
    this.total += header.bytes;
    if (this.total > SANDBOX_OUTPUT_LIMITS.totalBytes) {
      throw new SandboxProtocolError("frame_too_large");
    }
    const filePath = path.join(this.outputDirectory, header.name);
    const handle = await open(
      filePath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    this.file = {
      handle,
      name: header.name,
      path: filePath,
      remaining: header.bytes,
      bytes: header.bytes,
      sha256: header.sha256,
      hash: createHash("sha256"),
    };
    this.next += 1;
    this.phase = "body";
  }

  private async body(data: Buffer): Promise<Buffer> {
    const file = this.file!;
    const part = data.subarray(0, Math.min(file.remaining, data.byteLength));
    file.hash.update(part);
    await file.handle.write(part);
    file.remaining -= part.byteLength;
    if (file.remaining === 0) {
      await file.handle.close();
      this.file = null;
      if (file.hash.digest("hex") !== file.sha256) {
        throw new SandboxProtocolError("hash_mismatch");
      }
      this.files.set(file.name, {
        path: file.path,
        bytes: file.bytes,
        sha256: file.sha256,
      });
      this.phase = "header";
    }
    return data.subarray(part.byteLength);
  }

  async close(): Promise<void> {
    await this.file?.handle.close().catch(() => undefined);
    this.file = null;
  }
}

/**
 * Creates the coordinator's sandbox runner. Each job gets
 * `<work>/job-<32hex>/` (0700) holding `in/` (0755, files 0644, mounted
 * read-only) and `out/` (0700, never mounted). Performs no Docker call.
 */
export async function createSandboxRunner(
  options: SandboxRunnerOptions,
): Promise<SandboxRunner> {
  if (!IMAGE_PATTERN.test(options.image)) {
    throw new Error("Invalid media sandbox image reference");
  }
  const workDirectory = await assertPrivateMediaDirectory(
    options.workDirectory,
    options.temporaryRoots ? { temporaryRoots: options.temporaryRoots } : {},
  );
  const appDist = path.resolve(options.appDist);
  if (
    MOUNT_UNSAFE.test(workDirectory) ||
    MOUNT_UNSAFE.test(appDist) ||
    !path.isAbsolute(options.appDist)
  ) {
    throw new Error("Media sandbox directories cannot be bind-mounted safely");
  }
  const spawn: SandboxSpawn =
    options.spawn ??
    ((command, args, spawnOptions) =>
      nodeSpawn(command, args, {
        ...spawnOptions,
        env: { ...spawnOptions.env } as NodeJS.ProcessEnv,
      }) as SandboxProcess);
  const environment = filteredEnvironment(options.environment ?? process.env);
  const killGraceMs = options.killGraceMs ?? 5_000;
  const logger = options.logger ?? console;
  /** Job id → job root, for jobs created here and not yet disposed. */
  const activeJobs = new Map<string, string>();
  let rendererReported = false;
  let imageReported = false;

  /** Spawns a short Docker control command and resolves its bounded stdout. */
  const control = (args: string[]) =>
    new Promise<string>((resolve) => {
      let child: SandboxProcess;
      try {
        child = spawn("docker", args, {
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
          windowsHide: true,
          env: environment,
        });
      } catch {
        resolve("");
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      child.stdout?.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size <= 64 * 1024) chunks.push(chunk);
      });
      child.stderr?.resume();
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve("");
      }, CONTROL_TIMEOUT_MS);
      const done = () => {
        clearTimeout(timer);
        resolve(Buffer.concat(chunks).toString("utf8"));
      };
      child.on("error", done);
      child.on("close", done);
    });

  /**
   * The renderer the container would run must exist and, when running from
   * source, be at least as new as its sources. Logged once, content-free.
   */
  const assertRendererBuilt = async () => {
    let built: number;
    try {
      built = (await stat(path.join(appDist, RENDERER_ENTRY))).mtimeMs;
      if (
        options.sourceDirectory !== undefined &&
        (await stat(options.sourceDirectory).catch(() => null))?.isDirectory()
      ) {
        const sources = await newestSource(
          path.join(options.sourceDirectory, "publishing"),
        );
        if (sources > built) throw new Error("stale");
      }
    } catch {
      if (!rendererReported) {
        rendererReported = true;
        logger.error(
          "[media-sandbox] renderer build missing or stale: run `pnpm --filter @moya/backend-production build`",
        );
      }
      throw new MediaProcessingUnavailableError(null);
    }
  };

  /** Names of the sandbox containers that exist now (any state). */
  const listSandboxContainers = async (): Promise<string[]> =>
    (
      await control([
        "ps",
        "--all",
        "--filter",
        `name=^${SANDBOX_CONTAINER_PREFIX}`,
        "--format",
        "{{.Names}}",
      ])
    )
      .split("\n")
      .map((line) => line.trim())
      .filter((name) => CONTAINER_NAME_PATTERN.test(name));

  const run: SandboxRunner["run"] = async (job, request, runOptions) => {
    const root = activeJobs.get(job.id);
    if (
      root === undefined ||
      job.inputDirectory !== path.join(root, "in") ||
      job.outputDirectory !== path.join(root, "out") ||
      !Number.isSafeInteger(runOptions.timeoutMs) ||
      runOptions.timeoutMs < 1
    ) {
      throw new Error("Invalid media sandbox invocation");
    }
    const body = Buffer.from(JSON.stringify(request), "utf8");
    if (body.byteLength > SANDBOX_OUTPUT_LIMITS.jobFileBytes) {
      throw new MediaProcessingInputError();
    }
    if (runOptions.signal?.aborted) throw new MediaToolError("aborted");
    await assertRendererBuilt();
    await writeFile(path.join(job.inputDirectory, SANDBOX_JOB_FILE), body, {
      flag: "wx",
      mode: 0o644,
    });
    await chmod(path.join(job.inputDirectory, SANDBOX_JOB_FILE), 0o644);
    const now = new Date();
    await utimes(root, now, now);
    // An abort during the awaits above never fires the listener added after
    // the spawn: refuse here, and nothing asynchronous runs from this check
    // until that listener is in place.
    if (runOptions.signal?.aborted) throw new MediaToolError("aborted");
    const containerName = `${SANDBOX_CONTAINER_PREFIX}${randomBytes(12).toString("hex")}`;
    const args = buildSandboxRunArguments({
      image: options.image,
      containerName,
      inputDirectory: job.inputDirectory,
      appDist,
      timeoutMs: runOptions.timeoutMs,
    });
    let child: SandboxProcess;
    try {
      child = spawn("docker", args, {
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
        env: environment,
      });
    } catch {
      throw new MediaToolError("spawn_failed");
    }
    const decoder = new FrameDecoder(job.outputDirectory, request.nonce);
    let stopped: MediaToolFailure | "protocol" | null = null;
    let violation: SandboxViolation | null = null;
    let graceTimer: NodeJS.Timeout | undefined;
    const stop = (reason: MediaToolFailure | "protocol") => {
      if (stopped !== null) return;
      stopped = reason;
      void control(["kill", containerName]);
      graceTimer = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
    };
    const violate = (code: SandboxViolation) => {
      violation ??= code;
      stop("protocol");
    };
    const timer = setTimeout(() => stop("timeout"), runOptions.timeoutMs);
    const onAbort = () => stop("aborted");
    runOptions.signal?.addEventListener("abort", onAbort, { once: true });
    let stderrBytes = 0;
    child.stderr?.on("data", (chunk: Buffer) => {
      // Diagnostics are counted, never retained or logged.
      stderrBytes += chunk.byteLength;
      if (stderrBytes > SANDBOX_OUTPUT_LIMITS.stderrBytes) {
        violate("stderr_limit");
      }
    });
    let spawnFailed = false;
    const exited = new Promise<number | null>((resolve) => {
      child.on("error", () => {
        spawnFailed = true;
        resolve(null);
      });
      child.on("close", (code: number | null) => resolve(code));
    });
    const decoding = (async () => {
      const stdout = child.stdout;
      if (stdout === null) return;
      try {
        for await (const chunk of stdout) {
          if (stopped !== null) continue;
          await decoder.push(chunk as Buffer);
        }
      } catch (error) {
        violate(
          error instanceof SandboxProtocolError
            ? error.violation
            : "frame_invalid",
        );
        stdout.resume();
      } finally {
        await decoder.close();
      }
    })();
    const [code] = await Promise.all([exited, decoding]);
    clearTimeout(timer);
    clearTimeout(graceTimer);
    runOptions.signal?.removeEventListener("abort", onAbort);
    if (stopped !== null) {
      // A kill can race container creation: remove again after the grace.
      void control(["rm", "--force", containerName]);
      setTimeout(
        () => void control(["rm", "--force", containerName]),
        killGraceMs,
      ).unref();
    }
    if (stopped === "aborted") throw new MediaToolError("aborted");
    if (stopped === "timeout") throw new MediaToolError("timeout");
    if (violation !== null) throw new SandboxProtocolError(violation);
    if (spawnFailed) throw new MediaToolError("spawn_failed");
    if (code === 125 || code === 126 || code === 127) {
      if (!imageReported) {
        imageReported = true;
        logger.error(
          "[media-sandbox] sandbox unavailable: check the container daemon, build the media sandbox image (`pnpm dev:media-sandbox` in Development) and set WORK_MEDIA_TOOLS_IMAGE to the tag that script builds",
        );
      }
      throw new MediaToolError("sandbox_unavailable", code);
    }
    if (code === SANDBOX_EXIT_CODES.invalidJob) {
      throw new MediaProcessingInputError();
    }
    if (code === SANDBOX_EXIT_CODES.internal) {
      throw new MediaProcessingUnavailableError(null);
    }
    if (code !== 0 && decoder.manifest !== null) {
      throw new SandboxProtocolError("exit_after_manifest");
    }
    // A signal exit (an OOM kill, the in-container timeout, a decoder crash)
    // is deterministic for the input; any other status is the runtime's own
    // failure (for example a renderer that cannot load) and is retried.
    if (code === null || code >= 128) {
      throw new SandboxProtocolError("resource_exceeded");
    }
    if (code !== 0) throw new MediaProcessingUnavailableError(null);
    if (!decoder.complete || decoder.manifest === null) {
      throw new SandboxProtocolError("stream_incomplete");
    }
    return { manifest: decoder.manifest, files: decoder.files };
  };

  const createJob: SandboxRunner["createJob"] = async () => {
    const id = randomBytes(16).toString("hex");
    const root = path.join(workDirectory, `job-${id}`);
    const inputDirectory = path.join(root, "in");
    const outputDirectory = path.join(root, "out");
    await mkdir(root, { mode: 0o700 });
    activeJobs.set(id, root);
    try {
      await chmod(root, 0o700);
      await mkdir(inputDirectory, { mode: 0o755 });
      await chmod(inputDirectory, 0o755);
      await mkdir(outputDirectory, { mode: 0o700 });
      await chmod(outputDirectory, 0o700);
    } catch (error) {
      activeJobs.delete(id);
      await rm(root, { recursive: true, force: true });
      throw error;
    }
    return {
      id,
      inputDirectory,
      outputDirectory,
      inputPath: (name) => {
        if (typeof name !== "string" || !FILE_NAME_PATTERN.test(name)) {
          throw new Error("Invalid media sandbox job file name");
        }
        return path.join(inputDirectory, name);
      },
      dispose: async () => {
        await rm(root, { recursive: true, force: true });
        activeJobs.delete(id);
      },
    };
  };

  return {
    createJob,
    run,

    async selfCheck() {
      const job = await createJob();
      try {
        const request: SandboxJob = {
          protocol: SANDBOX_PROTOCOL_VERSION,
          nonce: sandboxNonce(),
          operation: "self-check",
          item: null,
          limits: SANDBOX_JOB_LIMITS,
        };
        let result: SandboxRunResult;
        try {
          result = await run(job, request, {
            timeoutMs: SANDBOX_TIMEOUTS_MS.selfCheck,
          });
        } catch (error) {
          if (error instanceof SandboxProtocolError) {
            return {
              status: "mismatch",
              mismatches: [error.violation],
              runtime: null,
              facts: null,
            };
          }
          if (error instanceof MediaToolError) {
            return { status: "unavailable", reason: error.code };
          }
          // A refused job, a missing or stale renderer or a renderer that
          // fails is a release or image problem, not a transient one.
          return {
            status: "mismatch",
            mismatches: [
              error instanceof MediaProcessingInputError
                ? "job_refused"
                : "renderer_unavailable",
            ],
            runtime: null,
            facts: null,
          };
        }
        const { manifest } = result;
        const facts = manifest.selfCheck;
        if (manifest.status !== "self-check" || facts === null) {
          return {
            status: "mismatch",
            mismatches: ["status"],
            runtime: manifest.runtime,
            facts: null,
          };
        }
        const mismatches = isolationMismatches(facts);
        return mismatches.length === 0
          ? { status: "ok", runtime: manifest.runtime, facts }
          : {
              status: "mismatch",
              mismatches,
              runtime: manifest.runtime,
              facts,
            };
      } finally {
        await job.dispose().catch(() => undefined);
      }
    },

    async boundsCheck() {
      const probes: SandboxBoundsProbeResult[] = [];
      for (const probe of SANDBOX_BOUNDS_PROBES) {
        const job = await createJob();
        const started = Date.now();
        let outcome:
          | { readonly facts: SandboxBoundsFacts | null }
          | { readonly error: unknown };
        try {
          const result = await run(
            job,
            {
              protocol: SANDBOX_PROTOCOL_VERSION,
              nonce: sandboxNonce(),
              operation: "bounds",
              probe,
              item: null,
              limits: SANDBOX_JOB_LIMITS,
            },
            { timeoutMs: BOUNDS_PROBE_TIMEOUTS_MS[probe] },
          );
          outcome = { facts: result.manifest.bounds ?? null };
        } catch (error) {
          outcome = { error };
        } finally {
          await job.dispose().catch(() => undefined);
        }
        if (
          "error" in outcome &&
          outcome.error instanceof MediaToolError &&
          (outcome.error.code === "sandbox_unavailable" ||
            outcome.error.code === "spawn_failed")
        )
          return { status: "unavailable", reason: outcome.error.code };
        const elapsedMs = Date.now() - started;
        probes.push({
          probe,
          ...judgeBoundsProbe(probe, outcome, elapsedMs, killGraceMs),
          elapsedMs,
        });
      }
      // Killed containers are removed twice, the second time after the
      // grace: none may remain once it has passed.
      await new Promise((resolve) => setTimeout(resolve, killGraceMs + 1_000));
      const leftoverContainers = (await listSandboxContainers()).length;
      return {
        status:
          leftoverContainers === 0 && probes.every((entry) => entry.passed)
            ? "ok"
            : "failed",
        probes,
        leftoverContainers,
      };
    },

    async removeOrphanContainers() {
      const names = (await listSandboxContainers()).slice(0, MAX_ORPHANS);
      for (const name of names) await control(["rm", "--force", name]);
      return { removed: names.length };
    },

    async sweepJobs(olderThan) {
      const cutoff = olderThan.getTime();
      if (!Number.isFinite(cutoff)) throw new Error("Invalid sweep cutoff");
      const active = new Set(activeJobs.keys());
      let removed = 0;
      for (const name of await readdir(workDirectory)) {
        if (!JOB_NAME_PATTERN.test(name) || active.has(name.slice(4))) continue;
        const entry = path.join(workDirectory, name);
        const info = await lstat(entry).catch(() => null);
        if (!info?.isDirectory() || info.mtimeMs >= cutoff) continue;
        await rm(entry, { recursive: true, force: true });
        removed += 1;
      }
      return { removed };
    },
  };
}
