"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ConfirmationModal, SetStepNav, useModal } from "@payloadcms/ui";

import { TIME_ZONE_NOTE, call, describeFailure, formatTime } from "./api";
import styles from "./community.module.css";

import type {
  AgentDelegation,
  AgentDelegationPage,
  AgentOperation,
  AgentOperationDetail,
  AgentOperationPage,
  AgentOperationState,
  AgentOperationTargetPage,
  AgentPrincipal,
  AgentPrincipalPage,
  AgentScope,
} from "@moya/contracts/internal/community-operator";

/**
 * Agent Administration V1 (Issue #141 r4), the Owner's operations surface.
 * Operations stay primary; identity and delegation setup sit in secondary
 * sections. Every status line separates the operation's lifecycle from what
 * happened to its targets, so a finished operation that hit a conflict never
 * reads as if everything succeeded.
 */
const PAGE_SIZE = 20;
const TARGET_PAGE_SIZE = 20;
const MAX_TARGETS = 500;
const MAX_HOURS = 720;

/** Readable scope labels; the canonical code stays visible as technical detail. */
const scopeLabels: Record<AgentScope, string> = {
  "users:read": "查找用户",
  "content:read": "查看作品",
  "comments:read": "查看评论",
  "comments:moderate": "准备评论审核操作",
  "featured:write": "准备推荐操作",
  "operations:execute": "执行、查询与取消已批准操作",
  "operations:undo": "准备撤销操作",
};
const scopeList = Object.keys(scopeLabels) as AgentScope[];

const stateLabels: Record<AgentOperationState, string> = {
  prepared: "待批准",
  approved: "已批准",
  executing: "执行中",
  completed: "已完成",
  cancelled: "已取消",
  failed: "已失败",
};

const kindLabels = {
  "comments.moderate": "评论审核",
  "featured.set": "推荐设置",
} as const;

const actionLabels = {
  approve: "通过",
  reject: "拒绝",
  hide: "隐藏",
  unhide: "恢复显示",
} as const;

const matchLabels = { any: "任一词命中", all: "全部词命中" } as const;
const scopeOfCriteria = {
  comments: "仅主评论",
  replies: "仅回复",
  both: "主评论与回复",
} as const;

/** What the operation is, in one phrase. */
const describeOperation = (operation: AgentOperation): string => {
  const kind = kindLabels[operation.kind];
  if (operation.kind !== "comments.moderate")
    return `${kind}：${operation.targetCount} 项`;
  const action = operation.action ? actionLabels[operation.action] : "";
  const source = operation.criteria === null ? "指定清单" : "关键词清单";
  return `${kind}：${action} ${operation.targetCount} 项（${source}）`;
};

/** Non-zero outcome categories only; the detail view shows every category. */
const outcomeSummary = (operation: AgentOperation): string => {
  const { tally } = operation;
  const parts: string[] = [];
  if (tally.applied > 0) parts.push(`已应用 ${tally.applied}`);
  if (tally.conflicts > 0) parts.push(`冲突 ${tally.conflicts}`);
  if (tally.notFound > 0) parts.push(`不存在 ${tally.notFound}`);
  if (tally.failed > 0) parts.push(`失败 ${tally.failed}`);
  if (tally.cancelled > 0) parts.push(`未执行 ${tally.cancelled}`);
  return parts.join(" · ");
};

/**
 * The lifecycle sentence. A cancellation before execution says so and counts
 * the targets that never ran; an executing operation with no live lease is not
 * described as progressing.
 */
const lifecycleSummary = (operation: AgentOperation): string => {
  const remaining = operation.targetCount - operation.nextIndex;
  if (operation.state === "prepared")
    return `待您批准 · 共 ${operation.targetCount} 项，尚未执行`;
  if (operation.state === "approved")
    return `已批准，等待执行 · 共 ${operation.targetCount} 项`;
  if (operation.state === "executing")
    return operation.leaseHeld
      ? `执行中 · 已处理 ${operation.nextIndex}/${operation.targetCount}`
      : `执行已中断，当前无执行者持有 · 已处理 ${operation.nextIndex}/${operation.targetCount}，可再次执行`;
  if (operation.state === "completed")
    // A cancellation that arrived after an atomic command had already
    // committed is a request that did not take effect, not a cancellation.
    // Saying "已完成" alone would hide the request; saying "已取消" would
    // deny the work.
    return operation.tally.applied === operation.targetCount
      ? operation.cancelRequestedAt !== null
        ? `已完成 · ${operation.targetCount} 项全部应用；取消请求在命令提交之后到达，未能生效，也没有撤销已提交的顺序（如需反转请使用撤销操作）`
        : `已完成 · ${operation.targetCount} 项全部应用`
      : operation.cancelRequestedAt !== null
        ? `已完成（并非全部应用）· ${outcomeSummary(operation)}；期间收到过取消请求`
        : `已完成（并非全部应用）· ${outcomeSummary(operation)}`;
  if (operation.state === "cancelled")
    return operation.nextIndex === 0
      ? `执行前已取消 · ${operation.targetCount} 项均未执行`
      : `执行中取消 · 已应用 ${operation.tally.applied} 项，其余 ${remaining} 项未执行`;
  return `已失败 · ${outcomeSummary(operation)}`;
};

/** Who authorized it, and how. */
const approvalText = (operation: AgentOperation): string =>
  operation.approval === null
    ? "尚未批准"
    : operation.approval.kind === "owner"
      ? `Owner 批准 · ${formatTime(operation.approval.at)}`
      : `委托自动批准 · ${formatTime(operation.approval.at)}`;

/** The real next action, in the Owner's terms. */
const nextActionText = (operation: AgentOperation): string => {
  if (operation.state === "prepared") return "批准后才会执行";
  if (operation.state === "approved") return "等待代理执行，或由您立即执行";
  if (operation.state === "executing")
    return operation.leaseHeld ? "正在执行，稍候刷新" : "可再次执行以继续";
  return "无后续动作";
};

/** The interpreted filter of a keyword manifest, in one readable line. */
const criteriaSummary = (operation: AgentOperation): string | null => {
  const criteria = operation.criteria;
  if (criteria === null) return null;
  const parts = [
    `词：${criteria.terms.join("、")}`,
    matchLabels[criteria.match],
    scopeOfCriteria[criteria.scope],
  ];
  if (criteria.target)
    parts.push(`对象：${criteria.target.type} ${criteria.target.id}`);
  if (criteria.authorId)
    parts.push(`作者：${criteria.authorHandle ?? criteria.authorId}`);
  if (criteria.moderation) parts.push(`状态：${criteria.moderation}`);
  if (criteria.createdFrom || criteria.createdTo)
    parts.push(
      `时间：${criteria.createdFrom ?? "不限"} 至 ${criteria.createdTo ?? "不限"}`,
    );
  return parts.join(" · ");
};

type Busy = { readonly id: string; readonly action: string } | null;
type PrincipalDraft = {
  readonly label: string;
  readonly displayName: string;
  readonly scopes: ReadonlySet<AgentScope>;
  readonly enabled: boolean;
  readonly expectedVersion: number;
  readonly editing: boolean;
};

const emptyDraft: PrincipalDraft = {
  label: "",
  displayName: "",
  scopes: new Set<AgentScope>(),
  enabled: true,
  expectedVersion: 0,
  editing: false,
};

export const AgentOperationsClient = () => {
  const { openModal, closeModal } = useModal();
  const [principals, setPrincipals] = useState<AgentPrincipal[]>([]);
  const [delegations, setDelegations] = useState<AgentDelegation[]>([]);
  const [operations, setOperations] = useState<AgentOperationPage | null>(null);
  const [detail, setDetail] = useState<AgentOperationDetail | null>(null);
  const [targets, setTargets] = useState<AgentOperationTargetPage | null>(null);
  const [stateFilter, setStateFilter] = useState<AgentOperationState | "all">(
    "all",
  );
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [draft, setDraft] = useState<PrincipalDraft>(emptyDraft);
  const [revoking, setRevoking] = useState<AgentPrincipal | null>(null);
  const [delegationPrincipal, setDelegationPrincipal] = useState("");
  const [delegationKind, setDelegationKind] =
    useState<keyof typeof kindLabels>("comments.moderate");
  const [delegationMax, setDelegationMax] = useState("50");
  const [delegationHours, setDelegationHours] = useState("24");
  // A slow refresh must never overwrite a newer list or a newer selection.
  const listEpoch = useRef(0);
  const detailEpoch = useRef(0);

  const maxTargetsValue = Number(delegationMax);
  const hoursValue = Number(delegationHours);
  const maxTargetsError =
    Number.isInteger(maxTargetsValue) &&
    maxTargetsValue >= 1 &&
    maxTargetsValue <= MAX_TARGETS
      ? null
      : `请输入 1–${MAX_TARGETS} 的整数（以后端契约为准）`;
  const hoursError =
    Number.isInteger(hoursValue) && hoursValue >= 1 && hoursValue <= MAX_HOURS
      ? null
      : `请输入 1–${MAX_HOURS} 的整数小时`;
  const labelValid = /^agent-[a-z0-9-]{2,57}$/u.test(draft.label);

  const load = useCallback(async () => {
    const epoch = (listEpoch.current += 1);
    setLoading(true);
    try {
      const [principalPage, delegationPage, operationPage] = await Promise.all([
        call<AgentPrincipalPage>("agent-principals-read", {}),
        call<AgentDelegationPage>("agent-delegations-read", {
          includeInactive: false,
        }),
        call<AgentOperationPage>("agent-operations-read", {
          ...(stateFilter === "all" ? {} : { state: stateFilter }),
          page,
          pageSize: PAGE_SIZE,
        }),
      ]);
      if (epoch !== listEpoch.current) return;
      setPrincipals(principalPage.items);
      setDelegations(delegationPage.items);
      setOperations(operationPage);
      setError(null);
    } catch (failure) {
      if (epoch !== listEpoch.current) return;
      setError(describeFailure(failure).text);
    } finally {
      if (epoch === listEpoch.current) setLoading(false);
    }
  }, [stateFilter, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const command = async (
    id: string,
    action: string,
    run: () => Promise<unknown>,
    done: string,
  ) => {
    if (busy !== null) return;
    setBusy({ id, action });
    setNotice(null);
    setError(null);
    try {
      await run();
      setNotice(done);
      await load();
    } catch (failure) {
      setError(describeFailure(failure).text);
    } finally {
      setBusy(null);
    }
  };

  const savePrincipal = async () => {
    const editing = draft.editing;
    await command(
      draft.label,
      "write",
      () =>
        call<AgentPrincipal>("agent-principal-write", {
          requestId: crypto.randomUUID(),
          label: draft.label,
          displayName: draft.displayName || draft.label,
          scopes: [...draft.scopes],
          enabled: draft.enabled,
          expectedVersion: draft.expectedVersion,
        }),
      editing ? "代理主体已更新。" : "代理主体已创建。",
    );
    setDraft(emptyDraft);
  };

  const setPrincipalEnabled = (principal: AgentPrincipal, enabled: boolean) =>
    command(
      principal.label,
      "enable",
      () =>
        call<AgentPrincipal>("agent-principal-write", {
          requestId: crypto.randomUUID(),
          label: principal.label,
          displayName: principal.displayName,
          scopes: principal.scopes,
          enabled,
          expectedVersion: principal.version,
        }),
      enabled
        ? "代理主体已启用，可再次发起操作。"
        : "代理主体已停用；可随时重新启用，已完成的操作不受影响。",
    );

  const revokePrincipal = (principal: AgentPrincipal) =>
    command(
      principal.label,
      "revoke",
      () =>
        call<AgentPrincipal>("agent-principal-revoke", {
          requestId: crypto.randomUUID(),
          label: principal.label,
          expectedVersion: principal.version,
        }),
      "代理主体已永久撤销，不能恢复。",
    );

  const createDelegation = () =>
    command(
      "delegation",
      "create",
      () =>
        call<AgentDelegation>("agent-delegation-create", {
          requestId: crypto.randomUUID(),
          principal: delegationPrincipal,
          kind: delegationKind,
          maxTargets: maxTargetsValue,
          expiresAt: new Date(
            Date.now() + hoursValue * 60 * 60 * 1000,
          ).toISOString(),
        }),
      "委托已创建：该主体在范围内准备的指定清单操作将自动获批。",
    );

  const revokeDelegation = (delegation: AgentDelegation) =>
    command(
      delegation.id,
      "revoke",
      () =>
        call<AgentDelegation>("agent-delegation-revoke", {
          requestId: crypto.randomUUID(),
          id: delegation.id,
        }),
      "委托已撤销：此后每个操作都需要您批准；已完成的操作不受影响。",
    );

  const operationCommand = (
    operation: AgentOperation,
    name:
      | "agent-operation-approve"
      | "agent-operation-cancel"
      | "agent-operation-execute",
    done: string,
  ) =>
    command(
      operation.id,
      name,
      () =>
        call(name, {
          requestId: crypto.randomUUID(),
          operationId: operation.id,
        }),
      done,
    );

  const openDetail = async (operation: AgentOperation, targetPage = 1) => {
    const epoch = (detailEpoch.current += 1);
    try {
      const [full, targetsPage] = await Promise.all([
        call<AgentOperationDetail>("agent-operation-read", {
          operationId: operation.id,
        }),
        call<AgentOperationTargetPage>("agent-operation-targets", {
          operationId: operation.id,
          targetsPage: targetPage,
          targetsPageSize: TARGET_PAGE_SIZE,
        }),
      ]);
      // A slower earlier request must not replace a newer selection.
      if (epoch !== detailEpoch.current) return;
      setDetail(full);
      setTargets(targetsPage);
    } catch (failure) {
      if (epoch !== detailEpoch.current) return;
      setError(describeFailure(failure).text);
    }
  };

  const totalPages =
    operations === null || operations.total === 0
      ? 1
      : Math.ceil(operations.total / operations.pageSize);

  return (
    <div className={styles.workspace} data-agent-operations>
      <SetStepNav
        nav={[
          { label: "发布工具", url: "/admin/editorial-workflow" },
          { label: "AI 操作" },
        ]}
      />
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>AI 操作</h1>
          <p className={styles.lead}>
            机器主体只能对已冻结的对象清单发起操作：或由调用方逐条指定，或由后端按关键词在评论正文中检索后冻结。
            关键词清单一律需要您批准；执行按 50
            项分块持久记录，可取消，可有条件撤销。{TIME_ZONE_NOTE}。{" "}
            <Link href="/admin/community-moderation">返回审核队列</Link>
          </p>
        </div>
      </header>

      {error === null ? null : (
        <p className={styles.notice} data-tone="error" role="alert">
          {error}
        </p>
      )}
      {notice === null ? null : (
        <p className={styles.notice} data-tone="success" role="status">
          {notice}
        </p>
      )}

      <section
        className={`${styles.panel} ${styles.agentPanel}`}
        aria-labelledby="agent-operations-title"
      >
        <div className={styles.panelHeader}>
          <h2 id="agent-operations-title">操作</h2>
          <label className={styles.agentField}>
            <span>状态</span>
            <select
              onChange={(event) => {
                setPage(1);
                setStateFilter(
                  event.currentTarget.value as AgentOperationState | "all",
                );
              }}
              value={stateFilter}
            >
              <option value="all">全部</option>
              {(Object.keys(stateLabels) as AgentOperationState[]).map(
                (value) => (
                  <option key={value} value={value}>
                    {stateLabels[value]}
                  </option>
                ),
              )}
            </select>
          </label>
        </div>

        {loading ? (
          <p className={styles.state} role="status">
            正在载入操作…
          </p>
        ) : operations === null || operations.items.length === 0 ? (
          <p className={styles.state}>
            {stateFilter === "all"
              ? "暂无代理操作。"
              : "该状态下暂无操作；可切换为“全部”。"}
          </p>
        ) : (
          <>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>操作</th>
                    <th>主体</th>
                    <th>状态与结果</th>
                    <th>批准</th>
                    <th>创建时间</th>
                    <th>决定</th>
                  </tr>
                </thead>
                <tbody>
                  {operations.items.map((operation) => (
                    <tr
                      data-busy={busy?.id === operation.id ? "true" : undefined}
                      data-operation-id={operation.id}
                      key={operation.id}
                    >
                      <td>
                        <button
                          className={styles.rowLink}
                          onClick={() => void openDetail(operation)}
                          type="button"
                        >
                          {describeOperation(operation)}
                        </button>
                        {operation.undoOf === null ? null : (
                          <span className={styles.agentHint}>撤销操作</span>
                        )}
                        {criteriaSummary(operation) === null ? null : (
                          <span className={styles.agentHint}>
                            {criteriaSummary(operation)}
                          </span>
                        )}
                      </td>
                      <td className={styles.mono}>{operation.principal}</td>
                      <td>
                        <span
                          className={styles.chip}
                          data-state={operation.state}
                        >
                          {stateLabels[operation.state]}
                        </span>
                        <span className={styles.agentHint}>
                          {lifecycleSummary(operation)}
                        </span>
                      </td>
                      <td>
                        {approvalText(operation)}
                        <span className={styles.agentHint}>
                          {nextActionText(operation)}
                        </span>
                      </td>
                      <td>{formatTime(operation.createdAt)}</td>
                      <td>
                        <div className={styles.agentActions}>
                          {operation.state === "prepared" ? (
                            <button
                              className={styles.actionButton}
                              data-primary="true"
                              disabled={busy !== null}
                              onClick={() =>
                                void operationCommand(
                                  operation,
                                  "agent-operation-approve",
                                  "操作已批准，等待执行。",
                                )
                              }
                              type="button"
                            >
                              批准
                            </button>
                          ) : null}
                          {operation.state === "approved" ||
                          operation.state === "executing" ? (
                            <button
                              className={styles.actionButton}
                              disabled={busy !== null || operation.leaseHeld}
                              onClick={() =>
                                void operationCommand(
                                  operation,
                                  "agent-operation-execute",
                                  "已执行一轮，可查看进度。",
                                )
                              }
                              type="button"
                            >
                              立即执行
                            </button>
                          ) : null}
                          {operation.state === "prepared" ||
                          operation.state === "approved" ||
                          operation.state === "executing" ? (
                            <button
                              className={styles.actionButton}
                              data-danger="true"
                              disabled={busy !== null}
                              onClick={() =>
                                void operationCommand(
                                  operation,
                                  "agent-operation-cancel",
                                  "已请求取消：尚未执行的对象不会被处理，已应用的不会回退。",
                                )
                              }
                              type="button"
                            >
                              取消
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className={styles.pager}>
              <button
                className={styles.secondary}
                disabled={page <= 1 || busy !== null}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
                type="button"
              >
                上一页
              </button>
              <span className={styles.summaryLine}>
                第 {operations.page}/{totalPages} 页 · 共 {operations.total} 条
              </span>
              <button
                className={styles.secondary}
                disabled={page >= totalPages || busy !== null}
                onClick={() => setPage((current) => current + 1)}
                type="button"
              >
                下一页
              </button>
            </div>
          </>
        )}

        {detail === null ? null : (
          <div className={styles.card} data-operation-detail>
            <div className={styles.panelHeader}>
              <h3>
                操作详情 <span className={styles.mono}>{detail.id}</span>
              </h3>
              <button
                className={styles.secondary}
                onClick={() => {
                  detailEpoch.current += 1;
                  setDetail(null);
                  setTargets(null);
                }}
                type="button"
              >
                关闭
              </button>
            </div>
            <dl className={styles.agentFacts}>
              <div>
                <dt>任务</dt>
                <dd>{describeOperation(detail)}</dd>
              </div>
              <div>
                <dt>发起主体</dt>
                <dd className={styles.mono}>{detail.principal}</dd>
              </div>
              <div>
                <dt>生命周期</dt>
                <dd>{lifecycleSummary(detail)}</dd>
              </div>
              <div>
                <dt>批准来源</dt>
                <dd>{approvalText(detail)}</dd>
              </div>
              <div>
                <dt>对象结果</dt>
                <dd>
                  已应用 {detail.tally.applied} · 冲突 {detail.tally.conflicts}{" "}
                  · 不存在 {detail.tally.notFound} · 失败 {detail.tally.failed}{" "}
                  · 未执行 {detail.tally.cancelled}
                </dd>
              </div>
              <div>
                <dt>时间</dt>
                <dd>
                  创建 {formatTime(detail.createdAt)}
                  {detail.approvedAt
                    ? ` · 批准 ${formatTime(detail.approvedAt)}`
                    : ""}
                  {detail.finishedAt
                    ? ` · 结束 ${formatTime(detail.finishedAt)}`
                    : ""}
                </dd>
              </div>
            </dl>

            {detail.criteria === null ? null : (
              <div className={styles.agentManifest} data-manifest>
                <h4>关键词清单（批准前请核对）</h4>
                <dl className={styles.agentFacts}>
                  <div>
                    <dt>匹配词（仅评论正文）</dt>
                    <dd className={styles.mono}>
                      {detail.criteria.terms.join(" / ")}
                    </dd>
                  </div>
                  <div>
                    <dt>组合规则</dt>
                    <dd>{matchLabels[detail.criteria.match]}</dd>
                  </div>
                  <div>
                    <dt>范围</dt>
                    <dd>{scopeOfCriteria[detail.criteria.scope]}</dd>
                  </div>
                  <div>
                    <dt>对象</dt>
                    <dd>
                      {detail.criteria.target
                        ? `${detail.criteria.target.type} ${detail.criteria.target.id}`
                        : "不限"}
                    </dd>
                  </div>
                  <div>
                    <dt>作者</dt>
                    <dd className={styles.mono}>
                      {detail.criteria.authorId ??
                        detail.criteria.authorHandle ??
                        "不限"}
                    </dd>
                  </div>
                  <div>
                    <dt>状态与时间</dt>
                    <dd>
                      {detail.criteria.moderation ?? "不限"} ·{" "}
                      {detail.criteria.createdFrom ?? "不限"} 至{" "}
                      {detail.criteria.createdTo ?? "不限"}
                    </dd>
                  </div>
                  <div>
                    <dt>解释方式</dt>
                    <dd>
                      正文字面子串匹配；不区分大小写（SQL lower），不做 Unicode
                      规范化（NFC/NFD 不互相匹配）；% _ \ 均为普通字符；时区{" "}
                      {detail.criteria.interpretation.timezone}
                      {detail.criteria.interpretation.defaults.length === 0
                        ? ""
                        : `；未指定项：${detail.criteria.interpretation.defaults.join("、")}`}
                    </dd>
                  </div>
                  <div>
                    <dt>准备时间与命中数</dt>
                    <dd>
                      {formatTime(detail.criteria.preparedAt)} · 命中{" "}
                      {detail.criteria.matchCount}{" "}
                      条；清单已冻结，之后新增的内容不会加入
                    </dd>
                  </div>
                </dl>
                <h4>正文样本（{detail.criteria.sample.length} 条）</h4>
                <ul className={styles.agentSample}>
                  {detail.criteria.sample.map((row) => (
                    <li key={row.id}>
                      <span className={styles.mono}>
                        {row.kind === "reply" ? "回复" : "评论"} {row.id}
                      </span>
                      <span>{row.excerpt}</span>
                    </li>
                  ))}
                </ul>
                <p className={styles.summaryLine}>
                  修改任何条件都会生成一份新的待批准清单；已批准的清单不会被改写。
                </p>
              </div>
            )}

            {targets === null ? null : (
              <>
                <h4>冻结对象（分页查看）</h4>
                {detail.kind === "featured.set" ? (
                  <p className={styles.summaryLine}>
                    这是一条有序推荐命令：下表的顺序就是请求的推荐顺序，整条命令
                    要么全部提交、要么全部不提交，因此每个对象的结果相同。冲突表
                    示没有写入任何一行；取消不等于回滚，已提交的命令需要撤销操作
                    才能反转。命令未点名的推荐项保持原位。
                  </p>
                ) : null}
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>对象</th>
                        <th>准备时状态</th>
                        <th>请求</th>
                        <th>结果</th>
                      </tr>
                    </thead>
                    <tbody>
                      {targets.items.map((target, index) => {
                        const absolute =
                          (targets.page - 1) * targets.pageSize + index;
                        const result = detail.results.find(
                          (row) => row.index === absolute,
                        );
                        const id =
                          "id" in target
                            ? target.id
                            : `${target.target.type}:${target.target.id}`;
                        const prior =
                          "id" in target
                            ? (target.prior ?? "不存在")
                            : target.prior === null
                              ? "无推荐行"
                              : `${target.prior.enabled ? "启用" : "停用"} @${target.prior.position}`;
                        const requested =
                          "id" in target
                            ? "—"
                            : `${target.enabled ? "启用" : "停用"} @${target.position}`;
                        return (
                          <tr key={id}>
                            <td>{absolute}</td>
                            <td className={styles.mono}>{id}</td>
                            <td>{prior}</td>
                            <td>{requested}</td>
                            <td>
                              {result === undefined
                                ? "未执行"
                                : `${result.outcome}${result.detail ? `（${result.detail}）` : ""}`}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className={styles.pager}>
                  <button
                    className={styles.secondary}
                    disabled={targets.page <= 1}
                    onClick={() => void openDetail(detail, targets.page - 1)}
                    type="button"
                  >
                    上一页
                  </button>
                  <span className={styles.summaryLine}>
                    第 {targets.page} 页 · 共 {targets.total} 个对象
                  </span>
                  <button
                    className={styles.secondary}
                    disabled={targets.page * targets.pageSize >= targets.total}
                    onClick={() => void openDetail(detail, targets.page + 1)}
                    type="button"
                  >
                    下一页
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </section>

      <details className={styles.agentSection}>
        <summary>代理主体（{principals.length}）</summary>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>名称</th>
                <th>权限范围</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {principals.length === 0 ? (
                <tr>
                  <td colSpan={4}>尚无代理主体。</td>
                </tr>
              ) : (
                principals.map((principal) => (
                  <tr data-principal={principal.label} key={principal.label}>
                    <td>
                      {principal.displayName}
                      <span className={`${styles.agentHint} ${styles.mono}`}>
                        {principal.label}
                      </span>
                    </td>
                    <td>
                      <ul className={styles.agentScopes}>
                        {principal.scopes.map((scope) => (
                          <li key={scope}>
                            {scopeLabels[scope] ?? scope}
                            <span
                              className={`${styles.agentHint} ${styles.mono}`}
                            >
                              {scope}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </td>
                    <td>
                      {principal.revokedAt !== null
                        ? "已撤销（不可恢复）"
                        : principal.enabled
                          ? "启用"
                          : "已停用（可恢复）"}
                    </td>
                    <td>
                      {principal.revokedAt === null ? (
                        <div className={styles.agentActions}>
                          <button
                            className={styles.actionButton}
                            disabled={busy !== null}
                            onClick={() =>
                              setDraft({
                                label: principal.label,
                                displayName: principal.displayName,
                                scopes: new Set(principal.scopes),
                                enabled: principal.enabled,
                                expectedVersion: principal.version,
                                editing: true,
                              })
                            }
                            type="button"
                          >
                            编辑
                          </button>
                          <button
                            className={styles.actionButton}
                            disabled={busy !== null}
                            onClick={() =>
                              void setPrincipalEnabled(
                                principal,
                                !principal.enabled,
                              )
                            }
                            type="button"
                          >
                            {principal.enabled ? "停用" : "启用"}
                          </button>
                          <button
                            className={styles.actionButton}
                            data-danger="true"
                            disabled={busy !== null}
                            onClick={() => {
                              setRevoking(principal);
                              openModal("agent-principal-revoke");
                            }}
                            type="button"
                          >
                            永久撤销
                          </button>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <form
          className={styles.agentForm}
          onSubmit={(event) => {
            event.preventDefault();
            void savePrincipal();
          }}
        >
          <h3>{draft.editing ? "编辑代理主体" : "新建代理主体"}</h3>
          <label className={styles.agentField}>
            <span>标签（创建后不可更改）</span>
            <input
              disabled={draft.editing}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  label: event.currentTarget.value.trim(),
                }))
              }
              placeholder="agent-reviewer"
              value={draft.label}
            />
          </label>
          {draft.label === "" || labelValid ? null : (
            <p className={styles.agentError}>
              标签形如 agent-xxx（小写字母、数字、连字符）
            </p>
          )}
          <label className={styles.agentField}>
            <span>名称</span>
            <input
              maxLength={80}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  displayName: event.currentTarget.value,
                }))
              }
              placeholder="例如：评审代理"
              value={draft.displayName}
            />
          </label>
          <fieldset className={styles.agentScopeGroup}>
            <legend>权限范围</legend>
            {scopeList.map((scope) => (
              <label className={styles.agentCheckbox} key={scope}>
                <input
                  checked={draft.scopes.has(scope)}
                  onChange={(event) =>
                    setDraft((current) => {
                      const next = new Set(current.scopes);
                      if (event.currentTarget.checked) next.add(scope);
                      else next.delete(scope);
                      return { ...current, scopes: next };
                    })
                  }
                  type="checkbox"
                />
                <span>
                  {scopeLabels[scope]}
                  <span className={`${styles.agentHint} ${styles.mono}`}>
                    {scope}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          <label className={styles.agentCheckbox}>
            <input
              checked={draft.enabled}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  enabled: event.currentTarget.checked,
                }))
              }
              type="checkbox"
            />
            <span>启用（停用后可随时恢复）</span>
          </label>
          <div className={styles.agentActions}>
            <button
              className={styles.actionButton}
              data-primary="true"
              disabled={busy !== null || !labelValid}
              type="submit"
            >
              {draft.editing ? "保存修改" : "创建主体"}
            </button>
            {draft.editing ? (
              <button
                className={styles.secondary}
                onClick={() => setDraft(emptyDraft)}
                type="button"
              >
                取消编辑
              </button>
            ) : null}
          </div>
        </form>
      </details>

      <details className={styles.agentSection}>
        <summary>自动批准委托（{delegations.length}）</summary>
        <p className={styles.summaryLine}>
          委托是一项“免逐次批准”的授权：在有效期内，该主体准备的、属于所选操作种类且不超过单次上限的
          <strong>指定清单</strong>
          操作会自动获批。它不是每日额度，不代表后台自动执行，也不覆盖关键词清单——关键词清单一律需要您逐次批准。
        </p>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>主体</th>
                <th>覆盖的操作种类</th>
                <th>单次对象上限</th>
                <th>到期</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {delegations.length === 0 ? (
                <tr>
                  <td colSpan={5}>没有有效委托；每个操作都需要您批准。</td>
                </tr>
              ) : (
                delegations.map((delegation) => (
                  <tr data-delegation={delegation.id} key={delegation.id}>
                    <td className={styles.mono}>{delegation.principal}</td>
                    <td>
                      {kindLabels[delegation.kind]}（该类已实现的全部动作）
                    </td>
                    <td>{delegation.maxTargets}</td>
                    <td>{formatTime(delegation.expiresAt)}</td>
                    <td>
                      <button
                        className={styles.actionButton}
                        data-danger="true"
                        disabled={busy !== null}
                        onClick={() => void revokeDelegation(delegation)}
                        type="button"
                      >
                        撤销委托
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <form
          className={styles.agentForm}
          onSubmit={(event) => {
            event.preventDefault();
            void createDelegation();
          }}
        >
          <h3>新建委托</h3>
          <label className={styles.agentField}>
            <span>主体</span>
            <select
              onChange={(event) =>
                setDelegationPrincipal(event.currentTarget.value)
              }
              value={delegationPrincipal}
            >
              <option value="">请选择</option>
              {principals
                .filter((principal) => principal.revokedAt === null)
                .map((principal) => (
                  <option key={principal.label} value={principal.label}>
                    {principal.displayName}（{principal.label}）
                  </option>
                ))}
            </select>
          </label>
          <label className={styles.agentField}>
            <span>操作种类</span>
            <select
              onChange={(event) =>
                setDelegationKind(
                  event.currentTarget.value as keyof typeof kindLabels,
                )
              }
              value={delegationKind}
            >
              {(Object.keys(kindLabels) as (keyof typeof kindLabels)[]).map(
                (kind) => (
                  <option key={kind} value={kind}>
                    {kindLabels[kind]}
                  </option>
                ),
              )}
            </select>
          </label>
          <label className={styles.agentField}>
            <span>单次对象上限（1–{MAX_TARGETS}）</span>
            <input
              inputMode="numeric"
              onChange={(event) => setDelegationMax(event.currentTarget.value)}
              value={delegationMax}
            />
          </label>
          {maxTargetsError === null ? null : (
            <p className={styles.agentError}>{maxTargetsError}</p>
          )}
          <label className={styles.agentField}>
            <span>有效小时数（1–{MAX_HOURS}）</span>
            <input
              inputMode="numeric"
              onChange={(event) =>
                setDelegationHours(event.currentTarget.value)
              }
              value={delegationHours}
            />
          </label>
          {hoursError === null ? null : (
            <p className={styles.agentError}>{hoursError}</p>
          )}
          <div className={styles.agentActions}>
            <button
              className={styles.actionButton}
              data-primary="true"
              disabled={
                busy !== null ||
                delegationPrincipal === "" ||
                maxTargetsError !== null ||
                hoursError !== null
              }
              type="submit"
            >
              创建委托
            </button>
          </div>
        </form>
      </details>

      <ConfirmationModal
        heading="永久撤销代理主体"
        modalSlug="agent-principal-revoke"
        cancelLabel="取消"
        confirmLabel="确认永久撤销"
        confirmingLabel="撤销中…"
        body={
          <p>
            即将永久撤销「{revoking?.displayName}」（
            <span className={styles.mono}>{revoking?.label}</span>
            ）。撤销不可恢复：该主体此后无法发起任何操作，也不能重新启用；如果只是暂时停止，请改用“停用”。
            已完成的操作与审计记录保留，正在进行的操作不会自动回退。
          </p>
        }
        onConfirm={async () => {
          closeModal("agent-principal-revoke");
          if (revoking) await revokePrincipal(revoking);
          setRevoking(null);
        }}
      />
    </div>
  );
};
