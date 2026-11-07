"use client";

import { createContext } from "react";

/** Detail's outer scroller remains the owner across the two content pages. */
export const CatalogDetailScrollContext = createContext<{
  readonly read: () => number;
  /**
   * Scrolls to `top`. With `anchor` (a section the reader asked for), later
   * content changes above it bring that section back, until the reader
   * moves (timeline-posts-v1).
   */
  readonly restore: (top: number, anchor?: HTMLElement) => void;
  readonly collapseTop: (section: HTMLElement) => number;
  /**
   * Content changed height after paint (the desktop band,
   * timeline-posts-v1): `below` is the collapseTop position where the
   * change ended before it. A section the reader asked for is brought back;
   * a saved place the reader has not moved from is applied again; a reader
   * at or past `below` keeps their place.
   */
  readonly shift?: (below: number, delta: number) => void;
} | null>(null);
