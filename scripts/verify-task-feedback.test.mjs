import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { classifyTask } from "./ci-task-scope.mjs";
import { assertTaskGate } from "./ci-task-gate.mjs";
import {
  FEEDBACK_LABEL,
  FOCUSED_FEEDBACK,
  VERIFY_TASK_USAGE,
  classifyFeedbackPath,
  contractCommands,
  feedbackCommands,
  formatFeedbackBanner,
  formatFeedbackCommandSelection,
  isFullAcceptance,
  parseVerifyTaskArgs,
  planFeedbackCommands,
  prepareFeedbackValidation,
  resolveFeedbackCheckpoint,
  scriptTests,
  selectTaskValidationCommands,
  taskCommands,
  taskChecks,
} from "./verify-task.mjs";
import { REMAINING_MS_TOKEN } from "./validation-profiles.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const script = join(root, "scripts/verify-task.mjs");

const fixtureGit = (t) => {
  const directory = mkdtempSync(join(tmpdir(), "verify-task-feedback-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Synthetic task fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Synthetic task fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const name of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_PREFIX",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE",
  ])
    delete env[name];
  const git = (...args) =>
    execFileSync("git", ["-C", directory, ...args], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
  git("init", "--initial-branch=main");
  const put = (file, content = "content\n") => {
    mkdirSync(join(directory, dirname(file)), { recursive: true });
    writeFileSync(join(directory, file), content);
  };
  const commit = (message) => {
    git("add", "--all");
    git("commit", "-m", message);
    return git("rev-parse", "HEAD").trim();
  };
  return { directory, git, put, commit };
};

describe("feedback argument parsing and acceptance labeling", () => {
  it("documents feedback mode and rejects --since on other modes", () => {
    assert.match(VERIFY_TASK_USAGE, /feedback/);
    assert.deepEqual(
      parseVerifyTaskArgs([
        "--mode",
        "feedback",
        "--base",
        "origin/main",
        "--since",
        "HEAD~1",
        "--output",
        "/tmp/feedback-run",
      ]),
      {
        "--mode": "feedback",
        "--base": "origin/main",
        "--since": "HEAD~1",
        "--output": "/tmp/feedback-run",
      },
    );
    assert.throws(
      () => parseVerifyTaskArgs(["--mode", "lightweight", "--since", "HEAD"]),
      /--since is only valid with --mode feedback/,
    );
    assert.throws(() => parseVerifyTaskArgs(["--mode", "mystery"]), Error);
  });

  it("never treats feedback or a failed full run as full acceptance", () => {
    assert.equal(
      isFullAcceptance({
        result: "PASS",
        mode: "feedback",
        label: FEEDBACK_LABEL,
        acceptance: false,
      }),
      false,
    );
    assert.equal(
      isFullAcceptance({ result: "FAIL", mode: "actual-diff" }),
      false,
    );
    assert.equal(
      isFullAcceptance({
        result: "FAIL",
        mode: "actual-diff",
        label: FEEDBACK_LABEL,
      }),
      false,
    );
    assert.equal(
      isFullAcceptance({ result: "PASS", mode: "lightweight" }),
      false,
    );
    assert.equal(
      isFullAcceptance({ result: "PASS", mode: "actual-diff" }),
      true,
    );
    assert.match(
      formatFeedbackBanner({
        checkpoint: { sha: "abc", source: "explicit-since" },
        notes: ["example note"],
      }),
      new RegExp(`^${FEEDBACK_LABEL}`),
    );
    assert.match(formatFeedbackBanner({}), /acceptance: false/);
  });
});

describe("feedback checkpoint and dirty-tree scope", () => {
  it("covers commits after the checkpoint plus staged, unstaged and untracked files", (t) => {
    const { git, put, commit } = fixtureGit(t);
    put("README.md", "base\n");
    const baseline = commit("baseline");
    git("checkout", "-b", "task");
    put("docs/first.md", "first\n");
    const first = commit("first preview");
    put("docs/second.md", "second\n");
    commit("second preview");
    put("docs/staged.md", "staged\n");
    git("add", "docs/staged.md");
    put("README.md", "unstaged\n");
    put("docs/untracked.md", "untracked\n");
    const resolved = resolveFeedbackCheckpoint({ since: first }, git);
    assert.equal(resolved.sha, first);
    assert.equal(resolved.source, "explicit-since");
    const detail = prepareFeedbackValidation(
      { since: first, baseRef: "main" },
      git,
    );
    assert.equal(detail.label, FEEDBACK_LABEL);
    assert.equal(detail.acceptance, false);
    assert.equal(detail.substitutesForTaskGate, false);
    assert.equal(detail.mode, "feedback");
    assert.deepEqual(
      [...detail.feedbackPaths].sort(),
      [
        "README.md",
        "docs/second.md",
        "docs/staged.md",
        "docs/untracked.md",
      ].sort(),
    );
    assert.ok(detail.feedbackPaths.includes("docs/second.md"));
    assert.ok(!detail.feedbackPaths.includes("docs/first.md"));
    assert.deepEqual(
      [...detail.cumulativePaths].sort(),
      [
        "README.md",
        "docs/first.md",
        "docs/second.md",
        "docs/staged.md",
        "docs/untracked.md",
      ].sort(),
    );
    assert.match(formatFeedbackBanner(detail), new RegExp(FEEDBACK_LABEL));
    assert.notDeepEqual(detail.feedbackPlan.paths, detail.cumulativePlan.paths);
    const tipNeeds = {
      classify_e2e: { result: "success" },
      lightweight: { result: "success" },
      browser_gate: { result: "success" },
      lint: { result: "skipped" },
      typecheck: { result: "skipped" },
      test: { result: "skipped" },
      build: { result: "skipped" },
      cms: { result: "skipped" },
      contracts: { result: "skipped" },
      apple: { result: "skipped" },
    };
    assert.throws(
      () =>
        assertTaskGate(detail.feedbackPlan, tipNeeds, {
          paths: detail.cumulativePaths,
        }),
      /Tip-only or feedback plan cannot satisfy a required cumulative task gate/,
    );
    assert.throws(
      () => assertTaskGate({ ...detail.feedbackPlan, ...detail }, tipNeeds),
      /Feedback results cannot satisfy a required cumulative task gate/,
    );
    assert.ok(!isFullAcceptance({ ...detail, result: "PASS" }));
    assert.equal(baseline.length, 40);
  });

  it("defaults to the last pushed upstream commit instead of HEAD alone", (t) => {
    const { directory, git, put, commit } = fixtureGit(t);
    put("README.md", "base\n");
    commit("baseline");
    git("checkout", "-b", "task");
    put("docs/pushed.md", "pushed\n");
    const pushed = commit("pushed preview");
    const remote = mkdtempSync(join(tmpdir(), "verify-task-feedback-remote-"));
    t.after(() => rmSync(remote, { recursive: true, force: true }));
    execFileSync("git", ["init", "--bare", remote], { encoding: "utf8" });
    git("remote", "add", "origin", remote);
    git("push", "-u", "origin", "task");
    put("docs/local.md", "local commit\n");
    commit("unpushed");
    put("docs/dirty.md", "dirty\n");
    const resolved = resolveFeedbackCheckpoint({ baseRef: "main" }, git);
    assert.equal(resolved.sha, pushed);
    assert.equal(resolved.source, "upstream");
    const detail = prepareFeedbackValidation({ baseRef: "main" }, git);
    assert.deepEqual(
      [...detail.feedbackPaths].sort(),
      ["docs/dirty.md", "docs/local.md"].sort(),
    );
    assert.ok(detail.feedbackPaths.includes("docs/dirty.md"));
    assert.ok(!detail.feedbackPaths.includes("docs/pushed.md"));
    assert.equal(directory.length > 0, true);
  });

  it("reports an unresolved checkpoint or unmapped path instead of treating it as checked", (t) => {
    const { git, put, commit } = fixtureGit(t);
    put("README.md", "base\n");
    commit("baseline");
    git("checkout", "-b", "task");
    put("docs/ok.md", "ok\n");
    commit("ok");
    assert.throws(
      () => resolveFeedbackCheckpoint({ since: "definitely-missing" }, git),
      /could not be resolved; scope is not treated as checked/,
    );
    put(".cursor/rules/preview.md", "unmapped\n");
    assert.throws(
      () => prepareFeedbackValidation({ since: "HEAD", baseRef: "main" }, git),
      /not treated as checked/,
    );
    assert.throws(
      () => classifyTask([".cursor/rules/preview.md"], "local"),
      /Unmapped changed paths/,
    );
  });
});

describe("workflow guidance names the feedback command", () => {
  it("keeps the exact non-acceptance label in the shared workflow and skills", async () => {
    const { readFileSync } = await import("node:fs");
    for (const file of [
      "docs/development/task-workflow.md",
      ".agents/skills/yoyi-task/SKILL.md",
      ".agents/skills/yoyi-review/SKILL.md",
      "AGENTS.md",
    ]) {
      const text = readFileSync(join(root, file), "utf8");
      assert.match(text, new RegExp(FEEDBACK_LABEL));
    }
    assert.match(
      readFileSync(join(root, "docs/development/task-workflow.md"), "utf8"),
      /--mode feedback --base origin\/main --output/,
    );
  });
});

describe("feedback CLI user-visible label", () => {
  it("prints the non-acceptance label and fails an unresolved checkpoint without claiming a pass", () => {
    const output = join(
      mkdtempSync(join(tmpdir(), "verify-task-feedback-cli-")),
      "run",
    );
    const result = spawnSync(
      process.execPath,
      [
        script,
        "--mode",
        "feedback",
        "--since",
        "definitely-missing-ref",
        "--output",
        output,
      ],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 15000,
      },
    );
    assert.notEqual(result.status, 0);
    const text = `${result.stdout}\n${result.stderr}`;
    assert.match(text, /not treated as checked/);
    assert.doesNotMatch(text, /"result":"PASS"/);
    assert.ok(!text.includes("FEEDBACK PASS"));
  });
});

const joined = (commands) =>
  commands.map((command) => command.join(" ")).join("\n");
// The default entry's Web check: the complete serial `verify.mjs all` plan
// under the parent's remaining time, never an unflagged (quick) invocation.
const isBareVerify = (command) =>
  command[0] === process.execPath &&
  command[1] === "scripts/verify.mjs" &&
  command[2] === "all" &&
  command[3] === "--profile" &&
  command[4] === "complete" &&
  command.at(-2) === "--remaining-ms" &&
  command.at(-1) === REMAINING_MS_TOKEN &&
  (command.length === 7 ||
    (command.length === 9 && command[5] === "--workspaces"));
const feedbackOptions = { root };

describe("feedback command selection", () => {
  it("reproduces general over-selection and limits a Web presentation-only delta", () => {
    const paths = ["apps/web/features/home/home-screen.module.css"];
    const plan = classifyTask(paths);
    assert.equal(plan.web, true);
    assert.equal(plan.cms, false);
    const general = taskCommands(plan, "/private/synthetic-output");
    assert.ok(
      general.some(isBareVerify),
      "general taskCommands still selects complete scripts/verify.mjs for Web",
    );
    assert.match(joined(general), /--test /);
    assert.doesNotMatch(
      joined(
        selectTaskValidationCommands({
          mode: "feedback",
          plan,
          detail: { feedbackPaths: paths },
          output: "/private/synthetic-output",
          options: feedbackOptions,
        }),
      ),
      /scripts\/verify\.mjs(?:\s|$)|test:cms|test:cms:browser|test:postgres|ci-e2e-smoke|verify-apple|turbo run |pnpm test(?:\s|$)/,
    );
    assert.deepEqual(
      feedbackCommands({ feedbackPaths: paths }, "/private/synthetic-output", {
        root,
      }),
      [["pnpm", "exec", "prettier", "--check", paths[0]]],
    );
    assert.equal(classifyFeedbackPath(paths[0]), "presentation");
  });

  it("selects focused Web behavior checks for a TSX change", () => {
    const paths = ["apps/web/features/home/home-screen.tsx"];
    const commands = feedbackCommands(
      { feedbackPaths: paths },
      "/private/synthetic-output",
      feedbackOptions,
    );
    assert.deepEqual(commands, [
      ["pnpm", "exec", "prettier", "--check", paths[0]],
      ["pnpm", "exec", "eslint", paths[0]],
      ["pnpm", "--filter", "web", "typecheck"],
      [
        "pnpm",
        "--filter",
        "web",
        "exec",
        "vitest",
        "run",
        "features/home/home-screen.integration.test.tsx",
        "features/home/home-screen.test.tsx",
      ],
    ]);
    assert.ok(!commands.some(isBareVerify));
    assert.doesNotMatch(
      joined(commands),
      /test:cms|test:postgres|ci-e2e-smoke|verify-apple/,
    );
    assert.equal(classifyFeedbackPath(paths[0]), "behavior");
  });

  it("widens shared-contract checks and refuses a misleading database PASS", () => {
    const contractPaths = ["packages/contracts/src/catalog.ts"];
    const contractPlan = classifyTask(contractPaths);
    assert.equal(contractPlan.contracts, true);
    assert.equal(contractPlan.cms, true);
    const general = taskCommands(contractPlan, "/private/synthetic-output");
    assert.ok(general.some((command) => command.includes("test:cms")));
    assert.ok(general.some((command) => command.includes("test:cms:browser")));
    const contractCommandsSelected = feedbackCommands(
      { feedbackPaths: contractPaths },
      "/private/synthetic-output",
      feedbackOptions,
    );
    assert.deepEqual(contractCommandsSelected, contractCommands());
    assert.doesNotMatch(
      joined(contractCommandsSelected),
      /test:cms|scripts\/verify\.mjs(?:\s|$)|test:postgres|ci-e2e-smoke/,
    );

    const databaseDetail = { feedbackPaths: ["database/schema.sql"] };
    const planned = planFeedbackCommands(
      databaseDetail,
      "/private/synthetic-output",
      feedbackOptions,
    );
    assert.equal(planned.commands.length, 0);
    assert.match(planned.unresolved, /unsupported/);
    assert.match(planned.unresolved, /database\/schema\.sql \(database\)/);
    assert.match(planned.unresolved, /not treated as checked/);
    assert.throws(
      () =>
        feedbackCommands(
          databaseDetail,
          "/private/synthetic-output",
          feedbackOptions,
        ),
      /not treated as checked/,
    );
    assert.doesNotMatch(JSON.stringify(planned), /"result":"PASS"/);
    assert.equal(classifyFeedbackPath("packages/ui/src/button.tsx"), "shared");
    assert.equal(classifyFeedbackPath("apps/web/next.config.ts"), "web-config");
    assert.equal(classifyFeedbackPath("apps/harmony/README.md"), "docs");
    assert.equal(
      classifyFeedbackPath("apps/harmony/ArtVenn/entryability.ets"),
      "harmony",
    );
    const harmonyDetail = {
      feedbackPaths: ["apps/harmony/ArtVenn/entryability.ets"],
    };
    const harmonyPlanned = planFeedbackCommands(
      harmonyDetail,
      "/private/synthetic-output",
      feedbackOptions,
    );
    assert.equal(harmonyPlanned.commands.length, 0);
    assert.match(harmonyPlanned.unresolved, /harmony/);
    assert.match(harmonyPlanned.unresolved, /not treated as checked/);
    assert.doesNotMatch(JSON.stringify(harmonyPlanned), /"result":"PASS"/);
  });

  it("keeps default, lightweight and contracts command selection unchanged", () => {
    const output = "/private/synthetic-output";
    const web = taskCommands(classifyTask(["apps/web/app/page.tsx"]), output);
    assert.deepEqual(web[0], [process.execPath, "--test", ...scriptTests()]);
    assert.ok(web.some(isBareVerify));
    assert.equal(
      web.filter((command) => command.includes("test:cms")).length,
      0,
    );
    const lightweight = taskCommands({ lightweight: true }, output);
    assert.deepEqual(lightweight, [
      [process.execPath, "--test", ...scriptTests()],
    ]);
    const contracts = taskCommands(
      { lightweight: true, contracts: true },
      output,
    );
    assert.deepEqual(contracts, [
      [process.execPath, "--test", ...scriptTests()],
      ...contractCommands(),
    ]);
    assert.deepEqual(
      selectTaskValidationCommands({
        mode: "actual-diff",
        plan: classifyTask(["apps/web/app/page.tsx"]),
        output,
      }),
      web,
    );
  });

  it("records unchecked coverage and still refuses full acceptance", () => {
    const selection = planFeedbackCommands(
      { feedbackPaths: ["apps/web/features/home/home-screen.module.css"] },
      "/private/synthetic-output",
      feedbackOptions,
    );
    assert.match(
      formatFeedbackCommandSelection(selection),
      /selected-commands: pnpm exec prettier --check /,
    );
    assert.match(formatFeedbackCommandSelection(selection), /browser smoke/);
    assert.match(
      formatFeedbackCommandSelection(selection),
      /not full acceptance/,
    );
    assert.ok(
      !isFullAcceptance({ ...selection, result: "PASS", mode: "feedback" }),
    );
    assert.ok(
      !isFullAcceptance({
        result: "PASS",
        mode: "feedback",
        label: FEEDBACK_LABEL,
        acceptance: false,
        substitutesForTaskGate: false,
        commandSelection: selection,
      }),
    );
  });
});

describe("finite Backend, Admin and shared feedback mappings", () => {
  it("selects existing focused tests and library preparation without runtime suites", () => {
    for (const [file, mapped] of Object.entries(FOCUSED_FEEDBACK)) {
      const selection = planFeedbackCommands(
        { feedbackPaths: [file] },
        "/private/synthetic-output",
        { root },
      );
      assert.equal(selection.unresolved, null, file);
      assert.equal(classifyFeedbackPath(file), "focused", file);
      const text = joined(selection.commands);
      assert.match(text, /turbo run build/u, file);
      assert.match(text, /turbo run typecheck/u, file);
      for (const test of mapped.tests)
        assert.ok(text.includes(test), `${file}: ${test}`);
      assert.doesNotMatch(
        text,
        /test:cms|test:postgres|ci-e2e-smoke|verify-apple|db:migrate/u,
        file,
      );
      assert.ok(
        selection.uncheckedCoverage.includes(
          "full acceptance / merge permission",
        ),
      );
    }
  });
  it("refuses missing mappings or missing mapped tests and preserves mixed unsupported coverage", () => {
    const known = "packages/image/src/index.ts";
    const missing = planFeedbackCommands({ feedbackPaths: [known] }, "", {
      root,
      exists: () => false,
    });
    assert.match(missing.unresolved, /Mapped feedback tests are missing/u);
    assert.deepEqual(missing.commands, []);
    for (const paths of [
      [
        "services/api/src/modules/catalog/application/services/future-service.ts",
      ],
      [known, "apps/admin/src/migrations/future.ts"],
      [known, "database/community/future.sql"],
    ]) {
      const selected = planFeedbackCommands({ feedbackPaths: paths }, "", {
        root,
      });
      assert.match(selected.unresolved, /unsupported/u);
      assert.deepEqual(selected.commands, []);
    }
  });
});

it("deduplicates focused contracts only when both complete consumers are selected", () => {
  const subset = taskChecks(
    { web: true, contracts: true, webWorkspaces: ["@moya/api"] },
    "/private/run",
  );
  assert.ok(subset.some((check) => check.name === "contracts"));
  const complete = taskChecks(
    { web: true, contracts: true, webWorkspaces: ["@moya/tests", "web"] },
    "/private/run",
  );
  assert.ok(!complete.some((check) => check.name === "contracts"));
});
