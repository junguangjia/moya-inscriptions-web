"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ThreadPage, ThreadSummary, UserWork } from "@moya/contracts";
import { useAuthors } from "../authors/author-context";
import { authorClient, AuthorRequestError } from "./thread-data";

export type ThreadsState =
  | { readonly state: "loading" }
  | {
      readonly state: "populated";
      readonly items: readonly ThreadSummary[];
      readonly anchor: string;
      readonly hasMore: boolean;
    }
  | { readonly state: "empty" }
  | { readonly state: "unavailable" };

/** Ranked Threads at one server anchor for the whole browsing sequence. */
export const useThreads = () => {
  const author = useAuthors();
  const [state, setState] = useState<ThreadsState>({ state: "loading" });
  const [busy, setBusy] = useState(false);
  const items = useRef<ThreadSummary[]>([]);
  const anchor = useRef<string | undefined>(undefined);
  const page = useRef(1);
  const epoch = useRef(0);
  const run = useCallback(async (next: number) => {
    const current = ++epoch.current;
    setBusy(true);
    try {
      const result: ThreadPage = await authorClient.threads.list({
        page: next,
        pageSize: 22,
        ...(next > 1 && anchor.current ? { anchor: anchor.current } : {}),
      });
      if (current !== epoch.current) return;
      anchor.current = result.anchor;
      items.current =
        next === 1 ? [...result.items] : [...items.current, ...result.items];
      page.current = next;
      setState(
        items.current.length === 0
          ? { state: "empty" }
          : {
              state: "populated",
              items: items.current,
              anchor: result.anchor,
              hasMore: next < result.totalPages,
            },
      );
    } catch (error) {
      if (current !== epoch.current) return;
      setState(
        error instanceof AuthorRequestError && error.status === 404
          ? { state: "empty" }
          : { state: "unavailable" },
      );
    } finally {
      if (current === epoch.current) setBusy(false);
    }
  }, []);
  // A fresh anchor per account: unread flags belong to the signed-in viewer.
  const account = author.viewer?.id ?? "guest";
  useEffect(() => {
    items.current = [];
    anchor.current = undefined;
    setState({ state: "loading" });
    void run(1);
    return () => {
      epoch.current++;
    };
  }, [run, account, author.revision]);
  return {
    state,
    busy,
    refresh: () => void run(1),
    loadMore: () => void run(page.current + 1),
  };
};

export type ThreadDetailState =
  | { readonly state: "loading" }
  | { readonly state: "populated"; readonly thread: ThreadSummary }
  | { readonly state: "missing" }
  | { readonly state: "unavailable" };

export const useThread = (id: string) => {
  const author = useAuthors();
  const [state, setState] = useState<ThreadDetailState>({ state: "loading" });
  const epoch = useRef(0);
  const run = useCallback(async () => {
    const current = ++epoch.current;
    try {
      const thread = await authorClient.threads.read(id);
      if (current === epoch.current) setState({ state: "populated", thread });
    } catch (error) {
      if (current !== epoch.current) return;
      setState(
        error instanceof AuthorRequestError && error.status === 404
          ? { state: "missing" }
          : { state: "unavailable" },
      );
    }
  }, [id]);
  useEffect(() => {
    setState({ state: "loading" });
    void run();
    return () => {
      epoch.current++;
    };
  }, [run, author.viewer?.id]);
  return { state, retry: () => void run() };
};

export type ThreadPostsState =
  | { readonly state: "loading" }
  | {
      readonly state: "populated";
      readonly items: readonly UserWork[];
      readonly total: number;
      readonly hasMore: boolean;
    }
  | { readonly state: "empty" }
  | { readonly state: "unavailable" };

export const useThreadPosts = (id: string, revision: number) => {
  const author = useAuthors();
  const [state, setState] = useState<ThreadPostsState>({ state: "loading" });
  const [busy, setBusy] = useState(false);
  const items = useRef<UserWork[]>([]);
  const page = useRef(1);
  const epoch = useRef(0);
  const run = useCallback(
    async (next: number) => {
      const current = ++epoch.current;
      setBusy(true);
      try {
        const result = await authorClient.threads.posts(id, next);
        if (current !== epoch.current) return;
        items.current =
          next === 1 ? [...result.items] : [...items.current, ...result.items];
        page.current = next;
        setState(
          items.current.length === 0
            ? { state: "empty" }
            : {
                state: "populated",
                items: items.current,
                total: result.total,
                hasMore: next * result.pageSize < result.total,
              },
        );
      } catch (error) {
        if (current !== epoch.current) return;
        setState(
          error instanceof AuthorRequestError && error.status === 404
            ? { state: "empty" }
            : { state: "unavailable" },
        );
      } finally {
        if (current === epoch.current) setBusy(false);
      }
    },
    [id],
  );
  useEffect(() => {
    items.current = [];
    setState({ state: "loading" });
    void run(1);
    return () => {
      epoch.current++;
    };
  }, [run, author.viewer?.id, revision]);
  return {
    state,
    busy,
    refresh: () => void run(1),
    loadMore: () => void run(page.current + 1),
  };
};

export const isThreadId = (id: string | null): id is string =>
  typeof id === "string" && /^thread-[0-9a-f]{32}$/u.test(id);
