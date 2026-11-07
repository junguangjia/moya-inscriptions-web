import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  AuthorCommunityService,
  CommunityConflictError,
  CommunityIdempotencyConflictError,
  CommunityInputError,
  CommunityNamedConflictError,
  CommunityNotFoundError,
} from "@moya/api";
import {
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import {
  PostgresCommunityDiscoveryAdapter,
  PostgresTimelineOperatorAdapter,
  runCommunityMigrations,
} from "@moya/community-postgres";
import {
  TIMELINE_ENTRIES_MAXIMUM,
  TIMELINE_RESPONSE_BYTES_MAXIMUM,
  estimateTimelineResponseBytes,
  timelineSchema,
} from "@moya/contracts/schemas";
import {
  createTimelineEntryCommandSchema,
  updateTimelineEntryCommandSchema,
} from "@moya/contracts/internal/community-operator";
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
 * home-timeline-v1 (Issue #384 r3) on a dedicated synthetic database with its
 * own App and public read roles, so reads and writes run with exactly the named
 * grants and no other suite meets its rows: the migration's checks and indexes,
 * the App role's column grants, the public read over both connections (linked
 * published, linked unpublished, unlinked, ordering, hidden rows left out), the
 * operator writes (receipts, versions, named refusals, the whole-set limits)
 * and the guarded import. The published Catalog relations are stand-in tables.
 * Content is synthetic.
 */

type Pool = ReturnType<typeof createPostgresPool>;

interface ImportCounts {
  readonly entries: number;
  readonly replaced: number;
  readonly operatorEdited: number;
  readonly hidden: number;
}
interface ImportScript {
  applyImport(
    pool: Pool,
    entries: readonly ImportEntry[],
    options?: { readonly replaceOperatorEdits?: boolean },
  ): Promise<ImportCounts>;
  CONTENT_OPERATOR_LOCK_SQL: string;
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

  it("starts a row at version 1 by the import, and refuses other actors and versions", async () => {
    const insert = (columns: string, values: string) =>
      code(
        setup.query(
          `INSERT INTO community.timeline_entries(entry_id,title,full_title,start_year,end_year,precision,on_axis,chapter,disputed,position${columns})
           VALUES('actor-check','合成','合成',618,618,'year',true,'唐',false,0${values})`,
        ),
      );
    for (const [columns, values] of [
      [",version", ",0"],
      [",created_by", ",'someone'"],
      [",updated_by", ",'ai'"],
    ] as const)
      await expect(insert(columns, values)).resolves.toBe("23514");
    try {
      await expect(insert("", "")).resolves.toBe("committed");
      expect(
        (
          await setup.query(
            "SELECT version,hidden_at,created_by,updated_by,created_at=updated_at AS same FROM community.timeline_entries WHERE entry_id='actor-check'",
          )
        ).rows,
      ).toEqual([
        {
          version: 1,
          hidden_at: null,
          created_by: "import",
          updated_by: "import",
          same: true,
        },
      ]);
    } finally {
      await setup.query(
        "DELETE FROM community.timeline_entries WHERE entry_id='actor-check'",
      );
    }
  });
});

describe("timeline grants", () => {
  const tableLevel = async () =>
    (
      await setup.query<{ privilege_type: string }>(
        "SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee=$1 AND table_schema='community' AND table_name='timeline_entries' ORDER BY 1",
        [appRole],
      )
    ).rows.map(({ privilege_type }) => privilege_type);
  const columnLevel = async () =>
    (
      await setup.query<{ name: string; insert: boolean; update: boolean }>(
        `SELECT a.attname AS name,
           has_column_privilege($1, a.attrelid, a.attnum, 'INSERT') AS insert,
           has_column_privilege($1, a.attrelid, a.attnum, 'UPDATE') AS update
         FROM pg_attribute a
         WHERE a.attrelid='community.timeline_entries'::regclass AND a.attnum>0 AND NOT a.attisdropped
         ORDER BY a.attnum`,
        [appRole],
      )
    ).rows;
  const fixed = ["entry_id", "created_by", "created_at"];
  const expectRuntimeGrants = async () => {
    expect(await tableLevel()).toEqual(["SELECT"]);
    const columns = await columnLevel();
    expect(columns).toHaveLength(23);
    for (const { name, insert, update } of columns)
      expect({ name, insert, update }).toEqual({
        name,
        insert: true,
        update: !fixed.includes(name),
      });
  };

  it("gives the App role reads, column inserts and column updates, idempotently, and the public role nothing", async () => {
    await expectRuntimeGrants();
    await setup.query(await runtimeGrant());
    await expectRuntimeGrants();
    for (const write of [
      "UPDATE community.timeline_entries SET entry_id='renamed'",
      "UPDATE community.timeline_entries SET created_by='owner'",
      "UPDATE community.timeline_entries SET created_at=now()",
      "DELETE FROM community.timeline_entries",
      "TRUNCATE community.timeline_entries",
    ])
      await expect(code(app.query(write))).resolves.toBe("42501");
    await expect(
      code(publicRead.query("SELECT 1 FROM community.timeline_entries")),
    ).resolves.toBe("42501");
  });

  it("narrows an earlier table-level grant back to the columns", async () => {
    await setup.query(
      `GRANT INSERT, UPDATE ON community.timeline_entries TO "${appRole}"`,
    );
    expect(await tableLevel()).toEqual(["INSERT", "SELECT", "UPDATE"]);
    await setup.query(await runtimeGrant());
    await expectRuntimeGrants();
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

// The operator side: what the Backend's Owner and AI routes call.
const operator = () =>
  new PostgresTimelineOperatorAdapter(app, { catalogPool: publicRead });
const publicIds = async () =>
  (
    await new PostgresCommunityDiscoveryAdapter(app, {
      catalogPool: publicRead,
    }).timeline()
  ).entries.map(({ id }) => id);
/** A create command as the route parses it, from an import row without its position. */
const createOf = (row: ImportEntry, extra: Record<string, unknown> = {}) =>
  createTimelineEntryCommandSchema.parse({
    requestId: randomUUID(),
    ...row,
    position: undefined,
    ...extra,
  });
const updateOf = (fields: Record<string, unknown>) =>
  updateTimelineEntryCommandSchema.parse({
    requestId: randomUUID(),
    ...fields,
  });
const failure = async (attempt: Promise<unknown>) =>
  attempt.then(
    () => undefined,
    (error: unknown) => error,
  );
/** The named refusal of a write; anything else fails the expectation. */
const refusal = async (attempt: Promise<unknown>) => {
  const error = await failure(attempt);
  expect(error).toBeInstanceOf(CommunityNamedConflictError);
  return (error as CommunityNamedConflictError).refusal;
};
interface EventRow {
  readonly operator_label: string;
  readonly action: string;
  readonly content_id: string | null;
  readonly detail: { readonly command?: { readonly requestId: string } };
}
const timelineEvents = async () =>
  (
    await setup.query<EventRow>(
      "SELECT operator_label,action,content_id,detail FROM community.content_operator_events WHERE content_type='timeline_entry' ORDER BY occurred_at,id",
    )
  ).rows;
const receipts = async (label: string, requestId: string) =>
  (
    await setup.query(
      "SELECT 1 FROM community.content_operator_receipts WHERE operator_label=$1 AND request_id=$2",
      [label, requestId],
    )
  ).rowCount;

describe("timeline operator writes", () => {
  const published = `catalog-${hex(8)}`;
  const unpublished = `catalog-${hex(8)}`;

  beforeAll(async () => {
    await setup.query(
      "INSERT INTO public.catalog_discovery(catalog_id,kind,title,aliases,first_published_at,filter_metadata) VALUES($1,'inscription','合成已发布',ARRAY[]::varchar[],NULL,'{}'::jsonb)",
      [published],
    );
    await importScript.applyImport(
      setup,
      [
        entry("tang-a", { position: 0 }),
        entry("tang-b", { position: 1024 }),
        entry("tang-c", { position: 2048 }),
        entry("linked", { startYear: 700, endYear: 700, catalogId: published }),
        entry("linked-off", {
          startYear: 701,
          endYear: 701,
          catalogId: unpublished,
        }),
        entry("song", { startYear: 960, endYear: 960, chapter: "宋辽金夏" }),
      ],
      { replaceOperatorEdits: true },
    );
  }, SLOW);

  it("reads every row with its version, actors, visibility and link state", async () => {
    const rows = await operator().operatorTimelineEntries();
    expect(rows.map(({ id }) => id)).toEqual([
      "tang-a",
      "tang-b",
      "tang-c",
      "linked",
      "linked-off",
      "song",
    ]);
    expect(rows[0]).toMatchObject({
      title: "合成tang-a",
      position: 0,
      version: 1,
      hidden: false,
      createdBy: "import",
      updatedBy: "import",
      linkState: "unlinked",
    });
    const states = rows.map(({ linkState }) => linkState);
    expect(states.slice(3, 5)).toEqual(["published", "not_published"]);
    // Without a Catalog connection the App role reads the same projection.
    expect(
      (
        await new PostgresTimelineOperatorAdapter(app).operatorTimelineEntries()
      ).map(({ linkState }) => linkState),
    ).toEqual(states);
  });

  it("creates a row at the end of its year with one event and one receipt, and replays it", async () => {
    const before = (await timelineEvents()).length;
    const command = createOf(entry("tang-d"));
    const created = await operator().operatorCreateTimelineEntry(
      "ai-admin",
      command,
    );
    expect(created).toMatchObject({
      id: "tang-d",
      position: 3072,
      version: 1,
      hidden: false,
      createdBy: "ai-admin",
      updatedBy: "ai-admin",
      linkState: "unlinked",
    });
    const events = await timelineEvents();
    expect(events).toHaveLength(before + 1);
    expect(events.at(-1)).toMatchObject({
      operator_label: "ai-admin",
      action: "timeline.create",
      content_id: "tang-d",
      detail: { command: { requestId: command.requestId } },
    });
    expect(await receipts("ai-admin", command.requestId)).toBe(1);
    await expect(
      operator().operatorCreateTimelineEntry("ai-admin", command),
    ).resolves.toEqual({ ...created, replayed: true });
    expect(await timelineEvents()).toHaveLength(before + 1);
    expect(
      await failure(
        operator().operatorCreateTimelineEntry("ai-admin", {
          ...command,
          title: "合成改题",
        }),
      ),
    ).toBeInstanceOf(CommunityIdempotencyConflictError);
    // The Owner's answers carry no AI marks.
    const owners = createOf(
      entry("year-empty", {
        startYear: 1001,
        endYear: 1001,
        chapter: "宋辽金夏",
      }),
    );
    const first = await operator().operatorCreateTimelineEntry("owner", owners);
    expect(first).toMatchObject({ position: 0, createdBy: "owner" });
    await expect(
      operator().operatorCreateTimelineEntry("owner", owners),
    ).resolves.toEqual(first);
  });

  it("refuses an existing id and a second link by name, writing nothing", async () => {
    const before = (await timelineEvents()).length;
    expect(
      await refusal(
        operator().operatorCreateTimelineEntry(
          "owner",
          createOf(entry("tang-a")),
        ),
      ),
    ).toBe("ENTRY_EXISTS");
    expect(
      await refusal(
        operator().operatorCreateTimelineEntry(
          "owner",
          createOf(entry("second-link", { catalogId: published })),
        ),
      ),
    ).toBe("CATALOG_ALREADY_LINKED");
    expect(
      await refusal(
        operator().operatorUpdateTimelineEntry(
          "ai-admin",
          "song",
          updateOf({ expectedVersion: 1, catalogId: published }),
        ),
      ),
    ).toBe("CATALOG_ALREADY_LINKED");
    expect(await timelineEvents()).toHaveLength(before);
    expect(await storedIds()).not.toContain("second-link");
  });

  it("updates against the version it read, and moves a row to the end of a new year", async () => {
    const edited = await operator().operatorUpdateTimelineEntry(
      "owner",
      "song",
      updateOf({ expectedVersion: 1, title: "合成改题" }),
    );
    expect(edited).toMatchObject({
      title: "合成改题",
      fullTitle: "合成朝合成song",
      version: 2,
      createdBy: "import",
      updatedBy: "owner",
    });
    expect(Date.parse(edited.updatedAt)).toBeGreaterThan(
      Date.parse(edited.createdAt),
    );
    const stale = await failure(
      operator().operatorUpdateTimelineEntry(
        "owner",
        "song",
        updateOf({ expectedVersion: 1, title: "合成再改" }),
      ),
    );
    expect(stale).toBeInstanceOf(CommunityConflictError);
    expect(stale).not.toBeInstanceOf(CommunityNamedConflictError);
    expect(
      await failure(
        operator().operatorUpdateTimelineEntry(
          "owner",
          "missing",
          updateOf({ expectedVersion: 1, title: "合成" }),
        ),
      ),
    ).toBeInstanceOf(CommunityNotFoundError);
    expect(
      await failure(
        operator().operatorUpdateTimelineEntry(
          "owner",
          "song",
          updateOf({ expectedVersion: 2 }),
        ),
      ),
    ).toBeInstanceOf(CommunityInputError);
    await expect(
      operator().operatorUpdateTimelineEntry(
        "owner",
        "song",
        updateOf({
          expectedVersion: 2,
          startYear: 618,
          endYear: 618,
          chapter: "唐",
        }),
      ),
    ).resolves.toMatchObject({ startYear: 618, position: 4096, version: 3 });
  });

  it("checks the row as it would be stored, so half a change is refused", async () => {
    expect(
      await refusal(
        operator().operatorUpdateTimelineEntry(
          "owner",
          "tang-a",
          updateOf({ expectedVersion: 1, startYear: 700 }),
        ),
      ),
    ).toBe("ENTRY_INVALID");
    expect(
      await refusal(
        operator().operatorUpdateTimelineEntry(
          "owner",
          "tang-a",
          updateOf({ expectedVersion: 1, groupId: "group-a" }),
        ),
      ),
    ).toBe("ENTRY_INVALID");
    await expect(
      operator().operatorUpdateTimelineEntry(
        "owner",
        "tang-a",
        updateOf({
          expectedVersion: 1,
          groupId: "group-a",
          groupTitle: "合成组",
        }),
      ),
    ).resolves.toMatchObject({
      groupId: "group-a",
      groupTitle: "合成组",
      version: 2,
    });
  });

  it("hides and shows a row, and the public read leaves a hidden row out", async () => {
    await expect(
      operator().operatorUpdateTimelineEntry(
        "ai-admin",
        "tang-b",
        updateOf({ expectedVersion: 1, hidden: true }),
      ),
    ).resolves.toMatchObject({ hidden: true, version: 2 });
    expect(await publicIds()).not.toContain("tang-b");
    expect(
      (await operator().operatorTimelineEntries()).find(
        ({ id }) => id === "tang-b",
      ),
    ).toMatchObject({ hidden: true, updatedBy: "ai-admin" });
    await expect(
      operator().operatorUpdateTimelineEntry(
        "ai-admin",
        "tang-b",
        updateOf({ expectedVersion: 2, hidden: false }),
      ),
    ).resolves.toMatchObject({ hidden: false, version: 3 });
    expect(await publicIds()).toContain("tang-b");
  });

  it("unlinks a record and links it to another row", async () => {
    await expect(
      operator().operatorUpdateTimelineEntry(
        "owner",
        "linked",
        updateOf({ expectedVersion: 1, catalogId: null }),
      ),
    ).resolves.toMatchObject({ catalogId: null, linkState: "unlinked" });
    await expect(
      operator().operatorUpdateTimelineEntry(
        "owner",
        "tang-c",
        updateOf({ expectedVersion: 1, catalogId: published }),
      ),
    ).resolves.toMatchObject({ catalogId: published, linkState: "published" });
  });

  it("reorders one start year at once under one receipt and one event", async () => {
    const year = (await operator().operatorTimelineEntries()).filter(
      ({ startYear }) => startYear === 618,
    );
    expect(year.map(({ id }) => id)).toEqual([
      "tang-a",
      "tang-b",
      "tang-c",
      "tang-d",
      "song",
    ]);
    const reversed = [...year].reverse();
    const command = {
      requestId: randomUUID(),
      startYear: 618,
      entries: reversed.map(({ id, version }) => ({
        id,
        expectedVersion: version,
      })),
    };
    const before = (await timelineEvents()).length;
    await expect(
      operator().operatorReorderTimeline("ai-admin", command),
    ).resolves.toEqual({ startYear: 618, count: 5 });
    const after = (await operator().operatorTimelineEntries()).filter(
      ({ startYear }) => startYear === 618,
    );
    expect(after.map(({ id }) => id)).toEqual(reversed.map(({ id }) => id));
    expect(after.map(({ position }) => position)).toEqual([
      0, 1024, 2048, 3072, 4096,
    ]);
    expect(after.map(({ version }) => version)).toEqual(
      reversed.map(({ version }) => version + 1),
    );
    expect(after.every(({ updatedBy }) => updatedBy === "ai-admin")).toBe(true);
    const events = await timelineEvents();
    expect(events).toHaveLength(before + 1);
    expect(events.at(-1)).toMatchObject({
      action: "timeline.reorder",
      content_id: null,
    });
    await expect(
      operator().operatorReorderTimeline("ai-admin", command),
    ).resolves.toEqual({ startYear: 618, count: 5, replayed: true });
    const current = after.map(({ id, version }) => ({
      id,
      expectedVersion: version,
    }));
    for (const entries of [
      current.slice(1),
      [...current, { id: "linked-off", expectedVersion: 1 }],
    ])
      expect(
        await refusal(
          operator().operatorReorderTimeline("owner", {
            requestId: randomUUID(),
            startYear: 618,
            entries,
          }),
        ),
      ).toBe("SET_CHANGED");
    const stale = await failure(
      operator().operatorReorderTimeline("owner", {
        ...command,
        requestId: randomUUID(),
      }),
    );
    expect(stale).toBeInstanceOf(CommunityConflictError);
    expect(stale).not.toBeInstanceOf(CommunityNamedConflictError);
    expect(await timelineEvents()).toHaveLength(before + 1);
  });

  it("refuses writes while another stored row fails the contract, until it is fixed", async () => {
    // 150 code points for the database, 300 UTF-16 units for the contract.
    await setup.query(
      "UPDATE community.timeline_entries SET title=$1 WHERE entry_id='linked-off'",
      ["\u{20000}".repeat(150)],
    );
    expect(
      (await operator().operatorTimelineEntries()).find(
        ({ id }) => id === "linked-off",
      )?.title,
    ).toHaveLength(300);
    const write = () =>
      operator().operatorUpdateTimelineEntry(
        "owner",
        "tang-a",
        updateOf({ expectedVersion: 3, dateLabel: "合成纪年" }),
      );
    expect(await refusal(write())).toBe("TIMELINE_INVALID");
    await expect(
      operator().operatorUpdateTimelineEntry(
        "owner",
        "linked-off",
        updateOf({ expectedVersion: 1, title: "合成修正" }),
      ),
    ).resolves.toMatchObject({ title: "合成修正", version: 2 });
    await expect(write()).resolves.toMatchObject({
      dateLabel: "合成纪年",
      version: 4,
    });
  });
});

describe("timeline whole-set limits", () => {
  it(
    "refuses a row past the maximum, and keeps every row",
    async () => {
      await importScript.applyImport(
        setup,
        Array.from({ length: TIMELINE_ENTRIES_MAXIMUM }, (_, index) =>
          entry(`row-${index}`, { position: index }),
        ),
        { replaceOperatorEdits: true },
      );
      expect(
        await refusal(
          operator().operatorCreateTimelineEntry(
            "owner",
            createOf(entry("one-more")),
          ),
        ),
      ).toBe("TIMELINE_FULL");
      // A change that adds no row still fits.
      await expect(
        operator().operatorUpdateTimelineEntry(
          "owner",
          "row-0",
          updateOf({ expectedVersion: 1, hidden: true }),
        ),
      ).resolves.toMatchObject({ hidden: true });
      expect(await storedIds()).toHaveLength(TIMELINE_ENTRIES_MAXIMUM);
    },
    SLOW,
  );

  it(
    "refuses a row that would take the response past its size estimate",
    async () => {
      const long = "长".repeat(200);
      const sized = (index: number) =>
        entry(`size-${String(index).padStart(5, "0")}`, {
          title: long,
          fullTitle: long,
          catalogId: `size-catalog-${String(index).padStart(5, "0")}`,
        });
      // Rows of one byte length: the most that fit, so one more does not.
      const one = estimateTimelineResponseBytes([sized(0)]) - 2;
      const fitting = Math.floor(
        (TIMELINE_RESPONSE_BYTES_MAXIMUM - 1) / (one + 1),
      );
      const rows = Array.from({ length: fitting }, (_, index) => sized(index));
      expect(estimateTimelineResponseBytes(rows)).toBeLessThanOrEqual(
        TIMELINE_RESPONSE_BYTES_MAXIMUM,
      );
      expect(
        estimateTimelineResponseBytes([...rows, sized(fitting)]),
      ).toBeGreaterThan(TIMELINE_RESPONSE_BYTES_MAXIMUM);
      await importScript.applyImport(setup, rows, {
        replaceOperatorEdits: true,
      });
      const next = sized(fitting);
      expect(
        await refusal(
          operator().operatorCreateTimelineEntry(
            "owner",
            createOf(next, { position: next.position }),
          ),
        ),
      ).toBe("TIMELINE_TOO_LARGE");
      expect(await storedIds()).toHaveLength(fitting);
    },
    SLOW,
  );
});

describe("timeline import guard", () => {
  beforeAll(async () => {
    await importScript.applyImport(setup, [entry("seed-a"), entry("seed-b")], {
      replaceOperatorEdits: true,
    });
  }, SLOW);

  it("keeps operator edits unless told to discard them, and records counts only", async () => {
    await operator().operatorUpdateTimelineEntry(
      "owner",
      "seed-a",
      updateOf({ expectedVersion: 1, hidden: true }),
    );
    await operator().operatorCreateTimelineEntry(
      "ai-admin",
      createOf(entry("seed-c")),
    );
    await expect(
      importScript.applyImport(setup, [entry("fresh")]),
    ).rejects.toThrow(
      "The timeline holds 2 operator-edited and 1 hidden rows; --replace-operator-edits discards them",
    );
    expect(await storedIds()).toEqual(["seed-a", "seed-b", "seed-c"]);
    const counts = {
      entries: 1,
      replaced: 3,
      operatorEdited: 2,
      hidden: 1,
    };
    await expect(
      importScript.applyImport(setup, [entry("fresh")], {
        replaceOperatorEdits: true,
      }),
    ).resolves.toEqual(counts);
    expect(
      (
        await setup.query(
          "SELECT entry_id,version,hidden_at,created_by,updated_by FROM community.timeline_entries",
        )
      ).rows,
    ).toEqual([
      {
        entry_id: "fresh",
        version: 1,
        hidden_at: null,
        created_by: "import",
        updated_by: "import",
      },
    ]);
    expect((await timelineEvents()).at(-1)).toEqual({
      operator_label: "import",
      action: "timeline.import",
      content_id: null,
      detail: counts,
    });
  });

  it("waits for an operator write that holds the shared lock", async () => {
    const holder = await setup.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(importScript.CONTENT_OPERATOR_LOCK_SQL);
      const importing = importScript.applyImport(setup, [entry("after-lock")]);
      const waiting = async () =>
        (
          await app.query<{ waiting: number }>(
            "SELECT count(*)::integer AS waiting FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())",
          )
        ).rows[0]!.waiting;
      const deadline = Date.now() + 4_000;
      while ((await waiting()) === 0 && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await waiting()).toBe(1);
      expect(await storedIds()).toEqual(["fresh"]);
      await holder.query("COMMIT");
      await importing;
      expect(await storedIds()).toEqual(["after-lock"]);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
  });
});
