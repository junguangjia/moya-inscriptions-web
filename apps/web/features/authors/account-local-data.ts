"use client";
import { discardBrowserEditorRecovery } from "../publishing/editor-recovery";
import { clearBrowserAccountRecovery } from "../publishing/local-recovery";
import { discardAvatarSave } from "./avatar-save";
import { forgetLocalLibraryAccount } from "./local-library";

const ACCOUNT = /^user-[0-9a-f]{32}$/u;
/** The ping other tabs of this browser receive once an account is deleted. */
const DELETED = "yoyi-account-deleted";

/**
 * account-deletion-v1: what this browser keeps for one account outlives a
 * sign-out: a pending avatar, browsing history, editor interruption records,
 * saved-draft media recovery and a guest-favorite merge reserved for it. Once
 * the account is deleted none of it can be used again, so it is removed. Each
 * store is cleared on its own; an unavailable one never keeps the others, and
 * no other account's or the guest's data is touched.
 */
export const clearAccountLocalData = async (accountId: string) => {
  if (!ACCOUNT.test(accountId)) return;
  await Promise.allSettled(
    [
      discardAvatarSave,
      forgetLocalLibraryAccount,
      discardBrowserEditorRecovery,
      clearBrowserAccountRecovery,
    ].map(async (clear) => clear(accountId)),
  );
};

/**
 * Tells this browser's other tabs which account was deleted: its opaque id and
 * the time, never a credential. Each of them ends that account's editing and
 * clears its data too (onAccountDeletedElsewhere), and its AuthorProvider,
 * which rechecks the Session on any storage event, falls back to signed out.
 */
export const announceAccountDeleted = (accountId: string): void => {
  try {
    window.localStorage.setItem(
      DELETED,
      JSON.stringify({ accountId, at: new Date().toISOString() }),
    );
    // The write alone reaches the other tabs; the browser keeps no record of
    // the deleted account (their listener ignores the removal).
    window.localStorage.removeItem(DELETED);
  } catch {
    // Storage may be disabled; other tabs still sign out on their next check.
  }
};

/**
 * Calls `listener` with each account another tab of this browser announced
 * as deleted. Storage events never reach the tab that wrote them, which
 * already did the same itself.
 */
export const onAccountDeletedElsewhere = (
  listener: (accountId: string) => void,
): (() => void) => {
  const storage = (event: StorageEvent) => {
    if (event.key !== DELETED || event.newValue === null) return;
    let accountId: unknown;
    try {
      accountId = (JSON.parse(event.newValue) as { accountId?: unknown } | null)
        ?.accountId;
    } catch {
      return;
    }
    if (typeof accountId === "string" && ACCOUNT.test(accountId))
      listener(accountId);
  };
  window.addEventListener("storage", storage);
  return () => window.removeEventListener("storage", storage);
};

/**
 * After a deletion: clears this browser's data of the account, then tells the
 * other tabs, which end its editing, clear the same data and fall back to
 * signed out. A store that never answers is not waited for beyond `limitMs`.
 */
export const forgetDeletedAccount = async (
  accountId: string,
  limitMs = 3000,
) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    clearAccountLocalData(accountId),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, limitMs);
    }),
  ]);
  clearTimeout(timer);
  announceAccountDeleted(accountId);
};
