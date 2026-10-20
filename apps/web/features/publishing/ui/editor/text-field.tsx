"use client";

import { useId, useLayoutEffect, useRef } from "react";

import { checkEditorText, issueMessage } from "./editor-text";
import styles from "./editor.module.css";

import type { EditorField } from "./editor-session-state";
import type { EditorTextRule } from "./editor-text";
import type { ReactNode } from "react";

/**
 * One text field with the shared counting rule: the counter shows code points
 * after normalization, and a local issue or the Backend's field failure is
 * shown at the field itself (E08).
 */
export const TextField = ({
  field,
  label,
  value,
  onChange,
  rule,
  optional = false,
  multiline = false,
  size,
  error = null,
  placeholder,
  hint,
  autoFocus = false,
}: {
  readonly field: EditorField;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly rule: EditorTextRule;
  readonly optional?: boolean;
  readonly multiline?: boolean;
  readonly size?: "small";
  /** A failure the account reported for this field. */
  readonly error?: string | null;
  readonly placeholder?: string;
  readonly hint?: ReactNode;
  readonly autoFocus?: boolean;
}) => {
  const id = useId();
  const counterId = useId();
  const errorId = useId();
  const hintId = useId();
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const checked = checkEditorText(value, rule);
  const local =
    checked.issue === null
      ? null
      : issueMessage(label, checked.issue, rule.maximum);
  const message = error ?? local;
  const describedBy = [
    counterId,
    message === null ? null : errorId,
    hint === undefined ? null : hintId,
  ]
    .filter((entry): entry is string => entry !== null)
    .join(" ");

  // The body grows with its text; line breaks are kept as typed.
  useLayoutEffect(() => {
    const area = areaRef.current;
    if (area === null || size === "small") return;
    area.style.height = "auto";
    if (area.scrollHeight > 0) area.style.height = `${area.scrollHeight}px`;
  }, [value, size]);

  const common = {
    "aria-required": field === "title" || undefined,
    "aria-describedby": describedBy,
    "aria-invalid": message === null ? undefined : true,
    className: multiline ? styles.textarea : styles.input,
    "data-editor-autofocus": autoFocus ? "" : undefined,
    "data-editor-input": field,
    id,
    placeholder,
    value,
  } as const;

  return (
    <div className={styles.field} data-editor-field={field}>
      <div className={styles.fieldHead}>
        <label className={styles.label} htmlFor={id}>
          {label}
          {optional ? <span className={styles.optional}>可选</span> : null}
        </label>
        <span
          className={styles.counter}
          data-over={checked.length > rule.maximum ? "true" : undefined}
          id={counterId}
        >
          <span aria-hidden="true">
            {checked.length}/{rule.maximum}
          </span>
          <span className={styles.visuallyHidden}>
            已输入 {checked.length} 字，最多 {rule.maximum} 字
          </span>
        </span>
      </div>
      {multiline ? (
        <textarea
          {...common}
          data-size={size}
          onChange={(event) => onChange(event.currentTarget.value)}
          ref={areaRef}
          rows={size === "small" ? 3 : 6}
        />
      ) : (
        <input
          {...common}
          autoComplete="off"
          onChange={(event) => onChange(event.currentTarget.value)}
          type="text"
        />
      )}
      {message === null ? null : (
        <p className={styles.error} id={errorId}>
          {message}
          {checked.issue === "line_break" ? (
            <button
              className={styles.inlineAction}
              onClick={() => onChange(value.replace(/[\r\n]+/gu, " ").trim())}
              type="button"
            >
              移除换行
            </button>
          ) : null}
        </p>
      )}
      {hint === undefined ? null : (
        <p className={styles.hint} id={hintId}>
          {hint}
        </p>
      )}
    </div>
  );
};
