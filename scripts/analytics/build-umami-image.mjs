import process from "node:process";
import console from "node:console";
import path from "node:path";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import {
  AnalyticsToolError,
  UMAMI_BASE_PATH,
  UMAMI_SOURCE_COMMIT,
  UMAMI_VERSION,
} from "./common.mjs";

import { COMPATIBILITY_POLICY, runtimePolicy } from "./runtime-policy.mjs";

export function buildImagePlan(values) {
  const target = values.target ?? "standalone";
  const platform = values.platform ?? "linux/amd64";
  const tag = values.tag;
  if (!["runtime", "migrator", "standalone"].includes(target))
    throw new AnalyticsToolError("BUILD_TARGET_INVALID");
  if (!["linux/amd64", "linux/arm64"].includes(platform))
    throw new AnalyticsToolError("BUILD_PLATFORM_INVALID");
  if (
    !tag ||
    !/^[a-z0-9][a-z0-9._/-]*:[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(tag)
  )
    throw new AnalyticsToolError("EXPLICIT_IMAGE_TAG_REQUIRED");
  const policy = runtimePolicy(values["runtime-policy"]);
  if (policy.id === COMPATIBILITY_POLICY && target !== "standalone")
    throw new AnalyticsToolError("COMPATIBILITY_STANDALONE_REQUIRED");
  const dockerContext = values["docker-context"];
  if (
    dockerContext !== undefined &&
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/u.test(dockerContext)
  )
    throw new AnalyticsToolError("EXPLICIT_BUILD_DOCKER_CONTEXT_REQUIRED");
  const context = fileURLToPath(
    new URL("../../infra/production/umami/", import.meta.url),
  );
  return {
    command: "docker",
    args: [
      ...(dockerContext ? ["--context", dockerContext] : []),
      "buildx",
      "build",
      "--load",
      "--platform",
      platform,
      "--target",
      target,
      "--tag",
      tag,
      "--file",
      path.join(context, policy.dockerfile),
      context,
    ],
    ...(policy.id === COMPATIBILITY_POLICY ? { runtimePolicy: policy.id } : {}),
    dockerContext: dockerContext ?? "EXPLICIT_CONTEXT_REQUIRED",
    version: UMAMI_VERSION,
    sourceCommit: UMAMI_SOURCE_COMMIT,
    basePath: UMAMI_BASE_PATH,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const { values } = parseArgs({
      options: {
        tag: { type: "string" },
        "docker-context": { type: "string" },
        target: { type: "string" },
        "runtime-policy": { type: "string" },
        platform: { type: "string" },
        execute: { type: "boolean", default: false },
      },
      allowPositionals: false,
    });
    const plan = buildImagePlan(values);
    if (!values.execute)
      console.info(JSON.stringify({ status: "PLAN_ONLY", ...plan }));
    else {
      if (
        !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/u.test(
          values["docker-context"] ?? "",
        )
      )
        throw new AnalyticsToolError("EXPLICIT_BUILD_DOCKER_CONTEXT_REQUIRED");
      // No repository/private .env enters the build context. No credentials.
      const result = spawnSync(plan.command, plan.args, {
        stdio: "inherit",
        timeout: 30 * 60 * 1000,
      });
      process.exitCode = result.status ?? 1;
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        ok: false,
        code:
          error instanceof AnalyticsToolError
            ? error.code
            : "UMAMI_IMAGE_BUILD_FAILED",
      }),
    );
    process.exitCode = 1;
  }
}
