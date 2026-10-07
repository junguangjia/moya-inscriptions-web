import type { JSONReport, JSONReportTest } from "@playwright/test/reporter";
import { describe, expect, it, vi } from "vitest";

import { readE2ePorts } from "../e2e/support/e2e-ports";
import {
  assertAggregate,
  assertCompleteReport,
  assertShardUnion,
  e2eProjects,
  reportEntries,
  type RunIdentity,
  type ShardResult,
} from "../e2e/support/e2e-report-integrity";

const identity: RunIdentity = {
  sourceHead: "a".repeat(40),
  checkoutSha: "b".repeat(40),
  tree: "c".repeat(40),
  runId: "123",
  runAttempt: "2",
};

// The directly used native JSON fields, without a browser or service fixture.
const report = (
  indices: number[],
  shard: number | null = null,
  list = false,
): JSONReport =>
  ({
    config: {
      projects: e2eProjects.map((name) => ({ name })),
      metadata: { moyaCI: { ...identity } },
      workers: 1,
      fullyParallel: false,
      failOnFlakyTests: true,
      shard: shard === null ? null : { current: shard, total: 3 },
    },
    suites: indices.map((index) => ({
      title: `case-${index}.spec.ts`,
      file: `case-${index}.spec.ts`,
      line: 1,
      column: 1,
      specs: [
        {
          title: "keeps its behavior",
          file: `case-${index}.spec.ts`,
          line: 4,
          column: 1,
          tests: [
            {
              projectName: e2eProjects[index % 5],
              expectedStatus: index === 0 ? "skipped" : "passed",
              status: list || index === 0 ? "skipped" : "expected",
              results: list
                ? []
                : [
                    {
                      status: index === 0 ? "skipped" : "passed",
                      retry: 0,
                      errors: [],
                    },
                  ],
            },
          ],
        },
      ],
    })),
    errors: [],
    stats: {
      expected: list ? 0 : indices.filter((index) => index !== 0).length,
      skipped: list ? indices.length : Number(indices.includes(0)),
      unexpected: 0,
      flaky: 0,
      startTime: "2026-01-01T00:00:00Z",
      duration: 10,
    },
  }) as unknown as JSONReport;

const fixture = () => {
  const indices = Array.from({ length: 15 }, (_, index) => index);
  const shards: ShardResult[] = [1, 2, 3].map((shard) => {
    const selected = indices.slice((shard - 1) * 5, shard * 5);
    return {
      identity: { ...identity },
      shard,
      total: 3,
      completed: true,
      exitCode: 0,
      full: report(indices, null, true),
      planned: report(selected, shard, true),
      report: report(selected, shard),
    };
  });
  const merged = report(indices);
  merged.config.workers = 3;
  return { shards, merged };
};
const firstPassed = (value: JSONReport): JSONReportTest =>
  [...reportEntries(value).values()].find(
    (test) => test.expectedStatus === "passed",
  )!;
const gate = (
  { shards, merged }: ReturnType<typeof fixture>,
  jobResult = "success",
) => assertAggregate(jobResult, identity, shards, merged);

it("keeps native five-project serial CI coverage and failure diagnostics", async () => {
  vi.stubEnv("CI", "true");
  vi.stubEnv("MOYA_E2E_WEB_PORT", "4320");
  vi.stubEnv("MOYA_E2E_PUBLIC_API_PORT", "4321");
  try {
    const { default: config } = await import("../e2e/playwright.config");
    expect(config.projects?.map((project) => project.name)).toEqual(
      e2eProjects,
    );
    expect(config).toMatchObject({
      workers: 1,
      fullyParallel: false,
      failOnFlakyTests: true,
      retries: 1,
      globalTimeout: 0,
      timeout: 0,
    });
    expect(config.use).toMatchObject({
      baseURL: "http://127.0.0.1:4320",
      screenshot: "only-on-failure",
      trace: "retain-on-failure-and-retries",
    });
    expect(config.reporter).toEqual([
      ["github"],
      ["blob", expect.any(Object)],
      ["json", expect.any(Object)],
    ]);
  } finally {
    vi.unstubAllEnvs();
  }
});

describe("E2E test-only port options", () => {
  it("preserves defaults and supports an isolated local pair", () => {
    expect(readE2ePorts({})).toEqual({ web: 3100, publicApi: 3101 });
    expect(
      readE2ePorts({
        MOYA_E2E_WEB_PORT: "4320",
        MOYA_E2E_PUBLIC_API_PORT: "4321",
      }),
    ).toEqual({ web: 4320, publicApi: 4321 });
  });
  it.each(["", "0", "65536", " 4320", "4320.5", "abc"])(
    "rejects malformed port %j",
    (port) => {
      expect(() => readE2ePorts({ MOYA_E2E_WEB_PORT: port })).toThrow();
    },
  );
  it("rejects competing Web/API ports", () => {
    expect(() => readE2ePorts({ MOYA_E2E_WEB_PORT: "3101" })).toThrow(
      "must differ",
    );
  });
});

describe("native collection integrity", () => {
  it("normalizes path separators without using mutable source line numbers", () => {
    const left = report([1]);
    const right = structuredClone(left);
    left.suites[0]!.specs[0]!.file = "nested/case.spec.ts";
    right.suites[0]!.specs[0]!.file = "nested\\case.spec.ts";
    right.suites[0]!.specs[0]!.line = 500;
    expect([...reportEntries(left).keys()]).toEqual([
      ...reportEntries(right).keys(),
    ]);
  });
  it("rejects a duplicate semantic key within a report", () => {
    expect(() => reportEntries(report([1, 1]))).toThrow(
      "Duplicate test/project",
    );
  });
  it("proves the exact shard union, not a hardcoded old total", () => {
    const { shards } = fixture();
    expect(
      assertShardUnion(
        shards[0]!.full,
        shards.map((shard) => shard.planned),
      ).size,
    ).toBe(15);
  });
  it("rejects a missing assignment", () => {
    const { shards } = fixture();
    expect(() =>
      assertShardUnion(
        shards[0]!.full,
        shards.slice(1).map((shard) => shard.planned),
      ),
    ).toThrow("Shard union");
  });
  it("rejects an overlapping assignment", () => {
    const { shards } = fixture();
    expect(() =>
      assertShardUnion(shards[0]!.full, [
        shards[0]!.planned,
        shards[0]!.planned,
      ]),
    ).toThrow("Duplicate shard assignment");
  });
});

describe("strict CI aggregate", () => {
  it("accepts all required successful jobs with complete native reports and an explicit skip", () => {
    expect(gate(fixture())).toEqual({
      passed: 14,
      skipped: 1,
      retries: 0,
      total: 15,
    });
  });
  it.each(["failure", "cancelled", "skipped", ""])(
    "rejects actual GitHub job result %j despite successful artifacts",
    (result) => {
      expect(() => gate(fixture(), result)).toThrow("Required shard jobs");
    },
  );
  it.each(["missing", "duplicate", "range", "total", "incomplete", "exit"])(
    "rejects %s shard evidence",
    (condition) => {
      const value = fixture();
      if (condition === "missing") value.shards.pop();
      if (condition === "duplicate") value.shards[2] = value.shards[0]!;
      if (condition === "range") value.shards[2]!.shard = 4;
      if (condition === "total") value.shards[2]!.total = 4;
      if (condition === "incomplete") value.shards[2]!.completed = false;
      if (condition === "exit") value.shards[2]!.exitCode = 1;
      expect(() => gate(value)).toThrow();
    },
  );
  it.each([
    "sourceHead",
    "checkoutSha",
    "tree",
    "runId",
    "runAttempt",
  ] as const)("rejects stale %s in each identity location", (field) => {
    for (const location of [
      "sidecar",
      "full",
      "planned",
      "report",
      "merged",
    ] as const) {
      const value = fixture();
      if (location === "sidecar") value.shards[0]!.identity[field] = "stale";
      else if (location === "merged")
        value.merged.config.metadata.moyaCI[field] = "stale";
      else value.shards[0]![location].config.metadata.moyaCI[field] = "stale";
      expect(() => gate(value)).toThrow(/identity|Mismatched/iu);
    }
  });
  it("rejects a missing trusted run identity", () => {
    const value = fixture();
    expect(() =>
      assertAggregate("success", {} as RunIdentity, value.shards, value.merged),
    ).toThrow("Missing identity");
  });
  it.each(["workers", "fullyParallel", "failOnFlakyTests", "shard", "project"])(
    "rejects changed %s policy",
    (policy) => {
      const value = fixture();
      const config = value.shards[0]!.report.config;
      if (policy === "workers") config.workers = 2;
      if (policy === "fullyParallel") config.fullyParallel = true;
      if (policy === "failOnFlakyTests") config.failOnFlakyTests = false;
      if (policy === "shard") config.shard = null;
      if (policy === "project") config.projects.pop();
      expect(() => gate(value)).toThrow();
    },
  );
  it("rejects a browser removed from every actual collection even if still declared", () => {
    const value = fixture();
    for (const current of [
      value.merged,
      ...value.shards.flatMap((shard) => [
        shard.full,
        shard.planned,
        shard.report,
      ]),
    ]) {
      current.suites = current.suites.filter(
        (suite) =>
          suite.specs[0]!.tests[0]!.projectName !== "tablet-landscape-webkit",
      );
    }
    expect(() => gate(value)).toThrow("Collected browser projects");
  });
  it.each(["missing", "extra"])(
    "rejects %s executed test combinations",
    (kind) => {
      const value = fixture();
      if (kind === "missing") value.shards[0]!.report.suites.pop();
      else value.shards[0]!.report.suites.push(report([99]).suites[0]!);
      expect(() => gate(value)).toThrow("Executed shard");
    },
  );
  it("rejects a missing merged test combination", () => {
    const value = fixture();
    value.merged.suites.pop();
    expect(() => gate(value)).toThrow("Merged report");
  });
  it("rejects merged pass-to-skip corruption even with corrected counters", () => {
    const value = fixture();
    const test = firstPassed(value.merged);
    test.expectedStatus = "skipped";
    test.status = "skipped";
    test.results[0]!.status = "skipped";
    value.merged.stats.expected -= 1;
    value.merged.stats.skipped += 1;
    expect(() => gate(value)).toThrow("Merged outcome mismatch");
  });
});

describe("incomplete or failed native results", () => {
  it.each([
    "empty",
    "implicit-skip",
    "interrupted",
    "error",
    "global",
    "counters",
    "retry-gap",
    "retry-duplicate",
    "flaky",
    "hidden-first-failure",
  ])("rejects %s", (condition) => {
    const value = report([1]);
    const test = firstPassed(value);
    if (condition === "empty") test.results = [];
    if (condition === "implicit-skip") {
      test.status = "skipped";
      test.results[0]!.status = "skipped";
    }
    if (condition === "interrupted") test.results[0]!.status = "interrupted";
    if (condition === "error") test.results[0]!.errors = [{ message: "error" }];
    if (condition === "global")
      value.errors = [
        { message: "Timed out waiting 720000ms for the entire test run" },
      ];
    if (condition === "counters") value.stats.expected = 2;
    if (condition === "retry-gap") test.results[0]!.retry = 1;
    if (condition === "retry-duplicate")
      test.results.push(structuredClone(test.results[0]!));
    if (condition === "flaky") {
      test.status = "flaky";
      value.stats.flaky = 1;
    }
    if (condition === "hidden-first-failure") {
      test.results.push({ ...structuredClone(test.results[0]!), retry: 1 });
      test.results[0]!.status = "failed";
    }
    expect(() => assertCompleteReport(value)).toThrow();
  });
});
