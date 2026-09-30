"use client";

import { useEffect, useImperativeHandle, useRef, useState } from "react";
import type { RefObject } from "react";

import { requestIdentity } from "../shell/request-identity";
import { authRequest } from "./auth-api";
import type { AuthAccountView } from "./auth-api";

import styles from "./account-security.module.css";

type Channel = "email" | "phone";
type Action = "link" | "replace" | "unlink";
type Step = "proof" | "identifier" | "factor";

interface FactorFlow {
  readonly action: Action;
  readonly target: Channel;
  readonly proof: Channel;
  readonly step: Step;
  readonly challengeId: string;
  readonly continuation: string;
  readonly reauthToken: string;
  readonly expectedVersion: number;
  readonly masked: string;
}

const labels = { email: "邮箱", phone: "手机号" } as const;
const states = {
  unbound: "未绑定",
  verified: "已验证",
  unavailable: "当前不可用",
  pending: "操作进行中",
} as const;
const reasons: Record<string, string> = {
  AUTH_CHANNEL_UNAVAILABLE: "这个登录方式当前不可用。",
  AUTH_INVALID_IDENTIFIER: "请检查邮箱或手机号格式。",
  AUTH_CODE_EXHAUSTED: "尝试次数已用完，请稍后再试。",
  AUTH_CODE_INVALID: "验证码不正确。",
  AUTH_CODE_EXPIRED: "验证码已过期，请重新获取。",
  AUTH_CODE_SUPERSEDED: "这是较早的验证码，请使用最新的一封。",
  AUTH_PROOF_REJECTED: "这次验证已失效，请重新开始。",
  AUTH_IDENTIFIER_CONFLICT: "这个联系方式无法绑定到当前账户。",
  AUTH_LAST_FACTOR: "至少需要保留一种可用的登录方式。",
  AUTH_STALE_VERSION: "账户信息已变化，请刷新后再试。",
  AUTH_UNAUTHENTICATED: "请重新登录。",
  AUTH_DELIVERY_FAILED: "验证消息没有发出，请稍后重试。",
  AUTH_DELIVERY_UNKNOWN: "发送结果不确定，请稍后再试，不要立刻重复提交。",
  AUTH_PROVENANCE_REJECTED: "这条验证记录不能在当前环境使用。",
};

const messageOf = (body: unknown): string => {
  if (typeof body !== "object" || body === null || !("error" in body))
    return "请求失败，请稍后重试。";
  const error = body.error;
  if (typeof error !== "object" || error === null || !("message" in error))
    return "请求失败，请稍后重试。";
  return reasons[String(error.message)] ?? "请求失败，请稍后重试。";
};

const digits = (value: string): string => value.replace(/\D/gu, "").slice(0, 6);

const proofFor = (
  account: AuthAccountView,
  target: Channel,
): Channel | null => {
  const other: Channel = target === "email" ? "phone" : "email";
  if (account[other].usable) return other;
  if (account[target].usable) return target;
  return null;
};

const emptyFlow = (
  action: Action,
  target: Channel,
  proof: Channel,
  expectedVersion: number,
): FactorFlow => ({
  action,
  target,
  proof,
  step: "proof",
  challengeId: "",
  continuation: "",
  reauthToken: "",
  expectedVersion,
  masked: "",
});

export interface AccountSecurityHandle {
  cancelFlow: () => boolean;
}

export const AccountSecurity = ({
  expectedViewerId,
  onBusyChange,
  onFlowChange,
  navigationRef,
  guardSignOut,
  onSignedOut,
}: {
  expectedViewerId?: string;
  onBusyChange?: (busy: boolean) => void;
  guardSignOut?: () => boolean;
  onSignedOut?: () => void;
  onFlowChange?: (title: string | null) => void;
  navigationRef?: RefObject<AccountSecurityHandle | null>;
} = {}) => {
  const generation = useRef(0),
    mounted = useRef(false),
    busyRef = useRef(false);
  const expected = useRef(expectedViewerId);
  expected.current = expectedViewerId;
  const callbacks = useRef({ onBusyChange, onFlowChange });
  callbacks.current = { onBusyChange, onFlowChange };
  const flowRef = useRef<FactorFlow | null>(null);
  const [account, setAccount] = useState<AuthAccountView | null>(null);
  const [loading, setLoading] = useState(true),
    [note, setNote] = useState("");
  const [flow, setFlow] = useState<FactorFlow | null>(null);
  const [identifier, setIdentifier] = useState(""),
    [code, setCode] = useState("");
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const flowTitle = (value: FactorFlow) =>
    `${value.action === "link" ? "绑定" : value.action === "replace" ? "更换" : "解除"}${labels[value.target]}`;
  const updateFlow = (value: FactorFlow | null) => {
    const previous = flowRef.current;
    flowRef.current = value;
    setFlow(value);
    if (
      (previous === null) !== (value === null) ||
      (previous && value && flowTitle(previous) !== flowTitle(value))
    )
      callbacks.current.onFlowChange?.(value ? flowTitle(value) : null);
  };
  const updateBusy = (value: boolean) => {
    busyRef.current = value;
    callbacks.current.onBusyChange?.(value);
    setBusy(value);
  };
  const matches = (value: AuthAccountView) =>
    expected.current === undefined || value.userId === expected.current;
  const load = async () => {
    if (busyRef.current) return;
    const current = ++generation.current,
      owner = expected.current;
    setLoading(true);
    setNote("");
    setError("");
    try {
      const result = await authRequest("account");
      if (
        !mounted.current ||
        current !== generation.current ||
        expected.current !== owner
      )
        return;
      if (
        result.status === 200 &&
        typeof result.body === "object" &&
        result.body !== null &&
        "userId" in result.body &&
        matches(result.body as AuthAccountView)
      )
        setAccount(result.body as AuthAccountView);
      else {
        setAccount(null);
        setNote("登录方式暂未开放，或当前没有可用会话。");
      }
    } catch {
      if (mounted.current && current === generation.current) {
        setAccount(null);
        setNote("登录方式暂时无法读取，请重试。");
      }
    } finally {
      if (mounted.current && current === generation.current) setLoading(false);
    }
  };
  const cancelFlow = () => {
    if (busyRef.current) return false;
    generation.current++;
    updateFlow(null);
    setCode("");
    setIdentifier("");
    setError("");
    return true;
  };
  useImperativeHandle(navigationRef, () => ({ cancelFlow }));
  useEffect(() => {
    mounted.current = true;
    flowRef.current = null;
    setFlow(null);
    setCode("");
    setIdentifier("");
    setAccount(null);
    updateBusy(false);
    void load();
    return () => {
      mounted.current = false;
      generation.current++;
      flowRef.current = null;
      busyRef.current = false;
      onBusyChange?.(false);
    };
  }, [expectedViewerId]);

  // One synchronous gate and generation cover the entire operation, including proof -> unlink.
  const run = async (operation: (valid: () => boolean) => Promise<void>) => {
    if (
      busyRef.current ||
      !mounted.current ||
      (expected.current !== undefined && (!account || !matches(account)))
    )
      return;
    const current = ++generation.current,
      owner = expected.current;
    const valid = () =>
      mounted.current &&
      generation.current === current &&
      expected.current === owner;
    updateBusy(true);
    setError("");
    try {
      await operation(valid);
    } catch {
      if (valid()) setError("网络暂时不可用，请稍后重试。");
    } finally {
      if (valid()) updateBusy(false);
    }
  };
  const readChallenge = (
    result: Awaited<ReturnType<typeof authRequest>>,
    currentFlow: FactorFlow,
    step: Step,
  ) => {
    if (result.status !== 200) {
      setError(messageOf(result.body));
      return;
    }
    const body = result.body as {
      challengeId?: string;
      continuationToken?: string;
      maskedTarget?: string;
    } | null;
    if (!body?.challengeId || !body.continuationToken) {
      setError("这次验证无法继续，请重新获取验证码。");
      return;
    }
    updateFlow({
      ...currentFlow,
      step,
      challengeId: body.challengeId,
      continuation: body.continuationToken,
      masked: body.maskedTarget ?? "",
    });
    setCode("");
  };
  const sendProof = (currentFlow: FactorFlow) =>
    run(async (valid) => {
      const result = await authRequest("challenges", {
        body: {
          channel: currentFlow.proof,
          purpose: "reauthenticate",
          idempotencyKey: requestIdentity(),
        },
      });
      if (valid()) readChallenge(result, currentFlow, "proof");
    });
  const begin = (action: Action, target: Channel) => {
    if (busyRef.current || account === null || !matches(account)) return;
    const proof = proofFor(account, target);
    if (proof === null) {
      setError("请先保留一种可用的登录方式。");
      return;
    }
    const next = emptyFlow(action, target, proof, account[target].version);
    setCode("");
    setIdentifier("");
    updateFlow(next);
    void sendProof(next);
  };
  const sendFactor = (currentFlow: FactorFlow, value: string) =>
    run(async (valid) => {
      const result = await authRequest("challenges", {
        body: {
          channel: currentFlow.target,
          purpose: currentFlow.action === "replace" ? "replace" : "link",
          identifier: value,
          reauthToken: currentFlow.reauthToken,
          idempotencyKey: requestIdentity(),
        },
      });
      if (valid()) readChallenge(result, currentFlow, "factor");
    });
  const applyAccount = async (body: unknown, valid: () => boolean) => {
    const payload = body as { account?: AuthAccountView } | null;
    if (payload?.account && matches(payload.account))
      setAccount(payload.account);
    else {
      const result = await authRequest("account");
      if (!valid()) return;
      if (
        result.status === 200 &&
        typeof result.body === "object" &&
        result.body !== null &&
        "userId" in result.body &&
        matches(result.body as AuthAccountView)
      )
        setAccount(result.body as AuthAccountView);
      else {
        setAccount(null);
        setNote("变更已确认，请重新读取账户信息。");
      }
    }
    if (valid()) {
      updateFlow(null);
      setCode("");
      setIdentifier("");
    }
  };
  const submit = () => {
    const currentFlow = flowRef.current;
    if (currentFlow === null || busyRef.current) return;
    if (currentFlow.step === "identifier") {
      void sendFactor(currentFlow, identifier);
      return;
    }
    void run(async (valid) => {
      if (currentFlow.step === "proof") {
        const result = await authRequest("challenges/verify", {
          body: {
            challengeId: currentFlow.challengeId,
            code,
            continuationToken: currentFlow.continuation,
            idempotencyKey: requestIdentity(),
          },
        });
        if (!valid()) return;
        if (result.status !== 200) {
          setError(messageOf(result.body));
          return;
        }
        const body = result.body as {
          outcome?: string;
          reauthToken?: string;
        } | null;
        if (body?.outcome !== "reauthenticated" || !body.reauthToken) {
          setError("这次验证不能继续，请重新开始。");
          return;
        }
        if (currentFlow.action === "unlink") {
          const unlinked = await authRequest("factors/unlink", {
            body: {
              channel: currentFlow.target,
              reauthToken: body.reauthToken,
              expectedVersion: currentFlow.expectedVersion,
              idempotencyKey: requestIdentity(),
            },
          });
          if (!valid()) return;
          if (unlinked.status !== 200) {
            setError(messageOf(unlinked.body));
            return;
          }
          await applyAccount(unlinked.body, valid);
        } else {
          updateFlow({
            ...currentFlow,
            reauthToken: body.reauthToken,
            step: "identifier",
          });
          setCode("");
        }
      } else {
        const result = await authRequest("factors/complete", {
          body: {
            challengeId: currentFlow.challengeId,
            code,
            continuationToken: currentFlow.continuation,
            reauthToken: currentFlow.reauthToken,
            expectedVersion: currentFlow.expectedVersion,
            idempotencyKey: requestIdentity(),
          },
        });
        if (!valid()) return;
        if (result.status !== 200) {
          setError(messageOf(result.body));
          return;
        }
        await applyAccount(result.body, valid);
      }
    });
  };
  const availableAccount = account && matches(account) ? account : null;
  return (
    <section aria-label="登录与安全" className={styles.panel} aria-busy={busy}>
      {!onFlowChange && <h3>登录与安全</h3>}
      {!flow ? (
        <>
          {availableAccount === null ? (
            <div className={styles.notice}>
              <p role="status">{loading ? "正在读取登录方式。" : note}</p>
              {!loading && (
                <button type="button" onClick={() => void load()}>
                  重试
                </button>
              )}
            </div>
          ) : (
            <div className={styles.rows}>
              {(["email", "phone"] as const).map((channel) => {
                const factor = availableAccount[channel],
                  available = availableAccount.capabilities[channel].available;
                return (
                  <div className={styles.row} key={channel}>
                    <div className={styles.detail}>
                      <strong>{labels[channel]}</strong>
                      <span>{factor.masked || states[factor.state]}</span>
                      <small>
                        {factor.masked
                          ? states[factor.state]
                          : available
                            ? "可用于登录当前账户"
                            : "此方式当前不可用"}
                      </small>
                    </div>
                    <div className={styles.actions}>
                      {available && factor.state === "unbound" && (
                        <button
                          type="button"
                          disabled={busy}
                          data-settings-focus-key={`auth-link-${channel}`}
                          onClick={() => begin("link", channel)}
                        >
                          绑定
                        </button>
                      )}
                      {available &&
                        (factor.state === "verified" ||
                          factor.state === "pending") && (
                          <>
                            <button
                              type="button"
                              disabled={busy}
                              data-settings-focus-key={`auth-replace-${channel}`}
                              onClick={() => begin("replace", channel)}
                            >
                              更换
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              data-settings-focus-key={`auth-unlink-${channel}`}
                              onClick={() => begin("unlink", channel)}
                            >
                              解除
                            </button>
                          </>
                        )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <p className={styles.muted}>
            邮箱和手机号属于同一个账户。更换或解除前，需要验证当前可用的登录方式。
          </p>
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          <button
            className={styles.signOut}
            type="button"
            disabled={
              busy ||
              loading ||
              (expectedViewerId !== undefined && availableAccount === null)
            }
            onClick={() => {
              if (busyRef.current || guardSignOut?.() === false) return;
              void run(async (valid) => {
                const result = await authRequest("sign-out", {
                  method: "POST",
                  body: {},
                });
                if (!valid()) return;
                if (result.status >= 200 && result.status < 300) {
                  if (onSignedOut) onSignedOut();
                  else window.location.assign("/");
                } else setError("退出未能确认，请重试。");
              });
            }}
          >
            {busy ? "处理中" : "退出登录"}
          </button>
        </>
      ) : (
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <p className={styles.muted}>
            {flow.step === "identifier"
              ? `输入要${flow.action === "replace" ? "更换" : "绑定"}的${labels[flow.target]}。这会留在当前账户。`
              : flow.step === "factor"
                ? `验证码已发往 ${flow.masked}。`
                : flow.action === "unlink"
                  ? `解除${labels[flow.target]}前，先验证当前的${labels[flow.proof]}${flow.masked ? ` ${flow.masked}` : ""}。`
                  : `验证码已发往当前的${labels[flow.proof]}${flow.masked ? ` ${flow.masked}` : ""}。`}
          </p>
          <label className={styles.field}>
            {flow.step === "identifier" ? labels[flow.target] : "验证码"}
            {flow.step === "identifier" ? (
              <input
                autoComplete={flow.target === "email" ? "email" : "tel"}
                inputMode={flow.target === "email" ? "email" : "tel"}
                value={identifier}
                disabled={busy}
                onChange={(event) => setIdentifier(event.target.value)}
                required
              />
            ) : (
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                disabled={busy}
                onPaste={(event) => {
                  const next = digits(event.clipboardData.getData("text"));
                  if (next.length === 0) return;
                  event.preventDefault();
                  setCode(next);
                }}
                onChange={(event) => setCode(digits(event.target.value))}
                required
              />
            )}
          </label>
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          <button
            className={styles.primary}
            type="submit"
            disabled={
              busy ||
              (flow.step === "identifier"
                ? !identifier.trim()
                : !flow.challengeId || code.length !== 6)
            }
          >
            {busy
              ? "处理中"
              : flow.step === "identifier"
                ? "发送验证码"
                : "继续"}
          </button>
          <div className={styles.actions}>
            {flow.step !== "identifier" && (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void (flow.step === "proof"
                    ? sendProof(flow)
                    : sendFactor(flow, identifier))
                }
              >
                重新获取验证码
              </button>
            )}
            <button type="button" disabled={busy} onClick={cancelFlow}>
              取消
            </button>
          </div>
        </form>
      )}
    </section>
  );
};
