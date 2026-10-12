"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { authorClient } from "../../../lib/public-api/author-community-client";
import {
  articleAuthoringClient,
  ArticleRequestError,
  createEmptyArticleDocument,
} from "../../../lib/public-api/article-authoring-client";
import { useAuthors } from "../../authors/author-context";
import { requestIdentity } from "../../shell/request-identity";
import { useArticleAvailability } from "./article-availability";

import type { CreateArticleDraftCommand } from "@moya/contracts";
import type { IconName } from "@moya/ui";
import type { ProductShellEditorOverlayControls } from "../../product-shell/product-shell";

/**
 * Creating an empty 专题文章 draft, shared by the desktop 发布内容 dialog
 * (article-create-entry.tsx) and the phone editor's start screen 专题 option
 * (#244 r4, spec §4.2). The hook only confirms the draft; where the author
 * goes next is the caller's: the dialog opens the profile and then the
 * article editor, the start screen swaps the editor in place.
 *
 * The create command is idempotent: an answer whose outcome is unknown keeps
 * the command, so the next `create()` re-sends the same `requestId` and the
 * Backend confirms the same draft instead of making a second one. A known
 * refusal drops it, so the next try is a new command. Every answer is fenced
 * to the account and account epoch it was sent for.
 *
 * Unmounting is not an account change: a creation confirmed after the caller
 * unmounted (the overlay closed, the layout swapped the entry away) for the
 * same account tells the author where the draft is
 * (`ARTICLE_DRAFT_ORPHAN_NOTICE`) instead of dropping it silently. After an
 * account change nothing is said once unmounted.
 */

/** The 专题 tab's glyph (讨论 → 专题), reused by the start screen's 专题. */
export const ARTICLE_TOPIC_ICON = "academic-cap" satisfies IconName;

/** A draft was confirmed but nothing is left to open it in. */
export const ARTICLE_DRAFT_ORPHAN_NOTICE =
  "专题草稿已创建，请从个人页的草稿箱继续编辑。";
/** The account is still being checked, failed, or does not match. */
export const ARTICLE_DRAFT_ACCOUNT_NOTICE = "请先确认当前账号后创建专题文章。";
/** The account fence moved while the create was in flight. */
export const ARTICLE_DRAFT_ACCOUNT_CHANGED_NOTICE =
  "账号验证已变化，创建结果尚未确认；请重新确认账号后重试同一次创建。";
/** The answer was lost: the retry confirms the same creation. */
export const ARTICLE_DRAFT_UNKNOWN_NOTICE =
  "创建结果尚未确认，重试会确认同一次创建。";
/** A known refusal: the retry is a new creation. */
export const ARTICLE_DRAFT_FAILED_NOTICE = "暂时无法创建专题文章，请重试。";

export interface ArticleDraftCreation {
  /** A create is in flight. */
  readonly creating: boolean;
  /** The last outcome is unknown: the next create re-sends the same requestId. */
  readonly retrying: boolean;
  readonly notice: string | null;
  /** The confirmed draft id, else null (`notice` says why). */
  readonly create: () => Promise<string | null>;
  readonly clearNotice: () => void;
}

type OverlayRoute = Pick<ProductShellEditorOverlayControls, "replaceTarget">;

/**
 * Opens a confirmed 专题 draft in place of the open editor. `replaceTarget`
 * keeps the editor session's history entry, so Back still returns to where
 * the editor was opened from.
 */
export const openArticleDraftInPlace = (
  controls: OverlayRoute,
  id: string,
): void => controls.replaceTarget({ type: "article-draft", id });

/**
 * 草稿箱 from an open editor: the article editor's own 返回草稿列表 route.
 * The article host sets `drafts-box-return` and calls `openDraftBox`, which
 * replaces the editor entry with 用户 → 作品 with 草稿箱 open
 * (article-host.tsx).
 */
export const openArticleDraftBox = (controls: OverlayRoute): void =>
  controls.replaceTarget({ type: "article-list" });

interface PendingCommand {
  readonly ownerId: string;
  readonly content: CreateArticleDraftCommand;
}

export const useArticleDraftCreation = (): ArticleDraftCreation => {
  const author = useAuthors();
  const articleEnabled = useArticleAvailability();
  const [creating, setCreating] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const command = useRef<PendingCommand | null>(null);
  const inFlight = useRef(false);
  const generation = useRef(0);
  const alive = useRef(true);
  const viewerId = author.viewer?.id;

  // An account change (only): a pending command and any answer still on its
  // way belong to the previous account.
  useEffect(() => {
    generation.current++;
    command.current = null;
    inFlight.current = false;
    setCreating(false);
    setRetrying(false);
    setNotice(null);
  }, [viewerId]);

  // Unmounting only: a late answer is not mistaken for an account change.
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const create = useCallback(async (): Promise<string | null> => {
    if (inFlight.current) return null;
    const ownerId = author.viewer?.id;
    if (
      !articleEnabled ||
      author.checking ||
      author.sessionError ||
      ownerId === undefined ||
      authorClient.account() !== ownerId
    ) {
      setNotice(ARTICLE_DRAFT_ACCOUNT_NOTICE);
      return null;
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
        // Unconfirmed for this account: the command stays for the retry.
        if (run === generation.current && alive.current) {
          setRetrying(true);
          setNotice(ARTICLE_DRAFT_ACCOUNT_CHANGED_NOTICE);
        }
        return null;
      }
      if (created.ownerId !== ownerId)
        throw new ArticleRequestError(502, "article_invalid_response", true);
      command.current = null;
      if (!alive.current) {
        author.notify(ARTICLE_DRAFT_ORPHAN_NOTICE);
        return null;
      }
      setRetrying(false);
      return created.id;
    } catch (error) {
      if (run !== generation.current) return null;
      const unknown =
        !(error instanceof ArticleRequestError) || error.outcomeUnknown;
      if (!unknown) command.current = null;
      if (alive.current) {
        setRetrying(unknown);
        setNotice(
          unknown ? ARTICLE_DRAFT_UNKNOWN_NOTICE : ARTICLE_DRAFT_FAILED_NOTICE,
        );
      }
      return null;
    } finally {
      if (run === generation.current) {
        inFlight.current = false;
        if (alive.current) setCreating(false);
      }
    }
  }, [author, articleEnabled]);

  const clearNotice = useCallback(() => setNotice(null), []);

  return { creating, retrying, notice, create, clearNotice };
};
