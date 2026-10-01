// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { client } = vi.hoisted(() => ({
  client: {
    listDrafts: vi.fn(),
    deleteDraft: vi.fn(),
  },
}));
vi.mock("../../publishing-data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../publishing-data")>()),
  publishingClient: client,
}));
vi.mock("../../publishing-provider", async () => {
  const { useSyncExternalStore } = await import("react");
  const { uploadSession } = await import("./drafts.test-support");
  return {
    useUploadSession: () =>
      useSyncExternalStore(uploadSession.subscribe, uploadSession.get),
  };
});

vi.mock("../../../authors/author-context", () => ({
  useAuthors: () => ({
    viewer: { id: `user-${"a".repeat(32)}` },
    checking: false,
    sessionError: false,
    refresh: vi.fn(),
  }),
}));
vi.mock(
  "../../../../lib/public-api/author-community-client",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("../../../../lib/public-api/author-community-client")
      >();
    return {
      ...original,
      authorClient: {
        ...original.authorClient,
        account: () => `user-${"a".repeat(32)}`,
        accountEpoch: () => 1,
      },
    };
  },
);

import { act } from "react";

import { PublishingRequestError } from "../../publishing-data";
import { DraftsPicker } from "./drafts-picker";
import {
  ACCOUNT,
  NOW,
  buttonByText,
  cleanup,
  click,
  draftId,
  editingDraft,
  flush,
  installDialogPolyfill,
  page,
  render,
  summary,
  uploadSession,
} from "./drafts.test-support";

const renderPicker = async () => {
  const onClose = vi.fn();
  const onOpenDraft = vi.fn();
  const onChanged = vi.fn();
  const node = await render(
    <DraftsPicker
      accountId={ACCOUNT}
      onChanged={onChanged}
      onClose={onClose}
      onOpenDraft={onOpenDraft}
    />,
  );
  await flush();
  return { node, onClose, onOpenDraft, onChanged };
};

const rows = (node: HTMLElement) =>
  Array.from(node.querySelectorAll<HTMLLIElement>("li[data-draft-id]"));

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  installDialogPolyfill();
  window.history.replaceState({ kind: "profile" }, "", "/#profile");
});
afterEach(async () => {
  window.history.replaceState({ kind: "profile" }, "", "/#profile");
  await cleanup();
  uploadSession.reset();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("Drafts picker", () => {
  it("lists drafts newest edited first with new/edit labels, times and missing local files", async () => {
    client.listDrafts.mockResolvedValue(
      page([
        // Deliberately out of order: the picker still shows newest first.
        summary(2, {
          kind: "edit",
          workId: `work-${"b".repeat(32)}`,
          title: "",
          updatedAt: new Date(NOW.getTime() - 2 * 3_600_000).toISOString(),
        }),
        summary(1, {
          title: "春日",
          excerpt: "第一行",
          itemCount: 3,
          missingLocalCount: 2,
          updatedAt: new Date(NOW.getTime() - 60_000).toISOString(),
        }),
      ]),
    );
    const { node, onChanged } = await renderPicker();
    await flush();
    expect(client.listDrafts).toHaveBeenCalledWith(
      { page: 1, pageSize: 20 },
      expect.any(AbortSignal),
    );
    const [first, second] = rows(node);
    expect(first?.dataset.draftId).toBe(summary(1).id);
    expect(second?.dataset.draftId).toBe(summary(2).id);
    expect(first?.querySelector("[data-draft-label]")?.textContent).toBe(
      "新作品",
    );
    expect(first?.querySelector("h3")?.textContent).toBe("春日");
    expect(first?.textContent).toContain("3 项图片");
    expect(first?.textContent).toContain("1 分钟前编辑");
    expect(first?.querySelector("[data-missing-local]")?.textContent).toBe(
      "2 项尚未上传，打开后需重新选择文件",
    );
    expect(second?.querySelector("[data-draft-label]")?.textContent).toBe(
      "编辑「未命名作品」",
    );
    expect(second?.textContent).toContain("2 小时前编辑");
    expect(second?.querySelector("[data-missing-local]")).toBeNull();
    expect(onChanged).toHaveBeenCalledWith(
      2,
      expect.objectContaining({ id: first?.dataset.draftId }),
    );
  });

  it("warns only about pending items this browser does not hold itself (D6)", async () => {
    const held = vi.fn(async (id: string) =>
      id === draftId(1) ? 1 : id === draftId(2) ? 2 : 0,
    );
    uploadSession.set({ countLocalDraftItems: held });
    client.listDrafts.mockResolvedValue(
      page([
        summary(1, { itemCount: 3, missingLocalCount: 2 }),
        summary(2, { itemCount: 2, missingLocalCount: 2 }),
        summary(3, { itemCount: 1, missingLocalCount: 0 }),
      ]),
    );
    const { node } = await renderPicker();
    await flush();
    const [one, two, three] = rows(node);
    // Two pending on the account, one of them recoverable here: one is missing here.
    expect(one?.querySelector("[data-missing-local]")?.textContent).toBe(
      "1 项尚未上传，打开后需重新选择文件",
    );
    // Every pending item is on this browser (device A): nothing to warn about.
    expect(two?.querySelector("[data-missing-local]")).toBeNull();
    expect(three?.querySelector("[data-missing-local]")).toBeNull();
    expect(held).toHaveBeenCalledTimes(2);
    expect(held).not.toHaveBeenCalledWith(draftId(3));
  });

  it("shows the truthful empty state", async () => {
    client.listDrafts.mockResolvedValue(page([]));
    const { node, onChanged } = await renderPicker();
    expect(node.textContent).toContain("暂无草稿");
    expect(rows(node)).toHaveLength(0);
    expect(onChanged).toHaveBeenCalledWith(0, null);
  });

  it("opens the chosen draft", async () => {
    client.listDrafts.mockResolvedValue(page([summary(1), summary(2)]));
    const { node, onOpenDraft } = await renderPicker();
    await click(buttonByText(rows(node)[1]!, "继续编辑"));
    expect(onOpenDraft).toHaveBeenCalledExactlyOnceWith(summary(2).id);
  });

  it("confirms deletion naming exactly this draft and its scope, then deletes only it", async () => {
    client.listDrafts.mockResolvedValue(
      page([
        summary(1, { title: "春日" }),
        summary(2, {
          title: "春日",
          kind: "edit",
          workId: `work-${"c".repeat(32)}`,
        }),
      ]),
    );
    client.deleteDraft.mockResolvedValue({
      deleted: true,
      snapshots: 4,
      conflictCopies: 1,
      mediaItems: 2,
    });
    const { node, onChanged } = await renderPicker();
    const target = rows(node)[0]!;
    await click(buttonByText(target, "删除"));
    expect(client.deleteDraft).not.toHaveBeenCalled();
    const confirm = target.querySelector<HTMLElement>('[role="alertdialog"]');
    expect(confirm).not.toBeNull();
    const title = document.getElementById(
      confirm!.getAttribute("aria-labelledby")!,
    );
    const description = document.getElementById(
      confirm!.getAttribute("aria-describedby")!,
    );
    expect(title?.textContent).toBe("删除新作品草稿「春日」？");
    expect(description?.textContent).toBe(
      "将删除新作品草稿「春日」（1 分钟前编辑），以及它的历史版本、冲突副本和只被它使用的图片。其他草稿和已发布的作品不受影响。删除后无法恢复。",
    );
    // The safe choice has focus; only this row asks.
    expect(document.activeElement?.textContent).toBe("取消");
    expect(rows(node)[1]!.querySelector('[role="alertdialog"]')).toBeNull();

    await click(buttonByText(confirm!, "删除草稿"));
    await flush();
    expect(client.deleteDraft).toHaveBeenCalledExactlyOnceWith(summary(1).id, {
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    });
    expect(rows(node).map((row) => row.dataset.draftId)).toEqual([
      summary(2).id,
    ]);
    expect(node.querySelector('[role="status"]')?.textContent).toBe(
      "草稿已删除，同时删除了 4 个历史版本、1 个冲突副本、2 项图片",
    );
    // This browser's local copies of exactly that draft go through the runtime.
    expect(
      uploadSession.get().forgetDraftLocalCopies,
    ).toHaveBeenCalledExactlyOnceWith(summary(1).id);
    // Focus moved from the removed row to the list, never to a hidden element.
    expect(document.activeElement).toBe(node.querySelector("ul"));
    expect(onChanged).toHaveBeenLastCalledWith(
      1,
      expect.objectContaining({ id: summary(2).id }),
    );
  });

  it("cancelling keeps the draft; an unconfirmed deletion retries with the same request identity", async () => {
    client.listDrafts.mockResolvedValue(page([summary(1, { title: "秋" })]));
    const { node } = await renderPicker();
    const target = rows(node)[0]!;
    await click(buttonByText(target, "删除"));
    await click(buttonByText(target, "取消"));
    expect(target.querySelector('[role="alertdialog"]')).toBeNull();
    expect(client.deleteDraft).not.toHaveBeenCalled();

    client.deleteDraft
      .mockRejectedValueOnce(
        new PublishingRequestError(0, "网络连接中断，结果尚未确认", null, true),
      )
      .mockResolvedValueOnce({
        deleted: true,
        snapshots: 0,
        conflictCopies: 0,
        mediaItems: 0,
      });
    await click(buttonByText(target, "删除"));
    await click(buttonByText(target, "删除草稿"));
    await flush();
    expect(target.querySelector('[role="alert"]')?.textContent).toBe(
      "网络连接中断，结果尚未确认",
    );
    expect(rows(node)).toHaveLength(1);
    await click(buttonByText(target, "删除草稿"));
    await flush();
    const [firstCall, secondCall] = client.deleteDraft.mock.calls;
    expect(secondCall?.[1].requestId).toBe(firstCall?.[1].requestId);
    expect(rows(node)).toHaveLength(0);
    expect(node.textContent).toContain("暂无草稿");
    expect(document.activeElement?.textContent).toBe("暂无草稿");
  });

  it("keeps the busy confirmation focusable, and Escape answers only the confirmation", async () => {
    client.listDrafts.mockResolvedValue(page([summary(1, { title: "冬" })]));
    let answer: (value: unknown) => void = () => undefined;
    client.deleteDraft.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const { node, onClose } = await renderPicker();
    const target = rows(node)[0]!;
    const ask = buttonByText(target, "删除");
    ask.focus();
    await click(ask);
    const confirm = target.querySelector<HTMLElement>('[role="alertdialog"]')!;
    expect(document.activeElement).toBe(buttonByText(confirm, "取消"));
    await act(async () => {
      confirm.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(target.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.activeElement).toBe(ask);
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector("dialog")?.open).toBe(true);

    await click(ask);
    const again = target.querySelector<HTMLElement>('[role="alertdialog"]')!;
    const confirmButton = buttonByText(again, "删除草稿");
    confirmButton.focus();
    await click(confirmButton);
    const busy = buttonByText(again, "正在删除…");
    expect(busy).toBe(confirmButton);
    expect(busy.getAttribute("aria-disabled")).toBe("true");
    expect(busy.disabled).toBe(false);
    expect(document.activeElement).toBe(busy);
    await click(busy);
    expect(client.deleteDraft).toHaveBeenCalledOnce();
    await act(async () =>
      answer({ deleted: true, snapshots: 0, conflictCopies: 0, mediaItems: 0 }),
    );
    await flush();
    expect(rows(node)).toHaveLength(0);
  });

  it("announces through a live region that is present before anything is said", async () => {
    client.listDrafts.mockResolvedValue(page([summary(1), summary(2)]));
    client.deleteDraft.mockResolvedValue({
      deleted: true,
      snapshots: 0,
      conflictCopies: 0,
      mediaItems: 0,
    });
    const { node } = await renderPicker();
    const status = node.querySelector('[role="status"]');
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(status?.textContent).toBe("");
    const target = rows(node)[0]!;
    await click(buttonByText(target, "删除"));
    await click(buttonByText(target, "删除草稿"));
    await flush();
    expect(node.querySelector('[role="status"]')).toBe(status);
    expect(status?.textContent).toBe("草稿已删除");
  });

  it("never deletes the draft of an editor session that is still running", async () => {
    uploadSession.set(editingDraft(draftId(2), "pending"));
    client.listDrafts.mockResolvedValue(
      page([
        summary(1, { missingLocalCount: 1 }),
        summary(2, { title: "进行中", missingLocalCount: 2 }),
      ]),
    );
    const { node, onOpenDraft } = await renderPicker();
    await flush();
    const [other, active] = rows(node);
    expect(other?.hasAttribute("data-draft-active")).toBe(false);
    expect(other?.querySelector("[data-missing-local]")?.textContent).toBe(
      "1 项尚未上传，打开后需重新选择文件",
    );
    expect(buttonByText(other!, "删除").disabled).toBe(false);
    expect(active?.hasAttribute("data-draft-active")).toBe(true);
    expect(active?.textContent).toContain("正在编辑");
    expect(active?.textContent).toContain("结束后才能删除这份草稿");
    // The running session still holds its files.
    expect(active?.querySelector("[data-missing-local]")).toBeNull();
    const remove = buttonByText(active!, "删除");
    expect(remove.disabled).toBe(true);
    await click(remove);
    expect(active?.querySelector('[role="alertdialog"]')).toBeNull();
    expect(client.deleteDraft).not.toHaveBeenCalled();
    await click(buttonByText(active!, "继续编辑"));
    expect(onOpenDraft).toHaveBeenCalledExactlyOnceWith(draftId(2));
  });

  it("does not clear local copies for a runtime that belongs to another account", async () => {
    uploadSession.set({ accountId: `user-${"f".repeat(32)}` });
    client.listDrafts.mockResolvedValue(page([summary(1)]));
    client.deleteDraft.mockResolvedValue({
      deleted: true,
      snapshots: 0,
      conflictCopies: 0,
      mediaItems: 0,
    });
    const { node } = await renderPicker();
    const target = rows(node)[0]!;
    await click(buttonByText(target, "删除"));
    await click(buttonByText(target, "删除草稿"));
    await flush();
    expect(client.deleteDraft).toHaveBeenCalledOnce();
    expect(uploadSession.get().forgetDraftLocalCopies).not.toHaveBeenCalled();
  });
});
