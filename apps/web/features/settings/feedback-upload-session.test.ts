import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  UploadManagerOptions,
  UploadManagerSnapshot,
} from "../publishing/upload-manager";
import type {
  PublishingMediaItem,
  PublishingSession,
  RegisterMediaItemCommand,
} from "@moya/contracts";

const fixture = vi.hoisted(() => ({
  account: "user-00000000000000000000000000000001",
  epoch: 0,
  options: null as unknown,
  identify: vi.fn(),
  createSession: vi.fn(),
  discardSession: vi.fn(),
  heartbeatSession: vi.fn(),
  registerItem: vi.fn(),
  addConfirmed: vi.fn(),
  release: vi.fn(),
  dispose: vi.fn(),
  connectionResume: vi.fn(),
}));
vi.mock("../../lib/public-api/feedback-client", () => ({
  feedbackImageLimits: { maxImages: 3, maxBytes: 10 * 1024 * 1024 },
}));
vi.mock("../authors/author-data", () => ({
  authorClient: {
    account: () => fixture.account,
    accountEpoch: () => fixture.epoch,
  },
}));
vi.mock("../../lib/public-api/work-publishing-client", () => ({
  publishingClient: {
    createSession: fixture.createSession,
    discardSession: fixture.discardSession,
    heartbeatSession: fixture.heartbeatSession,
    registerItem: fixture.registerItem,
  },
}));
vi.mock("../publishing/import-grouping", () => ({
  identifyFile: fixture.identify,
}));
vi.mock("../publishing/hashing", () => ({ createBlobHasher: () => ({}) }));
vi.mock("../publishing/preprocess/worker-client", () => ({
  createWorkerPreprocess: () => ({}),
}));
vi.mock("../publishing/uppy-transfer", () => ({
  createUppyTransfer: () => ({}),
}));
vi.mock("../publishing/upload-manager", () => ({
  canRetryProcessing: () => true,
  UploadManager: class {
    state: UploadManagerSnapshot = {
      accountId: fixture.account,
      status: "active",
      pauseReason: null,
      items: [],
    };
    store = { subscribe: () => () => undefined, get: () => this.state };
    constructor(options: unknown) {
      fixture.options = options;
    }
    bindSession() {}
    setPolling() {}
    getSnapshot() {
      return this.state;
    }
    localStill() {
      return null;
    }
    addConfirmed = fixture.addConfirmed;
    pause(reason: "account" | "offline") {
      this.state = { ...this.state, status: "paused", pauseReason: reason };
    }
    async continueUploads() {
      fixture.connectionResume();
      this.state = { ...this.state, status: "active", pauseReason: null };
    }
    release = fixture.release;
    dispose = fixture.dispose;
    async cancelItem() {}
    forget() {}
    retryRegistration() {}
    async retryProcessing() {}
    async retryComponent() {}
  },
}));
import { createFeedbackUploadSession } from "./feedback-upload-session";

const account = "user-00000000000000000000000000000001";
const temporary: PublishingSession = {
  id: `publishing-session-${"1".repeat(32)}`,
  state: "active",
  workId: null,
  createdAt: "2026-10-24T00:00:00.000Z",
  leaseExpiresAt: "2026-10-25T00:00:00.000Z",
};
const ready: PublishingMediaItem = {
  id: `media-item-${"2".repeat(32)}`,
  kind: "static",
  qualityMode: "standard",
  state: "ready",
  failureCode: null,
  components: [],
  presentation: { width: 100, height: 200 },
  media: { thumbSrc: "/synthetic/thumb", displaySrc: "/synthetic/display" },
};
let sessions: ReturnType<typeof createFeedbackUploadSession>[] = [];
const start = () => {
  const session = createFeedbackUploadSession(account);
  sessions.push(session);
  return session;
};
const options = () => fixture.options as UploadManagerOptions;
const file = (type = "image/png") =>
  new File(["synthetic image"], "screenshot", { type });
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-24T00:00:00.000Z"));
  fixture.account = account;
  fixture.epoch = 0;
  vi.stubGlobal("navigator", { userAgent: "Synthetic Desktop" });
  vi.stubGlobal("window", { innerWidth: 1280 });
  fixture.createSession.mockResolvedValue(temporary);
  fixture.discardSession.mockResolvedValue({ discarded: true });
  fixture.heartbeatSession.mockResolvedValue(temporary);
  fixture.registerItem.mockResolvedValue(ready);
  fixture.identify.mockImplementation(async (selected: File) => ({
    kind: "still",
    file: selected,
    type: selected.type,
    orientation: null,
    contentIdentifier: null,
    appleMakerNote: false,
    motionPhoto: null,
    motionPhotoInvalid: false,
  }));
});
afterEach(async () => {
  await Promise.all(sessions.map((session) => session.abandon()));
  sessions = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("feedback upload session", () => {
  it("renews at half the actual short lease rather than waiting ten minutes", async () => {
    const upload = start();
    fixture.createSession.mockResolvedValueOnce({
      ...temporary,
      leaseExpiresAt: "2026-10-24T00:01:00.000Z",
    });
    fixture.heartbeatSession.mockResolvedValue({
      ...temporary,
      leaseExpiresAt: "2026-10-24T00:02:00.000Z",
    });
    const command: RegisterMediaItemCommand = {
      requestId: "00000000-0000-4000-8000-000000000001",
      holder: { sessionId: temporary.id },
      kind: "static",
      qualityMode: "original",
      components: [{ role: "still", byteSize: 15, contentType: "image/png" }],
    };
    await options().client.registerItem(command);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fixture.heartbeatSession).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.heartbeatSession).toHaveBeenCalledOnce();
    await upload.abandon();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fixture.heartbeatSession).toHaveBeenCalledOnce();
  });

  it("renews the same holder after a heartbeat failure without replacing ready image ids or upload intents", async () => {
    const upload = start();
    fixture.createSession.mockResolvedValueOnce({
      ...temporary,
      leaseExpiresAt: "2026-10-24T00:01:00.000Z",
    });
    const command: RegisterMediaItemCommand = {
      requestId: "00000000-0000-4000-8000-000000000001",
      holder: { sessionId: temporary.id },
      kind: "static",
      qualityMode: "original",
      components: [{ role: "still", byteSize: 15, contentType: "image/png" }],
    };
    await options().client.registerItem(command);
    const manager = upload.manager as unknown as {
      state: UploadManagerSnapshot;
    };
    manager.state = {
      ...manager.state,
      items: [
        {
          key: "screenshot",
          kind: "static",
          qualityMode: "standard",
          notCameraOriginal: false,
          phase: "ready",
          itemId: ready.id,
          components: [],
          failure: null,
          choice: null,
          recoverable: false,
          serverItem: ready,
        },
      ],
    };
    fixture.heartbeatSession.mockRejectedValueOnce(
      new Error("synthetic network failure"),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(upload.snapshot().status).toBe("paused");
    expect(upload.snapshot().items[0]?.phase).toBe("ready");
    fixture.heartbeatSession.mockRejectedValueOnce(
      new Error("synthetic retry failure"),
    );
    await expect(upload.resumeConnection()).rejects.toThrow(
      "图片连接暂时无法恢复",
    );
    expect(upload.snapshot().items[0]?.itemId).toBe(ready.id);
    fixture.heartbeatSession.mockResolvedValueOnce({
      ...temporary,
      leaseExpiresAt: "2026-10-24T00:02:00.000Z",
    });
    await Promise.all([upload.resumeConnection(), upload.resumeConnection()]);
    expect(upload.snapshot().status).toBe("active");
    expect(upload.snapshot().items[0]?.itemId).toBe(ready.id);
    expect(fixture.connectionResume).toHaveBeenCalledOnce();
    expect(fixture.heartbeatSession).toHaveBeenCalledTimes(3);
    expect(
      fixture.heartbeatSession.mock.calls.every(
        (call) => call[0] === temporary.id,
      ),
    ).toBe(true);
    expect(fixture.createSession).toHaveBeenCalledOnce();
    expect(fixture.registerItem).toHaveBeenCalledOnce();
    expect(fixture.addConfirmed).not.toHaveBeenCalled();
  });

  it("registers feedback-purpose items under a temporary session without Work creation or metadata extraction", async () => {
    const upload = start();
    expect(fixture.createSession).not.toHaveBeenCalled();
    const command: RegisterMediaItemCommand = {
      requestId: "00000000-0000-4000-8000-000000000001",
      holder: { sessionId: temporary.id },
      kind: "static",
      qualityMode: "original",
      components: [{ role: "still", byteSize: 15, contentType: "image/png" }],
    };
    await options().client.registerItem(command);
    expect(fixture.createSession).toHaveBeenCalledWith(
      { requestId: expect.any(String), workId: null },
      expect.any(AbortSignal),
    );
    expect(fixture.registerItem.mock.calls[0]?.[0]).toMatchObject({
      purpose: "feedback",
      holder: { sessionId: temporary.id },
    });
    expect(options().recovery).toBeNull();
    expect(
      await options().metadata!(file(), {
        appleMakerNote: false,
        livePhotoIdentifier: false,
        exifOrientation: null,
      }),
    ).toEqual({
      provenance: {
        source: "client",
        parser: "feedback-image-v1",
        status: "absent",
      },
      values: {},
    });
    await upload.committed();
    expect(fixture.discardSession).toHaveBeenCalledOnce();
  });
  it("checks count, bytes and actual identified still type before queueing", async () => {
    const upload = start();
    await expect(upload.add([file(), file(), file(), file()])).rejects.toThrow(
      "最多添加 3",
    );
    await expect(
      upload.add([
        new File([new Uint8Array(10 * 1024 * 1024 + 1)], "large.png"),
      ]),
    ).rejects.toThrow("10 MB");
    fixture.identify.mockResolvedValueOnce({
      kind: "unsupported",
      reason: "animated_image",
    });
    await expect(upload.add([file("image/gif")])).rejects.toThrow("静态图片");
    expect(fixture.addConfirmed).not.toHaveBeenCalled();
    expect(fixture.createSession).not.toHaveBeenCalled();
    await upload.add([file("image/png"), file("image/heic")]);
    expect(fixture.addConfirmed.mock.calls[0]?.[0]).toMatchObject([
      { qualityMode: "standard", source: { kind: "static" } },
      { qualityMode: "original", source: { kind: "static" } },
    ]);
  });
  it("fences a slow file read when the account changes and releases the abandoned manager", async () => {
    const upload = start();
    let resolve!: (value: unknown) => void;
    fixture.identify.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const adding = upload.add([file()]);
    fixture.account = "user-00000000000000000000000000000002";
    fixture.epoch++;
    resolve({ kind: "still", file: file(), type: "image/png" });
    await expect(adding).rejects.toThrow("account_changed");
    expect(fixture.addConfirmed).not.toHaveBeenCalled();
    await upload.abandon();
    expect(fixture.release).toHaveBeenCalledOnce();
    expect(fixture.dispose).toHaveBeenCalledOnce();
  });
});
