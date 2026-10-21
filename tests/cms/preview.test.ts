import { randomUUID } from "node:crypto";
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
  type Payload,
  type PayloadRequest,
  type TypedUser,
} from "payload";
import config from "admin/config";
import { saveDraft } from "admin/editorial";
import {
  adminPreviewURL,
  editorialPreviewEndpoint,
  previewCatalogDetail,
} from "admin/preview";

const suffix = randomUUID();
const catalogId = `preview-${suffix}`;
let payload: Payload;
let owner: TypedUser;
let automation: TypedUser;
const reqFor = (user?: TypedUser) =>
  createLocalReq(user ? { user } : {}, payload);

beforeAll(async () => {
  if (process.env.CMS_ENVIRONMENT !== "synthetic")
    throw new Error("Synthetic CMS configuration required");
  payload = await getPayload({ config });
  const created = await payload.create({
    collection: "users",
    overrideAccess: true,
    data: {
      email: `preview-owner-${suffix}@example.invalid`,
      password: randomUUID(),
      role: "owner",
    },
  });
  owner = { ...created, collection: "users" };
  const scoped = await payload.create({
    collection: "users",
    overrideAccess: false,
    req: await reqFor(owner),
    data: {
      email: `preview-automation-${suffix}@example.invalid`,
      password: randomUUID(),
      role: "automation",
      scopeCatalogIds: [catalogId],
    },
  });
  automation = { ...scoped, collection: "users" };
}, 30_000);
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  await payload?.destroy();
});

const invoke = (req: PayloadRequest) => editorialPreviewEndpoint.handler(req);

describe.sequential("protected current draft preview", () => {
  it("maps real draft text/media to existing public DTO without private fields or implicit publication", async () => {
    vi.stubEnv("CMS_PUBLIC_URL", "https://cms.example.invalid");
    const mediaId = `preview-media-${suffix}`;
    const filename = `original-${suffix}.webp`;
    const objectKey = `editorial/${"b".repeat(64)}/${filename}`;
    await payload.create({
      collection: "media",
      req: await reqFor(owner),
      overrideAccess: false,
      data: {
        mediaId,
        catalogId,
        objectKey,
        sha256: "b".repeat(64),
        origin: "existing",
        mimeType: "image/webp",
        filesize: 123,
        width: 3,
        height: 2,
        alt: "Synthetic media caption",
        rights: "Fictional rights",
        orderConfidence: "LOW",
      },
    });
    const draft = await saveDraft(await reqFor(automation), {
      idempotencyKey: `preview-create-${suffix}`,
      content: {
        catalogId,
        sourceId: `source-${suffix}`,
        kind: "calligraphy",
        title: "Synthetic draft preview",
        ownerNote: "Fictional private operator note",
        transcription: { state: "VALUE", value: "虛構原文\n甲　乙〔缺〕" },
        media: [
          {
            mediaId,
            objectKey,
            width: 3,
            height: 2,
            alt: "Synthetic media caption",
            rights: "Fictional rights",
            orderConfidence: "LOW",
            position: 0,
            isRepresentative: true,
          },
        ],
      },
    });
    const detail = await previewCatalogDetail(
      await reqFor(automation),
      draft.id,
    );
    expect(detail.id).toBe(catalogId);
    expect(detail.title).toBe("Synthetic draft preview");
    expect(detail.transcription).toBe("虛構原文\n甲　乙〔缺〕");
    expect(detail.media).toHaveLength(1);
    expect(detail.media[0]).toMatchObject({
      id: mediaId,
      kind: "image",
      width: 3,
      height: 2,
    });
    expect(detail.representativeMedia).toEqual(detail.media[0]);
    expect(detail.media[0]?.src).toBe(
      `https://cms.example.invalid/api/media/file/${filename}`,
    );
    expect(JSON.stringify(detail)).not.toContain(objectKey);
    expect(JSON.stringify(detail)).not.toContain(
      "Fictional private operator note",
    );
    expect("sourceId" in detail).toBe(false);
    expect("provenance" in detail).toBe(false);
    expect(
      (
        await payload.findByID({
          collection: "catalogs",
          id: draft.id,
          req: await reqFor(owner),
          overrideAccess: false,
          draft: false,
        })
      )._status,
    ).toBe("draft");

    const req = await reqFor(owner);
    req.routeParams = { id: String(draft.id) };
    const response = await invoke(req);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("Vary")).toContain("Cookie");
    const unknownReq = await reqFor();
    unknownReq.routeParams = { id: String(draft.id) };
    expect((await invoke(unknownReq)).status).toBe(403);
  });

  it("shows an incomplete-state response without fabricating a missing title and hides out-of-scope records", async () => {
    const draft = await saveDraft(await reqFor(owner), {
      idempotencyKey: `preview-incomplete-${suffix}`,
      content: {
        catalogId: `incomplete-${suffix}`,
        sourceId: `incomplete-source-${suffix}`,
        kind: "inscription",
      },
    });
    const req = await reqFor(owner);
    req.routeParams = { id: String(draft.id) };
    const response = await invoke(req);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "PREVIEW_INCOMPLETE" });
    const scoped = await reqFor(automation);
    scoped.routeParams = { id: String(draft.id) };
    expect((await invoke(scoped)).status).toBe(404);
  });

  it("builds only configured origin links with a document id and no authentication material", () => {
    vi.stubEnv("CMS_PREVIEW_WEB_URL", "https://web.example.invalid");
    vi.stubEnv("CMS_PUBLIC_URL", "https://web.example.invalid");
    expect(adminPreviewURL({ id: 7 })).toBe(
      "https://web.example.invalid/editorial-preview/7",
    );
    expect(adminPreviewURL({ id: "../escape" })).toBeNull();
    vi.stubEnv("CMS_PUBLIC_URL", "https://other.example.invalid");
    expect(adminPreviewURL({ id: 7 })).toBeNull();
    vi.stubEnv("CMS_PUBLIC_URL", "https://web.example.invalid");
    vi.stubEnv(
      "CMS_PREVIEW_WEB_URL",
      "https://web.example.invalid/?untrusted=1",
    );
    expect(adminPreviewURL({ id: 7 })).toBeNull();
  });
});
