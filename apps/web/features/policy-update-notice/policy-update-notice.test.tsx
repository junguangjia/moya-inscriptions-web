// @vitest-environment jsdom

import { act } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Root } from "react-dom/client";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const KEY = "yoyi.policy-update-notice.ai-tools.v1";
const TEXT =
  "隐私政策和社区规则已更新：平台开始使用 AI 工具协助审核和后台管理。";
const cleanups: (() => void)[] = [];

// A fresh module is a new page: the memory of a close ends with the page.
const loadNotice = async () => {
  vi.resetModules();
  return (await import("./policy-update-notice")).PolicyUpdateNotice;
};

const openPage = async (instances = 1) => {
  const PolicyUpdateNotice = await loadNotice();
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  act(() =>
    root.render(
      Array.from({ length: instances }, (_, index) => (
        <PolicyUpdateNotice key={index} />
      )),
    ),
  );
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container;
};

const notices = (container: HTMLElement) =>
  container.querySelectorAll("[data-policy-update-notice]");
const closeButton = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>('button[aria-label="关闭提示"]')!;

const blockStorage = () => {
  const blocked = () => {
    throw new DOMException("Blocked", "SecurityError");
  };
  vi.spyOn(window, "localStorage", "get").mockImplementation(blocked);
};

beforeEach(() => {
  window.localStorage.clear();
  vi.useFakeTimers({
    now: Date.parse("2026-11-20T04:00:00.000Z"),
    toFake: ["Date"],
  });
});

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("PolicyUpdateNotice", () => {
  it("stays out of the server HTML and appears after hydration without a mismatch", async () => {
    const PolicyUpdateNotice = await loadNotice();
    const html = renderToString(<PolicyUpdateNotice />);
    expect(html).toBe("");

    const consoleError = vi.spyOn(console, "error");
    const onRecoverableError = vi.fn();
    const container = document.body.appendChild(document.createElement("div"));
    container.innerHTML = html;
    let root: Root;
    act(() => {
      root = hydrateRoot(container, <PolicyUpdateNotice />, {
        onRecoverableError,
      });
    });
    cleanups.push(() => {
      act(() => root.unmount());
      container.remove();
    });

    expect(notices(container)).toHaveLength(1);
    expect(onRecoverableError).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("says the agreed words, links to the policies and asks for nothing", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const container = await openPage();
    expect(container.querySelector("p")?.textContent).toBe(TEXT);
    const link = container.querySelector("a")!;
    expect(link.textContent).toBe("查看");
    expect(link.getAttribute("href")).toBe("/policies");
    expect(closeButton(container)).not.toBeNull();
    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(document.cookie).toBe("");
  });

  it("closes in every feed at once and stays closed on a later visit", async () => {
    const container = await openPage(4);
    expect(notices(container)).toHaveLength(4);
    act(() => closeButton(container).click());
    expect(notices(container)).toHaveLength(0);
    expect(window.localStorage.getItem(KEY)).not.toBeNull();

    expect(notices(await openPage())).toHaveLength(0);
  });

  it("records following the link without stopping it", async () => {
    const container = await openPage();
    let stopped: boolean | undefined;
    // jsdom cannot navigate; a one-off browser run covered the real departure.
    container.addEventListener("click", (event) => {
      stopped = event.defaultPrevented;
      event.preventDefault();
    });
    act(() => container.querySelector("a")!.click());
    expect(stopped).toBe(false);
    expect(notices(container)).toHaveLength(0);

    expect(notices(await openPage())).toHaveLength(0);
  });

  it("ends by the client's clock at the start of 2026-12-05 in China", async () => {
    vi.setSystemTime(Date.parse("2026-12-04T15:59:59.999Z"));
    expect(notices(await openPage())).toHaveLength(1);

    vi.setSystemTime(Date.parse("2026-12-04T16:00:00.000Z"));
    expect(notices(await openPage())).toHaveLength(0);

    vi.setSystemTime(Date.parse("2028-01-01T00:00:00.000Z"));
    expect(notices(await openPage())).toHaveLength(0);
  });

  it("shows and closes without throwing when storage is blocked, and may show again", async () => {
    blockStorage();
    const container = await openPage();
    expect(notices(container)).toHaveLength(1);
    act(() => closeButton(container).click());
    expect(notices(container)).toHaveLength(0);

    expect(notices(await openPage())).toHaveLength(1);
  });

  it("closes for this page when only the write fails", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Full", "QuotaExceededError");
    });
    const container = await openPage();
    act(() => closeButton(container).click());
    expect(notices(container)).toHaveLength(0);
  });
});
