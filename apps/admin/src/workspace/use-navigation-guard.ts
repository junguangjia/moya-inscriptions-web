"use client";

import { useEffect } from "react";

/** Keep pending command identities mounted until their result is reconciled. */
export function useNavigationGuard(blocked: boolean, onBlocked: () => void) {
  useEffect(() => {
    if (!blocked) return;
    const click = (event: MouseEvent) => {
      const link = (event.target as Element | null)?.closest<HTMLAnchorElement>(
        "a[href]",
      );
      if (
        !link ||
        link.target === "_blank" ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const target = new URL(link.href, window.location.href);
      if (
        target.origin !== window.location.origin ||
        !target.pathname.startsWith("/admin")
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onBlocked();
    };
    const leave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    document.addEventListener("click", click, true);
    window.addEventListener("beforeunload", leave);
    return () => {
      document.removeEventListener("click", click, true);
      window.removeEventListener("beforeunload", leave);
    };
  }, [blocked, onBlocked]);
}
