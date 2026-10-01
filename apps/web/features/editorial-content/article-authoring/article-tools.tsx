"use client";

import { HistoryExtension } from "@blocknote/core/extensions";
import { useEditorState } from "@blocknote/react";
import { useEffect, useRef, useState } from "react";
import { EditorDialog } from "../../publishing/ui/editor/editor-dialog";
import type { ArticleBlockNoteEditor } from "./article-blocknote-schema";
import {
  captureArticleSelection,
  restoreArticleSelection,
} from "./article-selection";
import type { ArticleSelection } from "./article-selection";
import styles from "./article-authoring.module.css";

export type ArticleToolName =
  | "back"
  | "undo"
  | "redo"
  | "bold"
  | "italic"
  | "link"
  | "image"
  | "gallery"
  | "catalog"
  | "divider"
  | "more"
  | "settings"
  | "up"
  | "down"
  | "check"
  | "close";

const paths: Record<ArticleToolName, string> = {
  back: "m15 5-7 7 7 7",
  undo: "M8 4 3 9l5 5M3 9h11a7 7 0 0 1 0 14",
  redo: "m16 4 5 5-5 5m5-5H10a7 7 0 0 0 0 14",
  bold: "M7 4h6a4 4 0 0 1 0 8H7V4Zm0 8h7a4 4 0 0 1 0 8H7v-8Z",
  italic: "M10 4h9M5 20h9M15 4 9 20",
  link: "m10 13 4-4M9 15l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m0 3 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0",
  image: "M4 4h16v16H4V4Zm0 12 5-5 7 9m-3-5 3-3 4 4M8 8h.01",
  gallery: "M7 3h14v14H7V3ZM3 7v14h14M7 13l4-4 6 8m-3-5 3-3 4 4",
  catalog:
    "M4 5h7l1 2 1-2h7v14h-7l-1 2-1-2H4V5Zm8 2v14M7 9h2m6 0h2M7 13h2m6 0h2",
  divider: "M4 12h16",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  settings: "M4 6h16M4 12h16M4 18h16M9 3v6m6 0v6m-6 0v6",
  up: "m6 14 6-6 6 6",
  down: "m6 10 6 6 6-6",
  check: "m5 12 4 4L19 6",
  close: "m6 6 12 12M6 18 18 6",
};

export const ArticleToolIcon = ({
  name,
}: {
  readonly name: ArticleToolName;
}) => (
  <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24">
    <path
      d={paths[name]}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const blockChoices = [
  { label: "正文", type: "paragraph" },
  { label: "章节标题", type: "heading", level: 2 },
  { label: "小节标题", type: "heading", level: 3 },
  { label: "无序列表", type: "bulletListItem" },
  { label: "有序列表", type: "numberedListItem" },
  { label: "引用", type: "quote" },
] as const;
type BlockChoice = (typeof blockChoices)[number];

const selectedTextBlocks = (editor: ArticleBlockNoteEditor) =>
  (
    editor.getSelection()?.blocks ?? [editor.getTextCursorPosition().block]
  ).filter((block) => blockChoices.some((item) => item.type === block.type));

/** Canonical nested lists cannot acquire a non-list parent or child. */
export const canFormatArticleBlocks = (
  editor: ArticleBlockNoteEditor,
  choice: BlockChoice,
) => {
  const blocks = selectedTextBlocks(editor);
  const listTarget =
    choice.type === "bulletListItem" || choice.type === "numberedListItem";
  return (
    blocks.length > 0 &&
    (listTarget ||
      blocks.every(
        (block) =>
          block.children.length === 0 &&
          editor.getParentBlock(block)?.type !== "bulletListItem" &&
          editor.getParentBlock(block)?.type !== "numberedListItem",
      ))
  );
};

/** Reject the whole incompatible selection before any native transaction. */
export const formatArticleBlocks = (
  editor: ArticleBlockNoteEditor,
  choice: BlockChoice,
): boolean => {
  if (!canFormatArticleBlocks(editor, choice)) return false;
  const selected = selectedTextBlocks(editor);
  editor.transact(() => {
    for (const block of selected) {
      if (choice.type === "heading")
        editor.updateBlock(block, {
          type: "heading",
          props: { level: choice.level },
        });
      else editor.updateBlock(block, { type: choice.type });
    }
  });
  editor.focus();
  return true;
};

export const ArticleTools = ({
  editor,
  disabled,
  bodyActive,
  canMutate,
  onLink,
  onImage,
  onGallery,
  onCatalog,
  onDivider,
  onSettings,
}: {
  readonly editor: ArticleBlockNoteEditor;
  readonly disabled: boolean;
  readonly bodyActive: boolean;
  readonly canMutate: () => boolean;
  readonly onLink: () => void;
  readonly onImage: () => void;
  readonly onGallery: () => void;
  readonly onCatalog: () => void;
  readonly onDivider: () => void;
  readonly onSettings: () => void;
}) => {
  const [menu, setMenu] = useState<"format" | "more" | null>(null);
  const current = useRef({ disabled, bodyActive, canMutate });
  current.current = { disabled, bodyActive, canMutate };
  const allowed = (body = true) =>
    !current.current.disabled &&
    (!body || current.current.bodyActive) &&
    current.current.canMutate();
  const selection = useRef<ArticleSelection | null>(null);
  const pending = useRef<(() => void) | null>(null);
  const openMenu = (value: "format" | "more") => {
    if (!allowed()) return;
    selection.current = captureArticleSelection(editor);
    setMenu(value);
  };
  const submit = (operation: () => void) => {
    if (!allowed()) return;
    pending.current = operation;
    setMenu(null);
  };
  useEffect(() => {
    if (menu !== null || pending.current === null) return;
    const operation = pending.current;
    const captured = selection.current;
    pending.current = null;
    const frame = requestAnimationFrame(() => {
      if (
        !allowed() ||
        captured === null ||
        !restoreArticleSelection(editor, captured)
      )
        return;
      operation();
      editor.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [menu, editor]);

  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const block = current.getTextCursorPosition().block;
      const history = current.getExtension(HistoryExtension);
      return {
        type: block.type,
        label:
          blockChoices.find(
            (item) =>
              item.type === block.type &&
              (item.type !== "heading" ||
                (block.type === "heading" && item.level === block.props.level)),
          )?.label ?? "内容块",
        bold: current.getActiveStyles().bold === true,
        italic: current.getActiveStyles().italic === true,
        linked: current.getSelectedLinkUrl() !== undefined,
        undo: history !== undefined && current.canExec(history.undoCommand),
        redo: history !== undefined && current.canExec(history.redoCommand),
      };
    },
  });
  const action = (
    name: ArticleToolName,
    label: string,
    run: () => void,
    pressed?: boolean,
    unavailable = false,
  ) => (
    <button
      type="button"
      className={styles.toolButton}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled || unavailable || (name !== "settings" && !bodyActive)}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        if (allowed(name !== "settings")) run();
      }}
    >
      <ArticleToolIcon name={name} />
    </button>
  );
  return (
    <>
      <div
        className={styles.toolbar}
        role="toolbar"
        aria-label="专题格式工具栏"
      >
        <div className={styles.toolGroup}>
          {action("undo", "撤销", () => editor.undo(), undefined, !state.undo)}
          {action("redo", "重做", () => editor.redo(), undefined, !state.redo)}
        </div>
        <div className={styles.toolGroup}>
          <button
            type="button"
            className={styles.formatButton}
            disabled={disabled || !bodyActive}
            aria-haspopup="dialog"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => openMenu("format")}
          >
            {state.label}
            <span aria-hidden="true">⌄</span>
          </button>
        </div>
        <div className={styles.toolGroup}>
          {action(
            "bold",
            "粗体（⌘/Ctrl+B）",
            () => {
              editor.toggleStyles({ bold: true });
              editor.focus();
            },
            state.bold,
          )}
          {action(
            "italic",
            "斜体（⌘/Ctrl+I）",
            () => {
              editor.toggleStyles({ italic: true });
              editor.focus();
            },
            state.italic,
          )}
          {action("link", "编辑链接", onLink, state.linked)}
        </div>
        <div className={styles.toolGroup}>
          {action("image", "插入图片", onImage)}
          {action("gallery", "插入图片组", onGallery)}
          {action("catalog", "插入藏品引用", onCatalog)}
          {action("divider", "插入分隔线", onDivider)}
        </div>
        <div className={styles.toolGroup}>
          {action("settings", "文章设置", onSettings)}
          {action("more", "更多块操作", () => openMenu("more"))}
        </div>
      </div>
      {menu === null ? null : (
        <EditorDialog
          title={menu === "format" ? "段落样式" : "块操作"}
          dataName="article-tools"
          onCancel={() => setMenu(null)}
        >
          {menu === "format" &&
          !canFormatArticleBlocks(editor, blockChoices[0]) ? (
            <p className={styles.dialogHint}>
              嵌套列表可切换列表样式；普通段落和标题请在列表外使用。
            </p>
          ) : null}
          <div className={styles.menuChoices}>
            {menu === "format" ? (
              blockChoices.map((choice) => (
                <button
                  type="button"
                  key={choice.label}
                  disabled={disabled || !canFormatArticleBlocks(editor, choice)}
                  onClick={() =>
                    submit(() => {
                      formatArticleBlocks(editor, choice);
                    })
                  }
                >
                  {choice.label}
                  <span>
                    {choice.type === "heading"
                      ? `H${choice.level}`
                      : choice.type === "paragraph"
                        ? "文本"
                        : ""}
                  </span>
                </button>
              ))
            ) : (
              <>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() =>
                    submit(() => {
                      editor.moveBlocksUp();
                    })
                  }
                >
                  <ArticleToolIcon name="up" />
                  当前块上移
                </button>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() =>
                    submit(() => {
                      editor.moveBlocksDown();
                    })
                  }
                >
                  <ArticleToolIcon name="down" />
                  当前块下移
                </button>
              </>
            )}
          </div>
          <div className={styles.actions}>
            <button type="button" onClick={() => setMenu(null)}>
              取消
            </button>
          </div>
        </EditorDialog>
      )}
    </>
  );
};
