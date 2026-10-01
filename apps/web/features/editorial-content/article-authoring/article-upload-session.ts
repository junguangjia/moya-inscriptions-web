import { authorClient } from "../../../lib/public-api/author-community-client";
import { publishingClient } from "../../../lib/public-api/work-publishing-client";
import { createBlobHasher } from "../../publishing/hashing";
import { createWorkerPreprocess } from "../../publishing/preprocess/worker-client";
import {
  TRANSFER_CONCURRENCY,
  preprocessConcurrency,
} from "../../publishing/preprocess/capabilities";
import { createUppyTransfer } from "../../publishing/uppy-transfer";
import { UploadManager } from "../../publishing/upload-manager";
import { createExternalStore } from "../../publishing/upload-manager-store";
import { resolveRuntimePresentationPlatform } from "../../shell/device-platform";
import type { ArticleDraft, ArticleMediaReference } from "@moya/contracts";

import { createArticleUploadLease } from "./article-upload-lease";

/** Reuses the established publishing upload pipeline; never submits a Work. */
export const createArticleUploadSession = (accountId: string) => {
  const epoch = authorClient.accountEpoch();
  const abort = new AbortController();
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let disposed = false;
  const error = createExternalStore<string | null>(null);
  const sameAccount = () =>
    !disposed &&
    authorClient.account() === accountId &&
    authorClient.accountEpoch() === epoch;
  const requireAccount = () => {
    if (!sameAccount()) throw new Error("article_upload_account_changed");
  };
  const lease = createArticleUploadLease({
    client: publishingClient,
    signal: abort.signal,
    requireAccount,
    requestId: () => crypto.randomUUID(),
    onSession: (session) => {
      if (heartbeat !== null) clearInterval(heartbeat);
      heartbeat =
        session === null
          ? null
          : setInterval(
              () => {
                if (!sameAccount()) return;
                void lease.heartbeat().catch(() => {
                  if (sameAccount())
                    error.set("上传会话续期未确认，请保留当前页面并重试。");
                });
              },
              10 * 60 * 1_000,
            );
    },
  });
  const manager = new UploadManager({
    accountId,
    client: { ...publishingClient, registerItem: lease.register },
    transfer: createUppyTransfer(TRANSFER_CONCURRENCY),
    preprocess: createWorkerPreprocess(),
    currentAccount: () => (sameAccount() ? accountId : null),
    requestId: () => crypto.randomUUID(),
    attemptId: () => crypto.randomUUID(),
    preprocessConcurrency: preprocessConcurrency(
      resolveRuntimePresentationPlatform(navigator, window.innerWidth),
    ),
    transferConcurrency: TRANSFER_CONCURRENCY,
    hasher: createBlobHasher(),
    // No Work DraftId, Work autosave, fabricated Work or new recovery store.
    // The temp session lease holds uploads until real Article save commits.
    recovery: null,
  });
  manager.bindSession({ saveMode: "unsaved", resolveHolder: lease.holder });
  manager.setPolling(true);
  const discard = lease.discard;
  return {
    manager,
    error,
    limits: () => publishingClient.limits(abort.signal),
    /** Called only after durable Article save and no unfinished upload remains. */
    releaseCommittedUploads: async (committed: ArticleDraft) => {
      requireAccount();
      if (committed.ownerId !== accountId)
        throw new Error("article_upload_not_owned");
      const used = new Set<string>();
      const append = (reference: ArticleMediaReference | undefined) => {
        if (reference?.type === "managed") used.add(reference.itemId);
      };
      if (committed.coverRefId !== null)
        append(committed.document.references[committed.coverRefId]);
      const walk = (blocks: ArticleDraft["document"]["blocks"]) => {
        for (const block of blocks) {
          if (block.type === "managedImage")
            append(committed.document.references[block.props.refId]);
          if (block.type === "imageGallery")
            for (const id of committed.document.galleries[block.props.groupId]
              ?.referenceIds ?? [])
              append(committed.document.references[id]);
          walk(block.children);
        }
      };
      walk(committed.document.blocks);
      return lease.retireCommitted(used, () => {
        const uploads = manager
          .getSnapshot()
          .items.filter(
            (item) => item.phase !== "cancelled" && item.phase !== "cleanup",
          );
        return !uploads.some(
          (item) =>
            item.phase !== "ready" ||
            item.itemId === null ||
            !used.has(item.itemId),
        );
      });
    },
    /** Explicitly abandon only this task's temporary upload session. */
    discard,
    dispose: () => {
      disposed = true;
      abort.abort();
      if (heartbeat !== null) clearInterval(heartbeat);
      heartbeat = null;
      lease.dispose();
      manager.release();
      manager.dispose();
    },
  };
};
export type ArticleUploadSession = ReturnType<
  typeof createArticleUploadSession
>;
