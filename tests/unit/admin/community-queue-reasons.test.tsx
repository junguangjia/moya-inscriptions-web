// @vitest-environment jsdom
import { createElement } from "react";
import type { ReactNode } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminViewServerProps } from "payload";
import type { OperatorComment } from "@moya/contracts/internal/community-operator";

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
    modal: "",
    params: new URLSearchParams(),
  };
});
vi.mock(runtime.ui, () => ({
  SetStepNav: () => null,
  useModal: () => ({
    openModal: (slug: string) => {
      runtime.modal = slug;
    },
    closeModal: () => {
      runtime.modal = "";
    },
  }),
  ConfirmationModal: ({
    body,
    confirmLabel,
    modalSlug,
    onConfirm,
  }: {
    body: ReactNode;
    confirmLabel: string;
    modalSlug: string;
    onConfirm: () => Promise<void>;
  }) =>
    runtime.modal === modalSlug
      ? createElement(
          "section",
          { role: "dialog" },
          body,
          createElement(
            "button",
            { onClick: () => void onConfirm() },
            confirmLabel,
          ),
        )
      : null,
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
import { OperatorFailure } from "admin/community-api";
import { CommunityModerationView } from "admin/community-views";

const props = {
  initPageResult: {
    req: { user: { collection: "users", role: "owner" } },
    visibleEntities: {},
  },
} as unknown as AdminViewServerProps;
const item = (): OperatorComment =>
  ({
    id: `comment-${"a".repeat(32)}`,
    kind: "comment",
    catalogId: null,
    target: { type: "work", id: `work-${"b".repeat(32)}` },
    contentTitle: "Synthetic target",
    catalogTitle: null,
    author: {
      id: `user-${"c".repeat(32)}`,
      handle: "synthetic_author",
      displayName: "Synthetic author",
      status: "active",
    },
    text: "Synthetic comment",
    createdAt: "2026-10-23T12:00:00.000Z",
    moderation: "visible",
    threadAffectedCount: 3,
  }) as OperatorComment;
beforeEach(() => {
  runtime.modal = "";
  runtime.params = new URLSearchParams();
  runtime.call.mockReset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("current human comment deletion reasons", () => {
  it.each([
    ["删除正文…", "delete-body"],
    ["移除整帖…", "remove-thread"],
  ] as const)(
    "freezes the reason, target, receipt and affected count for %s and its unknown-outcome retry",
    async (label, operation) => {
      const current = item();
      let attempts = 0;
      runtime.call.mockImplementation(async (name: string) => {
        if (name === "read-comments")
          return {
            items: [current],
            counts: { pending: 0, visible: 1, hidden: 0, all: 1 },
            total: 1,
            page: 1,
            pageSize: 20,
            totalPages: 1,
          };
        if (name === "read-policy") return { policy: "DIRECT_PUBLICATION" };
        if (name === operation) {
          attempts += 1;
          if (attempts === 1)
            throw new OperatorFailure(
              "OPERATOR_UNREACHABLE",
              "Synthetic lost response",
              502,
            );
          return { applied: true };
        }
        throw new Error(`Unexpected test operation ${name}`);
      });
      render(createElement(CommunityModerationView, props));
      const action = (await screen.findByText(label)) as HTMLButtonElement;
      expect(action.disabled).toBe(true);
      const field = screen.getByLabelText("评论与账号处置理由（必填）");
      fireEvent.change(field, {
        target: { value: "  Explicit deletion reason  " },
      });
      fireEvent.click(action);
      const dialog = screen.getByRole("dialog");
      expect(dialog.textContent).toContain(
        "处置理由：Explicit deletion reason",
      );
      if (operation === "remove-thread") {
        expect(dialog.textContent).toContain("共 3 项");
        expect(dialog.textContent).toContain("原有正文、作者关系及记录保留");
      }
      current.threadAffectedCount = 99;
      fireEvent.change(field, { target: { value: "Different unsent reason" } });
      fireEvent.click(
        screen.getByRole("button", {
          name: operation === "remove-thread" ? "确认移除" : "确认删除",
        }),
      );
      await screen.findByRole("button", { name: "重试同一操作" });
      const first = runtime.call.mock.calls.find(
        ([name]) => name === operation,
      )![1];
      expect(first).toEqual({
        id: current.id,
        reason: "Explicit deletion reason",
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
        ...(operation === "remove-thread" ? { expectedAffectedCount: 3 } : {}),
      });
      fireEvent.click(screen.getByRole("button", { name: "重试同一操作" }));
      await waitFor(() => expect(attempts).toBe(2));
      const calls = runtime.call.mock.calls.filter(
        ([name]) => name === operation,
      );
      expect(calls[1]![1]).toEqual(calls[0]![1]);
    },
  );
});
