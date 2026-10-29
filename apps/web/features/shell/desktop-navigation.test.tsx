// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { PrimaryBottomNavigation } from "./primary-bottom-navigation";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

it("keeps desktop navigation semantic and delegates its single settings control", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const navigate = vi.fn(),
    settings = vi.fn();
  try {
    await act(async () =>
      root.render(
        <PrimaryBottomNavigation
          desktop
          platform="pc"
          activeDestination="home"
          onDestinationChange={navigate}
          onSettingsIntent={settings}
        />,
      ),
    );
    expect(host.querySelectorAll("nav")).toHaveLength(1);
    expect(host.querySelectorAll('[aria-label="设置"]')).toHaveLength(1);
    const gear = host.querySelector<HTMLButtonElement>(
      "[data-desktop-settings]",
    )!;
    await act(async () => gear.click());
    expect(settings).toHaveBeenCalledExactlyOnceWith(gear);
    const discussion = host.querySelector<HTMLButtonElement>(
      '[data-primary-navigation-destination="discussion"]',
    )!;
    await act(async () => discussion.click());
    expect(navigate).toHaveBeenCalledExactlyOnceWith("discussion");
    expect(
      host
        .querySelector('[data-primary-navigation-destination="home"]')
        ?.getAttribute("aria-current"),
    ).toBe("page");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
