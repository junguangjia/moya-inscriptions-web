import { installProcessShutdownHandlers } from "@moya/backend-runtime";

import {
  openProductionPublishingMedia,
  openPublishingMedia,
  parseProductionPublishingMediaConfig,
  parsePublishingMediaConfig,
} from "./publishing/config.js";
import {
  MEDIA_WORKER_EXIT_CODES,
  MediaWorkerStartupError,
  startMediaWorker,
} from "./worker-composition.js";

/*
 * Media worker process entry (`node dist/worker-main.js`).
 *   (no flag)               run the worker until SIGTERM/SIGINT
 *   --sandbox-check         run only the sandbox self-check and print its
 *                           content-free JSON report (exit 0 when isolated
 *                           as configured, 1 otherwise)
 *   --sandbox-bounds-check  run only the active bound probes (memory,
 *                           processes, wall clock, output disk, stdout) for
 *                           acceptance, with the worker itself stopped, and
 *                           print their content-free JSON report (exit 0
 *                           when every bound held, 1 otherwise)
 * Exit codes: 0 stopped, 1 unexpected, 75 sandbox or daemon unavailable,
 * 78 configuration or isolation mismatch.
 */

const safeMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Unknown media worker error";

const openSandbox = async () => {
  const environment = process.env;
  const media =
    environment.NODE_ENV === "production"
      ? await openProductionPublishingMedia(
          parseProductionPublishingMediaConfig(environment),
        )
      : await (async () => {
          const config = parsePublishingMediaConfig(environment);
          if (config === null)
            throw new Error("Publishing media is not configured");
          return openPublishingMedia(config);
        })();
  return media.sandbox;
};

const report = (value: { readonly status: string }): number => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  return value.status === "ok" ? 0 : 1;
};

const main = async (): Promise<void> => {
  const flags = process.argv.slice(2);
  if (flags.length === 1 && flags[0] === "--sandbox-check") {
    process.exitCode = report(await (await openSandbox()).selfCheck());
    return;
  }
  if (flags.length === 1 && flags[0] === "--sandbox-bounds-check") {
    process.exitCode = report(await (await openSandbox()).boundsCheck());
    return;
  }
  if (flags.length > 0) {
    throw new MediaWorkerStartupError(
      MEDIA_WORKER_EXIT_CODES.config,
      "Unknown media worker argument",
    );
  }
  const worker = await startMediaWorker(process.env);
  installProcessShutdownHandlers(worker.stop);
};

main().catch((error: unknown) => {
  console.error(`[media-worker] startup failed: ${safeMessage(error)}`);
  process.exitCode =
    error instanceof MediaWorkerStartupError ? error.exitCode : 1;
});
