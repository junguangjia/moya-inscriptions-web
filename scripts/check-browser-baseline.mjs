#!/usr/bin/env node
/**
 * Scans the built Web client for APIs above the supported browser floors
 * (Safari 16.4, Chrome 111, Firefox 121; docs/development/browser-support.md).
 *
 *   node scripts/check-browser-baseline.mjs [--next-dir <dir>]
 *
 * Input: an existing `next build` output (default apps/web/.next). Every `.js`
 * file under `<next-dir>/static` is parsed as an ES2022 script, except the
 * `noModule` legacy polyfill chunk that `build-manifest.json` lists in
 * `polyfillFiles` (modern engines never load it). Output: one line per finding
 * and a summary; exit 1 on any finding, exit 2 for a usage error or a missing
 * build. Read-only, idempotent, no network and no credentials. Its tests
 * (check-browser-baseline.spec.mjs) need the workspace's parser, so they run
 * in the Web build stage of verify.mjs, not with the dependency-free
 * scripts/*.test.mjs.
 *
 * A listed API is a finding unless it is feature-detected for that same API
 * (same object or receiver) in a way that cannot itself throw on the floor
 * engines: inside the branch of an if, ?:, && or || whose condition proves it
 * present, after an early exit whose condition proves it absent, or through an
 * optional call. `AbortSignal.any` is stricter: it may appear only inside
 * Uppy's XHR upload module and as the installer's own feature test, and only
 * when the installer ships in a root main file. The list is short and
 * explicit; it is a tripwire for known post-baseline APIs, not a complete
 * compatibility proof. Inline scripts in server-rendered HTML are not scanned.
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

/**
 * Static members: `Object.member`, also through globalThis/window/self. When
 * the namespace itself is missing at a floor (`namespace: true`), only a
 * test of the namespace that cannot throw counts as a guard.
 */
const statics = [
  ["AbortSignal", "any"],
  ["Promise", "withResolvers"],
  ["Promise", "try"],
  ["Object", "groupBy"],
  ["Map", "groupBy"],
  ["Array", "fromAsync"],
  ["Iterator", "from", true],
  ["RegExp", "escape"],
  ["Uint8Array", "fromBase64"],
  ["Uint8Array", "fromHex"],
  ["URL", "parse"],
  ["Response", "json"],
  ["ReadableStream", "from"],
  ["scheduler", "postTask", true],
].map(([object, member, namespace = false]) => ({
  kind: "static",
  api: `${object}.${member}`,
  object,
  member,
  namespace,
}));

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
].map(([owner, member]) => ({
  kind: "method",
  api: `${owner}.prototype.${member}`,
  member,
}));

/**
 * `union`, `intersection` and `difference` are also ordinary library method
 * names (zod's `z.union([...])` ships in the client), so these count only
 * when a `new Set(...)` is the receiver or the argument.
 */
const setMethods = ["union", "intersection", "difference"].map((member) => ({
  kind: "method",
  api: `Set.prototype.${member}`,
  member,
  setOnly: true,
}));

/** Global functions, also through globalThis/window/self. */
const globals = [
  { kind: "global", api: "requestIdleCallback", name: "requestIdleCallback" },
];

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
const FUNCTIONS = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

const memberName = (node) =>
  node?.type !== "MemberExpression"
    ? null
    : !node.computed && node.property.type === "Identifier"
      ? node.property.name
      : node.computed &&
          node.property.type === "Literal" &&
          typeof node.property.value === "string"
        ? node.property.value
        : null;

const unwrapChain = (node) =>
  node?.type === "ChainExpression" ? node.expression : node;

/** `globalThis.name` / `window.name` / `self.name`. */
const isGlobalMember = (node, name) =>
  memberName(node) === name &&
  node.object.type === "Identifier" &&
  GLOBAL_OBJECTS.has(node.object.name);

/** `name`, or `globalThis.name` / `window.name` / `self.name`. */
const isGlobalReference = (node, name) =>
  (node?.type === "Identifier" && node.name === name) ||
  isGlobalMember(node, name);

const isNewSet = (node) =>
  node?.type === "NewExpression" && isGlobalReference(node.callee, "Set");

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

/** An identifier that names a binding or a key rather than reading a value. */
const isNameOnly = (node, parent) =>
  (parent.type === "MemberExpression" &&
    parent.property === node &&
    !parent.computed) ||
  ([
    "Property",
    "MethodDefinition",
    "PropertyDefinition",
    "AccessorProperty",
  ].includes(parent.type) &&
    parent.key === node &&
    !parent.computed) ||
  (parent.type === "VariableDeclarator" && parent.id === node) ||
  (FUNCTIONS.has(parent.type) &&
    (parent.id === node || parent.params.includes(node))) ||
  (parent.type === "CatchClause" && parent.param === node) ||
  parent.type === "LabeledStatement" ||
  parent.type === "BreakStatement" ||
  parent.type === "ContinueStatement";

/** Which listed API, if any, this node uses. */
const classify = (node, parent, source) => {
  if (node.type === "MemberExpression") {
    const member = memberName(node);
    if (member === null) return null;
    for (const entry of statics)
      if (
        entry.member === member &&
        isGlobalReference(unwrapChain(node.object), entry.object)
      )
        return entry;
    for (const entry of globals)
      if (isGlobalMember(node, entry.name)) return entry;
    const call =
      parent?.type === "CallExpression" && parent.callee === node
        ? parent
        : null;
    if (call === null) return null;
    const receiver = unwrapChain(node.object);
    const key = source.slice(receiver.start, receiver.end);
    for (const entry of methods)
      if (entry.member === member) return { ...entry, receiver: key };
    for (const entry of setMethods)
      if (
        entry.member === member &&
        (isNewSet(receiver) || isNewSet(call.arguments[0]))
      )
        return { ...entry, receiver: key };
    return null;
  }
  if (node.type === "Identifier" && !isNameOnly(node, parent))
    for (const entry of globals) if (node.name === entry.name) return entry;
  return null;
};

/**
 * Whether `node` refers to the API in a way that is safe to evaluate on a
 * floor engine that lacks it. Under `typeof`, a bare global name is safe;
 * elsewhere only a property of an object that certainly exists is.
 */
const refersSafely = (node, use, source, underTypeof) => {
  node = unwrapChain(node);
  if (use.kind === "global")
    return (
      isGlobalMember(node, use.name) ||
      (underTypeof && node.type === "Identifier" && node.name === use.name)
    );
  if (use.kind === "method") {
    if (memberName(node) !== use.member) return false;
    const receiver = unwrapChain(node.object);
    return source.slice(receiver.start, receiver.end) === use.receiver;
  }
  if (use.namespace) {
    // Iterator / scheduler themselves may be missing: test the namespace.
    if (isGlobalMember(node, use.object)) return true;
    if (underTypeof && node.type === "Identifier" && node.name === use.object)
      return true;
    // `globalThis.Iterator?.from` cannot throw either.
    return (
      memberName(node) === use.member &&
      node.optional === true &&
      isGlobalMember(unwrapChain(node.object), use.object)
    );
  }
  return (
    memberName(node) === use.member &&
    isGlobalReference(unwrapChain(node.object), use.object)
  );
};

const isNullish = (node) =>
  (node.type === "Literal" && node.value === null && node.raw === "null") ||
  (node.type === "Identifier" && node.name === "undefined") ||
  (node.type === "UnaryExpression" && node.operator === "void");

/**
 * Whether the API is known to be present when `test` evaluates to `outcome`.
 * Recognizes `typeof X ==/!= "function"/"undefined"`, `"name" in X`, a truthy
 * or non-nullish `X`, and their combinations through !, && and ||.
 */
const proves = (test, use, source, outcome) => {
  if (!test) return false;
  switch (test.type) {
    case "ChainExpression":
      return proves(test.expression, use, source, outcome);
    case "SequenceExpression":
      return proves(test.expressions.at(-1), use, source, outcome);
    case "UnaryExpression":
      return (
        test.operator === "!" && proves(test.argument, use, source, !outcome)
      );
    case "LogicalExpression": {
      const left = (value) => proves(test.left, use, source, value);
      const right = (value) => proves(test.right, use, source, value);
      if (test.operator === "&&")
        return outcome
          ? left(true) || right(true)
          : left(false) && right(false);
      if (test.operator === "||")
        return outcome
          ? left(true) && right(true)
          : left(false) || right(false);
      return false;
    }
    case "BinaryExpression": {
      if (test.operator === "in")
        return (
          outcome &&
          test.left.type === "Literal" &&
          (use.kind === "global"
            ? test.left.value === use.name &&
              test.right.type === "Identifier" &&
              GLOBAL_OBJECTS.has(test.right.name)
            : use.kind === "method"
              ? test.left.value === use.member &&
                source.slice(test.right.start, test.right.end) === use.receiver
              : use.namespace
                ? test.left.value === use.object &&
                  test.right.type === "Identifier" &&
                  GLOBAL_OBJECTS.has(test.right.name)
                : test.left.value === use.member &&
                  isGlobalReference(test.right, use.object))
        );
      const equal = test.operator === "===" || test.operator === "==";
      const unequal = test.operator === "!==" || test.operator === "!=";
      if (!equal && !unequal) return false;
      const [typed, literal] =
        test.left.type === "UnaryExpression" && test.left.operator === "typeof"
          ? [test.left.argument, test.right]
          : test.right.type === "UnaryExpression" &&
              test.right.operator === "typeof"
            ? [test.right.argument, test.left]
            : [null, null];
      if (typed !== null) {
        if (
          literal.type !== "Literal" ||
          !refersSafely(typed, use, source, true)
        )
          return false;
        const present =
          (equal && literal.value === "function") ||
          (equal && literal.value === "object") ||
          (unequal && literal.value === "undefined");
        const absent =
          (equal && literal.value === "undefined") ||
          (unequal && literal.value === "function");
        return outcome ? present : absent;
      }
      // `X != null` / `X !== undefined` proves presence when true.
      const value = isNullish(test.right)
        ? test.left
        : isNullish(test.left)
          ? test.right
          : null;
      if (value === null || !refersSafely(value, use, source, false))
        return false;
      return unequal ? outcome : !outcome;
    }
    default:
      return outcome && refersSafely(test, use, source, false);
  }
};

const exits = (statement) =>
  [
    "ReturnStatement",
    "ThrowStatement",
    "BreakStatement",
    "ContinueStatement",
  ].includes(statement?.type) ||
  (statement?.type === "BlockStatement" && exits(statement.body.at(-1)));

/** Whether this use of the API is feature-detected for that same API. */
const isGuarded = (node, ancestors, use, source) => {
  const parent = ancestors.at(-1);
  // `x.member?.()`; for a missing namespace only `globalThis.X?.member`.
  if (
    use.kind !== "global" &&
    !use.namespace &&
    parent?.type === "CallExpression" &&
    parent.callee === node &&
    parent.optional
  )
    return true;
  if (use.kind === "global" && isGlobalMember(node, use.name)) {
    if (
      parent?.type === "CallExpression" &&
      parent.callee === node &&
      parent.optional
    )
      return true;
  }
  if (use.namespace && refersSafely(node, use, source, false)) return true;
  let child = node;
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const ancestor = ancestors[index];
    if (
      ancestor.type === "IfStatement" ||
      ancestor.type === "ConditionalExpression"
    ) {
      if (
        child === ancestor.consequent &&
        proves(ancestor.test, use, source, true)
      )
        return true;
      if (
        child === ancestor.alternate &&
        proves(ancestor.test, use, source, false)
      )
        return true;
    } else if (
      ancestor.type === "LogicalExpression" &&
      child === ancestor.right
    ) {
      if (
        ancestor.operator === "&&" &&
        proves(ancestor.left, use, source, true)
      )
        return true;
      if (
        ancestor.operator === "||" &&
        proves(ancestor.left, use, source, false)
      )
        return true;
    } else if (
      ancestor.type === "BlockStatement" ||
      ancestor.type === "Program" ||
      ancestor.type === "SwitchCase"
    ) {
      const body =
        ancestor.type === "SwitchCase" ? ancestor.consequent : ancestor.body;
      // An earlier `if (absent) return;` in the same statement list.
      for (const statement of body.slice(0, body.indexOf(child)))
        if (
          statement.type === "IfStatement" &&
          !statement.alternate &&
          exits(statement.consequent) &&
          proves(statement.test, use, source, false)
        )
          return true;
    }
    child = ancestor;
  }
  return false;
};

/** A feature test in itself (`typeof X`, `if (X)`), not a call of the API. */
const isTestPosition = (node, parent) =>
  (parent.type === "UnaryExpression" &&
    (parent.operator === "typeof" || parent.operator === "!")) ||
  ((parent.type === "IfStatement" || parent.type === "ConditionalExpression") &&
    parent.test === node) ||
  (parent.type === "LogicalExpression" && parent.left === node) ||
  (parent.type === "BinaryExpression" &&
    ["==", "!=", "===", "!=="].includes(parent.operator));

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
 * Scans one chunk's source. Returns its findings (a parse failure is one),
 * whether Uppy's upload module used AbortSignal.any, and whether the chunk
 * carries the installer.
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
    return {
      findings: [
        {
          file,
          api: "ES2022 syntax",
          at: error.loc ? `${error.loc.line}:${error.loc.column + 1}` : "?",
          detail: error.message,
        },
      ],
      uppyAbortSignalAny: false,
      installer: false,
    };
  }
  // Uppy's XHR upload module is the outermost function holding its marker.
  const uppyModules = new Set();
  let installer = false;
  walk(program, (node, ancestors) => {
    if (node.type !== "Literal" || typeof node.value !== "string") return;
    if (node.value.includes(UPPY_XHR_MARKER)) {
      const factory = ancestors.find((ancestor) =>
        FUNCTIONS.has(ancestor.type),
      );
      if (factory) uppyModules.add(factory);
    }
    if (node.value === INSTALLER_MARKER) installer = true;
  });
  const declaresGlobalName = (name) => {
    let declared = false;
    walk(program, (node, ancestors) => {
      const parent = ancestors.at(-1);
      if (
        !declared &&
        node.type === "Identifier" &&
        node.name === name &&
        parent &&
        isNameOnly(node, parent) &&
        parent.type !== "MemberExpression" &&
        !["Property", "MethodDefinition", "PropertyDefinition"].includes(
          parent.type,
        )
      )
        declared = true;
    });
    return declared;
  };
  const localGlobals = new Map();
  let uppyAbortSignalAny = false;
  let installerTest = false;
  const findings = [];
  walk(program, (node, ancestors) => {
    const parent = ancestors.at(-1);
    if (!parent) return;
    const use = classify(node, parent, source);
    if (use === null) return;
    if (use.kind === "global") {
      if (!localGlobals.has(use.name))
        localGlobals.set(use.name, declaresGlobalName(use.name));
      if (localGlobals.get(use.name)) return;
    }
    const testPosition = isTestPosition(node, parent);
    if (use.api === "AbortSignal.any") {
      if (ancestors.some((ancestor) => uppyModules.has(ancestor))) {
        uppyAbortSignalAny = true;
        return;
      }
      if (
        installer &&
        parent.type === "UnaryExpression" &&
        parent.operator === "typeof"
      ) {
        installerTest = true;
        return;
      }
    } else if (testPosition) {
      // A feature test is fine only if it cannot throw on a floor engine.
      if (
        refersSafely(
          node,
          use,
          source,
          parent.type === "UnaryExpression" && parent.operator === "typeof",
        )
      )
        return;
    } else if (isGuarded(node, ancestors, use, source)) return;
    findings.push({
      file,
      api: use.api,
      at: lineColumn(source, node.start),
      detail: source
        .slice(Math.max(0, node.start - 40), node.end + 40)
        .replace(/\s+/gu, " "),
    });
  });
  return {
    findings,
    uppyAbortSignalAny,
    installer: installer && installerTest,
  };
};

/** Scans a whole `next build` output directory. */
export const scanBuild = (nextDir, acorn = loadAcorn()) => {
  const manifestPath = path.join(nextDir, "build-manifest.json");
  const staticDir = path.join(nextDir, "static");
  if (!fs.existsSync(manifestPath) || !fs.existsSync(staticDir))
    return { missing: true, findings: [], scanned: [], skipped: [] };
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const normalize = (files) =>
    (Array.isArray(files) ? files : []).map((file) => path.normalize(file));
  const skipped = normalize(manifest.polyfillFiles);
  const rootMainFiles = normalize(manifest.rootMainFiles);
  const scanned = [];
  const findings = [];
  let uppyAbortSignalAny = false;
  let installerInRootMain = false;
  const visit = (directory) => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.name.endsWith(".js")) {
        const relative = path.normalize(path.relative(nextDir, full));
        if (skipped.includes(relative)) continue;
        scanned.push(relative);
        const result = scanChunk(
          fs.readFileSync(full, "utf8"),
          relative,
          acorn,
        );
        findings.push(...result.findings);
        uppyAbortSignalAny ||= result.uppyAbortSignalAny;
        if (result.installer && rootMainFiles.includes(relative))
          installerInRootMain = true;
      }
    }
  };
  visit(staticDir);
  // Uppy's own AbortSignal.any is acceptable only because the installer runs
  // before it on every page.
  if (uppyAbortSignalAny && !installerInRootMain)
    findings.push({
      file: "build-manifest.json",
      api: "AbortSignal.any",
      at: "rootMainFiles",
      detail:
        "Uppy calls AbortSignal.any but no root main file carries installAbortSignalAny (apps/web/instrumentation-client.ts)",
    });
  return { missing: false, findings, scanned, skipped };
};

/** `[--next-dir <dir>]` or `--next-dir=<dir>`; anything else is a usage error. */
export const parseArguments = (args) => {
  let nextDir = path.join(root, "apps/web/.next");
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith("--next-dir=") && arg.length > "--next-dir=".length)
      nextDir = arg.slice("--next-dir=".length);
    else if (
      arg === "--next-dir" &&
      args[index + 1] &&
      !args[index + 1].startsWith("--")
    )
      nextDir = args[(index += 1)];
    else return { error: `Unexpected argument: ${arg}` };
  }
  return { nextDir: path.resolve(nextDir) };
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.error) {
    console.error(
      `${parsed.error}\nUsage: node scripts/check-browser-baseline.mjs [--next-dir <dir>]`,
    );
    process.exit(2);
  }
  const started = Date.now();
  const result = scanBuild(parsed.nextDir);
  const elapsed = Date.now() - started;
  if (result.missing) {
    console.error(
      `Browser baseline: no build output at ${path.relative(root, parsed.nextDir) || parsed.nextDir}; run the Web build first.`,
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
