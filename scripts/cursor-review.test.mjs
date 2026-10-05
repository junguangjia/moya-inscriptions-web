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
  agentConfiguration,
  agentEnvironment,
  currentRun,
  eligiblePR,
  marker,
  ownedComment,
  parseReport,
  parseCLIResult,
  renderReport,
  safeText,
  selectEvent,
} from "./cursor-review.mjs";
import { classifyTask } from "./ci-task-scope.mjs";

const repository = "example/project";
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
  }
  assert.throws(() =>
    parseReport(
      JSON.stringify({ ...clean, summary: ["ghp_", "A".repeat(36)].join("") }),
      packet,
    ),
  );
  assert.throws(() =>
    parseReport(JSON.stringify({ ...clean, assessment: "findings" }), packet),
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
  assert.match(workflow, /ref: main/u);
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(workflow, /sha256sum --check --status/u);
  assert.match(
    workflow,
    /format\('review-\{0\}',\s+github.event.pull_request.number \|\| inputs.pr\)/u,
  );
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
else if (method === 'GET') result = state.comments;
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
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("inference passes all evidence on stdin with no positional prompt or raw failure output", () => {
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
if (!input.includes('${head}') || process.argv.at(-1) !== 'json' || process.env.GH_TOKEN) process.exit(2);
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: ${JSON.stringify(JSON.stringify(clean))} }));
`,
      { mode: 0o700 },
    );
    const env = {
      PATH: process.env.PATH,
      RUNNER_TEMP: temp,
      CURSOR_AGENT_BIN: stub,
      CURSOR_API_KEY: "test-only",
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
      [`repos/${repository}/pulls/7`]: pr,
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
      JSON.stringify({ action: "opened", pull_request: pr }),
    );
    const output = join(temp, "output");
    const env = {
      PATH: `${bin}:${process.env.PATH}`,
      RUNNER_TEMP: temp,
      GITHUB_REPOSITORY: repository,
      GITHUB_EVENT_NAME: "pull_request_target",
      GITHUB_EVENT_PATH: event,
      GITHUB_OUTPUT: output,
    };
    const script = resolve(import.meta.dirname, "cursor-review.mjs");
    const prepared = spawnSync(process.execPath, [script, "prepare"], {
      env,
      encoding: "utf8",
    });
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.equal(readFileSync(output, "utf8"), "ready=true\n");
    const collected = JSON.parse(
      readFileSync(join(temp, "cursor-review/context.json"), "utf8"),
    );
    assert.equal(collected.files[0].source, "example();");
    assert.equal(collected.head, head);
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
