// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommentViewerState } from "../comments/comment-section";
import type { CommentReplyTarget } from "../comments/comment-types";

const h = vi.hoisted(() => ({
  authReturn: null as null | {
    remember: ReturnType<typeof vi.fn>;
    take: ReturnType<typeof vi.fn>;
  },
}));
vi.mock("../auth/auth-return", () => ({
  useAuthReturn: () => h.authReturn,
}));
import {
  COLOPHON_INPUT_BLUR_MS,
  COLOPHON_INPUT_MAX_LENGTH,
  colophonDraftKey,
  colophonInputFitHeight,
  colophonInputWidth,
  colophonLeadName,
  FeedColophonInput,
} from "./feed-colophon-input";
import type {
  FeedColophonInputHandle,
  FeedColophonInputProps,
} from "./feed-colophon-input";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const replyTo: CommentReplyTarget = {
  rootCommentId: "c1",
  user: { id: "u1", name: "听松", avatarSrc: null },
};

let strip: HTMLDivElement;
let root: Root;
let handle: ReturnType<typeof createRef<FeedColophonInputHandle>>;
let onSubmit: ReturnType<typeof vi.fn<FeedColophonInputProps["onSubmit"]>>;

const render = (props: Partial<FeedColophonInputProps> = {}) =>
  act(() => {
    root.render(
      <FeedColophonInput
        actorId="reader"
        closed={false}
        closedNote={null}
        contentKey="work:w1"
        strip={strip}
        notice=""
        onSubmit={onSubmit}
        ref={handle}
        shown
        submitting={false}
        unavailable={false}
        viewerState={{ state: "signed-in" }}
        {...props}
      />,
    );
  });

const $ = <T extends Element = HTMLElement>(selector: string) =>
  strip.querySelector<T>(selector);
const box = () => $<HTMLTextAreaElement>("textarea")!;
const send = () => $<HTMLButtonElement>("[data-colophon-input-send]")!;
const type = (text: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(box(), text);
    box().dispatchEvent(new Event("input", { bubbles: true }));
  });
const submit = () =>
  act(async () => {
    $("form")!.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });

beforeEach(() => {
  h.authReturn = null;
  strip = document.createElement("div");
  document.body.append(strip);
  root = createRoot(strip);
  handle = createRef<FeedColophonInputHandle>();
  onSubmit = vi.fn<FeedColophonInputProps["onSubmit"]>(async () => true);
});

afterEach(() => {
  act(() => root.unmount());
  strip.remove();
  vi.useRealTimers();
});

describe("colophon input geometry", () => {
  it("keeps the feed's draft key apart from Detail's", () => {
    expect(colophonDraftKey("work:w1")).toBe("feed:work:w1");
    expect(colophonDraftKey("feed:work:w1")).toBe("feed:work:w1");
  });

  it("widens with the text up to 60% of the stage, holding whole columns there", () => {
    // Idle, and while the text fits the idle column.
    expect(colophonInputWidth(30, 48, 393)).toBe(48);
    // Growing with the text.
    expect(colophonInputWidth(98, 48, 393)).toBe(98);
    expect(colophonInputWidth(236, 48, 393)).toBe(236);
    // Past the cap (236 of 393): whole 24 px columns within 16 px padding.
    expect(colophonInputWidth(900, 48, 393, 24, 16)).toBe(16 + 9 * 24);
    expect(colophonInputWidth(900, 48, 393)).toBe(236);
    // Never narrower than idle, even on a tiny stage.
    expect(colophonInputWidth(900, 48, 40, 24, 16)).toBe(48);
    // The reply lead's column beside it comes off the cap.
    expect(colophonInputWidth(900, 48, 393, 0, 0, 26)).toBe(236 - 26);
    expect(colophonInputWidth(100, 48, 393, 0, 0, 26)).toBe(100);
  });

  it("cuts a long reply target's name short in the lead", () => {
    expect(colophonLeadName("听松")).toBe("听松");
    expect(colophonLeadName("  墨池拾遗客  ")).toBe("墨池拾遗客");
    expect(colophonLeadName("长".repeat(40))).toBe(`${"长".repeat(5)}…`);
    // Code points, not UTF-16 units.
    expect(colophonLeadName("𠀀".repeat(7))).toBe(`${"𠀀".repeat(5)}…`);
  });

  it("ends the column above the keyboard, never shorter than its minimum", () => {
    // The whole stage is visible: no fitting.
    expect(
      colophonInputFitHeight({
        frameTop: 52,
        frameHeight: 491,
        visibleBottom: 659,
      }),
    ).toBeNull();
    expect(
      colophonInputFitHeight({
        frameTop: 52,
        frameHeight: 491,
        visibleBottom: 380,
      }),
    ).toBe(328);
    expect(
      colophonInputFitHeight({
        frameTop: 300,
        frameHeight: 491,
        visibleBottom: 380,
      }),
    ).toBe(160);
  });
});

describe("FeedColophonInput", () => {
  it("is a vertical text input with a vertical placeholder and a disabled 发送 while empty", () => {
    render();
    const column = $("[data-colophon-input]");
    expect(column?.dataset.colophonInput).toBe("write");
    expect(box().placeholder).toBe("写题跋…");
    expect(box().getAttribute("aria-label")).toBe("写题跋");
    expect(box().maxLength).toBe(COLOPHON_INPUT_MAX_LENGTH);
    expect(box().getAttribute("enterkeyhint")).toBe("enter");
    expect(send().textContent).toBe("发送");
    expect(send().disabled).toBe(true);
    type("   ");
    expect(send().disabled).toBe(true);
    type("临得很用心");
    expect(send().disabled).toBe(false);
    // No mentions in the feed.
    expect($("[data-mention-control]")).toBeNull();
  });

  it("sends the trimmed text, clears it once accepted, and keeps it after a failure", async () => {
    render();
    type("  好帖 \r\n ");
    await submit();
    expect(onSubmit).toHaveBeenCalledWith("好帖", null);
    expect(box().value).toBe("");

    onSubmit.mockResolvedValueOnce(false);
    type("再试");
    await submit();
    expect(onSubmit).toHaveBeenLastCalledWith("再试", null);
    expect(box().value).toBe("再试");
  });

  it("does not clear text written while the send was in flight", async () => {
    let resolve: (accepted: boolean) => void = () => undefined;
    onSubmit.mockImplementationOnce(
      () =>
        new Promise<boolean>((done) => {
          resolve = done;
        }),
    );
    render();
    type("第一句");
    await submit();
    type("第一句，又补一句");
    await act(async () => resolve(true));
    expect(box().value).toBe("第一句，又补一句");
  });

  it("says 发送中 and refuses a second send while submitting", async () => {
    render({ submitting: true });
    type("等一下");
    expect(send().textContent).toBe("发送中");
    expect(send().disabled).toBe(true);
    await submit();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("replies: focuses the input with the caret at the end, led by 「回复 X：」, which × drops", async () => {
    render();
    type("同意");
    act(() => handle.current?.reply(replyTo));
    expect(document.activeElement).toBe(box());
    expect(box().selectionStart).toBe(2);
    const lead = $("[data-colophon-input-reply]");
    expect(lead?.textContent).toContain("回复 听松：");
    expect(box().getAttribute("aria-label")).toBe("回复听松");
    await submit();
    expect(onSubmit).toHaveBeenCalledWith("同意", replyTo);
    expect($("[data-colophon-input-reply]")).toBeNull();

    act(() => handle.current?.reply(replyTo));
    type("留着");
    const drop = $<HTMLButtonElement>("[data-colophon-input-unreply]")!;
    expect(drop.getAttribute("aria-label")).toBe("不再回复听松");
    act(() => drop.click());
    expect($("[data-colophon-input-reply]")).toBeNull();
    // The text stays, and so does focus.
    expect(box().value).toBe("留着");
    expect(document.activeElement).toBe(box());
  });

  it("keeps a long reply target's name to the lead's one column, × and the text beside it", () => {
    render();
    const long = {
      ...replyTo,
      user: { ...replyTo.user, name: "长".repeat(40) },
    };
    act(() => handle.current?.reply(long));
    const lead = $("[data-colophon-input-reply]")!;
    expect(lead.textContent).toBe(`回复 ${"长".repeat(5)}…：×`);
    // The full name is still what the text and × are named after.
    expect(box().getAttribute("aria-label")).toBe(`回复${"长".repeat(40)}`);
    expect($("[data-colophon-input-unreply]")?.getAttribute("aria-label")).toBe(
      `不再回复${"长".repeat(40)}`,
    );
    // The lead and the text share one row: the lead never sits above it.
    expect(lead.parentElement).toBe(box().parentElement);
    expect(lead.parentElement).not.toBe($("form"));
  });

  it("Escape drops the reply first, then leaves the input", () => {
    render();
    act(() => handle.current?.reply(replyTo));
    const escape = () =>
      act(() => {
        box().dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
      });
    escape();
    expect($("[data-colophon-input-reply]")).toBeNull();
    expect(document.activeElement).toBe(box());
    escape();
    expect(document.activeElement).not.toBe(box());
  });

  it("leaves an Escape that ends an IME composition to the IME", () => {
    render();
    act(() => handle.current?.reply(replyTo));
    const composing = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
      isComposing: true,
    });
    act(() => {
      box().dispatchEvent(composing);
    });
    expect(composing.defaultPrevented).toBe(false);
    expect($("[data-colophon-input-reply]")).not.toBeNull();
    expect(document.activeElement).toBe(box());
  });

  it("tells the colophons while it is written in, and what it answers", () => {
    vi.useFakeTimers();
    const onWritingChange = vi.fn();
    render({ onWritingChange });
    expect(onWritingChange).toHaveBeenLastCalledWith(false, null);
    act(() => handle.current?.reply(replyTo));
    expect(onWritingChange).toHaveBeenLastCalledWith(true, replyTo);
    act(() => box().blur());
    act(() => vi.advanceTimersByTime(COLOPHON_INPUT_BLUR_MS));
    expect(onWritingChange).toHaveBeenLastCalledWith(false, replyTo);
  });

  it("leaves swipes on the column to the strip it sits in", () => {
    render();
    // The strip already keeps its swipes from the Home pager; marking the
    // column too would make the pager's rules stop the strip's own pans
    // on the colophons around it.
    expect($("[data-local-horizontal]")).toBeNull();
  });

  it("keeps the text focused when 发送 is pressed", () => {
    render();
    type("字");
    const down = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    act(() => {
      send().dispatchEvent(down);
    });
    expect(down.defaultPrevented).toBe(true);
  });

  it("shows the status after an action in the column", () => {
    render({ notice: "已发送" });
    const status = $("[data-colophon-notice]");
    expect(status?.getAttribute("role")).toBe("status");
    expect(status?.textContent).toBe("已发送");
  });

  it("is hidden and inert off the colophons, and lets go of focus there", () => {
    render();
    act(() => box().focus());
    expect(document.activeElement).toBe(box());
    render({ shown: false });
    const column = $("[data-colophon-input]");
    expect(column?.hasAttribute("data-colophon-input-shown")).toBe(false);
    expect(column?.hasAttribute("inert")).toBe(true);
    expect(document.activeElement).not.toBe(box());
    // The draft is still there when the reader comes back.
    render({ shown: true });
    expect(column?.hasAttribute("inert")).toBe(false);
  });

  it("marks the column as being written while focused, a moment past a blur", () => {
    vi.useFakeTimers();
    render();
    const column = $("[data-colophon-input]")!;
    act(() => box().focus());
    expect(column.hasAttribute("data-colophon-input-focused")).toBe(true);
    act(() => box().blur());
    expect(column.hasAttribute("data-colophon-input-focused")).toBe(true);
    act(() => vi.advanceTimersByTime(COLOPHON_INPUT_BLUR_MS));
    expect(column.hasAttribute("data-colophon-input-focused")).toBe(false);
  });

  it("offers a guest sign-in instead", () => {
    render({
      actorId: null,
      viewerState: { state: "signed-out", signInHref: "/login?r=1" },
    });
    expect($("[data-colophon-input]")?.dataset.colophonInput).toBe("guest");
    const link = $<HTMLAnchorElement>("[data-colophon-sign-in]");
    expect(link?.textContent).toBe("登录后题跋");
    expect(link?.getAttribute("href")).toBe("/login?r=1");
    expect($("textarea")).toBeNull();
  });

  it.each<[string, Partial<FeedColophonInputProps>, string, string | null]>([
    [
      "closed with a note",
      { closed: true, closedNote: "此作品当前仅你可见，暂时无法发表评论。" },
      "closed",
      "此作品当前仅你可见，暂时无法发表评论。",
    ],
    ["closed without a note", { closed: true }, "none", null],
    ["unavailable", { unavailable: true }, "none", null],
    [
      "checking the session",
      { viewerState: { state: "checking" } as CommentViewerState },
      "none",
      null,
    ],
    [
      "the session unknown",
      { viewerState: { state: "unavailable" } as CommentViewerState },
      "unknown",
      "暂时无法确认登录状态",
    ],
  ])("%s: no input, only a short note", (_, props, state, note) => {
    render(props);
    expect($("[data-colophon-input]")?.dataset.colophonInput).toBe(state);
    expect($("textarea")).toBeNull();
    expect($("[data-colophon-sign-in]")).toBeNull();
    const shown =
      $("[data-colophon-closed]") ?? $("[data-colophon-viewer-unavailable]");
    expect(shown?.textContent ?? null).toBe(note);
    expect(strip.textContent).not.toMatch(/审核|待发布|等待/);
  });

  it("remembers the draft for sign-in and takes it back for the same reader", () => {
    h.authReturn = {
      remember: vi.fn(),
      take: vi.fn(() => ({ draft: "登录前写的", replyTarget: replyTo })),
    };
    render();
    expect(h.authReturn.take).toHaveBeenCalledWith("reader", "feed:work:w1");
    expect(box().value).toBe("登录前写的");
    expect($("[data-colophon-input-reply]")?.textContent).toContain(
      "回复 听松：",
    );
    type("又写了");
    expect(h.authReturn.remember).toHaveBeenLastCalledWith(
      "reader",
      "feed:work:w1",
      { draft: "又写了", replyTarget: replyTo },
    );
  });

  it("starts a new draft for another post", () => {
    render();
    type("这一篇的");
    render({ contentKey: "work:w2" });
    expect(box().value).toBe("");
  });
});
