"use client";

import { useEffect, useRef, useState } from "react";
import { useAuthors } from "../../authors/author-context";
import { useProductShell } from "../../product-shell/product-shell";
import { CreateWorkAction } from "../../publishing/create-action";
import { usePublishingEntry } from "../../publishing/publishing-entry";
import { EditorDialog } from "../../publishing/ui/editor/editor-dialog";
import { useEditorLayout } from "../../publishing/ui/editor/editor-layout";
import { useArticleAvailability } from "./article-availability";
import styles from "./article-authoring.module.css";
import {
  ARTICLE_DRAFT_ORPHAN_NOTICE,
  useArticleDraftCreation,
} from "./use-article-draft-creation";

/**
 * The existing Work action still resumes an in-progress Work unchanged. On
 * the phone layout (#244 r4) the plus opens the editor straight on its start
 * screen, which offers 专题 and 草稿箱 itself; the desktop editor keeps the
 * 发布内容 dialog.
 */
export const ArticleCreateEntry = () => {
  const author = useAuthors();
  const shell = useProductShell();
  const work = usePublishingEntry();
  const articleEnabled = useArticleAvailability();
  const layout = useEditorLayout();
  const article = useArticleDraftCreation();
  const opener = useRef<HTMLElement | null>(null);
  const [choice, setChoice] = useState(false);

  useEffect(() => {
    setChoice(false);
  }, [author.viewer?.id]);

  const createArticle = async () => {
    const ownerId = author.viewer?.id;
    const id = await article.create();
    if (id === null || ownerId === undefined) return;
    const button = opener.current;
    if (button === null || !button.isConnected) {
      setChoice(false);
      author.notify(ARTICLE_DRAFT_ORPHAN_NOTICE);
      return;
    }
    author.cache.set(`drafts-box-return:${ownerId}`, "article");
    // Give the editor the existing own Works profile as its real predecessor.
    shell.openProfile(null, button);
    setChoice(false);
    if (!shell.openEditor({ type: "article-draft", id }, button))
      author.notify("专题草稿已创建，请从草稿箱继续编辑。");
  };

  if (!articleEnabled) return <CreateWorkAction />;

  return (
    <>
      <CreateWorkAction
        newLabel="发布内容"
        onNew={(button) => {
          if (author.checking) return;
          if (author.viewer === null) {
            shell.openProfile(null, button);
            return;
          }
          if (layout === "phone") {
            work.openEditor({ type: "new" }, button);
            return;
          }
          opener.current = button;
          article.clearNotice();
          setChoice(true);
        }}
      />
      {choice ? (
        <EditorDialog
          title="发布内容"
          cancellable={!article.creating}
          onCancel={() => setChoice(false)}
        >
          <div className={styles.actions}>
            <button
              type="button"
              disabled={article.creating}
              onClick={() => {
                setChoice(false);
                if (opener.current !== null)
                  work.openEditor({ type: "new" }, opener.current);
              }}
            >
              作品
            </button>
            {articleEnabled ? (
              <button
                type="button"
                disabled={
                  article.creating || author.checking || author.sessionError
                }
                onClick={() => void createArticle()}
              >
                {article.creating
                  ? "正在创建…"
                  : article.retrying
                    ? "重试确认创建"
                    : "专题文章"}
              </button>
            ) : null}
            <button
              type="button"
              disabled={article.creating}
              onClick={() => {
                const button = opener.current;
                const ownerId = author.viewer?.id;
                if (button === null || ownerId === undefined || author.checking)
                  return;
                if (articleEnabled)
                  author.cache.set(`drafts-box-return:${ownerId}`, "article");
                setChoice(false);
                shell.openProfile(null, button);
              }}
            >
              草稿箱
            </button>
          </div>
          {article.notice === null ? null : (
            <p role="alert">{article.notice}</p>
          )}
        </EditorDialog>
      ) : null}
    </>
  );
};
