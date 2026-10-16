import { describe, expect, it } from "vitest";
import { plannedStillRequests } from "@moya/backend-production/internal/publishing-processing";
import {
  publishingMediaItemSchema,
  publishingMediaItemProgressSchema,
} from "@moya/contracts/schemas";

describe("preview-first processing contracts", () => {
  it("requests only preview roles before HD and preserves the Catalog default", () => {
    expect(
      plannedStillRequests(["thumb", "display", "cover"], false).map(
        (request) => request.role,
      ),
    ).toEqual(["thumb", "cover", "display"]);
    expect(
      plannedStillRequests(["full"], true).map((request) => request.role),
    ).toEqual(["viewer", "full"]);
    expect(
      plannedStillRequests(["thumb", "display", "cover"]).map(
        (request) => request.role,
      ),
    ).toEqual(["thumb", "cover", "display", "viewer"]);
  });
  it("keeps the legacy item strict while validating a separate truthful progress envelope", () => {
    const item = {
      id: `media-item-${"a".repeat(32)}`,
      kind: "static",
      qualityMode: "standard",
      state: "ready",
      failureCode: null,
      components: [
        {
          id: `media-component-${"b".repeat(32)}`,
          role: "still",
          state: "verified",
          byteSize: 10,
          receivedBytes: 10,
        },
      ],
      presentation: { width: 6000, height: 4000 },
      media: {
        thumbSrc: `/api/community/publishing/media/media-item-${"a".repeat(32)}/thumb/base`,
        displaySrc: `/api/community/publishing/media/media-item-${"a".repeat(32)}/display/base`,
      },
    };
    const processing = {
      previewStatus: "ready",
      highResolutionStatus: "queued",
      completedRenditions: 3,
    };
    expect(publishingMediaItemSchema.safeParse(item).success).toBe(true);
    expect(
      publishingMediaItemSchema.safeParse({ ...item, processing }).success,
    ).toBe(false);
    expect(
      publishingMediaItemProgressSchema.safeParse({ item, processing }).success,
    ).toBe(true);
    expect(
      publishingMediaItemProgressSchema.safeParse({
        item,
        processing: { ...processing, completedRenditions: -1 },
      }).success,
    ).toBe(false);
  });
});
