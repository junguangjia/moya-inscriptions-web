// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authorClient } from "../authors/author-data";
import { ProductAccessWatcher } from "./product-access-actions";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * The watcher and the real author transport together (no mocked client). The
 * watcher mounts before any product read, so its listeners run before the
 * transport's own page-lifetime listeners; a back/forward-cache restore must
 * still ask the Backend live and reload on a different answer.
 */
describe("product access after a back/forward-cache restore", () => {
  let container: HTMLDivElement;
  let root: Root;
  let visibility: DocumentVisibilityState;
  const reload = vi.fn();

  beforeEach(() => {
    visibility = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
    reload.mockReset();
    vi.stubGlobal("location", { pathname: "/", search: "", hash: "", reload });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (document as { visibilityState?: unknown }).visibilityState;
    vi.unstubAllGlobals();
  });

  it("asks live on restore and reloads when the session ended while the page was cached", async () => {
    let answer = "granted";
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        signals.push(init.signal!);
        init.signal!.throwIfAborted();
        return new Response(
          JSON.stringify({ mode: "closed_beta", access: answer }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    await act(async () =>
      root.render(<ProductAccessWatcher expected="granted" />),
    );
    // A product read after the watcher mounted, as on the real page.
    await expect(authorClient.access()).resolves.toBe("granted");

    // Into the back/forward cache: hidden, then a persisted pagehide.
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(
      Object.assign(new Event("pagehide"), { persisted: true }),
    );
    // The session ends elsewhere while the page is cached.
    answer = "sign_in_required";

    // Restored: visible first, then pageshow.
    visibility = "visible";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(
        Object.assign(new Event("pageshow"), { persisted: true }),
      );
    });
    await act(async () => undefined);

    expect(reload).toHaveBeenCalledTimes(1);
    expect(signals.at(-1)?.aborted).toBe(false);
  });
});
