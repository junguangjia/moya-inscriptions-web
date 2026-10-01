"use client";

import { useAuthReturnView } from "../auth/auth-return";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { HorizontalPager } from "../shell/horizontal-pager";
import type { HorizontalPagerHandle } from "../shell/horizontal-pager";
import { useProductShell } from "../product-shell/product-shell";
import { CommentSection } from "../comments/comment-section";
import { CommentComposerPortalProvider } from "../comments/comment-composer-portal";
import { previewSelf, useDiscussionPreview } from "./preview-context";
import styles from "./discussion-preview.module.css";

export function PreviewComments({
  contentId,
  highlightCommentId,
  onOpenProfile,
}: {
  contentId: string;
  highlightCommentId?: string;
  onOpenProfile: (name: string) => void;
}) {
  const state = useDiscussionPreview()!;
  const items = state.commentsFor(contentId);
  return (
    <div className={styles.comments} data-preview-comments={contentId}>
      <CommentSection
        contentKey={contentId}
        currentUser={previewSelf}
        {...(highlightCommentId ? { highlightCommentId } : {})}
        items={items}
        onSendComment={(text) => state.addComment(contentId, text)}
        onSendReply={(target, text) =>
          state.addComment(contentId, text, target)
        }
        onToggleLike={(id, replyId) => state.toggleLike(contentId, id, replyId)}
        onOpenAuthor={(id) => {
          const users = [
            previewSelf,
            ...items.flatMap((item) => [
              item.user,
              ...item.replies.map((reply) => reply.user),
            ]),
          ];
          onOpenProfile(users.find((user) => user.id === id)?.name ?? "同好");
        }}
      />
    </div>
  );
}

/**
 * A live comment section takes the same comment column as the preview's
 * comments (width, centring, padding and room for the fixed composer).
 */
function LiveComments({ children }: { children: ReactNode }) {
  return (
    <div className={styles.comments} data-live-comments="">
      {children}
    </div>
  );
}

export function PostReader({
  id,
  children,
  comments,
  highlightCommentId,
  onOpenProfile,
}: {
  id: string;
  children: ReactNode;
  /** A live comment section; omitted, the preview state supplies comments. */
  comments?: ReactNode;
  highlightCommentId?: string;
  onOpenProfile: (name: string) => void;
}) {
  const postScroll = useRef<HTMLDivElement>(null);
  const authReturnView = useAuthReturnView(`post-reader:${id}`, () => ({
    top: postScroll.current?.scrollTop ?? 0,
  }));
  useLayoutEffect(() => {
    const element = postScroll.current;
    if (!authReturnView || !element) return;
    let stopped = false;
    const observer = new MutationObserver(() => restore());
    const stop = () => {
      stopped = true;
      observer.disconnect();
    };
    const restore = () => {
      if (stopped) return;
      element.scrollTop = authReturnView.top;
      if (Math.abs(element.scrollTop - authReturnView.top) < 1) stop();
    };
    observer.observe(element, { childList: true, subtree: true });
    element.addEventListener("wheel", stop, { passive: true });
    element.addEventListener("pointerdown", stop, { passive: true });
    element.addEventListener("keydown", stop);
    restore();
    const frame = requestAnimationFrame(restore);
    const timer = setTimeout(stop, 10_000);
    return () => {
      stop();
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      element.removeEventListener("wheel", stop);
      element.removeEventListener("pointerdown", stop);
      element.removeEventListener("keydown", stop);
    };
  }, [authReturnView]);
  const [outlet, setOutlet] = useState<HTMLDivElement | null>(null);
  return (
    <div className={styles.reader} data-discussion-comments-host="">
      <CommentComposerPortalProvider target={outlet}>
        <div
          ref={postScroll}
          className={styles.readerScroll}
          data-post-reader={id}
        >
          {children}
          {comments != null ? (
            <LiveComments>{comments}</LiveComments>
          ) : (
            <PreviewComments
              contentId={id}
              {...(highlightCommentId ? { highlightCommentId } : {})}
              onOpenProfile={onOpenProfile}
            />
          )}
        </div>
      </CommentComposerPortalProvider>
      <div ref={setOutlet} data-comment-composer-outlet="" data-active="true" />
    </div>
  );
}
const pages = ["reading", "comments"] as const;
type Page = (typeof pages)[number];
export function ArticleReader({
  id,
  children,
  comments,
  highlightCommentId,
  renderContent,
  onOpenProfile,
}: {
  id: string;
  children?: ReactNode;
  /** A live comment section; omitted, the preview state supplies comments. */
  comments?: ReactNode;
  highlightCommentId?: string;
  renderContent?: (context: {
    scrollElement: HTMLElement | null;
    active: boolean;
    overlayTarget: HTMLElement | null;
  }) => ReactNode;
  onOpenProfile: (name: string) => void;
}) {
  const shell = useProductShell();
  const activeRef = useRef<Page>(highlightCommentId ? "comments" : "reading");
  const readingRef = useRef<HTMLElement | null>(null);
  const commentsRef = useRef<HTMLElement | null>(null);
  const inlineRef = useRef(false);
  const authReturnView = useAuthReturnView(`reader:${id}`, () => ({
    page: activeRef.current,
    top: readingRef.current?.scrollTop ?? 0,
    commentsTop: commentsRef.current?.scrollTop ?? 0,
    inline: inlineRef.current,
  }));
  const [active, setActive] = useState<Page>(
    authReturnView?.page ?? (highlightCommentId ? "comments" : "reading"),
  );
  activeRef.current = active;
  const [readingElement, setReadingElement] = useState<HTMLElement | null>(
    null,
  );
  readingRef.current = readingElement;
  const [commentsElement, setCommentsElement] = useState<HTMLElement | null>(
    null,
  );
  commentsRef.current = commentsElement;
  const [overlayTarget, setOverlayTarget] = useState<HTMLDivElement | null>(
    null,
  );
  const registerScroller = useCallback((element: HTMLElement) => {
    if (element.dataset.readingPage === "reading") setReadingElement(element);
    if (element.dataset.readingPage === "comments") setCommentsElement(element);
    return () => {};
  }, []);
  const [inline, setInline] = useState(authReturnView?.inline ?? false);
  inlineRef.current = inline;
  const lastReadingTop = useRef(0);
  const [commentHost, setCommentHost] = useState<HTMLDivElement | null>(null);
  const sideMount = useRef<HTMLDivElement>(null);
  const inlineMount = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = document.createElement("div");
    setCommentHost(host);
    return () => host.remove();
  }, []);
  useLayoutEffect(() => {
    const target = inline ? inlineMount.current : sideMount.current;
    if (commentHost && target) target.appendChild(commentHost);
  }, [inline, commentHost]);

  const end = useRef<HTMLDivElement>(null);
  const pager = useRef<HorizontalPagerHandle<Page>>(null);
  const [outlet, setOutlet] = useState<HTMLDivElement | null>(null);
  const restoredScrollers = useRef(new WeakSet<HTMLElement>());
  useLayoutEffect(() => {
    if (!authReturnView) return;
    let cancelled = false;
    const elements = [readingElement, commentsElement].filter(
      (element): element is HTMLElement => element !== null,
    );
    const observer = new MutationObserver(() => restore());
    const cancel = () => {
      cancelled = true;
      observer.disconnect();
    };
    const stop = () => {
      for (const element of elements) restoredScrollers.current.add(element);
      cancel();
    };
    const restore = () => {
      if (cancelled) return;
      for (const [element, top] of [
        [readingElement, authReturnView.top],
        [commentsElement, authReturnView.commentsTop],
      ] as const) {
        if (!element || restoredScrollers.current.has(element)) continue;
        element.scrollTop = top;
        if (Math.abs(element.scrollTop - top) < 1)
          restoredScrollers.current.add(element);
      }
      lastReadingTop.current = readingElement?.scrollTop ?? authReturnView.top;
      if (elements.every((element) => restoredScrollers.current.has(element)))
        observer.disconnect();
    };
    for (const element of elements) {
      observer.observe(element, { childList: true, subtree: true });
      element.addEventListener("wheel", stop, { passive: true });
      element.addEventListener("pointerdown", stop, { passive: true });
      element.addEventListener("keydown", stop);
    }
    restore();
    // Comments and their restored source pages arrive after the panels mount.
    // Retry only until their original offsets fit, or the reader takes control.
    const frame = requestAnimationFrame(restore);
    const timer = setTimeout(stop, 10_000);
    return () => {
      cancel();
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      for (const element of elements) {
        element.removeEventListener("wheel", stop);
        element.removeEventListener("pointerdown", stop);
        element.removeEventListener("keydown", stop);
      }
    };
  }, [authReturnView, readingElement, commentsElement, commentHost, inline]);
  const changeInline = (next: boolean) => {
    inlineRef.current = next;
    setInline(next);
  };
  return (
    <div
      className={styles.reader}
      data-discussion-comments-host=""
      data-preview-reader={id}
      data-comment-mode={inline ? "inline" : "paged"}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || inlineRef.current) return;
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          pager.current?.scrollToKey(
            event.key === "ArrowLeft" ? "comments" : "reading",
          );
        }
      }}
    >
      <CommentComposerPortalProvider target={outlet}>
        <div
          className={styles.readerFrame}
          onScrollCapture={(event) => {
            const el = event.target;
            if (
              !(el instanceof HTMLElement) ||
              el.dataset.readingPage !== "reading" ||
              active !== "reading"
            )
              return;
            const scrollingUp = el.scrollTop < lastReadingTop.current;
            lastReadingTop.current = el.scrollTop;
            if (inlineRef.current) {
              // Keep the reading panel mounted: no scroll-position transfer or clamp.
              const boundary = end.current;
              if (
                scrollingUp &&
                boundary &&
                boundary.getBoundingClientRect().top >=
                  el.getBoundingClientRect().bottom - 1
              )
                changeInline(false);
            } else if (
              el.scrollTop > 16 &&
              el.scrollHeight - el.clientHeight - el.scrollTop <= 4
            )
              changeInline(true);
          }}
        >
          <HorizontalPager
            ref={pager}
            keys={pages}
            activeKey={active}
            onCommit={setActive}
            canStartGesture={() => !inlineRef.current}
            registerActiveScrollElement={registerScroller}
            panels={{
              reading: (
                <>
                  {renderContent ? (
                    renderContent({
                      scrollElement: readingElement,
                      active: active === "reading" && !inline,
                      overlayTarget,
                    })
                  ) : (
                    <article className={styles.article}>
                      {children}
                      <div className={styles.articleEnd}>
                        <span>全文完</span>
                      </div>
                    </article>
                  )}
                  {inline && (
                    <div ref={end} data-inline-comments="">
                      <div ref={inlineMount} />
                    </div>
                  )}
                </>
              ),
              comments: <div ref={sideMount} />,
            }}
            platform={shell.platform}
            scrollOwner="panel"
            panelId={(page) => `${id}-${page}`}
            panelLabelledBy={() => `${id}-reader-heading`}
            panelAttributes={(page) => ({ "data-reading-page": page })}
            diagnosticPrefix="article"
          />
        </div>
        {commentHost &&
          createPortal(
            comments != null ? (
              <LiveComments>{comments}</LiveComments>
            ) : (
              <PreviewComments
                contentId={id}
                {...(highlightCommentId ? { highlightCommentId } : {})}
                onOpenProfile={onOpenProfile}
              />
            ),
            commentHost,
          )}
      </CommentComposerPortalProvider>
      <div ref={setOverlayTarget} data-reader-overlay-outlet="" />
      <div
        ref={setOutlet}
        data-comment-composer-outlet=""
        data-active={active === "comments" || inline}
      />
    </div>
  );
}
