// @vitest-environment jsdom
import { StrictMode, act, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  UploadManagerSnapshot,
  UploadItemPhase,
} from "../publishing/upload-manager";

const h = vi.hoisted(() => ({
  account: "user-00000000000000000000000000000001",
  epoch: 0,
  created: 0,
  abandoned: 0,
  serial: 0,
  phase: "ready" as UploadItemPhase,
  openChanges: [] as boolean[],
}));
vi.mock("../authors/author-data", () => ({
  authorClient: { account: () => h.account, accountEpoch: () => h.epoch },
}));
vi.mock("../publishing/ui/media/media-preview", () => ({
  useBoundedPreview: () => ({ url: null, status: "idle", size: null }),
}));
vi.mock("./comment-image-upload-session", () => ({
  CommentImageError: class extends Error {},
  createCommentUploadSession: (owner: string) => {
    h.created++;
    let state: UploadManagerSnapshot = {
      accountId: owner,
      status: "active",
      pauseReason: null,
      items: [],
    };
    const listeners = new Set<() => void>(),
      emit = () => {
        for (const fn of listeners) fn();
      };
    return {
      owner,
      subscribe: (fn: () => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      snapshot: () => state,
      localStill: () => null,
      add: async (files: readonly File[]) => {
        const rows = files.map(() => {
          const serial = ++h.serial,
            id = `media-item-${serial.toString(16).padStart(32, "0")}`;
          return {
            key: `image-${serial}`,
            itemId: id,
            kind: "static" as const,
            qualityMode: "standard" as const,
            notCameraOriginal: false,
            phase: h.phase,
            components: [],
            failure: null,
            choice: null,
            recoverable: false,
            serverItem: {
              id,
              kind: "static" as const,
              qualityMode: "standard" as const,
              state: "ready" as const,
              failureCode: null,
              components: [],
              presentation: { width: 200, height: 100 },
              media: {
                thumbSrc: "/api/community/synthetic/thumb",
                displaySrc: "/api/community/synthetic/display",
              },
            },
          };
        });
        state = { ...state, items: [...state.items, ...rows] };
        emit();
        return rows.map(({ key }) => key);
      },
      remove: async (key: string) => {
        state = {
          ...state,
          items: state.items.filter((item) => item.key !== key),
        };
        emit();
      },
      retry: async (key: string) => {
        state = {
          ...state,
          items: state.items.map((item) =>
            item.key === key ? { ...item, phase: "ready" } : item,
          ),
        };
        emit();
      },
      useOriginal: () => {},
      resumeConnection: async () => {},
      committed: async () => {},
      abandon: async () => {
        h.abandoned++;
      },
    };
  },
}));
import {
  CommentImageComposerControls,
  useCommentImageComposer,
} from "./comment-image-composer";
import type { CommentImageComposer } from "./comment-image-composer";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement, current: CommentImageComposer;
function Host({
  orientation = "horizontal",
  owner = h.account,
  scope = "feed:synthetic",
  revalidating = false,
  active = true,
}: {
  orientation?: "horizontal" | "vertical";
  owner?: string;
  scope?: string;
  revalidating?: boolean;
  active?: boolean;
}) {
  const [draft, setDraft] = useState("甲乙");
  const box = useRef<HTMLTextAreaElement>(null);
  const composer = useCommentImageComposer({
    accountId: owner,
    scopeKey: scope,
    text: draft,
    revalidating,
  });
  current = composer;
  return (
    <>
      <textarea
        ref={box}
        aria-label="正文"
        value={draft}
        onSelect={() => composer.captureSelection(box.current)}
        onChange={(event) => {
          composer.textChanged(draft, event.currentTarget.value);
          setDraft(event.currentTarget.value);
        }}
      />
      <CommentImageComposerControls
        composer={composer}
        active={active}
        editorRef={box}
        orientation={orientation}
        onOpenChange={(open) => h.openChanges.push(open)}
        renderPreview={({ text, images }) => (
          <span data-preview="">
            {text}|{images.map(({ offset }) => offset).join(",")}
          </span>
        )}
      />
    </>
  );
}
const render = (
  orientation: "horizontal" | "vertical" = "horizontal",
  strict = false,
) =>
  act(() =>
    root.render(
      strict ? (
        <StrictMode>
          <Host orientation={orientation} />
        </StrictMode>
      ) : (
        <Host orientation={orientation} />
      ),
    ),
  );
const button = (label: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (n) => n.getAttribute("aria-label") === label || n.textContent === label,
  )!;
const pick = async (count = 1) => {
  await act(async () => button("添加图片").click());
  await act(async () => {
    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", {
      configurable: true,
      value: Array.from(
        { length: count },
        () => new File(["synthetic"], "synthetic.png", { type: "image/png" }),
      ),
    });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
};
const click = async (label: string) => act(async () => button(label).click());
beforeEach(() => {
  h.account = "user-00000000000000000000000000000001";
  h.epoch = 0;
  h.created = 0;
  h.abandoned = 0;
  h.serial = 0;
  h.phase = "ready";
  h.openChanges = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("comment image composer controls", () => {
  it("keeps an already opened native input alive through revalidation, queues its files and preserves the caret", async () => {
    render();
    const box = container.querySelector("textarea")!;
    box.setSelectionRange(1, 1);
    await click("添加图片");
    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]')!;
    act(() => root.render(<Host revalidating />));
    expect(container.querySelector('input[type="file"]')).toBe(input);
    expect(input.disabled).toBe(false);
    expect(button("添加图片").disabled).toBe(true);
    await act(async () => {
      Object.defineProperty(input, "files", {
        configurable: true,
        value: [
          new File(["synthetic"], "synthetic.png", { type: "image/png" }),
        ],
      });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(h.created).toBe(0);
    await act(async () => root.render(<Host />));
    expect(h.created).toBe(1);
    expect(current.items[0]?.offset).toBe(1);
  });

  it("ends picker busy state on native cancellation without dropping text", async () => {
    render();
    await click("添加图片");
    expect(current.picking).toBe(true);
    act(() =>
      container
        .querySelector('input[type="file"]')!
        .dispatchEvent(new Event("cancel", { bubbles: true })),
    );
    expect(current.picking).toBe(false);
    expect(current.mutating).toBe(false);
    expect(container.querySelector("textarea")?.value).toBe("甲乙");
  });
  it("keeps the original textarea and insertion caret and rebases the preview after typing", async () => {
    render();
    const box = container.querySelector("textarea")!;
    box.focus();
    box.setSelectionRange(1, 1);
    const down = new MouseEvent("mousedown", {
      button: 0,
      bubbles: true,
      cancelable: true,
    });
    act(() => button("添加图片").dispatchEvent(down));
    expect(down.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(box);
    await pick();
    expect(container.querySelector("[data-preview]")?.textContent).toBe(
      "甲乙|1",
    );
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(box, "前甲乙");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelector("[data-preview]")?.textContent).toBe(
      "前甲乙|2",
    );
    expect(container.querySelectorAll("textarea")).toHaveLength(1);
    expect(container.querySelector('[type="submit"]')).toBeNull();
  });

  it("offers retry without discarding the current text or other ready images", async () => {
    h.phase = "failed";
    render();
    container.querySelector("textarea")!.setSelectionRange(2, 2);
    await pick();
    expect(current.ready).toBe(false);
    expect(container.textContent).toContain("上传未完成，请重试");
    await click("重试图片 1");
    expect(current.ready).toBe(true);
    expect(container.querySelector("textarea")?.value).toBe("甲乙");
    expect(container.querySelector("[data-preview]")?.textContent).toBe(
      "甲乙|2",
    );
  });

  it("keeps a vertical management panel separate from the text field and closes only the panel on Escape", async () => {
    render("vertical");
    await pick();
    const panel = document.body.querySelector<HTMLElement>(
      "[data-comment-image-panel]",
    )!;
    expect(panel).not.toBeNull();
    expect(button("管理附图，共 1 张").getAttribute("aria-expanded")).toBe(
      "true",
    );
    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    act(() => panel.dispatchEvent(escape));
    expect(escape.defaultPrevented).toBe(true);
    expect(
      document.body.querySelector("[data-comment-image-panel]"),
    ).toBeNull();
    expect(current.items).toHaveLength(1);
    expect(h.abandoned).toBe(0);
    expect(h.openChanges).toEqual([true, false]);
  });

  it("uses labeled symbols and keeps the portaled tray out of a hidden host", async () => {
    render("vertical");
    await pick(2);
    const panel = document.body.querySelector<HTMLElement>(
      "[data-comment-image-panel]",
    )!;
    expect(container.contains(panel)).toBe(false);
    expect(panel.getAttribute("aria-label")).toBe("附图管理");
    expect(button("移除图片 1").textContent).toBe("");
    expect(button("图片 1 在当前位置向前移").disabled).toBe(true);
    expect(button("图片 1 在当前位置向后移").disabled).toBe(false);
    expect(panel.textContent).not.toContain("先在输入框定位光标");
    expect(panel.querySelector("[data-preview]")).toBeNull();
    await click("预览发送效果");
    expect(panel.querySelector("[data-preview]")).not.toBeNull();
    act(() => root.render(<Host orientation="vertical" active={false} />));
    expect(
      document.body.querySelector("[data-comment-image-panel]"),
    ).toBeNull();
    expect(current.items).toHaveLength(2);
    act(() => root.render(<Host orientation="vertical" />));
    expect(
      document.body.querySelector("[data-comment-image-panel]"),
    ).toBeNull();
    expect(h.openChanges).toEqual([true, false]);
  });

  it.each(["hidden", "inert", "aria-hidden"])(
    "dismisses a portal when its retained parent becomes %s",
    async (attribute) => {
      render("vertical");
      await pick();
      expect(
        document.body.querySelector("[data-comment-image-panel]"),
      ).not.toBeNull();
      await act(async () =>
        container.setAttribute(
          attribute,
          attribute === "aria-hidden" ? "true" : "",
        ),
      );
      expect(
        document.body.querySelector("[data-comment-image-panel]"),
      ).toBeNull();
      expect(current.items).toHaveLength(1);
      expect(h.openChanges).toEqual([true, false]);
    },
  );

  it("releases the writing layout when the last photo is removed", async () => {
    render("vertical");
    await pick();
    await click("移除图片 1");
    expect(
      document.body.querySelector("[data-comment-image-panel]"),
    ).toBeNull();
    expect(h.openChanges).toEqual([true, false]);
    expect(container.querySelector("textarea")?.value).toBe("甲乙");
  });

  it("follows the visual viewport above the keyboard and cleans up its listeners", async () => {
    const viewport = new EventTarget() as EventTarget & {
      height: number;
      offsetTop: number;
    };
    viewport.height = 420;
    viewport.offsetTop = 20;
    vi.stubGlobal("visualViewport", viewport);
    try {
      render("vertical");
      await pick();
      const panel = document.body.querySelector<HTMLElement>(
        "[data-comment-image-panel]",
      )!;
      expect(panel.style.maxHeight).toBe("168px");
      expect(panel.style.bottom).toContain(`${window.innerHeight - 440}px`);
      act(() => {
        viewport.height = 600;
        viewport.dispatchEvent(new Event("resize"));
      });
      expect(panel.style.maxHeight).toBe("240px");
      await click("收起附图面板");
      expect(
        document.body.querySelector("[data-comment-image-panel]"),
      ).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("locks picker and image actions during a send and unlocks after an unconfirmed result", async () => {
    render();
    await pick();
    let ticket!: ReturnType<CommentImageComposer["prepareSubmission"]>;
    act(() => {
      ticket = current.prepareSubmission("root");
    });
    expect(button("移除图片 1").disabled).toBe(true);
    expect(button("添加图片").disabled).toBe(true);
    await act(async () => ticket!.finish(false));
    expect(button("移除图片 1").disabled).toBe(false);
    expect(current.items).toHaveLength(1);
  });

  it("survives StrictMode's effect replay without creating an idle uploader or disposing the selected one early", async () => {
    render("horizontal", true);
    expect(h.created).toBe(0);
    await pick();
    expect(h.created).toBe(1);
    expect(current.ready).toBe(true);
    expect(h.abandoned).toBe(0);
  });

  it("removes a previous account's previews and open panel before the new account can use them", async () => {
    render("vertical");
    await pick();
    h.account = "user-00000000000000000000000000000002";
    h.epoch++;
    act(() => root.render(<Host orientation="vertical" owner={h.account} />));
    expect(current.items).toHaveLength(0);
    expect(container.querySelector("[data-preview]")).toBeNull();
    expect(
      document.body.querySelector("[data-comment-image-panel]"),
    ).toBeNull();
    expect(h.abandoned).toBe(1);
  });
});
