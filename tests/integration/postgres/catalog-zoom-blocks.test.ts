import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CommunityConflictError } from "@moya/api";
import { createCatalogPublicationAuthority } from "@moya/backend-production/internal/catalog-delivery";
import {
  APPROVAL_KIND,
  parseCatalogMasterArguments,
  runCatalogMasterCommand,
} from "@moya/backend-production/internal/catalog-master";
import { LocalCatalogSourceReader } from "@moya/backend-production/internal/catalog-source";
import {
  createCatalogBlockRenderer,
  catalogSyncIdentities,
  createCatalogSync,
  listPublishedCatalogSources,
} from "@moya/backend-production/internal/publishing-catalog";
import { createPublishingJobHandlers } from "@moya/backend-production/internal/publishing-job-handlers";
import { FilesystemPublishingMediaStore } from "@moya/backend-production/internal/publishing-media-store";
import {
  createSandboxRunner,
  defaultSandboxAppDist,
} from "@moya/backend-production/internal/publishing-sandbox";
import { PublishingWorker } from "@moya/backend-production/internal/publishing-worker";
import {
  createBackendApplication,
  createDevelopmentCatalogFixtureQueryPort,
  startBackendProcess,
} from "@moya/backend-runtime";
import {
  PostgresCatalogQueryAdapter,
  catalogZoomFramesSql,
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import {
  CATALOG_BLOCK_GUARD_SQL,
  CATALOG_MASTER_SLICE_CAP,
  CATALOG_MASTER_TASK_CAP,
  PostgresCatalogDisplayMasterAdapter,
  PostgresMediaPublicationAdapter,
  PostgresPublishingOperatorAdapter,
  PostgresWorkPublishingAdapter,
  catalogBlockCell,
  catalogBlockGrid,
  resolveCatalogRenditionRead,
  runCommunityMigrations,
} from "@moya/community-postgres";
import { UnconfiguredStorageUrlResolver } from "@moya/image";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { catalogAuthorityWithCopySet } from "../../unit/backend/catalog-copy-set.js";
import { InMemoryCommunityIdentityPort } from "../../unit/backend/community-identity-fixture.js";

import {
  assertSyntheticTestDatabaseUrl,
  requireSyntheticTestDatabaseUrl,
} from "./synthetic-test-database.js";

import type { CatalogMasterAttach, PublishingJobLease } from "@moya/api";
import type { CatalogSourceReader } from "@moya/backend-production/internal/catalog-source";

/*
 * catalog-deep-zoom-v1 (Issue #295) on a dedicated synthetic database with
 * its own App and public read roles, so every store command runs with exactly
 * the named grants (criterion 3a) and no other suite meets its rows:
 * master custody and CHECKs (1–3), scheduling and the operator guard (5),
 * the block desired set, withdrawal budget and sweep-once (6–8), the
 * rollback guard (9), the Development relay lookup (14) and the live storage
 * bounds (25); and (catalog-scale-v1 1B) that every change of an asset's
 * block set marks the asset, so a scoped reconcile pass whose sweep share is
 * empty still publishes a recorded set and withdraws a detached one, a
 * self-master's (catalog-deep-zoom-self-master-v1) included.
 * Content is synthetic; no store or cloud I/O. The opt-in
 * Development smoke (CATALOG_BLOCKS_SANDBOX_SMOKE=1) adds a private
 * temporary filesystem store and the local media sandbox image.
 */

type Pool = ReturnType<typeof createPostgresPool>;

const root = fileURLToPath(new URL("../../../", import.meta.url));
const targetUrl = requireSyntheticTestDatabaseUrl();
const endpoint = new URL(targetUrl);
if (
  !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
  endpoint.search ||
  endpoint.hash
)
  throw new Error("Catalog zoom tests require a loopback disposable target");
const guard = (await import(
  new URL("../../../scripts/disposable-test-target.mjs", import.meta.url).href
)) as {
  disposableTestTargetProbeSql: string;
  assertDisposableTestTarget(rows: unknown, database: string): string;
};

const poolFor = (url: string) =>
  createPostgresPool(parsePostgresConfig({ DATABASE_URL: url }));
const administration = poolFor(targetUrl);
const SLOW = 120_000;
const t0 = new Date("2126-10-20T04:00:00.000Z");
const hex = (bytes = 16) => randomBytes(bytes).toString("hex");
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const md5 = (value: string) => createHash("md5").update(value).digest("hex");

const suffix = hex(6);
const database = `cz_blocks_${suffix}_synthetic_test`;
const appRole = `cz_app_${suffix}`;
const publicRole = `cz_pub_${suffix}`;
let setup: Pool;
let app: Pool;
let publicRead: Pool;
let created = { database: false, app: false, public: false };

beforeAll(async () => {
  const probe = await administration.query(guard.disposableTestTargetProbeSql);
  guard.assertDisposableTestTarget(
    probe.rows,
    assertSyntheticTestDatabaseUrl(targetUrl),
  );
  const appPassword = hex(32);
  const publicPassword = hex(32);
  await administration.query(
    `CREATE ROLE ${appRole} LOGIN PASSWORD '${appPassword}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`,
  );
  created = { ...created, app: true };
  await administration.query(
    `CREATE ROLE ${publicRole} LOGIN PASSWORD '${publicPassword}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`,
  );
  created = { ...created, public: true };
  await administration.query(`CREATE DATABASE ${database}`);
  created = { ...created, database: true };
  const url = (login?: {
    readonly role: string;
    readonly password: string;
  }) => {
    const value = new URL(targetUrl);
    value.pathname = `/${database}`;
    if (login !== undefined) {
      value.username = login.role;
      value.password = login.password;
    }
    return value.toString();
  };
  setup = poolFor(url());
  await runCommunityMigrations(setup, `${root}/database/community-migrations`);
  await setup.query(
    "CREATE TABLE public.catalog_entries(catalog_id text PRIMARY KEY,province text,province_state text); CREATE TABLE public.catalog_discovery(catalog_id text PRIMARY KEY,kind text,title text,aliases varchar[],first_published_at timestamptz,filter_metadata jsonb); CREATE TABLE public.catalog_media(catalog_id text,media_id text,object_key text,width integer,height integer,is_representative boolean,position integer NOT NULL DEFAULT 0); CREATE TABLE public.article_entries(article_id text PRIMARY KEY,title text)",
  );
  await setup.query(
    (
      await readFile(
        `${root}/infra/development/work-publishing/grant-runtime.sql`,
        "utf8",
      )
    ).replaceAll(':"app_role"', `"${appRole}"`),
  );
  await setup.query(
    `GRANT SELECT (intent_id, asset_id) ON TABLE community.catalog_delivery_media_refs TO "${appRole}"`,
  );
  await setup.query(
    (
      await readFile(
        `${root}/infra/development/catalog-media/grant-public-read.sql`,
        "utf8",
      )
    ).replaceAll(':"public_read_role"', `"${publicRole}"`),
  );
  // The Catalog database's own public read grant covers its published
  // tables; the stub needs the same for the Detail's deep-zoom reads.
  await setup.query(`GRANT SELECT ON public.catalog_media TO "${publicRole}"`);
  app = poolFor(url({ role: appRole, password: appPassword }));
  publicRead = poolFor(url({ role: publicRole, password: publicPassword }));
}, SLOW);

afterAll(async () => {
  await app?.end();
  await publicRead?.end();
  await setup?.end();
  if (created.database)
    await administration.query(
      `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`,
    );
  if (created.app) await administration.query(`DROP ROLE IF EXISTS ${appRole}`);
  if (created.public)
    await administration.query(`DROP ROLE IF EXISTS ${publicRole}`);
  await administration.end();
}, SLOW);

const blobKey = () => {
  const key = hex();
  return `blobs/${key.slice(0, 2)}/${key.slice(2, 4)}/${key}`;
};

interface CatalogImage {
  readonly mediaId: string;
  readonly catalogId: string;
  readonly objectKey: string;
  readonly approvedSha256: string;
  readonly assetId: string;
  readonly width: number;
  readonly height: number;
}

/** A published, rendered Catalog image (thumb, cover, display and viewer);
 * with `mediaId`, a replacement image of that media id. */
const catalogImage = async (
  options: {
    readonly width?: number;
    readonly height?: number;
    readonly catalogId?: string;
    /** A fresh media id by default; an existing one makes a replaced image. */
    readonly mediaId?: string;
    readonly published?: boolean;
    /** The viewer's long edge; the approved image's by default. */
    readonly viewerLong?: number;
    /** `display`: a pilot `display/v1/` key instead of an `editorial/` one. */
    readonly keyForm?: "editorial" | "display";
    /** The approved bytes' SHA-256; synthetic by default. */
    readonly approvedSha256?: string;
    /** The asset's recorded `source_sha256`; the approved one by default. */
    readonly sourceSha256?: string | null;
    /** What the base render recorded; the approved image's facts by default. */
    readonly master?: {
      readonly sha256?: string;
      readonly width?: number;
      readonly height?: number;
    };
  } = {},
): Promise<CatalogImage> => {
  const width = options.width ?? 4096;
  const height = options.height ?? 2731;
  const mediaId = options.mediaId ?? `media-${hex(8)}`;
  const catalogId = options.catalogId ?? `catalog-${hex(8)}`;
  const approvedSha256 = options.approvedSha256 ?? sha(mediaId);
  const objectKey =
    options.keyForm === "display"
      ? `display/v1/media_${md5(mediaId)}/${approvedSha256}.webp`
      : `editorial/${sha(catalogId)}/${sha(`${mediaId}:orig`)}-${approvedSha256}.jpg`;
  const assetId = `catalog-asset-${md5(`${mediaId}:${objectKey}`)}`;
  if (options.published !== false)
    await setup.query(
      "INSERT INTO public.catalog_media(catalog_id,media_id,object_key,width,height,is_representative,position) VALUES($1,$2,$3,$4,$5,false,0)",
      [catalogId, mediaId, objectKey, width, height],
    );
  await setup.query(
    `INSERT INTO community.catalog_media_assets(id,media_id,source_object_key,source_sha256,source_width,source_height,source_content_type,master_sha256,master_width,master_height,state,created_at,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ready',$11,$11)`,
    [
      assetId,
      mediaId,
      objectKey,
      options.sourceSha256 === undefined
        ? approvedSha256
        : options.sourceSha256,
      width,
      height,
      options.keyForm === "display" ? "image/webp" : "image/jpeg",
      options.master?.sha256 ?? approvedSha256,
      options.master?.width ?? width,
      options.master?.height ?? height,
      t0,
    ],
  );
  const scaled = (long: number) =>
    width >= height
      ? [long, Math.round((height * long) / width)]
      : [Math.round((width * long) / height), long];
  for (const [role, long] of [
    ["thumb", 480],
    ["cover", 720],
    ["display", 2048],
    ["viewer", options.viewerLong ?? Math.max(width, height)],
  ] as const) {
    const blob = `media-blob-${hex()}`;
    await setup.query(
      "INSERT INTO community.media_blobs(id,owner_id,purpose,storage_key,byte_size,sha256,content_type,created_at) VALUES($1,NULL,'catalog_derivative',$2,1000,$3,'image/webp',$4)",
      [blob, blobKey(), sha(blob), t0],
    );
    const [w, h] = scaled(long);
    await setup.query(
      "INSERT INTO community.media_renditions(id,catalog_asset_id,edit_key,role,recipe_version,recipe_digest,blob_id,width,height,content_type,created_at) VALUES($1,$2,'base',$3,1,'1111111111111111',$4,$5,$6,'image/webp',$7)",
      [`media-rendition-${hex()}`, assetId, role, blob, w, h, t0],
    );
  }
  return {
    mediaId,
    catalogId,
    objectKey,
    approvedSha256,
    assetId,
    width,
    height,
  };
};

/**
 * The pool `pool()` names, bound lazily: the pools exist only after
 * beforeAll. Its methods run bound to that pool, not to the proxy: pg-pool's
 * own methods reassign its client list (an idle client's removal does), and
 * with the proxy as `this` the new list would land on the proxy's empty
 * target, so the pool's `end()` in afterAll would wait for a removed client.
 */
const lazyPool = (pool: () => Pool): Pool =>
  new Proxy({} as Pool, {
    get: (_target, property) => {
      const target = pool();
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

const masters = new PostgresCatalogDisplayMasterAdapter(lazyPool(() => app));

const attachInput = (
  image: CatalogImage,
  overrides: Partial<CatalogMasterAttach> = {},
): CatalogMasterAttach => ({
  mediaId: image.mediaId,
  approvedSha256: image.approvedSha256,
  masterSha256: sha(`${image.mediaId}:master`),
  header: {
    contentType: "image/jpeg",
    width: image.width >= image.height ? 6000 : 4000,
    height: image.width >= image.height ? 4000 : 6000,
  },
  derivation: "submitted",
  maxLongEdge: 8192,
  note: null,
  operator: "owner",
  source: { kind: "upload", storageKey: blobKey(), byteSize: 20_000_000 },
  ...overrides,
});

const attached = async (
  image: CatalogImage,
  overrides: Partial<CatalogMasterAttach> = {},
) => {
  const result = await masters.attach(attachInput(image, overrides), t0);
  if (result.status !== "done" || result.masterId === null)
    throw new Error(
      `Attach refused: ${result.status === "refused" ? result.code : "dry"}`,
    );
  return result;
};

/** Ready block renditions of a master for the given cells, exactly inside the frame. */
const insertBlocks = async (
  image: CatalogImage,
  masterId: string,
  frame: { readonly width: number; readonly height: number },
  cells: readonly number[],
) => {
  const ids: string[] = [];
  for (const cell of cells) {
    const rect = catalogBlockCell(frame.width, frame.height, cell);
    const blob = `media-blob-${hex()}`;
    await setup.query(
      "INSERT INTO community.media_blobs(id,owner_id,purpose,storage_key,byte_size,sha256,content_type,created_at) VALUES($1,NULL,'catalog_derivative',$2,250000,$3,'image/jpeg',$4)",
      [blob, blobKey(), sha(blob), t0],
    );
    const id = `media-rendition-${hex()}`;
    await setup.query(
      "INSERT INTO community.media_renditions(id,catalog_asset_id,catalog_master_id,edit_key,role,recipe_version,recipe_digest,blob_id,width,height,content_type,created_at) VALUES($1,$2,$3,'base',$4,1,'2222222222222222',$5,$6,$7,'image/jpeg',$8)",
      [
        id,
        image.assetId,
        masterId,
        `block-${String(cell).padStart(2, "0")}`,
        blob,
        rect.width,
        rect.height,
        t0,
      ],
    );
    ids.push(id);
  }
  return ids;
};

const allCells = (frame: { readonly width: number; readonly height: number }) =>
  Array.from(
    { length: catalogBlockGrid(frame.width, frame.height).cells },
    (_, cell) => cell,
  );

const codeOf = (result: { readonly status: string; readonly code?: string }) =>
  result.status === "refused" ? result.code : result.status;

const blockJob = async (
  assetId: string,
  masterId: string,
  cells: [number, number],
  state: string,
  errorCode: string | null = null,
) => {
  const id = `publishing-job-${hex()}`;
  await setup.query(
    `INSERT INTO community.publishing_jobs(id,kind,subject_id,payload,state,attempts,run_after,last_error_code,created_at,updated_at,finished_at,lease_owner,lease_expires_at)
     VALUES($1,'catalog_render',$2,$3::jsonb,$4,0,$5,$6,$5,$5,CASE WHEN $4 IN ('failed','abandoned') THEN $5::timestamptz END,
       CASE WHEN $4='running' THEN 'test' END, CASE WHEN $4='running' THEN $5::timestamptz + interval '1 hour' END)`,
    [
      id,
      assetId,
      JSON.stringify({ variant: "blocks", masterId, cells }),
      state,
      t0,
      errorCode,
    ],
  );
  return id;
};

describe("Catalog display masters: schema custody (criteria 2, 3)", () => {
  it("holds a committed master blob, allows only masters that hold, and lets erase tombstone and clear in one statement", async () => {
    const id = `media-blob-${hex()}`;
    await expect(
      setup.query(
        "INSERT INTO community.media_blobs(id,owner_id,purpose,storage_key,byte_size,sha256,content_type) VALUES($1,NULL,'catalog_master',$2,10,$3,'image/jpeg')",
        [id, blobKey(), sha(id)],
      ),
    ).rejects.toThrow(/catalog_master_held/u);
    await expect(
      setup.query(
        "INSERT INTO community.media_blobs(id,owner_id,purpose,storage_key,byte_size,sha256,content_type,retention_hold) VALUES($1,NULL,'catalog_master',$2,10,$3,'image/webp','catalog_master')",
        [id, blobKey(), sha(id)],
      ),
    ).rejects.toThrow(/catalog_master_type/u);
    await expect(
      setup.query(
        "INSERT INTO community.media_blobs(id,owner_id,purpose,storage_key,byte_size,sha256,content_type,retention_hold) VALUES($1,NULL,'catalog_derivative',$2,10,$3,'image/jpeg','catalog_master')",
        [id, blobKey(), sha(id)],
      ),
    ).rejects.toThrow(/hold_purpose/u);
    await setup.query(
      "INSERT INTO community.media_blobs(id,owner_id,purpose,storage_key,byte_size,sha256,content_type,retention_hold) VALUES($1,NULL,'catalog_master',$2,10,$3,'image/jpeg','catalog_master')",
      [id, blobKey(), sha(id)],
    );
    await expect(
      setup.query(
        "UPDATE community.media_blobs SET retention_hold=NULL WHERE id=$1",
        [id],
      ),
    ).rejects.toThrow(/catalog_master_held/u);
    await setup.query(
      "UPDATE community.media_blobs SET state='tombstoned', tombstoned_at=$2, retention_hold=NULL WHERE id=$1",
      [id, t0],
    );
  });

  it("refuses master rows on a blob that is not a held master, upscaled or over-limit frames, and any rewrite", async () => {
    const image = await catalogImage();
    const blob = `media-blob-${hex()}`;
    await setup.query(
      "INSERT INTO community.media_blobs(id,owner_id,purpose,storage_key,byte_size,sha256,content_type) VALUES($1,NULL,'catalog_derivative',$2,10,$3,'image/jpeg')",
      [blob, blobKey(), sha(blob)],
    );
    const insert = (values: Record<string, unknown>) =>
      setup.query(
        `INSERT INTO community.catalog_display_masters(id,catalog_asset_id,blob_id,master_sha256,content_type,master_width,master_height,derivation,max_long_edge,frame_width,frame_height,operator,created_at)
         VALUES($1,$2,$3,$4,'image/jpeg',$5,$6,'submitted',$7,$8,$9,'owner',$10)`,
        [
          `catalog-master-${hex()}`,
          image.assetId,
          values.blob ?? blob,
          values.sha ?? sha(blob),
          values.mw ?? 6000,
          values.mh ?? 4000,
          values.limit ?? 8192,
          values.fw ?? 6000,
          values.fh ?? 4000,
          t0,
        ],
      );
    await expect(insert({})).rejects.toThrow(/committed, held master blob/u);
    const held = `media-blob-${hex()}`;
    await setup.query(
      "INSERT INTO community.media_blobs(id,owner_id,purpose,storage_key,byte_size,sha256,content_type,retention_hold) VALUES($1,NULL,'catalog_master',$2,10,$3,'image/jpeg','catalog_master')",
      [held, blobKey(), sha(held)],
    );
    await expect(
      insert({ blob: held, sha: sha(held), fw: 6001 }),
    ).rejects.toThrow(/frame/u);
    await expect(
      insert({
        blob: held,
        sha: sha(held),
        mw: 12000,
        mh: 8000,
        fw: 12000,
        fh: 8000,
      }),
    ).rejects.toThrow(/frame_long_edge|limit_bounded/u);
    await expect(
      insert({ blob: held, sha: sha(held), limit: 5000, fw: 6000, fh: 4000 }),
    ).rejects.toThrow(/frame_long_edge/u);
    await expect(
      insert({ blob: held, sha: sha(held), fw: 6000, fh: 3900 }),
    ).rejects.toThrow(/frame_aspect/u);
    await insert({
      blob: held,
      sha: sha(held),
      mw: 12000,
      mh: 8000,
      fw: 8192,
      fh: 5461,
    });
    const row = (
      await setup.query<{ id: string }>(
        "SELECT id FROM community.catalog_display_masters WHERE blob_id=$1",
        [held],
      )
    ).rows[0]!;
    await expect(
      setup.query(
        "UPDATE community.catalog_display_masters SET note='changed' WHERE id=$1",
        [row.id],
      ),
    ).rejects.toThrow(/only ended, once/u);
    await setup.query(
      "UPDATE community.catalog_display_masters SET ended_at=$2, end_reason='detached' WHERE id=$1",
      [row.id, t0],
    );
    await expect(
      setup.query(
        "UPDATE community.catalog_display_masters SET ended_at=$2, end_reason='limit_changed' WHERE id=$1",
        [row.id, t0],
      ),
    ).rejects.toThrow(/only ended, once/u);
  });

  it("keeps block renditions to JPEG cells of a master of the same asset, and admits block publication keys", async () => {
    const image = await catalogImage();
    const other = await catalogImage();
    const master = await attached(image);
    const blob = `media-blob-${hex()}`;
    await setup.query(
      "INSERT INTO community.media_blobs(id,owner_id,purpose,storage_key,byte_size,sha256,content_type) VALUES($1,NULL,'catalog_derivative',$2,10,$3,'image/jpeg')",
      [blob, blobKey(), sha(blob)],
    );
    const insert = (
      asset: string,
      masterId: string | null,
      role: string,
      width: number,
      type = "image/jpeg",
    ) =>
      setup.query(
        "INSERT INTO community.media_renditions(id,catalog_asset_id,catalog_master_id,edit_key,role,recipe_version,recipe_digest,blob_id,width,height,content_type) VALUES($1,$2,$3,'base',$4,1,'2222222222222222',$5,$6,1024,$7)",
        [`media-rendition-${hex()}`, asset, masterId, role, blob, width, type],
      );
    await expect(insert(image.assetId, null, "block-00", 1024)).rejects.toThrow(
      /block_master/u,
    );
    await expect(
      insert(image.assetId, master.masterId, "viewer", 1024),
    ).rejects.toThrow(/block_master/u);
    await expect(
      insert(image.assetId, master.masterId, "block-00", 1027),
    ).rejects.toThrow(/block_shape/u);
    await expect(
      insert(image.assetId, master.masterId, "block-00", 1024, "image/webp"),
    ).rejects.toThrow(/block_shape/u);
    await expect(
      insert(other.assetId, master.masterId, "block-00", 1024),
    ).rejects.toThrow(/catalog_master_fkey/u);
    await expect(
      insert(image.assetId, master.masterId, "block-100", 1024),
    ).rejects.toThrow(/role_valid/u);
    const key = (role: string) => `v1/${hex()}/${hex()}/base/${role}.r1.jpg`;
    for (const [role, ok] of [
      ["block-07", true],
      ["block-7", false],
      ["block-100", false],
    ] as const) {
      const statement = setup.query(
        "SELECT $1::text ~ '^v1/[0-9a-f]{32}/[0-9a-f]{32}/(base|[0-9a-f]{32})/(thumb|cover|display|viewer|full|motion|block-[0-9]{2})\\.r[1-9][0-9]*\\.(webp|jpg|mp4)$' AS ok",
        [key(role)],
      );
      expect((await statement).rows[0]!.ok).toBe(ok);
    }
  });

  it("lets pre-task code insert the usage singleton without the day columns, and the App role write them", async () => {
    await setup.query("DELETE FROM community.media_request_usage");
    await app.query(
      "INSERT INTO community.media_request_usage(id,month_start,period_end,requests,warning,observed_at) VALUES('published-media',$1,$1,0,false,$1)",
      [t0],
    );
    await app.query(
      "UPDATE community.media_request_usage SET day_start=$1, day_requests=1200, day_bytes=34567, day_observed_at=$1 WHERE id='published-media'",
      [t0],
    );
    await expect(
      app.query(
        "UPDATE community.media_request_usage SET day_requests=NULL WHERE id='published-media'",
      ),
    ).rejects.toThrow(/day_complete/u);
  });
});

describe("catalog-master store as the App role (criteria 1, 2, 3a, 25)", () => {
  it("refuses images outside the published projection, unready assets, approval mismatches, large approved images, aspect and gain failures", async () => {
    const unpublished = await catalogImage({ published: false });
    expect(codeOf(await masters.attach(attachInput(unpublished), t0))).toBe(
      "not_published",
    );
    const pending = await catalogImage();
    await setup.query(
      "UPDATE community.catalog_media_assets SET state='pending' WHERE id=$1",
      [pending.assetId],
    );
    expect(codeOf(await masters.attach(attachInput(pending), t0))).toBe(
      "asset_not_ready",
    );
    const image = await catalogImage();
    expect(
      codeOf(
        await masters.attach(
          attachInput(image, { approvedSha256: "c".repeat(64) }),
          t0,
        ),
      ),
    ).toBe("approved_mismatch");
    // An `editorial/` image above 4096 px with a master that is not its own
    // bytes (masterSha256 differs from the approved SHA-256): not a
    // self-master, so RP-11 still refuses it.
    const large = await catalogImage({ width: 6000, height: 4000 });
    expect(codeOf(await masters.attach(attachInput(large), t0))).toBe(
      "approved_too_large",
    );
    expect(
      codeOf(
        await masters.attach(
          attachInput(image, {
            header: { contentType: "image/jpeg", width: 6000, height: 4030 },
          }),
          t0,
        ),
      ),
    ).toBe("aspect_mismatch");
    // Within 0.2 % but beyond the rounding of a side (PR C): the Detail would
    // never show this frame, so attach refuses it.
    expect(
      codeOf(
        await masters.attach(
          attachInput(image, {
            header: { contentType: "image/jpeg", width: 6000, height: 4004 },
          }),
          t0,
        ),
      ),
    ).toBe("aspect_mismatch");
    // 1.25 × the 4096 viewer is 5120: a 5000-px master gains too little.
    expect(
      codeOf(
        await masters.attach(
          attachInput(image, {
            header: { contentType: "image/jpeg", width: 5000, height: 3334 },
          }),
          t0,
        ),
      ),
    ).toBe("gain_too_small");
    expect(
      codeOf(
        await masters.attach(attachInput(image, { maxLongEdge: 5000 }), t0),
      ),
    ).toBe("gain_too_small");
  });

  it("records the held blob and the active row in one transaction; a dry run writes nothing", async () => {
    const image = await catalogImage();
    const dry = await masters.attach(
      attachInput(image, { source: { kind: "dry_run", byteSize: 20_000_000 } }),
      t0,
    );
    expect(dry).toMatchObject({
      status: "done",
      masterId: null,
      frameWidth: 6000,
      frameHeight: 4000,
      cells: 24,
    });
    expect(
      (
        await setup.query(
          "SELECT 1 FROM community.catalog_display_masters WHERE catalog_asset_id=$1",
          [image.assetId],
        )
      ).rowCount,
    ).toBe(0);
    const result = await attached(image);
    const row = (
      await setup.query<{
        purpose: string;
        owner_id: string | null;
        retention_hold: string;
        frame_width: number;
        frame_height: number;
        operator: string;
      }>(
        `SELECT b.purpose, b.owner_id, b.retention_hold, m.frame_width, m.frame_height, m.operator
         FROM community.catalog_display_masters m JOIN community.media_blobs b ON b.id=m.blob_id WHERE m.id=$1`,
        [result.masterId],
      )
    ).rows[0];
    expect(row).toEqual({
      purpose: "catalog_master",
      owner_id: null,
      retention_hold: "catalog_master",
      frame_width: 6000,
      frame_height: 4000,
      operator: "owner",
    });
    expect(codeOf(await masters.attach(attachInput(image), t0))).toBe(
      "already_attached",
    );
    // A 60 MP-class master is cut at 8192 on the long edge.
    const big = await catalogImage({ width: 2731, height: 4096 });
    const portrait = await attached(big, {
      header: { contentType: "image/jpeg", width: 6336, height: 9504 },
    });
    expect(portrait).toMatchObject({
      frameWidth: 5461,
      frameHeight: 8192,
      cells: 48,
    });
  });

  it("checks both storage bounds live at every attach (T0 measured now)", async () => {
    const first = await catalogImage();
    const second = await catalogImage();
    const ok = await masters.attach(
      attachInput(first, { source: { kind: "dry_run", byteSize: 1 } }),
      t0,
    );
    expect(ok.status).toBe("done");
    const taskBytes = ok.status === "done" ? ok.storage.taskBytes : 0;
    // Task bytes grow after the first check (an upload stream): the D4 bound refuses.
    const filler = `media-blob-${hex()}`;
    const user = `user-${hex()}`;
    await setup.query(
      "INSERT INTO community.public_users(id,handle,display_name) VALUES($1,$2,'合成')",
      [user, `cz-${hex(8)}`],
    );
    await setup.query(
      "INSERT INTO community.media_blobs(id,owner_id,purpose,storage_key,byte_size,sha256,content_type,created_at) VALUES($1,$2,'original',$3,$4,$5,'image/jpeg',$6)",
      [filler, user, blobKey(), 45 * 1000 ** 3 - taskBytes, sha(filler), t0],
    );
    const refused = await masters.attach(attachInput(second), t0);
    expect(refused).toMatchObject({
      status: "refused",
      code: "storage_task_cap",
    });
    await setup.query(
      "UPDATE community.media_blobs SET state='tombstoned', tombstoned_at=$2 WHERE id=$1",
      [filler, t0],
    );
    // The slice cap counts masters and blocks only.
    expect(CATALOG_MASTER_SLICE_CAP).toBe(20 * 1024 ** 3);
    expect(
      codeOf(
        await masters.attach(
          attachInput(second, {
            source: { kind: "dry_run", byteSize: CATALOG_MASTER_SLICE_CAP },
          }),
          t0,
        ),
      ),
    ).toBe("storage_slice_cap");
  });

  it("limits, detaches and re-attaches without a second upload; a replaced set is abandoned and released", async () => {
    const image = await catalogImage();
    const first = await attached(image);
    const frame = { width: first.frameWidth, height: first.frameHeight };
    const blocks = await insertBlocks(image, first.masterId!, frame, [0, 1]);
    const queued = await blockJob(
      image.assetId,
      first.masterId!,
      [2, 17],
      "queued",
    );
    const limited = await masters.setLimit(image.mediaId, 5500, "owner", t0);
    expect(limited).toMatchObject({
      status: "done",
      frameWidth: 5500,
      frameHeight: 3667,
      cells: 24,
    });
    expect(
      (
        await setup.query(
          "SELECT end_reason FROM community.catalog_display_masters WHERE id=$1",
          [first.masterId],
        )
      ).rows[0],
    ).toEqual({ end_reason: "limit_changed" });
    expect(
      (
        await setup.query(
          "SELECT state, last_error_code FROM community.publishing_jobs WHERE id=$1",
          [queued],
        )
      ).rows[0],
    ).toEqual({ state: "abandoned", last_error_code: "master_ended" });
    expect(
      (
        await setup.query(
          "SELECT DISTINCT state FROM community.media_renditions WHERE id=ANY($1::text[])",
          [blocks],
        )
      ).rows,
    ).toEqual([{ state: "released" }]);
    expect(
      codeOf(await masters.setLimit(image.mediaId, 5000, "owner", t0)),
    ).toBe("gain_too_small");
    const limitedId = limited.status === "done" ? limited.masterId! : "";
    expect(await masters.detach({ mediaId: image.mediaId }, t0)).toEqual({
      status: "done",
      ended: 1,
    });
    expect(codeOf(await masters.detach({ mediaId: image.mediaId }, t0))).toBe(
      "no_active_master",
    );
    const status = await masters.status(null);
    expect(status.heldWithoutActive).toContainEqual(
      expect.objectContaining({ masterId: limitedId, endReason: "detached" }),
    );
    const blobsBefore = (
      await setup.query(
        "SELECT count(*)::int AS n FROM community.media_blobs WHERE purpose='catalog_master'",
      )
    ).rows[0]!.n;
    expect(
      codeOf(
        await masters.attach(
          attachInput(image, {
            masterSha256: "d".repeat(64),
            source: { kind: "existing", masterId: limitedId },
          }),
          t0,
        ),
      ),
    ).toBe("master_mismatch");
    const again = await masters.attach(
      attachInput(image, { source: { kind: "existing", masterId: limitedId } }),
      t0,
    );
    expect(again).toMatchObject({
      status: "done",
      frameWidth: 6000,
      frameHeight: 4000,
    });
    expect(
      (
        await setup.query(
          "SELECT count(*)::int AS n FROM community.media_blobs WHERE purpose='catalog_master'",
        )
      ).rows[0]!.n,
    ).toBe(blobsBefore);
    expect(
      (await masters.status(null)).heldWithoutActive.map((row) => row.masterId),
    ).not.toContain(limitedId);
  });

  it("erases only an inactive master without live block publications, and the purge schedule never takes a held master", async () => {
    const image = await catalogImage();
    const master = await attached(image);
    expect(codeOf(await masters.erase(master.masterId!, t0))).toBe(
      "master_active",
    );
    const works = new PostgresWorkPublishingAdapter(app, {
      publication: { allowPublish: () => true, isPublic: () => true },
    });
    const later = new Date(t0.getTime() + 3 * 60 * 60 * 1000);
    await works.scheduleCleanup(later, 1000);
    const blobId = (
      await setup.query<{ blob_id: string }>(
        "SELECT blob_id FROM community.catalog_display_masters WHERE id=$1",
        [master.masterId],
      )
    ).rows[0]!.blob_id;
    expect(
      (
        await setup.query(
          "SELECT 1 FROM community.publishing_jobs WHERE kind='purge_blob' AND subject_id=$1",
          [blobId],
        )
      ).rowCount,
    ).toBe(0);
    // A block publication that is not withdrawn keeps the master.
    const [rendition] = await insertBlocks(
      image,
      master.masterId!,
      { width: master.frameWidth, height: master.frameHeight },
      [0],
    );
    await setup.query(
      "INSERT INTO community.media_public_assets(id,catalog_asset_id,desired_at,created_at,updated_at) VALUES($1,$2,$3,$3,$3)",
      [hex(), image.assetId, t0],
    );
    const publicAsset = (
      await setup.query<{ id: string }>(
        "SELECT id FROM community.media_public_assets WHERE catalog_asset_id=$1",
        [image.assetId],
      )
    ).rows[0]!.id;
    const blob = (
      await setup.query<{ storage_key: string; sha256: string }>(
        "SELECT b.storage_key, b.sha256 FROM community.media_renditions r JOIN community.media_blobs b ON b.id=r.blob_id WHERE r.id=$1",
        [rendition],
      )
    ).rows[0]!;
    const token = hex();
    await setup.query(
      `INSERT INTO community.media_publications(id,public_asset_id,rendition_id,generation_token,object_key,storage_key,content_type,purpose,byte_size,sha256,role,edit_key,created_at)
       VALUES($1,$2,$3,$4,$5,$6,'image/jpeg','catalog_derivative',250000,$7,'block-00','base',$8)`,
      [
        `media-publication-${hex()}`,
        publicAsset,
        rendition,
        token,
        `v1/${publicAsset}/${token}/base/block-00.r1.jpg`,
        blob.storage_key,
        blob.sha256,
        t0,
      ],
    );
    await masters.detach({ mediaId: image.mediaId }, t0);
    expect(codeOf(await masters.erase(master.masterId!, t0))).toBe(
      "blocks_published",
    );
    await setup.query(
      "UPDATE community.media_publications SET state='withdrawing', withdraw_requested_at=$2 WHERE public_asset_id=$1 AND role='block-00'",
      [publicAsset, t0],
    );
    expect(codeOf(await masters.erase(master.masterId!, t0))).toBe(
      "blocks_published",
    );
    await setup.query(
      "UPDATE community.media_publications SET state='withdrawn', origin_deleted_at=$2, verified_at=$2 WHERE public_asset_id=$1 AND role='block-00'",
      [publicAsset, t0],
    );
    expect(await masters.erase(master.masterId!, t0)).toEqual({
      status: "done",
      byteSize: 20_000_000,
    });
    expect(
      (
        await setup.query(
          "SELECT state, retention_hold FROM community.media_blobs WHERE id=$1",
          [blobId],
        )
      ).rows[0],
    ).toEqual({ state: "tombstoned", retention_hold: null });
    await works.scheduleCleanup(later, 1000);
    expect(
      (
        await setup.query(
          "SELECT 1 FROM community.publishing_jobs WHERE kind='purge_blob' AND subject_id=$1",
          [blobId],
        )
      ).rowCount,
    ).toBe(1);
    expect(codeOf(await masters.erase(master.masterId!, t0))).toBe(
      "master_not_held",
    );
  });

  it("requeues only the missing cells of a paused set, never after a content failure, within two open sets", async () => {
    const image = await catalogImage();
    const master = await attached(image);
    const frame = { width: master.frameWidth, height: master.frameHeight };
    await insertBlocks(image, master.masterId!, frame, [0, 1, 2, 3, 4]);
    const stopped = await blockJob(
      image.assetId,
      master.masterId!,
      [5, 20],
      "failed",
      "processing_timeout",
    );
    const status = (await masters.status(image.catalogId)).masters[0]!;
    expect(status).toMatchObject({
      blocksReady: 5,
      complete: false,
      paused: true,
      lastFailureCode: "processing_timeout",
    });
    const result = await masters.requeue(image.mediaId, t0);
    expect(result).toEqual({ status: "done", jobs: 2 });
    const payloads = (
      await setup.query<{ payload: { cells: number[] } }>(
        "SELECT payload FROM community.publishing_jobs WHERE kind='catalog_render' AND payload->>'masterId'=$1 AND state='queued' ORDER BY (payload->'cells'->>0)::int",
        [master.masterId],
      )
    ).rows.map((row) => row.payload.cells);
    expect(payloads).toEqual([
      [5, 20],
      [21, 23],
    ]);
    expect(codeOf(await masters.requeue(image.mediaId, t0))).toBe("set_open");
    // A content failure is never re-run for that master.
    const failed = await catalogImage();
    const failedMaster = await attached(failed);
    await blockJob(
      failed.assetId,
      failedMaster.masterId!,
      [0, 15],
      "failed",
      "master_mismatch",
    );
    expect(codeOf(await masters.requeue(failed.mediaId, t0))).toBe(
      "content_failure",
    );
    // Two other open sets: busy.
    const third = await catalogImage();
    const thirdMaster = await attached(third);
    const other = await catalogImage();
    const otherMaster = await attached(other);
    await blockJob(other.assetId, otherMaster.masterId!, [0, 15], "running");
    expect(codeOf(await masters.requeue(third.mediaId, t0))).toBe("sets_busy");
    void stopped;
    void thirdMaster;
  });

  it("reports the rollback guard counts in any state", async () => {
    const counts = await masters.guardCounts();
    expect(counts.blockRenditions).toBeGreaterThan(0);
    expect(counts.blockJobs).toBeGreaterThan(0);
    const direct = (await setup.query(CATALOG_BLOCK_GUARD_SQL)).rows[0]!;
    expect(Number(direct.renditions)).toBe(counts.blockRenditions);
  });
});

describe("Catalog block scheduling and the operator guard (criterion 5)", () => {
  it("claims previews, HD, base Catalog renders and blocks in that order; blocks only with the switch on an idle queue", async () => {
    await setup.query(
      "UPDATE community.publishing_jobs SET state='abandoned', finished_at=$1 WHERE state IN ('queued','running')",
      [t0],
    );
    const works = new PostgresWorkPublishingAdapter(app, {
      publication: { allowPublish: () => true, isPublic: () => true },
    });
    const image = await catalogImage();
    const master = await attached(image);
    const block = await blockJob(
      image.assetId,
      master.masterId!,
      [0, 15],
      "queued",
    );
    const base = `publishing-job-${hex()}`;
    await setup.query(
      "INSERT INTO community.publishing_jobs(id,kind,subject_id,state,run_after,created_at,updated_at) VALUES($1,'catalog_render',$2,'queued',$3,$3,$3)",
      [base, image.assetId, t0],
    );
    const owner = `user-${hex()}`;
    await setup.query(
      "INSERT INTO community.public_users(id,handle,display_name) VALUES($1,$2,'合成')",
      [owner, `cz-${hex(8)}`],
    );
    const item = `media-item-${hex()}`;
    await setup.query(
      "INSERT INTO community.media_items(id,owner_id,kind,quality_mode,source,state,presentation,created_at,updated_at) VALUES($1,$2,'static','standard','upload','ready','{\"width\":10,\"height\":10}'::jsonb,$3,$3)",
      [item, owner, t0],
    );
    const hd = `publishing-job-${hex()}`;
    await setup.query(
      `INSERT INTO community.publishing_jobs(id,kind,subject_id,payload,state,run_after,created_at,updated_at) VALUES($1,'derive_edit',$2,'{"editKey":"base","variants":["full"]}'::jsonb,'queued',$3,$3,$3)`,
      [hd, item, new Date(t0.getTime() - 60_000)],
    );
    const preview = `publishing-job-${hex()}`;
    await setup.query(
      "INSERT INTO community.publishing_jobs(id,kind,subject_id,state,run_after,created_at,updated_at) VALUES($1,'process_item',$2,'queued',$3,$3,$3)",
      [preview, item, new Date(t0.getTime() + 1_000)],
    );
    const at = new Date(t0.getTime() + 600_000);
    const claim = async (catalogBlocks?: boolean) =>
      (
        await works.claimJobs(
          {
            owner: `w-${hex(4)}`,
            limit: 1,
            leaseMs: 60_000,
            ...(catalogBlocks === undefined ? {} : { catalogBlocks }),
          },
          at,
        )
      )[0]?.id;
    const finish = (id: string) =>
      setup.query(
        "UPDATE community.publishing_jobs SET state='succeeded', finished_at=$2, lease_owner=NULL, lease_expires_at=NULL WHERE id=$1",
        [id, at],
      );
    expect(await claim(true)).toBe(preview);
    // While the preview runs, nothing else of lower priority is idle-gated in.
    await finish(preview);
    expect(await claim(true)).toBe(hd);
    await finish(hd);
    expect(await claim(true)).toBe(base);
    await finish(base);
    // An upload in flight changed within two minutes keeps blocks queued.
    await setup.query(
      "UPDATE community.media_items SET state='processing', updated_at=$2 WHERE id=$1",
      [item, new Date(at.getTime() - 60_000)],
    );
    expect(await claim(true)).toBeUndefined();
    await setup.query(
      "UPDATE community.media_items SET state='ready', updated_at=$2 WHERE id=$1",
      [item, at],
    );
    // The switch off (the default): queued, never failed.
    expect(await claim()).toBeUndefined();
    expect(await claim(false)).toBeUndefined();
    expect(
      (
        await setup.query(
          "SELECT state FROM community.publishing_jobs WHERE id=$1",
          [block],
        )
      ).rows[0],
    ).toEqual({ state: "queued" });
    expect(await claim(true)).toBe(block);
  });

  it("keeps base re-renders and block jobs from blocking or impersonating each other", async () => {
    const image = await catalogImage();
    const master = await attached(image);
    await blockJob(
      image.assetId,
      master.masterId!,
      [0, 15],
      "failed",
      "processing_failed",
    );
    await setup.query(
      "UPDATE community.media_renditions SET state='released', released_at=$2 WHERE catalog_asset_id=$1 AND role='thumb'",
      [image.assetId, t0],
    );
    const works = new PostgresWorkPublishingAdapter(app, {
      publication: { allowPublish: () => true, isPublic: () => true },
    });
    const counts = await works.syncCatalogAssets(
      [
        {
          mediaId: image.mediaId,
          objectKey: image.objectKey,
          width: image.width,
          height: image.height,
        },
      ],
      t0,
      {
        limit: 10,
        renditions: [{ role: "thumb", version: 1, digest: "1111111111111111" }],
      },
    );
    expect(counts.enqueued).toBe(1);
    const base = (
      await setup.query<{ payload: unknown }>(
        "SELECT payload FROM community.publishing_jobs WHERE kind='catalog_render' AND subject_id=$1 AND state='queued'",
        [image.assetId],
      )
    ).rows;
    expect(base).toEqual([{ payload: null }]);
  });

  it("refuses the operator's retry and abandon on block jobs with the existing conflict error, and leaves them unchanged", async () => {
    const operator = new PostgresPublishingOperatorAdapter(app);
    const image = await catalogImage();
    const master = await attached(image);
    const failedBlock = await blockJob(
      image.assetId,
      master.masterId!,
      [0, 15],
      "failed",
      "processing_timeout",
    );
    const queuedBlock = await blockJob(
      image.assetId,
      master.masterId!,
      [16, 23],
      "queued",
    );
    await expect(
      operator.retryJob(
        failedBlock,
        "operator-test",
        { requestId: randomUUID() },
        t0,
      ),
    ).rejects.toBeInstanceOf(CommunityConflictError);
    await expect(
      operator.abandonJob(
        queuedBlock,
        "operator-test",
        { requestId: randomUUID() },
        t0,
      ),
    ).rejects.toBeInstanceOf(CommunityConflictError);
    expect(
      (
        await setup.query(
          "SELECT id, state FROM community.publishing_jobs WHERE id=ANY($1::text[]) ORDER BY id",
          [[failedBlock, queuedBlock]],
        )
      ).rows,
    ).toEqual(
      [
        { id: failedBlock, state: "failed" },
        { id: queuedBlock, state: "queued" },
      ].sort((left, right) => (left.id < right.id ? -1 : 1)),
    );
    // A base Catalog job behaves as before.
    const base = `publishing-job-${hex()}`;
    await setup.query(
      "INSERT INTO community.publishing_jobs(id,kind,subject_id,state,run_after,last_error_code,created_at,updated_at,finished_at) VALUES($1,'catalog_render',$2,'failed',$3,'processing_failed',$3,$3,$3)",
      [base, image.assetId, t0],
    );
    expect(
      (
        await operator.retryJob(
          base,
          "operator-test",
          { requestId: randomUUID() },
          t0,
        )
      ).state,
    ).toBe("queued");
  });
});

describe("Catalog block publication and withdrawal (criteria 6–8, 14)", () => {
  const lease = async (
    subject: string,
    kind: "publish_media" | "withdraw_media",
  ): Promise<PublishingJobLease> => {
    const id = `publishing-job-${hex()}`;
    const owner = hex(8);
    await setup.query(
      "INSERT INTO community.publishing_jobs(id,kind,subject_id,state,attempts,max_attempts,run_after,lease_owner,lease_expires_at,created_at,updated_at) VALUES($1,$2,$3,'running',1,3,$4,$5,$4::timestamptz + interval '1 hour',$4,$4)",
      [id, kind, subject, t0, owner],
    );
    return { id, leaseOwner: owner };
  };
  const publication = new PostgresMediaPublicationAdapter(
    lazyPool(() => app),
    { isPublic: () => true, allowPublish: () => true },
  );

  it("publishes the active master's complete blocks under the block key grammar, and withdraws them after detach", async () => {
    const image = await catalogImage();
    const master = await attached(image);
    const frame = { width: master.frameWidth, height: master.frameHeight };
    await insertBlocks(image, master.masterId!, frame, allCells(frame));
    // A block of another (ended) master is never desired.
    await setup.query(
      "INSERT INTO community.media_public_assets(id,catalog_asset_id,desired_at,created_at,updated_at) VALUES($1,$2,$3,$3,$3)",
      [hex(), image.assetId, t0],
    );
    const plan = await publication.planPublish(
      image.assetId,
      await lease(image.assetId, "publish_media"),
      t0,
    );
    if (plan.status !== "ready") throw new Error(plan.status);
    const blockUnits = plan.units.filter((unit) =>
      unit.role.startsWith("block-"),
    );
    expect(blockUnits).toHaveLength(24);
    expect(
      plan.units
        .filter((unit) => !unit.role.startsWith("block-"))
        .map((unit) => unit.role)
        .sort(),
    ).toEqual(["cover", "display", "thumb", "viewer"]);
    for (const unit of blockUnits)
      expect(unit.objectKey).toMatch(
        /^v1\/[0-9a-f]{32}\/[0-9a-f]{32}\/base\/block-[0-9]{2}\.r1\.jpg$/u,
      );
    expect(await publication.finishPublish(plan.fence, t0)).toBe(true);
    await publication.release(plan.fence, t0);
    await setup.query(
      "UPDATE community.publishing_jobs SET state='succeeded', finished_at=$1, lease_owner=NULL, lease_expires_at=NULL WHERE state='running'",
      [t0],
    );
    const blockIds = blockUnits.map((unit) => unit.renditionId!);
    expect((await publication.lookupPublishedCatalog(blockIds, t0)).size).toBe(
      24,
    );
    // The relay serves a listed block as a catalog_block target.
    const target = await resolveCatalogRenditionRead(app, blockIds[0]!, setup);
    expect(target).toMatchObject({
      kind: "catalog_block",
      contentType: "image/jpeg",
      byteSize: 250000,
    });
    await masters.detach({ mediaId: image.mediaId }, t0);
    expect(
      await resolveCatalogRenditionRead(app, blockIds[0]!, setup),
    ).toBeNull();
    expect((await publication.lookupPublishedCatalog(blockIds, t0)).size).toBe(
      0,
    );
    const withdrawal = await publication.planWithdrawal(
      image.assetId,
      await lease(image.assetId, "withdraw_media"),
      t0,
    );
    if (withdrawal.status !== "ready") throw new Error(withdrawal.status);
    expect(withdrawal.units.map((unit) => unit.role).sort()).toEqual(
      blockUnits.map((unit) => unit.role).sort(),
    );
    const ids = withdrawal.units.map((unit) => unit.id);
    expect(
      await publication.recordOriginDeleted(withdrawal.fence, ids, t0),
    ).toBe(true);
    expect(
      await publication.deferBlockWithdrawal(withdrawal.fence, ids, 3600, t0),
    ).toBe(true);
    expect(
      (
        await setup.query(
          "SELECT DISTINCT fallback_ttl_seconds, last_error_code FROM community.media_publications WHERE id=ANY($1::text[])",
          [ids],
        )
      ).rows,
    ).toEqual([
      { fallback_ttl_seconds: 3600, last_error_code: "block_budget_deferred" },
    ]);
    expect(await publication.blockPurgesSince(t0)).toBe(0);
    expect(await publication.finishWithdrawal(withdrawal.fence, ids, t0)).toBe(
      true,
    );
    await publication.release(withdrawal.fence, t0);
    // Swept once: a swept block leaves the candidates; ordinary rows return hourly.
    const later = new Date(t0.getTime() + 2 * 60 * 60 * 1000);
    const first = await publication.sweepCandidates(later, 500);
    const sweptBlocks = first
      .filter((unit) => ids.includes(unit.id))
      .map((unit) => unit.id);
    expect(sweptBlocks.sort()).toEqual([...ids].sort());
    await publication.recordSweep(sweptBlocks, later);
    const next = await publication.sweepCandidates(
      new Date(later.getTime() + 2 * 60 * 60 * 1000),
      500,
    );
    expect(next.filter((unit) => ids.includes(unit.id))).toEqual([]);
  });

  it("retains exact active-master blocks through the live CMS authority selector", async () => {
    const image = await catalogImage();
    const master = await attached(image);
    const frame = { width: master.frameWidth, height: master.frameHeight };
    const blockIds = await insertBlocks(
      image,
      master.masterId!,
      frame,
      allCells(frame),
    );
    // Deliberately stale App sync metadata must not override the live source.
    await setup.query(
      "UPDATE community.catalog_media_assets SET unreferenced_since=$2 WHERE id=$1",
      [image.assetId, t0],
    );
    // The existing dedicated SQL fixture's published source table is read by
    // setup; all rendition and publication queries still use the real App role.
    // This is authority/SQL integration, not a second dual-DB Native E2E test.
    const malformedImage = await catalogImage();
    const malformedMaster = await attached(malformedImage);
    const malformedBlob = `media-blob-${hex()}`;
    const malformedBlock = `media-rendition-${hex()}`;
    await setup.query(
      "INSERT INTO community.media_blobs(id,owner_id,purpose,storage_key,byte_size,sha256,content_type,created_at) VALUES($1,NULL,'catalog_derivative',$2,1000,$3,'image/jpeg',$4)",
      [malformedBlob, blobKey(), sha(malformedBlob), t0],
    );
    // Width 1 satisfies the bounded column CHECK, but not this cell's width.
    // A separate published asset avoids the ready-role uniqueness constraint
    // without changing the original asset's 24 valid blocks.
    await setup.query(
      "INSERT INTO community.media_renditions(id,catalog_asset_id,catalog_master_id,edit_key,role,recipe_version,recipe_digest,blob_id,width,height,content_type,created_at) VALUES($1,$2,$3,'base','block-00',2,'3333333333333333',$4,1,$5,'image/jpeg',$6)",
      [
        malformedBlock,
        malformedImage.assetId,
        malformedMaster.masterId,
        malformedBlob,
        catalogBlockCell(
          malformedMaster.frameWidth,
          malformedMaster.frameHeight,
          0,
        ).height,
        t0,
      ],
    );
    const authority = catalogAuthorityWithCopySet(setup, null, app);
    const selected = await authority.copyRenditionIds();
    expect(selected).not.toContain(malformedBlock);
    expect(selected.filter((id) => blockIds.includes(id)).sort()).toEqual(
      [...blockIds].sort(),
    );
    const captured = await authority.acquire(image.assetId);
    try {
      expect(
        captured.renditionIds.filter((id) => blockIds.includes(id)).sort(),
      ).toEqual([...blockIds].sort());
      expect(await captured.authorized()).toBe(true);
    } finally {
      await captured.release();
    }
    await setup.query(
      "INSERT INTO community.media_public_assets(id,catalog_asset_id,desired_at,created_at,updated_at) VALUES($1,$2,$3,$3,$3)",
      [hex(), image.assetId, t0],
    );
    const withAuthority = new PostgresMediaPublicationAdapter(app, {
      isPublic: () => true,
      allowPublish: () => true,
      catalogAuthority: authority,
    });
    const job = await lease(image.assetId, "publish_media");
    const plan = await withAuthority.planPublish(image.assetId, job, t0);
    if (plan.status !== "ready") throw new Error(plan.status);
    try {
      expect(
        plan.units
          .filter((u) => u.role.startsWith("block-"))
          .map((u) => u.renditionId!)
          .sort(),
      ).toEqual([...blockIds].sort());
      expect(await withAuthority.finishPublish(plan.fence, t0)).toBe(true);
    } finally {
      await withAuthority.release(plan.fence, t0);
      await setup.query(
        "UPDATE community.publishing_jobs SET state='succeeded',finished_at=$2,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1 AND state='running'",
        [job.id, t0],
      );
    }
    // This is the authority lookup used by the real edge URL resolver, not
    // the no-authority legacy path covered in the preceding case.
    expect(
      (await withAuthority.lookupPublishedCatalog(blockIds, t0)).size,
    ).toBe(24);
    expect(
      await withAuthority.lookupPublishedCatalog([malformedBlock], t0),
    ).toEqual(new Map());
    await setup.query(
      "UPDATE community.media_renditions SET width=1 WHERE id=$1",
      [blockIds[0]],
    );
    const malformedLookup = await withAuthority.lookupPublishedCatalog(
      blockIds,
      t0,
    );
    expect(malformedLookup.size).toBe(23);
    expect(malformedLookup.has(blockIds[0]!)).toBe(false);
    await setup.query(
      "UPDATE community.media_renditions SET width=$2 WHERE id=$1",
      [blockIds[0], catalogBlockCell(frame.width, frame.height, 0).width],
    );
    expect(
      (await withAuthority.lookupPublishedCatalog(blockIds, t0)).size,
    ).toBe(24);
    await setup.query("DELETE FROM public.catalog_media WHERE media_id=$1", [
      image.mediaId,
    ]);
    expect(
      (await withAuthority.lookupPublishedCatalog(blockIds, t0)).size,
    ).toBe(0);
    expect(
      (await authority.copyRenditionIds()).filter((id) =>
        blockIds.includes(id),
      ),
    ).toEqual([]);
    await setup.query(
      "INSERT INTO public.catalog_media(catalog_id,media_id,object_key,width,height,is_representative,position) VALUES($1,$2,$3,$4,$5,false,0)",
      [
        image.catalogId,
        image.mediaId,
        image.objectKey,
        image.width,
        image.height,
      ],
    );
    expect((await masters.detach({ mediaId: image.mediaId }, t0)).status).toBe(
      "done",
    );
    expect(
      (await withAuthority.lookupPublishedCatalog(blockIds, t0)).size,
    ).toBe(0);
    expect(
      (await authority.copyRenditionIds()).filter((id) =>
        blockIds.includes(id),
      ),
    ).toEqual([]);
  });

  it("lets the public read role read the blocks view and nothing else that is new", async () => {
    await expect(
      publicRead.query(
        "SELECT count(*) FROM community.catalog_media_zoom_blocks",
      ),
    ).resolves.toBeDefined();
    await expect(
      publicRead.query(
        "SELECT 1 FROM community.catalog_display_masters LIMIT 1",
      ),
    ).rejects.toThrow(/permission denied/u);
    await expect(
      app.query("DELETE FROM community.catalog_display_masters"),
    ).rejects.toThrow(/permission denied/u);
    await expect(
      app.query("UPDATE community.catalog_display_masters SET note='x'"),
    ).rejects.toThrow(/permission denied/u);
  });
});

describe("Expand-release rollback floor and database cost (criteria 9, 10)", () => {
  const publication = new PostgresMediaPublicationAdapter(
    lazyPool(() => app),
    { isPublic: () => true, allowPublish: () => true },
  );

  it("runs reconcile, withdrawal planning and the sweep over block rows in every state without error", async () => {
    const image = await catalogImage();
    const master = await attached(image);
    const frame = { width: master.frameWidth, height: master.frameHeight };
    const renditions = await insertBlocks(
      image,
      master.masterId!,
      frame,
      [0, 1, 2, 3, 4, 5, 6, 7, 8],
    );
    const publicAsset = hex();
    await setup.query(
      "INSERT INTO community.media_public_assets(id,catalog_asset_id,desired_at,created_at,updated_at) VALUES($1,$2,$3,$3,$3)",
      [publicAsset, image.assetId, t0],
    );
    const ids: string[] = [];
    for (const [index, rendition] of renditions.entries()) {
      const blob = (
        await setup.query<{ storage_key: string; sha256: string }>(
          "SELECT b.storage_key, b.sha256 FROM community.media_renditions r JOIN community.media_blobs b ON b.id=r.blob_id WHERE r.id=$1",
          [rendition],
        )
      ).rows[0]!;
      const id = `media-publication-${hex()}`;
      const token = hex();
      const role = `block-${String(index).padStart(2, "0")}`;
      await setup.query(
        `INSERT INTO community.media_publications(id,public_asset_id,rendition_id,generation_token,object_key,storage_key,content_type,purpose,byte_size,sha256,role,edit_key,created_at)
         VALUES($1,$2,$3,$4,$5,$6,'image/jpeg','catalog_derivative',250000,$7,$8,'base',$9)`,
        [
          id,
          publicAsset,
          rendition,
          token,
          `v1/${publicAsset}/${token}/base/${role}.r1.jpg`,
          blob.storage_key,
          blob.sha256,
          role,
          t0,
        ],
      );
      ids.push(id);
    }
    const move = (id: string, sql: string) =>
      setup.query(
        `UPDATE community.media_publications SET ${sql} WHERE id=$1`,
        [id, t0],
      );
    // publishing (index 0) stays; published:
    await move(ids[1]!, "state='published', published_at=$2");
    for (const index of [2, 3, 4, 5, 6, 7, 8])
      await move(ids[index]!, "state='withdrawing', withdraw_requested_at=$2");
    for (const [index, attempts] of [
      [3, 0],
      [4, 1],
      [5, 3],
    ] as const)
      await move(
        ids[index]!,
        `state='purge_failed', purge_attempts=${attempts}, origin_deleted_at=$2`,
      );
    await move(
      ids[6]!,
      "origin_deleted_at=$2, fallback_ttl_seconds=3600, last_error_code='block_budget_deferred'",
    );
    await move(
      ids[7]!,
      "state='withdrawn', origin_deleted_at=$2, verified_at=$2",
    );
    await move(
      ids[8]!,
      "purge_task_ids='{task-1}', purge_attempts=1, origin_deleted_at=$2, purge_submitted_at=$2",
    );
    await expect(publication.reconcile(t0, true, 500)).resolves.toBeDefined();
    await setup.query(
      "UPDATE community.publishing_jobs SET state='abandoned', finished_at=$2 WHERE subject_id=$1 AND state IN ('queued','running')",
      [image.assetId, t0],
    );
    const id = `publishing-job-${hex()}`;
    await setup.query(
      "INSERT INTO community.publishing_jobs(id,kind,subject_id,state,attempts,max_attempts,run_after,lease_owner,lease_expires_at,created_at,updated_at) VALUES($1,'withdraw_media',$2,'running',1,3,$3,'test',$3::timestamptz + interval '1 hour',$3,$3)",
      [id, image.assetId, t0],
    );
    const plan = await publication.planWithdrawal(
      image.assetId,
      { id, leaseOwner: "test" },
      t0,
    );
    expect(plan.status).toBe("ready");
    expect(
      await publication.blockPurgesSince(new Date(t0.getTime() - 1000)),
    ).toBe(1);
    await expect(
      publication.sweepCandidates(new Date(t0.getTime() + 7_200_000), 500),
    ).resolves.toBeDefined();
    expect(
      (await masters.guardCounts()).blockPublications,
    ).toBeGreaterThanOrEqual(9);
  });

  it(
    "keeps the published Catalog lookup and reconcile's per-row cost within twice their no-block cost, with ≈6,000 block rows",
    async () => {
      const timed = async (sql: string, params: unknown[]) => {
        let best = Number.POSITIVE_INFINITY;
        for (let run = 0; run < 5; run += 1) {
          const plan = (
            await setup.query<{ "QUERY PLAN": { "Execution Time": number }[] }>(
              `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
              params,
            )
          ).rows[0]!["QUERY PLAN"][0]!;
          best = Math.min(best, plan["Execution Time"]);
        }
        return best;
      };
      // A baseline of ordinary published Catalog renditions: 1,500 images × 4.
      await setup.query(
        `WITH images AS (
         SELECT n, 'media-bulk-' || md5('img' || n) AS media_id,
           'editorial/' || md5('c' || n) || md5('c2' || n) || '/' || md5('o' || n) || md5('o2' || n) || '-' || md5('s' || n) || md5('s2' || n) || '.jpg' AS object_key
         FROM generate_series(1, 1500) AS n
       ), published AS (
         INSERT INTO public.catalog_media(catalog_id,media_id,object_key,width,height,is_representative,position)
         SELECT 'catalog-bulk', media_id, object_key, 4096, 2731, false, n FROM images RETURNING 1
       ), assets AS (
         INSERT INTO community.catalog_media_assets(id,media_id,source_object_key,state,master_sha256,master_width,master_height,created_at,updated_at)
         SELECT 'catalog-asset-' || md5(media_id || ':' || object_key), media_id, object_key, 'ready', md5('s' || n) || md5('s2' || n), 4096, 2731, $1, $1 FROM images RETURNING id
       ), roles AS (
         SELECT i.n, 'catalog-asset-' || md5(i.media_id || ':' || i.object_key) AS asset_id, r.role, r.w, r.h
         FROM images i CROSS JOIN (VALUES ('thumb', 480, 320), ('cover', 720, 480), ('display', 2048, 1366), ('viewer', 4096, 2731)) AS r(role, w, h)
       ), blobs AS (
         INSERT INTO community.media_blobs(id,owner_id,purpose,storage_key,byte_size,sha256,content_type,created_at)
         SELECT 'media-blob-' || md5('b' || n || role), NULL, 'catalog_derivative',
           'blobs/' || substr(md5('b' || n || role), 1, 2) || '/' || substr(md5('b' || n || role), 3, 2) || '/' || md5('b' || n || role),
           1000, encode(sha256(convert_to('b' || n || role, 'UTF8')), 'hex'), 'image/webp', $1 FROM roles RETURNING 1
       )
       INSERT INTO community.media_renditions(id,catalog_asset_id,edit_key,role,recipe_version,recipe_digest,blob_id,width,height,content_type,created_at)
       SELECT 'media-rendition-' || md5('r' || n || role), asset_id, 'base', role, 1, '1111111111111111', 'media-blob-' || md5('b' || n || role), w, h, 'image/webp', $1
       FROM roles WHERE (SELECT count(*) FROM assets) > 0 AND (SELECT count(*) FROM blobs) > 0 AND (SELECT count(*) FROM published) > 0`,
        [t0],
      );
      const image = await catalogImage();
      const master = await attached(image);
      const frame = { width: master.frameWidth, height: master.frameHeight };
      const lookupIds = await insertBlocks(
        image,
        master.masterId!,
        frame,
        allCells(frame),
      );
      // The desired-set SQL itself, as reconcile and the lookup embed it.
      const desired = (
        (await import(
          new URL(
            "../../../services/community-postgres/src/publishing/publication-eligibility.ts",
            import.meta.url,
          ).href
        )) as { readonly desiredRenditionsSql: (catalog: boolean) => string }
      ).desiredRenditionsSql(true);
      const reconcileSql = `SELECT count(*) FROM (${desired}) d`;
      const lookupSql = `SELECT d.rendition_id FROM (${desired}) d WHERE d.rendition_id=ANY($1::text[]) AND d.catalog_asset_id IS NOT NULL`;
      const desiredRows = async () =>
        Number((await setup.query(reconcileSql)).rows[0]!.count);
      await setup.query("ANALYZE");
      const before = {
        reconcile: await timed(reconcileSql, []),
        lookup: await timed(lookupSql, [lookupIds]),
        rows: await desiredRows(),
      };
      // ≈6,000 more blocks: 125 mastered images of 48 blocks each.
      for (let index = 0; index < 125; index += 1) {
        const bulk = await catalogImage({ width: 4096, height: 2731 });
        const bulkMaster = await attached(bulk, {
          header: { contentType: "image/jpeg", width: 9504, height: 6336 },
        });
        await setup.query(
          `WITH cells AS (
           SELECT cell, (cell % 8) * 1024 AS left_edge, (cell / 8) * 1024 AS top_edge FROM generate_series(0, 47) AS cell
         ), blobs AS (
           INSERT INTO community.media_blobs(id,owner_id,purpose,storage_key,byte_size,sha256,content_type,created_at)
           SELECT 'media-blob-' || md5($1 || cell), NULL, 'catalog_derivative',
             'blobs/' || substr(md5($1 || cell), 1, 2) || '/' || substr(md5($1 || cell), 3, 2) || '/' || md5($1 || cell),
             250000, encode(sha256(convert_to($1 || cell, 'UTF8')), 'hex'), 'image/jpeg', $3
           FROM cells RETURNING id
         )
         INSERT INTO community.media_renditions(id,catalog_asset_id,catalog_master_id,edit_key,role,recipe_version,recipe_digest,blob_id,width,height,content_type,created_at)
         SELECT 'media-rendition-' || md5('r' || $1 || cell), $2, $1, 'base', 'block-' || lpad(cell::text, 2, '0'), 1, '2222222222222222',
           'media-blob-' || md5($1 || cell), LEAST(1026, 8192 - left_edge), LEAST(1026, 5461 - top_edge), 'image/jpeg', $3
         FROM cells WHERE (SELECT count(*) FROM blobs) = 48`,
          [bulkMaster.masterId, bulk.assetId, t0],
        );
      }
      expect(
        Number(
          (
            await setup.query(
              "SELECT count(*) FROM community.media_renditions WHERE catalog_master_id IS NOT NULL",
            )
          ).rows[0]!.count,
        ),
      ).toBeGreaterThanOrEqual(6000);
      await setup.query("ANALYZE");
      const after = {
        reconcile: await timed(reconcileSql, []),
        lookup: await timed(lookupSql, [lookupIds]),
        rows: await desiredRows(),
      };
      // Content-free numbers for the PR record (milliseconds and row counts).
      console.info(`[catalog-zoom-cost] ${JSON.stringify({ before, after })}`);
      expect(after.rows - before.rows).toBeGreaterThanOrEqual(6000);
      // The per-image lookup must not grow with the number of blocks; reconcile
      // reads every desired row, so its cost per row is what may not double.
      expect(after.lookup).toBeLessThanOrEqual(2 * before.lookup + 1);
      expect(after.reconcile / after.rows).toBeLessThanOrEqual(
        (2 * before.reconcile) / before.rows + 0.001,
      );
    },
    SLOW,
  );
});

describe("Catalog block jobs in the store (PR B; criteria 3a, 5)", () => {
  const works = new PostgresWorkPublishingAdapter(
    lazyPool(() => app),
    { publication: { allowPublish: () => true, isPublic: () => true } },
  );
  const quiet = () =>
    setup.query(
      "UPDATE community.publishing_jobs SET state='abandoned', finished_at=$1, last_error_code='test_reset', lease_owner=NULL, lease_expires_at=NULL WHERE state IN ('queued','running')",
      [t0],
    );
  const blockRecords = (
    frame: { width: number; height: number },
    cells: readonly number[],
  ) =>
    cells.map((cell) => {
      const rect = catalogBlockCell(frame.width, frame.height, cell);
      const key = blobKey();
      return {
        storageKey: key,
        byteSize: 250_000,
        sha256: sha(key),
        cell,
        recipeVersion: 1,
        recipeDigest: "3333333333333333",
        contentType: "image/jpeg" as const,
        width: rect.width,
        height: rect.height,
      };
    });

  it("reads a block job's plan only for an active master of a ready, referenced asset", async () => {
    const image = await catalogImage();
    const master = await attached(image);
    const payload = {
      variant: "blocks",
      masterId: master.masterId,
      cells: [0, 15],
    };
    const plan = await works.readCatalogBlockPlan(image.assetId, payload);
    expect(plan).toMatchObject({
      assetId: image.assetId,
      masterId: master.masterId,
      master: {
        contentType: "image/jpeg",
        width: 6000,
        height: 4000,
        byteSize: 20_000_000,
      },
      frame: { width: 6000, height: 4000 },
      reference: { width: 2048 },
      cells: [0, 15],
    });
    expect(
      await works.readCatalogBlockPlan(image.assetId, {
        ...payload,
        cells: [20, 24],
      }),
    ).toBeNull();
    expect(
      await works.readCatalogBlockPlan(image.assetId, { ...payload, extra: 1 }),
    ).toBeNull();
    await masters.detach({ mediaId: image.mediaId }, t0);
    expect(await works.readCatalogBlockPlan(image.assetId, payload)).toBeNull();
  });

  it("records blocks with their master as the App role, discards a replay or an ended master's, and keeps one set per asset", async () => {
    const image = await catalogImage();
    const first = await attached(image);
    const frame = { width: first.frameWidth, height: first.frameHeight };
    const outcome = {
      masterId: first.masterId!,
      blocks: blockRecords(frame, [0, 1, 2]),
    };
    expect(await works.recordCatalogBlocks(image.assetId, outcome, t0)).toEqual(
      { status: "recorded" },
    );
    const listed = await publicRead.query(
      "SELECT cell, frame_width, frame_height, cells FROM community.catalog_media_zoom_blocks WHERE media_id=$1 ORDER BY cell",
      [image.mediaId],
    );
    expect(listed.rows).toEqual(
      [0, 1, 2].map((cell) => ({
        cell,
        frame_width: 6000,
        frame_height: 4000,
        cells: 24,
      })),
    );
    // A replayed job records nothing twice.
    const replay = await works.recordCatalogBlocks(
      image.assetId,
      { masterId: first.masterId!, blocks: blockRecords(frame, [0]) },
      t0,
    );
    expect(replay.status).toBe("discarded");
    // A block that does not fit its cell is refused.
    await expect(
      works.recordCatalogBlocks(
        image.assetId,
        {
          masterId: first.masterId!,
          blocks: [{ ...blockRecords(frame, [3])[0]!, width: 1000 }],
        },
        t0,
      ),
    ).rejects.toThrow(TypeError);
    // After a limit change the old master's late job is discarded entirely.
    const limited = await masters.setLimit(image.mediaId, 5500, "owner", t0);
    const late = await works.recordCatalogBlocks(
      image.assetId,
      { masterId: first.masterId!, blocks: blockRecords(frame, [5]) },
      t0,
    );
    expect(late.status).toBe("discarded");
    expect(late.status === "discarded" ? late.storageKeys : []).toHaveLength(1);
    const limitedId = limited.status === "done" ? limited.masterId! : "";
    const newFrame = { width: 5500, height: 3667 };
    expect(
      await works.recordCatalogBlocks(
        image.assetId,
        { masterId: limitedId, blocks: blockRecords(newFrame, [0]) },
        t0,
      ),
    ).toEqual({ status: "recorded" });
    expect(
      (
        await setup.query(
          "SELECT catalog_master_id, state FROM community.media_renditions WHERE catalog_asset_id=$1 AND role='block-00' ORDER BY state",
          [image.assetId],
        )
      ).rows,
    ).toEqual([
      { catalog_master_id: limitedId, state: "ready" },
      { catalog_master_id: first.masterId, state: "released" },
    ]);
  });

  it("queues missing cells of at most two open sets, skipping complete, paused and content-failed sets", async () => {
    await quiet();
    await setup.query(
      "UPDATE community.catalog_display_masters SET ended_at=$1, end_reason='detached' WHERE ended_at IS NULL",
      [t0],
    );
    await setup.query(
      "UPDATE community.media_renditions SET state='released', released_at=$1 WHERE catalog_master_id IS NOT NULL AND state='ready'",
      [t0],
    );
    const images = await Promise.all([1, 2, 3, 4, 5].map(() => catalogImage()));
    const ids: string[] = [];
    for (const image of images) ids.push((await attached(image)).masterId!);
    const frame = { width: 6000, height: 4000 };
    // Image 1 is complete; image 2 failed on content; image 3 is paused.
    await works.recordCatalogBlocks(
      images[0]!.assetId,
      {
        masterId: ids[0]!,
        blocks: blockRecords(
          frame,
          Array.from({ length: 16 }, (_, cell) => cell),
        ),
      },
      t0,
    );
    await works.recordCatalogBlocks(
      images[0]!.assetId,
      {
        masterId: ids[0]!,
        blocks: blockRecords(
          frame,
          Array.from({ length: 8 }, (_, cell) => cell + 16),
        ),
      },
      t0,
    );
    await blockJob(
      images[1]!.assetId,
      ids[1]!,
      [0, 15],
      "failed",
      "master_mismatch",
    );
    await blockJob(
      images[2]!.assetId,
      ids[2]!,
      [0, 15],
      "failed",
      "processing_timeout",
    );
    const result = await works.enqueueCatalogBlockSets(t0, 100);
    expect(result).toEqual({ enqueued: 4 });
    const open = (
      await setup.query<{ master: string; cells: number[] }>(
        "SELECT payload->>'masterId' AS master, payload->'cells' AS cells FROM community.publishing_jobs WHERE kind='catalog_render' AND payload->>'variant'='blocks' AND state='queued' ORDER BY payload->>'masterId', (payload->'cells'->>0)::int",
      )
    ).rows;
    expect(new Set(open.map((row) => row.master))).toEqual(
      new Set([ids[3], ids[4]]),
    );
    expect(
      open.filter((row) => row.master === ids[3]).map((row) => row.cells),
    ).toEqual([
      [0, 15],
      [16, 23],
    ]);
    // Two sets open: nothing more is queued.
    expect(await works.enqueueCatalogBlockSets(t0, 100)).toEqual({
      enqueued: 0,
    });
    // Only the Owner's requeue lifts the pause, under the same bound.
    expect(await masters.requeue(images[2]!.mediaId, t0)).toMatchObject({
      status: "refused",
      code: "sets_busy",
    });
    await quiet();
    expect(await masters.requeue(images[2]!.mediaId, t0)).toEqual({
      status: "done",
      jobs: 2,
    });
    expect(await masters.requeue(images[1]!.mediaId, t0)).toMatchObject({
      status: "refused",
      code: "content_failure",
    });
  });

  it("reaches a newer set past older ones that wait, and skips a set without a display rendition (review M1, L3)", async () => {
    await quiet();
    await setup.query(
      "UPDATE community.catalog_display_masters SET ended_at=$1, end_reason='detached' WHERE ended_at IS NULL",
      [t0],
    );
    await setup.query(
      "UPDATE community.media_renditions SET state='released', released_at=$1 WHERE catalog_master_id IS NOT NULL AND state='ready'",
      [t0],
    );
    const images = await Promise.all([1, 2, 3, 4, 5].map(() => catalogImage()));
    const ids: string[] = [];
    for (const image of images) ids.push((await attached(image)).masterId!);
    const frame = { width: 6000, height: 4000 };
    // Four sets that cannot be queued: complete, failed on content, paused,
    // and one without a display rendition.
    for (const cells of [
      Array.from({ length: 16 }, (_, cell) => cell),
      Array.from({ length: 8 }, (_, cell) => cell + 16),
    ])
      await works.recordCatalogBlocks(
        images[0]!.assetId,
        { masterId: ids[0]!, blocks: blockRecords(frame, cells) },
        t0,
      );
    await blockJob(
      images[1]!.assetId,
      ids[1]!,
      [0, 15],
      "failed",
      "zoom_blocks_alpha",
    );
    await blockJob(
      images[2]!.assetId,
      ids[2]!,
      [0, 15],
      "abandoned",
      "processing_failed",
    );
    await setup.query(
      "UPDATE community.media_renditions SET state='released', released_at=$1 WHERE catalog_asset_id=$2 AND role='display'",
      [t0, images[3]!.assetId],
    );
    // A pass of one set still reaches the newest set.
    expect(await works.enqueueCatalogBlockSets(t0, 1)).toEqual({
      enqueued: 2,
    });
    const open = (
      await setup.query<{ master: string }>(
        "SELECT DISTINCT payload->>'masterId' AS master FROM community.publishing_jobs WHERE kind='catalog_render' AND payload->>'variant'='blocks' AND state='queued'",
      )
    ).rows.map((row) => row.master);
    expect(open).toEqual([ids[4]]);
    await quiet();
  });
});

/*
 * Development smoke (PR B; opt-in, needs Docker and the local
 * `yoyi-work-publishing-media-tools:v2` image from `pnpm dev:media-sandbox`):
 * the `catalog-master attach` command uploads a synthetic master into a
 * private filesystem store; one Catalog sync with the block step queues its
 * set; the publishing worker with the block flag claims the job and cuts the
 * blocks in the real sandbox container; the Development relay then serves a
 * block as image/jpeg.
 */
describe.skipIf(process.env.CATALOG_BLOCKS_SANDBOX_SMOKE !== "1")(
  "Development smoke: attach, one sync, sandbox blocks, relay",
  () => {
    it("cuts a real master in the sandbox container and serves a block as image/jpeg", async () => {
      await setup.query(
        "UPDATE community.publishing_jobs SET state='abandoned', finished_at=$1, last_error_code='test_reset', lease_owner=NULL, lease_expires_at=NULL WHERE state IN ('queued','running')",
        [t0],
      );
      await setup.query(
        "UPDATE community.catalog_display_masters SET ended_at=$1, end_reason='detached' WHERE ended_at IS NULL",
        [t0],
      );
      const base = await realpath(
        await mkdtemp(path.join(tmpdir(), "catalog-blocks-smoke-")),
      );
      const handles: { shutdown(): Promise<void> }[] = [];
      try {
        const directories = ["store", "work", "inbox"].map((name) =>
          path.join(base, name),
        );
        for (const directory of directories) {
          await mkdir(directory, { mode: 0o700 });
          await chmod(directory, 0o700);
        }
        const [storeDirectory, work, inbox] = directories as [
          string,
          string,
          string,
        ];
        const store = await FilesystemPublishingMediaStore.open(
          storeDirectory,
          { temporaryRoots: [] },
        );
        // A synthetic 3000 x 1960 master: frame 3000 x 1960, 3 x 2 cells.
        const width = 3000;
        const height = 1960;
        const pixels = Buffer.alloc(width * height * 3);
        for (let y = 0; y < height; y += 1)
          for (let x = 0; x < width; x += 1) {
            const offset = (y * width + x) * 3;
            pixels[offset] = (x * 255) / width;
            pixels[offset + 1] = (y * 255) / height;
            pixels[offset + 2] =
              128 + 100 * Math.sin(x / 23) * Math.cos(y / 31);
          }
        const master = await sharp(pixels, {
          raw: { width, height, channels: 3 },
        })
          .jpeg({ quality: 95 })
          .toBuffer();
        await writeFile(path.join(inbox, "master.jpg"), master);
        // The approved image is the master at 3/4 (blocks gain >= 1.25x),
        // with current base renditions, so the sync queues no base render.
        const image = await catalogImage({ width: 2250, height: 1470 });
        for (const identity of catalogSyncIdentities())
          await setup.query(
            "UPDATE community.media_renditions SET recipe_version=$3, recipe_digest=$4 WHERE catalog_asset_id=$1 AND role=$2",
            [image.assetId, identity.role, identity.version, identity.digest],
          );
        // The asset's display rendition with real bytes in the store.
        const display = await sharp(master)
          .resize({
            width: 2048,
            height: 2048,
            fit: "inside",
            kernel: "lanczos3",
          })
          .webp({ quality: 86, effort: 4, smartSubsample: false })
          .toBuffer({ resolveWithObject: true });
        const stored = await store.writeStream(
          "catalog",
          "derivative",
          "image/webp",
          display.data.byteLength,
          (async function* () {
            yield display.data;
          })(),
          { requireExactSize: true },
        );
        await setup.query(
          `UPDATE community.media_blobs b SET storage_key=$2, byte_size=$3, sha256=$4
             FROM community.media_renditions r
             WHERE r.blob_id=b.id AND r.catalog_asset_id=$1 AND r.role='display'`,
          [image.assetId, stored.storageKey, stored.byteSize, stored.sha256],
        );
        await setup.query(
          "UPDATE community.media_renditions SET width=$2, height=$3 WHERE catalog_asset_id=$1 AND role='display'",
          [image.assetId, display.info.width, display.info.height],
        );

        // 1. The Owner's attach, through the command and the App role.
        const approval = path.join(base, "approval.json");
        await writeFile(
          approval,
          JSON.stringify({
            version: 1,
            kind: APPROVAL_KIND,
            catalogId: image.catalogId,
            entries: [
              {
                mediaId: image.mediaId,
                approvedSha256: image.approvedSha256,
                masterFile: "master.jpg",
                masterSha256: createHash("sha256").update(master).digest("hex"),
                derivation: "submitted",
              },
            ],
          }),
        );
        const lines: Record<string, unknown>[] = [];
        const attachedOk = await runCatalogMasterCommand(
          parseCatalogMasterArguments([
            "attach",
            "--media",
            image.mediaId,
            "--approval",
            approval,
            "--inbox",
            inbox,
          ]),
          {
            port: masters,
            store: async () => store,
            out: (line) => lines.push(line),
            now: () => t0,
          },
        );
        expect(
          { attachedOk, line: lines.at(-1) },
          JSON.stringify(lines),
        ).toMatchObject({
          attachedOk: true,
          line: {
            status: "attached",
            frameWidth: width,
            frameHeight: height,
            cells: 6,
          },
        });

        // 2. One Catalog sync with the block step queues the set.
        const works = new PostgresWorkPublishingAdapter(app, {
          publication: { allowPublish: () => true, isPublic: () => true },
        });
        const syncLog = { info: vi.fn(), error: vi.fn() };
        await createCatalogSync({
          listSources: () => listPublishedCatalogSources(setup),
          port: works,
          blocks: works,
          logger: syncLog,
        }).run(t0);
        expect(syncLog.info).toHaveBeenCalledWith(
          "[media-worker] catalog block sync enqueued=1",
        );

        // 3. The worker with the block flag cuts the set in the container.
        const started = Date.now();
        const clock = () =>
          new Date(t0.getTime() + 60_000 + (Date.now() - started));
        const renderLog = { info: vi.fn(), error: vi.fn() };
        const silent = {
          info: () => undefined,
          error: () => undefined,
          warn: () => undefined,
        };
        const worker = new PublishingWorker({
          port: works,
          handlers: createPublishingJobHandlers({
            port: works,
            store,
            catalog: {
              port: works,
              renderer: {
                render: async () => {
                  throw new Error("The smoke runs no base render");
                },
              },
              blocks: {
                port: works,
                renderer: createCatalogBlockRenderer({
                  store,
                  sandbox: await createSandboxRunner({
                    image: "yoyi-work-publishing-media-tools:v2",
                    workDirectory: work,
                    appDist: defaultSandboxAppDist().appDist,
                    temporaryRoots: [],
                  }),
                  logger: renderLog,
                }),
              },
            },
            clock,
            logger: silent,
          }),
          owner: `catalog-blocks-smoke-${hex(6)}`,
          kinds: ["catalog_render"],
          catalogBlocks: true,
          maintenance: false,
          concurrency: 1,
          pollIntervalMs: 200,
          clock,
          logger: silent,
        });
        worker.start();
        try {
          await vi.waitFor(
            async () => {
              const job = (
                await setup.query<{
                  variant: string;
                  state: string;
                  last_error_code: string | null;
                }>(
                  "SELECT COALESCE(payload->>'variant','base') AS variant, state, last_error_code FROM community.publishing_jobs WHERE subject_id=$1",
                  [image.assetId],
                )
              ).rows;
              expect(job).toEqual([
                {
                  variant: "blocks",
                  state: "succeeded",
                  last_error_code: null,
                },
              ]);
            },
            { timeout: 150_000, interval: 500 },
          );
        } finally {
          await worker.stop();
        }
        expect(String(renderLog.info.mock.calls.at(-1)?.[0])).toMatch(
          /^\[media-worker\] catalog blocks stage_ms=\d+ render_ms=\d+ cells=6 outcome=rendered$/u,
        );
        const listed = (
          await publicRead.query<{
            cell: number;
            delivery_key: string;
            width: number;
            height: number;
          }>(
            "SELECT cell, delivery_key, width, height FROM community.catalog_media_zoom_blocks WHERE media_id=$1 ORDER BY cell",
            [image.mediaId],
          )
        ).rows;
        expect(listed.map((row) => [row.cell, row.width, row.height])).toEqual([
          [0, 1026, 1026],
          [1, 1026, 1026],
          [2, 952, 1026],
          [3, 1026, 936],
          [4, 1026, 936],
          [5, 952, 936],
        ]);

        // 4. The Development relay serves a block as image/jpeg.
        const handle = await startBackendProcess({
          listen: { host: "127.0.0.1", port: 0 },
          requestListener: createBackendApplication({
            nodeEnv: "development",
            catalogQueryPort: createDevelopmentCatalogFixtureQueryPort(),
            storageUrlResolver: new UnconfiguredStorageUrlResolver(),
            communityIdentityPort: new InMemoryCommunityIdentityPort(),
            developmentCatalogRenditions: {
              resolve: (renditionId: string) =>
                resolveCatalogRenditionRead(app, renditionId, setup),
              store,
            },
          }),
        });
        handles.push(handle);
        const response = await new Promise<{
          status: number;
          type: string | undefined;
          body: Buffer;
        }>((resolve, reject) => {
          const outgoing = httpRequest(
            {
              host: "127.0.0.1",
              port: handle.address.port,
              path: `/v1/development/catalog-renditions/${listed[5]!.delivery_key}`,
            },
            (incoming) => {
              const chunks: Buffer[] = [];
              incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
              incoming.on("end", () =>
                resolve({
                  status: incoming.statusCode ?? 0,
                  type: incoming.headers["content-type"],
                  body: Buffer.concat(chunks),
                }),
              );
              incoming.on("error", reject);
            },
          );
          outgoing.on("error", reject);
          outgoing.end();
        });
        expect(response.status).toBe(200);
        expect(response.type).toBe("image/jpeg");
        const served = await sharp(response.body).metadata();
        expect([served.format, served.width, served.height]).toEqual([
          "jpeg",
          952,
          936,
        ]);
      } finally {
        for (const handle of handles) await handle.shutdown();
        await rm(base, { recursive: true, force: true });
      }
    }, 240_000);
  },
);

describe("Catalog Detail deep-zoom reads (PR C; criteria 12, 13, 20)", () => {
  const as = lazyPool;
  const publication = new PostgresMediaPublicationAdapter(
    as(() => app),
    { isPublic: () => true, allowPublish: () => true },
  );
  let open = true;
  const reader = () =>
    new PostgresCatalogQueryAdapter(
      as(() => publicRead),
      {
        renditions: true,
        zoom: { isOpen: async () => open },
      },
    );
  const mastered = async (cells: "all" | "missing-one" | "none" = "all") => {
    const image = await catalogImage();
    const master = await attached(image);
    const frame = { width: master.frameWidth, height: master.frameHeight };
    const all = allCells(frame);
    const ids =
      cells === "none"
        ? []
        : await insertBlocks(
            image,
            master.masterId!,
            frame,
            cells === "all" ? all : all.slice(1),
          );
    return { image, frame, ids };
  };

  it("lists frames of complete sets only, and one image's keys row-major, as the public read role", async () => {
    const complete = await mastered("all");
    const partial = await mastered("missing-one");
    expect([
      ...(await reader().getZoomFrames(complete.image.catalogId as never)),
    ]).toEqual([[complete.image.mediaId, complete.frame]]);
    expect(
      (await reader().getZoomFrames(partial.image.catalogId as never)).size,
    ).toBe(0);
    expect(
      await reader().getZoomBlocks(
        complete.image.catalogId as never,
        complete.image.mediaId as never,
      ),
    ).toEqual({ ...complete.frame, keys: complete.ids });
    expect(
      await reader().getZoomBlocks(
        partial.image.catalogId as never,
        partial.image.mediaId as never,
      ),
    ).toBeNull();
    // Production composition keeps CMS media reads separate from App block
    // facts. Exercise both real SQL branches with the existing distinct roles.
    const splitReader = new PostgresCatalogQueryAdapter(
      as(() => publicRead),
      {
        renditions: false,
        zoomPool: as(() => app),
        zoom: { isOpen: async () => open },
      },
    );
    expect([
      ...(await splitReader.getZoomFrames(complete.image.catalogId as never)),
    ]).toEqual([[complete.image.mediaId, complete.frame]]);
    expect(
      await splitReader.getZoomBlocks(
        complete.image.catalogId as never,
        complete.image.mediaId as never,
      ),
    ).toEqual({ ...complete.frame, keys: complete.ids });
    expect(
      (await splitReader.getZoomFrames(partial.image.catalogId as never)).size,
    ).toBe(0);
    expect(
      await splitReader.getZoomBlocks(
        partial.image.catalogId as never,
        partial.image.mediaId as never,
      ),
    ).toBeNull();
    // Another record's image is never listed.
    expect(
      await reader().getZoomBlocks(
        partial.image.catalogId as never,
        complete.image.mediaId as never,
      ),
    ).toBeNull();
    // A closed gate, or a reader composed without it, reads nothing.
    open = false;
    expect(
      (await reader().getZoomFrames(complete.image.catalogId as never)).size,
    ).toBe(0);
    open = true;
    expect(
      (
        await new PostgresCatalogQueryAdapter(
          as(() => publicRead),
          {
            renditions: true,
          },
        ).getZoomFrames(complete.image.catalogId as never)
      ).size,
    ).toBe(0);
    // A detached master's blocks leave the Detail at once.
    await masters.detach({ mediaId: complete.image.mediaId }, t0);
    expect(
      (await reader().getZoomFrames(complete.image.catalogId as never)).size,
    ).toBe(0);
  });

  it(
    "keeps the Detail frame read flat as other images gain block sets",
    async () => {
      const target = await mastered("all");
      const measure = async () => {
        let best = Number.POSITIVE_INFINITY;
        for (let run = 0; run < 5; run += 1) {
          const plan = await publicRead.query<{ "QUERY PLAN": unknown }>(
            `EXPLAIN (ANALYZE, FORMAT JSON) ${catalogZoomFramesSql}`,
            [target.image.catalogId],
          );
          const [root] = plan.rows[0]!["QUERY PLAN"] as [
            { "Execution Time": number },
          ];
          best = Math.min(best, root["Execution Time"]);
        }
        return best;
      };
      const before = await measure();
      for (let n = 0; n < 20; n += 1) await mastered("all");
      await setup.query("ANALYZE");
      const after = await measure();
      console.info(
        `[catalog-zoom-cost] detail frame read before=${before.toFixed(3)}ms after=${after.toFixed(3)}ms other_sets=20`,
      );
      expect(after).toBeLessThanOrEqual(2 * before + 0.5);
    },
    SLOW,
  );

  it("stores and reads the day-to-date usage columns as the App role", async () => {
    await setup.query("DELETE FROM community.media_request_usage");
    expect(
      await publication.recordDayUsage(
        { dayStart: t0, requests: 5, bytes: 6 },
        t0,
      ),
    ).toBe(false);
    expect(await publication.readDayUsage()).toBeNull();
    await publication.recordRequestUsage(
      { start: t0, end: t0, requests: 0, warning: false },
      t0,
    );
    expect(await publication.readDayUsage()).toBeNull();
    const observed = new Date(t0.getTime() + 60_000);
    expect(
      await publication.recordDayUsage(
        { dayStart: t0, requests: 150_000, bytes: null },
        observed,
      ),
    ).toBe(true);
    expect(await publication.readDayUsage()).toEqual({
      dayStart: t0,
      requests: 150_000,
      bytes: null,
      observedAt: observed,
    });
    await expect(
      publication.recordDayUsage({ dayStart: t0, requests: -1, bytes: 0 }, t0),
    ).rejects.toThrow(TypeError);
  });
});

describe("PR A review fixes (B1, B2, S2, S3, S5)", () => {
  const works = () =>
    new PostgresWorkPublishingAdapter(app, {
      publication: { allowPublish: () => true, isPublic: () => true },
    });
  const reset = () =>
    setup.query(
      "UPDATE community.publishing_jobs SET state='abandoned', finished_at=$1, lease_owner=NULL, lease_expires_at=NULL WHERE state IN ('queued','running')",
      [t0],
    );
  const baseJob = async (assetId: string, state = "queued") => {
    const id = `publishing-job-${hex()}`;
    await setup.query(
      `INSERT INTO community.publishing_jobs(id,kind,subject_id,state,run_after,created_at,updated_at,lease_owner,lease_expires_at)
       VALUES($1,'catalog_render',$2,$3,$4,$4,$4,CASE WHEN $3='running' THEN 'test' END,CASE WHEN $3='running' THEN $4::timestamptz + interval '1 hour' END)`,
      [id, assetId, state, t0],
    );
    return id;
  };
  const claim = async (catalogBlocks?: boolean) =>
    (
      await works().claimJobs(
        {
          owner: `w-${hex(4)}`,
          limit: 1,
          leaseMs: 60_000,
          kinds: ["catalog_render"],
          ...(catalogBlocks === undefined ? {} : { catalogBlocks }),
        },
        new Date(t0.getTime() + 600_000),
      )
    )[0]?.id;

  it("claims a payload-less base Catalog render with the block flag omitted or false (B1)", async () => {
    await reset();
    const image = await catalogImage();
    for (const flag of [undefined, false] as const) {
      const id = await baseJob(image.assetId);
      expect(await claim(flag), String(flag)).toBe(id);
      await reset();
    }
  });

  it("never starts a block job while a base Catalog render is due or running (B1, criterion 5)", async () => {
    await reset();
    const image = await catalogImage();
    const master = await attached(image);
    const block = await blockJob(
      image.assetId,
      master.masterId!,
      [0, 15],
      "queued",
    );
    const running = await baseJob(image.assetId, "running");
    expect(await claim(true)).toBeUndefined();
    await setup.query(
      "UPDATE community.publishing_jobs SET state='succeeded', finished_at=$2, lease_owner=NULL, lease_expires_at=NULL WHERE id=$1",
      [running, t0],
    );
    const due = await baseJob(image.assetId);
    expect(await claim(true)).toBe(due);
    expect(await claim(true)).toBeUndefined();
    await setup.query(
      "UPDATE community.publishing_jobs SET state='succeeded', finished_at=$2, lease_owner=NULL, lease_expires_at=NULL WHERE id=$1",
      [due, t0],
    );
    expect(await claim(true)).toBe(block);
  });

  it("never pauses the profile sweep for a queued block job (B2)", async () => {
    await reset();
    const anchors = [
      { role: "avatar-128" as const, version: 1, digest: "1111111111111111" },
      {
        role: "background-960" as const,
        version: 1,
        digest: "1111111111111111",
      },
    ];
    const sweep = () =>
      works().enqueueProfileRenders(t0, { limit: 2, maxOpen: 2, anchors });
    expect((await sweep()).paused).toBe(false);
    const image = await catalogImage();
    const master = await attached(image);
    await blockJob(image.assetId, master.masterId!, [0, 15], "queued");
    expect((await sweep()).paused).toBe(false);
    // A base render still yields the sweep, as before.
    await baseJob(image.assetId);
    expect((await sweep()).paused).toBe(true);
    await reset();
  });

  it("counts only an active master's jobs as an open set (S5)", async () => {
    await reset();
    const image = await catalogImage();
    const master = await attached(image);
    await blockJob(image.assetId, master.masterId!, [0, 15], "running");
    await masters.detach({ mediaId: image.mediaId }, t0);
    const open = (
      await setup.query<{ master_id: string }>(
        `SELECT DISTINCT j.payload->>'masterId' AS master_id FROM community.publishing_jobs j
         JOIN community.catalog_display_masters m ON m.id=j.payload->>'masterId' AND m.ended_at IS NULL
         WHERE j.kind='catalog_render' AND COALESCE(j.payload->>'variant','')='blocks' AND j.state IN ('queued','running')`,
      )
    ).rows.map((row) => row.master_id);
    expect(open).not.toContain(master.masterId);
    await reset();
  });
});

/*
 * catalog-deep-zoom-self-master-v1 (Issue #321): a published `editorial/`
 * original is its own master when all four conditions hold (criteria 1, 2);
 * the read-only source lookup and `attach --from-source` through a real
 * source reader, store and the App role (criterion 3); and the storage
 * bounds counting blocks that are not yet cut (criterion 4).
 */
describe("Self-masters (catalog-deep-zoom-self-master-v1, Issue #321)", () => {
  const works = new PostgresWorkPublishingAdapter(
    lazyPool(() => app),
    { publication: { allowPublish: () => true, isPublic: () => true } },
  );
  const quiet = async () => {
    await setup.query(
      "UPDATE community.publishing_jobs SET state='abandoned', finished_at=$1, last_error_code='test_reset', lease_owner=NULL, lease_expires_at=NULL WHERE state IN ('queued','running')",
      [t0],
    );
    await setup.query(
      "UPDATE community.catalog_display_masters SET ended_at=$1, end_reason='detached' WHERE ended_at IS NULL",
      [t0],
    );
  };
  /** A 60 MP-class `editorial/` original published as is, viewer 4096. */
  const original = (
    options: Parameters<typeof catalogImage>[0] = {},
  ): Promise<CatalogImage> =>
    catalogImage({ width: 9504, height: 6336, viewerLong: 4096, ...options });
  /** The approved bytes themselves as the master, `submitted`. */
  const self = (
    image: CatalogImage,
    overrides: Partial<CatalogMasterAttach> = {},
  ): Partial<CatalogMasterAttach> => ({
    masterSha256: image.approvedSha256,
    header: {
      contentType: "image/jpeg",
      width: image.width,
      height: image.height,
    },
    ...overrides,
  });
  const dry = { kind: "dry_run", byteSize: 40_000_000 } as const;
  const check = async (
    image: CatalogImage,
    overrides: Partial<CatalogMasterAttach> = {},
  ) =>
    codeOf(
      await masters.attach(
        attachInput(image, self(image, { source: dry, ...overrides })),
        t0,
      ),
    );

  it("attaches a self-master that meets all four conditions: an 8192 x 5461 frame of 48 cells", async () => {
    const image = await original();
    expect(
      await masters.attach(
        attachInput(image, self(image, { source: dry })),
        t0,
      ),
    ).toMatchObject({
      status: "done",
      masterId: null,
      frameWidth: 8192,
      frameHeight: 5461,
      cells: 48,
    });
    const result = await attached(image, self(image));
    expect(result).toMatchObject({
      frameWidth: 8192,
      frameHeight: 5461,
      cells: 48,
    });
    expect(
      (
        await setup.query(
          "SELECT m.master_sha256, m.master_width, m.master_height, m.derivation, b.sha256 FROM community.catalog_display_masters m JOIN community.media_blobs b ON b.id=m.blob_id WHERE m.id=$1",
          [result.masterId],
        )
      ).rows[0],
    ).toEqual({
      master_sha256: image.approvedSha256,
      master_width: 9504,
      master_height: 6336,
      derivation: "submitted",
      sha256: image.approvedSha256,
    });
  });

  it("refuses with approved_too_large when any single self-master condition breaks", async () => {
    // 1. The approved key is not `editorial/` (a pilot `display/v1/` key).
    expect(await check(await original({ keyForm: "display" }))).toBe(
      "approved_too_large",
    );
    // 2. The master's bytes are not the approved image's.
    const image = await original();
    expect(await check(image, { masterSha256: sha("another file") })).toBe(
      "approved_too_large",
    );
    // 3. The base render recorded another source.
    expect(
      await check(await original({ master: { sha256: sha("rendered") } })),
    ).toBe("approved_too_large");
    // 4. The master's oriented size is not the size the base render decoded
    //    (a rotated original recorded unoriented fails closed).
    expect(
      await check(await original({ master: { width: 6336, height: 9504 } })),
    ).toBe("approved_too_large");
    // 5. It is not the submitted file.
    expect(await check(image, { derivation: "edited-export" })).toBe(
      "approved_too_large",
    );
    // All four hold: the same image passes.
    expect(await check(image)).toBe("done");
  });

  it("keeps every other check for a self-master: aspect, framing, gain, base and the long scroll", async () => {
    // The published size and the decoded original disagree in aspect.
    const skewed = await catalogImage({
      width: 9504,
      height: 6000,
      viewerLong: 4096,
      master: { width: 9504, height: 6336 },
    });
    expect(
      await check(skewed, {
        header: { contentType: "image/jpeg", width: 9504, height: 6336 },
      }),
    ).toBe("aspect_mismatch");
    // 1.25 x the 4096 viewer is 5120: a 5000 px original gains too little.
    const small = await catalogImage({
      width: 5000,
      height: 3334,
      viewerLong: 4096,
    });
    expect(await check(small)).toBe("gain_too_small");
    // A 3000 px viewer is below 0.45 x the 8192 frame.
    expect(await check(await original({ viewerLong: 3000 }))).toBe(
      "base_too_small",
    );
    // An already full-size long scroll (986 x 4031, viewer 4031) gains nothing.
    const scroll = await catalogImage({ width: 986, height: 4031 });
    expect(await check(scroll)).toBe("gain_too_small");
  });

  it("limits and re-attaches a self-master under the same rule", async () => {
    const image = await original();
    const first = await attached(image, self(image));
    expect(await masters.setLimit(image.mediaId, 6144, "owner", t0)).toEqual(
      expect.objectContaining({
        status: "done",
        frameWidth: 6144,
        frameHeight: 4096,
        cells: 24,
      }),
    );
    expect(
      codeOf(await masters.setLimit(image.mediaId, 5000, "owner", t0)),
    ).toBe("gain_too_small");
    expect((await masters.detach({ mediaId: image.mediaId }, t0)).status).toBe(
      "done",
    );
    expect(
      await masters.attach(
        attachInput(
          image,
          self(image, {
            source: { kind: "existing", masterId: first.masterId! },
          }),
        ),
        t0,
      ),
    ).toMatchObject({ status: "done", frameWidth: 8192, frameHeight: 5461 });
  });

  it("names the published original only for a ready, published `editorial/` image without an active master", async () => {
    const image = await original();
    expect(await masters.sourceOf(image.mediaId)).toEqual({
      status: "done",
      objectKey: image.objectKey,
      approvedSha256: image.approvedSha256,
    });
    expect(
      codeOf(
        await masters.sourceOf(
          (await original({ keyForm: "display" })).mediaId,
        ),
      ),
    ).toBe("not_editorial");
    expect(
      codeOf(
        await masters.sourceOf((await original({ published: false })).mediaId),
      ),
    ).toBe("not_published");
    const pending = await original();
    await setup.query(
      "UPDATE community.catalog_media_assets SET state='pending' WHERE id=$1",
      [pending.assetId],
    );
    expect(codeOf(await masters.sourceOf(pending.mediaId))).toBe(
      "asset_not_ready",
    );
    await attached(image, self(image));
    expect(codeOf(await masters.sourceOf(image.mediaId))).toBe(
      "already_attached",
    );
    await expect(masters.sourceOf("bad id")).rejects.toThrow(TypeError);
  });

  it("takes the approved SHA-256 from the key, which the asset's recorded one always equals (review R6)", async () => {
    // The schema refuses an asset whose recorded SHA-256 is not its key's, so
    // a self-master's key check and approved-image check never disagree.
    await expect(
      original({ published: false, sourceSha256: sha("other bytes") }),
    ).rejects.toThrow(/catalog_media_assets_source_sha256_bound/u);
    // An asset that recorded none qualifies through its key's SHA-256.
    const unrecorded = await original({ sourceSha256: null });
    expect(await masters.sourceOf(unrecorded.mediaId)).toEqual({
      status: "done",
      objectKey: unrecorded.objectKey,
      approvedSha256: unrecorded.approvedSha256,
    });
    expect(await check(unrecorded)).toBe("done");
    expect(await check(unrecorded, { masterSha256: sha("another file") })).toBe(
      "approved_too_large",
    );
  });

  it("cuts, lists and selects a self-master's 48 blocks like any master's", async () => {
    await quiet();
    const image = await original();
    const master = await attached(image, self(image));
    const frame = { width: master.frameWidth, height: master.frameHeight };
    expect(await works.enqueueCatalogBlockSets(t0, 100)).toEqual({
      enqueued: 3,
    });
    const ranges = (
      await setup.query<{ cells: [number, number] }>(
        "SELECT payload->'cells' AS cells FROM community.publishing_jobs WHERE kind='catalog_render' AND payload->>'masterId'=$1 AND state='queued' ORDER BY (payload->'cells'->>0)::int",
        [master.masterId],
      )
    ).rows.map((row) => row.cells);
    expect(ranges).toEqual([
      [0, 15],
      [16, 31],
      [32, 47],
    ]);
    for (const [from, to] of ranges)
      expect(
        await works.recordCatalogBlocks(
          image.assetId,
          {
            masterId: master.masterId!,
            blocks: Array.from({ length: to - from + 1 }, (_, index) => {
              const cell = from + index;
              const rect = catalogBlockCell(frame.width, frame.height, cell);
              const key = blobKey();
              return {
                storageKey: key,
                byteSize: 250_000,
                sha256: sha(key),
                cell,
                recipeVersion: 1,
                recipeDigest: "3333333333333333",
                contentType: "image/jpeg" as const,
                width: rect.width,
                height: rect.height,
              };
            }),
          },
          t0,
        ),
      ).toEqual({ status: "recorded" });
    const blockIds = (
      await setup.query<{ id: string }>(
        "SELECT id FROM community.media_renditions WHERE catalog_master_id=$1 AND state='ready' ORDER BY role",
        [master.masterId],
      )
    ).rows.map((row) => row.id);
    expect(blockIds).toHaveLength(48);
    const reader = new PostgresCatalogQueryAdapter(
      lazyPool(() => publicRead),
      { renditions: true, zoom: { isOpen: async () => true } },
    );
    expect([...(await reader.getZoomFrames(image.catalogId as never))]).toEqual(
      [[image.mediaId, frame]],
    );
    expect(
      await reader.getZoomBlocks(
        image.catalogId as never,
        image.mediaId as never,
      ),
    ).toEqual({ ...frame, keys: blockIds });
    // The whole Catalog's copy set, the tests' oracle since catalog-scale-v1
    // W7 (a scoped pass publishing a self-master's set is tested with the
    // block-set marks below).
    const authority = catalogAuthorityWithCopySet(setup, null, app);
    expect(
      (await authority.copyRenditionIds()).filter((id) =>
        blockIds.includes(id),
      ),
    ).toHaveLength(48);
    expect((await masters.status(image.catalogId)).masters[0]).toMatchObject({
      blocksReady: 48,
      complete: true,
    });
  });

  it("counts the projected blocks of masters not yet cut, so a fast batch cannot pass the slice cap", async () => {
    await quiet();
    const images = await Promise.all([1, 2, 3].map(() => catalogImage()));
    // Each default master: 6000 x 4000 frame, projected at 1 byte per pixel.
    const projected = 6000 * 4000;
    const before = (await masters.status(null)).storage.sliceBytes;
    // Sized so the third attach fits only if the first two attaches' blocks
    // were forgotten: before + 3m + projected <= cap < before + 3m + 3 x projected.
    const masterBytes = Math.floor(
      (CATALOG_MASTER_SLICE_CAP - before - 2 * projected) / 3,
    );
    const upload = () =>
      ({
        kind: "upload",
        storageKey: blobKey(),
        byteSize: masterBytes,
      }) as const;
    const first = await attached(images[0]!, { source: upload() });
    expect(first.storage.sliceBytes).toBe(before);
    const second = await attached(images[1]!, { source: upload() });
    // The first master's bytes and its projected blocks, nothing cut yet.
    expect(second.storage.sliceBytes).toBe(before + masterBytes + projected);
    const third = await masters.attach(
      attachInput(images[2]!, { source: upload() }),
      t0,
    );
    expect(third).toMatchObject({
      status: "refused",
      code: "storage_slice_cap",
      storage: {
        sliceBytes: before + 2 * masterBytes + 2 * projected,
        attachBytes: masterBytes + projected,
        sliceCap: CATALOG_MASTER_SLICE_CAP,
      },
    });
    // Once a set is cut, its real block bytes replace its projection, and
    // the published copy its blocks do not have yet stays counted.
    const frame = { width: first.frameWidth, height: first.frameHeight };
    const cut = await insertBlocks(
      images[0]!,
      first.masterId!,
      frame,
      allCells(frame),
    );
    const settled = before + 2 * masterBytes + projected + 2 * 24 * 250_000;
    expect((await masters.status(null)).storage.sliceBytes).toBe(settled);
    // A dry run sees the same bound, also one sized into the room that
    // forgetting the unpublished copy would leave.
    for (const byteSize of [masterBytes, masterBytes - 24 * 250_000])
      expect(
        codeOf(
          await masters.attach(
            attachInput(images[2]!, {
              source: { kind: "dry_run", byteSize },
            }),
            t0,
          ),
        ),
      ).toBe("storage_slice_cap");
    // When the publication rows land, the reservation becomes their bytes:
    // the slice total does not move.
    const publicAsset = hex();
    await setup.query(
      "INSERT INTO community.media_public_assets(id,catalog_asset_id,desired_at,created_at,updated_at) VALUES($1,$2,$3,$3,$3)",
      [publicAsset, images[0]!.assetId, t0],
    );
    for (const [cell, rendition] of cut.entries()) {
      const blob = (
        await setup.query<{ storage_key: string; sha256: string }>(
          "SELECT b.storage_key, b.sha256 FROM community.media_renditions r JOIN community.media_blobs b ON b.id=r.blob_id WHERE r.id=$1",
          [rendition],
        )
      ).rows[0]!;
      const token = hex();
      const role = `block-${String(cell).padStart(2, "0")}`;
      await setup.query(
        `INSERT INTO community.media_publications(id,public_asset_id,rendition_id,generation_token,object_key,storage_key,content_type,purpose,byte_size,sha256,role,edit_key,created_at)
         VALUES($1,$2,$3,$4,$5,$6,'image/jpeg','catalog_derivative',250000,$7,$8,'base',$9)`,
        [
          `media-publication-${hex()}`,
          publicAsset,
          rendition,
          token,
          `v1/${publicAsset}/${token}/base/${role}.r1.jpg`,
          blob.storage_key,
          blob.sha256,
          role,
          t0,
        ],
      );
      if (cell === 11)
        expect((await masters.status(null)).storage.sliceBytes).toBe(settled);
    }
    expect((await masters.status(null)).storage.sliceBytes).toBe(settled);
    // Leave the slice for later suites: end both, release their blobs and
    // withdraw the block publications.
    await masters.detach({ all: true }, t0);
    await setup.query(
      `UPDATE community.media_blobs SET state='tombstoned', tombstoned_at=$2, retention_hold=NULL
       WHERE id IN (SELECT blob_id FROM community.catalog_display_masters WHERE id=ANY($1::text[]))`,
      [[first.masterId, second.masterId], t0],
    );
    for (const step of [
      "state='withdrawing', withdraw_requested_at=$2",
      "state='withdrawn', origin_deleted_at=$2, verified_at=$2",
    ])
      await setup.query(
        `UPDATE community.media_publications SET ${step} WHERE public_asset_id=$1`,
        [publicAsset, t0],
      );
  });

  it("takes the storage lock before the bounded check, so another process waits for it and sees its bytes", async () => {
    await quiet();
    const image = await catalogImage();
    const before = (await masters.status(null)).storage.sliceBytes;
    const filler = `media-blob-${hex()}`;
    const holder = await setup.connect();
    let open = false;
    let attach: Promise<unknown> | undefined;
    try {
      // Another catalog-master transaction holds the storage lock and fills
      // the slice to its cap; it commits only once the attach waits.
      await holder.query("BEGIN");
      open = true;
      await holder.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('catalog-master-storage',0))",
      );
      await holder.query(
        `INSERT INTO community.media_blobs(id,owner_id,purpose,storage_key,byte_size,sha256,content_type,retention_hold,created_at)
         VALUES($1,NULL,'catalog_master',$2,$3,$4,'image/jpeg','catalog_master',$5)`,
        [filler, blobKey(), CATALOG_MASTER_SLICE_CAP - before, sha(filler), t0],
      );
      let settled = false;
      attach = masters
        .attach(
          attachInput(image, {
            source: { kind: "dry_run", byteSize: 1_000_000 },
          }),
          t0,
        )
        .finally(() => {
          settled = true;
        });
      // The attach waits on this very key (not on a slow preamble): another
      // backend's request for the storage lock is queued, not granted.
      let waiting = false;
      for (let poll = 0; poll < 100 && !waiting && !settled; poll += 1) {
        waiting =
          (
            await setup.query(
              `SELECT 1 FROM pg_locks l,
                 (SELECT hashtextextended('catalog-master-storage',0) AS k) key
               WHERE l.locktype='advisory' AND NOT l.granted AND l.objsubid=1
                 AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database())
                 AND l.classid=((key.k >> 32) & 4294967295)::oid
                 AND l.objid=(key.k & 4294967295)::oid`,
            )
          ).rowCount === 1;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(settled).toBe(false);
      expect(waiting).toBe(true);
      await holder.query("COMMIT");
      open = false;
      // The bounds are read after the wait: the committed filler refuses
      // it. A bounds read before the lock would still have answered done.
      expect(
        codeOf(
          (await attach) as { readonly status: string; readonly code?: string },
        ),
      ).toBe("storage_slice_cap");
    } finally {
      if (open) await holder.query("ROLLBACK");
      // On a failed assertion the attach finishes once the lock is free.
      await attach?.catch(() => undefined);
      holder.release();
      await setup.query(
        "UPDATE community.media_blobs SET state='tombstoned', tombstoned_at=$2, retention_hold=NULL WHERE id=$1",
        [filler, t0],
      );
    }
  });

  it("serializes concurrent attaches, so two processes cannot both pass the slice cap", async () => {
    await quiet();
    const images = await Promise.all([1, 2].map(() => catalogImage()));
    const projected = 6000 * 4000;
    const before = (await masters.status(null)).storage.sliceBytes;
    // Either attach fits alone; the second one cannot fit beside the first.
    const masterBytes =
      Math.floor((CATALOG_MASTER_SLICE_CAP - before) / 2) - projected + 1;
    const results = await Promise.all(
      images.map((image) =>
        masters.attach(
          attachInput(image, {
            source: {
              kind: "upload",
              storageKey: blobKey(),
              byteSize: masterBytes,
            },
          }),
          t0,
        ),
      ),
    );
    expect(results.map(codeOf).sort()).toEqual(["done", "storage_slice_cap"]);
    const ids = results.flatMap((result) =>
      result.status === "done" && result.masterId ? [result.masterId] : [],
    );
    await masters.detach({ all: true }, t0);
    await setup.query(
      `UPDATE community.media_blobs SET state='tombstoned', tombstoned_at=$2, retention_hold=NULL
       WHERE id IN (SELECT blob_id FROM community.catalog_display_masters WHERE id=ANY($1::text[]))`,
      [ids, t0],
    );
  });

  it("counts the projected blocks of masters not yet cut in the task bound too (review R1)", async () => {
    await quiet();
    const images = await Promise.all([1, 2].map(() => catalogImage()));
    // Each default master: a 20,000,000-byte upload and a 6000 x 4000 frame.
    const masterBytes = 20_000_000;
    const projected = 6000 * 4000;
    const taskBefore = (await masters.status(null)).storage.taskBytes;
    // Other #206 bytes (a member's original) fill the task bound so that the
    // second attach fits only if the first attach's blocks were forgotten:
    // with them it is 12,000,000 bytes over.
    const user = `user-${hex()}`;
    await setup.query(
      "INSERT INTO community.public_users(id,handle,display_name) VALUES($1,$2,'合成')",
      [user, `cz-${hex(8)}`],
    );
    const filler = `media-blob-${hex()}`;
    const fillerBytes =
      CATALOG_MASTER_TASK_CAP -
      taskBefore -
      2 * (masterBytes + projected) +
      12_000_000;
    await setup.query(
      "INSERT INTO community.media_blobs(id,owner_id,purpose,storage_key,byte_size,sha256,content_type,created_at) VALUES($1,$2,'original',$3,$4,$5,'image/jpeg',$6)",
      [filler, user, blobKey(), fillerBytes, sha(filler), t0],
    );
    try {
      const sliceBefore = (await masters.status(null)).storage.sliceBytes;
      const first = await attached(images[0]!);
      expect(first.storage.taskBytes).toBe(taskBefore + fillerBytes);
      expect(await masters.attach(attachInput(images[1]!), t0)).toMatchObject({
        status: "refused",
        code: "storage_task_cap",
        storage: {
          taskBytes: taskBefore + fillerBytes + masterBytes + projected,
          sliceBytes: sliceBefore + masterBytes + projected,
          attachBytes: masterBytes + projected,
          taskCap: CATALOG_MASTER_TASK_CAP,
        },
      });
    } finally {
      await setup.query(
        "UPDATE community.media_blobs SET state='tombstoned', tombstoned_at=$2 WHERE id=$1",
        [filler, t0],
      );
    }
  });

  it("counts a block with a live and a withdrawing publication once, so a partly cut set stays projected", async () => {
    await quiet();
    const images = await Promise.all([1, 2].map(() => catalogImage()));
    // A default master: a 20,000,000-byte upload and a 6000 x 4000 frame.
    const masterBytes = 20_000_000;
    const projected = 6000 * 4000;
    const before = (await masters.status(null)).storage.sliceBytes;
    const first = await attached(images[0]!);
    const frame = { width: first.frameWidth, height: first.frameHeight };
    // Every cell but the last is cut: the set is not complete, so its whole
    // frame stays projected beside the cut blocks' bytes.
    const cut = await insertBlocks(
      images[0]!,
      first.masterId!,
      frame,
      allCells(frame).slice(0, -1),
    );
    const partly = before + masterBytes + cut.length * 250_000 + projected;
    expect((await masters.status(null)).storage.sliceBytes).toBe(partly);
    // The first cut block is published under a new generation while its old
    // one is still withdrawing: two publication rows that are not withdrawn
    // for one rendition (the live-rendition index covers only publishing and
    // published). Both rows' bytes count, but the block counts once: the set
    // stays not cut and projected, rather than looking cut with only its
    // other blocks' unpublished copies left.
    const publicAsset = hex();
    await setup.query(
      "INSERT INTO community.media_public_assets(id,catalog_asset_id,desired_at,created_at,updated_at) VALUES($1,$2,$3,$3,$3)",
      [publicAsset, images[0]!.assetId, t0],
    );
    const blob = (
      await setup.query<{ storage_key: string; sha256: string }>(
        "SELECT b.storage_key, b.sha256 FROM community.media_renditions r JOIN community.media_blobs b ON b.id=r.blob_id WHERE r.id=$1",
        [cut[0]],
      )
    ).rows[0]!;
    for (const state of ["withdrawing", "published"] as const) {
      const token = hex();
      await setup.query(
        `INSERT INTO community.media_publications(id,public_asset_id,rendition_id,generation_token,object_key,storage_key,content_type,purpose,byte_size,sha256,role,edit_key,state,published_at,withdraw_requested_at,created_at)
         VALUES($1,$2,$3,$4,$5,$6,'image/jpeg','catalog_derivative',250000,$7,'block-00','base',$8,$9,$10,$9)`,
        [
          `media-publication-${hex()}`,
          publicAsset,
          cut[0],
          token,
          `v1/${publicAsset}/${token}/base/block-00.r1.jpg`,
          blob.storage_key,
          blob.sha256,
          state,
          t0,
          state === "withdrawing" ? t0 : null,
        ],
      );
    }
    const settled = partly + 2 * 250_000;
    expect((await masters.status(null)).storage.sliceBytes).toBe(settled);
    // So an attach sized into the room that counting the block twice would
    // leave is refused.
    const room = CATALOG_MASTER_SLICE_CAP - settled - projected;
    expect(
      await masters.attach(
        attachInput(images[1]!, {
          source: { kind: "dry_run", byteSize: room + 1 },
        }),
        t0,
      ),
    ).toMatchObject({
      status: "refused",
      code: "storage_slice_cap",
      storage: { sliceBytes: settled, attachBytes: room + 1 + projected },
    });
    // Leave the slice for later suites: end the master, release its blob and
    // withdraw the block publications.
    await masters.detach({ all: true }, t0);
    await setup.query(
      `UPDATE community.media_blobs SET state='tombstoned', tombstoned_at=$2, retention_hold=NULL
       WHERE id IN (SELECT blob_id FROM community.catalog_display_masters WHERE id=$1)`,
      [first.masterId, t0],
    );
    for (const step of [
      "state='withdrawing', withdraw_requested_at=$2",
      "state='withdrawn', origin_deleted_at=$2, verified_at=$2",
    ])
      await setup.query(
        `UPDATE community.media_publications SET ${step} WHERE public_asset_id=$1`,
        [publicAsset, t0],
      );
  });

  it("leaves out the projection of the master a limit change or a re-attach ends (review R2)", async () => {
    await quiet();
    const image = await catalogImage();
    // A 6000 x 4000 frame, 5500 x 3667 once limited; 1 byte per frame pixel.
    const projected = 6000 * 4000;
    const limitedProjection = 5500 * 3667;
    const before = (await masters.status(null)).storage.sliceBytes;
    // Sized so that the limit change and the re-attach each fit only while the
    // master they end is left out: 12,000,000 bytes below the slice cap after
    // the first attach, and over it if that master's blocks counted twice.
    const masterBytes =
      CATALOG_MASTER_SLICE_CAP - before - projected - 12_000_000;
    const first = await attached(image, {
      source: { kind: "upload", storageKey: blobKey(), byteSize: masterBytes },
    });
    expect(first.storage.sliceBytes).toBe(before);
    const limited = await masters.setLimit(image.mediaId, 5500, "owner", t0);
    expect(limited).toMatchObject({
      status: "done",
      frameWidth: 5500,
      frameHeight: 3667,
      storage: {
        sliceBytes: before + masterBytes,
        attachBytes: limitedProjection,
      },
    });
    // The image is replaced in Admin while the limited master is still
    // active: re-attaching that master to the new asset ends it.
    const replacement = await catalogImage({
      mediaId: image.mediaId,
      catalogId: image.catalogId,
      approvedSha256: sha(`${image.mediaId}:replacement`),
    });
    await setup.query(
      "DELETE FROM public.catalog_media WHERE media_id=$1 AND object_key=$2",
      [image.mediaId, image.objectKey],
    );
    await setup.query(
      "UPDATE community.catalog_media_assets SET unreferenced_since=$2 WHERE id=$1",
      [image.assetId, t0],
    );
    const limitedId = limited.status === "done" ? limited.masterId! : "";
    const again = await masters.attach(
      attachInput(replacement, {
        source: { kind: "existing", masterId: limitedId },
      }),
      t0,
    );
    expect(again).toMatchObject({
      status: "done",
      frameWidth: 6000,
      frameHeight: 4000,
      storage: { sliceBytes: before + masterBytes, attachBytes: projected },
    });
    expect(
      (
        await setup.query(
          "SELECT end_reason FROM community.catalog_display_masters WHERE id=$1",
          [limitedId],
        )
      ).rows[0],
    ).toEqual({ end_reason: "reattached" });
    // Leave the slice for later suites: end it and release its blob.
    await masters.detach({ all: true }, t0);
    await setup.query(
      `UPDATE community.media_blobs SET state='tombstoned', tombstoned_at=$2, retention_hold=NULL
       WHERE id IN (SELECT blob_id FROM community.catalog_display_masters WHERE id=$1)`,
      [first.masterId, t0],
    );
  });

  it("attaches through --from-source: the source reader, an empty inbox, the store and the App role", async () => {
    await quiet();
    const base = await realpath(
      await mkdtemp(path.join(tmpdir(), "catalog-self-master-")),
    );
    try {
      const directories = ["store", "inbox", "media"].map((name) =>
        path.join(base, name),
      );
      for (const directory of directories) {
        await mkdir(directory, { mode: 0o700 });
        await chmod(directory, 0o700);
      }
      const [storeDirectory, inbox, media] = directories as [
        string,
        string,
        string,
      ];
      const store = await FilesystemPublishingMediaStore.open(storeDirectory, {
        temporaryRoots: [],
      });
      // A synthetic 5200 x 3467 original published as is: frame 5200 x 3467
      // over a 4096 viewer (1.27 x), 6 x 4 cells.
      const bytes = await sharp({
        create: {
          width: 5200,
          height: 3467,
          channels: 3,
          background: { r: 120, g: 90, b: 60 },
        },
      })
        .jpeg({ quality: 80 })
        .toBuffer();
      const approvedSha256 = createHash("sha256").update(bytes).digest("hex");
      const image = await catalogImage({
        width: 5200,
        height: 3467,
        viewerLong: 4096,
        approvedSha256,
      });
      await writeFile(
        path.join(media, image.objectKey.split("/").at(-1)!),
        bytes,
      );
      const pilot = await original({ keyForm: "display" });
      const approval = path.join(base, "approval.json");
      await writeFile(
        approval,
        JSON.stringify({
          version: 1,
          kind: APPROVAL_KIND,
          catalogId: image.catalogId,
          entries: [
            {
              mediaId: pilot.mediaId,
              approvedSha256: pilot.approvedSha256,
              masterFile: "pilot.jpg",
              masterSha256: pilot.approvedSha256,
              derivation: "submitted",
            },
            {
              mediaId: image.mediaId,
              approvedSha256,
              masterFile: "original.jpg",
              masterSha256: approvedSha256,
              derivation: "submitted",
            },
          ],
        }),
      );
      const local = new LocalCatalogSourceReader(media);
      const inboxCounts: number[] = [];
      const reader: CatalogSourceReader = {
        async read(objectKey, target, options) {
          const read = await local.read(objectKey, target, options);
          inboxCounts.push((await readdir(inbox)).length);
          return read;
        },
      };
      const lines: Record<string, unknown>[] = [];
      const ok = await runCatalogMasterCommand(
        parseCatalogMasterArguments([
          "attach-batch",
          "--approval",
          approval,
          "--inbox",
          inbox,
          "--from-source",
        ]),
        {
          port: masters,
          store: async () => store,
          source: async () => reader,
          out: (line) => lines.push(line),
          now: () => t0,
        },
      );
      expect(ok).toBe(false);
      expect(lines).toEqual([
        {
          command: "attach",
          mediaId: pilot.mediaId,
          status: "refused",
          code: "not_editorial",
        },
        expect.objectContaining({
          command: "attach",
          mediaId: image.mediaId,
          status: "attached",
          frameWidth: 5200,
          frameHeight: 3467,
          cells: 24,
        }),
      ]);
      expect(JSON.stringify(lines)).not.toMatch(
        /editorial\/|display\/v1|original\.jpg|blobs\/|catalog-self-master/u,
      );
      expect(inboxCounts).toEqual([1]);
      expect(await readdir(inbox)).toEqual([]);
      const row = (
        await setup.query<{
          sha256: string;
          byte_size: string;
          storage_key: string;
        }>(
          `SELECT b.sha256, b.byte_size, b.storage_key FROM community.catalog_display_masters m
           JOIN community.media_blobs b ON b.id=m.blob_id
           WHERE m.catalog_asset_id=$1 AND m.ended_at IS NULL`,
          [image.assetId],
        )
      ).rows[0]!;
      expect(row).toMatchObject({
        sha256: approvedSha256,
        byte_size: String(bytes.byteLength),
      });
      // The private store holds the original's exact bytes.
      expect(
        createHash("sha256")
          .update(await readFile(path.join(storeDirectory, row.storage_key)))
          .digest("hex"),
      ).toBe(approvedSha256);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("catalog-scale-v1: a block set's change marks its asset for the scoped reconcile", () => {
  const authority = createCatalogPublicationAuthority(
    lazyPool(() => setup),
    null,
    lazyPool(() => app),
  );
  /** The real authority, planning only the assets with a pending mark: a
   * scoped pass with an empty sweep share, so only a mark brings an asset
   * into it. */
  const markedOnly: typeof authority = {
    ...authority,
    async planScope(ids, options) {
      const marked = new Set(
        (
          await setup.query<{ asset_id: string }>(
            "SELECT asset_id FROM community.catalog_publication_dirty WHERE mark_seq > cleared_seq",
          )
        ).rows.map((row) => row.asset_id),
      );
      const kept = ids.filter((id) => marked.has(id));
      return authority.planScope(kept, { ...options, reserved: kept.length });
    },
  };
  const publication = new PostgresMediaPublicationAdapter(
    lazyPool(() => app),
    {
      isPublic: () => true,
      allowPublish: () => true,
      catalogAuthority: markedOnly,
    },
  );
  const works = new PostgresWorkPublishingAdapter(
    lazyPool(() => app),
    {
      publication: { allowPublish: () => true, isPublic: () => true },
    },
  );
  /** Every earlier mark cleared: only what the test does marks. */
  const clearMarks = () =>
    setup.query(
      "UPDATE community.catalog_publication_dirty SET cleared_seq = mark_seq",
    );
  const pendingMark = async (assetId: string) =>
    (
      await setup.query<{ reason: string; urgent: boolean }>(
        "SELECT reason, urgent FROM community.catalog_publication_dirty WHERE asset_id=$1 AND mark_seq > cleared_seq",
        [assetId],
      )
    ).rows[0] ?? null;
  const queued = async (assetId: string) =>
    (
      await setup.query<{ kind: string }>(
        "SELECT kind FROM community.publishing_jobs WHERE subject_id=$1 AND kind IN ('publish_media','withdraw_media') AND state='queued' ORDER BY kind",
        [assetId],
      )
    ).rows.map((row) => row.kind);
  /** Runs the asset's queued publish and withdraw jobs, and those they
   * queue (a publish queues the withdrawal of what it replaced), to
   * completion. */
  const runJobs = async (assetId: string): Promise<void> => {
    const jobs = (
      await setup.query<{ id: string; kind: string }>(
        "SELECT id, kind FROM community.publishing_jobs WHERE subject_id=$1 AND kind IN ('publish_media','withdraw_media') AND state='queued' ORDER BY kind DESC",
        [assetId],
      )
    ).rows;
    if (!jobs.length) return;
    for (const job of jobs) {
      const owner = hex(8);
      await setup.query(
        "UPDATE community.publishing_jobs SET state='running', attempts=attempts+1, lease_owner=$2, lease_expires_at=$3::timestamptz + interval '1 hour' WHERE id=$1",
        [job.id, owner, t0],
      );
      const lease = { id: job.id, leaseOwner: owner };
      const plan =
        job.kind === "publish_media"
          ? await publication.planPublish(assetId, lease, t0)
          : await publication.planWithdrawal(assetId, lease, t0);
      if (plan.status !== "ready")
        throw new Error(`${job.kind} ${plan.status}`);
      try {
        const ids = plan.units.map((unit) => unit.id);
        if (job.kind === "publish_media")
          expect(await publication.finishPublish(plan.fence, t0)).toBe(true);
        else if (ids.length) {
          expect(
            await publication.recordOriginDeleted(plan.fence, ids, t0),
          ).toBe(true);
          expect(await publication.finishWithdrawal(plan.fence, ids, t0)).toBe(
            true,
          );
        }
      } finally {
        await publication.release(plan.fence, t0);
      }
      await setup.query(
        "UPDATE community.publishing_jobs SET state='succeeded', finished_at=$2, lease_owner=NULL, lease_expires_at=NULL WHERE id=$1",
        [job.id, t0],
      );
    }
    await runJobs(assetId);
  };
  /** The live (publishing or published) publications of the asset's blocks. */
  const liveBlocks = async (assetId: string) =>
    (
      await setup.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM community.media_publications p
         JOIN community.media_renditions r ON r.id=p.rendition_id
         WHERE r.catalog_asset_id=$1 AND r.role ~ '^block-' AND p.state IN ('publishing','published')`,
        [assetId],
      )
    ).rows[0]!.n;
  /** A published image (a default one, or `served`) with an active master
   * (attached with `overrides`) and its base set copied. */
  const servedWithMaster = async (
    served?: CatalogImage,
    overrides: Partial<CatalogMasterAttach> = {},
  ) => {
    const image = served ?? (await catalogImage());
    const master = await attached(image, overrides);
    await clearMarks();
    await setup.query(
      `INSERT INTO community.catalog_publication_dirty (asset_id, mark_seq, reason, marked_at)
       VALUES ($1, 1, 'public_membership', $2)
       ON CONFLICT (asset_id) DO UPDATE SET mark_seq = community.catalog_publication_dirty.mark_seq + 1`,
      [image.assetId, t0],
    );
    await publication.reconcile(t0, true, 500);
    expect(await queued(image.assetId)).toEqual(["publish_media"]);
    await runJobs(image.assetId);
    await clearMarks();
    return { image, master };
  };

  it("publishes a recorded block set in the next pass, which plans no sweep asset", async () => {
    const { image, master } = await servedWithMaster();
    const frame = { width: master.frameWidth, height: master.frameHeight };
    const recorded = await works.recordCatalogBlocks(
      image.assetId,
      {
        masterId: master.masterId!,
        blocks: [0, 1, 2].map((cell) => {
          const rect = catalogBlockCell(frame.width, frame.height, cell);
          const key = blobKey();
          return {
            storageKey: key,
            byteSize: 250_000,
            sha256: sha(key),
            cell,
            recipeVersion: 1,
            recipeDigest: "3333333333333333",
            contentType: "image/jpeg" as const,
            width: rect.width,
            height: rect.height,
          };
        }),
      },
      t0,
    );
    expect(recorded).toEqual({ status: "recorded" });
    const marked = await pendingMark(image.assetId);
    // The pass copies the new generation (and, as for any new generation,
    // queues the withdrawal of what it replaces).
    await publication.reconcile(t0, true, 500);
    expect(await queued(image.assetId)).toContain("publish_media");
    // A normal mark brought it in: the new blocks are publish-side work.
    expect(marked).toEqual({ reason: "rendition", urgent: false });
    await runJobs(image.assetId);
    expect(await liveBlocks(image.assetId)).toBe(3);
  });

  it("withdraws a detached master's published blocks in the next pass, and a new limit or a re-attach marks too", async () => {
    const { image, master } = await servedWithMaster();
    const frame = { width: master.frameWidth, height: master.frameHeight };
    await insertBlocks(image, master.masterId!, frame, allCells(frame));
    await setup.query(
      `INSERT INTO community.catalog_publication_dirty (asset_id, mark_seq, reason, marked_at)
       VALUES ($1, 1, 'rendition', $2)
       ON CONFLICT (asset_id) DO UPDATE SET mark_seq = community.catalog_publication_dirty.mark_seq + 1`,
      [image.assetId, t0],
    );
    expect((await publication.reconcile(t0, true, 500)).publish).toBe(1);
    await runJobs(image.assetId);
    expect(await liveBlocks(image.assetId)).toBe(24);
    await clearMarks();
    expect(await masters.detach({ mediaId: image.mediaId }, t0)).toEqual({
      status: "done",
      ended: 1,
    });
    const marked = await pendingMark(image.assetId);
    await publication.reconcile(t0, true, 500);
    expect(await queued(image.assetId)).toEqual(["withdraw_media"]);
    // A normal mark brought it in: the blocks of a still-public image.
    expect(marked).toEqual({ reason: "rendition", urgent: false });
    await runJobs(image.assetId);
    expect(await liveBlocks(image.assetId)).toBe(0);

    // A new limit ends the active master, so it marks the asset too.
    const limited = await catalogImage();
    await attached(limited);
    await clearMarks();
    expect(
      (await masters.setLimit(limited.mediaId, 5500, "owner", t0)).status,
    ).toBe("done");
    expect(await pendingMark(limited.assetId)).toEqual({
      reason: "rendition",
      urgent: false,
    });

    // So does a re-attach that ends a master still active on the asset of
    // an image replaced in Admin (the projection names a new pair).
    const replaced = await catalogImage();
    const previous = await attached(replaced);
    await setup.query("DELETE FROM public.catalog_media WHERE media_id=$1", [
      replaced.mediaId,
    ]);
    await setup.query(
      "UPDATE community.catalog_media_assets SET unreferenced_since=$2 WHERE id=$1",
      [replaced.assetId, t0],
    );
    const replacement = await catalogImage({ mediaId: replaced.mediaId });
    await clearMarks();
    expect(
      await masters.attach(
        attachInput(replacement, {
          source: { kind: "existing", masterId: previous.masterId! },
        }),
        t0,
      ),
    ).toMatchObject({ status: "done" });
    expect(
      (
        await setup.query(
          "SELECT end_reason FROM community.catalog_display_masters WHERE id=$1",
          [previous.masterId],
        )
      ).rows[0],
    ).toEqual({ end_reason: "reattached" });
    expect(await pendingMark(replaced.assetId)).toEqual({
      reason: "rendition",
      urgent: false,
    });
  });

  /*
   * Self-masters (catalog-deep-zoom-self-master-v1) change a block set only
   * through the same writes: a recorded set, a new limit, a detach and a
   * re-attach. Each brings the asset into a pass that plans no sweep asset.
   */
  /** A published 9504 x 6336 `editorial/` original (viewer 4096) and the
   * attach of its own approved bytes as its master: a self-master. */
  const selfOriginal = async (
    options: Parameters<typeof catalogImage>[0] = {},
  ) => {
    const image = await catalogImage({
      width: 9504,
      height: 6336,
      viewerLong: 4096,
      ...options,
    });
    const self: Partial<CatalogMasterAttach> = {
      masterSha256: image.approvedSha256,
      header: { contentType: "image/jpeg", width: 9504, height: 6336 },
    };
    return { image, self };
  };
  /** Records the cells of a master's set as one block job would. */
  const recordCells = (
    image: CatalogImage,
    master: { readonly masterId: string | null },
    frame: { readonly width: number; readonly height: number },
    cells: readonly number[],
  ) =>
    works.recordCatalogBlocks(
      image.assetId,
      {
        masterId: master.masterId!,
        blocks: cells.map((cell) => {
          const rect = catalogBlockCell(frame.width, frame.height, cell);
          const key = blobKey();
          return {
            storageKey: key,
            byteSize: 250_000,
            sha256: sha(key),
            cell,
            recipeVersion: 1,
            recipeDigest: "3333333333333333",
            contentType: "image/jpeg" as const,
            width: rect.width,
            height: rect.height,
          };
        }),
      },
      t0,
    );
  /** Cells `from` to `to`, inclusive. */
  const cellRange = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, index) => from + index);

  it("publishes a self-master's recorded set and withdraws it after a new limit and after a detach, each in a pass that plans no sweep asset", async () => {
    const { image, self } = await selfOriginal();
    const { master } = await servedWithMaster(image, self);
    const frame = { width: master.frameWidth, height: master.frameHeight };
    expect(frame).toEqual({ width: 8192, height: 5461 });
    // The last two rows of the 8 x 6 grid, its edge cells included.
    expect(await recordCells(image, master, frame, cellRange(32, 47))).toEqual({
      status: "recorded",
    });
    let marked = await pendingMark(image.assetId);
    await publication.reconcile(t0, true, 500);
    expect(await queued(image.assetId)).toContain("publish_media");
    expect(marked).toEqual({ reason: "rendition", urgent: false });
    await runJobs(image.assetId);
    expect(await liveBlocks(image.assetId)).toBe(16);

    // A new limit ends the self-master: its blocks leave the plan.
    await clearMarks();
    const limited = await masters.setLimit(image.mediaId, 6144, "owner", t0);
    expect(limited).toMatchObject({
      status: "done",
      frameWidth: 6144,
      frameHeight: 4096,
      cells: 24,
    });
    marked = await pendingMark(image.assetId);
    await publication.reconcile(t0, true, 500);
    expect(await queued(image.assetId)).toEqual(["withdraw_media"]);
    expect(marked).toEqual({ reason: "rendition", urgent: false });
    await runJobs(image.assetId);
    expect(await liveBlocks(image.assetId)).toBe(0);

    // The limited set is recorded and published, then detached.
    const limitedFrame = { width: 6144, height: 4096 };
    await clearMarks();
    expect(
      await recordCells(
        image,
        limited as { readonly masterId: string },
        limitedFrame,
        cellRange(0, 15),
      ),
    ).toEqual({ status: "recorded" });
    await publication.reconcile(t0, true, 500);
    await runJobs(image.assetId);
    expect(await liveBlocks(image.assetId)).toBe(16);
    await clearMarks();
    expect(await masters.detach({ mediaId: image.mediaId }, t0)).toEqual({
      status: "done",
      ended: 1,
    });
    marked = await pendingMark(image.assetId);
    await publication.reconcile(t0, true, 500);
    expect(await queued(image.assetId)).toEqual(["withdraw_media"]);
    expect(marked).toEqual({ reason: "rendition", urgent: false });
    await runJobs(image.assetId);
    expect(await liveBlocks(image.assetId)).toBe(0);
  });

  it("withdraws the published blocks of a self-master re-attached to its image's replacement in the next pass", async () => {
    const { image, self } = await selfOriginal();
    const { master } = await servedWithMaster(image, self);
    const frame = { width: master.frameWidth, height: master.frameHeight };
    expect(await recordCells(image, master, frame, cellRange(0, 15))).toEqual({
      status: "recorded",
    });
    await publication.reconcile(t0, true, 500);
    await runJobs(image.assetId);
    expect(await liveBlocks(image.assetId)).toBe(16);
    // The same original moves to another record in Admin: the projection
    // names a new pair of the media id, and the old asset is unreferenced
    // (set here without the sync's own mark).
    const replacement = await catalogImage({
      mediaId: image.mediaId,
      approvedSha256: image.approvedSha256,
      width: 9504,
      height: 6336,
      viewerLong: 4096,
    });
    await setup.query(
      "DELETE FROM public.catalog_media WHERE media_id=$1 AND object_key=$2",
      [image.mediaId, image.objectKey],
    );
    await setup.query(
      "UPDATE community.catalog_media_assets SET unreferenced_since=$2 WHERE id=$1",
      [image.assetId, t0],
    );
    await clearMarks();
    // Still its own master on the replacement: the re-attach ends the
    // master still active on the old asset and marks that asset.
    expect(
      await masters.attach(
        attachInput(replacement, {
          ...self,
          source: { kind: "existing", masterId: master.masterId! },
        }),
        t0,
      ),
    ).toMatchObject({ status: "done", frameWidth: 8192, frameHeight: 5461 });
    expect(
      (
        await setup.query(
          "SELECT end_reason FROM community.catalog_display_masters WHERE id=$1",
          [master.masterId],
        )
      ).rows[0],
    ).toEqual({ end_reason: "reattached" });
    const marked = await pendingMark(image.assetId);
    await publication.reconcile(t0, true, 500);
    expect(await queued(image.assetId)).toEqual(["withdraw_media"]);
    expect(marked).toEqual({ reason: "rendition", urgent: false });
    await runJobs(image.assetId);
    expect(await liveBlocks(image.assetId)).toBe(0);
  });
});
