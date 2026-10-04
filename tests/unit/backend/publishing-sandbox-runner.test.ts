import { createHash } from "node:crypto";
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
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  MediaProcessingInputError,
  MediaProcessingUnavailableError,
  MediaToolError,
  currentRecipe,
  plannedStillRequests,
  validateSandboxManifest,
} from "@moya/backend-production/internal/publishing-processing";
import {
  SANDBOX_JOB_LIMITS,
  SandboxJobError,
  SandboxProtocolError,
  buildSandboxRunArguments,
  createSandboxRunner,
  defaultSandboxAppDist,
  encodeEndFrame,
  encodeFrameHeader,
  isolationMismatches,
  parseFrameHeader,
  parseSandboxJob,
  parseSandboxManifest,
  renderSandboxJob,
  sandboxManifest,
} from "@moya/backend-production/internal/publishing-sandbox";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  inProcessSandbox,
  isolatedFacts,
  mountSource,
  sandboxRuntime,
} from "./publishing-sandbox-fixture.js";

import type { StillRole } from "@moya/backend-production/internal/publishing-processing";
import type {
  SandboxJob,
  SandboxManifest,
  SandboxSpawn,
} from "@moya/backend-production/internal/publishing-sandbox";

/*
 * The coordinator's sandbox runner and the wire protocol: the exact `docker
 * run` arguments, the framed stream decoder and its bounds, kill and cleanup
 * on abort and timeout, exit status mapping, the startup self-check, the
 * active bound probes, orphan removal and job directory sweeps. Docker is
 * never required: the fixture runs the real renderer in-process behind a
 * fake CLI.
 */

const IMAGE = "yoyi-work-publishing-media-tools:v2";
const APP_DIST = defaultSandboxAppDist().appDist;
let base: string;
let work: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), "sandbox-runner-")));
  work = path.join(base, "work");
  await mkdir(work, { mode: 0o700 });
  await chmod(work, 0o700);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const errors: string[] = [];
const logger = { error: (message: string) => errors.push(message) };

const runnerWith = (
  spawn: SandboxSpawn,
  extra: Partial<Parameters<typeof createSandboxRunner>[0]> = {},
) =>
  createSandboxRunner({
    image: IMAGE,
    workDirectory: work,
    appDist: APP_DIST,
    spawn,
    temporaryRoots: [],
    environment: { PATH: "/usr/bin" },
    killGraceMs: 10,
    logger,
    ...extra,
  });

const jpeg = () =>
  sharp({
    create: { width: 64, height: 48, channels: 3, background: "#336699" },
  })
    .jpeg()
    .toBuffer();

/** A derive job for one staged JPEG still, with every planned role. */
const stillJob = async (
  job: { inputPath(name: string): string },
  roles: readonly StillRole[] = ["thumb", "cover", "display", "full"],
): Promise<SandboxJob> => {
  const bytes = await jpeg();
  await writeFile(job.inputPath("still"), bytes, { mode: 0o644 });
  return {
    protocol: 1,
    nonce: "b".repeat(32),
    operation: "derive",
    item: {
      kind: "static",
      qualityMode: "standard",
      inputs: [
        {
          role: "still",
          declaredType: "image/jpeg",
          byteSize: bytes.byteLength,
          sha256: sha256(bytes),
        },
      ],
      clientPairing: null,
      edit: { rotation: 0, crop: null },
      coverCrop: null,
      renditions: plannedStillRequests(roles),
      motion: false,
      placeholder: roles.includes("thumb"),
    },
    limits: SANDBOX_JOB_LIMITS,
  };
};

/** Encodes a framed stream exactly as the renderer writes it. */
const framed = (
  manifest: SandboxManifest,
  files: readonly { name: string; data: Buffer; header?: object }[],
  end = true,
) =>
  Buffer.concat([
    Buffer.from(`${JSON.stringify(manifest)}\n`),
    ...files.flatMap((file) => [
      file.header
        ? Buffer.from(`${JSON.stringify(file.header)}\n`)
        : encodeFrameHeader(file.name, file.data.byteLength, sha256(file.data)),
      file.data,
    ]),
    ...(end ? [encodeEndFrame(files.length)] : []),
  ]);

const outputsOf = async (
  manifest: SandboxManifest,
  directory: string,
): Promise<{ name: string; data: Buffer }[]> =>
  Promise.all(
    manifest.outputs.map(async (output) => ({
      name: output.name,
      data: await readFile(path.join(directory, output.name)),
    })),
  );

const violationOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(SandboxProtocolError);
    return (error as SandboxProtocolError).violation;
  }
  throw new Error("expected a protocol violation");
};

describe("media sandbox runner", () => {
  it("builds the exact docker run arguments", () => {
    expect(
      buildSandboxRunArguments({
        image: IMAGE,
        containerName: `yoyi-wp-media-${"a".repeat(24)}`,
        inputDirectory: "/srv/work/job-x/in",
        appDist: "/srv/release/services/backend-production/dist",
        timeoutMs: 300_000,
      }),
    ).toEqual([
      "run",
      "--rm",
      "--pull",
      "never",
      "--log-driver",
      "none",
      "--name",
      `yoyi-wp-media-${"a".repeat(24)}`,
      "--network",
      "none",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,noexec,size=64m",
      "--tmpfs",
      "/job/work:rw,nosuid,nodev,noexec,size=768m,uid=10001,gid=10001,mode=0700",
      "--tmpfs",
      "/job/out:rw,nosuid,nodev,noexec,size=256m,uid=10001,gid=10001,mode=0700",
      "--memory",
      "1536m",
      "--memory-swap",
      "1536m",
      "--cpus",
      "1",
      "--pids-limit",
      "256",
      "--ulimit",
      "nofile=1024:1024",
      "--ulimit",
      "core=0",
      "--oom-score-adj",
      "1000",
      "--security-opt",
      "no-new-privileges",
      "--cap-drop",
      "ALL",
      "--user",
      "10001:10001",
      "--env",
      "TMPDIR=/tmp",
      "--env",
      "VIPS_BLOCK_UNTRUSTED=1",
      "--env",
      "MALLOC_ARENA_MAX=2",
      "--env",
      "UV_THREADPOOL_SIZE=2",
      "--mount",
      "type=bind,source=/srv/work/job-x/in,target=/job/in,readonly",
      "--mount",
      "type=bind,source=/srv/release/services/backend-production/dist,target=/opt/renderer/app/dist,readonly",
      "--workdir",
      "/tmp",
      "--entrypoint",
      "/usr/bin/timeout",
      IMAGE,
      "--signal=KILL",
      "310s",
      "/usr/local/bin/node",
      "--max-old-space-size=384",
      "--disallow-code-generation-from-strings",
      "/opt/renderer/app/dist/publishing/sandbox/renderer-main.js",
    ]);
  });

  it("validates the image, the work directory and the mounted paths", async () => {
    const { spawn } = inProcessSandbox();
    for (const image of ["--privileged", "Bad Image", "evil;rm", ""]) {
      await expect(runnerWith(spawn, { image })).rejects.toThrow(
        "image reference",
      );
    }
    await expect(runnerWith(spawn, { temporaryRoots: [base] })).rejects.toThrow(
      "temporary storage",
    );
    await expect(
      runnerWith(spawn, { appDist: "/srv/a,b/dist" }),
    ).rejects.toThrow("bind-mounted");
    await expect(
      runnerWith(spawn, { appDist: "relative/dist" }),
    ).rejects.toThrow("bind-mounted");
    await chmod(work, 0o755);
    await expect(runnerWith(spawn)).rejects.toThrow("owner-only");
  });

  it("creates a private job with a read-only input and a host-only output directory", async () => {
    const runner = await runnerWith(inProcessSandbox().spawn);
    const job = await runner.createJob();
    const root = path.dirname(job.inputDirectory);
    expect(path.dirname(root)).toBe(work);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(job.inputDirectory)).mode & 0o777).toBe(0o755);
    expect((await stat(job.outputDirectory)).mode & 0o777).toBe(0o700);
    expect((await readdir(root)).sort()).toEqual(["in", "out"]);
    expect(() => job.inputPath("../escape")).toThrow("file name");
    await job.dispose();
    await expect(lstat(root)).rejects.toThrow();
  });

  it("runs one container per job and receives every output, verified, into the job", async () => {
    const sandbox = inProcessSandbox();
    const runner = await runnerWith(sandbox.spawn, {
      environment: {
        PATH: "/usr/bin",
        HOME: "/home/media",
        DOCKER_HOST: "unix:///run/docker.sock",
        APP_DATABASE_URL: "postgres://synthetic-secret",
        COS_SECRET_KEY: "synthetic-secret",
      },
    });
    const job = await runner.createJob();
    const request = await stillJob(job);
    const result = await runner.run(job, request, { timeoutMs: 30_000 });
    expect(result.manifest.status).toBe("derived");
    expect(result.manifest.nonce).toBe(request.nonce);
    validateSandboxManifest(result.manifest, request);
    expect([...result.files.keys()]).toEqual(
      result.manifest.outputs.map((output) => output.name),
    );
    for (const output of result.manifest.outputs) {
      const file = result.files.get(output.name)!;
      expect(path.dirname(file.path)).toBe(job.outputDirectory);
      expect((await stat(file.path)).mode & 0o777).toBe(0o600);
      expect(sha256(await readFile(file.path))).toBe(output.sha256);
    }
    // job.json is host-written, world-readable for the sandbox user, read-only.
    const written = await stat(job.inputPath("job.json"));
    expect(written.mode & 0o777).toBe(0o644);
    expect(
      JSON.parse(await readFile(job.inputPath("job.json"), "utf8")),
    ).toEqual(request);
    const [call] = sandbox.calls;
    expect(call!.args[0]).toBe("run");
    expect(mountSource(call!.args, "/job/in")).toBe(job.inputDirectory);
    expect(mountSource(call!.args, "/opt/renderer/app/dist")).toBe(APP_DIST);
    expect(mountSource(call!.args, "/job/out")).toBeNull();
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
    await job.dispose();
  });

  it("refuses a stream that breaks the protocol or its bounds and kills the container", async () => {
    const cases: [string, Parameters<typeof inProcessSandbox>[0]][] = [
      [
        "nonce_mismatch",
        { tamper: (manifest) => ({ ...manifest, nonce: "c".repeat(32) }) },
      ],
      [
        "runtime_mismatch",
        {
          tamper: (manifest) => ({
            ...manifest,
            runtime: { ...manifest.runtime, sharp: "0.35.3" },
          }),
        },
      ],
      [
        "manifest_invalid",
        {
          tamper: (manifest) =>
            ({ ...manifest, extra: true }) as unknown as SandboxManifest,
        },
      ],
      [
        "manifest_too_large",
        { stream: async () => Buffer.alloc(256 * 1024 + 1, 0x20) },
      ],
      [
        "frame_invalid",
        {
          stream: async (manifest, directory) => {
            const files = await outputsOf(manifest, directory);
            return framed(manifest, [
              {
                ...files[0]!,
                data: Buffer.concat([files[0]!.data, Buffer.from("x")]),
              },
              ...files.slice(1),
            ]);
          },
        },
      ],
      [
        "hash_mismatch",
        {
          stream: async (manifest, directory) => {
            const files = await outputsOf(manifest, directory);
            const tampered = Buffer.from(files[0]!.data);
            const last = tampered.byteLength - 1;
            tampered.writeUInt8(tampered.readUInt8(last) ^ 0xff, last);
            return framed(manifest, [
              {
                ...files[0]!,
                data: tampered,
                header: {
                  name: files[0]!.name,
                  bytes: tampered.byteLength,
                  sha256: manifest.outputs[0]!.sha256,
                },
              },
              ...files.slice(1),
            ]);
          },
        },
      ],
      [
        "stream_trailing_bytes",
        {
          stream: async (manifest, directory) =>
            Buffer.concat([
              framed(manifest, await outputsOf(manifest, directory)),
              Buffer.from("x"),
            ]),
        },
      ],
      [
        "stream_incomplete",
        {
          stream: async (manifest, directory) =>
            framed(manifest, await outputsOf(manifest, directory), false),
        },
      ],
      ["exit_after_manifest", { exitCode: 2 }],
    ];
    for (const [violation, options] of cases) {
      const sandbox = inProcessSandbox(options);
      const runner = await runnerWith(sandbox.spawn);
      const job = await runner.createJob();
      const request = await stillJob(job);
      expect(
        await violationOf(() =>
          runner.run(job, request, { timeoutMs: 30_000 }),
        ),
        violation,
      ).toBe(violation);
      await job.dispose();
    }
  });

  it("kills the container on abort and on timeout, then removes it twice", async () => {
    const controller = new AbortController();
    const aborting = inProcessSandbox({
      hang: true,
      onRun: () => controller.abort(),
    });
    const runner = await runnerWith(aborting.spawn);
    const job = await runner.createJob();
    const request = await stillJob(job);
    const failure = await runner
      .run(job, request, { timeoutMs: 30_000, signal: controller.signal })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(MediaToolError);
    expect((failure as MediaToolError).code).toBe("aborted");
    const name =
      aborting.calls[0]!.args[aborting.calls[0]!.args.indexOf("--name") + 1]!;
    expect(name).toMatch(/^yoyi-wp-media-[0-9a-f]{24}$/);
    await sleep(60);
    expect(aborting.calls.slice(1).map((call) => call.args)).toEqual([
      ["kill", name],
      ["rm", "--force", name],
      ["rm", "--force", name],
    ]);

    const hanging = inProcessSandbox({ hang: true });
    const slow = await runnerWith(hanging.spawn);
    const second = await slow.createJob();
    const started = Date.now();
    const timedOut = await slow
      .run(second, await stillJob(second), { timeoutMs: 30 })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect((timedOut as MediaToolError).code).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2000);
    // The container carries its own backstop: limit + 10 s grace.
    expect(hanging.calls[0]!.args).toContain("11s");
  });

  it("starts no container when the abort lands during the pre-spawn work", async () => {
    const sandbox = inProcessSandbox();
    const runner = await runnerWith(sandbox.spawn);
    const job = await runner.createJob();
    const request = await stillJob(job);
    const controller = new AbortController();
    // run() is suspended in its file work when the abort lands; a listener
    // added after the spawn would never see it.
    const running = runner.run(job, request, {
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    controller.abort();
    await expect(running).rejects.toMatchObject({
      name: "MediaToolError",
      code: "aborted",
    });
    expect(sandbox.calls).toEqual([]);
  });

  it("maps exit statuses: daemon or image unavailable, refused job, internal, resource and crash", async () => {
    const exitWith = async (code: number) => {
      const runner = await runnerWith(
        inProcessSandbox({
          exitCode: code,
          stream: async () => Buffer.alloc(0),
        }).spawn,
      );
      const job = await runner.createJob();
      return runner.run(job, await stillJob(job), { timeoutMs: 30_000 }).then(
        () => null,
        (error: unknown) => error,
      );
    };
    errors.length = 0;
    for (const code of [125, 126, 127]) {
      const failure = await exitWith(code);
      expect(failure).toBeInstanceOf(MediaToolError);
      expect(failure).toMatchObject({
        code: "sandbox_unavailable",
        exitCode: code,
      });
    }
    // One actionable, content-free line per runner.
    expect(errors).toHaveLength(3);
    expect(new Set(errors).size).toBe(1);
    expect(errors[0]).toContain("pnpm dev:media-sandbox");
    expect(await exitWith(64)).toBeInstanceOf(MediaProcessingInputError);
    expect(await exitWith(70)).toBeInstanceOf(MediaProcessingUnavailableError);
    expect(await exitWith(1)).toBeInstanceOf(MediaProcessingUnavailableError);
    expect(await exitWith(137)).toMatchObject({
      name: "SandboxProtocolError",
      violation: "resource_exceeded",
    });
    expect(await exitWith(139)).toMatchObject({
      violation: "resource_exceeded",
    });
    const throwing = await runnerWith(() => {
      throw new Error("spawn EACCES");
    });
    const job = await throwing.createJob();
    await expect(
      throwing.run(job, await stillJob(job), { timeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: "spawn_failed" });
  });

  it("refuses to run a missing or stale renderer build with one actionable message", async () => {
    errors.length = 0;
    const emptyDist = path.join(base, "dist");
    await mkdir(emptyDist);
    const missing = await runnerWith(inProcessSandbox().spawn, {
      appDist: emptyDist,
    });
    const job = await missing.createJob();
    for (let attempt = 0; attempt < 2; attempt += 1)
      await expect(
        missing.run(job, await stillJob(await missing.createJob()), {
          timeoutMs: 1000,
        }),
      ).rejects.toBeInstanceOf(MediaProcessingUnavailableError);
    expect(errors).toEqual([
      "[media-sandbox] renderer build missing or stale: run `pnpm --filter @moya/backend-production build`",
    ]);
    const source = path.join(base, "src", "publishing");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "newer.ts"), "");
    const future = new Date(Date.now() + 3_600_000);
    await utimes(path.join(source, "newer.ts"), future, future);
    const stale = await runnerWith(inProcessSandbox().spawn, {
      sourceDirectory: path.join(base, "src"),
    });
    const second = await stale.createJob();
    await expect(
      stale.run(second, await stillJob(second), { timeoutMs: 1000 }),
    ).rejects.toBeInstanceOf(MediaProcessingUnavailableError);
  });

  it("self-checks versions and isolation through the same arguments", async () => {
    const ok = await (await runnerWith(inProcessSandbox().spawn)).selfCheck();
    expect(ok).toMatchObject({ status: "ok", runtime: sandboxRuntime() });
    const leaky = await (
      await runnerWith(
        inProcessSandbox({
          facts: isolatedFacts({
            networkInterfaces: ["eth0", "lo"],
            routes: 2,
            environmentKeys: ["COS_SECRET_KEY", "PATH"],
            memoryMax: "max",
          }),
        }).spawn,
      )
    ).selfCheck();
    expect(leaky).toMatchObject({
      status: "mismatch",
      mismatches: [
        "networkInterfaces",
        "routes",
        "environmentKeys",
        "memoryMax",
      ],
    });
    const drifted = await (
      await runnerWith(
        inProcessSandbox({
          tamper: (manifest) => ({
            ...manifest,
            runtime: { ...manifest.runtime, sharp: "0.36.0" },
          }),
        }).spawn,
      )
    ).selfCheck();
    expect(drifted).toMatchObject({
      status: "mismatch",
      mismatches: ["runtime_mismatch"],
    });
    const down = await (
      await runnerWith(
        inProcessSandbox({ exitCode: 125, stream: async () => Buffer.alloc(0) })
          .spawn,
      )
    ).selfCheck();
    expect(down).toEqual({
      status: "unavailable",
      reason: "sandbox_unavailable",
    });
    expect(isolationMismatches(isolatedFacts())).toEqual([]);
    expect(
      isolationMismatches(
        isolatedFacts({
          uid: 0,
          effectiveCapabilities: "a80425fb",
          tcpConnect: "connected",
        }),
      ),
    ).toEqual(["uid", "effectiveCapabilities", "tcpConnect"]);
    // Self-check jobs leave nothing behind.
    expect(await readdir(work)).toEqual([]);
  });

  it("runs the active bound probes through the same arguments and judges each bound", async () => {
    const held = await (
      await runnerWith(
        inProcessSandbox({
          bounds: (probe) =>
            probe === "memory"
              ? { exitCode: 137 }
              : probe === "pids"
                ? { facts: { probe, count: 243, errorCode: "EAGAIN" } }
                : probe === "time"
                  ? { hang: true }
                  : probe === "disk"
                    ? { facts: { probe, count: 255, errorCode: "ENOSPC" } }
                    : { stream: Buffer.alloc(300 * 1024, 0x78) },
        }).spawn,
      )
    ).boundsCheck();
    expect(held).toMatchObject({
      status: "ok",
      leftoverContainers: 0,
      probes: [
        { probe: "memory", passed: true, observed: "resource_exceeded" },
        { probe: "pids", passed: true, observed: "243 EAGAIN" },
        { probe: "time", passed: true, observed: "timeout" },
        { probe: "disk", passed: true, observed: "255 ENOSPC" },
        { probe: "stdout", passed: true, observed: "manifest_too_large" },
      ],
    });
    // Every probe ran through the same `docker run` builder.
    const sandbox = inProcessSandbox({ bounds: () => ({ exitCode: 137 }) });
    const unbounded = await (
      await runnerWith(
        inProcessSandbox({
          bounds: (probe) =>
            probe === "memory"
              ? { facts: { probe, count: 4096, errorCode: null } }
              : probe === "pids"
                ? { facts: { probe, count: 1024, errorCode: null } }
                : probe === "disk"
                  ? { facts: { probe, count: 1024, errorCode: null } }
                  : { exitCode: 0 },
        }).spawn,
      )
    ).boundsCheck();
    expect(unbounded).toMatchObject({
      status: "failed",
      probes: [
        { probe: "memory", passed: false, observed: "4096 none" },
        { probe: "pids", passed: false, observed: "1024 none" },
        { probe: "time", passed: false },
        { probe: "disk", passed: false, observed: "1024 none" },
        { probe: "stdout", passed: false },
      ],
    });
    const runner = await runnerWith(sandbox.spawn);
    await runner.boundsCheck();
    const runs = sandbox.calls.filter((call) => call.args[0] === "run");
    expect(sandbox.jobs.map((job) => job.probe)).toEqual([
      "memory",
      "pids",
      "time",
      "disk",
      "stdout",
    ]);
    // Only the in-container deadline differs per probe.
    const withoutDeadline = (args: readonly string[]) =>
      args.filter((arg) => !/^\d+s$/u.test(arg));
    expect(runs).toHaveLength(5);
    for (const call of runs)
      expect(withoutDeadline(call.args)).toEqual(
        withoutDeadline(
          buildSandboxRunArguments({
            image: IMAGE,
            containerName: call.args[call.args.indexOf("--name") + 1]!,
            inputDirectory: mountSource(call.args, "/job/in")!,
            appDist: APP_DIST,
            timeoutMs: 1,
          }),
        ),
      );
    const down = await (
      await runnerWith(
        inProcessSandbox({
          bounds: () => ({ exitCode: 125 }),
        }).spawn,
      )
    ).boundsCheck();
    expect(down).toEqual({
      status: "unavailable",
      reason: "sandbox_unavailable",
    });
    // Probe jobs leave nothing behind.
    expect(await readdir(work)).toEqual([]);
  }, 30_000);

  it("removes orphaned sandbox containers by name prefix, bounded", async () => {
    const names = Array.from(
      { length: 40 },
      (_, index) => `yoyi-wp-media-${index.toString(16).padStart(24, "0")}`,
    );
    const calls: string[][] = [];
    const runner = await runnerWith((_command, args) => {
      calls.push(args);
      const child = new (class {
        listeners = new Map<string, (...values: unknown[]) => void>();
        stdout = {
          on: (event: string, listener: (chunk: Buffer) => void) => {
            if (event === "data" && args[0] === "ps")
              setImmediate(() =>
                listener(
                  Buffer.from(
                    [...names, "other-container", "yoyi-wp-media-bad"].join(
                      "\n",
                    ),
                  ),
                ),
              );
          },
        };
        stderr = { resume: () => undefined };
        kill = () => true;
        on(event: string, listener: (...values: unknown[]) => void) {
          if (event === "close") setTimeout(() => listener(0), 5);
          return this;
        }
      })();
      return child as unknown as ReturnType<SandboxSpawn>;
    });
    expect(await runner.removeOrphanContainers()).toEqual({ removed: 32 });
    expect(calls[0]).toEqual([
      "ps",
      "--all",
      "--filter",
      "name=^yoyi-wp-media-",
      "--format",
      "{{.Names}}",
    ]);
    expect(calls.slice(1)).toEqual(
      names.slice(0, 32).map((name) => ["rm", "--force", name]),
    );
  });

  it("sweeps stale job directories but never an active job", async () => {
    const runner = await runnerWith(inProcessSandbox().spawn);
    const active = await runner.createJob();
    const activeRoot = path.dirname(active.inputDirectory);
    const leftover = path.join(work, `job-${"c".repeat(32)}`);
    const fresh = path.join(work, `job-${"d".repeat(32)}`);
    await mkdir(leftover);
    await mkdir(fresh);
    await writeFile(path.join(work, "keep.txt"), "x");
    const old = new Date(Date.now() - 3 * 3600_000);
    await utimes(leftover, old, old);
    await utimes(activeRoot, old, old);
    expect(await runner.sweepJobs(new Date(Date.now() - 3600_000))).toEqual({
      removed: 1,
    });
    expect((await readdir(work)).sort()).toEqual(
      [path.basename(activeRoot), path.basename(fresh), "keep.txt"].sort(),
    );
  });
});

describe("media sandbox protocol", () => {
  const sampleJob = async (): Promise<SandboxJob> => {
    const directory = await mkdtemp(path.join(base, "job-"));
    return stillJob({ inputPath: (name) => path.join(directory, name) });
  };

  it("round-trips every recipe: the renderer accepts it and both sides compute the same sizes", async () => {
    for (const role of [
      "thumb",
      "cover",
      "display",
      "viewer",
      "full",
    ] as const) {
      const directory = await mkdtemp(path.join(base, `${role}-`));
      const paths = {
        input: path.join(directory, "in"),
        work: path.join(directory, "work"),
        output: path.join(directory, "out"),
      };
      for (const entry of Object.values(paths)) await mkdir(entry);
      const bytes = await sharp({
        create: {
          width: 4200,
          height: 2800,
          channels: 3,
          background: "#808080",
        },
      })
        .jpeg({ quality: 50 })
        .toBuffer();
      await writeFile(path.join(paths.input, "still"), bytes);
      const recipe = currentRecipe(role);
      const request: SandboxJob = parseSandboxJob(
        JSON.parse(
          JSON.stringify({
            ...(await sampleJob()),
            item: {
              ...(await sampleJob()).item!,
              inputs: [
                {
                  role: "still",
                  declaredType: "image/jpeg",
                  byteSize: bytes.byteLength,
                  sha256: sha256(bytes),
                },
              ],
              renditions: [
                { role, version: recipe.version, digest: recipe.digest },
              ],
              placeholder: false,
            },
          }),
        ) as unknown,
      );
      const manifest = sandboxManifest(
        request,
        sandboxRuntime(),
        await renderSandboxJob(request, paths, {
          run: async () => {
            throw new Error("no tool");
          },
        }),
      );
      // The coordinator recomputes the size with the same registry.
      expect(() => validateSandboxManifest(manifest, request)).not.toThrow();
      expect(manifest.outputs.map((output) => output.role)).toEqual([role]);
      expect(parseSandboxManifest(JSON.stringify(manifest))).toEqual(manifest);
      // A renderer of another release (different digest) refuses the job.
      expect(() =>
        parseSandboxJob({
          ...request,
          item: {
            ...request.item!,
            renditions: [{ role, version: 1, digest: "0".repeat(16) }],
          },
        }),
      ).toThrow(SandboxJobError);
    }
  });

  it("validates job files strictly", async () => {
    const job = await sampleJob();
    expect(parseSandboxJob(JSON.parse(JSON.stringify(job)))).toEqual(job);
    const item = job.item!;
    for (const invalid of [
      { ...job, extra: 1 },
      { ...job, protocol: 2 },
      { ...job, nonce: "x" },
      { ...job, operation: "tiles" },
      { ...job, operation: "self-check" },
      { ...job, item: { ...item, motion: true } },
      { ...job, item: { ...item, renditions: [] } },
      {
        ...job,
        item: {
          ...item,
          placeholder: true,
          renditions: item.renditions.slice(1),
        },
      },
      {
        ...job,
        item: { ...item, renditions: [...item.renditions, item.renditions[0]] },
      },
      { ...job, item: { ...item, edit: { rotation: 45, crop: null } } },
      { ...job, item: { ...item, kind: "live" }, operation: "process" },
      { ...job, limits: { ...job.limits, tools: {} } },
    ])
      expect(() => parseSandboxJob(invalid)).toThrow(SandboxJobError);
    // A Live edit stages only what its renditions need.
    expect(
      parseSandboxJob({
        ...job,
        item: {
          ...item,
          kind: "live",
          inputs: [
            { ...item.inputs[0]!, role: "motion", declaredType: "video/mp4" },
          ],
          renditions: [],
          motion: true,
          placeholder: false,
        },
      }).item?.motion,
    ).toBe(true);
    expect(
      parseSandboxJob({ ...job, operation: "self-check", item: null }).item,
    ).toBeNull();
    // A bound probe names exactly one known probe and no item.
    const probe = {
      protocol: 1,
      nonce: job.nonce,
      operation: "bounds",
      probe: "pids",
      item: null,
      limits: job.limits,
    };
    expect(parseSandboxJob(probe)).toEqual(probe);
    for (const invalid of [
      { ...probe, probe: "network" },
      { ...probe, probe: undefined },
      { ...probe, item },
      { ...probe, operation: "self-check" },
      { ...job, probe: "pids" },
    ])
      expect(() => parseSandboxJob(invalid)).toThrow(SandboxJobError);
  });

  it("validates manifests strictly and refuses outputs the recipes do not produce", async () => {
    const request = await sampleJob();
    const inspection = { width: 64, height: 48, hasAlpha: false };
    const output = (role: StillRole, width: number, height: number) => ({
      name: `${role}.webp`,
      role,
      contentType: "image/webp" as const,
      width,
      height,
      durationMs: null,
      bytes: 10,
      sha256: "e".repeat(64),
    });
    const manifest: SandboxManifest = {
      protocol: 1,
      nonce: request.nonce,
      runtime: sandboxRuntime(),
      status: "derived",
      failureCode: null,
      inspection,
      detectedTypes: null,
      pairing: null,
      presentation: null,
      stillExifOrientation: null,
      placeholderColor: "#336699",
      outputs: [
        output("thumb", 64, 48),
        output("cover", 64, 48),
        output("display", 64, 48),
        output("full", 64, 48),
      ],
      selfCheck: null,
    };
    expect(() => validateSandboxManifest(manifest, request)).not.toThrow();
    const violation = (tampered: SandboxManifest) => {
      try {
        validateSandboxManifest(tampered, request);
      } catch (error) {
        return (error as SandboxProtocolError).violation;
      }
      return null;
    };
    // An upscaled or oversized output is refused.
    expect(
      violation({
        ...manifest,
        outputs: [output("thumb", 128, 96), ...manifest.outputs.slice(1)],
      }),
    ).toBe("dimensions_mismatch");
    // A viewer the recipe skips (equal to display) is an extra output.
    expect(
      violation({
        ...manifest,
        outputs: [...manifest.outputs, output("viewer", 64, 48)],
      }),
    ).toBe("outputs_mismatch");
    expect(violation({ ...manifest, outputs: manifest.outputs.slice(1) })).toBe(
      "outputs_mismatch",
    );
    expect(violation({ ...manifest, status: "processed" })).toBe(
      "status_mismatch",
    );
    expect(
      violation({
        ...manifest,
        detectedTypes: [{ role: "still", contentType: "image/jpeg" }],
      }),
    ).toBe("status_mismatch");
    expect(
      violation({ ...manifest, inspection: { ...inspection, width: 200_000 } }),
    ).toBe("dimensions_mismatch");
    // Strict parsing of the line itself.
    for (const invalid of [
      { ...manifest, extra: 1 },
      { ...manifest, failureCode: "decode_failed" },
      { ...manifest, status: "rejected" },
      { ...manifest, placeholderColor: "#ABCDEF" },
      { ...manifest, outputs: [manifest.outputs[0], manifest.outputs[0]] },
      {
        ...manifest,
        outputs: [{ ...manifest.outputs[0]!, name: "thumb.png" }],
      },
      { ...manifest, status: "self-check" },
      { ...manifest, bounds: { probe: "disk", count: 1, errorCode: null } },
    ])
      expect(() => parseSandboxManifest(JSON.stringify(invalid))).toThrow(
        SandboxProtocolError,
      );
    // A bound probe reports content-free facts and nothing else.
    const probed: SandboxManifest = {
      ...manifest,
      status: "bounds",
      inspection: null,
      placeholderColor: null,
      outputs: [],
      bounds: { probe: "disk", count: 255, errorCode: "ENOSPC" },
    };
    expect(parseSandboxManifest(JSON.stringify(probed))).toEqual(probed);
    for (const invalid of [
      { ...probed, bounds: undefined },
      { ...probed, bounds: { probe: "disk", count: -1, errorCode: null } },
      { ...probed, bounds: { probe: "disk", count: 1, errorCode: "no space" } },
      { ...probed, bounds: { probe: "gpu", count: 1, errorCode: null } },
      { ...probed, outputs: manifest.outputs },
    ])
      expect(() => parseSandboxManifest(JSON.stringify(invalid))).toThrow(
        SandboxProtocolError,
      );
    expect(() => parseSandboxManifest("{")).toThrow(SandboxProtocolError);
    expect(parseFrameHeader('{"end":true,"count":2}')).toEqual({
      kind: "end",
      count: 2,
    });
    for (const invalid of [
      '{"end":false,"count":1}',
      '{"name":"x","bytes":0,"sha256":"e"}',
      "[]",
    ])
      expect(() => parseFrameHeader(invalid)).toThrow(SandboxProtocolError);
  });
});
