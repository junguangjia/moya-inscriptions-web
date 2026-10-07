"use client";
import { editorialImage, editorialMediaSrc } from "./editorial-media";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode, RefObject } from "react";
import { Icon } from "@moya/ui";
import type {
  ArticleCollectionDetail,
  ArticleDetail,
  ArticlePresentation,
  ArticleSummary,
  PublicMedia,
} from "@moya/contracts";
import { MEDIA_SIZES } from "../media/responsive-media";
import { useProductShell } from "../product-shell/product-shell";
import {
  ArticlePublishedBody,
  ArticlePublishedMedia,
  articleRichChapters,
} from "./article-published-body";
import { articleDocumentPlainText } from "../../lib/public-api/article-authoring-client";
import { ArticleReader } from "../discussion-preview/article-reader";
import { AcademicReader } from "../discussion-preview/academic-reader";
import type { AcademicArticleView } from "../discussion-preview/academic-reader";
import styles from "../discussion-preview/discussion-preview.module.css";
import homeStyles from "../home/home-screen.module.css";
import { estimateReadingMinutes, formatEditorialTime } from "./format-time";
import {
  isArticleId,
  listedArticlePresentation,
  useArticle,
  useCollection,
} from "./use-editorial-content";

/**
 * A news reader figure (.article figure img: the column, at most 350px tall,
 * contain fit, so no placeholder colour): rendition candidates and the size
 * reservation of the anchor.
 */
const Picture = ({
  media,
  alt,
  owner,
}: {
  media: PublicMedia;
  alt: string;
  owner: string;
}) => {
  const image = editorialImage(media, owner, MEDIA_SIZES.newsFigure(media));
  return (
    <img
      src={image.src}
      srcSet={image.srcSet}
      sizes={image.sizes}
      alt={alt}
      loading="lazy"
      decoding="async"
      width={media.width}
      height={media.height}
    />
  );
};

const DetailState = ({
  state,
  label,
  onRetry,
}: {
  state: "loading" | "missing" | "unavailable";
  label: string;
  onRetry: () => void;
}) => (
  <section
    className={homeStyles.stateMessage}
    role={state === "unavailable" ? "alert" : "status"}
    data-editorial-state={state}
  >
    <h2>
      {state === "loading"
        ? "正在加载"
        : state === "missing"
          ? `${label}不可见`
          : `${label}暂时不可用`}
    </h2>
    {state === "missing" && <p>该内容未发布、已撤回或不存在。</p>}
    {state === "unavailable" && (
      <button type="button" onClick={onRetry}>
        重试
      </button>
    )}
  </section>
);

export const academicViewFromArticle = (
  article: ArticleDetail,
): AcademicArticleView => ({
  id: article.id,
  category: article.section,
  title: article.title,
  subtitle: article.subtitle,
  byline: article.byline,
  meta: [
    article.issue,
    formatEditorialTime(article.publishedAt),
    `约 ${estimateReadingMinutes(
      article.document === undefined
        ? article.sections.flatMap((section) => section.paragraphs)
        : [articleDocumentPlainText(article.document)],
    )} 分钟`,
  ]
    .filter(Boolean)
    .join(" · "),
  intro: article.intro,
  chapters: article.sections.map((section, index) => ({
    title: section.heading ?? `第 ${index + 1} 节`,
    paragraphs: section.paragraphs,
    figures: section.image
      ? [
          {
            afterParagraph: 0,
            ...editorialImage(
              section.image,
              article.id,
              MEDIA_SIZES.academicFigure(section.image),
            ),
            alt: section.image.alt,
            caption: section.imageCaption ?? section.image.alt,
          },
        ]
      : [],
  })),
  citation: [
    article.citations[0]?.text ??
      `${article.byline}：《${article.title}》，由艺${article.issue ? `，${article.issue}` : ""}。`,
    article.citations.length > 1
      ? article.citations
          .slice(1)
          .map((citation) => citation.text)
          .join("；")
      : null,
  ],
});

function NewsArticleContent({
  article,
  active,
  onOpenCatalog,
}: {
  article: ArticleDetail;
  active: boolean;
  onOpenCatalog: (id: string) => void;
}) {
  return (
    <>
      {article.section && <p className={styles.eyebrow}>{article.section}</p>}
      <h2 id={`${article.id}-reader-heading`}>{article.title}</h2>
      <p className={styles.byline}>
        {article.byline} · {formatEditorialTime(article.publishedAt)}
      </p>
      {article.intro && <p className={styles.articleLead}>{article.intro}</p>}
      {article.managedCover ? (
        <figure>
          <ArticlePublishedMedia
            media={article.managedCover}
            alt=""
            active={active}
          />
        </figure>
      ) : (
        article.cover && (
          <figure>
            <Picture
              owner={article.id}
              media={article.cover}
              alt={article.cover.alt}
            />
          </figure>
        )
      )}
      {article.document === undefined ? (
        article.sections.map((section, index) => (
          <div key={index}>
            {section.heading && <h3>{section.heading}</h3>}
            {section.paragraphs.map((paragraph, paragraphIndex) => (
              <p key={paragraphIndex}>{paragraph}</p>
            ))}
            {section.image && (
              <figure>
                <Picture
                  owner={article.id}
                  media={section.image}
                  alt={section.image.alt}
                />
                {section.imageCaption && (
                  <figcaption>{section.imageCaption}</figcaption>
                )}
              </figure>
            )}
          </div>
        ))
      ) : (
        <ArticlePublishedBody
          article={article}
          active={active}
          onOpenCatalog={onOpenCatalog}
        />
      )}
      {article.citations.length > 0 && (
        <aside aria-label="引用与参考">
          <h3>引用与参考</h3>
          <ol>
            {article.citations.map((citation, index) => (
              <li key={index}>
                {citation.url ? (
                  <a
                    href={citation.url}
                    rel="noreferrer noopener"
                    target="_blank"
                  >
                    {citation.text}
                  </a>
                ) : (
                  citation.text
                )}
              </li>
            ))}
          </ol>
        </aside>
      )}
    </>
  );
}

/** One published Article in the accepted reader; comments arrive through `renderComments`. */
export function LiveArticleReader({
  id,
  highlightCommentId,
  renderComments,
  onPresentation,
  onUnavailable,
}: {
  id: string;
  highlightCommentId?: string;
  renderComments?: (articleId: string) => ReactNode;
  /** Reports the loaded Article's presentation (the overlay's title). */
  onPresentation?: (presentation: ArticlePresentation) => void;
  /** Only a source Article, rather than a child reader, requests shell recovery. */
  onUnavailable?: () => void;
}) {
  const shell = useProductShell();
  const openCatalog = (catalogId: string) =>
    shell.openCatalog(
      catalogId,
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : document.body,
    );
  const { state, retry } = useArticle(id);
  useEffect(() => {
    if (state.state === "missing") onUnavailable?.();
  }, [state.state, onUnavailable]);
  const loadedPresentation =
    state.state === "populated" ? state.item.presentation : null;
  useEffect(() => {
    if (loadedPresentation) onPresentation?.(loadedPresentation);
  }, [loadedPresentation, onPresentation]);
  if (state.state !== "populated")
    return <DetailState state={state.state} label="文章" onRetry={retry} />;
  const article = state.item;
  // The reader always receives an explicit comment slot: the live discussion
  // when composed, otherwise a truthful note. It never falls back to the
  // preview's fixture comments.
  const comments = renderComments ? (
    renderComments(article.id)
  ) : (
    <p
      role="status"
      className={styles.notice}
      data-editorial-comments="pending"
    >
      评论功能尚未接入此文章。
    </p>
  );
  const shared = {
    id: article.id,
    comments,
    ...(highlightCommentId ? { highlightCommentId } : {}),
    onOpenProfile: () => {},
  };
  return article.presentation === "academic" ? (
    <ArticleReader
      key={article.id}
      {...shared}
      renderContent={({ scrollElement, active, overlayTarget }) => (
        <AcademicReader
          article={{
            ...academicViewFromArticle(article),
            ...(article.managedCover
              ? {
                  cover: (
                    <ArticlePublishedMedia
                      media={article.managedCover}
                      alt=""
                      active={active}
                    />
                  ),
                }
              : {}),
            ...(article.document === undefined
              ? {}
              : {
                  chapters: articleRichChapters(
                    article.document,
                    (document) => (
                      <ArticlePublishedBody
                        article={article}
                        document={document}
                        active={active}
                        onOpenCatalog={openCatalog}
                      />
                    ),
                  ),
                }),
          }}
          scrollElement={scrollElement}
          active={active}
          railPortalTarget={overlayTarget}
        />
      )}
    />
  ) : (
    <ArticleReader
      key={article.id}
      {...shared}
      renderContent={({ active }) => (
        <article className={styles.article}>
          <NewsArticleContent
            article={article}
            active={active}
            onOpenCatalog={openCatalog}
          />
        </article>
      )}
    />
  );
}

function CollectionPage({
  id,
  onOpenArticle,
  onUnavailable,
}: {
  id: string;
  onOpenArticle: (article: ArticleSummary) => void;
  onUnavailable?: () => void;
}) {
  const shell = useProductShell();
  const { state, retry } = useCollection(id);
  useEffect(() => {
    if (state.state === "missing") onUnavailable?.();
  }, [state.state, onUnavailable]);
  if (state.state !== "populated")
    return <DetailState state={state.state} label="专题" onRetry={retry} />;
  const collection: ArticleCollectionDetail = state.item;
  return (
    <div className={styles.topicPage} data-editorial-collection={collection.id}>
      <section className={styles.topicIntro}>
        {(collection.issue || collection.category) && (
          <p className={styles.eyebrow}>
            {[collection.issue, collection.category]
              .filter(Boolean)
              .join(" / ")}
          </p>
        )}
        <h2>{collection.title}</h2>
        {collection.subtitle && (
          <p className={styles.byline}>{collection.subtitle}</p>
        )}
        {collection.cover && (
          <figure>
            {/* No CSS rule sizes this image, so it keeps only its source:
                srcset or width and height would change its rendered size. */}
            <img
              src={editorialMediaSrc(collection.cover.src, collection.id)}
              alt={collection.cover.alt}
              loading="lazy"
              decoding="async"
            />
          </figure>
        )}
        {collection.summary && (
          <p className={styles.topicDescription} data-expanded="true">
            {collection.summary}
          </p>
        )}
        <div className={styles.meta}>
          <span>{collection.memberTotal} 篇内容</span>
          <span>{formatEditorialTime(collection.publishedAt)}</span>
        </div>
      </section>
      <div className={styles.postListHeading}>
        <h3>阅读目录</h3>
      </div>
      {collection.members.length === 0 ? (
        <p role="status">此专题暂无已发布内容。</p>
      ) : (
        <ol className={styles.posts} aria-label="专题目录">
          {collection.members.map((member) => (
            <li
              className={styles.postCard}
              key={`${member.kind}-${member.position}`}
            >
              {member.kind === "article" ? (
                <button
                  type="button"
                  className={styles.postRead}
                  onClick={() => onOpenArticle(member.article)}
                  aria-label={`阅读文章 ${member.article.title}`}
                >
                  <span className={styles.postExcerpt}>
                    <strong>{member.article.title}</strong>
                    {member.article.summary && (
                      <span>{member.article.summary}</span>
                    )}
                  </span>
                  <span className={styles.postMeta}>
                    {member.article.byline}
                    <span>展开阅读 →</span>
                  </span>
                </button>
              ) : (
                <button
                  type="button"
                  className={styles.postRead}
                  onClick={(event) =>
                    shell.openContent(
                      { type: "catalog", id: member.record.id },
                      event.currentTarget,
                    )
                  }
                  aria-label={`查看资料 ${member.record.title}`}
                >
                  <span className={styles.postExcerpt}>
                    <strong>{member.record.title}</strong>
                    {member.record.summary && (
                      <span>{member.record.summary}</span>
                    )}
                  </span>
                  <span className={styles.postMeta}>
                    资料记录
                    <span>查看 →</span>
                  </span>
                </button>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/**
 * The topic overlay body for a real editorial id (`article-…` or
 * `collection-…`). Header Back returns from a child Article to its Collection at
 * the saved scroll position, then closes; browser Back closes the overlay
 * through the shell as before.
 */
export function EditorialDetail({
  id,
  backButtonRef,
  onClose,
  renderComments,
  onUnavailable,
}: {
  id: string;
  backButtonRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  renderComments?: (articleId: string) => ReactNode;
  onUnavailable?: () => void;
}) {
  const [child, setChild] = useState<string | null>(null);
  const detailScroll = useRef<HTMLDivElement>(null);
  const parentScroll = useRef(0);
  const isArticle = isArticleId(id);
  const [loaded, setLoaded] = useState<{
    id: string;
    presentation: ArticlePresentation;
  } | null>(null);
  // An academic Article opened from 专题 is titled 专题, a news one 近闻; until
  // either the feed or the detail says which, the neutral 文章.
  const presentation =
    loaded?.id === id ? loaded.presentation : listedArticlePresentation(id);
  const reportPresentation = useCallback(
    (value: ArticlePresentation) =>
      setLoaded((old) =>
        old?.id === id && old.presentation === value
          ? old
          : { id, presentation: value },
      ),
    [id],
  );
  useLayoutEffect(() => {
    if (!child && detailScroll.current)
      detailScroll.current.scrollTop = parentScroll.current;
    backButtonRef.current?.focus({ preventScroll: true });
  }, [child, backButtonRef]);
  const title = isArticle
    ? presentation === "academic"
      ? "专题"
      : presentation === "news"
        ? "近闻"
        : "文章"
    : child
      ? "文章"
      : "专题";
  return (
    <section
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-editorial-detail={id}
    >
      <header className={styles.detailHeader}>
        <button
          type="button"
          ref={backButtonRef}
          onClick={() => (child ? setChild(null) : onClose())}
          aria-label={child ? "返回专题" : "返回讨论"}
        >
          <Icon name="back" aria-hidden="true" />
        </button>
        <h1>{title}</h1>
        <span />
      </header>
      {isArticle ? (
        <LiveArticleReader
          id={id}
          {...(onUnavailable ? { onUnavailable } : {})}
          onPresentation={reportPresentation}
          {...(renderComments ? { renderComments } : {})}
        />
      ) : child ? (
        <LiveArticleReader
          id={child}
          {...(renderComments ? { renderComments } : {})}
        />
      ) : (
        <div
          className={styles.detailScroll}
          ref={detailScroll}
          data-topic-scroll=""
        >
          <CollectionPage
            id={id}
            {...(onUnavailable ? { onUnavailable } : {})}
            onOpenArticle={(article) => {
              parentScroll.current = detailScroll.current?.scrollTop ?? 0;
              setChild(article.id);
            }}
          />
        </div>
      )}
    </section>
  );
}
