import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { URL } from "node:url";
import {
  admit,
  SOURCE,
  TREE,
  FIELDS,
  selectedTests,
  sanitizeSnapshot,
  approvedAnonymousIdentity,
  coreCheckCategory,
  sanitizeAttribution,
} from "./media-home-diagnostic.mjs";

const workflow = "a".repeat(40);
const env = {
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF: "refs/heads/codex/media-home-d9-diagnostic",
  HOME_WORKFLOW_SHA: workflow,
  GITHUB_SHA: workflow,
  HOME_TASK_KEY: "12345678-1234-1234-1234-123456789abc",
  GITHUB_RUN_ID: "123",
  GITHUB_RUN_ATTEMPT: "1",
};
test("fresh-clone identity reuses only a valid anonymous controlled-commit author", () => {
  assert.deepEqual(
    approvedAnonymousIdentity(
      "Synthetic Agent\0fixture@users.noreply.github.com\n",
    ),
    { name: "Synthetic Agent", email: "fixture@users.noreply.github.com" },
  );
  for (const input of [
    "Synthetic Agent\0personal@example.invalid",
    "\0fixture@users.noreply.github.com",
    "Bad\nName\0fixture@users.noreply.github.com",
    "Synthetic Agent\0fixture@users.noreply.github.com\0other",
  ])
    assert.throws(() => approvedAnonymousIdentity(input));
});
test("checker incomplete, blocked and execution failures remain distinct", () => {
  assert.equal(coreCheckCategory(2), "OUTBOUND_CHECK_INCOMPLETE");
  assert.equal(coreCheckCategory(1), "OUTBOUND_CHECK_BLOCKED");
  assert.equal(coreCheckCategory(null), "OUTBOUND_CHECK_EXECUTION_FAILED");
});
test("admission rejects wrong source, workflow, event and replay attempts", () => {
  assert.equal(admit(env, SOURCE, TREE).source_sha, SOURCE);
  for (const [key, value] of [
    ["GITHUB_EVENT_NAME", "pull_request"],
    ["GITHUB_SHA", "b".repeat(40)],
    ["GITHUB_RUN_ATTEMPT", "2"],
    ["GITHUB_REF", "refs/heads/main"],
  ])
    assert.throws(() => admit({ ...env, [key]: value }, SOURCE, TREE));
  assert.throws(() => admit(env, "b".repeat(40), TREE));
});
test("selection rejects no tests and a broadened matrix", () => {
  const spec = {
    title:
      "Home preserves independent Discover, Nearby, and Calligraphy scroll positions",
    tests: [{ projectName: "tablet-webkit" }],
  };
  assert.equal(
    selectedTests({ suites: [{ specs: [spec] }] }).projectName,
    "tablet-webkit",
  );
  assert.throws(() => selectedTests({ suites: [] }));
  assert.throws(() => selectedTests({ suites: [{ specs: [spec, spec] }] }));
});
test("sanitizer rejects strings, nonfinite values and broad fields", () => {
  const row = Array(FIELDS.length).fill(0);
  const data = {
    schema: 1,
    documentLabel: [1, 2],
    rows: [row],
    slots: [{ key: "0.0.0.0", samples: 1, retained: 1 }],
    seen: 1,
    invalid: 0,
    slotOverflow: 0,
  };
  assert.equal(sanitizeSnapshot(data).rows.length, 1);
  for (const value of ["https://example.invalid/private", Infinity, {}]) {
    const changed = [...row];
    changed[14] = value;
    assert.throws(() => sanitizeSnapshot({ ...data, rows: [changed] }));
  }
});
function mockRecorder(action) {
  const require = createRequire(
    new URL("../tests/package.json", import.meta.url),
  );
  const ts = require("typescript");
  const code = ts.transpileModule(
    readFileSync(
      new URL("../tests/e2e/support/home-causal-recorder.ts", import.meta.url),
      "utf8",
    ),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", code)(
    require,
    module,
    module.exports,
  );
  const home = { dataset: { activeHomeFeed: "discover" }, isConnected: true };
  const panels = ["discover", "nearby", "inscriptions", "calligraphy"].map(
    (feed) => ({
      dataset: { homeFeedPanel: feed, testScrollIdentity: `stable-${feed}` },
      isConnected: true,
      scrollTop: 0,
      scrollHeight: 5000,
      clientHeight: 1000,
      hasAttribute: () => true,
      closest: () => home,
      querySelector: () => null,
    }),
  );
  home.querySelectorAll = () => panels;
  home.querySelector = (selector) =>
    panels.find((p) => selector.includes(`"${p.dataset.homeFeedPanel}"`)) ??
    null;
  home.closest = () => null;
  const old = {
    window: globalThis.window,
    document: globalThis.document,
    MutationObserver: globalThis.MutationObserver,
  };
  globalThis.window = { addEventListener() {} };
  globalThis.document = { querySelector: () => home, addEventListener() {} };
  globalThis.MutationObserver = class {
    disconnect() {}
    observe() {}
  };
  try {
    module.exports.installHomeRecorder();
    const recorder = globalThis.window.__artvennHomeRecorder;
    action(recorder, panels);
  } finally {
    Object.assign(globalThis, old);
  }
}

test("worst-case early event flood retains later critical phase slots", () => {
  mockRecorder((recorder, panels) => {
    recorder.bind("seed.begin", "discover", 0, 900);
    for (let n = 0; n < 10000; n++) {
      panels[0].scrollTop = n;
      recorder.mark(2, panels[0]);
    }
    recorder.bind("end", "calligraphy", 0, 900);
    panels[3].scrollTop = 900;
    recorder.mark(0, panels[3]);
    const data = sanitizeSnapshot(recorder.snapshot());
    assert.equal(data.slotOverflow, 0);
    assert.ok(data.rows.some((r) => r[2] === 14 && r[14] === 900));
    assert.ok(data.rows.some((r) => r[2] === 1 && r[14] === 0));
    assert.ok(data.rows.some((r) => r[2] === 1 && r[14] === 9999));
    assert.ok(Buffer.byteLength(JSON.stringify(data)) < 131072);
    assert.equal(data.slots[0].samples, 10000);
  });
});

test("all 128 critical slots reserve first, last and first divergence in both retries", () => {
  mockRecorder((recorder, panels) => {
    const feeds = ["discover", "nearby", "inscriptions", "calligraphy"];
    const contexts = [
      ["init", 0, 0],
      ["initial.before", 0, 0],
      ["initial.after", 0, 0],
    ];
    for (const phase of [
      "seed.begin",
      "seed.baseline",
      "final.before",
      "final.after",
    ])
      for (const [iteration, feed] of [0, 1, 3].entries())
        contexts.push([phase, feed, iteration]);
    for (const phase of ["restore.before", "matcher", "restore.matched"])
      for (const [iteration, feed] of [3, 1, 0, 3].entries())
        contexts.push([phase, feed, iteration]);
    for (const phase of [
      "settings.before",
      "settings.after",
      "destination.before",
      "destination.after",
      "end",
    ])
      contexts.push([phase, 3, 0]);
    assert.equal(contexts.length, 32);
    for (const [phase, feed, iteration] of contexts) {
      recorder.bind(phase, feeds[feed], iteration, 900);
      for (const panel of panels) {
        for (const top of [0, 900, 901]) {
          panel.scrollTop = top;
          recorder.mark(2, panel);
        }
      }
    }
    recorder.bind("seed.begin", "discover", 0, 900);
    for (let n = 0; n < 10000; n++) recorder.writer(0, 0, panels[0], 900);
    panels[0].scrollTop = 900;
    recorder.writer(0, 0, panels[0], 0);
    panels[0].scrollTop = 0;
    recorder.writer(0, 1, panels[0], 0);
    for (let n = 0; n < 10000; n++) recorder.writer(0, 1, panels[0], 0);
    const snapshot = sanitizeSnapshot(recorder.snapshot());
    assert.equal(snapshot.slotOverflow, 0);
    assert.equal(snapshot.invalid, 0);
    assert.equal(snapshot.slots.length, 128);
    assert.equal(snapshot.rows.length, 384);
    assert.ok(snapshot.slots.every((s) => s.retained === 3 && s.samples === 3));
    assert.equal(snapshot.attribution.rows.length, 49);
    const packet = { attempts: [snapshot, snapshot] };
    assert.ok(Buffer.byteLength(JSON.stringify(packet)) < 131072);
  });
});

test("late attribution retains the first actual900-to-zero writer and both edges after an early flood", () => {
  mockRecorder((recorder, panels) => {
    recorder.bind("seed.begin", "discover", 0, 900);
    for (let n = 0; n < 10000; n++) recorder.mark(2, panels[0]);
    panels[0].scrollTop = 900;
    recorder.mark(1, panels[0], 900);
    recorder.writer(0, 0, panels[0], 0);
    panels[0].scrollTop = 0;
    recorder.writer(0, 1, panels[0], 0);
    for (let n = 0; n < 10000; n++) recorder.mark(2, panels[0]);
    recorder.bind("end", "calligraphy", 0, 900);
    recorder.mark(0, panels[3]);
    const result = sanitizeSnapshot(recorder.snapshot());
    const trace = result.attribution;
    assert.ok(trace.first_900_to_zero > 10000);
    assert.ok(trace.rows.length <= 49);
    const after = trace.rows.find((row) => row[0] === trace.first_900_to_zero);
    const before = trace.rows.find((row) => row[0] === after[0] - 1);
    assert.deepEqual(before.slice(2, 5), [0, 0, 0]);
    assert.equal(before[14], 900);
    assert.deepEqual(after.slice(2, 5), [0, 0, 1]);
    assert.equal(after[13], 0);
    assert.equal(after[14], 0);
    assert.equal(trace.omitted, trace.seen - trace.rows.length);
    assert.ok(result.rows.some((row) => row[2] === 14));
    assert.ok(
      Buffer.byteLength(JSON.stringify({ attempts: [result, result] })) <
        131072,
    );
  });
});

test("attribution rejects unsafe scalars and reserves only the named seed stage", () => {
  mockRecorder((recorder, panels) => {
    recorder.bind("seed.begin", "nearby", 1, 350);
    recorder.writer(0, 0, panels[1], 350);
    assert.equal(recorder.snapshot().attribution.seen, 0);
    recorder.bind("seed.begin", "discover", 0, 900);
    recorder.writer(1, 0, panels[0], 900);
    const good = recorder.snapshot().attribution;
    assert.equal(sanitizeAttribution(good).rows.length, 1);
    for (const unsafe of ["https://example.invalid/private", {}, Infinity]) {
      const row = [...good.rows[0]];
      row[13] = unsafe;
      assert.throws(() => sanitizeAttribution({ ...good, rows: [row] }));
    }
    assert.throws(() => sanitizeAttribution({ ...good, first900ToZero: 1 }));
  });
});

test("default CI is byte-equivalent after removing only diagnostic guards, inputs and job", () => {
  const root = new URL("../", import.meta.url);
  const original = execFileSync(
    "git",
    ["show", `${SOURCE}:.github/workflows/ci.yml`],
    { cwd: root, encoding: "utf8", timeout: 5000 },
  );
  const changed = readFileSync(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  const withoutDiagnostic = changed
    .replace(/( {2}workflow_dispatch:\n)[\s\S]*?( {2}pull_request:)/, "$1$2")
    .replace("    if: ${{ !inputs.media_home_diagnostic }}\n", "")
    .replaceAll(
      "    if: ${{ always() && !inputs.media_home_diagnostic }}",
      "    if: ${{ always() }}",
    )
    .split("\n  media-home-diagnostic:")[0];
  assert.ok(withoutDiagnostic.trimEnd() === original.trimEnd());
});
