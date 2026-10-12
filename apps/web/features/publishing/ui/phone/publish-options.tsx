"use client";

import { Icon } from "@moya/ui";
import { useEffect, useId, useRef } from "react";

import {
  AUTHORSHIP_KINDS,
  REFERENCE_INPUTS,
} from "../editor/authorship-fields";
import { checkEditorText, issueMessage } from "../editor/editor-text";
import {
  VISIBILITY_EDIT_HINT,
  VISIBILITY_OPTIONS,
} from "../editor/visibility-field";
import editorStyles from "../editor/editor.module.css";
import styles from "./publish-screen.module.css";
import selectStyles from "./select-screen.module.css";
import { PhoneSheet } from "./tile-menu";

import type {
  EditorSessionState,
  EditorSessionStore,
  ReferenceField,
} from "../editor/editor-session-state";
import type { EditorTextRule } from "../editor/editor-text";
import type { KeyboardEvent, RefObject } from "react";

/**
 * 发布's settings (#244 r3, mockup A `.optSec`): 作品性质 as chips and
 * 可见范围 as a two-way segment, each under a small heading with a one-line
 * description, and the reference fields of 临摹或练习 and 素材分享 in a bottom
 * sheet. The semantics are `AuthorshipFields`' and `VisibilityField`'s (the
 * desktop editor keeps those): nothing is preselected for 作品性质 and a
 * choice can be cleared, the references are optional and write straight to
 * the session, with the same counting rule and messages.
 */

/** A counter shows once the text reaches this share of its limit (mockup A `setCounter`). */
const COUNTER_FROM = 0.8;

const isReferenceKind = (kind: EditorSessionState["authorshipKind"]) =>
  kind === "copy_practice" || kind === "material_sharing";

interface ChoiceOption<T extends string> {
  readonly value: T;
  readonly label: string;
}

/**
 * One radio group of buttons (mockup A `.chips`, `.seg`): one tab stop, the
 * arrow keys, Home and End move the choice and focus with it. With
 * `clearable`, the checked option pressed again clears the group (作品性质's
 * 「未设置」, mockup A).
 */
const Choices = <T extends string>({
  options,
  value,
  onChoose,
  clearable = false,
  className,
  optionClassName,
  labelledBy,
  describedBy,
  hook,
  face = false,
}: {
  readonly options: readonly ChoiceOption<T>[];
  readonly value: T | null;
  readonly onChoose: (value: T | null) => void;
  readonly clearable?: boolean;
  readonly className: string | undefined;
  readonly optionClassName: string | undefined;
  readonly labelledBy: string;
  readonly describedBy: string;
  /** `data-publish-choice` on each option. */
  readonly hook: string;
  /** The words sit on their own pill inside a larger target (A `.chip span`). */
  readonly face?: boolean;
}) => {
  const group = useRef<HTMLDivElement>(null);
  const tabStop = value ?? options[0]?.value ?? null;
  const step = (event: KeyboardEvent<HTMLDivElement>) => {
    const from = options.findIndex(
      (option) =>
        event.target instanceof HTMLElement &&
        option.value === event.target.dataset.publishChoice,
    );
    if (from < 0) return;
    const last = options.length - 1;
    const to =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? from === last
          ? 0
          : from + 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? from === 0
            ? last
            : from - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (to === null) return;
    event.preventDefault();
    const next = options[to]!;
    onChoose(next.value);
    group.current
      ?.querySelector<HTMLElement>(`[data-publish-choice="${next.value}"]`)
      ?.focus();
  };
  return (
    <div
      ref={group}
      aria-describedby={describedBy}
      aria-labelledby={labelledBy}
      className={className}
      data-publish-choices={hook}
      onKeyDown={step}
      role="radiogroup"
    >
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            aria-checked={checked}
            className={optionClassName}
            data-publish-choice={option.value}
            onClick={() => onChoose(checked && clearable ? null : option.value)}
            role="radio"
            tabIndex={option.value === tabStop ? 0 : -1}
            type="button"
          >
            {face ? (
              <span className={styles.chipFace}>{option.label}</span>
            ) : (
              option.label
            )}
          </button>
        );
      })}
    </div>
  );
};

/** A reference field's own message: the account's, else the local check's. */
const referenceIssue = (
  state: EditorSessionState,
  field: ReferenceField,
  label: string,
  rule: EditorTextRule,
): string | null => {
  const error = state.fieldErrors[field];
  if (error !== undefined) return error;
  const checked = checkEditorText(state.reference[field], rule);
  return checked.issue === null
    ? null
    : issueMessage(label, checked.issue, rule.maximum);
};

export interface AuthorshipSectionProps {
  readonly state: EditorSessionState;
  readonly store: EditorSessionStore;
  /** 参考作品 · 原作者 · 来源: opens the reference sheet. */
  readonly onOpenReferences: () => void;
}

/**
 * 作品性质 (C05, mockup A): the heading with 可选 and, once chosen, 清除选择;
 * the three kinds as chips; the chosen kind's description (or 未设置); and
 * for 临摹或练习 and 素材分享 one line naming the references so far, which
 * opens their sheet.
 */
export const AuthorshipSection = ({
  state,
  store,
  onOpenReferences,
}: AuthorshipSectionProps) => {
  const headingId = useId();
  const descriptionId = useId();
  const choices = useRef<HTMLDivElement>(null);
  const kind = state.authorshipKind;
  const chosen = AUTHORSHIP_KINDS.find((entry) => entry.kind === kind) ?? null;
  const values = REFERENCE_INPUTS.map((input) =>
    state.reference[input.field].trim(),
  ).filter((value) => value !== "");
  const issue =
    REFERENCE_INPUTS.map((input) =>
      referenceIssue(state, input.field, input.label, input.rule),
    ).find((message) => message !== null) ?? null;
  return (
    <section
      aria-labelledby={headingId}
      className={styles.optSection}
      data-editor-field="authorship"
      data-publish-option="authorship"
      ref={choices}
    >
      <div
        className={styles.optHead}
        data-editor-authorship-state={kind ?? "unset"}
      >
        <h3 id={headingId}>作品性质</h3>
        <span className={styles.optOptional}>可选</span>
        {kind === null ? null : (
          <button
            className={`${styles.inlineAction} ${styles.optClear}`}
            data-editor-authorship-clear=""
            onClick={() => {
              store.setAuthorshipKind(null);
              // The button goes away with the choice it clears, so the
              // keyboard stays in the group instead of falling to the page.
              choices.current
                ?.querySelector<HTMLElement>('[role="radio"]')
                ?.focus();
            }}
            type="button"
          >
            清除选择
          </button>
        )}
      </div>
      <Choices
        className={styles.chips}
        describedBy={descriptionId}
        face
        hook="authorship"
        labelledBy={headingId}
        onChoose={store.setAuthorshipKind}
        optionClassName={styles.chip}
        options={AUTHORSHIP_KINDS.map((entry) => ({
          value: entry.kind,
          label: entry.label,
        }))}
        value={kind}
        clearable
      />
      <p
        className={styles.optDescription}
        data-unset={chosen === null ? "" : undefined}
        id={descriptionId}
      >
        {chosen?.description ?? "未设置"}
      </p>
      {isReferenceKind(kind) ? (
        <button
          aria-haspopup="dialog"
          className={styles.refLine}
          data-publish-references=""
          onClick={onOpenReferences}
          type="button"
        >
          <span className={styles.refText}>
            <b>参考作品 · 原作者 · 来源</b>
            <small data-error={issue === null ? undefined : ""}>
              {issue ?? (values.length > 0 ? values.join(" · ") : "可选")}
            </small>
          </span>
          <Icon
            aria-hidden="true"
            className={styles.refChevron}
            name="next"
            size="sm"
          />
        </button>
      ) : null}
    </section>
  );
};

/** 可见范围 (P03, mockup A `.seg`): 公开 | 仅自己可见 and what the choice means. */
export const VisibilitySection = ({
  state,
  store,
}: {
  readonly state: EditorSessionState;
  readonly store: EditorSessionStore;
}) => {
  const headingId = useId();
  const descriptionId = useId();
  const hintId = useId();
  const chosen =
    VISIBILITY_OPTIONS.find((option) => option.value === state.visibility) ??
    VISIBILITY_OPTIONS[0]!;
  const edit = state.kind === "edit";
  return (
    <section
      aria-labelledby={headingId}
      className={styles.optSection}
      data-editor-field="visibility"
      data-publish-option="visibility"
    >
      <div className={styles.optHead}>
        <h3 id={headingId}>可见范围</h3>
      </div>
      <Choices
        className={styles.segment}
        describedBy={edit ? `${descriptionId} ${hintId}` : descriptionId}
        hook="visibility"
        labelledBy={headingId}
        onChoose={(value) => {
          if (value !== null) store.setVisibility(value);
        }}
        optionClassName={styles.segmentButton}
        options={VISIBILITY_OPTIONS}
        value={state.visibility}
      />
      <p className={styles.optDescription} id={descriptionId}>
        {chosen.description}
      </p>
      {edit ? (
        <p className={styles.optDescription} id={hintId}>
          {VISIBILITY_EDIT_HINT}
        </p>
      ) : null}
    </section>
  );
};

/** One reference field as mockup A's `.fld`: a filled input under its label. */
const SheetField = ({
  field,
  label,
  rule,
  multiline,
  value,
  error,
  onChange,
}: {
  readonly field: ReferenceField;
  readonly label: string;
  readonly rule: EditorTextRule;
  readonly multiline: boolean;
  readonly value: string;
  /** A failure the account reported for this field. */
  readonly error: string | null;
  readonly onChange: (value: string) => void;
}) => {
  const id = useId();
  const counterId = useId();
  const errorId = useId();
  const checked = checkEditorText(value, rule);
  const local =
    checked.issue === null
      ? null
      : issueMessage(label, checked.issue, rule.maximum);
  const message = error ?? local;
  const over = checked.length > rule.maximum;
  const common = {
    "aria-describedby":
      message === null ? counterId : `${counterId} ${errorId}`,
    "aria-invalid": message === null ? undefined : true,
    className: styles.fieldInput,
    "data-editor-input": field,
    id,
    value,
  } as const;
  return (
    <div className={styles.sheetField} data-editor-field={field}>
      <div className={styles.sheetFieldHead}>
        <label htmlFor={id}>
          {label}
          <span>可选</span>
        </label>
        <span
          className={styles.counter}
          data-over={over ? "true" : undefined}
          id={counterId}
        >
          <span
            aria-hidden="true"
            hidden={!over && checked.length < rule.maximum * COUNTER_FROM}
          >
            {checked.length}/{rule.maximum}
          </span>
          <span className={editorStyles.visuallyHidden}>
            已输入 {checked.length} 字，最多 {rule.maximum} 字
          </span>
        </span>
      </div>
      {multiline ? (
        <textarea
          {...common}
          onChange={(event) => onChange(event.currentTarget.value)}
          rows={2}
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
        <p
          className={`${editorStyles.error} ${styles.sheetFieldError}`}
          id={errorId}
        >
          {message}
          {checked.issue === "line_break" ? (
            <button
              className={`${styles.inlineAction} ${styles.lineAction}`}
              onClick={() => onChange(value.replace(/[\r\n]+/gu, " ").trim())}
              type="button"
            >
              移除换行
            </button>
          ) : null}
        </p>
      )}
    </div>
  );
};

/**
 * Keeps the focused field of a form sheet in view as the on-screen keyboard
 * comes and goes. The sheet stands on the keyboard (`.sheetHost` follows the
 * editor's visual viewport frame), so it gets shorter and scrolls; a field
 * that would end up past its visible edge is scrolled back inside it. Only
 * the sheet scrolls (the form is drawn straight in it): the screen and the
 * page never move. Each pass waits a frame, after the editor host has
 * measured the new viewport.
 */
const useFocusedFieldInView = (formRef: RefObject<HTMLElement | null>) => {
  useEffect(() => {
    const form = formRef.current;
    const sheet = form?.parentElement ?? null;
    if (form === null || sheet === null) return undefined;
    const viewport = window.visualViewport;
    let frame: number | null = null;
    const reveal = () => {
      frame = null;
      const field = document.activeElement;
      if (!(field instanceof HTMLElement) || !form.contains(field)) return;
      const shown = sheet.getBoundingClientRect();
      const box = field.getBoundingClientRect();
      if (box.bottom > shown.bottom)
        sheet.scrollTop += Math.min(
          box.bottom - shown.bottom,
          box.top - shown.top,
        );
      else if (box.top < shown.top) sheet.scrollTop -= shown.top - box.top;
    };
    const schedule = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(reveal);
    };
    schedule();
    viewport?.addEventListener("resize", schedule);
    form.addEventListener("focusin", schedule);
    return () => {
      viewport?.removeEventListener("resize", schedule);
      form.removeEventListener("focusin", schedule);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [formRef]);
};

export interface ReferenceSheetProps {
  readonly state: EditorSessionState;
  readonly store: EditorSessionStore;
  /** The field focused when the sheet opens (前往修改 names one). */
  readonly focus: ReferenceField;
  /** 完成, Escape or a tap outside: what was typed is already kept. */
  readonly onClose: () => void;
}

/**
 * 参考作品 · 原作者 · 来源 (mockup A `openRefSheet`): the chosen kind as the
 * title with its description, the three optional fields and 完成, in mockup
 * A's sheet (a grab bar over the header; select-screen.module.css keys it on
 * `data-phone-sheet="references"`). Every keystroke is kept as the editor
 * keeps it, so closing the sheet any way loses nothing; 完成 only closes it.
 * With the keyboard up, the sheet stands on it and the focused field stays
 * in view.
 */
export const ReferenceSheet = ({
  state,
  store,
  focus,
  onClose,
}: ReferenceSheetProps) => {
  const chosen =
    AUTHORSHIP_KINDS.find((entry) => entry.kind === state.authorshipKind) ??
    null;
  const formRef = useRef<HTMLDivElement>(null);
  useFocusedFieldInView(formRef);
  return (
    <PhoneSheet
      initialFocus={`[data-editor-input="${focus}"]`}
      name="references"
      onCancel={onClose}
      subtitle={chosen?.description ?? null}
      title={chosen?.label ?? "参考作品"}
    >
      <div ref={formRef} className={styles.sheetForm} data-editor-references="">
        {REFERENCE_INPUTS.map((input) => (
          <SheetField
            key={input.field}
            error={state.fieldErrors[input.field] ?? null}
            field={input.field}
            label={input.label}
            multiline={input.multiline}
            onChange={(value) => store.setReference(input.field, value)}
            rule={input.rule}
            value={state.reference[input.field]}
          />
        ))}
      </div>
      <div className={selectStyles.shActions}>
        <button
          className={selectStyles.inkBtn}
          data-publish-references-done=""
          onClick={onClose}
          type="button"
        >
          完成
        </button>
      </div>
    </PhoneSheet>
  );
};

/** Whether the work's 作品性质 has reference fields (the sheet can open). */
export const hasReferences = isReferenceKind;
