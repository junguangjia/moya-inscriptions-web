"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DirectConversation,
  DirectMessage,
  DirectMessagePage,
} from "@moya/contracts";
import { useAuthors } from "../authors/author-context";
import { requestIdentity } from "../shell/request-identity";
import { authorClient, AuthorRequestError } from "./message-data";

/** Foreground polling interval for the open DM view (V1 default 10 s). */
export const DM_POLL_INTERVAL_MS = 10_000;
const DM_POLL_BACKOFF_MAX_MS = 60_000;

const describeFailure = (error: unknown): string => {
  if (error instanceof AuthorRequestError) {
    const code = error.reason ?? "";
    const known: Record<string, string> = {
      dm_request_pending: "你已发送一条私信，等对方回复后才能继续发送。",
      dm_blocked: "对方目前不接受你的私信。",
      dm_recipient_unavailable: "对方账号暂不可用。",
      dm_self: "不能给自己发私信。",
      dm_daily_limit: "今天新发起的私信对话已达上限，请明天再试。",
      dm_rate_limited: "发送太快了，请稍后再试。",
      dm_text_invalid: "私信内容需在 1 到 2000 字之间。",
    };
    if (error.status === 422 && Object.hasOwn(known, code)) return known[code]!;
    if (error.status === 401) return "请先登录";
    if (error.status === 404) return "对话不可用";
    if (error.status === 409) return "状态已变化，请刷新后重试";
  }
  return "暂时无法完成，请重试";
};

/**
 * Polls while the document is visible; pauses in a background tab and backs
 * off after failures. Polling only refreshes: it never fabricates a sent
 * result and never replaces business endpoints.
 */
const useForegroundPoll = (tick: () => Promise<void>, enabled: boolean) => {
  const failures = useRef(0);
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    const schedule = () => {
      const delay = Math.min(
        DM_POLL_INTERVAL_MS * 2 ** failures.current,
        DM_POLL_BACKOFF_MAX_MS,
      );
      timer = setTimeout(run, delay);
    };
    const run = async () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.hidden) {
        schedule();
        return;
      }
      try {
        await tick();
        failures.current = 0;
      } catch {
        failures.current = Math.min(failures.current + 1, 3);
      }
      if (!cancelled) schedule();
    };
    const onVisible = () => {
      if (!document.hidden) {
        if (timer) clearTimeout(timer);
        void run();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    schedule();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [tick, enabled]);
};

export type ConversationsState =
  | { readonly state: "loading" }
  | {
      readonly state: "populated";
      readonly items: readonly DirectConversation[];
      readonly nextCursor: string | null;
    }
  | { readonly state: "empty" }
  | { readonly state: "unavailable"; readonly message: string };

export const useConversations = (enabled: boolean) => {
  const author = useAuthors();
  const [state, setState] = useState<ConversationsState>({ state: "loading" });
  const items = useRef<DirectConversation[]>([]);
  const cursor = useRef<string | null>(null);
  const epoch = useRef(0);
  const load = useCallback(async (more = false) => {
    const current = ++epoch.current;
    try {
      const page = await authorClient.messages.list(
        more ? (cursor.current ?? undefined) : undefined,
      );
      if (current !== epoch.current) return;
      items.current = more
        ? [...items.current, ...page.items]
        : [...page.items];
      cursor.current = page.nextCursor;
      setState(
        items.current.length === 0
          ? { state: "empty" }
          : {
              state: "populated",
              items: items.current,
              nextCursor: page.nextCursor,
            },
      );
    } catch (error) {
      if (current !== epoch.current) return;
      setState({ state: "unavailable", message: describeFailure(error) });
      throw error;
    }
  }, []);
  const refresh = useCallback(() => load(false).catch(() => undefined), [load]);
  useEffect(() => {
    if (!enabled || !author.viewer) return;
    items.current = [];
    setState({ state: "loading" });
    void refresh();
  }, [enabled, author.viewer?.id, refresh]);
  useForegroundPoll(refresh, enabled && author.viewer !== null);
  /** Optimistic local replacement after a participant command. */
  const replace = useCallback((conversation: DirectConversation) => {
    items.current = items.current.map((c) =>
      c.id === conversation.id ? conversation : c,
    );
    setState((old) =>
      old.state === "populated" ? { ...old, items: items.current } : old,
    );
  }, []);
  const remove = useCallback((id: string) => {
    items.current = items.current.filter((c) => c.id !== id);
    setState(
      items.current.length === 0
        ? { state: "empty" }
        : {
            state: "populated",
            items: items.current,
            nextCursor: cursor.current,
          },
    );
  }, []);
  return {
    state,
    refresh,
    loadMore: () => load(true).catch(() => undefined),
    replace,
    remove,
  };
};

export type ConversationViewState =
  | { readonly state: "loading" }
  | {
      readonly state: "populated";
      readonly conversation: DirectConversation;
      readonly messages: readonly DirectMessage[]; // oldest first
      readonly hasOlder: boolean;
    }
  | { readonly state: "unavailable"; readonly message: string };

export const useConversation = (id: string | null, enabled: boolean) => {
  const author = useAuthors();
  const [state, setState] = useState<ConversationViewState>({
    state: "loading",
  });
  const messages = useRef<DirectMessage[]>([]);
  const oldest = useRef<number | null>(null);
  const epoch = useRef(0);
  const apply = (
    page: DirectMessagePage,
    mode: "reset" | "older" | "newer",
  ) => {
    const incoming = [...page.items].reverse();
    if (mode === "reset") messages.current = incoming;
    else if (mode === "older")
      messages.current = [...incoming, ...messages.current];
    else {
      // Merge by sequence: a known message takes the server's current state
      // (e.g. removed by moderation), unknown ones append in order.
      const bySequence = new Map(incoming.map((m) => [m.sequence, m]));
      messages.current = [
        ...messages.current.map((m) => bySequence.get(m.sequence) ?? m),
        ...incoming.filter(
          (m) => !messages.current.some((k) => k.sequence === m.sequence),
        ),
      ];
    }
    if (mode !== "newer") oldest.current = page.nextBefore;
    setState({
      state: "populated",
      conversation: page.conversation,
      messages: messages.current,
      hasOlder: oldest.current !== null,
    });
  };
  const load = useCallback(async () => {
    if (!id) return;
    const current = ++epoch.current;
    try {
      const page = await authorClient.messages.history(id, { pageSize: 30 });
      if (current !== epoch.current) return;
      apply(page, "reset");
    } catch (error) {
      if (current !== epoch.current) return;
      setState({ state: "unavailable", message: describeFailure(error) });
      throw error;
    }
  }, [id]);
  const poll = useCallback(async () => {
    if (!id) return;
    // The newest window (not only `after` the latest sequence) so removals of
    // already-loaded messages are reflected within one interval.
    const page = await authorClient.messages.history(id, { pageSize: 30 });
    apply(page, "newer");
  }, [id]);
  useEffect(() => {
    if (!enabled || !id || !author.viewer) return;
    messages.current = [];
    oldest.current = null;
    setState({ state: "loading" });
    void load().catch(() => undefined);
  }, [enabled, id, author.viewer?.id, load]);
  useForegroundPoll(poll, enabled && id !== null && author.viewer !== null);
  // Mark the latest visible message as observed whenever the view shows it.
  const marked = useRef<number>(0);
  useEffect(() => {
    if (state.state !== "populated" || !id) return;
    const latest = state.messages[state.messages.length - 1]?.sequence ?? 0;
    if (latest <= marked.current || latest <= state.conversation.readSequence)
      return;
    marked.current = latest;
    void authorClient.messages
      .read(id, latest, requestIdentity())
      .then((conversation) =>
        setState((old) =>
          old.state === "populated" ? { ...old, conversation } : old,
        ),
      )
      .catch(() => undefined);
  }, [id, state]);
  const loadOlder = useCallback(async () => {
    if (!id || oldest.current === null) return;
    const page = await authorClient.messages.history(id, {
      before: oldest.current,
      pageSize: 30,
    });
    apply(page, "older");
  }, [id]);
  const send = useCallback(
    async (
      text: string,
    ): Promise<{ ok: true } | { ok: false; message: string }> => {
      if (!id) return { ok: false, message: "对话不可用" };
      try {
        await authorClient.messages.send({
          requestId: requestIdentity(),
          conversationId: id,
          text,
        });
        await poll();
        return { ok: true };
      } catch (error) {
        // Refresh the truthful state (e.g. the gate) but keep the draft and
        // the conversation: a refresh that also fails (for example while
        // offline) changes nothing, so the composer and its text stay.
        await poll().catch(() => undefined);
        return { ok: false, message: describeFailure(error) };
      }
    },
    [id, poll],
  );
  return {
    state,
    refresh: () => load().catch(() => undefined),
    loadOlder,
    send,
  };
};

/**
 * The DM badge unit: unread (unhidden) conversations for the signed-in
 * account, polled in the foreground. Hosted once by `DirectMessageEntryProvider`;
 * consumers read `useUnreadConversationCount()`.
 */
export const usePolledUnreadConversationCount = (): number => {
  const author = useAuthors();
  const [count, setCount] = useState(0);
  const tick = useCallback(async () => {
    if (!author.viewer) {
      setCount(0);
      return;
    }
    const result = await authorClient.messages.unread();
    setCount(result.unreadConversations);
  }, [author.viewer?.id]);
  useEffect(() => {
    void tick().catch(() => setCount(0));
  }, [tick, author.revision]);
  useForegroundPoll(tick, author.viewer !== null);
  return count;
};

export const startConversationWith = async (
  recipientId: string,
  text: string,
): Promise<
  { ok: true; conversationId: string } | { ok: false; message: string }
> => {
  try {
    const message = await authorClient.messages.send({
      requestId: requestIdentity(),
      recipientId,
      text,
    });
    return { ok: true, conversationId: message.conversationId };
  } catch (error) {
    return { ok: false, message: describeFailure(error) };
  }
};

export const findConversationWith = (userId: string) =>
  authorClient.messages.with(userId).then((r) => r.conversation);

export { describeFailure as describeDirectMessageFailure };
