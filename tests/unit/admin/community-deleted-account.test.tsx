// @vitest-environment jsdom
import { createElement } from "react";
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminViewServerProps } from "payload";
import type {
  OperatorComment,
  OperatorUser,
  OperatorWork,
} from "@moya/contracts/internal/community-operator";

/*
 * account-deletion-v1: Admin shows a deleted account as 已注销 wherever it
 * lists a user or an author, and offers no suspend, reinstate or new
 * recommendation for it. Every account here is synthetic.
 */

const runtime = await vi.hoisted(async () => {
  const { createRequire } = await import("node:module");
  const { realpathSync } = await import("node:fs");
  const { join } = await import("node:path");
  const require = createRequire(
    join(import.meta.dirname, "../../../apps/admin/"),
  );
  return {
    ui: realpathSync(require.resolve("@payloadcms/ui")),
    templates: realpathSync(require.resolve("@payloadcms/next/templates")),
    navigation: realpathSync(require.resolve("next/navigation")),
    call: vi.fn(),
    params: new URLSearchParams(),
  };
});
vi.mock(runtime.ui, () => ({
  SetStepNav: () => null,
  useModal: () => ({ openModal: vi.fn(), closeModal: vi.fn() }),
  ConfirmationModal: () => null,
}));
vi.mock(runtime.templates, () => ({
  DefaultTemplate: ({ children }: { children: ReactNode }) => children,
}));
vi.mock(runtime.navigation, () => ({
  usePathname: () => "/admin/community-moderation",
  useSearchParams: () => runtime.params,
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock("admin/community-api", async (original) => ({
  ...(await original<object>()),
  call: runtime.call,
}));
import { userStatusLabels } from "admin/community-api";
import {
  CommunityContentView,
  CommunityModerationView,
} from "admin/community-views";

const props = {
  initPageResult: {
    req: { user: { collection: "users", role: "owner" } },
    visibleEntities: {},
  },
} as unknown as AdminViewServerProps;
const live = `user-${"a".repeat(32)}`;
const gone = `user-${"d".repeat(32)}`;
const comment = (n: string, author: string, status: "active" | "deleted") =>
  ({
    id: `comment-${n.repeat(32)}`,
    kind: "comment",
    catalogId: null,
    target: { type: "work", id: `work-${"b".repeat(32)}` },
    contentTitle: "Synthetic target",
    catalogTitle: null,
    author: {
      id: author,
      handle: status === "deleted" ? "deleted-author" : "live-author",
      displayName: status === "deleted" ? "已注销用户" : "Synthetic author",
      status,
    },
    text: `Synthetic comment ${n}`,
    createdAt: "2026-10-27T01:00:00.000Z",
    moderation: "visible",
    threadAffectedCount: 1,
  }) as OperatorComment;
const user = (
  id: string,
  status: OperatorUser["status"],
  recommended = false,
): OperatorUser => ({
  id,
  handle: status === "deleted" ? "deleted-author" : "live-author",
  displayName: status === "deleted" ? "已注销用户" : "Synthetic author",
  bio: "",
  status,
  createdAt: "2026-10-01T00:00:00.000Z",
  submittedWorks: 0,
  recommended,
  recommendationVersion: recommended ? 1 : 0,
});
const work = (): OperatorWork => ({
  id: `work-${"c".repeat(32)}`,
  title: "Synthetic work",
  text: "",
  authorId: gone,
  authorName: "已注销用户",
  authorStatus: "deleted",
  state: "visible",
  authorDeleted: false,
  version: 1,
  firstPublishedAt: "2026-10-01T00:00:00.000Z",
  publiclyVisible: false,
});

beforeEach(() => {
  runtime.params = new URLSearchParams();
  runtime.call.mockReset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("deleted accounts in Admin", () => {
  it("labels every account state once", () => {
    expect(userStatusLabels).toEqual({
      active: "正常",
      suspended: "已停用",
      deleted: "已注销",
    });
  });

  it("marks a deleted comment author and offers no account action for it", async () => {
    runtime.call.mockImplementation(async (name: string) => {
      if (name === "read-comments")
        return {
          items: [comment("1", live, "active"), comment("2", gone, "deleted")],
          counts: { pending: 0, visible: 2, hidden: 0, all: 2 },
          total: 2,
          page: 1,
          pageSize: 20,
          totalPages: 1,
        };
      if (name === "read-policy") return { policy: "DIRECT_PUBLICATION" };
      throw new Error(`Unexpected test operation ${name}`);
    });
    render(createElement(CommunityModerationView, props));
    await screen.findByText("Synthetic comment 2");
    expect(screen.getByText("已注销").getAttribute("data-state")).toBe(
      "deleted",
    );
    // Only the live author can be suspended; the deleted one has neither
    // action.
    expect(screen.getAllByRole("menuitem", { name: "停用账号…" })).toHaveLength(
      1,
    );
    expect(screen.queryByRole("menuitem", { name: "恢复账号" })).toBeNull();
  });

  it("shows a deleted author and user, and never offers to recommend one again", async () => {
    runtime.call.mockImplementation(async (name: string) => {
      if (name === "read-works")
        return { items: [work()], total: 1, page: 1, pageSize: 20 };
      if (name === "read-users")
        return {
          items: [
            user(live, "active"),
            user(gone, "deleted"),
            user(`user-${"e".repeat(32)}`, "deleted", true),
          ],
          total: 3,
          page: 1,
          pageSize: 20,
        };
      throw new Error(`Unexpected test operation ${name}`);
    });
    render(createElement(CommunityContentView, props));
    expect(await screen.findByText("账号已注销")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "用户管理" }));
    await screen.findByText("不可推荐");
    expect(screen.getAllByText("已注销")).toHaveLength(2);
    expect(screen.getByText("正常")).toBeTruthy();
    // The live account can be recommended; an earlier recommendation of a
    // deleted account can still be withdrawn.
    expect(screen.getByRole("button", { name: "推荐用户" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "已推荐用户" })).toBeTruthy();
  });
});
