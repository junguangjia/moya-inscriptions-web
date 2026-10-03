import { s3Storage } from "@payloadcms/storage-s3";
import type { Plugin } from "payload";

/** Provider credentials remain server-only. This config is not COS acceptance evidence. */
export function createEditorialStoragePlugin(
  environment: NodeJS.ProcessEnv = process.env,
): Plugin {
  const mode = environment.CMS_STORAGE_MODE ?? "local";
  if (mode === "local") {
    // Keep the schema identical to COS mode while preserving synthetic local storage.
    return s3Storage({
      enabled: false,
      alwaysInsertFields: true,
      collections: { media: true },
      bucket: "disabled",
      config: {},
    });
  }
  if (mode !== "cos") throw new Error("CMS_STORAGE_MODE_INVALID");
  const required = [
    "CMS_COS_ENDPOINT",
    "CMS_COS_REGION",
    "CMS_COS_BUCKET",
    "CMS_COS_ACCESS_KEY_ID",
    "CMS_COS_SECRET_ACCESS_KEY",
  ] as const;
  for (const field of required)
    if (!environment[field])
      throw new Error(`CMS_STORAGE_FIELD_REQUIRED:${field}`);
  let endpoint: URL;
  try {
    endpoint = new URL(environment.CMS_COS_ENDPOINT!);
  } catch {
    throw new Error("CMS_STORAGE_ENDPOINT_INVALID");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/"
  )
    throw new Error("CMS_STORAGE_ENDPOINT_INVALID");
  return s3Storage({
    // Enabled storage needs an explicit prefix to register the existing DB
    // field. Individual documents retain their own non-composite prefixes.
    collections: { media: { prefix: "", signedDownloads: false } },
    bucket: environment.CMS_COS_BUCKET!,
    clientCacheKey: `editorial:${environment.CMS_COS_BUCKET}:${environment.CMS_COS_ENDPOINT}`,
    clientUploads: false,
    signedDownloads: false,
    alwaysInsertFields: true,
    config: {
      endpoint: endpoint.origin,
      region: environment.CMS_COS_REGION!,
      credentials: {
        accessKeyId: environment.CMS_COS_ACCESS_KEY_ID!,
        secretAccessKey: environment.CMS_COS_SECRET_ACCESS_KEY!,
      },
      // COS requires virtual-host addressing; path-style examples for other S3 providers do not apply.
      forcePathStyle: false,
      maxAttempts: 3,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    },
  });
}
