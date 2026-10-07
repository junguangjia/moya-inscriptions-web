import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import path from "node:path";

import type { ChildProcess } from "node:child_process";
import type { SandboxBoundsFacts, SandboxBoundsProbe } from "./protocol.js";

/*
 * The in-container side of the active bound probes (W11). Acceptance only:
 * the coordinator writes such a job solely for the worker's
 * `--sandbox-bounds-check`. Each probe drives one resource of its own
 * sandbox container towards a ceiling far above the configured bound and
 * reports how far it got; the memory and time probes end with the container
 * killed, the stdout probe with the coordinator stopping the stream. No
 * probe reads input bytes or reaches the network, and each one is finite
 * even in a sandbox that does not enforce its bound.
 */

const MIB = 1024 * 1024;

/** Probe ceilings, each far above its sandbox bound (W8). */
export const BOUNDS_PROBE_CEILINGS = {
  /** Container memory is 1536 MiB without swap. */
  memoryMiB: 4096,
  /** The container allows 256 tasks in total. */
  children: 1024,
  /** The output tmpfs holds 256 MiB. */
  diskMiB: 1024,
  /** The manifest line may not exceed 256 KiB. */
  stdoutMiB: 8,
} as const;

export type BoundsProbeCeilings = {
  readonly [Name in keyof typeof BOUNDS_PROBE_CEILINGS]: number;
};

export interface BoundsProbeOptions {
  /** Directory the disk probe fills (the output tmpfs in the container). */
  readonly fillDirectory: string;
  /** The renderer's stdout writer (resolves once a chunk is accepted). */
  readonly writeStdout: (chunk: Buffer) => Promise<void>;
  /** Executable the PID probe starts and keeps waiting. */
  readonly sleeper?: string;
  /** Lower ceilings (tests); never higher than the defaults. */
  readonly ceilings?: Partial<BoundsProbeCeilings>;
}

const SLEEPER = "/usr/bin/sleep";
const ERRNO = /^[A-Za-z_]{1,32}$/;

const errorCodeOf = (error: unknown, fallback: string): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && ERRNO.test(code) ? code : fallback;
};

const ceiling = (
  options: BoundsProbeOptions,
  name: keyof typeof BOUNDS_PROBE_CEILINGS,
): number =>
  Math.min(
    options.ceilings?.[name] ?? BOUNDS_PROBE_CEILINGS[name],
    BOUNDS_PROBE_CEILINGS[name],
  );

/** Touches every page it allocates, so only the cgroup can stop it. */
async function probeMemory(
  options: BoundsProbeOptions,
): Promise<SandboxBoundsFacts> {
  const held: Buffer[] = [];
  const chunkMiB = 32;
  let errorCode: string | null = null;
  try {
    while (held.length * chunkMiB < ceiling(options, "memoryMiB")) {
      held.push(Buffer.allocUnsafe(chunkMiB * MIB).fill(0x5a));
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  } catch (error) {
    errorCode = errorCodeOf(error, "ENOMEM");
  }
  const count = held.length * chunkMiB;
  held.length = 0;
  return { probe: "memory", count, errorCode };
}

/** Starts waiting child processes until the task limit refuses one. */
async function probePids(
  options: BoundsProbeOptions,
): Promise<SandboxBoundsFacts> {
  const children: ChildProcess[] = [];
  let errorCode: string | null = null;
  try {
    while (children.length < ceiling(options, "children")) {
      let child: ChildProcess;
      try {
        child = spawn(options.sleeper ?? SLEEPER, ["600"], {
          stdio: "ignore",
          env: {} as NodeJS.ProcessEnv,
          shell: false,
        });
      } catch (error) {
        errorCode = errorCodeOf(error, "spawn_failed");
        break;
      }
      const failed = await new Promise<string | null>((resolve) => {
        child.once("spawn", () => resolve(null));
        child.once("error", (error) =>
          resolve(errorCodeOf(error, "spawn_failed")),
        );
      });
      if (failed !== null) {
        errorCode = failed;
        break;
      }
      children.push(child);
    }
  } finally {
    for (const child of children) child.kill("SIGKILL");
  }
  return { probe: "pids", count: children.length, errorCode };
}

/** Writes MiB blocks into the fill directory until it is full, then removes them. */
async function probeDisk(
  options: BoundsProbeOptions,
): Promise<SandboxBoundsFacts> {
  const target = path.join(
    options.fillDirectory,
    `bounds-fill-${randomBytes(8).toString("hex")}`,
  );
  let count = 0;
  let errorCode: string | null = null;
  let handle;
  try {
    handle = await open(target, "wx", 0o600);
  } catch (error) {
    return { probe: "disk", count, errorCode: errorCodeOf(error, "EIO") };
  }
  const block = Buffer.alloc(MIB, 0x5a);
  try {
    while (count < ceiling(options, "diskMiB")) {
      const { bytesWritten } = await handle.write(block, 0, MIB);
      if (bytesWritten !== MIB) {
        errorCode = "ENOSPC";
        break;
      }
      count += 1;
    }
  } catch (error) {
    errorCode = errorCodeOf(error, "EIO");
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(target).catch(() => undefined);
  }
  return { probe: "disk", count, errorCode };
}

/** Floods stdout without a newline; the coordinator must stop it. */
async function probeStdout(options: BoundsProbeOptions): Promise<void> {
  const chunk = Buffer.alloc(64 * 1024, 0x78);
  const limit = ceiling(options, "stdoutMiB") * MIB;
  for (let written = 0; written < limit; written += chunk.byteLength) {
    await options.writeStdout(chunk);
  }
}

/**
 * Runs one probe. Resolves the facts to report for `memory` (only when the
 * container was not killed), `pids` and `disk`; `null` after a `stdout`
 * flood; `time` never resolves (the container is killed at its deadline).
 */
export async function runBoundsProbe(
  probe: SandboxBoundsProbe,
  options: BoundsProbeOptions,
): Promise<SandboxBoundsFacts | null> {
  switch (probe) {
    case "memory":
      return probeMemory(options);
    case "pids":
      return probePids(options);
    case "disk":
      return probeDisk(options);
    case "stdout":
      await probeStdout(options);
      return null;
    case "time":
      return new Promise<never>(() => {
        setInterval(() => undefined, 60_000);
      });
  }
}
