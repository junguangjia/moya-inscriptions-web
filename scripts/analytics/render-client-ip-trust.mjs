import { createHash } from "node:crypto";
import { open, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const MAX_SOURCE_AGE_MS = 72 * 60 * 60 * 1000;
const MAX_INPUT_BYTES = 2 * 1024 * 1024;

function reject(code) {
  throw new Error(code);
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hostName(value) {
  return (
    typeof value === "string" &&
    value.length <= 253 &&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(
      value,
    )
  );
}

function addressNumber(address, family) {
  if (family === 4)
    return address
      .split(".")
      .reduce((value, octet) => (value << 8n) | BigInt(octet), 0n);
  let expanded = address;
  if (expanded.includes(".")) {
    const start = expanded.lastIndexOf(":") + 1;
    const ipv4 = addressNumber(expanded.slice(start), 4);
    expanded = `${expanded.slice(0, start)}${(ipv4 >> 16n).toString(16)}:${(ipv4 & 65535n).toString(16)}`;
  }
  const [left, right] = expanded.split("::");
  const first = left ? left.split(":") : [];
  const last = right ? right.split(":") : [];
  const groups = expanded.includes("::")
    ? [...first, ...Array(8 - first.length - last.length).fill("0"), ...last]
    : first;
  return groups.reduce(
    (value, group) => (value << 16n) | BigInt(`0x${group}`),
    0n,
  );
}

function network(value, family) {
  if (typeof value !== "string") reject("INVALID_CIDR");
  const match = /^([0-9a-fA-F:.]+)\/([1-9][0-9]*)$/u.exec(value);
  if (!match || isIP(match[1]) !== family) reject("INVALID_CIDR");
  const bits = family === 4 ? 32 : 128;
  const prefix = Number(match[2]);
  if (!Number.isSafeInteger(prefix) || prefix > bits) reject("INVALID_CIDR");
  const numeric = addressNumber(match[1], family);
  const hostMask = (1n << BigInt(bits - prefix)) - 1n;
  if ((numeric & hostMask) !== 0n) reject("CIDR_HOST_BITS");
  const address =
    family === 4
      ? match[1]
      : numeric
          .toString(16)
          .padStart(32, "0")
          .match(/.{4}/gu)
          .map((group) => Number.parseInt(group, 16).toString(16))
          .join(":");
  return `${address}/${prefix}`;
}

export function renderClientIpTrust(
  source,
  { host, zoneId, now = Date.now() },
) {
  if (
    !hostName(host) ||
    typeof zoneId !== "string" ||
    !/^zone-[a-z0-9-]{1,100}$/u.test(zoneId)
  )
    reject("INVALID_BINDING");
  if (
    !record(source) ||
    source.schemaVersion !== 1 ||
    source.provider !== "tencent-edgeone" ||
    source.host !== host ||
    source.zoneId !== zoneId
  )
    reject("SOURCE_BINDING_MISMATCH");
  const capturedAt = source.capturedAt;
  const captured =
    typeof capturedAt === "string" ? Date.parse(capturedAt) : NaN;
  if (
    !Number.isSafeInteger(now) ||
    !Number.isFinite(captured) ||
    ![
      new Date(captured).toISOString(),
      new Date(captured).toISOString().replace(".000Z", "Z"),
    ].includes(capturedAt) ||
    captured > now ||
    now - captured > MAX_SOURCE_AGE_MS
  )
    reject("STALE_OR_INVALID_CAPTURE");
  const info = source.originAclInfo;
  if (
    !record(info) ||
    info.Status !== "online" ||
    !Array.isArray(info.L7Hosts) ||
    !info.L7Hosts.includes(host)
  )
    reject("ORIGIN_ACL_NOT_BOUND_ONLINE");
  const current = info.CurrentOriginACL;
  if (
    !record(current) ||
    typeof current.Version !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(current.Version) ||
    !record(current.EntireAddresses)
  )
    reject("INVALID_CURRENT_ACL");
  const addresses = current.EntireAddresses;
  if (
    !Array.isArray(addresses.IPv4) ||
    !Array.isArray(addresses.IPv6) ||
    addresses.IPv4.length + addresses.IPv6.length === 0 ||
    addresses.IPv4.length + addresses.IPv6.length > 10_000
  )
    reject("EMPTY_OR_INVALID_CURRENT_ADDRESSES");
  const ipv4 = [
    ...new Set(addresses.IPv4.map((value) => network(value, 4))),
  ].sort();
  const ipv6 = [
    ...new Set(addresses.IPv6.map((value) => network(value, 6))),
  ].sort();
  // NextOriginACL is deliberately never trusted until a fresh capture calls it current.
  const content =
    "# Generated analytics-only EdgeOne current-origin peers.\n" +
    [...ipv4, ...ipv6].map((cidr) => `${cidr} 1;\n`).join("");
  return {
    content,
    summary: {
      ipv4Count: ipv4.length,
      ipv6Count: ipv6.length,
      sha256: createHash("sha256").update(content).digest("hex"),
    },
  };
}

export async function renderClientIpTrustFile({ input, output, host, zone }) {
  if (!input || !output || path.resolve(input) === path.resolve(output))
    reject("INVALID_FILE_ARGUMENTS");
  const handle = await open(input, "r");
  let source;
  try {
    const size = (await handle.stat()).size;
    if (size === 0 || size > MAX_INPUT_BYTES) reject("INVALID_INPUT_SIZE");
    const bytes = await handle.readFile("utf8");
    if (Buffer.byteLength(bytes) > MAX_INPUT_BYTES)
      reject("INVALID_INPUT_SIZE");
    try {
      source = JSON.parse(bytes);
    } catch {
      reject("INVALID_JSON");
    }
  } finally {
    await handle.close();
  }
  const { content, summary } = renderClientIpTrust(source, {
    host,
    zoneId: zone,
  });
  await writeFile(output, content, { flag: "wx", mode: 0o600 });
  return summary;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const { values } = parseArgs({
      options: {
        input: { type: "string" },
        output: { type: "string" },
        host: { type: "string" },
        zone: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    });
    const summary = await renderClientIpTrustFile(values);
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } catch (error) {
    // Do not echo private source values, paths or JSON parser excerpts.
    const code =
      error instanceof Error && /^[A-Z][A-Z_]+$/u.test(error.message)
        ? error.message
        : "INPUT_OR_OUTPUT_ERROR";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
