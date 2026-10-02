"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ArticleDraftSummary } from "@moya/contracts";
import { authorClient } from "../../../lib/public-api/author-community-client";
import { articleAuthoringClient } from "../../../lib/public-api/article-authoring-client";
import { useAuthors } from "../../authors/author-context";
import { newestEditedFirst } from "../../publishing/ui/drafts/drafts-format";
/** Account-fenced data seam for the existing unified draft card grid. */
export const useArticleDrafts = (accountId: string, enabled: boolean) => {
  const author = useAuthors();
  const accountEpoch = authorClient.accountEpoch();
  const [items, setItems] = useState<readonly ArticleDraftSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const load = useCallback(
    async (after?: string) => {
      controller.current?.abort();
      const abort = new AbortController();
      controller.current = abort;
      const epoch = authorClient.accountEpoch();
      const live = () => controller.current === abort && !abort.signal.aborted;
      const owned = () =>
        authorClient.account() === accountId &&
        authorClient.accountEpoch() === epoch;
      if (!owned()) {
        setLoading(false);
        setError("账号暂时无法确认，请重新确认后读取专题草稿。");
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const page = await articleAuthoringClient.list(
          { pageSize: 20, ...(after === undefined ? {} : { cursor: after }) },
          abort.signal,
        );
        if (!live()) return;
        if (!owned()) {
          setItems([]);
          setCursor(null);
          setError("账号验证已变化，请重新确认后读取专题草稿。");
          return;
        }
        if (page.items.some((item) => item.ownerId !== accountId))
          throw new Error("article_drafts_owner_changed");
        setItems((old) =>
          [
            ...new Map(
              (after === undefined ? page.items : [...old, ...page.items]).map(
                (item) => [item.id, item],
              ),
            ).values(),
          ].sort(newestEditedFirst),
        );
        setCursor(page.nextCursor);
        setLoaded(true);
      } catch {
        if (live()) setError("暂时无法读取专题草稿，请重试。");
      } finally {
        if (live()) setLoading(false);
      }
    },
    [accountId],
  );

  useEffect(() => {
    setItems([]);
    setCursor(null);
    setLoaded(false);
    setError(null);
    if (!enabled) {
      setLoading(false);
      return;
    }
    if (
      author.checking ||
      author.sessionError ||
      author.viewer?.id !== accountId ||
      authorClient.account() !== accountId
    ) {
      setLoading(false);
      setError("账号暂时无法确认，请重新确认后读取专题草稿。");
      return;
    }
    void load();
    return () => controller.current?.abort();
  }, [
    accountId,
    enabled,
    accountEpoch,
    author.checking,
    author.sessionError,
    author.viewer?.id,
    load,
  ]);

  const confirmed =
    !author.checking &&
    !author.sessionError &&
    author.viewer?.id === accountId &&
    authorClient.account() === accountId;
  return {
    items: confirmed ? items : [],
    cursor,
    loading,
    loaded,
    error,
    confirmed,
    refresh: () => {
      if (confirmed) void load();
      else void author.refresh();
    },
    more: () => {
      if (confirmed && cursor !== null && !loading) void load(cursor);
    },
    forget: (id: string) =>
      setItems((current) => current.filter((item) => item.id !== id)),
  };
};
