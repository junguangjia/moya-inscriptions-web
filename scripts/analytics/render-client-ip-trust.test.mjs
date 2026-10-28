import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  MAX_SOURCE_AGE_MS,
  renderClientIpTrust,
  renderClientIpTrustFile,
} from "./render-client-ip-trust.mjs";

const now = Date.parse("2026-10-28T12:00:00Z");
const binding = {
  host: "catalog.example.invalid",
  zoneId: "zone-synthetic",
  now,
};
const source = () => ({
  schemaVersion: 1,
  provider: "tencent-edgeone",
  zoneId: binding.zoneId,
  host: binding.host,
  capturedAt: "2026-10-28T12:00:00Z",
  originAclInfo: {
    Status: "online",
    L7Hosts: [binding.host],
    CurrentOriginACL: {
      Version: "mlc-synthetic-current-v1",
      EntireAddresses: {
        IPv4: ["198.51.100.0/24", "192.0.2.0/24", "192.0.2.0/24"],
        IPv6: ["2001:db8:1::/48", "2001:0DB8:0001:0:0:0:0:0/48"],
      },
    },
    NextOriginACL: {
      Version: "mlc-synthetic-next-v2",
      EntireAddresses: { IPv4: ["203.0.113.0/24"], IPv6: [] },
    },
  },
});

test("renders only exact current peers, deduplicated deterministically with counts and hash", () => {
  const { content, summary } = renderClientIpTrust(source(), binding);
  assert.equal(
    content,
    "# Generated analytics-only EdgeOne current-origin peers.\n" +
      "192.0.2.0/24 1;\n198.51.100.0/24 1;\n2001:db8:1:0:0:0:0:0/48 1;\n",
  );
  assert.deepEqual(summary, {
    ipv4Count: 2,
    ipv6Count: 1,
    sha256: createHash("sha256").update(content).digest("hex"),
  });
  assert.ok(!content.includes("203.0.113"));
  assert.ok(!content.includes("default"));
  const reversed = source();
  reversed.originAclInfo.CurrentOriginACL.EntireAddresses.IPv4.reverse();
  assert.deepEqual(renderClientIpTrust(reversed, binding), {
    content,
    summary,
  });
});

test("requires the expected exact host and zone plus an online current ACL", () => {
  const changes = [
    (value) => (value.schemaVersion = 2),
    (value) => (value.provider = "other-provider"),
    (value) => (value.zoneId = "zone-other"),
    (value) => (value.host = "other.example.invalid"),
    (value) => (value.originAclInfo.Status = "offline"),
    (value) => (value.originAclInfo.Status = "updating"),
    (value) => (value.originAclInfo.L7Hosts = ["other.example.invalid"]),
    (value) => (value.originAclInfo.L7Hosts = ["*.example.invalid"]),
    (value) => (value.originAclInfo.CurrentOriginACL = null),
    (value) => (value.originAclInfo.CurrentOriginACL.Version = ""),
    (value) =>
      (value.originAclInfo.CurrentOriginACL.Version =
        "current\ninclude other;"),
    (value) => (value.originAclInfo.CurrentOriginACL.EntireAddresses.IPv4 = []),
  ];
  for (const change of changes) {
    const value = source();
    if (change === changes.at(-1))
      value.originAclInfo.CurrentOriginACL.EntireAddresses.IPv6 = [];
    change(value);
    assert.throws(() => renderClientIpTrust(value, binding));
  }
  for (const host of [
    "*.example.invalid",
    "catalog.example.invalid\n",
    "https://catalog.example.invalid",
    "Catalog.example.invalid",
  ])
    assert.throws(() => renderClientIpTrust(source(), { ...binding, host }));
  assert.throws(() =>
    renderClientIpTrust(source(), { ...binding, zoneId: "zone-synthetic\n" }),
  );
});

test("requires a real UTC capture no older than 72 hours and never from the future", () => {
  for (const capturedAt of [
    new Date(now - MAX_SOURCE_AGE_MS - 1).toISOString(),
    new Date(now + 1).toISOString(),
    "2026-02-30T12:00:00Z",
    "2026-10-28",
    "2026-10-28T12:00:00+00:00",
    "2026-10-28T12:00:00Z\n",
    null,
  ])
    assert.throws(
      () => renderClientIpTrust({ ...source(), capturedAt }, binding),
      /STALE_OR_INVALID_CAPTURE/u,
    );
  assert.doesNotThrow(() =>
    renderClientIpTrust(
      {
        ...source(),
        capturedAt: new Date(now - MAX_SOURCE_AGE_MS).toISOString(),
      },
      binding,
    ),
  );
});

test("fails closed on non-CIDRs, wrong families, host bits, defaults and directive injection", () => {
  const invalid = {
    IPv4: [
      "0.0.0.0/0",
      "192.0.2.0",
      "192.0.2.1/24",
      "192.0.2.0/33",
      "192.0.2.0/024",
      "192.0.2.0/-1",
      "192.0.2.0/+24",
      "0192.0.2.0/24",
      "3221225984/32",
      "192.0.2/24",
      "192.0.2.0/24\n0.0.0.0/0 1;",
      "192.0.2.0/24;",
      " 192.0.2.0/24",
      "192.0.2.0/24 ",
      "2001:db8::/32",
      "default 1;",
      123,
      null,
    ],
    IPv6: [
      "::/0",
      "2001:db8::",
      "2001:db8::1/32",
      "2001:db8::/129",
      "2001:db8::/032",
      "2001:db8::/32\ninclude other;",
      "[2001:db8::]/32",
      "2001:db8::%eth0/32",
      "2001:db8:::0/32",
      "192.0.2.0/24",
      "",
      false,
    ],
  };
  for (const [family, candidates] of Object.entries(invalid))
    for (const candidate of candidates) {
      const value = source();
      value.originAclInfo.CurrentOriginACL.EntireAddresses[family] = [
        candidate,
      ];
      assert.throws(() => renderClientIpTrust(value, binding));
    }
});

test("supports single-address IPv4/IPv6 and one nonempty address family", () => {
  const value = source();
  value.originAclInfo.CurrentOriginACL.EntireAddresses = {
    IPv4: ["192.0.2.7/32"],
    IPv6: ["2001:db8::7/128", "::ffff:192.0.2.0/120"],
  };
  assert.match(
    renderClientIpTrust(value, binding).content,
    /192\.0\.2\.7\/32 1;/u,
  );
  assert.match(
    renderClientIpTrust(value, binding).content,
    /0:0:0:0:0:ffff:c000:200\/120 1;/u,
  );
  value.originAclInfo.CurrentOriginACL.EntireAddresses.IPv4 = [];
  assert.equal(renderClientIpTrust(value, binding).summary.ipv4Count, 0);
});

test("CLI writes a unique private include and prints only counts plus its hash", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "analytics-ip-trust-"),
  );
  try {
    const input = path.join(directory, "source.json");
    const output = path.join(directory, "current.conf");
    const value = source();
    value.capturedAt = new Date().toISOString();
    await writeFile(input, JSON.stringify(value), { mode: 0o600 });
    const script = fileURLToPath(
      new URL("./render-client-ip-trust.mjs", import.meta.url),
    );
    const args = [
      script,
      "--input",
      input,
      "--output",
      output,
      "--host",
      binding.host,
      "--zone",
      binding.zoneId,
    ];
    const result = spawnSync(process.execPath, args, {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const summary = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(summary), [
      "ipv4Count",
      "ipv6Count",
      "sha256",
    ]);
    const content = await readFile(output, "utf8");
    assert.equal(
      summary.sha256,
      createHash("sha256").update(content).digest("hex"),
    );
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    await assert.rejects(
      renderClientIpTrustFile({
        input,
        output,
        host: binding.host,
        zone: binding.zoneId,
      }),
      { code: "EEXIST" },
    );
    assert.equal(await readFile(output, "utf8"), content);
    await writeFile(input, '{"synthetic-private-marker":');
    const failed = spawnSync(process.execPath, args, {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(failed.status, 1);
    assert.equal(failed.stdout, "");
    assert.equal(failed.stderr, "INVALID_JSON\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses oversized input and never creates output for an invalid source", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "analytics-ip-trust-invalid-"),
  );
  try {
    const input = path.join(directory, "source.json");
    const output = path.join(directory, "current.conf");
    await writeFile(input, " ".repeat(2 * 1024 * 1024 + 1));
    await assert.rejects(
      renderClientIpTrustFile({
        input,
        output,
        host: binding.host,
        zone: binding.zoneId,
      }),
      /INVALID_INPUT_SIZE/u,
    );
    await assert.rejects(stat(output), { code: "ENOENT" });
    await assert.rejects(
      renderClientIpTrustFile({
        input,
        output: input,
        host: binding.host,
        zone: binding.zoneId,
      }),
      /INVALID_FILE_ARGUMENTS/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
