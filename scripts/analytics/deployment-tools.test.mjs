import { URL } from "node:url";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
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

test("synthetic seed is bounded, local only, and uses pageviews plus canonical funnel names", async () => {
  const events = syntheticEvents(environment, 1792368000000);
  assert.equal(events.length, 18);
  assert.equal(events.filter((event) => !event.payload.name).length, 6);
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
        size: 18,
        processed: 18,
        errors: 0,
        cache: "synthetic-private-cache",
      });
    if (endpoint.endsWith("/stats"))
      return globalThis.Response.json({ pageviews: { value: 6 } });
    assert.fail("Unexpected synthetic endpoint");
  };
  const result = await seedSyntheticUmami(environment, {
    execute: true,
    fetchImpl,
  });
  assert.equal(result.acceptedEvents, 18);
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
    },
  };
  assert.doesNotThrow(() => verifyRuntimeImage(metadata, plan));
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
