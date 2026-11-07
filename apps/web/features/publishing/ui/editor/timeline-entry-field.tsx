"use client";

import { useEffect, useId, useRef, useState } from "react";

import { TimelineEntryPicker } from "../../../home/timeline/timeline-entry-picker";
import { useTimelineEntryName } from "../../../home/timeline/timeline-session";
import { takesTimelineEntry } from "./editor-session-state";
import styles from "./editor.module.css";

import type {
  EditorSessionState,
  EditorSessionStore,
} from "./editor-session-state";

/** What 关联词条 says about the chosen entry. */
const TIMELINE_ENTRY_HINT = "发布后会出现在这个词条下。";

/**
 * 关联词条 in the desktop text settings (timeline-posts-v1 §2.3), at the
 * place the phone 发布 shows it: new works and their drafts only, never the
 * Thread quick composer (`takesTimelineEntry`). The picker opens in place
 * under the field, with the focus on its search; a choice or 取消 closes it
 * and gives the focus back to 选择词条 / 更改, as 清除 does.
 */
export const TimelineEntryField = ({
  state,
  store,
}: {
  readonly state: EditorSessionState;
  readonly store: EditorSessionStore;
}) => {
  const legendId = useId();
  const [open, setOpen] = useState(false);
  const openerRef = useRef<HTMLButtonElement>(null);
  // Set when the picker or 清除 leaves the focus on a control that goes.
  const [refocus, setRefocus] = useState(0);
  useEffect(() => {
    if (refocus !== 0) openerRef.current?.focus();
  }, [refocus]);
  const chosen = state.timelineEntryId ?? null;
  const { name } = useTimelineEntryName(chosen);
  if (!takesTimelineEntry(state)) return null;
  const close = () => {
    setOpen(false);
    setRefocus((value) => value + 1);
  };
  const current =
    name.state === "named"
      ? name.name
      : name.state === "missing"
        ? "这个词条已不可用，请重新选择"
        : name.state === "none"
          ? null
          : "已选择词条";
  return (
    <fieldset
      aria-labelledby={legendId}
      className={styles.field}
      data-editor-field="timelineEntry"
    >
      <legend id={legendId}>
        关联词条<span className={styles.optional}>可选</span>
      </legend>
      {current === null ? null : <p data-editor-timeline-entry="">{current}</p>}
      <p className={styles.hint}>{TIMELINE_ENTRY_HINT}</p>
      {open ? (
        <TimelineEntryPicker
          focusOnOpen
          onCancel={close}
          onChoose={(entry) => {
            store.setTimelineEntry(entry?.id ?? null);
            close();
          }}
          selectedId={chosen}
        />
      ) : (
        <div className={styles.fieldHead}>
          <button
            className={styles.textButton}
            data-editor-timeline-entry-open=""
            onClick={() => setOpen(true)}
            ref={openerRef}
            type="button"
          >
            {chosen === null ? "选择词条" : "更改"}
          </button>
          {chosen === null ? null : (
            <button
              className={styles.textButton}
              data-editor-timeline-entry-clear=""
              onClick={() => {
                store.setTimelineEntry(null);
                setRefocus((value) => value + 1);
              }}
              type="button"
            >
              清除
            </button>
          )}
        </div>
      )}
    </fieldset>
  );
};
