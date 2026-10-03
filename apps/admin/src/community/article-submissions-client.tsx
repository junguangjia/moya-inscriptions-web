"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ConfirmationModal, SetStepNav, useModal } from "@payloadcms/ui";
import type {
  ArticlePendingPage,
  ArticlePendingPreview,
  ArticleModerationResult,
  ModerateArticlePendingCommand,
} from "./api";
import {
  call,
  describeFailure,
  describeFinalFailure,
  formatPreciseTime,
  outcomeUnknown,
} from "./api";
import { ArticleSubmissionPreview } from "./article-submission-preview";
import styles from "./community.module.css";

const CONFIRM = "community-article-submission-confirm";
type Decision = {
  readonly item: ArticlePendingPreview;
  readonly command: ModerateArticlePendingCommand;
};

/** Current pending submissions only. Every decision pins the reviewed immutable candidate. */
export const ArticleSubmissionsQueueClient = () => {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const { openModal, closeModal } = useModal();
  const rawCursor = params.get("cursor");
  const cursor =
    rawCursor !== null && /^[A-Za-z0-9_-]{1,512}$/u.test(rawCursor)
      ? rawCursor
      : undefined;
  const rawItem = params.get("item");
  const item =
    rawItem !== null && /^article-[0-9a-f]{32}$/u.test(rawItem)
      ? rawItem
      : null;
  const [page, setPage] = useState<ArticlePendingPage | null>(null);
  const [detail, setDetail] = useState<ArticlePendingPreview | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [previewReady, setPreviewReady] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Decision | null>(null);
  const [retry, setRetry] = useState<Decision | null>(null);
  const [revision, setRevision] = useState(0);
  const lock = useRef(false);
  const panel = useRef<HTMLElement | null>(null);
  const currentDetail = useRef(detail);
  currentDetail.current = detail;

  const navigate = (next: {
    cursor?: string | undefined;
    item?: string | null;
  }) => {
    const query = new URLSearchParams();
    if (next.cursor !== undefined) query.set("cursor", next.cursor);
    if (next.item) query.set("item", next.item);
    router.push(`${pathname}${query.size ? `?${query}` : ""}`, {
      scroll: false,
    });
  };
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setPage(null);
    setListError(null);
    void call<ArticlePendingPage>(
      "read-article-submissions",
      { pageSize: 20, ...(cursor === undefined ? {} : { cursor }) },
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) setPage(value);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setListError(describeFailure(error).text);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [cursor, revision]);

  useEffect(() => {
    const controller = new AbortController();
    setDetail(null);
    setPreviewReady(false);
    setDetailError(null);
    setReading(item !== null);
    if (item !== null) {
      void call<ArticlePendingPreview>(
        "read-article-submission",
        { id: item },
        controller.signal,
      )
        .then((value) => {
          if (!controller.signal.aborted) setDetail(value);
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted)
            setDetailError(describeFailure(error).text);
        })
        .finally(() => {
          if (!controller.signal.aborted) setReading(false);
        });
      panel.current?.focus();
      panel.current?.scrollIntoView({ block: "start" });
    }
    return () => controller.abort();
  }, [item, revision]);

  const decide = async (decision: Decision) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      const result = await call<ArticleModerationResult>(
        "moderate-article-submission",
        {
          id: decision.item.articleId,
          ...decision.command,
        },
      );
      setRetry(null);
      setNotice(
        result.disposition === "approved"
          ? "该文章版本已通过并公开。"
          : "该文章版本已拒绝；已有公开版本保持不变。作者可继续编辑后重新提交。",
      );
      refresh();
    } catch (error) {
      if (outcomeUnknown(error)) {
        setRetry(decision);
        setNotice(
          `处理结果尚未确认。${describeFailure(error).text}可用同一次请求确认结果。`,
        );
      } else {
        setRetry(null);
        setNotice(
          describeFailure(error).code === "STATE_CONFLICT"
            ? "待审核版本已变化，本次决定未执行。已刷新列表与详情，请重新检查后决定。"
            : describeFinalFailure(error),
        );
        refresh();
      }
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const ask = (action: ModerateArticlePendingCommand["action"]) => {
    if (
      detail === null ||
      busy ||
      retry !== null ||
      (action === "approve" && !previewReady)
    )
      return;
    setConfirmation({
      item: detail,
      command: {
        requestId: crypto.randomUUID(),
        expectedVersion: detail.expectedVersion,
        candidateVersion: detail.candidateVersion,
        fingerprint: detail.fingerprint,
        action,
      },
    });
    openModal(CONFIRM);
  };

  return (
    <div className={styles.workspace}>
      <SetStepNav nav={[{ label: "作者文章审核" }]} />
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>作者文章审核</h1>
          <p className={styles.lead}>
            审核作者明确提交的文章版本。草稿不会进入队列。
            <Link href="/admin">返回工作台</Link>
          </p>
        </div>
        <button
          type="button"
          className={styles.actionButton}
          disabled={busy}
          onClick={refresh}
        >
          刷新
        </button>
      </header>
      {notice === null ? null : (
        <p className={styles.notice} role="status">
          {notice}
          {retry === null ? null : (
            <button
              type="button"
              disabled={busy}
              onClick={() => void decide(retry)}
            >
              确认上次处理结果
            </button>
          )}
        </p>
      )}
      <div className={styles.layout} data-panel-open={item !== null}>
        <section aria-label="待审核文章">
          {loading ? (
            <p role="status">正在读取待审核文章…</p>
          ) : listError !== null ? (
            <p role="alert">{listError}</p>
          ) : page?.items.length === 0 ? (
            <p className={styles.state}>当前没有待审核文章。</p>
          ) : (
            <ul className={styles.timeline}>
              {page?.items.map((entry) => (
                <li key={entry.articleId}>
                  <button
                    type="button"
                    className={styles.rowLink}
                    aria-current={item === entry.articleId ? "true" : undefined}
                    disabled={busy}
                    onClick={() => navigate({ cursor, item: entry.articleId })}
                  >
                    {entry.title || "未命名文章"}
                  </button>
                  <span>
                    候选版本 {entry.candidateVersion} ·{" "}
                    {formatPreciseTime(entry.submittedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className={styles.pager}>
            {cursor === undefined ? null : (
              <button
                type="button"
                disabled={loading || busy}
                onClick={() => navigate({ item })}
              >
                返回第一页
              </button>
            )}
            {page?.nextCursor ? (
              <button
                type="button"
                disabled={loading || busy}
                onClick={() => navigate({ cursor: page.nextCursor!, item })}
              >
                下一页
              </button>
            ) : null}
          </div>
        </section>
        {item === null ? null : (
          <aside
            className={styles.panel}
            ref={panel}
            tabIndex={-1}
            aria-label="文章提交详情"
          >
            <button
              type="button"
              disabled={busy}
              onClick={() => navigate({ cursor })}
            >
              关闭详情
            </button>
            {reading ? (
              <p role="status">正在读取文章版本…</p>
            ) : detailError !== null ? (
              <p role="alert">{detailError}</p>
            ) : detail === null ? null : (
              <>
                <h2>{detail.title || "未命名文章"}</h2>
                <p>
                  作者：<span className={styles.mono}>{detail.ownerId}</span>
                </p>
                <p>
                  候选版本 {detail.candidateVersion} · 当前版本{" "}
                  {detail.expectedVersion} ·{" "}
                  {formatPreciseTime(detail.submittedAt)}
                </p>
                <ArticleSubmissionPreview
                  key={`${detail.articleId}:${detail.expectedVersion}:${detail.fingerprint}`}
                  candidate={detail}
                  onAvailabilityChange={setPreviewReady}
                />
                <div className={styles.actions}>
                  <button
                    type="button"
                    className={styles.actionButton}
                    data-primary="true"
                    disabled={busy || retry !== null || !previewReady}
                    onClick={() => ask("approve")}
                  >
                    通过并公开…
                  </button>
                  <button
                    type="button"
                    className={styles.actionButton}
                    data-danger="true"
                    disabled={busy || retry !== null}
                    onClick={() => ask("reject")}
                  >
                    拒绝…
                  </button>
                </div>
              </>
            )}
          </aside>
        )}
      </div>
      <ConfirmationModal
        modalSlug={CONFIRM}
        heading={
          confirmation?.command.action === "reject"
            ? "确认拒绝作者文章"
            : "确认通过作者文章"
        }
        cancelLabel="取消"
        confirmLabel={
          confirmation?.command.action === "reject"
            ? "确认拒绝"
            : "确认通过并公开"
        }
        confirmingLabel="处理中…"
        body={
          confirmation === null ? (
            <p />
          ) : (
            <>
              <p>
                「{confirmation.item.title || "未命名文章"}」候选版本{" "}
                {confirmation.command.candidateVersion}。
              </p>
              <p>
                {confirmation.command.action === "approve"
                  ? "这个版本将成为文章的公开版本。"
                  : "这个版本不会公开；已有公开版本保持不变，作者可继续编辑。"}
              </p>
              <p>只处理已查看的精确版本；文章若已变化，本次决定不会执行。</p>
            </>
          )
        }
        onCancel={() => setConfirmation(null)}
        onConfirm={async () => {
          closeModal(CONFIRM);
          const decision = confirmation;
          setConfirmation(null);
          if (
            decision !== null &&
            currentDetail.current === decision.item &&
            (decision.command.action === "reject" || previewReady)
          )
            await decide(decision);
          else setNotice("详情已刷新，请重新检查当前版本后决定。");
        }}
      />
    </div>
  );
};
