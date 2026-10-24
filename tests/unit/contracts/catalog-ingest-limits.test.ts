import { createHash } from "node:crypto";

import {
  CATALOG_SOURCE_MAX_BYTES,
  SANDBOX_INPUT_LIMITS,
  STILL_INPUT_LIMITS,
} from "@moya/backend-production/internal/publishing-processing";
import {
  CATALOG_RENDER_TIERS,
  readCatalogRenderBacklog,
} from "@moya/community-postgres";
import {
  CATALOG_INGEST_STAGING_TAGGING,
  CATALOG_ORIGINAL_MAX_BYTES,
  CATALOG_ORIGINAL_MAX_DECODED_BYTES,
  CATALOG_ORIGINAL_MAX_EDGE,
  CATALOG_ORIGINAL_MAX_INTERLACED_DECODED_BYTES,
  CATALOG_ORIGINAL_MAX_JPEG_COEFFICIENT_BYTES,
  CATALOG_ORIGINAL_MAX_JPEG_SCANS,
  CATALOG_ORIGINAL_MAX_LOSSLESS_WEBP_BYTES,
  CATALOG_ORIGINAL_MAX_PIXELS,
  CATALOG_ORIGINAL_MAX_ROW_BYTES,
  MAX_MEDIA_UPLOAD_BYTES,
  catalogProcessingIntentSchema,
  catalogRenderBacklogSchema,
  editorialMediaIngestAbandonResultSchema,
  editorialMediaIngestCompleteResultSchema,
  editorialMediaIngestRequestSchema,
  editorialMediaIngestStartResultSchema,
  editorialMediaIngestStartSchema,
  editorialMediaIngestVerifyRequestSchema,
  editorialMediaIngestVerifyResultSchema,
  editorialMediaUploadCompleteResultSchema,
  editorialMediaUploadStartSchema,
  editorialRegisteredMediaSchema,
  editorialUploadedMediaSchema,
} from "@moya/contracts/internal/editorial";
import { describe, expect, it } from "vitest";

/*
 * catalog-scale-v1 increment 2, slice S1: the ingest wire contract for Catalog
 * originals that go straight into private storage, its limits pinned at or
 * below the worker's, the read schema of registered media over 40 MiB, and
 * the read-only render backlog the pacing reads (I9). Synthetic values only.
 */

const MiB = 1024 * 1024;
const md5Of = (text: string) => createHash("md5").update(text).digest("base64");
const without = (value: object, ...keys: string[]) =>
  Object.fromEntries(
    Object.entries(value).filter(([key]) => !keys.includes(key)),
  );
const sha256Of = (text: string) =>
  createHash("sha256").update(text).digest("hex");

const intent = {
  transferId: "1".repeat(64),
  catalogId: "synthetic-ingest-catalog",
  mediaId: "synthetic-ingest-media",
  sha256: sha256Of("synthetic original"),
  bytes: 70 * MiB,
  mimeType: "image/jpeg",
  md5Base64: md5Of("synthetic original"),
  width: 9504,
  height: 6336,
  alt: "合成测试原图",
};
const media = {
  id: 7,
  mediaId: intent.mediaId,
  catalogId: intent.catalogId,
  objectKey: `editorial/${"a".repeat(64)}/${"b".repeat(64)}-${intent.sha256}.jpg`,
  sha256: intent.sha256,
  mimeType: "image/jpeg",
  filesize: intent.bytes,
  filename: `${"b".repeat(64)}-${intent.sha256}.jpg`,
  width: intent.width,
  height: intent.height,
  alt: intent.alt,
};
const ingestId = "c".repeat(64);
const stagingKey = `catalog-ingest/v1/${ingestId.slice(0, 2)}/${ingestId}`;
const upload = {
  method: "PUT",
  url: `https://upload.example.test/${stagingKey}?X-Amz-Expires=300`,
  headers: {
    "content-length": String(intent.bytes),
    "content-type": "image/jpeg",
    "x-cos-forbid-overwrite": "true",
    "content-md5": intent.md5Base64,
  },
  expiresAt: "2026-10-23T12:05:00.000Z",
};
const completed = {
  media,
  reused: false,
  validatedBytes: media.filesize,
  validatedSha256: media.sha256,
  validatedMd5: intent.md5Base64,
  width: media.width,
  height: media.height,
};

describe("Catalog original ingest limits", () => {
  it("are the Owner's D6 bounds as the Development render measurement left them, within what the worker reads", () => {
    expect(CATALOG_ORIGINAL_MAX_BYTES).toBe(128 * MiB);
    expect(CATALOG_ORIGINAL_MAX_PIXELS).toBe(120_000_000);
    expect(CATALOG_ORIGINAL_MAX_DECODED_BYTES).toBe(512 * MiB);
    // S5b: the JPEG decoder's longest side, and one decoded row.
    expect(CATALOG_ORIGINAL_MAX_EDGE).toBe(65_500);
    expect(CATALOG_ORIGINAL_MAX_ROW_BYTES).toBe(256 * 1024);
    // An 8-bit RGBA row keeps the whole edge.
    expect(CATALOG_ORIGINAL_MAX_EDGE * 4).toBeLessThanOrEqual(
      CATALOG_ORIGINAL_MAX_ROW_BYTES,
    );
    // The whole-image decoder buffers (S5b review): a progressive JPEG's
    // coefficients and an interlaced PNG's pixels, both within the decoded
    // bound.
    expect(CATALOG_ORIGINAL_MAX_JPEG_COEFFICIENT_BYTES).toBe(512 * MiB);
    expect(CATALOG_ORIGINAL_MAX_INTERLACED_DECODED_BYTES).toBe(256 * MiB);
    expect(CATALOG_ORIGINAL_MAX_INTERLACED_DECODED_BYTES).toBeLessThan(
      CATALOG_ORIGINAL_MAX_DECODED_BYTES,
    );
    // The PR review (S11): a lossless WebP's ARGB buffer, width x height x
    // 4 B, which libwebp holds whole; and the scans of one JPEG.
    expect(CATALOG_ORIGINAL_MAX_LOSSLESS_WEBP_BYTES).toBe(256 * MiB);
    expect(CATALOG_ORIGINAL_MAX_LOSSLESS_WEBP_BYTES).toBeLessThan(
      CATALOG_ORIGINAL_MAX_DECODED_BYTES,
    );
    expect(CATALOG_ORIGINAL_MAX_JPEG_SCANS).toBe(150);

    expect(CATALOG_ORIGINAL_MAX_BYTES).toBeLessThanOrEqual(
      CATALOG_SOURCE_MAX_BYTES,
    );
    expect(CATALOG_ORIGINAL_MAX_PIXELS).toBeLessThanOrEqual(
      SANDBOX_INPUT_LIMITS.maxPixels,
    );
    // The still decoder reads min(sandbox, still pipeline) pixels.
    expect(CATALOG_ORIGINAL_MAX_PIXELS).toBeLessThanOrEqual(
      STILL_INPUT_LIMITS.limitInputPixels,
    );
    expect(CATALOG_ORIGINAL_MAX_DECODED_BYTES).toBeLessThanOrEqual(
      SANDBOX_INPUT_LIMITS.maxDecodedBytes,
    );
    expect(CATALOG_ORIGINAL_MAX_EDGE).toBeLessThanOrEqual(65_535);
  });

  it("keep every ingested edge inside the private processing snapshot", () => {
    const snapshot = (edge: number) =>
      catalogProcessingIntentSchema.safeParse({
        intentId: "00000000-0000-4000-8000-000000000001",
        documentId: 1,
        catalogId: intent.catalogId,
        revision: 1,
        fingerprint: "d".repeat(64),
        manifestSha256: "e".repeat(64),
        recipeManifestSha256: "f".repeat(64),
        state: "prepared",
        stateVersion: 1,
        mediaCount: 1,
        media: [
          {
            ordinal: 1,
            mediaId: intent.mediaId,
            objectKey: media.objectKey,
            sourceSha256: media.sha256,
            width: edge,
            height: 1,
          },
        ],
        expiresAt: "2026-10-24T00:00:00.000Z",
      }).success;
    expect(snapshot(CATALOG_ORIGINAL_MAX_EDGE)).toBe(true);
    // The snapshot's own bound stays at or above the ingest edge (S5b).
    expect(snapshot(65_535)).toBe(true);
    expect(snapshot(65_536)).toBe(false);
  });

  it("leave the native and relay limit at 40 MiB", () => {
    expect(MAX_MEDIA_UPLOAD_BYTES).toBe(40 * MiB);
    const relay = {
      transferId: intent.transferId,
      catalogId: intent.catalogId,
      mediaId: intent.mediaId,
      sha256: intent.sha256,
      mimeType: intent.mimeType,
      alt: intent.alt,
    };
    expect(
      editorialMediaUploadStartSchema.safeParse({
        ...relay,
        bytes: MAX_MEDIA_UPLOAD_BYTES + 1,
      }).success,
    ).toBe(false);
    expect(
      editorialMediaUploadCompleteResultSchema.safeParse({
        media,
        reused: false,
        validatedBytes: media.filesize,
        validatedSha256: media.sha256,
      }).success,
    ).toBe(false);
    expect(
      editorialMediaIngestStartSchema.safeParse({
        ...intent,
        bytes: MAX_MEDIA_UPLOAD_BYTES + 1,
      }).success,
    ).toBe(true);
  });
});

describe("registered media read schema", () => {
  it("is the uploaded projection with only the filesize bound raised", () => {
    const uploaded = editorialUploadedMediaSchema.shape;
    const registered = editorialRegisteredMediaSchema.shape;
    expect(Object.keys(registered).sort()).toEqual(
      Object.keys(uploaded).sort(),
    );
    for (const key of Object.keys(uploaded) as (keyof typeof uploaded)[])
      if (key !== "filesize") expect(registered[key], key).toBe(uploaded[key]);

    const parse = (
      schema: { safeParse: (value: unknown) => { success: boolean } },
      filesize: number,
    ) => schema.safeParse({ ...media, filesize }).success;
    expect(parse(editorialUploadedMediaSchema, MAX_MEDIA_UPLOAD_BYTES)).toBe(
      true,
    );
    expect(
      parse(editorialUploadedMediaSchema, MAX_MEDIA_UPLOAD_BYTES + 1),
    ).toBe(false);
    expect(
      parse(editorialRegisteredMediaSchema, MAX_MEDIA_UPLOAD_BYTES + 1),
    ).toBe(true);
    expect(
      parse(editorialRegisteredMediaSchema, CATALOG_ORIGINAL_MAX_BYTES),
    ).toBe(true);
    expect(
      parse(editorialRegisteredMediaSchema, CATALOG_ORIGINAL_MAX_BYTES + 1),
    ).toBe(false);
    expect(parse(editorialRegisteredMediaSchema, 0)).toBe(false);
  });

  it("stays strict and carries no credentials, URLs or staging keys", () => {
    for (const extra of [
      { url: "https://upload.example.test/x" },
      { stagingKey },
      { ingestId },
    ])
      expect(
        editorialRegisteredMediaSchema.safeParse({ ...media, ...extra })
          .success,
      ).toBe(false);
  });
});

describe("ingest intent", () => {
  const accepts = (value: Record<string, unknown>) =>
    editorialMediaIngestStartSchema.safeParse(value).success;

  it("accepts a large original up to the ingest byte bound", () => {
    expect(accepts(intent)).toBe(true);
    expect(accepts({ ...intent, bytes: 1 })).toBe(true);
    expect(accepts({ ...intent, bytes: CATALOG_ORIGINAL_MAX_BYTES })).toBe(
      true,
    );
    for (const bytes of [0, CATALOG_ORIGINAL_MAX_BYTES + 1, 1.5, -1])
      expect(accepts({ ...intent, bytes }), String(bytes)).toBe(false);
  });

  it("requires a canonical Content-MD5 digest", () => {
    expect(accepts(without(intent, "md5Base64"))).toBe(false);
    for (const md5Base64 of [
      createHash("md5").update("x").digest("hex"),
      md5Of("x").slice(0, -2),
      `${md5Of("x").slice(0, 21)}B==`,
      createHash("sha256").update("x").digest("base64"),
    ])
      expect(accepts({ ...intent, md5Base64 }), md5Base64).toBe(false);
    for (const text of ["", "a", "synthetic", "合成"])
      expect(accepts({ ...intent, md5Base64: md5Of(text) })).toBe(true);
  });

  it("bounds a declared size by edge and pixels, and leaves it optional", () => {
    const undeclared = without(intent, "width", "height");
    expect(accepts(undeclared)).toBe(true);
    expect(accepts({ ...undeclared, width: 9504 })).toBe(true);
    expect(accepts({ ...undeclared, height: CATALOG_ORIGINAL_MAX_EDGE })).toBe(
      true,
    );
    for (const edge of [0, CATALOG_ORIGINAL_MAX_EDGE + 1, 10.5])
      for (const declared of [
        { width: edge },
        { height: edge },
        { width: edge, height: 1 },
        { width: 1, height: edge },
      ])
        expect(
          accepts({ ...undeclared, ...declared }),
          JSON.stringify(declared),
        ).toBe(false);
    expect(accepts({ ...intent, width: 12_000, height: 10_000 })).toBe(true);
    expect(accepts({ ...intent, width: 12_000, height: 10_001 })).toBe(false);
    expect(
      accepts({ ...intent, width: CATALOG_ORIGINAL_MAX_EDGE, height: 1_832 }),
    ).toBe(true);
    expect(
      accepts({ ...intent, width: CATALOG_ORIGINAL_MAX_EDGE, height: 1_833 }),
    ).toBe(false);
  });

  it("accepts only the three still formats and refuses unknown fields", () => {
    for (const mimeType of ["image/png", "image/webp"])
      expect(accepts({ ...intent, mimeType })).toBe(true);
    for (const mimeType of ["image/gif", "image/tiff", "image/avif", ""])
      expect(accepts({ ...intent, mimeType }), mimeType).toBe(false);
    for (const extra of [
      { existingOnly: true },
      { objectKey: media.objectKey },
      { filename: "x.jpg" },
      { ingestId },
      { stagingKey },
    ])
      expect(accepts({ ...intent, ...extra })).toBe(false);
    expect(accepts({ ...intent, transferId: "A".repeat(64) })).toBe(false);
    expect(accepts({ ...intent, sha256: "a".repeat(63) })).toBe(false);
  });

  it("is carried unchanged by complete and abandon", () => {
    expect(
      editorialMediaIngestRequestSchema.safeParse({ intent }).success,
    ).toBe(true);
    expect(editorialMediaIngestRequestSchema.safeParse(intent).success).toBe(
      false,
    );
    expect(
      editorialMediaIngestRequestSchema.safeParse({
        intent,
        ingestId,
      }).success,
    ).toBe(false);
    expect(
      editorialMediaIngestRequestSchema.safeParse({
        intent: { ...intent, bytes: CATALOG_ORIGINAL_MAX_BYTES + 1 },
      }).success,
    ).toBe(false);
  });
});

describe("ingest start result", () => {
  const accepts = (value: unknown) =>
    editorialMediaIngestStartResultSchema.safeParse(value).success;
  const withHeaders = (headers: Record<string, unknown>) => ({
    state: "upload",
    ingestId,
    upload: { ...upload, headers },
  });

  it("is one PUT with exactly the signed header set", () => {
    expect(accepts({ state: "upload", ingestId, upload })).toBe(true);
    expect(
      accepts(
        withHeaders({
          ...upload.headers,
          "x-cos-tagging": CATALOG_INGEST_STAGING_TAGGING,
        }),
      ),
    ).toBe(true);
    expect(
      accepts(withHeaders({ ...upload.headers, "x-cos-tagging": "other=tag" })),
    ).toBe(false);
    for (const header of [
      "x-cos-acl",
      "x-amz-acl",
      "x-cos-copy-source",
      "x-amz-copy-source",
      "x-cos-metadata-directive",
      "authorization",
      "cookie",
    ])
      expect(
        accepts(withHeaders({ ...upload.headers, [header]: "x" })),
        header,
      ).toBe(false);
    for (const header of Object.keys(upload.headers))
      expect(
        accepts(withHeaders(without(upload.headers, header))),
        header,
      ).toBe(false);
    expect(
      accepts(
        withHeaders({ ...upload.headers, "x-cos-forbid-overwrite": "false" }),
      ),
    ).toBe(false);
    for (const contentType of ["image/png", "image/webp"])
      expect(
        accepts(
          withHeaders({ ...upload.headers, "content-type": contentType }),
        ),
        contentType,
      ).toBe(true);
    for (const contentType of [
      "text/html",
      "image/gif",
      "application/octet-stream",
      "",
    ])
      expect(
        accepts(
          withHeaders({ ...upload.headers, "content-type": contentType }),
        ),
        contentType,
      ).toBe(false);
    for (const md5 of [
      createHash("md5").update("x").digest("hex"),
      "not-md5",
      md5Of("x").slice(0, -2),
      "",
    ])
      expect(
        accepts(withHeaders({ ...upload.headers, "content-md5": md5 })),
        md5,
      ).toBe(false);
    for (const length of [
      "0",
      "007",
      String(CATALOG_ORIGINAL_MAX_BYTES + 1),
      "1e3",
    ])
      expect(
        accepts(withHeaders({ ...upload.headers, "content-length": length })),
        length,
      ).toBe(false);
    expect(
      accepts(
        withHeaders({
          ...upload.headers,
          "content-length": String(CATALOG_ORIGINAL_MAX_BYTES),
        }),
      ),
    ).toBe(true);
    for (const method of ["GET", "POST", "put"])
      expect(
        accepts({
          state: "upload",
          ingestId,
          upload: { ...upload, method },
        }),
        method,
      ).toBe(false);
  });

  it("carries only an http(s) URL and an ISO expiry", () => {
    const withUpload = (patch: Record<string, unknown>) => ({
      state: "upload",
      ingestId,
      upload: { ...upload, ...patch },
    });
    expect(
      accepts(withUpload({ url: "http://127.0.0.1:3002/api/x?token=t" })),
    ).toBe(true);
    for (const url of [
      "ftp://upload.example.test/x",
      "javascript:alert(1)",
      `/${stagingKey}`,
      `https://upload.example.test/${"x".repeat(8_192)}`,
    ])
      expect(accepts(withUpload({ url })), url.slice(0, 32)).toBe(false);
    expect(accepts(withUpload({ expiresAt: "tomorrow" }))).toBe(false);
    expect(accepts(withUpload({ expiresIn: 300 }))).toBe(false);
  });

  it("names the upload by a lowercase ingest id and nothing else", () => {
    for (const id of ["C".repeat(64), ingestId.slice(1), `${ingestId}c`])
      expect(accepts({ state: "upload", ingestId: id, upload }), id).toBe(
        false,
      );
    for (const extra of [{ media }, { stagingKey }, { objectKey: stagingKey }])
      expect(
        accepts({ state: "upload", ingestId, upload, ...extra }),
        Object.keys(extra)[0],
      ).toBe(false);
  });

  it("returns a registered original over 40 MiB without an upload", () => {
    expect(accepts({ state: "registered", media })).toBe(true);
    expect(accepts({ state: "registered", media, upload })).toBe(false);
    expect(accepts({ state: "registered", ingestId })).toBe(false);
    expect(accepts({ state: "uploading", media })).toBe(false);
  });
});

describe("ingest complete result", () => {
  const accepts = (value: Record<string, unknown>) =>
    editorialMediaIngestCompleteResultSchema.safeParse(value).success;

  it("reports exactly the facts of the registered media", () => {
    expect(accepts(completed)).toBe(true);
    expect(accepts({ ...completed, reused: true })).toBe(true);
    for (const patch of [
      { validatedBytes: media.filesize - 1 },
      { validatedSha256: "f".repeat(64) },
      { width: media.width + 1 },
      { height: media.height - 1 },
    ])
      expect(accepts({ ...completed, ...patch }), Object.keys(patch)[0]).toBe(
        false,
      );
    expect(
      accepts({
        ...completed,
        media: { ...media, filesize: CATALOG_ORIGINAL_MAX_BYTES + 1 },
        validatedBytes: CATALOG_ORIGINAL_MAX_BYTES + 1,
      }),
    ).toBe(false);
  });

  it("reports the MD5 it verified unless it reused without reading", () => {
    expect(accepts({ ...completed, validatedMd5: null })).toBe(false);
    expect(accepts({ ...completed, reused: true, validatedMd5: null })).toBe(
      true,
    );
    expect(accepts({ ...completed, validatedMd5: "not-md5" })).toBe(false);
    expect(accepts(without(completed, "validatedMd5"))).toBe(false);
    expect(accepts({ ...completed, url: upload.url })).toBe(false);
  });
});

describe("ingest abandon and verify", () => {
  const verifies = (value: Record<string, unknown>) =>
    editorialMediaIngestVerifyResultSchema.safeParse(value).success;
  const intact = {
    media,
    intact: true,
    validatedBytes: media.filesize,
    validatedSha256: media.sha256,
  };

  it("abandons idempotently by ingest id", () => {
    const abandoned = { ingestId, state: "abandoned" };
    expect(
      editorialMediaIngestAbandonResultSchema.safeParse(abandoned).success,
    ).toBe(true);
    expect(
      editorialMediaIngestAbandonResultSchema.safeParse({
        ...abandoned,
        stagingKey,
      }).success,
    ).toBe(false);
    expect(
      editorialMediaIngestAbandonResultSchema.safeParse({
        ...abandoned,
        state: "deleted",
      }).success,
    ).toBe(false);
    for (const id of ["C".repeat(64), ingestId.slice(1), stagingKey])
      expect(
        editorialMediaIngestAbandonResultSchema.safeParse({
          ...abandoned,
          ingestId: id,
        }).success,
        id,
      ).toBe(false);
  });

  it("verifies by media id only", () => {
    expect(
      editorialMediaIngestVerifyRequestSchema.safeParse({
        mediaId: intent.mediaId,
      }).success,
    ).toBe(true);
    for (const value of [
      { mediaId: intent.mediaId, objectKey: media.objectKey },
      { mediaId: "has space" },
      {},
    ])
      expect(
        editorialMediaIngestVerifyRequestSchema.safeParse(value).success,
      ).toBe(false);
  });

  it("states intact exactly when the stored bytes are the registered ones", () => {
    expect(verifies(intact)).toBe(true);
    expect(verifies({ ...intact, intact: false })).toBe(false);
    for (const patch of [
      { validatedBytes: media.filesize + 1 },
      { validatedSha256: "f".repeat(64) },
      { validatedSha256: null },
      { validatedBytes: 0, validatedSha256: null },
    ]) {
      expect(verifies({ ...intact, ...patch }), JSON.stringify(patch)).toBe(
        false,
      );
      expect(
        verifies({ ...intact, ...patch, intact: false }),
        JSON.stringify(patch),
      ).toBe(true);
    }
    expect(verifies({ ...intact, validatedBytes: -1, intact: false })).toBe(
      false,
    );
    for (const validatedSha256 of ["xyz", "F".repeat(64), `${media.sha256}0`])
      expect(
        verifies({ ...intact, validatedSha256, intact: false }),
        validatedSha256,
      ).toBe(false);
  });

  it("reports the re-hash only, with no URL or key", () => {
    for (const extra of [
      { url: upload.url },
      { objectKey: media.objectKey },
      { stagingKey },
    ])
      expect(verifies({ ...intact, ...extra }), Object.keys(extra)[0]).toBe(
        false,
      );
  });
});

describe("Catalog render backlog contract (I9)", () => {
  const counted = {
    tiers: { t0: 0, t1: 2, t2: 40, t3: 0, t4: 1_200 },
    countedAt: "2026-10-23T12:00:00.000Z",
    queued: 300,
    running: 1,
  };
  const accepts = (value: unknown) =>
    catalogRenderBacklogSchema.safeParse(value).success;

  it("parses what the App read returns, once serialized", async () => {
    const rows = [
      {
        render_backlog: { t0: 1, t1: 2, t2: 3, t3: 4, t4: 5 },
        render_backlog_at: new Date("2026-10-23T12:00:00.000Z"),
        queued: 6,
        running: 1,
      },
      {
        render_backlog: null,
        render_backlog_at: null,
        queued: 0,
        running: 0,
      },
    ];
    for (const row of rows) {
      const read = await readCatalogRenderBacklog({
        query: async () => ({ rows: [row] }),
      } as unknown as Parameters<typeof readCatalogRenderBacklog>[0]);
      const wire = JSON.parse(JSON.stringify(read)) as unknown;
      expect(catalogRenderBacklogSchema.parse(wire)).toEqual(wire);
    }
  });

  it("reports a count with a tier that is not a whole number of at least 0 as never counted, never as 0", async () => {
    const countedAt = new Date("2026-10-23T12:00:00.000Z");
    const read = (render_backlog: unknown) =>
      readCatalogRenderBacklog({
        query: async () => ({
          rows: [
            {
              render_backlog,
              render_backlog_at: countedAt,
              queued: 6,
              running: 1,
            },
          ],
        }),
      } as unknown as Parameters<typeof readCatalogRenderBacklog>[0]);
    const whole = { t0: 0, t1: 2, t2: 3, t3: 4, t4: 5 };
    expect(await read(whole)).toEqual({
      tiers: whole,
      countedAt,
      queued: 6,
      running: 1,
    });
    const missing: Record<string, unknown> = { ...whole };
    delete missing.t2;
    for (const recorded of [
      { ...whole, t2: -1 },
      { ...whole, t2: 1.5 },
      { ...whole, t2: "3" },
      { ...whole, t2: null },
      { ...whole, t2: 2 ** 53 },
      { ...whole, t2: { images: 3 } },
      missing,
      [0, 2, 3, 4, 5],
    ]) {
      const report = await read(recorded);
      expect(report, JSON.stringify(recorded)).toEqual({
        tiers: null,
        countedAt: null,
        queued: 6,
        running: 1,
      });
      // On the wire it is the contract's "never counted", which stops a wave.
      expect(
        catalogRenderBacklogSchema.parse(JSON.parse(JSON.stringify(report))),
      ).toMatchObject({ tiers: null, countedAt: null });
    }
  });

  it("names exactly the App's render tiers", () => {
    expect(
      Object.keys(catalogRenderBacklogSchema.shape.tiers.unwrap().shape),
    ).toEqual([...CATALOG_RENDER_TIERS]);
  });

  it("counts only, with its time exactly when counted", () => {
    expect(accepts(counted)).toBe(true);
    expect(accepts({ ...counted, tiers: null, countedAt: null })).toBe(true);
    expect(accepts({ ...counted, tiers: null })).toBe(false);
    expect(accepts({ ...counted, countedAt: null })).toBe(false);
    for (const tiers of [
      { ...counted.tiers, t5: 0 },
      { t0: 0, t1: 0, t2: 0, t3: 0 },
      { ...counted.tiers, t2: -1 },
      { ...counted.tiers, t2: 1.5 },
    ])
      expect(accepts({ ...counted, tiers }), JSON.stringify(tiers)).toBe(false);
    for (const patch of [
      { queued: -1 },
      { running: 0.5 },
      { countedAt: "yesterday" },
      { assetIds: ["a"] },
    ])
      expect(accepts({ ...counted, ...patch }), JSON.stringify(patch)).toBe(
        false,
      );
  });
});
