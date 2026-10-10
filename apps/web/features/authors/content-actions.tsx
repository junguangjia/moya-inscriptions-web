"use client";
import { useAuthEntry } from "../auth/auth-return";
import { useEffect, useRef, useState } from "react";
import type { ContentIdentity } from "@moya/contracts";
import type { ContentQuickActionEnvironment } from "../quick-actions/quick-action-types";
import { quickActionContentKey } from "../quick-actions/quick-action-types";
import { useAuthors, shareContent, contentKey } from "./author-context";
import { authorClient } from "./author-data";
import {
  publishCommentCount,
  usePublishedCommentCount,
} from "./content-state-bus";
import { QuickActionIcon } from "../quick-actions/quick-action-card-action";
import type { QuickActionName } from "../quick-actions/quick-action-types";
import styles from "./content-actions.module.css";

const unknownState = (key: string) => ({
  key,
  favorite: false,
  liked: false,
  known: false,
  favoriteCount: null as number | null,
  likeCount: null as number | null,
  commentCount: null as number | null,
});
export const useContentActions = (
  target: ContentIdentity,
  title: string,
  includeGuestCounts = false,
) => {
  const author = useAuthors(),
    key = `${author.viewer?.id ?? "guest"}:${contentKey(target)}`;
  const [snapshot, setSnapshot] = useState(() => unknownState(key)),
    [busy, setBusy] = useState(false),
    [pendingAction, setPendingAction] = useState<QuickActionName | null>(null),
    scope = useRef(key),
    inFlight = useRef(false),
    readEpoch = useRef(0);
  scope.current = key;
  const viewerId = author.viewer?.id ?? null;
  // The newest comment total this reader received, from a state read or a
  // discussion read of the same content.
  const publishedComments = usePublishedCommentCount(viewerId, target);
  const known = snapshot.key === key ? snapshot : unknownState(key);
  const state = {
    ...known,
    commentCount: publishedComments ?? known.commentCount,
  };
  useEffect(() => {
    let current = true;
    if (author.checking) return;
    const read = ++readEpoch.current;
    const guestFavorite = author.guestFavorites.some(
      (x) => contentKey(x) === contentKey(target),
    );
    if (!author.viewer) {
      setSnapshot((old) => ({
        ...(old.key === key ? old : unknownState(key)),
        favorite: guestFavorite,
        liked: false,
        known: true,
      }));
      if (!includeGuestCounts) return;
    }
    void authorClient
      .state(target)
      .then((value) => {
        if (current && scope.current === key && read === readEpoch.current) {
          setSnapshot({
            key,
            ...value,
            favorite: author.viewer ? value.favorite : guestFavorite,
            known: true,
          });
          publishCommentCount(viewerId, target, value.commentCount);
        }
      })
      .catch(() => {
        /* Same-scope failures preserve known state; another account starts unknown. */
      });
    return () => {
      current = false;
    };
  }, [
    key,
    author.checking,
    author.revision,
    author.guestFavorites,
    includeGuestCounts,
  ]);
  const execute: ContentQuickActionEnvironment["onAction"] = async (action) => {
    if (inFlight.current) return false;
    if (action !== "share" && !state.known) {
      author.notify("内容状态尚未确认，请稍后重试");
      return false;
    }
    inFlight.current = true;
    if (action !== "share") readEpoch.current++;
    setBusy(true);
    setPendingAction(action);
    const run = key;
    try {
      if (action === "share") {
        const result = await shareContent(target, title);
        if (result !== "cancelled")
          author.notify(result === "shared" ? "已分享" : "链接已复制");
        return result !== "cancelled";
      }
      const field = action === "favorite" ? "favorite" : "liked",
        value = !state[field];
      const saved = await (action === "favorite"
        ? author.favorite(target, value)
        : author.like(target, value));
      if (saved && scope.current === run)
        setSnapshot((old) =>
          old.key === run ? { ...old, [field]: value } : old,
        );
      if (saved && author.viewer && scope.current === run) {
        const read = ++readEpoch.current;
        try {
          const confirmed = await authorClient.state(target);
          if (scope.current === run && read === readEpoch.current) {
            setSnapshot({ key: run, ...confirmed, known: true });
            publishCommentCount(viewerId, target, confirmed.commentCount);
          }
        } catch {
          // The toggle is committed, but an unknown aggregate is not a guessed +1.
          if (scope.current === run && read === readEpoch.current)
            setSnapshot((old) =>
              old.key === run
                ? {
                    ...old,
                    [action === "favorite" ? "favoriteCount" : "likeCount"]:
                      null,
                  }
                : old,
            );
        }
      }
      return saved && scope.current === run;
    } catch (error) {
      if (scope.current === run)
        author.notify(error instanceof Error ? error.message : "操作未完成");
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
      setPendingAction(null);
    }
  };
  const actionKey = quickActionContentKey({
    kind: target.type,
    id: target.id,
    title,
  });
  return {
    state,
    busy,
    pendingAction,
    execute,
    environment: {
      onAction: execute,
      likedIds: state.liked ? [actionKey] : [],
      favoriteIds: state.favorite ? [actionKey] : [],
    } satisfies ContentQuickActionEnvironment,
  };
};
export const ContentActionsView = ({
  target,
  title,
  actions,
}: {
  target: ContentIdentity;
  title: string;
  actions: ReturnType<typeof useContentActions>;
}) => {
  const { viewer, signInHref, checking } = useAuthors();
  const enterAuth = useAuthEntry();
  return (
    <div
      className={`phase4-detail-actions ${styles.actions}`}
      role="group"
      aria-label="内容操作"
      data-detail-content-actions=""
    >
      {(["favorite", "like", "share"] as const).map((action) => {
        const active =
          action === "favorite"
            ? actions.state.favorite
            : action === "like"
              ? actions.state.liked
              : actions.pendingAction === "share";
        const count =
          action === "favorite"
            ? actions.state.favoriteCount
            : action === "like"
              ? actions.state.likeCount
              : null;
        return (
          <button
            key={action}
            className={styles.action}
            type="button"
            aria-label={
              action === "favorite"
                ? "收藏"
                : action === "like"
                  ? "喜欢"
                  : "分享"
            }
            aria-pressed={action === "share" ? undefined : active}
            aria-busy={actions.pendingAction === action || undefined}
            data-active={active}
            disabled={
              checking ||
              actions.busy ||
              (action !== "share" && !actions.state.known)
            }
            onClick={() => {
              if (action === "like" && !viewer) {
                enterAuth(signInHref);
                return;
              }
              void actions.execute(action, {
                kind: target.type,
                id: target.id,
                title,
              });
            }}
          >
            <QuickActionIcon
              action={action}
              filled={action !== "share" && active}
            />
            {count !== null && count > 0 ? (
              <span
                className={styles.count}
                data-detail-reaction-count={action}
              >
                {count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
};

export const ContentActions = ({
  target,
  title,
}: {
  target: ContentIdentity;
  title: string;
}) => {
  const actions = useContentActions(target, title, true);
  return <ContentActionsView target={target} title={title} actions={actions} />;
};
