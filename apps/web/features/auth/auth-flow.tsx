"use client";

import { Button, Icon, Input, YoyiLogo } from "@moya/ui";
import { useEffect, useId, useRef, useState } from "react";

import { requestIdentity } from "../shell/request-identity";
import {
  authRequest,
  hasCompletedAuthSession,
  safeReturnPath,
} from "./auth-api";
import type { AuthCapabilitiesView, AuthChallengeView } from "./auth-api";

import styles from "./auth-flow.module.css";

type Channel = "email" | "phone";
type Mode = "sign-in" | "register";
type Step = "identifier" | "code" | "profile";
type Operation = "send" | "verify" | "confirm";
type Field = "identifier" | "code" | "displayName" | "agreement";
type Feedback = {
  readonly message: string;
  readonly field?: Field;
  readonly action?: "restart" | "login";
};

const reasons: Record<string, string> = {
  AUTH_CHANNEL_UNAVAILABLE: "这个登录方式暂时不可用，请选择其他方式。",
  AUTH_INVALID_IDENTIFIER: "请检查邮箱或手机号格式。",
  AUTH_INVALID_DISPLAY_NAME: "昵称需要 1 到 40 个字符。",
  AUTH_AGREEMENT_REQUIRED: "请先阅读并勾选注册说明。",
  AUTH_RATE_LIMITED: "操作过于频繁，请稍后重试。",
  AUTH_CODE_EXHAUSTED: "验证尝试次数已用完，请稍后重新获取验证码。",
  AUTH_CODE_INVALID: "验证码不正确，请检查后重新输入。",
  AUTH_CODE_EXPIRED: "验证码已过期，请重新获取。",
  AUTH_CODE_SUPERSEDED: "这次验证码已被替代，请重新获取验证码。",
  AUTH_PROOF_REJECTED: "这次验证已失效，请重新验证。",
  AUTH_ACCOUNT_SUSPENDED: "这个账户已停用。",
  AUTH_UNAUTHENTICATED: "登录状态已失效，请重新验证。",
  AUTH_DELIVERY_FAILED: "验证码没有发出，请稍后重新获取。",
  AUTH_DELIVERY_UNKNOWN: "发送结果暂时无法确认，请稍后重新获取验证码。",
  AUTH_PROVENANCE_REJECTED: "这次验证无法继续，请重新验证。",
  AUTH_NOT_CONFIGURED: "登录服务暂时不可用，请稍后重试。",
};

const recordOf = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const reasonOf = (body: unknown): string => {
  const error = recordOf(recordOf(body)?.error);
  return typeof error?.message === "string" ? error.message : "";
};

const messageOf = (body: unknown): string =>
  reasons[reasonOf(body)] ?? "暂时无法完成，请稍后重试。";

const capabilitiesOf = (body: unknown): AuthCapabilitiesView | null => {
  const value = recordOf(body);
  const email = recordOf(value?.email);
  const phone = recordOf(value?.phone);
  if (
    value === null ||
    !["full-local", "email-first", "disabled"].includes(
      String(value.profile),
    ) ||
    typeof value.developmentOnly !== "boolean" ||
    typeof email?.available !== "boolean" ||
    typeof phone?.available !== "boolean" ||
    !(email.reason === null || typeof email.reason === "string") ||
    !(phone.reason === null || typeof phone.reason === "string")
  )
    return null;
  return value as unknown as AuthCapabilitiesView;
};

const isProof = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value);

const challengeOf = (body: unknown): AuthChallengeView | null => {
  const value = recordOf(body);
  if (
    value === null ||
    typeof value.challengeId !== "string" ||
    !/^challenge-[0-9a-f]{32}$/u.test(value.challengeId) ||
    typeof value.maskedTarget !== "string" ||
    value.maskedTarget.length === 0 ||
    value.maskedTarget.length > 80 ||
    typeof value.resendAvailableAt !== "string" ||
    !Number.isFinite(Date.parse(value.resendAvailableAt)) ||
    (value.continuationToken !== undefined && !isProof(value.continuationToken))
  )
    return null;
  return value as unknown as AuthChallengeView;
};

const normalizedIdentifier = (
  channel: Channel,
  input: string,
): string | null => {
  if (channel === "email") {
    const email = input.trim();
    return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)
      ? email
      : null;
  }
  const phone = input
    .trim()
    .replace(/[\s()-]/gu, "")
    .replace(/^(?:\+86|0086)/u, "");
  return /^1[3-9]\d{9}$/u.test(phone) ? `+86${phone}` : null;
};

export const AuthFlow = ({
  mode,
  returnTo,
  onReturn,
  onModeChange,
  initialEmail = "",
  initialPhone = "",
  initialChannel = "email",
  onInputChange,
  onChannelChange,
}: {
  readonly mode: Mode;
  readonly returnTo: string;
  readonly onReturn?: (destination: string) => void;
  readonly onModeChange?: (mode: Mode) => void;
  readonly initialEmail?: string;
  readonly initialPhone?: string;
  readonly initialChannel?: Channel;
  readonly onInputChange?: (channel: Channel, value: string) => void;
  readonly onChannelChange?: (channel: Channel) => void;
}) => {
  const titleId = useId();
  const fieldId = useId();
  const hintId = useId();
  const feedbackId = useId();
  const agreementId = useId();
  const identifierRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const nicknameRef = useRef<HTMLInputElement>(null);
  const agreementTitleRef = useRef<HTMLHeadingElement>(null);
  const agreementButtonRef = useRef<HTMLButtonElement>(null);
  const restoreAgreementFocus = useRef(false);
  const flow = useRef(0);
  const capabilityRequest = useRef(0);
  const pendingRef = useRef<Operation | null>(null);
  const previousMode = useRef(mode);
  const retry = useRef<
    Partial<Record<Operation, { payload: string; key: string }>>
  >({});
  const [capabilities, setCapabilities] = useState<AuthCapabilitiesView | null>(
    null,
  );
  const [capabilityState, setCapabilityState] = useState<
    "loading" | "ready" | "error"
  >("loading");
  const [channel, setChannel] = useState<Channel>(initialChannel);
  const [email, setEmail] = useState(initialEmail);
  const [phone, setPhone] = useState(
    initialPhone.replace(/^(?:\+86|0086)/u, ""),
  );
  const [step, setStep] = useState<Step>("identifier");
  const [code, setCode] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [agreementOpen, setAgreementOpen] = useState(false);
  const [challenge, setChallenge] = useState<AuthChallengeView | null>(null);
  const [handoff, setHandoff] = useState("");
  const [masked, setMasked] = useState("");
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [pending, setPending] = useState<Operation | null>(null);
  const destination = safeReturnPath(returnTo);
  const identifier = channel === "email" ? email : phone;
  const available =
    capabilityState === "ready" && capabilities?.[channel].available === true;
  const locked = pending === "verify" || pending === "confirm";
  const remaining = Math.max(0, Math.ceil((resendAt - now) / 1000));

  const loadCapabilities = async () => {
    const current = ++capabilityRequest.current;
    setCapabilityState("loading");
    try {
      const result = await authRequest("capabilities");
      if (current !== capabilityRequest.current) return;
      const value = result.status === 200 ? capabilitiesOf(result.body) : null;
      if (value === null) {
        setCapabilityState("error");
        return;
      }
      setCapabilities(value);
      setCapabilityState("ready");
    } catch {
      if (current === capabilityRequest.current) setCapabilityState("error");
    }
  };

  useEffect(() => {
    void loadCapabilities();
    return () => {
      flow.current += 1;
      capabilityRequest.current += 1;
      pendingRef.current = null;
      retry.current = {};
    };
  }, []);

  const clearProof = () => {
    setChallenge(null);
    setHandoff("");
    setCode("");
    setAgreed(false);
  };

  const restart = () => {
    flow.current += 1;
    pendingRef.current = null;
    retry.current = {};
    setPending(null);
    clearProof();
    setStep("identifier");
    setFeedback(null);
    setAgreementOpen(false);
    setMasked("");
    setResendAt(0);
  };

  useEffect(() => {
    if (previousMode.current === mode) return;
    previousMode.current = mode;
    restart();
    setDisplayName("");
  }, [mode]);

  useEffect(() => {
    if (resendAt === 0) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [resendAt]);

  useEffect(() => {
    if (agreementOpen) {
      agreementTitleRef.current?.focus();
      return;
    }
    if (restoreAgreementFocus.current) {
      restoreAgreementFocus.current = false;
      agreementButtonRef.current?.focus();
      return;
    }
    if (step === "code") codeRef.current?.focus();
    if (step === "profile") nicknameRef.current?.focus();
    if (step === "identifier") identifierRef.current?.focus();
  }, [step, channel, mode, agreementOpen]);

  const returnToSource = () => {
    if (locked) return;
    restart();
    if (onReturn) onReturn(destination);
    else window.location.assign(destination);
  };

  const finish = () => {
    restart();
    if (onReturn) onReturn(destination);
    else window.location.assign(destination);
  };

  const changeMode = (next: Mode) => {
    if (locked) return;
    restart();
    if (onModeChange) onModeChange(next);
    else
      window.location.assign(
        `${next === "register" ? "/register" : "/login"}?return=${encodeURIComponent(destination)}`,
      );
  };

  const changeChannel = (next: Channel) => {
    if (locked || !capabilities?.[next].available || next === channel) return;
    restart();
    setChannel(next);
    onChannelChange?.(next);
  };

  const updateIdentifier = (value: string) => {
    if (channel === "email") setEmail(value);
    else setPhone(value.replace(/^(?:\+86|0086)/u, ""));
    onInputChange?.(
      channel,
      channel === "phone" ? value.replace(/^(?:\+86|0086)/u, "") : value,
    );
    if (feedback?.field === "identifier") setFeedback(null);
  };

  const handleFailure = (operation: Operation, body: unknown) => {
    const reason = reasonOf(body);
    if (reason === "AUTH_CHANNEL_UNAVAILABLE") void loadCapabilities();
    if (
      [
        "AUTH_CODE_EXPIRED",
        "AUTH_CODE_SUPERSEDED",
        "AUTH_CODE_EXHAUSTED",
        "AUTH_PROOF_REJECTED",
        "AUTH_PROVENANCE_REJECTED",
        "AUTH_UNAUTHENTICATED",
      ].includes(reason)
    ) {
      clearProof();
      setFeedback({ message: messageOf(body), action: "restart" });
      return;
    }
    if (
      operation === "send" &&
      ["AUTH_DELIVERY_FAILED", "AUTH_DELIVERY_UNKNOWN"].includes(reason)
    ) {
      clearProof();
      setStep("identifier");
      setMasked("");
    }
    if (reason === "AUTH_DELIVERY_UNKNOWN" && operation !== "send") {
      setFeedback({ message: "验证结果暂时无法确认，请稍后再点确认。" });
      return;
    }
    setFeedback({
      message: messageOf(body),
      ...(reason === "AUTH_CODE_INVALID" ? { field: "code" as const } : {}),
      ...(reason === "AUTH_INVALID_IDENTIFIER"
        ? { field: "identifier" as const }
        : {}),
      ...(reason === "AUTH_INVALID_DISPLAY_NAME"
        ? { field: "displayName" as const }
        : {}),
      ...(reason === "AUTH_AGREEMENT_REQUIRED"
        ? { field: "agreement" as const }
        : {}),
    });
    if (reason === "AUTH_CODE_INVALID") {
      codeRef.current?.focus();
      codeRef.current?.select();
    }
  };

  const perform = async (
    operation: Operation,
    path: string,
    payload: Record<string, unknown>,
    accept: (result: Awaited<ReturnType<typeof authRequest>>) => void,
  ) => {
    if (pendingRef.current !== null) return;
    const current = ++flow.current;
    const serialized = JSON.stringify(payload);
    const previous = retry.current[operation];
    const key =
      previous?.payload === serialized ? previous.key : requestIdentity();
    // Retry identity and proofs live only in this mounted flow. A manual retry
    // after a transport failure reuses its payload; no automatic replay occurs.
    retry.current[operation] = { payload: serialized, key };
    pendingRef.current = operation;
    setPending(operation);
    setFeedback(null);
    try {
      const result = await authRequest(path, {
        body: { ...payload, idempotencyKey: key },
      });
      if (current !== flow.current) return;
      if (
        operation === "send" ||
        reasonOf(result.body) !== "AUTH_DELIVERY_UNKNOWN"
      )
        delete retry.current[operation];
      accept(result);
    } catch {
      if (current !== flow.current) return;
      if (operation === "send") {
        clearProof();
        setStep("identifier");
        setMasked("");
      }
      setFeedback({
        message:
          operation === "send"
            ? "连接中断，尚未确认验证码是否发出。请检查网络后重试。"
            : operation === "confirm"
              ? "连接中断，尚未确认账户是否创建。请检查网络后重试。"
              : "连接中断，尚未确认验证结果。请检查网络后重试。",
      });
    } finally {
      if (current === flow.current) {
        pendingRef.current = null;
        setPending(null);
      }
    }
  };

  const send = async () => {
    if (!available || pendingRef.current !== null || remaining > 0) return;
    const normalized = normalizedIdentifier(channel, identifier);
    if (normalized === null) {
      setFeedback({
        field: "identifier",
        message:
          channel === "email"
            ? "请输入有效的邮箱地址。"
            : "请输入 11 位中国大陆手机号。",
      });
      identifierRef.current?.focus();
      return;
    }
    const previous = challenge;
    await perform(
      "send",
      "challenges",
      {
        channel,
        purpose:
          mode === "register" || step === "profile" ? "register" : "sign_in",
        identifier: normalized,
      },
      (result) => {
        if (result.status !== 200) {
          handleFailure("send", result.body);
          return;
        }
        const accepted = challengeOf(result.body);
        const continuation =
          accepted?.continuationToken ??
          (accepted?.challengeId === previous?.challengeId
            ? previous?.continuationToken
            : undefined);
        if (accepted !== null) {
          setResendAt(Date.parse(accepted.resendAvailableAt));
          setNow(Date.now());
        }
        if (accepted === null || !isProof(continuation)) {
          clearProof();
          setStep("identifier");
          setFeedback({ message: "这次发送无法继续验证，请重新获取验证码。" });
          return;
        }
        setChallenge({ ...accepted, continuationToken: continuation });
        setMasked(accepted.maskedTarget);
        setHandoff("");
        setCode("");
        setAgreed(false);
        setStep("code");
      },
    );
  };

  const verify = async () => {
    if (
      challenge === null ||
      !isProof(challenge.continuationToken) ||
      !/^\d{6}$/u.test(code)
    )
      return;
    await perform(
      "verify",
      "challenges/verify",
      {
        challengeId: challenge.challengeId,
        code,
        continuationToken: challenge.continuationToken,
      },
      (result) => {
        if (result.status !== 200) {
          handleFailure("verify", result.body);
          return;
        }
        const body = recordOf(result.body);
        if (body?.outcome === "signed_in" && hasCompletedAuthSession(body)) {
          finish();
          return;
        }
        if (
          body?.outcome === "registration_required" &&
          isProof(body.handoffToken) &&
          body.channel === channel &&
          typeof body.maskedTarget === "string" &&
          body.maskedTarget.length > 0 &&
          body.maskedTarget.length <= 80
        ) {
          if (
            typeof body.maskedTarget === "string" &&
            body.maskedTarget.length > 0
          )
            setMasked(body.maskedTarget);
          setChallenge(null);
          setCode("");
          setHandoff(body.handoffToken);
          setAgreed(false);
          setStep("profile");
          return;
        }
        clearProof();
        if (body?.outcome === "already_registered") {
          setFeedback({
            message: "这个账号已经注册，请前往登录并重新验证。",
            action: "login",
          });
          return;
        }
        setFeedback({
          message: "这次验证无法继续，请重新验证。",
          action: "restart",
        });
      },
    );
  };

  const confirm = async () => {
    if (!isProof(handoff)) return;
    const nickname = displayName.trim();
    if (nickname.length < 1 || nickname.length > 40) {
      setFeedback({
        message: reasons.AUTH_INVALID_DISPLAY_NAME!,
        field: "displayName",
      });
      nicknameRef.current?.focus();
      return;
    }
    if (!agreed) {
      setFeedback({
        message: reasons.AUTH_AGREEMENT_REQUIRED!,
        field: "agreement",
      });
      return;
    }
    await perform(
      "confirm",
      "registrations",
      {
        handoffToken: handoff,
        displayName: nickname,
        agreement: true,
      },
      (result) => {
        if (
          result.status === 201 &&
          recordOf(result.body)?.outcome === "registered" &&
          hasCompletedAuthSession(recordOf(result.body))
        ) {
          finish();
          return;
        }
        if (result.status === 201) {
          clearProof();
          setFeedback({
            message: "账户创建结果暂时无法确认，请重新验证。",
            action: "restart",
          });
          return;
        }
        handleFailure("confirm", result.body);
      },
    );
  };

  const feedbackFor = (field: Field) =>
    feedback?.field === field ? feedback : null;
  const descriptionFor = (field: Field) =>
    `${hintId}${feedbackFor(field) ? ` ${feedbackId}` : ""}`;
  const fieldFeedback = (field: Field) =>
    feedbackFor(field) ? (
      <p className={styles.fieldError} id={feedbackId} role="alert">
        {feedback?.message}
      </p>
    ) : null;
  const title =
    step === "profile"
      ? "创建你的账户"
      : step === "code"
        ? "填写验证码"
        : mode === "register"
          ? "注册"
          : "登录";
  const modeLink = `${mode === "register" ? "/login" : "/register"}?return=${encodeURIComponent(destination)}`;

  if (agreementOpen)
    return (
      <main
        className={styles.page}
        data-auth-step="agreements"
        data-auth-mode={mode}
        data-auth-channel={channel}
      >
        <nav className={styles.navigation} aria-label="注册说明">
          <Button
            variant="quiet"
            className={styles.back}
            onClick={() => {
              restoreAgreementFocus.current = true;
              setAgreementOpen(false);
            }}
          >
            <Icon name="back" />
            返回填写
          </Button>
        </nav>
        <article className={`${styles.panel} ${styles.agreement}`}>
          <h1 ref={agreementTitleRef} tabIndex={-1}>
            开发环境注册说明
          </h1>
          <p>这是开发环境草稿，不是已批准的用户协议或隐私政策。</p>
          <p>
            注册只创建由于艺 / ArtVenn
            的公开账户，用来登录、绑定邮箱或手机号，以及继续使用现有的作品与评论功能。验证邮箱或手机号不是身份证实名，也不是人脸核验。
          </p>
          <p>
            正式上线前需要替换为已批准的法律文本。这里没有客服渠道，也没有账户注销流程。
          </p>
          <Button
            className={styles.primary}
            onClick={() => {
              restoreAgreementFocus.current = true;
              setAgreementOpen(false);
            }}
          >
            返回填写
          </Button>
        </article>
      </main>
    );

  return (
    <main
      className={styles.page}
      data-auth-step={step}
      data-auth-mode={mode}
      data-auth-channel={channel}
    >
      <nav className={styles.navigation} aria-label="认证导航">
        <Button
          variant="quiet"
          className={styles.back}
          disabled={locked}
          onClick={returnToSource}
        >
          <Icon name="back" />
          返回原页面
        </Button>
        <span
          className={styles.progress}
          aria-label={`当前步骤：${step === "identifier" ? "输入账号" : step === "code" ? "验证账号" : "确认注册"}`}
        >
          <span data-current={step === "identifier"}>账号</span>
          <span aria-hidden="true">·</span>
          <span data-current={step === "code"}>验证</span>
          <span aria-hidden="true">·</span>
          <span data-current={step === "profile"}>完成</span>
        </span>
      </nav>
      <section className={styles.panel} aria-labelledby={titleId}>
        <header className={styles.intro}>
          <div className={styles.brand}>
            <YoyiLogo label="由于艺 / ArtVenn" className={styles.logo} />
            <span className={styles.brandName}>ArtVenn</span>
          </div>
          <h1 id={titleId}>{title}</h1>
          <p className={styles.subtitle}>
            {step === "identifier"
              ? mode === "register"
                ? "用邮箱或手机，开启你的艺文收藏。"
                : "登录后，继续你的收藏与交流。"
              : step === "code"
                ? "输入收到的 6 位验证码。"
                : "验证已完成，确认信息后才会创建账户。"}
          </p>
        </header>
        <form
          className={styles.form}
          aria-labelledby={titleId}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (pendingRef.current !== null || feedback?.action) return;
            if (step === "identifier") void send();
            else if (step === "code") void verify();
            else void confirm();
          }}
        >
          {step === "identifier" ? (
            <>
              <div
                className={styles.channels}
                role="group"
                aria-label={mode === "register" ? "注册方式" : "登录方式"}
              >
                {(["email", "phone"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    aria-pressed={channel === option}
                    disabled={
                      locked ||
                      capabilityState !== "ready" ||
                      !capabilities?.[option].available
                    }
                    onClick={() => changeChannel(option)}
                  >
                    {option === "email" ? "邮箱" : "手机"}
                  </button>
                ))}
              </div>
              {capabilityState === "loading" ? (
                <p className={styles.capabilityNotice} role="status">
                  <Icon name="loading" />
                  正在获取可用的登录方式…
                </p>
              ) : capabilityState === "error" ? (
                <div className={styles.capabilityNotice} role="alert">
                  <p>暂时无法获取登录方式，请检查网络后重试。</p>
                  <Button
                    variant="quiet"
                    onClick={() => void loadCapabilities()}
                  >
                    重新获取登录方式
                  </Button>
                </div>
              ) : !available ? (
                <p className={styles.capabilityNotice} role="status">
                  {channel === "email"
                    ? "邮箱登录当前不可用。"
                    : "手机登录当前不可用。"}
                  {capabilities?.[channel === "email" ? "phone" : "email"]
                    .available
                    ? "请选择另一种方式。"
                    : "请稍后再试。"}
                </p>
              ) : null}
              {capabilityState === "ready" &&
              channel === "email" &&
              !capabilities?.phone.available ? (
                <p className={styles.channelHint}>手机登录当前不可用。</p>
              ) : null}
              <div className={styles.field}>
                <label htmlFor={fieldId}>
                  {channel === "email" ? "邮箱地址" : "手机号"}
                </label>
                <div
                  className={
                    channel === "phone" ? styles.phoneField : undefined
                  }
                >
                  {channel === "phone" ? (
                    <span className={styles.dialCode} aria-hidden="true">
                      +86
                    </span>
                  ) : null}
                  <Input
                    id={fieldId}
                    ref={identifierRef}
                    type={channel === "email" ? "email" : "tel"}
                    autoComplete={
                      channel === "email" ? "email" : "tel-national"
                    }
                    inputMode={channel === "email" ? "email" : "tel"}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder={
                      channel === "email" ? "你的邮箱地址" : "11 位手机号"
                    }
                    value={identifier}
                    onChange={(event) => updateIdentifier(event.target.value)}
                    invalid={feedbackFor("identifier") !== null}
                    aria-describedby={descriptionFor("identifier")}
                    disabled={pending === "send"}
                    required
                    className={styles.input}
                  />
                </div>
                <p id={hintId} className={styles.hint}>
                  {channel === "email"
                    ? "我们会向这个邮箱发送验证码。"
                    : "目前仅支持中国大陆手机号（+86）。"}
                </p>
                {fieldFeedback("identifier")}
              </div>
            </>
          ) : step === "code" ? (
            <>
              <div className={styles.target}>
                <p>
                  验证码已发往 <strong>{masked}</strong>
                </p>
                <Button variant="quiet" disabled={locked} onClick={restart}>
                  修改账号
                </Button>
              </div>
              <div className={styles.field}>
                <label htmlFor={fieldId}>验证码</label>
                <Input
                  id={fieldId}
                  ref={codeRef}
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  value={code}
                  disabled={pending !== null || challenge === null}
                  invalid={feedbackFor("code") !== null}
                  aria-describedby={descriptionFor("code")}
                  className={`${styles.input} ${styles.codeInput}`}
                  placeholder="6 位验证码"
                  onPaste={(event) => {
                    const digits = event.clipboardData
                      .getData("text")
                      .replace(/\D/gu, "")
                      .slice(0, 6);
                    if (!digits) return;
                    event.preventDefault();
                    setCode(digits);
                    if (feedbackFor("code")) setFeedback(null);
                  }}
                  onChange={(event) => {
                    setCode(event.target.value.replace(/\D/gu, "").slice(0, 6));
                    if (feedbackFor("code")) setFeedback(null);
                  }}
                  required
                />
                <p id={hintId} className={styles.hint}>
                  可粘贴完整验证码，填写后点按钮确认。
                </p>
                {fieldFeedback("code")}
              </div>
              {!feedback?.action ? (
                <div className={styles.resend}>
                  <span>没有收到验证码？</span>
                  <Button
                    variant="quiet"
                    disabled={pending !== null || remaining > 0 || !available}
                    onClick={() => void send()}
                  >
                    {remaining > 0 ? `${remaining} 秒后可重发` : "重新发送"}
                  </Button>
                </div>
              ) : null}
            </>
          ) : (
            <>
              <p className={styles.verified}>{masked} 已验证，账户尚未创建。</p>
              <div className={styles.field}>
                <label htmlFor={fieldId}>昵称</label>
                <Input
                  id={fieldId}
                  ref={nicknameRef}
                  autoComplete="nickname"
                  maxLength={40}
                  value={displayName}
                  disabled={pending !== null || !handoff}
                  placeholder="你希望大家如何称呼你"
                  invalid={feedbackFor("displayName") !== null}
                  aria-describedby={descriptionFor("displayName")}
                  className={styles.input}
                  onChange={(event) => {
                    setDisplayName(event.target.value);
                    if (feedbackFor("displayName")) setFeedback(null);
                  }}
                  required
                />
                <p id={hintId} className={styles.hint}>
                  1–40 个字符，将作为你的公开昵称。
                </p>
                {fieldFeedback("displayName")}
              </div>
              <div className={styles.agreementField}>
                <label className={styles.agreementChoice} htmlFor={agreementId}>
                  <input
                    id={agreementId}
                    type="checkbox"
                    checked={agreed}
                    disabled={pending !== null || !handoff}
                    aria-invalid={feedbackFor("agreement") ? true : undefined}
                    aria-describedby={
                      feedbackFor("agreement") ? feedbackId : undefined
                    }
                    onChange={(event) => {
                      setAgreed(event.target.checked);
                      if (feedbackFor("agreement")) setFeedback(null);
                    }}
                  />
                  <span>我已阅读并同意注册说明</span>
                </label>
                <Button
                  ref={agreementButtonRef}
                  variant="quiet"
                  className={styles.agreementLink}
                  disabled={locked}
                  onClick={() => setAgreementOpen(true)}
                >
                  阅读开发环境注册说明
                  <Icon name="next" size="sm" />
                </Button>
                {fieldFeedback("agreement")}
              </div>
            </>
          )}
          {feedback && !feedback.field ? (
            <p id={feedbackId} className={styles.error} role="alert">
              <Icon name="error" />
              {feedback.message}
            </p>
          ) : null}
          {feedback?.action === "login" ? (
            <Button
              className={styles.primary}
              onClick={(event) => {
                event.preventDefault();
                changeMode("sign-in");
              }}
              disabled={pending !== null}
            >
              去登录
            </Button>
          ) : feedback?.action === "restart" ? (
            <Button
              className={styles.primary}
              onClick={(event) => {
                event.preventDefault();
                restart();
              }}
              disabled={pending !== null}
            >
              重新验证
            </Button>
          ) : (
            <Button
              type="submit"
              className={styles.primary}
              size="lg"
              loading={pending !== null}
              disabled={
                !available ||
                (step === "identifier" && remaining > 0) ||
                (step === "code" && (code.length !== 6 || !challenge)) ||
                (step === "profile" &&
                  (!agreed || !displayName.trim() || !handoff))
              }
            >
              {pending === "send"
                ? "正在发送…"
                : pending === "verify"
                  ? "正在验证…"
                  : pending === "confirm"
                    ? "正在创建…"
                    : step === "identifier"
                      ? remaining > 0
                        ? `${remaining} 秒后可重新获取`
                        : "发送验证码"
                      : step === "profile"
                        ? "创建账户"
                        : mode === "register"
                          ? "确认验证码"
                          : "登录"}
            </Button>
          )}
          {step === "profile" ? (
            <Button variant="quiet" disabled={locked} onClick={restart}>
              返回并重新验证
            </Button>
          ) : null}
        </form>
        <footer className={styles.footer}>
          <p>
            {mode === "register" ? "已有账户？" : "还没有账户？"}{" "}
            <a
              href={modeLink}
              aria-disabled={locked || undefined}
              tabIndex={locked ? -1 : undefined}
              onClick={(event) => {
                event.preventDefault();
                changeMode(mode === "register" ? "sign-in" : "register");
              }}
            >
              {mode === "register" ? "去登录" : "去注册"}
            </a>
          </p>
          {capabilities?.developmentOnly ? (
            <p className={styles.development}>开发预览</p>
          ) : null}
        </footer>
      </section>
    </main>
  );
};
