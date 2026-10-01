"use client";
import { UserIdentity } from "./user-identity";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { WorkVisibility } from "@moya/contracts";
import {
  toWorkAuthorshipPresentation,
  toWorkMediaPresentation,
} from "../detail/catalog-detail-presentation";
import { useCatalogDetailWithdrawal } from "../detail/catalog-detail-withdrawal";
import type { CatalogDetailPresentation } from "../detail/catalog-detail-presentation";
import type { CatalogDetailPresentationLoader } from "../detail/load-catalog-detail";
import detailStyles from "../detail/catalog-detail.module.css";
import {
  publishingClient,
  PublishingRequestError,
} from "../publishing/publishing-data";
import { usePublishingEntry } from "../publishing/publishing-entry";
import { requestIdentity } from "../shell/request-identity";
import { authorClient, AuthorRequestError } from "./author-data";
import { AuthorDialog } from "./author-dialog";
import { useAuthors } from "./author-context";
import { ContentActions } from "./content-actions";
import { UNTITLED_WORK_LABEL } from "./content-card";
import { useProductShell } from "../product-shell/product-shell";
import { recordLocalHistory } from "./local-library";
import {
  ownWorkAudienceNote,
  readOwnWorkAudience,
  recordOwnWorkAudience,
  setOwnWorkAudience,
  useOwnWorkAudience,
} from "./own-work-audience";

/** The pause before the one repeated read of the author's work. */
const READ_BACK_RETRY_MS = 2000;
export const loadWorkDetail: CatalogDetailPresentationLoader = async (
  id,
  signal,
) => {
  try {
    const work = await authorClient.work(id, signal);
    // Whether others can see the author's own work now (author-only).
    recordOwnWorkAudience(work);
    const label = work.title === "" ? UNTITLED_WORK_LABEL : work.title;
    return {
      state: "loaded",
      detail: {
        contentType: "work",
        id: work.id,
        authorId: work.authorId,
        authorName: work.authorName,
        authorStudioName: work.authorStudioName,
        canEdit: work.canEdit,
        available: work.available,
        firstPublishedAt: work.firstPublishedAt,
        editedAt: work.editedAt ?? null,
        ...(work.visibility === undefined
          ? {}
          : { visibility: work.visibility }),
        title: work.title,
        aliases: [],
        facts: [],
        sections: work.text
          ? [{ key: "description", title: "正文", text: work.text }]
          : [],
        ...(work.authorship === undefined
          ? {}
          : { authorship: toWorkAuthorshipPresentation(work.authorship) }),
        media: work.media.map((m) => toWorkMediaPresentation(m, label)),
        source: "runtime",
        sourceCitations: [],
      },
    };
  } catch (e) {
    return {
      state:
        e instanceof AuthorRequestError && e.status === 404
          ? "not-found"
          : "unavailable",
    };
  }
};

type WorkDetail = Extract<CatalogDetailPresentation, { contentType: "work" }>;

type ManagementIntent =
  | { readonly kind: "visibility"; readonly visibility: WorkVisibility }
  | { readonly kind: "delete" };

interface PendingIntent {
  readonly intent: ManagementIntent;
  /** Reused when a result was not confirmed: commands are idempotent per request. */
  readonly requestId: string;
}

const visibilityName = (visibility: WorkVisibility) =>
  visibility === "self" ? "仅自己可见" : "公开";

/**
 * States only what the answer confirms: the requested visibility as changed,
 * or, when the answer differs from the request, the visibility as it is.
 */
const visibilityResultText = (
  requested: WorkVisibility,
  answered: WorkVisibility,
) =>
  requested === answered
    ? `可见范围已改为${visibilityName(answered)}`
    : `可见范围：${visibilityName(answered)}`;

const DELETED_TEXT = "作品已永久删除";

const DELETED_NOTICE = {
  title: DELETED_TEXT,
  description: "此操作无法撤销。",
} as const;

/**
 * The author's own controls on a work (§11 item 11): edit, the requested
 * visibility and permanent deletion. Wording states what was changed,
 * never a delivery or review state. Busy controls stay focusable
 * (aria-disabled), so a result never leaves the focus behind.
 */
const WorkManagement = ({
  detail,
  onDeleted,
  onVisibility,
  deleted,
  visibility,
}: {
  detail: WorkDetail;
  onDeleted: () => void;
  onVisibility: (visibility: WorkVisibility) => void;
  /** Without a Detail that can withdraw its content, only the result stays. */
  deleted: boolean;
  visibility: WorkVisibility | undefined;
}) => {
  const author = useAuthors();
  const { openEditor } = usePublishingEntry();
  const withdraw = useCatalogDetailWithdrawal();
  const [confirm, setConfirm] = useState<"delete" | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    readonly tone: "status" | "error";
    readonly text: string;
  } | null>(null);
  const [unconfirmed, setUnconfirmed] = useState<PendingIntent | null>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // After a result, a control that disappeared with it (e.g. 重试) hands
  // the focus to the result line.
  const refocusRef = useRef(false);
  useLayoutEffect(() => {
    if (busy || !refocusRef.current) return;
    refocusRef.current = false;
    const focused = document.activeElement;
    if (focused === null || focused === document.body || !focused.isConnected)
      statusRef.current?.focus();
  }, [busy, message, deleted, unconfirmed]);

  const run = async (pending: PendingIntent) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setMessage(null);
    // 重试 stays (unavailable) while its own request runs; another command drops it.
    if (pending !== unconfirmed) setUnconfirmed(null);
    const { intent, requestId } = pending;
    try {
      if (intent.kind === "delete") {
        await publishingClient.deleteWork(detail.id, { requestId });
        if (!mounted.current) return;
        setUnconfirmed(null);
        // A toast of an earlier action (作品已提交) no longer describes this work.
        author.notify("");
        author.mutate();
        if (withdraw !== null) {
          // The Detail replaces media, actions and discussion with the result.
          withdraw(detail.id, DELETED_NOTICE);
          return;
        }
        setMessage({ tone: "status", text: DELETED_TEXT });
        // The controls are gone; the result line takes the focus.
        onDeleted();
        return;
      }
      const result = await publishingClient.setVisibility(detail.id, {
        requestId,
        visibility: intent.visibility,
      });
      if (!mounted.current) return;
      // The answer, not the request, decides what is shown.
      onVisibility(result.visibility);
      setUnconfirmed(null);
      author.notify("");
      setMessage({
        tone: "status",
        text: visibilityResultText(intent.visibility, result.visibility),
      });
      author.mutate();
    } catch (error) {
      if (!mounted.current) return;
      const unknown =
        error instanceof PublishingRequestError && error.outcomeUnknown;
      setUnconfirmed(unknown ? pending : null);
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "暂时无法完成，请重试",
      });
    } finally {
      busyRef.current = false;
      if (mounted.current) {
        refocusRef.current = true;
        setBusy(false);
      }
    }
  };

  const start = (intent: ManagementIntent) =>
    void run({ intent, requestId: requestIdentity() });

  const closeConfirm = (opener: HTMLButtonElement | null) => {
    setConfirm(null);
    window.requestAnimationFrame(() => {
      if (opener?.isConnected) opener.focus();
    });
  };

  const unavailable = busy ? true : undefined;

  return (
    <section
      aria-label="作品管理"
      className={detailStyles.workManagement}
      data-work-management=""
    >
      {deleted ? null : (
        <div className={detailStyles.workManagementRow}>
          <button
            aria-disabled={unavailable}
            aria-label="编辑"
            className={detailStyles.workIcon}
            onClick={(event) => {
              if (busyRef.current) return;
              // The editor's own status replaces any earlier toast.
              author.notify("");
              openEditor({ type: "work", id: detail.id }, event.currentTarget);
            }}
            type="button"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              width="24"
              height="24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L4 14z" />
            </svg>
          </button>
          <button
            aria-disabled={unavailable}
            aria-label="永久删除"
            className={detailStyles.workIcon}
            onClick={() => {
              if (!busyRef.current) setConfirm("delete");
            }}
            ref={deleteRef}
            type="button"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              width="24"
              height="24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" />
            </svg>
          </button>
          {visibility === undefined ? null : (
            <button
              aria-checked={visibility === "public"}
              aria-disabled={unavailable}
              aria-label="公开"
              className={detailStyles.visibilitySwitch}
              data-work-visibility={visibility}
              onClick={() => {
                if (!busyRef.current)
                  start({
                    kind: "visibility",
                    visibility: visibility === "public" ? "self" : "public",
                  });
              }}
              role="switch"
              title={
                visibility === "public"
                  ? "关闭后仅自己可见"
                  : "开启后按当前发布规则公开"
              }
              type="button"
            >
              <span
                aria-hidden="true"
                className={detailStyles.visibilityTrack}
              />
              <span>公开</span>
            </button>
          )}
        </div>
      )}
      <p
        aria-live="polite"
        className={detailStyles.workManagementStatus}
        data-tone={message?.tone}
        data-work-management-status=""
        ref={statusRef}
        role="status"
        tabIndex={-1}
      >
        {message?.text}
      </p>
      {unconfirmed !== null &&
      !deleted &&
      (busy || message?.tone === "error") ? (
        <div className={detailStyles.workManagementRow}>
          <button
            aria-disabled={unavailable}
            onClick={() => void run(unconfirmed)}
            type="button"
          >
            重试
          </button>
        </div>
      ) : null}
      {confirm === "delete" ? (
        <AuthorDialog
          onClose={() => closeConfirm(deleteRef.current)}
          title="永久删除"
        >
          <p className="phase4-muted">
            作品及其草稿、历史版本将永久删除，无法恢复。
          </p>
          <div className="phase4-actions">
            <button
              data-confirm-delete=""
              onClick={() => {
                closeConfirm(deleteRef.current);
                start({ kind: "delete" });
              }}
              type="button"
            >
              永久删除
            </button>
            <button
              onClick={() => closeConfirm(deleteRef.current)}
              type="button"
            >
              取消
            </button>
          </div>
        </AuthorDialog>
      ) : null}
    </section>
  );
};

const WorkAuthor = ({ detail }: { detail: WorkDetail }) => {
  const author = useAuthors();
  const shell = useProductShell();
  const scope = `${author.viewer?.id ?? "guest"}:${author.revision}:${detail.authorId}`;
  const [avatar, setAvatar] = useState<{
    scope: string;
    src: string | null;
  } | null>(null);
  useEffect(() => {
    if (
      author.checking ||
      author.sessionError ||
      author.viewer?.id === detail.authorId
    )
      return;
    const controller = new AbortController();
    void authorClient
      .profile(detail.authorId, controller.signal)
      .then((profile) => {
        if (!controller.signal.aborted)
          setAvatar({ scope, src: profile.avatar?.src ?? null });
      })
      .catch(() => {
        /* An unavailable profile uses the initial fallback. */
      });
    return () => controller.abort();
  }, [
    scope,
    author.checking,
    author.sessionError,
    author.viewer?.id,
    detail.authorId,
  ]);
  const src =
    author.checking || author.sessionError
      ? null
      : author.viewer?.id === detail.authorId
        ? author.avatarSrc
        : avatar?.scope === scope
          ? avatar.src
          : null;
  return (
    <button
      type="button"
      className={detailStyles.workAuthor}
      onClick={(event) =>
        shell.openProfile(detail.authorId, event.currentTarget)
      }
    >
      <span className={detailStyles.workAuthorAvatar}>
        {src ? (
          <img src={src} alt="" width="36" height="36" />
        ) : (
          [...detail.authorName][0]
        )}
      </span>
      <UserIdentity
        name={detail.authorName}
        studioName={detail.authorStudioName}
      />
    </button>
  );
};

export const DetailActions = ({
  detail,
}: {
  detail: CatalogDetailPresentation;
}) => {
  const author = useAuthors();
  const [deletedId, setDeletedId] = useState<string | null>(null);
  const [visibilityChange, setVisibilityChange] = useState<{
    readonly id: string;
    readonly value: WorkVisibility;
  } | null>(null);
  const readBack = useRef(0);
  // A read-back still waiting when the actions leave is not repeated.
  useEffect(
    () => () => {
      readBack.current += 1;
    },
    [],
  );
  const target = {
    type: detail.contentType === "work" ? "work" : "catalog",
    id: detail.id,
  } as const;
  // Only the confirmed author sees management; a third party never does.
  const owner =
    detail.contentType === "work" &&
    detail.canEdit &&
    author.viewer !== null &&
    author.viewer.id === detail.authorId;
  const ownerId = owner ? author.viewer!.id : null;
  // What the author's own view says about others seeing the work; null when
  // it never said (the loaded fields below decide then).
  const audience = useOwnWorkAudience(ownerId, owner ? detail.id : null);
  const deleted = deletedId === detail.id;
  const changedVisibility =
    visibilityChange?.id === detail.id ? visibilityChange.value : null;
  // Likes, favorites, sharing and the history record are public
  // interactions: for the author they follow whether others can see the
  // work now. Without that record, only a loaded public work that nothing
  // on this page changed counts.
  const ownerPublic =
    audience !== null
      ? audience.publiclyVisible === true
      : detail.contentType === "work" &&
        changedVisibility === null &&
        detail.visibility === "public" &&
        detail.firstPublishedAt !== null &&
        detail.firstPublishedAt !== undefined;
  const recordable =
    detail.contentType !== "work" ||
    (detail.available && !deleted && (!owner || ownerPublic));
  useEffect(() => {
    if (author.checking || author.sessionError || !recordable) return;
    try {
      recordLocalHistory(author.viewer?.id ?? null, target);
    } catch {
      author.notify("浏览记录无法保存在本机");
    }
  }, [detail.id, author.viewer?.id, author.checking, recordable]);
  if (detail.contentType !== "work")
    return (
      <div>
        <ContentActions target={target} title={detail.title} />{" "}
      </div>
    );
  /**
   * The answer names the visibility only. Self-only is never seen by others;
   * after 公开 the work is read again, because the work publication policy
   * decides whether others see it yet.
   */
  const followVisibility = (value: WorkVisibility) => {
    setVisibilityChange({ id: detail.id, value });
    if (ownerId === null) return;
    const run = ++readBack.current;
    setOwnWorkAudience(ownerId, detail.id, {
      publiclyVisible: value === "self" ? false : null,
      visibility: value,
    });
    if (value === "self") return;
    // Until the answer, nothing is offered and nothing is claimed. A failed
    // read is tried once more; after that the note says only that it cannot
    // be told, until the work loads again.
    const workId = detail.id;
    const replaced = () => run !== readBack.current;
    const readAgain = () => authorClient.work(workId);
    void Promise.resolve()
      .then(readAgain)
      .catch(async () => {
        await new Promise((resolve) => setTimeout(resolve, READ_BACK_RETRY_MS));
        if (replaced()) throw new Error("replaced");
        return readAgain();
      })
      .then((work) => {
        if (
          !replaced() &&
          work.id === workId &&
          work.canEdit &&
          work.authorId === ownerId
        )
          recordOwnWorkAudience(work);
      })
      .catch(() => {
        // Only the unknown state this change left, never a later load's record.
        if (
          !replaced() &&
          readOwnWorkAudience(ownerId, workId)?.publiclyVisible === null
        )
          setOwnWorkAudience(ownerId, workId, {
            publiclyVisible: null,
            visibility: value,
            unconfirmed: true,
          });
      });
  };
  // `available` lets the author open their own self-only or not yet public
  // work; a note tells the author when others cannot see it, never with a
  // pending or review label.
  const notice = !owner
    ? detail.available
      ? null
      : "此作品当前不可公开访问。"
    : deleted
      ? null
      : audience !== null
        ? ownWorkAudienceNote(audience)
        : detail.available
          ? null
          : "此作品当前不对其他人显示。";
  const interactive = detail.available && !deleted && (!owner || ownerPublic);
  return (
    <div>
      <div className={detailStyles.workAuthorRow}>
        <WorkAuthor detail={detail} />
        {notice === null ? null : <p data-work-notice="">{notice}</p>}
      </div>
      {owner ? (
        <WorkManagement
          detail={detail}
          onDeleted={() => setDeletedId(detail.id)}
          onVisibility={followVisibility}
          deleted={deleted}
          visibility={changedVisibility ?? detail.visibility}
        />
      ) : null}
      {interactive && (
        <ContentActions
          target={target}
          title={detail.title === "" ? UNTITLED_WORK_LABEL : detail.title}
        />
      )}{" "}
    </div>
  );
};
