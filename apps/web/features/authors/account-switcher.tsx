"use client";

import { useEffect, useRef, useState } from "react";

import type { PublicUserProfile } from "@moya/contracts";

import { useAuthEntry, useAuthReturn } from "../auth/auth-return";
import { useGlobalUploadProgress } from "../publishing/publishing-provider";
import { ConfirmPanel } from "../publishing/ui/drafts/drafts-shared";
import { SettingsIcon } from "../settings/settings-icons";
import settings from "../settings/settings-view.module.css";
import {
  communityAccountLimit,
  communityAccountsClient,
  reportEvidenceUploadsInFlight,
} from "./account-data";
import type {
  CommunityAccountHeld,
  CommunityAccountsView,
} from "./account-data";
import { useAuthors } from "./author-context";
import {
  announceCommunitySessionChange,
  carrySessionNotice,
} from "./session-change";
import { UserIdentity } from "./user-identity";

import styles from "./account-switcher.module.css";

/**
 * account-switching-v1: 设置 → 切换账号. Lists the current account and the
 * others this browser holds (at most three in all), switches between them,
 * adds one through the sign-in flow's add-account mode, and signs one or all
 * of them out. Sessions never reach this page: it only names accounts. A
 * switch or a sign-out of every account ends in a full reload, so nothing a
 * page kept in memory survives into another account.
 */

/** Another held account as this page shows it. */
interface AccountRow {
  readonly id: string;
  readonly handle: string;
  /** Unknown for an account that was already refused when it was read. */
  readonly displayName: string | null;
  readonly studioName?: string | undefined;
  /**
   * `reauth_required`: still held, but its session is no longer accepted;
   * signing in again replaces it, and 移除 lets it go.
   */
  readonly state: "ready" | "reauth_required";
}

interface Accounts {
  readonly current: PublicUserProfile | null;
  readonly others: readonly AccountRow[];
}

type Confirmation =
  | {
      readonly kind: "switch";
      readonly account: AccountRow;
      readonly work: readonly string[];
    }
  | {
      readonly kind: "add";
      readonly opener: HTMLElement | null;
      readonly work: readonly string[];
    }
  | { readonly kind: "remove"; readonly account: AccountRow }
  | { readonly kind: "sign-out-all"; readonly work: readonly string[] };

const nameOf = (account: { displayName: string | null; handle: string }) =>
  account.displayName ?? `@${account.handle}`;

/** A read lists everything this browser holds, 需重新登录 accounts included. */
const accountsOf = (view: CommunityAccountsView): Accounts => ({
  current: view.current,
  others: view.others,
});

/**
 * What a partial 退出所有账号 left, from its own answer: the current account
 * unless it was cleared, and the accounts still held, as this page showed
 * them. A kept current session's own saved copy is no other account.
 */
const remainingAfterSignOut = (
  shown: Accounts | null,
  currentCleared: boolean,
  remaining: readonly CommunityAccountHeld[],
): Accounts => {
  const current = currentCleared ? null : (shown?.current ?? null);
  return {
    current,
    others: remaining
      .filter((account) => account.id !== current?.id)
      .map(
        (account): AccountRow =>
          shown?.others.find((other) => other.id === account.id) ??
          (shown?.current?.id === account.id
            ? { ...shown.current, state: "ready" }
            : { ...account, displayName: null, state: "ready" }),
      ),
  };
};

const withStudio = (account: AccountRow) =>
  account.studioName === undefined ? {} : { studioName: account.studioName };

export const AccountSwitcher = ({
  viewerId,
  initialView,
  unsavedSettings,
  onBusyChange,
  onSessionChange,
}: {
  /** The account this page shows; null when signed out. */
  readonly viewerId: string | null;
  /** A read the settings page already made, so its reports are not lost. */
  readonly initialView?: CommunityAccountsView | null | undefined;
  /** What the settings dialog itself would lose by leaving, or null. */
  readonly unsavedSettings: string | null;
  readonly onBusyChange: (busy: boolean) => void;
  /** The session changed: close the dialog and reload the page. */
  readonly onSessionChange: () => void;
}) => {
  const author = useAuthors();
  const authReturn = useAuthReturn();
  const enterAuth = useAuthEntry();
  const progress = useGlobalUploadProgress();
  const [accounts, setAccounts] = useState<Accounts | null>(() =>
    initialView ? accountsOf(initialView) : null,
  );
  const [loading, setLoading] = useState(!initialView);
  const [unavailable, setUnavailable] = useState(false);
  const [confirming, setConfirming] = useState<Confirmation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const busyRef = useRef(false);
  // Set once the session changed: everything stays disabled until the reload.
  const departed = useRef(false);
  const mounted = useRef(true);
  const reads = useRef(0);
  const latest = useRef({
    progress,
    avatarSave: author.avatarSave,
    unsavedSettings,
    onBusyChange,
    onSessionChange,
  });
  latest.current = {
    progress,
    avatarSave: author.avatarSave,
    unsavedSettings,
    onBusyChange,
    onSessionChange,
  };

  const load = async (signal?: AbortSignal) => {
    const run = ++reads.current;
    setLoading(true);
    try {
      const result = await communityAccountsClient.list(signal);
      if (!mounted.current || run !== reads.current) return;
      if (result.state === "ready") {
        setAccounts(accountsOf(result.view));
        setUnavailable(false);
      } else setUnavailable(true);
    } catch {
      // Aborted: this page closed.
    } finally {
      if (mounted.current && run === reads.current) setLoading(false);
    }
  };

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    if (!initialView) void load(controller.signal);
    return () => {
      mounted.current = false;
      reads.current++;
      controller.abort();
    };
  }, []);

  const begin = () => {
    if (busyRef.current || departed.current) return false;
    busyRef.current = true;
    setBusy(true);
    latest.current.onBusyChange(true);
    setError("");
    setNotice("");
    return true;
  };
  const end = () => {
    if (departed.current || !mounted.current) return;
    busyRef.current = false;
    setBusy(false);
    latest.current.onBusyChange(false);
  };
  const depart = () => {
    departed.current = true;
    announceCommunitySessionChange();
    // The cookies already changed: a page that closed meanwhile still reloads.
    if (!mounted.current) {
      window.location.assign("/");
      return;
    }
    // The dialog may only close once nothing here is busy; the local busy
    // state stays on so no control works while the page reloads.
    latest.current.onBusyChange(false);
    latest.current.onSessionChange();
  };

  /**
   * The current session ended while other accounts are still held: reload as
   * signed out like a full sign-out, never as a plain success. The next page
   * load says which accounts are left and where to sign them out.
   */
  const departSignedOut = (held: readonly CommunityAccountHeld[]) => {
    if (held.length > 0) {
      const names = held
        .map((account) => {
          const shown = accounts?.others.find(
            (other) => other.id === account.id,
          );
          return `「${shown === undefined ? `@${account.handle}` : nameOf(shown)}」`;
        })
        .join("、");
      carrySessionNotice(
        `已退出当前账号；另有 ${held.length} 个账号未能确认退出：${names}。请到 设置 → 切换账号 再次退出。`,
      );
    }
    depart();
  };

  /** What switching away would interrupt or lose in this account. */
  const unfinishedWork = (): string[] => {
    const {
      progress: work,
      avatarSave,
      unsavedSettings: dirty,
    } = latest.current;
    return [
      ...(work.active
        ? ["作品还有未完成的上传或发布"]
        : work.hasUnsavedChanges
          ? ["作品还有未保存的编辑"]
          : []),
      ...(avatarSave !== null && !avatarSave.failed ? ["头像仍在保存"] : []),
      ...(reportEvidenceUploadsInFlight() > 0 ? ["举报附件仍在上传"] : []),
      ...(dirty === null ? [] : [dirty]),
    ];
  };

  /** Lets an open editor keep its local recovery before the page reloads. */
  const prepared = async () => {
    if (authReturn === null || (await authReturn.prepare())) return true;
    setError("本机恢复未能保存，请先保存草稿再继续。");
    return false;
  };

  const switchTo = async (account: AccountRow, confirmed = false) => {
    if (busyRef.current || departed.current) return;
    if (!confirmed) {
      const work = unfinishedWork();
      if (work.length > 0) {
        setConfirming({ kind: "switch", account, work });
        return;
      }
    }
    if (!begin()) return;
    try {
      if (!(await prepared())) {
        setConfirming(null);
        return;
      }
      const result = await communityAccountsClient.switchTo(account.id);
      if (result.state === "switched") {
        depart();
        return;
      }
      if (!mounted.current) return;
      setConfirming(null);
      if (result.state === "refused" && result.reason === "reauth_required") {
        setAccounts(
          (shown) =>
            shown && {
              ...shown,
              others: shown.others.map((other) =>
                other.id === account.id
                  ? { ...other, state: "reauth_required" }
                  : other,
              ),
            },
        );
        setError(`「${nameOf(account)}」的登录已失效，需要重新登录。`);
      } else if (
        result.state === "refused" &&
        result.reason === "account_not_found"
      ) {
        setError("这个账户已不在这台设备上。");
        void load();
      } else setError("暂时无法切换账户，请检查网络后重试。");
    } finally {
      end();
    }
  };

  const remove = async (account: AccountRow) => {
    if (!begin()) return;
    try {
      const result = await communityAccountsClient.remove(account.id);
      if (!mounted.current) return;
      setConfirming(null);
      if (
        result.state === "removed" ||
        (result.state === "refused" && result.reason === "account_not_found")
      ) {
        setAccounts(
          (shown) =>
            shown && {
              ...shown,
              others: shown.others.filter((other) => other.id !== account.id),
            },
        );
        setNotice(`已移除「${nameOf(account)}」`);
        if (result.state !== "removed") void load();
      } else setError("暂时无法移除这个账户，请稍后重试。");
    } finally {
      end();
    }
  };

  const signOutAll = async () => {
    if (!begin()) return;
    try {
      if (!(await prepared())) {
        setConfirming(null);
        return;
      }
      const result = await communityAccountsClient.signOutAll();
      if (result.state === "signed-out") {
        depart();
        return;
      }
      // Accounts whose sign-out was confirmed are already gone. The answer
      // says whether that includes the current one: then this page reloads as
      // signed out like a full sign-out, and the next page names the rest.
      if (result.state === "partial") {
        if (result.currentCleared && viewerId !== null) {
          departSignedOut(result.remaining);
          return;
        }
        if (!mounted.current) return;
        setConfirming(null);
        announceCommunitySessionChange();
        setError("部分账户未能确认退出，请重试。");
        setAccounts((shown) =>
          remainingAfterSignOut(shown, result.currentCleared, result.remaining),
        );
        // This page showed no current account, yet this browser still has
        // one: follow it.
        if (!result.currentCleared && viewerId === null) {
          void author.refresh();
          void load();
        }
        return;
      }
      // No usable answer: only a read can tell what is still held.
      const after = await communityAccountsClient.list();
      if (
        after.state === "ready" &&
        after.view.current === null &&
        viewerId !== null
      ) {
        // Every account still held, 需重新登录 ones included, is one whose
        // sign-out was not confirmed.
        departSignedOut(after.view.others);
        return;
      }
      if (!mounted.current) return;
      setConfirming(null);
      announceCommunitySessionChange();
      setError(
        result.state === "failed"
          ? "退出未能确认，请检查网络后重试。"
          : "退出未能确认，请重试。",
      );
      if (after.state === "ready") setAccounts(accountsOf(after.view));
    } finally {
      end();
    }
  };

  const add = (opener: HTMLElement | null, confirmed = false) => {
    if (busyRef.current || departed.current) return;
    if (!confirmed) {
      const work = unfinishedWork();
      if (work.length > 0) {
        setConfirming({ kind: "add", opener, work });
        return;
      }
    }
    setConfirming(null);
    // The auth entry keeps the editor's recovery and this page's place; after
    // signing in, the flow returns here with the new account current.
    const [path = "/login", query = ""] = author.signInHref.split("?");
    const parameters = new URLSearchParams(query);
    parameters.set("intent", "add-account");
    enterAuth(`${path}?${parameters}`, opener);
  };

  const held =
    accounts === null
      ? 0
      : (accounts.current === null ? 0 : 1) +
        accounts.others.filter((other) => other.state === "ready").length;
  const full = held >= communityAccountLimit;
  const stale =
    accounts !== null && (accounts.current?.id ?? null) !== viewerId;
  // A read in flight may still rewrite what this browser holds.
  const disabled = busy || loading || confirming !== null;
  const workText = (work: readonly string[], leaving: string) =>
    `${work.join("；")}。${leaving}：未保存的更改会丢失，上传会暂停，回到这个账户后可继续或从本机恢复。`;

  const confirmation = (kind: Confirmation["kind"], accountId?: string) => {
    if (
      confirming === null ||
      confirming.kind !== kind ||
      ("account" in confirming && confirming.account.id !== accountId)
    )
      return null;
    switch (confirming.kind) {
      case "switch":
        return (
          <ConfirmPanel
            title="还有未完成的内容"
            description={workText(confirming.work, "切换会重新载入页面")}
            confirmLabel="仍然切换"
            busyLabel="正在切换"
            busy={busy}
            onCancel={() => setConfirming(null)}
            onConfirm={() => void switchTo(confirming.account, true)}
          />
        );
      case "add":
        return (
          <ConfirmPanel
            title="还有未完成的内容"
            description={workText(confirming.work, "添加账号会先离开这个页面")}
            confirmLabel="仍然添加"
            busyLabel="正在前往"
            busy={busy}
            onCancel={() => setConfirming(null)}
            onConfirm={() => add(confirming.opener, true)}
          />
        );
      case "remove":
        return (
          <ConfirmPanel
            title={`移除「${nameOf(confirming.account)}」？`}
            description="这个账户会在这台设备上退出登录，其他设备不受影响。"
            confirmLabel="移除"
            busyLabel="正在移除"
            busy={busy}
            onCancel={() => setConfirming(null)}
            onConfirm={() => void remove(confirming.account)}
          />
        );
      case "sign-out-all":
        return (
          <ConfirmPanel
            title="退出所有账号？"
            description={`${
              confirming.work.length > 0
                ? `${confirming.work.join("；")}，未保存的更改会丢失。`
                : ""
            }这台设备上的所有账户都会退出登录，其他设备不受影响。`}
            confirmLabel="退出所有账号"
            busyLabel="正在退出"
            busy={busy}
            onCancel={() => setConfirming(null)}
            onConfirm={() => void signOutAll()}
          />
        );
    }
  };

  if (accounts === null)
    return (
      <div className={styles.panel} aria-busy={loading || undefined}>
        {unavailable && !loading ? (
          <div>
            <p className={settings.error} role="alert">
              暂时无法读取这台设备上的账户。
            </p>
            <button
              type="button"
              className={settings.action}
              onClick={() => void load()}
            >
              重试
            </button>
          </div>
        ) : (
          <p className={settings.status} role="status">
            正在读取账户…
          </p>
        )}
      </div>
    );

  return (
    <div className={styles.panel} data-account-switcher="">
      <section className={settings.group}>
        <h3>当前账户</h3>
        <div className={settings.rows}>
          {accounts.current === null ? (
            <div className={settings.row}>
              <span className={settings.rowText}>
                <span>未登录</span>
                <small>选择下面的账户切换，或添加账号。</small>
              </span>
            </div>
          ) : (
            <div className={settings.row} data-account-current="">
              <span className={settings.rowText}>
                <UserIdentity
                  name={accounts.current.displayName}
                  studioName={accounts.current.studioName}
                />
                <small>@{accounts.current.handle}</small>
              </span>
              <span className={styles.badge}>当前</span>
            </div>
          )}
        </div>
        {stale && (
          <p className={settings.status} role="status">
            当前账户已变化，刷新页面后显示最新状态。
          </p>
        )}
      </section>
      <section className={settings.group}>
        <h3>其他账户</h3>
        {accounts.others.length > 0 ? (
          <div className={settings.rows}>
            {accounts.others.map((account) => (
              <div
                className={`${settings.row} ${styles.row}`}
                key={account.id}
                data-account-row={account.id}
                data-account-state={account.state}
              >
                <span className={settings.rowText}>
                  {account.displayName === null ? (
                    <span>@{account.handle}</span>
                  ) : (
                    <UserIdentity
                      name={account.displayName}
                      {...withStudio(account)}
                    />
                  )}
                  <small>
                    @{account.handle}
                    {account.state === "reauth_required" && (
                      <span className={styles.reauth}> · 需重新登录</span>
                    )}
                  </small>
                </span>
                <span className={styles.actions}>
                  {account.state === "ready" ? (
                    <button
                      type="button"
                      className={settings.action}
                      disabled={disabled}
                      aria-label={`切换到「${nameOf(account)}」`}
                      onClick={() => void switchTo(account)}
                    >
                      切换
                    </button>
                  ) : (
                    <button
                      type="button"
                      className={settings.action}
                      disabled={disabled || full}
                      aria-label={`重新登录「${nameOf(account)}」`}
                      onClick={(event) => add(event.currentTarget)}
                    >
                      重新登录
                    </button>
                  )}
                  <button
                    type="button"
                    className={settings.action}
                    disabled={disabled}
                    aria-label={`移除「${nameOf(account)}」`}
                    onClick={() => setConfirming({ kind: "remove", account })}
                  >
                    移除
                  </button>
                </span>
                {confirmation("switch", account.id)}
                {confirmation("remove", account.id)}
              </div>
            ))}
          </div>
        ) : (
          <p className={settings.status}>还没有添加其他账户。</p>
        )}
        {accounts.others.some((other) => other.state === "reauth_required") && (
          <p className={settings.help}>
            登录已过期或失效的账户需要重新登录后才能切换，不再使用时可以移除。
          </p>
        )}
      </section>
      <section className={settings.group}>
        <div className={settings.rows}>
          <button
            type="button"
            className={settings.row}
            disabled={disabled || full}
            data-settings-focus-key="account-add"
            onClick={(event) => add(event.currentTarget)}
          >
            <span className={settings.rowIcon}>
              <SettingsIcon name="user-round-plus" />
            </span>
            <span className={settings.rowText}>
              <span>添加账号</span>
              <small>
                {full
                  ? `这台设备最多同时登录 ${communityAccountLimit} 个账户，请先移除一个账户。`
                  : "登录另一个账户，之后可在这里切换。"}
              </small>
            </span>
            <SettingsIcon className={settings.chevron} name="chevron-right" />
          </button>
        </div>
        {confirmation("add")}
        <p className={settings.help}>
          最多同时登录 {communityAccountLimit}{" "}
          个账户（含当前账户）。账户只保存在这台设备的浏览器中，其他设备不受影响。
        </p>
      </section>
      {error && (
        <p className={settings.error} role="alert">
          {error}
        </p>
      )}
      <p className={settings.status} role="status">
        {notice || (loading ? "正在更新账户…" : "")}
      </p>
      {held > 0 && (
        <>
          <button
            type="button"
            className={styles.signOutAll}
            disabled={disabled}
            onClick={() =>
              setConfirming({ kind: "sign-out-all", work: unfinishedWork() })
            }
          >
            <SettingsIcon name="log-out" />
            {busy && confirming?.kind === "sign-out-all"
              ? "正在退出"
              : "退出所有账号"}
          </button>
          {confirmation("sign-out-all")}
        </>
      )}
    </div>
  );
};
