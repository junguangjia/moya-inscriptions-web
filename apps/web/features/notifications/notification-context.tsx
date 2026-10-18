"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import type { NotificationPage } from "@moya/contracts";
import { authorClient } from "../authors/author-data";
import { useAuthors } from "../authors/author-context";

type Filter = "all" | "likes" | "comments" | "mentions";
type Category = Exclude<Filter, "all">;
interface Visit {
  valid: () => boolean;
  run: () => Promise<void>;
  failed: boolean;
}
interface Inbox {
  enabled: boolean;
  page: NotificationPage | null;
  loading: boolean;
  error: string;
  filter: Filter;
  setFilter: (value: Filter) => void;
  refresh: () => Promise<void>;
  revalidate: () => Promise<void>;
  more: () => void;
  read: (observation: string) => Promise<void>;
  visit: (category: Category) => () => void;
}
const Context = createContext<Inbox>({
  enabled: false,
  page: null,
  loading: false,
  error: "",
  filter: "all",
  setFilter: () => {},
  refresh: async () => {},
  revalidate: async () => {},
  more: () => {},
  read: async () => {},
  visit: () => () => {},
});
export const useNotifications = () => useContext(Context);
/** Exactly one subscription above all message surfaces; private state is keyed to the confirmed account. */
export function NotificationProvider({
  enabled,
  children,
}: {
  enabled: boolean;
  children: ReactNode;
}) {
  const author = useAuthors();
  const identity = enabled ? (author.viewer?.id ?? null) : null;
  const account = !author.sessionError ? identity : null;
  return (
    <AccountInbox enabled={enabled} account={account} identity={identity}>
      {children}
    </AccountInbox>
  );
}
function AccountInbox({
  enabled,
  account,
  identity,
  children,
}: {
  enabled: boolean;
  account: string | null;
  identity: string | null;
  children: ReactNode;
}) {
  const [rawPage, setPage] = useState<NotificationPage | null>(null),
    [filter, setFilter] = useState<Filter>("all"),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [readError, setReadError] = useState("");
  const generation = useRef(0),
    pending = useRef<AbortController | null>(null),
    current = useRef(rawPage),
    pageOwner = useRef<string | null>(null),
    activeAccount = useRef(account),
    activeIdentity = useRef(identity),
    accountEpoch = useRef(0),
    activeVisit = useRef<Visit | null>(null);
  if (activeIdentity.current !== identity) accountEpoch.current++;
  activeIdentity.current = identity;
  activeAccount.current = account;
  const page =
    account !== null && pageOwner.current === account ? rawPage : null;
  current.current = page;
  const refresh = useCallback(
    async (cursor?: string, preserveLoaded = false) => {
      if (!account) return;
      pending.current?.abort();
      const abort = new AbortController();
      pending.current = abort;
      const run = ++generation.current;
      const retained =
        !cursor && preserveLoaded ? current.current?.items : undefined;
      const retainedCount = retained?.length ?? 0;
      const retainedTail = retained?.at(-1)?.id;
      setLoading(true);
      setError("");
      await authorClient
        .notifications(filter, cursor, abort.signal)
        .then(async (first) => {
          let result = first;
          // Revalidate loaded pages under one fresh server cursor snapshot.
          // Never append stale private excerpts from the previous snapshot.
          for (
            let pages = 1;
            pages < 10 &&
            result.nextCursor &&
            result.items.length < 200 &&
            (result.items.length < retainedCount ||
              (retainedTail &&
                !result.items.some((item) => item.id === retainedTail)));
            pages++
          ) {
            if (run !== generation.current || abort.signal.aborted) return;
            const next = await authorClient.notifications(
              filter,
              result.nextCursor,
              abort.signal,
            );
            result = {
              ...next,
              items: [...result.items, ...next.items].slice(0, 200),
            };
          }
          if (run !== generation.current || abort.signal.aborted) return;
          pageOwner.current = account;
          setPage((old) =>
            cursor && old
              ? {
                  ...result,
                  items: [...old.items, ...result.items].slice(0, 200),
                }
              : result,
          );
        })
        .catch(() => {
          if (run === generation.current && !abort.signal.aborted) {
            setPage(null);
            setError("消息暂时不可用，请重试");
          }
        })
        .finally(() => {
          if (run === generation.current) setLoading(false);
        });
    },
    [account, filter],
  );
  useEffect(() => {
    setPage(null);
    setReadError("");
    pageOwner.current = null;
    refresh();
    return () => {
      generation.current++;
      pending.current?.abort();
    };
  }, [refresh]);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (!account) return;
    let stream: EventSource | undefined,
      retry: ReturnType<typeof setTimeout> | undefined,
      closed = false,
      delay = 1000;
    const connect = () => {
      if (closed) return;
      stream = new EventSource("/api/community/notifications/stream");
      stream.addEventListener("refresh", () => {
        delay = 1000;
        refreshRef.current(undefined, true);
      });
      stream.onerror = () => {
        stream?.close();
        if (!closed) {
          retry = setTimeout(connect, delay);
          delay = Math.min(delay * 2, 30_000);
        }
      };
    };
    const foreground = () => {
      if (document.visibilityState === "visible")
        refreshRef.current(undefined, true);
    };
    connect();
    document.addEventListener("visibilitychange", foreground);
    return () => {
      closed = true;
      clearTimeout(retry);
      stream?.close();
      document.removeEventListener("visibilitychange", foreground);
    };
  }, [account]);
  // One independent snapshot per visible category entry. Passive refreshes do
  // not replace its token, so arrivals during a visit remain unread. A failed
  // persistence retry uses the same observation, including unloaded pages.
  const visit = useCallback((category: Category) => {
    const owner = activeIdentity.current;
    if (!owner) return () => {};
    const epoch = accountEpoch.current;
    const abort = new AbortController();
    let active = true,
      running = false,
      observation: string | null = null;
    const sameOwner = () =>
      activeIdentity.current === owner && accountEpoch.current === epoch;
    const valid = () => activeAccount.current === owner && sameOwner();
    const entry: Visit = {
      valid,
      failed: activeAccount.current !== owner,
      run: async () => {
        if (running || !valid()) return;
        running = true;
        entry.failed = false;
        setReadError("");
        try {
          observation ??= (
            await authorClient.notifications(category, undefined, abort.signal)
          ).observation;
          if (!valid()) {
            if (sameOwner() && active) {
              entry.failed = true;
              setReadError("已读状态未保存，请刷新后重试");
            }
            return;
          }
          await authorClient.readNotifications(observation);
          if (valid()) await refreshRef.current(undefined, true);
        } catch {
          if (sameOwner() && active) {
            entry.failed = true;
            setReadError("已读状态未保存，请刷新后重试");
          }
        } finally {
          running = false;
        }
      },
    };
    activeVisit.current = entry;
    void entry.run();
    return () => {
      // Leaving the list detaches retry ownership, but its entry snapshot
      // still persists if this is the same account (including a quick Back).
      active = false;
      if (activeVisit.current === entry) activeVisit.current = null;
    };
  }, []);
  const read = async (observation: string) => {
    const epoch = accountEpoch.current;
    try {
      await authorClient.readNotifications(observation);
      if (activeAccount.current === account && accountEpoch.current === epoch) {
        setReadError("");
        await refreshRef.current(undefined, true);
      }
    } catch {
      if (activeAccount.current === account && accountEpoch.current === epoch)
        setReadError("已读状态未保存，请刷新后重试");
    }
  };
  return (
    <Context.Provider
      value={{
        enabled,
        page,
        filter,
        setFilter: (next) => {
          if (next !== filter) {
            setPage(null);
            setFilter(next);
          }
        },
        loading,
        error:
          readError ||
          (activeVisit.current?.valid() && activeVisit.current.failed
            ? "已读状态未保存，请刷新后重试"
            : error),
        revalidate: () => refresh(),
        refresh: () =>
          activeVisit.current?.valid()
            ? activeVisit.current.failed
              ? activeVisit.current.run()
              : current.current
                ? read(current.current.observation)
                : refresh()
            : refresh(),
        more: () => {
          if (
            !loading &&
            current.current?.nextCursor &&
            current.current.items.length < 200
          )
            refresh(current.current.nextCursor);
        },
        read,
        visit,
      }}
    >
      {children}
    </Context.Provider>
  );
}
