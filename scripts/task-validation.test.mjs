import assert from "node:assert/strict";
import { execPath as nodeExecPath, kill as killProcess } from "node:process";
import { performance } from "node:perf_hooks";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, URL as NodeURL } from "node:url";
import {
  assertPath,
  changedPaths,
  classifyTask,
  affectedWebWorkspaces,
  localPaths,
  nulPaths,
} from "./ci-task-scope.mjs";
import { assertTaskGate } from "./ci-task-gate.mjs";
import { assertBrowserGate, assertSmokeReport } from "./ci-e2e-gate.mjs";
import {
  contractCommands,
  feedbackValidationBudget,
  freshOutput,
  planFeedbackCommands,
  sourceFingerprint,
  taskChecks,
  taskCommands,
  taskValidationBudget,
  validate,
  validationEnvironment,
  workspaceFingerprint,
} from "./verify-task.mjs";
import {
  VALIDATION_PROFILES,
  REMAINING_MS_TOKEN,
  effectiveCeiling,
  takeProfileOptions,
  withRemaining,
} from "./validation-profiles.mjs";
import {
  GRACE_MS,
  STARTUP_MARGIN_MS,
  WEB_VERIFICATION_PROFILES,
  verificationBudgetMs,
  verificationCommands,
  verificationPlan,
  viableCeiling,
} from "./verify.mjs";
import { SMOKE_PROFILES, smokeBudget, smokeOptions } from "./ci-e2e-smoke.mjs";
import {
  CMS_FINALIZATION_MS,
  CMS_LIBRARY_WORKSPACES,
  cmsLibraryBuildArgs,
  CMS_PROFILES,
  boundedChildLimit,
  cmsBudget,
  cmsOptions,
  resolveCmsBudget,
} from "./editorial/verify-cms.mjs";
import {
  appleCommand,
  appleOptions,
  appleBudget,
  APPLE_PROFILES,
  APPLE_FINALIZATION_MS,
  remainingAppleBudget,
  assertCompatibleSdk,
  compatibleIphone,
  appleToolEvidence,
  runAppleCommand,
  appleNativeResult,
  appleInvocationResult,
  appleExecutionResult,
  appleOverall,
  safeAppleTestSummary,
  safeAppleLogSummary,
  cleanupAppleSimulator,
} from "./verify-apple.mjs";
import { runWithinBudget } from "./verify.mjs";
import { discoverWorkspaces } from "../tests/unit/architecture/workspace-scanner.ts";
import { e2eProjects } from "../tests/e2e/support/e2e-report-integrity.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFileSync(join(root, file), "utf8");
const sorted = (items) => [...items].sort();
const flags = (plan) =>
  Object.fromEntries(
    [
      "web",
      "cms",
      "contracts",
      "apple",
      "harmony",
      "harmonyNativeValidation",
      "lightweight",
      "scope",
    ].map((key) => [key, plan[key]]),
  );
const expectedFlags = (overrides = {}) => ({
  web: false,
  cms: false,
  contracts: false,
  apple: false,
  harmony: false,
  harmonyNativeValidation: "none",
  lightweight: true,
  scope: "none",
  ...overrides,
});
const temporary = (t) => {
  const directory = mkdtempSync(join(tmpdir(), "moya-task-validation-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
};
const put = (directory, file, contents = "synthetic fixture\n") => {
  const target = join(directory, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
  return target;
};
const fixtureGit = (t) => {
  const directory = temporary(t);
  // Fixture commits are local and synthetic. They never use this checkout's
  // working tree or remotes; installed checks remain enabled.
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Synthetic task fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Synthetic task fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_TERMINAL_PROMPT: "0",
  };
  // A test invoked from a Git hook must not inherit pointers to that real index.
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
  const commit = (message) => {
    git("add", "--all");
    git("commit", "-m", message);
    return git("rev-parse", "HEAD").trim();
  };
  return { directory, git, commit };
};

describe("task routing follows the complete changed-path set", () => {
  const cases = [
    [["README.md", "docs/development/task workflow.md"], {}],
    [["CLAUDE.md", "apps/apple/AGENTS.md", "apps/apple/README.md"], {}],
    [
      [
        "apps/harmony/AGENTS.md",
        "apps/harmony/CLAUDE.md",
        "apps/harmony/README.md",
      ],
      {},
    ],
    [
      ["apps/harmony/.gitignore"],
      {
        harmony: true,
        harmonyNativeValidation: "HARMONY_NATIVE_VALIDATION_NOT_YET_CONFIGURED",
      },
    ],
    [
      ["apps/harmony/ArtVenn/entryability.ets"],
      {
        harmony: true,
        harmonyNativeValidation: "HARMONY_NATIVE_VALIDATION_NOT_YET_CONFIGURED",
      },
    ],
    [
      ["apps/harmony/ArtVenn/entryability.ets", "apps/apple/ArtVenn/App.swift"],
      {
        apple: true,
        harmony: true,
        harmonyNativeValidation: "HARMONY_NATIVE_VALIDATION_NOT_YET_CONFIGURED",
      },
    ],
    [
      [
        "apps/harmony/ArtVenn/entryability.ets",
        "packages/contracts/src/catalog.ts",
      ],
      {
        contracts: true,
        cms: true,
        harmony: true,
        harmonyNativeValidation: "HARMONY_NATIVE_VALIDATION_NOT_YET_CONFIGURED",
      },
    ],
    [[".github/workflows/ci.yml", "scripts/verify-task.mjs"], {}],
    [[".github/workflows/ci.yml"], {}],
    [[".githooks/pre-commit", ".agents/skills/example/SKILL.md"], {}],
    [
      [
        ".claude/settings.json",
        ".claude/hooks/guard-bash.mjs",
        ".claude/skills/yoyi-task/SKILL.md",
        ".mcp.json",
        ".github/ISSUE_TEMPLATE/task.yml",
        "scripts/README.md",
        "scripts/agent-workflow.test.mjs",
        "scripts/task-git.mjs",
        "scripts/task-git.test.mjs",
      ],
      {},
    ],
    [["scripts/test-target.mjs"], { web: true, scope: "smoke" }],
    [
      ["scripts/disposable-test-target.mjs"],
      { web: true, cms: true, scope: "smoke" },
    ],
    [
      ["infra/test/disposable-test-target.sql"],
      { web: true, cms: true, scope: "smoke" },
    ],
    [
      ["tests/integration/postgres/synthetic-test-database.ts"],
      { web: true, cms: true, scope: "smoke" },
    ],
    [
      [
        "scripts/migrate.mjs",
        "infra/development/init-roles.sql",
        "tests/integration/postgres/catalog-postgres.test.ts",
      ],
      { web: true, scope: "smoke" },
    ],
    [["scripts/verify.mjs"], { web: true, scope: "smoke" }],
    [["scripts/ci-e2e-smoke.mjs"], { web: true, scope: "smoke" }],
    [["scripts/ci-e2e-scope.mjs"], { web: true, scope: "smoke" }],
    [
      ["tests/unit/architecture/ci-e2e-policy.test.ts"],
      { web: true, scope: "smoke" },
    ],
    [
      ["tests/unit/architecture/workspace-scanner.ts"],
      { web: true, scope: "smoke" },
    ],
    [[".editorconfig"], { web: true, scope: "smoke" }],
    [[".prettierignore"], { web: true, scope: "smoke" }],
    [["eslint.config.mjs"], { web: true, scope: "smoke" }],
    [["prettier.config.mjs"], { web: true, scope: "smoke" }],
    [["scripts/confidentiality-scan.test.mjs"], {}],
    [
      [
        "scripts/turbo-cache-prune.mjs",
        "scripts/turbo-cache-prune.test.mjs",
        "docs/development/turbo-cache-retention.md",
      ],
      {},
    ],
    [["turbo.json"], { web: true, cms: true, scope: "smoke" }],
    [["scripts/confidentiality-scan.mjs"], { web: true, scope: "smoke" }],
    [
      ["apps/apple/ArtVenn/Assets 由艺.xcassets/Contents.json"],
      { apple: true },
    ],
    [["apps/web/app/page.tsx"], { web: true, scope: "smoke" }],
    [
      ["apps/admin/src/editorial/action.ts"],
      { web: true, cms: true, scope: "smoke" },
    ],
    [["tests/cms/workflow.test.ts"], { web: true, cms: true, scope: "smoke" }],
    [["packages/contracts/src/catalog.ts"], { contracts: true, cms: true }],
    [
      ["packages/contracts/package.json"],
      { web: true, contracts: true, cms: true, scope: "smoke" },
    ],
    [
      ["packages/contracts/src/internal/catalog-import/index.ts"],
      { web: true, cms: true, scope: "smoke" },
    ],
    [
      ["packages/search/src/index.ts"],
      { web: true, cms: true, scope: "smoke" },
    ],
    [
      ["packages/image/tsconfig.json"],
      { web: true, cms: true, scope: "smoke" },
    ],
    [["services/api/package.json"], { web: true, cms: true, scope: "smoke" }],
    [
      ["services/agent-authorization/src/provider.ts"],
      { web: true, cms: true, scope: "smoke" },
    ],
    [
      ["services/agent-authorization/package.json"],
      { web: true, cms: true, scope: "smoke" },
    ],
    [
      ["services/agent-authorization/tsconfig.json"],
      { web: true, cms: true, scope: "smoke" },
    ],
    [
      [
        "apps/admin/src/agent-connections/consent.ts",
        "services/agent-authorization/src/server.ts",
      ],
      { web: true, cms: true, scope: "smoke" },
    ],
    [["services/agent-authorization/README.md"], {}],
    [
      ["services/catalog-postgres/src/adapter.ts"],
      { web: true, cms: true, scope: "smoke" },
    ],
    [
      // community-postgres reaches the cms job from r15: the Admin's
      // agent-connection control plane and resource boundary import it, so
      // `pnpm --filter admin build` builds it and the Owner-browser stage
      // runs it. The job-derived closure test is what caught this.
      [
        "packages/search/scripts/native-runtime.mjs",
        "services/community-postgres/src/index.ts",
      ],
      { web: true, cms: true, scope: "smoke" },
    ],
    [["packages/search/README.md", "services/api/README.md"], {}],
    [["services/public-api/src/openapi.ts"], { contracts: true }],
    [
      ["services/backend-runtime/src/community/session.ts"],
      { web: true, contracts: true, scope: "smoke" },
    ],
    [
      ["services/backend-runtime/src/community/auth.ts"],
      { web: true, contracts: true, scope: "smoke" },
    ],
    [
      ["packages/contracts/src/internal/editorial.ts"],
      { web: true, cms: true, scope: "smoke" },
    ],
    [
      ["packages/contracts/src/internal/editorial/contracts.ts"],
      { web: true, cms: true, scope: "smoke" },
    ],
    [
      ["packages/contracts/src/internal/community-operator.ts"],
      { web: true, cms: true, scope: "smoke" },
    ],
    [
      ["docs/prototypes/mobile-preview/README.md"],
      { web: true, scope: "smoke" },
    ],
    [["docs/design-system/assets/card.svg"], { web: true, scope: "smoke" }],
    [["pnpm-lock.yaml"], { web: true, cms: true, scope: "smoke" }],
    [
      [
        "apps/apple/ArtVenn/App.swift",
        "apps/web/app/page.tsx",
        "packages/contracts/src/catalog.ts",
      ],
      { apple: true, web: true, cms: true, contracts: true, scope: "smoke" },
    ],
  ];
  for (const [paths, expected] of cases) {
    it(`routes ${paths.join(", ")}`, () => {
      for (const event of ["pull_request", "push", "local"])
        assert.deepEqual(
          flags(classifyTask(paths, event)),
          expectedFlags(expected),
        );
    });
  }

  it("routes only the registered password operator script to full Web checks", () => {
    for (const event of ["pull_request", "push", "local"]) {
      const plan = classifyTask(
        ["scripts/provision-password-account.mjs"],
        event,
      );
      assert.deepEqual(
        flags(plan),
        expectedFlags({ web: true, scope: "smoke" }),
      );
      assert.deepEqual(plan.webWorkspaces, []);
    }
    for (const file of [
      "scripts/provision-password-account-extra.mjs",
      "scripts/nested/provision-password-account.mjs",
    ])
      assert.throws(() => classifyTask([file]), /Unmapped changed paths/);
  });

  it("routes the email-auth acceptance launcher to Web and its two template sources as documentation", () => {
    for (const event of ["pull_request", "push", "local"]) {
      assert.deepEqual(
        flags(classifyTask(["scripts/email-auth-acceptance.mjs"], event)),
        expectedFlags({ web: true, scope: "smoke" }),
      );
      for (const file of [
        "docs/development/email-auth/verification.html",
        "docs/development/email-auth/verification.txt",
      ])
        assert.deepEqual(flags(classifyTask([file], event)), expectedFlags({}));
    }
    for (const file of [
      "scripts/email-auth-acceptance-extra.mjs",
      "scripts/nested/email-auth-acceptance.mjs",
      "docs/development/email-auth/verification.htm",
      "docs/development/other/verification.html",
      "docs/development/email-auth/notes.txt",
    ])
      assert.throws(() => classifyTask([file]), /Unmapped changed paths/);
  });

  it("routes only the three registered Phase 4 fixture scripts to Web", () => {
    for (const name of [
      "materialize-phase4-fixtures",
      "seed-phase4-acceptance",
      "seed-phase4-support",
    ]) {
      for (const event of ["pull_request", "push", "local"])
        assert.deepEqual(
          flags(classifyTask([`scripts/${name}.mjs`], event)),
          expectedFlags({ web: true, scope: "smoke" }),
        );
      assert.throws(() => classifyTask([`scripts/${name}-extra.mjs`]));
      assert.throws(() => classifyTask([`scripts/nested/${name}.mjs`]));
    }
  });

  it("routes the authorization runtime to Web and its Admin integration checks", () => {
    // The exact set the classifier refused at 589ac38.
    const paths = [
      "services/agent-authorization/package.json",
      "services/agent-authorization/src/config.ts",
      "services/agent-authorization/src/index.ts",
      "services/agent-authorization/src/main.ts",
      "services/agent-authorization/src/provider.ts",
      "services/agent-authorization/src/server.ts",
      "services/agent-authorization/src/wrap.ts",
      "services/agent-authorization/tsconfig.json",
    ];
    for (const event of ["pull_request", "push", "local"])
      assert.deepEqual(
        flags(classifyTask(paths, event)),
        expectedFlags({ web: true, cms: true, scope: "smoke" }),
      );
    // One directory is registered, not a services/ wildcard: a sibling whose
    // name merely starts with the same characters is still unmapped.
    for (const file of [
      "services/agent-authorization.ts",
      "services/agent-authorization-extra/src/index.ts",
      "services/agent-relay/src/index.ts",
      "services/agent-authorization2/package.json",
    ])
      assert.throws(() => classifyTask([file]));
  });

  it("does not truncate long diffs or let metadata change the selected checks", () => {
    const paths = Array.from({ length: 1000 }, (_, i) => `docs/change ${i}.md`);
    paths.push("apps/web/app/page.tsx", "docs/change 1.md");
    const plan = classifyTask(paths);
    assert.equal(plan.paths.length, 1001);
    assert.equal(plan.web, true);
    for (const metadata of [
      { tool: "Codex", author: "web", labels: ["docs"], branch: "feat/apple" },
      { tool: "Claude", author: "apple", labels: ["web"], branch: "fix/web" },
    ])
      assert.deepEqual(classifyTask(paths, "pull_request", metadata), plan);
    assert.deepEqual(classifyTask([...paths].reverse()), plan);
  });

  it("explicit dispatch retains full Web regression without requiring an absent Apple project", () => {
    assert.deepEqual(
      flags(classifyTask([], "workflow_dispatch")),
      expectedFlags({
        web: true,
        cms: true,
        contracts: true,
        scope: "full",
      }),
    );
  });

  it("rejects unknown, malformed and incomplete input instead of reporting N/A", () => {
    for (const paths of [
      [],
      null,
      ["unknown.ts"],
      ["README.md", "unknown.ts"],
      ["scripts/new-thing.mjs"],
      ["scripts/sub/x.test.mjs"],
      [".github/dependabot.yml"],
    ])
      assert.throws(() => classifyTask(paths));
    for (const file of [
      "",
      "../README.md",
      "/README.md",
      "docs//a.md",
      "docs/./a.md",
      "docs/a\nb.md",
      "docs/a\0b.md",
      "docs\\a.md",
    ])
      assert.throws(() => assertPath(file));
    assert.doesNotThrow(() => assertPath("docs/中文 notes.md"));
    assert.throws(() => classifyTask(["README.md"], "pull_request_target"));
    for (const value of ["README.md", "README.md\0\0", null])
      assert.throws(() => nulPaths(value));
    assert.throws(() => nulPaths(""));
    assert.deepEqual(nulPaths("", true), []);
    assert.deepEqual(nulPaths("docs/中文 notes.md\0"), ["docs/中文 notes.md"]);
    const valid = "a".repeat(40);
    for (const invalid of ["", "0".repeat(40), "--bad", "HEAD"])
      assert.throws(() =>
        changedPaths("push", invalid, valid, () => "README.md\0"),
      );
    assert.throws(() =>
      changedPaths("push", valid, "b".repeat(40), () => {
        throw new Error("diff unavailable");
      }),
    );
  });
});

describe("real temporary Git comparisons", () => {
  it("uses a PR merge base and the complete push span, preserving deletes and both rename paths", (t) => {
    const { directory, git, commit } = fixtureGit(t);
    const oldPath = "services/api/src/old handler.ts";
    const newPath = "docs/moved handler.md";
    put(directory, oldPath);
    put(directory, "docs/delete me.md");
    const baseline = commit("initial synthetic tree");
    git("checkout", "-b", "task");
    mkdirSync(join(directory, "docs"), { recursive: true });
    renameSync(join(directory, oldPath), join(directory, newPath));
    rmSync(join(directory, "docs/delete me.md"));
    commit("rename runtime into docs and remove a file");
    const manyDocs = Array.from(
      { length: 310 },
      (_, i) => `docs/完整 diff ${i}.md`,
    );
    for (const file of manyDocs) put(directory, file);
    put(directory, "apps/apple/ArtVenn/resource.json", "{}\n");
    const head = commit("second commit in the push span");
    git("checkout", "main");
    put(directory, "apps/admin/base-only.ts");
    const advancedBase = commit("unrelated main advance");
    const expected = sorted([
      oldPath,
      newPath,
      "docs/delete me.md",
      ...manyDocs,
      "apps/apple/ArtVenn/resource.json",
    ]);
    const pr = changedPaths("pull_request", advancedBase, head, git);
    assert.deepEqual(sorted(pr), expected);
    assert.ok(!pr.includes("apps/admin/base-only.ts"));
    assert.deepEqual(
      sorted(changedPaths("push", baseline, head, git)),
      expected,
    );
    assert.deepEqual(
      flags(classifyTask(pr)),
      expectedFlags({ web: true, cms: true, apple: true, scope: "smoke" }),
    );
  });

  it("unions committed, staged, unstaged and untracked paths while excluding ignored files", (t) => {
    const { directory, git, commit } = fixtureGit(t);
    put(directory, ".gitignore", "ignored-output/\n");
    put(directory, "README.md", "before\n");
    put(directory, "apps/web/removed.ts");
    commit("local baseline");
    git("checkout", "-b", "task");
    put(directory, "services/api/committed.ts");
    commit("committed task change");
    put(directory, "packages/contracts/src/staged.ts", "staged\n");
    git("add", "packages/contracts/src/staged.ts");
    put(directory, "packages/contracts/src/staged.ts", "also unstaged\n");
    put(directory, "README.md", "unstaged\n");
    rmSync(join(directory, "apps/web/removed.ts"));
    put(directory, "apps/apple/ArtVenn/untracked 文件.json", "{}\n");
    put(directory, "ignored-output/noise.txt");
    const paths = localPaths("main", git);
    assert.deepEqual(
      sorted(paths),
      sorted([
        "services/api/committed.ts",
        "packages/contracts/src/staged.ts",
        "README.md",
        "apps/web/removed.ts",
        "apps/apple/ArtVenn/untracked 文件.json",
      ]),
    );
    assert.deepEqual(
      flags(classifyTask(paths, "local")),
      expectedFlags({
        web: true,
        cms: true,
        contracts: true,
        apple: true,
        scope: "smoke",
      }),
    );
  });
});

const expectedNeeds = (plan) => ({
  classify_e2e: { result: "success" },
  lightweight: { result: "success" },
  browser_gate: { result: "success" },
  ...Object.fromEntries(
    Object.entries({
      lint: plan.web,
      typecheck: plan.web,
      test: plan.web,
      build: plan.web,
      cms: plan.cms,
      contracts: plan.contracts,
      apple: plan.apple,
    }).map(([job, applies]) => [
      job,
      { result: applies ? "success" : "skipped" },
    ]),
  ),
});

describe("stable task and browser gates", () => {
  it("rejects every non-success or missing required job, including classifier and browser aggregation", () => {
    const plan = classifyTask([
      "apps/admin/src/action.ts",
      "apps/apple/App.swift",
      "packages/contracts/src/catalog.ts",
    ]);
    const needs = expectedNeeds(plan);
    assert.match(assertTaskGate(plan, needs), /executed successfully/);
    for (const job of Object.keys(needs)) {
      for (const result of [
        "failure",
        "cancelled",
        "timed_out",
        "timeout",
        "skipped",
        "",
      ]) {
        assert.throws(
          () => assertTaskGate(plan, { ...needs, [job]: { result } }),
          job,
        );
      }
      const missing = { ...needs };
      delete missing[job];
      assert.throws(() => assertTaskGate(plan, missing), job);
    }
  });

  it("accepts N/A only as skipped and rejects inconsistent or forged plans", () => {
    const plan = classifyTask(["README.md"]);
    const needs = expectedNeeds(plan);
    assert.match(assertTaskGate(plan, needs), /apple: N\/A \(not run\)/);
    for (const [job, value] of Object.entries(needs)) {
      if (value.result !== "skipped") continue;
      for (const result of [
        "success",
        "failure",
        "cancelled",
        "timed_out",
        "",
      ]) {
        assert.throws(
          () => assertTaskGate(plan, { ...needs, [job]: { result } }),
          job,
        );
      }
      const missing = { ...needs };
      delete missing[job];
      assert.throws(() => assertTaskGate(plan, missing));
    }
    for (const invalid of [
      null,
      { ...plan, web: true },
      { ...plan, version: 2 },
      { ...plan, paths: ["apps/web/page.tsx"] },
    ])
      assert.throws(() => assertTaskGate(invalid, needs));
  });

  it("rejects tip-only and feedback-labeled plans when a cumulative plan is required", () => {
    const tip = classifyTask(["README.md"]);
    const cumulative = classifyTask([
      "README.md",
      "apps/web/page.tsx",
      "packages/contracts/src/catalog.ts",
    ]);
    const tipNeeds = expectedNeeds(tip);
    const cumulativeNeeds = expectedNeeds(cumulative);
    assert.match(assertTaskGate(tip, tipNeeds), /N\/A \(not run\)/);
    assert.throws(
      () => assertTaskGate(tip, tipNeeds, { paths: cumulative.paths }),
      /Tip-only or feedback plan cannot satisfy a required cumulative task gate/,
    );
    assert.throws(
      () =>
        assertTaskGate(
          {
            ...tip,
            mode: "feedback",
            label: "FEEDBACK ONLY — NOT FULL ACCEPTANCE",
          },
          tipNeeds,
        ),
      /Feedback results cannot satisfy a required cumulative task gate/,
    );
    assert.throws(
      () =>
        assertTaskGate(
          { ...tip, acceptance: false, substitutesForTaskGate: false },
          tipNeeds,
        ),
      /Feedback results cannot satisfy a required cumulative task gate/,
    );
    assert.match(
      assertTaskGate(cumulative, cumulativeNeeds, { paths: cumulative.paths }),
      /executed successfully/,
    );
  });

  it("preserves browser N/A, explicit regression and actual native smoke evidence", () => {
    assert.match(
      assertBrowserGate("none", "success", "skipped", "skipped"),
      /NOT RUN/,
    );
    assert.doesNotThrow(() =>
      assertBrowserGate("full", "success", "skipped", "success"),
    );
    for (const result of ["failure", "cancelled", "skipped", ""]) {
      assert.throws(() =>
        assertBrowserGate("smoke", "success", result, "skipped"),
      );
      assert.throws(() =>
        assertBrowserGate("full", "success", "skipped", result),
      );
    }
    assert.throws(() =>
      assertBrowserGate("unknown", "success", "skipped", "skipped"),
    );
    const identity = {
      sourceHead: "source",
      checkoutSha: "checkout",
      tree: "tree",
      runId: "run",
      runAttempt: "1",
    };
    const report = (planned = false) => ({
      config: {
        metadata: { moyaCI: { ...identity } },
        workers: 1,
        fullyParallel: false,
        failOnFlakyTests: true,
        shard: null,
      },
      suites: [
        {
          title: "formal-web.spec.ts",
          suites: [],
          specs: [
            {
              title: "Formal root",
              file: "formal-web.spec.ts",
              tests: [
                {
                  projectName: "desktop-chromium",
                  expectedStatus: "passed",
                  status: planned ? "skipped" : "expected",
                  results: planned
                    ? []
                    : [{ retry: 0, status: "passed", errors: [] }],
                },
              ],
            },
          ],
        },
      ],
      errors: [],
      stats: {
        expected: planned ? 0 : 1,
        skipped: planned ? 1 : 0,
        unexpected: 0,
        flaky: 0,
      },
    });
    assert.deepEqual(assertSmokeReport(report(true), report(), identity), {
      passed: 1,
      skipped: 0,
      total: 1,
      retries: 0,
    });
    for (const state of ["skipped", "failed", "timedOut", "interrupted"]) {
      const failed = report();
      failed.suites[0].specs[0].tests[0].results[0].status = state;
      assert.throws(() => assertSmokeReport(report(true), failed, identity));
    }
    assert.throws(() =>
      assertSmokeReport(report(true), report(true), identity),
    );
    assert.throws(() =>
      assertSmokeReport(report(true), { ...report(), suites: [] }, identity),
    );
    assert.throws(() =>
      assertSmokeReport(report(true), report(), { ...identity, tree: "other" }),
    );
    const retried = report();
    retried.suites[0].specs[0].tests[0].results.push({
      retry: 1,
      status: "passed",
      errors: [],
    });
    assert.throws(() => assertSmokeReport(report(true), retried, identity));
  });
});

// Inspect job boundaries and their declarative wiring without adding a YAML
// dependency or running any workflow command. Runtime gate behavior is above.
const workflowJobs = () => {
  const workflow = read(".github/workflows/ci.yml");
  const body = workflow.slice(workflow.indexOf("\njobs:\n") + 7);
  const matches = [...body.matchAll(/^  ([\w-]+):\s*$/gm)];
  return {
    workflow,
    jobs: new Map(
      matches.map((match, i) => [
        match[1],
        body.slice(match.index, matches[i + 1]?.index),
      ]),
    ),
  };
};
const jobNeeds = (body) => {
  const line = body.match(/^    needs:[ \t]*(.*)$/m)?.[1] ?? "";
  if (line.startsWith("["))
    return line
      .slice(1, line.indexOf("]"))
      .split(",")
      .map((item) => item.trim());
  if (line) return [line.trim()];
  return [
    ...(
      body.match(/^    needs:\n((?:      - [\w-]+\n)+)/m)?.[1] ?? ""
    ).matchAll(/- ([\w-]+)/g),
  ].map((match) => match[1]);
};

describe("the real CI wiring preserves required-check closure", () => {
  it("keeps every selected job reachable from the stable e2e gate", () => {
    const { workflow, jobs } = workflowJobs();
    const all = classifyTask([
      "apps/admin/src/action.ts",
      "apps/apple/App.swift",
      "packages/contracts/src/catalog.ts",
    ]);
    assert.deepEqual(
      sorted(jobNeeds(jobs.get("e2e"))),
      sorted(Object.keys(expectedNeeds(all))),
    );
    for (const gate of ["e2e", "browser_gate"])
      assert.match(jobs.get(gate), /^    if:.*always\(\)/m);
    const visiting = new Set();
    const visited = new Set();
    const visit = (job) => {
      assert.ok(jobs.has(job), `missing job ${job}`);
      assert.ok(!visiting.has(job), `dependency cycle at ${job}`);
      if (visited.has(job)) return;
      visiting.add(job);
      for (const dependency of jobNeeds(jobs.get(job))) visit(dependency);
      visiting.delete(job);
      visited.add(job);
    };
    visit("e2e");
    assert.deepEqual(sorted(visited), sorted(jobs.keys()));
    for (const [job, output] of Object.entries({
      lightweight: "lightweight",
      contracts: "contracts",
      apple: "apple",
      cms: "cms",
      lint: "web",
      typecheck: "web",
      test: "web",
      build: "web",
    })) {
      assert.deepEqual(jobNeeds(jobs.get(job)), ["classify_e2e"]);
      assert.match(
        jobs.get(job),
        new RegExp(
          `^    if:.*needs\\.classify_e2e\\.outputs\\.${output} == 'true'`,
          "m",
        ),
      );
    }
    assert.match(jobs.get("e2e"), /NEEDS_JSON:.*toJSON\(needs\)/);
    assert.match(jobs.get("e2e"), /PLAN:.*needs\.classify_e2e\.outputs\.plan/);
    assert.match(jobs.get("e2e"), /node scripts\/ci-task-gate\.mjs/);
    assert.match(jobs.get("classify_e2e"), /fetch-depth: 0/);
    assert.match(jobs.get("classify_e2e"), /node scripts\/ci-task-scope\.mjs/);
    assert.match(workflow, /github\.workflow/);
    assert.match(workflow, /github\.event_name/);
    assert.match(workflow, /github\.ref/);
    assert.match(
      workflow,
      /github\.event\.pull_request\.number \|\| github\.run_id/,
    );
    assert.match(
      workflow,
      /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/,
    );
    assert.doesNotMatch(
      workflow,
      /^\s*(?:paths|paths-ignore|pull_request_target|continue-on-error):/m,
    );
  });

  it("routes the files the PostgreSQL and Web jobs execute to those jobs", () => {
    const { jobs } = workflowJobs();
    const entry = "scripts/editorial/verify-cms.mjs";
    const imported = [
      ...read(entry).matchAll(/\bfrom\s+"(\.\.?\/[^"]+)"/gu),
    ].map((match) => relative(root, resolve(root, dirname(entry), match[1])));
    const redirected = (job) =>
      [...jobs.get(job).matchAll(/\s<([\w./-]+)/gu)].map((match) => match[1]);
    const marker = "infra/test/disposable-test-target.sql";
    assert.match(jobs.get("cms"), /run: pnpm test:cms --profile complete\n/);
    assert.match(
      jobs.get("cms"),
      /run: pnpm test:cms:browser --profile complete\n/,
    );
    assert.ok(imported.includes("scripts/disposable-test-target.mjs"));
    assert.ok(
      imported.includes(
        "tests/integration/postgres/synthetic-test-database.ts",
      ),
    );
    assert.ok(redirected("cms").includes(marker));
    assert.ok(redirected("test").includes(marker));
    for (const file of [...imported, ...redirected("cms")])
      assert.equal(classifyTask([file]).cms, true, file);
    for (const file of redirected("test"))
      assert.equal(classifyTask([file]).web, true, file);
    // Only the Web-selected jobs run the verify.mjs stage plans, each as its
    // own explicit complete profile (the test job through its CI milestone).
    const stages = new Map([
      ["lint", "lint --profile complete"],
      ["typecheck", "typecheck --profile complete"],
      ["test", "test --ci-milestone"],
      ["build", "build --profile complete"],
      ["e2e_smoke", "e2e --profile complete"],
    ]);
    for (const [job, body] of jobs)
      if (stages.has(job))
        assert.match(
          body,
          new RegExp(`run: node scripts/verify\\.mjs ${stages.get(job)}\\n`),
          job,
        );
      else assert.doesNotMatch(body, /node scripts\/verify\.mjs/, job);
    assert.deepEqual(
      flags(classifyTask(["scripts/verify.mjs"])),
      expectedFlags({ web: true, scope: "smoke" }),
    );
  });

  it("runs the PostgreSQL integration and Payload suites on both supported majors", () => {
    const { jobs } = workflowJobs();
    // One services entry: from its key to the next service key or the steps.
    const service = (body, name) =>
      body
        .split(`\n      ${name}:\n`)[1]
        ?.split(/\n {6}[\w-]+:\n|\n {4}steps:/u)[0] ?? "";
    const pg16Marker =
      /docker exec -i "\$\{\{ job\.services\.postgres16\.id \}\}" psql/u;
    for (const job of ["test", "cms"]) {
      const body = jobs.get(job);
      assert.match(
        service(body, "postgres"),
        /image: postgres:18\.4-alpine\n/u,
      );
      assert.match(service(body, "postgres"), /- 5432:5432\n/u);
      assert.match(
        service(body, "postgres16"),
        /image: postgres:16\.15-alpine\n/u,
      );
      assert.match(service(body, "postgres16"), /- 5433:5432\n/u);
      assert.match(body, pg16Marker, job);
    }
    // test: the PostgreSQL 16 slice follows the unchanged PostgreSQL 18
    // milestone, after its own disposable marker, against the 5433 service.
    const test = jobs.get("test");
    const milestone = test.indexOf(
      "run: node scripts/verify.mjs test --ci-milestone\n",
    );
    const pg16 = test.indexOf(
      "run: node scripts/verify.mjs postgres --profile complete\n",
    );
    assert.ok(milestone > 0 && pg16 > milestone);
    assert.ok(test.search(pg16Marker) > milestone);
    assert.ok(test.search(pg16Marker) < pg16);
    const pg16Step = test.slice(test.lastIndexOf("- name:", pg16), pg16);
    assert.match(
      pg16Step,
      /TEST_DATABASE_URL: postgresql:\/\/\S+@127\.0\.0\.1:5433\/moya_test\n/u,
    );
    assert.match(pg16Step, /TEST_DATABASE_EXPECTED_VERSION_NUM: "160015"\n/u);
    // cms: Payload migrations/integration and the native Owner browser flow
    // each run once more against the 5433 service, after its marker.
    const cms = jobs.get("cms");
    const pg16Url =
      "CMS_TEST_DATABASE_URL: postgresql://cms_qa@127.0.0.1:5433/cms_synthetic_test\n";
    for (const command of [
      "pnpm test:cms --profile complete",
      "pnpm test:cms:browser --profile complete",
    ]) {
      const step = cms.indexOf(`${pg16Url}        run: ${command}\n`);
      assert.ok(step > cms.search(pg16Marker), command);
    }
  });

  it("prepares every internal Admin runtime dependency before the native CMS build", () => {
    const manifests = new Map(
      ["apps", "packages", "services"].flatMap((parent) =>
        readdirSync(join(root, parent))
          .filter((name) =>
            existsSync(join(root, parent, name, "package.json")),
          )
          .map((name) => {
            const manifest = JSON.parse(read(`${parent}/${name}/package.json`));
            return [manifest.name, manifest];
          }),
      ),
    );
    const closure = (roots) => {
      const pending = [...roots],
        visited = new Set();
      while (pending.length) {
        const name = pending.pop();
        if (visited.has(name)) continue;
        const manifest = manifests.get(name);
        assert.ok(manifest, `Unknown CMS prerequisite workspace: ${name}`);
        visited.add(name);
        pending.push(
          ...Object.entries(manifest.dependencies ?? {})
            .filter(([, version]) => version.startsWith("workspace:"))
            .map(([name]) => name),
        );
      }
      return visited;
    };
    const required = closure(["admin"]);
    required.delete("admin");
    const prepared = closure(CMS_LIBRARY_WORKSPACES);
    for (const name of required)
      assert.ok(prepared.has(name), `Cold CMS preparation omits ${name}`);
    assert.equal(prepared.has("admin"), false);
    assert.equal(prepared.has("web"), false);
    assert.ok(prepared.has("@moya/ui"));
    assert.ok(prepared.has("@moya/design-tokens"));
    assert.deepEqual(
      cmsLibraryBuildArgs().filter((argument) =>
        argument.startsWith("--filter="),
      ),
      CMS_LIBRARY_WORKSPACES.map((name) => `--filter=${name}...`),
    );
  });

  it("prepares Formal Web UI runtime dependencies before each dependent compiler", () => {
    const source = read("tests/e2e/support/start-formal-web.ts");
    const block =
      /for \(const \[name, configuration\] of \[([\s\S]*?)\] as const\) \{/u.exec(
        source,
      );
    assert.ok(block, "Formal Web declares its ordered library preparation");
    const projects = [
      ...block[1].matchAll(
        /\["([^"]+)", "(packages\/[^"]+)\/tsconfig\.json"\]/gu,
      ),
    ].map((match) => ({ name: match[1], project: match[2] }));
    const completed = new Set();
    for (const { name, project } of projects) {
      const manifest = JSON.parse(read(`${project}/package.json`));
      assert.equal(manifest.name, name);
      for (const [name, version] of Object.entries(manifest.dependencies ?? {}))
        if (version.startsWith("workspace:"))
          assert.ok(
            completed.has(name),
            `Formal Web compiles ${manifest.name} before runtime prerequisite ${name}`,
          );
      completed.add(manifest.name);
    }
    assert.ok(completed.has("@moya/ui"));
    assert.ok(completed.has("@moya/design-tokens"));
    assert.ok(projects.every(({ project }) => project.startsWith("packages/")));
  });

  it("routes the packages the cms job builds and imports to the cms job", () => {
    const { jobs } = workflowJobs();
    const entry = "scripts/editorial/verify-cms.mjs";
    const source = read(entry);
    // The finite Turbo selectors and the build output it imports itself.
    const buildBlock =
      /CMS_LIBRARY_WORKSPACES = Object\.freeze\(\[([\s\S]*?)\]\)/u.exec(source);
    assert.ok(buildBlock, "CMS names its finite library preparation");
    const builtNames = [...buildBlock[1].matchAll(/"(@moya\/[^"]+)"/gu)].map(
      (match) => match[1],
    );
    const probed = [
      ...source.matchAll(/\bimport\("(\.\.\/[^"]+?)\/dist\/[^"]+"\)/gu),
    ].map((match) => relative(root, resolve(root, dirname(entry), match[1])));
    const workspaces = new Map(
      ["apps", "packages", "services"].flatMap((parent) =>
        readdirSync(join(root, parent))
          .filter((name) =>
            existsSync(join(root, parent, name, "package.json")),
          )
          .map((name) => [
            JSON.parse(read(`${parent}/${name}/package.json`)).name,
            `${parent}/${name}`,
          ]),
      ),
    );
    const built = builtNames.map((name) => workspaces.get(name));
    assert.ok(
      !built.includes(undefined),
      "every library filter names a known workspace",
    );
    // The job migrates and builds Admin and runs Vitest over tests/cms; the
    // workspaces they import load their workspace runtime dependencies.
    assert.match(jobs.get("cms"), /pnpm --filter admin build\n/);
    const pending = [
      "admin",
      ...readdirSync(join(root, "tests/cms"))
        .filter((file) => /\.[cm]?[jt]s$/u.test(file))
        .flatMap((file) =>
          [
            ...read(`tests/cms/${file}`).matchAll(
              /(?:\bfrom\s+|\bimport\()"([^".][^"]*)"/gu,
            ),
          ].map((match) => match[1]),
        ),
    ];
    const loaded = new Set();
    while (pending.length) {
      const specifier = pending.pop();
      const dir = workspaces.get(
        specifier
          .split("/")
          .slice(0, specifier.startsWith("@") ? 2 : 1)
          .join("/"),
      );
      if (!dir || loaded.has(dir)) continue;
      loaded.add(dir);
      pending.push(
        ...Object.entries(
          JSON.parse(read(`${dir}/package.json`)).dependencies ?? {},
        )
          .filter(([, version]) => version.startsWith("workspace:"))
          .map(([name]) => name),
      );
    }
    for (const dir of ["packages/image", "packages/search"])
      assert.ok(built.includes(dir), dir);
    assert.ok(probed.includes("services/catalog-postgres"));
    for (const dir of [
      "apps/admin",
      "packages/contracts",
      "packages/image",
      "packages/search",
      "services/api",
      "services/catalog-postgres",
    ])
      assert.ok(loaded.has(dir), dir);
    for (const dir of new Set([...built, ...probed, ...loaded]))
      for (const file of ["src/index.ts", "package.json", "tsconfig.json"])
        assert.equal(
          classifyTask([`${dir}/${file}`]).cms,
          true,
          `${dir}/${file}`,
        );
  });

  it("routes the E2E smoke and policy files to the Web jobs that run them", () => {
    const { jobs } = workflowJobs();
    // e2e_smoke runs verify.mjs e2e as the cold complete smoke, whose only
    // stage spawns the smoke script under this stage's remaining time.
    assert.match(
      jobs.get("e2e_smoke"),
      /run: node scripts\/verify\.mjs e2e --profile complete\n/,
    );
    const verify = read("scripts/verify.mjs");
    assert.match(verify, /\be2e: \[bounded\(smoke\)\]/);
    const smoke = verificationCommands({
      mode: "e2e",
      selection: "complete",
    })[0][1];
    assert.equal(smoke, "scripts/ci-e2e-smoke.mjs");
    // The Web test job's @moya/tests Vitest run keeps the unit architecture
    // tests; the policy test there loads the E2E scope module.
    const policy = "tests/unit/architecture/ci-e2e-policy.test.ts";
    assert.doesNotMatch(
      JSON.parse(read("tests/package.json")).scripts.test,
      /unit/,
    );
    assert.match(
      read(policy),
      /pathToFileURL\(root \+ "scripts\/ci-e2e-scope\.mjs"\)/,
    );
    for (const file of [smoke, policy, "scripts/ci-e2e-scope.mjs"]) {
      const plan = classifyTask([file]);
      assert.equal(plan.web, true, file);
      assert.equal(plan.scope, "smoke", file);
    }
  });

  it("routes the modules the architecture tests import to the Web jobs that run them", () => {
    const { jobs } = workflowJobs();
    // The Web test job runs verify.mjs test (the --ci-milestone flag only sets
    // its CI budget), whose pnpm test reaches the @moya/tests Vitest run that
    // keeps the unit architecture tests.
    assert.match(
      jobs.get("test"),
      /run: node scripts\/verify\.mjs test --ci-milestone\n/,
    );
    assert.match(
      read("scripts/verify.mjs"),
      /\btest: \[.*pnpm\("test"\)\],\n/u,
    );
    assert.match(
      JSON.parse(read("package.json")).scripts.test,
      /turbo run test/,
    );
    const vitest = JSON.parse(read("tests/package.json")).scripts.test;
    assert.match(vitest, /^vitest run /);
    assert.doesNotMatch(vitest, /unit/);
    // Follow top-level static imports and re-exports only: indented or quoted
    // import text in the tests' fixtures is data, not a dependency.
    const directory = "tests/unit/architecture";
    const pending = readdirSync(join(root, directory))
      .filter((file) => file.endsWith(".test.ts"))
      .map((file) => `${directory}/${file}`);
    const seen = new Set(pending);
    const imported = new Set();
    while (pending.length) {
      const file = pending.pop();
      for (const [, specifier] of read(file).matchAll(
        /^(?:import|export)\s(?:[^;"'`]*?\sfrom\s+)?"(\.{1,2}\/[^"]+)"/gmu,
      )) {
        const target = relative(root, resolve(root, dirname(file), specifier));
        const module = [target.replace(/\.js$/u, ".ts"), target].find(
          (candidate) => existsSync(join(root, candidate)),
        );
        assert.ok(module, `${file} imports ${specifier}`);
        if (seen.has(module)) continue;
        seen.add(module);
        imported.add(module);
        pending.push(module);
      }
    }
    // The lightweight script tests import the scanner too, so a scanner change
    // keeps lightweight and adds the Web jobs.
    assert.ok(imported.has(`${directory}/workspace-scanner.ts`));
    for (const file of imported) {
      const plan = classifyTask([file]);
      assert.equal(plan.web, true, file);
      assert.equal(plan.scope, "smoke", file);
      assert.equal(plan.lightweight, true, file);
    }
  });

  it("routes the configuration the Web lint job reads to the Web jobs", () => {
    const { jobs } = workflowJobs();
    // The Web lint job runs verify.mjs lint, whose stage runs root pnpm scripts.
    assert.match(
      jobs.get("lint"),
      /run: node scripts\/verify\.mjs lint --profile complete\n/,
    );
    const stage = read("scripts/verify.mjs").match(/\blint: \[(.*)\],\n/u)?.[1];
    const scripts = [...(stage ?? "").matchAll(/\bpnpm\("([^"]+)"\)/gu)].map(
      (match) => match[1],
    );
    const rootScripts = JSON.parse(read("package.json")).scripts;
    // Prettier's CLI finds its config, reads .prettierignore and applies
    // .editorconfig unless a flag narrows that; turbo runs workspace lint.
    assert.deepEqual(
      scripts.map((name) => rootScripts[name]),
      ["prettier --check .", "turbo run lint"],
    );
    const extensions = ["js", "mjs", "cjs", "ts", "mts", "cts"];
    const eslintConfigs = extensions.map((ext) => `eslint.config.${ext}`);
    const packages = read("pnpm-workspace.yaml").match(
      /^packages:\n((?: {2}- \S+\n)+)/mu,
    )?.[1];
    const workspaces = [...(packages ?? "").matchAll(/- (\S+)\n/gu)]
      .flatMap(([, pattern]) =>
        pattern.endsWith("/*")
          ? readdirSync(join(root, pattern.slice(0, -2))).map(
              (name) => `${pattern.slice(0, -2)}/${name}`,
            )
          : [pattern],
      )
      .filter((dir) => existsSync(join(root, dir, "package.json")));
    const linted = workspaces.filter(
      (dir) => JSON.parse(read(`${dir}/package.json`)).scripts?.lint,
    );
    assert.ok(linted.includes("tests") && linted.includes("apps/web"));
    // Without a workspace config, each eslint . run uses the root flat config.
    for (const dir of linted) {
      assert.equal(
        JSON.parse(read(`${dir}/package.json`)).scripts.lint,
        "eslint .",
        dir,
      );
      for (const name of eslintConfigs)
        assert.ok(!existsSync(join(root, dir, name)), `${dir}/${name}`);
    }
    // Prettier also honours .gitignore, a Git file left to its existing routing.
    const present = (names) =>
      names.filter((name) => existsSync(join(root, name)));
    const prettierConfigs = present([
      ".prettierrc",
      ...["json", "yaml", "yml", "json5", "toml"].map(
        (e) => `.prettierrc.${e}`,
      ),
      ...extensions.flatMap((e) => [
        `.prettierrc.${e}`,
        `prettier.config.${e}`,
      ]),
    ]);
    const rootEslintConfigs = present(eslintConfigs);
    assert.ok(prettierConfigs.length > 0, "Prettier config");
    assert.ok(rootEslintConfigs.length > 0, "ESLint config");
    for (const file of [
      ...prettierConfigs,
      ".prettierignore",
      ".editorconfig",
      ...rootEslintConfigs,
    ]) {
      assert.ok(existsSync(join(root, file)), file);
      for (const event of ["pull_request", "push", "local"])
        assert.deepEqual(
          flags(classifyTask([file], event)),
          expectedFlags({ web: true, scope: "smoke" }),
          `${file} (${event})`,
        );
    }
  });

  it("retains existing smoke/full jobs, five projects, native reports and the compatible Apple runner", () => {
    const { workflow, jobs } = workflowJobs();
    assert.deepEqual(jobNeeds(jobs.get("browser_gate")), [
      "classify_e2e",
      "e2e_smoke",
      "e2e-shards",
    ]);
    assert.match(jobs.get("browser_gate"), /name: browser-gate/);
    assert.match(
      jobs.get("browser_gate"),
      /node scripts\/ci-e2e-gate\.mjs gate/,
    );
    assert.match(
      jobs.get("browser_gate"),
      /node tests\/e2e\/support\/e2e-ci\.mjs merge/,
    );
    for (const [job, scope] of [
      ["e2e_smoke", "smoke"],
      ["e2e-shards", "full"],
    ])
      assert.match(jobs.get(job), new RegExp(`outputs\\.scope == '${scope}'`));
    assert.match(jobs.get("e2e-shards"), /shard: \[1, 2, 3\]/);
    for (const job of ["e2e-shards", "browser_gate", "e2e"])
      assert.doesNotMatch(jobs.get(job), /timeout-minutes:/);
    for (const mode of ["prepare", "run"])
      assert.ok(
        jobs
          .get("e2e-shards")
          .includes(`node tests/e2e/support/e2e-ci.mjs ${mode}`),
      );
    for (const mode of ["lint", "typecheck", "test", "build", "e2e"])
      assert.ok(workflow.includes(`node scripts/verify.mjs ${mode}`));
    assert.deepEqual(e2eProjects, [
      "desktop-chromium",
      "desktop-webkit",
      "mobile-webkit",
      "tablet-webkit",
      "tablet-landscape-webkit",
    ]);
    assert.match(jobs.get("apple"), /runs-on: macos-26/);
    assert.match(
      jobs.get("apple"),
      /DEVELOPER_DIR: \/Applications\/Xcode_26\.6\.app\/Contents\/Developer/,
    );
    assert.match(jobs.get("apple"), /node scripts\/verify-apple\.mjs/);
    assert.doesNotMatch(
      jobs.get("apple"),
      /pnpm install|continue-on-error|--build-only/,
    );
    for (const job of ["lightweight", "contracts", "apple"])
      assert.match(jobs.get(job), /if-no-files-found: error/);
    assert.equal(jobs.has("harmony"), false);
    assert.doesNotMatch(workflow, /Harmony build|verify-harmony|ohpm/);
  });
});

describe("instructions and JS workspace boundaries support either tool", () => {
  it("resolves root, Apple and Harmony instruction imports with no cycles or ownership split", () => {
    const visited = new Set();
    const visit = (file, stack = new Set()) => {
      const absolute = resolve(root, file);
      assert.ok(
        !relative(root, absolute).startsWith(".."),
        "instruction escapes repository",
      );
      assert.ok(!stack.has(absolute), `instruction import cycle: ${file}`);
      if (visited.has(absolute)) return;
      const source = readFileSync(absolute, "utf8");
      const next = new Set([...stack, absolute]);
      for (const [, target] of source.matchAll(/^@([^\s]+)\s*$/gm))
        visit(relative(root, resolve(dirname(absolute), target)), next);
      visited.add(absolute);
    };
    visit("CLAUDE.md");
    visit("apps/apple/CLAUDE.md");
    visit("apps/harmony/CLAUDE.md");
    for (const file of [
      "AGENTS.md",
      "apps/apple/AGENTS.md",
      "apps/harmony/AGENTS.md",
    ])
      assert.ok(
        visited.has(resolve(root, file)),
        `missing shared authority ${file}`,
      );
    const authority = read("AGENTS.md");
    assert.match(authority, /apps\/apple\/AGENTS\.md/);
    assert.match(authority, /apps\/harmony\/AGENTS\.md/);
    assert.match(authority, /Codex and\s+Claude Code may each implement/);
    assert.match(authority, /one writer at a time/);
    const instructions = [
      authority,
      read("CLAUDE.md"),
      read("apps/apple/AGENTS.md"),
      read("apps/apple/CLAUDE.md"),
      read("apps/harmony/AGENTS.md"),
      read("apps/harmony/CLAUDE.md"),
      read("docs/development/task-workflow.md"),
    ].join("\n");
    assert.doesNotMatch(
      instructions,
      /(?:Codex|Claude(?: Code)?|Cursor)\s+(?:must\s+|should\s+)?(?:only|exclusively)\s+(?:handle|own|implement|work on)\s+(?:Apple|Web|Harmony)/i,
    );
    assert.match(
      read("apps/apple/AGENTS.md"),
      /no API consumer|no such\s+consumer/i,
    );
  });

  it("excludes native Apple and Harmony formatting/lint but retains the Web roots", () => {
    const ignored = read(".prettierignore")
      .split(/\r?\n/)
      .map((line) => line.trim());
    assert.ok(
      ignored.some((line) =>
        /^(?:\/|\*\*\/)?apps\/apple(?:\/\*\*|\/)?$/.test(line),
      ),
    );
    assert.ok(
      ignored.some((line) =>
        /^(?:\/|\*\*\/)?apps\/harmony(?:\/\*\*|\/)?$/.test(line),
      ),
    );
    assert.ok(
      !ignored.some((line) => /^(?:\/)?apps(?:\/\*\*|\/)?$/.test(line)),
    );
    const globalIgnores = read("eslint.config.mjs").match(
      /ignores:\s*\[([\s\S]*?)\]/,
    )?.[1];
    assert.match(globalIgnores, /["'](?:\*\*\/)?apps\/apple\/\*\*["']/);
    assert.match(globalIgnores, /["'](?:\*\*\/)?apps\/harmony\/\*\*["']/);
    assert.doesNotMatch(globalIgnores, /["']apps\/\*\*["']/);
  });

  it("discovers JS workspaces with Apple or Harmony absent or present, and retains other manifest failures", async (t) => {
    const directory = temporary(t);
    for (const workspace of [
      "tests",
      "apps/web",
      "packages/contracts",
      "services/api",
      "services/apple",
    ])
      put(
        directory,
        `${workspace}/package.json`,
        JSON.stringify({ name: workspace }),
      );
    put(directory, "apps/web/src/index.ts", "export const value = 1;\n");
    const before = await discoverWorkspaces(directory);
    assert.deepEqual(
      sorted(before.map((workspace) => workspace.manifest.name)),
      [
        "apps/web",
        "packages/contracts",
        "services/api",
        "services/apple",
        "tests",
      ],
    );
    put(
      directory,
      "apps/apple/package.json",
      "Native project: not a JS manifest",
    );
    put(
      directory,
      "apps/harmony/package.json",
      "Native project: not a JS manifest",
    );
    const after = await discoverWorkspaces(directory);
    assert.deepEqual(after, before);
    mkdirSync(join(directory, "apps/unexpected"));
    await assert.rejects(discoverWorkspaces(directory), { code: "ENOENT" });
    rmSync(join(directory, "apps/unexpected"), { recursive: true });
    mkdirSync(join(directory, "packages/apple"));
    await assert.rejects(discoverWorkspaces(directory), { code: "ENOENT" });
  });
});

describe("scoped validation commands and private output", () => {
  it("uses one deadline for a sequence and never starts work after timeout", async (t) => {
    const directory = temporary(t);
    const first = join(directory, "first.txt");
    const after = join(directory, "must-not-run.txt");
    const write = (file) => [
      process.execPath,
      "-e",
      "require('node:fs').writeFileSync(process.argv[1], 'done')",
      file,
    ];
    const result = await runWithinBudget(
      [
        write(first),
        [
          process.execPath,
          "-e",
          "process.on('SIGINT', () => {}); setInterval(() => {}, 1000)",
        ],
        write(after),
      ],
      { budgetMs: 1000, graceMs: 100, stdio: "ignore" },
    );
    assert.equal(result.code, 124);
    assert.ok(
      result.durationMs >= 900 && result.durationMs < 3000,
      `unexpected deadline ${result.durationMs}ms`,
    );
    assert.ok(existsSync(first));
    assert.ok(!existsSync(after));
  });

  it("allows a child to finish bounded cleanup on explicit cancellation", async (t) => {
    const directory = temporary(t);
    const ready = join(directory, "ready"),
      cleaned = join(directory, "cleaned");
    const childCode = `const fs=require('node:fs');process.on('SIGINT',()=>setTimeout(()=>{fs.writeFileSync(process.argv[2],'cleaned');process.exit(0)},100));fs.writeFileSync(process.argv[1],'ready');setInterval(()=>{},1000);`;
    const driver = `import {runWithinBudget} from ${JSON.stringify(new URL("./verify.mjs", import.meta.url).href)}; const r=await runWithinBudget([[process.execPath,'-e',${JSON.stringify(childCode)},${JSON.stringify(ready)},${JSON.stringify(cleaned)}]],{budgetMs:3000,graceMs:500,stdio:'ignore'});process.exitCode=r.code;`;
    const wrapper = spawn(
      process.execPath,
      ["--input-type=module", "-e", driver],
      { stdio: "ignore" },
    );
    t.after(() => {
      try {
        wrapper.kill("SIGKILL");
      } catch {}
    });
    const exited = new Promise((accept) =>
      wrapper.once("exit", (code) => accept(code)),
    );
    const start = Date.now();
    while (!existsSync(ready) && Date.now() - start < 2000)
      await new Promise((accept) => setTimeout(accept, 10));
    assert.ok(existsSync(ready));
    wrapper.kill("SIGTERM");
    assert.equal(await exited, 130);
    assert.ok(existsSync(cleaned));
    assert.ok(Date.now() - start < 2500);
  });

  it("fingerprints changed untracked bytes as well as staged and unstaged versions", (t) => {
    const fixture = fixtureGit(t);
    put(fixture.directory, "README.md");
    fixture.commit("Synthetic fingerprint baseline");
    put(fixture.directory, "new.md", "first");
    const before = workspaceFingerprint(fixture.git);
    put(fixture.directory, "new.md", "other");
    const after = workspaceFingerprint(fixture.git);
    assert.notDeepEqual(before.untracked, after.untracked);
    assert.equal(before.stagedDiffSha256, after.stagedDiffSha256);
    assert.equal(before.workingDiffSha256, after.workingDiffSha256);
  });

  it("reserves outer cancellation grace for nested validator cleanup despite repeated signals", async (t) => {
    const directory = temporary(t);
    const ready = join(directory, "nested-ready"),
      cleaned = join(directory, "nested-cleaned");
    const moduleUrl = new URL("./verify.mjs", import.meta.url).href;
    const grandchild = `require('node:fs').writeFileSync(process.argv[1],'ready');process.on('SIGINT',()=>{});setInterval(()=>{},1000);`;
    const inner = `import {runWithinBudget} from ${JSON.stringify(moduleUrl)};import {writeFileSync} from 'node:fs';const r=await runWithinBudget([[process.execPath,'-e',${JSON.stringify(grandchild)},${JSON.stringify(ready)}]],{budgetMs:3000,graceMs:100,stdio:'ignore'});await new Promise(r=>setTimeout(r,250));writeFileSync(${JSON.stringify(cleaned)},'cleaned');process.exitCode=r.code;`;
    const outer = `import {runWithinBudget} from ${JSON.stringify(moduleUrl)};const r=await runWithinBudget([[process.execPath,'--input-type=module','-e',${JSON.stringify(inner)}]],{budgetMs:4000,graceMs:700,stdio:'ignore'});process.exitCode=r.code;`;
    const wrapper = spawn(
      process.execPath,
      ["--input-type=module", "-e", outer],
      { stdio: "ignore" },
    );
    t.after(() => {
      try {
        wrapper.kill("SIGKILL");
      } catch {}
    });
    const exited = new Promise((accept) =>
      wrapper.once("exit", (code) => accept(code)),
    );
    const start = Date.now();
    while (!existsSync(ready) && Date.now() - start < 2000)
      await new Promise((accept) => setTimeout(accept, 10));
    assert.ok(existsSync(ready));
    wrapper.kill("SIGTERM");
    await new Promise((accept) => setTimeout(accept, 40));
    wrapper.kill("SIGTERM");
    assert.equal(await exited, 130);
    assert.ok(existsSync(cleaned));
    assert.ok(Date.now() - start < 3000);
  });

  it("does not select product suites for docs or workflow-only work", () => {
    for (const paths of [["README.md"], [".github/workflows/ci.yml"]]) {
      const commands = taskCommands(
        classifyTask(paths),
        "/private/synthetic-output",
      );
      assert.ok(
        commands.some(
          (command) =>
            command.includes("scripts/task-validation.test.mjs") &&
            command.includes("scripts/confidentiality-scan.test.mjs"),
        ),
      );
      assert.doesNotMatch(
        commands.map((command) => command.join(" ")).join("\n"),
        /scripts\/verify\.mjs|verify-apple|test:cms|test:postgres|playwright|turbo run (?:build|test)/,
      );
    }
    const apple = taskCommands(
      classifyTask(["apps/apple/App.swift"]),
      "/private/synthetic-output",
    );
    assert.ok(
      apple.some((command) => command.includes("scripts/verify-apple.mjs")),
    );
    assert.doesNotMatch(
      apple.map((command) => command.join(" ")).join("\n"),
      /pnpm (?:verify|install)|scripts\/verify\.mjs|test:cms|test:postgres|playwright/,
    );
    const harmony = taskCommands(
      classifyTask(["apps/harmony/ArtVenn/entryability.ets"]),
      "/private/synthetic-output",
    );
    assert.doesNotMatch(
      harmony.map((command) => command.join(" ")).join("\n"),
      /scripts\/verify\.mjs|verify-apple|test:cms|test:postgres|playwright|turbo run (?:build|test)/,
    );
    assert.equal(
      classifyTask(["apps/harmony/ArtVenn/entryability.ets"])
        .harmonyNativeValidation,
      "HARMONY_NATIVE_VALIDATION_NOT_YET_CONFIGURED",
    );
  });

  it("keeps shared contract checks focused on existing contract and client seams", () => {
    const commands = contractCommands();
    const text = commands.map((command) => command.join(" ")).join("\n");
    for (const target of [
      "unit/contracts",
      "unit/backend/openapi-contract.test.ts",
      "unit/backend/community-http.test.ts",
      "lib/public-api",
    ])
      assert.ok(
        text.includes(target),
        `missing existing contract seam ${target}`,
      );
    assert.doesNotMatch(
      text,
      /test:cms|test:postgres|playwright|xcodebuild|verify-apple|scripts\/verify\.mjs/,
    );
    // tests depends on Admin for source imports. This transitive build selector
    // would unintentionally build the full Admin application for a contract task.
    assert.doesNotMatch(
      text,
      /--filter=@moya\/tests\^\.\.\.|--filter=admin(?:\s|$)/,
    );
  });

  it("allocates a unique private directory outside the worktree without overwriting", (t) => {
    const directory = temporary(t);
    const worktree = join(directory, "worktree");
    mkdirSync(worktree);
    assert.throws(() => freshOutput("relative", worktree));
    assert.throws(() => freshOutput(worktree, worktree));
    assert.throws(() => freshOutput(join(worktree, "output"), worktree));
    const output = freshOutput(join(directory, "evidence"), worktree);
    assert.equal(statSync(output).mode & 0o777, 0o700);
    put(output, "sentinel.txt", "preserve\n");
    assert.throws(() => freshOutput(output, worktree));
    assert.equal(
      readFileSync(join(output, "sentinel.txt"), "utf8"),
      "preserve\n",
    );
    assert.ok(!existsSync(join(worktree, "output")));
    const alias = join(directory, "alias");
    symlinkSync(worktree, alias, "dir");
    assert.throws(() => freshOutput(join(alias, "output"), worktree));
  });

  it("binds browser output and source identity to the new task", () => {
    const env = validationEnvironment("/private/new-run", "current-head", {
      MOYA_E2E_ARTIFACT_DIR: "/private/other-task",
      MOYA_E2E_SOURCE_HEAD: "old-head",
      GITHUB_RUN_ID: "stale",
      GITHUB_RUN_ATTEMPT: "7",
    });
    assert.equal(env.MOYA_E2E_ARTIFACT_DIR, "/private/new-run/web-smoke");
    assert.equal(env.MOYA_E2E_SOURCE_HEAD, "current-head");
    assert.notEqual(env.GITHUB_RUN_ID, "stale");
    assert.equal(env.GITHUB_RUN_ATTEMPT, "1");
  });

  it("reports an absent Apple project without starting Xcode or claiming success", (t) => {
    const fixture = fixtureGit(t);
    put(fixture.directory, "README.md");
    fixture.commit("Synthetic empty Apple baseline");
    const output = join(temporary(t), "apple-result");
    const result = spawnSync(
      process.execPath,
      [join(root, "scripts/verify-apple.mjs"), "--output", output],
      {
        cwd: fixture.directory,
        encoding: "utf8",
        timeout: 5000,
      },
    );
    assert.equal(result.status, 1);
    const summary = JSON.parse(
      readFileSync(join(output, "summary.json"), "utf8"),
    );
    assert.equal(summary.result, "NOT_TESTED");
    assert.equal(summary.reason, "APPLE_PROJECT_ABSENT_BOOTSTRAP_PENDING");
    assert.equal(summary.cleanup, "complete");
    assert.ok(!existsSync(join(output, "DerivedData")));
  });

  it("selects an installed iPhone supported by the exact runtime", () => {
    const phone = (name) => ({
      name,
      identifier: name,
      productFamily: "iPhone",
    });
    const current = phone("iPhone 18 Pro");
    const older = phone("iPhone 17 Pro");
    const ipod = phone("iPod touch (7th generation)");
    const ipad = {
      name: "iPad Pro",
      identifier: "iPad",
      productFamily: "iPad",
    };
    const devices = [current, older, ipad, ipod];
    const runtime = { supportedDeviceTypes: [older, ipad, ipod] };
    assert.equal(compatibleIphone(runtime, devices), older);
    assert.equal(
      compatibleIphone({ supportedDeviceTypes: [current, older] }, devices),
      current,
    );
    for (const unsupported of [
      {},
      { supportedDeviceTypes: [] },
      { supportedDeviceTypes: [ipad, ipod] },
      { supportedDeviceTypes: [phone("iPhone absent")] },
    ]) {
      assert.throws(
        () => compatibleIphone(unsupported, devices),
        /COMPATIBLE_IPHONE_DEVICE_TYPE_UNAVAILABLE/u,
      );
    }
  });

  it("selects the explicit Apple profile, defaults to full and retires ad-hoc budgets", () => {
    const output = ["--output", "/private/synthetic-apple-output"];
    assert.deepEqual(appleOptions(output), {
      output: output[1],
      buildOnly: false,
      profile: "full",
      remainingMs: null,
    });
    assert.deepEqual(appleOptions([...output, "--profile", "full"]), {
      output: output[1],
      buildOnly: false,
      profile: "full",
      remainingMs: null,
    });
    // Feedback is the build-only preview; it cannot be widened into tests.
    assert.deepEqual(appleOptions(["--profile", "feedback", ...output]), {
      output: output[1],
      buildOnly: true,
      profile: "feedback",
      remainingMs: null,
    });
    assert.equal(appleOptions(["--build-only", ...output]).profile, "full");
    assert.equal(appleOptions(["--build-only", ...output]).buildOnly, true);
    for (const value of ["1", "119000", "600000", "900000"])
      assert.equal(
        appleOptions([...output, "--remaining-ms", value]).remainingMs,
        Number(value),
      );
    for (const value of [
      "",
      "0",
      "-1",
      "NaN",
      "Infinity",
      "1.5",
      "1e5",
      " 1000",
      "9007199254740993",
    ])
      assert.throws(
        () => appleOptions([...output, "--remaining-ms", value]),
        /INVALID_REMAINING_MS|INVALID_APPLE_ARGUMENTS/u,
      );
    for (const value of ["", "FULL", "daily", "milestone", "--full"])
      assert.throws(
        () => appleOptions([...output, "--profile", value]),
        /INVALID_APPLE_PROFILE|INVALID_APPLE_ARGUMENTS/u,
      );
    for (const args of [
      [...output, "--milestone-budget-ms", "300000"],
      [...output, "--remaining-ms"],
      [...output, "--remaining-ms", "200000", "--remaining-ms", "300000"],
      [...output, "--profile", "full", "--profile", "feedback"],
      [...output, "--output", "/private/duplicate"],
      [...output, "--unknown"],
      ["--profile", "full"],
    ])
      assert.throws(() => appleOptions(args));
    assert.equal(APPLE_PROFILES.full.totalMs, 600000);
    assert.equal(APPLE_PROFILES.full.preparationMs, 120000);
    assert.equal(APPLE_PROFILES.full.reserveMs, 60000);
    assert.equal(APPLE_PROFILES.feedback.totalMs, 120000);
    assert.ok(Object.isFrozen(APPLE_PROFILES.full));
  });

  it("caps preparation inside the total and treats a parent's remaining time as a ceiling", () => {
    const full = appleBudget(APPLE_PROFILES.full);
    assert.deepEqual(full, {
      profile: "full",
      totalMs: 600000,
      ceilingMs: 600000,
      ceilingSource: "profile",
      preparationMs: 120000,
      reserveMs: 60000,
      minimumMs: 240000,
      viable: true,
    });
    // A larger parent allowance never raises the profile.
    assert.equal(appleBudget(APPLE_PROFILES.full, 900000).ceilingMs, 600000);
    assert.equal(
      appleBudget(APPLE_PROFILES.full, 900000).ceilingSource,
      "profile",
    );
    const bounded = appleBudget(APPLE_PROFILES.full, 300000);
    assert.equal(bounded.ceilingMs, 300000);
    assert.equal(bounded.ceilingSource, "parent-remaining");
    assert.equal(bounded.preparationMs, 120000);
    assert.equal(bounded.reserveMs, 60000);
    assert.equal(bounded.viable, true);
    // Below the minimum viable time the run must fail fast, never truncate.
    for (const remaining of [1, 119000, 239999]) {
      const short = appleBudget(APPLE_PROFILES.full, remaining);
      assert.equal(short.viable, false);
      assert.equal(short.ceilingMs, remaining);
      assert.ok(short.preparationMs <= Math.max(0, remaining - 60000));
    }
    const feedback = appleBudget(APPLE_PROFILES.feedback);
    assert.equal(feedback.ceilingMs, 120000);
    assert.equal(feedback.preparationMs, 30000);
    assert.equal(feedback.viable, true);
    assert.equal(appleBudget(APPLE_PROFILES.feedback, 59999).viable, false);
    // The same single deadline: preparation ≤ cap, native gets the rest minus
    // the pooled reserve, and the pool is drawn by remaining time.
    const start = 1000;
    const deadline = start + full.ceilingMs;
    const preparationDeadline = start + full.preparationMs;
    assert.equal(preparationDeadline - start, 120000);
    assert.equal(
      remainingAppleBudget(deadline, full.reserveMs, start + 20000),
      520000,
    );
    assert.equal(
      remainingAppleBudget(deadline, full.reserveMs, preparationDeadline),
      420000,
    );
    assert.throws(
      () => remainingAppleBudget(deadline, full.reserveMs, deadline - 60000),
      /TIME_BUDGET_EXCEEDED/u,
    );
    const pool = deadline - APPLE_FINALIZATION_MS;
    assert.equal(pool - (deadline - full.reserveMs), 58000);
    assert.equal(remainingAppleBudget(pool, 0, deadline - 60000), 58000);
    assert.equal(remainingAppleBudget(pool, 0, deadline - 30000), 28000);
    for (const now of [pool, deadline])
      assert.throws(
        () => remainingAppleBudget(pool, 0, now),
        /TIME_BUDGET_EXCEEDED/u,
      );
  });

  it("rejects incompatible SDKs and uses unsigned simulator build/test commands", () => {
    const project =
      "IPHONEOS_DEPLOYMENT_TARGET = 26.5;\nIPHONEOS_DEPLOYMENT_TARGET = 26.4;";
    assert.doesNotThrow(() => assertCompatibleSdk(project, "26.5"));
    assert.doesNotThrow(() => assertCompatibleSdk(project, "27.0"));
    assert.throws(() => assertCompatibleSdk(project, "26.4"));
    assert.throws(() => assertCompatibleSdk(project, "unknown"));
    assert.throws(() => assertCompatibleSdk("no deployment targets", "26.5"));
    for (const buildOnly of [false, true]) {
      const output = "/private/synthetic-apple-output";
      const destination = buildOnly
        ? "generic/platform=iOS Simulator"
        : "platform=iOS Simulator,id=synthetic-task-simulator";
      const command = appleCommand(output, destination, buildOnly);
      const value = (flag) => command[command.indexOf(flag) + 1];
      assert.equal(command[0], "xcodebuild");
      assert.equal(value("-sdk"), "iphonesimulator");
      assert.equal(value("-destination"), destination);
      assert.equal(command.filter((item) => item === "-destination").length, 1);
      if (buildOnly) assert.ok(!command.includes("-parallel-testing-enabled"));
      else {
        assert.equal(value("-parallel-testing-enabled"), "NO");
        assert.equal(
          value("-maximum-concurrent-test-simulator-destinations"),
          "1",
        );
        assert.ok(!command.includes("-parallel-testing-worker-count"));
      }
      assert.equal(value("-configuration"), "Debug");
      assert.equal(value("-scheme"), "ArtVenn");
      assert.equal(value("-derivedDataPath"), join(output, "DerivedData"));
      assert.equal(value("-resultBundlePath"), join(output, "Result.xcresult"));
      assert.ok(command.includes("CODE_SIGNING_ALLOWED=NO"));
      assert.equal(command.at(-1), buildOnly ? "build" : "test");
      assert.ok(!command.includes("-allowProvisioningUpdates"));
    }
  });
});

describe("Apple execution and cleanup evidence", () => {
  const prepared = { result: "PASS", code: 0, reason: "PREPARED" };
  const passed = () =>
    appleExecutionResult(
      { code: 0, durationMs: 40 },
      { state: "closed", code: 0, signal: null },
    );
  const name = "ArtVenn-task-synthetic-owned";
  const udid = "00000000-0000-4000-8000-000000000001";
  const foreign = "00000000-0000-4000-8000-000000000002";
  const devices = (state = "Booted", extra = []) =>
    JSON.stringify({
      devices: {
        runtime: [...(state ? [{ name, udid, state }] : []), ...extra],
      },
    });
  // State-machine tests only; real-child deadlines are covered separately below.
  const harness = async (steps, overrides = {}) => {
    let clock = 0;
    const calls = [];
    const result = await cleanupAppleSimulator({
      createAttempted: true,
      simulator: udid,
      name,
      deadline: 10000,
      now: () => clock,
      call: async (command, args, allowanceMs) => {
        const step = steps.shift();
        assert.ok(step, "No unplanned cleanup command or retry");
        assert.equal(command, "xcrun");
        assert.equal(args[1], step.operation);
        assert.ok(allowanceMs > 0 && allowanceMs <= 10000 - clock);
        const durationMs = step.timeout ? allowanceMs : (step.durationMs ?? 10);
        assert.ok(durationMs <= allowanceMs);
        calls.push({ args, allowanceMs, start: clock });
        clock += durationMs;
        return {
          stdout: step.stdout ?? "",
          evidence: {
            ...appleToolEvidence({
              error: step.error,
              timedOut: !!step.timeout,
              allowanceMs,
              durationMs,
            }),
            teardown: { status: "CONFIRMED" },
          },
        };
      },
      ...overrides,
    });
    assert.equal(steps.length, 0);
    return { result, calls, clock };
  };

  it("does not mark a phase checkpoint PASS before cleanup is completed", () => {
    const result = appleOverall(prepared, passed(), { result: "PENDING" });
    assert.equal(result.result, "PENDING");
    assert.notEqual(result.code, 0);
  });
  it("records a missing native executable as unobserved exit, not xcodebuild exit -2", async (t) => {
    const response = await runAppleCommand(
      join(temporary(t), "absent-native-executable"),
      [],
      { deadline: performance.now() + 500 },
    );
    const result = appleNativeResult(response.evidence, true);
    assert.equal(result.nativeExitCode, null);
    assert.equal(result.result, "FAIL");
    assert.equal(response.evidence.teardown.status, "CONFIRMED");
  });
  it("retains execution PASS with cleanup failure and fails overall", () => {
    const execution = passed();
    assert.equal(
      appleOverall(prepared, execution, { result: "FAIL" }).reason,
      "TASK_SIMULATOR_CLEANUP_INCOMPLETE",
    );
    assert.equal(execution.result, "PASS");
    assert.equal(execution.nativeExitCode, 0);
  });
  it("retains deadline, runner code and observed signal when both phases fail", () => {
    const execution = appleExecutionResult(
      { code: 124, durationMs: 100 },
      { state: "closed", code: null, signal: "SIGINT" },
    );
    assert.equal(execution.deadlineExpired, true);
    assert.equal(execution.nativeExitCode, null);
    assert.equal(execution.nativeSignal, "SIGINT");
    assert.equal(execution.runnerCode, 124);
    assert.equal(
      appleOverall(prepared, execution, { result: "FAIL" }).result,
      "TIME_BUDGET_EXCEEDED",
    );
  });
  it("does not convert native failure, interruption or missing exit into PASS", () => {
    for (const [runner, observation, interrupted] of [
      [{ code: 1 }, { state: "closed", code: 65 }],
      [{ code: 1 }, { state: "closed", code: null, signal: "SIGTERM" }],
      [{ code: 0 }, null],
      [{ code: 130 }, { state: "closed", code: 0 }, true],
    ]) {
      const execution = appleExecutionResult(runner, observation, interrupted);
      assert.notEqual(
        appleOverall(prepared, execution, { result: "PASS" }).result,
        "PASS",
      );
      assert.equal(
        execution.deadlineExpired,
        false,
        "A signal or failure alone is not a timeout",
      );
    }
  });
  it("fails overall on cancellation arriving after execution, during diagnostics", () => {
    const execution = passed();
    const before = appleOverall(prepared, execution, { result: "PASS" });
    assert.equal(before.code, 0);
    const after = appleOverall(prepared, execution, { result: "PASS" }, true);
    assert.equal(after.code, 130);
    assert.equal(after.reason, "INTERRUPTED");
    assert.equal(execution.result, "PASS");
  });
  it("does not claim tests ran after preparation failure", () => {
    const result = appleOverall(
      { result: "FAIL", code: 1, reason: "MATCHING_IOS_RUNTIME_UNAVAILABLE" },
      { attempted: false },
      { result: "PASS" },
    );
    assert.equal(result.result, "NOT_TESTED");
    assert.equal(result.reason, "MATCHING_IOS_RUNTIME_UNAVAILABLE");
  });
  it("observes native exit 124 independently from the deadline wrapper", async () => {
    const response = await runAppleCommand(
      nodeExecPath,
      ["-e", "process.exitCode=124"],
      { deadline: performance.now() + 500 },
    );
    const result = appleNativeResult(response.evidence, true);
    assert.equal(result.runnerCode, 1);
    assert.equal(result.nativeExitCode, 124);
    assert.equal(result.deadlineExpired, false);
    assert.equal(result.teardown.status, "CONFIRMED");
  });
  it("skips shutdown only for a confirmed stopped owned device and verifies deletion", async () => {
    const { result, calls } = await harness([
      {
        operation: "list",
        stdout: devices("Shutdown", [
          { name: "other-task", udid: foreign, state: "Booted" },
        ]),
      },
      { operation: "delete" },
      { operation: "list", stdout: devices(null) },
    ]);
    assert.equal(result.result, "PASS");
    assert.equal(result.state, "deleted");
    assert.equal(
      result.operations.find((op) => op.operation === "shutdown").outcome,
      "already-stopped",
    );
    assert.deepEqual(
      calls.filter(({ args }) => args[1] !== "list").map(({ args }) => args),
      [["simctl", "delete", udid]],
    );
  });
  it("confirms an already-absent task without deleting anything", async () => {
    const { result, calls } = await harness(
      [{ operation: "list", stdout: devices(null) }],
      { simulator: undefined },
    );
    assert.equal(result.state, "already-absent");
    assert.equal(result.result, "PASS");
    assert.equal(calls.length, 1);
  });
  it("does not swallow arbitrary shutdown errors", async () => {
    const { result, calls } = await harness([
      { operation: "list", stdout: devices() },
      { operation: "shutdown", error: { code: 5, signal: null } },
      { operation: "list", stdout: devices() },
    ]);
    assert.equal(result.result, "FAIL");
    assert.equal(result.state, "shutdown-failed");
    assert.equal(result.operations[1].exitCode, 5);
    assert.ok(!calls.some(({ args }) => args[1] === "delete"));
  });
  it("can resolve a shutdown error with confirmed stopped state", async () => {
    const { result } = await harness([
      { operation: "list", stdout: devices() },
      { operation: "shutdown", error: { code: 149 } },
      { operation: "list", stdout: devices("Shutdown") },
      { operation: "delete" },
      { operation: "list", stdout: devices(null) },
    ]);
    assert.equal(result.result, "PASS");
    assert.equal(
      result.operations[1].outcome,
      "failure",
      "Original shutdown failure remains recorded",
    );
  });
  it("resolves a timed-out deletion once using remaining shared time", async () => {
    const { result, calls, clock } = await harness([
      { operation: "list", stdout: devices("Shutdown") },
      { operation: "delete", timeout: true, error: { signal: "SIGKILL" } },
      { operation: "list", stdout: devices(null) },
    ]);
    assert.equal(result.result, "PASS");
    assert.equal(result.state, "absence-confirmed-after-delete-error");
    const deletion = result.operations.find((op) => op.operation === "delete");
    assert.equal(deletion.deadlineExpired, true);
    assert.equal(deletion.exitCode, null);
    assert.equal(
      deletion.allowanceMs,
      7990,
      "Delete may use remaining cleanup time, not a fresh 2s cap",
    );
    assert.equal(calls.at(-1).allowanceMs, 2000);
    assert.ok(clock <= 10000);
    assert.equal(calls.filter(({ args }) => args[1] === "delete").length, 1);
  });
  it("keeps unresolved deletion non-PASS at the shared deadline", async () => {
    const { result, clock } = await harness([
      { operation: "list", stdout: devices("Shutdown") },
      { operation: "delete", timeout: true, error: { signal: "SIGKILL" } },
      { operation: "list", timeout: true, error: { signal: "SIGKILL" } },
    ]);
    assert.equal(result.result, "FAIL");
    assert.equal(clock, 10000);
    const exhausted = await harness([], { deadline: 0 });
    assert.equal(exhausted.result.result, "FAIL");
    assert.equal(exhausted.result.operations[0].attempted, false);
  });
  it("refuses unverified identity, ambiguous names and unsettled native teardown", async () => {
    for (const stdout of [
      "invalid json",
      JSON.stringify({ devices: [] }),
      devices("Shutdown", [{ name, udid: foreign }]),
      JSON.stringify({
        devices: { runtime: [{ name: "other-task", udid, state: "Shutdown" }] },
      }),
    ]) {
      const { result, calls } = await harness([{ operation: "list", stdout }]);
      assert.equal(result.result, "FAIL");
      assert.equal(calls.length, 1);
    }
    const { result, calls } = await harness([], { teardownConfirmed: false });
    assert.equal(result.result, "FAIL");
    assert.equal(calls.length, 0);
  });
  it("publishes only safe categories and counts, never synthetic sensitive payloads", () => {
    const sensitive = "synthetic-sensitive-fixture-do-not-publish";
    const evidence = appleToolEvidence({
      error: { code: 149, message: sensitive, stdout: sensitive },
      stderr: `domain=com.apple.CoreSimulator.SimError, code=405): ${sensitive}`,
      allowanceMs: 20,
      durationMs: 4,
    });
    assert.equal(evidence.errorCategory, "COMMAND_FAILED");
    assert.equal(evidence.errorDomainCode, 405);
    assert.ok(!JSON.stringify(evidence).includes(sensitive));
    const summary = safeAppleTestSummary({
      result: "Passed",
      startTime: 1,
      finishTime: 2,
      totalTestCount: 7,
      passedTests: 7,
      failedTests: 0,
      skippedTests: 0,
      expectedFailures: 0,
      title: sensitive,
      testFailures: [{ failureText: sensitive }],
      environmentDescription: sensitive,
    });
    assert.equal(summary.status, "complete");
    assert.equal(summary.passedTests, 7);
    assert.ok(!JSON.stringify(summary).includes(sensitive));
    const missing = safeAppleTestSummary({ result: "Passed" });
    assert.equal(missing.status, "partial");
    assert.equal(missing.failedTests, null);
    assert.equal(missing.totalTestCount, null);
  });
  it("extracts bounded log events without exposing names or claiming whole-scheme totals", () => {
    const sensitive = "synthetic-sensitive-fixture-do-not-publish";
    const result = safeAppleLogSummary(
      `Test Case '${sensitive}' passed (1.00 seconds).\nExecuted 2 tests, with 0 failures (0 unexpected).\n${sensitive}`.replaceAll(
        "\\n",
        "\n",
      ),
    );
    assert.equal(result.events.passed, 1);
    assert.equal(result.events.failed, null);
    assert.deepEqual(result.lastSuiteReport, { tests: 2, failures: 0 });
    assert.ok(!JSON.stringify(result).includes(sensitive));
    assert.equal(safeAppleLogSummary(sensitive).lastSuiteReport, null);
  });
  it("allowlists only safe Apple artifacts and records PR source independently", () => {
    const { jobs } = workflowJobs();
    const apple = jobs.get("apple");
    assert.match(
      apple,
      /APPLE_SOURCE_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/u,
    );
    assert.match(apple, /if: \$\{\{ always\(\) \}\}/u);
    const paths = apple
      .split("path: |\n")[1]
      .split("include-hidden-files:")[0]
      .trim()
      .split("\n")
      .map((line) => line.trim().split("/").at(-1));
    assert.deepEqual(paths, [
      "summary.json",
      "phase-checkpoint.json",
      "diagnostic.json",
    ]);
    assert.doesNotMatch(
      apple,
      /\.private|\.xcresult|\*\*|continue-on-error|milestone-budget|--remaining-ms|--build-only/u,
    );
  });
});

// Every driver is observed by a separate process with a 2.5s watchdog. Its
// private spawn receipts permit finally cleanup of fixture-owned groups only.
function realAppleFixture(t, mode) {
  const directory = temporary(t);
  const receipt = join(directory, "owned-groups.jsonl");
  const moduleUrl = new NodeURL("./verify-apple.mjs", import.meta.url).href;
  const driver = `
import {spawn,execFile} from 'node:child_process';
import {writeFileSync,openSync,closeSync,readFileSync} from 'node:fs';
import {once} from 'node:events';
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import {runAppleCommand} from ${JSON.stringify(moduleUrl)};
const mode=${JSON.stringify(mode)},receipt=${JSON.stringify(receipt)};
const own=pid=>writeFileSync(receipt+'-'+pid,'owned',{mode:0o600});
const sentinel=spawn(process.execPath,['-e',"process.send('ready');setInterval(()=>{},1000)"],{detached:true,stdio:['ignore','ignore','ignore','ipc']});
own(sentinel.pid);await once(sentinel,'message');
let fixture;
if(mode==='normal') fixture="process.stdout.write(Buffer.from([0xe4]));setImmediate(()=>{process.stdout.write(Buffer.from([0xbd,0xa0]));process.exitCode=7})";
else if(mode==='hung') fixture="process.on('SIGTERM',()=>{});console.log('READY');setInterval(()=>{},1000)";
else if(mode==='output') fixture="process.stdout.write('x'.repeat(10000));setInterval(()=>{},1000)";
else if(mode==='race') fixture="console.log('READY');setTimeout(()=>process.exit(0),375)";
else {
 const grandchild=mode==='old' ? "console.log('READY');process.send('ready');setTimeout(()=>process.exit(0),700)" :
  (mode.includes('escaped') ? "require('node:fs').writeFileSync("+JSON.stringify(receipt)+"+'-'+process.pid,'owned',{mode:0o600});" : '')+
  "console.log('READY');process.send('ready');setInterval(()=>{},1000)";
 fixture="const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',"+JSON.stringify(grandchild)+"],{detached:"+mode.includes('escaped')+",stdio:['ignore','inherit','inherit','ipc']});c.once('message',()=>process.exit(0));";
}
const log=receipt+'.log';const outputFd=mode==='native-escaped'?openSync(log,'wx',0o600):undefined;
const started=performance.now();let result,notified=0,staleCancel;
try {
 if(mode==='old') {
  // Exact faulty r2 mechanism: kill the child at timeout, then still await
  // execFile's callback/pipe EOF. Short fixture, not a historical root-cause claim.
  result=await new Promise(resolve=>{let timedOut=false;const child=execFile(process.execPath,['-e',fixture],{encoding:'utf8'},(error,stdout)=>{clearTimeout(timer);resolve({stdout,evidence:{deadlineExpired:timedOut,durationMs:performance.now()-started,callbackCode:error?.code??0}})});const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL')},120)});
 } else result=await runAppleCommand(process.execPath,['-e',fixture],{deadline:started+500,outputFd,maxOutputBytes:mode==='output'?128:4096,onSpawn:own,onOutcome:()=>{notified++},registerCancel:cancel=>{if(cancel)staleCancel=cancel}});
 if(outputFd!==undefined){closeSync(outputFd);if(!readFileSync(log,'utf8').includes('READY'))throw Error('Missing private native output')}
 const immutable=JSON.stringify(result);
 if(mode==='race'){staleCancel();staleCancel();await delay(180)}
 process.kill(sentinel.pid,0);
 console.log(JSON.stringify({result,notified,immutable:immutable===JSON.stringify(result),sentinelAlive:true,elapsedMs:performance.now()-started}));
} finally {
 const exited=once(sentinel,'exit');process.kill(-sentinel.pid,'SIGKILL');await exited;
}
`;
  let child;
  const started = performance.now();
  try {
    child = spawnSync(nodeExecPath, ["--input-type=module", "-e", driver], {
      encoding: "utf8",
      timeout: 2500,
      killSignal: "SIGKILL",
      detached: true,
    });
    assert.equal(
      child.error,
      undefined,
      "Independent watchdog must not have to stop the driver",
    );
    assert.equal(child.status, 0, child.stderr);
    const measured = JSON.parse(child.stdout.trim());
    assert.equal(measured.sentinelAlive, true);
    assert.equal(measured.immutable, true);
    t.diagnostic(
      JSON.stringify({
        fixture: mode,
        driverMs: performance.now() - started,
        commandMs: measured.result.evidence.durationMs,
        outcome: measured.result.evidence.outcome,
        teardown: measured.result.evidence.teardown?.status,
      }),
    );
    if (!["old", "escaped", "native-escaped"].includes(mode)) {
      const owned = readdirSync(directory)
        .filter((file) => /^owned-groups\.jsonl-\d+$/u.test(file))
        .map((file) => Number(file.split("-").at(-1)));
      for (const group of owned)
        assert.throws(() => killProcess(-group, 0), { code: "ESRCH" });
    }
    return measured;
  } finally {
    const groups = [child?.pid];
    groups.push(
      ...readdirSync(directory)
        .filter((file) => /^owned-groups\.jsonl-\d+$/u.test(file))
        .map((file) => Number(file.split("-").at(-1))),
    );
    for (const group of new Set(groups)) {
      if (!Number.isSafeInteger(group) || group <= 1) continue;
      try {
        killProcess(-group, "SIGKILL");
      } catch (error) {
        assert.equal(error.code, "ESRCH", "Fixture-owned group cleanup failed");
      }
    }
  }
}

describe("Apple real-child deadlines and lifetime", () => {
  it("preserves an observed normal exit and complete split UTF-8 output", (t) => {
    const { result, notified } = realAppleFixture(t, "normal");
    assert.equal(result.stdout, "你");
    assert.equal(result.evidence.exitCode, 7);
    assert.equal(result.evidence.exitObserved, true);
    assert.equal(result.evidence.outputComplete, true);
    assert.equal(result.evidence.teardown.status, "CONFIRMED");
    assert.equal(notified, 1);
  });
  it("bounds a real SIGTERM-resistant child, confirms group cleanup and preserves a sentinel", (t) => {
    const { result, notified } = realAppleFixture(t, "hung");
    assert.match(result.stdout, /READY/u);
    assert.equal(result.evidence.deadlineExpired, true);
    assert.equal(result.evidence.teardown.status, "CONFIRMED");
    assert.equal(result.evidence.signal, "SIGKILL");
    assert.ok(
      result.evidence.teardown.signals.some(
        (item) => item.signal === "SIGKILL" && item.sendResult === "SENT",
      ),
    );
    assert.equal(notified, 1);
    // Fixture scheduling tolerance only, never a production budget extension.
    assert.ok(result.evidence.durationMs < 800);
  });
  it("reproduces the old pipe-EOF deadline failure and proves the repaired owned-group path", (t) => {
    const old = realAppleFixture(t, "old");
    assert.equal(old.result.evidence.deadlineExpired, true);
    assert.ok(
      old.result.evidence.durationMs > 500,
      "r2 mechanism exceeds its 120ms timer",
    );
    const corrected = realAppleFixture(t, "pipes");
    assert.match(corrected.result.stdout, /READY/u);
    assert.equal(corrected.result.evidence.exitCode, 0);
    assert.equal(corrected.result.evidence.teardown.status, "CONFIRMED");
    assert.equal(corrected.result.evidence.outputComplete, true);
    assert.ok(corrected.result.evidence.durationMs < 500);
  });
  it("returns bounded non-PASS for unconfirmed escaped-pipe teardown and bounded output overflow", (t) => {
    for (const mode of ["escaped", "native-escaped"]) {
      const escaped = realAppleFixture(t, mode);
      assert.equal(escaped.result.evidence.exitCode, 0);
      // The wrapper Promise resolved, the direct child's exit was observed and
      // its own group is gone, yet the captured pipe never closed: process
      // exit, group absence and stream closure stay distinct, and teardown
      // remains UNCONFIRMED.
      assert.equal(escaped.result.evidence.exitObserved, true);
      assert.equal(escaped.result.evidence.teardown.groupAbsent, true);
      assert.equal(escaped.result.evidence.teardown.streamsClosed, false);
      assert.equal(escaped.result.evidence.teardown.status, "UNCONFIRMED");
      assert.notEqual(escaped.result.evidence.outcome, "success");
      assert.equal(escaped.result.evidence.outputComplete, false);
    }
    const overflow = realAppleFixture(t, "output");
    assert.equal(overflow.result.evidence.outputTruncated, true);
    assert.equal(overflow.result.evidence.outputComplete, false);
    assert.ok(overflow.result.stdout.length <= 128);
    assert.notEqual(overflow.result.evidence.outcome, "success");
  });
  it("settles an exit/deadline race once and ignores stale cancellation after settlement", (t) => {
    const measured = realAppleFixture(t, "race");
    assert.equal(measured.notified, 1);
    assert.equal(measured.immutable, true);
    assert.equal(measured.result.evidence.teardown.status, "CONFIRMED");
    assert.ok(measured.elapsedMs < 1000);
  });
  it("retains native PASS while unresolved teardown or invocation expiry fails overall", () => {
    const evidence = {
      executionOutcome: "success",
      executionDeadlineExpired: false,
      outcome: "unresolved",
      exitObserved: true,
      exitCode: 0,
      teardown: { status: "UNCONFIRMED" },
      durationMs: 20,
    };
    const execution = appleNativeResult(evidence, true);
    assert.equal(execution.result, "PASS");
    assert.equal(execution.wrapperSettled, true);
    assert.equal(execution.wrapperCode, 1);
    assert.equal(execution.teardown.status, "UNCONFIRMED");
    assert.notEqual(
      appleOverall({ result: "PASS" }, execution, { result: "PASS" }).result,
      "PASS",
    );
    const late = appleInvocationResult(
      { result: "PASS", code: 0 },
      { started: 0, deadline: 120000, now: 120000.25, teardownConfirmed: true },
    );
    assert.equal(late.result, "TIME_BUDGET_EXCEEDED");
    assert.equal(late.invocationOverrunMs, 0.25);
    const unresolved = appleInvocationResult(
      { result: "PASS", code: 0 },
      { started: 0, deadline: 120000, now: 100, teardownConfirmed: false },
    );
    assert.equal(unresolved.result, "FAIL");
  });
  it("runs the explicit Apple full profile under 12-minute containment and preserves the upload", () => {
    const apple = workflowJobs().jobs.get("apple");
    assert.match(apple, /timeout-minutes: 20/u);
    assert.match(
      apple,
      /name: Validate the selected native Apple project\n\s+timeout-minutes: 12\n/u,
    );
    // Containment must exceed the 600 s profile; the job limit is unchanged.
    const step = Number(
      /Validate the selected native Apple project\n\s+timeout-minutes: (\d+)/u.exec(
        apple,
      )[1],
    );
    assert.ok(step * 60000 > APPLE_PROFILES.full.totalMs);
    assert.ok(step < 20);
    assert.match(
      apple,
      /node scripts\/verify-apple\.mjs --profile full --output\n/u,
    );
    assert.equal(apple.match(/--profile/gu).length, 1);
    assert.match(
      apple,
      /DEVELOPER_DIR: \/Applications\/Xcode_26\.6\.app\/Contents\/Developer/u,
    );
    assert.match(
      apple,
      /name: Preserve native Apple validation evidence\n\s+if: \$\{\{ always\(\) \}\}/u,
    );
    assert.match(apple, /phase-checkpoint\.json/u);
  });
  it("fails fast with the requested profile when a parent ceiling is not viable", (t) => {
    // Real entry point, no xcodebuild: the budget check precedes every command.
    // The output path is never created, so nothing is written outside tmp.
    const directory = temporary(t);
    for (const [profile, remaining] of [
      ["full", "119000"],
      ["feedback", "30000"],
    ]) {
      const started = performance.now();
      const child = spawnSync(
        nodeExecPath,
        [
          join(root, "scripts/verify-apple.mjs"),
          "--profile",
          profile,
          "--remaining-ms",
          remaining,
          "--output",
          join(directory, `never-created-${profile}`),
        ],
        { encoding: "utf8", timeout: 5000, killSignal: "SIGKILL" },
      );
      assert.equal(child.error, undefined);
      assert.equal(child.status, 1, child.stderr);
      assert.ok(performance.now() - started < 4000);
      const summary = JSON.parse(child.stdout.trim().split("\n").at(-1));
      assert.equal(summary.result, "NOT_TESTED");
      assert.equal(summary.reason, "INSUFFICIENT_REMAINING_TIME");
      assert.equal(summary.profile, profile);
      assert.equal(summary.budget.ceilingMs, Number(remaining));
      assert.equal(summary.budget.ceilingSource, "parent-remaining");
      assert.equal(summary.budget.totalMs, APPLE_PROFILES[profile].totalMs);
      assert.equal(summary.budgetMs, Number(remaining));
      assert.notEqual(summary.budgetMs, 120000);
      assert.equal(summary.phases.execution.attempted, false);
      assert.equal(summary.phases.preparation.deadlineExpired, false);
      assert.equal(summary.phases.cleanup.state, "not-required");
      assert.equal(summary.resultBundle.status, "absent");
      assert.equal(summary.timings.ceilingMs, Number(remaining));
      assert.equal(
        summary.timings.reserveMs,
        APPLE_PROFILES[profile].reserveMs,
      );
      if (profile === "feedback") {
        assert.equal(summary.label, "FEEDBACK ONLY — NOT FULL ACCEPTANCE");
        assert.equal(summary.acceptance, false);
        assert.ok(summary.feedback.unchecked.length > 0);
      } else assert.equal(summary.label, undefined);
      assert.equal(
        existsSync(join(directory, `never-created-${profile}`)),
        false,
      );
    }
  });
  it("reports the effective profile ceiling instead of a literal 120000", (t) => {
    // Argument and budget resolution succeed; the pre-existing output path
    // stops the run before any xcodebuild, so the printed budget is the
    // profile's own, not a fixed daily constant.
    const directory = temporary(t);
    const existing = join(directory, "already-exists");
    mkdirSync(existing);
    const child = spawnSync(
      nodeExecPath,
      [
        join(root, "scripts/verify-apple.mjs"),
        "--output",
        existing,
        "--remaining-ms",
        "480000",
      ],
      { encoding: "utf8", timeout: 5000, killSignal: "SIGKILL" },
    );
    assert.equal(child.error, undefined);
    assert.equal(child.status, 1, child.stderr);
    const summary = JSON.parse(child.stdout.trim().split("\n").at(-1));
    assert.equal(summary.profile, "full");
    assert.equal(summary.validationKind, "FULL");
    assert.equal(summary.budget.totalMs, 600000);
    assert.equal(summary.budgetMs, 480000);
    assert.equal(summary.timings.preparationCapMs, 120000);
    assert.equal(summary.result, "NOT_TESTED");
    assert.equal(summary.reason, "PREPARATION_UNAVAILABLE");
    assert.equal(summary.phases.execution.attempted, false);
    assert.equal(summary.acceptance, undefined);
  });
});

describe("explicit validation profiles and nested deadlines", () => {
  const joined = (checks) =>
    checks
      .flatMap((check) => check.commands ?? [check])
      .map((command) => command.join(" "))
      .join("\n");

  it("keeps the frozen profile ceilings and lowers, never raises, them by a parent's remaining time", () => {
    assert.equal(VALIDATION_PROFILES.feedback.totalMs, 120000);
    // Neutral quick ceilings share the cap but never the feedback label.
    for (const key of ["scriptTests", "webQuick", "cmsQuick"]) {
      assert.equal(VALIDATION_PROFILES[key].totalMs, 120000);
      assert.doesNotMatch(VALIDATION_PROFILES[key].name, /feedback/iu);
    }
    assert.equal(VALIDATION_PROFILES.scriptTests.name, "script-tests");
    assert.equal(VALIDATION_PROFILES.webQuick.name, "web-quick");
    assert.equal(VALIDATION_PROFILES.cmsQuick.name, "cms-quick");
    assert.equal(VALIDATION_PROFILES.webComplete.totalMs, 300000);
    assert.equal(VALIDATION_PROFILES.cmsComplete.totalMs, 300000);
    assert.equal(VALIDATION_PROFILES.browserSmokeWarm.totalMs, 120000);
    assert.equal(VALIDATION_PROFILES.browserSmokeCold.totalMs, 300000);
    assert.equal(VALIDATION_PROFILES.appleFull.totalMs, 600000);
    assert.equal(VALIDATION_PROFILES.appleFeedback.totalMs, 120000);
    assert.equal(VALIDATION_PROFILES.localCombined.totalMs, 900000);
    assert.equal(VALIDATION_PROFILES.credentialDelivery.totalMs, 120000);
    assert.ok(Object.isFrozen(VALIDATION_PROFILES));
    for (const profile of Object.values(VALIDATION_PROFILES))
      assert.ok(Object.isFrozen(profile));
    assert.deepEqual(effectiveCeiling(VALIDATION_PROFILES.webComplete), {
      profile: "web-complete",
      totalMs: 300000,
      ceilingMs: 300000,
      ceilingSource: "profile",
      remainingMs: null,
    });
    const lowered = effectiveCeiling(VALIDATION_PROFILES.webComplete, 45000);
    assert.equal(lowered.ceilingMs, 45000);
    assert.equal(lowered.ceilingSource, "parent-remaining");
    const generous = effectiveCeiling(
      VALIDATION_PROFILES.webComplete,
      10 * 60 * 1000,
    );
    assert.equal(generous.ceilingMs, 300000);
    assert.equal(generous.ceilingSource, "profile");
    assert.deepEqual(
      takeProfileOptions(
        ["--profile", "complete", "--remaining-ms", "5000", "--ci-milestone"],
        { quick: true, complete: true },
      ),
      { profile: "complete", remainingMs: 5000, rest: ["--ci-milestone"] },
    );
    for (const argv of [
      ["--profile"],
      ["--profile", "--remaining-ms", "5"],
      ["--profile", "unknown"],
      ["--remaining-ms"],
      ["--remaining-ms", "0"],
      ["--remaining-ms", "12a"],
      ["--remaining-ms", "-5"],
      ["--remaining-ms", "1e3"],
      ["--profile", "quick", "--profile", "quick"],
      ["--remaining-ms", "5", "--remaining-ms", "6"],
    ])
      assert.throws(
        () => takeProfileOptions(argv, { quick: true, complete: true }),
        argv.join(" "),
      );
    const command = ["node", "child.mjs", "--remaining-ms", REMAINING_MS_TOKEN];
    assert.deepEqual(withRemaining(command, 1234.9), [
      "node",
      "child.mjs",
      "--remaining-ms",
      "1234",
    ]);
    assert.equal(withRemaining(command, 0).at(-1), "1");
    assert.deepEqual(withRemaining(["node", "plain.mjs"], 5), [
      "node",
      "plain.mjs",
    ]);
  });

  it("gives each Web stage an explicit complete profile and keeps the CI test milestone at 300 seconds", () => {
    for (const mode of ["lint", "typecheck", "test", "build"]) {
      assert.equal(WEB_VERIFICATION_PROFILES[mode].complete.totalMs, 300000);
      const quick = verificationPlan(mode);
      assert.equal(quick.selection, "quick");
      assert.equal(quick.ceilingMs, VALIDATION_PROFILES.webQuick.totalMs);
      // An unflagged run is an ordinary acceptance check, never "feedback".
      assert.equal(quick.profile, "web-quick");
      assert.equal(verificationBudgetMs(mode), 120000);
      const complete = verificationPlan(mode, ["--profile", "complete"]);
      assert.equal(complete.selection, "complete");
      assert.equal(complete.profile, "web-complete");
      assert.equal(complete.ceilingMs, 300000);
      assert.equal(complete.ceilingSource, "profile");
    }
    const all = verificationPlan("all", ["--profile", "complete"]);
    assert.equal(all.profile, "local-combined");
    assert.equal(all.ceilingMs, 900000);
    assert.equal(verificationBudgetMs("all"), 120000);
    assert.equal(verificationPlan("all").profile, "web-quick");
    for (const [mode, plan] of Object.entries(WEB_VERIFICATION_PROFILES))
      for (const selection of Object.values(plan))
        assert.doesNotMatch(selection.name, /feedback/iu, mode);
    assert.equal(verificationPlan("e2e").profile, "browser-smoke-warm");
    const cold = verificationPlan("e2e", ["--profile", "complete"]);
    assert.equal(cold.profile, "browser-smoke-cold");
    assert.equal(cold.ceilingMs, 300000);
    const ci = { GITHUB_ACTIONS: "true", TEST_DATABASE_URL: "postgresql://x" };
    const milestone = verificationPlan("test", ["--ci-milestone"], ci);
    assert.equal(milestone.milestone, true);
    assert.equal(milestone.selection, "complete");
    assert.equal(milestone.profile, "web-complete");
    assert.equal(milestone.ceilingMs, 300000);
    assert.throws(() => verificationPlan("test", ["--ci-milestone"], {}));
    assert.throws(() =>
      verificationPlan("test", ["--ci-milestone"], { GITHUB_ACTIONS: "true" }),
    );
    assert.throws(() => verificationPlan("lint", ["--ci-milestone"], ci));
    assert.throws(() =>
      verificationPlan("test", ["--ci-milestone", "--profile", "complete"], ci),
    );
    assert.throws(() =>
      verificationPlan("test", ["--ci-milestone", "--ci-milestone"], ci),
    );
    assert.throws(() => verificationPlan("test", ["--unknown"]));
    assert.throws(() => verificationPlan("unknown"));
    const bounded = verificationPlan("build", [
      "--profile",
      "complete",
      "--remaining-ms",
      "75000",
    ]);
    assert.equal(bounded.totalMs, 300000);
    assert.equal(bounded.ceilingMs, 75000);
    assert.equal(bounded.ceilingSource, "parent-remaining");
    const notRaised = verificationPlan("lint", ["--remaining-ms", "999999"]);
    assert.equal(notRaised.ceilingMs, 120000);
    assert.equal(notRaised.ceilingSource, "profile");
    const source = read("scripts/verify.mjs");
    assert.doesNotMatch(
      source,
      /retain 120 seconds|explicit CI test milestone only|Owner-authorized/iu,
    );
    for (const file of ["scripts/verify.mjs", "scripts/verify-task.mjs"])
      assert.doesNotMatch(read(file), /\b1(?:20|18)_?000\b/u, file);
    assert.match(source, /e2e: \[bounded\(smoke\)\]/u);
    assert.match(source, /plan\.selection === "complete" \? "cold" : "warm"/u);
  });

  it("hands a child the real remaining time and never lets it outlive the parent's deadline", async (t) => {
    const directory = temporary(t);
    const received = join(directory, "received.json");
    const child = [
      process.execPath,
      "-e",
      "const fs=require('node:fs');const ms=Number(process.argv[2]);fs.writeFileSync(process.argv[1],JSON.stringify({ms}));process.on('SIGINT',()=>{});setTimeout(()=>fs.writeFileSync(process.argv[1]+'.late','late'),ms+1500);",
      received,
      REMAINING_MS_TOKEN,
    ];
    const started = performance.now();
    const result = await runWithinBudget([child], {
      budgetMs: 1500,
      graceMs: 300,
      stdio: "ignore",
    });
    const elapsed = performance.now() - started;
    assert.equal(result.code, 124);
    assert.ok(elapsed < 3500, `parent deadline not enforced: ${elapsed}ms`);
    assert.equal(result.budgetMs, 1500);
    const [recorded] = result.executed;
    assert.equal(recorded.command.at(-1), String(recorded.remainingMs));
    assert.ok(recorded.remainingMs > 0 && recorded.remainingMs <= 1200);
    const { ms } = JSON.parse(readFileSync(received, "utf8"));
    assert.equal(ms, recorded.remainingMs, "child saw the recorded value");
    await new Promise((accept) =>
      setTimeout(accept, Math.max(0, ms + 1500 - elapsed) + 400),
    );
    assert.ok(
      !existsSync(received + ".late"),
      "the child was stopped at the parent's deadline",
    );
  });

  it("fails fast before spawning when a parent's remaining time leaves nothing beyond startup and cleanup grace", async () => {
    // The minimum is the startup margin plus the cleanup grace: below it the
    // runner cannot start a command and stop it cleanly, so it does not try.
    assert.equal(GRACE_MS, 8000);
    assert.equal(viableCeiling(STARTUP_MARGIN_MS + GRACE_MS), false);
    assert.equal(viableCeiling(STARTUP_MARGIN_MS + GRACE_MS + 1), true);
    for (const ms of [1, 1000, 5000, 9000])
      assert.equal(viableCeiling(ms), false, String(ms));
    assert.equal(viableCeiling(9001), true);
    // A negative or grace-sized budget never arms a timer in the past: the
    // runner clamps it, spawns nothing and reports the failed ceiling at once.
    for (const budgetMs of [-999, 0, 10]) {
      const clamped = await runWithinBudget(
        [[process.execPath, "-e", "setTimeout(()=>{}, 500)"]],
        { budgetMs, graceMs: 10, stdio: "ignore" },
      );
      assert.equal(clamped.code, 124, String(budgetMs));
      assert.equal(clamped.budgetMs, Math.max(0, budgetMs));
      assert.deepEqual(clamped.executed, [], "nothing spawned");
    }
    // Real entry point on the boundary band: the whole 1–9 s band and the
    // sub-second case exit 124 without spawning any stage and without a stack.
    for (const remaining of ["1", "999", "1000", "5000", "9000"]) {
      const started = performance.now();
      const child = spawnSync(
        process.execPath,
        [join(root, "scripts/verify.mjs"), "lint", "--remaining-ms", remaining],
        { cwd: root, encoding: "utf8", timeout: 10000, killSignal: "SIGKILL" },
      );
      assert.equal(child.error, undefined, remaining);
      assert.equal(child.status, 124, remaining + child.stderr);
      assert.ok(performance.now() - started < 4000, remaining);
      assert.equal(
        child.stdout.trim(),
        `Acceptance lint: INSUFFICIENT_REMAINING_TIME (${remaining}ms ceiling from parent remaining; profile web-quick 120000ms)`,
      );
      assert.doesNotMatch(child.stderr, /Warning|at |Error/u, remaining);
      assert.doesNotMatch(child.stdout, /TIME BUDGET EXCEEDED|PASS|FAIL/u);
    }
  });

  it("declares the plan profile from the selected checks and routes strictly by changed paths", () => {
    const output = "/private/synthetic-output";
    const apple = taskChecks(
      classifyTask(["apps/apple/App.swift"], "local"),
      output,
    );
    assert.deepEqual(
      apple.map((check) => check.name),
      ["script-tests", "apple"],
    );
    const appleBudget = taskValidationBudget(apple);
    assert.equal(appleBudget.profile, "explicit-profile-sum");
    assert.equal(appleBudget.totalMs, 720000);
    assert.equal(appleBudget.serialCombination, false);
    assert.equal(appleBudget.combinedCeilingMs, 900000);
    assert.deepEqual(appleBudget.checks, [
      {
        name: "script-tests",
        profile: "script-tests",
        totalMs: 120000,
        commands: 1,
      },
      { name: "apple", profile: "apple-full", totalMs: 600000, commands: 1 },
    ]);
    assert.equal(appleBudget.note, undefined, "an uncapped plan has no note");
    const [appleCommand] = apple[1].commands;
    assert.deepEqual(appleCommand.slice(0, 4), [
      process.execPath,
      "scripts/verify-apple.mjs",
      "--profile",
      "full",
    ]);
    assert.deepEqual(appleCommand.slice(-2), [
      "--remaining-ms",
      REMAINING_MS_TOKEN,
    ]);
    assert.doesNotMatch(
      joined(apple),
      /scripts\/verify\.mjs|test:cms|ci-e2e-smoke|playwright|pnpm/u,
    );

    const web = taskChecks(
      classifyTask(["apps/web/app/page.tsx"], "local"),
      output,
    );
    assert.deepEqual(
      web.map((check) => check.name),
      ["script-tests", "web"],
    );
    const webBudget = taskValidationBudget(web);
    assert.equal(webBudget.profile, "local-combined");
    assert.equal(webBudget.totalMs, 900000);
    assert.equal(webBudget.serialCombination, true);
    // The explicit sum (120 000 + 900 000) exceeds the combined ceiling, so
    // the cap and its meaning are stated once in the plan.
    assert.match(webBudget.note, /sum to 1020000 ms/u);
    assert.match(webBudget.note, /capped at 900000 ms/u);
    assert.match(webBudget.note, /truthful non-PASS, not acceptance/u);
    assert.match(
      webBudget.note,
      /CI jobs run each check under its own profile/u,
    );
    assert.deepEqual(web[1].commands, [
      [
        process.execPath,
        "scripts/verify.mjs",
        "all",
        "--profile",
        "complete",
        "--workspaces",
        "@moya/tests,web",
        "--remaining-ms",
        REMAINING_MS_TOKEN,
      ],
    ]);
    assert.doesNotMatch(joined(web), /verify-apple|xcodebuild|test:cms/u);

    const cms = taskChecks(
      classifyTask(["apps/admin/src/fields/editorial-fields.ts"], "local"),
      output,
    );
    assert.deepEqual(
      cms.map((check) => check.name),
      ["script-tests", "web", "cms", "cms-browser"],
    );
    for (const name of ["cms", "cms-browser"]) {
      const check = cms.find((item) => item.name === name);
      assert.equal(check.profile, "cms-complete");
      assert.equal(check.totalMs, 300000);
      assert.deepEqual(check.commands[0].slice(-4), [
        "--profile",
        "complete",
        "--remaining-ms",
        REMAINING_MS_TOKEN,
      ]);
    }
    assert.equal(taskValidationBudget(cms).profile, "local-combined");
    assert.equal(taskValidationBudget(cms).totalMs, 900000);
    assert.doesNotMatch(joined(cms), /verify-apple/u);

    const shared = taskChecks(
      classifyTask(
        [
          "scripts/verify.mjs",
          "scripts/validation-profiles.mjs",
          "scripts/editorial/verify-cms.mjs",
        ],
        "local",
      ),
      output,
    );
    assert.deepEqual(
      shared.map((check) => check.name),
      ["script-tests", "web", "cms", "cms-browser"],
    );
    assert.doesNotMatch(joined(shared), /verify-apple/u);
    const sharedBudget = taskValidationBudget(shared);
    assert.equal(sharedBudget.totalMs, 900000);
    assert.match(sharedBudget.note, /sum to 1620000 ms; .*capped at 900000/u);
    // The feedback label belongs to `--mode feedback` only: no default plan,
    // check or note may carry it.
    for (const budget of [appleBudget, webBudget, sharedBudget])
      assert.doesNotMatch(JSON.stringify(budget), /feedback/iu);

    const lightweight = taskValidationBudget(
      taskChecks({ lightweight: true }, output),
    );
    assert.equal(lightweight.profile, "explicit-profile-sum");
    assert.equal(lightweight.totalMs, VALIDATION_PROFILES.scriptTests.totalMs);
    assert.equal(lightweight.checks[0].profile, "script-tests");
    assert.equal(lightweight.note, undefined);
    const contracts = taskValidationBudget(
      taskChecks({ lightweight: true, contracts: true }, output),
    );
    assert.equal(contracts.profile, "explicit-profile-sum");
    assert.equal(contracts.totalMs, 420000);
    const feedback = feedbackValidationBudget([["pnpm", "exec", "prettier"]]);
    assert.equal(feedback.profile, "feedback");
    assert.equal(feedback.totalMs, 120000);
    assert.equal(feedback.combinedCeilingMs, 120000);
  });

  it("routes an Apple feedback delta to the build-only Apple feedback profile and nothing Web, CMS or browser", () => {
    const output = "/private/synthetic-output";
    const planned = planFeedbackCommands(
      { feedbackPaths: ["apps/apple/Sources/App.swift"] },
      output,
      { root },
    );
    assert.equal(planned.unresolved, null);
    assert.deepEqual(planned.commands, [
      [
        process.execPath,
        "scripts/verify-apple.mjs",
        "--profile",
        "feedback",
        "--output",
        join(output, "apple"),
        "--remaining-ms",
        REMAINING_MS_TOKEN,
      ],
    ]);
    assert.ok(
      planned.uncheckedCoverage.some((item) =>
        /Apple native unit\/UI tests \(feedback build is build-only\)/u.test(
          item,
        ),
      ),
    );
    assert.doesNotMatch(
      joined(planned.commands),
      /scripts\/verify\.mjs|test:cms|ci-e2e-smoke|prettier|eslint|vitest|playwright/u,
    );
    const web = planFeedbackCommands(
      { feedbackPaths: ["apps/web/features/home/home-screen.module.css"] },
      output,
      { root },
    );
    assert.doesNotMatch(joined(web.commands), /verify-apple|xcodebuild/u);
  });

  it("reports the effective profile, ceiling and per-check elapsed time, and repeats one fingerprint for identical content without erasing the prior result", async (t) => {
    const directory = temporary(t);
    const command = [
      process.execPath,
      "-e",
      "process.exit(Number(process.argv[1]) > 0 ? 0 : 1)",
      REMAINING_MS_TOKEN,
    ];
    const checks = [
      {
        name: "synthetic",
        profile: VALIDATION_PROFILES.webComplete.name,
        totalMs: VALIDATION_PROFILES.webComplete.totalMs,
        commands: [command],
      },
    ];
    const budget = taskValidationBudget(checks);
    const first = freshOutput(join(directory, "run-1"), root);
    assert.equal(
      await validate([command], first, { mode: "actual-diff" }, budget),
      0,
    );
    const summary = JSON.parse(
      readFileSync(join(first, "summary.json"), "utf8"),
    );
    assert.equal(summary.result, "PASS");
    assert.equal(summary.profile, "explicit-profile-sum");
    assert.equal(summary.totalMs, 300000);
    assert.equal(summary.ceilingMs, 300000 - STARTUP_MARGIN_MS);
    assert.equal(summary.combinedCeilingMs, 900000);
    assert.deepEqual(summary.checks, [
      {
        name: "synthetic",
        profile: "web-complete",
        totalMs: 300000,
        commands: 1,
      },
    ]);
    const [run] = summary.executed;
    assert.equal(run.check, "synthetic");
    assert.equal(run.command.at(-1), String(run.remainingMs));
    assert.ok(run.remainingMs > 0 && run.remainingMs <= summary.ceilingMs);
    assert.ok(Number.isInteger(run.durationMs) && run.durationMs >= 0);
    assert.equal(run.code, 0);
    assert.equal(summary.accounting.elapsedMs, summary.durationMs);
    assert.match(summary.accounting.note, /reporting only/u);
    assert.match(summary.sourceFingerprint, /^[a-f0-9]{64}$/u);
    assert.equal(
      summary.sourceFingerprint,
      sourceFingerprint(summary.contentBefore),
    );
    assert.equal(summary.contentUnchanged, true);
    const firstBytes = readFileSync(join(first, "summary.json"));
    const second = freshOutput(join(directory, "run-2"), root);
    assert.equal(
      await validate([command], second, { mode: "actual-diff" }, budget),
      0,
    );
    const retry = JSON.parse(
      readFileSync(join(second, "summary.json"), "utf8"),
    );
    assert.equal(retry.sourceFingerprint, summary.sourceFingerprint);
    assert.deepEqual(readFileSync(join(first, "summary.json")), firstBytes);
    assert.throws(() => freshOutput(first, root));
    assert.notEqual(
      sourceFingerprint({ ...summary.contentBefore, head: "other" }),
      summary.sourceFingerprint,
    );
  });

  it("fits the browser smoke server timeout inside the global timeout and the parent's remaining time", () => {
    assert.equal(SMOKE_PROFILES.warm.totalMs, 120000);
    assert.equal(SMOKE_PROFILES.cold.totalMs, 300000);
    assert.deepEqual(smokeOptions([]), { profile: "warm", remainingMs: null });
    assert.deepEqual(
      smokeOptions(["--profile", "cold", "--remaining-ms", "250000"]),
      { profile: "cold", remainingMs: 250000 },
    );
    assert.throws(() => smokeOptions(["--profile", "full"]));
    assert.throws(() => smokeOptions(["--list"]));
    const warm = smokeBudget("warm");
    assert.equal(warm.ceilingMs, 120000);
    assert.equal(warm.globalTimeoutMs, 110000);
    assert.equal(warm.webServerTimeoutMs, 60000);
    assert.equal(warm.viable, true);
    const cold = smokeBudget("cold");
    assert.equal(cold.ceilingMs, 300000);
    assert.equal(cold.globalTimeoutMs, 280000);
    assert.equal(cold.webServerTimeoutMs, 120000);
    const bounded = smokeBudget("warm", 50000);
    assert.equal(bounded.ceilingSource, "parent-remaining");
    assert.equal(bounded.globalTimeoutMs, 40000);
    assert.equal(bounded.webServerTimeoutMs, 20000);
    for (const budget of [
      warm,
      cold,
      bounded,
      smokeBudget("cold", 100000, 15000),
    ]) {
      assert.ok(budget.webServerTimeoutMs < budget.globalTimeoutMs);
      assert.ok(budget.globalTimeoutMs + budget.reserveMs <= budget.ceilingMs);
    }
    assert.equal(smokeBudget("cold", null, 290000).globalTimeoutMs, 0);
    assert.equal(smokeBudget("warm", 29999).viable, false);
    assert.equal(smokeBudget("cold", 59999).viable, false);
    assert.equal(smokeBudget("cold", 999999).ceilingMs, 300000);
    const smoke = read("scripts/ci-e2e-smoke.mjs");
    assert.match(smoke, /--global-timeout=\$\{current\.globalTimeoutMs\}/u);
    assert.match(
      smoke,
      /MOYA_E2E_WEBSERVER_TIMEOUT_MS: String\(current\.webServerTimeoutMs\)/u,
    );
    assert.doesNotMatch(smoke, /--global-timeout=90000/u);
    const config = read("tests/e2e/playwright.config.ts");
    assert.match(config, /process\.env\.MOYA_E2E_WEBSERVER_TIMEOUT_MS/u);
    assert.match(config, /timeout: webServerTimeoutMs,/u);
    assert.match(config, /globalTimeout: 0,/u);
  });

  it("gives CMS integration and native browser validation explicit complete profiles whose children receive the session's remaining time", () => {
    assert.equal(CMS_PROFILES.quick.totalMs, 120000);
    // The unflagged CMS run is an ordinary quick check, never "feedback".
    assert.equal(CMS_PROFILES.quick.name, "cms-quick");
    assert.equal(cmsBudget("quick").profile, "cms-quick");
    assert.equal(CMS_PROFILES.complete.totalMs, 300000);
    assert.deepEqual(cmsOptions([]), { profile: "quick", remainingMs: null });
    assert.deepEqual(cmsOptions(["--profile", "complete"]), {
      profile: "complete",
      remainingMs: null,
    });
    assert.throws(() => cmsOptions(["--unknown"]));
    const complete = cmsBudget("complete");
    assert.equal(complete.ceilingMs, 300000);
    assert.equal(complete.sessionBudgetMs, 300000 - CMS_FINALIZATION_MS);
    assert.equal(complete.viable, true);
    assert.equal(
      cmsBudget("quick").sessionBudgetMs,
      120000 - CMS_FINALIZATION_MS,
    );
    const bounded = cmsBudget("complete", 90000);
    assert.equal(bounded.ceilingSource, "parent-remaining");
    assert.equal(bounded.ceilingMs, 90000);
    assert.equal(bounded.sessionBudgetMs, 90000 - CMS_FINALIZATION_MS);
    assert.equal(cmsBudget("complete", 59999).viable, false);
    assert.equal(cmsBudget("complete", 999999).ceilingMs, 300000);
    assert.throws(
      () =>
        resolveCmsBudget(["--profile", "complete", "--remaining-ms", "5000"]),
      /INSUFFICIENT_REMAINING_TIME/u,
    );
    assert.equal(boundedChildLimit(45000, 200000), 45000);
    assert.equal(boundedChildLimit(45000, 30000), 22000);
    assert.equal(boundedChildLimit(45000, 5000), 1);
    const cms = read("scripts/editorial/verify-cms.mjs");
    assert.match(
      cms,
      /--testTimeout=\$\{boundedChildLimit\(30_000, session\.remaining\(\)\)\}/u,
    );
    assert.match(
      cms,
      /--hookTimeout=\$\{boundedChildLimit\(60_000, session\.remaining\(\)\)\}/u,
    );
    assert.match(
      read("scripts/editorial/verify-owner-browser.mjs"),
      /boundedChildLimit\(NATIVE_SERVER_START_MS, session\.remaining\(\)\)/u,
    );
    // Both entries fail fast on an unusable remaining time or profile before
    // any database, build or browser work; no CMS target is contacted.
    const env = { ...process.env };
    delete env.CMS_TEST_DATABASE_URL;
    delete env.CMS_DATABASE_URL;
    for (const script of [
      "scripts/editorial/verify-cms.mjs",
      "scripts/editorial/verify-owner-browser.mjs",
    ]) {
      const insufficient = spawnSync(
        process.execPath,
        [join(root, script), "--profile", "complete", "--remaining-ms", "5000"],
        { cwd: root, env, encoding: "utf8", timeout: 20000 },
      );
      assert.equal(insufficient.status, 124, script + insufficient.stderr);
      const lines = insufficient.stdout
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      assert.deepEqual(lines[0], {
        profile: "cms-complete",
        totalMs: 300000,
        ceilingMs: 5000,
        ceilingSource: "parent-remaining",
        minimumMs: 60000,
      });
      assert.equal(lines.at(-1).category, "INSUFFICIENT_REMAINING_TIME");
      const invalid = spawnSync(
        process.execPath,
        [join(root, script), "--profile", "full"],
        { cwd: root, env, encoding: "utf8", timeout: 20000 },
      );
      assert.equal(invalid.status, 1, script);
      assert.equal(
        JSON.parse(invalid.stdout.trim()).category,
        "INVALID_PROFILE",
      );
    }
  });
});

describe("semantic workspace selection and cumulative coverage", () => {
  it("retains the monolithic tests while selecting real dependent consumers", () => {
    assert.deepEqual(
      classifyTask(["apps/web/features/home/home-screen.tsx"]).webWorkspaces,
      ["@moya/tests", "web"],
    );
    const image = classifyTask(["packages/image/src/index.ts"]);
    for (const name of [
      "@moya/image",
      "@moya/tests",
      "@moya/backend-production",
      "web",
    ])
      assert.ok(image.webWorkspaces.includes(name), name);
    const admin = classifyTask(["apps/admin/src/community/endpoints.ts"]);
    assert.ok(admin.webWorkspaces.includes("admin"));
    assert.ok(admin.webWorkspaces.includes("@moya/tests"));
  });
  it("uses the broad plan for security, migrations, global configuration and unresolved dependencies", () => {
    for (const file of [
      "services/backend-runtime/src/community/auth-handler.ts",
      "database/schema.sql",
      "turbo.json",
      "tests/unit/backend/catalog-http.test.ts",
      "apps/admin/payload.config.ts",
    ])
      assert.deepEqual(classifyTask([file]).webWorkspaces ?? [], [], file);
    assert.deepEqual(
      affectedWebWorkspaces(
        ["apps/web/app/page.tsx"],
        "/missing/synthetic-repository",
      ),
      [],
    );
    assert.throws(
      () => classifyTask(["services/new-runtime/src/index.ts"]),
      /Unmapped/u,
    );
    for (const file of [
      "scripts/task-context.mjs",
      "scripts/task-resources.mjs",
    ])
      assert.deepEqual(flags(classifyTask([file])), expectedFlags({}), file);
  });
  it("runs focused contract suites once when the full Web invocation already includes them", () => {
    const plan = classifyTask([
      "packages/contracts/src/catalog.ts",
      "apps/web/app/page.tsx",
    ]);
    assert.equal(plan.contracts, true);
    const commands = taskCommands(plan, "/private/synthetic-output");
    assert.ok(
      commands.some((command) => command.includes("scripts/verify.mjs")),
    );
    assert.ok(!commands.some((command) => command.includes("unit/contracts")));
    assert.ok(plan.webWorkspaces.includes("@moya/tests"));
    assert.ok(plan.webWorkspaces.includes("web"));
    assert.ok(
      taskCommands({ contracts: true }, "/private/synthetic-output").some(
        (command) => command.includes("unit/contracts"),
      ),
    );
  });
  it("keeps persisted cache writes restricted to libraries and adds root/toolchain invalidation", () => {
    const workflow = read(".github/workflows/ci.yml");
    assert.equal(
      (workflow.match(/path: \.turbo\/library-cache/gu) ?? []).length,
      3,
    );
    assert.doesNotMatch(workflow, /path: \.turbo\/cache/u);
    assert.equal(
      JSON.parse(read("package.json")).scripts.test,
      "pnpm test:confidentiality && turbo run test --cache-dir=.turbo/library-cache --cache=local:r",
    );
    const scopedTest = verificationCommands(
      verificationPlan("test", ["--workspaces", "@moya/tests"]),
    );
    assert.deepEqual(scopedTest[0], ["pnpm", "test:confidentiality"]);
    assert.deepEqual(scopedTest[1], [
      "pnpm",
      "exec",
      "turbo",
      "run",
      "test",
      "--filter=@moya/tests",
      "--cache-dir=.turbo/library-cache",
      "--cache=local:r",
    ]);
    const config = JSON.parse(read("turbo.json"));
    assert.ok(config.globalDependencies.includes(".nvmrc"));
    assert.ok(config.globalDependencies.includes("tsconfig.base.json"));
    assert.ok(config.globalEnv.includes("MOYA_VERIFICATION_TOOLCHAIN"));
  });
});
