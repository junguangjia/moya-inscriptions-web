// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CommentItem,
  CommentReply,
  CommentUserPresentation,
} from "../comments/comment-types";
import type { DiscussionThread } from "./use-discussion-thread";

const h = vi.hoisted(() => ({
  thread: null as unknown as DiscussionThread,
  options: [] as Array<Record<string, unknown>>,
  stage: null as Record<string, unknown> | null,
  composer: null as unknown as Record<string, unknown>,
  composerProps: [] as Array<Record<string, unknown>>,
  composerOptions: null as Record<string, unknown> | null,
  enterAuth: vi.fn(),
  openProfile: vi.fn(),
  authors: { viewer: { id: "reader", displayName: "读者" } as unknown },
  entryRenders: 0,
}));
vi.mock("./feed-colophon-entry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./feed-colophon-entry")>();
  return {
    ...actual,
    ColophonEntry: (props: Parameters<typeof actual.ColophonEntry>[0]) => {
      h.entryRenders += 1;
      return <actual.ColophonEntry {...props} />;
    },
  };
});
vi.mock("./use-discussion-thread", () => ({
  useDiscussionThread: (options: Record<string, unknown>) => {
    h.options.push(options);
    return h.thread;
  },
}));
vi.mock("./feed-post-stage-context", () => ({
  useFeedStage: () => h.stage,
}));
vi.mock("./feed-colophon-composer", () => ({
  colophonComposerScene: (shell: Record<string, unknown>) =>
    `scene:${String(shell.activeDestination)}`,
  FeedColophonComposer: (props: Record<string, unknown>) => {
    h.composerProps.push(props);
    return <form data-colophon-composer="" data-open={String(props.open)} />;
  },
  useColophonComposer: (_key: string, options: Record<string, unknown>) => {
    h.composerOptions = options;
    return h.composer;
  },
}));
vi.mock("./author-context", () => ({
  useAuthors: () => h.authors,
  contentKey: (target: { type: string; id: string }) =>
    `${target.type}:${target.id}`,
}));
vi.mock("../auth/auth-return", () => ({
  useAuthEntry: () => h.enterAuth,
}));
vi.mock("../product-shell/product-shell", () => ({
  useProductShell: () => ({
    openProfile: h.openProfile,
    activeDestination: "home",
  }),
}));
import { FeedColophon, FeedColophonOutletContext } from "./feed-colophon";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

class FakeObserver {
  static instances: FakeObserver[] = [];
  readonly targets: Element[] = [];
  disconnected = false;
  constructor(
    readonly callback: IntersectionObserverCallback,
    readonly options: IntersectionObserverInit = {},
  ) {
    FakeObserver.instances.push(this);
  }
  observe(target: Element) {
    this.targets.push(target);
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
  takeRecords() {
    return [];
  }
}

/** Reports `target` intersecting to every live observer watching it. */
const intersect = (target: Element | null, isIntersecting = true) =>
  act(() => {
    for (const observer of FakeObserver.instances.filter(
      (o) => !o.disconnected && target !== null && o.targets.includes(target),
    ))
      observer.callback(
        [{ isIntersecting, target } as unknown as IntersectionObserverEntry],
        observer as unknown as IntersectionObserver,
      );
  });

const user = (id: string, name: string): CommentUserPresentation => ({
  id,
  name,
  avatarSrc: null,
});
const reply = (
  id: string,
  author: CommentUserPresentation,
  extra: Partial<CommentReply> = {},
): CommentReply => ({
  id,
  text: `${id} 的回复`,
  user: author,
  createdAtLabel: "",
  createdAt: "2026-10-09T11:57:00.000Z",
  likeCount: 0,
  liked: false,
  ...extra,
});
const comment = (
  id: string,
  author: CommentUserPresentation,
  extra: Partial<CommentItem> = {},
): CommentItem => ({
  id,
  text: `${id} 的题跋`,
  user: author,
  createdAtLabel: "",
  createdAt: "2026-10-09T11:57:00.000Z",
  isQaGenerated: false,
  likeCount: 2,
  liked: false,
  replies: [],
  replyTotal: 0,
  replyPageTotal: 0,
  ...extra,
});

const makeThread = (
  overrides: Partial<DiscussionThread> = {},
): DiscussionThread => ({
  hot: [],
  items: [],
  currentUser: user("reader", "读者"),
  visibleTotal: 0,
  page: 1,
  totalPages: 1,
  hasMore: false,
  loading: false,
  busy: false,
  submitting: false,
  unavailable: false,
  error: null,
  readError: null,
  actionError: null,
  notice: "",
  viewerState: { state: "signed-in" },
  composerClosed: false,
  closedNote: null,
  locatedPage: null,
  highlightId: undefined,
  repliesLoading: new Set(),
  lastSubmit: null,
  loadMore: vi.fn(),
  retry: vi.fn(),
  returnToLatest: vi.fn(),
  browseHighlightFromFirstReply: vi.fn(),
  loadReplies: vi.fn(),
  sendComment: vi.fn(async () => true),
  sendReply: vi.fn(async () => true),
  toggleLike: vi.fn(),
  deleteBody: vi.fn(),
  setHighlight: vi.fn(),
  ...overrides,
});

const target = { type: "work", id: "w1" } as const;
const writer = user("writer", "甲");
const other = user("other", "乙");
let host: HTMLDivElement;
let outlet: HTMLDivElement;
let strip: HTMLDivElement;
let root: Root;

const render = (withOutlet = true) =>
  act(() => {
    root.render(
      <FeedColophonOutletContext.Provider value={withOutlet ? outlet : null}>
        <FeedColophon fallbackCount={7} target={target} title="寒山诗" />
      </FeedColophonOutletContext.Provider>,
    );
  });
const $ = <T extends Element = HTMLElement>(selector: string) =>
  host.querySelector<T>(selector);
const $$ = (selector: string) => [
  ...host.querySelectorAll<HTMLElement>(selector),
];
const click = (node: Element | null) =>
  act(() => {
    node?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  });

beforeEach(() => {
  FakeObserver.instances = [];
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  h.options = [];
  h.composerProps = [];
  h.enterAuth.mockReset();
  h.openProfile.mockReset();
  h.authors = { viewer: { id: "reader", displayName: "读者" } };
  strip = document.createElement("div");
  h.stage = {
    strip,
    count: 2,
    region: "media",
    readOffset: () => 0,
    scrollToOffset: vi.fn(),
    scrollToElement: vi.fn(),
    setCommentsAnchor: vi.fn(),
    subscribeSettle: vi.fn(() => () => undefined),
    isSettled: () => true,
  };
  h.composer = {
    open: false,
    replyTarget: null,
    textareaRef: { current: null },
    openComposer: vi.fn(),
    close: vi.fn(),
    setReplyTarget: vi.fn(),
  };
  h.thread = makeThread();
  host = document.createElement("div");
  outlet = document.createElement("div");
  document.body.append(host, outlet);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  outlet.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("FeedColophon", () => {
  it("reads nothing until the reader nears the colophons, then reads once", () => {
    h.thread = makeThread({ page: 0, totalPages: 0, loading: true });
    render();
    expect(h.options.every((options) => options.enabled === false)).toBe(true);
    expect(h.options[0]).toMatchObject({
      target,
      mode: "colophon",
      authReturnSlot: "feed-colophon:work:w1",
      consumeLocation: false,
    });
    const head = $("[data-colophon-head]");
    const approach = FakeObserver.instances.find((o) =>
      o.targets.includes(head as Element),
    );
    expect(approach?.options.root).toBe(strip);
    // Several images: the read starts as the last one comes in.
    expect(approach?.options.rootMargin).toBe("0px 0px 0px 95%");
    intersect(head);
    expect(h.options.at(-1)?.enabled).toBe(true);
    // Leaving again never turns the read off.
    h.stage = { ...h.stage, region: "media" };
    render();
    expect(h.options.at(-1)?.enabled).toBe(true);
  });

  it("waits for half a swipe past a single image, which starts on its last", () => {
    h.stage = { ...h.stage, count: 1 };
    h.thread = makeThread({ page: 0, totalPages: 0, loading: true });
    render();
    const head = $("[data-colophon-head]");
    const approach = FakeObserver.instances.find((o) =>
      o.targets.includes(head as Element),
    );
    // The head starts flush with a single image: no read at mount.
    expect(approach?.options.rootMargin).toBe("0px 0px 0px -50%");
    expect(h.options.at(-1)?.enabled).toBe(false);
  });

  it("holds rows that arrive while the strip moves until it settles", () => {
    let settled = false;
    const listeners: ((settle: { resized: boolean }) => void)[] = [];
    h.stage = {
      ...h.stage,
      region: "comments",
      isSettled: () => settled,
      subscribeSettle: vi.fn((listener) => {
        listeners.push(listener);
        return () => undefined;
      }),
    };
    h.thread = makeThread({ page: 0, totalPages: 0, loading: true });
    render();
    expect($$("[data-colophon-skeleton]")).toHaveLength(3);
    // The first page lands mid-swipe: the strip keeps its width.
    h.thread = makeThread({ items: [comment("c1", writer)] });
    render();
    expect($$("[data-colophon-entry]")).toHaveLength(0);
    expect($$("[data-colophon-skeleton]")).toHaveLength(3);
    settled = true;
    act(() => listeners.forEach((listener) => listener({ resized: false })));
    expect($$("[data-colophon-entry]")).toHaveLength(1);
    expect($$("[data-colophon-skeleton]")).toHaveLength(0);
  });

  it("reads once the stage settles on the colophons", () => {
    h.thread = makeThread({ page: 0, totalPages: 0, loading: true });
    render();
    expect(h.options.at(-1)?.enabled).toBe(false);
    h.stage = { ...h.stage, region: "comments" };
    render();
    expect(h.options.at(-1)?.enabled).toBe(true);
  });

  it("orders head, hot, latest, sentinel and end, right to left", () => {
    h.thread = makeThread({
      hot: [comment("h1", writer)],
      items: [comment("i1", other)],
      visibleTotal: 12,
    });
    render();
    const section = $("[data-feed-colophon]");
    expect(section?.getAttribute("aria-label")).toBe("寒山诗的题跋");
    const order = [...(section?.children ?? [])].map(
      (node) =>
        [
          "data-colophon-head",
          "data-colophon-group",
          "data-colophon-list",
          "data-colophon-sentinel",
          "data-colophon-end",
        ]
          .map((name) =>
            node.hasAttribute(name) ? `${name}=${node.getAttribute(name)}` : "",
          )
          .join("") || node.tagName,
    );
    expect(order).toEqual([
      "data-colophon-head=",
      "data-colophon-group=hot",
      "data-colophon-list=hot",
      "data-colophon-group=latest",
      "data-colophon-list=latest",
      "data-colophon-sentinel=",
      "data-colophon-end=",
    ]);
    expect($("[data-colophon-group=hot]")?.textContent).toBe("热评");
    expect($("[data-colophon-group=latest]")?.textContent).toBe("最新");
    expect($("[data-colophon-count]")?.textContent).toBe("12则");
    expect($("[data-colophon-end]")?.textContent).toContain("题跋至此");
    // No way out to Detail from the colophons.
    expect(section?.textContent).not.toMatch(/查看评论|查看全部/);
  });

  it("shows the feed's count before the read and 尚无题跋 for none", () => {
    h.thread = makeThread({ page: 0, totalPages: 0, loading: true });
    render();
    expect($("[data-colophon-count]")?.textContent).toBe("7则");
    expect($$("[data-colophon-skeleton]")).toHaveLength(3);
    h.thread = makeThread({ page: 1, visibleTotal: 0 });
    render();
    expect($("[data-colophon-count]")?.textContent).toBe("尚无题跋");
    expect($$("[data-colophon-skeleton]")).toHaveLength(0);
  });

  it("signs each colophon with avatar, names and a short time", () => {
    h.thread = makeThread({
      items: [comment("c1", { ...writer, studioName: "听雨轩" })],
    });
    render();
    const signature = $("[data-colophon-signature=root]");
    expect(
      signature
        ?.querySelector("[data-studio-name]")
        ?.getAttribute("aria-label"),
    ).toBe("斋号：听雨轩");
    expect(signature?.querySelector("time")?.getAttribute("dateTime")).toBe(
      "2026-10-09T11:57:00.000Z",
    );
    const avatar = signature?.querySelector<HTMLButtonElement>(
      'button[aria-label="打开甲的主页"]',
    );
    expect(avatar?.textContent).toBe("甲");
    click(avatar ?? null);
    expect(h.openProfile).toHaveBeenCalledWith("writer", avatar);
    expect($("[data-colophon-text]")?.getAttribute("aria-describedby")).toBe(
      signature?.id,
    );
  });

  it("folds a colophon past 200 characters even where it would fit, and 全文 expands it", () => {
    const long = "永".repeat(250);
    h.thread = makeThread({
      items: [
        comment("c1", writer, { text: long }),
        comment("c2", writer, { text: "和".repeat(200) }),
        comment("c3", writer, { text: "风".repeat(201) }),
      ],
    });
    render();
    const [first, second, third] = $$("[data-colophon-text]");
    expect(first?.textContent).toBe(`${"永".repeat(200)}…`);
    expect(first?.dataset.folded).toBe("true");
    // Exactly 200 is shown whole where it fits; one more always folds.
    expect(second?.textContent).toBe("和".repeat(200));
    expect(third?.dataset.folded).toBe("true");
    expect($$("[data-colophon-fold]")).toHaveLength(2);
    const fold = $("[data-colophon-fold]");
    expect(fold?.textContent).toBe("全文");
    expect(fold?.getAttribute("aria-expanded")).toBe("false");
    click(fold);
    expect($("[data-colophon-text]")?.textContent).toBe(long);
    expect(fold?.textContent).toBe("收起");
    expect(fold?.getAttribute("aria-expanded")).toBe("true");
  });

  it("folds a shorter colophon whose text does not fit one view with its signature", () => {
    // jsdom lays nothing out: the text's overflow is stubbed per row.
    const widths = vi
      .spyOn(HTMLElement.prototype, "scrollWidth", "get")
      .mockImplementation(function (this: HTMLElement) {
        return this.dataset.colophonText !== undefined &&
          (this.textContent ?? "").includes("长")
          ? 480
          : 0;
      });
    try {
      h.thread = makeThread({
        items: [
          comment("c1", writer, { text: "长".repeat(150) }),
          comment("c2", writer, { text: "短".repeat(150) }),
          comment("c3", writer, {
            replies: [reply("r1", writer, { text: "长".repeat(80) })],
          }),
        ],
      });
      render();
      const [long, short, , replyText] = $$("[data-colophon-text]");
      // Whole, but cut by the view: folded with a fade and 全文.
      expect(long?.textContent).toBe("长".repeat(150));
      expect(long?.dataset.folded).toBe("true");
      expect(long?.dataset.overflow).toBe("true");
      expect(short?.dataset.folded).toBeUndefined();
      expect(short?.dataset.overflow).toBeUndefined();
      // A reply that overflows its view folds by the same rule.
      expect(replyText?.dataset.folded).toBe("true");
      expect($$("[data-colophon-fold]")).toHaveLength(2);
      const fold = $("[data-colophon-fold]");
      expect(fold?.textContent).toBe("全文");
      expect(long?.parentElement?.dataset.expanded).toBeUndefined();
      click(fold);
      // Unclamped, it still offers 收起.
      expect(long?.parentElement?.dataset.expanded).toBe("true");
      expect(long?.dataset.overflow).toBeUndefined();
      expect(long?.dataset.folded).toBe("false");
      expect(fold?.textContent).toBe("收起");
      click(fold);
      expect(long?.dataset.overflow).toBe("true");
      expect(fold?.textContent).toBe("全文");
    } finally {
      widths.mockRestore();
    }
  });

  it("annotates replies with 回复 X： and loads the rest from 余 N 则回复", () => {
    h.thread = makeThread({
      items: [
        comment("c1", writer, {
          replies: [
            reply("r1", other),
            reply("r2", writer, { replyToUser: other }),
          ],
          replyTotal: 6,
          replyPageTotal: 6,
        }),
      ],
      repliesLoading: new Set(["c1"]),
    });
    render();
    expect(
      $$("[data-colophon-reply-lead]").map((lead) => lead.textContent),
    ).toEqual(["回复 甲：", "回复 乙："]);
    expect(
      $$("[data-comment-reply]").map((node) => node.dataset.colophonAnchor),
    ).toEqual(["r1", "r2"]);
    const more = $("[data-colophon-more-replies]");
    expect(more?.textContent).toBe("余4则回复");
    expect(more?.getAttribute("aria-busy")).toBe("true");
    click(more);
    expect(h.thread.loadReplies).toHaveBeenCalledWith("c1");
  });

  it("selecting a colophon reveals its actions; 删除 only on one's own", () => {
    h.thread = makeThread({
      currentUser: user("writer", "甲"),
      items: [comment("own", writer), comment("theirs", other)],
    });
    render();
    const [own, theirs] = $$("[data-colophon-text]");
    expect($("[data-colophon-actions]")).toBeNull();
    click(own ?? null);
    expect(own?.getAttribute("aria-pressed")).toBe("true");
    const toolbar = $("[data-colophon-actions]");
    expect(toolbar?.getAttribute("role")).toBe("toolbar");
    expect(toolbar?.getAttribute("aria-orientation")).toBe("vertical");
    expect($("[data-colophon-delete]")).not.toBeNull();
    expect($("[data-colophon-like]")?.getAttribute("aria-label")).toBe("赞，2");
    click(theirs ?? null);
    expect($$("[data-colophon-actions]")).toHaveLength(1);
    expect($("[data-colophon-delete]")).toBeNull();
    // Tapping the selected text again clears it.
    click(theirs ?? null);
    expect($("[data-colophon-actions]")).toBeNull();
  });

  it("moves through the action column with the arrow keys and leaves with Escape", () => {
    h.thread = makeThread({
      currentUser: user("writer", "甲"),
      items: [comment("own", writer)],
    });
    render();
    const text = $("[data-colophon-text]");
    act(() => {
      text?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    const buttons = $$("[data-colophon-actions] button");
    expect(buttons.map((button) => button.tabIndex)).toEqual([0, -1, -1]);
    act(() => buttons[0]?.focus());
    act(() => {
      buttons[0]?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(buttons[1]);
    act(() => {
      buttons[1]?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect($("[data-colophon-actions]")).toBeNull();
    expect(document.activeElement).toBe(text);
  });

  it("deletes only after confirmation", () => {
    h.thread = makeThread({
      currentUser: user("writer", "甲"),
      items: [comment("own", writer)],
    });
    render();
    click($("[data-colophon-text]"));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    click($("[data-colophon-delete]"));
    expect(confirm).toHaveBeenCalledWith("删除正文？其他人的回复将保留。");
    expect(h.thread.deleteBody).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    click($("[data-colophon-delete]"));
    expect(h.thread.deleteBody).toHaveBeenCalledWith("own");
    expect($("[data-colophon-actions]")).toBeNull();
    // Focus stays with the colophon, not on the page.
    expect(document.activeElement).toBe($("[data-colophon-text]"));
  });

  it("likes through the thread with the button as opener", () => {
    h.thread = makeThread({
      items: [comment("c1", writer, { replies: [reply("r1", other)] })],
    });
    render();
    click($('[data-comment-reply="r1"] [data-colophon-text]'));
    const like = $("[data-colophon-like]");
    click(like);
    expect(h.thread.toggleLike).toHaveBeenCalledWith("c1", "r1", like);
    // The like stays selectable: the count changes in place.
    expect($("[data-colophon-actions]")).not.toBeNull();
  });

  it("sends a guest to sign in from the head, 回复 and 赞, returning focus to the opener", () => {
    h.authors = { viewer: null };
    h.thread = makeThread({
      currentUser: { id: "guest", name: "访客" },
      viewerState: { state: "signed-out", signInHref: "/login?x=1" },
      items: [comment("c1", writer)],
    });
    render();
    const signIn = $<HTMLAnchorElement>("[data-colophon-sign-in]");
    expect(signIn?.textContent).toBe("登录后题跋");
    expect(signIn?.getAttribute("href")).toBe("/login?x=1");
    expect($("[data-colophon-write]")).toBeNull();
    click($("[data-colophon-text]"));
    const replyButton = $("[data-colophon-reply]");
    click(replyButton);
    expect(h.enterAuth).toHaveBeenCalledWith("/login?x=1", replyButton);
    expect(h.composer.openComposer).not.toHaveBeenCalled();
    const like = $("[data-colophon-like]");
    click(like);
    expect(h.thread.toggleLike).toHaveBeenCalledWith("c1", undefined, like);
    // A guest never gets a composer.
    expect(outlet.querySelector("[data-colophon-composer]")).toBeNull();
  });

  it("opens the composer from 写题跋 and 回复, sending through the thread", async () => {
    h.thread = makeThread({ items: [comment("c1", writer)] });
    render();
    const write = $("[data-colophon-write]");
    click(write);
    expect(h.composer.openComposer).toHaveBeenCalledWith(null, write);
    const text = $("[data-colophon-text]");
    click(text);
    click($("[data-colophon-reply]"));
    // Focus returns to the text replied to: the toolbar is gone by then.
    expect(h.composer.openComposer).toHaveBeenLastCalledWith(
      { rootCommentId: "c1", user: writer },
      text,
    );
    expect($("[data-colophon-actions]")).toBeNull();
    expect(outlet.querySelector("[data-colophon-composer]")).not.toBeNull();
    const props = h.composerProps.at(-1) as {
      contentKey: string;
      actorId: string | null;
      onSubmit: (t: string, m: [], target: unknown) => Promise<boolean>;
      onCancel: unknown;
    };
    expect(props.contentKey).toBe("work:w1");
    expect(props.actorId).toBe("reader");
    expect(props.onCancel).toBe(h.composer.close);
    await props.onSubmit("新题", [], null);
    expect(h.thread.sendComment).toHaveBeenCalledWith("新题", []);
    const replyTarget = { rootCommentId: "c1", user: writer };
    await props.onSubmit("答", [], replyTarget);
    expect(h.thread.sendReply).toHaveBeenCalledWith(replyTarget, "答", []);
  });

  it("asks for the next page once per page as the end comes near", () => {
    h.thread = makeThread({
      items: [comment("c1", writer)],
      page: 1,
      totalPages: 3,
      hasMore: true,
    });
    render();
    const sentinel = $("[data-colophon-sentinel]");
    const end = FakeObserver.instances.find(
      (o) => !o.disconnected && o.targets.includes(sentinel as Element),
    );
    expect(end?.options).toMatchObject({
      root: strip,
      rootMargin: "0px 100% 0px 100%",
    });
    intersect(sentinel);
    intersect(sentinel);
    expect(h.thread.loadMore).toHaveBeenCalledTimes(1);
    const loadMore = h.thread.loadMore;
    h.thread = makeThread({
      items: [comment("c1", writer), comment("c2", writer)],
      page: 2,
      totalPages: 3,
      hasMore: true,
      loadMore,
    });
    render();
    intersect(sentinel);
    expect(loadMore).toHaveBeenCalledTimes(2);
    // Nothing more past the last page, and no load-more button at all.
    h.thread = makeThread({
      items: [comment("c1", writer)],
      page: 3,
      totalPages: 3,
      loadMore,
    });
    render();
    intersect(sentinel);
    expect(loadMore).toHaveBeenCalledTimes(2);
    expect(host.textContent).not.toMatch(/加载更多|查看更多/);
  });

  it("asks again after a read that left the page where it was", () => {
    const loadMore = vi.fn();
    const at = (busy: boolean) =>
      makeThread({
        items: [comment("c1", writer)],
        page: 2,
        totalPages: 3,
        hasMore: true,
        busy,
        loadMore,
      });
    h.thread = at(false);
    render();
    const sentinel = $("[data-colophon-sentinel]");
    intersect(sentinel);
    expect(loadMore).toHaveBeenCalledTimes(1);
    // A refresh replaced that read and committed at the same depth.
    h.thread = at(true);
    render();
    h.thread = at(false);
    render();
    intersect(sentinel);
    expect(loadMore).toHaveBeenCalledTimes(2);
  });

  it("keeps the composer open while the post is on screen and its status above it", () => {
    const article = document.createElement("article");
    article.append(outlet);
    document.body.append(article);
    h.thread = makeThread({ items: [comment("c1", writer)] });
    render();
    expect(h.composerOptions?.observe).toBe(article);
    // It also closes when the shell's destination or layers change.
    expect(h.composerOptions?.scene).toBe("scene:home");
    const fallback = h.composerOptions?.fallbackFocus as () => unknown;
    expect(fallback()).toBe($("[data-colophon-write]"));

    const form = document.createElement("form");
    const box = document.createElement("textarea");
    form.append(box);
    h.composer = { ...h.composer, open: true, textareaRef: { current: box } };
    render();
    const notice = outlet.querySelector<HTMLElement>("[data-colophon-notice]");
    expect(
      notice?.style.getPropertyValue("--colophon-composer-block-size"),
    ).toBe("0px");
    h.composer = { ...h.composer, open: false };
    render();
    expect(
      notice?.style.getPropertyValue("--colophon-composer-block-size"),
    ).toBe("");
    article.remove();
  });

  it("shows 正在展开… while a page loads and a retry after a read error", () => {
    h.thread = makeThread({
      items: [comment("c1", writer)],
      hasMore: true,
      totalPages: 2,
      busy: true,
    });
    render();
    expect($("[data-colophon-end]")?.textContent).toBe("正在展开…");
    h.thread = makeThread({
      page: 0,
      totalPages: 0,
      readError: "内容不可用或此列表未公开",
    });
    render();
    expect($("[data-colophon-read-error]")?.textContent).toBe(
      "内容不可用或此列表未公开",
    );
    click($("[data-colophon-retry]"));
    expect(h.thread.retry).toHaveBeenCalledTimes(1);
  });

  it("marks a published colophon after it is brought in, for 1.8 s", () => {
    vi.useFakeTimers();
    h.thread = makeThread({
      items: [comment("c1", writer), comment("c2", writer)],
    });
    render();
    const setHighlight = vi.fn();
    h.thread = makeThread({
      items: [comment("c1", writer), comment("c2", writer)],
      highlightId: "c2",
      lastSubmit: { id: "c2", rootId: "c2", awaitingApproval: false },
      setHighlight,
    });
    render();
    const entry = $('[data-comment-id="c2"]');
    expect(entry?.dataset.colophonHighlight).toBe("true");
    expect(h.stage?.scrollToElement).toHaveBeenCalledWith(entry);
    expect(setHighlight).toHaveBeenCalledWith(undefined);
    act(() => vi.advanceTimersByTime(1799));
    expect(entry?.dataset.colophonHighlight).toBe("true");
    act(() => vi.advanceTimersByTime(1));
    expect(entry?.hasAttribute("data-colophon-highlight")).toBe(false);
  });

  it("brings the first colophon of a group in with the group's label", () => {
    h.thread = makeThread({
      hot: [comment("h1", other)],
      items: [comment("c1", writer), comment("c2", writer)],
      highlightId: "c1",
      lastSubmit: { id: "c1", rootId: "c1", awaitingApproval: false },
    });
    render();
    expect(h.stage?.scrollToElement).toHaveBeenCalledWith(
      $('[data-colophon-group="latest"]'),
    );
    expect($('[data-comment-id="c1"]')?.dataset.colophonHighlight).toBe("true");
  });

  it("drops a mark whose colophon is not shown, without moving the strip", () => {
    h.thread = makeThread({
      items: [comment("c1", writer)],
      highlightId: "gone",
      lastSubmit: { id: "gone", rootId: "gone", awaitingApproval: false },
    });
    render();
    expect(h.thread.setHighlight).toHaveBeenCalledWith(undefined);
    expect(h.stage?.scrollToElement).not.toHaveBeenCalled();
  });

  it("reads a sent reply's last page when it is past the preview", () => {
    h.thread = makeThread({
      items: [
        comment("c1", writer, {
          replies: [reply("r1", other)],
          replyTotal: 12,
          replyPageTotal: 12,
        }),
      ],
      highlightId: "r12",
      lastSubmit: { id: "r12", rootId: "c1", awaitingApproval: false },
    });
    render();
    expect(h.thread.loadReplies).toHaveBeenCalledWith("c1", 2);
  });

  it("says 已发送 for a few seconds whether published or awaiting approval", () => {
    vi.useFakeTimers();
    render();
    const notice = outlet.querySelector("[data-colophon-notice]");
    expect(notice?.getAttribute("role")).toBe("status");
    expect(notice?.textContent).toBe("");
    h.thread = makeThread({
      notice: "已发送",
      lastSubmit: { id: "p1", rootId: "p1", awaitingApproval: true },
    });
    render();
    expect(notice?.textContent).toBe("已发送");
    // Awaiting approval: nothing inserted, nothing marked.
    expect($("[data-colophon-highlight]")).toBeNull();
    act(() => vi.advanceTimersByTime(4000));
    expect(notice?.textContent).toBe("");
    h.thread = makeThread({
      notice: "已发送",
      lastSubmit: { id: "p2", rootId: "p2", awaitingApproval: false },
    });
    render();
    expect(notice?.textContent).toBe("已发送");
    h.thread = makeThread({
      notice: "已发送",
      lastSubmit: h.thread.lastSubmit,
      actionError: { id: "c1", message: "操作未完成" },
    });
    render();
    expect(notice?.textContent).toBe("操作未完成");
  });

  it("keeps the notice inside the colophons without an outlet", () => {
    render(false);
    expect($("[data-colophon-notice]")).not.toBeNull();
  });

  it("closed: a truthful note, no write entry, no reply, no review wording", () => {
    h.thread = makeThread({
      composerClosed: true,
      closedNote: "此作品当前仅你可见，暂时无法发表评论。",
      viewerState: { state: "checking" },
      currentUser: user("writer", "甲"),
      items: [comment("c1", other)],
      notice: "",
    });
    render();
    expect($("[data-colophon-closed]")?.textContent).toBe(
      "此作品当前仅你可见，暂时无法发表评论。",
    );
    expect($("[data-colophon-write]")).toBeNull();
    expect($("[data-colophon-sign-in]")).toBeNull();
    click($("[data-colophon-text]"));
    expect($("[data-colophon-reply]")).toBeNull();
    expect(host.textContent).not.toMatch(/审核|待发布|等待/);
    expect(outlet.textContent).not.toMatch(/审核|待发布|等待/);
  });

  it("says when the discussion is not open here", () => {
    h.thread = makeThread({ page: 0, totalPages: 0, unavailable: true });
    render();
    expect($("[data-colophon-unavailable]")?.textContent).toBe(
      "此处暂不开放题跋",
    );
    expect($("[data-colophon-write]")).toBeNull();
  });

  it("registers its reading anchor with the stage and listens for settles", () => {
    render();
    expect(h.stage?.setCommentsAnchor).toHaveBeenCalledWith(
      expect.any(Function),
    );
    expect(h.stage?.subscribeSettle).toHaveBeenCalledWith(expect.any(Function));
    act(() => root.unmount());
    expect(h.stage?.setCommentsAnchor).toHaveBeenLastCalledWith(null);
    root = createRoot(host);
  });

  it("keeps the reading position a resize re-pin restored", () => {
    const listeners: ((settle: { resized: boolean }) => void)[] = [];
    h.stage = {
      ...h.stage,
      region: "comments",
      readOffset: () => 1000,
      subscribeSettle: vi.fn((listener) => {
        listeners.push(listener);
        return () => undefined;
      }),
    };
    h.thread = makeThread({
      items: [comment("c1", writer), comment("c2", writer)],
    });
    render();
    const box = (left: number, right: number) =>
      ({ left, right, top: 0, bottom: 0, width: right - left }) as DOMRect;
    const place = (node: Element | null, left: number, right: number) => {
      if (node !== null) node.getBoundingClientRect = () => box(left, right);
    };
    place(strip, 0, 390);
    const [first, second] = $$("[data-colophon-entry]");
    // c1 is the right-most in view, 20px from the right edge.
    place(first ?? null, 200, 370);
    place(second ?? null, -400, -10);
    act(() => listeners.forEach((listener) => listener({ resized: false })));
    const register = h.stage.setCommentsAnchor as ReturnType<typeof vi.fn>;
    const getter = register.mock.calls.at(-1)?.[0] as () => number | null;
    // Clamped at the strip's end after a resize, c2 shows instead.
    place(first ?? null, 500, 670);
    place(second ?? null, 100, 370);
    act(() => listeners.forEach((listener) => listener({ resized: true })));
    // Still c1, 20px from the right edge: 300px further back.
    expect(getter()).toBe(1000 - 300);
    act(() => listeners.forEach((listener) => listener({ resized: false })));
    expect(getter()).toBe(1000);
  });

  it("brings a collapsed colophon's start back into view", () => {
    h.stage = { ...h.stage, region: "comments" };
    h.thread = makeThread({
      items: [comment("c1", writer, { text: "永".repeat(250) })],
    });
    render();
    const fold = $("[data-colophon-fold]");
    click(fold);
    expect(h.stage.scrollToElement).not.toHaveBeenCalled();
    strip.getBoundingClientRect = () => ({ left: 0, right: 390 }) as DOMRect;
    const entry = $('[data-comment-id="c1"]');
    // Read to its far end: its start is well right of the view.
    if (entry !== null)
      entry.getBoundingClientRect = () =>
        ({ left: -100, right: 860 }) as DOMRect;
    click(fold);
    expect(h.stage.scrollToElement).toHaveBeenCalledWith(entry, "instant");
  });

  it("copies the selected text with its own digits", () => {
    h.thread = makeThread({
      items: [comment("c1", writer, { text: "临了10遍" })],
    });
    render();
    const text = $("[data-colophon-text]");
    expect(text?.querySelector("span")?.textContent).toBe("10");
    const range = document.createRange();
    range.selectNodeContents(text!);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const setData = vi.fn();
    const event = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { setData } });
    act(() => {
      text?.dispatchEvent(event);
    });
    expect(setData).toHaveBeenCalledWith("text/plain", "临了10遍");
    expect(event.defaultPrevented).toBe(true);
    selection.removeAllRanges();
  });

  it("clears the selection when the stage returns to the images", () => {
    h.stage = { ...h.stage, region: "comments" };
    h.thread = makeThread({ items: [comment("c1", writer)] });
    render();
    click($("[data-colophon-text]"));
    expect($("[data-colophon-actions]")).not.toBeNull();
    h.stage = { ...h.stage, region: "media" };
    render();
    expect($("[data-colophon-actions]")).toBeNull();
  });
});

describe("FeedColophon writing", () => {
  const reader = { ...user("reader", "读者"), avatarSrc: "/a/reader.png" };
  let form: HTMLFormElement;
  let box: HTMLTextAreaElement;
  beforeEach(() => {
    h.entryRenders = 0;
    form = document.createElement("form");
    box = document.createElement("textarea");
    form.append(box);
    outlet.append(form);
    h.thread = makeThread({ currentUser: reader });
  });
  const composerProps = () =>
    h.composerProps.at(-1) as {
      onDraftChange: (draft: string) => void;
      formId: string;
    };
  const typeDraft = (draft: string) =>
    act(() => composerProps().onDraftChange(draft));
  const setOpen = (
    open: boolean,
    replyTarget: Record<string, unknown> | null = null,
  ) => {
    h.composer = {
      ...h.composer,
      open,
      replyTarget,
      textareaRef: { current: box },
    };
    render();
  };
  const slip = () => $("[data-colophon-head] [data-colophon-invite]");

  it("invites the reader to write in the head, with their own avatar", () => {
    h.thread = makeThread({
      currentUser: reader,
      items: [comment("c1", writer)],
      visibleTotal: 1,
    });
    render();
    const write = $("[data-colophon-head] [data-colophon-write]");
    expect(write).toBe(slip());
    expect(write?.dataset.colophonInvite).toBe("signed-in");
    // Named by its visible prompt (the pen and the avatar are hidden).
    expect(write?.hasAttribute("aria-label")).toBe(false);
    expect(write?.getAttribute("aria-expanded")).toBe("false");
    expect(write?.getAttribute("aria-controls")).toBe(composerProps().formId);
    expect(write?.textContent).toContain("在此写题跋");
    expect(write?.querySelector("img")?.getAttribute("src")).toBe(
      "/a/reader.png",
    );
    // The head reads 题跋, the count, then the slip.
    expect([...($("[data-colophon-head]")?.children ?? [])].at(-1)).toBe(write);
  });

  it("asks for the first colophon of an empty thread and to go on with a kept draft", () => {
    h.thread = makeThread({ currentUser: reader, visibleTotal: 0 });
    render();
    expect(slip()?.textContent).toContain("写第一则题跋");
    typeDraft("x");
    expect(slip()?.textContent).toContain("续写题跋");
    typeDraft("");
    expect(slip()?.textContent).toContain("写第一则题跋");
  });

  it("holds the slip's place while the session is confirmed, and says when it cannot be", () => {
    render();
    const signedIn = slip();
    h.thread = makeThread({ viewerState: { state: "checking" } });
    render();
    const checking = slip();
    expect(checking?.dataset.colophonInvite).toBe("checking");
    expect(checking?.tagName).toBe("SPAN");
    expect(checking?.className).toBe(signedIn?.className);
    expect(checking?.getAttribute("aria-hidden")).toBe("true");
    expect(checking?.textContent).toBe("");
    h.thread = makeThread({ viewerState: { state: "unavailable" } });
    render();
    expect(slip()?.dataset.colophonInvite).toBe("unavailable");
    expect(slip()?.textContent).toBe("暂时无法确认登录状态");
    expect(slip()?.className).toBe(signedIn?.className);
  });

  it("turns the slip itself into the draft sheet and previews the typing alone", () => {
    h.thread = makeThread({
      currentUser: reader,
      items: [comment("c1", writer), comment("c2", other)],
      visibleTotal: 2,
    });
    render();
    const write = $("[data-colophon-head] [data-colophon-write]");
    click(write);
    expect(h.composer.openComposer).toHaveBeenCalledWith(null, write);
    setOpen(true);
    const head = $("[data-colophon-head]");
    expect(head?.hasAttribute("data-colophon-drafting")).toBe(true);
    expect($("[data-colophon-head] [data-colophon-write]")).toBe(write);
    expect(write?.getAttribute("aria-expanded")).toBe("true");
    // The sheet's ink is hidden: the button keeps a name of its own.
    expect(write?.getAttribute("aria-label")).toBe("写题跋");
    const sheet = write?.querySelector<HTMLElement>(
      '[data-colophon-draft="head"]',
    );
    expect(sheet).not.toBeNull();
    expect(
      sheet?.querySelector("[data-colophon-draft-status]")?.textContent,
    ).toBe("草稿");
    const renders = h.entryRenders;
    typeDraft("寒山 10月");
    expect(sheet?.textContent).toContain("寒山 10月");
    for (let index = 0; index < 20; index += 1) typeDraft(`寒山${index}`);
    expect(h.entryRenders).toBe(renders);
    // A tap on the sheet brings the keyboard back.
    click(sheet ?? null);
    expect(h.composer.openComposer).toHaveBeenLastCalledWith(null, write);
    // The preview is no colophon: the rows stay two.
    expect($$("[data-colophon-entry]")).toHaveLength(2);
    setOpen(false);
    expect(head?.hasAttribute("data-colophon-drafting")).toBe(false);
    expect($("[data-colophon-draft]")).toBeNull();
    expect(slip()?.textContent).toContain("续写题跋");
  });

  it("writes in the end column when opened there, and in the head otherwise", () => {
    h.thread = makeThread({
      currentUser: reader,
      items: [comment("c1", writer)],
      visibleTotal: 1,
    });
    render();
    const pill = $("[data-colophon-end] [data-colophon-write]");
    expect(pill?.textContent).toBe("写题跋");
    click(pill);
    setOpen(true);
    expect(
      $("[data-colophon-end]")?.hasAttribute("data-colophon-drafting"),
    ).toBe(true);
    expect(pill?.querySelector('[data-colophon-draft="end"]')).not.toBeNull();
    expect($("[data-colophon-head] [data-colophon-draft]")).toBeNull();
    // More to read: the end column is no longer the end, the head takes it.
    h.thread = makeThread({
      currentUser: reader,
      items: [comment("c1", writer)],
      visibleTotal: 3,
      totalPages: 2,
      hasMore: true,
    });
    render();
    expect(
      $('[data-colophon-head] [data-colophon-draft="head"]'),
    ).not.toBeNull();
    expect($("[data-colophon-end] [data-colophon-draft]")).toBeNull();
  });

  it("drafts a reply as its colophon's last annotation, only in the list it came from", () => {
    const root = comment("c1", writer, {
      replies: [reply("r1", other)],
      replyTotal: 4,
      replyPageTotal: 4,
    });
    h.thread = makeThread({
      currentUser: reader,
      hot: [root],
      items: [root],
      visibleTotal: 4,
    });
    render();
    const latest = $('[data-colophon-list="latest"]');
    const text = latest?.querySelector("[data-colophon-text]") ?? null;
    click(text);
    click(latest?.querySelector("[data-colophon-reply]") ?? null);
    const target = { rootCommentId: "c1", user: writer };
    expect(h.composer.openComposer).toHaveBeenLastCalledWith(target, text);
    setOpen(true, target);
    const entry = latest?.querySelector('[data-comment-id="c1"]');
    const last = entry?.lastElementChild as HTMLElement | null;
    expect(last?.matches("[data-colophon-draft-replies]")).toBe(true);
    expect(last?.getAttribute("aria-hidden")).toBe("true");
    expect(
      last?.previousElementSibling?.matches("[data-colophon-more-replies]"),
    ).toBe(true);
    expect(last?.textContent).toContain("回复 甲：");
    expect($$("[data-colophon-draft]")).toHaveLength(1);
    expect($('[data-colophon-list="hot"] [data-colophon-draft]')).toBeNull();
    expect($("[data-colophon-head] [data-colophon-draft]")).toBeNull();
    typeDraft("同感");
    expect(last?.textContent).toContain("回复 甲：同感");
  });

  it("continues a kept reply from the slip, bringing its sheet back into view", () => {
    const root = comment("c1", writer);
    h.thread = makeThread({
      currentUser: reader,
      items: [comment("c0", other), root],
      visibleTotal: 2,
    });
    render();
    const target = { rootCommentId: "c1", user: writer };
    setOpen(true, target);
    typeDraft("同感");
    expect(slip()?.textContent).toContain("续写回复");
    const sheet = $('[data-colophon-draft="reply"]')!;
    vi.spyOn(strip, "getBoundingClientRect").mockReturnValue({
      left: 0,
      right: 300,
      width: 300,
    } as DOMRect);
    // The reader swiped back to the head: the reply is off to the left.
    vi.spyOn(sheet, "getBoundingClientRect").mockReturnValue({
      left: -500,
      right: -350,
    } as DOMRect);
    const scrollTo = h.stage?.scrollToElement as ReturnType<typeof vi.fn>;
    const scrolls = scrollTo.mock.calls.length;
    click($("[data-colophon-head] [data-colophon-write]"));
    expect(h.composer.openComposer).toHaveBeenLastCalledWith(
      null,
      $("[data-colophon-head] [data-colophon-write]"),
    );
    expect(scrollTo.mock.calls.length).toBe(scrolls + 1);
    expect(scrollTo.mock.calls.at(-1)?.[0]).toBe(sheet);
    // Closed (the post left the screen), the kept reply still reads so,
    // on the end pill as well.
    setOpen(false, target);
    expect(slip()?.textContent).toContain("续写回复");
    expect($("[data-colophon-end] [data-colophon-write]")?.textContent).toBe(
      "续写回复",
    );
    // 取消 drops the reply: the text would go on as a new colophon.
    setOpen(false, null);
    expect(slip()?.textContent).toContain("续写题跋");
  });

  it("never previews for a guest, a closed or unavailable thread, or a root not shown", () => {
    const open = (
      thread: Partial<DiscussionThread>,
      target = null as never,
    ) => {
      h.thread = makeThread({ items: [comment("c1", writer)], ...thread });
      setOpen(true, target);
      expect($("[data-colophon-draft]")).toBeNull();
    };
    open({ viewerState: { state: "signed-out", signInHref: "/login" } });
    open({
      composerClosed: true,
      closedNote: "暂时无法发表评论。",
      viewerState: { state: "checking" },
    });
    open({ unavailable: true, page: 0 });
    open({}, { rootCommentId: "gone", user: writer } as never);
    // The composer's own bar still names the reply's target.
  });

  it("removes the sheet in the commit that marks the published colophon", () => {
    h.thread = makeThread({
      currentUser: reader,
      items: [comment("c1", writer)],
      visibleTotal: 1,
    });
    render();
    setOpen(true);
    expect($('[data-colophon-draft="head"]')).not.toBeNull();
    const seen: Array<{ target: Element; sheet: boolean }> = [];
    h.stage = {
      ...h.stage,
      scrollToElement: vi.fn((target: Element) =>
        seen.push({ target, sheet: $("[data-colophon-draft]") !== null }),
      ),
    };
    h.thread = makeThread({
      currentUser: reader,
      items: [comment("n1", reader), comment("c1", writer)],
      visibleTotal: 2,
      highlightId: "n1",
      lastSubmit: { id: "n1", rootId: "n1", awaitingApproval: false },
      notice: "已发送",
    });
    render();
    expect($("[data-colophon-draft]")).toBeNull();
    expect(seen).toEqual([
      { target: $('[data-comment-id="n1"]'), sheet: false },
    ]);
    expect(
      $("[data-colophon-head]")?.hasAttribute("data-colophon-drafting"),
    ).toBe(false);
  });

  it("removes the sheet once awaiting approval, with nothing to bring in", () => {
    h.thread = makeThread({
      currentUser: reader,
      items: [comment("c1", writer)],
    });
    render();
    setOpen(true);
    h.thread = makeThread({
      currentUser: reader,
      items: [comment("c1", writer)],
      lastSubmit: { id: "p1", rootId: "p1", awaitingApproval: true },
      notice: "已发送",
    });
    render();
    expect($("[data-colophon-draft]")).toBeNull();
    expect(h.stage?.scrollToElement).not.toHaveBeenCalled();
    expect(outlet.textContent).toContain("已发送");
  });

  it("darkens while sending and keeps the sheet, 未发出, after a failure", () => {
    render();
    setOpen(true);
    h.thread = makeThread({ currentUser: reader, submitting: true });
    render();
    const sheet = $('[data-colophon-draft="head"]');
    expect(sheet?.dataset.draftState).toBe("sending");
    expect(
      sheet?.querySelector("[data-colophon-draft-status]")?.textContent,
    ).toBe("发送中");
    h.thread = makeThread({
      currentUser: reader,
      actionError: { id: null, message: "发送失败，输入仍保留" },
    });
    render();
    expect($('[data-colophon-draft="head"]')).toBe(sheet);
    expect(sheet?.dataset.draftState).toBe("failed");
    expect(
      sheet?.querySelector("[data-colophon-draft-status]")?.textContent,
    ).toBe("未发出");
    // A failed like is not a failed send.
    h.thread = makeThread({
      currentUser: reader,
      actionError: { id: "c1", message: "操作未完成" },
    });
    render();
    expect(sheet?.dataset.draftState).toBe("draft");
  });

  it("drops 未发出 once the composer closes on the failed text", () => {
    render();
    setOpen(true);
    typeDraft("发不出");
    h.thread = makeThread({
      currentUser: reader,
      actionError: { id: null, message: "发送失败，输入仍保留" },
    });
    render();
    expect(
      $('[data-colophon-draft="head"] [data-colophon-draft-status]')
        ?.textContent,
    ).toBe("未发出");
    setOpen(false);
    setOpen(true);
    expect(
      $('[data-colophon-draft="head"] [data-colophon-draft-status]')
        ?.textContent,
    ).toBe("草稿");
  });

  it("restores the strip once on open and close, and never while typing", () => {
    // WebKit throws the view on by the width the head gains or loses.
    h.stage = {
      ...h.stage,
      readOffset: () =>
        $("[data-colophon-head]")?.hasAttribute("data-colophon-drafting")
          ? 160
          : 100,
    };
    h.thread = makeThread({
      currentUser: reader,
      items: [comment("c1", writer)],
    });
    render();
    const scrollToOffset = h.stage?.scrollToOffset as ReturnType<typeof vi.fn>;
    setOpen(true);
    expect(scrollToOffset.mock.calls).toEqual([[100, "instant"]]);
    for (let index = 0; index < 5; index += 1) typeDraft(`字${index}`);
    render();
    expect(scrollToOffset).toHaveBeenCalledTimes(1);
    setOpen(false);
    expect(scrollToOffset.mock.calls).toEqual([
      [100, "instant"],
      [160, "instant"],
    ]);
  });

  it("brings a clipped head in once as the sheet opens", () => {
    h.thread = makeThread({
      currentUser: reader,
      items: [comment("c1", writer)],
    });
    render();
    const head = $("[data-colophon-head]")!;
    vi.spyOn(strip, "getBoundingClientRect").mockReturnValue({
      left: 0,
      right: 300,
    } as DOMRect);
    const headRect = vi
      .spyOn(head, "getBoundingClientRect")
      .mockReturnValue({ left: 20, right: 280 } as DOMRect);
    setOpen(true);
    expect(h.stage?.scrollToElement).not.toHaveBeenCalled();
    setOpen(false);
    headRect.mockReturnValue({ left: 200, right: 460 } as DOMRect);
    setOpen(true);
    expect(h.stage?.scrollToElement).toHaveBeenCalledTimes(1);
    expect(h.stage?.scrollToElement).toHaveBeenCalledWith(head);
    typeDraft("字");
    render();
    expect(h.stage?.scrollToElement).toHaveBeenCalledTimes(1);
  });

  it("inks the slip once, the first time the reader comes to the colophons", () => {
    render();
    expect(slip()?.hasAttribute("data-colophon-invite-cue")).toBe(false);
    h.stage = { ...h.stage, region: "comments" };
    render();
    expect(slip()?.hasAttribute("data-colophon-invite-cue")).toBe(true);
    act(() => {
      // jsdom has no AnimationEvent: React listens for the prefixed name.
      for (const name of ["animationend", "webkitAnimationEnd"])
        slip()?.dispatchEvent(new Event(name, { bubbles: true }));
    });
    expect(slip()?.hasAttribute("data-colophon-invite-cue")).toBe(false);
    h.stage = { ...h.stage, region: "media" };
    render();
    h.stage = { ...h.stage, region: "comments" };
    render();
    expect(slip()?.hasAttribute("data-colophon-invite-cue")).toBe(false);
  });

  it("skips the cue without motion, so it never stays pending", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query === "(prefers-reduced-motion: reduce)",
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    h.stage = { ...h.stage, region: "comments" };
    render();
    expect(slip()?.hasAttribute("data-colophon-invite-cue")).toBe(false);
    vi.unstubAllGlobals();
  });

  it("ends the cue for good when its ink is cut short or the slip is opened", () => {
    h.stage = { ...h.stage, region: "comments" };
    render();
    expect(slip()?.hasAttribute("data-colophon-invite-cue")).toBe(true);
    act(() => {
      slip()?.dispatchEvent(new Event("animationcancel", { bubbles: true }));
    });
    expect(slip()?.hasAttribute("data-colophon-invite-cue")).toBe(false);
  });

  it("does not ink the slip again after it was opened mid-cue", () => {
    h.stage = { ...h.stage, region: "comments" };
    render();
    expect(slip()?.hasAttribute("data-colophon-invite-cue")).toBe(true);
    click($("[data-colophon-head] [data-colophon-write]"));
    setOpen(true);
    setOpen(false);
    expect(slip()?.hasAttribute("data-colophon-invite-cue")).toBe(false);
  });
});
