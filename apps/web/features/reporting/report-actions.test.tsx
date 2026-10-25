// @vitest-environment jsdom
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { author, enterAuth, create, evidence } = vi.hoisted(() => ({
  author: {
    viewer: { id: "user-synthetic" } as { id: string } | null,
    checking: false,
    sessionError: false,
    signInHref: "/login",
    notify: vi.fn(),
  },
  enterAuth: vi.fn(),
  create: vi.fn(),
  evidence: vi.fn(),
}));
vi.mock("../authors/author-context", () => ({ useAuthors: () => author }));
vi.mock("../auth/auth-return", () => ({ useAuthEntry: () => enterAuth }));
vi.mock("../authors/author-dialog", () => ({
  AuthorDialog: ({
    children,
    title,
  }: {
    children: ReactNode;
    title: string;
  }) => (
    <div role="dialog" aria-label={title}>
      {children}
    </div>
  ),
}));
vi.mock("./reporting-data", () => ({
  reportingClient: { create, evidence },
  ReportingRequestError: class extends Error {},
}));
import { QuickCommentReport, ReportDialog, ReportMenu } from "./report-actions";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, node: HTMLDivElement;
const mount = async (element: ReactNode) => {
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () => root.render(element));
};
const click = async (element: Element | null) => {
  if (!(element instanceof HTMLElement)) throw new Error("missing control");
  await act(async () => element.click());
};
const chooseReason = async (value: string) => {
  const select = node.querySelector("select")!;
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
};
beforeEach(() => {
  vi.clearAllMocks();
  author.viewer = { id: "user-synthetic" };
  author.checking = false;
  author.sessionError = false;
  create.mockResolvedValue({ id: "report-synthetic" });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
});
describe("reporting entry behavior", () => {
  it("sends a comment with one quiet symbol, no visible label, no form, reason or dialog", async () => {
    let finish!: (value: unknown) => void;
    create.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await mount(<QuickCommentReport id="comment-synthetic" />);
    const flag = node.querySelector<HTMLButtonElement>("button")!;
    expect(flag.getAttribute("aria-label")).toBe("举报评论");
    expect(flag.textContent).toBe("");
    expect(flag.querySelector("svg")).not.toBeNull();
    await click(flag);
    await click(flag);
    expect(flag.disabled).toBe(true);
    expect(
      node.querySelector("dialog, [role=dialog], form, select, textarea"),
    ).toBeNull();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![1]).toEqual({
      kind: "quick_comment",
      target: { type: "comment", id: "comment-synthetic" },
      requestId: expect.any(String),
    });
    expect(create.mock.calls[0]![1]).not.toHaveProperty("reason");
    await act(async () => finish({ id: "report-synthetic" }));
    expect(flag.disabled).toBe(true);
    expect(flag.getAttribute("aria-label")).toBe("已举报评论");
    expect(author.notify).toHaveBeenCalledWith("已收到举报");
  });
  it("allows a failed quick report to retry with the same idempotency key", async () => {
    create.mockRejectedValueOnce(new Error("服务暂不可用"));
    await mount(<QuickCommentReport id="reply-synthetic" />);
    await click(node.querySelector("button"));
    expect(node.querySelector<HTMLButtonElement>("button")!.disabled).toBe(
      false,
    );
    expect(author.notify).toHaveBeenCalledWith("服务暂不可用");
    await click(node.querySelector("button"));
    expect(create.mock.calls[0]![1]).toEqual(create.mock.calls[1]![1]);
  });
  it("requires another click after login and never auto-reports", async () => {
    author.viewer = null;
    await mount(<QuickCommentReport id="comment-synthetic" />);
    await click(node.querySelector("button"));
    expect(enterAuth).toHaveBeenCalledWith("/login", expect.any(HTMLElement));
    expect(create).not.toHaveBeenCalled();
    author.viewer = { id: "user-synthetic" };
    await act(async () =>
      root.render(<QuickCommentReport id="comment-synthetic" />),
    );
    expect(create).not.toHaveBeenCalled();
    await click(node.querySelector("button"));
    expect(create).toHaveBeenCalledOnce();
  });
  it.each(["work", "user", "catalog", "article", "thread"] as const)(
    "requires a selected reason for %s, with optional explanation",
    async (type) => {
      await mount(
        <ReportDialog
          target={{ type, id: "target-synthetic" }}
          sourceCaseId="case-retained"
          onClose={vi.fn()}
        />,
      );
      const submit = node.querySelector<HTMLButtonElement>(
        'button[type="submit"]',
      )!;
      expect(node.querySelector("select")!.required).toBe(true);
      expect(submit.disabled).toBe(true);
      await click(submit);
      expect(create).not.toHaveBeenCalled();
      await chooseReason("harassment");
      expect(submit.disabled).toBe(false);
      await click(submit);
      expect(create).toHaveBeenCalledWith("user-synthetic", {
        kind: "standard",
        target: { type, id: "target-synthetic" },
        reason: "harassment",
        requestId: expect.any(String),
      });
      expect(evidence).not.toHaveBeenCalled();
    },
  );
  it.each(["comment-synthetic", "reply-synthetic"])(
    "requires a complete private rights notice for %s without offering a standard comment form",
    async (id) => {
      await mount(
        <ReportDialog
          target={{ type: "comment", id }}
          sourceCaseId="case-retained"
          rightsOnly
          onClose={vi.fn()}
        />,
      );
      const reason = node.querySelector<HTMLSelectElement>("select")!;
      expect(reason.value).toBe("copyright");
      expect(reason.disabled).toBe(true);
      expect(node.querySelector('[type="checkbox"]')).toBeNull();
      const submit = node.querySelector<HTMLButtonElement>(
        'button[type="submit"]',
      )!;
      expect(submit.textContent).toBe("提交权利人投诉");
      expect(submit.disabled).toBe(true);
      const inputs = node.querySelectorAll<HTMLInputElement>(
        'input:not([type="file"])',
      );
      const areas = node.querySelectorAll<HTMLTextAreaElement>("textarea");
      expect(inputs).toHaveLength(2);
      expect(areas).toHaveLength(2);
      for (const [element, value] of [
        [inputs[0]!, "合成权利人"],
        [inputs[1]!, "synthetic@example.com"],
        [areas[0]!, "合成权属证明"],
        [areas[1]!, "合成评论侵权说明"],
      ] as const) {
        expect(element.required).toBe(true);
        await act(async () => {
          const prototype =
            element instanceof HTMLInputElement
              ? HTMLInputElement.prototype
              : HTMLTextAreaElement.prototype;
          Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
            element,
            value,
          );
          element.dispatchEvent(new Event("input", { bubbles: true }));
        });
      }
      expect(submit.disabled).toBe(false);
      await click(submit);
      expect(create).toHaveBeenCalledWith("user-synthetic", {
        kind: "rights_notice",
        target: { type: "comment", id },
        reason: "copyright",
        claimantName: "合成权利人",
        contact: "synthetic@example.com",
        rightsBasis: "合成权属证明",
        description: "合成评论侵权说明",
        sourceCaseId: "case-retained",
        requestId: expect.any(String),
      });
      expect(create.mock.calls[0]![1].kind).not.toBe("standard");
    },
  );
  it("opens the post reason form through its existing operation-menu pattern", async () => {
    await mount(<ReportMenu target={{ type: "work", id: "work-synthetic" }} />);
    expect(node.querySelector("form")).toBeNull();
    await click(node.querySelector('[aria-label="更多操作"]'));
    await click(node.querySelector('[role="menuitem"]'));
    expect(node.querySelector('[role="dialog"]')).not.toBeNull();
    expect(node.querySelector("select")).not.toBeNull();
    expect(create).not.toHaveBeenCalled();
  });
  it("sends signed-out post and account reporters to login before opening a form", async () => {
    author.viewer = null;
    await mount(<ReportMenu target={{ type: "user", id: "user-target" }} />);
    await click(node.querySelector('[aria-label="更多操作"]'));
    await click(node.querySelector('[role="menuitem"]'));
    expect(enterAuth).toHaveBeenCalledOnce();
    expect(node.querySelector("form")).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });
});
