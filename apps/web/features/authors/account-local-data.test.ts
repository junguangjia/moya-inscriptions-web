// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stores = vi.hoisted(() => ({
  discardAvatarSave: vi.fn(),
  forgetLocalLibraryAccount: vi.fn(),
  discardBrowserEditorRecovery: vi.fn(),
  clearBrowserAccountRecovery: vi.fn(),
}));
vi.mock("./avatar-save", () => ({
  discardAvatarSave: stores.discardAvatarSave,
}));
vi.mock("./local-library", () => ({
  forgetLocalLibraryAccount: stores.forgetLocalLibraryAccount,
}));
vi.mock("../publishing/editor-recovery", () => ({
  discardBrowserEditorRecovery: stores.discardBrowserEditorRecovery,
}));
vi.mock("../publishing/local-recovery", () => ({
  clearBrowserAccountRecovery: stores.clearBrowserAccountRecovery,
}));

import {
  clearAccountLocalData,
  forgetDeletedAccount,
  onAccountDeletedElsewhere,
} from "./account-local-data";

// Synthetic account identifiers only.
const account = `user-${"a".repeat(32)}`;
const clearers = [
  stores.discardAvatarSave,
  stores.forgetLocalLibraryAccount,
  stores.discardBrowserEditorRecovery,
  stores.clearBrowserAccountRecovery,
];

const PING = "yoyi-account-deleted";
let sent: string[] = [];
/** The last ping written for the other tabs; the key itself never stays. */
const ping = () => {
  expect(window.localStorage.getItem(PING)).toBeNull();
  return sent.at(-1) ?? null;
};

beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
  sent = [];
  const setItem = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
    this: Storage,
    key: string,
    value: string,
  ) {
    if (key === PING) sent.push(value);
    setItem.call(this, key, value);
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("per-account local data after deletion", () => {
  it("clears every store of exactly that account", async () => {
    await clearAccountLocalData(account);
    for (const clear of clearers) expect(clear).toHaveBeenCalledWith(account);
  });

  it("keeps clearing the other stores when one fails or throws", async () => {
    stores.discardAvatarSave.mockImplementation(() => {
      throw new Error("storage disabled");
    });
    stores.forgetLocalLibraryAccount.mockRejectedValue(
      new Error("indexeddb unavailable"),
    );
    await expect(clearAccountLocalData(account)).resolves.toBeUndefined();
    expect(stores.discardBrowserEditorRecovery).toHaveBeenCalledWith(account);
    expect(stores.clearBrowserAccountRecovery).toHaveBeenCalledWith(account);
  });

  it.each(["guest", "", `user-${"A".repeat(32)}`, `work-${"a".repeat(32)}`])(
    "touches nothing for %j, which is not an account",
    async (value) => {
      await clearAccountLocalData(value);
      for (const clear of clearers) expect(clear).not.toHaveBeenCalled();
    },
  );

  it("tells other tabs which account was deleted only after this browser's data is cleared", async () => {
    let finish = () => {};
    stores.clearBrowserAccountRecovery.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const done = forgetDeletedAccount(account);
    await Promise.resolve();
    expect(ping()).toBeNull();
    finish();
    await done;
    // The account's opaque id and the time; nothing else, no credential.
    const sent = JSON.parse(ping() ?? "null") as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(["accountId", "at"]);
    expect(sent.accountId).toBe(account);
    expect(Number.isNaN(Date.parse(String(sent.at)))).toBe(false);
  });

  it("does not wait beyond its limit for a store that never answers", async () => {
    vi.useFakeTimers();
    stores.clearBrowserAccountRecovery.mockReturnValue(new Promise(() => {}));
    const done = forgetDeletedAccount(account, 3000);
    await vi.advanceTimersByTimeAsync(2999);
    expect(ping()).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(ping()).toContain(account);
  });
});

describe("the deletion ping in other tabs", () => {
  const receive = (key: string | null, newValue: string | null) =>
    window.dispatchEvent(new StorageEvent("storage", { key, newValue }));

  it("names exactly the deleted account and ignores everything else", () => {
    const heard = vi.fn();
    const stop = onAccountDeletedElsewhere(heard);
    receive(PING, JSON.stringify({ accountId: account, at: "2026-10-27" }));
    expect(heard.mock.calls).toEqual([[account]]);
    for (const [key, value] of [
      [null, null],
      [PING, null],
      ["yoyi-community-session-change", JSON.stringify({ accountId: account })],
      [PING, "not json"],
      [PING, "null"],
      [PING, JSON.stringify({ accountId: "guest" })],
      [PING, JSON.stringify({ accountId: `user-${"A".repeat(32)}` })],
      [PING, JSON.stringify([account])],
    ] as const)
      receive(key, value);
    expect(heard).toHaveBeenCalledOnce();
    stop();
    receive(PING, JSON.stringify({ accountId: account, at: "2026-10-27" }));
    expect(heard).toHaveBeenCalledOnce();
  });
});
