import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { URL } from "node:url";
import test from "node:test";
import {
  earlierClaims,
  waitForPriorAnswer,
  completionHuman,
  agentConfiguration,
  adjacentSource,
  automaticResponseState,
  collectRunEvidence,
  agentEnvironment,
  boundedBody,
  collectFileEvidence,
  collectFailureSources,
  collectRequestedSources,
  parseSourceRequests,
  parseCIEvidence,
  confirmModelSelection,
  cursorFailure,
  currentRun,
  eligiblePR,
  excerptJobLogs,
  failureSourceReferences,
  marker,
  main,
  modelInventory,
  ownedComment,
  parseReport,
  parseCLIResult,
  parseModelSelection,
  readJobLogs,
  renderReport,
  safeText,
  selectEvent,
  questionInput,
  LIMITS,
} from "./cursor-review.mjs";
import { classifyTask } from "./ci-task-scope.mjs";
import {
  claimRecord,
  finishRecord,
  ledgerBody,
  readLedger,
} from "./cursor-automation.mjs";

const repository = "example/project";
test("large changed files preserve bounded exact current context instead of no source", () => {
  const source = Array.from(
    { length: 1800 },
    (_, i) => `const line${i + 1} = ${i + 1};`,
  ).join("\n");
  const patch =
    "@@ -898,3 +898,3 @@\n const line898 = 898;\n-old();\n+const line899 = 899;\n const line900 = 900;";
  const excerpts = adjacentSource(source, patch);
  assert.ok(
    excerpts.some((e) => e.source.includes("899: const line899 = 899;")),
  );
  assert.ok(!excerpts.some((e) => e.source.includes("1: const line1 = 1;")));
  assert.ok(JSON.stringify(excerpts).length <= LIMITS.source);
  const evidence = { files: [], omissions: [], head: "a".repeat(40) };
  collectFileEvidence(
    evidence,
    [
      {
        filename: "scripts/large.mjs",
        status: "modified",
        sha: "b".repeat(40),
        patch,
      },
    ],
    () => ({
      encoding: "base64",
      size: Buffer.byteLength(source),
      content: Buffer.from(source).toString("base64"),
    }),
  );
  assert.deepEqual(evidence.files[0].sourceExcerpts, excerpts);
  assert.equal(evidence.files[0].sourceBlob, "b".repeat(40));
  assert.ok(
    evidence.omissions.some((x) =>
      x.includes("full source outside supplied scope"),
    ),
  );
  assert.deepEqual(adjacentSource(source, "+unanchored();"), []);
});

for (const boundary of ["excerpt cap", "packet allowance"]) {
  test(`large source omissions do not claim absent windows at ${boundary}`, () => {
    const source =
      boundary === "excerpt cap"
        ? `/* ${"padding ".repeat(4000)} */\nconst changed = true;`
        : Array.from(
            { length: 1800 },
            (_, i) => `const line${i + 1} = ${i + 1};`,
          ).join("\n");
    const patch =
      boundary === "excerpt cap"
        ? "@@ -2 +2 @@\n-old();\n+const changed = true;"
        : "@@ -899 +899 @@\n-old();\n+const line899 = 899;";
    const excerpts = adjacentSource(source, patch);
    assert.equal(excerpts.length === 0, boundary === "excerpt cap");
    const evidence = { files: [], omissions: [], head: "a".repeat(40) };
    if (boundary === "packet allowance")
      evidence.context = "x".repeat(LIMITS.packet - 12000 - 512);
    collectFileEvidence(
      evidence,
      [
        {
          filename: "scripts/large.mjs",
          status: "modified",
          sha: "b".repeat(40),
          patch,
        },
      ],
      () => ({
        encoding: "base64",
        size: Buffer.byteLength(source),
        content: Buffer.from(source).toString("base64"),
      }),
    );
    assert.equal(evidence.files.length, 1);
    assert.equal(evidence.files[0].sourceExcerpts, undefined);
    assert.ok(
      evidence.omissions.some((value) =>
        value.startsWith("Hunk-adjacent source not included"),
      ),
    );
    assert.ok(
      !evidence.omissions.some((value) =>
        value.startsWith("Hunk-adjacent source only;"),
      ),
    );
  });
}

test("successful CI evidence reports exact jobs/steps while missing testcase data remains unclaimed", () => {
  const evidence = { omissions: [] };
  collectRunEvidence(
    evidence,
    {
      id: 12,
      run_attempt: 1,
      head_sha: "a".repeat(40),
      event: "push",
      conclusion: "success",
    },
    {
      total_count: 2,
      jobs: [
        {
          id: 13,
          name: "lightweight",
          conclusion: "success",
          steps: [
            {
              number: 4,
              name: "Run shared tooling checks",
              conclusion: "success",
            },
          ],
        },
        { id: 14, name: "e2e-shards", conclusion: "skipped", steps: [] },
      ],
    },
  );
  assert.equal(evidence.runEvidence.jobs[0].steps[0].conclusion, "success");
  assert.equal(evidence.runEvidence.jobs[1].conclusion, "skipped");
  assert.equal(evidence.runEvidence.source, "a".repeat(40));
  assert.equal(evidence.runEvidence.testcases, undefined);
  const bounded = { omissions: [] };
  collectRunEvidence(
    bounded,
    { id: 12 },
    {
      total_count: 101,
      jobs: Array.from({ length: 101 }, (_, i) => ({
        id: i + 1,
        name: "n".repeat(600),
        steps: [],
      })),
    },
  );
  assert.ok(JSON.stringify(bounded.runEvidence).length <= 12000);
  assert.ok(bounded.omissions.length > 0);
});

test("valid partial answer is consumable without clean verdict or complete-review reuse", () => {
  const report = {
    assessment: "incomplete",
    actualInvocations: 1,
    model: "grok-4.7[context=500k,reasoning_effort=xhigh,fast=true]",
    effectiveSelection: {
      modelId: "grok-4.7",
      context: "500k",
      reasoning_effort: "xhigh",
      fast: "true",
      maxMode: true,
    },
    citationValidation: {
      status: "PASS",
      count: 1,
      citations: [{ exact: true }],
    },
  };
  const state = automaticResponseState(
    { omissions: ["missing context"] },
    report,
  );
  assert.equal(state.status, "PARTIAL");
  assert.equal(state.responseAccepted, true);
  assert.equal(state.coverageComplete, false);
  assert.equal(state.cleanVerdict, false);
  assert.equal(state.ledgerStatus, "incomplete");
  const findings = automaticResponseState(
    { omissions: ["missing context"] },
    {
      ...report,
      assessment: "findings",
      findings: [{ priority: "P1", body: "supported issue" }],
    },
  );
  assert.equal(findings.responseAccepted, true);
  assert.equal(findings.status, "PARTIAL");
  assert.equal(findings.ledgerStatus, "incomplete");
  const review = claimRecord(
    { records: [] },
    repository,
    { number: 7, head: "a".repeat(40), kind: "review" },
    100,
  );
  const rows = finishRecord(
    { records: review.records },
    review.key,
    100,
    findings.ledgerStatus,
  );
  const merged = claimRecord(
    { records: rows },
    repository,
    {
      number: 7,
      head: "b".repeat(40),
      prHead: "a".repeat(40),
      postMerge: true,
      kind: "postmerge",
      runId: 8,
      attempt: 1,
    },
    101,
  );
  assert.equal(merged.priorReview, null);
  assert.equal(
    automaticResponseState(
      { omissions: [] },
      { ...report, assessment: "no_findings" },
    ).cleanVerdict,
    true,
  );
  for (const delta of [
    { assessment: "unavailable" },
    { actualInvocations: 0 },
    { effectiveSelection: { ...report.effectiveSelection, maxMode: false } },
    {
      citationValidation: {
        status: "PASS",
        count: 1,
        citations: [{ exact: false }],
      },
    },
  ])
    assert.equal(
      automaticResponseState({ omissions: [] }, { ...report, ...delta })
        .responseAccepted,
      false,
    );
  assert.equal(
    automaticResponseState({ omissions: [], metadataOnly: true }, report)
      .responseAccepted,
    false,
  );
});
const head = "a".repeat(40);
const base = "b".repeat(40);
const pr = {
  number: 7,
  state: "open",
  changed_files: 1,
  base: { ref: "main", sha: base, repo: { full_name: repository } },
  head: { sha: head, repo: { full_name: repository } },
};
const run = {
  id: 12,
  run_attempt: 1,
  name: "CI",
  path: ".github/workflows/ci.yml",
  event: "pull_request",
  status: "completed",
  conclusion: "failure",
  head_sha: head,
  head_repository: { full_name: repository },
};
const packet = {
  repository,
  number: 7,
  kind: "review",
  head,
  base,
  files: [{ path: "src/example.js", patch: "+example();" }],
  omissions: [],
};
const clean = {
  assessment: "no_findings",
  summary: "No supported issue in supplied evidence.",
  findings: [],
};

test("only current same-repository PRs and failed canonical CI runs are eligible", () => {
  assert.ok(eligiblePR(pr, repository, head));
  assert.equal(eligiblePR(pr, repository, base), false);
  assert.equal(eligiblePR({ ...pr, state: "closed" }, repository), false);
  assert.equal(
    eligiblePR(
      { ...pr, head: { ...pr.head, repo: { full_name: "fork/project" } } },
      repository,
    ),
    false,
  );
  assert.equal(
    selectEvent(
      "pull_request_target",
      { action: "synchronize", pull_request: pr },
      repository,
    ).number,
    7,
  );
  assert.equal(
    selectEvent(
      "pull_request_target",
      { action: "edited", pull_request: pr },
      repository,
    ),
    null,
  );
  const target = selectEvent(
    "workflow_run",
    { action: "completed", workflow_run: run },
    repository,
  );
  assert.ok(currentRun(run, target));
  for (const delta of [
    { conclusion: "success" },
    { conclusion: "cancelled" },
    { status: "queued" },
    { name: "Other CI" },
    { path: ".github/workflows/untrusted.yml" },
    { event: "push" },
    { head_repository: { full_name: "fork/project" } },
    { run_attempt: undefined },
  ]) {
    assert.equal(
      selectEvent(
        "workflow_run",
        { action: "completed", workflow_run: { ...run, ...delta } },
        repository,
      ),
      null,
    );
  }
  assert.equal(currentRun({ ...run, run_attempt: 2 }, target), false);
  assert.throws(() =>
    selectEvent(
      "workflow_dispatch",
      { inputs: { pr: "7; echo bad" } },
      repository,
    ),
  );
});

test("credential scanning withholds complete source rather than leaking matched values", () => {
  const syntheticValue = ["ghp_", "A".repeat(36)].join("");
  assert.equal(safeText(syntheticValue), null);
  const syntheticAssignment = [
    "password",
    "=",
    JSON.stringify("aB3".repeat(10)),
  ].join("");
  assert.equal(safeText(syntheticAssignment, "config.env"), null);
  assert.equal(
    safeText("const apiKey = process.env.API_KEY;", "example.ts"),
    "const apiKey = process.env.API_KEY;",
  );
  assert.equal(safeText("\u001b[31merror\u001b[0m"), "error");
  assert.equal(safeText(`safe\u0000${syntheticValue}`), null);
});

test("job logs support gh ANSI protection without exposing controls or credentials", () => {
  for (const recent of [true, false]) {
    const runner = (bin, args) => {
      assert.equal(bin, "gh");
      if (args[1] === "--help")
        return recent ? "--allow-escape-sequences" : "older gh help";
      assert.equal(args[1], `repos/${repository}/actions/jobs/12/logs`);
      assert.equal(args.includes("--allow-escape-sequences"), recent);
      return "\u001b[31mtest failed\u001b[0m";
    };
    assert.equal(readJobLogs(repository, 12, runner), "test failed");
  }
  assert.equal(
    readJobLogs(repository, 12, (_bin, args) =>
      args[1] === "--help" ? "" : ["ghp_", "A".repeat(36)].join(""),
    ),
    null,
  );
});

test("bounded log excerpts preserve middle failures ahead of setup and cleanup noise", () => {
  const steps = [
    {
      conclusion: "failure",
      started_at: "2026-10-05T08:10:00Z",
      completed_at: "2026-10-05T08:11:00Z",
    },
  ];
  const logs = [
    ...Array(500).fill("2026-10-05T08:00:00Z setup"),
    "2026-10-05T08:10:00Z " + "x".repeat(20000),
    "2026-10-05T08:10:01Z ##[error] AssertionError: expected visible, received hidden",
    "2026-10-05T08:10:02Z at tests/viewer.spec.ts:41",
    ...Array(500).fill("2026-10-05T08:10:59Z test output"),
    ...Array(500).fill(
      "2026-10-05T08:20:00Z ##[error] irrelevant cleanup noise",
    ),
  ].join("\n");
  const excerpt = excerptJobLogs(logs, steps, 1800);
  assert.ok(excerpt.length <= 1800);
  assert.match(excerpt, /AssertionError: expected visible, received hidden/u);
  assert.match(excerpt, /tests\/viewer.spec.ts:41/u);
  assert.doesNotMatch(excerpt, /irrelevant cleanup noise/u);
  assert.match(excerpt, /other lines omitted/u);
  const missingTimes = excerptJobLogs(logs, [], 1800);
  assert.match(missingTimes, /AssertionError/u);
  assert.ok(missingTimes.length <= 1800);
  assert.equal(excerptJobLogs("short failure", steps, 1800), "short failure");
});

test("CI source gaps are filled from exact head with scanned failure windows and bounded helpers", () => {
  const evidence = {
    ...packet,
    kind: "ci",
    files: [],
    omissions: [],
    failedJobs: [
      {
        logs: "Error: e2e/missing.spec.ts:600:7\nat tests/e2e/missing.spec.ts:400:1\ntests/../../private.ts:1\nscripts/credential.ts:1",
      },
    ],
  };
  assert.deepEqual(failureSourceReferences(evidence.failedJobs), [
    { path: "tests/e2e/missing.spec.ts", lines: [600, 400] },
    { path: "scripts/credential.ts", lines: [1] },
  ]);
  const source = Array(700).fill("// surrounding source");
  source[0] = 'import { ready } from "./helper";';
  source[599] = "expect(ready()).toBe(true); // actual failing assertion";
  source[399] = "const observed = false; // earlier reported location";
  const sources = {
    "tests/e2e/missing.spec.ts": source.join("\n"),
    "tests/e2e/helper.ts": "export const ready = () => false;",
    "scripts/credential.ts": ["ghp_", "A".repeat(36)].join(""),
  };
  const reads = [];
  collectFailureSources(evidence, (path, ref) => {
    assert.equal(ref, head);
    reads.push(path);
    if (!Object.hasOwn(sources, path)) throw new Error("missing");
    const content = sources[path];
    return {
      type: "file",
      path,
      sha: base,
      encoding: "base64",
      size: Buffer.byteLength(content),
      content: Buffer.from(content).toString("base64"),
    };
  });
  assert.equal(evidence.relatedSources.length, 2);
  assert.match(evidence.relatedSources[0].source, /600: expect\(ready\(\)\)/u);
  assert.match(evidence.relatedSources[0].source, /400: const observed/u);
  assert.match(evidence.relatedSources[1].source, /ready = \(\) => false/u);
  assert.ok(
    evidence.relatedSources.every(
      (file) => file.ref === head && file.blob === base,
    ),
  );
  assert.ok(
    evidence.omissions.some((value) => value.includes("Credential finding")),
  );
  assert.ok(reads.length <= 24);
  assert.ok(
    !JSON.stringify(evidence).includes(sources["scripts/credential.ts"]),
  );
  const findings = {
    assessment: "findings",
    summary: "Supported cause",
    findings: [
      {
        priority: "P2",
        path: "tests/e2e/helper.ts",
        line: 1,
        body: "Concrete source evidence",
        fix: "Repair helper",
        validation: "Run its test",
      },
    ],
  };
  assert.equal(
    parseReport(JSON.stringify(findings), evidence).assessment,
    "findings",
  );
  assert.throws(() =>
    parseReport(JSON.stringify(findings), { ...evidence, kind: "review" }),
  );
});

test("requested CI source wins over unrelated patches and preserves complete bodies", () => {
  const evidence = {
    ...packet,
    kind: "ci",
    manualCI: true,
    files: [],
    omissions: [],
    failedJobs: [],
    sourceRequests: parseSourceRequests(
      "apps/web/causal.ts,tests/helper.ts:2-3",
    ),
  };
  const sources = {
    "apps/web/causal.ts":
      "// context\n".repeat(2000) + "export const actualCause = false;",
    "tests/helper.ts":
      "// omitted\nconst ready = false;\nexport { ready };\n// omitted",
  };
  collectRequestedSources(evidence, (path, ref) => {
    assert.equal(ref, head);
    const text = sources[path];
    return {
      type: "file",
      path,
      sha: base,
      encoding: "base64",
      size: Buffer.byteLength(text),
      content: Buffer.from(text).toString("base64"),
    };
  });
  collectFileEvidence(
    evidence,
    Array.from({ length: 100 }, (_, i) => ({
      filename: `apps/web/unrelated-${i}.ts`,
      status: "added",
      patch: "+" + "x".repeat(12000),
    })),
    () => {
      throw new Error("unexpected read");
    },
  );
  collectFailureSources(evidence, () => {
    throw new Error("unexpected read");
  });
  assert.equal(
    evidence.relatedSources[0].source,
    sources["apps/web/causal.ts"],
  );
  assert.equal(evidence.relatedSources[0].coverage, "full");
  assert.equal(
    evidence.relatedSources[1].source,
    "2: const ready = false;\n3: export { ready };",
  );
  assert.ok(
    evidence.omissions.some((value) => value.includes("Patch omitted")),
  );
  assert.ok(JSON.stringify(evidence).length < 100000);
});

test("requested source paths, ranges and full-content credential scan remain bounded", () => {
  for (const value of [
    "../private.ts",
    "apps/../private.ts",
    "scripts/private.env",
    "https://example.com/a.ts",
    "apps/a.ts:9-2",
    "apps/a.ts:1-401",
    "apps/a.ts,apps/a.ts",
    "apps/a.ts,",
    Array(9).fill("apps/a.ts").join(","),
  ])
    assert.throws(() => parseSourceRequests(value));
  const evidence = {
    ...packet,
    kind: "ci",
    manualCI: true,
    files: [],
    omissions: [],
    failedJobs: [],
    sourceRequests: parseSourceRequests(
      "apps/unsafe.ts:1-1,apps/large.ts,apps/wrong.ts,apps/range.ts:2-8",
    ),
  };
  collectRequestedSources(evidence, (path) => {
    const text =
      path === "apps/unsafe.ts"
        ? "// safe visible line\n" + ["ghp_", "A".repeat(36)].join("")
        : path === "apps/large.ts"
          ? "x".repeat(32001)
          : "x";
    return {
      type: "file",
      path: path === "apps/wrong.ts" ? "apps/other.ts" : path,
      sha: base,
      encoding: "base64",
      size: Buffer.byteLength(text),
      content: Buffer.from(text).toString("base64"),
    };
  });
  assert.deepEqual(evidence.relatedSources, []);
  assert.equal(evidence.omissions.length, 4);
  assert.match(evidence.omissions[0], /Credential finding/u);
  assert.match(evidence.omissions[1], /narrower path:start-end/u);
  const ordinary = { ...evidence, manualCI: false, relatedSources: [] };
  collectRequestedSources(ordinary, () => {
    throw new Error("must not read");
  });
  assert.deepEqual(ordinary.relatedSources, []);
});

test("supplied native observations bind the exact tuple and cannot smuggle extra fields or credentials", () => {
  const target = { head, runId: 12, attempt: 1 };
  const supplied = {
    ...target,
    provenance: "Synthetic CI trace: chromium, test A, retry1, call56",
    observations: [
      "Reported pre-snapshot delay100ms; matcher2ms; not a product wait measurement.",
    ],
  };
  const parsed = parseCIEvidence(
    JSON.stringify({ ...supplied, extra: "discard me" }),
    target,
  );
  assert.equal(parsed.independentlyVerified, false);
  assert.equal(parsed.kind, "supplied_native_observations");
  assert.equal(Object.hasOwn(parsed, "extra"), false);
  for (const delta of [
    { head: base },
    { runId: 13 },
    { attempt: 2 },
    { observations: [] },
    { observations: Array(9).fill("observation") },
    { observations: [{}] },
    { extra: ["ghp_", "A".repeat(36)].join("") },
    { extra: "界".repeat(3000) },
  ])
    assert.throws(
      () => parseCIEvidence(JSON.stringify({ ...supplied, ...delta }), target),
      /INVALID_CI_EVIDENCE/u,
    );
  assert.throws(
    () => parseCIEvidence("malformed", target),
    /INVALID_CI_EVIDENCE/u,
  );
  for (const delta of [
    { provenance: "sentinel" },
    { observations: ["sentinel"] },
    { extra: { nested: "sentinel" } },
  ]) {
    const encoded = JSON.stringify({ ...supplied, ...delta }).replace(
      "sentinel",
      "\\u0067" + "hp_" + "A".repeat(36),
    );
    assert.notEqual(safeText(encoded), null);
    assert.throws(
      () => parseCIEvidence(encoded, target),
      /INVALID_CI_EVIDENCE/u,
    );
  }
  const controls = parseCIEvidence(
    JSON.stringify({
      ...supplied,
      observations: ["\u001b[31mReported timing\u001b[0m"],
    }),
    target,
  );
  assert.deepEqual(controls.observations, ["Reported timing"]);
  const inputs = {
    pr: "7",
    operation: "diagnose-ci",
    expected_head: head,
    ci_run: "12",
    ci_attempt: "1",
    base_ref: "main",
    ci_evidence: JSON.stringify(supplied),
  };
  assert.deepEqual(
    selectEvent("workflow_dispatch", { inputs }, repository)
      .supplementalEvidence,
    parsed,
  );
  assert.throws(() =>
    selectEvent(
      "workflow_dispatch",
      { inputs: { ...inputs, expected_head: base } },
      repository,
    ),
  );
  assert.equal(
    Object.hasOwn(
      selectEvent(
        "workflow_dispatch",
        { inputs: { pr: "7", operation: "review", ci_evidence: "malformed" } },
        repository,
      ),
      "supplementalEvidence",
    ),
    false,
  );
});

test("source collection rejects wrong-path metadata, oversized files and unrelated file types", () => {
  assert.deepEqual(
    failureSourceReferences([
      {
        logs: "services/backend/route.ts:12\napps/web/app/(routes)/[id]/page.tsx:34",
      },
    ]),
    [
      { path: "services/backend/route.ts", lines: [12] },
      { path: "apps/web/app/(routes)/[id]/page.tsx", lines: [34] },
    ],
  );
  for (const delta of [{ path: "scripts/other.ts" }, { size: 300000 }]) {
    const evidence = {
      ...packet,
      kind: "ci",
      files: [],
      omissions: [],
      failedJobs: [{ logs: "scripts/fail.ts:1\nscripts/private.env:1" }],
    };
    collectFailureSources(evidence, (path) => ({
      type: "file",
      path,
      sha: base,
      size: 1,
      encoding: "base64",
      content: "eA==",
      ...delta,
    }));
    assert.deepEqual(evidence.relatedSources, []);
    assert.equal(evidence.omissions.length, 1);
  }
});

test("already supplied full source still contributes its missing direct helper", () => {
  const evidence = {
    ...packet,
    kind: "ci",
    files: [
      {
        path: "tests/failure.ts",
        source: 'import { helper } from "./helper";',
      },
    ],
    omissions: [],
    failedJobs: [{ logs: "tests/failure.ts:10" }],
  };
  collectFailureSources(evidence, (path, ref) => {
    assert.equal(path, "tests/helper.ts");
    assert.equal(ref, head);
    return {
      type: "file",
      path,
      sha: base,
      size: 1,
      encoding: "base64",
      content: "eA==",
    };
  });
  assert.equal(evidence.relatedSources.length, 1);
  assert.equal(evidence.relatedSources[0].path, "tests/helper.ts");
});

test("large prose and generated additions cannot displace executable patch coverage", () => {
  const evidence = { ...packet, files: [], omissions: [], failedJobs: [] };
  const paths = [
    "database/migration.sql",
    "packages/contracts/schema.ts",
    "services/backend/worker.ts",
    "tests/worker.test.ts",
    "infra/Dockerfile",
    "infra/backend.env.example",
    "infra/worker.service",
    ".github/workflows/ci.yml",
    "package.json",
  ];
  const source = paths.map((filename) => ({
    filename,
    status: "added",
    sha: base,
    patch: "+// small executable change",
  }));
  const docs = Array.from({ length: 90 }, (_, i) => ({
    filename: `docs/${i}.md`,
    status: "added",
    sha: base,
    patch: `+${"Long prose. ".repeat(1300)}`,
  }));
  let reads = 0;
  collectFileEvidence(
    evidence,
    [
      ...docs,
      {
        filename: "infra/package-lock.json",
        status: "added",
        sha: base,
        patch: `+${"lock entry ".repeat(1800)}`,
      },
      {
        filename: "services/oversized.ts",
        status: "added",
        sha: base,
        patch: `+${"x".repeat(LIMITS.source)}`,
      },
      ...source,
      {
        filename: "z/renamed.ts",
        status: "renamed",
        sha: base,
        patch: "+updated();",
      },
    ],
    () => {
      reads++;
      assert.ok(
        paths.every((path) =>
          evidence.files.some((file) => file.path === path),
        ),
      );
      return {
        encoding: "base64",
        size: 20000,
        content: Buffer.from("// " + "context ".repeat(2499)).toString(
          "base64",
        ),
      };
    },
  );
  assert.equal(
    reads,
    1,
    "added files, prose and lockfiles must not duplicate full source",
  );
  assert.ok(
    paths.every((path) => evidence.files.some((file) => file.path === path)),
  );
  assert.ok(
    evidence.omissions.some((value) => value.includes("services/oversized.ts")),
  );
  assert.ok(
    evidence.omissions.some((value) => value.startsWith("Patch omitted by")),
  );
  assert.ok(evidence.files.length <= LIMITS.files);
  assert.ok(JSON.stringify(evidence).length <= LIMITS.packet);
});

test("patch allocation respects serialized Unicode/escape size and preserves CI log room", () => {
  const evidence = {
    ...packet,
    kind: "ci",
    files: [],
    omissions: [],
    failedJobs: [],
  };
  const patch = `+// ${'文字 " \\ '.repeat(1200)}`;
  collectFileEvidence(
    evidence,
    Array.from({ length: 80 }, (_, i) => ({
      filename: `services/模块-${i}.ts`,
      status: "added",
      sha: base,
      patch,
    })),
    () => {
      throw new Error("unexpected source fetch");
    },
  );
  evidence.failedJobs.push({ id: 12, logs: '"'.repeat(LIMITS.logs) });
  assert.ok(evidence.files.length > 0);
  assert.ok(evidence.omissions.length > 0);
  assert.ok(JSON.stringify(evidence).length <= LIMITS.packet);
  assert.ok(evidence.files.every((file) => file.patch === patch));
});

test("executable prototypes under docs outrank even smaller prose patches", () => {
  const evidence = { ...packet, files: [], omissions: [], failedJobs: [] };
  collectFileEvidence(
    evidence,
    [
      { filename: "docs/a.md", status: "added", patch: "+x" },
      {
        filename: "docs/prototypes/preview.js",
        status: "added",
        patch: "+renderPreview();",
      },
      {
        filename: "docs/prototypes/preview.css",
        status: "added",
        patch: "+main { color: inherit; }",
      },
    ],
    () => {
      throw new Error("unexpected source fetch");
    },
  );
  assert.deepEqual(
    evidence.files.map((file) => file.path),
    ["docs/prototypes/preview.js", "docs/prototypes/preview.css", "docs/a.md"],
  );
});

test("optional source credentials withhold the entire file; missing and invalid evidence stays explicit", () => {
  const evidence = { ...packet, files: [], omissions: [], failedJobs: [] };
  const synthetic = ["ghp_", "A".repeat(36)].join("");
  const file = (filename, extra = {}) => ({
    filename,
    status: "modified",
    sha: base,
    patch: "+safe();",
    ...extra,
  });
  collectFileEvidence(
    evidence,
    [
      file("src/credential.ts"),
      file("src/invalid.ts", { sha: head }),
      file("src/removed.ts", { status: "removed" }),
      file("src/no-patch.ts", { patch: undefined }),
      file("assets/binary.png", { patch: undefined }),
      file("docs/guide.md"),
    ],
    (blobSha) =>
      blobSha === base
        ? {
            encoding: "base64",
            size: synthetic.length,
            content: Buffer.from(synthetic).toString("base64"),
          }
        : {
            encoding: "base64",
            size: 1,
            content: Buffer.from([255]).toString("base64"),
          },
  );
  assert.ok(!evidence.files.some((file) => file.path === "src/credential.ts"));
  assert.ok(evidence.files.some((file) => file.path === "src/removed.ts"));
  assert.ok(evidence.files.some((file) => file.path === "docs/guide.md"));
  assert.ok(
    evidence.omissions.some((value) =>
      value.includes("Credential finding: src/credential.ts"),
    ),
  );
  assert.ok(
    evidence.omissions.some((value) =>
      value.includes("Full source unavailable: src/invalid.ts"),
    ),
  );
  assert.ok(
    evidence.omissions.some((value) => value.includes("src/no-patch.ts")),
  );
  assert.ok(
    evidence.omissions.some((value) => value.includes("assets/binary.png")),
  );
  assert.ok(!JSON.stringify(evidence).includes(synthetic));
});

test("agent receives no GitHub/runner credentials and has no shell/write/network tools", () => {
  const result = agentEnvironment(
    {
      PATH: "/bin",
      CURSOR_API_KEY: "test-only",
      GH_TOKEN: "test-only",
      GITHUB_TOKEN: "test-only",
      ACTIONS_RUNTIME_TOKEN: "test-only",
      NODE_OPTIONS: "--inspect",
      OPENAI_API_KEY: "test-only",
    },
    "/isolated",
  );
  assert.deepEqual(Object.keys(result).sort(), [
    "CURSOR_API_KEY",
    "CURSOR_CONFIG_DIR",
    "HOME",
    "NO_COLOR",
    "PATH",
    "TERM",
  ]);
  const { permissions } = agentConfiguration();
  assert.deepEqual(permissions.allow, []);
  for (const rule of [
    "Shell(*)",
    "Write(**)",
    "WebFetch(*)",
    "Mcp(*:*)",
    "Read(**)",
  ])
    assert.ok(permissions.deny.includes(rule));
});

test("legacy reports accept non-English prose while retaining required fields and length limits", () => {
  const finding = {
    priority: "P1",
    path: "src/example.js",
    line: 1,
    body: "存在可复现的错误。",
    fix: "修复已定位的问题。",
    validation: "运行相关测试。",
  };
  const report = {
    assessment: "findings",
    summary: "已发现有证据支持的问题。",
    findings: [finding],
  };
  assert.deepEqual(parseReport(JSON.stringify(report), packet), report);
  for (const value of [undefined, null, 0, "", "   ", "证".repeat(1801)]) {
    assert.throws(
      () => parseReport(JSON.stringify({ ...report, summary: value }), packet),
      /INVALID_REPORT/u,
    );
  }
  for (const field of ["body", "fix", "validation"]) {
    for (const value of [undefined, null, 0, "", "   ", "证".repeat(2201)]) {
      assert.throws(
        () =>
          parseReport(
            JSON.stringify({
              ...report,
              findings: [{ ...finding, [field]: value }],
            }),
            packet,
          ),
        /INVALID_FINDING/u,
      );
    }
  }
  assert.equal(
    parseReport(
      JSON.stringify({
        ...report,
        summary: "证".repeat(1800),
        findings: [{ ...finding, body: "证".repeat(2200) }],
      }),
      packet,
    ).assessment,
    "findings",
  );
});

test("reports cannot invent paths, silently pass missing evidence, or contain credentials", () => {
  assert.equal(
    parseReport(JSON.stringify(clean), packet).assessment,
    "no_findings",
  );
  assert.equal(
    parseReport(JSON.stringify(clean), {
      ...packet,
      omissions: ["missing patch"],
    }).assessment,
    "incomplete",
  );
  assert.equal(
    parseReport(JSON.stringify(clean), { ...packet, kind: "ci" }).assessment,
    "incomplete",
  );
  const finding = {
    priority: "P1",
    path: "src/example.js",
    line: 1,
    body: "Concrete failure",
    fix: "Minimal fix",
    validation: "Relevant check",
  };
  const report = {
    assessment: "findings",
    summary: "A concrete defect",
    findings: [finding],
  };
  assert.equal(parseReport(JSON.stringify(report), packet).findings.length, 1);
  const partial = parseReport(
    JSON.stringify({ ...report, assessment: "incomplete" }),
    packet,
  );
  assert.equal(partial.assessment, "incomplete");
  assert.deepEqual(partial.findings, [finding]);
  const mislabeled = parseReport(
    JSON.stringify({ ...report, assessment: "no_findings" }),
    packet,
  );
  assert.equal(mislabeled.assessment, "incomplete");
  assert.deepEqual(mislabeled.findings, [finding]);
  assert.match(mislabeled.formatWarning, /label disagreed/u);
  for (const delta of [
    { path: "invented.js" },
    { line: -1 },
    { priority: "P0" },
    { body: "" },
    { fix: "x".repeat(2201) },
  ]) {
    assert.throws(() =>
      parseReport(
        JSON.stringify({ ...report, findings: [{ ...finding, ...delta }] }),
        packet,
      ),
    );
    assert.throws(() =>
      parseReport(
        JSON.stringify({
          ...report,
          assessment: "incomplete",
          findings: [{ ...finding, ...delta }],
        }),
        packet,
      ),
    );
  }
  assert.throws(() =>
    parseReport(
      JSON.stringify({ ...clean, summary: ["ghp_", "A".repeat(36)].join("") }),
      packet,
    ),
  );
  const emptyFindings = parseReport(
    JSON.stringify({ ...clean, assessment: "findings" }),
    packet,
  );
  assert.equal(emptyFindings.assessment, "incomplete");
  assert.match(emptyFindings.formatWarning, /label disagreed/u);
  assert.throws(() =>
    parseReport(
      JSON.stringify({
        ...report,
        assessment: "incomplete",
        findings: [{ ...finding, body: ["ghp_", "A".repeat(36)].join("") }],
      }),
      packet,
    ),
  );
  assert.throws(() => parseReport("error: unavailable", packet));
  assert.equal(
    parseCLIResult(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: JSON.stringify(clean),
      }),
      packet,
    ).assessment,
    "no_findings",
  );
  assert.throws(() =>
    parseCLIResult(
      JSON.stringify({
        type: "result",
        subtype: "error",
        is_error: true,
        result: JSON.stringify(clean),
      }),
      packet,
    ),
  );
});

test("deterministic summary escapes active content and only updates its own bot comment", () => {
  const body = renderReport(packet, {
    ...clean,
    summary: "<img src=x> @someone [click](https://example.com)",
  });
  assert.ok(body.startsWith(marker("review")));
  assert.ok(body.includes(head));
  assert.ok(!body.includes("<img"));
  assert.ok(!body.includes("@someone"));
  const fake = { id: 1, user: { login: "contributor", type: "User" }, body };
  const bot = {
    id: 2,
    user: { login: "github-actions[bot]", type: "Bot" },
    body,
  };
  assert.equal(ownedComment([fake, bot], "review"), bot);
  assert.equal(ownedComment([fake, bot], "ci"), undefined);
});

test("automation-only paths stay in lightweight validation with behavioral tests", () => {
  const plan = classifyTask([
    "scripts/cursor-review.mjs",
    "scripts/cursor-review.test.mjs",
    ".github/workflows/cursor-review.yml",
    "docs/development/cursor-github-automation.md",
  ]);
  assert.equal(plan.web, false);
  assert.equal(plan.apple, false);
  assert.equal(plan.cms, false);
  assert.equal(plan.lightweight, true);
});

test("workflow keeps trusted checkout, pinned CLI, separate credentials and no PR execution", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/cursor-review.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /pull_request_target:/u);
  assert.match(workflow, /ref: \$\{\{ needs.route.outputs.trusted \}\}/u);
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(workflow, /sha256sum --check --status/u);
  assert.match(workflow, /group: cursor-.*-pr-/u);
  assert.match(workflow, /steps.fresh.outputs.ready/u);
  assert.match(
    workflow,
    /install-confidentiality-hooks.mjs --confirm-current-identity-approved/u,
  );
  assert.match(workflow, /timeout --kill-after=5s 115s/u);
  assert.doesNotMatch(
    workflow,
    /ref:.*head|pnpm install|npm install|contents: write|--force|--yolo/u,
  );
  assert.equal((workflow.match(/secrets\.CURSOR_API_KEY/gu) || []).length, 1);
});

test("fresh runner installs the controlled scanner, publishes once, updates once, and skips stale heads", () => {
  const temp = mkdtempSync(join(tmpdir(), "cursor-publish-test-"));
  const project = join(temp, "project");
  const bin = join(temp, "bin");
  const runTemp = join(temp, "runner");
  const directory = join(runTemp, "cursor-review");
  for (const path of [join(project, "scripts"), bin, directory])
    mkdirSync(path, { recursive: true });
  try {
    for (const name of [
      "cursor-review.mjs",
      "cursor-response.mjs",
      "cursor-stream.mjs",
      "cursor-automation.mjs",
      "confidentiality-scan.mjs",
      "install-confidentiality-hooks.mjs",
    ])
      cpSync(
        new URL(`./${name}`, import.meta.url),
        join(project, "scripts", name),
      );
    cpSync(
      new URL("../.githooks", import.meta.url),
      join(project, ".githooks"),
      { recursive: true },
    );
    const state = join(temp, "state.json");
    writeFileSync(state, JSON.stringify({ pr, comments: [], writes: [] }));
    writeFileSync(join(directory, "context.json"), JSON.stringify(packet));
    writeFileSync(join(directory, "report.json"), JSON.stringify(clean));
    writeFileSync(
      join(bin, "gh"),
      `#!${process.execPath}
const fs = require('node:fs');
const file = ${JSON.stringify(state)};
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const method = process.argv[4], path = process.argv[5];
let result;
if (method === 'GET' && path.includes('/pulls/')) result = state.pr;
else if (method === 'GET' && path.includes('/actions/runs/')) result = state.run;
else if (method === 'GET') {
 result = state.comments;
 if (state.replaceAttempt) { state.run.run_attempt++; fs.writeFileSync(file, JSON.stringify(state)); }
}
else {
 const body = JSON.parse(fs.readFileSync(0, 'utf8')).body;
 state.writes.push(method);
 if (method === 'POST') state.comments.push({ id: 10, user: { login: 'github-actions[bot]', type: 'Bot' }, body });
 else state.comments[0].body = body;
 fs.writeFileSync(file, JSON.stringify(state));
 result = {};
}
process.stdout.write(JSON.stringify(result));
`,
      { mode: 0o700 },
    );
    const env = {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: temp,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      RUNNER_TEMP: runTemp,
      GITHUB_REPOSITORY: repository,
      GITHUB_OUTPUT: join(temp, "fresh-output"),
      CONFIDENTIALITY_BATCH_ID: "synthetic-publication",
    };
    const execute = (bin, args) => {
      const result = spawnSync(bin, args, {
        cwd: project,
        env,
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return result;
    };
    execute("git", ["init", "--quiet"]);
    execute("git", ["config", "user.name", "Synthetic reviewer"]);
    execute("git", [
      "config",
      "user.email",
      "synthetic@users.noreply.github.com",
    ]);
    execute("git", ["config", "user.useConfigOnly", "true"]);
    execute(process.execPath, [
      "scripts/install-confidentiality-hooks.mjs",
      "--confirm-current-identity-approved",
    ]);
    execute(process.execPath, ["scripts/cursor-review.mjs", "fresh"]);
    assert.equal(readFileSync(env.GITHUB_OUTPUT, "utf8"), "ready=true\n");
    execute(process.execPath, ["scripts/cursor-review.mjs", "publish"]);
    execute(process.execPath, ["scripts/cursor-review.mjs", "publish"]);
    let saved = JSON.parse(readFileSync(state, "utf8"));
    assert.deepEqual(saved.writes, ["POST", "PATCH"]);
    assert.equal(saved.comments.length, 1);
    saved.pr.head.sha = base;
    writeFileSync(state, JSON.stringify(saved));
    writeFileSync(env.GITHUB_OUTPUT, "");
    execute(process.execPath, ["scripts/cursor-review.mjs", "fresh"]);
    execute(process.execPath, ["scripts/cursor-review.mjs", "publish"]);
    assert.equal(readFileSync(env.GITHUB_OUTPUT, "utf8"), "");
    saved = JSON.parse(readFileSync(state, "utf8"));
    assert.deepEqual(saved.writes, ["POST", "PATCH"]);
    const ciPacket = {
      ...packet,
      kind: "ci",
      manualCI: true,
      runId: 12,
      attempt: 1,
      baseRef: "claude/media",
      headBranch: "claude/child",
    };
    saved.pr = {
      ...pr,
      base: { ...pr.base, ref: ciPacket.baseRef },
      head: { ...pr.head, sha: head, ref: ciPacket.headBranch },
    };
    saved.run = {
      ...run,
      event: "workflow_dispatch",
      repository: { full_name: repository },
      head_branch: ciPacket.headBranch,
      pull_requests: [{ number: 7, head: { sha: head } }],
    };
    writeFileSync(state, JSON.stringify(saved));
    writeFileSync(join(directory, "context.json"), JSON.stringify(ciPacket));
    execute(process.execPath, ["scripts/cursor-review.mjs", "fresh"]);
    execute(process.execPath, ["scripts/cursor-review.mjs", "publish"]);
    saved = JSON.parse(readFileSync(state, "utf8"));
    assert.deepEqual(saved.writes, ["POST", "PATCH", "POST"]);
    saved.replaceAttempt = true;
    writeFileSync(state, JSON.stringify(saved));
    execute(process.execPath, ["scripts/cursor-review.mjs", "publish"]);
    saved = JSON.parse(readFileSync(state, "utf8"));
    assert.equal(saved.run.run_attempt, 2);
    assert.deepEqual(saved.writes, ["POST", "PATCH", "POST"]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("parameterized models reject malformed input and unconfirmed or downgraded selections", () => {
  const selection = parseModelSelection(
    "grok-4.7[context=500k,reasoning_effort=xhigh,fast=true]",
  );
  assert.deepEqual(
    parseModelSelection("grok-4.7[context=500k,effort=xhigh,fast=true]"),
    selection,
  );
  assert.throws(() =>
    parseModelSelection("grok-4.7[effort=high,reasoning_effort=xhigh]"),
  );
  const configuration = {
    selectedModel: {
      modelId: "grok-4.7",
      parameters: [
        { id: "context", value: "500k" },
        { id: "reasoning_effort", value: "xhigh" },
        { id: "fast", value: "true" },
      ],
    },
  };
  assert.deepEqual(
    confirmModelSelection(selection, { ...configuration, maxMode: true }),
    {
      modelId: "grok-4.7",
      context: "500k",
      reasoning_effort: "xhigh",
      fast: "true",
      maxMode: true,
    },
  );
  confirmModelSelection(parseModelSelection("composer-2.5"), {});
  assert.throws(() => confirmModelSelection(selection, {}));
  for (const [index, value] of [
    [0, "256k"],
    [1, "high"],
    [2, "false"],
  ]) {
    const changed = JSON.parse(JSON.stringify(configuration));
    changed.selectedModel.parameters[index].value = value;
    assert.throws(() => confirmModelSelection(selection, changed));
  }
  assert.throws(() =>
    confirmModelSelection(selection, {
      selectedModel: { ...configuration.selectedModel, modelId: "other" },
    }),
  );
  for (const invalid of [
    "grok-4.7[context=500k,context=256k]",
    "grok-4.7[unknown=true]",
    "grok-4.7[fast=true=false]",
    "grok-4.7[effort=extra high]",
    "grok-4.7[fast=yes]",
    "grok-4.7[context=500k];echo",
  ])
    assert.throws(() => parseModelSelection(invalid));
});

test("CLI diagnostics emit only fixed failure categories without raw values", () => {
  for (const [stderr, category] of [
    ["Invalid model parameter: context 500k", "CURSOR_MODEL_REJECTED"],
    ["model unavailable for this account", "CURSOR_MODEL_REJECTED"],
    [
      "Cannot use this model: grok-4.7. Available models: composer-2.5",
      "CURSOR_MODEL_REJECTED",
    ],
    ["You have exceeded your quota", "CURSOR_USAGE_LIMIT"],
    [
      "unauthenticated; private-diagnostic-must-not-escape",
      "CURSOR_AUTHENTICATION",
    ],
    ["private-diagnostic-must-not-escape", "CURSOR_COMMAND_FAILED"],
  ])
    assert.equal(cursorFailure({ stderr }), category);
  assert.equal(
    cursorFailure({ error: { code: "ETIMEDOUT" } }),
    "CURSOR_TIMEOUT",
  );
});

test("model inventory publishes only scoped IDs and known parameter values", () => {
  const inventory = modelInventory(
    "Available models\n\u001b[32mgrok-4.7-xhigh-fast\u001b[0m - Grok\ngrok-4.7 - Grok\nother-model - private-name\n",
    {
      items: [
        {
          id: "grok-4.7",
          description: "private-diagnostic-must-not-escape",
          parameters: [
            {
              id: "context",
              values: [{ value: "500k" }, { value: "private-value" }],
            },
            { id: "private-field", values: [{ value: "private-value" }] },
          ],
          variants: [
            {
              params: [
                { id: "context", value: "500k" },
                { id: "reasoning_effort", value: "xhigh" },
                { id: "fast", value: "true" },
                { id: "credential", value: "private-value" },
              ],
            },
          ],
        },
      ],
    },
  );
  assert.deepEqual(inventory.cliModelIds, ["grok-4.7-xhigh-fast", "grok-4.7"]);
  assert.deepEqual(inventory.cloudModel.parameters, [
    { id: "context", values: ["500k"] },
  ]);
  assert.equal(inventory.cloudModel.variants[0].length, 3);
  assert.doesNotMatch(
    JSON.stringify(inventory),
    /private|credential|other-model/u,
  );
  assert.deepEqual(modelInventory("", { items: [] }), {
    cliModelIds: [],
    cloudModel: null,
  });
});

test("catalog size is capped while reading and an oversized body is cancelled", async () => {
  let cancelled = false;
  const response = {
    body: new globalThis.ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.alloc(5));
        controller.enqueue(Buffer.alloc(5));
      },
      cancel() {
        cancelled = true;
      },
    }),
  };
  await assert.rejects(boundedBody(response, 8), /CATALOG_TOO_LARGE/u);
  assert.equal(cancelled, true);
  const small = {
    body: new globalThis.ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from("{}"));
        controller.close();
      },
    }),
  };
  assert.equal(await boundedBody(small), "{}");
});

test("manual CI diagnosis binds a stacked PR to its exact canonical run and attempt", () => {
  const event = {
    inputs: {
      operation: "diagnose-ci",
      pr: "7",
      ci_run: "12",
      ci_attempt: "1",
      expected_head: head,
      base_ref: "claude/media",
    },
  };
  const target = {
    ...selectEvent("workflow_dispatch", event, repository),
    repository,
    headBranch: "claude/media-child",
    base,
  };
  const stacked = {
    ...pr,
    base: { ...pr.base, ref: "claude/media" },
    head: { ...pr.head, ref: "claude/media-child" },
  };
  const manualRun = {
    ...run,
    id: 12,
    run_attempt: 1,
    event: "workflow_dispatch",
    repository: { full_name: repository },
    head_branch: "claude/media-child",
    pull_requests: [{ number: 7, head: { sha: head } }],
  };
  assert.equal(eligiblePR(stacked, repository, head), false);
  assert.equal(eligiblePR(stacked, repository, head, target), true);
  assert.equal(currentRun(manualRun, target), true);
  for (const update of [
    { run_attempt: 2 },
    { head_sha: base },
    { path: ".github/workflows/other.yml" },
    { event: "push" },
    { name: "Other" },
    { head_branch: "other" },
    { repository: { full_name: "other/project" } },
    { pull_requests: [] },
  ])
    assert.equal(currentRun({ ...manualRun, ...update }, target), false);
  assert.equal(
    eligiblePR(
      { ...stacked, base: { ...stacked.base, sha: head } },
      repository,
      head,
      target,
    ),
    false,
  );
  assert.equal(
    eligiblePR(
      { ...stacked, base: { ...stacked.base, ref: "other" } },
      repository,
      head,
      target,
    ),
    false,
  );
  assert.equal(
    selectEvent(
      "workflow_run",
      { action: "completed", workflow_run: manualRun },
      repository,
    ),
    null,
  );
  assert.throws(
    () =>
      selectEvent(
        "workflow_dispatch",
        { inputs: { ...event.inputs, ci_attempt: "" } },
        repository,
      ),
    /INVALID_CI_TARGET/u,
  );
});

test("manual model metadata works while paused but only for trusted main dispatch", async () => {
  const temp = mkdtempSync(join(tmpdir(), "cursor-models-test-"));
  try {
    const event = join(temp, "event.json");
    const output = join(temp, "output");
    writeFileSync(
      event,
      JSON.stringify({ inputs: { operation: "inspect-models" } }),
    );
    writeFileSync(output, "");
    const env = {
      RUNNER_TEMP: temp,
      GITHUB_EVENT_PATH: event,
      GITHUB_OUTPUT: output,
      GITHUB_REPOSITORY: repository,
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF: "refs/heads/untrusted",
      CURSOR_AUTOMATION_ENABLED: "false",
    };
    await main("prepare", env);
    await main("models", env); // Must return without accessing key, CLI or network.
    assert.equal(readFileSync(output, "utf8"), "");
    await main("prepare", { ...env, GITHUB_REF: "refs/heads/main" });
    assert.equal(readFileSync(output, "utf8"), "models=true\n");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("inference passes exact model and evidence on stdin, rejects hidden parameter fallback and conceals raw errors", () => {
  const temp = mkdtempSync(join(tmpdir(), "cursor-inference-test-"));
  try {
    const directory = join(temp, "cursor-review");
    mkdirSync(directory);
    writeFileSync(join(directory, "context.json"), JSON.stringify(packet));
    const stub = join(temp, "agent");
    writeFileSync(
      stub,
      `#!${process.execPath}
const fs = require('node:fs');
const input = fs.readFileSync(0, 'utf8');
if (!input.includes('${head}') || !process.argv.includes('stream-json') || !process.argv.includes('--stream-partial-output') || process.env.GH_TOKEN || process.argv.includes('--force') || process.argv.includes('--approve-mcps') || process.argv[process.argv.indexOf('--mode') + 1] !== 'ask') process.exit(2);
if (process.argv[process.argv.indexOf('--model') + 1] !== 'grok-4.7[context=500k,reasoning_effort=xhigh,fast=true]') process.exit(3);
const configPath = process.env.CURSOR_CONFIG_DIR + '/cli-config.json';
const configuration = JSON.parse(fs.readFileSync(configPath, 'utf8'));
configuration.selectedModel = { modelId: 'grok-4.7', parameters: [{ id: 'context', value: '500k' }, { id: 'reasoning_effort', value: 'xhigh' }, { id: 'fast', value: 'true' }] };
configuration.maxMode = true;
fs.writeFileSync(configPath, JSON.stringify(configuration));
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: ${JSON.stringify(JSON.stringify(clean))} }));
`,
      { mode: 0o700 },
    );
    const env = {
      PATH: process.env.PATH,
      RUNNER_TEMP: temp,
      CURSOR_AGENT_BIN: stub,
      CURSOR_API_KEY: "test-only",
      CURSOR_MODEL: "grok-4.7[context=500k,reasoning_effort=xhigh,fast=true]",
      GH_TOKEN: "test-only",
    };
    const script = resolve(import.meta.dirname, "cursor-review.mjs");
    let result = spawnSync(process.execPath, [script, "analyze"], {
      env,
      encoding: "utf8",
    });
    assert.equal(result.status, 0);
    assert.equal(
      JSON.parse(readFileSync(join(directory, "report.json"), "utf8"))
        .assessment,
      "no_findings",
    );
    const successful = JSON.parse(
      readFileSync(join(directory, "report.json"), "utf8"),
    );
    assert.equal(successful.model, env.CURSOR_MODEL);
    assert.deepEqual(successful.effectiveSelection, {
      modelId: "grok-4.7",
      context: "500k",
      reasoning_effort: "xhigh",
      fast: "true",
      maxMode: true,
    });
    assert.match(renderReport(packet, successful), /Configured selection:/u);
    assert.match(
      renderReport(packet, successful),
      /Effective selection \(fresh CLI configuration after inference\):/u,
    );
    writeFileSync(
      stub,
      readFileSync(stub, "utf8").replace(
        JSON.stringify(JSON.stringify(clean)),
        JSON.stringify(JSON.stringify({ ...clean, assessment: "findings" })),
      ),
    );
    result = spawnSync(process.execPath, [script, "analyze"], {
      env,
      encoding: "utf8",
    });
    assert.equal(result.status, 0);
    const normalized = JSON.parse(
      readFileSync(join(directory, "report.json"), "utf8"),
    );
    assert.equal(normalized.assessment, "incomplete");
    assert.deepEqual(
      normalized.effectiveSelection,
      successful.effectiveSelection,
    );
    assert.match(renderReport(packet, normalized), /label disagreed/u);
    writeFileSync(
      stub,
      readFileSync(stub, "utf8").replace("value: '500k'", "value: '256k'"),
    );
    result = spawnSync(process.execPath, [script, "analyze"], {
      env,
      encoding: "utf8",
    });
    assert.equal(result.status, 0);
    const downgraded = JSON.parse(
      readFileSync(join(directory, "report.json"), "utf8"),
    );
    assert.equal(downgraded.assessment, "unavailable");
    assert.match(downgraded.summary, /MODEL_SELECTION_NOT_CONFIRMED/u);
    writeFileSync(
      stub,
      `#!${process.execPath}\nprocess.stderr.write('raw-diagnostic-must-not-escape'); process.exit(1);`,
      { mode: 0o700 },
    );
    result = spawnSync(process.execPath, [script, "analyze"], {
      env,
      encoding: "utf8",
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout + result.stderr, "");
    const report = readFileSync(join(directory, "report.json"), "utf8");
    assert.equal(JSON.parse(report).assessment, "unavailable");
    assert.ok(!report.includes("raw-diagnostic-must-not-escape"));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("real stage process collects immutable evidence; missing key produces unavailable without raw output", () => {
  const temp = mkdtempSync(join(tmpdir(), "cursor-review-test-"));
  try {
    const bin = join(temp, "bin");
    mkdirSync(bin);
    // Fixture CLI returns only synthetic API data; no network or real credentials.
    const responses = {
      [`repos/${repository}/pulls/7`]: { ...pr, changed_files: 101 },
      [`repos/${repository}/pulls/7/files?per_page=100`]: [
        {
          filename: "src/example.js",
          status: "modified",
          patch: "+example();",
          sha: base,
        },
      ],
      [`repos/${repository}/git/blobs/${base}`]: {
        size: 10,
        encoding: "base64",
        content: Buffer.from("example();").toString("base64"),
      },
    };
    writeFileSync(
      join(bin, "gh"),
      `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(${JSON.stringify(responses)}[process.argv[5]]));`,
      { mode: 0o700 },
    );
    const event = join(temp, "event.json");
    writeFileSync(
      event,
      JSON.stringify({ inputs: { pr: "7", operation: "review" } }),
    );
    const output = join(temp, "output");
    const env = {
      PATH: `${bin}:${process.env.PATH}`,
      RUNNER_TEMP: temp,
      GITHUB_REPOSITORY: repository,
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF: "refs/heads/main",
      GITHUB_EVENT_PATH: event,
      GITHUB_OUTPUT: output,
    };
    const script = resolve(import.meta.dirname, "cursor-review.mjs");
    const prepared = spawnSync(process.execPath, [script, "prepare"], {
      env,
      encoding: "utf8",
    });
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.equal(readFileSync(output, "utf8"), "ready=true\ninference=true\n");
    const collected = JSON.parse(
      readFileSync(join(temp, "cursor-review/context.json"), "utf8"),
    );
    assert.equal(collected.files[0].source, "example();");
    assert.equal(collected.head, head);
    assert.ok(
      collected.omissions.some(
        (value) =>
          value ===
          "Changed-file listing limited: 100 additional files not retrieved",
      ),
    );
    const analyzed = spawnSync(process.execPath, [script, "analyze"], {
      env,
      encoding: "utf8",
    });
    assert.equal(analyzed.status, 0);
    assert.equal(analyzed.stdout, "");
    const report = JSON.parse(
      readFileSync(join(temp, "cursor-review/report.json"), "utf8"),
    );
    assert.equal(report.assessment, "unavailable");
    assert.match(report.summary, /not configured/u);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("trusted question syntax separates human comments, machine dispatch, and bot replies", () => {
  const event = {
    action: "created",
    issue: { number: 7, pull_request: {} },
    sender: { login: "owner" },
    comment: {
      id: 8,
      user: { login: "owner", type: "User" },
      body: "@cursor reply-to:123 继续核对缺少的调用点。",
    },
  };
  const q = questionInput("issue_comment", event);
  assert.equal(q.question, "继续核对缺少的调用点。");
  assert.equal(q.replyTo, 123);
  assert.equal(q.actor, "owner");
  assert.equal(q.commentHash.length, 64);
  assert.equal(
    questionInput("issue_comment", { ...event, action: "edited" }),
    null,
  );
  assert.equal(
    questionInput("issue_comment", { ...event, issue: { number: 7 } }),
    null,
  );
  assert.equal(
    questionInput("issue_comment", {
      ...event,
      comment: { ...event.comment, user: { login: "owner", type: "Bot" } },
    }),
    null,
  );
  assert.equal(
    questionInput("issue_comment", { ...event, sender: { login: "other" } }),
    null,
  );
  const manual = {
    inputs: {
      operation: "question",
      pr: "7",
      expected_head: head,
      question_request: JSON.stringify({
        question: "Find the missing source independently",
        replyTo: 123,
      }),
    },
  };
  assert.equal(questionInput("workflow_dispatch", manual).head, head);
  assert.equal(questionInput("workflow_dispatch", manual).replyTo, 123);
  assert.throws(
    () =>
      questionInput("workflow_dispatch", {
        inputs: { ...manual.inputs, expected_head: "" },
      }),
    /QUESTION_HEAD_REQUIRED/u,
  );
});

for (const [label, body, usable] of [
  [
    "natural English",
    "The source shows a delayed restoration; this is a hypothesis, not a PASS.",
    true,
  ],
  ["natural Chinese", "已读取相关源码。当前证据不能证明运行通过。", true],
  ["whitespace only", "   \n", false],
  [
    "malformed optional JSON",
    "{ answer: this is a useful unstructured observation",
    true,
  ],
  [
    "invalid optional citation",
    JSON.stringify({
      ...clean,
      citations: [{ id: "invented", quote: "invented" }],
    }),
    true,
  ],
  ["unsafe scalar", "token=" + "ghp_" + "A".repeat(36), false],
  ["cookie-only", "Cookie: session=" + ["opaque", "Value"].join(""), false],
  [
    "mixed diagnostic and credential",
    "Inspect apps/web/features/home/home-feed.ts:18. token=" +
      "ghp_" +
      "A".repeat(36) +
      "\nThe assertion needs investigation.",
    true,
  ],
  [
    "quoted masked credential with useful prose",
    'Inspect password="' +
      ["opaque", "Value"].join("") +
      '" then await line 18.',
    true,
  ],
  [
    "source path and GitHub URL",
    "Inspect apps/web/features/home/home-feed.ts and https://github.com/example/repo/blob/main/apps/web/features/home/home-feed.ts",
    true,
  ],
])
  test(`official-direct configuration retains ${label} independently of optional schema`, async () => {
    const temp = mkdtempSync(join(tmpdir(), "cursor-natural-"));
    try {
      const directory = join(temp, "cursor-review");
      mkdirSync(directory);
      const target = {
        ...packet,
        files: [],
        automatic: true,
        autonomous: true,
      };
      writeFileSync(join(directory, "context.json"), JSON.stringify(target));
      writeFileSync(
        join(directory, "automatic-receipt.json"),
        JSON.stringify({ target, actualInvocations: 0 }),
      );
      const stub = join(temp, "agent");
      writeFileSync(
        stub,
        `#!${process.execPath}
const fs = require('node:fs');
const input = fs.readFileSync(0,'utf8');
if (!input.includes('independently') || !input.includes('downloads/') || process.env.GH_TOKEN || process.env.ACTIONS_RUNTIME_TOKEN || !process.argv.includes('--approve-mcps') || !process.argv.includes('--force') || process.argv.includes('--mode')) process.exit(2);
const mcp = JSON.parse(fs.readFileSync('.cursor/mcp.json','utf8')).mcpServers.github;
if (mcp.command !== '/official/github-mcp-server' || mcp.type !== 'stdio' || mcp.args.join(' ') !== 'stdio --read-only --toolsets=repos,issues,pull_requests,actions') process.exit(3);
const expectedReference = '$'+'{env:CURSOR_GITHUB_READ_TOKEN}';
if (mcp.env.GITHUB_PERSONAL_ACCESS_TOKEN !== expectedReference || process.env.CURSOR_GITHUB_READ_TOKEN !== 'synthetic-read-token') process.exit(4);
const p = process.env.CURSOR_CONFIG_DIR + '/cli-config.json';
const config = JSON.parse(fs.readFileSync(p,'utf8'));
const project = JSON.parse(fs.readFileSync('.cursor/cli.json','utf8'));
if (config.version !== 1 || config.editor.vimMode !== false || Object.keys(project).join() !== 'permissions' || JSON.stringify(project.permissions) !== JSON.stringify(config.permissions)) process.exit(5);
if (!['Read(**)','Mcp(github:*)','WebFetch(*)','Shell(*)'].every(rule => config.permissions.allow.includes(rule)) || config.permissions.deny.includes('Shell(*)') || !['Write(**)','Read(**/.env*)','Read(**/.cursor/**)','Read(**/.ssh/**)','Read(**/.aws/**)'].every(rule => config.permissions.deny.includes(rule)) || !fs.statSync('downloads').isDirectory()) process.exit(6);
config.selectedModel = { modelId:'grok-4.7', parameters:[{id:'context',value:'500k'},{id:'reasoning_effort',value:'xhigh'},{id:'fast',value:'true'}] }; config.maxMode = true;
fs.writeFileSync(p,JSON.stringify(config));
console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:${JSON.stringify(body)}}));
`,
        { mode: 0o700 },
      );
      await main("analyze", {
        PATH: process.env.PATH,
        RUNNER_TEMP: temp,
        GITHUB_RUN_ID: "100",
        GITHUB_RUN_ATTEMPT: "1",
        CURSOR_MODEL: "grok-4.7[context=500k,reasoning_effort=xhigh,fast=true]",
        CURSOR_API_KEY: "synthetic-key",
        GH_TOKEN: "synthetic-publisher-token",
        CURSOR_AUTONOMOUS: "true",
        CURSOR_GITHUB_READ_TOKEN: "synthetic-read-token",
        CURSOR_GITHUB_MCP_BIN: "/official/github-mcp-server",
        CURSOR_AGENT_BIN: stub,
      });
      const report = JSON.parse(
        readFileSync(join(directory, "report.json"), "utf8"),
      );
      const retained = JSON.parse(
        readFileSync(join(directory, "model-response.json"), "utf8"),
      );
      await main("transfer", { RUNNER_TEMP: temp });
      assert.equal(
        readFileSync(join(directory, "transfer/model-response.json"), "utf8"),
        readFileSync(join(directory, "model-response.json"), "utf8"),
      );
      assert.equal(report.transportCompleted, true);
      assert.equal(report.actualInvocations, 1);
      assert.equal(report.effectiveSelection.maxMode, true);
      assert.deepEqual(report.effectiveInvestigation, {
        requestedMode: "agent",
        force: true,
        configurationOnly: true,
        globalPermissions: agentConfiguration({ autonomous: true }).permissions,
        projectPermissions: agentConfiguration({ autonomous: true })
          .permissions,
      });
      assert.equal(
        JSON.stringify(report).includes("synthetic-read-token"),
        false,
      );
      assert.equal(JSON.stringify(report).includes("synthetic-key"), false);
      assert.deepEqual(
        JSON.parse(
          readFileSync(join(directory, "transfer/report.json"), "utf8"),
        ).effectiveInvestigation,
        report.effectiveInvestigation,
      );
      assert.equal(
        automaticResponseState(target, report).responseAccepted,
        usable,
      );
      assert.equal(
        automaticResponseState(target, report).coverageComplete,
        false,
      );
      assert.equal(automaticResponseState(target, report).cleanVerdict, false);
      if (usable) {
        assert.equal(report.answerRetained, true);
        assert.ok(report.answerText.length);
        assert.equal(
          retained.redactions,
          [
            "mixed diagnostic and credential",
            "quoted masked credential with useful prose",
          ].includes(label)
            ? 1
            : 0,
        );
        assert.equal(report.answerUsable, true);
        assert.deepEqual(report.redactionCounts, retained.redactionCounts);
        if (label === "mixed diagnostic and credential") {
          assert.match(
            report.answerText,
            /Inspect apps\/web\/features\/home\/home-feed.ts:18/u,
          );
          assert.ok(!JSON.stringify(report).includes(body));
        }
      } else {
        if (label === "whitespace only") {
          assert.equal(report.answerRetained, false);
          assert.equal(retained.redactions, 0);
        } else {
          assert.ok(retained.redactions > 0);
          assert.ok(!JSON.stringify(report).includes(body));
        }
      }
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

test("workflow separates read-only inference from publication and restores only same-run named records", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/cursor-review.yml", import.meta.url),
    "utf8",
  );
  const analyze = workflow.slice(
    workflow.indexOf("  analyze:\n"),
    workflow.indexOf("  publish:\n"),
  );
  const publish = workflow.slice(workflow.indexOf("  publish:\n"));
  assert.equal((workflow.match(/queue: max/gu) ?? []).length, 2);
  assert.doesNotMatch(analyze, /concurrency:/u);
  assert.match(analyze, /github.run_attempt == 1/u);
  assert.match(publish, /if: always\(\) && needs.prepare.outputs.transfer/u);
  assert.match(analyze, /pull-requests: read/u);
  assert.doesNotMatch(analyze, /pull-requests: write|issues: write/u);
  assert.doesNotMatch(
    publish,
    /secrets.CURSOR_API_KEY|cursor-review.mjs analyze|CURSOR_GITHUB_READ_TOKEN/u,
  );
  assert.match(workflow, /issue_comment:\n {4}types: \[created\]/u);
  assert.match(workflow, /github-mcp-server_Linux_x86_64/u);
  assert.doesNotMatch(
    workflow,
    /cursor-github-mcp|cursor-investigation|run-id:|repository:/u,
  );
  assert.match(
    publish,
    /cursor-analysis-\$\{\{ github.run_id \}\}-\$\{\{ github.run_attempt \}\}/u,
  );
});

test("autonomous question admission, linked reply, duplicate suppression and edited-comment freshness use existing ledger", () => {
  const temp = mkdtempSync(join(tmpdir(), "cursor-question-host-"));
  const project = join(temp, "project"),
    bin = join(temp, "bin"),
    runner = join(temp, "runner");
  mkdirSync(join(project, "scripts"), { recursive: true });
  mkdirSync(bin);
  mkdirSync(runner);
  try {
    for (const name of [
      "cursor-review.mjs",
      "cursor-response.mjs",
      "cursor-automation.mjs",
      "cursor-stream.mjs",
      "confidentiality-scan.mjs",
      "install-confidentiality-hooks.mjs",
    ])
      cpSync(
        new URL(`./${name}`, import.meta.url),
        join(project, "scripts", name),
      );
    cpSync(
      new URL("../.githooks", import.meta.url),
      join(project, ".githooks"),
      { recursive: true },
    );
    const statePath = join(temp, "state.json"),
      eventPath = join(temp, "event.json");
    const human = {
      id: 91,
      user: { login: "owner", type: "User" },
      body: "@cursor Find the missing caller independently.",
      issue_url: `https://api.github.com/repos/${repository}/issues/7`,
    };
    writeFileSync(
      statePath,
      JSON.stringify({ pr, comments: [human], writes: [], permission: "read" }),
    );
    writeFileSync(
      eventPath,
      JSON.stringify({
        action: "created",
        issue: { number: 7, pull_request: {} },
        sender: { login: "owner" },
        comment: human,
      }),
    );
    writeFileSync(
      join(bin, "gh"),
      `#!${process.execPath}
const fs=require('node:fs'), file=${JSON.stringify(statePath)};
const s=JSON.parse(fs.readFileSync(file,'utf8')), method=process.argv[4], path=process.argv[5]; let result;
if(method==='GET') {
 if(path.includes('/collaborators/')) result={permission:s.permission};
 else if(path.includes('/pulls/')) result=s.pr;
 else if(path.includes('/issues/comments/')) result=s.comments.find(c=>c.id===Number(path.split('/').at(-1)));
 else if(path.includes('/issues/7/comments?')) result=s.comments;
 else process.exit(8);
} else {
 const body=JSON.parse(fs.readFileSync(0,'utf8')).body;
 let c=method==='PATCH'?s.comments.find(c=>c.id===Number(path.split('/').at(-1))):null;
 if(!c){c={id:100+s.comments.length,user:{login:'github-actions[bot]',type:'Bot'}};s.comments.push(c);}
 c.body=body;c.html_url='https://github.com/${repository}/pull/7#issuecomment-'+c.id;
 s.writes.push({method,id:c.id});result=c;fs.writeFileSync(file,JSON.stringify(s));
}
if(!result)process.exit(9);process.stdout.write(JSON.stringify(result));
`,
      { mode: 0o700 },
    );
    const env = {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: temp,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      RUNNER_TEMP: runner,
      GITHUB_REPOSITORY: repository,
      GITHUB_EVENT_NAME: "issue_comment",
      GITHUB_REF: "refs/heads/main",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_OUTPUT: join(temp, "output"),
      GITHUB_RUN_ID: "200",
      GITHUB_RUN_ATTEMPT: "1",
      CURSOR_AUTOMATION_ENABLED: "true",
      CURSOR_AUTONOMOUS: "true",
      CONFIDENTIALITY_BATCH_ID: "synthetic-question",
    };
    const run = (args, extra = {}) => {
      const r = spawnSync(args[0], args.slice(1), {
        cwd: project,
        env: { ...env, ...extra },
        encoding: "utf8",
      });
      assert.equal(r.status, 0, r.stderr || r.stdout);
      return r;
    };
    run(["git", "init", "--quiet"]);
    run(["git", "config", "user.name", "Synthetic reviewer"]);
    run(["git", "config", "user.email", "synthetic@users.noreply.github.com"]);
    run(["git", "config", "user.useConfigOnly", "true"]);
    run([
      process.execPath,
      "scripts/install-confidentiality-hooks.mjs",
      "--confirm-current-identity-approved",
    ]);
    run([process.execPath, "scripts/cursor-review.mjs", "prepare"]);
    let saved = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(saved.writes.length, 0); // Read-only collaborator cannot consume a call.
    saved.permission = "write";
    writeFileSync(statePath, JSON.stringify(saved));
    run([process.execPath, "scripts/cursor-review.mjs", "prepare"]);
    const directory = join(runner, "cursor-review"),
      target = JSON.parse(
        readFileSync(join(directory, "context.json"), "utf8"),
      );
    assert.equal(target.autonomous, true);
    assert.deepEqual(target.files, []);
    assert.deepEqual(target.failedJobs, []);
    run([process.execPath, "scripts/cursor-review.mjs", "fresh"]);
    assert.match(readFileSync(env.GITHUB_OUTPUT, "utf8"), /ready=true/u);
    const report = {
      assessment: "incomplete",
      summary: "Actual safe reply",
      findings: [],
      answerText: "I read the helper; the caller remains uncertain.",
      answerRetained: true,
      transportCompleted: true,
      redactions: 0,
      model: "grok-4.7[context=500k,reasoning_effort=xhigh,fast=true]",
      actualInvocations: 1,
      effectiveSelection: {
        modelId: "grok-4.7",
        context: "500k",
        reasoning_effort: "xhigh",
        fast: "true",
        maxMode: true,
      },
      structuredValidation: "RESPONSE_JSON_INVALID",
    };
    writeFileSync(join(directory, "report.json"), JSON.stringify(report));
    run([process.execPath, "scripts/cursor-review.mjs", "publish"]);
    saved = JSON.parse(readFileSync(statePath, "utf8"));
    const reply = saved.comments.find((c) =>
      c.body.startsWith("<!-- cursor-answer:"),
    );
    assert.ok(reply.body.includes(report.answerText));
    assert.ok(reply.body.includes("#issuecomment-91"));
    assert.ok(
      saved.comments
        .find((c) => c.body.startsWith("<!-- cursor-automation-summary:"))
        .body.includes(reply.html_url),
    );
    const priorWrites = saved.writes.length;
    const duplicate = join(temp, "duplicate");
    mkdirSync(duplicate);
    run([process.execPath, "scripts/cursor-review.mjs", "prepare"], {
      RUNNER_TEMP: duplicate,
      GITHUB_RUN_ID: "201",
    });
    assert.equal(
      JSON.parse(
        readFileSync(
          join(duplicate, "cursor-review/automatic-receipt.json"),
          "utf8",
        ),
      ).status,
      "DUPLICATE_SUPPRESSED",
    );
    assert.equal(
      JSON.parse(readFileSync(statePath, "utf8")).writes.length,
      priorWrites,
    );
    // Explicit machine follow-up carries this answer, not a hidden session or a fresh first review.
    writeFileSync(
      eventPath,
      JSON.stringify({
        inputs: {
          operation: "question",
          pr: "7",
          expected_head: head,
          question_request: JSON.stringify({
            question: "Read the caller and resolve that uncertainty",
            replyTo: reply.id,
          }),
        },
      }),
    );
    const next = join(temp, "next");
    mkdirSync(next);
    run([process.execPath, "scripts/cursor-review.mjs", "prepare"], {
      RUNNER_TEMP: next,
      GITHUB_RUN_ID: "202",
      GITHUB_EVENT_NAME: "workflow_dispatch",
    });
    const follow = JSON.parse(
      readFileSync(join(next, "cursor-review/context.json"), "utf8"),
    );
    assert.ok(follow.priorAnswer.includes(report.answerText));
    assert.equal(follow.priorAnswerURL, reply.html_url);
    assert.notEqual(follow.questionDigest, target.questionDigest);
    // A changed original comment invalidates its claim before inference/publication.
    saved = JSON.parse(readFileSync(statePath, "utf8"));
    saved.comments[0].body += " edited";
    writeFileSync(statePath, JSON.stringify(saved));
    writeFileSync(env.GITHUB_OUTPUT, "");
    run([process.execPath, "scripts/cursor-review.mjs", "fresh"]);
    assert.equal(readFileSync(env.GITHUB_OUTPUT, "utf8"), "");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

const sequenceRecord = (digit, ownerRun, status = "claimed", extra = {}) => ({
  key: digit.repeat(64),
  head: "a".repeat(40),
  ownerRun,
  status,
  ...extra,
});
const sequenceComment = (records, human = "Current summary") => ({
  user: { login: "github-actions[bot]", type: "Bot" },
  body: ledgerBody(human, records),
});

test("PR sequence uses append order and excludes every alias of its own invocation", () => {
  const records = [
    sequenceRecord("a", 900),
    sequenceRecord("b", 20),
    sequenceRecord("c", 900),
    sequenceRecord("d", 20),
    sequenceRecord("e", 1),
  ];
  assert.deepEqual(
    earlierClaims(records, { automationKey: "d".repeat(64), ownerRun: 20 }),
    [900],
  );
  assert.throws(
    () =>
      earlierClaims(records, { automationKey: "d".repeat(64), ownerRun: 2 }),
    /CLAIM_LOST/u,
  );
  assert.throws(
    () =>
      earlierClaims([{ ...records[3], status: "answered" }], {
        automationKey: "d".repeat(64),
        ownerRun: 20,
      }),
    /CLAIM_LOST/u,
  );
});

test("next question waits for publication and then loads its newly published prior answer", async () => {
  const previous = sequenceRecord("a", 900),
    own = sequenceRecord("b", 20);
  let comments = [sequenceComment([previous, own])];
  let waits = 0,
    reads = 0;
  const answer = {
    user: { login: "github-actions[bot]", type: "Bot" },
    body: `<!-- cursor-answer:${previous.key} -->\nActual predecessor answer`,
    html_url: "https://github.com/example/project/pull/7#issuecomment-12",
  };
  const result = await waitForPriorAnswer(
    { automationKey: own.key, ownerRun: own.ownerRun, number: 7 },
    repository,
    {
      loadComments: () => comments,
      fresh: () => true,
      loadRun: (id) => {
        reads++;
        assert.equal(id, 900);
        return {
          id,
          repository: { full_name: repository },
          status: "in_progress",
        };
      },
      progress: (id) => assert.equal(id, 900),
      sleep: async () => {
        waits++;
        comments = [
          sequenceComment([{ ...previous, status: "answered" }, own]),
          answer,
        ];
      },
    },
  );
  assert.equal(result.ready, true);
  assert.equal(result.prior, answer);
  assert.deepEqual(result.terminalUnclosed, []);
  assert.equal(waits, 1);
  assert.equal(reads, 1);
});

test("completed orphan is disclosed without modifying its claim or waiting forever", async () => {
  const previous = sequenceRecord("a", 900),
    own = sequenceRecord("b", 20);
  const comments = [sequenceComment([previous, own])];
  const before = JSON.stringify(comments);
  const result = await waitForPriorAnswer(
    { automationKey: own.key, ownerRun: own.ownerRun, number: 7 },
    repository,
    {
      loadComments: () => comments,
      fresh: () => true,
      loadRun: (id) => ({
        id,
        repository: { full_name: repository },
        status: "completed",
      }),
      sleep: () => assert.fail("terminal owner must not wait"),
    },
  );
  assert.deepEqual(result.terminalUnclosed, [900]);
  assert.equal(result.ready, true);
  assert.equal(JSON.stringify(comments), before);
});

test("answer published during terminal-owner check is loaded at readiness boundary", async () => {
  const previous = sequenceRecord("a", 900),
    own = sequenceRecord("b", 20);
  const answer = {
    user: { login: "github-actions[bot]", type: "Bot" },
    body: `<!-- cursor-answer:${previous.key} -->\nLatest`,
  };
  let comments = [sequenceComment([previous, own])];
  const result = await waitForPriorAnswer(
    { automationKey: own.key, ownerRun: own.ownerRun, number: 7 },
    repository,
    {
      loadComments: () => comments,
      fresh: () => true,
      loadRun: (id) => {
        comments = [
          sequenceComment([{ ...previous, status: "answered" }, own]),
          answer,
        ];
        return {
          id,
          repository: { full_name: repository },
          status: "completed",
        };
      },
    },
  );
  assert.equal(result.prior, answer);
  assert.deepEqual(result.terminalUnclosed, []);
});

test("waiting stops when source/comment freshness or claim ownership is lost", async () => {
  const previous = sequenceRecord("a", 900),
    own = sequenceRecord("b", 20);
  let current = true;
  const options = {
    loadComments: () => [sequenceComment([previous, own])],
    fresh: () => current,
    loadRun: (id) => ({
      id,
      repository: { full_name: repository },
      status: "in_progress",
    }),
    progress: () => {},
    sleep: async () => {
      current = false;
    },
  };
  const packet = { automationKey: own.key, ownerRun: own.ownerRun, number: 7 };
  assert.deepEqual(await waitForPriorAnswer(packet, repository, options), {
    ready: false,
  });
  await assert.rejects(
    waitForPriorAnswer(packet, repository, {
      ...options,
      fresh: () => true,
      loadComments: () => [sequenceComment([previous])],
    }),
    /CLAIM_LOST/u,
  );
  await assert.rejects(
    waitForPriorAnswer(packet, repository, {
      ...options,
      fresh: () => true,
      loadRun: (id) => ({
        id,
        repository: { full_name: "other/project" },
        status: "completed",
      }),
    }),
    /PRIOR_INVOCATION_IDENTITY_UNVERIFIED/u,
  );
});

test("another PR's conversation does not wait on claims absent from its ledger", async () => {
  const own = sequenceRecord("c", 30);
  const result = await waitForPriorAnswer(
    { automationKey: own.key, ownerRun: own.ownerRun, number: 8 },
    repository,
    {
      loadComments: () => [sequenceComment([own])],
      fresh: () => true,
      loadRun: () => assert.fail("unrelated PR must not be loaded"),
    },
  );
  assert.equal(result.ready, true);
});

for (const status of ["answered", "metadata", "incomplete", "stale"]) {
  test(`late publication preserves newer ${status} summary and ledger records`, () => {
    const own = sequenceRecord("a", 900),
      newer = sequenceRecord("b", 20, status);
    const state = readLedger([
      sequenceComment([own, newer], "Newer actual outcome"),
    ]);
    assert.equal(
      completionHuman(state, own.key, "Older outcome"),
      "Newer actual outcome",
    );
    const records = finishRecord(state, own.key, own.ownerRun, "incomplete");
    assert.deepEqual(records[1], newer);
    assert.equal(records[0].status, "incomplete");
    const aliasState = readLedger([
      sequenceComment([own, { ...newer, coveredBy: own.key }], "Old summary"),
    ]);
    assert.equal(
      completionHuman(aliasState, own.key, "Own terminal outcome"),
      "Own terminal outcome",
    );
  });
}

test("review analyze refuses workflow reruns before any CLI invocation", async () => {
  const temp = mkdtempSync(join(tmpdir(), "cursor-rerun-"));
  try {
    const directory = join(temp, "cursor-review");
    mkdirSync(directory);
    writeFileSync(
      join(directory, "context.json"),
      JSON.stringify({ ...packet, automatic: true, autonomous: true }),
    );
    await main("analyze", {
      RUNNER_TEMP: temp,
      GITHUB_RUN_ATTEMPT: "2",
      CURSOR_AGENT_BIN: "must-not-run",
    });
    const report = JSON.parse(
      readFileSync(join(directory, "report.json"), "utf8"),
    );
    assert.match(report.summary, /does not repeat/u);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
