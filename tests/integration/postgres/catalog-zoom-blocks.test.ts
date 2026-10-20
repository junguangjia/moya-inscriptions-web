import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { CommunityConflictError } from "@moya/api";
import {
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import {
  CATALOG_BLOCK_GUARD_SQL,
  PostgresCatalogDisplayMasterAdapter,
  PostgresMediaPublicationAdapter,
  PostgresPublishingOperatorAdapter,
  PostgresWorkPublishingAdapter,
  catalogBlockCell,
  catalogBlockGrid,
  resolveCatalogRenditionRead,
  runCommunityMigrations,
} from "@moya/community-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assertSyntheticTestDatabaseUrl,
  requireSyntheticTestDatabaseUrl,
} from "./synthetic-test-database.js";

import type { CatalogMasterAttach, PublishingJobLease } from "@moya/api";

/*
 * catalog-deep-zoom-v1 (Issue #295) on a dedicated synthetic database with
 * its own App and public read roles, so every store command runs with exactly
 * the named grants (criterion 3a) and no other suite meets its rows:
 * master custody and CHECKs (1–3), scheduling and the operator guard (5),
 * the block desired set, withdrawal budget and sweep-once (6–8), the
 * rollback guard (9), the Development relay lookup (14) and the live storage
 * bounds (25). Content is synthetic; no store or cloud I/O.
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
    (
      await readFile(
        `${root}/infra/development/catalog-media/grant-public-read.sql`,
        "utf8",
      )
    ).replaceAll(':"public_read_role"', `"${publicRole}"`),
  );
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

/** A published, rendered Catalog image (thumb, cover, display and viewer). */
const catalogImage = async (
  options: {
    readonly width?: number;
    readonly height?: number;
    readonly catalogId?: string;
    readonly published?: boolean;
  } = {},
): Promise<CatalogImage> => {
  const width = options.width ?? 4096;
  const height = options.height ?? 2731;
  const mediaId = `media-${hex(8)}`;
  const catalogId = options.catalogId ?? `catalog-${hex(8)}`;
  const approvedSha256 = sha(mediaId);
  const objectKey = `editorial/${sha(catalogId)}/${sha(`${mediaId}:orig`)}-${approvedSha256}.jpg`;
  const assetId = `catalog-asset-${md5(`${mediaId}:${objectKey}`)}`;
  if (options.published !== false)
    await setup.query(
      "INSERT INTO public.catalog_media(catalog_id,media_id,object_key,width,height,is_representative,position) VALUES($1,$2,$3,$4,$5,false,0)",
      [catalogId, mediaId, objectKey, width, height],
    );
  await setup.query(
    `INSERT INTO community.catalog_media_assets(id,media_id,source_object_key,source_sha256,source_width,source_height,source_content_type,master_sha256,master_width,master_height,state,created_at,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,'image/jpeg',$4,$5,$6,'ready',$7,$7)`,
    [assetId, mediaId, objectKey, approvedSha256, width, height, t0],
  );
  const scaled = (long: number) =>
    width >= height
      ? [long, Math.round((height * long) / width)]
      : [Math.round((width * long) / height), long];
  for (const [role, long] of [
    ["thumb", 480],
    ["cover", 720],
    ["display", 2048],
    ["viewer", Math.max(width, height)],
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

const masters = new PostgresCatalogDisplayMasterAdapter(
  // Bound lazily: the App pool exists only after beforeAll.
  new Proxy({} as Pool, {
    get: (_target, property) => Reflect.get(app, property, app),
  }),
);

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
    expect(
      codeOf(
        await masters.attach(
          attachInput(second, {
            source: { kind: "dry_run", byteSize: 11 * 1024 ** 3 },
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
    new Proxy({} as Pool, {
      get: (_target, property) => Reflect.get(app, property, app),
    }),
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
    new Proxy({} as Pool, {
      get: (_target, property) => Reflect.get(app, property, app),
    }),
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
