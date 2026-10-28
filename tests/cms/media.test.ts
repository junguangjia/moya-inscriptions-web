import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLocalReq,
  getPayload,
  type Payload,
  type PayloadRequest,
} from "payload";
import config from "admin/config";
import { validateCatalogMedia } from "admin/media";
import { readDraft, restoreDraft, saveDraft } from "admin/editorial";
import { selectedMediaSnapshot } from "admin/media-snapshot";
import { editorialDraftSchema } from "@moya/contracts/internal/editorial";
import sharp from "sharp";

const suffix = randomUUID();
const catalogId = `synthetic-media-${suffix}`;
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
let payload: Payload;
let ownerReq: PayloadRequest;
let automationReq: PayloadRequest;
let outsiderReq: PayloadRequest;
const mediaDirectory = process.env.CMS_MEDIA_DIR!;

beforeAll(async () => {
  if (process.env.CMS_ENVIRONMENT !== "synthetic" || !mediaDirectory)
    throw new Error("Synthetic CMS test configuration required");
  payload = await getPayload({ config });
  const owner = await payload.create({
    collection: "users",
    overrideAccess: true,
    data: {
      email: `media-owner-${suffix}@example.invalid`,
      password: randomUUID(),
      role: "owner",
      scopeCatalogIds: [],
    },
  });
  ownerReq = await createLocalReq(
    { user: { ...owner, collection: "users" } },
    payload,
  );
  const automation = await payload.create({
    collection: "users",
    overrideAccess: false,
    req: ownerReq,
    data: {
      email: `media-automation-${suffix}@example.invalid`,
      password: randomUUID(),
      role: "automation",
      scopeCatalogIds: [catalogId],
    },
  });
  automationReq = await createLocalReq(
    { user: { ...automation, collection: "users" } },
    payload,
  );
  const outsider = await payload.create({
    collection: "users",
    overrideAccess: false,
    req: ownerReq,
    data: {
      email: `media-outside-${suffix}@example.invalid`,
      password: randomUUID(),
      role: "automation",
      scopeCatalogIds: [`other-${suffix}`],
    },
  });
  outsiderReq = await createLocalReq(
    { user: { ...outsider, collection: "users" } },
    payload,
  );
}, 30_000);
afterAll(async () => {
  await payload?.destroy();
});

const mediaData = (mediaId: string) => ({
  mediaId,
  catalogId,
  origin: "upload" as const,
  objectKey: "",
  sha256: "",
  alt: "Synthetic original media",
  rights: "Explicitly fictional test rights",
  orderConfidence: "LOW" as const,
});

describe("native Payload original media", () => {
  it.each(["png", "jpeg", "webp"] as const)(
    "retains exact %s bytes, dimensions and stable ownership on real writes",
    async (format) => {
      const bytes = await sharp({
        create: {
          width: 3,
          height: 2,
          channels: 3,
          background: { r: 12, g: 34, b: 56 },
        },
      })
        .toFormat(format)
        .toBuffer();
      const mediaId = `media-${format}-${suffix}`;
      const result = await payload.create({
        collection: "media",
        overrideAccess: false,
        req: automationReq,
        data: mediaData(mediaId),
        file: {
          name: `synthetic.${format}`,
          data: bytes,
          mimetype: `image/${format}`,
          size: bytes.length,
        },
      });
      const saved = await readFile(path.join(mediaDirectory, result.filename!));
      expect(hash(saved)).toBe(hash(bytes));
      expect(result.sha256).toBe(hash(bytes));
      expect(result.mediaId).toBe(mediaId);
      expect(result.catalogId).toBe(catalogId);
      expect([result.width, result.height]).toEqual([3, 2]);
      expect(result.orderConfidence).toBe("LOW");
      expect(result.objectKey).toBe(`${result.prefix}/${result.filename}`);
      expect("sizes" in result).toBe(false);
      const thumbnail = new URL(
        String(result.thumbnailURL),
        "http://cms.example.invalid",
      );
      expect(thumbnail.pathname).toBe("/api/catalog-media-thumbnail");
      expect(thumbnail.searchParams.get("mediaId")).toBe(mediaId);
      expect(thumbnail.searchParams.get("objectKey")).toBe(result.objectKey);
      expect(thumbnail.searchParams.get("sourceSha256")).toBe(hash(bytes));
      expect(payload.collections.media.config.upload).toHaveProperty(
        "cacheTags",
        false,
      );

      await expect(
        payload.findByID({
          collection: "media",
          id: result.id,
          overrideAccess: false,
          req: await createLocalReq({}, payload),
        }),
      ).rejects.toThrow();
      await expect(
        payload.findByID({
          collection: "media",
          id: result.id,
          overrideAccess: false,
          req: outsiderReq,
        }),
      ).rejects.toThrow();
      await expect(
        payload.update({
          collection: "media",
          id: result.id,
          overrideAccess: false,
          req: ownerReq,
          data: { objectKey: "fictional/changed.png" },
        }),
      ).rejects.toThrow("MEDIA_IDENTITY_IMMUTABLE");
      await expect(
        payload.update({
          collection: "media",
          id: result.id,
          overrideAccess: false,
          req: ownerReq,
          data: {},
          file: {
            name: "replacement.png",
            data: bytes,
            mimetype: `image/${format}`,
            size: bytes.length,
          },
        }),
      ).rejects.toThrow("MEDIA_REPLACEMENT_DISABLED");
      await expect(
        payload.delete({
          collection: "media",
          id: result.id,
          overrideAccess: true,
          req: ownerReq,
        }),
      ).rejects.toThrow("MEDIA_DELETE_DISABLED");
      const edited = await payload.update({
        collection: "media",
        id: result.id,
        overrideAccess: false,
        req: ownerReq,
        data: { alt: "Updated synthetic caption" },
      });
      expect(edited.alt).toBe("Updated synthetic caption");
      expect(
        hash(await readFile(path.join(mediaDirectory, result.filename!))),
      ).toBe(hash(bytes));
    },
  );

  it("registers approved existing metadata without filesystem writes and denies automation registration", async () => {
    const filesBefore = await readdir(mediaDirectory);
    const existing = {
      ...mediaData(`existing-${suffix}`),
      origin: "existing" as const,
      objectKey: `approved existing/${suffix}/原圖 100% ${suffix}.webp`,
      sha256: "a".repeat(64),
      mimeType: "image/webp",
      filesize: 10,
      width: 3,
      height: 2,
    };
    await expect(
      payload.create({
        collection: "media",
        overrideAccess: false,
        req: automationReq,
        data: existing,
      }),
    ).rejects.toThrow("MEDIA_REGISTRATION_FORBIDDEN");
    const registered = await payload.create({
      collection: "media",
      overrideAccess: false,
      req: ownerReq,
      data: existing,
    });
    expect(registered.objectKey).toBe(existing.objectKey);
    expect(registered.mediaId).toBe(existing.mediaId);
    expect(registered.orderConfidence).toBe("LOW");
    expect(registered.rights).toBe(existing.rights);
    expect(await readdir(mediaDirectory)).toEqual(filesBefore);
    const selection = selectedMediaSnapshot({ ...registered }, catalogId, []);
    expect(selection).toMatchObject({
      mediaId: existing.mediaId,
      objectKey: existing.objectKey,
      rights: existing.rights,
      orderConfidence: "LOW",
      position: 0,
      isRepresentative: true,
    });
    expect(
      selectedMediaSnapshot({ ...registered }, catalogId, [selection!]),
    ).toBeNull();
    expect(() =>
      selectedMediaSnapshot({ ...registered }, "unrelated-catalog", []),
    ).toThrow("MEDIA_SCOPE_MISMATCH");
    const candidate = editorialDraftSchema.parse({
      catalogId,
      sourceId: `source-${suffix}`,
      kind: "inscription",
      media: [
        {
          mediaId: existing.mediaId,
          objectKey: existing.objectKey,
          width: 3,
          height: 2,
          alt: existing.alt,
          rights: existing.rights,
          orderConfidence: "LOW",
          position: 0,
          isRepresentative: true,
        },
      ],
    });
    await expect(
      validateCatalogMedia(automationReq, candidate, { publishing: false }),
    ).resolves.toBeUndefined();
    for (const data of [
      { rights: "Changed fictional rights" },
      { orderConfidence: "HIGH" as const },
      { orderConfidence: null },
    ]) {
      await expect(
        payload.update({
          collection: "media",
          id: registered.id,
          req: ownerReq,
          overrideAccess: false,
          data,
        }),
      ).rejects.toThrow("MEDIA_IDENTITY_IMMUTABLE");
    }
    const first = await saveDraft(automationReq, {
      idempotencyKey: `media-history-first-${suffix}`,
      content: candidate,
    });
    const second = await saveDraft(automationReq, {
      id: first.id,
      expectedRevision: first.revision,
      idempotencyKey: `media-history-second-${suffix}`,
      content: { ...candidate, title: "Synthetic unrelated draft edit" },
    });
    const versions = await payload.findVersions({
      collection: "catalogs",
      where: { parent: { equals: first.id } },
      sort: "createdAt",
      depth: 0,
      req: ownerReq,
      overrideAccess: false,
    });
    expect(versions.docs.length).toBeGreaterThan(0);
    await restoreDraft(ownerReq, {
      versionId: versions.docs[0]!.id,
      expectedRevision: second.revision,
    });
    const restored = await readDraft(ownerReq, { id: first.id });
    expect(restored.content.media).toEqual(candidate.media);
    expect(restored.content.title).toBeUndefined();
    await expect(
      payload.create({
        collection: "media",
        overrideAccess: false,
        req: ownerReq,
        data: {
          ...existing,
          mediaId: `duplicate-filename-${suffix}`,
          objectKey: `different approved prefix/${registered.filename}`,
        },
      }),
    ).rejects.toThrow("MEDIA_OBJECT_KEY_REQUIRES_ADAPTER_EXTENSION");
    expect(await readdir(mediaDirectory)).toEqual(filesBefore);
    candidate.media[0]!.objectKey = "fictional/unregistered-object.webp";
    await expect(
      validateCatalogMedia(automationReq, candidate, { publishing: false }),
    ).rejects.toThrow("MEDIA_REFERENCE_INVALID");
    candidate.media[0]!.objectKey = existing.objectKey;
    delete candidate.media[0]!.orderConfidence;
    await expect(
      validateCatalogMedia(automationReq, candidate, { publishing: true }),
    ).rejects.toThrow("MEDIA_PUBLICATION_REFERENCE_INVALID");
    await expect(
      payload.create({
        collection: "media",
        overrideAccess: false,
        req: ownerReq,
        data: {
          ...existing,
          mediaId: `normalized-${suffix}`,
          objectKey: "approved%20existing/original.webp",
        },
      }),
    ).rejects.toThrow("MEDIA_OBJECT_KEY_REQUIRES_ADAPTER_EXTENSION");
  });

  it("rejects MIME spoofing, corrupt image bytes, duplicate identities and remote edit attempts before writes", async () => {
    const bytes = await sharp({
      create: { width: 1, height: 1, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    const data = mediaData(`spoof-${suffix}`);
    await expect(
      payload.create({
        collection: "media",
        overrideAccess: false,
        req: ownerReq,
        data,
        file: {
          name: "wrong.webp",
          data: bytes,
          mimetype: "image/webp",
          size: bytes.length,
        },
      }),
    ).rejects.toThrow("MEDIA_FILE_INVALID");
    const broken = Buffer.from("fictional broken image");
    await expect(
      payload.create({
        collection: "media",
        overrideAccess: false,
        req: ownerReq,
        data,
        file: {
          name: "broken.png",
          data: broken,
          mimetype: "image/png",
          size: broken.length,
        },
      }),
    ).rejects.toThrow("MEDIA_FILE_INVALID");
    const input = {
      collection: "media" as const,
      overrideAccess: false,
      req: ownerReq,
      data,
      file: {
        name: "valid.png",
        data: bytes,
        mimetype: "image/png",
        size: bytes.length,
      },
    };
    const saved = await payload.create(input);
    await expect(payload.create(input)).rejects.toThrow(
      "MEDIA_IDENTITY_EXISTS",
    );
    if (!ownerReq.user) throw new Error("Synthetic Owner request required");
    const remoteReq = await createLocalReq({ user: ownerReq.user }, payload);
    remoteReq.query = {
      uploadEdits: { crop: { x: 0, y: 0, width: 1, height: 1 } },
    };
    await expect(
      payload.update({
        collection: "media",
        id: saved.id,
        req: remoteReq,
        overrideAccess: false,
        data: { url: "https://example.invalid/untrusted.png" },
      }),
    ).rejects.toThrow("MEDIA_TRANSFORM_DISABLED");
  });
});
