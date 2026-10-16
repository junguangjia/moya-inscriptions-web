"use client";

import { createContext, useContext } from "react";

const BrowseOnlyContext = createContext(false);

/** ProductShell provides it; false outside a shell and without a policy. */
export const BrowseOnlyProvider = BrowseOnlyContext.Provider;

/**
 * Whether the shell is browse-only (pc-browse-only-v1), for components that
 * need nothing else from it: they re-render only when it changes, never with
 * every shell render.
 */
export const useBrowseOnly = (): boolean => useContext(BrowseOnlyContext);
