"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  feedbackClient,
  feedbackImageLimits,
} from "../../lib/public-api/feedback-client";
import { requestIdentity } from "../shell/request-identity";
import { useBoundedPreview } from "../publishing/ui/media/media-preview";
import { THUMBNAIL_EDGE } from "../publishing/ui/media/bounded-preview";
import {
  createFeedbackUploadSession,
  FeedbackImageError,
} from "./feedback-upload-session";
import type {
  FeedbackUploadSession,
  FeedbackImageUpload,
} from "./feedback-upload-session";
import type { UploadManagerSnapshot } from "../publishing/upload-manager";
import styles from "./settings-view.module.css";

const emptySnapshot: UploadManagerSnapshot = {
  accountId: "",
  status: "active",
  pauseReason: null,
  items: [],
};
const readEmpty = () => emptySnapshot;
const subscribeEmpty = () => () => undefined;
const retained = (items: readonly FeedbackImageUpload[]) =>
  items.filter((item) => item.phase !== "cancelled");

/** The settings tree owns text, selected files and the temporary upload lease. */
export const useSettingsFeedback = (owner: string | null) => {
  const [draft, setDraft] = useState({
    owner,
    message: "",
    error: "",
    sent: false,
    pending: false,
  });
  const [upload, setUpload] = useState<FeedbackUploadSession | null>(null);
  const uploadRef = useRef<FeedbackUploadSession | null>(null);
  const [selecting, setSelecting] = useState(false);
  const selectionPending = useRef(false);
  const selectionRun = useRef(0);
  const [imageError, setImageError] = useState("");
  const [reconnecting, setReconnecting] = useState(false);
  const connectionPending = useRef(false);
  const snapshot = useSyncExternalStore(
    upload?.subscribe ?? subscribeEmpty,
    upload?.snapshot ?? readEmpty,
    readEmpty,
  );
  const identity = useRef(owner);
  identity.current = owner;
  const mounted = useRef(true);
  const pending = useRef(false);
  const run = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const attempt = useRef<{
    owner: string;
    intent: string;
    submissionId: string;
  } | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      run.current++;
      selectionRun.current++;
      controller.current?.abort();
      const old = uploadRef.current;
      uploadRef.current = null;
      void old?.abandon();
    };
  }, []);
  useEffect(() => {
    run.current++;
    selectionRun.current++;
    controller.current?.abort();
    pending.current = false;
    selectionPending.current = false;
    attempt.current = null;
    const old = uploadRef.current;
    uploadRef.current = null;
    setUpload(null);
    void old?.abandon();
    setSelecting(false);
    connectionPending.current = false;
    setReconnecting(false);
    setImageError("");
    setDraft({ owner, message: "", error: "", sent: false, pending: false });
  }, [owner]);
  const current =
    draft.owner === owner
      ? draft
      : { owner, message: "", error: "", sent: false, pending: false };
  const images = upload?.owner === owner ? retained(snapshot.items) : [];
  const connectionPaused =
    upload?.owner === owner && snapshot.status === "paused";
  const imagesBusy = images.some(
    (item) => item.phase !== "ready" || item.itemId === null,
  );
  const setMessage = (message: string) => {
    if (!owner || pending.current) return;
    setDraft({ owner, message, error: "", sent: false, pending: false });
  };
  const addImages = async (files: readonly File[]) => {
    if (
      !owner ||
      files.length === 0 ||
      pending.current ||
      selectionPending.current ||
      connectionPending.current
    )
      return;
    const account = owner;
    const generation = ++selectionRun.current;
    const active = () =>
      mounted.current &&
      identity.current === account &&
      selectionRun.current === generation;
    selectionPending.current = true;
    setSelecting(true);
    setImageError("");
    setDraft((old) => ({ ...old, sent: false }));
    try {
      const session = uploadRef.current ?? createFeedbackUploadSession(account);
      if (uploadRef.current === null) {
        uploadRef.current = session;
        setUpload(session);
      }
      await session.add(files);
    } catch (error) {
      if (active())
        setImageError(
          error instanceof FeedbackImageError
            ? error.message
            : "图片暂时无法添加，请重试。",
        );
    } finally {
      if (active()) {
        selectionPending.current = false;
        setSelecting(false);
      }
    }
  };
  const imageAction = async (action: "remove" | "retry", key: string) => {
    const session = uploadRef.current;
    if (
      !owner ||
      session?.owner !== owner ||
      pending.current ||
      selectionPending.current
    )
      return;
    setImageError("");
    try {
      await session[action](key);
      if (
        action === "remove" &&
        mounted.current &&
        identity.current === owner &&
        uploadRef.current === session &&
        retained(session.snapshot().items).length === 0
      ) {
        // Explicitly removing the last image retires that holder. A later pick
        // may create a fresh one, without silently replacing existing images.
        uploadRef.current = null;
        setUpload(null);
        connectionPending.current = false;
        setReconnecting(false);
        void session.abandon();
      }
    } catch (error) {
      if (
        mounted.current &&
        identity.current === owner &&
        uploadRef.current === session
      )
        setImageError(
          error instanceof FeedbackImageError
            ? error.message
            : "图片操作未能确认，请重试。",
        );
    }
  };
  const retryConnection = async () => {
    const session = uploadRef.current;
    if (
      !owner ||
      session?.owner !== owner ||
      pending.current ||
      selectionPending.current ||
      connectionPending.current
    )
      return;
    connectionPending.current = true;
    setReconnecting(true);
    setImageError("");
    const active = () =>
      mounted.current &&
      identity.current === owner &&
      uploadRef.current === session;
    try {
      await session.resumeConnection();
    } catch (error) {
      if (active())
        setImageError(
          error instanceof FeedbackImageError
            ? error.message
            : "图片连接暂时无法恢复，请重试或重新选择图片。",
        );
    } finally {
      if (active()) {
        connectionPending.current = false;
        setReconnecting(false);
      }
    }
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
    const session = uploadRef.current;
    const attached =
      session?.owner === owner ? retained(session.snapshot().items) : [];
    const imageIds = attached.flatMap((item) =>
      item.phase === "ready" && item.itemId !== null ? [item.itemId] : [],
    );
    if (selectionPending.current || attached.length !== imageIds.length) {
      setImageError("请等待图片上传和处理完成，或移除未完成的图片。");
      return;
    }
    const intent = JSON.stringify([message, imageIds]);
    if (attempt.current?.owner !== owner || attempt.current.intent !== intent)
      attempt.current = { owner, intent, submissionId: requestIdentity() };
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
        {
          message,
          submissionId: body.submissionId,
          ...(imageIds.length === 0 ? {} : { imageIds }),
        },
        controller.current.signal,
      );
      if (active()) {
        attempt.current = null;
        uploadRef.current = null;
        setUpload(null);
        connectionPending.current = false;
        setReconnecting(false);
        setImageError("");
        setDraft({ owner, message: "", error: "", sent: true, pending: false });
        // The durable receipt pins images before any temporary holder is retired.
        void Promise.resolve()
          .then(() => session?.committed())
          .catch(() => undefined);
      }
    } catch {
      if (active())
        setDraft({
          ...draft,
          error:
            "反馈暂时未能确认提交，请重试。内容已保留。" +
            (imageIds.length > 0 ? "图片也已保留。" : ""),
          sent: false,
          pending: false,
        });
    } finally {
      if (active()) pending.current = false;
    }
  };
  return {
    ...current,
    images,
    imagesBusy,
    selecting,
    imageError,
    connectionPaused,
    reconnecting,
    retryConnection,
    dirty: current.message.length > 0 || images.length > 0 || selecting,
    isPending: () => pending.current,
    localStill: (key: string) =>
      upload?.owner === owner ? upload.localStill(key) : null,
    addImages,
    removeImage: (key: string) => imageAction("remove", key),
    retryImage: (key: string) => imageAction("retry", key),
    setMessage,
    submit,
  };
};

const imageStatus = (image: FeedbackImageUpload) => {
  switch (image.phase) {
    case "ready":
      return "已就绪";
    case "failed":
    case "paused":
      return "上传未完成，请重试";
    case "needs_choice":
      return "当前浏览器无法处理，请换图";
    case "missing_local":
      return "请重新选择这张图片";
    case "cleanup":
      return "正在移除…";
    case "uploaded":
    case "processing":
      return "正在处理…";
    case "queued":
    case "uploading":
    case "registering":
      return "正在上传…";
    default:
      return "正在准备…";
  }
};
const FeedbackImage = ({
  image,
  file,
  index,
  disabled,
  onRemove,
  onRetry,
}: {
  image: FeedbackImageUpload;
  file: Blob | null;
  index: number;
  disabled: boolean;
  onRemove: () => void;
  onRetry: () => void;
}) => {
  const local = useBoundedPreview(file, THUMBNAIL_EDGE);
  const src = image.serverItem?.media?.thumbSrc ?? local.url;
  return (
    <li
      className={styles.feedbackImage}
      data-feedback-image-state={image.phase}
    >
      {src ? (
        <img src={src} alt={`反馈图片 ${index + 1}`} decoding="async" />
      ) : (
        <span className={styles.feedbackImagePlaceholder}>
          图片 {index + 1}
        </span>
      )}
      <span className={styles.status} aria-live="polite">
        {imageStatus(image)}
      </span>
      <div className={styles.feedbackImageActions}>
        {(image.phase === "failed" || image.phase === "paused") && (
          <button
            type="button"
            className={styles.action}
            disabled={disabled}
            aria-label={`重试图片 ${index + 1}`}
            onClick={onRetry}
          >
            重试
          </button>
        )}
        <button
          type="button"
          className={styles.action}
          disabled={disabled || image.phase === "cleanup"}
          aria-label={`移除图片 ${index + 1}`}
          onClick={onRemove}
        >
          移除
        </button>
      </div>
    </li>
  );
};

export const SettingsFeedbackForm = ({
  feedback,
}: {
  feedback: ReturnType<typeof useSettingsFeedback>;
}) => {
  const picker = useRef<HTMLInputElement>(null);
  return (
    <form
      className={styles.feedbackForm}
      noValidate
      aria-busy={feedback.pending}
      onSubmit={(event) => {
        event.preventDefault();
        void feedback.submit();
      }}
    >
      <label
        className={styles.feedbackLabel}
        htmlFor="settings-feedback-message"
      >
        反馈内容
      </label>
      <p className={styles.help} id="settings-feedback-help">
        欢迎告诉我们遇到的问题或改进建议，请勿在文字或图片中包含密码、验证码等敏感信息。
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
      <fieldset className={styles.feedbackImages} disabled={feedback.pending}>
        <legend>图片（可选）</legend>
        <p className={styles.help} id="settings-feedback-images-help">
          最多 {feedbackImageLimits.maxImages} 张，每张不超过{" "}
          {feedbackImageLimits.maxBytes / 1024 / 1024} MB。支持
          JPEG、PNG、WebP、HEIC、HEIF 静态图片，仅本人和维护者可查看。
        </p>
        <input
          ref={picker}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif"
          multiple
          hidden
          aria-label="选择反馈图片"
          disabled={
            feedback.pending ||
            feedback.selecting ||
            feedback.reconnecting ||
            feedback.images.length >= feedbackImageLimits.maxImages
          }
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            void feedback.addImages(files);
          }}
        />
        <button
          type="button"
          className={styles.action}
          aria-describedby="settings-feedback-images-help"
          disabled={
            feedback.pending ||
            feedback.selecting ||
            feedback.reconnecting ||
            feedback.images.length >= feedbackImageLimits.maxImages
          }
          onClick={() => picker.current?.click()}
        >
          {feedback.selecting ? "正在读取图片…" : "添加图片"}
        </button>
        {feedback.connectionPaused && feedback.images.length > 0 && (
          <div>
            <p className={styles.help} role="status">
              图片连接已中断，可重试连接，或移除后重新添加图片。
            </p>
            <button
              type="button"
              className={styles.action}
              disabled={
                feedback.pending || feedback.selecting || feedback.reconnecting
              }
              onClick={() => void feedback.retryConnection()}
            >
              {feedback.reconnecting ? "正在恢复图片连接…" : "重试图片连接"}
            </button>
          </div>
        )}
        {feedback.images.length > 0 && (
          <ul className={styles.feedbackImageList}>
            {feedback.images.map((image, index) => (
              <FeedbackImage
                key={image.key}
                image={image}
                file={feedback.localStill(image.key)}
                index={index}
                disabled={feedback.pending || feedback.selecting}
                onRemove={() => void feedback.removeImage(image.key)}
                onRetry={() => void feedback.retryImage(image.key)}
              />
            ))}
          </ul>
        )}
        {feedback.imageError && (
          <p className={styles.error} role="alert">
            {feedback.imageError}
          </p>
        )}
      </fieldset>
      {feedback.error && (
        <p className={styles.error} id="settings-feedback-error" role="alert">
          {feedback.error}
        </p>
      )}
      <button
        className={`${styles.action} ${styles.primary}`}
        type="submit"
        disabled={feedback.pending || feedback.selecting || feedback.imagesBusy}
      >
        {feedback.pending ? "正在提交…" : "提交反馈"}
      </button>
      <p className={styles.status} role="status">
        {feedback.sent ? "反馈已提交，谢谢你的建议。" : ""}
      </p>
    </form>
  );
};
