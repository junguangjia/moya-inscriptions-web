import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  catalogExpectedRenditions,
  createCatalogPublishedRenditions,
} from "@moya/backend-production/internal/catalog-delivery";
import {
  closePostgresPool,
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import { runCommunityMigrations } from "@moya/community-postgres";
import { catalogPublishedRenditionsRequestSchema } from "@moya/contracts/internal/editorial";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { requireSyntheticTestDatabaseUrl } from "./synthetic-test-database.js";

/*
 * The Admin publish gate's App facts on real PostgreSQL: an editorial source
 * already live counts as complete only with every current-recipe rendition
 * ready on a committed blob and published once. The rows this run creates are
 * removed afterwards.
 */

const testDatabaseUrl = requireSyntheticTestDatabaseUrl();
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const hex = (bytes = 16) => randomBytes(bytes).toString("hex");
const pool = createPostgresPool(
  parsePostgresConfig({ DATABASE_URL: testDatabaseUrl }),
);
const created = {
  assets: [] as string[],
  publicAssets: [] as string[],
  blobs: [] as string[],
  renditions: [] as string[],
  publications: [] as string[],
};
const at = new Date("2026-10-21T00:00:00.000Z");

/** One live editorial source with its current set; `published` picks roles. */
const liveSource = async (
  published: (role: string) => boolean = () => true,
) => {
  const sha = hex(32);
  const mediaId = `media-gate-${hex(8)}`;
  const objectKey = `editorial/${hex(32)}/${hex(32)}-${sha}.jpg`;
  const asset = (
    await pool.query<{ id: string }>(
      `INSERT INTO community.catalog_media_assets(
         id, media_id, source_object_key, source_sha256, state,
         master_sha256, master_width, master_height)
       VALUES ('catalog-asset-' || md5($1 || ':' || $2), $1, $2, $3, 'ready', $3, 4096, 2731)
       RETURNING id`,
      [mediaId, objectKey, sha],
    )
  ).rows[0]!.id;
  created.assets.push(asset);
  const publicAsset = hex();
  await pool.query(
    "INSERT INTO community.media_public_assets(id,catalog_asset_id,desired_at,created_at,updated_at) VALUES($1,$2,$3,$3,$3)",
    [publicAsset, asset, at],
  );
  created.publicAssets.push(publicAsset);
  for (const want of catalogExpectedRenditions(4096, 2731)) {
    const blob = `media-blob-${hex()}`;
    const storageKey = `blobs/${hex(1)}/${hex(1)}/${hex()}`;
    const blobSha = hex(32);
    await pool.query(
      `INSERT INTO community.media_blobs(id, owner_id, purpose, storage_key, byte_size, sha256, content_type, state)
       VALUES ($1, NULL, 'catalog_derivative', $2, 2048, $3, 'image/webp', 'committed')`,
      [blob, storageKey, blobSha],
    );
    created.blobs.push(blob);
    const rendition = `media-rendition-${hex()}`;
    await pool.query(
      `INSERT INTO community.media_renditions(
         id, catalog_asset_id, edit_key, role, recipe_version, recipe_digest, blob_id,
         width, height, content_type, state)
       VALUES ($1, $2, 'base', $3, $4, $5, $6, $7, $8, 'image/webp', 'ready')`,
      [
        rendition,
        asset,
        want.role,
        want.version,
        want.digest,
        blob,
        want.width,
        want.height,
      ],
    );
    created.renditions.push(rendition);
    if (!published(want.role)) continue;
    const id = `media-publication-${hex()}`;
    const token = hex();
    await pool.query(
      `INSERT INTO community.media_publications(id,public_asset_id,rendition_id,generation_token,object_key,storage_key,content_type,purpose,byte_size,sha256,role,edit_key,state,created_at,published_at)
       VALUES($1,$2,$3,$4,$5,$6,'image/webp','catalog_derivative',2048,$7,$8,'base','published',$9,$9)`,
      [
        id,
        publicAsset,
        rendition,
        token,
        `v1/${publicAsset}/${token}/base/${want.role}.r1.webp`,
        storageKey,
        blobSha,
        want.role,
        at,
      ],
    );
    created.publications.push(id);
  }
  return sources({ mediaId, objectKey, sourceSha256: sha })[0]!;
};
const sources = (...media: Record<string, string>[]) =>
  catalogPublishedRenditionsRequestSchema.parse({ media }).media;

beforeAll(async () => {
  await runCommunityMigrations(
    pool,
    path.join(repositoryRoot, "database", "community-migrations"),
  );
});

afterAll(async () => {
  try {
    for (const [table, ids] of [
      ["media_publications", created.publications],
      ["media_public_assets", created.publicAssets],
      ["media_renditions", created.renditions],
      ["media_blobs", created.blobs],
      ["catalog_media_assets", created.assets],
    ] as const)
      await pool.query(`DELETE FROM community.${table} WHERE id = ANY($1)`, [
        ids,
      ]);
  } finally {
    await closePostgresPool(pool);
  }
});

describe("Admin publish gate facts on PostgreSQL", () => {
  it("proves a live source only with its whole current set published", async () => {
    const live = await liveSource();
    const partial = await liveSource((role) => role !== "cover");
    const read = createCatalogPublishedRenditions(pool);
    expect(
      (await read(sources(live, partial))).media.map(
        ({ complete }) => complete,
      ),
    ).toEqual([true, false]);
    // Other bytes under the same pair, or an unknown pair, are no proof.
    expect(
      (
        await read(
          sources(
            { ...live, sourceSha256: hex(32) },
            { ...live, mediaId: `media-gate-${hex(8)}` },
          ),
        )
      ).media.map(({ complete }) => complete),
    ).toEqual([false, false]);
    // A withdrawn generation is no longer published.
    await pool.query(
      "UPDATE community.media_publications SET state='withdrawing', withdraw_requested_at=$2 WHERE id=$1",
      [created.publications[0], at],
    );
    expect((await read(sources(live))).media[0]!.complete).toBe(false);
  });
});
