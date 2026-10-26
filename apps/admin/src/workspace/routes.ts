/** Presentation routes only. Access remains enforced by Payload and each view. */
export const workspaces = [
  {
    id: "home",
    label: "工作台",
    icon: "home",
    pages: [{ label: "工作台", href: "/admin" }],
  },
  {
    id: "content",
    label: "内容",
    icon: "inscriptions",
    pages: [
      { label: "资料", href: "/admin/collections/catalogs" },
      { label: "图片素材", href: "/admin/collections/media" },
      { label: "编辑文章", href: "/admin/collections/articles" },
      { label: "专题合集", href: "/admin/collections/article-collections" },
      { label: "用户作品", href: "/admin/community-moderation/content" },
      {
        label: "推荐",
        href: "/admin/community-moderation/content?tab=featured",
      },
      { label: "话题", href: "/admin/community-moderation/threads" },
    ],
  },
  {
    id: "review",
    label: "审核",
    icon: "discussion",
    pages: [
      { label: "评论", href: "/admin/community-moderation" },
      {
        label: "作品投稿",
        href: "/admin/community-moderation/work-submissions",
      },
      {
        label: "作者投稿",
        href: "/admin/community-moderation/article-submissions",
      },
      { label: "举报", href: "/admin/community-moderation/reports" },
      { label: "申诉", href: "/admin/community-moderation/appeals" },
      { label: "私信", href: "/admin/community-moderation/direct-messages" },
      { label: "反馈", href: "/admin/community-moderation/feedback" },
    ],
  },
  {
    id: "users",
    label: "用户",
    icon: "user",
    pages: [
      {
        label: "网站用户",
        href: "/admin/community-moderation/content?tab=users",
      },
      {
        label: "发布额度",
        href: "/admin/community-moderation/account-capacity",
      },
    ],
  },
  {
    id: "analytics",
    label: "数据",
    icon: "layout-double",
    pages: [{ label: "访问分析", href: "/admin/analytics" }],
  },
  {
    id: "publishing",
    label: "发布工具",
    icon: "edit",
    pages: [
      { label: "批量审核", href: "/admin/editorial-workflow" },
      { label: "资料批准", href: "/admin/collections/editorial-approvals" },
      {
        label: "文章批准",
        href: "/admin/collections/editorial-article-approvals",
      },
      {
        label: "发布进度",
        href: "/admin/community-moderation/publishing-jobs",
      },
      {
        label: "AI 操作",
        href: "/admin/community-moderation/agent-operations",
        developmentOnly: true,
      },
      {
        label: "AI 连接",
        href: "/admin/agent-connections",
        developmentOnly: true,
      },
    ],
  },
  {
    id: "history",
    label: "操作记录",
    icon: "news",
    pages: [
      { label: "社区操作", href: "/admin/community-moderation/history" },
      { label: "批量执行记录", href: "/admin/collections/editorial-receipts" },
    ],
  },
  {
    id: "settings",
    label: "设置",
    icon: "settings",
    pages: [
      { label: "发布规则", href: "/admin/community-moderation/settings" },
      { label: "后台账号", href: "/admin/collections/users" },
      { label: "自动化密钥", href: "/admin/collections/payload-mcp-api-keys" },
    ],
  },
] as const;

export type Workspace = (typeof workspaces)[number];
export type WorkspacePage = Workspace["pages"][number];
export type ContentTab = "works" | "featured" | "users";

/** Use the navigation vocabulary for page headings and native collection labels. */
export function workspacePageLabel(href: string): string {
  for (const workspace of workspaces) {
    const page = workspace.pages.find((page) => page.href === href);
    if (page) return page.label;
  }
  throw new Error(`Unknown Admin workspace page: ${href}`);
}

export const contentTab = (value: string | null): ContentTab =>
  value === "featured" || value === "users" ? value : "works";

export const workspacePages = (workspace: Workspace, development = false) =>
  workspace.pages.filter((page) => !("developmentOnly" in page) || development);

export function currentWorkspace(
  pathname: string,
  search: { get(name: string): string | null },
) {
  for (const workspace of workspaces) {
    for (const page of workspace.pages) {
      const [path = "", query] = page.href.split("?");
      if (path === "/admin/community-moderation/content") {
        if (pathname !== path) continue;
        const tab = new URLSearchParams(query).get("tab");
        if (contentTab(search.get("tab")) !== contentTab(tab)) continue;
      } else if (
        path.startsWith("/admin/collections/") ||
        path === "/admin/agent-connections"
      ) {
        if (pathname !== path && !pathname.startsWith(`${path}/`)) continue;
      } else if (pathname !== path) continue;
      return { workspace, page };
    }
  }
  return null;
}
