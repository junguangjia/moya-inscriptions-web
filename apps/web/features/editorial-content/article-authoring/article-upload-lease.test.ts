import { getEventListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PublishingMediaItem,
  PublishingSession,
  RegisterMediaItemCommand,
} from "@moya/contracts";
import { createArticleUploadLease } from "./article-upload-lease";

const deferred = <Value>() => {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const session = (value: string): PublishingSession => ({
  id: `session-${value.repeat(32)}` as PublishingSession["id"],
  state: "active",
  workId: null,
  createdAt: "2026-09-30T00:00:00.000Z",
  leaseExpiresAt: "2026-09-30T01:00:00.000Z",
});
const ready: PublishingMediaItem = {
  id: `media-item-${"3".repeat(32)}`,
  kind: "static",
  qualityMode: "original",
  state: "ready",
  failureCode: null,
  components: [
    {
      id: `media-component-${"4".repeat(32)}`,
      role: "still",
      state: "verified",
      byteSize: 4,
      receivedBytes: 4,
    },
  ],
  presentation: { width: 4, height: 3 },
  media: { thumbSrc: "/synthetic/thumb", displaySrc: "/synthetic/display" },
};
const command = (
  id: string,
  holder: RegisterMediaItemCommand["holder"],
): RegisterMediaItemCommand => ({
  requestId: id,
  holder,
  kind: "static",
  qualityMode: "original",
  components: [{ role: "still", byteSize: 4, contentType: "image/jpeg" }],
});
const setup = () => {
  type Client = Parameters<typeof createArticleUploadLease>[0]["client"];
  let sequence = 0;
  const a = session("1"),
    b = session("2");
  const client = {
    createSession: vi.fn<Client["createSession"]>(async () =>
      sequence++ === 0 ? a : b,
    ),
    discardSession: vi.fn<Client["discardSession"]>(async () => ({
      discarded: true,
    })),
    heartbeatSession: vi.fn<Client["heartbeatSession"]>(async () => a),
    registerItem: vi.fn<Client["registerItem"]>(async () => ready),
  };
  const lease = createArticleUploadLease({
    client,
    signal: new AbortController().signal,
    requireAccount: () => undefined,
    requestId: () => crypto.randomUUID(),
    onSession: vi.fn(),
  });
  return { a, b, client, lease };
};

describe("Article temporary upload lease", () => {
  it("holds the next registration until delayed discard completes and binds its fresh session", async () => {
    const { b, client, lease } = setup();
    const oldHolder = await lease.holder();
    const discarded = deferred<{ discarded: true }>();
    client.discardSession.mockReturnValueOnce(discarded.promise);
    const cleanup = lease.retireCommitted(new Set(), () => true);
    await vi.waitFor(() =>
      expect(client.discardSession).toHaveBeenCalledOnce(),
    );
    const upload = lease.register(command("next-upload", oldHolder));
    await Promise.resolve();
    expect(client.registerItem).not.toHaveBeenCalled();
    expect(client.createSession).toHaveBeenCalledOnce();
    discarded.resolve({ discarded: true });
    expect(await cleanup).toBe(true);
    await upload;
    expect(client.registerItem.mock.calls[0]?.[0].holder).toEqual({
      sessionId: b.id,
    });
  });
  it("reconciles an unknown discard using the same receipt before any next upload", async () => {
    const { a, b, client, lease } = setup();
    const holder = await lease.holder();
    client.discardSession.mockRejectedValueOnce(
      new Error("lost-discard-response"),
    );
    await expect(lease.retireCommitted(new Set(), () => true)).rejects.toThrow(
      "lost-discard-response",
    );
    const unknown = client.discardSession.mock.calls[0];
    await lease.register(command("next-upload", holder));
    expect(client.discardSession.mock.calls[1]?.[0]).toBe(a.id);
    expect(client.discardSession.mock.calls[1]?.[1]).toEqual(unknown?.[1]);
    expect(client.registerItem.mock.calls[0]?.[0].holder).toEqual({
      sessionId: b.id,
    });
  });
  it("retains an unknown registration's exact body and protects its temporary asset from cleanup", async () => {
    const { client, lease } = setup();
    const holder = await lease.holder();
    const intent = command("same-upload", holder);
    client.registerItem.mockRejectedValueOnce(
      new Error("lost-register-response"),
    );
    await expect(lease.register(intent)).rejects.toThrow(
      "lost-register-response",
    );
    expect(await lease.retireCommitted(new Set(), () => true)).toBe(false);
    expect(client.discardSession).not.toHaveBeenCalled();
    await lease.register(intent);
    expect(client.registerItem.mock.calls[1]?.[0]).toEqual(
      client.registerItem.mock.calls[0]?.[0],
    );
    expect(await lease.retireCommitted(new Set([ready.id]), () => true)).toBe(
      true,
    );
  });
  it("refuses retirement when a registration queued during a content write is absent from that committed document", async () => {
    const { client, lease } = setup();
    const holder = await lease.holder();
    const registered = deferred<PublishingMediaItem>();
    client.registerItem.mockReturnValueOnce(registered.promise);
    const upload = lease.register(command("concurrent-upload", holder));
    await vi.waitFor(() => expect(client.registerItem).toHaveBeenCalledOnce());
    const cleanup = lease.retireCommitted(new Set(), () => true);
    registered.resolve(ready);
    await upload;
    expect(await cleanup).toBe(false);
    expect(client.discardSession).not.toHaveBeenCalled();
  });
});

describe("Article temporary upload lease without AbortSignal.any", () => {
  // Chromium 111-115 and Safari 16.4-17.3 lack it (docs/development/browser-support.md).
  beforeEach(() => {
    vi.spyOn(AbortSignal, "any").mockImplementation(() => {
      throw new TypeError("AbortSignal.any is not a function");
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers with both its own and the lease signal and releases them afterwards", async () => {
    type Client = Parameters<typeof createArticleUploadLease>[0]["client"];
    const leaseController = new AbortController();
    const received: AbortSignal[] = [];
    const pending = [
      deferred<PublishingMediaItem>(),
      deferred<PublishingMediaItem>(),
    ];
    const client = {
      createSession: vi.fn<Client["createSession"]>(async () => session("1")),
      discardSession: vi.fn<Client["discardSession"]>(async () => ({
        discarded: true,
      })),
      heartbeatSession: vi.fn<Client["heartbeatSession"]>(async () =>
        session("1"),
      ),
      registerItem: vi.fn<Client["registerItem"]>(async (_command, signal) => {
        received.push(signal!);
        return received.length === 1
          ? ready
          : pending[received.length - 2]!.promise;
      }),
    };
    const lease = createArticleUploadLease({
      client,
      signal: leaseController.signal,
      requireAccount: () => undefined,
      requestId: () => crypto.randomUUID(),
      onSession: vi.fn(),
    });
    const holder = await lease.holder();
    const own = new AbortController();
    await expect(
      lease.register(command("first-upload", holder), own.signal),
    ).resolves.toEqual(ready);
    expect(received[0]!.aborted).toBe(false);
    expect(getEventListeners(own.signal, "abort")).toHaveLength(0);
    expect(getEventListeners(leaseController.signal, "abort")).toHaveLength(0);

    // A registration's own abort reaches its request ...
    const own2 = new AbortController();
    const second = lease.register(
      command("second-upload", holder),
      own2.signal,
    );
    await vi.waitFor(() => expect(received).toHaveLength(2));
    const departed = new Error("upload removed");
    own2.abort(departed);
    expect(received[1]!.reason).toBe(departed);
    pending[0]!.reject(departed);
    await expect(second).rejects.toBe(departed);
    expect(leaseController.signal.aborted).toBe(false);
    expect(getEventListeners(leaseController.signal, "abort")).toHaveLength(0);

    // ... and so does the lease's.
    const third = lease.register(
      command("third-upload", holder),
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(received).toHaveLength(3));
    const closed = new Error("lease closed");
    leaseController.abort(closed);
    expect(received[2]!.reason).toBe(closed);
    pending[1]!.reject(closed);
    await expect(third).rejects.toBe(closed);
  });
});
