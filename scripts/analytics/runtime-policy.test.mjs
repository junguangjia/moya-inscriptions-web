import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { test } from "node:test";
import { runtimePolicy, COMPATIBILITY_POLICY } from "./runtime-policy.mjs";
import { buildImagePlan } from "./build-umami-image.mjs";
import {
  runtimeExportPlan,
  verifyRuntimeImage,
} from "./export-umami-runtime.mjs";
import {
  UMAMI_PG_TLS_HOST_SHA256,
  UMAMI_VISITOR_DEVICE_SHA256,
  UMAMI_GEOGRAPHY_POLICY,
  UMAMI_CHINA_MAP_SHA256,
} from "./common.mjs";
import {
  parseProtectedInventory,
  presentationPaths,
  verifyProtectedSource,
} from "../../infra/production/umami/ui-pre365-v1-verify.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const directory = new URL("../../infra/production/umami/", import.meta.url);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const metadata = JSON.parse(
  await readFile(new URL("ui-pre365-v1-source.json", directory), "utf8"),
);
const image = `sha256:${"a".repeat(64)}`;
const values = {
  image,
  output: "/tmp/synthetic-compatibility.tar.gz",
  platform: "linux/amd64",
  "docker-context": "synthetic-task-build",
};

function imageMetadata(policy) {
  const labels = {
    "org.opencontainers.image.version": "3.4.0",
    "org.opencontainers.image.revision":
      "ec0ff50388c264ed8ce46f00967e92f7e71476ae",
    "com.artvenn.umami.base-path": "/admin/analytics-workspace",
    "com.artvenn.umami.libc": "glibc",
    "com.artvenn.umami.node-major": "24",
    "com.artvenn.umami.pool-max": "3",
    "com.artvenn.umami.locale": "zh-CN",
    "com.artvenn.umami.patch-sha256": policy.workspaceIdentitySha256,
    "com.artvenn.umami.visitor-device-sha256": UMAMI_VISITOR_DEVICE_SHA256,
    "com.artvenn.umami.pg-tls-host-sha256": UMAMI_PG_TLS_HOST_SHA256,
    "com.artvenn.umami.province-fallback-sha256": policy.provinceFallbackSha256,
    "com.artvenn.umami.database-timezone": policy.postgresTimeZone,
    "com.artvenn.umami.geography": UMAMI_GEOGRAPHY_POLICY,
    "com.artvenn.umami.china-map-sha256": UMAMI_CHINA_MAP_SHA256,
    "com.artvenn.umami.geo-sha256":
      "fd112e5b13ca19e8bb0bf2e1902fb0694f6ba1940bef916e0d8d9d9346f4e029",
    ...(policy.id === COMPATIBILITY_POLICY
      ? {
          "com.artvenn.umami.runtime-policy": policy.id,
          "com.artvenn.umami.protected-source-sha256":
            policy.protectedInventorySha256,
          "com.artvenn.umami.protected-source-verifier-sha256":
            policy.verifierSha256,
          "com.artvenn.umami.compatibility-manifest-sha256":
            policy.manifestSha256,
        }
      : {}),
  };
  return {
    id: image,
    os: "linux",
    architecture: "amd64",
    labels,
    env: ["PATH=/usr/bin", "PORT=3010"],
  };
}

test("baseline province, environment and service bytes are preserved outside the approved additive layer", async () => {
  const changedByApprovedVisitorLayer = new Set([
    "infra/production/umami/Dockerfile",
    "infra/production/umami/.dockerignore",
    "infra/production/umami/source.json",
  ]);
  for (const [name, expected] of Object.entries(metadata.preservedDefaults)) {
    if (changedByApprovedVisitorLayer.has(name)) continue;
    assert.equal(
      hash(await readFile(path.join(repository, name))),
      expected,
      name,
    );
  }
  assert.equal(
    runtimePolicy().provinceFallbackSha256,
    "19c912fe03a013b817a86253632ac1d4957162cf3194d4cec6c08b10fac7ef6d",
  );
  assert.equal(
    runtimePolicy(COMPATIBILITY_POLICY).provinceFallbackSha256,
    "ee0442474fe367cd426f58ffc7f253320b58f550395c8104419567078acaf8f2",
  );
});

test("default build/export plans retain their original arguments and result shape", () => {
  const plan = buildImagePlan({ tag: "synthetic:test" });
  assert.deepEqual(
    Object.keys(plan).sort(),
    [
      "command",
      "args",
      "dockerContext",
      "version",
      "sourceCommit",
      "basePath",
    ].sort(),
  );
  assert.deepEqual(plan.args, [
    "buildx",
    "build",
    "--load",
    "--platform",
    "linux/amd64",
    "--target",
    "standalone",
    "--tag",
    "synthetic:test",
    "--file",
    path.join(fileURLToPath(directory), "Dockerfile"),
    fileURLToPath(directory),
  ]);
  assert.deepEqual(runtimeExportPlan(values), {
    image,
    output: values.output,
    manifest: `${values.output}.json`,
    platform: values.platform,
    dockerContext: values["docker-context"],
  });
  assert.deepEqual(
    buildImagePlan({ tag: "synthetic:test", "runtime-policy": "current" }),
    plan,
  );
});

test("only the named standalone variant selects the compatibility recipe", () => {
  const plan = buildImagePlan({
    tag: "synthetic:test",
    "runtime-policy": COMPATIBILITY_POLICY,
  });
  assert.equal(plan.runtimePolicy, COMPATIBILITY_POLICY);
  assert.equal(
    plan.args.at(-2),
    path.join(fileURLToPath(directory), "Dockerfile.ui-pre365-v1"),
  );
  for (const target of ["runtime", "migrator"])
    assert.throws(
      () =>
        buildImagePlan({
          tag: "synthetic:test",
          target,
          "runtime-policy": COMPATIBILITY_POLICY,
        }),
      /COMPATIBILITY_STANDALONE/,
    );
  for (const value of ["", "future", null, "../Dockerfile"])
    assert.throws(() => runtimePolicy(value), /RUNTIME_POLICY_INVALID/);
  assert.throws(
    () => runtimeExportPlan({ ...values, "runtime-policy": "future" }),
    /RUNTIME_POLICY_INVALID/,
  );
});

test("variant context has exactly its COPY inputs and two Docker metadata files", async () => {
  const recipe = await readFile(
    new URL("Dockerfile.ui-pre365-v1", directory),
    "utf8",
  );
  const rules = (
    await readFile(
      new URL("Dockerfile.ui-pre365-v1.dockerignore", directory),
      "utf8",
    )
  )
    .trim()
    .split("\n");
  const inputs = new Set(
    recipe
      .replace(/[ \t]*\\\n[ \t]*/gu, " ")
      .split("\n")
      .filter((line) => /^COPY /u.test(line) && !/ --from=/u.test(line))
      .flatMap((line) => line.split(/\s+/u).slice(1, -1)),
  );
  const check = (candidate) => {
    assert.equal(candidate[0], "**");
    assert.ok(
      candidate.slice(1).every((line) => /^![A-Za-z0-9._-]+$/u.test(line)),
    );
    assert.deepEqual(
      candidate
        .slice(1)
        .map((line) => line.slice(1))
        .sort(),
      [
        ...inputs,
        "Dockerfile.ui-pre365-v1",
        "Dockerfile.ui-pre365-v1.dockerignore",
      ].sort(),
    );
  };
  check(rules);
  for (const name of inputs) {
    assert.ok((await readFile(new URL(name, directory))).length > 0);
    assert.throws(
      () => check(rules.filter((line) => line !== `!${name}`)),
      assert.AssertionError,
    );
  }
  assert.throws(() => check([...rules, "!*.patch"]), assert.AssertionError);
  assert.throws(
    () => check([...rules, "!unexpected.txt"]),
    assert.AssertionError,
  );
  assert.ok(!/PGOPTIONS|\bTZ=/u.test(recipe));
  for (const pin of [
    metadata.provincePatchSha256,
    metadata.protectedInventorySha256,
    metadata.verifierSha256,
    hash(await readFile(new URL("ui-pre365-v1-source.json", directory))),
  ])
    assert.ok(recipe.includes(pin));
  assert.ok(
    recipe.indexOf("&& node /tmp/ui-pre365-v1-verify.mjs") <
      recipe.indexOf("RUN pnpm exec vitest run"),
  );
  assert.ok(recipe.includes("'src/lib/archive-theme.test.ts'"));
  assert.ok(!recipe.includes("artvenn-postgres-utc.test.ts"));
  // Generator diagnostics have no runtime consumer; keep their nondeterministic
  // timing report outside the completely inventoried source tree.
  assert.ok(
    recipe.includes(
      "&& mv src/data/geo-translations-collisions.json src/data/geo-translations-summary.json /tmp/",
    ),
  );
});

test("compatibility and current images cannot cross policies", () => {
  const current = imageMetadata(runtimePolicy());
  const compatible = imageMetadata(runtimePolicy(COMPATIBILITY_POLICY));
  const plan = runtimeExportPlan({
    ...values,
    "runtime-policy": COMPATIBILITY_POLICY,
  });
  assert.doesNotThrow(() =>
    verifyRuntimeImage(current, runtimeExportPlan(values)),
  );
  assert.doesNotThrow(() => verifyRuntimeImage(compatible, plan));
  assert.throws(() => verifyRuntimeImage(current, plan), /PINNED_GLIBC/);
  assert.throws(
    () => verifyRuntimeImage(compatible, runtimeExportPlan(values)),
    /PINNED_GLIBC/,
  );
  for (const key of [
    "com.artvenn.umami.runtime-policy",
    "com.artvenn.umami.protected-source-sha256",
    "com.artvenn.umami.protected-source-verifier-sha256",
    "com.artvenn.umami.compatibility-manifest-sha256",
  ]) {
    const labels = { ...compatible.labels };
    delete labels[key];
    assert.throws(
      () => verifyRuntimeImage({ ...compatible, labels }, plan),
      /COMPATIBILITY_RUNTIME/,
    );
  }
});

test("compatibility requires full environment metadata and rejects timezone injection including empty values", () => {
  const compatible = imageMetadata(runtimePolicy(COMPATIBILITY_POLICY));
  const plan = runtimeExportPlan({
    ...values,
    "runtime-policy": COMPATIBILITY_POLICY,
  });
  for (const env of [
    undefined,
    null,
    {},
    "PATH=/usr/bin",
    [null],
    ["PGOPTIONS"],
    ["PGOPTIONS="],
    ["PGOPTIONS=-c timezone=UTC"],
    ["TZ="],
    ["TZ=Asia/Shanghai"],
  ])
    assert.throws(
      () => verifyRuntimeImage({ ...compatible, env }, plan),
      /COMPATIBILITY_RUNTIME/,
    );
});

async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "umami-compat-source-"));
  const put = async (name, body) => {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
  };
  try {
    const protectedFiles = {
      "src/app/api/auth/route.ts": "// synthetic protected auth\n",
      "src/queries/session.ts": "// synthetic protected query\n",
    };
    for (const [name, body] of Object.entries(protectedFiles))
      await put(name, body);
    const presentationFiles = {};
    for (const name of presentationPaths) {
      const body = "// synthetic presentation\n";
      await put(name, body);
      presentationFiles[name] = hash(body);
    }
    const driver =
      "node_modules/.pnpm/pg@8.22.0/node_modules/pg/lib/connection.js";
    await put(driver, "// synthetic pinned driver\n");
    const inventoryText = Object.entries(protectedFiles)
      .map(([name, body]) => `${hash(body)}  ${name}\n`)
      .join("");
    const meta = {
      version: 1,
      id: COMPATIBILITY_POLICY,
      protectedInventorySha256: hash(inventoryText),
      protectedFileCount: 2,
      presentationFiles,
      dependencyFiles: { [driver]: hash("// synthetic pinned driver\n") },
    };
    await run({ root, put, driver, inventoryText, metadata: meta });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("source proof accepts exact source, reviewed UI and pinned driver only", async () =>
  fixture(async (context) => {
    const result = await verifyProtectedSource(context);
    assert.equal(result.protectedFiles, 2);
    assert.equal(result.presentationFiles, 8);
    assert.equal(result.dependencyFiles, 1);
  }));
test("source proof rejects changed auth, missing queries, extra files and nested node_modules shadows", async () => {
  for (const kind of ["changed", "missing", "extra", "shadow"])
    await fixture(async (context) => {
      if (kind === "changed")
        await context.put("src/app/api/auth/route.ts", "// changed\n");
      if (kind === "missing")
        await unlink(path.join(context.root, "src/queries/session.ts"));
      if (kind === "extra")
        await context.put("src/app/api/extra.ts", "// extra\n");
      if (kind === "shadow")
        await context.put(
          "src/app/node_modules/shadow/index.js",
          "// shadow\n",
        );
      await assert.rejects(verifyProtectedSource(context), /COMPAT_SOURCE_/);
    });
});
test("source proof rejects source symlinks, dependency ancestor links and special files", async () => {
  for (const kind of ["source", "dependency", "fifo"])
    await fixture(async (context) => {
      if (kind === "source") {
        const target = path.join(context.root, "src/queries/session.ts");
        await unlink(target);
        await symlink("../app/api/auth/route.ts", target);
      }
      if (kind === "dependency") {
        const dir = path.join(
          context.root,
          "node_modules/.pnpm/pg@8.22.0/node_modules/pg/lib",
        );
        await rm(dir, { recursive: true });
        await mkdir(path.join(context.root, "node_modules/other"));
        await writeFile(
          path.join(context.root, "node_modules/other/connection.js"),
          "// synthetic pinned driver\n",
        );
        await symlink(path.join(context.root, "node_modules/other"), dir);
      }
      if (kind === "fifo")
        execFileSync("mkfifo", [path.join(context.root, "src/pipe")]);
      await assert.rejects(
        verifyProtectedSource(context),
        /COMPAT_(?:SOURCE|DEPENDENCY)_/,
      );
    });
});
test("inventory parser rejects duplicate and escaping paths instead of broadening protection", () => {
  const h = "a".repeat(64);
  assert.throws(
    () => parseProtectedInventory(`${h}  src/a.ts\n${h}  src/a.ts\n`),
    /DUPLICATE/,
  );
  for (const name of [
    "../escape",
    "/absolute",
    "src/../escape",
    "src//file",
    "src\\file",
    "node_modules/x",
    presentationPaths[0],
  ])
    assert.throws(
      () => parseProtectedInventory(`${h}  ${name}\n`),
      /COMPAT_INVENTORY_/,
    );
});
test("source proof rejects unknown presentation scope and altered inventory metadata", async () =>
  fixture(async (context) => {
    await assert.rejects(
      verifyProtectedSource({
        ...context,
        metadata: { ...context.metadata, id: "future" },
      }),
      /IDENTITY/,
    );
    await assert.rejects(
      verifyProtectedSource({
        ...context,
        inventoryText: `${context.inventoryText}\n`,
      }),
      /IDENTITY/,
    );
    await assert.rejects(
      verifyProtectedSource({
        ...context,
        metadata: {
          ...context.metadata,
          presentationFiles: {
            ...context.metadata.presentationFiles,
            "src/app/api/new.ts": "a".repeat(64),
          },
        },
      }),
      /PRESENTATION_SCOPE/,
    );
  }));

test("compatibility CLI export records the chosen source policy and streams only its stopped synthetic container", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "umami-compat-export-"));
  try {
    await writeFile(
      path.join(root, "server.js"),
      "// synthetic standalone only\n",
    );
    const tar = execFileSync("tar", ["-cf", "-", "-C", root, "server.js"]);
    const log = path.join(root, "calls.jsonl");
    const fixtureMetadata = imageMetadata(runtimePolicy(COMPATIBILITY_POLICY));
    await writeFile(
      path.join(root, "docker"),
      `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nconst args=process.argv.slice(2); appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');\nif(args[0]!=='--context'||args[1]!=='synthetic-task-build')process.exit(11);\nif(args[2]==='image')console.log(${JSON.stringify(JSON.stringify(fixtureMetadata))});\nelse if(args[2]==='create')console.log('${"b".repeat(64)}');\nelse if(args[2]==='cp')process.stdout.write(Buffer.from('${tar.toString("base64")}','base64'));\nelse if(args[2]!=='rm')process.exit(12);\n`,
      { mode: 0o700 },
    );
    const output = path.join(root, "runtime.tar.gz");
    const cli = fileURLToPath(
      new URL("./export-umami-runtime.mjs", import.meta.url),
    );
    const result = spawnSync(
      process.execPath,
      [
        cli,
        "--image",
        image,
        "--output",
        output,
        "--platform",
        "linux/amd64",
        "--docker-context",
        "synthetic-task-build",
        "--runtime-policy",
        COMPATIBILITY_POLICY,
        "--execute",
      ],
      {
        env: {
          ...process.env,
          PATH: `${root}${path.delimiter}${process.env.PATH}`,
        },
        encoding: "utf8",
        timeout: 10000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(await readFile(`${output}.json`, "utf8"));
    assert.equal(manifest.runtimePolicy, COMPATIBILITY_POLICY);
    assert.equal(manifest.postgresTimeZone, "inherit");
    assert.equal(manifest.businessSourceBaseline, metadata.baselineCommit);
    assert.equal(
      manifest.protectedInventorySha256,
      metadata.protectedInventorySha256,
    );
    assert.equal(
      manifest.configurationPolicy,
      "inherit-existing-effective-environment",
    );
    assert.equal(manifest.archiveSha256, hash(await readFile(output)));
    const calls = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.ok(
      !calls.some((args) => args.includes("run") || args.includes("start")),
    );
    assert.equal(calls.at(-1)[2], "rm");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
