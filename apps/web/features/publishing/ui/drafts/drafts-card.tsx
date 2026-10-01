"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { useAuthors } from "../../../authors/author-context";
import { authorClient } from "../../../../lib/public-api/author-community-client";
import { useProductShell } from "../../../product-shell/product-shell";
import type { ProductEditorTarget } from "../../../product-shell/product-history";
import { useArticleAvailability } from "../../../editorial-content/article-authoring/article-availability";
import homeStyles from "../../../home/home-screen.module.css";
import { usePublishingEntry } from "../../publishing-entry";
import { publishingClient } from "../../publishing-data";
import { DraftsPicker } from "./drafts-picker";
import { isAbort } from "./drafts-intent";
import { CoverThumb } from "./drafts-shared";
import styles from "./drafts.module.css";

import type { PublishingDraftSummary } from "@moya/contracts";

type CardState =
  | { readonly status: "loading" }
  | { readonly status: "error" }
  | {
      readonly status: "ready";
      readonly total: number;
      readonly newest: PublishingDraftSummary | null;
    };

/** How long the card waits for the closed picker to hand its history entry back. */
const HISTORY_SETTLE_LIMIT_MS = 2_000;
const HISTORY_SETTLE_STEP_MS = 16;

const countText = (state: CardState): string =>
  state.status === "ready"
    ? state.total === 0
      ? "暂无草稿"
      : `${state.total} 份草稿`
    : state.status === "loading"
      ? "正在读取…"
      : "暂时无法读取";

/**
 * The first card of the owner's Works tab (D03): a stacked card with the
 * account's true draft count ("暂无草稿" at zero) that opens the drafts
 * picker. The caller renders it only for the signed-in owner of the profile;
 * visitors never receive it. The card mounts with each profile visit (the
 * profile closes while the editor is open), so every visit reads the count.
 */
export const DraftsCard = ({
  accountId,
  active,
  onSettled,
}: {
  /** The confirmed viewer who owns this profile. */
  readonly accountId: string;
  /** Whether the Works tab is the visible panel; entering it rereads the count. */
  readonly active: boolean;
  /** Lets the masonry measure again after the card's content changed. */
  readonly onSettled?: () => void;
}) => {
  const author = useAuthors();
  const entry = usePublishingEntry();
  const shell = useProductShell();
  const articleEnabled = useArticleAvailability();
  const returnKey = `drafts-box-return:${accountId}`;
  const cacheKey = `drafts-card:${accountId}`;
  const [state, setState] = useState<CardState>(
    () =>
      (author.cache.get(cacheKey) as CardState | undefined) ?? {
        status: "loading",
      },
  );
  const [picker, setPicker] = useState(false);
  const [pickerType, setPickerType] = useState<"work" | "article">("work");
  const openerRef = useRef<HTMLButtonElement>(null);
  const pendingTarget = useRef<ProductEditorTarget | null>(null);
  const pendingArticleEpoch = useRef<number | null>(null);
  const controller = useRef<AbortController | null>(null);
  const settled = useRef(onSettled);
  settled.current = onSettled;
  const latest = useRef({
    openEditor: entry.openEditor,
    openArticle: shell.openEditor,
    articleEnabled,
    ownerId: author.viewer?.id ?? null,
    checking: author.checking,
    notify: author.notify,
  });
  latest.current = {
    openEditor: entry.openEditor,
    openArticle: shell.openEditor,
    articleEnabled,
    ownerId: author.viewer?.id ?? null,
    checking: author.checking,
    notify: author.notify,
  };

  const show = useCallback(
    (next: CardState) => {
      if (next.status === "ready") author.cache.set(cacheKey, next);
      setState(next);
    },
    [author.cache, cacheKey],
  );

  const read = useCallback(async () => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    try {
      const page = await publishingClient.listDrafts(
        { page: 1, pageSize: 1 },
        current.signal,
      );
      if (current.signal.aborted) return;
      show({
        status: "ready",
        total: page.total,
        newest: page.items[0] ?? null,
      });
    } catch (error) {
      if (current.signal.aborted || isAbort(error)) return;
      // A count that could not be confirmed is never shown, not even the
      // last one: drafts may have been created or deleted since.
      setState({ status: "error" });
    }
  }, [show]);

  useEffect(() => {
    if (active) void read();
  }, [active, read, author.revision]);

  useEffect(() => () => controller.current?.abort(), []);

  useLayoutEffect(() => {
    settled.current?.();
  }, [state]);

  // The existing owner profile returns from an Article to this same box.
  // Only the visible card consumes the transient, account-keyed request.
  useEffect(() => {
    if (
      !articleEnabled ||
      !active ||
      shell.activeEditor !== null ||
      author.checking ||
      author.sessionError ||
      author.viewer?.id !== accountId ||
      author.cache.get(returnKey) !== "article"
    )
      return;
    const opener = openerRef.current;
    if (
      opener === null ||
      opener.closest('[inert], [hidden], [aria-hidden="true"]') !== null
    )
      return;
    author.cache.delete(returnKey);
    setPickerType("article");
    setPicker(true);
  }, [
    accountId,
    active,
    articleEnabled,
    author.cache,
    author.checking,
    author.sessionError,
    author.viewer?.id,
    returnKey,
    shell.activeEditor,
    shell.activeProfile,
  ]);

  // The picker's AuthorDialog owns a temporary history entry. The editor
  // opens only after that entry is gone, so it never inherits (and later
  // loses) the dialog's history marker.
  useEffect(() => {
    if (picker || pendingTarget.current === null) return undefined;
    const target = pendingTarget.current;
    const started = Date.now();
    let timer = 0;
    const attempt = () => {
      const dialogEntry =
        typeof window.history.state === "object" &&
        window.history.state !== null &&
        "phase4Dialog" in window.history.state &&
        Boolean(window.history.state.phase4Dialog);
      if (dialogEntry) {
        if (Date.now() - started < HISTORY_SETTLE_LIMIT_MS) {
          timer = window.setTimeout(attempt, HISTORY_SETTLE_STEP_MS);
          return;
        }
        pendingTarget.current = null;
        latest.current.notify("暂时无法打开草稿，请重试");
        return;
      }
      pendingTarget.current = null;
      const opener = openerRef.current;
      if (opener === null) {
        latest.current.notify("暂时无法打开草稿，请重试");
        return;
      }
      if (target.type === "article-draft") {
        if (
          !latest.current.articleEnabled ||
          latest.current.checking ||
          latest.current.ownerId !== accountId ||
          authorClient.account() !== accountId ||
          authorClient.accountEpoch() !== pendingArticleEpoch.current
        ) {
          latest.current.notify("请先确认当前账号后打开专题草稿");
          return;
        }
        author.cache.set(returnKey, "article");
        if (!latest.current.openArticle(target, opener))
          latest.current.notify("暂时无法打开专题草稿，请重试");
        return;
      }
      if (
        target.type !== "article-list" &&
        !latest.current.openEditor(target, opener)
      )
        latest.current.notify("暂时无法打开草稿，请重试");
    };
    timer = window.setTimeout(attempt, 0);
    return () => window.clearTimeout(timer);
  }, [accountId, author.cache, picker, returnKey]);

  const newest = state.status === "ready" ? state.newest : null;
  const text = countText(state);
  const label = articleEnabled ? "草稿箱" : "草稿";
  const detail = articleEnabled
    ? state.status === "ready"
      ? `${state.total === 0 ? "暂无作品草稿" : `${state.total} 份作品草稿`} + 专题草稿`
      : `${text} + 专题草稿`
    : text;

  return (
    <div className={styles.stack} data-drafts-card-stack="">
      <span
        aria-hidden="true"
        className={styles.stackLayer}
        data-layer="back"
      />
      <span
        aria-hidden="true"
        className={styles.stackLayer}
        data-layer="middle"
      />
      <article
        className={`${homeStyles.card} ${homeStyles.feedCard}`}
        data-drafts-card=""
        data-drafts-count={state.status === "ready" ? state.total : undefined}
        role="listitem"
      >
        {state.status !== "ready" ? (
          <div aria-hidden="true" className={styles.cardCover} />
        ) : (
          <CoverThumb
            className={styles.cardCover}
            maximum={120}
            onSettled={onSettled}
            src={newest?.coverSrc ?? null}
            text={newest === null ? "" : newest.excerpt || newest.title}
            textClassName={styles.coverText}
          />
        )}
        <div className={homeStyles.cardBody}>
          <h3 className={homeStyles.cardTitle}>{label}</h3>
          <p className={`${homeStyles.cardMetadata} ${styles.cardMeta}`}>
            {detail}
          </p>
        </div>
        <button
          ref={openerRef}
          aria-haspopup="dialog"
          aria-label={`${label}，${detail}`}
          className={homeStyles.cardAction}
          onClick={() => {
            setPickerType("work");
            setPicker(true);
          }}
          type="button"
        />
      </article>
      {picker
        ? // Outside the tab pager's DOM, so its swipe engine never sees the
          // picker's gestures; wheel events stop here for the same reason.
          createPortal(
            <div onWheel={(event) => event.stopPropagation()}>
              <DraftsPicker
                accountId={accountId}
                articleEnabled={articleEnabled}
                initialType={pickerType}
                onOpenArticle={(id) => {
                  pendingTarget.current = { type: "article-draft", id };
                  pendingArticleEpoch.current = authorClient.accountEpoch();
                  setPicker(false);
                }}
                onChanged={(total, first) =>
                  show({ status: "ready", total, newest: first })
                }
                onClose={() => setPicker(false)}
                onOpenDraft={(draftId) => {
                  pendingTarget.current = { type: "draft", id: draftId };
                  setPicker(false);
                }}
              />
            </div>,
            document.body,
          )
        : null}
    </div>
  );
};
