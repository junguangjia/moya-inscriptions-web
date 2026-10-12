// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCategoryPagerEngine } from "./category-pager-engine";

let time = 0;
let frameId = 0;
let reduce = false;
const frames = new Map<number, FrameRequestCallback>();
const cleanups: (() => void)[] = [];

const advance = (count = 1) => {
  for (let i = 0; i < count; i++) {
    time += 16.667;
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(time));
  }
};
const touch = (
  target: Element,
  type: string,
  points: [number, number][],
  cancelable = true,
) => {
  const event = new TouchEvent(type, {
    bubbles: true,
    cancelable,
    touches: points.map(([clientX, clientY], identifier) => ({
      clientX,
      clientY,
      identifier,
      target,
      pageX: clientX,
      pageY: clientY,
      screenX: clientX,
      screenY: clientY,
      force: 1,
      radiusX: 1,
      radiusY: 1,
      rotationAngle: 0,
    })),
  });
  Object.defineProperty(event, "timeStamp", { value: time });
  target.dispatchEvent(event);
  return event;
};
const setup = (canStartGesture?: () => boolean) => {
  const frame = document.createElement("div");
  frame.innerHTML =
    "<div><section><button>one</button></section><section><button>two</button></section><section><button>three</button></section></div>";
  document.body.append(frame);
  const track = frame.firstElementChild as HTMLElement;
  const panels = [...track.children] as HTMLElement[];
  let active = 0;
  const commits: number[] = [];
  const motion: boolean[] = [];
  const progress: number[] = [];
  const apply = () =>
    panels.forEach((panel, index) => {
      panel.inert = index !== active;
    });
  apply();
  for (const node of [frame, track, ...panels]) {
    Object.defineProperties(node, {
      offsetWidth: { configurable: true, value: 400 },
      offsetHeight: { configurable: true, value: 600 },
      offsetTop: { configurable: true, value: 0 },
      offsetLeft: {
        configurable: true,
        value: Math.max(0, panels.indexOf(node)) * 400,
      },
      offsetParent: { configurable: true, value: document.body },
    });
  }
  const engine = createCategoryPagerEngine(frame, {
    ...(canStartGesture ? { canStartGesture } : {}),
    getCommittedIndex: () => active,
    onCommit: (index) => {
      active = index;
      commits.push(index);
      apply();
    },
    onMotion: (moving) => motion.push(moving),
    onProgress: (value) => progress.push(value),
  });
  cleanups.push(engine.destroy);
  const button = panels[0]!.firstElementChild as HTMLButtonElement;
  const drag = (dx = -220, dy = 0, count = 10) => {
    touch(button, "touchstart", [[300, 300]]);
    for (let i = 1; i <= count; i++) {
      advance();
      touch(button, "touchmove", [
        [300 + (dx * i) / count, 300 + (dy * i) / count],
      ]);
    }
  };
  return {
    frame,
    track,
    panels,
    button,
    engine,
    commits,
    motion,
    progress,
    drag,
    active: () => active,
  };
};

describe("category paging with the actual Embla core", () => {
  beforeEach(() => {
    time = 0;
    frameId = 0;
    reduce = false;
    frames.clear();
    vi.spyOn(performance, "now").mockImplementation(() => time);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      frames.set(++frameId, cb);
      return frameId;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      frames.delete(id);
    });
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: reduce,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => {
    cleanups.splice(0).forEach((cleanup) => cleanup());
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("blocks only opted-out gestures and resumes without replacing the engine", () => {
    let allowed = false;
    const host = setup(() => allowed);
    host.drag();
    touch(host.button, "touchend", []);
    advance(120);
    expect(host.active()).toBe(0);
    expect(host.commits).toEqual([]);
    allowed = true;
    host.drag();
    touch(host.button, "touchend", []);
    advance(120);
    expect(host.active()).toBe(1);
    expect(host.commits).toEqual([1]);
  });
  it("leaves a drag that starts inside a local horizontal scroller to it", () => {
    const view = setup();
    const local = document.createElement("div");
    local.setAttribute("data-local-horizontal", "");
    local.innerHTML = "<figure><button>image</button></figure>";
    view.panels[0]!.append(local);
    const image = local.querySelector("button")!;
    const action = vi.fn();
    image.addEventListener("click", action);
    const progressBefore = view.progress.length;
    touch(image, "touchstart", [[300, 300]]);
    for (let i = 1; i <= 10; i++) {
      advance();
      // Embla never claims the move, so the nested native scroller can.
      expect(
        touch(image, "touchmove", [[300 - 22 * i, 300]]).defaultPrevented,
      ).toBe(false);
    }
    touch(image, "touchend", []);
    advance(120);
    expect(view.commits).toEqual([]);
    expect(view.active()).toBe(0);
    expect(view.progress.slice(progressBefore).every((p) => p === 0)).toBe(
      true,
    );
    expect(view.track.style.transform).not.toMatch(/-\d/u);
    image.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }),
    );
    expect(action).toHaveBeenCalledOnce();

    // The same drag starting outside the scroller still pages.
    view.drag();
    touch(view.button, "touchend", []);
    advance(120);
    expect(view.commits).toEqual([1]);
  });

  it("hands selection and inert over on release, before visual settlement", () => {
    const view = setup();
    view.drag();
    expect(view.commits).toEqual([]);
    expect(view.track.style.transform).not.toBe("translate3d(0px,0px,0px)");
    touch(view.button, "touchend", []);
    expect(view.commits).toEqual([1]);
    expect(view.panels.map((p) => p.inert)).toEqual([true, false, true]);
    expect(view.track.style.transform).not.toBe("translate3d(-400px,0px,0px)");
    advance(180);
    expect(view.commits).toEqual([1]);
    expect(view.motion.at(-1)).toBe(false);
    expect(view.progress.at(-1)).toBeCloseTo(1, 2);
  });

  it("leaves a vertical-first gesture to the browser for its whole lifetime", () => {
    const view = setup();
    touch(view.button, "touchstart", [[300, 300]]);
    expect(touch(view.button, "touchmove", [[296, 280]]).defaultPrevented).toBe(
      false,
    );
    expect(touch(view.button, "touchmove", [[100, 275]]).defaultPrevented).toBe(
      false,
    );
    touch(view.button, "touchend", []);
    advance(120);
    expect(view.commits).toEqual([]);
    expect(view.progress.at(-1)).toBe(0);
  });

  it.each([true, false])(
    "keeps the engine intact when vertical input wins (cancelable=%s)",
    (cancelable) => {
      const view = setup();
      const add = vi.spyOn(view.frame, "addEventListener");
      const remove = vi.spyOn(view.frame, "removeEventListener");
      touch(view.button, "touchstart", [[220, 659]], cancelable);
      advance();
      const vertical = touch(
        view.button,
        "touchmove",
        [[226.33, 649.67]],
        cancelable,
      );
      // Embla may remove the current drag listeners. Its persistent root
      // listeners must not be destroyed/recreated while Safari begins scrolling.
      const persistent = new Set(["touchstart", "touchcancel", "click"]);
      expect(
        remove.mock.calls.filter(([type]) => persistent.has(type)),
      ).toEqual([]);
      expect(add.mock.calls.filter(([type]) => persistent.has(type))).toEqual(
        [],
      );
      expect(vertical.defaultPrevented).toBe(false);
      expect(view.frame.firstElementChild).toBe(view.track);
      expect(view.commits).toEqual([]);
      touch(view.button, "touchmove", [[220, 601]]);
      touch(view.button, "touchend", []);
      advance(120);
      expect(view.commits).toEqual([]);
    },
  );

  it("accepts the same horizontal touch when the browser releases preceding vertical momentum", () => {
    const view = setup();
    touch(view.button, "touchstart", [[300, 300]], false);
    touch(view.button, "touchmove", [[276, 300.4]], false);
    advance();
    expect(
      touch(view.button, "touchmove", [[252, 300.8]]).defaultPrevented,
    ).toBe(true);
    for (let i = 1; i <= 8; i++) {
      advance();
      touch(view.button, "touchmove", [[252 - i * 24, 301]]);
    }
    touch(view.button, "touchend", []);
    advance(180);
    expect(view.commits).toEqual([1]);
  });

  it("leaves the recorded Safari up-swipe with initial diagonal jitter to native scrolling", () => {
    const view = setup();
    view.engine.scrollTo(1);
    advance(180);
    view.commits.length = 0;
    const target = view.panels[1]!.firstElementChild!;
    const began = time;
    touch(target, "touchstart", [[221, 559]], false);
    // Actual Safari coordinates and delivery times from the retained failing
    // touch. The first nearly equal-axis move was only 3.77px from the origin.
    const moves = [
      [61, 223.66666666666666, 561.6666666666666],
      [76, 228, 559.6666666666666],
      [93, 226.33333333333331, 554.3333333333333],
      [96, 223.66666666666666, 548],
      [110, 218, 533.3333333333333],
      [126, 211.33333333333331, 516.3333333333333],
      [143, 204.66666666666666, 499.66666666666663],
      [162, 197.66666666666666, 484],
      [176, 190, 469],
      [193, 180.33333333333331, 454],
      [210, 161.66666666666666, 434],
      [227, 142, 415.3333333333333],
    ] as const;
    const prevented: boolean[] = [];
    for (const [elapsed, x, y] of moves) {
      time = began + elapsed;
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback(time));
      prevented.push(touch(target, "touchmove", [[x, y]]).defaultPrevented);
    }
    time = began + 230;
    touch(target, "touchend", []);
    advance(120);
    expect(prevented).toEqual(moves.map(() => false));
    expect(view.commits).toEqual([]);
    expect(view.active()).toBe(1);
    expect(view.panels.map((panel) => panel.inert)).toEqual([
      true,
      false,
      true,
    ]);
  });

  it("does not turn noncancelable vertical input into a later horizontal gesture", () => {
    const view = setup();
    touch(view.button, "touchstart", [[300, 300]], false);
    touch(view.button, "touchmove", [[296, 275]], false);
    expect(touch(view.button, "touchmove", [[100, 270]]).defaultPrevented).toBe(
      false,
    );
    touch(view.button, "touchend", []);
    advance(120);
    expect(view.commits).toEqual([]);
  });

  it("interrupts from the current position and the previous tail never recommits", () => {
    const view = setup();
    view.drag();
    touch(view.button, "touchend", []);
    advance(2);
    const position = view.track.style.transform;
    touch(view.button, "touchstart", [[100, 300]]);
    expect(view.track.style.transform).toBe(position);
    for (let i = 1; i <= 8; i++) {
      advance();
      touch(view.button, "touchmove", [[100 + i * 25, 300]]);
    }
    touch(view.button, "touchend", []);
    advance(180);
    expect(view.commits).toEqual([1, 0]);
  });

  for (const phase of ["waiting", "jitter", "dragging", "menu"] as const) {
    it(`cancels ${phase} on a second finger without release or click leakage`, () => {
      const view = setup();
      if (phase === "dragging") view.drag();
      else touch(view.button, "touchstart", [[300, 300]]);
      if (phase === "jitter") touch(view.button, "touchmove", [[303, 302]]);
      if (phase === "menu") {
        view.button.dataset.quickActions = "enabled";
        view.button.dataset.quickActionPhase = "menu-open";
      }
      touch(view.button, "touchstart", [
        [100, 300],
        [220, 300],
      ]);
      expect(
        touch(view.button, "touchmove", [
          [60, 300],
          [280, 300],
        ]).defaultPrevented,
      ).toBe(false);
      touch(view.button, "touchend", [[60, 300]]);
      touch(view.button, "touchmove", [[10, 300]]);
      touch(view.button, "touchend", []);
      advance(120);
      expect(view.commits).toEqual([]);
      expect(view.progress.at(-1)).toBe(0);
      delete view.button.dataset.quickActionPhase;
      view.drag();
      touch(view.button, "touchend", []);
      advance(120);
      expect(view.commits).toEqual([1]);
    });
  }

  it("keeps a small-motion tap and stops filtering once a horizontal drag starts", () => {
    const view = setup();
    const click = vi.fn();
    view.button.addEventListener("click", click);
    touch(view.button, "touchstart", [[300, 300]]);
    expect(touch(view.button, "touchmove", [[303, 301]]).defaultPrevented).toBe(
      false,
    );
    touch(view.button, "touchend", []);
    view.button.dispatchEvent(
      new MouseEvent("click", { bubbles: true, detail: 1 }),
    );
    expect(click).toHaveBeenCalledOnce();
    touch(view.button, "touchstart", [[300, 300]]);
    expect(touch(view.button, "touchmove", [[303, 301]]).defaultPrevented).toBe(
      false,
    );
    expect(touch(view.button, "touchmove", [[270, 300]]).defaultPrevented).toBe(
      true,
    );
    expect(touch(view.button, "touchmove", [[299, 300]]).defaultPrevented).toBe(
      true,
    );
    touch(view.button, "touchcancel", []);
    advance(120);
    expect(view.commits).toEqual([]);
  });

  it("gives an open long-press menu exclusive horizontal movement", () => {
    const view = setup();
    touch(view.button, "touchstart", [[300, 300]]);
    view.button.dataset.quickActions = "enabled";
    view.button.dataset.quickActionPhase = "menu-open";
    touch(view.button, "touchmove", [[80, 300]]);
    touch(view.button, "touchend", []);
    advance(120);
    expect(view.commits).toEqual([]);
    expect(view.progress.at(-1)).toBe(0);
  });

  it("keeps the committed category when vertical scrolling interrupts an unfinished tail", () => {
    const view = setup();
    view.drag();
    touch(view.button, "touchend", []);
    advance(2);
    touch(view.button, "touchstart", [[200, 400]]);
    expect(touch(view.button, "touchmove", [[195, 370]]).defaultPrevented).toBe(
      false,
    );
    touch(view.button, "touchend", []);
    advance(120);
    expect(view.commits).toEqual([1]);
    expect(view.motion.at(-1)).toBe(false);
    // Natural settlement retains Embla's subpixel position instead of
    // rebuilding the engine at the integer snap during native scrolling.
    expect(view.progress.at(-1)).toBeCloseTo(1, 5);
    const x = Number(
      view.track.style.transform.match(/translate3d\(([-\d.]+)px/)?.[1],
    );
    expect(Math.abs(x + 400)).toBeLessThan(0.002);
  });

  it("limits a vigorous release to an adjacent category", () => {
    const view = setup();
    view.drag(-750);
    touch(view.button, "touchend", []);
    advance(180);
    expect(view.commits).toEqual([1]);
  });

  it("still suppresses a drag tail after a long stationary hold and cleans hidden-page work", () => {
    const view = setup();
    const click = vi.fn();
    view.button.addEventListener("click", click);
    view.drag();
    advance(60);
    touch(view.button, "touchend", []);
    view.button.dispatchEvent(
      new MouseEvent("click", { bubbles: true, detail: 1 }),
    );
    expect(click).not.toHaveBeenCalled();
    view.drag();
    window.dispatchEvent(new Event("pagehide"));
    const commits = [...view.commits];
    touch(view.button, "touchend", []);
    advance(180);
    expect(view.commits).toEqual(commits);
  });

  it("suppresses only the trailing pointer click and accepts a new tap or keyboard", () => {
    const view = setup();
    const action = vi.fn();
    view.button.addEventListener("click", action);
    view.drag();
    touch(view.button, "touchend", []);
    view.button.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }),
    );
    expect(action).not.toHaveBeenCalled();
    touch(view.button, "touchstart", [[100, 300]]);
    touch(view.button, "touchend", []);
    view.button.dispatchEvent(
      new MouseEvent("click", { bubbles: true, detail: 1 }),
    );
    expect(action).toHaveBeenCalledTimes(1);
    view.drag();
    touch(view.button, "touchend", []);
    view.button.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }),
    );
    view.button.dispatchEvent(
      new MouseEvent("click", { bubbles: true, detail: 0 }),
    );
    expect(action).toHaveBeenCalledTimes(2);
  });

  it("accepts a fresh mouse click after a touch drag with no synthesized tail click", () => {
    const view = setup();
    view.drag();
    touch(view.button, "touchend", []);
    advance(180);
    const button = view.panels[1]!.firstElementChild!;
    const action = vi.fn();
    button.addEventListener("click", action);
    const pointer = new MouseEvent("pointerdown", { bubbles: true, button: 0 });
    Object.defineProperty(pointer, "pointerType", { value: "mouse" });
    button.dispatchEvent(pointer);
    button.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0 }),
    );
    button.dispatchEvent(
      new MouseEvent("mouseup", { bubbles: true, button: 0 }),
    );
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(action).toHaveBeenCalledOnce();
  });

  it("does not treat compatibility mouse events from the old touch as a fresh press", () => {
    const view = setup();
    view.drag();
    touch(view.button, "touchend", []);
    advance(180);
    const action = vi.fn();
    view.button.addEventListener("click", action);
    for (const type of ["mousedown", "mouseup", "click"]) {
      const event = new MouseEvent(type, {
        bubbles: true,
        detail: 1,
        button: 0,
      });
      Object.defineProperty(event, "sourceCapabilities", {
        value: { firesTouchEvents: true },
      });
      view.button.dispatchEvent(event);
    }
    expect(action).not.toHaveBeenCalled();
  });

  it("accepts assistive activation without a preceding keyboard event", () => {
    const view = setup();
    view.drag();
    touch(view.button, "touchend", []);
    advance(180);
    const button = view.panels[1]!.firstElementChild!;
    const action = vi.fn();
    button.addEventListener("click", action);
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
    expect(action).toHaveBeenCalledOnce();
  });

  it("jumps to the target after release and tab selection with reduced motion", () => {
    reduce = true;
    const view = setup();
    view.drag();
    touch(view.button, "touchend", []);
    expect(view.progress.at(-1)).toBeCloseTo(1, 4);
    view.engine.scrollTo(2);
    expect(view.active()).toBe(2);
    expect(view.progress.at(-1)).toBeCloseTo(2, 4);
  });

  it("commits a newer explicit tab request while cancelling the held drag", () => {
    const view = setup();
    view.drag();
    view.engine.scrollTo(2);
    expect(view.commits).toEqual([2]);
    touch(view.button, "touchend", []);
    advance(180);
    expect(view.commits).toEqual([2]);
    expect(view.progress.at(-1)).toBeCloseTo(2, 2);
  });

  it("invalidates queued movement on resize and removes its listeners on disposal", () => {
    const view = setup();
    view.drag();
    view.engine.resize();
    touch(view.button, "touchend", []);
    advance(120);
    expect(view.commits).toEqual([]);
    view.engine.destroy();
    view.drag();
    touch(view.button, "touchend", []);
    advance(120);
    expect(view.commits).toEqual([]);
    expect(view.track.style.transform).toBe("");
  });
});
