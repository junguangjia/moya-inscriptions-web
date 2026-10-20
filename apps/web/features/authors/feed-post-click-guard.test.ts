// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetFeedPostClickGuard,
  suppressFollowingPointerClicks,
} from "./feed-post-click-guard";
import { FEED_POST_CLICK_SUPPRESSION_MS } from "./feed-post-strip-geometry";

import type { Mock } from "vitest";

let target: HTMLButtonElement;
let received: Mock<(event: Event) => void>;
/** Dispatches a click on the target; true when nothing cancelled it. */
const click = (detail: number) =>
  target.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true, detail }),
  );
const clickListeners = (spy: { mock: { calls: readonly unknown[][] } }) =>
  spy.mock.calls.filter(([type]) => type === "click");

beforeEach(() => {
  vi.useFakeTimers();
  target = document.createElement("button");
  received = vi.fn<(event: Event) => void>();
  target.addEventListener("click", received);
  document.body.append(target);
});

afterEach(() => {
  resetFeedPostClickGuard();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("suppressFollowingPointerClicks", () => {
  it("swallows pointer clicks for 500 ms, then removes its listener", () => {
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");
    expect(FEED_POST_CLICK_SUPPRESSION_MS).toBe(500);
    suppressFollowingPointerClicks();
    const added = clickListeners(add);
    expect(added).toHaveLength(1);
    expect(added[0]![2]).toBe(true);

    expect(click(1)).toBe(false);
    expect(click(2)).toBe(false);
    vi.advanceTimersByTime(499);
    expect(click(1)).toBe(false);
    expect(received).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(clickListeners(remove)).toEqual([["click", added[0]![1], true]]);
    expect(vi.getTimerCount()).toBe(0);
    expect(click(1)).toBe(true);
    expect(received).toHaveBeenCalledOnce();
  });

  it("lets keyboard and assistive activation through at once", () => {
    suppressFollowingPointerClicks();
    expect(click(0)).toBe(true);
    expect(received).toHaveBeenCalledOnce();
    // Pointer clicks around it are still swallowed.
    expect(click(1)).toBe(false);
    expect(received).toHaveBeenCalledOnce();
  });

  it("extends the time when armed again, with one listener", () => {
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");
    suppressFollowingPointerClicks();
    vi.advanceTimersByTime(300);
    suppressFollowingPointerClicks();
    // A shorter arming never cuts the time short.
    suppressFollowingPointerClicks(50);
    expect(clickListeners(add)).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(300);
    expect(click(1)).toBe(false);
    vi.advanceTimersByTime(199);
    expect(click(1)).toBe(false);
    expect(received).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(clickListeners(remove)).toHaveLength(1);
    expect(click(1)).toBe(true);
    expect(received).toHaveBeenCalledOnce();
  });

  it("lets clicks through once the time is up, even before a late timer runs", () => {
    const remove = vi.spyOn(document, "removeEventListener");
    const start = performance.now();
    suppressFollowingPointerClicks();
    vi.spyOn(performance, "now").mockReturnValue(start + 500);
    expect(click(1)).toBe(true);
    expect(received).toHaveBeenCalledOnce();
    expect(clickListeners(remove)).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does nothing without a document", () => {
    vi.stubGlobal("document", undefined);
    expect(() => suppressFollowingPointerClicks()).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
    vi.unstubAllGlobals();
    expect(click(1)).toBe(true);
    expect(received).toHaveBeenCalledOnce();
  });

  it("lets every click through after a reset", () => {
    suppressFollowingPointerClicks();
    resetFeedPostClickGuard();
    expect(vi.getTimerCount()).toBe(0);
    expect(click(1)).toBe(true);
    expect(received).toHaveBeenCalledOnce();
  });
});
