import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createGunzip } from "node:zlib";

/** Aggregate only: raw IPs, paths, UA strings and log lines never enter output. */
export async function summarizeTraffic(lines) {
  const summary = {
    requests: 0,
    legacyUnattributedRequests: 0,
    classifiedRequests: 0,
    invalidLines: 0,
    knownResponseBytes: 0,
    requestsWithKnownBytes: 0,
    deviceMarkedExcluded: 0,
    firstAt: null,
    lastAt: null,
    statuses: {},
    routeFamilies: {},
    clientHeuristics: {},
    hours: {},
    qualifications: [
      "HTTP requests include APIs, media, assets, probes and keepalives; they are not page views or people.",
      "Legacy time/status/duration logs cannot establish IP, route, client or Owner attribution.",
      "Client classes are UA heuristics and cannot identify Codex, Claude Code or a human operator.",
      "The device exclusion marker is an opt-out signal, not an authenticated user identity.",
    ],
  };
  const increment = (record, key) => {
    record[key] = (record[key] ?? 0) + 1;
  };
  const routeNames = new Set([
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
  const clientNames = new Set([
    "other",
    "empty",
    "test-like",
    "script-like",
    "crawler-like",
    "browser-like",
  ]);
  for await (const line of lines) {
    if (!line.trim()) continue;
    let item;
    let legacy = false;
    try {
      if (line.length > 16_384) throw new Error("LINE_TOO_LONG");
      if (line.startsWith("{")) item = JSON.parse(line);
      else {
        const match = /^(\S+)\s+(\d{3})\s+([0-9.]+)$/u.exec(line.trim());
        if (!match) throw new Error("INVALID_LEGACY_LINE");
        item = { at: match[1], status: Number(match[2]) };
        legacy = true;
      }
      if (
        !item ||
        typeof item !== "object" ||
        !Number.isInteger(item.status) ||
        item.status < 100 ||
        item.status > 599 ||
        !Number.isFinite(Date.parse(item.at))
      )
        throw new Error("INVALID_LINE");
      if (
        !legacy &&
        (!routeNames.has(item.route) || !clientNames.has(item.client))
      )
        throw new Error("UNKNOWN_CLASSIFICATION");
    } catch {
      summary.invalidLines += 1;
      continue;
    }
    summary.requests += 1;
    const at = new Date(item.at).toISOString();
    if (!summary.firstAt || at < summary.firstAt) summary.firstAt = at;
    if (!summary.lastAt || at > summary.lastAt) summary.lastAt = at;
    increment(summary.statuses, String(item.status));
    increment(summary.hours, at.slice(0, 13));
    if (legacy) {
      summary.legacyUnattributedRequests += 1;
      continue;
    }
    summary.classifiedRequests += 1;
    increment(summary.routeFamilies, item.route);
    increment(summary.clientHeuristics, item.client);
    if (item.device_excluded === 1) summary.deviceMarkedExcluded += 1;
    if (Number.isSafeInteger(item.bytes) && item.bytes >= 0) {
      summary.knownResponseBytes += item.bytes;
      summary.requestsWithKnownBytes += 1;
    }
  }
  return summary;
}

async function* fileLines(paths) {
  for (const path of paths) {
    const raw = createReadStream(path);
    const stream = path.endsWith(".gz") ? raw.pipe(createGunzip()) : raw;
    const reader = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of reader) yield line;
    } finally {
      reader.close();
      stream.destroy();
      raw.destroy();
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const paths = process.argv.slice(2);
    if (paths.length < 1 || paths.length > 32)
      throw new Error("EXPLICIT_LOG_FILES_REQUIRED");
    console.log(
      JSON.stringify(await summarizeTraffic(fileLines(paths)), null, 2),
    );
  } catch {
    console.error(
      "TRAFFIC_SUMMARY_FAILED: explicit readable application log files required",
    );
    process.exitCode = 1;
  }
}
