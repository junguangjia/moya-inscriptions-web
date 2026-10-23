"use client";

import { useEffect, useRef, useState } from "react";
import { feedbackClient } from "../../lib/public-api/feedback-client";
import { requestIdentity } from "../shell/request-identity";
import styles from "./settings-view.module.css";

/** The settings tree owns the draft; returning to its root never discards it. */
export const useSettingsFeedback = (owner: string | null) => {
  const [draft, setDraft] = useState({
    owner,
    message: "",
    error: "",
    sent: false,
    pending: false,
  });
  const identity = useRef(owner);
  identity.current = owner;
  const mounted = useRef(true);
  const pending = useRef(false);
  const run = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const attempt = useRef<{
    owner: string;
    message: string;
    submissionId: string;
  } | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      run.current++;
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    run.current++;
    controller.current?.abort();
    pending.current = false;
    attempt.current = null;
    setDraft({ owner, message: "", error: "", sent: false, pending: false });
  }, [owner]);
  const current =
    draft.owner === owner
      ? draft
      : { owner, message: "", error: "", sent: false, pending: false };
  const setMessage = (message: string) => {
    if (!owner || pending.current) return;
    setDraft({ owner, message, error: "", sent: false, pending: false });
  };
  const submit = async () => {
    if (!owner || pending.current || draft.owner !== owner) return;
    const message = draft.message.trim();
    if (!message || message.length > 5000) {
      setDraft({
        ...draft,
        error: !message ? "请填写反馈内容。" : "反馈内容请控制在 5000 字以内。",
        sent: false,
      });
      return;
    }
    // Reuse this immutable key after a timeout: the server may already have saved it.
    if (attempt.current?.owner !== owner || attempt.current.message !== message)
      attempt.current = { owner, message, submissionId: requestIdentity() };
    const body = attempt.current;
    const generation = ++run.current;
    const active = () =>
      mounted.current &&
      identity.current === owner &&
      run.current === generation;
    controller.current = new AbortController();
    pending.current = true;
    setDraft({ ...draft, pending: true, error: "", sent: false });
    try {
      await feedbackClient.submit(
        { message, submissionId: body.submissionId },
        controller.current.signal,
      );
      if (active()) {
        attempt.current = null;
        setDraft({ owner, message: "", error: "", sent: true, pending: false });
      }
    } catch {
      if (active())
        setDraft({
          ...draft,
          error: "反馈暂时未能确认提交，请重试。内容已保留。",
          sent: false,
          pending: false,
        });
    } finally {
      if (active()) pending.current = false;
    }
  };
  return {
    ...current,
    dirty: current.message.length > 0,
    isPending: () => pending.current,
    setMessage,
    submit,
  };
};

export const SettingsFeedbackForm = ({
  feedback,
}: {
  feedback: ReturnType<typeof useSettingsFeedback>;
}) => (
  <form
    className={styles.feedbackForm}
    noValidate
    aria-busy={feedback.pending}
    onSubmit={(event) => {
      event.preventDefault();
      void feedback.submit();
    }}
  >
    <label className={styles.feedbackLabel} htmlFor="settings-feedback-message">
      反馈内容
    </label>
    <p className={styles.help} id="settings-feedback-help">
      欢迎告诉我们遇到的问题或改进建议，请勿填写密码、验证码等敏感信息。
    </p>
    <textarea
      id="settings-feedback-message"
      name="message"
      rows={8}
      value={feedback.message}
      disabled={feedback.pending}
      required
      aria-invalid={!!feedback.error}
      aria-describedby={`settings-feedback-help${feedback.error ? " settings-feedback-error" : ""}`}
      onChange={(event) => feedback.setMessage(event.target.value)}
    />
    <p className={styles.status}>{feedback.message.length} / 5000</p>
    {feedback.error && (
      <p className={styles.error} id="settings-feedback-error" role="alert">
        {feedback.error}
      </p>
    )}
    <button
      className={`${styles.action} ${styles.primary}`}
      type="submit"
      disabled={feedback.pending}
    >
      {feedback.pending ? "正在提交…" : "提交反馈"}
    </button>
    <p className={styles.status} role="status">
      {feedback.sent ? "反馈已提交，谢谢你的建议。" : ""}
    </p>
  </form>
);
