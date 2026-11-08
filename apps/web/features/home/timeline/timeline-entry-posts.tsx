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

export type TimelinePostsState =
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

/** One entry's posts as useTimelinePosts reads them. */
export interface TimelinePosts {
  readonly state: TimelinePostsState;
  readonly showMore: () => void;
  readonly reload: () => void;
}

/**
 * The viewer's posts of one entry, as the 词条卡's grid and the card deck
 * read them: the preview first, then pages of TIMELINE_POSTS_PAGE on
 * `showMore`. A new entry or account starts over from the preview, and so
 * does `reload` (after an attachment); a reload keeps the posts shown until
 * the new preview replaces them, so nothing around them shrinks and regrows.
 * A null entry reads nothing: its host passes posts it has read itself.
 */
export const useTimelinePosts = (entryId: string | null): TimelinePosts => {
  const authors = useOptionalAuthors();
  const viewerId = authors?.viewer?.id ?? null;
  const [state, setState] = useState<TimelinePostsState>({ state: "loading" });
  const [revision, setRevision] = useState(0);
  const latest = useRef(state);
  latest.current = state;

  const loadedFor = useRef<string | null>(null);
  useEffect(() => {
    if (entryId === null) return undefined;
    const controller = new AbortController();
    const key = `${entryId}\n${viewerId ?? ""}`;
    if (loadedFor.current !== key || latest.current.state !== "ready")
      setState({ state: "loading" });
    loadedFor.current = key;
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
    if (entryId === null) return;
    if (current.state !== "ready" || current.more === "loading") return;
    const page = current.pages + 1;
    // Held at once, so a second call before the next render reads nothing twice.
    const loading = { ...current, more: "loading" } as const;
    latest.current = loading;
    setState(loading);
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

  const reload = useCallback(() => setRevision((value) => value + 1), []);
  return { state, showMore, reload };
};

/** The props of an entry's posts; see TimelineEntryPosts. */
type TimelineEntryPostsProps = {
  readonly browseOnly?: boolean;
  readonly entryId: string;
  /** The entry's full title (with its dynasty), named when a post moves here. */
  readonly entryTitle: string;
  /** Catalog Detail names the section; the 词条卡 does not. */
  readonly heading?: string | null;
  /**
   * Posts its host has read already (Catalog Detail, which shows nothing
   * until it knows there are some); read here otherwise.
   */
  readonly posts?: TimelinePosts;
} & (
  | { readonly actions: TimelineEntryPostsActions; readonly uploads?: true }
  | {
      readonly actions: Pick<TimelineEntryPostsActions, "openWork">;
      /** Neither 「上传这件碑帖」 nor 「关联我发过的帖子」, at any width. */
      readonly uploads: false;
    }
);

/**
 * The posts of one timeline entry (timeline-posts-v1 §2.2): the upload
 * action and its line, which is also all a row with no posts says; then the
 * newest attached posts as a three-column grid of their covers, six first
 * and 「全部 N 篇」 for the rest, paged in place; and 「关联我发过的帖子」.
 * Browse-only keeps the posts and drops both actions, and so does
 * `uploads={false}`: Catalog Detail shows the posts alone, because uploading
 * starts from the card deck's 「上传」 and the 词条卡 (Issue #422). Loads
 * after its host has painted and never holds it up.
 */
export const TimelineEntryPosts = (props: TimelineEntryPostsProps) => {
  const { browseOnly = false, entryId, entryTitle, heading = null } = props;
  // The upload and attach actions, when this host shows them.
  const owned = props.uploads === false || browseOnly ? null : props.actions;
  const { openWork } = props.actions;
  const authors = useOptionalAuthors();
  const viewerId = authors?.viewer?.id ?? null;
  const own = useTimelinePosts(props.posts === undefined ? entryId : null);
  const { state, showMore, reload } = props.posts ?? own;
  const [attaching, setAttaching] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
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

  const openAttach = (
    actions: TimelineEntryPostsActions,
    opener: HTMLElement,
  ) => {
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
      {owned === null ? null : (
        <>
          <button
            className={styles.upload}
            data-timeline-upload=""
            onClick={(event) => owned.upload(event.currentTarget)}
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
          <button className={styles.textAction} onClick={reload} type="button">
            重试
          </button>
        </div>
      ) : null}
      {shown ? (
        <>
          <ul className={styles.grid} data-timeline-post-grid="">
            {state.items.map((work) => (
              <PostCell key={work.id} onOpen={openWork} work={work} />
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
      {owned === null ? null : attaching && viewerId !== null ? (
        <TimelineAttachPicker
          authorId={viewerId}
          entryId={entryId}
          entryTitle={entryTitle}
          onCancel={closeAttach}
          onAttached={(text) => {
            closeAttach();
            setNotice(text);
            reload();
            owned.postsChanged?.();
          }}
        />
      ) : (
        <div className={styles.row}>
          <button
            className={styles.textAction}
            data-timeline-attach=""
            onClick={(event) => openAttach(owned, event.currentTarget)}
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
