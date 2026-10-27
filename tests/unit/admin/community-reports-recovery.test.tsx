// @vitest-environment jsdom
import { createElement } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperatorReport } from "@moya/contracts/internal/community-operator";

const runtime = await vi.hoisted(async () => {
  const { createRequire } = await import("node:module");
  const { realpathSync } = await import("node:fs");
  const { join } = await import("node:path");
  const req = createRequire(join(import.meta.dirname, "../../../apps/admin/"));
  return {
    ui: realpathSync(req.resolve("@payloadcms/ui")),
    navigation: realpathSync(req.resolve("next/navigation")),
    params: new URLSearchParams("case=case-a"),
    replace: vi.fn(),
    call: vi.fn(),
  };
});
vi.mock(runtime.ui, () => ({ SetStepNav: () => null }));
vi.mock(runtime.navigation, () => ({
  usePathname: () => "/admin/community-moderation/reports",
  useRouter: () => ({ replace: runtime.replace }),
  useSearchParams: () => runtime.params,
}));
vi.mock("admin/community-api", async (original) => ({
  ...(await original<object>()),
  call: runtime.call,
}));
import { CommunityReportsClient } from "admin/community-reports-client";
import { OperatorFailure } from "admin/community-api";

const fixture = (id = "case-a", version = 2): OperatorReport => ({
  id,
  target: { type: "comment", id: "comment-synthetic" },
  canonicalPath: "/work/synthetic",
  kind: "rights_notice",
  reason: "copyright",
  description: "Synthetic report",
  status: "open",
  urgent: false,
  version,
  createdAt: "2026-10-23T12:00:00Z",
  updatedAt: "2026-10-23T12:00:00Z",
  decision: null,
  appeal: null,
  messages: [],
  evidence: [],
  reporterId: "synthetic-reporter",
  affectedUserId: "synthetic-author",
  legalHold: false,
  snapshot: { text: "Synthetic comment" },
  claimant: null,
  materials: [],
  history: [],
  notificationFailures: 0,
  allowedActions: ["retain", "hide"],
});
let version = 2;
beforeEach(() => {
  version = 2;
  runtime.params = new URLSearchParams("case=case-a");
  runtime.call.mockReset();
  runtime.call.mockImplementation(
    async (name: string, input: { id?: string }) => {
      if (name === "read-reports")
        return { items: [fixture()], total: 1, page: 1, pageSize: 20 };
      if (name === "read-report") return fixture(input.id, version);
      throw new OperatorFailure("STATE_CONFLICT", "Synthetic conflict", 409);
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("report case input recovery", () => {
  it("keeps the reason visible after failure and rereads before a newly confirmed version is submitted", async () => {
    render(createElement(CommunityReportsClient));
    await screen.findByLabelText("决定理由（必填）");
    fireEvent.change(screen.getByLabelText("处置措施"), {
      target: { value: "hide" },
    });
    fireEvent.change(screen.getByLabelText("决定理由（必填）"), {
      target: { value: "Synthetic reason" },
    });
    fireEvent.click(screen.getByRole("button", { name: "核对处置决定" }));
    fireEvent.click(
      within(screen.getByRole("group", { name: "确认人工决定" })).getByRole(
        "button",
        { name: "确认提交决定" },
      ),
    );
    await screen.findByText(/已保留填写内容/);
    expect(
      (screen.getByLabelText("决定理由（必填）") as HTMLTextAreaElement).value,
    ).toBe("Synthetic reason");
    expect(
      (
        screen.getByRole("button", {
          name: "核对处置决定",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    version = 3;
    fireEvent.click(screen.getByRole("button", { name: "重新读取案件" }));
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "核对处置决定",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    expect(
      (screen.getByLabelText("决定理由（必填）") as HTMLTextAreaElement).value,
    ).toBe("Synthetic reason");
    expect(screen.queryByRole("group", { name: "确认人工决定" })).toBeNull();
    expect(
      runtime.call.mock.calls.filter(([name]) => name === "decide-report"),
    ).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "核对处置决定" }));
    fireEvent.click(
      within(screen.getByRole("group", { name: "确认人工决定" })).getByRole(
        "button",
        { name: "确认提交决定" },
      ),
    );
    await waitFor(() =>
      expect(
        runtime.call.mock.calls.filter(([name]) => name === "decide-report"),
      ).toHaveLength(2),
    );
    expect(
      runtime.call.mock.calls.filter(
        ([name]) => name === "decide-report",
      )[1]?.[1],
    ).toEqual({
      id: "case-a",
      expectedVersion: 3,
      action: "hide",
      reason: "Synthetic reason",
    });
  });

  it("retains the forwarding copy and checked review for its own case without automatically sending it again", async () => {
    const view = render(createElement(CommunityReportsClient));
    await screen.findByLabelText("人工整理后的必要披露副本");
    fireEvent.change(screen.getByLabelText("人工整理后的必要披露副本"), {
      target: { value: "Synthetic necessary copy" },
    });
    fireEvent.click(screen.getByLabelText(/已核对接收方/));
    fireEvent.click(screen.getByRole("button", { name: "预览转送副本" }));
    const confirmation = screen.getByRole("group", { name: "确认转送" });
    fireEvent.click(
      within(confirmation).getByRole("button", { name: /确认转送/ }),
    );
    await screen.findByText(/已保留填写内容/);
    fireEvent.click(screen.getByRole("button", { name: "重新读取案件" }));
    await waitFor(() =>
      expect(
        (
          screen.getByLabelText(
            "人工整理后的必要披露副本",
          ) as HTMLTextAreaElement
        ).disabled,
      ).toBe(false),
    );
    expect(
      (screen.getByLabelText("人工整理后的必要披露副本") as HTMLTextAreaElement)
        .value,
    ).toBe("Synthetic necessary copy");
    expect(
      (screen.getByLabelText(/已核对接收方/) as HTMLInputElement).checked,
    ).toBe(true);
    expect(screen.queryByRole("group", { name: "确认转送" })).toBeNull();
    runtime.params = new URLSearchParams("case=case-b");
    view.rerender(createElement(CommunityReportsClient));
    await waitFor(() =>
      expect(
        (
          screen.getByLabelText(
            "人工整理后的必要披露副本",
          ) as HTMLTextAreaElement
        ).value,
      ).toBe(""),
    );
    runtime.params = new URLSearchParams("case=case-a");
    view.rerender(createElement(CommunityReportsClient));
    await waitFor(() =>
      expect(
        (
          screen.getByLabelText(
            "人工整理后的必要披露副本",
          ) as HTMLTextAreaElement
        ).value,
      ).toBe("Synthetic necessary copy"),
    );
    expect(
      runtime.call.mock.calls.filter(([name]) => name === "forward-report"),
    ).toHaveLength(1);
  });
  it("returns keyboard focus to the case opener after closing detail", async () => {
    runtime.params = new URLSearchParams();
    const view = render(createElement(CommunityReportsClient));
    const opener = await screen.findByRole("button", { name: "评论/回复" });
    opener.focus();
    fireEvent.click(opener);
    runtime.params = new URLSearchParams("case=case-a");
    view.rerender(createElement(CommunityReportsClient));
    await screen.findByLabelText("决定理由（必填）");
    expect(document.activeElement).toBe(screen.getByLabelText("案件详情"));
    fireEvent.click(screen.getByRole("button", { name: "返回列表" }));
    runtime.params = new URLSearchParams();
    view.rerender(createElement(CommunityReportsClient));
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
});
