"use client";
import { useRef, useState } from "react";
import { ConfirmationModal, useModal } from "@payloadcms/ui";
import {
  call,
  describeFailure,
  outcomeUnknown,
  workActionPhrases,
  workTitleOf,
} from "./api";
import type { OperatorWork } from "./api";
import styles from "./community.module.css";

/** Human decisions must carry an explicit reason; unrelated controls use none. */
export const readModerationReason = (value: string): string | null => {
  const reason = value.trim();
  return reason.length > 0 && reason.length <= 2000 ? reason : null;
};

export const ModerationReasonInput = ({
  value,
  onChange,
  disabled = false,
  label = "处置理由（必填）",
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
  readonly label?: string;
}) => (
  <div className={styles.reportField}>
    <label>
      {label}
      <textarea
        disabled={disabled}
        maxLength={2000}
        required
        rows={3}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </label>
    <span className={styles.secondary}>
      请先填写理由，再核对并确认决定。理由会提供给相关用户；批量处置逐项使用同一理由。
    </span>
  </div>
);

export interface SelectedOperation {
  readonly id: string;
  readonly label: string;
  readonly name: "set-featured" | "moderate-work" | "recommend-user";
  readonly input: Record<string, unknown>;
}

export type WorkBulkAction = "feature" | "unfeature" | "hidden" | "removed";

/**
 * The commands a selected-work action sends, and the rows it leaves alone
 * with the reason the operator reads. A non-public work cannot be featured,
 * a work never recommended has nothing to cancel, and a work already in the
 * requested state is not re-applied. A new explicit recommendation starts at
 * position 0; only an existing explicit row keeps its own position.
 */
export const planWorkOperations = (
  action: WorkBulkAction,
  works: readonly OperatorWork[],
  selected: ReadonlySet<string>,
): { operations: SelectedOperation[]; skipped: string[] } => {
  const operations: SelectedOperation[] = [];
  const skipped: string[] = [];
  for (const w of works) {
    if (w.authorDeleted || !selected.has(w.id)) continue;
    const label = workTitleOf(w);
    if (action === "feature" || action === "unfeature") {
      if (action === "feature" && w.publiclyVisible === false) {
        skipped.push(`${label}：未公开，不能推荐`);
        continue;
      }
      if (action === "unfeature" && !w.recommendation?.enabled) {
        skipped.push(`${label}：未推荐，无需取消`);
        continue;
      }
      operations.push({
        id: w.id,
        label,
        name: "set-featured",
        input: {
          target: { type: "work", id: w.id },
          enabled: action === "feature",
          position:
            w.recommendation?.source === "work" ? w.recommendation.position : 0,
          expectedVersion: w.recommendation?.version ?? 0,
        },
      });
      continue;
    }
    if (w.state === action) {
      skipped.push(`${label}：已是该状态，未处理`);
      continue;
    }
    operations.push({
      id: w.id,
      label,
      name: "moderate-work",
      input: { id: w.id, state: action, expectedVersion: w.version },
    });
  }
  return { operations, skipped };
};

/** The confirmation text for a selected-work action that restricts access. */
export const workBulkConfirmText: Record<"hidden" | "removed", string> = {
  hidden: `${workActionPhrases.hidden}：按现有管理规则限制访问，保留内容、原有身份、首次发布时间与审计记录。`,
  removed: `${workActionPhrases.removed}：按现有管理规则限制访问，保留内容、原有身份、首次发布时间与审计记录。`,
};

/** At most one current page, serial commands and per-item results. A lost
 * response retains its exact request identity; retries never repeat successes.
 * Unconfirmed items stay here until they are retried or explicitly abandoned;
 * the owning view learns their count through `onPending` and keeps them
 * mounted meanwhile.
 */
export const BulkActions = ({
  view,
  count,
  disabled,
  choices,
  skipped = [],
  prepare,
  onBusy,
  onPending,
  onComplete,
}: {
  /** Names the confirmation modal so views on one page never share one. */
  view: string;
  count: number;
  disabled: boolean;
  /** `confirm` is the body text of the confirmation asked before running. */
  choices: readonly {
    value: string;
    label: string;
    confirm?: string;
    requiresReason?: boolean;
  }[];
  /** Rows the last action left alone, each with its reason. */
  skipped?: readonly string[];
  prepare: (action: string) => SelectedOperation[];
  onBusy: (busy: boolean) => void;
  onPending?: (count: number) => void;
  onComplete: () => Promise<void>;
}) => {
  const { openModal, closeModal } = useModal();
  const modalSlug = `community-bulk-confirm-${view}`;
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<SelectedOperation[]>([]);
  const [reasonDraft, setReasonDraft] = useState("");
  const [results, setResults] = useState<string[]>([]);
  const [confirming, setConfirming] = useState<{
    label: string;
    confirm: string;
    count: number;
    operations: SelectedOperation[];
    reason?: string;
  } | null>(null);
  const run = async (operations: SelectedOperation[]) => {
    if (lock.current || operations.length === 0 || operations.length > 50)
      return;
    lock.current = true;
    setBusy(true);
    onBusy(true);
    const retry: SelectedOperation[] = [],
      lines: string[] = [];
    try {
      for (const op of operations) {
        try {
          await call(op.name, op.input);
          lines.push(`${op.label}：已完成`);
        } catch (error) {
          lines.push(`${op.label}：${describeFailure(error).text}`);
          if (outcomeUnknown(error)) retry.push(op);
        }
        setResults([...lines]);
      }
      setPending(retry);
      onPending?.(retry.length);
      await onComplete();
    } finally {
      lock.current = false;
      setBusy(false);
      onBusy(false);
    }
  };
  const prepareSnapshot = (
    action: string,
    reason?: string,
  ): SelectedOperation[] => {
    const prepared = prepare(action);
    if (
      prepared.some((operation) => operation.name === "moderate-work") &&
      readModerationReason(reason ?? "") === null
    )
      return [];
    return prepared.map((op) => ({
      ...op,
      input: {
        ...structuredClone(op.input),
        ...(op.name === "moderate-work"
          ? { reason: readModerationReason(reason ?? "")! }
          : {}),
        requestId: crypto.randomUUID(),
      },
    }));
  };
  const abandon = () => {
    setPending([]);
    setResults([]);
    onPending?.(0);
    void onComplete();
  };
  const lines = [...results, ...skipped];
  return (
    <section aria-label="批量操作" className={styles.bulkBar}>
      {choices.some((choice) => choice.requiresReason) ? (
        <ModerationReasonInput
          label="批量处置理由（必填）"
          value={reasonDraft}
          onChange={setReasonDraft}
          disabled={busy || pending.length > 0}
        />
      ) : null}
      <div className={styles.actions}>
        {pending.length > 0 ? (
          <span>未确认 {pending.length} 项</span>
        ) : (
          <span>已选择 {count} 项（当前页）</span>
        )}
        {choices.map((choice) => (
          <button
            key={choice.value}
            type="button"
            className={styles.actionButton}
            disabled={
              disabled ||
              busy ||
              count === 0 ||
              pending.length > 0 ||
              (choice.requiresReason === true &&
                readModerationReason(reasonDraft) === null)
            }
            onClick={() => {
              if (choice.confirm === undefined) {
                void run(
                  prepareSnapshot(
                    choice.value,
                    choice.requiresReason
                      ? readModerationReason(reasonDraft)!
                      : undefined,
                  ),
                );
                return;
              }
              setConfirming({
                operations: prepareSnapshot(
                  choice.value,
                  choice.requiresReason
                    ? readModerationReason(reasonDraft)!
                    : undefined,
                ),
                label: choice.label,
                confirm: choice.confirm,
                count,
                ...(choice.requiresReason
                  ? { reason: readModerationReason(reasonDraft)! }
                  : {}),
              });
              openModal(modalSlug);
            }}
          >
            {choice.label}
          </button>
        ))}
        {pending.length > 0 ? (
          <>
            <button
              type="button"
              className={styles.actionButton}
              disabled={busy || disabled}
              onClick={() => void run(pending)}
            >
              重试未确认的 {pending.length} 项
            </button>
            <button
              type="button"
              className={styles.actionButton}
              disabled={busy || disabled}
              onClick={abandon}
            >
              放弃未确认项
            </button>
          </>
        ) : null}
      </div>
      {lines.length > 0 ? (
        <ul role="status">
          {lines.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      ) : null}
      <ConfirmationModal
        heading="确认批量操作"
        modalSlug={modalSlug}
        cancelLabel="取消"
        confirmLabel="确认执行"
        confirmingLabel="处理中…"
        body={
          <>
            <p>
              {confirming === null
                ? null
                : `${confirming.label}所选 ${confirming.count} 项。${confirming.confirm}`}
            </p>
            {confirming?.reason === undefined ? null : (
              <p className={styles.reportText}>处置理由：{confirming.reason}</p>
            )}
          </>
        }
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          closeModal(modalSlug);
          if (confirming !== null) void run(confirming.operations);
          setConfirming(null);
        }}
      />
    </section>
  );
};
