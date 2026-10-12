"use client";

import { useId, useRef } from "react";

import {
  originalAuthorRule,
  referenceTitleRule,
  sourceNoteRule,
} from "./editor-text";
import { TextField } from "./text-field";
import styles from "./editor.module.css";

import type {
  EditorSessionState,
  EditorSessionStore,
  ReferenceField,
} from "./editor-session-state";
import type { EditorTextRule } from "./editor-text";
import type { WorkAuthorshipKind } from "@moya/contracts";

/** The kinds of 作品性质 with their words (the phone 发布 draws them as chips). */
export const AUTHORSHIP_KINDS: readonly {
  readonly kind: WorkAuthorshipKind;
  readonly label: string;
  readonly description: string;
}[] = [
  { kind: "original", label: "原创", description: "自己创作的作品" },
  {
    kind: "copy_practice",
    label: "临摹或练习",
    description: "临摹、仿写或练习，可注明参考作品",
  },
  {
    kind: "material_sharing",
    label: "素材分享",
    description: "分享拍摄或收集的素材，可注明来源",
  },
];

/** The reference fields of 临摹或练习 and 素材分享, in reading order. */
export const REFERENCE_INPUTS: readonly {
  readonly field: ReferenceField;
  readonly label: string;
  readonly rule: EditorTextRule;
  readonly multiline: boolean;
}[] = [
  {
    field: "referenceTitle",
    label: "参考作品",
    rule: referenceTitleRule,
    multiline: false,
  },
  {
    field: "originalAuthor",
    label: "原作者",
    rule: originalAuthorRule,
    multiline: false,
  },
  { field: "sourceNote", label: "来源", rule: sourceNoteRule, multiline: true },
];

/**
 * 作品性质 (C05): only these fields, the references optional. Nothing is
 * preselected — the work stays 未设置 until the author chooses, and a choice
 * can be cleared again, so no claim is ever made on their behalf.
 */
export const AuthorshipFields = ({
  state,
  store,
}: {
  readonly state: EditorSessionState;
  readonly store: EditorSessionStore;
}) => {
  const name = useId();
  const options = useRef<HTMLDivElement>(null);
  return (
    <fieldset className={styles.field} data-editor-field="authorship">
      <legend>
        作品性质
        <span className={styles.optional}>可选</span>
      </legend>
      <div
        className={styles.fieldHead}
        data-editor-authorship-state={state.authorshipKind ?? "unset"}
      >
        <span className={styles.hint}>
          {state.authorshipKind === null
            ? "未设置"
            : (AUTHORSHIP_KINDS.find(
                (entry) => entry.kind === state.authorshipKind,
              )?.label ?? "未设置")}
        </span>
        {state.authorshipKind === null ? null : (
          <button
            className={styles.inlineAction}
            data-editor-authorship-clear=""
            onClick={() => {
              store.setAuthorshipKind(null);
              // The button goes away with the choice it clears, so the
              // keyboard stays in the field instead of falling to the page.
              options.current
                ?.querySelector<HTMLInputElement>('input[type="radio"]')
                ?.focus();
            }}
            type="button"
          >
            清除选择
          </button>
        )}
      </div>
      <div className={styles.options} ref={options}>
        {AUTHORSHIP_KINDS.map((entry) => (
          <label className={styles.option} key={entry.kind}>
            <input
              checked={state.authorshipKind === entry.kind}
              name={name}
              onChange={() => store.setAuthorshipKind(entry.kind)}
              type="radio"
              value={entry.kind}
            />
            <span className={styles.optionText}>
              <span>{entry.label}</span>
              <small>{entry.description}</small>
            </span>
          </label>
        ))}
      </div>
      {state.authorshipKind === null ||
      state.authorshipKind === "original" ? null : (
        <div className={styles.referenceFields} data-editor-references="">
          {REFERENCE_INPUTS.map((input) => (
            <TextField
              key={input.field}
              error={state.fieldErrors[input.field] ?? null}
              field={input.field}
              label={input.label}
              multiline={input.multiline}
              onChange={(value) => store.setReference(input.field, value)}
              optional
              rule={input.rule}
              size="small"
              value={state.reference[input.field]}
            />
          ))}
        </div>
      )}
    </fieldset>
  );
};
