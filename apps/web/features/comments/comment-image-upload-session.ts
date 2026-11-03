import { COMMENT_IMAGE_LIMITS } from "../../lib/public-api/comment-images-client";
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

export type { UploadItemView as CommentImageUpload } from "../publishing/upload-manager";

/** Product text only; transport/lease exceptions must never reach the form. */
export class CommentImageError extends Error {}

/** Reuse the established upload/worker path with comment-only private items. */
export const createCommentUploadSession = (accountId: string) => {
  const epoch = authorClient.accountEpoch();
  const lifetime = new AbortController();
  let heartbeat: ReturnType<typeof setTimeout> | null = null;
  let leaseExpiresAt: string | null = null;
  let disposed = false;
  let closing = false;
  let pause: () => void = () => undefined;
  let abandoned: Promise<void> | null = null;
  const actions = new Set<string>();
  const settledRemoved = new Set<string>();
  let resuming: Promise<void> | null = null;
  let selecting = false;
  const sameAccount = () =>
    !disposed &&
    authorClient.account() === accountId &&
    authorClient.accountEpoch() === epoch;
  const requireAccount = () => {
    if (!sameAccount()) throw new Error("comment_upload_account_changed");
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
          { ...command, purpose: "comment" },
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
    // Comments need image content, not a separate EXIF/GPS metadata record.
    metadata: async () => ({
      provenance: {
        source: "client",
        parser: "comment-image-v1",
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
        new CommentImageError("图片连接已结束，请重新选择图片。"),
      );
    if (resuming !== null) return resuming;
    const next = (async () => {
      try {
        // Renew the exact existing holder. Never create a replacement session
        // or change item ids: a comment response may already have been saved.
        await lease.heartbeat();
        requireAccount();
        if (closing) throw new Error("comment_upload_closed");
        await manager.continueUploads();
        requireAccount();
        if (closing) throw new Error("comment_upload_closed");
        scheduleHeartbeat();
      } catch {
        if (sameAccount() && !closing) pause();
        throw new CommentImageError(
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
    add: async (files: readonly File[]): Promise<readonly string[]> => {
      if (selecting) throw new CommentImageError("正在添加图片，请稍候。");
      if (files.length === 0) return [];
      selecting = true;
      try {
        requireAccount();
        if (closing)
          throw new CommentImageError("图片上传会话已结束，请重新选择。");
        if (manager.getSnapshot().status === "paused") await resumeConnection();
        if (active().length + files.length > COMMENT_IMAGE_LIMITS.maxImages)
          throw new CommentImageError(
            `最多添加 ${COMMENT_IMAGE_LIMITS.maxImages} 张图片。`,
          );
        const confirmed: ConfirmedSource[] = [];
        for (const file of files) {
          if (file.size === 0 || file.size > COMMENT_IMAGE_LIMITS.maxBytes)
            throw new CommentImageError("请选择非空且不超过 10 MB 的图片。");
          const identified = await identifyFile(file);
          requireAccount();
          if (identified.kind !== "still")
            throw new CommentImageError(
              "请选择 JPEG、PNG、WebP、HEIC 或 HEIF 静态图片。",
            );
          confirmed.push({
            key: requestIdentity(),
            source: { kind: "static", still: identified },
            qualityMode:
              identified.type === "image/heic" ||
              identified.type === "image/heif"
                ? "original"
                : "standard",
            notCameraOriginal: false,
            clientSource: "picker",
          });
        }
        requireAccount();
        if (closing)
          throw new CommentImageError("图片上传会话已结束，请重新选择。");
        manager.addConfirmed(confirmed);
        return confirmed.map(({ key }) => key);
      } finally {
        selecting = false;
      }
    },
    remove: async (key: string) => {
      requireAccount();
      if (actions.has(key) || closing) return;
      const selected = active().find((item) => item.key === key);
      if (selected === undefined) return;
      actions.add(key);
      try {
        await manager.cancelItem(key);
        requireAccount();
        const cancelled = manager
          .getSnapshot()
          .items.find((item) => item.key === key);
        if (cancelled?.phase !== "cancelled")
          throw new CommentImageError("图片移除尚未确认，请重试。");
        // A known registration and explicit removal may be retired with the
        // holder. An item whose registration never returned an id is not added.
        if (cancelled.itemId !== null) settledRemoved.add(cancelled.itemId);
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
            throw new CommentImageError("这张图片无法处理，请更换图片。");
          await manager.retryProcessing(key);
        } else
          for (const component of item.components)
            if (component.phase === "failed" || component.phase === "paused")
              await manager.retryComponent(key, component.role);
      } finally {
        actions.delete(key);
      }
    },
    /** No per-item cancellation: durable pins are confirmed before retirement. */
    committed: async (used: ReadonlySet<string>) => {
      if (abandoned !== null) return abandoned;
      closing = true;
      manager.pause("offline");
      abandoned = lease
        .retireCommitted(
          used,
          () =>
            active().every(
              (item) =>
                item.phase === "ready" &&
                item.itemId !== null &&
                used.has(item.itemId),
            ),
          settledRemoved,
        )
        .then(() => undefined)
        .catch(() => undefined)
        .finally(dispose);
      return abandoned;
    },
    useOriginal: (key: string) => {
      requireAccount();
      if (!closing) manager.chooseOriginal(key);
    },
    abandon,
  };
};

export type CommentUploadSession = ReturnType<
  typeof createCommentUploadSession
>;
