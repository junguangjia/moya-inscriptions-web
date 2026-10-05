import { parseRuntimeConfig } from "@moya/backend-runtime";
import type { RuntimeConfig, RuntimeEnvironment } from "@moya/backend-runtime";

const renditionId = /^media-rendition-[0-9a-f]{32}$/u;

/**
 * Development uses Payload's existing file route and native local storage.
 * Catalog renditions (unified media pipeline, PR 1b) are delivered by the
 * Backend's own Development route, named on its loopback listener
 * (`listen`, the parsed runtime configuration by default):
 * `http://127.0.0.1:<port>/v1/development/catalog-renditions/<rendition id>`.
 * The Web relays that exact shape same-origin in Development.
 */
export function createLocalStorageUrlResolver(
  environment: RuntimeEnvironment,
  listen?: Pick<RuntimeConfig, "host" | "port">,
) {
  if (
    environment.NODE_ENV !== "development" ||
    environment.CMS_ENVIRONMENT !== "synthetic" ||
    environment.CMS_STORAGE_MODE !== "local"
  )
    throw new Error("Local media requires synthetic development storage");
  let origin: URL;
  try {
    origin = new URL(environment.PUBLIC_MEDIA_BASE_URL ?? "");
  } catch {
    throw new Error("Invalid local media origin");
  }
  if (
    origin.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new Error("Invalid local media origin");
  const mediaOrigin = origin.origin;
  const backend = listen ?? parseRuntimeConfig(environment);
  if (
    backend.host !== "127.0.0.1" ||
    !Number.isSafeInteger(backend.port) ||
    backend.port < 1 ||
    backend.port > 65_535
  )
    throw new Error("Local media requires an IPv4 loopback Backend listener");
  const renditionOrigin = `http://127.0.0.1:${backend.port}`;
  return {
    async resolveMany<MediaIdentity extends string>(
      locators: readonly {
        readonly mediaId: MediaIdentity;
        readonly objectKey: string;
      }[],
    ): Promise<ReadonlyMap<MediaIdentity, string>> {
      const result = new Map<MediaIdentity, string>();
      for (const locator of locators) {
        // Local uploads already use hashed CatalogId / MediaId / byte SHA keys.
        // Never turn arbitrary object keys or filesystem paths into URLs.
        const match =
          /^editorial\/[a-f0-9]{64}\/([a-f0-9]{64}-[a-f0-9]{64}\.(?:jpg|png|webp))$/.exec(
            locator.objectKey,
          );
        if (!match) throw new Error("Invalid local media object key");
        result.set(
          locator.mediaId,
          `${mediaOrigin}/api/media/file/${match[1]!}`,
        );
      }
      return result;
    },
    /**
     * Each Catalog rendition id becomes its Development delivery URL; any
     * other key (never a storage key or path) is left out.
     */
    async resolveKeys(
      keys: readonly string[],
    ): Promise<ReadonlyMap<string, string>> {
      const result = new Map<string, string>();
      for (const key of keys)
        if (renditionId.test(key))
          result.set(
            key,
            `${renditionOrigin}/v1/development/catalog-renditions/${key}`,
          );
      return result;
    },
  };
}
