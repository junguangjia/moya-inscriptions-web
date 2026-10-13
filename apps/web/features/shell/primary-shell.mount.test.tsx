// @vitest-environment jsdom

import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { PrimaryShell } from "./primary-shell";

import type { PrimaryDestination } from "./primary-shell";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const container = document.createElement("div");
const root = createRoot(container);
let userMounts = 0;

const UserPage = () => {
  useEffect(() => {
    userMounts += 1;
  }, []);
  return <p>user content</p>;
};

const show = (activeDestination: PrimaryDestination) =>
  act(() =>
    root.render(
      <PrimaryShell
        activeDestination={activeDestination}
        platform="phone"
        home={<p>home content</p>}
        discussion={<p>discussion content</p>}
        user={<UserPage />}
      />,
    ),
  );

const userSection = () =>
  container.querySelector<HTMLElement>('[data-primary-destination="user"]')!;

afterEach(() => act(() => root.render(null)));

describe("PrimaryShell mounts 我 on first use", () => {
  it("leaves 我 unmounted until it is opened, then keeps it mounted and hidden", async () => {
    userMounts = 0;
    await show("home");
    expect(userSection().hidden).toBe(true);
    expect(userSection().textContent).toBe("");
    await show("discussion");
    expect(userSection().textContent).toBe("");

    await show("user");
    expect(userSection().hidden).toBe(false);
    expect(userSection().textContent).toBe("user content");
    expect(userMounts).toBe(1);

    // Leaving 我 keeps its state (scroll, tabs, loaded profile) for the next visit.
    await show("home");
    expect(userSection().hidden).toBe(true);
    expect(userSection().textContent).toBe("user content");
    await show("user");
    expect(userSection().textContent).toBe("user content");
    expect(userMounts).toBe(1);
  });
});
