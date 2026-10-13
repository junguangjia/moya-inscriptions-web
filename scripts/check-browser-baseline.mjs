#!/usr/bin/env node
/**
 * Scans the built Web client for APIs above the supported browser floors
 * (Safari 16.4, Chrome 111, Firefox 121; docs/development/browser-support.md).
 *
 *   node scripts/check-browser-baseline.mjs [--next-dir apps/web/.next]
 *
 * Input: an existing `next build` output. Every `.js` file under
 * `<next-dir>/static` is parsed as an ES2022 script, except the `noModule`
 * legacy polyfill chunk that `build-manifest.json` lists in `polyfillFiles`
 * (modern engines never load it). Output: one line per finding and a summary;
 * exit 1 on any finding, exit 2 when the build output is missing. Read-only,
 * idempotent, no network and no credentials.
 *
 * A listed API is a finding unless it is feature-detected: used as a
 * `typeof` operand, an `in` test, a condition or an optional call, or tested
 * that way earlier in the same function. `AbortSignal.any` is stricter: it may
 * appear only in Uppy's XHR upload chunk (the installer in
 * apps/web/instrumentation-client.ts provides it there) and as the installer's
 * own feature test. The list is short and explicit; it is a tripwire for the
 * known post-baseline APIs, not a complete compatibility proof.
 */
import console from "node:console";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The workspace already ships acorn through eslint -> espree; no dependency
// is added for this check.
const loadAcorn = () => {
  const fromRoot = createRequire(path.join(root, "package.json"));
  const fromEslint = createRequire(fromRoot.resolve("eslint/package.json"));
  const fromEspree = createRequire(fromEslint.resolve("espree/package.json"));
  return fromEspree("acorn");
};

/** Static members: `Object.member`, also through globalThis/window/self. */
const statics = [
  ["AbortSignal", "any"],
  ["Promise", "withResolvers"],
  ["Promise", "try"],
  ["Object", "groupBy"],
  ["Map", "groupBy"],
  ["Array", "fromAsync"],
  ["Iterator", "from"],
  ["RegExp", "escape"],
  ["Uint8Array", "fromBase64"],
  ["Uint8Array", "fromHex"],
  ["URL", "parse"],
  ["Response", "json"],
  ["ReadableStream", "from"],
  ["scheduler", "postTask"],
].map(([object, member]) => ({ api: `${object}.${member}`, object, member }));

/** Instance methods, matched on any receiver at a call. */
const methods = [
  ["Set", "symmetricDifference"],
  ["Set", "isSubsetOf"],
  ["Set", "isSupersetOf"],
  ["Set", "isDisjointFrom"],
  ["Uint8Array", "toBase64"],
  ["Uint8Array", "toHex"],
  ["Uint8Array", "setFromBase64"],
  ["Uint8Array", "setFromHex"],
  ["Element", "checkVisibility"],
].map(([owner, member]) => ({ api: `${owner}.prototype.${member}`, member }));

/**
 * `union`, `intersection` and `difference` are also ordinary library method
 * names (zod's `z.union([...])` ships in the client), so these count only
 * when a `new Set(...)` is the receiver or the argument.
 */
const setMethods = ["union", "intersection", "difference"].map((member) => ({
  api: `Set.prototype.${member}`,
  member,
  setOnly: true,
}));

/** Global functions, also through globalThis/window/self. */
const globals = [{ api: "requestIdleCallback", name: "requestIdleCallback" }];

export const CHECKED_APIS = [
  ...statics,
  ...methods,
  ...setMethods,
  ...globals,
].map((entry) => entry.api);

const GLOBAL_OBJECTS = new Set(["globalThis", "window", "self"]);
/** Marker strings that identify the two places allowed to name AbortSignal.any. */
const UPPY_XHR_MARKER = "[XHRUpload]";
const INSTALLER_MARKER = "AbortSignal.any: not an AbortSignal";

const memberName = (node) =>
  node.type !== "MemberExpression"
    ? null
    : !node.computed && node.property.type === "Identifier"
      ? node.property.name
      : node.computed &&
          node.property.type === "Literal" &&
          typeof node.property.value === "string"
        ? node.property.value
        : null;

/** `name`, or `globalThis.name` / `window.name` / `self.name`. */
const isGlobalReference = (node, name) =>
  (node.type === "Identifier" && node.name === name) ||
  (memberName(node) === name &&
    node.object.type === "Identifier" &&
    GLOBAL_OBJECTS.has(node.object.name));

const isNewSet = (node) =>
  node?.type === "NewExpression" && isGlobalReference(node.callee, "Set");

const unwrapChain = (node) =>
  node.type === "ChainExpression" ? node.expression : node;

/** Visits every node with its ancestors (outermost first). */
const walk = (node, visit, ancestors = []) => {
  visit(node, ancestors);
  ancestors.push(node);
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value)
        if (child && typeof child.type === "string")
          walk(child, visit, ancestors);
    } else if (value && typeof value.type === "string")
      walk(value, visit, ancestors);
  }
  ancestors.pop();
};

/** Which listed API, if any, this node names. */
const classify = (node, parent) => {
  if (node.type === "MemberExpression") {
    const member = memberName(node);
    if (member === null) return null;
    for (const entry of statics)
      if (
        entry.member === member &&
        isGlobalReference(unwrapChain(node.object), entry.object)
      )
        return { ...entry, feature: member };
    for (const entry of globals)
      if (isGlobalReference(node, entry.name))
        return { ...entry, feature: entry.name };
    const call =
      parent?.type === "CallExpression" && parent.callee === node
        ? parent
        : null;
    if (call === null) return null;
    for (const entry of methods)
      if (entry.member === member) return { ...entry, feature: member };
    for (const entry of setMethods)
      if (
        entry.member === member &&
        (isNewSet(unwrapChain(node.object)) || isNewSet(call.arguments[0]))
      )
        return { ...entry, feature: member };
    return null;
  }
  if (node.type === "Identifier")
    for (const entry of globals)
      if (node.name === entry.name) return { ...entry, feature: entry.name };
  return null;
};

/** Whether this occurrence itself is a feature test rather than a use. */
const isFeatureTest = (node, ancestors) => {
  const parent = ancestors.at(-1);
  if (!parent) return false;
  if (parent.type === "UnaryExpression" && parent.operator === "typeof")
    return true;
  if (
    (parent.type === "IfStatement" ||
      parent.type === "ConditionalExpression") &&
    parent.test === node
  )
    return true;
  if (parent.type === "LogicalExpression" && parent.left === node) return true;
  if (parent.type === "UnaryExpression" && parent.operator === "!") return true;
  // `X.member?.()`: an optional call is its own guard.
  return (
    parent.type === "CallExpression" &&
    parent.callee === node &&
    parent.optional
  );
};

/** Feature tests by name: `typeof … .name`, `"name" in …`, `!x.name`, etc. */
const featureTestsIn = (node) => {
  const found = [];
  walk(node, (current, ancestors) => {
    if (
      current.type === "BinaryExpression" &&
      current.operator === "in" &&
      current.left.type === "Literal" &&
      typeof current.left.value === "string"
    )
      found.push({ name: current.left.value, start: current.start });
    const name =
      current.type === "Identifier" ? current.name : memberName(current);
    if (name !== null && isFeatureTest(current, ancestors))
      found.push({ name, start: current.start });
  });
  return found;
};

const lineColumn = (source, offset) => {
  let line = 1;
  let last = -1;
  for (let index = source.indexOf("\n"); index !== -1 && index < offset;) {
    line += 1;
    last = index;
    index = source.indexOf("\n", index + 1);
  }
  return `${line}:${offset - last}`;
};

/**
 * Scans one chunk's source. Returns the findings and whether it parsed as
 * ES2022; a parse failure is itself a finding.
 */
export const scanChunk = (source, file, acorn = loadAcorn()) => {
  let program;
  try {
    program = acorn.parse(source, {
      ecmaVersion: 2022,
      sourceType: "script",
      allowHashBang: true,
    });
  } catch (error) {
    return [
      {
        file,
        api: "ES2022 syntax",
        at: error.loc ? `${error.loc.line}:${error.loc.column + 1}` : "?",
        detail: error.message,
      },
    ];
  }
  const uppy = source.includes(UPPY_XHR_MARKER);
  const installer = source.includes(INSTALLER_MARKER);
  const functionTests = new Map();
  const testsBefore = (scope, feature, start) => {
    if (!functionTests.has(scope))
      functionTests.set(scope, featureTestsIn(scope));
    return functionTests
      .get(scope)
      .some((test) => test.name === feature && test.start < start);
  };
  const findings = [];
  walk(program, (node, ancestors) => {
    const parent = ancestors.at(-1);
    // A property key or a member name is not a reference to a global.
    if (
      node.type === "Identifier" &&
      ((parent?.type === "MemberExpression" &&
        parent.property === node &&
        !parent.computed) ||
        (parent?.type === "Property" &&
          parent.key === node &&
          !parent.computed))
    )
      return;
    const match = classify(node, parent);
    if (match === null) return;
    const featureTest = isFeatureTest(node, ancestors);
    if (match.api === "AbortSignal.any") {
      if (uppy || (installer && featureTest)) return;
    } else {
      if (featureTest) return;
      const scope =
        [...ancestors]
          .reverse()
          .find((ancestor) =>
            [
              "FunctionDeclaration",
              "FunctionExpression",
              "ArrowFunctionExpression",
            ].includes(ancestor.type),
          ) ?? program;
      if (testsBefore(scope, match.feature, node.start)) return;
    }
    findings.push({
      file,
      api: match.api,
      at: lineColumn(source, node.start),
      detail: source
        .slice(Math.max(0, node.start - 40), node.end + 40)
        .replace(/\s+/gu, " "),
    });
  });
  return findings;
};

/** Scans a whole `next build` output directory. */
export const scanBuild = (nextDir, acorn = loadAcorn()) => {
  const manifestPath = path.join(nextDir, "build-manifest.json");
  const staticDir = path.join(nextDir, "static");
  if (!fs.existsSync(manifestPath) || !fs.existsSync(staticDir))
    return { missing: true, findings: [], scanned: [], skipped: [] };
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const skipped = (manifest.polyfillFiles ?? []).map((file) =>
    path.normalize(file),
  );
  const scanned = [];
  const findings = [];
  const visit = (directory) => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.name.endsWith(".js")) {
        const relative = path.relative(nextDir, full);
        if (skipped.includes(path.normalize(relative))) continue;
        scanned.push(relative);
        findings.push(
          ...scanChunk(fs.readFileSync(full, "utf8"), relative, acorn),
        );
      }
    }
  };
  visit(staticDir);
  return { missing: false, findings, scanned, skipped };
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  const index = args.indexOf("--next-dir");
  const nextDir = path.resolve(
    index === -1 ? path.join(root, "apps/web/.next") : (args[index + 1] ?? ""),
  );
  const started = Date.now();
  const result = scanBuild(nextDir);
  const elapsed = Date.now() - started;
  if (result.missing) {
    console.error(
      `Browser baseline: no build output at ${path.relative(root, nextDir) || nextDir}; run the Web build first.`,
    );
    process.exitCode = 2;
  } else {
    for (const finding of result.findings)
      console.error(
        `${finding.file}:${finding.at} ${finding.api} — ${finding.detail}`,
      );
    console.log(
      `Browser baseline: ${result.findings.length === 0 ? "PASS" : "FAIL"} (${result.scanned.length} client scripts as ES2022, ${result.skipped.length} noModule polyfill skipped, ${CHECKED_APIS.length} APIs, ${result.findings.length} findings, ${elapsed}ms)`,
    );
    if (result.findings.length > 0) process.exitCode = 1;
  }
}
