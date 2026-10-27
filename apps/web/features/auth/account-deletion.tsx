"use client";

import { useEffect, useId, useImperativeHandle, useRef, useState } from "react";
import type { RefObject } from "react";

import { requestIdentity } from "../shell/request-identity";
import { SettingsIcon } from "../settings/settings-icons";
import { digits, reasonOf, reasons } from "./account-security";
import {
  authRequest,
  parseAccountDeletionResult,
  parseAuthAccount,
  requestAccountDeletion,
} from "./auth-api";
import type { AuthAccountSecurity } from "./auth-api";

import styles from "./account-deletion.module.css";

type Channel = "email" | "phone";
type Step = "intro" | "unfinished" | "proof" | "code" | "final" | "done";

interface Proof {
  readonly channel: Channel;
  readonly challengeId: string;
  readonly continuation: string;
  readonly masked: string;
  readonly resendAt: number;
}

const labels = { email: "邮箱", phone: "手机号" } as const;

/** Everything deletion does, stated before anything is irreversible. */
const effects = [
  "账号立即注销，不能撤销，也不能恢复。",
  "所有设备上的登录立即失效。",
  "作品、作品草稿和专题文章草稿（含标题、正文和封面）及其图片，以及头像和背景图会被永久删除。删除在后台进行，可能需要一段时间。",
  "专题文章已提交审核或已发布的版本存档不会删除，已发布的文章停止公开展示。",
  "昵称改为“已注销用户”，简介和工作室名称被清除；账号标识保留，不再显示，也不会分配给他人。",
  "关注、粉丝、你设置的屏蔽、喜欢、收藏和评论点赞会被移除；其他用户对此账号的屏蔽继续有效。",
  "评论和回复保留文字，作者显示为“已注销用户”，不再链接到主页。私信记录对方仍可看到，发送者显示为“已注销用户”；之后不能再收发私信。",
  "绑定的手机号和邮箱会被释放，可以重新注册一个与此无关的新账号；已使用的邀请名额不退还。",
  "举报、申诉、处理记录和反馈按《隐私政策》中的期限保留。",
] as const;

/*
 * No refusal says 账号没有被注销 unless it proves the account is still live:
 * another page or device may have deleted it meanwhile, which also revokes
 * this Session and removes this proof.
 */
const copy: Record<string, string> = {
  ...reasons,
  AUTH_ACCOUNT_SUSPENDED: "当前账户已停用，不能自助注销。",
  AUTH_CHANNEL_UNAVAILABLE: "当前无法通过验证码确认身份，暂时不能注销。",
  // A deletion finished elsewhere removes this proof too (code step).
  AUTH_PROOF_REJECTED: "这次验证已失效，请重新验证。",
  // The Backend also refuses this way once another page or device deleted the
  // account, so it never claims the account is intact.
  AUTH_UNAUTHENTICATED:
    "登录状态已失效，无法在这里确认注销结果。如果已在其他设备或页面完成注销，账号已经注销；否则请重新登录后再试。",
};
/**
 * Refusals of the final request that prove the account is still live: the
 * Backend answers them only after finding, under the account's lock, no
 * deletion of it and an active account.
 */
const finalCopy: Record<string, string> = {
  AUTH_PROOF_REJECTED: "这次验证已失效，请重新验证。账号没有被注销。",
};
/** Final refusals that also settle an earlier unanswered attempt. */
const settledReasons = new Set([
  "AUTH_PROOF_REJECTED",
  "AUTH_ACCOUNT_SUSPENDED",
  "AUTH_CHANNEL_UNAVAILABLE",
]);
const FAILED = "请求失败，请稍后重试。";
/** The proof must be redone before deletion can be asked again. */
const restartReasons = new Set([
  "AUTH_PROOF_REJECTED",
  "AUTH_PROVENANCE_REJECTED",
]);
/** Nothing more can be done on this page. */
const stopReasons = new Set(["AUTH_UNAUTHENTICATED", "AUTH_ACCOUNT_SUSPENDED"]);
const UNCERTAIN = "注销结果尚未确认。请重试；重试不会重复注销。";
const LIMITED = "操作过于频繁，这次请求没有处理，请稍后重试。";
/** Refusals after an unanswered attempt, which may itself have deleted it. */
const LIMITED_UNCERTAIN = "操作过于频繁，请稍后重试；重试不会重复注销。";
const UNCONFIRMED =
  "注销可能已经完成，但这里无法确认。这台设备上为该账号保存的草稿恢复、浏览记录等数据会被清除。请刷新页面确认账号状态。";

/** Bound contacts that can receive a re-verification code now. */
const proofChannels = (account: AuthAccountSecurity | null): Channel[] =>
  account === null
    ? []
    : (["phone", "email"] as const).filter(
        (channel) =>
          account[channel].usable &&
          account[channel].state !== "unbound" &&
          account[channel].state !== "unavailable" &&
          account.capabilities[channel].available,
      );

/** Lets the surrounding dialog ask the page before it is left. */
export interface AccountDeletionHandle {
  /**
   * True when the page must stay: a deletion attempt is unconfirmed, so the
   * page first asks inline whether to leave (leaving keeps this device's data
   * of the account, which may already be deleted).
   */
  requestLeave: () => boolean;
}

/** The settings row that opens this page; the destructive step is later. */
export const AccountDeletionEntry = ({
  disabled,
  onOpen,
}: {
  disabled: boolean;
  onOpen: () => void;
}) => (
  <button
    type="button"
    className={styles.entry}
    data-settings-focus-key="deletion"
    disabled={disabled}
    onClick={onOpen}
  >
    <span>
      <strong>注销账号</strong>
      <small>永久删除账号、作品和图片</small>
    </span>
    <SettingsIcon name="chevron-right" />
  </button>
);

/**
 * account-deletion-v1: explains every effect, refuses an account without a
 * contact that can be re-verified, warns about unfinished work, requires an
 * explicit understanding, a fresh OTP of a bound contact and a final
 * confirmation. Cancel is available until the request is sent. The request
 * names the confirmed account and keeps one idempotency key until the
 * Backend answers definitively, so a retry after a lost answer can only
 * repeat the same deletion. Nothing here changes the account before that
 * final request succeeds. Once an attempt went unanswered, no later refusal
 * is reported as "not deleted" unless it proves so, and leaving the page
 * (取消, Back, dismissal) is confirmed inline first.
 */
export const AccountDeletion = ({
  expectedViewerId,
  unfinishedWork,
  navigationRef,
  onBusyChange,
  onPendingChange,
  onCancel,
  onDeleted,
  onFinished,
}: {
  expectedViewerId: string;
  /** The surrounding dialog asks through this before Back or dismissal. */
  navigationRef?: RefObject<AccountDeletionHandle | null>;
  /** Short descriptions of work that deletion would discard. */
  unfinishedWork: readonly string[];
  /** True while a request runs and after success, so the page is not left. */
  onBusyChange?: (busy: boolean) => void;
  /**
   * True from the first final request until a new proof is started or the
   * page is left: while it is, the outcome on this page (and the Session the
   * same-key retry presents) must not be replaced by a Session recheck.
   */
  onPendingChange?: (pending: boolean) => void;
  onCancel: () => void;
  /**
   * Runs once, as soon as the Backend confirms the deletion, or when the
   * Session is refused after an unanswered attempt (the account may be gone).
   */
  onDeleted?: (accountId: string) => Promise<void> | void;
  /** 完成: leaves the page; the default reloads the product at its root. */
  onFinished?: () => void;
}) => {
  const generation = useRef(0),
    mounted = useRef(false),
    busyRef = useRef(false),
    lockedRef = useRef(false);
  const expected = useRef(expectedViewerId);
  expected.current = expectedViewerId;
  const notifyBusy = useRef(onBusyChange);
  notifyBusy.current = onBusyChange;
  const notifyPending = useRef(onPendingChange);
  notifyPending.current = onPendingChange;
  const pendingRef = useRef(false);
  const proofResendAt = useRef<Partial<Record<Channel, number>>>({});
  // Kept from the first final submission until a definitive answer.
  const deletionKey = useRef<string | null>(null);
  // An attempt with the current key went unanswered: it may have deleted.
  const unanswered = useRef(false);
  const forgetting = useRef<Promise<void> | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const retryButton = useRef<HTMLButtonElement>(null);
  // Leaving was confirmed; the next leave attempt is not asked again.
  const leaveApproved = useRef(false),
    refocusRetry = useRef(false);
  const hintId = useId(),
    errorId = useId(),
    understoodId = useId();
  const [account, setAccount] = useState<AuthAccountSecurity | null>(null);
  const [loading, setLoading] = useState(true),
    [note, setNote] = useState("");
  const [step, setStep] = useState<Step>("intro");
  const [understood, setUnderstood] = useState(false);
  const [proof, setProof] = useState<Proof | null>(null);
  const [code, setCode] = useState("");
  const [reauthToken, setReauthToken] = useState("");
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [restartRequired, setRestartRequired] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const remaining = Math.max(
    0,
    Math.ceil(((proof?.resendAt ?? 0) - now) / 1000),
  );
  const channels = proofChannels(account);
  // An attempt went unanswered and the same-key retry is still possible: the
  // account may already be deleted while this device keeps its data.
  const unconfirmed = step === "final" && uncertain && !stopped;
  const unconfirmedRef = useRef(unconfirmed);
  unconfirmedRef.current = unconfirmed;

  const updateBusy = (value: boolean) => {
    busyRef.current = value;
    notifyBusy.current?.(value || lockedRef.current);
    setBusy(value);
  };
  const updatePending = (value: boolean) => {
    if (pendingRef.current === value) return;
    pendingRef.current = value;
    notifyPending.current?.(value);
  };
  /** Forgets the account's data in this browser, once, even if the page is left. */
  const forget = (owner: string) => {
    forgetting.current ??= (async () => onDeleted?.(owner))().catch(
      () => undefined,
    );
  };
  const load = async () => {
    if (busyRef.current) return;
    const current = ++generation.current,
      owner = expected.current;
    setLoading(true);
    setAccount(null);
    setNote("");
    try {
      const result = await authRequest("account");
      if (
        !mounted.current ||
        current !== generation.current ||
        expected.current !== owner
      )
        return;
      const value =
        result.status === 200 ? parseAuthAccount(result.body) : null;
      if (value !== null && value.userId === owner) setAccount(value);
      else setNote("账户信息暂时无法确认，请重试。");
    } catch {
      if (mounted.current && current === generation.current)
        setNote("账户信息暂时无法读取，请重试。");
    } finally {
      if (mounted.current && current === generation.current) setLoading(false);
    }
  };
  useEffect(() => {
    mounted.current = true;
    lockedRef.current = false;
    deletionKey.current = null;
    unanswered.current = false;
    // A clearing already started for an earlier account still completes.
    forgetting.current = null;
    setStep("intro");
    setUnderstood(false);
    setProof(null);
    setCode("");
    setReauthToken("");
    setError("");
    setRestartRequired(false);
    setStopped(false);
    setUncertain(false);
    setLeaving(false);
    leaveApproved.current = false;
    proofResendAt.current = {};
    updateBusy(false);
    void load();
    return () => {
      mounted.current = false;
      generation.current++;
      busyRef.current = false;
      lockedRef.current = false;
      notifyBusy.current?.(false);
      updatePending(false);
    };
  }, [expectedViewerId]);
  useEffect(() => {
    if (step !== "proof" && step !== "code") return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [step]);
  useEffect(() => {
    if (step !== "intro") heading.current?.focus();
  }, [step]);
  useEffect(() => {
    if (leaving || !refocusRetry.current) return;
    refocusRetry.current = false;
    retryButton.current?.focus();
  }, [leaving]);
  useEffect(() => {
    if (!unconfirmed) return;
    // A reload or closed tab would drop the retry as well: the browser asks.
    const unload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, [unconfirmed]);
  /** True when leaving must be confirmed first; shows that question. */
  const askBeforeLeaving = () => {
    if (!unconfirmedRef.current || leaveApproved.current) return false;
    setLeaving(true);
    return true;
  };
  useImperativeHandle(navigationRef, () => ({
    requestLeave: askBeforeLeaving,
  }));

  const fail = (body: unknown, final = false) => {
    const reason = reasonOf(body);
    setError((final ? finalCopy[reason] : undefined) ?? copy[reason] ?? FAILED);
    if (restartReasons.has(reason)) setRestartRequired(true);
    if (stopReasons.has(reason)) setStopped(true);
  };
  // One synchronous gate and generation cover each request, as in AccountSecurity.
  const run = async (operation: (valid: () => boolean) => Promise<void>) => {
    if (busyRef.current || !mounted.current || stopped) return;
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
  const cancel = () => {
    if (busyRef.current || lockedRef.current || askBeforeLeaving()) return;
    generation.current++;
    onCancel();
  };
  /** 留下重试: the question goes; focus returns to the retry. */
  const stay = () => {
    refocusRetry.current = true;
    setLeaving(false);
  };
  /** 仍然离开: this device keeps the data; nothing more is asked. */
  const leave = () => {
    if (busyRef.current) return;
    leaveApproved.current = true;
    setLeaving(false);
    generation.current++;
    onCancel();
  };
  const advance = () => {
    if (busyRef.current || channels.length === 0) return;
    setError("");
    setStep(unfinishedWork.length > 0 ? "unfinished" : "proof");
  };
  const sendProof = (channel: Channel) => {
    if (!understood || (proofResendAt.current[channel] ?? 0) > Date.now())
      return;
    return run(async (valid) => {
      const result = await authRequest("challenges", {
        body: {
          channel,
          purpose: "reauthenticate",
          idempotencyKey: requestIdentity(),
        },
      });
      if (!valid()) return;
      if (result.status !== 200) {
        fail(result.body);
        return;
      }
      const body = result.body as {
        challengeId?: string;
        continuationToken?: string;
        maskedTarget?: string;
        resendAvailableAt?: string;
      } | null;
      if (!body?.challengeId || !body.continuationToken) {
        setError("这次验证无法继续，请重新获取验证码。");
        return;
      }
      const resendAt = Date.parse(body.resendAvailableAt ?? "");
      const deadline = Number.isFinite(resendAt)
        ? resendAt
        : Date.now() + 60_000;
      proofResendAt.current[channel] = deadline;
      setNow(Date.now());
      setProof({
        channel,
        challengeId: body.challengeId,
        continuation: body.continuationToken,
        masked: body.maskedTarget ?? "",
        resendAt: deadline,
      });
      setCode("");
      setRestartRequired(false);
      setStep("code");
    });
  };
  const verify = () => {
    const current = proof;
    if (current === null || restartRequired || code.length !== 6) return;
    void run(async (valid) => {
      const result = await authRequest("challenges/verify", {
        body: {
          challengeId: current.challengeId,
          code,
          continuationToken: current.continuation,
          idempotencyKey: requestIdentity(),
        },
      });
      if (!valid()) return;
      if (result.status !== 200) {
        fail(result.body);
        return;
      }
      const body = result.body as {
        outcome?: string;
        reauthToken?: string;
      } | null;
      if (body?.outcome !== "reauthenticated" || !body.reauthToken) {
        setError("这次验证不能继续，请重新验证。");
        setRestartRequired(true);
        return;
      }
      setReauthToken(body.reauthToken);
      deletionKey.current = null;
      unanswered.current = false;
      setUncertain(false);
      setCode("");
      setStep("final");
    });
  };
  const confirm = () => {
    if (!reauthToken || restartRequired) return;
    void run(async (valid) => {
      const owner = expected.current;
      deletionKey.current ??= requestIdentity();
      leaveApproved.current = false;
      updatePending(true);
      let result: Awaited<ReturnType<typeof requestAccountDeletion>>;
      try {
        result = await requestAccountDeletion(owner, {
          reauthToken,
          idempotencyKey: deletionKey.current,
        });
      } catch {
        // The request may or may not have arrived: keep the key for a retry.
        unanswered.current = true;
        if (valid()) {
          setUncertain(true);
          setError(UNCERTAIN);
        }
        return;
      }
      const deleted =
        result.status === 200 ? parseAccountDeletionResult(result.body) : null;
      if (deleted !== null) {
        // The account is gone whatever this page shows by now: this browser
        // forgets its data even if the page was left meanwhile.
        forget(owner);
        if (!valid()) return;
        deletionKey.current = null;
        lockedRef.current = true;
        setUncertain(false);
        setReauthToken("");
        setStep("done");
        return;
      }
      if (!valid()) return;
      const reason = reasonOf(result.body);
      if (result.status === 429 || reason === "AUTH_RATE_LIMITED") {
        // Refused before anything ran; the same key may be sent again. An
        // earlier unanswered attempt may still have deleted the account.
        setUncertain(unanswered.current);
        setError(unanswered.current ? LIMITED_UNCERTAIN : LIMITED);
        return;
      }
      if (
        reason !== "AUTH_CHANNEL_UNAVAILABLE" &&
        (result.status === 200 || result.status === 408 || result.status >= 500)
      ) {
        // Not a definitive answer: the same key retries this exact request.
        unanswered.current = true;
        setUncertain(true);
        setError(UNCERTAIN);
        return;
      }
      if (
        unanswered.current &&
        result.status === 401 &&
        reason !== "AUTH_ACCOUNT_SUSPENDED"
      ) {
        // The Session this retry needed is gone (revoked by a deletion this
        // page never saw confirmed, or replaced meanwhile): the account may be
        // deleted, so it is never called intact and this browser forgets its
        // data as after a confirmed deletion. Nothing more can be done here.
        forget(owner);
        setStopped(true);
        setError(UNCONFIRMED);
        return;
      }
      if (unanswered.current && !settledReasons.has(reason)) {
        // A refusal that proves nothing about the earlier attempt: its key
        // stays the only safe retry.
        setUncertain(true);
        setError(UNCERTAIN);
        return;
      }
      deletionKey.current = null;
      unanswered.current = false;
      setUncertain(false);
      fail(result.body, true);
    });
  };
  const finish = async () => {
    if (!lockedRef.current || finishing) return;
    setFinishing(true);
    await forgetting.current;
    lockedRef.current = false;
    notifyBusy.current?.(false);
    if (onFinished) onFinished();
    else window.location.assign("/");
  };
  const restart = () => {
    if (busyRef.current) return;
    generation.current++;
    setProof(null);
    setCode("");
    setReauthToken("");
    setError("");
    setRestartRequired(false);
    deletionKey.current = null;
    unanswered.current = false;
    updatePending(false);
    setStep("proof");
  };

  const cancelButton =
    step === "done" ? null : (
      <button
        type="button"
        className={styles.secondary}
        disabled={busy}
        onClick={cancel}
      >
        取消
      </button>
    );
  const errorText = error && (
    <p className={styles.error} role="alert" id={errorId}>
      {error}
    </p>
  );
  return (
    <section
      aria-label="注销账号"
      className={styles.panel}
      aria-busy={busy}
      data-deletion-step={step}
    >
      {step === "intro" && (
        <>
          <h3 className={styles.title}>注销后</h3>
          <ul className={styles.effects}>
            {effects.map((effect) => (
              <li key={effect}>{effect}</li>
            ))}
          </ul>
          {loading ? (
            <p className={styles.muted} role="status">
              正在确认账户信息。
            </p>
          ) : account === null ? (
            <div className={styles.notice}>
              <p role="status">{note}</p>
              <button
                type="button"
                className={styles.secondary}
                onClick={() => void load()}
              >
                重试
              </button>
            </div>
          ) : channels.length === 0 ? (
            <p className={styles.notice} role="status">
              注销前需要用已绑定的手机号或邮箱接收验证码确认身份。当前账号没有可以接收验证码的联系方式，因此暂时不能在这里注销。账号没有任何变化。
            </p>
          ) : null}
          {errorText}
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.secondary}
              disabled={busy || loading || channels.length === 0}
              onClick={advance}
            >
              继续
            </button>
            {cancelButton}
          </div>
        </>
      )}
      {step === "unfinished" && (
        <>
          <h4 className={styles.title} ref={heading} tabIndex={-1}>
            还有未完成的内容
          </h4>
          <ul className={styles.effects}>
            {unfinishedWork.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <p className={styles.muted}>
            注销后，这些内容不能再保存或发布，会随账号一起删除。
          </p>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.secondary}
              onClick={() => setStep("proof")}
            >
              仍然继续
            </button>
            {cancelButton}
          </div>
        </>
      )}
      {step === "proof" && (
        <>
          <h4 className={styles.title} ref={heading} tabIndex={-1}>
            验证身份
          </h4>
          <label className={styles.check} htmlFor={understoodId}>
            <input
              id={understoodId}
              type="checkbox"
              checked={understood}
              disabled={busy}
              onChange={(event) => setUnderstood(event.target.checked)}
            />
            我已了解注销后无法恢复
          </label>
          <p className={styles.muted} id={hintId}>
            向已绑定的联系方式发送验证码，确认是你本人在操作。
          </p>
          <div className={styles.channels}>
            {channels.map((channel) => {
              const wait = Math.max(
                0,
                Math.ceil(((proofResendAt.current[channel] ?? 0) - now) / 1000),
              );
              return (
                <button
                  key={channel}
                  type="button"
                  className={styles.secondary}
                  aria-describedby={hintId}
                  disabled={busy || !understood || wait > 0}
                  onClick={() => void sendProof(channel)}
                >
                  {`发送验证码到${labels[channel]} ${account?.[channel].masked ?? ""}`.trim()}
                  {wait > 0 ? `（${wait} 秒后可发送）` : ""}
                </button>
              );
            })}
          </div>
          {errorText}
          <div className={styles.actions}>{cancelButton}</div>
        </>
      )}
      {step === "code" && proof && (
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            verify();
          }}
        >
          <h4 className={styles.title} ref={heading} tabIndex={-1}>
            验证{labels[proof.channel]}
          </h4>
          <p className={styles.muted} id={hintId}>
            验证码已发往{labels[proof.channel]}
            {proof.masked ? ` ${proof.masked}` : ""}
            。验证后还需要最后确认，账号才会注销。
          </p>
          <label className={styles.field}>
            验证码
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              aria-label="验证码"
              aria-describedby={`${hintId}${error ? ` ${errorId}` : ""}`}
              maxLength={6}
              pattern="[0-9]{6}"
              value={code}
              disabled={busy || restartRequired}
              onPaste={(event) => {
                const next = digits(event.clipboardData.getData("text"));
                if (next.length === 0) return;
                event.preventDefault();
                setCode(next);
              }}
              onChange={(event) => setCode(digits(event.target.value))}
              required
            />
          </label>
          {errorText}
          <button
            type="submit"
            className={styles.primary}
            disabled={busy || restartRequired || stopped || code.length !== 6}
          >
            {busy ? "处理中" : "验证"}
          </button>
          <div className={styles.actions}>
            {restartRequired ? (
              <button
                type="button"
                className={styles.secondary}
                disabled={busy}
                onClick={restart}
              >
                重新验证
              </button>
            ) : (
              <button
                type="button"
                className={styles.secondary}
                disabled={busy || stopped || remaining > 0}
                onClick={() => void sendProof(proof.channel)}
              >
                {remaining > 0 ? `${remaining} 秒后重新获取` : "重新获取验证码"}
              </button>
            )}
            {cancelButton}
          </div>
        </form>
      )}
      {step === "final" && (
        <>
          <h4 className={styles.title} ref={heading} tabIndex={-1}>
            确认注销
          </h4>
          <p className={styles.warning}>
            确认后账号会立即注销，所有设备随即退出登录。这一步不能撤销。
          </p>
          {errorText}
          {leaving && unconfirmed ? (
            <LeaveQuestion onStay={stay} onLeave={leave} />
          ) : (
            <>
              {restartRequired ? (
                <button
                  type="button"
                  className={styles.secondary}
                  disabled={busy}
                  onClick={restart}
                >
                  重新验证
                </button>
              ) : (
                <button
                  ref={retryButton}
                  type="button"
                  className={styles.destructive}
                  disabled={busy || stopped}
                  onClick={confirm}
                >
                  {busy ? "正在注销" : uncertain ? "重试注销" : "确认注销"}
                </button>
              )}
              <div className={styles.actions}>{cancelButton}</div>
            </>
          )}
        </>
      )}
      {step === "done" && (
        <>
          <h4 className={styles.title} ref={heading} tabIndex={-1}>
            账号已注销
          </h4>
          <p className={styles.notice} role="status">
            所有设备上的登录已失效。作品和图片正在后台删除；这台设备上为该账号保存的草稿恢复、浏览记录等数据也已清除。
          </p>
          <button
            type="button"
            className={styles.primary}
            disabled={finishing}
            onClick={() => void finish()}
          >
            完成
          </button>
        </>
      )}
    </section>
  );
};

/**
 * Asked before leaving after an unconfirmed attempt, inline as the drafts
 * confirmations are (one dialog, no second modal): focus starts on the safe
 * choice and Escape answers this question only.
 */
const LeaveQuestion = ({
  onStay,
  onLeave,
}: {
  onStay: () => void;
  onLeave: () => void;
}) => {
  const titleId = useId(),
    descriptionId = useId();
  const stayButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    stayButton.current?.focus();
  }, []);
  return (
    <div
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      className={styles.confirm}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        // Keeps the settings dialog open: Escape means 留下重试 here.
        event.preventDefault();
        event.stopPropagation();
        onStay();
      }}
    >
      <p className={styles.confirmTitle} id={titleId}>
        注销可能已经完成
      </p>
      <p className={styles.confirmText} id={descriptionId}>
        上一次注销请求没有得到确认，账号可能已经注销。现在离开，这台设备上为该账号保存的草稿恢复、浏览记录等数据会保留；留下重试可以确认结果，重试不会重复注销。
      </p>
      <div className={styles.actions}>
        <button
          ref={stayButton}
          type="button"
          className={styles.primary}
          onClick={onStay}
        >
          留下重试
        </button>
        <button type="button" className={styles.secondary} onClick={onLeave}>
          仍然离开
        </button>
      </div>
    </div>
  );
};
