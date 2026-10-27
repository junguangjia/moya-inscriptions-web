"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmationModal, useModal } from "@payloadcms/ui";

import {
  TIME_ZONE_NOTE,
  call,
  describeFailure,
  describeFinalFailure,
  formatPreciseTime,
  outcomeUnknown,
  policyLabels,
  workPolicyDescriptions,
} from "./api";
import styles from "./community.module.css";
import {
  WORK_PUBLISHING_LIMIT_FIELDS,
  formatBytes,
  limitDisplayValue,
  limitRangeText,
  readLimitInput,
} from "./work-publishing-limits";

import type {
  PublicationPolicy,
  SetWorkPublishingSettingsCommand,
  WorkPublishingSettings,
} from "./api";
import type {
  WorkPublishingLimitField,
  WorkPublishingLimitName,
} from "./work-publishing-limits";

type Inputs = Record<WorkPublishingLimitName, string>;
type Edited = ReadonlySet<WorkPublishingLimitName>;
type FieldErrors = Partial<Record<WorkPublishingLimitName, string>>;

interface Notice {
  readonly tone: "success" | "error" | "info";
  readonly text: string;
}

const CONFIRM_SLUG = "community-work-settings-confirm";
const policies: readonly PublicationPolicy[] = [
  "DIRECT_PUBLICATION",
  "PRE_MODERATION",
];

const inputsOf = (settings: WorkPublishingSettings): Inputs =>
  Object.fromEntries(
    WORK_PUBLISHING_LIMIT_FIELDS.map((field) => [
      field.name,
      limitDisplayValue(field, settings[field.name]),
    ]),
  ) as Inputs;

/** Byte limits read as binary units; counts, days and minutes as themselves. */
const describeValue = (field: WorkPublishingLimitField, value: number) =>
  field.scale === 1 ? `${value} ${field.unit}` : formatBytes(value);

const changesOf = (
  settings: WorkPublishingSettings,
  command: SetWorkPublishingSettingsCommand,
): string[] => [
  ...(command.policy === settings.policy
    ? []
    : [
        `作品发布模式：${policyLabels[settings.policy]} → ${policyLabels[command.policy]}`,
      ]),
  ...WORK_PUBLISHING_LIMIT_FIELDS.filter(
    (field) => command[field.name] !== settings[field.name],
  ).map(
    (field) =>
      `${field.label}：${describeValue(field, settings[field.name])} → ${describeValue(field, command[field.name])}`,
  ),
];

/**
 * The work publication policy and limits, saved together as one versioned
 * Backend setting. Independent of the comment policy on the same page and
 * prospective only: saving never rewrites existing works, pending
 * submissions or stored media. A stale version is a conflict: the latest
 * setting is loaded and nothing is overwritten.
 */
export const WorkPublishingSettingsCard = () => {
  const { openModal, closeModal } = useModal();
  const [settings, setSettings] = useState<WorkPublishingSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [policy, setPolicy] = useState<PublicationPolicy | null>(null);
  const [inputs, setInputs] = useState<Inputs | null>(null);
  // Only a field the Owner typed into is re-read; the rest keep their stored values.
  const [edited, setEdited] = useState<Edited>(new Set());
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [confirmation, setConfirmation] =
    useState<SetWorkPublishingSettingsCommand | null>(null);
  const [retry, setRetry] = useState<SetWorkPublishingSettingsCommand | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<Notice | null>(null);
  const lock = useRef(false);
  const sequence = useRef(0);

  const adopt = (next: WorkPublishingSettings) => {
    setSettings(next);
    setPolicy(next.policy);
    setInputs(inputsOf(next));
    setEdited(new Set());
    setFieldErrors({});
  };

  const load = useCallback(async () => {
    const current = (sequence.current += 1);
    try {
      const next = await call<WorkPublishingSettings>(
        "read-work-publishing-settings",
      );
      if (current !== sequence.current) return;
      adopt(next);
      setLoadError(null);
    } catch (failure) {
      if (current !== sequence.current) return;
      setLoadError(describeFailure(failure).text);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      sequence.current += 1;
    };
  }, [load]);

  const dirty =
    settings !== null &&
    inputs !== null &&
    (policy !== settings.policy || edited.size > 0);

  const review = () => {
    if (settings === null || inputs === null || policy === null) return;
    const errors: FieldErrors = {};
    const values = {} as Record<WorkPublishingLimitName, number>;
    for (const field of WORK_PUBLISHING_LIMIT_FIELDS) {
      const result = readLimitInput(
        field,
        inputs[field.name],
        settings[field.name],
        edited.has(field.name),
      );
      if (result.ok) values[field.name] = result.value;
      else errors[field.name] = result.message;
    }
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      setReceipt({
        tone: "error",
        text: "有字段未通过校验，未保存。请按提示修改后再保存。",
      });
      return;
    }
    const command: SetWorkPublishingSettingsCommand = {
      requestId: crypto.randomUUID(),
      expectedVersion: settings.version,
      policy,
      ...values,
    };
    if (changesOf(settings, command).length === 0) {
      setReceipt({ tone: "info", text: "没有需要保存的更改。" });
      return;
    }
    setReceipt(null);
    setConfirmation(command);
    openModal(CONFIRM_SLUG);
  };

  const save = async (command: SetWorkPublishingSettingsCommand) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      const next = await call<WorkPublishingSettings>(
        "set-work-publishing-settings",
        command,
      );
      sequence.current += 1;
      adopt(next);
      setLoadError(null);
      setRetry(null);
      setReceipt({
        tone: "success",
        text: "作品发布设置已保存，立即对之后的提交与上传生效；已有作品和待审核提交保持原状。",
      });
    } catch (failure) {
      const { code, text } = describeFailure(failure);
      if (code === "STATE_CONFLICT") {
        setRetry(null);
        setReceipt({
          tone: "error",
          text: "作品发布设置已被其他操作更新，本次保存未执行。已载入最新设置，请重新检查后再保存。",
        });
        await load();
      } else if (code === "OPERATOR_RESPONSE_INVALID") {
        // The Backend answered, but not in the contract shape: reload the truth.
        setRetry(null);
        setReceipt({
          tone: "error",
          text: `保存结果无法确认：${text}已重新读取当前设置。`,
        });
        await load();
      } else if (outcomeUnknown(failure)) {
        // The outcome is unknown; the same request identity may be re-sent.
        setRetry(command);
        setReceipt({ tone: "error", text: `保存结果未确认：${text}` });
      } else {
        // A refusal the Backend decided: nothing changed, never re-sent.
        setRetry(null);
        setReceipt({
          tone: "error",
          text: `保存未执行：${describeFinalFailure(failure)}`,
        });
      }
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };

  const pendingChanges =
    settings === null || confirmation === null
      ? []
      : changesOf(settings, confirmation);
  const policyChanging =
    settings !== null &&
    confirmation !== null &&
    confirmation.policy !== settings.policy;

  return (
    <section
      aria-labelledby="community-work-settings-title"
      className={styles.card}
      data-work-publishing-settings=""
    >
      <h2 id="community-work-settings-title">作品发布设置</h2>
      <p className={styles.lead}>
        作品和评论可分别设置发布方式。切换只影响此后作者新提交的公开版本：已公开的作品仍公开，已在待审核的提交仍待审核，仅自己可见的作品不会进入审核，也不会被批量更改。
      </p>

      {loadError !== null ? (
        <p className={styles.notice} data-tone="error" role="alert">
          无法读取作品发布设置：{loadError}{" "}
          <button
            className={styles.rowLink}
            onClick={() => void load()}
            type="button"
          >
            重试
          </button>
        </p>
      ) : null}

      {settings === null || inputs === null || policy === null ? (
        loadError === null ? (
          <p className={styles.state} role="status">
            正在读取作品发布设置…
          </p>
        ) : null
      ) : (
        <form
          className={styles.settingsForm}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            review();
          }}
        >
          <fieldset className={styles.fieldset}>
            <legend>作品发布模式</legend>
            <div
              aria-label="作品发布模式"
              className={styles.tabs}
              role="radiogroup"
            >
              {policies.map((option) => (
                <button
                  aria-checked={policy === option}
                  className={styles.option}
                  data-work-policy-option={option}
                  disabled={busy}
                  key={option}
                  onClick={() => setPolicy(option)}
                  role="radio"
                  type="button"
                >
                  {policyLabels[option]}
                </button>
              ))}
            </div>
            <p className={styles.lead}>{workPolicyDescriptions[policy]}</p>
            {policy === settings.policy ? null : (
              <p className={styles.notice} data-tone="info">
                尚未保存：当前生效的仍是「{policyLabels[settings.policy]}」。
              </p>
            )}
          </fieldset>

          <fieldset className={styles.fieldset}>
            <legend>限制</legend>
            <div className={styles.limitGrid}>
              {WORK_PUBLISHING_LIMIT_FIELDS.map((field) => {
                const error = fieldErrors[field.name];
                const id = `work-limit-${field.name}`;
                return (
                  <div className={styles.limitField} key={field.name}>
                    <label htmlFor={id}>
                      {field.label}（{field.unit}）
                    </label>
                    <input
                      aria-describedby={`${id}-hint${error === undefined ? "" : ` ${id}-error`}`}
                      aria-invalid={error !== undefined}
                      data-work-limit={field.name}
                      disabled={busy}
                      id={id}
                      inputMode={field.decimals === 0 ? "numeric" : "decimal"}
                      max={field.maximum / field.scale}
                      min={
                        field.decimals === 0
                          ? field.minimum / field.scale
                          : 0.001
                      }
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        setInputs((current) =>
                          current === null
                            ? current
                            : { ...current, [field.name]: value },
                        );
                        setEdited((current) =>
                          current.has(field.name)
                            ? current
                            : new Set([...current, field.name]),
                        );
                      }}
                      step={field.decimals === 0 ? 1 : 0.001}
                      type="number"
                      value={inputs[field.name]}
                    />
                    <span className={styles.secondary} id={`${id}-hint`}>
                      {field.hint} 范围 {limitRangeText(field)}
                      {field.decimals === 0 ? "" : "（可输入三位小数）"}
                      ；当前 {describeValue(field, settings[field.name])}。
                    </span>
                    {error === undefined ? null : (
                      <span
                        className={styles.rowNotice}
                        data-tone="error"
                        id={`${id}-error`}
                        role="alert"
                      >
                        {error}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </fieldset>

          <div className={styles.actions}>
            <button
              className={styles.actionButton}
              data-primary="true"
              disabled={busy || !dirty}
              type="submit"
            >
              {busy ? "保存中…" : "保存作品发布设置…"}
            </button>
            <button
              className={styles.actionButton}
              disabled={busy || !dirty}
              onClick={() => {
                adopt(settings);
                setReceipt(null);
              }}
              type="button"
            >
              放弃更改
            </button>
            {retry === null ? null : (
              <button
                className={styles.actionButton}
                disabled={busy}
                onClick={() => void save(retry)}
                type="button"
              >
                重试同一保存
              </button>
            )}
          </div>

          <p className={styles.secondary}>
            版本 {settings.version} · 由 {settings.updatedBy ?? "初始设置"} 于{" "}
            <time dateTime={settings.updatedAt}>
              {formatPreciseTime(settings.updatedAt)}
            </time>{" "}
            保存；{TIME_ZONE_NOTE}。
          </p>
        </form>
      )}

      {receipt === null ? null : (
        <p className={styles.receipt} data-tone={receipt.tone} role="status">
          {receipt.text}
        </p>
      )}

      <ConfirmationModal
        body={
          <div>
            <p>
              将保存以下更改（版本 {confirmation?.expectedVersion ?? ""}）：
            </p>
            <ul>
              {pendingChanges.map((change) => (
                <li key={change}>{change}</li>
              ))}
            </ul>
            {policyChanging ? (
              <p>
                切换作品发布模式只影响此后的新提交；不会批量公开、下架或重新审核已有作品。
              </p>
            ) : null}
            <p>
              限制保存后立即对之后的操作生效；保存本身不会删除已有作品、草稿或媒体。调低历史版本保留数量后，之后保存时按新数量保留（固定的冲突副本除外）。操作者与时间随设置一同记录。
            </p>
          </div>
        }
        cancelLabel="取消"
        confirmLabel="确认保存"
        confirmingLabel="保存中…"
        heading="确认保存作品发布设置"
        modalSlug={CONFIRM_SLUG}
        onCancel={() => setConfirmation(null)}
        onConfirm={async () => {
          closeModal(CONFIRM_SLUG);
          if (confirmation !== null) await save(confirmation);
          setConfirmation(null);
        }}
      />
    </section>
  );
};
