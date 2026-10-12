// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { author, shell, progress, upload, account, client } = vi.hoisted(() => ({
  author: {
    checking: false,
    sessionError: false,
    viewer: null as { id: string } | null,
    signInHref: "/dev/community",
    notify: vi.fn<(text: string) => void>(),
    cache: { set: vi.fn<(key: string, value: unknown) => void>() },
  },
  shell: {
    openEditor: vi.fn(),
    openProfile: vi.fn(),
    platform: "pc" as PresentationPlatform,
  },
  progress: { current: null as unknown },
  upload: { current: null as unknown },
  account: { epoch: 1 },
  client: {
    create:
      vi.fn<(command: CreateArticleDraftCommand) => Promise<ArticleDraft>>(),
  },
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
// The account fence the 专题文章 creation checks: the signed-in viewer.
vi.mock(
  "../../lib/public-api/author-community-client",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../lib/public-api/author-community-client")
    >()),
    authorClient: {
      account: () => author.viewer?.id ?? null,
      accountEpoch: () => account.epoch,
    },
  }),
);
vi.mock(
  "../../lib/public-api/article-authoring-client",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../lib/public-api/article-authoring-client")
    >()),
    articleAuthoringClient: client,
  }),
);

import { ArticleRequestError } from "../../lib/public-api/article-authoring-client";
import { ArticleAvailability } from "../editorial-content/article-authoring/article-availability";
import { ArticleCreateEntry } from "../editorial-content/article-authoring/article-create-entry";
import { CreateWorkAction, createActionRing } from "./create-action";
import { PublishingEntryProvider } from "./publishing-entry";

import type { ArticleDraft, CreateArticleDraftCommand } from "@moya/contracts";
import type { ComponentProps } from "react";
import type { Root } from "react-dom/client";
import type { EditorTarget } from "../product-shell/product-history";
import type { PresentationPlatform } from "../shell/device-platform";
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
const render = (
  withProvider = true,
  props: ComponentProps<typeof CreateWorkAction> = {},
) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() =>
    root.render(
      withProvider ? (
        <PublishingEntryProvider>
          <CreateWorkAction {...props} />
        </PublishingEntryProvider>
      ) : (
        <CreateWorkAction {...props} />
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
  shell.platform = "pc";
  // The shell reports whether the editor opened.
  shell.openEditor.mockReturnValue(true);
  progress.current = idle;
  upload.current = noSession;
  account.epoch = 1;
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

const OWNER = `user-${"a".repeat(32)}`;
const ARTICLE_ID = `article-${"e".repeat(32)}`;

/** The 发布内容 composition (articles enabled unless said otherwise). */
const renderEntry = (articles = true) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() =>
    root.render(
      <PublishingEntryProvider>
        <ArticleAvailability enabled={articles}>
          <ArticleCreateEntry />
        </ArticleAvailability>
      </PublishingEntryProvider>,
    ),
  );
  const plus = container.querySelector<HTMLButtonElement>(
    "[data-create-work-action]",
  );
  if (plus === null) throw new Error("Missing create action");
  return { container, plus };
};
/** The 发布内容 dialog's choices, in order. */
const choices = () =>
  [...document.querySelectorAll<HTMLButtonElement>("dialog button")].map(
    (button) => button.textContent,
  );
/** One of the open 发布内容 dialog's choices, by its label. */
const choice = (label: string) => {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>("dialog button"),
  ].find((button) => button.textContent === label);
  if (found === undefined) throw new Error(`Missing ${label} choice`);
  return found;
};
/** Lets a create's answer reach the dialog. */
const flushAnswer = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

describe("the dock + by layout (#244 r4)", () => {
  it("opens the editor straight on its start screen on a phone with articles", () => {
    author.viewer = { id: OWNER };
    shell.platform = "phone";
    const click = vi
      .spyOn(HTMLInputElement.prototype, "click")
      .mockImplementation(() => undefined);
    try {
      const { container, plus } = renderEntry();
      expect(plus.getAttribute("aria-label")).toBe("发布内容");
      act(() => plus.click());
      expect(shell.openEditor).toHaveBeenCalledExactlyOnceWith(
        { type: "new" },
        plus,
      );
      expect(document.querySelector("dialog")).toBeNull();
      // No picker opens from the dock: the start screen's 选择照片 does.
      expect(click).not.toHaveBeenCalled();
      expect(container.querySelector('input[type="file"]')).toBeNull();
    } finally {
      click.mockRestore();
    }
  });

  it("keeps the 发布内容 dialog on the desktop layout, whose 作品 opens a new work", () => {
    author.viewer = { id: OWNER };
    // jsdom's 1024px window makes a tablet the wide, desktop editor.
    for (const platform of ["pc", "tablet"] as const) {
      shell.platform = platform;
      shell.openEditor.mockClear();
      const { plus } = renderEntry();
      act(() => plus.click());
      expect(shell.openEditor).not.toHaveBeenCalled();
      expect(document.querySelector("dialog h2")?.textContent).toBe("发布内容");
      expect(choices()).toEqual(["作品", "专题文章", "草稿箱"]);
      act(() => choice("作品").click());
      expect(document.querySelector("dialog")).toBeNull();
      expect(shell.openEditor).toHaveBeenCalledExactlyOnceWith(
        { type: "new" },
        plus,
      );
    }
  });

  it("sends a guest to the sign-in center on both layouts", () => {
    for (const platform of ["phone", "pc"] as const) {
      shell.platform = platform;
      shell.openProfile.mockClear();
      const { plus } = renderEntry();
      act(() => plus.click());
      expect(shell.openProfile).toHaveBeenCalledExactlyOnceWith(null, plus);
      expect(document.querySelector("dialog")).toBeNull();
    }
    expect(shell.openEditor).not.toHaveBeenCalled();
  });

  it("waits for the session check on both layouts", () => {
    author.viewer = { id: OWNER };
    author.checking = true;
    for (const platform of ["phone", "pc"] as const) {
      shell.platform = platform;
      const { plus } = renderEntry();
      expect(plus.disabled).toBe(true);
      act(() => plus.click());
    }
    expect(shell.openEditor).not.toHaveBeenCalled();
    expect(shell.openProfile).not.toHaveBeenCalled();
    expect(document.querySelector("dialog")).toBeNull();
  });

  it("returns to a kept session or 参与话题 composer without the dialog on both layouts", () => {
    author.viewer = { id: OWNER };
    const targets: EditorTarget[] = [
      { type: "work", id: `work-${"b".repeat(32)}` },
      { type: "new", threadId: `thread-${"c".repeat(32)}` },
    ];
    for (const platform of ["phone", "pc"] as const)
      for (const target of targets) {
        shell.platform = platform;
        upload.current = {
          session: sessionView(target, { saveMode: "unsaved" }),
          autosave: null,
          uploads: snapshot([]),
        } satisfies UploadSessionDouble;
        const { plus } = renderEntry();
        expect(plus.getAttribute("aria-label")).toBe("返回正在编辑的作品");
        act(() => plus.click());
        expect(shell.openEditor).toHaveBeenLastCalledWith(target, plus);
        expect(document.querySelector("dialog")).toBeNull();
      }
    expect(shell.openEditor).toHaveBeenCalledTimes(4);
  });

  it("opens a new work from the plain plus when articles are off, on both layouts", () => {
    author.viewer = { id: OWNER };
    for (const platform of ["phone", "pc"] as const) {
      shell.platform = platform;
      shell.openEditor.mockClear();
      const { plus } = renderEntry(false);
      expect(plus.getAttribute("aria-label")).toBe("发布作品");
      act(() => plus.click());
      expect(document.querySelector("dialog")).toBeNull();
      expect(shell.openEditor).toHaveBeenCalledExactlyOnceWith(
        { type: "new" },
        plus,
      );
    }
  });
});

describe("the desktop 发布内容 dialog's 专题文章", () => {
  const created = (): ArticleDraft => ({
    id: ARTICLE_ID as ArticleDraft["id"],
    ownerId: OWNER as ArticleDraft["ownerId"],
    title: "",
    coverRefId: null,
    document: {
      format: "blocknote",
      version: 1,
      blocks: [],
      references: {},
      galleries: {},
    },
    version: 1,
    status: "draft",
    publicVersion: null,
    updatedAt: "2026-10-10T00:00:00Z",
    fingerprint: "a".repeat(64),
  });
  const deferred = <Value,>() => {
    let resolve!: (value: Value) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<Value>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  };
  const requestIds = () =>
    client.create.mock.calls.map(([command]) => command.requestId);
  /** The plus with the 发布内容 dialog open on the desktop layout. */
  const openDialog = () => {
    author.viewer = { id: OWNER };
    shell.platform = "pc";
    const entry = renderEntry();
    act(() => entry.plus.click());
    return entry;
  };
  const alert = () =>
    document.querySelector('dialog [role="alert"]')?.textContent ?? null;

  it("opens the profile, then the new draft's editor, and closes", async () => {
    const { plus } = openDialog();
    client.create.mockResolvedValueOnce(created());
    act(() => choice("专题文章").click());
    await flushAnswer();
    expect(author.cache.set).toHaveBeenCalledExactlyOnceWith(
      `drafts-box-return:${OWNER}`,
      "article",
    );
    expect(shell.openProfile).toHaveBeenCalledExactlyOnceWith(null, plus);
    expect(shell.openEditor).toHaveBeenCalledExactlyOnceWith(
      { type: "article-draft", id: ARTICLE_ID },
      plus,
    );
    const [set] = author.cache.set.mock.invocationCallOrder;
    const [profile] = shell.openProfile.mock.invocationCallOrder;
    const [editor] = shell.openEditor.mock.invocationCallOrder;
    expect(set).toBeLessThan(profile!);
    expect(profile).toBeLessThan(editor!);
    expect(document.querySelector("dialog")).toBeNull();
    expect(author.notify).not.toHaveBeenCalled();
    const [command] = client.create.mock.calls[0]!;
    expect(command).toMatchObject({ title: "", coverRefId: null });
  });

  it("points to the draft box when the shell refuses the editor", async () => {
    openDialog();
    client.create.mockResolvedValueOnce(created());
    shell.openEditor.mockReturnValueOnce(false);
    act(() => choice("专题文章").click());
    await flushAnswer();
    expect(author.notify).toHaveBeenCalledExactlyOnceWith(
      "专题草稿已创建，请从草稿箱继续编辑。",
    );
    expect(document.querySelector("dialog")).toBeNull();
  });

  it("confirms the same creation after an unknown outcome", async () => {
    const { plus } = openDialog();
    client.create.mockRejectedValueOnce(
      new ArticleRequestError(504, null, true),
    );
    act(() => choice("专题文章").click());
    await flushAnswer();
    expect(alert()).toBe("创建结果尚未确认，重试会确认同一次创建。");
    expect(choices()).toEqual(["作品", "重试确认创建", "草稿箱"]);
    expect(shell.openEditor).not.toHaveBeenCalled();

    client.create.mockResolvedValueOnce(created());
    act(() => choice("重试确认创建").click());
    await flushAnswer();
    const [first, second] = requestIds();
    expect(second).toBe(first);
    expect(shell.openEditor).toHaveBeenCalledExactlyOnceWith(
      { type: "article-draft", id: ARTICLE_ID },
      plus,
    );
  });

  it("starts a new creation after a refusal", async () => {
    openDialog();
    client.create.mockRejectedValueOnce(
      new ArticleRequestError(422, "article_invalid", false),
    );
    act(() => choice("专题文章").click());
    await flushAnswer();
    expect(alert()).toBe("暂时无法创建专题文章，请重试。");
    expect(choices()).toEqual(["作品", "专题文章", "草稿箱"]);

    client.create.mockResolvedValueOnce(created());
    act(() => choice("专题文章").click());
    await flushAnswer();
    const [first, second] = requestIds();
    expect(second).not.toBe(first);
  });

  it("holds the dialog and every choice while creating", async () => {
    openDialog();
    const pending = deferred<ArticleDraft>();
    client.create.mockReturnValueOnce(pending.promise);
    act(() => choice("专题文章").click());
    expect(choices()).toEqual(["作品", "正在创建…", "草稿箱"]);
    for (const button of document.querySelectorAll<HTMLButtonElement>(
      "dialog button",
    ))
      expect(button.disabled).toBe(true);
    // Escape (the dialog's cancel) keeps it open.
    const dialog = document.querySelector("dialog")!;
    act(() => {
      dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    });
    expect(document.querySelector("dialog")).toBe(dialog);

    pending.reject(new ArticleRequestError(504, null, true));
    await flushAnswer();
    expect(choices()).toEqual(["作品", "重试确认创建", "草稿箱"]);
    // Cancellable again once the answer is in.
    act(() => {
      dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    });
    expect(document.querySelector("dialog")).toBeNull();
  });

  it("tells the author where the draft is when the opener left before the answer", async () => {
    const { container } = openDialog();
    const pending = deferred<ArticleDraft>();
    client.create.mockReturnValueOnce(pending.promise);
    act(() => choice("专题文章").click());
    // The dock (and the plus with it) left the page meanwhile.
    container.remove();
    pending.resolve(created());
    await flushAnswer();
    expect(author.notify).toHaveBeenCalledExactlyOnceWith(
      "专题草稿已创建，请从个人页的草稿箱继续编辑。",
    );
    expect(author.cache.set).not.toHaveBeenCalled();
    expect(shell.openProfile).not.toHaveBeenCalled();
    expect(shell.openEditor).not.toHaveBeenCalled();
  });

  it("opens the own profile's draft box from 草稿箱", () => {
    const { plus } = openDialog();
    act(() => choice("草稿箱").click());
    expect(author.cache.set).toHaveBeenCalledExactlyOnceWith(
      `drafts-box-return:${OWNER}`,
      "article",
    );
    expect(shell.openProfile).toHaveBeenCalledExactlyOnceWith(null, plus);
    expect(shell.openEditor).not.toHaveBeenCalled();
    expect(document.querySelector("dialog")).toBeNull();
    expect(client.create).not.toHaveBeenCalled();
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
