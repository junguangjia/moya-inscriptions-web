"use client";

import { BlockNoteEditor } from "@blocknote/core";
import { filterSuggestionItems } from "@blocknote/core/extensions";
import { zh } from "@blocknote/core/locales";
import { BlockNoteView } from "@blocknote/ariakit";
import {
  BasicTextStyleButton,
  CreateLinkButton,
  FormattingToolbar,
  FormattingToolbarController,
  SuggestionMenuController,
  getDefaultReactSlashMenuItems,
} from "@blocknote/react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ArticlePreview } from "@moya/contracts";
import type { KeyboardEvent } from "react";
import { authorClient } from "../../../lib/public-api/author-community-client";
import {
  ArticleRequestError,
  articleAuthoringLimits,
  articleTextLength,
  articleDocumentPlainText,
  isArticleSafeLink,
  parseArticleEditorDocument,
} from "../../../lib/public-api/article-authoring-client";
import "@blocknote/ariakit/style.css";
import { createExternalStore } from "../../publishing/upload-manager-store";
import { EditorDialog } from "../../publishing/ui/editor/editor-dialog";
import { createArticleAutosave } from "./article-autosave";
import { createArticlePublicationAttempt } from "./article-publication-attempt";
import type { ArticlePublicationAttempt } from "./article-publication-attempt";
import type {
  ArticleAutosave,
  ArticleAutosaveSnapshot,
} from "./article-autosave";
import {
  ArticleAttachmentContext,
  articleSessionAttachments,
  attachArticleReferences,
} from "./article-attachments";
import { articleBlockNoteSchema } from "./article-blocknote-schema";
import type { ArticleBlockNoteEditor } from "./article-blocknote-schema";
import type { ArticleEditorProps } from "./article-editor-props";
import { ArticleRichBody } from "./article-rich-body";
import styles from "./article-authoring.module.css";

const nextStableId = () => crypto.randomUUID().replaceAll("-", "");
const SelectionTools = () => (
  <FormattingToolbar>
    <BasicTextStyleButton basicTextStyle="bold" />
    <BasicTextStyleButton basicTextStyle="italic" />
    <CreateLinkButton />
  </FormattingToolbar>
);
const statusText = {
  saved: "已保存到账号",
  pending: "有未保存的更改",
  saving: "保存中…",
  failed: "保存失败",
  conflict: "存在版本冲突",
  permission_lost: "授权已失效",
  closed: "已关闭",
} as const;

/** Integrated active authoring boundary; one editor and one serialized write stream. */
export default function ArticleEditor(props: ArticleEditorProps) {
  const { initial, client, media } = props;
  const editorRef = useRef<ArticleBlockNoteEditor | null>(null);
  const publicationRef = useRef<ArticlePublicationAttempt | null>(null);
  const busyRef = useRef(false);
  const [editor, setEditor] = useState<ArticleBlockNoteEditor | null>(null);
  const [title, setTitle] = useState(initial.title);
  const [attachments, setAttachments] = useState(() =>
    articleSessionAttachments(initial),
  );
  const [coverRefId, setCoverRefId] = useState(initial.coverRefId);
  const [portal, setPortal] = useState<HTMLDivElement | null>(null);
  const [busy, setBusy] = useState<
    "preview" | "publish" | "media" | "close" | null
  >(null);
  const [preview, setPreview] = useState<ArticlePreview | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [compare, setCompare] = useState(false);
  busyRef.current = busy !== null && busy !== "close";
  const [insertMenu, setInsertMenu] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const frozen = useRef({ initial, client, accountEpoch: props.accountEpoch });
  const latest = useRef({ title, attachments, coverRefId, media });
  latest.current = { title, attachments, coverRefId, media };
  const [loadingStore] = useState(() =>
    createExternalStore<ArticleAutosaveSnapshot>({
      draft: initial,
      editGeneration: 0,
      acknowledgedGeneration: 0,
      status: "saved",
      remote: null,
      message: null,
    }),
  );
  const [auto, setAuto] = useState<ArticleAutosave | null>(null);
  const saveStore = auto?.store ?? loadingStore;
  const saved = useSyncExternalStore(
    saveStore.subscribe,
    saveStore.get,
    saveStore.get,
  );
  const canChange = () => auto?.canMutate() === true;
  const mutationAllowed = canChange();
  const activeSave = () => {
    if (auto === null) throw new Error("article_editor_unavailable");
    return auto;
  };

  useEffect(() => {
    const opening = frozen.current;
    if (
      authorClient.account() !== opening.initial.ownerId ||
      authorClient.accountEpoch() !== opening.accountEpoch
    ) {
      setNotice("账户状态已变化，请重新打开专题。");
      return;
    }
    const abort = new AbortController();
    abortRef.current = abort;
    const instance = BlockNoteEditor.create({
      schema: articleBlockNoteSchema,
      initialContent: opening.initial.document.blocks,
      dictionary: zh,
      tabBehavior: "prefer-navigate-ui",
      links: {
        isValidLink: isArticleSafeLink,
        HTMLAttributes: { rel: "noreferrer noopener", target: "_blank" },
      },
      pasteHandler: ({ defaultPasteHandler }) =>
        defaultPasteHandler({
          prioritizeMarkdownOverHTML: false,
          plainTextAsMarkdown: false,
        }),
    });
    const autosave = createArticleAutosave({
      initial: opening.initial,
      client: opening.client,
      currentAccount: authorClient.account,
      accountEpoch: authorClient.accountEpoch,
      requestId: () => crypto.randomUUID(),
      capture: () => {
        const value = latest.current;
        return {
          title: value.title,
          coverRefId: value.coverRefId,
          document: parseArticleEditorDocument(
            instance.document,
            value.attachments,
          ),
        };
      },
      classifyFailure: (error) =>
        error instanceof ArticleRequestError
          ? {
              status: error.status,
              reason: error.reason,
              outcomeUnknown: error.outcomeUnknown,
            }
          : {
              status: 422,
              reason: "article_invalid_document",
              outcomeUnknown: false,
            },
    });
    const publication = createArticlePublicationAttempt({
      ownerId: opening.initial.ownerId,
      currentAccount: authorClient.account,
      accountEpoch: authorClient.accountEpoch,
      publish: opening.client.publish,
      requestId: () => crypto.randomUUID(),
    });
    publicationRef.current = publication;
    editorRef.current = instance;
    setEditor(instance);
    setAuto(autosave);
    return () => {
      publication.dispose();
      if (publicationRef.current === publication) publicationRef.current = null;
      autosave.dispose();
      abort.abort();
      instance.unmount();
      if (editorRef.current === instance) editorRef.current = null;
    };
  }, []);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      const publication = publicationRef.current;
      if (
        auto?.isDirty() ||
        (publication !== null && publication.pending() !== null)
      )
        event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [auto]);
  useEffect(() => {
    if (
      auto === null ||
      (!auto.isDirty() &&
        publicationRef.current?.pending() == null &&
        busy === null)
    )
      return;
    return props.registerLeaveGuard?.((reason) => {
      if (
        auto?.isDirty() ||
        publicationRef.current?.pending() != null ||
        busyRef.current
      ) {
        if (reason !== "unload")
          setNotice(
            "当前内容或发布结果尚未确认，请先保存并使用编辑器的返回按钮。",
          );
        return "blocked";
      }
      return "allow";
    });
  }, [auto, saved.status, busy, props.registerLeaveGuard]);
  const failed = (error: unknown) =>
    setNotice(
      publicationRef.current?.unconfirmed()
        ? "发布结果尚未确认。请重试确认同一次发布，当前输入仍保留。"
        : error instanceof ArticleRequestError && error.status === 409
          ? "专题版本已变化。当前输入仍保留，请比较版本后继续。"
          : "暂时无法完成，当前输入仍保留。请检查保存状态并重试。",
    );
  const act = async (
    kind: "preview" | "publish" | "close",
    operation: () => Promise<void>,
  ) => {
    if (busy !== null) return;
    setNotice(null);
    setBusy(kind);
    try {
      await operation();
    } catch (error) {
      if (
        (kind === "preview" || kind === "publish") &&
        error instanceof ArticleRequestError &&
        error.status === 409 &&
        !error.outcomeUnknown
      ) {
        activeSave().noteCandidateConflict();
        setPreview(null);
        setCompare(true);
        await activeSave().inspectRemote().catch(failed);
      } else failed(error);
    } finally {
      setBusy(null);
    }
  };
  const identityEpoch = authorClient.accountEpoch();
  useEffect(() => {
    auto?.checkIdentity();
  }, [auto, identityEpoch]);
  const openPreview = () =>
    void act("preview", async () => {
      const committed = await activeSave().flush();
      const exact = {
        requestId: crypto.randomUUID(),
        expectedVersion: committed.version,
        fingerprint: committed.fingerprint,
      };
      setPreview(
        await client.preview(committed.id, exact, abortRef.current!.signal),
      );
    });
  const publish = () => {
    if (!canChange()) return;
    const publication = publicationRef.current;
    if (preview === null || !preview.validation.valid || publication === null)
      return;
    const existing = publication.pending();
    if (existing === null && activeSave().isDirty()) return;
    const exact = preview.draft;
    const checkpoint =
      existing?.checkpoint ?? activeSave().publicationCheckpoint();
    if (
      checkpoint.version !== exact.version ||
      checkpoint.fingerprint !== exact.fingerprint
    ) {
      setNotice("专题已更新，请重新预览后发布。");
      return;
    }
    void act("publish", async () => {
      const verified = await publication.submit(
        exact,
        checkpoint,
        abortRef.current!.signal,
      );
      const result = verified.result;
      activeSave().adoptPublicationResult(result.draft, verified.checkpoint);
      if (result.status === "published" && !activeSave().isDirty())
        props.onPublished(result.draft.id);
      else {
        setPreview(null);
        setNotice(
          result.status === "published"
            ? "候选已公开，当前新输入仍保留，请继续保存。"
            : "已提交审核，尚未公开。通过审核前，读者仍看到此前已发布版本。",
        );
      }
    });
  };
  const insertMedia = async (multiple: boolean) => {
    if (editor === null || busy !== null || !canChange()) return;
    const anchor = editor.getTextCursorPosition().block.id;
    setBusy("media");
    setInsertMenu(false);
    try {
      const selected = await latest.current.media.choose({
        multiple,
        signal: abortRef.current!.signal,
      });
      if (!canChange() || selected.length === 0) return;
      const bounded = multiple ? articleAuthoringLimits.galleryImages : 1;
      if (selected.length > bounded) throw new Error("article_gallery_limit");
      const attached = attachArticleReferences(
        latest.current.attachments,
        selected,
        nextStableId,
      );
      if (
        Object.keys(attached.attachments.references).length >
        articleAuthoringLimits.imageReferences
      )
        throw new Error("article_image_reference_limit");
      if (multiple) {
        const groupId = nextStableId();
        const next = {
          ...attached.attachments,
          galleries: {
            ...attached.attachments.galleries,
            [groupId]: { referenceIds: attached.referenceIds },
          },
        };
        latest.current = { ...latest.current, attachments: next };
        setAttachments(next);
        editor.insertBlocks(
          [{ id: nextStableId(), type: "imageGallery", props: { groupId } }],
          anchor,
          "after",
        );
      } else {
        latest.current = {
          ...latest.current,
          attachments: attached.attachments,
        };
        setAttachments(attached.attachments);
        editor.insertBlocks(
          [
            {
              id: nextStableId(),
              type: "managedImage",
              props: { refId: attached.referenceIds[0]!, caption: "", alt: "" },
            },
          ],
          anchor,
          "after",
        );
      }
      auto?.changed();
    } catch (error) {
      failed(error);
    } finally {
      setBusy(null);
      editor.focus();
    }
  };
  const insertCatalog = async () => {
    if (editor === null || busy !== null || !canChange()) return;
    const anchor = editor.getTextCursorPosition().block.id;
    setInsertMenu(false);
    setBusy("media");
    try {
      const catalogId = await latest.current.media.chooseCatalog(
        abortRef.current!.signal,
      );
      if (canChange() && catalogId !== null)
        editor.insertBlocks(
          [
            {
              id: nextStableId(),
              type: "catalogReference",
              props: { catalogId },
            },
          ],
          anchor,
          "after",
        );
    } catch (error) {
      failed(error);
    } finally {
      setBusy(null);
      editor.focus();
    }
  };
  const insertText = (
    type:
      | "paragraph"
      | "heading"
      | "bulletListItem"
      | "numberedListItem"
      | "quote"
      | "divider",
    level: 2 | 3 = 2,
  ) => {
    if (editor === null || !canChange()) return;
    const anchor = editor.getTextCursorPosition().block.id;
    if (type === "heading")
      editor.insertBlocks(
        [{ id: nextStableId(), type, props: { level } }],
        anchor,
        "after",
      );
    else editor.insertBlocks([{ id: nextStableId(), type }], anchor, "after");
    setInsertMenu(false);
    editor.focus();
  };
  const protectListNesting = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      !canChange() ||
      event.key !== "Tab" ||
      editor === null ||
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLButtonElement
    )
      return;
    const block = editor.getTextCursorPosition().block;
    const list =
      block.type === "bulletListItem" || block.type === "numberedListItem";
    if (!list) {
      event.stopPropagation();
      return;
    }
    if (event.shiftKey) {
      if (editor.canUnnestBlock()) {
        event.preventDefault();
        event.stopPropagation();
        editor.unnestBlock();
      }
      return;
    }
    const previous = editor.getPrevBlock(block.id);
    let depth = 1;
    for (
      let parent = editor.getParentBlock(block.id);
      parent !== undefined;
      parent = editor.getParentBlock(parent.id)
    )
      depth++;
    if (
      previous !== undefined &&
      (previous.type === "bulletListItem" ||
        previous.type === "numberedListItem") &&
      depth < articleAuthoringLimits.depth &&
      editor.canNestBlock()
    ) {
      event.preventDefault();
      event.stopPropagation();
      editor.nestBlock();
    } else event.stopPropagation();
  };
  const customSlashItems =
    editor === null
      ? []
      : [
          {
            title: "图片",
            group: "素材",
            aliases: ["image", "图片"],
            onItemClick: () => void insertMedia(false),
          },
          {
            title: "图片组",
            group: "素材",
            aliases: ["gallery", "图组"],
            onItemClick: () => void insertMedia(true),
          },
          {
            title: "藏品引用",
            group: "素材",
            aliases: ["catalog", "藏品"],
            onItemClick: () => void insertCatalog(),
          },
        ];
  const moveGalleryImage = (
    blockId: string,
    groupId: string,
    index: number,
    offset: -1 | 1,
  ) => {
    if (!canChange()) return;
    const current = latest.current.attachments;
    const group = Object.hasOwn(current.galleries, groupId)
      ? current.galleries[groupId]
      : undefined;
    if (
      group === undefined ||
      index + offset < 0 ||
      index + offset >= group.referenceIds.length
    )
      return;
    const ids = [...group.referenceIds];
    const [moving] = ids.splice(index, 1);
    ids.splice(index + offset, 0, moving!);
    if (
      editor === null ||
      editor.getBlock(blockId)?.type !== "imageGallery" ||
      Object.keys(current.galleries).length >= articleAuthoringLimits.blocks
    ) {
      setNotice("当前图组调整历史已达上限，请保存并重新打开后继续。");
      return;
    }
    // Retain the old group and change the block's primitive group key through
    // BlockNote's own history, so Undo restores the exact earlier ordering.
    const nextGroupId = nextStableId();
    const next = {
      ...current,
      galleries: { ...current.galleries, [nextGroupId]: { referenceIds: ids } },
    };
    latest.current = { ...latest.current, attachments: next };
    setAttachments(next);
    editor.updateBlock(blockId, {
      type: "imageGallery",
      props: { groupId: nextGroupId },
    });
  };
  return (
    <section
      className={styles.editor}
      data-article-authoring=""
      aria-label="专题编辑器"
      onCompositionStartCapture={() => auto?.composition(true)}
      onCompositionEndCapture={() => auto?.composition(false)}
    >
      <header className={styles.bar}>
        <button
          type="button"
          ref={props.backButtonRef}
          disabled={busy !== null}
          onClick={() =>
            void act("close", async () => {
              if (auto?.isDirty() || publicationRef.current?.pending() != null)
                await activeSave().flush();
              props.onBack();
            })
          }
        >
          返回
        </button>
        <div className={styles.status}>
          <strong>专题</strong>
          <span
            aria-live={
              saved.status === "failed" ||
              saved.status === "conflict" ||
              saved.status === "permission_lost"
                ? "polite"
                : "off"
            }
          >
            {statusText[saved.status]}
          </span>
        </div>
        <button
          type="button"
          disabled={
            editor === null ||
            busy !== null ||
            saved.status === "conflict" ||
            saved.status === "permission_lost"
          }
          onClick={openPreview}
        >
          {busy === "preview" ? "准备预览…" : "预览"}
        </button>
      </header>
      <div className={styles.messages}>
        {saved.message !== null ? (
          <div className={styles.notice} role="alert">
            {saved.message}
            {saved.status === "failed" ? (
              <button
                type="button"
                onClick={() => void activeSave().retry().catch(failed)}
              >
                重试保存
              </button>
            ) : null}
            {saved.status === "conflict" ? (
              <button
                type="button"
                onClick={() => {
                  setCompare(true);
                  void activeSave().inspectRemote().catch(failed);
                }}
              >
                比较版本
              </button>
            ) : null}
          </div>
        ) : null}
        {notice !== null ? (
          <p className={styles.notice} role="status">
            {notice}
          </p>
        ) : null}
      </div>
      <div className={styles.scroller}>
        <label className={styles.title}>
          <span className={styles.srOnly}>专题标题</span>
          <input
            aria-label="专题标题"
            placeholder="写下专题标题"
            value={title}
            disabled={
              auto === null ||
              busy !== null ||
              saved.status === "permission_lost"
            }
            maxLength={articleAuthoringLimits.titleCodePoints * 2}
            onChange={(event) => {
              if (!canChange()) return;
              const value = event.currentTarget.value;
              latest.current = { ...latest.current, title: value };
              setTitle(value);
              auto?.changed();
            }}
          />
        </label>
        {articleTextLength(title) > articleAuthoringLimits.titleCodePoints ? (
          <p role="alert">标题最多 120 字，请调整后保存。</p>
        ) : null}
        <div className={styles.touchTools} aria-label="编辑工具">
          <button
            type="button"
            aria-expanded={insertMenu}
            disabled={editor === null || busy !== null || !mutationAllowed}
            onClick={() => setInsertMenu((open) => !open)}
          >
            插入
          </button>
          <button
            type="button"
            disabled={editor === null || busy !== null || !mutationAllowed}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (canChange()) editor?.moveBlocksUp();
            }}
          >
            上移
          </button>
          <button
            type="button"
            disabled={editor === null || busy !== null || !mutationAllowed}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (canChange()) editor?.moveBlocksDown();
            }}
          >
            下移
          </button>
          <button
            type="button"
            disabled={editor === null || busy !== null || !mutationAllowed}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (canChange()) editor?.undo();
            }}
          >
            撤销
          </button>
          <button
            type="button"
            disabled={editor === null || busy !== null || !mutationAllowed}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (canChange()) editor?.redo();
            }}
          >
            重做
          </button>
        </div>
        {insertMenu && mutationAllowed ? (
          <div className={styles.insertMenu} aria-label="插入内容">
            <button type="button" onClick={() => insertText("paragraph")}>
              段落
            </button>
            <button type="button" onClick={() => insertText("heading", 2)}>
              章节标题
            </button>
            <button type="button" onClick={() => insertText("heading", 3)}>
              小节标题
            </button>
            <button type="button" onClick={() => insertText("bulletListItem")}>
              无序列表
            </button>
            <button
              type="button"
              onClick={() => insertText("numberedListItem")}
            >
              有序列表
            </button>
            <button type="button" onClick={() => insertText("quote")}>
              引用
            </button>
            <button type="button" onClick={() => insertText("divider")}>
              分隔线
            </button>
            <button type="button" onClick={() => void insertMedia(false)}>
              图片
            </button>
            <button type="button" onClick={() => void insertMedia(true)}>
              图片组
            </button>
            <button type="button" onClick={() => void insertCatalog()}>
              藏品引用
            </button>
          </div>
        ) : null}
        <div className={styles.document} onKeyDownCapture={protectListNesting}>
          {editor === null ? (
            <p role="status">正在加载编辑器…</p>
          ) : (
            <ArticleAttachmentContext.Provider
              value={{
                attachments,
                media,
                disabled:
                  !mutationAllowed ||
                  busy !== null ||
                  preview !== null ||
                  saved.status === "permission_lost" ||
                  compare,
                moveGalleryImage,
              }}
            >
              <BlockNoteView
                editor={editor}
                editable={
                  mutationAllowed &&
                  busy === null &&
                  preview === null &&
                  saved.status !== "permission_lost"
                }
                className={styles.blocknote}
                formattingToolbar={false}
                linkToolbar={false}
                slashMenu={false}
                sideMenu={false}
                filePanel={false}
                emojiPicker={false}
                tableHandles={false}
                {...(portal === null
                  ? {}
                  : { portalElements: { default: portal } })}
                onChange={(_editor, context) => {
                  // Editable/focus updates may emit an empty transaction.
                  // Only document changes advance the persisted edit generation.
                  if (canChange() && context.getChanges().length !== 0)
                    auto?.changed();
                }}
              >
                <FormattingToolbarController
                  formattingToolbar={SelectionTools}
                  {...(portal === null ? {} : { portalElement: portal })}
                />
                <SuggestionMenuController
                  triggerCharacter="/"
                  getItems={async (query) =>
                    filterSuggestionItems(
                      [
                        ...getDefaultReactSlashMenuItems(editor),
                        ...customSlashItems,
                      ],
                      query,
                    )
                  }
                  {...(portal === null ? {} : { portalElement: portal })}
                />
              </BlockNoteView>
            </ArticleAttachmentContext.Provider>
          )}
        </div>
        <label className={styles.cover}>
          <span>封面</span>
          <select
            aria-label="专题封面"
            value={coverRefId ?? ""}
            disabled={busy !== null || !mutationAllowed}
            onChange={(event) => {
              if (!canChange()) return;
              const id = event.currentTarget.value || null;
              latest.current = { ...latest.current, coverRefId: id };
              setCoverRefId(id);
              auto?.changed();
            }}
          >
            <option value="">不设封面</option>
            {Object.keys(attachments.references).map((id, index) => (
              <option key={id} value={id}>
                已选图片 {index + 1}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div
        ref={setPortal}
        className={styles.portal}
        data-article-editor-portals=""
      />
      {preview !== null ? (
        <EditorDialog
          title="专题预览"
          size="wide"
          dataName="article-preview"
          cancellable={!publicationRef.current?.unconfirmed()}
          onCancel={() => {
            if (!publicationRef.current?.unconfirmed()) setPreview(null);
          }}
        >
          <h3>{preview.draft.title}</h3>
          <ArticleRichBody
            document={preview.draft.document}
            renderMedia={(reference, alt) =>
              media.render(reference, { alt, active: busy !== "publish" })
            }
            renderCatalog={media.renderCatalog}
          />
          {preview.validation.valid ? (
            <p>
              这是已保存的第 {preview.draft.version}{" "}
              版。发布时会再次核对权限和素材。
            </p>
          ) : (
            <p role="alert">
              预览发现不可用素材或缺失信息，请返回编辑后再发布。
            </p>
          )}
          <div className={styles.actions}>
            <button
              type="button"
              disabled={busy !== null || publicationRef.current?.unconfirmed()}
              onClick={() => setPreview(null)}
            >
              返回编辑
            </button>
            <button
              type="button"
              className={styles.primary}
              disabled={
                !mutationAllowed ||
                !preview.validation.valid ||
                busy !== null ||
                (activeSave().isDirty() &&
                  publicationRef.current?.pending() === null)
              }
              onClick={publish}
            >
              {busy === "publish"
                ? "提交中…"
                : publicationRef.current?.unconfirmed()
                  ? "重试确认发布"
                  : "提交发布"}
            </button>
          </div>
        </EditorDialog>
      ) : null}
      {compare ? (
        <EditorDialog
          title="比较专题版本"
          size="wide"
          dataName="article-conflict"
          onCancel={() => setCompare(false)}
        >
          <p>
            当前输入未被替换。请检查另一窗口或 Agent 已保存的版本，再明确选择。
          </p>
          {saved.remote === null ? (
            <p role="status">正在读取服务器版本…</p>
          ) : (
            <>
              <h3>
                服务器第 {saved.remote.version} 版：{saved.remote.title}
              </h3>
              <p className={styles.comparison}>
                {articleDocumentPlainText(saved.remote.document)}
              </p>
              <div className={styles.actions}>
                <button type="button" onClick={() => setCompare(false)}>
                  继续保留当前输入
                </button>
                <button
                  type="button"
                  disabled={!mutationAllowed}
                  onClick={() => {
                    if (!canChange()) return;
                    setCompare(false);
                    if (canChange()) props.onReloadDraft(saved.remote!);
                  }}
                >
                  使用服务器版本
                </button>
                <button
                  type="button"
                  disabled={!mutationAllowed}
                  onClick={() => {
                    if (!canChange()) return;
                    setCompare(false);
                    void activeSave().keepLocalAfterComparison().catch(failed);
                  }}
                >
                  以当前输入另存下一版
                </button>
              </div>
            </>
          )}
        </EditorDialog>
      ) : null}
    </section>
  );
}
