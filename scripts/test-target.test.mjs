import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import { describe, it } from "node:test";
import { URL, fileURLToPath } from "node:url";
import {
  DISPOSABLE_TEST_TARGET_MARKER,
  DISPOSABLE_TARGET_VARIABLE,
  assertDisposableTestTarget,
  databaseNameFromUrl,
  disposableTargetRequired,
  disposableTestTargetProbeSql,
  markCurrentDatabaseDisposableSql,
  remedyFor,
} from "./disposable-test-target.mjs";
import { checkTarget, markTarget, staticTargetCheck } from "./test-target.mjs";
import { migrationPlan } from "./migrate.mjs";
import {
  syntheticDatabase,
  verifyLoopbackDisposableTarget,
} from "./editorial/verify-cms.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) =>
  readFileSync(new URL(file, new URL("../", import.meta.url)), "utf8");
const url = (database, host = "127.0.0.1") =>
  `postgresql://synthetic_role:synthetic-secret@${host}:54329/${database}`;
const marked = (database) => [
  { database, comment: DISPOSABLE_TEST_TARGET_MARKER },
];
/** A fake query function that records statements and answers the probe. */
const fakeQuery = (rows, { markSucceeds = true } = {}) => {
  const statements = [];
  const query = async (sql) => {
    statements.push(sql);
    if (sql === markCurrentDatabaseDisposableSql) {
      if (!markSucceeds) throw new Error("permission denied");
      return { rows: [] };
    }
    if (sql === disposableTestTargetProbeSql) return { rows };
    throw new Error(`unexpected statement: ${sql.slice(0, 40)}`);
  };
  query.statements = statements;
  return query;
};
const category = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return error.message;
  }
  return "PASS";
};

describe("disposable target identification is explicit and name-independent", () => {
  it("accepts exactly one row naming the expected database with the marker", () => {
    assert.equal(
      assertDisposableTestTarget(marked("moya_test"), "moya_test"),
      "moya_test",
    );
  });

  it("refuses an unmarked, mismatched, refused or malformed probe", () => {
    const cases = [
      [[{ database: "moya_test", comment: null }], "moya_test"],
      [[{ database: "moya_test", comment: "disposable" }], "moya_test"],
      [
        [{ database: "other_test", comment: DISPOSABLE_TEST_TARGET_MARKER }],
        "moya_test",
      ],
      [marked("yoyi_dev"), "yoyi_dev"],
      [marked("YOYI_DEV"), "YOYI_DEV"],
      [[], "moya_test"],
      [[...marked("moya_test"), ...marked("moya_test")], "moya_test"],
      [[{ comment: DISPOSABLE_TEST_TARGET_MARKER }], "moya_test"],
      [marked("moya_test"), ""],
    ];
    const seen = new Set();
    for (const [rows, expected] of cases) {
      let thrown;
      assert.throws(
        () => assertDisposableTestTarget(rows, expected),
        (error) => {
          thrown = error.message;
          return /^[A-Z_]+$/u.test(error.message);
        },
      );
      seen.add(thrown);
    }
    assert.deepEqual([...seen].sort(), [
      "CONNECTED_DATABASE_MISMATCH",
      "DATABASE_NAME_MISSING",
      "DISPOSABLE_TARGET_PROBE_FAILED",
      "DISPOSABLE_TEST_TARGET_REQUIRED",
      "REFUSED_TEST_DATABASE_NAME",
    ]);
  });

  it("reads the database name the way node-postgres does", () => {
    assert.deepEqual(databaseNameFromUrl(url("moya%5Ftest")), {
      name: "moya_test",
      hostname: "127.0.0.1",
      loopback: true,
    });
    assert.equal(
      databaseNameFromUrl(url("moya_test", "db.example.invalid")).loopback,
      false,
    );
    assert.throws(
      () => databaseNameFromUrl("mysql://x@127.0.0.1/moya_test"),
      /INVALID_DATABASE_URL/u,
    );
    assert.throws(
      () => databaseNameFromUrl("not a url"),
      /INVALID_DATABASE_URL/u,
    );
    assert.throws(
      () => databaseNameFromUrl("postgresql://x@127.0.0.1:5432/"),
      /DATABASE_NAME_MISSING/u,
    );
  });

  it("only the explicit environment key makes migration require the marker", () => {
    assert.equal(
      disposableTargetRequired({ [DISPOSABLE_TARGET_VARIABLE]: "1" }),
      true,
    );
    for (const value of [undefined, "", "0", "true", "yes"])
      assert.equal(
        disposableTargetRequired({ [DISPOSABLE_TARGET_VARIABLE]: value }),
        false,
      );
    assert.equal(disposableTargetRequired(undefined), false);
  });

  it("the marking SQL and the initdb file refuse yoyi_dev and unmarked names identically", () => {
    const file = read("infra/test/disposable-test-target.sql");
    // The file the container and CI run and the SQL `mark` runs are one block.
    const block = (text) =>
      text.slice(text.indexOf("DO $$"), text.indexOf("END $$;") + 7);
    assert.equal(block(file), block(markCurrentDatabaseDisposableSql));
    for (const text of [markCurrentDatabaseDisposableSql, file]) {
      assert.match(text, /IN \('yoyi_dev'\)/u);
      assert.match(text, /!~\* '\(\^\|_\)\(test\|synthetic\)\(_\|\$\)'/u);
      assert.ok(text.includes(`'${DISPOSABLE_TEST_TARGET_MARKER}'`));
      assert.match(text, /COMMENT ON DATABASE %I IS %L/u);
    }
    assert.match(
      disposableTestTargetProbeSql,
      /shobj_description\(d\.oid, 'pg_database'\)/u,
    );
    assert.doesNotMatch(
      disposableTestTargetProbeSql,
      /COMMENT|DROP|TRUNCATE|DELETE|INSERT|UPDATE/u,
    );
    for (const code of [
      "DISPOSABLE_TEST_TARGET_REQUIRED",
      "REFUSED_TEST_DATABASE_NAME",
      "LOOPBACK_REQUIRED",
      "SYNTHETIC_DATABASE_NAME_REQUIRED",
    ])
      assert.ok(remedyFor(code).length > 20, code);
  });
});

describe("the command entry rejects unsafe targets before connecting", () => {
  it("static checks: variable, URL, suite name rule and loopback host", async () => {
    assert.equal(
      await category(
        Promise.resolve().then(() =>
          staticTargetCheck("TEST_DATABASE_URL", {}),
        ),
      ),
      "VARIABLE_MISSING",
    );
    assert.equal(
      await category(
        Promise.resolve().then(() =>
          staticTargetCheck("test_database_url", {
            test_database_url: url("moya_test"),
          }),
        ),
      ),
      "USAGE",
    );
    assert.equal(
      await category(
        Promise.resolve().then(() =>
          staticTargetCheck("TEST_DATABASE_URL", {
            TEST_DATABASE_URL: url("yoyi_dev"),
          }),
        ),
      ),
      "REFUSED_TEST_DATABASE_NAME",
    );
    assert.equal(
      await category(
        Promise.resolve().then(() =>
          staticTargetCheck("CMS_TEST_DATABASE_URL", {
            CMS_TEST_DATABASE_URL: url("cms_qa"),
          }),
        ),
      ),
      "SYNTHETIC_DATABASE_NAME_REQUIRED",
    );
    assert.equal(
      await category(
        Promise.resolve().then(() =>
          staticTargetCheck("TEST_DATABASE_URL", {
            TEST_DATABASE_URL: url("moya_test", "db.example.invalid"),
          }),
        ),
      ),
      "LOOPBACK_REQUIRED",
    );
    assert.equal(
      await category(
        Promise.resolve().then(() =>
          staticTargetCheck("TEST_DATABASE_URL", {
            TEST_DATABASE_URL: "postgresql://x@127.0.0.1:5432/",
          }),
        ),
      ),
      "DATABASE_NAME_MISSING",
    );
    for (const query of [
      "?host=db.example.invalid",
      "?hostaddr=10.0.0.9",
      "?port=5433",
    ])
      assert.equal(
        await category(
          Promise.resolve().then(() =>
            staticTargetCheck("TEST_DATABASE_URL", {
              TEST_DATABASE_URL: `${url("moya_test")}${query}`,
            }),
          ),
        ),
        "LOOPBACK_REQUIRED",
        query,
      );
    assert.deepEqual(
      staticTargetCheck("TEST_DATABASE_URL", {
        TEST_DATABASE_URL: url("moya_synthetic_test"),
      }),
      {
        variable: "TEST_DATABASE_URL",
        value: url("moya_synthetic_test"),
        database: "moya_synthetic_test",
      },
    );
  });

  it("check passes only a marked, matching database and never connects for a refused name", async () => {
    const environment = { TEST_DATABASE_URL: url("moya_test") };
    const ok = fakeQuery(marked("moya_test"));
    assert.deepEqual(await checkTarget("TEST_DATABASE_URL", environment, ok), {
      variable: "TEST_DATABASE_URL",
      database: "moya_test",
      result: "PASS",
    });
    assert.deepEqual(ok.statements, [disposableTestTargetProbeSql]);
    assert.equal(
      await category(
        checkTarget(
          "TEST_DATABASE_URL",
          environment,
          fakeQuery([{ database: "moya_test", comment: null }]),
        ),
      ),
      "DISPOSABLE_TEST_TARGET_REQUIRED",
    );
    assert.equal(
      await category(
        checkTarget(
          "TEST_DATABASE_URL",
          environment,
          fakeQuery(marked("yoyi_dev")),
        ),
      ),
      "CONNECTED_DATABASE_MISMATCH",
    );
    assert.equal(
      await category(
        checkTarget("TEST_DATABASE_URL", environment, async () => {
          throw new Error("ECONNREFUSED");
        }),
      ),
      "DISPOSABLE_TARGET_PROBE_FAILED",
    );
    const refused = fakeQuery(marked("yoyi_dev"));
    assert.equal(
      await category(
        checkTarget(
          "TEST_DATABASE_URL",
          { TEST_DATABASE_URL: url("yoyi_dev") },
          refused,
        ),
      ),
      "REFUSED_TEST_DATABASE_NAME",
    );
    assert.deepEqual(refused.statements, []);
  });

  it("mark needs --yes, runs the guarded statement and re-probes the result", async () => {
    const environment = { TEST_DATABASE_URL: url("moya_test") };
    const untouched = fakeQuery(marked("moya_test"));
    assert.equal(
      await category(
        markTarget("TEST_DATABASE_URL", [], environment, untouched),
      ),
      "CONFIRMATION_REQUIRED",
    );
    assert.deepEqual(untouched.statements, []);
    const query = fakeQuery(marked("moya_test"));
    assert.deepEqual(
      await markTarget("TEST_DATABASE_URL", ["--yes"], environment, query),
      {
        variable: "TEST_DATABASE_URL",
        database: "moya_test",
        result: "MARKED",
      },
    );
    assert.deepEqual(query.statements, [
      markCurrentDatabaseDisposableSql,
      disposableTestTargetProbeSql,
    ]);
    assert.equal(
      await category(
        markTarget(
          "TEST_DATABASE_URL",
          ["--yes"],
          environment,
          fakeQuery(marked("moya_test"), { markSucceeds: false }),
        ),
      ),
      "MARK_FAILED",
    );
    const refused = fakeQuery(marked("yoyi_dev"));
    assert.equal(
      await category(
        markTarget(
          "TEST_DATABASE_URL",
          ["--yes"],
          { TEST_DATABASE_URL: url("yoyi_dev") },
          refused,
        ),
      ),
      "REFUSED_TEST_DATABASE_NAME",
    );
    assert.deepEqual(refused.statements, []);
  });

  it("the CLI reports a category without the connection string and exits 1", () => {
    const run = (args, env = {}) =>
      spawnSync(process.execPath, ["scripts/test-target.mjs", ...args], {
        cwd: root,
        encoding: "utf8",
        timeout: 20_000,
        env: { ...process.env, TEST_DATABASE_URL: undefined, ...env },
      });
    const refused = run(["check", "TEST_DATABASE_URL"], {
      TEST_DATABASE_URL: url("yoyi_dev"),
    });
    assert.equal(refused.status, 1);
    assert.equal(refused.stdout, "");
    const report = JSON.parse(refused.stderr);
    assert.equal(report.category, "REFUSED_TEST_DATABASE_NAME");
    assert.equal(report.result, "REFUSED");
    assert.doesNotMatch(refused.stderr, /synthetic-secret|54329|yoyi_dev/u);
    for (const args of [
      [],
      ["check"],
      ["probe", "TEST_DATABASE_URL"],
      ["check", "TEST_DATABASE_URL", "--force"],
    ]) {
      const usage = run(args, { TEST_DATABASE_URL: url("moya_test") });
      assert.equal(usage.status, 1, args.join(" "));
      assert.equal(JSON.parse(usage.stderr).category, "USAGE", args.join(" "));
    }
    const unconfirmed = run(["mark", "TEST_DATABASE_URL"], {
      TEST_DATABASE_URL: url("moya_test"),
    });
    assert.equal(
      JSON.parse(unconfirmed.stderr).category,
      "CONFIRMATION_REQUIRED",
    );
    const missing = run(["check", "TEST_DATABASE_URL"]);
    assert.equal(JSON.parse(missing.stderr).category, "VARIABLE_MISSING");
  });
});

describe("preparation entry points require the marked target", () => {
  it("verify.mjs checks the target before db:migrate and asks migrate.mjs to re-check", () => {
    const verify = read("scripts/verify.mjs");
    const plan = verify.split("const postgres = [")[1]?.split("];", 1)[0];
    const check = plan.indexOf(
      '"scripts/test-target.mjs", "check", "TEST_DATABASE_URL"',
    );
    assert.ok(check > 0);
    assert.ok(check < plan.indexOf('pnpm("db:migrate")'));
    assert.ok(check > plan.indexOf('"build"'));
    const branch = verify
      .split("process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;")[1]
      ?.split("}", 1)[0];
    assert.ok(
      branch.includes(`process.env.${DISPOSABLE_TARGET_VARIABLE} = "1";`),
    );
  });

  it("migrate.mjs keeps its routing and probes the marker before any DDL when asked", () => {
    const source = read("scripts/migrate.mjs");
    const probe = source.indexOf("disposableTargetRequired(environment)");
    assert.ok(probe > 0);
    assert.ok(
      probe < source.indexOf("assertMigrationTarget(result.rows, plan.source)"),
    );
    assert.ok(probe < source.indexOf("spawn(plan.command, plan.args"));
    assert.deepEqual(
      migrationPlan({
        MOYA_CONTENT_SOURCE: "legacy",
        DATABASE_URL: url("moya_test"),
        [DISPOSABLE_TARGET_VARIABLE]: "1",
      }),
      {
        source: "legacy",
        variable: "DATABASE_URL",
        command: "pnpm",
        args: ["--filter", "@moya/catalog-postgres", "migrate"],
      },
    );
    assert.throws(
      () =>
        migrationPlan(
          { MOYA_CONTENT_SOURCE: "legacy", DATABASE_URL: url("moya_test") },
          ["--disposable"],
        ),
      /Unsupported migration argument/u,
    );
  });

  it("verify-cms.mjs applies the suite name rule and the marker to loopback CMS targets", async () => {
    assert.equal(
      syntheticDatabase(
        url("p204_cms_synthetic_test").replace(
          "synthetic_role:synthetic-secret",
          "cms_qa",
        ),
        {},
      ),
      "postgresql://cms_qa@127.0.0.1:54329/p204_cms_synthetic_test",
    );
    for (const database of ["cms_qa", "yoyi_dev", "moya_tests"])
      assert.throws(
        () =>
          syntheticDatabase(
            `postgresql://cms_qa@127.0.0.1:5432/${database}`,
            {},
          ),
        /SYNTHETIC_DATABASE_NAME_REQUIRED/u,
        database,
      );
    assert.throws(
      () =>
        syntheticDatabase(
          "postgresql://cms_qa@db.example.invalid:5432/cms_synthetic_test",
          {},
        ),
      /SYNTHETIC_LOOPBACK_DATABASE_REQUIRED/u,
    );
    const environment = {
      CMS_TEST_DATABASE_URL:
        "postgresql://cms_qa@127.0.0.1:5432/cms_synthetic_test",
    };
    const query = fakeQuery(marked("cms_synthetic_test"));
    await verifyLoopbackDisposableTarget(environment, query);
    assert.deepEqual(query.statements, [disposableTestTargetProbeSql]);
    assert.equal(
      await category(
        verifyLoopbackDisposableTarget(
          environment,
          fakeQuery([{ database: "cms_synthetic_test", comment: null }]),
        ),
      ),
      "DISPOSABLE_TEST_TARGET_REQUIRED",
    );
    assert.equal(
      await category(
        verifyLoopbackDisposableTarget(environment, async () => {
          throw new Error("ECONNREFUSED");
        }),
      ),
      "DISPOSABLE_TARGET_PROBE_FAILED",
    );
    const remote = fakeQuery(marked("cms_synthetic_test"));
    await verifyLoopbackDisposableTarget(
      { ...environment, CMS_TEST_REMOTE_TARGET_JSON: "{}" },
      remote,
    );
    assert.deepEqual(remote.statements, []);
    const cms = read("scripts/editorial/verify-cms.mjs");
    const migrations = cms.indexOf('if (name === "migrations")');
    assert.ok(
      cms.indexOf("await verifyLoopbackDisposableTarget(session.env)") >
        migrations,
    );
    assert.ok(
      cms.indexOf("await verifyLoopbackDisposableTarget(session.env)") <
        cms.indexOf("session.assertActive();", migrations),
    );
  });

  it("CI and the local test container mark their disposable databases explicitly", () => {
    const workflow = read(".github/workflows/ci.yml");
    const testJob = workflow.split("\n  test:\n")[1]?.split("\n  cms:\n")[0];
    const cmsJob = workflow.split("\n  cms:\n")[1]?.split("\n  build:\n")[0];
    for (const [job, database, user, next] of [
      [testJob, "moya_test", "moya_test", "node scripts/verify.mjs test"],
      [cmsJob, "cms_synthetic_test", "cms_qa", "pnpm test:cms"],
    ]) {
      const mark = job.indexOf(
        "Mark the CI PostgreSQL service as a disposable test target",
      );
      assert.ok(mark > 0);
      assert.ok(mark < job.indexOf(`run: ${next}`));
      const step = job.slice(mark, job.indexOf(`run: ${next}`));
      assert.match(
        step,
        /docker exec -i "\$\{\{ job\.services\.postgres\.id \}\}" psql/u,
      );
      assert.ok(step.includes(`-U ${user} -d ${database}`));
      assert.ok(step.includes("<infra/test/disposable-test-target.sql"));
      assert.ok(job.includes(`POSTGRES_DB: ${database}`));
    }
    assert.doesNotMatch(cmsJob, /:5432\/cms_qa\b/u);
    const compose = read("compose.postgres.yml");
    assert.ok(
      compose.includes(
        "./infra/test/disposable-test-target.sql:/docker-entrypoint-initdb.d/90-disposable-test-target.sql:ro",
      ),
    );
    assert.ok(compose.includes("POSTGRES_DB: ${MOYA_TEST_DB_NAME:-moya_test}"));
  });
});
