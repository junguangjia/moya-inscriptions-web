// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { access, authRequest } = vi.hoisted(() => ({
  access: vi.fn(),
  authRequest: vi.fn(),
}));
vi.mock("../auth/auth-api", () => ({
  authRequest,
  safeReturnPath: (value: string) => value,
}));
vi.mock("../authors/author-data", () => ({
  authorClient: { access },
  PRODUCT_ACCESS_REFUSED_EVENT: "yoyi:product-access-refused",
}));

import {
  ProductAccessSignIn,
  ProductAccessSignOut,
  ProductAccessWatcher,
} from "./product-access-actions";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("product access actions", () => {
  let container: HTMLDivElement;
  let root: Root;
  const reload = vi.fn();
  const settle = () => act(async () => undefined);

  beforeEach(() => {
    access.mockReset();
    authRequest.mockReset();
    reload.mockReset();
    vi.stubGlobal("location", {
      pathname: "/",
      search: "?catalogId=catalog-one",
      hash: "#detail",
      reload,
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("sends sign-in to the existing login page with the address the visitor asked for, fragment included", async () => {
    await act(async () => root.render(<ProductAccessSignIn />));
    const form = container.querySelector("form")!;
    expect(form.getAttribute("action")).toBe("/login");
    expect(form.getAttribute("method")).toBe("get");
    const destination = form.querySelector<HTMLInputElement>(
      'input[name="return"]',
    )!;
    expect(destination.value).toBe("/?catalogId=catalog-one#detail");
    expect(form.querySelector("button")!.textContent).toBe("登录");
    // The address is read again at the moment of leaving.
    (window.location as unknown as { hash: string }).hash = "#viewer";
    form.addEventListener("submit", (event) => event.preventDefault());
    await act(async () => {
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    expect(destination.value).toBe("/?catalogId=catalog-one#viewer");
  });

  it("ends the session through the existing sign-out operation and lets the server render again", async () => {
    authRequest.mockResolvedValue({ status: 200, body: null });
    await act(async () => root.render(<ProductAccessSignOut />));
    await act(async () => container.querySelector("button")!.click());
    expect(authRequest).toHaveBeenCalledWith("sign-out", {
      method: "POST",
      body: {},
    });
    expect(reload).toHaveBeenCalledOnce();
  });

  it("keeps the visitor on the notice and says so when sign-out is not confirmed", async () => {
    authRequest.mockResolvedValue({ status: 503, body: null });
    await act(async () => root.render(<ProductAccessSignOut />));
    await act(async () => container.querySelector("button")!.click());
    expect(reload).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')!.textContent).toContain(
      "退出未能确认",
    );
    authRequest.mockRejectedValue(new Error("offline"));
    await act(async () => container.querySelector("button")!.click());
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads when the Backend's answer no longer matches what is on screen", async () => {
    access.mockResolvedValue("granted");
    await act(async () =>
      root.render(<ProductAccessWatcher expected="granted" />),
    );
    // Nothing is asked until the visitor returns or a request is refused.
    expect(access).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("focus"));
    await settle();
    expect(access).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();

    access.mockResolvedValue("restricted");
    window.dispatchEvent(new Event("yoyi:product-access-refused"));
    await settle();
    expect(reload).toHaveBeenCalledOnce();

    // A page restored from the back-forward cache asks as well.
    access.mockResolvedValue("sign_in_required");
    window.dispatchEvent(new Event("pageshow"));
    await settle();
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("changes nothing when the question itself fails", async () => {
    access.mockRejectedValue(new Error("offline"));
    await act(async () =>
      root.render(<ProductAccessWatcher expected="sign_in_required" />),
    );
    window.dispatchEvent(new Event("focus"));
    await settle();
    expect(access).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
  });
});
