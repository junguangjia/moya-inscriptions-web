// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  client,
  author,
  authReturn,
  enter,
  progress,
  announce,
  carry,
  evidence,
} = vi.hoisted(() => ({
  client: {
    list: vi.fn(),
    switchTo: vi.fn(),
    remove: vi.fn(),
    signOutAll: vi.fn(),
  },
  author: {
    signInHref: "/login",
    avatarSave: null as null | { message: string; failed: boolean },
    refresh: vi.fn(),
  },
  authReturn: { prepare: vi.fn() },
  enter: vi.fn(),
  progress: { active: false, hasUnsavedChanges: false },
  announce: vi.fn(),
  carry: vi.fn(),
  evidence: vi.fn(() => 0),
}));
vi.mock("./account-data", () => ({
  communityAccountLimit: 3,
  communityAccountsClient: client,
  reportEvidenceUploadsInFlight: evidence,
}));
vi.mock("./author-context", () => ({ useAuthors: () => author }));
vi.mock("../auth/auth-return", () => ({
  useAuthReturn: () => authReturn,
  useAuthEntry: () => enter,
}));
vi.mock("../publishing/publishing-provider", () => ({
  useGlobalUploadProgress: () => progress,
}));
vi.mock("./session-change", () => ({
  announceCommunitySessionChange: announce,
  carrySessionNotice: carry,
}));

import { AccountSwitcher } from "./account-switcher";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// account-switching-v1: synthetic accounts only; this page never sees a session.
const current = {
  id: `user-${"a".repeat(32)}`,
  handle: "synthetic-current",
  displayName: "当前账户",
};
const second = {
  id: `user-${"b".repeat(32)}`,
  handle: "synthetic-second",
  displayName: "第二个账户",
  studioName: "墨斋",
};
const third = {
  id: `user-${"c".repeat(32)}`,
  handle: "synthetic-third",
  displayName: "第三个账户",
};
const expired = {
  id: `user-${"d".repeat(32)}`,
  handle: "synthetic-expired",
  displayName: null,
  state: "reauth_required" as const,
};
const ready = <T extends object>(account: T) => ({
  ...account,
  state: "ready" as const,
});
const view = (others: unknown[] = [ready(second)], me: unknown = current) => ({
  state: "ready" as const,
  view: { current: me, others, limit: 3 },
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

let root: Root | null = null;
let node: HTMLDivElement;
const onBusyChange = vi.fn();
const onSessionChange = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  author.avatarSave = null;
  progress.active = false;
  progress.hasUnsavedChanges = false;
  authReturn.prepare.mockResolvedValue(true);
  author.refresh.mockResolvedValue(undefined);
  client.list.mockResolvedValue(view());
  client.switchTo.mockResolvedValue({ state: "switched" });
  client.remove.mockResolvedValue({ state: "removed" });
  client.signOutAll.mockResolvedValue({ state: "signed-out" });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

const render = async (
  props: Partial<Parameters<typeof AccountSwitcher>[0]> = {},
) => {
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () =>
    root!.render(
      <AccountSwitcher
        viewerId={current.id}
        unsavedSettings={null}
        onBusyChange={onBusyChange}
        onSessionChange={onSessionChange}
        {...props}
      />,
    ),
  );
};
const button = (label: string) => {
  const found = [...node.querySelectorAll("button")].find(
    (item) =>
      item.getAttribute("aria-label") === label ||
      item.textContent?.trim().startsWith(label),
  );
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
};
const click = async (label: string) => act(async () => button(label).click());
const row = (id: string) =>
  node.querySelector<HTMLElement>(`[data-account-row="${id}"]`);
const alert = () => node.querySelector("[role=alert]")?.textContent ?? "";

describe("AccountSwitcher", () => {
  it("marks the current account and lists the others by name and handle", async () => {
    client.list.mockResolvedValue(view([ready(second), expired]));
    await render();
    const currentRow = node.querySelector("[data-account-current]");
    expect(currentRow?.textContent).toContain("当前账户");
    expect(currentRow?.textContent).toContain("@synthetic-current");
    expect(currentRow?.textContent).toContain("当前");
    expect(row(second.id)?.textContent).toContain("第二个账户");
    expect(row(second.id)?.textContent).toContain("@synthetic-second");
    expect(row(second.id)?.getAttribute("data-account-state")).toBe("ready");
    expect(button("切换到「第二个账户」")).toBeDefined();
    expect(row(expired.id)?.textContent).toContain("需重新登录");
    expect(row(expired.id)?.querySelector("button")?.textContent).toBe(
      "重新登录",
    );
    expect(node.textContent).toContain("已从这台设备移除");
    // Nothing in the page carries a session.
    expect(node.innerHTML).not.toMatch(/token/iu);
  });

  it("shows a signed-out browser its held accounts without a current one", async () => {
    await render({
      viewerId: null,
      initialView: view([ready(second)], null).view as Parameters<
        typeof AccountSwitcher
      >[0]["initialView"],
    });
    expect(client.list).not.toHaveBeenCalled();
    expect(node.textContent).toContain("未登录");
    expect(node.querySelector("[data-account-current]")).toBeNull();
    expect(node.textContent).not.toContain("其他页面更改");
    expect(button("退出所有账号")).toBeDefined();
  });

  it("says so when the current account changed, without guessing where", async () => {
    await render({ viewerId: third.id });
    expect(node.textContent).toContain("当前账户已变化");
    expect(node.textContent).not.toContain("其他页面");
  });

  it("retries an unavailable read without inventing accounts", async () => {
    client.list.mockResolvedValueOnce({ state: "unavailable" });
    await render();
    expect(alert()).toContain("暂时无法读取");
    expect(node.querySelector("[data-account-switcher]")).toBeNull();
    await click("重试");
    expect(client.list).toHaveBeenCalledTimes(2);
    expect(row(second.id)).not.toBeNull();
  });

  it("refuses a fourth account before sign-in and adds through the add-account entry", async () => {
    client.list.mockResolvedValue(view([ready(second), ready(third)]));
    await render();
    expect(button("添加账号").disabled).toBe(true);
    expect(node.textContent).toContain(
      "最多同时登录 3 个账户，请先移除一个账户",
    );
    await act(async () => root!.unmount());
    client.list.mockResolvedValue(view([ready(second)]));
    await render();
    const add = button("添加账号");
    expect(add.disabled).toBe(false);
    await click("添加账号");
    expect(enter).toHaveBeenCalledWith("/login?intent=add-account", add);
    expect(client.switchTo).not.toHaveBeenCalled();
  });

  it("sends a refused account through add-account sign-in", async () => {
    client.list.mockResolvedValue(view([expired]));
    author.signInHref = "/login?return=%2F";
    try {
      await render();
      await click("重新登录「@synthetic-expired」");
      expect(enter).toHaveBeenCalledWith(
        "/login?return=%2F&intent=add-account",
        expect.any(HTMLButtonElement),
      );
    } finally {
      author.signInHref = "/login";
    }
  });

  it("switches once, announces the change and hands the reload to settings", async () => {
    const pending = deferred<{ state: "switched" }>();
    client.switchTo.mockReturnValue(pending.promise);
    await render();
    await click("切换到「第二个账户」");
    await click("切换到「第二个账户」");
    expect(authReturn.prepare).toHaveBeenCalledOnce();
    expect(client.switchTo).toHaveBeenCalledOnce();
    expect(client.switchTo).toHaveBeenCalledWith(second.id);
    expect(onBusyChange).toHaveBeenLastCalledWith(true);
    expect(button("切换到「第二个账户」").disabled).toBe(true);
    await act(async () => pending.resolve({ state: "switched" }));
    expect(announce).toHaveBeenCalledOnce();
    expect(onSessionChange).toHaveBeenCalledOnce();
    // Settings may close now, while nothing here can be pressed again.
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
    expect(button("切换到「第二个账户」").disabled).toBe(true);
  });

  it("checks unfinished work first and lets the reader cancel", async () => {
    progress.active = true;
    author.avatarSave = { message: "正在保存头像", failed: false };
    await render({ unsavedSettings: "列表隐私有未保存的更改" });
    await click("切换到「第二个账户」");
    const dialog = node.querySelector("[role=alertdialog]");
    expect(dialog?.textContent).toContain("还有未完成的内容");
    expect(dialog?.textContent).toContain("作品还有未完成的上传或发布");
    expect(dialog?.textContent).toContain("头像仍在保存");
    expect(dialog?.textContent).toContain("列表隐私有未保存的更改");
    expect(client.switchTo).not.toHaveBeenCalled();
    await click("取消");
    expect(node.querySelector("[role=alertdialog]")).toBeNull();
    expect(client.switchTo).not.toHaveBeenCalled();
    progress.active = false;
    progress.hasUnsavedChanges = true;
    author.avatarSave = null;
    await click("切换到「第二个账户」");
    expect(node.querySelector("[role=alertdialog]")?.textContent).toContain(
      "作品还有未保存的编辑",
    );
    await click("仍然切换");
    expect(authReturn.prepare).toHaveBeenCalledOnce();
    expect(client.switchTo).toHaveBeenCalledWith(second.id);
    expect(onSessionChange).toHaveBeenCalledOnce();
  });

  it("names an evidence upload still in flight before switching or signing out", async () => {
    evidence.mockReturnValue(1);
    try {
      await render();
      await click("切换到「第二个账户」");
      expect(node.querySelector("[role=alertdialog]")?.textContent).toContain(
        "举报附件仍在上传",
      );
      expect(client.switchTo).not.toHaveBeenCalled();
      await click("取消");
      await click("退出所有账号");
      expect(node.querySelector("[role=alertdialog]")?.textContent).toContain(
        "举报附件仍在上传",
      );
    } finally {
      evidence.mockReturnValue(0);
    }
  });

  it("does not switch when the editor could not keep its local recovery", async () => {
    authReturn.prepare.mockResolvedValue(false);
    await render();
    await click("切换到「第二个账户」");
    expect(client.switchTo).not.toHaveBeenCalled();
    expect(alert()).toContain("本机恢复未能保存");
    expect(onSessionChange).not.toHaveBeenCalled();
    expect(button("切换到「第二个账户」").disabled).toBe(false);
  });

  it("shows a refused target as 需重新登录 and never claims success", async () => {
    client.switchTo.mockResolvedValue({
      state: "refused",
      reason: "reauth_required",
    });
    await render();
    await click("切换到「第二个账户」");
    expect(alert()).toContain("「第二个账户」的登录已失效");
    expect(row(second.id)?.getAttribute("data-account-state")).toBe(
      "reauth_required",
    );
    expect(button("重新登录「第二个账户」")).toBeDefined();
    expect(announce).not.toHaveBeenCalled();
    expect(onSessionChange).not.toHaveBeenCalled();
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it("keeps everything as it was after a network failure", async () => {
    client.switchTo.mockResolvedValue({ state: "failed" });
    await render();
    await click("切换到「第二个账户」");
    expect(alert()).toContain("暂时无法切换账户");
    expect(row(second.id)?.getAttribute("data-account-state")).toBe("ready");
    expect(onSessionChange).not.toHaveBeenCalled();
    expect(button("切换到「第二个账户」").disabled).toBe(false);
  });

  it("reads again when the target is no longer held, keeping earlier 需重新登录 reports", async () => {
    client.list
      .mockResolvedValueOnce(view([ready(second), expired]))
      .mockResolvedValueOnce(view([]));
    client.switchTo.mockResolvedValue({
      state: "refused",
      reason: "account_not_found",
    });
    await render();
    await click("切换到「第二个账户」");
    expect(alert()).toContain("这个账户已不在这台设备上");
    expect(client.list).toHaveBeenCalledTimes(2);
    expect(row(second.id)).toBeNull();
    expect(row(expired.id)?.textContent).toContain("需重新登录");
  });

  it("removes another account only after confirmation", async () => {
    await render();
    await click("移除「第二个账户」");
    expect(node.querySelector("[role=alertdialog]")?.textContent).toContain(
      "这个账户会在这台设备上退出登录",
    );
    expect(client.remove).not.toHaveBeenCalled();
    await act(async () =>
      [...node.querySelectorAll("[role=alertdialog] button")]
        .find((item) => item.textContent === "移除")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(client.remove).toHaveBeenCalledWith(second.id);
    expect(row(second.id)).toBeNull();
    expect(node.textContent).toContain("已移除「第二个账户」");
    expect(onSessionChange).not.toHaveBeenCalled();
  });

  it("keeps 切换 and 移除 disabled while a read is in flight", async () => {
    const reread = deferred<ReturnType<typeof view>>();
    client.list
      .mockResolvedValueOnce(view([ready(second), ready(third)]))
      .mockReturnValueOnce(reread.promise);
    client.remove.mockResolvedValue({
      state: "refused",
      reason: "account_not_found",
    });
    await render();
    await click("移除「第二个账户」");
    await act(async () =>
      [...node.querySelectorAll("[role=alertdialog] button")]
        .find((item) => item.textContent === "移除")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(client.list).toHaveBeenCalledTimes(2);
    expect(button("切换到「第三个账户」").disabled).toBe(true);
    expect(button("移除「第三个账户」").disabled).toBe(true);
    await click("切换到「第三个账户」");
    expect(client.switchTo).not.toHaveBeenCalled();
    await act(async () => reread.resolve(view([ready(third)])));
    expect(button("切换到「第三个账户」").disabled).toBe(false);
    expect(button("移除「第三个账户」").disabled).toBe(false);
  });

  it("keeps an account whose removal could not be confirmed", async () => {
    client.remove.mockResolvedValue({
      state: "refused",
      reason: "unavailable",
    });
    await render();
    await click("移除「第二个账户」");
    await act(async () =>
      [...node.querySelectorAll("[role=alertdialog] button")]
        .find((item) => item.textContent === "移除")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(alert()).toContain("暂时无法移除");
    expect(row(second.id)).not.toBeNull();
  });

  it("signs every account out after confirmation and reloads", async () => {
    await render();
    await click("退出所有账号");
    const dialog = node.querySelector("[role=alertdialog]");
    expect(dialog?.textContent).toContain("这台设备上的所有账户都会退出登录");
    expect(client.signOutAll).not.toHaveBeenCalled();
    await act(async () =>
      [...node.querySelectorAll("[role=alertdialog] button")]
        .find((item) => item.textContent === "退出所有账号")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(authReturn.prepare).toHaveBeenCalledOnce();
    expect(client.signOutAll).toHaveBeenCalledOnce();
    expect(announce).toHaveBeenCalledOnce();
    expect(onSessionChange).toHaveBeenCalledOnce();
  });

  it("names unfinished work in the sign-out-all confirmation", async () => {
    progress.active = true;
    await render();
    await click("退出所有账号");
    expect(node.querySelector("[role=alertdialog]")?.textContent).toContain(
      "作品还有未完成的上传或发布",
    );
  });

  const confirmSignOutAll = async () => {
    await click("退出所有账号");
    await act(async () =>
      [...node.querySelectorAll("[role=alertdialog] button")]
        .find((item) => item.textContent === "退出所有账号")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
  };

  const partial = (
    currentCleared: boolean,
    remaining: readonly { id: string; handle: string }[],
  ) => ({
    state: "partial" as const,
    currentCleared,
    remaining: remaining.map(({ id, handle }) => ({ id, handle })),
  });

  it("reloads as signed out when a partial sign-out ended the current account, and says so after the reload", async () => {
    client.signOutAll.mockResolvedValue(partial(true, [second]));
    await render();
    await confirmSignOutAll();
    // The answer decides: no second read.
    expect(client.list).toHaveBeenCalledOnce();
    // The next page load names what is still held; never a plain success.
    expect(carry).toHaveBeenCalledOnce();
    expect(carry).toHaveBeenCalledWith(
      "已退出当前账号；另有 1 个账号未能确认退出：「第二个账户」。请到 设置 → 切换账号 再次退出。",
    );
    expect(carry.mock.invocationCallOrder[0]).toBeLessThan(
      onSessionChange.mock.invocationCallOrder[0]!,
    );
    // This page follows the signed-out state like a full sign-out does.
    expect(announce).toHaveBeenCalledOnce();
    expect(onSessionChange).toHaveBeenCalledOnce();
    expect(node.textContent).not.toContain("其他页面");
    expect(button("切换到「第二个账户」").disabled).toBe(true);
  });

  it("names a held account this page did not show by its handle", async () => {
    client.list.mockResolvedValue(view([ready(second)]));
    client.signOutAll.mockResolvedValue(partial(true, [second, third]));
    await render();
    await confirmSignOutAll();
    expect(carry).toHaveBeenCalledWith(
      "已退出当前账号；另有 2 个账号未能确认退出：「第二个账户」、「@synthetic-third」。请到 设置 → 切换账号 再次退出。",
    );
    expect(onSessionChange).toHaveBeenCalledOnce();
  });

  it("stays with the error and what is still held when the current account was kept", async () => {
    client.list.mockResolvedValue(view([ready(second), ready(third), expired]));
    client.signOutAll.mockResolvedValue(partial(false, [second]));
    await render();
    await confirmSignOutAll();
    expect(client.list).toHaveBeenCalledOnce();
    expect(alert()).toContain("部分账户未能确认退出，请重试。");
    expect(onSessionChange).not.toHaveBeenCalled();
    expect(carry).not.toHaveBeenCalled();
    // Signed-out accounts leave; the current one and the unconfirmed one stay.
    expect(node.querySelector("[data-account-current]")?.textContent).toContain(
      "当前账户",
    );
    expect(row(second.id)?.getAttribute("data-account-state")).toBe("ready");
    expect(row(third.id)).toBeNull();
    expect(row(expired.id)?.textContent).toContain("需重新登录");
    expect(announce).toHaveBeenCalledOnce();
    // This tab's identity is still the account the page shows.
    expect(author.refresh).not.toHaveBeenCalled();
    expect(node.textContent).not.toContain("当前账户已变化");
    expect(button("退出所有账号").disabled).toBe(false);
  });

  it("stays on a signed-out page and lists what is left", async () => {
    client.signOutAll.mockResolvedValue(partial(true, [second]));
    await render({
      viewerId: null,
      initialView: view([ready(second), ready(third)], null).view as Parameters<
        typeof AccountSwitcher
      >[0]["initialView"],
    });
    await confirmSignOutAll();
    expect(onSessionChange).not.toHaveBeenCalled();
    expect(carry).not.toHaveBeenCalled();
    expect(alert()).toContain("部分账户未能确认退出");
    expect(node.textContent).toContain("未登录");
    expect(row(second.id)).not.toBeNull();
    expect(row(third.id)).toBeNull();
    expect(client.list).not.toHaveBeenCalled();
    expect(author.refresh).not.toHaveBeenCalled();
  });

  it("follows a current account this signed-out page did not know about", async () => {
    client.signOutAll.mockResolvedValue(partial(false, []));
    client.list.mockResolvedValue(view([], current));
    await render({
      viewerId: null,
      initialView: view([ready(second)], null).view as Parameters<
        typeof AccountSwitcher
      >[0]["initialView"],
    });
    await confirmSignOutAll();
    expect(onSessionChange).not.toHaveBeenCalled();
    expect(alert()).toContain("部分账户未能确认退出");
    expect(author.refresh).toHaveBeenCalledOnce();
    expect(client.list).toHaveBeenCalledOnce();
    expect(row(second.id)).toBeNull();
  });

  it("does not claim a partial sign-out when the request got no answer", async () => {
    client.signOutAll.mockResolvedValue({ state: "failed" });
    await render();
    await confirmSignOutAll();
    expect(alert()).toContain("退出未能确认，请检查网络后重试");
    expect(alert()).not.toContain("部分");
    expect(onSessionChange).not.toHaveBeenCalled();
    expect(carry).not.toHaveBeenCalled();
  });

  it("reads what is held after an unanswered sign-out and reloads with a notice when the current account ended", async () => {
    client.signOutAll.mockResolvedValue({ state: "failed" });
    client.list
      .mockResolvedValueOnce(view())
      .mockResolvedValueOnce(view([ready(second)], null));
    await render();
    await confirmSignOutAll();
    expect(client.list).toHaveBeenCalledTimes(2);
    expect(carry).toHaveBeenCalledWith(
      "已退出当前账号；另有 1 个账号未能确认退出：「第二个账户」。请到 设置 → 切换账号 再次退出。",
    );
    expect(onSessionChange).toHaveBeenCalledOnce();
  });

  it("reloads quietly when that read shows nothing is held any more", async () => {
    client.signOutAll.mockResolvedValue({
      state: "refused",
      reason: "unavailable",
    });
    client.list
      .mockResolvedValueOnce(view())
      .mockResolvedValueOnce(view([], null));
    await render();
    await confirmSignOutAll();
    expect(carry).not.toHaveBeenCalled();
    expect(onSessionChange).toHaveBeenCalledOnce();
  });

  it("keeps the page when neither the sign-out nor the read was answered", async () => {
    client.signOutAll.mockResolvedValue({
      state: "refused",
      reason: "unavailable",
    });
    client.list
      .mockResolvedValueOnce(view())
      .mockResolvedValueOnce({ state: "unavailable" });
    await render();
    await confirmSignOutAll();
    expect(alert()).toContain("退出未能确认，请重试。");
    expect(alert()).not.toContain("部分");
    expect(onSessionChange).not.toHaveBeenCalled();
    expect(row(second.id)).not.toBeNull();
  });
});
