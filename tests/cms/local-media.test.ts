import { createHash, randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createLocalReq,
  getPayload,
  handleEndpoints,
  type Payload,
  type PayloadRequest,
} from "payload";
import config from "admin/config";
import { saveDraft } from "admin/editorial";
import { selectedMediaSnapshot } from "admin/media-snapshot";
import {
  EDITORIAL_STATEFUL_FIELDS,
  editorialDraftSchema,
} from "@moya/contracts/internal/editorial";
import sharp from "sharp";

const suffix = randomUUID();
const catalogId = `synthetic-local-media-${suffix}`;
let payload: Payload;
let ownerReq: PayloadRequest;

beforeAll(async () => {
  if (
    process.env.CMS_ENVIRONMENT !== "synthetic" ||
    process.env.CMS_STORAGE_MODE !== "local"
  )
    throw new Error("Synthetic local CMS test configuration required");
  payload = await getPayload({ config });
  const owner = await payload.create({
    collection: "users",
    overrideAccess: true,
    data: {
      email: `local-media-owner-${suffix}@example.invalid`,
      password: randomUUID(),
      role: "owner",
    },
  });
  ownerReq = await createLocalReq(
    { user: { ...owner, collection: "users" } },
    payload,
  );
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  await payload?.destroy();
});

const get = (route: string) =>
  handleEndpoints({
    config,
    request: new Request(`http://127.0.0.1:3002/api/${route}`),
  });

describe("native local Payload file access against published snapshots", () => {
  it("serves only published bytes, keeps draft replacement private, and denies files immediately after withdrawal", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const bytes = await sharp({
      create: { width: 3, height: 2, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    const createMedia = (label: string) =>
      payload.create({
        collection: "media",
        req: ownerReq,
        overrideAccess: false,
        data: {
          mediaId: `local-${label}-${suffix}`,
          catalogId,
          origin: "upload",
          objectKey: "",
          sha256: "",
          alt: "Synthetic local file",
          rights: "Fictional test rights",
          orderConfidence: "HIGH",
        },
        file: {
          name: "synthetic-local.png",
          data: bytes,
          mimetype: "image/png",
          size: bytes.length,
        },
      });
    const publishedMedia = await createMedia("published");
    const privateMedia = await createMedia("draft");
    const content = editorialDraftSchema.parse({
      catalogId,
      sourceId: `synthetic-local-source-${suffix}`,
      kind: "calligraphy",
      title: "Synthetic local publication",
      ...Object.fromEntries(
        EDITORIAL_STATEFUL_FIELDS.map((name) => [
          name,
          { state: "UNSUPPLIED" },
        ]),
      ),
      media: [selectedMediaSnapshot({ ...publishedMedia }, catalogId, [])],
    });
    const draft = await saveDraft(ownerReq, {
      idempotencyKey: `local-create-${suffix}`,
      content,
    });
    const publishedRoute = `media/file/${publishedMedia.filename!}`;
    const privateRoute = `media/file/${privateMedia.filename!}`;
    expect((await get(publishedRoute)).status).toBe(403);
    expect((await get(privateRoute)).status).toBe(403);

    // New editorial originals cannot bypass the delivery workflow, including
    // Development. The read-access regression below uses an explicitly seeded
    // pre-existing publication in this isolated fixture, not a publish bypass
    // available to an application actor.
    await expect(
      payload.update({
        collection: "catalogs",
        id: draft.id,
        data: { revision: draft.revision, _status: "published" },
        req: ownerReq,
        overrideAccess: false,
      }),
    ).rejects.toThrow("CATALOG_DELIVERY_PREPARATION_REQUIRED");
    await payload.db.pool.query(
      "UPDATE catalogs SET _status = 'published' WHERE id = $1",
      [draft.id],
    );
    const published = await payload.findByID({
      collection: "catalogs",
      id: draft.id,
      draft: false,
      req: ownerReq,
      overrideAccess: false,
    });
    const publicRead = await get(publishedRoute);
    expect(publicRead.status).toBe(200);
    expect(publicRead.headers.get("Cache-Control")).toContain("no-store");
    expect(
      createHash("sha256")
        .update(Buffer.from(await publicRead.arrayBuffer()))
        .digest("hex"),
    ).toBe(publishedMedia.sha256);
    for (const route of [
      "media",
      `media/${publishedMedia.id}`,
      `media/${publishedMedia.id}?isReadingStaticFile=true`,
      privateRoute,
    ])
      expect((await get(route)).status).toBe(403);

    const edited = await saveDraft(ownerReq, {
      id: draft.id,
      expectedRevision: Number(published.revision),
      idempotencyKey: `local-draft-replacement-${suffix}`,
      content: {
        ...content,
        media: [selectedMediaSnapshot({ ...privateMedia }, catalogId, [])!],
      },
    });
    expect((await get(publishedRoute)).status).toBe(200);
    expect((await get(privateRoute)).status).toBe(403);

    vi.stubEnv("NODE_ENV", "production");
    expect((await get(publishedRoute)).status).toBe(403);
    vi.stubEnv("NODE_ENV", "development");
    await payload.update({
      collection: "catalogs",
      id: draft.id,
      data: { revision: edited.revision, _status: "draft" },
      draft: false,
      req: ownerReq,
      overrideAccess: false,
    });
    expect((await get(publishedRoute)).status).toBe(403);
    expect((await get(privateRoute)).status).toBe(403);
  });
});
