import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { URL, fileURLToPath } from "node:url";

import { classifyTask } from "./ci-task-scope.mjs";

/**
 * Agent Connections V1 (Issue #141) — the acceptance harness is only evidence
 * if CI actually runs it.
 *
 * These assertions live in a dependency-free script test on purpose. A change
 * to `.github/workflows/` routes to the LIGHTWEIGHT job and to nothing else,
 * by the classifier's own design ("a workflow path cannot name the job an
 * edit affects"), and the lightweight entry runs every script test. So a
 * later edit that deleted the step, made it conditional, or let it fail
 * softly is caught by the one job such an edit selects. A Vitest architecture
 * test would have been selected by the `test` job, which that edit does not
 * start.
 */

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) =>
  readFileSync(new URL(file, new URL("../", import.meta.url)), "utf8");

// The mandatory run is on the PostgreSQL 16 service. The PostgreSQL 18 run it
// was first added as stays in the job behind the workflow's one switch,
// CI_POSTGRES_18, which the Owner paused on 2026-11-05.
const STEP = "Development OAuth consent and Backend tool read on PostgreSQL 16";
const STEP_18 =
  "Development OAuth consent, revocation and a real Backend tool read";
const OPERATOR_STEP =
  "Login door consent in two browsers and the official SDK client";
const COMMAND = "pnpm test:cms:agent-connections --profile complete";
const PRODUCTION_BROWSER = "pnpm test:cms:browser --profile complete";
const PG16_URL =
  "CMS_TEST_DATABASE_URL: postgresql://cms_qa@127.0.0.1:5433/cms_synthetic_test";
const PG18_URL =
  "CMS_TEST_DATABASE_URL: postgresql://cms_qa@127.0.0.1:5432/cms_synthetic_test";

// One step's own lines: from its `- name:` line to the next step or the end.
const stepOf = (job, name) => {
  const at = job.indexOf(`      - name: ${name}\n`);
  if (at < 0) return { at, body: "" };
  const next = job.indexOf("\n      - ", at + 1);
  return { at, body: job.slice(at, next < 0 ? undefined : next) };
};

const cmsJob = () => {
  const workflow = read(".github/workflows/ci.yml");
  const after = workflow.split("\n  cms:\n")[1];
  assert.ok(after, "the cms job must exist");
  // Bounded by the NEXT job key rather than by a neighbour's name. Splitting
  // on the literal "\n  build:\n" meant renaming an unrelated job swallowed
  // every job after this one into the slice, and the whole-job assertions
  // below then failed while pointing at the wrong thing entirely.
  const next = /\n {2}[a-z][a-z0-9_-]*:\n/u.exec(after);
  const job = next ? after.slice(0, next.index) : after;
  assert.ok(job.includes("runs-on:"), "the cms job slice must be a job");
  return job;
};

describe("the agent-connections acceptance runs in CI", () => {
  it("is a mandatory step of the cms job, after its browser preparation", () => {
    const job = cmsJob();
    const { at: step, body } = stepOf(job, STEP);
    assert.ok(step > 0, "the named step must exist");
    // After the Playwright install: the harness drives a real browser and
    // would otherwise fail on a missing one rather than on its own property.
    assert.ok(step > job.indexOf("playwright install --with-deps"));
    // And after BOTH Production Admin browser checks, which keep running
    // against a tree this harness has not touched.
    assert.ok(step > job.lastIndexOf(`run: ${PRODUCTION_BROWSER}`));
    assert.ok(body.includes(`run: ${COMMAND}\n`), "it runs the acceptance");
    // On the PostgreSQL 16 service, the minimum supported Production major.
    assert.ok(body.includes(`${PG16_URL}\n`), "it uses the 5433 service");
    assert.doesNotMatch(body, /:5432\//u, "not the PostgreSQL 18 service");
    // The COMPLETE profile, not a shorter one: the acceptance is the point.
    assert.doesNotMatch(job, /test:cms:agent-connections --profile feedback/u);
  });

  it("keeps the PostgreSQL 18 run, behind the one switch only", () => {
    const job = cmsJob();
    const { at, body } = stepOf(job, STEP_18);
    // Paused, not deleted: setting CI_POSTGRES_18 to "on" brings it back.
    assert.ok(at > 0, "the PostgreSQL 18 run must still exist");
    assert.ok(at < stepOf(job, STEP).at, "it precedes the mandatory run");
    assert.ok(at > job.lastIndexOf(`run: ${PRODUCTION_BROWSER}`));
    assert.ok(body.includes(`${PG18_URL}\n`), "it uses the 5432 service");
    assert.ok(body.includes(`run: ${COMMAND}\n`));
    const conditions = [...body.matchAll(/^\s+if:\s*(.+)$/gmu)].map((match) =>
      match[1].trim(),
    );
    assert.deepEqual(conditions, ["env.CI_POSTGRES_18 == 'on'"]);
    assert.doesNotMatch(body, /continue-on-error|\|\|\s*true/u);
    // Exactly these two runs, so a third copy cannot stand in for either.
    assert.equal(job.split(`run: ${COMMAND}\n`).length - 1, 2);
  });

  it("cannot pass softly", () => {
    const job = cmsJob();
    const at = stepOf(job, STEP).at;
    // Without this the whole check passes vacuously when the step is gone:
    // `indexOf` answers -1, `slice(-1)` is one character, and none of the
    // patterns below match one character. Measured by deleting the step.
    assert.ok(at > 0, "the named step must exist to be checked");
    const tail = job.slice(at);
    // No soft failure, no condition, and no `|| true` shell escape. Each is a
    // way to keep a green job while the acceptance never ran or never passed.
    assert.doesNotMatch(tail, /continue-on-error/u, "step must not soft-fail");
    assert.doesNotMatch(tail, /^\s+if:/mu, "step must not be conditional");
    assert.doesNotMatch(tail, /\|\|\s*true/u, "step must not swallow failure");
    // Nothing from this step is uploaded. The harness holds two access tokens
    // and a synthetic Owner credential in its session directory, and an
    // artifact upload here would carry them out of the runner.
    assert.doesNotMatch(tail, /upload-artifact/u, "step must upload nothing");

    // THE JOB, NOT ONLY THE STEP. Slicing from the step leaves every
    // job-level key outside the checks above, and an independent review
    // showed three mutations that broke the property while every assertion
    // stayed green: `continue-on-error: true` on the job, `if: false` on the
    // job, and deleting the Playwright preparation step the harness needs.
    // All three are measured, not hypothetical.
    assert.doesNotMatch(job, /continue-on-error/u, "job must not soft-fail");
    // The job's own condition is the classifier's, exactly. Anything else --
    // `false`, a narrower expression, a different output -- means the
    // acceptance can be skipped on a pull request that changed it.
    const conditions = [...job.matchAll(/^\s{4}if:\s*(.+)$/gmu)].map((match) =>
      match[1].trim(),
    );
    assert.deepEqual(conditions, ["needs.classify_e2e.outputs.cms == 'true'"]);
    // And the preparation the step depends on still exists. Without it the
    // harness has no Chromium, and the ordering assertion above would be
    // comparing against -1.
    assert.ok(
      job.includes("- name: Prepare native Admin browser validation"),
      "the browser preparation step must exist",
    );
    assert.ok(
      job.includes("playwright install --with-deps"),
      "the browser preparation step must install Chromium",
    );
  });

  it("runs the login door's operator profile beside the read-only one", () => {
    const job = cmsJob();
    const readOnly = job.indexOf(`- name: ${STEP}`);
    const at = job.indexOf(`- name: ${OPERATOR_STEP}`);
    assert.ok(at > readOnly && readOnly > 0, "the named step must follow it");
    const step = job.slice(at);
    assert.match(step, /AGENT_AUTHORIZATION_PROFILE: operator\n/u);
    assert.match(
      step,
      /CMS_TEST_DATABASE_URL: \S+:5433\/cms_synthetic_test\n/u,
    );
    assert.ok(step.includes("playwright install --with-deps webkit"));
    assert.ok(step.includes(COMMAND));
    // The read-only step keeps running without that setting.
    assert.doesNotMatch(
      job.slice(readOnly, at),
      /AGENT_AUTHORIZATION_PROFILE/u,
    );

    const harness = read("scripts/editorial/verify-agent-connections.mjs");
    // The Admin refuses to compose under `operator` unless these two names agree.
    assert.match(
      harness,
      /AGENT_AUTHORIZATION_ENVIRONMENT: OPERATOR\s*\?\s*session\.env\.CMS_ENVIRONMENT\s*:\s*"development"/u,
    );
    for (const child of [
      "tests/cms/agent-connections-browser.mjs",
      "tests/cms/agent-connections-generic-client.mjs",
    ])
      assert.match(
        read(child),
        /process\.env\.AGENT_AUTHORIZATION_PROFILE === "operator"\) \{\n {2}await operatorAcceptance\(\);/u,
        child,
      );
    // Compared exactly, in both engines, so a skipped stage is a failure.
    assert.ok(harness.includes('["chromium", "webkit"].flatMap'));
    assert.ok(harness.includes("GENERIC_CLIENT_RESULT_INCOMPLETE"));
    // The major the step names is held by the harness, not by the port alone.
    assert.match(step, /TEST_DATABASE_EXPECTED_VERSION_NUM: "160015"\n/u);
    assert.match(
      harness,
      /process\.env\.TEST_DATABASE_EXPECTED_VERSION_NUM;[\s\S]{0,400}throw new Error\("AGENT_CONNECTIONS_POSTGRES_VERSION_MISMATCH"\)/u,
    );
  });

  it("keeps the Production Admin browser coverage it was added beside", () => {
    const job = cmsJob();
    assert.ok(job.includes(`run: ${PRODUCTION_BROWSER}`));
    assert.ok(
      job.includes(
        "Native Owner create, publish, autosave, batch approval and restore",
      ),
    );
    // The one that runs while PostgreSQL 18 is paused: unconditional, 5433.
    const pg16 = stepOf(job, "Native Owner browser flow on PostgreSQL 16");
    assert.ok(pg16.at > 0, "the PostgreSQL 16 Owner browser flow must exist");
    assert.ok(pg16.body.includes(`${PG16_URL}\n`));
    assert.ok(pg16.body.includes(`run: ${PRODUCTION_BROWSER}\n`));
    assert.doesNotMatch(pg16.body, /^\s+if:/mu);
    // Two harnesses, two claims, neither standing in for the other. The
    // production one boots the STANDALONE build, where every
    // Development-gated surface is absent from the emitted JavaScript rather
    // than merely switched off; the acceptance one boots `next dev`, which is
    // the only place those surfaces exist at all. Asserted by their entry
    // points, because that difference is the whole reason both are kept.
    const production = read("scripts/editorial/verify-owner-browser.mjs");
    assert.ok(
      production.includes(".next/standalone/apps/admin"),
      "the production harness must still boot the standalone build",
    );
    assert.ok(
      production.includes("tests/cms/owner-browser.mjs"),
      "the production harness must still run the Owner browser suite",
    );
    const acceptance = read("scripts/editorial/verify-agent-connections.mjs");
    assert.ok(
      acceptance.includes(
        '"node_modules/next/dist/bin/next",\n          "dev"',
      ),
      "the acceptance harness must boot next dev, where the surface exists",
    );
    assert.ok(
      acceptance.includes("tests/cms/agent-connections-browser.mjs"),
      "the acceptance harness must run its own browser suite",
    );
  });

  it("routes the files it depends on to the cms job", () => {
    for (const file of [
      "scripts/editorial/verify-agent-connections.mjs",
      "scripts/editorial/agent-connections-backend.mjs",
      "tests/cms/agent-connections-browser.mjs",
      "tests/cms/agent-connections-operator-kit.mjs",
      "services/agent-authorization/src/main.ts",
      "apps/admin/src/agent-connections/resource.ts",
    ]) {
      const plan = classifyTask([file]);
      assert.equal(plan.cms, true, file);
    }
  });

  it("fails acceptance when the Backend read did not happen", () => {
    const harness = read("scripts/editorial/verify-agent-connections.mjs");
    // The gate itself, by its literal text: a summary that does not say
    // VERIFIED throws, whatever the earlier stages reported.
    assert.match(
      harness,
      /summary\.backendToolRead !== "VERIFIED"\)\s*\n?\s*throw new Error\("BACKEND_TOOL_READ_NOT_VERIFIED"\)/u,
    );
    // The target is asserted disposable before the first DDL, like every
    // other entry point that issues DDL.
    assert.ok(
      harness.includes("await verifyLoopbackDisposableTarget(process.env)"),
      "the harness must assert its target is disposable before any DDL",
    );
    // Anchored on the CALL and on the STATEMENT. The obvious spelling --
    // `indexOf("verifyLoopbackDisposableTarget") < indexOf("CREATE DATABASE")`
    // -- compares the import against a comment, and stayed green when the
    // call was moved to after the DDL.
    const marker = harness.indexOf(
      "await verifyLoopbackDisposableTarget(process.env)",
    );
    const ddl = harness.indexOf("control.query(`CREATE DATABASE");
    assert.ok(marker > 0 && ddl > 0, "both anchors must exist");
    assert.ok(marker < ddl, "that assertion must precede CREATE DATABASE");
    // And the three read stages are part of the exact expected sequence.
    for (const stage of [
      "backend-read-returns-the-seeded-record",
      "backend-read-denied-after-disconnect",
      "backend-read-restored-by-fresh-consent",
    ])
      assert.ok(harness.includes(`"${stage}"`), stage);

    // The two children that carry the generic-interoperability evidence are
    // started by the harness and their failure is a hard failure. Named here
    // so deleting either is caught by a dependency-free script test rather
    // than by noticing the stage count dropped.
    for (const [child, code] of [
      [
        "tests/cms/agent-connections-callback-policy.mjs",
        "CALLBACK_POLICY_CHECK_FAILED",
      ],
      [
        "tests/cms/agent-connections-generic-client.mjs",
        "GENERIC_CLIENT_CHECK_FAILED",
      ],
    ]) {
      assert.ok(harness.includes(child), child);
      assert.ok(harness.includes(`throw new Error("${code}")`), code);
    }
  });

  it("refuses to start a Backend that is not a disposable target this harness owns", () => {
    const backend = read("scripts/editorial/agent-connections-backend.mjs");
    for (const gate of [
      // Development only, and an explicit opt-in besides.
      'process.env.NODE_ENV !== "development"',
      'process.env[ENABLED] !== "true"',
      // Loopback, both for the listener and for the database.
      "guard.isLoopbackHostname(url.hostname)",
      'listen: { host: "127.0.0.1", port }',
      // A name this harness owns, by pattern rather than by allowance.
      "OWNED_DATABASE.test(name)",
      // The marker verified on the database actually connected to.
      "guard.assertDisposableTestTarget(probe.rows, name)",
      // The URL carries no `?host=` / `?port=` / `?user=` override, because
      // the hostname is not where `pg` connects when one is present.
      "DATABASE_URL_CARRIES_OVERRIDES",
      // And a role that is not another service's -- with all three peers
      // required, so the check cannot be silently skipped.
      "BACKEND_ROLE_SHARED_WITH_ANOTHER_SERVICE",
      "PEER_ROLE_URLS_REQUIRED",
      "AGENT_AUTHORIZATION_DATABASE_URL",
    ])
      assert.ok(backend.includes(gate), gate);
    // Every named gate is REACHED THROUGH `refuse(`, so one downgraded to a
    // warning fails here. Presence alone could not tell the difference:
    // rewriting a check as `console.warn(...)` keeps every substring above
    // intact while the gate stops gating.
    //
    // The codes are listed rather than swept out of the file, because a sweep
    // cannot tell a refusal code from an environment variable name and would
    // fail on the peer-role list above -- measured, and the reason this is a
    // list.
    // Collected by scanning FORWARD from each `refuse(` rather than by
    // matching a literal first argument. Two of this file's refusals pass a
    // ternary -- `refuse(cond ? error.message : "CODE")` -- and a pattern
    // anchored on `refuse("` is structurally incapable of seeing them. That
    // was the defect in the first version of this check, and it let the
    // marker probe's whole catch block be replaced with `catch { }` while
    // every assertion here stayed green. Measured, twice.
    // Comments stripped FIRST. Neither this sweep nor the anchored catch
    // below can tell live code from a comment, and a refusal commented out
    // while debugging and never restored leaves the gate dead with the string
    // still present -- measured, and the same class as the defect this check
    // was written to fix, one level down.
    const live = backend
      .replaceAll(/\/\*[\s\S]*?\*\//gu, "")
      .replaceAll(/^\s*\/\/.*$/gmu, "");
    // Each window is the call's OWN argument list, found by balancing
    // parentheses from `refuse(`. A fixed width, or a window ending at the
    // next call, collects codes belonging to a neighbour: the call sites sit
    // as close as 73 characters apart, so deleting a refusal and leaving its
    // code as a quoted string nearby still registered it as refused.
    const refusals = new Set();
    for (const call of live.matchAll(/\brefuse\(/gu)) {
      let depth = 0;
      let end = call.index + call[0].length - 1;
      for (; end < live.length; end += 1) {
        if (live[end] === "(") depth += 1;
        else if (live[end] === ")") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      for (const code of live
        .slice(call.index, end)
        .matchAll(/"([A-Z][A-Z0-9_]{2,63})"/gu))
        refusals.add(code[1]);
    }
    for (const code of [
      "DATABASE_REQUIRED",
      "DATABASE_MALFORMED",
      "NOT_DEVELOPMENT",
      "NOT_ENABLED",
      "DATABASE_NOT_LOOPBACK",
      "DATABASE_URL_CARRIES_OVERRIDES",
      "DATABASE_PORT_REQUIRED",
      "DATABASE_NOT_HARNESS_OWNED",
      "OPERATOR_CREDENTIAL_REQUIRED",
      "PORT_INVALID",
      // The marker gate. Its refusal lives in a catch block, and removing
      // that block is the mutation that neutered safeguard #5 unnoticed.
      "DISPOSABLE_TARGET_PROBE_FAILED",
      "ACTING_ROLE_UNREADABLE",
      "PEER_ROLE_URLS_REQUIRED",
      "BACKEND_ROLE_SHARED_WITH_ANOTHER_SERVICE",
      "ACCEPTANCE_BACKEND_FAILED",
    ])
      assert.ok(refusals.has(code), `${code} must be reached through refuse()`);
    assert.doesNotMatch(
      live,
      /console\.warn|console\.log/u,
      "a refusal is never a warning",
    );

    // THE GUARDING CATCHES, ANCHORED. A code can appear at two sites, so its
    // presence cannot tell that one of them stopped refusing: replacing the
    // `current_user` catch with `actingRole = "unknown"` leaves the string
    // intact at the second site AND makes the role comparison match nothing,
    // which is the check passing for no reason. Measured.
    //
    // Anchored on the two catches that guard a gate, rather than on a blanket
    // "every catch must refuse" rule -- the peer-URL catch legitimately
    // assigns the FAILING value instead of refusing, and a rule with an
    // exception is the drift this is trying to prevent.
    for (const [label, anchor] of [
      ["the disposable-marker probe", "guard.assertDisposableTestTarget("],
      ["the acting-role read", '"SELECT current_user AS role"'],
    ]) {
      const at = live.indexOf(anchor);
      assert.ok(at > 0, `${label} must exist`);
      assert.match(
        live.slice(at, at + 400),
        /\}\s*catch[^}]*refuse\(/su,
        `${label} must refuse when it fails`,
      );
    }
    // And the peer-URL catch's fallback must be the value the next line
    // refuses on, which is what makes NOT refusing there correct.
    assert.ok(
      backend.includes('theirs === "" || theirs === actingRole'),
      "an unreadable peer username must be treated as a collision",
    );
    // The production composition's own database-name condition is untouched.
    const production = readFileSync(
      new URL(
        "services/backend-production/src/composition.ts",
        new URL("file://" + root),
      ),
      "utf8",
    );
    assert.match(production, /assertLocalDevelopmentDatabase/u);
    assert.match(production, /yoyi_dev/u);
  });

  it("actually refuses, measured by running it", () => {
    // THE WAY OUT OF TEXT ASSERTIONS. Every check above reads source, and
    // source-reading cannot tell a live refusal from a commented-out one, a
    // conditional one, or one whose code merely appears nearby. This runs the
    // script and reads what it emits.
    //
    // Ten of its fifteen refusals are reachable this way, because all ten sit
    // BEFORE the first `dist` import: no database is contacted, no listener
    // opens, nothing is built, and each spawn is a bare Node start. That is
    // what makes a behavioural check affordable in a dependency-free script
    // test.
    // No connection string here carries a username or a password, and the
    // operator value is generated rather than written down. None of the ten
    // gates below reads userinfo, so nothing is lost -- and the repository's
    // confidentiality scanner is right to refuse a `user:secret@host` literal
    // in a source file even when the secret is obviously fake. It blocked an
    // earlier version of this test, which is the scanner working.
    const owned = "x_synthetic_test_agent_conn_deadbeef";
    const at = (authority, database = owned) =>
      `postgres://${authority}/${database}`;
    const sound = {
      NODE_ENV: "development",
      AGENT_ACCEPTANCE_BACKEND_ENABLED: "true",
      AGENT_ACCEPTANCE_BACKEND_PORT: "54997",
      COMMUNITY_OPERATOR_TOKEN: randomBytes(32).toString("hex"),
      AGENT_ACCEPTANCE_BACKEND_DATABASE_URL: at("127.0.0.1:5432"),
    };
    const refusalOf = (overrides) => {
      const env = { ...sound, ...overrides };
      for (const [key, value] of Object.entries(env))
        if (value === undefined) delete env[key];
      const result = spawnSync(
        process.execPath,
        ["scripts/editorial/agent-connections-backend.mjs"],
        { cwd: root, env, encoding: "utf8", timeout: 20_000 },
      );
      const line = /refused:\s*([A-Z][A-Z0-9_]{2,63})/u.exec(
        result.stderr ?? "",
      );
      return { code: line?.[1], status: result.status };
    };

    for (const [expected, overrides] of [
      ["NOT_DEVELOPMENT", { NODE_ENV: "production" }],
      ["NOT_ENABLED", { AGENT_ACCEPTANCE_BACKEND_ENABLED: undefined }],
      [
        "DATABASE_REQUIRED",
        { AGENT_ACCEPTANCE_BACKEND_DATABASE_URL: undefined },
      ],
      [
        "DATABASE_MALFORMED",
        { AGENT_ACCEPTANCE_BACKEND_DATABASE_URL: "not a url" },
      ],
      [
        "DATABASE_NOT_LOOPBACK",
        { AGENT_ACCEPTANCE_BACKEND_DATABASE_URL: at("203.0.113.9:5432") },
      ],
      [
        // The query-parameter override: the hostname still reads 127.0.0.1,
        // and `pg` would connect somewhere else entirely.
        "DATABASE_URL_CARRIES_OVERRIDES",
        {
          AGENT_ACCEPTANCE_BACKEND_DATABASE_URL: `${at("127.0.0.1:5432")}?host=203.0.113.9&port=6543`,
        },
      ],
      [
        "DATABASE_PORT_REQUIRED",
        { AGENT_ACCEPTANCE_BACKEND_DATABASE_URL: at("127.0.0.1") },
      ],
      [
        // The retained Development database, by name.
        "DATABASE_NOT_HARNESS_OWNED",
        {
          AGENT_ACCEPTANCE_BACKEND_DATABASE_URL: at(
            "127.0.0.1:5432",
            "yoyi_dev",
          ),
        },
      ],
      [
        // Below the 32-character minimum. Generated rather than written down:
        // the scanner treats any literal assigned to a *_TOKEN name as a
        // credential, and it is right to, however obviously fake the value.
        "OPERATOR_CREDENTIAL_REQUIRED",
        { COMMUNITY_OPERATOR_TOKEN: randomBytes(4).toString("hex") },
      ],
      ["PORT_INVALID", { AGENT_ACCEPTANCE_BACKEND_PORT: "0" }],
    ]) {
      const { code, status } = refusalOf(overrides);
      assert.equal(code, expected, `expected ${expected}`);
      // A refusal, not a crash and not a start: 78 is EX_CONFIG.
      assert.equal(status, 78, `${expected} must exit 78`);
    }
  });

  it("builds every workspace the services it starts depend on", () => {
    // The harness starts three processes out of `dist`. CI failed with
    // ERR_MODULE_NOT_FOUND because one workspace in that dependency
    // closure -- `@moya/public-api`, reached through `backend-runtime`'s
    // health handler -- was not in the build list, and locally an older
    // build had left its `dist` behind so nothing noticed.
    //
    // So the closure is COMPUTED from the manifests rather than restated:
    // adding a dependency to any of these services now fails this test
    // instead of failing CI a commit later.
    const manifests = new Map();
    for (const base of ["packages", "services", "apps"])
      for (const name of readdirSync(join(root, base))) {
        const file = join(root, base, name, "package.json");
        if (!existsSync(file)) continue;
        const pkg = JSON.parse(readFileSync(file, "utf8"));
        manifests.set(pkg.name, {
          directory: `${base}/${name}`,
          dependencies: Object.keys(pkg.dependencies ?? {}).filter((entry) =>
            entry.startsWith("@moya/"),
          ),
        });
      }
    const required = new Set();
    const visit = (name) => {
      const manifest = manifests.get(name);
      if (!manifest || required.has(name)) return;
      required.add(name);
      for (const dependency of manifest.dependencies) visit(dependency);
    };
    // The three processes the harness starts from `dist`, by the packages
    // their entry points resolve.
    for (const entry of [
      "@moya/agent-authorization",
      "@moya/catalog-postgres",
      "@moya/community-postgres",
      "@moya/backend-runtime",
    ])
      visit(entry);

    const harness = read("scripts/editorial/verify-agent-connections.mjs");
    const built = new Set(
      [...harness.matchAll(/\["[a-z-]+-build", "([a-z-]+\/[a-z-]+)"\]/gu)].map(
        (match) => match[1],
      ),
    );
    const expected = new Set(
      [...required].map((name) => manifests.get(name).directory),
    );
    assert.ok(expected.size > 1, "the closure must not be empty");
    assert.deepEqual(
      [...built].sort(),
      [...expected].sort(),
      "the harness must build exactly its services' workspace closure",
    );
  });

  it("gives the acceptance Backend a read-only role", () => {
    const grants = read(
      "infra/development/agent-connections/grant-authorization.sql",
    );
    const block = grants.slice(
      grants.indexOf("IF backend_role IS NOT NULL AND backend_role <> '' THEN"),
    );
    const body = block.slice(0, block.indexOf("END IF;"));
    assert.match(body, /GRANT SELECT ON TABLE/u);
    // No write anywhere in the Backend's block, and no reach into the
    // connection ledger: it never sees a token, only an asserted principal.
    assert.doesNotMatch(body, /INSERT|UPDATE|DELETE/u);
    assert.doesNotMatch(body, /agent_connection/u);
  });
});
