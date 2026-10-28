// @vitest-environment jsdom
import { createElement, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import type {
  OperatorUser,
  OperatorWork,
} from "@moya/contracts/internal/community-operator";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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
    navigation: realpathSync(require.resolve("next/navigation")),
    link: realpathSync(require.resolve("next/link")),
    params: new URLSearchParams(),
    call: vi.fn(),
    modal: "",
    listeners: new Set<() => void>(),
  };
});
const setModal = (slug: string) => {
  runtime.modal = slug;
  for (const listener of runtime.listeners) listener();
};
vi.mock(runtime.ui, () => ({
  SetStepNav: () => null,
  useModal: () => ({ openModal: setModal, closeModal: () => setModal("") }),
  ConfirmationModal: ({
    heading,
    body,
    modalSlug,
    onConfirm,
    onCancel,
    confirmLabel,
  }: {
    heading: string;
    body: ReactNode;
    modalSlug: string;
    onConfirm: () => Promise<void> | void;
    onCancel?: () => void;
    confirmLabel: string;
  }) => {
    const current = useSyncExternalStore(
      (listener) => {
        runtime.listeners.add(listener);
        return () => runtime.listeners.delete(listener);
      },
      () => runtime.modal,
    );
    return current === modalSlug
      ? createElement(
          "section",
          { role: "dialog", "aria-label": heading },
          body,
          createElement(
            "button",
            { onClick: () => void onConfirm() },
            confirmLabel,
          ),
          createElement(
            "button",
            {
              onClick: () => {
                setModal("");
                onCancel?.();
              },
            },
            "取消",
          ),
        )
      : null;
  },
}));
vi.mock(runtime.navigation, () => ({ useSearchParams: () => runtime.params }));
vi.mock(runtime.link, () => ({
  default: ({ children, ...props }: { children: ReactNode; href: string }) =>
    createElement("a", props, children),
}));
vi.mock("admin/community-api", async (original) => ({
  ...(await original<object>()),
  call: runtime.call,
}));
import { CommunityContentClient } from "admin/community-content-client";
import { OperatorFailure } from "admin/community-api";

const author: OperatorUser = {
  id: `user-${"c".repeat(32)}`,
  handle: "synthetic-author",
  displayName: "合成作者",
  bio: "",
  status: "active",
  createdAt: "2026-10-01T00:00:00Z",
  submittedWorks: 2,
  recommended: false,
  recommendationVersion: 0,
};
const work = (letter = "a"): OperatorWork => ({
  id: `work-${letter.repeat(32)}`,
  title: `合成作品 ${letter}`,
  text: "隔离测试正文",
  authorId: author.id,
  authorName: author.displayName,
  authorStatus: "active",
  state: "visible",
  authorDeleted: false,
  publiclyVisible: true,
  version: 1,
  firstPublishedAt: "2026-10-01T00:00:00Z",
});
let rows: OperatorWork[];
const reads = (name: string) => {
  if (name === "read-users")
    return { items: [author], total: 1, page: 1, pageSize: 20 };
  if (name === "read-works")
    return { items: rows, total: rows.length, page: 1, pageSize: 20 };
  throw new Error(`Unexpected synthetic request: ${name}`);
};
const writes = () =>
  runtime.call.mock.calls.filter(([name]) => name === "moderate-work");
const button = async (name: string) => {
  const element = await screen.findByRole("button", { name });
  await waitFor(() => expect(element.hasAttribute("disabled")).toBe(false));
  return element;
};
const reason = () =>
  screen.getByRole("textbox", { name: "作品处置理由（必填）" });
const fillReason = (value = "  合成验收理由  ") =>
  fireEvent.change(reason(), { target: { value } });
const confirm = () =>
  fireEvent.click(screen.getByRole("button", { name: "确认保存" }));

beforeEach(() => {
  runtime.params = new URLSearchParams();
  runtime.modal = "";
  rows = [work()];
  runtime.call
    .mockReset()
    .mockImplementation(async (name: string) => reads(name));
  window.history.replaceState(null, "", "/admin/community-moderation/content");
});
afterEach(cleanup);

describe("work moderation prerequisites and recovery", () => {
  it.each([false, true])(
    "explains blank reasons without a command in the author-filtered=%s list",
    async (filtered) => {
      runtime.params = new URLSearchParams(
        filtered ? `author=${author.id}` : "",
      );
      render(createElement(CommunityContentClient));
      const hide = await button("隐藏作品");
      fireEvent.click(hide);
      const field = reason();
      expect(document.activeElement).toBe(field);
      expect(field.getAttribute("aria-invalid")).toBe("true");
      const message = screen.getByRole("alert");
      expect(message.textContent).toContain("请填写 1–2000 字");
      expect(field.getAttribute("aria-describedby")?.split(" ")).toContain(
        message.id,
      );
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(writes()).toHaveLength(0);
      fillReason("   ");
      fireEvent.click(await button("移除作品"));
      expect(document.activeElement).toBe(field);
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(writes()).toHaveLength(0);
      expect(
        runtime.call.mock.calls.find(([name]) => name === "read-works")?.[1],
      ).toMatchObject(filtered ? { authorId: author.id } : { search: "" });
    },
  );

  it("requires confirmation, freezes the trimmed reason, updates the row and supports another action", async () => {
    runtime.call.mockImplementation(
      async (name: string, input: { state: OperatorWork["state"] }) => {
        if (name !== "moderate-work") return reads(name);
        rows = [
          { ...rows[0]!, state: input.state, version: rows[0]!.version + 1 },
        ];
        return rows[0];
      },
    );
    render(createElement(CommunityContentClient));
    await button("隐藏作品");
    fillReason();
    fireEvent.click(await button("隐藏作品"));
    expect(screen.getByRole("dialog").textContent).toContain(
      "处置理由：合成验收理由",
    );
    expect(writes()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(writes()).toHaveLength(0);
    fireEvent.click(await button("隐藏作品"));
    fillReason("后来编辑但尚未确认的理由");
    confirm();
    await screen.findByText("隐藏作品「合成作品 a」已保存。");
    expect(writes()[0]?.[1]).toMatchObject({
      reason: "合成验收理由",
      state: "hidden",
      expectedVersion: 1,
    });
    expect(screen.getByText("已隐藏")).toBeTruthy();
    fireEvent.click(await button("移除作品"));
    confirm();
    await screen.findByText("移除作品「合成作品 a」已保存。");
    expect(writes()).toHaveLength(2);
    expect(writes()[1]?.[1]).toMatchObject({
      state: "removed",
      expectedVersion: 2,
    });
    expect(writes()[1]?.[1].requestId).not.toBe(writes()[0]?.[1].requestId);
  });

  it.each(["COMMUNITY_OWNER_ONLY", "COMMAND_INVALID"])(
    "releases pending controls after the final refusal %s",
    async (code) => {
      let reject!: (error: Error) => void;
      runtime.call.mockImplementation((name: string) =>
        name === "moderate-work"
          ? new Promise((_resolve, fail) => {
              reject = fail;
            })
          : Promise.resolve(reads(name)),
      );
      const view = render(createElement(CommunityContentClient));
      await button("隐藏作品");
      fillReason();
      fireEvent.click(await button("隐藏作品"));
      confirm();
      await screen.findByText("正在保存操作，请等待结果…");
      expect(view.container.firstElementChild?.getAttribute("aria-busy")).toBe(
        "true",
      );
      expect(
        screen
          .getByRole("button", { name: "移除作品" })
          .hasAttribute("disabled"),
      ).toBe(true);
      await act(async () =>
        reject(new OperatorFailure(code, "Synthetic refusal", 403)),
      );
      await button("移除作品");
      expect(view.container.firstElementChild?.getAttribute("aria-busy")).toBe(
        "false",
      );
      expect(screen.queryByText("正在保存操作，请等待结果…")).toBeNull();
      expect(screen.queryByRole("button", { name: "重试同一操作" })).toBeNull();
      expect(writes()).toHaveLength(1);
      expect(screen.getByText("正常")).toBeTruthy();
    },
  );

  it("offers reconciliation after an unknown response and reuses the exact command", async () => {
    let attempt = 0;
    runtime.call.mockImplementation(async (name: string) => {
      if (name !== "moderate-work") return reads(name);
      if (++attempt === 1)
        throw new OperatorFailure(
          "OPERATOR_UNREACHABLE",
          "Synthetic lost response",
        );
      rows = [{ ...rows[0]!, state: "hidden", version: 2 }];
      return rows[0];
    });
    render(createElement(CommunityContentClient));
    await button("隐藏作品");
    fillReason();
    fireEvent.click(await button("隐藏作品"));
    confirm();
    const retry = await screen.findByRole("button", { name: "重试同一操作" });
    expect(screen.queryByText("正在保存操作，请等待结果…")).toBeNull();
    expect(
      screen.getByRole("button", { name: "移除作品" }).hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(retry);
    await screen.findByText("隐藏作品「合成作品 a」已保存。");
    expect(writes()).toHaveLength(2);
    expect(writes()[1]?.[1]).toEqual(writes()[0]?.[1]);
    await button("移除作品");
  });

  it("keeps a requested single-item reason editable when selection had hidden it", async () => {
    render(createElement(CommunityContentClient));
    await button("隐藏作品");
    fireEvent.click(
      screen.getByRole("checkbox", { name: "选择作品：合成作品 a" }),
    );
    expect(
      screen.queryByRole("textbox", { name: "作品处置理由（必填）" }),
    ).toBeNull();
    fireEvent.click(await button("隐藏作品"));
    expect(document.activeElement).toBe(reason());
    fillReason("第");
    expect(reason()).toBeTruthy();
    fillReason("第二个完整理由");
    fireEvent.click(await button("隐藏作品"));
    expect(screen.getByRole("dialog").textContent).toContain(
      "处置理由：第二个完整理由",
    );
    expect(writes()).toHaveLength(0);
  });

  it("retains author-deleted and nonpublic recommendation restrictions", async () => {
    rows = [{ ...work(), authorDeleted: true, publiclyVisible: false }];
    render(createElement(CommunityContentClient));
    await screen.findByText("作者已删除");
    for (const name of ["隐藏作品", "移除作品", "加入推荐"]) {
      const action = screen.getByRole("button", { name });
      expect(action.hasAttribute("disabled")).toBe(true);
      fireEvent.click(action);
    }
    expect(writes()).toHaveLength(0);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("validates a selected batch before opening its confirmation", async () => {
    rows = [work(), work("b")];
    render(createElement(CommunityContentClient));
    await screen.findByText("合成作品 b");
    fireEvent.click(screen.getByRole("checkbox", { name: "选择本页所有作品" }));
    const bulk = screen.getByRole("region", { name: "批量操作" });
    fireEvent.click(within(bulk).getByRole("button", { name: "批量隐藏" }));
    const field = within(bulk).getByRole("textbox", {
      name: "批量处置理由（必填）",
    });
    expect(document.activeElement).toBe(field);
    expect(within(bulk).getByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(writes()).toHaveLength(0);
    fireEvent.change(field, { target: { value: " 合成批量理由 " } });
    fireEvent.click(within(bulk).getByRole("button", { name: "批量隐藏" }));
    expect(screen.getByRole("dialog").textContent).toContain(
      "处置理由：合成批量理由",
    );
    expect(writes()).toHaveLength(0);
  });
});
