#!/usr/bin/env node
// Incremental core-credential checks; exact content, one delivery budget.
import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  existsSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const VERSION = 2;
export const INSTALL_DIR = "confidentiality-hooks";
export const INSTALLED_FILES = [
  "pre-commit",
  "commit-msg",
  "pre-push",
  "confidentiality-scan.mjs",
];
const MAX_BYTES = 64 * 1024 * 1024;
const BUDGET_MS = 120000;
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const ZERO = /^0+$/;
const SELF = fileURLToPath(import.meta.url);
export const digest = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
const RULE_VERSION = digest(readFileSync(SELF));
let deadline = Infinity;
let cache = {};
let stats = { scanned: 0, reused: 0, commits: 0 };
export class Stop extends Error {
  constructor(category, location = ".") {
    super(category);
    this.category = category;
    this.location = location;
  }
}
function remaining() {
  const ms = Math.floor(deadline - Date.now());
  if (ms <= 0) throw new Stop("BUDGET_EXHAUSTED");
  return Math.min(BUDGET_MS, ms);
}
export function git(args, options = {}) {
  const result = spawnSync(
    "git",
    [
      "--no-lazy-fetch",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "diff.external=",
      ...args,
    ],
    {
      cwd: options.cwd,
      input: options.input,
      maxBuffer: MAX_BYTES,
      timeout: remaining(),
      killSignal: "SIGKILL",
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_NO_LAZY_FETCH: "1",
        GIT_OPTIONAL_LOCKS: "0",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  if (result.error || result.status !== 0)
    throw new Stop(
      result.error?.code === "ETIMEDOUT"
        ? "BUDGET_EXHAUSTED"
        : "GIT_READ_FAILED",
    );
  if (options.binary) return result.stdout;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
  } catch {
    throw new Stop("GIT_TEXT_UNREADABLE");
  }
}
export function config(key) {
  return git(["config", "--local", "--get", key]).trim();
}
function commonDir() {
  return realpathSync(
    git(["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim(),
  );
}
function currentRepository() {
  let dir = process.cwd(),
    admin = process.env.GIT_DIR;
  if (!admin) {
    for (;;) {
      const candidate = path.join(dir, ".git");
      if (existsSync(candidate)) {
        admin = candidate;
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) throw new Stop("NOT_A_GIT_WORKTREE");
      dir = parent;
    }
  }
  admin = path.resolve(admin);
  if (lstatSync(admin).isFile()) {
    const match = /^gitdir: (.+)\s*$/.exec(readFileSync(admin, "utf8"));
    if (!match) throw new Stop("GIT_DIRECTORY_UNREADABLE");
    admin = path.resolve(path.dirname(admin), match[1]);
  }
  const gitDir = realpathSync(admin);
  const commonFile = path.join(gitDir, "commondir");
  const common = process.env.GIT_COMMON_DIR
    ? path.resolve(process.env.GIT_COMMON_DIR)
    : existsSync(commonFile)
      ? path.resolve(gitDir, readFileSync(commonFile, "utf8").trim())
      : gitDir;
  return { gitDir, common: realpathSync(common) };
}
function regularBytes(file) {
  const info = lstatSync(file);
  if (!info.isFile() || info.size > MAX_BYTES)
    throw new Stop("TEXT_INPUT_UNREADABLE", path.basename(file));
  return readFileSync(file);
}
const PLACEHOLDER =
  /^(?:<[^<>\r\n]+>|\$\{[^{}\r\n]+\}|\$[A-Z_][A-Z0-9_]*|__[A-Z0-9_]+__|(?:EXAMPLE|PLACEHOLDER|REPLACE_ME|REDACTED|SYNTHETIC|TEST_ONLY|YOUR)(?:[_-][A-Z0-9_-]+)?|(?:example|placeholder|synthetic|fictional|test-only|dummy|fake|changeme|test|testing)(?:[-_][a-z0-9_-]+)?)$/i;
const PRIMITIVE =
  /^(?:string|number|boolean|unknown|never|any|void|undefined|null|false|true)$/;
const CREDENTIAL_NAME =
  /^(?:(?:[A-Za-z0-9]+[_-])*(?:password|passwd|pwd|secret[_-]?(?:access[_-]?)?key|api[_-]?key|access[_-]?token|refresh[_-]?token|security[_-]?token|session[_-]?token|client[_-]?secret|token)|(?:db|database|cos|cloud)?(?:Password|SecretKey|ApiKey|AccessToken|RefreshToken)|authorization|cookie)$/i;
function syntax(filename) {
  return /\.(?:[cm]?js|jsx|tsx?|py)$/i.test(filename)
    ? "code"
    : /(?:^|\.)env(?:\.|$)|\.(?:ini|conf|service|timer|ya?ml|json|toml)$/i.test(
          filename,
        )
      ? "config"
      : "text";
}
function placeholder(value) {
  return (
    !value ||
    value === "..." ||
    PLACEHOLDER.test(value) ||
    /^EXPLICIT_SYNTHETIC_PLACEHOLDER$/i.test(value)
  );
}
const pnpmLock = (filename) => path.basename(filename) === "pnpm-lock.yaml";
const syntaxContext = (filename) =>
  syntax(filename) +
  (pnpmLock(filename) ? ":pnpm-lock" : "") +
  (/\.swift$/i.test(filename) ? ":swift" : "") +
  (/\.(?:[cm]?js|ts)$/i.test(filename) ? ":javascript" : "");
// Conservative lexical proof for the two source-only exemptions below. Plain
// templates and Swift multiline strings stay opaque; interpolation declines.
// Only a JS regex immediately after an opening parenthesis is unambiguous here.
// Other slash syntax and Swift raw strings decline the exemption; this is not a
// general-purpose language parser.
function sourcePosition(text, at, swift = false) {
  // Unmodeled line separators, legacy HTML-close and hashbang comments can
  // change where a quoted region starts. Decline the exemption instead of
  // guessing, even when they occur in an otherwise harmless string.
  if (/[\u2028\u2029]|-->|#!/.test(text.slice(0, at))) return false;
  let quote = null,
    comment = 0;
  for (let i = 0; i < at; i++) {
    if (comment === -1) {
      if (text[i] === "\n" || text[i] === "\r") comment = 0;
    } else if (comment > 0) {
      if (swift && text.startsWith("/*", i)) {
        comment++;
        i++;
      } else if (text.startsWith("*/", i)) {
        comment--;
        i++;
      }
    } else if (quote) {
      if (
        (quote === "`" && text.startsWith("${", i)) ||
        (swift && text.startsWith("\\(", i))
      )
        return false;
      if (text[i] === "\\") i++;
      else if (text.startsWith(quote, i)) {
        i += quote.length - 1;
        quote = null;
      }
    } else if (text.startsWith("//", i)) {
      comment = -1;
      i++;
    } else if (text.startsWith("/*", i)) {
      comment = 1;
      i++;
    } else if (text[i] === "/") {
      if (swift || !text.slice(0, i).trimEnd().endsWith("(")) return false;
      let inClass = false,
        closed = false;
      for (i++; i < at; i++) {
        if (text[i] === "\n" || text[i] === "\r") return false;
        if (text[i] === "\\") i++;
        else if (text[i] === "[") inClass = true;
        else if (text[i] === "]") inClass = false;
        else if (text[i] === "/" && !inClass) {
          closed = true;
          break;
        }
      }
      if (!closed) return false;
    } else if (swift && text[i] === "#") return false;
    // JS-in-.js can contain JSX. Only the unambiguous numeric comparison
    // prefix needed here is accepted; possible tags and type syntax decline.
    else if (
      !swift &&
      text[i] === "<" &&
      !/^[ \t]*\d+(?:\.\d+)?\b/.test(text.slice(i + 1))
    )
      return false;
    else if (swift && text.startsWith('"""', i)) {
      quote = '"""';
      i += 2;
    } else if (/['"`]/.test(text[i])) quote = text[i];
  }
  return quote === null && comment === 0;
}
function packageVersionContext(text, at, name, value, filename, operator) {
  if (
    !pnpmLock(filename) ||
    operator !== ":" ||
    !/^lockfileVersion:[ \t]*(['"]?)9\.0\1[ \t]*$/m.test(text)
  )
    return false;
  const lineStart = text.lastIndexOf("\n", at - 1) + 1;
  const lineEnd = text.indexOf("\n", at);
  const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
  const entry =
    /^ {6}(['"]?)(@[-\w.]+\/[-\w.]+|[-\w.]+)\1:[ \t]+(['"]?)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\3[ \t]*$/.exec(
      line,
    );
  if (!entry || entry[4] !== value) return false;
  // The scanner revisits nested matches, including the passwd suffix in
  // parse-passwd. Each match must end at this exact validated package key.
  const keyStart = lineStart + 6;
  const keyEnd = keyStart + entry[1].length + entry[2].length;
  if (
    at < keyStart ||
    at >= keyEnd ||
    ![name, entry[1] + name].includes(text.slice(at, keyEnd))
  )
    return false;
  const parents = [];
  for (const previous of text.slice(0, lineStart).split("\n")) {
    if (!previous.trim() || previous.trimStart().startsWith("#")) continue;
    const indentation = previous.length - previous.trimStart().length;
    while (parents.length && parents.at(-1).indentation >= indentation)
      parents.pop();
    const mapping = /^ *(.*):[ \t]*$/.exec(previous);
    if (mapping) parents.push({ indentation, key: mapping[1] });
  }
  return (
    parents.length === 3 &&
    parents[0].indentation === 0 &&
    parents[0].key === "snapshots" &&
    parents[1].indentation === 2 &&
    /^(['"]?)(?:@[-\w.]+\/[-\w.]+|[-\w.]+)@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\1$/.test(
      parents[1].key,
    ) &&
    parents[2].indentation === 4 &&
    /^(?:dependencies|optionalDependencies)$/.test(parents[2].key)
  );
}
function placeholderCookie(value) {
  const entries = value
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return (
    entries.length > 0 &&
    entries.every((entry) => {
      const pair = /^[A-Za-z_][\w-]*=([^;]*)$/.exec(entry);
      return pair && PLACEHOLDER.test(pair[1]);
    })
  );
}
function literalFindings(text, filename) {
  const hits = [];
  const add = (at, category) =>
    hits.push({
      line: text.slice(0, at).split("\n").length,
      category,
      severity: "BLOCK",
    });
  for (const m of text.matchAll(
    /-----BEGIN (?:[A-Z0-9 ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----/g,
  ))
    add(m.index, "PRIVATE_KEY");
  for (const m of text.matchAll(
    /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-(?:proj-)?[A-Za-z0-9_-]{24,})\b/g,
  ))
    add(m.index, "API_TOKEN");
  for (const m of text.matchAll(
    /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=_-]{12,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/g,
  ))
    add(m.index, "AUTH_MATERIAL");
  const assignment =
    /(?:\b([A-Za-z_][\w-]*)|["']([A-Za-z_][\w-]*)["'])[ \t]*(:=|===|!==|==|!=|=(?!=|>)|:(?!=))[ \t]*(?:(["'])([^\r\n]*?)\4|([^\s,;#{}()[\]"'`]+))/g;
  let m;
  while ((m = assignment.exec(text))) {
    // Inspect nested assignments, e.g. systemd Environment="API_KEY=...".
    assignment.lastIndex = m.index + 1;
    const name = m[1] ?? m[2];
    if (!CREDENTIAL_NAME.test(name)) continue;
    const operator = m[3];
    const quoted = Boolean(m[4]);
    let value = m[5] ?? m[6];
    if (!quoted && syntax(filename) === "code") value = value.replace(/:$/, "");
    if (
      syntax(filename) === "code" &&
      quoted &&
      /^(?:===|!==|==|!=)$/.test(operator) &&
      /^(?:undefined|object|boolean|number|bigint|string|symbol|function)$/.test(
        value,
      ) &&
      /\btypeof[ \t]+(?:[A-Za-z_$][\w$]*[ \t]*(?:\?\.|\.)[ \t]*)*$/.test(
        text.slice(Math.max(0, m.index - 512), m.index),
      )
    )
      continue;
    if (packageVersionContext(text, m.index, name, value, filename, operator))
      continue;
    const afterValue = text.slice(m.index + m[0].length);
    const expressionEnd = /^[ \t]*(?:$|[,;)}\]\r\n]|\/\/)/;
    // This documented environment switch disables implicit authentication.
    // Its name alone, other values and other token fields receive no exemption.
    if (
      name === "HF_HUB_DISABLE_IMPLICIT_TOKEN" &&
      /^(?:=|:)$/.test(operator) &&
      value === "1" &&
      /^(?:code|config)$/.test(syntax(filename)) &&
      (expressionEnd.test(afterValue) || /^[ \t]*#/.test(afterValue))
    )
      continue;
    // Swift optional absence predicates contain no password value. Keep Swift
    // distinct in the cache without treating arbitrary Swift text as JS code.
    if (
      /\.swift$/i.test(filename) &&
      !quoted &&
      /^(?:==|!=)$/.test(operator) &&
      value === "nil" &&
      (expressionEnd.test(afterValue) ||
        /^[ \t]*(?:&&|\|\|)/.test(afterValue)) &&
      sourcePosition(text, m.index, true)
    )
      continue;
    // A semicolon-terminated JS declaration with a prefix increment is numeric.
    // A newline is not a terminator: it can continue into a string expression.
    if (
      /\.(?:[cm]?js|ts)$/i.test(filename) &&
      !quoted &&
      operator === "=" &&
      /^\+\+[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(value) &&
      /^[ \t]*;/.test(afterValue) &&
      /^[ \t]*(?:const|let|var)[ \t]+$/.test(
        text.slice(text.lastIndexOf("\n", m.index - 1) + 1, m.index),
      ) &&
      sourcePosition(text, m.index)
    )
      continue;
    // A closing source string followed by concatenation is not a literal value.
    if (syntax(filename) === "code" && /^\s*\+\s*$/.test(value)) continue;
    // Package versions and auth field declarations are not auth material.
    if (
      /^authorization$/i.test(name) &&
      !/^(?:Bearer|Basic)\s+\S{12,}$/.test(value)
    )
      continue;
    if (/^cookie$/i.test(name) && !/\b[A-Za-z_][\w-]*=[^;\s]{12,}/.test(value))
      continue;
    if (/^cookie$/i.test(name) && placeholderCookie(value)) continue;
    if (
      !quoted &&
      value === "$" &&
      /^\{[A-Za-z_][A-Za-z0-9_]*\}/.test(text.slice(m.index + m[0].length))
    )
      continue;
    if (placeholder(value) || (!quoted && PRIMITIVE.test(value))) continue;
    if (
      !quoted &&
      /^(?:process\.env(?:\.|$)|import\.meta\.env(?:\.|$)|os\.environ(?:\.|$)|getenv$|env$)/.test(
        value,
      )
    )
      continue;
    if (
      !quoted &&
      syntax(filename) === "code" &&
      /^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*$/.test(value)
    )
      continue;
    if (
      !quoted &&
      syntax(filename) !== "config" &&
      m[0].includes(":") &&
      /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(value)
    )
      continue;
    if (quoted || syntax(filename) === "config" || m[0].includes("="))
      add(m.index, "CREDENTIAL_LITERAL");
  }
  for (const m of text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+/gi)) {
    try {
      const u = new URL(m[0]);
      if (u.password && !placeholder(decodeURIComponent(u.password)))
        add(m.index, "PASSWORD_CONNECTION_URL");
      for (const [key, value] of u.searchParams) {
        if (
          /^(?:q-signature|x-amz-signature|signature|sig|access_token|refresh_token|token)$/i.test(
            key,
          ) &&
          value.length >= 12 &&
          !placeholder(value)
        )
          add(m.index, "AUTHORIZING_URL");
      }
    } catch {
      /* Incomplete code fragment. */
    }
  }
  return [...new Map(hits.map((h) => [JSON.stringify(h), h])).values()];
}
export function categories(text, filename = "") {
  return [
    ...new Set(literalFindings(text, filename).map((f) => f.category)),
  ].sort();
}
function safePath(label) {
  return categories(label).length
    ? "[credential-in-filename]"
    : label.replace(/[\x00-\x1f\x7f]/g, "?");
}
export function inspect(bytes, label = ".", filename = label) {
  remaining();
  const nameHits = literalFindings(filename, "");
  const key = digest(
    Buffer.from(
      RULE_VERSION + "\0" + syntaxContext(filename) + "\0" + digest(bytes),
    ),
  );
  let findings = cache[key];
  if (findings) stats.reused++;
  else {
    stats.scanned++;
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      /* Ordinary binary. */
    }
    findings =
      text === undefined || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)
        ? [{ line: 1, category: "BINARY_NOT_TEXT_SCANNED", severity: "WARN" }]
        : literalFindings(text, filename);
    cache[key] = findings;
  }
  remaining();
  return [...nameHits, ...findings].map((f) => ({
    path: safePath(label),
    ...f,
  }));
}
export function health() {
  const directory = path.join(commonDir(), INSTALL_DIR);
  const bytes = regularBytes(path.join(directory, "manifest.json"));
  const manifest = JSON.parse(bytes);
  if (
    digest(bytes) !== config("confidentiality.manifestSha256") ||
    manifest.version !== VERSION
  )
    throw new Stop("INSTALL_VERSION_MISMATCH");
  if (git(["config", "--get", "core.hooksPath"]).trim() !== directory)
    throw new Stop("ACTIVE_HOOKS_DIFFER");
  for (const f of INSTALLED_FILES) {
    const p = path.join(directory, f);
    if (digest(regularBytes(p)) !== manifest.files[f])
      throw new Stop("INSTALLED_FILE_CHANGED");
    if (f !== "confidentiality-scan.mjs" && !(lstatSync(p).mode & 0o111))
      throw new Stop("HOOK_NOT_EXECUTABLE");
  }
  if (manifest.files["confidentiality-scan.mjs"] !== RULE_VERSION)
    throw new Stop("SCANNER_VERSION_MISMATCH");
  return { version: VERSION, manifestSha256: digest(bytes) };
}
function blob(oid, label, mode, findings) {
  if (!OID.test(oid)) throw new Stop("GIT_OBJECT_UNREADABLE", label);
  if (mode === "160000") {
    findings.push({
      path: safePath(label),
      line: 1,
      category: "SUBMODULE_CONTENT_NOT_INCLUDED",
      severity: "WARN",
    });
    return;
  }
  if (!["100644", "100755", "120000"].includes(mode))
    throw new Stop("GIT_MODE_UNREADABLE", label);
  findings.push(
    ...inspect(git(["cat-file", "blob", oid], { binary: true }), label),
  );
}
function rawBlobs(records, findings) {
  for (let i = 0; i < records.length && records[i]; i += 2) {
    const m = /^:(\d{6}) (\d{6}) ([a-f0-9]+) ([a-f0-9]+) ([A-Z])$/.exec(
      records[i],
    );
    const file = records[i + 1];
    if (!m || !file || m[5] === "U")
      throw new Stop("CHANGED_CONTENT_UNDETERMINED");
    findings.push(...inspect(Buffer.alloc(0), file));
    if (m[5] !== "D") blob(m[4], file, m[2], findings);
  }
}
export function staged() {
  const findings = [];
  rawBlobs(
    git([
      "diff",
      "--cached",
      "--raw",
      "--abbrev=64",
      "-z",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
    ]).split("\0"),
    findings,
  );
  return findings;
}
export function message(file) {
  return inspect(regularBytes(file), "[commit-message]");
}
function metadata(oid, type, findings) {
  findings.push(
    ...inspect(
      Buffer.from(git(["cat-file", type, oid])),
      `[${type} ${oid.slice(0, 12)}]`,
      "[metadata]",
    ),
  );
}
function peel(oid, findings, inspectTags) {
  for (let depth = 0; depth < 8; depth++) {
    if (!OID.test(oid)) throw new Stop("PUSH_OBJECT_UNDETERMINED");
    const type = git(["cat-file", "-t", oid]).trim();
    if (type === "commit") return oid;
    if (type !== "tag") throw new Stop("PUSH_TARGET_UNDETERMINED");
    if (inspectTags) metadata(oid, "tag", findings);
    oid = /^object ([a-f0-9]+)\n/.exec(git(["cat-file", "tag", oid]))?.[1];
  }
  throw new Stop("TAG_DEPTH_LIMIT");
}
function changedBlobs(commit, findings) {
  const raw = git(["cat-file", "commit", commit]);
  const parents = [
    ...raw.slice(0, raw.indexOf("\n\n")).matchAll(/^parent ([a-f0-9]+)$/gm),
  ].map((m) => m[1]);
  for (const parent of parents.length ? parents : [null]) {
    rawBlobs(
      git([
        "diff-tree",
        "--no-commit-id",
        "-r",
        "--raw",
        "--abbrev=64",
        "-z",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        ...(parent ? [parent, commit] : ["--root", commit]),
      ]).split("\0"),
      findings,
    );
  }
}
export function push(remote, input) {
  const findings = [],
    visited = new Set();
  let newBranchBase;
  for (const line of input.trim().split("\n").filter(Boolean)) {
    const fields = line.split(" ");
    if (fields.length !== 4 || !OID.test(fields[1]) || !OID.test(fields[3]))
      throw new Stop("PUSH_INPUT_UNDETERMINED");
    const [localRef, localOid, remoteRef, remoteOid] = fields;
    findings.push(
      ...inspect(Buffer.from(localRef + "\n" + remoteRef), "[ref-name]"),
    );
    if (ZERO.test(localOid)) continue;
    const tip = peel(localOid, findings, true);
    let base;
    if (!ZERO.test(remoteOid)) base = peel(remoteOid, findings, false);
    else {
      if (newBranchBase === undefined) {
        const rows = git(["ls-remote", "--symref", "--", remote, "HEAD"])
          .trim()
          .split("\n");
        const head = rows
          .map((row) => /^([a-f0-9]+)\tHEAD$/.exec(row)?.[1])
          .find(Boolean);
        newBranchBase = head ? peel(head, findings, false) : null;
      }
      base = newBranchBase;
    }
    const commits = git([
      "rev-list",
      "--reverse",
      "--topo-order",
      tip,
      ...(base ? ["^" + base] : []),
    ])
      .trim()
      .split("\n")
      .filter(Boolean);
    for (const commit of commits) {
      if (visited.has(commit)) continue;
      visited.add(commit);
      stats.commits++;
      metadata(commit, "commit", findings);
      changedBlobs(commit, findings);
    }
  }
  return findings;
}
export function outbound(files) {
  if (!files.length) throw new Stop("EXACT_OUTBOUND_FILE_REQUIRED");
  return files.flatMap((file) => {
    const relative = path.relative(process.cwd(), path.resolve(file));
    return inspect(
      regularBytes(file),
      relative.startsWith("..")
        ? "[outbound]/" + path.basename(file)
        : relative,
      path.basename(file),
    );
  });
}
function atomicJSON(file, value) {
  const temp = file + "." + process.pid + ".tmp";
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  renameSync(temp, file);
}
function readJSON(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Stop("LOCAL_STATE_UNREADABLE");
  }
}
function result(findings) {
  const unique = [
    ...new Map(findings.map((f) => [JSON.stringify(f), f])).values(),
  ];
  const status = unique.some((f) => f.severity === "BLOCK")
    ? "BLOCK"
    : unique.length
      ? "WARN"
      : "PASS";
  return { status, ok: status !== "BLOCK", findings: unique, ...stats };
}
async function worker(args) {
  deadline = Number(process.env.CONFIDENTIALITY_WORKER_DEADLINE);
  cache = readJSON(process.env.CONFIDENTIALITY_CACHE_FILE, {});
  const [mode, ...rest] = args;
  let findings;
  if (mode === "health") return { status: "PASS", ok: true, ...health() };
  if (mode === "staged" && !rest.length) findings = staged();
  else if (mode === "message" && rest.length === 1) findings = message(rest[0]);
  else if (mode === "push" && rest.length === 2) {
    const chunks = [];
    for await (const chunk of process.stdin) {
      remaining();
      chunks.push(chunk);
    }
    let input;
    try {
      input = new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks),
      );
    } catch {
      throw new Stop("PUSH_INPUT_UNDETERMINED");
    }
    findings = push(rest[1], input);
  } else if (mode === "outbound") findings = outbound(rest);
  else throw new Stop("COMMAND_INVALID");
  remaining();
  atomicJSON(process.env.CONFIDENTIALITY_CACHE_FILE, cache);
  return result(findings);
}
function incomplete(error) {
  return {
    status: "INCOMPLETE",
    ok: false,
    findings: [
      {
        path: safePath(error.location ?? "."),
        line: 1,
        category: error instanceof Stop ? error.category : "CHECK_FAILED",
        severity: "INCOMPLETE",
      },
    ],
  };
}
// Publication-cycle ledger. One cycle is the commit, push and related
// publication of one outgoing-content identity; its checks share one
// allowance. The cycle boundary is recorded completion of the declared
// outgoing checks plus genuinely new outgoing content, never
// CONFIDENTIALITY_BATCH_ID, a revision label or a cosmetic edit alone.
export const LEDGER_FORMAT = 2;
const OUTGOING_MODES = new Set(["staged", "message", "push", "outbound"]);
const COMPLETED_HISTORY = 8;
const IDENTITY_HISTORY = 64;
function clampMs(value, fallback) {
  return Number.isFinite(value) && value >= 0
    ? Math.min(BUDGET_MS, Math.floor(value))
    : fallback;
}
function newCycle(batch, now, seed) {
  return {
    id: digest(Buffer.from(`${now}\0${seed ?? ""}\0${batch ?? ""}`)).slice(
      0,
      16,
    ),
    batch: batch ?? null,
    startedAt: now,
    remainingMs: BUDGET_MS,
    usedMs: 0,
    complete: false,
    pendingPush: false,
    hold: null,
    checks: {},
    identities: [],
  };
}
// Transition from the pre-cycle ledger ({rule, batch, remainingMs, usedMs}):
// its allowance carries over unchanged and, because that format recorded no
// completion, the migrated cycle is open. Nothing is replenished by the
// format change itself.
export function normalizeLedger(previous) {
  if (!previous || typeof previous !== "object")
    return {
      format: LEDGER_FORMAT,
      rule: RULE_VERSION,
      cycle: null,
      completed: [],
    };
  if (previous.format === LEDGER_FORMAT) {
    // A current-format ledger without a cycle (the shape an authorized reset
    // leaves behind) is empty, never a legacy cycle with nothing left.
    const cycle =
      previous.cycle && typeof previous.cycle === "object"
        ? previous.cycle
        : null;
    return {
      format: LEDGER_FORMAT,
      rule: RULE_VERSION,
      cycle: cycle && {
        ...cycle,
        id: typeof cycle.id === "string" ? cycle.id : "unrecorded",
        batch: typeof cycle.batch === "string" ? cycle.batch : null,
        remainingMs: clampMs(cycle.remainingMs, 0),
        usedMs: Number.isFinite(cycle.usedMs) ? cycle.usedMs : 0,
        complete: cycle.complete === true,
        pendingPush: cycle.pendingPush === true,
        hold: cycle.hold && typeof cycle.hold === "object" ? cycle.hold : null,
        checks:
          cycle.checks && typeof cycle.checks === "object" ? cycle.checks : {},
        identities: Array.isArray(cycle.identities) ? cycle.identities : [],
      },
      completed: Array.isArray(previous.completed) ? previous.completed : [],
    };
  }
  const batch = typeof previous.batch === "string" ? previous.batch : null;
  return {
    format: LEDGER_FORMAT,
    rule: RULE_VERSION,
    cycle: {
      ...newCycle(batch, 0, "legacy"),
      startedAt: null,
      remainingMs: clampMs(previous.remainingMs, 0),
      usedMs: Number.isFinite(previous.usedMs) ? previous.usedMs : 0,
      legacy: true,
    },
    completed: [],
  };
}
export function cycleOpen(cycle) {
  return !cycle.complete || cycle.hold !== null;
}
/**
 * Decide which cycle this invocation belongs to. An open cycle (no recorded
 * completion, or an unresolved BLOCK/INCOMPLETE) is always continued. After
 * completion, the same outgoing content is an unchanged retry, the same
 * declared batch is related publication of that delivery, and anything else
 * is genuinely new outgoing content that starts a new cycle.
 */
export function selectCycle(ledger, identity, batch, now) {
  const current = ledger.cycle;
  // Only a declared outgoing check opens a cycle; health (identity null) is
  // maintenance and never starts one.
  if (!current)
    return identity === null
      ? { ledger, transition: null }
      : {
          ledger: { ...ledger, cycle: newCycle(batch, now, identity) },
          transition: "start",
        };
  if (cycleOpen(current)) return { ledger, transition: "continue-open" };
  if (identity === null) return { ledger, transition: "continue" };
  if (current.identities.includes(identity))
    return { ledger, transition: "unchanged-retry" };
  if (batch && current.batch === batch)
    return { ledger, transition: "related-publication" };
  const archived = {
    id: current.id,
    batch: current.batch,
    startedAt: current.startedAt,
    completedAt: now,
    usedMs: current.usedMs,
    checks: Object.fromEntries(
      Object.entries(current.checks).map(([mode, check]) => [
        mode,
        { status: check.status, runs: check.runs },
      ]),
    ),
  };
  return {
    ledger: {
      ...ledger,
      cycle: newCycle(batch, now, identity),
      completed: [...ledger.completed, archived].slice(-COMPLETED_HISTORY),
    },
    transition: "new-content",
  };
}
/**
 * Record one finished outgoing check and derive completion or hold. A
 * finished staged/message check for content this cycle has not seen declares
 * a push still to come; only a finished push clears it. A BLOCK or INCOMPLETE
 * holds the cycle until the same check later finishes; an unchanged retry
 * (same identity) never reopens a completed publication.
 */
export function recordCheck(cycle, mode, identity, status, category, now) {
  if (!OUTGOING_MODES.has(mode) || identity === null) return cycle;
  const previous = cycle.checks[mode];
  const fresh = !cycle.identities.includes(identity);
  const checks = {
    ...cycle.checks,
    [mode]: {
      identity,
      status,
      ...(category ? { category } : {}),
      at: now,
      runs: (previous?.runs ?? 0) + 1,
      retry: !fresh,
    },
  };
  const identities = fresh
    ? [...cycle.identities, identity].slice(-IDENTITY_HISTORY)
    : cycle.identities;
  const next = { ...cycle, checks, identities };
  if (status === "PASS" || status === "WARN") {
    if (next.hold?.mode === mode) next.hold = null;
    if (mode === "push") next.pendingPush = false;
    else if ((mode === "staged" || mode === "message") && fresh)
      next.pendingPush = true;
  } else next.hold = { status, mode, category: category ?? status };
  // Complete means every declared outgoing check finished PASS/WARN: no push
  // still owed and no unfinished check holding the cycle.
  next.complete = !next.pendingPush && next.hold === null;
  return next;
}
// Pre-push ref lines arrive on stdin from the hook, which always closes it. A
// terminal never does, and a read that outlives the deadline is exhaustion,
// never a hang: the read is raced against the current deadline.
async function readAll(stream) {
  if (stream.isTTY) throw new Stop("PUSH_INPUT_UNDETERMINED");
  const chunks = [];
  let timer;
  const collect = (async () => {
    for await (const chunk of stream) {
      remaining();
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  })();
  collect.catch(() => {});
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(
      () => {
        stream.destroy();
        reject(new Stop("BUDGET_EXHAUSTED"));
      },
      Math.max(1, deadline - Date.now()),
    );
  });
  try {
    return await Promise.race([collect, expiry]);
  } finally {
    clearTimeout(timer);
  }
}
async function outgoingIdentity(mode, rest) {
  if (mode === "staged" && !rest.length)
    return {
      identity: digest(Buffer.from("staged\0" + git(["write-tree"]).trim())),
    };
  if (mode === "message" && rest.length === 1)
    return {
      identity: digest(
        Buffer.concat([
          Buffer.from("message\0" + git(["write-tree"]).trim() + "\0"),
          regularBytes(rest[0]),
        ]),
      ),
    };
  if (mode === "push" && rest.length === 2) {
    const input = await readAll(process.stdin);
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(input);
    } catch {
      throw new Stop("PUSH_INPUT_UNDETERMINED");
    }
    return {
      identity: digest(Buffer.concat([Buffer.from("push\0"), input])),
      input,
    };
  }
  if (mode === "outbound") {
    if (!rest.length) throw new Stop("EXACT_OUTBOUND_FILE_REQUIRED");
    return {
      identity: digest(
        Buffer.concat(
          rest.flatMap((file) => [
            Buffer.from("outbound\0" + path.basename(file) + "\0"),
            Buffer.from(digest(regularBytes(file)) + "\0"),
          ]),
        ),
      ),
    };
  }
  if (mode === "health") return { identity: null };
  throw new Stop("COMMAND_INVALID");
}
function compatMirror(ledger) {
  return {
    ...ledger,
    batch: ledger.cycle?.batch ?? null,
    remainingMs: ledger.cycle?.remainingMs ?? BUDGET_MS,
    usedMs: ledger.cycle?.usedMs ?? 0,
  };
}
export async function main(args = process.argv.slice(2)) {
  const started = Date.now();
  deadline = started + BUDGET_MS;
  let stateFile, state, lock, mode, identity, transition;
  const charge = () => {
    if (!state.cycle) return;
    const elapsed = Date.now() - started;
    state.cycle.usedMs += elapsed;
    state.cycle.remainingMs = Math.max(0, state.cycle.remainingMs - elapsed);
  };
  try {
    const { common, gitDir } = currentRepository();
    const directory = path.join(common, "confidentiality-check-state");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    stateFile = path.join(directory, digest(Buffer.from(gitDir)) + ".json");
    lock = stateFile + ".lock";
    try {
      mkdirSync(lock);
    } catch {
      lock = undefined;
      throw new Stop("CHECK_ALREADY_RUNNING");
    }
    state = normalizeLedger(readJSON(stateFile, null));
    mode = args[0];
    const batch = process.env.CONFIDENTIALITY_BATCH_ID || null;
    // Health is maintenance: it verifies the installation inside the plain
    // window and is never bounded by a cycle it does not check.
    const maintenance = mode === "health";
    // An open cycle is continued whatever the identity turns out to be, so its
    // remaining time already bounds identity preparation (including the
    // pre-push stdin read); an exhausted cycle fails fast as BUDGET_EXHAUSTED.
    if (!maintenance && state.cycle && cycleOpen(state.cycle)) {
      transition = "continue-open";
      deadline = started + Math.max(0, state.cycle.remainingMs);
    }
    const prepared = await outgoingIdentity(mode, args.slice(1));
    identity = prepared.identity;
    ({ ledger: state, transition } = selectCycle(
      state,
      identity,
      batch,
      started,
    ));
    if (state.cycle) {
      // Only an open cycle adopts a late label; a completed cycle's boundary
      // is recorded completion plus new content, never an ID set afterwards.
      if (state.cycle.batch === null && batch && cycleOpen(state.cycle))
        state.cycle.batch = batch;
      if (!maintenance)
        deadline = started + Math.max(0, state.cycle.remainingMs);
    }
    const cacheFile = path.join(directory, RULE_VERSION + ".cache.json");
    const manifest = readJSON(
      path.join(common, INSTALL_DIR, "manifest.json"),
      null,
    );
    if (
      !manifest ||
      manifest.version !== VERSION ||
      manifest.files["confidentiality-scan.mjs"] !== RULE_VERSION
    )
      throw new Stop("SCANNER_VERSION_MISMATCH");
    for (const file of INSTALLED_FILES) {
      const installed = path.join(common, INSTALL_DIR, file);
      if (digest(regularBytes(installed)) !== manifest.files[file])
        throw new Stop("INSTALLED_FILE_CHANGED");
      if (
        file !== "confidentiality-scan.mjs" &&
        !(lstatSync(installed).mode & 0o111)
      )
        throw new Stop("HOOK_NOT_EXECUTABLE");
    }
    const output = await new Promise((resolve) => {
      const child = spawn(process.execPath, [SELF, "--worker", ...args], {
        detached: process.platform !== "win32",
        stdio: [prepared.input ? "pipe" : "ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          CONFIDENTIALITY_WORKER_DEADLINE: String(deadline),
          CONFIDENTIALITY_CACHE_FILE: cacheFile,
        },
      });
      if (prepared.input) {
        child.stdin.on("error", () => {});
        child.stdin.end(prepared.input);
      }
      let bytes = "",
        finished = false;
      const finish = (value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        terminate();
        resolve(value);
      };
      const terminate = () => {
        try {
          process.kill(
            process.platform === "win32" ? child.pid : -child.pid,
            "SIGKILL",
          );
        } catch {
          /* Already exited. */
        }
      };
      const timer = setTimeout(
        () => {
          terminate();
          finish(incomplete(new Stop("BUDGET_EXHAUSTED")));
        },
        Math.max(1, deadline - Date.now()),
      );
      child.stdout.on("data", (chunk) => {
        bytes += chunk.toString();
        if (bytes.length > 2 * 1024 * 1024) {
          terminate();
          finish(incomplete(new Stop("RESULT_TOO_LARGE")));
        }
      });
      child.on("error", () =>
        finish(incomplete(new Stop("WORKER_START_FAILED"))),
      );
      child.on("close", () => {
        try {
          finish(JSON.parse(bytes));
        } catch {
          finish(incomplete(new Stop("WORKER_FAILED")));
        }
      });
    });
    const finished = Date.now();
    if (state.cycle)
      state.cycle = recordCheck(
        state.cycle,
        mode,
        identity,
        output.status,
        output.findings?.find((f) => f.severity === output.status)?.category,
        finished,
      );
    charge();
    if (state.cycle) atomicJSON(stateFile, compatMirror(state));
    console.log(
      JSON.stringify({
        ...output,
        elapsedMs: finished - started,
        ...(state.cycle
          ? {
              cycle: cycleSummary(state.cycle, transition, stateFile),
              cycleUsedMs: state.cycle.usedMs,
              cycleRemainingMs: state.cycle.remainingMs,
              batchUsedMs: state.cycle.usedMs,
              batchRemainingMs: state.cycle.remainingMs,
            }
          : { cycle: null }),
      }),
    );
    return output.status === "BLOCK"
      ? 1
      : output.status === "INCOMPLETE"
        ? 2
        : 0;
  } catch (error) {
    if (state?.cycle && stateFile) {
      // A check that could not run is an unfinished check of this cycle: it
      // holds the cycle open and consumes the elapsed preparation time.
      if (identity !== undefined && identity !== null)
        state.cycle = recordCheck(
          state.cycle,
          mode,
          identity,
          "INCOMPLETE",
          error instanceof Stop ? error.category : "CHECK_FAILED",
          Date.now(),
        );
      charge();
      try {
        atomicJSON(stateFile, compatMirror(state));
      } catch {
        /* Report once. */
      }
    }
    console.log(
      JSON.stringify({
        ...incomplete(error),
        elapsedMs: Date.now() - started,
        ...(state?.cycle
          ? {
              cycle: cycleSummary(state.cycle, transition, stateFile),
              cycleUsedMs: state.cycle.usedMs,
              cycleRemainingMs: state.cycle.remainingMs,
              batchUsedMs: state.cycle.usedMs,
              batchRemainingMs: state.cycle.remainingMs,
            }
          : {}),
      }),
    );
    return 2;
  } finally {
    if (lock) rmSync(lock, { recursive: true, force: true });
  }
}
function cycleSummary(cycle, transition, stateFile) {
  return {
    id: cycle.id,
    batch: cycle.batch,
    transition: transition ?? null,
    complete: cycle.complete,
    open: cycleOpen(cycle),
    pendingPush: cycle.pendingPush,
    hold: cycle.hold,
    remainingMs: cycle.remainingMs,
    // An open cycle with nothing left cannot continue: STOP and report this
    // id and ledger file; only an explicitly authorized reset reopens it.
    exhausted: cycleOpen(cycle) && cycle.remainingMs <= 0,
    ledger: stateFile ? path.basename(stateFile) : null,
    legacy: cycle.legacy === true,
    checks: Object.fromEntries(
      Object.entries(cycle.checks).map(([m, c]) => [m, c.status]),
    ),
  };
}
export function isEntryPoint(url) {
  if (!process.argv[1] || process.argv[1] === "-") return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(url);
  } catch {
    return false;
  }
}
if (isEntryPoint(import.meta.url)) {
  if (process.argv[2] === "--worker") {
    try {
      console.log(JSON.stringify(await worker(process.argv.slice(3))));
    } catch (error) {
      console.log(JSON.stringify(incomplete(error)));
    }
  } else process.exitCode = await main();
}
