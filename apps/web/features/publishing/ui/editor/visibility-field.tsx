"use client";

import { useId } from "react";

import styles from "./editor.module.css";

import type {
  EditorSessionState,
  EditorSessionStore,
} from "./editor-session-state";
import type { WorkVisibility } from "@moya/contracts";

/** The two 可见范围 with their words (the phone 发布 draws them as a segment). */
export const VISIBILITY_OPTIONS: readonly {
  readonly value: WorkVisibility;
  readonly label: string;
  readonly description: string;
}[] = [
  { value: "public", label: "公开", description: "允许其他人浏览" },
  { value: "self", label: "仅自己可见", description: "只有你能看到" },
];

/** What an edit's 可见范围 adds: the work's own applies until the update is saved. */
export const VISIBILITY_EDIT_HINT =
  "默认沿用作品当前的可见范围，保存更新后生效。";

/** 可见范围 (P03): new works default to public; edits inherit the work's. */
export const VisibilityField = ({
  state,
  store,
}: {
  readonly state: EditorSessionState;
  readonly store: EditorSessionStore;
}) => {
  const name = useId();
  const hintId = useId();
  return (
    <fieldset
      aria-describedby={state.kind === "edit" ? hintId : undefined}
      className={styles.field}
      data-editor-field="visibility"
    >
      <legend>可见范围</legend>
      <div className={styles.options}>
        {VISIBILITY_OPTIONS.map((option) => (
          <label className={styles.option} key={option.value}>
            <input
              checked={state.visibility === option.value}
              name={name}
              onChange={() => store.setVisibility(option.value)}
              type="radio"
              value={option.value}
            />
            <span className={styles.optionText}>
              <span>{option.label}</span>
              <small>{option.description}</small>
            </span>
          </label>
        ))}
      </div>
      {state.kind === "edit" ? (
        <p className={styles.hint} id={hintId}>
          {VISIBILITY_EDIT_HINT}
        </p>
      ) : null}
    </fieldset>
  );
};
