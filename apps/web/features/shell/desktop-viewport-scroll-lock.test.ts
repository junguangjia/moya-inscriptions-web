// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { acquireDesktopViewportScrollLock } from "./desktop-viewport-scroll-lock";

const releases: (() => void)[] = [];
const acquire = () => {
  const release = acquireDesktopViewportScrollLock();
  releases.push(release);
  return release;
};
const desktop = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)";
let agent: MockInstance<() => string>;
beforeEach(() => {
  agent = vi.spyOn(navigator, "userAgent", "get").mockReturnValue(desktop);
  Object.defineProperty(navigator, "maxTouchPoints", {
    configurable: true,
    value: 0,
  });
});
afterEach(() => {
  for (const release of releases.splice(0)) release();
  document.documentElement.removeAttribute("style");
  delete (navigator as { maxTouchPoints?: number }).maxTouchPoints;
  vi.restoreAllMocks();
});

describe("desktop viewport scroll ownership", () => {
  it("keeps nested owners locked through out-of-order releases and restores exact priority", () => {
    const style = document.documentElement.style;
    style.setProperty("overflow-y", "scroll", "important");
    style.setProperty("overflow-x", "clip", "important");
    style.color = "red";
    const first = acquire();
    const second = acquire();
    expect(style.overflowY).toBe("hidden");
    first();
    expect(style.overflowY).toBe("hidden");
    expect(style.overflowX).toBe("clip");
    second();
    expect(style.overflowY).toBe("scroll");
    expect(style.getPropertyPriority("overflow-y")).toBe("important");
    expect(style.getPropertyPriority("overflow-x")).toBe("important");
    expect(style.color).toBe("red");
  });

  it("makes replayed cleanup idempotent without unlocking the next modal", () => {
    const style = document.documentElement.style;
    const first = acquire();
    first();
    const next = acquire();
    first();
    expect(style.overflowY).toBe("hidden");
    next();
    expect(style.getPropertyValue("overflow-y")).toBe("");
  });

  it("retains an already-held external lock", () => {
    document.documentElement.style.overflowY = "hidden";
    acquire()();
    expect(document.documentElement.style.overflowY).toBe("hidden");
  });

  it("releases according to acquisition even after device or window inputs change", () => {
    const release = acquire();
    agent.mockReturnValue("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)");
    release();
    expect(document.documentElement.style.overflowY).toBe("");
  });

  it.each([
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)", 5],
    ["Mozilla/5.0 (iPad; CPU OS 18_0)", 5],
    [desktop, 5],
  ] as const)(
    "leaves the existing body lock authoritative for %s",
    (userAgent, touch) => {
      agent.mockReturnValue(userAgent);
      Object.defineProperty(navigator, "maxTouchPoints", {
        configurable: true,
        value: touch,
      });
      document.documentElement.style.overflowY = "clip";
      const release = acquire();
      expect(document.documentElement.style.overflowY).toBe("clip");
      release();
      expect(document.documentElement.style.overflowY).toBe("clip");
    },
  );
});
