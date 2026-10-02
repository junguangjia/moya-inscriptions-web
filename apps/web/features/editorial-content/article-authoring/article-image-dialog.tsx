"use client";

import { useState } from "react";
import {
  articleAuthoringLimits,
  articleTextLength,
} from "../../../lib/public-api/article-authoring-client";
import { EditorDialog } from "../../publishing/ui/editor/editor-dialog";
import styles from "./article-authoring.module.css";

export const ArticleImageDialog = ({
  caption,
  alt,
  disabled,
  onCancel,
  onSubmit,
}: {
  readonly caption: string;
  readonly alt: string;
  readonly disabled: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: (caption: string, alt: string) => void;
}) => {
  const [description, setDescription] = useState(caption);
  const [alternative, setAlternative] = useState(alt);
  const [error, setError] = useState(false);
  return (
    <EditorDialog
      title="图片说明"
      description="说明显示在图片下方；替代文字帮助使用屏幕阅读器的读者理解图片。"
      dataName="article-image-details"
      onCancel={onCancel}
    >
      <form
        className={styles.dialogForm}
        onSubmit={(event) => {
          event.preventDefault();
          if (disabled) return;
          if (
            articleTextLength(description) >
              articleAuthoringLimits.captionCodePoints ||
            articleTextLength(alternative) >
              articleAuthoringLimits.captionCodePoints
          ) {
            setError(true);
            return;
          }
          onSubmit(description, alternative);
        }}
      >
        <label>
          图片说明
          <input
            data-dialog-initial-focus=""
            placeholder="可选，补充图片内容"
            value={description}
            disabled={disabled}
            maxLength={articleAuthoringLimits.captionCodePoints * 2}
            onChange={(event) => setDescription(event.currentTarget.value)}
          />
        </label>
        <label>
          替代文字
          <input
            placeholder="简短描述图片中的内容"
            value={alternative}
            disabled={disabled}
            maxLength={articleAuthoringLimits.captionCodePoints * 2}
            onChange={(event) => setAlternative(event.currentTarget.value)}
          />
        </label>
        {error ? (
          <p className={styles.fieldError} role="alert">
            每项最多 200 字，请调整后保存。
          </p>
        ) : null}
        <div className={styles.actions}>
          <button type="button" onClick={onCancel}>
            取消
          </button>
          <button type="submit" className={styles.primary} disabled={disabled}>
            保存说明
          </button>
        </div>
      </form>
    </EditorDialog>
  );
};
