import type { CatalogMediaProjection } from "../catalog-read-projections.js";
import type { MediaId } from "@moya/contracts";

export interface StorageMediaLocator {
  readonly mediaId: MediaId;
  readonly objectKey: string;
}

export type ResolvedMediaUrl = string;

/** Application-owned batch boundary between logical object keys and runtime URLs. */
export interface StorageUrlResolver {
  /** App rendition facts for exact CMS-published source pairs. No original I/O. */
  catalogFacts?(
    locators: readonly StorageMediaLocator[],
  ): Promise<
    ReadonlyMap<
      string,
      Pick<CatalogMediaProjection, "renditions" | "placeholderColor">
    >
  >;
  resolveMany(
    locators: readonly StorageMediaLocator[],
  ): Promise<ReadonlyMap<MediaId, ResolvedMediaUrl>>;
  /**
   * Delivery URLs of Catalog renditions by their opaque delivery keys
   * (unified media pipeline, CW12). A key the resolver does not deliver is
   * left out; an empty answer (or no method) means rendition delivery is off,
   * and readers keep the approved image's `src`. A failed batch fails the
   * read, as with `resolveMany`.
   */
  resolveKeys?(
    keys: readonly string[],
  ): Promise<ReadonlyMap<string, ResolvedMediaUrl>>;
}
