"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AuthorProfile } from "@moya/contracts";
import { authorClient, AuthorRequestError } from "./author-data";
import { requestIdentity } from "../shell/request-identity";

const PREFIX = "yoyi-avatar-save-v1:";
type PendingAvatar = {
  accountId: string;
  uploadId: string;
  saveId: string;
  png: string;
  mediaId?: string;
  rejection?: string;
};
export type AvatarSaveState = {
  accountId: string;
  message: string;
  failed: boolean;
};
const CONFLICT = "头像未更换：保存状态冲突，请重新选择照片。";
// Releases before profile-media-renditions-v1 stored a daily-limit or New York
// date note as the rejection. That limit is gone: show the current 409 copy.
const LEGACY_LIMIT = "今天已更换过头像";
const key = (account: string) => `${PREFIX}${account}`;
const read = (account: string): PendingAvatar | null => {
  const raw = window.localStorage.getItem(key(account));
  if (!raw) return null;
  const value: unknown = JSON.parse(raw);
  if (
    !value ||
    typeof value !== "object" ||
    !("accountId" in value) ||
    value.accountId !== account ||
    !("png" in value) ||
    typeof value.png !== "string" ||
    !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/u.test(value.png) ||
    value.png.length > 5600000 ||
    !("saveId" in value) ||
    typeof value.saveId !== "string" ||
    !("uploadId" in value) ||
    typeof value.uploadId !== "string" ||
    ("mediaId" in value && typeof value.mediaId !== "string") ||
    ("rejection" in value && typeof value.rejection !== "string")
  )
    throw Error("本机头像保存记录无法读取");
  const job = value as PendingAvatar;
  return job.rejection?.includes(LEGACY_LIMIT)
    ? { ...job, rejection: CONFLICT }
    : job;
};
/**
 * account-deletion-v1: an ended account's pending avatar can never be saved.
 * Its intent (the image itself) is removed from this browser; a request still
 * in flight finds the record gone and never writes it back.
 */
export const discardAvatarSave = (account: string): void =>
  window.localStorage.removeItem(key(account));
const pngBlob = (png: string) => {
  const bytes = atob(png.slice("data:image/png;base64,".length));
  return new Blob([Uint8Array.from(bytes, (c) => c.charCodeAt(0))], {
    type: "image/png",
  });
};

/** One avatar intent per account. No credentials; the Backend still owns identity,
 * media and idempotency. Persistence precedes the first asynchronous operation. */
export const useAvatarSave = (options: {
  accountId: string | null;
  checking: boolean;
  sessionError: boolean;
  /**
   * account-deletion-v1: the Session is held (AuthorProvider.holdSession). No
   * save starts and one under way stops before its next request, which a
   * deletion committed meanwhile would answer with a refused Session (and the
   * relay with a cleared cookie). It resumes once released.
   */
  held: boolean;
  refresh: () => Promise<void>;
  onSaved: (profile: AuthorProfile, selectedAvatarIsCurrent: boolean) => void;
}) => {
  const latest = useRef(options);
  latest.current = options;
  const mounted = useRef(false),
    running = useRef(false),
    attempts = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<AvatarSaveState | null>(null);
  const wake = useCallback(() => setTick((n) => n + 1), []);
  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    const delay = Math.min(30000, 2000 * 2 ** Math.min(attempts.current++, 4));
    timer.current = setTimeout(() => {
      timer.current = null;
      if (mounted.current) void latest.current.refresh().finally(wake);
    }, delay);
  }, [wake]);
  useEffect(() => {
    mounted.current = true;
    const online = () => void latest.current.refresh().finally(wake);
    const storage = (event: StorageEvent) => {
      if (event.key === null || event.key.startsWith(PREFIX)) wake();
    };
    window.addEventListener("online", online);
    window.addEventListener("focus", wake);
    window.addEventListener("storage", storage);
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
      window.removeEventListener("online", online);
      window.removeEventListener("focus", wake);
      window.removeEventListener("storage", storage);
    };
  }, [wake]);

  useEffect(() => {
    const account = options.accountId;
    if (!account) {
      setState(null);
      if (timer.current) clearTimeout(timer.current);
      // An offline reload has no confirmed viewer yet. Retry only if this
      // browser contains an avatar intent; never infer its account as the viewer.
      if (options.sessionError && !options.checking) {
        try {
          if (
            Object.keys(window.localStorage).some((name) =>
              name.startsWith(PREFIX),
            )
          )
            schedule();
        } catch {
          /* Storage failure is reported when the owner can be confirmed. */
        }
      }
      return;
    }
    let job: PendingAvatar | null;
    try {
      job = read(account);
    } catch {
      setState({
        accountId: account,
        failed: true,
        message: "无法读取本机头像保存记录，请检查浏览器存储设置。",
      });
      return;
    }
    if (!job) {
      if (timer.current) clearTimeout(timer.current);
      setState(null);
      return;
    }
    const pending = job;
    setState({
      accountId: account,
      failed: Boolean(job.rejection),
      message: job.rejection ?? "正在保存头像，返回或刷新后会继续。",
    });
    if (job.rejection || running.current) return;
    if (options.checking || options.held) return;
    if (options.sessionError || authorClient.account() !== account) {
      schedule();
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    running.current = true;
    const current = () =>
      mounted.current &&
      latest.current.accountId === account &&
      authorClient.account() === account;
    const guard = () => {
      if (!current() || latest.current.held)
        throw new AuthorRequestError(401, "等待原账户确认");
      if (read(account)?.saveId !== pending.saveId)
        throw Error("头像保存状态已更新");
    };
    void (async () => {
      try {
        guard();
        if (!pending.mediaId) {
          const media = await authorClient.upload(
            pngBlob(pending.png),
            pending.uploadId,
          );
          guard();
          pending.mediaId = media.id;
          window.localStorage.setItem(key(account), JSON.stringify(pending));
        }
        guard();
        await authorClient.avatar({
          requestId: pending.saveId,
          mediaId: pending.mediaId,
        });
        guard();
        const profile = await authorClient.profile(account);
        guard();
        window.localStorage.removeItem(key(account));
        attempts.current = 0;
        setState(null);
        latest.current.onSaved(profile, profile.avatar?.id === pending.mediaId);
      } catch (error) {
        if (!mounted.current || latest.current.accountId !== account) return;
        let stored: PendingAvatar | null;
        try {
          stored = read(account);
        } catch {
          stored = null;
        }
        if (!stored || stored.saveId !== pending.saveId) return;
        let rejection: string | undefined;
        if (
          error instanceof AuthorRequestError &&
          [403, 409, 413, 422].includes(error.status)
        ) {
          rejection =
            error.status === 409
              ? CONFLICT
              : "头像未更换：服务器未接受图像，请重新选择照片。";
        }
        // The request can outlive this owner, the confirmed account or a
        // replacement intent submitted by another tab. Never restore the stale record.
        if (!mounted.current || latest.current.accountId !== account) return;
        try {
          stored = read(account);
        } catch {
          return;
        }
        if (
          !stored ||
          stored.saveId !== pending.saveId ||
          (rejection && !current())
        )
          return;
        if (rejection) {
          try {
            window.localStorage.setItem(
              key(account),
              JSON.stringify({ ...stored, rejection }),
            );
          } catch {
            /* Keep original intent. */
          }
        }
        setState({
          accountId: account,
          failed: Boolean(rejection),
          message:
            rejection ?? "头像保存等待网络恢复，返回或刷新后会自动继续。",
        });
        if (!rejection) schedule();
      } finally {
        running.current = false;
        // Identity may have changed while the old request was awaiting a response.
        if (mounted.current) {
          try {
            if (
              latest.current.accountId !== account ||
              read(account)?.saveId !== pending.saveId
            )
              wake();
            else if (authorClient.account() !== account) schedule();
          } catch {
            /* Storage failure was already reported. */
          }
        }
      }
    })();
  }, [
    options.accountId,
    options.checking,
    options.sessionError,
    options.held,
    tick,
    wake,
    schedule,
  ]);

  const save = (png: string) => {
    const account = latest.current.accountId;
    if (
      !account ||
      latest.current.checking ||
      latest.current.sessionError ||
      authorClient.account() !== account
    )
      throw Error("正在确认账户，请稍后保存");
    try {
      const existing = read(account);
      if (existing && !existing.rejection)
        throw Error("已有头像正在保存，请等待完成");
      const job: PendingAvatar = {
        accountId: account,
        png,
        uploadId: requestIdentity(),
        saveId: requestIdentity(),
      };
      window.localStorage.setItem(key(account), JSON.stringify(job));
    } catch (error) {
      if (error instanceof Error && error.message.includes("正在保存"))
        throw error;
      throw Error(
        "本机存储不可用，尚未开始保存。请释放浏览器存储空间后重试。",
        { cause: error },
      );
    }
    attempts.current = 0;
    setState({
      accountId: account,
      failed: false,
      message: "正在保存头像，返回或刷新后会继续。",
    });
    wake();
  };
  const retry = () => {
    const account = latest.current.accountId;
    if (!account || latest.current.checking || latest.current.sessionError)
      return;
    try {
      const job = read(account);
      if (!job) return;
      const { rejection: _, ...pending } = job;
      void _;
      window.localStorage.setItem(key(account), JSON.stringify(pending));
      attempts.current = 0;
      wake();
    } catch {
      /* Keep the visible storage failure and pending intent. */
    }
  };
  return {
    state: state?.accountId === options.accountId ? state : null,
    save,
    retry,
  };
};
