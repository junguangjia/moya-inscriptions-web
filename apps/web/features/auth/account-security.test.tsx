// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./auth-api", () => ({
  authRequest: vi.fn(),
}));

import { authRequest } from "./auth-api";
import { AccountSecurity } from "./account-security";
import type { AuthAccountView } from "./auth-api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const request = vi.mocked(authRequest);

const account = {
  userId: "user-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  email: {
    channel: "email" as const,
    state: "verified" as const,
    masked: "a***@example.com",
    version: 1,
    usable: true,
  },
  phone: {
    channel: "phone" as const,
    state: "unbound" as const,
    masked: null,
    version: 0,
    usable: false,
  },
  capabilities: {
    profile: "full-local" as const,
    email: { available: true, reason: null },
    phone: { available: true, reason: null },
    developmentOnly: true,
  },
};

const challenge = {
  challengeId: "challenge-0123456789abcdef0123456789abcdef",
  continuationToken: "a".repeat(43),
  maskedTarget: "a***@example.com",
};

const linkedAccount: AuthAccountView = {
  ...account,
  phone: {
    channel: "phone",
    state: "verified",
    masked: "138****8000",
    version: 4,
    usable: true,
  },
};

const setValue = (element: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
};

describe("AccountSecurity", () => {
  let container: HTMLDivElement;
  afterEach(() => {
    container.remove();
    request.mockReset();
  });

  it("binds a phone to the current account instead of registering", async () => {
    const purposes: unknown[] = [];
    request.mockImplementation(async (path, init) => {
      const body = init?.body as { purpose?: string } | undefined;
      if (body?.purpose !== undefined) purposes.push(body.purpose);
      if (path === "account") return { status: 200, body: account };
      if (path === "challenges" && body?.purpose === "reauthenticate")
        return { status: 200, body: challenge };
      if (path === "challenges/verify")
        return {
          status: 200,
          body: { outcome: "reauthenticated", reauthToken: "b".repeat(43) },
        };
      if (path === "challenges" && body?.purpose === "link")
        return {
          status: 200,
          body: { ...challenge, maskedTarget: "138****8000" },
        };
      if (path === "factors/complete")
        return {
          status: 200,
          body: {
            outcome: "updated",
            account: {
              ...account,
              phone: {
                channel: "phone",
                state: "verified",
                masked: "138****8000",
                version: 1,
                usable: true,
              },
            },
          },
        };
      return {
        status: 500,
        body: { error: { message: "AUTH_PROOF_REJECTED" } },
      };
    });
    container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<AccountSecurity />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    const bind = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "绑定",
    );
    expect(container.querySelector("a[href^='/login']")).toBeNull();
    await act(async () => {
      bind?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    const proof = container.querySelector(
      "input[autocomplete='one-time-code']",
    ) as HTMLInputElement;
    await act(async () => {
      setValue(proof, "123456");
    });
    const continueProof = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "继续",
    );
    await act(async () => {
      continueProof?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    const phone = container.querySelector(
      "input[autocomplete='tel']",
    ) as HTMLInputElement;
    await act(async () => {
      setValue(phone, "13800138000");
    });
    const send = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "发送验证码",
    );
    await act(async () => {
      send?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    const factor = container.querySelector(
      "input[autocomplete='one-time-code']",
    ) as HTMLInputElement;
    await act(async () => {
      setValue(factor, "654321");
    });
    const finish = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "继续",
    );
    await act(async () => {
      finish?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(purposes).toEqual(["reauthenticate", "link"]);
    expect(request.mock.calls.some(([path]) => path === "registrations")).toBe(
      false,
    );
    expect(container.textContent).toContain(
      "user-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" === account.userId
        ? "138****8000"
        : "",
    );
    expect(container.textContent).toContain("已验证");
    root.unmount();
  });

  it("shows last-factor protection without creating an account", async () => {
    request.mockImplementation(async (path, init) => {
      const body = init?.body as { purpose?: string } | undefined;
      if (path === "account")
        return {
          status: 200,
          body: {
            ...account,
            phone: {
              ...account.phone,
              state: "unavailable",
            },
            capabilities: {
              ...account.capabilities,
              phone: { available: false, reason: "off" },
            },
          },
        };
      if (path === "challenges" && body?.purpose === "reauthenticate")
        return { status: 200, body: challenge };
      if (path === "challenges/verify")
        return {
          status: 200,
          body: { outcome: "reauthenticated", reauthToken: "b".repeat(43) },
        };
      if (path === "factors/unlink")
        return {
          status: 409,
          body: { error: { message: "AUTH_LAST_FACTOR" } },
        };
      return {
        status: 500,
        body: { error: { message: "AUTH_PROOF_REJECTED" } },
      };
    });
    container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<AccountSecurity />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    const unlink = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "解除",
    );
    await act(async () => {
      unlink?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    const proof = container.querySelector(
      "input[autocomplete='one-time-code']",
    ) as HTMLInputElement;
    await act(async () => {
      setValue(proof, "123456");
    });
    const continueProof = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "继续",
    );
    await act(async () => {
      continueProof?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.textContent).toContain("至少需要保留一种可用的登录方式");
    expect(request.mock.calls.some(([path]) => path === "registrations")).toBe(
      false,
    );
    expect(
      request.mock.calls.some(([, init]) => {
        const body = init?.body as { purpose?: string } | undefined;
        return body?.purpose === "register" || body?.purpose === "sign_in";
      }),
    ).toBe(false);
    root.unmount();
  });

  // A phone on the Development LAN origin (plain HTTP) is not a secure
  // context, so crypto.randomUUID does not exist there.
  it("starts binding on a plain-HTTP LAN origin, where crypto.randomUUID does not exist", async () => {
    request.mockImplementation(async (path, init) => {
      const body = init?.body as { purpose?: string } | undefined;
      if (path === "account") return { status: 200, body: account };
      if (path === "challenges" && body?.purpose === "reauthenticate")
        return { status: 200, body: challenge };
      return {
        status: 500,
        body: { error: { message: "AUTH_PROOF_REJECTED" } },
      };
    });
    Object.defineProperty(crypto, "randomUUID", {
      configurable: true,
      value: undefined,
    });
    try {
      container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      await act(async () => {
        root.render(<AccountSecurity />);
      });
      await act(async () => {
        await Promise.resolve();
      });
      const bind = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "绑定",
      );
      await act(async () => {
        bind?.click();
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(
        container.querySelector("input[autocomplete='one-time-code']"),
      ).not.toBeNull();
      const sent = request.mock.calls.find(
        ([path, init]) =>
          path === "challenges" &&
          (init?.body as { purpose?: string } | undefined)?.purpose ===
            "reauthenticate",
      );
      expect(
        (sent?.[1]?.body as { idempotencyKey?: string } | undefined)
          ?.idempotencyKey,
      ).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
      root.unmount();
    } finally {
      delete (crypto as { randomUUID?: unknown }).randomUUID;
    }
  });
});

const deferredResult = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const authButton = (node: HTMLElement, label: string) => {
  const button = [...node.querySelectorAll("button")].find(
    (item) => item.textContent === label,
  );
  if (!button) throw Error(`Missing ${label}`);
  return button;
};

describe("phone and email rebinding", () => {
  let node: HTMLDivElement, root: ReturnType<typeof createRoot> | null;
  let current: AuthAccountView;
  let failure: string | null;
  const mount = async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
    current = structuredClone(linkedAccount);
    failure = null;
    request.mockImplementation(async (path, init) => {
      const body = init?.body as Record<string, unknown> | undefined;
      if (path === "account") return { status: 200, body: current };
      if (path === "challenges")
        return {
          status: 200,
          body: {
            ...challenge,
            maskedTarget:
              body?.purpose === "replace"
                ? "new***@example.com"
                : current[body?.channel as "email" | "phone"].masked,
            resendAvailableAt: new Date(Date.now() + 7000).toISOString(),
          },
        };
      if (path === "challenges/verify")
        return {
          status: 200,
          body: { outcome: "reauthenticated", reauthToken: "b".repeat(43) },
        };
      if (path === "factors/complete" && failure)
        return { status: 409, body: { error: { message: failure } } };
      return { status: 503, body: null };
    });
    node = document.createElement("div");
    document.body.append(node);
    root = createRoot(node);
    await act(async () =>
      root!.render(<AccountSecurity expectedViewerId={account.userId} />),
    );
  };
  const click = async (label: string) =>
    act(async () => authButton(node, label).click());
  const begin = async (channel: "email" | "phone") =>
    act(async () => {
      node
        .querySelector<HTMLButtonElement>(
          `[data-settings-focus-key="auth-replace-${channel}"]`,
        )!
        .click();
    });
  const fill = async (value: string) =>
    act(async () => setValue(node.querySelector("input")!, value));
  const throughNewContact = async (channel: "email" | "phone" = "email") => {
    await begin(channel);
    await fill("123456");
    await click("验证并继续");
    await fill(channel === "email" ? "new@example.com" : "13900139000");
    await click("发送验证码");
    await fill("654321");
  };
  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    node?.remove();
    request.mockReset();
    vi.useRealTimers();
  });

  it.each(["email", "phone"] as const)(
    "verifies the old %s before the new contact and confirms only after the server",
    async (channel) => {
      await mount();
      const pending = deferredResult<{ status: number; body: unknown }>();
      const original = request.getMockImplementation()!;
      request.mockImplementation((path, init) =>
        path === "factors/complete" ? pending.promise : original(path, init),
      );
      await throughNewContact(channel);
      const commands = request.mock.calls.filter(
        ([path]) => path === "challenges",
      );
      expect(
        commands.map(
          ([, init]) => init?.body as { channel: string; purpose: string },
        ),
      ).toEqual([
        expect.objectContaining({ channel, purpose: "reauthenticate" }),
        expect.objectContaining({ channel, purpose: "replace" }),
      ]);
      expect(
        node.querySelector('[aria-current="step"]')?.textContent,
      ).toContain("确认绑定");
      expect(
        request.mock.calls.some(([path]) => path === "factors/complete"),
      ).toBe(false);
      const confirm = authButton(node, "确认换绑");
      await act(async () => {
        confirm.click();
        confirm.click();
      });
      expect(
        request.mock.calls.filter(([path]) => path === "factors/complete"),
      ).toHaveLength(1);
      expect(request).toHaveBeenLastCalledWith(
        "factors/complete",
        expect.objectContaining({
          body: expect.objectContaining({
            expectedVersion: linkedAccount[channel].version,
          }),
        }),
      );
      expect(node.textContent).not.toContain("换绑成功");
      expect(authButton(node, "取消").disabled).toBe(true);
      const masked = channel === "email" ? "new***@example.com" : "139****9000";
      await act(async () =>
        pending.resolve({
          status: 200,
          body: {
            account: {
              ...linkedAccount,
              [channel]: {
                ...linkedAccount[channel],
                masked,
                version: linkedAccount[channel].version + 1,
              },
            },
          },
        }),
      );
      expect(node.querySelector('[role="status"]')?.textContent).toContain(
        "换绑成功",
      );
      expect(node.textContent).toContain(masked);
      expect(node.querySelector("input")).toBeNull();
      expect(
        request.mock.calls.some(([path]) =>
          ["registrations", "sign-in", "sign-out"].includes(path),
        ),
      ).toBe(false);
    },
  );

  it("uses the server resend deadline and preserves it across cancel and reopen", async () => {
    await mount();
    await begin("email");
    expect(authButton(node, "7 秒后重新获取").disabled).toBe(true);
    await click("7 秒后重新获取");
    await click("取消");
    await begin("email");
    expect(node.textContent).not.toContain("验证码已发往");
    expect(
      request.mock.calls.filter(([path]) => path === "challenges"),
    ).toHaveLength(1);
    await act(async () => vi.advanceTimersByTime(7000));
    await click("重新获取验证码");
    expect(
      request.mock.calls.filter(([path]) => path === "challenges"),
    ).toHaveLength(2);
    expect(authButton(node, "7 秒后重新获取").disabled).toBe(true);
  });

  it.each(["AUTH_PROOF_REJECTED", "AUTH_STALE_VERSION"])(
    "offers a fresh account read after %s without claiming success",
    async (reason) => {
      await mount();
      await throughNewContact();
      failure = reason;
      await click("确认换绑");
      expect(node.querySelector('[role="alert"]')).not.toBeNull();
      expect(node.textContent).not.toContain("换绑成功");
      expect(authButton(node, "确认换绑").disabled).toBe(true);
      await click("返回并重新验证");
      expect(
        request.mock.calls.filter(([path]) => path === "account"),
      ).toHaveLength(2);
      expect(node.textContent).toContain(linkedAccount.email.masked!);
      expect(node.querySelector("input")).toBeNull();
    },
  );

  it("keeps the original binding on conflict and permits editing the new contact", async () => {
    await mount();
    await throughNewContact();
    failure = "AUTH_IDENTIFIER_CONFLICT";
    await click("确认换绑");
    expect(node.textContent).toContain("这个联系方式无法绑定");
    await click("修改邮箱");
    expect(node.querySelector<HTMLInputElement>("input")?.value).toBe(
      "new@example.com",
    );
    await fill("corrected@example.com");
    expect(authButton(node, "7 秒后可发送").disabled).toBe(true);
    await act(async () => vi.advanceTimersByTime(7000));
    await click("发送验证码");
    expect(request).toHaveBeenLastCalledWith(
      "challenges",
      expect.objectContaining({
        body: expect.objectContaining({
          purpose: "replace",
          identifier: "corrected@example.com",
        }),
      }),
    );
    expect(
      request.mock.calls.filter(([path]) => path === "challenges/verify"),
    ).toHaveLength(1);
    expect(node.querySelector<HTMLInputElement>("input")?.value).toBe("");
    await click("取消");
    expect(node.textContent).toContain(linkedAccount.email.masked!);
    expect(node.textContent).not.toContain("换绑成功");
  });

  it("blocks another replacement until a stale account refresh finishes", async () => {
    await mount();
    await throughNewContact();
    failure = "AUTH_STALE_VERSION";
    await click("确认换绑");
    const refreshed = deferredResult<{ status: number; body: unknown }>();
    const original = request.getMockImplementation()!;
    request.mockImplementation((path, init) =>
      path === "account" ? refreshed.promise : original(path, init),
    );
    await click("返回并重新验证");
    expect(
      node.querySelector('[data-settings-focus-key="auth-replace-email"]'),
    ).toBeNull();
    expect(node.textContent).toContain("正在读取登录方式");
    await act(async () =>
      refreshed.resolve({
        status: 200,
        body: { ...current, email: { ...current.email, version: 9 } },
      }),
    );
    await act(async () => vi.advanceTimersByTime(7000));
    await throughNewContact();
    await click("确认换绑");
    expect(request).toHaveBeenLastCalledWith(
      "factors/complete",
      expect.objectContaining({
        body: expect.objectContaining({ expectedVersion: 9 }),
      }),
    );
  });

  it("ignores late successful completion after the viewer changes", async () => {
    await mount();
    await throughNewContact();
    const pending = deferredResult<{ status: number; body: unknown }>();
    const original = request.getMockImplementation()!;
    request.mockImplementation((path, init) =>
      path === "factors/complete" ? pending.promise : original(path, init),
    );
    await click("确认换绑");
    current = {
      ...current,
      userId: "user-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      email: { ...current.email, masked: "other***@example.com" },
    };
    await act(async () =>
      root!.render(<AccountSecurity expectedViewerId={current.userId} />),
    );
    await act(async () =>
      pending.resolve({ status: 200, body: { account: linkedAccount } }),
    );
    expect(node.textContent).toContain("other***@example.com");
    expect(node.textContent).not.toContain("换绑成功");
    expect(node.textContent).not.toContain(linkedAccount.email.masked!);
    expect(node.querySelector("input")).toBeNull();
  });

  it("does not substitute the other factor when the old target cannot be verified", async () => {
    await mount();
    current = { ...current, email: { ...current.email, usable: false } };
    await act(async () => root!.unmount());
    root = createRoot(node);
    await act(async () =>
      root!.render(<AccountSecurity expectedViewerId={account.userId} />),
    );
    await begin("email");
    expect(node.textContent).toContain("原邮箱当前无法验证");
    expect(request.mock.calls.some(([path]) => path === "challenges")).toBe(
      false,
    );
  });

  it("reports rate limits without pretending a code was sent", async () => {
    await mount();
    request.mockResolvedValue({
      status: 429,
      body: { error: { message: "AUTH_RATE_LIMITED" } },
    });
    await begin("phone");
    expect(node.querySelector('[role="alert"]')?.textContent).toContain(
      "操作过于频繁",
    );
    expect(node.textContent).not.toContain("验证码已发往");
    expect(authButton(node, "验证并继续").disabled).toBe(true);
  });
});

describe("AccountSecurity request and host boundaries", () => {
  let node: HTMLDivElement, root: ReturnType<typeof createRoot> | null;
  const busy = vi.fn(),
    flow = vi.fn();
  const mount = async (viewer = account.userId) => {
    node = document.createElement("div");
    document.body.append(node);
    root = createRoot(node);
    await act(async () =>
      root!.render(
        <AccountSecurity
          expectedViewerId={viewer}
          onBusyChange={busy}
          onFlowChange={flow}
        />,
      ),
    );
  };
  const click = async (label: string) =>
    act(async () => authButton(node, label).click());
  const proofCode = async () =>
    act(async () =>
      setValue(
        node.querySelector<HTMLInputElement>(
          "input[autocomplete='one-time-code']",
        )!,
        "123456",
      ),
    );
  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    node?.remove();
    request.mockReset();
    busy.mockClear();
    flow.mockClear();
  });
  it("reports the synchronous gate before sending and refuses duplicate starts", async () => {
    const pending = deferredResult<{ status: number; body: unknown }>();
    request.mockImplementation(async (path) => {
      if (path === "account") return { status: 200, body: account };
      expect(busy).toHaveBeenLastCalledWith(true);
      return pending.promise;
    });
    await mount();
    const bind = authButton(node, "绑定");
    await act(async () => {
      bind.click();
      bind.click();
    });
    expect(
      request.mock.calls.filter(([path]) => path === "challenges"),
    ).toHaveLength(1);
    expect(flow).toHaveBeenCalledWith("绑定手机号");
    expect(node.textContent).not.toContain("验证码已发往");
    await act(async () => pending.resolve({ status: 200, body: challenge }));
    expect(busy).toHaveBeenLastCalledWith(false);
  });
  it("keeps proof and unlink inside one busy interval and prevents cancellation", async () => {
    const pending = deferredResult<{ status: number; body: unknown }>();
    request.mockImplementation(async (path) =>
      path === "account"
        ? { status: 200, body: account }
        : path === "challenges"
          ? { status: 200, body: challenge }
          : path === "challenges/verify"
            ? {
                status: 200,
                body: {
                  outcome: "reauthenticated",
                  reauthToken: "b".repeat(43),
                },
              }
            : pending.promise,
    );
    await mount();
    await click("解除");
    await proofCode();
    busy.mockClear();
    await click("继续");
    expect(request).toHaveBeenLastCalledWith(
      "factors/unlink",
      expect.anything(),
    );
    expect(busy.mock.calls).toEqual([[true]]);
    expect(authButton(node, "取消").disabled).toBe(true);
    await act(async () =>
      pending.resolve({
        status: 409,
        body: { error: { message: "AUTH_LAST_FACTOR" } },
      }),
    );
    expect(busy).toHaveBeenLastCalledWith(false);
    expect(node.querySelector("[role=alert]")?.textContent).toContain(
      "至少需要保留",
    );
  });
  it("recovers from network failure without hiding the error or holding the gate", async () => {
    request.mockImplementation(async (path) => {
      if (path === "account") return { status: 200, body: account };
      throw Error("synthetic network failure");
    });
    await mount();
    await click("绑定");
    expect(node.querySelector("[role=alert]")?.textContent).toContain(
      "网络暂时不可用",
    );
    expect(busy).toHaveBeenLastCalledWith(false);
    expect(node.textContent).not.toContain("验证码已发往");
    await click("取消");
    expect(flow).toHaveBeenLastCalledWith(null);
    expect(node.querySelector("input")).toBeNull();
    expect(authButton(node, "绑定").disabled).toBe(false);
  });
  it("makes unavailable challenge failures visible and supports an explicit retry", async () => {
    let attempts = 0;
    request.mockImplementation(async (path) =>
      path === "account"
        ? { status: 200, body: account }
        : ++attempts === 1
          ? {
              status: 503,
              body: { error: { message: "AUTH_CHANNEL_UNAVAILABLE" } },
            }
          : { status: 200, body: challenge },
    );
    await mount();
    await click("绑定");
    expect(node.querySelector("[role=alert]")?.textContent).toContain(
      "这个登录方式当前不可用",
    );
    expect(node.textContent).not.toContain("验证码已发往");
    await click("重新获取验证码");
    expect(node.querySelector("[role=alert]")).toBeNull();
    expect(node.textContent).toContain("验证码已发往");
    expect(attempts).toBe(2);
  });
  it("never reports successful sign-out after a failed or duplicate request", async () => {
    const pending = deferredResult<{ status: number; body: unknown }>();
    request.mockImplementation(async (path) =>
      path === "account" ? { status: 200, body: account } : pending.promise,
    );
    await mount();
    const signOut = authButton(node, "退出登录");
    await act(async () => {
      signOut.click();
      signOut.click();
    });
    expect(
      request.mock.calls.filter(([path]) => path === "sign-out"),
    ).toHaveLength(1);
    await act(async () => pending.resolve({ status: 503, body: null }));
    expect(node.querySelector("[role=alert]")?.textContent).toContain(
      "退出未能确认",
    );
    expect(authButton(node, "退出登录").disabled).toBe(false);
  });
  it("asks the host before sign-out and reports confirmation only after success", async () => {
    const guard = vi.fn(() => false),
      confirmed = vi.fn();
    const pending = deferredResult<{ status: number; body: unknown }>();
    request.mockImplementation(async (path) =>
      path === "account" ? { status: 200, body: account } : pending.promise,
    );
    await mount();
    await act(async () =>
      root!.render(
        <AccountSecurity
          expectedViewerId={account.userId}
          guardSignOut={guard}
          onSignedOut={confirmed}
        />,
      ),
    );
    await click("退出登录");
    expect(request.mock.calls.some(([path]) => path === "sign-out")).toBe(
      false,
    );
    guard.mockReturnValue(true);
    await click("退出登录");
    expect(confirmed).not.toHaveBeenCalled();
    await act(async () => pending.resolve({ status: 204, body: null }));
    expect(confirmed).toHaveBeenCalledOnce();
  });
  it("does not continue proof -> unlink after the expected account changes", async () => {
    const pending = deferredResult<{ status: number; body: unknown }>();
    const other = "user-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    request.mockImplementation(async (path) =>
      path === "account"
        ? {
            status: 200,
            body:
              request.mock.calls.filter(([name]) => name === "account").length >
              1
                ? {
                    ...account,
                    userId: other,
                    email: { ...account.email, masked: "b***@example.com" },
                  }
                : account,
          }
        : path === "challenges"
          ? { status: 200, body: challenge }
          : pending.promise,
    );
    await mount();
    await click("解除");
    await proofCode();
    await click("继续");
    await act(async () =>
      root!.render(
        <AccountSecurity
          expectedViewerId={other}
          onBusyChange={busy}
          onFlowChange={flow}
        />,
      ),
    );
    const events = busy.mock.calls.length;
    await act(async () =>
      pending.resolve({
        status: 200,
        body: { outcome: "reauthenticated", reauthToken: "b".repeat(43) },
      }),
    );
    expect(request.mock.calls.some(([path]) => path === "factors/unlink")).toBe(
      false,
    );
    expect(busy.mock.calls).toHaveLength(events);
    expect(node.textContent).toContain("b***@example.com");
    expect(node.textContent).not.toContain("a***@example.com");
  });
  it("rejects account data belonging to a different viewer", async () => {
    request.mockResolvedValue({ status: 200, body: account });
    await mount("user-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(node.textContent).not.toContain("a***@example.com");
    expect(node.textContent).toContain("当前没有可用会话");
    await click("退出登录");
    expect(request.mock.calls.some(([path]) => path === "sign-out")).toBe(
      false,
    );
  });
  it("ignores late proof results after unmount and makes no following mutation", async () => {
    const pending = deferredResult<{ status: number; body: unknown }>();
    request.mockImplementation(async (path) =>
      path === "account"
        ? { status: 200, body: account }
        : path === "challenges"
          ? { status: 200, body: challenge }
          : pending.promise,
    );
    await mount();
    await click("解除");
    await proofCode();
    await click("继续");
    await act(async () => root!.unmount());
    root = null;
    const events = busy.mock.calls.length;
    await act(async () =>
      pending.resolve({
        status: 200,
        body: { outcome: "reauthenticated", reauthToken: "b".repeat(43) },
      }),
    );
    expect(request.mock.calls.some(([path]) => path === "factors/unlink")).toBe(
      false,
    );
    expect(busy.mock.calls).toHaveLength(events);
  });
});
