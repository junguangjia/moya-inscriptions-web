import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  BOOTSTRAP_FAILURE_CATEGORIES,
  bootstrapFailureCategory,
  childCategory,
  createVerificationSession,
} from "./editorial/verify-cms.mjs";
import { expectedStages } from "./editorial/verify-owner-browser.mjs";

// The CMS verification session runs the synthetic bootstrap on a disposable
// database that is created once per task and never reset. These checks keep
// that stage repeatable and its refusal legible: the bootstrap namespaces its
// identities per session and names its own refusal with one bare category,
// which the session records instead of a generic child failure. No database
// is contacted; the session URL below is only validated, never opened.

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (file) => readFileSync(join(root, file), "utf8");
const database =
  "postgresql://moya_test:placeholder@127.0.0.1:1/moya_synthetic_test";
const frame = (value) => JSON.stringify(value);

describe("bootstrap failure categories", () => {
  it("reads the bootstrap's own category from its fixed FAIL line only", () => {
    const noise = [
      frame({ level: 30, msg: "Connected to database" }),
      "Error running script: /private/scripts/bootstrap-synthetic.ts",
      "    at file:///private/scripts/bootstrap-synthetic.ts:48:3",
      frame({
        syntheticBootstrap: "FAIL",
        category: "SYNTHETIC_OWNER_ALREADY_EXISTS",
      }),
      "",
    ].join("\n");
    assert.equal(
      bootstrapFailureCategory(noise),
      "SYNTHETIC_OWNER_ALREADY_EXISTS",
    );
    for (const output of [
      "",
      undefined,
      frame({ syntheticBootstrap: "created", identities: 2, mcpKey: "scoped" }),
      frame({ syntheticBootstrap: "FAIL", category: "DROP_TABLE_USERS" }),
      frame({ syntheticBootstrap: "FAIL", category: 42 }),
      frame({ category: "SYNTHETIC_OWNER_ALREADY_EXISTS" }),
      "SYNTHETIC_OWNER_ALREADY_EXISTS",
    ])
      assert.equal(bootstrapFailureCategory(output), undefined, String(output));
  });

  it("admits only bare identifiers as a child's own category", () => {
    for (const category of BOOTSTRAP_FAILURE_CATEGORIES)
      assert.equal(childCategory(category), category);
    assert.equal(
      childCategory("VERIFICATION_CHILD_FAILED"),
      "VERIFICATION_CHILD_FAILED",
    );
    for (const value of [
      undefined,
      null,
      "",
      "ok",
      "A_",
      "CHILD FAILED",
      "postgresql://moya_test:placeholder@127.0.0.1/db",
      "ERR_1",
      "_LEADING",
      "X".repeat(65),
    ])
      assert.equal(childCategory(value), undefined, String(value));
  });

  it("keeps the bootstrap, both harnesses and the vocabulary in step", () => {
    const bootstrap = read("apps/admin/scripts/bootstrap-synthetic.ts");
    // Namespaced per session: a repeated run never meets its own leftovers.
    assert.match(
      bootstrap,
      /const namespace = randomBytes\(6\)\.toString\("hex"\)/u,
    );
    assert.match(
      bootstrap,
      /`owner-\$\{namespace\}@editorial\.example\.invalid`/u,
    );
    assert.match(
      bootstrap,
      /`automation-\$\{namespace\}@editorial\.example\.invalid`/u,
    );
    assert.doesNotMatch(
      bootstrap,
      /"(?:owner|automation)@editorial\.example\.invalid"/u,
    );
    // Every refusal the bootstrap can name is in the harness vocabulary, and
    // the generic collapse is the vocabulary's last entry.
    assert.match(bootstrap, /syntheticBootstrap: "FAIL", category/u);
    for (const category of BOOTSTRAP_FAILURE_CATEGORIES)
      assert.ok(bootstrap.includes(`"${category}"`), category);
    assert.equal(
      BOOTSTRAP_FAILURE_CATEGORIES.at(-1),
      "SYNTHETIC_BOOTSTRAP_FAILED",
    );
    // Both harnesses hand the bootstrap stage that reader, and the Owner
    // browser harness reports the orchestration stage with its category.
    for (const harness of [
      "scripts/editorial/verify-owner-browser.mjs",
      "scripts/editorial/verify-agent-connections.mjs",
    ]) {
      const source = read(harness);
      const bootstrapRun = source.indexOf('"scripts/bootstrap-synthetic.ts"');
      assert.ok(bootstrapRun > 0, harness);
      const next = source.indexOf(
        "{ categorize: bootstrapFailureCategory }",
        bootstrapRun,
      );
      assert.ok(next > bootstrapRun && next - bootstrapRun < 240, harness);
    }
    const browser = read("scripts/editorial/verify-owner-browser.mjs");
    assert.match(browser, /syntheticOwnerBrowser: "FAIL", category, stage/u);
    for (const name of ["prepare", "bootstrap", "native-server", "browser"])
      assert.ok(browser.includes(`stage = "${name}";`), name);
    assert.equal(expectedStages[0], "login");
    // The benchmark reads the same handoff instead of a fixed address.
    const benchmark = read("apps/admin/scripts/benchmark-synthetic.ts");
    assert.match(benchmark, /process\.env\.CMS_QA_HANDOFF_FILE/u);
    assert.doesNotMatch(benchmark, /owner@editorial\.example\.invalid/u);
  });
});

describe("verification session child categories", () => {
  const child = (lines, code) => [
    "-e",
    `${lines.map((line) => `console.log(${JSON.stringify(line)});`).join("")}process.exit(${code});`,
  ];
  const logOf = (session, label) =>
    JSON.parse(readFileSync(join(session.directory, `${label}.log`), "utf8"));

  it("records a child's own category and throws it; the generic failure otherwise", async () => {
    const session = await createVerificationSession(
      database,
      "moya-cms-session-test-",
      60_000,
    );
    try {
      const refusal = frame({
        syntheticBootstrap: "FAIL",
        category: "SYNTHETIC_OWNER_ALREADY_EXISTS",
      });
      await assert.rejects(
        session.run(child([refusal], 1), root, "named", session.env, {
          categorize: bootstrapFailureCategory,
        }),
        /^Error: SYNTHETIC_OWNER_ALREADY_EXISTS$/u,
      );
      const named = logOf(session, "named");
      assert.deepEqual(named, {
        stage: "named",
        exitCode: 1,
        category: "SYNTHETIC_OWNER_ALREADY_EXISTS",
        summaries: [],
      });
      // The vocabulary bounds the category; the shape bounds the reader.
      await assert.rejects(
        session.run(
          child(
            [
              frame({
                syntheticBootstrap: "FAIL",
                category: "DROP_TABLE_USERS",
              }),
            ],
            1,
          ),
          root,
          "unknown",
          session.env,
          { categorize: bootstrapFailureCategory },
        ),
        /^Error: VERIFICATION_CHILD_FAILED$/u,
      );
      assert.equal(logOf(session, "unknown").category, "CHILD_FAILED");
      await assert.rejects(
        session.run(child([refusal], 1), root, "unread", session.env, {
          categorize: () => "postgresql://moya_test:placeholder@127.0.0.1/db",
        }),
        /^Error: VERIFICATION_CHILD_FAILED$/u,
      );
      assert.equal(logOf(session, "unread").category, "CHILD_FAILED");
      // Without a reader the session behaves as before.
      await assert.rejects(
        session.run(child([refusal], 1), root, "plain", session.env),
        /^Error: VERIFICATION_CHILD_FAILED$/u,
      );
      assert.equal(logOf(session, "plain").category, "CHILD_FAILED");
      // The exit code decides; a FAIL line from a child that exited 0 is not
      // a failure, and the raw line is never retained.
      const passed = await session.run(
        child([refusal], 0),
        root,
        "passed",
        session.env,
        {
          categorize: bootstrapFailureCategory,
        },
      );
      assert.ok(passed.output.includes("SYNTHETIC_OWNER_ALREADY_EXISTS"));
      assert.deepEqual(logOf(session, "passed"), {
        stage: "passed",
        exitCode: 0,
        category: "PASS",
        summaries: [],
      });
      for (const label of ["named", "unknown", "unread", "plain", "passed"])
        assert.doesNotMatch(
          readFileSync(join(session.directory, `${label}.log`), "utf8"),
          /syntheticBootstrap|placeholder/u,
        );
    } finally {
      await session.dispose();
      rmSync(session.directory, { recursive: true, force: true });
    }
  });
});
