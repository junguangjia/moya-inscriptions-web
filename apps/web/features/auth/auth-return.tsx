"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { requestIdentity } from "../shell/request-identity";
import { safeReturnPath } from "./auth-api";

const historyKey = "__artvennAuthReturn";
type Ticket = { readonly id: string; readonly role: "source" | "auth" };
type Draft = {
  readonly owner: string;
  readonly path: string;
  readonly value: unknown;
};
type Journey = {
  readonly id: string;
  readonly path: string;
  readonly entry: string | null;
  readonly views: Map<string, unknown>;
  readonly drafts: Map<string, Draft>;
  readonly focus: string | null;
  phase: "captured" | "auth" | "restoring";
};
type AuthEntry = (href: string, opener?: HTMLElement | null) => void;

const objectOf = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const ticketOf = (value: unknown): Ticket | null => {
  const ticket = objectOf(objectOf(value)?.[historyKey]);
  return typeof ticket?.id === "string" &&
    (ticket.role === "source" || ticket.role === "auth")
    ? (ticket as Ticket)
    : null;
};
const browserPath = () =>
  `${window.location.pathname}${window.location.search}${window.location.hash}`;
const isAuthPath = (path: string) =>
  ["/login", "/register"].includes(
    new URL(path, "http://auth-return.invalid").pathname,
  );
const entryOf = (value: unknown) => {
  const entry = objectOf(value)?.__artvennEntry;
  return typeof entry === "string" ? entry : null;
};
const withoutTicket = (value: unknown): unknown => {
  const data = objectOf(value);
  if (data === null || !(historyKey in data)) return value;
  const next = { ...data };
  delete next[historyKey];
  return next;
};
const withTicket = (value: unknown, ticket: Ticket) => ({
  ...objectOf(value),
  [historyKey]: ticket,
});

// This is transient presentation state, never a session/proof store. The
// history ticket identifies one journey, without authorizing any API action.
export const createAuthReturnState = () => {
  const captures = new Map<string, () => unknown>();
  const guards = new Set<() => Promise<boolean>>();
  const drafts = new Map<string, Draft>();
  let source: Journey | null = null;
  let stampingSource = false;
  const inputs = {
    email: "",
    phone: "",
    channel: "email" as "email" | "phone",
  };

  const retire = () => {
    source = null;
    drafts.clear();
  };
  const matches = (ticket: Ticket | null, role: Ticket["role"]) =>
    source !== null && ticket?.id === source.id && ticket.role === role;
  const sameEntry = (value: unknown) =>
    source !== null &&
    (source.entry === null ||
      entryOf(value) === null ||
      entryOf(value) === source.entry);
  const authMatches = (path: string) =>
    source !== null &&
    isAuthPath(path) &&
    new URL(path, "http://auth-return.invalid").searchParams.get("return") ===
      source.path;
  const observe = () => {
    if (source === null || typeof window === "undefined") return;
    const path = browserPath();
    const ticket = ticketOf(window.history.state);
    if (source.phase === "captured") {
      if (
        path === source.path &&
        matches(ticket, "source") &&
        sameEntry(window.history.state)
      )
        return;
      if (authMatches(path) && matches(ticket, "auth")) {
        source.phase = "auth";
        return;
      }
    } else if (source.phase === "auth") {
      if (authMatches(path) && matches(ticket, "auth")) return;
      if (
        path === source.path &&
        matches(ticket, "source") &&
        sameEntry(window.history.state)
      ) {
        source.phase = "restoring";
        return;
      }
    } else if (
      path === source.path &&
      matches(ticket, "source") &&
      sameEntry(window.history.state)
    )
      return;
    retire();
  };
  const restoring = () => {
    observe();
    return source?.phase === "restoring";
  };

  return {
    inputs,
    register(slot: string, capture: () => unknown) {
      captures.set(slot, capture);
      return () => {
        if (captures.get(slot) === capture) captures.delete(slot);
      };
    },
    guard(check: () => Promise<boolean>) {
      guards.add(check);
      return () => {
        guards.delete(check);
      };
    },
    async prepare() {
      for (const check of guards) if (!(await check())) return false;
      return true;
    },
    capture(path: string, focus: string | null) {
      const safePath = safeReturnPath(path);
      const views = new Map(
        [...captures].map(([slot, read]) => [slot, read()]),
      );
      const savedDrafts = new Map(
        [...drafts].filter(([, draft]) => draft.path === safePath),
      );
      source = {
        id: requestIdentity(),
        path: safePath,
        focus,
        views,
        drafts: savedDrafts,
        entry:
          typeof window === "undefined" ? null : entryOf(window.history.state),
        phase: "captured",
      };
      if (typeof window !== "undefined" && browserPath() === safePath) {
        stampingSource = true;
        try {
          window.history.replaceState(
            withTicket(window.history.state, { id: source.id, role: "source" }),
            "",
          );
        } finally {
          stampingSource = false;
        }
      }
    },
    // Retire by actual history transition, including query/hash-only changes.
    // Preserve existing Next/ProductShell data; this never pushes, pops or
    // substitutes another navigation owner. Same-route local modal entries may
    // carry the source ticket, while fresh visits to the same URL cannot.
    historyMutation(
      kind: "push" | "replace",
      path: string,
      data: unknown,
    ): unknown {
      if (stampingSource) return data;
      observe();
      if (source === null) return withoutTicket(data);
      const incoming = ticketOf(data);
      if (source.phase === "captured" && authMatches(path)) {
        source.phase = "auth";
        return withTicket(data, { id: source.id, role: "auth" });
      }
      if (source.phase === "auth" && kind === "replace" && authMatches(path))
        return withTicket(data, { id: source.id, role: "auth" });
      if (
        source.phase !== "auth" &&
        path === source.path &&
        (kind === "replace" || matches(incoming, "source")) &&
        sameEntry(data)
      )
        return withTicket(data, { id: source.id, role: "source" });
      retire();
      return withoutTicket(data);
    },
    observe,
    retire,
    hasSource() {
      observe();
      return source?.phase === "auth";
    },
    isRestoring: restoring,
    returnPath(fallback: string) {
      observe();
      return source?.phase === "auth" ? source.path : safeReturnPath(fallback);
    },
    read(slot: string) {
      return restoring() ? source?.views.get(slot) : undefined;
    },
    consumeView(slot: string, saved: unknown) {
      if (!restoring()) return;
      const journey = source;
      if (journey && journey.views.get(slot) === saved)
        journey.views.delete(slot);
    },
    focus() {
      return restoring() ? (source?.focus ?? null) : null;
    },
    remember(owner: string, content: string, value: unknown) {
      if (typeof window === "undefined" || isAuthPath(browserPath())) return;
      drafts.set(content, { owner, path: browserPath(), value });
    },
    take(owner: string, content: string) {
      if (!restoring()) return undefined;
      const saved = source?.drafts.get(content);
      if (!saved || saved.owner !== owner) return undefined;
      source?.drafts.delete(content);
      drafts.delete(content);
      return saved.value;
    },
    identify(owner: string) {
      for (const map of [drafts, source?.drafts])
        if (map)
          for (const [key, draft] of map)
            if (draft.owner !== owner) map.delete(key);
    },
    clearDrafts() {
      drafts.clear();
      source?.drafts.clear();
    },
  };
};

const AuthReturnContext = createContext<ReturnType<
  typeof createAuthReturnState
> | null>(null);
const AuthEntryContext = createContext<AuthEntry | null>(null);

export const AuthReturnProvider = ({
  children,
}: {
  readonly children: ReactNode;
}) => {
  const router = useRouter();
  const pathname = usePathname();
  const [state] = useState(createAuthReturnState);
  const entering = useRef(false);

  useEffect(() => {
    let live = true;
    const previousPush = window.history.pushState;
    const previousReplace = window.history.replaceState;
    const pathOf = (url?: string | URL | null) => {
      const target = new URL(
        url?.toString() ?? window.location.href,
        window.location.href,
      );
      return `${target.pathname}${target.search}${target.hash}`;
    };
    const push: History["pushState"] = function (data, unused, url) {
      previousPush.call(
        window.history,
        live ? state.historyMutation("push", pathOf(url), data) : data,
        unused,
        url,
      );
      if (live) state.observe();
    };
    const replace: History["replaceState"] = function (data, unused, url) {
      previousReplace.call(
        window.history,
        live ? state.historyMutation("replace", pathOf(url), data) : data,
        unused,
        url,
      );
      if (live) state.observe();
    };
    const observe = () => state.observe();
    window.history.pushState = push;
    window.history.replaceState = replace;
    window.addEventListener("popstate", observe, true);
    window.addEventListener("hashchange", observe);
    observe();
    return () => {
      live = false;
      if (window.history.pushState === push)
        window.history.pushState = previousPush;
      if (window.history.replaceState === replace)
        window.history.replaceState = previousReplace;
      window.removeEventListener("popstate", observe, true);
      window.removeEventListener("hashchange", observe);
    };
  }, [state]);

  useEffect(() => {
    state.observe();
    if (isAuthPath(pathname) || !state.isRestoring()) return;
    const restore = () => {
      if (!state.isRestoring()) {
        observer.disconnect();
        return;
      }
      const selector = state.focus();
      const candidates = selector
        ? [...document.querySelectorAll<HTMLElement>(selector)]
        : [];
      candidates.push(
        ...document.querySelectorAll<HTMLElement>(
          "textarea:not([disabled]), [data-home-surface], main h1",
        ),
      );
      const element = candidates.find(
        (node) => node.getClientRects().length > 0,
      );
      if (!element) return;
      element.focus({ preventScroll: true });
      observer.disconnect();
    };
    const observer = new MutationObserver(restore);
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = setTimeout(() => observer.disconnect(), 10_000);
    restore();
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [pathname, state]);

  const enter = useCallback<AuthEntry>(
    (href, opener) => {
      const url = new URL(href, window.location.href);
      if (url.origin !== window.location.origin || !isAuthPath(url.pathname)) {
        window.location.assign(href);
        return;
      }
      if (isAuthPath(window.location.pathname)) {
        const fallback = url.searchParams.get("return") ?? "/";
        url.searchParams.set("return", state.returnPath(fallback));
        router.replace(`${url.pathname}${url.search}`, { scroll: true });
        return;
      }
      if (entering.current) return;
      entering.current = true;
      void (async () => {
        try {
          const before = window.location.href;
          const entry = entryOf(window.history.state);
          if (
            !(await state.prepare()) ||
            (opener && !opener.isConnected) ||
            window.location.href !== before ||
            entryOf(window.history.state) !== entry
          )
            return;
          const path = browserPath();
          const focus = opener?.id ? `#${CSS.escape(opener.id)}` : null;
          state.capture(path, focus);
          url.searchParams.set("return", safeReturnPath(path));
          // Keep Next and ProductShell state; retire only the source dialog's
          // obsolete marker so its cleanup cannot consume the auth entry.
          if (window.history.state?.phase4Dialog) {
            const next = { ...window.history.state };
            delete next.phase4Dialog;
            delete next.phase4DialogDepth;
            window.history.replaceState(next, "");
          }
          router.push(`${url.pathname}${url.search}`, { scroll: true });
        } catch {
          state.retire();
          // The source checkpoint owns its actionable recovery notice.
        } finally {
          entering.current = false;
        }
      })();
    },
    [router, state],
  );

  return (
    <AuthReturnContext.Provider value={state}>
      <AuthEntryContext.Provider value={enter}>
        <div
          data-auth-return-root=""
          style={{ display: "contents" }}
          onClickCapture={(event) => {
            if (
              event.defaultPrevented ||
              event.button !== 0 ||
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey
            )
              return;
            const anchor = (event.target as HTMLElement).closest?.("a[href]");
            if (
              !(anchor instanceof HTMLAnchorElement) ||
              anchor.target ||
              anchor.hasAttribute("download")
            )
              return;
            const url = new URL(anchor.href, window.location.href);
            if (
              url.origin !== window.location.origin ||
              !isAuthPath(url.pathname) ||
              isAuthPath(window.location.pathname)
            )
              return;
            event.preventDefault();
            event.stopPropagation();
            enter(`${url.pathname}${url.search}`, anchor);
          }}
        >
          {children}
        </div>
      </AuthEntryContext.Provider>
    </AuthReturnContext.Provider>
  );
};

export const useAuthReturn = () => useContext(AuthReturnContext);

export const useAuthEntry = (): AuthEntry => {
  const enter = useContext(AuthEntryContext);
  return useCallback(
    (href, opener) => {
      if (enter) enter(href, opener);
      else window.location.assign(href);
    },
    [enter],
  );
};

/** Each source owns its snapshot shape and validates it before restoration. */
export function useAuthReturnView<T>(
  slot: string,
  capture: () => T,
): T | undefined {
  const state = useAuthReturn();
  const latest = useRef(capture);
  latest.current = capture;
  const [saved] = useState(() => state?.read(slot) as T | undefined);
  // Public presentation snapshots remain available for this returned entry.
  // /me can replace a checking/guest component with an account-keyed one after
  // the first commit. The exact journey ticket and entry retirement, rather
  // than an early component effect, bound restoration. Private drafts still
  // require a confirmed owner and are taken only once.
  useEffect(() => state?.register(slot, () => latest.current()), [slot, state]);
  return saved;
}

export const useBeforeAuth = (check: () => Promise<boolean>) => {
  const state = useAuthReturn();
  const latest = useRef(check);
  latest.current = check;
  useEffect(() => state?.guard(() => latest.current()), [state]);
};
