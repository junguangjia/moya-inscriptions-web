"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NavGroup, useAuth } from "@payloadcms/ui";

import styles from "./community.module.css";

/**
 * Work-oriented navigation for the Owner: the Community group (queue,
 * publication setting, operation history, and in Development the content and
 * work publishing views) and the automation tools group (the editorial batch
 * workflow). Rendered inside Payload's own sidebar through `afterNavLinks`,
 * so the built-in collection groups stay intact.
 */
const groups = [
  {
    label: "社区",
    links: [
      { href: "/admin/community-moderation", label: "评论审核队列" },
      {
        href: "/admin/community-moderation/work-submissions",
        label: "作品提交审核",
      },
      { href: "/admin/community-moderation/settings", label: "发布设置" },
      { href: "/admin/community-moderation/history", label: "操作历史" },
      { href: "/admin/community-moderation/content", label: "作品与推荐" },
      {
        href: "/admin/community-moderation/account-capacity",
        label: "账号容量",
      },
      {
        href: "/admin/community-moderation/publishing-jobs",
        label: "发布任务",
      },
      {
        href: "/admin/community-moderation/agent-operations",
        label: "代理操作",
      },
      { href: "/admin/community-moderation/threads", label: "话题管理" },
      {
        href: "/admin/community-moderation/direct-messages",
        label: "私信处理",
      },
    ],
  },
  {
    label: "自动化工具",
    links: [{ href: "/admin/editorial-workflow", label: "编辑批处理工作流" }],
  },
  {
    label: "AI 连接",
    links: [{ href: "/admin/agent-connections", label: "AI 连接" }],
  },
] as const;

/** Development-only surfaces, hidden from the sidebar everywhere else. */
const developmentLinks: ReadonlySet<string> = new Set([
  "/admin/community-moderation/content",
  "/admin/community-moderation/work-submissions",
  "/admin/community-moderation/account-capacity",
  "/admin/community-moderation/publishing-jobs",
  "/admin/community-moderation/agent-operations",
  "/admin/agent-connections",
  "/admin/community-moderation/threads",
  "/admin/community-moderation/direct-messages",
]);

export const CommunityNavGroups = ({
  phase4Enabled = false,
}: {
  readonly phase4Enabled?: boolean;
}) => {
  const { user } = useAuth();
  const pathname = usePathname();
  if (user?.collection !== "users" || user.role !== "owner") return null;
  return (
    <>
      {groups.map((group) => (
        <NavGroup isOpen key={group.label} label={group.label}>
          {group.links
            .filter((link) => phase4Enabled || !developmentLinks.has(link.href))
            .map((link) => {
              const active = pathname === link.href;
              return (
                <Link
                  aria-current={active ? "page" : undefined}
                  className={`nav__link ${styles.navLink}${active ? " nav__link--active" : ""}`}
                  data-community-nav={link.href}
                  href={link.href}
                  key={link.href}
                >
                  {active ? <span className="nav__link-indicator" /> : null}
                  <span className="nav__link-label">{link.label}</span>
                </Link>
              );
            })}
        </NavGroup>
      ))}
    </>
  );
};
