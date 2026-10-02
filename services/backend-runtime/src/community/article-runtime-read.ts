import {
  ArticleAuthoringService,
  CatalogReadService,
  CommunityInputError,
  CommunityNotFoundError,
  CommunityStoreUnavailableError,
  parseCatalogSearchQuery,
} from "@moya/api";
import type {
  ArticleAuthoringPort,
  ArticleAuthoringServiceOptions,
  CatalogQueryPort,
  CatalogSearchQueryPort,
  PublishingMediaStorePort,
  PublishingMediaReadTarget,
  StorageUrlResolver,
} from "@moya/api";
import type { ArticleMcpDependencies } from "./article-mcp.js";

/** The application and delegated transport share this exact service instance. */
export const createArticleAuthoringService = (
  port: ArticleAuthoringPort,
  options: ArticleAuthoringServiceOptions = {},
) => new ArticleAuthoringService(port, options);

/** Existing public Catalog service; caller keeps its current delegated actor fence open. */
export const createArticleCatalogReadCallbacks = (
  port: CatalogQueryPort & CatalogSearchQueryPort,
  storage: StorageUrlResolver,
) => {
  const service = new CatalogReadService(port, storage, port);
  return {
    discoverCatalog: (
      input: Parameters<ArticleMcpDependencies["discoverCatalog"]>[1],
    ) => {
      if (
        input.cursor !== undefined &&
        (!/^[1-9][0-9]{0,3}$/u.test(input.cursor) ||
          Number(input.cursor) > 1000)
      )
        throw new CommunityInputError("article_catalog_cursor_invalid");
      return service.search(
        parseCatalogSearchQuery({
          q: input.query,
          page: input.cursor ?? "1",
          pageSize: String(input.pageSize),
        }),
      );
    },
    readCatalog: (id: Parameters<ArticleMcpDependencies["readCatalog"]>[1]) =>
      service.getById(id),
  };
};
export const ARTICLE_THUMBNAIL_MAX_BYTES = 512 * 1024;
/** Only a bounded committed thumbnail derivative; no original/legacy-still fallback. */
export const readBoundedArticleThumbnail = async (
  store: PublishingMediaStorePort | undefined,
  resolve: () => Promise<PublishingMediaReadTarget | null>,
): Promise<{ bytes: Uint8Array; mimeType: "image/webp" }> => {
  if (store === undefined) throw new CommunityStoreUnavailableError();
  const target = await resolve();
  if (
    target === null ||
    target.contentType !== "image/webp" ||
    target.byteSize > ARTICLE_THUMBNAIL_MAX_BYTES
  )
    throw new CommunityNotFoundError();
  const read = await store.openRead(target.storageKey);
  if (read === null || read.status !== "ok") throw new CommunityNotFoundError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (
      read.byteSize !== target.byteSize ||
      read.contentLength !== target.byteSize ||
      read.start !== 0 ||
      read.end !== target.byteSize - 1
    )
      throw new CommunityNotFoundError();
    const collect = async () => {
      let size = 0;
      const parts: Uint8Array[] = [];
      for await (const chunk of read.body) {
        size += chunk.byteLength;
        if (size > ARTICLE_THUMBNAIL_MAX_BYTES || size > target.byteSize)
          throw new CommunityNotFoundError();
        parts.push(chunk);
      }
      if (size !== target.byteSize) throw new CommunityNotFoundError();
      const bytes = Buffer.concat(parts);
      if (
        bytes.length < 12 ||
        bytes.toString("ascii", 0, 4) !== "RIFF" ||
        bytes.toString("ascii", 8, 12) !== "WEBP" ||
        bytes.readUInt32LE(4) + 8 !== bytes.length
      )
        throw new CommunityNotFoundError();
      return { bytes, mimeType: "image/webp" as const };
    };
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        void read.close().catch(() => undefined);
        reject(new CommunityStoreUnavailableError());
      }, 5000);
    });
    return await Promise.race([collect(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await read.close().catch(() => undefined);
  }
};
