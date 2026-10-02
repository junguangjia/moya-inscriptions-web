"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type {
  ArticleMediaReference,
  CatalogId,
  PublishingMediaItem,
  MediaCrop,
} from "@moya/contracts";
import type { DetailMediaPresentation } from "../../detail/catalog-detail-presentation";
import { ArticleImage } from "./article-image";
import { ArticleImageCropDialog } from "./article-image-crop-dialog";
import type { ArticleMediaResolver } from "./article-media-resolver";
import styles from "./article-media.module.css";

export const ArticleManagedMedia = ({
  item,
  alt,
  active,
  crop = null,
  onCrop,
}: {
  readonly item: PublishingMediaItem;
  readonly alt: string;
  readonly active: boolean;
  readonly crop?: MediaCrop | null;
  readonly onCrop?: (crop: MediaCrop | null) => boolean;
}) => {
  if (
    item.state !== "ready" ||
    item.media === null ||
    item.presentation === null
  )
    return <p role="status">素材尚未就绪或已不可用。</p>;
  return (
    <ResolvedImage
      active={active}
      crop={crop}
      {...(onCrop ? { onCrop } : {})}
      media={{
        id: item.id,
        src: item.media.displaySrc,
        alt,
        width: item.presentation.width,
        height: item.presentation.height,
        ...(item.media.fullSrc === undefined
          ? {}
          : { fullSrc: item.media.fullSrc }),
        ...(item.kind === "live" && item.media.motionSrc !== undefined
          ? {
              live: {
                motionSrc: item.media.motionSrc,
                hasAudio: item.presentation.hasAudio === true,
              },
            }
          : {}),
      }}
    />
  );
};

const ResolvedImage = ({
  media,
  active,
  crop,
  onCrop,
}: {
  readonly media: DetailMediaPresentation;
  readonly active: boolean;
  readonly crop: MediaCrop | null;
  readonly onCrop?: (crop: MediaCrop | null) => boolean;
}) => {
  const basis = JSON.stringify([
    media.id,
    media.src,
    media.fullSrc,
    media.width,
    media.height,
    crop,
  ]);
  const current = useRef({ basis, onCrop });
  current.current = { basis, onCrop };
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return onCrop === undefined ? (
    <ArticleImage media={media} active={active} crop={crop} />
  ) : (
    <EditableResolvedImage
      key={basis}
      media={media}
      active={active}
      crop={crop}
      onCrop={(next) =>
        alive.current &&
        current.current.basis === basis &&
        current.current.onCrop?.(next) === true
      }
    />
  );
};

const EditableResolvedImage = ({
  media,
  active,
  crop,
  onCrop,
}: {
  readonly media: DetailMediaPresentation;
  readonly active: boolean;
  readonly crop: MediaCrop | null;
  readonly onCrop: (crop: MediaCrop | null) => boolean;
}) => {
  const [cropping, setCropping] = useState(false);
  return (
    <>
      <ArticleImage
        media={media}
        active={active && !cropping}
        crop={crop}
        onCrop={() => setCropping(true)}
      />
      {cropping ? (
        <ArticleImageCropDialog
          media={media}
          crop={crop}
          onApply={onCrop}
          onCancel={() => setCropping(false)}
        />
      ) : null}
    </>
  );
};

export const ArticleReferencedMedia = ({
  resolver,
  reference,
  alt,
  active,
  crop = null,
  onCrop,
}: {
  readonly resolver: ArticleMediaResolver;
  readonly active: boolean;
  readonly reference: ArticleMediaReference;
  readonly alt: string;
  readonly crop?: MediaCrop | null;
  readonly onCrop?: (crop: MediaCrop | null) => boolean;
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
      <ArticleManagedMedia
        key={reference.itemId}
        item={item.value}
        alt={alt}
        active={active}
        crop={crop}
        {...(onCrop === undefined ? {} : { onCrop })}
      />
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
    <ResolvedImage
      key={`${reference.catalogId}:${reference.mediaId}`}
      media={{ ...media, alt: alt || media.alt }}
      active={active}
      crop={crop}
      {...(onCrop === undefined ? {} : { onCrop })}
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
