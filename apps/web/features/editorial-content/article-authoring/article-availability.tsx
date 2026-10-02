"use client";
import { createContext, useContext } from "react";
import type { ReactNode } from "react";
const Availability = createContext(false);
export const ArticleAvailability = ({
  enabled,
  children,
}: {
  readonly enabled: boolean;
  readonly children: ReactNode;
}) => <Availability.Provider value={enabled}>{children}</Availability.Provider>;
export const useArticleAvailability = () => useContext(Availability);
