import { randomUUID } from "node:crypto";

import { AuthorCommunityService } from "@moya/api";
import type { CatalogPublicationPort } from "@moya/api";
import {
  RECIPE_DIGESTS_V1,
  stillOutputSize,
} from "@moya/backend-production/internal/publishing-processing";
import {
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import {
  PostgresAuthorCommunityAdapter,
  PostgresCommunityDiscoveryAdapter,
  PostgresWorkPublishingAdapter,
  isRenditionRole,
  resolvePublishedArticleManagedMedia,
} from "@moya/community-postgres";
import {
  contentCardSchema,
  workMediaSchema,
  workSchema,
  workSubmissionCommandSchema,
} from "@moya/contracts/schemas";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import type {
  MediaCrop,
  MediaEdit,
  MediaRendition,
  MediaVariant,
  UserWork,
  WorkSubmissionContent,
  WorkSubmissionReceipt,
} from "@moya/contracts";

import { requireSyntheticTestDatabaseUrl } from "./synthetic-test-database.js";
import { cleanupPublishingData } from "./work-publishing-content-cases.js";

type Pool = ReturnType<typeof createPostgresPool>;

const hex = () => randomUUID().replaceAll("-", "");
const opaque = (prefix: string) => `${prefix}-${hex()}`;
const identity: MediaEdit = { rotation: 0, crop: null };
const now = new Date("2026-10-04T08:00:00.000Z");

const path = (itemId: string, role: string, editKey: string) =>
  `/api/community/publishing/media/${itemId}/${role}/${editKey}`;
const candidate = (
  itemId: string,
  role: string,
  editKey: string,
  width: number,
  height: number,
): MediaRendition => ({
  src: path(itemId, role, editKey),
  width,
  height,
  contentType: "image/webp",
});

/** The item, role and edit key a relay path names. */
const relayTarget = (src: string) => {
  const match =
    /^\/api\/community\/publishing\/media\/(media-item-[0-9a-f]{32})\/([a-z]+)\/(base|[0-9a-f]{32})$/u.exec(
      src,
    );
  if (match === null) throw new Error("not a relay path");
  return {
    itemId: match[1]!,
    variant: match[2]! as MediaVariant,
    editKey: match[3]!,
  };
};

/**
 * Real PostgreSQL cases for the rendition candidates of community media
 * (unified media pipeline increment 1, PR 1b): the WorkMedia detail list of
 * each item's edit framing, the cover's card list in its own framing (work
 * DTO and discovery card), published Article media in the unedited framing,
 * the D3 public bound on `full` in the DTOs and in the authorized relay, and
 * `viewer` through the relay. Registered from community-postgres.test.ts,
 * which guards TEST_DATABASE_URL first. Fixtures are the rows processing
 * records (ready items, committed blob rows, ready renditions of chosen
 * sizes); no bytes exist. Every case removes only the accounts it created;
 * Article rows, which are immutable, live only inside a rolled-back
 * transaction.
 */
export const registerMediaDeliveryTests = (pool: Pool) => {
  // The registering suite already guards the target; stay safe if moved.
  requireSyntheticTestDatabaseUrl();

  describe("media delivery candidates on real PostgreSQL", () => {
    const schema = `media_delivery_${hex()}`;
    const reads = createPostgresPool(
      parsePostgresConfig({ DATABASE_URL: requireSyntheticTestDatabaseUrl() }),
    );
    reads.options.options = `-c search_path=${schema},public`;
    const adapter = new PostgresWorkPublishingAdapter(pool);
    const authors = new PostgresAuthorCommunityAdapter(reads);
    const discovery = new PostgresCommunityDiscoveryAdapter(reads);
    const service = new AuthorCommunityService(
      authors,
      { isPublished: async () => false } as unknown as CatalogPublicationPort,
      undefined,
      discovery,
    );
    const users: string[] = [];
    let author: string, visitor: string;

    beforeAll(async () => {
      // Discovery reads the published Catalog projections next to works.
      await pool.query(`CREATE SCHEMA ${schema}`);
      await pool.query(
        `CREATE TABLE ${schema}.catalog_entries(catalog_id text PRIMARY KEY,province text,province_state text);CREATE TABLE ${schema}.catalog_discovery(catalog_id text PRIMARY KEY,kind text,title text,aliases varchar[],first_published_at timestamptz,filter_metadata jsonb);CREATE TABLE ${schema}.catalog_media(catalog_id text,media_id text,object_key text,width integer,height integer,is_representative boolean)`,
      );
    });
    afterAll(async () => {
      await reads.end();
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    });

    const user = async (label: string): Promise<string> => {
      const created = opaque("user");
      await pool.query(
        "INSERT INTO community.public_users(id,handle,display_name) VALUES($1,$2,$3)",
        [created, `md-${created.slice(-24)}`, label],
      );
      users.push(created);
      return created;
    };

    beforeEach(async () => {
      users.length = 0;
      author = await user("媒体作者");
      visitor = await user("媒体访客");
    });

    afterEach(async () => {
      await cleanupPublishingData(pool, users);
      for (const statement of [
        "DELETE FROM community.works WHERE author_id=ANY($1::text[])",
        "DELETE FROM community.author_command_receipts WHERE actor_id=ANY($1::text[])",
        "DELETE FROM community.author_events WHERE actor_id=ANY($1::text[])",
        "DELETE FROM community.public_users WHERE id=ANY($1::text[])",
      ])
        await pool.query(statement, [users]);
    });

    const blob = async (
      owner: string,
      purpose: "standard_master" | "derivative",
      contentType: string,
      byteSize = 1024,
    ) => {
      const digest = hex();
      const blobId = opaque("media-blob");
      await pool.query(
        "INSERT INTO community.media_blobs(id,owner_id,purpose,storage_key,byte_size,sha256,content_type) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          blobId,
          owner,
          purpose,
          `blobs/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}`,
          byteSize,
          digest + digest,
          contentType,
        ],
      );
      return blobId;
    };

    /** A ready static item as processing leaves it, before any rendition. */
    const mediaItem = async (
      owner: string,
      presentation: { readonly width: number; readonly height: number },
      placeholderColor: string | null = null,
    ): Promise<string> => {
      const itemId = opaque("media-item");
      await pool.query(
        `INSERT INTO community.media_items(id,owner_id,kind,quality_mode,source,state,declared_total_bytes,received_total_bytes,presentation,processing_profile,placeholder_color)
        VALUES($1,$2,'static','standard','upload','ready',2048,2048,$3::jsonb,'standard-image-v1',$4)`,
        [
          itemId,
          owner,
          JSON.stringify({ ...presentation, displayRotation: 0 }),
          placeholderColor,
        ],
      );
      await pool.query(
        "INSERT INTO community.media_components(id,item_id,owner_id,role,declared_bytes,declared_type,state,received_bytes,sha256,blob_id) VALUES($1,$2,$3,'still',1024,'image/jpeg','verified',1024,$4,$5)",
        [
          opaque("media-component"),
          itemId,
          owner,
          "a".repeat(64),
          await blob(owner, "standard_master", "image/jpeg"),
        ],
      );
      return itemId;
    };

    /** A ready version 1 still rendition with a committed blob; returns the blob id. */
    const rendition = async (
      itemId: string,
      owner: string,
      role: string,
      editKey: string,
      width: number,
      height: number,
      byteSize = 1024,
    ): Promise<string> => {
      if (!isRenditionRole(role)) throw new Error("Unknown rendition role");
      const blobId = await blob(owner, "derivative", "image/webp", byteSize);
      await pool.query(
        "INSERT INTO community.media_renditions(id,item_id,edit_key,role,recipe_version,recipe_digest,blob_id,width,height,content_type) VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,'image/webp')",
        [
          opaque("media-rendition"),
          itemId,
          editKey,
          role,
          RECIPE_DIGESTS_V1[role],
          blobId,
          width,
          height,
        ],
      );
      return blobId;
    };

    /** Several base renditions of one item: `[role, width, height]` each. */
    const renditions = async (
      itemId: string,
      owner: string,
      sizes: readonly (readonly [string, number, number])[],
      editKey = "base",
    ) => {
      const blobs: Record<string, string> = {};
      for (const [role, width, height] of sizes)
        blobs[role] = await rendition(
          itemId,
          owner,
          role,
          editKey,
          width,
          height,
        );
      return blobs;
    };

    const editKeyOf = async (edit: MediaEdit, coverCrop: MediaCrop | null) =>
      (
        await pool.query<{ key: string }>(
          "SELECT community.media_edit_key($1::jsonb,$2::jsonb) AS key",
          [
            JSON.stringify(edit),
            coverCrop === null ? null : JSON.stringify(coverCrop),
          ],
        )
      ).rows[0]!.key;

    const entry = (itemId: string) => ({
      key: `k-${itemId.slice(-20)}`,
      itemId,
      kind: "static" as const,
      qualityMode: "standard" as const,
      edit: identity,
    });

    /** Confirms one public submission through a held session, as the editor does. */
    const publish = async (
      owner: string,
      over: Partial<WorkSubmissionContent>,
    ): Promise<WorkSubmissionReceipt> => {
      const sessionId = opaque("publishing-session");
      await pool.query(
        "INSERT INTO community.publishing_sessions(id,owner_id,save_mode,work_id,state,lease_expires_at) VALUES($1,$2,'unsaved',NULL,'active','2100-01-01T00:00:00Z')",
        [sessionId, owner],
      );
      const result = await adapter.submit(
        owner,
        workSubmissionCommandSchema.parse({
          requestId: randomUUID(),
          holder: { sessionId },
          content: {
            title: "",
            body: "",
            authorship: { kind: "original" },
            visibility: "public",
            items: [],
            coverKey: null,
            coverCrop: null,
            ...over,
          },
          baseRevisionId: null,
        }),
        now,
      );
      if (result.state !== "confirmed")
        throw new Error(`expected a confirmed submission, got ${result.state}`);
      return result;
    };

    /** Every candidate of a work's lists, which the relay must serve to its readers. */
    const listedCandidates = (work: UserWork) => [
      ...work.media.flatMap((media) => media.renditions ?? []),
      ...(work.coverRenditions ?? []),
    ];

    const read = (viewer: string | null, src: string) => {
      const target = relayTarget(src);
      return adapter.resolveMediaRead(
        viewer,
        target.itemId,
        target.variant,
        target.editKey,
      );
    };

    it("lists detail candidates in each item's edit framing and the cover's card candidates in its own framing", async () => {
      const crop: MediaCrop = { x: 0.1, y: 0.1, width: 0.5, height: 0.5 };
      const cropKey = await editKeyOf(identity, crop);
      expect(cropKey).not.toBe("base");
      // The cover item: processing left its base thumb and cover; its cover
      // crop has its own (square) thumb and cover.
      const cover = await mediaItem(
        author,
        { width: 6000, height: 4000 },
        "#a1b2c3",
      );
      await renditions(cover, author, [
        ["thumb", 480, 320],
        ["cover", 1080, 720],
        ["display", 2048, 1365],
        ["viewer", 4096, 2731],
        ["full", 6000, 4000],
      ]);
      await renditions(
        cover,
        author,
        [
          ["thumb", 480, 480],
          ["cover", 1080, 1080],
        ],
        cropKey,
      );
      // An ordinary portrait item without a placeholder colour or viewer.
      const other = await mediaItem(author, { width: 3000, height: 4000 });
      await renditions(other, author, [
        ["thumb", 360, 480],
        ["cover", 810, 1080],
        ["display", 1536, 2048],
        ["full", 3000, 4000],
      ]);
      const coverEntry = entry(cover);
      const work = await publish(author, {
        title: "封面裁切",
        items: [coverEntry, entry(other)],
        coverKey: coverEntry.key,
        coverCrop: crop,
      });

      const coverRenditions = [
        candidate(cover, "thumb", cropKey, 480, 480),
        candidate(cover, "cover", cropKey, 1080, 1080),
      ];
      for (const viewer of [visitor, author, null]) {
        const view = await authors.readWork(work.workId, viewer);
        expect(workSchema.safeParse(view).success).toBe(true);
        expect(view.media).toEqual([
          {
            id: cover,
            src: path(cover, "display", "base"),
            width: 2048,
            height: 1365,
            kind: "static",
            // The cover item's cropped thumb and cover and its base thumb
            // and cover (the relay serves those under the crop key only)
            // never join its full-frame list.
            renditions: [
              candidate(cover, "display", "base", 2048, 1365),
              candidate(cover, "viewer", "base", 4096, 2731),
              candidate(cover, "full", "base", 6000, 4000),
            ],
            placeholderColor: "#a1b2c3",
          },
          {
            id: other,
            src: path(other, "display", "base"),
            width: 1536,
            height: 2048,
            kind: "static",
            renditions: [
              candidate(other, "thumb", "base", 360, 480),
              candidate(other, "cover", "base", 810, 1080),
              candidate(other, "display", "base", 1536, 2048),
              candidate(other, "full", "base", 3000, 4000),
            ],
          },
        ]);
        expect(view.media[1]).not.toHaveProperty("placeholderColor");
        expect(view.coverSrc).toBe(path(cover, "cover", cropKey));
        expect(view.coverRenditions).toEqual(coverRenditions);
      }

      // Every listed candidate is one the relay serves to every reader of the
      // work; the cover item's base card stills stay the owner's.
      const listed = listedCandidates(
        await authors.readWork(work.workId, visitor),
      );
      expect(listed).toHaveLength(9);
      for (const listedCandidate of listed)
        for (const viewer of [visitor, null, author])
          expect(await read(viewer, listedCandidate.src)).not.toBeNull();
      for (const role of ["thumb", "cover"]) {
        expect(await read(visitor, path(cover, role, "base"))).toBeNull();
        expect(await read(author, path(cover, role, "base"))).not.toBeNull();
      }

      // The discovery card and the public card carry the same cover list.
      const target = { type: "work" as const, id: work.workId };
      expect((await discovery.card(target, visitor)).media).toEqual({
        type: "work",
        id: cover,
        src: path(cover, "cover", cropKey),
        width: 1080,
        height: 1080,
        renditions: coverRenditions,
        placeholderColor: "#a1b2c3",
      });
      const publicCard = await service.card(target, visitor);
      expect(contentCardSchema.parse(publicCard)).toEqual(publicCard);
      expect(publicCard.media).toEqual({
        id: cover,
        src: path(cover, "cover", cropKey),
        width: 1080,
        height: 1080,
        renditions: coverRenditions,
        placeholderColor: "#a1b2c3",
      });
    });

    it("anchors the first-item cover on the derivative its src names, with only smaller card candidates of that framing", async () => {
      const first = await mediaItem(author, { width: 4000, height: 3000 });
      const blobs = await renditions(first, author, [
        ["thumb", 480, 360],
        ["display", 2048, 1536],
        ["full", 4000, 3000],
      ]);
      const work = await publish(author, {
        title: "首图封面",
        items: [entry(first)],
      });
      const target = { type: "work" as const, id: work.workId };
      // Without a cover derivative the card shows the display image.
      let view = await authors.readWork(work.workId, visitor);
      expect(view.coverSrc).toBe(path(first, "display", "base"));
      expect(view.coverRenditions).toEqual([
        candidate(first, "thumb", "base", 480, 360),
        candidate(first, "display", "base", 2048, 1536),
      ]);
      expect(view.media[0]?.renditions).toEqual([
        candidate(first, "thumb", "base", 480, 360),
        candidate(first, "display", "base", 2048, 1536),
        candidate(first, "full", "base", 4000, 3000),
      ]);
      const publicCard = await service.card(target, null);
      expect(contentCardSchema.parse(publicCard).media).toEqual({
        id: first,
        src: path(first, "display", "base"),
        width: 2048,
        height: 1536,
        renditions: view.coverRenditions,
      });

      // With one, the card stops at the cover: the display is a zoom level.
      blobs.cover = await rendition(first, author, "cover", "base", 1080, 810);
      view = await authors.readWork(work.workId, visitor);
      expect(workSchema.safeParse(view).success).toBe(true);
      expect(view.coverSrc).toBe(path(first, "cover", "base"));
      expect(view.coverRenditions).toEqual([
        candidate(first, "thumb", "base", 480, 360),
        candidate(first, "cover", "base", 1080, 810),
      ]);
      expect((await discovery.card(target, visitor)).media).toMatchObject({
        src: path(first, "cover", "base"),
        renditions: view.coverRenditions,
      });

      // A candidate whose blob is gone leaves the lists; without its anchor a
      // list is omitted and the entry keeps its src (legacy fallback).
      const tombstone = (ids: readonly (string | undefined)[]) =>
        pool.query(
          "UPDATE community.media_blobs SET state='tombstoned',tombstoned_at=$2::timestamptz WHERE id=ANY($1::text[])",
          [ids, now],
        );
      await tombstone([blobs.thumb]);
      view = await authors.readWork(work.workId, visitor);
      expect(workSchema.safeParse(view).success).toBe(true);
      expect(view.coverRenditions).toEqual([
        candidate(first, "cover", "base", 1080, 810),
      ]);
      expect(view.media[0]?.renditions).toEqual([
        candidate(first, "cover", "base", 1080, 810),
        candidate(first, "display", "base", 2048, 1536),
        candidate(first, "full", "base", 4000, 3000),
      ]);
      await tombstone([blobs.cover, blobs.display]);
      view = await authors.readWork(work.workId, visitor);
      expect(workSchema.safeParse(view).success).toBe(true);
      expect(view.coverSrc).toBe(path(first, "cover", "base"));
      expect(view).not.toHaveProperty("coverRenditions");
      expect(view.media).toEqual([
        {
          id: first,
          src: path(first, "display", "base"),
          width: 2048,
          height: 1536,
          kind: "static",
        },
      ]);
      expect((await discovery.card(target, visitor)).media).toEqual({
        type: "work",
        id: first,
        src: path(first, "cover", "base"),
        width: 1080,
        height: 810,
      });
      expect(
        contentCardSchema.parse(await service.card(target, null)).media,
      ).not.toHaveProperty("renditions");
    });

    it("exposes a public full only within D3 in the DTO and the relay while the owner reads every full", async () => {
      // [display, full, public]: ordinary images up to 8192 on the long edge;
      // long scrolls (long edge > 2.5 x short edge) up to 16000 and 40 MP,
      // with the half pixel by which the recipe rounds each side.
      const recipe = (width: number, height: number) =>
        [
          stillOutputSize("display", { width, height }),
          stillOutputSize("full", { width, height }),
        ].map(({ width: w, height: h }) => [w, h] as const);
      const [scrollDisplay, scrollFull] = recipe(2504, 15993);
      const [edgeDisplay, edgeFull] = recipe(12501, 5000);
      // Real full@1 outputs of long-scroll frames: 2503 x 15984 is
      // 40,007,952 px, and 10000 x 4000 has an aspect of exactly 2.5.
      expect([scrollFull, edgeFull]).toEqual([
        [2503, 15984],
        [10000, 4000],
      ]);
      const cases: readonly (readonly [
        readonly [number, number],
        readonly [number, number],
        boolean,
      ])[] = [
        [[2048, 1365], [8192, 5461], true],
        [[2048, 1365], [8193, 5462], false],
        [edgeDisplay!, edgeFull!, true],
        // Below 2.5 by more than the rounding: not a long scroll.
        [[2048, 820], [10000, 4002], false],
        [[2048, 819], [10000, 3999], true],
        [scrollDisplay!, scrollFull!, true],
        // Above 40 MP by more than the rounding.
        [[1280, 8171], [2504, 15984], false],
        [[8000, 600], [16000, 1200], true],
        [[8000, 1250], [16000, 2500], true],
        [[8000, 600], [16001, 1200], false],
        [[8000, 1300], [16000, 2600], false],
        [[600, 8000], [1200, 16000], true],
        [[600, 8000], [1200, 16001], false],
      ];
      const items: { itemId: string; full: string; public: boolean }[] = [];
      for (const [display, full, open] of cases) {
        const itemId = await mediaItem(author, {
          width: full[0],
          height: full[1],
        });
        const scale = 480 / Math.max(...full);
        await renditions(itemId, author, [
          [
            "thumb",
            Math.max(1, Math.round(full[0] * scale)),
            Math.max(1, Math.round(full[1] * scale)),
          ],
          ["display", ...display],
          ["full", ...full],
        ]);
        items.push({
          itemId,
          full: path(itemId, "full", "base"),
          public: open,
        });
      }
      // A viewer zoom level is read like display and full.
      const zoomed = items[0]!.itemId;
      await rendition(zoomed, author, "viewer", "base", 4096, 2731);
      const work = await publish(author, {
        title: "公开分辨率",
        items: items.map((item) => entry(item.itemId)),
      });

      for (const viewer of [visitor, author, null]) {
        const view = await authors.readWork(work.workId, viewer);
        expect(workSchema.safeParse(view).success).toBe(true);
        expect(
          view.media.map((media) =>
            (media.renditions ?? []).some((listed) =>
              listed.src.includes("/full/"),
            ),
          ),
        ).toEqual(items.map((item) => item.public));
      }
      expect(
        (await authors.readWork(work.workId, visitor)).media[0]?.renditions,
      ).toEqual([
        candidate(zoomed, "thumb", "base", 480, 320),
        candidate(zoomed, "display", "base", 2048, 1365),
        candidate(zoomed, "viewer", "base", 4096, 2731),
        candidate(zoomed, "full", "base", 8192, 5461),
      ]);
      for (const item of items) {
        for (const viewer of [visitor, null])
          expect((await read(viewer, item.full)) !== null).toBe(item.public);
        expect(await read(author, item.full)).not.toBeNull();
        expect(
          await read(visitor, path(item.itemId, "display", "base")),
        ).not.toBeNull();
      }
      for (const viewer of [visitor, null, author])
        expect(
          await read(viewer, path(zoomed, "viewer", "base")),
        ).toMatchObject({ contentType: "image/webp", byteSize: 1024 });

      // A self-only work keeps every zoom level its owner's.
      expect(
        await adapter.setVisibility(
          author,
          work.workId,
          { requestId: randomUUID(), visibility: "self" },
          new Date(now.getTime() + 60_000),
        ),
      ).toEqual({ workId: work.workId, visibility: "self" });
      for (const src of [
        path(zoomed, "viewer", "base"),
        path(zoomed, "full", "base"),
        path(zoomed, "display", "base"),
      ]) {
        expect(await read(visitor, src)).toBeNull();
        expect(await read(null, src)).toBeNull();
        expect(await read(author, src)).not.toBeNull();
      }
    });

    it("admits every full the v1 recipe renders and refuses sizes past its rounding", async () => {
      // The D3 predicate itself, on PostgreSQL's exact numeric arithmetic,
      // against the recipe's own geometry: ordinary frames, and long scrolls
      // across the long-edge, pixel-cap and near-2.5 regimes, both ways up.
      const { withinPublicPolicySql } = (await import(
        new URL(
          "../../../services/community-postgres/src/publishing/rendition-read.ts",
          import.meta.url,
        ).href
      )) as { readonly withinPublicPolicySql: (alias: string) => string };
      const frames: { width: number; height: number }[] = [
        { width: 2504, height: 15993 },
        { width: 12501, height: 5000 },
      ];
      for (let short = 1; short <= 9_000; short += 97)
        for (const aspect of [2.5001, 2.51, 2.7, 3.3, 4.1, 5.2, 6.3, 6.5, 9]) {
          const long = Math.floor(short * aspect) + 1;
          if (long * short <= 120_000_000)
            frames.push(
              { width: long, height: short },
              { width: short, height: long },
            );
        }
      for (let width = 500; width <= 12_000; width += 1_150)
        for (
          let height = Math.ceil(width / 2.5);
          height <= Math.min(12_000, width * 2.5);
          height += 1_310
        )
          frames.push({ width, height });
      const outputs = frames.map((frame) => stillOutputSize("full", frame));
      const evaluate = async (
        sizes: readonly { readonly width: number; readonly height: number }[],
        admitted: boolean,
      ) =>
        (
          await pool.query<{ width: number; height: number }>(
            `SELECT r.width,r.height
             FROM (SELECT 'full'::text AS role,s.width,s.height
                   FROM unnest($1::int[],$2::int[]) AS s(width,height)) r
             WHERE (${withinPublicPolicySql("r")}) = $3`,
            [
              sizes.map(({ width }) => width),
              sizes.map(({ height }) => height),
              admitted,
            ],
          )
        ).rows;
      expect(outputs.length).toBeGreaterThan(1_000);
      expect(await evaluate(outputs, false)).toEqual([]);
      const beyond = [
        [8193, 5462],
        [5462, 8193],
        [10000, 4002],
        [9000, 3602],
        [2504, 15984],
        [15984, 2504],
        [16001, 1200],
        [16000, 2600],
        [1200, 16001],
        [8200, 8200],
      ].map(([width, height]) => ({ width: width!, height: height! }));
      expect(await evaluate(beyond, true)).toEqual([]);
    });

    it("lists unedited-framing detail candidates for published Article media and bounds Article readers by D3", async () => {
      const item = await mediaItem(
        author,
        { width: 6000, height: 4000 },
        "#102030",
      );
      await renditions(item, author, [
        ["thumb", 480, 320],
        ["cover", 1080, 720],
        ["display", 2048, 1365],
        ["viewer", 4096, 2731],
        ["full", 6000, 4000],
      ]);
      // An edit of the same item is never an Article candidate.
      await rendition(item, author, "display", hex(), 1365, 2048);
      const large = await mediaItem(author, { width: 9000, height: 6000 });
      await renditions(large, author, [
        ["thumb", 480, 320],
        ["display", 2048, 1365],
        ["full", 9000, 6000],
      ]);

      // Article revisions are immutable: the publication exists only inside
      // this transaction, which every read below shares and which is rolled
      // back afterwards.
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const scoped = {
          connect: async () => ({
            query: (sql: string, values?: unknown[]) =>
              /^(BEGIN|COMMIT|ROLLBACK)\b/u.test(sql.trimStart())
                ? Promise.resolve({ rows: [], rowCount: 0 })
                : client.query(sql, values),
            release: () => undefined,
          }),
        } as unknown as Pool;
        const article = opaque("article");
        const document = JSON.stringify({
          format: "blocknote",
          version: 1,
          blocks: [],
        });
        const fingerprint = "c".repeat(64);
        await client.query(
          `INSERT INTO community.article_documents(id,owner_id,version,title,document,fingerprint,status,published_version,first_published_at,published_at,created_at,updated_at)
          VALUES($1,$2,2,'合成文章',$3::jsonb,$4,'published',1,$5::timestamptz,$5::timestamptz,$5::timestamptz,$5::timestamptz)`,
          [article, author, document, fingerprint, now],
        );
        await client.query(
          `INSERT INTO community.article_revisions(article_id,version,owner_id,title,document,fingerprint,submitted_policy,submitted_by_source,created_at)
          VALUES($1,1,$2,'合成文章',$3::jsonb,$4,'DIRECT_PUBLICATION','human',$5::timestamptz)`,
          [article, author, document, fingerprint, now],
        );
        await client.query(
          `INSERT INTO community.media_item_refs(item_id,holder_kind,holder_id)
          SELECT unnest($2::text[]),'article_revision','article-revision-'||substr(encode(sha256(convert_to($1::text||':1','UTF8')),'hex'),1,32)`,
          [article, [item, large]],
        );

        const resolved = await resolvePublishedArticleManagedMedia(
          scoped,
          author as Parameters<typeof resolvePublishedArticleManagedMedia>[1],
          [item, large],
        );
        expect(resolved.get(item)).toEqual({
          id: item,
          kind: "static",
          src: path(item, "display", "base"),
          width: 6000,
          height: 4000,
          renditions: [
            candidate(item, "thumb", "base", 480, 320),
            candidate(item, "cover", "base", 1080, 720),
            candidate(item, "display", "base", 2048, 1365),
            candidate(item, "viewer", "base", 4096, 2731),
            candidate(item, "full", "base", 6000, 4000),
          ],
          placeholderColor: "#102030",
        });
        expect(resolved.get(large)).toEqual({
          id: large,
          kind: "static",
          src: path(large, "display", "base"),
          width: 9000,
          height: 6000,
          renditions: [
            candidate(large, "thumb", "base", 480, 320),
            candidate(large, "display", "base", 2048, 1365),
          ],
        });
        for (const media of resolved.values())
          expect(workMediaSchema.parse(media)).toEqual(media);

        const relay = new PostgresWorkPublishingAdapter(scoped);
        const articleRead = (
          viewer: string | null,
          itemId: string,
          variant: MediaVariant,
        ) => relay.resolveMediaRead(viewer, itemId, variant, "base");
        for (const viewer of [visitor, null]) {
          expect(await articleRead(viewer, item, "viewer")).not.toBeNull();
          expect(await articleRead(viewer, item, "full")).not.toBeNull();
          expect(await articleRead(viewer, large, "display")).not.toBeNull();
          expect(await articleRead(viewer, large, "full")).toBeNull();
        }
        expect(await articleRead(author, large, "full")).not.toBeNull();
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
      // Rolled back: no reader but the owner reaches the items again.
      expect(await read(visitor, path(item, "viewer", "base"))).toBeNull();
      expect(await read(author, path(item, "viewer", "base"))).not.toBeNull();
    });
  });
};
