// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { submit } = vi.hoisted(() => ({ submit: vi.fn() }));
vi.mock("../../lib/public-api/feedback-client", () => ({
  feedbackClient: { submit },
}));
import { SettingsFeedbackForm, useSettingsFeedback } from "./feedback-form";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let node: HTMLDivElement;
let feedback: ReturnType<typeof useSettingsFeedback>;
const owner = "user-00000000000000000000000000000001";
const Harness = ({ account }: { account: string | null }) => {
  feedback = useSettingsFeedback(account);
  return <SettingsFeedbackForm feedback={feedback} />;
};
const render = async (account: string | null = owner) =>
  act(async () => root.render(<Harness account={account} />));
const input = async (message: string) =>
  act(async () => feedback.setMessage(message));
const send = async () =>
  act(async () => {
    await feedback.submit();
  });
beforeEach(async () => {
  vi.clearAllMocks();
  submit.mockResolvedValue({
    id: "feedback-00000000000000000000000000000001",
    createdAt: "2026-10-23T12:00:00.000Z",
  });
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await render();
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
});
describe("settings feedback", () => {
  it("rejects whitespace and oversize before submission", async () => {
    await input(" \n ");
    await send();
    expect(node.querySelector('[role="alert"]')?.textContent).toContain(
      "请填写",
    );
    await input("字".repeat(5001));
    await send();
    expect(node.querySelector('[role="alert"]')?.textContent).toContain("5000");
    expect(submit).not.toHaveBeenCalled();
  });
  it("waits for the backend and synchronously blocks duplicate submissions", async () => {
    let resolve!: (value: unknown) => void;
    submit.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await input("  搜索建议  ");
    let first!: Promise<void>;
    await act(async () => {
      first = feedback.submit();
      void feedback.submit();
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]?.[0]).toMatchObject({ message: "搜索建议" });
    expect(node.querySelector("button")?.disabled).toBe(true);
    expect(node.textContent).not.toContain("反馈已提交");
    await act(async () => {
      resolve({
        id: "feedback-00000000000000000000000000000001",
        createdAt: "2026-10-23T12:00:00.000Z",
      });
      await first;
    });
    expect(feedback.message).toBe("");
    expect(feedback.dirty).toBe(false);
    expect(node.textContent).toContain("反馈已提交");
  });
  it("retains failed drafts and reuses the same key for a retry", async () => {
    submit.mockRejectedValueOnce(new Error("timeout"));
    await input("保留这条建议");
    await send();
    const key = submit.mock.calls[0]?.[0].submissionId;
    expect(feedback.message).toBe("保留这条建议");
    expect(feedback.dirty).toBe(true);
    expect(node.querySelector('[role="alert"]')).not.toBeNull();
    await send();
    expect(submit.mock.calls[1]?.[0].submissionId).toBe(key);
    expect(node.textContent).toContain("反馈已提交");
  });
  it("uses a new key when the user edits a failed message", async () => {
    submit.mockRejectedValueOnce(new Error("timeout"));
    await input("第一条");
    await send();
    const key = submit.mock.calls[0]?.[0].submissionId;
    await input("修订内容");
    await send();
    expect(submit.mock.calls[1]?.[0].submissionId).not.toBe(key);
  });
  it("clears private state on account change and ignores a late result", async () => {
    let resolve!: (value: unknown) => void;
    submit.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await input("账户 A 的反馈");
    let first!: Promise<void>;
    await act(async () => {
      first = feedback.submit();
    });
    const signal = submit.mock.calls[0]?.[1] as AbortSignal;
    await render("user-00000000000000000000000000000002");
    expect(signal.aborted).toBe(true);
    expect(feedback.message).toBe("");
    await act(async () => {
      resolve({});
      await first;
    });
    expect(node.textContent).not.toContain("反馈已提交");
    expect(feedback.pending).toBe(false);
  });
  it("clears logout drafts and refuses a guest submission", async () => {
    await input("账户私密草稿");
    await render(null);
    await send();
    expect(feedback.message).toBe("");
    expect(submit).not.toHaveBeenCalled();
  });
});
