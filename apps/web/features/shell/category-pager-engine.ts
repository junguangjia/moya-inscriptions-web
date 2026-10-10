import EmblaCarousel from "embla-carousel";

interface CategoryPagerCallbacks {
  readonly canStartGesture?: () => boolean;
  readonly getCommittedIndex: () => number;
  readonly onCommit: (index: number) => void;
  readonly onProgress: (progress: number) => void;
  readonly onMotion: (moving: boolean) => void;
}

export interface CategoryPagerEngine {
  readonly scrollTo: (index: number) => void;
  readonly sync: (index: number) => void;
  readonly resize: () => void;
  readonly destroy: () => void;
}

// A card-level horizontal scroller owns every single-finger gesture that
// starts inside it; the pager stays idle for that whole touch.
const isLocalHorizontal = (target: EventTarget | null) =>
  target instanceof Element &&
  target.closest("[data-local-horizontal]") !== null;

// Only the category pager hosts use this adapter. Embla owns direction,
// velocity, track movement and interruption; the hosts retain business state.
export function createCategoryPagerEngine(
  frame: HTMLElement,
  callbacks: CategoryPagerCallbacks,
): CategoryPagerEngine {
  const win = frame.ownerDocument.defaultView!;
  let disposed = false;
  let resetting = false;
  let blocked = false;
  let contacts = 0;
  let origin = callbacks.getCommittedIndex();
  let touchTarget: Element | null = null;
  let touching = false;
  let released = false;
  let suppressClick = false;
  let freshNonTouchPress = false;
  let startX = 0;
  let startY = 0;
  let dragged = false;
  let awaitingCancelableInput = false;
  const reducedMotion = () =>
    win.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const menuOpen = () =>
    touchTarget
      ?.closest("[data-quick-actions]")
      ?.getAttribute("data-quick-action-phase") === "menu-open";
  const progress = () => {
    if (!disposed)
      callbacks.onProgress(
        Math.max(
          0,
          Math.min(
            api.scrollSnapList().length - 1,
            api.scrollProgress() * (api.scrollSnapList().length - 1),
          ),
        ),
      );
  };
  const reset = () => {
    if (disposed) return;
    resetting = true;
    touching = false;
    released = false;
    api.reInit({ startIndex: callbacks.getCommittedIndex() });
    resetting = false;
    callbacks.onMotion(false);
    progress();
  };
  const cancel = () => {
    blocked = contacts > 0;
    suppressClick ||= dragged || menuOpen();
    reset();
  };
  const start = (event: TouchEvent) => {
    if (contacts === 0 && isLocalHorizontal(event.target)) {
      // A previous drag's tail click has already been delivered by now.
      suppressClick = false;
      return;
    }
    if (contacts === 0 && callbacks.canStartGesture?.() === false) return;
    if (!frame.contains(event.target as Node) && contacts === 0) return;
    if (event.touches.length > 1) {
      contacts = event.touches.length;
      cancel();
      return;
    }
    if (!frame.contains(event.target as Node)) return;
    contacts = event.touches.length;
    if (blocked) return;
    touchTarget = event.target instanceof Element ? event.target : null;
    origin = callbacks.getCommittedIndex();
    startX = event.touches[0]?.clientX ?? 0;
    startY = event.touches[0]?.clientY ?? 0;
    dragged = false;
    suppressClick = false;
    freshNonTouchPress = false;
    touching = true;
    released = false;
    awaitingCancelableInput = !event.cancelable;
  };
  const move = (event: TouchEvent) => {
    if (contacts === 0) return;
    if (event.touches.length > 1 || menuOpen()) {
      if (!blocked) cancel();
      return;
    }
    if (!touching || blocked) return;
    const point = event.touches[0];
    if (point && Math.hypot(point.clientX - startX, point.clientY - startY) > 8)
      dragged = true;
  };
  const end = (event: TouchEvent) => {
    if (contacts === 0) return;
    contacts = event.touches.length;
    if (contacts === 0) {
      if (blocked) {
        blocked = false;
        touching = false;
        released = false;
      } else if (touching) {
        released = true;
        suppressClick = dragged;
      }
    }
  };
  const touchCancel = () => {
    cancel();
    contacts = 0;
    blocked = false;
  };
  const momentumHandoff = (event: TouchEvent) => {
    if (!touching || blocked || isLocalHorizontal(event.target)) return;
    // Safari can deliver a few sub-drag pixels before native scrolling starts.
    // Do not let floating-point axis differences in that initial noise latch
    // Embla's direction. Once the existing drag threshold is crossed, the core
    // owns every later move, including movement back through the origin.
    if (!dragged) {
      event.stopPropagation();
      return;
    }
    if (!awaitingCancelableInput) return;
    if (event.cancelable) {
      awaitingCancelableInput = false;
      return;
    }
    // A fresh touch can initially belong to the browser's previous vertical
    // fling. Keep that noncancelable delivery out of Embla's release path;
    // subsequent cancelable input is still handled by its original session.
    // Vertical-first input reaches Embla's ordinary release and then stays
    // blocked, even if later events in the same touch become cancelable.
    const point = event.touches[0];
    if (
      point &&
      Math.abs(point.clientY - startY) >= Math.abs(point.clientX - startX)
    ) {
      // Let Embla release its current drag when native vertical scrolling
      // owns this event. Rebuilding here would remove and reattach persistent
      // touch listeners during the same native scrolling handoff.
      awaitingCancelableInput = false;
      return;
    }
    event.stopPropagation();
  };
  // Capture runs before Embla's touch listeners. Cancelling uses its public
  // lifecycle API, so a second finger cannot take the ordinary release path.
  win.addEventListener("touchstart", start, { capture: true, passive: true });
  win.addEventListener("touchmove", move, { capture: true, passive: true });
  win.addEventListener("touchend", end, { capture: true, passive: true });
  win.addEventListener("touchcancel", touchCancel, {
    capture: true,
    passive: true,
  });
  frame.addEventListener("touchmove", momentumHandoff, {
    capture: true,
    passive: true,
  });

  const api = EmblaCarousel(frame, {
    axis: "x",
    align: "start",
    loop: false,
    slidesToScroll: 1,
    dragFree: false,
    skipSnaps: false,
    startIndex: origin,
    watchFocus: false,
    watchResize: false,
    watchSlides: false,
    watchDrag: (_api, event) =>
      callbacks.canStartGesture?.() !== false &&
      "touches" in event &&
      event.touches.length === 1 &&
      !blocked &&
      !menuOpen() &&
      !isLocalHorizontal(event.target),
  });
  const commit = (explicit = false) => {
    if (disposed || resetting || (blocked && !explicit)) return;
    let target = api.selectedScrollSnap();
    if (touching) {
      if (!released) return;
      target = Math.max(origin - 1, Math.min(origin + 1, target));
      if (target !== api.selectedScrollSnap()) {
        api.scrollTo(target, reducedMotion());
        return;
      }
    }
    if (target !== callbacks.getCommittedIndex()) {
      callbacks.onCommit(target);
      // The host's active-category effect may reset its indicator to an
      // integer. Restore the actual visual progress in the same input task.
      progress();
    }
  };
  const up = () => {
    if (disposed || blocked) return;
    // Embla also releases when vertical scrolling wins. That path must not
    // turn an interrupted visual tail into a new business selection.
    if (touching && !released) {
      // Embla has already removed this drag's listeners. Keep its root and
      // transformed track intact while the browser takes vertical ownership.
      blocked = contacts > 0;
      suppressClick ||= dragged;
      touching = false;
      released = false;
      const committed = callbacks.getCommittedIndex();
      if (api.selectedScrollSnap() !== committed)
        api.scrollTo(committed, reducedMotion());
      return;
    }
    commit();
    touching = false;
    released = false;
    // A release has already set Embla's target. scrollTo(sameIndex, true)
    // would have zero target distance and would not flush the pending motion.
    if (reducedMotion()) reset();
  };
  const scroll = () => {
    callbacks.onMotion(true);
    progress();
  };
  const settle = () => {
    if (disposed) return;
    callbacks.onMotion(false);
    progress();
  };
  api
    .on("select", () => commit())
    .on("pointerUp", up)
    .on("scroll", scroll)
    .on("settle", settle);
  const click = (event: MouseEvent) => {
    if (!frame.contains(event.target as Node)) return;
    // Window capture precedes Embla's frame capture. Assistive activation
    // need not have a preceding keydown or physical press.
    if (event.detail === 0 || freshNonTouchPress) {
      freshNonTouchPress = false;
      suppressClick = false;
      reset();
      return;
    }
    if (event.detail !== 0 && suppressClick) {
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
    }
  };
  const pointerStart = (event: PointerEvent) => {
    if (
      event.button !== 0 ||
      (event.pointerType !== "mouse" && event.pointerType !== "pen") ||
      !frame.contains(event.target as Node)
    )
      return;
    suppressClick = false;
    // Compatibility mousedown after touch has no fresh non-touch pointerdown.
    // Defer the engine reset until the browser has chosen the click target,
    // so clearing its token cannot move a card between down and up.
    freshNonTouchPress = true;
  };
  const key = (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    suppressClick = false;
    reset();
  };
  const hidden = () => {
    if (frame.ownerDocument.visibilityState !== "visible") cancel();
  };
  win.addEventListener("click", click, true);
  win.addEventListener("pointerdown", pointerStart, true);
  frame.addEventListener("keydown", key, true);
  frame.ownerDocument.addEventListener("visibilitychange", hidden);
  win.addEventListener("pagehide", cancel);
  win.addEventListener("blur", cancel);
  win.addEventListener("orientationchange", cancel);
  win.visualViewport?.addEventListener("resize", cancel);
  progress();
  return {
    scrollTo(index) {
      if (disposed) return;
      if (touching) cancel();
      api.scrollTo(index, reducedMotion());
      // A new tab request owns the selection even while the cancelled
      // touch remains blocked until all fingers leave the surface.
      commit(true);
      progress();
    },
    sync(index) {
      if (disposed || api.selectedScrollSnap() === index) return;
      cancel();
      api.scrollTo(index, true);
    },
    resize: cancel,
    destroy() {
      disposed = true;
      api.destroy();
      win.removeEventListener("touchstart", start, true);
      win.removeEventListener("touchmove", move, true);
      win.removeEventListener("touchend", end, true);
      win.removeEventListener("touchcancel", touchCancel, true);
      frame.removeEventListener("touchmove", momentumHandoff, true);
      win.removeEventListener("click", click, true);
      win.removeEventListener("pointerdown", pointerStart, true);
      frame.removeEventListener("keydown", key, true);
      frame.ownerDocument.removeEventListener("visibilitychange", hidden);
      win.removeEventListener("pagehide", cancel);
      win.removeEventListener("blur", cancel);
      win.removeEventListener("orientationchange", cancel);
      win.visualViewport?.removeEventListener("resize", cancel);
    },
  };
}
