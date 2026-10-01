"use client";

import { useAuthReturn } from "../auth/auth-return";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import type { ContentIdentity } from "@moya/contracts";
import { authorClient, AuthorRequestError } from "./author-data";
import {
  acknowledgeGuestBatch,
  contentKey,
  pendingGuestBatch,
  hasOtherGuestBatch,
  readGuestFavorites,
  setGuestFavorite,
} from "./local-library";
import { requestIdentity } from "../shell/request-identity";
import { useAvatarSave } from "./avatar-save";
import type { AvatarSaveState } from "./avatar-save";

type Viewer = Awaited<ReturnType<typeof authorClient.me>>;
interface Context {
  cache: Map<string, unknown>;
  avatarSrc: string | null;
  avatarSave: AvatarSaveState | null;
  saveAvatar: (png: string) => void;
  viewer: Viewer | null;
  checking: boolean;
  sessionError: boolean;
  revision: number;
  notice: string;
  signInHref: string;
  refresh: () => Promise<void>;
  notify: (text: string) => void;
  mutate: () => void;
  favorite: (target: ContentIdentity, enabled: boolean) => Promise<boolean>;
  like: (target: ContentIdentity, enabled: boolean) => Promise<boolean>;
  guestFavorites: readonly ContentIdentity[];
}
const AuthorContext = createContext<Context | null>(null);
/** Public/QA presentation can read identity readiness without owning a provider. */
export const useOptionalAuthors = () => useContext(AuthorContext);
export const useAuthors = () => {
  const value = useOptionalAuthors();
  if (!value) throw Error("Author provider missing");
  return value;
};
export const AuthorProvider = ({
  children,
  signInHref,
}: {
  children: ReactNode;
  signInHref: string;
}) => {
  const authReturn = useAuthReturn();
  const [viewer, setViewer] = useState<Viewer | null>(null),
    [avatarSrc, setAvatarSrc] = useState<string | null>(null),
    [checking, setChecking] = useState(true),
    [sessionError, setSessionError] = useState(false),
    [revision, setRevision] = useState(0),
    [notice, setNotice] = useState(""),
    [guestFavorites, setGuestFavorites] = useState<ContentIdentity[]>([]);
  const cache = useRef(new Map<string, unknown>());
  const accountRef = useRef<string | null>(null),
    epoch = useRef(0),
    mergeWorker = useRef<Promise<void>>(Promise.resolve()),
    confirmed = useRef(false);
  const [undo, setUndo] = useState<{
    target: ContentIdentity;
    account: string | null;
    expires: number;
  } | null>(null);
  const notify = useCallback((text: string) => setNotice(text), []);
  const refreshGuest = () =>
    readGuestFavorites()
      .then(setGuestFavorites)
      .catch(() => setNotice("本机存储不可用"));
  const refresh = useCallback(async () => {
    const run = ++epoch.current;
    confirmed.current = false;
    // Revalidation is not an account switch. Keep the confirmed identity so
    // focus returning from a device picker cannot invalidate in-flight writes.
    // A different /me identity or a failed check still invalidates the client.
    setChecking(true);
    try {
      const next = await authorClient.me();
      if (run !== epoch.current) return;
      if (accountRef.current !== next.id) {
        cache.current.clear();
        setAvatarSrc(null);
        setUndo(null);
        setNotice("");
      }
      authReturn?.identify(next.id);
      accountRef.current = next.id;
      authorClient.setAccount(next.id);
      confirmed.current = true;
      setViewer((old) =>
        old?.id === next.id &&
        old.displayName === next.displayName &&
        old.studioName === next.studioName &&
        old.handle === next.handle
          ? old
          : next,
      );
      setSessionError(false);
      setRevision((v) => v + 1);
      const merge = async () => {
        if (run !== epoch.current || !confirmed.current) return;
        try {
          for (let i = 0; i < 5; i++) {
            if (
              run !== epoch.current ||
              accountRef.current !== next.id ||
              !confirmed.current
            )
              break;
            const batch = await pendingGuestBatch(next.id);
            if (run !== epoch.current) break;
            if (!batch) {
              const waiting = await hasOtherGuestBatch(next.id);
              if (waiting && run === epoch.current)
                setNotice("另一个账户有待确认的本机收藏，请登录原账户继续合并");
              break;
            }
            const result = await authorClient.merge({
              requestId: batch.requestId,
              expectedAccountId: next.id,
              items: batch.entries.map((e) => e.target),
            });
            await acknowledgeGuestBatch(batch, result.acknowledged);
            if (run === epoch.current) {
              await refreshGuest();
              setRevision((v) => v + 1);
              setNotice(
                result.acknowledged.length
                  ? "本机收藏已合并到账户"
                  : "部分本机收藏尚未导入，可重试",
              );
            }
            if (result.acknowledged.length === 0) break;
          }
        } catch {
          if (run === epoch.current) setNotice("本机收藏仍保留，可重试合并");
        }
      };
      mergeWorker.current = mergeWorker.current.then(merge, merge);
    } catch (error) {
      if (run !== epoch.current) return;
      authorClient.setAccount(null);
      if (error instanceof AuthorRequestError && error.status === 401) {
        if (accountRef.current !== null) cache.current.clear();
        accountRef.current = null;
        confirmed.current = true;
        setViewer(null);
        setAvatarSrc(null);
        setSessionError(false);
      } else setSessionError(true);
    } finally {
      if (run === epoch.current) setChecking(false);
    }
  }, [authReturn]);
  const avatarSave = useAvatarSave({
    accountId: viewer?.id ?? null,
    checking,
    sessionError,
    refresh,
    onSaved: (profile, selectedAvatarIsCurrent) => {
      cache.current.set(`profile:${profile.id}`, profile);
      setAvatarSrc(profile.avatar?.src ?? null);
      setRevision((n) => n + 1);
      setNotice(
        selectedAvatarIsCurrent
          ? "头像已更换"
          : "保存已确认，当前头像已在其他页面更新。",
      );
    },
  });
  useEffect(() => {
    void refresh();
    void refreshGuest();
    const update = () => {
      void refresh();
      void refreshGuest();
    };
    window.addEventListener("focus", update);
    window.addEventListener("storage", update);
    return () => {
      epoch.current++;
      authorClient.setAccount(null);
      window.removeEventListener("focus", update);
      window.removeEventListener("storage", update);
    };
  }, [refresh]);
  useEffect(() => {
    if (!viewer || checking || sessionError) return;
    let active = true;
    void authorClient
      .profile(viewer.id)
      .then((profile) => {
        if (active) setAvatarSrc(profile.avatar?.src ?? null);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [viewer?.id, checking, sessionError, revision]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 6000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!undo) return;
    const timer = window.setTimeout(
      () => setUndo(null),
      Math.max(0, undo.expires - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [undo]);
  const mutate = useCallback(() => setRevision((v) => v + 1), []);
  const favorite = async (target: ContentIdentity, enabled: boolean) => {
    if (!confirmed.current || checking || sessionError) {
      notify("正在确认账户，请稍后重试");
      return false;
    }
    const run = epoch.current,
      account = accountRef.current;
    try {
      if (viewer) {
        await authorClient.command("content/favorite", {
          requestId: requestIdentity(),
          target,
          enabled,
        });
      } else {
        setGuestFavorites(await setGuestFavorite(target, enabled));
        notify(enabled ? "已收藏在本机；登录后可合并到账户" : "已取消本机收藏");
      }
      if (run !== epoch.current) return false;
      if (!enabled) setUndo({ target, account, expires: Date.now() + 6000 });
      mutate();
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : "收藏未完成");
      return false;
    }
  };
  const like = async (target: ContentIdentity, enabled: boolean) => {
    if (!viewer || checking || sessionError) {
      notify("登录后可以喜欢内容");
      return false;
    }
    try {
      await authorClient.command("content/like", {
        requestId: requestIdentity(),
        target,
        enabled,
      });
      mutate();
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : "喜欢未完成");
      return false;
    }
  };
  return (
    <AuthorContext.Provider
      value={{
        cache: cache.current,
        avatarSrc,
        avatarSave: avatarSave.state,
        saveAvatar: avatarSave.save,
        viewer,
        checking,
        sessionError,
        revision,
        notice,
        signInHref,
        refresh,
        notify,
        mutate,
        favorite,
        like,
        guestFavorites,
      }}
    >
      {children}
      <div className="phase4-feedback" role="status" aria-live="polite">
        {avatarSave.state?.message ?? notice}
        {avatarSave.state?.failed && (
          <button
            type="button"
            style={{ pointerEvents: "auto" }}
            disabled={checking || sessionError}
            onClick={avatarSave.retry}
          >
            重试保存
          </button>
        )}
        {undo && (
          <button
            type="button"
            style={{ pointerEvents: "auto" }}
            onClick={() => {
              if (undo.account !== accountRef.current) return;
              void favorite(undo.target, true).then((ok) => {
                if (ok) {
                  setUndo(null);
                  notify("已恢复收藏");
                }
              });
            }}
          >
            撤销取消收藏
          </button>
        )}
        {!avatarSave.state && notice.includes("重试") && (
          <button
            type="button"
            style={{ pointerEvents: "auto" }}
            onClick={() => void refresh()}
          >
            重试合并
          </button>
        )}
      </div>
    </AuthorContext.Provider>
  );
};
export const safeContentUrl = (target: ContentIdentity) => {
  const url = new URL("/", window.location.origin);
  url.searchParams.set(
    target.type === "catalog" ? "catalogId" : "workId",
    target.id,
  );
  url.hash = "detail";
  return url.href;
};
export const shareContent = async (
  target: ContentIdentity,
  title: string,
): Promise<"shared" | "copied" | "cancelled"> => {
  const url = safeContentUrl(target);
  if (navigator.share) {
    try {
      await navigator.share({ title, url });
      return "shared";
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError")
        return "cancelled";
    }
  }
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(url);
    return "copied";
  }
  const input = document.createElement("textarea");
  input.value = url;
  input.style.position = "fixed";
  input.style.top = "0";
  input.style.opacity = "0";
  document.body.append(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied) throw Error("无法复制，请使用浏览器分享菜单");
  return "copied";
};
export { contentKey };
