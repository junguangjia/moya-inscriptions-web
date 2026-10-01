"use client";
import { useRef, useState } from "react";
import { useAuthors } from "../../authors/author-context";
import { useProductShell } from "../../product-shell/product-shell";
import { CreateWorkAction } from "../../publishing/create-action";
import { usePublishingEntry } from "../../publishing/publishing-entry";
import { EditorDialog } from "../../publishing/ui/editor/editor-dialog";
import styles from "./article-authoring.module.css";

/** The existing Work action still resumes an in-progress Work unchanged. */
export const ArticleCreateEntry = () => {
  const author = useAuthors();
  const shell = useProductShell();
  const work = usePublishingEntry();
  const opener = useRef<HTMLElement | null>(null);
  const [choice, setChoice] = useState(false);
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
          opener.current = button;
          setChoice(true);
        }}
      />
      {choice ? (
        <EditorDialog title="发布内容" onCancel={() => setChoice(false)}>
          <div className={styles.actions}>
            <button
              type="button"
              onClick={() => {
                setChoice(false);
                if (opener.current !== null)
                  work.openEditor({ type: "new" }, opener.current);
              }}
            >
              作品
            </button>
            <button
              type="button"
              onClick={() => {
                setChoice(false);
                if (opener.current !== null)
                  shell.openEditor({ type: "article-list" }, opener.current);
              }}
            >
              专题文章与草稿
            </button>
          </div>
        </EditorDialog>
      ) : null}
    </>
  );
};
