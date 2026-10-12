import { describe, expect, it, vi } from "vitest";

import { identifyFiles } from "./import-grouping";
import {
  IDENTIFIER,
  fileOf,
  jpeg,
  motion,
} from "./parsers/synthetic-media.test-support";
import { PublishingRuntime, SESSION_HEARTBEAT_MS } from "./publishing-runtime";
import {
  ACCOUNT,
  DRAFT_ID,
  OTHER_ACCOUNT,
  SESSION_ID,
  clientError,
  fakeClient,
  fakePreprocess,
  fakeTransfer,
  manualTimers,
  recoveryDouble,
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
  PublishingMediaItem,
  PublishingReadiness,
  PublishingHolder,
  RegisterMediaItemCommand,
  WorkDraftContent,
  WorkDraftItem,
  WorkSubmissionResult,
} from "@moya/contracts";

const stamp = "2026-09-13T12:00:00.000Z";

const draftOf = (content: WorkDraftContent, revision = 1): PublishingDraft => ({
  id: DRAFT_ID,
  kind: "new",
  workId: null,
  baseRevisionId: null,
  revision,
  content,
  mediaItems: [],
  conflict: null,
  deviceClass: "desktop",
  createdAt: stamp,
  updatedAt: stamp,
});

const setup = (
  identify: PublishingServices["identifyFiles"] = identifyFiles,
) => {
  const uploads = fakeClient();
  const transfers: ReturnType<typeof fakeTransfer>[] = [];
  const preprocessors: ReturnType<typeof fakePreprocess>[] = [];
  const recovery = recoveryDouble();
  const timers = manualTimers();
  let account: string | null = null;
  const client = {
    ...uploads.client,
    limits: vi.fn(async () => ({
      maxItems: 2,
      originalItemMaxBytes: 1_000_000,
      standardComponentMaxBytes: 1_000_000,
      titleMax: 200,
      bodyMax: 10_000,
    })),
    createDraft: vi.fn(
      async (cmd: { content: WorkDraftContent; requestId: string }) =>
        draftOf(cmd.content),
    ),
    saveDraft: vi.fn(
      async (
        _id: string,
        cmd: { content: WorkDraftContent; baseRevision: number },
      ) => ({
        status: "saved" as const,
        draft: draftOf(cmd.content, cmd.baseRevision + 1),
      }),
    ),
    saveDraftNow: vi.fn(),
    draft: vi.fn(),
    submit: vi.fn(
      async (cmd: { requestId: string }): Promise<WorkSubmissionResult> => ({
        state: "confirmed" as const,
        requestId: cmd.requestId,
        workId: `work-${"9".repeat(32)}`,
        revisionId: `work-revision-${"8".repeat(32)}`,
        visibility: "public" as const,
        submittedAt: stamp,
      }),
    ),
    submissionReceipt: vi.fn(async () => null),
    createSession: vi.fn(async () => ({
      id: SESSION_ID,
      state: "active" as const,
      workId: null,
      leaseExpiresAt: stamp,
      createdAt: stamp,
    })),
    heartbeatSession: vi.fn(async () => undefined),
    discardSession: vi.fn(async () => ({ discarded: true as const })),
    deleteDraft: vi.fn(async () => ({
      deleted: true as const,
      snapshots: 2,
      conflictCopies: 0,
      mediaItems: 1,
    })),
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
    currentAccount: () => account,
    requestId: uuid,
    createTransfer: () => {
      const transfer = fakeTransfer();
      transfers.push(transfer);
      return transfer.transfer;
    },
    createPreprocess: () => {
      const preprocess = fakePreprocess();
      preprocessors.push(preprocess);
      return preprocess;
    },
    createHasher: () => null,
    createRecovery: () => recovery,
    identifyFiles: identify,
    preprocessConcurrency: () => 1,
    transferConcurrency: 2,
    deviceClass: () => "phone",
    timers: timers.timers,
    metadata: absentMetadata,
    onBackgroundPublished: vi.fn(),
  };
  const runtime = new PublishingRuntime(services);
  return {
    runtime,
    client,
    services,
    uploads,
    transfers,
    preprocessors,
    recovery,
    timers,
    signIn: (next: string | null) => {
      account = next;
      runtime.setAccount(next);
    },
  };
};

const content = (title: string): WorkDraftContent => ({
  title,
  body: "",
  authorship: { kind: "original" },
  visibility: "public",
  items: [],
  coverKey: null,
  coverCrop: null,
});

describe("background publication", () => {
  const pick = async (t: ReturnType<typeof setup>) => {
    t.signIn(ACCOUNT);
    t.runtime.startSession({ target: { type: "new" }, saveMode: "unsaved" });
    await t.runtime.stageFiles([fileOf(jpeg({}))], "picker");
    expect(t.runtime.confirmStaging().ok).toBe(true);
    await settle();
    const draft: WorkDraftContent = {
      ...content("frozen title"),
      body: "frozen body",
      visibility: "self",
      items: t.runtime
        .draftItems()
        .map((item) => ({ ...item, edit: { rotation: 0, crop: null } })),
    };
    t.runtime.edit(draft);
    return draft;
  };
  const receive = async (t: ReturnType<typeof setup>) => {
    const id = t.runtime.manager()!.getSnapshot().items[0]!.itemId!;
    t.transfers[0]!.starts.at(-1)!.callbacks.onSettled({
      status: 200,
      responseText: t.uploads.receive(id, "still"),
      stalled: false,
    });
    await settle();
    return id;
  };
  const ready = async (t: ReturnType<typeof setup>, id: string) => {
    t.uploads.makeReady(id);
    for (let i = 0; i < 4; i += 1) {
      t.timers.fireAll();
      await settle();
    }
  };

  it("keeps uploading after the editor leaves and publishes one frozen intent only after authoritative readiness", async () => {
    const t = setup();
    const draft = await pick(t);
    let mediaReady = false;
    t.client.readiness.mockImplementation(async (_holder, current) => ({
      ready: mediaReady,
      pendingItemKeys: mediaReady ? [] : current.items.map((i) => i.key),
      failedItemKeys: [],
      editKeys: {},
    }));
    expect(t.runtime.queuePublication(draft)).toBe(true);
    expect(t.runtime.queuePublication(draft)).toBe(true);
    expect(await t.runtime.closeSession({ discard: false })).toBe("kept");
    t.runtime.edit(content("late edit"));
    (draft as { title: string }).title = "mutated caller";
    expect(t.runtime.submission()?.store.get().status).toBe("queued");
    expect(t.client.submit).not.toHaveBeenCalled();
    const id = await receive(t);
    await ready(t, id);
    expect(t.client.submit).not.toHaveBeenCalled();
    mediaReady = true;
    await ready(t, id);
    expect(t.client.submit).toHaveBeenCalledOnce();
    expect(t.client.submit.mock.calls[0]![0]).toMatchObject({
      content: {
        title: "frozen title",
        body: "frozen body",
        visibility: "self",
        items: [{ itemId: id }],
      },
    });
    expect(t.services.onBackgroundPublished).toHaveBeenCalledOnce();
    expect(t.runtime.store.get().session).toBeNull();
    t.runtime.dispose();
  });

  it.each(["cancel", "discard"])(
    "fences late media readiness after %s",
    async (action) => {
      const t = setup();
      const draft = await pick(t);
      expect(t.runtime.queuePublication(draft)).toBe(true);
      if (action === "cancel") expect(t.runtime.cancelPublication()).toBe(true);
      else
        expect(await t.runtime.closeSession({ discard: true })).toBe("ended");
      if (action === "cancel") {
        const id = await receive(t);
        await ready(t, id);
        expect(t.runtime.store.get().session).not.toBeNull();
      }
      t.timers.fireAll();
      await settle();
      expect(t.client.submit).not.toHaveBeenCalled();
      expect(t.services.onBackgroundPublished).not.toHaveBeenCalled();
      t.runtime.dispose();
    },
  );

  it("pauses queued publication across accounts until the original author explicitly continues", async () => {
    const t = setup();
    const draft = await pick(t);
    t.runtime.queuePublication(draft);
    t.signIn(OTHER_ACCOUNT);
    t.timers.fireAll();
    await settle();
    expect(t.client.submit).not.toHaveBeenCalled();
    t.signIn(ACCOUNT);
    expect(t.runtime.store.get().publicationPaused).toBe(true);
    await t.runtime.continuePublication();
    const id = await receive(t);
    await ready(t, id);
    expect(t.client.submit).toHaveBeenCalledOnce();
    t.runtime.dispose();
  });

  it("does not send after an account change while the holder is being created", async () => {
    const t = setup();
    t.signIn(ACCOUNT);
    t.runtime.startSession({ target: { type: "new" }, saveMode: "unsaved" });
    let release!: (
      value: Awaited<ReturnType<typeof t.client.createSession>>,
    ) => void;
    t.client.createSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    t.runtime.queuePublication(content("title"));
    await settle();
    t.signIn(OTHER_ACCOUNT);
    release({
      id: SESSION_ID,
      state: "active",
      workId: null,
      leaseExpiresAt: stamp,
      createdAt: stamp,
    });
    await settle();
    expect(t.client.submit).not.toHaveBeenCalled();
    t.signIn(ACCOUNT);
    await t.runtime.continuePublication();
    await settle();
    expect(t.client.submit).toHaveBeenCalledOnce();
    t.runtime.dispose();
  });

  it("reacquires a missing holder on explicit resume after its earlier request failed under another account", async () => {
    const t = setup();
    t.signIn(ACCOUNT);
    const draft: WorkDraftContent = {
      ...content("ready photo"),
      items: [
        {
          key: "existing",
          itemId: `media-item-${"5".repeat(32)}`,
          kind: "static",
          qualityMode: "standard",
          edit: { rotation: 0, crop: null },
        },
      ],
    };
    t.runtime.startSession({
      target: { type: "new" },
      saveMode: "unsaved",
      content: draft,
    });
    let reject!: (error: Error) => void;
    t.client.createSession.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    t.runtime.queuePublication(draft);
    await settle();
    t.signIn(OTHER_ACCOUNT);
    reject(new Error("offline"));
    await settle();
    t.signIn(ACCOUNT);
    await t.runtime.continuePublication();
    for (let i = 0; i < 4; i += 1) {
      t.timers.fireAll();
      await settle();
    }
    expect(t.client.createSession).toHaveBeenCalledTimes(2);
    expect(t.client.submit).toHaveBeenCalledOnce();
    expect(t.client.submit.mock.calls[0]![0]).toMatchObject({
      content: { title: "ready photo" },
    });
    t.runtime.dispose();
  });

  it("creates a holder for existing ready photos and rejects a late version adoption", async () => {
    const t = setup();
    t.signIn(ACCOUNT);
    const draft = {
      ...content("kept title"),
      items: [
        {
          key: "existing",
          itemId: `media-item-${"5".repeat(32)}`,
          kind: "static" as const,
          qualityMode: "standard" as const,
          edit: { rotation: 0 as const, crop: null },
        },
      ],
    };
    t.runtime.startSession({
      target: { type: "new" },
      saveMode: "unsaved",
      content: draft,
    });
    expect(t.runtime.queuePublication(draft)).toBe(true);
    t.runtime.adoptDraft(
      draftOf(content("old history")),
      content("old history"),
    );
    for (let i = 0; i < 4; i += 1) {
      await settle();
      t.timers.fireAll();
    }
    await settle();
    expect(t.client.createSession).toHaveBeenCalledOnce();
    expect(t.client.submit).toHaveBeenCalledOnce();
    expect(t.client.submit.mock.calls[0]![0]).toMatchObject({
      content: { title: "kept title" },
      holder: { sessionId: SESSION_ID },
    });
    t.runtime.dispose();
  });

  it("does not publish a terminal derivative failure and permits explicit cancellation", async () => {
    const t = setup();
    const draft = await pick(t);
    t.client.readiness.mockResolvedValue({
      ready: false,
      pendingItemKeys: [],
      failedItemKeys: draft.items.map((i) => i.key),
      editKeys: {},
    });
    t.runtime.queuePublication(draft);
    const id = await receive(t);
    await ready(t, id);
    expect(t.runtime.manager()!.getSnapshot().items[0]!.phase).toBe("ready");
    expect(t.runtime.editReadiness()?.get().answered?.failedItemKeys.size).toBe(
      1,
    );
    expect(t.client.submit).not.toHaveBeenCalled();
    expect(t.runtime.cancelPublication()).toBe(true);
    t.runtime.edit(content("editable again"));
    t.runtime.dispose();
  });

  it("waits again after a definitive not-ready response with the same frozen request", async () => {
    const t = setup();
    const draft = await pick(t);
    t.client.submit.mockResolvedValueOnce({
      state: "not_ready",
      itemKeys: draft.items.map((i) => i.key),
    });
    t.runtime.queuePublication(draft);
    const id = await receive(t);
    await ready(t, id);
    expect(t.client.submit).toHaveBeenCalledTimes(2);
    expect(t.client.submit.mock.calls[1]![0]).toEqual(
      t.client.submit.mock.calls[0]![0],
    );
    t.runtime.dispose();
  });

  it("keeps an unknown outcome for explicit receipt reconciliation without resending", async () => {
    const t = setup();
    t.signIn(ACCOUNT);
    t.runtime.startSession({ target: { type: "new" }, saveMode: "unsaved" });
    t.client.submit.mockRejectedValueOnce(clientError(0, "lost answer", true));
    t.runtime.queuePublication(content("title"));
    await settle();
    expect(t.runtime.submission()?.store.get().status).toBe("unconfirmed");
    expect(t.client.submissionReceipt).toHaveBeenCalledOnce();
    expect(await t.runtime.closeSession({ discard: true })).toBe("kept");
    await t.runtime.continuePublication();
    t.timers.fireAll();
    await settle();
    expect(t.client.submit).toHaveBeenCalledOnce();
    await t.runtime.submission()!.retry();
    expect(t.client.submit.mock.calls[1]![0]).toEqual(
      t.client.submit.mock.calls[0]![0],
    );
    expect(t.services.onBackgroundPublished).toHaveBeenCalledOnce();
    t.runtime.dispose();
  });
});

describe("publishing runtime", () => {
  it.each(["heartbeat", "discard"])(
    "clears an expired retained holder when the account switches during %s",
    async (waiting) => {
      const source = setup();
      source.signIn(ACCOUNT);
      source.runtime.startSession({
        target: { type: "new" },
        saveMode: "saved",
      });
      await source.runtime.stageFiles([fileOf(jpeg({}))], "picker");
      source.runtime.confirmStaging();
      await settle();
      const checkpoint = source.runtime.checkpoint()!;
      source.runtime.dispose();
      const identify = vi.fn(identifyFiles);
      const t = setup(identify);
      t.signIn(ACCOUNT);
      let release!: () => void;
      if (waiting === "heartbeat")
        t.client.heartbeatSession.mockImplementationOnce(
          () =>
            new Promise((_resolve, reject) => {
              release = () =>
                reject(Object.assign(new Error("expired"), { status: 404 }));
            }),
        );
      else {
        t.client.heartbeatSession.mockRejectedValueOnce(
          Object.assign(new Error("expired"), { status: 404 }),
        );
        t.client.discardSession.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              release = () => resolve({ discarded: true });
            }),
        );
      }
      const restoration = t.runtime.restoreCheckpoint(checkpoint);
      await settle();
      t.signIn(OTHER_ACCOUNT);
      t.runtime.startSession({ target: { type: "new" }, saveMode: "unsaved" });
      await settle();
      const other = t.runtime.store.get();
      release();
      await restoration;
      expect(t.runtime.store.get()).toEqual(other);
      expect(t.client.discardSession).toHaveBeenCalledTimes(
        waiting === "heartbeat" ? 0 : 1,
      );
      expect(identify).not.toHaveBeenCalled();
      t.signIn(ACCOUNT);
      expect(t.runtime.store.get().session?.sessionId).toBeNull();
      await t.runtime.stageFiles([fileOf(jpeg({}))], "picker");
      t.runtime.confirmStaging();
      await settle();
      expect(t.client.createSession).toHaveBeenCalledOnce();
      expect(t.client.registerItem.mock.calls.at(-1)![0]).toMatchObject({
        holder: { sessionId: SESSION_ID },
      });
      t.runtime.dispose();
    },
  );

  it.each(["heartbeat", "discard"])(
    "clears an expired holder when selection cancellation happens during %s",
    async (waiting) => {
      const source = setup();
      source.signIn(ACCOUNT);
      source.runtime.startSession({
        target: { type: "new" },
        saveMode: "saved",
      });
      await source.runtime.stageFiles([fileOf(jpeg({}))], "picker");
      source.runtime.confirmStaging();
      await settle();
      const checkpoint = source.runtime.checkpoint()!;
      expect(checkpoint.view.sessionId).toBe(SESSION_ID);
      source.runtime.dispose();
      const identify = vi.fn(identifyFiles);
      const t = setup(identify);
      t.signIn(ACCOUNT);
      let release!: () => void;
      if (waiting === "heartbeat")
        t.client.heartbeatSession.mockImplementationOnce(
          () =>
            new Promise((_resolve, reject) => {
              release = () =>
                reject(Object.assign(new Error("expired"), { status: 404 }));
            }),
        );
      else {
        t.client.heartbeatSession.mockRejectedValueOnce(
          Object.assign(new Error("expired"), { status: 404 }),
        );
        t.client.discardSession.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              release = () => resolve({ discarded: true });
            }),
        );
      }
      const restoration = t.runtime.restoreCheckpoint(checkpoint);
      await settle();
      t.runtime.cancelStaging();
      release();
      await restoration;
      expect(t.runtime.store.get().session?.sessionId).toBeNull();
      expect(t.client.discardSession).toHaveBeenCalledOnce();
      expect(identify).not.toHaveBeenCalled();
      await t.runtime.stageFiles([fileOf(jpeg({}))], "picker");
      t.runtime.confirmStaging();
      await settle();
      expect(t.client.createSession).toHaveBeenCalledOnce();
      expect(t.client.registerItem.mock.calls.at(-1)![0]).toMatchObject({
        holder: { sessionId: SESSION_ID },
      });
      t.runtime.dispose();
    },
  );

  it("keeps an otherwise empty session when leaving during photo identification", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const test = setup(async (files) => {
      await pending;
      return identifyFiles(files);
    });
    test.signIn(ACCOUNT);
    test.runtime.startSession({ target: { type: "new" }, saveMode: "saved" });
    const accepted = vi.fn(() => test.runtime.confirmStaging());
    const selected = test.runtime.stageFiles(
      [fileOf(jpeg({}))],
      "picker",
      accepted,
    );
    await settle();
    expect(await test.runtime.closeSession({ discard: false })).toBe("kept");
    release();
    await selected;
    expect(accepted).toHaveBeenCalledOnce();
    expect(test.runtime.draftItems()).toHaveLength(1);
    test.runtime.dispose();
  });

  it.each(["logout", "cancel", "replace-session"])(
    "fences a slow picker response after %s",
    async (action) => {
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const test = setup(async (files) => {
        await pending;
        return identifyFiles(files);
      });
      test.signIn(ACCOUNT);
      test.runtime.startSession({
        target: { type: "new" },
        saveMode: "unsaved",
      });
      const accepted = vi.fn(() => test.runtime.confirmStaging());
      const selected = test.runtime.stageFiles(
        [fileOf(jpeg({}))],
        "picker",
        accepted,
      );
      await settle();
      if (action === "logout") {
        test.signIn(null);
        test.signIn(ACCOUNT);
      } else if (action === "cancel") test.runtime.cancelStaging();
      else {
        await test.runtime.closeSession({ discard: true });
        test.runtime.startSession({
          target: { type: "new" },
          saveMode: "unsaved",
        });
      }
      release();
      await selected;
      expect(accepted).not.toHaveBeenCalled();
      expect(test.runtime.store.get().staging).toBeNull();
      expect(test.client.registerItem).not.toHaveBeenCalled();
      test.runtime.dispose();
    },
  );

  it.each(["cancel", "logout", "discard", "dispose"])(
    "releases hung and queued photo selections on %s without waiting for their bytes",
    async (action) => {
      const identify = vi.fn<PublishingServices["identifyFiles"]>();
      identify.mockImplementationOnce(() => new Promise(() => undefined));
      identify.mockImplementation(identifyFiles);
      const test = setup(identify);
      test.signIn(ACCOUNT);
      test.runtime.startSession({
        target: { type: "new" },
        saveMode: "unsaved",
      });
      const accepted = vi.fn();
      const first = test.runtime.stageFiles(
        [fileOf(jpeg({}))],
        "picker",
        accepted,
      );
      const queued = test.runtime.stageFiles(
        [fileOf(jpeg({}))],
        "picker",
        accepted,
      );
      const settled = vi.fn();
      void Promise.all([first, queued]).then(settled);
      await settle();
      expect(identify).toHaveBeenCalledOnce();
      expect(test.runtime.store.get().staging?.identifying).toBe(2);
      if (action === "cancel") test.runtime.cancelStaging();
      else if (action === "logout") {
        test.signIn(null);
        test.signIn(ACCOUNT);
      } else if (action === "discard") {
        await test.runtime.closeSession({ discard: true });
        test.runtime.startSession({
          target: { type: "new" },
          saveMode: "unsaved",
        });
      } else test.runtime.dispose();
      await settle();
      expect(settled).toHaveBeenCalledOnce();
      expect(accepted).not.toHaveBeenCalled();
      expect(test.runtime.store.get().staging).toBeNull();
      expect(test.runtime.checkpoint()?.pendingFiles ?? []).toHaveLength(0);
      if (action !== "dispose") {
        await test.runtime.stageFiles([fileOf(jpeg({}))], "picker");
        expect(identify).toHaveBeenCalledTimes(2);
        expect(test.runtime.store.get().staging?.identifying).toBe(0);
        expect(test.runtime.checkpoint()?.pendingFiles).toHaveLength(0);
      }
      test.runtime.dispose();
    },
  );

  it.each(["resolve", "reject"])(
    "ignores a cancelled reader's late %s while a new selection is still reading",
    async (completion) => {
      type Identified = Awaited<
        ReturnType<PublishingServices["identifyFiles"]>
      >;
      let resolveOld!: (files: Identified) => void;
      let rejectOld!: (error: Error) => void;
      const old = new Promise<Identified>((resolve, reject) => {
        resolveOld = resolve;
        rejectOld = reject;
      });
      let resolveNew!: (files: Identified) => void;
      const next = new Promise<Identified>((resolve) => {
        resolveNew = resolve;
      });
      const identify = vi.fn<PublishingServices["identifyFiles"]>();
      identify
        .mockImplementationOnce(() => old)
        .mockImplementationOnce(() => next);
      const test = setup(identify);
      test.signIn(ACCOUNT);
      test.runtime.startSession({
        target: { type: "new" },
        saveMode: "unsaved",
      });
      const file = fileOf(jpeg({}));
      const staleReady = vi.fn();
      const stale = test.runtime.stageFiles([file], "picker", staleReady);
      await settle();
      test.runtime.cancelStaging();
      await stale;
      const ready = vi.fn();
      const current = test.runtime.stageFiles([file], "picker", ready, true);
      await settle();
      expect(identify).toHaveBeenCalledTimes(2);
      const identified = await identifyFiles([file]);
      if (completion === "resolve") resolveOld(identified);
      else rejectOld(new Error("late file read failure"));
      await settle();
      expect(staleReady).not.toHaveBeenCalled();
      expect(ready).not.toHaveBeenCalled();
      expect(test.runtime.store.get().staging?.identifying).toBe(1);
      expect(test.runtime.store.get().staging?.batch.entries).toHaveLength(0);
      expect(test.runtime.checkpoint()?.pendingFiles).toMatchObject([
        { original: true },
      ]);
      resolveNew(identified);
      await current;
      expect(ready).toHaveBeenCalledOnce();
      expect(test.runtime.store.get().staging?.identifying).toBe(0);
      expect(test.runtime.store.get().staging?.batch.entries).toHaveLength(1);
      test.runtime.dispose();
    },
  );

  it("preserves pending selection order when only completed staging is cleared", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const identify = vi.fn<PublishingServices["identifyFiles"]>();
    identify
      .mockImplementationOnce(async (files) => {
        await pending;
        return identifyFiles(files);
      })
      .mockImplementation(identifyFiles);
    const test = setup(identify);
    test.signIn(ACCOUNT);
    test.runtime.startSession({ target: { type: "new" }, saveMode: "unsaved" });
    const order: number[] = [];
    const first = test.runtime.stageFiles([fileOf(jpeg({}))], "picker", () => {
      order.push(1);
    });
    const second = test.runtime.stageFiles([fileOf(jpeg({}))], "picker", () => {
      order.push(2);
    });
    await settle();
    test.runtime.cancelStaging(false);
    expect(identify).toHaveBeenCalledOnce();
    expect(test.runtime.checkpoint()?.pendingFiles).toHaveLength(2);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual([1, 2]);
    expect(test.runtime.store.get().staging?.identifying).toBe(0);
    test.runtime.dispose();
  });

  it("reports an ordinary identification error and still releases the queue", async () => {
    const identify = vi.fn<PublishingServices["identifyFiles"]>();
    identify
      .mockRejectedValueOnce(new Error("file read failure"))
      .mockImplementation(identifyFiles);
    const test = setup(identify);
    test.signIn(ACCOUNT);
    test.runtime.startSession({ target: { type: "new" }, saveMode: "unsaved" });
    const first = test.runtime.stageFiles([fileOf(jpeg({}))], "picker");
    const next = test.runtime.stageFiles([fileOf(jpeg({}))], "picker");
    await expect(first).rejects.toThrow("file read failure");
    await next;
    expect(identify).toHaveBeenCalledTimes(2);
    expect(test.runtime.checkpoint()?.pendingFiles).toHaveLength(0);
    expect(test.runtime.store.get().staging?.identifying).toBe(0);
    test.runtime.dispose();
  });

  it.each(["cancel", "switch-account"])(
    "stops restoring retained selections after %s instead of reading the next old pick",
    async (action) => {
      const source = setup(() => new Promise(() => undefined));
      source.signIn(ACCOUNT);
      source.runtime.startSession({
        target: { type: "new" },
        saveMode: "saved",
      });
      const selections = [
        source.runtime.stageFiles([fileOf(jpeg({}))], "picker"),
        source.runtime.stageFiles([fileOf(jpeg({}))], "picker"),
      ];
      const checkpoint = source.runtime.checkpoint()!;
      source.runtime.dispose();
      await Promise.all(selections);
      const identify = vi.fn<PublishingServices["identifyFiles"]>();
      identify
        .mockImplementationOnce(() => new Promise(() => undefined))
        .mockImplementation(identifyFiles);
      const test = setup(identify);
      test.signIn(ACCOUNT);
      const restored = vi.fn();
      void test.runtime.restoreCheckpoint(checkpoint).then(restored);
      await settle();
      expect(identify).toHaveBeenCalledOnce();
      if (action === "cancel") test.runtime.cancelStaging();
      else {
        test.signIn(OTHER_ACCOUNT);
        test.runtime.startSession({
          target: { type: "new" },
          saveMode: "unsaved",
        });
      }
      await settle();
      expect(restored).toHaveBeenCalledOnce();
      expect(identify).toHaveBeenCalledOnce();
      expect(test.runtime.store.get().staging).toBeNull();
      expect(test.client.registerItem).not.toHaveBeenCalled();
      await test.runtime.stageFiles([fileOf(jpeg({}))], "picker");
      expect(identify).toHaveBeenCalledTimes(2);
      test.runtime.dispose();
    },
  );

  it("keeps a newer account's pending pick when an old asynchronous discard finishes", async () => {
    let resolveNew!: () => void;
    const pending = new Promise<void>((resolve) => {
      resolveNew = resolve;
    });
    const identify = vi.fn<PublishingServices["identifyFiles"]>();
    identify
      .mockImplementationOnce(identifyFiles)
      .mockImplementationOnce(async (files) => {
        await pending;
        return identifyFiles(files);
      });
    const test = setup(identify);
    let created!: () => void;
    const create = test.client.createSession.getMockImplementation()!;
    test.client.createSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          created = () => resolve(create());
        }),
    );
    test.signIn(ACCOUNT);
    test.runtime.startSession({ target: { type: "new" }, saveMode: "unsaved" });
    await test.runtime.stageFiles([fileOf(jpeg({}))], "picker");
    test.runtime.confirmStaging();
    await settle();
    const closing = test.runtime.closeSession({ discard: true });
    await settle();
    test.signIn(OTHER_ACCOUNT);
    test.runtime.startSession({ target: { type: "new" }, saveMode: "unsaved" });
    const ready = vi.fn();
    const selected = test.runtime.stageFiles(
      [fileOf(jpeg({}))],
      "picker",
      ready,
    );
    await settle();
    created();
    expect(await closing).toBe("ended");
    expect(test.runtime.store.get().staging?.identifying).toBe(1);
    expect(test.runtime.checkpoint()?.pendingFiles).toHaveLength(1);
    expect(ready).not.toHaveBeenCalled();
    resolveNew();
    await selected;
    expect(ready).toHaveBeenCalledOnce();
    expect(test.runtime.store.get().staging?.identifying).toBe(0);
    test.runtime.dispose();
  });

  it("keeps one manager per account and pauses the previous account on a switch", async () => {
    const test = setup();
    test.signIn(ACCOUNT);
    test.runtime.startSession({ target: { type: "new" }, saveMode: "unsaved" });
    await test.runtime.stageFiles([fileOf(jpeg({}))], "picker");
    expect(test.runtime.confirmStaging().ok).toBe(true);
    await settle();
    const managerA = test.runtime.manager()!;
    expect(managerA.getSnapshot().items).toHaveLength(1);
    expect(test.transfers[0]!.starts).toHaveLength(1);

    test.signIn(OTHER_ACCOUNT);
    const managerB = test.runtime.manager()!;
    expect(managerB).not.toBe(managerA);
    expect(managerB.getSnapshot().items).toHaveLength(0);
    expect(managerA.getSnapshot()).toMatchObject({
      status: "paused",
      pauseReason: "account",
    });
    expect(test.transfers[0]!.transfer.abort).toHaveBeenCalledOnce();
    expect(test.runtime.store.get()).toMatchObject({
      accountId: OTHER_ACCOUNT,
      session: null,
      staging: null,
    });

    // Back to A: interrupted work waits for the explicit Continue.
    test.signIn(ACCOUNT);
    expect(test.runtime.manager()).toBe(managerA);
    expect(managerA.getSnapshot().status).toBe("paused");
    test.signIn(null);
    expect(test.runtime.manager()).toBeNull();
  });

  it("creates the temporary session only when media needs a holder in no-save mode", async () => {
    const test = setup();
    test.signIn(ACCOUNT);
    test.runtime.startSession({ target: { type: "new" }, saveMode: "unsaved" });
    test.runtime.edit(content("只有文字"));
    expect(test.client.createSession).not.toHaveBeenCalled();
    expect(test.client.createDraft).not.toHaveBeenCalled();
    await test.runtime.stageFiles([fileOf(jpeg({}))], "picker");
    test.runtime.confirmStaging();
    await settle();
    expect(test.client.createSession).toHaveBeenCalledOnce();
    expect(test.uploads.client.registerItem.mock.calls[0]![0].holder).toEqual({
      sessionId: SESSION_ID,
    });
    expect(test.recovery.save).not.toHaveBeenCalled();
    await test.runtime.closeSession({ discard: true });
    expect(test.uploads.client.cancelItem).not.toHaveBeenCalled();
    expect(test.client.discardSession).toHaveBeenCalledWith(
      SESSION_ID,
      expect.anything(),
    );
  });

  it("r6 preserves an uncertain draft-create command across interruption and never sends newer text under its old identity", async () => {
    const first = setup();
    first.signIn(ACCOUNT);
    first.runtime.startSession({ target: { type: "new" }, saveMode: "saved" });
    first.runtime.edit(content("saved request"));
    first.client.createDraft.mockRejectedValueOnce(
      clientError(0, "lost response", true),
    );
    await first.runtime.saveNow();
    const command = first.client.createDraft.mock.calls[0]![0];
    first.runtime.edit(content("newer local text"));
    const snapshot = first.runtime.checkpoint()!;
    first.runtime.dispose();
    const next = setup();
    next.signIn(ACCOUNT);
    await next.runtime.restoreCheckpoint(snapshot);
    expect(next.client.createDraft).not.toHaveBeenCalled();
    await next.runtime.saveNow();
    expect(next.client.createDraft.mock.calls[0]![0]).toEqual(command);
    expect(next.runtime.autosave()!.hasUnsavedChanges()).toBe(true);
    await next.runtime.saveNow();
    expect(next.client.saveDraft.mock.calls[0]![1].content.title).toBe(
      "newer local text",
    );
  });

  it("r6 retries a definitive create refusal with the corrected content and a fresh identity", async () => {
    const test = setup();
    test.signIn(ACCOUNT);
    test.runtime.startSession({ target: { type: "new" }, saveMode: "saved" });
    test.runtime.edit(content("refused"));
    test.client.createDraft.mockRejectedValueOnce(
      clientError(409, "draft limit", false, "draft_limit"),
    );
    await test.runtime.saveNow();
    test.runtime.edit(content("corrected"));
    await test.runtime.saveNow();
    expect(test.client.createDraft.mock.calls[1]![0].content.title).toBe(
      "corrected",
    );
    expect(test.client.createDraft.mock.calls[1]![0].requestId).not.toBe(
      test.client.createDraft.mock.calls[0]![0].requestId,
    );
  });

  it("r6 replays only the newest interrupted replacement at its original album position", async () => {
    const test = setup();
    test.signIn(ACCOUNT);
    const previous: WorkDraftItem = {
      key: "missing",
      itemId: null,
      kind: "static",
      qualityMode: "standard",
      edit: { rotation: 90, crop: null },
    };
    const original = {
      ...content("replacement"),
      items: [previous],
      coverKey: previous.key,
    };
    test.runtime.startSession({
      target: { type: "new" },
      saveMode: "saved",
      content: original,
    });
    test.runtime.edit(original);
    const snapshot = test.runtime.checkpoint()!;
    test.runtime.dispose();
    const next = setup();
    next.signIn(ACCOUNT);
    const older = fileOf(jpeg({})),
      newer = fileOf(jpeg({}));
    await next.runtime.restoreCheckpoint({
      ...snapshot,
      pendingFiles: [
        {
          id: "old",
          files: [older],
          origin: "picker",
          original: false,
          replacement: { target: previous.key, previous },
        },
        {
          id: "new",
          files: [newer],
          origin: "picker",
          original: false,
          replacement: { target: previous.key, previous },
        },
      ],
    });
    const restored = next.runtime.checkpoint()!;
    expect(restored.content?.items).toHaveLength(1);
    expect(restored.content?.items[0]!.key).not.toBe(previous.key);
    expect(restored.content?.items[0]!.edit.rotation).toBe(90);
    expect(restored.content?.coverKey).toBe(restored.content?.items[0]!.key);
    expect(restored.uploads).toHaveLength(1);
    expect(restored.uploads[0]!.source?.still.file).toBe(newer);
    expect(next.client.createDraft).not.toHaveBeenCalled();
  });

  const receiveStill = async (test: ReturnType<typeof setup>, index = 0) => {
    const id = test.runtime.manager()!.getSnapshot().items[index]!.itemId!;
    test.transfers[0]!.starts[index]!.callbacks.onSettled({
      status: 200,
      responseText: test.uploads.receive(id, "still"),
      stalled: false,
    });
    await settle();
    expect(test.runtime.manager()!.getSnapshot().items[index]!.phase).toBe(
      "processing",
    );
  };

  it("says what keeps saveNow from saving the media: picks on their way, or ones that need the author", async () => {
    const test = setup();
    test.signIn(ACCOUNT);
    test.runtime.startSession({ target: { type: "new" }, saveMode: "saved" });
    expect(test.runtime.mediaSaveHold()).toBeNull();
    // A pick still being read holds the save back, with nothing counted yet.
    const reading = test.runtime.stageFiles(
      [fileOf(jpeg({})), fileOf(jpeg({ width: 6 }))],
      "picker",
    );
    expect(test.runtime.mediaSaveHold()).toEqual({
      received: 0,
      total: 0,
      reading: true,
      blocked: [],
    });
    await reading;
    test.runtime.confirmStaging();
    await settle();
    test.timers.fireAll();
    await settle();
    // Both uploading: on their way, nothing needs the author.
    expect(test.runtime.mediaSaveHold()).toEqual({
      received: 0,
      total: 2,
      reading: false,
      blocked: [],
    });
    await expect(test.runtime.saveNow()).rejects.toThrow("图片还未准备好");
    // One in (processing on the account is not waited for), one failed.
    await receiveStill(test, 0);
    const failed = test.runtime.manager()!.getSnapshot().items[1]!;
    test.transfers[0]!.starts[1]!.callbacks.onSettled({
      status: 0,
      responseText: "",
      stalled: true,
    });
    await settle();
    expect(test.runtime.mediaSaveHold()).toEqual({
      received: 1,
      total: 2,
      reading: false,
      blocked: [failed.key],
    });
    await expect(test.runtime.saveNow()).rejects.toThrow("图片还未准备好");
    expect(test.client.createDraft).not.toHaveBeenCalled();
  });

  it("r6 uploads under a temporary holder, then explicitly saves registered identities without cancelling them", async () => {
    const test = setup();
    test.signIn(ACCOUNT);
    test.runtime.startSession({ target: { type: "new" }, saveMode: "saved" });
    await test.runtime.stageFiles([fileOf(jpeg({}))], "picker");
    const confirmed = test.runtime.confirmStaging();
    await settle();
    test.timers.fireAll();
    await settle();
    expect(test.client.createDraft).not.toHaveBeenCalled();
    expect(test.uploads.client.registerItem.mock.calls[0]![0].holder).toEqual({
      sessionId: SESSION_ID,
    });
    await expect(test.runtime.saveNow()).rejects.toThrow("图片还未准备好");
    expect(test.client.createDraft).not.toHaveBeenCalled();
    await receiveStill(test);
    await test.runtime.saveNow();
    expect(test.client.createDraft).toHaveBeenCalledOnce();
    expect(test.client.createDraft.mock.calls[0]![0].content.items).toEqual([
      expect.objectContaining({
        key: confirmed.ok ? confirmed.confirmed[0]!.key : "",
        itemId: expect.stringMatching(/^media-item-/u),
      }),
    ]);
    expect(test.client.saveDraftNow).not.toHaveBeenCalled();
    await test.runtime.closeSession({ discard: true });
    // Session discard removes only unreferenced items; direct cancel would cancel draft media.
    expect(test.client.discardSession).toHaveBeenCalledOnce();
    expect(test.uploads.client.cancelItem).not.toHaveBeenCalled();
  });

  it("enforces the photo limit while refusing separate motion in Web r4", async () => {
    const test = setup();
    test.signIn(ACCOUNT);
    await settle();
    test.runtime.startSession({ target: { type: "new" }, saveMode: "unsaved" });
    await test.runtime.stageFiles(
      [
        fileOf(jpeg({ identifier: IDENTIFIER })),
        fileOf(motion({ identifier: IDENTIFIER })),
        fileOf(jpeg({})),
        fileOf(jpeg({})),
      ],
      "picker",
    );
    expect(test.runtime.store.get().staging?.count).toMatchObject({
      ready: 3,
      unsupported: 1,
      maxItems: 2,
      overBy: 1,
    });
    expect(test.runtime.confirmStaging()).toEqual({
      ok: false,
      error: "items_limit",
    });
    const last = test.runtime.store.get().staging!.batch.entries.at(-1)!;
    expect(test.runtime.removeStaged(last.key)).toBeNull();
    expect(test.runtime.confirmStaging().ok).toBe(true);
  });

  it("switches a saved draft to no-save only through the targeted deletion", async () => {
    const test = setup();
    test.signIn(ACCOUNT);
    test.runtime.startSession({
      target: { type: "draft", id: DRAFT_ID },
      saveMode: "saved",
      draft: draftOf(content("草稿")),
    });
    const result = await test.runtime.disableSaving();
    expect(test.client.deleteDraft).toHaveBeenCalledWith(
      DRAFT_ID,
      expect.anything(),
    );
    expect(result).toMatchObject({ deleted: true, snapshots: 2 });
    expect(test.recovery.clearDraft).toHaveBeenCalledWith(ACCOUNT, DRAFT_ID);
    expect(test.runtime.store.get().session).toMatchObject({
      saveMode: "unsaved",
      draftId: null,
    });
    expect(test.runtime.autosave()).toBeNull();
  });

  it("submits once with the session holder and the edit's base revision", async () => {
    const test = setup();
    test.signIn(ACCOUNT);
    test.runtime.startSession({ target: { type: "new" }, saveMode: "saved" });
    test.runtime.edit(content("题"));
    const state = await test.runtime.submit(content("题"));
    expect(state?.status).toBe("confirmed");
    expect(test.client.submit).toHaveBeenCalledOnce();
    expect(test.client.submit.mock.calls[0]![0]).toMatchObject({
      holder: { sessionId: SESSION_ID },
      baseRevisionId: null,
    });
  });

  it("keeps a session while anything would be lost on leaving, and ends it only when nothing would", async () => {
    const test = setup();
    test.signIn(ACCOUNT);
    test.runtime.startSession({ target: { type: "new" }, saveMode: "unsaved" });
    await test.runtime.stageFiles([fileOf(jpeg({}))], "picker");
    test.runtime.confirmStaging();
    await settle();
    expect(await test.runtime.closeSession({ discard: false })).toBe("kept");
    const manager = test.runtime.manager()!;
    // A paused upload is still unfinished work: the session and the progress entry stay.
    manager.pause("offline");
    expect(await test.runtime.closeSession({ discard: false })).toBe("kept");
    await manager.continueUploads();
    await settle();
    const itemId = manager.getSnapshot().items[0]!.itemId!;
    test.transfers[0]!.starts.at(-1)!.callbacks.onSettled({
      status: 200,
      responseText: test.uploads.receive(itemId, "still"),
      stalled: false,
    });
    await settle();
    test.uploads.makeReady(itemId);
    test.timers.fireAll();
    await settle();
    expect(manager.getSnapshot().items[0]!.phase).toBe("ready");
    // No-save content exists nowhere else: a plain leave keeps it.
    expect(await test.runtime.closeSession({ discard: false })).toBe("kept");
    expect(test.uploads.client.cancelItem).not.toHaveBeenCalled();
    expect(await test.runtime.closeSession({ discard: true })).toBe("ended");
    expect(test.runtime.store.get().session).toBeNull();
    expect(manager.getSnapshot().items).toEqual([]);
    expect(test.uploads.client.cancelItem).not.toHaveBeenCalled();
    expect(test.client.discardSession).toHaveBeenCalledOnce();

    // A saved-mode item that failed (nothing in flight) still needs the author.
    test.runtime.startSession({ target: { type: "new" }, saveMode: "saved" });
    const failing = test.runtime.manager()!;
    await test.runtime.stageFiles([fileOf(jpeg({}))], "picker");
    const preprocess = test.preprocessors.at(-1)!;
    preprocess.still.mockResolvedValueOnce({
      status: "failed",
      reason: "decode_failed",
    });
    test.runtime.confirmStaging();
    await settle();
    expect(failing.getSnapshot().items[0]!.phase).toBe("failed");
    expect(await test.runtime.closeSession({ discard: false })).toBe("kept");
    expect(await test.runtime.closeSession({ discard: true })).toBe("ended");

    // A saved draft that is saved and fully ready ends on leaving, without any account write.
    test.runtime.startSession({
      target: { type: "draft", id: DRAFT_ID },
      saveMode: "saved",
      draft: draftOf(content("已保存")),
    });
    expect(await test.runtime.closeSession({ discard: false })).toBe("ended");
    expect(test.client.deleteDraft).not.toHaveBeenCalled();
  });

  it("discards a temporary session that was still being created when the author discards", async () => {
    const test = setup();
    let created!: () => void;
    const create = test.client.createSession.getMockImplementation()!;
    test.client.createSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          created = () => resolve(create());
        }),
    );
    test.signIn(ACCOUNT);
    test.runtime.startSession({ target: { type: "new" }, saveMode: "unsaved" });
    await test.runtime.stageFiles([fileOf(jpeg({}))], "picker");
    test.runtime.confirmStaging();
    await settle();
    expect(test.client.createSession).toHaveBeenCalledOnce();
    const closing = test.runtime.closeSession({ discard: true });
    await settle();
    created();
    expect(await closing).toBe("ended");
    expect(test.client.discardSession).toHaveBeenCalledWith(
      SESSION_ID,
      expect.anything(),
    );
    expect(test.uploads.client.registerItem).not.toHaveBeenCalled();
  });

  it("never sends one account's pending draft save under another account", async () => {
    const test = setup();
    test.signIn(ACCOUNT);
    test.runtime.startSession({ target: { type: "new" }, saveMode: "saved" });
    test.runtime.edit(content("A 的草稿"));
    test.signIn(OTHER_ACCOUNT);
    test.timers.fireAll();
    await settle();
    expect(test.client.createDraft).not.toHaveBeenCalled();
    test.signIn(ACCOUNT);
    test.timers.fireAll();
    await settle();
    expect(test.client.createDraft).not.toHaveBeenCalled();
    await test.runtime.saveNow();
    expect(test.client.createDraft).toHaveBeenCalledOnce();
    expect(test.client.createDraft.mock.calls[0]![0].content.title).toBe(
      "A 的草稿",
    );
  });

  it("restarts the temporary session heartbeat when its account returns", async () => {
    const test = setup();
    test.signIn(ACCOUNT);
    test.runtime.startSession({ target: { type: "new" }, saveMode: "unsaved" });
    await test.runtime.stageFiles([fileOf(jpeg({}))], "picker");
    test.runtime.confirmStaging();
    await settle();
    const heartbeats = () =>
      [...test.timers.pending.values()].filter(
        (timer) => timer.ms === SESSION_HEARTBEAT_MS,
      ).length;
    expect(heartbeats()).toBe(1);
    test.signIn(OTHER_ACCOUNT);
    expect(heartbeats()).toBe(0);
    test.signIn(ACCOUNT);
    expect(heartbeats()).toBe(1);
  });

  it("deletes the draft a first save was still creating when saving is switched off", async () => {
    const test = setup();
    let finish!: () => void;
    test.client.createDraft.mockImplementationOnce(
      (cmd: { content: WorkDraftContent }) =>
        new Promise((resolve) => {
          finish = () => resolve(draftOf(cmd.content));
        }),
    );
    test.signIn(ACCOUNT);
    test.runtime.startSession({ target: { type: "new" }, saveMode: "saved" });
    test.runtime.edit(content("第一稿"));
    void test.runtime.saveNow();
    test.timers.fireAll();
    await settle();
    expect(test.client.createDraft).toHaveBeenCalledOnce();
    const switching = test.runtime.disableSaving();
    await settle();
    expect(test.client.deleteDraft).not.toHaveBeenCalled();
    finish();
    await switching;
    expect(test.client.deleteDraft).toHaveBeenCalledWith(
      DRAFT_ID,
      expect.anything(),
    );
    expect(test.runtime.store.get().session).toMatchObject({
      saveMode: "unsaved",
      draftId: null,
    });
    test.timers.fireAll();
    await settle();
    expect(test.client.saveDraft).not.toHaveBeenCalled();
  });

  it("saves registered item ids into the draft without the editor merging them", async () => {
    const test = setup();
    test.signIn(ACCOUNT);
    test.runtime.startSession({ target: { type: "new" }, saveMode: "saved" });
    test.runtime.edit(content("有图"));
    await test.runtime.stageFiles([fileOf(jpeg({}))], "picker");
    test.runtime.confirmStaging();
    await settle();
    const itemId = test.runtime.manager()!.getSnapshot().items[0]!.itemId!;
    expect(itemId).toMatch(/^media-item-/u);
    test.timers.fireAll();
    await settle();
    await receiveStill(test);
    await test.runtime.saveNow();
    const saved = test.client.createDraft.mock.calls.at(-1)![0].content;
    expect(saved.items).toEqual([expect.objectContaining({ itemId })]);
    expect(saved.items[0]).not.toHaveProperty("pendingLabel");
    // A later editor edit without the id keeps it.
    test.runtime.edit({
      ...content("有图，改标题"),
      items: [{ ...saved.items[0]!, itemId: null, pendingLabel: "photo" }],
    });
    test.timers.fireAll();
    await settle();
    await test.runtime.saveNow();
    expect(
      test.client.saveDraft.mock.calls.at(-1)![1].content.items[0],
    ).toEqual(expect.objectContaining({ itemId }));
  });

  it("completes the session on a confirmed submission: no later draft write, the receipt stays readable", async () => {
    const test = setup();
    test.signIn(ACCOUNT);
    test.runtime.startSession({ target: { type: "new" }, saveMode: "saved" });
    test.runtime.edit(content("题"));
    test.timers.fireAll();
    await settle();
    await test.runtime.saveNow();
    test.runtime.edit(content("题（改）"));
    const state = await test.runtime.submit(content("题（改）"));
    expect(state?.status).toBe("confirmed");
    expect(test.runtime.store.get().session).toBeNull();
    expect(test.runtime.submission()?.store.get().status).toBe("confirmed");
    const saves = test.client.saveDraft.mock.calls.length;
    test.timers.fireAll();
    await settle();
    expect(test.client.saveDraft).toHaveBeenCalledTimes(saves);
    expect(await test.runtime.closeSession({ discard: false })).toBe("none");
    expect(test.recovery.clearDraft).toHaveBeenCalledWith(ACCOUNT, DRAFT_ID);
  });

  it("shows a submit that failed before sending in the submission state", async () => {
    const test = setup();
    test.client.createSession.mockRejectedValueOnce(
      Object.assign(new Error("暂时无法创建上传会话"), {
        status: 503,
        code: "session_unavailable",
        outcomeUnknown: false,
      }),
    );
    test.signIn(ACCOUNT);
    test.runtime.startSession({ target: { type: "new" }, saveMode: "saved" });
    test.runtime.edit(content("题"));
    const state = await test.runtime.submit(content("题"));
    expect(state).toEqual({
      status: "failed",
      code: "session_unavailable",
      message: "暂时无法创建上传会话",
    });
    expect(test.runtime.submission()?.store.get()).toEqual(state);
    expect(test.client.submit).not.toHaveBeenCalled();
  });

  describe("adopting a chosen version", () => {
    const conflictOf = (
      device: WorkDraftContent,
      account: WorkDraftContent,
    ): PublishingDraftConflict => ({
      id: `work-draft-${"2".repeat(32)}`,
      device: {
        content: device,
        baseRevision: 1,
        deviceClass: "phone",
        savedAt: stamp,
      },
      account: {
        content: account,
        revision: 3,
        deviceClass: "desktop",
        updatedAt: stamp,
      },
      createdAt: stamp,
    });

    const conflicted = async (test: ReturnType<typeof setup>) => {
      test.signIn(ACCOUNT);
      await settle();
      test.runtime.startSession({
        target: { type: "draft", id: DRAFT_ID },
        saveMode: "saved",
        draft: draftOf(content("原稿")),
      });
      const conflict = conflictOf(content("本设备"), content("账号"));
      test.client.saveDraft.mockResolvedValueOnce({
        status: "conflict",
        draft: { ...draftOf(content("账号"), 3), conflict },
        conflict,
      } as never);
      test.runtime.edit(content("本设备"));
      await test.runtime.saveNow();
      test.timers.fireAll();
      await settle();
      expect(test.runtime.autosave()!.store.get()).toMatchObject({
        status: "conflict",
        revision: 3,
      });
      // Typing while the author chooses saves nothing.
      test.runtime.edit(content("本设备，还在输入"));
      test.timers.fireAll();
      await settle();
      expect(test.client.saveDraft).toHaveBeenCalledOnce();
    };

    it("leaves the conflict and saves the next edit on the chosen draft's revision", async () => {
      const test = setup();
      await conflicted(test);
      test.runtime.adoptDraft(draftOf(content("账号"), 4), content("账号"));
      expect(test.runtime.autosave()!.store.get()).toMatchObject({
        status: "saved",
        revision: 4,
        conflict: null,
      });
      expect(test.runtime.hasUnfinishedWork()).toBe(false);
      test.timers.fireAll();
      await settle();
      expect(test.client.saveDraft).toHaveBeenCalledOnce();

      test.runtime.edit(content("账号，继续编辑"));
      await test.runtime.saveNow();
      test.timers.fireAll();
      await settle();
      expect(test.client.saveDraft).toHaveBeenCalledTimes(2);
      expect(test.client.saveDraft.mock.calls[1]![0]).toBe(DRAFT_ID);
      expect(test.client.saveDraft.mock.calls[1]![1]).toMatchObject({
        baseRevision: 4,
        content: { title: "账号，继续编辑" },
      });
      expect(test.runtime.autosave()!.store.get()).toMatchObject({
        status: "saved",
        revision: 5,
      });
    });

    it("makes the chosen content the session content, so a later upload identity never brings back the input typed before the choice", async () => {
      const test = setup();
      await conflicted(test);
      // 账号中的新版本 chosen: the screen shows the account version now.
      test.runtime.adoptDraft(draftOf(content("账号"), 4), content("账号"));
      await test.runtime.stageFiles([fileOf(jpeg({}))], "picker");
      expect(test.runtime.confirmStaging().ok).toBe(true);
      await settle();
      test.timers.fireAll();
      await settle();
      await receiveStill(test);
      await test.runtime.saveNow();
      const saved = test.client.saveDraft.mock.calls.at(-1)![1];
      expect(saved.baseRevision).toBe(4);
      expect(saved.content.title).toBe("账号");
      expect(saved.content.items).toEqual([
        expect.objectContaining({
          itemId: expect.stringMatching(/^media-item-/u),
        }),
      ]);
      expect(test.runtime.autosave()!.store.get().status).toBe("saved");
    });

    it("saves newer screen input kept with 本设备版本 on the chosen revision", async () => {
      const test = setup();
      await conflicted(test);
      test.runtime.adoptDraft(
        draftOf(content("本设备"), 4),
        content("本设备，还在输入"),
      );
      expect(test.runtime.autosave()!.store.get()).toMatchObject({
        status: "pending",
        revision: 4,
      });
      test.timers.fireAll();
      await settle();
      await test.runtime.saveNow();
      expect(test.client.saveDraft.mock.calls.at(-1)![1]).toMatchObject({
        baseRevision: 4,
        content: { title: "本设备，还在输入" },
      });
      expect(test.runtime.autosave()!.store.get()).toMatchObject({
        status: "saved",
        revision: 5,
      });
    });
  });

  describe("items a version leaves out (V04)", () => {
    const itemOf = (
      entry: ReturnType<PublishingRuntime["draftItems"]>[number],
    ): WorkDraftItem => ({ ...entry, edit: { rotation: 0, crop: null } });

    it("never re-adds them, while items staged after the choice join the album", async () => {
      const test = setup();
      const register =
        test.uploads.client.registerItem.getMockImplementation()!;
      let releaseSecond!: () => void;
      test.uploads.client.registerItem
        .mockImplementationOnce(register)
        .mockImplementationOnce(
          (cmd: RegisterMediaItemCommand) =>
            new Promise<PublishingMediaItem>((resolve) => {
              releaseSecond = () => resolve(register(cmd));
            }),
        );
      test.signIn(ACCOUNT);
      await settle();
      test.runtime.startSession({ target: { type: "new" }, saveMode: "saved" });
      await test.runtime.stageFiles(
        [fileOf(jpeg({})), fileOf(jpeg({}))],
        "picker",
      );
      expect(test.runtime.confirmStaging().ok).toBe(true);
      await settle();
      const [kept, dropped] = test.runtime.draftItems();
      expect(dropped!.itemId).toBeNull();
      // The editor lists both, then the author restores a version with only the first.
      test.runtime.edit({
        ...content("两张"),
        items: test.runtime.draftItems().map(itemOf),
      });
      test.timers.fireAll();
      await settle();
      const version: WorkDraftContent = {
        ...content("只有一张"),
        items: [itemOf(kept!)],
        coverKey: kept!.key,
      };
      test.runtime.adoptDraft(draftOf(version, 5), version);
      expect(test.runtime.draftItems().map((item) => item.key)).toEqual([
        kept!.key,
      ]);
      const savesAtChoice = test.client.saveDraft.mock.calls.length;

      // The left-out item still gets its identity; nothing puts it back.
      releaseSecond();
      await settle();
      test.timers.fireAll();
      await settle();
      expect(
        test.runtime
          .manager()!
          .draftItems()
          .map((item) => item.key),
      ).toEqual([kept!.key, dropped!.key]);
      expect(test.runtime.draftItems().map((item) => item.key)).toEqual([
        kept!.key,
      ]);
      // Nothing changed in the album, so nothing is saved for that identity.
      expect(test.client.saveDraft).toHaveBeenCalledTimes(savesAtChoice);
      test.runtime.edit({ ...version, title: "只有一张，改题" });
      test.timers.fireAll();
      await settle();
      await receiveStill(test);
      await test.runtime.saveNow();
      const next = test.client.saveDraft.mock.calls.at(-1)![1];
      expect(next.baseRevision).toBe(5);
      expect(next.content.items.map((item) => item.key)).toEqual([kept!.key]);
      const submitted = await test.runtime.submit({
        ...version,
        title: "只有一张",
      });
      expect(submitted?.status).toBe("confirmed");
      const command = test.client.submit.mock.calls[0]![0] as unknown as {
        content: WorkDraftContent;
      };
      expect(command.content.items.map((item) => item.key)).toEqual([
        kept!.key,
      ]);
    });

    it("appends items staged after the choice (the album holds the chosen items plus the new ones)", async () => {
      const test = setup();
      test.signIn(ACCOUNT);
      await settle();
      test.runtime.startSession({ target: { type: "new" }, saveMode: "saved" });
      await test.runtime.stageFiles(
        [fileOf(jpeg({})), fileOf(jpeg({}))],
        "picker",
      );
      expect(test.runtime.confirmStaging().ok).toBe(true);
      await settle();
      const [kept] = test.runtime.draftItems();
      const version: WorkDraftContent = {
        ...content("只有一张"),
        items: [itemOf(kept!)],
      };
      test.runtime.adoptDraft(draftOf(version, 5), version);
      // One listed item plus one new one fits the limit of 2; the left-out item does not count.
      await test.runtime.stageFiles([fileOf(jpeg({}))], "picker");
      expect(test.runtime.store.get().staging?.count).toMatchObject({
        total: 2,
        withinLimit: true,
      });
      const added = test.runtime.confirmStaging();
      expect(added.ok).toBe(true);
      await settle();
      test.timers.fireAll();
      await settle();
      const newKey = added.ok ? added.confirmed[0]!.key : "";
      expect(test.runtime.draftItems().map((item) => item.key)).toEqual([
        kept!.key,
        newKey,
      ]);
      await receiveStill(test, 0);
      await receiveStill(test, 2);
      await test.runtime.saveNow();
      expect(
        test.client.saveDraft.mock.calls
          .at(-1)![1]
          .content.items.map((item) => item.key),
      ).toEqual([kept!.key, newKey]);
    });

    it("never keeps the session for them: a left-out item that failed does not block leaving or a new work", async () => {
      const test = setup();
      test.uploads.client.registerItem.mockRejectedValueOnce(
        clientError(422, "格式不支持", false, "unsupported_type"),
      );
      test.signIn(ACCOUNT);
      await settle();
      test.runtime.startSession({ target: { type: "new" }, saveMode: "saved" });
      await test.runtime.stageFiles([fileOf(jpeg({}))], "picker");
      expect(test.runtime.confirmStaging().ok).toBe(true);
      await settle();
      test.runtime.edit({
        ...content("有图"),
        items: test.runtime.draftItems().map(itemOf),
      });
      test.timers.fireAll();
      await settle();
      const manager = test.runtime.manager()!;
      expect(manager.getSnapshot().items.map((item) => item.phase)).toEqual([
        "failed",
      ]);
      // Listed, the failed item needs the author.
      expect(test.runtime.hasUnfinishedWork()).toBe(true);
      expect(
        test.runtime.albumUploads(manager.getSnapshot()).items,
      ).toHaveLength(1);

      const version = content("只有文字");
      test.runtime.adoptDraft(draftOf(version, 5), version);
      test.timers.fireAll();
      await settle();
      expect(test.runtime.draftItems()).toEqual([]);
      // Still tracked, but outside the album: nothing to lose, nothing to show.
      expect(manager.getSnapshot().items).toHaveLength(1);
      expect(test.runtime.albumUploads(manager.getSnapshot()).items).toEqual(
        [],
      );
      expect(test.runtime.hasUnfinishedWork()).toBe(false);
      expect(await test.runtime.closeSession({ discard: false })).toBe("ended");
      expect(
        test.runtime.startSession({
          target: { type: "new" },
          saveMode: "saved",
        }),
      ).toMatchObject({ target: { type: "new" }, draftId: null });
    });
  });

  it("does not re-add a confirmed item once the editor listed it and then left it out", async () => {
    const test = setup();
    test.signIn(ACCOUNT);
    await settle();
    test.runtime.startSession({ target: { type: "new" }, saveMode: "saved" });
    test.runtime.edit(content("有图"));
    await test.runtime.stageFiles([fileOf(jpeg({}))], "picker");
    expect(test.runtime.confirmStaging().ok).toBe(true);
    // Until the editor lists it, a stale edit keeps the confirmed item in the album.
    test.runtime.edit(content("有图，改题"));
    const [entry] = test.runtime.draftItems();
    expect(entry).toBeDefined();
    await settle();
    test.timers.fireAll();
    await settle();
    await receiveStill(test);
    await test.runtime.saveNow();
    expect(
      test.client.createDraft.mock.calls.at(-1)![0].content.items,
    ).toHaveLength(1);
    const listed = test.runtime.draftItems()[0]!;
    test.runtime.edit({
      ...content("有图，改题"),
      items: [{ ...listed, edit: { rotation: 0, crop: null } }],
    });
    test.runtime.edit(content("不要图了"));
    expect(test.runtime.draftItems()).toEqual([]);
    test.timers.fireAll();
    await settle();
    await test.runtime.saveNow();
    expect(test.client.saveDraft.mock.calls.at(-1)![1].content).toMatchObject({
      title: "不要图了",
      items: [],
    });
  });

  it("counts every item of the session content against the limit, including media the manager does not track", async () => {
    const test = setup();
    test.signIn(ACCOUNT);
    await settle();
    const legacy = (key: string, digit: string): WorkDraftItem => ({
      key,
      itemId: `media-item-${digit.repeat(32)}`,
      kind: "static",
      qualityMode: "legacy",
      edit: { rotation: 0, crop: null },
    });
    const workId = `work-${"9".repeat(32)}`;
    const edited: WorkDraftContent = {
      ...content("旧作"),
      items: [legacy("l1", "1"), legacy("l2", "2")],
    };
    test.runtime.startSession({
      target: { type: "work", id: workId },
      saveMode: "saved",
      draft: {
        ...draftOf(edited),
        kind: "edit",
        workId,
        baseRevisionId: `work-revision-${"8".repeat(32)}`,
      },
    });
    expect(test.runtime.manager()!.draftItems()).toEqual([]);
    await test.runtime.stageFiles([fileOf(jpeg({}))], "picker");
    expect(test.runtime.store.get().staging?.count).toMatchObject({
      ready: 1,
      total: 3,
      maxItems: 2,
      withinLimit: false,
      overBy: 1,
    });
    expect(test.runtime.confirmStaging()).toEqual({
      ok: false,
      error: "items_limit",
    });
    await settle();
    expect(test.uploads.client.registerItem).not.toHaveBeenCalled();
    // The author removes one of the work's items: the new one now fits.
    test.runtime.edit({ ...edited, items: [legacy("l1", "1")] });
    expect(test.runtime.store.get().staging?.count).toMatchObject({
      total: 2,
      withinLimit: true,
    });
    expect(test.runtime.confirmStaging().ok).toBe(true);
    await settle();
    // And the album is full again: no further item fits.
    await test.runtime.stageFiles([fileOf(jpeg({}))], "picker");
    expect(test.runtime.confirmStaging()).toEqual({
      ok: false,
      error: "items_limit",
    });
  });

  it("counts a no-save edit's existing items against the limit before its first edit (draft limit reached)", async () => {
    const test = setup();
    test.signIn(ACCOUNT);
    await settle();
    const workId = `work-${"9".repeat(32)}`;
    const existing = (key: string, digit: string): WorkDraftItem => ({
      key,
      itemId: `media-item-${digit.repeat(32)}`,
      kind: "static",
      qualityMode: "standard",
      edit: { rotation: 0, crop: null },
    });
    const work: WorkDraftContent = {
      ...content("已发布"),
      items: [existing("w1", "1"), existing("w2", "2")],
    };
    test.runtime.startSession({
      target: { type: "work", id: workId },
      saveMode: "unsaved",
      workId,
      baseRevisionId: `work-revision-${"8".repeat(32)}`,
      content: work,
    });
    // The work's content is not the author's own input: leaving loses nothing.
    expect(test.runtime.store.get().session).toMatchObject({
      saveMode: "unsaved",
      hasContent: false,
    });
    expect(test.runtime.hasUnfinishedWork()).toBe(false);
    await test.runtime.stageFiles(
      [fileOf(jpeg({})), fileOf(jpeg({}))],
      "picker",
    );
    expect(test.runtime.store.get().staging?.count).toMatchObject({
      ready: 2,
      total: 4,
      maxItems: 2,
      withinLimit: false,
      overBy: 2,
    });
    expect(test.runtime.confirmStaging()).toEqual({
      ok: false,
      error: "items_limit",
    });
    await settle();
    expect(test.uploads.client.registerItem).not.toHaveBeenCalled();
    expect(test.client.createSession).not.toHaveBeenCalled();
    // The author removes both of the work's items: the two new ones fit.
    test.runtime.edit({ ...work, items: [] });
    expect(test.runtime.store.get().staging?.count).toMatchObject({
      total: 2,
      withinLimit: true,
    });
    expect(test.runtime.confirmStaging().ok).toBe(true);
    await settle();
    expect(test.runtime.draftItems()).toHaveLength(2);
    expect(await test.runtime.closeSession({ discard: false })).toBe("kept");
  });

  it("keeps the clipboard origin in the draft content, its private provenance, and a restored draft", async () => {
    const test = setup();
    test.signIn(ACCOUNT);
    await settle();
    test.runtime.startSession({ target: { type: "new" }, saveMode: "saved" });
    await test.runtime.stageFiles([fileOf(jpeg({}))], "paste");
    await test.runtime.stageFiles([fileOf(jpeg({}))], "drop");
    const confirmed = test.runtime.confirmStaging();
    expect(confirmed.ok).toBe(true);
    await settle();
    const [pastedKey, droppedKey] = confirmed.ok
      ? confirmed.confirmed.map((entry) => entry.key)
      : [];
    await receiveStill(test, 0);
    await receiveStill(test, 1);
    await test.runtime.saveNow();
    const created = test.client.createDraft.mock.calls[0]![0].content;
    // The first save of a session the editor has not written to yet claims
    // no 作品性质 for the author (C05).
    expect(created.authorship).toBeNull();
    expect(
      created.items.map((item: WorkDraftItem) => [item.key, item.origin]),
    ).toEqual([
      [pastedKey, "clipboard"],
      [droppedKey, undefined],
    ]);
    expect(
      test.uploads.client.registerItem.mock.calls.map(
        ([command]) => command.metadata?.provenance.clientSource,
      ),
    ).toEqual(["clipboard", "drop"]);

    // An editor edit that does not carry the origin keeps it.
    test.runtime.edit({
      ...content("贴图"),
      items: test.runtime.draftItems().map((item) => {
        const withoutOrigin: WorkDraftItem = {
          ...item,
          edit: { rotation: 0, crop: null },
        };
        delete withoutOrigin.origin;
        return withoutOrigin;
      }),
    });
    test.timers.fireAll();
    await settle();
    await test.runtime.saveNow();
    const saved = test.client.saveDraft.mock.calls.at(-1)![1].content;
    expect(
      saved.items.map((item: WorkDraftItem) => [item.key, item.origin]),
    ).toEqual([
      [pastedKey, "clipboard"],
      [droppedKey, undefined],
    ]);

    // Reopened elsewhere (a new session on the saved draft): the label comes back from the content.
    // A saved draft is left as last saved; its media stays with the draft.
    expect(await test.runtime.closeSession({ discard: true })).toBe("ended");
    expect(test.uploads.client.cancelItem).not.toHaveBeenCalled();
    const reopened = { ...draftOf(saved, 3), mediaItems: [] };
    test.runtime.startSession({
      target: { type: "draft", id: DRAFT_ID },
      saveMode: "saved",
      draft: reopened,
    });
    await test.runtime.restoreDraftMedia(reopened);
    const restored = test.runtime.manager()!.getSnapshot().items;
    expect(restored.map((item) => [item.key, item.notCameraOriginal])).toEqual([
      [pastedKey, true],
      [droppedKey, false],
    ]);
    expect(test.runtime.draftItems()[0]).toMatchObject({
      key: pastedKey,
      origin: "clipboard",
    });
  });
});

describe("edit derivative readiness (D1)", () => {
  const turnedContent = (rotation: 0 | 90): WorkDraftContent => ({
    title: "",
    body: "",
    authorship: null,
    visibility: "public",
    items: [
      {
        key: "k1",
        itemId: `media-item-${"5".repeat(32)}`,
        kind: "static",
        qualityMode: "standard",
        edit: { rotation, crop: null },
      },
    ],
    coverKey: null,
    coverCrop: null,
  });

  it("asks the account after an edit settles, using the saved draft as holder, and polls a not_ready submission", async () => {
    const t = setup();
    t.signIn(ACCOUNT);
    await settle();
    t.runtime.startSession({
      target: { type: "draft", id: DRAFT_ID },
      saveMode: "saved",
      draft: draftOf(turnedContent(0)),
    });
    expect(t.runtime.editReadiness()?.get()).toEqual({
      status: "idle",
      answered: null,
    });
    // No edit needs derivatives: nothing is asked.
    t.timers.fireAll();
    await settle();
    expect(t.client.readiness).not.toHaveBeenCalled();

    t.client.readiness.mockResolvedValueOnce({
      ready: false,
      pendingItemKeys: ["k1"],
      failedItemKeys: [],
      editKeys: {},
    });
    t.runtime.edit(turnedContent(90));
    expect(t.runtime.editReadiness()?.get().status).toBe("idle");
    expect([...t.timers.pending.values()].map((timer) => timer.ms)).toContain(
      1000,
    );
    t.timers.fireAll();
    await settle();
    expect(t.client.readiness).toHaveBeenCalledTimes(1);
    expect(t.client.readiness.mock.calls[0]![0]).toEqual({ draftId: DRAFT_ID });
    expect(t.runtime.editReadiness()?.get()).toMatchObject({
      status: "not_ready",
      answered: { pendingItemKeys: new Set(["k1"]) },
    });
    t.client.readiness.mockResolvedValueOnce({
      ready: true,
      pendingItemKeys: [],
      failedItemKeys: [],
      editKeys: { k1: "d".repeat(32) },
    });
    t.timers.fireAll();
    await settle();
    expect(t.runtime.editReadiness()?.get()).toMatchObject({
      status: "ready",
      answered: { editKeys: { k1: "d".repeat(32) } },
    });

    // A refused submission marks its keys pending and asks again.
    t.client.submit.mockResolvedValueOnce({
      state: "not_ready" as const,
      itemKeys: ["k1"],
    });
    const result = await t.runtime.submit(turnedContent(90));
    expect(result?.status).toBe("not_ready");
    expect(t.runtime.editReadiness()?.get()).toMatchObject({
      status: "not_ready",
      answered: { ready: false, pendingItemKeys: new Set(["k1"]) },
    });
    t.client.readiness.mockResolvedValueOnce({
      ready: true,
      pendingItemKeys: [],
      failedItemKeys: [],
      editKeys: { k1: "d".repeat(32) },
    });
    t.timers.fireAll();
    await settle();
    expect(t.client.readiness).toHaveBeenCalledTimes(3);
    expect(t.runtime.editReadiness()?.get().status).toBe("ready");

    // Leaving the session ends the tracking.
    await t.runtime.closeSession({ discard: true });
    expect(t.runtime.editReadiness()).toBeNull();
  });
});
