// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FeedViewerHost } from "./feed-viewer-host";

import type { Root } from "react-dom/client";
import type { FeedViewerSession } from "./feed-viewer-host";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
const media = ["media-one", "media-two", "media-three"].map((id, index) => ({
  alt: `动态图像 ${index + 1}`,
  height: 600,
  id,
  src: `https://example.test/${id}.jpg`,
  width: 400,
}));

const render = (session: FeedViewerSession | null) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const onClose = vi.fn();
  const onIndexChange = vi.fn();
  act(() =>
    root.render(
      <FeedViewerHost
        onClose={onClose}
        onIndexChange={onIndexChange}
        platform="phone"
        session={session}
      />,
    ),
  );
  return { container, onClose, onIndexChange };
};

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({ matches: false })),
  });
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe("FeedViewerHost", () => {
  it("renders nothing without a session", () => {
    const { container } = render(null);
    expect(container.querySelector("[data-detail-viewer]")).toBeNull();
  });

  it("opens the full-screen viewer on the session's item and direction", () => {
    const opener = document.createElement("button");
    const { container, onClose, onIndexChange } = render({
      target: { type: "catalog", id: "catalog-one" },
      media,
      index: 1,
      opener,
      direction: "rtl",
    });
    const viewer = container.querySelector<HTMLElement>(
      "[data-detail-viewer]",
    )!;
    expect(viewer.getAttribute("data-viewer-direction")).toBe("rtl");
    expect(
      viewer.querySelector<HTMLImageElement>("[data-detail-viewer-image]")?.alt,
    ).toBe("动态图像 2");

    // In rtl the next item lies to the left.
    act(() => {
      viewer.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft" }),
      );
      vi.advanceTimersByTime(220);
    });
    expect(onIndexChange).toHaveBeenCalledExactlyOnceWith(2);

    act(() => {
      viewer.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
      );
    });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
