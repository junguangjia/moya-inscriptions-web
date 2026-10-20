import { URL } from "node:url";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  UMAMI_WORKSPACE_IDENTITY,
  UMAMI_PG_TLS_HOST_SHA256,
} from "./common.mjs";
import { createHash } from "node:crypto";
import { buildImagePlan } from "./build-umami-image.mjs";
import {
  seedSyntheticUmami,
  syntheticEvents,
} from "./seed-synthetic-umami.mjs";

const environment = {
  ANALYTICS_TASK_ENV: "synthetic",
  UMAMI_ORIGIN: "http://127.0.0.1:3010",
  UMAMI_WEBSITE_ID: "10000000-0000-4000-8000-000000000004",
  UMAMI_WEBSITE_DOMAIN: "localhost",
  UMAMI_SYNTHETIC_RUN_ID: "10000000-0000-4000-8000-000000000009",
  UMAMI_VIEWER_USERNAME: "synthetic-viewer",
  UMAMI_VIEWER_PASSWORD: "synthetic-not-valid-password",
};

test("pinned build isolates its context and checks the exact pool-only patch", async () => {
  const plan = buildImagePlan({
    tag: "artvenn-umami:synthetic",
    platform: "linux/arm64",
  });
  assert.equal(plan.basePath, "/admin/analytics-workspace");
  assert.equal(plan.sourceCommit, "ec0ff50388c264ed8ce46f00967e92f7e71476ae");
  assert.match(plan.args.at(-1), /infra\/production\/umami\/$/u);
  assert.throws(() => buildImagePlan({ tag: "latest" }), /TAG/);
  assert.throws(
    () => buildImagePlan({ tag: "synthetic:test", platform: "linux/unknown" }),
    /PLATFORM/,
  );
  const dockerfile = await readFile(
    new URL("../../infra/production/umami/Dockerfile", import.meta.url),
    "utf8",
  );
  assert.match(dockerfile, /ADD --checksum=sha256:/u);
  assert.match(dockerfile, /sha256sum -c \/tmp\/upstream-pool.sha256/u);
  assert.match(dockerfile, /patch -p1 --fuzz=0/u);
  assert.match(dockerfile, /sha256sum -c \/tmp\/patched-pool.sha256/u);
  const patch = await readFile(
    new URL("../../infra/production/umami/pool-limit.patch", import.meta.url),
    "utf8",
  );
  const added = patch
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"));
  assert.equal(added.length, 2);
  assert.ok(added.every((line) => line.includes("max: 3")));
});

test("pg TLS patch only adds the original host to the existing socket options", async () => {
  const patch = await readFile(
    new URL("../../infra/production/umami/pg-tls-host.patch", import.meta.url),
    "utf8",
  );
  const target =
    "node_modules/.pnpm/pg@8.22.0/node_modules/pg/lib/connection.js";
  const assertHostOnly = (value) => {
    assert.deepEqual(
      value.split("\n").filter((line) => /^[+@-]/u.test(line)),
      [
        `--- a/${target}`,
        `+++ b/${target}`,
        "@@ -96,6 +96,7 @@",
        "+      host,",
      ],
    );
  };
  assertHostOnly(patch);
  for (const changed of [
    patch.replace("+      host,", "+      host: self.host,"),
    patch.replace(
      "+      host,",
      "+      host,\n+      rejectUnauthorized: false,",
    ),
    patch.replace("       socket: self.stream,", "-      socket: self.stream,"),
    `${patch}@@ -120,0 +121,1 @@\n+      host,\n`,
    `${patch}--- a/another.js\n+++ b/another.js\n`,
  ]) {
    assert.throws(() => assertHostOnly(changed), assert.AssertionError);
  }
});

test("pg TLS patch and checksum pins stay bound to both image build paths and exports", async () => {
  const directory = new URL("../../infra/production/umami/", import.meta.url);
  const source = JSON.parse(
    await readFile(new URL("source.json", directory), "utf8"),
  ).postgresTlsPatch;
  const target =
    "node_modules/.pnpm/pg@8.22.0/node_modules/pg/lib/connection.js";
  assert.equal(source.file, "pg-tls-host.patch");
  assert.equal(source.dependency, "pg@8.22.0");
  assert.equal(
    source.upstreamFileSha256,
    "5c17c585f307518f8369d6162d138c58eef1309128ad2fae2d6b315c8000234e",
  );
  assert.equal(source.upstreamHashes, "upstream-pg-tls.sha256");
  assert.equal(source.patchedHashes, "patched-pg-tls.sha256");
  assert.equal(
    createHash("sha256")
      .update(await readFile(new URL(source.file, directory)))
      .digest("hex"),
    source.sha256,
  );
  assert.equal(
    await readFile(new URL(source.upstreamHashes, directory), "utf8"),
    `${source.upstreamFileSha256}  ${target}\n`,
  );
  assert.equal(source.patchedFileSha256, UMAMI_PG_TLS_HOST_SHA256);
  assert.equal(
    await readFile(new URL(source.patchedHashes, directory), "utf8"),
    `${UMAMI_PG_TLS_HOST_SHA256}  ${target}\n`,
  );

  const dockerfile = await readFile(new URL("Dockerfile", directory), "utf8");
  const stages = new Map(
    dockerfile
      .split(/^FROM /mu)
      .slice(1)
      .map((body) => [/^\S+ AS (\S+)\n/u.exec(body)?.[1], body]),
  );
  const patchStep =
    "RUN sha256sum -c /tmp/upstream-pg-tls.sha256 && patch -p1 --fuzz=0 < /tmp/pg-tls-host.patch && sha256sum -c /tmp/patched-pg-tls.sha256";
  for (const name of ["builder", "standalone-builder"]) {
    const stage = stages.get(name);
    assert.ok(stage, `${name} must remain a named build stage`);
    const instructions = stage.replace(/[ \t]*\\\n[ \t]*/gu, " ").split("\n");
    assert.equal(
      instructions.filter(
        (line) =>
          line ===
          "COPY pg-tls-host.patch upstream-pg-tls.sha256 patched-pg-tls.sha256 /tmp/",
      ).length,
      1,
    );
    assert.equal(instructions.filter((line) => line === patchStep).length, 1);
    assert.ok(
      stage.indexOf("COPY pg-tls-host.patch") <
        stage.indexOf("RUN sha256sum -c /tmp/upstream-pg-tls.sha256"),
    );
    assert.ok(
      stage.indexOf(patchStep.split(" && ")[0]) <
        stage.indexOf("pnpm build:docker"),
    );
  }
  for (const name of ["runtime", "standalone"]) {
    assert.ok(
      stages
        .get(name)
        ?.includes(
          `com.artvenn.umami.pg-tls-host-sha256="${UMAMI_PG_TLS_HOST_SHA256}"`,
        ),
      `${name} must declare the checked TLS file identity`,
    );
  }
});

test("synthetic seed is bounded, local only, and uses pageviews plus canonical funnel names", async () => {
  const events = syntheticEvents(environment, 1792368000000);
  assert.equal(events.length, 20);
  assert.equal(events.filter((event) => !event.payload.name).length, 8);
  assert.equal(
    events.filter((event) => event.payload.name === "content_impression")
      .length,
    6,
  );
  assert.equal(
    events.filter((event) => event.payload.name === "content_open").length,
    4,
  );
  assert.equal(
    events.filter((event) => event.payload.name === "favorite").length,
    2,
  );
  assert.ok(
    events.every(
      (event) => event.payload.website === environment.UMAMI_WEBSITE_ID,
    ),
  );
  assert.throws(
    () => syntheticEvents({ ...environment, ANALYTICS_TASK_ENV: "production" }),
    /ENVIRONMENT/,
  );
  assert.throws(
    () =>
      syntheticEvents({
        ...environment,
        UMAMI_WEBSITE_DOMAIN: "real.example.com",
      }),
    /SYNTHETIC_DOMAIN/,
  );
  assert.equal((await seedSyntheticUmami(environment)).status, "PLAN_ONLY");
});

test("native collection acceptance counts must match and never return cache credentials", async () => {
  const fetchImpl = async (url) => {
    const endpoint = new URL(url).pathname.split("/api/")[1];
    if (endpoint === "auth/login")
      return globalThis.Response.json({
        token: "synthetic-token-never-output",
        user: { role: "view-only", isAdmin: false },
      });
    if (endpoint.startsWith("websites/") && !endpoint.includes("/stats"))
      return globalThis.Response.json({
        id: environment.UMAMI_WEBSITE_ID,
        domain: "localhost",
        shareId: null,
      });
    if (endpoint === "batch")
      return globalThis.Response.json({
        size: 20,
        processed: 20,
        errors: 0,
        cache: "synthetic-private-cache",
      });
    if (endpoint.endsWith("/stats"))
      return globalThis.Response.json({ pageviews: { value: 8 } });
    assert.fail("Unexpected synthetic endpoint");
  };
  const result = await seedSyntheticUmami(environment, {
    execute: true,
    fetchImpl,
  });
  assert.equal(result.acceptedEvents, 20);
  assert.ok(!JSON.stringify(result).includes("synthetic-token"));
  assert.ok(!JSON.stringify(result).includes("synthetic-private-cache"));
});

test("standalone runtime export requires immutable glibc image metadata and explicit daemon context", async () => {
  const { runtimeExportPlan, verifyRuntimeImage, exportRuntime } =
    await import("./export-umami-runtime.mjs");
  const values = {
    image: `sha256:${"a".repeat(64)}`,
    output: "/tmp/synthetic-umami.tar.gz",
    platform: "linux/amd64",
    "docker-context": "synthetic-task-build",
  };
  const plan = runtimeExportPlan(values);
  assert.throws(
    () => runtimeExportPlan({ ...values, image: "mutable:latest" }),
    /IMMUTABLE/,
  );
  assert.throws(
    () => runtimeExportPlan({ ...values, "docker-context": undefined }),
    /CONTEXT/,
  );
  const metadata = {
    id: values.image,
    os: "linux",
    architecture: "amd64",
    labels: {
      "org.opencontainers.image.version": "3.4.0",
      "org.opencontainers.image.revision":
        "ec0ff50388c264ed8ce46f00967e92f7e71476ae",
      "com.artvenn.umami.base-path": "/admin/analytics-workspace",
      "com.artvenn.umami.libc": "glibc",
      "com.artvenn.umami.node-major": "24",
      "com.artvenn.umami.pool-max": "3",
      "com.artvenn.umami.locale": "zh-CN",
      "com.artvenn.umami.patch-sha256": UMAMI_WORKSPACE_IDENTITY,
      "com.artvenn.umami.pg-tls-host-sha256": UMAMI_PG_TLS_HOST_SHA256,
      "com.artvenn.umami.geography": "cn-province-v1",
      "com.artvenn.umami.geo-sha256":
        "fd112e5b13ca19e8bb0bf2e1902fb0694f6ba1940bef916e0d8d9d9346f4e029",
    },
  };
  assert.doesNotThrow(() => verifyRuntimeImage(metadata, plan));
  for (const key of [
    "com.artvenn.umami.patch-sha256",
    "com.artvenn.umami.pg-tls-host-sha256",
    "com.artvenn.umami.locale",
    "com.artvenn.umami.geography",
    "com.artvenn.umami.geo-sha256",
  ]) {
    const labels = { ...metadata.labels };
    delete labels[key];
    assert.throws(
      () => verifyRuntimeImage({ ...metadata, labels }, plan),
      /GLIBC/,
    );
  }
  assert.throws(
    () => verifyRuntimeImage({ ...metadata, architecture: "arm64" }, plan),
    /GLIBC/,
  );
  assert.throws(
    () =>
      verifyRuntimeImage(
        {
          ...metadata,
          labels: { ...metadata.labels, "com.artvenn.umami.libc": "musl" },
        },
        plan,
      ),
    /GLIBC/,
  );
  assert.equal((await exportRuntime(values)).status, "PLAN_ONLY");
});

test("Chinese native patch, generator and immutable export identity stay bound", async () => {
  const directory = new URL("../../infra/production/umami/", import.meta.url);
  const source = JSON.parse(
    await readFile(new URL("source.json", directory), "utf8"),
  );
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const patch = await readFile(new URL("chinese-workspace.patch", directory));
  const generator = await readFile(
    new URL("generate-chinese-dictionaries.mjs", directory),
  );
  assert.equal(hash(patch), source.localizationPatch.sha256);
  assert.equal(hash(generator), source.localizationPatch.generatorSha256);
  assert.equal(hash(hash(patch) + hash(generator)), UMAMI_WORKSPACE_IDENTITY);
  assert.equal(
    source.localizationPatch.identitySha256,
    UMAMI_WORKSPACE_IDENTITY,
  );
  const dockerfile = await readFile(new URL("Dockerfile", directory), "utf8");
  assert.match(dockerfile, /SKIP_BUILD_GEO=1/u);
  assert.ok(dockerfile.includes(source.geographyDatabase.archiveSha256));
  assert.ok(dockerfile.includes(UMAMI_WORKSPACE_IDENTITY));
  assert.match(dockerfile, /sha256sum -c \/tmp\/generated-chinese.sha256/u);
  assert.match(dockerfile, /vitest run src\/lib\/format.test.ts/u);
});
