import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  assertPostgresStartupReady,
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import { PostgresCommunityDiscoveryAdapter } from "@moya/community-postgres";
import { SEARCH_NORMALIZATION_VERSION } from "@moya/search";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assertSyntheticTestDatabaseUrl,
  requireSyntheticTestDatabaseUrl,
} from "./synthetic-test-database.js";

/*
 * catalog-delivery-release-hardening-v1 (N1). Since #312 the Backend's
 * discovery (browse, collection, card, filter options) reads the published
 * Payload view `public.catalog_discovery` through the public read role
 * (`DATABASE_URL`). This suite applies the actual
 * `infra/development/grant-public-read.sql` to a fresh non-owner role on a
 * dedicated synthetic database whose published relations are stand-in views
 * over a private table, and proves: the script grants SELECT on the view and
 * nothing beneath it or any write; without that grant the discovery read
 * fails with 42501 and Backend startup stops with a clear message; with it
 * both succeed. Content is synthetic.
 */

type Pool = ReturnType<typeof createPostgresPool>;

const root = fileURLToPath(new URL("../../../", import.meta.url));
const targetUrl = requireSyntheticTestDatabaseUrl();
const guard = (await import(
  new URL("../../../scripts/disposable-test-target.mjs", import.meta.url).href
)) as {
  disposableTestTargetProbeSql: string;
  assertDisposableTestTarget(rows: unknown, database: string): string;
};

const poolFor = (url: string) =>
  createPostgresPool(parsePostgresConfig({ DATABASE_URL: url }));
const SLOW = 120_000;
const suffix = randomBytes(6).toString("hex");
const database = `cdrh_discovery_${suffix}_synthetic_test`;
const publicRole = `cdrh_pub_${suffix}`;
const administration = poolFor(targetUrl);
let setup: Pool;
let publicRead: Pool;
let created = { database: false, role: false };

/** The actual grant file for this role, as `psql -v public_read_role=…` runs it. */
const grantSql = async () =>
  (await readFile(`${root}/infra/development/grant-public-read.sql`, "utf8"))
    .replace(/\\if :\{\?public_read_role\}[\s\S]*?\\endif/u, "")
    .replaceAll(':"public_read_role"', `"${publicRole}"`);

const published = `catalog-${randomBytes(8).toString("hex")}`;
const draft = `catalog-${randomBytes(8).toString("hex")}`;

beforeAll(async () => {
  guard.assertDisposableTestTarget(
    (await administration.query(guard.disposableTestTargetProbeSql)).rows,
    assertSyntheticTestDatabaseUrl(targetUrl),
  );
  const password = randomBytes(32).toString("hex");
  await administration.query(
    `CREATE ROLE ${publicRole} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`,
  );
  created = { ...created, role: true };
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
  // Stand-ins for the Payload published relations the grant names: views
  // (the six Catalog views startup requires) over a private table that no
  // grant names, plus the published-only discovery view of #312's shape.
  await setup.query(`
    CREATE TABLE public.catalogs(
      catalog_id text PRIMARY KEY, kind text NOT NULL, title text NOT NULL,
      _status text NOT NULL, filter_metadata jsonb NOT NULL
    );
    CREATE VIEW public.catalog_entries AS
      SELECT catalog_id, NULL::text AS province, NULL::text AS province_state
      FROM public.catalogs WHERE _status = 'published';
    CREATE VIEW public.catalog_aliases AS
      SELECT catalog_id, NULL::text AS alias FROM public.catalogs WHERE false;
    CREATE VIEW public.catalog_contributors AS
      SELECT catalog_id, NULL::text AS name FROM public.catalogs WHERE false;
    CREATE VIEW public.catalog_source_citations AS
      SELECT catalog_id, NULL::text AS citation FROM public.catalogs WHERE false;
    CREATE VIEW public.catalog_source_citation_scopes AS
      SELECT catalog_id, NULL::text AS scope FROM public.catalogs WHERE false;
    CREATE VIEW public.catalog_media AS
      SELECT catalog_id, NULL::text AS media_id, NULL::text AS object_key
      FROM public.catalogs WHERE false;
    CREATE TABLE public.catalog_search_documents(
      catalog_id text PRIMARY KEY, normalization_version text NOT NULL
    );
    CREATE TABLE public.article_entries(article_id text PRIMARY KEY);
    CREATE TABLE public.article_sections(article_id text);
    CREATE TABLE public.article_citations(article_id text);
    CREATE TABLE public.article_collection_entries(collection_id text);
    CREATE TABLE public.article_collection_members(collection_id text);
    CREATE TABLE public.payload_migrations(
      id serial PRIMARY KEY, name text NOT NULL, private_probe text
    );
    INSERT INTO public.payload_migrations(name) VALUES
      ('20260908_031500_published_views'), ('20260908_120000_published_search');
    CREATE VIEW public.catalog_discovery AS
      SELECT catalog_id, kind, title, ARRAY[]::varchar[] AS aliases,
        NULL::timestamptz AS first_published_at, filter_metadata
      FROM public.catalogs WHERE _status = 'published';
  `);
  const filters = (dynasty: string) =>
    JSON.stringify({
      dynasty: { state: "VALUE", values: [dynasty] },
      textAuthor: { state: "UNKNOWN", values: [] },
      calligrapher: { state: "UNSUPPLIED", values: [] },
      originalRegion: { state: "UNSUPPLIED", values: [] },
      script: { state: "UNSUPPLIED", values: [] },
    });
  await setup.query(
    "INSERT INTO public.catalogs VALUES ($1,'inscription','合成已发布','published',$3::jsonb),($2,'inscription','合成草稿','draft',$4::jsonb)",
    [published, draft, filters("合成已发布朝代"), filters("合成草稿朝代")],
  );
  await setup.query(
    "INSERT INTO public.catalog_search_documents VALUES ($1,$2)",
    [published, SEARCH_NORMALIZATION_VERSION],
  );
  publicRead = poolFor(url({ role: publicRole, password }));
}, SLOW);

afterAll(async () => {
  await publicRead?.end();
  await setup?.end();
  if (created.database)
    await administration.query(
      `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`,
    );
  if (created.role)
    await administration.query(`DROP ROLE IF EXISTS ${publicRole}`);
  await administration.end();
}, SLOW);

const discovery = () =>
  new PostgresCommunityDiscoveryAdapter(setup, { catalogPool: publicRead });
const startup = (discoveryOn: boolean) =>
  assertPostgresStartupReady(publicRead, "payload", {
    renditions: false,
    discovery: discoveryOn,
  });

describe("public read grant for the Catalog discovery view", () => {
  it("names the view, never its table, a wildcard or a write", async () => {
    const file = (await grantSql())
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(file).toMatch(
      /GRANT SELECT ON TABLE public\.catalog_discovery TO "cdrh_pub_[0-9a-f]+";/u,
    );
    expect(file).not.toMatch(/ALL TABLES|INSERT|UPDATE|DELETE|TRUNCATE/u);
    expect(file).not.toMatch(/public\.catalogs\b|catalog_first_publications/u);
  });

  it(
    "without the grant discovery fails with 42501 and startup stops clearly",
    async () => {
      // The grant set before this task: the same file without the view.
      await setup.query(await grantSql());
      await setup.query(
        `REVOKE SELECT ON public.catalog_discovery FROM "${publicRole}"`,
      );
      // 0a4ab863 started cleanly in this state, then failed every read.
      await expect(startup(false)).resolves.toBeUndefined();
      await expect(discovery().filterOptions()).rejects.toMatchObject({
        code: "42501",
      });
      await expect(startup(true)).rejects.toThrow(
        /^Catalog discovery view is not readable: grant SELECT on public\.catalog_discovery to the public read role$/,
      );
    },
    SLOW,
  );

  it(
    "with the grant discovery reads published rows only and startup passes",
    async () => {
      await setup.query(await grantSql());
      // Idempotent: reapplying changes nothing.
      const acl = async () =>
        (
          await setup.query(
            "SELECT table_name, privilege_type FROM information_schema.role_table_grants WHERE grantee=$1 ORDER BY 1,2",
            [publicRole],
          )
        ).rows;
      const before = await acl();
      await setup.query(await grantSql());
      expect(await acl()).toEqual(before);
      expect(
        before.filter(({ table_name }) => table_name === "catalog_discovery"),
      ).toEqual([
        { table_name: "catalog_discovery", privilege_type: "SELECT" },
      ]);
      expect(
        (
          await publicRead.query<{ read: boolean; write: boolean }>(
            `SELECT has_table_privilege(current_user, 'public.catalog_discovery', 'SELECT') AS read,
               has_table_privilege(current_user, 'public.catalog_discovery', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS write`,
          )
        ).rows,
      ).toEqual([{ read: true, write: false }]);
      // The view only: the private table beneath it stays unreadable.
      await expect(
        publicRead.query("SELECT 1 FROM public.catalogs LIMIT 1"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(startup(true)).resolves.toBeUndefined();
      const options = await discovery().filterOptions();
      expect(options.dynasty).toEqual({
        values: ["合成已发布朝代"],
        unknown: 0,
        unsupplied: 0,
      });
      expect(options.textAuthor).toMatchObject({ unknown: 1 });
    },
    SLOW,
  );
});
