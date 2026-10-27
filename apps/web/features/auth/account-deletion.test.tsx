// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authRequest, requestAccountDeletion } = vi.hoisted(() => ({
  authRequest: vi.fn(),
  requestAccountDeletion: vi.fn(),
}));
vi.mock("./auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth-api")>()),
  authRequest,
  requestAccountDeletion,
}));

import { AccountDeletion } from "./account-deletion";
import type { AccountDeletionHandle } from "./account-deletion";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Synthetic account and proofs only; no provider, Session or Backend is used.
const viewer = `user-${"a".repeat(32)}`;
const factor = (channel: "email" | "phone", masked: string | null) => ({
  channel,
  state: masked === null ? ("unbound" as const) : ("verified" as const),
  masked,
  version: masked === null ? 0 : 1,
  usable: masked !== null,
});
const account = {
  userId: viewer,
  email: factor("email", "a***@example.com"),
  phone: factor("phone", "138****8000"),
  capabilities: {
    profile: "full-local" as const,
    email: { available: true, reason: null },
    phone: { available: true, reason: null },
    developmentOnly: true,
  },
};
const challenge = {
  challengeId: "challenge-0123456789abcdef0123456789abcdef",
  continuationToken: "c".repeat(43),
  maskedTarget: "138****8000",
  resendAvailableAt: new Date(Date.now() + 60_000).toISOString(),
};
const reauthToken = "r".repeat(43);
const deleted = { outcome: "deleted", deletedAt: "2026-10-27T01:00:00.000Z" };
const refusal = (message: string) => ({ error: { code: "X", message } });

let root: Root | null = null;
let node: HTMLDivElement;
const handle: { current: AccountDeletionHandle | null } = { current: null };
const props = {
  onBusyChange: vi.fn(),
  onPendingChange: vi.fn(),
  onCancel: vi.fn(),
  onDeleted: vi.fn(),
  onFinished: vi.fn(),
};

const serve = (overrides: Record<string, unknown> = {}) =>
  authRequest.mockImplementation(async (path: string) => {
    if (path in overrides)
      return overrides[path] as { status: number; body: unknown };
    if (path === "account") return { status: 200, body: account };
    if (path === "challenges") return { status: 200, body: challenge };
    if (path === "challenges/verify")
      return { status: 200, body: { outcome: "reauthenticated", reauthToken } };
    return { status: 500, body: null };
  });

const render = async (unfinishedWork: readonly string[] = []) => {
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () =>
    root!.render(
      <AccountDeletion
        expectedViewerId={viewer}
        unfinishedWork={unfinishedWork}
        navigationRef={handle}
        {...props}
      />,
    ),
  );
};
const button = (label: string | RegExp) => {
  const found = Array.from(node.querySelectorAll("button")).find((item) =>
    typeof label === "string"
      ? item.textContent?.trim() === label
      : label.test(item.textContent ?? ""),
  );
  if (!found) throw new Error(`Missing button ${String(label)}`);
  return found;
};
const hasButton = (label: string | RegExp) => {
  try {
    button(label);
    return true;
  } catch {
    return false;
  }
};
const click = async (label: string | RegExp) =>
  act(async () => button(label).click());
const step = () =>
  node.querySelector("section")?.getAttribute("data-deletion-step");
const check = async () =>
  act(async () =>
    node.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
  );
const type = async (value: string) => {
  const input = node.querySelector<HTMLInputElement>(
    'input[aria-label="验证码"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
/** From the impact page to the final confirmation through the phone proof. */
const reachFinal = async () => {
  await click("继续");
  await check();
  await click(/发送验证码到手机号/u);
  await type("123456");
  await click("验证");
  expect(step()).toBe("final");
};
const alert = () => node.querySelector('[role="alert"]')?.textContent ?? "";

beforeEach(() => {
  vi.resetAllMocks();
  serve();
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  node.remove();
});

describe("AccountDeletion", () => {
  it("states every effect first and leaves through cancel without a request", async () => {
    await render();
    const text = node.textContent ?? "";
    for (const effect of [
      "不能撤销",
      "所有设备上的登录立即失效",
      "作品、作品草稿和专题文章草稿（含标题、正文和封面）及其图片",
      "已提交审核或已发布的版本存档不会删除",
      "已注销用户",
      "关注、粉丝、你设置的屏蔽、喜欢、收藏和评论点赞会被移除",
      "其他用户对此账号的屏蔽继续有效",
      "私信记录对方仍可看到",
      "手机号和邮箱会被释放",
      "邀请名额不退还",
      "隐私政策",
    ])
      expect(text).toContain(effect);
    await click("取消");
    expect(props.onCancel).toHaveBeenCalledOnce();
    expect(authRequest.mock.calls.map(([path]) => path)).toEqual(["account"]);
    expect(requestAccountDeletion).not.toHaveBeenCalled();
  });

  it.each([
    [
      "no bound contact",
      {
        ...account,
        email: factor("email", null),
        phone: factor("phone", null),
      },
    ],
    [
      "bound contacts whose channels are unavailable",
      {
        ...account,
        capabilities: {
          ...account.capabilities,
          profile: "password-only" as const,
          email: { available: false, reason: null },
          phone: { available: false, reason: null },
        },
      },
    ],
  ])("explains and stops for %s", async (_label, value) => {
    serve({ account: { status: 200, body: value } });
    await render();
    expect(node.textContent).toContain("暂时不能在这里注销");
    expect(button("继续").disabled).toBe(true);
    expect(authRequest).toHaveBeenCalledTimes(1);
  });

  it("does not trust an account answer for someone else and offers a retry", async () => {
    serve({
      account: {
        status: 200,
        body: { ...account, userId: `user-${"b".repeat(32)}` },
      },
    });
    await render();
    expect(node.textContent).toContain("账户信息暂时无法确认");
    expect(button("继续").disabled).toBe(true);
    serve();
    await click("重试");
    expect(button("继续").disabled).toBe(false);
  });

  it("warns about unfinished work and lets the owner cancel there", async () => {
    await render(["作品图片仍在上传、处理或发布中。"]);
    await click("继续");
    expect(step()).toBe("unfinished");
    expect(node.textContent).toContain("作品图片仍在上传、处理或发布中。");
    await click("取消");
    expect(props.onCancel).toHaveBeenCalledOnce();
    await click("仍然继续");
    expect(step()).toBe("proof");
  });

  it("waits for the resend time before sending another code", async () => {
    await render();
    await click("继续");
    await check();
    await click(/发送验证码到手机号/u);
    expect(button(/秒后重新获取/u).disabled).toBe(true);
    serve({
      "challenges/verify": {
        status: 400,
        body: refusal("AUTH_PROOF_REJECTED"),
      },
    });
    await type("123456");
    await click("验证");
    await click("重新验证");
    expect(button(/发送验证码到手机号.*秒后可发送/u).disabled).toBe(true);
    expect(button(/发送验证码到邮箱/u).disabled).toBe(false);
    expect(
      authRequest.mock.calls.filter(([path]) => path === "challenges"),
    ).toHaveLength(1);
  });

  it("sends no code before the irreversible effect is acknowledged", async () => {
    await render();
    await click("继续");
    expect(button(/发送验证码到手机号 138\*\*\*\*8000/u).disabled).toBe(true);
    expect(button(/发送验证码到邮箱/u).disabled).toBe(true);
    await check();
    await click(/发送验证码到邮箱/u);
    expect(authRequest).toHaveBeenLastCalledWith("challenges", {
      body: expect.objectContaining({
        channel: "email",
        purpose: "reauthenticate",
      }),
    });
    expect(step()).toBe("code");
  });

  it("keeps the code step going on a wrong code and never calls the account intact on a rejected proof", async () => {
    serve({
      "challenges/verify": {
        status: 400,
        body: refusal("AUTH_CODE_INVALID"),
      },
    });
    await render();
    await click("继续");
    await check();
    await click(/发送验证码到手机号/u);
    await type("654321");
    await click("验证");
    expect(alert()).toBe("验证码不正确。");
    expect(step()).toBe("code");
    serve({
      "challenges/verify": {
        status: 400,
        body: refusal("AUTH_PROOF_REJECTED"),
      },
    });
    await click("验证");
    // A deletion finished on another page or device removes this proof too,
    // so the code step's refusal proves nothing about the account.
    expect(alert()).toBe("这次验证已失效，请重新验证。");
    await click("重新验证");
    expect(step()).toBe("proof");
    expect(requestAccountDeletion).not.toHaveBeenCalled();
  });

  it("deletes once with the confirmed account, then clears and finishes", async () => {
    let resolveForget = () => {};
    props.onDeleted.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveForget = resolve;
      }),
    );
    requestAccountDeletion.mockResolvedValue({ status: 200, body: deleted });
    await render();
    await reachFinal();
    expect(node.textContent).toContain("这一步不能撤销");
    await act(async () => {
      const confirm = button("确认注销");
      confirm.click();
      confirm.click();
    });
    expect(requestAccountDeletion).toHaveBeenCalledOnce();
    const [accountId, request] = requestAccountDeletion.mock.calls[0]!;
    expect(accountId).toBe(viewer);
    expect(request).toEqual({
      reauthToken,
      idempotencyKey: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      ),
    });
    expect(step()).toBe("done");
    expect(node.textContent).toContain("账号已注销");
    expect(props.onDeleted).toHaveBeenCalledWith(viewer);
    expect(props.onBusyChange).toHaveBeenLastCalledWith(true);
    expect(hasButton("取消")).toBe(false);
    await click("完成");
    expect(props.onFinished).not.toHaveBeenCalled();
    await act(async () => resolveForget());
    expect(props.onFinished).toHaveBeenCalledOnce();
    expect(props.onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it("retries an unanswered request with the same idempotency key", async () => {
    requestAccountDeletion
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce({ status: 503, body: null })
      .mockResolvedValueOnce({ status: 200, body: deleted });
    await render();
    await reachFinal();
    await click("确认注销");
    expect(alert()).toContain("注销结果尚未确认");
    expect(step()).toBe("final");
    await click("重试注销");
    expect(alert()).toContain("注销结果尚未确认");
    await click("重试注销");
    expect(step()).toBe("done");
    const keys = requestAccountDeletion.mock.calls.map(
      ([, request]) => (request as { idempotencyKey: string }).idempotencyKey,
    );
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
  });

  it("asks for a new proof and a new key after the proof was rejected", async () => {
    serve({
      challenges: {
        status: 200,
        body: { ...challenge, resendAvailableAt: new Date(0).toISOString() },
      },
    });
    requestAccountDeletion
      .mockResolvedValueOnce({
        status: 400,
        body: refusal("AUTH_PROOF_REJECTED"),
      })
      .mockResolvedValueOnce({ status: 200, body: deleted });
    await render();
    await reachFinal();
    await click("确认注销");
    expect(alert()).toBe("这次验证已失效，请重新验证。账号没有被注销。");
    expect(hasButton("确认注销")).toBe(false);
    await click("重新验证");
    await click(/发送验证码到手机号/u);
    await type("123456");
    await click("验证");
    await click("确认注销");
    expect(step()).toBe("done");
    const [first, second] = requestAccountDeletion.mock.calls.map(
      ([, request]) => (request as { idempotencyKey: string }).idempotencyKey,
    );
    expect(first).not.toBe(second);
  });

  it.each([
    [401, "AUTH_UNAUTHENTICATED", "无法在这里确认注销结果"],
    [401, "AUTH_ACCOUNT_SUSPENDED", "不能自助注销"],
  ])(
    "stops on a definitive %i refusal without claiming success",
    async (status, reason, text) => {
      requestAccountDeletion.mockResolvedValue({
        status,
        body: refusal(reason),
      });
      await render();
      await reachFinal();
      await click("确认注销");
      expect(alert()).toContain(text);
      expect(step()).toBe("final");
      expect(button("确认注销").disabled).toBe(true);
      expect(props.onDeleted).not.toHaveBeenCalled();
      expect(button("取消").disabled).toBe(false);
      await click("取消");
      expect(props.onCancel).toHaveBeenCalledOnce();
    },
  );

  it("forgets the account's local data even when the page was left before the answer", async () => {
    let answer: (value: { status: number; body: unknown }) => void = () => {};
    requestAccountDeletion.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    await render();
    await reachFinal();
    await click("确认注销");
    await act(async () => root?.unmount());
    root = null;
    await act(async () => answer({ status: 200, body: deleted }));
    expect(props.onDeleted).toHaveBeenCalledWith(viewer);
    expect(props.onFinished).not.toHaveBeenCalled();
  });

  it("states a refusal for an unavailable proof channel instead of an unknown result", async () => {
    requestAccountDeletion.mockResolvedValue({
      status: 503,
      body: refusal("AUTH_CHANNEL_UNAVAILABLE"),
    });
    await render();
    await reachFinal();
    await click("确认注销");
    expect(alert()).toBe("当前无法通过验证码确认身份，暂时不能注销。");
    expect(hasButton("重试注销")).toBe(false);
    expect(props.onDeleted).not.toHaveBeenCalled();
  });

  it("keeps the key and changes nothing on a rate-limited answer", async () => {
    requestAccountDeletion
      .mockResolvedValueOnce({
        status: 409,
        body: refusal("AUTH_RATE_LIMITED"),
      })
      .mockResolvedValueOnce({ status: 200, body: deleted });
    await render();
    await reachFinal();
    await click("确认注销");
    // Refused before it ran, but another device may have deleted meanwhile.
    expect(alert()).toBe("操作过于频繁，这次请求没有处理，请稍后重试。");
    await click("确认注销");
    expect(step()).toBe("done");
    const keys = requestAccountDeletion.mock.calls.map(
      ([, request]) => (request as { idempotencyKey: string }).idempotencyKey,
    );
    expect(keys[0]).toBe(keys[1]);
  });

  it("holds cancel and navigation while the deletion request runs", async () => {
    let answer: (value: { status: number; body: unknown }) => void = () => {};
    requestAccountDeletion.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    await render();
    await reachFinal();
    await click("确认注销");
    expect(props.onBusyChange).toHaveBeenLastCalledWith(true);
    expect(button("取消").disabled).toBe(true);
    expect(button("正在注销").disabled).toBe(true);
    await act(async () => answer({ status: 200, body: deleted }));
    expect(step()).toBe("done");
    expect(props.onBusyChange).toHaveBeenLastCalledWith(true);
  });

  it("never calls the account intact on a first AUTH_UNAUTHENTICATED, which also answers an account deleted elsewhere", async () => {
    requestAccountDeletion.mockResolvedValue({
      status: 401,
      body: refusal("AUTH_UNAUTHENTICATED"),
    });
    await render();
    await reachFinal();
    await click("确认注销");
    expect(alert()).toContain("如果已在其他设备或页面完成注销，账号已经注销");
    expect(alert()).not.toContain("账号没有被注销");
    expect(props.onDeleted).not.toHaveBeenCalled();
  });

  it.each([
    ["the answer was lost", () => Promise.reject(new TypeError("offline"))],
    [
      "the relay could not use the Backend's answer",
      async () => ({ status: 502, body: null }),
    ],
    [
      "the answer was cut off",
      async () => ({ status: 200, body: { outcome: "deleted" } }),
    ],
  ])(
    "after an unanswered attempt (%s), a refused Session is shown as possibly deleted and the account's data is forgotten",
    async (_label, first) => {
      requestAccountDeletion
        .mockImplementationOnce(first)
        .mockResolvedValueOnce({
          status: 401,
          body: refusal("AUTH_UNAUTHENTICATED"),
        });
      await render();
      await reachFinal();
      await click("确认注销");
      expect(alert()).toContain("注销结果尚未确认");
      expect(props.onDeleted).not.toHaveBeenCalled();
      await click("重试注销");
      expect(alert()).toContain("注销可能已经完成");
      expect(alert()).toContain("请刷新页面确认账号状态");
      expect(alert()).not.toContain("账号没有被注销");
      expect(props.onDeleted).toHaveBeenCalledOnce();
      expect(props.onDeleted).toHaveBeenCalledWith(viewer);
      // Nothing more can be sent from here; the page and its hold remain
      // until it is left.
      expect(button("重试注销").disabled).toBe(true);
      expect(step()).toBe("final");
      expect(props.onPendingChange).toHaveBeenLastCalledWith(true);
      expect(button("取消").disabled).toBe(false);
      const keys = requestAccountDeletion.mock.calls.map(
        ([, request]) => (request as { idempotencyKey: string }).idempotencyKey,
      );
      expect(new Set(keys).size).toBe(1);
    },
  );

  it("keeps the retry promise when a retry after an unanswered attempt is rate limited", async () => {
    requestAccountDeletion
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce({
        status: 429,
        body: refusal("AUTH_RATE_LIMITED"),
      })
      .mockResolvedValueOnce({ status: 200, body: deleted });
    await render();
    await reachFinal();
    await click("确认注销");
    await click("重试注销");
    expect(alert()).toBe("操作过于频繁，请稍后重试；重试不会重复注销。");
    await click("重试注销");
    expect(step()).toBe("done");
    expect(props.onDeleted).toHaveBeenCalledOnce();
    const keys = requestAccountDeletion.mock.calls.map(
      ([, request]) => (request as { idempotencyKey: string }).idempotencyKey,
    );
    expect(new Set(keys).size).toBe(1);
  });

  it("reports a pending outcome from the first final request until a new proof starts", async () => {
    serve({
      challenges: {
        status: 200,
        body: { ...challenge, resendAvailableAt: new Date(0).toISOString() },
      },
    });
    requestAccountDeletion
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce({
        status: 400,
        body: refusal("AUTH_PROOF_REJECTED"),
      })
      .mockResolvedValueOnce({ status: 200, body: deleted });
    await render();
    await reachFinal();
    expect(props.onPendingChange).not.toHaveBeenCalled();
    await click("确认注销");
    expect(props.onPendingChange.mock.calls).toEqual([[true]]);
    // The replay found no deletion: this refusal proves nothing ran.
    await click("重试注销");
    expect(alert()).toBe("这次验证已失效，请重新验证。账号没有被注销。");
    expect(props.onPendingChange.mock.calls).toEqual([[true]]);
    await click("重新验证");
    expect(props.onPendingChange.mock.calls).toEqual([[true], [false]]);
    await click(/发送验证码到手机号/u);
    await type("123456");
    await click("验证");
    await click("确认注销");
    expect(step()).toBe("done");
    expect(props.onPendingChange).toHaveBeenLastCalledWith(true);
    await act(async () => root?.unmount());
    root = null;
    expect(props.onPendingChange).toHaveBeenLastCalledWith(false);
  });

  it("states no outcome for a final refusal that proves nothing and asks for a new key", async () => {
    requestAccountDeletion
      .mockResolvedValueOnce({ status: 422, body: null })
      .mockResolvedValueOnce({ status: 200, body: deleted });
    await render();
    await reachFinal();
    await click("确认注销");
    expect(alert()).toBe("请求失败，请稍后重试。");
    await click("确认注销");
    expect(step()).toBe("done");
    const [first, second] = requestAccountDeletion.mock.calls.map(
      ([, request]) => (request as { idempotencyKey: string }).idempotencyKey,
    );
    expect(first).not.toBe(second);
  });

  it("keeps the unanswered attempt's key when a later refusal proves nothing", async () => {
    requestAccountDeletion
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce({ status: 422, body: null })
      .mockResolvedValueOnce({ status: 200, body: deleted });
    await render();
    await reachFinal();
    await click("确认注销");
    await click("重试注销");
    expect(alert()).toContain("注销结果尚未确认");
    expect(alert()).not.toContain("账号没有被注销");
    await click("重试注销");
    expect(step()).toBe("done");
    const keys = requestAccountDeletion.mock.calls.map(
      ([, request]) => (request as { idempotencyKey: string }).idempotencyKey,
    );
    expect(new Set(keys).size).toBe(1);
  });

  describe("leaving after an unconfirmed attempt", () => {
    const question = () => node.querySelector('[role="alertdialog"]');
    const unconfirmed = async () => {
      requestAccountDeletion.mockRejectedValue(new TypeError("offline"));
      await render();
      await reachFinal();
      expect(handle.current?.requestLeave()).toBe(false);
      await click("确认注销");
      expect(alert()).toContain("注销结果尚未确认");
    };

    it("asks before 取消 and keeps the page by default", async () => {
      await unconfirmed();
      await click("取消");
      expect(props.onCancel).not.toHaveBeenCalled();
      expect(question()?.getAttribute("aria-labelledby")).toBeTruthy();
      expect(question()?.textContent).toContain("注销可能已经完成");
      expect(question()?.textContent).toContain(
        "这台设备上为该账号保存的草稿恢复、浏览记录等数据会保留",
      );
      // The safe choice has focus; the retry and 取消 wait behind the question.
      expect(document.activeElement?.textContent).toBe("留下重试");
      expect(hasButton("重试注销")).toBe(false);
      await click("留下重试");
      expect(question()).toBeNull();
      expect(document.activeElement).toBe(button("重试注销"));
      expect(props.onCancel).not.toHaveBeenCalled();
      await click("取消");
      await click("仍然离开");
      expect(props.onCancel).toHaveBeenCalledOnce();
      // The answer stands: the dialog's own Back is not asked again.
      expect(handle.current?.requestLeave()).toBe(false);
    });

    it("answers the dialog's Back and dismissal with the question", async () => {
      await unconfirmed();
      let kept = false;
      await act(async () => {
        kept = handle.current?.requestLeave() ?? false;
      });
      expect(kept).toBe(true);
      expect(question()).not.toBeNull();
      // Escape answers the question only: 留下重试.
      const escape = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      await act(async () => {
        document.activeElement?.dispatchEvent(escape);
      });
      expect(escape.defaultPrevented).toBe(true);
      expect(question()).toBeNull();
      expect(props.onCancel).not.toHaveBeenCalled();
      // Reloading or closing the tab would also drop the retry.
      const unload = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(unload);
      expect(unload.defaultPrevented).toBe(true);
    });

    it("asks nothing once the outcome is settled or the cleanup ran", async () => {
      requestAccountDeletion
        .mockRejectedValueOnce(new TypeError("offline"))
        .mockResolvedValueOnce({
          status: 401,
          body: refusal("AUTH_UNAUTHENTICATED"),
        });
      await render();
      await reachFinal();
      await click("确认注销");
      await click("重试注销");
      expect(alert()).toContain("注销可能已经完成");
      expect(props.onDeleted).toHaveBeenCalledOnce();
      expect(handle.current?.requestLeave()).toBe(false);
      const unload = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(unload);
      expect(unload.defaultPrevented).toBe(false);
      await click("取消");
      expect(question()).toBeNull();
      expect(props.onCancel).toHaveBeenCalledOnce();
    });
  });
});
