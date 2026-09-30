import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  writeFileSync,
  realpathSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
} from "node:fs";
import {
  resolve,
  relative,
  isAbsolute,
  join,
  dirname,
  basename,
} from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { runWithinBudget, STARTUP_MARGIN_MS, GRACE_MS } from "./verify.mjs";
import { performance } from "node:perf_hooks";
import {
  EVIDENCE_VERSION,
  staticCheckFiles,
  evidenceToolchain,
  checkInputIdentity,
  reuseDecision,
  readReuseSummary,
  sourceInventory,
} from "./verification-evidence.mjs";
import {
  VALIDATION_PROFILES,
  REMAINING_MS_TOKEN,
} from "./validation-profiles.mjs";
import {
  classifyTask,
  isSecurityPath,
  localPaths,
  runGit,
  nulPaths,
} from "./ci-task-scope.mjs";

/** Validate and resolve a private output path without creating it. */
export function resolveFreshOutput(value, root = process.cwd()) {
  if (!value || !isAbsolute(value))
    throw new Error(
      "An absolute, unique private --output directory is required",
    );
  const output = join(realpathSync(dirname(resolve(value))), basename(value));
  const rel = relative(realpathSync(root), output);
  if (rel === "" || (!rel.startsWith("../") && !isAbsolute(rel)))
    throw new Error("Validation output must be outside this worktree");
  if (existsSync(output))
    throw new Error("Output already exists; do not overwrite another run");
  return output;
}

export function freshOutput(value, root = process.cwd()) {
  const output = resolveFreshOutput(value, root);
  mkdirSync(output, { mode: 0o700 });
  return output;
}

export const contractCommands = () => [
  [
    "pnpm",
    "exec",
    "turbo",
    "run",
    "build",
    "--filter=@moya/backend-production...",
    "--filter=@moya/catalog-importer...",
    "--no-daemon",
    "--cache-dir=.turbo/library-cache",
  ],
  [
    "pnpm",
    "--filter",
    "@moya/tests",
    "exec",
    "vitest",
    "run",
    "unit/contracts",
    "unit/backend/openapi-contract.test.ts",
    "unit/backend/catalog-http.test.ts",
    "unit/backend/community-http.test.ts",
    "unit/backend/community-comment-http.test.ts",
    "unit/backend/search-v1-http.test.ts",
  ],
  ["pnpm", "--filter", "web", "exec", "vitest", "run", "lib/public-api"],
];

export function scriptTests(root = process.cwd()) {
  const files = readdirSync(join(root, "scripts"))
    .filter((file) => /^[a-z-]+\.test\.mjs$/u.test(file))
    .sort()
    .map((file) => `scripts/${file}`);
  if (files.length === 0)
    throw new Error("No script tests found under scripts/");
  return files;
}

const remainingArgs = ["--remaining-ms", REMAINING_MS_TOKEN];
const declared = (profile) => ({
  profile: profile.name,
  totalMs: profile.totalMs,
});

/**
 * The selected checks of the default cumulative entry, each with its declared
 * profile. Selection follows the classified plan only: Apple-only work gets no
 * Web, CMS or browser command; Web-only work launches no Xcode; shared tooling
 * gets its genuinely affected routing regressions. Children that own a profile
 * receive the parent's remaining time, never a renewed allowance.
 */
export function taskChecks(plan, output) {
  const checks = [
    {
      // Every dependency-free script test: routing, gates, the disposable
      // test-target guard and the agent permission guard get behavioral checks
      // even when a task touches only lightweight paths. The files are
      // enumerated so a missing suite fails instead of passing vacuously.
      name: "script-tests",
      ...declared(VALIDATION_PROFILES.scriptTests),
      commands: [[process.execPath, "--test", ...scriptTests()]],
    },
  ];
  // The full Web test invocation already covers the focused contract and HTTP
  // suites; do not run the same tests twice within one candidate plan.
  const completeContractConsumers =
    plan.web &&
    (!plan.webWorkspaces?.length ||
      ["@moya/tests", "web"].every((name) =>
        plan.webWorkspaces.includes(name),
      ));
  if (plan.contracts && !completeContractConsumers)
    checks.push({
      name: "contracts",
      ...declared(VALIDATION_PROFILES.webComplete),
      commands: contractCommands(),
    });
  if (plan.web)
    checks.push({
      // `verify.mjs all` is itself a serial combination of the complete Web
      // checks and the cold browser smoke, so it declares the combined ceiling.
      name: "web",
      ...declared(VALIDATION_PROFILES.localCombined),
      serial: true,
      commands: [
        [
          process.execPath,
          "scripts/verify.mjs",
          "all",
          "--profile",
          "complete",
          ...(plan.webWorkspaces?.length
            ? ["--workspaces", plan.webWorkspaces.join(",")]
            : []),
          ...remainingArgs,
        ],
      ],
    });
  if (plan.cms)
    checks.push(
      {
        name: "cms",
        ...declared(VALIDATION_PROFILES.cmsComplete),
        commands: [
          ["pnpm", "test:cms", "--profile", "complete", ...remainingArgs],
        ],
      },
      {
        name: "cms-browser",
        ...declared(VALIDATION_PROFILES.cmsComplete),
        commands: [
          [
            "pnpm",
            "test:cms:browser",
            "--profile",
            "complete",
            ...remainingArgs,
          ],
        ],
      },
    );
  if (plan.apple)
    checks.push({
      name: "apple",
      ...declared(VALIDATION_PROFILES.appleFull),
      commands: [
        [
          process.execPath,
          "scripts/verify-apple.mjs",
          "--profile",
          "full",
          "--output",
          join(output, "apple"),
          ...remainingArgs,
        ],
      ],
    });
  return checks;
}

export function taskCommands(plan, output) {
  return taskChecks(plan, output).flatMap((check) => check.commands);
}

/**
 * The parent plan's declared profile: LOCAL FULL COMBINED when a selected
 * check is itself a serial combination or the explicit profiles together
 * exceed the combined ceiling; otherwise the sum of the selected explicit
 * profiles. The total is always capped at the combined ceiling.
 */
export function taskValidationBudget(checks) {
  const combined = VALIDATION_PROFILES.localCombined;
  const sumMs = checks.reduce((total, check) => total + check.totalMs, 0);
  const serialCombination =
    checks.some((check) => check.serial) || sumMs > combined.totalMs;
  return {
    profile: serialCombination ? combined.name : "explicit-profile-sum",
    totalMs: Math.min(combined.totalMs, sumMs),
    combinedCeilingMs: combined.totalMs,
    serialCombination,
    checks: checks.map(({ name, profile, totalMs, commands }) => ({
      name,
      profile,
      totalMs,
      commands: commands.length,
    })),
    // Capping is visible: later checks get only the remaining time, and a
    // child that fails fast on it is a truthful non-PASS, never acceptance.
    ...(sumMs > combined.totalMs
      ? {
          note: `explicit profiles sum to ${sumMs} ms; the local combined plan is capped at ${combined.totalMs} ms, so later checks receive the remaining time and a check that fails fast on it is a truthful non-PASS, not acceptance. The CI jobs run each check under its own profile.`,
        }
      : {}),
  };
}

export function feedbackValidationBudget(commands) {
  return {
    profile: VALIDATION_PROFILES.feedback.name,
    totalMs: VALIDATION_PROFILES.feedback.totalMs,
    combinedCeilingMs: VALIDATION_PROFILES.feedback.totalMs,
    serialCombination: false,
    checks: [
      {
        name: "feedback",
        profile: VALIDATION_PROFILES.feedback.name,
        totalMs: VALIDATION_PROFILES.feedback.totalMs,
        commands: commands.length,
      },
    ],
  };
}

const FEEDBACK_WEB_CONFIG =
  /(?:^|\/)(?:package\.json|tsconfig\.json|middleware\.ts|(?:next|vitest|playwright|eslint|prettier)?\.config\.[cm]?[jt]s)$/u;
const FEEDBACK_PRESENTATION =
  /\.(?:module\.css|css|scss|sass|less|svg|png|jpe?g|webp|gif|avif|ico|woff2?|ttf|otf)$/u;
const FEEDBACK_SOURCE = /\.(?:[cm]?[jt]sx?)$/u;
const FEEDBACK_LINTABLE = /\.(?:[cm]?[jt]sx?)$/u;
const FEEDBACK_WEB_TEST = /\.(?:test|spec|integration\.test)\.[cm]?[jt]sx?$/u;
const FEEDBACK_UNSUPPORTED_DEFAULT =
  "Use the default verify-task entry for complete validation.";

const FEEDBACK_WORKSPACE_CONFIG = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "turbo.json",
  "tsconfig.base.json",
  "compose.dev.yml",
  "compose.postgres.yml",
  ".nvmrc",
  ".env.example",
  ".editorconfig",
  ".prettierignore",
  "eslint.config.mjs",
  "prettier.config.mjs",
]);

const FEEDBACK_CMS_FILES = new Set([
  "scripts/disposable-test-target.mjs",
  "infra/test/disposable-test-target.sql",
  "tests/integration/postgres/synthetic-test-database.ts",
]);

function isPublicContractPath(file) {
  return (
    (file.startsWith("packages/contracts/") &&
      !file.startsWith("packages/contracts/src/internal/")) ||
    file.startsWith("services/public-api/") ||
    /^services\/backend-runtime\/src\/community\/(?:session|auth|community-handler)/u.test(
      file,
    )
  );
}

// Deliberately finite: new files never acquire focused coverage by a wildcard.
export const FOCUSED_FEEDBACK = Object.freeze({
  "services/api/src/modules/catalog/application/services/catalog-read-service.ts":
    {
      kind: "backend",
      workspace: "@moya/api",
      tests: [
        "unit/backend/catalog-read-service.test.ts",
        "unit/backend/catalog-http.test.ts",
      ],
    },
  "services/api/src/modules/catalog/application/mappers/catalog-public-contract-mapper.ts":
    {
      kind: "backend",
      workspace: "@moya/api",
      tests: [
        "unit/backend/catalog-public-mapper.test.ts",
        "unit/backend/catalog-http.test.ts",
      ],
    },
  "services/api/src/modules/catalog/application/queries/catalog-list-query.ts":
    {
      kind: "backend",
      workspace: "@moya/api",
      tests: [
        "unit/backend/catalog-list-query.test.ts",
        "unit/backend/catalog-http.test.ts",
      ],
    },
  "services/api/src/modules/catalog/application/catalog-read-projections.ts": {
    kind: "backend",
    workspace: "@moya/api",
    tests: [
      "unit/backend/catalog-read-projections.test.ts",
      "unit/backend/catalog-http.test.ts",
    ],
  },
  "services/api/src/modules/community/application/services/catalog-comment-service.ts":
    {
      kind: "backend",
      workspace: "@moya/api",
      tests: [
        "unit/backend/catalog-comment-service.test.ts",
        "unit/backend/community-comment-http.test.ts",
      ],
    },
  "services/api/src/modules/community/application/services/community-moderation-service.ts":
    {
      kind: "backend",
      workspace: "@moya/api",
      tests: [
        "unit/backend/community-moderation-service.test.ts",
        "unit/backend/community-http.test.ts",
      ],
    },
  "services/api/src/modules/community/application/services/author-community-service.ts":
    {
      kind: "backend",
      workspace: "@moya/api",
      tests: [
        "unit/backend/author-community-service.test.ts",
        "unit/backend/community-http.test.ts",
      ],
    },
  "services/api/src/modules/community/application/services/agent-administration-service.ts":
    {
      kind: "backend",
      workspace: "@moya/api",
      tests: [
        "unit/backend/agent-administration-service.test.ts",
        "unit/backend/agent-boundary-http.test.ts",
      ],
    },
  "apps/admin/src/community/endpoints.ts": {
    kind: "admin",
    workspace: "admin",
    tests: ["unit/backend/community-admin-endpoints.test.ts"],
  },
  "apps/admin/src/community/bulk-actions.tsx": {
    kind: "admin",
    workspace: "admin",
    tests: ["unit/backend/community-bulk-actions.test.ts"],
  },
  "apps/admin/src/agent-connections/connections-client.tsx": {
    kind: "admin",
    workspace: "admin",
    tests: ["unit/admin/agent-connections-page.test.tsx"],
  },
  "packages/image/src/index.ts": {
    kind: "shared",
    workspace: "@moya/image",
    tests: [
      "unit/backend/image-resolver.test.ts",
      "unit/architecture/image-surface.test.ts",
    ],
  },
  "packages/search/src/index.ts": {
    kind: "shared",
    workspace: "@moya/search",
    tests: [
      "unit/backend/search-normalization.test.ts",
      "unit/backend/search-golden.test.ts",
    ],
  },
  "packages/design-tokens/src/index.ts": {
    kind: "shared",
    workspace: "@moya/design-tokens",
    tests: ["unit/ui/tokens.test.ts"],
  },
  "packages/ui/src/components/navigation.tsx": {
    kind: "shared",
    workspace: "@moya/ui",
    tests: [
      "unit/ui/components.test.ts",
      "unit/ui/styles-and-architecture.test.ts",
    ],
  },
  "packages/ui/src/components/feedback.tsx": {
    kind: "shared",
    workspace: "@moya/ui",
    tests: [
      "unit/ui/components.test.ts",
      "unit/ui/styles-and-architecture.test.ts",
    ],
  },
  "packages/ui/src/components/layout.tsx": {
    kind: "shared",
    workspace: "@moya/ui",
    tests: [
      "unit/ui/components.test.ts",
      "unit/ui/styles-and-architecture.test.ts",
    ],
  },
  "packages/ui/src/components/primitives.tsx": {
    kind: "shared",
    workspace: "@moya/ui",
    tests: [
      "unit/ui/components.test.ts",
      "unit/ui/styles-and-architecture.test.ts",
    ],
  },
  "packages/ui/src/components/content.tsx": {
    kind: "shared",
    workspace: "@moya/ui",
    tests: [
      "unit/ui/components.test.ts",
      "unit/ui/styles-and-architecture.test.ts",
    ],
  },
  "packages/ui/src/components/tabs.tsx": {
    kind: "shared",
    workspace: "@moya/ui",
    tests: [
      "unit/ui/components.test.ts",
      "unit/ui/styles-and-architecture.test.ts",
    ],
  },
  "packages/ui/src/components/overlays.tsx": {
    kind: "shared",
    workspace: "@moya/ui",
    tests: [
      "unit/ui/components.test.ts",
      "unit/ui/styles-and-architecture.test.ts",
    ],
  },
});

export function classifyFeedbackPath(file) {
  if (
    isSecurityPath(file) &&
    !file.startsWith("docs/") &&
    !file.endsWith(".md")
  )
    return "security";
  if (Object.hasOwn(FOCUSED_FEEDBACK, file)) return "focused";
  if (
    file.startsWith("apps/admin/") ||
    file.startsWith("tests/cms/") ||
    file.startsWith("scripts/editorial/") ||
    FEEDBACK_CMS_FILES.has(file)
  )
    return "cms";
  if (file.startsWith("apps/apple/")) return "apple";
  if (file.startsWith("apps/harmony/"))
    return file.endsWith(".md") ? "docs" : "harmony";
  if (
    file.startsWith("database/") ||
    file.startsWith("services/catalog-postgres/") ||
    file.startsWith("services/community-postgres/") ||
    /(?:^|\/)migrations\//u.test(file) ||
    (file.endsWith(".sql") && !file.startsWith("docs/"))
  )
    return "database";
  if (isPublicContractPath(file) || file.startsWith("packages/contracts/"))
    return "contracts";
  if (
    FEEDBACK_WORKSPACE_CONFIG.has(file) ||
    file.startsWith("packages/") ||
    file.startsWith("services/") ||
    file.startsWith("infra/") ||
    file.startsWith("tests/") ||
    file.startsWith("experiments/")
  )
    return "shared";
  if (/^scripts\/[a-z-]+\.(?:test\.)?mjs$/u.test(file)) return "tooling";
  if (file.startsWith("apps/web/")) {
    if (FEEDBACK_WEB_CONFIG.test(file)) return "web-config";
    if (FEEDBACK_PRESENTATION.test(file)) return "presentation";
    if (FEEDBACK_SOURCE.test(file)) return "behavior";
    return "shared";
  }
  if (
    file.startsWith("docs/") ||
    file.startsWith(".agents/") ||
    file.startsWith(".claude/") ||
    file.startsWith(".github/") ||
    file.startsWith(".githooks/") ||
    file.endsWith(".md") ||
    file === ".mcp.json" ||
    file === ".gitignore" ||
    file === "scripts/README.md"
  )
    return "docs";
  return "shared";
}

function colocatedWebTests(file, root, exists) {
  if (FEEDBACK_WEB_TEST.test(file)) return [file];
  const stem = file.replace(/\.[cm]?[jt]sx?$/u, "");
  return [
    `${stem}.test.ts`,
    `${stem}.test.tsx`,
    `${stem}.spec.ts`,
    `${stem}.spec.tsx`,
    `${stem}.integration.test.ts`,
    `${stem}.integration.test.tsx`,
  ].filter((candidate) => exists(join(root, candidate)));
}

function matchingScriptTests(file, root) {
  if (/^scripts\/[a-z-]+\.test\.mjs$/u.test(file)) return [file];
  const match = /^scripts\/([a-z-]+)\.mjs$/u.exec(file);
  if (!match) return [];
  const name = match[1];
  let available = [];
  try {
    available = scriptTests(root);
  } catch {
    return [];
  }
  const dedicated = available.filter(
    (test) =>
      test === `scripts/${name}.test.mjs` ||
      test.startsWith(`scripts/${name}-`),
  );
  if (dedicated.length) return dedicated;
  return available.includes("scripts/task-validation.test.mjs")
    ? ["scripts/task-validation.test.mjs"]
    : [];
}

function feedbackUncheckedCoverage(kinds) {
  const coverage = [
    "workspace-wide lint/typecheck/test/build",
    "browser smoke",
    "PostgreSQL",
    "CMS",
    kinds.has("apple")
      ? "Apple native unit/UI tests (feedback build is build-only)"
      : "Apple",
    "full acceptance / merge permission",
  ];
  if (!kinds.has("tooling"))
    coverage.splice(5, 0, "complete scripts/ test suite");
  return coverage;
}

export function planFeedbackCommands(
  detail,
  output = "",
  { root = process.cwd(), exists = existsSync } = {},
) {
  const paths = [...new Set(detail?.feedbackPaths ?? [])].sort();
  const groups = {
    presentation: [],
    behavior: [],
    contracts: [],
    tooling: [],
    docs: [],
    focused: [],
    apple: [],
    unsupported: [],
  };
  const kinds = new Map();
  for (const file of paths) {
    const kind = classifyFeedbackPath(file);
    kinds.set(file, kind);
    if (groups[kind]) groups[kind].push(file);
    else groups.unsupported.push(file);
  }

  const unsupportedCoverage = groups.unsupported.map(
    (file) => `${file} (${kinds.get(file)})`,
  );
  const commands = [];
  const prettierFiles = [
    ...groups.presentation,
    ...groups.behavior,
    ...groups.docs,
    ...groups.focused,
  ];
  const eslintFiles = [
    ...groups.behavior,
    ...groups.docs,
    ...groups.focused,
  ].filter((file) => FEEDBACK_LINTABLE.test(file));
  if (prettierFiles.length)
    commands.push(["pnpm", "exec", "prettier", "--check", ...prettierFiles]);
  if (eslintFiles.length)
    commands.push(["pnpm", "exec", "eslint", ...eslintFiles]);

  const webTests = [
    ...new Set(
      groups.behavior.flatMap((file) => colocatedWebTests(file, root, exists)),
    ),
  ]
    .sort()
    .map((file) => file.slice("apps/web/".length));
  if (groups.behavior.some((file) => FEEDBACK_SOURCE.test(file)))
    commands.push(["pnpm", "--filter", "web", "typecheck"]);
  if (webTests.length)
    commands.push([
      "pnpm",
      "--filter",
      "web",
      "exec",
      "vitest",
      "run",
      ...webTests,
    ]);

  const scriptFiles = [
    ...new Set(
      groups.tooling.flatMap((file) => matchingScriptTests(file, root)),
    ),
  ].sort();
  if (scriptFiles.length)
    commands.push([process.execPath, "--test", ...scriptFiles]);
  const focused = groups.focused.map((file) => FOCUSED_FEEDBACK[file]);
  const missingFocusedTests = [
    ...new Set(focused.flatMap(({ tests }) => tests)),
  ].filter((test) => !exists(join(root, "tests", test)));
  if (focused.length) {
    const workspaces = [
      ...new Set(focused.map(({ workspace }) => workspace)),
    ].sort();
    const buildFilters = workspaces.map(
      (workspace) =>
        `--filter=${workspace}${workspace === "admin" ? "^..." : "..."}`,
    );
    commands.push([
      "pnpm",
      "exec",
      "turbo",
      "run",
      "build",
      ...buildFilters,
      "--cache-dir=.turbo/library-cache",
    ]);
    commands.push([
      "pnpm",
      "exec",
      "turbo",
      "run",
      "typecheck",
      ...workspaces.map((workspace) => `--filter=${workspace}...`),
    ]);
    commands.push([
      "pnpm",
      "--filter",
      "@moya/tests",
      "exec",
      "vitest",
      "run",
      ...[...new Set(focused.flatMap(({ tests }) => tests))].sort(),
    ]);
  }
  if (groups.contracts.length) commands.push(...contractCommands());
  // An Apple delta gets the build-only Apple feedback profile under this
  // plan's remaining time. Native tests stay unchecked and are listed as such.
  if (groups.apple.length)
    commands.push([
      process.execPath,
      "scripts/verify-apple.mjs",
      "--profile",
      "feedback",
      "--output",
      join(output || "<output>", "apple"),
      ...remainingArgs,
    ]);

  let unresolved = null;
  if (paths.length === 0) {
    unresolved =
      "No committed, staged, unstaged or untracked paths since the feedback checkpoint; no product delta was treated as checked";
  } else if (missingFocusedTests.length) {
    unresolved = `Mapped feedback tests are missing: ${missingFocusedTests.join(", ")}; scope is not treated as checked`;
  } else if (unsupportedCoverage.length) {
    unresolved = `Feedback coverage is unsupported for ${unsupportedCoverage.join(", ")}; not treated as checked. ${FEEDBACK_UNSUPPORTED_DEFAULT}`;
  } else if (commands.length === 0) {
    unresolved = `Feedback selected no relevant checks; not treated as checked. ${FEEDBACK_UNSUPPORTED_DEFAULT}`;
  }

  const missingBehaviorTests = groups.behavior.filter(
    (file) =>
      !FEEDBACK_WEB_TEST.test(file) &&
      colocatedWebTests(file, root, exists).length === 0,
  );

  return {
    commands: unresolved ? [] : commands,
    kinds: Object.fromEntries(kinds),
    unsupportedCoverage,
    uncheckedCoverage: [
      ...feedbackUncheckedCoverage(new Set(kinds.values())),
      ...missingBehaviorTests.map(
        (file) => `no colocated Web unit test for ${file}`,
      ),
    ],
    unresolved,
    note: FEEDBACK_LABEL,
  };
}

export function feedbackCommands(detail, output, options) {
  const planned = planFeedbackCommands(detail, output, options);
  if (planned.unresolved) throw new Error(planned.unresolved);
  return planned.commands;
}

export function formatFeedbackCommandSelection(selection) {
  const commands = (selection?.commands ?? []).map((command) =>
    command.join(" "),
  );
  const lines = [
    `selected-commands: ${commands.length ? commands.join(" | ") : "(none)"}`,
    `unchecked-coverage: ${(selection?.uncheckedCoverage ?? []).join("; ")}`,
  ];
  if (selection?.unresolved)
    lines.push(`unresolved-coverage: ${selection.unresolved}`);
  lines.push(
    "This preview is not full acceptance and cannot replace the default verify-task entry.",
  );
  return lines.join("\n");
}

export function selectTaskValidationCommands({
  mode,
  plan,
  detail,
  output,
  options,
}) {
  return mode === "feedback"
    ? feedbackCommands(detail, output, options)
    : taskCommands(plan, output);
}

export function validationEnvironment(output, head, env = process.env) {
  return {
    ...env,
    MOYA_E2E_ARTIFACT_DIR: join(output, "web-smoke"),
    MOYA_E2E_SOURCE_HEAD: head,
    ...(env.GITHUB_ACTIONS === "true"
      ? {}
      : {
          GITHUB_RUN_ID: `local-${Date.now()}-${process.pid}`,
          GITHUB_RUN_ATTEMPT: "1",
        }),
  };
}

export function workspaceFingerprint(git = runGit) {
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const root = git("rev-parse", "--show-toplevel").trim();
  const untracked = nulPaths(
    git("ls-files", "--others", "--exclude-standard", "-z"),
    true,
  )
    .sort()
    .map((file) => {
      const path = join(root, file),
        info = lstatSync(path);
      return {
        file,
        mode: info.mode,
        sha256: hash(
          info.isSymbolicLink() ? readlinkSync(path) : readFileSync(path),
        ),
      };
    });
  return {
    head: git("rev-parse", "HEAD").trim(),
    stagedDiffSha256: hash(git("diff", "--cached", "--binary", "HEAD", "--")),
    workingDiffSha256: hash(git("diff", "--binary", "--")),
    untracked,
  };
}

/**
 * One value for the exact validated content (HEAD plus every dirty byte). A
 * rerun on identical content repeats this value, so it is recognizable as an
 * unchanged retry of the earlier result rather than new evidence; the earlier
 * output directory is never overwritten (see freshOutput).
 */
export function sourceFingerprint(fingerprint) {
  return createHash("sha256").update(JSON.stringify(fingerprint)).digest("hex");
}

export const FEEDBACK_LABEL = "FEEDBACK ONLY — NOT FULL ACCEPTANCE";
export const VERIFY_TASK_USAGE =
  "Usage: verify-task.mjs [--base origin/main] [--mode lightweight|contracts|feedback] [--since <ref>] [--reuse-summary <private-summary>] [--resources <private-manifest>] --output /private/unique-run";

function tryGit(git, ...args) {
  try {
    return git(...args).trim();
  } catch {
    return null;
  }
}

export function parseVerifyTaskArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (
      ![
        "--base",
        "--mode",
        "--output",
        "--since",
        "--reuse-summary",
        "--resources",
      ].includes(argv[i]) ||
      !argv[i + 1] ||
      options[argv[i]]
    )
      throw new Error(VERIFY_TASK_USAGE);
    options[argv[i]] = argv[i + 1];
  }
  if (options["--since"] && options["--mode"] !== "feedback")
    throw new Error("--since is only valid with --mode feedback");
  if (
    options["--mode"] &&
    !["lightweight", "contracts", "feedback"].includes(options["--mode"])
  )
    throw new Error("Unknown validation mode");
  return options;
}

export function resolveFeedbackCheckpoint(
  { since, baseRef = "origin/main" } = {},
  git = runGit,
) {
  const notes = [];
  if (since) {
    const sha = tryGit(git, "rev-parse", "--verify", `${since}^{commit}`);
    if (!sha)
      throw new Error(
        `Feedback checkpoint --since ${since} could not be resolved; scope is not treated as checked`,
      );
    const head = tryGit(git, "rev-parse", "HEAD");
    const mergeBase = head ? tryGit(git, "merge-base", sha, head) : null;
    if (!head || mergeBase !== sha)
      throw new Error(
        `Feedback checkpoint ${since} (${sha}) is not an ancestor of HEAD; scope is not treated as checked`,
      );
    return { sha, source: "explicit-since", notes };
  }

  const head = tryGit(git, "rev-parse", "HEAD");
  if (!head)
    throw new Error(
      "HEAD could not be resolved; feedback scope is not treated as checked",
    );
  const upstream = tryGit(git, "rev-parse", "--verify", "@{upstream}^{commit}");
  if (upstream) {
    const mergeBase = tryGit(git, "merge-base", upstream, head);
    if (mergeBase === upstream)
      return { sha: upstream, source: "upstream", notes };
    notes.push(
      `Upstream ${upstream} is not an ancestor of HEAD; not used as the feedback checkpoint`,
    );
  } else {
    notes.push(
      "No upstream branch; cannot use the last pushed commit as the feedback checkpoint",
    );
  }

  const base = tryGit(git, "rev-parse", "--verify", `${baseRef}^{commit}`);
  const mergeBase = base ? tryGit(git, "merge-base", base, head) : null;
  if (!mergeBase)
    throw new Error(
      `No defensible feedback checkpoint: missing --since, no usable upstream, and ${baseRef} could not be resolved; scope is not treated as checked`,
    );
  notes.push(
    `Using merge-base with ${baseRef} as the defensible feedback checkpoint`,
  );
  return { sha: mergeBase, source: "merge-base", notes };
}

const emptyLocalPlan = {
  version: 1,
  event: "local",
  paths: [],
  lightweight: true,
  web: false,
  cms: false,
  contracts: false,
  apple: false,
  harmony: false,
  harmonyNativeValidation: "none",
  scope: "none",
};

export function prepareFeedbackValidation(
  { since, baseRef = "origin/main" } = {},
  git = runGit,
) {
  const checkpoint = resolveFeedbackCheckpoint({ since, baseRef }, git);
  const notes = [...checkpoint.notes];
  let feedbackPaths;
  try {
    feedbackPaths = localPaths(checkpoint.sha, git);
  } catch (error) {
    throw new Error(
      `Feedback scope could not be collected: ${error.message}; scope is not treated as checked`,
    );
  }

  let cumulativePaths;
  try {
    cumulativePaths = localPaths(baseRef, git);
  } catch (error) {
    throw new Error(
      `Cumulative task paths could not be collected: ${error.message}; scope is not treated as checked`,
    );
  }

  let feedbackPlan;
  if (feedbackPaths.length === 0) {
    notes.push(
      "No committed, staged, unstaged or untracked paths since the feedback checkpoint; no product delta was treated as checked",
    );
    feedbackPlan = emptyLocalPlan;
  } else {
    try {
      feedbackPlan = classifyTask(feedbackPaths, "local");
    } catch (error) {
      throw new Error(
        `Feedback scope is missing, ambiguous or unmapped: ${error.message}; scope is not treated as checked`,
      );
    }
  }

  let cumulativePlan = null;
  if (cumulativePaths.length === 0) {
    notes.push(
      "Cumulative path set since base is empty; delivery still requires a complete path set when one exists",
    );
  } else {
    try {
      cumulativePlan = classifyTask(cumulativePaths, "local");
    } catch (error) {
      throw new Error(
        `Cumulative task classification failed: ${error.message}; not treated as checked`,
      );
    }
  }

  return {
    mode: "feedback",
    label: FEEDBACK_LABEL,
    acceptance: false,
    substitutesForTaskGate: false,
    checkpoint,
    feedbackPaths,
    feedbackPlan,
    cumulativePaths,
    cumulativePlan,
    notes,
    scopeNote: FEEDBACK_LABEL,
    evidenceReuseNote:
      "Unchanged applicable evidence remains valid. Changing HEAD or the implementing tool alone does not require a full historical rerun. This feedback run does not replace a required cumulative task gate.",
  };
}

export function formatFeedbackBanner(detail) {
  const checkpoint = detail.checkpoint
    ? `${detail.checkpoint.sha} (${detail.checkpoint.source})`
    : "unresolved";
  return [
    FEEDBACK_LABEL,
    `checkpoint: ${checkpoint}`,
    `acceptance: false`,
    `substitutesForTaskGate: false`,
    ...(detail.notes ?? []).map((note) => `scope-note: ${note}`),
  ].join("\n");
}

export function isFullAcceptance(summary) {
  return (
    summary?.result === "PASS" &&
    summary?.mode === "actual-diff" &&
    summary?.acceptance !== false &&
    summary?.substitutesForTaskGate !== false &&
    summary?.label !== FEEDBACK_LABEL
  );
}

/**
 * Run the selected commands under the plan's declared profile. `budget` is the
 * object from taskValidationBudget() or feedbackValidationBudget(); the runner
 * receives its total minus the startup margin and hands each child the time
 * actually left. The summary reports the effective profile, ceiling and
 * per-command elapsed time; elapsed time is recorded for reporting only and
 * is never deducted from any Issue-lifetime quota.
 */
export async function validate(
  commands,
  output,
  detail = {},
  budget = feedbackValidationBudget(commands),
) {
  const started = detail.validationStartedMs ?? performance.now();
  const originalBudgetMs = budget.totalMs - STARTUP_MARGIN_MS;
  const deadline = started + originalBudgetMs - GRACE_MS;
  process.env.MOYA_VERIFICATION_TOOLCHAIN = `${process.version}/${process.platform}/${process.arch}`;
  const before = workspaceFingerprint();
  const hasStatic = commands.some((command) => staticCheckFiles(command));
  const toolchain = hasStatic
    ? evidenceToolchain(
        process.cwd(),
        Math.max(1, Math.floor(deadline - performance.now())),
      )
    : { node: process.version, platform: process.platform, arch: process.arch };
  const inventory = hasStatic ? sourceInventory(runGit) : [];
  const source = detail.reuseSummary
    ? readReuseSummary(detail.reuseSummary, { root: process.cwd(), deadline })
    : null;
  const checkEvidence = commands.map((command, index) => {
    const identity = checkInputIdentity(command, {
      root: process.cwd(),
      files: inventory,
      toolchain,
      deadline,
    });
    return {
      index,
      ...identity,
      reuse: reuseDecision(
        identity,
        command,
        source?.summary,
        source?.identity,
      ),
    };
  });
  const selectedIndices = checkEvidence
    .filter((entry) => !entry.reuse.reused)
    .map((entry) => entry.index);
  const selected = selectedIndices.map((index) => commands[index]);
  const parallelIndices = selectedIndices.flatMap((originalIndex, index) =>
    checkEvidence[originalIndex].eligible ? [index] : [],
  );
  const preparationMs = Math.round(performance.now() - started);
  const budgetMs = Math.max(0, originalBudgetMs - preparationMs);
  const fd = openSync(join(output, "validation.private.log"), "wx", 0o600);
  let result;
  try {
    result = await runWithinBudget(selected, {
      budgetMs,
      parallelIndices,
      stdio: ["ignore", fd, fd],
    });
  } finally {
    closeSync(fd);
  }
  const after = workspaceFingerprint();
  let staticInputsUnchanged = !hasStatic || result.code === 0;
  const evidenceRecheckStarted = performance.now();
  if (hasStatic && result.code === 0) {
    const afterToolchain = evidenceToolchain(
      process.cwd(),
      Math.max(1, Math.floor(deadline - performance.now())),
    );
    const afterInventory = sourceInventory(runGit);
    staticInputsUnchanged = checkEvidence.every((entry, index) => {
      if (!entry.eligible) return true;
      const afterIdentity = checkInputIdentity(commands[index], {
        root: process.cwd(),
        files: afterInventory,
        toolchain: afterToolchain,
        deadline,
      });
      return (
        afterIdentity.eligible &&
        afterIdentity.inputSha256 === entry.inputSha256
      );
    });
  }
  const evidenceRecheckMs = Math.round(
    performance.now() - evidenceRecheckStarted,
  );
  const contentUnchanged =
    JSON.stringify(before) === JSON.stringify(after) && staticInputsUnchanged;
  if (!contentUnchanged && result.code === 0) result.code = 1;
  const checkNames = budget.checks.flatMap((check) =>
    Array.from({ length: check.commands }, () => check.name),
  );
  const executed = result.executed.map((record, position) => {
    const index = selectedIndices[record.index ?? position];
    return { ...record, index, check: checkNames[index] ?? null };
  });
  const elapsedMs = Math.round(performance.now() - started);
  const testedBase =
    detail.checkpoint?.sha ??
    tryGit(runGit, "merge-base", detail.baseRef ?? "origin/main", before.head);
  const summary = {
    ...detail,
    evidenceVersion: EVIDENCE_VERSION,
    testedBase,
    toolchain,
    checkEvidence,
    reusedChecks: checkEvidence
      .filter((entry) => entry.reuse.reused)
      .map(({ index, reuse }) => ({ index, ...reuse })),
    preparationMs,
    evidenceRecheckMs,
    concurrencyLimit: 2,
    code: result.code,
    durationMs: elapsedMs,
    profile: budget.profile,
    totalMs: budget.totalMs,
    ceilingMs: originalBudgetMs,
    executionCeilingMs: budgetMs,
    combinedCeilingMs: budget.combinedCeilingMs,
    serialCombination: budget.serialCombination,
    checks: budget.checks,
    ...(budget.note ? { planNote: budget.note } : {}),
    executed,
    accounting: {
      elapsedMs,
      note: "Recorded for reporting only; a new substantive validation plan gets its declared profile, never an Issue-lifetime balance.",
    },
    result:
      result.code === 0
        ? "PASS"
        : result.code === 124
          ? "TIME_BUDGET_EXCEEDED"
          : "FAIL",
    commands,
    head: runGit("rev-parse", "HEAD").trim(),
    checkoutTree: runGit("rev-parse", "HEAD^{tree}").trim(),
    sourceFingerprint: sourceFingerprint(before),
    contentBefore: before,
    contentAfter: after,
    contentUnchanged,
    staticInputsUnchanged,
    note: "Evidence belongs to the recorded HEAD and dirty-content fingerprints. Source drift fails acceptance. Raw logs are private, not publication attachments.",
  };
  writeFileSync(
    join(output, "summary.json"),
    JSON.stringify(summary, null, 2) + "\n",
    { mode: 0o600 },
  );
  const printed = {
    result: summary.result,
    durationMs: elapsedMs,
    preparationMs,
    reusedChecks: summary.reusedChecks,
    profile: budget.profile,
    totalMs: budget.totalMs,
    ceilingMs: originalBudgetMs,
    sourceFingerprint: summary.sourceFingerprint,
    checks: executed.map(
      ({ check, command, durationMs, remainingMs, code }) => ({
        check,
        command: command.join(" "),
        remainingMs,
        durationMs,
        code,
      }),
    ),
    output,
  };
  if (summary.mode === "feedback") {
    printed.label = FEEDBACK_LABEL;
    printed.acceptance = false;
    printed.substitutesForTaskGate = false;
    if (summary.commandSelection) {
      printed.selectedCommands = summary.commandSelection.commands;
      printed.uncheckedCoverage = summary.commandSelection.uncheckedCoverage;
    }
  }
  console.log(JSON.stringify(printed));
  return result.code;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const options = parseVerifyTaskArgs(process.argv.slice(2));
    const root = runGit("rev-parse", "--show-toplevel").trim();
    process.chdir(root);
    // Resolve the private output path first so planned commands can name it;
    // the directory is created only once the plan is resolved.
    const outputPath = resolveFreshOutput(options["--output"], root);
    let plan;
    let detail;
    let feedbackSelection;
    if (options["--mode"] === "lightweight") {
      plan = { lightweight: true };
      detail = {
        mode: "lightweight",
        plan,
        scopeNote: "Explicit subset; not full task acceptance",
      };
    } else if (options["--mode"] === "contracts") {
      plan = { lightweight: true, contracts: true };
      detail = {
        mode: "contracts",
        plan,
        scopeNote: "Explicit subset; not full task acceptance",
      };
    } else if (options["--mode"] === "feedback") {
      detail = prepareFeedbackValidation({
        since: options["--since"],
        baseRef: options["--base"] ?? "origin/main",
      });
      plan = detail.feedbackPlan;
      feedbackSelection = planFeedbackCommands(detail, outputPath);
      console.log(formatFeedbackBanner(detail));
      console.log(formatFeedbackCommandSelection(feedbackSelection));
      if (feedbackSelection.unresolved)
        throw new Error(feedbackSelection.unresolved);
      detail = { ...detail, commandSelection: feedbackSelection };
    } else if (options["--mode"]) throw new Error("Unknown validation mode");
    else {
      plan = classifyTask(localPaths(options["--base"]), "local");
      detail = {
        mode: "actual-diff",
        plan,
        scopeNote: "Committed, staged, unstaged and untracked union",
      };
    }
    detail = {
      ...detail,
      baseRef: options["--base"] ?? "origin/main",
      ...(options["--reuse-summary"]
        ? { reuseSummary: options["--reuse-summary"] }
        : {}),
    };
    const output = freshOutput(outputPath, root);
    // A resumed task must not reuse another session's smoke paths or identity.
    Object.assign(
      process.env,
      validationEnvironment(output, runGit("rev-parse", "HEAD").trim()),
    );
    let commands;
    let budget;
    if (options["--mode"] === "feedback") {
      commands = feedbackSelection.commands;
      budget = feedbackValidationBudget(commands);
    } else {
      const checks = taskChecks(plan, output);
      commands = checks.flatMap((check) => check.commands);
      budget = taskValidationBudget(checks);
    }
    if (options["--resources"]) {
      const started = performance.now();
      const { loadResourceEnvironment, boundedDockerRunner } =
        await import("./task-resources.mjs");
      Object.assign(
        process.env,
        loadResourceEnvironment(options["--resources"], {
          root,
          run: boundedDockerRunner(
            budget.totalMs -
              STARTUP_MARGIN_MS -
              GRACE_MS -
              (performance.now() - started),
          ),
        }),
      );
      detail.resourceManifest = options["--resources"];
      detail.validationStartedMs = started;
    }
    console.log(
      JSON.stringify({
        plan: budget.profile,
        totalMs: budget.totalMs,
        checks: budget.checks,
        ...(budget.note ? { note: budget.note } : {}),
      }),
    );
    process.exitCode = await validate(commands, output, detail, budget);
  } catch (error) {
    console.error(`Task validation unavailable: ${error.message}`);
    process.exitCode = 1;
  }
}
