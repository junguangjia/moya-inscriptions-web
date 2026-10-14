// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class PublishingRequestError extends Error {
    constructor(
      readonly status: number,
      message: string,
      readonly code: string | null = null,
      readonly outcomeUnknown = false,
    ) {
      super(message);
    }
  }
  class AuthorRequestError extends Error {
    constructor(
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    PublishingRequestError,
    AuthorRequestError,
    author: {
      viewer: null as { id: string } | null,
      checking: false,
      sessionError: false,
      notify: vi.fn(),
      mutate: vi.fn(),
    },
    shell: { openProfile: vi.fn(), openContent: vi.fn() },
    entry: { checking: false, openEditor: vi.fn(() => true) },
    publishing: { setVisibility: vi.fn(), deleteWork: vi.fn() },
    work: vi.fn(),
    profile: vi.fn(async () => ({ avatar: null })),
  };
});
vi.mock("./author-context", () => ({ useAuthors: () => mocks.author }));
vi.mock("../product-shell/product-shell", () => ({
  useProductShell: () => mocks.shell,
}));
vi.mock("../publishing/publishing-entry", () => ({
  usePublishingEntry: () => mocks.entry,
}));
vi.mock("../publishing/publishing-data", () => ({
  publishingClient: mocks.publishing,
  PublishingRequestError: mocks.PublishingRequestError,
}));
vi.mock("./author-data", () => ({
  authorClient: { work: mocks.work, profile: mocks.profile },
  AuthorRequestError: mocks.AuthorRequestError,
}));
vi.mock("./content-actions", () => ({
  ContentActions: ({ title }: { title: string }) => (
    <div data-content-actions={title} />
  ),
  useContentActions: () => ({ environment: {} }),
}));
vi.mock("./local-library", () => ({ recordLocalHistory: vi.fn() }));
// The native modal's history handling has its own tests; here only its use.
vi.mock("./author-dialog", () => ({
  AuthorDialog: ({
    title,
    onClose,
    children,
  }: {
    title: string;
    onClose: () => void;
    children: React.ReactNode;
  }) => (
    <div aria-label={title} data-test-dialog="" role="dialog">
      <button onClick={onClose} type="button">
        返回
      </button>
      {children}
    </div>
  ),
}));

import { CatalogDetailWithdrawalContext } from "../detail/catalog-detail-withdrawal";
import { recordLocalHistory } from "./local-library";
import { resetOwnWorkAudiences } from "./own-work-audience";
import { DetailActions, loadWorkDetail } from "./work-detail";

import type { UserWork } from "@moya/contracts";
import type { Root } from "react-dom/client";
import type { CatalogDetailPresentation } from "../detail/catalog-detail-presentation";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const AUTHOR = `user-${"a".repeat(32)}`;
const OTHER = `user-${"b".repeat(32)}`;
const WORK = `work-${"c".repeat(32)}`;

const detail = (
  overrides: Partial<
    Extract<CatalogDetailPresentation, { contentType: "work" }>
  >,
): CatalogDetailPresentation => ({
  contentType: "work",
  id: WORK,
  authorId: AUTHOR,
  authorName: "临帖人",
  canEdit: true,
  available: true,
  firstPublishedAt: "2026-09-10T08:00:00.000Z",
  editedAt: null,
  visibility: "public",
  title: "春日临帖",
  aliases: [],
  facts: [],
  media: [],
  sections: [],
  source: "runtime",
  sourceCitations: [],
  ...overrides,
});

const roots: Root[] = [];
const render = (
  presentation: CatalogDetailPresentation,
  withdraw: ((id: string, notice: unknown) => void) | null = null,
) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const draw = (next: CatalogDetailPresentation) =>
    act(() =>
      root.render(
        withdraw === null ? (
          <DetailActions detail={next} />
        ) : (
          <CatalogDetailWithdrawalContext.Provider value={withdraw}>
            <DetailActions detail={next} />
          </CatalogDetailWithdrawalContext.Provider>
        ),
      ),
    );
  draw(presentation);
  const button = (name: string) =>
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) =>
        (candidate.getAttribute("aria-label") ?? candidate.textContent) ===
        name,
    );
  const status = () =>
    container.querySelector("[data-work-management-status]")?.textContent;
  return { button, container, draw, status };
};

beforeEach(() => {
  mocks.author.viewer = { id: AUTHOR };
  // Focus restoration waits a frame; run it at once.
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0);
    return 0;
  });
});
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  resetOwnWorkAudiences();
  // Answers queued for reads a test did not make never reach the next test.
  mocks.work.mockReset();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("Work detail actions for the author", () => {
  it("never shows author controls to a third party", () => {
    mocks.author.viewer = { id: OTHER };
    const thirdParty = render(detail({ canEdit: false }));
    expect(
      thirdParty.container.querySelector("[data-work-management]"),
    ).toBeNull();
    expect(thirdParty.button("编辑")).toBeUndefined();
    expect(thirdParty.button("永久删除")).toBeUndefined();
    expect(
      thirdParty.container.querySelector("[data-content-actions]"),
    ).not.toBeNull();

    // A stale canEdit for a different signed-in account shows nothing either.
    const stale = render(detail({ canEdit: true }));
    expect(stale.container.querySelector("[data-work-management]")).toBeNull();

    mocks.author.viewer = null;
    const guest = render(detail({ canEdit: false }));
    expect(guest.container.querySelector("[data-work-management]")).toBeNull();
  });

  it("links an unframed author identity to the profile for every reader", () => {
    mocks.author.viewer = { id: OTHER };
    const view = render(detail({ canEdit: false }));
    const identity = [
      ...view.container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent?.includes("临帖人"))!;
    act(() => identity.click());
    expect(mocks.shell.openProfile).toHaveBeenCalledWith(AUTHOR, identity);
    expect(identity.querySelector("span")).not.toBeNull();
  });
  // profile-media-renditions-v1: the 36 px author avatar loads `avatar-128`.
  it("draws the author's avatar from its smallest rendition", async () => {
    mocks.author.viewer = { id: OTHER };
    const src = `/api/community/media/user-media-${"e".repeat(32)}`;
    mocks.profile.mockResolvedValueOnce({
      avatar: {
        src,
        renditions: [
          { src: `${src}/avatar-128`, width: 128, height: 128 },
          { src: `${src}/avatar-512`, width: 512, height: 512 },
        ],
      },
    } as never);
    const view = render(detail({ canEdit: false }));
    await act(async () => undefined);
    expect(mocks.profile).toHaveBeenCalledWith(AUTHOR, expect.anything());
    expect(view.container.querySelector("img")?.getAttribute("src")).toBe(
      `${src}/avatar-128`,
    );
  });

  it("opens the editor for this work", () => {
    const view = render(detail({}));
    const edit = view.button("编辑")!;
    act(() => edit.click());
    expect(mocks.entry.openEditor).toHaveBeenCalledExactlyOnceWith(
      { type: "work", id: WORK },
      edit,
    );
  });

  it("switches to self-only in place and keeps edit and trash before the switch", async () => {
    mocks.publishing.setVisibility.mockResolvedValue({
      workId: WORK,
      visibility: "self",
    });
    const view = render(detail({}));
    const toggle = view.button("公开")!;
    expect(toggle.getAttribute("role")).toBe("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect([...toggle.parentElement!.querySelectorAll("button")]).toEqual([
      view.button("编辑"),
      view.button("永久删除"),
      toggle,
    ]);
    await act(async () => toggle.click());
    expect(view.container.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.publishing.setVisibility).toHaveBeenCalledExactlyOnceWith(
      WORK,
      {
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
        visibility: "self",
      },
    );
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(view.status()).toBe("可见范围已改为仅自己可见");
    expect(mocks.author.mutate).toHaveBeenCalledOnce();
  });

  it("makes a self-only work public without a confirmation, in neutral wording", async () => {
    mocks.publishing.setVisibility.mockResolvedValue({
      workId: WORK,
      visibility: "public",
    });
    const view = render(detail({ visibility: "self" }));
    await act(async () => view.button("公开")!.click());
    expect(view.container.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.publishing.setVisibility).toHaveBeenCalledWith(WORK, {
      requestId: expect.any(String),
      visibility: "public",
    });
    expect(view.status()).toBe("可见范围已改为公开");
    expect(view.container.textContent).not.toMatch(/审核|待|已发布给/u);
  });

  it("permanently deletes the work only after irreversible confirmation", async () => {
    mocks.publishing.deleteWork.mockResolvedValue({ deleted: true });
    const view = render(detail({}));
    act(() => view.button("永久删除")!.click());
    const dialog = view.container.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute("aria-label")).toBe("永久删除");
    expect(dialog?.textContent).toContain("无法恢复");
    expect(mocks.publishing.deleteWork).not.toHaveBeenCalled();

    await act(async () =>
      view.container
        .querySelector<HTMLButtonElement>("[data-confirm-delete]")!
        .click(),
    );
    expect(mocks.publishing.deleteWork).toHaveBeenCalledExactlyOnceWith(WORK, {
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    });
    expect(view.status()).toBe("作品已永久删除");
    expect(view.button("编辑")).toBeUndefined();
    expect(view.container.querySelector("[data-content-actions]")).toBeNull();
    expect(mocks.author.mutate).toHaveBeenCalledOnce();
    // The earlier 作品已提交 toast no longer describes this work.
    expect(mocks.author.notify).toHaveBeenCalledWith("");
  });

  it("clears an earlier status toast when the visibility changes or the editor reopens", async () => {
    mocks.publishing.setVisibility.mockResolvedValue({
      workId: WORK,
      visibility: "public",
    });
    const view = render(detail({ visibility: "self" }));
    expect(mocks.author.notify).not.toHaveBeenCalled();
    await act(async () => view.button("公开")!.click());
    expect(mocks.author.notify).toHaveBeenCalledExactlyOnceWith("");
    mocks.author.notify.mockClear();
    act(() => view.button("编辑")!.click());
    expect(mocks.author.notify).toHaveBeenCalledExactlyOnceWith("");
    expect(mocks.entry.openEditor).toHaveBeenCalledOnce();
  });

  it("shows a field-neutral failure and repeats an unconfirmed command with the same request", async () => {
    mocks.publishing.deleteWork
      .mockRejectedValueOnce(
        new mocks.PublishingRequestError(
          0,
          "网络连接中断，结果尚未确认",
          null,
          true,
        ),
      )
      .mockResolvedValueOnce({ deleted: true });
    const view = render(detail({}));
    act(() => view.button("永久删除")!.click());
    await act(async () =>
      view.container
        .querySelector<HTMLButtonElement>("[data-confirm-delete]")!
        .click(),
    );
    expect(view.status()).toBe("网络连接中断，结果尚未确认");
    expect(view.button("编辑")).toBeDefined();
    await act(async () => view.button("重试")!.click());
    const [first, second] = mocks.publishing.deleteWork.mock.calls;
    expect(second?.[1]).toEqual(first?.[1]);
    expect(view.status()).toBe("作品已永久删除");
  });

  it("without the author's visibility record, never labels the author's own self-only or not yet public work, and offers public interactions only on a public work", () => {
    const actions = (view: ReturnType<typeof render>) =>
      view.container.querySelector("[data-content-actions]");
    // The Backend lets the author open these (available), but likes,
    // favorites and sharing only exist on a work others can see.
    const selfOnly = render(
      detail({ available: true, visibility: "self", firstPublishedAt: null }),
    );
    expect(selfOnly.container.querySelector("[data-work-notice]")).toBeNull();
    expect(selfOnly.button("编辑")).toBeDefined();
    expect(actions(selfOnly)).toBeNull();

    const publishedSelfOnly = render(detail({ visibility: "self" }));
    expect(actions(publishedSelfOnly)).toBeNull();

    const pendingFirst = render(
      detail({ available: true, visibility: "public", firstPublishedAt: null }),
    );
    expect(
      pendingFirst.container.querySelector("[data-work-notice]"),
    ).toBeNull();
    expect(pendingFirst.container.textContent).not.toMatch(
      /审核|待发布|不可公开访问/u,
    );
    expect(actions(pendingFirst)).toBeNull();

    const published = render(detail({}));
    expect(actions(published)?.getAttribute("data-content-actions")).toBe(
      "春日临帖",
    );

    mocks.author.viewer = { id: OTHER };
    const thirdParty = render(detail({ canEdit: false, available: false }));
    expect(thirdParty.container.textContent).toContain(
      "此作品当前不可公开访问。",
    );
    expect(actions(thirdParty)).toBeNull();
  });

  it("tells the author neutrally when their work is not shown to others for another reason", () => {
    // Not available to its own author outside the recycle bin: e.g. hidden by an operator.
    const hidden = render(detail({ available: false, visibility: "public" }));
    expect(
      hidden.container.querySelector("[data-work-notice]")?.textContent,
    ).toBe("此作品当前不对其他人显示。");
    expect(hidden.container.textContent).not.toMatch(/审核|违规|管理员/u);
    expect(hidden.container.querySelector("[data-content-actions]")).toBeNull();
    expect(hidden.button("编辑")).toBeDefined();
  });

  it("drops public interactions once the author makes the work self-only", async () => {
    mocks.publishing.setVisibility.mockResolvedValue({
      workId: WORK,
      visibility: "self",
    });
    const view = render(detail({}));
    expect(
      view.container.querySelector("[data-content-actions]"),
    ).not.toBeNull();
    await act(async () => view.button("公开")!.click());
    expect(view.container.querySelector("[data-content-actions]")).toBeNull();
  });

  it("keeps the focus on the switch while the change runs and after its result", async () => {
    let answer: (value: unknown) => void = () => undefined;
    mocks.publishing.setVisibility.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const view = render(detail({}));
    const privateButton = view.button("公开")!;
    privateButton.focus();
    act(() => privateButton.click());

    expect(view.container.querySelector('[role="dialog"]')).toBeNull();
    // Unavailable but still focusable: the focus is not dropped to the page.
    expect(document.activeElement).toBe(privateButton);
    expect(privateButton.getAttribute("aria-disabled")).toBe("true");
    expect(privateButton.disabled).toBe(false);
    // Nothing else starts meanwhile.
    act(() => view.button("永久删除")!.click());
    expect(view.container.querySelector('[role="dialog"]')).toBeNull();
    act(() => view.button("编辑")!.click());
    expect(mocks.entry.openEditor).not.toHaveBeenCalled();

    await act(async () => answer({ workId: WORK, visibility: "self" }));
    expect(view.status()).toBe("可见范围已改为仅自己可见");
    expect(document.activeElement).toBe(privateButton);
    expect(privateButton.hasAttribute("aria-disabled")).toBe(false);
  });

  it("states the answered visibility without claiming a change it did not make", async () => {
    mocks.publishing.setVisibility.mockResolvedValue({
      workId: WORK,
      visibility: "self",
    });
    const view = render(detail({ visibility: "self" }));
    await act(async () => view.button("公开")!.click());
    expect(view.status()).toBe("可见范围：仅自己可见");
    expect(view.button("公开")?.getAttribute("aria-checked")).toBe("false");
  });

  it("hands the focus from 重试 to the result once the repeated command is confirmed", async () => {
    mocks.publishing.setVisibility
      .mockRejectedValueOnce(
        new mocks.PublishingRequestError(
          0,
          "网络连接中断，结果尚未确认",
          null,
          true,
        ),
      )
      .mockResolvedValueOnce({ workId: WORK, visibility: "public" });
    const view = render(detail({ visibility: "self" }));
    await act(async () => view.button("公开")!.click());
    const retry = view.button("重试")!;
    retry.focus();
    await act(async () => retry.click());
    const [first, second] = mocks.publishing.setVisibility.mock.calls;
    expect(second?.[1]).toEqual(first?.[1]);
    expect(view.button("重试")).toBeUndefined();
    expect(view.status()).toBe("可见范围已改为公开");
    expect(document.activeElement).toBe(
      view.container.querySelector("[data-work-management-status]"),
    );
  });

  it("lets the Detail replace its content with the result after permanent deletion", async () => {
    mocks.publishing.deleteWork.mockResolvedValue({});
    const withdraw = vi.fn();
    const view = render(detail({}), withdraw);
    act(() => view.button("永久删除")!.click());
    await act(async () =>
      view.container
        .querySelector<HTMLButtonElement>("[data-confirm-delete]")!
        .click(),
    );
    expect(withdraw).toHaveBeenCalledExactlyOnceWith(WORK, {
      title: "作品已永久删除",
      description: "此操作无法撤销。",
    });
    expect(mocks.author.mutate).toHaveBeenCalledOnce();
  });
});

const authorWork = (overrides: Partial<UserWork> = {}): UserWork => ({
  id: WORK,
  authorId: AUTHOR,
  authorName: "临帖人",
  title: "春日临帖",
  text: "正文",
  media: [],
  firstPublishedAt: "2026-09-10T08:00:00.000Z",
  editedAt: null,
  version: 1,
  canEdit: true,
  available: true,
  visibility: "public",
  trashedAt: null,
  publiclyVisible: true,
  ...overrides,
});

/** Loads the work as the Detail does, so the author's own record exists. */
const loaded = async (work: UserWork) => {
  mocks.work.mockResolvedValueOnce(work);
  const state = await loadWorkDetail(work.id, new AbortController().signal);
  if (state.state !== "loaded") throw new Error("not loaded");
  return state.detail;
};

describe("Work detail follows whether others can see the author's work", () => {
  const actions = (view: ReturnType<typeof render>) =>
    view.container.querySelector("[data-content-actions]");
  const note = (view: ReturnType<typeof render>) =>
    view.container.querySelector("[data-work-notice]")?.textContent ?? null;

  it("offers no like, favorite, share or history record on a work only its author can see, and says so", async () => {
    const view = render(
      await loaded(
        authorWork({
          visibility: "self",
          firstPublishedAt: null,
          publiclyVisible: false,
        }),
      ),
    );
    expect(note(view)).toBe("此作品当前仅你可见。");
    expect(actions(view)).toBeNull();
    expect(recordLocalHistory).not.toHaveBeenCalled();
    // Management stays.
    expect(view.button("编辑")).toBeDefined();
    expect(view.container.textContent).not.toMatch(/审核|待发布|等待/u);
  });

  it("uses neutral wording for a public work others cannot see yet, with no pending label", async () => {
    // e.g. a first submission under pre-moderation, or hidden by an operator.
    const view = render(
      await loaded(
        authorWork({ firstPublishedAt: null, publiclyVisible: false }),
      ),
    );
    expect(note(view)).toBe("此作品当前不对其他人显示。");
    expect(actions(view)).toBeNull();
    expect(recordLocalHistory).not.toHaveBeenCalled();
    expect(view.container.textContent).not.toMatch(/审核|待发布|等待|审批/u);
  });

  it("offers the public interactions and records history once others can see it", async () => {
    const view = render(await loaded(authorWork()));
    expect(note(view)).toBeNull();
    expect(actions(view)?.getAttribute("data-content-actions")).toBe(
      "春日临帖",
    );
    expect(recordLocalHistory).toHaveBeenCalledWith(AUTHOR, {
      type: "work",
      id: WORK,
    });
  });

  it("trusts the author's record over the loaded publication time", async () => {
    // Public and published once, but others cannot see it now.
    const view = render(await loaded(authorWork({ publiclyVisible: false })));
    expect(actions(view)).toBeNull();
    expect(note(view)).toBe("此作品当前不对其他人显示。");
  });

  it("keeps a third party's view unchanged, whatever the author's browser recorded", async () => {
    await loaded(authorWork({ visibility: "self", publiclyVisible: false }));
    mocks.author.viewer = { id: OTHER };
    const view = render(detail({ canEdit: false }));
    expect(note(view)).toBeNull();
    expect(actions(view)).not.toBeNull();
    expect(recordLocalHistory).toHaveBeenCalledWith(OTHER, {
      type: "work",
      id: WORK,
    });
    // A third party's own read records nothing.
    mocks.work.mockResolvedValueOnce({
      ...authorWork({ canEdit: false }),
      visibility: undefined,
      trashedAt: undefined,
      publiclyVisible: undefined,
    });
    await loadWorkDetail(WORK, new AbortController().signal);
    mocks.author.viewer = { id: AUTHOR };
    const author = render(detail({}));
    expect(note(author)).toBe("此作品当前仅你可见。");
  });

  it("hides the interactions with the self-only note as soon as the author makes the work self-only", async () => {
    mocks.publishing.setVisibility.mockResolvedValue({
      workId: WORK,
      visibility: "self",
    });
    const view = render(await loaded(authorWork()));
    expect(actions(view)).not.toBeNull();
    await act(async () => view.button("公开")!.click());
    expect(actions(view)).toBeNull();
    expect(note(view)).toBe("此作品当前仅你可见。");
    // Self-only is known without reading the work again.
    expect(mocks.work).toHaveBeenCalledOnce();
  });

  it("reads the work again after 公开 and offers the interactions only once others can see it", async () => {
    mocks.publishing.setVisibility.mockResolvedValue({
      workId: WORK,
      visibility: "public",
    });
    const view = render(
      await loaded(
        authorWork({
          visibility: "self",
          publiclyVisible: false,
        }),
      ),
    );
    let answer: (work: UserWork) => void = () => undefined;
    mocks.work.mockImplementationOnce(
      () =>
        new Promise<UserWork>((resolve) => {
          answer = resolve;
        }),
    );
    await act(async () => view.button("公开")!.click());
    expect(view.status()).toBe("可见范围已改为公开");
    // Not known yet: nothing offered, nothing claimed.
    expect(actions(view)).toBeNull();
    expect(note(view)).toBeNull();
    expect(mocks.work).toHaveBeenCalledTimes(2);
    expect(mocks.work.mock.calls[1]).toEqual([WORK]);

    // Under pre-moderation the work is not seen by others yet.
    await act(async () => answer(authorWork({ publiclyVisible: false })));
    expect(actions(view)).toBeNull();
    expect(note(view)).toBe("此作品当前不对其他人显示。");
    expect(view.container.textContent).not.toMatch(/审核|待发布|等待/u);
  });

  it("offers the interactions again when the read-back says others can see the work", async () => {
    mocks.publishing.setVisibility.mockResolvedValue({
      workId: WORK,
      visibility: "public",
    });
    const view = render(
      await loaded(authorWork({ visibility: "self", publiclyVisible: false })),
    );
    expect(recordLocalHistory).not.toHaveBeenCalled();
    mocks.work.mockResolvedValueOnce(authorWork({ publiclyVisible: true }));
    await act(async () => view.button("公开")!.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(actions(view)).not.toBeNull();
    expect(note(view)).toBeNull();
    // Others can see it now: the visit is recorded like any public work's.
    expect(recordLocalHistory).toHaveBeenCalledWith(AUTHOR, {
      type: "work",
      id: WORK,
    });
  });

  it("reads the work once more after a failed read-back, then says only that it cannot tell", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mocks.publishing.setVisibility.mockResolvedValue({
      workId: WORK,
      visibility: "public",
    });
    const view = render(
      await loaded(authorWork({ visibility: "self", publiclyVisible: false })),
    );
    mocks.work
      .mockRejectedValueOnce(new Error("网络不可用"))
      .mockRejectedValueOnce(new Error("网络不可用"));
    await act(async () => view.button("公开")!.click());
    expect(mocks.work).toHaveBeenCalledTimes(2);
    // Waiting before the repeated read: nothing offered, nothing claimed.
    expect(actions(view)).toBeNull();
    expect(note(view)).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1999);
    });
    expect(mocks.work).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mocks.work).toHaveBeenCalledTimes(3);
    expect(actions(view)).toBeNull();
    expect(note(view)).toBe("暂时无法确认其他人能否看到此作品。");
    expect(recordLocalHistory).not.toHaveBeenCalled();
    expect(view.container.textContent).not.toMatch(/审核|待发布|等待/u);
    // No further reads on its own.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(mocks.work).toHaveBeenCalledTimes(3);
  });

  it("follows the repeated read-back when it answers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mocks.publishing.setVisibility.mockResolvedValue({
      workId: WORK,
      visibility: "public",
    });
    const view = render(
      await loaded(authorWork({ visibility: "self", publiclyVisible: false })),
    );
    mocks.work
      .mockRejectedValueOnce(new Error("网络不可用"))
      .mockResolvedValueOnce(authorWork({ publiclyVisible: true }));
    await act(async () => view.button("公开")!.click());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(mocks.work).toHaveBeenCalledTimes(3);
    expect(actions(view)).not.toBeNull();
    expect(note(view)).toBeNull();
  });

  it("does not repeat a read-back once the actions have left", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mocks.publishing.setVisibility.mockResolvedValue({
      workId: WORK,
      visibility: "public",
    });
    const view = render(
      await loaded(authorWork({ visibility: "self", publiclyVisible: false })),
    );
    mocks.work.mockRejectedValueOnce(new Error("网络不可用"));
    await act(async () => view.button("公开")!.click());
    expect(mocks.work).toHaveBeenCalledTimes(2);
    for (const root of roots.splice(0)) act(() => root.unmount());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(mocks.work).toHaveBeenCalledTimes(2);
  });

  it("never marks a later load's record as unknown when an older read-back fails", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mocks.publishing.setVisibility.mockResolvedValue({
      workId: WORK,
      visibility: "public",
    });
    const view = render(
      await loaded(authorWork({ visibility: "self", publiclyVisible: false })),
    );
    mocks.work.mockRejectedValueOnce(new Error("网络不可用"));
    await act(async () => view.button("公开")!.click());
    // The work loads again meanwhile (e.g. the Detail refreshed).
    await act(async () => {
      await loaded(authorWork({ publiclyVisible: false }));
    });
    expect(note(view)).toBe("此作品当前不对其他人显示。");
    // The repeated read fails too; the newer record stays.
    mocks.work.mockRejectedValueOnce(new Error("网络不可用"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(mocks.work).toHaveBeenCalledTimes(4);
    expect(note(view)).toBe("此作品当前不对其他人显示。");
  });

  it("ignores a read-back that a later change replaced", async () => {
    mocks.publishing.setVisibility
      .mockResolvedValueOnce({ workId: WORK, visibility: "public" })
      .mockResolvedValueOnce({ workId: WORK, visibility: "self" });
    const view = render(
      await loaded(authorWork({ visibility: "self", publiclyVisible: false })),
    );
    let answer: (work: UserWork) => void = () => undefined;
    mocks.work.mockImplementationOnce(
      () =>
        new Promise<UserWork>((resolve) => {
          answer = resolve;
        }),
    );
    await act(async () => view.button("公开")!.click());
    await act(async () => view.button("公开")!.click());
    await act(async () => answer(authorWork({ publiclyVisible: true })));
    expect(actions(view)).toBeNull();
    expect(note(view)).toBe("此作品当前仅你可见。");
  });
});

describe("loadWorkDetail", () => {
  it("maps Live media, the edited marker and the author's visibility", async () => {
    const item = `item-${"d".repeat(32)}`;
    mocks.work.mockResolvedValue({
      id: WORK,
      authorId: AUTHOR,
      authorName: "临帖人",
      title: "",
      text: "正文",
      media: [
        {
          id: item,
          src: `/api/community/publishing/media/${item}/display/base`,
          width: 800,
          height: 600,
          kind: "live",
          motionSrc: `/api/community/publishing/media/${item}/motion/base`,
          hasAudio: true,
        },
      ],
      firstPublishedAt: "2026-09-10T08:00:00.000Z",
      editedAt: "2026-09-12T08:00:00.000Z",
      version: 3,
      canEdit: true,
      available: true,
      visibility: "self",
      authorship: {
        kind: "copy_practice",
        referenceTitle: "兰亭序",
        originalAuthor: "  ",
        sourceNote: "故宫博物院藏\n摹本",
      },
    } satisfies UserWork);
    const state = await loadWorkDetail(WORK, new AbortController().signal);
    expect(state).toMatchObject({
      state: "loaded",
      detail: {
        contentType: "work",
        title: "",
        firstPublishedAt: "2026-09-10T08:00:00.000Z",
        editedAt: "2026-09-12T08:00:00.000Z",
        visibility: "self",
        authorship: {
          kind: "copy_practice",
          label: "临摹或练习",
          references: [
            { label: "参考作品", value: "兰亭序" },
            { label: "来源", value: "故宫博物院藏\n摹本" },
          ],
        },
        media: [
          {
            id: item,
            alt: "未命名作品",
            live: {
              motionSrc: `/api/community/publishing/media/${item}/motion/base`,
              hasAudio: true,
            },
          },
        ],
      },
    });
  });

  it("shows an original work's authorship to everyone and leaves it out when the work has none", async () => {
    mocks.work.mockResolvedValueOnce({
      ...authorWork({ canEdit: false, authorship: { kind: "original" } }),
      visibility: undefined,
      trashedAt: undefined,
      publiclyVisible: undefined,
    });
    const third = await loadWorkDetail(WORK, new AbortController().signal);
    expect(third).toMatchObject({
      detail: {
        authorship: { kind: "original", label: "原创", references: [] },
      },
    });
    // C05: a work whose revision declares none carries no authorship field,
    // so the Detail has no 作品性质 section and invents no 原创 claim.
    mocks.work.mockResolvedValueOnce(authorWork());
    const without = await loadWorkDetail(WORK, new AbortController().signal);
    expect(without.state).toBe("loaded");
    expect(without.state === "loaded" && "authorship" in without.detail).toBe(
      false,
    );
  });
});
