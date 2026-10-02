"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { EditorDialog } from "../../publishing/ui/editor/editor-dialog";
import type { ArticleBlockNoteEditor } from "./article-blocknote-schema";
import {
  captureArticleSelection,
  restoreArticleSelection,
} from "./article-selection";
import type { ArticleSelection } from "./article-selection";
import styles from "./article-authoring.module.css";

const articleMarkColors = [
  { value: "default", textLabel: "默认墨色", backgroundLabel: "无背景" },
  { value: "gray", textLabel: "灰色", backgroundLabel: "灰色" },
  { value: "red", textLabel: "朱红", backgroundLabel: "朱红" },
  { value: "brown", textLabel: "褐色", backgroundLabel: "褐色" },
] as const;

type MarkTarget = "textColor" | "backgroundColor";
type MarkColor = (typeof articleMarkColors)[number]["value"];

/** One UI owner survives selection-toolbar dismissal and uses native marks. */
export const useArticleMarkPalette = ({
  editor,
  disabled,
  canMutate,
  selectedIcon,
}: {
  readonly editor: ArticleBlockNoteEditor | null;
  readonly disabled: boolean;
  readonly canMutate: () => boolean;
  readonly selectedIcon: ReactNode;
}) => {
  const [target, setTarget] = useState<MarkTarget | null>(null);
  const current = useRef({ editor, disabled, canMutate });
  current.current = { editor, disabled, canMutate };
  const allowed = () =>
    current.current.editor !== null &&
    !current.current.disabled &&
    current.current.canMutate();
  const captured = useRef<ArticleSelection | null>(null);
  const pending = useRef<{ target: MarkTarget; value: MarkColor } | null>(null);
  const activeColor = useRef<string>("default");

  const open = (value: MarkTarget) => {
    const instance = current.current.editor;
    if (instance === null || !allowed()) return;
    captured.current = captureArticleSelection(instance);
    activeColor.current = instance.getActiveStyles()[value] ?? "default";
    setTarget(value);
  };
  const cancel = () => {
    pending.current = null;
    setTarget(null);
  };
  const submit = (value: MarkColor) => {
    if (target === null || !allowed()) return;
    pending.current = { target, value };
    setTarget(null);
  };

  useEffect(() => {
    if (target !== null || pending.current === null) return;
    const command = pending.current;
    const selection = captured.current;
    pending.current = null;
    captured.current = null;
    const frame = requestAnimationFrame(() => {
      const instance = current.current.editor;
      if (
        instance === null ||
        !allowed() ||
        selection === null ||
        selection.editor !== instance ||
        !restoreArticleSelection(instance, selection) ||
        !allowed()
      )
        return;
      const mark =
        command.target === "textColor"
          ? { textColor: command.value }
          : { backgroundColor: command.value };
      if (command.value === "default") instance.removeStyles(mark);
      else instance.addStyles(mark);
      instance.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [target, editor]);

  useEffect(() => {
    captured.current = null;
    pending.current = null;
    setTarget(null);
  }, [editor]);

  const dialog =
    target === null || editor === null ? null : (
      <EditorDialog
        title={target === "textColor" ? "文字颜色" : "文字背景色"}
        dataName="article-tools"
        onCancel={cancel}
      >
        <div className={styles.menuChoices}>
          {articleMarkColors.map((color) => (
            <button
              type="button"
              key={color.value}
              aria-pressed={activeColor.current === color.value}
              disabled={disabled}
              onClick={() => submit(color.value)}
            >
              <span
                className={styles.colorSwatch}
                data-article-text-color={
                  target === "textColor" ? color.value : undefined
                }
                data-article-background-color={
                  target === "backgroundColor" ? color.value : undefined
                }
              >
                A
              </span>
              {target === "textColor" ? color.textLabel : color.backgroundLabel}
              {activeColor.current === color.value ? selectedIcon : null}
            </button>
          ))}
        </div>
        <div className={styles.actions}>
          <button type="button" onClick={cancel}>
            取消
          </button>
        </div>
      </EditorDialog>
    );
  return { open, allowed, isOpen: target !== null, dialog };
};

export type ArticleMarkPaletteController = ReturnType<
  typeof useArticleMarkPalette
>;
export const ArticleMarkPaletteContext =
  createContext<ArticleMarkPaletteController | null>(null);
export const useArticleMarkPaletteContext = () => {
  const value = useContext(ArticleMarkPaletteContext);
  if (value === null) throw new Error("article_mark_palette_context_missing");
  return value;
};
