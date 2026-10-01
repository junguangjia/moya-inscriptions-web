// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ArticleDraft,
  ArticleMediaReference,
  PublishingMediaItem,
  UpdateArticleDraftCommand,
} from "@moya/contracts";
import { createExternalStore } from "../../publishing/upload-manager-store";
import type { UploadManagerSnapshot } from "../../publishing/upload-manager";
import type { ArticleEditorProps } from "./article-editor-props";
import type { MediaPickerProps } from "../../publishing/ui/media/media-picker";
import type { StagedChoicesProps } from "../../publishing/ui/media/staged-choices";
import type {
  IdentifiedFile,
  IdentifiedStill,
  IdentifiedMotion,
} from "../../publishing/import-grouping";

const state = vi.hoisted(() => ({
  account: "user-" + "1".repeat(32),
  epoch: 1,
  editor: null as ArticleEditorProps | null,
  picker: null as MediaPickerProps | null,
  staged: null as StagedChoicesProps | null,
  showFrame: false,
  frameActive: true,
}));
const identify = vi.hoisted(() => ({
  files: vi.fn<(files: File[]) => Promise<IdentifiedFile[]>>(),
  file: vi.fn<(file: File) => Promise<IdentifiedFile>>(),
}));
vi.mock("../../publishing/import-grouping", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../publishing/import-grouping")
  >()),
  identifyFiles: identify.files,
  identifyFile: identify.file,
}));
vi.mock("../../publishing/ui/media/media-picker", () => ({
  MediaPicker: (props: MediaPickerProps) => {
    state.picker = props;
    return (
      <button disabled={props.disabled} data-picker="">
        Pick files
      </button>
    );
  },
}));
vi.mock("../../publishing/ui/media/staged-choices", () => ({
  StagedChoices: (props: StagedChoicesProps) => {
    state.staged = props;
    return (
      <p data-staged="">{props.staging.batch?.entries.length} staged entries</p>
    );
  },
}));
vi.mock("../../../lib/public-api/work-publishing-client", () => ({
  publishingClient: { item: async () => liveItem },
}));
vi.mock("../../../lib/public-api/author-community-client", () => ({
  AuthorRequestError: class extends Error {},
  authorClient: {
    account: () => state.account,
    accountEpoch: () => state.epoch,
  },
}));
vi.mock("./article-authoring-boundary", () => ({
  ArticleAuthoringBoundary: (props: ArticleEditorProps) => {
    state.editor = props;
    return (
      <>
        <p data-active-editor="">Editor active</p>
        {state.showFrame
          ? props.media.render(
              { type: "managed", itemId: liveItem.id },
              { alt: "合成实况", active: state.frameActive },
            )
          : null}
      </>
    );
  },
}));
const snapshots = createExternalStore<UploadManagerSnapshot>({
  accountId: state.account,
  status: "active",
  pauseReason: null,
  items: [],
});
const session = {
  manager: { store: snapshots, release: vi.fn() },
  limits: vi.fn(async () => ({ maxItems: 20 })),
  releaseCommittedUploads: vi.fn(async () => true),
  discard: vi.fn(async () => undefined),
  dispose: vi.fn(),
};
vi.mock("./article-upload-session", () => ({
  createArticleUploadSession: vi.fn(() => session),
}));
const save = vi.fn<
  (
    id: ArticleDraft["id"],
    command: UpdateArticleDraftCommand,
    signal: AbortSignal,
  ) => Promise<ArticleDraft>
>(async () => initial);
vi.mock("../../../lib/public-api/article-authoring-client", () => ({
  articleAuthoringClient: {
    save: (
      id: ArticleDraft["id"],
      command: UpdateArticleDraftCommand,
      signal: AbortSignal,
    ) => save(id, command, signal),
  },
  articleAuthoringLimits: { galleryImages: 20 },
}));
import { ArticleAuthoringWorkspace } from "./article-authoring-workspace";

const initial: ArticleDraft = {
  id: `article-${"2".repeat(32)}` as ArticleDraft["id"],
  ownerId: state.account as ArticleDraft["ownerId"],
  title: "合成专题",
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
  updatedAt: "2026-09-30T00:00:00.000Z",
  fingerprint: "a".repeat(64),
};
const item = (value: string, ready = true): PublishingMediaItem => ({
  id: `media-item-${value.repeat(32)}`,
  kind: "static",
  qualityMode: "standard",
  state: ready ? "ready" : "processing",
  failureCode: null,
  components: [
    {
      id: `media-component-${value.repeat(32)}`,
      role: "still",
      state: "verified",
      byteSize: 4,
      receivedBytes: 4,
    },
  ],
  presentation: { width: 4, height: 3 },
  media: ready
    ? {
        thumbSrc: `/api/community/publishing/media/media-item-${value.repeat(32)}/thumb/base`,
        displaySrc: `/api/community/publishing/media/media-item-${value.repeat(32)}/display/base`,
      }
    : null,
});
const liveItem: PublishingMediaItem = {
  ...item("6"),
  kind: "live",
  presentation: { width: 4, height: 3, hasAudio: true },
  media: {
    thumbSrc: "/synthetic/live-thumb",
    displaySrc: "/synthetic/live-still",
    motionSrc: "/synthetic/live-motion",
  },
};
const deferred = <Value,>() => {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
const still = (): IdentifiedStill => ({
  kind: "still",
  file: new File(["synthetic"], "pair.jpg", { type: "image/jpeg" }),
  type: "image/jpeg",
  orientation: 1,
  contentIdentifier: "synthetic-pair",
  appleMakerNote: true,
  motionPhoto: null,
  motionPhotoInvalid: false,
});
const motion = (): IdentifiedMotion => ({
  kind: "motion",
  file: new File(["synthetic"], "pair.mov", { type: "video/quicktime" }),
  type: "video/quicktime",
  contentIdentifier: "synthetic-pair",
  audioTracks: 1,
  stillTimeMs: 0,
});
let root: Root | null = null;
let node: HTMLDivElement;
const reloadMedia = vi.fn(async () => undefined);
const onBack = vi.fn();
const render = async (
  sessionKey = "account:article:1",
  covered = false,
  strict = false,
) => {
  const workspace = (
    <ArticleAuthoringWorkspace
      sessionKey={sessionKey}
      covered={covered}
      initial={initial}
      layout="phone"
      mediaItems={[item("3"), item("5"), item("4", false)]}
      mediaLoading={false}
      mediaHasMore={false}
      reloadMedia={reloadMedia}
      loadMoreMedia={async () => undefined}
      onBack={onBack}
      onPublished={() => undefined}
      onReloadDraft={() => undefined}
      onOpenCatalog={() => undefined}
    />
  );
  await act(async () =>
    root!.render(strict ? <StrictMode>{workspace}</StrictMode> : workspace),
  );
};
const mount = async () => {
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await render();
};
const choose = async () => {
  const abort = new AbortController();
  let answer!: Promise<readonly ArticleMediaReference[]>;
  await act(async () => {
    answer = state.editor!.media.choose({
      multiple: true,
      signal: abort.signal,
    });
  });
  return { answer, abort };
};
const click = async (button: HTMLButtonElement) => {
  await act(async () => button.click());
};
beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  state.account = initial.ownerId;
  state.epoch = 1;
  state.editor = null;
  state.picker = null;
  state.staged = null;
  state.showFrame = false;
  state.frameActive = true;
  vi.clearAllMocks();
  session.limits.mockReset().mockResolvedValue({ maxItems: 20 });
  identify.files.mockReset();
  identify.file.mockReset();
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(
    () => undefined,
  );
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(
    () => undefined,
  );
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("Article authoring media workspace", () => {
  it("keeps the loaded epoch across identity recovery and releases a clean readonly exit without stale lease writes", async () => {
    await mount();
    expect(state.editor!.accountEpoch).toBe(1);
    state.epoch += 2;
    await render();
    expect(state.editor!.accountEpoch).toBe(1);
    await act(async () => state.editor!.onBack());
    expect(session.discard).not.toHaveBeenCalled();
    expect(session.manager.release).toHaveBeenCalled();
    expect(session.dispose).toHaveBeenCalled();
    expect(onBack).toHaveBeenCalledOnce();
  });
  it("ignores the disposed StrictMode limits request while reporting a current session failure", async () => {
    let reject!: (error: Error) => void;
    session.limits.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    node = document.createElement("div");
    document.body.append(node);
    root = createRoot(node);
    await render("account:article:1", false, true);
    expect(session.limits).toHaveBeenCalledTimes(2);
    await act(async () => reject(new Error("synthetic disposed request")));
    expect(node.textContent).not.toContain("暂时无法读取或上传素材");
    session.limits.mockRejectedValueOnce(
      new Error("synthetic current request"),
    );
    await render("account:article:2", false, true);
    expect(node.textContent).toContain("暂时无法读取或上传素材");
  });
  it("returns only selected ready managed identities and preserves selection order", async () => {
    await mount();
    const abort = new AbortController();
    let answer!: Promise<readonly ArticleMediaReference[]>;
    await act(async () => {
      answer = state.editor!.media.choose({
        multiple: true,
        signal: abort.signal,
      });
    });
    expect(reloadMedia).toHaveBeenCalledOnce();
    const assets = [
      ...node.querySelectorAll<HTMLButtonElement>("button[aria-pressed]"),
    ];
    expect(assets).toHaveLength(3);
    expect(assets[2]!.disabled).toBe(true);
    await click(assets[1]!);
    await click(assets[0]!);
    const confirm = [
      ...node.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "使用已选素材")!;
    await click(confirm);
    expect(await answer).toEqual([
      { type: "managed", itemId: item("5").id },
      { type: "managed", itemId: item("3").id },
    ]);
    expect(node.querySelector("dialog")).toBeNull();
  });
  it("cancels a pending chooser on lifetime abort and disposes its owned upload session", async () => {
    await mount();
    const abort = new AbortController();
    let answer!: Promise<readonly ArticleMediaReference[]>;
    await act(async () => {
      answer = state.editor!.media.choose({
        multiple: false,
        signal: abort.signal,
      });
    });
    await act(async () => abort.abort());
    expect(await answer).toEqual([]);
    expect(node.querySelector("dialog")).toBeNull();
    await act(async () => root!.unmount());
    root = null;
    expect(session.manager.release).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalledOnce();
  });
  it("refuses a late selection after A to B to A identity drift", async () => {
    await mount();
    const abort = new AbortController();
    let answer!: Promise<readonly ArticleMediaReference[]>;
    await act(async () => {
      answer = state.editor!.media.choose({
        multiple: false,
        signal: abort.signal,
      });
    });
    await click(node.querySelector<HTMLButtonElement>("button[aria-pressed]")!);
    state.account = `user-${"9".repeat(32)}`;
    state.epoch++;
    state.account = initial.ownerId;
    state.epoch++;
    await click(
      [...node.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "使用已选素材",
      )!,
    );
    expect(await answer).toEqual([]);
  });
  it.each(["remove", "cancel"] as const)(
    "does not restore a removed staging batch after delayed counterpart identification: %s",
    async (action) => {
      await mount();
      await choose();
      const original = still();
      identify.files.mockResolvedValueOnce([original]);
      await act(async () => state.picker!.onFiles([original.file], "picker"));
      const choices = state.staged!;
      const key = choices.staging.batch!.entries[0]!.key;
      const delayed = deferred<IdentifiedFile>();
      identify.file.mockReturnValueOnce(delayed.promise);
      let attached!: ReturnType<StagedChoicesProps["onAttach"]>;
      await act(async () => {
        attached = choices.onAttach(key, motion().file);
      });
      await act(async () => {
        if (action === "remove") choices.onRemove(key);
        else choices.onCancel();
      });
      await act(async () => delayed.resolve(motion()));
      expect(await attached).toBe("entry_missing");
      if (action === "cancel")
        expect(node.querySelector("[data-staged]")).toBeNull();
      else expect(state.staged!.staging.batch!.entries).toHaveLength(0);
    },
  );
  it("does not overwrite a newer batch revision with a delayed pairing result", async () => {
    await mount();
    await choose();
    const original = still();
    identify.files.mockResolvedValueOnce([original]);
    await act(async () => state.picker!.onFiles([original.file], "picker"));
    const choices = state.staged!;
    const delayed = deferred<IdentifiedFile>();
    identify.file.mockReturnValueOnce(delayed.promise);
    let attached!: ReturnType<StagedChoicesProps["onAttach"]>;
    await act(async () => {
      attached = choices.onAttach(
        choices.staging.batch!.entries[0]!.key,
        motion().file,
      );
    });
    const added = {
      ...still(),
      file: new File(["new"], "new.jpg", { type: "image/jpeg" }),
      contentIdentifier: null,
      appleMakerNote: false,
    };
    identify.files.mockResolvedValueOnce([added]);
    await act(async () => state.picker!.onFiles([added.file], "picker"));
    await act(async () => delayed.resolve(motion()));
    expect(await attached).toBe("entry_missing");
    expect(state.staged!.staging.batch!.entries).toHaveLength(2);
    expect(state.staged!.staging.batch!.entries[0]!.status).toBe(
      "needs_counterpart",
    );
  });
  it("rejects a pairing completed for the previous session without replacing new-session input", async () => {
    await mount();
    await choose();
    const original = still();
    identify.files.mockResolvedValueOnce([original]);
    await act(async () => state.picker!.onFiles([original.file], "picker"));
    const choices = state.staged!;
    const delayed = deferred<IdentifiedFile>();
    identify.file.mockReturnValueOnce(delayed.promise);
    let attached!: ReturnType<StagedChoicesProps["onAttach"]>;
    await act(async () => {
      attached = choices.onAttach(
        choices.staging.batch!.entries[0]!.key,
        motion().file,
      );
    });
    await render("account:article:2");
    await choose();
    const fresh = {
      ...still(),
      file: new File(["fresh"], "fresh.jpg", { type: "image/jpeg" }),
      contentIdentifier: null,
      appleMakerNote: false,
    };
    identify.files.mockResolvedValueOnce([fresh]);
    await act(async () => state.picker!.onFiles([fresh.file], "picker"));
    const current = state.staged!.staging.batch;
    await act(async () => delayed.resolve(motion()));
    expect(await attached).toBe("entry_missing");
    expect(state.staged!.staging.batch).toBe(current);
    expect(state.staged!.staging.batch!.entries).toHaveLength(1);
  });
  it("rejects a pairing completed after its chooser was cancelled and reopened", async () => {
    await mount();
    const first = await choose();
    const original = still();
    identify.files.mockResolvedValueOnce([original]);
    await act(async () => state.picker!.onFiles([original.file], "picker"));
    const choices = state.staged!;
    const delayed = deferred<IdentifiedFile>();
    identify.file.mockReturnValueOnce(delayed.promise);
    let attached!: ReturnType<StagedChoicesProps["onAttach"]>;
    await act(async () => {
      attached = choices.onAttach(
        choices.staging.batch!.entries[0]!.key,
        motion().file,
      );
    });
    await act(async () => first.abort.abort());
    expect(await first.answer).toEqual([]);
    await choose();
    await act(async () => delayed.resolve(motion()));
    expect(await attached).toBe("entry_missing");
    expect(node.querySelector("[data-staged]")).toBeNull();
  });
  it("enables uploads in a new session while old file identification is pending and ignores its completion", async () => {
    await mount();
    await choose();
    const delayed = deferred<IdentifiedFile[]>();
    identify.files.mockReturnValueOnce(delayed.promise);
    await act(async () => state.picker!.onFiles([still().file], "picker"));
    expect(state.picker!.disabled).toBe(true);
    await render("account:article:2");
    await choose();
    expect(state.picker!.disabled).toBe(false);
    const fresh = {
      ...still(),
      file: new File(["fresh"], "fresh.jpg", { type: "image/jpeg" }),
      contentIdentifier: null,
      appleMakerNote: false,
    };
    identify.files.mockResolvedValueOnce([fresh]);
    await act(async () => state.picker!.onFiles([fresh.file], "picker"));
    const current = state.staged!.staging.batch;
    await act(async () => delayed.resolve([still()]));
    expect(state.picker!.disabled).toBe(false);
    expect(state.staged!.staging.batch).toBe(current);
    expect(state.staged!.staging.batch!.entries).toHaveLength(1);
  });
  it("releases actual Live Photo motion when covered by the picker, an outer dialog, preview state, or teardown", async () => {
    state.showFrame = true;
    await mount();
    const play = async () => {
      const button = [
        ...node.querySelectorAll<HTMLButtonElement>("button"),
      ].find((entry) => entry.textContent?.includes("播放实况"))!;
      await click(button);
      const video = node.querySelector<HTMLVideoElement>("video")!;
      expect(video.getAttribute("src")).toBe("/synthetic/live-motion");
      return video;
    };
    const first = await play();
    const pending = await choose();
    expect(first.getAttribute("src")).toBeNull();
    expect(node.querySelector("video")).toBeNull();
    await act(async () => pending.abort.abort());
    expect(await pending.answer).toEqual([]);
    const second = await play();
    await render("account:article:1", true);
    expect(second.getAttribute("src")).toBeNull();
    expect(node.querySelector("video")).toBeNull();
    await render();
    const third = await play();
    state.frameActive = false;
    await render();
    expect(third.getAttribute("src")).toBeNull();
    expect(node.querySelector("video")).toBeNull();
    state.frameActive = true;
    await render();
    const fourth = await play();
    await act(async () => root!.unmount());
    root = null;
    expect(fourth.getAttribute("src")).toBeNull();
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
  });
});
