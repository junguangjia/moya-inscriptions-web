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
  scanBuild,
  scanChunk,
} from "./check-browser-baseline.mjs";

const SCRIPT = fileURLToPath(
  new URL("./check-browser-baseline.mjs", import.meta.url),
);
const POLYFILL = "static/chunks/legacy-polyfill.js";
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
    JSON.stringify({ polyfillFiles: [POLYFILL], rootMainFiles: [] }),
  );
  for (const [name, source] of Object.entries(chunks))
    fs.writeFileSync(path.join(dir, name), source);
  return dir;
};
const apis = (source) => scanChunk(source, "chunk.js").map(({ api }) => api);
const run = (dir) =>
  spawnSync(process.execPath, [SCRIPT, "--next-dir", dir], {
    encoding: "utf8",
  });

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
    "URL.parse": 'URL.parse("/a",base)',
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
    assert.deepEqual(apis(`(function(a,b,e,f,s,u,v){${use}})()`), [api], use);
  assert.deepEqual(apis('AbortSignal["any"]([a])'), ["AbortSignal.any"]);
});

test("accepts feature-detected uses", () => {
  for (const guarded of [
    'typeof Promise.withResolvers=="function"?Promise.withResolvers():d()',
    '"checkVisibility"in e&&e.checkVisibility()',
    'if("full-native"===n&&"checkVisibility"in e)return!e.checkVisibility()',
    '"function"==typeof e.checkVisibility?e.checkVisibility():e.offsetWidth>0',
    "e.checkVisibility?.()",
    "window.requestIdleCallback?requestIdleCallback(f):setTimeout(f)",
    'function g(){if(typeof URL.parse!="function")return null;return URL.parse(s)}',
  ])
    assert.deepEqual(apis(`(function(e,n,f,s){${guarded}})`), [], guarded);
});

test("ignores names that are not references to the listed APIs", () => {
  for (const source of [
    '"requestIdleCallback is unavailable";',
    "const z={union:a=>a};z.union([a,b]);z.intersection(a,b);",
    "a.union(b);a.difference(b);",
    "({checkVisibility:1}).x;",
    "AbortSignal.timeout(15e3);",
    "a.groupBy(f);",
  ])
    assert.deepEqual(apis(source), [], source);
});

test("allows AbortSignal.any only in Uppy's upload chunk and as the installer's feature test", () => {
  const uppy =
    'const m="[XHRUpload] No files to upload!";r(a,{signal:AbortSignal.any([t,i.signal])});';
  assert.deepEqual(apis(uppy), []);
  const installer =
    '"function"!=typeof AbortSignal.any&&Object.defineProperty(AbortSignal,"any",{value:e=>{throw new TypeError("AbortSignal.any: not an AbortSignal")}});';
  assert.deepEqual(apis(installer), []);
  assert.deepEqual(apis(`${installer}AbortSignal.any([a]);`), [
    "AbortSignal.any",
  ]);
  // Feature-testing it elsewhere is still a finding: first-party code links
  // signals through the helper instead.
  assert.deepEqual(
    apis('typeof AbortSignal.any=="function"?AbortSignal.any(s):s[0]'),
    ["AbortSignal.any", "AbortSignal.any"],
  );
});

test("requires every client script to parse as ES2022", () => {
  const findings = scanChunk("const r=/[\\p{L}--[a-z]]/v;", "chunk.js");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].api, "ES2022 syntax");
  assert.deepEqual(apis("class A{#x=1;static{this.y=#x in this}}"), []);
});

test("scans a build, skipping only the noModule polyfill chunk", () => {
  const clean = build({
    "static/chunks/app.js": "(globalThis.TURBOPACK||=[]).push([1]);",
    [POLYFILL]: "Promise.withResolvers=function(){};Object.groupBy(a,f);",
  });
  const result = scanBuild(clean);
  assert.equal(result.missing, false);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.scanned, ["static/chunks/app.js"]);
  const pass = run(clean);
  assert.equal(pass.status, 0, pass.stderr);
  assert.match(pass.stdout, /Browser baseline: PASS \(1 client scripts/u);

  fs.mkdirSync(path.join(clean, "static/build-id"));
  fs.writeFileSync(
    path.join(clean, "static/build-id/page.js"),
    "Promise.withResolvers();",
  );
  const fail = run(clean);
  assert.equal(fail.status, 1);
  assert.match(
    fail.stderr,
    /static\/build-id\/page\.js:1:1 Promise\.withResolvers/u,
  );
  assert.match(fail.stdout, /Browser baseline: FAIL .*1 findings/u);
});

test("fails without a build output", () => {
  const empty = temporaryDir();
  const result = run(empty);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /run the Web build first/u);
});
