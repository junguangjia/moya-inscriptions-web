"use client";

import { useState } from "react";
import { EditorDialog } from "../../publishing/ui/editor/editor-dialog";
import { isArticleSafeLink } from "../../../lib/public-api/article-authoring-client";
import type { ArticleSelection } from "./article-selection";
import styles from "./article-authoring.module.css";

export const ArticleLinkDialog = ({
  selection,
  disabled,
  onCancel,
  onSubmit,
}: {
  readonly selection: ArticleSelection;
  readonly disabled: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: (url: string | null, label: string) => void;
}) => {
  const [url, setUrl] = useState(selection.link?.href ?? "");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const needsLabel = selection.empty && selection.link === undefined;
  return (
    <EditorDialog
      title={selection.link === undefined ? "插入链接" : "编辑链接"}
      dataName="article-link"
      onCancel={onCancel}
    >
      <form
        className={styles.dialogForm}
        onSubmit={(event) => {
          event.preventDefault();
          if (disabled) return;
          const next = url.trim();
          if (!isArticleSafeLink(next)) {
            setError("请输入有效的 http 或 https 网址。");
            return;
          }
          if (needsLabel && label.trim() === "") {
            setError("请填写链接文字，或先选中正文中的文字。");
            return;
          }
          onSubmit(next, label.trim());
        }}
      >
        {needsLabel ? (
          <label>
            链接文字
            <input
              data-dialog-initial-focus=""
              value={label}
              disabled={disabled}
              onChange={(event) => setLabel(event.currentTarget.value)}
              maxLength={200}
            />
          </label>
        ) : (
          <p className={styles.selectionExcerpt}>
            {selection.text || selection.link?.text}
          </p>
        )}
        <label>
          链接地址
          <input
            data-dialog-initial-focus={needsLabel ? undefined : ""}
            type="url"
            placeholder="https://"
            value={url}
            disabled={disabled}
            onChange={(event) => setUrl(event.currentTarget.value)}
            maxLength={2048}
          />
        </label>
        {error === null ? null : (
          <p role="alert" className={styles.fieldError}>
            {error}
          </p>
        )}
        <div className={styles.actions}>
          {selection.link === undefined ? null : (
            <button
              type="button"
              disabled={disabled}
              onClick={() => onSubmit(null, "")}
            >
              移除链接
            </button>
          )}
          <button type="button" onClick={onCancel}>
            取消
          </button>
          <button className={styles.primary} type="submit" disabled={disabled}>
            确认
          </button>
        </div>
      </form>
    </EditorDialog>
  );
};
