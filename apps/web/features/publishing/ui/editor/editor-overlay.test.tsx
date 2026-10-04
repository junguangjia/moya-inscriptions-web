// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { author, shell, client, versions } = vi.hoisted(() => ({
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
vi.mock("../../../product-shell/product-shell", () => ({
  useProductShell: () => shell,
}));
vi.mock("../../publishing-data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../publishing-data")>()),
  publishingClient: client,
}));
// The media section (C1b) and the drafts panels (C3) have their own tests.
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
  options: { readonly recovery?: LocalRecoveryStore } = {},
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
      <PublishingProvider services={services}>
        <EditorSessionProvider>
          <StagingProbe />
          {shown ? (
            <EditorOverlay controls={controls} target={current} />
          ) : null}
        </EditorSessionProvider>
      </PublishingProvider>,
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
const step = () =>
  query("[data-editor-step]")?.getAttribute("data-editor-step") ?? null;
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

const goToStep = async (target: "text" | "confirm") => {
  if (step() === "media") {
    await click(query("[data-media-skip]") ?? buttonByText("下一步"));
  }
  if (target === "confirm" && step() === "text")
    await click(buttonByText("下一步"));
  expect(step()).toBe(target);
};

beforeEach(() => {
  shell.platform = "phone";
  shell.orientation = "portrait";
  author.viewer = { id: ACCOUNT, displayName: "测试作者" };
  author.notify = vi.fn();
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
});

describe("Publishing editor", () => {
  it("r6 synchronizes only explicit saves and keeps the same latest draft without a snapshot call", async () => {
    const harness = await renderEditor({ type: "new" });
    expect(draftSwitch()).toBeNull();
    expect(query("[data-editor-save-now]")?.textContent).toBe("保存草稿");
    await goToStep("text");
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
    await goToStep("text");
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

    await goToStep("text");
    await type(titleInput(), "临兰亭序");
    await type(bodyInput(), "第一行\n第二行");
    await click(buttonByText("上一步"));
    expect(step()).toBe("media");
    await click(buttonByText("下一步") ?? query("[data-media-skip]"));
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

  it("switches a tablet between the phone steps and the desktop editor at 896px, keeping the field being typed in", async () => {
    await setViewport("tablet", 895);
    await renderEditor({ type: "new" });
    await nextFrames();
    expect(query('[data-editor-layout="phone"]')).not.toBeNull();
    await goToStep("text");
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
    expect(step()).toBe("text");
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
    await goToStep("text");
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
    expect(step()).toBe("text");
    expect(titleInput()?.value).toBe("上传中离开");
    await click(buttonByText("上一步"));
    expect(query("[data-media-section]")).not.toBeNull();
    expect(harness.transfer.starts.length).toBe(1);
    expect(fn("cancelItem")).not.toHaveBeenCalled();
  });

  it("ends a clean session when the editor is left", async () => {
    const harness = await renderEditor({ type: "new" });
    const firstKey = query("[data-media-section]")?.getAttribute(
      "data-media-section",
    );
    expect(harness.guard()).toBeNull();
    await harness.show(false);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await flush();
    await harness.show(true);
    const secondKey = query("[data-media-section]")?.getAttribute(
      "data-media-section",
    );
    expect(secondKey).toBeTruthy();
    expect(secondKey).not.toBe(firstKey);
    expect(query("[data-editor-other-session]")).toBeNull();
  });

  it("lets a text-only work skip the media step", async () => {
    await renderEditor({ type: "new" });
    expect(step()).toBe("media");
    await click(query("[data-media-skip]"));
    expect(step()).toBe("text");
    expect(titleInput()).not.toBeNull();
    expect(query("[data-editor-recommendation]")?.textContent).toBe(
      "建议添加标题和图片",
    );
    // A step change moves focus to the new step's heading.
    expect(document.activeElement?.textContent).toBe("文字与设置");
  });

  it("focuses the first control on open and previews the real work presentation on a phone", async () => {
    await renderEditor({ type: "new" });
    // Focus moves after the shell's own focus, in the next animation frame.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(document.activeElement).toBe(
      query('[data-editor-switch="original"] button'),
    );

    await goToStep("text");
    await type(titleInput(), "预览标题");
    await type(bodyInput(), "正文\n第二行");
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
    await goToStep("text");
    const authorshipState = () =>
      query("[data-editor-authorship-state]")?.getAttribute(
        "data-editor-authorship-state",
      );
    const radios = () =>
      Array.from(
        document.querySelectorAll<HTMLInputElement>(
          '[data-editor-field="authorship"] input[type="radio"]',
        ),
      );
    // C05: nothing is claimed for the author before they choose.
    expect(authorshipState()).toBe("unset");
    expect(query("[data-editor-authorship-state]")?.textContent).toContain(
      "未设置",
    );
    expect(radios().every((radio) => !radio.checked)).toBe(true);
    expect(query("[data-editor-authorship-clear]")).toBeNull();
    expect(query("[data-editor-references]")).toBeNull();

    await goToStep("confirm");
    expect(
      query("[data-editor-summary-authorship]")?.getAttribute(
        "data-editor-summary-authorship",
      ),
    ).toBe("unset");
    expect(query("[data-editor-summary-authorship]")?.textContent).toBe(
      "未设置",
    );
    await click(buttonByText("上一步"));

    await act(async () => {
      radios()
        .find((radio) => radio.value === "original")!
        .click();
    });
    expect(authorshipState()).toBe("original");
    expect(query("[data-editor-authorship-state]")?.textContent).toContain(
      "原创",
    );

    // The choice can be taken back; 未设置 is not a kind of its own.
    await click(query("[data-editor-authorship-clear]"));
    expect(authorshipState()).toBe("unset");
    expect(radios().every((radio) => !radio.checked)).toBe(true);
    // 清除选择 goes away with the choice it cleared: the keyboard stays in
    // the field instead of dropping to the page.
    expect(document.activeElement).toBe(radios()[0]);

    await type(titleInput(), "未声明性质的作品");
    await goToStep("confirm");
    expect(query("[data-editor-summary-authorship]")?.textContent).toBe(
      "未设置",
    );
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

    await click(buttonByText("下一步"));
    await click(buttonByText("下一步"));
    expect(step()).toBe("confirm");
    expect(query("[data-editor-readiness]")?.textContent).toBe(
      "1 项仍在上传，1 项失败。全部就绪或移除后才能发布",
    );
    expect(query<HTMLButtonElement>("[data-editor-submit]")?.disabled).toBe(
      true,
    );
    expect(fn("submit")).not.toHaveBeenCalled();
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
      await goToStep("confirm");
      expect(query("[data-editor-readiness]")?.textContent).toBe(
        "1 项正在处理。全部就绪或移除后才能发布",
      );
      expect(query<HTMLButtonElement>("[data-editor-submit]")?.disabled).toBe(
        true,
      );
      // The debounced check asks with the draft as holder; the answer still names the item.
      await fireTimers(harness);
      expect(fn("readiness")).toHaveBeenCalledTimes(1);
      expect(fn("readiness").mock.calls[0]![0]).toEqual({ draftId: DRAFT_ID });
      expect(fn("readiness").mock.calls[0]![1]).toMatchObject({
        items: [{ key: "turned", edit: { rotation: 90, crop: null } }],
      });
      expect(query("[data-editor-readiness]")?.textContent).toBe(
        "1 项正在处理。全部就绪或移除后才能发布",
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
      expect(query<HTMLButtonElement>("[data-editor-submit]")?.disabled).toBe(
        false,
      );
    });

    it("shows the pending count of a not_ready submission and keeps asking instead of a bare error", async () => {
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
      await goToStep("confirm");
      expect(query("[data-editor-readiness]")?.textContent).toBe(
        "全部 1 项已就绪",
      );
      await click(query("[data-editor-submit]"));
      expect(fn("submit")).toHaveBeenCalledTimes(1);
      expect(query("[data-editor-submission='not_ready']")?.textContent).toBe(
        "1 项正在处理，完成后可再发布",
      );
      expect(query("[data-editor-readiness]")?.textContent).toBe(
        "1 项正在处理。全部就绪或移除后才能发布",
      );
      expect(query("[data-editor-issues]")).toBeNull();
      expect(query<HTMLButtonElement>("[data-editor-submit]")?.disabled).toBe(
        true,
      );
      // The account is asked again; once ready the sheet lets the author publish.
      fn("readiness").mockResolvedValueOnce({
        ready: true,
        pendingItemKeys: [],
        failedItemKeys: [],
        editKeys: {},
      });
      await fireTimers(harness);
      expect(fn("readiness")).toHaveBeenCalledTimes(1);
      expect(query("[data-editor-readiness]")?.textContent).toBe(
        "全部 1 项已就绪",
      );
      expect(query("[data-editor-submission='not_ready']")?.textContent).toBe(
        "",
      );
      expect(query<HTMLButtonElement>("[data-editor-submit]")?.disabled).toBe(
        false,
      );
      await click(query("[data-editor-submit]"));
      expect(fn("submit")).toHaveBeenCalledTimes(2);
      expect(harness.controls.completeWith).toHaveBeenCalledWith({
        type: "work",
        id: WORK_ID,
      });
    });
  });

  it("submits once and opens the submitted work on success", async () => {
    const harness = await renderEditor({ type: "new" });
    await goToStep("text");
    await type(titleInput(), "新作");
    await goToStep("confirm");
    expect(query("[data-editor-summary='text']")).toBeNull();
    expect(query("[data-editor-summary-visibility]")?.textContent).toBe("公开");
    await click(query("[data-editor-submit]"));
    expect(fn("submit")).toHaveBeenCalledTimes(1);
    expect(fn("submit").mock.calls[0]![0]).toMatchObject({
      holder: { sessionId: SESSION_ID },
      content: { title: "新作", visibility: "public" },
      baseRevisionId: null,
    });
    expect(harness.controls.completeWith).toHaveBeenCalledWith({
      type: "work",
      id: WORK_ID,
    });
    expect(author.notify).toHaveBeenCalledWith("作品已提交");
  });

  it("shows 正在确认结果… for a lost answer and completes on the receipt", async () => {
    const harness = await renderEditor({ type: "new" });
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
    await goToStep("text");
    await type(bodyInput(), "只有正文");
    await goToStep("confirm");
    expect(query("[data-editor-summary='text']")?.textContent).toBe("只有正文");
    expect(query("[data-unnamed]")?.textContent).toBe("未命名作品");
    await click(query("[data-editor-submit]"));
    expect(query("[data-editor-submission]")?.textContent).toBe(
      "正在确认结果…",
    );
    expect(harness.controls.completeWith).not.toHaveBeenCalled();
    // Leaving now would lose the result: the guard holds the editor.
    expect(harness.guard()?.("close")).toBe("blocked");
    await flush();
    expect(
      document.querySelector('[data-editor-dialog="leave"] h2')?.textContent,
    ).toBe("正在确认结果…");
    await click(buttonByText("继续等待"));
    await act(async () => answerReceipt(null));
    await flush();
    expect(fn("submit")).toHaveBeenCalledTimes(1);
    expect(harness.controls.completeWith).toHaveBeenCalledWith({
      type: "work",
      id: WORK_ID,
    });
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
    await goToStep("text");
    await type(titleInput(), "标题");
    await goToStep("confirm");
    await click(query("[data-editor-submit]"));
    await click(buttonByText("前往查看"));
    expect(step()).toBe("text");
    expect(
      query('[data-editor-field="title"]')?.querySelector("p")?.textContent,
    ).toBe("标题过长");
  });

  it("offers 保存草稿并离开 / 继续编辑 / 放弃本次未保存的更改 for unsaved draft changes", async () => {
    const harness = await renderEditor({ type: "new" });
    await goToStep("text");
    await type(titleInput(), "草稿标题");
    await flush();
    expect(query("[data-save-status]")?.textContent).toContain(
      "有未保存的更改",
    );
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
    await goToStep("text");
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
    await goToStep("text");
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
    await goToStep("text");
    expect(titleInput()?.value).toBe("旧作");
    const checked = query<HTMLInputElement>(
      '[data-editor-field="visibility"] input:checked',
    );
    expect(checked?.value).toBe("self");
    await goToStep("confirm");
    expect(query("[data-editor-summary-visibility]")?.textContent).toBe(
      "仅自己可见",
    );
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
    await goToStep("text");
    expect(
      query("[data-editor-authorship-state]")?.getAttribute(
        "data-editor-authorship-state",
      ),
    ).toBe("unset");
    expect(
      document.querySelector('[data-editor-field="authorship"] input:checked'),
    ).toBeNull();
    await type(titleInput(), "旧作（改）");
    await goToStep("confirm");
    expect(query("[data-editor-summary-authorship]")?.textContent).toBe(
      "未设置",
    );
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
    expect(titleInput() ?? query("[data-media-section]")).not.toBeNull();
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
    await goToStep("text");
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
    await goToStep("text");
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

  it("continues saving from a restored history version", async () => {
    const saved = draftOf(emptyContent({ title: "当前" }), { revision: 3 });
    await renderEditor({ type: "draft", id: DRAFT_ID }, () => {
      fn("draft").mockResolvedValue(saved);
    });
    await goToStep("text");
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
    await goToStep("text");
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
    await goToStep("text");
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
    await goToStep("text");
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
    await goToStep("text");
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
    await goToStep("text");
    await click(buttonByText("预览"));
    expect(
      document.querySelector('[data-editor-preview="phone"]'),
    ).not.toBeNull();
    expect(query("[data-editor-body]")?.hasAttribute("inert")).toBe(true);
    expect(harness.guard()?.("history")).toBe("blocked");
    await flush();
    expect(document.querySelector('[data-editor-preview="phone"]')).toBeNull();
    expect(query("[data-editor-body]")?.hasAttribute("inert")).toBe(false);
    expect(harness.controls.close).not.toHaveBeenCalled();
    // Nothing to protect afterwards: the guard is released again.
    expect(harness.guard()).toBeNull();
  });
});
