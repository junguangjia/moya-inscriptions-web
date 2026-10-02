// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArticleDraftSummary } from "@moya/contracts";

const { workClient, articleClient, identity, author } = vi.hoisted(() => ({
  workClient: {
    listDrafts: vi.fn(),
    draft: vi.fn(),
    deleteDraft: vi.fn(),
  },
  articleClient: { list: vi.fn(), deleteDraft: vi.fn() },
  identity: { account: `user-${"a".repeat(32)}`, epoch: 1 },
  author: {
    viewer: { id: `user-${"a".repeat(32)}` },
    checking: false,
    sessionError: false,
    refresh: vi.fn(),
  },
}));
vi.mock("../../publishing-data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../publishing-data")>()),
  publishingClient: workClient,
}));
vi.mock(
  "../../../../lib/public-api/article-authoring-client",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../../lib/public-api/article-authoring-client")
    >()),
    articleAuthoringClient: articleClient,
  }),
);
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
        account: () => identity.account,
        accountEpoch: () => identity.epoch,
      },
    };
  },
);
vi.mock("../../../authors/author-context", () => ({
  useAuthors: () => author,
}));
vi.mock("../../publishing-provider", async () => {
  const { useSyncExternalStore } = await import("react");
  const { uploadSession } = await import("./drafts.test-support");
  return {
    useUploadSession: () =>
      useSyncExternalStore(uploadSession.subscribe, uploadSession.get),
  };
});

import { ArticleRequestError } from "../../../../lib/public-api/article-authoring-client";
import { DraftsPicker } from "./drafts-picker";
import {
  ACCOUNT,
  NOW,
  buttonByText,
  cleanup,
  click,
  draft,
  draftId,
  editingDraft,
  flush,
  installDialogPolyfill,
  minutesAgo,
  page,
  render,
  summary,
  uploadSession,
} from "./drafts.test-support";

const articleId = (n: number) =>
  `article-${n.toString(16).padStart(32, "0")}` as ArticleDraftSummary["id"];
const article = (
  n: number,
  overrides: Partial<ArticleDraftSummary> = {},
): ArticleDraftSummary => ({
  id: articleId(n),
  ownerId: ACCOUNT as ArticleDraftSummary["ownerId"],
  version: 7,
  title: `专题 ${n}`,
  coverRefId: null,
  status: "draft",
  publicVersion: null,
  updatedAt: minutesAgo(n),
  fingerprint: "a".repeat(64),
  ...overrides,
});
const rows = (node: ParentNode) =>
  Array.from(node.querySelectorAll<HTMLElement>("li[data-draft-id]"));
const row = (node: ParentNode, id: string) => {
  const result = node.querySelector<HTMLElement>(`li[data-draft-id="${id}"]`);
  expect(result).not.toBeNull();
  return result!;
};
const checkbox = (node: ParentNode, id: string) => {
  const result = row(node, id).querySelector<HTMLInputElement>(
    'input[type="checkbox"]',
  );
  expect(result).not.toBeNull();
  return result!;
};
const mount = async (enabled = true) => {
  const onOpenDraft = vi.fn();
  const onOpenArticle = vi.fn();
  const node = await render(
    <DraftsPicker
      accountId={ACCOUNT}
      articleEnabled={enabled}
      onClose={vi.fn()}
      onOpenDraft={onOpenDraft}
      onOpenArticle={onOpenArticle}
    />,
  );
  await flush();
  return { node, onOpenDraft, onOpenArticle };
};
const chooseAll = async (node: HTMLElement) => {
  await click(buttonByText(node, "选择"));
  await click(buttonByText(node, "全选"));
};
const askToDelete = async (node: HTMLElement, count: number) => {
  await click(buttonByText(node, `删除所选（${count}）`));
  const confirmation = node.querySelector<HTMLElement>('[role="alertdialog"]');
  expect(confirmation).not.toBeNull();
  return confirmation!;
};
const pointer = async (
  target: EventTarget,
  type: string,
  props: Record<string, unknown> = {},
) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(
    event,
    Object.fromEntries(
      Object.entries({
        pointerId: 1,
        pointerType: "touch",
        isPrimary: true,
        button: 0,
        clientX: 80,
        clientY: 160,
        ...props,
      }).map(([key, value]) => [key, { value }]),
    ),
  );
  await act(async () => target.dispatchEvent(event));
};
const releaseClick = async (target: HTMLElement) => {
  await act(async () =>
    target.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        detail: 1,
      }),
    ),
  );
};

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  installDialogPolyfill();
  window.history.replaceState({ kind: "profile" }, "", "/#profile");
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
  identity.account = ACCOUNT;
  identity.epoch = 1;
  author.viewer = { id: ACCOUNT };
  author.checking = false;
  author.sessionError = false;
  uploadSession.reset();
  workClient.listDrafts.mockResolvedValue(
    page([summary(2, { title: "作品二" })]),
  );
  workClient.draft.mockImplementation(async (id: string) =>
    draft({
      id,
      revision: 12,
      updatedAt: minutesAgo(Number.parseInt(id.slice(-32), 16)),
    }),
  );
  workClient.deleteDraft.mockResolvedValue({
    deleted: true,
    snapshots: 0,
    conflictCopies: 0,
    mediaItems: 0,
  });
  articleClient.list.mockResolvedValue({
    items: [article(1)],
    nextCursor: null,
  });
  articleClient.deleteDraft.mockResolvedValue({
    id: articleId(1),
    deleted: true,
    publicVersion: null,
  });
});
afterEach(async () => {
  await cleanup();
  uploadSession.reset();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("Unified private draft cards", () => {
  it("uses one keyboard-accessible card entry without redundant edit or public buttons", async () => {
    articleClient.list.mockResolvedValue({
      items: [article(1, { publicVersion: 2 })],
      nextCursor: null,
    });
    const { node, onOpenDraft, onOpenArticle } = await mount();
    expect(node.textContent).not.toContain("继续编辑");
    expect(node.textContent).not.toContain("公开版本");
    const activate = async (id: string, key: string) =>
      act(async () => {
        row(node, id)
          .querySelector('[role="button"]')!
          .dispatchEvent(
            new KeyboardEvent("keydown", {
              key,
              bubbles: true,
              cancelable: true,
            }),
          );
      });
    await activate(articleId(1), "Enter");
    await activate(draftId(2), " ");
    expect(onOpenArticle).toHaveBeenCalledExactlyOnceWith(articleId(1));
    expect(onOpenDraft).toHaveBeenCalledExactlyOnceWith(draftId(2));
    identity.epoch += 1;
    await activate(articleId(1), "Enter");
    expect(onOpenArticle).toHaveBeenCalledTimes(1);
  });
  it("shows both existing draft kinds in one newest-first card grid with no type tabs", async () => {
    workClient.listDrafts.mockResolvedValue(
      page([summary(2, { title: "作品二" }), summary(4, { title: "作品四" })]),
    );
    articleClient.list.mockResolvedValue({
      items: [article(3), article(1)],
      nextCursor: null,
    });
    const { node, onOpenDraft, onOpenArticle } = await mount();
    expect(node.querySelector('[role="tablist"]')).toBeNull();
    expect(node.querySelector('[role="tab"]')).toBeNull();
    expect(node.querySelectorAll('ul[aria-label="草稿列表"]')).toHaveLength(1);
    expect(rows(node).map((item) => item.dataset.draftId)).toEqual([
      articleId(1),
      draftId(2),
      articleId(3),
      draftId(4),
    ]);
    await click(row(node, articleId(1)).querySelector("h3")!);
    await click(row(node, draftId(2)).querySelector("h3")!);
    expect(onOpenArticle).toHaveBeenCalledExactlyOnceWith(articleId(1));
    expect(onOpenDraft).toHaveBeenCalledExactlyOnceWith(draftId(2));
  });

  it("keeps Work cards usable while Article loading fails, then mixes a successful retry", async () => {
    articleClient.list
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce({ items: [article(1)], nextCursor: null });
    const { node, onOpenDraft } = await mount();
    expect(rows(node).map((item) => item.dataset.draftId)).toEqual([
      draftId(2),
    ]);
    expect(node.textContent).toContain("暂时无法读取专题草稿");
    // The existing Work card remains inspectable even when the other data source fails.
    expect(row(node, draftId(2)).textContent).toContain("作品二");
    await click(buttonByText(node, "重试专题草稿"));
    await flush();
    expect(rows(node).map((item) => item.dataset.draftId)).toEqual([
      articleId(1),
      draftId(2),
    ]);
    await click(row(node, draftId(2)).querySelector("h3")!);
    expect(onOpenDraft).toHaveBeenCalledWith(draftId(2));
  });

  it("does not request or expose Article drafts under the existing false availability gate", async () => {
    const { node, onOpenDraft } = await mount(false);
    expect(articleClient.list).not.toHaveBeenCalled();
    expect(node.querySelector("[data-article-draft-id]")).toBeNull();
    expect(rows(node).map((item) => item.dataset.draftId)).toEqual([
      draftId(2),
    ]);
    expect(node.querySelector('[role="tablist"]')).toBeNull();
    expect(node.textContent).not.toContain("长按卡片");
    expect(
      Array.from(node.querySelectorAll("button")).some(
        (button) => button.textContent === "选择",
      ),
    ).toBe(false);
    await click(row(node, draftId(2)).querySelector("h3")!);
    expect(onOpenDraft).not.toHaveBeenCalled();
    await click(buttonByText(node, "继续编辑"));
    expect(onOpenDraft).toHaveBeenCalledWith(draftId(2));
  });

  it("rejects another owner's Article result instead of exposing its private card", async () => {
    articleClient.list.mockResolvedValue({
      items: [
        article(1, {
          ownerId: `user-${"f".repeat(32)}` as ArticleDraftSummary["ownerId"],
        }),
      ],
      nextCursor: null,
    });
    const { node } = await mount();
    expect(node.querySelector("[data-article-draft-id]")).toBeNull();
    expect(node.textContent).toContain("暂时无法读取专题草稿");
    expect(row(node, draftId(2)).textContent).toContain("作品二");
  });

  it("deletes only confirmed selected drafts, preserves a failed card for retry, and clears only successful Work local copies", async () => {
    workClient.listDrafts.mockResolvedValue(
      page([
        summary(2, { title: "作品二" }),
        summary(4, { title: "未选择作品" }),
      ]),
    );
    articleClient.deleteDraft
      .mockRejectedValueOnce(
        new ArticleRequestError(409, "article_version_conflict", false),
      )
      .mockResolvedValueOnce({
        id: articleId(1),
        deleted: true,
        publicVersion: null,
      });
    const { node, onOpenDraft, onOpenArticle } = await mount();
    await click(buttonByText(node, "选择"));
    await click(checkbox(node, articleId(1)));
    await click(checkbox(node, draftId(2)));
    expect(checkbox(node, draftId(4)).checked).toBe(false);
    const confirmation = await askToDelete(node, 2);
    expect(workClient.deleteDraft).not.toHaveBeenCalled();
    expect(articleClient.deleteDraft).not.toHaveBeenCalled();
    expect(confirmation.textContent).toContain(
      "已公开的作品、专题版本不受影响",
    );
    expect(document.activeElement).toBe(buttonByText(confirmation, "取消"));
    await click(buttonByText(confirmation, "删除所选草稿"));
    await flush();
    expect(workClient.deleteDraft).toHaveBeenCalledTimes(1);
    expect(workClient.deleteDraft.mock.calls[0]?.[0]).toBe(draftId(2));
    expect(workClient.deleteDraft.mock.calls[0]?.[1]).toMatchObject({
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    });
    expect(articleClient.deleteDraft).toHaveBeenCalledWith(articleId(1), {
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      expectedVersion: 7,
    });
    expect(rows(node).map((item) => item.dataset.draftId)).toEqual([
      articleId(1),
      draftId(4),
    ]);
    expect(checkbox(node, articleId(1)).checked).toBe(true);
    expect(
      row(node, articleId(1)).querySelector('[role="alert"]'),
    ).not.toBeNull();
    expect(
      uploadSession.get().forgetDraftLocalCopies,
    ).toHaveBeenCalledExactlyOnceWith(draftId(2));
    expect(node.textContent).toContain("已删除 1 份草稿");
    expect(onOpenDraft).not.toHaveBeenCalled();
    expect(onOpenArticle).not.toHaveBeenCalled();
    const retry = await askToDelete(node, 1);
    await click(buttonByText(retry, "删除所选草稿"));
    await flush();
    expect(articleClient.deleteDraft).toHaveBeenCalledTimes(2);
    expect(workClient.deleteDraft).toHaveBeenCalledTimes(1);
    expect(rows(node).map((item) => item.dataset.draftId)).toEqual([
      draftId(4),
    ]);
  });

  it("retains the same Article deletion request identity when the committed outcome is unknown", async () => {
    workClient.listDrafts.mockResolvedValue(page([]));
    articleClient.deleteDraft
      .mockRejectedValueOnce(new ArticleRequestError(0, null, true))
      .mockResolvedValueOnce({
        id: articleId(1),
        deleted: true,
        publicVersion: null,
      });
    const { node } = await mount();
    await chooseAll(node);
    let confirmation = await askToDelete(node, 1);
    await click(buttonByText(confirmation, "删除所选草稿"));
    await flush();
    expect(checkbox(node, articleId(1)).checked).toBe(true);
    confirmation = await askToDelete(node, 1);
    await click(buttonByText(confirmation, "删除所选草稿"));
    await flush();
    expect(articleClient.deleteDraft).toHaveBeenCalledTimes(2);
    expect(articleClient.deleteDraft.mock.calls[1]?.[1]).toEqual(
      articleClient.deleteDraft.mock.calls[0]?.[1],
    );
    expect(rows(node)).toHaveLength(0);
  });

  it("excludes the kept active Work session from select-all and deletion", async () => {
    uploadSession.set(editingDraft(draftId(2), "pending"));
    const { node } = await mount();
    await chooseAll(node);
    expect(checkbox(node, draftId(2)).disabled).toBe(true);
    expect(checkbox(node, draftId(2)).checked).toBe(false);
    expect(checkbox(node, articleId(1)).checked).toBe(true);
    const confirmation = await askToDelete(node, 1);
    await click(buttonByText(confirmation, "删除所选草稿"));
    await flush();
    expect(articleClient.deleteDraft).toHaveBeenCalledTimes(1);
    expect(workClient.deleteDraft).not.toHaveBeenCalled();
    expect(row(node, draftId(2)).hasAttribute("data-draft-active")).toBe(true);
  });

  it("cancels the confirmation if current account confirmation is lost before submission", async () => {
    const { node } = await mount();
    await chooseAll(node);
    await askToDelete(node, 2);
    await act(async () => {
      author.checking = true;
      uploadSession.set({});
    });
    expect(node.querySelector('[role="alertdialog"]')).toBeNull();
    expect(workClient.deleteDraft).not.toHaveBeenCalled();
    expect(articleClient.deleteDraft).not.toHaveBeenCalled();
    expect(buttonByText(node, "选择").disabled).toBe(true);
  });

  it("stops the remaining fixed selection when identity changes during the first pending deletion", async () => {
    let resolveDelete!: (result: unknown) => void;
    articleClient.deleteDraft.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDelete = resolve;
        }),
    );
    const { node } = await mount();
    await chooseAll(node);
    const confirmation = await askToDelete(node, 2);
    await click(buttonByText(confirmation, "删除所选草稿"));
    expect(articleClient.deleteDraft).toHaveBeenCalledTimes(1);
    expect(workClient.deleteDraft).not.toHaveBeenCalled();
    await act(async () => {
      identity.account = `user-${"f".repeat(32)}`;
      identity.epoch += 1;
      author.viewer = { id: identity.account };
      uploadSession.set({ accountId: identity.account });
      resolveDelete({ id: articleId(1), deleted: true, publicVersion: null });
    });
    await flush();
    expect(workClient.deleteDraft).not.toHaveBeenCalled();
    expect(uploadSession.get().forgetDraftLocalCopies).not.toHaveBeenCalled();
    expect(node.textContent).toContain("后续删除已停止");
  });
});

describe("Real draft-card hold gesture", () => {
  it("selects at 400ms, suppresses the release click, then permits selecting another card", async () => {
    const { node, onOpenArticle, onOpenDraft } = await mount();
    vi.useFakeTimers({ now: NOW });
    const title = row(node, articleId(1)).querySelector<HTMLElement>("h3")!;
    await pointer(title, "pointerdown");
    await act(async () => vi.advanceTimersByTimeAsync(399));
    expect(node.querySelector('input[type="checkbox"]')).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(checkbox(node, articleId(1)).checked).toBe(true);
    await pointer(title, "pointerup");
    await releaseClick(title);
    expect(checkbox(node, articleId(1)).checked).toBe(true);
    expect(onOpenArticle).not.toHaveBeenCalled();
    await click(row(node, draftId(2)).querySelector("h3")!);
    expect(checkbox(node, draftId(2)).checked).toBe(true);
    expect(node.textContent).toContain("已选择 2 份草稿");
    expect(onOpenDraft).not.toHaveBeenCalled();
  });

  it.each(["movement", "scroll", "pointercancel", "second-pointer"])(
    "allows %s to cancel a pending hold before it can select or open a draft",
    async (interruption) => {
      const { node, onOpenArticle } = await mount();
      vi.useFakeTimers({ now: NOW });
      const title = row(node, articleId(1)).querySelector<HTMLElement>("h3")!;
      await pointer(title, "pointerdown");
      await act(async () => vi.advanceTimersByTimeAsync(200));
      if (interruption === "movement")
        await pointer(document, "pointermove", { clientY: 171 });
      else if (interruption === "scroll")
        await act(async () => window.dispatchEvent(new Event("scroll")));
      else if (interruption === "second-pointer")
        await pointer(title, "pointerdown", { pointerId: 2, isPrimary: false });
      else await pointer(document, "pointercancel");
      await act(async () => vi.advanceTimersByTimeAsync(250));
      await pointer(title, "pointerup");
      await releaseClick(title);
      expect(node.querySelector('input[type="checkbox"]')).toBeNull();
      expect(onOpenArticle).not.toHaveBeenCalled();
      expect(articleClient.deleteDraft).not.toHaveBeenCalled();
    },
  );

  it("never enters selection from a kept active Work card", async () => {
    uploadSession.set(editingDraft(draftId(2), "pending"));
    const { node, onOpenDraft } = await mount();
    vi.useFakeTimers({ now: NOW });
    const title = row(node, draftId(2)).querySelector<HTMLElement>("h3")!;
    await pointer(title, "pointerdown");
    await act(async () => vi.advanceTimersByTimeAsync(500));
    await pointer(title, "pointerup");
    expect(node.querySelector('input[type="checkbox"]')).toBeNull();
    expect(onOpenDraft).not.toHaveBeenCalled();
  });
});
