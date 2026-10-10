"use client";
import { useSyncExternalStore } from "react";

/*
 * One colophon composer across the feed: opening one claims the bar, and any
 * composer that no longer holds the claim closes.
 */
let claimed: string | null = null;
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of [...listeners]) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Takes the composer for `key`, closing whichever held it. */
export const claimColophonComposer = (key: string): void => {
  if (claimed === key) return;
  claimed = key;
  emit();
};

/** Gives the composer up, only when `key` still holds it. */
export const releaseColophonComposer = (key: string): void => {
  if (claimed !== key) return;
  claimed = null;
  emit();
};

/** The key holding the composer, if any. */
export const currentColophonComposer = (): string | null => claimed;

/** Whether `key` holds the composer. */
export const useColophonComposerClaimed = (key: string): boolean =>
  useSyncExternalStore(
    subscribe,
    () => claimed === key,
    () => false,
  );
