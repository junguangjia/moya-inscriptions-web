// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { author } = vi.hoisted(() => ({
  author: { viewer: null as { id: string } | null, checking: false },
}));
vi.mock("../authors/author-context", () => ({ useAuthors: () => author }));

import { identifyFiles } from "./import-grouping";
import { fileOf, jpeg } from "./parsers/synthetic-media.test-support";
import {
  PublishingProvider,
  useGlobalUploadProgress,
  useStagedItems,
  useSubmission,
  useUploadSession,
} from "./publishing-provider";
import {
  ACCOUNT,
  DRAFT_ID,
  OTHER_ACCOUNT,
  SESSION_ID,
  fakeClient,
  fakePreprocess,
  fakeTransfer,
  manualTimers,
  settle,
  absentMetadata,
  uuid,
} from "./upload-manager.test-support";

import type {
  PublishingClientPort,
  PublishingServices,
} from "./publishing-runtime";
import type {
  PublishingDraft,
  PublishingDraftConflict,
  SavePublishingDraftCommand,
  WorkDraftContent,
} from "@moya/contracts";
import type { Root } from "react-dom/client";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

interface Hooks {
  session: ReturnType<typeof useUploadSession>;
  staged: ReturnType<typeof useStagedItems>;
  progress: ReturnType<typeof useGlobalUploadProgress>;
  submission: ReturnType<typeof useSubmission>;
}

const latest: { current: Hooks | null } = { current: null };

const Probe = () => {
  latest.current = {
    session: useUploadSession(),
    staged: useStagedItems(),
    progress: useGlobalUploadProgress(),
    submission: useSubmission(),
  };
  return null;
};

const stamp = "2026-09-13T12:00:00.000Z";

const contentOf = (title: string): WorkDraftContent => ({
  title,
  body: "",
  authorship: { kind: "original" },
  visibility: "public",
  items: [],
  coverKey: null,
  coverCrop: null,
});

const draftOf = (
  content: WorkDraftContent,
  revision: number,
  conflict: PublishingDraftConflict | null = null,
): PublishingDraft => ({
  id: DRAFT_ID,
  kind: "new",
  workId: null,
  baseRevisionId: null,
  revision,
  content,
  mediaItems: [],
  conflict,
  deviceClass: "desktop",
  createdAt: stamp,
  updatedAt: stamp,
});

const services = () => {
  const uploads = fakeClient();
  const account = { id: null as string | null };
  const timers = manualTimers();
  const drafts = {
    saveDraft: vi.fn(
      async (_draftId: string, cmd: SavePublishingDraftCommand) => ({
        status: "saved" as const,
        draft: draftOf(cmd.content, cmd.baseRevision + 1),
      }),
    ),
  };
  const client = {
    ...drafts,
    ...uploads.client,
    limits: vi.fn(async () => ({
      maxItems: 50,
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
  };
  return {
    account,
    drafts,
    timers,
    services: {
      client: client as unknown as PublishingClientPort,
      currentAccount: () => account.id,
      requestId: uuid,
      createTransfer: () => fakeTransfer().transfer,
      createPreprocess: () => fakePreprocess(),
      createHasher: () => null,
      createRecovery: () => null,
      identifyFiles: (files) => identifyFiles(files),
      preprocessConcurrency: () => 1,
      transferConcurrency: 2,
      deviceClass: () => "desktop",
      timers: timers.timers,
      metadata: absentMetadata,
    } satisfies PublishingServices,
  };
};

describe("PublishingProvider hooks", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    author.viewer = null;
    latest.current = null;
  });

  it("surfaces terminal derivative failure in global background progress and preserves cancellation", async () => {
    const fake = services();
    author.viewer = { id: ACCOUNT };
    fake.account.id = ACCOUNT;
    Object.assign(fake.services.client, {
      readiness: vi.fn(async () => ({
        ready: false,
        pendingItemKeys: [],
        failedItemKeys: ["existing"],
        editKeys: {},
      })),
    });
    await act(async () =>
      root.render(
        <PublishingProvider services={fake.services}>
          <Probe />
        </PublishingProvider>,
      ),
    );
    const content: WorkDraftContent = {
      ...contentOf("title"),
      items: [
        {
          key: "existing",
          itemId: `media-item-${"5".repeat(32)}`,
          kind: "static",
          qualityMode: "standard",
          edit: { rotation: 90, crop: null },
        },
      ],
    };
    await act(async () => {
      latest.current!.session.startSession({
        target: { type: "new" },
        saveMode: "saved",
        draft: draftOf(content, 1),
      });
      expect(latest.current!.submission.queue(content)).toBe(true);
      fake.timers.fireAll();
      await settle();
    });
    expect(latest.current!.progress).toMatchObject({
      active: true,
      backgroundPublication: true,
      publicationStatus: "queued",
      readiness: "图片需要处理，返回继续",
    });
    await act(async () => {
      expect(latest.current!.submission.cancelQueued()).toBe(true);
    });
    expect(latest.current!.submission.background).toBe(false);
    expect(latest.current!.session.session).not.toBeNull();
  });

  it("exposes an account-keyed session, staging and progress, isolated on account change", async () => {
    const fake = services();
    author.viewer = { id: ACCOUNT };
    fake.account.id = ACCOUNT;
    await act(async () => {
      root.render(
        <PublishingProvider services={fake.services}>
          <Probe />
        </PublishingProvider>,
      );
    });
    expect(latest.current!.session.accountId).toBe(ACCOUNT);
    await act(async () => {
      latest.current!.session.startSession({
        target: { type: "new" },
        saveMode: "unsaved",
      });
    });
    expect(latest.current!.session.session).toMatchObject({
      saveMode: "unsaved",
    });
    await act(async () => {
      await latest.current!.staged.stageFiles([fileOf(jpeg({}))], "picker");
    });
    expect(latest.current!.staged.staging?.count).toMatchObject({
      ready: 1,
      total: 1,
    });
    await act(async () => {
      expect(latest.current!.staged.confirm().ok).toBe(true);
      await settle();
    });
    expect(latest.current!.session.uploads?.items).toHaveLength(1);
    expect(latest.current!.progress).toMatchObject({
      active: true,
      itemCount: 1,
      paused: false,
    });
    expect(latest.current!.submission.state).toEqual({ status: "idle" });

    author.viewer = { id: OTHER_ACCOUNT };
    fake.account.id = OTHER_ACCOUNT;
    await act(async () => {
      root.render(
        <PublishingProvider services={fake.services}>
          <Probe />
        </PublishingProvider>,
      );
    });
    expect(latest.current!.session.accountId).toBe(OTHER_ACCOUNT);
    expect(latest.current!.session.session).toBeNull();
    expect(latest.current!.session.uploads?.items).toHaveLength(0);
    expect(latest.current!.progress).toMatchObject({
      active: false,
      itemCount: 0,
    });
  });

  it("adopts a chosen version through the session hook: the conflict ends and the next save uses its revision", async () => {
    const fake = services();
    author.viewer = { id: ACCOUNT };
    fake.account.id = ACCOUNT;
    await act(async () => {
      root.render(
        <PublishingProvider services={fake.services}>
          <Probe />
        </PublishingProvider>,
      );
    });
    await act(async () => {
      latest.current!.session.startSession({
        target: { type: "draft", id: DRAFT_ID },
        saveMode: "saved",
        draft: draftOf(contentOf("原稿"), 1),
      });
    });
    const conflict: PublishingDraftConflict = {
      id: `work-draft-${"2".repeat(32)}`,
      device: {
        content: contentOf("本设备"),
        baseRevision: 1,
        deviceClass: "desktop",
        savedAt: stamp,
      },
      account: {
        content: contentOf("账号"),
        revision: 3,
        deviceClass: "phone",
        updatedAt: stamp,
      },
      createdAt: stamp,
    };
    fake.drafts.saveDraft.mockResolvedValueOnce({
      status: "conflict",
      draft: draftOf(contentOf("账号"), 3, conflict),
      conflict,
    } as never);
    await act(async () => {
      latest.current!.session.edit(contentOf("本设备"));
      fake.timers.fireAll();
      await settle();
      await latest.current!.session.saveNow();
    });
    expect(latest.current!.session.autosave).toMatchObject({
      status: "conflict",
      conflict,
    });
    expect(latest.current!.progress.hasUnsavedChanges).toBe(true);

    await act(async () => {
      latest.current!.session.adoptDraft(
        draftOf(contentOf("账号"), 4),
        contentOf("账号"),
      );
    });
    expect(latest.current!.session.autosave).toMatchObject({
      status: "saved",
      revision: 4,
      conflict: null,
    });
    expect(latest.current!.progress.hasUnsavedChanges).toBe(false);

    await act(async () => {
      latest.current!.session.edit(contentOf("账号，继续编辑"));
      fake.timers.fireAll();
      await settle();
      await latest.current!.session.saveNow();
    });
    expect(fake.drafts.saveDraft).toHaveBeenCalledTimes(2);
    expect(fake.drafts.saveDraft.mock.calls[1]![1]).toMatchObject({
      baseRevision: 4,
      content: { title: "账号，继续编辑" },
    });
    expect(latest.current!.session.autosave).toMatchObject({
      status: "saved",
      revision: 5,
    });
  });

  it("hides items a chosen version leaves out from the session's draft items and the progress entry", async () => {
    const fake = services();
    author.viewer = { id: ACCOUNT };
    fake.account.id = ACCOUNT;
    await act(async () => {
      root.render(
        <PublishingProvider services={fake.services}>
          <Probe />
        </PublishingProvider>,
      );
    });
    await act(async () => {
      latest.current!.session.startSession({
        target: { type: "draft", id: DRAFT_ID },
        saveMode: "saved",
        draft: draftOf(contentOf("原稿"), 1),
      });
    });
    await act(async () => {
      await latest.current!.staged.stageFiles([fileOf(jpeg({}))], "picker");
    });
    await act(async () => {
      expect(latest.current!.staged.confirm().ok).toBe(true);
      await settle();
    });
    const [entry] = latest.current!.session.draftItems();
    expect(entry).toBeDefined();
    await act(async () => {
      latest.current!.session.edit({
        ...contentOf("有图"),
        items: [{ ...entry!, edit: { rotation: 0, crop: null } }],
      });
      fake.timers.fireAll();
      await settle();
    });
    // The upload is still running: the progress entry shows it.
    expect(latest.current!.progress).toMatchObject({
      active: true,
      itemCount: 1,
    });

    await act(async () => {
      latest.current!.session.adoptDraft(
        draftOf(contentOf("只有文字"), 4),
        contentOf("只有文字"),
      );
    });
    // What the editor merges from: the left-out item is never offered again.
    expect(latest.current!.session.draftItems()).toEqual([]);
    expect(latest.current!.session.uploads?.items).toHaveLength(1);
    expect(latest.current!.progress).toMatchObject({
      active: false,
      itemCount: 0,
      readiness: null,
    });
    expect(latest.current!.session.hasUnfinishedWork()).toBe(false);
  });
});
