import { AuthorCommunityService } from "@moya/api";
import {
  catalogIdSchema,
  contentCardSchema,
  mediaIdSchema,
} from "@moya/contracts/schemas";
import { describe, expect, it } from "vitest";

import { FixtureCatalogPublicationPort } from "./community-comment-fixture.js";

import type {
  AuthorCommunityPort,
  CatalogPublicationPort,
  CommunityDiscoveryPort,
  DiscoveryCardMediaRecord,
  DiscoveryCardRecord,
  DiscussionPort,
  StorageUrlResolver,
} from "@moya/api";
import type {
  AuthorProfile,
  CatalogCommentId,
  CatalogId,
  OwnComment,
} from "@moya/contracts";

const owner = "user-0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f01";
const profile: AuthorProfile = {
  id: owner,
  handle: "dev-user-01",
  displayName: "拓片爱好者",
  bio: "",
  avatar: null,
  isOwner: false,
  following: false,
  privacy: {
    following: "public",
    followers: "public",
    favorites: "public",
    likes: "public",
  },
  totals: { works: 1, following: 2, followers: 3, favorites: 4, likes: 5 },
  nextAvatarChangeAt: null,
};

/** Only the members a test exercises; everything else is unreachable here. */
const authorPort = (calls: string[]): AuthorCommunityPort =>
  ({
    readProfile: async () => {
      calls.push("readProfile");
      return profile;
    },
    listPeople: async () => {
      calls.push("listPeople");
      return { items: [], total: 99, page: 1, pageSize: 1 };
    },
  }) as unknown as AuthorCommunityPort;

const ownComment = (id: string, target: OwnComment["target"]): OwnComment => ({
  id: `comment-${id.padStart(32, "0")}` as CatalogCommentId,
  rootId: `comment-${id.padStart(32, "0")}` as CatalogCommentId,
  text: "记录",
  createdAt: "2026-09-12T16:00:00.000Z",
  deleted: false,
  target,
});

const published = "catalog-published-01" as CatalogId;
const withdrawn = "catalog-withdrawn-02" as CatalogId;
const pageItems = [
  ownComment("1", { type: "catalog", id: published }),
  ownComment("2", { type: "catalog", id: withdrawn }),
  ownComment("3", {
    type: "work",
    id: "work-00000000000000000000000000000001",
  }),
  ownComment("4", { type: "catalog", id: published }),
  ownComment("5", null),
];
const discussionPort = {
  ownComments: async () => ({
    items: pageItems,
    total: pageItems.length,
    page: 1,
    pageSize: 20,
    totalPages: 1,
  }),
} as unknown as DiscussionPort;

describe("AuthorCommunityService", () => {
  it("returns the adapter's profile totals unchanged without re-reading the lists", async () => {
    const calls: string[] = [];
    const service = new AuthorCommunityService(
      authorPort(calls),
      new FixtureCatalogPublicationPort(),
      undefined,
      // A discovery port used to trigger a four-list override; it no longer may.
      {
        collection: async () => ({
          items: [],
          total: 77,
          page: 1,
          pageSize: 1,
        }),
      } as never,
    );
    const result = await service.profile(owner, null);
    expect(result).toEqual(profile);
    expect(result.totals).toEqual({
      works: 1,
      following: 2,
      followers: 3,
      favorites: 4,
      likes: 5,
    });
    expect(calls).toEqual(["readProfile"]);
  });

  it("resolves My Comments Catalog targets with one batched lookup per page, keeping order and null targets", async () => {
    const catalog = new FixtureCatalogPublicationPort();
    const service = new AuthorCommunityService(
      authorPort([]),
      catalog,
      discussionPort,
    );
    const page = await service.ownComments(owner, { page: 1, pageSize: 20 });
    expect(catalog.publishedIdsCalls).toEqual([[published, withdrawn]]);
    expect(page.items.map((item) => item.target)).toEqual([
      { type: "catalog", id: published },
      null,
      { type: "work", id: "work-00000000000000000000000000000001" },
      { type: "catalog", id: published },
      null,
    ]);
    expect(page.items.map((item) => item.id)).toEqual(
      pageItems.map((item) => item.id),
    );
    expect(page.total).toBe(5);
  });

  it("falls back to one isPublished call per distinct Catalog id when the port has no batched read", async () => {
    const asked: CatalogId[] = [];
    const catalog: CatalogPublicationPort = {
      isPublished: async (id) => {
        asked.push(id);
        return id === published;
      },
      readTitle: async () => null,
    };
    const service = new AuthorCommunityService(
      authorPort([]),
      catalog,
      discussionPort,
    );
    const page = await service.ownComments(owner, { page: 1, pageSize: 20 });
    expect([...asked].sort()).toEqual([published, withdrawn]);
    expect(page.items.map((item) => item.target?.id ?? null)).toEqual([
      published,
      null,
      "work-00000000000000000000000000000001",
      published,
      null,
    ]);
  });

  /** A service whose discovery port answers `record` for any card. */
  const cardService = (
    record: DiscoveryCardRecord,
    resolveMany?: StorageUrlResolver["resolveMany"],
  ) =>
    new AuthorCommunityService(
      authorPort([]),
      new FixtureCatalogPublicationPort(),
      undefined,
      { card: async () => record } as unknown as CommunityDiscoveryPort,
      resolveMany === undefined ? undefined : { resolveMany },
    );

  it("passes a work card's feed framing to its image and each gallery entry unchanged", async () => {
    const item = (n: string) => `media-item-${n.repeat(32)}`;
    const still = (id: string) => ({
      type: "work" as const,
      id,
      src: `/api/community/publishing/media/${id}/display/base`,
      width: 1200,
      height: 3600,
    });
    const record: DiscoveryCardRecord = {
      target: { type: "work", id: `work-${"e".repeat(32)}` },
      title: "长图作品",
      aliases: [],
      kind: null,
      authorId: owner,
      firstPublishedAt: null,
      live: false,
      media: { ...still(item("a")), feed: { fit: "cover", y: 0 } },
      gallery: [
        { ...still(item("a")), feed: { fit: "cover", y: 0 } },
        still(item("b")),
        { ...still(item("c")), live: true, feed: { fit: "contain" } },
      ],
      mediaCount: 3,
    };
    const delivered = contentCardSchema.parse(
      await cardService(record).card(record.target, null),
    );
    expect(delivered.media).toEqual({
      id: item("a"),
      src: still(item("a")).src,
      width: 1200,
      height: 3600,
      feed: { fit: "cover", y: 0 },
    });
    expect(delivered.gallery).toEqual([
      {
        id: item("a"),
        src: still(item("a")).src,
        width: 1200,
        height: 3600,
        feed: { fit: "cover", y: 0 },
      },
      {
        id: item("b"),
        src: still(item("b")).src,
        width: 1200,
        height: 3600,
      },
      {
        id: item("c"),
        src: still(item("c")).src,
        width: 1200,
        height: 3600,
        live: true,
        feed: { fit: "contain" },
      },
    ]);
    // An entry without framing carries no key at all (absent = centred).
    expect(delivered.gallery?.[1]).not.toHaveProperty("feed");
  });

  it("never carries feed framing onto a Catalog card image or gallery entry", async () => {
    const mediaId = mediaIdSchema.parse("media-feed-catalog-1");
    const image = {
      type: "catalog",
      id: mediaId,
      objectKey: "private/approved.webp",
      width: 1200,
      height: 3600,
      // A stray field the port type forbids must not leak into the card.
      feed: { fit: "contain" },
    } as unknown as DiscoveryCardMediaRecord;
    const record: DiscoveryCardRecord = {
      target: { type: "catalog", id: catalogIdSchema.parse("catalog-feed-1") },
      title: "长幅拓片",
      aliases: [],
      kind: "inscription",
      authorId: null,
      firstPublishedAt: null,
      media: image,
      gallery: [image],
      mediaCount: 1,
    };
    const approvedUrl = "https://media.example.invalid/approved.webp";
    const delivered = contentCardSchema.parse(
      await cardService(
        record,
        async () => new Map([[mediaId, approvedUrl]]),
      ).card(record.target, null),
    );
    expect(delivered.media).toEqual({
      id: mediaId,
      src: approvedUrl,
      width: 1200,
      height: 3600,
    });
    expect(delivered.gallery).toEqual([delivered.media]);
  });
});
