"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ConfirmationModal, SetStepNav, useModal } from "@payloadcms/ui";

import {
  TIME_ZONE_NOTE,
  UNTITLED_WORK,
  authorshipLabel,
  call,
  describeFailure,
  describeFinalFailure,
  excerpt,
  formatPreciseTime,
  formatTime,
  mediaStateLabels,
  outcomeUnknown,
  policyLabels,
  qualityModeLabels,
  shortId,
  submissionActionLabels,
  submissionDoneLabels,
  submissionStateLabels,
  userStatusLabels,
  workStateLabels,
  workSubmissionMediaSrc,
} from "./api";
import styles from "./community.module.css";
import { ModerationReasonInput, readModerationReason } from "./bulk-actions";
import {
  coverPreview,
  itemPreviewVariant,
  submissionDecidable,
  submissionUndecidableReason,
  submissionVariantKey,
} from "./work-publishing-rules";

import type {
  OperatorSubmissionMedia,
  OperatorWorkSubmission,
  OperatorWorkSubmissionPage,
  WorkPublishingSettings,
  WorkSubmissionModerationAction,
  WorkSubmissionModerationResult,
  WorkSubmissionQueueState,
} from "./api";

interface Notice {
  readonly tone: "success" | "error" | "info";
  readonly text: string;
}

interface Decision {
  readonly item: OperatorWorkSubmission;
  readonly action: WorkSubmissionModerationAction;
  readonly requestId: string;
  readonly reason: string;
}

type Detail =
  | { readonly state: "loading"; readonly id: string }
  | {
      readonly state: "ready";
      readonly id: string;
      readonly data: OperatorWorkSubmission;
    }
  | { readonly state: "error"; readonly id: string; readonly text: string };

const states: readonly WorkSubmissionQueueState[] = [
  "pending",
  "approved",
  "rejected",
  "superseded",
  "withdrawn",
];
const PAGE_SIZE = 20;
const CONFIRM_SLUG = "community-work-submission-confirm";
const revisionIdPattern = /^work-revision-[0-9a-f]{32}$/u;

/** The queue state lives in the URL, so back, reload and direct entry agree. */
const readQuery = (params: URLSearchParams) => {
  const state = params.get("state");
  const page = Number(params.get("page") ?? "1");
  const item = params.get("item");
  return {
    state: states.includes(state as WorkSubmissionQueueState)
      ? (state as WorkSubmissionQueueState)
      : "pending",
    page: Number.isInteger(page) && page >= 1 && page <= 10_000 ? page : 1,
    item: item !== null && revisionIdPattern.test(item) ? item : null,
  } as const;
};

type Query = ReturnType<typeof readQuery>;

const writeQuery = (query: Query): string => {
  const params = new URLSearchParams();
  if (query.state !== "pending") params.set("state", query.state);
  if (query.page !== 1) params.set("page", String(query.page));
  if (query.item !== null) params.set("item", query.item);
  const encoded = params.toString();
  return encoded === "" ? "" : `?${encoded}`;
};

const chipState = (state: WorkSubmissionQueueState): string =>
  state === "pending" ? "pending" : state === "approved" ? "visible" : "hidden";

const StateChip = ({ state }: { readonly state: WorkSubmissionQueueState }) => (
  <span className={styles.chip} data-state={chipState(state)}>
    {submissionStateLabels[state]}
  </span>
);

const titleOf = (item: OperatorWorkSubmission): string =>
  item.title === "" ? UNTITLED_WORK : item.title;

const capacityHref = (accountId: string): string =>
  `/admin/community-moderation/account-capacity?account=${encodeURIComponent(accountId)}`;

/**
 * The work submission queue: explicit, immutable submissions that requested
 * public visibility. Autosaves, drafts and self-only submissions never reach
 * it. Only the latest pending submission of a work can be approved or
 * rejected, against the version the Owner looked at; a stale view is a
 * conflict that refreshes instead of retrying.
 */
export const WorkSubmissionsQueueClient = () => {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const query = useMemo(() => readQuery(searchParams), [searchParams]);
  const { openModal, closeModal } = useModal();

  const [page, setPage] = useState<OperatorWorkSubmissionPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [settings, setSettings] = useState<WorkPublishingSettings | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [receipt, setReceipt] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<Decision | null>(null);
  const [reasonDraft, setReasonDraft] = useState("");
  const reason = readModerationReason(reasonDraft);
  const [retry, setRetry] = useState<Decision | null>(null);
  const lock = useRef(false);
  const listSequence = useRef(0);
  const detailSequence = useRef(0);
  const panel = useRef<HTMLElement | null>(null);
  // The latest URL state: a reload after a decision lists and details what is
  // on screen now, never the tab, page or item the decision started from.
  const queryRef = useRef(query);
  useEffect(() => {
    queryRef.current = query;
  }, [query]);

  const navigate = useCallback(
    (patch: Partial<Query>, mode: "replace" | "push" = "replace") => {
      const href = `${pathname}${writeQuery({ ...query, ...patch })}`;
      if (mode === "push") router.push(href, { scroll: false });
      else router.replace(href, { scroll: false });
    },
    [pathname, query, router],
  );

  // A newer request always wins; a slow older answer never replaces it.
  const load = useCallback(async () => {
    const sequence = (listSequence.current += 1);
    const { state, page: pageNumber } = queryRef.current;
    const current = () =>
      sequence === listSequence.current &&
      queryRef.current.state === state &&
      queryRef.current.page === pageNumber;
    setLoading(true);
    try {
      const result = await call<OperatorWorkSubmissionPage>(
        "read-work-submissions",
        { state, page: pageNumber, pageSize: PAGE_SIZE },
      );
      if (!current()) return;
      setPage(result);
      setLoadError(null);
    } catch (failure) {
      if (!current()) return;
      setLoadError(describeFailure(failure).text);
    } finally {
      if (sequence === listSequence.current) setLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    const sequence = (detailSequence.current += 1);
    const current = () =>
      sequence === detailSequence.current && queryRef.current.item === id;
    setDetail((shown) =>
      shown?.id === id && shown.state === "ready"
        ? shown
        : { state: "loading", id },
    );
    try {
      const data = await call<OperatorWorkSubmission>("read-work-submission", {
        id,
      });
      if (current()) setDetail({ state: "ready", id, data });
    } catch (failure) {
      if (current())
        setDetail({ state: "error", id, text: describeFailure(failure).text });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, query.state, query.page]);

  useEffect(() => {
    if (query.item === null) {
      detailSequence.current += 1;
      setDetail(null);
      return;
    }
    void loadDetail(query.item);
  }, [query.item, loadDetail]);

  useEffect(() => {
    if (query.item === null) return;
    // Below the two-column width the panel follows the whole list.
    panel.current?.focus();
    panel.current?.scrollIntoView({ block: "start" });
  }, [query.item]);

  useEffect(() => {
    void call<WorkPublishingSettings>("read-work-publishing-settings")
      .then(setSettings)
      .catch(() => setSettings(null));
  }, []);

  const refresh = async (id: string) => {
    await Promise.all([
      load(),
      queryRef.current.item === id ? loadDetail(id) : Promise.resolve(),
    ]);
  };

  const decide = async (decision: Decision) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    const { item, action, requestId } = decision;
    const label = `「${titleOf(item)}」第 ${item.sequence} 次提交`;
    try {
      const result = await call<WorkSubmissionModerationResult>(
        "moderate-work-submission",
        {
          id: item.revisionId,
          requestId,
          action,
          expectedVersion: item.version,
          reason: decision.reason,
        },
      );
      setRetry(null);
      setReceipt({
        tone: "success",
        text: `${submissionDoneLabels[action]}：${label}（${shortId(result.revisionId)}）。`,
      });
      await refresh(item.revisionId);
    } catch (failure) {
      const { code, text } = describeFailure(failure);
      if (outcomeUnknown(failure)) {
        // Outcome unknown: the same request identity may be re-sent safely.
        setRetry(decision);
        setReceipt({
          tone: "error",
          text: `${submissionActionLabels[action]}结果未确认（${label}）：${text}`,
        });
      } else {
        setRetry(null);
        setReceipt({
          tone: "error",
          text:
            code === "STATE_CONFLICT"
              ? `${submissionActionLabels[action]}未执行（${label}）：该提交已变化——可能已被处理、已有作者的更新提交，或作品状态已改变。已刷新列表与详情，请重新检查后再决定。`
              : code === "OPERATOR_RESPONSE_INVALID"
                ? `${submissionActionLabels[action]}结果无法确认（${label}）：${text}已刷新列表与详情。`
                : `${submissionActionLabels[action]}未执行（${label}）：${describeFinalFailure(failure)}`,
        });
        await refresh(item.revisionId);
      }
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };

  const ask = (
    item: OperatorWorkSubmission,
    action: WorkSubmissionModerationAction,
  ) => {
    if (reason === null) return;
    setConfirmation({ item, action, requestId: crypto.randomUUID(), reason });
    openModal(CONFIRM_SLUG);
  };

  const renderActions = (item: OperatorWorkSubmission, compact: boolean) => (
    <div className={styles.actions}>
      {compact ? (
        <button
          className={styles.actionButton}
          onClick={() => navigate({ item: item.revisionId }, "push")}
          type="button"
        >
          查看
        </button>
      ) : null}
      {submissionDecidable(item) ? (
        <>
          <button
            className={styles.actionButton}
            data-primary="true"
            data-submission-action="approve"
            disabled={busy || retry !== null || reason === null}
            onClick={() => ask(item, "approve")}
            type="button"
          >
            通过并公开…
          </button>
          <button
            className={styles.actionButton}
            data-danger="true"
            data-submission-action="reject"
            disabled={busy || retry !== null || reason === null}
            onClick={() => ask(item, "reject")}
            type="button"
          >
            拒绝…
          </button>
        </>
      ) : submissionUndecidableReason(item) === null ? null : (
        <span className={styles.secondary}>
          {submissionUndecidableReason(item)}
        </span>
      )}
    </div>
  );

  const pendingDecision = confirmation;

  return (
    <div className={styles.workspace}>
      <SetStepNav
        nav={[
          { label: "社区", url: "/admin/community-moderation" },
          { label: "作品提交审核" },
        ]}
      />
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>作品提交审核</h1>
          <p className={styles.lead}>
            只包含作者明确提交并请求公开的不可变版本；自动保存的草稿和仅自己可见的提交不会出现在这里。
            {TIME_ZONE_NOTE}。<Link href="/admin">返回工作台</Link>
          </p>
        </div>
        <div className={styles.summaryLine} data-work-policy-summary="">
          <span>
            当前作品发布模式：
            <strong>
              {settings === null ? "读取中…" : policyLabels[settings.policy]}
            </strong>
          </span>
          <Link href="/admin/community-moderation/settings">发布设置</Link>
        </div>
      </header>

      {settings?.policy === "DIRECT_PUBLICATION" ? (
        <p className={styles.notice} data-tone="info">
          当前为直接发布：新的公开提交会直接公开，不再进入此队列；切换前已进入待审核的提交仍需在这里处理。
        </p>
      ) : null}

      <ModerationReasonInput
        label="作品审核理由（必填）"
        value={reasonDraft}
        onChange={setReasonDraft}
        disabled={busy || retry !== null}
      />
      <div aria-label="提交状态" className={styles.tabs} role="tablist">
        {states.map((state) => (
          <button
            aria-busy={loading && query.state === state}
            aria-controls="community-work-submission-list"
            aria-selected={query.state === state}
            className={styles.tab}
            key={state}
            onClick={() => navigate({ state, page: 1, item: null })}
            role="tab"
            type="button"
          >
            {submissionStateLabels[state]}
            {query.state === state && page !== null ? (
              <span className={styles.count}>{page.total}</span>
            ) : null}
          </button>
        ))}
      </div>

      {receipt === null ? null : (
        <p className={styles.receipt} data-tone={receipt.tone} role="status">
          {receipt.text}
          {retry === null ? null : (
            <>
              {" "}
              <button
                className={styles.rowLink}
                disabled={busy}
                onClick={() => void decide(retry)}
                type="button"
              >
                重试同一操作
              </button>
              {" · "}
              <button
                className={styles.rowLink}
                disabled={busy}
                onClick={() => {
                  setRetry(null);
                  void refresh(retry.item.revisionId);
                }}
                type="button"
              >
                放弃并刷新
              </button>
            </>
          )}
        </p>
      )}

      <div
        className={styles.layout}
        data-panel-open={query.item === null ? "false" : "true"}
      >
        <section
          aria-busy={loading}
          aria-label="作品提交"
          data-work-submission-list=""
          id="community-work-submission-list"
        >
          {loadError !== null ? (
            <p className={styles.state} role="alert">
              无法读取作品提交：{loadError}{" "}
              <button
                className={styles.rowLink}
                onClick={() => void load()}
                type="button"
              >
                重试
              </button>
            </p>
          ) : page === null ? (
            <p className={styles.state} role="status">
              正在读取…
            </p>
          ) : page.items.length === 0 ? (
            <p className={styles.state}>
              {query.state === "pending"
                ? "暂无待审核的作品提交。"
                : "没有符合条件的作品提交。"}
            </p>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">作品</th>
                    <th scope="col">作者</th>
                    <th scope="col">提交</th>
                    <th scope="col">状态</th>
                    <th scope="col">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {page.items.map((item) => (
                    <tr
                      data-current={query.item === item.revisionId}
                      data-work-submission-row={item.revisionId}
                      key={item.revisionId}
                    >
                      <td>
                        <button
                          className={styles.rowLink}
                          onClick={() =>
                            navigate({ item: item.revisionId }, "push")
                          }
                          type="button"
                        >
                          {item.title === "" ? (
                            <em>{UNTITLED_WORK}</em>
                          ) : (
                            <strong>{item.title}</strong>
                          )}
                        </button>
                        {item.body === "" ? null : (
                          <p className={styles.excerpt}>
                            {excerpt(item.body, 80)}
                          </p>
                        )}
                        <span className={styles.secondary}>
                          {item.items.length === 0
                            ? "纯文字"
                            : `${item.items.length} 项媒体`}
                          {" · "}
                          {authorshipLabel(item.authorship)}
                        </span>
                      </td>
                      <td>
                        {item.author.displayName}
                        <span className={styles.secondary}>
                          @{item.author.handle}
                          {item.author.status === "active" ? null : (
                            <>
                              {" "}
                              <span
                                className={styles.chip}
                                data-state={item.author.status}
                              >
                                账号{userStatusLabels[item.author.status]}
                              </span>
                            </>
                          )}
                        </span>
                      </td>
                      <td>
                        {item.origin === "legacy"
                          ? "早期作品"
                          : `第 ${item.sequence} 次提交`}
                        <span className={styles.secondary}>
                          <time dateTime={item.submittedAt}>
                            {formatTime(item.submittedAt)}
                          </time>
                        </span>
                      </td>
                      <td>
                        <StateChip state={item.disposition} />
                        <span className={styles.secondary}>
                          {item.latest ? "最新提交" : "较早的提交"}
                          {item.workState === "visible"
                            ? ""
                            : ` · ${workStateLabels[item.workState]}`}
                          {item.workTrashed ? " · 作品在回收站" : ""}
                        </span>
                      </td>
                      <td>{renderActions(item, true)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {page === null ? null : (
            <div className={styles.pager}>
              <span>
                共 {page.total} 条 · 第 {page.total === 0 ? 0 : page.page} /{" "}
                {page.totalPages} 页
              </span>
              <div className={styles.actions}>
                <button
                  className={styles.actionButton}
                  disabled={page.page <= 1 || loading}
                  onClick={() => navigate({ page: query.page - 1 })}
                  type="button"
                >
                  上一页
                </button>
                <button
                  className={styles.actionButton}
                  disabled={page.page >= page.totalPages || loading}
                  onClick={() => navigate({ page: query.page + 1 })}
                  type="button"
                >
                  下一页
                </button>
              </div>
            </div>
          )}
        </section>

        {query.item === null ? null : (
          <aside
            aria-labelledby="community-work-submission-title"
            className={styles.panel}
            data-work-submission-detail=""
            ref={panel}
            tabIndex={-1}
          >
            <div className={styles.panelHeader}>
              <h2 id="community-work-submission-title">提交详情</h2>
              <button
                className={styles.iconButton}
                onClick={() => navigate({ item: null })}
                type="button"
              >
                关闭
              </button>
            </div>
            {detail === null || detail.state === "loading" ? (
              <p role="status">正在读取详情…</p>
            ) : detail.state === "error" ? (
              <p className={styles.notice} data-tone="error" role="alert">
                {detail.text}{" "}
                <button
                  className={styles.rowLink}
                  onClick={() => void loadDetail(detail.id)}
                  type="button"
                >
                  重试
                </button>
              </p>
            ) : (
              <SubmissionDetail
                // A new submission (or a refreshed version) resets the preview.
                key={`${detail.data.revisionId}:${detail.data.version}`}
                data={detail.data}
                actions={renderActions(detail.data, false)}
              />
            )}
          </aside>
        )}
      </div>

      <ConfirmationModal
        body={
          pendingDecision === null ? (
            <p />
          ) : (
            <div>
              <p>
                将对「{titleOf(pendingDecision.item)}」（@
                {pendingDecision.item.author.handle}）第{" "}
                {pendingDecision.item.sequence} 次提交执行「
                {submissionActionLabels[pendingDecision.action]}」。
              </p>
              <p>
                {pendingDecision.action === "approve"
                  ? "通过后，这个版本成为该作品的公开版本，作品可见时其他人立即看到它；作品身份、讨论、点赞收藏和首次发布时间保持不变。"
                  : "拒绝后，这个版本不会公开；作品已有的公开版本（如有）继续对其他人显示，作者仍能看到自己的最新内容。"}
              </p>
              {pendingDecision.item.workState !== "visible" ? (
                <p>
                  注意：{workStateLabels[pendingDecision.item.workState]}
                  。审核决定不会解除作者或 Owner 的隐藏与移除状态。
                </p>
              ) : null}
              <p className={styles.reportText}>
                处置理由：{pendingDecision.reason}
              </p>
              <p>
                只针对你查看时的版本（版本号 {pendingDecision.item.version}
                ）；若期间已有新的提交或其他处理，本次操作不会执行。
              </p>
            </div>
          )
        }
        cancelLabel="取消"
        confirmLabel={
          pendingDecision?.action === "reject" ? "确认拒绝" : "确认通过"
        }
        confirmingLabel="处理中…"
        heading={
          pendingDecision?.action === "reject"
            ? "确认拒绝作品提交"
            : "确认通过作品提交"
        }
        modalSlug={CONFIRM_SLUG}
        onCancel={() => setConfirmation(null)}
        onConfirm={async () => {
          closeModal(CONFIRM_SLUG);
          if (confirmation !== null) await decide(confirmation);
          setConfirmation(null);
        }}
      />
    </div>
  );
};

const editSummary = (item: OperatorSubmissionMedia): string =>
  [
    item.edit.rotation === 0 ? null : `旋转 ${item.edit.rotation}°`,
    item.edit.crop === null ? null : "已裁切",
  ]
    .filter((part) => part !== null)
    .join("，");

const mediaLabel = (item: OperatorSubmissionMedia): string =>
  `第 ${item.position} 项${item.kind === "live" ? "（实况照片静态画面）" : ""}`;

export const SubmissionDetail = ({
  data,
  actions,
}: {
  readonly data: OperatorWorkSubmission;
  readonly actions: React.ReactNode;
}) => {
  const [selected, setSelected] = useState<number | null>(
    data.items[0]?.position ?? null,
  );
  const selectedItem =
    data.items.find((item) => item.position === selected) ?? null;
  return (
    <>
      <div>
        <h3>状态</h3>
        <StateChip state={data.disposition} />{" "}
        <span className={styles.chip} data-state="kind">
          {data.latest ? "最新提交" : "较早的提交"}
        </span>
        <span className={styles.secondary}>
          {data.origin === "legacy" ? "早期作品" : `第 ${data.sequence} 次提交`}
          {" · "}提交于{" "}
          <time dateTime={data.submittedAt}>
            {formatPreciseTime(data.submittedAt)}
          </time>
        </span>
        {data.decidedAt === null ? null : (
          <span className={styles.secondary}>
            由 {data.decidedBy ?? "系统"} 于{" "}
            <time dateTime={data.decidedAt}>
              {formatPreciseTime(data.decidedAt)}
            </time>{" "}
            处理
          </span>
        )}
        {data.workState !== "visible" || data.workTrashed ? (
          <p className={styles.notice} data-tone="info">
            {data.workTrashed ? "作品目前在回收站。" : ""}
            {data.workState === "visible"
              ? ""
              : `${workStateLabels[data.workState]}。`}
          </p>
        ) : null}
      </div>
      {actions}
      <div>
        <h3>提交时请求的可见范围</h3>
        <p className={styles.excerpt}>
          公开。实际展示仍取决于作品当前可见范围、审核结果和管理状态。
        </p>
      </div>
      <div>
        <h3>标题</h3>
        {data.title === "" ? (
          <p className={styles.secondary}>{UNTITLED_WORK}（作者未填写标题）</p>
        ) : (
          <p className={styles.fullText} data-submission-title="">
            {data.title}
          </p>
        )}
      </div>
      <div>
        <h3>正文</h3>
        {data.body === "" ? (
          <p className={styles.secondary}>（无正文）</p>
        ) : (
          <p className={styles.fullText} data-submission-body="">
            {data.body}
          </p>
        )}
      </div>
      <div>
        <h3>作品性质</h3>
        <p className={styles.excerpt}>{authorshipLabel(data.authorship)}</p>
        {data.authorship === null ||
        data.authorship.kind === "original" ? null : (
          <dl className={styles.contextBox}>
            <dt className={styles.secondary}>参考作品</dt>
            <dd className={styles.excerpt}>
              {data.authorship.referenceTitle ?? "（未填写）"}
            </dd>
            <dt className={styles.secondary}>原作者</dt>
            <dd className={styles.excerpt}>
              {data.authorship.originalAuthor ?? "（未填写）"}
            </dd>
            <dt className={styles.secondary}>来源</dt>
            <dd className={styles.fullText}>
              {data.authorship.sourceNote ?? "（未填写）"}
            </dd>
          </dl>
        )}
      </div>
      <div>
        <h3>封面</h3>
        <CoverPreview data={data} />
      </div>
      <div>
        <h3>媒体（{data.items.length} 项，按作者排列顺序）</h3>
        {data.items.length === 0 ? (
          <p className={styles.secondary}>纯文字作品，没有媒体。</p>
        ) : (
          <>
            <ol className={styles.mediaGrid}>
              {data.items.map((item) => (
                <MediaTile
                  data={data}
                  item={item}
                  isCover={item.itemId === data.coverItemId}
                  key={item.itemId}
                  onSelect={() => setSelected(item.position)}
                  selected={item.position === selected}
                />
              ))}
            </ol>
            {selectedItem === null ? null : (
              <MediaPreview
                data={data}
                item={selectedItem}
                key={selectedItem.itemId}
              />
            )}
          </>
        )}
      </div>
      <div>
        <h3>作者</h3>
        {data.author.displayName}
        <span className={styles.secondary}>
          @{data.author.handle}
          {data.author.status === "active"
            ? ""
            : ` · 账号${userStatusLabels[data.author.status]}`}
        </span>
        <span className={`${styles.secondary} ${styles.mono}`}>
          {data.author.id}
        </span>
        <span className={styles.secondary}>
          <Link href={capacityHref(data.author.id)}>查看该账号容量</Link>
        </span>
      </div>
      <div>
        <h3>标识</h3>
        <span className={`${styles.secondary} ${styles.mono}`}>
          作品 {data.workId}
        </span>
        <span className={`${styles.secondary} ${styles.mono}`}>
          提交 {data.revisionId} · 版本 {data.version}
        </span>
        <span className={styles.secondary}>
          <Link
            href={`/admin/community-moderation/content?q=${encodeURIComponent(data.workId)}`}
          >
            在作品管理中查看
          </Link>
        </span>
      </div>
    </>
  );
};

/** Why an item shows no still: its state, a legacy image without derivatives, or none rendered yet. */
const noPreviewText = (item: OperatorSubmissionMedia): string =>
  item.qualityMode === "legacy"
    ? "早期作品图片当前没有可用预览"
    : item.state === "ready"
      ? "暂无可用预览"
      : `${mediaStateLabels[item.state]}，暂无预览`;

const CoverPreview = ({ data }: { readonly data: OperatorWorkSubmission }) => {
  const [broken, setBroken] = useState(false);
  if (data.items.length === 0)
    return (
      <p className={styles.secondary}>纯文字作品：卡片显示正文，没有封面图。</p>
    );
  const cover = coverPreview(data);
  if (cover === null)
    return <p className={styles.secondary}>封面媒体不在本次提交中。</p>;
  const { item, chosen, preview } = cover;
  return (
    <>
      {preview === null || broken ? (
        <p className={styles.secondary}>
          封面为第 {item.position} 项；
          {broken ? "预览无法加载。" : `${noPreviewText(item)}。`}
        </p>
      ) : (
        <span className={styles.coverFrame} data-submission-cover="">
          <img
            alt={`封面（第 ${item.position} 项）`}
            decoding="async"
            onError={() => setBroken(true)}
            referrerPolicy="no-referrer"
            src={workSubmissionMediaSrc(
              data.revisionId,
              item.itemId,
              preview.variant,
              preview.editKey,
            )}
          />
          {/* The cover crop is normalized to the edited image; over the
              uncropped display still it is drawn as an outline. */}
          {preview.outline && data.coverCrop !== null ? (
            <span
              aria-hidden="true"
              className={styles.cropMark}
              data-submission-cover-crop=""
              style={{
                left: `${data.coverCrop.x * 100}%`,
                top: `${data.coverCrop.y * 100}%`,
                width: `${data.coverCrop.width * 100}%`,
                height: `${data.coverCrop.height * 100}%`,
              }}
            />
          ) : null}
        </span>
      )}
      <span className={styles.secondary}>
        {chosen
          ? `封面为作者选择的第 ${item.position} 项`
          : `作者未单独选择封面，卡片使用第 ${item.position} 项`}
        {data.coverCrop === null
          ? "，未单独裁切"
          : preview?.outline === true
            ? "，框内为作者选择的封面裁切区域"
            : "，已按作者的封面裁切"}
        。
      </span>
    </>
  );
};

const MediaTile = ({
  data,
  item,
  isCover,
  selected,
  onSelect,
}: {
  readonly data: OperatorWorkSubmission;
  readonly item: OperatorSubmissionMedia;
  readonly isCover: boolean;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) => {
  const [broken, setBroken] = useState(false);
  const variant = itemPreviewVariant(data, item, "tile");
  const edits = editSummary(item);
  return (
    <li className={styles.mediaTile} data-submission-media={item.position}>
      <button
        aria-label={`预览${mediaLabel(item)}`}
        aria-pressed={selected}
        className={styles.rowLink}
        onClick={onSelect}
        type="button"
      >
        <span
          className={styles.mediaFrame}
          data-current={selected ? "true" : "false"}
        >
          <span className={styles.mediaOrder}>{item.position}</span>
          {variant === null || broken ? (
            <span>
              {broken
                ? "预览无法加载"
                : item.qualityMode === "legacy"
                  ? "早期图片"
                  : "暂无预览"}
            </span>
          ) : (
            <img
              alt={mediaLabel(item)}
              decoding="async"
              loading="lazy"
              onError={() => setBroken(true)}
              referrerPolicy="no-referrer"
              src={workSubmissionMediaSrc(
                data.revisionId,
                item.itemId,
                variant,
                submissionVariantKey(data, item, variant) ?? item.editKey,
              )}
            />
          )}
          {item.kind === "live" ? (
            <span className={styles.mediaBadge}>LIVE</span>
          ) : null}
        </span>
      </button>
      <span className={styles.secondary}>
        {qualityModeLabels[item.qualityMode]}
        {item.state === "ready" ? "" : ` · ${mediaStateLabels[item.state]}`}
        {isCover ? " · 封面" : ""}
        {edits === "" ? "" : ` · ${edits}`}
      </span>
    </li>
  );
};

/** A larger still, and the motion part of a Live item only on explicit play, muted first. */
const MediaPreview = ({
  data,
  item,
}: {
  readonly data: OperatorWorkSubmission;
  readonly item: OperatorSubmissionMedia;
}) => {
  const [playing, setPlaying] = useState(false);
  const [broken, setBroken] = useState(false);
  const variant = itemPreviewVariant(data, item, "preview");
  const motion = item.kind === "live" && item.variants.includes("motion");
  const src = (name: OperatorSubmissionMedia["variants"][number]) =>
    workSubmissionMediaSrc(
      data.revisionId,
      item.itemId,
      name,
      submissionVariantKey(data, item, name) ?? item.editKey,
    );
  return (
    <div className={styles.contextBox} data-submission-preview={item.position}>
      {playing && motion ? (
        <video
          aria-label={`第 ${item.position} 项的实况动态部分`}
          autoPlay
          className={styles.previewMedia}
          controls
          muted
          onError={() => setBroken(true)}
          playsInline
          preload="metadata"
          src={src("motion")}
        />
      ) : variant === null ? (
        <p className={styles.secondary}>
          第 {item.position} 项{noPreviewText(item)}。
        </p>
      ) : (
        <img
          alt={mediaLabel(item)}
          className={styles.previewMedia}
          decoding="async"
          onError={() => setBroken(true)}
          referrerPolicy="no-referrer"
          src={src(variant)}
        />
      )}
      {broken ? (
        <p className={styles.secondary}>
          {playing ? "动态影像无法播放。" : "预览无法加载。"}
        </p>
      ) : null}
      {item.kind === "live" && !motion && item.qualityMode !== "legacy" ? (
        <p className={styles.secondary} data-submission-motion-missing="">
          {item.state === "ready"
            ? "这项实况照片的动态部分暂无可播放的预览；审核时只能查看静态画面。"
            : "这项实况照片尚未处理完成，动态部分暂无预览。"}
        </p>
      ) : null}
      <span className={styles.secondary}>
        第 {item.position} 项 · {item.kind === "live" ? "实况照片" : "静态图片"}{" "}
        · {qualityModeLabels[item.qualityMode]}
        {item.presentation === null
          ? ""
          : ` · ${item.presentation.width}×${item.presentation.height}`}
        {item.presentation?.durationMs === undefined
          ? ""
          : ` · ${(item.presentation.durationMs / 1000).toFixed(1)} 秒`}
        {item.presentation?.hasAudio === true ? " · 含声音" : ""}
      </span>
      <div className={styles.actions}>
        {motion ? (
          <button
            className={styles.actionButton}
            onClick={() => {
              setBroken(false);
              setPlaying((current) => !current);
            }}
            type="button"
          >
            {playing ? "显示静态画面" : "播放实况"}
          </button>
        ) : null}
        {item.variants.includes("display") ? (
          <a
            className={styles.rowLink}
            href={src("display")}
            rel="noopener noreferrer"
            target="_blank"
          >
            新窗口查看大图
          </a>
        ) : null}
      </div>
    </div>
  );
};
