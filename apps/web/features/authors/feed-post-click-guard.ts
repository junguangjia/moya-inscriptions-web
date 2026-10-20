import { FEED_POST_CLICK_SUPPRESSION_MS } from "./feed-post-strip-geometry";

/*
 * A pointer tap that opened Detail from a feed post keeps the rest of its
 * gesture: the second click of a double tap on body text would otherwise
 * land on the Detail now covering the feed (its image opens the Viewer or
 * likes, its Back closes it again). Keyboard and assistive activation
 * (`detail` 0) always pass.
 */

let until = 0;
let timer: number | null = null;
let listening = false;

const swallow = (event: MouseEvent) => {
  // A timer that ran late never holds clicks past the deadline.
  if (performance.now() >= until) {
    release();
    return;
  }
  if (event.detail === 0) return;
  event.preventDefault();
  event.stopPropagation();
};

const release = () => {
  if (timer !== null) window.clearTimeout(timer);
  timer = null;
  until = 0;
  if (listening) document.removeEventListener("click", swallow, true);
  listening = false;
};

/**
 * Ignores pointer clicks anywhere in the document for `ms`; arming it again
 * extends the time and adds no second listener.
 */
export const suppressFollowingPointerClicks = (
  ms = FEED_POST_CLICK_SUPPRESSION_MS,
): void => {
  if (typeof document === "undefined") return;
  const now = performance.now();
  until = Math.max(until, now + ms);
  if (timer !== null) window.clearTimeout(timer);
  timer = window.setTimeout(release, until - now);
  if (!listening) {
    document.addEventListener("click", swallow, true);
    listening = true;
  }
};

/** Only for tests: lets every click through again. */
export const resetFeedPostClickGuard = (): void => release();
