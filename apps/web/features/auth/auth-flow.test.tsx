// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./auth-api", async (importOriginal) => {
  const original = await importOriginal<typeof import("./auth-api")>();
  return { ...original, authRequest: request };
});

import { AuthFlow } from "./auth-flow";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type Props = Parameters<typeof AuthFlow>[0];
type Response = { status: number; body: unknown };

// All addresses, codes and proof strings below are synthetic mock fixtures.
// No delivery provider, Session cookie or real credential is used by this suite.
const syntheticCode = "123456";
const syntheticProof = "s".repeat(43);
const syntheticHandoff = "h".repeat(43);
const challengeId = `challenge-${"0".repeat(32)}`;
const accepted = (overrides: Record<string, unknown> = {}): Response => ({
  status: 200,
  body: {
    challengeId,
    maskedTarget: "t***@example.com",
    resendAvailableAt: new Date(Date.now() - 1_000).toISOString(),
    continuationToken: syntheticProof,
    ...overrides,
  },
});
const capabilities = (phone = false, email = true): Response => ({
  status: 200,
  body: {
    profile: phone ? "full-local" : "email-first",
    email: { available: email, reason: null },
    phone: { available: phone, reason: null },
    developmentOnly: true,
  },
});
const failure = (reason: string): Response => ({
  status: 409,
  body: { error: { code: "INVALID_INPUT", message: reason } },
});
const syntheticSession = {
  expiresAt: "2099-01-01T00:00:00.000Z",
  profile: {
    id: "user-synthetic-auth-ui",
    handle: "synthetic-auth-ui",
    displayName: "合成测试",
  },
};
const handoff = (): Response => ({
  status: 200,
  body: {
    outcome: "registration_required",
    handoffToken: syntheticHandoff,
    maskedTarget: "t***@example.com",
    channel: "email",
  },
});
const deferred = () => {
  let resolve!: (response: Response) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<Response>((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
};

describe("AuthFlow", () => {
  let container: HTMLDivElement;
  let root: Root;
  let props: Props;
  const onReturn = vi.fn();
  const onModeChange = vi.fn();

  beforeEach(() => {
    request.mockReset();
    onReturn.mockReset();
    onModeChange.mockReset();
    request.mockImplementation(async (path: string): Promise<Response> => {
      if (path === "capabilities") return capabilities();
      if (path === "challenges") return accepted();
      if (path === "challenges/verify")
        return {
          status: 200,
          body: { outcome: "signed_in", session: syntheticSession },
        };
      return { status: 503, body: null };
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    props = {
      mode: "sign-in",
      returnTo: "/?catalog=fixture",
      onReturn,
      onModeChange,
    };
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const render = async (changes: Partial<Props> = {}) => {
    props = { ...props, ...changes };
    await act(async () => root.render(<AuthFlow {...props} />));
  };
  const input = (selector: string): HTMLInputElement => {
    const element = container.querySelector<HTMLInputElement>(selector);
    expect(element).not.toBeNull();
    return element!;
  };
  const setInput = async (element: HTMLInputElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const button = (text: string): HTMLButtonElement => {
    const element = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === text,
    );
    expect(element).toBeDefined();
    return element!;
  };
  const click = async (text: string) => {
    await act(async () => button(text).click());
  };
  const submit = async () => {
    await act(async () =>
      container
        .querySelector("form")
        ?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
  };
  const calls = (path: string) =>
    request.mock.calls.filter(([called]) => called === path);
  const bodies = (path: string) =>
    calls(path).map(([, init]) => init.body as Record<string, unknown>);
  const startCode = async () => {
    await setInput(input("input[type='email']"), "tester@example.com");
    await click("发送验证码");
    expect(
      container.querySelector("main")?.getAttribute("data-auth-step"),
    ).toBe("code");
  };
  const enterCode = async () => {
    await setInput(input("input[autocomplete='one-time-code']"), syntheticCode);
  };
  const startProfile = async () => {
    request.mockImplementation(async (path: string) => {
      if (path === "capabilities") return capabilities();
      if (path === "challenges") return accepted();
      if (path === "challenges/verify") return handoff();
      if (path === "registrations")
        return {
          status: 201,
          body: { outcome: "registered", session: syntheticSession },
        };
      return { status: 503, body: null };
    });
    await render();
    await startCode();
    await enterCode();
    await submit();
  };

  it("starts on email and presents unavailable phone without engineering instructions", async () => {
    await render();
    expect(container.querySelector("h1")?.textContent).toBe("登录");
    expect(container.querySelector("[aria-pressed='true']")?.textContent).toBe(
      "邮箱",
    );
    expect(button("手机").disabled).toBe(true);
    expect(container.textContent).toContain("手机登录当前不可用");
    expect(
      container.querySelector(
        "a[href='/register?return=%2F%3Fcatalog%3Dfixture']",
      ),
    ).not.toBeNull();
    expect(container.textContent).not.toContain("开发测试账号");
    expect(
      container.querySelector("input[autocomplete='one-time-code']"),
    ).toBeNull();
  });

  it("loads capabilities independently of a changed flow mode", async () => {
    const loading = deferred();
    request.mockImplementation(() => loading.promise);
    await render();
    expect(container.querySelector("[role='status']")?.textContent).toContain(
      "正在获取",
    );
    await render({ mode: "register" });
    await act(async () => loading.resolve(capabilities()));
    expect(button("发送验证码").disabled).toBe(false);
    expect(container.querySelector("h1")?.textContent).toBe("注册");
  });

  it("recovers a thrown capability request using an explicit retry", async () => {
    request.mockRejectedValueOnce(new Error("synthetic transport failure"));
    await render();
    expect(button("发送验证码").disabled).toBe(true);
    expect(container.querySelector("[role='alert']")?.textContent).toContain(
      "暂时无法获取登录方式",
    );
    await click("重新获取登录方式");
    expect(button("发送验证码").disabled).toBe(false);
    expect(calls("capabilities")).toHaveLength(2);
  });

  it("does not trust malformed capabilities or silently switch from unavailable email", async () => {
    request.mockResolvedValueOnce({ status: 200, body: { email: null } });
    await render();
    expect(container.textContent).toContain("暂时无法获取登录方式");
    request.mockResolvedValueOnce(capabilities(true, false));
    await click("重新获取登录方式");
    expect(button("邮箱").getAttribute("aria-pressed")).toBe("true");
    expect(button("发送验证码").disabled).toBe(true);
    expect(container.textContent).toContain("邮箱登录当前不可用");
    await click("手机");
    expect(input("input[type='tel']").getAttribute("autocomplete")).toBe(
      "tel-national",
    );
    expect(container.textContent).toContain("目前仅支持中国大陆手机号");
  });

  it("places account-format errors beside the associated input before requesting a code", async () => {
    await render();
    await setInput(input("input[type='email']"), "invalid");
    await click("发送验证码");
    const email = input("input[type='email']");
    expect(email.getAttribute("aria-invalid")).toBe("true");
    expect(
      document.getElementById(
        email.getAttribute("aria-describedby")!.split(" ")[1]!,
      )?.textContent,
    ).toContain("有效的邮箱");
    expect(calls("challenges")).toHaveLength(0);
  });

  it.each([
    ["sign-in", "email", "sign_in"],
    ["register", "email", "register"],
    ["sign-in", "phone", "sign_in"],
    ["register", "phone", "register"],
  ] as const)(
    "sends the existing %s %s purpose",
    async (mode, channel, purpose) => {
      request.mockResolvedValueOnce(capabilities(true));
      await render({ mode });
      if (channel === "phone") {
        await click("手机");
        await setInput(input("input[type='tel']"), "13800000000");
      } else await setInput(input("input[type='email']"), "tester@example.com");
      await click("发送验证码");
      const body = bodies("challenges")[0]!;
      expect(body.purpose).toBe(purpose);
      expect(body.channel).toBe(channel);
      expect(body.identifier).toBe(
        channel === "phone" ? "+8613800000000" : "tester@example.com",
      );
    },
  );

  it("uses one native field for pasted digits and waits for manual keyboard confirmation", async () => {
    await render();
    await startCode();
    const code = input("input[autocomplete='one-time-code']");
    expect(document.activeElement).toBe(code);
    expect(button("登录").disabled).toBe(true);
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: { getData: () => "12 3456" },
    });
    await act(async () => code.dispatchEvent(paste));
    expect(code.value).toBe(syntheticCode);
    expect(
      container.querySelectorAll("input[autocomplete='one-time-code']"),
    ).toHaveLength(1);
    expect(calls("challenges/verify")).toHaveLength(0);
    await submit();
    expect(calls("challenges/verify")).toHaveLength(1);
    expect(onReturn).toHaveBeenCalledWith("/?catalog=fixture");
  });

  it("generates a UUID on a plain-HTTP LAN where crypto.randomUUID is unavailable", async () => {
    const original = Object.getOwnPropertyDescriptor(crypto, "randomUUID");
    Object.defineProperty(crypto, "randomUUID", {
      configurable: true,
      value: undefined,
    });
    try {
      await render();
      await startCode();
      expect(bodies("challenges")[0]!.idempotencyKey).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
    } finally {
      if (original) Object.defineProperty(crypto, "randomUUID", original);
      else delete (crypto as { randomUUID?: unknown }).randomUUID;
    }
  });

  it("keeps the send identity for an explicit network retry and replaces it when the payload changes", async () => {
    await render();
    request.mockRejectedValueOnce(new Error("synthetic transport failure"));
    await setInput(input("input[type='email']"), "tester@example.com");
    await click("发送验证码");
    expect(container.textContent).toContain("尚未确认验证码是否发出");
    expect(
      container.querySelector("main")?.getAttribute("data-auth-step"),
    ).toBe("identifier");
    expect(calls("challenges")).toHaveLength(1);
    request.mockRejectedValueOnce(new Error("synthetic transport failure"));
    await click("发送验证码");
    expect(bodies("challenges")[1]!.idempotencyKey).toBe(
      bodies("challenges")[0]!.idempotencyKey,
    );
    await setInput(input("input[type='email']"), "second@example.com");
    await click("发送验证码");
    expect(bodies("challenges")[2]!.idempotencyKey).not.toBe(
      bodies("challenges")[0]!.idempotencyKey,
    );
  });

  it("does not claim unknown delivery succeeded and gives a later send a new identity", async () => {
    await render();
    request.mockResolvedValueOnce(failure("AUTH_DELIVERY_UNKNOWN"));
    await setInput(input("input[type='email']"), "tester@example.com");
    await click("发送验证码");
    expect(container.textContent).toContain("发送结果暂时无法确认");
    expect(
      container.querySelector("input[autocomplete='one-time-code']"),
    ).toBeNull();
    await click("发送验证码");
    expect(bodies("challenges")[1]!.idempotencyKey).not.toBe(
      bodies("challenges")[0]!.idempotencyKey,
    );
  });

  it("uses only the server resend deadline and never invents a fallback countdown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T00:00:00.000Z"));
    await render();
    request.mockResolvedValueOnce(
      accepted({
        resendAvailableAt: new Date(Date.now() + 40_000).toISOString(),
      }),
    );
    await startCode();
    expect(button("40 秒后可重发").disabled).toBe(true);
    await act(async () => vi.advanceTimersByTime(40_000));
    expect(button("重新发送").disabled).toBe(false);
    await click("修改账号");
    request.mockResolvedValueOnce(accepted({ resendAvailableAt: undefined }));
    await click("发送验证码");
    expect(
      container.querySelector("input[autocomplete='one-time-code']"),
    ).toBeNull();
    expect(container.textContent).not.toContain("60 秒");
  });

  it("does not enter verification without a continuation and honors the returned resend deadline", async () => {
    await render();
    request.mockResolvedValueOnce(
      accepted({
        continuationToken: undefined,
        resendAvailableAt: new Date(Date.now() + 40_000).toISOString(),
      }),
    );
    await setInput(input("input[type='email']"), "tester@example.com");
    await click("发送验证码");
    expect(
      container.querySelector("input[autocomplete='one-time-code']"),
    ).toBeNull();
    expect(container.textContent).toContain("这次发送无法继续验证");
    expect(
      container
        .querySelector("button[type='submit']")
        ?.hasAttribute("disabled"),
    ).toBe(true);
  });

  it("retains a known continuation only when a replay has the same challenge identity", async () => {
    await render();
    await startCode();
    request.mockResolvedValueOnce(accepted({ continuationToken: undefined }));
    await click("重新发送");
    await enterCode();
    await submit();
    expect(bodies("challenges/verify")[0]!.continuationToken).toBe(
      syntheticProof,
    );
  });

  it("refuses a new challenge that omitted its continuation", async () => {
    await render();
    await startCode();
    request.mockResolvedValueOnce(
      accepted({
        challengeId: `challenge-${"1".repeat(32)}`,
        continuationToken: undefined,
      }),
    );
    await click("重新发送");
    expect(
      container.querySelector("input[autocomplete='one-time-code']"),
    ).toBeNull();
    expect(calls("challenges/verify")).toHaveLength(0);
  });

  it("ignores an old send rejection and its finally while a new mode request is pending", async () => {
    await render({ initialEmail: "tester@example.com" });
    const first = deferred();
    request.mockReturnValueOnce(first.promise);
    await click("发送验证码");
    await render({ mode: "register" });
    const second = deferred();
    request.mockReturnValueOnce(second.promise);
    await click("发送验证码");
    await act(async () => first.reject(new Error("synthetic old failure")));
    expect(button("正在发送…").getAttribute("aria-busy")).toBe("true");
    expect(container.textContent).not.toContain("连接中断");
    await act(async () => second.resolve(accepted()));
    expect(
      container.querySelector("main")?.getAttribute("data-auth-step"),
    ).toBe("code");
    expect(bodies("challenges")[1]!.purpose).toBe("register");
  });

  it("prevents duplicate confirmation and page controls while verification is pending", async () => {
    await render();
    await startCode();
    await enterCode();
    const verifying = deferred();
    request.mockReturnValueOnce(verifying.promise);
    await act(async () => {
      button("登录").click();
      button("登录").click();
    });
    expect(calls("challenges/verify")).toHaveLength(1);
    expect(button("修改账号").disabled).toBe(true);
    expect(button("返回原页面").disabled).toBe(true);
    expect(
      container.querySelector("footer a")?.getAttribute("aria-disabled"),
    ).toBe("true");
    await act(async () =>
      verifying.resolve({
        status: 200,
        body: { outcome: "signed_in", session: syntheticSession },
      }),
    );
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it("allows only a manual verification network retry, reusing its identity and proof", async () => {
    await render();
    await startCode();
    await enterCode();
    request.mockRejectedValueOnce(new Error("synthetic transport failure"));
    await submit();
    expect(input("input[autocomplete='one-time-code']").value).toBe(
      syntheticCode,
    );
    expect(calls("challenges/verify")).toHaveLength(1);
    await submit();
    expect(bodies("challenges/verify")[1]!.idempotencyKey).toBe(
      bodies("challenges/verify")[0]!.idempotencyKey,
    );
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it("keeps an invalid code editable and gives a changed code a new operation identity", async () => {
    await render();
    await startCode();
    await enterCode();
    request.mockResolvedValueOnce(failure("AUTH_CODE_INVALID"));
    await submit();
    const code = input("input[autocomplete='one-time-code']");
    expect(code.disabled).toBe(false);
    expect(code.getAttribute("aria-invalid")).toBe("true");
    await setInput(code, "654321");
    await submit();
    expect(bodies("challenges/verify")[1]!.idempotencyKey).not.toBe(
      bodies("challenges/verify")[0]!.idempotencyKey,
    );
  });

  it.each([
    "AUTH_CODE_EXPIRED",
    "AUTH_CODE_SUPERSEDED",
    "AUTH_CODE_EXHAUSTED",
    "AUTH_PROOF_REJECTED",
    "AUTH_PROVENANCE_REJECTED",
  ])(
    "invalidates unusable proof after %s without inventing unlock times",
    async (reason) => {
      await render();
      await startCode();
      await enterCode();
      request.mockResolvedValueOnce(failure(reason));
      await submit();
      const code = input("input[autocomplete='one-time-code']");
      expect(code.value).toBe("");
      expect(code.disabled).toBe(true);
      await submit();
      expect(calls("challenges/verify")).toHaveLength(1);
      await click("重新验证");
      expect(
        container.querySelector("main")?.getAttribute("data-auth-step"),
      ).toBe("identifier");
      expect(input("input[type='email']").value).toBe("tester@example.com");
    },
  );

  it("preserves the proof on an unknown verification result for explicit retry", async () => {
    await render();
    await startCode();
    await enterCode();
    request.mockResolvedValueOnce(failure("AUTH_DELIVERY_UNKNOWN"));
    await submit();
    expect(container.textContent).toContain("验证结果暂时无法确认");
    expect(input("input[autocomplete='one-time-code']").disabled).toBe(false);
    await submit();
    expect(bodies("challenges/verify")[1]!.idempotencyKey).toBe(
      bodies("challenges/verify")[0]!.idempotencyKey,
    );
  });

  it.each(["sign-in", "register"] as const)(
    "requires explicit registration after the %s handoff and preserves progress through the inline agreement",
    async (mode) => {
      props = { ...props, mode };
      await startProfile();
      expect(
        container.querySelector("main")?.getAttribute("data-auth-step"),
      ).toBe("profile");
      expect(container.textContent).toContain("账户尚未创建");
      expect(calls("registrations")).toHaveLength(0);
      await setInput(input("input[autocomplete='nickname']"), "  访碑者  ");
      expect(button("创建账户").disabled).toBe(true);
      await act(async () => input("input[type='checkbox']").click());
      await click("阅读开发环境注册说明");
      expect(
        container.querySelector("main")?.getAttribute("data-auth-step"),
      ).toBe("agreements");
      expect(container.textContent).toContain("不是已批准的用户协议或隐私政策");
      expect(container.textContent).toContain("也不是人脸核验");
      await click("返回填写");
      expect(input("input[autocomplete='nickname']").value).toBe("  访碑者  ");
      expect(input("input[type='checkbox']").checked).toBe(true);
      expect(document.activeElement).toBe(button("阅读开发环境注册说明"));
      await click("创建账户");
      expect(bodies("registrations")[0]!.displayName).toBe("访碑者");
      expect(bodies("registrations")[0]!.agreement).toBe(true);
      expect(onReturn).toHaveBeenCalledTimes(1);
      expect(localStorage.length).toBe(0);
    },
  );

  it("asks an already registered account to go to login and verify again", async () => {
    await render({ mode: "register" });
    await startCode();
    await enterCode();
    request.mockResolvedValueOnce({
      status: 200,
      body: { outcome: "already_registered", channel: "email" },
    });
    await submit();
    expect(container.textContent).toContain("这个账号已经注册");
    expect(onModeChange).not.toHaveBeenCalled();
    expect(onReturn).not.toHaveBeenCalled();
    await click("去登录");
    expect(onModeChange).toHaveBeenCalledWith("sign-in");
    expect(
      container.querySelector("input[autocomplete='one-time-code']"),
    ).toBeNull();
    expect(input("input[type='email']").value).toBe("tester@example.com");
    expect(calls("challenges")).toHaveLength(1);
  });

  it("clears consumed registration proof on profile back and resets the agreement after re-verification", async () => {
    await startProfile();
    await setInput(input("input[autocomplete='nickname']"), "访碑者");
    await act(async () => input("input[type='checkbox']").click());
    await click("返回并重新验证");
    await submit();
    await enterCode();
    await submit();
    expect(input("input[type='checkbox']").checked).toBe(false);
    expect(button("创建账户").disabled).toBe(true);
    expect(calls("registrations")).toHaveLength(0);
  });

  it("rejects malformed verify success and a registration 201 without its registered outcome", async () => {
    await render();
    await startCode();
    await enterCode();
    request.mockResolvedValueOnce({
      status: 200,
      body: { outcome: "registration_required" },
    });
    await submit();
    expect(
      container.querySelector("main")?.getAttribute("data-auth-step"),
    ).toBe("code");
    expect(button("重新验证")).toBeDefined();
    expect(onReturn).not.toHaveBeenCalled();
    await click("重新验证");
    request.mockImplementation(async (path: string) =>
      path === "challenges"
        ? accepted()
        : path === "challenges/verify"
          ? handoff()
          : { status: 201, body: null },
    );
    await click("发送验证码");
    await enterCode();
    await submit();
    await setInput(input("input[autocomplete='nickname']"), "访碑者");
    await act(async () => input("input[type='checkbox']").click());
    await click("创建账户");
    expect(onReturn).not.toHaveBeenCalled();
    expect(button("重新验证")).toBeDefined();
  });

  it("clears proofs on channel and mode changes while retaining ordinary account inputs", async () => {
    request.mockResolvedValueOnce(capabilities(true));
    await render({
      initialEmail: "tester@example.com",
      initialPhone: "13800000000",
    });
    await click("发送验证码");
    await click("修改账号");
    await click("手机");
    expect(input("input[type='tel']").value).toBe("13800000000");
    await click("发送验证码");
    await enterCode();
    await render({ mode: "register" });
    expect(
      container.querySelector("input[autocomplete='one-time-code']"),
    ).toBeNull();
    expect(input("input[type='tel']").value).toBe("13800000000");
    await click("邮箱");
    expect(input("input[type='email']").value).toBe("tester@example.com");
  });

  it("uses the existing safe return path before its return callback", async () => {
    await render({ returnTo: "//outside.invalid/path" });
    await click("返回原页面");
    expect(onReturn).toHaveBeenCalledWith("/");
  });
});
