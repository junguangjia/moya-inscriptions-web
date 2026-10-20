"use client";

import { forwardRef } from "react";

import { bodyRule, checkEditorText, titleRule } from "./editor-text";
import { UNNAMED_WORK } from "./preview";
import { publicationRequirement } from "./text-settings";
import styles from "./editor.module.css";

import type {
  EditorField,
  EditorSessionState,
  FieldCheck,
  Readiness,
} from "./editor-session-state";
import type { EditorMediaSource } from "./preview";
import type { SubmissionState } from "../../submission-reconcile";

const visibilityLabels = { public: "公开", self: "仅自己可见" } as const;
const authorshipLabels = {
  original: "原创",
  copy_practice: "临摹或练习",
  material_sharing: "素材分享",
} as const;
/** Nothing is claimed for a work whose author declared no 作品性质 (C05). */
const AUTHORSHIP_UNSET = "未设置";

const EXCERPT_POINTS = 80;

const excerptOf = (body: string): string => {
  const points = [...checkEditorText(body, bodyRule).value];
  return points.length <= EXCERPT_POINTS
    ? points.join("")
    : `${points.slice(0, EXCERPT_POINTS).join("").trimEnd()}…`;
};

const isBusy = (submission: SubmissionState, resolving: boolean): boolean =>
  resolving ||
  submission.status === "queued" ||
  submission.status === "submitting" ||
  submission.status === "reconciling" ||
  submission.status === "confirmed";

export interface ConfirmationGate {
  readonly state: Pick<EditorSessionState, "title" | "body" | "items">;
  readonly readiness: Readiness;
  readonly issues: readonly FieldCheck[];
  readonly submission: SubmissionState;
  readonly resolving?: boolean;
  /** Phone new-work intent: accepted before transient media work settles. */
  readonly background?: boolean;
}

/**
 * Whether 发布 (保存更新) is disabled now. The sheet's own button uses it; a
 * primary action drawn elsewhere (a sticky bar) must follow the same rule.
 */
export const confirmationBlocked = ({
  state,
  readiness,
  issues,
  submission,
  resolving = false,
  background = false,
}: ConfirmationGate): boolean =>
  publicationRequirement(state) !== null ||
  (!background && (readiness.blocking > 0 || !readiness.confirmed)) ||
  issues.length > 0 ||
  isBusy(submission, resolving) ||
  submission.status === "unconfirmed";

export interface ConfirmationSheetProps {
  readonly state: EditorSessionState;
  readonly readiness: Readiness;
  /** The cover the card will show (the chosen cover, else the first item). */
  readonly cover: EditorMediaSource | null;
  readonly issues: readonly FieldCheck[];
  readonly submission: SubmissionState;
  /** The editor is still resolving where to submit from (before the request). */
  readonly resolving?: boolean;
  readonly background?: boolean;
  /** Staged files the author has not confirmed yet (not part of the work). */
  readonly unconfirmedFiles: number;
  readonly onSubmit: () => void;
  readonly onGoToField: (field: EditorField) => void;
  readonly onCheckAgain: () => void;
  readonly onRetry: () => void;
  /** "hidden" leaves out the summary card (a screen that shows the work itself). */
  readonly summary?: "card" | "hidden";
  /** "hidden" leaves out 发布 for a primary action drawn elsewhere. */
  readonly primary?: "inline" | "hidden";
  /**
   * A photo needs the author and sits a screen away (the phone 发布): the
   * blocking readiness line ends in 前往处理, which goes to it.
   */
  readonly onResolveMedia?: (() => void) | undefined;
}

/**
 * The short final confirmation (E04, P05, U11): what is about to be
 * submitted, exact readiness counts that keep 发布 disabled until every
 * retained item is ready or removed, one primary action, the reconciling
 * state of a lost answer and failures placed at their fields.
 */
export const ConfirmationSheet = forwardRef<
  HTMLButtonElement,
  ConfirmationSheetProps
>(function ConfirmationSheet(
  {
    state,
    readiness,
    cover,
    issues,
    submission,
    resolving = false,
    background = false,
    unconfirmedFiles,
    onSubmit,
    onGoToField,
    onCheckAgain,
    onRetry,
    summary = "card",
    primary = "inline",
    onResolveMedia,
  },
  primaryRef,
) {
  const title = checkEditorText(state.title, titleRule).value;
  const excerpt = excerptOf(state.body);
  const busy = isBusy(submission, resolving);
  const blocked = confirmationBlocked({
    state,
    readiness,
    issues,
    submission,
    resolving,
    background,
  });
  const primaryLabel = state.kind === "edit" ? "保存更新" : "发布";
  const requirement = publicationRequirement(state);
  const fieldErrors = Object.entries(state.fieldErrors).filter(
    (entry): entry is [EditorField, string] =>
      typeof entry[1] === "string" && entry[0] !== "general",
  );
  const generalError = state.fieldErrors.general ?? null;

  // A lost answer being reconciled outranks the request still in progress.
  const status =
    submission.status === "queued"
      ? "正在后台上传，完成后自动发布"
      : submission.status === "reconciling"
        ? "正在确认结果…"
        : submission.status === "confirmed"
          ? state.kind === "edit"
            ? "更新已保存"
            : "作品已提交"
          : resolving || submission.status === "submitting"
            ? state.kind === "edit"
              ? "正在保存更新…"
              : "正在发布…"
            : // Refused as not ready: the count, while the account is asked again.
              submission.status === "not_ready" && readiness.blocking > 0
              ? `${submission.itemKeys.length} 项正在处理，完成后可再${primaryLabel}`
              : "";

  return (
    <section
      aria-label={`确认${primaryLabel}`}
      className={styles.sheet}
      data-editor-confirmation=""
    >
      {summary === "hidden" ? null : (
        <div className={styles.summary}>
          {cover !== null ? (
            <div className={styles.summaryCover} data-editor-summary="cover">
              <img alt="" src={cover.src} />
            </div>
          ) : excerpt !== "" ? (
            <p className={styles.summaryText} data-editor-summary="text">
              {excerpt}
            </p>
          ) : (
            <div className={styles.summaryCover} data-editor-summary="empty" />
          )}
          <div className={styles.summaryBody}>
            <h3
              className={styles.summaryTitle}
              data-unnamed={title === "" ? "" : undefined}
            >
              {title === "" ? UNNAMED_WORK : title}
            </h3>
            <dl className={styles.facts}>
              <div>
                <dt>可见范围</dt>
                <dd data-editor-summary-visibility={state.visibility}>
                  {visibilityLabels[state.visibility]}
                </dd>
              </div>
              <div>
                <dt>作品性质</dt>
                <dd
                  data-editor-summary-authorship={
                    state.authorshipKind ?? "unset"
                  }
                >
                  {state.authorshipKind === null
                    ? AUTHORSHIP_UNSET
                    : authorshipLabels[state.authorshipKind]}
                </dd>
              </div>
              <div>
                <dt>图片</dt>
                <dd>
                  {state.items.length === 0
                    ? "未添加，至少需要一张图片"
                    : `${state.items.length} 项`}
                </dd>
              </div>
            </dl>
          </div>
        </div>
      )}

      {state.items.length === 0 ? null : (
        <p
          aria-live="polite"
          className={styles.readiness}
          data-blocking={readiness.blocking > 0 ? "true" : undefined}
          data-editor-readiness=""
          role="status"
        >
          {background && (readiness.blocking > 0 || !readiness.confirmed)
            ? "图片将在后台上传和处理，完成后自动发布，可继续浏览"
            : readiness.blocking > 0 && readiness.text !== null
              ? `${readiness.text}。全部就绪或移除后才能${primaryLabel}`
              : readiness.confirmed
                ? `全部 ${readiness.ready} 项已就绪`
                : "正在确认图片状态…"}
          {!background &&
          readiness.blocking > 0 &&
          onResolveMedia !== undefined ? (
            <button
              className={styles.inlineAction}
              data-editor-resolve-media=""
              onClick={onResolveMedia}
              type="button"
            >
              前往处理
            </button>
          ) : null}
        </p>
      )}
      {unconfirmedFiles > 0 ? (
        <p className={styles.hint}>
          还有 {unconfirmedFiles} 个选择的文件没有添加，不会包含在作品中。
        </p>
      ) : null}

      {requirement !== null ? (
        <p className={styles.error} data-editor-requirement="">
          {requirement}
        </p>
      ) : null}

      {issues.length + fieldErrors.length === 0 ? null : (
        <ul className={styles.issues} data-editor-issues="">
          {issues.map((issue) => (
            <li key={`local-${issue.field}`}>
              {issue.message}
              <button
                className={styles.inlineAction}
                onClick={() => onGoToField(issue.field)}
                type="button"
              >
                前往修改
              </button>
            </li>
          ))}
          {fieldErrors
            .filter(([field]) => !issues.some((issue) => issue.field === field))
            .map(([field, message]) => (
              <li key={`account-${field}`}>
                {message}
                <button
                  className={styles.inlineAction}
                  onClick={() => onGoToField(field)}
                  type="button"
                >
                  前往查看
                </button>
              </li>
            ))}
        </ul>
      )}

      {generalError === null ? null : (
        <p className={styles.error} role="alert">
          {generalError}
        </p>
      )}

      {submission.status === "unconfirmed" ? (
        <div className={styles.notice} data-tone="error" role="alert">
          <span>{submission.message}</span>
          <button
            className={styles.inlineAction}
            onClick={onCheckAgain}
            type="button"
          >
            再次检查
          </button>
          <button
            className={styles.inlineAction}
            onClick={onRetry}
            type="button"
          >
            重试
          </button>
        </div>
      ) : null}

      <p
        aria-live="polite"
        className={status === "" ? styles.visuallyHidden : styles.readiness}
        data-editor-submission={submission.status}
        role="status"
      >
        {status}
      </p>

      {primary === "hidden" ? null : (
        <div className={styles.sheetActions}>
          <button
            ref={primaryRef}
            aria-busy={busy || undefined}
            className={styles.primaryButton}
            data-editor-submit=""
            disabled={blocked}
            onClick={onSubmit}
            type="button"
          >
            {primaryLabel}
          </button>
        </div>
      )}
    </section>
  );
});
