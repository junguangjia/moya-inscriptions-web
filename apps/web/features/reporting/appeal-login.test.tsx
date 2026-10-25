// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { client } = vi.hoisted(() => ({
  client: {
    session: vi.fn(),
    signOut: vi.fn(),
    capabilities: vi.fn(),
    login: vi.fn(),
    challenge: vi.fn(),
    verify: vi.fn(),
  },
}));
vi.mock("./reporting-data", () => ({ appealClient: client }));
vi.mock("./reporting-cases", () => ({
  ReportingCases: ({
    account,
    restricted,
  }: {
    account: string;
    restricted: boolean;
  }) => (
    <div data-account={account} data-restricted={String(restricted)}>
      本人处置记录
    </div>
  ),
}));
import { AppealLogin } from "./appeal-login";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const session = {
  expiresAt: "2099-01-01T00:00:00.000Z",
  profile: {
    id: "user-synthetic",
    displayName: "合成账户",
    handle: "synthetic",
  },
};
const capabilities = {
  profile: "email-first",
  password: { available: true, identifiers: ["email", "handle"], reason: null },
  email: { available: true, reason: null },
  phone: { available: false, reason: "尚未配置" },
  developmentOnly: true,
};
let root: Root, node: HTMLDivElement;
const mount = async () => {
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () => root.render(<AppealLogin />));
};
const button = (label: string) =>
  Array.from(node.querySelectorAll<HTMLButtonElement>("button")).find(
    (item) => item.textContent === label,
  )!;
const fill = async (input: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
beforeEach(() => {
  vi.clearAllMocks();
  client.session.mockResolvedValue(null);
  client.capabilities.mockResolvedValue(capabilities);
  client.login.mockResolvedValue(session);
  client.verify.mockResolvedValue(session);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
});
describe("restricted appeal login", () => {
  it("restores only the restricted decisions panel without requesting ordinary account data", async () => {
    client.session.mockResolvedValue(session);
    await mount();
    expect(
      node
        .querySelector('[data-restricted="true"]')
        ?.getAttribute("data-account"),
    ).toBe("user-synthetic");
    expect(node.querySelector("form")).toBeNull();
    expect(client.login).not.toHaveBeenCalled();
  });
  it("validates the original account with a password and opens only own appeal records", async () => {
    await mount();
    await fill(
      node.querySelector<HTMLInputElement>('[autocomplete="username"]')!,
      "synthetic@example.com",
    );
    await fill(
      node.querySelector<HTMLInputElement>('[type="password"]')!,
      "synthetic-test-password",
    );
    await act(async () => button("验证并查看申诉").click());
    expect(client.login).toHaveBeenCalledWith({
      channel: "email",
      identifier: "synthetic@example.com",
      password: "synthetic-test-password",
      idempotencyKey: expect.any(String),
    });
    expect(node.querySelector('[data-restricted="true"]')).not.toBeNull();
    expect(node.querySelector('[type="password"]')).toBeNull();
  });
  it("supports configured OTP login, keeps the proof off URLs and disables unavailable phone delivery", async () => {
    client.challenge.mockResolvedValue({
      challengeId: "challenge-synthetic",
      continuationToken: "synthetic-transient-proof",
      maskedTarget: "s***@example.com",
      resendAvailableAt: "2020-01-01T00:00:00.000Z",
    });
    await mount();
    const mode = node.querySelector<HTMLSelectElement>("select")!;
    await act(async () => {
      mode.value = "code";
      mode.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(
      node.querySelector<HTMLOptionElement>('option[value="phone"]')?.disabled,
    ).toBe(true);
    await fill(
      node.querySelector<HTMLInputElement>('[autocomplete="username"]')!,
      "synthetic@example.com",
    );
    await act(async () => button("获取验证码").click());
    expect(client.challenge).toHaveBeenCalledWith({
      channel: "email",
      identifier: "synthetic@example.com",
      purpose: "sign_in",
      idempotencyKey: expect.any(String),
    });
    await fill(
      node.querySelector<HTMLInputElement>('[autocomplete="one-time-code"]')!,
      "123456",
    );
    await act(async () => button("验证并查看申诉").click());
    expect(client.verify).toHaveBeenCalledWith({
      challengeId: "challenge-synthetic",
      continuationToken: "synthetic-transient-proof",
      code: "123456",
      idempotencyKey: expect.any(String),
    });
    expect(window.location.href).not.toContain("synthetic-transient-proof");
    expect(node.querySelector('[data-restricted="true"]')).not.toBeNull();
  });
  it("ends the restricted session explicitly and returns to the appeal login form", async () => {
    client.session.mockResolvedValue(session);
    client.signOut.mockResolvedValue(undefined);
    await mount();
    await act(async () => button("退出申诉登录").click());
    expect(client.signOut).toHaveBeenCalledOnce();
    expect(node.querySelector("form")).not.toBeNull();
    expect(node.querySelector('[data-restricted="true"]')).toBeNull();
  });
  it("retains a failed login for a user-driven retry", async () => {
    client.login.mockRejectedValueOnce(new Error("验证未完成"));
    await mount();
    await fill(
      node.querySelector<HTMLInputElement>('[autocomplete="username"]')!,
      "synthetic@example.com",
    );
    await fill(
      node.querySelector<HTMLInputElement>('[type="password"]')!,
      "synthetic-test-password",
    );
    await act(async () => button("验证并查看申诉").click());
    expect(node.querySelector('[role="alert"]')?.textContent).toBe(
      "验证未完成",
    );
    await act(async () => button("验证并查看申诉").click());
    expect(client.login.mock.calls[0]![0]).toEqual(
      client.login.mock.calls[1]![0],
    );
  });
});
