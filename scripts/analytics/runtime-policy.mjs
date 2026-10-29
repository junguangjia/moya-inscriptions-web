import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import {
  AnalyticsToolError,
  UMAMI_WORKSPACE_IDENTITY,
  UMAMI_VISITOR_DEVICE_SHA256,
  UMAMI_PROVINCE_FALLBACK_SHA256,
  UMAMI_POSTGRES_TIMEZONE,
  UMAMI_SOURCE_COMMIT,
} from "./common.mjs";

export const COMPATIBILITY_POLICY = "ui-pre365-v1";
const legacyProvince =
  "ee0442474fe367cd426f58ffc7f253320b58f550395c8104419567078acaf8f2";
const directory = new URL("../../infra/production/umami/", import.meta.url);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The default path never reads compatibility inputs or changes its recipe. */
export function runtimePolicy(value) {
  if (value === undefined || value === "current") {
    return {
      id: "current",
      dockerfile: "Dockerfile",
      workspaceIdentitySha256: UMAMI_WORKSPACE_IDENTITY,
      visitorDevicePatchSha256: UMAMI_VISITOR_DEVICE_SHA256,
      provinceFallbackSha256: UMAMI_PROVINCE_FALLBACK_SHA256,
      postgresTimeZone: UMAMI_POSTGRES_TIMEZONE,
    };
  }
  if (value !== COMPATIBILITY_POLICY)
    throw new AnalyticsToolError("RUNTIME_POLICY_INVALID");
  try {
    const bytes = readFileSync(new URL("ui-pre365-v1-source.json", directory));
    const metadata = JSON.parse(bytes);
    if (
      metadata.version !== 1 ||
      metadata.id !== COMPATIBILITY_POLICY ||
      metadata.baselineCommit !== "9d542f1a1852ec1b4e8f1d31dcbcdc22b353be28" ||
      metadata.sourceCommit !== UMAMI_SOURCE_COMMIT ||
      metadata.workspaceIdentitySha256 !== UMAMI_WORKSPACE_IDENTITY ||
      metadata.provincePatchSha256 !== legacyProvince ||
      metadata.postgresTimeZone !== "inherit" ||
      metadata.imageEnvironmentPolicy?.PGOPTIONS !== "absent" ||
      metadata.imageEnvironmentPolicy?.TZ !== "absent"
    )
      throw new Error("MISMATCH");
    for (const [file, expected] of [
      ["ui-pre365-v1-province.patch", metadata.provincePatchSha256],
      ["ui-pre365-v1-province.sha256", metadata.provincePatchedHashesSha256],
      ["ui-pre365-v1-protected.sha256", metadata.protectedInventorySha256],
      ["ui-pre365-v1-verify.mjs", metadata.verifierSha256],
    ]) {
      if (
        !/^[a-f0-9]{64}$/u.test(expected) ||
        digest(readFileSync(new URL(file, directory))) !== expected
      )
        throw new Error("MISMATCH");
    }
    return {
      id: COMPATIBILITY_POLICY,
      dockerfile: "Dockerfile.ui-pre365-v1",
      workspaceIdentitySha256: metadata.workspaceIdentitySha256,
      visitorDevicePatchSha256: UMAMI_VISITOR_DEVICE_SHA256,
      provinceFallbackSha256: legacyProvince,
      postgresTimeZone: "inherit",
      businessSourceBaseline: metadata.baselineCommit,
      protectedInventorySha256: metadata.protectedInventorySha256,
      verifierSha256: metadata.verifierSha256,
      manifestSha256: digest(bytes),
    };
  } catch {
    throw new AnalyticsToolError("COMPATIBILITY_INPUT_IDENTITY_INVALID");
  }
}
