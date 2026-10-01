import { Buffer } from "node:buffer";
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { Script } from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  categories,
  inspect,
  digest,
  normalizeLedger,
} from "./confidentiality-scan.mjs";

const source = path.dirname(fileURLToPath(import.meta.url));
// These intentionally invalid fixtures are assembled at runtime. No production
// identity, address, credential or media is read by this suite.
const approvedName = "Synthetic Developer";
const approvedEmail = ["synthetic-developer", "users.noreply.github.com"].join(
  "@",
);
const rejectedEmail = ["synthetic-person", "fictional-person.invalidtld"].join(
  "@",
);
const token = ["gh", "p_", "Z".repeat(36)].join("");
const privatePath = [
  "/",
  "Users",
  "/",
  "synthetic-person",
  "/private-input",
].join("");
const address = [10, 24, 31, 57].join(".");
const secretContent = ['const payload = "', token, '";\n'].join("");
const signedUrl =
  "https://example.invalid/" + "image?" + "q-signature=" + "a".repeat(40);

function run(command, args, { cwd, env, input } = {}) {
  return spawnSync(command, args, {
    cwd,
    env,
    input,
    encoding: "utf8",
    timeout: 30000,
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
}
function fixture(t, installed = true) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "confidentiality-synthetic-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const globalConfig = path.join(dir, "synthetic-config");
  writeFileSync(
    globalConfig,
    "[user]\n name = " +
      approvedName +
      "\n email = " +
      approvedEmail +
      "\n useConfigOnly = true\n",
  );
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const key of Object.keys(env))
    if (
      /^GIT_(?:AUTHOR|COMMITTER|CONFIG_COUNT|CONFIG_KEY_|CONFIG_VALUE_|DIR$|WORK_TREE$|INDEX_FILE$|COMMON_DIR$)/.test(
        key,
      ) ||
      key === "CONFIDENTIALITY_BATCH_ID"
    )
      delete env[key];
  const repo = path.join(dir, "repo");
  mkdirSync(repo);
  const git = (...args) => run("git", args, { cwd: repo, env });
  const good = (...args) => {
    const result = git(...args);
    assert.equal(result.status, 0, "synthetic Git setup must succeed");
    return result.stdout.trim();
  };
  good("init", "-b", "main");
  writeFileSync(path.join(repo, "safe.txt"), "Explicit synthetic fixture.\n");
  good("add", ".");
  good("commit", "-m", "Synthetic base");
  const remote = path.join(dir, "remote.git");
  assert.equal(run("git", ["init", "--bare", remote], { env }).status, 0);
  good("remote", "add", "origin", remote);
  good("push", "origin", "main");
  const install = (...args) =>
    run(
      process.execPath,
      [
        path.join(source, "install-confidentiality-hooks.mjs"),
        "--confirm-current-identity-approved",
        ...args,
      ],
      { cwd: repo, env },
    );
  const scan = (mode, ...args) =>
    run(
      process.execPath,
      [path.join(source, "confidentiality-scan.mjs"), mode, ...args],
      { cwd: repo, env },
    );
  if (installed)
    assert.equal(install().status, 0, "synthetic install must succeed");
  return { dir, repo, remote, env, git, good, install, scan, globalConfig };
}
function blocked(result, expected) {
  assert.notEqual(result.status, 0, "operation must be blocked");
  if (expected)
    assert.ok(
      (result.stdout + result.stderr).includes(expected),
      "sanitized category must be present",
    );
  for (const value of [token, signedUrl])
    assert.ok(
      !(result.stdout + result.stderr).includes(value),
      "diagnostics must suppress synthetic sensitive values",
    );
}
function add(f, content, filename = "fixture.txt") {
  writeFileSync(path.join(f.repo, filename), content);
  f.good("add", "--", filename);
}
function ledgerFile(f) {
  const common = f.good(
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  );
  const admin = f.good("rev-parse", "--absolute-git-dir");
  return path.join(
    common,
    "confidentiality-check-state",
    digest(Buffer.from(admin)) + ".json",
  );
}
const ledger = (f) => JSON.parse(readFileSync(ledgerFile(f), "utf8"));
const scanned = (result) => JSON.parse(result.stdout);
// A copy of the current hooks and scanner whose scanner bytes differ by one
// comment: a genuine rule-version change without any rule difference.
function syntheticRelease(f) {
  const release = path.join(f.dir, "synthetic-release");
  mkdirSync(path.join(release, "scripts"), { recursive: true });
  mkdirSync(path.join(release, ".githooks"));
  for (const filename of [
    "confidentiality-scan.mjs",
    "install-confidentiality-hooks.mjs",
  ])
    copyFileSync(
      path.join(source, filename),
      path.join(release, "scripts", filename),
    );
  for (const filename of ["pre-commit", "commit-msg", "pre-push"])
    copyFileSync(
      path.join(source, "..", ".githooks", filename),
      path.join(release, ".githooks", filename),
    );
  const scanner = path.join(release, "scripts", "confidentiality-scan.mjs");
  writeFileSync(
    scanner,
    readFileSync(scanner, "utf8") + "\n// Synthetic controlled update.\n",
  );
  return {
    scanner,
    installer: path.join(
      release,
      "scripts",
      "install-confidentiality-hooks.mjs",
    ),
    scan: (mode, ...args) =>
      run(process.execPath, [scanner, mode, ...args], {
        cwd: f.repo,
        env: f.env,
      }),
  };
}

test("AWS_SECRET_ACCESS_KEY assignments are core credential names; identifiers and placeholders pass", () => {
  const syntheticSecret = [
    "wJalrXUtnFEMI",
    "K7MDENG",
    "bPxRfiCYEXAMPLEKEY",
  ].join("/");
  assert.ok(
    categories(
      ["AWS_", "SECRET_ACCESS_KEY", "=", syntheticSecret].join(""),
      "fixture.env",
    ).includes("CREDENTIAL_LITERAL"),
  );
  assert.ok(
    categories(
      ["secret", "_access_key", " = ", '"', syntheticSecret, '"'].join(""),
      "fixture.ts",
    ).includes("CREDENTIAL_LITERAL"),
  );
  const findings = inspect(
    Buffer.from(
      ["AWS_", "SECRET_ACCESS_KEY", "=", syntheticSecret, "\n"].join(""),
    ),
    "fixture.env",
  );
  assert.ok(
    findings.some(
      (f) => f.category === "CREDENTIAL_LITERAL" && f.severity === "BLOCK",
    ),
  );
  assert.ok(!JSON.stringify(findings).includes(syntheticSecret));
  assert.deepEqual(
    categories("type ApiKey = { id: string }", "fixture.ts"),
    [],
  );
  assert.deepEqual(
    inspect(Buffer.from("type ApiKey = { id: string }\n"), "fixture.ts").filter(
      (f) => f.severity === "BLOCK",
    ),
    [],
  );
  assert.deepEqual(
    categories("AWS_SECRET_ACCESS_KEY=EXAMPLE", "fixture.env"),
    [],
  );
  assert.deepEqual(
    categories("AWS_SECRET_ACCESS_KEY=EXAMPLE_AWS_SECRET", "fixture.env"),
    [],
  );
  assert.deepEqual(
    categories(
      "const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;",
      "fixture.ts",
    ),
    [],
  );
  assert.deepEqual(
    inspect(
      Buffer.from(
        "[user]\n\tname = Synthetic Developer\n\temail = " +
          approvedEmail +
          "\n",
      ),
      ".gitconfig",
    ).filter((f) => f.severity === "BLOCK"),
    [],
  );
});

test("types, references, relative imports and versions are not credential literals", () => {
  const values = [
    "password:string",
    "SecretKey:options.secretKey",
    "token: process.env.API_TOKEN",
    "const password = process.env.PASSWORD;",
    "const key = options.secretKey;",
    "import value from '../../module';",
    'const version = "18.4.0";',
    'const assignment = "API_KEY=" + "PLACEHOLDER";',
    "type Login = { password: string; secretKey?: string };",
  ];
  for (const value of values)
    assert.deepEqual(categories(value, "fixture.ts"), []);
  assert.deepEqual(categories('{"cookie":"^1.0.0"}', "package.json"), []);
  assert.deepEqual(
    categories("https://example.invalid/search?code=9781234567890", "notes.md"),
    [],
  );
  for (const text of [
    'username, password = value["username"], value["password"]',
    "username, password = load_auth(args.auth_file)",
    "wrong_password = secrets.token_urlsafe(32)",
    "while wrong_password == password:",
    "headers, body = authenticated(asset_path, check_wrong_password=False)",
  ])
    assert.deepEqual(categories(text, "probe.py"), []);
  for (const operator of ["=", ":=", "==", "!=", "===", "!=="])
    assert.ok(
      categories(
        ["password", operator, '"opaqueCredential123456789"'].join(" "),
        "probe.py",
      ).length,
    );
});
test("typeof primitive comparisons pass without hiding literal credential comparisons or assignments", () => {
  for (const source of [
    "token !== null && typeof token === 'object'",
    "typeof config.apiKey !== 'string'",
    "typeof config?.apiKey === 'undefined'",
    "const check = token => Boolean(token);",
  ])
    assert.deepEqual(categories(source, "fixture.ts"), []);
  for (const type of [
    "undefined",
    "object",
    "boolean",
    "number",
    "bigint",
    "string",
    "symbol",
    "function",
  ])
    assert.deepEqual(
      categories(
        ["typeof", "config.apiKey", "===", JSON.stringify(type)].join(" "),
        "fixture.ts",
      ),
      [],
    );
  const opaque = ["opaque", "Credential123456789"].join("");
  for (const operator of ["=", ":=", "==", "!=", "===", "!=="])
    for (const value of [opaque, "object", "string"])
      assert.ok(
        categories(
          ["apiKey", operator, JSON.stringify(value)].join(" "),
          "fixture.ts",
        ).includes("CREDENTIAL_LITERAL"),
      );
  assert.ok(
    categories(
      ["typeof", "apiKey", "===", JSON.stringify(opaque)].join(" "),
      "fixture.ts",
    ).includes("CREDENTIAL_LITERAL"),
  );
  assert.ok(
    categories(
      ["typeof", "apiKey", "===", JSON.stringify(token)].join(" "),
      "fixture.ts",
    ).includes("API_TOKEN"),
  );
  assert.ok(
    categories(
      ["typeof", "apiKey", "===", JSON.stringify(signedUrl)].join(" "),
      "fixture.ts",
    ).includes("AUTHORIZING_URL"),
  );
});
// Reviewed synthetic adversarial material; assembled rather than copied from
// any configuration. Assertions expose only categories and source line numbers.
const opaqueLiteral = ["opaque", "Credential123456789"].join("");
const assignmentText = (name, operator, value) =>
  [name, operator, value].join(" ");
function assertNearbyDetectors(safe, filename) {
  const literal = assignmentText("apiKey", "=", JSON.stringify(opaqueLiteral));
  for (const separator of ["; ", "\n"])
    for (const content of [
      safe + separator + literal,
      literal + separator + safe,
    ])
      assert.ok(categories(content, filename).includes("CREDENTIAL_LITERAL"));
  assert.ok(categories(safe + "\n" + token, filename).includes("API_TOKEN"));
  assert.ok(
    categories(safe + "\n" + signedUrl, filename).includes("AUTHORIZING_URL"),
  );
}

test("explicit synthetic placeholder markers pass only as complete marker values", () => {
  const marker = ["EXPLICIT", "SYNTHETIC", "PLACEHOLDER"].join("_");
  for (const filename of ["fixture.mjs", "fixture.env", "notes.md"])
    for (const value of [marker, marker.toLowerCase()]) {
      const safe = assignmentText("token", "=", JSON.stringify(value));
      assert.deepEqual(categories(safe, filename), []);
      assertNearbyDetectors(safe, filename);
    }
  for (const value of [
    "UNREVIEWED_" + marker,
    marker + "_" + opaqueLiteral,
    "EXPLICIT_" + opaqueLiteral,
    marker.replace("SYNTHETIC", "LIVE"),
    marker.replace("PLACEHOLDER", "VALUE"),
  ])
    assert.ok(
      categories(
        assignmentText("token", "=", JSON.stringify(value)),
        "fixture.ts",
      ).includes("CREDENTIAL_LITERAL"),
    );
  assert.ok(
    categories(
      "// Explicit synthetic fixture\n" +
        assignmentText("token", "=", JSON.stringify(opaqueLiteral)),
      "fixture.test.ts",
    ).includes("CREDENTIAL_LITERAL"),
  );
});

test("the implicit-authentication disabling switch accepts only its boolean sentinel", () => {
  const name = "HF_HUB_DISABLE_IMPLICIT_TOKEN";
  for (const [filename, operator] of [
    ["fixture.py", ":"],
    ["fixture.env", "="],
    ["fixture.json", ":"],
  ])
    for (const value of ["1", JSON.stringify("1")]) {
      const safe = assignmentText(name, operator, value);
      assert.deepEqual(categories(safe, filename), []);
      assertNearbyDetectors(safe, filename);
      assert.deepEqual(categories(safe + " # disabled", filename), []);
    }
  for (const otherName of [
    "API_TOKEN",
    "DISABLE_ACCESS_TOKEN",
    name + "_TOKEN",
  ])
    assert.ok(
      categories(
        assignmentText(otherName, "=", JSON.stringify("1")),
        "fixture.env",
      ).includes("CREDENTIAL_LITERAL"),
    );
  for (const value of ["0", "10", opaqueLiteral, token, signedUrl])
    assert.ok(
      categories(
        assignmentText(name, "=", JSON.stringify(value)),
        "fixture.env",
      ).includes("CREDENTIAL_LITERAL"),
    );
  for (const suffix of [
    " + " + JSON.stringify(opaqueLiteral),
    " && " + JSON.stringify(opaqueLiteral),
    ".suffix",
    "extra",
  ])
    assert.ok(
      categories(
        assignmentText(name, "=", JSON.stringify("1")) + suffix,
        "fixture.py",
      ).includes("CREDENTIAL_LITERAL"),
    );
  assert.ok(
    categories(assignmentText(name, "=", "1"), "notes.md").includes(
      "CREDENTIAL_LITERAL",
    ),
  );
});

test("Swift nil predicates pass without accepting nil strings or dropping nearby literals", () => {
  for (const operator of ["==", "!="])
    for (const member of ["parts.password", "parts?.password"])
      for (const suffix of ["", ",", " && parts.host != nil", " // optional"]) {
        const safe = assignmentText(member, operator, "nil") + suffix;
        assert.deepEqual(categories(safe, "fixture.swift"), []);
        assertNearbyDetectors(safe, "fixture.swift");
      }
  for (const [operator, value] of [
    ["=", "nil"],
    ["==", JSON.stringify("nil")],
    ["!=", JSON.stringify(opaqueLiteral)],
    ["==", "nilSuffix"],
    ["==", "nil + " + JSON.stringify(opaqueLiteral)],
  ])
    assert.ok(
      categories(
        assignmentText("parts.password", operator, value),
        "fixture.swift",
      ).includes("CREDENTIAL_LITERAL"),
    );
  const content = Buffer.from(assignmentText("parts.password", "==", "nil"));
  assert.deepEqual(inspect(content, "fixture.swift"), []);
  assert.ok(
    inspect(content, "notes.md").some(
      (f) => f.category === "CREDENTIAL_LITERAL",
    ),
  );
});

test("JavaScript prefix counters are expressions with a complete source boundary", () => {
  for (const filename of ["fixture.js", "fixture.mjs", "fixture.ts"])
    for (const reference of [
      "generation",
      "state.generation",
      "$state.generation",
    ])
      for (const declaration of ["const", "let", "var"]) {
        const safe =
          declaration +
          " " +
          assignmentText("token", "=", "++" + reference) +
          ";";
        assert.deepEqual(categories(safe, filename), []);
        assertNearbyDetectors(safe, filename);
      }
  for (const value of [
    JSON.stringify("++state.generation"),
    "123456789",
    "++state.generation + " + JSON.stringify(opaqueLiteral),
    "++state.generation && " + JSON.stringify(opaqueLiteral),
    "++state.generation[" + JSON.stringify(opaqueLiteral) + "]",
    "++state.generation/" + opaqueLiteral,
    JSON.stringify(opaqueLiteral),
  ])
    assert.ok(
      categories(
        "const " + assignmentText("token", "=", value) + ";",
        "fixture.js",
      ).includes("CREDENTIAL_LITERAL"),
    );
  const content = Buffer.from(
    "const " + assignmentText("token", "=", "++state.generation") + ";",
  );
  assert.deepEqual(inspect(content, "fixture.js"), []);
  for (const filename of [
    "fixture.py",
    "fixture.jsx",
    "fixture.tsx",
    "fixture.env",
    "notes.md",
    "source.patch",
  ])
    assert.ok(
      inspect(content, filename).some(
        (f) => f.category === "CREDENTIAL_LITERAL",
      ),
    );
});

test("counter exemptions require executable declarations, not strings, comments or continuations", () => {
  const counter = "const " + assignmentText("token", "=", "++" + opaqueLiteral);
  const complete = counter + ";";
  const literal = JSON.stringify(opaqueLiteral);
  for (const source of [
    counter,
    counter + "\n? " + literal + " : null;",
    counter + " // continued\n+ " + literal + ";",
    counter + "\n+ " + literal + ";",
    assignmentText("token", "=", "++" + opaqueLiteral) + ";",
    ...["'", '"', "`"].map(
      (quote) => "const text = " + quote + complete + quote + ";",
    ),
    "const text = `\n" + complete + "\n`;",
    "/*\n" + complete + "\n*/",
    "// " + complete,
    "value.match(/" + complete + "/);",
    "const pattern = /ambiguous/;\n" + complete,
    "const text = `opaque ${value}`;\n" + complete,
    "const element = <div>\n" + complete + "\n</div>;",
  ])
    assert.ok(categories(source, "fixture.js").includes("CREDENTIAL_LITERAL"));
  for (const prefix of [
    "// comment\n",
    "/* closed comment */\n",
    "const text = 'quoted prefix';\n",
    'const text = "escaped \\" prefix";\n',
    "const text = `plain opaque text`;\n",
    "if (active < 1 || disabled) return;\n",
    "value.match(/[/\"'\\\\]/g);\n",
    "value.match(/escaped\\/slash/);\n",
  ]) {
    assert.deepEqual(categories(prefix + complete, "fixture.js"), []);
    assertNearbyDetectors(prefix + complete, "fixture.js");
  }
});

test("valid JavaScript comment and interpolation decoys retain literal detection", () => {
  const counter =
    "const " + assignmentText("token", "=", "++" + opaqueLiteral) + ";";
  const fixtures = [
    "/* /* */\nconst text = `*/\n" + counter + "\n`;",
    "const text = `" + '${"`"}' + '"\n' + counter + "\n`;",
  ];
  for (const source of fixtures) {
    let parses = false;
    try {
      new Script(source);
      parses = true;
    } catch {
      // Never render fixture source through an exception diagnostic.
    }
    assert.ok(parses, "reviewed synthetic source must parse without execution");
    assert.ok(categories(source, "fixture.js").includes("CREDENTIAL_LITERAL"));
  }
});

test("Swift nil exemptions stay outside quoted, raw and multiline string contents", () => {
  const predicate = assignmentText("parts.password", "==", "nil");
  for (const source of [
    'let text = "' + predicate + ', continued"',
    'let text = """\n' + predicate + '\n"""',
    'let text = #"' + predicate + '"#',
    'let text = "\\(value)"\n' + predicate,
    "/* " + predicate + " */",
    "// " + predicate,
  ])
    assert.ok(
      categories(source, "fixture.swift").includes("CREDENTIAL_LITERAL"),
    );
  for (const prefix of [
    '// quoted " comment\n',
    '/* outer /* nested " */ comment */\n',
    'let text = "closed"\n',
    'let text = """\nmultiline " content\n"""\n',
  ]) {
    assert.deepEqual(categories(prefix + predicate, "fixture.swift"), []);
    assertNearbyDetectors(prefix + predicate, "fixture.swift");
  }
});

test("unmodeled JavaScript comment boundaries conservatively retain literal detection", () => {
  const counter =
    "const " + assignmentText("token", "=", "++" + opaqueLiteral) + ";";
  const fixtures = [
    ...["\u2028", "\u2029"].map(
      (separator) =>
        "// comment" + separator + "const text = `\n" + counter + "\n`;",
    ),
    "--> `\nconst text = `\n" + counter + "\n`;",
    "#!node `\nconst text = `\n" + counter + "\n`;",
  ];
  for (const source of fixtures) {
    let parses = false;
    try {
      new Script(source);
      parses = true;
    } catch {
      // Keep source values out of assertion output.
    }
    assert.ok(parses, "reviewed synthetic boundary fixture must parse");
    assert.ok(categories(source, "fixture.js").includes("CREDENTIAL_LITERAL"));
  }
  // A harmless prefix containing the unmodeled syntax also declines: this
  // deliberately conservative fallback is not a claim to parse all JS syntax.
  for (const marker of ["\u2028", "\u2029", "-->", "#!"])
    assert.ok(
      categories(
        "const text = " + JSON.stringify(marker) + ";\n" + counter,
        "fixture.js",
      ).includes("CREDENTIAL_LITERAL"),
    );
  for (const newline of ["\n", "\r\n"])
    assert.deepEqual(
      categories("// comment" + newline + counter, "fixture.js"),
      [],
    );
  const hashbang = "#!node\n";
  const credential = assignmentText(
    "apiKey",
    "=",
    JSON.stringify(opaqueLiteral),
  );
  const findings = inspect(Buffer.from(hashbang + credential), "fixture.js");
  assert.ok(
    findings.some(
      (f) =>
        f.line === 2 &&
        f.category === "CREDENTIAL_LITERAL" &&
        f.severity === "BLOCK",
    ),
  );
  assert.ok(categories(hashbang + token, "fixture.js").includes("API_TOKEN"));
  assert.ok(
    categories(hashbang + signedUrl, "fixture.js").includes("AUTHORIZING_URL"),
  );
});

test("source context for existing typeof, references and Python false is not inferred from patches", () => {
  for (const [source, filename] of [
    ["typeof token === 'object'", "fixture.js"],
    [assignmentText("token", "=", "state.runtimeGeneration"), "fixture.js"],
    [assignmentText("token", "=", "False"), "fixture.py"],
  ]) {
    assert.deepEqual(categories(source, filename), []);
    assertNearbyDetectors(source, filename);
    assert.ok(
      categories(source, "source.patch").includes("CREDENTIAL_LITERAL"),
    );
  }
});

test("only exact pnpm snapshot dependency versions pass and cache remains context-bound", () => {
  const lock = [
    "lockfileVersion: '9.0'",
    "",
    "snapshots:",
    "  synthetic-package@1.2.3:",
    "    dependencies:",
    "      parse-passwd: 1.0.0",
    "",
  ].join("\n");
  assert.deepEqual(categories(lock, "pnpm-lock.yaml"), []);
  assert.deepEqual(inspect(Buffer.from(lock), "pnpm-lock.yaml"), []);
  assert.ok(
    inspect(Buffer.from(lock), "settings.yaml").some(
      (finding) => finding.category === "CREDENTIAL_LITERAL",
    ),
  );
  for (const content of [
    lock.replace("snapshots:", "credentials:"),
    lock.replace("    dependencies:", "    settings:"),
    lock.replace("synthetic-package@1.2.3", "unversioned-record"),
    lock.replace("1.0.0", ["opaque", "Credential123456789"].join("")),
    lock + [["password", ":"].join(""), "7.8.9"].join(" ") + "\n",
  ])
    assert.ok(
      categories(content, "pnpm-lock.yaml").includes("CREDENTIAL_LITERAL"),
    );
  assert.ok(categories(lock + token, "pnpm-lock.yaml").includes("API_TOKEN"));
  assert.ok(
    categories(lock + signedUrl, "pnpm-lock.yaml").includes("AUTHORIZING_URL"),
  );
});
test("fictional placeholders and wholly-placeholder cookies pass but mixed cookie values block", () => {
  const opaque = ["opaque", "Session123456789"].join("");
  const cookie = (value) => JSON.stringify({ Cookie: value });
  for (const value of [
    "payload-token=fictional-session",
    "session=synthetic-session; token=fictional-token",
  ])
    assert.deepEqual(categories(cookie(value), "fixture.ts"), []);
  assert.deepEqual(
    categories(
      JSON.stringify({ apiKey: "fictional-test-key" }),
      "settings.json",
    ),
    [],
  );
  for (const value of [
    "session=synthetic-session; other=" + opaque,
    "other=" + opaque + "; session=fictional-session",
    "session=fictional-session; pin=1234",
  ])
    assert.ok(
      categories(cookie(value), "fixture.ts").includes("CREDENTIAL_LITERAL"),
    );
  assert.ok(
    categories(cookie("session=" + token), "fixture.ts").includes("API_TOKEN"),
  );
  assert.ok(
    categories(JSON.stringify({ apiKey: opaque }), "settings.json").includes(
      "CREDENTIAL_LITERAL",
    ),
  );
});
test("ordinary identifiers, certificates, public keys and readable artifacts pass", () => {
  for (const filename of [
    "pilot.service",
    "pilot.timer",
    "drawing.svg",
    "certificate.pem",
    "config.env",
  ]) {
    const text = [
      address,
      privatePath,
      rejectedEmail,
      "https://example.invalid/path",
      "resource-id-example",
      "<svg></svg>",
      "-----BEGIN CERTIFICATE-----",
      "QUJDREVGR0hJ",
      "-----END CERTIFICATE-----",
      "-----BEGIN PUBLIC KEY-----",
      "QUJDREVGR0hJ",
      "-----END PUBLIC KEY-----",
      "version https://git-lfs.github.com/spec/v1",
      "oid sha256:" + "a".repeat(64),
      "TOKEN=PLACEHOLDER",
      "PASSWORD=${PASSWORD}",
    ].join("\n");
    assert.deepEqual(inspect(Buffer.from(text), filename), []);
  }
  const findings = inspect(Buffer.from([0, 255]), "photo.png");
  assert.equal(findings[0].severity, "WARN");
  assert.equal(findings[0].path, "photo.png");
});
test("core credentials retain location without printing values", () => {
  const samples = [
    token,
    ["-----BEGIN ", "PRIVATE KEY-----\nQUJD\n-----END PRIVATE KEY-----"].join(
      "",
    ),
    ["postgres://example:", "opaquePass987", "@example.invalid/db"].join(""),
    "COS_SECRET_KEY=" + "opaqueCredential123456789",
    signedUrl,
  ];
  for (const sample of samples) {
    const findings = inspect(Buffer.from("safe\n" + sample), "config.env");
    assert.ok(
      findings.some(
        (f) =>
          f.severity === "BLOCK" && f.line === 2 && f.path === "config.env",
      ),
    );
    assert.ok(!JSON.stringify(findings).includes(sample));
  }
  for (const [filename, text] of [
    ["settings.yml", "password: " + "opaqueCredential123456789"],
    ["settings.yaml", "api_key: " + "opaqueCredential123456789"],
    [
      "pilot.service",
      ['Environment="', "API_KEY", "=", "opaqueCredential123456789", '"'].join(
        "",
      ),
    ],
  ])
    assert.ok(categories(text, filename).includes("CREDENTIAL_LITERAL"));
});
test("actual message, trailer and exact outbound text check only core credentials", (t) => {
  const f = fixture(t);
  add(f, "safe\n");
  blocked(f.git("commit", "-m", "Synthetic title\n\n" + token), "API_TOKEN");
  assert.equal(
    f.git(
      "commit",
      "-m",
      "Synthetic title\n\nCo-authored-by: Example <" + rejectedEmail + ">",
    ).status,
    0,
  );
  const file = path.join(f.dir, "payload.md");
  writeFileSync(file, signedUrl);
  blocked(f.scan("outbound", file), "AUTHORIZING_URL");
  writeFileSync(
    file,
    "Ordinary URL https://example.invalid/ and " + privatePath,
  );
  assert.equal(f.scan("outbound", file).status, 0);
});
test("same content and syntax context reuse cache, changed bytes are rechecked", (t) => {
  const f = fixture(t);
  add(f, "Safe reusable content\n");
  const a = JSON.parse(f.scan("staged").stdout),
    b = JSON.parse(f.scan("staged").stdout);
  assert.equal(a.status, "PASS");
  assert.equal(b.scanned, 0);
  assert.ok(b.reused > 0);
  assert.ok(b.batchUsedMs >= a.batchUsedMs);
  add(f, secretContent);
  blocked(f.scan("staged"), "API_TOKEN");
  assert.deepEqual(categories("password=options.password", "fixture.ts"), []);
  assert.ok(categories("password=options.password", "fixture.env").length);
});
test("normal includeIf and worktree config do not trigger credential blocking", (t) => {
  const f = fixture(t, false);
  const include = path.join(f.dir, "included-config");
  writeFileSync(include, "[alias]\n example = status\n");
  f.good("config", "includeIf.onbranch:main.path", include);
  f.good("config", "extensions.worktreeConfig", "true");
  f.good("config", "--worktree", "core.sparseCheckout", "false");
  assert.equal(f.install().status, 0);
  add(f, "Safe bytes\n");
  assert.equal(f.scan("staged").status, 0);
});
test("one delivery allowance spans stages and a real deadline kills child processes", async (t) => {
  const f = fixture(t);
  add(f, "Safe budget bytes\n");
  assert.equal(f.scan("staged").status, 0);
  const common = f.good(
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  );
  const admin = f.good("rev-parse", "--absolute-git-dir");
  const stateFile = path.join(
    common,
    "confidentiality-check-state",
    digest(Buffer.from(admin)) + ".json",
  );
  const state = JSON.parse(readFileSync(stateFile));
  // The cycle ledger is authoritative; the top-level fields mirror it for
  // older readers.
  state.cycle.remainingMs = 800;
  state.cycle.usedMs = 119200;
  state.remainingMs = 800;
  state.usedMs = 119200;
  writeFileSync(stateFile, JSON.stringify(state));
  const helper = path.join(f.dir, "slow-transport");
  const marker = path.join(f.dir, "should-not-complete");
  const pidFile = path.join(f.dir, "helper.pid");
  writeFileSync(
    helper,
    '#!/bin/sh\nprintf "%s" "$$" > "' +
      pidFile +
      '"\nsleep 2\nprintf done > "' +
      marker +
      '"\n',
  );
  chmodSync(helper, 0o700);
  f.good("config", "protocol.ext.allow", "always");
  const head = f.good("rev-parse", "HEAD");
  const start = Date.now();
  const r = run(
    process.execPath,
    [
      path.join(source, "confidentiality-scan.mjs"),
      "push",
      "example",
      "ext::" + helper,
    ],
    {
      cwd: f.repo,
      env: f.env,
      input:
        "refs/heads/main " + head + " refs/heads/new " + "0".repeat(40) + "\n",
    },
  );
  assert.equal(r.status, 2);
  const result = JSON.parse(r.stdout);
  assert.equal(result.status, "INCOMPLETE");
  assert.ok(Date.now() - start < 1500);
  assert.equal(r.stdout.trim().split("\n").length, 1);
  assert.equal(existsSync(marker), false);
  assert.equal(f.scan("staged").status, 2);
  // An exhausted, unfinished cycle is not repeated under a new batch label.
  const relabeled = scanned(
    run(
      process.execPath,
      [path.join(source, "confidentiality-scan.mjs"), "staged"],
      {
        cwd: f.repo,
        env: { ...f.env, CONFIDENTIALITY_BATCH_ID: "synthetic-relabel" },
      },
    ),
  );
  assert.equal(relabeled.status, "INCOMPLETE");
  assert.equal(relabeled.cycle.id, result.cycle.id);
  assert.equal(relabeled.cycle.transition, "continue-open");
  assert.equal(relabeled.cycle.hold.category, "BUDGET_EXHAUSTED");
  assert.equal(relabeled.cycleRemainingMs, 0);
  assert.equal(relabeled.cycle.exhausted, true, "the STOP condition is named");
  assert.equal(relabeled.cycle.ledger, path.basename(stateFile));
  // Health verifies the installation inside its own window: it is not bounded
  // by the exhausted cycle and reports that cycle's STOP state instead.
  const health = scanned(f.scan("health"));
  assert.equal(health.status, "PASS");
  assert.equal(health.cycle.id, result.cycle.id);
  assert.equal(health.cycle.exhausted, true);
  assert.equal(health.cycle.remainingMs, 0);
  assert.equal(health.cycle.hold.category, "BUDGET_EXHAUSTED");
  assert.ok(existsSync(pidFile), "the slow related process actually started");
  await new Promise((resolve) => setTimeout(resolve, 2200));
  assert.equal(
    existsSync(marker),
    false,
    "the helper cannot continue after the deadline",
  );
});

test("a completed publication cycle closes on recorded completion and new content reuses unchanged coverage", (t) => {
  const f = fixture(t);
  add(f, "Cycle one bytes\n");
  f.good("commit", "-m", "Synthetic cycle one");
  const committed = ledger(f);
  assert.equal(committed.format, 2);
  assert.equal(committed.cycle.checks.staged.status, "PASS");
  assert.equal(committed.cycle.checks.message.status, "PASS");
  assert.equal(committed.cycle.pendingPush, true);
  assert.equal(committed.cycle.complete, false);
  // A new label alone does not close the still-unpushed cycle.
  const relabeled = scanned(
    run(
      process.execPath,
      [path.join(source, "confidentiality-scan.mjs"), "staged"],
      {
        cwd: f.repo,
        env: { ...f.env, CONFIDENTIALITY_BATCH_ID: "synthetic-relabel" },
      },
    ),
  );
  assert.equal(relabeled.cycle.id, committed.cycle.id);
  assert.equal(relabeled.cycle.transition, "continue-open");
  f.good("push", "origin", "main");
  const pushed = ledger(f);
  assert.equal(pushed.cycle.id, committed.cycle.id);
  assert.equal(pushed.cycle.checks.push.status, "PASS");
  assert.equal(pushed.cycle.complete, true);
  assert.equal(pushed.cycle.pendingPush, false);
  assert.equal(pushed.cycle.hold, null);
  assert.ok(pushed.cycle.usedMs > relabeled.cycleUsedMs);
  // Unchanged content after completion is an unchanged retry, not new content,
  // whatever label it carries.
  const retry = scanned(
    run(
      process.execPath,
      [path.join(source, "confidentiality-scan.mjs"), "staged"],
      {
        cwd: f.repo,
        env: { ...f.env, CONFIDENTIALITY_BATCH_ID: "synthetic-other-label" },
      },
    ),
  );
  assert.equal(retry.cycle.id, pushed.cycle.id);
  assert.equal(retry.cycle.transition, "unchanged-retry");
  assert.equal(retry.cycle.complete, true);
  // Genuinely new outgoing content starts a new cycle; the archived cycle
  // keeps its own accounting and unchanged blob coverage is reused.
  add(f, "Cycle one bytes\n", "reused.txt");
  const next = scanned(f.scan("staged"));
  assert.equal(next.status, "PASS");
  assert.equal(next.cycle.transition, "new-content");
  assert.notEqual(next.cycle.id, pushed.cycle.id);
  assert.equal(next.scanned, 0, "unchanged bytes are still-valid coverage");
  assert.ok(next.reused > 0);
  const started = ledger(f);
  assert.equal(started.completed.length, 1);
  assert.equal(started.completed[0].id, pushed.cycle.id);
  assert.equal(started.completed[0].usedMs, retry.cycleUsedMs);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(started.completed[0].checks).map(([m, c]) => [
        m,
        c.status,
      ]),
    ),
    { staged: "PASS", message: "PASS", push: "PASS" },
  );
  assert.equal(started.cycle.usedMs + started.cycle.remainingMs, 120000);
  assert.ok(started.cycle.usedMs >= next.elapsedMs);
  assert.ok(started.cycle.usedMs < retry.cycleUsedMs);
  assert.equal(started.remainingMs, started.cycle.remainingMs);
  assert.equal(started.usedMs, started.cycle.usedMs);
  // A completed, batch-less cycle never adopts an ID set afterwards: neither
  // maintenance nor an unchanged retry may move its boundary, so later new
  // content under that ID is new content with a fresh allowance, not a
  // related publication of the leftover.
  assert.equal(started.cycle.batch, null);
  f.good("commit", "-m", "Synthetic cycle two");
  f.good("push", "origin", "main");
  const completedTwo = ledger(f);
  assert.equal(completedTwo.cycle.id, started.cycle.id);
  assert.equal(completedTwo.cycle.complete, true);
  assert.equal(completedTwo.cycle.batch, null);
  const late = { ...f.env, CONFIDENTIALITY_BATCH_ID: "synthetic-late-label" };
  const health = scanned(
    run(
      process.execPath,
      [path.join(source, "confidentiality-scan.mjs"), "health"],
      {
        cwd: f.repo,
        env: late,
      },
    ),
  );
  assert.equal(health.status, "PASS");
  assert.equal(health.cycle.id, completedTwo.cycle.id);
  assert.equal(
    health.cycle.batch,
    null,
    "health cannot label a completed cycle",
  );
  assert.equal(ledger(f).cycle.batch, null);
  const lateRetry = scanned(
    run(
      process.execPath,
      [path.join(source, "confidentiality-scan.mjs"), "staged"],
      {
        cwd: f.repo,
        env: late,
      },
    ),
  );
  assert.equal(lateRetry.cycle.transition, "unchanged-retry");
  assert.equal(lateRetry.cycle.batch, null, "a retry cannot label it either");
  assert.equal(ledger(f).cycle.batch, null);
  add(f, "Cycle three bytes\n", "third.txt");
  const third = scanned(
    run(
      process.execPath,
      [path.join(source, "confidentiality-scan.mjs"), "staged"],
      {
        cwd: f.repo,
        env: late,
      },
    ),
  );
  assert.equal(third.status, "PASS");
  assert.equal(third.cycle.transition, "new-content");
  assert.notEqual(third.cycle.id, completedTwo.cycle.id);
  assert.equal(
    third.cycle.batch,
    "synthetic-late-label",
    "a fresh cycle carries its own ID",
  );
  assert.ok(third.cycleRemainingMs > 100000, "a fresh 120 s, not the leftover");
  assert.equal(third.cycleUsedMs + third.cycleRemainingMs, 120000);
  const archived = ledger(f);
  assert.equal(archived.completed.length, 2);
  assert.equal(archived.completed[1].id, completedTwo.cycle.id);
  assert.equal(archived.completed[1].batch, null);
});
test("related publication under one declared batch shares the completed cycle until its own push", (t) => {
  const f = fixture(t);
  f.env.CONFIDENTIALITY_BATCH_ID = "synthetic-delivery";
  add(f, "Delivery bytes\n");
  f.good("commit", "-m", "Synthetic delivery");
  f.good("push", "origin", "main");
  const first = ledger(f);
  assert.equal(first.cycle.complete, true);
  assert.equal(first.cycle.batch, "synthetic-delivery");
  const body = path.join(f.dir, "publication.md");
  writeFileSync(body, "Ordinary publication text.\n");
  const outbound = scanned(f.scan("outbound", body));
  assert.equal(outbound.cycle.transition, "related-publication");
  assert.equal(outbound.cycle.id, first.cycle.id);
  assert.equal(outbound.cycle.complete, true);
  add(f, "Follow-up bytes\n", "follow-up.txt");
  const followUp = scanned(f.scan("staged"));
  assert.equal(followUp.cycle.transition, "related-publication");
  assert.equal(followUp.cycle.id, first.cycle.id);
  assert.equal(followUp.cycle.complete, false, "a new commit needs its push");
  assert.equal(followUp.cycle.pendingPush, true);
  f.good("commit", "-m", "Synthetic follow-up");
  assert.equal(ledger(f).cycle.complete, false);
  f.good("push", "origin", "main");
  const second = ledger(f);
  assert.equal(second.cycle.id, first.cycle.id);
  assert.equal(second.cycle.complete, true);
  assert.ok(second.cycle.usedMs > first.cycle.usedMs);
  assert.equal(second.completed.length, 0);
});
test("an unfinished cycle is not reset by a new batch ID, a new revision or a cosmetic edit", (t) => {
  const f = fixture(t);
  f.env.CONFIDENTIALITY_BATCH_ID = "synthetic-first";
  add(f, secretContent);
  const first = f.scan("staged");
  blocked(first, "API_TOKEN");
  const held = scanned(first);
  assert.equal(held.cycle.hold.status, "BLOCK");
  assert.equal(held.cycle.hold.mode, "staged");
  f.env.CONFIDENTIALITY_BATCH_ID = "synthetic-second";
  add(f, secretContent + "\n");
  const cosmetic = f.scan("staged");
  blocked(cosmetic, "API_TOKEN");
  const stillHeld = scanned(cosmetic);
  assert.equal(stillHeld.cycle.id, held.cycle.id);
  assert.equal(stillHeld.cycle.transition, "continue-open");
  assert.ok(stillHeld.cycleUsedMs > held.cycleUsedMs);
  assert.ok(stillHeld.cycleRemainingMs < held.cycleRemainingMs);
  f.env.CONFIDENTIALITY_BATCH_ID = "synthetic-third";
  const body = path.join(f.dir, "note.md");
  writeFileSync(body, "Unrelated ordinary text.\n");
  const unrelated = scanned(f.scan("outbound", body));
  assert.equal(unrelated.status, "PASS");
  assert.equal(unrelated.cycle.id, held.cycle.id);
  assert.equal(
    unrelated.cycle.open,
    true,
    "another check cannot lift the hold",
  );
  assert.equal(unrelated.cycle.hold.mode, "staged");
  assert.equal(
    unrelated.cycle.complete,
    false,
    "a held cycle is never printed as complete",
  );
  add(f, "Safe revision\n");
  const resolved = scanned(f.scan("staged"));
  assert.equal(resolved.status, "PASS");
  assert.equal(resolved.cycle.id, held.cycle.id);
  assert.equal(resolved.cycle.hold, null);
  assert.equal(resolved.cycle.complete, false);
  f.good("commit", "-m", "Synthetic resolved revision");
  f.good("push", "origin", "main");
  const completed = ledger(f);
  assert.equal(completed.cycle.id, held.cycle.id);
  assert.equal(completed.cycle.complete, true);
  assert.equal(completed.cycle.checks.staged.runs, 4);
  add(f, "Next delivery\n", "next.txt");
  assert.equal(scanned(f.scan("staged")).cycle.transition, "new-content");
});
test("an intermediate outgoing commit whose credential was later deleted blocks the push after clean staged checks", (t) => {
  const f = fixture(t, false);
  add(f, secretContent);
  f.good("commit", "-m", "Synthetic intermediate");
  f.good("rm", "fixture.txt");
  f.good("commit", "-m", "Synthetic removal");
  assert.equal(f.install().status, 0);
  add(f, "Safe final bytes.\n", "final.txt");
  f.good("commit", "-m", "Synthetic final");
  const committed = ledger(f);
  assert.equal(committed.cycle.checks.staged.status, "PASS");
  assert.equal(committed.cycle.hold, null);
  blocked(f.git("push", "origin", "main"), "API_TOKEN");
  const held = ledger(f);
  assert.equal(held.cycle.id, committed.cycle.id);
  assert.equal(held.cycle.checks.push.status, "BLOCK");
  assert.equal(held.cycle.hold.mode, "push");
  assert.equal(held.cycle.complete, false);
  const body = path.join(f.dir, "publication.md");
  writeFileSync(body, "Ordinary text.\n");
  const bypass = scanned(
    run(
      process.execPath,
      [path.join(source, "confidentiality-scan.mjs"), "outbound", body],
      {
        cwd: f.repo,
        env: { ...f.env, CONFIDENTIALITY_BATCH_ID: "synthetic-new-label" },
      },
    ),
  );
  assert.equal(bypass.cycle.id, held.cycle.id);
  assert.equal(bypass.cycle.transition, "continue-open");
  assert.equal(bypass.cycle.hold.mode, "push");
  blocked(f.git("push", "origin", "main"), "API_TOKEN");
});
test("a rule change invalidates cached coverage without completing or replenishing an unfinished cycle", (t) => {
  const f = fixture(t);
  add(f, secretContent);
  const held = scanned(f.scan("staged"));
  assert.equal(held.status, "BLOCK");
  const release = syntheticRelease(f);
  assert.equal(
    run(process.execPath, [release.installer, "--update"], {
      cwd: f.repo,
      env: f.env,
    }).status,
    0,
  );
  const rescanned = release.scan("staged");
  blocked(rescanned, "API_TOKEN");
  const after = scanned(rescanned);
  assert.ok(after.scanned > 0, "the changed rule version rescans the bytes");
  assert.equal(after.cycle.id, held.cycle.id);
  assert.equal(after.cycle.transition, "continue-open");
  assert.equal(after.cycle.complete, false);
  assert.equal(after.cycle.hold.mode, "staged");
  assert.ok(after.cycleUsedMs > held.cycleUsedMs);
  assert.ok(after.cycleRemainingMs < held.cycleRemainingMs);
  add(f, "Safe resolved bytes\n");
  const resolved = scanned(release.scan("staged"));
  assert.equal(resolved.status, "PASS");
  assert.equal(resolved.cycle.id, held.cycle.id);
  assert.equal(resolved.cycle.hold, null);
});
test("a legacy ledger migrates to the cycle format carrying its allowance unchanged", (t) => {
  const f = fixture(t);
  const file = ledgerFile(f);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      rule: "synthetic-previous-rule",
      batch: "synthetic-legacy",
      remainingMs: 45000,
      usedMs: 75000,
    }),
  );
  add(f, "Safe migrated bytes\n");
  const migrated = scanned(
    run(
      process.execPath,
      [path.join(source, "confidentiality-scan.mjs"), "staged"],
      {
        cwd: f.repo,
        env: { ...f.env, CONFIDENTIALITY_BATCH_ID: "synthetic-renamed" },
      },
    ),
  );
  assert.equal(migrated.status, "PASS");
  assert.equal(migrated.cycle.legacy, true);
  assert.equal(migrated.cycle.batch, "synthetic-legacy");
  assert.equal(migrated.cycle.transition, "continue-open");
  assert.ok(migrated.cycleRemainingMs < 45000);
  assert.ok(migrated.cycleUsedMs > 75000);
  assert.equal(migrated.cycleUsedMs + migrated.cycleRemainingMs, 120000);
  assert.equal(migrated.batchRemainingMs, migrated.cycleRemainingMs);
  assert.equal(migrated.batchUsedMs, migrated.cycleUsedMs);
  const state = ledger(f);
  assert.equal(state.format, 2);
  assert.equal(state.cycle.legacy, true);
  assert.equal(state.cycle.remainingMs, migrated.cycleRemainingMs);
  assert.equal(state.remainingMs, state.cycle.remainingMs);
  assert.equal(state.usedMs, state.cycle.usedMs);
  assert.equal(state.batch, "synthetic-legacy");
  assert.equal(state.completed.length, 0);
  // The migrated cycle recorded no completion, so it must complete first.
  f.good("commit", "-m", "Synthetic migrated commit");
  assert.equal(ledger(f).cycle.legacy, true);
  f.good("push", "origin", "main");
  const completed = ledger(f);
  assert.equal(completed.cycle.legacy, true);
  assert.equal(completed.cycle.complete, true);
  add(f, "Post-migration content\n", "post.txt");
  const next = scanned(f.scan("staged"));
  assert.equal(next.cycle.transition, "new-content");
  assert.equal(next.cycle.legacy, false);
  assert.equal(ledger(f).completed[0].id, completed.cycle.id);
});
test("a current-format ledger without a cycle is empty: an authorized reset reopens publication with a fresh cycle", (t) => {
  // Pure shape checks: neither reset shape is a legacy cycle with nothing left.
  assert.equal(normalizeLedger({ format: 2, cycle: null }).cycle, null);
  assert.equal(normalizeLedger({ format: 2 }).cycle, null);
  assert.equal(normalizeLedger({ format: 2, cycle: null }).completed.length, 0);
  const f = fixture(t);
  const file = ledgerFile(f);
  mkdirSync(path.dirname(file), { recursive: true });
  const archived = { id: "synthetic-archived", usedMs: 120000, checks: {} };
  writeFileSync(
    file,
    JSON.stringify({
      format: 2,
      rule: "synthetic-previous-rule",
      cycle: null,
      completed: [archived],
    }),
  );
  const empty = scanned(f.scan("health"));
  assert.equal(empty.status, "PASS");
  assert.equal(empty.cycle, null);
  assert.equal(
    JSON.parse(readFileSync(file, "utf8")).cycle,
    null,
    "health leaves the reset ledger untouched",
  );
  add(f, "Bytes after an authorized reset\n");
  const fresh = scanned(f.scan("staged"));
  assert.equal(fresh.status, "PASS");
  assert.equal(fresh.cycle.transition, "start");
  assert.equal(fresh.cycle.legacy, false);
  assert.equal(fresh.cycle.exhausted, false);
  assert.ok(fresh.cycleRemainingMs > 100000, "a fresh cycle, not 0 ms");
  assert.equal(fresh.cycleUsedMs + fresh.cycleRemainingMs, 120000);
  const state = ledger(f);
  assert.equal(state.cycle.id, fresh.cycle.id);
  assert.deepEqual(state.completed, [archived], "history is preserved");
});
test("a pre-push stdin that never closes is bounded by the cycle deadline instead of hanging", async (t) => {
  const f = fixture(t);
  add(f, "Safe bytes for a bounded read\n");
  assert.equal(f.scan("staged").status, 0);
  const file = ledgerFile(f);
  const state = JSON.parse(readFileSync(file, "utf8"));
  state.cycle.remainingMs = 600;
  state.cycle.usedMs = 119400;
  state.remainingMs = 600;
  state.usedMs = 119400;
  writeFileSync(file, JSON.stringify(state));
  const start = Date.now();
  const child = spawn(
    process.execPath,
    [path.join(source, "confidentiality-scan.mjs"), "push", "origin", f.remote],
    { cwd: f.repo, env: f.env, stdio: ["pipe", "pipe", "pipe"] },
  );
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  // Ref lines never arrive and stdin is never closed.
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 2);
  assert.ok(Date.now() - start < 5000, "the parent did not hang");
  const result = JSON.parse(stdout);
  assert.equal(result.status, "INCOMPLETE");
  assert.equal(result.findings[0].category, "BUDGET_EXHAUSTED");
  assert.equal(result.cycle.transition, "continue-open");
  assert.equal(result.cycle.exhausted, true);
  assert.equal(result.cycleRemainingMs, 0);
  assert.equal(result.cycle.ledger, path.basename(file));
  child.stdin.destroy();
});
test("health is maintenance: it never starts a publication cycle and never holds or completes one", (t) => {
  const f = fixture(t);
  const empty = scanned(f.scan("health"));
  assert.equal(empty.status, "PASS");
  assert.equal(empty.cycle, null, "no cycle without an outgoing check");
  assert.ok(!existsSync(ledgerFile(f)), "an empty ledger stays unwritten");
  add(f, secretContent);
  blocked(f.scan("staged"), "API_TOKEN");
  const held = ledger(f);
  assert.equal(held.cycle.hold.mode, "staged");
  const checked = scanned(f.scan("health"));
  assert.equal(checked.status, "PASS");
  assert.equal(checked.cycle.id, held.cycle.id);
  assert.equal(checked.cycle.transition, "continue-open");
  assert.deepEqual(
    checked.cycle.hold,
    held.cycle.hold,
    "health cannot clear a hold",
  );
  assert.equal(checked.cycle.complete, false);
  const after = ledger(f);
  assert.deepEqual(after.cycle.checks, held.cycle.checks);
  assert.ok(
    after.cycle.usedMs >= held.cycle.usedMs,
    "maintenance time is charged, never granted",
  );
  assert.equal(after.cycle.usedMs + after.cycle.remainingMs, 120000);
});

test("installer freezes only local policy and health verifies same version", (t) => {
  const f = fixture(t);
  const before = readFileSync(f.globalConfig);
  assert.equal(f.scan("health").status, 0);
  assert.equal(JSON.parse(f.install().stdout).changed, false);
  assert.ok(
    path.isAbsolute(f.good("config", "--local", "--get", "core.hooksPath")),
  );
  assert.equal(
    f.good("config", "--local", "--get", "confidentiality.approvedEmail"),
    approvedEmail,
  );
  assert.deepEqual(readFileSync(f.globalConfig), before);
});
test("unknown custom hook is preserved and installation stops", (t) => {
  const f = fixture(t, false);
  const hook = path.join(f.repo, ".git", "hooks", "pre-commit");
  const contents = "#!/bin/sh\nexit 0\n";
  writeFileSync(hook, contents);
  chmodSync(hook, 0o700);
  blocked(f.install(), "EXISTING_HOOKS_CONFLICT");
  assert.equal(readFileSync(hook, "utf8"), contents);
  assert.equal(f.git("config", "--local", "--get", "core.hooksPath").status, 1);
});
test("unknown hooksPath is preserved and installation stops", (t) => {
  const f = fixture(t, false);
  f.good("config", "--local", "core.hooksPath", "synthetic-custom-hooks");
  blocked(f.install(), "EXISTING_HOOKS_PATH_CONFLICT");
  assert.equal(
    f.good("config", "--local", "--get", "core.hooksPath"),
    "synthetic-custom-hooks",
  );
});
test("installed file tamper stops health and subsequent commit", (t) => {
  const f = fixture(t);
  const hooks = f.good("config", "--local", "--get", "core.hooksPath");
  writeFileSync(path.join(hooks, "pre-push"), "#!/bin/sh\nexit 1\n");
  blocked(f.scan("health"), "INSTALLED_FILE_CHANGED");
  add(f, "Safe synthetic change.\n");
  blocked(f.git("commit", "-m", "Synthetic update"), "INSTALLED_FILE_CHANGED");
});
test("actual pre-commit scans staged secret even when worktree is cleaned", (t) => {
  const f = fixture(t);
  add(f, secretContent);
  writeFileSync(path.join(f.repo, "fixture.txt"), "Clean working copy.\n");
  blocked(f.git("commit", "-m", "Synthetic update"), "API_TOKEN");
});
test("actual pre-commit accepts clean staged bytes despite unstaged secret", (t) => {
  const f = fixture(t);
  add(f, "Safe staged bytes.\n");
  writeFileSync(path.join(f.repo, "fixture.txt"), secretContent);
  assert.equal(f.git("commit", "-m", "Synthetic clean index").status, 0);
});
test("whole modified blob includes preexisting unchanged sensitive line", (t) => {
  const f = fixture(t, false);
  add(f, secretContent);
  f.good("commit", "-m", "Synthetic historical input");
  assert.equal(f.install().status, 0);
  add(f, secretContent + "A new unrelated line.\n");
  blocked(f.git("commit", "-m", "Synthetic update"), "API_TOKEN");
});
test("old sibling worktree without tracked guard files uses shared hooks", (t) => {
  const f = fixture(t);
  const sibling = path.join(f.dir, "stale-worktree");
  f.good("worktree", "add", "-b", "synthetic-sibling", sibling, "main");
  assert.equal(existsSync(path.join(sibling, ".githooks")), false);
  writeFileSync(path.join(sibling, "fixture.txt"), secretContent);
  assert.equal(
    run("git", ["add", "."], { cwd: sibling, env: f.env }).status,
    0,
  );
  blocked(
    run("git", ["commit", "-m", "Synthetic update"], {
      cwd: sibling,
      env: f.env,
    }),
    "API_TOKEN",
  );
});
test("actual new-branch push scans every intermediate added then removed blob", (t) => {
  const f = fixture(t, false);
  f.good("switch", "-c", "synthetic-new");
  add(f, secretContent);
  f.good("commit", "-m", "Synthetic intermediate");
  f.good("rm", "fixture.txt");
  f.good("commit", "-m", "Synthetic removal");
  assert.equal(f.install().status, 0);
  blocked(f.git("push", "origin", "synthetic-new"), "API_TOKEN");
});
test("actual push scans renamed intermediate content", (t) => {
  const f = fixture(t, false);
  add(f, secretContent);
  f.good("commit", "-m", "Synthetic intermediate");
  f.good("mv", "fixture.txt", "renamed.txt");
  f.good("commit", "-m", "Synthetic rename");
  add(f, "Safe final bytes.\n", "renamed.txt");
  f.good("commit", "-m", "Synthetic final");
  assert.equal(f.install().status, 0);
  blocked(f.git("push", "origin", "main"), "API_TOKEN");
});
test("annotated tag message is scanned even when target already remote", (t) => {
  const f = fixture(t);
  f.good("tag", "-a", "synthetic-tag", "-m", "Synthetic tag " + token);
  blocked(f.git("push", "origin", "synthetic-tag"), "API_TOKEN");
});
test("actual clean new-branch push succeeds against confirmed baseline", (t) => {
  const f = fixture(t);
  f.good("switch", "-c", "synthetic-clean");
  add(f, "Safe synthetic update.\n");
  f.good("commit", "-m", "Synthetic clean update");
  assert.equal(f.git("push", "origin", "synthetic-clean").status, 0);
});
test("unavailable remote baseline fails closed without raw Git error", (t) => {
  const f = fixture(t);
  const head = f.good("rev-parse", "HEAD");
  const result = run(
    process.execPath,
    [
      path.join(source, "confidentiality-scan.mjs"),
      "push",
      "synthetic-missing",
      path.join(f.dir, "missing.git"),
    ],
    {
      cwd: f.repo,
      env: f.env,
      input:
        "refs/heads/main " + head + " refs/heads/main " + "0".repeat(40) + "\n",
    },
  );
  blocked(result, "GIT_READ_FAILED");
  assert.equal(result.stderr, "");
  assert.ok(!result.stdout.includes(f.dir));
});
test("unrelated remote branch missing locally does not block a new branch", (t) => {
  const f = fixture(t);
  const other = path.join(f.dir, "other");
  assert.equal(
    run("git", ["clone", f.remote, other], { env: f.env }).status,
    0,
  );
  writeFileSync(path.join(other, "other.txt"), "Other synthetic bytes.\n");
  for (const args of [
    ["add", "."],
    ["commit", "-m", "Synthetic remote advance"],
    ["push", "origin", "HEAD:refs/heads/other"],
  ])
    assert.equal(run("git", args, { cwd: other, env: f.env }).status, 0);
  f.good("switch", "-c", "synthetic-local");
  add(f, "Safe bytes.\n");
  f.good("commit", "-m", "Synthetic update");
  assert.equal(f.git("push", "origin", "synthetic-local").status, 0);
});
test("merge resolution blob is scanned against all parents", (t) => {
  const f = fixture(t, false);
  f.good("switch", "-c", "synthetic-side");
  add(f, "Synthetic side.\n", "side.txt");
  f.good("commit", "-m", "Synthetic side");
  f.good("switch", "main");
  add(f, "Synthetic main.\n", "main.txt");
  f.good("commit", "-m", "Synthetic main");
  f.good("merge", "--no-commit", "--no-ff", "synthetic-side");
  add(f, secretContent);
  f.good("commit", "-m", "Synthetic merge");
  assert.equal(f.install().status, 0);
  blocked(f.git("push", "origin", "main"), "API_TOKEN");
});

test("invalid UTF-8 filenames cannot collide and hide staged sensitive content", (t) => {
  const f = fixture(t);
  const sensitiveBlob = run("git", ["hash-object", "-w", "--stdin"], {
    cwd: f.repo,
    env: f.env,
    input: secretContent,
  }).stdout.trim();
  const safeBlob = run("git", ["hash-object", "-w", "--stdin"], {
    cwd: f.repo,
    env: f.env,
    input: "Safe bytes.\n",
  }).stdout.trim();
  const indexInput = Buffer.concat([
    Buffer.from("100644 " + sensitiveBlob + "\t"),
    Buffer.from([0x80, 0]),
    Buffer.from("100644 " + safeBlob + "\t"),
    Buffer.from([0x81, 0]),
  ]);
  assert.equal(
    run("git", ["update-index", "-z", "--index-info"], {
      cwd: f.repo,
      env: f.env,
      input: indexInput,
    }).status,
    0,
  );
  blocked(f.scan("staged"), "GIT_TEXT_UNREADABLE");
});
test("repository fsmonitor helper is not executed during staged inspection", (t) => {
  const f = fixture(t);
  const marker = path.join(f.dir, "helper-ran");
  const helper = path.join(f.dir, "synthetic-helper");
  writeFileSync(helper, '#!/bin/sh\nprintf x > "' + marker + '"\n');
  chmodSync(helper, 0o700);
  add(f, "Safe bytes.\n");
  f.good("config", "core.fsmonitor", helper);
  assert.equal(f.scan("staged").status, 0);
  assert.equal(existsSync(marker), false);
});
test("controlled update preserves shared directory and requires explicit update", (t) => {
  const f = fixture(t);
  f.env.CONFIDENTIALITY_BATCH_ID = "synthetic-controlled-update";
  add(f, "Reusable content across a rule update\n");
  const prior = JSON.parse(f.scan("staged").stdout);
  const { scanner: nextScanner, installer } = syntheticRelease(f);
  const hooks = f.good("config", "--local", "--get", "core.hooksPath");
  blocked(
    run(process.execPath, [installer], { cwd: f.repo, env: f.env }),
    "EXPLICIT_CONTROLLED_UPDATE_REQUIRED",
  );
  assert.equal(
    run(process.execPath, [installer, "--update"], { cwd: f.repo, env: f.env })
      .status,
    0,
  );
  assert.equal(f.good("config", "--local", "--get", "core.hooksPath"), hooks);
  const next = run(process.execPath, [nextScanner, "staged"], {
    cwd: f.repo,
    env: f.env,
  });
  assert.equal(next.status, 0);
  const refreshed = JSON.parse(next.stdout);
  assert.ok(refreshed.scanned > 0, "a changed rule invalidates cached content");
  assert.ok(
    refreshed.batchUsedMs > prior.batchUsedMs,
    "a rule update cannot replenish this delivery allowance",
  );
  assert.equal(
    run(process.execPath, [nextScanner, "health"], { cwd: f.repo, env: f.env })
      .status,
    0,
  );
  add(f, secretContent);
  blocked(f.git("commit", "-m", "Synthetic update"), "API_TOKEN");
});

test("stdin module import never runs CLI or emits a raw filesystem error", () => {
  const moduleFile = path.join(source, "confidentiality-scan.mjs");
  const result = run(process.execPath, ["--input-type=module", "-"], {
    input:
      "await import(" +
      JSON.stringify(moduleFile) +
      "); console.log('IMPORT_OK');",
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "IMPORT_OK");
  assert.equal(result.stderr, "");
});

test("installer refuses nonexecutable hooks for idempotent and update operations", (t) => {
  const f = fixture(t);
  const hooks = f.good("config", "--local", "--get", "core.hooksPath");
  for (const file of ["pre-commit", "commit-msg", "pre-push"])
    chmodSync(path.join(hooks, file), 0o600);
  blocked(f.install(), "HOOK_NOT_EXECUTABLE");
  blocked(f.install("--update"), "HOOK_NOT_EXECUTABLE");
  blocked(f.scan("health"), "HOOK_NOT_EXECUTABLE");
});

test("all hooks fail safely when PATH contains no runtime utilities", (t) => {
  const f = fixture(t);
  const hooks = f.good("config", "--local", "--get", "core.hooksPath");
  const emptyPath = path.join(f.dir, "empty-bin");
  mkdirSync(emptyPath);
  for (const file of ["pre-commit", "commit-msg", "pre-push"]) {
    const result = run("/bin/sh", [path.join(hooks, file)], {
      cwd: f.repo,
      env: { ...f.env, PATH: emptyPath },
    });
    blocked(result, "HOOK_RUNTIME_MISSING");
    assert.equal(result.stderr, "");
    assert.ok(!result.stdout.includes(f.dir));
  }
});
test("missing promisor blob remains missing and inspection cannot lazy fetch", (t) => {
  const f = fixture(t, false);
  assert.equal(
    run(
      "git",
      ["--git-dir", f.remote, "config", "uploadpack.allowFilter", "true"],
      { env: f.env },
    ).status,
    0,
  );
  const oid = f.good("rev-parse", "HEAD:safe.txt");
  const partial = path.join(f.dir, "partial-clone");
  const clone = run(
    "git",
    [
      "clone",
      "--filter=blob:none",
      "--no-checkout",
      pathToFileURL(f.remote).href,
      partial,
    ],
    { env: f.env },
  );
  assert.equal(clone.status, 0, "synthetic filtered clone must succeed");
  const present = () =>
    run("git", ["--no-lazy-fetch", "cat-file", "-e", oid], {
      cwd: partial,
      env: f.env,
    }).status === 0;
  assert.equal(present(), false, "synthetic blob must initially be missing");
  const program =
    "const {git}=await import(" +
    JSON.stringify(path.join(source, "confidentiality-scan.mjs")) +
    "); try {git(['cat-file','-s'," +
    JSON.stringify(oid) +
    "]); console.log('UNEXPECTED_PASS');} catch {console.log('EXPECTED_STOP');process.exitCode=1;}";
  const result = run(process.execPath, ["--input-type=module", "-"], {
    cwd: partial,
    env: f.env,
    input: program,
  });
  blocked(result, "EXPECTED_STOP");
  assert.equal(result.stderr, "");
  assert.equal(
    present(),
    false,
    "inspection must not materialize the missing object",
  );
});

test("pre-push input rejects invalid UTF-8 ref names before remote access", (t) => {
  const f = fixture(t);
  const head = f.good("rev-parse", "HEAD");
  for (const location of ["local", "remote"]) {
    const local =
      location === "local" ? Buffer.from([0x80]) : Buffer.from("main");
    const remote =
      location === "remote" ? Buffer.from([0x81]) : Buffer.from("new");
    const input = Buffer.concat([
      Buffer.from("refs/heads/"),
      local,
      Buffer.from(" " + head + " refs/heads/"),
      remote,
      Buffer.from(" " + "0".repeat(40) + "\n"),
    ]);
    const result = run(
      process.execPath,
      [
        path.join(source, "confidentiality-scan.mjs"),
        "push",
        "origin",
        f.remote,
      ],
      { cwd: f.repo, env: f.env, input },
    );
    blocked(result, "PUSH_INPUT_UNDETERMINED");
    assert.equal(result.stderr, "");
  }
});
