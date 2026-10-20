import process from "node:process";
import console from "node:console";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { createUmamiClient } from "./bootstrap-umami.mjs";
import {
  AnalyticsToolError,
  readPrivateConfig,
  requireSetting,
  umamiOrigin,
  uuid,
  validateEnvironment,
} from "./common.mjs";

export async function rotateBootstrapPassword(
  environment,
  selected,
  options = {},
) {
  validateEnvironment(environment, selected);
  const origin = umamiOrigin(requireSetting(environment, "UMAMI_ORIGIN"));
  const username = requireSetting(environment, "UMAMI_BOOTSTRAP_USERNAME");
  const currentPassword = requireSetting(
    environment,
    "UMAMI_BOOTSTRAP_PASSWORD",
  );
  const newPassword = requireSetting(
    environment,
    "UMAMI_BOOTSTRAP_NEW_PASSWORD",
  );
  if (
    newPassword.length < 24 ||
    newPassword.length > 255 ||
    newPassword === currentPassword
  )
    throw new AnalyticsToolError("DISTINCT_RANDOM_BOOTSTRAP_PASSWORD_REQUIRED");
  if (!options.execute) return { ok: true, status: "PLAN_ONLY" };
  const api = createUmamiClient(origin, options.fetchImpl);
  let user;
  try {
    user = await api.login(username, newPassword);
  } catch (error) {
    if (
      !(error instanceof AnalyticsToolError) ||
      error.code !== "UMAMI_HTTP_401"
    )
      throw error;
  }
  if (user) {
    if (!user.isAdmin || user.role !== "admin")
      throw new AnalyticsToolError("BOOTSTRAP_ADMIN_REQUIRED");
    return { ok: true, status: "ALREADY_ROTATED", userId: uuid(user.id) };
  }
  user = await api.login(username, currentPassword);
  if (!user.isAdmin || user.role !== "admin")
    throw new AnalyticsToolError("BOOTSTRAP_ADMIN_REQUIRED");
  await api.request("POST", "/me/password", { currentPassword, newPassword });
  const verified = await api.login(username, newPassword);
  if (verified.id !== user.id || !verified.isAdmin)
    throw new AnalyticsToolError("PASSWORD_ROTATION_VERIFICATION_FAILED");
  return { ok: true, status: "ROTATED", userId: uuid(user.id) };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const { values } = parseArgs({
      options: {
        config: { type: "string" },
        environment: { type: "string" },
        execute: { type: "boolean", default: false },
      },
      allowPositionals: false,
    });
    const environment = await readPrivateConfig(
      values.config,
      values.environment,
    );
    console.info(
      JSON.stringify(
        await rotateBootstrapPassword(environment, values.environment, {
          execute: values.execute,
        }),
      ),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        ok: false,
        code:
          error instanceof AnalyticsToolError
            ? error.code
            : "UMAMI_PASSWORD_ROTATION_FAILED",
      }),
    );
    process.exitCode = 1;
  }
}
