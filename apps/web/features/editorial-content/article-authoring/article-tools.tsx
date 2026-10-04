"use client";

import { HistoryExtension } from "@blocknote/core/extensions";
import { blockTypeSelectItems, useEditorState } from "@blocknote/react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ArticleBlock } from "@moya/contracts";
import { articleLineHeight } from "@moya/design-tokens";
import { EditorDialog } from "../../publishing/ui/editor/editor-dialog";
import type { ArticleBlockNoteEditor } from "./article-blocknote-schema";
import {
  captureArticleSelection,
  restoreArticleSelection,
} from "./article-selection";
import type { ArticleSelection } from "./article-selection";
import { stepArticleBlock } from "./article-block-move";
import { useArticleMarkPalette } from "./article-mark-palette";
import type { ArticleMarkPaletteController } from "./article-mark-palette";
import styles from "./article-authoring.module.css";

export type ArticleToolName =
  | "undo"
  | "redo"
  | "bold"
  | "italic"
  | "underline"
  | "color"
  | "background"
  | "left"
  | "center"
  | "right"
  | "justify"
  | "spacing"
  | "insert"
  | "drag"
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
  undo: "M8 4 3 9l5 5M3 9h11a7 7 0 0 1 0 14",
  redo: "m16 4 5 5-5 5m5-5H10a7 7 0 0 0 0 14",
  bold: "M7 4h6a4 4 0 0 1 0 8H7V4Zm0 8h7a4 4 0 0 1 0 8H7v-8Z",
  italic: "M10 4h9M5 20h9M15 4 9 20",
  underline: "M6 4v7a6 6 0 0 0 12 0V4M4 21h16",
  color: "m7 16 5-12 5 12M9 12h6M4 21h16",
  background: "m5 16 9-12 5 4-9 12H5v-4Zm7-10 5 4M3 22h18",
  left: "M4 5h16M4 10h10M4 15h16M4 20h10",
  center: "M4 5h16M7 10h10M4 15h16M7 20h10",
  right: "M4 5h16M10 10h10M4 15h16M10 20h10",
  justify: "M4 5h16M4 10h16M4 15h16M4 20h16",
  spacing: "M10 5h11M10 12h11M10 19h11M4 3v18m-2-16 2-2 2 2m-4 14 2 2 2-2",
  insert: "M12 4v16M4 12h16",
  drag: "M8 5h.01M16 5h.01M8 12h.01M16 12h.01M8 19h.01M16 19h.01",
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

/** Native updates preserve all inline marks, stable IDs and one Undo unit. */
export const formatArticleLayout = (
  editor: ArticleBlockNoteEditor,
  props: Partial<
    Pick<
      Extract<ArticleBlock, { type: "paragraph" }>["props"],
      "textAlignment" | "lineSpacing"
    >
  >,
): boolean => {
  const blocks = selectedTextBlocks(editor);
  if (blocks.length === 0) return false;
  editor.transact(() => {
    for (const block of blocks) editor.updateBlock(block, { props });
  });
  return true;
};

const alignmentChoices = [
  { value: "left", label: "左对齐" },
  { value: "center", label: "居中" },
  { value: "right", label: "右对齐" },
  { value: "justify", label: "两端对齐" },
] as const;
const spacingChoices = [
  { value: "compact", label: "紧凑" },
  { value: "normal", label: "标准" },
  { value: "relaxed", label: "宽松" },
] as const;

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
  markPalette,
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
  readonly markPalette?: ArticleMarkPaletteController;
}) => {
  const localPalette = useArticleMarkPalette({
    editor,
    disabled: disabled || !bodyActive,
    canMutate,
    selectedIcon: <ArticleToolIcon name="check" />,
  });
  const palette = markPalette ?? localPalette;
  const [menu, setMenu] = useState<
    "format" | "more" | "alignment" | "spacing" | "insert" | null
  >(null);
  const current = useRef({ disabled, bodyActive, canMutate });
  current.current = { disabled, bodyActive, canMutate };
  const allowed = (body = true) =>
    !current.current.disabled &&
    (!body || current.current.bodyActive) &&
    current.current.canMutate();
  const selection = useRef<ArticleSelection | null>(null);
  const pending = useRef<(() => void) | null>(null);
  const openMenu = (value: NonNullable<typeof menu>) => {
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
        underline: current.getActiveStyles().underline === true,
        color: current.getActiveStyles().textColor ?? "default",
        background: current.getActiveStyles().backgroundColor ?? "default",
        alignment:
          "textAlignment" in block.props ? block.props.textAlignment : "left",
        spacing:
          "lineSpacing" in block.props ? block.props.lineSpacing : "normal",
        linked: current.getSelectedLinkUrl() !== undefined,
        undo: history !== undefined && current.canExec(history.undoCommand),
        redo: history !== undefined && current.canExec(history.redoCommand),
      };
    },
  });
  const nativeTypes = blockTypeSelectItems(editor.dictionary);
  const nativeListIcon = (type: "bulletListItem" | "numberedListItem") => {
    const Icon = nativeTypes.find((item) => item.type === type)?.icon;
    return Icon === undefined ? null : <Icon />;
  };
  const action = (
    name: ArticleToolName,
    label: string,
    run: () => void,
    pressed?: boolean,
    unavailable = false,
    icon?: ReactNode,
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
      {icon ?? <ArticleToolIcon name={name} />}
    </button>
  );
  return (
    <>
      <div
        className={`${styles.toolbar} yoyi-functional-glass`}
        role="toolbar"
        aria-label="专题格式工具栏"
      >
        <div className={styles.formattingRow}>
          <button
            type="button"
            className={styles.formatButton}
            disabled={disabled || !bodyActive}
            aria-label={`段落样式：${state.label}`}
            aria-haspopup="dialog"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => openMenu("format")}
          >
            <span className={styles.desktopFormat}>{state.label}</span>
            <span className={styles.mobileFormat}>T⌄</span>
          </button>
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
          {action(
            "underline",
            "下划线（⌘/Ctrl+U）",
            () => {
              editor.toggleStyles({ underline: true });
              editor.focus();
            },
            state.underline,
          )}
          {action(
            "color",
            "文字颜色",
            () => palette.open("textColor"),
            state.color !== "default",
          )}
          {action("link", "编辑链接", onLink, state.linked)}
          {action(
            "background",
            "文字背景色",
            () => palette.open("backgroundColor"),
            state.background !== "default",
          )}
          <div
            className={styles.layoutTools}
            role="group"
            aria-label="段落排版"
          >
            {action(state.alignment, "对齐方式", () => openMenu("alignment"))}
            {action(
              "spacing",
              "行间距",
              () => openMenu("spacing"),
              state.spacing !== "normal",
            )}
            {action(
              "more",
              "无序列表",
              () => formatArticleBlocks(editor, blockChoices[3]),
              state.type === "bulletListItem",
              !canFormatArticleBlocks(editor, blockChoices[3]),
              nativeListIcon("bulletListItem"),
            )}
            {action(
              "more",
              "有序列表",
              () => formatArticleBlocks(editor, blockChoices[4]),
              state.type === "numberedListItem",
              !canFormatArticleBlocks(editor, blockChoices[4]),
              nativeListIcon("numberedListItem"),
            )}
          </div>
        </div>
        <div className={styles.utilityRow}>
          {action("undo", "撤销", () => editor.undo(), undefined, !state.undo)}
          {action("redo", "重做", () => editor.redo(), undefined, !state.redo)}
          <button
            type="button"
            className={`${styles.insertButton} ${styles.mobileTools}`}
            disabled={disabled || !bodyActive}
            aria-haspopup="dialog"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => openMenu("insert")}
          >
            <ArticleToolIcon name="insert" />
            插入
          </button>
          <span className={styles.mobileTools}>
            {action("more", "更多块操作", () => openMenu("more"))}
          </span>
          <span className={styles.mobileTools}>
            {action(state.alignment, "对齐方式", () => openMenu("alignment"))}
            {action(
              "spacing",
              "行间距",
              () => openMenu("spacing"),
              state.spacing !== "normal",
            )}
          </span>
          <div
            className={styles.desktopTools}
            role="group"
            aria-label="插入内容"
          >
            {action("image", "插入图片", onImage)}
            {action("gallery", "插入图片组", onGallery)}
            {action("catalog", "插入藏品引用", onCatalog)}
            {action("divider", "插入分隔线", onDivider)}
          </div>
          <div className={styles.desktopTools} role="group" aria-label="块操作">
            {action("up", "当前块上移", () =>
              stepArticleBlock(
                editor,
                editor.getTextCursorPosition().block.id,
                -1,
              ),
            )}
            {action("down", "当前块下移", () =>
              stepArticleBlock(
                editor,
                editor.getTextCursorPosition().block.id,
                1,
              ),
            )}
          </div>
          {action("settings", "文章设置", onSettings)}
        </div>
      </div>
      {markPalette === undefined ? localPalette.dialog : null}
      {menu === null ? null : (
        <EditorDialog
          title={
            menu === "format"
              ? "段落样式"
              : menu === "alignment"
                ? "对齐方式"
                : menu === "spacing"
                  ? "行间距"
                  : menu === "insert"
                    ? "插入内容"
                    : "块操作"
          }
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
            ) : menu === "alignment" ? (
              alignmentChoices.map((choice) => (
                <button
                  type="button"
                  key={choice.value}
                  disabled={disabled}
                  aria-pressed={state.alignment === choice.value}
                  onClick={() =>
                    submit(() => {
                      formatArticleLayout(editor, {
                        textAlignment: choice.value,
                      });
                    })
                  }
                >
                  <ArticleToolIcon name={choice.value} />
                  {choice.label}
                  {state.alignment === choice.value ? (
                    <ArticleToolIcon name="check" />
                  ) : null}
                </button>
              ))
            ) : menu === "spacing" ? (
              spacingChoices.map((choice) => (
                <button
                  type="button"
                  key={choice.value}
                  disabled={disabled}
                  aria-pressed={state.spacing === choice.value}
                  onClick={() =>
                    submit(() => {
                      formatArticleLayout(editor, {
                        lineSpacing: choice.value,
                      });
                    })
                  }
                >
                  {choice.label}
                  <span>{articleLineHeight[choice.value]}</span>
                  {state.spacing === choice.value ? (
                    <ArticleToolIcon name="check" />
                  ) : null}
                </button>
              ))
            ) : menu === "insert" ? (
              (
                [
                  { icon: "image", label: "图片", run: onImage },
                  { icon: "gallery", label: "图片组", run: onGallery },
                  { icon: "catalog", label: "藏品引用", run: onCatalog },
                  { icon: "divider", label: "分隔线", run: onDivider },
                ] as const
              ).map((item) => (
                <button
                  type="button"
                  key={item.icon}
                  disabled={disabled}
                  onClick={() => submit(item.run)}
                >
                  <ArticleToolIcon name={item.icon} />
                  {item.label}
                </button>
              ))
            ) : (
              <>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() =>
                    submit(() => {
                      stepArticleBlock(
                        editor,
                        editor.getTextCursorPosition().block.id,
                        -1,
                      );
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
                      stepArticleBlock(
                        editor,
                        editor.getTextCursorPosition().block.id,
                        1,
                      );
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
