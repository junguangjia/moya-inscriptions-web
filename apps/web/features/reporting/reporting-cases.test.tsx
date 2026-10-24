// @vitest-environment jsdom
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type { CommunityReportingInbox } from "@moya/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { client, modal, appealEvidence } = vi.hoisted(() => ({
  modal: vi.fn(),
  appealEvidence: vi.fn(),
  client: {
    list: vi.fn(),
    create: vi.fn(),
    evidence: vi.fn(),
    decisions: vi.fn(),
    inbox: vi.fn(),
    material: vi.fn(),
    appeal: vi.fn(),
    statement: vi.fn(),
    read: vi.fn(),
  },
}));
vi.mock("./reporting-data", () => ({
  reportingClient: client,
  appealReportingClient: { ...client, evidence: appealEvidence },
  downloadReportEvidence: vi.fn(),
  ReportingRequestError: class extends Error {},
}));
vi.mock("../authors/author-context", () => ({
  useAuthors: () => ({
    viewer: { id: "user-synthetic" },
    checking: false,
    sessionError: false,
    notify: vi.fn(),
  }),
}));
vi.mock("../auth/auth-return", () => ({ useAuthEntry: () => vi.fn() }));
vi.mock("../authors/author-dialog", () => ({
  AuthorDialog: ({
    children,
    title,
  }: {
    children: ReactNode;
    title: string;
  }) => {
    modal();
    return (
      <div role="dialog" aria-label={title}>
        {children}
      </div>
    );
  },
}));
import { ReportingCases } from "./reporting-cases";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const createdAt = "2026-10-23T00:00:00.000Z";
const report = {
  id: "case-synthetic",
  target: { type: "comment", id: "comment-synthetic" },
  kind: "quick_comment",
  reason: null,
  description: "合成案件正文",
  status: "open",
  createdAt,
  decision: null,
  appeal: null,
  messages: [],
  evidence: [],
};
const decision = {
  caseId: "case-synthetic",
  kind: "standard",
  target: { type: "work", id: "work-synthetic" },
  decision: {
    id: "decision-synthetic",
    action: "hide",
    reason: "合成处置理由",
    createdAt,
    reversedAt: null,
    reviewReason: null,
  },
  appeal: null,
  messages: [],
  evidence: [],
};
let root: Root, node: HTMLDivElement;
const mount = async (account = "user-synthetic", restricted = false) => {
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () =>
    root.render(<ReportingCases account={account} restricted={restricted} />),
  );
};
const button = (label: string) =>
  Array.from(node.querySelectorAll<HTMLButtonElement>("button")).find(
    (item) => item.textContent === label,
  )!;
const click = async (element: HTMLElement) => act(async () => element.click());
const fill = async (value: string) => {
  const area = node.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(area, value);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
beforeEach(() => {
  vi.clearAllMocks();
  client.list.mockResolvedValue({ items: [report], total: 1 });
  client.decisions.mockResolvedValue({ items: [decision], total: 1 });
  client.inbox.mockResolvedValue({ items: [] });
  client.material.mockResolvedValue(report);
  client.create.mockResolvedValue({
    ...report,
    kind: "rights_notice",
    reason: "copyright",
  });
  client.appeal.mockResolvedValue(decision);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
  window.history.replaceState({}, "", "/");
});
describe("own reporting cases", () => {
  it("labels a one-click comment reason truthfully and allows private supplementary material", async () => {
    await mount();
    expect(node.textContent).toContain("未提供原因（评论快捷举报）");
    expect(node.textContent).toContain("合成案件正文");
    await click(button("查看与补充材料"));
    await fill("合成补充说明");
    await click(button("补充材料"));
    expect(client.material).toHaveBeenCalledWith(
      "user-synthetic",
      "case-synthetic",
      { text: "合成补充说明", requestId: expect.any(String) },
    );
    expect(node.textContent).toContain("已收到材料");
  });
  it("submits a resolved quick-comment case as a source-bound formal notice without changing dialog history", async () => {
    const marker = { phase4Dialog: "synthetic-settings", phase4DialogDepth: 1 };
    window.history.replaceState(marker, "", "/#settings");
    const resolved = { ...report, status: "resolved" };
    client.list.mockResolvedValue({ items: [resolved], total: 1 });
    client.create.mockImplementationOnce(async () => {
      const formal = {
        ...report,
        id: "case-formal",
        kind: "rights_notice",
        reason: "copyright",
      };
      client.list.mockResolvedValue({ items: [resolved, formal], total: 2 });
      return formal;
    });
    await mount();
    expect(button("提交权利人投诉")).toBeUndefined();
    await click(button("查看与补充材料"));
    await click(button("提交权利人投诉"));
    const dialog = node.querySelector<HTMLElement>(
      '[data-report-embedded][aria-label="权利人投诉"]',
    )!;
    expect(dialog).not.toBeNull();
    expect(dialog.closest("article")?.textContent).toContain(
      "案件编号：case-synthetic",
    );
    expect(node.querySelector('[role="dialog"]')).toBeNull();
    expect(modal).not.toHaveBeenCalled();
    expect(window.history.state).toEqual(marker);
    expect(window.location.hash).toBe("#settings");
    expect(dialog.querySelector("select")!.disabled).toBe(true);
    const fields = [
      ...dialog.querySelectorAll<HTMLInputElement>('input:not([type="file"])'),
      ...dialog.querySelectorAll<HTMLTextAreaElement>("textarea"),
    ];
    for (const [index, element] of fields.entries()) {
      await act(async () => {
        const prototype =
          element instanceof HTMLInputElement
            ? HTMLInputElement.prototype
            : HTMLTextAreaElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
          element,
          [
            "合成权利人",
            "synthetic@example.com",
            "合成权属材料",
            "合成评论投诉说明",
          ][index],
        );
        element.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    await click(
      dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!,
    );
    expect(client.create).toHaveBeenCalledWith(
      "user-synthetic",
      expect.objectContaining({
        kind: "rights_notice",
        target: { type: "comment", id: "comment-synthetic" },
        reason: "copyright",
        claimantName: "合成权利人",
        rightsBasis: "合成权属材料",
        sourceCaseId: "case-synthetic",
      }),
    );
    expect(node.querySelector("[data-report-embedded]")).toBeNull();
    expect(node.textContent).toContain("case-formal");
    expect(node.textContent).toContain("已结案");
    expect(window.history.state).toEqual(marker);
    expect(window.location.hash).toBe("#settings");
  });
  it("binds an open rights form to its source case id when the same target also has another case", async () => {
    client.list.mockResolvedValue({
      items: [
        { ...report, status: "resolved" },
        {
          ...report,
          id: "case-new-legal",
          kind: "rights_notice",
          reason: "copyright",
        },
      ],
      total: 2,
    });
    await mount();
    const ownCase = (id: string) =>
      Array.from(node.querySelectorAll("article")).find((article) =>
        article.textContent?.includes(`案件编号：${id}`),
      )!;
    await click(
      ownCase("case-synthetic").querySelector<HTMLButtonElement>(
        "button[aria-expanded]",
      )!,
    );
    await click(button("提交权利人投诉"));
    expect(
      ownCase("case-synthetic").querySelectorAll("[data-report-embedded]"),
    ).toHaveLength(1);
    await click(
      ownCase("case-new-legal").querySelector<HTMLButtonElement>(
        "button[aria-expanded]",
      )!,
    );
    expect(
      ownCase("case-new-legal").querySelector("[data-report-embedded]"),
    ).toBeNull();
    expect(node.querySelectorAll("[data-report-embedded]")).toHaveLength(0);
    expect(client.create).not.toHaveBeenCalled();
  });
  it("closes an untouched private follow-up without adding dialog history or sending a report", async () => {
    const marker = { phase4Dialog: "synthetic-messages", phase4DialogDepth: 1 };
    window.history.replaceState(marker, "", "/#messages");
    await mount();
    await click(button("查看与补充材料"));
    await click(button("提交权利人投诉"));
    await click(button("关闭投诉表单"));
    expect(node.querySelector("[data-report-embedded]")).toBeNull();
    expect(client.create).not.toHaveBeenCalled();
    expect(modal).not.toHaveBeenCalled();
    expect(window.history.state).toEqual(marker);
    expect(window.location.hash).toBe("#messages");
  });
  it("does not offer another rights-notice upgrade for an already formal case", async () => {
    client.list.mockResolvedValue({
      items: [{ ...report, kind: "rights_notice", reason: "copyright" }],
      total: 1,
    });
    await mount();
    await click(button("查看与补充材料"));
    expect(button("提交权利人投诉")).toBeUndefined();
  });
  it("shows a specific decision and submits an appeal using its decision identity", async () => {
    await mount();
    await click(button("处置与申诉"));
    expect(node.textContent).toContain("合成处置理由");
    expect(button("提交不侵权声明")).toBeUndefined();
    await fill("合成申诉说明");
    await click(button("提交申诉"));
    expect(client.appeal).toHaveBeenCalledWith(
      "user-synthetic",
      "decision-synthetic",
      { text: "合成申诉说明", requestId: expect.any(String) },
    );
  });
  it.each([
    ["approve", "审核通过"],
    ["reject", "审核拒绝"],
    ["restore", "恢复内容"],
    ["delete_body", "删除正文"],
    ["remove_thread", "移除讨论串"],
  ] as const)(
    "labels a staff %s decision without fabricating reporter controls",
    async (action, label) => {
      client.decisions.mockResolvedValue({
        items: [
          {
            ...decision,
            kind: "moderation",
            decision: { ...decision.decision, action },
            appeal: null,
          },
        ],
        total: 1,
      });
      await mount("user-synthetic", true);
      expect(node.querySelector("h3")?.textContent).toBe(label);
      expect(node.textContent).toContain("管理审核决定");
      expect(node.textContent).toContain("审核记录编号：case-synthetic");
      expect(node.textContent).not.toContain("补充私有证据附件");
      expect(button("补充材料")).toBeUndefined();
      expect(button("提交权利人投诉")).toBeUndefined();
      expect(button("提交不侵权声明")).toBeUndefined();
      expect(client.list).not.toHaveBeenCalled();
    },
  );
  it("does not offer staff-origin evidence upload before an appeal is pending", async () => {
    client.decisions.mockResolvedValue({
      items: [{ ...decision, kind: "moderation" }],
      total: 1,
    });
    await mount("user-synthetic", true);
    expect(node.querySelector('input[type="file"]')).toBeNull();
    expect(button("上传附件")).toBeUndefined();
    expect(button("提交申诉")).toBeDefined();
    expect(button("补充材料")).toBeUndefined();
    expect(button("提交权利人投诉")).toBeUndefined();
    expect(button("提交不侵权声明")).toBeUndefined();
  });
  it.each([false, true])(
    "uploads only the affected account's pending staff-appeal evidence with restricted=%s",
    async (restricted) => {
      const account = `user-${(restricted ? "9" : "8").repeat(32)}`;
      const caseId = `report-${"7".repeat(32)}`;
      const earlier = {
        id: "evidence-own-earlier",
        fileName: "own-earlier-evidence",
        mimeType: "application/pdf",
        size: 12,
        sensitive: true,
        createdAt,
        downloadPath: `/v1/community/reports/${caseId}/evidence/evidence-own-earlier`,
      };
      const current = {
        ...decision,
        caseId,
        kind: "moderation",
        appeal: { text: "合成审核申诉", status: "pending", createdAt },
        evidence: [earlier],
      };
      client.decisions.mockResolvedValue({ items: [current], total: 1 });
      await mount(account, restricted);
      if (!restricted) await click(button("处置与申诉"));
      expect(button("own-earlier-evidence")).toBeDefined();
      const file = new File(["%PDF-1.4\nsynthetic"], "own-appeal-evidence", {
        type: "application/pdf",
      });
      const selectedClient = restricted ? appealEvidence : client.evidence;
      selectedClient.mockImplementationOnce(async () => {
        const uploaded = {
          ...earlier,
          id: "evidence-own-new",
          fileName: file.name,
          size: file.size,
        };
        client.decisions.mockResolvedValue({
          items: [{ ...current, evidence: [earlier, uploaded] }],
          total: 1,
        });
        return uploaded;
      });
      const input = node.querySelector<HTMLInputElement>('input[type="file"]')!;
      await act(async () => {
        Object.defineProperty(input, "files", {
          configurable: true,
          value: [file],
        });
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await act(async () => {
        button("上传附件").click();
        await vi.waitFor(() => expect(selectedClient).toHaveBeenCalledOnce());
      });
      expect(selectedClient).toHaveBeenCalledWith(account, caseId, {
        fileName: "own-appeal-evidence",
        mimeType: "application/pdf",
        contentBase64: btoa("%PDF-1.4\nsynthetic"),
        sensitive: true,
        requestId: expect.any(String),
      });
      expect(
        restricted ? client.evidence : appealEvidence,
      ).not.toHaveBeenCalled();
      expect(button("own-appeal-evidence")).toBeDefined();
      expect(button("补充材料")).toBeUndefined();
      expect(button("提交权利人投诉")).toBeUndefined();
      expect(button("提交不侵权声明")).toBeUndefined();
      expect(client.material).not.toHaveBeenCalled();
      expect(client.statement).not.toHaveBeenCalled();
      expect(client.create).not.toHaveBeenCalled();
    },
  );
  it("keeps only the affected account's existing files readable after a staff appeal closes", async () => {
    const ownEvidence = {
      id: "evidence-own",
      fileName: "own-closed-appeal-evidence",
      mimeType: "application/pdf",
      size: 12,
      sensitive: true,
      createdAt,
      downloadPath:
        "/v1/community/reports/case-synthetic/evidence/evidence-own",
    };
    client.decisions.mockResolvedValue({
      items: [
        {
          ...decision,
          kind: "moderation",
          evidence: [ownEvidence],
          appeal: { text: "合成申诉", status: "upheld", createdAt },
        },
      ],
      total: 1,
    });
    await mount("user-synthetic", true);
    expect(button("own-closed-appeal-evidence")).toBeDefined();
    expect(node.querySelector('input[type="file"]')).toBeNull();
    expect(button("上传附件")).toBeUndefined();
  });
  it("lets an affected account appeal a staff rejection through the restricted decisions view", async () => {
    client.decisions.mockResolvedValue({
      items: [
        {
          ...decision,
          kind: "moderation",
          decision: { ...decision.decision, action: "reject" },
        },
      ],
      total: 1,
    });
    await mount("user-synthetic", true);
    await fill("合成拒绝审核申诉");
    await click(button("提交申诉"));
    expect(client.appeal).toHaveBeenCalledWith(
      "user-synthetic",
      "decision-synthetic",
      { text: "合成拒绝审核申诉", requestId: expect.any(String) },
    );
    expect(node.textContent).not.toContain("补充私有证据附件");
  });
  it("states that an overturned staff rejection returns to pending review and remains unpublished", async () => {
    client.decisions.mockResolvedValue({
      items: [
        {
          ...decision,
          kind: "moderation",
          decision: {
            ...decision.decision,
            action: "reject",
            reversedAt: createdAt,
            reviewReason: "合成复核纠正",
          },
          appeal: { text: "合成审核申诉", status: "overturned", createdAt },
        },
      ],
      total: 1,
    });
    await mount("user-synthetic", true);
    expect(node.textContent).toContain(
      "拒绝决定已撤销，内容已返回原审核队列，仍未发布。",
    );
    expect(button("提交申诉")).toBeUndefined();
    expect(node.textContent).not.toContain("补充私有证据附件");
    expect(button("提交权利人投诉")).toBeUndefined();
  });
  it.each([
    ["delete_body", "删除正文的决定已纠正；已删除的文字无法恢复。"],
    [
      "remove_thread",
      "移除讨论串的决定已纠正；其他仍有效的处置可能继续限制相关内容。",
    ],
  ] as const)(
    "explains the limits of correcting a staff %s decision",
    async (action, message) => {
      client.decisions.mockResolvedValue({
        items: [
          {
            ...decision,
            kind: "moderation",
            decision: {
              ...decision.decision,
              action,
              reversedAt: createdAt,
              reviewReason: "合成复核理由",
            },
            appeal: { text: "合成审核申诉", status: "overturned", createdAt },
          },
        ],
        total: 1,
      });
      await mount("user-synthetic", true);
      expect(node.textContent).toContain(message);
      expect(node.textContent).toContain("合成复核理由");
      expect(button("提交申诉")).toBeUndefined();
      expect(node.textContent).not.toContain("补充私有证据附件");
    },
  );
  it("offers a non-infringement statement only for a rights-holder notice", async () => {
    client.decisions.mockResolvedValue({
      items: [{ ...decision, kind: "rights_notice" }],
      total: 1,
    });
    await mount("user-synthetic", true);
    const form = button("提交不侵权声明").closest("form")!;
    const area = form.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(area, "合成不侵权声明");
      area.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(button("提交不侵权声明"));
    expect(client.statement).toHaveBeenCalledWith(
      "user-synthetic",
      "case-synthetic",
      { text: "合成不侵权声明", requestId: expect.any(String) },
    );
    expect(client.list).not.toHaveBeenCalled();
    expect(client.inbox).not.toHaveBeenCalled();
    expect(node.querySelector('[role="tablist"]')).toBeNull();
  });
  it("discards private responses across account changes", async () => {
    let finish!: (value: unknown) => void;
    client.list
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValueOnce({ items: [], total: 0 });
    await mount("user-before");
    await act(async () => root.render(<ReportingCases account="user-after" />));
    await act(async () => finish({ items: [report], total: 1 }));
    expect(node.textContent).not.toContain("合成案件正文");
    expect(node.textContent).toContain("暂无记录");
  });
});

describe("system result presentation", () => {
  const reason = "原始 warn 理由。";
  const reporterText = `举报已处理：warn。${reason}`;
  const affectedText = `处理措施：warn。理由：${reason}。可在举报与申诉中申请复核。`;
  const noWrites = () => {
    for (const write of [
      client.create,
      client.material,
      client.appeal,
      client.statement,
      client.evidence,
      client.read,
      appealEvidence,
    ])
      expect(write).not.toHaveBeenCalled();
  };
  it.each([
    {
      party: "reporter",
      text: reporterText,
      expected: `举报已处理：警告。${reason}`,
    },
    {
      party: "affected",
      text: affectedText,
      expected: `处理措施：警告。理由：${reason}。可在举报与申诉中申请复核。`,
    },
  ] as const)(
    "localizes the actual older $party decision template while preserving all trailing text",
    async ({ party, text, expected }) => {
      const notice = "举报已处理：warn。管理员 notice 原文保持 warn。";
      const statement = "处理措施：warn。用户 statement 原文保持 warn。";
      const messages = [
        { id: "system-result", kind: "result" as const, text, createdAt },
        {
          id: "operator-notice",
          kind: "notice" as const,
          text: notice,
          createdAt,
        },
        {
          id: "user-statement",
          kind: "statement" as const,
          text: statement,
          createdAt,
        },
      ];
      const originals = messages.map((message) => message.text);
      const decided = { ...decision.decision, action: "warn" as const, reason };
      client.list.mockResolvedValue({
        items: [{ ...report, status: "resolved", decision: decided, messages }],
        total: 1,
      });
      client.decisions.mockResolvedValue({
        items: [{ ...decision, decision: decided, messages }],
        total: 1,
      });
      await mount();
      await click(
        button(party === "reporter" ? "查看与补充材料" : "处置与申诉"),
      );
      const paragraphs = Array.from(
        node.querySelectorAll("p"),
        (paragraph) => paragraph.textContent,
      );
      expect(paragraphs).toContain(expected);
      expect(paragraphs).not.toContain(text);
      expect(paragraphs).toContain(notice);
      expect(paragraphs).toContain(statement);
      expect(messages.map((message) => message.text)).toEqual(originals);
      noWrites();
    },
  );
  it.each([
    ["reporter", "uphold", "维持原决定"],
    ["reporter", "overturn", "已纠正原决定"],
    ["affected", "uphold", "维持原决定"],
    ["affected", "overturn", "已纠正原决定"],
  ] as const)(
    "localizes the actual %s review %s template without rewriting its reason",
    async (party, outcome, label) => {
      const reviewReason = "原始 uphold 与 overturn 理由。";
      const text = `复核结果：${outcome}。${reviewReason}`;
      const literal = `复核结果：${outcome}。statement 中的 ${outcome} 保持不变。`;
      const messages = [
        { id: "review-result", kind: "result" as const, text, createdAt },
        {
          id: "review-statement",
          kind: "statement" as const,
          text: literal,
          createdAt,
        },
      ];
      const originals = messages.map((message) => message.text);
      const reviewed = {
        ...decision.decision,
        reversedAt: outcome === "overturn" ? createdAt : null,
        reviewReason,
      };
      const appeal = {
        text: "合成原申诉",
        status:
          outcome === "uphold" ? ("upheld" as const) : ("overturned" as const),
        createdAt,
      };
      client.list.mockResolvedValue({
        items: [
          {
            ...report,
            status: "resolved",
            decision: reviewed,
            appeal,
            messages,
          },
        ],
        total: 1,
      });
      client.decisions.mockResolvedValue({
        items: [{ ...decision, decision: reviewed, appeal, messages }],
        total: 1,
      });
      await mount();
      await click(
        button(party === "reporter" ? "查看与补充材料" : "处置与申诉"),
      );
      const paragraphs = Array.from(
        node.querySelectorAll("p"),
        (paragraph) => paragraph.textContent,
      );
      expect(paragraphs).toContain(`复核结果：${label}。${reviewReason}`);
      expect(paragraphs).not.toContain(text);
      expect(paragraphs).toContain(literal);
      expect(messages.map((message) => message.text)).toEqual(originals);
      noWrites();
    },
  );
  it("localizes only explicitly typed system-inbox results and leaves notice/statement text immutable", async () => {
    const inbox: CommunityReportingInbox = {
      items: [
        {
          id: "result-reporter",
          caseId: "case-synthetic",
          kind: "result",
          text: reporterText,
          createdAt,
          readAt: null,
        },
        {
          id: "result-affected",
          caseId: "case-synthetic",
          kind: "result",
          text: affectedText,
          createdAt,
          readAt: null,
        },
        {
          id: "result-uphold",
          caseId: "case-synthetic",
          kind: "result",
          text: "复核结果：uphold。原始 uphold 理由。",
          createdAt,
          readAt: null,
        },
        {
          id: "result-overturn",
          caseId: "case-synthetic",
          kind: "result",
          text: "复核结果：overturn。原始 overturn 理由。",
          createdAt,
          readAt: null,
        },
        {
          id: "notice-reporter-prefix",
          caseId: "case-synthetic",
          kind: "notice",
          text: "举报已处理：warn。notice 原文保持 warn。",
          createdAt,
          readAt: null,
        },
        {
          id: "notice-affected-prefix",
          caseId: "case-synthetic",
          kind: "notice",
          text: "处理措施：warn。notice 原文保持 warn。",
          createdAt,
          readAt: null,
        },
        {
          id: "statement-action-prefix",
          caseId: "case-synthetic",
          kind: "statement",
          text: "举报已处理：warn。statement 原文保持 warn。",
          createdAt,
          readAt: null,
        },
        {
          id: "statement-review-prefix",
          caseId: "case-synthetic",
          kind: "statement",
          text: "复核结果：overturn。statement 原文保持 overturn。",
          createdAt,
          readAt: null,
        },
        {
          id: "unrecognized-result",
          caseId: "case-synthetic",
          kind: "result",
          text: "复核结果：pending。未知编码 pending 保持不变。",
          createdAt,
          readAt: null,
        },
      ],
    };
    const originals = inbox.items.map((item) => ({ ...item }));
    client.inbox.mockResolvedValue(inbox);
    await mount();
    await click(button("系统通知"));
    const paragraphs = Array.from(
      node.querySelectorAll("p"),
      (paragraph) => paragraph.textContent,
    );
    expect(paragraphs).toContain(`举报已处理：警告。${reason}`);
    expect(paragraphs).toContain(
      `处理措施：警告。理由：${reason}。可在举报与申诉中申请复核。`,
    );
    expect(paragraphs).toContain("复核结果：维持原决定。原始 uphold 理由。");
    expect(paragraphs).toContain(
      "复核结果：已纠正原决定。原始 overturn 理由。",
    );
    for (const item of inbox.items.filter(
      (item) => item.kind !== "result" || item.id === "unrecognized-result",
    ))
      expect(paragraphs).toContain(item.text);
    for (const item of inbox.items.filter(
      (item) => item.kind === "result" && item.id !== "unrecognized-result",
    ))
      expect(paragraphs).not.toContain(item.text);
    expect(client.inbox).toHaveBeenCalled();
    expect(inbox.items).toEqual(originals);
    noWrites();
  });
});
