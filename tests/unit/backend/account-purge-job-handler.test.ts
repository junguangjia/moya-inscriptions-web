import {
  ACCOUNT_PURGE_BATCHES_PER_RUN,
  ACCOUNT_PURGE_CONTINUE_MS,
  MEDIA_WORKER_JOB_KINDS,
  createPublishingJobHandlers,
} from "@moya/backend-production/internal/publishing-job-handlers";
import { describe, expect, it, vi } from "vitest";

import type {
  PublishingJobHandlerOptions,
  PublishingWorkerJobClaim,
  PublishingWorkerPort,
} from "@moya/backend-production/internal/publishing-job-handlers";

/*
 * The `purge_deleted_account` job handler (account-deletion-v1): a user id
 * subject only; committed batches of the port's purge until nothing is left,
 * bounded per claim, the rest deferred with attempts kept; an abort between
 * batches leaves the committed ones and gives the job back; transfers of
 * cancelled items reach the upload registry. The purge itself runs against
 * PostgreSQL in tests/integration/postgres/account-purge.test.ts.
 */

const NOW = new Date("2026-10-27T12:00:00.000Z");
const hex = (seed: number) => seed.toString(16).padStart(32, "0");
const ACCOUNT = `user-${hex(51)}`;
const silent = { info: () => undefined, error: () => undefined };

type Purge = Awaited<ReturnType<PublishingWorkerPort["purgeDeletedAccount"]>>;
const outcome = (
  status: Purge["status"],
  cancelledComponentIds: string[] = [],
): Purge => ({ status, cancelledComponentIds });

const claim = (subjectId: string): PublishingWorkerJobClaim => ({
  id: `publishing-job-${hex(1)}`,
  kind: "purge_deleted_account",
  subjectId,
  payload: null,
  attempts: 1,
  maxAttempts: 5,
  leaseOwner: "worker.1",
  leaseExpiresAt: new Date(NOW.getTime() + 300_000),
});

const handlersFor = (
  outcomes: readonly (Purge | Error)[],
  options: Partial<PublishingJobHandlerOptions> = {},
) => {
  let call = 0;
  const purgeDeletedAccount = vi.fn(async () => {
    const next = outcomes[Math.min(call, outcomes.length - 1)]!;
    call += 1;
    if (next instanceof Error) throw next;
    return next;
  });
  const handlers = createPublishingJobHandlers({
    port: { purgeDeletedAccount } as unknown as PublishingWorkerPort,
    store: {} as PublishingJobHandlerOptions["store"],
    clock: () => NOW,
    logger: silent,
    ...options,
  });
  return { handlers, purgeDeletedAccount };
};

describe("purge_deleted_account job handler", () => {
  it("is claimed by the media worker beside the other purges", () => {
    expect(MEDIA_WORKER_JOB_KINDS).toContain("purge_deleted_account");
  });

  it("refuses a subject that is not a user id without touching the port", async () => {
    const { handlers, purgeDeletedAccount } = handlersFor([outcome("purged")]);
    const signal = new AbortController().signal;
    for (const subject of [
      `work-${hex(5)}`,
      `user-${hex(0xabcdef).toUpperCase()}`,
      "media-store",
      `user-${hex(5)}x`,
    ])
      expect(await handlers.run(claim(subject), signal)).toEqual({
        status: "failed",
        errorCode: "invalid_job_subject",
        retryable: false,
      });
    expect(purgeDeletedAccount).not.toHaveBeenCalled();
  });

  it.each(["purged", "missing"] as const)(
    "completes once the port answers %s",
    async (status) => {
      const { handlers, purgeDeletedAccount } = handlersFor([outcome(status)]);
      expect(
        await handlers.run(claim(ACCOUNT), new AbortController().signal),
      ).toEqual({ status: "completed" });
      expect(purgeDeletedAccount).toHaveBeenCalledTimes(1);
      expect(purgeDeletedAccount).toHaveBeenCalledWith(ACCOUNT, NOW);
    },
  );

  it("runs batches until the account is purged and stops their transfers", async () => {
    const onUploadsCancelled = vi.fn();
    const first = [`media-component-${hex(1)}`, `media-component-${hex(2)}`];
    const { handlers, purgeDeletedAccount } = handlersFor(
      [outcome("partial", first), outcome("partial"), outcome("purged")],
      { onUploadsCancelled },
    );
    expect(
      await handlers.run(claim(ACCOUNT), new AbortController().signal),
    ).toEqual({ status: "completed" });
    expect(purgeDeletedAccount).toHaveBeenCalledTimes(3);
    // Only batches that cancelled transfers notify the registry.
    expect(onUploadsCancelled).toHaveBeenCalledTimes(1);
    expect(onUploadsCancelled).toHaveBeenCalledWith(first);
  });

  it("defers the rest, attempts kept, after its batch bound", async () => {
    const { handlers, purgeDeletedAccount } = handlersFor([outcome("partial")]);
    expect(
      await handlers.run(claim(ACCOUNT), new AbortController().signal),
    ).toEqual({ status: "deferred", delayMs: ACCOUNT_PURGE_CONTINUE_MS });
    expect(purgeDeletedAccount).toHaveBeenCalledTimes(
      ACCOUNT_PURGE_BATCHES_PER_RUN,
    );
    // The queue's deferral bound (`deferJob`).
    expect(ACCOUNT_PURGE_CONTINUE_MS).toBeGreaterThanOrEqual(1);
    expect(ACCOUNT_PURGE_CONTINUE_MS).toBeLessThanOrEqual(300_000);
  });

  it("starts no batch after an abort; committed batches stay committed", async () => {
    const controller = new AbortController();
    const reason = new Error("lease lost");
    const purgeDeletedAccount = vi.fn(async () => {
      // The abort arrives while the first batch commits.
      controller.abort(reason);
      return outcome("partial");
    });
    const handlers = createPublishingJobHandlers({
      port: { purgeDeletedAccount } as unknown as PublishingWorkerPort,
      store: {} as PublishingJobHandlerOptions["store"],
      clock: () => NOW,
      logger: silent,
    });
    await expect(handlers.run(claim(ACCOUNT), controller.signal)).rejects.toBe(
      reason,
    );
    expect(purgeDeletedAccount).toHaveBeenCalledTimes(1);

    const aborted = new AbortController();
    aborted.abort(reason);
    const idle = handlersFor([outcome("purged")]);
    await expect(
      idle.handlers.run(claim(ACCOUNT), aborted.signal),
    ).rejects.toBe(reason);
    expect(idle.purgeDeletedAccount).not.toHaveBeenCalled();
  });

  it("leaves a failed batch to the worker's classification", async () => {
    const failure = Object.assign(new Error("deadlock detected"), {
      code: "40P01",
    });
    const { handlers, purgeDeletedAccount } = handlersFor([
      outcome("partial"),
      failure,
    ]);
    await expect(
      handlers.run(claim(ACCOUNT), new AbortController().signal),
    ).rejects.toBe(failure);
    expect(purgeDeletedAccount).toHaveBeenCalledTimes(2);
  });

  it("logs a failing upload registry and still finishes the purge", async () => {
    const error = vi.fn();
    const { handlers } = handlersFor(
      [outcome("purged", [`media-component-${hex(3)}`])],
      {
        onUploadsCancelled: () => {
          throw new Error("registry down");
        },
        logger: { info: () => undefined, error },
      },
    );
    expect(
      await handlers.run(claim(ACCOUNT), new AbortController().signal),
    ).toEqual({ status: "completed" });
    expect(error).toHaveBeenCalledWith(
      "[publishing-worker] upload registry notification failed",
    );
  });
});
