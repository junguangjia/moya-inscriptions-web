import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  BOUNDS_PROBE_CEILINGS,
  runBoundsProbe,
} from "@moya/backend-production/internal/publishing-sandbox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/*
 * The in-container side of the active bound probes (W11), run in-process
 * with lowered ceilings: each probe reports how far it got and what stopped
 * it, and cleans up after itself. The real bounds are met only inside the
 * sandbox container (`worker-main.js --sandbox-bounds-check`); the runner
 * tests cover how the coordinator judges them.
 */

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "bounds-probe-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const noStdout = async () => {
  throw new Error("this probe never writes to stdout");
};

describe("media sandbox bound probes", () => {
  it("keeps every ceiling far above its sandbox bound", () => {
    expect(BOUNDS_PROBE_CEILINGS).toEqual({
      memoryMiB: 4096,
      children: 1024,
      diskMiB: 1024,
      stdoutMiB: 8,
    });
  });

  it("fills the output directory in MiB blocks and removes the fill", async () => {
    expect(
      await runBoundsProbe("disk", {
        fillDirectory: directory,
        writeStdout: noStdout,
        ceilings: { diskMiB: 3 },
      }),
    ).toEqual({ probe: "disk", count: 3, errorCode: null });
    expect(await readdir(directory)).toEqual([]);
    expect(
      await runBoundsProbe("disk", {
        fillDirectory: path.join(directory, "missing"),
        writeStdout: noStdout,
      }),
    ).toEqual({ probe: "disk", count: 0, errorCode: "ENOENT" });
  });

  it("starts waiting children up to its ceiling, reports a refusal and kills them", async () => {
    expect(
      await runBoundsProbe("pids", {
        fillDirectory: directory,
        writeStdout: noStdout,
        sleeper: path.join(directory, "missing-sleeper"),
        ceilings: { children: 3 },
      }),
    ).toEqual({ probe: "pids", count: 0, errorCode: "ENOENT" });
    expect(
      await runBoundsProbe("pids", {
        fillDirectory: directory,
        writeStdout: noStdout,
        sleeper: "/bin/sleep",
        ceilings: { children: 3 },
      }),
    ).toEqual({ probe: "pids", count: 3, errorCode: null });
  });

  it("touches the memory it allocates and floods stdout without a newline", async () => {
    expect(
      await runBoundsProbe("memory", {
        fillDirectory: directory,
        writeStdout: noStdout,
        ceilings: { memoryMiB: 64 },
      }),
    ).toEqual({ probe: "memory", count: 64, errorCode: null });
    const chunks: Buffer[] = [];
    expect(
      await runBoundsProbe("stdout", {
        fillDirectory: directory,
        writeStdout: async (chunk) => {
          chunks.push(chunk);
        },
        ceilings: { stdoutMiB: 1 },
      }),
    ).toBeNull();
    const flood = Buffer.concat(chunks);
    expect(flood.byteLength).toBe(1024 * 1024);
    expect(flood.includes(0x0a)).toBe(false);
  });
});
