import {
  articleCollectionMemberSchema,
  articleDetailSchema,
  articleIdSchema,
  articleListQuerySchema,
  articlePageSchema,
} from "@moya/contracts/schemas";
import { describe, expect, it } from "vitest";
import {
  editorialMediaUploadSessionSchema,
  editorialMediaUploadStartSchema,
  MEDIA_UPLOAD_CHUNK_BYTES,
  MEDIA_UPLOAD_STREAM_VERSION,
  MAX_MEDIA_UPLOAD_BYTES,
} from "@moya/contracts/internal/editorial";

const id = `article-${"1".repeat(32)}`;
const summary = {
  id,
  presentation: "news",
  title: "走近石上的时间",
  subtitle: null,
  summary: "摘要",
  section: "田野观察",
  issue: null,
  byline: "由艺编辑室",
  cover: null,
  firstPublishedAt: "2026-09-21T00:00:00.000Z",
  publishedAt: "2026-09-21T00:00:00.000Z",
  updatedAt: "2026-09-21T00:00:00.000Z",
};

describe("editorial content contracts (content-community-completion-v1)", () => {
  it("accepts only the server-generated public identity form", () => {
    expect(articleIdSchema.safeParse(id).success).toBe(true);
    expect(articleIdSchema.safeParse("12").success).toBe(false);
    expect(articleIdSchema.safeParse("article-XYZ").success).toBe(false);
  });
  it("requires at least one section and rejects unknown fields", () => {
    const detail = { ...summary, intro: null, sections: [], citations: [] };
    expect(articleDetailSchema.safeParse(detail).success).toBe(false);
    const valid = {
      ...detail,
      sections: [
        {
          heading: null,
          paragraphs: ["段落"],
          image: null,
          imageCaption: null,
        },
      ],
    };
    expect(articleDetailSchema.safeParse(valid).success).toBe(true);
    expect(
      articleDetailSchema.safeParse({ ...valid, objectKey: "x" }).success,
    ).toBe(false);
  });
  it("bounds the list query and defaults its page size", () => {
    expect(articleListQuerySchema.parse({})).toEqual({ page: 1, pageSize: 12 });
    expect(articleListQuerySchema.safeParse({ pageSize: "51" }).success).toBe(
      false,
    );
    expect(
      articleListQuerySchema.safeParse({ presentation: "video" }).success,
    ).toBe(false);
  });
  it("keeps page invariants and typed members", () => {
    expect(
      articlePageSchema.safeParse({
        items: [summary],
        total: 1,
        page: 1,
        pageSize: 12,
        totalPages: 1,
      }).success,
    ).toBe(true);
    expect(
      articleCollectionMemberSchema.safeParse({
        kind: "catalog",
        position: 0,
        article: summary,
      }).success,
    ).toBe(false);
  });
});

describe("Native resumable upload wire contract", () => {
  const intent = {
    transferId: "1".repeat(64),
    catalogId: "synthetic-upload-catalog",
    mediaId: "synthetic-upload-media",
    sha256: "2".repeat(64),
    bytes: MEDIA_UPLOAD_CHUNK_BYTES + 1,
    mimeType: "image/png",
    alt: "Synthetic image",
  };
  it("bounds immutable byte intent and keeps stream capability out of strict legacy JSON", () => {
    expect(editorialMediaUploadStartSchema.parse(intent).existingOnly).toBe(
      false,
    );
    for (const extra of [
      { url: "https://example.invalid/image" },
      { actorId: 1 },
      { ready: true },
    ])
      expect(
        editorialMediaUploadStartSchema.safeParse({ ...intent, ...extra })
          .success,
      ).toBe(false);
    for (const bytes of [0, MAX_MEDIA_UPLOAD_BYTES + 1, 1.5])
      expect(
        editorialMediaUploadStartSchema.safeParse({ ...intent, bytes }).success,
      ).toBe(false);
    const session = {
      uploadId: "3".repeat(64),
      state: "uploading",
      chunkBytes: MEDIA_UPLOAD_CHUNK_BYTES,
      chunkCount: 2,
      receivedIndices: [0],
      expiresAt: "2026-10-21T00:00:00.000Z",
    };
    expect(editorialMediaUploadSessionSchema.safeParse(session).success).toBe(
      true,
    );
    expect(MEDIA_UPLOAD_STREAM_VERSION).toBe("1");
    expect(
      editorialMediaUploadSessionSchema.safeParse({
        ...session,
        streamVersion: "1",
      }).success,
    ).toBe(false);
    for (const receivedIndices of [[0, 0], [2], [-1]])
      expect(
        editorialMediaUploadSessionSchema.safeParse({
          ...session,
          receivedIndices,
        }).success,
      ).toBe(false);
  });
});
