// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type { AuthorProfile } from "@moya/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  authRequest,
  requestAccountDeletion,
  forgetDeletedAccount,
  endAccountEditing,
  holdSession,
  releaseSession,
  progress,
  authors,
} = vi.hoisted(() => ({
  authRequest: vi.fn(),
  requestAccountDeletion: vi.fn(),
  forgetDeletedAccount: vi.fn(),
  endAccountEditing: vi.fn(),
  holdSession: vi.fn(),
  releaseSession: vi.fn(),
  progress: { active: false, hasUnsavedChanges: false },
  authors: {
    avatarSave: null as null | {
      accountId: string;
      message: string;
      failed: boolean;
    },
  },
}));
vi.mock("../auth/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth/auth-api")>()),
  authRequest,
  requestAccountDeletion,
}));
vi.mock("../../lib/public-api/feedback-client", () => ({
  feedbackClient: { submit: vi.fn() },
  feedbackImageLimits: { maxImages: 3, maxBytes: 10 * 1024 * 1024 },
}));
vi.mock("./author-data", () => ({
  authorClient: { people: vi.fn(), command: vi.fn() },
}));
vi.mock("./author-context", () => ({
  useAuthors: () => ({
    signInHref: "/login",
    viewer: { id: owner },
    mutate: vi.fn(),
    avatarSave: authors.avatarSave,
    holdSession,
  }),
}));
vi.mock("./account-local-data", () => ({ forgetDeletedAccount }));
vi.mock("../publishing/publishing-provider", () => ({
  useGlobalUploadProgress: () => progress,
}));
vi.mock("../publishing/ui/editor/editor-session-provider", () => ({
  useEndAccountEditing: () => endAccountEditing,
}));
vi.mock("../product-shell/product-shell", () => ({
  useProductShell: () => ({
    feedLayout: "double",
    platform: "phone",
    theme: "system",
    setThemePreference: vi.fn(),
    setFeedLayoutPreference: vi.fn(),
  }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => window.location.pathname,
}));
import { ProfileSettings } from "./profile-settings";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Synthetic account only; no provider, Session or Backend is used.
const owner = "user-00000000000000000000000000000001";
const profile: AuthorProfile = {
  id: owner,
  handle: "synthetic-deletion-owner",
  displayName: "注销测试",
  bio: "",
  avatar: null,
  isOwner: true,
  following: false,
  privacy: {
    following: "private",
    followers: "private",
    favorites: "private",
    likes: "private",
  },
  totals: { works: 0, following: 0, followers: 0, favorites: 0, likes: 0 },
  nextAvatarChangeAt: null,
};
const account = {
  userId: owner,
  email: {
    channel: "email",
    state: "unbound",
    masked: null,
    version: 0,
    usable: false,
  },
  phone: {
    channel: "phone",
    state: "verified",
    masked: "138****8000",
    version: 1,
    usable: true,
  },
  capabilities: {
    profile: "full-local",
    email: { available: true, reason: null },
    phone: { available: true, reason: null },
    developmentOnly: true,
  },
};
const sourceHistory = { screen: "profile" };
let root: Root | null = null;
let node: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  progress.active = false;
  progress.hasUnsavedChanges = false;
  authors.avatarSave = null;
  forgetDeletedAccount.mockResolvedValue(undefined);
  holdSession.mockReturnValue(releaseSession);
  authRequest.mockImplementation(async (path: string) => {
    if (path === "account") return { status: 200, body: account };
    if (path === "challenges")
      return {
        status: 200,
        body: {
          challengeId: "challenge-0123456789abcdef0123456789abcdef",
          continuationToken: "c".repeat(43),
          maskedTarget: "138****8000",
        },
      };
    if (path === "challenges/verify")
      return {
        status: 200,
        body: { outcome: "reauthenticated", reauthToken: "r".repeat(43) },
      };
    return { status: 503, body: null };
  });
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: true })),
  );
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: vi.fn(function (this: HTMLDialogElement) {
      this.open = true;
    }),
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: vi.fn(function (this: HTMLDialogElement) {
      this.open = false;
    }),
  });
  window.history.replaceState(sourceHistory, "", "/#profile");
});
afterEach(async () => {
  window.history.replaceState(sourceHistory, "", "/#profile");
  await act(async () => root?.unmount());
  // Lets a history traversal a closing dialog queued land before the next
  // test's dialog listens for it.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  root = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const render = async () => {
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  const onClose = vi.fn();
  await act(async () =>
    root!.render(
      <ProfileSettings
        profile={profile}
        onClose={onClose}
        onSaved={vi.fn()}
        onEdit={vi.fn()}
      />,
    ),
  );
  return { onClose };
};
const button = (label: string | RegExp) => {
  const found = Array.from(node.querySelectorAll("button")).find((item) =>
    typeof label === "string"
      ? item.getAttribute("aria-label") === label ||
        item.textContent?.trim().startsWith(label)
      : label.test(item.textContent ?? ""),
  );
  if (!found) throw new Error(`Missing button ${String(label)}`);
  return found;
};
const click = async (label: string | RegExp) =>
  act(async () => button(label).click());
const page = () =>
  node
    .querySelector("[data-settings-page]")
    ?.getAttribute("data-settings-page");
const pop = async (state: unknown) =>
  act(async () => {
    window.history.replaceState(state, "", "/#profile");
    window.dispatchEvent(new PopStateEvent("popstate", { state }));
  });
const openDeletion = async () => {
  await click("账号与安全");
  await click("注销账号");
  expect(page()).toBe("deletion");
};
/** From the impact page to the final confirmation through the phone proof. */
const reachFinal = async () => {
  await click("继续");
  await act(async () =>
    node.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
  );
  await click(/发送验证码到手机号/u);
  const input = node.querySelector<HTMLInputElement>(
    'input[aria-label="验证码"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, "123456");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("验证");
};

describe("account deletion in settings", () => {
  it("offers 注销账号 under 账号与安全 and returns there on cancel", async () => {
    await render();
    await click("账号与安全");
    const entry = button("注销账号");
    expect(entry.textContent).toContain("永久删除账号、作品和图片");
    // The entry follows sign-out, as the page's last row.
    expect(
      button("退出登录").compareDocumentPosition(entry) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await click("注销账号");
    expect(page()).toBe("deletion");
    expect(node.querySelector("dialog")?.getAttribute("aria-label")).toBe(
      "注销账号",
    );
    expect(window.history.state.phase4DialogDepth).toBe(2);
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const security = { ...window.history.state, phase4DialogDepth: 1 };
    await click("取消");
    expect(back).toHaveBeenCalledOnce();
    await pop(security);
    expect(page()).toBe("security");
    expect(requestAccountDeletion).not.toHaveBeenCalled();
  });

  it("warns about the composer's unfinished work and a pending avatar", async () => {
    progress.active = true;
    progress.hasUnsavedChanges = true;
    authors.avatarSave = {
      accountId: owner,
      message: "正在保存头像",
      failed: false,
    };
    await render();
    await openDeletion();
    await click("继续");
    const text = node.textContent ?? "";
    expect(text).toContain("还有未完成的内容");
    expect(text).toContain("作品图片仍在上传、处理或发布中。");
    expect(text).toContain("正在编辑的作品还有未保存的更改。");
    expect(text).toContain("新头像还没有保存完成。");
  });

  it("goes straight to verification when nothing is unfinished", async () => {
    await render();
    await openDeletion();
    await click("继续");
    expect(node.textContent).not.toContain("还有未完成的内容");
    expect(node.textContent).toContain("我已了解注销后无法恢复");
  });

  it("locks the dialog after deletion and leaves only through 完成", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    requestAccountDeletion.mockResolvedValue({
      status: 200,
      body: { outcome: "deleted", deletedAt: "2026-10-27T01:00:00.000Z" },
    });
    const { onClose } = await render();
    await openDeletion();
    await reachFinal();
    await click("确认注销");
    expect(requestAccountDeletion).toHaveBeenCalledWith(
      owner,
      expect.objectContaining({ reauthToken: "r".repeat(43) }),
    );
    // This tab's composer, uploads and autosave stop for the account before
    // its local data is cleared, so nothing writes it back.
    expect(endAccountEditing).toHaveBeenCalledWith(owner);
    expect(forgetDeletedAccount).toHaveBeenCalledWith(owner);
    expect(endAccountEditing.mock.invocationCallOrder[0]).toBeLessThan(
      forgetDeletedAccount.mock.invocationCallOrder[0]!,
    );
    expect(node.textContent).toContain("账号已注销");
    expect(button("返回").disabled).toBe(true);
    // A Session recheck cannot replace the result while it is shown.
    expect(holdSession).toHaveBeenCalledOnce();
    expect(releaseSession).not.toHaveBeenCalled();
    const go = vi.spyOn(window.history, "go").mockImplementation(() => {});
    await click("完成");
    expect(go).toHaveBeenCalledWith(-3);
    await pop(sourceHistory);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("holds Session rechecks while the outcome is unconfirmed and releases them when the page is left", async () => {
    requestAccountDeletion.mockRejectedValue(new TypeError("offline"));
    await render();
    await openDeletion();
    expect(holdSession).not.toHaveBeenCalled();
    await reachFinal();
    await click("确认注销");
    expect(node.textContent).toContain("注销结果尚未确认");
    expect(holdSession).toHaveBeenCalledOnce();
    await click("重试注销");
    expect(holdSession).toHaveBeenCalledOnce();
    expect(releaseSession).not.toHaveBeenCalled();
    expect(forgetDeletedAccount).not.toHaveBeenCalled();
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const security = { ...window.history.state, phase4DialogDepth: 1 };
    await click("取消");
    // Leaving keeps this device's data of a possibly deleted account: asked.
    expect(back).not.toHaveBeenCalled();
    await click("仍然离开");
    expect(back).toHaveBeenCalledOnce();
    await pop(security);
    expect(page()).toBe("security");
    expect(releaseSession).toHaveBeenCalledOnce();
    expect(forgetDeletedAccount).not.toHaveBeenCalled();
  });

  it("asks before Back, Escape or a history step leaves an unconfirmed deletion", async () => {
    requestAccountDeletion.mockRejectedValue(new TypeError("offline"));
    await render();
    await openDeletion();
    await reachFinal();
    await click("确认注销");
    expect(node.textContent).toContain("注销结果尚未确认");
    const question = () => node.querySelector('[role="alertdialog"]');
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const forward = vi
      .spyOn(window.history, "forward")
      .mockImplementation(() => {});
    const deletionState = { ...window.history.state };
    const security = { ...deletionState, phase4DialogDepth: 1 };

    // The dialog's Back button.
    await click("返回");
    expect(back).not.toHaveBeenCalled();
    expect(question()?.textContent).toContain("注销可能已经完成");
    await click("留下重试");
    expect(question()).toBeNull();

    // Escape on the dialog.
    await act(async () => {
      node
        .querySelector("dialog")!
        .dispatchEvent(new Event("cancel", { cancelable: true }));
    });
    expect(back).not.toHaveBeenCalled();
    expect(question()).not.toBeNull();
    await click("留下重试");

    // The browser's or phone's Back: the step is undone and the page asks.
    await pop(security);
    expect(forward).toHaveBeenCalledOnce();
    await pop(deletionState);
    expect(page()).toBe("deletion");
    expect(question()).not.toBeNull();
    expect(releaseSession).not.toHaveBeenCalled();

    await click("仍然离开");
    expect(back).toHaveBeenCalledOnce();
    await pop(security);
    expect(page()).toBe("security");
    expect(releaseSession).toHaveBeenCalledOnce();
    expect(requestAccountDeletion).toHaveBeenCalledOnce();
  });
});
