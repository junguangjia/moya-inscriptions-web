// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { author, shell, client, versions, articles } = vi.hoisted(() => ({
  author: {
    checking: false,
    viewer: null as { id: string; displayName: string } | null,
    signInHref: "/dev/community",
    notify: (() => undefined) as (text: string) => void,
  },
  shell: {
    platform: "phone" as "phone" | "tablet" | "pc",
    orientation: "portrait" as "portrait" | "landscape",
  },
  client: {} as Record<string, unknown>,
  /** What the drafts panels (C3) hand back when the author chooses. */
  versions: {
    resolve: null as
      | ((
          choice: "device" | "account",
        ) => import("@moya/contracts").PublishingDraft)
      | null,
    restored: null as import("@moya/contracts").PublishingDraft | null,
    /** History's latest restore callback, to answer after something changed. */
    onRestored: null as
      ((draft: import("@moya/contracts").PublishingDraft) => void) | null,
  },
  /** 专题文章's create (r4 D3) and the account fence it is checked against. */
  articles: {
    create: (() => Promise.reject(new Error("unset"))) as (
      command: import("@moya/contracts").CreateArticleDraftCommand,
    ) => Promise<unknown>,
    epoch: 1,
  },
}));

vi.mock("../../../authors/author-context", () => ({
  useAuthors: () => author,
}));
vi.mock("../../../authors/author-data", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../../authors/author-data")>();
  return {
    ...original,
    authorClient: {
      ...original.authorClient,
      account: () => author.viewer?.id ?? null,
    },
  };
});
// The 专题 create and its account fence (use-article-draft-creation.ts).
vi.mock(
  "../../../../lib/public-api/author-community-client",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("../../../../lib/public-api/author-community-client")
      >();
    return {
      ...original,
      authorClient: {
        ...original.authorClient,
        account: () => author.viewer?.id ?? null,
        accountEpoch: () => articles.epoch,
      },
    };
  },
);
vi.mock(
  "../../../../lib/public-api/article-authoring-client",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("../../../../lib/public-api/article-authoring-client")
      >();
    return {
      ...original,
      articleAuthoringClient: {
        ...original.articleAuthoringClient,
        create: (
          command: import("@moya/contracts").CreateArticleDraftCommand,
        ) => articles.create(command),
      },
    };
  },
);
vi.mock("../../../product-shell/product-shell", () => ({
  useProductShell: () => shell,
}));
vi.mock("../../publishing-data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../publishing-data")>()),
  publishingClient: client,
}));
// The desktop media section (C1b) and the drafts panels (C3) have their
// own tests; the phone screens draw their own media.
vi.mock("../media/media-section", () => ({
  MediaSection: ({
    sessionKey,
    onSkip,
  }: {
    sessionKey: string;
    onSkip?: () => void;
  }) => (
    <div data-media-section={sessionKey}>
      {onSkip ? (
        <button data-media-skip="" onClick={onSkip} type="button">
          跳过，只发布文字
        </button>
      ) : null}
    </div>
  ),
}));
// Stubs with the real callback contract: a choice hands the resulting draft back.
vi.mock("../drafts/history-panel", () => ({
  HistoryPanel: ({
    onRestored,
    onClose,
    onChooseVersion,
  }: {
    onRestored: (draft: import("@moya/contracts").PublishingDraft) => void;
    onClose: () => void;
    onChooseVersion?: () => void;
  }) => {
    versions.onRestored = onRestored;
    return (
      <div data-history-stub="">
        <button
          data-history-restore=""
          onClick={() => onRestored(versions.restored!)}
          type="button"
        >
          恢复为当前编辑
        </button>
        {onChooseVersion === undefined ? null : (
          <button
            data-history-choose-version=""
            onClick={onChooseVersion}
            type="button"
          >
            选择版本
          </button>
        )}
        <button data-history-close="" onClick={onClose} type="button">
          关闭历史版本
        </button>
      </div>
    );
  },
}));
vi.mock("../drafts/conflict-chooser", () => ({
  ConflictChooser: ({
    conflict,
    onResolved,
    onClose,
  }: {
    conflict: { id: string };
    onResolved: (draft: import("@moya/contracts").PublishingDraft) => void;
    onClose: () => void;
  }) => (
    <div data-conflict-stub={conflict.id}>
      <button data-conflict-close="" onClick={onClose} type="button">
        关闭版本选择
      </button>
      <button
        data-choose="device"
        onClick={() => onResolved(versions.resolve!("device"))}
        type="button"
      >
        使用本设备版本
      </button>
      <button
        data-choose="account"
        onClick={() => onResolved(versions.resolve!("account"))}
        type="button"
      >
        使用账号中的版本
      </button>
    </div>
  ),
}));

import { ArticleAvailability } from "../../../editorial-content/article-authoring/article-availability";
import { ARTICLE_DRAFT_ORPHAN_NOTICE } from "../../../editorial-content/article-authoring/use-article-draft-creation";
import { identifyFiles } from "../../import-grouping";
import { fileOf, jpeg } from "../../parsers/synthetic-media.test-support";
import { PublishingProvider, useStagedItems } from "../../publishing-provider";
import {
  ACCOUNT,
  DRAFT_ID,
  SESSION_ID,
  absentMetadata,
  clientError,
  fakeClient,
  fakePreprocess,
  fakeTransfer,
  manualTimers,
  recoveryDouble,
  settle,
  uuid,
} from "../../upload-manager.test-support";
import { EditorOverlay } from "./editor-overlay";
import { EditorSessionProvider } from "./editor-session-provider";

import type {
  PublishingClientPort,
  PublishingServices,
} from "../../publishing-runtime";
import type {
  ProductShellEditorLeaveGuard,
  ProductShellEditorOverlayControls,
} from "../../../product-shell/product-shell";
import type { EditorTarget } from "../../../product-shell/product-history";
import type { LocalRecoveryStore } from "../../local-recovery";
import type {
  EditableWork,
  PublishingDraft,
  PublishingDraftConflict,
  PublishingMediaItem,
  WorkDraftContent,
  WorkDraftItem,
} from "@moya/contracts";
import type { Root } from "react-dom/client";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const T = "2026-09-13T12:00:00.000Z";
const WORK_ID = `work-${"c".repeat(32)}`;
const REVISION_ID = `work-revision-${"f".repeat(32)}`;
const EDIT_DRAFT_ID = `work-draft-${"e".repeat(32)}`;

const emptyContent = (
  change: Partial<WorkDraftContent> = {},
): WorkDraftContent => ({
  title: "",
  body: "",
  authorship: { kind: "original" },
  visibility: "public",
  items: [],
  coverKey: null,
  coverCrop: null,
  ...change,
});

const draftOf = (
  content: WorkDraftContent,
  change: Partial<PublishingDraft> = {},
): PublishingDraft => ({
  id: DRAFT_ID,
  kind: "new",
  workId: null,
  baseRevisionId: null,
  revision: 1,
  content,
  mediaItems: [],
  conflict: null,
  deviceClass: "phone",
  createdAt: T,
  updatedAt: T,
  ...change,
});

/**
 * The account's answer of `POST publishing/works/:workId/draft`: the draft
 * and whether this request inserted it.
 */
const openedDraft = (draft: PublishingDraft, created = true) => ({
  draft,
  created,
});

const receipt = (requestId: string) => ({
  state: "confirmed" as const,
  requestId,
  workId: WORK_ID,
  revisionId: REVISION_ID,
  visibility: "public" as const,
  submittedAt: T,
});

const makeServices = (recovery: LocalRecoveryStore | null = null) => {
  const uploads = fakeClient();
  const transfer = fakeTransfer();
  const timers = manualTimers();
  let revision = 1;
  Object.assign(client, uploads.client, {
    limits: vi.fn(async () => ({
      maxItems: 50,
      originalItemMaxBytes: 1_000_000,
      standardComponentMaxBytes: 1_000_000,
      titleMax: 200,
      bodyMax: 10_000,
    })),
    createSession: vi.fn(async () => ({
      id: SESSION_ID,
      state: "active",
      workId: null,
      leaseExpiresAt: T,
      createdAt: T,
    })),
    heartbeatSession: vi.fn(),
    discardSession: vi.fn(async () => ({ discarded: true })),
    deleteDraft: vi.fn(async () => ({
      deleted: true,
      snapshots: 2,
      conflictCopies: 1,
      mediaItems: 0,
    })),
    createDraft: vi.fn(async (cmd: { content: WorkDraftContent }) =>
      draftOf(cmd.content, { revision }),
    ),
    saveDraft: vi.fn(
      async (id: string, cmd: { content: WorkDraftContent }) => ({
        status: "saved",
        draft: draftOf(cmd.content, { id, revision: (revision += 1) }),
      }),
    ),
    saveDraftNow: vi.fn(
      async (id: string, cmd: { content: WorkDraftContent }) => ({
        status: "saved",
        draft: draftOf(cmd.content, { id, revision: (revision += 1) }),
      }),
    ),
    draft: vi.fn(),
    editableWork: vi.fn(),
    openWorkEditDraft: vi.fn(),
    submit: vi.fn(async (cmd: { requestId: string }) => receipt(cmd.requestId)),
    submissionReceipt: vi.fn(async () => null),
    readiness: vi.fn(async () => ({
      ready: true,
      pendingItemKeys: [],
      failedItemKeys: [],
      editKeys: {},
    })),
  });
  const services: PublishingServices = {
    client: client as unknown as PublishingClientPort,
    currentAccount: () => ACCOUNT,
    requestId: uuid,
    createTransfer: () => transfer.transfer,
    createPreprocess: () => fakePreprocess(),
    createHasher: () => null,
    createRecovery: () => recovery,
    identifyFiles: (files) => identifyFiles(files),
    preprocessConcurrency: () => 1,
    transferConcurrency: 2,
    deviceClass: () => "phone",
    timers: timers.timers,
    metadata: absentMetadata,
  };
  return { services, transfer, timers, uploads };
};

const fn = (name: string) => client[name] as ReturnType<typeof vi.fn>;

const staged: { current: ReturnType<typeof useStagedItems> | null } = {
  current: null,
};
const StagingProbe = () => {
  staged.current = useStagedItems();
  return null;
};

interface Harness {
  readonly container: HTMLDivElement;
  readonly controls: ProductShellEditorOverlayControls & {
    close: ReturnType<typeof vi.fn>;
    completeWith: ReturnType<typeof vi.fn>;
    replaceTarget: ReturnType<typeof vi.fn>;
  };
  readonly guard: () => ProductShellEditorLeaveGuard | null;
  readonly rerender: (target?: EditorTarget) => Promise<void>;
  readonly show: (visible: boolean) => Promise<void>;
  readonly uploads: ReturnType<typeof fakeClient>;
  readonly transfer: ReturnType<typeof fakeTransfer>;
  readonly timers: ReturnType<typeof manualTimers>;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const flush = async () => {
  await act(async () => {
    await settle();
  });
};

/** `prepare` sets client answers before the editor mounts. */
const renderEditor = async (
  target: EditorTarget,
  prepare: () => void = () => undefined,
  options: {
    readonly recovery?: LocalRecoveryStore;
    /** 专题文章 on (production): the start screen offers 专题 and 草稿箱. */
    readonly articles?: boolean;
  } = {},
): Promise<Harness> => {
  const { services, transfer, timers, uploads } = makeServices(
    options.recovery ?? null,
  );
  prepare();
  let guard: ProductShellEditorLeaveGuard | null = null;
  const controls = {
    backButtonRef: createRef<HTMLButtonElement>(),
    close: vi.fn(),
    completeWith: vi.fn(),
    replaceTarget: vi.fn(),
    registerLeaveGuard: vi.fn((next: ProductShellEditorLeaveGuard) => {
      guard = next;
      return () => {
        if (guard === next) guard = null;
      };
    }),
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  let current = target;
  let shown = true;
  const draw = () =>
    root!.render(
      <ArticleAvailability enabled={options.articles ?? false}>
        <PublishingProvider services={services}>
          <EditorSessionProvider>
            <StagingProbe />
            {shown ? (
              <EditorOverlay controls={controls} target={current} />
            ) : null}
          </EditorSessionProvider>
        </PublishingProvider>
      </ArticleAvailability>,
    );
  await act(async () => draw());
  await flush();
  return {
    container,
    controls,
    guard: () => guard,
    rerender: async (next) => {
      if (next) current = next;
      await act(async () => draw());
      await flush();
    },
    show: async (visible) => {
      // The shell unmounts the overlay when the editor entry is left.
      shown = visible;
      await act(async () => draw());
      await flush();
    },
    uploads,
    transfer,
    timers,
  };
};

const query = <E extends Element = HTMLElement>(selector: string) =>
  container!.querySelector<E & HTMLElement>(selector);

const buttonByText = (text: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (button) => button.textContent?.trim() === text,
  ) ?? null;

const click = async (element: HTMLElement | null) => {
  expect(element).not.toBeNull();
  await act(async () => {
    element!.click();
  });
  await flush();
};

const type = async (
  element: HTMLInputElement | HTMLTextAreaElement | null,
  value: string,
) => {
  expect(element).not.toBeNull();
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
      element,
      value,
    );
    element!.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const titleInput = () =>
  query<HTMLInputElement>('input[data-editor-input="title"]');
const bodyInput = () =>
  query<HTMLTextAreaElement>('textarea[data-editor-input="body"]');
/** The phone screen shown (select = the start screen, edit, publish); null on the desktop. */
const screen = () =>
  query("[data-editor-screen]")?.getAttribute("data-editor-screen") ?? null;
/** The session step the phone shows: the start screen and 编辑 assemble, 发布 describes. */
const step = () => {
  const shown = screen();
  return shown === null ? null : shown === "publish" ? "text" : "media";
};
/** The shown phone screen's ‹ (the shell's Back target). */
const phoneBack = () =>
  query<HTMLButtonElement>("[data-editor-screen] [data-editor-bar] > button");
/** 发布's 作品性质 chips. */
const authorshipChips = () =>
  Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      '[data-editor-field="authorship"] [role="radio"]',
    ),
  );
const draftSwitch = () =>
  query<HTMLButtonElement>('[data-editor-switch="drafts"] [role="switch"]');

const saveStatus = () =>
  query("[data-save-status]")?.getAttribute("data-save-status") ?? null;

const setViewport = async (
  platform: "phone" | "tablet" | "pc",
  width: number,
) => {
  shell.platform = platform;
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  });
  await act(async () => {
    window.dispatchEvent(new Event("resize"));
  });
  await flush();
};

const nextFrames = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
};

const leaveOverlay = async (harness: Harness) => {
  await harness.show(false);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  await flush();
};

const conflictOf = (
  device: WorkDraftContent,
  account: WorkDraftContent,
): PublishingDraftConflict => ({
  id: `work-draft-${"9".repeat(32)}`,
  device: {
    content: device,
    baseRevision: 3,
    deviceClass: "phone",
    savedAt: T,
  },
  account: {
    content: account,
    revision: 4,
    deviceClass: "desktop",
    updatedAt: T,
  },
  createdAt: T,
});

/**
 * On to 发布, where the phone describes and submits the work (the old text
 * and confirm steps in one): 跳过 on the start screen, 下一步 on 编辑.
 */
const goToPublish = async () => {
  for (let moves = 0; moves < 3 && screen() !== "publish"; moves += 1)
    await click(
      screen() === "edit"
        ? query("[data-edit-next]")
        : query("[data-media-skip]"),
    );
  expect(screen()).toBe("publish");
};

/** 编辑's current thumbnail: a tap opens its sheet (r4 D11). */
const currentThumb = () =>
  query<HTMLButtonElement>('[data-edit-thumb][aria-current="true"]');
/** One of the phone's bottom sheets, open or not. */
const phoneSheet = (name: string) =>
  document.querySelector<HTMLDialogElement>(
    `dialog[data-phone-sheet="${name}"]`,
  );
/** The phone bar's title (编辑's 「n / N」). */
const barTitle = () =>
  query("[data-editor-screen] [data-editor-step-heading]")?.textContent ?? "";

/** 发布 is unavailable (it stays focusable and named, `aria-disabled`). */
const submitBlocked = () =>
  query<HTMLButtonElement>("[data-editor-submit]")?.getAttribute(
    "aria-disabled",
  ) === "true";

beforeEach(() => {
  shell.platform = "phone";
  shell.orientation = "portrait";
  author.viewer = { id: ACCOUNT, displayName: "测试作者" };
  author.notify = vi.fn();
  articles.epoch = 1;
  articles.create = vi.fn(() => Promise.reject(new Error("unset")));
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 390,
  });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.setAttribute("open", "");
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.removeAttribute("open");
    },
  });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  container?.remove();
  root = null;
  container = null;
  staged.current = null;
  versions.resolve = null;
  versions.restored = null;
  versions.onRestored = null;
  for (const key of Object.keys(client)) delete client[key];
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("Publishing editor", () => {
  it("r6 synchronizes only explicit saves and keeps the same latest draft without a snapshot call", async () => {
    const harness = await renderEditor({ type: "new" });
    expect(draftSwitch()).toBeNull();
    await goToPublish();
    // 保存草稿 sits in 发布's bottom bar (mockup A).
    expect(
      query("[data-editor-footer] [data-editor-save-now]")?.textContent,
    ).toBe("保存草稿");
    await type(titleInput(), "第一次内容");
    await act(async () => {
      harness.timers.fireAll();
    });
    await flush();
    expect(fn("createDraft")).not.toHaveBeenCalled();
    await click(query("[data-editor-save-now]"));
    expect(fn("createDraft")).toHaveBeenCalledOnce();
    await type(bodyInput(), "修改后才手动保存");
    await act(async () => {
      harness.timers.fireAll();
    });
    await flush();
    expect(fn("saveDraft")).not.toHaveBeenCalled();
    await click(query("[data-editor-save-now]"));
    expect(fn("saveDraft")).toHaveBeenCalledWith(
      DRAFT_ID,
      expect.objectContaining({
        content: expect.objectContaining({
          title: "第一次内容",
          body: "修改后才手动保存",
        }),
      }),
    );
    expect(fn("saveDraftNow")).not.toHaveBeenCalled();
    expect(fn("createDraft")).toHaveBeenCalledOnce();
  });

  it("r6 preserves unsaved input when Save Draft and Leave is refused", async () => {
    const harness = await renderEditor({ type: "new" });
    await goToPublish();
    await type(titleInput(), "仍要保留");
    expect(harness.guard()?.("close")).toBe("blocked");
    await flush();
    fn("createDraft").mockRejectedValueOnce(
      clientError(409, "草稿数量已达上限", false, "draft_limit"),
    );
    await click(buttonByText("保存草稿并离开"));
    expect(harness.controls.close).not.toHaveBeenCalled();
    expect(titleInput()?.value).toBe("仍要保留");
    expect(query('[data-editor-dialog="leave"]')).not.toBeNull();
  });

  it("keeps one session's input across steps and a resize into the desktop editor", async () => {
    const harness = await renderEditor({ type: "new" });
    expect(query('[role="dialog"]')?.getAttribute("aria-label")).toBe(
      "发布作品",
    );
    // r6 removes cloud autosave choices; selection quality remains explicit.
    expect(draftSwitch()).toBeNull();
    expect(
      query('[data-editor-switch="original"] [role="switch"]')?.getAttribute(
        "aria-checked",
      ),
    ).toBe("false");

    await goToPublish();
    await type(titleInput(), "临兰亭序");
    await type(bodyInput(), "第一行\n第二行");
    // No photos: ‹ goes back to 选择照片, and on again keeps the text.
    await click(phoneBack());
    expect(screen()).toBe("select");
    await goToPublish();
    expect(titleInput()?.value).toBe("临兰亭序");

    // Resize: the shell reports a PC platform; the same session renders wide.
    shell.platform = "pc";
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1280,
    });
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });
    await harness.rerender();
    expect(query('[data-editor-layout="desktop"]')).not.toBeNull();
    expect(titleInput()?.value).toBe("临兰亭序");
    expect(bodyInput()?.value).toBe("第一行\n第二行");
    // The continuous preview renders the real work presentation.
    expect(
      query('[data-editor-preview="continuous"] [data-detail-title]')
        ?.textContent,
    ).toBe("临兰亭序");
    // The preview shows the authorship section readers will see. Nothing is
    // claimed for a new work until the author chooses one (C05).
    const previewAuthorship = () =>
      query(
        '[data-editor-preview="continuous"] [data-detail-section="authorship"]',
      );
    expect(previewAuthorship()).toBeNull();
    await act(async () => {
      query<HTMLInputElement>(
        '[data-editor-field="authorship"] input[value="copy_practice"]',
      )!.click();
    });
    await type(
      query<HTMLInputElement>('input[data-editor-input="referenceTitle"]'),
      "兰亭序",
    );
    await flush();
    expect(previewAuthorship()?.textContent).toContain("临摹或练习");
    expect(previewAuthorship()?.textContent).toContain("参考作品兰亭序");
    await type(titleInput(), "临兰亭序（二）");

    shell.platform = "phone";
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 390,
    });
    await harness.rerender();
    expect(step()).toBe("text");
    expect(titleInput()?.value).toBe("临兰亭序（二）");
    expect(bodyInput()?.value).toBe("第一行\n第二行");
  });

  it("switches a tablet between the phone screens and the desktop editor at 896px, keeping the field being typed in", async () => {
    await setViewport("tablet", 895);
    await renderEditor({ type: "new" });
    await nextFrames();
    expect(query('[data-editor-layout="phone"]')).not.toBeNull();
    await goToPublish();
    const phoneBody = bodyInput()!;
    await act(async () => phoneBody.focus());
    await type(phoneBody, "正文在平板上");

    // Only the viewport changes: the shell still reports a tablet.
    await setViewport("tablet", 896);
    await nextFrames();
    expect(query('[data-editor-layout="desktop"]')).not.toBeNull();
    expect(bodyInput()?.value).toBe("正文在平板上");
    expect(document.activeElement).toBe(bodyInput());

    await act(async () => titleInput()!.focus());
    await type(titleInput(), "横屏标题");
    await setViewport("tablet", 820);
    await nextFrames();
    // Back on the phone at 发布, in the field being typed in.
    expect(screen()).toBe("publish");
    expect(document.activeElement).toBe(titleInput());
    expect(titleInput()?.value).toBe("横屏标题");
    expect(bodyInput()?.value).toBe("正文在平板上");

    // A dialog of one layout never reopens by itself after a round trip.
    await setViewport("tablet", 1024);
    await click(query("[data-editor-open-confirmation]"));
    expect(query('[data-editor-dialog="confirmation"]')).not.toBeNull();
    await setViewport("tablet", 820);
    await setViewport("tablet", 1024);
    expect(query('[data-editor-dialog="confirmation"]')).toBeNull();
  });

  const receiveStill = async (harness: Harness) => {
    const item = (await fn("registerItem").mock.results[0]!
      .value) as PublishingMediaItem;
    await act(async () => {
      harness.transfer.starts[0]!.callbacks.onSettled({
        status: 200,
        responseText: harness.uploads.receive(item.id, "still"),
        stalled: false,
      });
    });
    await flush();
    expect(harness.uploads.items.get(item.id)!.state).toBe("processing");
    return item.id;
  };

  it("keeps a session with processing media when the editor is left and returns to it", async () => {
    const harness = await renderEditor({ type: "new" });
    await act(async () => {
      await staged.current!.stageFiles([fileOf(jpeg({}))], "picker");
    });
    await flush();
    await act(async () => {
      expect(staged.current!.confirm().ok).toBe(true);
    });
    await flush();
    await flush();
    await receiveStill(harness);
    await goToPublish();
    await type(titleInput(), "上传中离开");
    await click(query("[data-editor-save-now]"));
    expect(fn("createDraft")).toHaveBeenCalledTimes(1);
    expect(query("[data-save-status]")?.textContent).toContain("已保存");

    // Uploads alone never hold the author: leaving is allowed (the browser
    // still asks before unloading the page).
    expect(harness.guard()?.("close")).toBe("blocked");
    await flush();
    await click(buttonByText("继续编辑"));
    expect(harness.guard()?.("unload")).toBe("blocked");
    await harness.show(false);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await flush();

    // The progress entry reopens the same session with the same content.
    await harness.show(true);
    // It resumes on 发布 (nothing needs the author).
    expect(screen()).toBe("publish");
    expect(titleInput()?.value).toBe("上传中离开");
    // On its heading, as entering 发布 always is: 标题 would raise the
    // keyboard over the 发布 bar and the preview.
    await nextFrames();
    expect(document.activeElement).toBe(
      query("[data-editor-screen] [data-editor-step-heading]"),
    );
    expect(document.activeElement).not.toBe(titleInput());
    // ‹ goes back to 编辑 at the photo.
    await click(phoneBack());
    expect(screen()).toBe("edit");
    expect(harness.transfer.starts.length).toBe(1);
    expect(fn("cancelItem")).not.toHaveBeenCalled();
  });

  it("ends a clean session when the editor is left", async () => {
    const harness = await renderEditor({ type: "new" });
    const firstKey =
      query("[data-phone-flow]")?.getAttribute("data-phone-flow");
    expect(firstKey).toBeTruthy();
    expect(harness.guard()).toBeNull();
    await harness.show(false);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await flush();
    await harness.show(true);
    const secondKey =
      query("[data-phone-flow]")?.getAttribute("data-phone-flow");
    expect(secondKey).toBeTruthy();
    expect(secondKey).not.toBe(firstKey);
    expect(query("[data-editor-other-session]")).toBeNull();
  });

  it("lets a text-only work skip 选择照片 and 编辑", async () => {
    await renderEditor({ type: "new" });
    expect(screen()).toBe("select");
    await click(query("[data-media-skip]"));
    expect(screen()).toBe("publish");
    expect(titleInput()).not.toBeNull();
    // The line above 发布 says why it cannot go yet.
    expect(query("[data-publish-reason]")?.textContent).toBe(
      "标题、正文和图片不能都为空",
    );
    // 发布 entered to write: 标题 takes focus.
    expect(document.activeElement).toBe(titleInput());
  });

  it("focuses the first control on open and previews the real work presentation on a phone", async () => {
    await renderEditor({ type: "new" });
    // Focus moves after the shell's own focus, in the next animation frame:
    // 选择照片's first control.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(document.activeElement).toBe(query("[data-media-picker] button"));
    expect(document.activeElement?.textContent).toBe("选择照片");

    await goToPublish();
    await type(titleInput(), "预览标题");
    await type(bodyInput(), "正文\n第二行");
    // 预览 sits in 发布's bottom bar, beside 发布 (mockup A).
    expect(
      query("[data-editor-footer] [data-editor-preview-open]")?.textContent,
    ).toBe("预览");
    await click(buttonByText("预览"));
    const preview = document.querySelector('[data-editor-preview="phone"]');
    expect(preview?.querySelector("[data-detail-title]")?.textContent).toBe(
      "预览标题",
    );
    expect(preview?.textContent).toContain("正文\n第二行");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("返回");
    await click(
      preview!.querySelector<HTMLButtonElement>('button[aria-label="返回"]'),
    );
    expect(document.querySelector('[data-editor-preview="phone"]')).toBeNull();
    expect(titleInput()?.value).toBe("预览标题");
    expect(document.activeElement?.textContent).toBe("预览");
  });

  it("preselects no 作品性质, lets the author clear one, and submits none as none", async () => {
    await renderEditor({ type: "new" });
    await goToPublish();
    const authorshipState = () =>
      query("[data-editor-authorship-state]")?.getAttribute(
        "data-editor-authorship-state",
      );
    const checked = () =>
      authorshipChips().filter(
        (chip) => chip.getAttribute("aria-checked") === "true",
      );
    // C05: nothing is claimed for the author before they choose.
    expect(authorshipState()).toBe("unset");
    expect(
      query('[data-editor-field="authorship"] [data-unset]')?.textContent,
    ).toBe("未设置");
    expect(checked()).toEqual([]);
    expect(query("[data-editor-authorship-clear]")).toBeNull();
    expect(query("[data-publish-references]")).toBeNull();

    await click(
      authorshipChips().find(
        (chip) => chip.getAttribute("data-publish-choice") === "original",
      )!,
    );
    expect(authorshipState()).toBe("original");
    expect(checked().map((chip) => chip.textContent)).toEqual(["原创"]);

    // The choice can be taken back; 未设置 is not a kind of its own.
    await click(query("[data-editor-authorship-clear]"));
    expect(authorshipState()).toBe("unset");
    expect(checked()).toEqual([]);
    // 清除选择 goes away with the choice it cleared: the keyboard stays in
    // the group instead of dropping to the page.
    expect(document.activeElement).toBe(authorshipChips()[0]);

    await type(titleInput(), "未声明性质的作品");
    await click(query("[data-editor-submit]"));
    expect(fn("submit").mock.calls[0]![0]).toMatchObject({
      content: { title: "未声明性质的作品", authorship: null },
    });
  });

  it("blocks the confirmation while retained items are not ready and lists exact counts", async () => {
    const harness = await renderEditor({ type: "new" });
    await act(async () => {
      await staged.current!.stageFiles(
        [fileOf(jpeg({ width: 40, height: 30 })), fileOf(jpeg({}))],
        "picker",
      );
    });
    await flush();
    await act(async () => {
      expect(staged.current!.confirm().ok).toBe(true);
    });
    await flush();
    await flush();
    expect(harness.transfer.starts.length).toBe(2);
    // One transfer stalls and fails; the other is still uploading.
    await act(async () => {
      harness.transfer.starts[0]!.callbacks.onSettled({
        status: 0,
        responseText: "",
        stalled: true,
      });
    });
    await flush();

    // The pick is on 编辑 at photo 1 (r4 D5) → 发布.
    expect(screen()).toBe("edit");
    await click(query("[data-edit-next]"));
    expect(screen()).toBe("publish");
    expect(query("[data-editor-readiness]")?.textContent).toBe(
      "1 项仍在上传，1 项失败。全部就绪或移除后才能发布",
    );
    expect(query("[data-publish-reason]")?.textContent).toBe(
      "1 项仍在上传，1 项失败。全部就绪或移除后才能发布前往处理",
    );
    expect(submitBlocked()).toBe(true);
    await click(query("[data-editor-submit]"));
    expect(fn("submit")).not.toHaveBeenCalled();

    // 前往处理: 编辑 at the failed photo, its fix sheet open (r4 D7).
    await click(query("[data-editor-resolve-media]"));
    expect(screen()).toBe("edit");
    expect(barTitle()).toContain("1 / 2");
    const fix = phoneSheet("photo-attention");
    expect(fix?.open).toBe(true);
    expect(fix?.querySelector("h2")?.textContent).toBe("上传失败");
    expect(fix?.querySelector("h2")?.nextElementSibling?.textContent).toBe(
      "第 1 项",
    );

    // Left on 发布 and opened again later, it resumes on 编辑 at that photo,
    // with no sheet: its stage says what it needs.
    await click(
      fix!.querySelector<HTMLButtonElement>('[data-media-action="cancel"]'),
    );
    await goToPublish();
    await harness.show(false);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await flush();
    await harness.show(true);
    expect(screen()).toBe("edit");
    expect(barTitle()).toContain("1 / 2");
    expect(phoneSheet("photo-attention")).toBeNull();
  });

  describe("edit derivative readiness (D1)", () => {
    const itemId = `media-item-${"7".repeat(32)}`;
    const readyItem: PublishingMediaItem = {
      id: itemId,
      kind: "static",
      qualityMode: "standard",
      state: "ready",
      failureCode: null,
      components: [],
      presentation: { width: 4, height: 3 },
      media: {
        thumbSrc: `/api/community/publishing/media/${itemId}/thumb/base`,
        displaySrc: `/api/community/publishing/media/${itemId}/display/base`,
      },
    };
    const turned = (rotation: 0 | 90): WorkDraftItem => ({
      key: "turned",
      itemId,
      kind: "static",
      qualityMode: "standard",
      edit: { rotation, crop: null },
    });
    const savedDraft = (rotation: 0 | 90) =>
      draftOf(emptyContent({ title: "已有图片", items: [turned(rotation)] }), {
        mediaItems: [readyItem],
      });
    const fireTimers = async (harness: Harness) => {
      await act(async () => {
        harness.timers.fireAll();
      });
      await flush();
    };

    it("counts a reopened draft's edited item as processing until the account confirms, then shows it ready", async () => {
      const harness = await renderEditor(
        { type: "draft", id: DRAFT_ID },
        () => {
          fn("draft").mockResolvedValue(savedDraft(90));
          fn("readiness").mockResolvedValueOnce({
            ready: false,
            pendingItemKeys: ["turned"],
            failedItemKeys: [],
            editKeys: {},
          });
        },
      );
      await goToPublish();
      expect(query("[data-editor-readiness]")?.textContent).toBe(
        "图片将在后台上传和处理，完成后自动发布，可继续浏览",
      );
      expect(submitBlocked()).toBe(false);
      // The debounced check asks with the draft as holder; the answer still names the item.
      await fireTimers(harness);
      expect(fn("readiness")).toHaveBeenCalledTimes(1);
      expect(fn("readiness").mock.calls[0]![0]).toEqual({ draftId: DRAFT_ID });
      expect(fn("readiness").mock.calls[0]![1]).toMatchObject({
        items: [{ key: "turned", edit: { rotation: 90, crop: null } }],
      });
      expect(query("[data-editor-readiness]")?.textContent).toBe(
        "图片将在后台上传和处理，完成后自动发布，可继续浏览",
      );
      // The poll (≤ 5 s) learns the derivatives exist.
      expect(
        [...harness.timers.pending.values()].some((timer) => timer.ms <= 5000),
      ).toBe(true);
      fn("readiness").mockResolvedValueOnce({
        ready: true,
        pendingItemKeys: [],
        failedItemKeys: [],
        editKeys: { turned: "e".repeat(32) },
      });
      await fireTimers(harness);
      expect(fn("readiness")).toHaveBeenCalledTimes(2);
      expect(query("[data-editor-readiness]")?.textContent).toBe(
        "全部 1 项已就绪",
      );
      expect(submitBlocked()).toBe(false);
    });

    it("continues a background intent after a definitive not-ready response without changing its identity", async () => {
      const harness = await renderEditor(
        { type: "draft", id: DRAFT_ID },
        () => {
          fn("draft").mockResolvedValue(savedDraft(0));
          fn("submit").mockResolvedValueOnce({
            state: "not_ready",
            itemKeys: ["turned"],
          });
        },
      );
      await goToPublish();
      await click(query("[data-editor-submit]"));
      expect(harness.controls.close).toHaveBeenCalledOnce();
      await leaveOverlay(harness);
      await fireTimers(harness);
      expect(fn("submit")).toHaveBeenCalledOnce();
      await fireTimers(harness);
      expect(fn("submit")).toHaveBeenCalledTimes(2);
      expect(fn("submit").mock.calls[1]![0]).toEqual(
        fn("submit").mock.calls[0]![0],
      );
      expect(harness.controls.completeWith).not.toHaveBeenCalled();
      expect(author.notify).toHaveBeenCalledWith("作品已发布");
    });

    it("says nothing when a draft opened from 草稿箱 leaves from 编辑: its photos are already there", async () => {
      const harness = await renderEditor(
        { type: "draft", id: DRAFT_ID },
        () => {
          fn("draft").mockResolvedValue(savedDraft(0));
        },
      );
      expect(screen()).toBe("publish");
      await click(phoneBack());
      expect(screen()).toBe("edit");
      // A draft leaves from 编辑: no back sheet.
      await click(phoneBack());
      expect(phoneSheet("edit-back")).toBeNull();
      expect(harness.controls.close).toHaveBeenCalledOnce();
      // The shell asks the guard: nothing to save, so no dialog, and no
      // 「照片已存入草稿箱…」: that is for a work started here (r4 §2.3).
      expect(harness.guard()?.("close")).toBe("allow");
      await flush();
      expect(query('[data-editor-dialog="leave"]')).toBeNull();
      expect(author.notify).not.toHaveBeenCalled();

      // Nor from 发布.
      await goToPublish();
      expect(harness.guard()?.("close")).toBe("allow");
      expect(author.notify).not.toHaveBeenCalled();
    });

    it("shows the editor's notices on 编辑 (a media field failure)", async () => {
      const harness = await renderEditor(
        { type: "draft", id: DRAFT_ID },
        () => {
          fn("draft").mockResolvedValue(savedDraft(0));
          fn("submit").mockRejectedValueOnce(
            Object.assign(new Error("不支持的文件类型"), {
              status: 422,
              code: "unsupported_type",
              outcomeUnknown: false,
            }),
          );
        },
      );
      await goToPublish();
      await click(query("[data-editor-submit]"));
      await fireTimers(harness);
      await click(buttonByText("前往查看"));
      expect(screen()).toBe("edit");
      expect(query("[data-edit-notices]")?.textContent).toContain(
        "不支持的文件类型",
      );
      await nextFrames();
      expect(document.activeElement).toBe(heading());
    });
  });

  it("desktop Publish still confirms and opens the submitted work", async () => {
    const h = await renderEditor({ type: "new" });
    await setViewport("pc", 1280);
    await h.rerender();
    await type(titleInput(), "桌面作品");
    await click(query("[data-editor-open-confirmation]"));
    await click(query("[data-editor-submit]"));
    expect(h.controls.completeWith).toHaveBeenCalledWith({
      type: "work",
      id: WORK_ID,
    });
    expect(author.notify).toHaveBeenCalledWith("作品已提交");
  });

  it("phone Publish closes immediately and confirms without opening a work page", async () => {
    const harness = await renderEditor({ type: "new" });
    await goToPublish();
    await type(titleInput(), "新作");
    await click(query("[data-editor-submit]"));
    expect(harness.controls.close).toHaveBeenCalledOnce();
    await leaveOverlay(harness);
    expect(fn("submit")).toHaveBeenCalledOnce();
    expect(fn("submit").mock.calls[0]![0]).toMatchObject({
      holder: { sessionId: SESSION_ID },
      content: { title: "新作", visibility: "public" },
      baseRevisionId: null,
    });
    expect(harness.controls.completeWith).not.toHaveBeenCalled();
    expect(author.notify).toHaveBeenCalledWith("作品已发布");
  });

  it("phone Publish leaves while photos upload, preserves the frozen content and waits for processing", async () => {
    const harness = await renderEditor({ type: "new" });
    await act(async () => {
      await staged.current!.stageFiles([fileOf(jpeg({}))], "picker");
      staged.current!.confirm();
    });
    await flush();
    await goToPublish();
    await type(titleInput(), "后台照片");
    await type(bodyInput(), "正文");
    expect(submitBlocked()).toBe(false);
    await click(query("[data-editor-submit]"));
    expect(harness.controls.close).toHaveBeenCalledOnce();
    expect(fn("submit")).not.toHaveBeenCalled();
    await leaveOverlay(harness);
    const itemId = await receiveStill(harness);
    expect(fn("submit")).not.toHaveBeenCalled();
    await act(async () => {
      harness.uploads.makeReady(itemId);
      harness.timers.fireAll();
    });
    await flush();
    await act(async () => harness.timers.fireAll());
    await flush();
    expect(fn("submit")).toHaveBeenCalledOnce();
    expect(fn("submit").mock.calls[0]![0]).toMatchObject({
      content: { title: "后台照片", body: "正文", items: [{ itemId }] },
    });
    expect(harness.controls.completeWith).not.toHaveBeenCalled();
    expect(author.notify).toHaveBeenCalledWith("作品已发布");
  });

  it("keeps a failed background upload and releases editing after cancelling its queued intent", async () => {
    const harness = await renderEditor({ type: "new" });
    await act(async () => {
      await staged.current!.stageFiles([fileOf(jpeg({}))], "picker");
      staged.current!.confirm();
    });
    await flush();
    await goToPublish();
    await type(titleInput(), "保留标题");
    await click(query("[data-editor-submit]"));
    await leaveOverlay(harness);
    await act(async () =>
      harness.transfer.starts[0]!.callbacks.onSettled({
        status: 503,
        responseText: "",
        stalled: false,
      }),
    );
    await flush();
    expect(fn("submit")).not.toHaveBeenCalled();
    await harness.show(true);
    expect(
      query("[data-editor-background-publication]")?.textContent,
    ).toContain("图片需要处理");
    expect(query("[data-editor-body]")?.hasAttribute("inert")).toBe(true);
    await click(buttonByText("取消自动发布，继续编辑"));
    expect(query("[data-editor-background-publication]")).toBeNull();
    expect(query("[data-editor-body]")?.hasAttribute("inert")).toBe(false);
    await goToPublish();
    expect(titleInput()?.value).toBe("保留标题");
    expect(submitBlocked()).toBe(true);
  });

  it("restores a Backend field failure which arrives after the phone editor has closed", async () => {
    const h = await renderEditor({ type: "new" });
    let reject!: (error: Error) => void;
    fn("submit").mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    await goToPublish();
    await type(titleInput(), "保留标题");
    await click(query("[data-editor-submit]"));
    await leaveOverlay(h);
    await act(async () =>
      reject(
        Object.assign(new Error("标题不符合要求"), {
          status: 422,
          code: "title_too_long",
          outcomeUnknown: false,
        }),
      ),
    );
    await flush();
    await h.show(true);
    await goToPublish();
    expect(titleInput()?.value).toBe("保留标题");
    expect(query('[data-editor-field="title"]')?.textContent).toContain(
      "标题不符合要求",
    );
    expect(h.controls.completeWith).not.toHaveBeenCalled();
  });

  it("resumes a paused background transfer from its progress panel without editing the frozen post", async () => {
    const h = await renderEditor({ type: "new" });
    await act(async () => {
      await staged.current!.stageFiles([fileOf(jpeg({}))], "picker");
      staged.current!.confirm();
    });
    await flush();
    await goToPublish();
    await type(titleInput(), "断网恢复");
    await click(query("[data-editor-submit]"));
    await leaveOverlay(h);
    await act(async () => window.dispatchEvent(new Event("offline")));
    await flush();
    await h.show(true);
    expect(
      query("[data-editor-background-publication]")?.textContent,
    ).toContain("后台发布已暂停");
    await click(buttonByText("继续上传／重试确认"));
    expect(h.transfer.starts).toHaveLength(2);
    const item = (await fn("registerItem").mock.results[0]!
      .value) as PublishingMediaItem;
    await act(async () =>
      h.transfer.starts.at(-1)!.callbacks.onSettled({
        status: 200,
        responseText: h.uploads.receive(item.id, "still"),
        stalled: false,
      }),
    );
    await flush();
    await act(async () => {
      h.uploads.makeReady(item.id);
      h.timers.fireAll();
    });
    await flush();
    await act(async () => h.timers.fireAll());
    await flush();
    expect(fn("submit")).toHaveBeenCalledOnce();
    expect(fn("submit").mock.calls[0]![0]).toMatchObject({
      content: { title: "断网恢复" },
    });
    expect(h.controls.completeWith).not.toHaveBeenCalled();
    expect(h.controls.close).toHaveBeenCalledTimes(2);
    expect(h.guard()?.("history")).toBe("allow");
    expect(query("[data-editor-leave-dialog]")).toBeNull();
    expect(
      vi
        .mocked(author.notify)
        .mock.calls.filter(([text]) => text === "作品已发布"),
    ).toHaveLength(1);
    await leaveOverlay(h);
    await h.show(true);
    await goToPublish();
    expect(titleInput()?.value).toBe("");
  });

  it("closes the reopened background progress editor when a receipt confirms publication", async () => {
    const h = await renderEditor({ type: "new" });
    let reject!: (error: Error) => void;
    let answerReceipt!: () => void;
    fn("submit").mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    fn("submissionReceipt").mockImplementationOnce(
      (id: string) =>
        new Promise((resolve) => {
          answerReceipt = () => resolve(receipt(id));
        }),
    );
    await goToPublish();
    await type(titleInput(), "等待回执");
    await click(query("[data-editor-submit]"));
    await leaveOverlay(h);
    await h.show(true);
    expect(
      query("[data-editor-background-publication]")?.textContent,
    ).toContain("正在发布");
    await act(async () =>
      reject(clientError(0, "网络连接中断，结果尚未确认", true)),
    );
    await flush();
    expect(
      query("[data-editor-background-publication]")?.textContent,
    ).toContain("正在确认发布结果");
    await act(async () => answerReceipt());
    await flush();
    expect(h.controls.close).toHaveBeenCalledTimes(2);
    expect(h.controls.completeWith).not.toHaveBeenCalled();
    expect(fn("submit")).toHaveBeenCalledOnce();
    expect(h.guard()?.("history")).toBe("allow");
    expect(
      vi
        .mocked(author.notify)
        .mock.calls.filter(([text]) => text === "作品已发布"),
    ).toHaveLength(1);
  });

  it("keeps a lost background result while browsing and confirms by receipt without navigation", async () => {
    const harness = await renderEditor({ type: "new" });
    let answerReceipt!: () => void;
    fn("submit").mockRejectedValueOnce(
      clientError(0, "网络连接中断，结果尚未确认", true),
    );
    fn("submissionReceipt").mockImplementationOnce(
      (id: string) =>
        new Promise((resolve) => {
          answerReceipt = () => resolve(receipt(id));
        }),
    );
    await goToPublish();
    await type(bodyInput(), "只有正文");
    await click(query("[data-editor-submit]"));
    expect(harness.controls.close).toHaveBeenCalledOnce();
    await leaveOverlay(harness);
    expect(fn("submit")).toHaveBeenCalledOnce();
    await act(async () => answerReceipt());
    await flush();
    expect(harness.controls.completeWith).not.toHaveBeenCalled();
    expect(author.notify).toHaveBeenCalledWith("作品已发布");
  });

  it("places a Backend field failure at its field", async () => {
    await renderEditor({ type: "new" });
    fn("submit").mockRejectedValueOnce(
      Object.assign(new Error("标题过长"), {
        status: 422,
        code: "title_too_long",
        outcomeUnknown: false,
      }),
    );
    await goToPublish();
    await type(titleInput(), "标题");
    await click(query("[data-editor-submit]"));
    await click(buttonByText("前往查看"));
    expect(screen()).toBe("publish");
    await nextFrames();
    expect(document.activeElement).toBe(titleInput());
    expect(
      query('[data-editor-field="title"]')?.querySelector("p")?.textContent,
    ).toBe("标题过长");
  });

  it("offers 保存草稿并离开 / 继续编辑 / 放弃本次未保存的更改 for unsaved draft changes", async () => {
    const harness = await renderEditor({ type: "new" });
    await goToPublish();
    await type(titleInput(), "草稿标题");
    await flush();
    expect(query("[data-save-status]")?.textContent).toContain(
      "有未保存的更改",
    );
    // The browser's Back steps back a screen first: 发布 → 选择照片 (no
    // photos), then leaves through the dialog.
    expect(harness.guard()?.("history")).toBe("blocked");
    await flush();
    expect(screen()).toBe("select");
    expect(query('[data-editor-dialog="leave"]')).toBeNull();
    expect(harness.guard()?.("history")).toBe("blocked");
    await flush();
    for (const label of ["保存草稿并离开", "继续编辑", "放弃本次未保存的更改"])
      expect(buttonByText(label)).not.toBeNull();
    await click(buttonByText("继续编辑"));
    expect(harness.controls.close).not.toHaveBeenCalled();

    expect(harness.guard()?.("close")).toBe("blocked");
    await flush();
    await click(buttonByText("保存草稿并离开"));
    await flush();
    expect(fn("createDraft")).toHaveBeenCalledTimes(1);
    expect(fn("saveDraft")).not.toHaveBeenCalled();
    expect(fn("saveDraftNow")).not.toHaveBeenCalled();
    expect(harness.controls.close).toHaveBeenCalledTimes(1);
    // The new work's draft became the editor entry.
    expect(harness.controls.replaceTarget).toHaveBeenCalledWith({
      type: "draft",
      id: DRAFT_ID,
    });
  });

  it("says a new work without a draft loses everything when discarded", async () => {
    const harness = await renderEditor({ type: "new" });
    await goToPublish();
    await type(titleInput(), "不要了");
    await flush();
    expect(harness.guard()?.("close")).toBe("blocked");
    await flush();
    expect(document.querySelector("[data-leave-scope]")?.textContent).toContain(
      "这些内容还没有保存到账号",
    );
    await click(buttonByText("放弃本次未保存的更改"));
    expect(harness.controls.close).toHaveBeenCalledTimes(1);
    expect(fn("createDraft")).not.toHaveBeenCalled();
    expect(fn("saveDraft")).not.toHaveBeenCalled();
  });

  it("discards only the unsaved changes of a saved draft and keeps the draft", async () => {
    const saved = draftOf(emptyContent({ title: "已保存" }), { revision: 3 });
    const harness = await renderEditor({ type: "draft", id: DRAFT_ID }, () => {
      fn("draft").mockResolvedValue(saved);
    });
    await goToPublish();
    await type(titleInput(), "已保存（未保存的更改）");
    await flush();
    expect(harness.guard()?.("close")).toBe("blocked");
    await flush();
    expect(document.querySelector("[data-leave-scope]")?.textContent).toBe(
      "有更改还没有保存到草稿。放弃会丢弃这些未保存的更改，草稿保留上次保存的内容。",
    );
    await click(buttonByText("放弃本次未保存的更改"));
    expect(harness.controls.close).toHaveBeenCalledTimes(1);
    await leaveOverlay(harness);
    expect(fn("deleteDraft")).not.toHaveBeenCalled();
    expect(fn("saveDraft")).not.toHaveBeenCalled();
    expect(fn("saveDraft")).not.toHaveBeenCalled();
  });

  it("opens an existing work's edit draft with the work's visibility", async () => {
    const editable: EditableWork = {
      workId: WORK_ID,
      revisionId: REVISION_ID,
      content: emptyContent({ title: "旧作", visibility: "self" }),
      mediaItems: [],
      visibility: "self",
      firstPublishedAt: T,
      editedAt: null,
      draftId: null,
      version: 1,
    };
    const harness = await renderEditor({ type: "work", id: WORK_ID }, () => {
      fn("editableWork").mockResolvedValue(editable);
      fn("openWorkEditDraft").mockResolvedValue(
        openedDraft(
          draftOf(emptyContent({ title: "旧作", visibility: "public" }), {
            id: EDIT_DRAFT_ID,
            kind: "edit",
            workId: WORK_ID,
            baseRevisionId: REVISION_ID,
          }),
        ),
      );
    });
    expect(query('[role="dialog"]')?.getAttribute("aria-label")).toBe(
      "编辑作品",
    );
    await goToPublish();
    expect(titleInput()?.value).toBe("旧作");
    const checked = query(
      '[data-editor-field="visibility"] [role="radio"][aria-checked="true"]',
    );
    expect(checked?.getAttribute("data-publish-choice")).toBe("self");
    expect(checked?.textContent).toBe("仅自己可见");
    expect(query("[data-editor-submit]")?.textContent).toBe("保存更新");
    await click(query("[data-editor-submit]"));
    expect(fn("submit").mock.calls[0]![0]).toMatchObject({
      holder: { sessionId: SESSION_ID },
      baseRevisionId: REVISION_ID,
      content: { visibility: "self" },
    });
    expect(harness.controls.completeWith).toHaveBeenCalledWith({
      type: "work",
      id: WORK_ID,
    });
  });
  it("offers 重试 and an icon-only back when a work cannot be opened", async () => {
    const harness = await renderEditor({ type: "work", id: WORK_ID }, () => {
      fn("editableWork").mockRejectedValue(new Error("synthetic outage"));
    });
    const panel = query("[data-editor-unavailable]");
    expect(panel).not.toBeNull();
    expect(buttonByText("重试")).not.toBeNull();
    const back = panel!.querySelector<HTMLButtonElement>(
      "button[aria-label='返回']",
    );
    expect(back?.textContent?.trim()).toBe("");
    expect(back?.querySelector("[data-icon='back']")).not.toBeNull();
    await click(back);
    expect(harness.controls.close).toHaveBeenCalledOnce();
  });
  it("keeps a legacy work's undeclared 作品性质 undeclared through an edit", async () => {
    // A Phase 4 work whose author never declared one: editing and saving it
    // again must not put 原创 on it (C05).
    const undeclared = emptyContent({ title: "旧作", authorship: null });
    const editable: EditableWork = {
      workId: WORK_ID,
      revisionId: REVISION_ID,
      content: undeclared,
      mediaItems: [],
      visibility: "public",
      firstPublishedAt: T,
      editedAt: null,
      draftId: null,
      version: 1,
    };
    await renderEditor({ type: "work", id: WORK_ID }, () => {
      fn("editableWork").mockResolvedValue(editable);
      fn("openWorkEditDraft").mockResolvedValue(
        openedDraft(
          draftOf(undeclared, {
            id: EDIT_DRAFT_ID,
            kind: "edit",
            workId: WORK_ID,
            baseRevisionId: REVISION_ID,
          }),
        ),
      );
    });
    await goToPublish();
    expect(
      query("[data-editor-authorship-state]")?.getAttribute(
        "data-editor-authorship-state",
      ),
    ).toBe("unset");
    expect(
      authorshipChips().some(
        (chip) => chip.getAttribute("aria-checked") === "true",
      ),
    ).toBe(false);
    await type(titleInput(), "旧作（改）");
    await click(query("[data-editor-submit]"));
    expect(fn("submit").mock.calls[0]![0]).toMatchObject({
      content: { title: "旧作（改）", authorship: null },
    });
  });

  it("keeps an edit draft the account did not create for this editor, even when the work read saw none", async () => {
    // The race the account settles: the editable read still showed no draft,
    // and another device opened one before this request reached the account.
    const editable: EditableWork = {
      workId: WORK_ID,
      revisionId: REVISION_ID,
      content: emptyContent({ title: "旧作" }),
      mediaItems: [],
      visibility: "public",
      firstPublishedAt: T,
      editedAt: null,
      draftId: null,
      version: 1,
    };
    const opened = draftOf(emptyContent({ title: "旧作" }), {
      id: EDIT_DRAFT_ID,
      kind: "edit",
      workId: WORK_ID,
      baseRevisionId: REVISION_ID,
      revision: 1,
    });
    const recovery = recoveryDouble();
    const harness = await renderEditor(
      { type: "work", id: WORK_ID },
      () => {
        fn("editableWork").mockResolvedValue(editable);
        fn("openWorkEditDraft").mockResolvedValue(openedDraft(opened, false));
      },
      { recovery },
    );
    expect(titleInput() ?? query("[data-phone-flow]")).not.toBeNull();
    await leaveOverlay(harness);
    // Not this editor's draft to remove: the other device keeps it.
    expect(fn("deleteDraft")).not.toHaveBeenCalled();
    expect(recovery.clearDraft).not.toHaveBeenCalled();
    expect(author.notify).not.toHaveBeenCalled();
  });

  it("resumes saving after the author keeps this device's version, including input typed after the conflict", async () => {
    const saved = draftOf(emptyContent({ title: "起点" }), { revision: 3 });
    const device = emptyContent({ title: "本设备标题" });
    const account = emptyContent({ title: "别处标题" });
    const conflict = conflictOf(device, account);
    await renderEditor({ type: "draft", id: DRAFT_ID }, () => {
      fn("draft").mockResolvedValue(saved);
    });
    await goToPublish();
    await type(titleInput(), "本设备标题");
    fn("saveDraft").mockResolvedValueOnce({
      status: "conflict",
      draft: draftOf(account, { revision: 4, conflict }),
      conflict,
    });
    await click(query("[data-editor-save-now]"));
    expect(saveStatus()).toBe("conflict");
    // The chooser opens by itself; input typed meanwhile is kept.
    expect(query(`[data-conflict-stub="${conflict.id}"]`)).not.toBeNull();
    await type(titleInput(), "本设备标题（续）");
    versions.resolve = (choice) =>
      draftOf(choice === "device" ? device : account, { revision: 5 });
    await click(query('[data-choose="device"]'));
    await flush();

    expect(query("[data-conflict-stub]")).toBeNull();
    expect(titleInput()?.value).toBe("本设备标题（续）");
    expect(saveStatus()).toBe("pending");
    fn("saveDraft").mockClear();
    await click(query("[data-editor-save-now]"));
    expect(fn("saveDraft")).toHaveBeenCalledTimes(1);
    expect(fn("saveDraft").mock.calls[0]![1]).toMatchObject({
      baseRevision: 5,
      content: { title: "本设备标题（续）" },
    });
    expect(saveStatus()).toBe("saved");

    // Saving keeps working for later edits, each on the last saved revision.
    const first = (await fn("saveDraft").mock.results[0]!.value) as {
      draft: PublishingDraft;
    };
    await type(titleInput(), "本设备标题（再续）");
    await click(query("[data-editor-save-now]"));
    expect(fn("saveDraft").mock.calls[1]![1]).toMatchObject({
      baseRevision: first.draft.revision,
      content: { title: "本设备标题（再续）" },
    });
    expect(saveStatus()).toBe("saved");
    expect(query("[data-editor-notice]")).toBeNull();
  });

  it("uses the account version while preserving later typing and the chosen save base", async () => {
    const saved = draftOf(emptyContent({ title: "起点" }), { revision: 3 });
    const device = emptyContent({ title: "本设备标题" });
    const account = emptyContent({ title: "别处标题", body: "别处正文" });
    const conflict = conflictOf(device, account);
    await renderEditor({ type: "draft", id: DRAFT_ID }, () => {
      fn("draft").mockResolvedValue(saved);
    });
    await goToPublish();
    await type(titleInput(), "本设备标题");
    fn("saveDraft").mockResolvedValueOnce({
      status: "conflict",
      draft: draftOf(account, { revision: 4, conflict }),
      conflict,
    });
    await click(query("[data-editor-save-now]"));
    await type(titleInput(), "冲突后的输入");
    versions.resolve = (choice) =>
      draftOf(choice === "device" ? device : account, { revision: 5 });
    await click(query('[data-choose="account"]'));
    await flush();

    expect(titleInput()?.value).toBe("冲突后的输入");
    expect(bodyInput()?.value).toBe("别处正文");
    expect(query("[data-editor-notice]")?.textContent).toContain(
      "保留冲突出现后在本设备输入的更改",
    );
    expect(saveStatus()).toBe("pending");
    fn("saveDraft").mockClear();
    await type(titleInput(), "别处标题（改）");
    await click(query("[data-editor-save-now]"));
    expect(fn("saveDraft").mock.calls[0]![1]).toMatchObject({
      baseRevision: 5,
      content: { title: "别处标题（改）", body: "别处正文" },
    });
    expect(saveStatus()).toBe("saved");
  });

  it("permits a history version after a definitive background failure returns the draft to editing", async () => {
    const saved = draftOf(emptyContent({ title: "当前" }), { revision: 3 });
    const h = await renderEditor({ type: "draft", id: DRAFT_ID }, () =>
      fn("draft").mockResolvedValue(saved),
    );
    let reject!: (error: Error) => void;
    fn("submit").mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    await goToPublish();
    await click(query("[data-editor-submit]"));
    await leaveOverlay(h);
    await act(async () =>
      reject(
        Object.assign(new Error("暂时无法发布"), {
          status: 422,
          code: "invalid_content",
          outcomeUnknown: false,
        }),
      ),
    );
    await flush();
    await h.show(true);
    await goToPublish();
    await click(query("[data-editor-menu]"));
    await click(query("[data-editor-menu-history]"));
    versions.restored = draftOf(emptyContent({ title: "恢复历史内容" }), {
      revision: 7,
    });
    await click(query("[data-history-restore]"));
    await flush();
    expect(titleInput()?.value).toBe("恢复历史内容");
    expect(fn("submit")).toHaveBeenCalledOnce();
    expect(h.controls.completeWith).not.toHaveBeenCalled();
  });

  it("continues saving from a restored history version", async () => {
    const saved = draftOf(emptyContent({ title: "当前" }), { revision: 3 });
    await renderEditor({ type: "draft", id: DRAFT_ID }, () => {
      fn("draft").mockResolvedValue(saved);
    });
    await goToPublish();
    await click(query("[data-editor-menu]"));
    await click(query("[data-editor-menu-history]"));
    versions.restored = draftOf(emptyContent({ title: "历史标题" }), {
      revision: 7,
    });
    await click(query("[data-history-restore]"));
    await flush();
    expect(query("[data-history-stub]")).toBeNull();
    expect(titleInput()?.value).toBe("历史标题");
    await type(titleInput(), "历史标题（改）");
    await click(query("[data-editor-save-now]"));
    expect(fn("saveDraft").mock.calls.at(-1)![1]).toMatchObject({
      baseRevision: 7,
      content: { title: "历史标题（改）" },
    });
    expect(saveStatus()).toBe("saved");
  });

  it("adopts nothing from a version answer for another draft or after the account changed", async () => {
    const saved = draftOf(emptyContent({ title: "当前" }), { revision: 3 });
    await renderEditor({ type: "draft", id: DRAFT_ID }, () => {
      fn("draft").mockResolvedValue(saved);
    });
    await goToPublish();
    const restoreLater = async (
      restored: PublishingDraft,
      meanwhile: () => void = () => undefined,
    ) => {
      await click(query("[data-editor-menu]"));
      await click(query("[data-editor-menu-history]"));
      const answer = versions.onRestored!;
      await act(async () => {
        meanwhile();
        answer(restored);
        author.viewer = { id: ACCOUNT, displayName: "测试作者" };
      });
      await flush();
    };

    // An answer for a draft this session no longer saves to.
    await restoreLater(
      draftOf(emptyContent({ title: "别的草稿" }), {
        id: `work-draft-${"8".repeat(32)}`,
        revision: 9,
      }),
    );
    expect(titleInput()?.value).toBe("当前");
    expect(saveStatus()).not.toBe("pending");

    // The answer arrives once another account is confirmed.
    await restoreLater(
      draftOf(emptyContent({ title: "历史标题" }), { revision: 7 }),
      () => {
        author.viewer = { id: `user-${"9".repeat(32)}`, displayName: "另一人" };
      },
    );
    expect(query("[data-history-stub]")).toBeNull();
    expect(titleInput()?.value).toBe("当前");

    await type(titleInput(), "当前（改）");
    await click(query("[data-editor-save-now]"));
    expect(fn("saveDraft").mock.calls.at(-1)![1]).toMatchObject({
      baseRevision: 3,
      content: { title: "当前（改）" },
    });
  });

  it("does not end another session whose changes could not be saved", async () => {
    const harness = await renderEditor({ type: "new" });
    await goToPublish();
    await type(titleInput(), "另一项编辑");
    await flush();
    await leaveOverlay(harness);
    await harness.rerender({ type: "work", id: WORK_ID });
    await harness.show(true);
    expect(query("[data-editor-other-session]")).not.toBeNull();
    expect(query("[data-editor-other-scope]")?.textContent).toContain(
      "结束前会先保存那项编辑的更改",
    );

    fn("createDraft").mockRejectedValueOnce(
      clientError(409, "草稿数量已达上限", false, "draft_limit"),
    );
    await click(buttonByText("保存草稿并结束那项编辑"));
    expect(fn("createDraft")).toHaveBeenCalledTimes(1);
    expect(
      query("[data-editor-other-session] [role='alert']")?.textContent,
    ).toContain("草稿数量已达上限");
    expect(query("[data-editor-other-session]")).not.toBeNull();

    await click(buttonByText("回到那项编辑"));
    expect(harness.controls.replaceTarget).toHaveBeenCalledWith({
      type: "new",
    });
  });

  it("adopts a chosen version at once while media processes, and never adds back what it left out", async () => {
    const saved = draftOf(emptyContent({ title: "起点" }), { revision: 3 });
    const account = emptyContent({ title: "别处标题" });
    const harness = await renderEditor({ type: "draft", id: DRAFT_ID }, () => {
      fn("draft").mockResolvedValue(saved);
    });
    await act(async () => {
      await staged.current!.stageFiles([fileOf(jpeg({}))], "picker");
    });
    await flush();
    await act(async () => {
      expect(staged.current!.confirm().ok).toBe(true);
    });
    await flush();
    await flush();
    expect(harness.transfer.starts.length).toBe(1);
    const itemId = await receiveStill(harness);
    await goToPublish();
    await type(titleInput(), "本设备标题");
    fn("saveDraft").mockImplementationOnce(
      async (_id: string, cmd: { content: WorkDraftContent }) => {
        const conflict = conflictOf(cmd.content, account);
        return {
          status: "conflict",
          draft: draftOf(account, { revision: 4, conflict }),
          conflict,
        };
      },
    );
    await click(query("[data-editor-save-now]"));
    expect(saveStatus()).toBe("conflict");
    expect(
      (fn("saveDraft").mock.calls[0]![1] as { content: WorkDraftContent })
        .content.items,
    ).toHaveLength(1);
    // The upload is still running: the chooser opens anyway, and so does history.
    expect(query("[data-conflict-stub]")).not.toBeNull();
    versions.resolve = () => draftOf(account, { revision: 5 });
    await click(query('[data-choose="account"]'));
    expect(query("[data-conflict-stub]")).toBeNull();
    expect(titleInput()?.value).toBe("别处标题");
    expect(saveStatus()).toBe("saved");
    // Nothing restarted: the same transfer runs, nothing was cancelled or discarded.
    expect(harness.transfer.starts.length).toBe(1);
    expect(fn("cancelItem")).not.toHaveBeenCalled();
    expect(fn("discardSession")).not.toHaveBeenCalled();
    await click(query("[data-editor-menu]"));
    expect(
      query("[data-editor-menu-history]")?.hasAttribute("aria-disabled"),
    ).toBe(false);
    expect(query("[data-editor-menu]")?.textContent ?? "").not.toContain(
      "图片上传完成后可用",
    );
    // A history version is adopted the same way while the upload still runs.
    await click(query("[data-editor-menu-history]"));
    versions.restored = draftOf(emptyContent({ title: "历史标题" }), {
      revision: 6,
    });
    await click(query("[data-history-restore]"));
    expect(query("[data-history-stub]")).toBeNull();
    expect(titleInput()?.value).toBe("历史标题");
    expect(saveStatus()).toBe("saved");
    expect(harness.transfer.starts.length).toBe(1);
    expect(fn("cancelItem")).not.toHaveBeenCalled();
    expect(fn("discardSession")).not.toHaveBeenCalled();

    // A processing failure on an excluded item cannot restore it to the album.
    fn("item").mockClear();
    await act(async () => {
      harness.uploads.failProcessing(itemId, "processing_failed");
      harness.timers.fireAll();
    });
    await flush();
    expect(fn("item").mock.calls.some(([id]) => id === itemId)).toBe(true);
    fn("saveDraft").mockClear();
    await type(titleInput(), "历史标题（改）");
    await click(query("[data-editor-save-now]"));
    expect(fn("saveDraft")).toHaveBeenCalledTimes(1);
    expect(fn("saveDraft").mock.calls[0]![1]).toMatchObject({
      baseRevision: 6,
      content: { title: "历史标题（改）", items: [] },
    });
  });

  it("never shows history and the version chooser together, and history leads back to the chooser", async () => {
    const saved = draftOf(emptyContent({ title: "起点" }), { revision: 3 });
    await renderEditor({ type: "draft", id: DRAFT_ID }, () => {
      fn("draft").mockResolvedValue(saved);
    });
    const shown = () => ({
      history: query("[data-history-stub]") !== null,
      chooser: query("[data-conflict-stub]") !== null,
    });
    await goToPublish();
    await click(query("[data-editor-menu]"));
    await click(query("[data-editor-menu-history]"));
    expect(shown()).toEqual({ history: true, chooser: false });
    // Without two versions there is no chooser to go back to.
    expect(query("[data-history-choose-version]")).toBeNull();

    // A conflict arriving while history is open takes its place.
    await type(titleInput(), "本设备标题");
    const conflict = conflictOf(
      emptyContent({ title: "本设备标题" }),
      emptyContent({ title: "别处标题" }),
    );
    fn("saveDraft").mockResolvedValueOnce({
      status: "conflict",
      draft: draftOf(emptyContent({ title: "别处标题" }), {
        revision: 4,
        conflict,
      }),
      conflict,
    });
    await click(query("[data-editor-save-now]"));
    expect(shown()).toEqual({ history: false, chooser: true });

    // Closed, then history: blocked restores, but a way back to the chooser.
    await click(query("[data-conflict-close]"));
    expect(shown()).toEqual({ history: false, chooser: false });
    await click(query("[data-editor-menu]"));
    await click(query("[data-editor-menu-history]"));
    expect(shown()).toEqual({ history: true, chooser: false });
    await click(query("[data-history-choose-version]"));
    expect(shown()).toEqual({ history: false, chooser: true });

    // Opening history from the menu while choosing replaces the chooser.
    await click(query("[data-editor-menu]"));
    await click(query("[data-editor-menu-history]"));
    expect(shown()).toEqual({ history: true, chooser: false });
    // 选择版本 in the return bar replaces history.
    await click(
      query("[data-save-status]")!.querySelector<HTMLButtonElement>("button"),
    );
    expect(shown()).toEqual({ history: false, chooser: true });
  });

  it("counts a no-save edit's existing items against the item limit", async () => {
    const itemId = (n: number) => `media-item-${String(n).repeat(32)}`;
    const items: WorkDraftItem[] = [1, 2].map((n) => ({
      key: `existing-${n}`,
      itemId: itemId(n),
      kind: "static",
      qualityMode: "standard",
      edit: { rotation: 0, crop: null },
    }));
    const ready = (id: string): PublishingMediaItem => ({
      id,
      kind: "static",
      qualityMode: "standard",
      state: "ready",
      failureCode: null,
      components: [],
      presentation: { width: 4, height: 3 },
      media: {
        thumbSrc: `/api/community/publishing/media/${id}/thumb/base`,
        displaySrc: `/api/community/publishing/media/${id}/display/base`,
      },
    });
    const editable: EditableWork = {
      workId: WORK_ID,
      revisionId: REVISION_ID,
      content: emptyContent({ title: "旧作", items }),
      mediaItems: items.map((item) => ready(item.itemId!)),
      visibility: "public",
      firstPublishedAt: T,
      editedAt: null,
      draftId: null,
      version: 1,
    };
    await renderEditor({ type: "work", id: WORK_ID }, () => {
      fn("limits").mockResolvedValue({
        maxItems: 2,
        originalItemMaxBytes: 1_000_000,
        standardComponentMaxBytes: 1_000_000,
        titleMax: 200,
        bodyMax: 10_000,
      });
      fn("editableWork").mockResolvedValue(editable);
      fn("openWorkEditDraft").mockRejectedValueOnce(
        clientError(409, "草稿数量已达上限", false, "draft_limit"),
      );
    });
    expect(draftSwitch()).toBeNull();
    expect(fn("openWorkEditDraft")).not.toHaveBeenCalled();
    await act(async () => {
      await staged.current!.stageFiles([fileOf(jpeg({}))], "picker");
    });
    await flush();
    let result: ReturnType<NonNullable<typeof staged.current>["confirm"]>;
    await act(async () => {
      result = staged.current!.confirm();
    });
    expect(result!).toMatchObject({ ok: false, error: "items_limit" });
    expect(fn("registerItem")).not.toHaveBeenCalled();
  });

  it("closes the phone preview on the browser's Back without leaving the editor", async () => {
    const harness = await renderEditor({ type: "new" });
    await goToPublish();
    await click(buttonByText("预览"));
    expect(
      document.querySelector('[data-editor-preview="phone"]'),
    ).not.toBeNull();
    expect(query("[data-editor-body]")?.hasAttribute("inert")).toBe(true);
    expect(harness.guard()?.("history")).toBe("blocked");
    await flush();
    expect(document.querySelector('[data-editor-preview="phone"]')).toBeNull();
    expect(query("[data-editor-body]")?.hasAttribute("inert")).toBe(false);
    expect(screen()).toBe("publish");
    expect(harness.controls.close).not.toHaveBeenCalled();
    // The next Back steps back to the start screen (no photos); with
    // nothing to protect there, the guard is released again.
    expect(harness.guard()?.("history")).toBe("blocked");
    await flush();
    expect(screen()).toBe("select");
    expect(harness.guard()).toBeNull();
  });

  it("steps the browser's Back 发布 → 编辑 → its back sheet, and a second Back closes the sheet", async () => {
    const harness = await renderEditor({ type: "new" });
    await act(async () => {
      await staged.current!.stageFiles([fileOf(jpeg({}))], "picker");
    });
    await flush();
    await act(async () => {
      expect(staged.current!.confirm().ok).toBe(true);
    });
    await flush();
    await flush();
    await goToPublish();
    await type(titleInput(), "三步返回");
    await click(buttonByText("预览"));
    // The preview closes first.
    expect(harness.guard()?.("history")).toBe("blocked");
    await flush();
    expect(document.querySelector('[data-editor-preview="phone"]')).toBeNull();
    expect(screen()).toBe("publish");
    expect(harness.guard()?.("history")).toBe("blocked");
    await flush();
    expect(screen()).toBe("edit");
    // A new work asks before it leaves 编辑 (r4 ASK-1).
    expect(harness.guard()?.("history")).toBe("blocked");
    await flush();
    const sheet = phoneSheet("edit-back");
    expect(sheet?.open).toBe(true);
    expect(
      [...sheet!.querySelectorAll("[data-back-action]")].map((action) => [
        action.getAttribute("data-back-action"),
        action.textContent,
      ]),
    ).toEqual([
      ["reselect", "重新选择照片"],
      ["leave", "存草稿并退出"],
      ["continue", "继续编辑"],
    ]);
    expect(screen()).toBe("edit");
    // The next Back closes it, as 继续编辑 would.
    expect(harness.guard()?.("history")).toBe("blocked");
    await flush();
    expect(phoneSheet("edit-back")).toBeNull();
    expect(screen()).toBe("edit");
    expect(query('[data-editor-dialog="leave"]')).toBeNull();
    expect(harness.controls.close).not.toHaveBeenCalled();
  });

  it("draws 封面构图 over 编辑 as its own screen from photo 1's sheet, and the browser's Back closes it first", async () => {
    const harness = await renderEditor({ type: "new" });
    await act(async () => {
      await staged.current!.stageFiles([fileOf(jpeg({}))], "picker");
    });
    await flush();
    await act(async () => {
      expect(staged.current!.confirm().ok).toBe(true);
    });
    await flush();
    await flush();
    expect(screen()).toBe("edit");
    // A tap on the current, healthy thumbnail: its sheet (r4 D11).
    await click(currentThumb());
    expect(phoneSheet("photo-menu")?.open).toBe(true);
    await click(
      document.querySelector<HTMLButtonElement>(
        '[data-media-action="compose-cover"]',
      ),
    );
    const cover = () =>
      document.querySelector<HTMLDialogElement>("dialog[data-phone-cover]");
    expect(cover()?.open).toBe(true);
    expect(phoneSheet("photo-menu")).toBeNull();
    // No desktop dialog with its ratio radios.
    expect(document.querySelector("[data-cover-crop-dialog]")).toBeNull();
    expect(harness.guard()?.("history")).toBe("blocked");
    await flush();
    expect(cover()).toBeNull();
    expect(screen()).toBe("edit");
    expect(phoneSheet("edit-back")).toBeNull();
    expect(query('[data-editor-dialog="leave"]')).toBeNull();
  });

  /** One photo staged and confirmed, as a finished pick leaves it. */
  const addPhotos = async (count = 1) => {
    await act(async () => {
      await staged.current!.stageFiles(
        Array.from({ length: count }, (_, index) =>
          fileOf(jpeg({ width: 4 + index })),
        ),
        "picker",
      );
    });
    await flush();
    await act(async () => {
      expect(staged.current!.confirm().ok).toBe(true);
    });
    await flush();
    await flush();
  };
  const escape = async (target: Element | null = document.activeElement) => {
    expect(target).not.toBeNull();
    let event: KeyboardEvent | null = null;
    await act(async () => {
      event = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      target!.dispatchEvent(event);
    });
    await flush();
    return event!;
  };
  const heading = () =>
    query<HTMLElement>("[data-editor-screen] [data-editor-step-heading]");

  it("enters 发布 from 编辑's 下一步 on its heading, never in 标题 (no keyboard over the 发布 bar)", async () => {
    await renderEditor({ type: "new" });
    await addPhotos();
    expect(screen()).toBe("edit");
    await click(query("[data-edit-next]"));
    expect(screen()).toBe("publish");
    expect(document.activeElement).toBe(heading());
    expect(document.activeElement).not.toBe(titleInput());
  });

  it("steps back a screen on Escape, 发布 → 编辑 → its back sheet, unless a field or a layer has it", async () => {
    const harness = await renderEditor({ type: "new" });
    await addPhotos();
    await goToPublish();
    // Typing in 标题: Escape is the field's.
    await act(async () => titleInput()!.focus());
    const typed = await escape();
    expect(typed.defaultPrevented).toBe(false);
    expect(screen()).toBe("publish");

    await act(async () => heading()!.focus());
    expect((await escape()).defaultPrevented).toBe(true);
    expect(screen()).toBe("edit");
    expect(document.activeElement).toBe(heading());

    // A photo's sheet open on 编辑 takes Escape itself and closes.
    await click(currentThumb());
    expect(phoneSheet("photo-menu")).not.toBeNull();
    await escape();
    expect(phoneSheet("photo-menu")).toBeNull();
    expect(phoneSheet("edit-back")).toBeNull();
    expect(screen()).toBe("edit");

    // Then Escape asks before leaving a new work, and the sheet's own
    // Escape closes it again.
    await act(async () => heading()!.focus());
    await escape();
    expect(phoneSheet("edit-back")?.open).toBe(true);
    await escape();
    expect(phoneSheet("edit-back")).toBeNull();
    expect(screen()).toBe("edit");
    expect(harness.controls.close).not.toHaveBeenCalled();

    // 存草稿并退出 saves the picks and leaves in one tap (r4 ASK-1).
    await receiveStill(harness);
    await act(async () => heading()!.focus());
    await escape();
    await click(query('[data-back-action="leave"]'));
    expect(fn("createDraft")).toHaveBeenCalledOnce();
    expect(query('[data-editor-dialog="leave"]')).toBeNull();
    expect(harness.controls.close).toHaveBeenCalledOnce();
  });

  it("closes a 编辑 sheet on the browser's Back before anything else", async () => {
    const harness = await renderEditor({ type: "new" });
    await addPhotos();
    await click(currentThumb());
    expect(phoneSheet("photo-menu")).not.toBeNull();
    expect(harness.guard()?.("history")).toBe("blocked");
    await flush();
    expect(phoneSheet("photo-menu")).toBeNull();
    expect(phoneSheet("edit-back")).toBeNull();
    expect(screen()).toBe("edit");
    expect(query('[data-editor-dialog="leave"]')).toBeNull();
  });

  it("hands 编辑's last removal to the start screen: 撤销 returns to the photo, Back commits it first", async () => {
    const harness = await renderEditor({ type: "new" });
    await addPhotos();
    const key = currentThumb()!.getAttribute("data-edit-thumb")!;
    await click(currentThumb());
    await click(
      document.querySelector<HTMLButtonElement>('[data-media-action="remove"]'),
    );
    expect(screen()).toBe("select");
    const toast = () => query("[data-select-toast]");
    const undo = () =>
      Array.from(document.querySelectorAll("[data-select-toast] button")).find(
        (button) => button.textContent === "撤销",
      ) ?? null;
    expect(toast()?.textContent).toBe("已移除第 1 项撤销");
    // Its upload is not cancelled while 撤销 is offered.
    expect(fn("cancelItem")).not.toHaveBeenCalled();

    // 撤销: 编辑 at the photo, its thumbnail focused (not the heading).
    await click(undo() as HTMLElement);
    expect(screen()).toBe("edit");
    expect(document.activeElement).toBe(query(`[data-edit-thumb="${key}"]`));
    expect(fn("cancelItem")).not.toHaveBeenCalled();

    // Again, then the browser's Back: committed first, as ‹ does.
    await click(currentThumb());
    await click(
      document.querySelector<HTMLButtonElement>('[data-media-action="remove"]'),
    );
    expect(screen()).toBe("select");
    expect(harness.guard()?.("history")).not.toBeUndefined();
    await flush();
    expect(fn("cancelItem")).toHaveBeenCalledOnce();
    expect(undo()).toBeNull();
    expect(screen()).toBe("select");
  });

  it("takes every photo back to the start screen with 重新选择照片, and 撤销 brings them back on 编辑", async () => {
    const harness = await renderEditor({ type: "new" });
    await addPhotos(2);
    expect(barTitle()).toContain("1 / 2");
    // The second photo is the one shown.
    await click(query('[data-edit-thumb]:not([aria-current="true"])'));
    expect(barTitle()).toContain("2 / 2");
    const shownKey = currentThumb()!.getAttribute("data-edit-thumb")!;
    await click(phoneBack());
    expect(phoneSheet("edit-back")?.open).toBe(true);
    await click(query('[data-back-action="reselect"]'));
    expect(phoneSheet("edit-back")).toBeNull();
    expect(screen()).toBe("select");
    expect(query("[data-select-toast]")?.textContent).toBe("已移除 2 项撤销");
    // Held until 撤销 ends: nothing is cancelled yet.
    expect(fn("cancelItem")).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(query("[data-media-picker] button"));

    await click(
      Array.from(document.querySelectorAll("[data-select-toast] button")).find(
        (button) => button.textContent === "撤销",
      ) as HTMLElement,
    );
    expect(screen()).toBe("edit");
    expect(barTitle()).toContain("2 / 2");
    expect(document.activeElement).toBe(
      query(`[data-edit-thumb="${shownKey}"]`),
    );

    // Again, and this time 撤销's time runs out: both photos go.
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout"],
      shouldAdvanceTime: true,
    });
    try {
      await click(phoneBack());
      await click(query('[data-back-action="reselect"]'));
      expect(screen()).toBe("select");
      await act(async () => {
        vi.advanceTimersByTime(4200);
      });
      await flush();
      expect(fn("cancelItem")).toHaveBeenCalledTimes(2);
      expect(screen()).toBe("select");
      expect(harness.controls.close).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("saves a new work's picks and leaves in one tap from 存草稿并退出, then says where they are", async () => {
    const harness = await renderEditor({ type: "new" });
    await addPhotos();
    await receiveStill(harness);
    expect(screen()).toBe("edit");
    // Production saves only on an explicit action (r6): no draft yet.
    expect(fn("createDraft")).not.toHaveBeenCalled();
    await click(phoneBack());
    await click(query('[data-back-action="leave"]'));
    await flush();
    // 存草稿并退出 is that action (r4 ASK-1): saved and left, with no
    // second question.
    expect(fn("createDraft")).toHaveBeenCalledTimes(1);
    expect(query('[data-editor-dialog="leave"]')).toBeNull();
    expect(harness.controls.close).toHaveBeenCalledOnce();
    expect(author.notify).toHaveBeenCalledExactlyOnceWith(
      "照片已存入草稿箱，可从草稿箱继续编辑。",
    );
    // The shell's guard then lets the editor go, saying nothing more.
    expect(harness.guard()?.("close")).toBe("allow");
    await flush();
    expect(query('[data-editor-dialog="leave"]')).toBeNull();
    expect(author.notify).toHaveBeenCalledOnce();
  });

  describe("存草稿并退出 while the picks upload", () => {
    const LEFT = "照片已存入草稿箱，可从草稿箱继续编辑。";
    const said = () =>
      (query("[data-media-announcer]")?.textContent ?? "").replaceAll(
        "\u200b",
        "",
      );
    const backAction = (name: string) =>
      query<HTMLButtonElement>(`[data-back-action="${name}"]`);
    /** A new work's pick, still uploading, and 存草稿并退出 chosen on 编辑. */
    const waitFromEdit = async () => {
      const harness = await renderEditor({ type: "new" });
      await addPhotos();
      expect(screen()).toBe("edit");
      await click(phoneBack());
      await click(backAction("leave"));
      // It waits for the pick's bytes (a saved draft holds uploaded photos
      // only, r6): the sheet stays and says so; nothing is saved yet.
      expect(phoneSheet("edit-back")?.open).toBe(true);
      expect(backAction("leave")?.textContent).toBe(
        "等待上传完成…已上传 0 / 1 项",
      );
      expect(fn("createDraft")).not.toHaveBeenCalled();
      expect(harness.controls.close).not.toHaveBeenCalled();
      return harness;
    };

    it("waits for the uploads, then saves and leaves as the one tap would", async () => {
      const harness = await waitFromEdit();
      expect(backAction("leave")?.getAttribute("aria-disabled")).toBe("true");
      expect(backAction("reselect")?.getAttribute("aria-disabled")).toBe(
        "true",
      );
      expect(backAction("continue")?.hasAttribute("aria-disabled")).toBe(false);
      // Said once as it starts, in the sheet's own polite region.
      expect(query("[data-wait-status]")?.textContent).toBe(
        "等待上传完成，已上传 0 / 1 项",
      );
      expect(query("[data-edit-notices]")).toBeNull();
      expect(query('[data-editor-dialog="leave"]')).toBeNull();
      expect(author.notify).not.toHaveBeenCalled();

      // The bytes are in (processing on the account is not waited for).
      await receiveStill(harness);
      await flush();
      expect(fn("createDraft")).toHaveBeenCalledTimes(1);
      expect(harness.controls.close).toHaveBeenCalledOnce();
      expect(query('[data-editor-dialog="leave"]')).toBeNull();
      expect(author.notify).toHaveBeenCalledExactlyOnceWith(LEFT);
      expect(harness.guard()?.("close")).toBe("allow");
      expect(author.notify).toHaveBeenCalledOnce();
      expect(fn("cancelItem")).not.toHaveBeenCalled();
    });

    it("ends the wait on 继续编辑: 编辑 stays, the upload goes on, nothing is saved", async () => {
      const harness = await waitFromEdit();
      await click(backAction("continue"));
      expect(phoneSheet("edit-back")).toBeNull();
      expect(screen()).toBe("edit");
      expect(document.activeElement).toBe(phoneBack());
      expect(said()).not.toContain("没有存草稿");
      await receiveStill(harness);
      await flush();
      expect(fn("createDraft")).not.toHaveBeenCalled();
      expect(harness.controls.close).not.toHaveBeenCalled();
      expect(author.notify).not.toHaveBeenCalled();
      expect(fn("cancelItem")).not.toHaveBeenCalled();

      // Asked again once the photo is in: one tap saves and leaves.
      await click(phoneBack());
      await click(backAction("leave"));
      await flush();
      expect(fn("createDraft")).toHaveBeenCalledTimes(1);
      expect(harness.controls.close).toHaveBeenCalledOnce();
      expect(author.notify).toHaveBeenCalledExactlyOnceWith(LEFT);
    });

    it("ends the wait on the browser's Back and on Escape, as 继续编辑", async () => {
      const harness = await waitFromEdit();
      expect(harness.guard()?.("history")).toBe("blocked");
      await flush();
      expect(phoneSheet("edit-back")).toBeNull();
      expect(screen()).toBe("edit");
      expect(query('[data-editor-dialog="leave"]')).toBeNull();

      await click(phoneBack());
      await click(backAction("leave"));
      expect(backAction("leave")?.hasAttribute("data-waiting")).toBe(true);
      await escape(backAction("leave"));
      expect(phoneSheet("edit-back")).toBeNull();
      expect(screen()).toBe("edit");

      await receiveStill(harness);
      await flush();
      expect(fn("createDraft")).not.toHaveBeenCalled();
      expect(harness.controls.close).not.toHaveBeenCalled();
      expect(author.notify).not.toHaveBeenCalled();
    });

    it("makes a removal waiting for 撤销 before it waits, and leaves no 撤销 once the wait ends", async () => {
      const harness = await renderEditor({ type: "new" });
      await addPhotos(2);
      expect(screen()).toBe("edit");
      // 移除 the photo shown: 编辑 goes on with the other, 撤销 offered.
      await click(currentThumb());
      await click(
        document.querySelector<HTMLButtonElement>(
          '[data-media-action="remove"]',
        ),
      );
      expect(screen()).toBe("edit");
      expect(query("[data-edit-toasts]")?.textContent).toBe(
        "已移除第 1 项撤销",
      );
      expect(query("[data-edit-undo]")).not.toBeNull();
      expect(fn("cancelItem")).not.toHaveBeenCalled();

      // 存草稿并退出 makes the removal first (it never waits for a photo on
      // its way out), and its 撤销 goes with it while the sheet waits.
      await click(phoneBack());
      await click(backAction("leave"));
      expect(backAction("leave")?.hasAttribute("data-waiting")).toBe(true);
      expect(fn("cancelItem")).toHaveBeenCalledOnce();
      expect(query("[data-edit-undo]")).toBeNull();
      expect(query("[data-edit-toasts]")?.textContent).toBe("");

      // 继续编辑 ends the wait: 编辑 with the one photo left, no 撤销 back.
      await click(backAction("continue"));
      expect(phoneSheet("edit-back")).toBeNull();
      expect(screen()).toBe("edit");
      expect(query("[data-edit-undo]")).toBeNull();
      expect(document.querySelectorAll("[data-edit-thumb]")).toHaveLength(1);
      expect(barTitle()).toContain("1 / 1");
      expect(fn("createDraft")).not.toHaveBeenCalled();
      expect(harness.controls.close).not.toHaveBeenCalled();
    });

    it("stops waiting when a photo fails, and says why on 编辑", async () => {
      const harness = await waitFromEdit();
      await act(async () => {
        harness.transfer.starts[0]!.callbacks.onSettled({
          status: 0,
          responseText: "",
          stalled: true,
        });
      });
      await flush();
      // The same refusal path: 编辑 as it was, the reason among its
      // notices, focus back on ‹, and the reason said by the announcer.
      const reason = "没有存草稿：第 1 项需要处理";
      expect(phoneSheet("edit-back")).toBeNull();
      expect(screen()).toBe("edit");
      expect(query("[data-edit-notices]")?.textContent).toContain(reason);
      expect(document.activeElement).toBe(phoneBack());
      expect(said()).toBe(reason);
      expect(fn("createDraft")).not.toHaveBeenCalled();
      expect(harness.controls.close).not.toHaveBeenCalled();
      expect(author.notify).not.toHaveBeenCalled();

      // Asked again while the photo still needs the author: no wait, the
      // runtime's own reason at once.
      await click(phoneBack());
      await click(backAction("leave"));
      await flush();
      expect(phoneSheet("edit-back")).toBeNull();
      expect(said()).toBe("图片还未准备好，请完成上传或移除失败项后保存草稿");
      expect(fn("createDraft")).not.toHaveBeenCalled();
      expect(harness.controls.close).not.toHaveBeenCalled();
    });

    it("saves nothing once the editor has gone during the wait", async () => {
      const harness = await waitFromEdit();
      await leaveOverlay(harness);
      await receiveStill(harness);
      await flush();
      expect(fn("createDraft")).not.toHaveBeenCalled();
      expect(harness.controls.close).not.toHaveBeenCalled();
      expect(author.notify).not.toHaveBeenCalled();
      expect(fn("cancelItem")).not.toHaveBeenCalled();
    });
  });

  it("says a cover reset by a move once, with the move's words, in one live region", async () => {
    const ids = [1, 2].map((n) => `media-item-${String(n).repeat(32)}`);
    const ready = (id: string): PublishingMediaItem => ({
      id,
      kind: "static",
      qualityMode: "standard",
      state: "ready",
      failureCode: null,
      components: [],
      presentation: { width: 4, height: 3 },
      media: {
        thumbSrc: `/api/community/publishing/media/${id}/thumb/base`,
        displaySrc: `/api/community/publishing/media/${id}/display/base`,
      },
    });
    const items: WorkDraftItem[] = ids.map((itemId, index) => ({
      key: `p${index + 1}`,
      itemId,
      kind: "static",
      qualityMode: "standard",
      edit: { rotation: 0, crop: null },
    }));
    await renderEditor({ type: "draft", id: DRAFT_ID }, () => {
      fn("draft").mockResolvedValue(
        draftOf(
          emptyContent({
            title: "封面",
            items,
            coverKey: "p1",
            coverCrop: { x: 0, y: 0, width: 0.5, height: 0.5 },
          }),
          { mediaItems: ids.map(ready) },
        ),
      );
    });
    expect(screen()).toBe("publish");
    await click(phoneBack());
    expect(screen()).toBe("edit");
    // Alt + → moves 第 2 项 to 首图: the chosen cover gives way (首图 = 封面).
    const second = query<HTMLButtonElement>('[data-edit-thumb="p2"]')!;
    await act(async () => second.focus());
    await act(async () => {
      second.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowRight",
          altKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await flush();
    expect(
      [...container!.querySelectorAll("[data-edit-thumb]")].map((thumb) =>
        thumb.getAttribute("data-edit-thumb"),
      ),
    ).toEqual(["p2", "p1"]);
    // One message in one region: the flow's announcer says the move and
    // the reset together; the toast says the same move, only seen.
    expect(
      (query("[data-media-announcer]")?.textContent ?? "").replaceAll(
        "\u200b",
        "",
      ),
    ).toBe("第 2 项已设为首图。封面构图已恢复为完整画面");
    const toast = query("[data-edit-toasts] span");
    expect(toast?.textContent).toBe("已设为首图");
    expect(toast?.getAttribute("aria-hidden")).toBe("true");
    expect(query("[data-media-notice]")?.textContent).toContain(
      "封面构图已恢复为完整画面",
    );
  });

  it("leaves 编辑 of a new work with 存草稿并退出, the upload kept, and reopens on 发布", async () => {
    const harness = await renderEditor({ type: "new" });
    await addPhotos();
    await receiveStill(harness);
    await goToPublish();
    await type(titleInput(), "上传中退出");
    await click(query("[data-editor-save-now]"));
    expect(fn("createDraft")).toHaveBeenCalledTimes(1);
    await click(phoneBack());
    expect(screen()).toBe("edit");
    // Still the work started here, though it is a draft now (r4 ASK-1).
    await click(phoneBack());
    await click(query('[data-back-action="leave"]'));
    await flush();
    // The photo's bytes are in (it is still processing): one tap saves and
    // leaves, with no dialog, and says where the photos are.
    expect(query('[data-editor-dialog="leave"]')).toBeNull();
    expect(harness.controls.close).toHaveBeenCalledOnce();
    expect(author.notify).toHaveBeenCalledExactlyOnceWith(
      "照片已存入草稿箱，可从草稿箱继续编辑。",
    );
    await leaveOverlay(harness);
    // The session is kept while its upload runs: + returns to it on 发布.
    await harness.show(true);
    expect(screen()).toBe("publish");
    expect(titleInput()?.value).toBe("上传中退出");
    expect(harness.transfer.starts.length).toBe(1);
    expect(fn("cancelItem")).not.toHaveBeenCalled();
  });

  it("closes 历史版本 on the browser's Back over 发布, staying there", async () => {
    const saved = draftOf(emptyContent({ title: "当前" }), { revision: 3 });
    const harness = await renderEditor({ type: "draft", id: DRAFT_ID }, () => {
      fn("draft").mockResolvedValue(saved);
    });
    await goToPublish();
    await click(query("[data-editor-menu]"));
    await click(query("[data-editor-menu-history]"));
    expect(query("[data-history-stub]")).not.toBeNull();
    expect(harness.guard()?.("history")).toBe("blocked");
    await flush();
    expect(query("[data-history-stub]")).toBeNull();
    expect(screen()).toBe("publish");
    expect(query('[data-editor-dialog="leave"]')).toBeNull();
  });

  it("goes to a reference field's sheet from 前往修改, focused on the field", async () => {
    await renderEditor({ type: "new" });
    await goToPublish();
    await type(titleInput(), "临兰亭");
    await click(
      authorshipChips().find(
        (chip) => chip.getAttribute("data-publish-choice") === "copy_practice",
      )!,
    );
    await click(query("[data-publish-references]"));
    const sheet = () =>
      document.querySelector<HTMLDialogElement>(
        'dialog[data-phone-sheet="references"]',
      );
    expect(sheet()?.open).toBe(true);
    expect(document.activeElement).toBe(
      document.querySelector('[data-editor-input="referenceTitle"]'),
    );
    await type(
      document.querySelector<HTMLTextAreaElement>(
        '[data-editor-input="sourceNote"]',
      ),
      "源".repeat(501),
    );
    await click(query("[data-publish-references-done]"));
    expect(sheet()).toBeNull();
    expect(submitBlocked()).toBe(true);
    await click(buttonByText("前往修改"));
    await nextFrames();
    expect(sheet()?.open).toBe(true);
    expect(document.activeElement).toBe(
      document.querySelector('[data-editor-input="sourceNote"]'),
    );
  });

  it("opens a draft that resumes on 发布 with focus on its heading, never in 标题 or on the page", async () => {
    const saved = draftOf(emptyContent({ title: "草稿标题" }), { revision: 2 });
    await renderEditor({ type: "draft", id: DRAFT_ID }, () => {
      fn("draft").mockResolvedValue(saved);
    });
    await nextFrames();
    expect(screen()).toBe("publish");
    expect(titleInput()?.value).toBe("草稿标题");
    expect(titleInput()?.hasAttribute("data-editor-autofocus")).toBe(false);
    expect(document.activeElement).toBe(heading());
  });

  describe("a re-selected missing photo", () => {
    /** A draft whose one photo's file is not on this device. */
    const missingDraft = () =>
      draftOf(
        emptyContent({
          items: [
            {
              key: "missing",
              itemId: null,
              kind: "static",
              qualityMode: "standard",
              edit: { rotation: 0, crop: null },
              pendingLabel: "photo",
            },
          ],
        }),
      );
    const reselectWith = async (file: File) => {
      const input = query<HTMLInputElement>(
        'input[aria-label="重新选择缺少的文件"]',
      )!;
      expect(input).not.toBeNull();
      Object.defineProperty(input, "files", {
        configurable: true,
        value: [file],
      });
      await act(async () => {
        input.dispatchEvent(new Event("change", { bubbles: true }));
        await settle();
      });
      await flush();
      await flush();
    };
    /** The first photo's key: its thumbnail on 编辑. */
    const firstKey = () =>
      query("[data-edit-thumb]")?.getAttribute("data-edit-thumb") ?? null;

    it("resumes on 编辑 at it and hands focus from its thumbnail to its replacement's", async () => {
      await renderEditor({ type: "draft", id: DRAFT_ID }, () => {
        fn("draft").mockResolvedValue(missingDraft());
      });
      await nextFrames();
      // It resumes on 编辑 at the photo: it needs the author (r4 D7).
      expect(screen()).toBe("edit");
      expect(phoneSheet("photo-attention")).toBeNull();
      // A tap on it focuses it: its fix sheet gives focus back to it.
      await act(async () => currentThumb()!.focus());
      await click(currentThumb());
      expect(phoneSheet("photo-attention")?.open).toBe(true);
      // 重新选择 closes the sheet before it opens the picker (r4 D19).
      const opened: boolean[] = [];
      vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {
        opened.push(document.querySelector("dialog[open]") === null);
      });
      await click(buttonByText("重新选择"));
      expect(opened).toEqual([true]);
      expect(document.activeElement).toBe(query('[data-edit-thumb="missing"]'));
      await reselectWith(fileOf(jpeg({ width: 6 }), "found.jpg"));
      expect(screen()).toBe("edit");
      const replacement = firstKey();
      expect(replacement).not.toBeNull();
      expect(replacement).not.toBe("missing");
      expect(document.activeElement).toBe(
        query(`[data-edit-thumb="${replacement}"]`),
      );
    });
  });

  it("holds 发布 while a submission is in flight: Back says 正在确认结果…, ‹ and Escape stay", async () => {
    const harness = await renderEditor({ type: "work", id: WORK_ID }, () => {
      fn("editableWork").mockResolvedValue({
        workId: WORK_ID,
        revisionId: REVISION_ID,
        content: emptyContent(),
        mediaItems: [],
        visibility: "public",
        firstPublishedAt: T,
        editedAt: null,
        draftId: null,
        version: 1,
      });
    });
    let answerReceipt: (value: unknown) => void = () => undefined;
    fn("submit").mockRejectedValueOnce(
      clientError(0, "网络连接中断，结果尚未确认", true),
    );
    fn("submissionReceipt").mockImplementationOnce(
      (requestId: string) =>
        new Promise((resolve) => {
          answerReceipt = () => resolve(receipt(requestId));
        }),
    );
    await goToPublish();
    await type(bodyInput(), "只有正文");
    await click(query("[data-editor-submit]"));
    expect(query("[data-publish-reason]")?.textContent).toBe("正在确认结果…");

    // The browser's Back: no step back to 选择照片 (where the work could
    // change under the submission), the leave guard's 正在确认结果… instead.
    expect(harness.guard()?.("history")).toBe("blocked");
    await flush();
    expect(screen()).toBe("publish");
    expect(
      document.querySelector('[data-editor-dialog="leave"] h2')?.textContent,
    ).toBe("正在确认结果…");
    await click(buttonByText("继续等待"));

    // ‹, 添加照片 and Escape stay on 发布 too.
    await click(phoneBack());
    expect(screen()).toBe("publish");
    await click(query("[data-publish-add] button"));
    expect(screen()).toBe("publish");
    await act(async () => heading()!.focus());
    await escape();
    expect(screen()).toBe("publish");
    expect(harness.controls.close).not.toHaveBeenCalled();

    await act(async () => answerReceipt(null));
    await flush();
    expect(fn("submit")).toHaveBeenCalledTimes(1);
    expect(harness.controls.completeWith).toHaveBeenCalledWith({
      type: "work",
      id: WORK_ID,
    });
  });

  it("lands on 编辑 「1 / 1」 once a pick from the start screen's 选择照片 is in", async () => {
    await renderEditor({ type: "new" });
    expect(screen()).toBe("select");
    const input = query<HTMLInputElement>(
      '[data-media-picker] input[type="file"][multiple]',
    )!;
    const opened = vi
      .spyOn(HTMLInputElement.prototype, "click")
      .mockImplementation(() => undefined);
    await click(query('[data-start-option="photos"]'));
    expect(opened).toHaveBeenCalledOnce();
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [fileOf(jpeg({}))],
    });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await settle();
    });
    await flush();
    await flush();
    expect(screen()).toBe("edit");
    expect(barTitle()).toContain("1 / 1");
    expect(fn("registerItem")).toHaveBeenCalledOnce();
  });

  describe("专题 and 草稿箱 on the start screen", () => {
    const ARTICLE_ID = `article-draft-${"d".repeat(32)}`;
    const created = () => ({ id: ARTICLE_ID, ownerId: ACCOUNT });
    const topic = () => query<HTMLButtonElement>('[data-start-option="topic"]');
    const drafts = () => query<HTMLButtonElement>("[data-start-drafts]");
    /** A create that answers only when told to. */
    const pendingCreate = () => {
      let answer: (value: unknown) => void = () => undefined;
      let fail: (error: unknown) => void = () => undefined;
      articles.create = vi.fn(
        () =>
          new Promise((resolve, reject) => {
            answer = resolve;
            fail = reject;
          }),
      );
      return {
        answer: async (value: unknown) => {
          await act(async () => answer(value));
          await flush();
        },
        fail: async (error: unknown) => {
          await act(async () => fail(error));
          await flush();
        },
      };
    };

    it("offers both on an untouched new phone work, and neither once it is not", async () => {
      await renderEditor({ type: "new" }, undefined, { articles: true });
      expect(topic()?.textContent).toBe("专题");
      expect(topic()?.querySelector('[data-icon="academic-cap"]')).not.toBe(
        null,
      );
      expect(drafts()?.textContent).toBe("草稿箱");
      // Text typed (跳过 → 发布 → typed → back): no longer untouched.
      await goToPublish();
      await type(titleInput(), "已有标题");
      await click(phoneBack());
      expect(screen()).toBe("select");
      expect(topic()).toBeNull();
      expect(drafts()).toBeNull();
    });

    it("offers neither on 参与话题, a draft, a work, or with 专题文章 off", async () => {
      await renderEditor({ type: "new", threadId: "thread-1" }, undefined, {
        articles: true,
      });
      expect(screen()).toBe("select");
      expect(topic()).toBeNull();
      expect(drafts()).toBeNull();
      await act(async () => root?.unmount());
      container?.remove();

      await renderEditor(
        { type: "draft", id: DRAFT_ID },
        () => fn("draft").mockResolvedValue(draftOf(emptyContent())),
        { articles: true },
      );
      expect(screen()).toBe("select");
      expect(topic()).toBeNull();
      await act(async () => root?.unmount());
      container?.remove();

      // A published work, its text only: back from 发布 to the start screen.
      await renderEditor(
        { type: "work", id: WORK_ID },
        () => {
          fn("editableWork").mockResolvedValue({
            workId: WORK_ID,
            revisionId: REVISION_ID,
            content: emptyContent({ title: "旧作" }),
            mediaItems: [],
            visibility: "public",
            firstPublishedAt: T,
            editedAt: null,
            draftId: null,
            version: 1,
          } satisfies EditableWork);
          fn("openWorkEditDraft").mockResolvedValue(
            openedDraft(
              draftOf(emptyContent({ title: "旧作" }), {
                id: EDIT_DRAFT_ID,
                kind: "edit",
                workId: WORK_ID,
                baseRevisionId: REVISION_ID,
              }),
            ),
          );
        },
        { articles: true },
      );
      await goToPublish();
      await click(phoneBack());
      expect(screen()).toBe("select");
      expect(topic()).toBeNull();
      expect(drafts()).toBeNull();
      await act(async () => root?.unmount());
      container?.remove();

      await renderEditor({ type: "new" });
      expect(screen()).toBe("select");
      expect(topic()).toBeNull();
      expect(drafts()).toBeNull();
    });

    it("creates a 专题 draft and opens the article editor in place; the empty session ends", async () => {
      const harness = await renderEditor({ type: "new" }, undefined, {
        articles: true,
      });
      // The opening's own focus has landed (选择照片).
      await nextFrames();
      const create = pendingCreate();
      const firstKey =
        query("[data-phone-flow]")?.getAttribute("data-phone-flow");
      await click(topic());
      expect(articles.create).toHaveBeenCalledOnce();
      expect(vi.mocked(articles.create).mock.calls[0]![0]).toMatchObject({
        title: "",
        coverRefId: null,
      });
      // Focus fell to the page while it was created (a browser drops it
      // from 选择照片, disabled meanwhile; jsdom keeps it there).
      await act(async () => {
        heading()!.focus();
        heading()!.blur();
      });
      expect(document.activeElement).toBe(document.body);
      await create.answer(created());
      expect(harness.controls.replaceTarget).toHaveBeenCalledWith({
        type: "article-draft",
        id: ARTICLE_ID,
      });
      expect(author.notify).not.toHaveBeenCalled();
      // The shell's focus follows a new session only: ‹ takes it now.
      await nextFrames();
      expect(document.activeElement).toBe(
        harness.controls.backButtonRef.current,
      );
      // The shell swaps the overlay: the empty work session ends.
      await leaveOverlay(harness);
      await harness.show(true);
      expect(
        query("[data-phone-flow]")?.getAttribute("data-phone-flow"),
      ).not.toBe(firstKey);
      expect(query("[data-editor-other-session]")).toBeNull();
    });

    it("holds the editor while 专题 creates: Back, close and a reload wait, ‹ and Escape do nothing", async () => {
      const harness = await renderEditor({ type: "new" }, undefined, {
        articles: true,
      });
      const create = pendingCreate();
      // The tap focuses 专题, which keeps focus as it turns busy (it waits
      // with aria-disabled, never a native disabled under focus).
      await act(async () => topic()!.focus());
      await click(topic());
      expect(topic()?.textContent).toBe("正在创建…");
      expect(topic()?.getAttribute("aria-busy")).toBe("true");
      expect(topic()?.getAttribute("aria-disabled")).toBe("true");
      expect(document.activeElement).toBe(topic());
      expect(
        query<HTMLButtonElement>('[data-start-option="photos"]')?.getAttribute(
          "aria-disabled",
        ),
      ).toBe("true");
      expect(drafts()?.getAttribute("aria-disabled")).toBe("true");
      for (const reason of ["history", "close", "unload"] as const)
        expect(harness.guard()?.(reason)).toBe("blocked");
      await flush();
      expect(query('[data-editor-dialog="leave"]')).toBeNull();
      expect(phoneBack()?.getAttribute("aria-disabled")).toBe("true");
      await click(phoneBack());
      await act(async () => heading()!.focus());
      await escape();
      expect(harness.controls.close).not.toHaveBeenCalled();
      expect(screen()).toBe("select");

      await create.answer(created());
      expect(harness.controls.replaceTarget).toHaveBeenCalledWith({
        type: "article-draft",
        id: ARTICLE_ID,
      });
      // Nothing holds the editor any more.
      expect(harness.guard()).toBeNull();
    });

    it("tells the author where a 专题 draft confirmed after the editor went is", async () => {
      const harness = await renderEditor({ type: "new" }, undefined, {
        articles: true,
      });
      const create = pendingCreate();
      await click(topic());
      // The session ended elsewhere (the guard cannot hold that).
      await harness.show(false);
      await create.answer(created());
      expect(author.notify).toHaveBeenCalledExactlyOnceWith(
        ARTICLE_DRAFT_ORPHAN_NOTICE,
      );
      expect(harness.controls.replaceTarget).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "article-draft" }),
      );
    });

    it("says why a create was not confirmed, and the retry confirms the same one", async () => {
      await renderEditor({ type: "new" }, undefined, { articles: true });
      const first = pendingCreate();
      await act(async () => topic()!.focus());
      await click(topic());
      await first.fail(new TypeError("network"));
      // 专题 kept focus through the create: the start screen stays usable
      // from the keyboard (Escape included).
      expect(document.activeElement).toBe(topic());
      const notice = query("[data-start-topic-notice]");
      expect(notice?.getAttribute("role")).toBe("alert");
      expect(notice?.textContent).toBe(
        "创建结果尚未确认，重试会确认同一次创建。",
      );
      expect(topic()?.textContent).toBe("重试确认创建");
      const requestId = vi.mocked(articles.create).mock.calls[0]![0].requestId;
      const second = pendingCreate();
      await click(topic());
      expect(vi.mocked(articles.create).mock.calls[0]![0].requestId).toBe(
        requestId,
      );
      await second.answer(created());
    });

    it("opens 草稿箱 by the article editor's route; the empty session ends", async () => {
      const harness = await renderEditor({ type: "new" }, undefined, {
        articles: true,
      });
      const firstKey =
        query("[data-phone-flow]")?.getAttribute("data-phone-flow");
      await click(drafts());
      expect(harness.controls.replaceTarget).toHaveBeenCalledWith({
        type: "article-list",
      });
      // No 草稿箱 return is set here: the article host sets its own.
      await leaveOverlay(harness);
      await harness.show(true);
      expect(
        query("[data-phone-flow]")?.getAttribute("data-phone-flow"),
      ).not.toBe(firstKey);
    });

    it("lets 专题 and 草稿箱 wait while 编辑's photos are held for 撤销", async () => {
      await renderEditor({ type: "new" }, undefined, { articles: true });
      await addPhotos();
      expect(topic()).toBeNull();
      await click(currentThumb());
      await click(
        document.querySelector<HTMLButtonElement>(
          '[data-media-action="remove"]',
        ),
      );
      expect(screen()).toBe("select");
      // The work counts as untouched (the held photo aside), but waits.
      expect(topic()?.getAttribute("aria-disabled")).toBe("true");
      expect(drafts()?.getAttribute("aria-disabled")).toBe("true");
    });
  });

  it("shows 编辑 at photo 1 after a desktop → phone swap on the media step", async () => {
    await setViewport("pc", 1280);
    await renderEditor({ type: "new" });
    expect(query('[data-editor-layout="desktop"]')).not.toBeNull();
    await addPhotos(2);
    // Out of 标题 (a field being typed in follows the swap to 发布).
    await nextFrames();
    await act(async () => (document.activeElement as HTMLElement)?.blur());
    await flush();
    await setViewport("phone", 390);
    await nextFrames();
    expect(screen()).toBe("edit");
    expect(barTitle()).toContain("1 / 2");
  });

  it("adds from 编辑's + sheet in the 原图画质 chosen there", async () => {
    await renderEditor({ type: "new" });
    await addPhotos();
    expect(fn("registerItem")).toHaveBeenCalledOnce();
    expect(fn("registerItem").mock.calls[0]![0]).toMatchObject({
      qualityMode: "standard",
    });
    await click(query("[data-edit-add]"));
    const sheet = phoneSheet("add");
    expect(sheet?.open).toBe(true);
    await click(
      sheet!.querySelector<HTMLButtonElement>(
        '[data-editor-switch="original"] [role="switch"]',
      ),
    );
    expect(
      window.localStorage.getItem("yoyi.publishing.original-quality"),
    ).toBe("original");
    const opened = vi
      .spyOn(HTMLInputElement.prototype, "click")
      .mockImplementation(() => undefined);
    await click(query('[data-add-option="photos"]'));
    expect(opened).toHaveBeenCalledOnce();
    expect(phoneSheet("add")).toBeNull();
    const input = opened.mock.contexts[0] as HTMLInputElement;
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [fileOf(jpeg({ width: 7 }))],
    });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await settle();
    });
    await flush();
    await flush();
    expect(fn("registerItem")).toHaveBeenCalledTimes(2);
    expect(fn("registerItem").mock.calls[1]![0]).toMatchObject({
      qualityMode: "original",
    });
    // The stage stays on the photo being edited.
    expect(barTitle()).toContain("1 / 2");
    window.localStorage.clear();
  });
});
