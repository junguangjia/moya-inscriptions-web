"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@moya/ui";

import { authRequest, safeReturnPath } from "../auth/auth-api";
import {
  authorClient,
  PRODUCT_ACCESS_REFUSED_EVENT,
} from "../authors/author-data";
import styles from "./product-access-notice.module.css";

/**
 * Leaves for the existing sign-in flow with a full navigation, so the page is
 * rendered again by the server once a session exists. The destination is the
 * address the visitor asked for, fragment included.
 */
export const ProductAccessSignIn = () => {
  const destination = useRef<HTMLInputElement>(null);
  const here = () =>
    safeReturnPath(
      `${window.location.pathname}${window.location.search}${window.location.hash}`,
    );
  useEffect(() => {
    if (destination.current) destination.current.value = here();
  }, []);
  return (
    <form
      action="/login"
      method="get"
      onSubmit={() => {
        if (destination.current) destination.current.value = here();
      }}
    >
      <input defaultValue="/" name="return" ref={destination} type="hidden" />
      <Button className={styles.action} size="lg" type="submit">
        登录
      </Button>
    </form>
  );
};

/** Ends the session through the existing sign-out operation, then asks the server again. */
export const ProductAccessSignOut = () => {
  const [state, setState] = useState<"idle" | "busy" | "failed">("idle");
  return (
    <>
      {state === "failed" && (
        <p className={styles.error} role="alert">
          退出未能确认，请重试。
        </p>
      )}
      <Button
        className={styles.action}
        loading={state === "busy"}
        size="lg"
        variant="secondary"
        onClick={() => {
          setState("busy");
          void authRequest("sign-out", { method: "POST", body: {} })
            .then((result) => {
              if (result.status >= 200 && result.status < 300)
                window.location.reload();
              else setState("failed");
            })
            .catch(() => setState("failed"));
        }}
      >
        退出登录
      </Button>
    </>
  );
};

export const ProductAccessRetry = () => (
  <Button
    className={styles.action}
    size="lg"
    variant="secondary"
    onClick={() => window.location.reload()}
  >
    重试
  </Button>
);

/**
 * Keeps what is on screen in step with the Backend's answer. When the visitor
 * returns to the page (focus, visibility, or a page restored from the
 * back-forward cache) or a request was refused, it asks again; a different
 * answer reloads, so the server renders the right state and everything this
 * page held in memory is dropped. A failed question changes nothing.
 */
export const ProductAccessWatcher = ({
  expected,
}: {
  readonly expected:
    "granted" | "sign_in_required" | "restricted" | "unavailable";
}) => {
  useEffect(() => {
    let live = true;
    let asking = false;
    const ask = () => {
      if (asking || document.visibilityState !== "visible") return;
      asking = true;
      void authorClient
        .access()
        .then((access) => {
          if (live && access !== expected) window.location.reload();
        })
        .catch(() => undefined)
        .finally(() => {
          asking = false;
        });
    };
    window.addEventListener("focus", ask);
    window.addEventListener("pageshow", ask);
    window.addEventListener(PRODUCT_ACCESS_REFUSED_EVENT, ask);
    document.addEventListener("visibilitychange", ask);
    return () => {
      live = false;
      window.removeEventListener("focus", ask);
      window.removeEventListener("pageshow", ask);
      window.removeEventListener(PRODUCT_ACCESS_REFUSED_EVENT, ask);
      document.removeEventListener("visibilitychange", ask);
    };
  }, [expected]);
  return null;
};
