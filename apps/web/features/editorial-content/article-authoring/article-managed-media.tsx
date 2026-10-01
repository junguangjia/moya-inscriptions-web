"use client";

import { useEffect, useSyncExternalStore } from "react";
import type {
  ArticleMediaReference,
  CatalogId,
  PublishingMediaItem,
} from "@moya/contracts";
import { LivePhotoFrame } from "../../publishing/ui/live/live-photo";
import type { ArticleMediaResolver } from "./article-media-resolver";
import styles from "./article-media.module.css";

export const ArticleManagedMedia = ({
  item,
  alt,
  active,
}: {
  readonly item: PublishingMediaItem;
  readonly alt: string;
  readonly active: boolean;
}) => {
  if (
    item.state !== "ready" ||
    item.media === null ||
    item.presentation === null
  )
    return <p role="status">素材尚未就绪或已不可用。</p>;
  const still = (
    <img
      alt={alt}
      src={item.media.displaySrc}
      width={item.presentation.width}
      height={item.presentation.height}
      decoding="async"
      loading="lazy"
    />
  );
  return item.kind === "live" && item.media.motionSrc !== undefined ? (
    <LivePhotoFrame
      active={active}
      motion={{
        motionSrc: item.media.motionSrc,
        hasAudio: item.presentation.hasAudio === true,
      }}
    >
      {still}
    </LivePhotoFrame>
  ) : (
    still
  );
};

export const ArticleReferencedMedia = ({
  resolver,
  reference,
  alt,
  active,
}: {
  readonly resolver: ArticleMediaResolver;
  readonly active: boolean;
  readonly reference: ArticleMediaReference;
  readonly alt: string;
}) => {
  useSyncExternalStore(resolver.subscribe, resolver.version, resolver.version);
  const kind = reference.type;
  const id =
    reference.type === "managed" ? reference.itemId : reference.catalogId;
  useEffect(() => {
    if (kind === "managed") void resolver.managed(id);
    else void resolver.catalog(id as CatalogId);
    // Consumers never abort a shared request; the workspace owns its lifetime.
  }, [resolver, kind, id]);
  if (reference.type === "managed") {
    const item = resolver.peekManaged(reference.itemId);
    return item.state === "loading" ? (
      <p role="status">正在读取图片…</p>
    ) : item.state === "unavailable" ? (
      <p role="status">素材无法读取，请重新选择。</p>
    ) : (
      <ArticleManagedMedia item={item.value} alt={alt} active={active} />
    );
  }
  const catalog = resolver.peekCatalog(reference.catalogId);
  if (catalog.state === "loading")
    return <p role="status">正在读取藏品图片…</p>;
  if (catalog.state === "unavailable")
    return <p role="status">素材无法读取，请重新选择。</p>;
  const media = catalog.value.media.find(
    (candidate) => candidate.id === reference.mediaId,
  );
  return media === undefined ? (
    <p role="status">藏品图片已不可用。</p>
  ) : (
    <img
      alt={alt || media.alt}
      src={media.src}
      width={media.width}
      height={media.height}
      decoding="async"
      loading="lazy"
    />
  );
};

export const ArticleCatalogReference = ({
  resolver,
  id,
  onOpen,
}: {
  readonly resolver: ArticleMediaResolver;
  readonly id: CatalogId;
  readonly onOpen: (id: CatalogId) => void;
}) => {
  useSyncExternalStore(resolver.subscribe, resolver.version, resolver.version);
  useEffect(() => {
    void resolver.catalog(id);
  }, [resolver, id]);
  const result = resolver.peekCatalog(id);
  if (result.state === "unavailable")
    return <p role="status">藏品已不可用。</p>;
  if (result.state === "loading") return <p role="status">正在读取藏品…</p>;
  const value = result.value;
  return (
    <button
      type="button"
      className={styles.catalogCard}
      onClick={() => onOpen(id)}
    >
      {value.representativeMedia === undefined ? null : (
        <img
          alt=""
          src={value.representativeMedia.src}
          loading="lazy"
          decoding="async"
        />
      )}
      <span>{value.title}</span>
    </button>
  );
};
