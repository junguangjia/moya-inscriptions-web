import type {
  ResolvedMediaUrl,
  StorageMediaLocator,
  StorageUrlResolver,
} from "@moya/api";
import type { MediaId } from "@moya/contracts";

/** Deterministic backend resolver for explicit test/development mappings. */
export class MappedStorageUrlResolver implements StorageUrlResolver {
  constructor(
    private readonly urlsByObjectKey: ReadonlyMap<string, ResolvedMediaUrl>,
    /** Rendition delivery URLs by opaque delivery key; none by default. */
    private readonly urlsByDeliveryKey: ReadonlyMap<
      string,
      ResolvedMediaUrl
    > = new Map(),
  ) {}

  async resolveMany(
    locators: readonly StorageMediaLocator[],
  ): Promise<ReadonlyMap<MediaId, ResolvedMediaUrl>> {
    const resolved = new Map<MediaId, ResolvedMediaUrl>();
    for (const locator of locators) {
      const url = this.urlsByObjectKey.get(locator.objectKey);
      if (url !== undefined) resolved.set(locator.mediaId, url);
    }
    return resolved;
  }

  /** Mapped keys only; an unmapped key is left out. */
  async resolveKeys(
    keys: readonly string[],
  ): Promise<ReadonlyMap<string, ResolvedMediaUrl>> {
    const resolved = new Map<string, ResolvedMediaUrl>();
    for (const key of keys) {
      const url = this.urlsByDeliveryKey.get(key);
      if (url !== undefined) resolved.set(key, url);
    }
    return resolved;
  }
}

/** Production placeholder that never fabricates a storage-provider URL. */
export class UnconfiguredStorageUrlResolver implements StorageUrlResolver {
  async resolveMany(
    locators: readonly StorageMediaLocator[],
  ): Promise<ReadonlyMap<MediaId, ResolvedMediaUrl>> {
    void locators;
    return new Map();
  }

  /** No rendition delivery: readers keep the approved image. */
  async resolveKeys(
    keys: readonly string[],
  ): Promise<ReadonlyMap<string, ResolvedMediaUrl>> {
    void keys;
    return new Map();
  }
}
