import type {
  CatalogDetail,
  CatalogId,
  PublishingMediaItem,
} from "@moya/contracts";

export type ArticleMediaResolution<Value> =
  | { readonly state: "loading" }
  | { readonly state: "ready"; readonly value: Value }
  | { readonly state: "unavailable" };

const loading = { state: "loading" } as const;
const unavailable = { state: "unavailable" } as const;

/** Internal editor resource: one lifetime, immutable account/epoch, no public DTO. */
export interface ArticleMediaResolver {
  readonly subscribe: (listener: () => void) => () => void;
  readonly version: () => number;
  readonly current: () => boolean;
  readonly managed: (id: string) => Promise<PublishingMediaItem | null>;
  readonly catalog: (id: CatalogId) => Promise<CatalogDetail | null>;
  readonly peekManaged: (
    id: string,
  ) => ArticleMediaResolution<PublishingMediaItem>;
  readonly peekCatalog: (
    id: CatalogId,
  ) => ArticleMediaResolution<CatalogDetail>;
  readonly refreshReady: () => void;
  readonly dispose: () => void;
}

export const createArticleMediaResolver = (options: {
  readonly ownerId: string;
  readonly epoch: number;
  readonly account: () => string | null;
  readonly accountEpoch: () => number;
  readonly readyItems: () => ReadonlyMap<string, PublishingMediaItem>;
  readonly readManaged: (
    id: string,
    signal: AbortSignal,
  ) => Promise<PublishingMediaItem>;
  readonly readCatalog: (
    id: CatalogId,
    signal: AbortSignal,
  ) => Promise<CatalogDetail | null>;
}): ArticleMediaResolver => {
  let disposed = false;
  let revision = 0;
  const listeners = new Set<() => void>();
  const managed = new Map<
    string,
    ArticleMediaResolution<PublishingMediaItem>
  >();
  const catalogs = new Map<CatalogId, ArticleMediaResolution<CatalogDetail>>();
  const managedReads = new Map<string, Promise<PublishingMediaItem | null>>();
  const catalogReads = new Map<CatalogId, Promise<CatalogDetail | null>>();
  const controllers = new Set<AbortController>();
  const current = () =>
    !disposed &&
    options.account() === options.ownerId &&
    options.accountEpoch() === options.epoch;
  const emit = () => {
    revision++;
    for (const listener of listeners) listener();
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const controller of controllers) controller.abort();
    controllers.clear();
    managed.clear();
    catalogs.clear();
    managedReads.clear();
    catalogReads.clear();
    emit();
    listeners.clear();
  };
  const admitted = () => {
    if (current()) return true;
    dispose();
    return false;
  };
  const readyItem = (id: string) => {
    const value = options.readyItems().get(id);
    return value?.id === id &&
      value.state === "ready" &&
      value.media !== null &&
      value.presentation !== null
      ? value
      : null;
  };
  const resolver: ArticleMediaResolver = {
    subscribe: (listener) => {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    version: () => revision,
    current,
    peekManaged: (id) => {
      if (!current()) return unavailable;
      const ready = readyItem(id);
      return ready === null
        ? (managed.get(id) ?? loading)
        : { state: "ready", value: ready };
    },
    peekCatalog: (id) =>
      current() ? (catalogs.get(id) ?? loading) : unavailable,
    refreshReady: () => {
      if (!admitted()) return;
      let changed = false;
      for (const [id, value] of options.readyItems()) {
        if (readyItem(id) === null) continue;
        const previous = managed.get(id);
        if (previous?.state === "ready" && previous.value === value) continue;
        managed.set(id, { state: "ready", value });
        changed = true;
      }
      if (changed) emit();
    },
    managed: (id) => {
      if (!admitted()) return Promise.resolve(null);
      const ready = readyItem(id);
      if (ready !== null) return Promise.resolve(ready);
      const entry = managed.get(id);
      if (entry?.state === "ready") return Promise.resolve(entry.value);
      if (entry?.state === "unavailable") return Promise.resolve(null);
      const inflight = managedReads.get(id);
      if (inflight !== undefined) return inflight;
      const abort = new AbortController();
      controllers.add(abort);
      const request = options
        .readManaged(id, abort.signal)
        .then((value) => {
          if (!admitted() || abort.signal.aborted) return null;
          // A page/upload result that arrived meanwhile takes precedence over this read.
          const preferred = readyItem(id) ?? value;
          const valid =
            preferred.id === id &&
            preferred.state === "ready" &&
            preferred.media !== null &&
            preferred.presentation !== null;
          managed.set(
            id,
            valid ? { state: "ready", value: preferred } : unavailable,
          );
          emit();
          return valid ? preferred : null;
        })
        .catch(() => {
          if (admitted() && !abort.signal.aborted) {
            managed.set(id, unavailable);
            emit();
          }
          return null;
        })
        .finally(() => {
          controllers.delete(abort);
          managedReads.delete(id);
        });
      managedReads.set(id, request);
      return request;
    },
    catalog: (id) => {
      if (!admitted()) return Promise.resolve(null);
      const entry = catalogs.get(id);
      if (entry?.state === "ready") return Promise.resolve(entry.value);
      if (entry?.state === "unavailable") return Promise.resolve(null);
      const inflight = catalogReads.get(id);
      if (inflight !== undefined) return inflight;
      const abort = new AbortController();
      controllers.add(abort);
      const request = options
        .readCatalog(id, abort.signal)
        .then((value) => {
          if (!admitted() || abort.signal.aborted) return null;
          const valid = value !== null && value.id === id;
          catalogs.set(id, valid ? { state: "ready", value } : unavailable);
          emit();
          return valid ? value : null;
        })
        .catch(() => {
          if (admitted() && !abort.signal.aborted) {
            catalogs.set(id, unavailable);
            emit();
          }
          return null;
        })
        .finally(() => {
          controllers.delete(abort);
          catalogReads.delete(id);
        });
      catalogReads.set(id, request);
      return request;
    },
    dispose,
  };
  return resolver;
};
