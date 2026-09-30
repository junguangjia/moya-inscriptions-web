// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./auth-api", () => ({
  authRequest: vi.fn(),
}));

import { authRequest } from "./auth-api";
import { AccountSecurity } from "./account-security";

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
    await click("重新获取验证码");
    expect(node.querySelector("[role=alert]")).toBeNull();
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
