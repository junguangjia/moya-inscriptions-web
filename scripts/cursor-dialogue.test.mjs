import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
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
  RESUMPTION,
  DIALOGUE_PROMPT,
  decodeOriginals,
  decodeResumeRecord,
  dialogueDeadline,
  dialogueMain,
  extractJSON,
  scannedJSON,
  selectionCoverage,
  retainedResponse,
  validateAdmission,
  validateAnswer,
  validateEvidence,
  validateNativeIdentity,
  validatePrevious,
  validateResumePrior,
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
    { ...diagnostic, head_sha: "f".repeat(40) },
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
test("retained responses preserve rejected bodies while redacting credential scalars and encoded secrets", () => {
  const token = ["ghp_", "A".repeat(36)].join("");
  const result = retainedResponse(
    JSON.stringify({
      type: "result",
      result: JSON.stringify({
        answer: "useful evidence",
        secret: token,
        nested: [token],
      }),
      unrelated: token,
    }),
  );
  assert.equal(result.artifact.body.answer, "useful evidence");
  assert.equal(result.artifact.redactions, 2);
  assert.ok(!JSON.stringify(result.artifact).includes(token));
  assert.equal(result.artifact.accepted, false);
  const malformed = retainedResponse(
    JSON.stringify({
      result: '{"answer":"' + token.replaceAll("A", "\\u0041"),
    }),
  );
  assert.equal(malformed.artifact.redactions, 1);
  assert.match(malformed.artifact.body, /REDACTED/u);
  const valid = retainedResponse(
    JSON.stringify({ result: JSON.stringify({ answer: "证".repeat(2401) }) }),
  );
  assert.equal(valid.artifact.body.answer.length, 2401);
  assert.equal(valid.artifact.redactions, 0);
  assert.equal(
    retainedResponse("malformed safe output").artifact.format,
    "invalid-transport",
  );
});
test("one pinned resumption preserves original cost and expired start without reopening other failures", () => {
  const now = RESUMPTION.authorizedAt + 1000;
  const next = {
    ...request,
    dialogueId: RESUMPTION.dialogueId,
    round: 2,
    previousRun: RESUMPTION.priorRun,
    startedAt: RESUMPTION.startedAt,
    resumption: RESUMPTION.id,
    resumeRecord: "encoded",
    evidence: [evidence],
  };
  validateRequest(next, now);
  assert.throws(() => validateRequest({ ...next, resumption: undefined }, now));
  assert.throws(() =>
    validateRequest({ ...next, dialogueId: "a".repeat(24) }, now),
  );
  assert.throws(() => validateRequest({ ...next, startedAt: now }, now));
  assert.throws(() => validateRequest(next, RESUMPTION.expiresAt));
  assert.throws(() => validateRequest({ ...next, resumeAdmittedAt: now }, now));
  const prepared = { ...next, resumeAdmittedAt: now };
  validateRequest(prepared, now, true);
  assert.equal(dialogueDeadline(prepared), now + RESUMPTION.wallMs);
  assert.throws(() => validateRequest(prepared, now + RESUMPTION.wallMs, true));
  const prior = {
    version: 1,
    runId: RESUMPTION.priorRun,
    candidate: RESUMPTION.priorCandidate,
    dialogueId: RESUMPTION.dialogueId,
    target: TARGET,
    model: MODEL,
    round: 1,
    invocationCount: 1,
    startedAt: RESUMPTION.startedAt,
    inferenceMs: RESUMPTION.inferenceMs,
    status: "incomplete",
    error: "ENGLISH_REQUIRED",
    seenEvidence: [],
    seenCoverage: [],
  };
  validateResumePrior(prior);
  validatePrevious(prepared, prior, now);
  for (const changed of [
    { ...prior, inferenceMs: 0 },
    { ...prior, error: "CURSOR_TIMEOUT" },
    { ...prior, invocationCount: 0 },
  ])
    assert.throws(() => validatePrevious(prepared, changed, now));
  assert.throws(() => decodeResumeRecord("e30="));
  const round3 = {
    ...prepared,
    round: 3,
    previousRun: 777,
    originals: undefined,
  };
  const second = {
    ...prior,
    ...prepared,
    runId: 777,
    round: 2,
    invocationCount: 2,
    status: "needs_evidence",
    inferenceMs: 500000,
  };
  validatePrevious(round3, second, now);
  assert.throws(() =>
    validatePrevious({ ...round3, resumeAdmittedAt: now + 1 }, second, now),
  );
  assert.throws(() =>
    validatePrevious(round3, { ...second, status: "incomplete" }, now),
  );
  assert.throws(() =>
    validatePrevious(round3, { ...second, inferenceMs: NaN }, now),
  );
});
test("prepare admits the host timestamp before reaching pinned-prior validation", () => {
  const temp = mkdtempSync(join(tmpdir(), "cursor-resume-prepare-"));
  try {
    const now = RESUMPTION.authorizedAt + 1000;
    const runId = 37359999999;
    const next = {
      ...request,
      dialogueId: RESUMPTION.dialogueId,
      round: 2,
      previousRun: RESUMPTION.priorRun,
      startedAt: RESUMPTION.startedAt,
      resumption: RESUMPTION.id,
      resumeRecord: "not-base64",
    };
    const previous = {
      head_sha: RESUMPTION.priorCandidate,
      event: "workflow_dispatch",
      path: ".github/workflows/cursor-review.yml",
      run_attempt: 1,
      status: "completed",
      display_title: `cursor-dialogue ${RESUMPTION.dialogueId} round 1`,
    };
    const responses = {
      "actions/workflows/cursor-review.yml/runs?event=workflow_dispatch&per_page=100":
        {
          workflow_runs: [
            {
              id: runId,
              created_at: new Date(now).toISOString(),
              display_title: `cursor-dialogue ${RESUMPTION.dialogueId} round 2`,
            },
          ],
        },
      [`pulls/${TARGET.pr}`]: media,
      [`actions/runs/${TARGET.run}`]: diagnostic,
      [`git/commits/${TARGET.source}`]: {
        sha: TARGET.source,
        tree: { sha: TARGET.tree },
      },
      "pulls/224": candidate,
      [`actions/runs/${RESUMPTION.priorRun}`]: previous,
    };
    writeFileSync(
      join(temp, "gh"),
      `#!${process.execPath}\nconst responses=${JSON.stringify(responses)};\nconst path=process.argv.at(-1).replace(${JSON.stringify(`repos/${TARGET.repository}/`)},'');\nif(!Object.hasOwn(responses,path))process.exit(2);\nprocess.stdout.write(JSON.stringify(responses[path]));\n`,
      { mode: 0o700 },
    );
    writeFileSync(
      join(temp, "event.json"),
      JSON.stringify({
        inputs: {
          operation: "dialogue",
          dialogue_request: JSON.stringify(next),
        },
      }),
    );
    const script = `import { dialogueMain } from ${JSON.stringify(new URL("./cursor-dialogue.mjs", import.meta.url).href)}; Date.now=()=>${now}; try { await dialogueMain('prepare'); process.exitCode=2; } catch(error) { process.stdout.write(error.message); }`;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        encoding: "utf8",
        timeout: 10000,
        env: {
          PATH: temp + ":" + process.env.PATH,
          RUNNER_TEMP: temp,
          GITHUB_OUTPUT: join(temp, "output"),
          GITHUB_EVENT_PATH: join(temp, "event.json"),
          GITHUB_EVENT_NAME: "workflow_dispatch",
          GITHUB_REPOSITORY: TARGET.repository,
          GITHUB_REF: "refs/heads/codex/cursor-bounded-dialogue",
          GITHUB_SHA: request.candidate,
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_RUN_ID: String(runId),
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "RESUMPTION_PRIOR_MISMATCH");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
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
test("English is preferred without rejecting other languages or altering evidence", () => {
  for (const prompt of [PROMPT, DIALOGUE_PROMPT]) {
    assert.doesNotMatch(prompt, /Chinese summary|Chinese:|用中文|中文输出/u);
    assert.doesNotMatch(prompt, /Write ALL generated narrative in ENGLISH/u);
    assert.match(prompt, /English is preferred/u);
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
    (a) => {
      a.missing_evidence = [{ ...selection, reason: "补充已保存的证据" }];
    },
  ]) {
    const changed = globalThis.structuredClone(answer);
    change(changed);
    assert.deepEqual(validateAnswer(changed, [evidence]), changed);
  }
  const original = { ...evidence, text: "原始报错" };
  const quoted = globalThis.structuredClone(answer);
  quoted.findings[0].citations[0].quote = original.text;
  validateAnswer(quoted, [original]);
  const report = {
    assessment: "incomplete",
    summary: "中文摘要",
    findings: [],
  };
  assert.equal(
    parseReport(JSON.stringify(report), {
      files: [],
      omissions: [],
      kind: "ci",
    }).summary,
    report.summary,
  );
  validateRequest({ ...request, question: "哪些结论有证据？" }, 100001);
});
test("all dialogue narrative fields retain required content and length bounds regardless of language", () => {
  const setters = [
    (a, value) => {
      a.answer = value;
    },
    (a, value) => {
      a.findings[0].claim = value;
    },
    (a, value) => {
      a.findings[0].next_step = value;
    },
    (a, value) => {
      a.uncertainty = [value];
    },
    (a, value) => {
      a.next_verification = [value];
    },
    (a, value) => {
      a.missing_evidence = [{ ...selection, reason: value }];
    },
  ];
  for (const set of setters) {
    for (const value of [undefined, null, 0, "", "   "]) {
      const changed = globalThis.structuredClone(answer);
      set(changed, value);
      assert.throws(
        () => validateAnswer(changed, [evidence]),
        /INVALID_NARRATIVE/u,
      );
    }
    for (const value of ["a".repeat(2401), "证".repeat(2401)]) {
      const changed = globalThis.structuredClone(answer);
      set(changed, value);
      assert.throws(
        () => validateAnswer(changed, [evidence]),
        /NARRATIVE_TOO_LONG/u,
      );
    }
    const changed = globalThis.structuredClone(answer);
    set(changed, "证".repeat(2400));
    validateAnswer(changed, [evidence]);
  }
  const unsafe = globalThis.structuredClone(answer);
  unsafe.answer = "证据 " + ["ghp_", "A".repeat(36)].join("");
  assert.throws(() => validateAnswer(unsafe, [evidence]), /UNSAFE_ANSWER/u);
});
test("requests have finite time, size and round bounds", () => {
  validateRequest(request, 100001);
  for (const changed of [
    { ...request, round: 4 },
    { ...request, previousRun: 7 },
    { ...request, question: "   " },
    { ...request, question: undefined },
    { ...request, question: 0 },
    { ...request, question: "q".repeat(2401) },
    { ...request, startedAt: 200000 },
    { ...request, startedAt: 100002 },
  ])
    assert.throws(() => validateRequest(changed, 100001));
  assert.doesNotThrow(() =>
    validateRequest(request, request.startedAt + 8 * 3600000),
  );
  assert.equal(BUDGET.rounds, 3);
  assert.equal(BUDGET.callMs, null);
  assert.equal(BUDGET.inferenceMs, null);
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
    { ...prior, inferenceMs: NaN },
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
  assert.match(workflow, /needs.route.outputs.trusted/u);
  assert.match(workflow, /refs\/heads\/main/u);
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

for (const [label, returnedAnswer, expectedError] of [
  ["English", answer, undefined],
  [
    "non-English",
    { ...answer, answer: "诊断达到反馈时限；现有证据不足以确定根因。" },
    undefined,
  ],
  [
    "overlength",
    { ...answer, answer: "证".repeat(2401) },
    "NARRATIVE_TOO_LONG",
  ],
  ["missing-body", undefined, "MODEL_BODY_MISSING"],
  ["missing-narrative", { ...answer, answer: undefined }, "INVALID_NARRATIVE"],
  ["invalid-schema", {}, "INVALID_ANSWER"],
])
  test(`isolated fake-CLI stage handles ${label} output without translation or retry`, async () => {
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
process.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:false,result:${JSON.stringify(JSON.stringify(returnedAnswer))},usage:{input_tokens:10,output_tokens:20,extra:'discard'}}));
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
      assert.equal(record.error, expectedError);
      assert.equal(record.invocationCount, 1);
      assert.equal(record.effectiveSelection.modelId, "grok-4.7");
      assert.deepEqual(record.usage, { input_tokens: 10, output_tokens: 20 });
      const retained = JSON.parse(
        readFileSync(join(directory, "output/model-response.json"), "utf8"),
      );
      assert.equal(retained.accepted, !expectedError);
      assert.equal(retained.redactions, 0);
      if (label === "overlength") {
        assert.equal(retained.body.answer.length, 2401);
        assert.deepEqual(record.validationDetail, {
          field: "answer",
          issue: "length",
          characters: 2401,
          limit: 2400,
        });
      }
      if (label === "missing-narrative")
        assert.deepEqual(record.validationDetail, {
          field: "answer",
          issue: "missing",
        });
      if (!expectedError) {
        assert.equal(record.answer.answer, returnedAnswer.answer);
        assert.equal(record.effectiveSelection.modelId, "grok-4.7");
        assert.deepEqual(record.usage, { input_tokens: 10, output_tokens: 20 });
      }
      assert.ok(record.roundInferenceMs > 0);
      assert.equal(record.evidence[0].text, undefined);
      assert.match(
        readFileSync(join(directory, "output/report.md"), "utf8"),
        expectedError
          ? new RegExp(expectedError.replaceAll("_", "&#95;"), "u")
          : /FEEDBACK/u,
      );
      await assert.rejects(
        dialogueMain("analyze", env),
        /DUPLICATE_INVOCATION/u,
      );
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

test("ordinary question admits only exact live trusted-main identities and explicitly sanitized evidence", () => {
  const script = `
import assert from 'node:assert/strict';
import { configureQuestionScope, TARGET, ORIGINALS, validateAdmission, validatePrevious } from ${JSON.stringify(new URL("./cursor-dialogue.mjs", import.meta.url).href)};
const t = { ...${JSON.stringify(TARGET)}, pr: 215, source: 'e'.repeat(40), tree: 'f'.repeat(40), workflow: 'e'.repeat(40), run: 321, base: 'main' };
const hashes = { preparation: '1'.repeat(64), feedback: '2'.repeat(64), execution: '3'.repeat(64) };
const request = { scope: 'repository-question-v1', remoteEvidenceApproved: true, target: t, originalHashes: hashes, candidate: 'd'.repeat(40) };
assert.throws(() => configureQuestionScope({ ...request, remoteEvidenceApproved: false }), /INVALID_REPOSITORY/);
assert.throws(() => configureQuestionScope({ ...request, private: '/Users/example/context.json' }), /NONPUBLIC/);
assert.throws(() => configureQuestionScope({ ...request, resumption: 'old' }), /INVALID_REPOSITORY/);
configureQuestionScope(request);
assert.deepEqual(TARGET,t); assert.deepEqual(ORIGINALS,hashes);
const media = { state: 'open', head: { sha: t.source, repo: { full_name: t.repository } }, base: { ref: t.base, repo: { full_name: t.repository } } };
const run = { id:t.run, run_attempt:t.attempt, workflow_id:t.workflowId, head_sha:t.workflow, path:'.github/workflows/ci.yml', event:'pull_request', repository:{full_name:t.repository}, head_repository:{full_name:t.repository}, status:'completed', conclusion:'failure' };
const commit = { sha:t.source,tree:{sha:t.tree} }, main = { sha:request.candidate };
validateAdmission(request,media,run,commit,main);
for (const r of [{ ...run,run_attempt:2 },{ ...run,head_sha:'b'.repeat(40) },{ ...run,workflow_id:1 }]) assert.throws(() => validateAdmission(request,media,r,commit,main));
assert.throws(() => validateAdmission(request,media,run,commit,{sha:'b'.repeat(40)}));
assert.throws(() => validatePrevious({ ...request,round:2 },{ status:'answered' }), /NOT_CONTINUABLE/);
console.log('PASS');`;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "PASS");
});

test("sanitized remote response retention never uploads a generated private path", () => {
  const capture = retainedResponse(
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: JSON.stringify({
        ...answer,
        answer: "/Users/example/private.json",
      }),
    }),
  );
  assert.equal(capture.artifact.redactions, 1);
  assert.doesNotMatch(JSON.stringify(capture.artifact), /\/Users\//u);
});
