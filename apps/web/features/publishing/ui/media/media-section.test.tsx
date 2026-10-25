// @vitest-environment jsdom
import { act, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { author, crop } = vi.hoisted(() => ({
  author: {
    viewer: { id: `user-${"a".repeat(32)}` } as { id: string } | null,
    checking: false,
  },
  crop: {
    props: null as null | {
      aspect: number;
      rotation: number;
      initialCroppedAreaPercentages?: {
        x: number;
        y: number;
        width: number;
        height: number;
      };
      onCropAreaChange: (
        area: { x: number; y: number; width: number; height: number },
        pixels: { x: number; y: number; width: number; height: number },
      ) => void;
    },
  },
}));
vi.mock("../../../authors/author-context", () => ({
  useAuthors: () => author,
}));
vi.mock("react-easy-crop", () => ({
  default: (props: NonNullable<typeof crop.props>) => {
    crop.props = props;
    return <div data-test-cropper="" />;
  },
}));

import { identifyFiles } from "../../import-grouping";
import {
  IDENTIFIER,
  OTHER_IDENTIFIER,
  animatedGif,
  fileOf,
  heic,
  jpeg,
  motion,
  png,
} from "../../parsers/synthetic-media.test-support";
import {
  PublishingProvider,
  useUploadSession,
} from "../../publishing-provider";
import { UploadManager } from "../../upload-manager";
import {
  ACCOUNT,
  DRAFT_ID,
  SESSION_ID,
  absentMetadata,
  fakeClient,
  fakePreprocess,
  fakeTransfer,
  manualTimers,
  settle,
  uuid,
} from "../../upload-manager.test-support";
import {
  EditorSessionProvider,
  useEditorSession,
  useEditorSessionRegistry,
} from "../editor/editor-session-provider";
import { COVER_RESET_NOTICE, keepCoverOnFirst } from "../phone/cover-rule";
import { MediaSection } from "./media-section";
import { mediaUiFor } from "./media-ui-store";
import { useMediaActions } from "./use-media-actions";

import type {
  PublishingClientPort,
  PublishingServices,
} from "../../publishing-runtime";
import type { EditDraft } from "./media-ui-store";
import type {
  MediaActions,
  MediaActionsOptions,
  StageOutcome,
} from "./use-media-actions";
import type { EditorSessionHandle } from "../editor/editor-session-provider";
import type { EditorSessionStore } from "../editor/editor-session-state";
import type {
  PublishingDraft,
  PublishingMediaItem,
  PublishingReadiness,
  WorkDraftContent,
  PublishingHolder,
} from "@moya/contracts";
import type { Root } from "react-dom/client";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

interface FixtureOptions {
  readonly maxItems?: number;
  readonly identify?: PublishingServices["identifyFiles"];
  readonly preprocess?: () => ReturnType<typeof fakePreprocess>;
}

const fixture = ({
  maxItems = 50,
  preprocess,
  identify,
}: FixtureOptions = {}) => {
  const uploads = fakeClient();
  const transfer = fakeTransfer();
  const timers = manualTimers();
  const client = {
    ...uploads.client,
    limits: vi.fn(async () => ({
      maxItems,
      originalItemMaxBytes: 1_000_000,
      standardComponentMaxBytes: 1_000_000,
      titleMax: 200,
      bodyMax: 10_000,
    })),
    createSession: vi.fn(async () => ({
      id: SESSION_ID,
      state: "active" as const,
      workId: null,
      leaseExpiresAt: "2026-09-13T12:00:00.000Z",
      createdAt: "2026-09-13T12:00:00.000Z",
    })),
    heartbeatSession: vi.fn(),
    discardSession: vi.fn(async () => ({ discarded: true as const })),
    saveDraft: vi.fn(),
    saveDraftNow: vi.fn(),
    createDraft: vi.fn(),
    draft: vi.fn(),
    readiness: vi.fn<
      (
        holder: PublishingHolder,
        content: WorkDraftContent,
      ) => Promise<PublishingReadiness>
    >(async () => ({
      ready: true,
      pendingItemKeys: [],
      failedItemKeys: [],
      editKeys: {},
    })),
  };
  const services: PublishingServices = {
    client: client as unknown as PublishingClientPort,
    currentAccount: () => ACCOUNT,
    requestId: uuid,
    createTransfer: () => transfer.transfer,
    createPreprocess: () => (preprocess ?? fakePreprocess)(),
    createHasher: () => null,
    createRecovery: () => null,
    identifyFiles: identify ?? ((files) => identifyFiles(files)),
    preprocessConcurrency: () => 1,
    transferConcurrency: 2,
    deviceClass: () => "phone",
    timers: timers.timers,
    metadata: absentMetadata,
  };
  return { services, uploads, transfer, timers, client };
};

type Layout = "phone" | "desktop";

const probe: {
  store: EditorSessionStore | null;
  upload: ReturnType<typeof useUploadSession> | null;
  setView: ((view: { layout: Layout; shown: boolean }) => void) | null;
} = { store: null, upload: null, setView: null };

/** The editor host: a step change unmounts the section, a layout swap remounts it. */
const Editor = ({ layout }: { readonly layout: Layout }) => {
  const registry = useEditorSessionRegistry();
  const upload = useUploadSession();
  const [store] = useState(() => registry.create(ACCOUNT, { type: "new" }));
  const [view, setView] = useState({ layout, shown: true });
  useEffect(() => registry.mount(store), [registry, store]);
  probe.store = store;
  probe.upload = upload;
  probe.setView = setView;
  return view.shown ? (
    <MediaSection
      key={view.layout}
      layout={view.layout}
      onSkip={() => store.setStep("text")}
      sessionKey={store.key}
    />
  ) : (
    <p data-other-step="" />
  );
};

const hook: { actions: MediaActions | null } = { actions: null };

const ActionsBody = ({
  editor,
  options,
}: {
  readonly editor: EditorSessionHandle;
  readonly options: MediaActionsOptions;
}) => {
  const rootRef = useRef<HTMLDivElement>(null);
  hook.actions = useMediaActions(editor, rootRef, options);
  return (
    <div ref={rootRef}>
      {/* Where a test's `focusTarget` sends focus after a removal. */}
      <button data-actions-probe="" type="button" />
    </div>
  );
};

/** The hook without the section that draws it, as the phone composer uses it. */
const ActionsEditor = ({
  options,
  callers,
  generation,
}: {
  readonly options: MediaActionsOptions;
  readonly callers: number;
  /** A new generation remounts every caller in one commit (a layout swap). */
  readonly generation: number;
}) => {
  const registry = useEditorSessionRegistry();
  const upload = useUploadSession();
  const [store] = useState(() => registry.create(ACCOUNT, { type: "new" }));
  useEffect(() => registry.mount(store), [registry, store]);
  const editor = useEditorSession(store.key);
  probe.store = store;
  probe.upload = upload;
  return editor === null
    ? null
    : Array.from({ length: callers }, (_, index) => (
        <ActionsBody
          key={`${generation}-${index}`}
          editor={editor}
          options={options}
        />
      ));
};

let container: HTMLDivElement;
let root: Root;
let current: ReturnType<typeof fixture>;

const render = async (
  layout: Layout = "phone",
  options: FixtureOptions & { readonly draft?: PublishingDraft } = {},
) => {
  current = fixture(options);
  await act(async () => {
    root.render(
      <PublishingProvider services={current.services}>
        <EditorSessionProvider>
          <Editor layout={layout} />
        </EditorSessionProvider>
      </PublishingProvider>,
    );
    await settle();
  });
  // The editor host starts the runtime session once the account is known.
  await act(async () => {
    probe.upload!.startSession(
      options.draft === undefined
        ? { target: { type: "new" }, saveMode: "unsaved" }
        : {
            target: { type: "draft", id: options.draft.id },
            saveMode: "saved",
            draft: options.draft,
          },
    );
    await settle();
  });
};

const renderActions = async (
  options: MediaActionsOptions,
  fixtureOptions: FixtureOptions = {},
) => {
  current = fixture(fixtureOptions);
  const draw = async (callers = 1, generation = 0) => {
    await act(async () => {
      root.render(
        <PublishingProvider services={current.services}>
          <EditorSessionProvider>
            <ActionsEditor
              callers={callers}
              generation={generation}
              options={options}
            />
          </EditorSessionProvider>
        </PublishingProvider>,
      );
      await settle();
    });
  };
  await draw();
  await act(async () => {
    probe.upload!.startSession({
      target: { type: "new" },
      saveMode: "unsaved",
    });
    await settle();
  });
  return draw;
};

const setView = async (view: { layout: Layout; shown: boolean }) => {
  await act(async () => {
    probe.setView!(view);
    await settle();
  });
};

const announcer = () =>
  container.querySelector("[data-media-announcer]")?.textContent ?? "";

const flush = async (rounds = 3) => {
  for (let round = 0; round < rounds; round += 1)
    await act(async () => {
      await settle();
    });
};

const until = async (condition: () => boolean, rounds = 20) => {
  for (let round = 0; round < rounds && !condition(); round += 1)
    await flush(1);
  expect(condition()).toBe(true);
};

const setFiles = async (input: HTMLInputElement, files: File[]) => {
  Object.defineProperty(input, "files", { configurable: true, value: files });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
  });
};

const pickerInput = () =>
  container.querySelector<HTMLInputElement>(
    "[data-media-picker] input[type=file]",
  )!;

const buttonByText = (text: string, scope: ParentNode = document.body) => {
  const found = [...scope.querySelectorAll("button")].find(
    (button) =>
      button.textContent === text || button.getAttribute("aria-label") === text,
  );
  if (!found) throw new Error(`No button ${text}`);
  return found;
};

const click = async (element: HTMLElement) => {
  await act(async () => {
    element.click();
    await settle();
  });
};

const tiles = () =>
  [...container.querySelectorAll<HTMLElement>("[data-media-key]")].map(
    (tile) => ({
      key: tile.dataset.mediaKey!,
      handle: tile
        .querySelector("[data-media-handle]")!
        .getAttribute("aria-label"),
      status: tile.dataset.mediaStatus,
    }),
  );

const storeKeys = () => probe.store!.get().items.map((item) => item.key);

const addStatic = async (count: number) => {
  await setFiles(
    pickerInput(),
    Array.from({ length: count }, (_, index) =>
      fileOf(jpeg({ width: 4 + index }), `photo-${index}.jpg`),
    ),
  );
  await until(() => tiles().length === count);
};

const registered = () =>
  probe.store!.get().items.every((item) => item.itemId !== null);

beforeEach(() => {
  // Uppy schedules its initial online check for 3s and does not cancel it in
  // destroy(). Fake timers that still advance with real time (every 1ms, so
  // the settle/until polling keeps its pace) let afterEach flush that timer
  // before jsdom goes away.
  vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 1 });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  crop.props = null;
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = false;
    },
  });
  window.history.replaceState({}, "", "/#editor");
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.replaceChildren();
  probe.store = null;
  probe.upload = null;
  probe.setView = null;
  hook.actions = null;
  vi.restoreAllMocks();
  // Execute pending library timers here, where the error would fail this
  // file, instead of letting them leak into the worker's teardown.
  try {
    await vi.runAllTimersAsync();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

describe("MediaSection automatic photo selection", () => {
  it("keeps an ordinary pick queued behind a slow missing-file replacement", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const draft: PublishingDraft = {
      id: DRAFT_ID,
      kind: "new",
      workId: null,
      baseRevisionId: null,
      revision: 1,
      content: {
        title: "",
        body: "",
        authorship: { kind: "original" },
        visibility: "public",
        items: [
          {
            key: "missing",
            itemId: null,
            kind: "static",
            qualityMode: "original",
            edit: { rotation: 90, crop: null },
            pendingLabel: "photo",
          },
        ],
        coverKey: "missing",
        coverCrop: null,
      },
      mediaItems: [],
      conflict: null,
      deviceClass: "phone",
      createdAt: "2026-09-13T12:00:00.000Z",
      updatedAt: "2026-09-13T12:00:00.000Z",
    };
    let calls = 0;
    await render("phone", {
      draft,
      identify: async (files) => {
        if (calls++ === 0) await pending;
        return identifyFiles(files);
      },
    });
    await act(async () => {
      probe.store!.adoptContent(draft.content, []);
      await probe.upload!.restoreDraftMedia(draft);
      await settle();
    });
    await click(buttonByText("重新选择第 1 项"));
    await setFiles(
      container.querySelector<HTMLInputElement>(
        'input[aria-label="重新选择缺少的文件"]',
      )!,
      [fileOf(jpeg({ width: 6 }), "replacement.jpg")],
    );
    await setFiles(pickerInput(), [fileOf(jpeg({ width: 8 }), "ordinary.jpg")]);
    await act(async () => {
      release();
      await settle();
    });
    await until(() => storeKeys().length === 2);
    expect(
      probe.store!.get().items.map((i) => [i.qualityMode, i.edit.rotation]),
    ).toEqual([
      ["original", 90],
      ["standard", 0],
    ]);
    expect(probe.store!.get().coverKey).toBe(storeKeys()[0]);
  });

  it("keeps the newest replacement choice when the same missing card is reselected twice", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const draft: PublishingDraft = {
      id: DRAFT_ID,
      kind: "new",
      workId: null,
      baseRevisionId: null,
      revision: 1,
      content: {
        title: "",
        body: "",
        authorship: { kind: "original" },
        visibility: "public",
        items: [
          {
            key: "missing",
            itemId: null,
            kind: "static",
            qualityMode: "original",
            edit: { rotation: 90, crop: null },
            pendingLabel: "photo",
          },
        ],
        coverKey: "missing",
        coverCrop: null,
      },
      mediaItems: [],
      conflict: null,
      deviceClass: "phone",
      createdAt: "2026-09-13T12:00:00.000Z",
      updatedAt: "2026-09-13T12:00:00.000Z",
    };
    let calls = 0;
    await render("phone", {
      draft,
      identify: async (files) => {
        if (calls++ === 0) await pending;
        return identifyFiles(files);
      },
    });
    await act(async () => {
      probe.store!.adoptContent(draft.content, []);
      await probe.upload!.restoreDraftMedia(draft);
      await settle();
    });
    const oldFile = fileOf(jpeg({ width: 6 }), "old.jpg");
    const newFile = fileOf(jpeg({ width: 8 }), "new.jpg");
    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="重新选择缺少的文件"]',
    )!;
    await click(buttonByText("重新选择第 1 项"));
    await setFiles(input, [oldFile]);
    await click(buttonByText("重新选择第 1 项"));
    await setFiles(input, [newFile]);
    await act(async () => {
      release();
      await settle();
    });
    await until(() => current.transfer.starts.length === 1);
    expect(current.transfer.starts[0]!.request.body).toBe(newFile);
    expect(storeKeys()).toHaveLength(1);
  });

  it("retains a rejected selection notice when identification finishes on another step", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await render("phone", {
      identify: async (files) => {
        await pending;
        return identifyFiles(files);
      },
    });
    await setFiles(pickerInput(), [fileOf(animatedGif(), "unsupported.gif")]);
    await setView({ layout: "phone", shown: false });
    await act(async () => {
      release();
      await settle();
    });
    await flush();
    await setView({ layout: "phone", shown: true });
    expect(container.textContent).toContain("所选文件无法添加");
    expect(storeKeys()).toHaveLength(0);
    expect(current.transfer.starts).toHaveLength(0);
  });

  it("long-presses the card body to select, then removes selected transfers without resurrection", async () => {
    await render();
    await addStatic(3);
    await until(registered);
    await until(() => current.transfer.starts.length === 2);
    const [first, second, third] = storeKeys();
    const cards = [
      ...container.querySelectorAll<HTMLElement>("[data-media-key]"),
    ];
    const target = cards[0]!.querySelector("p")!;
    const point: Touch = {
      identifier: 1,
      clientX: 180,
      clientY: 80,
      pageX: 180,
      pageY: 80,
      screenX: 180,
      screenY: 80,
      radiusX: 1,
      radiusY: 1,
      rotationAngle: 0,
      force: 1,
      target,
    };
    await act(async () => {
      target.dispatchEvent(
        new TouchEvent("touchstart", {
          bubbles: true,
          cancelable: true,
          touches: [point],
        }),
      );
      await vi.advanceTimersByTimeAsync(260);
    });
    expect(cards[0]!.dataset.selected).toBe("true");
    expect(cards[0]!.dataset.dragging).toBe("true");
    await act(async () => {
      target.dispatchEvent(
        new TouchEvent("touchend", {
          bubbles: true,
          changedTouches: [point],
        }),
      );
      // dnd-kit briefly suppresses the release click after a drag.
      await vi.advanceTimersByTimeAsync(60);
    });
    await click(cards[1]!.querySelector("p")!);
    expect(cards[1]!.dataset.selected).toBe("true");
    expect(container.textContent).toContain("已选择 2 项");
    const late = [...current.transfer.starts];
    await click(buttonByText("移除所选"));
    expect(storeKeys()).toEqual([third]);
    await act(async () => {
      for (const transfer of late)
        transfer.callbacks.onSettled({
          status: 200,
          responseText: "{}",
          stalled: false,
        });
      await settle();
    });
    expect(storeKeys()).toEqual([third]);
    expect(probe.upload!.draftItems().map((item) => item.key)).not.toContain(
      first,
    );
    expect(probe.upload!.draftItems().map((item) => item.key)).not.toContain(
      second,
    );
  });

  it("accepts a slow selection after navigating away and keeps separate picks in selection order", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    await render("phone", {
      identify: async (files) => {
        if (calls++ === 0) await pending;
        return identifyFiles(files);
      },
    });
    await act(async () => probe.store!.setOriginalNext(true));
    await setFiles(pickerInput(), [fileOf(jpeg({ width: 4 }), "first.jpg")]);
    await setFiles(pickerInput(), [fileOf(jpeg({ width: 8 }), "second.jpg")]);
    await setView({ layout: "phone", shown: false });
    await act(async () => {
      release();
      await settle();
    });
    await until(() => storeKeys().length === 2);
    expect(probe.store!.get().items.map((item) => item.qualityMode)).toEqual([
      "original",
      "standard",
    ]);
    await setView({ layout: "phone", shown: true });
    expect(tiles()).toHaveLength(2);
    expect(container.querySelector("[data-media-staging]")).toBeNull();
  });

  it("rejects an over-limit selection as a whole without disturbing completed items", async () => {
    await render("phone", { maxItems: 2 });
    await addStatic(1);
    const kept = storeKeys();
    await setFiles(pickerInput(), [
      fileOf(jpeg({ width: 7 })),
      fileOf(jpeg({ width: 8 })),
    ]);
    await until(() => container.textContent!.includes("本次选择未加入"));
    expect(storeKeys()).toEqual(kept);
    expect(container.querySelector("[data-media-staging]")).toBeNull();
  });

  it("adds selected static photos directly under the explicit batch quality choice", async () => {
    await render();
    // The explicit Original choice precedes the native picker.
    await act(async () => probe.store!.setOriginalNext(true));
    await setFiles(pickerInput(), [
      fileOf(jpeg({}), "plain.jpg"),
      fileOf(heic({ identifier: IDENTIFIER }), "IMG_0001.HEIC"),
      fileOf(heic({ identifier: OTHER_IDENTIFIER }), "IMG_0002.HEIC"),
      fileOf(animatedGif(), "moving.gif"),
    ]);
    await until(() => tiles().length === 3);
    expect(container.querySelector("[data-media-staging]")).toBeNull();
    expect(container.textContent).not.toContain("补选动态文件");
    expect(container.textContent).toContain("1 个不支持的文件未添加");
    expect(container.textContent).not.toContain("全部取消");
    const state = probe.store!.get();
    expect(state.originalNext).toBe(false);
    expect(state.items.map((item) => [item.kind, item.qualityMode])).toEqual([
      ["static", "original"],
      ["static", "original"],
      ["static", "original"],
    ]);
    expect(tiles().map((tile) => tile.handle)).toEqual([
      "第 1 项，照片，长按可拖动排序或多选",
      "第 2 项，照片，长按可拖动排序或多选",
      "第 3 项，照片，长按可拖动排序或多选",
    ]);
    expect(
      container.querySelectorAll("[data-media-quality=original]"),
    ).toHaveLength(3);
  });

  it("labels clipboard images as not camera originals", async () => {
    await render("desktop");
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        files: [fileOf(png(), "image.png", "image/png")],
        items: [],
        types: ["Files"],
      },
    });
    await act(async () => {
      document.body.dispatchEvent(event);
      await settle();
    });
    await until(() => tiles().length === 1);
    expect(container.querySelector("[data-media-key]")!.textContent).toContain(
      "来自剪贴板",
    );
  });

  it("keeps the clipboard label of restored items from the draft content", async () => {
    const readyId = `media-item-${"6".repeat(32)}`;
    const stamp = "2026-09-13T12:00:00.000Z";
    const clipboardItem = (
      key: string,
      itemId: string | null,
    ): PublishingDraft["content"]["items"][number] =>
      itemId === null
        ? {
            key,
            itemId: null,
            kind: "static",
            qualityMode: "standard",
            edit: { rotation: 0, crop: null },
            pendingLabel: "photo",
            origin: "clipboard",
          }
        : {
            key,
            itemId,
            kind: "static",
            qualityMode: "standard",
            edit: { rotation: 0, crop: null },
            origin: "clipboard",
          };
    const draft: PublishingDraft = {
      id: DRAFT_ID,
      kind: "new",
      workId: null,
      baseRevisionId: null,
      revision: 2,
      content: {
        title: "",
        body: "",
        authorship: { kind: "original" },
        visibility: "public",
        items: [
          clipboardItem("pasted-ready", readyId),
          clipboardItem("pasted-missing", null),
          {
            key: "picked",
            itemId: null,
            kind: "static",
            qualityMode: "standard",
            edit: { rotation: 0, crop: null },
            pendingLabel: "photo",
          },
        ],
        coverKey: null,
        coverCrop: null,
      },
      mediaItems: [readyItem(readyId)],
      conflict: null,
      deviceClass: "desktop",
      createdAt: stamp,
      updatedAt: stamp,
    };
    await render("desktop", { draft });
    const labelled = () =>
      [...container.querySelectorAll<HTMLElement>("[data-media-key]")]
        .filter((tile) => tile.querySelector("[data-media-clipboard]") !== null)
        .map((tile) => tile.dataset.mediaKey);
    // The account's items alone (no manager entry on this browser).
    await act(async () => {
      probe.store!.adoptContent(draft.content, draft.mediaItems);
      await settle();
    });
    await until(() => tiles().length === 3);
    expect(labelled()).toEqual(["pasted-ready", "pasted-missing"]);
    // Reopened on this browser: the manager's entries keep it too.
    await act(async () => {
      await probe.upload!.restoreDraftMedia(draft);
      await settle();
    });
    await until(() => tiles()[1]?.status === "missing_local");
    expect(labelled()).toEqual(["pasted-ready", "pasted-missing"]);
    expect(
      container.querySelector(
        '[data-media-key="pasted-missing"] [data-media-clipboard]',
      )?.textContent,
    ).toBe("来自剪贴板");
    // The label never becomes author content that disappears on sync.
    expect(probe.store!.get().items.map((item) => item.origin ?? null)).toEqual(
      ["clipboard", "clipboard", null],
    );
  });

  it("offers 先写标题和正文 only while the phone step has no media", async () => {
    await render();
    await click(buttonByText("先写标题和正文"));
    expect(probe.store!.get().step).toBe("text");
    await addStatic(1);
    expect(container.querySelector("[data-media-skip]")).toBeNull();
  });
});

describe("MediaSection strip", () => {
  it("reorders with buttons and keyboard while keys, identities and numbers stay consistent", async () => {
    await render();
    await addStatic(3);
    await until(registered);
    const [a, b, c] = storeKeys();
    const ids = new Map(
      probe.store!.get().items.map((item) => [item.key, item.itemId]),
    );

    await click(buttonByText("下移第 1 项"));
    expect(storeKeys()).toEqual([b, a, c]);
    expect(tiles().map((tile) => tile.key)).toEqual([b, a, c]);
    expect(tiles().map((tile) => tile.handle?.split("，")[0])).toEqual([
      "第 1 项",
      "第 2 项",
      "第 3 项",
    ]);

    // Alt + ↑ on the drag handle moves without dragging.
    const handleC = container.querySelector<HTMLElement>(
      `[data-media-handle="${c}"]`,
    )!;
    await act(async () => {
      handleC.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowUp",
          code: "ArrowUp",
          altKey: true,
          bubbles: true,
        }),
      );
      await settle();
    });
    expect(storeKeys()).toEqual([b, c, a]);

    // At the first position 上移 is disabled and focus stays in the tile.
    await click(buttonByText("上移第 2 项"));
    expect(storeKeys()).toEqual([c, b, a]);
    expect(buttonByText("上移第 1 项").disabled).toBe(true);
    expect(document.activeElement?.getAttribute("data-media-action")).toBe(
      "down",
    );
    for (const item of probe.store!.get().items)
      expect(item.itemId).toBe(ids.get(item.key));
    // Screen readers hear the product language, and every move.
    expect(
      container
        .querySelector("[data-media-handle]")!
        .getAttribute("aria-roledescription"),
    ).toBe("可排序的图片");
    expect(announcer()).toBe("第 2 项已移到第 1 位");
  });

  it("sorts with the dnd-kit keyboard sensor", async () => {
    await render();
    await addStatic(3);
    const [a, b, c] = storeKeys();
    // Layout for the sensor: rows stacked 120px apart.
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        const tile = this.closest("[data-media-key]");
        const index = tile
          ? [...container.querySelectorAll("[data-media-key]")].indexOf(tile)
          : -1;
        const top = index < 0 ? 0 : 100 + index * 120;
        const height = index < 0 ? 0 : 100;
        return {
          x: 0,
          y: top,
          top,
          left: 0,
          width: index < 0 ? 0 : 300,
          height,
          right: index < 0 ? 0 : 300,
          bottom: top + height,
          toJSON: () => ({}),
        } as DOMRect;
      },
    );
    Element.prototype.scrollIntoView ??= () => undefined;
    const handle = container.querySelector<HTMLElement>(
      `[data-media-handle="${a}"]`,
    )!;
    handle.focus();
    const press = async (target: EventTarget, code: string) => {
      await act(async () => {
        target.dispatchEvent(
          new KeyboardEvent("keydown", { key: code, code, bubbles: true }),
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    };
    await press(handle, "Space");
    await press(document, "ArrowDown");
    await press(document, "Space");
    await flush(1);
    expect(storeKeys()).toEqual([b, a, c]);
  });

  it("keeps an independent cover and tells the author about the fallback", async () => {
    await render();
    await addStatic(3);
    const [a, b, c] = storeKeys();
    expect(
      container
        .querySelector(`[data-media-key="${a}"] [data-media-cover]`)!
        .getAttribute("data-media-cover"),
    ).toBe("default");

    await click(buttonByText("设为封面：第 3 项"));
    expect(probe.store!.get().coverKey).toBe(c);
    await click(buttonByText("上移第 3 项"));
    expect(storeKeys()).toEqual([a, c, b]);
    expect(probe.store!.get().coverKey).toBe(c);
    expect(
      [...container.querySelectorAll("[data-media-cover]")].map((badge) => [
        badge.closest<HTMLElement>("[data-media-key]")!.dataset.mediaKey,
        badge.getAttribute("data-media-cover"),
      ]),
    ).toEqual([[c, "chosen"]]);

    await click(buttonByText("移除第 2 项"));
    expect(probe.store!.get().coverKey).toBe(null);
    expect(storeKeys()).toEqual([a, b]);
    expect(
      container.querySelector("[data-media-notice]")!.textContent,
    ).toContain("封面已移除，现在以第 1 项作为封面");
    // The notice is also said, politely, with what caused it.
    expect(announcer()).toBe(
      "已移除第 2 项。封面已移除，现在以第 1 项作为封面",
    );
    expect(
      container
        .querySelector(`[data-media-key="${a}"] [data-media-cover]`)!
        .getAttribute("data-media-cover"),
    ).toBe("default");
  });

  it("cancels a removed item through the runtime and never re-adds it", async () => {
    await render();
    await addStatic(2);
    await until(registered);
    const [a, b] = probe.store!.get().items;
    await click(buttonByText("移除第 1 项"));
    expect(current.uploads.client.cancelItem).toHaveBeenCalledWith(
      a!.itemId,
      expect.objectContaining({ requestId: expect.any(String) }),
    );
    await flush();
    expect(storeKeys()).toEqual([b!.key]);
    expect(probe.upload!.draftItems().map((item) => item.key)).toEqual([
      b!.key,
    ]);
    expect(tiles().map((tile) => tile.handle)).toEqual([
      "第 1 项，照片，长按可拖动排序或多选",
    ]);
    expect(document.activeElement?.getAttribute("data-media-handle")).toBe(
      b!.key,
    );
  });

  it("moves the phone's current item on to its neighbour when it is removed, and drops its crop work", async () => {
    await render();
    await addStatic(2);
    const [a, b] = storeKeys();
    const ui = mediaUiFor(probe.store!);
    const draft: EditDraft = {
      basis: { rotation: 0, crop: null },
      rotation: 90,
      stored: null,
    };
    act(() => {
      ui.setCurrentKey(a!);
      ui.saveCropDraft(a!, draft);
      ui.saveCropDraft(b!, draft);
    });
    await click(buttonByText("移除第 1 项"));
    expect(storeKeys()).toEqual([b]);
    expect(ui.get().phone).toMatchObject({ currentKey: b });
    expect(ui.cropDraftFor(a!)).toBe(null);
    expect(ui.cropDraftFor(b!)).toBe(draft);

    // The last item leaves nothing to edit.
    await click(buttonByText("移除第 1 项"));
    expect(storeKeys()).toEqual([]);
    expect(ui.get().phone).toMatchObject({
      currentKey: null,
      backAsk: false,
    });
  });

  it("keeps the phone's current item on its place when a missing item is re-selected", async () => {
    const draft: PublishingDraft = {
      id: DRAFT_ID,
      kind: "new",
      workId: null,
      baseRevisionId: null,
      revision: 1,
      content: {
        title: "",
        body: "",
        authorship: { kind: "original" },
        visibility: "public",
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
        coverKey: null,
        coverCrop: null,
      },
      mediaItems: [],
      conflict: null,
      deviceClass: "phone",
      createdAt: "2026-09-13T12:00:00.000Z",
      updatedAt: "2026-09-13T12:00:00.000Z",
    };
    await render("phone", { draft });
    await act(async () => {
      probe.store!.adoptContent(draft.content, []);
      await probe.upload!.restoreDraftMedia(draft);
      await settle();
    });
    const ui = mediaUiFor(probe.store!);
    act(() => {
      ui.setCurrentKey("missing");
    });
    await click(buttonByText("重新选择第 1 项"));
    await setFiles(
      container.querySelector<HTMLInputElement>(
        'input[aria-label="重新选择缺少的文件"]',
      )!,
      [fileOf(jpeg({ width: 6 }), "replacement.jpg")],
    );
    await until(() => storeKeys().length === 1 && storeKeys()[0] !== "missing");
    expect(ui.get().phone).toMatchObject({
      currentKey: storeKeys()[0],
    });
  });

  it("shows a failed transfer with a retry that restarts only that component", async () => {
    await render();
    await addStatic(1);
    await until(() => current.transfer.starts.length === 1);
    const retry = vi.spyOn(UploadManager.prototype, "retryComponent");
    await act(async () => {
      current.transfer.starts[0]!.callbacks.onSettled({
        status: 0,
        responseText: "",
        stalled: false,
      });
      await settle();
    });
    await until(() => tiles()[0]?.status === "failed");
    const tile = container.querySelector<HTMLElement>("[data-media-key]")!;
    expect(tile.textContent).toContain("失败");
    await click(buttonByText("重试第 1 项"));
    expect(retry).toHaveBeenCalledWith(storeKeys()[0], "still");
    await until(() => current.transfer.starts.length === 2);
  });

  it("does not fabricate LIVE when Web receives a still and a separate video", async () => {
    await render();
    await act(async () => probe.store!.setOriginalNext(true));
    await setFiles(pickerInput(), [
      fileOf(heic({ identifier: IDENTIFIER })),
      fileOf(motion({ identifier: IDENTIFIER })),
      fileOf(jpeg({})),
    ]);
    await until(() => tiles().length === 2);
    expect(container.textContent).toContain("1 个不支持的文件未添加");
    await until(() => current.transfer.starts.length === 2, 40);
    expect(probe.store!.get().items.map((item) => item.kind)).toEqual([
      "static",
      "static",
    ]);
    expect(container.querySelector("[data-media-live]")).toBeNull();
  });

  it("applies rotation and crop from the edit dialog and reverts to the full frame", async () => {
    await render();
    await addStatic(1);
    await until(registered);
    const itemId = probe.store!.get().items[0]!.itemId!;
    await until(() => current.transfer.starts.length === 1);
    await act(async () => {
      current.transfer.starts[0]!.callbacks.onSettled({
        status: 200,
        responseText: current.uploads.receive(itemId, "still"),
        stalled: false,
      });
      await settle();
    });
    current.uploads.makeReady(itemId);
    await act(async () => {
      current.timers.fireAll();
      await settle();
    });
    await until(() => tiles()[0]?.status === "ready");

    // A chosen cover with a composition: an edit of that item resets it.
    await click(buttonByText("设为封面：第 1 项"));
    await act(async () =>
      probe.store!.setCoverCrop({ x: 0, y: 0, width: 0.5, height: 0.5 }),
    );

    await click(buttonByText("编辑第 1 项"));
    const dialog = document.querySelector<HTMLElement>(
      "[data-media-edit-dialog]",
    )!;
    expect(dialog).not.toBeNull();
    expect(crop.props?.rotation).toBe(0);
    await click(buttonByText("向右旋转 90°", dialog));
    expect(crop.props?.rotation).toBe(90);
    const square = [...dialog.querySelectorAll("label")].find(
      (label) => label.textContent === "1:1",
    )!;
    await click(square.querySelector("input")!);
    // Presentation 4 × 3 turned: a 3 × 4 frame; 1:1 is the centered square.
    expect(crop.props?.aspect).toBe(1);
    await act(async () =>
      crop.props!.onCropAreaChange(
        { x: 0, y: 12.5, width: 100, height: 75 },
        { x: 0, y: 1, width: 3, height: 3 },
      ),
    );
    await click(buttonByText("完成", dialog));
    expect(document.querySelector("[data-media-edit-dialog]")).toBeNull();
    const edited = probe.store!.get();
    expect(edited.items[0]!.edit).toEqual({
      rotation: 90,
      crop: { x: 0, y: 0.125, width: 1, height: 0.75 },
    });
    expect(edited.coverCrop).toBe(null);
    expect(
      container.querySelector("[data-media-notice]")!.textContent,
    ).toContain("封面构图已恢复为完整画面");

    await click(buttonByText("编辑第 1 项"));
    const reopened = document.querySelector<HTMLElement>(
      "[data-media-edit-dialog]",
    )!;
    expect(
      [...reopened.querySelectorAll<HTMLInputElement>("input[type=radio]")]
        .filter((input) => input.checked)
        .map((input) => input.value),
    ).toEqual(["1:1"]);
    await click(buttonByText("还原", reopened));
    await click(buttonByText("完成", reopened));
    expect(probe.store!.get().items[0]!.edit).toEqual({
      rotation: 0,
      crop: null,
    });
  });
});

const readyItem = (id: string): PublishingMediaItem => ({
  id,
  kind: "static",
  qualityMode: "standard",
  state: "ready",
  failureCode: null,
  components: [
    {
      id: `media-component-${"5".repeat(32)}`,
      role: "still",
      state: "verified",
      byteSize: 9,
      receivedBytes: 9,
    },
  ],
  presentation: { width: 4, height: 3 },
  media: {
    thumbSrc: `/api/community/publishing/media/${id}/thumb/base`,
    displaySrc: `/api/community/publishing/media/${id}/display/base`,
  },
});

const fileDrag = (type: string, files: File[], types = ["Files"]) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { types, files, dropEffect: "none" },
  });
  return event as Event & { dataTransfer: { dropEffect: string } };
};

const dispatch = async <E extends Event>(target: EventTarget, event: E) => {
  await act(async () => {
    target.dispatchEvent(event);
    await settle();
  });
  return event;
};

/** Makes the first confirmed item ready on the account. */
const makeFirstReady = async () => {
  await until(registered);
  const itemId = probe.store!.get().items[0]!.itemId!;
  await until(() => current.transfer.starts.length >= 1);
  await act(async () => {
    current.transfer.starts[0]!.callbacks.onSettled({
      status: 200,
      responseText: current.uploads.receive(itemId, "still"),
      stalled: false,
    });
    await settle();
  });
  current.uploads.makeReady(itemId);
  await act(async () => {
    current.timers.fireAll();
    await settle();
  });
  await until(() => tiles()[0]?.status === "ready");
};

describe("MediaSection edit derivative readiness (D1)", () => {
  it("shows a turned item as 处理中 until the account confirms, then its edited thumbnail", async () => {
    await render();
    await addStatic(1);
    await makeFirstReady();
    const itemId = probe.store!.get().items[0]!.itemId!;
    const tile = () =>
      container.querySelector<HTMLElement>("[data-media-key]")!;
    expect(tile().querySelector("img")!.getAttribute("src")).toBe(
      `/api/community/publishing/media/${itemId}/thumb/base`,
    );

    current.client.readiness.mockResolvedValueOnce({
      ready: false,
      pendingItemKeys: [probe.store!.get().items[0]!.key],
      failedItemKeys: [],
      editKeys: {},
    });
    await click(buttonByText("编辑第 1 项"));
    const dialog = document.querySelector<HTMLElement>(
      "[data-media-edit-dialog]",
    )!;
    await click(buttonByText("向右旋转 90°", dialog));
    await click(buttonByText("完成", dialog));
    // Immediately after 完成: not 已就绪 any more.
    expect(tiles()[0]!.status).toBe("processing");
    expect(tile().querySelector("[data-media-state-label]")!.textContent).toBe(
      "处理中",
    );
    // The editor host forwards the edit to the runtime (as the overlay does).
    await act(async () => {
      probe.upload!.edit(probe.store!.content());
      await settle();
    });
    expect(current.client.readiness).not.toHaveBeenCalled();
    // The debounced check (session holder) still names it pending.
    await act(async () => {
      current.timers.fireAll();
      await settle();
    });
    expect(current.client.readiness).toHaveBeenCalledTimes(1);
    expect(current.client.readiness.mock.calls[0]![0]).toEqual({
      sessionId: SESSION_ID,
    });
    expect(tiles()[0]!.status).toBe("processing");
    // The poll answers ready with the edit key: the strip shows the edited thumbnail.
    const editKey = "c".repeat(32);
    current.client.readiness.mockResolvedValueOnce({
      ready: true,
      pendingItemKeys: [],
      failedItemKeys: [],
      editKeys: { [probe.store!.get().items[0]!.key]: editKey },
    });
    await act(async () => {
      current.timers.fireAll();
      await settle();
    });
    await until(() => tiles()[0]?.status === "ready");
    expect(tile().dataset.mediaThumb).toBe("edited");
    expect(tile().querySelector("img")!.getAttribute("src")).toBe(
      `/api/community/publishing/media/${itemId}/thumb/${editKey}`,
    );
    // The edited thumbnail is shown as it is (no second rotation in CSS).
    expect(
      tile().querySelector("[data-rotation]")!.getAttribute("data-rotation"),
    ).toBe("0");
  });
});

describe("MediaSection across remounts and interruptions", () => {
  it("keeps an open dialog with its unfinished crop and the notice when the layout swaps or the step changes", async () => {
    await render();
    await addStatic(3);
    await makeFirstReady();
    const [a, , c] = storeKeys();
    await click(buttonByText("设为封面：第 3 项"));
    await click(buttonByText("移除第 3 项"));
    expect(storeKeys()).not.toContain(c);

    await click(buttonByText("编辑第 1 项"));
    let dialog = document.querySelector<HTMLElement>(
      "[data-media-edit-dialog]",
    )!;
    await click(buttonByText("向右旋转 90°", dialog));
    const square = [...dialog.querySelectorAll("label")].find(
      (label) => label.textContent === "1:1",
    )!;
    await click(square.querySelector("input")!);
    await act(async () =>
      crop.props!.onCropAreaChange(
        { x: 0, y: 20, width: 100, height: 75 },
        { x: 0, y: 1, width: 3, height: 3 },
      ),
    );

    // Tablet rotated across 896 px: the editor swaps layouts.
    await setView({ layout: "desktop", shown: true });
    dialog = document.querySelector<HTMLElement>("[data-media-edit-dialog]")!;
    expect(dialog).not.toBeNull();
    expect(crop.props?.rotation).toBe(90);
    expect(crop.props?.initialCroppedAreaPercentages).toEqual({
      x: 0,
      y: 20,
      width: 100,
      height: 75,
    });
    expect(
      [...dialog.querySelectorAll<HTMLInputElement>("input[type=radio]")]
        .filter((input) => input.checked)
        .map((input) => input.value),
    ).toEqual(["1:1"]);
    expect(
      container.querySelector("[data-media-notice]")!.textContent,
    ).toContain("封面已移除");
    await click(buttonByText("完成", dialog));
    expect(probe.store!.get().items[0]).toMatchObject({
      key: a,
      edit: { rotation: 90, crop: { x: 0, y: 0.2, width: 1, height: 0.75 } },
    });
    expect(document.querySelector("[data-media-edit-dialog]")).toBeNull();

    // 下一步 and back: the notice is still there, the dialog stays closed.
    await setView({ layout: "desktop", shown: false });
    await setView({ layout: "desktop", shown: true });
    expect(
      container.querySelector("[data-media-notice]")!.textContent,
    ).toContain("封面已移除");
    expect(document.querySelector("[data-media-edit-dialog]")).toBeNull();
  });

  it("re-selects a missing file into its place with its cover, edit and quality, counting it once", async () => {
    const readyId = `media-item-${"4".repeat(32)}`;
    const stamp = "2026-09-13T12:00:00.000Z";
    const draft: PublishingDraft = {
      id: DRAFT_ID,
      kind: "new",
      workId: null,
      baseRevisionId: null,
      revision: 1,
      content: {
        title: "",
        body: "",
        authorship: { kind: "original" },
        visibility: "public",
        items: [
          {
            key: "done",
            itemId: readyId,
            kind: "static",
            qualityMode: "standard",
            edit: { rotation: 0, crop: null },
          },
          {
            key: "gone",
            itemId: null,
            kind: "static",
            qualityMode: "original",
            edit: { rotation: 90, crop: null },
            pendingLabel: "photo",
          },
        ],
        coverKey: "gone",
        coverCrop: { x: 0, y: 0, width: 0.5, height: 0.5 },
      },
      mediaItems: [readyItem(readyId)],
      conflict: null,
      deviceClass: "desktop",
      createdAt: stamp,
      updatedAt: stamp,
    };
    // The work is at its limit: the missing item still holds its place.
    await render("phone", { maxItems: 2, draft });
    await act(async () => {
      probe.store!.adoptContent(draft.content, draft.mediaItems);
      await probe.upload!.restoreDraftMedia(draft);
      await settle();
    });
    await until(() => tiles()[1]?.status === "missing_local");

    await click(buttonByText("重新选择第 2 项"));
    await setFiles(
      container.querySelector<HTMLInputElement>(
        'input[aria-label="重新选择缺少的文件"]',
      )!,
      [fileOf(jpeg({ width: 6 }), "again.jpg")],
    );
    await until(
      () => storeKeys().length === 2 && !storeKeys().includes("gone"),
    );
    // Replacement is already committed; navigation preserves it.
    await setView({ layout: "phone", shown: false });
    await setView({ layout: "phone", shown: true });
    const state = probe.store!.get();
    expect(state.items.map((item) => item.key)).toHaveLength(2);
    const [first, second] = state.items;
    expect(first!.key).toBe("done");
    expect(second!.key).not.toBe("gone");
    expect(second).toMatchObject({
      kind: "static",
      qualityMode: "original",
      edit: { rotation: 90, crop: null },
    });
    expect(state.coverKey).toBe(second!.key);
    expect(state.coverCrop).toBe(null);
    expect(state.originalNext).toBe(false);
    await flush();
    expect(probe.upload!.draftItems().map((item) => item.key)).toEqual([
      "done",
      second!.key,
    ]);
    expect(container.querySelector("[data-media-staging]")).toBeNull();
  });

  it("uploads files dropped anywhere in the section and never lets a dropped file replace the editor", async () => {
    await render("desktop");
    const outside = document.createElement("div");
    document.body.append(outside);

    // On the drop zone: staged once (the zone handles it, the guard does not repeat it).
    await dispatch(
      container.querySelector("[data-media-picker]")!,
      fileDrag("drop", [fileOf(jpeg({}), "zone.jpg")]),
    );
    await until(() => tiles().length === 1);

    // Outside the section: the browser does not open the file, nothing is staged.
    const overOutside = await dispatch(outside, fileDrag("dragover", []));
    expect(overOutside.defaultPrevented).toBe(true);
    expect(overOutside.dataTransfer.dropEffect).toBe("none");
    const dropOutside = await dispatch(
      outside,
      fileDrag("drop", [fileOf(jpeg({}), "outside.jpg")]),
    );
    expect(dropOutside.defaultPrevented).toBe(true);
    await flush();
    expect(container.querySelector("[data-media-staging]")).toBeNull();

    // Dragging text is left alone.
    const text = await dispatch(
      outside,
      fileDrag("dragover", [], ["text/plain"]),
    );
    expect(text.defaultPrevented).toBe(false);

    // On the strip: staged like the zone.
    const tile = container.querySelector("[data-media-key]")!;
    const overTile = await dispatch(tile, fileDrag("dragover", []));
    expect(overTile.dataTransfer.dropEffect).toBe("copy");
    await dispatch(
      tile,
      fileDrag("drop", [fileOf(jpeg({ width: 9 }), "strip.jpg")]),
    );
    await until(() => tiles().length === 2);
  });

  it("removes an item cancelled elsewhere and says so", async () => {
    const draftItems = vi.spyOn(UploadManager.prototype, "draftItems");
    await render();
    await addStatic(2);
    await until(registered);
    const [a, b] = storeKeys();
    const manager = draftItems.mock.contexts.at(-1) as UploadManager;
    await act(async () => {
      await manager.cancelItem(a!);
      await settle();
    });
    await until(() => storeKeys().length === 1);
    expect(storeKeys()).toEqual([b]);
    expect(
      container.querySelector("[data-media-notice]")!.textContent,
    ).toContain("1 项已不可用，已从作品中移除");
    expect(announcer()).toContain("1 项已不可用，已从作品中移除");
  });

  it("offers 上传原图 when this browser cannot prepare Standard", async () => {
    const chooseOriginal = vi.spyOn(UploadManager.prototype, "chooseOriginal");
    await render("phone", {
      preprocess: () => {
        const preprocess = fakePreprocess();
        preprocess.still.mockResolvedValueOnce({
          status: "unsupported",
          reason: "decode_unsupported",
        });
        return preprocess;
      },
    });
    await addStatic(1);
    await until(() => tiles()[0]?.status === "needs_choice");
    expect(announcer()).toContain("第 1 项需要选择");
    await click(buttonByText("上传原图：第 1 项"));
    expect(chooseOriginal).toHaveBeenCalledWith(storeKeys()[0]);
    await until(() => probe.store!.get().items[0]?.qualityMode === "original");
    expect(
      container.querySelector("[data-media-quality=original]"),
    ).not.toBeNull();
  });

  it("shows the not-reducible copy and offers 上传原图 when a HEIC cannot be reduced in Standard", async () => {
    const chooseOriginal = vi.spyOn(UploadManager.prototype, "chooseOriginal");
    await render("phone", {
      preprocess: () => {
        const preprocess = fakePreprocess();
        preprocess.still.mockResolvedValueOnce({
          status: "unsupported",
          reason: "standard_not_smaller",
        });
        return preprocess;
      },
    });
    await addStatic(1);
    await until(() => tiles()[0]?.status === "needs_choice");
    expect(container.textContent).toContain(
      "此文件无法以标准画质缩小，可上传原图或移除",
    );
    expect(buttonByText("移除第 1 项")).not.toBeNull();
    await click(buttonByText("上传原图：第 1 项"));
    expect(chooseOriginal).toHaveBeenCalledWith(storeKeys()[0]);
    await until(() => probe.store!.get().items[0]?.qualityMode === "original");
  });

  it("continues paused uploads with 继续上传", async () => {
    const draftItems = vi.spyOn(UploadManager.prototype, "draftItems");
    const continueUploads = vi.spyOn(
      UploadManager.prototype,
      "continueUploads",
    );
    await render();
    await addStatic(1);
    await until(() => current.transfer.starts.length === 1);
    const manager = draftItems.mock.contexts.at(-1) as UploadManager;
    await act(async () => {
      manager.pause("offline");
      await settle();
    });
    await until(() => container.querySelector("[data-media-paused]") !== null);
    expect(tiles()[0]?.status).toBe("paused");
    expect(announcer()).toContain("第 1 项已暂停");
    await click(buttonByText("继续上传"));
    expect(continueUploads).toHaveBeenCalled();
    await until(() => current.transfer.starts.length === 2);
  });

  it("ignores late identification after the session ends", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await render("phone", {
      identify: async (files) => {
        await pending;
        return identifyFiles(files);
      },
    });
    await setFiles(pickerInput(), [fileOf(jpeg({}), "late.jpg")]);
    await act(async () => {
      probe.upload!.closeSession({ discard: true });
      await settle();
    });
    await act(async () => {
      release();
      await settle();
    });
    await flush();
    expect(current.uploads.client.registerItem).not.toHaveBeenCalled();
    expect(current.transfer.starts).toHaveLength(0);
    const picker = container.querySelector("[data-media-picker]")!;
    expect(picker.textContent).toContain("暂时无法添加图片");
    expect(picker.querySelector<HTMLButtonElement>("button")!.disabled).toBe(
      true,
    );
    await dispatch(
      container.querySelector("[data-media-section]")!,
      fileDrag("drop", [fileOf(jpeg({}), "refused.jpg")]),
    );
    expect(announcer()).toBe("暂时无法添加图片");
    expect(container.querySelector("[data-media-staging]")).toBeNull();
  });
});

describe("MediaSection feed preview (#244)", () => {
  it("shows the stage preview in content order with the first image rightmost", async () => {
    await render();
    expect(container.querySelector("[data-media-composer]")).toBe(null);
    await addStatic(2);
    const stage = container.querySelector<HTMLElement>(
      "[data-media-composer] [data-feed-preview-stage]",
    )!;
    expect(stage.getAttribute("data-feed-stage-count")).toBe("2");
    expect(stage.getAttribute("data-feed-stage-index")).toBe("0");
    expect(stage.className).toContain("postStrip");
    expect(
      [...container.querySelectorAll("[data-feed-slide]")].map((slide) =>
        slide.getAttribute("data-feed-slide"),
      ),
    ).toEqual(["0", "1"]);
    expect(
      container.querySelector("[data-feed-preview-caption]")!.textContent,
    ).toContain("第 1 张在最右");
    // The strip keeps its own order controls; the stage is a preview only.
    expect(tiles().map((tile) => tile.handle)).toEqual([
      "第 1 项，照片，长按可拖动排序或多选",
      "第 2 项，照片，长按可拖动排序或多选",
    ]);
    // Removing the last item removes the preview with it.
    await click(buttonByText("移除第 2 项"));
    await click(buttonByText("移除第 1 项"));
    await until(() => tiles().length === 0);
    expect(container.querySelector("[data-media-composer]")).toBe(null);
  });

  it("leaves the order to the strip alone: no second reorder control beside the stage", async () => {
    await render("desktop");
    await addStatic(3);
    const [a, b, c] = storeKeys();
    const composer = container.querySelector("[data-media-composer]")!;
    expect(composer.getAttribute("aria-label")).toBe("动态预览");
    expect(composer.querySelector("[data-feed-preview-stage]")).not.toBe(null);
    // Plan v2: the desktop column has the stage, the strip and its dialogs.
    expect(container.querySelector("[data-order-rail]")).toBe(null);
    expect(container.querySelector("[data-rail-key]")).toBe(null);
    expect(composer.querySelector("button[data-media-handle]")).toBe(null);

    // The strip still orders; the stage follows it.
    await click(buttonByText("下移第 1 项"));
    expect(storeKeys()).toEqual([b, a, c]);
    expect(tiles().map((tile) => tile.key)).toEqual([b, a, c]);
  });

  it("gives the first item's edit dialog the feed window and its stage ratio", async () => {
    await render();
    await addStatic(2);
    await makeFirstReady();
    await click(buttonByText("编辑第 1 项"));
    const dialog = document.querySelector<HTMLElement>(
      "[data-media-edit-dialog]",
    )!;
    // Presentation 4 × 3: a frame wider than the square stage is shown whole.
    expect(
      dialog.querySelector("[data-feed-window]")!.getAttribute("data-feed-fit"),
    ).toBe("contain");
    expect(dialog.textContent).toContain("动态中整张显示，上下留白");
    expect(dialog.textContent).toContain("由第 1 张决定");
    const toggle = dialog.querySelector<HTMLButtonElement>(
      '[data-editor-switch="feed-window"] [role="switch"]',
    )!;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(dialog.querySelector('input[type="range"]')).toBe(null);
    await click(buttonByText("返回"));
  });

  it("keeps the dialog's 局部 · 整张 choice with 完成, and 还原 clears it (#341)", async () => {
    await render("desktop");
    await addStatic(2);
    await makeFirstReady();
    const fitPicker = () =>
      document.querySelector<HTMLElement>(
        "[data-media-edit-dialog] [data-feed-fit-picker]",
      );
    const choice = (fit: "region" | "whole") =>
      fitPicker()!.querySelector<HTMLInputElement>(
        `[data-feed-choice="${fit}"]`,
      )!;

    await click(buttonByText("编辑第 1 项"));
    let dialog = document.querySelector<HTMLElement>(
      "[data-media-edit-dialog]",
    )!;
    // Presentation 4 × 3 is shown whole: nothing to choose.
    expect(fitPicker()).toBe(null);
    // Turned, the 3 × 4 frame is taller than its 4:5 stage.
    await click(buttonByText("向右旋转 90°", dialog));
    expect(choice("region").checked).toBe(true);
    await click(choice("whole"));
    await click(buttonByText("完成", dialog));
    expect(probe.store!.get().items[0]!.edit).toEqual({
      rotation: 90,
      crop: null,
      feed: { fit: "contain" },
    });

    // A framing-only change is kept too; the pixels stay.
    await click(buttonByText("编辑第 1 项"));
    dialog = document.querySelector<HTMLElement>("[data-media-edit-dialog]")!;
    expect(choice("whole").checked).toBe(true);
    await click(choice("region"));
    await click(buttonByText("完成", dialog));
    expect(probe.store!.get().items[0]!.edit).toEqual({
      rotation: 90,
      crop: null,
    });

    await click(buttonByText("编辑第 1 项"));
    dialog = document.querySelector<HTMLElement>("[data-media-edit-dialog]")!;
    await click(choice("whole"));
    await click(buttonByText("还原", dialog));
    expect(fitPicker()).toBe(null);
    await click(buttonByText("完成", dialog));
    expect(probe.store!.get().items[0]!.edit).toEqual({
      rotation: 0,
      crop: null,
    });
  });
});

describe("useMediaActions for the phone composer (#244)", () => {
  const photos = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      fileOf(jpeg({ width: 4 + index }), `photo-${index}.jpg`),
    );
  const stage = async (files: File[]) => {
    let outcome: StageOutcome | null = null;
    await act(async () => {
      outcome = await hook.actions!.stage(files, "picker");
      await settle();
    });
    return outcome;
  };
  const run = async (action: (actions: MediaActions) => void) => {
    await act(async () => {
      action(hook.actions!);
      await settle();
    });
  };
  const crop = { x: 0.1, y: 0.1, width: 0.5, height: 0.5 };

  it("says what became of each selection", async () => {
    await renderActions({}, { maxItems: 3 });
    expect(await stage(photos(2))).toEqual({
      status: "added",
      keys: storeKeys(),
      replaced: null,
      unsupported: 0,
    });
    expect(await stage(photos(2))).toEqual({
      status: "refused",
      reason: "items_limit",
    });
    expect(await stage([])).toEqual({ status: "dropped" });
    expect(storeKeys()).toHaveLength(2);
  });

  it("says when the files could not be read", async () => {
    await renderActions(
      {},
      {
        identify: async () => {
          throw new Error("unreadable");
        },
      },
    );
    expect(await stage(photos(1))).toEqual({ status: "unreadable" });
    expect(hook.actions!.notice).toBe("文件无法读取，请重新选择");
  });

  it("keeps 首图 = 封面 when asked to", async () => {
    await renderActions({ coverFollowsFirst: true });
    await stage(photos(3));
    const [a, b, c] = storeKeys();
    await run((actions) => actions.applyCoverCrop(a!, crop));
    expect(probe.store!.get().coverKey).toBe(a);

    await run((actions) => actions.reorder(c!, 0));
    expect(storeKeys()).toEqual([c, a, b]);
    expect(probe.store!.get()).toMatchObject({ coverKey: c, coverCrop: null });
    expect(hook.actions!.notice).toBe(
      "首图已更换，封面构图已恢复为完整画面，可重新调整",
    );

    await run((actions) => actions.move(a!, -1, "keep"));
    expect(storeKeys()).toEqual([a, c, b]);
    expect(probe.store!.get().coverKey).toBe(a);

    await run((actions) => actions.makeFirst(b!));
    expect(storeKeys()).toEqual([b, a, c]);
    expect(probe.store!.get().coverKey).toBe(b);
    expect(hook.actions!.announcement).toBe("第 3 项已设为首图");
  });

  it("makes an item the 首图 when its cover is chosen or composed under 首图 = 封面", async () => {
    await renderActions({ coverFollowsFirst: true });
    await stage(photos(3));
    const [a, b, c] = storeKeys();
    await run((actions) => actions.applyCoverCrop(c!, crop));
    expect(storeKeys()).toEqual([c, a, b]);
    expect(probe.store!.get()).toMatchObject({ coverKey: c, coverCrop: crop });
    expect(hook.actions!.announcement).toBe("第 3 项已设为首图并更新封面构图");

    // The 首图's own composition changes in place.
    const tighter = { x: 0.2, y: 0.2, width: 0.4, height: 0.4 };
    await run((actions) => actions.applyCoverCrop(c!, tighter));
    expect(storeKeys()).toEqual([c, a, b]);
    expect(probe.store!.get()).toMatchObject({
      coverKey: c,
      coverCrop: tighter,
    });
    expect(hook.actions!.announcement).toBe("封面构图已更新");

    await run((actions) => actions.chooseCover(b!));
    expect(storeKeys()).toEqual([b, c, a]);
    expect(probe.store!.get()).toMatchObject({ coverKey: b, coverCrop: null });
    expect(hook.actions!.announcement).toBe("第 3 项已设为首图");
  });

  it("leaves a chosen cover in place by default, while 设为首图 still takes it along", async () => {
    await renderActions({});
    await stage(photos(3));
    const [a, b, c] = storeKeys();
    await run((actions) => actions.applyCoverCrop(b!, crop));
    await run((actions) => actions.reorder(c!, 0));
    expect(storeKeys()).toEqual([c, a, b]);
    expect(probe.store!.get()).toMatchObject({ coverKey: b, coverCrop: crop });

    await run((actions) => actions.makeFirst(a!));
    expect(storeKeys()).toEqual([a, c, b]);
    expect(probe.store!.get()).toMatchObject({ coverKey: a, coverCrop: null });

    await run((actions) => actions.chooseCover(b!));
    expect(storeKeys()).toEqual([a, c, b]);
    expect(probe.store!.get().coverKey).toBe(b);
  });

  it("commits a deferred removal quietly, leaving focus where the author is unless it fell to the page", async () => {
    await renderActions({
      deferredRemoval: true,
      focusTarget: () => "[data-actions-probe]",
    });
    await stage(photos(3));
    const [a, b] = storeKeys();
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    elsewhere.focus();
    await run((actions) => actions.remove(a!));
    expect(storeKeys()).not.toContain(a);
    // The screen's toast said it when the photo went: nothing more now.
    expect(hook.actions!.announcement).not.toContain("已移除");
    expect(document.activeElement).toBe(elsewhere);

    // Focus fell to the page meanwhile: the photo in its place takes it.
    elsewhere.blur();
    expect(document.activeElement).toBe(document.body);
    await run((actions) => actions.remove(b!));
    expect(document.activeElement).toBe(
      container.querySelector("[data-actions-probe]"),
    );
    expect(hook.actions!.announcement).not.toContain("已移除");
    elsewhere.remove();
  });

  it("keeps an edit without saying so when asked to be quiet", async () => {
    await renderActions({});
    await stage(photos(2));
    const [a, b] = storeKeys();
    const turned = { rotation: 90, crop: null } as const;
    await run((actions) => actions.applyEdit(a!, turned, { quiet: true }));
    expect(probe.store!.get().items[0]!.edit).toEqual(turned);
    expect(hook.actions!.announcement).not.toContain("编辑已应用");
    await run((actions) => actions.applyEdit(b!, turned));
    expect(hook.actions!.announcement).toBe("第 2 项的编辑已应用");
  });

  it("keeps feed framing apart from the pixels, without a word (#341)", async () => {
    await renderActions({});
    await stage(photos(2));
    const [a] = storeKeys();
    await run((actions) => actions.applyCoverCrop(a!, crop));
    const said = hook.actions!.announcement;
    await run((actions) => actions.applyFeed(a!, { fit: "cover", y: 0.2 }));
    expect(probe.store!.get().items[0]!.edit).toEqual({
      rotation: 0,
      crop: null,
      feed: { fit: "cover", y: 0.2 },
    });
    // Never a pixel edit: the cover composition stays and nothing is said.
    expect(probe.store!.get()).toMatchObject({ coverKey: a, coverCrop: crop });
    expect(hook.actions!.announcement).toBe(said);
    expect(hook.actions!.notice).toBeNull();
    const version = probe.store!.get().editVersion;
    await run((actions) => actions.applyFeed(a!, { fit: "cover", y: 0.20001 }));
    expect(probe.store!.get().editVersion).toBe(version);

    // A rotate/crop edit keeps the framing and resets the composition.
    await run((actions) =>
      actions.applyEdit(a!, { rotation: 90, crop: null }, { quiet: true }),
    );
    expect(probe.store!.get()).toMatchObject({
      coverKey: a,
      coverCrop: null,
      items: [
        { edit: { rotation: 90, crop: null, feed: { fit: "cover", y: 0.2 } } },
        {},
      ],
    });
    // A centred cover is no framing.
    await run((actions) => actions.applyFeed(a!, undefined));
    expect(probe.store!.get().items[0]!.edit).toEqual({
      rotation: 90,
      crop: null,
    });
  });

  it("carries a photo's feed framing to its re-selection (#341)", async () => {
    await renderActions({});
    await stage(photos(2));
    const [a, b] = storeKeys();
    await run((actions) => actions.applyFeed(a!, { fit: "contain" }));
    await act(async () => {
      hook.actions!.startReplacement(a!, [
        fileOf(jpeg({ width: 9 }), "again.jpg"),
      ]);
      await settle();
    });
    await until(() => !storeKeys().includes(a!));
    const [first, second] = probe.store!.get().items;
    expect(first!.key).not.toBe(a);
    // The same photo again: its edit, framing included, travels.
    expect(first!.edit).toEqual({
      rotation: 0,
      crop: null,
      feed: { fit: "contain" },
    });
    expect(second!.key).toBe(b);
  });

  const phoneCoverRule = {
    apply: keepCoverOnFirst,
    notice: COVER_RESET_NOTICE,
  };

  it("keeps the phone's 首图 = 封面 when a re-selection replaces item 1", async () => {
    await renderActions({ coverRule: phoneCoverRule });
    await stage(photos(3));
    const [a, b, c] = storeKeys();
    await run((actions) => actions.applyCoverCrop(c!, crop));
    expect(probe.store!.get()).toMatchObject({ coverKey: c, coverCrop: crop });
    await act(async () => {
      hook.actions!.startReplacement(a!, [
        fileOf(jpeg({ width: 9 }), "again.jpg"),
      ]);
      await settle();
    });
    await until(() => !storeKeys().includes(a!));
    const [first, second, third] = storeKeys();
    expect([second, third]).toEqual([b, c]);
    expect(first).not.toBe(a);
    // Position 1 changed: the chosen cover falls back to it.
    expect(probe.store!.get()).toMatchObject({
      coverKey: null,
      coverCrop: null,
    });
    expect(hook.actions!.notice).toBe(COVER_RESET_NOTICE);
  });

  it("keeps the phone's 首图 = 封面 when the account cancels item 1 elsewhere", async () => {
    const draftItems = vi.spyOn(UploadManager.prototype, "draftItems");
    await renderActions({ coverRule: phoneCoverRule });
    await stage(photos(3));
    await until(registered);
    const [a, b, c] = storeKeys();
    await run((actions) => actions.applyCoverCrop(c!, crop));
    const manager = draftItems.mock.contexts.at(-1) as UploadManager;
    await act(async () => {
      await manager.cancelItem(a!);
      await settle();
    });
    await until(() => storeKeys().length === 2);
    expect(storeKeys()).toEqual([b, c]);
    expect(probe.store!.get()).toMatchObject({
      coverKey: null,
      coverCrop: null,
    });
    expect(hook.actions!.notice).toBe(
      `1 项已不可用，已从作品中移除；${COVER_RESET_NOTICE}`,
    );
  });

  it("flags a second caller for one editor session, not a layout swap", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const message = "useMediaActions mounted twice for one editor session";
    const draw = await renderActions({});
    await draw(1, 1);
    expect(error).not.toHaveBeenCalledWith(message);
    await draw(2, 1);
    expect(error).toHaveBeenCalledWith(message);
  });
});
