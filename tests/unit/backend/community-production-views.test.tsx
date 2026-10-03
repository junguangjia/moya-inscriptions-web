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
    call: vi.fn(),
  };
});
vi.mock(runtime.ui, () => ({
  useAuth: () => ({ user: runtime.user }),
  NavGroup: ({ children }: { children: ReactNode }) => children,
}));
vi.mock(runtime.templates, () => ({
  DefaultTemplate: ({ children }: { children: ReactNode }) => children,
}));
vi.mock(runtime.link, () => ({
  default: ({ children, ...props }: { children: ReactNode; href: string }) =>
    createElement("a", props, children),
}));
vi.mock(runtime.navigation, () => ({ usePathname: () => "/admin" }));
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
vi.mock("../../../apps/admin/src/community/content-client", () => ({
  CommunityContentClient: () => "content",
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
  CommunityModerationView,
  CommunitySettingsView,
  DmModerationView,
  PublishingJobsView,
  ThreadsView,
  WorkSubmissionsView,
} from "admin/community-views";
import { CommunityNavGroups } from "admin/community-navigation";
import { CommunityDashboardCard } from "admin/community-dashboard";

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
      const markup = navigation();
      for (const path of [
        "content",
        "work-submissions",
        "article-submissions",
        "account-capacity",
        "publishing-jobs",
        "threads",
        "direct-messages",
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
  },
);
