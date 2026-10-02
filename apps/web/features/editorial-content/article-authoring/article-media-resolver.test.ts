import { describe, expect, it, vi } from "vitest";
import type {
  CatalogDetail,
  CatalogId,
  PublishingMediaItem,
} from "@moya/contracts";
import { createArticleMediaResolver } from "./article-media-resolver";

const item = (id = "media-item-synthetic"): PublishingMediaItem => ({
  id,
  kind: "static",
  qualityMode: "standard",
  state: "ready",
  failureCode: null,
  components: [],
  presentation: { width: 4, height: 3 },
  media: { thumbSrc: "/synthetic/thumb", displaySrc: "/synthetic/display" },
});
const catalogId = "catalog-synthetic" as CatalogId;
const detail: CatalogDetail = {
  id: catalogId,
  kind: "inscription",
  title: "合成藏品",
  aliases: [],
  sourceCitations: [],
  media: [],
};
const deferred = <Value>() => {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
const fixture = () => {
  const scope = { account: "A", epoch: 1 };
  const ready = new Map<string, PublishingMediaItem>();
  const readManaged = vi.fn<
    (id: string, signal: AbortSignal) => Promise<PublishingMediaItem>
  >(async () => item());
  const readCatalog = vi.fn<
    (id: CatalogId, signal: AbortSignal) => Promise<CatalogDetail | null>
  >(async () => detail);
  const create = () =>
    createArticleMediaResolver({
      ownerId: scope.account,
      epoch: scope.epoch,
      account: () => scope.account,
      accountEpoch: () => scope.epoch,
      readyItems: () => ready,
      readManaged,
      readCatalog,
    });
  return { scope, ready, readManaged, readCatalog, create };
};

describe("Article account/epoch-scoped media resolver", () => {
  it("uses page/upload-ready items without reading an item endpoint", async () => {
    const f = fixture();
    const value = item();
    f.ready.set(value.id, value);
    const resolver = f.create();
    expect(resolver.peekManaged(value.id)).toEqual({ state: "ready", value });
    expect(await resolver.managed(value.id)).toBe(value);
    expect(f.readManaged).not.toHaveBeenCalled();
    resolver.dispose();
  });
  it("shares managed inflight and cached reads across duplicate references", async () => {
    const f = fixture();
    const pending = deferred<PublishingMediaItem>();
    f.readManaged.mockReturnValue(pending.promise);
    const resolver = f.create();
    const first = resolver.managed(item().id);
    const second = resolver.managed(item().id);
    expect(first).toBe(second);
    expect(f.readManaged).toHaveBeenCalledTimes(1);
    pending.resolve(item());
    await first;
    await resolver.managed(item().id);
    expect(f.readManaged).toHaveBeenCalledTimes(1);
    resolver.dispose();
  });
  it("shares Catalog detail by Catalog ID across media IDs and cards", async () => {
    const f = fixture();
    const pending = deferred<CatalogDetail>();
    f.readCatalog.mockReturnValue(pending.promise);
    const resolver = f.create();
    const first = resolver.catalog(catalogId);
    const second = resolver.catalog(catalogId);
    expect(first).toBe(second);
    pending.resolve(detail);
    await first;
    await resolver.catalog(catalogId);
    expect(f.readCatalog).toHaveBeenCalledTimes(1);
    resolver.dispose();
  });
  it("prefers a ready upload arriving while a fallback read is in flight", async () => {
    const f = fixture();
    const pending = deferred<PublishingMediaItem>();
    f.readManaged.mockReturnValue(pending.promise);
    const resolver = f.create();
    const request = resolver.managed(item().id);
    const newest = {
      ...item(),
      media: { thumbSrc: "/new/thumb", displaySrc: "/new/display" },
    };
    f.ready.set(newest.id, newest);
    resolver.refreshReady();
    pending.resolve(item());
    expect(await request).toBe(newest);
    expect(resolver.peekManaged(newest.id)).toEqual({
      state: "ready",
      value: newest,
    });
    resolver.dispose();
  });
  it("aborts on close and ignores late responses instead of repopulating cache", async () => {
    const f = fixture();
    const pending = deferred<PublishingMediaItem>();
    let signal: AbortSignal | undefined;
    f.readManaged.mockImplementation((_id: string, provided: AbortSignal) => {
      signal = provided;
      return pending.promise;
    });
    const resolver = f.create();
    const request = resolver.managed(item().id);
    resolver.dispose();
    expect(signal?.aborted).toBe(true);
    pending.resolve(item());
    expect(await request).toBeNull();
    expect(resolver.peekManaged(item().id).state).toBe("unavailable");
  });
  it("A→B→A never revives an old epoch cache or accepts its late result", async () => {
    const f = fixture();
    const pending = deferred<PublishingMediaItem>();
    let signal: AbortSignal | undefined;
    f.readManaged.mockImplementation((_id: string, provided: AbortSignal) => {
      signal = provided;
      return pending.promise;
    });
    const old = f.create();
    const request = old.managed(item().id);
    f.scope.account = "B";
    f.scope.epoch++;
    f.ready.clear();
    await old.catalog(catalogId);
    expect(signal?.aborted).toBe(true);
    f.scope.account = "A";
    f.scope.epoch++;
    pending.resolve(item());
    expect(await request).toBeNull();
    expect(old.current()).toBe(false);
    f.readManaged.mockResolvedValue(item());
    const fresh = f.create();
    await fresh.managed(item().id);
    expect(f.readManaged).toHaveBeenCalledTimes(2);
    fresh.dispose();
  });
  it("rejects wrong-identity responses and retries only in a new workspace", async () => {
    const f = fixture();
    f.readManaged.mockResolvedValue(item("foreign"));
    const resolver = f.create();
    expect(await resolver.managed(item().id)).toBeNull();
    await resolver.managed(item().id);
    expect(f.readManaged).toHaveBeenCalledTimes(1);
    resolver.dispose();
  });
});
