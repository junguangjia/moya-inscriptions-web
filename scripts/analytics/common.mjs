import { URL } from "node:url";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";

export const UMAMI_VERSION = "3.4.0";
export const UMAMI_SOURCE_COMMIT = "ec0ff50388c264ed8ce46f00967e92f7e71476ae";
export const UMAMI_WORKSPACE_IDENTITY =
  "fe1ae90c0f4b9b71c3362d62404518f8bdcbe7ce35de22abdfc4d6d3567cf101";
export const UMAMI_PG_TLS_HOST_SHA256 =
  "ad0a70c6fc8820bb613a8437c634b6a0a6a04cc3cc36175ab72590d2733c24e6";
export const UMAMI_BASE_PATH = "/admin/analytics-workspace";

/** Error codes deliberately contain no upstream messages, URLs or credentials. */
export class AnalyticsToolError extends Error {
  constructor(code) {
    super(code);
    this.name = "AnalyticsToolError";
    this.code = code;
  }
}

export function requireSetting(environment, name) {
  const value = environment[name];
  if (!value || value.startsWith("REPLACE_ME"))
    throw new AnalyticsToolError(`MISSING_${name}`);
  return value;
}

export function validateEnvironment(environment, selected) {
  if (
    !["synthetic", "pilot", "production"].includes(selected) ||
    environment.ANALYTICS_TASK_ENV !== selected
  )
    throw new AnalyticsToolError("EXPLICIT_ENVIRONMENT_REQUIRED");
  return selected;
}

/** No .env discovery and no implicit process/Production configuration. */
export async function readPrivateConfig(filename, selected) {
  if (!filename || !path.isAbsolute(filename))
    throw new AnalyticsToolError("PRIVATE_CONFIG_REQUIRED");
  const info = await lstat(filename);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    info.size > 65536
  )
    throw new AnalyticsToolError("PRIVATE_CONFIG_PERMISSIONS");
  const environment = parseEnv(await readFile(filename, "utf8"));
  validateEnvironment(environment, selected);
  return environment;
}

export function umamiOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new AnalyticsToolError("UMAMI_ORIGIN_INVALID");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["", "/"].includes(url.pathname)
  )
    throw new AnalyticsToolError("UMAMI_LOOPBACK_ORIGIN_REQUIRED");
  return url.origin;
}

export function uuid(value) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  )
    throw new AnalyticsToolError("UMAMI_ID_INVALID");
  return value;
}

export function boundedText(value, maximum) {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < 1 ||
    value.length > maximum ||
    [...value].some((character) => character.codePointAt(0) < 32)
  )
    throw new AnalyticsToolError("CONFIGURATION_TEXT_INVALID");
  return value;
}
