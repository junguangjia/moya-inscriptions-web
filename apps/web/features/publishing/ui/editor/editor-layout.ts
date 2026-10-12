"use client";

import { useSyncExternalStore } from "react";

import { useProductShell } from "../../../product-shell/product-shell";

import type { PresentationPlatform } from "../../../shell/device-platform";

/**
 * Which editor the overlay shows (design §11.1): the desktop editor on a PC
 * and on a wide tablet, the phone steps everywhere else. The phone composer
 * screens (#244) follow the same decision, so it lives in one place.
 */

/** Wide tablets use the desktop editor from this width (design §11.1). */
export const DESKTOP_MINIMUM_WIDTH = 896;

export type EditorLayout = "phone" | "desktop";

const subscribeResize = (listener: () => void) => {
  window.addEventListener("resize", listener);
  window.addEventListener("orientationchange", listener);
  return () => {
    window.removeEventListener("resize", listener);
    window.removeEventListener("orientationchange", listener);
  };
};

const useViewportWidth = () =>
  useSyncExternalStore(
    subscribeResize,
    () => window.innerWidth,
    () => DESKTOP_MINIMUM_WIDTH,
  );

export const editorLayout = (
  platform: PresentationPlatform,
  width: number,
): EditorLayout =>
  platform === "pc" || (platform === "tablet" && width >= DESKTOP_MINIMUM_WIDTH)
    ? "desktop"
    : "phone";

/**
 * Set on the editor host by its viewport frame ("true" while the on-screen
 * keyboard takes part of the viewport), for the phone 发布 bar (G22).
 */
export const KEYBOARD_ATTRIBUTE = "data-editor-keyboard";

/** The editor layout for the shell's platform and the viewport width now. */
export const useEditorLayout = (): EditorLayout => {
  const shell = useProductShell();
  const width = useViewportWidth();
  return editorLayout(shell.platform, width);
};
