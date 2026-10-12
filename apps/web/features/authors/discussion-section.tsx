"use client";
import type { DiscussionTarget as ContentIdentity } from "@moya/contracts";
import { CommentSection } from "../comments/comment-section";
import { useProductShell } from "../product-shell/product-shell";
import { useAuthors, contentKey } from "./author-context";
import { useDiscussionThread } from "./use-discussion-thread";
const ScopedDiscussionSection = ({ target }: { target: ContentIdentity }) => {
  const shell = useProductShell();
  const t = useDiscussionThread({ target });
  return (
    <div>
      {t.locatedPage !== null && (
        <div className="phase4-actions">
          <span>已定位到第 {t.locatedPage} 页；展开回复从所在页开始。</span>
          {t.highlightId && (
            <button type="button" onClick={t.browseHighlightFromFirstReply}>
              从第一条回复浏览
            </button>
          )}
          <button type="button" onClick={t.returnToLatest}>
            返回最新评论
          </button>
        </div>
      )}
      {t.closedNote === null ? null : (
        // Outside the section's notice line, so a comment error never hides it.
        <p className="phase4-muted" data-discussion-closed="" role="status">
          {t.closedNote}
        </p>
      )}
      <CommentSection
        // The closed box is its own editor scope. CommentSection has no prop
        // for a closed box, so 回复 there still sets a reply target nothing
        // shows; scoping it away means the box never reopens in 回复 X mode
        // on a comment the author answered while nobody else could see the
        // work. Only the editor (its draft and reply target) is scoped by
        // this value, so the comments themselves stay as they are.
        contentKey={`${contentKey(target)}${t.composerClosed ? ":closed" : ""}`}
        currentUser={t.currentUser}
        items={t.items}
        hotItems={t.hot}
        onSendComment={(text, refs) => t.sendComment(text, refs)}
        onSendReply={(reply, text, refs) => t.sendReply(reply, text, refs)}
        onToggleLike={(root, reply) => t.toggleLike(root, reply)}
        onOpenAuthor={(id, opener) => shell.openProfile(id, opener)}
        onDeleteBody={(id) => {
          if (!window.confirm("删除正文？其他人的回复将保留。")) return;
          t.deleteBody(id);
        }}
        {...(t.highlightId ? { highlightCommentId: t.highlightId } : {})}
        presentation="live"
        viewer={t.viewerState}
        loading={t.loading}
        status={t.unavailable ? "not-found" : null}
        notice={
          t.error
            ? { tone: "error", text: t.error }
            : t.notice
              ? { tone: "info", text: t.notice }
              : null
        }
        totalCount={t.visibleTotal}
        submitting={t.submitting}
        loadMore={{
          hasMore: t.hasMore,
          loading: t.busy,
          onLoadMore: t.loadMore,
        }}
        onLoadMoreReplies={(id) => t.loadReplies(id)}
      />
      {t.error && (
        <button className="phase4-button" onClick={t.retry}>
          重试读取评论
        </button>
      )}
    </div>
  );
};

export const DiscussionSection = ({ target }: { target: ContentIdentity }) => {
  const author = useAuthors();
  return (
    <ScopedDiscussionSection
      key={`${author.viewer?.id ?? "guest"}:${contentKey(target)}`}
      target={target}
    />
  );
};
