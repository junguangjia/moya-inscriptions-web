import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import {
  automaticEvent,
  automaticKey,
  automaticPR,
  automaticRun,
  readLedger,
  claimRecord,
  finishRecord,
  ledgerBody,
  citationEvidence,
  validateCitations,
  selectUnprocessedCI,
  assertRemoteInput,
  publicText,
  coverUnperformedReview,
  sanitizeRemoteProjection,
} from "./cursor-automation.mjs";
import { classifyTask } from "./ci-task-scope.mjs";
const repo = "junguangjia/moya-inscriptions-web";
const head = "a".repeat(40),
  base = "b".repeat(40),
  merge = "c".repeat(40);
const pr = {
  number: 214,
  state: "open",
  head: { sha: head, repo: { full_name: repo } },
  base: { sha: base, ref: "stacked/base", repo: { full_name: repo } },
};
const run = {
  id: 123,
  run_attempt: 1,
  workflow_id: 327712419,
  name: "CI",
  path: ".github/workflows/ci.yml",
  event: "workflow_dispatch",
  head_sha: head,
  head_repository: { full_name: repo },
  repository: { full_name: repo },
  status: "completed",
  conclusion: "failure",
};
const event = (action) =>
  automaticEvent("pull_request_target", { action, pull_request: pr }, repo);
const ci = automaticEvent(
  "workflow_run",
  { action: "completed", workflow_run: run },
  repo,
);

test("same-repository stacked PR aliases share one review; forks and self loops are rejected", () => {
  for (const action of [
    "opened",
    "reopened",
    "synchronize",
    "ready_for_review",
  ]) {
    assert.equal(event(action).head, head);
    assert.equal(
      automaticKey(repo, event(action)),
      automaticKey(repo, event("opened")),
    );
  }
  assert.equal(event("closed"), null);
  assert.equal(event("edited"), null);
  assert.equal(automaticEvent("issue_comment", {}, repo), null);
  assert.equal(
    automaticPR(
      { ...pr, head: { ...pr.head, repo: { full_name: "fork/repo" } } },
      repo,
      event("opened"),
    ),
    false,
  );
  assert.equal(
    automaticPR(pr, repo, { ...event("opened"), head: merge }),
    false,
  );
});
test("merge notification and canonical postmerge CI remain separate, without reviewing an unmerged close", () => {
  const merged = {
    ...pr,
    state: "closed",
    merged: true,
    merge_commit_sha: merge,
    base: { ...pr.base, ref: "main" },
  };
  const target = automaticEvent(
    "pull_request_target",
    { action: "closed", pull_request: merged },
    repo,
  );
  assert.equal(target.metadataOnly, true);
  assert.equal(target.head, merge);
  assert.equal(target.prHead, head);
  assert.equal(
    automaticEvent(
      "pull_request_target",
      { action: "closed", pull_request: { ...merged, merged: false } },
      repo,
    ),
    null,
  );
  assert.equal(automaticPR(merged, repo, { ...target, prHead: base }), false);
  assert.notEqual(
    automaticKey(repo, target),
    automaticKey(repo, { ...target, runId: 123, attempt: 1 }),
  );
});
test("canonical CI supports PR, manual CI and push, but excludes our analysis workflow and stale attempts", () => {
  for (const event of ["pull_request", "workflow_dispatch", "push"])
    assert.ok(
      automaticEvent(
        "workflow_run",
        { action: "completed", workflow_run: { ...run, event } },
        repo,
      ),
    );
  assert.equal(
    automaticEvent(
      "workflow_run",
      { action: "completed", workflow_run: { ...run, name: "Cursor review" } },
      repo,
    ),
    null,
  );
  assert.equal(
    automaticRun(run, { ...ci, repository: repo, workflowId: run.workflow_id }),
    true,
  );
  assert.equal(
    automaticRun({ ...run, run_attempt: 2 }, { ...ci, repository: repo }),
    false,
  );
  assert.notEqual(
    automaticKey(repo, { ...ci, number: 214 }),
    automaticKey(repo, { ...ci, number: 214, attempt: 2 }),
  );
});
test("durable claims suppress duplicates including errors and orphan claims; publisher must own the claim", () => {
  const target = event("opened");
  const claimed = claimRecord({ records: [] }, repo, target, 999);
  for (const status of [
    "claimed",
    "incomplete",
    "accepted",
    "metadata",
    "stale",
  ])
    assert.equal(
      claimRecord(
        { records: [{ ...claimed.records[0], status }] },
        repo,
        target,
        1000,
      ).duplicate,
      true,
    );
  assert.throws(
    () =>
      finishRecord({ records: claimed.records }, claimed.key, 1000, "accepted"),
    /CLAIM_LOST/,
  );
  const records = finishRecord(
    { records: claimed.records },
    claimed.key,
    999,
    "accepted",
  );
  const body = ledgerBody("Human summary", records);
  const state = readLedger([
    { id: 5, body, user: { login: "github-actions[bot]", type: "Bot" } },
  ]);
  assert.deepEqual(state.records, records);
  assert.equal(
    claimRecord(
      state,
      repo,
      { ...target, postMerge: true, head: merge, prHead: head },
      1000,
    ).priorReview,
    claimed.key,
  );
  assert.equal(
    readLedger([{ body, user: { login: "other", type: "User" } }]).comment,
    null,
  );
  assert.throws(
    () =>
      readLedger([
        {
          body: body.replace(/accepted/u, "bogus"),
          user: { login: "github-actions[bot]", type: "Bot" },
        },
      ]),
    /LEDGER_INVALID/,
  );
});
test("overlapping PR aliases recover only unprocessed exact-source canonical CI", () => {
  const target = event("opened");
  const ledger = [
    { key: automaticKey(repo, { ...target, runId: run.id, attempt: 1 }) },
  ];
  assert.equal(selectUnprocessedCI([run], repo, target, ledger), undefined);
  assert.equal(
    selectUnprocessedCI([{ ...run, run_attempt: 2 }], repo, target, ledger)
      .run_attempt,
    2,
  );
  assert.equal(
    selectUnprocessedCI([{ ...run, head_sha: merge }], repo, target, []),
    undefined,
  );
  assert.equal(
    selectUnprocessedCI([{ ...run, status: "in_progress" }], repo, target, []),
    undefined,
  );
});
test("citations bind literal original evidence and exact source/run/attempt; invented quotes cannot pass", () => {
  const packet = {
    repository: repo,
    number: 214,
    head,
    kind: "ci",
    runId: 123,
    attempt: 1,
    files: [],
    failedJobs: [{ logs: "Expected 900; received 0" }],
    omissions: [],
  };
  const evidence = citationEvidence(packet),
    log = evidence.find((e) => e.pointer.endsWith("/logs"));
  const report = {
    citations: [{ id: log.id, quote: "received 0" }],
    findings: [{ citations: [{ id: log.id, quote: "Expected 900" }] }],
  };
  assert.equal(validateCitations(report, evidence).length, 2);
  assert.throws(
    () =>
      validateCitations(
        { ...report, citations: [{ id: log.id, quote: "received 900" }] },
        evidence,
      ),
    /NOT_IN_ORIGINAL/,
  );
  assert.throws(
    () =>
      validateCitations(report, citationEvidence({ ...packet, attempt: 2 })),
    /NOT_IN_ORIGINAL/,
  );
  assert.throws(
    () => validateCitations({ findings: [] }, evidence),
    /INVALID_CITATION/,
  );
});
test("public transport excludes private paths and authorizing URLs without classifying ordinary identifiers as secrets", () => {
  assert.throws(
    () => assertRemoteInput({ nested: ["/Users/example/private.json"] }),
    /NONPUBLIC_REMOTE_INPUT/,
  );
  assert.throws(
    () =>
      assertRemoteInput({
        url: "https://storage.example/file?X-Amz-Signature=synthetic",
      }),
    /NONPUBLIC_REMOTE_INPUT/,
  );
  assert.equal(publicText("/Users/example/a.json"), "[private path omitted]");
  assert.doesNotThrow(() =>
    assertRemoteInput({
      path: "tests/e2e/home.spec.ts",
      sha: head,
      url: "https://github.com/example/repo/actions/runs/123",
    }),
  );
});
test("installed workflow serializes by resolved PR, pins main, and never uploads automatic raw context", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/cursor-review.yml", import.meta.url),
    "utf8",
  );
  assert.match(
    workflow,
    /types: \[opened, reopened, synchronize, ready_for_review, closed\]/u,
  );
  assert.match(
    workflow,
    /group: cursor-\$\{\{ github.repository \}\}-pr-\$\{\{ needs.route.outputs.pr \}\}/u,
  );
  assert.match(workflow, /ref: \$\{\{ needs.route.outputs.trusted \}\}/u);
  assert.match(workflow, /timeout-minutes: 360/u);
  assert.doesNotMatch(workflow, /CURSOR_MODEL:.*composer/u);
  assert.match(workflow, /cursor-review\/remote-output\//u);
  assert.doesNotMatch(workflow, /path:.*cursor-review\/\s*$/mu);
  assert.equal(
    classifyTask([
      "scripts/cursor-automation.mjs",
      "scripts/cursor-automation.test.mjs",
    ]).web,
    false,
  );
});

test("combined CI claim closes its covered review alias without another inference", () => {
  const t = { ...ci, number: 214 };
  const c = claimRecord({ records: [] }, repo, t, 999);
  const review = claimRecord(
    { records: c.records },
    repo,
    event("opened"),
    999,
  );
  const rows = review.records.map((r) =>
    r.key === review.key ? { ...r, coveredBy: c.key } : r,
  );
  const finished = finishRecord({ records: rows }, c.key, 999, "accepted");
  assert.equal(finished.filter((r) => r.status === "accepted").length, 2);
  assert.equal(
    claimRecord({ records: finished }, repo, event("synchronize"), 1000)
      .duplicate,
    true,
  );
});

for (const conclusion of [
  "success",
  "cancelled",
  "skipped",
  "failure",
  "timed_out",
]) {
  test(`CI ${conclusion} arriving first cannot suppress an unperformed PR review`, () => {
    const target = {
      ...ci,
      number: 214,
      conclusion,
      metadataOnly: !["failure", "timed_out"].includes(conclusion),
    };
    const claimed = claimRecord({ records: [] }, repo, target, 999);
    const combined = coverUnperformedReview(claimed, repo, target, 999);
    assert.equal(combined.target.coversReview, true);
    assert.equal(combined.target.metadataOnly, false);
    assert.equal(
      combined.target.kind,
      ["failure", "timed_out"].includes(conclusion) ? "ci" : "review",
    );
    const completed = finishRecord(
      { records: combined.claim.records },
      combined.claim.key,
      999,
      "accepted",
    );
    assert.equal(
      claimRecord({ records: completed }, repo, event("opened"), 1000)
        .duplicate,
      true,
    );
    const next = claimRecord(
      { records: completed },
      repo,
      { ...target, attempt: 2 },
      1000,
    );
    assert.equal(
      coverUnperformedReview(next, repo, { ...target, attempt: 2 }, 1000).target
        .coversReview,
      undefined,
    );
  });
}

test("decoded-scalar redaction preserves quoted JSON source and exact sanitized citations", () => {
  const packet = {
    repository: repo,
    number: 214,
    head,
    kind: "review",
    files: [
      {
        path: "scripts/sample.mjs",
        patch: '+const path = "/Users/example/private.json";',
      },
    ],
    failedJobs: [],
    omissions: [],
  };
  assert.throws(
    () => JSON.parse(publicText(JSON.stringify(packet))),
    SyntaxError,
  );
  const clean = sanitizeRemoteProjection(packet);
  assertRemoteInput(clean);
  assert.equal(
    JSON.parse(JSON.stringify(clean)).files[0].patch,
    '+const path = "[private path omitted]";',
  );
  const evidence = citationEvidence(clean),
    patch = evidence.find((e) => e.pointer === "/files/0/patch");
  assert.equal(
    validateCitations(
      {
        citations: [{ id: patch.id, quote: "[private path omitted]" }],
        findings: [],
      },
      evidence,
    )[0].exact,
    true,
  );
  assert.equal(packet.files[0].patch.includes("/Users/example"), true);
});
