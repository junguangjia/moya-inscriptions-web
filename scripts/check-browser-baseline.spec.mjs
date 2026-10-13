// Tests for check-browser-baseline.mjs. They need the workspace's parser
// (acorn through eslint -> espree), so verify.mjs runs them in the Web build
// stage next to the scan; they are not one of the dependency-free
// scripts/*.test.mjs that the lightweight CI job runs without node_modules.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CHECKED_APIS,
  parseArguments,
  scanBuild,
  scanChunk,
} from "./check-browser-baseline.mjs";
import { verificationCommands } from "./verify.mjs";

const SCRIPT = fileURLToPath(
  new URL("./check-browser-baseline.mjs", import.meta.url),
);
const POLYFILL = "static/chunks/legacy-polyfill.js";
const ROOT_MAIN = "static/chunks/root-main.js";
const temporary = [];
after(() => {
  for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true });
});
const temporaryDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-baseline-"));
  temporary.push(dir);
  return dir;
};

/** A synthetic `next build` output with the given chunk sources. */
const build = (chunks) => {
  const dir = temporaryDir();
  fs.mkdirSync(path.join(dir, "static/chunks"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "build-manifest.json"),
    JSON.stringify({ polyfillFiles: [POLYFILL], rootMainFiles: [ROOT_MAIN] }),
  );
  for (const [name, source] of Object.entries(chunks))
    fs.writeFileSync(path.join(dir, name), source);
  return dir;
};
const apis = (source) =>
  scanChunk(source, "chunk.js").findings.map(({ api }) => api);
const run = (...args) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
const wrap = (body) => `(function(a,b,e,f,n,o,s,t,u,v){${body}})()`;

// Turbopack pushes [script, id, factory, id, factory, ...] per chunk.
const chunk = (...factories) =>
  `(globalThis.TURBOPACK||(globalThis.TURBOPACK=[])).push([null,${factories
    .map((body, index) => `${index + 1},e=>{${body}}`)
    .join(",")}]);`;
const UPPY =
  'const m="[XHRUpload] No files to upload!";r(a,{signal:AbortSignal.any([t,i.signal])});';
const INSTALLER =
  '"function"!=typeof AbortSignal.any&&Object.defineProperty(AbortSignal,"any",{value:function any(e){throw new TypeError("AbortSignal.any: not an AbortSignal")}});';

test("checks the agreed post-baseline APIs", () => {
  for (const api of [
    "AbortSignal.any",
    "Promise.withResolvers",
    "Promise.try",
    "Object.groupBy",
    "Map.groupBy",
    "Array.fromAsync",
    "Set.prototype.union",
    "Set.prototype.intersection",
    "Set.prototype.difference",
    "Set.prototype.symmetricDifference",
    "Set.prototype.isSubsetOf",
    "Set.prototype.isSupersetOf",
    "Set.prototype.isDisjointFrom",
    "Iterator.from",
    "RegExp.escape",
    "Uint8Array.fromBase64",
    "Uint8Array.fromHex",
    "Uint8Array.prototype.toBase64",
    "Uint8Array.prototype.toHex",
    "URL.parse",
    "Response.json",
    "ReadableStream.from",
    "Element.prototype.checkVisibility",
    "requestIdleCallback",
    "scheduler.postTask",
  ])
    assert.ok(CHECKED_APIS.includes(api), api);
});

test("reports each unguarded use, also through globalThis, window and self", () => {
  const uses = {
    "Promise.withResolvers": "Promise.withResolvers()",
    "Promise.try": "Promise.try(f)",
    "Object.groupBy": "Object.groupBy(a,f)",
    "Map.groupBy": "globalThis.Map.groupBy(a,f)",
    "Array.fromAsync": "Array.fromAsync(a)",
    "Iterator.from": "Iterator.from(a)",
    "RegExp.escape": "window.RegExp.escape(s)",
    "Uint8Array.fromBase64": "Uint8Array.fromBase64(s)",
    "Uint8Array.fromHex": "Uint8Array.fromHex(s)",
    "Uint8Array.prototype.toBase64": "b.toBase64()",
    "Uint8Array.prototype.toHex": "b.toHex()",
    "URL.parse": 'URL.parse("/a",b)',
    "Response.json": "Response.json(v)",
    "ReadableStream.from": "ReadableStream.from(a)",
    "Element.prototype.checkVisibility": "e.checkVisibility()",
    requestIdleCallback: "requestIdleCallback(f)",
    "scheduler.postTask": "self.scheduler.postTask(f)",
    "Set.prototype.isSubsetOf": "a.isSubsetOf(b)",
    "Set.prototype.union": "new Set(a).union(b)",
    "Set.prototype.difference": "a.difference(new Set(b))",
    "AbortSignal.any": "fetch(u,{signal:AbortSignal.any([a,b])})",
  };
  for (const [api, use] of Object.entries(uses))
    assert.deepEqual(apis(wrap(use)), [api], use);
  assert.deepEqual(apis('AbortSignal["any"]([a])'), ["AbortSignal.any"]);
});

test("accepts uses guarded by a test of the same API", () => {
  for (const guarded of [
    'typeof Promise.withResolvers=="function"?Promise.withResolvers():d()',
    '"withResolvers"in Promise&&Promise.withResolvers()',
    "Promise.withResolvers?.()",
    '"checkVisibility"in e&&e.checkVisibility()',
    'if("full-native"===n&&"checkVisibility"in e)return!e.checkVisibility()',
    '"function"==typeof e.checkVisibility?e.checkVisibility():e.offsetWidth>0',
    "e.checkVisibility?.()",
    "window.requestIdleCallback?requestIdleCallback(f):setTimeout(f)",
    '"undefined"!=typeof requestIdleCallback&&requestIdleCallback(f)',
    '"requestIdleCallback"in window&&requestIdleCallback(f)',
    "window.requestIdleCallback?.(f)",
    'if(typeof URL.parse!="function")return null;return URL.parse(s)',
    "if(!URL.parse){return null}return URL.parse(s)",
    'typeof URL.parse!="function"||URL.parse(s)',
    // A missing namespace is tested itself, in a way that cannot throw.
    "globalThis.scheduler?.postTask(f)",
    "window.scheduler?.postTask(f)",
    '"scheduler"in window&&scheduler.postTask(f)',
    "if(window.scheduler)return scheduler.postTask(f)",
    '"undefined"!=typeof Iterator&&Iterator.from(a)',
    "globalThis.Iterator?.from(a)",
  ])
    assert.deepEqual(apis(wrap(guarded)), [], guarded);
});

test("needs the guard to name the same API, before and around the use", () => {
  for (const [source, expected] of [
    // An unrelated condition, or a guard that comes after the use.
    ["if(e)return;Promise.withResolvers()", ["Promise.withResolvers"]],
    [
      'Promise.withResolvers();typeof Promise.withResolvers=="function"',
      ["Promise.withResolvers"],
    ],
    // The same member name on another object guards nothing.
    [
      '"number"!=typeof t.from&&ReadableStream.from(a)',
      ["ReadableStream.from"],
    ],
    ["if(o.parse)o.parse();return URL.parse(s)", ["URL.parse"]],
    [
      '"checkVisibility"in n&&e.checkVisibility()',
      ["Element.prototype.checkVisibility"],
    ],
    // A test inside an earlier nested function does not guard the outer use.
    [
      'function h(){return typeof URL.parse=="function"}h();URL.parse(s)',
      ["URL.parse"],
    ],
    // The branch must be the one where the API is present.
    ["URL.parse?0:URL.parse(s)", ["URL.parse"]],
    ["if(!URL.parse){URL.parse(s)}", ["URL.parse"]],
    ['typeof URL.parse=="function"||URL.parse(s)', ["URL.parse"]],
  ])
    assert.deepEqual(apis(wrap(source)), expected, source);
});

test("refuses guards that throw on the floor engines themselves", () => {
  for (const [source, api] of [
    [
      "requestIdleCallback?requestIdleCallback(f):setTimeout(f)",
      "requestIdleCallback",
    ],
    ["(requestIdleCallback||setTimeout)(f)", "requestIdleCallback"],
    ["if(requestIdleCallback)requestIdleCallback(f)", "requestIdleCallback"],
    ["requestIdleCallback?.(f)", "requestIdleCallback"],
    [
      '"function"==typeof scheduler.postTask&&scheduler.postTask(f)',
      "scheduler.postTask",
    ],
    ["scheduler.postTask?.(f)", "scheduler.postTask"],
    ['"function"==typeof Iterator.from?Iterator.from(a):a', "Iterator.from"],
    ["Iterator.from?Iterator.from(a):a", "Iterator.from"],
  ]) {
    const found = apis(wrap(source));
    assert.ok(
      found.length > 0 && found.every((entry) => entry === api),
      source,
    );
  }
});

test("ignores names that are not uses of the listed APIs", () => {
  for (const source of [
    '"requestIdleCallback is unavailable";',
    "const z={union:a=>a};z.union([a,b]);z.intersection(a,b);",
    "a.union(b);a.difference(b);",
    "({checkVisibility:1}).x;",
    "AbortSignal.timeout(15e3);",
    "a.groupBy(f);",
    "class X{requestIdleCallback(){}}",
    "class Y{requestIdleCallback=1}",
    "function requestIdleCallback(f){return setTimeout(f)}requestIdleCallback(g);",
  ])
    assert.deepEqual(apis(source), [], source);
});

test("allows AbortSignal.any only in Uppy's upload module and as the installer's test", () => {
  assert.deepEqual(apis(chunk(UPPY)), []);
  assert.equal(scanChunk(chunk(UPPY), "uppy.js").uppyAbortSignalAny, true);
  // First-party code in the same chunk as Uppy is not exempt.
  assert.deepEqual(
    apis(chunk(UPPY, "fetch(u,{signal:AbortSignal.any([a])})")),
    ["AbortSignal.any"],
  );
  assert.deepEqual(apis(INSTALLER), []);
  assert.equal(scanChunk(INSTALLER, "root.js").installer, true);
  assert.deepEqual(apis(`${INSTALLER}AbortSignal.any([a]);`), [
    "AbortSignal.any",
  ]);
  // Feature-testing it elsewhere is still a finding: first-party code links
  // signals through the helper instead.
  assert.deepEqual(
    apis('typeof AbortSignal.any=="function"?AbortSignal.any(s):s[0]'),
    ["AbortSignal.any", "AbortSignal.any"],
  );
});

test("requires the installer in a root main file whenever Uppy uses AbortSignal.any", () => {
  const ok = build({
    "static/chunks/uppy.js": chunk(UPPY),
    [ROOT_MAIN]: INSTALLER,
  });
  assert.deepEqual(scanBuild(ok).findings, []);
  const missing = build({
    "static/chunks/uppy.js": chunk(UPPY),
    [ROOT_MAIN]: "",
  });
  assert.deepEqual(
    scanBuild(missing).findings.map(({ api, at }) => `${api}@${at}`),
    ["AbortSignal.any@rootMainFiles"],
  );
  const elsewhere = build({
    "static/chunks/uppy.js": chunk(UPPY),
    "static/chunks/lazy.js": INSTALLER,
    [ROOT_MAIN]: "",
  });
  assert.equal(scanBuild(elsewhere).findings.length, 1);
});

test("requires every client script to parse as ES2022", () => {
  const { findings } = scanChunk("const r=/[\\p{L}--[a-z]]/v;", "chunk.js");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].api, "ES2022 syntax");
  assert.deepEqual(apis("class A{#x=1;static{this.y=#x in this}}"), []);
});

test("scans a build, skipping only the noModule polyfill chunk", () => {
  const clean = build({
    [ROOT_MAIN]: "(globalThis.TURBOPACK||=[]).push([1]);",
    [POLYFILL]: "Promise.withResolvers=function(){};Object.groupBy(a,f);",
  });
  const result = scanBuild(clean);
  assert.equal(result.missing, false);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.scanned, [path.normalize(ROOT_MAIN)]);
  const pass = run("--next-dir", clean);
  assert.equal(pass.status, 0, pass.stderr);
  assert.match(pass.stdout, /Browser baseline: PASS \(1 client scripts/u);

  fs.mkdirSync(path.join(clean, "static/build-id"));
  fs.writeFileSync(
    path.join(clean, "static/build-id/page.js"),
    "Promise.withResolvers();",
  );
  const fail = run(`--next-dir=${clean}`);
  assert.equal(fail.status, 1);
  assert.match(
    fail.stderr,
    /static\/build-id\/page\.js:1:1 Promise\.withResolvers/u,
  );
  assert.match(fail.stdout, /Browser baseline: FAIL .*1 findings/u);
});

test("refuses unknown arguments and a missing build output", () => {
  assert.equal(parseArguments(["--next-dir", "x"]).nextDir, path.resolve("x"));
  assert.equal(parseArguments(["--next-dir=y"]).nextDir, path.resolve("y"));
  for (const args of [
    ["--next-dir"],
    ["--next-dir", "--x"],
    ["--bogus"],
    ["dir"],
  ])
    assert.ok(parseArguments(args).error, args.join(" "));
  assert.equal(run("--bogus").status, 2);
  const empty = run("--next-dir", temporaryDir());
  assert.equal(empty.status, 2);
  assert.match(empty.stderr, /run the Web build first/u);
});

test("runs right after every Web build in verify.mjs", () => {
  const spec = [
    process.execPath,
    "--test",
    "scripts/check-browser-baseline.spec.mjs",
  ];
  const scan = [process.execPath, "scripts/check-browser-baseline.mjs"];
  const followsBuild = (commands, index) => {
    assert.deepEqual(commands[index + 1], spec);
    assert.deepEqual(commands[index + 2], scan);
  };
  const plan = (mode, workspaces) => ({
    mode,
    selection: "quick",
    ...(workspaces ? { workspaces } : {}),
  });
  const buildStage = verificationCommands(plan("build"));
  followsBuild(
    buildStage,
    buildStage.findIndex((command) => command.join(" ") === "pnpm build"),
  );
  const all = verificationCommands(plan("all"));
  followsBuild(
    all,
    all.findIndex((command) => command.includes("turbo")),
  );
  for (const mode of ["build", "all"]) {
    const scoped = verificationCommands(plan(mode, ["web", "@moya/tests"]));
    followsBuild(
      scoped,
      scoped.findIndex((command) => command.includes("--filter=web")),
    );
    const other = verificationCommands(plan(mode, ["admin"]));
    assert.ok(
      !other.some((command) => command.join(" ").includes("browser-baseline")),
    );
  }
});
