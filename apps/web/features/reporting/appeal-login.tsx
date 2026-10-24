"use client";
import { useEffect, useRef, useState } from "react";
import type {
  AuthCapabilities,
  AuthChallengeAccepted,
  AuthPasswordLoginRequest,
  CommunityAppealSession,
} from "@moya/contracts";
import { requestIdentity } from "../shell/request-identity";
import { appealClient } from "./reporting-data";
import { ReportingCases } from "./reporting-cases";
import styles from "./reporting.module.css";
import authStyles from "../auth/auth-flow.module.css";

export const AppealLogin = () => {
  const [session, setSession] = useState<CommunityAppealSession | null>(null);
  const [capabilities, setCapabilities] = useState<AuthCapabilities | null>(
    null,
  );
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [mode, setMode] = useState<"password" | "code">("password");
  const [channel, setChannel] =
    useState<AuthPasswordLoginRequest["channel"]>("email");
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState<AuthChallengeAccepted | null>(
    null,
  );
  const [now, setNow] = useState(Date.now);
  const pending = useRef<{ identity: string; id: string } | null>(null);
  const inFlight = useRef(false);
  useEffect(() => {
    let active = true;
    setChecking(true);
    setError("");
    void Promise.all([appealClient.session(), appealClient.capabilities()])
      .then(([current, available]) => {
        if (!active) return;
        setSession(current);
        setCapabilities(available);
        const identifiers = available.password?.identifiers ?? ["email"];
        setChannel(identifiers[0] ?? "email");
        if (available.password?.available === false) {
          setMode("code");
          setChannel(available.email.available ? "email" : "phone");
        }
      })
      .catch((failure) => {
        if (active)
          setError(
            failure instanceof Error
              ? failure.message
              : "登录服务暂不可用，请重试",
          );
      })
      .finally(() => {
        if (active) setChecking(false);
      });
    return () => {
      active = false;
    };
  }, [revision]);
  useEffect(() => {
    if (!challenge) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [challenge]);
  const run = async (operation: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "验证未完成，请重试",
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const key = (identity: string) => {
    if (pending.current?.identity !== identity)
      pending.current = { identity, id: requestIdentity() };
    return pending.current.id;
  };
  const submit = () =>
    void run(async () => {
      if (mode === "password") {
        const value = { channel, identifier: identifier.trim(), password };
        const loggedIn = await appealClient.login({
          ...value,
          idempotencyKey: key(JSON.stringify(value)),
        });
        setPassword("");
        pending.current = null;
        setSession(loggedIn);
      } else {
        if (!challenge?.continuationToken || !/^\d{6}$/u.test(code)) return;
        const value = {
          challengeId: challenge.challengeId,
          code,
          continuationToken: challenge.continuationToken,
        };
        const loggedIn = await appealClient.verify({
          ...value,
          idempotencyKey: key(JSON.stringify(value)),
        });
        setCode("");
        setChallenge(null);
        pending.current = null;
        setSession(loggedIn);
      }
    });
  const send = () =>
    void run(async () => {
      if (channel === "handle") return;
      const value = {
        channel,
        identifier: identifier.trim(),
        purpose: "sign_in" as const,
      };
      const accepted = await appealClient.challenge({
        ...value,
        idempotencyKey: key(JSON.stringify(value)),
      });
      const continuationToken =
        accepted.continuationToken ??
        (accepted.challengeId === challenge?.challengeId
          ? challenge.continuationToken
          : undefined);
      if (!continuationToken) {
        pending.current = null;
        throw new Error("无法继续验证，请重新获取验证码");
      }
      setChallenge({ ...accepted, continuationToken });
      setCode("");
      pending.current = null;
    });
  const channels =
    mode === "password"
      ? (capabilities?.password?.identifiers ??
        (["email", "phone", "handle"] as const))
      : (["email", "phone"] as const);
  const resendSeconds = challenge
    ? Math.max(
        0,
        Math.ceil((Date.parse(challenge.resendAvailableAt) - now) / 1000),
      )
    : 0;
  return (
    <main className={authStyles.page}>
      <nav className={authStyles.navigation} aria-label="申诉导航">
        <a href="/login">返回登录</a>
        <a href="/policies/reporting">举报与申诉说明</a>
      </nav>
      <section className={authStyles.panel}>
        <h1>{session ? "处置与申诉" : "申诉登录"}</h1>
        {checking ? (
          <p role="status">正在准备申诉入口…</p>
        ) : session ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await appealClient.signOut();
                  setSession(null);
                  setPassword("");
                  setCode("");
                  setChallenge(null);
                  pending.current = null;
                })
              }
            >
              退出申诉登录
            </button>
            <ReportingCases account={session.profile.id} restricted />
          </>
        ) : (
          <>
            <p className={styles.note}>
              使用原账号验证身份后，可以查看处置理由并提交申诉。账号限制继续生效。
            </p>
            {capabilities === null ? (
              <button
                type="button"
                onClick={() => setRevision((value) => value + 1)}
              >
                重试连接
              </button>
            ) : (
              <form
                className={styles.form}
                onSubmit={(event) => {
                  event.preventDefault();
                  submit();
                }}
              >
                <label>
                  验证方式
                  <select
                    value={mode}
                    disabled={busy}
                    onChange={(event) => {
                      const next = event.target.value as "password" | "code";
                      setMode(next);
                      setChallenge(null);
                      setCode("");
                      setError("");
                      pending.current = null;
                      setChannel(
                        next === "code"
                          ? capabilities.email.available
                            ? "email"
                            : "phone"
                          : (capabilities.password?.identifiers[0] ?? "email"),
                      );
                    }}
                  >
                    <option
                      value="password"
                      disabled={capabilities.password?.available === false}
                    >
                      密码
                    </option>
                    <option
                      value="code"
                      disabled={
                        !capabilities.email.available &&
                        !capabilities.phone.available
                      }
                    >
                      验证码
                    </option>
                  </select>
                </label>
                <label>
                  账号类型
                  <select
                    value={channel}
                    disabled={busy || challenge !== null}
                    onChange={(event) => {
                      setChannel(event.target.value as typeof channel);
                      setIdentifier("");
                      setError("");
                      pending.current = null;
                    }}
                  >
                    {channels.map((value) => (
                      <option
                        key={value}
                        value={value}
                        disabled={
                          mode === "code" &&
                          value !== "handle" &&
                          !capabilities[value].available
                        }
                      >
                        {value === "email"
                          ? "邮箱"
                          : value === "phone"
                            ? "手机号"
                            : "用户名"}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {channel === "email"
                    ? "邮箱"
                    : channel === "phone"
                      ? "手机号"
                      : "用户名"}
                  <input
                    autoComplete="username"
                    type={channel === "email" ? "email" : "text"}
                    inputMode={channel === "phone" ? "tel" : undefined}
                    required
                    maxLength={254}
                    value={identifier}
                    disabled={busy || challenge !== null}
                    onChange={(event) => setIdentifier(event.target.value)}
                  />
                </label>
                {mode === "password" ? (
                  <label>
                    密码
                    <input
                      type="password"
                      autoComplete="current-password"
                      required
                      maxLength={80}
                      value={password}
                      disabled={busy}
                      onChange={(event) => setPassword(event.target.value)}
                    />
                  </label>
                ) : (
                  <>
                    {challenge && (
                      <p className={styles.note}>
                        验证码已发送至 {challenge.maskedTarget}
                      </p>
                    )}
                    <button
                      type="button"
                      disabled={busy || !identifier.trim() || resendSeconds > 0}
                      onClick={send}
                    >
                      {resendSeconds > 0
                        ? `${resendSeconds} 秒后可重新发送`
                        : challenge
                          ? "重新发送验证码"
                          : "获取验证码"}
                    </button>
                    {challenge && (
                      <>
                        <label>
                          验证码
                          <input
                            inputMode="numeric"
                            autoComplete="one-time-code"
                            pattern="[0-9]{6}"
                            minLength={6}
                            maxLength={6}
                            required
                            value={code}
                            disabled={busy}
                            onChange={(event) =>
                              setCode(
                                event.target.value
                                  .replace(/\D/gu, "")
                                  .slice(0, 6),
                              )
                            }
                          />
                        </label>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setChallenge(null);
                            setCode("");
                            pending.current = null;
                          }}
                        >
                          更换账号
                        </button>
                      </>
                    )}
                  </>
                )}
                <button
                  type="submit"
                  disabled={
                    busy ||
                    !identifier.trim() ||
                    (mode === "password"
                      ? !password
                      : !challenge || !/^\d{6}$/u.test(code))
                  }
                >
                  {busy ? "正在验证…" : "验证并查看申诉"}
                </button>
              </form>
            )}
          </>
        )}
        {error && <p role="alert">{error}</p>}
      </section>
    </main>
  );
};
