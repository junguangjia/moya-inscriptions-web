import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  readFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { URL } from "node:url";
import {
  BUDGET,
  TARGET,
  MODEL,
  ORIGINALS,
  DIALOGUE_PROMPT,
  decodeOriginals,
  dialogueMain,
  extractJSON,
  scannedJSON,
  selectionCoverage,
  validateAdmission,
  validateAnswer,
  validateEvidence,
  validateNativeIdentity,
  validatePrevious,
  validateRequest,
} from "./cursor-dialogue.mjs";
import {
  agentConfiguration,
  agentEnvironment,
  PROMPT,
  parseReport,
} from "./cursor-review.mjs";
import { classifyTask } from "./ci-task-scope.mjs";
const hash = (s) => createHash("sha256").update(s).digest("hex");
const selection = { file: "feedback", pointer: "/outcome" };
const text = JSON.stringify("FEEDBACK_DEADLINE_EXCEEDED", null, 2);
const evidence = {
  ...selection,
  originalSha256: ORIGINALS.feedback,
  text,
  sha256: hash(text),
  id: hash(JSON.stringify(selection) + ORIGINALS.feedback + hash(text)),
  coverage: [hash("original feedback outcome leaf")],
};
const question = "What does this result establish, and what remains unknown?";
const request = {
  target: TARGET,
  candidate: "a".repeat(40),
  candidatePR: 224,
  dialogueId: "b".repeat(24),
  round: 1,
  startedAt: 100000,
  previousRun: null,
  question,
  originals: "encoded",
  selectors: [selection],
};
const answer = {
  status: "incomplete",
  answer: "The diagnostic exceeded its deadline.",
  findings: [
    {
      claim: "The run exceeded its feedback deadline.",
      confidence: "observed",
      citations: [{ id: evidence.id, quote: "FEEDBACK_DEADLINE_EXCEEDED" }],
      next_step:
        "Request the missing native phase evidence; do not rerun this diagnostic.",
    },
  ],
  uncertainty: ["The internal initialization cause remains unknown."],
  missing_evidence: [],
  next_verification: ["Inspect only a disputed cited record."],
};
const media = {
  state: "open",
  head: { sha: TARGET.source, repo: { full_name: TARGET.repository } },
  base: { ref: TARGET.base, repo: { full_name: TARGET.repository } },
};
const diagnostic = {
  id: TARGET.run,
  run_attempt: 1,
  workflow_id: TARGET.workflowId,
  head_sha: TARGET.workflow,
  path: ".github/workflows/ci.yml",
  event: "workflow_dispatch",
  repository: { full_name: TARGET.repository },
  head_repository: { full_name: TARGET.repository },
  status: "completed",
  conclusion: "failure",
};
const commit = { sha: TARGET.source, tree: { sha: TARGET.tree } };
const candidate = {
  state: "open",
  draft: true,
  head: {
    sha: request.candidate,
    ref: "codex/cursor-bounded-dialogue",
    repo: { full_name: TARGET.repository },
  },
  base: { ref: "main", repo: { full_name: TARGET.repository } },
};

test("dual workflow/source identity is explicit and rejects stale or foreign candidates", () => {
  validateAdmission(request, media, diagnostic, commit, candidate);
  for (const run of [
    { ...diagnostic, head_sha: TARGET.source },
    { ...diagnostic, run_attempt: 2 },
    { ...diagnostic, workflow_id: TARGET.workflowId + 1 },
    { ...diagnostic, status: "in_progress" },
  ])
    assert.throws(() =>
      validateAdmission(request, media, run, commit, candidate),
    );
  assert.throws(() =>
    validateAdmission(
      request,
      { ...media, head: candidate.head },
      diagnostic,
      commit,
      candidate,
    ),
  );
  assert.throws(() =>
    validateAdmission(request, media, diagnostic, commit, {
      ...candidate,
      draft: false,
    }),
  );
  assert.throws(() =>
    validateAdmission(
      request,
      media,
      diagnostic,
      { ...commit, tree: { sha: "b".repeat(40) } },
      candidate,
    ),
  );
});
test("native manifest binds source tree, workflow, run/attempt and non-acceptance", () => {
  const id = {
    source_head: TARGET.source,
    source_tree: TARGET.tree,
    workflow_revision: TARGET.workflow,
    diagnostic_run_id: String(TARGET.run),
    diagnostic_run_attempt: "1",
    diagnostic_only: true,
    acceptance_pass: false,
  };
  validateNativeIdentity(id);
  assert.throws(() => validateNativeIdentity({ ...id, acceptance_pass: true }));
  assert.throws(() =>
    validateNativeIdentity({ ...id, source_tree: TARGET.workflow }),
  );
});
test("selector reads faithful original values with explicit array positions and no inherited paths", () => {
  const value = {
    phases: {
      events: [{ raw: "first" }, { raw: "literal evidence" }, { raw: "last" }],
    },
  };
  assert.equal(
    extractJSON(value, {
      file: "feedback",
      pointer: "/phases/events",
      start: 1,
      count: 1,
    }),
    JSON.stringify([{ raw: "literal evidence" }], null, 2),
  );
  for (const selector of [
    { file: "secrets", pointer: "" },
    { file: "feedback", pointer: "/__proto__" },
    { file: "feedback", pointer: "/phases/events", start: -1, count: 1 },
    { file: "feedback", pointer: "/phases/events", start: 0, count: 33 },
  ])
    assert.throws(() => extractJSON(value, selector));
  assert.throws(() =>
    extractJSON(
      { large: "x".repeat(BUDGET.recordChars + 1) },
      { file: "feedback", pointer: "/large" },
    ),
  );
});
test("original bundle rejects unrelated, corrupt and oversized compressed inputs", () => {
  assert.throws(() => decodeOriginals("not-base64"));
  assert.throws(() => decodeOriginals("A".repeat(BUDGET.transportBytes + 1)));
  assert.throws(() => decodeOriginals("e30="));
  assert.throws(() => scannedJSON("x".repeat(BUDGET.originalBytes + 1)));
});
test("evidence hash/id integrity and exact quote citations cannot silently drift", () => {
  validateEvidence([evidence]);
  validateAnswer(globalThis.structuredClone(answer), [evidence]);
  assert.throws(() => validateEvidence([{ ...evidence, text: '"changed"' }]));
  const forged = globalThis.structuredClone(answer);
  forged.findings[0].citations[0].quote = "NATIVE_PASS";
  assert.throws(
    () => validateAnswer(forged, [evidence]),
    /CITATION_NOT_IN_ORIGINAL/u,
  );
  forged.findings[0].citations[0] = {
    id: "unknown",
    quote: "FEEDBACK_DEADLINE_EXCEEDED",
  };
  assert.throws(() => validateAnswer(forged, [evidence]));
});
test("English is required on every narrative path while literal cited evidence stays intact", () => {
  for (const prompt of [PROMPT, DIALOGUE_PROMPT]) {
    assert.doesNotMatch(prompt, /Chinese summary|Chinese:|用中文|中文输出/u);
    assert.match(prompt, /English|ENGLISH/u);
  }
  for (const change of [
    (a) => {
      a.answer = "中文输出";
    },
    (a) => {
      a.findings[0].claim = "中文结论";
    },
    (a) => {
      a.findings[0].next_step = "重新运行";
    },
    (a) => {
      a.uncertainty = ["不确定"];
    },
    (a) => {
      a.next_verification = ["重新测试"];
    },
  ]) {
    const changed = globalThis.structuredClone(answer);
    change(changed);
    assert.throws(
      () => validateAnswer(changed, [evidence]),
      /ENGLISH_REQUIRED/u,
    );
  }
  const original = { ...evidence, text: "原始报错" };
  const quoted = globalThis.structuredClone(answer);
  quoted.findings[0].citations[0].quote = original.text;
  validateAnswer(quoted, [original]);
  assert.throws(
    () =>
      parseReport(
        JSON.stringify({
          assessment: "incomplete",
          summary: "中文摘要",
          findings: [],
        }),
        { files: [], omissions: [], kind: "ci" },
      ),
    /ENGLISH_REQUIRED/u,
  );
});
test("requests have finite time, size and round bounds", () => {
  validateRequest(request, 100001);
  for (const changed of [
    { ...request, round: 4 },
    { ...request, previousRun: 7 },
    { ...request, question: "中文问题" },
    { ...request, question: "q".repeat(2401) },
    { ...request, startedAt: 200000 },
    { ...request, startedAt: 100002 },
  ])
    assert.throws(() => validateRequest(changed, 100001));
  assert.throws(() =>
    validateRequest(request, request.startedAt + BUDGET.wallMs),
  );
  assert.equal(BUDGET.rounds, 3);
  assert.equal(BUDGET.callMs, 360000);
  assert.equal(BUDGET.inferenceMs, 900000);
  assert.equal(
    MODEL,
    "grok-4.7[context=500k,reasoning_effort=xhigh,fast=true]",
  );
});
test("follow-ups require validated prior identity and genuinely new evidence", () => {
  const next = { ...request, round: 2, previousRun: 42, evidence: [evidence] };
  const prior = {
    version: 1,
    dialogueId: request.dialogueId,
    candidate: request.candidate,
    target: TARGET,
    round: 1,
    runId: 42,
    startedAt: request.startedAt,
    status: "needs_evidence",
    inferenceMs: 50000,
    seenEvidence: [],
    seenCoverage: [],
  };
  validatePrevious(next, prior, 100001);
  for (const changed of [
    { ...prior, seenCoverage: evidence.coverage },
    { ...prior, status: "incomplete" },
    { ...prior, inferenceMs: BUDGET.inferenceMs },
    { ...prior, candidate: "c".repeat(40) },
    { ...prior, startedAt: 200000 },
  ])
    assert.throws(() => validatePrevious(next, changed, 100001));
});

test("overlapping slices and parent/child aliases cannot reset original coverage", () => {
  const original = { events: [{ phase: "start" }] };
  const one = { file: "feedback", pointer: "/events", start: 0, count: 1 };
  const oversized = { ...one, count: 2 };
  const child = { file: "feedback", pointer: "/events/0/phase" };
  assert.equal(extractJSON(original, one), extractJSON(original, oversized));
  assert.deepEqual(
    selectionCoverage(original, one),
    selectionCoverage(original, oversized),
  );
  assert.deepEqual(
    selectionCoverage(original, one),
    selectionCoverage(original, child),
  );
  const seen = selectionCoverage(original, one);
  const next = {
    ...request,
    round: 2,
    previousRun: 42,
    evidence: [
      {
        ...evidence,
        id: "different selector",
        coverage: selectionCoverage(original, oversized),
      },
    ],
  };
  const prior = {
    version: 1,
    dialogueId: request.dialogueId,
    candidate: request.candidate,
    target: TARGET,
    round: 1,
    runId: 42,
    startedAt: request.startedAt,
    status: "needs_evidence",
    inferenceMs: 10,
    seenEvidence: [evidence.id],
    seenCoverage: seen,
  };
  assert.throws(
    () => validatePrevious(next, prior, 100001),
    /NO_NEW_EVIDENCE/u,
  );
});
test("tool, environment, candidate-route and validation profile boundaries remain narrow", () => {
  assert.deepEqual(agentConfiguration().permissions.allow, []);
  for (const permission of [
    "Shell(*)",
    "Write(**)",
    "WebFetch(*)",
    "Mcp(*:*)",
    "Read(**)",
  ])
    assert.ok(agentConfiguration().permissions.deny.includes(permission));
  const environment = agentEnvironment(
    { PATH: "safe", GH_TOKEN: "synthetic", ACTIONS_RUNTIME_TOKEN: "synthetic" },
    "/tmp/isolated",
  );
  assert.equal(environment.GH_TOKEN, undefined);
  assert.equal(environment.ACTIONS_RUNTIME_TOKEN, undefined);
  const workflow = readFileSync(
    new URL("../.github/workflows/cursor-review.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /refs\/heads\/codex\/cursor-bounded-dialogue/u);
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(workflow, /actions: read/u);
  assert.doesNotMatch(workflow, /actions: write|contents: write/u);
  const plan = classifyTask(
    ["scripts/cursor-dialogue.mjs", "scripts/cursor-dialogue.test.mjs"],
    "pull_request",
  );
  assert.equal(plan.lightweight, true);
  assert.equal(plan.web, false);
});

test("isolated real stage retains an English cited round, numeric usage and refuses duplicate invocation", async () => {
  const temp = mkdtempSync(join(tmpdir(), "cursor-dialogue-stage-"));
  try {
    const directory = join(temp, "cursor-dialogue");
    mkdirSync(join(directory, "output"), { recursive: true });
    const prepared = {
      ...request,
      startedAt: Date.now(),
      evidence: [evidence],
    };
    delete prepared.originals;
    writeFileSync(
      join(directory, "prepared.json"),
      JSON.stringify({
        request: prepared,
        prior: null,
        sources: { omissions: [] },
      }),
    );
    const stub = join(temp, "agent");
    writeFileSync(
      stub,
      `#!${process.execPath}
const fs = require('node:fs');
const input = fs.readFileSync(0, 'utf8');
if (!input.includes('FEEDBACK_DEADLINE_EXCEEDED') || process.env.GH_TOKEN || process.argv.includes('--resume')) process.exit(2);
const path = process.env.CURSOR_CONFIG_DIR + '/cli-config.json';
const config = JSON.parse(fs.readFileSync(path, 'utf8'));
if(config.permissions.allow.length || !config.permissions.deny.includes('Read(**)')) process.exit(3);
config.selectedModel = { modelId: 'grok-4.7', parameters: [{id:'context',value:'500k'},{id:'reasoning_effort',value:'xhigh'},{id:'fast',value:'true'}] };
config.maxMode = true; fs.writeFileSync(path, JSON.stringify(config));
process.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:false,result:${JSON.stringify(JSON.stringify(answer))},usage:{input_tokens:10,output_tokens:20,extra:'discard'}}));
`,
      { mode: 0o700 },
    );
    const env = {
      PATH: process.env.PATH,
      RUNNER_TEMP: temp,
      GITHUB_RUN_ID: "999",
      CURSOR_MODEL: MODEL,
      CURSOR_API_KEY: "test-only",
      GH_TOKEN: "test-only",
      CURSOR_AGENT_BIN: stub,
    };
    await dialogueMain("analyze", env);
    const record = JSON.parse(
      readFileSync(join(directory, "output/round.json"), "utf8"),
    );
    assert.equal(record.status, "incomplete");
    assert.equal(record.error, undefined);
    assert.equal(record.invocationCount, 1);
    assert.equal(record.effectiveSelection.modelId, "grok-4.7");
    assert.deepEqual(record.usage, { input_tokens: 10, output_tokens: 20 });
    assert.ok(record.roundInferenceMs > 0);
    assert.equal(record.evidence[0].text, undefined);
    assert.match(
      readFileSync(join(directory, "output/report.md"), "utf8"),
      /FEEDBACK/u,
    );
    await assert.rejects(dialogueMain("analyze", env), /DUPLICATE_INVOCATION/u);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
