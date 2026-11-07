"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useOptionalAuthors } from "../../authors/author-context";
import { UNTITLED_WORK_LABEL } from "../../authors/content-card";
import {
  ownWorkAudienceLabel,
  ownWorkAudienceNote,
  ownWorkAudienceOf,
} from "../../authors/own-work-audience";
import { workCard } from "../../authors/profile-list";
import {
  placeholderStyle,
  responsiveImage,
} from "../../media/responsive-media";
import { TimelineAttachPicker } from "./timeline-attach-picker";
import {
  TIMELINE_POSTS_PAGE,
  TIMELINE_POSTS_PREVIEW,
  readTimelinePosts,
} from "./timeline-posts-data";
import styles from "./timeline-posts.module.css";

import type { UserWork } from "@moya/contracts";

/** A cell is a third of the card (at most 400 wide) less its gaps. */
const CELL_SIZES = "(min-width: 768px) 128px, 33vw";

/**
 * What the posts of an entry may do. Each receives the control that was
 * pressed; a host that closes first (the timeline's sheets) uses its own
 * opener instead, because the pressed control leaves with the sheet.
 */
export interface TimelineEntryPostsActions {
  /** 「上传这件碑帖」: a new post attached to this entry. */
  readonly upload: (opener: HTMLElement) => void;
  readonly openWork: (workId: string, opener: HTMLElement) => void;
  /** A guest's 「关联我发过的帖子」 reaches sign-in. */
  readonly signIn: (opener: HTMLElement) => void;
  /** An attachment changed this entry's posts (row counts follow). */
  readonly postsChanged?: (() => void) | undefined;
}

type PostsState =
  | { readonly state: "loading" }
  | { readonly state: "failed" }
  | {
      readonly state: "ready";
      readonly items: readonly UserWork[];
      readonly total: number;
      /** The pages of TIMELINE_POSTS_PAGE read; 0 while only the preview is. */
      readonly pages: number;
      readonly more: "idle" | "loading" | "failed";
    };

/**
 * One post's cover. The author's own post that others cannot see (self-only,
 * pending, hidden or removed) carries the profile works grid's mark, so the
 * author can tell why nobody else finds it here.
 */
const PostCell = ({
  onOpen,
  work,
}: {
  readonly onOpen: (workId: string, opener: HTMLElement) => void;
  readonly work: UserWork;
}) => {
  const card = workCard(work);
  const label = work.title === "" ? UNTITLED_WORK_LABEL : work.title;
  const media = card.media;
  const image = media === null ? null : responsiveImage(media, CELL_SIZES);
  const audience = ownWorkAudienceOf(work);
  const mark = audience === null ? null : ownWorkAudienceLabel(audience);
  return (
    <li>
      <button
        aria-label={mark === null ? label : `${label}，${mark}`}
        className={styles.cell}
        data-timeline-post={work.id}
        onClick={(event) => onOpen(work.id, event.currentTarget)}
        type="button"
      >
        {media === null || image === null ? (
          <span className={styles.cellText}>
            {work.title === "" ? (card.excerpt ?? label) : work.title}
          </span>
        ) : (
          <img
            alt=""
            decoding="async"
            height={media.height}
            loading="lazy"
            sizes={image.sizes}
            src={image.src}
            srcSet={image.srcSet}
            style={placeholderStyle(media.placeholderColor)}
            width={media.width}
          />
        )}
        {mark === null || audience === null ? null : (
          <span
            aria-hidden="true"
            className={styles.audience}
            data-timeline-post-audience=""
            title={ownWorkAudienceNote(audience) ?? undefined}
          >
            {mark}
          </span>
        )}
      </button>
    </li>
  );
};

/** Distinct by id, in reading order: a page may repeat a post that moved. */
const appendPosts = (
  current: readonly UserWork[],
  next: readonly UserWork[],
): readonly UserWork[] => {
  const known = new Set(current.map((work) => work.id));
  return [...current, ...next.filter((work) => !known.has(work.id))];
};

/**
 * The posts of one timeline entry (timeline-posts-v1 §2.2): the upload
 * action and its line, which is also all a row with no posts says; then the
 * newest attached posts as a three-column grid of their covers, six first
 * and 「全部 N 篇」 for the rest, paged in place; and 「关联我发过的帖子」.
 * Browse-only keeps the posts and drops both actions. Loads after its host
 * has painted and never holds it up.
 */
export const TimelineEntryPosts = ({
  actions,
  browseOnly = false,
  entryId,
  entryTitle,
  heading = null,
}: {
  readonly actions: TimelineEntryPostsActions;
  readonly browseOnly?: boolean;
  readonly entryId: string;
  /** The entry's short title, named when a post moves here. */
  readonly entryTitle: string;
  /** Catalog Detail names the section; the 词条卡 does not. */
  readonly heading?: string | null;
}) => {
  const authors = useOptionalAuthors();
  const viewerId = authors?.viewer?.id ?? null;
  const [state, setState] = useState<PostsState>({ state: "loading" });
  const [revision, setRevision] = useState(0);
  const [attaching, setAttaching] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const latest = useRef(state);
  latest.current = state;
  // 「关联我发过的帖子」 is replaced by its picker; when the picker closes
  // (取消 or an attachment), the focus comes back to the new button.
  const attachRef = useRef<HTMLButtonElement>(null);
  const attachClosed = useRef(false);
  useEffect(() => {
    if (attaching || !attachClosed.current) return;
    attachClosed.current = false;
    attachRef.current?.focus();
  }, [attaching]);
  const closeAttach = () => {
    attachClosed.current = true;
    setAttaching(false);
  };

  // A new entry, account or attachment starts over from the preview.
  useEffect(() => {
    const controller = new AbortController();
    setState({ state: "loading" });
    readTimelinePosts(entryId, 1, TIMELINE_POSTS_PREVIEW, controller.signal)
      .then((page) => {
        if (!controller.signal.aborted)
          setState({
            state: "ready",
            items: page.items,
            total: page.total,
            pages: 0,
            more: "idle",
          });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ state: "failed" });
      });
    return () => controller.abort();
  }, [entryId, revision, viewerId]);

  const showMore = useCallback(() => {
    const current = latest.current;
    if (current.state !== "ready" || current.more === "loading") return;
    const page = current.pages + 1;
    setState({ ...current, more: "loading" });
    readTimelinePosts(entryId, page, TIMELINE_POSTS_PAGE).then(
      (answer) => {
        const now = latest.current;
        if (now.state !== "ready") return;
        setState({
          state: "ready",
          // The first full page replaces the preview it starts with.
          items:
            page === 1 ? answer.items : appendPosts(now.items, answer.items),
          total: answer.total,
          pages: page,
          more: "idle",
        });
      },
      () => {
        const now = latest.current;
        if (now.state === "ready") setState({ ...now, more: "failed" });
      },
    );
  }, [entryId]);

  const openAttach = (opener: HTMLElement) => {
    if (authors?.checking) return;
    if (!authors?.viewer) {
      actions.signIn(opener);
      return;
    }
    setNotice(null);
    setAttaching(true);
  };

  const shown = state.state === "ready" && state.total > 0;
  const remaining =
    state.state === "ready" ? state.total - state.items.length : 0;

  return (
    <section
      aria-busy={state.state === "loading" || undefined}
      aria-label={heading ?? "帖子"}
      className={styles.posts}
      data-timeline-posts={entryId}
    >
      {heading === null ? null : <h2 className={styles.heading}>{heading}</h2>}
      {browseOnly ? null : (
        <>
          <button
            className={styles.upload}
            data-timeline-upload=""
            onClick={(event) => actions.upload(event.currentTarget)}
            type="button"
          >
            上传这件碑帖
          </button>
          <p className={styles.caption}>发布后会出现在这个词条下。</p>
        </>
      )}
      {state.state === "loading" ? (
        <div aria-hidden="true" className={styles.grid}>
          <span className={styles.placeholder} />
          <span className={styles.placeholder} />
          <span className={styles.placeholder} />
        </div>
      ) : null}
      {state.state === "failed" ? (
        <div className={styles.row}>
          <p className={styles.status} data-tone="error" role="status">
            帖子载入失败
          </p>
          <button
            className={styles.textAction}
            onClick={() => setRevision((value) => value + 1)}
            type="button"
          >
            重试
          </button>
        </div>
      ) : null}
      {shown ? (
        <>
          <ul className={styles.grid} data-timeline-post-grid="">
            {state.items.map((work) => (
              <PostCell key={work.id} onOpen={actions.openWork} work={work} />
            ))}
          </ul>
          {remaining > 0 ? (
            <div className={styles.row}>
              <button
                aria-disabled={state.more === "loading" || undefined}
                className={styles.textAction}
                data-timeline-posts-more=""
                onClick={showMore}
                type="button"
              >
                {state.pages === 0 ? `全部 ${state.total} 篇` : "显示更多"}
              </button>
              {state.more === "failed" ? (
                <span className={styles.status} data-tone="error" role="status">
                  帖子载入失败
                </span>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
      {browseOnly ? null : attaching && viewerId !== null ? (
        <TimelineAttachPicker
          authorId={viewerId}
          entryId={entryId}
          entryTitle={entryTitle}
          onCancel={closeAttach}
          onAttached={(text) => {
            closeAttach();
            setNotice(text);
            setRevision((value) => value + 1);
            actions.postsChanged?.();
          }}
        />
      ) : (
        <div className={styles.row}>
          <button
            className={styles.textAction}
            data-timeline-attach=""
            onClick={(event) => openAttach(event.currentTarget)}
            ref={attachRef}
            type="button"
          >
            关联我发过的帖子
          </button>
          {notice === null ? null : (
            <p className={styles.status} role="status">
              {notice}
            </p>
          )}
        </div>
      )}
    </section>
  );
};
