// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ArticleDocument,
  ArticleMediaReference,
  CatalogDetail,
  CatalogId,
  PublishingMediaItem,
} from "@moya/contracts";
import {
  ArticleCatalogReference,
  ArticleReferencedMedia,
} from "./article-managed-media";
import { createArticleMediaResolver } from "./article-media-resolver";
import { ArticleRichBody } from "./article-rich-body";

const managedId = "media-item-synthetic";
const catalogId = "catalog-synthetic" as CatalogId;
const value: PublishingMediaItem = {
  id: managedId,
  kind: "static",
  qualityMode: "standard",
  state: "ready",
  failureCode: null,
  components: [],
  presentation: { width: 4, height: 3 },
  media: { thumbSrc: "/synthetic/thumb", displaySrc: "/synthetic/display" },
};
const catalog: CatalogDetail = {
  id: catalogId,
  kind: "inscription",
  title: "合成藏品",
  aliases: [],
  sourceCitations: [],
  media: [1, 2].map((id) => ({
    id: `media-${id}` as CatalogDetail["media"][number]["id"],
    kind: "image" as const,
    src: `/synthetic/catalog-${id}`,
    alt: "合成图片",
    width: 4,
    height: 3,
  })),
};
const deferred = <Value,>() => {
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
  >(async () => value);
  const readCatalog = vi.fn<
    (id: CatalogId, signal: AbortSignal) => Promise<CatalogDetail | null>
  >(async () => catalog);
  const resolver = createArticleMediaResolver({
    ownerId: "A",
    epoch: 1,
    account: () => scope.account,
    accountEpoch: () => scope.epoch,
    readyItems: () => ready,
    readManaged,
    readCatalog,
  });
  return { scope, ready, readManaged, readCatalog, resolver };
};
let root: Root | null = null;
let container: HTMLDivElement | null = null;
const mount = () => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  return root;
};
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("Article shared media rendering", () => {
  it("duplicate instances, recreated references, reorder and semantic preview issue one managed read", async () => {
    const f = fixture();
    const pending = deferred<PublishingMediaItem>();
    f.readManaged.mockReturnValue(pending.promise);
    const mounted = mount();
    const render = (reverse: boolean, preview: boolean) => {
      const refs: ArticleMediaReference[] = [
        { type: "managed", itemId: managedId },
        { type: "managed", itemId: managedId },
      ];
      const document: ArticleDocument = {
        format: "blocknote",
        version: 1,
        blocks: [
          {
            id: "preview",
            type: "managedImage",
            props: { refId: "image", caption: "", alt: "预览" },
            children: [],
          },
        ],
        references: { image: { type: "managed", itemId: managedId } },
        galleries: {},
      };
      return (
        <>
          {(reverse ? refs.toReversed() : refs).map((reference, index) => (
            <ArticleReferencedMedia
              key={index}
              resolver={f.resolver}
              reference={reference}
              alt={`图${index}`}
              active={false}
            />
          ))}
          {preview ? (
            <ArticleRichBody
              document={document}
              renderMedia={(reference, alt) => (
                <ArticleReferencedMedia
                  resolver={f.resolver}
                  reference={reference}
                  alt={alt}
                  active={false}
                />
              )}
              renderCatalog={() => null}
            />
          ) : null}
        </>
      );
    };
    await act(async () => mounted.render(render(false, false)));
    expect(f.readManaged).toHaveBeenCalledTimes(1);
    await act(async () => mounted.render(render(true, true)));
    expect(f.readManaged).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve(value);
      await pending.promise;
    });
    expect(container?.querySelectorAll("img")).toHaveLength(3);
    await act(async () => mounted.render(render(false, true)));
    expect(f.readManaged).toHaveBeenCalledTimes(1);
    f.resolver.dispose();
  });
  it("ready page media renders immediately without a request and a page update refreshes it", async () => {
    const f = fixture();
    f.ready.set(managedId, value);
    const mounted = mount();
    await act(async () =>
      mounted.render(
        <ArticleReferencedMedia
          resolver={f.resolver}
          reference={{ type: "managed", itemId: managedId }}
          alt="页面素材"
          active={false}
        />,
      ),
    );
    expect(f.readManaged).not.toHaveBeenCalled();
    expect(container?.querySelector("img")?.getAttribute("src")).toBe(
      "/synthetic/display",
    );
    await act(async () => {
      f.ready.set(managedId, {
        ...value,
        media: { thumbSrc: "/updated/thumb", displaySrc: "/updated/display" },
      });
      f.resolver.refreshReady();
    });
    expect(container?.querySelector("img")?.getAttribute("src")).toBe(
      "/updated/display",
    );
    await act(async () => f.resolver.dispose());
    expect(container?.querySelector("img")).toBeNull();
  });
  it("two Catalog media and a Catalog card share one detail read, including preview remount", async () => {
    const f = fixture();
    const mounted = mount();
    const content = (preview: boolean) => (
      <>
        {catalog.media.map((media) => (
          <ArticleReferencedMedia
            key={media.id}
            resolver={f.resolver}
            reference={{ type: "catalog", catalogId, mediaId: media.id }}
            alt={media.alt}
            active={false}
          />
        ))}
        <ArticleCatalogReference
          resolver={f.resolver}
          id={catalogId}
          onOpen={() => undefined}
        />
        {preview ? (
          <ArticleCatalogReference
            resolver={f.resolver}
            id={catalogId}
            onOpen={() => undefined}
          />
        ) : null}
      </>
    );
    await act(async () => mounted.render(content(false)));
    expect(f.readCatalog).toHaveBeenCalledTimes(1);
    await act(async () => mounted.render(content(true)));
    expect(f.readCatalog).toHaveBeenCalledTimes(1);
    expect(container?.querySelectorAll("img")).toHaveLength(2);
    await act(async () => f.resolver.dispose());
  });
  it("unmounting one duplicate consumer does not cancel another consumer's shared read", async () => {
    const f = fixture();
    const pending = deferred<PublishingMediaItem>();
    let signal: AbortSignal | undefined;
    f.readManaged.mockImplementation((_id: string, provided: AbortSignal) => {
      signal = provided;
      return pending.promise;
    });
    const mounted = mount();
    const render = (duplicate: boolean) => (
      <>
        <ArticleReferencedMedia
          resolver={f.resolver}
          reference={{ type: "managed", itemId: managedId }}
          alt="保留"
          active={false}
        />
        {duplicate ? (
          <ArticleReferencedMedia
            resolver={f.resolver}
            reference={{ type: "managed", itemId: managedId }}
            alt="关闭"
            active={false}
          />
        ) : null}
      </>
    );
    await act(async () => mounted.render(render(true)));
    await act(async () => mounted.render(render(false)));
    expect(signal?.aborted).toBe(false);
    await act(async () => {
      pending.resolve(value);
      await pending.promise;
    });
    expect(container?.querySelectorAll("img")).toHaveLength(1);
    await act(async () => f.resolver.dispose());
  });
});
