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
  sanitizeReadiness,
  READINESS_FIELDS,
  ACTION_GROUPS,
  sanitizeActions,
  sanitizeNativeErrors,
} from "./media-home-diagnostic.mjs";

const workflow = "a".repeat(40);
const env = {
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF: "refs/heads/codex/media-home97-hop-diagnostic",
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

function readinessRecorder() {
  const require = createRequire(
    new URL("../tests/package.json", import.meta.url),
  );
  const ts = require("typescript");
  const code = ts.transpileModule(
    readFileSync(
      new URL(
        "../tests/e2e/support/home-readiness-recorder.ts",
        import.meta.url,
      ),
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
  return new module.exports.HomeReadinessRecorder();
}
test("fixed action groups preserve every late group and unfinished native error independently of early samples", () => {
  const r = readinessRecorder();
  const call = r.begin("discover");
  for (let n = 0; n < 10000; n++) r.sample(call, readyEvidence(), 2, true);
  for (let group = 0; group < 8; group++) {
    r.actionBegin(group);
    r.actionEnd(group);
  }
  r.phase(2);
  r.finalSettleBegin("nearby");
  assert.equal(r.snapshot().actions.rows.length, 8);
  r.finalSettleBegin("discover");
  const out = sanitizeReadiness(r.snapshot("failed", true));
  assert.equal(ACTION_GROUPS.length, 9);
  assert.equal(out.actions.rows.length, 9);
  assert.deepEqual(
    out.actions.rows.map((row) => row[0]),
    [0, 1, 2, 3, 4, 5, 6, 7, 8],
  );
  assert.ok(
    out.actions.rows
      .slice(0, 8)
      .every((row) => row[3] === 1 && row[2] >= row[1]),
  );
  assert.equal(out.actions.rows[8][2], null);
  assert.equal(out.actions.rows[8][3], 2);
  assert.equal(out.actions.invalid, 0);
  assert.equal(out.actions.overflow, 0);
  assert.equal(
    sanitizeActions(r.snapshot("timedOut", true).actions).rows[8][3],
    3,
  );
  r.finalSettleEnd("discover");
  r.actionBegin(9);
  const complete = sanitizeActions(r.snapshot().actions);
  assert.equal(complete.rows[8][3], 1);
  assert.equal(complete.overflow, 1);
  assert.ok(
    Buffer.byteLength(JSON.stringify({ attempts: [out, out] })) < 131072,
  );
});
test("action sanitizer rejects unsafe timestamps, routes and completion flags", () => {
  const base = {
    rows: [
      [0, 1, 2, 1],
      [1, 3, null, 0],
    ],
    invalid: 0,
    overflow: 0,
  };
  sanitizeActions(base);
  for (const [index, value] of [
    [0, 5],
    [1, "private"],
    [1, Infinity],
    [2, 0],
    [3, 3],
  ]) {
    const changed = JSON.parse(JSON.stringify(base));
    changed.rows[0][index] = value;
    assert.throws(() => sanitizeActions(changed));
  }
  assert.throws(() =>
    sanitizeActions({
      ...base,
      rows: [
        [0, 1, null, 0],
        [1, 2, 3, 1],
      ],
    }),
  );
});
test("native error categories use actual fields or recognized text and never native duration", () => {
  assert.equal(sanitizeNativeErrors(undefined).native_result_present, false);
  const unknown = sanitizeNativeErrors({
    status: "timedOut",
    duration: 30000,
    errors: [{ message: "PRIVATE_SENTINEL_NOT_REAL https://example.invalid/" }],
  });
  assert.equal(unknown.errors[0].category, "UNKNOWN");
  assert.ok(!JSON.stringify(unknown).includes("PRIVATE_SENTINEL"));
  assert.ok(!JSON.stringify(unknown).includes("example.invalid"));
  for (const [message, category] of [
    ["Test timeout of 30000ms exceeded.", "TEST_TIMEOUT"],
    ["Timeout 15000ms exceeded while waiting on the predicate", "POLL_TIMEOUT"],
    [
      "Error: expect(received).toBe(expected) // Object.is equality",
      "ASSERTION_TO_BE",
    ],
    ["locator.click: Timeout 5000ms exceeded.", "ACTION_TIMEOUT"],
    ["Target page, context or browser has been closed", "PAGE_CONTEXT_CLOSED"],
  ])
    assert.equal(
      sanitizeNativeErrors({ error: { message } }).errors[0].category,
      category,
    );
  assert.equal(
    sanitizeNativeErrors({ error: { name: "TimeoutError" } }).errors[0]
      .category,
    "TIMEOUT_UNCLASSIFIED",
  );
  const esc = String.fromCharCode(27);
  assert.equal(
    sanitizeNativeErrors({
      error: {
        message: esc + "[31mTest timeout of 30000ms exceeded." + esc + "[39m",
      },
    }).errors[0].category,
    "TEST_TIMEOUT",
  );
  assert.equal(
    sanitizeNativeErrors({ error: "private" }).errors[0].category,
    "ERROR_FIELD_INVALID",
  );
  assert.equal(
    sanitizeNativeErrors({ error: { message: "x".repeat(65537) } }).errors[0]
      .category,
    "ERROR_TEXT_OVERSIZED",
  );
});
test("native error retention bounds early floods and emits only assigned-spec numeric locations", () => {
  const malformed = sanitizeNativeErrors({
    errors: "PRIVATE_SENTINEL_NOT_REAL",
  });
  assert.equal(malformed.error_collection_invalid, true);
  assert.equal(malformed.error_present, null);
  assert.equal(malformed.errors_seen, null);
  assert.equal(malformed.errors_omitted, null);
  const withKnown = sanitizeNativeErrors({
    errors: {},
    error: { message: "Test timeout of 30000ms exceeded." },
  });
  assert.equal(withKnown.error_present, true);
  assert.equal(withKnown.errors_seen, null);
  assert.equal(withKnown.errors[0].category, "TEST_TIMEOUT");
  assert.equal(
    sanitizeNativeErrors({
      error: {
        stack:
          " at https://example.invalid/tests/e2e/t02p-development-acceptance.spec.ts:2123:6",
      },
    }).errors[0].location,
    null,
  );
  const errors = Array.from({ length: 100 }, () => ({
    message: "PRIVATE_SENTINEL_NOT_REAL",
  }));
  errors[99] = {
    message: "Test timeout of 30000ms exceeded.",
    stack:
      " at /synthetic/tests/e2e/t02p-development-acceptance.spec.ts:2123:6",
  };
  errors[0] = {
    location: {
      file: "tests/e2e/t02p-development-acceptance.spec.ts",
      line: 2091,
      column: 4,
    },
  };
  errors[1] = {
    location: { file: "unrelated.ts", line: 900, column: 1 },
    stack: "https://example.invalid/private",
  };
  const out = sanitizeNativeErrors({ errors });
  assert.equal(out.errors_seen, 100);
  assert.equal(out.errors_retained, 8);
  assert.equal(out.errors_omitted, 92);
  assert.deepEqual(out.errors[0].location, { line: 2091, column: 4 });
  assert.equal(out.errors[1].location, null);
  assert.equal(out.errors.at(-1).category, "TEST_TIMEOUT");
  assert.deepEqual(out.errors.at(-1).location, { line: 2123, column: 6 });
  const body = JSON.stringify(out);
  for (const text of [
    "PRIVATE_SENTINEL",
    "example.invalid",
    "synthetic",
    "unrelated.ts",
    "stack",
  ])
    assert.ok(!body.includes(text));
});
const readyEvidence = (extra = {}) => ({
  activeFeed: "discover",
  layoutReady: "true",
  layoutRetained: false,
  mediaTerminal: true,
  masonryHeightMinusMaxItemBottom: 0,
  images: [
    {
      complete: true,
      naturalWidth: 320,
      currentSrc: "https://example.invalid/private",
    },
  ],
  items: [{ top: 0, height: 200 }],
  scrollTop: 900,
  clientHeight: 1141,
  masonryHeight: 200,
  ...extra,
});
test("readiness guards and signature changes emit scalars without raw evidence", () => {
  const r = readinessRecorder();
  r.phase(0);
  const call = r.begin("discover");
  r.eagerDone(call);
  r.sample(call, readyEvidence(), 1, false);
  r.sample(call, readyEvidence({ scrollTop: 0 }), 2, false);
  r.sample(
    call,
    readyEvidence({
      images: [{ complete: false, naturalWidth: 0 }],
      mediaTerminal: false,
    }),
    0,
    false,
  );
  const out = sanitizeReadiness(r.snapshot());
  assert.ok(out.rows.every((row) => row.length === READINESS_FIELDS.length));
  assert.ok(out.rows.some((row) => row[18] === 1 << 12));
  assert.ok(
    out.rows.some(
      (row) => row[11] === 1 && row[13] === false && row[19] === false,
    ),
  );
  assert.ok(!JSON.stringify(out).includes("example.invalid"));
  assert.ok(!JSON.stringify(out).includes("currentSrc"));
});
test("readiness early flood preserves first failure, its predecessor and every late call", () => {
  const make = () => {
    const r = readinessRecorder();
    const routes = [
      [0, "discover"],
      [1, "discover"],
      [0, "nearby"],
      [1, "nearby"],
      [0, "calligraphy"],
      [1, "calligraphy"],
      [2, "discover"],
      [2, "nearby"],
      [2, "calligraphy"],
    ];
    for (const [phase, feed] of routes) {
      r.phase(phase);
      const call = r.begin(feed);
      r.eagerDone(call);
      const v = readyEvidence({ activeFeed: feed });
      r.sample(call, v, 1, false);
      const changed = { ...v, masonryHeight: 201 };
      r.sample(call, changed, 1, false);
      for (let n = 0; n < 10000; n++) r.sample(call, changed, 2, true);
      r.sample(call, { ...changed, layoutRetained: true }, 0, false);
      r.sample(call, changed, 1, false);
      r.sample(call, changed, 3, true);
      r.settled(call);
    }
    return sanitizeReadiness(r.snapshot());
  };
  const a = make(),
    b = make();
  const actions = sanitizeActions({
    rows: ACTION_GROUPS.map((_, group) => [group, group * 2, group * 2 + 1, 1]),
    invalid: 0,
    overflow: 0,
  });
  const nativeErrors = sanitizeNativeErrors({
    errors: Array.from({ length: 8 }, () => ({
      message: "Test timeout of 30000ms exceeded.",
      location: {
        file: "tests/e2e/t02p-development-acceptance.spec.ts",
        line: 100000,
        column: 10000,
      },
    })),
  });
  const fullPacket = {
    readiness_fields: READINESS_FIELDS,
    action_group_dictionary: ACTION_GROUPS,
    attempts: [a, b].map((readiness) => ({
      readiness: { ...readiness, actions },
      native_errors: nativeErrors,
    })),
  };
  assert.ok(Buffer.byteLength(JSON.stringify(fullPacket)) < 131072);
  assert.equal(a.slots.length, 9);
  assert.equal(a.rows.length, 72);
  assert.equal(a.invalid, 0);
  assert.equal(a.overflow, 0);
  for (const slot of a.slots) {
    assert.equal(slot.retained, 8);
    assert.equal(slot.completed, true);
    const rows = a.rows.filter((row) => row[2] === slot.call);
    const failed = rows.find((row) => row[19] === false);
    assert.ok(failed);
    assert.ok(rows.some((row) => row[0] === failed[0] - 1));
    assert.ok(rows.some((row) => row[5] === 3));
  }
  assert.ok(Buffer.byteLength(JSON.stringify({ attempts: [a, b] })) < 131072);
});
test("readiness sanitizer rejects unsafe values, altered predicates and stage routes", () => {
  const r = readinessRecorder();
  const call = r.begin("discover");
  r.eagerDone(call);
  r.sample(call, readyEvidence(), 1, false);
  const value = r.snapshot();
  sanitizeReadiness(value);
  for (const unsafe of ["https://example.invalid", Infinity, {}, []]) {
    const changed = JSON.parse(JSON.stringify(value));
    changed.rows[2][15] = unsafe;
    assert.throws(() => sanitizeReadiness(changed));
  }
  for (const [at, v] of [
    [3, 2],
    [4, 3],
    [19, false],
    [10, 999],
    [16, 4],
    [18, 8192],
  ]) {
    const changed = JSON.parse(JSON.stringify(value));
    changed.rows[2][at] = v;
    assert.throws(() => sanitizeReadiness(changed));
  }
  const changed = JSON.parse(JSON.stringify(value));
  changed.slots[0].retained = 99;
  assert.throws(() => sanitizeReadiness(changed));
});
test("unknown and excess readiness calls remain explicit, never contaminate a late stage", () => {
  const r = readinessRecorder();
  r.phase(2);
  assert.equal(r.begin("discover"), undefined);
  assert.equal(r.snapshot().invalid, 1);
  r.phase(0);
  assert.equal(r.begin("discover"), 1);
  assert.equal(r.snapshot().slots.length, 1);
});

test("same-body readiness awaits retain completed and pending phases without another browser call", () => {
  const r = readinessRecorder();
  const call = r.begin("discover");
  r.evaluationBegin(call, 0);
  r.evaluationEnd(call, 0);
  r.evaluationBegin(call, 1);
  r.evaluationEnd(call, 1);
  r.sample(call, readyEvidence(), 1, false);
  const out = sanitizeReadiness(r.snapshot());
  const row = out.rows.find((row) => row[5] === 2);
  assert.equal(row.length, 26);
  assert.ok(
    row.slice(22).every((x, i, a) => x >= (a[i - 1] ?? 0) && x <= row[1]),
  );
  r.evaluationBegin(call, 0);
  const pending = sanitizeReadiness(r.snapshot()).slots[0].last_evaluation;
  assert.equal(pending[0], 0);
  assert.equal(pending[2], null);
  const changed = JSON.parse(JSON.stringify(out));
  changed.rows.find((row) => row[5] === 2)[24] =
    "https://example.invalid/private";
  assert.throws(() => sanitizeReadiness(changed));
});

test("independent touch reservation retains every hop and final unfinished boundary after early flood", () => {
  const r = readinessRecorder();
  const names = ["discover", "nearby", "inscriptions", "calligraphy"];
  const routes = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
    [0, 3],
    [1, 3],
    [1, 0],
    [1, 3],
    [1, 1],
    [1, 0],
    [1, 3],
    [2, 0],
    [2, 1],
    [2, 3],
  ];
  const ready = r.begin("discover");
  for (let n = 0; n < 10000; n++) r.sample(ready, readyEvidence(), 1, false);
  let active = 0;
  const align = (call, kind, target) => {
    r.touchOpBegin(call, kind, names[target]);
    r.alignmentResult(r.alignmentToken(), {
      frames: 1,
      elapsed_ms: 16,
      aligned: true,
      gap: 0,
    });
    r.touchOpEnd(call, kind);
  };
  for (const [index, [phase, target]] of routes.entries()) {
    r.phase(phase);
    const call = r.touchBegin(names[target]);
    align(call, 0, active);
    while (active !== target) {
      active += Math.sign(target - active);
      r.touchOpBegin(call, 1, names[active]);
      if (index === 13) break;
      r.touchOpEnd(call, 1);
      r.touchOpBegin(call, 2, names[active]);
      r.touchOpEnd(call, 2);
      align(call, 3, active);
    }
    if (index < 13) r.touchEnd(call);
  }
  const out = sanitizeReadiness(r.snapshot("timedOut", true));
  assert.equal(out.touches.calls.length, 14);
  assert.equal(out.touches.invalid, 0);
  assert.equal(out.touches.overflow, 0);
  assert.ok(out.touches.calls.slice(0, 13).every((c) => c.completed));
  const late = out.touches.calls[13];
  assert.equal(late.pending_kind, 1);
  assert.equal(late.rows.at(-1)[9], 3);
  assert.equal(late.rows.at(-1)[4], null);
  assert.equal(out.rows.length, 4);
  for (const value of ["https://example.invalid/private", Infinity, {}]) {
    const changed = JSON.parse(JSON.stringify(out));
    changed.touches.calls[0].rows[0][11] = value;
    assert.throws(() => sanitizeReadiness(changed));
  }
  const changed = JSON.parse(JSON.stringify(out));
  changed.touches.calls[13].pending_kind = 3;
  assert.throws(() => sanitizeReadiness(changed));
});

test("two retries with maximum readiness, touch, action and native-error capacity fit the packet bound", () => {
  const fields = Array(26).fill(1080000.123456789);
  const attempt = {
    readiness: {
      rows: Array.from({ length: 72 }, () => fields),
      slots: Array.from({ length: 9 }, (_, i) => ({
        call: i + 1,
        phase: 2,
        feed: 3,
        seen: 100000,
        retained: 8,
        omitted: 99992,
        completed: false,
        last_evaluation: [1, 1080000.123456789, null],
      })),
      touches: {
        calls: Array.from({ length: 14 }, (_, i) => ({
          call: i + 1,
          phase: 2,
          feed: 3,
          begin_ms: 1080000.123456789,
          end_ms: 1080000.123456789,
          completed: true,
          pending_kind: null,
          rows: Array.from({ length: 4 }, () =>
            Array(14).fill(1080000.123456789),
          ),
        })),
        invalid: 0,
        overflow: 0,
      },
      actions: {
        rows: Array.from({ length: 9 }, () => [
          8, 1080000.123456789, 1080000.123456789, 3,
        ]),
        invalid: 0,
        overflow: 0,
      },
    },
    native_errors: sanitizeNativeErrors({
      errors: Array.from({ length: 8 }, () => ({
        message: "Test timeout of 30000ms exceeded.",
        location: {
          file: "tests/e2e/t02p-development-acceptance.spec.ts",
          line: 100000,
          column: 10000,
        },
      })),
    }),
  };
  const bytes = Buffer.byteLength(
    JSON.stringify({ attempts: [attempt, attempt] }),
  );
  assert.ok(bytes + 16384 < 131072, `capacity ${bytes} plus 16KiB envelope`);
});
