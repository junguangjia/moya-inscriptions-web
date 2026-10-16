import {
  canRetryProcessing,
  processingProgressText,
} from "../../upload-manager";

import type { ItemDerivation } from "../../edit-readiness";
import type { UploadItemView } from "../../upload-manager";
import type { MediaComponentRole, PublishingMediaItem } from "@moya/contracts";

/**
 * Per-item state wording for the media strip (U03): distinct preparation,
 * transfer, processing and readiness states, 100 % never shown as ready, and
 * the explicit action each interrupted state offers.
 */

export type RetryPlan =
  | { readonly type: "high_resolution" }
  | { readonly type: "processing" }
  | { readonly type: "registration" }
  | {
      readonly type: "components";
      readonly roles: readonly MediaComponentRole[];
    };

export type ItemStatus =
  | { readonly kind: "loading"; readonly label: string }
  | { readonly kind: "preparing"; readonly label: string }
  | { readonly kind: "queued"; readonly label: string }
  | {
      readonly kind: "uploading";
      readonly label: string;
      readonly percent: number;
    }
  | { readonly kind: "uploaded"; readonly label: string }
  | { readonly kind: "processing"; readonly label: string }
  | {
      readonly kind: "ready";
      readonly label: string;
      readonly background?: "pending" | "failed";
      readonly message?: string;
      readonly retry?: RetryPlan;
    }
  | {
      readonly kind: "paused";
      readonly label: string;
      readonly message: string | null;
    }
  | {
      readonly kind: "needs_choice";
      readonly label: string;
      readonly message: string;
    }
  | {
      readonly kind: "failed";
      readonly label: string;
      readonly message: string;
      readonly retry: RetryPlan | null;
    }
  | {
      readonly kind: "missing_local";
      readonly label: string;
      readonly message: string;
    }
  | {
      readonly kind: "unavailable";
      readonly label: string;
      readonly message: string;
    }
  | { readonly kind: "removing"; readonly label: string };

/** Failures a plain retry cannot fix: the author removes (or re-selects) the item. */
const FINAL_CODES = new Set([
  "preprocess_failed",
  "unavailable",
  "rejected",
  "missing_local",
]);

export const uploadPercent = (item: UploadItemView): number => {
  let total = 0;
  let sent = 0;
  for (const component of item.components) {
    total += component.byteSize;
    sent +=
      component.phase === "received"
        ? component.byteSize
        : Math.min(component.bytesSent, component.byteSize);
  }
  return total > 0 ? Math.floor((sent / total) * 100) : 0;
};

/** The explicit retry a failed item offers, if any. */
export const retryPlan = (item: UploadItemView): RetryPlan | null => {
  if (item.phase !== "failed") return null;
  if (canRetryProcessing(item)) return { type: "processing" };
  if (item.failure !== null && FINAL_CODES.has(item.failure.code)) return null;
  if (item.serverItem?.state === "failed") return null;
  if (item.itemId === null) return { type: "registration" };
  const roles = item.components
    .filter(
      (component) =>
        component.phase === "failed" &&
        !FINAL_CODES.has(component.failure?.code ?? ""),
    )
    .map((component) => component.role);
  return roles.length > 0 ? { type: "components", roles } : null;
};

/** What the strip knows about an item beyond the manager and account views. */
export interface StatusContext {
  /** The editor and the upload manager have loaded (no view will still arrive). */
  readonly loaded: boolean;
  readonly item: { readonly itemId: string | null };
  /**
   * Whether the item's edit derivatives (rotation, crop, cover crop) exist
   * on the account (edit-readiness.ts): a ready item is 处理中 until they
   * do, and 失败 when their derivation failed.
   */
  readonly derivation?: ItemDerivation;
}

const missingLocal = (): ItemStatus => ({
  kind: "missing_local",
  label: "缺少本地文件",
  message: "这台设备上没有这个文件，请重新选择",
});

/**
 * An item this browser's upload manager does not track (e.g. media of the
 * work an edit started from, before it is reopened here) shows the account's
 * own state. Once everything has loaded, an item neither describes is not
 * "loading" any more: a pending one lost its local file, a registered one
 * cannot be read.
 */
const serverStatus = (
  server: PublishingMediaItem | undefined,
  context: StatusContext | undefined,
): ItemStatus => {
  switch (server?.state) {
    case undefined:
      if (context?.loaded !== true)
        return { kind: "loading", label: "正在读取" };
      return context.item.itemId === null
        ? missingLocal()
        : {
            kind: "unavailable",
            label: "无法读取",
            message: "暂时无法读取这一项，可以移除后重新选择",
          };
    case "ready":
      return { kind: "ready", label: "已就绪" };
    case "processing":
      return { kind: "processing", label: "处理中" };
    case "failed":
      return {
        kind: "failed",
        label: "失败",
        message: "处理失败，请移除后重新选择",
        retry: null,
      };
    case "awaiting_upload":
      return missingLocal();
    case "cancelled":
    case "purged":
      return { kind: "removing", label: "已不可用" };
  }
};

/** A ready item with unconfirmed or failed edit derivatives is not ready (QA D1). */
const withDerivation = (
  status: ItemStatus,
  context: StatusContext | undefined,
): ItemStatus => {
  if (status.kind !== "ready") return status;
  switch (context?.derivation) {
    case "pending":
      return { kind: "processing", label: "处理中" };
    case "failed":
      return {
        kind: "failed",
        label: "失败",
        message: "编辑处理失败，可重新编辑或移除",
        retry: null,
      };
    default:
      return status;
  }
};

export const itemStatus = (
  item: UploadItemView | undefined,
  server?: PublishingMediaItem,
  context?: StatusContext,
): ItemStatus => withDerivation(baseStatus(item, server, context), context);

const baseStatus = (
  item: UploadItemView | undefined,
  server?: PublishingMediaItem,
  context?: StatusContext,
): ItemStatus => {
  if (item === undefined) return serverStatus(server, context);
  switch (item.phase) {
    case "waiting":
    case "preprocessing":
    case "registering":
      return { kind: "preparing", label: "准备中" };
    case "queued":
      return { kind: "queued", label: "等待上传" };
    case "uploading": {
      const percent = uploadPercent(item);
      return {
        kind: "uploading",
        label: percent === 100 ? "文件已发送，等待确认" : `上传中 ${percent}%`,
        percent,
      };
    }
    case "uploaded":
      return {
        kind: "uploaded",
        label: processingProgressText(item) ?? "已上传，等待处理",
      };
    case "processing":
      return {
        kind: "processing",
        label: processingProgressText(item) ?? "处理中",
      };
    case "ready": {
      const label = processingProgressText(item);
      if (
        item.processing?.highResolutionStatus === "failed" &&
        item.processingFailure?.code !== "progress_refreshing"
      )
        return {
          kind: "ready",
          label: label ?? "预览可用，高清图处理失败",
          background: "failed",
          retry: { type: "high_resolution" },
          message:
            item.processingFailure?.message ??
            "预览仍可使用，可以单独重试高清图",
        };
      return label === null
        ? { kind: "ready", label: "已就绪" }
        : { kind: "ready", label, background: "pending" };
    }
    case "paused":
      return {
        kind: "paused",
        label: "已暂停",
        message:
          item.components.find((component) => component.failure !== null)
            ?.failure?.message ?? null,
      };
    case "needs_choice":
      return {
        kind: "needs_choice",
        label: "需要选择",
        message:
          item.choice?.message ?? "此浏览器无法生成标准画质，可上传原图或移除",
      };
    case "failed":
      return {
        kind: "failed",
        label: "失败",
        message: item.failure?.message ?? "上传失败",
        retry: retryPlan(item),
      };
    case "missing_local":
      return missingLocal();
    case "cleanup":
    case "cancelled":
      return { kind: "removing", label: "正在移除" };
  }
};

/**
 * Whether the account will still produce a derivative for this item (so a
 * dialog can say "after processing"); false for items waiting on the author.
 */
export const derivativeExpected = (status: ItemStatus): boolean => {
  switch (status.kind) {
    case "loading":
    case "preparing":
    case "queued":
    case "uploading":
    case "uploaded":
    case "processing":
    case "paused":
    case "ready":
      return true;
    case "failed":
      return status.retry !== null;
    case "needs_choice":
    case "missing_local":
    case "unavailable":
    case "removing":
      return false;
  }
};

const verifiedLive = (server: PublishingMediaItem | null | undefined) =>
  server !== null &&
  server !== undefined &&
  server.state === "ready" &&
  server.kind === "live" &&
  server.media?.motionSrc !== undefined &&
  server.components.every((component) => component.state === "verified");

/** LIVE is shown only for a Live Photo the account verified and made ready. */
export const isVerifiedLive = (
  item: UploadItemView | undefined,
  server?: PublishingMediaItem,
): boolean =>
  item === undefined
    ? verifiedLive(server)
    : item.kind === "live" &&
      item.phase === "ready" &&
      verifiedLive(item.serverItem);
