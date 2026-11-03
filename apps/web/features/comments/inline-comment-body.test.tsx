// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type { CommentImage } from "@moya/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InlineCommentBody } from "./inline-comment-body";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../shell/desktop-viewport-scroll-lock", () => ({
  acquireDesktopViewportScrollLock: () => () => {},
}));
vi.mock("../detail/catalog-viewer", () => ({
  CatalogViewer: ({
    media,
    index,
    onClose,
    onIndexChange,
  }: {
    media: readonly { id: string; src: string }[];
    index: number;
    onClose: () => void;
    onIndexChange: (index: number) => void;
  }) => (
    <dialog open data-viewer-index={index} data-viewer-count={media.length}>
      <span>{media[index]?.src}</span>
      <button onClick={onClose}>关闭图像</button>
      <button
        onClick={() => onIndexChange(Math.min(media.length - 1, index + 1))}
      >
        下一张
      </button>
    </dialog>
  ),
}));

const image = (digit: string, offset: number): CommentImage => ({
  id: `media-item-${digit.repeat(32)}`,
  offset,
  width: 1200,
  height: 800,
  thumbSrc: `/api/community/discussion/images/comment-${"a".repeat(32)}/media-item-${digit.repeat(32)}/thumb`,
  src: `/api/community/discussion/images/comment-${"a".repeat(32)}/media-item-${digit.repeat(32)}/display`,
});
let root: Root;
let node: HTMLDivElement;
beforeEach(() => {
  window.history.replaceState({ screen: "detail" }, "", "/");
  vi.spyOn(window.history, "back").mockImplementation(() => {});
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});
afterEach(async () => {
  window.history.replaceState({ screen: "detail" }, "", "/");
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("inline comment images", () => {
  it("keeps start, middle and end positions in UTF-16 text and stable equal-offset order", async () => {
    const images = [image("1", 0), image("2", 3), image("3", 3), image("4", 4)];
    await act(async () =>
      root.render(<InlineCommentBody text="甲😀乙" images={images} />),
    );
    const sequence = [...node.childNodes].map((n) =>
      n instanceof HTMLButtonElement ? n.dataset.commentImage : n.textContent,
    );
    expect(sequence).toEqual([
      images[0]!.id,
      "甲😀",
      images[1]!.id,
      images[2]!.id,
      "乙",
      images[3]!.id,
    ]);
    expect(
      [...node.querySelectorAll("img")].every(
        (n) => n.width === 32 && n.height === 32,
      ),
    ).toBe(true);
  });

  it("opens only this entry's images without invoking reply, and returns focus without scrolling", async () => {
    const reply = vi.fn();
    const images = [image("1", 1), image("2", 2)];
    await act(async () =>
      root.render(
        <div onClick={reply} onKeyDown={reply}>
          <InlineCommentBody text="甲乙" images={images} />
        </div>,
      ),
    );
    const trigger = node.querySelector<HTMLButtonElement>(
      `[data-comment-image="${images[1]!.id}"]`,
    )!;
    const focus = vi.spyOn(trigger, "focus");
    await act(async () => {
      trigger.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
      trigger.click();
    });
    expect(reply).not.toHaveBeenCalled();
    const dialog = document.querySelector("dialog")!;
    expect(dialog.getAttribute("data-viewer-count")).toBe("2");
    expect(dialog.getAttribute("data-viewer-index")).toBe("1");
    expect(dialog.textContent).toContain(images[1]!.src);
    await act(async () =>
      [...dialog.querySelectorAll("button")]
        .find((b) => b.textContent === "关闭图像")!
        .click(),
    );
    expect(window.history.back).toHaveBeenCalledOnce();
    const state = {
      ...window.history.state,
      commentImageNavigation: {
        ...window.history.state.commentImageNavigation,
        depth: 0,
      },
    };
    await act(async () => {
      window.history.replaceState(state, "", "/");
      window.dispatchEvent(new PopStateEvent("popstate", { state }));
    });
    expect(document.querySelector("dialog")).toBeNull();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(reply).not.toHaveBeenCalled();
    const go = vi.spyOn(window.history, "go").mockImplementation(() => {});
    const forward = {
      ...state,
      commentImageNavigation: { ...state.commentImageNavigation, depth: 1 },
    };
    await act(async () => {
      window.history.replaceState(forward, "", "/");
      window.dispatchEvent(new PopStateEvent("popstate", { state: forward }));
    });
    expect(document.querySelector("dialog")).toBeNull();
    expect(go).toHaveBeenCalledWith(-1);
  });

  it("supports image-only entries and a truthful retry fallback", async () => {
    const images = [image("1", 0)];
    await act(async () =>
      root.render(<InlineCommentBody text="" images={images} />),
    );
    await act(async () =>
      node.querySelector("img")!.dispatchEvent(new Event("error")),
    );
    expect(node.textContent).toBe("重试");
    await act(async () => node.querySelector("button")!.click());
    expect(node.querySelector("img")).not.toBeNull();
    expect(
      document.querySelector("dialog")?.getAttribute("data-viewer-count"),
    ).toBe("1");
  });

  it("keeps the full current-entry sequence when a folded body hides later inline slots", async () => {
    const first = image("1", 1),
      last = image("2", 400);
    await act(async () =>
      root.render(
        <InlineCommentBody
          text="开头…"
          images={[first]}
          viewerImages={[first, last]}
        />,
      ),
    );
    expect(node.querySelectorAll("[data-comment-image]")).toHaveLength(1);
    expect(node.querySelector("button")?.getAttribute("aria-label")).toContain(
      "共 2 张",
    );
    await act(async () => node.querySelector("button")!.click());
    expect(
      document.querySelector("dialog")?.getAttribute("data-viewer-count"),
    ).toBe("2");
    await act(async () =>
      [...document.querySelectorAll("dialog button")]
        .find((b) => b.textContent === "下一张")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(
      document.querySelector("dialog")?.getAttribute("data-viewer-index"),
    ).toBe("1");
  });

  it("lets the existing reader receive a pointer drag without opening an image or replying", async () => {
    const down = vi.fn(),
      reply = vi.fn();
    await act(async () =>
      root.render(
        <div onPointerDown={down} onClick={reply}>
          <InlineCommentBody text="正文" images={[image("1", 1)]} vertical />
        </div>,
      ),
    );
    const trigger = node.querySelector("button")!;
    const pointer = (kind: string, x: number) => {
      const event = new Event(kind, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        clientX: { value: x },
        clientY: { value: 10 },
      });
      return event;
    };
    await act(async () => {
      trigger.dispatchEvent(pointer("pointerdown", 10));
      trigger.dispatchEvent(pointer("pointermove", 40));
      trigger.click();
    });
    expect(down).toHaveBeenCalledOnce();
    expect(reply).not.toHaveBeenCalled();
    expect(document.querySelector("dialog")).toBeNull();
  });

  it("preserves reader navigation keys while isolating image activation keys", async () => {
    const keys: string[] = [];
    await act(async () =>
      root.render(
        <div onKeyDown={(event) => keys.push(event.key)}>
          <InlineCommentBody text="正文" images={[image("1", 1)]} />
        </div>,
      ),
    );
    const trigger = node.querySelector("button")!;
    await act(async () => {
      for (const key of ["Enter", " ", "ArrowLeft", "Escape"])
        trigger.dispatchEvent(
          new KeyboardEvent("keydown", { key, bubbles: true }),
        );
    });
    expect(keys).toEqual(["ArrowLeft", "Escape"]);
  });

  it("closes a viewer when its attachment is removed by a refreshed permission result", async () => {
    await act(async () =>
      root.render(<InlineCommentBody text="正文" images={[image("1", 1)]} />),
    );
    await act(async () => node.querySelector("button")!.click());
    expect(document.querySelector("dialog")).not.toBeNull();
    await act(async () =>
      root.render(<InlineCommentBody text="该正文已删除" images={[]} />),
    );
    expect(document.querySelector("dialog")).toBeNull();
    expect(node.textContent).toBe("该正文已删除");
  });
});
