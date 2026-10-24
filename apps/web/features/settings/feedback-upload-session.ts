import { feedbackImageLimits } from "../../lib/public-api/feedback-client";
import { publishingClient } from "../../lib/public-api/work-publishing-client";
import { authorClient } from "../authors/author-data";
import { requestIdentity } from "../shell/request-identity";
import { resolveRuntimePresentationPlatform } from "../shell/device-platform";
import { identifyFile } from "../publishing/import-grouping";
import { createBlobHasher } from "../publishing/hashing";
import { createWorkerPreprocess } from "../publishing/preprocess/worker-client";
import {
  TRANSFER_CONCURRENCY,
  preprocessConcurrency,
} from "../publishing/preprocess/capabilities";
import { createUppyTransfer } from "../publishing/uppy-transfer";
import {
  UploadManager,
  canRetryProcessing,
} from "../publishing/upload-manager";
import { createTemporaryUploadLease } from "../publishing/temporary-upload-lease";
import type { ConfirmedSource } from "../publishing/import-grouping";

export type { UploadItemView as FeedbackImageUpload } from "../publishing/upload-manager";

/** Product text only; transport/lease exceptions must never reach the form. */
export class FeedbackImageError extends Error {}

/** Reuse the established upload/worker path with feedback-only private items. */
export const createFeedbackUploadSession = (accountId: string) => {
  const epoch = authorClient.accountEpoch();
  const lifetime = new AbortController();
  let heartbeat: ReturnType<typeof setTimeout> | null = null;
  let leaseExpiresAt: string | null = null;
  let disposed = false;
  let closing = false;
  let pause: () => void = () => undefined;
  let abandoned: Promise<void> | null = null;
  const actions = new Set<string>();
  let resuming: Promise<void> | null = null;
  const sameAccount = () =>
    !disposed &&
    authorClient.account() === accountId &&
    authorClient.accountEpoch() === epoch;
  const requireAccount = () => {
    if (!sameAccount()) throw new Error("feedback_upload_account_changed");
  };
  const scheduleHeartbeat = (): void => {
    if (heartbeat !== null) clearTimeout(heartbeat);
    heartbeat = null;
    if (leaseExpiresAt === null || closing || !sameAccount()) return;
    const remaining = Date.parse(leaseExpiresAt) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 250) {
      pause();
      return;
    }
    // Short Owner-configured leases need renewal before the ordinary ten-minute
    // cadence; renew halfway through the lease actually returned by Backend.
    const delay = Math.max(
      250,
      Math.min(10 * 60 * 1000, Math.floor(remaining / 2)),
    );
    heartbeat = setTimeout(() => {
      if (!sameAccount() || closing) return;
      void lease
        .heartbeat()
        .then(scheduleHeartbeat)
        .catch(() => pause());
    }, delay);
  };
  const lease = createTemporaryUploadLease({
    client: {
      ...publishingClient,
      heartbeatSession: async (id, signal) => {
        const answer = await publishingClient.heartbeatSession(id, signal);
        leaseExpiresAt = answer.leaseExpiresAt;
        return answer;
      },
      registerItem: (command, signal) =>
        publishingClient.registerItem(
          { ...command, purpose: "feedback" },
          signal,
        ),
    },
    signal: lifetime.signal,
    requireAccount,
    requestId: requestIdentity,
    onSession: (session) => {
      leaseExpiresAt = session?.leaseExpiresAt ?? null;
      scheduleHeartbeat();
    },
  });
  const manager = new UploadManager({
    accountId,
    client: { ...publishingClient, registerItem: lease.register },
    transfer: createUppyTransfer(TRANSFER_CONCURRENCY),
    preprocess: createWorkerPreprocess(),
    currentAccount: () => (sameAccount() ? accountId : null),
    requestId: requestIdentity,
    attemptId: requestIdentity,
    preprocessConcurrency: preprocessConcurrency(
      resolveRuntimePresentationPlatform(navigator, window.innerWidth),
    ),
    transferConcurrency: TRANSFER_CONCURRENCY,
    hasher: createBlobHasher(),
    recovery: null,
    // Feedback needs image content, not a separate EXIF/GPS metadata record.
    metadata: async () => ({
      provenance: {
        source: "client",
        parser: "feedback-image-v1",
        status: "absent",
      },
      values: {},
    }),
  });
  pause = () => manager.pause("offline");
  manager.bindSession({ saveMode: "unsaved", resolveHolder: lease.holder });
  manager.setPolling(true);
  const active = () =>
    manager.getSnapshot().items.filter((item) => item.phase !== "cancelled");
  const dispose = () => {
    disposed = true;
    lifetime.abort();
    if (heartbeat !== null) clearTimeout(heartbeat);
    heartbeat = null;
    lease.dispose();
    manager.release();
    manager.dispose();
  };
  const abandon = () => {
    if (abandoned !== null) return abandoned;
    closing = true;
    manager.pause("offline");
    // On account change no old-account write is attempted. The bounded server
    // lease expires; a failed discard likewise never creates a permanent hold.
    abandoned = lease
      .discard()
      .catch(() => undefined)
      .finally(dispose);
    return abandoned;
  };
  const resumeConnection = (): Promise<void> => {
    requireAccount();
    if (closing)
      return Promise.reject(
        new FeedbackImageError("图片连接已结束，请重新选择图片。"),
      );
    if (resuming !== null) return resuming;
    const next = (async () => {
      try {
        // Renew the exact existing holder. Never create a replacement session
        // or change item ids: a feedback response may already have been saved.
        await lease.heartbeat();
        requireAccount();
        if (closing) throw new Error("feedback_upload_closed");
        await manager.continueUploads();
        requireAccount();
        if (closing) throw new Error("feedback_upload_closed");
        scheduleHeartbeat();
      } catch {
        if (sameAccount() && !closing) pause();
        throw new FeedbackImageError(
          "图片连接暂时无法恢复，请重试；仍不可用时请移除图片后重新添加。",
        );
      }
    })();
    resuming = next;
    void next.then(
      () => {
        if (resuming === next) resuming = null;
      },
      () => {
        if (resuming === next) resuming = null;
      },
    );
    return next;
  };
  return {
    owner: accountId,
    manager,
    subscribe: manager.store.subscribe,
    snapshot: manager.store.get,
    localStill: (key: string) => manager.localStill(key),
    resumeConnection,
    add: async (files: readonly File[]) => {
      requireAccount();
      if (closing)
        throw new FeedbackImageError("图片上传会话已结束，请重新选择。");
      if (manager.getSnapshot().status === "paused") await resumeConnection();
      if (active().length + files.length > feedbackImageLimits.maxImages)
        throw new FeedbackImageError(
          `最多添加 ${feedbackImageLimits.maxImages} 张图片。`,
        );
      const confirmed: ConfirmedSource[] = [];
      for (const file of files) {
        if (file.size === 0 || file.size > feedbackImageLimits.maxBytes)
          throw new FeedbackImageError("请选择非空且不超过 10 MB 的图片。");
        const identified = await identifyFile(file);
        requireAccount();
        if (identified.kind !== "still")
          throw new FeedbackImageError(
            "请选择 JPEG、PNG、WebP、HEIC 或 HEIF 静态图片。",
          );
        confirmed.push({
          key: requestIdentity(),
          source: { kind: "static", still: identified },
          qualityMode:
            identified.type === "image/heic" || identified.type === "image/heif"
              ? "original"
              : "standard",
          notCameraOriginal: false,
          clientSource: "picker",
        });
      }
      requireAccount();
      if (closing)
        throw new FeedbackImageError("图片上传会话已结束，请重新选择。");
      manager.addConfirmed(confirmed);
    },
    remove: async (key: string) => {
      requireAccount();
      if (actions.has(key) || closing) return;
      actions.add(key);
      try {
        await manager.cancelItem(key);
        requireAccount();
        manager.forget(key);
      } finally {
        actions.delete(key);
      }
    },
    retry: async (key: string) => {
      requireAccount();
      const item = active().find((candidate) => candidate.key === key);
      if (item === undefined || closing || actions.has(key)) return;
      actions.add(key);
      try {
        if (manager.getSnapshot().status === "paused") await resumeConnection();
        if (item.itemId === null) manager.retryRegistration(key);
        else if (item.serverItem?.state === "failed") {
          if (!canRetryProcessing(item))
            throw new FeedbackImageError("这张图片无法处理，请更换图片。");
          await manager.retryProcessing(key);
        } else
          for (const component of item.components)
            if (component.phase === "failed" || component.phase === "paused")
              await manager.retryComponent(key, component.role);
      } finally {
        actions.delete(key);
      }
    },
    /** Invoke only after the feedback receipt confirms durable image pins. */
    committed: abandon,
    abandon,
  };
};

export type FeedbackUploadSession = ReturnType<
  typeof createFeedbackUploadSession
>;
