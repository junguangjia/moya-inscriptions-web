#!/usr/bin/env node
import { Buffer } from "node:buffer";
import process from "node:process";
import console from "node:console";
import { setTimeout, clearTimeout } from "node:timers";
import { URL } from "node:url";
/** Private, bounded, archive-only maintenance. No source deletion or retries. */
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs, parseEnv, promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { gzip, gunzip } from "node:zlib";
import { summarizeTraffic } from "../analytics/summarize-traffic.mjs";

export const LIMITS = Object.freeze({
  fileBytes: 64 * 1024 ** 2,
  runBytes: 256 * 1024 ** 2,
  deadlineMs: 240000,
  requestMs: 15000,
  stateBytes: 1024 ** 2,
  receipts: 1024,
});
async function productionBindings() {
  const [{ signCosRequest }, { requestCosHttps }] = await Promise.all([
    import("../../services/backend-production/dist/storage/cos-signature.js"),
    import("../../services/backend-production/dist/storage/cos-https.js"),
  ]);
  return { signer: signCosRequest, transport: requestCosHttps };
}
const VERSION = "ops-private-archive-v1";
const STATE = "/var/lib/yoyi-ops-archive";
const BACKUPS = "/var/backups/artvenn-db";
const SECURITY = "/var/log/nginx/yoyi-security";
const TRAFFIC = "/var/log/nginx/yoyi-analytics";
const CONFIG_KEYS = ["BUCKET", "REGION", "SECRET_ID", "SECRET_KEY"].map(
  (x) => "OPS_ARCHIVE_COS_" + x,
);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const encoded = (value) => Buffer.from(JSON.stringify(value) + "\n");
const zip = promisify(gzip),
  unzip = promisify(gunzip);
class ArchiveError extends Error {
  constructor(category) {
    super(category);
    this.category = category;
  }
}
const need = (test, category) => {
  if (!test) throw new ArchiveError(category);
};
const category = (error) =>
  error instanceof ArchiveError ? error.category : "ARCHIVE_OPERATION_FAILED";
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const identity = (s) =>
  [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.mode, s.uid, s.nlink].map(
    String,
  );
const utcDate = (ms) => new Date(ms).toISOString().slice(0, 10);

export function classifySource(path, securitySnapshot = false) {
  need(isAbsolute(path) && resolve(path) === path, "SOURCE_OUTSIDE_ALLOWLIST");
  const name = basename(path),
    parent = dirname(path);
  if (
    parent === BACKUPS &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.pgdump$/u.test(name)
  )
    return { kind: "backup", snapshot: false };
  if (parent === SECURITY) {
    if (name === "yoyi-security.log" && securitySnapshot)
      return { kind: "security", snapshot: true };
    const number = /^yoyi-security\.log\.([1-9]\d{0,2})\.gz$/u.exec(name)?.[1];
    if (name === "yoyi-security.log.1" || (number && Number(number) <= 200))
      return { kind: "security", snapshot: false };
  }
  if (
    parent === TRAFFIC &&
    /^yoyi-(?:access|article-status)\.log(?:\.[1-6](?:\.gz)?)?$/u.test(name)
  )
    return { kind: "traffic", snapshot: !/\.log\./u.test(name) };
  throw new ArchiveError("SOURCE_OUTSIDE_ALLOWLIST");
}

async function ancestors(path, floor = "/") {
  let current = dirname(path);
  for (;;) {
    const s = await lstat(current);
    need(
      s.isDirectory() && !s.isSymbolicLink() && (s.mode & 0o022) === 0,
      "UNSAFE_PATH_ANCESTOR",
    );
    if (current === floor) return;
    need(current !== dirname(current), "PATH_OUTSIDE_FIXTURE");
    current = dirname(current);
  }
}

async function privateBytes(path, maximum, floor = "/") {
  await ancestors(path, floor);
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await file.stat({ bigint: true });
    need(
      before.isFile() &&
        before.nlink === 1n &&
        before.uid === BigInt(process.geteuid()) &&
        (before.mode & 0o777n) === 0o600n &&
        before.size <= BigInt(maximum),
      "PRIVATE_FILE_METADATA",
    );
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const r = await file.read(
        bytes,
        offset,
        Math.min(65536, bytes.length - offset),
        offset,
      );
      need(r.bytesRead > 0, "PRIVATE_FILE_CHANGED");
      offset += r.bytesRead;
    }
    need(
      same(identity(before), identity(await file.stat({ bigint: true }))),
      "PRIVATE_FILE_CHANGED",
    );
    need(bytes.length <= maximum, "PRIVATE_FILE_SIZE");
    return bytes;
  } finally {
    await file.close();
  }
}

export async function readConfiguration(path, floor = "/") {
  need(isAbsolute(path), "EXPLICIT_PRIVATE_CONFIG_REQUIRED");
  const values = parseEnv(
    (await privateBytes(path, 16384, floor)).toString("utf8"),
  );
  need(
    same(Object.keys(values).sort(), [...CONFIG_KEYS].sort()),
    "CONFIG_KEYS_NOT_EXPLICIT",
  );
  for (const key of CONFIG_KEYS)
    need(
      values[key] &&
        values[key].trim() === values[key] &&
        !/[\r\n\0]/u.test(values[key]) &&
        !values[key].startsWith("REPLACE_ME"),
      "CONFIG_VALUE_INVALID",
    );
  need(
    /^[a-z0-9][a-z0-9-]{1,49}-[0-9]{5,20}$/u.test(
      values.OPS_ARCHIVE_COS_BUCKET,
    ),
    "BUCKET_INVALID",
  );
  need(
    /^[a-z]{2}-[a-z]+(?:-[a-z]+)?$/u.test(values.OPS_ARCHIVE_COS_REGION),
    "REGION_INVALID",
  );
  need(
    /^[A-Za-z0-9_-]+$/u.test(values.OPS_ARCHIVE_COS_SECRET_ID),
    "IDENTITY_INVALID",
  );
  return {
    bucket: values.OPS_ARCHIVE_COS_BUCKET,
    region: values.OPS_ARCHIVE_COS_REGION,
    secretId: values.OPS_ARCHIVE_COS_SECRET_ID,
    secretKey: values.OPS_ARCHIVE_COS_SECRET_KEY,
  };
}

class Budget {
  constructor(milliseconds = LIMITS.deadlineMs, byteLimit = LIMITS.runBytes) {
    need(
      milliseconds > 0 &&
        milliseconds <= LIMITS.deadlineMs &&
        Number.isSafeInteger(byteLimit) &&
        byteLimit > 0 &&
        byteLimit <= LIMITS.runBytes,
      "BUDGET_INVALID",
    );
    this.end = performance.now() + milliseconds;
    this.byteLimit = byteLimit;
    this.bytes = 0;
  }
  left() {
    const value = Math.floor(this.end - performance.now());
    need(value > 0, "DEADLINE_EXPIRED");
    return value;
  }
  charge(bytes) {
    this.left();
    need(
      Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= LIMITS.fileBytes,
      "FILE_TOO_LARGE",
    );
    need(this.bytes + bytes <= this.byteLimit, "INPUT_BUDGET_REACHED");
    this.bytes += bytes;
  }
}

const routes = new Set([
  "other",
  "page",
  "analytics-workspace",
  "admin",
  "analytics-collection",
  "notification-stream",
  "notifications",
  "authentication",
  "publishing",
  "community",
  "catalog",
  "search",
  "admin-api",
  "assets",
  "machine-api",
]);
const clients = new Set([
  "other",
  "empty",
  "test-like",
  "script-like",
  "crawler-like",
  "browser-like",
]);
const methods = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "OPTIONS",
  "TRACE",
  "CONNECT",
]);
function* lines(bytes, budget) {
  for (let start = 0; start < bytes.length;) {
    budget.left();
    const found = bytes.indexOf(10, start),
      end = found === -1 ? bytes.length : found;
    need(end - start <= 16384, "LOG_LINE_TOO_LARGE");
    const line = bytes.subarray(start, end).toString("utf8").trim();
    start = end + 1;
    if (line) yield line;
  }
}
function securityProjection(bytes, budget) {
  const output = [];
  let total = 0;
  for (const line of lines(bytes, budget)) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      throw new ArchiveError("SECURITY_FORMAT_INVALID");
    }
    need(
      row &&
        Number.isFinite(Date.parse(row.at)) &&
        Number.isInteger(row.status) &&
        row.status >= 100 &&
        row.status <= 599 &&
        Number.isFinite(row.duration) &&
        row.duration >= 0 &&
        Number.isSafeInteger(row.bytes) &&
        row.bytes >= 0 &&
        typeof row.method === "string" &&
        routes.has(row.route) &&
        clients.has(row.client) &&
        [0, 1].includes(row.device_excluded) &&
        typeof row.ip === "string" &&
        isIP(row.ip),
      "SECURITY_FORMAT_INVALID",
    );
    // Fixed operational fields only. Never copy extra headers, paths, queries,
    // cookies or arbitrary fields from a misconfigured source format.
    const projected = encoded({
      at: new Date(row.at).toISOString(),
      status: row.status,
      duration: row.duration,
      bytes: row.bytes,
      method: methods.has(row.method) ? row.method : "OTHER",
      route: row.route,
      client: row.client,
      device_excluded: row.device_excluded,
      ip: row.ip,
    });
    total += projected.length;
    need(total <= LIMITS.fileBytes, "FILE_TOO_LARGE");
    output.push(projected);
  }
  return Buffer.concat(output, total);
}

class State {
  constructor(path, target, floor) {
    this.path = path;
    this.target = target;
    this.floor = floor;
    this.entries = {};
    this.lock = join(path, "lock.json");
  }
  async initialize() {
    await ancestors(this.path, this.floor);
    await mkdir(this.path, { mode: 0o700 }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    const s = await lstat(this.path);
    need(
      s.isDirectory() &&
        !s.isSymbolicLink() &&
        s.uid === process.geteuid() &&
        (s.mode & 0o777) === 0o700,
      "STATE_DIRECTORY_METADATA",
    );
    need((await readdir(this.path)).length <= 16, "STATE_DIRECTORY_LIMIT");
    try {
      this.lease = await open(
        this.lock,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const before = await lstat(this.lock, { bigint: true });
      const old = JSON.parse(
        (await privateBytes(this.lock, 1024, this.floor)).toString("utf8"),
      );
      need(
        old.version === VERSION && Number.isSafeInteger(old.pid) && old.pid > 1,
        "ARCHIVE_LOCKED",
      );
      let absent = false;
      try {
        process.kill(old.pid, 0);
      } catch (probe) {
        absent = probe.code === "ESRCH";
      }
      need(
        absent &&
          same(
            identity(before),
            identity(await lstat(this.lock, { bigint: true })),
          ),
        "ARCHIVE_LOCKED",
      );
      await unlink(this.lock);
      this.lease = await open(
        this.lock,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
    }
    await this.lease.writeFile(encoded({ version: VERSION, pid: process.pid }));
    await this.lease.sync();
    const path = join(this.path, "state.json");
    try {
      const old = JSON.parse(
        (await privateBytes(path, LIMITS.stateBytes, this.floor)).toString(
          "utf8",
        ),
      );
      need(
        old.version === VERSION &&
          old.target === this.target &&
          old.entries &&
          !Array.isArray(old.entries) &&
          Object.keys(old.entries).length <= LIMITS.receipts,
        "STATE_BINDING_INVALID",
      );
      for (const [fingerprint, receipt] of Object.entries(old.entries))
        need(
          /^[a-f0-9]{64}$/u.test(fingerprint) &&
            receipt &&
            /^[a-f0-9]{64}$/u.test(receipt.archiveSha256) &&
            typeof receipt.key === "string" &&
            receipt.key.startsWith("ops/") &&
            Number.isSafeInteger(receipt.verifiedAt),
          "STATE_RECEIPT_INVALID",
        );
      this.entries = old.entries;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  async record(fingerprint, receipt) {
    this.entries[fingerprint] = receipt;
    const sorted = Object.entries(this.entries)
      .sort((a, b) => b[1].verifiedAt - a[1].verifiedAt)
      .slice(0, LIMITS.receipts);
    this.entries = Object.fromEntries(sorted);
    const bytes = encoded({
      version: VERSION,
      target: this.target,
      entries: this.entries,
    });
    need(bytes.length <= LIMITS.stateBytes, "STATE_SIZE_LIMIT");
    const temp = join(this.path, ".state-" + randomUUID() + ".tmp");
    try {
      const out = await open(
        temp,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await out.writeFile(bytes);
        await out.sync();
      } finally {
        await out.close();
      }
      await rename(temp, join(this.path, "state.json"));
      const directory = await open(
        this.path,
        constants.O_RDONLY | constants.O_DIRECTORY,
      );
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await unlink(temp).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
  async close() {
    if (this.lease) {
      const held = await this.lease.stat({ bigint: true }),
        named = await lstat(this.lock, { bigint: true });
      need(held.dev === named.dev && held.ino === named.ino, "LOCK_CHANGED");
      await this.lease.close();
      await unlink(this.lock);
      this.lease = undefined;
    }
  }
}

async function readSource(
  logical,
  context,
  maximum = LIMITS.fileBytes,
  snapshot = false,
  sidecar = false,
) {
  if (!sidecar) classifySource(logical, context.securitySnapshot);
  else
    need(
      dirname(logical) === BACKUPS && logical.endsWith(".pgdump.sha256"),
      "SOURCE_OUTSIDE_ALLOWLIST",
    );
  const path = context.map(logical);
  await ancestors(path, context.floor);
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await file.stat({ bigint: true });
    need(
      before.isFile() && before.nlink === 1n && (before.mode & 0o022n) === 0n,
      "SOURCE_METADATA_INVALID",
    );
    need(before.size <= BigInt(maximum), "FILE_TOO_LARGE");
    const size = Number(before.size);
    context.budget.charge(size);
    const body = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      context.budget.left();
      const r = await file.read(
        body,
        offset,
        Math.min(65536, size - offset),
        offset,
      );
      need(r.bytesRead > 0, "SOURCE_CHANGED");
      offset += r.bytesRead;
    }
    const after = await file.stat({ bigint: true }),
      named = await lstat(path, { bigint: true });
    need(
      before.dev === after.dev &&
        before.ino === after.ino &&
        before.ino === named.ino &&
        before.dev === named.dev &&
        (snapshot
          ? after.size >= before.size
          : same(identity(before), identity(after))),
      "SOURCE_CHANGED",
    );
    return { body, stat: before };
  } finally {
    await file.close();
  }
}

async function discover(context) {
  const found = [];
  for (const logical of [BACKUPS, SECURITY, TRAFFIC]) {
    const path = context.map(logical);
    await ancestors(path, context.floor);
    let names;
    try {
      const s = await lstat(path);
      need(
        s.isDirectory() && !s.isSymbolicLink() && (s.mode & 0o022) === 0,
        "SOURCE_DIRECTORY_INVALID",
      );
      names = await readdir(path);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    need(names.length <= 2048, "SOURCE_DIRECTORY_LIMIT");
    for (const name of names.sort()) {
      const candidate = join(logical, name);
      try {
        const policy = classifySource(candidate, context.securitySnapshot);
        found.push({ logical: candidate, ...policy });
      } catch (error) {
        if (category(error) !== "SOURCE_OUTSIDE_ALLOWLIST") throw error;
      }
    }
  }
  // A bounded run must protect the newest recovery point before historical
  // backlog or logs. lstat is only a priority hint; readSource rechecks identity.
  const backups = [];
  for (const candidate of found.filter((item) => item.kind === "backup")) {
    context.budget.left();
    const s = await lstat(context.map(candidate.logical), { bigint: true });
    backups.push({ candidate, modified: s.mtimeNs });
  }
  backups.sort((a, b) =>
    a.modified === b.modified
      ? b.candidate.logical.localeCompare(a.candidate.logical)
      : a.modified > b.modified
        ? -1
        : 1,
  );
  return [
    ...backups.map((item) => item.candidate),
    ...found.filter((item) => item.kind !== "backup"),
  ];
}

async function remote(config, sender, context, method, key, body) {
  context.budget.left();
  const host = `${config.bucket}.cos.${config.region}.myqcloud.com`,
    pathname = "/" + key;
  const headers = { host };
  if (method === "PUT")
    Object.assign(headers, {
      "content-type": "application/octet-stream",
      "content-length": String(body.length),
      "content-md5": createHash("md5").update(body).digest("base64"),
      "cache-control": "private, no-store",
      "x-cos-acl": "private",
      "x-cos-server-side-encryption": "AES256",
      "x-cos-forbid-overwrite": "true",
      "x-cos-meta-archive-sha256": sha(body),
    });
  const now = Math.floor(Date.now() / 1000);
  headers.authorization = context.signer({
    method,
    pathname,
    headers,
    query: {},
    secretId: config.secretId,
    secretKey: config.secretKey,
    startsAt: now - 5,
    expiresAt: now + 60,
  });
  try {
    return await sender({
      url: new URL("https://" + host + pathname),
      method,
      headers,
      ...(body ? { body } : {}),
      timeoutMs: Math.min(LIMITS.requestMs, context.budget.left()),
      maxResponseBytes: method === "GET" ? LIMITS.fileBytes : 65536,
    });
  } catch {
    throw new ArchiveError("COS_REQUEST_FAILED");
  }
}

async function verifyArchive(config, sender, context, key, payload) {
  let head = await remote(config, sender, context, "HEAD", key);
  if (head.statusCode === 404) {
    const put = await remote(config, sender, context, "PUT", key, payload);
    // A conflict may be another run's identical content-addressed upload.
    // Verify it; never issue a second PUT after an uncertain outcome.
    need(
      [200, 201, 204, 409, 412].includes(put.statusCode),
      "COS_PUT_REJECTED",
    );
    head = await remote(config, sender, context, "HEAD", key);
  }
  const expectedSha256 = sha(payload);
  const metadataMatches = [
    "x-cos-meta-archive-sha256",
    "x-cos-meta-sha256",
  ].some((name) => head.headers[name] === expectedSha256);
  need(
    head.statusCode === 200 &&
      head.headers["content-length"] === String(payload.length) &&
      head.headers["x-cos-server-side-encryption"] === "AES256" &&
      metadataMatches,
    "COS_HEAD_VERIFICATION_FAILED",
  );
  const readback = await remote(config, sender, context, "GET", key);
  need(
    readback.statusCode === 200 &&
      readback.body.length === payload.length &&
      sha(readback.body) === sha(payload),
    "COS_READBACK_HASH_MISMATCH",
  );
}

async function payloadFor(candidate, source, context) {
  let plain = source.body;
  if (candidate.logical.endsWith(".gz")) {
    try {
      plain = await unzip(plain, { maxOutputLength: LIMITS.fileBytes });
    } catch {
      throw new ArchiveError("COMPRESSED_INPUT_INVALID_OR_TOO_LARGE");
    }
    context.budget.charge(plain.length);
  }
  const date = utcDate(Number(source.stat.mtimeMs));
  if (candidate.kind === "backup") {
    need(
      plain.subarray(0, 5).equals(Buffer.from("PGDMP")),
      "BACKUP_FORMAT_INVALID",
    );
    const checksum = await readSource(
      candidate.logical + ".sha256",
      context,
      4096,
      false,
      true,
    );
    const expected = sha(plain) + "  " + basename(candidate.logical);
    need(
      checksum.body.toString("utf8").trim() === expected,
      "BACKUP_SOURCE_CHECKSUM_MISMATCH",
    );
    const daily =
      /^artvenn-db-daily-(\d{4})(\d{2})(\d{2})T\d{6}Z-yoyi_payload\.pgdump$/u.exec(
        basename(candidate.logical),
      );
    const prefix = daily
      ? `ops/backups/daily/${daily[1]}-${daily[2]}-${daily[3]}/`
      : "ops/backups/milestones/";
    return {
      key: prefix + sha(plain) + ".pgdump",
      payload: plain,
      sourceSha256: sha(source.body),
    };
  }
  let data;
  if (candidate.kind === "security")
    data = securityProjection(plain, context.budget);
  else
    data = encoded({
      format: "artvenn-traffic-summary-v1",
      scope: "one log snapshot; windows can overlap and must not be summed",
      summary: await summarizeTraffic(lines(plain, context.budget)),
    });
  context.budget.left();
  const payload = await zip(data, { level: 6 });
  need(payload.length <= LIMITS.fileBytes, "FILE_TOO_LARGE");
  return {
    key:
      (candidate.kind === "security"
        ? `ops/logs/security/${date}/`
        : `ops/metrics/traffic/${date}/`) +
      sha(payload) +
      (candidate.kind === "security" ? ".jsonl.gz" : ".json.gz"),
    payload,
    sourceSha256: sha(source.body),
  };
}

/** Fixture-only transport/root/budget seams are never exposed by the CLI. */
export async function runArchive(options, dependencies = {}) {
  const floor = dependencies.fixtureRoot
    ? resolve(dependencies.fixtureRoot)
    : "/";
  need(!dependencies.fixtureRoot || floor !== "/", "FIXTURE_ROOT_INVALID");
  if (dependencies.fixtureRoot) {
    need(
      typeof dependencies.transport === "function",
      "FIXTURE_TRANSPORT_REQUIRED",
    );
    need(typeof dependencies.signer === "function", "FIXTURE_SIGNER_REQUIRED");
  }
  if (!dependencies.fixtureRoot)
    need(
      process.platform === "linux" && process.geteuid() === 0,
      "LINUX_ROOT_REQUIRED",
    );
  const bindings = dependencies.fixtureRoot
    ? dependencies
    : await productionBindings();
  const context = {
    signer: bindings.signer,
    floor,
    map: (logical) =>
      dependencies.fixtureRoot ? join(floor, logical.slice(1)) : logical,
    securitySnapshot: options.securitySnapshot === true,
    budget: new Budget(dependencies.budgetMs, dependencies.inputLimit),
  };
  const config = await readConfiguration(options.configPath, floor);
  const target = sha(
    encoded({ bucket: config.bucket, region: config.region, version: VERSION }),
  );
  const state = new State(context.map(STATE), target, floor);
  const result = {
    status: "ARCHIVE_COMPLETE",
    candidates: 0,
    verified: 0,
    skipped: 0,
    failed: 0,
    sourceDeleted: 0,
    inputBytes: 0,
    categories: {},
  };
  try {
    await state.initialize();
    let candidates;
    try {
      candidates = await discover(context);
    } catch (error) {
      result.status = "ARCHIVE_PARTIAL";
      result.failed = 1;
      result.categories[category(error)] = 1;
      return result;
    }
    result.candidates = candidates.length;
    for (const candidate of candidates) {
      try {
        context.budget.left();
        const path = context.map(candidate.logical);
        await ancestors(path, floor);
        const stat = await lstat(path, { bigint: true });
        need(
          stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n,
          "SOURCE_METADATA_INVALID",
        );
        const fingerprint = sha(
          encoded({
            version: VERSION,
            logical: candidate.logical,
            identity: identity(stat),
          }),
        );
        if (state.entries[fingerprint]) {
          result.skipped++;
          continue;
        }
        const source = await readSource(
          candidate.logical,
          context,
          LIMITS.fileBytes,
          candidate.snapshot,
        );
        need(same(identity(stat), identity(source.stat)), "SOURCE_CHANGED");
        const payload = await payloadFor(candidate, source, context);
        await verifyArchive(
          config,
          bindings.transport,
          context,
          payload.key,
          payload.payload,
        );
        context.budget.left();
        await state.record(fingerprint, {
          key: payload.key,
          archiveSha256: sha(payload.payload),
          sourceSha256: payload.sourceSha256,
          sourceName: basename(candidate.logical),
          bytes: payload.payload.length,
          snapshot: candidate.snapshot,
          verifiedAt: Date.now(),
        });
        result.verified++;
      } catch (error) {
        result.failed++;
        const code = category(error);
        result.categories[code] = (result.categories[code] ?? 0) + 1;
        if (["DEADLINE_EXPIRED", "INPUT_BUDGET_REACHED"].includes(code)) break;
      }
    }
    result.inputBytes = context.budget.bytes;
    if (result.failed) result.status = "ARCHIVE_PARTIAL";
    return result;
  } finally {
    await state.close();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const hard = setTimeout(() => {
    console.error(
      JSON.stringify({
        status: "FAILED",
        category: "HARD_DEADLINE",
        sourceDeleted: 0,
      }),
    );
    process.exit(1);
  }, LIMITS.deadlineMs);
  try {
    const { values } = parseArgs({
      options: {
        config: { type: "string" },
        "security-snapshot": { type: "boolean", default: false },
      },
      allowPositionals: false,
    });
    need(typeof values.config === "string", "EXPLICIT_PRIVATE_CONFIG_REQUIRED");
    const result = await runArchive({
      configPath: values.config,
      securitySnapshot: values["security-snapshot"],
    });
    console.log(JSON.stringify(result));
    process.exitCode = result.failed ? 1 : 0;
  } catch (error) {
    console.error(
      JSON.stringify({
        status: "FAILED",
        category: category(error),
        sourceDeleted: 0,
      }),
    );
    process.exitCode = 1;
  } finally {
    clearTimeout(hard);
  }
}
