import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

// Email-auth acceptance templates. Exact files only: other HTML or text under
// docs/ stays unmapped. They are documentation of the message, not runtime.
const emailAuthTemplates = new Set([
  "docs/development/email-auth/verification.html",
  "docs/development/email-auth/verification.txt",
]);
const docs = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
  "README.md",
  "SECURITY.md",
  "LICENSE",
  "LICENSE-DATA",
  "NOTICE",
  ".github/pull_request_template.md",
]);
const tooling = new Set([
  ".gitignore",
  ".github/CODEOWNERS",
  "scripts/ci-e2e-gate.mjs",
  "scripts/ci-task-scope.mjs",
  "scripts/ci-task-gate.mjs",
  "scripts/verify-task.mjs",
  "scripts/verify-apple.mjs",
  "scripts/task-git.mjs",
  "scripts/task-context.mjs",
  "scripts/task-resources.mjs",
  "scripts/verification-evidence.mjs",
  "scripts/verification-tool-inputs.mjs",
  "scripts/task-validation.test.mjs",
  // Dependency-free maintenance for the shared local Turbo cache; its own
  // script test runs in the lightweight job.
  "scripts/turbo-cache-prune.mjs",
  "scripts/cursor-review.mjs",
]);
const webRoots = [
  "apps/web/",
  "apps/admin/",
  "packages/design-tokens/",
  "packages/image/",
  "packages/search/",
  "packages/ui/",
  "services/agent-authorization/",
  "services/api/",
  "services/backend-production/",
  "services/backend-runtime/",
  "services/catalog-importer/",
  "services/catalog-postgres/",
  "services/community-postgres/",
  "database/",
  "infra/",
  // Includes tests/unit/architecture/workspace-scanner.ts: a lightweight
  // routing test imports it, but the Web jobs lint and type-check it and run
  // the architecture tests that import it.
  "tests/",
  "experiments/",
  "docs/prototypes/",
  "docs/design-system/",
];
const webConfig = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".nvmrc",
  ".env.example",
  "tsconfig.base.json",
  "turbo.json",
  "compose.dev.yml",
  "compose.postgres.yml",
]);
// The Web lint job's verify.mjs lint stage runs prettier --check ., which loads
// the Prettier config and ignore file and applies .editorconfig, and turbo run
// lint, whose workspace eslint . runs use the root flat config. A lightweight
// routing test reads only the two ignore lists.
const webLintConfig = new Set([
  ".editorconfig",
  ".prettierignore",
  "eslint.config.mjs",
  "prettier.config.mjs",
]);
// The cms job imports the marker module and the name guard through
// scripts/editorial/verify-cms.mjs and runs the SQL in its marker step.
const cmsTestTarget = new Set([
  "scripts/disposable-test-target.mjs",
  "infra/test/disposable-test-target.sql",
  "tests/integration/postgres/synthetic-test-database.ts",
  // The frozen validation-profile constants the cms job's verify-cms.mjs and
  // verify-owner-browser.mjs entries import for their CMS COMPLETE ceilings.
  "scripts/validation-profiles.mjs",
]);
// verify-cms.mjs compiles these packages with tsc -p; Payload migrations,
// tests/cms and its PostgreSQL probe import their dist output.
//
// `community-postgres` joined the list in r15, and not by preference: the
// Admin's agent-connection control plane and resource boundary import it, so
// the cms job now builds and runs it through `pnpm --filter admin build`. The
// script test derives this closure from the job itself rather than from this
// comment, which is what caught the omission. Admin branding now consumes the
// existing UI asset export, so UI and its design-token dependency join that
// closure and must retain CMS coverage when their shared resources change.
const cmsBuiltPackage =
  /^(?:packages\/(?:contracts|design-tokens|image|search|ui)|services\/(?:api|catalog-postgres|community-postgres))\/(?:src\/|(?:package|tsconfig)\.json$)/u;
const publicBoundary = (file) =>
  (file.startsWith("packages/contracts/") &&
    !file.startsWith("packages/contracts/src/internal/")) ||
  file.startsWith("services/public-api/") ||
  /^services\/backend-runtime\/src\/community\/(?:session|auth|community-handler)/u.test(
    file,
  );

export function assertPath(file) {
  if (
    typeof file !== "string" ||
    !file ||
    /[\\\x00-\x1f\x7f]/u.test(file) ||
    file.startsWith("/") ||
    file.split("/").some((part) => ["", ".", ".."].includes(part))
  )
    throw new Error(`Invalid changed path: ${JSON.stringify(file)}`);
}

/** A missing/ambiguous dependency graph selects the existing broad plan. */
export function isSecurityPath(file) {
  return /(?:^|[\/.-])(?:auth(?:entication|orization)?|sessions?|credentials?|security|permissions?|grants?|passwords?|tokens?|csrf|oauth|jwt|scram|acl)(?:[\/.-]|$)/iu.test(
    file.replace(/^packages\/design-tokens\//u, "packages/design-system/"),
  );
}

function broadWebImpact(file) {
  return (
    isSecurityPath(file) ||
    webConfig.has(file) ||
    webLintConfig.has(file) ||
    /(?:^|\/)(?:package\.json|tsconfig[^/]*\.json|[^/]*(?:migration|config)[^/]*)$/iu.test(
      file,
    ) ||
    /^(?:database|infra|tests|experiments|docs\/prototypes|docs\/design-system)\//u.test(
      file,
    )
  );
}

export function affectedWebWorkspaces(
  paths,
  root = fileURLToPath(new URL("../", import.meta.url)),
) {
  const manifests = [];
  try {
    for (const parent of ["apps", "packages", "services"])
      for (const name of readdirSync(join(root, parent))) {
        const directory = `${parent}/${name}`;
        if (existsSync(join(root, directory, "package.json")))
          manifests.push([
            directory,
            JSON.parse(
              readFileSync(join(root, directory, "package.json"), "utf8"),
            ),
          ]);
      }
    manifests.push([
      "tests",
      JSON.parse(readFileSync(join(root, "tests/package.json"), "utf8")),
    ]);
  } catch {
    return [];
  }
  const graph = new Map();
  for (const [directory, manifest] of manifests) {
    if (
      typeof manifest.name !== "string" ||
      !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(
        manifest.name,
      ) ||
      graph.has(manifest.name)
    )
      return [];
    const dependencies = Object.entries({
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
    })
      .filter(
        ([, value]) =>
          typeof value === "string" && value.startsWith("workspace:"),
      )
      .map(([name]) => name);
    graph.set(manifest.name, { directory, dependencies });
  }
  if (!graph.has("web") || !graph.has("@moya/tests")) return [];
  for (const { dependencies } of graph.values())
    if (dependencies.some((name) => !graph.has(name))) return [];
  const selected = new Set(["@moya/tests"]);
  for (const file of paths) {
    // Global configuration, security/authentication and persisted state retain
    // the broad path. This optimization cannot waive their semantic consumers.
    if (broadWebImpact(file)) return [];
    const entry = [...graph.entries()].find(([, item]) =>
      file.startsWith(`${item.directory}/`),
    );
    if (entry) {
      selected.add(entry[0]);
      // HTTP is a semantic dependency outside package.json: backend and shared
      // public shapes keep the Web consumer even without a direct import.
      if (
        file.startsWith("services/") ||
        /^packages\/(?:contracts|image|search)\//u.test(file)
      )
        selected.add("web");
    } else if (
      !docs.has(file) &&
      !tooling.has(file) &&
      !emailAuthTemplates.has(file) &&
      !file.endsWith(".md") &&
      !/^\.(?:agents|claude|github|githooks)\//u.test(file) &&
      !/^scripts\/[a-z-]+\.test\.mjs$/u.test(file)
    )
      return [];
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, { dependencies }] of graph)
      if (
        !selected.has(name) &&
        dependencies.some((dependency) => selected.has(dependency))
      ) {
        selected.add(name);
        changed = true;
      }
  }
  return [...selected].sort();
}

// Metadata (author, model, labels, branch prefix) is deliberately not an input.
export function classifyTask(paths, event = "pull_request") {
  if (!["pull_request", "push", "local", "workflow_dispatch"].includes(event))
    throw new Error("Unsupported comparison event");
  if (
    !Array.isArray(paths) ||
    (paths.length === 0 && event !== "workflow_dispatch")
  )
    throw new Error("No complete changed-path set");
  paths.forEach(assertPath);
  const plan = {
    version: 1,
    event,
    paths: [...new Set(paths)].sort(),
    lightweight: true,
    web: false,
    cms: false,
    contracts: false,
    apple: false,
    harmony: false,
    harmonyNativeValidation: "none",
    scope: "none",
  };
  const unknown = [];
  for (const file of plan.paths) {
    // Runtime prototype/design assets retain Web checks, including their docs.
    if (
      file.startsWith("docs/prototypes/") ||
      file.startsWith("docs/design-system/")
    ) {
      plan.web = true;
    } else if (
      docs.has(file) ||
      emailAuthTemplates.has(file) ||
      tooling.has(file) ||
      // A workflow path cannot name the job an edit affects; script tests
      // assert the test and cms jobs' disposable-target marker steps.
      file.startsWith(".github/workflows/") ||
      file.startsWith(".agents/") ||
      file.startsWith(".githooks/") ||
      /(?:^|\/)(?:AGENTS|CLAUDE)\.md$/u.test(file) ||
      // Agent skills, project-scoped Claude configuration, the project MCP
      // definition, Issue forms and dependency-free script tests are
      // instruction/tooling changes with lightweight checks only.
      file.startsWith(".claude/") ||
      file === ".mcp.json" ||
      file.startsWith(".github/ISSUE_TEMPLATE/") ||
      file === "scripts/README.md" ||
      // Local curation owns separate pinned native runtimes and Draft-only
      // acceptance; it does not change CMS/public runtime implementation.
      file.startsWith("scripts/curation/") ||
      /^scripts\/[a-z-]+\.test\.mjs$/u.test(file) ||
      (/\.md$/u.test(file) &&
        /^(?:docs|apps\/apple|apps\/harmony|apps\/web|apps\/admin|packages|services)\//u.test(
          file,
        ))
    ) {
      // Documentation, instruction imports and workflow tooling have real lightweight checks.
    } else if (file.startsWith("apps/apple/")) {
      plan.apple = true;
    } else if (file.startsWith("apps/harmony/")) {
      plan.harmony = true;
      plan.harmonyNativeValidation =
        "HARMONY_NATIVE_VALIDATION_NOT_YET_CONFIGURED";
    } else if (publicBoundary(file)) {
      plan.contracts = true;
      // Sensitive public-boundary paths must reach broad Web validation too;
      // the focused contract path cannot cover all auth or shared config checks.
      if (broadWebImpact(file)) plan.web = true;
      if (cmsBuiltPackage.test(file)) plan.cms = true;
    } else if (
      webConfig.has(file) ||
      webLintConfig.has(file) ||
      webRoots.some((prefix) => file.startsWith(prefix)) ||
      file.startsWith("packages/contracts/src/internal/") ||
      file.startsWith("scripts/editorial/") ||
      // verify.mjs stage plans are the Web lint, typecheck, test, build and
      // smoke job commands, including the test job's marker check. The smoke
      // stage spawns ci-e2e-smoke.mjs; only the test job's Vitest policy test
      // loads ci-e2e-scope.mjs. validation-profiles.mjs supplies the stage and
      // smoke ceilings those commands import.
      /^scripts\/(?:migrate(?:-community)?|generate-catalog-import-template|confidentiality-scan|install-confidentiality-hooks|disposable-test-target|test-target|verify|validation-profiles|ci-e2e-(?:scope|smoke)|materialize-phase4-fixtures|seed-phase4-acceptance|seed-phase4-support|email-auth-acceptance|provision-password-account)\.mjs$/u.test(
        file,
      )
    ) {
      plan.web = true;
      if (
        file.startsWith("apps/admin/") ||
        // The authorization runtime carries no checks of its own. The Web jobs
        // lint, type-check and build it through the root turbo tasks, and its
        // Admin consent and MCP integration is exercised by the cms job's
        // Payload and Owner-browser stages, so a change isolated to this
        // service keeps the integration coverage it needs.
        file.startsWith("services/agent-authorization/") ||
        file.startsWith("tests/cms/") ||
        file.startsWith("scripts/editorial/") ||
        cmsTestTarget.has(file) ||
        cmsBuiltPackage.test(file) ||
        webConfig.has(file)
      )
        plan.cms = true;
    } else unknown.push(file);
  }
  if (unknown.length)
    throw new Error(
      `Unmapped changed paths; extend the scoped routing with tests: ${JSON.stringify(unknown)}`,
    );
  if (event === "workflow_dispatch") {
    // Existing explicitly requested Web release regression; never starts Apple implicitly.
    plan.web = true;
    plan.cms = true;
    plan.contracts = true;
    plan.scope = "full";
  } else if (plan.web) plan.scope = "smoke";
  if (plan.web)
    plan.webWorkspaces =
      event === "workflow_dispatch" ? [] : affectedWebWorkspaces(plan.paths);
  return plan;
}

export const runGit = (...args) =>
  execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 10_000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  });

export function nulPaths(value, allowEmpty = false) {
  if (value === "" && allowEmpty) return [];
  if (typeof value !== "string" || !value.endsWith("\0"))
    throw new Error("Missing complete NUL-delimited diff");
  const paths = value.slice(0, -1).split("\0");
  paths.forEach(assertPath);
  return paths;
}

export function changedPaths(event, base, head, git = runGit) {
  if (
    !["pull_request", "push", "local"].includes(event) ||
    ![base, head].every(
      (sha) =>
        typeof sha === "string" &&
        /^[a-f0-9]{40}$/u.test(sha) &&
        !/^0+$/u.test(sha),
    )
  )
    throw new Error("Invalid event or comparison SHA");
  // --no-renames includes BOTH original and destination paths, including deletes.
  // Git has no API pagination. NUL keeps spaces and non-ASCII path names intact.
  return nulPaths(
    git(
      "diff",
      "--no-renames",
      "--name-only",
      "-z",
      `${base}${event === "push" ? ".." : "..."}${head}`,
      "--",
    ),
    event === "local",
  );
}

export function localPaths(baseRef = "origin/main", git = runGit) {
  const base = git("rev-parse", "--verify", `${baseRef}^{commit}`).trim();
  const head = git("rev-parse", "HEAD").trim();
  return [
    ...new Set([
      ...changedPaths("local", base, head, git),
      ...nulPaths(
        git(
          "diff",
          "--no-renames",
          "--name-only",
          "-z",
          "--cached",
          "HEAD",
          "--",
        ),
        true,
      ),
      ...nulPaths(git("diff", "--no-renames", "--name-only", "-z", "--"), true),
      ...nulPaths(
        git("ls-files", "--others", "--exclude-standard", "-z"),
        true,
      ),
    ]),
  ];
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const event = process.env.EVENT_NAME;
    const plan = classifyTask(
      event === "workflow_dispatch"
        ? []
        : changedPaths(event, process.env.BASE_SHA, process.env.HEAD_SHA),
      event,
    );
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        ["scope", "web", "cms", "contracts", "apple", "harmony", "lightweight"]
          .map((key) => `${key}=${plan[key]}\n`)
          .join("") +
          `web_workspaces=${(plan.webWorkspaces ?? []).join(",")}\n` +
          `plan=${JSON.stringify(plan)}\n`,
      );
    }
    console.log(JSON.stringify(plan));
  } catch (error) {
    console.error(`Task classification failed: ${error.message}`);
    process.exitCode = 1;
  }
}
