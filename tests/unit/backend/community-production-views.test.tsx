import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminViewServerProps, ServerProps } from "payload";
import type { ReactNode } from "react";

const runtime = await vi.hoisted(async () => {
  const { createRequire } = await import("node:module");
  const { realpathSync } = await import("node:fs");
  const { join } = await import("node:path");
  const adminRequire = createRequire(
    join(import.meta.dirname, "../../../apps/admin/"),
  );
  return {
    ui: realpathSync(adminRequire.resolve("@payloadcms/ui")),
    templates: realpathSync(adminRequire.resolve("@payloadcms/next/templates")),
    link: realpathSync(adminRequire.resolve("next/link")),
    navigation: realpathSync(adminRequire.resolve("next/navigation")),
    user: { collection: "users", role: "owner" },
    pathname: "/admin",
    params: new URLSearchParams(),
    call: vi.fn(),
  };
});
vi.mock(runtime.ui, () => ({
  useAuth: () => ({ user: runtime.user }),
  Link: ({
    children,
    prefetch,
    ...props
  }: {
    children: ReactNode;
    prefetch?: boolean;
  }) =>
    createElement(
      "a",
      { ...props, "data-prefetch": String(prefetch) },
      children,
    ),
  useNav: () => ({
    hydrated: true,
    navOpen: true,
    navRef: { current: null },
    shouldAnimate: false,
    setNavOpen: vi.fn(),
  }),
  useTheme: () => ({ theme: "light", setTheme: vi.fn() }),
  usePreferences: () => ({ getPreference: async () => undefined }),
  Logout: () => null,
  NavToggler: () => null,
  Hamburger: () => null,
}));
vi.mock(runtime.templates, () => ({
  DefaultTemplate: ({ children }: { children: ReactNode }) => children,
}));
vi.mock(runtime.link, () => ({
  default: ({
    children,
    prefetch,
    ...props
  }: {
    children: ReactNode;
    href: string;
    prefetch?: boolean;
  }) =>
    createElement(
      "a",
      { ...props, "data-prefetch": String(prefetch) },
      children,
    ),
}));
vi.mock(runtime.navigation, () => ({
  usePathname: () => runtime.pathname,
  useSearchParams: () => runtime.params,
}));
vi.mock("../../../apps/admin/src/community/backend", () => ({
  callCommunityOperator: runtime.call,
}));
vi.mock("../../../apps/admin/src/community/queue-client", () => ({
  CommunityQueueClient: ({ phase4Enabled }: { phase4Enabled: boolean }) =>
    createElement(
      "span",
      null,
      phase4Enabled ? "queue-enabled" : "queue-disabled",
    ),
}));
vi.mock("../../../apps/admin/src/community/settings-client", () => ({
  CommunitySettingsClient: ({ workPublishing }: { workPublishing: boolean }) =>
    createElement(
      "span",
      null,
      workPublishing ? "publishing-enabled" : "publishing-disabled",
    ),
}));
vi.mock("admin/community-content-client", () => ({
  CommunityContentClient: () => "content",
}));
vi.mock("../../../apps/admin/src/community/feedback-client", () => ({
  CommunityFeedbackClient: () => "feedback",
}));
vi.mock("../../../apps/admin/src/community/history-client", () => ({
  CommunityHistoryClient: () => "history",
}));
vi.mock("../../../apps/admin/src/community/article-submissions-client", () => ({
  ArticleSubmissionsQueueClient: () => "article-submissions",
}));
vi.mock("../../../apps/admin/src/community/work-submissions-client", () => ({
  WorkSubmissionsQueueClient: () => "submissions",
}));
vi.mock("../../../apps/admin/src/community/account-capacity-client", () => ({
  AccountCapacityClient: () => "capacity",
}));
vi.mock("../../../apps/admin/src/community/publishing-jobs-client", () => ({
  PublishingJobsClient: () => "jobs",
}));
vi.mock("../../../apps/admin/src/community/threads-client", () => ({
  ThreadsClient: () => "threads",
}));
vi.mock("../../../apps/admin/src/community/dm-moderation-client", () => ({
  DmModerationClient: () => "messages",
}));
vi.mock("../../../apps/admin/src/community/agent-operations-client", () => ({
  AgentOperationsClient: () => "agent-operations",
}));

import {
  ArticleSubmissionsView,
  AccountCapacityView,
  AgentOperationsView,
  CommunityContentView,
  CommunityFeedbackView,
  CommunityModerationView,
  CommunitySettingsView,
  DmModerationView,
  PublishingJobsView,
  ThreadsView,
  WorkSubmissionsView,
} from "admin/community-views";
import { CommunityNavGroups } from "admin/community-navigation";
import { CommunityDashboardCard } from "admin/community-dashboard";
import { WorkspaceTabs } from "admin/workspace-navigation";

const props = (role: "owner" | "automation"): AdminViewServerProps =>
  ({
    initPageResult: {
      req: { user: { collection: "users", role } },
      visibleEntities: {},
    },
  }) as unknown as AdminViewServerProps;
const businessViews = [
  [CommunityModerationView, "queue-enabled"],
  [CommunitySettingsView, "publishing-enabled"],
  [CommunityContentView, "content"],
  [CommunityFeedbackView, "feedback"],
  [WorkSubmissionsView, "submissions"],
  [ArticleSubmissionsView, "article-submissions"],
  [AccountCapacityView, "capacity"],
  [PublishingJobsView, "jobs"],
  [ThreadsView, "threads"],
  [DmModerationView, "messages"],
] as const;

afterEach(() => {
  vi.unstubAllEnvs();
  runtime.user.role = "owner";
  runtime.pathname = "/admin";
  runtime.params = new URLSearchParams();
  runtime.call.mockReset();
});

describe.each(["development", "production"])(
  "Admin business availability in %s",
  (nodeEnv) => {
    it("renders every existing business view for the Owner and refuses automation", () => {
      vi.stubEnv("NODE_ENV", nodeEnv);
      for (const [View, content] of businessViews) {
        expect(
          renderToStaticMarkup(createElement(View, props("owner"))),
        ).toContain(content);
        const refused = renderToStaticMarkup(
          createElement(View, props("automation")),
        );
        expect(refused).toContain("此工作区仅限 Owner。");
        expect(refused).not.toContain(content);
      }
      const agents = renderToStaticMarkup(
        createElement(AgentOperationsView, props("owner")),
      );
      expect(agents.includes("agent-operations")).toBe(
        nodeEnv === "development",
      );
    });

    it("keeps business links visible while restricting Agent and AI connection links", () => {
      const navigation = () =>
        renderToStaticMarkup(
          createElement(CommunityNavGroups, {
            developmentAgentsEnabled: nodeEnv === "development",
          }),
        );
      const sidebar = navigation();
      expect(sidebar.match(/data-workspace=/g) ?? []).toHaveLength(8);
      expect(sidebar).not.toContain("系统与自动化");
      const markup =
        sidebar +
        [
          "/admin/collections/catalogs",
          "/admin/community-moderation",
          "/admin/community-moderation/content?tab=users",
          "/admin/analytics",
          "/admin/editorial-workflow",
          "/admin/community-moderation/history",
          "/admin/community-moderation/settings",
        ]
          .map((href) => {
            const url = new URL(href, "https://admin.example.test");
            runtime.pathname = url.pathname;
            runtime.params = url.searchParams;
            return renderToStaticMarkup(
              createElement(WorkspaceTabs, {
                developmentAgentsEnabled: nodeEnv === "development",
              }),
            );
          })
          .join("");
      for (const path of [
        "content",
        "work-submissions",
        "article-submissions",
        "account-capacity",
        "publishing-jobs",
        "threads",
        "direct-messages",
        "feedback",
      ])
        expect(markup).toContain(`/admin/community-moderation/${path}`);
      expect(
        markup.includes("/admin/community-moderation/agent-operations"),
      ).toBe(nodeEnv === "development");
      expect(markup.includes("/admin/agent-connections")).toBe(
        nodeEnv === "development",
      );
      runtime.user.role = "automation";
      expect(navigation()).toBe("");
      expect(renderToStaticMarkup(createElement(WorkspaceTabs))).toBe("");
    });

    it("reads real pending submissions for the dashboard and keeps non-Owner access empty", async () => {
      vi.stubEnv("NODE_ENV", nodeEnv);
      runtime.call.mockImplementation(async (_method: string, path: string) =>
        path.startsWith("publishing/")
          ? {
              items: [],
              total: 3,
              page: 1,
              pageSize: 1,
              totalPages: 3,
            }
          : {
              generatedAt: "2026-10-02T00:00:00.000Z",
              queue: { pending: 2 },
              policy: { policy: "PRE_MODERATION" },
              actions: { approve: 0, reject: 0, hide: 0, unhide: 0 },
              recentEvents: [],
              analysis: { connected: false },
            },
      );
      const card = await CommunityDashboardCard({
        user: { collection: "users", role: "owner" },
      } as unknown as ServerProps);
      const markup = renderToStaticMarkup(card);
      expect(markup).toContain('data-card-pending-work-submissions="">3');
      expect(markup).toContain("/admin/community-moderation/publishing-jobs");
      expect(markup).toContain("/admin/community-moderation/feedback");
      expect(runtime.call).toHaveBeenCalledWith(
        "GET",
        "publishing/submissions?state=pending&page=1&pageSize=1",
      );
      runtime.call.mockClear();
      expect(
        await CommunityDashboardCard({
          user: { collection: "users", role: "automation" },
        } as unknown as ServerProps),
      ).toBe(null);
      expect(runtime.call).not.toHaveBeenCalled();
    });

    it("represents unavailable dashboard counts as unknown and does not invent empty queues", async () => {
      vi.stubEnv("NODE_ENV", nodeEnv);
      runtime.call.mockRejectedValue(
        new Error("synthetic unavailable backend"),
      );
      const card = await CommunityDashboardCard({
        user: { collection: "users", role: "owner" },
      } as unknown as ServerProps);
      const markup = renderToStaticMarkup(card);
      expect(markup).toContain('data-card-pending="">—');
      expect(markup).toContain('data-card-pending-work-submissions="">—');
      expect(markup).not.toContain('data-card-pending="">0');
      expect(markup).not.toContain('data-card-pending-work-submissions="">0');
      expect(markup).toContain("部分数据暂时无法读取");
    });
  },
);
