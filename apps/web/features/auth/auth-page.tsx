"use client";

import { useEffect, useState } from "react";
import { Button } from "@moya/ui";
import { useRouter } from "next/navigation";
import { AuthFlow } from "./auth-flow";
import { safeReturnPath } from "./auth-api";
import { useAuthReturn } from "./auth-return";
import { authorClient, AuthorRequestError } from "../authors/author-data";

export const AuthPage = ({
  mode,
  returnTo,
}: {
  readonly mode: "sign-in" | "register";
  readonly returnTo: string;
}) => {
  const router = useRouter();
  const context = useAuthReturn();
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    setFailed(false);
    // The existing /me relay clears only a refused session cookie. Do not
    // submit an auth write with a known stale cookie, or sign out on transport failure.
    void authorClient
      .me(controller.signal)
      .then(() => {
        if (!live) return;
        setReady(true);
      })
      .catch((error: unknown) => {
        if (!live) return;
        if (error instanceof AuthorRequestError && error.status === 401)
          setReady(true);
        else setFailed(true);
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [revision]);
  const returnToSource = (destination: string) => {
    if (context) {
      context.inputs.email = "";
      context.inputs.phone = "";
      context.inputs.channel = "email";
    }
    if (context?.hasSource()) router.back();
    else router.replace(safeReturnPath(destination), { scroll: false });
  };
  if (!ready)
    return (
      <main
        style={{
          maxWidth: "28rem",
          margin: "auto",
          padding: "var(--yoyi-space-8) var(--yoyi-space-5)",
        }}
        aria-live="polite"
      >
        <p>{failed ? "暂时无法连接登录服务，请重试。" : "正在准备登录…"}</p>
        {failed && (
          <Button onClick={() => setRevision((old) => old + 1)}>重试</Button>
        )}
        <Button variant="quiet" onClick={() => returnToSource(returnTo)}>
          返回原页面
        </Button>
      </main>
    );
  return (
    <AuthFlow
      mode={mode}
      returnTo={returnTo}
      {...(context
        ? {
            initialEmail: context.inputs.email,
            initialPhone: context.inputs.phone,
            initialChannel: context.inputs.channel,
          }
        : {})}
      onInputChange={(channel, value) => {
        if (context) context.inputs[channel] = value;
      }}
      onChannelChange={(channel) => {
        if (context) context.inputs.channel = channel;
      }}
      onModeChange={(next) =>
        router.replace(
          `${next === "register" ? "/register" : "/login"}?return=${encodeURIComponent(safeReturnPath(returnTo))}`,
          { scroll: true },
        )
      }
      onReturn={returnToSource}
    />
  );
};
