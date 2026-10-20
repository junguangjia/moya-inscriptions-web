"use client";

import { MentionControl } from "../../../notifications/mention-control";
import { AuthorshipFields } from "./authorship-fields";
import { bodyRule, checkEditorText, titleRule } from "./editor-text";
import { TextField } from "./text-field";
import { VisibilityField } from "./visibility-field";
import styles from "./editor.module.css";

import type {
  EditorSessionState,
  EditorSessionStore,
} from "./editor-session-state";
import type { ReactNode } from "react";

/** The title and photo required before a work can be published. */
export const publicationRequirement = (
  state: Pick<EditorSessionState, "title" | "items">,
): string | null => {
  const hasTitle = checkEditorText(state.title, titleRule).length > 0;
  const hasMedia = state.items.length > 0;
  if (hasTitle && hasMedia) return null;
  return !hasTitle && !hasMedia
    ? "请填写标题并至少添加一张图片"
    : !hasTitle
      ? "请填写标题"
      : "请至少添加一张图片";
};

export const TitleField = ({
  state,
  store,
  autoFocus = false,
}: {
  readonly state: EditorSessionState;
  readonly store: EditorSessionStore;
  readonly autoFocus?: boolean;
}) => (
  <TextField
    autoFocus={autoFocus}
    error={state.fieldErrors.title ?? null}
    field="title"
    label="标题"
    onChange={store.setTitle}
    placeholder="添加标题"
    rule={titleRule}
    value={state.title}
  />
);

export const BodyField = ({
  state,
  store,
}: {
  readonly state: EditorSessionState;
  readonly store: EditorSessionStore;
}) => (
  <>
    <TextField
      error={state.fieldErrors.body ?? null}
      field="body"
      hint="保留换行；首尾的空白不计入字数"
      label="正文"
      multiline
      onChange={store.setBody}
      optional
      placeholder="写下作品的说明、释文或心得"
      rule={bodyRule}
      value={state.body}
    />
    <MentionControl
      text={state.body}
      mentions={state.mentions}
      onChange={store.setBody}
    />
  </>
);

/**
 * Step 2 (phone) and the desktop text column (E04–E05): title, body,
 * authorship and visibility; upload progress stays visible
 * through the editor's own status line.
 */
export const TextSettings = ({
  state,
  store,
  progress,
  autoFocusTitle = false,
}: {
  readonly state: EditorSessionState;
  readonly store: EditorSessionStore;
  /** Upload progress summary kept visible while typing. */
  readonly progress?: ReactNode;
  readonly autoFocusTitle?: boolean;
}) => {
  const requirement = publicationRequirement(state);
  return (
    <div className={styles.fields} data-editor-text-settings="">
      {progress}
      <TitleField autoFocus={autoFocusTitle} state={state} store={store} />
      <BodyField state={state} store={store} />
      {requirement === null ? null : (
        <p className={styles.hint} data-editor-requirement="">
          {requirement}
        </p>
      )}
      <AuthorshipFields state={state} store={store} />
      <VisibilityField state={state} store={store} />
    </div>
  );
};
