import Link from "next/link";
import type { ServerProps } from "payload";

import {
  actionLabels,
  formatTime,
  policyLabels,
  subjectKindLabels,
} from "./api";
import { operatorWorkSubmissionPageSchema } from "@moya/contracts/internal/community-operator";

import { callCommunityOperator } from "./backend";
import styles from "./community.module.css";

import type { ModerationSummary } from "@moya/contracts/internal/community-operator";

/**
 * The Owner's workspace card: direct Community access plus a few real
 * operational numbers from the Backend summary (pending count, current
 * publication mode, recent actions). No charts, nothing fabricated; when the
 * Backend is unreachable the card says so. It also shows the
 * pending work submission total from a one-row queue read checked against the
 * operator contract, or nothing when that read fails or does not match.
 */
export const CommunityDashboardCard = async ({ user }: ServerProps) => {
  if (user?.collection !== "users" || user.role !== "owner") return null;
  let summary: ModerationSummary | null = null;
  let problem: string | null = null;
  const [summaryResult, submissionsResult] = await Promise.allSettled([
    callCommunityOperator<ModerationSummary>("GET", "summary?range=7d"),
    callCommunityOperator<unknown>(
      "GET",
      "publishing/submissions?state=pending&page=1&pageSize=1",
    ),
  ]);
  if (summaryResult.status === "fulfilled") summary = summaryResult.value;
  else problem = "社区后端未连接或暂时不可用；队列与设置暂不可读。";
  const submissions =
    submissionsResult.status === "fulfilled" && submissionsResult.value !== null
      ? operatorWorkSubmissionPageSchema.safeParse(submissionsResult.value)
      : null;
  const pendingSubmissions =
    submissions?.success === true ? submissions.data.total : null;
  return (
    <section
      aria-labelledby="community-card-title"
      className={styles.card}
      data-community-card=""
    >
      <h2 id="community-card-title">社区</h2>
      {summary === null ? (
        <p className={styles.notice} data-tone="error" role="status">
          {problem}
        </p>
      ) : (
        <>
          <ul className={styles.stats}>
            <li>
              <strong data-card-pending="">{summary.queue.pending}</strong>
              <span>待审核（根评论与回复）</span>
            </li>
            {pendingSubmissions === null ? null : (
              <li>
                <strong data-card-pending-work-submissions="">
                  {pendingSubmissions}
                </strong>
                <span>待审核作品提交</span>
              </li>
            )}
            <li>
              <strong>{policyLabels[summary.policy.policy]}</strong>
              <span>当前评论发布模式</span>
            </li>
            <li>
              <strong>
                {summary.actions.approve +
                  summary.actions.reject +
                  summary.actions.hide +
                  summary.actions.unhide}
              </strong>
              <span>近 7 天审核操作次数</span>
            </li>
          </ul>
          {summary.recentEvents.length === 0 ? (
            <p className={styles.secondary}>近期没有操作记录。</p>
          ) : (
            <ol className={styles.timeline}>
              {summary.recentEvents.slice(0, 5).map((event) => (
                <li key={event.id}>
                  <time dateTime={event.occurredAt}>
                    {formatTime(event.occurredAt)}
                  </time>
                  <span>
                    {actionLabels[event.action]} ·{" "}
                    {subjectKindLabels[event.subjectKind]} ·{" "}
                    {event.operatorLabel}
                  </span>
                </li>
              ))}
            </ol>
          )}
          <p className={styles.secondary}>
            统计截至 {formatTime(summary.generatedAt)}（北京时间）；
            {summary.analysis.connected
              ? "机器分析已接入。"
              : "未接入机器分析。"}
          </p>
        </>
      )}
      <div className={styles.links}>
        <Link href="/admin/community-moderation">评论审核队列</Link>
        <Link href="/admin/community-moderation/work-submissions">
          作品提交审核
        </Link>
        <Link href="/admin/community-moderation/content">作品与推荐</Link>
        <Link href="/admin/community-moderation/account-capacity">
          账号容量
        </Link>
        <Link href="/admin/community-moderation/publishing-jobs">发布任务</Link>
        <Link href="/admin/community-moderation/settings">发布设置</Link>
        <Link href="/admin/community-moderation/history">操作历史</Link>
      </div>
    </section>
  );
};
