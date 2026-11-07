import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  CommunityConflictError,
  CommunityIdempotencyConflictError,
  CommunityInputError,
  CommunityNamedConflictError,
  CommunityNotFoundError,
  TimelineOperatorService,
} from "@moya/api";
import {
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import {
  PostgresTimelineOperatorAdapter,
  PostgresTimelinePostsAdapter,
  PostgresWorkPublishingAdapter,
  runCommunityMigrations,
} from "@moya/community-postgres";
import {
  operatorTimelinePageSchema,
  operatorTimelinePostPageSchema,
  operatorTimelinePostSchema,
} from "@moya/contracts/internal/community-operator";
import {
  contentTimelineEntrySchema,
  timelinePostCountsSchema,
  workPageSchema,
  workSubmissionCommandSchema,
} from "@moya/contracts/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assertSyntheticTestDatabaseUrl,
  requireSyntheticTestDatabaseUrl,
} from "./synthetic-test-database.js";

import type {
  WorkDraftContent,
  WorkSubmissionCommand,
  WorkVisibility,
} from "@moya/contracts";

/*
 * timeline-posts-v1 on a dedicated synthetic database with its own App role, so
 * every read and write runs with exactly the named grants and no other suite
 * meets its rows: the deferred entry key with the import's delete and
 * re-insert, the import's refusal, the table's checks, the App role's column
 * grants and the design doc's preflight, the attach in the submission
 * transaction, the author's attach / move / detach command with its receipt
 * and named refusals, the per-viewer list, counts and entry reads, and the
 * operator side: rows' post counts, the post rows the Owner and AI read, and
 * the receipted attach / move / take-off / withhold command. Each
 * case creates the users, works and entries it reads, so it passes alone; the
 * database is created empty and dropped afterwards. Content is synthetic.
 */

type Pool = ReturnType<typeof createPostgresPool>;

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
interface ImportScript {
  applyImport(
    pool: Pool,
    entries: readonly ImportEntry[],
    options?: { readonly replaceOperatorEdits?: boolean },
  ): Promise<unknown>;
  TimelineImportRefused: new (message: string) => Error;
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
const opaque = (prefix: string) =>
  `${prefix}-${randomUUID().replaceAll("-", "")}`;

const suffix = hex(6);
const database = `timeline_posts_${suffix}_synthetic_test`;
const appRole = `tl_posts_app_${suffix}`;
let setup: Pool;
let app: Pool;
let created = { database: false, app: false };

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
  await administration.query(
    `CREATE ROLE ${appRole} LOGIN PASSWORD '${appPassword}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`,
  );
  created = { ...created, app: true };
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
  // The published Catalog relations the runtime grants name; stand-ins here.
  await setup.query(
    "CREATE TABLE public.catalog_entries(catalog_id text PRIMARY KEY,province text,province_state text); CREATE TABLE public.catalog_discovery(catalog_id text PRIMARY KEY,kind text,title text,aliases varchar[],first_published_at timestamptz,filter_metadata jsonb); CREATE TABLE public.catalog_media(catalog_id text,media_id text,object_key text,width integer,height integer,is_representative boolean,position integer NOT NULL DEFAULT 0); CREATE TABLE public.article_entries(article_id text PRIMARY KEY,title text)",
  );
  await setup.query(await runtimeGrant());
  app = poolFor(url({ role: appRole, password: appPassword }));
}, SLOW);

afterAll(async () => {
  await app?.end();
  await setup?.end();
  if (created.database)
    await administration.query(
      `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`,
    );
  if (created.app) await administration.query(`DROP ROLE IF EXISTS ${appRole}`);
  await administration.end();
}, SLOW);

const publishing = () => new PostgresWorkPublishingAdapter(app);
const posts = () => new PostgresTimelinePostsAdapter(app);
/** Stored times come from the injected clock; each call is one second on. */
let tick = 0;
const clock = () => new Date(Date.UTC(2026, 10, 7, 9, 0, tick++));
/** The author list query; posts read its page and page size only. */
const pageOf = (page: number, pageSize: number) =>
  ({ page, pageSize, search: "", kind: "all" }) as const;
const everything = pageOf(1, 50);

/** What a refused call answered: a named code, or the error class. */
const outcome = async (attempt: Promise<unknown>) =>
  attempt.then(
    () => "resolved",
    (error: unknown) =>
      error instanceof CommunityInputError
        ? error.message
        : error instanceof CommunityNotFoundError
          ? "not_found"
          : error instanceof CommunityConflictError
            ? "conflict"
            : String((error as { readonly code?: unknown }).code ?? error),
  );

const user = async (label = "合成作者") => {
  const id = opaque("user");
  await setup.query(
    "INSERT INTO community.public_users(id,handle,display_name) VALUES($1,$2,$3)",
    [id, `tp-${id.slice(-24)}`, label],
  );
  return id;
};
/** A visible text-only row, as the import stores one; its own id per case. */
const entry = async (
  options: { readonly catalogId?: string; readonly hidden?: boolean } = {},
) => {
  const id = `tp-${hex(6)}`;
  await setup.query(
    "INSERT INTO community.timeline_entries(entry_id,title,full_title,start_year,end_year,precision,on_axis,chapter,disputed,catalog_id,position,hidden_at) VALUES($1,$2,$3,618,618,'year',TRUE,'唐',FALSE,$4,0,$5)",
    [
      id,
      `合成${id}`,
      `合成朝合成${id}`,
      options.catalogId ?? null,
      options.hidden === true ? new Date() : null,
    ],
  );
  return id;
};
/** A ready legacy still owned by `owner`, so a submission needs no processing. */
const readyItem = async (owner: string) => {
  const mediaId = opaque("user-media");
  const itemId = opaque("media-item");
  await setup.query(
    "INSERT INTO community.user_media(id,owner_id,mime_type,width,height,sha256,bytes) VALUES($1,$2,'image/png',30,40,$3,$4)",
    [mediaId, owner, "b".repeat(64), Buffer.from([0x89, 0x50, 0x4e, 0x47])],
  );
  await setup.query(
    "INSERT INTO community.media_items(id,owner_id,kind,quality_mode,source,legacy_media_id,state,presentation) VALUES($1,$2,'static','legacy','legacy_user_media',$3,'ready','{\"width\":30,\"height\":40}'::jsonb)",
    [itemId, owner, mediaId],
  );
  return itemId;
};
const content = (itemId: string, visibility: WorkVisibility = "public") => ({
  title: "访碑记录",
  body: "合成正文",
  authorship: { kind: "original" as const },
  visibility,
  items: [
    {
      key: itemId,
      itemId,
      kind: "static" as const,
      qualityMode: "legacy" as const,
      edit: { rotation: 0 as const, crop: null },
    },
  ],
  coverKey: null,
  coverCrop: null,
});
const session = async (owner: string, itemId: string, workId?: string) => {
  const sessionId = opaque("publishing-session");
  await setup.query(
    "INSERT INTO community.publishing_sessions(id,owner_id,save_mode,work_id,state,lease_expires_at) VALUES($1,$2,'unsaved',$3,'active','2100-01-01T00:00:00Z')",
    [sessionId, owner, workId ?? null],
  );
  await setup.query(
    "INSERT INTO community.media_item_refs(item_id,holder_kind,holder_id) VALUES($1,'session',$2)",
    [itemId, sessionId],
  );
  return sessionId;
};
/** A new work's submission command, through an unsaved session. */
const newWork = async (
  owner: string,
  options: {
    readonly entryId?: string;
    readonly visibility?: WorkVisibility;
  } = {},
): Promise<WorkSubmissionCommand> => {
  const itemId = await readyItem(owner);
  return workSubmissionCommandSchema.parse({
    requestId: randomUUID(),
    holder: { sessionId: await session(owner, itemId) },
    baseRevisionId: null,
    content: content(itemId, options.visibility),
    ...(options.entryId === undefined
      ? {}
      : { timelineEntryId: options.entryId }),
  });
};
const submit = async (owner: string, command: WorkSubmissionCommand) => {
  const result = await publishing().submit(owner, command, clock());
  if (result.state !== "confirmed") throw new Error("Submission not ready");
  return result;
};
const publish = async (
  owner: string,
  options: Parameters<typeof newWork>[1] = {},
) => (await submit(owner, await newWork(owner, options))).workId;
const setEntry = (
  owner: string,
  workId: string,
  entryId: string | null,
  requestId: string = randomUUID(),
) =>
  publishing().setTimelineEntry(owner, workId, { requestId, entryId }, clock());
const association = async (workId: string) =>
  (
    await setup.query<{
      entry_id: string | null;
      state: string;
      withheld_entry_id: string | null;
      attached_by: string;
      updated_by: string;
      version: number;
      attached_at: Date;
    }>(
      "SELECT entry_id,state,withheld_entry_id,attached_by,updated_by,version,attached_at FROM community.timeline_entry_posts WHERE work_id=$1",
      [workId],
    )
  ).rows[0];
const listed = async (entryId: string, viewer: string | null) => {
  const page = workPageSchema.parse(
    await posts().listTimelinePosts(entryId, viewer, everything),
  );
  return { total: page.total, ids: page.items.map(({ id }) => id) };
};
const counted = async (viewer: string | null) =>
  timelinePostCountsSchema.parse(await posts().timelinePostCounts(viewer))
    .counts;
const entryOf = async (
  target: { readonly type: "work" | "catalog"; readonly id: string },
  viewer: string | null,
) =>
  contentTimelineEntrySchema.parse(
    await posts().timelineEntryOf(target, viewer),
  ).entry;
const countOf = async (sql: string, values: readonly unknown[]) =>
  Number(
    (await setup.query<{ total: string }>(sql, [...values])).rows[0]!.total,
  );

describe("the deferred entry key", () => {
  it("lets one transaction delete and re-insert a row holding a post, and refuses a delete alone at commit", async () => {
    const author = await user();
    const row = await entry();
    const work = await publish(author, { entryId: row });
    const client = await setup.connect();
    try {
      await client.query("BEGIN");
      const deleted = await client.query(
        "DELETE FROM community.timeline_entries WHERE entry_id=$1 RETURNING *",
        [row],
      );
      expect(deleted.rowCount).toBe(1);
      await client.query(
        "INSERT INTO community.timeline_entries SELECT * FROM json_populate_record(NULL::community.timeline_entries,$1::json)",
        [JSON.stringify(deleted.rows[0])],
      );
      await client.query("COMMIT");
      // NO ACTION, deferred: the delete alone passes its statement and fails
      // only at commit; RESTRICT would have failed on the DELETE itself.
      await client.query("BEGIN");
      await client.query(
        "DELETE FROM community.timeline_entries WHERE entry_id=$1",
        [row],
      );
      await expect(outcome(client.query("COMMIT"))).resolves.toBe("23503");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    expect(await association(work)).toMatchObject({
      entry_id: row,
      state: "attached",
    });
    expect((await listed(row, null)).ids).toEqual([work]);
  });

  it("is checked at commit and plain NO ACTION", async () => {
    const [key] = (
      await setup.query<{
        deferrable: boolean;
        deferred: boolean;
        on_delete: string;
      }>(
        "SELECT condeferrable AS deferrable, condeferred AS deferred, confdeltype AS on_delete FROM pg_constraint WHERE conrelid='community.timeline_entry_posts'::regclass AND contype='f' AND confrelid='community.timeline_entries'::regclass",
      )
    ).rows;
    expect(key).toEqual({ deferrable: true, deferred: true, on_delete: "a" });
  });
});

describe("the timeline import with attached posts", () => {
  /** The stored set as an import file, so a case replaces only what it says. */
  const storedFile = async (): Promise<ImportEntry[]> =>
    (
      await setup.query<ImportEntry>(
        `SELECT entry_id AS id,title,full_title AS "fullTitle",start_year AS "startYear",end_year AS "endYear",precision,
           date_label AS "dateLabel",on_axis AS "onAxis",chapter,polity,disputed,group_id AS "groupId",group_title AS "groupTitle",
           province,holder,catalog_id AS "catalogId",position
         FROM community.timeline_entries ORDER BY start_year,position,entry_id`,
      )
    ).rows;
  const storedIds = async () =>
    (
      await setup.query<{ entry_id: string; version: number }>(
        "SELECT entry_id,version FROM community.timeline_entries ORDER BY entry_id",
      )
    ).rows;

  it("keeps the posts of every id it keeps, and refuses with counts only a file dropping a row that holds posts", async () => {
    const author = await user();
    const kept = await entry();
    const dropped = await entry();
    const keptWork = await publish(author, { entryId: kept });
    const droppedWorks = [
      await publish(author, { entryId: dropped }),
      await publish(author, { entryId: dropped, visibility: "self" }),
    ];
    await importScript.applyImport(setup, await storedFile(), {
      replaceOperatorEdits: true,
    });
    expect((await listed(kept, null)).ids).toEqual([keptWork]);
    expect((await listed(dropped, author)).total).toBe(2);
    const before = await storedIds();
    const imports = () =>
      countOf(
        "SELECT count(*) AS total FROM community.content_operator_events WHERE action='timeline.import'",
        [],
      );
    const recorded = await imports();
    const file = (await storedFile()).filter(({ id }) => id !== dropped);
    await expect(
      importScript.applyImport(setup, file, { replaceOperatorEdits: true }),
    ).rejects.toThrow(
      new importScript.TimelineImportRefused(
        "The file drops 1 rows that hold 2 attached posts; keep those rows, or take their posts off first",
      ),
    );
    // Refused inside its transaction: no row, version or post changed.
    expect(await storedIds()).toEqual(before);
    for (const work of droppedWorks)
      expect(await association(work)).toMatchObject({
        entry_id: dropped,
        state: "attached",
      });
    expect(await imports()).toBe(recorded);
  });

  it("is not held back by posts that are detached or withheld", async () => {
    const author = await user();
    const row = await entry();
    const detached = await publish(author, { entryId: row });
    const withheld = await publish(author, { entryId: row });
    await setEntry(author, detached, null);
    await setup.query(
      "UPDATE community.timeline_entry_posts SET state='withheld',entry_id=NULL,withheld_entry_id=$2,updated_by='owner',version=version+1,updated_at=now() WHERE work_id=$1",
      [withheld, row],
    );
    await importScript.applyImport(
      setup,
      (await storedFile()).filter(({ id }) => id !== row),
      { replaceOperatorEdits: true },
    );
    expect((await storedIds()).map(({ entry_id }) => entry_id)).not.toContain(
      row,
    );
    expect(await association(withheld)).toMatchObject({
      state: "withheld",
      entry_id: null,
      withheld_entry_id: row,
    });
  });
});

describe("timeline post table", () => {
  const insert = (values: string) =>
    outcome(
      setup.query(
        `INSERT INTO community.timeline_entry_posts(work_id,entry_id,state,withheld_entry_id,attached_by,updated_by) VALUES(${values})`,
      ),
    );

  it("keeps one row per work, an entry exactly while attached, and named actors", async () => {
    const author = await user();
    const row = await entry();
    const work = await publish(author, { entryId: row });
    const other = await publish(author);
    expect(
      await insert(`'${work}','${row}','attached',NULL,'author','author'`),
    ).toBe("23505");
    for (const values of [
      `'${other}',NULL,'attached',NULL,'author','author'`,
      `'${other}','${row}','detached',NULL,'author','author'`,
      `'${other}',NULL,'withheld',NULL,'owner','owner'`,
      `'${other}',NULL,'detached','Not An Id','author','author'`,
      `'${other}','${row}','attached',NULL,'import','author'`,
      `'${other}','${row}','attached',NULL,'author','someone'`,
      `'${other}','${row}','pending',NULL,'author','author'`,
    ])
      expect(await insert(values)).toBe("23514");
    expect(
      await outcome(
        setup.query(
          `INSERT INTO community.timeline_entry_posts(work_id,entry_id,attached_by,updated_by) VALUES('${opaque("work")}','${row}','author','author')`,
        ),
      ),
    ).toBe("23503");
  });

  it("orders an entry's attached posts by a partial index", async () => {
    const definitions = (
      await setup.query<{ indexdef: string }>(
        "SELECT indexdef FROM pg_indexes WHERE schemaname='community' AND tablename='timeline_entry_posts' AND indexname<>'timeline_entry_posts_pkey'",
      )
    ).rows.map(({ indexdef }) => indexdef);
    expect(definitions).toHaveLength(1);
    expect(definitions[0]).toMatch(
      /timeline_entry_posts_entry_order .*\(entry_id, attached_at DESC, work_id DESC\) WHERE \(state = 'attached'::text\)$/u,
    );
  });
});

describe("timeline post grants", () => {
  const tableLevel = async () =>
    (
      await setup.query<{ privilege_type: string }>(
        "SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee=$1 AND table_schema='community' AND table_name='timeline_entry_posts' ORDER BY 1",
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
         WHERE a.attrelid='community.timeline_entry_posts'::regclass AND a.attnum>0 AND NOT a.attisdropped
         ORDER BY a.attnum`,
        [appRole],
      )
    ).rows;
  // The columns a new row names; its state and version are the defaults.
  const inserted = [
    "work_id",
    "entry_id",
    "attached_by",
    "updated_by",
    "attached_at",
    "updated_at",
  ];
  const expectRuntimeGrants = async () => {
    expect(await tableLevel()).toEqual(["SELECT"]);
    const columns = await columnLevel();
    expect(columns.map(({ name }) => name)).toEqual([
      "work_id",
      "entry_id",
      "state",
      "withheld_entry_id",
      "attached_by",
      "updated_by",
      "version",
      "attached_at",
      "updated_at",
    ]);
    for (const { name, insert, update } of columns)
      expect({ name, insert, update }).toEqual({
        name,
        insert: inserted.includes(name),
        update: name !== "work_id",
      });
  };

  it("gives the App role reads, column inserts and column updates, idempotently, and no delete", async () => {
    await expectRuntimeGrants();
    await setup.query(await runtimeGrant());
    await expectRuntimeGrants();
    const author = await user();
    const row = await entry();
    const work = await publish(author);
    for (const write of [
      `UPDATE community.timeline_entry_posts SET work_id='${work}'`,
      "DELETE FROM community.timeline_entry_posts",
      "TRUNCATE community.timeline_entry_posts",
      `INSERT INTO community.timeline_entry_posts(work_id,entry_id,attached_by,updated_by,state) VALUES('${work}','${row}','author','author','attached')`,
      `INSERT INTO community.timeline_entry_posts(work_id,entry_id,attached_by,updated_by,version) VALUES('${work}','${row}','author','author',1)`,
      `INSERT INTO community.timeline_entry_posts(work_id,entry_id,attached_by,updated_by,withheld_entry_id) VALUES('${work}','${row}','author','author',NULL)`,
    ])
      await expect(outcome(app.query(write))).resolves.toBe("42501");
  });

  it("narrows an earlier table-level grant back to the columns", async () => {
    await setup.query(
      `GRANT INSERT, UPDATE, DELETE ON community.timeline_entry_posts TO "${appRole}"`,
    );
    try {
      await setup.query(await runtimeGrant());
      // DELETE is not this plan's to revoke; it stays for the preflight to find.
      expect(await tableLevel()).toEqual(["DELETE", "SELECT"]);
    } finally {
      await setup.query(
        `REVOKE DELETE ON community.timeline_entry_posts FROM "${appRole}"`,
      );
    }
    await expectRuntimeGrants();
  });

  it("reads the design doc's App-role preflight all true, and false for each residue", async () => {
    const sql =
      /App-role preflight for timeline posts[\s\S]*?```sql\n([\s\S]*?)```/u.exec(
        await readFile(`${root}/docs/development/home-timeline-v1.md`, "utf8"),
      )?.[1];
    expect(sql).toBeTypeOf("string");
    const preflight = async () =>
      (await setup.query(sql!.replaceAll(":'app_role'", `'${appRole}'`))).rows;
    const granted = {
      reads: true,
      creates: true,
      edits: true,
      no_delete: true,
      no_truncate: true,
      locks_entries: true,
      events: true,
      receipts: true,
    };
    expect(await preflight()).toEqual([granted]);
    const residue =
      "INSERT (version), DELETE, TRUNCATE ON community.timeline_entry_posts";
    try {
      await setup.query(`GRANT ${residue} TO "${appRole}"`);
      await setup.query(
        `REVOKE UPDATE (withheld_entry_id) ON community.timeline_entry_posts FROM "${appRole}"`,
      );
      expect(await preflight()).toEqual([
        {
          ...granted,
          creates: false,
          edits: false,
          no_delete: false,
          no_truncate: false,
        },
      ]);
    } finally {
      await setup.query(`REVOKE ${residue} FROM "${appRole}"`);
      await setup.query(await runtimeGrant());
    }
    expect(await preflight()).toEqual([granted]);
    await expectRuntimeGrants();
  });
});

describe("attaching on submission", () => {
  it("attaches a new work in its submission transaction, and replays the receipt without a second row", async () => {
    const author = await user();
    const row = await entry();
    const command = await newWork(author, { entryId: row });
    const first = await submit(author, command);
    expect(await association(first.workId)).toMatchObject({
      entry_id: row,
      state: "attached",
      withheld_entry_id: null,
      attached_by: "author",
      updated_by: "author",
      version: 1,
    });
    // A lost answer: the same request replays its receipt.
    expect(await submit(author, command)).toEqual(first);
    expect(
      await countOf(
        "SELECT count(*) AS total FROM community.timeline_entry_posts p JOIN community.works w ON w.id=p.work_id WHERE w.author_id=$1",
        [author],
      ),
    ).toBe(1);
    expect((await listed(row, null)).ids).toEqual([first.workId]);
  });

  it("refuses a hidden or unknown entry by name and writes nothing", async () => {
    const author = await user();
    const hidden = await entry({ hidden: true });
    for (const entryId of [hidden, `tp-${hex(6)}`])
      expect(
        await outcome(submit(author, await newWork(author, { entryId }))),
      ).toBe("timeline_entry_unavailable");
    for (const table of [
      "community.works WHERE author_id=$1",
      "community.author_command_receipts WHERE actor_id=$1",
      "community.author_events WHERE actor_id=$1",
    ])
      expect(
        await countOf(`SELECT count(*) AS total FROM ${table}`, [author]),
      ).toBe(0);
  });

  it("refuses an entry on a submission for an existing work", async () => {
    const author = await user();
    const row = await entry();
    const work = await publish(author);
    const { author_revision_id: base } = (
      await setup.query<{ author_revision_id: string }>(
        "SELECT author_revision_id FROM community.works WHERE id=$1",
        [work],
      )
    ).rows[0]!;
    const itemId = await readyItem(author);
    const edit = workSubmissionCommandSchema.parse({
      requestId: randomUUID(),
      holder: { sessionId: await session(author, itemId, work) },
      baseRevisionId: base,
      content: content(itemId),
      timelineEntryId: row,
    });
    expect(await outcome(submit(author, edit))).toBe("timeline_entry_conflict");
    expect(await association(work)).toBeUndefined();
    // Without the entry the same edit goes through.
    const { timelineEntryId: _entry, ...plain } = edit;
    void _entry;
    await submit(author, { ...plain, requestId: randomUUID() });
  });

  it("submits a draft that carries its entry with no conflict copy, and keeps the entry out of the revision", async () => {
    const author = await user();
    const row = await entry();
    const itemId = await readyItem(author);
    const draftContent: WorkDraftContent = {
      ...content(itemId),
      timelineEntryId: row,
    };
    const draft = await publishing().createDraft(
      author,
      { requestId: randomUUID(), content: draftContent, deviceClass: null },
      clock(),
    );
    // The draft keeps the entry it was saved with.
    expect(draft.content.timelineEntryId).toBe(row);
    const receipt = await submit(
      author,
      workSubmissionCommandSchema.parse({
        requestId: randomUUID(),
        holder: { draftId: draft.id },
        baseRevisionId: null,
        content: content(itemId),
        timelineEntryId: row,
      }),
    );
    expect(await association(receipt.workId)).toMatchObject({
      entry_id: row,
      state: "attached",
    });
    expect(
      (
        await setup.query<{ kind: string }>(
          "SELECT kind FROM community.work_draft_snapshots WHERE draft_id=$1 ORDER BY created_at",
          [draft.id],
        )
      ).rows.map(({ kind }) => kind),
    ).toEqual(["submitted"]);
  });
});

describe("the author's attach, move and detach", () => {
  it("takes effect at once, under one receipt and one event each, with no new revision", async () => {
    const author = await user();
    const [first, second] = [await entry(), await entry()];
    const work = await publish(author);
    const revisions = () =>
      countOf(
        "SELECT count(*) AS total FROM community.work_revisions WHERE work_id=$1",
        [work],
      );
    const events = () =>
      countOf(
        "SELECT count(*) AS total FROM community.author_events WHERE actor_id=$1 AND action='publishing.work.timeline_entry' AND subject_id=$2",
        [author, work],
      );
    expect(await revisions()).toBe(1);
    const attach = randomUUID();
    expect(await setEntry(author, work, first, attach)).toEqual({
      workId: work,
      entryId: first,
      version: 1,
    });
    // The same request again is the same answer, not a second change.
    expect(await setEntry(author, work, first, attach)).toEqual({
      workId: work,
      entryId: first,
      version: 1,
    });
    expect(await events()).toBe(1);
    expect(await outcome(setEntry(author, work, second, attach))).toBe(
      "conflict",
    );
    const attachedAt = (await association(work))!.attached_at;
    expect(await setEntry(author, work, second)).toEqual({
      workId: work,
      entryId: second,
      version: 2,
    });
    expect((await association(work))!.attached_at.getTime()).toBeGreaterThan(
      attachedAt.getTime(),
    );
    expect((await listed(first, null)).ids).toEqual([]);
    expect((await listed(second, null)).ids).toEqual([work]);
    // Asking for what is already true changes nothing.
    expect(await setEntry(author, work, second)).toEqual({
      workId: work,
      entryId: second,
      version: 2,
    });
    expect(await setEntry(author, work, null)).toEqual({
      workId: work,
      entryId: null,
      version: 3,
    });
    expect(await association(work)).toMatchObject({
      entry_id: null,
      state: "detached",
      updated_by: "author",
    });
    expect(await setEntry(author, work, null)).toEqual({
      workId: work,
      entryId: null,
      version: 3,
    });
    expect((await listed(second, author)).ids).toEqual([]);
    expect(await entryOf({ type: "work", id: work }, author)).toBeNull();
    // Re-attaching is a new attachment.
    expect(await setEntry(author, work, first)).toEqual({
      workId: work,
      entryId: first,
      version: 4,
    });
    expect(await revisions()).toBe(1);
    expect(await events()).toBe(6);
  });

  it("detaches a work with no association as version 0", async () => {
    const author = await user();
    const work = await publish(author);
    expect(await setEntry(author, work, null)).toEqual({
      workId: work,
      entryId: null,
      version: 0,
    });
    expect(await association(work)).toBeUndefined();
  });

  it("refuses another's work, a trashed or removed work and a hidden or unknown entry, writing nothing", async () => {
    const author = await user();
    const stranger = await user();
    const row = await entry();
    const hidden = await entry({ hidden: true });
    const work = await publish(author);
    expect(await outcome(setEntry(stranger, work, row))).toBe("not_found");
    expect(await outcome(setEntry(author, opaque("work"), row))).toBe(
      "not_found",
    );
    expect(await outcome(setEntry(author, work, hidden))).toBe(
      "timeline_entry_unavailable",
    );
    expect(await outcome(setEntry(author, work, `tp-${hex(6)}`))).toBe(
      "timeline_entry_unavailable",
    );
    const trashed = await publish(author);
    await setup.query(
      "UPDATE community.works SET trashed_at=now(),trash_purge_after=now()+interval '30 days' WHERE id=$1",
      [trashed],
    );
    const removed = await publish(author);
    await setup.query(
      "UPDATE community.works SET operator_state='removed' WHERE id=$1",
      [removed],
    );
    for (const unusable of [trashed, removed])
      expect(await outcome(setEntry(author, unusable, row))).toBe(
        "work_unavailable",
      );
    expect(
      await countOf(
        "SELECT count(*) AS total FROM community.timeline_entry_posts WHERE work_id=ANY($1::text[])",
        [[work, trashed, removed]],
      ),
    ).toBe(0);
    expect(
      await countOf(
        "SELECT count(*) AS total FROM community.author_events WHERE actor_id=ANY($1::text[]) AND action='publishing.work.timeline_entry'",
        [[author, stranger]],
      ),
    ).toBe(0);
  });

  it("refuses the entry an operator withheld the post from, allows another, and a detach keeps it withheld", async () => {
    const author = await user();
    const [withheldFrom, other] = [await entry(), await entry()];
    const work = await publish(author, { entryId: withheldFrom });
    // What the operator route writes (timeline-posts-v1 §6).
    await setup.query(
      "UPDATE community.timeline_entry_posts SET state='withheld',entry_id=NULL,withheld_entry_id=entry_id,updated_by='ai-admin',version=version+1,updated_at=now() WHERE work_id=$1",
      [work],
    );
    expect((await listed(withheldFrom, author)).ids).toEqual([]);
    expect(await outcome(setEntry(author, work, withheldFrom))).toBe(
      "timeline_entry_withheld",
    );
    expect(await setEntry(author, work, null)).toEqual({
      workId: work,
      entryId: null,
      version: 2,
    });
    expect(await association(work)).toMatchObject({
      state: "withheld",
      withheld_entry_id: withheldFrom,
    });
    expect(await setEntry(author, work, other)).toEqual({
      workId: work,
      entryId: other,
      version: 3,
    });
    expect(await association(work)).toMatchObject({
      state: "attached",
      entry_id: other,
      withheld_entry_id: withheldFrom,
      attached_by: "author",
    });
    expect(await outcome(setEntry(author, work, withheldFrom))).toBe(
      "timeline_entry_withheld",
    );
  });
});

describe("timeline post reads", () => {
  const setPolicy = (policy: "PRE_MODERATION" | "DIRECT_PUBLICATION") =>
    setup.query(
      "UPDATE community.work_publishing_settings SET publication_policy=$1",
      [policy],
    );

  it("lists and counts, for each viewer, exactly the posts that viewer may see", async () => {
    const row = await entry();
    const author = await user();
    const otherAuthor = await user();
    const suspendedAuthor = await user();
    const reader = await user();
    const blockedReader = await user();
    const visible = await publish(author, { entryId: row });
    const selfOnly = await publish(author, {
      entryId: row,
      visibility: "self",
    });
    // Pre-moderation: a first public submission waits as pending.
    await setPolicy("PRE_MODERATION");
    const pending = await publish(author, { entryId: row }).finally(() =>
      setPolicy("DIRECT_PUBLICATION"),
    );
    const trashed = await publish(author, { entryId: row });
    const hidden = await publish(author, { entryId: row });
    const removed = await publish(author, { entryId: row });
    await setup.query(
      "UPDATE community.works SET trashed_at=now(),trash_purge_after=now()+interval '30 days' WHERE id=$1",
      [trashed],
    );
    await setup.query(
      "UPDATE community.works SET operator_state='hidden' WHERE id=$1",
      [hidden],
    );
    await setup.query(
      "UPDATE community.works SET operator_state='removed' WHERE id=$1",
      [removed],
    );
    const fromOther = await publish(otherAuthor, { entryId: row });
    await publish(suspendedAuthor, { entryId: row });
    await setup.query(
      "UPDATE community.public_users SET status='suspended' WHERE id=$1",
      [suspendedAuthor],
    );
    await setup.query(
      "INSERT INTO community.blocks(blocker_id,blocked_id) VALUES($1,$2)",
      [otherAuthor, blockedReader],
    );
    // A detached post never shows.
    const detached = await publish(author, { entryId: row });
    await setEntry(author, detached, null);
    const expected = new Map<string | null, string[]>([
      [null, [fromOther, visible]],
      [reader, [fromOther, visible]],
      [blockedReader, [visible]],
      [otherAuthor, [fromOther, visible]],
      [author, [fromOther, removed, hidden, pending, selfOnly, visible]],
    ]);
    for (const [viewer, ids] of expected) {
      // Newest attachment first.
      expect(await listed(row, viewer)).toEqual({ total: ids.length, ids });
      expect((await counted(viewer))[row]).toBe(ids.length);
    }
  });

  it("leaves a row with no visible post out of the counts, and pages a long list", async () => {
    const author = await user();
    const empty = await entry();
    const selfOnlyRow = await entry();
    const long = await entry();
    await publish(author, { entryId: selfOnlyRow, visibility: "self" });
    const works: string[] = [];
    for (let index = 0; index < 3; index += 1)
      works.unshift(await publish(author, { entryId: long }));
    const counts = await counted(null);
    expect(counts[empty]).toBeUndefined();
    expect(counts[selfOnlyRow]).toBeUndefined();
    expect(counts[long]).toBe(3);
    expect((await counted(author))[selfOnlyRow]).toBe(1);
    const second = workPageSchema.parse(
      await posts().listTimelinePosts(long, null, pageOf(2, 2)),
    );
    expect(second).toMatchObject({ total: 3, page: 2, pageSize: 2 });
    expect(second.items.map(({ id }) => id)).toEqual([works[2]]);
  });

  it("takes a hidden row off every read, and brings its posts back when it shows again", async () => {
    const author = await user();
    const row = await entry();
    const work = await publish(author, { entryId: row });
    await setup.query(
      "UPDATE community.timeline_entries SET hidden_at=now() WHERE entry_id=$1",
      [row],
    );
    expect(
      await outcome(posts().listTimelinePosts(row, author, everything)),
    ).toBe("not_found");
    expect(
      await outcome(
        posts().listTimelinePosts(`tp-${hex(6)}`, null, everything),
      ),
    ).toBe("not_found");
    expect((await counted(author))[row]).toBeUndefined();
    expect(await entryOf({ type: "work", id: work }, author)).toBeNull();
    await setup.query(
      "UPDATE community.timeline_entries SET hidden_at=NULL WHERE entry_id=$1",
      [row],
    );
    expect((await listed(row, null)).ids).toEqual([work]);
  });

  it("names the row a visible work is attached to, and the row linking a Catalog record", async () => {
    const author = await user();
    const reader = await user();
    const catalogId = `catalog-${hex(8)}`;
    const linked = await entry({ catalogId });
    const hiddenCatalogId = `catalog-${hex(8)}`;
    await entry({ catalogId: hiddenCatalogId, hidden: true });
    const named = {
      id: linked,
      title: `合成${linked}`,
      fullTitle: `合成朝合成${linked}`,
    };
    expect(await entryOf({ type: "catalog", id: catalogId }, null)).toEqual(
      named,
    );
    expect(
      await entryOf({ type: "catalog", id: hiddenCatalogId }, null),
    ).toBeNull();
    expect(
      await entryOf({ type: "catalog", id: `catalog-${hex(8)}` }, null),
    ).toBeNull();
    const visible = await publish(author, { entryId: linked });
    const selfOnly = await publish(author, {
      entryId: linked,
      visibility: "self",
    });
    const plain = await publish(author);
    for (const viewer of [null, reader, author])
      expect(await entryOf({ type: "work", id: visible }, viewer)).toEqual(
        named,
      );
    expect(await entryOf({ type: "work", id: selfOnly }, author)).toEqual(
      named,
    );
    expect(await entryOf({ type: "work", id: selfOnly }, reader)).toBeNull();
    expect(await entryOf({ type: "work", id: plain }, author)).toBeNull();
  });
});

// timeline-posts-v1 §6: the operator side, over the App role's own grants.
describe("the operator side of timeline posts", () => {
  const AI = "ai-admin";
  const operator = () => new PostgresTimelineOperatorAdapter(app);
  const service = () => new TimelineOperatorService(operator());
  const set = (
    label: string,
    workId: string,
    command: {
      readonly expectedVersion: number;
      readonly entryId: string | null;
      readonly state?: "withheld";
    },
    requestId: string = randomUUID(),
  ) =>
    operator().operatorSetTimelinePost(label, workId, {
      requestId,
      ...command,
    });
  /** A refusal's contract code, the error's class, or "resolved". */
  const refusal = async (attempt: Promise<unknown>) =>
    attempt.then(
      () => "resolved",
      (error: unknown) =>
        error instanceof CommunityNamedConflictError
          ? error.refusal
          : error instanceof CommunityIdempotencyConflictError
            ? "idempotency_conflict"
            : error instanceof CommunityNotFoundError
              ? "not_found"
              : error instanceof CommunityConflictError
                ? "conflict"
                : error instanceof CommunityInputError
                  ? "input"
                  : String(error),
    );
  const events = (workId: string) =>
    setup
      .query<{ operator_label: string; action: string; content_type: string }>(
        "SELECT operator_label,action,content_type FROM community.content_operator_events WHERE content_id=$1 ORDER BY occurred_at,id",
        [workId],
      )
      .then(({ rows }) => rows);
  const receipts = (label: string, requestId: string) =>
    countOf(
      "SELECT count(*) AS total FROM community.content_operator_receipts WHERE operator_label=$1 AND request_id=$2",
      [label, requestId],
    );

  it("attaches a public post, moves and withholds it under one receipt and one event each, and its author cannot attach it back", async () => {
    const author = await user();
    const [first, second] = [await entry(), await entry()];
    const work = await publish(author);
    const attach = randomUUID();
    const attached = await set(
      AI,
      work,
      { expectedVersion: 0, entryId: first },
      attach,
    );
    expect(operatorTimelinePostSchema.parse(attached)).toMatchObject({
      workId: work,
      title: "访碑记录",
      authorId: author,
      workState: "visible",
      publiclyVisible: true,
      entryId: first,
      withheldEntryId: null,
      state: "attached",
      attachedBy: AI,
      updatedBy: AI,
      version: 1,
    });
    // A lost answer, retried: the receipt answers, marked for AI, and nothing runs again.
    expect(
      await set(AI, work, { expectedVersion: 0, entryId: first }, attach),
    ).toEqual({ ...attached, replayed: true });
    expect(
      await refusal(
        set(AI, work, { expectedVersion: 0, entryId: second }, attach),
      ),
    ).toBe("idempotency_conflict");
    expect((await listed(first, null)).ids).toEqual([work]);
    const moved = await set(AI, work, { expectedVersion: 1, entryId: second });
    expect(moved).toMatchObject({ entryId: second, version: 2 });
    expect(Date.parse(moved.attachedAt)).toBeGreaterThanOrEqual(
      Date.parse(attached.attachedAt),
    );
    expect((await listed(first, null)).ids).toEqual([]);
    expect((await listed(second, null)).ids).toEqual([work]);
    expect(
      await set("owner", work, {
        expectedVersion: 2,
        entryId: null,
        state: "withheld",
      }),
    ).toMatchObject({
      entryId: null,
      withheldEntryId: second,
      state: "withheld",
      attachedBy: AI,
      updatedBy: "owner",
      version: 3,
    });
    expect((await listed(second, author)).ids).toEqual([]);
    expect(await outcome(setEntry(author, work, second))).toBe(
      "timeline_entry_withheld",
    );
    expect(await setEntry(author, work, first)).toEqual({
      workId: work,
      entryId: first,
      version: 4,
    });
    expect(await association(work)).toMatchObject({
      state: "attached",
      entry_id: first,
      withheld_entry_id: second,
      attached_by: "author",
    });
    expect(await events(work)).toEqual([
      { operator_label: AI, action: "timeline.post", content_type: "work" },
      { operator_label: AI, action: "timeline.post", content_type: "work" },
      {
        operator_label: "owner",
        action: "timeline.post",
        content_type: "work",
      },
    ]);
    expect(await receipts(AI, attach)).toBe(1);
  });

  it("names each refusal, answers a stale version as a conflict, and writes nothing", async () => {
    const author = await user();
    const row = await entry();
    const hidden = await entry({ hidden: true });
    const work = await publish(author);
    const selfOnly = await publish(author, { visibility: "self" });
    const removed = await publish(author, { entryId: row });
    await setup.query(
      "UPDATE community.works SET operator_state='removed' WHERE id=$1",
      [removed],
    );
    const detached = await publish(author, { entryId: row });
    await setEntry(author, detached, null);
    for (const [label, workId, command, expected] of [
      [AI, work, { expectedVersion: 0, entryId: hidden }, "ENTRY_UNAVAILABLE"],
      [
        "owner",
        work,
        { expectedVersion: 0, entryId: `tp-${hex(6)}` },
        "ENTRY_UNAVAILABLE",
      ],
      [
        "owner",
        selfOnly,
        { expectedVersion: 0, entryId: row },
        "WORK_NOT_PUBLIC",
      ],
      [AI, removed, { expectedVersion: 1, entryId: row }, "WORK_NOT_PUBLIC"],
      [AI, work, { expectedVersion: 0, entryId: null }, "POST_NOT_ATTACHED"],
      [
        AI,
        work,
        { expectedVersion: 0, entryId: null, state: "withheld" },
        "POST_NOT_ATTACHED",
      ],
      [
        AI,
        detached,
        { expectedVersion: 2, entryId: null, state: "withheld" },
        "POST_NOT_ATTACHED",
      ],
      [AI, work, { expectedVersion: 1, entryId: row }, "conflict"],
      [AI, removed, { expectedVersion: 0, entryId: null }, "conflict"],
      [AI, opaque("work"), { expectedVersion: 0, entryId: row }, "not_found"],
    ] as const)
      expect(
        await refusal(set(label, workId, command)),
        `${label} ${workId} ${JSON.stringify(command)}`,
      ).toBe(expected);
    for (const workId of [work, selfOnly, removed, detached])
      expect(await events(workId), workId).toEqual([]);
    expect(await association(work)).toBeUndefined();
    expect(await association(removed)).toMatchObject({
      state: "attached",
      version: 1,
      updated_by: "author",
    });
    // A withhold names no row; the service refuses one that does, before the store.
    expect(
      await refusal(
        service().operatorSetPost(AI, removed, {
          requestId: randomUUID(),
          expectedVersion: 1,
          entryId: row,
          state: "withheld",
        }),
      ),
    ).toBe("input");
    expect(
      await refusal(
        service().operatorSetPost(AI, "work-1", {
          requestId: randomUUID(),
          expectedVersion: 0,
          entryId: row,
        }),
      ),
    ).toBe("not_found");
  });

  it("answers what is already true with no event, tells AI so, and an operator attach lifts its own withhold", async () => {
    const author = await user();
    const row = await entry();
    const work = await publish(author, { entryId: row });
    const again = randomUUID();
    expect(
      await set(AI, work, { expectedVersion: 1, entryId: row }, again),
    ).toMatchObject({ alreadyInPlace: true, version: 1, attachedBy: "author" });
    expect(await receipts(AI, again)).toBe(1);
    expect(
      await set("owner", work, { expectedVersion: 1, entryId: row }),
    ).not.toHaveProperty("alreadyInPlace");
    expect(await events(work)).toEqual([]);
    await set(AI, work, {
      expectedVersion: 1,
      entryId: null,
      state: "withheld",
    });
    for (const command of [
      { expectedVersion: 2, entryId: null, state: "withheld" },
      { expectedVersion: 2, entryId: null },
    ] as const)
      expect(await set(AI, work, command)).toMatchObject({
        alreadyInPlace: true,
        state: "withheld",
        withheldEntryId: row,
        version: 2,
      });
    expect(await events(work)).toHaveLength(1);
    expect(
      await set("owner", work, { expectedVersion: 2, entryId: row }),
    ).toMatchObject({
      state: "attached",
      entryId: row,
      withheldEntryId: null,
      attachedBy: "owner",
      version: 3,
    });
    expect((await listed(row, null)).ids).toEqual([work]);
    // The author may take it off and put it back now.
    expect(await setEntry(author, work, null)).toMatchObject({ version: 4 });
    expect(await setEntry(author, work, row)).toMatchObject({ version: 5 });
    // An operator's plain take-off keeps no withhold.
    expect(
      await set(AI, work, { expectedVersion: 5, entryId: null }),
    ).toMatchObject({ state: "detached", withheldEntryId: null, version: 6 });
    expect(await setEntry(author, work, row)).toMatchObject({ version: 7 });
  });

  it("reads every post row for the Owner, leaves self-only works out for AI, and narrows by each filter", async () => {
    const author = await user();
    const other = await user();
    const row = await entry();
    const elsewhere = await entry();
    const visible = await publish(author, { entryId: row });
    const selfOnly = await publish(author, {
      entryId: row,
      visibility: "self",
    });
    const withheld = await publish(other, { entryId: row });
    await set(AI, withheld, {
      expectedVersion: 1,
      entryId: null,
      state: "withheld",
    });
    const detached = await publish(author, { entryId: row });
    await setEntry(author, detached, null);
    const curated = await publish(other);
    await set("owner", curated, { expectedVersion: 0, entryId: elsewhere });
    const read = async (
      query: Record<string, unknown>,
      label: string = "owner",
    ) => {
      const page = operatorTimelinePostPageSchema.parse(
        await service().operatorPosts(label, query),
      );
      return { total: page.total, ids: page.items.map(({ workId }) => workId) };
    };
    const sorted = (ids: readonly string[]) => [...ids].sort();
    const owners = await read({ entryId: row });
    expect(owners.total).toBe(3);
    expect(sorted(owners.ids)).toEqual(sorted([visible, selfOnly, withheld]));
    const ais = await read({ entryId: row }, AI);
    expect(ais.total).toBe(2);
    expect(sorted(ais.ids)).toEqual(sorted([visible, withheld]));
    expect(await read({ workId: selfOnly }, AI)).toEqual({ total: 0, ids: [] });
    expect(await read({ workId: selfOnly })).toEqual({
      total: 1,
      ids: [selfOnly],
    });
    expect(await read({ workId: detached })).toMatchObject({ total: 1 });
    expect(await read({ entryId: row, state: "withheld" }, AI)).toEqual({
      total: 1,
      ids: [withheld],
    });
    expect(await read({ authorId: other, attachedBy: "owner" })).toEqual({
      total: 1,
      ids: [curated],
    });
    expect(
      await read({ workId: curated, from: "2100-01-01T00:00:00.000Z" }),
    ).toEqual({ total: 0, ids: [] });
    const paged = operatorTimelinePostPageSchema.parse(
      await service().operatorPosts("owner", {
        entryId: row,
        page: 2,
        pageSize: 2,
      }),
    );
    expect(paged).toMatchObject({ total: 3, page: 2, pageSize: 2 });
    expect(paged.items).toHaveLength(1);
    // A row's count is its public posts, whoever asks: the list takes no label.
    const page = operatorTimelinePageSchema.parse(
      await service().operatorList({ ids: `${row},${elsewhere}` }),
    );
    expect(
      Object.fromEntries(
        page.items.map(({ id, postCount }) => [id, postCount]),
      ),
    ).toEqual({ [row]: 1, [elsewhere]: 1 });
    const withPosts = operatorTimelinePageSchema.parse(
      await service().operatorList({ posts: "with", pageSize: 50 }),
    );
    expect(withPosts.items.map(({ id }) => id)).toEqual(
      expect.arrayContaining([row, elsewhere]),
    );
    expect(withPosts.items.every(({ postCount }) => postCount > 0)).toBe(true);
    const summary = await service().operatorSummary();
    expect(summary.posts).toEqual({
      total: Object.values(
        await operator().operatorTimelinePostCounts(),
      ).reduce((sum, count) => sum + count, 0),
      entries: withPosts.total,
    });
  });

  it("answers a replay of a receipt a work's erasure emptied as not found", async () => {
    const author = await user();
    const row = await entry();
    const work = await publish(author);
    const requestId = randomUUID();
    await set(AI, work, { expectedVersion: 0, entryId: row }, requestId);
    // What an erasure leaves of a receipt that held the work's title.
    expect(
      (
        await setup.query(
          `UPDATE community.content_operator_receipts SET result='{"permanentlyDeleted":true}'::jsonb
           WHERE (result->>'id'=$1 OR result->>'workId'=$1) AND result ? 'title'`,
          [work],
        )
      ).rowCount,
    ).toBe(1);
    expect(
      await refusal(
        set(AI, work, { expectedVersion: 0, entryId: row }, requestId),
      ),
    ).toBe("not_found");
  });
});
