"use client";

import { Button, Icon, Input, YoyiLogo } from "@moya/ui";
import { useEffect, useId, useRef, useState } from "react";

import { requestIdentity } from "../shell/request-identity";
import {
  authRequest,
  parseAuthCapabilities,
  hasCompletedAuthSession,
  safeReturnPath,
  validAuthPassword,
} from "./auth-api";
import type { AuthCapabilitiesView, AuthChallengeView } from "./auth-api";
import { StudioNameField, studioNameInput } from "../authors/studio-name-field";
import { RegistrationAvatar } from "./registration-avatar";

import styles from "./auth-flow.module.css";

type Channel = "email" | "phone";
type Mode = "sign-in" | "register";
type Step =
  "identifier" | "code" | "password" | "profile" | "avatar" | "reset-complete";
type Operation = "send" | "verify" | "confirm" | "password-login" | "reset";
type Field =
  | "identifier"
  | "code"
  | "password"
  | "passwordConfirm"
  | "displayName"
  | "studioName"
  | "agreement";
type Feedback = {
  readonly message: string;
  readonly field?: Field;
  readonly action?: "restart" | "login";
};

const passwordRuleHint = "密码需要 6–20 个字符，包含大写字母和数字。";

const reasons: Record<string, string> = {
  AUTH_CHANNEL_UNAVAILABLE: "这个登录方式暂时不可用，请选择其他方式。",
  AUTH_INVALID_IDENTIFIER: "请检查邮箱或手机号格式。",
  AUTH_INVALID_DISPLAY_NAME: "昵称需要 1 到 40 个字符。",
  AUTH_INVALID_PASSWORD: passwordRuleHint,
  AUTH_INVALID_STUDIO_NAME: "斋号名称最多 5 字，称谓需要 1 到 2 字。",
  AUTH_INVALID_CREDENTIALS: "账号或密码不正确，请重试或找回密码。",
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
  const passwordId = useId();
  const passwordConfirmId = useId();
  const studioId = useId();
  const identifierRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const nicknameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const passwordConfirmRef = useRef<HTMLInputElement>(null);
  const studioRef = useRef<HTMLInputElement>(null);
  const resultTitleRef = useRef<HTMLHeadingElement>(null);
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
  const [handle, setHandle] = useState("");
  const [phone, setPhone] = useState(
    initialPhone.replace(/^(?:\+86|0086)/u, ""),
  );
  const [step, setStep] = useState<Step>("identifier");
  const [method, setMethod] = useState<"password" | "code">("password");
  const [resetting, setResetting] = useState(false);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [studioName, setStudioName] = useState("");
  const [studioSuffix, setStudioSuffix] = useState("斋");
  const [createdAccountId, setCreatedAccountId] = useState("");
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
  const developmentAgreementAvailable = process.env.NODE_ENV === "development";
  const approvedAgreement =
    !developmentAgreementAvailable && capabilities?.registration?.available
      ? capabilities.registration.agreement
      : null;
  const agreementAvailable =
    developmentAgreementAvailable || approvedAgreement !== null;
  const registrationUnavailable =
    mode === "register" && !resetting && !agreementAvailable;
  const passwordOnly = capabilities?.profile === "password-only";
  const handleLogin =
    passwordOnly && mode === "sign-in" && method === "password" && !resetting;
  const identifier = handleLogin ? handle : channel === "email" ? email : phone;
  const passwordIdentifier = handleLogin ? "handle" : channel;
  const passwordAvailable =
    capabilities?.password === undefined
      ? capabilities?.[channel].available === true
      : capabilities.password.available &&
        capabilities.password.identifiers.includes(passwordIdentifier);
  const available =
    capabilityState === "ready" &&
    (mode === "sign-in" && method === "password" && !resetting
      ? passwordAvailable
      : capabilities?.[channel].available === true);
  const locked = pending !== null && pending !== "send";
  const passwordLogin =
    mode === "sign-in" && method === "password" && !resetting;
  const remaining = Math.max(0, Math.ceil((resendAt - now) / 1000));

  const loadCapabilities = async () => {
    const current = ++capabilityRequest.current;
    setCapabilityState("loading");
    try {
      const result = await authRequest("capabilities");
      if (current !== capabilityRequest.current) return;
      const value =
        result.status === 200 ? parseAuthCapabilities(result.body) : null;
      if (
        value === null ||
        (process.env.NODE_ENV === "production" && value.developmentOnly)
      ) {
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
    setPassword("");
    setPasswordConfirm("");
    setCreatedAccountId("");
  };

  useEffect(() => {
    if (previousMode.current === mode) return;
    previousMode.current = mode;
    restart();
    setDisplayName("");
    setStudioName("");
    setResetting(false);
    setMethod("password");
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
    if (step === "password") passwordRef.current?.focus();
    if (step === "reset-complete" || step === "avatar")
      resultTitleRef.current?.focus();
    if (step === "identifier") identifierRef.current?.focus();
  }, [step, channel, mode, agreementOpen, method, resetting]);

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
    setResetting(false);
    setMethod("password");
    if (onModeChange) onModeChange(next);
    else
      window.location.assign(
        `${next === "register" ? "/register" : "/login"}?return=${encodeURIComponent(destination)}`,
      );
  };

  const changeMethod = (next: "password" | "code") => {
    if (locked) return;
    restart();
    setResetting(false);
    setMethod(next);
  };

  const beginReset = () => {
    if (locked) return;
    restart();
    setResetting(true);
    setMethod("code");
  };

  const changeChannel = (next: Channel) => {
    if (locked || !capabilities?.[next].available || next === channel) return;
    restart();
    setChannel(next);
    onChannelChange?.(next);
  };

  const updateIdentifier = (value: string) => {
    if (handleLogin) {
      setHandle(value);
      if (feedback?.field === "identifier") setFeedback(null);
      return;
    }
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
      ...(reason === "AUTH_INVALID_PASSWORD"
        ? { field: "password" as const }
        : {}),
      ...(reason === "AUTH_INVALID_STUDIO_NAME"
        ? { field: "studioName" as const }
        : {}),
      ...(reason === "AUTH_AGREEMENT_REQUIRED"
        ? { field: "agreement" as const }
        : {}),
    });
    if (reason === "AUTH_INVALID_PASSWORD" && step === "profile")
      setStep("password");
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
      const reason = reasonOf(result.body);
      const uncertainServerResult =
        result.status >= 500 && !Object.hasOwn(reasons, reason);
      if (
        !uncertainServerResult &&
        (operation === "send" || reason !== "AUTH_DELIVERY_UNKNOWN")
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
              : operation === "password-login"
                ? "连接中断，尚未确认登录结果。请检查网络后重试。"
                : operation === "reset"
                  ? "连接中断，尚未确认密码是否重置。请检查网络后重试。"
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
    if (
      !available ||
      registrationUnavailable ||
      pendingRef.current !== null ||
      remaining > 0
    )
      return;
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
        purpose: resetting
          ? "password_reset"
          : mode === "register"
            ? "register"
            : "sign_in",
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
        if (
          mode === "sign-in" &&
          !resetting &&
          body?.outcome === "signed_in" &&
          hasCompletedAuthSession(body)
        ) {
          finish();
          return;
        }
        if (
          ((!resetting && body?.outcome === "registration_required") ||
            (resetting && body?.outcome === "password_reset_required")) &&
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
          setPassword("");
          setPasswordConfirm("");
          setStep("password");
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

  const validateIdentifier = () => {
    const normalized = handleLogin
      ? /^[a-z][a-z0-9-]{2,31}$/u.test(identifier)
        ? identifier
        : null
      : normalizedIdentifier(channel, identifier);
    if (normalized === null) {
      setFeedback({
        field: "identifier",
        message: handleLogin
          ? "请输入有效的账号。"
          : channel === "email"
            ? "请输入有效的邮箱地址。"
            : "请输入 11 位中国大陆手机号。",
      });
      identifierRef.current?.focus();
    }
    return normalized;
  };

  const validatePassword = () => {
    if (!validAuthPassword(password)) {
      setFeedback({
        field: "password",
        message: reasons.AUTH_INVALID_PASSWORD!,
      });
      passwordRef.current?.focus();
      return false;
    }
    if (password !== passwordConfirm) {
      setFeedback({
        field: "passwordConfirm",
        message: "两次输入的密码不一致。",
      });
      passwordConfirmRef.current?.focus();
      return false;
    }
    return true;
  };

  const loginWithPassword = async () => {
    if (!available || pendingRef.current !== null) return;
    const normalized = validateIdentifier();
    if (normalized === null) return;
    if (!password) {
      setFeedback({ field: "password", message: "请输入密码。" });
      passwordRef.current?.focus();
      return;
    }
    await perform(
      "password-login",
      "passwords/login",
      { channel: passwordIdentifier, identifier: normalized, password },
      (result) => {
        if (result.status === 200 && hasCompletedAuthSession(result.body)) {
          finish();
          return;
        }
        handleFailure("password-login", result.body);
      },
    );
  };

  const acceptPassword = async () => {
    if (pendingRef.current !== null || !isProof(handoff) || !validatePassword())
      return;
    if (!resetting) {
      setFeedback(null);
      setStep("profile");
      return;
    }
    await perform(
      "reset",
      "passwords/reset",
      { handoffToken: handoff, password },
      (result) => {
        if (result.status === 200 && recordOf(result.body)?.reset === true) {
          clearProof();
          setPassword("");
          setPasswordConfirm("");
          setStep("reset-complete");
          return;
        }
        handleFailure("reset", result.body);
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
    if (!agreed || !agreementAvailable) {
      setFeedback({
        message: reasons.AUTH_AGREEMENT_REQUIRED!,
        field: "agreement",
      });
      return;
    }
    const studio = studioNameInput(studioName, studioSuffix);
    if (!studio.success) {
      setFeedback({
        field: "studioName",
        message: reasons.AUTH_INVALID_STUDIO_NAME!,
      });
      studioRef.current?.focus();
      return;
    }
    if (!validatePassword()) {
      setStep("password");
      return;
    }
    await perform(
      "confirm",
      "registrations",
      {
        handoffToken: handoff,
        displayName: nickname,
        password,
        ...(studio.data.studioName ? studio.data : {}),
        agreement: true,
        ...(approvedAgreement === null
          ? {}
          : { agreementVersion: approvedAgreement.version }),
      },
      (result) => {
        if (
          result.status === 201 &&
          recordOf(result.body)?.outcome === "registered" &&
          hasCompletedAuthSession(recordOf(result.body))
        ) {
          clearProof();
          setPassword("");
          setPasswordConfirm("");
          const createdProfile = recordOf(
            recordOf(recordOf(result.body)?.session)?.profile,
          );
          setCreatedAccountId(
            typeof createdProfile?.id === "string" ? createdProfile.id : "",
          );
          setStep("avatar");
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
    [
      field === "password" && !passwordLogin ? hintId : null,
      feedbackFor(field) ? feedbackId : null,
    ]
      .filter(Boolean)
      .join(" ") || undefined;
  const fieldFeedback = (field: Field) =>
    feedbackFor(field) ? (
      <p className={styles.fieldError} id={feedbackId} role="alert">
        {feedback?.message}
      </p>
    ) : null;
  const title =
    step === "profile"
      ? "完善资料"
      : step === "password"
        ? resetting
          ? "设置新密码"
          : "设置密码"
        : step === "code"
          ? "填写验证码"
          : step === "avatar"
            ? "设置头像"
            : step === "reset-complete"
              ? "密码已重置"
              : resetting
                ? "找回密码"
                : mode === "register"
                  ? "注册"
                  : "登录";
  const modeLink = `${mode === "register" ? "/login" : "/register"}?return=${encodeURIComponent(destination)}`;
  const registrationStep =
    !resetting &&
    (mode === "register" || step === "password" || step === "profile");

  const brand = (
    <div className={styles.brand}>
      <YoyiLogo aria-hidden="true" className={styles.logo} />
      <span className={`yoyi-wordmark ${styles.brandName}`}>由于艺</span>
    </div>
  );

  if (agreementOpen && agreementAvailable)
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
            {approvedAgreement?.title ?? "开发环境注册说明"}
          </h1>
          {approvedAgreement === null ? (
            <>
              <p>这是开发环境草稿，不是已批准的用户协议或隐私政策。</p>
              <p>
                注册只创建由于艺
                的公开账户，用来登录、绑定邮箱或手机号，以及继续使用现有的作品与评论功能。验证邮箱或手机号不是身份证实名，也不是人脸核验。
              </p>
              <p>
                正式上线前需要替换为已批准的法律文本。这里没有客服渠道，也没有账户注销流程。
              </p>
            </>
          ) : (
            <>
              <p>版本：{approvedAgreement.version}</p>
              <p style={{ whiteSpace: "pre-wrap" }}>{approvedAgreement.body}</p>
            </>
          )}
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
      data-auth-method={method}
      data-auth-purpose={resetting ? "password-reset" : mode}
    >
      <nav className={styles.navigation} aria-label="认证导航">
        <Button
          variant="quiet"
          className={styles.back}
          disabled={locked}
          onClick={returnToSource}
        >
          <Icon name="back" />
          返回
        </Button>
      </nav>
      <section className={styles.panel} aria-labelledby={titleId}>
        <header className={styles.intro}>
          {brand}
          <h1
            id={titleId}
            ref={
              step === "reset-complete" || step === "avatar"
                ? resultTitleRef
                : undefined
            }
            tabIndex={
              step === "reset-complete" || step === "avatar" ? -1 : undefined
            }
          >
            {title}
          </h1>
        </header>
        {step === "avatar" ? (
          <RegistrationAvatar
            expectedAccountId={createdAccountId}
            onComplete={finish}
          />
        ) : step === "reset-complete" ? (
          <Button
            className={styles.primary}
            onClick={() => changeMethod("password")}
          >
            返回登录
          </Button>
        ) : (
          <form
            className={styles.form}
            aria-labelledby={titleId}
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              if (pendingRef.current !== null || feedback?.action) return;
              if (step === "identifier")
                void (passwordLogin ? loginWithPassword() : send());
              else if (step === "code") void verify();
              else if (step === "password") void acceptPassword();
              else if (step === "profile") void confirm();
            }}
          >
            {step === "identifier" ? (
              <>
                <div
                  className={styles.channels}
                  role="group"
                  aria-label={mode === "register" ? "注册方式" : "登录方式"}
                >
                  {!passwordOnly &&
                    (["email", "phone"] as const).map((option) => (
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
                {passwordOnly && (
                  <p className={styles.channelHint}>
                    验证码登录、注册、找回密码和联系方式绑定暂不可用。请使用已开通的账号和密码登录。
                  </p>
                )}
                {capabilityState === "loading" ? (
                  <p className={styles.capabilityNotice} role="status">
                    <Icon name="loading" />
                    正在获取登录方式…
                  </p>
                ) : capabilityState === "error" ? (
                  <div className={styles.capabilityNotice} role="alert">
                    <p>暂时无法获取登录方式。</p>
                    <Button
                      variant="quiet"
                      onClick={() => void loadCapabilities()}
                    >
                      重试
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
                ) : capabilityState === "ready" &&
                  !passwordOnly &&
                  channel === "email" &&
                  !capabilities?.phone.available ? (
                  <p className={styles.channelHint}>手机登录当前不可用。</p>
                ) : null}
                {capabilityState === "ready" && registrationUnavailable ? (
                  <p className={styles.capabilityNotice} role="status">
                    注册说明暂时不可用，暂时无法创建账户。
                  </p>
                ) : null}
                <div className={styles.field}>
                  <label htmlFor={fieldId}>
                    {handleLogin
                      ? "账号"
                      : channel === "email"
                        ? "邮箱地址"
                        : "手机号"}
                  </label>
                  <div
                    className={
                      !handleLogin && channel === "phone"
                        ? styles.phoneField
                        : undefined
                    }
                  >
                    {!handleLogin && channel === "phone" && (
                      <span className={styles.dialCode} aria-hidden="true">
                        +86
                      </span>
                    )}
                    <Input
                      id={fieldId}
                      ref={identifierRef}
                      type={
                        handleLogin
                          ? "text"
                          : channel === "email"
                            ? "email"
                            : "tel"
                      }
                      autoComplete={
                        passwordLogin
                          ? "username"
                          : channel === "email"
                            ? "email"
                            : "tel-national"
                      }
                      inputMode={
                        handleLogin
                          ? "text"
                          : channel === "email"
                            ? "email"
                            : "tel"
                      }
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      placeholder={
                        handleLogin
                          ? "账号"
                          : channel === "email"
                            ? "邮箱地址"
                            : "11 位手机号"
                      }
                      value={identifier}
                      onChange={(event) => updateIdentifier(event.target.value)}
                      invalid={feedbackFor("identifier") !== null}
                      aria-describedby={descriptionFor("identifier")}
                      disabled={pending !== null}
                      required
                      className={styles.input}
                    />
                  </div>
                  {!handleLogin && channel === "phone" && (
                    <p className={styles.hint}>仅支持中国大陆手机号（+86）。</p>
                  )}
                  {fieldFeedback("identifier")}
                </div>
                {passwordLogin && (
                  <div className={styles.field}>
                    <label htmlFor={passwordId}>密码</label>
                    <Input
                      id={passwordId}
                      ref={passwordRef}
                      type="password"
                      autoComplete="current-password"
                      autoCapitalize="none"
                      spellCheck={false}
                      value={password}
                      disabled={pending !== null}
                      invalid={feedbackFor("password") !== null}
                      aria-describedby={descriptionFor("password")}
                      className={styles.input}
                      onChange={(event) => {
                        setPassword(event.target.value);
                        if (feedbackFor("password")) setFeedback(null);
                      }}
                      required
                    />
                    {fieldFeedback("password")}
                  </div>
                )}
              </>
            ) : step === "code" ? (
              <>
                <div className={styles.target}>
                  <p>
                    已发送至 <strong>{masked}</strong>
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
                      setCode(
                        event.target.value.replace(/\D/gu, "").slice(0, 6),
                      );
                      if (feedbackFor("code")) setFeedback(null);
                    }}
                    required
                  />
                  {fieldFeedback("code")}
                </div>
                {!feedback?.action && (
                  <div className={styles.resend}>
                    <Button
                      variant="quiet"
                      disabled={pending !== null || remaining > 0 || !available}
                      onClick={() => void send()}
                    >
                      {remaining > 0 ? `${remaining} 秒后可重发` : "重新发送"}
                    </Button>
                  </div>
                )}
              </>
            ) : step === "password" ? (
              <>
                <div className={styles.field}>
                  <label htmlFor={passwordId}>
                    {resetting ? "新密码" : "密码"}
                  </label>
                  <Input
                    id={passwordId}
                    ref={passwordRef}
                    type="password"
                    autoComplete="new-password"
                    autoCapitalize="none"
                    spellCheck={false}
                    value={password}
                    disabled={pending !== null || !handoff}
                    invalid={feedbackFor("password") !== null}
                    aria-describedby={descriptionFor("password")}
                    className={styles.input}
                    onChange={(event) => {
                      setPassword(event.target.value);
                      if (feedbackFor("password")) setFeedback(null);
                    }}
                    required
                  />
                  <p id={hintId} className={styles.hint}>
                    6–20 个字符，包含大写字母和数字。
                  </p>
                  {fieldFeedback("password")}
                </div>
                <div className={styles.field}>
                  <label htmlFor={passwordConfirmId}>
                    {resetting ? "确认新密码" : "确认密码"}
                  </label>
                  <Input
                    id={passwordConfirmId}
                    ref={passwordConfirmRef}
                    type="password"
                    autoComplete="new-password"
                    autoCapitalize="none"
                    spellCheck={false}
                    value={passwordConfirm}
                    disabled={pending !== null || !handoff}
                    invalid={feedbackFor("passwordConfirm") !== null}
                    aria-describedby={descriptionFor("passwordConfirm")}
                    className={styles.input}
                    onChange={(event) => {
                      setPasswordConfirm(event.target.value);
                      if (feedbackFor("passwordConfirm")) setFeedback(null);
                    }}
                    required
                  />
                  {fieldFeedback("passwordConfirm")}
                </div>
              </>
            ) : (
              <>
                <div className={styles.field}>
                  <label htmlFor={fieldId}>昵称</label>
                  <Input
                    id={fieldId}
                    ref={nicknameRef}
                    autoComplete="nickname"
                    maxLength={40}
                    value={displayName}
                    disabled={pending !== null || !handoff}
                    placeholder="昵称"
                    invalid={feedbackFor("displayName") !== null}
                    aria-describedby={descriptionFor("displayName")}
                    className={styles.input}
                    onChange={(event) => {
                      setDisplayName(event.target.value);
                      if (feedbackFor("displayName")) setFeedback(null);
                    }}
                    required
                  />
                  {fieldFeedback("displayName")}
                </div>
                <div className={styles.field}>
                  <StudioNameField
                    inputId={studioId}
                    inputRef={studioRef}
                    name={studioName}
                    suffix={studioSuffix}
                    disabled={pending !== null || !handoff}
                    invalid={feedbackFor("studioName") !== null}
                    describedBy={descriptionFor("studioName")}
                    onChange={(name, suffix) => {
                      setStudioName(name);
                      setStudioSuffix(suffix);
                      if (feedbackFor("studioName")) setFeedback(null);
                    }}
                  />
                  {fieldFeedback("studioName")}
                </div>
                <div className={styles.agreementField}>
                  {agreementAvailable ? (
                    <div className={styles.agreementRow}>
                      <label
                        className={styles.agreementChoice}
                        htmlFor={agreementId}
                      >
                        <input
                          id={agreementId}
                          type="checkbox"
                          checked={agreed}
                          disabled={pending !== null || !handoff}
                          aria-invalid={
                            feedbackFor("agreement") ? true : undefined
                          }
                          aria-describedby={
                            feedbackFor("agreement") ? feedbackId : undefined
                          }
                          onChange={(event) => {
                            setAgreed(event.target.checked);
                            if (feedbackFor("agreement")) setFeedback(null);
                          }}
                        />
                        <span>我已阅读并同意</span>
                      </label>
                      <Button
                        ref={agreementButtonRef}
                        variant="quiet"
                        className={styles.agreementLink}
                        disabled={locked}
                        onClick={() => setAgreementOpen(true)}
                      >
                        注册说明
                      </Button>
                    </div>
                  ) : (
                    <p role="status">注册说明暂时不可用，暂时无法创建账户。</p>
                  )}
                  {fieldFeedback("agreement")}
                </div>
              </>
            )}
            {feedback && !feedback.field && (
              <p id={feedbackId} className={styles.error} role="alert">
                <Icon name="error" />
                {feedback.message}
              </p>
            )}
            {feedback?.action ? (
              <Button
                key="auth-recovery-action"
                type="button"
                className={styles.primary}
                disabled={pending !== null}
                onClick={(event) => {
                  // React may replace this recovery action with a submit
                  // button before the browser runs its native click default.
                  event.preventDefault();
                  if (feedback.action === "login") changeMode("sign-in");
                  else restart();
                }}
              >
                {feedback.action === "login" ? "去登录" : "重新验证"}
              </Button>
            ) : (
              <Button
                key="auth-step-submit"
                type="submit"
                className={styles.primary}
                size="lg"
                loading={pending !== null}
                disabled={
                  !available ||
                  registrationUnavailable ||
                  (step === "identifier" && !passwordLogin && remaining > 0) ||
                  (step === "code" && (code.length !== 6 || !challenge)) ||
                  (step === "password" &&
                    (!password || !passwordConfirm || !handoff)) ||
                  (step === "profile" &&
                    (!agreementAvailable ||
                      !agreed ||
                      !displayName.trim() ||
                      !handoff))
                }
              >
                {pending === "send"
                  ? "正在发送…"
                  : pending === "verify"
                    ? "正在验证…"
                    : pending === "confirm"
                      ? "正在创建…"
                      : pending === "password-login"
                        ? "正在登录…"
                        : pending === "reset"
                          ? "正在重置…"
                          : step === "identifier"
                            ? passwordLogin
                              ? "登录"
                              : remaining > 0
                                ? `${remaining} 秒后可重新获取`
                                : "发送验证码"
                            : step === "password"
                              ? resetting
                                ? "重置密码"
                                : "下一步"
                              : step === "profile"
                                ? "创建账户"
                                : registrationStep || resetting
                                  ? "确认验证码"
                                  : "登录"}
              </Button>
            )}
            {step === "identifier" && mode === "sign-in" && (
              <div className={styles.secondaryActions}>
                <Button
                  variant="quiet"
                  disabled={locked || passwordOnly}
                  onClick={() =>
                    changeMethod(passwordLogin ? "code" : "password")
                  }
                >
                  {passwordLogin ? "验证码登录" : "密码登录"}
                </Button>
                {!resetting && (
                  <Button
                    variant="quiet"
                    disabled={locked || passwordOnly}
                    onClick={beginReset}
                  >
                    忘记密码
                  </Button>
                )}
              </div>
            )}
            {step === "profile" && (
              <Button variant="quiet" disabled={locked} onClick={restart}>
                返回并重新验证
              </Button>
            )}
          </form>
        )}
        {step !== "avatar" && step !== "reset-complete" && (
          <footer className={styles.footer}>
            <p>
              {mode === "register" ? "已有账户？" : "还没有账户？"}{" "}
              <a
                href={modeLink}
                aria-disabled={
                  locked || (passwordOnly && mode !== "register") || undefined
                }
                tabIndex={
                  locked || (passwordOnly && mode !== "register")
                    ? -1
                    : undefined
                }
                onClick={(event) => {
                  event.preventDefault();
                  if (!passwordOnly || mode === "register")
                    changeMode(mode === "register" ? "sign-in" : "register");
                }}
              >
                {mode === "register" ? "去登录" : "去注册"}
              </a>
            </p>
          </footer>
        )}
      </section>
    </main>
  );
};
