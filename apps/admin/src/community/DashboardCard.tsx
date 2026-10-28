import Link from "next/link";
import type { ServerProps } from "payload";
import type { ModerationSummary } from "@moya/contracts/internal/community-operator";
import { operatorWorkSubmissionPageSchema } from "@moya/contracts/internal/community-operator";
import {
  actionLabels,
  formatTime,
  policyLabels,
  subjectKindLabels,
} from "./api";
import { callCommunityOperator } from "./backend";
import { UiIcon } from "../workspace/Icon";

/** Existing reads only. Unavailable totals are never represented as zero. */
export const CommunityDashboardCard = async ({ user }: ServerProps) => {
  if (user?.collection !== "users" || user.role !== "owner") return null;
  const [summaryResult, submissionsResult] = await Promise.allSettled([
    callCommunityOperator<ModerationSummary>("GET", "summary?range=7d"),
    callCommunityOperator<unknown>(
      "GET",
      "publishing/submissions?state=pending&page=1&pageSize=1",
    ),
  ]);
  const summary =
    summaryResult.status === "fulfilled" ? summaryResult.value : null;
  const submissions =
    submissionsResult.status === "fulfilled"
      ? operatorWorkSubmissionPageSchema.safeParse(submissionsResult.value)
      : null;
  const pendingSubmissions = submissions?.success
    ? submissions.data.total
    : null;
  const recentTotal = summary
    ? summary.actions.approve +
      summary.actions.reject +
      summary.actions.hide +
      summary.actions.unhide
    : null;
  return (
    <section
      className="archive-dashboard"
      aria-labelledby="workspace-title"
      data-community-card=""
    >
      <header className="archive-page-heading">
        <div>
          <p className="archive-eyebrow">由于艺 · 管理后台</p>
          <h1 id="workspace-title">工作台</h1>
          <p>整理资料，处理投稿，查看近期操作。</p>
        </div>
        <span className="archive-heading-stamp" aria-hidden="true">
          由于艺
        </span>
      </header>
      <section aria-labelledby="pending-title">
        <h2 id="pending-title">待处理事项</h2>
        <div className="archive-stat-grid">
          <Link
            className="archive-stat"
            href="/admin/community-moderation"
            prefetch={false}
          >
            <UiIcon name="discussion" />
            <span>评论待审核</span>
            <strong data-card-pending="">
              {summary?.queue.pending ?? "—"}
            </strong>
            <span className="archive-stat__hint">
              {summary ? "评论与回复" : "暂时无法读取"}
              <UiIcon name="next" size="sm" />
            </span>
          </Link>
          <Link
            className="archive-stat"
            href="/admin/community-moderation/work-submissions"
            prefetch={false}
          >
            <UiIcon name="image" />
            <span>作品待审核</span>
            <strong data-card-pending-work-submissions="">
              {pendingSubmissions ?? "—"}
            </strong>
            <span className="archive-stat__hint">
              {pendingSubmissions === null ? "暂时无法读取" : "查看作品投稿"}
              <UiIcon name="next" size="sm" />
            </span>
          </Link>
          <Link
            className="archive-stat"
            href="/admin/community-moderation/history"
            prefetch={false}
          >
            <UiIcon name="news" />
            <span>近 7 天审核操作</span>
            <strong>{recentTotal ?? "—"}</strong>
            <span className="archive-stat__hint">
              查看操作记录
              <UiIcon name="next" size="sm" />
            </span>
          </Link>
          <Link
            className="archive-stat archive-stat--policy"
            href="/admin/community-moderation/settings"
            prefetch={false}
          >
            <UiIcon name="settings" />
            <span>评论发布规则</span>
            <strong>
              {summary ? policyLabels[summary.policy.policy] : "—"}
            </strong>
            <span className="archive-stat__hint">
              仅影响后续提交
              <UiIcon name="next" size="sm" />
            </span>
          </Link>
        </div>
        {summary === null || pendingSubmissions === null ? (
          <p className="archive-inline-notice" role="status">
            部分数据暂时无法读取。可以进入对应页面重试；“—”表示数量未知。
          </p>
        ) : null}
      </section>
      <section aria-labelledby="quick-title">
        <h2 id="quick-title">常用操作</h2>
        <div className="archive-quick-grid">
          {(
            [
              [
                "inscriptions",
                "整理资料",
                "碑刻与书法",
                "/admin/collections/catalogs",
              ],
              [
                "image",
                "图片素材",
                "查找与维护图片",
                "/admin/collections/media",
              ],
              [
                "edit",
                "编辑文章",
                "文章与专题内容",
                "/admin/collections/articles",
              ],
              [
                "discussion",
                "举报处理",
                "查看待处理举报",
                "/admin/community-moderation/reports",
              ],
              [
                "message",
                "用户反馈",
                "查看用户意见",
                "/admin/community-moderation/feedback",
              ],
              [
                "loading",
                "发布进度",
                "查看处理结果",
                "/admin/community-moderation/publishing-jobs",
              ],
            ] as const
          ).map(([icon, title, hint, href]) => (
            <Link
              key={href}
              href={href}
              prefetch={false}
              className="archive-quick-link"
            >
              <UiIcon name={icon} />
              <span>
                <strong>{title}</strong>
                <span>{hint}</span>
              </span>
              <UiIcon name="next" size="sm" />
            </Link>
          ))}
        </div>
      </section>
      <section className="archive-recent" aria-labelledby="recent-title">
        <header>
          <h2 id="recent-title">近期操作</h2>
          <Link href="/admin/community-moderation/history" prefetch={false}>
            全部记录
            <UiIcon name="next" size="sm" />
          </Link>
        </header>
        {summary === null ? (
          <p className="archive-empty" role="status">
            暂时无法读取操作记录。
          </p>
        ) : summary.recentEvents.length === 0 ? (
          <p className="archive-empty">近期没有操作记录。</p>
        ) : (
          <ol className="archive-timeline">
            {summary.recentEvents.slice(0, 5).map((event) => (
              <li key={event.id}>
                <span className="archive-timeline__dot" aria-hidden="true" />
                <span>
                  <strong>
                    {actionLabels[event.action]} ·{" "}
                    {subjectKindLabels[event.subjectKind]}
                  </strong>
                  <span>{event.operatorLabel}</span>
                </span>
                <time dateTime={event.occurredAt}>
                  {formatTime(event.occurredAt)}
                </time>
              </li>
            ))}
          </ol>
        )}
        {summary ? (
          <p className="archive-updated">
            统计截至 {formatTime(summary.generatedAt)}（北京时间）
          </p>
        ) : null}
      </section>
    </section>
  );
};
