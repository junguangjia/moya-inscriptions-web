import { describe, expect, it } from "vitest";

import {
  derivativeExpected,
  isVerifiedLive,
  itemStatus,
  retryPlan,
} from "./media-status";

import type { UploadItemView } from "../../upload-manager";
import type { PublishingMediaItem } from "@moya/contracts";

const ITEM_ID = `media-item-${"1".repeat(32)}`;

const view = (overrides: Partial<UploadItemView> = {}): UploadItemView => ({
  key: "k1",
  kind: "static",
  qualityMode: "standard",
  notCameraOriginal: false,
  phase: "queued",
  itemId: ITEM_ID,
  components: [
    {
      role: "still",
      contentType: "image/webp",
      byteSize: 200,
      bytesSent: 0,
      standardOutcome: "optimized",
      phase: "queued",
      failure: null,
    },
  ],
  failure: null,
  choice: null,
  recoverable: false,
  serverItem: null,
  ...overrides,
});

const server = (
  overrides: Partial<PublishingMediaItem> = {},
): PublishingMediaItem => ({
  id: ITEM_ID,
  kind: "live",
  qualityMode: "original",
  state: "ready",
  failureCode: null,
  components: [
    {
      id: `media-component-${"2".repeat(32)}`,
      role: "still",
      state: "verified",
      byteSize: 10,
      receivedBytes: 10,
    },
    {
      id: `media-component-${"3".repeat(32)}`,
      role: "motion",
      state: "verified",
      byteSize: 20,
      receivedBytes: 20,
    },
  ],
  presentation: { width: 4, height: 3, durationMs: 2900, hasAudio: true },
  media: {
    thumbSrc: `/api/community/publishing/media/${ITEM_ID}/thumb/base`,
    displaySrc: `/api/community/publishing/media/${ITEM_ID}/display/base`,
    motionSrc: `/api/community/publishing/media/${ITEM_ID}/motion/base`,
  },
  ...overrides,
});

describe("media item status", () => {
  it("names each distinct state and never reports 100 % as ready", () => {
    expect(itemStatus(view({ phase: "preprocessing" })).label).toBe("准备中");
    expect(itemStatus(view({ phase: "queued" })).label).toBe("等待上传");
    expect(
      itemStatus(
        view({
          phase: "uploading",
          components: [
            { ...view().components[0]!, phase: "uploading", bytesSent: 200 },
          ],
        }),
      ),
    ).toEqual({
      kind: "uploading",
      label: "文件已发送，等待确认",
      percent: 100,
    });
    expect(itemStatus(view({ phase: "uploaded" })).label).toBe(
      "已上传，等待处理",
    );
    expect(itemStatus(view({ phase: "processing" })).label).toBe("处理中");
    expect(itemStatus(view({ phase: "ready" })).label).toBe("已就绪");
    expect(itemStatus(view({ phase: "missing_local" })).kind).toBe(
      "missing_local",
    );
    expect(itemStatus(undefined, server({ state: "processing" })).label).toBe(
      "处理中",
    );
    expect(itemStatus(undefined).label).toBe("正在读取");
  });

  it("keeps byte progress visible before the server-confirmation wait", () => {
    expect(
      itemStatus(
        view({
          phase: "uploading",
          components: [
            { ...view().components[0]!, phase: "uploading", bytesSent: 198 },
          ],
        }),
      ),
    ).toEqual({ kind: "uploading", label: "上传中 99%", percent: 99 });
  });

  it("stops reading once everything has loaded and nobody describes the item", () => {
    expect(
      itemStatus(undefined, undefined, {
        loaded: false,
        item: { itemId: ITEM_ID },
      }).label,
    ).toBe("正在读取");
    // A pending item whose local file is gone needs re-selection.
    expect(
      itemStatus(undefined, undefined, {
        loaded: true,
        item: { itemId: null },
      }),
    ).toMatchObject({ kind: "missing_local", label: "缺少本地文件" });
    // A registered item the account view does not include cannot be read.
    expect(
      itemStatus(undefined, undefined, {
        loaded: true,
        item: { itemId: ITEM_ID },
      }),
    ).toMatchObject({ kind: "unavailable", label: "无法读取" });
  });

  it("knows whether a derivative will still come for a dialog preview", () => {
    expect(derivativeExpected(itemStatus(view({ phase: "uploading" })))).toBe(
      true,
    );
    expect(
      derivativeExpected(itemStatus(view({ phase: "missing_local" }))),
    ).toBe(false);
    expect(
      derivativeExpected(itemStatus(view({ phase: "needs_choice" }))),
    ).toBe(false);
    expect(
      derivativeExpected(
        itemStatus(
          view({
            phase: "failed",
            failure: {
              code: "preprocess_failed",
              message: "图片处理失败",
              outcomeUnknown: false,
            },
          }),
        ),
      ),
    ).toBe(false);
  });

  it("offers the retry that fits the failure, and none for final failures", () => {
    const failedComponent = view({
      phase: "failed",
      failure: {
        code: "network",
        message: "网络连接中断",
        outcomeUnknown: true,
      },
      components: [
        {
          ...view().components[0]!,
          phase: "failed",
          failure: {
            code: "network",
            message: "网络连接中断",
            outcomeUnknown: true,
          },
        },
      ],
    });
    expect(retryPlan(failedComponent)).toEqual({
      type: "components",
      roles: ["still"],
    });
    expect(
      retryPlan(
        view({
          phase: "failed",
          itemId: null,
          failure: {
            code: "register_failed",
            message: "暂时无法开始上传",
            outcomeUnknown: true,
          },
        }),
      ),
    ).toEqual({ type: "registration" });
    expect(
      retryPlan(
        view({
          phase: "failed",
          itemId: null,
          failure: {
            code: "preprocess_failed",
            message: "图片处理失败",
            outcomeUnknown: false,
          },
        }),
      ),
    ).toBe(null);
    expect(
      retryPlan(
        view({
          phase: "failed",
          serverItem: server({
            kind: "static",
            state: "failed",
            failureCode: "processing_timeout",
            media: null,
            presentation: null,
          }),
          failure: {
            code: "processing_timeout",
            message: "处理超时",
            outcomeUnknown: false,
          },
        }),
      ),
    ).toEqual({ type: "processing" });
  });

  it("shows LIVE only for a ready Live Photo the account verified", () => {
    const live = view({ kind: "live", phase: "ready", serverItem: server() });
    expect(isVerifiedLive(live)).toBe(true);
    expect(isVerifiedLive({ ...live, phase: "processing" })).toBe(false);
    expect(
      isVerifiedLive({
        ...live,
        serverItem: server({ state: "processing", media: null }),
      }),
    ).toBe(false);
    expect(isVerifiedLive({ ...live, kind: "static" })).toBe(false);
    expect(isVerifiedLive(undefined, server())).toBe(true);
    expect(isVerifiedLive(undefined, undefined)).toBe(false);
  });
});
