import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { AuthorCommunityService } from "@moya/api";
import {
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import {
  PostgresCommunityDiscoveryAdapter,
  runCommunityMigrations,
} from "@moya/community-postgres";
import { timelineSchema } from "@moya/contracts/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assertSyntheticTestDatabaseUrl,
  requireSyntheticTestDatabaseUrl,
} from "./synthetic-test-database.js";

import type {
  AuthorCommunityPort,
  CatalogPublicationPort,
  StorageUrlResolver,
} from "@moya/api";

/*
 * home-timeline-v1 (Issue #384) on a dedicated synthetic database with its own
 * App and public read roles, so the read runs with exactly the named grants and
 * no other suite meets its rows: the migration's checks and indexes, the App
 * role's read-only grant, the read over both connections (linked published,
 * linked unpublished, unlinked, ordering) and the import's replacement. The
 * published Catalog relations are stand-in tables. Content is synthetic.
 */

type Pool = ReturnType<typeof createPostgresPool>;

interface ImportScript {
  applyImport(pool: Pool, entries: readonly ImportEntry[]): Promise<void>;
  TIMELINE_MIGRATION_ID: string;
}
interface ImportEntry {
  readonly id: string;
  readonly title: string;
  readonly fullTitle: string;
  readonly startYear: number;
  readonly endYear: number;
  readonly precision: string;
  readonly dateLabel: string | null;
  readonly onAxis: boolean;
  readonly chapter: string;
  readonly polity: string | null;
  readonly disputed: boolean;
  readonly groupId: string | null;
  readonly groupTitle: string | null;
  readonly province: string | null;
  readonly holder: string | null;
  readonly catalogId: string | null;
  readonly position: number;
}

const root = fileURLToPath(new URL("../../../", import.meta.url));
const targetUrl = requireSyntheticTestDatabaseUrl();
const guard = (await import(
  new URL("../../../scripts/disposable-test-target.mjs", import.meta.url).href
)) as {
  disposableTestTargetProbeSql: string;
  assertDisposableTestTarget(rows: unknown, database: string): string;
};
const importScript = (await import(
  new URL("../../../scripts/import-timeline.mjs", import.meta.url).href
)) as ImportScript;

const poolFor = (url: string) =>
  createPostgresPool(parsePostgresConfig({ DATABASE_URL: url }));
const administration = poolFor(targetUrl);
const SLOW = 120_000;
const hex = (bytes = 16) => randomBytes(bytes).toString("hex");

const suffix = hex(6);
const database = `timeline_${suffix}_synthetic_test`;
const appRole = `timeline_app_${suffix}`;
const publicRole = `timeline_pub_${suffix}`;
let setup: Pool;
let app: Pool;
let publicRead: Pool;
let created = { database: false, app: false, public: false };

const runtimeGrant = async () =>
  (
    await readFile(
      `${root}/infra/development/work-publishing/grant-runtime.sql`,
      "utf8",
    )
  ).replaceAll(':"app_role"', `"${appRole}"`);

beforeAll(async () => {
  guard.assertDisposableTestTarget(
    (await administration.query(guard.disposableTestTargetProbeSql)).rows,
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
  await setup.query(await runtimeGrant());
  await setup.query(
    (
      await readFile(
        `${root}/infra/development/catalog-media/grant-public-read.sql`,
        "utf8",
      )
    ).replaceAll(':"public_read_role"', `"${publicRole}"`),
  );
  await setup.query(
    `GRANT SELECT ON public.catalog_entries, public.catalog_discovery, public.catalog_media TO "${publicRole}"`,
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

const entry = (
  id: string,
  overrides: Partial<ImportEntry> = {},
): ImportEntry => ({
  id,
  title: `合成${id}`,
  fullTitle: `合成朝合成${id}`,
  startYear: 618,
  endYear: 618,
  precision: "year",
  dateLabel: null,
  onAxis: true,
  chapter: "唐",
  polity: null,
  disputed: false,
  groupId: null,
  groupTitle: null,
  province: null,
  holder: null,
  catalogId: null,
  position: 0,
  ...overrides,
});
const code = async (attempt: Promise<unknown>) =>
  attempt.then(
    () => "committed",
    (error: { readonly code?: string }) => error.code,
  );
const storedIds = async () =>
  (
    await setup.query<{ entry_id: string }>(
      "SELECT entry_id FROM community.timeline_entries ORDER BY entry_id",
    )
  ).rows.map(({ entry_id }) => entry_id);

describe("timeline migration", () => {
  it("records the migration in the ledger the import checks", async () => {
    expect(
      (
        await setup.query(
          "SELECT migration_id FROM community.schema_migrations WHERE migration_id=$1",
          [importScript.TIMELINE_MIGRATION_ID],
        )
      ).rows,
    ).toHaveLength(1);
  });

  it("creates the unique link and the read order indexes", async () => {
    const definitions = (
      await setup.query<{ indexdef: string }>(
        "SELECT indexdef FROM pg_indexes WHERE schemaname='community' AND tablename='timeline_entries' AND indexname<>'timeline_entries_pkey' ORDER BY indexname",
      )
    ).rows.map(({ indexdef }) => indexdef);
    expect(definitions).toHaveLength(2);
    expect(definitions[0]).toMatch(
      /^CREATE UNIQUE INDEX timeline_entries_catalog_id_unique .*\(catalog_id\) WHERE \(catalog_id IS NOT NULL\)$/u,
    );
    expect(definitions[1]).toMatch(
      /timeline_entries_order .*\(start_year, "?position"?, entry_id\)$/u,
    );
  });

  it.each([
    ["year 0", { startYear: 0, endYear: 1 }],
    ["an end before the start", { startYear: 700, endYear: 650 }],
    ["an unknown precision", { precision: "decade" }],
    ["an unknown chapter", { chapter: "未知" }],
    ["a group id without a title", { groupId: "group-a" }],
    ["a group title without an id", { groupTitle: "合成组" }],
    ["an invalid id", { id: "Not Valid" }],
    ["a blank title", { title: "" }],
    ["a padded title", { title: " 合成 " }],
    ["a negative position", { position: -1 }],
  ] satisfies readonly [string, Partial<ImportEntry>][])(
    "refuses %s",
    async (_name, overrides) => {
      await expect(
        code(importScript.applyImport(setup, [entry("check", overrides)])),
      ).resolves.toBe("23514");
    },
    SLOW,
  );

  it("refuses a second row linking one Catalog record", async () => {
    await expect(
      code(
        importScript.applyImport(setup, [
          entry("first", { catalogId: "catalog-one" }),
          entry("second", { catalogId: "catalog-one" }),
        ]),
      ),
    ).resolves.toBe("23505");
  });
});

describe("timeline grants", () => {
  it("gives the App role reads only, idempotently, and the public role nothing", async () => {
    const acl = async () =>
      (
        await setup.query(
          "SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee=$1 AND table_schema='community' AND table_name='timeline_entries' ORDER BY 1",
          [appRole],
        )
      ).rows;
    expect(await acl()).toEqual([{ privilege_type: "SELECT" }]);
    await setup.query(await runtimeGrant());
    expect(await acl()).toEqual([{ privilege_type: "SELECT" }]);
    for (const write of [
      "INSERT INTO community.timeline_entries(entry_id) VALUES('app-write')",
      "UPDATE community.timeline_entries SET title='改写'",
      "DELETE FROM community.timeline_entries",
      "TRUNCATE community.timeline_entries",
    ])
      await expect(code(app.query(write))).resolves.toBe("42501");
    await expect(
      code(publicRead.query("SELECT 1 FROM community.timeline_entries")),
    ).resolves.toBe("42501");
  });
});

describe("timeline read and import", () => {
  const published = `catalog-${hex(8)}`;
  const textOnly = `catalog-${hex(8)}`;
  const unpublished = `catalog-${hex(8)}`;
  const mediaId = `media-${hex(8)}`;
  const objectKey = `display/v1/media_${hex(16)}/${hex(32)}.webp`;
  const adapter = () =>
    new PostgresCommunityDiscoveryAdapter(app, { catalogPool: publicRead });

  beforeAll(async () => {
    await setup.query(
      "INSERT INTO public.catalog_discovery(catalog_id,kind,title,aliases,first_published_at,filter_metadata) VALUES($1,'inscription','合成已发布',ARRAY[]::varchar[],NULL,'{}'::jsonb),($2,'inscription','合成无图',ARRAY[]::varchar[],NULL,'{}'::jsonb)",
      [published, textOnly],
    );
    await setup.query(
      "INSERT INTO public.catalog_media(catalog_id,media_id,object_key,width,height,is_representative,position) VALUES($1,$2,$3,1200,800,true,0)",
      [published, mediaId, objectKey],
    );
    await importScript.applyImport(setup, [
      entry("year-later", { startYear: 650, endYear: 650 }),
      entry("same-year-b", { startYear: -221, endYear: -221, position: 1 }),
      entry("same-year-a", { startYear: -221, endYear: -221, position: 1 }),
      entry("same-year-first", {
        startYear: -221,
        endYear: -221,
        position: 0,
        chapter: "秦",
      }),
      entry("shelf-tang", {
        onAxis: false,
        precision: "dynasty",
        endYear: 907,
        startYear: 618,
        position: 5,
      }),
      entry("linked-published", {
        startYear: 700,
        endYear: 700,
        catalogId: published,
      }),
      entry("linked-text-only", {
        startYear: 701,
        endYear: 701,
        catalogId: textOnly,
      }),
      entry("linked-unpublished", {
        startYear: 702,
        endYear: 702,
        catalogId: unpublished,
      }),
    ]);
  }, SLOW);

  it("returns rows ordered by start year, position and id", async () => {
    const { entries } = await adapter().timeline();
    expect(entries.map(({ id }) => id)).toEqual([
      "same-year-first",
      "same-year-a",
      "same-year-b",
      "shelf-tang",
      "year-later",
      "linked-published",
      "linked-text-only",
      "linked-unpublished",
    ]);
  });

  it("keeps a link only for a published record and resolves its image", async () => {
    const resolver: StorageUrlResolver = {
      resolveMany: async (locators) =>
        new Map(
          locators.map(({ mediaId: id }) => [
            id,
            "https://media.example.invalid/approved.webp",
          ]),
        ),
    };
    const timeline = timelineSchema.parse(
      await new AuthorCommunityService(
        {} as AuthorCommunityPort,
        {} as CatalogPublicationPort,
        undefined,
        adapter(),
        resolver,
      ).timeline(),
    );
    const byId = new Map(timeline.entries.map((item) => [item.id, item]));
    expect(byId.get("linked-published")).toMatchObject({
      catalogId: published,
      media: {
        id: mediaId,
        kind: "image",
        src: "https://media.example.invalid/approved.webp",
        alt: "合成朝合成linked-published",
        width: 1200,
        height: 800,
      },
    });
    expect(byId.get("linked-text-only")).toMatchObject({
      catalogId: textOnly,
      media: null,
    });
    expect(byId.get("linked-unpublished")).toMatchObject({
      catalogId: null,
      media: null,
    });
    expect(byId.get("year-later")).toMatchObject({
      catalogId: null,
      media: null,
    });
  });

  it("withdrawing a record drops its link on the next read", async () => {
    await setup.query(
      "DELETE FROM public.catalog_discovery WHERE catalog_id=$1",
      [textOnly],
    );
    const { entries } = await adapter().timeline();
    expect(entries.find(({ id }) => id === "linked-text-only")).toMatchObject({
      catalogId: null,
    });
  });

  it("replaces all rows at once, and a failed import changes nothing", async () => {
    const before = await storedIds();
    await expect(
      code(
        importScript.applyImport(setup, [
          entry("replaced"),
          entry("broken", { startYear: 0, endYear: 1 }),
        ]),
      ),
    ).resolves.toBe("23514");
    expect(await storedIds()).toEqual(before);
    await importScript.applyImport(setup, [entry("replaced")]);
    expect(await storedIds()).toEqual(["replaced"]);
  });
});
