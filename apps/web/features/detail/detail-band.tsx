"use client";

import { createContext, useContext } from "react";
import { createPortal } from "react-dom";

import type { ReactNode } from "react";

/**
 * A full-width band under the desktop Detail's first screen, before the
 * reading below it (timeline-posts-v1). The desktop composition keeps its
 * actions slot under the image, so a section taller than the actions
 * renders here instead and the image keeps the first screen. Elsewhere
 * there is no band and the section stays where its caller put it.
 */
export const DetailBandContext = createContext<HTMLElement | null>(null);

export const DetailBand = ({ children }: { readonly children: ReactNode }) => {
  const band = useContext(DetailBandContext);
  return band === null ? children : createPortal(children, band);
};

/** Whether the section renders in the desktop band. */
export const useInDetailBand = (): boolean =>
  useContext(DetailBandContext) !== null;
