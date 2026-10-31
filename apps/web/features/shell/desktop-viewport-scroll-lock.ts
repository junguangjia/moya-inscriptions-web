"use client";

import { readRuntimeDeviceClass } from "./device-platform";

let locks = 0;
let snapshot: {
  readonly element: HTMLElement;
  readonly value: string;
  readonly priority: string;
} | null = null;

/** Pair with existing modal owners; WebKit can retain the desktop HTML gutter. */
export const acquireDesktopViewportScrollLock = (): (() => void) => {
  if (
    typeof document === "undefined" ||
    typeof navigator === "undefined" ||
    readRuntimeDeviceClass(navigator) !== "desktop"
  )
    return () => {};

  const element = document.documentElement;
  if (snapshot === null) {
    snapshot = {
      element,
      value: element.style.getPropertyValue("overflow-y"),
      priority: element.style.getPropertyPriority("overflow-y"),
    };
    element.style.setProperty("overflow-y", "hidden", snapshot.priority);
  }
  locks += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    locks -= 1;
    if (locks !== 0 || snapshot === null) return;
    const previous = snapshot;
    snapshot = null;
    if (previous.value === "")
      previous.element.style.removeProperty("overflow-y");
    else
      previous.element.style.setProperty(
        "overflow-y",
        previous.value,
        previous.priority,
      );
  };
};
