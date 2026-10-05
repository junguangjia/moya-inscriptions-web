import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AuthorCommunityService,
  CatalogReadService,
  EditorialContentReadService,
} from "@moya/api";
import {
  assertPostgresStartupReady,
  closePostgresPool,
  createPostgresPool,
  parsePostgresConfig,
  PostgresCatalogQueryAdapter,
  PostgresEditorialContentAdapter,
  runMigrations,
} from "@moya/catalog-postgres";
import {
  CommunitySchemaNotReadyError,
  PostgresCommunityDiscoveryAdapter,
  resolveCatalogRenditionRead,
  runCommunityMigrations,
  verifyCatalogDeliveryReadable,
} from "@moya/community-postgres";
import {
  articlePageSchema,
  catalogDetailSchema,
  catalogPageSchema,
  contentCardSchema,
} from "@moya/contracts/schemas";
import { MappedStorageUrlResolver } from "@moya/image";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { requireSyntheticTestDatabaseUrl } from "./synthetic-test-database.js";

import type { AuthorCommunityPort, CatalogPublicationPort } from "@moya/api";
import type { CatalogId } from "@moya/contracts";

const connectTo = (target: ReturnType<typeof createPostgresPool>) =>
  target.connect();
type PoolClient = Awaited<ReturnType<typeof connectTo>>;

/*
 * The Catalog rendition delivery view and its readers on real PostgreSQL
 * (unified media pipeline, PR 1b): community.catalog_media_delivery lists
 * only ready renditions on committed blobs of ready, referenced assets,
 * within the public resolution bound, with opaque delivery keys and context
 * levels; the post-Community grant lets a public read role select it and
 * nothing else; the readers composed with renditions join it. The legacy
 * Catalog tables live in a schema of this run; the community rows it creates
 * are removed afterwards. The SQL uses nothing beyond PostgreSQL 16.
 */

const testDatabaseUrl = requireSyntheticTestDatabaseUrl();
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const hex = (bytes = 16) => randomBytes(bytes).toString("hex");
const schema = `catalog_delivery_${hex(6)}`;
const pool = createPostgresPool(
  parsePostgresConfig({ DATABASE_URL: testDatabaseUrl }),
);
const isolatedUrl = new URL(testDatabaseUrl);
isolatedUrl.searchParams.set("options", `-c search_path=${schema}`);
const catalogPool = createPostgresPool(
  parsePostgresConfig({ DATABASE_URL: isolatedUrl.toString() }),
);
// Discovery reads its Catalog projections next to community tables.
const discoveryPool = createPostgresPool(
  parsePostgresConfig({ DATABASE_URL: testDatabaseUrl }),
);
discoveryPool.options.options = `-c search_path=${schema},public`;

const created = {
  assets: [] as string[],
  blobs: [] as string[],
  renditions: [] as string[],
};

interface Asset {
  readonly id: string;
  readonly mediaId: string;
  readonly objectKey: string;
}

/** A Catalog asset of a fresh approved key (its SHA-256 is part of the key). */
const asset = async (
  options: {
    readonly state?: "pending" | "ready" | "failed";
    readonly unreferenced?: boolean;
    readonly placeholder?: string | null;
  } = {},
): Promise<Asset> => {
  const mediaId = `media-delivery-${hex(8)}`;
  const sha = hex(32);
  const objectKey = `display/v1/media_${hex()}/${sha}.webp`;
  const state = options.state ?? "ready";
  const row = await pool.query<{ id: string }>(
    `INSERT INTO community.catalog_media_assets(
       id, media_id, source_object_key, source_sha256, state, failure_code,
       master_sha256, master_width, master_height, placeholder_color, unreferenced_since)
     VALUES ('catalog-asset-' || md5($1 || ':' || $2), $1, $2, $3, $4,
       CASE WHEN $4 = 'failed' THEN 'source_unreadable' END,
       CASE WHEN $4 = 'ready' THEN $3 END, CASE WHEN $4 = 'ready' THEN 4096 END,
       CASE WHEN $4 = 'ready' THEN 2731 END, $5,
       CASE WHEN $6 THEN CURRENT_TIMESTAMP END)
     RETURNING id`,
    [
      mediaId,
      objectKey,
      sha,
      state,
      options.placeholder === undefined ? "#3a2f28" : options.placeholder,
      options.unreferenced === true,
    ],
  );
  const id = row.rows[0]!.id;
  created.assets.push(id);
  return { id, mediaId, objectKey };
};

/** One rendition of an asset on its own owner-less blob. */
const rendition = async (
  of: Asset,
  role: "thumb" | "cover" | "display" | "viewer" | "full",
  width: number,
  height: number,
  options: {
    readonly state?: "ready" | "superseded" | "released";
    readonly blob?: "committed" | "tombstoned";
  } = {},
): Promise<{ readonly id: string; readonly storageKey: string }> => {
  const blob = `media-blob-${hex()}`;
  const storageKey = `blobs/${hex(1)}/${hex(1)}/${hex()}`;
  const blobState = options.blob ?? "committed";
  await pool.query(
    `INSERT INTO community.media_blobs(id, owner_id, purpose, storage_key, byte_size, sha256, content_type, state, tombstoned_at)
     VALUES ($1, NULL, 'catalog_derivative', $2, 2048, $3, 'image/webp', $4,
       CASE WHEN $4 = 'tombstoned' THEN CURRENT_TIMESTAMP END)`,
    [blob, storageKey, hex(32), blobState],
  );
  created.blobs.push(blob);
  const id = `media-rendition-${hex()}`;
  const state = options.state ?? "ready";
  await pool.query(
    `INSERT INTO community.media_renditions(
       id, catalog_asset_id, edit_key, role, recipe_version, recipe_digest, blob_id,
       width, height, content_type, state, superseded_at, released_at)
     VALUES ($1, $2, 'base', $3, 1, '0123456789abcdef', $4, $5, $6, 'image/webp', $7,
       CASE WHEN $7 = 'superseded' THEN CURRENT_TIMESTAMP END,
       CASE WHEN $7 = 'released' THEN CURRENT_TIMESTAMP END)`,
    [id, of.id, role, blob, width, height, state],
  );
  created.renditions.push(id);
  return { id, storageKey };
};

interface DeliveryRow {
  readonly media_id: string;
  readonly object_key: string;
  readonly role: string;
  readonly width: number;
  readonly height: number;
  readonly content_type: string;
  readonly delivery_key: string;
  readonly level: string;
  readonly placeholder_color: string | null;
}

const deliveryRows = async (
  of: Asset,
  client: { query: PoolClient["query"] } = pool,
) =>
  (
    await client.query<DeliveryRow>(
      "SELECT * FROM community.catalog_media_delivery WHERE media_id=$1 AND object_key=$2 ORDER BY width, height",
      [of.mediaId, of.objectKey],
    )
  ).rows;

// The published image: a 4096×2731 approved object with four renditions.
let published: Asset;
let renditionIds: Record<"thumb" | "cover" | "display" | "viewer", string>;
let displayStorageKey: string;
const catalogId = `catalog-delivery-${hex(8)}` as CatalogId;

beforeAll(async () => {
  await runCommunityMigrations(
    pool,
    path.join(repositoryRoot, "database", "community-migrations"),
  );
  await pool.query(`CREATE SCHEMA ${schema}`);
  await runMigrations(
    catalogPool,
    path.join(repositoryRoot, "database", "migrations"),
  );
  // Minimal published projections the editorial and discovery readers name.
  await pool.query(
    `CREATE TABLE ${schema}.article_entries(
       article_id text PRIMARY KEY, presentation text, title text, subtitle text,
       summary text, section text, issue text, byline text, intro text,
       cover_alt text, cover_catalog_id text, first_published_at timestamptz,
       published_at timestamptz, updated_at timestamptz);
     CREATE TABLE ${schema}.catalog_discovery(
       catalog_id text PRIMARY KEY, kind text, title text, aliases varchar[],
       first_published_at timestamptz, filter_metadata jsonb)`,
  );
  published = await asset();
  const thumb = await rendition(published, "thumb", 480, 320);
  const cover = await rendition(published, "cover", 1080, 720);
  const display = await rendition(published, "display", 2048, 1365);
  const viewer = await rendition(published, "viewer", 4096, 2731);
  // Not current: a superseded and a released thumb of the same asset.
  await rendition(published, "thumb", 480, 320, { state: "superseded" });
  await rendition(published, "thumb", 480, 320, { state: "released" });
  renditionIds = {
    thumb: thumb.id,
    cover: cover.id,
    display: display.id,
    viewer: viewer.id,
  };
  displayStorageKey = display.storageKey;
  await catalogPool.query(
    `INSERT INTO catalog_entries (catalog_id, kind, title, summary, description, period_label)
     VALUES ($1, 'inscription', '合成资料', NULL, NULL, NULL)`,
    [catalogId],
  );
  await catalogPool.query(
    `INSERT INTO catalog_media (media_id, catalog_id, position, is_representative, kind, alt_text, width, height, object_key)
     VALUES ($1, $2, 0, true, 'image', '合成拓片', 4096, 2731, $3)`,
    [published.mediaId, catalogId, published.objectKey],
  );
  await catalogPool.query(
    `INSERT INTO article_entries VALUES ($1, 'academic', '合成文章', NULL, NULL, NULL, NULL,
       '合成编辑室', NULL, NULL, $2, '2026-09-20T10:00:00Z', '2026-09-21T10:00:00Z', '2026-09-21T10:00:00Z')`,
    [`article-${hex()}`, catalogId],
  );
  await catalogPool.query(
    "INSERT INTO catalog_discovery VALUES ($1, 'inscription', '合成资料', ARRAY[]::varchar[], '2026-01-01', '{}'::jsonb)",
    [catalogId],
  );
}, 60_000);

afterAll(async () => {
  try {
    await pool.query(
      "DELETE FROM community.media_renditions WHERE id = ANY($1::text[])",
      [created.renditions],
    );
    await pool.query(
      "DELETE FROM community.media_blobs WHERE id = ANY($1::text[])",
      [created.blobs],
    );
    await pool.query(
      "DELETE FROM community.catalog_media_assets WHERE id = ANY($1::text[])",
      [created.assets],
    );
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } finally {
    await closePostgresPool(discoveryPool);
    await closePostgresPool(catalogPool);
    await closePostgresPool(pool);
  }
});

describe("community.catalog_media_delivery", () => {
  it("lists the current renditions of a ready, referenced asset with opaque keys and levels", async () => {
    const rows = await deliveryRows(published);
    expect(rows).toEqual([
      {
        media_id: published.mediaId,
        object_key: published.objectKey,
        role: "thumb",
        width: 480,
        height: 320,
        content_type: "image/webp",
        delivery_key: renditionIds.thumb,
        level: "card",
        placeholder_color: "#3a2f28",
      },
      {
        media_id: published.mediaId,
        object_key: published.objectKey,
        role: "cover",
        width: 1080,
        height: 720,
        content_type: "image/webp",
        delivery_key: renditionIds.cover,
        level: "card",
        placeholder_color: "#3a2f28",
      },
      {
        media_id: published.mediaId,
        object_key: published.objectKey,
        role: "display",
        width: 2048,
        height: 1365,
        content_type: "image/webp",
        delivery_key: renditionIds.display,
        level: "display",
        placeholder_color: "#3a2f28",
      },
      {
        media_id: published.mediaId,
        object_key: published.objectKey,
        role: "viewer",
        width: 4096,
        height: 2731,
        content_type: "image/webp",
        delivery_key: renditionIds.viewer,
        level: "zoom",
        placeholder_color: "#3a2f28",
      },
    ]);
    // No storage key, blob id or store name in any column.
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toMatch(/blobs\/|media-blob-|catalog-asset-/u);
    expect(
      rows.every(({ delivery_key }) =>
        /^media-rendition-[0-9a-f]{32}$/u.test(delivery_key),
      ),
    ).toBe(true);
  });

  it("omits pending, failed and unreferenced assets and renditions on uncommitted blobs", async () => {
    const pending = await asset({ state: "pending" });
    await rendition(pending, "display", 2048, 1365);
    const failed = await asset({ state: "failed" });
    await rendition(failed, "display", 2048, 1365);
    const unreferenced = await asset({ unreferenced: true });
    await rendition(unreferenced, "display", 2048, 1365);
    const tombstoned = await asset();
    await rendition(tombstoned, "display", 2048, 1365, { blob: "tombstoned" });
    await rendition(tombstoned, "thumb", 480, 320);
    for (const hidden of [pending, failed, unreferenced])
      expect(await deliveryRows(hidden)).toEqual([]);
    expect((await deliveryRows(tombstoned)).map(({ role }) => role)).toEqual([
      "thumb",
    ]);
    // A transparent image has no placeholder colour.
    const transparent = await asset({ placeholder: null });
    await rendition(transparent, "display", 2048, 1365);
    expect(await deliveryRows(transparent)).toMatchObject([
      { role: "display", placeholder_color: null },
    ]);
  });

  // The same predicate as community media (D3), including the half pixel by
  // which the recipe rounds each side: 2503 x 15984 (40,007,952 px) and
  // 10000 x 4000 (an aspect of exactly 2.5) are full@1 long-scroll outputs.
  it.each([
    [8192, 5461, true],
    [8193, 5462, false],
    [1200, 16000, true],
    [16000, 1200, true],
    [16001, 1200, false],
    [16000, 2600, false],
    [10000, 4000, true],
    [10000, 4002, false],
    [10000, 3999, true],
    [2503, 15984, true],
    [2504, 15984, false],
  ])(
    "applies the public resolution bound to full %i×%i (listed: %s)",
    async (width, height, listed) => {
      const scroll = await asset();
      await rendition(scroll, "display", 2048, 1365);
      await rendition(scroll, "full", width, height);
      expect(
        (await deliveryRows(scroll)).map(({ role }) => role).sort(),
      ).toEqual(listed ? ["display", "full"] : ["display"]);
    },
  );

  it("is a security_barrier view with no PUBLIC privilege", async () => {
    const view = await pool.query<{
      options: string[] | null;
      public_grants: number;
    }>(
      `SELECT c.reloptions AS options,
         (SELECT count(*)::int FROM aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
          WHERE a.grantee = 0) AS public_grants
       FROM pg_class c WHERE c.oid = 'community.catalog_media_delivery'::regclass`,
    );
    expect(view.rows).toEqual([
      { options: ["security_barrier=true"], public_grants: 0 },
    ]);
  });
});

describe("post-Community grants of the delivery view", () => {
  /**
   * Runs `check` as a role created inside a transaction that is always
   * rolled back: nothing of the role or its grants remains.
   */
  const asTemporaryRole = async (
    grantSql: (role: string) => string,
    check: (client: PoolClient) => Promise<void>,
  ) => {
    const client = await connectTo(pool);
    const role = `delivery_reader_${hex(6)}`;
    try {
      await client.query("BEGIN");
      await client.query(`CREATE ROLE ${role} NOLOGIN`);
      await client.query(grantSql(role));
      await client.query(`SET LOCAL ROLE ${role}`);
      await check(client);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  };

  /** The SQLSTATE of one statement run under a savepoint, or null. */
  const failure = async (client: PoolClient, sql: string) => {
    await client.query("SAVEPOINT probe");
    try {
      await client.query(sql);
      await client.query("RELEASE SAVEPOINT probe");
      return null;
    } catch (error) {
      await client.query("ROLLBACK TO SAVEPOINT probe");
      return (error as { code?: string }).code ?? "unknown";
    }
  };

  it("lets the public read role select the view and nothing beneath it", async () => {
    const file = await readFile(
      path.join(
        repositoryRoot,
        "infra/development/catalog-media/grant-public-read.sql",
      ),
      "utf8",
    );
    expect(file).not.toMatch(
      /ALL TABLES|community\.(?!catalog_media_delivery)/u,
    );
    await asTemporaryRole(
      (role) => file.replaceAll(':"public_read_role"', `"${role}"`),
      async (client) => {
        expect(
          (await deliveryRows(published, client)).map(
            ({ delivery_key }) => delivery_key,
          ),
        ).toEqual([
          renditionIds.thumb,
          renditionIds.cover,
          renditionIds.display,
          renditionIds.viewer,
        ]);
        for (const table of [
          "community.catalog_media_assets",
          "community.media_renditions",
          "community.media_blobs",
        ])
          expect(
            await failure(client, `SELECT 1 FROM ${table} LIMIT 1`),
            table,
          ).toBe("42501");
        expect(
          (
            await client.query<{ read: boolean; write: boolean }>(
              `SELECT has_table_privilege(current_user, 'community.catalog_media_delivery', 'SELECT') AS read,
                 has_table_privilege(current_user, 'community.catalog_media_delivery', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS write`,
            )
          ).rows,
        ).toEqual([{ read: true, write: false }]);
      },
    );
  });

  it("refuses the view to a role without the grant, and the App role grant names it", async () => {
    // The App role's startup check reads the view the same way.
    const verify = (client: PoolClient) =>
      verifyCatalogDeliveryReadable(
        client as unknown as Parameters<
          typeof verifyCatalogDeliveryReadable
        >[0],
      );
    await asTemporaryRole(
      (role) => `GRANT USAGE ON SCHEMA community TO ${role}`,
      async (client) => {
        expect(
          await failure(
            client,
            "SELECT 1 FROM community.catalog_media_delivery LIMIT 1",
          ),
        ).toBe("42501");
        await expect(verify(client)).rejects.toBeInstanceOf(
          CommunitySchemaNotReadyError,
        );
      },
    );
    const runtime = await readFile(
      path.join(
        repositoryRoot,
        "infra/development/work-publishing/grant-runtime.sql",
      ),
      "utf8",
    );
    const appGrant =
      'GRANT SELECT ON community.catalog_media_delivery TO :"app_role";';
    expect(runtime).toContain(appGrant);
    await asTemporaryRole(
      (role) =>
        `GRANT USAGE ON SCHEMA community TO ${role}; ${appGrant.replace(':"app_role"', role)}`,
      async (client) => {
        expect(await deliveryRows(published, client)).toHaveLength(4);
        await expect(verify(client)).resolves.toBeUndefined();
      },
    );
  });
});

describe("Catalog readers composed with renditions", () => {
  const url = (key: string) =>
    `http://127.0.0.1:3001/v1/development/catalog-renditions/${key}`;
  const resolver = () =>
    new MappedStorageUrlResolver(
      new Map([
        [published.objectKey, "https://media.example.invalid/approved.webp"],
      ]),
      new Map(
        Object.values(renditionIds).map((key) => [key, url(key)] as const),
      ),
    );
  const candidate = (
    role: keyof typeof renditionIds,
    width: number,
    height: number,
  ) => ({
    src: url(renditionIds[role]),
    width,
    height,
    contentType: "image/webp",
  });
  const cardList = () => [
    candidate("thumb", 480, 320),
    candidate("cover", 1080, 720),
    candidate("display", 2048, 1365),
  ];

  it("projects delivery facts only when composed with renditions", async () => {
    const plain = await new PostgresCatalogQueryAdapter(catalogPool).getById(
      catalogId,
    );
    expect(plain?.media[0]).not.toHaveProperty("renditions");
    expect(plain?.media[0]).not.toHaveProperty("placeholderColor");
    const joined = await new PostgresCatalogQueryAdapter(catalogPool, {
      renditions: true,
    }).getById(catalogId);
    expect(joined?.media[0]).toMatchObject({
      renditions: [
        {
          key: renditionIds.thumb,
          width: 480,
          height: 320,
          contentType: "image/webp",
          level: "card",
        },
        {
          key: renditionIds.cover,
          width: 1080,
          height: 720,
          contentType: "image/webp",
          level: "card",
        },
        {
          key: renditionIds.display,
          width: 2048,
          height: 1365,
          contentType: "image/webp",
          level: "display",
        },
        {
          key: renditionIds.viewer,
          width: 4096,
          height: 2731,
          contentType: "image/webp",
          level: "zoom",
        },
      ],
      placeholderColor: "#3a2f28",
    });
    await expect(
      assertPostgresStartupReady(catalogPool, "legacy", { renditions: true }),
    ).resolves.toBeUndefined();
  });

  it("serves card lists in list and search contexts and zoom levels on detail", async () => {
    const adapter = new PostgresCatalogQueryAdapter(catalogPool, {
      renditions: true,
    });
    const service = new CatalogReadService(adapter, resolver(), adapter);
    const page = catalogPageSchema.parse(
      await service.list({ page: 1, pageSize: 100 }),
    );
    expect(
      page.items.find(({ id }) => id === catalogId)?.representativeMedia,
    ).toMatchObject({
      src: url(renditionIds.display),
      width: 2048,
      height: 1365,
      renditions: cardList(),
      placeholderColor: "#3a2f28",
    });
    const detail = catalogDetailSchema.parse(await service.getById(catalogId));
    expect(detail.representativeMedia?.renditions).toEqual(cardList());
    expect(detail.media[0]?.renditions).toEqual([
      ...cardList(),
      candidate("viewer", 4096, 2731),
    ]);
    expect(JSON.stringify(detail)).not.toMatch(/blobs\/|display\/v1\//u);
  });

  it("gives editorial covers and discovery cards the same facts", async () => {
    const editorial = new EditorialContentReadService(
      new PostgresEditorialContentAdapter(catalogPool, { renditions: true }),
      resolver(),
    );
    const articles = articlePageSchema.parse(
      await editorial.listArticles({ page: 1, pageSize: 20 }),
    );
    expect(articles.items[0]?.cover?.renditions).toEqual(cardList());
    const cards = new AuthorCommunityService(
      {} as AuthorCommunityPort,
      {} as CatalogPublicationPort,
      undefined,
      new PostgresCommunityDiscoveryAdapter(discoveryPool),
      resolver(),
    );
    const card = contentCardSchema.parse(
      await cards.card({ type: "catalog", id: catalogId }, null),
    );
    expect(card.media).toEqual({
      id: published.mediaId,
      width: 2048,
      height: 1365,
      src: url(renditionIds.display),
      renditions: cardList(),
      placeholderColor: "#3a2f28",
    });
  });

  it("reads the committed blob of a listed rendition for the Development route only", async () => {
    expect(
      await resolveCatalogRenditionRead(
        pool,
        renditionIds.display,
        catalogPool,
      ),
    ).toEqual({
      storageKey: displayStorageKey,
      contentType: "image/webp",
      byteSize: 2048,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    const hidden = await asset({ unreferenced: true });
    const unlisted = await rendition(hidden, "display", 2048, 1365);
    for (const id of [
      unlisted.id,
      `media-rendition-${hex()}`,
      displayStorageKey,
      published.objectKey,
    ])
      expect(
        await resolveCatalogRenditionRead(pool, id, catalogPool),
      ).toBeNull();
  });

  it("refuses a withdrawn or replaced published reference before the worker sync", async () => {
    const replacedKey = `display/v1/media_${hex()}/${hex(32)}.webp`;
    await catalogPool.query(
      "UPDATE catalog_media SET object_key=$1 WHERE media_id=$2",
      [replacedKey, published.mediaId],
    );
    try {
      // The worker registry still lists this rendition; the live projection
      // has changed, so guessed rendition ids cannot serve the old bytes.
      expect(await deliveryRows(published)).toHaveLength(4);
      expect(
        await resolveCatalogRenditionRead(
          pool,
          renditionIds.display,
          catalogPool,
        ),
      ).toBeNull();
      await catalogPool.query("DELETE FROM catalog_media WHERE media_id=$1", [
        published.mediaId,
      ]);
      expect(
        await resolveCatalogRenditionRead(
          pool,
          renditionIds.display,
          catalogPool,
        ),
      ).toBeNull();
    } finally {
      await catalogPool.query("DELETE FROM catalog_media WHERE media_id=$1", [
        published.mediaId,
      ]);
      await catalogPool.query(
        `INSERT INTO catalog_media (media_id, catalog_id, position, is_representative, kind, alt_text, width, height, object_key)
         VALUES ($1, $2, 0, true, 'image', '合成拓片', 4096, 2731, $3)`,
        [published.mediaId, catalogId, published.objectKey],
      );
    }
  });
});
