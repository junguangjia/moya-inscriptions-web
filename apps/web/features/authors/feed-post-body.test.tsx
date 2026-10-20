// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ComponentProps } from "react";
import type { Root } from "react-dom/client";

const { client, identity, author } = vi.hoisted(() => {
  // Whom the author client reads for; an account change starts a new epoch.
  const identity = { account: "viewer" as string | null, epoch: 1 };
  return {
    identity,
    client: {
      work: vi.fn(),
      account: () => identity.account,
      accountEpoch: () => identity.epoch,
    },
    author: {
      viewer: { id: "viewer" } as { id: string } | null,
      checking: false,
      sessionError: false,
      refresh: vi.fn(async () => undefined),
    },
  };
});
vi.mock("./author-data", () => ({ authorClient: client }));
vi.mock("./author-context", () => ({ useOptionalAuthors: () => author }));

import { FeedPostBody } from "./feed-post-body";
import {
  forgetWorkSnapshot,
  readWorkSnapshot,
  recordWorkSnapshots,
  resetWorkSnapshots,
  workSnapshotToken,
} from "./work-snapshots";

import type { UserWork } from "@moya/contracts";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type BodyProps = ComponentProps<typeof FeedPostBody>;

const deferred = () => {
  let resolve!: (value: UserWork) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<UserWork>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
const work = (id: string, text: string, available = true): UserWork => ({
  id,
  authorId: "author",
  authorName: "作者",
  title: "",
  text,
  firstPublishedAt: "2026-09-01T00:00:00.000Z",
  media: [],
  version: 1,
  canEdit: false,
  available,
});
/** The account changes as the client sees it: a new epoch, a new viewer. */
const switchAccount = (id: string | null) => {
  identity.account = id;
  identity.epoch++;
  author.viewer = id === null ? null : { id };
};
/** As a Works tab list or another read records it for the current account. */
const hold = (record: UserWork) =>
  act(() => recordWorkSnapshots([record], workSnapshotToken()));
const flush = () =>
  act(async () => {
    await Promise.resolve();
  });

const roots: Root[] = [];
const mount = async (props: Partial<BodyProps> & { workId: string }) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const render = (change: Partial<BodyProps> = {}) =>
    act(async () =>
      root.render(
        <FeedPostBody expanded id="post-body" {...props} {...change} />,
      ),
    );
  await render();
  return { container, render };
};

const status = (container: HTMLElement) =>
  container.querySelector('[role="status"]');
const alert = (container: HTMLElement) =>
  container.querySelector('[role="alert"]');
const body = (container: HTMLElement) =>
  container.querySelector("[data-feed-post-body]");
const wrapper = (container: HTMLElement) =>
  container.querySelector<HTMLElement>("[data-feed-post-body-state]");
const retry = (container: HTMLElement) =>
  [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "重试",
  );
const opener = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>("[data-feed-post-body-open]");

beforeEach(() => {
  identity.account = "viewer";
  identity.epoch = 1;
  author.viewer = { id: "viewer" };
  author.checking = false;
  author.sessionError = false;
  author.refresh.mockClear();
  resetWorkSnapshots();
});
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  client.work.mockReset();
  vi.unstubAllGlobals();
});

describe("FeedPostBody", () => {
  it("re-reads after sign-out without showing the previous account's body", async () => {
    client.work.mockResolvedValueOnce(
      work("work-sign-out", "合成作者未公开修订"),
    );
    const { container, render } = await mount({ workId: "work-sign-out" });
    expect(body(container)!.textContent).toBe("合成作者未公开修订");
    const guest = deferred();
    client.work.mockReturnValueOnce(guest.promise);
    switchAccount(null);
    await render();
    expect(body(container)).toBeNull();
    expect(container.textContent).not.toContain("合成作者未公开修订");
    expect(client.work).toHaveBeenCalledTimes(2);
    await act(async () => guest.resolve(work("work-sign-out", "合成公开正文")));
    expect(body(container)!.textContent).toBe("合成公开正文");
  });

  it("does not share a held body with a different account's new post instance", async () => {
    client.work.mockResolvedValueOnce(
      work("work-account-switch", "合成作者修订"),
    );
    await mount({ workId: "work-account-switch" });
    switchAccount("other-viewer");
    client.work.mockResolvedValueOnce(
      work("work-account-switch", "合成公开版本"),
    );
    const next = await mount({ workId: "work-account-switch" });
    expect(body(next.container)!.textContent).toBe("合成公开版本");
    expect(client.work).toHaveBeenCalledTimes(2);
  });

  it("hides account content while identity is being checked and ignores its late response", async () => {
    const previous = deferred();
    client.work.mockReturnValueOnce(previous.promise);
    const { container, render } = await mount({ workId: "work-checking" });
    const signal = client.work.mock.calls[0]![1] as AbortSignal;
    author.checking = true;
    await render();
    expect(signal.aborted).toBe(true);
    await act(async () =>
      previous.resolve(work("work-checking", "合成旧账户正文")),
    );
    expect(body(container)).toBeNull();
    expect(readWorkSnapshot("work-checking")).toBeNull();
    switchAccount(null);
    author.checking = false;
    client.work.mockResolvedValueOnce(work("work-checking", "合成游客正文"));
    await render();
    expect(body(container)!.textContent).toBe("合成游客正文");
  });

  it("hides an already loaded body when identity fails and retries identity confirmation", async () => {
    client.work.mockResolvedValueOnce(
      work("work-session-error", "合成账户正文"),
    );
    const { container, render } = await mount({ workId: "work-session-error" });
    expect(body(container)!.textContent).toBe("合成账户正文");
    author.sessionError = true;
    await render();
    expect(body(container)).toBeNull();
    expect(container.textContent).not.toContain("合成账户正文");
    expect(client.work).toHaveBeenCalledTimes(1);
    await act(async () => retry(container)!.click());
    expect(author.refresh).toHaveBeenCalledOnce();
    expect(body(container)).toBeNull();
    expect(client.work).toHaveBeenCalledTimes(1);
    switchAccount(null);
    author.sessionError = false;
    client.work.mockResolvedValueOnce(
      work("work-session-error", "合成公开正文"),
    );
    await render();
    expect(body(container)!.textContent).toBe("合成公开正文");
    expect(client.work).toHaveBeenCalledTimes(2);
  });

  it("previews immediately but reads only after the collapsed post becomes visible", async () => {
    let enter!: IntersectionObserverCallback;
    const disconnect = vi.fn();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: IntersectionObserverCallback) {
          enter = callback;
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    const pending = deferred();
    client.work.mockReturnValueOnce(pending.promise);
    const onOverflowChange = vi.fn();
    const { container, render } = await mount({
      workId: "work-visible-preview",
      expanded: false,
      preview: "正文开头",
      onOverflowChange,
    });
    expect(container.querySelector("[data-card-excerpt]")?.textContent).toBe(
      "正文开头",
    );
    expect(client.work).not.toHaveBeenCalled();
    await act(async () =>
      enter(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      ),
    );
    expect(client.work).toHaveBeenCalledOnce();
    const signal = client.work.mock.calls[0]![1] as AbortSignal;
    await render({ expanded: true });
    await render({ expanded: false });
    expect(signal.aborted).toBe(false);
    expect(client.work).toHaveBeenCalledOnce();
    await act(async () =>
      pending.resolve(work("work-visible-preview", "完整正文")),
    );
    expect(body(container)?.textContent).toBe("完整正文");
    vi.unstubAllGlobals();
  });

  it("hides both held text and the excerpt during checking, identity failure and sign-out", async () => {
    client.work.mockResolvedValueOnce(
      work("work-preview-identity", "合成私密正文"),
    );
    const { container, render } = await mount({
      workId: "work-preview-identity",
      expanded: false,
      preview: "合成私密摘要",
      onOverflowChange: vi.fn(),
    });
    expect(body(container)?.textContent).toBe("合成私密正文");
    author.checking = true;
    await render();
    expect(container.textContent).not.toContain("合成私密");
    author.checking = false;
    author.sessionError = true;
    await render();
    expect(container.textContent).not.toContain("合成私密");
    switchAccount(null);
    author.sessionError = false;
    const next = deferred();
    client.work.mockReturnValueOnce(next.promise);
    await render();
    expect(container.textContent).not.toContain("合成私密");
    await act(async () =>
      next.resolve(work("work-preview-identity", "合成公开正文")),
    );
    expect(body(container)?.textContent).toBe("合成公开正文");
  });

  it("exposes a bounded Unicode preview until expansion without changing full-text measurement", async () => {
    const fullText = "😀".repeat(170) + "全文结尾";
    client.work.mockResolvedValue(work("work-accessible-preview", fullText));
    vi.stubGlobal("getComputedStyle", () => ({ lineHeight: "20px" }));
    const width = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(300);
    const scrollHeight = vi
      .spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockReturnValue(100);
    try {
      const onOverflowChange = vi.fn();
      const { container, render } = await mount({
        workId: "work-accessible-preview",
        expanded: false,
        preview: "开头摘要",
        onOverflowChange,
      });
      expect(body(container)?.textContent).toBe(fullText);
      expect(body(container)?.getAttribute("aria-hidden")).toBe("true");
      const accessiblePreview = () =>
        container.querySelector("p:not([aria-hidden])");
      expect(accessiblePreview()?.textContent).toBe("😀".repeat(160) + "…");
      expect(accessiblePreview()?.textContent).not.toContain("全文结尾");
      expect(onOverflowChange).toHaveBeenLastCalledWith(true);

      await render({ expanded: true });
      expect(body(container)?.getAttribute("aria-hidden")).toBeNull();
      expect(accessiblePreview()).toBe(body(container));
      expect(accessiblePreview()?.textContent).toBe(fullText);

      await render({ expanded: false });
      expect(body(container)?.getAttribute("aria-hidden")).toBe("true");
      expect(accessiblePreview()?.textContent).toBe("😀".repeat(160) + "…");
      expect(client.work).toHaveBeenCalledOnce();
    } finally {
      scrollHeight.mockRestore();
      width.mockRestore();
    }
  });

  it("exposes the entire collapsed body when it fits and has no expand action", async () => {
    const fullText = "短正文".repeat(60);
    client.work.mockResolvedValue(work("work-accessible-short", fullText));
    vi.stubGlobal("getComputedStyle", () => ({ lineHeight: "20px" }));
    const width = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(300);
    const scrollHeight = vi
      .spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockReturnValue(40);
    try {
      const onOverflowChange = vi.fn();
      const { container } = await mount({
        workId: "work-accessible-short",
        expanded: false,
        onOverflowChange,
      });
      expect(onOverflowChange).toHaveBeenLastCalledWith(false);
      expect(container.querySelector("p:not([aria-hidden])")?.textContent).toBe(
        fullText,
      );
    } finally {
      scrollHeight.mockRestore();
      width.mockRestore();
    }
  });

  it("keeps hidden or zero-size body text unmeasured and resets a short-body measurement for another work", async () => {
    const opening = "正文".repeat(100);
    client.work.mockResolvedValue(work("work-measured-short", opening));
    vi.stubGlobal("getComputedStyle", () => ({ lineHeight: "20px" }));
    const width = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(300);
    const scrollHeight = vi
      .spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockReturnValue(40);
    try {
      const { container, render } = await mount({
        workId: "work-measured-short",
        expanded: false,
        onOverflowChange: vi.fn(),
      });
      expect(container.querySelector("p:not([aria-hidden])")?.textContent).toBe(
        opening,
      );
      width.mockReturnValue(0);
      scrollHeight.mockReturnValue(0);
      await hold(work("work-hidden", opening));
      await render({ workId: "work-hidden" });
      expect(container.querySelector("p:not([aria-hidden])")?.textContent).toBe(
        "正文".repeat(80) + "…",
      );
    } finally {
      scrollHeight.mockRestore();
      width.mockRestore();
    }
  });

  it("bounds a newline-heavy body with fewer than 160 code points to its visible lines", async () => {
    client.work.mockResolvedValue(
      work("work-accessible-newlines", "甲\n乙\n丙\n丁"),
    );
    vi.stubGlobal("getComputedStyle", () => ({ lineHeight: "20px" }));
    const width = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(300);
    const height = vi
      .spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockReturnValue(80);
    const createRange = document.createRange.bind(document);
    const ranges = vi.spyOn(document, "createRange").mockImplementation(() => {
      const range = createRange();
      Object.assign(range, {
        getBoundingClientRect: () => ({
          bottom: range.endOffset <= 6 ? 60 : 80,
        }),
      });
      return range;
    });
    try {
      const { container, render } = await mount({
        workId: "work-accessible-newlines",
        expanded: false,
        onOverflowChange: vi.fn(),
      });
      expect(container.querySelector("p:not([aria-hidden])")?.textContent).toBe(
        "甲\n乙\n丙…",
      );
      await render({ expanded: true });
      expect(body(container)?.textContent).toBe("甲\n乙\n丙\n丁");
    } finally {
      ranges.mockRestore();
      height.mockRestore();
      width.mockRestore();
    }
  });

  it("renders nothing and reads nothing while collapsed", async () => {
    const { container } = await mount({
      workId: "work-collapsed",
      expanded: false,
    });
    expect(container.childElementCount).toBe(0);
    expect(client.work).not.toHaveBeenCalled();
  });

  it("reads the work once on expansion and shows the full body", async () => {
    const pending = deferred();
    client.work.mockReturnValue(pending.promise);
    const { container, render } = await mount({
      workId: "work-expand",
      expanded: false,
    });
    await render({ expanded: true });
    expect(client.work).toHaveBeenCalledTimes(1);
    expect(client.work).toHaveBeenCalledWith(
      "work-expand",
      expect.any(AbortSignal),
    );
    expect(wrapper(container)!.dataset.feedPostBodyState).toBe("loading");
    expect(status(container)!.textContent).toBe("正文加载中…");
    expect(body(container)).toBeNull();

    await act(async () => pending.resolve(work("work-expand", "碑文全文")));
    expect(body(container)!.textContent).toBe("碑文全文");
    expect(wrapper(container)!.dataset.feedPostBodyState).toBe("loaded");
    expect(status(container)).toBeNull();
    expect(alert(container)).toBeNull();
    expect(client.work).toHaveBeenCalledTimes(1);
  });

  it("puts the given id on the container", async () => {
    client.work.mockReturnValue(deferred().promise);
    const { container } = await mount({
      workId: "work-id-attr",
      id: "feed-post-body-42",
    });
    expect(wrapper(container)!.id).toBe("feed-post-body-42");
  });

  it("shows a body read earlier in the document without another request", async () => {
    client.work.mockResolvedValue(work("work-cached", "已读正文"));
    const first = await mount({ workId: "work-cached" });
    await flush();
    expect(body(first.container)!.textContent).toBe("已读正文");
    expect(client.work).toHaveBeenCalledTimes(1);

    const second = await mount({ workId: "work-cached" });
    expect(body(second.container)!.textContent).toBe("已读正文");
    expect(wrapper(second.container)!.dataset.feedPostBodyState).toBe("loaded");
    expect(status(second.container)).toBeNull();
    expect(client.work).toHaveBeenCalledTimes(1);
  });

  it("keeps a held body across collapse and re-expansion", async () => {
    client.work.mockResolvedValue(work("work-toggle", "收起再展开"));
    const { container, render } = await mount({ workId: "work-toggle" });
    await flush();
    await render({ expanded: false });
    expect(container.childElementCount).toBe(0);
    await render({ expanded: true });
    expect(body(container)!.textContent).toBe("收起再展开");
    expect(client.work).toHaveBeenCalledTimes(1);
  });

  it("offers a retry for an unavailable work and loads on retry", async () => {
    client.work.mockResolvedValueOnce(work("work-unavailable", "", false));
    const { container } = await mount({ workId: "work-unavailable" });
    await flush();
    expect(wrapper(container)!.dataset.feedPostBodyState).toBe("error");
    expect(alert(container)!.textContent).toContain("正文暂时无法加载");
    expect(body(container)).toBeNull();
    expect(retry(container)).toBeDefined();

    client.work.mockResolvedValueOnce(work("work-unavailable", "重试后的正文"));
    await act(async () => retry(container)!.click());
    await flush();
    expect(client.work).toHaveBeenCalledTimes(2);
    expect(client.work).toHaveBeenLastCalledWith(
      "work-unavailable",
      expect.any(AbortSignal),
    );
    expect(body(container)!.textContent).toBe("重试后的正文");
    expect(alert(container)).toBeNull();
  });

  it("does not hold an unavailable work", async () => {
    client.work.mockResolvedValue(work("work-unavailable-cache", "", false));
    await mount({ workId: "work-unavailable-cache" });
    await flush();
    expect(readWorkSnapshot("work-unavailable-cache")).toBeNull();
    await mount({ workId: "work-unavailable-cache" });
    await flush();
    expect(client.work).toHaveBeenCalledTimes(2);
  });

  it("shows the error state when the read fails", async () => {
    client.work.mockRejectedValueOnce(new Error("offline"));
    const { container } = await mount({ workId: "work-rejected" });
    await flush();
    expect(wrapper(container)!.dataset.feedPostBodyState).toBe("error");
    expect(alert(container)!.textContent).toContain("正文暂时无法加载");
    expect(retry(container)).toBeDefined();
    expect(status(container)).toBeNull();
  });

  it("aborts a read in flight on collapse and ignores its late result", async () => {
    const pending = deferred();
    client.work.mockReturnValueOnce(pending.promise);
    const { container, render } = await mount({ workId: "work-abort" });
    const signal = client.work.mock.calls[0]![1] as AbortSignal;
    expect(signal.aborted).toBe(false);

    await render({ expanded: false });
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(work("work-abort", "迟到的正文")));
    expect(container.childElementCount).toBe(0);
    expect(readWorkSnapshot("work-abort")).toBeNull();

    // The late body was neither rendered nor held: re-expanding reads again.
    const next = deferred();
    client.work.mockReturnValueOnce(next.promise);
    await render({ expanded: true });
    expect(client.work).toHaveBeenCalledTimes(2);
    expect(body(container)).toBeNull();
    expect(status(container)).not.toBeNull();
    await act(async () => next.resolve(work("work-abort", "新的正文")));
    expect(body(container)!.textContent).toBe("新的正文");
  });

  it("ignores a late rejection after collapse", async () => {
    const pending = deferred();
    client.work.mockReturnValueOnce(pending.promise);
    const { container, render } = await mount({ workId: "work-abort-error" });
    await render({ expanded: false });
    await act(async () => pending.reject(new Error("aborted")));
    client.work.mockReturnValueOnce(deferred().promise);
    await render({ expanded: true });
    expect(alert(container)).toBeNull();
    expect(wrapper(container)!.dataset.feedPostBodyState).toBe("loading");
  });

  it("keeps the preview in place while loading and replaces it with the body", async () => {
    const pending = deferred();
    client.work.mockReturnValue(pending.promise);
    const { container } = await mount({
      workId: "work-preview",
      preview: "摘要一行",
    });
    const excerpt = container.querySelector("[data-card-excerpt]");
    expect(excerpt!.textContent).toBe("摘要一行");
    expect(status(container)).not.toBeNull();

    await act(async () => pending.resolve(work("work-preview", "完整正文")));
    expect(container.querySelector("[data-card-excerpt]")).toBeNull();
    expect(body(container)!.textContent).toBe("完整正文");
  });

  it("keeps the preview beside the error", async () => {
    client.work.mockRejectedValueOnce(new Error("offline"));
    const { container } = await mount({
      workId: "work-preview-error",
      preview: "摘要仍在",
    });
    await flush();
    expect(container.querySelector("[data-card-excerpt]")!.textContent).toBe(
      "摘要仍在",
    );
    expect(alert(container)).not.toBeNull();
  });

  it("renders no excerpt for an empty preview", async () => {
    client.work.mockReturnValue(deferred().promise);
    const { container } = await mount({
      workId: "work-preview-empty",
      preview: "",
    });
    expect(container.querySelector("[data-card-excerpt]")).toBeNull();
    expect(status(container)).not.toBeNull();
  });
});

describe("FeedPostBody with a held work", () => {
  it("shows the full text at once, with no read and no 正文加载中", async () => {
    await hold(work("work-known", "列表里的全文"));
    const expanded = await mount({ workId: "work-known" });
    expect(body(expanded.container)!.textContent).toBe("列表里的全文");
    expect(wrapper(expanded.container)!.dataset.feedPostBodyState).toBe(
      "loaded",
    );
    expect(status(expanded.container)).toBeNull();
    // A collapsed post that is on screen reads nothing either.
    const collapsed = await mount({
      workId: "work-known",
      expanded: false,
      preview: "列表里的",
      onOverflowChange: vi.fn(),
    });
    expect(body(collapsed.container)!.textContent).toBe("列表里的全文");
    expect(collapsed.container.querySelector("[data-card-excerpt]")).toBeNull();
    for (const { container } of [expanded, collapsed])
      expect(container.textContent).not.toContain("正文加载中");
    expect(client.work).not.toHaveBeenCalled();
  });

  it("hides held text while the account is checked or after a session error", async () => {
    await hold(work("work-known-identity", "合成私密全文"));
    author.checking = true;
    const { container, render } = await mount({
      workId: "work-known-identity",
    });
    expect(body(container)).toBeNull();
    expect(container.textContent).not.toContain("合成私密全文");
    author.checking = false;
    await render();
    expect(body(container)!.textContent).toBe("合成私密全文");
    author.sessionError = true;
    await render();
    expect(body(container)).toBeNull();
    expect(container.textContent).not.toContain("合成私密全文");
    expect(alert(container)!.querySelectorAll("button")).toHaveLength(1);
    expect(client.work).not.toHaveBeenCalled();
  });

  it("reads an unavailable held work again and shows its error and 重试", async () => {
    await hold(work("work-known-hidden", "运营隐藏的正文", false));
    const pending = deferred();
    client.work.mockReturnValueOnce(pending.promise);
    const { container } = await mount({ workId: "work-known-hidden" });
    expect(client.work).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain("运营隐藏的正文");
    expect(status(container)!.textContent).toBe("正文加载中…");
    await act(async () =>
      pending.resolve(work("work-known-hidden", "", false)),
    );
    expect(wrapper(container)!.dataset.feedPostBodyState).toBe("error");
    expect(alert(container)!.textContent).toContain("正文暂时无法加载");
    expect(alert(container)!.querySelectorAll("button")).toHaveLength(1);
    expect(retry(container)).toBeDefined();
  });

  it("drops a shown text once the held work turns unavailable, and reads once for its error", async () => {
    await hold(work("work-flip", "原本公开的正文"));
    const { container } = await mount({ workId: "work-flip" });
    expect(body(container)!.textContent).toBe("原本公开的正文");
    expect(client.work).not.toHaveBeenCalled();
    const pending = deferred();
    client.work.mockReturnValueOnce(pending.promise);
    // A Works list refresh or the owner's own Detail read records it hidden.
    await hold(work("work-flip", "原本公开的正文", false));
    expect(client.work).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain("原本公开的正文");
    expect(status(container)!.textContent).toBe("正文加载中…");
    await act(async () => pending.resolve(work("work-flip", "", false)));
    expect(wrapper(container)!.dataset.feedPostBodyState).toBe("error");
    expect(alert(container)!.textContent).toContain("正文暂时无法加载");
    expect(retry(container)).toBeDefined();
    await flush();
    expect(client.work).toHaveBeenCalledOnce();
  });

  it("drops text it read itself once the held work turns unavailable", async () => {
    client.work.mockResolvedValueOnce(work("work-read-flip", "自己读到的正文"));
    const { container } = await mount({ workId: "work-read-flip" });
    expect(body(container)!.textContent).toBe("自己读到的正文");
    const pending = deferred();
    client.work.mockReturnValueOnce(pending.promise);
    await hold(work("work-read-flip", "自己读到的正文", false));
    expect(client.work).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain("自己读到的正文");
    await act(async () => pending.resolve(work("work-read-flip", "", false)));
    expect(alert(container)!.textContent).toContain("正文暂时无法加载");
  });

  it("shows the newer text when the held work changes under a mounted post", async () => {
    await hold(work("work-known-update", "第一版正文"));
    const { container } = await mount({ workId: "work-known-update" });
    expect(body(container)!.textContent).toBe("第一版正文");
    await hold(work("work-known-update", "列表重读后的正文"));
    expect(body(container)!.textContent).toBe("列表重读后的正文");
    expect(client.work).not.toHaveBeenCalled();
  });

  it("reads once again after the held work is forgotten, never showing the old text", async () => {
    await hold(work("work-known-forget", "编辑前的正文"));
    const { container } = await mount({ workId: "work-known-forget" });
    expect(client.work).not.toHaveBeenCalled();
    const pending = deferred();
    client.work.mockReturnValueOnce(pending.promise);
    await act(async () => forgetWorkSnapshot("work-known-forget"));
    expect(client.work).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain("编辑前的正文");
    await act(async () =>
      pending.resolve(work("work-known-forget", "编辑后的正文")),
    );
    expect(body(container)!.textContent).toBe("编辑后的正文");
    await flush();
    expect(client.work).toHaveBeenCalledOnce();
  });

  it("holds the read's answer for the next post and Detail", async () => {
    const answer = work("work-read", "读到的全文");
    client.work.mockResolvedValueOnce(answer);
    await mount({ workId: "work-read" });
    expect(readWorkSnapshot("work-read")).toEqual(answer);
    const next = await mount({ workId: "work-read" });
    expect(body(next.container)!.textContent).toBe("读到的全文");
    expect(client.work).toHaveBeenCalledOnce();
  });

  it("holds nothing from an answer naming another work", async () => {
    client.work.mockResolvedValueOnce(work("work-other", "别的作品"));
    await mount({ workId: "work-asked" });
    expect(readWorkSnapshot("work-asked")).toBeNull();
    expect(readWorkSnapshot("work-other")).toBeNull();
  });

  it("holds nothing from a read that started under another account epoch", async () => {
    const epochRead = deferred();
    client.work.mockReturnValueOnce(epochRead.promise);
    await mount({ workId: "work-epoch" });
    // The client moves to a new epoch (A→B→A) before the post re-renders.
    identity.epoch++;
    await act(async () => epochRead.resolve(work("work-epoch", "旧纪元正文")));
    expect(readWorkSnapshot("work-epoch")).toBeNull();
    expect(client.work).toHaveBeenCalledOnce();
  });

  it("reads once more when its work is forgotten while the read runs, never showing that answer", async () => {
    const forgottenRead = deferred();
    client.work.mockReturnValueOnce(forgottenRead.promise);
    const { container } = await mount({ workId: "work-forgotten" });
    await act(async () => forgetWorkSnapshot("work-forgotten"));
    const next = deferred();
    client.work.mockReturnValueOnce(next.promise);
    await act(async () =>
      forgottenRead.resolve(work("work-forgotten", "编辑前的正文")),
    );
    expect(readWorkSnapshot("work-forgotten")).toBeNull();
    expect(container.textContent).not.toContain("编辑前的正文");
    expect(status(container)!.textContent).toBe("正文加载中…");
    expect(client.work).toHaveBeenCalledTimes(2);
    const answer = work("work-forgotten", "编辑后的正文");
    await act(async () => next.resolve(answer));
    expect(body(container)!.textContent).toBe("编辑后的正文");
    expect(readWorkSnapshot("work-forgotten")).toEqual(answer);
    await flush();
    expect(client.work).toHaveBeenCalledTimes(2);
  });

  it("hides text it read itself once the work is forgotten, and reads once more", async () => {
    client.work.mockResolvedValueOnce(work("work-read-forget", "编辑前读到的"));
    const { container } = await mount({ workId: "work-read-forget" });
    expect(body(container)!.textContent).toBe("编辑前读到的");
    const pending = deferred();
    client.work.mockReturnValueOnce(pending.promise);
    await act(async () => forgetWorkSnapshot("work-read-forget"));
    expect(client.work).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain("编辑前读到的");
    await act(async () =>
      pending.resolve(work("work-read-forget", "编辑后读到的")),
    );
    expect(body(container)!.textContent).toBe("编辑后读到的");
    await flush();
    expect(client.work).toHaveBeenCalledTimes(2);
  });
});

describe("FeedPostBody beside the bounded store", () => {
  // The store keeps the 200 most recently written works.
  const BEYOND_LIMIT = 205;
  /** A post on screen, collapsed, as in a feed or Works tab. */
  const mountShown = (workId: string) =>
    mount({ workId, expanded: false, onOverflowChange: vi.fn() });
  const others = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, index) =>
      work(`${prefix}-${index}`, `其他作品${index}`),
    );

  it("keeps a held text the store drops on screen and reads nothing", async () => {
    await hold(work("work-dropped", "作品页里的全文"));
    const { container } = await mountShown("work-dropped");
    expect(body(container)!.textContent).toBe("作品页里的全文");
    await act(async () =>
      recordWorkSnapshots(others("work-later", 200), workSnapshotToken()),
    );
    expect(readWorkSnapshot("work-dropped")).toBeNull();
    expect(body(container)!.textContent).toBe("作品页里的全文");
    expect(wrapper(container)!.dataset.feedPostBodyState).toBe("loaded");
    await flush();
    expect(client.work).not.toHaveBeenCalled();
  });

  it("reads each of more posts than the store holds exactly once", async () => {
    client.work.mockImplementation(async (id: string) => work(id, `正文${id}`));
    const ids = Array.from(
      { length: BEYOND_LIMIT },
      (_, index) => `work-many-${index}`,
    );
    const posts = [];
    for (const id of ids) posts.push(await mountShown(id));
    await flush();
    await flush();
    expect(client.work).toHaveBeenCalledTimes(BEYOND_LIMIT);
    expect(readWorkSnapshot(ids[0]!)).toBeNull();
    posts.forEach(({ container }, index) => {
      expect(body(container)!.textContent).toBe(`正文${ids[index]}`);
      expect(wrapper(container)!.dataset.feedPostBodyState).toBe("loaded");
    });
  });

  it("after a forget, reads a post whose record the store drops once more without recording it", async () => {
    client.work.mockImplementation(async (id: string) => work(id, `正文${id}`));
    const ids = Array.from(
      { length: BEYOND_LIMIT },
      (_, index) => `work-forget-${index}`,
    );
    const posts = [];
    for (const id of ids) posts.push(await mountShown(id));
    await flush();
    expect(client.work).toHaveBeenCalledTimes(BEYOND_LIMIT);
    // The store cannot say which work a forget was for, so the three posts
    // whose records the next write drops read again, once, for themselves.
    await act(async () => forgetWorkSnapshot("work-unrelated"));
    client.work.mockImplementation(async (id: string) => work(id, `重读${id}`));
    await act(async () =>
      recordWorkSnapshots(others("work-newer", 3), workSnapshotToken()),
    );
    await flush();
    await flush();
    expect(client.work).toHaveBeenCalledTimes(BEYOND_LIMIT + 3);
    const dropped = ids.slice(BEYOND_LIMIT - 200, BEYOND_LIMIT - 200 + 3);
    for (const id of dropped) {
      expect(readWorkSnapshot(id)).toBeNull();
      expect(body(posts[ids.indexOf(id)]!.container)!.textContent).toBe(
        `重读${id}`,
      );
    }
    // Dropped before the forget: kept as shown.
    expect(body(posts[0]!.container)!.textContent).toBe(`正文${ids[0]}`);
  });
});

describe("FeedPostBody's Detail opener", () => {
  /** The opener sits outside every alert and status row. */
  const outsideRows = (container: HTMLElement) =>
    opener(container)!.closest('[role="alert"], [role="status"]') === null;

  it("covers the displayed text and passes its button to onOpen", async () => {
    await hold(work("work-opener", "列表里的全文"));
    const onOpen = vi.fn();
    const { container } = await mount({ workId: "work-opener", onOpen });
    const button = opener(container)!;
    expect(button.getAttribute("aria-label")).toBe("查看详情");
    expect(button.getAttribute("type")).toBe("button");
    expect(button.textContent).toBe("");
    // The opener comes last beside the text it covers.
    expect(button.parentElement).toBe(body(container)!.parentElement);
    expect(button.parentElement!.lastElementChild).toBe(button);
    expect(button.hasAttribute("data-open-catalog")).toBe(false);
    expect(button.hasAttribute("data-local-horizontal")).toBe(false);
    // A programmatic or keyboard click has detail 0; a pointer tap does not.
    act(() => button.click());
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenLastCalledWith(button, false);
    act(() => {
      button.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }),
      );
    });
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(onOpen).toHaveBeenLastCalledWith(button, true);
  });

  it("renders no opener over a loaded empty text", async () => {
    await hold(work("work-opener-empty", ""));
    const onOpen = vi.fn();
    const { container } = await mount({
      workId: "work-opener-empty",
      preview: "旧的开头",
      onOpen,
    });
    expect(opener(container)).toBeNull();
  });

  it("renders no opener without onOpen", async () => {
    await hold(work("work-no-opener", "列表里的全文"));
    const { container } = await mount({ workId: "work-no-opener" });
    expect(body(container)!.textContent).toBe("列表里的全文");
    expect(opener(container)).toBeNull();
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("appears only while text is displayed, never in the status or alert row", async () => {
    const onOpen = vi.fn();
    const pending = deferred();
    client.work.mockReturnValueOnce(pending.promise);
    const loading = await mount({ workId: "work-opener-loading", onOpen });
    expect(status(loading.container)!.textContent).toBe("正文加载中…");
    expect(opener(loading.container)).toBeNull();
    await act(async () =>
      pending.resolve(work("work-opener-loading", "读到的全文")),
    );
    expect(body(loading.container)!.textContent).toBe("读到的全文");
    expect(outsideRows(loading.container)).toBe(true);

    // The preview is displayed text: it shows the opener while reading.
    client.work.mockReturnValueOnce(deferred().promise);
    const previewing = await mount({
      workId: "work-opener-preview",
      preview: "正文开头",
      onOpen,
    });
    expect(status(previewing.container)).not.toBeNull();
    expect(opener(previewing.container)).not.toBeNull();
    expect(outsideRows(previewing.container)).toBe(true);

    client.work.mockRejectedValueOnce(new Error("offline"));
    const failed = await mount({
      workId: "work-opener-error",
      preview: "正文开头",
      onOpen,
    });
    expect(alert(failed.container)!.textContent).toContain("正文暂时无法加载");
    expect(opener(failed.container)).not.toBeNull();
    expect(outsideRows(failed.container)).toBe(true);
    expect([...alert(failed.container)!.querySelectorAll("button")]).toEqual([
      retry(failed.container),
    ]);

    client.work.mockRejectedValueOnce(new Error("offline"));
    const bare = await mount({ workId: "work-opener-bare", onOpen });
    expect(alert(bare.container)).not.toBeNull();
    expect(opener(bare.container)).toBeNull();
    expect([...bare.container.querySelectorAll("button")]).toEqual([
      retry(bare.container),
    ]);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("is withdrawn while the account is checked or after a session error", async () => {
    await hold(work("work-opener-identity", "合成私密全文"));
    const onOpen = vi.fn();
    const { container, render } = await mount({
      workId: "work-opener-identity",
      preview: "合成私密摘要",
      onOpen,
    });
    expect(opener(container)).not.toBeNull();
    author.checking = true;
    await render();
    expect(opener(container)).toBeNull();
    author.checking = false;
    author.sessionError = true;
    await render();
    expect(opener(container)).toBeNull();
    // 重试 stays the alert's only button.
    expect([...container.querySelectorAll("button")]).toEqual([
      retry(container),
    ]);
    expect(alert(container)!.querySelectorAll("button")).toHaveLength(1);
  });

  it("follows the bounded accessible opening and keeps the text's aria-hidden rule", async () => {
    const fullText = "😀".repeat(170) + "全文结尾";
    client.work.mockResolvedValue(work("work-opener-a11y", fullText));
    vi.stubGlobal("getComputedStyle", () => ({ lineHeight: "20px" }));
    const width = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(300);
    const scrollHeight = vi
      .spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockReturnValue(100);
    try {
      const onOverflowChange = vi.fn();
      const { container, render } = await mount({
        workId: "work-opener-a11y",
        expanded: false,
        preview: "开头摘要",
        onOverflowChange,
        onOpen: vi.fn(),
      });
      const accessible = () =>
        [...container.querySelectorAll("p:not([aria-hidden]), button")].map(
          (node) =>
            node.tagName === "BUTTON"
              ? `button:${node.getAttribute("aria-label")}`
              : node.textContent,
        );
      expect(body(container)?.getAttribute("aria-hidden")).toBe("true");
      expect(accessible()).toEqual(["😀".repeat(160) + "…", "button:查看详情"]);
      expect(onOverflowChange).toHaveBeenLastCalledWith(true);

      await render({ expanded: true });
      expect(body(container)?.getAttribute("aria-hidden")).toBeNull();
      expect(accessible()).toEqual([fullText, "button:查看详情"]);

      await render({ expanded: false });
      expect(body(container)?.getAttribute("aria-hidden")).toBe("true");
      expect(accessible()).toEqual(["😀".repeat(160) + "…", "button:查看详情"]);
      expect(client.work).toHaveBeenCalledOnce();
    } finally {
      scrollHeight.mockRestore();
      width.mockRestore();
    }
  });
});
