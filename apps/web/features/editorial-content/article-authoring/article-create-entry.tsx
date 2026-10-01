"use client";

import { useEffect, useRef, useState } from "react";
import type { CreateArticleDraftCommand } from "@moya/contracts";
import { authorClient } from "../../../lib/public-api/author-community-client";
import {
  articleAuthoringClient,
  ArticleRequestError,
  createEmptyArticleDocument,
} from "../../../lib/public-api/article-authoring-client";
import { useAuthors } from "../../authors/author-context";
import { useProductShell } from "../../product-shell/product-shell";
import { CreateWorkAction } from "../../publishing/create-action";
import { usePublishingEntry } from "../../publishing/publishing-entry";
import { EditorDialog } from "../../publishing/ui/editor/editor-dialog";
import { requestIdentity } from "../../shell/request-identity";
import { useArticleAvailability } from "./article-availability";
import styles from "./article-authoring.module.css";

/** The existing Work action still resumes an in-progress Work unchanged. */
export const ArticleCreateEntry = () => {
  const author = useAuthors();
  const shell = useProductShell();
  const work = usePublishingEntry();
  const articleEnabled = useArticleAvailability();
  const opener = useRef<HTMLElement | null>(null);
  const [choice, setChoice] = useState(false);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const command = useRef<{
    ownerId: string;
    content: CreateArticleDraftCommand;
  } | null>(null);
  const inFlight = useRef(false);
  const generation = useRef(0);

  useEffect(() => {
    generation.current++;
    command.current = null;
    inFlight.current = false;
    setCreating(false);
    setNotice(null);
    setChoice(false);
    return () => {
      generation.current++;
    };
  }, [author.viewer?.id]);

  const createArticle = async () => {
    const ownerId = author.viewer?.id;
    if (inFlight.current) return;
    if (
      !articleEnabled ||
      author.checking ||
      author.sessionError ||
      ownerId === undefined ||
      authorClient.account() !== ownerId
    ) {
      setNotice("请先确认当前账号后创建专题文章。");
      return;
    }
    const epoch = authorClient.accountEpoch();
    const run = ++generation.current;
    const current = () =>
      run === generation.current &&
      authorClient.account() === ownerId &&
      authorClient.accountEpoch() === epoch;
    if (command.current === null || command.current.ownerId !== ownerId)
      command.current = {
        ownerId,
        content: {
          requestId: requestIdentity(),
          title: "",
          coverRefId: null,
          document: createEmptyArticleDocument(),
        },
      };
    const content = command.current.content;
    inFlight.current = true;
    setCreating(true);
    setNotice(null);
    try {
      const created = await articleAuthoringClient.create(content);
      if (!current()) {
        if (run === generation.current)
          setNotice(
            "账号验证已变化，创建结果尚未确认；请重新确认账号后重试同一次创建。",
          );
        return;
      }
      if (created.ownerId !== ownerId)
        throw new ArticleRequestError(502, "article_invalid_response", true);
      command.current = null;
      const button = opener.current;
      if (button === null || !button.isConnected) {
        setChoice(false);
        author.notify("专题草稿已创建，请从个人页的草稿箱继续编辑。");
        return;
      }
      author.cache.set(`drafts-box-return:${ownerId}`, "article");
      // Give the editor the existing own Works profile as its real predecessor.
      shell.openProfile(null, button);
      setChoice(false);
      if (!shell.openEditor({ type: "article-draft", id: created.id }, button))
        author.notify("专题草稿已创建，请从草稿箱继续编辑。");
    } catch (error) {
      if (run !== generation.current) return;
      const unknown =
        !(error instanceof ArticleRequestError) || error.outcomeUnknown;
      if (!unknown) command.current = null;
      setNotice(
        unknown
          ? "创建结果尚未确认，重试会确认同一次创建。"
          : "暂时无法创建专题文章，请重试。",
      );
    } finally {
      if (run === generation.current) {
        inFlight.current = false;
        setCreating(false);
      }
    }
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
          opener.current = button;
          setNotice(null);
          setChoice(true);
        }}
      />
      {choice ? (
        <EditorDialog
          title="发布内容"
          cancellable={!creating}
          onCancel={() => setChoice(false)}
        >
          <div className={styles.actions}>
            <button
              type="button"
              disabled={creating}
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
                disabled={creating || author.checking || author.sessionError}
                onClick={() => void createArticle()}
              >
                {creating
                  ? "正在创建…"
                  : command.current === null
                    ? "专题文章"
                    : "重试确认创建"}
              </button>
            ) : null}
            <button
              type="button"
              disabled={creating}
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
          {notice === null ? null : <p role="alert">{notice}</p>}
        </EditorDialog>
      ) : null}
    </>
  );
};
