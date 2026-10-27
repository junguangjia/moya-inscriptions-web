"use client";

import { workspacePageLabel } from "../workspace/routes";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ConfirmationModal, SetStepNav, useModal } from "@payloadcms/ui";

import {
  TIME_ZONE_NOTE,
  call,
  capacityClassLabels,
  describeFailure,
  describeFinalFailure,
  formatPreciseTime,
  outcomeUnknown,
} from "./api";
import styles from "./community.module.css";
import { formatBytes } from "./work-publishing-limits";
import { capacityDesignationAllowed } from "./work-publishing-rules";

import type { AccountCapacityClass, OperatorAccountCapacity } from "./api";

interface Notice {
  readonly tone: "success" | "error" | "info";
  readonly text: string;
}

interface Designation {
  readonly accountId: string;
  readonly capacityClass: AccountCapacityClass;
  readonly expectedVersion: number;
  readonly requestId: string;
}

const CONFIRM_SLUG = "community-account-capacity-confirm";
const accountIdPattern = /^user-[0-9a-f]{32}$/u;
const classes: readonly AccountCapacityClass[] = ["ordinary", "owner"];

const readAccount = (params: URLSearchParams): string | null => {
  const account = params.get("account");
  return account !== null && accountIdPattern.test(account) ? account : null;
};

/**
 * Account capacity designation on an immutable PublicUserId. The Owner
 * account's larger capacity is never inferred from a handle, a display name
 * or a client claim: the Owner enters or follows the account id, reviews the
 * current usage and confirms the class change, which the Backend audits.
 * Everything on screen belongs to the account in the URL: another account's
 * capacity is never shown for it, and a change that finishes after the Owner
 * moved on only reports its receipt.
 */
export const AccountCapacityClient = () => {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const account = useMemo(() => readAccount(searchParams), [searchParams]);
  const { openModal, closeModal } = useModal();

  const [draft, setDraft] = useState(account ?? "");
  const [draftError, setDraftError] = useState<string | null>(null);
  const [capacity, setCapacity] = useState<OperatorAccountCapacity | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [choice, setChoice] = useState<AccountCapacityClass | null>(null);
  const [confirmation, setConfirmation] = useState<Designation | null>(null);
  const [verified, setVerified] = useState(false);
  const [retry, setRetry] = useState<Designation | null>(null);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<Notice | null>(null);
  const lock = useRef(false);
  const sequence = useRef(0);
  // The account the page is for right now; late answers for another are dropped.
  const accountRef = useRef(account);

  const load = useCallback(async (accountId: string | null) => {
    const current = (sequence.current += 1);
    // A different account never inherits the previous card or class choice.
    setCapacity((shown) => (shown?.accountId === accountId ? shown : null));
    if (accountId === null) {
      setChoice(null);
      setLoadError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const result = await call<OperatorAccountCapacity>(
        "read-account-capacity",
        { accountId },
      );
      if (current !== sequence.current || accountRef.current !== accountId)
        return;
      setCapacity(result);
      setChoice(result.capacityClass);
      setLoadError(null);
    } catch (failure) {
      if (current !== sequence.current || accountRef.current !== accountId)
        return;
      setCapacity(null);
      setChoice(null);
      const { code, text } = describeFailure(failure);
      setLoadError(
        code === "NOT_FOUND" ? "没有这个账号，或该账号已不可用。" : text,
      );
    } finally {
      if (current === sequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    accountRef.current = account;
    setDraft(account ?? "");
    setReceipt(null);
    setRetry(null);
    setVerified(false);
    setConfirmation(null);
    setChoice(null);
    setLoadError(null);
    void load(account);
  }, [account, load]);

  const open = (value: string) => {
    const trimmed = value.trim();
    if (!accountIdPattern.test(trimmed)) {
      setDraftError(
        "请输入完整的账号 ID（user- 加 32 位小写十六进制），不接受账号名或显示名。",
      );
      return;
    }
    setDraftError(null);
    if (lock.current) return;
    if (trimmed === account) void load(trimmed);
    else
      router.replace(`${pathname}?account=${encodeURIComponent(trimmed)}`, {
        scroll: false,
      });
  };

  const designate = async (designation: Designation) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    const stillCurrent = () => accountRef.current === designation.accountId;
    try {
      const result = await call<OperatorAccountCapacity>(
        "set-account-capacity",
        designation,
      );
      setReceipt({
        tone: "success",
        text: `已将账号 ${result.accountId} 设为「${capacityClassLabels[result.capacityClass]}」，容量 ${formatBytes(result.capacityBytes)}。已占用的媒体不受影响。`,
      });
      if (stillCurrent() && result.accountId === designation.accountId) {
        // The answer supersedes any read that was still on its way.
        sequence.current += 1;
        setLoading(false);
        setCapacity(result);
        setChoice(result.capacityClass);
        setLoadError(null);
        setRetry(null);
      }
    } catch (failure) {
      const { code, text } = describeFailure(failure);
      const subject = `账号 ${designation.accountId}`;
      if (outcomeUnknown(failure)) {
        if (stillCurrent()) {
          // Outcome unknown: the same request identity may be re-sent safely.
          setRetry(designation);
          setReceipt({
            tone: "error",
            text: `更改结果未确认（${subject}）：${text}`,
          });
        } else
          setReceipt({
            tone: "error",
            text: `更改结果未确认（${subject}）：${text}请回到该账号查看最新状态。`,
          });
      } else {
        if (stillCurrent()) setRetry(null);
        setReceipt({
          tone: "error",
          text:
            code === "STATE_CONFLICT"
              ? `${subject} 的容量记录已被其他操作更新，本次更改未执行。${stillCurrent() ? "已载入最新状态，请重新检查后再决定。" : ""}`
              : code === "OPERATOR_RESPONSE_INVALID"
                ? `更改结果无法确认（${subject}）：${text}`
                : `更改未执行（${subject}）：${describeFinalFailure(failure)}`,
        });
        if (stillCurrent()) await load(designation.accountId);
      }
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };

  const used =
    capacity === null ? 0 : capacity.committedBytes + capacity.reservedBytes;

  return (
    <div className={styles.workspace}>
      <SetStepNav
        nav={[
          {
            label: "用户",
            url: "/admin/community-moderation/content?tab=users",
          },
          { label: "发布额度" },
        ]}
      />
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>
            {workspacePageLabel("/admin/community-moderation/account-capacity")}
          </h1>
          <p className={styles.lead}>
            按用户编号查看已用空间和存储额度。各类额度可在
            <Link href="/admin/community-moderation/settings">发布规则</Link>
            中配置；{TIME_ZONE_NOTE}。
          </p>
        </div>
      </header>

      <form
        className={styles.filters}
        onSubmit={(event) => {
          event.preventDefault();
          open(draft);
        }}
      >
        <label>
          账号 ID
          <input
            aria-describedby="account-capacity-hint"
            aria-invalid={draftError !== null}
            autoComplete="off"
            data-account-capacity-input=""
            disabled={busy}
            maxLength={37}
            onChange={(event) => setDraft(event.currentTarget.value)}
            placeholder="user-0123456789abcdef0123456789abcdef"
            spellCheck={false}
            value={draft}
          />
        </label>
        <button
          className={styles.actionButton}
          disabled={loading || busy}
          type="submit"
        >
          查看容量
        </button>
      </form>
      <p className={styles.secondary} id="account-capacity-hint">
        账号 ID 可在「作品提交审核」的提交详情中找到；不接受账号名或显示名。
      </p>
      {draftError === null ? null : (
        <p className={styles.notice} data-tone="error" role="alert">
          {draftError}
        </p>
      )}

      {receipt === null ? null : (
        <p className={styles.receipt} data-tone={receipt.tone} role="status">
          {receipt.text}
          {retry === null ? null : (
            <>
              {" "}
              <button
                className={styles.rowLink}
                disabled={busy}
                onClick={() => void designate(retry)}
                type="button"
              >
                重试同一操作
              </button>
            </>
          )}
        </p>
      )}

      {account === null ? (
        <p className={styles.state}>输入账号 ID 后查看其容量与占用。</p>
      ) : loadError !== null ? (
        <p className={styles.state} role="alert">
          无法读取发布额度：{loadError}{" "}
          <button
            className={styles.rowLink}
            disabled={busy}
            onClick={() => void load(account)}
            type="button"
          >
            重试
          </button>
        </p>
      ) : capacity === null || capacity.accountId !== account ? (
        <p className={styles.state} role="status">
          正在读取…
        </p>
      ) : (
        <section
          aria-labelledby="account-capacity-title"
          className={styles.card}
          data-account-capacity={capacity.accountId}
        >
          <h2 id="account-capacity-title">
            当前：{capacityClassLabels[capacity.capacityClass]}
          </h2>
          <p className={styles.mono}>{capacity.accountId}</p>
          <ul className={styles.stats}>
            <li>
              <strong>{formatBytes(capacity.capacityBytes)}</strong>
              <span>容量</span>
            </li>
            <li>
              <strong>{formatBytes(capacity.committedBytes)}</strong>
              <span>已保存</span>
            </li>
            <li>
              <strong>{formatBytes(capacity.reservedBytes)}</strong>
              <span>上传中预留</span>
            </li>
            <li>
              <strong>
                {formatBytes(Math.max(0, capacity.capacityBytes - used))}
              </strong>
              <span>剩余可用</span>
            </li>
          </ul>
          <p className={styles.secondary}>
            版本 {capacity.version}
            {capacity.updatedAt === null ? (
              "；尚无更新记录"
            ) : (
              <>
                {" "}
                · 更新于{" "}
                <time dateTime={capacity.updatedAt}>
                  {formatPreciseTime(capacity.updatedAt)}
                </time>
              </>
            )}
            。
          </p>
          {used > capacity.capacityBytes ? (
            <p className={styles.notice} data-tone="info">
              已占用超过当前容量：新的媒体上传会被拒绝，已有作品、草稿与媒体不会被删除。
            </p>
          ) : null}

          <fieldset className={styles.fieldset}>
            <legend>容量类别</legend>
            <div
              aria-label="容量类别"
              className={styles.tabs}
              role="radiogroup"
            >
              {classes.map((option) => (
                <button
                  aria-checked={choice === option}
                  className={styles.option}
                  data-capacity-class-option={option}
                  disabled={busy}
                  key={option}
                  onClick={() => {
                    setChoice(option);
                    setVerified(false);
                  }}
                  role="radio"
                  type="button"
                >
                  {capacityClassLabels[option]}
                </button>
              ))}
            </div>
            <p className={styles.secondary}>
              「Owner 账号」只用于真实的 Owner
              社区账号；普通账号使用普通容量。更改只影响之后的上传额度，不会删除或移动任何已保存的媒体。
            </p>
            {choice === "owner" && capacity.capacityClass !== "owner" ? (
              <label className={styles.summaryLine}>
                <input
                  checked={verified}
                  data-account-capacity-verified=""
                  disabled={busy}
                  onChange={(event) => setVerified(event.currentTarget.checked)}
                  type="checkbox"
                />
                我已核对上面的账号 ID，确认它是真实的 Owner 社区账号
              </label>
            ) : null}
          </fieldset>
          <div className={styles.actions}>
            <button
              className={styles.actionButton}
              data-primary="true"
              disabled={
                !capacityDesignationAllowed({
                  account,
                  capacity,
                  choice,
                  verified,
                  loading,
                  busy,
                  retryPending: retry !== null,
                })
              }
              onClick={() => {
                if (
                  choice === null ||
                  !capacityDesignationAllowed({
                    account,
                    capacity,
                    choice,
                    verified,
                    loading,
                    busy,
                    retryPending: retry !== null,
                  })
                )
                  return;
                setConfirmation({
                  accountId: capacity.accountId,
                  capacityClass: choice,
                  expectedVersion: capacity.version,
                  requestId: crypto.randomUUID(),
                });
                openModal(CONFIRM_SLUG);
              }}
              type="button"
            >
              更改容量类别…
            </button>
          </div>
        </section>
      )}

      <ConfirmationModal
        body={
          confirmation === null ? (
            <p />
          ) : (
            <div>
              <p>
                将账号{" "}
                <span className={styles.mono}>{confirmation.accountId}</span>{" "}
                设为「{capacityClassLabels[confirmation.capacityClass]}」。
              </p>
              <p>
                {confirmation.capacityClass === "owner"
                  ? "该账号将使用 Owner 发布额度。请确认这个账号 ID 属于真实的 Owner 社区账号，而不是按账号名或显示名推断。"
                  : "该账号将使用普通发布额度。已占用超过普通容量时，新的媒体上传会被拒绝，已有内容不会被删除。"}
              </p>
              <p>
                此次更改会记入操作记录。若账号设置已被更新，请刷新后重新核对。
              </p>
            </div>
          )
        }
        cancelLabel="取消"
        confirmLabel="确认更改"
        confirmingLabel="处理中…"
        heading="确认更改容量类别"
        modalSlug={CONFIRM_SLUG}
        onCancel={() => setConfirmation(null)}
        onConfirm={async () => {
          closeModal(CONFIRM_SLUG);
          const target = confirmation;
          setConfirmation(null);
          if (target === null) return;
          if (target.capacityClass === "owner" && !verified) return;
          if (target.accountId !== accountRef.current) return;
          await designate(target);
          setVerified(false);
        }}
      />
    </div>
  );
};
