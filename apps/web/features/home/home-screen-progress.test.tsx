// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { HomeFeed } from "./home-feed";

const callbacks = vi.hoisted(() => ({
  progress: (_value: number) => {
    void _value;
  },
  commit: (_feed: HomeFeed) => {
    void _feed;
  },
}));
vi.mock("./home-feed-pager", () => ({
  HomeFeedPager: (props: {
    onProgress: (value: number) => void;
    onCommit: (feed: HomeFeed) => void;
  }) => {
    callbacks.progress = props.onProgress;
    callbacks.commit = props.onCommit;
    return null;
  },
}));
vi.mock("../product-shell/product-shell", () => ({
  useProductShell: () => ({
    activeDestination: "home",
    platform: "phone",
    feedLayout: "double",
  }),
}));
import { HomeScreen } from "./home-screen";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

it("does not rerender populated feeds for fractional swipe progress, but updates them on commit", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const discover = vi.fn(() => <p>Populated feed</p>);
  try {
    await act(async () =>
      root.render(
        <HomeScreen
          data={{
            discover: { state: "empty" },
            timeline: { state: "empty" },
            topics: { state: "empty" },
          }}
          renderDiscover={discover}
        />,
      ),
    );
    const initial = discover.mock.calls.length;
    const icon = container.querySelector('[data-icon="timeline"]');
    for (const progress of [0.1, 0.3, 0.7, 0.4, 0]) {
      await act(async () => callbacks.progress(progress));
      expect(discover).toHaveBeenCalledTimes(initial);
      expect(container.querySelector('[data-icon="timeline"]')).toBe(icon);
      expect(
        Number(
          container
            .querySelector<HTMLElement>('[data-tab-key="timeline"]')!
            .style.getPropertyValue("--top-tab-activation"),
        ),
      ).toBeCloseTo(progress, 5);
    }
    await act(async () => callbacks.commit("timeline"));
    expect(discover).toHaveBeenCalledTimes(initial + 1);
    expect(
      container
        .querySelector('[data-tab-key="timeline"]')
        ?.getAttribute("aria-selected"),
    ).toBe("true");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
