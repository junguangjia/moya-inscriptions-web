import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import console from "node:console";

/**
 * home-timeline-v1: the guarded seed step behind community.timeline_entries.
 * The rows are a private file validated against the contract (each row and the
 * whole set: a file must be wholly valid), never a migration and never Git. The
 * default is a dry run that opens no connection; --apply replaces every row in
 * one transaction with the migration role, so a reader sees the old set or the
 * new one. It holds the content-operator lock the Backend's operator writes
 * take, and refuses to discard rows an operator created, edited or hid unless
 * --replace-operator-edits says so. Output carries counts only: no row content
 * and no connection string.
 */
export const TIMELINE_MIGRATION_ID = "20261105235900";
const migrationVariable = "APP_MIGRATION_DATABASE_URL";
const INSERT_BATCH_ROWS = 200;
const ISSUES_SHOWN = 5;
/** The lock of every content-operator write, the timeline's included. */
export const CONTENT_OPERATOR_LOCK_SQL =
  "SELECT pg_advisory_xact_lock(hashtextextended('phase4-content-operator',0))";
const OPERATOR_ROWS_SQL =
  "SELECT count(*)::integer AS total, count(*) FILTER (WHERE created_by<>'import' OR updated_by<>'import')::integer AS edited, count(*) FILTER (WHERE hidden_at IS NOT NULL)::integer AS hidden FROM community.timeline_entries";

const entryColumns = [
  ["entry_id", (entry) => entry.id],
  ["title", (entry) => entry.title],
  ["full_title", (entry) => entry.fullTitle],
  ["start_year", (entry) => entry.startYear],
  ["end_year", (entry) => entry.endYear],
  ["precision", (entry) => entry.precision],
  ["date_label", (entry) => entry.dateLabel],
  ["on_axis", (entry) => entry.onAxis],
  ["chapter", (entry) => entry.chapter],
  ["polity", (entry) => entry.polity],
  ["disputed", (entry) => entry.disputed],
  ["group_id", (entry) => entry.groupId],
  ["group_title", (entry) => entry.groupTitle],
  ["province", (entry) => entry.province],
  ["holder", (entry) => entry.holder],
  ["catalog_id", (entry) => entry.catalogId],
  ["position", (entry) => entry.position],
];

/** A deliberate refusal: its message is safe to print. */
export class TimelineImportRefused extends Error {
  name = "TimelineImportRefused";
}
const refuse = (message) => {
  throw new TimelineImportRefused(message);
};

const usage =
  "Usage: import-timeline.mjs --file <absolute path> [--apply [--replace-operator-edits]]";

export function parseImportCommand(args) {
  let file;
  let apply = false;
  let replaceOperatorEdits = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--apply" && !apply) apply = true;
    else if (arg === "--replace-operator-edits" && !replaceOperatorEdits)
      replaceOperatorEdits = true;
    else if (arg === "--file" && file === undefined) {
      file = args[(index += 1)];
      if (file === undefined || file.startsWith("--")) refuse(usage);
    } else refuse(usage);
  }
  // Discarding operator edits is a write decision: a dry run never takes it.
  if (file === undefined || (replaceOperatorEdits && !apply)) refuse(usage);
  if (!isAbsolute(file)) refuse("The timeline file path must be absolute");
  return { file, apply, replaceOperatorEdits };
}

/** Parse and validate; a failure names issue paths and codes, never values. */
export async function loadImportFile(file, schema) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    refuse("The timeline file is unreadable or not JSON");
  }
  const result = schema.safeParse(parsed);
  if (result.success) return result.data;
  const { issues } = result.error;
  const shown = issues
    .slice(0, ISSUES_SHOWN)
    .map(({ path, code }) => `${path.join(".") || "(root)"} ${code}`);
  return refuse(
    `The timeline file failed validation (${issues.length} issues): ${shown.join("; ")}`,
  );
}

/**
 * The contract's whole-set check over the file: the response estimate is the
 * part the file schema does not cover.
 */
export const checkImportSet = (entries, checkTimelineEntrySet) => {
  const checked = checkTimelineEntrySet(entries);
  if (checked.ok) return;
  const { code, index } = checked.issue;
  if (code === "TIMELINE_TOO_LARGE")
    refuse("The timeline file would exceed the response size limit");
  refuse(
    `The timeline file failed the whole-set check: ${code}${index === undefined ? "" : ` at entries.${index}`}`,
  );
};

export const summarizeImport = (entries, chapters) => ({
  entries: entries.length,
  onAxis: entries.filter((entry) => entry.onAxis).length,
  linked: entries.filter((entry) => entry.catalogId !== null).length,
  chapters: chapters.map((chapter) => ({
    chapter,
    entries: entries.filter((entry) => entry.chapter === chapter).length,
  })),
});

/**
 * Parameterized multi-row INSERTs: row values reach only the bind list. Each
 * row's version is one past the replaced row of its id in `replaced` (id to
 * version), or 1 for a new id.
 */
export const insertStatements = (
  entries,
  batchRows = INSERT_BATCH_ROWS,
  replaced = new Map(),
) => {
  const columns = [
    ...entryColumns,
    ["version", (entry) => (replaced.get(entry.id) ?? 0) + 1],
  ];
  const statements = [];
  const names = columns.map(([name]) => name).join(",");
  for (let start = 0; start < entries.length; start += batchRows) {
    const batch = entries.slice(start, start + batchRows);
    const rows = batch.map(
      (_, row) =>
        `(${columns
          .map((_column, column) => `$${row * columns.length + column + 1}`)
          .join(",")})`,
    );
    statements.push({
      text: `INSERT INTO community.timeline_entries(${names}) VALUES ${rows.join(",")}`,
      values: batch.flatMap((entry) =>
        columns.map(([, value]) => value(entry)),
      ),
    });
  }
  return statements;
};

/**
 * Replaces every row in one transaction, or changes nothing. Rows an operator
 * created, edited or hid stay unless `replaceOperatorEdits`; the refusal names
 * counts only. New rows take the column defaults: 'import' as creator and
 * editor, visible. A replaced id comes back one version past the row it
 * replaces, so a version read before the import never matches the row that
 * replaces it; a new id, including one an earlier import dropped, starts at
 * version 1. One content-operator event records the counts.
 */
export async function applyImport(
  pool,
  entries,
  { replaceOperatorEdits = false } = {},
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // The wait for the shared lock counts too: an operator write in progress
    // holds the import back by at most this long.
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query(CONTENT_OPERATOR_LOCK_SQL);
    const ledger = await client.query(
      "SELECT migration_id FROM community.schema_migrations WHERE migration_id=$1",
      [TIMELINE_MIGRATION_ID],
    );
    if (ledger.rows.length !== 1)
      refuse(`Community migration ${TIMELINE_MIGRATION_ID} is not applied`);
    const { total, edited, hidden } = (await client.query(OPERATOR_ROWS_SQL))
      .rows[0];
    if ((edited > 0 || hidden > 0) && !replaceOperatorEdits)
      refuse(
        `The timeline holds ${edited} operator-edited and ${hidden} hidden rows; --replace-operator-edits discards them`,
      );
    const replaced = new Map(
      (
        await client.query(
          "DELETE FROM community.timeline_entries RETURNING entry_id,version",
        )
      ).rows.map(({ entry_id, version }) => [entry_id, version]),
    );
    for (const { text, values } of insertStatements(
      entries,
      INSERT_BATCH_ROWS,
      replaced,
    ))
      await client.query(text, values);
    const counts = {
      entries: entries.length,
      replaced: total,
      operatorEdited: edited,
      hidden,
    };
    await client.query(
      "INSERT INTO community.content_operator_events(id,operator_label,action,content_type,content_id,detail) VALUES($1,'import','timeline.import','timeline_entry',NULL,$2)",
      [randomUUID(), JSON.stringify(counts)],
    );
    await client.query("COMMIT");
    return counts;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const printSummary = (log, summary) => {
  log(
    `Entries ${summary.entries}, on axis ${summary.onAxis}, linked ${summary.linked}`,
  );
  for (const { chapter, entries } of summary.chapters)
    log(`  ${chapter} ${entries}`);
};

const loadContract = () => import("../packages/contracts/dist/schemas.js");

const openMigrationPool = async (environment) => {
  // Build the shared server packages first, as for the community migrations.
  const { parsePostgresConfig, createPostgresPool, closePostgresPool } =
    await import("../services/catalog-postgres/dist/index.js");
  const pool = createPostgresPool(
    parsePostgresConfig({
      DATABASE_URL: environment[migrationVariable],
      DATABASE_SSL_CA_FILE: environment.APP_MIGRATION_DATABASE_SSL_CA_FILE,
    }),
  );
  return { pool, close: () => closePostgresPool(pool) };
};

export async function runTimelineImport(
  environment = process.env,
  args = process.argv.slice(2),
  {
    contract = loadContract,
    openPool = openMigrationPool,
    log = console.info,
  } = {},
) {
  const command = parseImportCommand(args);
  const {
    checkTimelineEntrySet,
    timelineChapterSchema,
    timelineImportFileSchema,
  } = await contract();
  const { entries } = await loadImportFile(
    command.file,
    timelineImportFileSchema,
  );
  checkImportSet(entries, checkTimelineEntrySet);
  const summary = summarizeImport(entries, timelineChapterSchema.options);
  printSummary(log, summary);
  if (!command.apply) {
    log("Timeline import: dry run, nothing written");
    return summary;
  }
  if (!environment[migrationVariable])
    refuse(`Missing migration setting: ${migrationVariable}`);
  const { pool, close } = await openPool(environment);
  let applied;
  try {
    applied = await applyImport(pool, entries, {
      replaceOperatorEdits: command.replaceOperatorEdits,
    });
  } finally {
    await close();
  }
  if (applied.operatorEdited > 0 || applied.hidden > 0)
    log(
      `Discarded ${applied.operatorEdited} operator-edited and ${applied.hidden} hidden rows`,
    );
  log(`Timeline import: PASS (${entries.length} rows replaced)`);
  return summary;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await runTimelineImport();
  } catch (error) {
    // Driver errors can echo connection strings or bound row values; only a
    // deliberate refusal names its reason.
    console.error(
      error instanceof TimelineImportRefused
        ? error.message
        : "Timeline import failed",
    );
    process.exitCode = 1;
  }
}
