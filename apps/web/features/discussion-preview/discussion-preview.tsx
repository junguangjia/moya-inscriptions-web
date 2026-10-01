"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { Icon } from "@moya/ui";
import { useProductShell } from "../product-shell/product-shell";
import { usePreviewNavigationHistory } from "../shell/use-preview-navigation-history";
import { ArticleReader, PostReader } from "./article-reader";
import { AcademicReader, academicViewFromSpecial } from "./academic-reader";
import { DiscussionCount, Heat } from "./discussion-icons";
import { PreviewAuthorProfile } from "../authors/preview-author-profile";
import {
  previewArticles,
  previewFeed,
  previewSpecials,
  previewTopics,
} from "./preview-data";
import { useDiscussionPreview } from "./preview-context";
import styles from "./discussion-preview.module.css";

function Picture({
  src,
  alt,
  className,
}: {
  src: string;
  alt: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  return failed ? (
    <span
      className={`${className ?? ""} ${styles.imageFallback}`}
      role="img"
      aria-label={alt}
    >
      图像暂不可用
    </span>
  ) : (
    <img
      className={className}
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

export function DiscussionPreviewFeed({
  feed,
}: {
  feed: "news" | "threads" | "topics";
}) {
  const state = useDiscussionPreview();
  const shell = useProductShell();
  if (!state) return null;
  const open = (id: string, opener: HTMLElement) => {
    state.markRead(id);
    shell.openTopic(id, opener, shell.readActiveScrollTop());
  };
  return (
    <div className={styles.feed} data-discussion-preview-feed={feed}>
      {feed === "news" && (
        <div className={styles.newsList}>
          {previewArticles.map((item, index) => (
            <button
              type="button"
              key={item.id}
              data-topic-id={item.id}
              data-news-layout={index % 3 === 0 ? "large" : "compact"}
              className={styles.newsCard}
              onClick={(event) => open(item.id, event.currentTarget)}
            >
              <Picture src={item.image} alt={item.imageAlt} />
              <span className={styles.newsCopy}>
                <span className={styles.eyebrow}>{item.section}</span>
                <strong>{item.title}</strong>
                <span className={styles.summary}>{item.summary}</span>
                <span className={styles.meta}>
                  {item.author}
                  <span>{item.time} · 约 3 分钟</span>
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
      {feed === "threads" && (
        <ol className={styles.ranking} aria-label="22 条热门话题">
          {previewTopics.map((item, index) => (
            <li key={item.id}>
              <button
                type="button"
                data-topic-id={item.id}
                data-read={state.read.includes(item.id)}
                onClick={(event) => open(item.id, event.currentTarget)}
              >
                <span className={styles.rank} data-top={index < 3}>
                  {index + 1}
                </span>
                <span className={styles.rankCopy}>
                  <strong>{item.title}</strong>
                  <span className={styles.meta}>
                    <Heat value={item.heat} />
                    <DiscussionCount value={item.replies} />
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
      {feed === "topics" && (
        <div className={styles.specialList}>
          {previewSpecials.map((item) => (
            <button
              type="button"
              key={item.id}
              data-topic-id={item.id}
              className={styles.specialCard}
              onClick={(event) => open(item.id, event.currentTarget)}
            >
              <Picture src={item.image} alt="" />
              <span className={styles.specialShade} />
              <span className={styles.specialCopy}>
                <span className={styles.specialCategory}>
                  {item.issue} / {item.category}
                </span>
                <strong>{item.title}</strong>
                <span className={styles.specialSubtitle}>{item.subtitle}</span>
                <span className={styles.specialIntro}>{item.intro}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ArticleContent({
  article,
}: {
  article: (typeof previewArticles)[number];
}) {
  return (
    <>
      <p className={styles.eyebrow}>{article.section}</p>
      <h2 id={`${article.id}-reader-heading`}>{article.title}</h2>
      <p className={styles.byline}>
        {article.author} · {article.time}
      </p>
      <p className={styles.articleLead}>{article.intro}</p>
      <figure>
        <Picture src={article.image} alt={article.imageAlt} />
      </figure>
      {article.paragraphs.map((paragraph, index) =>
        paragraph.length < 16 ? (
          <h3 key={index}>{paragraph}</h3>
        ) : (
          <p key={index}>{paragraph}</p>
        ),
      )}
    </>
  );
}

export function DiscussionPreviewDetail({
  id,
  backButtonRef,
  onClose,
}: {
  id: string;
  backButtonRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const state = useDiscussionPreview()!;
  const consumeCommentLocation = state.consumeCommentLocation;
  const article = previewArticles.find((item) => item.id === id);
  const topic = previewTopics.find((item) => item.id === id);
  const special = previewSpecials.find((item) => item.id === id);
  const queuedCommentLocation =
    state.commentLocation?.topicId === id ? state.commentLocation : null;
  const [commentLocation] = useState(queuedCommentLocation);
  const [child, setChild] = useState<string | null>(() =>
    queuedCommentLocation && queuedCommentLocation.contentId !== id
      ? queuedCommentLocation.contentId
      : null,
  );
  const [compose, setCompose] = useState(false);
  const [expandedDescription, setExpandedDescription] = useState(false);
  const [profileName, setProfileName] = useState<string | null>(null);
  const locatedChild =
    commentLocation !== null &&
    commentLocation.contentId !== id &&
    commentLocation.contentId === child;
  const childDepth = compose || (child && !locatedChild) ? 1 : 0;
  const navigation = usePreviewNavigationHistory({
    depth: childDepth + (profileName !== null ? 1 : 0),
    onBack: (targetDepth) => {
      if (profileName !== null) closeProfile();
      if (targetDepth < childDepth) {
        setCompose(false);
        setChild(null);
      }
    },
  });
  const profileOpener = useRef<HTMLElement | null>(null);
  const openProfile = (name: string) => {
    profileOpener.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setProfileName(name);
  };
  const closeProfile = () => {
    setProfileName(null);
    requestAnimationFrame(() => {
      if (profileOpener.current?.isConnected)
        profileOpener.current.focus({ preventScroll: true });
      else backButtonRef.current?.focus({ preventScroll: true });
    });
  };
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const draftImages = useRef<string[]>([]);
  const releaseDraftImage = useRef(state.releaseImage);
  useEffect(() => {
    if (commentLocation) consumeCommentLocation(commentLocation.token);
  }, [commentLocation, consumeCommentLocation]);
  useEffect(
    () => () => {
      draftImages.current.forEach(releaseDraftImage.current);
    },
    [],
  );
  const updateImages = (next: string[]) => {
    draftImages.current = next;
    setImages(next);
  };
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const detailScroll = useRef<HTMLDivElement>(null);
  const parentScroll = useRef(0);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const childArticle = previewArticles.find((item) => item.id === child);
  const post = (state.posts[id] ?? []).find((item) => item.id === child);
  const openChild = (target: string) => {
    parentScroll.current = detailScroll.current?.scrollTop ?? 0;
    setCompose(false);
    setChild(target);
  };
  useLayoutEffect(() => {
    if (!child && !compose && detailScroll.current)
      detailScroll.current.scrollTop = parentScroll.current;
    backButtonRef.current?.focus({ preventScroll: true });
  }, [child, compose, backButtonRef]);
  useLayoutEffect(() => {
    if (compose) draftRef.current?.focus();
  }, [compose]);
  const back = () => {
    if (!navigation.requestBack()) onClose();
  };
  const title = compose
    ? "参与话题"
    : post
      ? "帖子"
      : article || childArticle
        ? "近闻"
        : topic
          ? "话题"
          : "专题";
  return (
    <>
      <section
        inert={profileName !== null}
        aria-hidden={profileName ? true : undefined}
        style={profileName ? { visibility: "hidden" } : undefined}
        className={styles.overlay}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-discussion-preview-detail={id}
      >
        <header className={styles.detailHeader}>
          <button
            type="button"
            ref={backButtonRef}
            onClick={back}
            aria-label={
              commentLocation
                ? "返回评论消息"
                : compose
                  ? "返回话题"
                  : child
                    ? topic
                      ? "返回话题"
                      : "返回专题"
                    : "返回讨论"
            }
          >
            <Icon name="back" aria-hidden="true" />
          </button>
          <h1>{title}</h1>
          <span />
        </header>
        {compose ? (
          <div className={styles.composePage} data-post-compose="">
            <form
              className={styles.postComposer}
              onSubmit={(event) => {
                event.preventDefault();
                if (!draft.trim()) return;
                state.addPost(id, draft, images);
                setDraft("");
                updateImages([]);
                setCompose(false);
                setNotice("已发布");
              }}
            >
              <label htmlFor="discussion-post-draft">分享你的观察</label>
              <textarea
                id="discussion-post-draft"
                ref={draftRef}
                placeholder="从一个细节、一次经历，或一个问题开始…"
                value={draft}
                maxLength={3000}
                onChange={(event) => setDraft(event.target.value)}
                rows={6}
              />
              <div className={styles.attachmentPreview}>
                {images.map((src, index) => (
                  <span key={src}>
                    <Picture src={src} alt={`待发布图片 ${index + 1}`} />
                    <button
                      type="button"
                      aria-label={`移除图片 ${index + 1}`}
                      onClick={() => {
                        state.releaseImage(src);
                        updateImages(images.filter((item) => item !== src));
                      }}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
              <label className={styles.addImages}>
                <Icon name="image" aria-hidden="true" />
                添加图片（{images.length}/3）
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  multiple
                  onChange={(event) => {
                    const files = Array.from(event.target.files ?? []);
                    event.target.value = "";
                    if (
                      files.length + images.length > 3 ||
                      files.some(
                        (file) =>
                          ![
                            "image/jpeg",
                            "image/png",
                            "image/webp",
                            "image/gif",
                          ].includes(file.type) || file.size > 10 * 1024 * 1024,
                      )
                    ) {
                      setError(
                        "最多 3 张图片，每张不超过 10MB，支持 JPG、PNG、WebP 和 GIF。",
                      );
                      return;
                    }
                    setError("");
                    const added = files.map(state.createImage);
                    updateImages([...images, ...added]);
                  }}
                />
              </label>
              {error && <p role="alert">{error}</p>}
              <div className={styles.composerActions}>
                <span>{draft.length}/3000</span>
                <button type="submit" disabled={!draft.trim()}>
                  发布帖子
                </button>
              </div>
            </form>
          </div>
        ) : article || childArticle ? (
          <ArticleReader
            key={(article ?? childArticle)!.id}
            id={(article ?? childArticle)!.id}
            {...(commentLocation?.contentId === (article ?? childArticle)!.id
              ? { highlightCommentId: commentLocation.commentId }
              : {})}
            onOpenProfile={openProfile}
          >
            <ArticleContent article={(article ?? childArticle)!} />
          </ArticleReader>
        ) : post ? (
          <PostReader
            id={post.id}
            {...(commentLocation?.contentId === post.id
              ? { highlightCommentId: commentLocation.commentId }
              : {})}
            onOpenProfile={openProfile}
          >
            <article className={styles.article}>
              <p className={styles.eyebrow}>参与话题</p>
              <h2 className={styles.postTopicTitle}>{topic?.title}</h2>
              <p className={styles.byline}>
                {post.author} · {post.time}
              </p>
              <div className={styles.postText}>{post.text}</div>
              <div className={styles.postGallery}>
                {post.images.map((src) => (
                  <Picture
                    key={src}
                    src={src}
                    alt={`${post.author}分享的图片`}
                  />
                ))}
              </div>
            </article>
          </PostReader>
        ) : special ? (
          <ArticleReader
            key={special.id}
            id={special.id}
            {...(commentLocation?.contentId === special.id
              ? { highlightCommentId: commentLocation.commentId }
              : {})}
            onOpenProfile={openProfile}
            renderContent={({ scrollElement, active, overlayTarget }) => (
              <AcademicReader
                article={academicViewFromSpecial(special)}
                scrollElement={scrollElement}
                active={active}
                railPortalTarget={overlayTarget}
              />
            )}
          />
        ) : (
          <div
            className={styles.detailScroll}
            ref={detailScroll}
            data-topic-scroll=""
          >
            {topic && (
              <div className={styles.topicPage}>
                <section className={styles.topicIntro}>
                  <h2>{topic.title}</h2>
                  <p
                    className={styles.topicDescription}
                    data-expanded={expandedDescription}
                  >
                    {topic.description}
                  </p>
                  {topic.description.length > 95 && (
                    <button
                      type="button"
                      className={styles.expandDescription}
                      aria-expanded={expandedDescription}
                      onClick={() => setExpandedDescription((old) => !old)}
                    >
                      {expandedDescription ? "收起" : "展开"}
                    </button>
                  )}
                  <div className={styles.tags}>
                    {topic.tags.map((tag) => (
                      <span key={tag}>{tag}</span>
                    ))}
                  </div>
                  <div className={styles.meta}>
                    <Heat value={topic.heat} />
                    <span>{(state.posts[id] ?? []).length} 篇帖子</span>
                  </div>
                </section>
                <div className={styles.postListHeading}>
                  <h3>交流</h3>
                  <span>最新在前</span>
                </div>
                {notice && (
                  <p role="status" className={styles.notice}>
                    {notice}
                  </p>
                )}
                <div className={styles.posts}>
                  {(state.posts[id] ?? []).map((item) => (
                    <div className={styles.postCard} key={item.id}>
                      <span className={styles.postAuthor}>
                        <button
                          type="button"
                          className={styles.avatar}
                          aria-label={`查看${item.author}的主页`}
                          onClick={() => openProfile(item.author)}
                        >
                          {item.author.slice(0, 1)}
                        </button>
                        <strong>{item.author}</strong>
                        <time>{item.time}</time>
                      </span>
                      <button
                        type="button"
                        className={styles.postRead}
                        onClick={() => openChild(item.id)}
                        aria-label={`阅读${item.author}的帖子`}
                      >
                        <span className={styles.postExcerpt}>{item.text}</span>
                        {item.images.length > 0 && (
                          <span className={styles.postThumbnails}>
                            {item.images.map((src) => (
                              <Picture key={src} src={src} alt="帖子配图" />
                            ))}
                          </span>
                        )}
                        <span className={styles.postMeta}>
                          {state.commentsFor(item.id).length} 条评论
                          <span>展开阅读 →</span>
                        </span>
                      </button>
                    </div>
                  ))}
                </div>
                {!compose && (
                  <div className={styles.topicAction}>
                    <button
                      type="button"
                      onClick={() => {
                        parentScroll.current =
                          detailScroll.current?.scrollTop ?? 0;
                        setCompose(true);
                      }}
                    >
                      <Icon name="edit" aria-hidden="true" />
                      参与话题
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </section>
      {profileName && (
        <PreviewAuthorProfile
          enabled
          name={profileName}
          onClose={() => navigation.requestBack()}
        />
      )}
    </>
  );
}
export { previewFeed };
