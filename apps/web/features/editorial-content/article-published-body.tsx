"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type {
  ArticleDetail,
  ArticleDocument,
  ArticleMediaReference,
  ArticleResolvedReference,
  CatalogId,
  WorkMedia,
} from "@moya/contracts";
import { fetchSameOriginCatalogDetail } from "../../lib/public-api/catalog-detail-client";
import { LivePhotoFrame } from "../publishing/ui/live/live-photo";
import { ArticleRichBody } from "./article-authoring/article-rich-body";
import type { AcademicChapterView } from "../discussion-preview/academic-reader";

/** Resolved public DTOs only: never read private owner-media endpoints. */
export const ArticlePublishedMedia = ({
  media,
  alt,
  active,
}: {
  readonly media: WorkMedia;
  readonly alt: string;
  readonly active: boolean;
}) => {
  const still = (
    <img
      src={media.src}
      alt={alt}
      width={media.width}
      height={media.height}
      loading="lazy"
      decoding="async"
    />
  );
  return media.kind === "live" && media.motionSrc !== undefined ? (
    <LivePhotoFrame
      active={active}
      motion={{ motionSrc: media.motionSrc, hasAudio: media.hasAudio === true }}
    >
      {still}
    </LivePhotoFrame>
  ) : (
    still
  );
};
const CatalogLink = ({
  id,
  onOpen,
}: {
  readonly id: CatalogId;
  readonly onOpen?: (id: CatalogId) => void;
}) => {
  const [title, setTitle] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    setTitle(null);
    setFailed(false);
    void fetchSameOriginCatalogDetail(id, abort.signal)
      .then((value) => {
        if (abort.signal.aborted) return;
        if (value.state === "success") setTitle(value.detail.title);
        else setFailed(true);
      })
      .catch(() => {
        if (!abort.signal.aborted) setFailed(true);
      });
    return () => abort.abort();
  }, [id]);
  if (failed) return <p role="status">藏品已不可用。</p>;
  if (title === null) return <p role="status">正在读取藏品…</p>;
  return onOpen === undefined ? (
    <a href={`/?catalogId=${encodeURIComponent(id)}#detail`}>{title}</a>
  ) : (
    <button type="button" onClick={() => onOpen(id)}>
      {title}
    </button>
  );
};
export const ArticlePublishedBody = ({
  article,
  document = article.document,
  active,
  onOpenCatalog,
}: {
  readonly article: ArticleDetail;
  readonly document?: ArticleDocument;
  readonly active: boolean;
  readonly onOpenCatalog?: (id: CatalogId) => void;
}) => {
  if (document === undefined) return null;
  const resolutions = new Map<
    ArticleMediaReference,
    ArticleResolvedReference
  >();
  for (const [id, reference] of Object.entries(document.references)) {
    const resolved =
      article.resolvedReferences !== undefined &&
      Object.hasOwn(article.resolvedReferences, id)
        ? article.resolvedReferences[id]
        : undefined;
    if (resolved !== undefined) resolutions.set(reference, resolved);
  }
  return (
    <ArticleRichBody
      document={document}
      renderMedia={(reference, alt) => {
        const resolved = resolutions.get(reference);
        if (resolved === undefined || resolved.type === "unavailable")
          return <p role="status">图片已不可用。</p>;
        return resolved.type === "managed" ? (
          <ArticlePublishedMedia
            media={resolved.media}
            alt={alt}
            active={active}
          />
        ) : (
          <img
            src={resolved.media.src}
            alt={alt || resolved.media.alt}
            width={resolved.media.width}
            height={resolved.media.height}
            loading="lazy"
            decoding="async"
          />
        );
      }}
      renderCatalog={(id) => (
        <CatalogLink
          id={id}
          {...(onOpenCatalog === undefined ? {} : { onOpen: onOpenCatalog })}
        />
      )}
    />
  );
};

/** Keep the existing academic chapter rail, while canonical blocks retain semantics. */
export const articleRichChapters = (
  document: ArticleDocument,
  render: (document: ArticleDocument) => ReactNode,
): readonly AcademicChapterView[] => {
  const groups: {
    title: string;
    headingId: string | null;
    blocks: ArticleDocument["blocks"];
  }[] = [];
  for (const block of document.blocks) {
    if (block.type === "heading" && block.props.level === 2) {
      const title = block.content
        .map((part) =>
          part.type === "text"
            ? part.text
            : part.content.map((span) => span.text).join(""),
        )
        .join("");
      groups.push({
        title: title || "未命名小节",
        headingId: `article-block-${block.id}`,
        blocks: [block],
      });
    } else {
      if (groups.length === 0)
        groups.push({ title: "正文", headingId: null, blocks: [] });
      groups.at(-1)!.blocks.push(block);
    }
  }
  return groups.map((group, index) => {
    const headingId = group.headingId ?? `article-introduction-${index}`;
    return {
      title: group.title,
      paragraphs: [],
      headingId,
      richContent: (
        <>
          {group.headingId === null ? (
            <h3 id={headingId} tabIndex={-1}>
              {group.title}
            </h3>
          ) : null}
          {render({ ...document, blocks: group.blocks })}
        </>
      ),
    };
  });
};
