import { readFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

import { SANDBOX_OUTPUT_LIMITS } from "../processing/profiles.js";
import { runBoundsProbe } from "./bounds-probe.js";
import { probeIsolation } from "./isolation-probe.js";
import { createLocalToolRunner } from "./local-tools.js";
import {
  SANDBOX_EXIT_CODES,
  SANDBOX_JOB_FILE,
  SANDBOX_PATHS,
  parseSandboxJob,
} from "./protocol.js";
import {
  renderSandboxJob,
  sandboxManifest,
  writeSandboxStream,
} from "./renderer.js";
import {
  configureSandboxSharp,
  loaderAllowlistHolds,
} from "./sandbox-sharp.js";

import type { SandboxJob } from "./protocol.js";

/*
 * Entry of the media sandbox container (`node renderer-main.js`, run by the
 * coordinator under `timeout --signal=KILL`). Reads `/job/in/job.json`,
 * configures sharp for untrusted input, renders, self-checks or runs one
 * active bound probe, and writes the framed stream to stdout. Exit 0: a
 * manifest was written (also for content rejections) or a probe ended; 64:
 * the job file was refused; 70: internal failure. Nothing is logged: stderr
 * stays empty unless the runtime itself fails.
 */

const writeStdout = (chunk: Buffer) =>
  new Promise<void>((resolve, reject) => {
    process.stdout.write(chunk, (error) => (error ? reject(error) : resolve()));
  });

async function main(): Promise<number> {
  configureSandboxSharp();
  let job: SandboxJob;
  try {
    const raw = await readFile(
      path.join(SANDBOX_PATHS.input, SANDBOX_JOB_FILE),
    );
    if (raw.byteLength > SANDBOX_OUTPUT_LIMITS.jobFileBytes) throw new Error();
    job = parseSandboxJob(JSON.parse(raw.toString("utf8")) as unknown);
  } catch {
    return SANDBOX_EXIT_CODES.invalidJob;
  }
  const runtime = {
    node: process.versions.node,
    sharp: sharp.versions.sharp ?? "",
    vips: sharp.versions.vips,
  };
  if (job.operation === "bounds") {
    const facts = await runBoundsProbe(job.probe!, {
      fillDirectory: SANDBOX_PATHS.output,
      writeStdout,
    });
    if (facts !== null) {
      await writeSandboxStream(
        sandboxManifest(job, runtime, { bounds: facts }),
        SANDBOX_PATHS.output,
        writeStdout,
      );
    }
    return 0;
  }
  const manifest =
    job.operation === "self-check"
      ? sandboxManifest(job, runtime, {
          selfCheck: await probeIsolation(
            {
              root: "/",
              app: SANDBOX_PATHS.app,
              input: SANDBOX_PATHS.input,
              tmp: SANDBOX_PATHS.tmp,
              work: SANDBOX_PATHS.work,
              output: SANDBOX_PATHS.output,
            },
            await loaderAllowlistHolds(SANDBOX_PATHS.tmp),
          ),
        })
      : sandboxManifest(
          job,
          runtime,
          await renderSandboxJob(
            job,
            {
              input: SANDBOX_PATHS.input,
              work: SANDBOX_PATHS.work,
              output: SANDBOX_PATHS.output,
            },
            createLocalToolRunner(),
          ),
        );
  await writeSandboxStream(manifest, SANDBOX_PATHS.output, writeStdout);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    process.exitCode = SANDBOX_EXIT_CODES.internal;
  },
);
