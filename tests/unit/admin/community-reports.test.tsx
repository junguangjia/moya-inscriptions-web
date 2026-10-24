// @vitest-environment jsdom
import { createElement } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OperatorReport } from "@moya/contracts/internal/community-operator";

const paths = await vi.hoisted(async () => {
  const { createRequire } = await import("node:module");
  const { realpathSync } = await import("node:fs");
  const { join } = await import("node:path");
  const req = createRequire(join(import.meta.dirname, "../../../apps/admin/"));
  return {
    ui: realpathSync(req.resolve("@payloadcms/ui")),
    templates: realpathSync(req.resolve("@payloadcms/next/templates")),
  };
});
vi.mock(paths.ui, () => ({ SetStepNav: () => null }));
vi.mock(paths.templates, () => ({ DefaultTemplate: () => null }));
import { ReportDetail } from "admin/community-views";

const fixture = (patch: Partial<OperatorReport> = {}): OperatorReport => ({
  id: "report-synthetic",
  target: { type: "comment", id: "comment-synthetic" },
  canonicalPath: "/work/work-synthetic",
  kind: "quick_comment",
  reason: null,
  description: "",
  status: "open",
  urgent: false,
  version: 2,
  createdAt: "2026-10-23T12:00:00.000Z",
  updatedAt: "2026-10-23T12:00:00.000Z",
  decision: null,
  appeal: null,
  messages: [],
  evidence: [
    {
      id: "evidence-synthetic",
      fileName: "Synthetic evidence.pdf",
      mimeType: "application/pdf",
      size: 100,
      sensitive: true,
      createdAt: "2026-10-23T12:00:00.000Z",
      downloadPath: "https://untrusted.invalid/ignored",
    },
  ],
  reporterId: "user-reporter",
  affectedUserId: "user-author",
  legalHold: false,
  snapshot: {
    text: "Synthetic comment",
    parent: { id: "parent", text: "Synthetic parent" },
    post: { id: "work-synthetic", type: "work", title: "Synthetic post" },
  },
  claimant: null,
  materials: [],
  history: [],
  notificationFailures: 0,
  allowedActions: ["retain", "hide", "warn", "restrict_comments", "suspend"],
  ...patch,
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Owner report case detail", () => {
  it("shows unspecified quick-comment reason, contextual parent and a private same-origin evidence download", () => {
    render(
      createElement(ReportDetail, {
        report: fixture(),
        busy: false,
        onMutation: vi.fn(),
        onClose: vi.fn(),
      }),
    );
    expect(screen.getByText("未提供原因（评论快捷举报）")).toBeTruthy();
    expect(screen.getByText("父评论：Synthetic parent")).toBeTruthy();
    expect(screen.getByText("所属内容：Synthetic post")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Synthetic evidence.pdf" })
        .getAttribute("href"),
    ).toBe(
      "/api/community-moderation/report-evidence/report-synthetic/evidence-synthetic",
    );
    expect(document.querySelector("iframe, img, embed")).toBeNull();
  });

  it("requires a reason and a checked confirmation before a decision is sent", () => {
    const onMutation = vi.fn(async () => undefined);
    render(
      createElement(ReportDetail, {
        report: fixture(),
        busy: false,
        onMutation,
        onClose: vi.fn(),
      }),
    );
    expect(
      (
        screen.getByRole("button", {
          name: "核对处置决定",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.change(screen.getByLabelText("处置措施"), {
      target: { value: "hide" },
    });
    fireEvent.change(screen.getByLabelText("决定理由（必填）"), {
      target: { value: "Synthetic reason" },
    });
    fireEvent.click(screen.getByRole("button", { name: "核对处置决定" }));
    expect(onMutation).not.toHaveBeenCalled();
    const confirmation = screen.getByRole("group", { name: "确认人工决定" });
    expect(within(confirmation).getByText("隐藏内容")).toBeTruthy();
    fireEvent.click(
      within(confirmation).getByRole("button", { name: "确认提交决定" }),
    );
    expect(onMutation).toHaveBeenCalledExactlyOnceWith("decide-report", {
      expectedVersion: 2,
      action: "hide",
      reason: "Synthetic reason",
    });
  });

  it("keeps private rights material out of forwarding until staff writes and confirms a necessary-disclosure copy", () => {
    const onMutation = vi.fn(async () => undefined);
    render(
      createElement(ReportDetail, {
        report: fixture({
          kind: "rights_notice",
          reason: "copyright",
          claimant: {
            name: "Synthetic claimant",
            contact: "private-contact",
            rightsBasis: "Private source",
          },
        }),
        busy: false,
        onMutation,
        onClose: vi.fn(),
      }),
    );
    const field = screen.getByLabelText(
      "人工整理后的必要披露副本",
    ) as HTMLTextAreaElement;
    expect(field.value).toBe("");
    expect(
      (
        screen.getByRole("button", {
          name: "预览转送副本",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.change(field, { target: { value: "Necessary copy" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /已核对接收方/u }));
    fireEvent.click(screen.getByRole("button", { name: "预览转送副本" }));
    expect(onMutation).not.toHaveBeenCalled();
    const confirmation = screen.getByRole("group", { name: "确认转送" });
    expect(confirmation.textContent).not.toContain("private-contact");
    expect(confirmation.textContent).not.toContain("Private source");
    fireEvent.click(
      within(confirmation).getByRole("button", { name: "确认转送此副本" }),
    );
    expect(onMutation).toHaveBeenCalledExactlyOnceWith("forward-report", {
      expectedVersion: 2,
      kind: "notice",
      text: "Necessary copy",
    });
  });

  it.each(["catalog", "article"] as const)(
    "records an observed native %s takedown without promising to enforce publication",
    (type) => {
      const onMutation = vi.fn(async () => undefined);
      render(
        createElement(ReportDetail, {
          report: fixture({
            target: { type, id: "official-synthetic" },
            kind: "rights_notice",
            reason: "copyright",
            affectedUserId: null,
            allowedActions: ["retain", "hide"],
            snapshot: {
              source: "official",
              title: "Synthetic official item",
              nativePublicationObservation: {
                status: "unavailable",
                observedAt: "2026-10-23T12:00:00.000Z",
              },
            },
          }),
          busy: false,
          onMutation,
          onClose: vi.fn(),
        }),
      );
      expect(
        screen.getByText(/此处仅核验并记录原条目当前不可访问/u),
      ).toBeTruthy();
      expect(screen.getByText(/原内容核验：核验时不可公开读取/u)).toBeTruthy();
      expect(screen.getByRole("option", { name: "核验已撤下" })).toBeTruthy();
      expect(screen.queryByRole("option", { name: "隐藏内容" })).toBeNull();
      expect(
        (
          screen.getByRole("option", {
            name: "权利通知 → 相关用户",
          }) as HTMLOptionElement
        ).disabled,
      ).toBe(true);
      expect(
        (
          screen.getByRole("option", {
            name: "不侵权声明 → 投诉人",
          }) as HTMLOptionElement
        ).disabled,
      ).toBe(true);
      expect(
        (screen.getByLabelText("转送类型") as HTMLSelectElement).value,
      ).toBe("result");
      fireEvent.change(screen.getByLabelText("处置措施"), {
        target: { value: "hide" },
      });
      fireEvent.change(screen.getByLabelText("决定理由（必填）"), {
        target: { value: "Native item was taken down in content management" },
      });
      fireEvent.click(screen.getByRole("button", { name: "核对处置决定" }));
      const confirmation = screen.getByRole("group", { name: "确认人工决定" });
      expect(within(confirmation).getByText("核验已撤下")).toBeTruthy();
      expect(
        within(confirmation).getByText(/不替代内容管理操作/u),
      ).toBeTruthy();
      fireEvent.click(
        within(confirmation).getByRole("button", { name: "确认提交决定" }),
      );
      expect(onMutation).toHaveBeenCalledExactlyOnceWith("decide-report", {
        expectedVersion: 2,
        action: "hide",
        reason: "Native item was taken down in content management",
      });
    },
  );

  it("sends an explicit platform response only for an official rights notice", () => {
    const onMutation = vi.fn(async () => undefined);
    render(
      createElement(ReportDetail, {
        report: fixture({
          target: { type: "catalog", id: "official-synthetic" },
          kind: "rights_notice",
          reason: "copyright",
          affectedUserId: null,
          allowedActions: ["retain", "hide"],
          snapshot: { source: "official" },
        }),
        busy: false,
        onMutation,
        onClose: vi.fn(),
      }),
    );
    expect(
      screen.getByRole("option", { name: "平台处理说明 → 投诉人" }),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("人工整理后的必要披露副本"), {
      target: {
        value: "The original item was unpublished through content management",
      },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /已核对接收方/u }));
    fireEvent.click(screen.getByRole("button", { name: "预览转送副本" }));
    expect(onMutation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认转送此副本" }));
    expect(onMutation).toHaveBeenCalledExactlyOnceWith("forward-report", {
      expectedVersion: 2,
      kind: "result",
      text: "The original item was unpublished through content management",
    });
  });

  it("keeps native community Article actions unchanged and offers no platform response", () => {
    render(
      createElement(ReportDetail, {
        report: fixture({
          target: { type: "article", id: "community-article" },
          kind: "rights_notice",
          reason: "copyright",
          snapshot: { source: "community" },
        }),
        busy: false,
        onMutation: vi.fn(),
        onClose: vi.fn(),
      }),
    );
    expect(screen.getByRole("option", { name: "隐藏内容" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "核验已撤下" })).toBeNull();
    expect(
      screen.queryByRole("option", { name: "平台处理说明 → 投诉人" }),
    ).toBeNull();
    expect(
      (
        screen.getByRole("option", {
          name: "不侵权声明 → 投诉人",
        }) as HTMLOptionElement
      ).disabled,
    ).toBe(true);
  });

  it("lets staff uphold a protective measure reopened by a rights statement without a formal appeal", () => {
    const onMutation = vi.fn(async () => undefined);
    render(
      createElement(ReportDetail, {
        report: fixture({
          kind: "rights_notice",
          reason: "copyright",
          status: "reviewing",
          appeal: null,
          decision: {
            id: "decision",
            action: "hide",
            reason: "Protective measure",
            createdAt: "2026-10-23T12:00:00.000Z",
            reversedAt: null,
            reviewReason: null,
          },
          materials: [
            {
              id: "statement",
              authorId: "user-author",
              kind: "statement",
              text: "Synthetic non-infringement statement",
              createdAt: "2026-10-23T12:10:00.000Z",
            },
          ],
        }),
        busy: false,
        onMutation,
        onClose: vi.fn(),
      }),
    );
    expect(screen.getByRole("option", { name: "维持原决定" })).toBeTruthy();
    expect(
      screen.getByRole("option", { name: "撤销原决定并纠正" }),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("决定理由（必填）"), {
      target: { value: "Protective measure remains necessary" },
    });
    fireEvent.click(screen.getByRole("button", { name: "核对复核决定" }));
    expect(onMutation).not.toHaveBeenCalled();
    expect(
      within(screen.getByRole("group", { name: "确认人工决定" })).getByText(
        "维持原决定",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认提交决定" }));
    expect(onMutation).toHaveBeenCalledExactlyOnceWith("review-report", {
      expectedVersion: 2,
      outcome: "uphold",
      reason: "Protective measure remains necessary",
    });
  });

  it("identifies direct moderation without a reporter and returns an overturned rejection to pending review", () => {
    const onMutation = vi.fn(async () => undefined);
    render(
      createElement(ReportDetail, {
        report: fixture({
          kind: "moderation",
          reporterId: null,
          reason: null,
          target: { type: "article", id: "article-synthetic" },
          status: "appealed",
          allowedActions: [],
          decision: {
            id: "decision",
            action: "reject",
            reason: "Candidate rejected",
            createdAt: "2026-10-23T12:00:00.000Z",
            reversedAt: null,
            reviewReason: null,
          },
          appeal: {
            text: "Please review this candidate",
            status: "pending",
            createdAt: "2026-10-23T12:10:00.000Z",
          },
        }),
        busy: false,
        onMutation,
        onClose: vi.fn(),
      }),
    );
    expect(screen.getByText("人工审核处置（无举报人）")).toBeTruthy();
    expect(screen.getByLabelText("私有材料").textContent).toContain(
      "无（人工审核处置）",
    );
    expect(
      screen.getByText(/原候选版本仅返回待审核，不会自动公开/u),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("复核结果"), {
      target: { value: "overturn" },
    });
    fireEvent.change(screen.getByLabelText("决定理由（必填）"), {
      target: { value: "Return exact candidate for a fresh review" },
    });
    fireEvent.click(screen.getByRole("button", { name: "核对复核决定" }));
    expect(
      within(screen.getByRole("group", { name: "确认人工决定" })).getByText(
        "撤销拒绝并退回待审核",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认提交决定" }));
    expect(onMutation).toHaveBeenCalledExactlyOnceWith("review-report", {
      expectedVersion: 2,
      outcome: "overturn",
      reason: "Return exact candidate for a fresh review",
    });
  });

  it.each([
    ["delete_body", "已删除正文无法恢复", "认定原决定有误（正文无法恢复）"],
    [
      "remove_thread",
      "其他有效案件及评论自身审核状态仍可限制访问",
      "撤销原决定并纠正",
    ],
  ] as const)(
    "describes the real recovery boundary for %s decisions",
    (action, explanation, confirmationLabel) => {
      const onMutation = vi.fn(async () => undefined);
      render(
        createElement(ReportDetail, {
          report: fixture({
            kind: "moderation",
            reporterId: null,
            status: "resolved",
            allowedActions: [],
            decision: {
              id: "decision",
              action,
              reason: "Prior direct moderation",
              createdAt: "2026-10-23T12:00:00.000Z",
              reversedAt: null,
              reviewReason: null,
            },
          }),
          busy: false,
          onMutation,
          onClose: vi.fn(),
        }),
      );
      expect(screen.getByText(new RegExp(explanation, "u"))).toBeTruthy();
      fireEvent.change(screen.getByLabelText("决定理由（必填）"), {
        target: { value: "Correct the erroneous decision" },
      });
      fireEvent.click(screen.getByRole("button", { name: "核对复核决定" }));
      expect(
        within(screen.getByRole("group", { name: "确认人工决定" })).getByText(
          confirmationLabel,
        ),
      ).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "确认提交决定" }));
      expect(onMutation).toHaveBeenCalledExactlyOnceWith("review-report", {
        expectedVersion: 2,
        outcome: "overturn",
        reason: "Correct the erroneous decision",
      });
    },
  );

  it("permits a reasoned correction without an appeal and preserves actor, time and prior decision", () => {
    const onMutation = vi.fn(async () => undefined);
    render(
      createElement(ReportDetail, {
        report: fixture({
          status: "resolved",
          decision: {
            id: "decision",
            action: "hide",
            reason: "Original reason",
            createdAt: "2026-10-23T12:00:00.000Z",
            reversedAt: null,
            reviewReason: null,
          },
          history: [
            {
              id: "audit",
              action: "hide",
              operator: "synthetic-owner",
              reason: "Original reason",
              occurredAt: "2026-10-23T12:00:00.000Z",
            },
          ],
          notificationFailures: 1,
        }),
        busy: false,
        onMutation,
        onClose: vi.fn(),
      }),
    );
    expect(screen.queryByRole("option", { name: "维持原决定" })).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("通知发送失败");
    expect(screen.getByLabelText("案件操作历史").textContent).toContain(
      "synthetic-owner",
    );
    fireEvent.change(screen.getByLabelText("决定理由（必填）"), {
      target: { value: "Corrected reason" },
    });
    fireEvent.click(screen.getByRole("button", { name: "核对复核决定" }));
    fireEvent.click(screen.getByRole("button", { name: "确认提交决定" }));
    expect(onMutation).toHaveBeenCalledExactlyOnceWith("review-report", {
      expectedVersion: 2,
      outcome: "overturn",
      reason: "Corrected reason",
    });
  });
});
