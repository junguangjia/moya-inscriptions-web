"use client";

import { useId, useState } from "react";

import { TimelineEntryPicker } from "../../../home/timeline/timeline-entry-picker";
import { useTimelineEntryName } from "../../../home/timeline/timeline-session";
import styles from "./editor.module.css";

import type {
  EditorSessionState,
  EditorSessionStore,
} from "./editor-session-state";

/** What 关联词条 says about the chosen entry. */
const TIMELINE_ENTRY_HINT = "发布后会出现在这个词条下。";

/**
 * 关联词条 in the desktop text settings (timeline-posts-v1 §2.3), at the
 * place the phone 发布 shows it: new works and their drafts only. The
 * picker opens in place under the field; a choice closes it.
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
  const chosen = state.timelineEntryId ?? null;
  const { name } = useTimelineEntryName(chosen);
  if (state.kind !== "new") return null;
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
          onCancel={() => setOpen(false)}
          onChoose={(entry) => {
            store.setTimelineEntry(entry?.id ?? null);
            setOpen(false);
          }}
          selectedId={chosen}
        />
      ) : (
        <div className={styles.fieldHead}>
          <button
            className={styles.textButton}
            data-editor-timeline-entry-open=""
            onClick={() => setOpen(true)}
            type="button"
          >
            {chosen === null ? "选择词条" : "更改"}
          </button>
          {chosen === null ? null : (
            <button
              className={styles.textButton}
              data-editor-timeline-entry-clear=""
              onClick={() => store.setTimelineEntry(null)}
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
