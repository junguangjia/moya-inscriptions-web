"use client";

import { QuickActionIcon } from "./quick-action-card-action";
import styles from "./feed-post-actions.module.css";

import type {
  ContentQuickActionEnvironment,
  QuickActionContent,
  QuickActionName,
} from "./quick-action-types";
import { quickActionContentKey } from "./quick-action-types";

const countFormat = new Intl.NumberFormat("zh-CN");

/** The right-hand action: a work expands its body, official content opens Detail. */
export type FeedPostTrailingAction =
  | {
      readonly kind: "expand";
      readonly expanded: boolean;
      readonly controls?: string;
      readonly onToggle: () => void;
    }
  | {
      readonly kind: "detail";
      readonly onOpen: (opener: HTMLButtonElement) => void;
    };

const ActionCount = ({
  action,
  value,
}: {
  readonly action: QuickActionName | "comment";
  readonly value: number | null | undefined;
}) =>
  value === null || value === undefined || value <= 0 ? null : (
    <span className={styles.count} data-feed-post-count={action}>
      {countFormat.format(value)}
    </span>
  );

/** Outline glyphs drawn like QuickActionIcon so every action lines up. */
const Glyph = ({ path }: { readonly path: string }) => (
  <svg aria-hidden="true" className={styles.glyph} viewBox="0 0 24 24">
    <path d={path} />
  </svg>
);
const COMMENT_PATH =
  "M5 4.5h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9l-6 3v-3a2 2 0 0 1-1-1.7V6.5a2 2 0 0 1 2-2ZM7 9h10M7 13h7";
const EXPAND_PATH = "m6 9 6 6 6-6";
const DETAIL_PATH = "m9.5 5 7 7-7 7";

/**
 * The always-visible action row of a single-column feed post: like, comment,
 * share and favorite on the left with their totals, the body or Detail action
 * on the right. Like, favorite and share run the same environment as the
 * long-press menu of two-column cards, so both entries stay one behavior.
 */
export const FeedPostActions = ({
  content,
  environment,
  onComment,
  trailing,
}: {
  readonly content: QuickActionContent;
  readonly environment: ContentQuickActionEnvironment | null;
  readonly onComment: (opener: HTMLButtonElement) => void;
  readonly trailing?: FeedPostTrailingAction | undefined;
}) => {
  const key = quickActionContentKey(content);
  const liked = environment?.likedIds.includes(key) ?? false;
  const favorited = environment?.favoriteIds.includes(key) ?? false;
  const ready = environment !== null && environment.ready !== false;
  const run = (action: QuickActionName) => {
    if (environment !== null) void environment.onAction(action, content);
  };
  return (
    <div
      className={styles.actions}
      role="group"
      aria-label="内容操作"
      data-feed-post-actions=""
    >
      <button
        type="button"
        className={styles.action}
        aria-label="喜欢"
        aria-pressed={liked}
        data-active={liked}
        disabled={!ready}
        onClick={() => run("like")}
      >
        <QuickActionIcon action="like" filled={liked} />
        <ActionCount action="like" value={environment?.likeCount} />
      </button>
      <button
        type="button"
        className={styles.action}
        aria-label="评论"
        data-feed-post-comment=""
        onClick={(event) => onComment(event.currentTarget)}
      >
        <Glyph path={COMMENT_PATH} />
        <ActionCount action="comment" value={environment?.commentCount} />
      </button>
      <button
        type="button"
        className={styles.action}
        aria-label="分享"
        disabled={environment === null}
        onClick={() => run("share")}
      >
        <QuickActionIcon action="share" />
      </button>
      <button
        type="button"
        className={styles.action}
        aria-label="收藏"
        aria-pressed={favorited}
        data-active={favorited}
        disabled={!ready}
        onClick={() => run("favorite")}
      >
        <QuickActionIcon action="favorite" filled={favorited} />
        <ActionCount action="favorite" value={environment?.favoriteCount} />
      </button>
      {trailing === undefined ? null : trailing.kind === "expand" ? (
        <button
          type="button"
          className={`${styles.action} ${styles.trailing}`}
          aria-controls={trailing.controls}
          aria-expanded={trailing.expanded}
          aria-label={trailing.expanded ? "收起正文" : "展开正文"}
          data-feed-post-trailing="expand"
          onClick={trailing.onToggle}
        >
          <Glyph path={EXPAND_PATH} />
        </button>
      ) : (
        <button
          type="button"
          className={`${styles.action} ${styles.trailing}`}
          aria-label="查看详情"
          data-feed-post-trailing="detail"
          onClick={(event) => trailing.onOpen(event.currentTarget)}
        >
          <Glyph path={DETAIL_PATH} />
        </button>
      )}
    </div>
  );
};
