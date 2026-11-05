import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import console from "node:console";

/**
 * home-timeline-v1: the controlled bulk step behind community.timeline_entries.
 * The rows are a private file validated against the contract, never a migration
 * and never Git. The default is a dry run that opens no connection; --apply
 * replaces every row in one transaction with the migration role, so a reader
 * sees the old set or the new one. Output carries counts only: no row content
 * and no connection string.
 */
export const TIMELINE_MIGRATION_ID = "20261105020000";
const migrationVariable = "APP_MIGRATION_DATABASE_URL";
const INSERT_BATCH_ROWS = 200;
const ISSUES_SHOWN = 5;

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

const LINKED_ROW_MEDIA_BYTES = 1_500;
const RESPONSE_BYTES_LIMIT = 4_000_000;
const usage = "Usage: import-timeline.mjs --file <absolute path> [--apply]";

export function parseImportCommand(args) {
  let file;
  let apply = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--apply" && !apply) apply = true;
    else if (arg === "--file" && file === undefined) {
      file = args[(index += 1)];
      if (file === undefined || file.startsWith("--")) refuse(usage);
    } else refuse(usage);
  }
  if (file === undefined) refuse(usage);
  if (!isAbsolute(file)) refuse("The timeline file path must be absolute");
  return { file, apply };
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
 * The one response carrying every row passes the Web relay's 4.5 MB cap only
 * with room for each linked row's image candidates.
 */
export const estimateResponseBytes = (entries) =>
  Buffer.byteLength(JSON.stringify(entries), "utf8") +
  entries.filter((entry) => entry.catalogId !== null).length *
    LINKED_ROW_MEDIA_BYTES;

export const summarizeImport = (entries, chapters) => ({
  entries: entries.length,
  onAxis: entries.filter((entry) => entry.onAxis).length,
  linked: entries.filter((entry) => entry.catalogId !== null).length,
  chapters: chapters.map((chapter) => ({
    chapter,
    entries: entries.filter((entry) => entry.chapter === chapter).length,
  })),
});

/** Parameterized multi-row INSERTs: row values reach only the bind list. */
export const insertStatements = (entries, batchRows = INSERT_BATCH_ROWS) => {
  const statements = [];
  const names = entryColumns.map(([name]) => name).join(",");
  for (let start = 0; start < entries.length; start += batchRows) {
    const batch = entries.slice(start, start + batchRows);
    const rows = batch.map(
      (_, row) =>
        `(${entryColumns
          .map(
            (_column, column) => `$${row * entryColumns.length + column + 1}`,
          )
          .join(",")})`,
    );
    statements.push({
      text: `INSERT INTO community.timeline_entries(${names}) VALUES ${rows.join(",")}`,
      values: batch.flatMap((entry) =>
        entryColumns.map(([, value]) => value(entry)),
      ),
    });
  }
  return statements;
};

/** Replaces every row in one transaction, or changes nothing. */
export async function applyImport(pool, entries) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='5s'");
    const ledger = await client.query(
      "SELECT migration_id FROM community.schema_migrations WHERE migration_id=$1",
      [TIMELINE_MIGRATION_ID],
    );
    if (ledger.rows.length !== 1)
      refuse(`Community migration ${TIMELINE_MIGRATION_ID} is not applied`);
    await client.query("DELETE FROM community.timeline_entries");
    for (const { text, values } of insertStatements(entries))
      await client.query(text, values);
    await client.query("COMMIT");
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
  const { timelineChapterSchema, timelineImportFileSchema } = await contract();
  const { entries } = await loadImportFile(
    command.file,
    timelineImportFileSchema,
  );
  if (estimateResponseBytes(entries) > RESPONSE_BYTES_LIMIT)
    refuse("The timeline file would exceed the response size limit");
  const summary = summarizeImport(entries, timelineChapterSchema.options);
  printSummary(log, summary);
  if (!command.apply) {
    log("Timeline import: dry run, nothing written");
    return summary;
  }
  if (!environment[migrationVariable])
    refuse(`Missing migration setting: ${migrationVariable}`);
  const { pool, close } = await openPool(environment);
  try {
    await applyImport(pool, entries);
  } finally {
    await close();
  }
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
