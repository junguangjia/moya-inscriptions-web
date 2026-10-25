"use client";

import { SetStepNav } from "@payloadcms/ui";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { call, describeFailure, formatTime, TIME_ZONE_NOTE } from "./api";
import styles from "./community.module.css";

import type {
  OperatorReport,
  OperatorReportDecisionRequest,
  OperatorReportForwardRequest,
  OperatorReportMetadataRequest,
  OperatorReportPage,
  OperatorReportReviewRequest,
} from "./api";

const statusLabels: Record<OperatorReport["status"], string> = {
  open: "待处理",
  reviewing: "审查中",
  resolved: "已结案",
  appealed: "待复核",
};
const targetLabels: Record<OperatorReport["target"]["type"], string> = {
  work: "帖子",
  comment: "评论/回复",
  user: "用户账号",
  article: "文章",
  thread: "话题",
  catalog: "官方作品",
};
const reasonLabels: Record<NonNullable<OperatorReport["reason"]>, string> = {
  illegal_harmful: "违法有害",
  spam_scam: "垃圾诈骗",
  harassment: "骚扰",
  privacy: "隐私侵犯",
  impersonation: "冒充",
  copyright: "著作权",
  other: "其他",
};
const decisionLabels: Record<OperatorReportDecisionRequest["action"], string> =
  {
    retain: "保留内容/账号",
    hide: "隐藏内容",
    warn: "警告用户",
    restrict_comments: "限制评论",
    suspend: "停用账号",
    approve: "审核通过",
    reject: "拒绝候选版本",
    restore: "恢复原状态",
    delete_body: "删除正文",
    remove_thread: "移除整帖讨论",
  };
const externalEditorialReport = (report: OperatorReport): boolean =>
  (report.target.type === "catalog" || report.target.type === "article") &&
  report.affectedUserId === null &&
  report.snapshot.source !== "community";
const reportDecisionLabel = (
  report: OperatorReport,
  action: OperatorReportDecisionRequest["action"],
): string =>
  externalEditorialReport(report) && action === "hide"
    ? "核验已撤下"
    : decisionLabels[action];
const externalEditorialNote =
  "请先通过现有内容管理撤下；此处仅核验并记录原条目当前不可访问，不替代内容管理操作。";
const historyLabels: Readonly<Record<string, string>> = {
  retain: "保留内容/账号",
  hide: "隐藏内容",
  warn: "警告用户",
  restrict_comments: "限制评论",
  suspend: "停用账号",
  approve: "审核通过",
  reject: "拒绝候选版本",
  restore: "恢复原状态",
  delete_body: "删除正文",
  remove_thread: "移除整帖讨论",
  uphold: "维持决定",
  overturn: "撤销决定并纠正",
  notice: "转送权利通知",
  statement: "转送不侵权声明",
  metadata: "更新案件标记",
};
const reasonLabel = (report: OperatorReport): string =>
  report.reason === null
    ? report.kind === "quick_comment"
      ? "未提供原因（评论快捷举报）"
      : "人工审核处置（无举报人）"
    : reasonLabels[report.reason];
const localPath = (value: string): string | undefined =>
  value.startsWith("/") &&
  !value.startsWith("//") &&
  ![...value].some(
    (character) => character === "\\" || character.charCodeAt(0) <= 32,
  )
    ? value
    : undefined;
const evidencePath = (reportId: string, evidenceId: string): string =>
  `/api/community-moderation/report-evidence/${encodeURIComponent(reportId)}/${encodeURIComponent(evidenceId)}`;
const textValue = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;
const recordValue = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** Target text is the Backend snapshot, never a direct community database read. */
const ReportContext = ({ report }: { readonly report: OperatorReport }) => {
  const snapshot = report.snapshot;
  const parent = recordValue(snapshot.parent);
  const post = recordValue(snapshot.post);
  const publicationObservation = recordValue(
    snapshot.nativePublicationObservation,
  );
  const title = textValue(snapshot.title) ?? textValue(snapshot.displayName);
  const text = textValue(snapshot.text) ?? textValue(snapshot.description);
  const path = localPath(report.canonicalPath);
  return (
    <section aria-label="被举报对象与上下文" className={styles.reportSection}>
      <h3>{targetLabels[report.target.type]}与上下文</h3>
      <p className={styles.mono}>{report.target.id}</p>
      {title === null ? null : <strong>{title}</strong>}
      {text === null ? null : <p className={styles.reportText}>{text}</p>}
      {textValue(snapshot.handle) === null ? null : (
        <p>账号：{String(snapshot.handle)}</p>
      )}
      {post === null ? null : (
        <p>所属内容：{textValue(post.title) ?? String(post.id ?? "")}</p>
      )}
      {parent === null ? null : (
        <blockquote className={styles.reportText}>
          父评论：{textValue(parent.text) ?? "内容暂不可用"}
        </blockquote>
      )}
      {publicationObservation !== null &&
      (publicationObservation.status === "unavailable" ||
        publicationObservation.status === "public") &&
      typeof publicationObservation.observedAt === "string" ? (
        <p>
          原内容核验：
          {publicationObservation.status === "unavailable"
            ? "核验时不可公开读取"
            : "核验时可公开访问"}{" "}
          · {formatTime(publicationObservation.observedAt)}
        </p>
      ) : null}
      {path === undefined ? null : (
        <a href={path} rel="noreferrer" target="_blank">
          打开内容页面
        </a>
      )}
      {report.target.type !== "comment" ? null : (
        <Link
          href={`/admin/community-moderation?status=all&item=${encodeURIComponent(report.target.id)}`}
        >
          在评论审核队列查看
        </Link>
      )}
      <details>
        <summary>查看 Backend 留存的对象快照</summary>
        <pre className={styles.reportSnapshot}>
          {JSON.stringify(snapshot, null, 2)}
        </pre>
      </details>
    </section>
  );
};

export const ReportDetail = ({
  report,
  busy,
  onMutation,
  onClose,
}: {
  readonly report: OperatorReport;
  readonly busy: boolean;
  readonly onMutation: (
    name: string,
    command:
      | OperatorReportDecisionRequest
      | OperatorReportReviewRequest
      | OperatorReportMetadataRequest
      | OperatorReportForwardRequest,
  ) => Promise<void>;
  readonly onClose: () => void;
}) => {
  const externalEditorial = externalEditorialReport(report);
  const platformResponse = externalEditorial && report.kind === "rights_notice";
  const hasStatement = report.materials.some(
    (material) => material.kind === "statement",
  );
  const [reason, setReason] = useState("");
  const [action, setAction] = useState<OperatorReportDecisionRequest["action"]>(
    report.allowedActions[0] ?? "retain",
  );
  const [review, setReview] =
    useState<OperatorReportReviewRequest["outcome"]>("uphold");
  const [prepared, setPrepared] = useState<
    "decision" | "review" | "forward" | null
  >(null);
  const [forwardText, setForwardText] = useState("");
  const [forwardKind, setForwardKind] = useState<
    OperatorReportForwardRequest["kind"]
  >(
    platformResponse
      ? "result"
      : report.affectedUserId !== null
        ? "notice"
        : hasStatement
          ? "statement"
          : "notice",
  );
  const forwardAllowed =
    forwardKind === "notice"
      ? report.affectedUserId !== null
      : forwardKind === "statement"
        ? hasStatement
        : platformResponse;
  const [redacted, setRedacted] = useState(false);
  const activeDecision =
    report.decision !== null && report.decision.reversedAt === null;
  const pendingAppeal = report.appeal?.status === "pending";
  const rejectedCandidate =
    report.kind === "moderation" && report.decision?.action === "reject";
  const irreversibleBodyDeletion = report.decision?.action === "delete_body";
  const removedDiscussion = report.decision?.action === "remove_thread";
  const canUphold =
    pendingAppeal ||
    (report.kind === "rights_notice" && report.status === "reviewing");
  const undecided =
    !activeDecision &&
    (report.status === "open" || report.status === "reviewing");
  const expectedVersion = report.version;
  const resetReason = (value: string) => {
    setReason(value);
    setPrepared(null);
  };
  const submit = async (
    name: string,
    command: Parameters<typeof onMutation>[1],
  ) => {
    setPrepared(null);
    await onMutation(name, command);
  };
  return (
    <aside
      aria-label="举报案件详情"
      className={`${styles.panel} ${styles.reportPanel}`}
      data-report-detail={report.id}
    >
      <div className={styles.panelHeader}>
        <h2>案件 {report.id}</h2>
        <button className={styles.rowLink} onClick={onClose} type="button">
          关闭详情
        </button>
      </div>
      <div className={styles.summaryLine}>
        <strong>{statusLabels[report.status]}</strong>
        {report.urgent ? (
          <span className={styles.chip} data-state="suspended">
            紧急
          </span>
        ) : null}
        {report.legalHold ? <span>保全中 · 暂停清理</span> : null}
      </div>
      {report.notificationFailures > 0 ? (
        <p className={styles.notice} data-tone="error" role="alert">
          {report.notificationFailures} 条通知发送失败，待 Backend
          重试；案件决定仍有效。
        </p>
      ) : null}
      <p>
        提交于 {formatTime(report.createdAt)}；{TIME_ZONE_NOTE}。
      </p>
      <p>
        <strong>举报原因：</strong>
        {reasonLabel(report)}
      </p>
      {report.description === "" ? null : (
        <p className={styles.reportText}>{report.description}</p>
      )}
      <div className={styles.actions}>
        <button
          className={styles.actionButton}
          disabled={busy}
          onClick={() =>
            void submit("set-report-metadata", {
              expectedVersion,
              urgent: !report.urgent,
            })
          }
          type="button"
        >
          {report.urgent ? "取消紧急标记" : "标记紧急"}
        </button>
        <button
          className={styles.actionButton}
          disabled={busy}
          onClick={() =>
            void submit("set-report-metadata", {
              expectedVersion,
              legalHold: !report.legalHold,
            })
          }
          type="button"
        >
          {report.legalHold ? "解除保全" : "保全并暂停清理"}
        </button>
        {report.status === "open" ? (
          <button
            className={styles.actionButton}
            disabled={busy}
            onClick={() =>
              void submit("set-report-metadata", {
                expectedVersion,
                status: "reviewing",
              })
            }
            type="button"
          >
            开始审查
          </button>
        ) : null}
      </div>
      <ReportContext report={report} />
      <section className={styles.reportSection} aria-label="私有材料">
        <h3>私有材料 · 仅限 Owner</h3>
        <p className={styles.secondary}>
          举报人：{report.reporterId ?? "无（人工审核处置）"}；相关用户：
          {report.affectedUserId ?? "无账号关联"}
          。身份与原始证据不会随通知自动转送。
        </p>
        {report.claimant === null ? null : (
          <dl className={styles.agentFacts}>
            <div>
              <dt>投诉人</dt>
              <dd>{report.claimant.name}</dd>
            </div>
            <div>
              <dt>联系方式</dt>
              <dd>{report.claimant.contact}</dd>
            </div>
            <div>
              <dt>权属依据</dt>
              <dd className={styles.reportText}>
                {report.claimant.rightsBasis}
              </dd>
            </div>
          </dl>
        )}
        {report.evidence.length === 0 ? (
          <p className={styles.secondary}>暂无附件。</p>
        ) : (
          <ul>
            {report.evidence.map((evidence) => (
              <li key={evidence.id}>
                <a download href={evidencePath(report.id, evidence.id)}>
                  {evidence.fileName}
                </a>{" "}
                · {Math.ceil(evidence.size / 1024)} KB
                {evidence.sensitive ? " · 敏感附件" : ""}
              </li>
            ))}
          </ul>
        )}
        {report.materials.map((material) => (
          <article className={styles.reportMaterial} key={material.id}>
            <strong>
              {material.kind === "statement" ? "不侵权声明" : "补充材料"}
            </strong>
            <p className={styles.secondary}>
              {material.authorId} · {formatTime(material.createdAt)}
            </p>
            <p className={styles.reportText}>{material.text}</p>
          </article>
        ))}
      </section>
      {report.decision === null ? null : (
        <section className={styles.reportSection} aria-label="当前处置">
          <h3>处置决定</h3>
          <p>
            {reportDecisionLabel(report, report.decision.action)} ·{" "}
            {formatTime(report.decision.createdAt)}
          </p>
          <p className={styles.reportText}>{report.decision.reason}</p>
          {report.decision.reversedAt === null ? null : (
            <p>
              已于 {formatTime(report.decision.reversedAt)} 撤销。
              {report.decision.reviewReason}
            </p>
          )}
        </section>
      )}
      {report.appeal === null ? null : (
        <section className={styles.reportSection} aria-label="申诉材料">
          <h3>申诉</h3>
          <p>
            {report.appeal.status === "pending"
              ? "待复核"
              : report.appeal.status === "overturned"
                ? "已撤销原决定"
                : "已维持原决定"}{" "}
            · {formatTime(report.appeal.createdAt)}
          </p>
          <p className={styles.reportText}>{report.appeal.text}</p>
        </section>
      )}
      {undecided || activeDecision ? (
        <section className={styles.reportSection} aria-label="人工决定">
          <h3>
            {undecided
              ? externalEditorial
                ? "核验与记录"
                : "人工处置"
              : "复核与纠正"}
          </h3>
          {externalEditorial ? (
            <p className={styles.secondary}>
              {externalEditorialNote}
              恢复需先在原内容管理中发布，再由此处核验记录。
            </p>
          ) : null}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (reason.trim() === "") return;
              setPrepared(undecided ? "decision" : "review");
            }}
          >
            {undecided ? (
              <label className={styles.reportField}>
                处置措施
                <select
                  disabled={busy}
                  onChange={(event) => {
                    setAction(event.currentTarget.value as typeof action);
                    setPrepared(null);
                  }}
                  value={action}
                >
                  {report.allowedActions.map((value) => (
                    <option key={value} value={value}>
                      {reportDecisionLabel(report, value)}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <label className={styles.reportField}>
                复核结果
                <select
                  disabled={busy}
                  onChange={(event) => {
                    setReview(event.currentTarget.value as typeof review);
                    setPrepared(null);
                  }}
                  value={canUphold ? review : "overturn"}
                >
                  {canUphold ? (
                    <option value="uphold">维持原决定</option>
                  ) : null}
                  <option value="overturn">
                    {externalEditorial
                      ? "核验已恢复并撤销记录"
                      : rejectedCandidate
                        ? "撤销拒绝并退回待审核"
                        : irreversibleBodyDeletion
                          ? "认定原决定有误（正文无法恢复）"
                          : "撤销原决定并纠正"}
                  </option>
                </select>
              </label>
            )}
            <label className={styles.reportField}>
              决定理由（必填）
              <textarea
                disabled={busy}
                maxLength={2000}
                onChange={(event) => resetReason(event.currentTarget.value)}
                required
                rows={4}
                value={reason}
              />
            </label>
            <p className={styles.secondary}>
              {externalEditorial
                ? "请如实填写核验理由。此处不会自动撤下或恢复原内容。"
                : rejectedCandidate
                  ? "撤销拒绝后，原候选版本仅返回待审核，不会自动公开；需重新检查并审批。"
                  : irreversibleBodyDeletion
                    ? "复核可认定原决定有误并更正记录，已删除正文无法恢复；不会创建替代文本。"
                    : removedDiscussion
                      ? "撤销整帖移除只解除本次整帖限制；已删除正文不会恢复，其他有效案件及评论自身审核状态仍可限制访问。"
                      : "理由将通知相关用户。撤销仅解除本决定造成的限制，其他有效处分及作者删除继续生效。"}
            </p>
            <button
              className={styles.actionButton}
              disabled={
                busy ||
                reason.trim() === "" ||
                (undecided && report.allowedActions.length === 0)
              }
              type="submit"
            >
              核对{undecided ? "处置" : "复核"}决定
            </button>
          </form>
          {prepared !== "decision" && prepared !== "review" ? null : (
            <div
              className={styles.reportConfirmation}
              role="group"
              aria-label="确认人工决定"
            >
              <strong>
                {prepared === "decision"
                  ? reportDecisionLabel(report, action)
                  : canUphold && review === "uphold"
                    ? "维持原决定"
                    : externalEditorial
                      ? "核验已恢复并撤销记录"
                      : rejectedCandidate
                        ? "撤销拒绝并退回待审核"
                        : irreversibleBodyDeletion
                          ? "认定原决定有误（正文无法恢复）"
                          : "撤销原决定并纠正"}
              </strong>
              <p className={styles.reportText}>{reason.trim()}</p>
              {externalEditorial ? (
                <p className={styles.secondary}>{externalEditorialNote}</p>
              ) : null}
              <button
                className={styles.actionButton}
                disabled={busy}
                onClick={() =>
                  void submit(
                    prepared === "decision" ? "decide-report" : "review-report",
                    prepared === "decision"
                      ? { expectedVersion, action, reason: reason.trim() }
                      : {
                          expectedVersion,
                          outcome: canUphold ? review : "overturn",
                          reason: reason.trim(),
                        },
                  )
                }
                type="button"
              >
                确认提交决定
              </button>
              <button
                className={styles.rowLink}
                disabled={busy}
                onClick={() => setPrepared(null)}
                type="button"
              >
                返回修改
              </button>
            </div>
          )}
        </section>
      ) : null}
      {report.kind !== "rights_notice" ? null : (
        <section className={styles.reportSection} aria-label="权利通知转送">
          <h3>必要披露与转送</h3>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (forwardText.trim() !== "" && redacted && forwardAllowed)
                setPrepared("forward");
            }}
          >
            <label className={styles.reportField}>
              转送类型
              <select
                disabled={busy}
                onChange={(event) => {
                  setForwardKind(
                    event.currentTarget.value as typeof forwardKind,
                  );
                  setRedacted(false);
                  setPrepared(null);
                }}
                value={forwardKind}
              >
                <option
                  disabled={report.affectedUserId === null}
                  value="notice"
                >
                  权利通知 → 相关用户
                </option>
                <option disabled={!hasStatement} value="statement">
                  不侵权声明 → 投诉人
                </option>
                {platformResponse ? (
                  <option value="result">平台处理说明 → 投诉人</option>
                ) : null}
              </select>
            </label>
            <label className={styles.reportField}>
              人工整理后的必要披露副本
              <textarea
                disabled={busy}
                maxLength={10000}
                onChange={(event) => {
                  setForwardText(event.currentTarget.value);
                  setRedacted(false);
                  setPrepared(null);
                }}
                placeholder="请人工输入转送正文。原始身份材料和附件不会自动带入。"
                required
                rows={5}
                value={forwardText}
              />
            </label>
            <label>
              <input
                checked={redacted}
                disabled={busy}
                onChange={(event) => {
                  setRedacted(event.currentTarget.checked);
                  setPrepared(null);
                }}
                required
                type="checkbox"
              />
              已核对接收方，移除无关身份、联系方式及敏感证据，仅保留必要披露内容。
            </label>
            <button
              className={styles.actionButton}
              disabled={
                busy ||
                !redacted ||
                forwardText.trim() === "" ||
                !forwardAllowed
              }
              type="submit"
            >
              预览转送副本
            </button>
          </form>
          {prepared !== "forward" ? null : (
            <div
              className={styles.reportConfirmation}
              role="group"
              aria-label="确认转送"
            >
              <strong>
                接收方：
                {forwardKind === "notice" ? "被投诉的相关用户" : "权利投诉人"}
              </strong>
              <p className={styles.reportText}>{forwardText.trim()}</p>
              <button
                className={styles.actionButton}
                disabled={busy || !forwardAllowed}
                onClick={() =>
                  void submit("forward-report", {
                    expectedVersion,
                    kind: forwardKind,
                    text: forwardText.trim(),
                  })
                }
                type="button"
              >
                确认转送此副本
              </button>
              <button
                className={styles.rowLink}
                onClick={() => setPrepared(null)}
                type="button"
              >
                返回修改
              </button>
            </div>
          )}
        </section>
      )}
      <section className={styles.reportSection} aria-label="已发出的通知">
        <h3>已保存的通知副本</h3>
        {report.messages.length === 0 ? (
          <p>暂无通知副本。</p>
        ) : (
          report.messages.map((message) => (
            <article className={styles.reportMaterial} key={message.id}>
              <strong>
                {message.kind === "notice"
                  ? "权利通知"
                  : message.kind === "statement"
                    ? "不侵权声明"
                    : "处理结果"}
              </strong>
              <p className={styles.secondary}>
                {formatTime(message.createdAt)}
              </p>
              <p className={styles.reportText}>{message.text}</p>
            </article>
          ))
        )}
      </section>
      <section className={styles.reportSection} aria-label="案件操作历史">
        <h3>案件操作历史</h3>
        {report.history.length === 0 ? (
          <p>暂无人工操作。</p>
        ) : (
          <ol className={styles.reportHistory}>
            {report.history.map((event) => (
              <li key={event.id}>
                <strong>{historyLabels[event.action] ?? event.action}</strong>
                <p className={styles.secondary}>
                  {event.operator} · {formatTime(event.occurredAt)}
                </p>
                <p className={styles.reportText}>{event.reason}</p>
              </li>
            ))}
          </ol>
        )}
        <Link href="/admin/community-moderation/history">查看社区操作历史</Link>
      </section>
    </aside>
  );
};

/** Cases and appeals share one Backend-owned lifecycle and one detail view. */
export const CommunityReportsClient = ({
  appealsOnly = false,
}: {
  readonly appealsOnly?: boolean;
}) => {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const query = useMemo(() => {
    const status = params.get("status");
    const page = Number(params.get("page") ?? "1");
    return {
      status: appealsOnly
        ? ("appealed" as const)
        : status !== null && Object.hasOwn(statusLabels, status)
          ? (status as OperatorReport["status"])
          : undefined,
      urgent: params.get("urgent") === "true",
      page: Number.isInteger(page) && page >= 1 && page <= 100000 ? page : 1,
      id: (params.get("case") ?? "").slice(0, 128),
    };
  }, [params, appealsOnly]);
  const [page, setPage] = useState<OperatorReportPage | null>(null);
  const [detail, setDetail] = useState<OperatorReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const sequence = useRef(0);
  const detailSequence = useRef(0);
  const navigate = (patch: Partial<typeof query>) => {
    const next = { ...query, ...patch };
    const values = new URLSearchParams();
    if (!appealsOnly && next.status !== undefined)
      values.set("status", next.status);
    if (next.urgent) values.set("urgent", "true");
    if (next.page !== 1) values.set("page", String(next.page));
    if (next.id !== "") values.set("case", next.id);
    router.replace(
      `${pathname}${values.size === 0 ? "" : `?${values.toString()}`}`,
      { scroll: false },
    );
  };
  const load = useCallback(async () => {
    const current = ++sequence.current;
    setLoading(true);
    try {
      const result = await call<OperatorReportPage>("read-reports", {
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.urgent ? { urgent: "true" } : {}),
        page: query.page,
        pageSize: 20,
      });
      if (current !== sequence.current) return;
      setPage(result);
      setError(null);
    } catch (failure) {
      if (current === sequence.current) setError(describeFailure(failure).text);
    } finally {
      if (current === sequence.current) setLoading(false);
    }
  }, [query.status, query.urgent, query.page]);
  const loadDetail = useCallback(async () => {
    const current = ++detailSequence.current;
    setDetail(null);
    setDetailError(null);
    setReceipt(null);
    if (query.id === "") {
      setDetailLoading(false);
      return;
    }
    setDetailLoading(true);
    try {
      const result = await call<OperatorReport>("read-report", {
        id: query.id,
      });
      if (current === detailSequence.current) setDetail(result);
    } catch (failure) {
      if (current === detailSequence.current)
        setDetailError(describeFailure(failure).text);
    } finally {
      if (current === detailSequence.current) setDetailLoading(false);
    }
  }, [query.id]);
  useEffect(() => {
    void load();
    return () => {
      sequence.current += 1;
    };
  }, [load]);
  useEffect(() => {
    void loadDetail();
    return () => {
      detailSequence.current += 1;
    };
  }, [loadDetail]);
  const mutate = async (
    name: string,
    command: Parameters<Parameters<typeof ReportDetail>[0]["onMutation"]>[1],
  ) => {
    if (detail === null || busy) return;
    const current = detailSequence.current;
    setBusy(true);
    setDetailError(null);
    setReceipt(null);
    try {
      const result = await call<OperatorReport>(name, {
        id: detail.id,
        ...command,
      });
      if (current !== detailSequence.current) return;
      setDetail(result);
      setReceipt("Backend 已保存操作及通知任务。通知送达状态以案件显示为准。");
      await load();
    } catch (failure) {
      if (current === detailSequence.current) {
        setDetail(null);
        setDetailError(
          `${describeFailure(failure).text}请先重新读取案件，核对最新结果。`,
        );
      }
    } finally {
      setBusy(false);
    }
  };
  const title = appealsOnly ? "申诉与操作历史" : "用户举报";
  return (
    <div
      className={styles.workspace}
      data-community-reports={appealsOnly ? "appeals" : "reports"}
    >
      <SetStepNav
        nav={[
          { label: "社区", url: "/admin/community-moderation" },
          { label: title },
        ]}
      />
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>{title}</h1>
          <p className={styles.lead}>
            {appealsOnly
              ? "待复核的申诉与完整案件历史；"
              : "帖子、评论/回复与用户账号等举报，紧急案件优先；"}
            {TIME_ZONE_NOTE}。
          </p>
        </div>
        <nav aria-label="社区处理入口" className={styles.summaryLine}>
          <Link href="/admin/community-moderation">待审核</Link>
          <Link href="/admin/community-moderation/reports">用户举报</Link>
          <Link href="/admin/community-moderation/appeals">申诉与操作历史</Link>
          <Link href="/admin/community-moderation/history">社区操作历史</Link>
        </nav>
      </header>
      <div className={styles.filters}>
        {appealsOnly ? null : (
          <label>
            案件状态
            <select
              disabled={busy}
              onChange={(event) =>
                navigate({
                  status:
                    event.currentTarget.value === "all"
                      ? undefined
                      : (event.currentTarget.value as OperatorReport["status"]),
                  page: 1,
                })
              }
              value={query.status ?? "all"}
            >
              <option value="all">全部状态</option>
              {Object.entries(statusLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          <span>优先级</span>
          <select
            disabled={busy}
            onChange={(event) =>
              navigate({
                urgent: event.currentTarget.value === "urgent",
                page: 1,
              })
            }
            value={query.urgent ? "urgent" : "all"}
          >
            <option value="all">全部优先级</option>
            <option value="urgent">仅紧急案件</option>
          </select>
        </label>
        <button
          className={styles.actionButton}
          disabled={loading || busy}
          onClick={() => void load()}
          type="button"
        >
          刷新列表
        </button>
      </div>
      {receipt === null ? null : (
        <p className={styles.receipt} data-tone="success" role="status">
          {receipt}
        </p>
      )}
      <div className={styles.layout} data-panel-open={query.id !== ""}>
        <section aria-label="举报案件列表" aria-busy={loading}>
          {error !== null ? (
            <p className={styles.state} role="alert">
              无法读取案件：{error}
            </p>
          ) : page === null ? (
            <p className={styles.state} role="status">
              正在读取…
            </p>
          ) : page.items.length === 0 ? (
            <p className={styles.state}>
              {appealsOnly
                ? "暂无待复核申诉。已处理记录可在全部举报及操作历史查看。"
                : "暂无符合条件的案件。"}
            </p>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">案件 / 时间</th>
                    <th scope="col">对象 / 原因</th>
                    <th scope="col">状态 / 提醒</th>
                  </tr>
                </thead>
                <tbody>
                  {page.items.map((report) => (
                    <tr
                      key={report.id}
                      data-current={query.id === report.id}
                      data-report-row={report.id}
                    >
                      <td>
                        <button
                          className={styles.rowLink}
                          disabled={busy}
                          onClick={() => navigate({ id: report.id })}
                          type="button"
                        >
                          {report.id}
                        </button>
                        <time
                          className={styles.secondary}
                          dateTime={report.createdAt}
                        >
                          {formatTime(report.createdAt)}
                        </time>
                      </td>
                      <td>
                        {targetLabels[report.target.type]}
                        <span className={styles.secondary}>
                          {reasonLabel(report)}
                        </span>
                      </td>
                      <td>
                        {statusLabels[report.status]}
                        {report.urgent ? (
                          <span className={styles.chip} data-state="suspended">
                            紧急
                          </span>
                        ) : null}
                        {report.legalHold ? (
                          <span className={styles.secondary}>保全中</span>
                        ) : null}
                        {report.notificationFailures === 0 ? null : (
                          <strong className={styles.secondary}>
                            通知失败 {report.notificationFailures}
                          </strong>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {page === null ? null : (
            <div className={styles.summaryLine}>
              <span>
                共 {page.total} 件 · 第 {page.page} 页
              </span>
              <button
                className={styles.rowLink}
                disabled={loading || busy || query.page <= 1}
                onClick={() => navigate({ page: query.page - 1 })}
                type="button"
              >
                上一页
              </button>
              <button
                className={styles.rowLink}
                disabled={
                  loading || busy || page.page * page.pageSize >= page.total
                }
                onClick={() => navigate({ page: query.page + 1 })}
                type="button"
              >
                下一页
              </button>
            </div>
          )}
        </section>
        {query.id === "" ? null : detailLoading ? (
          <p className={styles.state} role="status">
            正在读取案件详情…
          </p>
        ) : detailError !== null ? (
          <div>
            <p className={styles.notice} data-tone="error" role="alert">
              {detailError}
            </p>
            <button
              className={styles.actionButton}
              disabled={busy}
              onClick={() => void loadDetail()}
              type="button"
            >
              重新读取案件
            </button>
          </div>
        ) : detail === null ? null : (
          <ReportDetail
            busy={busy}
            key={`${detail.id}:${detail.version}`}
            onClose={() => navigate({ id: "" })}
            onMutation={mutate}
            report={detail}
          />
        )}
      </div>
    </div>
  );
};
