import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { URL } from "node:url";
import {
  TIMELINE_MIGRATION_ID,
  TimelineImportRefused,
  applyImport,
  estimateResponseBytes,
  insertStatements,
  loadImportFile,
  parseImportCommand,
  runTimelineImport,
  summarizeImport,
} from "./import-timeline.mjs";

// The dependency-free suite stands in for the contract; the last test uses the
// real one when the workspace has built it. Rows are fictional.
const entry = (id, overrides = {}) => ({
  id,
  title: "虚构碑",
  fullTitle: "虚构朝虚构碑",
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
const acceptAll = {
  safeParse: (data) => ({ success: true, data }),
};
const refusing = (issues) => ({
  safeParse: () => ({ success: false, error: { issues } }),
});
const standInContract = async () => ({
  timelineChapterSchema: { options: ["隋", "唐"] },
  timelineImportFileSchema: acceptAll,
});

const withFile = async (content, run) => {
  const directory = await mkdtemp(join(tmpdir(), "import-timeline-"));
  try {
    const file = join(directory, "entries.json");
    await writeFile(file, content);
    return await run(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const fakePool = ({ ledger = true, failOn } = {}) => {
  const statements = [];
  let released = 0;
  const client = {
    query: async (text) => {
      statements.push(text);
      if (failOn !== undefined && text.startsWith(failOn))
        throw new Error("driver error");
      if (text.includes("schema_migrations"))
        return {
          rows: ledger ? [{ migration_id: TIMELINE_MIGRATION_ID }] : [],
        };
      return { rows: [] };
    },
    release: () => {
      released += 1;
    },
  };
  return {
    pool: { connect: async () => client },
    statements,
    released: () => released,
  };
};

test("the command takes one absolute file and an optional --apply", () => {
  assert.deepEqual(parseImportCommand(["--file", "/data/entries.json"]), {
    file: "/data/entries.json",
    apply: false,
  });
  assert.deepEqual(
    parseImportCommand(["--apply", "--file", "/data/entries.json"]),
    { file: "/data/entries.json", apply: true },
  );
  for (const args of [
    [],
    ["--apply"],
    ["--file"],
    ["--file", "--apply"],
    ["--file", "relative/entries.json"],
    ["--file", "./entries.json"],
    ["--file", "/a.json", "--file", "/b.json"],
    ["--file", "/a.json", "--apply", "--apply"],
    ["--file", "/a.json", "--dry-run"],
    ["/a.json"],
  ])
    assert.throws(() => parseImportCommand(args), TimelineImportRefused);
});

test("a failed file names issue paths and codes, never its content", async () => {
  const secret = "不应出现的行内容";
  await withFile(`{"version":1,"title":"${secret}"`, async (file) => {
    await assert.rejects(loadImportFile(file, acceptAll), (error) => {
      assert.ok(error instanceof TimelineImportRefused);
      assert.ok(!error.message.includes(secret));
      return true;
    });
  });
  await assert.rejects(
    loadImportFile("/nonexistent/entries.json", acceptAll),
    TimelineImportRefused,
  );
  const issues = Array.from({ length: 7 }, (_, index) => ({
    path: ["entries", index, "title"],
    code: "custom",
    message: secret,
    input: secret,
  }));
  await withFile(JSON.stringify({ title: secret }), async (file) => {
    await assert.rejects(loadImportFile(file, refusing(issues)), (error) => {
      assert.ok(error instanceof TimelineImportRefused);
      assert.match(error.message, /7 issues/u);
      assert.match(error.message, /entries\.0\.title custom/u);
      assert.ok(!error.message.includes("entries.5"));
      assert.ok(!error.message.includes(secret));
      return true;
    });
  });
});

test("the summary counts chapters in contract order, axis and links", () => {
  assert.deepEqual(
    summarizeImport(
      [
        entry("a"),
        entry("b", { onAxis: false, catalogId: "catalog-a" }),
        entry("c", { chapter: "隋" }),
      ],
      ["隋", "唐", "宋辽金夏"],
    ),
    {
      entries: 3,
      onAxis: 2,
      linked: 1,
      chapters: [
        { chapter: "隋", entries: 1 },
        { chapter: "唐", entries: 2 },
        { chapter: "宋辽金夏", entries: 0 },
      ],
    },
  );
});

test("inserts bind every value, batch by batch, in file order", () => {
  const secret = "不应进入语句文本";
  const statements = insertStatements(
    [
      entry("a", { title: secret }),
      entry("b", { position: 7, catalogId: "catalog-b" }),
      entry("c"),
    ],
    2,
  );
  assert.equal(statements.length, 2);
  assert.equal(statements[0].values.length, 34);
  assert.equal(statements[1].values.length, 17);
  assert.match(
    statements[0].text,
    /^INSERT INTO community\.timeline_entries\(entry_id,title,full_title,start_year,end_year,precision,date_label,on_axis,chapter,polity,disputed,group_id,group_title,province,holder,catalog_id,position\) VALUES \(\$1,/u,
  );
  assert.ok(statements[0].text.endsWith(",$34)"));
  assert.ok(!statements[0].text.includes(secret));
  assert.equal(statements[0].values[0], "a");
  assert.equal(statements[0].values[1], secret);
  assert.equal(statements[0].values[17], "b");
  assert.equal(statements[0].values[32], "catalog-b");
  assert.equal(statements[0].values[33], 7);
  assert.equal(statements[1].values[0], "c");
});

test("apply replaces all rows inside one transaction", async () => {
  const { pool, statements, released } = fakePool();
  await applyImport(pool, [entry("a"), entry("b")]);
  assert.deepEqual(
    statements.map((text) => text.split(/\s/u)[0]),
    ["BEGIN", "SET", "SELECT", "DELETE", "INSERT", "COMMIT"],
  );
  assert.equal(statements[3], "DELETE FROM community.timeline_entries");
  assert.equal(released(), 1);
});

test("apply refuses a missing ledger entry before any write", async () => {
  const { pool, statements, released } = fakePool({ ledger: false });
  await assert.rejects(
    applyImport(pool, [entry("a")]),
    /Community migration 20261104020000 is not applied/u,
  );
  assert.ok(!statements.some((text) => /^(DELETE|INSERT)/u.test(text)));
  assert.equal(statements.at(-1), "ROLLBACK");
  assert.equal(released(), 1);
});

test("a failed batch rolls the whole replacement back", async () => {
  const { pool, statements, released } = fakePool({ failOn: "INSERT" });
  await assert.rejects(applyImport(pool, [entry("a")]), /driver error/u);
  assert.equal(statements.at(-1), "ROLLBACK");
  assert.ok(!statements.includes("COMMIT"));
  assert.equal(released(), 1);
});

test("a dry run prints counts only and never opens a connection", async () => {
  const secret = "不应出现的题名";
  await withFile(
    JSON.stringify({
      version: 1,
      entries: [entry("a", { title: secret }), entry("b", { onAxis: false })],
    }),
    async (file) => {
      const lines = [];
      const summary = await runTimelineImport({}, ["--file", file], {
        contract: standInContract,
        openPool: () => assert.fail("a dry run opened a connection"),
        log: (line) => lines.push(line),
      });
      assert.equal(summary.entries, 2);
      assert.deepEqual(lines, [
        "Entries 2, on axis 1, linked 0",
        "  隋 0",
        "  唐 2",
        "Timeline import: dry run, nothing written",
      ]);
    },
  );
});

test("apply needs the migration setting and closes its pool", async () => {
  const content = JSON.stringify({ version: 1, entries: [entry("a")] });
  await withFile(content, async (file) => {
    await assert.rejects(
      runTimelineImport({}, ["--file", file, "--apply"], {
        contract: standInContract,
        openPool: () => assert.fail("no setting, no connection"),
        log: () => undefined,
      }),
      /Missing migration setting: APP_MIGRATION_DATABASE_URL/u,
    );
    const { pool, statements } = fakePool();
    let closed = 0;
    const lines = [];
    await runTimelineImport(
      { APP_MIGRATION_DATABASE_URL: "postgresql://synthetic" },
      ["--file", file, "--apply"],
      {
        contract: standInContract,
        openPool: async () => ({
          pool,
          close: async () => {
            closed += 1;
          },
        }),
        log: (line) => lines.push(line),
      },
    );
    assert.ok(statements.includes("COMMIT"));
    assert.equal(closed, 1);
    assert.equal(lines.at(-1), "Timeline import: PASS (1 rows replaced)");
    assert.ok(!lines.join("\n").includes("synthetic"));
  });
});

const builtContract = new URL(
  "../packages/contracts/dist/schemas.js",
  import.meta.url,
);
test(
  "the built contract accepts a fictional file and refuses broken rows",
  { skip: !existsSync(builtContract) },
  async () => {
    const { timelineImportFileSchema } = await import(builtContract.href);
    const accepted = (entries) =>
      timelineImportFileSchema.safeParse({ version: 1, entries }).success;
    assert.ok(accepted([entry("a"), entry("b", { catalogId: "catalog-b" })]));
    assert.ok(!accepted([]));
    assert.ok(!accepted([entry("a", { startYear: 0 })]));
    assert.ok(!accepted([entry("a", { startYear: 700, endYear: 650 })]));
    assert.ok(!accepted([entry("a", { precision: "decade" })]));
    assert.ok(!accepted([entry("a", { chapter: "未知" })]));
    assert.ok(!accepted([entry("a", { groupId: "g" })]));
    assert.ok(!accepted([entry("a", { extra: true })]));
    assert.ok(!accepted([entry("a"), entry("a")]));
    assert.ok(
      !accepted([
        entry("a", { catalogId: "catalog-a" }),
        entry("b", { catalogId: "catalog-a" }),
      ]),
    );
  },
);

test("refuses a file whose one response could not pass the Web relay", async () => {
  const linked = Array.from({ length: 2_800 }, (_, index) =>
    entry(`row-${index}`, { catalogId: `catalog-${index}` }),
  );
  assert.ok(estimateResponseBytes(linked) > 4_000_000);
  assert.ok(estimateResponseBytes([entry("one")]) < 1_000);
});
