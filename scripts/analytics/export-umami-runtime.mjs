import process from "node:process";
import console from "node:console";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  AnalyticsToolError,
  UMAMI_VERSION,
  UMAMI_SOURCE_COMMIT,
  UMAMI_BASE_PATH,
  UMAMI_WORKSPACE_IDENTITY,
  UMAMI_VISITOR_DEVICE_SHA256,
  UMAMI_PG_TLS_HOST_SHA256,
  UMAMI_GEOGRAPHY_POLICY,
  UMAMI_CHINA_MAP_SHA256,
} from "./common.mjs";

import { COMPATIBILITY_POLICY, runtimePolicy } from "./runtime-policy.mjs";

export function runtimeExportPlan(values) {
  if (!/^sha256:[a-f0-9]{64}$/u.test(values.image ?? ""))
    throw new AnalyticsToolError("IMMUTABLE_LOCAL_IMAGE_ID_REQUIRED");
  if (
    !values.output ||
    !path.isAbsolute(values.output) ||
    !values.output.endsWith(".tar.gz")
  )
    throw new AnalyticsToolError("ABSOLUTE_RUNTIME_ARCHIVE_REQUIRED");
  if (!["linux/amd64", "linux/arm64"].includes(values.platform))
    throw new AnalyticsToolError("EXPLICIT_RUNTIME_PLATFORM_REQUIRED");
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/u.test(values["docker-context"] ?? "")
  )
    throw new AnalyticsToolError("EXPLICIT_BUILD_DOCKER_CONTEXT_REQUIRED");
  const policy = runtimePolicy(values["runtime-policy"]);
  return {
    ...(policy.id === COMPATIBILITY_POLICY ? { runtimePolicy: policy.id } : {}),
    image: values.image,
    output: values.output,
    manifest: `${values.output}.json`,
    platform: values.platform,
    dockerContext: values["docker-context"],
  };
}

export function verifyRuntimeImage(metadata, plan) {
  const labels = metadata.labels ?? {};
  const policy = runtimePolicy(plan.runtimePolicy);
  if (
    metadata.id !== plan.image ||
    `${metadata.os}/${metadata.architecture}` !== plan.platform ||
    labels["org.opencontainers.image.version"] !== UMAMI_VERSION ||
    labels["org.opencontainers.image.revision"] !== UMAMI_SOURCE_COMMIT ||
    labels["com.artvenn.umami.base-path"] !== UMAMI_BASE_PATH ||
    labels["com.artvenn.umami.libc"] !== "glibc" ||
    labels["com.artvenn.umami.node-major"] !== "24" ||
    labels["com.artvenn.umami.pool-max"] !== "3" ||
    labels["com.artvenn.umami.locale"] !== "zh-CN" ||
    labels["com.artvenn.umami.patch-sha256"] !==
      policy.workspaceIdentitySha256 ||
    labels["com.artvenn.umami.visitor-device-sha256"] !==
      UMAMI_VISITOR_DEVICE_SHA256 ||
    labels["com.artvenn.umami.pg-tls-host-sha256"] !==
      UMAMI_PG_TLS_HOST_SHA256 ||
    labels["com.artvenn.umami.province-fallback-sha256"] !==
      policy.provinceFallbackSha256 ||
    labels["com.artvenn.umami.database-timezone"] !== policy.postgresTimeZone ||
    labels["com.artvenn.umami.geography"] !== UMAMI_GEOGRAPHY_POLICY ||
    labels["com.artvenn.umami.china-map-sha256"] !== UMAMI_CHINA_MAP_SHA256 ||
    labels["com.artvenn.umami.geo-sha256"] !==
      "fd112e5b13ca19e8bb0bf2e1902fb0694f6ba1940bef916e0d8d9d9346f4e029"
  )
    throw new AnalyticsToolError("PINNED_GLIBC_RUNTIME_IMAGE_REQUIRED");
  if (
    policy.id === COMPATIBILITY_POLICY &&
    (labels["com.artvenn.umami.runtime-policy"] !== policy.id ||
      labels["com.artvenn.umami.protected-source-sha256"] !==
        policy.protectedInventorySha256 ||
      labels["com.artvenn.umami.protected-source-verifier-sha256"] !==
        policy.verifierSha256 ||
      labels["com.artvenn.umami.compatibility-manifest-sha256"] !==
        policy.manifestSha256 ||
      !Array.isArray(metadata.env) ||
      metadata.env.some(
        (entry) =>
          typeof entry !== "string" ||
          !/^[A-Za-z_][A-Za-z0-9_]*=/u.test(entry) ||
          /^(?:PGOPTIONS|TZ)=/u.test(entry),
      ))
  )
    throw new AnalyticsToolError("COMPATIBILITY_RUNTIME_IDENTITY_REQUIRED");
}

/** Export a stopped task-owned container. No server/process/DB is started. */
export async function exportRuntime(values) {
  const plan = runtimeExportPlan(values);
  const policy = runtimePolicy(plan.runtimePolicy);
  if (!values.execute)
    return {
      ok: true,
      status: "PLAN_ONLY",
      ...plan,
      version: UMAMI_VERSION,
      sourceCommit: UMAMI_SOURCE_COMMIT,
      libc: "glibc",
      nodeMajor: 24,
    };
  const deadline = Date.now() + 180000;
  const docker = (args, maxBuffer = 65536) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new AnalyticsToolError("RUNTIME_EXPORT_DEADLINE");
    const result = spawnSync(
      "docker",
      ["--context", plan.dockerContext, ...args],
      {
        encoding: "utf8",
        timeout: Math.min(15000, remaining),
        maxBuffer,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    if (result.status !== 0)
      throw new AnalyticsToolError("RUNTIME_DOCKER_OPERATION_FAILED");
    return result.stdout.trim();
  };
  const format =
    '{"labels":{{json .Config.Labels}},"architecture":{{json .Architecture}},"os":{{json .Os}},"id":{{json .Id}},"env":{{json .Config.Env}}}';
  let metadata;
  try {
    metadata = JSON.parse(
      docker(["image", "inspect", "--format", format, plan.image]),
    );
  } catch {
    throw new AnalyticsToolError("RUNTIME_IMAGE_METADATA_INVALID");
  }
  verifyRuntimeImage(metadata, plan);
  // Both outputs must be absent; lstat refuses preexisting symlinks as well.
  for (const filename of [plan.output, plan.manifest]) {
    try {
      await lstat(filename);
      throw new AnalyticsToolError("RUNTIME_OUTPUT_EXISTS");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const name = `artvenn-umami-export-${randomUUID()}`;
  let containerId;
  let createAttempted = false;
  let archiveCreated = false;
  let manifestCreated = false;
  let success = false;
  let archive;
  let manifest;
  let copyChild;
  let outcome;
  let failure;
  let cleanupFailure;
  try {
    createAttempted = true;
    containerId = docker([
      "create",
      "--name",
      name,
      "--network",
      "none",
      "--entrypoint",
      "/bin/true",
      plan.image,
    ]);
    if (!/^[a-f0-9]{64}$/u.test(containerId))
      throw new AnalyticsToolError("RUNTIME_CONTAINER_ID_INVALID");
    archive = await open(plan.output, "wx", 0o600);
    archiveCreated = true;
    const hash = createHash("sha256");
    let bytes = 0;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024 * 1024)
          callback(new AnalyticsToolError("RUNTIME_ARCHIVE_SIZE_LIMIT"));
        else {
          hash.update(chunk);
          callback(null, chunk);
        }
      },
    });
    const child = spawn(
      "docker",
      ["--context", plan.dockerContext, "cp", `${containerId}:/app/.`, "-"],
      {
        stdio: ["ignore", "pipe", "ignore"],
        signal: globalThis.AbortSignal.timeout(
          Math.max(1, deadline - Date.now()),
        ),
      },
    );
    copyChild = child;
    const exited = new Promise((resolve, reject) => {
      child.once("error", () =>
        reject(new AnalyticsToolError("RUNTIME_ARCHIVE_COPY_FAILED")),
      );
      child.once("exit", (code) =>
        code === 0
          ? resolve()
          : reject(new AnalyticsToolError("RUNTIME_ARCHIVE_COPY_FAILED")),
      );
    });
    // Docker supplies an uncompressed tar; compress/hash without loading it in RAM.
    const destination = createWriteStream(plan.output, {
      fd: archive.fd,
      autoClose: false,
    });
    await Promise.all([
      pipeline(child.stdout, createGzip(), meter, destination).catch(() => {
        child.kill("SIGTERM");
        throw new AnalyticsToolError("RUNTIME_ARCHIVE_WRITE_FAILED");
      }),
      exited,
    ]);
    await archive.sync();
    const sha256 = hash.digest("hex");
    manifest = await open(plan.manifest, "wx", 0o600);
    manifestCreated = true;
    await manifest.writeFile(
      `${JSON.stringify({ version: UMAMI_VERSION, sourceCommit: UMAMI_SOURCE_COMMIT, sourceArchiveSha256: "dfdc154f23fe52ffd8fbf13c0544ea880e5ef01463f57d06954512b41c50a93a", imageId: plan.image, platform: plan.platform, libc: "glibc", nodeMajor: 24, basePath: UMAMI_BASE_PATH, poolMax: 3, workspaceIdentitySha256: UMAMI_WORKSPACE_IDENTITY, visitorDevicePatchSha256: UMAMI_VISITOR_DEVICE_SHA256, postgresTlsHostSha256: UMAMI_PG_TLS_HOST_SHA256, locale: "zh-CN", geographyPolicy: UMAMI_GEOGRAPHY_POLICY, postgresTimeZone: policy.postgresTimeZone, provinceFallbackSha256: policy.provinceFallbackSha256, ...(policy.id === COMPATIBILITY_POLICY ? { runtimePolicy: policy.id, businessSourceBaseline: policy.businessSourceBaseline, protectedInventorySha256: policy.protectedInventorySha256, compatibilityManifestSha256: policy.manifestSha256, configurationPolicy: "inherit-existing-effective-environment" } : {}), chinaMapSha256: UMAMI_CHINA_MAP_SHA256, geoDatabaseSha256: "fd112e5b13ca19e8bb0bf2e1902fb0694f6ba1940bef916e0d8d9d9346f4e029", archiveSha256: sha256, archiveBytes: bytes, contents: "/app standalone only; no private env/config/database" }, null, 2)}\n`,
    );
    await manifest.sync();
    success = true;
    outcome = {
      ok: true,
      status: "RUNTIME_EXPORTED",
      version: UMAMI_VERSION,
      sourceCommit: UMAMI_SOURCE_COMMIT,
      imageId: plan.image,
      platform: plan.platform,
      archiveSha256: sha256,
      archiveBytes: bytes,
    };
  } catch (error) {
    failure = error;
  } finally {
    if (copyChild && copyChild.exitCode === null) copyChild.kill("SIGTERM");
    const closed = await Promise.allSettled([
      archive?.close(),
      manifest?.close(),
    ]);
    // Name is generated here before create: it also covers daemon-side success
    // followed by a local timeout or an incomplete create response.
    let cleanupFailed = closed.some((result) => result.status === "rejected");
    if (createAttempted) {
      const removed = spawnSync(
        "docker",
        ["--context", plan.dockerContext, "rm", name],
        { timeout: 5000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      if (removed.status !== 0) {
        // A failed create may have created nothing. Distinguish that case from
        // daemon/unexpected-state failures without printing raw Docker output.
        const missing = new RegExp(
          `No such (?:container|object): ${name}`,
          "u",
        ).test(removed.stderr ?? "");
        cleanupFailed ||= !missing;
      }
    }
    if (!success) {
      if (archiveCreated) await unlink(plan.output).catch(() => {});
      if (manifestCreated) await unlink(plan.manifest).catch(() => {});
    }
    if (cleanupFailed) {
      cleanupFailure = new AnalyticsToolError(
        "RUNTIME_EXPORT_CLEANUP_INCOMPLETE",
      );
      cleanupFailure.containerName = name;
    }
  }
  if (cleanupFailure) throw cleanupFailure;
  if (failure) throw failure;
  return outcome;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const { values } = parseArgs({
      options: {
        image: { type: "string" },
        "docker-context": { type: "string" },
        output: { type: "string" },
        platform: { type: "string" },
        "runtime-policy": { type: "string" },
        execute: { type: "boolean", default: false },
      },
      allowPositionals: false,
    });
    console.info(JSON.stringify(await exportRuntime(values)));
  } catch (error) {
    console.error(
      JSON.stringify({
        ok: false,
        code:
          error instanceof AnalyticsToolError
            ? error.code
            : "UMAMI_RUNTIME_EXPORT_FAILED",
        ...(error?.containerName ? { containerName: error.containerName } : {}),
      }),
    );
    process.exitCode = 1;
  }
}
