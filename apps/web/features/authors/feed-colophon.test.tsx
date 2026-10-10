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
vi.mock("./author-context", () => ({
  useAuthors: () => h.authors,
  contentKey: (target: { type: string; id: string }) =>
    `${target.type}:${target.id}`,
}));
vi.mock("../auth/auth-return", () => ({
  useAuthEntry: () => h.enterAuth,
  useAuthReturn: () => null,
}));
vi.mock("../product-shell/product-shell", () => ({
  useProductShell: () => ({
    openProfile: h.openProfile,
    activeDestination: "home",
  }),
}));
import { FeedColophon } from "./feed-colophon";
import { COLOPHON_INPUT_BLUR_MS } from "./feed-colophon-input";

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
let strip: HTMLDivElement;
let root: Root;

const render = () =>
  act(() => {
    root.render(
      <FeedColophon fallbackCount={7} target={target} title="寒山诗" />,
    );
  });
const $ = <T extends Element = HTMLElement>(selector: string) =>
  host.querySelector<T>(selector);
const $$ = (selector: string) => [
  ...host.querySelectorAll<HTMLElement>(selector),
];
/** A signature's parts in document order: time, name, plaque, avatar. */
const signatureOrder = (signature: Element | null | undefined) =>
  [
    ...(signature?.querySelectorAll(
      "time,[data-colophon-name],[data-studio-name],[data-colophon-author]",
    ) ?? []),
  ].map((part) =>
    part.matches("time")
      ? "time"
      : part.matches("[data-colophon-author]")
        ? "avatar"
        : part.matches("[data-colophon-name]")
          ? "name"
          : "plaque",
  );

/** A colophon's own words, without the 「回复 X：」 leading a reply's. */
const words = (text: Element | null | undefined) =>
  text?.querySelector("[data-colophon-words]")?.textContent;
const click = (node: Element | null) =>
  act(() => {
    node?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  });

beforeEach(() => {
  FakeObserver.instances = [];
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  h.options = [];
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
  h.thread = makeThread();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
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
          "data-colophon-input-anchor",
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
      // The input's anchor, first so its sticky column is held at the
      // strip's left edge however little the colophons fill.
      "data-colophon-input-anchor=",
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

  it("starts each colophon with its words and signs it at the left, the time on top", () => {
    h.thread = makeThread({
      items: [comment("c1", { ...writer, studioName: "听雨轩" })],
    });
    render();
    const text = $("[data-colophon-text]");
    // The text starts with the words themselves: no avatar or nickname.
    expect(text?.parentElement?.firstElementChild).toBe(text);
    expect(text?.querySelector("[data-colophon-name]")).toBeNull();
    expect(text?.textContent).toBe("c1 的题跋");
    expect(words(text)).toBe("c1 的题跋");
    // 落款, after the text: the time first (at the column's top), then the
    // nickname and the plaque, then the avatar at the foot.
    const signature = $("[data-colophon-signature=root]");
    expect(signature?.tagName).toBe("FOOTER");
    expect(signature?.previousElementSibling).toBe(text);
    const time = signature?.firstElementChild as HTMLElement | null;
    expect(time?.tagName).toBe("TIME");
    expect(time?.getAttribute("dateTime")).toBe("2026-10-09T11:57:00.000Z");
    const name = signature?.querySelector<HTMLElement>("[data-colophon-name]");
    expect(name?.textContent).toBe("甲");
    expect(
      signature
        ?.querySelector("[data-studio-name]")
        ?.getAttribute("aria-label"),
    ).toBe("斋号：听雨轩");
    expect(signatureOrder(signature)).toEqual([
      "time",
      "name",
      "plaque",
      "avatar",
    ]);
    const avatar = signature?.querySelector<HTMLButtonElement>(
      "[data-colophon-author]",
    );
    expect(avatar?.tagName).toBe("BUTTON");
    expect(avatar?.getAttribute("aria-label")).toBe("打开甲的主页");
    expect(
      avatar
        ?.querySelector("[data-comment-avatar]")
        ?.getAttribute("aria-label"),
    ).toBe("甲的头像");
    expect(avatar?.textContent).toBe("甲");
    click(avatar!);
    expect(h.openProfile).toHaveBeenCalledWith("writer", avatar);
    // The text is described by its author (with the plaque) and the time.
    const [namesId, timeId] = (
      text?.getAttribute("aria-describedby") ?? ""
    ).split(" ");
    expect(document.getElementById(namesId!)?.contains(name!)).toBe(true);
    expect(
      document.getElementById(namesId!)?.querySelector("[data-studio-name]"),
    ).not.toBeNull();
    expect(document.getElementById(timeId!)).toBe(time);
  });

  it("describes a colophon without a time by its author alone", () => {
    const undated: { -readonly [K in keyof CommentItem]?: CommentItem[K] } =
      comment("c1", writer);
    delete undated.createdAt;
    h.thread = makeThread({ items: [undated as CommentItem] });
    render();
    const signature = $("[data-colophon-signature]");
    expect(signature?.querySelector("time")).toBeNull();
    expect(signature?.querySelector("[data-colophon-author]")).not.toBeNull();
    const text = $("[data-colophon-text]");
    const described = text?.getAttribute("aria-describedby") ?? "";
    expect(described.split(" ")).toHaveLength(1);
    expect(document.getElementById(described)?.textContent).toBe("甲");
  });

  it("cuts a long nickname in the signature, the avatar and description keeping it whole", () => {
    const long = { ...writer, name: "长".repeat(40) };
    h.thread = makeThread({ items: [comment("c1", long)] });
    render();
    const name = $("[data-colophon-signature] [data-colophon-name]");
    expect(name?.textContent).toBe(`${"长".repeat(11)}…`);
    expect(name?.getAttribute("aria-hidden")).toBe("true");
    expect($("[data-colophon-author]")?.getAttribute("aria-label")).toBe(
      `打开${"长".repeat(40)}的主页`,
    );
    const [namesId] = (
      $("[data-colophon-text]")?.getAttribute("aria-describedby") ?? ""
    ).split(" ");
    const names = document.getElementById(namesId!);
    // Read whole: the cut name is hidden, the full one is there for the
    // description.
    expect(
      [...(names?.children ?? [])]
        .filter((part) => part.getAttribute("aria-hidden") !== "true")
        .map((part) => part.textContent)
        .join(""),
    ).toBe("长".repeat(40));
  });

  it("cuts a long nickname in 「回复 X：」 as in the signature, read whole", () => {
    const long = { ...other, name: "长".repeat(17) };
    h.thread = makeThread({
      items: [comment("c1", long, { replies: [reply("r1", writer)] })],
    });
    render();
    const lead = $("[data-colophon-reply-lead]");
    // The cut name is shown and hidden from assistive technology; the full
    // one is read in its place.
    const read = (hidden: boolean) =>
      [...(lead?.childNodes ?? [])]
        .filter(
          (part) =>
            !(part instanceof HTMLElement) ||
            (part.getAttribute("aria-hidden") === "true") === hidden,
        )
        .map((part) => part.textContent)
        .join("");
    expect(read(true)).toBe(`回复 ${"长".repeat(11)}…：`);
    expect(read(false)).toBe(`回复 ${"长".repeat(17)}：`);
  });

  it("keeps the writer's focus when another colophon is pressed while writing", () => {
    h.thread = makeThread({ items: [comment("c1", writer)] });
    render();
    const writing = document.createElement("textarea");
    const column = document.createElement("div");
    column.setAttribute("data-colophon-input", "idle");
    column.append(writing);
    document.body.append(column);
    try {
      writing.focus();
      const text = $("[data-colophon-text]")!;
      const press = new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
      });
      text.dispatchEvent(press);
      expect(press.defaultPrevented).toBe(true);
      writing.blur();
      const idle = new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
      });
      text.dispatchEvent(idle);
      expect(idle.defaultPrevented).toBe(false);
    } finally {
      column.remove();
    }
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
    expect(words(first)).toBe(`${"永".repeat(200)}…`);
    expect(first?.dataset.folded).toBe("true");
    // Exactly 200 is shown whole where it fits; one more always folds.
    expect(words(second)).toBe("和".repeat(200));
    expect(third?.dataset.folded).toBe("true");
    expect($$("[data-colophon-fold]")).toHaveLength(2);
    const fold = $("[data-colophon-fold]");
    expect(fold?.textContent).toBe("全文");
    expect(fold?.getAttribute("aria-expanded")).toBe("false");
    click(fold);
    expect(words($("[data-colophon-text]"))).toBe(long);
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
      expect(words(long)).toBe("长".repeat(150));
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
            reply("r1", { ...other, studioName: "洗砚斋" }),
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
    // Each reply starts with the relation, then its words: 回复 甲：…
    const replyText = $('[data-comment-reply="r1"] [data-colophon-text]');
    expect(
      [...(replyText?.children ?? [])].map(
        (part) => (part as HTMLElement).textContent,
      ),
    ).toEqual(["回复 甲：", "r1 的回复"]);
    expect(
      $('[data-comment-reply="r1"] [data-colophon-author]')?.getAttribute(
        "aria-label",
      ),
    ).toBe("打开乙的主页");
    const replySignature = $(
      '[data-comment-reply="r1"] [data-colophon-signature]',
    );
    expect(replySignature?.dataset.colophonSignature).toBe("reply");
    // Signed like a root: the time on top, the avatar at the foot.
    expect(signatureOrder(replySignature)).toEqual([
      "time",
      "name",
      "plaque",
      "avatar",
    ]);
    expect(
      $$("[data-comment-reply]").map((node) => node.dataset.colophonAnchor),
    ).toEqual(["r1", "r2"]);
    const more = $("[data-colophon-more-replies]");
    expect(more?.textContent).toBe("余4则回复");
    expect(more?.getAttribute("aria-busy")).toBe("true");
    click(more);
    expect(h.thread.loadReplies).toHaveBeenCalledWith("c1");
  });

  it("keeps a deleted root's signature and says its text was deleted", () => {
    h.thread = makeThread({
      items: [
        comment("c1", writer, {
          deleted: true,
          text: "",
          replies: [reply("r1", other)],
        }),
      ],
    });
    render();
    const text = $('[data-comment-id="c1"] [data-colophon-text]');
    expect(
      $(
        '[data-comment-id="c1"] [data-colophon-signature=root] [data-colophon-name]',
      )?.textContent,
    ).toBe("甲");
    expect(words(text)).toBe("该正文已删除");
    expect(text?.querySelector("[data-colophon-deleted]")).not.toBeNull();
    expect(
      $$("[data-colophon-reply-lead]").map((lead) => lead.textContent),
    ).toEqual(["回复 甲："]);
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

  it("sends a guest to sign in from the input column, 回复 and 赞, returning focus to the opener", () => {
    h.authors = { viewer: null };
    h.thread = makeThread({
      currentUser: { id: "guest", name: "访客" },
      viewerState: { state: "signed-out", signInHref: "/login?x=1" },
      items: [comment("c1", writer)],
    });
    render();
    const signIn = host.querySelector<HTMLAnchorElement>(
      "[data-colophon-sign-in]",
    );
    expect(signIn?.textContent).toBe("登录后题跋");
    expect(signIn?.getAttribute("href")).toBe("/login?x=1");
    // Nothing to write in for a guest, and nothing in the head.
    expect(host.querySelector("textarea")).toBeNull();
    expect($("[data-colophon-head] a, [data-colophon-head] button")).toBeNull();
    click($("[data-colophon-text]"));
    const replyButton = $("[data-colophon-reply]");
    click(replyButton);
    expect(h.enterAuth).toHaveBeenCalledWith("/login?x=1", replyButton);
    const like = $("[data-colophon-like]");
    click(like);
    expect(h.thread.toggleLike).toHaveBeenCalledWith("c1", undefined, like);
  });

  it("holds the input column in the strip, at its left edge, shown only on the colophons", () => {
    h.thread = makeThread({ items: [comment("c1", writer)], visibleTotal: 1 });
    render();
    const column = $("[data-colophon-input]");
    expect(column?.dataset.colophonInput).toBe("write");
    // In a sticky anchor, first in the colophons.
    const anchor = column?.parentElement;
    expect(anchor?.hasAttribute("data-colophon-input-anchor")).toBe(true);
    expect(anchor?.parentElement?.firstElementChild).toBe(anchor);
    expect(anchor?.parentElement?.hasAttribute("data-feed-colophon")).toBe(
      true,
    );
    // On the images it is hidden and inert.
    expect(column?.hasAttribute("data-colophon-input-shown")).toBe(false);
    expect(column?.hasAttribute("inert")).toBe(true);
    h.stage = { ...h.stage, region: "comments" };
    render();
    expect(column?.hasAttribute("data-colophon-input-shown")).toBe(true);
    expect(column?.hasAttribute("inert")).toBe(false);
    // The head keeps only 题跋 and the count: no write entry anywhere in
    // the strip, and no horizontal composer.
    expect($("[data-colophon-head]")?.textContent).toBe("题跋1则");
    expect($("[data-colophon-end] button, [data-colophon-end] a")).toBeNull();
    expect(document.querySelector("[data-colophon-composer]")).toBeNull();
  });

  it("replies from 回复 in the input, focused in the same tap, and sends through the thread", async () => {
    h.stage = { ...h.stage, region: "comments" };
    h.thread = makeThread({ items: [comment("c1", writer)] });
    render();
    const box = host.querySelector("textarea")!;
    click($("[data-colophon-text]"));
    click($("[data-colophon-reply]"));
    // The toolbar closes; the input takes focus, led by 「回复 甲：」.
    expect($("[data-colophon-actions]")).toBeNull();
    expect(document.activeElement).toBe(box);
    expect(
      host.querySelector("[data-colophon-input-reply]")?.textContent,
    ).toContain("回复 甲：");
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(box, "  答  ");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      host
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });
    expect(h.thread.sendReply).toHaveBeenCalledWith(
      { rootCommentId: "c1", user: writer },
      "答",
    );
    // Accepted: the text and the reply lead are gone.
    expect(box.value).toBe("");
    expect(host.querySelector("[data-colophon-input-reply]")).toBeNull();
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(box, "新题");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      host
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });
    expect(h.thread.sendComment).toHaveBeenCalledWith("新题");
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

  it("moves focus on from the input to the reader's own published colophon", () => {
    h.stage = { ...h.stage, region: "comments" };
    h.thread = makeThread({
      items: [comment("c1", writer), comment("c2", writer)],
    });
    render();
    // The input let go of focus once the send was accepted.
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    h.thread = makeThread({
      items: [comment("c1", writer), comment("c2", writer)],
      highlightId: "c2",
      lastSubmit: { id: "c2", rootId: "c2", awaitingApproval: false },
    });
    render();
    expect(document.activeElement).toBe(
      $('[data-comment-id="c2"] [data-colophon-text]'),
    );
  });

  /** Places the input column, the strip and the colophons for a test. */
  const layout = (place: (node: Element) => [left: number, width: number]) =>
    vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: Element) {
        const [left, width] = place(this);
        return {
          x: left,
          y: 0,
          left,
          right: left + width,
          top: 0,
          bottom: 500,
          width,
          height: 500,
          toJSON: () => ({}),
        } as DOMRect;
      });

  it("brings a selected colophon whose actions sit under the input column to its snap position", () => {
    h.stage = { ...h.stage, region: "comments" };
    h.thread = makeThread({
      items: [comment("c1", writer), comment("c2", other)],
    });
    let actionsLeft = 10;
    layout((node) =>
      node === strip
        ? [0, 393]
        : node.matches("[data-colophon-input]")
          ? [0, 49]
          : node.matches("[data-colophon-actions]")
            ? [actionsLeft, 52]
            : [200, 40],
    );
    render();
    click($('[data-comment-id="c2"] [data-colophon-text]'));
    expect(h.stage?.scrollToElement).toHaveBeenCalledWith(
      $('[data-comment-id="c2"]'),
    );
    // Clear of the column: the strip stays where it is.
    click($('[data-comment-id="c2"] [data-colophon-text]'));
    actionsLeft = 120;
    click($('[data-comment-id="c1"] [data-colophon-text]'));
    expect(h.stage?.scrollToElement).toHaveBeenCalledTimes(1);
  });

  it("brings the colophon a reply answers clear of where the input can grow", () => {
    h.stage = { ...h.stage, region: "comments" };
    h.thread = makeThread({
      items: [comment("c1", writer), comment("c2", other)],
    });
    // The input grows to 60% of 393 px: c1 sits within that, c2 beyond it.
    layout((node) => {
      if (node === strip) return [0, 393];
      if (node.matches("[data-colophon-input]")) return [0, 49];
      if (node.matches("[data-colophon-actions]")) return [300, 52];
      const entry = node.closest("[data-comment-id]");
      return entry?.getAttribute("data-comment-id") === "c1"
        ? [150, 60]
        : [300, 60];
    });
    render();
    click($('[data-comment-id="c2"] [data-colophon-text]'));
    click($("[data-colophon-reply]"));
    expect(h.stage?.scrollToElement).not.toHaveBeenCalled();
    click($('[data-comment-id="c1"] [data-colophon-text]'));
    click($("[data-colophon-reply]"));
    expect(h.stage?.scrollToElement).toHaveBeenCalledWith(
      $('[data-comment-id="c1"]'),
    );
    expect(h.stage?.scrollToElement).toHaveBeenCalledTimes(1);
  });

  it("lets the colophons recede while the input is written in, all but the one it answers", () => {
    vi.useFakeTimers();
    h.stage = { ...h.stage, region: "comments" };
    h.thread = makeThread({
      items: [comment("c1", writer), comment("c2", other)],
    });
    render();
    const section = $("[data-feed-colophon]")!;
    expect(section.hasAttribute("data-colophon-writing")).toBe(false);
    click($('[data-comment-id="c1"] [data-colophon-text]'));
    click($("[data-colophon-reply]"));
    expect(section.hasAttribute("data-colophon-writing")).toBe(true);
    expect(
      $('[data-comment-id="c1"]')?.hasAttribute("data-colophon-reply-target"),
    ).toBe(true);
    expect($("[data-colophon-reply-target]")).toBe($('[data-comment-id="c1"]'));
    act(() => $("textarea")!.blur());
    act(() => vi.advanceTimersByTime(COLOPHON_INPUT_BLUR_MS));
    expect(section.hasAttribute("data-colophon-writing")).toBe(false);
    // Still answering it: still marked.
    expect(
      $('[data-comment-id="c1"]')?.hasAttribute("data-colophon-reply-target"),
    ).toBe(true);
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

  it("says 已发送 in the input column for a few seconds whether published or awaiting approval", () => {
    vi.useFakeTimers();
    render();
    const notice = host.querySelector("[data-colophon-notice]");
    expect(notice?.getAttribute("role")).toBe("status");
    expect(notice?.closest("[data-colophon-input]")).not.toBeNull();
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

  it("renders no input before the stage strip is there", () => {
    h.stage = { ...h.stage, strip: null };
    render();
    expect(document.querySelector("[data-colophon-input]")).toBeNull();
    expect($("[data-colophon-head]")).not.toBeNull();
  });

  it("closed: a truthful note in the column, no input, no reply, no review wording", () => {
    h.thread = makeThread({
      composerClosed: true,
      closedNote: "此作品当前仅你可见，暂时无法发表评论。",
      viewerState: { state: "checking" },
      currentUser: user("writer", "甲"),
      items: [comment("c1", other)],
      notice: "",
    });
    render();
    expect(host.querySelector("[data-colophon-closed]")?.textContent).toBe(
      "此作品当前仅你可见，暂时无法发表评论。",
    );
    expect(host.querySelector("textarea")).toBeNull();
    expect(host.querySelector("[data-colophon-sign-in]")).toBeNull();
    click($("[data-colophon-text]"));
    expect($("[data-colophon-reply]")).toBeNull();
    expect(host.textContent).not.toMatch(/审核|待发布|等待/);
    expect(host.textContent).not.toMatch(/审核|待发布|等待/);
  });

  it("says when the discussion is not open here, with nothing to write in", () => {
    h.thread = makeThread({ page: 0, totalPages: 0, unavailable: true });
    render();
    expect($("[data-colophon-unavailable]")?.textContent).toBe(
      "此处暂不开放题跋",
    );
    expect(
      host.querySelector<HTMLElement>("[data-colophon-input]")?.dataset
        .colophonInput,
    ).toBe("none");
    expect(host.querySelector("textarea")).toBeNull();
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
    expect(text?.querySelector("[data-colophon-words] span")?.textContent).toBe(
      "10",
    );
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
    // The nickname leading the text is not part of the copy.
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
