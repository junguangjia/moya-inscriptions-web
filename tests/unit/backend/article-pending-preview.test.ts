import { createHash, randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ArticlePublicationOperatorService,
  CommunityConflictError,
  CommunityNotFoundError,
  parseArticlePendingMediaQuery,
} from "@moya/api";
import type {
  ArticlePublicationOperatorPort,
  AuthorCommunityPort,
  PublishingMediaDelivery,
  PublishingMediaStorePort,
  WorkPublishingPort,
} from "@moya/api";
import {
  createBackendApplication,
  createBackendServer,
  createDevelopmentCatalogFixtureQueryPort,
  startServer,
  stopServer,
} from "@moya/backend-runtime";
import { UnconfiguredStorageUrlResolver } from "@moya/image";
import {
  articlePendingCandidateSchema,
  articlePendingMediaQuerySchema,
  articlePendingPreviewSchema,
} from "@moya/contracts/internal/community-operator";
import { publishingMediaItemSchema } from "@moya/contracts/schemas";
import type { CatalogDetail, PublicMedia } from "@moya/contracts";
import { InMemoryCommunityIdentityPort } from "./community-identity-fixture.js";
import { InMemoryCommunityCommentPort } from "./community-comment-fixture.js";

const itemId = `media-item-${"1".repeat(32)}`;
const unusedId = `media-item-${"2".repeat(32)}`;
const legacyId = `user-media-${"3".repeat(32)}`;
const catalogId = "catalog-synthetic-preview";
const catalogMediaId = "media-synthetic-preview";
const candidate = articlePendingCandidateSchema.parse({
  articleId: `article-${"4".repeat(32)}`,
  ownerId: `user-${"5".repeat(32)}`,
  expectedVersion: 3,
  candidateVersion: 2,
  fingerprint: "a".repeat(64),
  title: "Synthetic pending Article",
  publicVersion: null,
  submittedAt: "2026-10-02T00:00:00.000Z",
  coverRefId: "cover",
  document: {
    format: "blocknote",
    version: 1,
    blocks: [
      {
        id: "image",
        type: "managedImage",
        props: { refId: "visible", caption: "", alt: "" },
        children: [],
      },
    ],
    references: {
      visible: { type: "managed", itemId },
      cover: { type: "catalog", catalogId, mediaId: catalogMediaId },
      unused: { type: "managed", itemId: unusedId },
    },
    galleries: {},
  },
});
const query = articlePendingMediaQuerySchema.parse({
  expectedVersion: candidate.expectedVersion,
  candidateVersion: candidate.candidateVersion,
  fingerprint: candidate.fingerprint,
  refId: "visible",
  variant: "display",
});
const item = publishingMediaItemSchema.parse({
  id: itemId,
  kind: "static",
  qualityMode: "standard",
  state: "ready",
  failureCode: null,
  components: [
    {
      id: `media-component-${"6".repeat(32)}`,
      role: "still",
      state: "verified",
      byteSize: 4,
      receivedBytes: 4,
    },
  ],
  presentation: { width: 32, height: 24 },
  media: {
    thumbSrc: `/api/community/publishing/media/${itemId}/thumb/base`,
    displaySrc: `/api/community/publishing/media/${itemId}/display/base`,
  },
});
const bytes = Uint8Array.from([1, 2, 3, 4]);
const delivery = (): PublishingMediaDelivery => ({
  contentType: "image/webp",
  sha256: createHash("sha256").update(bytes).digest("hex"),
  read: {
    status: "ok",
    byteSize: bytes.length,
    contentLength: bytes.length,
    start: 0,
    end: bytes.length - 1,
    body: (async function* () {
      yield bytes;
    })(),
    close: vi.fn(async () => {}),
  },
});
const fixture = () => {
  const port: ArticlePublicationOperatorPort = {
    readPending: vi.fn(async () => candidate),
    listPending: vi.fn(async () => ({ items: [], nextCursor: null })),
    moderatePending: vi.fn(async () => {
      throw new Error("unexpected moderation");
    }),
  };
  const publishing = {
    readItem: vi.fn(async () => item),
    openMedia: vi.fn(async () => delivery()),
  };
  const catalogMedia = {
    id: catalogMediaId,
    kind: "image",
    src: "https://example.test/catalog.webp",
    alt: "Synthetic",
    width: 32,
    height: 24,
  } as PublicMedia;
  const catalog = {
    getById: vi.fn(async () => ({ media: [catalogMedia] }) as CatalogDetail),
  };
  const authorMedia = {
    readMedia: vi.fn(async () => ({ bytes, width: 32, height: 24 })),
  };
  const service = new ArticlePublicationOperatorService(port, {
    publishing,
    catalog,
    authorMedia,
  });
  return { port, publishing, catalog, authorMedia, service };
};

it("resolves only used/cover refs under the immutable owner and keeps metadata out", async () => {
  const f = fixture();
  const preview = await f.service.readPending(candidate.articleId);
  expect(Object.keys(preview.resolvedReferences)).toEqual(["cover", "visible"]);
  expect(f.publishing.readItem).toHaveBeenCalledExactlyOnceWith(
    candidate.ownerId,
    itemId,
  );
  expect(f.catalog.getById).toHaveBeenCalledExactlyOnceWith(catalogId);
  expect(preview.document).toEqual(candidate.document);
  expect(preview.resolvedReferences.visible).toEqual({
    type: "managed",
    media: {
      id: itemId,
      kind: "static",
      src: item.media!.displaySrc,
      width: 32,
      height: 24,
    },
  });
  expect(JSON.stringify(preview.resolvedReferences)).not.toMatch(
    /components|storageKey|original|privateMetadata/u,
  );
  expect(f.port.readPending).toHaveBeenCalledTimes(2);
});
it("returns unavailable for foreign, removed and unpublished refs without exposing them", async () => {
  const f = fixture();
  f.publishing.readItem.mockRejectedValue(new CommunityNotFoundError());
  f.catalog.getById.mockResolvedValue(null as unknown as CatalogDetail);
  expect(
    (await f.service.readPending(candidate.articleId)).resolvedReferences,
  ).toEqual({
    cover: { type: "unavailable", reason: "catalog_unavailable" },
    visible: { type: "unavailable", reason: "media_unavailable" },
  });
});
it("rechecks metadata after resolution and refuses a changed candidate", async () => {
  const f = fixture();
  vi.mocked(f.port.readPending)
    .mockResolvedValueOnce(candidate)
    .mockResolvedValueOnce({ ...candidate, expectedVersion: 4 });
  await expect(
    f.service.readPending(candidate.articleId),
  ).rejects.toBeInstanceOf(CommunityConflictError);
});
it.each(["expectedVersion", "candidateVersion", "fingerprint"] as const)(
  "refuses stale %s before any media operation",
  async (field) => {
    const f = fixture();
    const stale = {
      ...query,
      [field]: field === "fingerprint" ? "b".repeat(64) : 99,
    };
    await expect(
      f.service.openPendingMedia(candidate.articleId, stale),
    ).rejects.toBeInstanceOf(CommunityConflictError);
    expect(f.publishing.readItem).not.toHaveBeenCalled();
    expect(f.publishing.openMedia).not.toHaveBeenCalled();
    expect(f.authorMedia.readMedia).not.toHaveBeenCalled();
  },
);
it.each(["unused", "cover", "missing"])(
  "rejects ref %s before opening or resolving an arbitrary item",
  async (refId) => {
    const f = fixture();
    await expect(
      f.service.openPendingMedia(candidate.articleId, { ...query, refId }),
    ).rejects.toBeInstanceOf(CommunityNotFoundError);
    expect(f.publishing.readItem).not.toHaveBeenCalled();
    expect(f.publishing.openMedia).not.toHaveBeenCalled();
  },
);
it("opens only the referenced base derivative under the candidate owner", async () => {
  const f = fixture();
  const result = await f.service.openPendingMedia(candidate.articleId, query, {
    start: 1,
    end: 2,
  });
  expect(f.publishing.openMedia).toHaveBeenCalledExactlyOnceWith(
    candidate.ownerId,
    itemId,
    "display",
    "base",
    { start: 1, end: 2 },
  );
  expect(result.contentType).toBe("image/webp");
  expect(f.port.readPending).toHaveBeenCalledTimes(2);
});
it("serves the exact Live Photo motion and refuses a cancelled item", async () => {
  const f = fixture();
  f.publishing.readItem.mockResolvedValue({
    ...item,
    kind: "live",
    presentation: { width: 32, height: 24, hasAudio: false },
    media: {
      ...item.media!,
      motionSrc: `/api/community/publishing/media/${itemId}/motion/base`,
    },
  });
  await f.service.openPendingMedia(candidate.articleId, {
    ...query,
    variant: "motion",
  });
  expect(f.publishing.openMedia).toHaveBeenCalledExactlyOnceWith(
    candidate.ownerId,
    itemId,
    "motion",
    "base",
    undefined,
  );
  f.publishing.openMedia.mockClear();
  f.publishing.readItem.mockResolvedValue({
    ...item,
    state: "cancelled",
    media: null,
  });
  await expect(
    f.service.openPendingMedia(candidate.articleId, query),
  ).rejects.toBeInstanceOf(CommunityNotFoundError);
  expect(f.publishing.openMedia).not.toHaveBeenCalled();
});
it("refuses a foreign or revoked item before store I/O", async () => {
  const f = fixture();
  f.publishing.readItem.mockRejectedValue(new CommunityNotFoundError());
  await expect(
    f.service.openPendingMedia(candidate.articleId, query),
  ).rejects.toBeInstanceOf(CommunityNotFoundError);
  expect(f.publishing.openMedia).not.toHaveBeenCalled();
});
it.each(["changed", "withdrawn"])(
  "closes opened media before returning when candidate is %s",
  async (change) => {
    const f = fixture();
    const open = delivery();
    f.publishing.openMedia.mockResolvedValue(open);
    vi.mocked(f.port.readPending).mockResolvedValueOnce(candidate);
    if (change === "changed")
      vi.mocked(f.port.readPending).mockResolvedValueOnce({
        ...candidate,
        candidateVersion: 5,
      });
    else
      vi.mocked(f.port.readPending).mockRejectedValueOnce(
        new CommunityNotFoundError(),
      );
    await expect(
      f.service.openPendingMedia(candidate.articleId, query),
    ).rejects.toBeInstanceOf(
      change === "changed" ? CommunityConflictError : CommunityNotFoundError,
    );
    if (open.read.status === "ok")
      expect(open.read.close).toHaveBeenCalledOnce();
  },
);
it("serves legacy PNG through the existing owner media port with range and release", async () => {
  const f = fixture();
  f.publishing.readItem.mockResolvedValue({
    ...item,
    qualityMode: "legacy",
    media: {
      thumbSrc: `/api/community/media/${legacyId}`,
      displaySrc: `/api/community/media/${legacyId}`,
    },
  });
  const preview = await f.service.readPending(candidate.articleId);
  expect(preview.resolvedReferences.visible!.type).toBe("managed");
  const result = await f.service.openPendingMedia(candidate.articleId, query, {
    start: 1,
    end: 2,
  });
  expect(f.authorMedia.readMedia).toHaveBeenCalledExactlyOnceWith(
    legacyId,
    candidate.ownerId,
  );
  expect(f.publishing.openMedia).not.toHaveBeenCalled();
  expect(result.contentType).toBe("image/png");
  expect(result.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(result.read.status).toBe("ok");
  if (result.read.status === "ok") {
    const chunks = [];
    for await (const b of result.read.body) chunks.push(...b);
    expect(chunks).toEqual([2, 3]);
    await result.read.close();
  }
});
it("never treats a substituted URL as a legacy media authority", async () => {
  const f = fixture();
  f.publishing.readItem.mockResolvedValue({
    ...item,
    qualityMode: "legacy",
    media: {
      thumbSrc: `/api/community/media/${legacyId}`,
      displaySrc: `https://example.test/api/community/media/${legacyId}`,
    },
  });
  await expect(
    f.service.openPendingMedia(candidate.articleId, query),
  ).rejects.toBeInstanceOf(CommunityNotFoundError);
  expect(f.authorMedia.readMedia).not.toHaveBeenCalled();
  expect(f.publishing.openMedia).not.toHaveBeenCalled();
});
it("legacy deletion and motion substitution fail closed", async () => {
  const f = fixture();
  f.publishing.readItem.mockResolvedValue({
    ...item,
    qualityMode: "legacy",
    media: {
      thumbSrc: `/api/community/media/${legacyId}`,
      displaySrc: `/api/community/media/${legacyId}`,
    },
  });
  f.authorMedia.readMedia.mockResolvedValue(null as never);
  await expect(
    f.service.openPendingMedia(candidate.articleId, query),
  ).rejects.toBeInstanceOf(CommunityNotFoundError);
  f.authorMedia.readMedia.mockClear();
  await expect(
    f.service.openPendingMedia(candidate.articleId, {
      ...query,
      variant: "motion",
    }),
  ).rejects.toBeInstanceOf(CommunityNotFoundError);
  expect(f.authorMedia.readMedia).not.toHaveBeenCalled();
});
it("schema requires exactly matching used reference resolutions", async () => {
  const preview = await fixture().service.readPending(candidate.articleId);
  for (const refs of [
    {},
    {
      ...preview.resolvedReferences,
      unused: { type: "unavailable", reason: "media_unavailable" },
    },
    {
      ...preview.resolvedReferences,
      visible: preview.resolvedReferences.cover,
    },
    {
      ...preview.resolvedReferences,
      visible: { type: "unavailable", reason: "catalog_unavailable" },
    },
  ])
    expect(
      articlePendingPreviewSchema.safeParse({
        ...preview,
        resolvedReferences: refs,
      }).success,
    ).toBe(false);
});
it("strict URL query parser accepts decimal versions and rejects authority/URL substitution", () => {
  expect(
    parseArticlePendingMediaQuery({
      ...query,
      expectedVersion: "3",
      candidateVersion: "2",
    }),
  ).toEqual(query);
  for (const invalid of [
    { ...query, ownerId: candidate.ownerId },
    { ...query, itemId },
    { ...query, url: "https://example.test/" },
    { ...query, editKey: "base" },
    { ...query, variant: "full" },
    { ...query, expectedVersion: true },
    { ...query, expectedVersion: "1e2" },
    { ...query, expectedVersion: ["3", "3"] },
    { ...query, fingerprint: "a" },
  ])
    expect(() => parseArticlePendingMediaQuery(invalid)).toThrow();
});

const servers = new Set<Server>();
afterEach(async () => {
  await Promise.all([...servers].map((server) => stopServer(server)));
  servers.clear();
});
describe("Production private pending media HTTP boundary", () => {
  it("requires operator authority before reads and preserves HEAD/Range/no-store", async () => {
    const f = fixture();
    const credential = randomBytes(32).toString("hex");
    const work = {
      readItem: f.publishing.readItem,
      resolveMediaRead: vi.fn(async () => ({
        storageKey: "synthetic-preview",
        contentType: "image/webp",
        sha256: "a".repeat(64),
        byteSize: 4,
      })),
    } as unknown as WorkPublishingPort;
    const store = {
      openRead: vi.fn(
        async (_key: string, range?: { start: number; end?: number }) => {
          const value = delivery().read;
          if (value.status !== "ok") throw Error();
          return {
            ...value,
            body: (async function* () {
              yield range
                ? bytes.subarray(range.start, (range.end ?? 3) + 1)
                : bytes;
            })(),
            start: range?.start ?? 0,
            end: range?.end ?? 3,
            contentLength: range ? 2 : 4,
          };
        },
      ),
    } as unknown as PublishingMediaStorePort;
    const server = createBackendServer(
      createBackendApplication({
        nodeEnv: "production",
        catalogQueryPort: createDevelopmentCatalogFixtureQueryPort(),
        storageUrlResolver: new UnconfiguredStorageUrlResolver(),
        communityIdentityPort: new InMemoryCommunityIdentityPort(),
        communityCommentPort: new InMemoryCommunityCommentPort(),
        communityOperatorCredential: credential,
        articlePublicationOperatorPort: f.port,
        workPublishingPort: work,
        authorCommunityPort: f.authorMedia as unknown as AuthorCommunityPort,
        publishingMediaStore: store,
      }),
    );
    servers.add(server);
    const address = await startServer(server, { host: "127.0.0.1", port: 0 });
    const url = `http://${address.address}:${address.port}/internal/community/articles/${candidate.articleId}/submission-media?${new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]))}`;
    expect((await fetch(url)).status).toBe(401);
    expect(f.port.readPending).not.toHaveBeenCalled();
    const headers = { authorization: `Bearer ${credential}` };
    const response = await fetch(url, {
      headers: { ...headers, range: "bytes=1-2" },
    });
    expect(response.status).toBe(206);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-range")).toBe("bytes 1-2/4");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([2, 3]);
    const head = await fetch(url, { method: "HEAD", headers });
    expect(head.status).toBe(200);
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    const bad = await fetch(`${url}&ownerId=${candidate.ownerId}`, { headers });
    expect(bad.status).toBe(400);
  });
});
