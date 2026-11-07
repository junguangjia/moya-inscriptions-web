import { createHash, randomUUID } from "node:crypto";

import {
  CommunityConflictError,
  CommunityIdempotencyConflictError,
  CommunityInputError,
  CommunityNamedConflictError,
  CommunityNotFoundError,
} from "@moya/api";
import {
  TIMELINE_ENTRIES_MAXIMUM,
  checkTimelineEntryWrite,
} from "@moya/contracts/schemas";
import {
  markForAiOperator,
  operatorTimelineEntrySchema,
  operatorTimelinePostPageSchema,
  operatorTimelinePostSchema,
  timelineReorderResultSchema,
} from "@moya/contracts/internal/community-operator";

import { limitAiWrite } from "./ai-write-limit.js";
import { asCommunityOperationError } from "./availability.js";
import { isSelfOnlyWorkInScanSql } from "./self-only.js";

import type { TimelineOperatorPort } from "@moya/api";
import type {
  CreateTimelineEntryCommand,
  OperatorReadScope,
  OperatorTimelineEntry,
  OperatorTimelinePost,
  OperatorTimelinePostPage,
  OperatorTimelinePostQuery,
  ReorderTimelineCommand,
  SetTimelinePostCommand,
  TimelinePostRefusalCode,
  TimelineRefusalCode,
  TimelineReorderResult,
  UpdateTimelineEntryCommand,
} from "@moya/contracts/internal/community-operator";
import type { Pool, PoolClient, QueryResultRow } from "pg";

/*
 * home-timeline-v1 (Issue #384 r3): the operator side of
 * community.timeline_entries, for the Owner's route and the AI's.
 *
 * Writes follow the receipted command of the Thread adapter: the AI write
 * limit, the shared content-operator lock (the import takes it too), the
 * receipt, the change, one content_operator_events row and the receipt row.
 * Inside the lock each write reads the stored set, applies its change and runs
 * the contract's write check over the set before and after it: a write is
 * refused only for what it makes worse, so a row that fails a text or length
 * rule after direct SQL or a contract change can always be fixed or hidden. A
 * change to the chapter or precision values ships with a data migration, since
 * the table's checks list the same values. Ids and
 * Catalog links stay unique by the table's keys, named below. The public read
 * itself lives in the discovery adapter.
 *
 * Link state reads the published Catalog projection: on `catalogPool` when the
 * deployment reads Catalog over its own connection, as discovery does, else on
 * the App connection.
 *
 * timeline-posts-v1: the operator side of community.timeline_entry_posts, one
 * row per work, under the same receipted command. Its event names the work
 * (content type `work`), so a work's erasure scrubs the title its answer holds
 * from both the event and the receipt (publishing/works.ts). A write takes the
 * table's lock order, shared with the author's command: the work FOR UPDATE,
 * then the entry FOR SHARE when it attaches, then the post's row.
 */

interface TimelineEntryRow extends QueryResultRow {
  entry_id: string;
  title: string;
  full_title: string;
  start_year: number;
  end_year: number;
  precision: string;
  date_label: string | null;
  on_axis: boolean;
  chapter: string;
  polity: string | null;
  disputed: boolean;
  group_id: string | null;
  group_title: string | null;
  province: string | null;
  holder: string | null;
  catalog_id: string | null;
  position: number;
  version: number;
  hidden_at: Date | null;
  created_by: string;
  updated_by: string;
  created_at: Date;
  updated_at: Date;
}

const entryColumns = `entry_id,title,full_title,start_year,end_year,precision,date_label,on_axis,chapter,polity,disputed,
  group_id,group_title,province,holder,catalog_id,position,version,hidden_at,created_by,updated_by,created_at,updated_at`;
const readOrder = "ORDER BY start_year,position,entry_id";
/** The gap a new or reordered row leaves, so one row can move between two without renumbering. */
const POSITION_STEP = 1024;

/** A row's import fields in the contract's order: what the whole-set check reads. */
const importFields = (row: TimelineEntryRow) => ({
  id: row.entry_id,
  title: row.title,
  fullTitle: row.full_title,
  startYear: row.start_year,
  endYear: row.end_year,
  precision: row.precision,
  dateLabel: row.date_label,
  onAxis: row.on_axis,
  chapter: row.chapter,
  polity: row.polity,
  disputed: row.disputed,
  groupId: row.group_id,
  groupTitle: row.group_title,
  province: row.province,
  holder: row.holder,
  catalogId: row.catalog_id,
  position: row.position,
});
type ImportFields = ReturnType<typeof importFields>;
/** The written columns after entry_id, in the order the statements bind them. */
const writtenValues = (entry: ImportFields) => [
  entry.title,
  entry.fullTitle,
  entry.startYear,
  entry.endYear,
  entry.precision,
  entry.dateLabel,
  entry.onAxis,
  entry.chapter,
  entry.polity,
  entry.disputed,
  entry.groupId,
  entry.groupTitle,
  entry.province,
  entry.holder,
  entry.catalogId,
  entry.position,
];

/** The end of a start year: its highest position plus a step, or 0 when it has no row. */
const endOfYear = (
  rows: readonly ImportFields[],
  startYear: number,
): number => {
  let highest: number | null = null;
  for (const row of rows)
    if (
      row.startYear === startYear &&
      (highest === null || row.position > highest)
    )
      highest = row.position;
  return highest === null ? 0 : highest + POSITION_STEP;
};

const refusalMessages: Readonly<Record<TimelineRefusalCode, string>> = {
  ENTRY_EXISTS: "The timeline already holds this entry id",
  CATALOG_ALREADY_LINKED: "Another timeline entry links this Catalog record",
  TIMELINE_FULL: "The timeline holds its maximum number of entries",
  TIMELINE_TOO_LARGE: "The timeline response would exceed its size limit",
  ENTRY_INVALID: "The entry as it would be stored fails the contract",
  SET_CHANGED: "The listed entries are not exactly the rows of that year",
};
const refused = (code: TimelineRefusalCode) =>
  new CommunityNamedConflictError(code, refusalMessages[code]);

const postRefusalMessages: Readonly<Record<TimelinePostRefusalCode, string>> = {
  WORK_NOT_PUBLIC: "Only a public work by an active author is attached",
  ENTRY_UNAVAILABLE: "The timeline entry is unknown or hidden",
  POST_NOT_ATTACHED: "The work's post is not attached to a timeline entry",
};
const postRefused = (code: TimelinePostRefusalCode) =>
  new CommunityNamedConflictError(code, postRefusalMessages[code]);

interface TimelinePostRow extends QueryResultRow {
  work_id: string;
  title: string;
  author_id: string;
  operator_state: string;
  publicly_visible: boolean;
  entry_id: string | null;
  withheld_entry_id: string | null;
  state: string;
  attached_by: string;
  updated_by: string;
  version: number;
  attached_at: Date;
  updated_at: Date;
}

/** A post's row with its work, joined as `p`, `w` and `u`. */
const postSource = `community.timeline_entry_posts p
  JOIN community.works w ON w.id=p.work_id
  JOIN community.public_users u ON u.id=w.author_id`;
const postColumns = `p.work_id,w.title,w.author_id,w.operator_state,
  community.work_is_public(w) AND u.status='active' AS publicly_visible,
  p.entry_id,p.withheld_entry_id,p.state,p.attached_by,p.updated_by,p.version,p.attached_at,p.updated_at`;
/**
 * `$1` entry (attached there, or withheld from it), `$2` work, `$3` author, `$4`
 * state, `$5` attacher, `$6`/`$7` the last change's range, `$8` true to leave
 * self-only works out, so neither a row nor the total names one.
 */
const postsWhere = `WHERE ($1::text IS NULL OR p.entry_id=$1 OR (p.state='withheld' AND p.withheld_entry_id=$1))
  AND ($2::text IS NULL OR p.work_id=$2)
  AND ($3::text IS NULL OR w.author_id=$3)
  AND ($4::text IS NULL OR p.state=$4)
  AND ($5::text IS NULL OR p.attached_by=$5)
  AND ($6::timestamptz IS NULL OR p.updated_at>=$6::timestamptz)
  AND ($7::timestamptz IS NULL OR p.updated_at<=$7::timestamptz)
  AND NOT ($8::boolean AND ${isSelfOnlyWorkInScanSql("w")})`;

const postOf = (row: TimelinePostRow): OperatorTimelinePost =>
  operatorTimelinePostSchema.parse({
    workId: row.work_id,
    title: row.title,
    authorId: row.author_id,
    workState: row.operator_state,
    publiclyVisible: row.publicly_visible,
    entryId: row.entry_id,
    withheldEntryId: row.withheld_entry_id,
    state: row.state,
    attachedBy: row.attached_by,
    updatedBy: row.updated_by,
    version: row.version,
    attachedAt: row.attached_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });

/** The contract's write check over the stored set before and after the write. */
const assertWritable = (
  write: Parameters<typeof checkTimelineEntryWrite>[0],
): void => {
  const checked = checkTimelineEntryWrite(write);
  if (!checked.ok) throw refused(checked.issue.code);
};

/** The two unique rules, by name: a Catalog link is unique by its index alone. */
const constraintRefusals = new Map<string, TimelineRefusalCode>([
  ["timeline_entries_pkey", "ENTRY_EXISTS"],
  ["timeline_entries_catalog_id_unique", "CATALOG_ALREADY_LINKED"],
]);
const asTimelineOperationError = (error: unknown): unknown => {
  if (typeof error === "object" && error !== null && "code" in error) {
    const refusal =
      error.code === "23505" &&
      "constraint" in error &&
      typeof error.constraint === "string"
        ? constraintRefusals.get(error.constraint)
        : undefined;
    if (refusal !== undefined) return refused(refusal);
    // The contract refuses NUL; this backstops a caller that skipped it.
    if (error.code === "22021")
      return new CommunityInputError(
        "Text holds a character the store refuses",
      );
  }
  return asCommunityOperationError(error, "query");
};

const commandFingerprint = (action: string, subject: string, input: unknown) =>
  createHash("sha256")
    .update(JSON.stringify([action, subject, input]))
    .digest("hex");

const stored = <T>(value: T | undefined, current: T): T =>
  value === undefined ? current : value;

export class PostgresTimelineOperatorAdapter implements TimelineOperatorPort {
  constructor(
    private readonly pool: Pool,
    private readonly options: { catalogPool?: Pool } = {},
  ) {}

  private async run<T>(
    write: boolean,
    fn: (db: PoolClient) => Promise<T>,
  ): Promise<T> {
    const db = await this.pool.connect().catch((error) => {
      throw asCommunityOperationError(error, "connect");
    });
    try {
      // A write reads committed rows after it holds the lock: a snapshot taken
      // before the lock (REPEATABLE READ) would check a stale set.
      await db.query(
        write ? "BEGIN" : "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      const result = await fn(db);
      await db.query("COMMIT");
      return result;
    } catch (error) {
      await db.query("ROLLBACK").catch(() => undefined);
      throw asTimelineOperationError(error);
    } finally {
      db.release();
    }
  }

  /** The linked Catalog ids among `rows` whose record is published now. */
  private async published(
    db: PoolClient,
    rows: readonly TimelineEntryRow[],
  ): Promise<ReadonlySet<string>> {
    const linked = rows.flatMap(({ catalog_id }) =>
      catalog_id === null ? [] : [catalog_id],
    );
    if (linked.length === 0) return new Set();
    const sql =
      "SELECT catalog_id FROM public.catalog_discovery WHERE catalog_id=ANY($1::text[])";
    const reader = this.options.catalogPool ?? db;
    return new Set(
      (await reader.query<{ catalog_id: string }>(sql, [linked])).rows.map(
        ({ catalog_id }) => catalog_id,
      ),
    );
  }

  private entry(
    row: TimelineEntryRow,
    published: ReadonlySet<string>,
  ): OperatorTimelineEntry {
    return operatorTimelineEntrySchema.parse({
      ...importFields(row),
      version: row.version,
      hidden: row.hidden_at !== null,
      linkState:
        row.catalog_id === null
          ? "unlinked"
          : published.has(row.catalog_id)
            ? "published"
            : "not_published",
      createdBy: row.created_by,
      updatedBy: row.updated_by,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    });
  }

  private async answer(
    db: PoolClient,
    row: TimelineEntryRow,
  ): Promise<OperatorTimelineEntry> {
    return this.entry(row, await this.published(db, [row]));
  }

  private async storedRows(db: PoolClient): Promise<TimelineEntryRow[]> {
    return (
      await db.query<TimelineEntryRow>(
        `SELECT ${entryColumns} FROM community.timeline_entries ${readOrder} LIMIT $1`,
        [TIMELINE_ENTRIES_MAXIMUM + 1],
      )
    ).rows;
  }

  /**
   * Every stored row in the public read's order, hidden ones included, each
   * with its link state. The service filters, pages and counts over it; the
   * set is bounded at one row past the contract's maximum.
   */
  async operatorTimelineEntries(): Promise<OperatorTimelineEntry[]> {
    return this.run(false, async (db) => {
      const rows = await this.storedRows(db);
      const published = await this.published(db, rows);
      return rows.map((row) => this.entry(row, published));
    });
  }

  /** Receipted, audited operator command over the content-operator tables. */
  private async command<T>(
    operator: string,
    action: string,
    /** What names the command in its fingerprint. */
    named: string,
    /** The audited record; a timeline entry has no id when the command spans rows. */
    content: {
      readonly type: "timeline_entry" | "work";
      readonly id: string | null;
    },
    input: { readonly requestId: string },
    /** `unchanged()`: nothing was left to change, so no event; the receipt is kept. */
    change: (db: PoolClient, unchanged: () => void) => Promise<T>,
  ): Promise<T> {
    return this.run(true, async (db) => {
      await limitAiWrite(operator, (sql) => db.query(sql));
      await db.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('phase4-content-operator',0))",
      );
      const fingerprint = commandFingerprint(action, named, input);
      const old = await db.query<{
        fingerprint: string;
        result: T & { permanentlyDeleted?: unknown };
      }>(
        "SELECT fingerprint,result FROM community.content_operator_receipts WHERE operator_label=$1 AND request_id=$2",
        [operator, input.requestId],
      );
      if (old.rows[0]) {
        if (old.rows[0].fingerprint !== fingerprint)
          throw new CommunityIdempotencyConflictError(
            "Request identity already used",
          );
        // A work's erasure empties the receipt of a post on it.
        if (old.rows[0].result.permanentlyDeleted === true)
          throw new CommunityNotFoundError();
        return markForAiOperator(operator, old.rows[0].result, "replayed");
      }
      let audit = true;
      const result = await change(db, () => {
        audit = false;
      });
      if (audit)
        await db.query(
          "INSERT INTO community.content_operator_events(id,operator_label,action,content_type,content_id,detail) VALUES($1,$2,$3,$4,$5,$6)",
          [
            randomUUID(),
            operator,
            action,
            content.type,
            content.id,
            JSON.stringify({ command: input, result }),
          ],
        );
      await db.query(
        "INSERT INTO community.content_operator_receipts(operator_label,request_id,fingerprint,result) VALUES($1,$2,$3,$4)",
        [operator, input.requestId, fingerprint, JSON.stringify(result)],
      );
      return audit
        ? result
        : markForAiOperator(operator, result, "alreadyInPlace");
    });
  }

  async operatorCreateTimelineEntry(
    operator: string,
    input: CreateTimelineEntryCommand,
  ): Promise<OperatorTimelineEntry> {
    return this.command(
      operator,
      "timeline.create",
      input.id,
      { type: "timeline_entry", id: input.id },
      input,
      async (db) => {
        const rows = (await this.storedRows(db)).map(importFields);
        if (rows.some(({ id }) => id === input.id))
          throw refused("ENTRY_EXISTS");
        const entry: ImportFields = {
          id: input.id,
          title: input.title,
          fullTitle: input.fullTitle,
          startYear: input.startYear,
          endYear: input.endYear,
          precision: input.precision,
          dateLabel: input.dateLabel,
          onAxis: input.onAxis,
          chapter: input.chapter,
          polity: input.polity,
          disputed: input.disputed,
          groupId: input.groupId,
          groupTitle: input.groupTitle,
          province: input.province,
          holder: input.holder,
          catalogId: input.catalogId,
          position: input.position ?? endOfYear(rows, input.startYear),
        };
        assertWritable({
          before: rows,
          after: [...rows, entry],
          changes: [{ before: null, after: entry, hidden: false }],
        });
        const row = (
          await db.query<TimelineEntryRow>(
            `INSERT INTO community.timeline_entries(entry_id,title,full_title,start_year,end_year,precision,date_label,on_axis,
               chapter,polity,disputed,group_id,group_title,province,holder,catalog_id,position,created_by,updated_by)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18)
             RETURNING ${entryColumns}`,
            [entry.id, ...writtenValues(entry), operator],
          )
        ).rows[0]!;
        return this.answer(db, row);
      },
    );
  }

  async operatorUpdateTimelineEntry(
    operator: string,
    id: string,
    input: UpdateTimelineEntryCommand,
  ): Promise<OperatorTimelineEntry> {
    return this.command(
      operator,
      "timeline.update",
      id,
      { type: "timeline_entry", id },
      input,
      async (db) => {
        const before = (
          await db.query<TimelineEntryRow>(
            `SELECT ${entryColumns} FROM community.timeline_entries WHERE entry_id=$1 FOR UPDATE`,
            [id],
          )
        ).rows[0];
        if (!before) throw new CommunityNotFoundError();
        if (before.version !== input.expectedVersion)
          throw new CommunityConflictError(
            "The timeline entry changed since it was read",
          );
        if (
          Object.entries(input).every(
            ([key, value]) =>
              key === "requestId" ||
              key === "expectedVersion" ||
              value === undefined,
          )
        )
          throw new CommunityInputError("Nothing to change");
        const current = importFields(before);
        const others = (await this.storedRows(db))
          .filter(({ entry_id }) => entry_id !== id)
          .map(importFields);
        const startYear = stored(input.startYear, current.startYear);
        const entry: ImportFields = {
          id,
          title: stored(input.title, current.title),
          fullTitle: stored(input.fullTitle, current.fullTitle),
          startYear,
          endYear: stored(input.endYear, current.endYear),
          precision: stored(input.precision, current.precision),
          dateLabel: stored(input.dateLabel, current.dateLabel),
          onAxis: stored(input.onAxis, current.onAxis),
          chapter: stored(input.chapter, current.chapter),
          polity: stored(input.polity, current.polity),
          disputed: stored(input.disputed, current.disputed),
          groupId: stored(input.groupId, current.groupId),
          groupTitle: stored(input.groupTitle, current.groupTitle),
          province: stored(input.province, current.province),
          holder: stored(input.holder, current.holder),
          catalogId: stored(input.catalogId, current.catalogId),
          // A row moved to another year without a position joins its end.
          position:
            input.position ??
            (startYear === current.startYear
              ? current.position
              : endOfYear(others, startYear)),
        };
        assertWritable({
          before: [...others, current],
          after: [...others, entry],
          changes: [
            {
              before: current,
              after: entry,
              hidden: input.hidden ?? before.hidden_at !== null,
            },
          ],
        });
        const row = (
          await db.query<TimelineEntryRow>(
            `UPDATE community.timeline_entries SET
               title=$2, full_title=$3, start_year=$4, end_year=$5, precision=$6, date_label=$7,
               on_axis=$8, chapter=$9, polity=$10, disputed=$11, group_id=$12, group_title=$13,
               province=$14, holder=$15, catalog_id=$16, position=$17,
               hidden_at = CASE WHEN $18::boolean IS NULL THEN hidden_at
                                WHEN $18::boolean THEN COALESCE(hidden_at, CURRENT_TIMESTAMP)
                                ELSE NULL END,
               version = version + 1, updated_by = $19, updated_at = CURRENT_TIMESTAMP
             WHERE entry_id = $1
             RETURNING ${entryColumns}`,
            [id, ...writtenValues(entry), input.hidden ?? null, operator],
          )
        ).rows[0]!;
        return this.answer(db, row);
      },
    );
  }

  /**
   * One start year's rows in a new order, all or none, under one receipt and
   * one event (no single entry id is audited). The year's hidden rows belong to
   * the list too, so a row shown again keeps a place in the order. Each listed
   * row is written, so it is checked as an update is.
   */
  async operatorReorderTimeline(
    operator: string,
    input: ReorderTimelineCommand,
  ): Promise<TimelineReorderResult> {
    return this.command(
      operator,
      "timeline.reorder",
      `year:${input.startYear}`,
      { type: "timeline_entry", id: null },
      input,
      async (db) => {
        const year = (
          await db.query<TimelineEntryRow>(
            `SELECT ${entryColumns} FROM community.timeline_entries WHERE start_year=$1 FOR UPDATE`,
            [input.startYear],
          )
        ).rows;
        const versions = new Map(
          year.map(({ entry_id, version }) => [entry_id, version]),
        );
        if (
          year.length !== input.entries.length ||
          input.entries.some(({ id }) => !versions.has(id))
        )
          throw refused("SET_CHANGED");
        if (
          input.entries.some(
            ({ id, expectedVersion }) => versions.get(id) !== expectedVersion,
          )
        )
          throw new CommunityConflictError(
            "A timeline entry changed since it was read",
          );
        const positions = new Map(
          input.entries.map(({ id }, index) => [id, index * POSITION_STEP]),
        );
        const placed = (row: TimelineEntryRow): ImportFields => ({
          ...importFields(row),
          position: positions.get(row.entry_id) ?? row.position,
        });
        const rows = await this.storedRows(db);
        assertWritable({
          before: rows.map(importFields),
          after: rows.map(placed),
          changes: year.map((row) => ({
            before: importFields(row),
            after: placed(row),
            hidden: row.hidden_at !== null,
          })),
        });
        await db.query(
          `UPDATE community.timeline_entries t
           SET position = v.position, version = t.version + 1, updated_by = $3, updated_at = CURRENT_TIMESTAMP
           FROM unnest($1::text[], $2::integer[]) AS v(entry_id, position)
           WHERE t.entry_id = v.entry_id`,
          [[...positions.keys()], [...positions.values()], operator],
        );
        return timelineReorderResultSchema.parse({
          startYear: input.startYear,
          count: input.entries.length,
        });
      },
    );
  }

  /**
   * timeline-posts-v1: per stored row, its public posts (a public work by an
   * active author, attached), whoever asks; rows with none are absent.
   */
  async operatorTimelinePostCounts(): Promise<
    Readonly<Record<string, number>>
  > {
    return this.run(false, async (db) => {
      const rows = (
        await db.query<{ entry_id: string; total: number }>(
          `SELECT p.entry_id,count(*)::integer AS total FROM ${postSource}
           WHERE p.state='attached' AND community.work_is_public(w) AND u.status='active'
           GROUP BY p.entry_id`,
        )
      ).rows;
      return Object.fromEntries(
        rows.map(({ entry_id, total }) => [entry_id, total]),
      );
    });
  }

  /** A filtered page of post rows, newest change first, in one snapshot. */
  async operatorTimelinePosts(
    query: OperatorTimelinePostQuery,
    scope?: OperatorReadScope,
  ): Promise<OperatorTimelinePostPage> {
    const filters = [
      query.entryId ?? null,
      query.workId ?? null,
      query.authorId ?? null,
      query.state ?? null,
      query.attachedBy ?? null,
      query.from ?? null,
      query.to ?? null,
      scope?.withholdSelfOnly === true,
    ];
    return this.run(false, async (db) => {
      const total = (
        await db.query<{ total: number }>(
          `SELECT count(*)::integer AS total FROM ${postSource} ${postsWhere}`,
          filters,
        )
      ).rows[0]!.total;
      const rows = (
        await db.query<TimelinePostRow>(
          `SELECT ${postColumns} FROM ${postSource} ${postsWhere}
           ORDER BY p.updated_at DESC,p.work_id DESC LIMIT $9 OFFSET $10`,
          [...filters, query.pageSize, (query.page - 1) * query.pageSize],
        )
      ).rows;
      return operatorTimelinePostPageSchema.parse({
        items: rows.map(postOf),
        total,
        page: query.page,
        pageSize: query.pageSize,
      });
    });
  }

  /**
   * One work's post, against the version its row was read at (0: no row).
   * Attaching needs a public work and a visible entry, and lifts a withhold
   * from that same entry; a move or a re-attach is a new attachment, its time
   * and attacher too. A detach or a withhold needs a row: a withhold of an
   * attached post records the entry it leaves. Asking for what is already
   * true writes nothing, keeps the receipt and tells AI so.
   */
  async operatorSetTimelinePost(
    operator: string,
    workId: string,
    input: SetTimelinePostCommand,
  ): Promise<OperatorTimelinePost> {
    return this.command(
      operator,
      "timeline.post",
      workId,
      { type: "work", id: workId },
      input,
      async (db, unchanged) => {
        const work = (
          await db.query<{ public: boolean }>(
            `SELECT community.work_is_public(w) AND u.status='active' AS public
             FROM community.works w JOIN community.public_users u ON u.id=w.author_id
             WHERE w.id=$1 FOR UPDATE OF w`,
            [workId],
          )
        ).rows[0];
        if (!work) throw new CommunityNotFoundError();
        const entryVisible =
          input.entryId === null ||
          (
            await db.query(
              "SELECT 1 FROM community.timeline_entries WHERE entry_id=$1 AND hidden_at IS NULL FOR SHARE",
              [input.entryId],
            )
          ).rowCount === 1;
        const current = (
          await db.query<{
            entry_id: string | null;
            state: string;
            version: number;
          }>(
            "SELECT entry_id,state,version FROM community.timeline_entry_posts WHERE work_id=$1 FOR UPDATE",
            [workId],
          )
        ).rows[0];
        if ((current?.version ?? 0) !== input.expectedVersion)
          throw new CommunityConflictError(
            "The post's timeline entry changed since it was read",
          );
        if (input.entryId !== null) {
          if (!work.public) throw postRefused("WORK_NOT_PUBLIC");
          if (!entryVisible) throw postRefused("ENTRY_UNAVAILABLE");
          if (current === undefined)
            await db.query(
              "INSERT INTO community.timeline_entry_posts(work_id,entry_id,attached_by,updated_by) VALUES($1,$2,$3,$3)",
              [workId, input.entryId, operator],
            );
          else if (
            current.state === "attached" &&
            current.entry_id === input.entryId
          )
            unchanged();
          else
            await db.query(
              `UPDATE community.timeline_entry_posts SET entry_id=$2,state='attached',
                 withheld_entry_id=CASE WHEN withheld_entry_id=$2 THEN NULL ELSE withheld_entry_id END,
                 attached_by=$3,attached_at=CURRENT_TIMESTAMP,updated_by=$3,version=version+1,updated_at=CURRENT_TIMESTAMP
               WHERE work_id=$1`,
              [workId, input.entryId, operator],
            );
        } else {
          if (current === undefined) throw postRefused("POST_NOT_ATTACHED");
          const withhold = input.state === "withheld";
          if (current.state === "attached")
            await db.query(
              `UPDATE community.timeline_entry_posts SET state=$2,
                 withheld_entry_id=CASE WHEN $2='withheld' THEN entry_id ELSE withheld_entry_id END,
                 entry_id=NULL,updated_by=$3,version=version+1,updated_at=CURRENT_TIMESTAMP
               WHERE work_id=$1`,
              [workId, withhold ? "withheld" : "detached", operator],
            );
          // A post off its row stays off; only an attached one names the row to withhold from.
          else if (withhold && current.state !== "withheld")
            throw postRefused("POST_NOT_ATTACHED");
          else unchanged();
        }
        return postOf(
          (
            await db.query<TimelinePostRow>(
              `SELECT ${postColumns} FROM ${postSource} WHERE p.work_id=$1`,
              [workId],
            )
          ).rows[0]!,
        );
      },
    );
  }
}
