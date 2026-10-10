// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ComponentProps } from "react";
import type { Root } from "react-dom/client";

const { client } = vi.hoisted(() => ({ client: { work: vi.fn() } }));
vi.mock("./author-data", () => ({ authorClient: client }));

import { FeedPostBody } from "./feed-post-body";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type BodyProps = ComponentProps<typeof FeedPostBody>;
// Only the fields the body reads; the real work view carries more.
type WorkStub = { readonly available: boolean; readonly text: string };

const deferred = () => {
  let resolve!: (value: WorkStub) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<WorkStub>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
const work = (text: string, available = true): WorkStub => ({
  available,
  text,
});
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

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  client.work.mockReset();
});

describe("FeedPostBody", () => {
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

    await act(async () => pending.resolve(work("碑文全文")));
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
    client.work.mockResolvedValue(work("已读正文"));
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

  it("keeps a cached body across collapse and re-expansion", async () => {
    client.work.mockResolvedValue(work("收起再展开"));
    const { container, render } = await mount({ workId: "work-toggle" });
    await flush();
    await render({ expanded: false });
    expect(container.childElementCount).toBe(0);
    await render({ expanded: true });
    expect(body(container)!.textContent).toBe("收起再展开");
    expect(client.work).toHaveBeenCalledTimes(1);
  });

  it("offers a retry for an unavailable work and loads on retry", async () => {
    client.work.mockResolvedValueOnce(work("", false));
    const { container } = await mount({ workId: "work-unavailable" });
    await flush();
    expect(wrapper(container)!.dataset.feedPostBodyState).toBe("error");
    expect(alert(container)!.textContent).toContain("正文暂时无法加载");
    expect(body(container)).toBeNull();
    expect(retry(container)).toBeDefined();

    client.work.mockResolvedValueOnce(work("重试后的正文"));
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

  it("does not cache an unavailable work", async () => {
    client.work.mockResolvedValue(work("", false));
    await mount({ workId: "work-unavailable-cache" });
    await flush();
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
    await act(async () => pending.resolve(work("迟到的正文")));
    expect(container.childElementCount).toBe(0);

    // The late body was neither rendered nor cached: re-expanding reads again.
    const next = deferred();
    client.work.mockReturnValueOnce(next.promise);
    await render({ expanded: true });
    expect(client.work).toHaveBeenCalledTimes(2);
    expect(body(container)).toBeNull();
    expect(status(container)).not.toBeNull();
    await act(async () => next.resolve(work("新的正文")));
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

    await act(async () => pending.resolve(work("完整正文")));
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
