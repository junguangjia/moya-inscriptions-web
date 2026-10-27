"use client";

import { workspacePageLabel } from "../workspace/routes";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Gutter, Button, SetStepNav } from "@payloadcms/ui";
import styles from "../community/community.module.css";
import type {
  EditorialApprovalResult,
  EditorialMutationResult,
  OwnerDraftPage,
  OwnerDraftSummary,
  OwnerHistoryPage,
} from "@moya/contracts/internal/editorial";

const labels: Record<string, string> = {
  title: "标题",
  summary: "摘要",
  periodLabel: "时代标签",
  dynasty: "朝代",
  dateText: "年代",
  province: "省",
  prefecture: "市",
  county: "县",
  currentLocation: "现址",
  currentCustodian: "保管方",
  description: "简介",
  scriptStyle: "书体",
  transcription: "释文",
  historicalContext: "历史背景",
  scholarlyResearch: "研究",
  aliases: "别名",
  provenance: "内部来源",
  contributors: "作者与书者",
  sourceCitations: "公开引用",
  media: "图片",
  ownerNote: "内部备注",
  catalogId: "目录身份",
  sourceId: "来源身份",
  kind: "类别",
};
const fieldLabels = (fields: string[]) =>
  fields.map((field) => labels[field] ?? "内容").join("、");

const errorMessage = (code: string) =>
  ({
    REVISION_CONFLICT: "记录已被他人修改。请刷新并重新审核当前版本。",
    CONTENT_INVALID: "所选记录仍有缺失或不合法字段，请先完成编辑。",
    APPROVAL_SCOPE_INVALID:
      "所选自动化账号没有全部记录的编辑范围，请在账号页调整授权范围。",
    APPROVAL_ACCOUNT_INVALID: "请选择有效的自动化账号。",
    OWNER_WORKFLOW_ONLY: "此操作仅限 Owner。",
    AUTHORIZATION_REQUIRED: "登录已过期，请重新登录。",
    RESTORE_OWNER_ONLY: "只有 Owner 可以恢复历史版本。",
    CONCURRENT_OPERATION_BUSY: "记录正在保存，请稍后刷新重试。",
  })[code] ?? "操作未完成。请刷新后重试；内容不会被自动覆盖。";

class WorkflowFailure extends Error {}

async function call<T>(name: string, input: unknown): Promise<T> {
  const response = await fetch(`/api/editorial/${name}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    cache: "no-store",
  });
  const body: unknown = await response.json();
  if (
    !body ||
    typeof body !== "object" ||
    !("ok" in body) ||
    body.ok !== true
  ) {
    let code = "OPERATION_FAILED";
    if (
      body &&
      typeof body === "object" &&
      "error" in body &&
      body.error &&
      typeof body.error === "object" &&
      "code" in body.error &&
      typeof body.error.code === "string"
    ) {
      code = body.error.code;
    }
    throw new WorkflowFailure(errorMessage(code));
  }
  if (!response.ok || !("result" in body))
    throw new WorkflowFailure(errorMessage("OPERATION_FAILED"));
  return body.result as T;
}

export const OwnerWorkflowClient = () => {
  const [data, setData] = useState<OwnerDraftPage | null>(null);
  const [selected, setSelected] = useState<OwnerDraftSummary[]>([]);
  const [automationId, setAutomationId] = useState("");
  const [history, setHistory] = useState<OwnerHistoryPage | null>(null);
  const [versionId, setVersionId] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [failure, setFailure] = useState("");
  const [mode, setMode] = useState<"approval" | "history">("approval");
  const [confirming, setConfirming] = useState(false);
  const mutationLock = useRef(false);

  const load = useCallback(async (page = 1) => {
    setBusy(true);
    setFailure("");
    setConfirming(false);
    try {
      const next = await call<OwnerDraftPage>("owner-drafts", {
        page,
        pageSize: 20,
      });
      setData(next);
      setSelected([]);
      setHistory(null);
      setVersionId("");
    } catch (error) {
      setFailure(
        error instanceof WorkflowFailure
          ? error.message
          : errorMessage("OPERATION_FAILED"),
      );
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const approve = async () => {
    if (mutationLock.current) return;
    mutationLock.current = true;
    setConfirming(false);
    setBusy(true);
    setFailure("");
    setNotice("");
    try {
      const result = await call<EditorialApprovalResult>("approve-batch", {
        automationUserId: Number(automationId),
        items: selected.map(({ id, revision }) => ({ id, revision })),
      });
      setNotice(
        `已批准批次 #${result.approvalId}，共 ${result.itemCount} 条。自动化可执行这些已审核版本；后续内容变动会使对应批准失效。`,
      );
      setSelected([]);
    } catch (error) {
      setFailure(
        error instanceof WorkflowFailure
          ? error.message
          : errorMessage("OPERATION_FAILED"),
      );
    } finally {
      mutationLock.current = false;
      setBusy(false);
    }
  };

  const loadHistory = async (id: number, page = 1) => {
    setMode("history");
    setConfirming(false);
    setBusy(true);
    setFailure("");
    setVersionId("");
    setHistory(null);
    try {
      setHistory(await call<OwnerHistoryPage>("owner-history", { id, page }));
    } catch (error) {
      setFailure(
        error instanceof WorkflowFailure
          ? error.message
          : errorMessage("OPERATION_FAILED"),
      );
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    if (!history || mutationLock.current) return;
    mutationLock.current = true;
    setBusy(true);
    setFailure("");
    setNotice("");
    try {
      const result = await call<EditorialMutationResult>("restore-draft", {
        versionId: Number(versionId),
        expectedRevision: history.currentRevision,
      });
      setNotice(
        `已恢复为新草稿，当前版本 ${result.revision}。已发布页面保持原样；请审核恢复内容后再发布。`,
      );
      setHistory(null);
      setVersionId("");
      await load(data?.page ?? 1);
    } catch (error) {
      setFailure(
        error instanceof WorkflowFailure
          ? error.message
          : errorMessage("OPERATION_FAILED"),
      );
    } finally {
      mutationLock.current = false;
      setBusy(false);
    }
  };

  const selectable =
    data?.docs.filter((row) => row.missingFields.length === 0) ?? [];
  const allSelected =
    selectable.length > 0 &&
    selectable.every((row) => selected.some(({ id }) => id === row.id));
  return (
    <Gutter className="archive-view">
      <div className={styles.workspace}>
        <SetStepNav nav={[{ label: "发布工具" }, { label: "批量审核" }]} />
        <header className={styles.header}>
          <div>
            <h1 className={styles.title}>
              {workspacePageLabel("/admin/editorial-workflow")}
            </h1>
            <p className={styles.lead}>
              核对记录变更，批准指定账号执行当前版本。
            </p>
          </div>
          <Button
            buttonStyle="secondary"
            disabled={busy}
            onClick={() => void load(data?.page ?? 1)}
          >
            刷新
          </Button>
        </header>
        {notice && (
          <p className={styles.receipt} data-tone="success" role="status">
            {notice}
          </p>
        )}
        {failure && (
          <p className={styles.notice} data-tone="error" role="alert">
            {failure}
          </p>
        )}
        <div className={styles.tabs} role="tablist" aria-label="编辑工具">
          {(
            [
              ["approval", "批量审核"],
              ["history", "版本恢复"],
            ] as const
          ).map(([value, label]) => (
            <button
              className={styles.tab}
              type="button"
              role="tab"
              aria-selected={mode === value}
              aria-controls="owner-workflow-content"
              tabIndex={mode === value ? 0 : -1}
              key={value}
              onKeyDown={(event) => {
                if (
                  !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                    event.key,
                  )
                )
                  return;
                event.preventDefault();
                const next =
                  event.key === "Home"
                    ? "approval"
                    : event.key === "End"
                      ? "history"
                      : value === "approval"
                        ? "history"
                        : "approval";
                setMode(next);
                setConfirming(false);
                const tabs =
                  event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                    '[role="tab"]',
                  );
                tabs?.[next === "approval" ? 0 : 1]?.focus();
              }}
              onClick={() => {
                setMode(value);
                setConfirming(false);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <section
          id="owner-workflow-content"
          role="tabpanel"
          aria-label={mode === "approval" ? "批量审核" : "版本恢复"}
        >
          <div className={styles.summaryLine}>
            <p>
              {data
                ? `共 ${data.totalDocs} 条 · 第 ${data.page} / ${Math.max(1, data.totalPages)} 页`
                : "正在读取记录…"}
            </p>
            {mode === "history" && (
              <span>选择记录，查看可恢复的历史版本。</span>
            )}
          </div>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  {mode === "approval" && (
                    <th scope="col">
                      <input
                        type="checkbox"
                        aria-label="选择本页全部可批准记录"
                        checked={allSelected}
                        disabled={busy || confirming || selectable.length === 0}
                        onChange={(event) =>
                          setSelected(event.target.checked ? selectable : [])
                        }
                      />
                    </th>
                  )}
                  <th scope="col">记录</th>
                  <th scope="col">状态</th>
                  <th scope="col">变更与待补充</th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {data?.docs.map((row) => (
                  <tr key={row.id}>
                    {mode === "approval" && (
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`选择 ${row.title ?? "未填写标题"}`}
                          disabled={
                            busy || confirming || row.missingFields.length > 0
                          }
                          checked={selected.some(({ id }) => id === row.id)}
                          onChange={(event) =>
                            setSelected(
                              event.target.checked
                                ? [...selected, row]
                                : selected.filter(({ id }) => id !== row.id),
                            )
                          }
                        />
                      </td>
                    )}
                    <td>
                      <Link
                        className={styles.rowLink}
                        href={`/admin/collections/catalogs/${row.id}`}
                      >
                        {row.title ?? "未填写标题"}
                      </Link>
                      <span className={styles.secondary}>
                        版本 {row.revision}
                      </span>
                    </td>
                    <td>
                      <span
                        className={styles.chip}
                        data-state={
                          row.status === "published" ? "visible" : "pending"
                        }
                      >
                        <span aria-hidden="true">
                          {row.status === "published" ? "✓" : "◷"}
                        </span>{" "}
                        {row.status === "published" ? "已发布" : "草稿"}
                      </span>
                    </td>
                    <td>
                      <p className={styles.excerpt}>
                        {row.changedFields.length
                          ? fieldLabels(row.changedFields)
                          : "无内容差异"}
                      </p>
                      {row.missingFields.length > 0 && (
                        <p className={styles.notice} data-tone="error">
                          待补充：{fieldLabels(row.missingFields)}
                        </p>
                      )}
                    </td>
                    <td>
                      <div className={styles.actions}>
                        <Link
                          href={`/admin/collections/catalogs/${row.id}/versions`}
                        >
                          对比版本
                        </Link>
                        {mode === "history" && (
                          <Button
                            buttonStyle="secondary"
                            disabled={busy}
                            onClick={() => void loadHistory(row.id)}
                          >
                            查看历史
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data?.docs.length === 0 && (
            <p className={styles.state}>暂无记录。</p>
          )}
          <div className={styles.pager}>
            <Button
              buttonStyle="secondary"
              disabled={busy || !data || data.page <= 1}
              onClick={() => void load((data?.page ?? 1) - 1)}
            >
              上一页
            </Button>
            <Button
              buttonStyle="secondary"
              disabled={busy || !data || data.page >= data.totalPages}
              onClick={() => void load((data?.page ?? 1) + 1)}
            >
              下一页
            </Button>
          </div>
        </section>
        {mode === "approval" && (
          <fieldset className={styles.fieldset} disabled={busy}>
            <legend>批准所选版本</legend>
            <label className={styles.reportField}>
              执行账号
              <select
                value={automationId}
                disabled={confirming}
                onChange={(event) => setAutomationId(event.target.value)}
              >
                <option value="">请选择自动化账号</option>
                {data?.automationUsers.map(({ id, label }) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <p className={styles.secondary}>
              已选 {selected.length}{" "}
              条。批准后，该账号可发布所选版本；内容变动需要重新审核。
            </p>
            {confirming ? (
              <div
                className={styles.reportConfirmation}
                role="group"
                aria-label="确认批次批准"
              >
                <strong>批准 {selected.length} 条记录的当前版本</strong>
                <p>
                  执行账号：
                  {
                    data?.automationUsers.find(
                      ({ id }) => String(id) === automationId,
                    )?.label
                  }
                  。这会授予本批次发布权限。
                </p>
                <div className={styles.actions}>
                  <Button disabled={busy} onClick={() => void approve()}>
                    确认批准
                  </Button>
                  <Button
                    buttonStyle="secondary"
                    disabled={busy}
                    onClick={() => setConfirming(false)}
                  >
                    返回修改
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                disabled={busy || selected.length === 0 || !automationId}
                onClick={() => setConfirming(true)}
              >
                核对并批准…
              </Button>
            )}
          </fieldset>
        )}
        {mode === "history" && history && (
          <fieldset className={styles.fieldset} disabled={busy}>
            <legend>恢复为新草稿</legend>
            <p>
              <Link href={`/admin/collections/catalogs/${history.id}`}>
                {data?.docs.find(({ id }) => id === history.id)?.title ??
                  `记录 #${history.id}`}
              </Link>{" "}
              · 当前版本 {history.currentRevision}
            </p>
            <p className={styles.secondary}>
              恢复后生成新草稿，审核后可另行发布。
            </p>
            <label className={styles.reportField}>
              历史版本
              <select
                value={versionId}
                onChange={(event) => setVersionId(event.target.value)}
              >
                <option value="">请选择版本</option>
                {history.docs.map((version) => (
                  <option key={version.id} value={version.id}>
                    版本 {version.revision} · {version.title ?? "未填写标题"} ·{" "}
                    {version.status === "published" ? "已发布" : "草稿"} ·{" "}
                    {version.createdAt}
                  </option>
                ))}
              </select>
            </label>
            <div className={styles.pager}>
              <span>
                第 {history.page} / {Math.max(1, history.totalPages)} 页
              </span>
              <Button
                buttonStyle="secondary"
                disabled={busy || history.page <= 1}
                onClick={() => void loadHistory(history.id, history.page - 1)}
              >
                较新版本
              </Button>
              <Button
                buttonStyle="secondary"
                disabled={busy || history.page >= history.totalPages}
                onClick={() => void loadHistory(history.id, history.page + 1)}
              >
                较早版本
              </Button>
            </div>
            <div className={styles.actions}>
              <Button
                disabled={busy || !versionId}
                onClick={() => void restore()}
              >
                恢复为新草稿
              </Button>
              <Button
                buttonStyle="secondary"
                onClick={() => {
                  setHistory(null);
                  setVersionId("");
                }}
              >
                取消
              </Button>
            </div>
          </fieldset>
        )}
      </div>
    </Gutter>
  );
};
