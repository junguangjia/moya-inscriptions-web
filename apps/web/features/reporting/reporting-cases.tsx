"use client";

import { useEffect, useRef, useState } from "react";
import type {
  CommunityReport,
  CommunityReportEvidence,
  CommunityReportingDecision,
  CommunityReportingInbox,
} from "@moya/contracts";
import { useAuthors } from "../authors/author-context";
import { requestIdentity } from "../shell/request-identity";
import {
  reportingClient,
  appealReportingClient,
  downloadReportEvidence,
} from "./reporting-data";
import {
  ReportDialog,
  reportReasonLabels,
  uploadReportEvidence,
} from "./report-actions";
import styles from "./reporting.module.css";

const statusLabels = {
  open: "待处理",
  reviewing: "审核中",
  resolved: "已结案",
  appealed: "申诉处理中",
} as const;
const targetLabels = {
  work: "帖子",
  comment: "评论",
  user: "用户账号",
  article: "文章",
  thread: "话题",
  catalog: "官方作品",
} as const;
const actionLabels = {
  retain: "保留内容",
  hide: "隐藏内容",
  warn: "警告",
  restrict_comments: "限制评论",
  suspend: "停用账号",
  approve: "审核通过",
  reject: "审核拒绝",
  restore: "恢复内容",
  delete_body: "删除正文",
  remove_thread: "移除讨论串",
} as const;
const appealLabels = {
  pending: "等待复核",
  upheld: "维持原决定",
  overturned: "已纠正原决定",
} as const;
const failureText = (error: unknown) =>
  error instanceof Error ? error.message : "操作未完成，请重试";
const Time = ({ value }: { value: string }) => (
  <time dateTime={value}>{new Date(value).toLocaleString("zh-CN")}</time>
);

const CaseTextForm = ({
  label,
  onSubmit,
}: {
  label: string;
  onSubmit: (text: string, requestId: string) => Promise<unknown>;
}) => {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const pending = useRef<{ text: string; requestId: string } | null>(null);
  const inFlight = useRef(false);
  const submit = async () => {
    if (inFlight.current || !text.trim()) return;
    inFlight.current = true;
    setBusy(true);
    setNotice("");
    const value = text.trim();
    if (pending.current?.text !== value)
      pending.current = { text: value, requestId: requestIdentity() };
    try {
      await onSubmit(value, pending.current.requestId);
      setText("");
      pending.current = null;
      setNotice("已收到材料");
    } catch (error) {
      setNotice(failureText(error));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label>
        {label}
        <textarea
          rows={3}
          maxLength={10000}
          required
          disabled={busy}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      <button disabled={busy || !text.trim()} type="submit">
        {busy ? "正在提交…" : label}
      </button>
      {notice && <p role="status">{notice}</p>}
    </form>
  );
};
const CaseEvidence = ({
  account,
  caseId,
  evidence,
  restricted = false,
  allowUpload = true,
  onChanged,
}: {
  account: string;
  caseId: string;
  evidence: readonly CommunityReportEvidence[];
  restricted?: boolean;
  allowUpload?: boolean;
  onChanged: () => void;
}) => {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const uploadId = useRef(requestIdentity());
  const input = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);
  const upload = async () => {
    if (file === null || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setNotice("");
    try {
      await uploadReportEvidence(
        account,
        caseId,
        file,
        uploadId.current,
        restricted,
      );
      setFile(null);
      if (input.current) input.current.value = "";
      setNotice("附件已收到");
      onChanged();
    } catch (error) {
      setNotice(failureText(error));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <>
      <ul>
        {evidence.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              onClick={() =>
                void downloadReportEvidence(
                  account,
                  caseId,
                  item.id,
                  restricted,
                )
                  .then((blob) => {
                    const url = URL.createObjectURL(blob);
                    const link = document.createElement("a");
                    link.href = url;
                    link.download = item.fileName;
                    link.click();
                    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
                  })
                  .catch((error) => setNotice(failureText(error)))
              }
            >
              {item.fileName}
            </button>
          </li>
        ))}
      </ul>
      {allowUpload && (
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            void upload();
          }}
        >
          <label>
            补充私有证据附件
            <input
              ref={input}
              type="file"
              accept="image/jpeg,image/png,image/webp,application/pdf"
              disabled={busy}
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
                uploadId.current = requestIdentity();
              }}
            />
            <span className={styles.note}>
              最多 8 MB，仅本人及审核人员可访问。
            </span>
          </label>
          <button type="submit" disabled={busy || file === null}>
            {busy ? "正在上传…" : "上传附件"}
          </button>
        </form>
      )}
      {notice && <p role="status">{notice}</p>}
    </>
  );
};

/** A child view inside the existing settings/message host; owns no dialog history. */
const AccountReportingCases = ({
  account,
  restricted = false,
  initialTab = "reports",
}: {
  account: string;
  restricted?: boolean;
  initialTab?: "reports" | "decisions" | "notices";
}) => {
  const [tab, setTab] = useState<"reports" | "decisions" | "notices">(
    restricted ? "decisions" : initialTab,
  );
  const [reports, setReports] = useState<CommunityReport[]>([]);
  const [decisions, setDecisions] = useState<CommunityReportingDecision[]>([]);
  const [notices, setNotices] = useState<CommunityReportingInbox["items"]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [rightsCaseId, setRightsCaseId] = useState<string | null>(null);
  const decisionClient = restricted ? appealReportingClient : reportingClient;
  const reload = () => setRevision((value) => value + 1);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setBusy(true);
    setError("");
    const load = async () => {
      if (tab === "reports") {
        const value = await reportingClient.list(
          account,
          page,
          controller.signal,
        );
        if (active) {
          setReports((old) =>
            page === 1
              ? value.items
              : [
                  ...old.filter(
                    (item) => !value.items.some((next) => next.id === item.id),
                  ),
                  ...value.items,
                ],
          );
          setTotal(value.total);
        }
      } else if (tab === "decisions") {
        const value = await decisionClient.decisions(
          account,
          page,
          controller.signal,
        );
        if (active) {
          setDecisions((old) =>
            page === 1
              ? value.items
              : [
                  ...old.filter(
                    (item) =>
                      !value.items.some(
                        (next) => next.decision.id === item.decision.id,
                      ),
                  ),
                  ...value.items,
                ],
          );
          setTotal(value.total);
        }
      } else {
        const value = await reportingClient.inbox(account, controller.signal);
        if (active) {
          setNotices(value.items);
          setTotal(value.items.length);
        }
      }
    };
    void load()
      .catch((failure) => {
        if (active) setError(failureText(failure));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [account, tab, page, revision, decisionClient]);
  const select = (next: typeof tab) => {
    setTab(next);
    setPage(1);
    setExpanded(null);
    setError("");
  };
  return (
    <section
      className={styles.cases}
      aria-label="我的举报与申诉"
      aria-busy={busy}
    >
      {restricted ? (
        <p className={styles.note}>
          此入口仅允许查看本人处置记录和提交申诉，不恢复社区功能。
        </p>
      ) : (
        <div className={styles.tabs} role="tablist" aria-label="举报与申诉分类">
          {(["reports", "decisions", "notices"] as const).map((value) => (
            <button
              type="button"
              role="tab"
              key={value}
              aria-selected={tab === value}
              onClick={() => select(value)}
            >
              {value === "reports"
                ? "我的举报"
                : value === "decisions"
                  ? "处置与申诉"
                  : "系统通知"}
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setPage(1);
          reload();
        }}
      >
        刷新记录
      </button>
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">正在读取记录…</p>}
      {!busy && !error && total === 0 && (
        <p className={styles.note}>暂无记录。</p>
      )}
      {tab === "reports" &&
        reports.map((report) => (
          <article className={styles.case} key={report.id}>
            <h3>
              {targetLabels[report.target.type]}举报 ·{" "}
              {statusLabels[report.status]}
            </h3>
            <p className={styles.note}>案件编号：{report.id}</p>
            <Time value={report.createdAt} />
            <p>
              原因：
              {report.reason === null
                ? "未提供原因（评论快捷举报）"
                : reportReasonLabels[report.reason]}
            </p>
            {report.description && <p>{report.description}</p>}
            {report.decision && (
              <p>
                处理结果：{actionLabels[report.decision.action]}。
                {report.decision.reason}
                {report.decision.reversedAt &&
                  ` 已纠正：${report.decision.reviewReason ?? "原决定已撤销"}`}
              </p>
            )}
            <button
              type="button"
              aria-expanded={expanded === report.id}
              onClick={() =>
                setExpanded(expanded === report.id ? null : report.id)
              }
            >
              {expanded === report.id ? "收起案件" : "查看与补充材料"}
            </button>
            {expanded === report.id && (
              <>
                {report.messages.map((message) => (
                  <div key={message.id}>
                    <p>{message.text}</p>
                    <Time value={message.createdAt} />
                  </div>
                ))}
                <CaseTextForm
                  label="补充材料"
                  onSubmit={async (text, requestId) => {
                    await reportingClient.material(account, report.id, {
                      text,
                      requestId,
                    });
                    reload();
                  }}
                />
                <CaseEvidence
                  account={account}
                  caseId={report.id}
                  evidence={report.evidence}
                  onChanged={reload}
                />
                {report.kind !== "rights_notice" && (
                  <button
                    type="button"
                    onClick={() => setRightsCaseId(report.id)}
                  >
                    提交权利人投诉
                  </button>
                )}
                {rightsCaseId === report.id && (
                  <ReportDialog
                    target={report.target}
                    sourceCaseId={report.id}
                    rightsOnly
                    embedded
                    onClose={() => {
                      setRightsCaseId(null);
                      reload();
                    }}
                  />
                )}
              </>
            )}
          </article>
        ))}
      {tab === "decisions" &&
        decisions.map((item) => (
          <article className={styles.case} key={item.decision.id}>
            {item.kind === "moderation" && (
              <p className={styles.note}>管理审核决定</p>
            )}
            <h3>
              {actionLabels[item.decision.action]}
              {item.decision.reversedAt ? " · 已纠正" : ""}
            </h3>
            <p>{item.decision.reason}</p>
            <p className={styles.note}>
              {item.kind === "moderation" ? "审核记录编号" : "案件编号"}：
              {item.caseId} · {targetLabels[item.target.type]}
            </p>
            <Time value={item.decision.createdAt} />
            {item.kind === "moderation" &&
              item.decision.action === "reject" &&
              item.decision.reversedAt !== null && (
                <p role="status">
                  拒绝决定已撤销，内容已返回原审核队列，仍未发布。
                </p>
              )}
            {item.decision.action === "delete_body" &&
              item.decision.reversedAt !== null && (
                <p role="status">
                  删除正文的决定已纠正；已删除的文字无法恢复。
                </p>
              )}
            {item.decision.action === "remove_thread" &&
              item.decision.reversedAt !== null && (
                <p role="status">
                  移除讨论串的决定已纠正；其他仍有效的处置可能继续限制相关内容。
                </p>
              )}
            {item.decision.reviewReason && (
              <p>复核结果：{item.decision.reviewReason}</p>
            )}
            {item.appeal && (
              <p>
                申诉：{appealLabels[item.appeal.status]}。{item.appeal.text}
              </p>
            )}
            {item.messages.map((message) => (
              <div key={message.id}>
                <p>{message.text}</p>
                <Time value={message.createdAt} />
              </div>
            ))}
            {!item.decision.reversedAt && !item.appeal && (
              <CaseTextForm
                label="提交申诉"
                onSubmit={async (text, requestId) => {
                  await decisionClient.appeal(account, item.decision.id, {
                    text,
                    requestId,
                  });
                  reload();
                }}
              />
            )}
            {item.kind !== "moderation" && (
              <CaseEvidence
                account={account}
                caseId={item.caseId}
                evidence={item.evidence}
                restricted={restricted}
                allowUpload={
                  !item.decision.reversedAt &&
                  (item.kind === "rights_notice" ||
                    item.appeal?.status === "pending")
                }
                onChanged={reload}
              />
            )}
            {item.kind === "rights_notice" && !item.decision.reversedAt && (
              <CaseTextForm
                label="提交不侵权声明"
                onSubmit={async (text, requestId) => {
                  await decisionClient.statement(account, item.caseId, {
                    text,
                    requestId,
                  });
                  reload();
                }}
              />
            )}
          </article>
        ))}
      {tab === "notices" &&
        notices.map((item) => (
          <article className={styles.case} key={item.id}>
            <p>{item.text}</p>
            <p className={styles.note}>案件编号：{item.caseId}</p>
            <Time value={item.createdAt} />
            {item.readAt === null && (
              <button
                type="button"
                onClick={() =>
                  void reportingClient
                    .read(account, item.id)
                    .then(reload)
                    .catch((failure) => setError(failureText(failure)))
                }
              >
                标为已读
              </button>
            )}
          </article>
        ))}
      {tab !== "notices" &&
        !busy &&
        !error &&
        (tab === "reports" ? reports.length : decisions.length) < total && (
          <button type="button" onClick={() => setPage((value) => value + 1)}>
            加载更多
          </button>
        )}
    </section>
  );
};
export const ReportingCases = (props: {
  account: string;
  restricted?: boolean;
  initialTab?: "reports" | "decisions" | "notices";
}) => <AccountReportingCases key={props.account} {...props} />;
export const MyReportingCases = ({
  initialTab,
}: {
  initialTab?: "reports" | "decisions" | "notices";
}) => {
  const author = useAuthors();
  return author.viewer && !author.sessionError ? (
    <ReportingCases
      key={author.viewer.id}
      account={author.viewer.id}
      {...(initialTab ? { initialTab } : {})}
    />
  ) : (
    <p role="status">请登录后查看本人举报与申诉。</p>
  );
};
