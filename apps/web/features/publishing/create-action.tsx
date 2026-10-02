"use client";

import searchStyles from "../search/search.module.css";
import styles from "./create-action.module.css";
import {
  useGlobalUploadProgress,
  useUploadSession,
} from "./publishing-provider";
import { usePublishingEntry } from "./publishing-entry";

import type { EditorTarget } from "../product-shell/product-history";
import type { EditorSessionView } from "./publishing-runtime";
import type { UploadManagerSnapshot, UploadItemPhase } from "./upload-manager";

/** Longer counts stay legible inside the 60px (44px minimized) action. */
const countText = (count: number) => (count > 99 ? "99+" : String(count));

/** Bytes are only meaningful while an item is being transferred. */
const TRANSFER_PHASES: ReadonlySet<UploadItemPhase> = new Set([
  "queued",
  "uploading",
  "paused",
]);

/** Work in progress without a byte measure: preparing, or processing after 100 %. */
const UNMEASURED_PHASES: ReadonlySet<UploadItemPhase> = new Set([
  "waiting",
  "preprocessing",
  "registering",
  "uploaded",
  "processing",
]);

export type CreateActionRing =
  | { readonly kind: "track" }
  | { readonly kind: "indeterminate" }
  | { readonly kind: "determinate"; readonly fraction: number };

/**
 * The ring for the session's unfinished items only: ready items never count
 * as sent, a finished transfer is not shown as done while the Backend still
 * processes (100 % is not ready), and an empty arc is not drawn.
 */
export const createActionRing = (
  uploads: UploadManagerSnapshot | null,
): CreateActionRing => {
  let sent = 0;
  let total = 0;
  let unmeasured = false;
  for (const item of uploads?.items ?? []) {
    if (TRANSFER_PHASES.has(item.phase))
      for (const component of item.components) {
        total += component.byteSize;
        sent +=
          component.phase === "received"
            ? component.byteSize
            : component.bytesSent;
      }
    else if (UNMEASURED_PHASES.has(item.phase)) unmeasured = true;
  }
  const fraction = total > 0 ? Math.min(1, sent / total) : 0;
  if (fraction > 0) return { kind: "determinate", fraction };
  return unmeasured || total > 0
    ? { kind: "indeterminate" }
    : { kind: "track" };
};

/**
 * Where the plus returns: the kept editor session's entry. A new work whose
 * draft was saved meanwhile reopens as that draft (as the editor's own entry
 * does), so a reload finds the draft instead of a blank editor.
 */
const resumeTarget = (
  session: EditorSessionView | null,
  draftId: string | null,
): EditorTarget | null => {
  if (session === null) return null;
  if (
    session.target.type === "new" &&
    session.saveMode === "saved" &&
    draftId !== null
  )
    return { type: "draft", id: draftId };
  return session.target;
};

/**
 * The author composition's single floating dock action. While an editor
 * session still prepares, transfers or processes media, or holds unsaved
 * changes, the same action carries a progress ring and the unfinished item
 * count (§11 item 9). Whenever an editor session is kept, it returns to that
 * editor, also once its work has settled. There is no second button.
 */
export const CreateWorkAction = ({
  onNew,
  newLabel = "发布作品",
}: {
  readonly onNew?: (opener: HTMLElement) => void;
  readonly newLabel?: string;
} = {}) => {
  const { checking, openEditor } = usePublishingEntry();
  const progress = useGlobalUploadProgress();
  const upload = useUploadSession();
  const draftId = upload.autosave?.draftId ?? upload.session?.draftId ?? null;
  const resume = resumeTarget(upload.session, draftId);
  const active = resume !== null && progress.active;
  const ring = active ? createActionRing(upload.uploads) : null;
  const unfinished = progress.summary?.blocking ?? 0;
  const state =
    progress.readiness ??
    (progress.hasUnsavedChanges ? "有未保存的更改" : null);
  const label =
    resume === null
      ? newLabel
      : `返回正在编辑的作品${active && state !== null ? `：${state}` : ""}`;
  return (
    <>
      <button
        aria-haspopup="dialog"
        aria-label={label}
        className={`${searchStyles.trigger} ${styles.action}`}
        data-create-work-action=""
        data-create-work-progress={active ? "active" : undefined}
        data-create-work-resume={resume === null ? undefined : resume.type}
        data-paused={active && progress.paused ? "true" : undefined}
        disabled={checking}
        onClick={(event) =>
          resume === null && onNew !== undefined
            ? onNew(event.currentTarget)
            : openEditor(resume ?? { type: "new" }, event.currentTarget)
        }
        type="button"
      >
        {/* Drawn locally: the shared UI icon set is outside this task's scope. */}
        <svg
          aria-hidden="true"
          className={styles.icon}
          data-create-work-icon=""
          focusable="false"
          viewBox="0 0 24 24"
        >
          <path d="M12 5v14m-7-7h14" />
        </svg>
        {ring === null ? null : (
          <svg
            aria-hidden="true"
            className={styles.ring}
            data-create-work-ring={ring.kind}
            focusable="false"
            viewBox="0 0 48 48"
          >
            <circle
              className={styles.ringTrack}
              cx="24"
              cy="24"
              pathLength={100}
              r="21"
            />
            {ring.kind === "track" ? null : (
              <circle
                className={styles.ringArc}
                cx="24"
                cy="24"
                data-create-work-ring-arc={ring.kind}
                data-create-work-ring-fraction={
                  ring.kind === "determinate" ? ring.fraction : undefined
                }
                pathLength={100}
                r="21"
                strokeDasharray={
                  ring.kind === "determinate"
                    ? `${Math.max(1, Math.round(ring.fraction * 100))} 100`
                    : undefined
                }
              />
            )}
          </svg>
        )}
        {!active || unfinished === 0 ? null : (
          <span
            aria-hidden="true"
            className={styles.count}
            data-create-work-count=""
          >
            {countText(unfinished)}
          </span>
        )}
      </button>
      {/* Phase changes only (counts, not bytes), announced politely. */}
      <span
        aria-live="polite"
        className={searchStyles.visuallyHidden}
        data-create-work-status=""
        role="status"
      >
        {active ? (progress.readiness ?? "") : ""}
      </span>
    </>
  );
};
