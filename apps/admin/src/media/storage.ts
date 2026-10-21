import { s3Storage } from "@payloadcms/storage-s3";
import type { CollectionAfterChangeHook, Plugin } from "payload";

const computedFields = ["url", "thumbnailURL", "sizes", "focalX", "focalY"];

/** Keep the native adapter's metadata echo out of the ordinary media input API. */
function preserveOriginalMediaGuards(storagePlugin: Plugin): Plugin {
  return async (incoming) => {
    const invalid = (): never => {
      throw new Error("EDITORIAL_STORAGE_HOOK_SHAPE_INVALID");
    };
    const originals = (incoming.collections ?? []).filter(
      (collection) => collection.slug === "media",
    );
    if (originals.length !== 1) invalid();
    const original = originals[0]!;
    const upload = original.upload;
    if (
      !upload ||
      typeof upload !== "object" ||
      upload.crop !== false ||
      upload.focalPoint !== false ||
      (upload.imageSizes !== undefined &&
        (!Array.isArray(upload.imageSizes) ||
          upload.imageSizes.length !== 0)) ||
      upload.resizeOptions != null ||
      upload.formatOptions != null ||
      upload.trimOptions != null ||
      upload.constructorOptions != null ||
      upload.withMetadata != null
    )
      invalid();
    const priorHooks = [...(original.hooks?.afterChange ?? [])];
    const result = await storagePlugin(incoming);
    const targets = (result.collections ?? []).filter(
      (collection) => collection.slug === "media",
    );
    if (targets.length !== 1) invalid();
    const target = targets[0]!;
    const hooks = target.hooks?.afterChange ?? [];
    if (
      hooks.length !== priorHooks.length + 1 ||
      priorHooks.some((hook, index) => hooks[index] !== hook) ||
      typeof hooks.at(-1) !== "function"
    )
      invalid();
    const nativeHook = hooks.at(-1)!;
    const wrappedHook: CollectionAfterChangeHook = async (args) => {
      // The document already passed the media guards. S3 returns that whole
      // document as metadata; its computed URLs must not become update input.
      const originalDoc = args.doc;
      const metadataDoc = { ...originalDoc };
      for (const field of computedFields) delete metadataDoc[field];
      const updated = await nativeHook({ ...args, doc: metadataDoc });
      if (!updated || typeof updated !== "object") return updated;
      const response = { ...updated };
      for (const field of computedFields)
        if (Object.hasOwn(originalDoc, field))
          response[field] = originalDoc[field];
      return response;
    };
    return {
      ...result,
      collections: (result.collections ?? []).map((collection) =>
        collection === target
          ? {
              ...collection,
              hooks: {
                ...collection.hooks,
                afterChange: [...priorHooks, wrappedHook],
              },
            }
          : collection,
      ),
    };
  };
}

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
  return preserveOriginalMediaGuards(
    s3Storage({
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
    }),
  );
}
