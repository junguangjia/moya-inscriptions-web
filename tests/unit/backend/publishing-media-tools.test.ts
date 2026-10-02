import { EventEmitter } from "node:events";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { crc32, deflateSync } from "node:zlib";

import { cosFixture } from "./publishing-cos-fixture.js";

import { FilesystemPublishingMediaStore } from "@moya/backend-production/internal/publishing-media-store";
import {
  MOTION_DERIVATIVE,
  MediaProcessingInputError,
  MediaProcessingUnavailableError,
  MediaRejectedError,
  MediaToolError,
  contentIdentifierSha256,
  createMediaToolsRunner,
  createPublishingMediaProcessor,
  ffmpegColorFilters,
  ffmpegEditFilters,
  ffmpegMotionArguments,
  ffprobeJson,
  heifDecodeToPng,
  inspectStaticSource,
  isEditKey,
  isIdentityEdit,
  parseEdit,
  pixelRegion,
  renderStaticDerivative,
  staticDerivativeSize,
  staticEditRegion,
  validateMotionProbe,
} from "@moya/backend-production/internal/publishing-processing";
import {
  mediaFailureCodeSchema,
  mediaPresentationSchema,
} from "@moya/contracts/schemas";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  PublishingMediaFailureCode,
  PublishingMediaProcessorPort,
  PublishingProcessInput,
  PublishingProcessOutcome,
} from "@moya/api";
import type {
  MediaFailureCode,
  ProcessorInput,
  MediaToolProcess,
  MediaToolSpawn,
  MediaToolSpawnOptions,
  MediaToolsRunner,
  MotionColor,
} from "@moya/backend-production/internal/publishing-processing";
import type { MediaFailureCode as ContractMediaFailureCode } from "@moya/contracts";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
// Processor, port and contracts failure codes are one list (type-level).
const failureCodesMatchContracts: Same<
  MediaFailureCode,
  ContractMediaFailureCode
> &
  Same<PublishingMediaFailureCode, ContractMediaFailureCode> = true;

const IMAGE = "yoyi-work-publishing-media-tools:v1";
let base: string;
let work: string;
let storeRoot: string;

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "publishing-tools-"));
  work = path.join(base, "work");
  storeRoot = path.join(base, "store");
  for (const directory of [work, storeRoot]) {
    await mkdir(directory, { mode: 0o700 });
    await chmod(directory, 0o700);
  }
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Injected stand-in for `child_process.spawn`; Docker is never required. */
class FakeProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: string[] = [];
  onKill: ((signal: string) => void) | null = null;

  kill(signal: NodeJS.Signals = "SIGTERM") {
    this.signals.push(signal);
    this.onKill?.(signal);
    return true;
  }

  exit(code: number | null) {
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit("close", code, null));
  }
}

interface SpawnCall {
  readonly command: string;
  readonly args: string[];
  readonly options: MediaToolSpawnOptions;
  readonly process: FakeProcess;
}

interface RunView {
  readonly tool: string;
  readonly toolArgs: string[];
  readonly containerName: string;
  readonly inputDirectory: string;
  /** This run's writable mount, or null when it has none. */
  readonly outputDirectory: string | null;
  readonly process: FakeProcess;
}

const mountSource = (args: readonly string[], target: string) => {
  const mount = args.find(
    (arg) => arg.startsWith("type=bind,") && arg.includes(`,target=${target}`),
  );
  return mount
    ? mount.slice("type=bind,source=".length, mount.indexOf(",target="))
    : null;
};

const fakeDocker = (
  onRun: (run: RunView) => void,
  options: { ignoreKill?: boolean; throwOnSpawn?: boolean } = {},
) => {
  const calls: SpawnCall[] = [];
  const running = new Map<string, FakeProcess>();
  const spawn: MediaToolSpawn = (command, args, spawnOptions) => {
    if (options.throwOnSpawn) throw new Error("spawn EACCES");
    const child = new FakeProcess();
    calls.push({ command, args, options: spawnOptions, process: child });
    setImmediate(() => {
      if (args[0] === "run") {
        const name = args[args.indexOf("--name") + 1]!;
        const imageIndex = args.indexOf(IMAGE);
        running.set(name, child);
        onRun({
          tool: args[imageIndex + 3]!,
          toolArgs: args.slice(imageIndex + 4),
          containerName: name,
          inputDirectory: mountSource(args, "/job/in")!,
          outputDirectory: mountSource(args, "/job/out"),
          process: child,
        });
      } else if (args[0] === "kill") {
        const target = running.get(args[1]!);
        if (target && !options.ignoreKill) target.exit(137);
        child.exit(0);
      } else {
        child.exit(0);
      }
    });
    return child as unknown as MediaToolProcess;
  };
  return { spawn, calls };
};

const runner = (
  spawn: MediaToolSpawn,
  extra: {
    killGraceMs?: number;
    environment?: Readonly<Record<string, string>>;
  } = {},
) =>
  createMediaToolsRunner({
    image: IMAGE,
    workDirectory: work,
    spawn,
    temporaryRoots: [],
    environment: extra.environment ?? { PATH: "/usr/bin" },
    ...(extra.killGraceMs === undefined
      ? {}
      : { killGraceMs: extra.killGraceMs }),
  });

const toolFailure = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(MediaToolError);
    return [(error as MediaToolError).code, (error as MediaToolError).exitCode];
  }
  throw new Error("expected a tool failure");
};

const rejection = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(MediaRejectedError);
    return (error as MediaRejectedError).failureCode;
  }
  throw new Error("expected a rejection");
};

describe("publishing media tools runner", () => {
  it("validates the image reference and the work directory", async () => {
    const { spawn } = fakeDocker(() => undefined);
    for (const image of ["--privileged", "Bad Image", "evil;rm", ""]) {
      await expect(
        createMediaToolsRunner({
          image,
          workDirectory: work,
          spawn,
          temporaryRoots: [],
        }),
      ).rejects.toThrow("image reference");
    }
    await expect(
      createMediaToolsRunner({
        image: IMAGE,
        workDirectory: work,
        spawn,
        temporaryRoots: [base],
      }),
    ).rejects.toThrow("temporary storage");
    await chmod(work, 0o755);
    await expect(
      createMediaToolsRunner({
        image: IMAGE,
        workDirectory: work,
        spawn,
        temporaryRoots: [],
      }),
    ).rejects.toThrow("owner-only");
  });

  it("creates a private job directory with a read-only, host-written input", async () => {
    const tools = await runner(fakeDocker(() => undefined).spawn);
    const job = await tools.createJob();
    const root = path.dirname(job.inputDirectory);
    expect(path.dirname(root)).toBe(await realpath(work));
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(job.inputDirectory)).mode & 0o777).toBe(0o755);
    expect(await readdir(root)).toEqual(["in"]);
    expect(() => job.inputPath("../escape")).toThrow("file name");
    expect(() => job.inputPath("a/b")).toThrow("file name");
    await job.dispose();
    await expect(lstat(root)).rejects.toThrow();
  });

  it("spawns docker with an argument array, exact sandbox flags, a fresh output mount and a filtered environment", async () => {
    const { spawn, calls } = fakeDocker(async (run) => {
      await writeFile(path.join(run.outputDirectory!, "still.png"), "png");
      run.process.exit(0);
    });
    const tools = await runner(spawn, {
      environment: {
        PATH: "/usr/bin",
        HOME: "/home/media",
        DOCKER_HOST: "unix:///run/docker.sock",
        APP_DATABASE_URL: "postgres://synthetic-secret",
        COS_SECRET_KEY: "synthetic-secret",
      },
    });
    const job = await tools.createJob();
    const output = await heifDecodeToPng(tools, job, "still");
    expect(output).toEqual({ path: job.inputPath("still.png"), byteSize: 3 });
    expect(await readFile(output.path, "utf8")).toBe("png");
    expect(calls).toHaveLength(1);
    const [call] = calls;
    const name = call!.args[call!.args.indexOf("--name") + 1]!;
    expect(name).toMatch(/^yoyi-wp-media-[0-9a-f]{24}$/);
    const outputDirectory = mountSource(call!.args, "/job/out")!;
    expect(path.dirname(outputDirectory)).toBe(
      path.dirname(job.inputDirectory),
    );
    expect(path.basename(outputDirectory)).toMatch(/^out-[0-9a-f]{16}$/);
    // The run's output directory is gone once its file was accepted.
    await expect(lstat(outputDirectory)).rejects.toThrow();
    expect(call!.command).toBe("docker");
    expect(call!.args).toEqual([
      "run",
      "--rm",
      "--pull",
      "never",
      "--name",
      name,
      "--network",
      "none",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,size=512m",
      "--memory",
      "1536m",
      "--cpus",
      "2",
      "--pids-limit",
      "256",
      "--security-opt",
      "no-new-privileges",
      "--cap-drop",
      "ALL",
      "--user",
      "10001:10001",
      "--mount",
      `type=bind,source=${job.inputDirectory},target=/job/in,readonly`,
      "--mount",
      `type=bind,source=${outputDirectory},target=/job/out`,
      "--workdir",
      "/tmp",
      "--entrypoint",
      "/usr/bin/timeout",
      IMAGE,
      "--signal=KILL",
      "70s",
      "heif-dec",
      "--quiet",
      "/job/in/still",
      "/job/out/still.png",
    ]);
    expect(call!.options).toEqual({
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      env: {
        PATH: "/usr/bin",
        HOME: "/home/media",
        DOCKER_HOST: "unix:///run/docker.sock",
      },
    });
  });

  it("refuses multi-image, symlinked and non-file tool output", async () => {
    const cases: ((directory: string) => Promise<void>)[] = [
      async (directory) => {
        await writeFile(path.join(directory, "still-1.png"), "a");
        await writeFile(path.join(directory, "still-2.png"), "b");
      },
      async (directory) => {
        await writeFile(path.join(directory, "still.png"), "a");
        await writeFile(path.join(directory, "still.png-depth.png"), "b");
      },
      (directory) => symlink("/etc/hosts", path.join(directory, "still.png")),
      (directory) => mkdir(path.join(directory, "still.png")),
      (directory) => writeFile(path.join(directory, "still.png"), ""),
    ];
    for (const produce of cases) {
      const tools = await runner(
        fakeDocker(async (run) => {
          await produce(run.outputDirectory!);
          run.process.exit(0);
        }).spawn,
      );
      const job = await tools.createJob();
      expect(
        await toolFailure(() => heifDecodeToPng(tools, job, "still")),
      ).toEqual(["tool_failed", null]);
      expect(await readdir(job.inputDirectory)).toEqual([]);
    }
  });

  it("never mounts a writable directory into a later container", async () => {
    const mounts: { tool: string; output: string | null }[] = [];
    const { spawn } = fakeDocker(async (run) => {
      mounts.push({ tool: run.tool, output: run.outputDirectory });
      if (run.tool === "heif-dec") {
        const name = path.basename(run.toolArgs.at(-1)!);
        await writeFile(path.join(run.outputDirectory!, name), "decoded");
      } else {
        run.process.stdout.write("{}");
      }
      run.process.exit(0);
    });
    const tools = await runner(spawn);
    const job = await tools.createJob();
    const decoded = await heifDecodeToPng(tools, job, "still");
    expect(await ffprobeJson(tools, job, "still.png")).toEqual({});
    await heifDecodeToPng(tools, job, "motion");
    expect(mounts.map((mount) => mount.tool)).toEqual([
      "heif-dec",
      "ffprobe",
      "heif-dec",
    ]);
    expect(mounts[1]!.output).toBeNull();
    expect(mounts[0]!.output).not.toBe(mounts[2]!.output);
    expect(path.dirname(decoded.path)).toBe(job.inputDirectory);
    expect(await readFile(decoded.path, "utf8")).toBe("decoded");
    expect((await lstat(decoded.path)).isFile()).toBe(true);
    expect(await readdir(path.dirname(job.inputDirectory))).toEqual(["in"]);
  });

  it("runs ffprobe with the pinned demuxer on a job input without a writable mount", async () => {
    const { spawn, calls } = fakeDocker((run) => {
      run.process.stdout.write(JSON.stringify({ streams: [], format: {} }));
      run.process.exit(0);
    });
    const tools = await runner(spawn);
    const job = await tools.createJob();
    expect(await ffprobeJson(tools, job, "motion")).toEqual({
      streams: [],
      format: {},
    });
    expect(mountSource(calls[0]!.args, "/job/out")).toBeNull();
    expect(calls[0]!.args.slice(calls[0]!.args.indexOf(IMAGE) - 2)).toEqual([
      "--entrypoint",
      "/usr/bin/timeout",
      IMAGE,
      "--signal=KILL",
      "30s",
      "ffprobe",
      "-v",
      "error",
      "-f",
      "mov",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      "/job/in/motion",
    ]);
  });

  it("kills the container by name when stdout exceeds its cap and removes it twice", async () => {
    const { spawn, calls } = fakeDocker((run) => {
      run.process.stdout.write(Buffer.alloc(1024 * 1024 + 1, 0x7b));
    });
    const tools = await runner(spawn, { killGraceMs: 10 });
    const job = await tools.createJob();
    expect(await toolFailure(() => ffprobeJson(tools, job, "motion"))).toEqual([
      "output_limit",
      137,
    ]);
    const name = calls[0]!.args[calls[0]!.args.indexOf("--name") + 1]!;
    await sleep(60);
    expect(calls.slice(1).map((call) => call.args)).toEqual([
      ["kill", name],
      ["rm", "--force", name],
      ["rm", "--force", name],
    ]);
  });

  it("enforces the hard timeout by killing the container, then the CLI after a grace period", async () => {
    const hanging = fakeDocker(() => undefined);
    const tools = await runner(hanging.spawn, { killGraceMs: 10 });
    const job = await tools.createJob();
    const started = Date.now();
    expect(
      await toolFailure(() =>
        tools.run(job, "ffmpeg", ["-version"], { timeoutMs: 20 }),
      ),
    ).toEqual(["timeout", 137]);
    expect(Date.now() - started).toBeLessThan(2000);
    const name =
      hanging.calls[0]!.args[hanging.calls[0]!.args.indexOf("--name") + 1]!;
    // The container carries its own backstop: host limit + 10 s grace.
    expect(hanging.calls[0]!.args.slice(-4)).toEqual([
      "--signal=KILL",
      "11s",
      "ffmpeg",
      "-version",
    ]);
    await sleep(60);
    expect(hanging.calls.slice(1).map((call) => call.args)).toEqual([
      ["kill", name],
      ["rm", "--force", name],
      ["rm", "--force", name],
    ]);

    const stubborn = fakeDocker(
      (run) => {
        run.process.onKill = () => run.process.exit(null);
      },
      { ignoreKill: true },
    );
    const graceful = await runner(stubborn.spawn, { killGraceMs: 10 });
    const second = await graceful.createJob();
    expect(
      await toolFailure(() =>
        graceful.run(second, "ffmpeg", ["-version"], { timeoutMs: 10 }),
      ),
    ).toEqual(["timeout", null]);
    expect(stubborn.calls[0]!.process.signals).toEqual(["SIGKILL"]);
  });

  it("classifies exit codes, spawn failures and aborts", async () => {
    const exitWith = (code: number) =>
      runner(fakeDocker((run) => run.process.exit(code)).spawn);
    for (const [code, failure] of [
      [1, "tool_failed"],
      [137, "tool_failed"],
      [125, "sandbox_unavailable"],
      [127, "sandbox_unavailable"],
    ] as const) {
      const tools = await exitWith(code);
      expect(
        await toolFailure(async () =>
          tools.run(await tools.createJob(), "ffprobe", [], {
            timeoutMs: 1000,
          }),
        ),
      ).toEqual([failure, code]);
    }
    const throwing = await runner(
      fakeDocker(() => undefined, { throwOnSpawn: true }).spawn,
    );
    expect(
      await toolFailure(async () =>
        throwing.run(await throwing.createJob(), "ffprobe", [], {
          timeoutMs: 1000,
        }),
      ),
    ).toEqual(["spawn_failed", null]);
    const erroring = await runner(
      fakeDocker((run) => run.process.emit("error", new Error("ENOENT"))).spawn,
    );
    expect(
      await toolFailure(async () =>
        erroring.run(await erroring.createJob(), "ffprobe", [], {
          timeoutMs: 1000,
        }),
      ),
    ).toEqual(["spawn_failed", null]);
    const controller = new AbortController();
    const aborting = await runner(fakeDocker(() => controller.abort()).spawn);
    expect(
      await toolFailure(async () =>
        aborting.run(await aborting.createJob(), "ffmpeg", [], {
          timeoutMs: 5000,
          signal: controller.signal,
        }),
      ),
    ).toEqual(["aborted", 137]);
  });

  it("rejects unknown tools, unsafe arguments and foreign or disposed jobs without spawning", async () => {
    const { spawn, calls } = fakeDocker(() => undefined);
    const tools = await runner(spawn);
    const job = await tools.createJob();
    const other = await (await runner(spawn)).createJob();
    const bad = [
      () => tools.run(job, "sh" as "ffmpeg", ["-c", "id"], { timeoutMs: 1000 }),
      () => tools.run(job, "ffmpeg", ["a\0b"], { timeoutMs: 1000 }),
      () => tools.run(job, "ffmpeg", [], { timeoutMs: 0 }),
      () =>
        tools.run(
          { ...job, inputDirectory: "/elsewhere/job-x/in" },
          "ffmpeg",
          [],
          { timeoutMs: 1000 },
        ),
      () => tools.run(other, "ffmpeg", [], { timeoutMs: 1000 }),
    ];
    for (const run of bad)
      await expect(run()).rejects.toThrow("Invalid media tool invocation");
    await job.dispose();
    await expect(
      tools.run(job, "ffmpeg", [], { timeoutMs: 1000 }),
    ).rejects.toThrow("Invalid media tool invocation");
    expect(calls).toEqual([]);
  });

  it("sweeps stale leftover job directories but never an active job, and runs touch their job", async () => {
    const tools = await runner(fakeDocker((run) => run.process.exit(0)).spawn);
    const active = await tools.createJob();
    const activeRoot = path.dirname(active.inputDirectory);
    const leftover = path.join(work, `job-${"c".repeat(32)}`);
    const freshLeftover = path.join(work, `job-${"d".repeat(32)}`);
    await mkdir(leftover);
    await mkdir(freshLeftover);
    await writeFile(path.join(work, "keep.txt"), "x");
    const old = new Date(Date.now() - 3 * 3600_000);
    await utimes(leftover, old, old);
    await utimes(activeRoot, old, old);
    expect(await tools.sweepJobs(new Date(Date.now() - 3600_000))).toEqual({
      removed: 1,
    });
    expect((await readdir(work)).sort()).toEqual(
      [
        path.basename(activeRoot),
        path.basename(freshLeftover),
        "keep.txt",
      ].sort(),
    );
    await tools.run(active, "ffprobe", [], { timeoutMs: 1000 });
    expect((await stat(activeRoot)).mtimeMs).toBeGreaterThan(
      Date.now() - 60_000,
    );
  });
});

const SDR_709: MotionColor = {
  primaries: "bt709",
  transfer: "bt709",
  matrix: "bt709",
  range: "tv",
  dynamicRange: "sdr",
  pixelFormat: "yuv420p",
};

describe("publishing motion derivative arguments", () => {
  it("bakes rotation, crops in exact pixels, strips metadata and tags BT.709", () => {
    const args = ffmpegMotionArguments(
      "motion",
      "motion-output.mp4",
      { rotation: 90, crop: { x: 0.1, y: 0.2, width: 0.5, height: 0.25 } },
      { width: 1440, height: 1920, color: SDR_709 },
    );
    expect(args).toEqual([
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-n",
      "-f",
      "mov",
      "-i",
      "/job/in/motion",
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
      "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv,transpose=clock,crop=w=960:h=360:x=192:y=288:exact=1,scale=w=min(1920\\,iw):h=min(1920\\,ih):force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p",
      "-c:v",
      "libx264",
      "-profile:v",
      "high",
      "-preset",
      "veryfast",
      "-crf",
      "21",
      "-pix_fmt",
      "yuv420p",
      "-color_primaries",
      "bt709",
      "-color_trc",
      "bt709",
      "-colorspace",
      "bt709",
      "-color_range",
      "tv",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      "-f",
      "mp4",
      "/job/out/motion-output.mp4",
    ]);
    expect(args).not.toContain("-noautorotate");
    expect(MOTION_DERIVATIVE.maxLongEdge).toBe(1920);
  });

  it("tone-maps HLG and PQ, converts other SDR colour spaces and passes BT.709 8-bit through", () => {
    const hdrTail = [
      "zscale=transfer=linear:npl=100",
      "format=gbrpf32le",
      "zscale=primaries=709",
      "tonemap=tonemap=hable:desat=0",
      "zscale=transfer=709:matrix=709:range=tv",
      "format=yuv420p",
    ];
    expect(
      ffmpegColorFilters({
        primaries: "bt2020",
        transfer: "arib-std-b67",
        matrix: "bt2020nc",
        range: "tv",
        dynamicRange: "hlg",
        pixelFormat: "yuv420p10le",
      }),
    ).toEqual({
      head: [
        "setparams=color_primaries=bt2020:color_trc=arib-std-b67:colorspace=bt2020nc:range=tv",
      ],
      tail: hdrTail,
    });
    expect(
      ffmpegColorFilters({
        ...SDR_709,
        primaries: "bt2020",
        transfer: "smpte2084",
        matrix: "bt2020nc",
        dynamicRange: "pq",
      }).tail,
    ).toEqual(hdrTail);
    const converted = [
      "zscale=primaries=709:transfer=709:matrix=709:range=tv",
      "format=yuv420p",
    ];
    expect(
      ffmpegColorFilters({
        ...SDR_709,
        primaries: "smpte170m",
        transfer: "smpte170m",
        matrix: "smpte170m",
      }).tail,
    ).toEqual(converted);
    expect(
      ffmpegColorFilters({ ...SDR_709, pixelFormat: "yuv420p10le" }).tail,
    ).toEqual(converted);
    expect(ffmpegColorFilters({ ...SDR_709, range: "pc" }).tail).toEqual(
      converted,
    );
    expect(ffmpegColorFilters(SDR_709).tail).toEqual(["format=yuv420p"]);
  });
});

const videoStream = (extra: Record<string, unknown> = {}) => ({
  codec_type: "video",
  codec_name: "hevc",
  width: 1920,
  height: 1440,
  duration: "2.900000",
  pix_fmt: "yuv420p",
  ...extra,
});
const probe = (
  streams: unknown[],
  format: Record<string, unknown> = { duration: "2.900000" },
) => ({
  streams,
  format,
});

describe("publishing motion probe validation", () => {
  it("accepts one video, one audio and metadata data streams, reporting clockwise rotation and colour", () => {
    expect(
      validateMotionProbe(
        probe([
          videoStream({
            side_data_list: [
              { side_data_type: "Display Matrix", rotation: -90 },
            ],
          }),
          { codec_type: "audio", codec_name: "aac" },
          { codec_type: "data" },
          { codec_type: "data" },
        ]),
      ),
    ).toEqual({
      durationMs: 2900,
      codedWidth: 1920,
      codedHeight: 1440,
      width: 1440,
      height: 1920,
      rotation: 90,
      hasAudio: true,
      videoCodec: "hevc",
      audioCodec: "aac",
      colorTags: { primaries: null, transfer: null, matrix: null, range: null },
      color: SDR_709,
    });
    expect(
      validateMotionProbe(
        probe([videoStream({ side_data_list: [{ rotation: 90 }] })]),
      ).rotation,
    ).toBe(270);
    expect(
      validateMotionProbe(probe([videoStream({ tags: { rotate: "180" } })]))
        .rotation,
    ).toBe(180);
    expect(validateMotionProbe(probe([videoStream()], {})).durationMs).toBe(
      2900,
    );
    const hdr = (transfer: string) =>
      validateMotionProbe(
        probe([
          videoStream({
            color_primaries: "bt2020",
            color_transfer: transfer,
            color_space: "bt2020nc",
            color_range: "tv",
            pix_fmt: "yuv420p10le",
          }),
        ]),
      ).color;
    expect(hdr("arib-std-b67")).toEqual({
      primaries: "bt2020",
      transfer: "arib-std-b67",
      matrix: "bt2020nc",
      range: "tv",
      dynamicRange: "hlg",
      pixelFormat: "yuv420p10le",
    });
    expect(hdr("smpte2084").dynamicRange).toBe("pq");
    expect(hdr("bt2020-10").dynamicRange).toBe("sdr");
    expect(
      validateMotionProbe(
        probe([videoStream({ color_primaries: "unknown", color_range: "pc" })]),
      ).color,
    ).toEqual({ ...SDR_709, range: "pc" });
  });

  it.each([
    [
      "two video streams",
      probe([videoStream(), videoStream()]),
      "stream_layout_unsupported",
    ],
    [
      "no video stream",
      probe([{ codec_type: "audio" }]),
      "stream_layout_unsupported",
    ],
    [
      "two audio streams",
      probe([videoStream(), { codec_type: "audio" }, { codec_type: "audio" }]),
      "stream_layout_unsupported",
    ],
    [
      "a subtitle stream",
      probe([videoStream(), { codec_type: "subtitle" }]),
      "stream_layout_unsupported",
    ],
    [
      "too many data streams",
      probe([
        videoStream(),
        ...Array.from({ length: 9 }, () => ({ codec_type: "data" })),
      ]),
      "stream_layout_unsupported",
    ],
    [
      "a duration over 30 s",
      probe([videoStream()], { duration: "30.001" }),
      "duration_exceeded",
    ],
    [
      "a missing duration",
      probe([videoStream({ duration: undefined })], {}),
      "decode_failed",
    ],
    [
      "a non-numeric duration",
      probe([videoStream({ duration: "NaN" })], { duration: "1e3" }),
      "decode_failed",
    ],
    [
      "an oversized dimension",
      probe([videoStream({ width: 8193 })]),
      "dimensions_exceeded",
    ],
    [
      "missing dimensions",
      probe([videoStream({ height: undefined })]),
      "decode_failed",
    ],
    [
      "a non-right-angle rotation",
      probe([videoStream({ side_data_list: [{ rotation: 45 }] })]),
      "stream_layout_unsupported",
    ],
    [
      "unlisted primaries",
      probe([videoStream({ color_primaries: "film" })]),
      "stream_layout_unsupported",
    ],
    [
      "an unlisted transfer",
      probe([videoStream({ color_transfer: "log100" })]),
      "stream_layout_unsupported",
    ],
    [
      "a constant-luminance matrix",
      probe([videoStream({ color_space: "bt2020c" })]),
      "stream_layout_unsupported",
    ],
    [
      "a malformed codec name",
      probe([videoStream({ codec_name: "Not A Name!" })]),
      "stream_layout_unsupported",
    ],
    ["a non-object document", "[]", "decode_failed"],
  ])("rejects %s", async (_name, json, code) => {
    expect(await rejection(async () => validateMotionProbe(json))).toBe(code);
  });
});

describe("publishing edits", () => {
  it("validates edits strictly as processing input", () => {
    expect(
      parseEdit({ rotation: 270, crop: { x: 0, y: 0, width: 1, height: 1 } }),
    ).toEqual({
      rotation: 270,
      crop: { x: 0, y: 0, width: 1, height: 1 },
    });
    for (const edit of [
      { rotation: 45, crop: null },
      { rotation: 90 },
      { rotation: 0, crop: null, filter: "sepia" },
      { rotation: 0, crop: { x: 0.6, y: 0, width: 0.5, height: 1 } },
      { rotation: 0, crop: { x: -0.1, y: 0, width: 0.5, height: 1 } },
      { rotation: 0, crop: { x: 0, y: 0, width: 0, height: 1 } },
      { rotation: 0, crop: { x: 0, y: 0, width: Number.NaN, height: 1 } },
      null,
    ]) {
      expect(() => parseEdit(edit)).toThrow(MediaProcessingInputError);
    }
    expect(isIdentityEdit({ rotation: 0, crop: null })).toBe(true);
    expect(
      isIdentityEdit({
        rotation: 0,
        crop: { x: 0, y: 0, width: 1, height: 1 },
      }),
    ).toBe(false);
    expect(isEditKey("base")).toBe(true);
    expect(isEditKey("a".repeat(32))).toBe(true);
    expect(isEditKey("A".repeat(32))).toBe(false);
  });

  it("maps normalized crops to bounded pixel regions and composes cover crops", () => {
    expect(
      pixelRegion({ x: 0.1, y: 0.2, width: 0.5, height: 0.5 }, 1000, 500),
    ).toEqual({
      left: 100,
      top: 100,
      width: 500,
      height: 250,
    });
    expect(
      pixelRegion(
        { x: 0.9999, y: 0.9999, width: 0.0001, height: 0.0001 },
        10,
        10,
      ),
    ).toEqual({
      left: 9,
      top: 9,
      width: 1,
      height: 1,
    });
    expect(
      staticEditRegion(
        { width: 2000, height: 1000 },
        { rotation: 90, crop: { x: 0, y: 0.5, width: 1, height: 0.5 } },
        { x: 0.5, y: 0, width: 0.5, height: 1 },
      ),
    ).toEqual({
      frame: { width: 1000, height: 2000 },
      region: { left: 500, top: 1000, width: 500, height: 1000 },
    });
    expect(
      ffmpegEditFilters(
        { rotation: 180, crop: null },
        { width: 1920, height: 1080 },
        1920,
      ),
    ).toEqual([
      "hflip",
      "vflip",
      "scale=w=min(1920\\,iw):h=min(1920\\,ih):force_original_aspect_ratio=decrease:force_divisible_by=2",
    ]);
  });

  it("crops still and motion frames with the same pixel rounding (L10)", () => {
    const crop = {
      x: 0.1234567,
      y: 0.3333333,
      width: 0.4567891,
      height: 0.3333333,
    };
    for (const [width, height] of [
      [1920, 1080],
      [1441, 1921],
      [1000, 999],
    ] as const) {
      const still = staticEditRegion(
        { width, height },
        { rotation: 0, crop },
        null,
      ).region;
      expect(still).toEqual(pixelRegion(crop, width, height));
      expect(
        ffmpegEditFilters({ rotation: 0, crop }, { width, height }, 8192)[0],
      ).toBe(
        `crop=w=${still.width}:h=${still.height}:x=${still.left}:y=${still.top}:exact=1`,
      );
    }
    const rotatedStill = staticEditRegion(
      { width: 1440, height: 1920 },
      { rotation: 270, crop },
      null,
    ).region;
    expect(
      ffmpegEditFilters(
        { rotation: 270, crop },
        { width: 1440, height: 1920 },
        1920,
      )[1],
    ).toBe(
      `crop=w=${rotatedStill.width}:h=${rotatedStill.height}:x=${rotatedStill.left}:y=${rotatedStill.top}:exact=1`,
    );
    // A degenerate crop grows to the 2×2 an encoder needs, inside the frame.
    expect(
      ffmpegEditFilters(
        { rotation: 0, crop: { x: 0.9999, y: 0, width: 0.0001, height: 1 } },
        { width: 100, height: 100 },
        1920,
      )[0],
    ).toBe("crop=w=2:h=100:x=98:y=0:exact=1");
  });

  it("sizes derivatives without upscaling and keeps long scrolls legible", () => {
    expect(staticDerivativeSize("thumb", 4032, 3024)).toEqual({
      width: 480,
      height: 360,
    });
    expect(staticDerivativeSize("display", 800, 600)).toEqual({
      width: 800,
      height: 600,
    });
    expect(staticDerivativeSize("full", 12000, 9000)).toEqual({
      width: 8192,
      height: 6144,
    });
    expect(staticDerivativeSize("full", 1200, 16000)).toEqual({
      width: 1200,
      height: 16000,
    });
    expect(staticDerivativeSize("full", 4000, 20000)).toEqual({
      width: 2828,
      height: 14142,
    });
    expect(staticDerivativeSize("cover", 1200, 16000)).toEqual({
      width: 81,
      height: 1080,
    });
    expect(staticDerivativeSize("full", 6000, 16000)).toEqual({
      width: 3873,
      height: 10328,
    });
    expect(staticDerivativeSize("display", 1200, 16000)).toEqual({
      width: 1200,
      height: 16000,
    });
    expect(staticDerivativeSize("display", 2000, 16000)).toEqual({
      width: 1280,
      height: 10240,
    });
    expect(staticDerivativeSize("display", 16000, 2000)).toEqual({
      width: 10240,
      height: 1280,
    });
    // Aspect 2.33 is not a long scroll: the ordinary 2048 long edge applies.
    expect(staticDerivativeSize("display", 3000, 7000)).toEqual({
      width: 878,
      height: 2048,
    });
  });
});

const RED = { r: 255, g: 0, b: 0 };
const BLUE = { r: 0, g: 0, b: 255 };

/** 300×200 JPEG (left half red, right half blue) displayed with EXIF orientation 6. */
const orientedJpeg = async () => {
  const red = await sharp({
    create: { width: 150, height: 200, channels: 3, background: RED },
  })
    .png()
    .toBuffer();
  return sharp({
    create: { width: 300, height: 200, channels: 3, background: BLUE },
  })
    .composite([{ input: red, left: 0, top: 0 }])
    .jpeg({ quality: 95 })
    .withExif({ IFD0: { Copyright: "synthetic-private-marker" } })
    .withMetadata({ orientation: 6 })
    .toBuffer();
};

const centerPixel = async (image: Buffer) => {
  const { data, info } = await sharp(image)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const offset =
    (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) *
    info.channels;
  return [data[offset]!, data[offset + 1]!, data[offset + 2]!];
};

const pngChunk = (type: string, data: Buffer) => {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};

const pngFile = (
  width: number,
  height: number,
  beforeImageData: Buffer[] = [],
) => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    ...beforeImageData,
    pngChunk("IDAT", deflateSync(Buffer.alloc(64))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
};

describe("publishing static processor", () => {
  it("orients, rotates, then crops and strips metadata from WebP derivatives; card variants use the cover crop", async () => {
    const input = await orientedJpeg();
    const source = { input, autoOrient: true, expectedFormat: "jpeg" as const };
    const inspection = await inspectStaticSource(source);
    expect(inspection).toEqual({
      width: 200,
      height: 300,
      hasAlpha: false,
      orientation: 6,
    });
    const derivative = await renderStaticDerivative(
      source,
      inspection,
      "display",
      {
        rotation: 90,
        crop: { x: 0, y: 0, width: 0.5, height: 1 },
      },
    );
    expect([
      derivative.width,
      derivative.height,
      derivative.contentType,
    ]).toEqual([150, 200, "image/webp"]);
    const metadata = await sharp(derivative.buffer).metadata();
    expect(metadata.format).toBe("webp");
    expect(metadata.exif).toBeUndefined();
    expect(metadata.xmp).toBeUndefined();
    expect(metadata.orientation).toBeUndefined();
    // Orientation 6 puts red on top; rotating 90° clockwise puts it on the right.
    const [r, , b] = await centerPixel(derivative.buffer);
    expect(b).toBeGreaterThan(200);
    expect(r).toBeLessThan(60);
    const coverCrop = { x: 0.5, y: 0, width: 0.5, height: 1 };
    for (const variant of ["cover", "thumb"] as const) {
      const card = await renderStaticDerivative(
        source,
        inspection,
        variant,
        { rotation: 90, crop: null },
        coverCrop,
      );
      expect([card.width, card.height]).toEqual([150, 200]);
      expect((await centerPixel(card.buffer))[0]).toBeGreaterThan(200);
    }
    const full = await renderStaticDerivative(
      source,
      inspection,
      "full",
      { rotation: 90, crop: null },
      coverCrop,
    );
    expect([full.width, full.height]).toEqual([300, 200]);
  });

  it("rejects format mismatches, undecodable bytes, oversized headers and animation", async () => {
    const jpegBytes = await orientedJpeg();
    expect(
      await rejection(() =>
        inspectStaticSource({
          input: jpegBytes,
          autoOrient: true,
          expectedFormat: "png",
        }),
      ),
    ).toBe("unsupported_type");
    expect(
      await rejection(() =>
        inspectStaticSource({
          input: Buffer.from("not an image"),
          autoOrient: true,
          expectedFormat: "jpeg",
        }),
      ),
    ).toBe("decode_failed");
    expect(
      await rejection(() =>
        inspectStaticSource({
          input: pngFile(12000, 12000),
          autoOrient: true,
          expectedFormat: "png",
        }),
      ),
    ).toBe("dimensions_exceeded");
    const frame = (background: typeof RED) =>
      sharp({ create: { width: 8, height: 8, channels: 3, background } })
        .png()
        .toBuffer();
    const animated = await sharp([await frame(RED), await frame(BLUE)], {
      join: { animated: true },
    })
      .webp()
      .toBuffer();
    expect(
      await rejection(() =>
        inspectStaticSource({
          input: animated,
          autoOrient: true,
          expectedFormat: "webp",
        }),
      ),
    ).toBe("animated_image_unsupported");
  });
});

// ---- End-to-end processor orchestration over a real store and a fake sandbox ----

const u8 = (...values: number[]) => Uint8Array.from(values);
const concat = (...parts: Uint8Array[]) => Buffer.concat(parts);
const u16 = (v: number) => u8((v >>> 8) & 255, v & 255);
const u32 = (v: number) =>
  u8((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
const ascii = (text: string) => Buffer.from(text, "latin1");
const zeros = (length: number) => Buffer.alloc(length);
const box = (type: string, ...payload: Uint8Array[]) => {
  const body = concat(...payload);
  return concat(u32(8 + body.length), ascii(type), body);
};
const fullBox = (type: string, version: number, ...payload: Uint8Array[]) =>
  box(type, u8(version, 0, 0, 0), ...payload);
const identity = concat(
  u32(0x10000),
  u32(0),
  u32(0),
  u32(0),
  u32(0x10000),
  u32(0),
  u32(0),
  u32(0),
  u32(0x40000000),
);

const IDENTIFIER = "7A1C2B3D-4E5F-4061-8273-94A5B6C7D8E9";
const OTHER_IDENTIFIER = "11111111-2222-4333-8444-555555555555";

const movieBox = (...extra: Uint8Array[]) => {
  const handler = fullBox("hdlr", 0, u32(0), ascii("vide"), zeros(12), u8(0));
  return box(
    "moov",
    fullBox(
      "mvhd",
      0,
      u32(0),
      u32(0),
      u32(600),
      u32(1740),
      u32(0x10000),
      u16(0x100),
      zeros(10),
      identity,
      zeros(24),
      u32(2),
    ),
    box(
      "trak",
      fullBox(
        "tkhd",
        0,
        u32(0),
        u32(0),
        u32(1),
        u32(0),
        u32(1740),
        zeros(16),
        identity,
        u32(64 << 16),
        u32(48 << 16),
      ),
      box("mdia", handler),
    ),
    ...extra,
  );
};

const quickTime = (identifier: string | null) => {
  const handler = (type: string) =>
    fullBox("hdlr", 0, u32(0), ascii(type), zeros(12), u8(0));
  const key = "com.apple.quicktime.content.identifier";
  const meta = identifier
    ? [
        box(
          "meta",
          handler("mdta"),
          fullBox(
            "keys",
            0,
            u32(1),
            concat(u32(8 + key.length), ascii("mdta"), ascii(key)),
          ),
          box(
            "ilst",
            (() => {
              const data = box("data", u32(1), u32(0), ascii(identifier));
              return concat(u32(8 + data.length), u32(1), data);
            })(),
          ),
        ),
      ]
    : [];
  return concat(
    box("ftyp", ascii("qt  "), u32(0), ascii("qt  ")),
    box("mdat", zeros(16)),
    movieBox(...meta),
  );
};

const appleExifSegment = (identifier: string) => {
  const value = concat(ascii(identifier), u8(0));
  const makerNote = concat(
    ascii("Apple iOS\0"),
    u16(1),
    ascii("MM"),
    u16(1),
    u16(0x0011),
    u16(2),
    u32(value.length),
    u32(32),
    u32(0),
    value,
  );
  const tiff = concat(
    ascii("MM"),
    u16(42),
    u32(8),
    u16(1),
    u16(0x8769),
    u16(4),
    u32(1),
    u32(26),
    u32(0),
    u16(1),
    u16(0x927c),
    u16(7),
    u32(makerNote.length),
    u32(44),
    u32(0),
    makerNote,
  );
  const payload = concat(ascii("Exif\0\0"), tiff);
  return concat(u8(0xff, 0xe1), u16(payload.length + 2), payload);
};

const liveStillJpeg = async (identifier: string | null) => {
  const image = await sharp({
    create: { width: 64, height: 48, channels: 3, background: RED },
  })
    .jpeg()
    .toBuffer();
  return identifier
    ? concat(
        image.subarray(0, 2),
        appleExifSegment(identifier),
        image.subarray(2),
      )
    : image;
};

/** JPEG Motion Photo: primary JPEG with a Container directory XMP, then an MP4. */
const motionPhoto = async (lengthDelta = 0) => {
  const video = concat(
    box("ftyp", ascii("isom"), u32(0), ascii("isom")),
    movieBox(),
    box("mdat", zeros(32)),
  );
  const xmp =
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    '<rdf:Description xmlns:GContainer="http://ns.google.com/photos/1.0/container/" xmlns:Item="http://ns.google.com/photos/1.0/container/item/">' +
    "<GContainer:Directory><rdf:Seq>" +
    '<rdf:li rdf:parseType="Resource"><GContainer:Item Item:Mime="image/jpeg" Item:Semantic="Primary"/></rdf:li>' +
    `<rdf:li rdf:parseType="Resource"><GContainer:Item Item:Mime="video/mp4" Item:Semantic="MotionPhoto" Item:Length="${video.length + lengthDelta}"/></rdf:li>` +
    "</rdf:Seq></GContainer:Directory></rdf:Description></rdf:RDF></x:xmpmeta>";
  const payload = concat(
    ascii("http://ns.adobe.com/xap/1.0/\0"),
    Buffer.from(xmp, "utf8"),
  );
  const image = await liveStillJpeg(null);
  return concat(
    image.subarray(0, 2),
    u8(0xff, 0xe1),
    u16(payload.length + 2),
    payload,
    image.subarray(2),
    video,
  );
};

/** A HEIC-branded still without an Exif item (decoded by the fake heif-dec). */
const heicStill = () =>
  concat(
    box("ftyp", ascii("heic"), u32(0), ascii("mif1"), ascii("heic")),
    box("mdat", zeros(16)),
  );

const motionProbeJson = (output: boolean) =>
  JSON.stringify({
    streams: [
      {
        codec_type: "video",
        codec_name: output ? "h264" : "hevc",
        width: 64,
        height: 48,
        duration: "2.900000",
        pix_fmt: "yuv420p",
        ...(output
          ? {
              color_primaries: "bt709",
              color_transfer: "bt709",
              color_space: "bt709",
              color_range: "tv",
            }
          : { side_data_list: [{ rotation: 0 }] }),
      },
      { codec_type: "audio", codec_name: "aac" },
      ...(output ? [] : [{ codec_type: "data" }]),
    ],
    format: { duration: "2.900000" },
  });

interface SandboxRun {
  readonly tool: string;
  readonly output: string | null;
}

/** Sandbox stand-in: ffprobe prints fixed JSON, heif-dec and ffmpeg write files. */
const fakeMediaSandbox = (
  options: {
    ffmpegExit?: number;
    decodedPng?: Buffer;
    onRun?: (run: RunView) => Promise<void>;
  } = {},
) => {
  const runs: SandboxRun[] = [];
  const docker = fakeDocker(async (run) => {
    runs.push({ tool: run.tool, output: run.outputDirectory });
    await options.onRun?.(run);
    const target = run.outputDirectory
      ? path.join(run.outputDirectory, path.basename(run.toolArgs.at(-1)!))
      : null;
    if (run.tool === "ffprobe") {
      const isOutput = run.toolArgs.at(-1) === "/job/in/motion-output.mp4";
      run.process.stdout.write(motionProbeJson(isOutput));
      run.process.exit(0);
    } else if (run.tool === "ffmpeg") {
      const code = options.ffmpegExit ?? 0;
      if (code === 0) await writeFile(target!, "synthetic-mp4");
      run.process.exit(code);
    } else if (run.tool === "heif-dec" && options.decodedPng) {
      await writeFile(target!, options.decodedPng);
      run.process.exit(0);
    } else {
      run.process.exit(1);
    }
  });
  return { ...docker, runs };
};

const OWNER = `user-${"2".repeat(32)}`;

let processorStoreKind: "filesystem" | "cos" = "filesystem";

const setup = async (
  sandbox: ReturnType<typeof fakeMediaSandbox> = fakeMediaSandbox(),
  wrap: (tools: MediaToolsRunner) => MediaToolsRunner = (tools) => tools,
) => {
  const store =
    processorStoreKind === "cos"
      ? cosFixture().store
      : await FilesystemPublishingMediaStore.open(storeRoot, {
          temporaryRoots: [],
        });
  const tools: MediaToolsRunner = wrap(await runner(sandbox.spawn));
  const processor: PublishingMediaProcessorPort =
    createPublishingMediaProcessor({ store, runner: tools });
  const put = async (bytes: Buffer) => {
    const written = await store.writeStream(
      OWNER,
      "original",
      "image/jpeg",
      bytes.length,
      (async function* () {
        yield bytes;
      })(),
    );
    return {
      storageKey: written.storageKey,
      byteSize: written.byteSize,
      sha256: written.sha256,
    };
  };
  const blobCount = async () =>
    (await store.listBlobs({ limit: 1000 })).entries.length;
  const toolsRun = () => sandbox.runs.map((run) => run.tool);
  return { store, tools, processor, put, blobCount, toolsRun, sandbox };
};

const baseInput = {
  mode: "process",
  itemId: `media-item-${"a".repeat(32)}`,
  ownerId: OWNER,
  clientPairing: null,
  editKey: "base",
  edit: { rotation: 0, crop: null },
  coverCrop: null,
} as const;

/** Asserts a contracts-valid rejection code. */
const expectRejected = (
  outcome: PublishingProcessOutcome,
  failureCode: PublishingMediaFailureCode,
) => {
  expect(outcome).toEqual({ status: "rejected", failureCode });
  expect(mediaFailureCodeSchema.options).toContain(failureCode);
};

const processed = (outcome: PublishingProcessOutcome) => {
  if (outcome.status !== "processed") {
    throw new Error(`expected processed, got ${JSON.stringify(outcome)}`);
  }
  return outcome;
};

const processorCases = () => {
  it("keeps processor, port and contracts failure codes identical", () => {
    expect(failureCodesMatchContracts).toBe(true);
  });

  it("processes a static JPEG without the sandbox and commits WebP derivatives", async () => {
    const { store, processor, put, toolsRun } = await setup();
    const still = await put(await orientedJpeg());
    const outcome = processed(
      await processor.process({
        ...baseInput,
        kind: "static",
        qualityMode: "original",
        components: [{ role: "still", declaredType: "image/jpeg", ...still }],
        variants: ["thumb", "display", "full"],
      }),
    );
    expect(outcome.presentation).toEqual({ width: 200, height: 300 });
    expect(mediaPresentationSchema.parse(outcome.presentation)).toEqual(
      outcome.presentation,
    );
    expect(outcome.pairing).toBeNull();
    expect(outcome.stillExifOrientation).toBe(6);
    expect(outcome).not.toHaveProperty("processingProfile");
    expect(outcome.detectedTypes).toEqual([
      { role: "still", contentType: "image/jpeg" },
    ]);
    expect(
      outcome.derivatives.map((d) => [
        d.variant,
        d.editKey,
        d.contentType,
        d.width,
        d.height,
      ]),
    ).toEqual([
      ["thumb", "base", "image/webp", 200, 300],
      ["display", "base", "image/webp", 200, 300],
      ["full", "base", "image/webp", 200, 300],
    ]);
    const read = await store.openRead(outcome.derivatives[0]!.storageKey);
    if (read?.status !== "ok") throw new Error("expected derivative");
    const parts: Buffer[] = [];
    for await (const part of read.body) parts.push(part as Buffer);
    expect((await sharp(Buffer.concat(parts)).metadata()).format).toBe("webp");
    expect(toolsRun()).toEqual([]);
    expect(await readdir(work)).toEqual([]);
  });

  it.each([
    [
      "a declared type that differs from the bytes",
      async () => orientedJpeg(),
      "image/png" as const,
      "unsupported_type",
    ],
    [
      "an animated PNG",
      async () =>
        pngFile(8, 8, [
          pngChunk("acTL", Buffer.from([0, 0, 0, 2, 0, 0, 0, 0])),
        ]),
      "image/png" as const,
      "animated_image_unsupported",
    ],
    [
      "a HEIF image sequence that also lists still brands",
      async () =>
        concat(
          box(
            "ftyp",
            ascii("msf1"),
            u32(0),
            ascii("mif1"),
            ascii("heic"),
            ascii("msf1"),
          ),
          box("mdat", zeros(8)),
        ),
      "image/heic" as const,
      "animated_image_unsupported",
    ],
    [
      "a HEIF still carrying a movie box",
      async () => concat(heicStill(), movieBox()),
      "image/heic" as const,
      "animated_image_unsupported",
    ],
    [
      "a truncated PNG",
      async () => pngFile(8, 8).subarray(0, 40),
      "image/png" as const,
      "decode_failed",
    ],
  ])(
    "rejects %s before any tool runs and leaves no derivative behind",
    async (_name, bytes, declaredType, code) => {
      const { processor, put, blobCount, toolsRun } = await setup();
      const still = await put(await bytes());
      expectRejected(
        await processor.process({
          ...baseInput,
          kind: "static",
          qualityMode: "original",
          components: [{ role: "still", declaredType, ...still }],
          variants: ["thumb", "full"],
        }),
        code as PublishingMediaFailureCode,
      );
      expect(await blobCount()).toBe(1);
      expect(toolsRun()).toEqual([]);
    },
  );

  it("throws input errors for impossible layouts, base keys with edits and malformed pairing", async () => {
    const { processor, put } = await setup();
    const still = await put(await orientedJpeg());
    const staticInput: PublishingProcessInput = {
      ...baseInput,
      kind: "static",
      qualityMode: "original",
      components: [{ role: "still", declaredType: "image/jpeg", ...still }],
      variants: ["display"],
    };
    const coverCrop = { x: 0, y: 0, width: 0.5, height: 0.5 };
    for (const input of [
      { ...staticInput, kind: "live" as const },
      { ...staticInput, variants: ["motion" as const] },
      { ...staticInput, edit: { rotation: 90 as const, crop: null } },
      { ...staticInput, coverCrop, variants: ["thumb" as const] },
      { ...staticInput, editKey: "not-a-key" },
      { ...staticInput, mode: "validate" as "process" },
      {
        ...staticInput,
        kind: "live" as const,
        clientPairing: {
          method: "apple-content-identifier" as const,
          identifierSha256: null,
        },
      },
    ]) {
      await expect(processor.process(input)).rejects.toBeInstanceOf(
        MediaProcessingInputError,
      );
    }
    // `base` stays valid when the cover crop does not shape any variant.
    expect(
      (await processor.process({ ...staticInput, coverCrop })).status,
    ).toBe("processed");
  });

  it("verifies an Apple Live Photo pair on the server, keeps the client still time and produces the motion derivative", async () => {
    const { processor, put, toolsRun, blobCount, sandbox } = await setup();
    const still = await put(await liveStillJpeg(IDENTIFIER.toLowerCase()));
    const motion = await put(quickTime(IDENTIFIER));
    const outcome = processed(
      await processor.process({
        ...baseInput,
        kind: "live",
        qualityMode: "original",
        components: [
          { role: "still", declaredType: "image/jpeg", ...still },
          { role: "motion", declaredType: "video/quicktime", ...motion },
        ],
        clientPairing: {
          method: "apple-content-identifier",
          identifierSha256: contentIdentifierSha256(IDENTIFIER),
          stillTimeMs: 1500,
        },
        variants: ["thumb", "motion"],
      }),
    );
    expect(outcome.pairing).toEqual({
      method: "apple-content-identifier",
      verifiedBy: "server",
      identifierSha256: contentIdentifierSha256(IDENTIFIER),
      stillTimeMs: 1500,
    });
    expect(outcome.presentation).toEqual({
      width: 64,
      height: 48,
      durationMs: 2900,
      hasAudio: true,
      displayRotation: 0,
    });
    // The public mapper drops the private display rotation.
    const publicPresentation = { ...outcome.presentation };
    delete publicPresentation.displayRotation;
    expect(mediaPresentationSchema.parse(publicPresentation)).toEqual(
      publicPresentation,
    );
    expect(() => mediaPresentationSchema.parse(outcome.presentation)).toThrow();
    expect(outcome.stillExifOrientation).toBeNull();
    expect(
      outcome.derivatives.map((d) => [d.variant, d.contentType, d.durationMs]),
    ).toEqual([
      ["thumb", "image/webp", null],
      ["motion", "video/mp4", 2900],
    ]);
    expect(toolsRun()).toEqual(["ffprobe", "ffmpeg", "ffprobe"]);
    expect(sandbox.runs.map((run) => run.output === null)).toEqual([
      true,
      false,
      true,
    ]);
    expect(await blobCount()).toBe(4);
  });

  it("rejects pairing contradictions before any tool runs and trusts only a consistent client proof in Standard mode", async () => {
    const { processor, put, blobCount, toolsRun } = await setup();
    const still = await put(await liveStillJpeg(IDENTIFIER));
    const matching = await put(quickTime(IDENTIFIER));
    const other = await put(quickTime(OTHER_IDENTIFIER));
    const bare = await put(quickTime(null));
    const plainStill = await put(await liveStillJpeg(null));
    const live = (
      stillComponent: typeof still,
      motionComponent: typeof still,
      extra: Partial<PublishingProcessInput> = {},
    ): PublishingProcessInput => ({
      ...baseInput,
      kind: "live",
      qualityMode: "original",
      components: [
        { role: "still", declaredType: "image/jpeg", ...stillComponent },
        {
          role: "motion",
          declaredType: "video/quicktime",
          ...motionComponent,
        },
      ],
      variants: ["thumb"],
      ...extra,
    });
    const appleProof = {
      method: "apple-content-identifier" as const,
      identifierSha256: contentIdentifierSha256(IDENTIFIER),
    };
    const containerClaim = {
      method: "motion-photo-container" as const,
      identifierSha256: null,
    };
    for (const input of [
      live(still, other),
      live(still, bare),
      live(plainStill, bare, { qualityMode: "standard" }),
      live(plainStill, other, {
        qualityMode: "standard",
        clientPairing: appleProof,
      }),
      live(still, bare, {
        qualityMode: "standard",
        clientPairing: containerClaim,
      }),
      live(still, matching, {
        clientPairing: {
          ...appleProof,
          identifierSha256: contentIdentifierSha256(OTHER_IDENTIFIER),
        },
      }),
    ]) {
      expectRejected(await processor.process(input), "pairing_mismatch");
    }
    expect(toolsRun()).toEqual([]);
    // A still time beyond the motion is known only after probing.
    expectRejected(
      await processor.process(
        live(still, matching, {
          clientPairing: { ...appleProof, stillTimeMs: 5000 },
        }),
      ),
      "pairing_mismatch",
    );
    expect(toolsRun()).toEqual(["ffprobe"]);
    const accepted = processed(
      await processor.process(
        live(plainStill, bare, {
          qualityMode: "standard",
          clientPairing: appleProof,
        }),
      ),
    );
    expect(accepted.pairing).toEqual({ ...appleProof, verifiedBy: "client" });
    const container = processed(
      await processor.process(
        live(plainStill, bare, {
          qualityMode: "standard",
          clientPairing: { ...containerClaim, stillTimeMs: 800 },
        }),
      ),
    );
    expect(container.pairing).toEqual({
      method: "motion-photo-container",
      verifiedBy: "client",
      identifierSha256: null,
      stillTimeMs: 800,
    });
    expect(await blobCount()).toBe(7);
  });

  it("splits a Motion Photo package on the server without an identifier digest and rejects inconsistent directories", async () => {
    const { processor, put, blobCount, toolsRun } = await setup();
    const packaged = await put(await motionPhoto());
    const input: PublishingProcessInput = {
      ...baseInput,
      kind: "live",
      qualityMode: "original",
      components: [
        { role: "package", declaredType: "image/jpeg", ...packaged },
      ],
      variants: ["thumb", "motion"],
    };
    const outcome = processed(await processor.process(input));
    expect(outcome.detectedTypes).toEqual([
      { role: "package", contentType: "image/jpeg" },
    ]);
    expect(outcome.pairing).toEqual({
      method: "motion-photo-container",
      verifiedBy: "server",
      identifierSha256: null,
    });
    expect(outcome.presentation).toMatchObject({
      width: 64,
      height: 48,
      durationMs: 2900,
    });
    expect(outcome.derivatives.map((d) => d.variant)).toEqual([
      "thumb",
      "motion",
    ]);
    expect(toolsRun()).toEqual(["ffprobe", "ffmpeg", "ffprobe"]);
    const inconsistent = await put(await motionPhoto(1));
    expectRejected(
      await processor.process({
        ...input,
        components: [
          { role: "package", declaredType: "image/jpeg", ...inconsistent },
        ],
      }),
      "decode_failed",
    );
    const plain = await put(await liveStillJpeg(null));
    expectRejected(
      await processor.process({
        ...input,
        components: [{ role: "package", declaredType: "image/jpeg", ...plain }],
      }),
      "unsupported_type",
    );
    expect(await blobCount()).toBe(5);
  });

  it("decodes HEIC through the sandbox and reads only host-written copies afterwards", async () => {
    const decodedPng = await sharp({
      create: { width: 40, height: 30, channels: 3, background: BLUE },
    })
      .png()
      .toBuffer();
    const observations: string[] = [];
    let jobInput = "";
    const sandbox = fakeMediaSandbox({
      decodedPng,
      onRun: async (run) => {
        jobInput = run.inputDirectory;
        if (run.tool !== "ffmpeg") return;
        // A hostile later container can only touch its own fresh directory.
        await symlink(
          "/etc/hosts",
          path.join(run.outputDirectory!, "still.png"),
        );
        await rm(path.join(run.outputDirectory!, "still.png"));
        const accepted = await lstat(path.join(jobInput, "still.png"));
        observations.push(accepted.isFile() ? "still-copy-regular" : "link");
        observations.push(
          (await readdir(path.dirname(jobInput))).sort().join(","),
        );
      },
    });
    const { processor, put, toolsRun } = await setup(sandbox);
    const still = await put(heicStill());
    const motion = await put(quickTime(null));
    const outcome = processed(
      await processor.process({
        ...baseInput,
        kind: "live",
        qualityMode: "standard",
        components: [
          { role: "still", declaredType: "image/heic", ...still },
          { role: "motion", declaredType: "video/quicktime", ...motion },
        ],
        clientPairing: {
          method: "apple-content-identifier",
          identifierSha256: contentIdentifierSha256(IDENTIFIER),
        },
        variants: ["thumb", "motion"],
      }),
    );
    expect(toolsRun()).toEqual(["heif-dec", "ffprobe", "ffmpeg", "ffprobe"]);
    const outputs = sandbox.runs.map((run) => run.output);
    expect(outputs[1]).toBeNull();
    expect(outputs[3]).toBeNull();
    expect(outputs[0]).not.toBe(outputs[2]);
    expect(observations[0]).toBe("still-copy-regular");
    // Only `in/` and the ffmpeg run's own directory exist during ffmpeg.
    expect(observations[1]).toBe(
      ["in", path.basename(outputs[2]!)].sort().join(","),
    );
    expect(outcome.detectedTypes).toEqual([
      { role: "still", contentType: "image/heic" },
      { role: "motion", contentType: "video/quicktime" },
    ]);
    expect(outcome.presentation).toMatchObject({ width: 40, height: 30 });
    expect(outcome.stillExifOrientation).toBeNull();
  });

  it("derives an edit from only the components its variants need, without re-verifying pairing", async () => {
    const { store, tools, put, toolsRun } = await setup();
    const reads: string[] = [];
    const countingStore = {
      openRead: (key: string) => {
        reads.push(key);
        return store.openRead(key);
      },
      writeStream: store.writeStream.bind(store),
      remove: store.remove.bind(store),
    };
    const processor: PublishingMediaProcessorPort =
      createPublishingMediaProcessor({ store: countingStore, runner: tools });
    const still = await put(await orientedJpeg());
    const motion = await put(quickTime(OTHER_IDENTIFIER));
    const input: PublishingProcessInput = {
      ...baseInput,
      mode: "derive",
      kind: "live",
      qualityMode: "original",
      components: [
        { role: "still", declaredType: "image/jpeg", ...still },
        { role: "motion", declaredType: "video/quicktime", ...motion },
      ],
      editKey: "e".repeat(32),
      edit: { rotation: 90, crop: null },
      coverCrop: { x: 0.5, y: 0, width: 0.5, height: 1 },
      variants: ["cover"],
    };
    const cover = await processor.process(input);
    expect(cover.status).toBe("derived");
    if (cover.status !== "derived") throw new Error("expected derived");
    expect(
      cover.derivatives.map((d) => [d.variant, d.editKey, d.width, d.height]),
    ).toEqual([["cover", "e".repeat(32), 150, 200]]);
    expect(reads).toEqual([still.storageKey]);
    expect(toolsRun()).toEqual([]);
    const moving = await processor.process({
      ...input,
      variants: ["motion"],
    });
    expect(moving.status).toBe("derived");
    expect(reads.slice(1)).toEqual([motion.storageKey]);
    expect(toolsRun()).toEqual(["ffprobe", "ffmpeg", "ffprobe"]);
    expect(await readdir(work)).toEqual([]);
  });

  it("rejects a timeout during processing but retries it for an edit derivation, cleaning derivatives", async () => {
    const timingOut = (tools: MediaToolsRunner): MediaToolsRunner => ({
      createJob: () => tools.createJob(),
      sweepJobs: (olderThan) => tools.sweepJobs(olderThan),
      run: (job, tool, args, options) =>
        tool === "ffmpeg"
          ? Promise.reject(new MediaToolError("timeout"))
          : tools.run(job, tool, args, options),
    });
    const { processor, put, blobCount } = await setup(
      fakeMediaSandbox(),
      timingOut,
    );
    const still = await put(await liveStillJpeg(IDENTIFIER));
    const motion = await put(quickTime(IDENTIFIER));
    const input: PublishingProcessInput = {
      ...baseInput,
      kind: "live",
      qualityMode: "original",
      components: [
        { role: "still", declaredType: "image/jpeg", ...still },
        { role: "motion", declaredType: "video/quicktime", ...motion },
      ],
      variants: ["thumb", "motion"],
    };
    expectRejected(await processor.process(input), "processing_timeout");
    await expect(
      processor.process({ ...input, mode: "derive" }),
    ).rejects.toMatchObject({ name: "MediaToolError", code: "timeout" });
    expect(await blobCount()).toBe(2);
  });

  it("maps a failing transcoder to a rejection and a sandbox outage to a retryable failure, cleaning derivatives", async () => {
    const failing = await setup(fakeMediaSandbox({ ffmpegExit: 1 }));
    const still = await failing.put(await liveStillJpeg(IDENTIFIER));
    const motion = await failing.put(quickTime(IDENTIFIER));
    const input: PublishingProcessInput = {
      ...baseInput,
      kind: "live",
      qualityMode: "original",
      components: [
        { role: "still", declaredType: "image/jpeg", ...still },
        { role: "motion", declaredType: "video/quicktime", ...motion },
      ],
      variants: ["thumb", "motion"],
    };
    expectRejected(await failing.processor.process(input), "processing_failed");
    expect(await failing.blobCount()).toBe(2);

    await rm(storeRoot, { recursive: true, force: true });
    await mkdir(storeRoot, { mode: 0o700 });
    const outage = await setup(fakeMediaSandbox({ ffmpegExit: 125 }));
    const again = {
      ...input,
      components: [
        {
          role: "still" as const,
          declaredType: "image/jpeg" as const,
          ...(await outage.put(await liveStillJpeg(IDENTIFIER))),
        },
        {
          role: "motion" as const,
          declaredType: "video/quicktime" as const,
          ...(await outage.put(quickTime(IDENTIFIER))),
        },
      ],
    };
    await expect(outage.processor.process(again)).rejects.toMatchObject({
      code: "sandbox_unavailable",
    });
    expect(await outage.blobCount()).toBe(2);
    expect(await readdir(work)).toEqual([]);
  });

  it("wraps unexpected infrastructure errors without paths", async () => {
    const { store, tools, put } = await setup();
    const still = await put(await orientedJpeg());
    const brokenStore = {
      openRead: async () => {
        throw Object.assign(
          new Error(`EIO: i/o error, open '${storeRoot}/blobs/secret'`),
          { code: "EIO", path: `${storeRoot}/blobs/secret` },
        );
      },
      writeStream: store.writeStream.bind(store),
      remove: store.remove.bind(store),
    };
    const processor = createPublishingMediaProcessor({
      store: brokenStore,
      runner: tools,
    });
    const failure = await processor
      .process({
        ...baseInput,
        kind: "static",
        qualityMode: "original",
        components: [{ role: "still", declaredType: "image/jpeg", ...still }],
        variants: ["thumb"],
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(MediaProcessingUnavailableError);
    expect(failure).toMatchObject({ systemCode: "EIO" });
    expect(JSON.stringify(failure)).not.toContain(storeRoot);
    expect((failure as Error).message).not.toContain(storeRoot);
    expect(await readdir(work)).toEqual([]);
  });
};

describe.each(["filesystem", "cos"] as const)(
  "publishing media processor (%s)",
  (kind) => {
    beforeEach(() => {
      processorStoreKind = kind;
    });
    processorCases();
  },
);

describe("publishing media processor legacy user media stills", () => {
  const LEGACY_MEDIA_ID = `user-media-${"3".repeat(32)}`;
  const translucentPng = () =>
    sharp({
      create: {
        width: 40,
        height: 20,
        channels: 4,
        background: { r: 200, g: 10, b: 10, alpha: 0.5 },
      },
    })
      .png()
      .toBuffer();
  const legacyInput = (
    bytes: Buffer,
    extra: Partial<ProcessorInput> = {},
  ): ProcessorInput => ({
    ...baseInput,
    mode: "derive",
    kind: "static",
    qualityMode: "standard",
    source: {
      kind: "legacy_user_media",
      legacyMediaId: LEGACY_MEDIA_ID,
      byteSize: bytes.byteLength,
      contentType: "image/png",
    },
    legacyStill: bytes,
    components: [],
    editKey: "f".repeat(32),
    edit: { rotation: 90, crop: null },
    coverCrop: { x: 0, y: 0, width: 1, height: 0.5 },
    variants: ["thumb", "display", "cover"],
    ...extra,
  });
  const storedBlobs = async (count: () => Promise<number>) =>
    count().catch(() => 0);

  it("derives an edited legacy PNG from the job input and stores only its derivatives", async () => {
    const { store, tools, blobCount, toolsRun } = await setup();
    const processor = createPublishingMediaProcessor({ store, runner: tools });
    const png = await translucentPng();
    const untouched = Buffer.from(png);
    const outcome = await processor.process(legacyInput(png));
    if (outcome.status !== "derived") {
      throw new Error(`expected derived, got ${JSON.stringify(outcome)}`);
    }
    // Rotated to 20 × 40; the card variants take the upper half.
    expect(
      outcome.derivatives.map((d) => [
        d.variant,
        d.editKey,
        d.contentType,
        d.width,
        d.height,
      ]),
    ).toEqual([
      ["thumb", "f".repeat(32), "image/webp", 20, 20],
      ["display", "f".repeat(32), "image/webp", 20, 40],
      ["cover", "f".repeat(32), "image/webp", 20, 20],
    ]);
    const read = await store.openRead(outcome.derivatives[1]!.storageKey);
    if (read?.status !== "ok") throw new Error("expected derivative");
    const parts: Buffer[] = [];
    for await (const part of read.body) parts.push(part as Buffer);
    const metadata = await sharp(Buffer.concat(parts)).metadata();
    expect([metadata.format, metadata.hasAlpha]).toEqual(["webp", true]);
    // Only derivatives were stored; the source never enters the media store.
    expect(await storedBlobs(blobCount)).toBe(3);
    expect(png.equals(untouched)).toBe(true);
    expect(toolsRun()).toEqual([]);
    expect(await readdir(work)).toEqual([]);
  });

  it("rejects legacy bytes that are not a still PNG without storing anything", async () => {
    const { store, tools, blobCount, toolsRun } = await setup();
    const processor = createPublishingMediaProcessor({ store, runner: tools });
    const jpeg = await orientedJpeg();
    expectRejected(
      await processor.process(legacyInput(jpeg)),
      "unsupported_type",
    );
    const animated = pngFile(8, 8, [
      pngChunk("acTL", Buffer.from([0, 0, 0, 2, 0, 0, 0, 0])),
    ]);
    expectRejected(
      await processor.process(legacyInput(animated)),
      "animated_image_unsupported",
    );
    expect(await storedBlobs(blobCount)).toBe(0);
    expect(toolsRun()).toEqual([]);
    expect(await readdir(work)).toEqual([]);
  });

  it("throws input errors for legacy sources outside an edit of a static item", async () => {
    const { store, tools, put } = await setup();
    const processor = createPublishingMediaProcessor({ store, runner: tools });
    const png = await translucentPng();
    const valid = legacyInput(png);
    const source = valid.source as Extract<
      ProcessorInput["source"],
      { kind: "legacy_user_media" }
    >;
    const still = await put(await orientedJpeg());
    const upload: ProcessorInput = {
      ...baseInput,
      mode: "derive",
      kind: "static",
      qualityMode: "original",
      components: [{ role: "still", declaredType: "image/jpeg", ...still }],
      variants: ["display"],
    };
    for (const input of [
      { ...valid, mode: "process" as const },
      { ...valid, kind: "live" as const, variants: ["display" as const] },
      { ...valid, components: upload.components },
      { ...valid, legacyStill: png.subarray(1) },
      // A legacy source without the bytes the worker reads for it.
      { ...valid, legacyStill: undefined } as unknown as ProcessorInput,
      { ...valid, source: { ...source, byteSize: 4 * 1024 * 1024 + 1 } },
      { ...valid, source: { ...source, legacyMediaId: "user-media-1" } },
      {
        ...valid,
        source: { ...source, contentType: "image/jpeg" as "image/png" },
      },
      { ...upload, legacyStill: png },
      // Legacy edits carry the standard quality mode; no other mode exists.
      { ...valid, qualityMode: "legacy" as unknown as "standard" },
    ]) {
      await expect(processor.process(input)).rejects.toBeInstanceOf(
        MediaProcessingInputError,
      );
    }
    expect((await processor.process(upload)).status).toBe("derived");
    expect(
      (await processor.process({ ...upload, source: { kind: "upload" } }))
        .status,
    ).toBe("derived");
    expect(await readdir(work)).toEqual([]);
  });
});
