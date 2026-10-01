// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsSwipe } from "./use-settings-swipe";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | null = null,
  frame: HTMLDivElement;
let allowed = true;
const back = vi.fn();
const Harness = ({ page = "root", enabled = true }) => {
  const ref = useRef<HTMLDivElement>(null);
  const handlers = useSettingsSwipe({
    frame: ref,
    page,
    enabled,
    canBack: () => allowed,
    onBack: back,
  });
  return (
    <div ref={ref} {...handlers}>
      <p>滑动区域</p>
      <input aria-label="保留原生输入" />
      <button>操作</button>
    </div>
  );
};
const mount = async () => {
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () => root!.render(<Harness />));
  frame = node.firstElementChild as HTMLDivElement;
};
const pointer = async (
  type: string,
  x: number,
  y: number,
  target: Element = frame,
  time = 0,
  pointerId = 1,
  isPrimary = true,
) =>
  act(async () => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      clientX: { value: x },
      clientY: { value: y },
      pointerId: { value: pointerId },
      pointerType: { value: "touch" },
      isPrimary: { value: isPrimary },
      timeStamp: { value: time },
    });
    target.dispatchEvent(event);
  });
const start = async (target?: Element, x = 50) =>
  pointer("pointerdown", x, 100, target);
const finish = async () => {
  await pointer("pointermove", 220, 103, frame, 250);
  await pointer("pointerup", 220, 103, frame, 300);
};
beforeEach(() => {
  allowed = true;
  back.mockClear();
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
describe("settings-local touch Back", () => {
  it("commits one intentional internal swipe", async () => {
    await mount();
    await start();
    await finish();
    expect(back).toHaveBeenCalledOnce();
  });
  it("leaves the browser edge and interactive controls alone", async () => {
    await mount();
    await start(undefined, 10);
    await finish();
    await start(frame.querySelector("input")!);
    await finish();
    await start(frame.querySelector("button")!);
    await finish();
    expect(back).not.toHaveBeenCalled();
  });
  it("preserves capture transferred from a child and cancels actual frame capture loss", async () => {
    await mount();
    await start(frame.querySelector("p")!);
    await pointer("pointermove", 80, 102);
    await pointer("lostpointercapture", 80, 102, frame.querySelector("p")!);
    await finish();
    expect(back).toHaveBeenCalledOnce();
    await start();
    await pointer("pointermove", 80, 102);
    await pointer("lostpointercapture", 80, 102);
    await finish();
    expect(back).toHaveBeenCalledOnce();
  });
  it("cancels an established swipe when a second finger touches elsewhere", async () => {
    await mount();
    await start();
    await pointer("pointermove", 220, 103, frame, 100);
    await pointer("pointerdown", 250, 150, document.body, 110, 2, false);
    await pointer("pointerup", 220, 103, frame, 300);
    expect(back).not.toHaveBeenCalled();
    await pointer("pointerup", 250, 150, document.body, 310, 2, false);
    await start();
    await finish();
    expect(back).toHaveBeenCalledOnce();
  });
  it("never converts an established vertical scroll into Back", async () => {
    await mount();
    await start();
    await pointer("pointermove", 55, 140);
    await finish();
    expect(back).not.toHaveBeenCalled();
  });
  it("cancels on pointer cancellation, resizing and page changes", async () => {
    await mount();
    await start();
    await pointer("pointercancel", 50, 100);
    await finish();
    await start();
    window.dispatchEvent(new Event("resize"));
    await finish();
    await start();
    await act(async () => root!.render(<Harness page="privacy" />));
    await finish();
    expect(back).not.toHaveBeenCalled();
  });
  it("rechecks busy at release and disables desktop presentation", async () => {
    await mount();
    await start();
    allowed = false;
    await finish();
    expect(back).not.toHaveBeenCalled();
    allowed = true;
    await act(async () => root!.render(<Harness enabled={false} />));
    await start();
    await finish();
    expect(back).not.toHaveBeenCalled();
  });
  it("keeps focused inputs and a short aborted drag in place", async () => {
    await mount();
    frame.querySelector("input")!.focus();
    await start();
    await finish();
    frame.querySelector("input")!.blur();
    await start();
    await pointer("pointermove", 70, 102, frame, 300);
    await pointer("pointerup", 70, 102, frame, 350);
    expect(back).not.toHaveBeenCalled();
  });
});
