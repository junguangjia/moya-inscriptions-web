// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Root } from "react-dom/client";
import type { CommentViewerState } from "../comments/comment-section";
import type { CommentReplyTarget } from "../comments/comment-types";
import type { FeedColophonComposerProps } from "./feed-colophon-composer";
import type { FeedStageApi } from "./feed-post-stage-context";

const authReturn = vi.hoisted(() => ({
  remember: vi.fn(),
  take: vi.fn<(owner: string, content: string) => unknown>(),
}));
const mention = vi.hoisted(() => ({
  onChange: null as ((text: string, refs: unknown[]) => void) | null,
}));

vi.mock("../auth/auth-return", () => ({
  useAuthReturn: () => authReturn,
}));
vi.mock("../notifications/mention-control", () => ({
  MentionControl: (props: {
    onChange: (text: string, refs: unknown[]) => void;
  }) => {
    mention.onChange = props.onChange;
    return null;
  },
}));

import {
  colophonComposerScene,
  colophonDraftKey,
  colophonPostCovered,
  colophonPostShownAboveBar,
  colophonPostVisible,
  FeedColophonComposer,
  useColophonComposer,
} from "./feed-colophon-composer";
import { FeedStageContext } from "./feed-post-stage-context";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const signedIn: CommentViewerState = { state: "signed-in" };
const replyTo: CommentReplyTarget = {
  rootCommentId: "root-1",
  user: { id: "u2", name: "石门" },
};

const roots: Root[] = [];
const mount = (node: React.ReactNode) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(node));
  return {
    container,
    rerender: (next: React.ReactNode) => act(() => root.render(next)),
  };
};

/** A controlled composer with test doubles for every callback. */
const renderComposer = (overrides: Partial<FeedColophonComposerProps> = {}) => {
  const textareaRef = { current: null as HTMLTextAreaElement | null };
  const props: FeedColophonComposerProps = {
    contentKey: "work:w1",
    actorId: "u1",
    viewerState: signedIn,
    open: true,
    replyTarget: null,
    submitting: false,
    onSubmit: vi.fn(() => Promise.resolve(true)),
    onCancel: vi.fn(),
    onReplyTargetChange: vi.fn(),
    textareaRef,
    ...overrides,
  };
  const view = mount(<FeedColophonComposer {...props} />);
  const form = view.container.querySelector<HTMLFormElement>(
    "[data-colophon-composer]",
  )!;
  const textarea = form.querySelector("textarea")!;
  return {
    ...view,
    props,
    form,
    textarea,
    rerender: (next: Partial<FeedColophonComposerProps>) =>
      view.rerender(<FeedColophonComposer {...props} {...next} />),
  };
};

const type = (textarea: HTMLTextAreaElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });

const submit = async (form: HTMLFormElement) => {
  await act(async () => {
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
};

/** Uses the hook the way the colophon does: open inside a tap handler. */
const Harness = ({
  contentKey,
  probe,
  scene,
  observe,
}: {
  readonly contentKey: string;
  readonly probe?: (state: { open: string; focused: boolean }) => void;
  readonly scene?: string;
  readonly observe?: Element | null;
}) => {
  const composer = useColophonComposer(contentKey, {
    ...(scene === undefined ? {} : { scene }),
    ...(observe === undefined ? {} : { observe }),
  });
  const formHost = useRef<HTMLDivElement>(null);
  return (
    <div ref={formHost} data-harness={contentKey}>
      <button
        data-write=""
        onClick={(event) => {
          composer.openComposer(null, event.currentTarget);
          probe?.({
            open:
              formHost.current
                ?.querySelector("[data-colophon-composer]")
                ?.getAttribute("data-open") ?? "",
            focused: document.activeElement === composer.textareaRef.current,
          });
        }}
        type="button"
      >
        写题跋
      </button>
      <button
        data-reply=""
        onClick={(event) => composer.openComposer(replyTo, event.currentTarget)}
        type="button"
      >
        回复
      </button>
      <FeedColophonComposer
        actorId="u1"
        contentKey={contentKey}
        onCancel={composer.close}
        onReplyTargetChange={composer.setReplyTarget}
        onSubmit={() => Promise.resolve(true)}
        open={composer.open}
        replyTarget={composer.replyTarget}
        submitting={false}
        textareaRef={composer.textareaRef}
        viewerState={signedIn}
      />
    </div>
  );
};

const stageApi = (change: Partial<FeedStageApi> = {}): FeedStageApi => ({
  strip: null,
  count: 1,
  region: "comments",
  readOffset: () => 0,
  scrollToOffset: vi.fn(),
  scrollToElement: vi.fn(),
  setCommentsAnchor: vi.fn(),
  subscribeSettle: () => () => undefined,
  isSettled: () => true,
  viewerOpen: false,
  ...change,
});

/** Animation frames that run only when flushed. */
const stubFrames = () => {
  const queue = new Map<number, FrameRequestCallback>();
  let next = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    next += 1;
    queue.set(next, callback);
    return next;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => queue.delete(id));
  return {
    flush: () => {
      const callbacks = [...queue.values()];
      queue.clear();
      for (const callback of callbacks) callback(0);
    },
  };
};

const composerOf = (container: HTMLElement, key: string) =>
  container.querySelector<HTMLFormElement>(
    `[data-harness="${key}"] [data-colophon-composer]`,
  )!;
const click = (element: Element) =>
  act(() => {
    element.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }),
    );
  });

beforeEach(() => {
  authReturn.remember.mockReset();
  authReturn.take.mockReset();
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("FeedColophonComposer", () => {
  it("keeps drafts apart from Detail's under a feed: key", () => {
    expect(colophonDraftKey("work:w1")).toBe("feed:work:w1");
    expect(colophonDraftKey("feed:work:w1")).toBe("feed:work:w1");
  });

  it("is mounted but marked closed until opened", () => {
    const { form, textarea } = renderComposer({ open: false });
    expect(form.dataset.open).toBe("false");
    expect(textarea.isConnected).toBe(true);
  });

  it("clears the draft only when the send is accepted", async () => {
    let settle: (accepted: boolean) => void = () => undefined;
    const onSubmit = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          settle = resolve;
        }),
    );
    const { form, textarea, props } = renderComposer({ onSubmit });
    type(textarea, "  墨色如新  ");
    await submit(form);
    expect(onSubmit).toHaveBeenCalledWith("墨色如新", [], null);
    await act(async () => settle(false));
    expect(textarea.value).toBe("  墨色如新  ");
    expect(props.onCancel).not.toHaveBeenCalled();
    await submit(form);
    await act(async () => settle(true));
    expect(textarea.value).toBe("");
    expect(props.onCancel).toHaveBeenCalledOnce();
  });

  it("keeps a draft edited while its send was in flight", async () => {
    let settle: (accepted: boolean) => void = () => undefined;
    const { form, textarea } = renderComposer({
      onSubmit: () =>
        new Promise<boolean>((resolve) => {
          settle = resolve;
        }),
    });
    type(textarea, "初稿");
    await submit(form);
    type(textarea, "初稿又改");
    await act(async () => settle(true));
    expect(textarea.value).toBe("初稿又改");
  });

  it("sends nothing for blank text or while sending", async () => {
    const onSubmit = vi.fn(() => Promise.resolve(true));
    const { form, textarea, rerender } = renderComposer({ onSubmit });
    type(textarea, "   ");
    await submit(form);
    type(textarea, "题");
    rerender({ submitting: true });
    await submit(form);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(
      form.querySelector("[data-colophon-composer-send]")!.textContent,
    ).toBe("发送中…");
  });

  it("remembers the draft for the signed-in reader under the feed: key", () => {
    const { textarea } = renderComposer({ replyTarget: replyTo });
    type(textarea, "回题");
    expect(authReturn.remember).toHaveBeenLastCalledWith("u1", "feed:work:w1", {
      draft: "回题",
      mentions: [],
      replyTarget: replyTo,
    });
  });

  it("restores a remembered draft and reply target after sign-in", () => {
    authReturn.take.mockReturnValue({
      draft: "未竟之题",
      mentions: [],
      replyTarget: replyTo,
    });
    const onReplyTargetChange = vi.fn();
    const { textarea } = renderComposer({ onReplyTargetChange });
    expect(authReturn.take).toHaveBeenCalledWith("u1", "feed:work:w1");
    expect(textarea.value).toBe("未竟之题");
    expect(onReplyTargetChange).toHaveBeenCalledWith(replyTo);
  });

  it("never remembers or restores for a guest", () => {
    const { textarea } = renderComposer({
      actorId: null,
      viewerState: { state: "signed-out", signInHref: "/login" },
    });
    type(textarea, "访客");
    expect(authReturn.take).not.toHaveBeenCalled();
    expect(authReturn.remember).not.toHaveBeenCalled();
  });

  it("shows the reply bar whose 取消 drops the reply and closes", () => {
    const onReplyTargetChange = vi.fn();
    const onCancel = vi.fn();
    const { form, textarea } = renderComposer({
      replyTarget: replyTo,
      onReplyTargetChange,
      onCancel,
    });
    const head = form.querySelector("[data-colophon-reply-mode]")!;
    expect(head.textContent).toContain("回复 石门");
    expect(textarea.placeholder).toBe("回复 石门…");
    click(form.querySelector("[data-colophon-composer-cancel]")!);
    expect(onReplyTargetChange).toHaveBeenCalledWith(null);
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("closes a new colophon from 取消 or Escape in the box", () => {
    const onCancel = vi.fn();
    const { form, textarea } = renderComposer({ onCancel });
    expect(form.querySelector("[data-colophon-reply-mode]")).toBeNull();
    expect(textarea.placeholder).toBe("写题跋…");
    expect(textarea.getAttribute("aria-label")).toBe("题跋内容");
    expect(textarea.maxLength).toBe(1000);
    click(form.querySelector("[data-colophon-composer-cancel]")!);
    act(() => {
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
      );
    });
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it("drops the bottom safe area above the keyboard", () => {
    const viewport = {
      height: 844,
      offsetTop: 0,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal("visualViewport", viewport);
    vi.stubGlobal("innerHeight", 844);
    const closed = renderComposer();
    expect(closed.form.style.getPropertyValue("--colophon-safe-bottom")).toBe(
      "",
    );
    viewport.height = 500;
    const raised = renderComposer();
    expect(raised.form.style.getPropertyValue("--colophon-safe-bottom")).toBe(
      "0px",
    );
  });
});

describe("useColophonComposer", () => {
  it("opens and focuses the box inside the tap that asked for it", () => {
    const probe = vi.fn();
    const { container } = mount(<Harness contentKey="work:w1" probe={probe} />);
    expect(composerOf(container, "work:w1").dataset.open).toBe("false");
    click(container.querySelector("[data-write]")!);
    expect(probe).toHaveBeenCalledWith({ open: "true", focused: true });
  });

  it("opens in reply mode for a reply", () => {
    const { container } = mount(<Harness contentKey="work:w1" />);
    click(container.querySelector("[data-reply]")!);
    const form = composerOf(container, "work:w1");
    expect(form.dataset.open).toBe("true");
    expect(form.querySelector("[data-colophon-reply-mode]")).not.toBeNull();
  });

  it("returns focus to the opener when the reader closes the bar", () => {
    const { container } = mount(<Harness contentKey="work:w1" />);
    const write = container.querySelector<HTMLElement>("[data-write]")!;
    click(write);
    const form = composerOf(container, "work:w1");
    expect(document.activeElement).toBe(form.querySelector("textarea"));
    click(form.querySelector("[data-colophon-composer-cancel]")!);
    expect(form.dataset.open).toBe("false");
    expect(document.activeElement).toBe(write);
  });

  it("leaves focus alone when another post's composer takes over", () => {
    const { container } = mount(
      <>
        <Harness contentKey="work:a" />
        <Harness contentKey="work:b" />
      </>,
    );
    click(container.querySelector('[data-harness="work:a"] [data-write]')!);
    click(container.querySelector('[data-harness="work:b"] [data-write]')!);
    expect(document.activeElement).toBe(
      composerOf(container, "work:b").querySelector("textarea"),
    );
  });

  it("keeps an unsent reply's target on 写题跋, and starts a colophon once the box is empty", () => {
    const { container } = mount(<Harness contentKey="work:w1" />);
    click(container.querySelector("[data-reply]")!);
    const form = composerOf(container, "work:w1");
    type(form.querySelector("textarea")!, "未发的回复");
    click(container.querySelector("[data-write]")!);
    expect(form.querySelector("[data-colophon-reply-mode]")).not.toBeNull();
    type(form.querySelector("textarea")!, "");
    click(container.querySelector("[data-write]")!);
    expect(form.querySelector("[data-colophon-reply-mode]")).toBeNull();
  });

  it("closes one post's composer when another post opens its own", () => {
    const { container } = mount(
      <>
        <Harness contentKey="work:a" />
        <Harness contentKey="work:b" />
      </>,
    );
    click(container.querySelector('[data-harness="work:a"] [data-write]')!);
    expect(composerOf(container, "work:a").dataset.open).toBe("true");
    click(container.querySelector('[data-harness="work:b"] [data-write]')!);
    expect(composerOf(container, "work:a").dataset.open).toBe("false");
    expect(composerOf(container, "work:b").dataset.open).toBe("true");
  });

  it("closes when the post's viewer opens", () => {
    const view = mount(
      <FeedStageContext.Provider value={stageApi()}>
        <Harness contentKey="work:w1" />
      </FeedStageContext.Provider>,
    );
    click(view.container.querySelector("[data-write]")!);
    expect(composerOf(view.container, "work:w1").dataset.open).toBe("true");
    view.rerender(
      <FeedStageContext.Provider value={stageApi({ viewerOpen: true })}>
        <Harness contentKey="work:w1" />
      </FeedStageContext.Provider>,
    );
    expect(composerOf(view.container, "work:w1").dataset.open).toBe("false");
  });

  it("closes when the post's stage leaves the viewport", () => {
    let report: IntersectionObserverCallback = () => undefined;
    const observe = vi.fn();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: IntersectionObserverCallback) {
          report = callback;
        }
        observe = observe;
        disconnect() {}
      },
    );
    const strip = document.createElement("div");
    const { container } = mount(
      <FeedStageContext.Provider value={stageApi({ strip })}>
        <Harness contentKey="work:w1" />
      </FeedStageContext.Provider>,
    );
    click(container.querySelector("[data-write]")!);
    expect(observe).toHaveBeenCalledWith(strip);
    act(() =>
      report(
        [{ isIntersecting: false } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      ),
    );
    expect(composerOf(container, "work:w1").dataset.open).toBe("false");
  });
  it("closes when the post rests edge to edge with the viewport, keeping the draft and leaving focus alone", () => {
    let report: IntersectionObserverCallback = () => undefined;
    let init: IntersectionObserverInit | undefined;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(
          callback: IntersectionObserverCallback,
          options?: IntersectionObserverInit,
        ) {
          report = callback;
          init = options;
        }
        observe() {}
        disconnect() {}
      },
    );
    const article = document.createElement("article");
    document.body.append(article);
    const { container } = mount(
      <Harness contentKey="work:w1" observe={article} />,
    );
    const write = container.querySelector<HTMLElement>("[data-write]")!;
    click(write);
    const form = composerOf(container, "work:w1");
    const textarea = form.querySelector("textarea")!;
    type(textarea, "未发的题跋");
    expect(document.activeElement).toBe(textarea);
    // A sliver inside the viewport's edge no longer counts as shown.
    expect(init?.rootMargin).toBe("-1px");
    const edge = (width: number) =>
      ({
        isIntersecting: true,
        intersectionRect: { width, height: 300 },
      }) as IntersectionObserverEntry;
    act(() => report([edge(120)], {} as IntersectionObserver));
    expect(form.dataset.open).toBe("true");
    // A Home panel slid away: still "intersecting", with no area.
    act(() => report([edge(0)], {} as IntersectionObserver));
    expect(form.dataset.open).toBe("false");
    expect(textarea.value).toBe("未发的题跋");
    expect(document.activeElement).not.toBe(write);
    expect(document.activeElement).not.toBe(textarea);
  });

  it("closes when the Home tab holding the post is no longer the shown one", async () => {
    const panel = document.createElement("div");
    const article = document.createElement("article");
    panel.append(article);
    document.body.append(panel);
    const { container } = mount(
      <Harness contentKey="work:w1" observe={article} />,
    );
    click(container.querySelector("[data-write]")!);
    const form = composerOf(container, "work:w1");
    type(form.querySelector("textarea")!, "草稿");
    expect(form.dataset.open).toBe("true");
    await act(async () => {
      panel.setAttribute("inert", "");
      await Promise.resolve();
    });
    expect(form.dataset.open).toBe("false");
    expect(form.querySelector("textarea")!.value).toBe("草稿");
  });

  it("closes when a modal layer the shell does not track covers the post", async () => {
    // jsdom has no showModal: its open dialogs stand in for modal ones.
    const query = document.querySelectorAll.bind(document);
    const modal = vi
      .spyOn(document, "querySelectorAll")
      .mockImplementation((selectors: string) =>
        query(selectors === "dialog:modal" ? "dialog[open]" : selectors),
      );
    const article = document.createElement("article");
    document.body.append(article);
    const { container } = mount(
      <Harness contentKey="work:w1" observe={article} />,
    );
    const write = container.querySelector<HTMLElement>("[data-write]")!;
    click(write);
    const form = composerOf(container, "work:w1");
    const textarea = form.querySelector("textarea")!;
    type(textarea, "草稿");
    expect(document.activeElement).toBe(textarea);
    // A dialog that holds the post (a profile showing it) is its own scene.
    const holder = document.createElement("dialog");
    document.body.append(holder);
    holder.append(article);
    await act(async () => {
      holder.setAttribute("open", "");
      await Promise.resolve();
    });
    expect(form.dataset.open).toBe("true");
    // 消息 opens over it.
    const messages = document.createElement("dialog");
    document.body.append(messages);
    await act(async () => {
      messages.setAttribute("open", "");
      await Promise.resolve();
    });
    expect(form.dataset.open).toBe("false");
    expect(textarea.value).toBe("草稿");
    expect(document.activeElement).not.toBe(write);
    expect(colophonPostCovered(article)).toBe(true);
    // Closed, it hands focus back to the closed box: the opener takes it.
    await act(async () => {
      messages.remove();
      await Promise.resolve();
    });
    expect(colophonPostCovered(article)).toBe(false);
    expect(document.activeElement).toBe(write);
    expect(form.dataset.open).toBe("false");
    modal.mockRestore();
  });

  it("closes when the shell shows another destination or opens a layer", () => {
    const home = colophonComposerScene({
      activeDestination: "home",
      activeContent: null,
      activeProfile: null,
      activeFeedViewer: null,
      activeEditor: null,
      activeTopicId: null,
      activeViewerMediaId: null,
      settingsOpen: false,
    });
    const view = mount(<Harness contentKey="work:w1" scene={home} />);
    const write = view.container.querySelector<HTMLElement>("[data-write]")!;
    click(write);
    const form = composerOf(view.container, "work:w1");
    type(form.querySelector("textarea")!, "草稿");
    view.rerender(<Harness contentKey="work:w1" scene={home} />);
    expect(form.dataset.open).toBe("true");
    view.rerender(
      <Harness
        contentKey="work:w1"
        scene={colophonComposerScene({ activeDestination: "discussion" })}
      />,
    );
    expect(form.dataset.open).toBe("false");
    expect(form.querySelector("textarea")!.value).toBe("草稿");
    expect(document.activeElement).not.toBe(write);
    // Opened again in the new scene, it stays until that one changes.
    click(write);
    expect(form.dataset.open).toBe("true");
  });

  it("tells every layer over the feed apart", () => {
    const base = colophonComposerScene({ activeDestination: "home" });
    expect(colophonComposerScene({ activeDestination: "home" })).toBe(base);
    expect(colophonComposerScene(null)).not.toBe(base);
    for (const layer of [
      { activeContent: { type: "work", id: "w1" } },
      {
        activeProfile: {
          kind: "profile",
          authorId: "a1",
          entryId: "e1",
          tab: "works",
        },
      },
      {
        activeFeedViewer: {
          target: { type: "work", id: "w1" },
          mediaId: "m1",
        },
      },
      { activeEditor: { type: "new" } },
      { activeTopicId: "t1" },
      { activeViewerMediaId: "m1" },
      { settingsOpen: true },
    ])
      expect(
        colophonComposerScene({
          activeDestination: "home",
          ...(layer as Partial<Parameters<typeof colophonComposerScene>[0]>),
        }),
      ).not.toBe(base);
  });

  it("closes when the page is hidden", () => {
    const { container } = mount(<Harness contentKey="work:w1" />);
    click(container.querySelector("[data-write]")!);
    const form = composerOf(container, "work:w1");
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    visibility.mockRestore();
    expect(form.dataset.open).toBe("false");
  });

  it("tells the preview every committed draft, and only those", async () => {
    authReturn.take.mockReturnValue({
      draft: "登录前的题",
      mentions: [],
      replyTarget: null,
    });
    const onDraftChange = vi.fn();
    let settle: (accepted: boolean) => void = () => undefined;
    const { form, textarea } = renderComposer({
      onDraftChange,
      onSubmit: () =>
        new Promise<boolean>((resolve) => {
          settle = resolve;
        }),
    });
    // The first commit, then the text restored after sign-in.
    expect(onDraftChange.mock.calls.map(([draft]) => draft)).toEqual([
      "",
      "登录前的题",
    ]);
    type(textarea, "寒山 10月");
    act(() => mention.onChange?.("寒山 10月 @石门 ", []));
    expect(onDraftChange).toHaveBeenLastCalledWith("寒山 10月 @石门 ");
    const calls = onDraftChange.mock.calls.length;
    // An unchanged draft is not told again.
    type(textarea, "寒山 10月 @石门 ");
    expect(onDraftChange).toHaveBeenCalledTimes(calls);
    // A rejected send keeps it, an accepted one empties it.
    await submit(form);
    await act(async () => settle(false));
    expect(onDraftChange).toHaveBeenCalledTimes(calls);
    await submit(form);
    await act(async () => settle(true));
    expect(onDraftChange).toHaveBeenLastCalledWith("");
    expect(onDraftChange).toHaveBeenCalledTimes(calls + 1);
  });

  it("names its form for the preview and describes the box", () => {
    const { form, textarea } = renderComposer({ formId: "colophon-form" });
    expect(form.id).toBe("colophon-form");
    const hint = document.getElementById(
      textarea.getAttribute("aria-describedby") ?? "",
    );
    expect(hint?.textContent).toBe("输入内容会在上方题跋中竖排预览");
    expect(form.contains(hint)).toBe(true);
  });

  it("counts a post shown only above the bar, in the visual viewport", () => {
    const shown = (
      postTop: number,
      postBottom: number,
      barTop: number | null,
    ) =>
      colophonPostShownAboveBar({
        postTop,
        postBottom,
        viewportTop: 0,
        viewportBottom: 800,
        barTop,
      });
    // About 60 px above the bar.
    expect(shown(540, 1200, 600)).toBe(true);
    // Its top 20 px under the bar's: hidden behind the bar.
    expect(shown(620, 1200, 600)).toBe(false);
    // A sliver under the minimum.
    expect(shown(590, 1200, 600)).toBe(false);
    // Without a bar box, the visual viewport alone.
    expect(shown(620, 1200, null)).toBe(true);
    expect(
      colophonPostShownAboveBar({
        postTop: 100,
        postBottom: 300,
        viewportTop: 320,
        viewportBottom: 700,
        barTop: 600,
      }),
    ).toBe(false);
  });

  it("closes when the reader scrolls the post behind the bar, keeping the draft and focus untouched", () => {
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const frames = stubFrames();
    const article = document.createElement("article");
    document.body.append(article);
    let postTop = 300;
    const { container } = mount(
      <Harness contentKey="work:w1" observe={article} />,
    );
    const form = composerOf(container, "work:w1");
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        if (this === form)
          return { top: 600, bottom: 700, height: 100 } as DOMRect;
        if (this === article)
          return {
            top: postTop,
            bottom: postTop + 600,
            height: 600,
          } as DOMRect;
        return { top: 0, bottom: 0, height: 0 } as DOMRect;
      },
    );
    const write = container.querySelector<HTMLElement>("[data-write]")!;
    click(write);
    const textarea = form.querySelector("textarea")!;
    type(textarea, "未发的题跋");
    const scroll = () =>
      act(() => {
        document.dispatchEvent(new Event("scroll"));
        frames.flush();
      });
    // About 60 px still above the bar: it stays.
    postTop = 540;
    scroll();
    expect(form.dataset.open).toBe("true");
    // Its top 20 px below the bar's top: only behind the bar.
    postTop = 620;
    scroll();
    expect(form.dataset.open).toBe("false");
    expect(textarea.value).toBe("未发的题跋");
    expect(document.activeElement).not.toBe(write);
  });

  it("never closes for a post that opened under the bar until it has shown above it", () => {
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const frames = stubFrames();
    const article = document.createElement("article");
    document.body.append(article);
    let postTop = 640;
    const { container } = mount(
      <Harness contentKey="work:w1" observe={article} />,
    );
    const form = composerOf(container, "work:w1");
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        if (this === form)
          return { top: 600, bottom: 700, height: 100 } as DOMRect;
        if (this === article)
          return {
            top: postTop,
            bottom: postTop + 600,
            height: 600,
          } as DOMRect;
        return { top: 0, bottom: 0, height: 0 } as DOMRect;
      },
    );
    click(container.querySelector("[data-write]")!);
    const scroll = () =>
      act(() => {
        document.dispatchEvent(new Event("scroll"));
        frames.flush();
      });
    scroll();
    expect(form.dataset.open).toBe("true");
    postTop = 400;
    scroll();
    postTop = 640;
    scroll();
    expect(form.dataset.open).toBe("false");
  });

  it("stays open when the keyboard lifts the bar over a low post and the feed then scrolls", () => {
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const frames = stubFrames();
    const article = document.createElement("article");
    document.body.append(article);
    let postTop = 330;
    let barTop = 600;
    const { container } = mount(
      <Harness contentKey="work:w1" observe={article} />,
    );
    const form = composerOf(container, "work:w1");
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        if (this === form)
          return { top: barTop, bottom: barTop + 100, height: 100 } as DOMRect;
        if (this === article)
          return {
            top: postTop,
            bottom: postTop + 600,
            height: 600,
          } as DOMRect;
        return { top: 0, bottom: 0, height: 0 } as DOMRect;
      },
    );
    click(container.querySelector("[data-write]")!);
    const scroll = () =>
      act(() => {
        document.dispatchEvent(new Event("scroll"));
        frames.flush();
      });
    // Shown above the bar where it opened.
    scroll();
    expect(form.dataset.open).toBe("true");
    // The keyboard comes up: the bar now covers the post, and the nudge (or
    // any scroll the reader did not make) moves the feed.
    barTop = 250;
    scroll();
    expect(form.dataset.open).toBe("true");
    postTop = 300;
    scroll();
    expect(form.dataset.open).toBe("true");
    // The nudge brings it above the bar.
    postTop = 120;
    scroll();
    expect(form.dataset.open).toBe("true");
    // Scrolled behind the bar where the bar is now: it has left.
    postTop = 260;
    scroll();
    expect(form.dataset.open).toBe("false");
  });

  it("counts only an intersection with area as shown", () => {
    expect(colophonPostVisible({ isIntersecting: false })).toBe(false);
    expect(colophonPostVisible({ isIntersecting: true })).toBe(true);
    expect(
      colophonPostVisible({
        isIntersecting: true,
        intersectionRect: { width: 0, height: 400 } as DOMRectReadOnly,
      }),
    ).toBe(false);
    expect(
      colophonPostVisible({
        isIntersecting: true,
        intersectionRect: { width: 40, height: 400 } as DOMRectReadOnly,
      }),
    ).toBe(true);
  });
});
