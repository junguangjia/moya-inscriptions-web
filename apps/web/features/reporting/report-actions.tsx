"use client";

import { useEffect, useId, useRef, useState } from "react";
import type {
  CommunityReportReason,
  CommunityReportTarget,
  CreateCommunityReportRequest,
} from "@moya/contracts";
import { useAuthEntry } from "../auth/auth-return";
import { useAuthors } from "../authors/author-context";
import { AuthorDialog } from "../authors/author-dialog";
import { requestIdentity } from "../shell/request-identity";
import {
  reportingClient,
  appealReportingClient,
  ReportingRequestError,
} from "./reporting-data";
import styles from "./reporting.module.css";

export const reportReasonLabels: Record<CommunityReportReason, string> = {
  illegal_harmful: "违法有害",
  spam_scam: "垃圾诈骗",
  harassment: "骚扰",
  privacy: "隐私侵犯",
  impersonation: "冒充",
  copyright: "著作权",
  other: "其他",
};
type FormTarget = Extract<
  CreateCommunityReportRequest,
  { kind: "standard" }
>["target"];
const Flag = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M5 21V3m0 1c5-4 9 4 15 0v11c-6 4-10-4-15 0" />
  </svg>
);

/** A comment report is intentionally only a quiet symbol and one command. */
export const QuickCommentReport = ({ id }: { id: string }) => {
  const author = useAuthors();
  const enterAuth = useAuthEntry();
  const [state, setState] = useState<"idle" | "pending" | "sent">("idle");
  const inFlight = useRef(false);
  const requestId = useRef(requestIdentity());
  const owner = author.viewer?.id ?? null;
  const scope = `${owner ?? "guest"}:${id}`;
  const current = useRef(scope);
  current.current = scope;
  useEffect(() => {
    setState("idle");
    inFlight.current = false;
    requestId.current = requestIdentity();
  }, [scope]);
  const run = async (opener: HTMLElement) => {
    if (author.checking || inFlight.current || state === "sent") return;
    if (author.sessionError) {
      author.notify("账户状态尚未确认，请稍后重试");
      return;
    }
    if (owner === null) {
      enterAuth(author.signInHref, opener);
      return;
    }
    const active = scope;
    inFlight.current = true;
    setState("pending");
    try {
      await reportingClient.create(owner, {
        kind: "quick_comment",
        target: { type: "comment", id },
        requestId: requestId.current,
      });
      if (current.current === active) {
        setState("sent");
        author.notify("已收到举报");
      }
    } catch (error) {
      if (current.current === active) {
        setState("idle");
        author.notify(
          error instanceof Error ? error.message : "举报未完成，请重试",
        );
      }
    } finally {
      if (current.current === active) inFlight.current = false;
    }
  };
  return (
    <button
      type="button"
      className={styles.flag}
      aria-label={state === "sent" ? "已举报评论" : "举报评论"}
      aria-pressed={state === "sent"}
      aria-busy={state === "pending" || undefined}
      disabled={author.checking || state !== "idle"}
      onClick={(event) => void run(event.currentTarget)}
      data-comment-report=""
    >
      <Flag />
    </button>
  );
};

export const evidenceFileBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result);
      const comma = value.indexOf(",");
      if (comma < 0) reject(new Error("附件读取失败"));
      else resolve(value.slice(comma + 1));
    };
    reader.onerror = () => reject(new Error("附件读取失败"));
    reader.readAsDataURL(file);
  });
const acceptedEvidenceTypes = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
] as const;
export const uploadReportEvidence = async (
  account: string,
  reportId: string,
  file: File,
  requestId: string,
  restricted = false,
) => {
  const mimeType = acceptedEvidenceTypes.find((value) => value === file.type);
  if (mimeType === undefined || file.size > 8 * 1024 * 1024 || file.size === 0)
    throw new Error("请选择 8 MB 以内的 JPG、PNG、WebP 或 PDF 附件");
  return (restricted ? appealReportingClient : reportingClient).evidence(
    account,
    reportId,
    {
      fileName: file.name,
      mimeType,
      contentBase64: await evidenceFileBase64(file),
      sensitive: true,
      requestId,
    },
  );
};

export const ReportDialog = ({
  target,
  onClose,
  rightsOnly = false,
  embedded = false,
  sourceCaseId,
}: {
  target: CommunityReportTarget;
  sourceCaseId?: string;
  rightsOnly?: boolean;
  /** The owning settings/message view retains its sole dialog history entry. */
  embedded?: boolean;
  onClose: () => void;
}) => {
  const author = useAuthors();
  const account = author.viewer?.id ?? null;
  // Comment legal notices are a private follow-up. The primary flag never
  // reaches this form, and a comment can never become a standard report here.
  const requiresRights = rightsOnly || target.type === "comment";
  const [reason, setReason] = useState<CommunityReportReason | "">(
    requiresRights ? "copyright" : "",
  );
  const [description, setDescription] = useState("");
  const [rightsSelected, setRights] = useState(false);
  const rights = requiresRights || rightsSelected;
  const [claimantName, setClaimantName] = useState("");
  const [contact, setContact] = useState("");
  const [rightsBasis, setRightsBasis] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const created = useRef<string | null>(null);
  const uploadId = useRef(requestIdentity());
  const command = useRef<{ identity: string; requestId: string } | null>(null);
  const inFlight = useRef(false);
  const owner = useRef(account);
  owner.current = account;
  const canSubmit =
    account !== null &&
    !author.checking &&
    !author.sessionError &&
    !busy &&
    (created.current !== null ||
      (reason !== "" &&
        (!rights ||
          (description.trim() !== "" &&
            claimantName.trim() !== "" &&
            contact.trim() !== "" &&
            rightsBasis.trim() !== ""))));
  const submit = async () => {
    if (!canSubmit || inFlight.current || account === null) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      if (created.current === null) {
        if (reason === "") return;
        const fields = rights
          ? {
              kind: "rights_notice" as const,
              target,
              reason: "copyright" as const,
              description: description.trim(),
              claimantName: claimantName.trim(),
              contact: contact.trim(),
              rightsBasis: rightsBasis.trim(),
              ...(sourceCaseId === undefined ? {} : { sourceCaseId }),
            }
          : target.type === "comment"
            ? null
            : {
                kind: "standard" as const,
                target: { type: target.type, id: target.id },
                reason,
                ...(description.trim()
                  ? { description: description.trim() }
                  : {}),
              };
        if (fields === null) return;
        const identity = JSON.stringify(fields);
        if (command.current?.identity !== identity)
          command.current = { identity, requestId: requestIdentity() };
        const report = await reportingClient.create(account, {
          ...fields,
          requestId: command.current.requestId,
        });
        if (owner.current !== account) return;
        created.current = report.id;
      }
      if (file !== null)
        await uploadReportEvidence(
          account,
          created.current,
          file,
          uploadId.current,
        );
      if (owner.current !== account) return;
      author.notify(`已收到举报，案件编号：${created.current}`);
      setSaved(true);
      if (embedded) onClose();
    } catch (failure) {
      if (owner.current !== account) return;
      const detail =
        failure instanceof ReportingRequestError || failure instanceof Error
          ? failure.message
          : "请稍后重试";
      setError(
        created.current === null
          ? detail
          : `举报已收到，附件尚未上传：${detail}。可重试或关闭后在“我的举报与申诉”补充。`,
      );
    } finally {
      inFlight.current = false;
      if (owner.current === account) setBusy(false);
    }
  };
  const dirty =
    !saved &&
    created.current === null &&
    (description !== "" ||
      (!requiresRights && reason !== "") ||
      claimantName !== "" ||
      contact !== "" ||
      rightsBasis !== "" ||
      file !== null);
  const form = (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <p className={styles.note}>
        举报内容仅供审核人员处理，其他用户看不到举报人身份和原始证据。
      </p>
      <label>
        举报原因
        <select
          required
          value={reason}
          disabled={requiresRights || busy || created.current !== null}
          onChange={(event) => {
            setReason(event.target.value as CommunityReportReason | "");
            setRights(false);
          }}
        >
          <option value="">请选择原因</option>
          {Object.entries(reportReasonLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {reason === "copyright" && !requiresRights && (
        <label>
          <span>
            <input
              type="checkbox"
              checked={rights}
              disabled={busy || created.current !== null}
              onChange={(event) => setRights(event.target.checked)}
            />{" "}
            我是权利人或其授权代表，提交正式权利投诉
          </span>
        </label>
      )}
      {rights && (
        <>
          <label>
            权利人姓名或名称
            <input
              required
              maxLength={200}
              value={claimantName}
              disabled={busy || created.current !== null}
              onChange={(event) => setClaimantName(event.target.value)}
            />
          </label>
          <label>
            联系信息
            <input
              required
              maxLength={500}
              value={contact}
              disabled={busy || created.current !== null}
              onChange={(event) => setContact(event.target.value)}
            />
          </label>
          <label>
            权属依据
            <textarea
              required
              maxLength={10000}
              rows={3}
              value={rightsBasis}
              disabled={busy || created.current !== null}
              onChange={(event) => setRightsBasis(event.target.value)}
            />
          </label>
          <p className={styles.note}>
            审核人员将审查材料，并向相关用户转送处理争议所必需的信息。请勿填写无关身份信息。
          </p>
        </>
      )}
      <label>
        {rights ? "受影响内容与投诉说明" : "补充说明（可选）"}
        <textarea
          required={rights}
          maxLength={10000}
          rows={4}
          value={description}
          disabled={busy || created.current !== null}
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>
      <label>
        私有证据附件（可选）
        <input
          type="file"
          accept={acceptedEvidenceTypes.join(",")}
          disabled={busy}
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null);
            uploadId.current = requestIdentity();
          }}
        />
        <span className={styles.note}>
          JPG、PNG、WebP 或 PDF，最多 8 MB。附件不公开。
        </span>
      </label>
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={!canSubmit}>
        {busy
          ? "正在提交…"
          : created.current
            ? "重试上传附件"
            : rights
              ? "提交权利人投诉"
              : "提交举报"}
      </button>
    </form>
  );
  if (embedded)
    return (
      <section
        className={styles.case}
        aria-label="权利人投诉"
        data-report-embedded=""
      >
        <h3>权利人投诉</h3>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            if (!dirty || window.confirm("更改尚未保存，放弃这些更改？"))
              onClose();
          }}
        >
          关闭投诉表单
        </button>
        {form}
      </section>
    );
  return (
    <AuthorDialog
      title={rights ? "权利人投诉" : "举报"}
      onClose={onClose}
      closeRequested={saved || account === null}
      dirty={dirty}
      dismissible={!busy}
    >
      {form}
    </AuthorDialog>
  );
};

/** Reuses the content action/menu location without adding a new navigation owner. */
export const ReportMenu = ({
  target,
  label = "更多操作",
}: {
  target: FormTarget;
  label?: string;
}) => {
  const author = useAuthors();
  const enterAuth = useAuthEntry();
  const [open, setOpen] = useState(false);
  const [reporting, setReporting] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    host.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        opener.current?.focus();
      }
    };
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !host.current?.contains(event.target))
        setOpen(false);
    };
    document.addEventListener("keydown", key);
    document.addEventListener("pointerdown", outside);
    return () => {
      document.removeEventListener("keydown", key);
      document.removeEventListener("pointerdown", outside);
    };
  }, [open]);
  return (
    <>
      <div
        className={styles.menuHost}
        ref={host}
        onBlur={(event) => {
          if (
            event.relatedTarget instanceof Node &&
            !host.current?.contains(event.relatedTarget)
          )
            setOpen(false);
        }}
      >
        <button
          ref={opener}
          type="button"
          className={styles.more}
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          onClick={() => setOpen((value) => !value)}
        >
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="5" cy="12" r="1.5" />
            <circle cx="12" cy="12" r="1.5" />
            <circle cx="19" cy="12" r="1.5" />
          </svg>
        </button>
        {open && (
          <div role="menu" id={id} className={styles.menu}>
            <button
              type="button"
              role="menuitem"
              disabled={author.checking}
              onClick={() => {
                setOpen(false);
                opener.current?.focus();
                if (author.sessionError)
                  author.notify("账户状态尚未确认，请稍后重试");
                else if (!author.viewer)
                  enterAuth(author.signInHref, opener.current);
                else setReporting(true);
              }}
            >
              举报
            </button>
          </div>
        )}
      </div>
      {reporting && (
        <ReportDialog
          key={author.viewer?.id ?? "guest"}
          target={target}
          onClose={() => {
            setReporting(false);
            opener.current?.focus();
          }}
        />
      )}
    </>
  );
};
export type { CommunityReportTarget };
