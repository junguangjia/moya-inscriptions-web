import { Buffer } from "node:buffer";
import { classifyTask } from "./ci-task-scope.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  chmod,
  lstat,
  realpath,
  rm,
  symlink,
  open,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import {
  LIMITS,
  classifySource,
  readConfiguration,
  runArchive,
} from "./operations/archive-runtime-data.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const backup =
  "/var/backups/artvenn-db/artvenn-db-daily-20261025T024000Z-yoyi_payload.pgdump";
const security = "/var/log/nginx/yoyi-security/yoyi-security.log.1";
const traffic = "/var/log/nginx/yoyi-analytics/yoyi-access.log";
const row = {
  at: "2026-10-25T01:00:00Z",
  status: 200,
  duration: 0.12,
  bytes: 123,
  method: "GET",
  route: "catalog",
  client: "browser-like",
  device_excluded: 1,
  ip: "198.51.100.21",
  path: "/synthetic-private-query?cap=must-not-archive",
  ua: "synthetic-private-UA",
  authorization: "synthetic-not-a-real-token",
};

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "ops-archive-synthetic-")),
  );
  await chmod(root, 0o700);
  const path = (logical) => join(root, logical.slice(1));
  for (const directory of [
    "/var/backups/artvenn-db",
    "/var/log/nginx/yoyi-security",
    "/var/log/nginx/yoyi-analytics",
    "/var/lib",
  ])
    await mkdir(path(directory), { recursive: true, mode: 0o700 });
  const configPath = join(root, "config.env");
  const config =
    [
      ["OPS_ARCHIVE_COS_BUCKET", "synthetic-private-1250000000"],
      ["OPS_ARCHIVE_COS_REGION", "ap-guangzhou"],
      ["OPS_ARCHIVE_COS_SECRET_ID", "SYNTHETIC_TEST_ONLY_OPS_ID"],
      ["OPS_ARCHIVE_COS_SECRET_KEY", "SYNTHETIC_TEST_ONLY_OPS_KEY"],
    ]
      .map((pair) => pair.join("="))
      .join("\n") + "\n";
  await writeFile(configPath, config, { mode: 0o600 });
  const objects = new Map(),
    calls = [];
  const state = {
    putFailure: false,
    corruptGet: false,
    commitThenFail: false,
    legacyChecksum: false,
  };
  const transport = async (input) => {
    calls.push(input);
    assert.ok(input.timeoutMs > 0 && input.timeoutMs <= 15000);
    assert.equal(input.url.protocol, "https:");
    assert.equal(
      input.url.hostname,
      "synthetic-private-1250000000.cos.ap-guangzhou.myqcloud.com",
    );
    assert.equal(
      input.headers.authorization,
      "SYNTHETIC_AUTHORIZATION_PLACEHOLDER",
    );
    const key = input.url.pathname.slice(1),
      object = objects.get(key);
    if (input.method === "HEAD")
      return object
        ? {
            statusCode: 200,
            headers: {
              "content-length": String(object.length),
              "x-cos-server-side-encryption": "AES256",
              [state.legacyChecksum
                ? "x-cos-meta-sha256"
                : "x-cos-meta-archive-sha256"]: digest(object),
            },
            body: Buffer.alloc(0),
          }
        : { statusCode: 404, headers: {}, body: Buffer.alloc(0) };
    if (input.method === "PUT") {
      if (state.putFailure)
        throw new Error("synthetic private provider diagnostic");
      assert.equal(input.headers["x-cos-acl"], "private");
      assert.equal(input.headers["x-cos-server-side-encryption"], "AES256");
      assert.equal(input.headers["x-cos-forbid-overwrite"], "true");
      assert.equal(
        input.headers["content-md5"],
        createHash("md5").update(input.body).digest("base64"),
      );
      if (object)
        return { statusCode: 409, headers: {}, body: Buffer.alloc(0) };
      objects.set(key, Buffer.from(input.body));
      if (state.commitThenFail)
        throw new Error("synthetic lost PUT response after commit");
      return { statusCode: 200, headers: {}, body: Buffer.alloc(0) };
    }
    assert.equal(input.method, "GET");
    assert.ok(object);
    const body = Buffer.from(object);
    if (state.corruptGet && body.length) body[0] ^= 1;
    return { statusCode: 200, headers: {}, body };
  };
  const run = (options) =>
    runArchive(
      { configPath, ...options },
      {
        fixtureRoot: root,
        transport,
        signer: () => "SYNTHETIC_AUTHORIZATION_PLACEHOLDER",
      },
    );
  const put = async (logical, body) =>
    writeFile(path(logical), body, { mode: 0o600 });
  const putBackup = async (logical = backup) => {
    const body = Buffer.from("PGDMPsynthetic-private-database-only");
    await put(logical, body);
    await put(
      logical + ".sha256",
      digest(body) + "  " + basename(logical) + "\n",
    );
    return body;
  };
  const receipts = async () =>
    JSON.parse(
      await readFile(path("/var/lib/yoyi-ops-archive/state.json"), "utf8"),
    );
  return {
    root,
    path,
    config,
    configPath,
    objects,
    calls,
    state,
    transport,
    run,
    put,
    putBackup,
    receipts,
    close: () => rm(root, { recursive: true, force: true }),
  };
}

test("backup pairs are verified through HEAD and full GET, receipts are private, and repeats skip unchanged files", async () => {
  const f = await fixture();
  try {
    const original = await f.putBackup();
    const result = await f.run();
    assert.equal(result.verified, 1);
    assert.equal(result.sourceDeleted, 0);
    assert.equal(result.failed, 0);
    assert.deepEqual(
      f.calls.map((c) => c.method),
      ["HEAD", "PUT", "HEAD", "GET"],
    );
    assert.deepEqual(await readFile(f.path(backup)), original);
    assert.equal(
      [...f.objects.keys()][0],
      `ops/backups/daily/2026-10-25/${digest(original)}.pgdump`,
    );
    assert.equal(Object.keys((await f.receipts()).entries).length, 1);
    assert.equal(
      (await lstat(f.path("/var/lib/yoyi-ops-archive/state.json"))).mode &
        0o777,
      0o600,
    );
    const calls = f.calls.length;
    const again = await f.run();
    assert.equal(again.skipped, 1);
    assert.equal(f.calls.length, calls);
  } finally {
    await f.close();
  }
});

test("PUT failure and GET hash mismatch never record success or remove source data", async () => {
  for (const mode of ["putFailure", "corruptGet"]) {
    const f = await fixture();
    try {
      const original = await f.putBackup();
      f.state[mode] = true;
      const result = await f.run();
      assert.equal(result.verified, 0);
      assert.equal(result.failed, 1);
      assert.equal(result.sourceDeleted, 0);
      assert.deepEqual(await readFile(f.path(backup)), original);
      await assert.rejects(f.receipts(), { code: "ENOENT" });
      assert.equal(
        JSON.stringify(result).includes("private provider diagnostic"),
        false,
      );
      assert.equal(f.calls.filter((c) => c.method === "PUT").length, 1);
    } finally {
      await f.close();
    }
  }
});

test("an existing backup with the reviewed legacy checksum alias is read back without overwrite", async () => {
  const f = await fixture();
  try {
    const body = await f.putBackup();
    const key = `ops/backups/daily/2026-10-25/${digest(body)}.pgdump`;
    f.objects.set(key, Buffer.from(body));
    f.state.legacyChecksum = true;
    const result = await f.run();
    assert.equal(result.verified, 1);
    assert.equal(result.failed, 0);
    assert.deepEqual(
      f.calls.map((call) => call.method),
      ["HEAD", "GET"],
    );
    assert.equal(Object.keys((await f.receipts()).entries).length, 1);
    assert.deepEqual(await readFile(f.path(backup)), body);
  } finally {
    await f.close();
  }
});

test("a matching legacy checksum metadata never substitutes for full GET content verification", async () => {
  const f = await fixture();
  try {
    const body = await f.putBackup();
    const key = `ops/backups/daily/2026-10-25/${digest(body)}.pgdump`;
    f.objects.set(key, Buffer.from(body));
    f.state.legacyChecksum = true;
    f.state.corruptGet = true;
    const result = await f.run();
    assert.equal(result.verified, 0);
    assert.equal(result.categories.COS_READBACK_HASH_MISMATCH, 1);
    assert.deepEqual(
      f.calls.map((call) => call.method),
      ["HEAD", "GET"],
    );
    await assert.rejects(f.receipts(), { code: "ENOENT" });
    assert.deepEqual(f.objects.get(key), body);
    assert.deepEqual(await readFile(f.path(backup)), body);
  } finally {
    await f.close();
  }
});

test("an ambiguously committed PUT is recovered by HEAD/GET on the next run without retrying PUT", async () => {
  const f = await fixture();
  try {
    await f.putBackup();
    f.state.commitThenFail = true;
    assert.equal((await f.run()).failed, 1);
    assert.equal(f.objects.size, 1);
    f.state.commitThenFail = false;
    assert.equal((await f.run()).verified, 1);
    assert.equal(f.calls.filter((c) => c.method === "PUT").length, 1);
    assert.equal(f.calls.at(-1).method, "GET");
  } finally {
    await f.close();
  }
});

test("the total input bound stops a batch and verified fingerprints let the next batch resume", async () => {
  const f = await fixture();
  try {
    await f.putBackup();
    const second =
      "/var/backups/artvenn-db/artvenn-db-daily-20261025T034000Z-yoyi_payload.pgdump";
    await f.putBackup(second);
    const options = {
      fixtureRoot: f.root,
      transport: f.transport,
      signer: () => "SYNTHETIC_AUTHORIZATION_PLACEHOLDER",
      inputLimit: 200,
    };
    const first = await runArchive({ configPath: f.configPath }, options);
    assert.equal(first.verified, 1);
    assert.equal(first.categories.INPUT_BUDGET_REACHED, 1);
    const next = await runArchive({ configPath: f.configPath }, options);
    assert.equal(next.skipped, 1);
    assert.equal(next.verified, 1);
    assert.equal(next.failed, 0);
    assert.ok((await lstat(f.path(backup))).isFile());
    assert.ok((await lstat(f.path(second))).isFile());
  } finally {
    await f.close();
  }
});

test("bounded runs archive the newest backup before older backups and traffic", async () => {
  const f = await fixture();
  try {
    const newest =
      "/var/backups/artvenn-db/artvenn-db-daily-20261025T054000Z-yoyi_payload.pgdump";
    await f.putBackup(backup);
    await f.putBackup(newest);
    await utimes(
      f.path(backup),
      new Date("2026-10-24T01:00:00Z"),
      new Date("2026-10-24T01:00:00Z"),
    );
    await utimes(
      f.path(newest),
      new Date("2026-10-25T05:40:00Z"),
      new Date("2026-10-25T05:40:00Z"),
    );
    await f.put(traffic, JSON.stringify(row) + "\n");
    const result = await runArchive(
      { configPath: f.configPath },
      {
        fixtureRoot: f.root,
        transport: f.transport,
        signer: () => "SYNTHETIC_AUTHORIZATION_PLACEHOLDER",
        inputLimit: 200,
      },
    );
    assert.equal(result.verified, 1);
    const receipts = Object.values((await f.receipts()).entries);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].sourceName, basename(newest));
    assert.equal(result.categories.INPUT_BUDGET_REACHED, 1);
    assert.ok(
      f.calls
        .filter((call) => call.method === "PUT")
        .every((call) => call.url.pathname.startsWith("/ops/backups/")),
    );
    assert.ok((await lstat(f.path(backup))).isFile());
    assert.ok((await lstat(f.path(newest))).isFile());
  } finally {
    await f.close();
  }
});

test("a concurrent run cannot remove the active private PID lock", async () => {
  const f = await fixture();
  let release, entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  try {
    await f.putBackup();
    let first = true;
    const pending = runArchive(
      { configPath: f.configPath },
      {
        fixtureRoot: f.root,
        signer: () => "SYNTHETIC_AUTHORIZATION_PLACEHOLDER",
        transport: async (input) => {
          if (first) {
            first = false;
            entered();
            await gate;
          }
          return f.transport(input);
        },
      },
    );
    await started;
    await assert.rejects(f.run(), /ARCHIVE_LOCKED/);
    assert.equal(
      (await lstat(f.path("/var/lib/yoyi-ops-archive/lock.json"))).isFile(),
      true,
    );
    release();
    assert.equal((await pending).verified, 1);
    await assert.rejects(lstat(f.path("/var/lib/yoyi-ops-archive/lock.json")), {
      code: "ENOENT",
    });
  } finally {
    release();
    await f.close();
  }
});

test("traffic archives contain only aggregate fields and no source IP, UA, path, credential or user text", async () => {
  const f = await fixture();
  try {
    const original = Buffer.from(JSON.stringify(row) + "\n");
    await f.put(traffic, original);
    assert.equal((await f.run()).verified, 1);
    const [key, body] = [...f.objects][0];
    assert.match(
      key,
      /^ops\/metrics\/traffic\/\d{4}-\d{2}-\d{2}\/[a-f0-9]{64}\.json\.gz$/,
    );
    const decoded = gunzipSync(body).toString("utf8");
    for (const value of [row.ip, row.ua, row.path, row.authorization])
      assert.equal(decoded.includes(value), false);
    assert.equal(JSON.parse(decoded).summary.requests, 1);
    assert.deepEqual(await readFile(f.path(traffic)), original);
  } finally {
    await f.close();
  }
});

test("security projection keeps approved security fields, discards extra raw fields, and leaves canonical snapshots intact", async () => {
  const f = await fixture();
  try {
    const original = Buffer.from(JSON.stringify(row) + "\n");
    await f.put(security, original);
    await f.put("/var/log/nginx/yoyi-security/yoyi-security.log", original);
    assert.equal((await f.run()).verified, 1);
    const [key, body] = [...f.objects][0];
    assert.match(
      key,
      /^ops\/logs\/security\/\d{4}-\d{2}-\d{2}\/[a-f0-9]{64}\.jsonl\.gz$/,
    );
    const decoded = gunzipSync(body).toString("utf8");
    assert.equal(JSON.parse(decoded).ip, row.ip);
    for (const value of [row.ua, row.path, row.authorization])
      assert.equal(decoded.includes(value), false);
    const snapshot = await f.run({ securitySnapshot: true });
    assert.equal(snapshot.verified, 1);
    assert.equal(snapshot.sourceDeleted, 0);
    assert.deepEqual(
      await readFile(f.path("/var/log/nginx/yoyi-security/yoyi-security.log")),
      original,
    );
  } finally {
    await f.close();
  }
});

test("explicit config rejects broad permissions, media credentials and symlinks", async () => {
  const f = await fixture();
  try {
    await chmod(f.configPath, 0o644);
    await assert.rejects(
      readConfiguration(f.configPath, f.root),
      /PRIVATE_FILE_METADATA/,
    );
    await chmod(f.configPath, 0o600);
    await writeFile(
      f.configPath,
      f.config +
        ["COS_SECRET_KEY", "SYNTHETIC_TEST_ONLY_MEDIA_KEY"].join("=") +
        "\n",
    );
    await assert.rejects(
      readConfiguration(f.configPath, f.root),
      /CONFIG_KEYS_NOT_EXPLICIT/,
    );
    await writeFile(f.configPath, f.config);
    const link = join(f.root, "link.env");
    await symlink(f.configPath, link);
    await assert.rejects(readConfiguration(link, f.root));
    await assert.rejects(
      runArchive({ configPath: f.configPath }, { fixtureRoot: f.root }),
      /FIXTURE_TRANSPORT_REQUIRED/,
    );
  } finally {
    await f.close();
  }
});

test("symlinked sources, outside paths and oversized files are refused before upload", async () => {
  const f = await fixture();
  try {
    for (const path of [
      "/etc/yoyi/backend.env",
      "/srv/yoyi/releases/source.tar",
      "/var/backups/artvenn-db/../credential.pgdump",
      "/var/log/nginx/yoyi-security/yoyi-security.log",
    ])
      assert.throws(() => classifySource(path), /ALLOWLIST/);
    await writeFile(join(f.root, "outside"), "synthetic private text");
    await symlink(join(f.root, "outside"), f.path(backup));
    assert.equal((await f.run()).failed, 1);
    assert.equal(f.calls.length, 0);
    await rm(f.path(backup));
    const file = await open(f.path(backup), "wx", 0o600);
    try {
      await file.truncate(LIMITS.fileBytes + 1);
    } finally {
      await file.close();
    }
    const result = await f.run();
    assert.equal(result.categories.FILE_TOO_LARGE, 1);
    assert.equal(f.calls.length, 0);
    assert.equal((await lstat(f.path(backup))).size, LIMITS.fileBytes + 1);
  } finally {
    await f.close();
  }
});

test("a mismatched local backup checksum is never uploaded and milestone keys stay separate", async () => {
  const f = await fixture();
  try {
    const original = await f.putBackup();
    await f.put(
      backup + ".sha256",
      "0".repeat(64) + "  " + basename(backup) + "\n",
    );
    assert.equal((await f.run()).categories.BACKUP_SOURCE_CHECKSUM_MISMATCH, 1);
    assert.equal(f.calls.length, 0);
    await rm(f.path(backup));
    await rm(f.path(backup + ".sha256"));
    await f.putBackup("/var/backups/artvenn-db/synthetic-pre-migration.pgdump");
    assert.equal((await f.run()).verified, 1);
    assert.equal(
      [...f.objects.keys()][0],
      `ops/backups/milestones/${digest(original)}.pgdump`,
    );
  } finally {
    await f.close();
  }
});

test("receipts are bounded, request bounds are clipped, and no source is touched when the run budget expires", async () => {
  const f = await fixture();
  try {
    await f.putBackup();
    assert.equal(
      (
        await runArchive(
          { configPath: f.configPath },
          {
            fixtureRoot: f.root,
            transport: f.transport,
            signer: () => "SYNTHETIC_AUTHORIZATION_PLACEHOLDER",
            budgetMs: 1000,
          },
        )
      ).verified,
      1,
    );
    assert.ok(f.calls.every((call) => call.timeoutMs <= 1000));
    const calls = f.calls.length;
    const result = await runArchive(
      { configPath: f.configPath },
      {
        fixtureRoot: f.root,
        transport: f.transport,
        signer: () => "SYNTHETIC_AUTHORIZATION_PLACEHOLDER",
        budgetMs: 0.001,
      },
    );
    assert.equal(result.categories.DEADLINE_EXPIRED, 1);
    assert.equal(f.calls.length, calls);
    assert.equal((await lstat(f.path(backup))).isFile(), true);
    const state = await f.receipts(),
      receipt = Object.values(state.entries)[0];
    state.entries = Object.fromEntries(
      Array.from({ length: LIMITS.receipts }, (_, i) => [
        i.toString(16).padStart(64, "0"),
        { ...receipt, verifiedAt: receipt.verifiedAt - i - 1000 },
      ]),
    );
    await writeFile(
      f.path("/var/lib/yoyi-ops-archive/state.json"),
      JSON.stringify(state),
    );
    assert.equal((await f.run()).verified, 1);
    assert.equal(
      Object.keys((await f.receipts()).entries).length,
      LIMITS.receipts,
    );
    assert.ok(
      (await lstat(f.path("/var/lib/yoyi-ops-archive/state.json"))).size <=
        LIMITS.stateBytes,
    );
  } finally {
    await f.close();
  }
});

test("only the two reviewed archive entries receive tooling routing", () => {
  for (const path of [
    "scripts/build-ops-archive-bundle.mjs",
    "scripts/operations/archive-runtime-data.mjs",
  ]) {
    const plan = classifyTask([path], "local");
    assert.equal(plan.lightweight, true);
    assert.equal(plan.web, false);
    assert.equal(plan.cms, false);
  }
  assert.throws(
    () => classifyTask(["scripts/operations/unreviewed-export.mjs"], "local"),
    /Unmapped changed paths/,
  );
  const runtime = classifyTask(
    [
      "scripts/operations/archive-runtime-data.mjs",
      "services/backend-production/src/reporting/store.ts",
    ],
    "local",
  );
  assert.equal(runtime.web, true);
  assert.equal(runtime.cms, true);
});

test("malformed or extension request methods retain safe security facts without copying raw method text", async () => {
  const f = await fixture();
  try {
    const original = Buffer.from(
      JSON.stringify({
        ...row,
        method: "SYNTHETIC_UNKNOWN_METHOD",
        status: 400,
      }) + "\n",
    );
    await f.put(security, original);
    const result = await f.run();
    assert.equal(result.failed, 0);
    assert.equal(result.verified, 1);
    const archived = gunzipSync([...f.objects.values()][0]).toString("utf8");
    assert.equal(JSON.parse(archived).method, "OTHER");
    assert.equal(JSON.parse(archived).status, 400);
    assert.equal(archived.includes("SYNTHETIC_UNKNOWN_METHOD"), false);
    assert.deepEqual(await readFile(f.path(security)), original);
  } finally {
    await f.close();
  }
});
