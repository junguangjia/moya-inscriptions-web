import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import {
  SANDBOX_JOB_FILE,
  parseSandboxJob,
  renderSandboxJob,
  sandboxManifest,
  writeSandboxStream,
} from "@moya/backend-production/internal/publishing-sandbox";
import sharp from "sharp";

import type { MediaToolRunner } from "@moya/backend-production/internal/publishing-processing";
import type {
  SandboxBoundsFacts,
  SandboxBoundsProbe,
  SandboxIsolationFacts,
  SandboxJob,
  SandboxManifest,
  SandboxProcess,
  SandboxSpawn,
  SandboxSpawnOptions,
} from "@moya/backend-production/internal/publishing-sandbox";

/*
 * An in-process stand-in for `docker run` of the media sandbox: it reads the
 * job from the read-only input mount the runner passes, runs the real
 * renderer (real sharp) with an injected tool runner, and emits the real
 * framed stream on the fake CLI's stdout. Docker is never required.
 */

export class FakeSandboxProcess extends EventEmitter {
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

export interface SandboxSpawnCall {
  readonly args: string[];
  readonly options: SandboxSpawnOptions;
  readonly process: FakeSandboxProcess;
}

export const mountSource = (args: readonly string[], target: string) => {
  const mount = args.find(
    (arg) => arg.startsWith("type=bind,") && arg.includes(`,target=${target}`),
  );
  return mount
    ? mount.slice("type=bind,source=".length, mount.indexOf(",target="))
    : null;
};

/** Facts of a correctly isolated sandbox (what the self-check expects). */
export const isolatedFacts = (
  overrides: Partial<SandboxIsolationFacts> = {},
): SandboxIsolationFacts => ({
  uid: 10001,
  gid: 10001,
  noNewPrivileges: true,
  effectiveCapabilities: "0",
  seccomp: 2,
  networkInterfaces: ["lo"],
  routes: 0,
  tcpConnect: "ENETUNREACH",
  readOnly: { root: true, app: true, input: true },
  writable: { tmp: true, work: true, output: true },
  environmentKeys: ["HOME", "HOSTNAME", "PATH", "TMPDIR"],
  memoryMax: "1610612736",
  swapMax: "0",
  pidsMax: "256",
  cpuMax: "100000 100000",
  oomScoreAdj: 1000,
  coreLimit: "0",
  openFilesLimit: "1024",
  visibleProcesses: 2,
  loaderAllowlist: true,
  ...overrides,
});

export const sandboxRuntime = () => ({
  node: process.versions.node,
  sharp: sharp.versions.sharp ?? "",
  vips: sharp.versions.vips,
});

export interface InProcessSandboxOptions {
  /** In-container tools (heif-dec, ffprobe, ffmpeg); none by default. */
  readonly tools?: MediaToolRunner;
  /** Self-check facts reported by the fake container. */
  readonly facts?: SandboxIsolationFacts;
  /** Rewrites the manifest before it is sent (protocol violation tests). */
  readonly tamper?: (manifest: SandboxManifest) => SandboxManifest;
  /** Replaces the whole stdout stream (raw protocol tests). */
  readonly stream?: (
    manifest: SandboxManifest,
    outputDirectory: string,
  ) => Promise<Buffer>;
  /** Exit status once the stream is written (default 0). */
  readonly exitCode?: number;
  /** Called for every `docker run` before the job runs. */
  readonly onRun?: (job: SandboxJob, call: SandboxSpawnCall) => void;
  /** Never finish the run (abort and timeout tests). */
  readonly hang?: boolean;
  /**
   * How a container answers an active bound probe: hang until killed, write
   * raw bytes, report facts, then exit (default: report nothing, exit 0).
   */
  readonly bounds?: (probe: SandboxBoundsProbe) => {
    readonly hang?: boolean;
    readonly stream?: Buffer;
    readonly facts?: SandboxBoundsFacts;
    readonly exitCode?: number;
  };
}

const noTools: MediaToolRunner = {
  run: async () => {
    throw new Error("no media tool in this sandbox fixture");
  },
};

/** A `SandboxSpawn` that runs the renderer in this process. */
export const inProcessSandbox = (options: InProcessSandboxOptions = {}) => {
  const calls: SandboxSpawnCall[] = [];
  const running = new Map<string, FakeSandboxProcess>();
  const jobs: SandboxJob[] = [];
  const spawn: SandboxSpawn = (_command, args, spawnOptions) => {
    const child = new FakeSandboxProcess();
    const call = { args, options: spawnOptions, process: child };
    calls.push(call);
    setImmediate(() => {
      if (args[0] === "run") {
        const name = args[args.indexOf("--name") + 1]!;
        running.set(name, child);
        void runJob(args, child, call).catch(() => child.exit(70));
      } else if (args[0] === "kill") {
        running.get(args[1]!)?.exit(137);
        child.exit(0);
      } else {
        child.exit(0);
      }
    });
    return child as unknown as SandboxProcess;
  };
  const runJob = async (
    args: string[],
    child: FakeSandboxProcess,
    call: SandboxSpawnCall,
  ) => {
    const input = mountSource(args, "/job/in")!;
    let job: SandboxJob;
    try {
      job = parseSandboxJob(
        JSON.parse(
          await readFile(path.join(input, SANDBOX_JOB_FILE), "utf8"),
        ) as unknown,
      );
    } catch {
      child.exit(64);
      return;
    }
    jobs.push(job);
    options.onRun?.(job, call);
    if (options.hang) return;
    if (job.operation === "bounds") {
      const answer = options.bounds?.(job.probe!) ?? {};
      if (answer.hang) return;
      if (answer.stream) child.stdout.write(answer.stream);
      if (answer.facts)
        await writeSandboxStream(
          sandboxManifest(job, sandboxRuntime(), { bounds: answer.facts }),
          input,
          async (chunk) => {
            child.stdout.write(chunk);
          },
        );
      child.exit(answer.exitCode ?? 0);
      return;
    }
    const scratch = await mkdtemp(path.join(tmpdir(), "sandbox-fixture-"));
    const work = path.join(scratch, "work");
    const output = path.join(scratch, "out");
    await Promise.all([mkdir(work), mkdir(output)]);
    try {
      let manifest =
        job.operation === "self-check"
          ? sandboxManifest(job, sandboxRuntime(), {
              selfCheck: options.facts ?? isolatedFacts(),
            })
          : sandboxManifest(
              job,
              sandboxRuntime(),
              await renderSandboxJob(
                job,
                { input, work, output },
                options.tools ?? noTools,
              ),
            );
      if (options.tamper) manifest = options.tamper(manifest);
      if (options.stream) {
        child.stdout.write(await options.stream(manifest, output));
      } else {
        await writeSandboxStream(manifest, output, (chunk) =>
          // A killed container stops writing: once the fake stdout ended or
          // the runner destroyed it, the renderer's write fails and it closes
          // its output handles.
          child.stdout.writableEnded || child.stdout.destroyed
            ? Promise.reject(new Error("sandbox stdout closed"))
            : new Promise<void>((resolve) => {
                if (child.stdout.write(chunk)) {
                  resolve();
                  return;
                }
                const settle = () => {
                  child.stdout.off("drain", settle);
                  child.stdout.off("close", settle);
                  resolve();
                };
                child.stdout.once("drain", settle);
                child.stdout.once("close", settle);
              }),
        );
      }
      child.exit(options.exitCode ?? 0);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  };
  return { spawn, calls, jobs };
};
