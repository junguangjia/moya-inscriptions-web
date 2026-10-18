"use client";

import { createContext, useContext } from "react";

/** Shared by the calligraphy image gestures and the existing action controller. */
export interface DetailInteractions {
  readonly onComment: (opener: HTMLElement) => void;
  readonly registerLike: (like: () => void, enabled: boolean) => () => void;
}

export const DetailInteractionsContext =
  createContext<DetailInteractions | null>(null);

export const useDetailInteractions = () =>
  useContext(DetailInteractionsContext);
