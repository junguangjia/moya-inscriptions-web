import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const verificationModule = (await import(
  pathToFileURL(root + "scripts/verify.mjs").href
)) as {
  verificationCommands: (
    plan: { mode: string; selection: string },
    env?: Record<string, string>,
  ) => string[][];
};

const scopeModule = (await import(
  pathToFileURL(root + "scripts/ci-e2e-scope.mjs").href
)) as {
  classifyE2eScope: (paths: unknown, event?: string) => string;
  classifyGitDiff: (
    event: string,
    base: string,
    head: string,
    git: (...args: string[]) => unknown,
  ) => string;
};
const gateModule = (await import(
  pathToFileURL(root + "scripts/ci-e2e-gate.mjs").href
)) as {
  assertBrowserGate: (
    scope: string,
    classified: string,
    smoke: string,
    full: string,
  ) => string;
  assertSmokeReport: (
    planned: unknown,
    report: unknown,
    identity: unknown,
  ) => unknown;
};
const { classifyE2eScope: classify, classifyGitDiff } = scopeModule;
const { assertBrowserGate: gate, assertSmokeReport } = gateModule;

const requireTurbo = createRequire(
  createRequire(root + "package.json").resolve("turbo/package.json"),
);
const turboPlatform =
  process.platform === "win32" ? "windows" : process.platform;
const turboArch = process.arch === "x64" ? "64" : process.arch;
const turboExtension = process.platform === "win32" ? ".exe" : "";
const nativeTurbo = (() => {
  for (const prefix of ["@turbo/", "turbo-"]) {
    try {
      return requireTurbo.resolve(
        `${prefix}${turboPlatform}-${turboArch}/bin/turbo${turboExtension}`,
      );
    } catch {
      // Resolve only installed native packages; never invoke auto-install.
    }
  }
  throw new Error("TURBO_NATIVE_BINARY_UNAVAILABLE");
})();

const taskGraph = (task: string, filters: string[]) => {
  const result = spawnSync(
    nativeTurbo,
    [
      "run",
      task,
      ...filters.map((filter) => "--filter=" + filter),
      "--dry=json",
      "--no-daemon",
    ],
    {
      cwd: root,
      env: { ...process.env, TURBO_TELEMETRY_DISABLED: "1" },
      encoding: "utf8",
      timeout: 10_000,
      killSignal: "SIGKILL",
      maxBuffer: 5 * 1024 * 1024,
    },
  );
  // Raw task output can include environment metadata and local paths.
  if (result.error || result.status !== 0)
    throw new Error("TURBO_DRY_RUN_FAILED");
  try {
    const plan = JSON.parse(result.stdout) as {
      tasks: { taskId: string; dependencies: string[]; hash: string }[];
    };
    return new Map(plan.tasks.map((entry) => [entry.taskId, entry]));
  } catch {
    throw new Error("TURBO_DRY_RUN_UNREADABLE");
  }
};

describe("PostgreSQL preparation shares ordinary test build hashes", () => {
  it("retains all eleven dependency builds inside the existing verification plan", async () => {
    const filters = [
      "@moya/backend-production...",
      "@moya/catalog-importer...",
    ];
    const graph = taskGraph("test", ["@moya/tests"]);
    const preparation = taskGraph("build", filters);
    expect([...preparation.keys()].sort()).toEqual(
      [
        "@moya/agent-authorization#build",
        "@moya/api#build",
        "@moya/backend-production#build",
        "@moya/backend-runtime#build",
        "@moya/catalog-importer#build",
        "@moya/catalog-postgres#build",
        "@moya/community-postgres#build",
        "@moya/contracts#build",
        "@moya/image#build",
        "@moya/public-api#build",
        "@moya/search#build",
      ].sort(),
    );
    for (const [id, task] of preparation) {
      expect(task.hash).toMatch(/^[a-f0-9]{16}$/);
      expect(task.hash).toBe(graph.get(id)?.hash);
    }
    const verify = await readFile(root + "scripts/verify.mjs", "utf8");
    const postgresPlan = verify
      .split("const postgres = [")[1]
      ?.split("];", 1)[0];
    expect(postgresPlan).toMatch(
      /pnpm\(\s*"exec",\s*"turbo",\s*"run",\s*"build",/,
    );
    for (const filter of filters)
      expect(postgresPlan).toContain(JSON.stringify("--filter=" + filter));
    expect(postgresPlan).toMatch(
      /pnpm\("db:migrate"\),\s*pnpm\("test:postgres"\)/,
    );
    const commands = verificationModule.verificationCommands(
      { mode: "test", selection: "complete" },
      { TEST_DATABASE_URL: "synthetic-selected" },
    );
    expect(commands.slice(-2)).toEqual([
      ["pnpm", "test:postgres"],
      ["pnpm", "test"],
    ]);
    expect(commands[0]).toContain(".turbo/library-cache");
    expect(
      verificationModule.verificationCommands({
        mode: "test",
        selection: "complete",
      }),
    ).toEqual([["pnpm", "test"]]);
    expect(verify).toContain("runWithinBudget(plans[mode])");
  });
});

describe("ordinary tests and production task boundaries", () => {
  it("retains every workspace library build without building the Admin app for source imports", async () => {
    const manifest = JSON.parse(
      await readFile(root + "tests/package.json", "utf8"),
    ) as { devDependencies: Record<string, string> };
    expect(manifest.devDependencies.admin).toBe("workspace:*");
    const requireTests = createRequire(root + "tests/package.json");
    expect(
      requireTests
        .resolve("admin/fields")
        .endsWith("/apps/admin/src/fields/editorial-fields.ts"),
    ).toBe(true);
    expect(
      requireTests
        .resolve("admin/migration")
        .endsWith("/apps/admin/src/migration/legacy.ts"),
    ).toBe(true);

    const libraryBuilds = Object.entries(manifest.devDependencies)
      .filter(
        ([name, version]) =>
          name !== "admin" && version.startsWith("workspace:"),
      )
      .map(([name]) => name + "#build")
      .sort();
    const graph = taskGraph("test", ["@moya/tests"]);
    expect(
      [...(graph.get("@moya/tests#test")?.dependencies ?? [])].sort(),
    ).toEqual(libraryBuilds);
    expect([...graph.keys()].sort()).toEqual(
      [...libraryBuilds, "@moya/tests#test"].sort(),
    );
    expect(graph.has("admin#build")).toBe(false);
    expect(graph.has("web#build")).toBe(false);

    const filters = [
      "@moya/backend-production...",
      "@moya/catalog-importer...",
    ];
    const preparation = taskGraph("build", filters);
    for (const [id, task] of preparation) {
      expect(task.hash).toMatch(/^[a-f0-9]{16}$/);
      expect(task.hash).toBe(graph.get(id)?.hash);
    }
    const verify = await readFile(root + "scripts/verify.mjs", "utf8");
    const postgresPlan = verify
      .split("const postgres = [")[1]
      ?.split("];", 1)[0];
    expect(postgresPlan).toMatch(
      /pnpm\(\s*"exec",\s*"turbo",\s*"run",\s*"build",/,
    );
    for (const filter of filters)
      expect(postgresPlan).toContain(JSON.stringify("--filter=" + filter));
    const commands = verificationModule.verificationCommands(
      { mode: "test", selection: "complete" },
      { TEST_DATABASE_URL: "synthetic-selected" },
    );
    expect(commands.slice(-2)).toEqual([
      ["pnpm", "test:postgres"],
      ["pnpm", "test"],
    ]);
    expect(commands[0]).toContain(".turbo/library-cache");
    expect(
      verificationModule.verificationCommands({
        mode: "test",
        selection: "complete",
      }),
    ).toEqual([["pnpm", "test"]]);
    expect(verify).toContain("runWithinBudget(plans[mode])");
  });

  it("retains production app builds and native CMS browser validation", async () => {
    const graph = taskGraph("build", ["admin", "web"]);
    expect(graph.has("admin#build")).toBe(true);
    expect(graph.has("web#build")).toBe(true);
    expect(graph.get("admin#build")?.dependencies).toContain(
      "@moya/contracts#build",
    );
    const [workflow, rootManifest] = await Promise.all([
      readFile(root + ".github/workflows/ci.yml", "utf8"),
      readFile(root + "package.json", "utf8"),
    ]);
    expect(JSON.parse(rootManifest).scripts).toMatchObject({
      build: "turbo run build",
      "test:cms": "node scripts/editorial/verify-cms.mjs",
      "test:cms:browser": "node scripts/editorial/verify-owner-browser.mjs",
    });
    const cmsJob = workflow.split("\n  cms:\n")[1]?.split("\n  build:\n")[0];
    expect(cmsJob).toContain("run: pnpm test:cms");
    expect(cmsJob).toMatch(
      /pnpm --filter admin build[\s\S]*?run: pnpm test:cms:browser/,
    );
    expect(workflow).toContain("run: node scripts/verify.mjs build");
  });
});

describe("bounded daily browser selection", () => {
  it.each([
    [
      ["README.md", "docs/governance/OWNER-DEVELOPMENT-CONSTITUTION.md"],
      "none",
    ],
    [["services/catalog-importer/src/cli.ts"], "smoke"],
    [["tests/unit/backend/parser.test.ts"], "smoke"],
    [["apps/web/app/page.tsx"], "smoke"],
    [["packages/contracts/src/catalog.ts"], "smoke"],
    [["docs/prototypes/mobile-preview/README.md"], "smoke"],
    [["docs/design-system/assets/card.svg"], "smoke"],
    [["pnpm-lock.yaml"], "smoke"],
    [[".github/workflows/ci.yml"], "smoke"],
    [["README.md", "services/catalog-importer/src/cli.ts"], "smoke"],
    [["unknown.ts"], "smoke"],
  ])("%j => %s for both PR and main", (paths, expected) => {
    for (const event of ["pull_request", "push"])
      expect(classify(paths, event)).toBe(expected);
  });

  it("reserves full regression for an explicit dispatch", () => {
    expect(classify([], "workflow_dispatch")).toBe("full");
    expect(
      classifyGitDiff("workflow_dispatch", "", "", () => {
        throw new Error("manual regression does not need a diff");
      }),
    ).toBe("full");
  });

  it("fails closed on bad comparisons without starting an unbounded regression", () => {
    const a = "a".repeat(40),
      b = "b".repeat(40);
    const calls: string[][] = [];
    const git = (...args: string[]) => {
      calls.push(args);
      return "README.md\0";
    };
    expect(classifyGitDiff("pull_request", a, b, git)).toBe("none");
    expect(calls[0]).toEqual([
      "diff",
      "--no-renames",
      "--name-only",
      "-z",
      a + "..." + b,
      "--",
    ]);
    expect(classifyGitDiff("push", a, b, git)).toBe("none");
    expect(calls[1]).toContain(a + ".." + b);
    expect(
      classifyGitDiff("push", a, b, () => "README.md\0apps/web/page.tsx\0"),
    ).toBe("smoke");
    for (const output of ["", "README.md", "README.md\0\0", null])
      expect(() => classifyGitDiff("push", a, b, () => output)).toThrow();
    expect(() =>
      classifyGitDiff("push", a, b, () => {
        throw new Error("git failed");
      }),
    ).toThrow();
    expect(() => classifyGitDiff("push", "0".repeat(40), b, git)).toThrow();
    expect(() => classifyGitDiff("push", "--bad", b, git)).toThrow();
    for (const paths of [
      [],
      [""],
      ["../README.md"],
      [" README.md"],
      ["docs/governance/a.md\napps/web/b.ts"],
      null,
    ])
      expect(() => classify(paths)).toThrow();
    expect(() => classify([], "unknown")).toThrow();
  });
});

const identity = {
  sourceHead: "a",
  checkoutSha: "b",
  tree: "c",
  runId: "1",
  runAttempt: "1",
};
const nativeReport = (list = false) => ({
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
              status: list ? "skipped" : "expected",
              results: list ? [] : [{ retry: 0, status: "passed", errors: [] }],
            },
          ],
        },
      ],
    },
  ],
  errors: [],
  stats: {
    expected: list ? 0 : 1,
    skipped: list ? 1 : 0,
    unexpected: 0,
    flaky: 0,
  },
});

describe("stable e2e result gate", () => {
  it("distinguishes no-browser from successfully executed browser tests", () => {
    expect(gate("none", "success", "skipped", "skipped")).toContain("NOT RUN");
    expect(gate("smoke", "success", "success", "skipped")).toContain("smoke");
    expect(gate("full", "success", "skipped", "success")).toContain("full");
  });
  it.each(["failure", "cancelled", "skipped", ""])(
    "blocks missing/failed selected execution: %s",
    (result) => {
      expect(() => gate("smoke", "success", result, "skipped")).toThrow();
      expect(() => gate("full", "success", "skipped", result)).toThrow();
      expect(() => gate("none", result, "skipped", "skipped")).toThrow();
    },
  );
  it("rejects malformed scopes and unexpected jobs", () => {
    expect(() => gate("", "success", "skipped", "skipped")).toThrow();
    expect(() => gate("none", "success", "failure", "skipped")).toThrow();
  });
  it("requires actual matching native smoke results", () => {
    expect(
      assertSmokeReport(nativeReport(true), nativeReport(), identity),
    ).toEqual({
      passed: 1,
      skipped: 0,
      total: 1,
      retries: 0,
    });
    const badReports = [
      { ...nativeReport(), suites: [] },
      { ...nativeReport(), errors: ["global failure"] },
      { ...nativeReport(), stats: { ...nativeReport().stats, flaky: 1 } },
      { ...nativeReport(), stats: { ...nativeReport().stats, expected: 2 } },
      nativeReport(true),
    ];
    for (const report of badReports)
      expect(() =>
        assertSmokeReport(nativeReport(true), report, identity),
      ).toThrow();
    for (const outcome of ["failed", "timedOut", "interrupted", "skipped"]) {
      const report = nativeReport();
      report.suites[0]!.specs[0]!.tests[0]!.results[0]!.status = outcome;
      expect(() =>
        assertSmokeReport(nativeReport(true), report, identity),
      ).toThrow();
    }
    const report = nativeReport();
    report.suites[0]!.specs[0]!.tests[0]!.projectName = "desktop-webkit";
    expect(() =>
      assertSmokeReport(nativeReport(true), report, identity),
    ).toThrow();
    expect(() =>
      assertSmokeReport(nativeReport(true), nativeReport(), {
        ...identity,
        tree: "wrong",
      }),
    ).toThrow();
    expect(() =>
      assertSmokeReport(nativeReport(true), undefined, identity),
    ).toThrow();
  });
  it("keeps explicit full regression and bounds the daily checks", async () => {
    const workflow = await readFile(root + ".github/workflows/ci.yml", "utf8");
    expect(workflow).toContain(
      "github.event.pull_request.number || github.run_id",
    );
    expect(workflow).toContain(
      "cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
    );
    expect(workflow).toContain("needs: [classify_e2e, e2e_smoke, e2e-shards]");
    expect(workflow).toContain("shard: [1, 2, 3]");
    for (const [job, next] of [
      ["e2e-shards", "e2e_smoke"],
      ["browser_gate", "e2e"],
    ]) {
      const block = workflow
        .split(`\n  ${job}:\n`)[1]
        ?.split(`\n  ${next}:\n`)[0];
      expect(block).toBeDefined();
      expect(block).not.toContain("timeout-minutes:");
    }
    expect(workflow.split("\n  e2e:\n")[1]).not.toContain("timeout-minutes:");
    for (const mode of ["prepare", "run", "merge"])
      expect(workflow).toContain("node tests/e2e/support/e2e-ci.mjs " + mode);
    expect(workflow).toContain("workflow_dispatch:");
    for (const mode of ["lint", "typecheck", "test", "build", "e2e"])
      expect(workflow).toContain("node scripts/verify.mjs " + mode);
    expect(workflow).not.toContain("|| scope=full");
    expect(workflow).toContain("node scripts/ci-e2e-gate.mjs gate");
    expect(workflow).toContain("if-no-files-found: error");
    expect(workflow).not.toContain("continue-on-error");
    expect(workflow).not.toContain("schedule:");
  });
});
