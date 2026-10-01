"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ArticleCollectionDetail,
  ArticleDetail,
  ArticlePresentation,
  ArticleSummary,
} from "@moya/contracts";
import { authorClient, AuthorRequestError } from "./editorial-data";

export type EditorialListState<T> =
  | { readonly state: "loading" }
  | {
      readonly state: "populated";
      readonly items: readonly T[];
      readonly total: number;
      readonly hasMore: boolean;
    }
  | { readonly state: "empty" }
  | { readonly state: "unavailable" };

export type EditorialDetailState<T> =
  | { readonly state: "loading" }
  | { readonly state: "populated"; readonly item: T }
  | { readonly state: "missing" }
  | { readonly state: "unavailable" };

const PAGE_SIZE = 12;

const useList = <T>(
  load: (
    page: number,
    signal: AbortSignal,
  ) => Promise<{
    items: readonly T[];
    total: number;
    totalPages: number;
  }>,
  key: string,
) => {
  const [state, setState] = useState<EditorialListState<T>>({
    state: "loading",
  });
  const [pageNumber, setPageNumber] = useState(1);
  const [busy, setBusy] = useState(false);
  const items = useRef<T[]>([]);
  const epoch = useRef(0);
  const run = useCallback(
    async (page: number, attempt = 0): Promise<void> => {
      const current = ++epoch.current;
      const controller = new AbortController();
      setBusy(true);
      try {
        const result = await load(page, controller.signal);
        if (current !== epoch.current) return;
        items.current =
          page === 1 ? [...result.items] : [...items.current, ...result.items];
        setPageNumber(page);
        setState(
          items.current.length === 0
            ? { state: "empty" }
            : {
                state: "populated",
                items: items.current,
                total: result.total,
                hasMore: page < result.totalPages,
              },
        );
      } catch (error) {
        if (current !== epoch.current) return;
        // The shared client refuses a read that finished while the account
        // changed; these anonymous reads are simply asked again once.
        if (
          error instanceof AuthorRequestError &&
          error.status === 401 &&
          attempt === 0
        )
          return run(page, 1);
        // An empty list is a 200 with no items; any refusal (including a 404
        // from a runtime that composes no editorial reads) is "unavailable".
        setState({ state: "unavailable" });
      } finally {
        if (current === epoch.current) setBusy(false);
      }
    },
    [load],
  );
  useEffect(() => {
    items.current = [];
    setState({ state: "loading" });
    void run(1);
    return () => {
      epoch.current++;
    };
  }, [run, key]);
  return {
    state,
    busy,
    retry: () => void run(items.current.length === 0 ? 1 : pageNumber),
    loadMore: () => void run(pageNumber + 1),
  };
};

// Presentations of Articles already listed, so an Article opened from a feed
// can title its overlay (近闻 or 专题) before its own detail loads.
const listedPresentations = new Map<string, ArticlePresentation>();

export const listedArticlePresentation = (
  id: string,
): ArticlePresentation | null => listedPresentations.get(id) ?? null;

export const useArticles = (presentation: ArticlePresentation) =>
  useList<ArticleSummary>(
    useCallback(
      async (page, signal) => {
        const result = await authorClient.editorial.articles(
          { page, pageSize: PAGE_SIZE, presentation },
          signal,
        );
        for (const item of result.items)
          listedPresentations.set(item.id, item.presentation);
        return result;
      },
      [presentation],
    ),
    presentation,
  );

const useDetail = <T>(
  load: (signal: AbortSignal) => Promise<T>,
  key: string,
) => {
  const [state, setState] = useState<EditorialDetailState<T>>({
    state: "loading",
  });
  const epoch = useRef(0);
  const run = useCallback(
    async (attempt = 0): Promise<void> => {
      const current = ++epoch.current;
      const controller = new AbortController();
      setState({ state: "loading" });
      try {
        const item = await load(controller.signal);
        if (current === epoch.current) setState({ state: "populated", item });
      } catch (error) {
        if (current !== epoch.current) return;
        if (
          error instanceof AuthorRequestError &&
          error.status === 401 &&
          attempt === 0
        )
          return run(1);
        setState(
          error instanceof AuthorRequestError && error.status === 404
            ? { state: "missing" }
            : { state: "unavailable" },
        );
      }
    },
    [load],
  );
  useEffect(() => {
    void run();
    return () => {
      epoch.current++;
    };
  }, [run, key]);
  return { state, retry: () => void run() };
};

export const useArticle = (id: string) =>
  useDetail<ArticleDetail>(
    useCallback((signal) => authorClient.editorial.article(id, signal), [id]),
    id,
  );

export const useCollection = (id: string) =>
  useDetail<ArticleCollectionDetail>(
    useCallback(
      (signal) => authorClient.editorial.collection(id, signal),
      [id],
    ),
    id,
  );

export const isArticleId = (id: string | null): id is string =>
  typeof id === "string" && /^article-[0-9a-f]{32}$/u.test(id);
export const isCollectionId = (id: string | null): id is string =>
  typeof id === "string" && /^collection-[0-9a-f]{32}$/u.test(id);
