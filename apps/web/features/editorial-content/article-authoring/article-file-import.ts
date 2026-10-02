import type { ArticleMediaReference } from "@moya/contracts";
import {
  addToStagingBatch,
  confirmStaging,
  identifyFiles,
} from "../../publishing/import-grouping";
import type { StagingBatch } from "../../publishing/import-grouping";
import type { UploadManager } from "../../publishing/upload-manager";

/** Safe product feedback; arbitrary worker/network errors are never displayed. */
export class ArticleFileImportError extends Error {}

/** File import uses the existing uploader and its authoritative readiness state. */
export const importArticleFiles = async (options: {
  readonly files: File[];
  readonly manager: Pick<
    UploadManager,
    "store" | "getSnapshot" | "addConfirmed"
  >;
  readonly maxItems: number;
  readonly signal: AbortSignal;
  readonly allowed: () => boolean;
  readonly recover: (
    batch: StagingBatch | null,
  ) => Promise<readonly ArticleMediaReference[]>;
}): Promise<readonly ArticleMediaReference[]> => {
  const { manager, signal } = options;
  const allowed = () => !signal.aborted && options.allowed();
  if (!allowed()) return [];
  const activeCount = () =>
    manager
      .getSnapshot()
      .items.filter(
        (item) => item.phase !== "cancelled" && item.phase !== "cleanup",
      ).length;
  if (options.files.length === 0) return [];
  if (
    options.files.length > options.maxItems ||
    activeCount() >= options.maxItems
  )
    throw new ArticleFileImportError(
      `本次最多上传 ${options.maxItems} 项素材，请减少选择。`,
    );
  const batch = addToStagingBatch(
    null,
    await identifyFiles(options.files),
    "drop",
  );
  if (!allowed()) return [];
  const result = confirmStaging(batch, activeCount(), options.maxItems);
  if (!result.ok && result.error === "items_limit")
    throw new ArticleFileImportError(
      `本次最多上传 ${options.maxItems} 项素材，请减少选择。`,
    );
  // Reuse the existing pairing/original/retry UI when a file requires a choice.
  // Never silently discard one file from a multi-file drop.
  if (
    !result.ok ||
    result.remaining !== null ||
    batch.entries.some((entry) => entry.status !== "ready")
  )
    return options.recover(batch);
  manager.addConfirmed(result.confirmed);
  const keys = result.confirmed.map((item) => item.key);
  const references = await new Promise<readonly ArticleMediaReference[] | null>(
    (resolve) => {
      let finished = false;
      let unsubscribe = () => {};
      const finish = (value: readonly ArticleMediaReference[] | null) => {
        if (finished) return;
        finished = true;
        unsubscribe();
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const onAbort = () => finish([]);
      const timer = setTimeout(() => finish(null), 120_000);
      const inspect = () => {
        if (!allowed()) return finish([]);
        const state = manager.getSnapshot();
        const items = keys.map((key) =>
          state.items.find((item) => item.key === key),
        );
        if (
          state.status !== "active" ||
          items.some(
            (item) =>
              item === undefined ||
              [
                "needs_choice",
                "failed",
                "paused",
                "missing_local",
                "cancelled",
                "cleanup",
              ].includes(item.phase),
          )
        )
          return finish(null);
        if (
          items.every(
            (item) =>
              item?.phase === "ready" &&
              item.serverItem?.state === "ready" &&
              item.serverItem.media !== null,
          )
        )
          finish(
            items.map((item) => ({
              type: "managed",
              itemId: item!.serverItem!.id,
            })),
          );
      };
      unsubscribe = manager.store.subscribe(inspect);
      signal.addEventListener("abort", onAbort, { once: true });
      inspect();
    },
  );
  if (!allowed()) return [];
  return references ?? options.recover(null);
};
