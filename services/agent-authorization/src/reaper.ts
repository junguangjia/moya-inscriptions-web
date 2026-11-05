import { PROVIDER_ARTIFACT_MODELS } from "@moya/community-postgres";

import type { ProviderBundle } from "./provider.js";

/**
 * Issue #355, login door: what keeps a public issuer's tables from growing.
 *
 * An anonymous authorize request writes rows and client ids are public, so this
 * runs in-process once an hour. Each store removes only what has already expired
 * and is bounded per statement, and a store is drained rather than taken once:
 * one batch an hour would fall behind what the issuer's rate limit lets in.
 */

const BATCH = 1000;
const MAX_BATCHES = 100;
const INTERVAL_MS = 60 * 60 * 1000;

const drain = async (remove: () => Promise<number>): Promise<void> => {
  for (let batch = 0; batch < MAX_BATCHES; batch += 1)
    if ((await remove()) < BATCH) return;
};

export const reapExpiredArtifacts = async (
  bundle: Pick<ProviderBundle, "Adapter" | "wrappers" | "consents">,
): Promise<void> => {
  for (const model of PROVIDER_ARTIFACT_MODELS) {
    const artifacts = new bundle.Adapter(model);
    await drain(() => artifacts.deleteExpired(BATCH));
  }
  await drain(() => bundle.wrappers.deleteExpired(new Date(), BATCH));
  await drain(() => bundle.consents.reapExpired(BATCH));
};

/**
 * The hourly timer, which never keeps the process alive and never runs twice at
 * once. A failed run leaves a bare code and the next hour tries again. Stopping
 * waits for a run in flight, so the pool is not closed underneath it.
 */
export const startArtifactReaper = (
  reap: () => Promise<void>,
  recordFailure: (code: string) => void,
): (() => Promise<void>) => {
  let running: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (running !== null) return;
    running = reap()
      .catch(() => recordFailure("ARTIFACT_REAP_FAILED"))
      .finally(() => {
        running = null;
      });
  }, INTERVAL_MS);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await running;
  };
};
