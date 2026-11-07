"use client";

import { createContext } from "react";

/** Detail's outer scroller remains the owner across the two content pages. */
export const CatalogDetailScrollContext = createContext<{
  readonly read: () => number;
  readonly restore: (top: number) => void;
  readonly collapseTop: (section: HTMLElement) => number;
  /**
   * Content above the reader changed height after paint (the desktop band,
   * timeline-posts-v1): `below` is the collapseTop position where the
   * change ends. A reader at or past it keeps their place; a saved place
   * still waiting for that content is applied again instead.
   */
  readonly shift?: (below: number, delta: number) => void;
} | null>(null);
