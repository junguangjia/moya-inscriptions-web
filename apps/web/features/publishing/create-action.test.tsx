// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { author, shell, progress, upload } = vi.hoisted(() => ({
  author: {
    checking: false,
    viewer: null as { id: string } | null,
    signInHref: "/dev/community",
  },
  shell: { openEditor: vi.fn(), openProfile: vi.fn() },
  progress: { current: null as unknown },
  upload: { current: null as unknown },
}));
vi.mock("../authors/author-context", () => ({ useAuthors: () => author }));
vi.mock("../product-shell/product-shell", () => ({
  useProductShell: () => shell,
}));
// The selector's rule is covered with the real runtime in publishing-provider.test.tsx.
vi.mock("./publishing-provider", () => ({
  useGlobalUploadProgress: () => progress.current,
  useUploadSession: () => upload.current,
}));

import { CreateWorkAction, createActionRing } from "./create-action";
import { PublishingEntryProvider } from "./publishing-entry";

import type { Root } from "react-dom/client";
import type { EditorTarget } from "../product-shell/product-history";
import type { useGlobalUploadProgress } from "./publishing-provider";
import type { EditorSessionView } from "./publishing-runtime";
import type {
  UploadItemPhase,
  UploadItemView,
  UploadManagerSnapshot,
  UploadSummary,
} from "./upload-manager";

type Progress = ReturnType<typeof useGlobalUploadProgress>;

interface UploadSessionDouble {
  readonly session: EditorSessionView | null;
  readonly autosave: { readonly draftId: string | null } | null;
  readonly uploads: UploadManagerSnapshot | null;
}

const sessionView = (
  target: EditorTarget,
  overrides: Partial<EditorSessionView> = {},
): EditorSessionView => ({
  target,
  threadId: null,
  saveMode: "saved",
  draftId: null,
  sessionId: null,
  workId: null,
  baseRevisionId: null,
  hasContent: true,
  ...overrides,
});

const item = (
  key: string,
  phase: UploadItemPhase,
  byteSize = 100,
  bytesSent = 0,
): UploadItemView => ({
  key,
  kind: "static",
  qualityMode: "standard",
  notCameraOriginal: false,
  phase,
  itemId: null,
  components: [
    {
      role: "still",
      contentType: null,
      byteSize,
      bytesSent,
      standardOutcome: null,
      phase: phase === "ready" ? "received" : "uploading",
      failure: null,
    },
  ],
  failure: null,
  choice: null,
  recoverable: false,
  serverItem: null,
});

const snapshot = (items: UploadItemView[]): UploadManagerSnapshot => ({
  accountId: `user-${"a".repeat(32)}`,
  status: "active",
  pauseReason: null,
  items,
});

const summary = (overrides: Partial<UploadSummary>): UploadSummary => ({
  total: 0,
  preparing: 0,
  needsChoice: 0,
  queued: 0,
  uploading: 0,
  uploaded: 0,
  processing: 0,
  ready: 0,
  failed: 0,
  paused: 0,
  missingLocal: 0,
  bytesSent: 0,
  bytesTotal: 0,
  active: false,
  unfinished: false,
  blocking: 0,
  ...overrides,
});

const idle: Progress = {
  target: null,
  active: false,
  paused: false,
  itemCount: 0,
  fraction: 0,
  summary: null,
  readiness: null,
  hasUnsavedChanges: false,
};

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const roots: Root[] = [];
const render = (withProvider = true) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() =>
    root.render(
      withProvider ? (
        <PublishingEntryProvider>
          <CreateWorkAction />
        </PublishingEntryProvider>
      ) : (
        <CreateWorkAction />
      ),
    ),
  );
  const button = container.querySelector<HTMLButtonElement>(
    "[data-create-work-action]",
  );
  if (button === null) throw new Error("Missing create action");
  return button;
};
const rerender = (next: Progress) => {
  progress.current = next;
  const root = roots.at(-1)!;
  act(() =>
    root.render(
      <PublishingEntryProvider>
        <CreateWorkAction />
      </PublishingEntryProvider>,
    ),
  );
};

const noSession: UploadSessionDouble = {
  session: null,
  autosave: null,
  uploads: null,
};

beforeEach(() => {
  author.checking = false;
  author.viewer = null;
  progress.current = idle;
  upload.current = noSession;
});
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe("CreateWorkAction", () => {
  it("is one labelled plus action instead of the dock Search trigger", () => {
    const button = render();
    expect(button.getAttribute("aria-label")).toBe("发布作品");
    expect(button.type).toBe("button");
    const icon = button.querySelector("svg[data-create-work-icon]");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(icon?.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(icon?.querySelector("path")?.getAttribute("d")).toBe(
      "M12 5v14m-7-7h14",
    );
    // No shared UI icon name is needed, so the frozen icon set is unchanged.
    expect(button.querySelector(".yoyi-icon")).toBeNull();
    expect(button.hasAttribute("data-search-trigger")).toBe(false);
    expect(button.querySelector('[data-icon="search"]')).toBeNull();
  });

  it("opens a new work editor for a signed-in author", () => {
    author.viewer = { id: `user-${"a".repeat(32)}` };
    const button = render();
    act(() => button.click());
    expect(shell.openEditor).toHaveBeenCalledExactlyOnceWith(
      { type: "new" },
      button,
    );
    expect(shell.openProfile).not.toHaveBeenCalled();
  });

  it("sends a guest to the existing sign-in center instead of an editor", () => {
    const button = render();
    act(() => button.click());
    expect(shell.openProfile).toHaveBeenCalledExactlyOnceWith(null, button);
    expect(shell.openEditor).not.toHaveBeenCalled();
  });

  it("waits for the session check before acting", () => {
    author.checking = true;
    const button = render();
    expect(button.disabled).toBe(true);
    act(() => button.click());
    expect(shell.openEditor).not.toHaveBeenCalled();
    expect(shell.openProfile).not.toHaveBeenCalled();
  });

  it("exists only inside the publishing composition", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(false)).toThrow(
      "Publishing entry requires its provider",
    );
  });
  it("shows no ring or count while no editor session is kept", () => {
    author.viewer = { id: `user-${"a".repeat(32)}` };
    const button = render();
    expect(button.querySelector("[data-create-work-ring]")).toBeNull();
    expect(button.querySelector("[data-create-work-count]")).toBeNull();
    expect(button.hasAttribute("data-create-work-progress")).toBe(false);
    expect(button.getAttribute("aria-label")).toBe("发布作品");
    act(() => button.click());
    expect(shell.openEditor).toHaveBeenCalledExactlyOnceWith(
      { type: "new" },
      button,
    );
  });

  it("carries the ring and unfinished count on the same action and returns to that editor", () => {
    author.viewer = { id: `user-${"a".repeat(32)}` };
    const target = { type: "work", id: `work-${"b".repeat(32)}` } as const;
    upload.current = {
      session: sessionView(target, { workId: target.id }),
      autosave: null,
      uploads: snapshot([
        item("a", "uploading", 100, 40),
        item("b", "queued", 100, 0),
        item("c", "ready", 800, 0),
      ]),
    } satisfies UploadSessionDouble;
    progress.current = {
      ...idle,
      target,
      active: true,
      itemCount: 3,
      fraction: 0.9,
      summary: summary({
        total: 3,
        uploading: 1,
        queued: 1,
        ready: 1,
        active: true,
        unfinished: true,
        blocking: 2,
      }),
      readiness: "2 项仍在上传",
    };
    const button = render();
    const container = button.parentElement!;
    // Still exactly one floating action.
    expect(
      container.querySelectorAll("button[data-create-work-action]"),
    ).toHaveLength(1);
    expect(button.getAttribute("data-create-work-progress")).toBe("active");
    // Only the unfinished transfer counts: 40 of 200 bytes, not the ready item.
    const arc = button.querySelector("[data-create-work-ring-fraction]");
    expect(arc?.getAttribute("stroke-dasharray")).toBe("20 100");
    expect(button.querySelector("[data-create-work-count]")?.textContent).toBe(
      "2",
    );
    expect(button.getAttribute("aria-label")).toBe(
      "返回正在编辑的作品：2 项仍在上传",
    );
    expect(
      container.querySelector("[data-create-work-status]")?.textContent,
    ).toBe("2 项仍在上传");
    act(() => button.click());
    expect(shell.openEditor).toHaveBeenCalledExactlyOnceWith(target, button);
  });

  it("keeps the entry for unsaved changes without an arc, and still returns once the session settles", () => {
    author.viewer = { id: `user-${"a".repeat(32)}` };
    const target = {
      type: "draft",
      id: `work-draft-${"c".repeat(32)}`,
    } as const;
    upload.current = {
      session: sessionView(target, { draftId: target.id }),
      autosave: { draftId: target.id },
      uploads: snapshot([]),
    } satisfies UploadSessionDouble;
    progress.current = {
      ...idle,
      target,
      active: true,
      hasUnsavedChanges: true,
    };
    const button = render();
    expect(
      button
        .querySelector("[data-create-work-ring]")
        ?.getAttribute("data-create-work-ring"),
    ).toBe("track");
    expect(button.querySelector("[data-create-work-ring-arc]")).toBeNull();
    expect(button.querySelector("[data-create-work-count]")).toBeNull();
    expect(button.getAttribute("aria-label")).toBe(
      "返回正在编辑的作品：有未保存的更改",
    );

    // Uploads finished and autosave settled; the kept session is still open.
    rerender({ ...idle, target });
    expect(button.querySelector("[data-create-work-ring]")).toBeNull();
    expect(button.hasAttribute("data-create-work-progress")).toBe(false);
    expect(button.getAttribute("aria-label")).toBe("返回正在编辑的作品");
    act(() => button.click());
    expect(shell.openEditor).toHaveBeenCalledExactlyOnceWith(target, button);
  });

  it("returns a new work that gained a draft to that draft", () => {
    author.viewer = { id: `user-${"a".repeat(32)}` };
    const draftId = `work-draft-${"d".repeat(32)}`;
    upload.current = {
      session: sessionView({ type: "new" }, { draftId: null }),
      autosave: { draftId },
      uploads: snapshot([item("a", "processing")]),
    } satisfies UploadSessionDouble;
    progress.current = {
      ...idle,
      target: { type: "new" },
      active: true,
      summary: summary({ total: 1, processing: 1, blocking: 1 }),
      readiness: "1 项正在处理",
    };
    const button = render();
    act(() => button.click());
    expect(shell.openEditor).toHaveBeenCalledExactlyOnceWith(
      { type: "draft", id: draftId },
      button,
    );

    // A no-save session has no draft: it stays a new work.
    shell.openEditor.mockClear();
    upload.current = {
      session: sessionView({ type: "new" }, { saveMode: "unsaved" }),
      autosave: null,
      uploads: snapshot([item("a", "uploading", 100, 10)]),
    } satisfies UploadSessionDouble;
    rerender(progress.current as Progress);
    act(() => button.click());
    expect(shell.openEditor).toHaveBeenCalledExactlyOnceWith(
      { type: "new" },
      button,
    );
  });
});

describe("createActionRing", () => {
  it("measures only transfers of unfinished items and draws no empty arc", () => {
    expect(createActionRing(null)).toEqual({ kind: "track" });
    // Ready items alone: nothing to measure.
    expect(createActionRing(snapshot([item("a", "ready", 900, 900)]))).toEqual({
      kind: "track",
    });
    // 100 % transferred but still processing is not shown as done.
    expect(
      createActionRing(
        snapshot([item("a", "uploaded", 100, 100), item("b", "processing")]),
      ),
    ).toEqual({ kind: "indeterminate" });
    expect(createActionRing(snapshot([item("a", "preprocessing")]))).toEqual({
      kind: "indeterminate",
    });
    // A transfer that has not sent anything yet has no arc to draw.
    expect(createActionRing(snapshot([item("a", "queued", 100, 0)]))).toEqual({
      kind: "indeterminate",
    });
    expect(
      createActionRing(
        snapshot([
          item("a", "uploading", 300, 150),
          item("b", "ready", 5000, 5000),
          item("c", "processing"),
        ]),
      ),
    ).toEqual({ kind: "determinate", fraction: 0.5 });
  });
});
