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

const runtime = await vi.hoisted(async () => {
  const { createRequire } = await import("node:module");
  const { realpathSync } = await import("node:fs");
  const { join } = await import("node:path");
  const require = createRequire(
    join(import.meta.dirname, "../../../apps/admin/"),
  );
  return {
    ui: realpathSync(require.resolve("@payloadcms/ui")),
    link: realpathSync(require.resolve("next/link")),
    call: vi.fn(),
  };
});
vi.mock(runtime.ui, () => ({ SetStepNav: () => null }));
vi.mock(runtime.link, () => ({
  default: ({ children, ...props }: { children: ReactNode; href: string }) =>
    createElement("a", props, children),
}));
vi.mock("admin/community-api", async (original) => ({
  ...(await original<object>()),
  call: runtime.call,
}));

import { CommunityFeedbackClient } from "admin/community-feedback-client";
import { OperatorFailure } from "admin/community-api";

const feedback = {
  id: "feedback-" + "a".repeat(32),
  message: "完整反馈<script>保持纯文本</script>",
  user: { id: "user-" + "b".repeat(32), displayName: "测试用户" },
  createdAt: "2026-10-23T12:00:00.000Z",
};
const page = (number = 1) => ({
  items: [{ ...feedback, id: feedback.id }],
  total: 21,
  page: number,
  pageSize: 20,
});
beforeEach(() => {
  runtime.call.mockReset();
  runtime.call.mockImplementation(async (_name, input: { page: number }) =>
    page(input.page),
  );
});
afterEach(cleanup);

describe("Owner feedback list", () => {
  it("shows the submitted message and submitter as text and pages through the operator read", async () => {
    const { container } = render(<CommunityFeedbackClient />);
    await screen.findByText(feedback.message);
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByText(feedback.user.displayName)).toBeTruthy();
    expect(screen.getByText(`用户 ID：${feedback.user.id}`)).toBeTruthy();
    expect(runtime.call).toHaveBeenCalledWith(
      "read-feedback",
      { page: 1, pageSize: 20 },
      expect.any(AbortSignal),
    );
    const firstSignal = runtime.call.mock.calls[0]![2] as AbortSignal;
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "下一页" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() =>
      expect(runtime.call).toHaveBeenCalledWith(
        "read-feedback",
        { page: 2, pageSize: 20 },
        expect.any(AbortSignal),
      ),
    );
    await screen.findByText("共 21 条 · 第 2 / 2 页");
    expect(firstSignal.aborted).toBe(true);
    expect(
      (screen.getByRole("button", { name: "下一页" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "刷新反馈" }));
    await screen.findByText("共 21 条 · 第 1 / 2 页");
  });

  it("offers a retry for an unavailable read and distinguishes an empty result", async () => {
    runtime.call.mockRejectedValueOnce(
      new OperatorFailure("OPERATOR_UNAVAILABLE", "unavailable", 503),
    );
    runtime.call.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });
    render(<CommunityFeedbackClient />);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "社区数据暂时不可用",
    );
    expect(screen.queryByText("暂无用户反馈。")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByText("暂无用户反馈。");
    expect(runtime.call).toHaveBeenCalledTimes(2);
  });

  it("cancels an in-flight read when the Owner leaves the view", () => {
    runtime.call.mockImplementation(() => new Promise(() => {}));
    const { unmount } = render(<CommunityFeedbackClient />);
    const signal = runtime.call.mock.calls[0]![2] as AbortSignal;
    expect(signal.aborted).toBe(false);
    unmount();
    expect(signal.aborted).toBe(true);
  });
});
