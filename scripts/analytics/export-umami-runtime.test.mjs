import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { test } from "node:test";

import {
  UMAMI_WORKSPACE_IDENTITY,
  UMAMI_VISITOR_DEVICE_SHA256,
  UMAMI_GEOGRAPHY_POLICY,
  UMAMI_CHINA_MAP_SHA256,
  UMAMI_PG_TLS_HOST_SHA256,
  UMAMI_PROVINCE_FALLBACK_SHA256,
  UMAMI_POSTGRES_TIMEZONE,
} from "./common.mjs";

const imageId = `sha256:${"a".repeat(64)}`;
const labels = {
  "org.opencontainers.image.version": "3.4.0",
  "org.opencontainers.image.revision":
    "ec0ff50388c264ed8ce46f00967e92f7e71476ae",
  "com.artvenn.umami.base-path": "/admin/analytics-workspace",
  "com.artvenn.umami.libc": "glibc",
  "com.artvenn.umami.node-major": "24",
  "com.artvenn.umami.pool-max": "3",
  "com.artvenn.umami.locale": "zh-CN",
  "com.artvenn.umami.patch-sha256": UMAMI_WORKSPACE_IDENTITY,
  "com.artvenn.umami.visitor-device-sha256": UMAMI_VISITOR_DEVICE_SHA256,
  "com.artvenn.umami.pg-tls-host-sha256": UMAMI_PG_TLS_HOST_SHA256,
  "com.artvenn.umami.province-fallback-sha256": UMAMI_PROVINCE_FALLBACK_SHA256,
  "com.artvenn.umami.database-timezone": UMAMI_POSTGRES_TIMEZONE,
  "com.artvenn.umami.geography": UMAMI_GEOGRAPHY_POLICY,
  "com.artvenn.umami.china-map-sha256": UMAMI_CHINA_MAP_SHA256,
  "com.artvenn.umami.geo-sha256":
    "fd112e5b13ca19e8bb0bf2e1902fb0694f6ba1940bef916e0d8d9d9346f4e029",
};

test("runtime exporter streams/hash-checks a synthetic tar, writes private metadata and removes only its stopped container", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "umami-runtime-export-test-"),
  );
  try {
    await writeFile(
      path.join(directory, "server.js"),
      "// synthetic fixture only\n",
    );
    const tar = execFileSync("tar", ["-cf", "-", "-C", directory, "server.js"]);
    const log = path.join(directory, "docker-calls.jsonl");
    const fakeDocker = path.join(directory, "docker");
    const metadata = {
      id: imageId,
      architecture: "amd64",
      os: "linux",
      labels,
    };
    await writeFile(
      fakeDocker,
      `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nconst args=process.argv.slice(2);\nappendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');\nif(args[0]!=='--context'||args[1]!=='synthetic-task-build')process.exit(11);\nconst command=args[2];\nif(command==='image')console.log(${JSON.stringify(JSON.stringify(metadata))});\nelse if(command==='create')console.log(process.env.SYNTHETIC_CREATE_BAD?'synthetic-bad-response':'${"b".repeat(64)}');\nelse if(command==='cp'){if(process.env.SYNTHETIC_COPY_FAIL)process.exit(12);process.stdout.write(Buffer.from('${tar.toString("base64")}','base64'));}\nelse if(command==='rm'&&process.env.SYNTHETIC_REMOVE_FAIL){console.error('synthetic-daemon-unavailable');process.exit(14);}
else if(command!=='rm')process.exit(13);\n`,
      { mode: 0o700 },
    );
    await chmod(fakeDocker, 0o700);
    const cli = fileURLToPath(
      new URL("./export-umami-runtime.mjs", import.meta.url),
    );
    const output = path.join(directory, "runtime.tar.gz");
    const args = [
      cli,
      "--image",
      imageId,
      "--platform",
      "linux/amd64",
      "--docker-context",
      "synthetic-task-build",
      "--output",
      output,
      "--execute",
    ];
    const result = spawnSync(process.execPath, args, {
      env: {
        ...process.env,
        PATH: `${directory}${path.delimiter}${process.env.PATH}`,
      },
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    const status = JSON.parse(result.stdout);
    assert.equal(status.status, "RUNTIME_EXPORTED");
    const archive = await readFile(output);
    const manifest = JSON.parse(await readFile(`${output}.json`, "utf8"));
    assert.equal(
      createHash("sha256").update(archive).digest("hex"),
      manifest.archiveSha256,
    );
    assert.equal(manifest.workspaceIdentitySha256, UMAMI_WORKSPACE_IDENTITY);
    assert.equal(manifest.chinaMapSha256, UMAMI_CHINA_MAP_SHA256);
    assert.equal(manifest.geographyPolicy, UMAMI_GEOGRAPHY_POLICY);
    assert.equal(manifest.postgresTlsHostSha256, UMAMI_PG_TLS_HOST_SHA256);
    assert.equal(manifest.locale, "zh-CN");
    assert.equal(manifest.postgresTimeZone, UMAMI_POSTGRES_TIMEZONE);
    assert.equal(
      manifest.provinceFallbackSha256,
      UMAMI_PROVINCE_FALLBACK_SHA256,
      UMAMI_POSTGRES_TIMEZONE,
    );
    assert.ok(
      gunzipSync(archive).includes(Buffer.from("synthetic fixture only")),
    );
    assert.equal((await stat(output)).mode & 0o077, 0);
    assert.equal((await stat(`${output}.json`)).mode & 0o077, 0);
    let calls = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.ok(
      calls.every(
        (call) => call[0] === "--context" && call[1] === "synthetic-task-build",
      ),
    );
    assert.equal(calls.at(-1)[2], "rm");
    assert.ok(
      !calls.some((call) => call.includes("start") || call.includes("run")),
    );
    const failedOutput = path.join(directory, "failed.tar.gz");
    const failure = spawnSync(
      process.execPath,
      args.map((value) => (value === output ? failedOutput : value)),
      {
        env: {
          ...process.env,
          PATH: `${directory}${path.delimiter}${process.env.PATH}`,
          SYNTHETIC_COPY_FAIL: "1",
        },
        encoding: "utf8",
        timeout: 10000,
      },
    );
    assert.equal(failure.status, 1);
    await assert.rejects(stat(failedOutput), { code: "ENOENT" });
    calls = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(calls.at(-1)[2], "rm");
    for (const [flag, expected] of [
      ["SYNTHETIC_CREATE_BAD", "RUNTIME_CONTAINER_ID_INVALID"],
      ["SYNTHETIC_REMOVE_FAIL", "RUNTIME_EXPORT_CLEANUP_INCOMPLETE"],
    ]) {
      const otherOutput = path.join(directory, `${flag}.tar.gz`);
      const other = spawnSync(
        process.execPath,
        args.map((value) => (value === output ? otherOutput : value)),
        {
          env: {
            ...process.env,
            PATH: `${directory}${path.delimiter}${process.env.PATH}`,
            [flag]: "1",
          },
          encoding: "utf8",
          timeout: 10000,
        },
      );
      assert.equal(other.status, 1);
      assert.equal(JSON.parse(other.stderr).code, expected);
      if (flag === "SYNTHETIC_REMOVE_FAIL")
        assert.match(
          JSON.parse(other.stderr).containerName,
          /^artvenn-umami-export-/u,
        );
      calls = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
      assert.equal(calls.at(-1)[2], "rm");
      assert.match(calls.at(-1)[3], /^artvenn-umami-export-/u);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
