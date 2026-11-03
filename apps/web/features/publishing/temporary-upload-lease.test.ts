import { describe, expect, it, vi } from "vitest";
import type {
  PublishingMediaItem,
  PublishingSession,
  RegisterMediaItemCommand,
} from "@moya/contracts";
import { createTemporaryUploadLease } from "./temporary-upload-lease";

const session: PublishingSession = {
  id: `publishing-session-${"1".repeat(32)}`,
  state: "active",
  workId: null,
  createdAt: "2026-11-02T00:00:00.000Z",
  leaseExpiresAt: "2026-11-03T00:00:00.000Z",
};
const media = (digit: string): PublishingMediaItem => ({
  id: `media-item-${digit.repeat(32)}`,
  kind: "static",
  qualityMode: "original",
  state: "ready",
  failureCode: null,
  components: [],
  presentation: { width: 100, height: 200 },
  media: { thumbSrc: "/synthetic/thumb", displaySrc: "/synthetic/display" },
});
const command = (digit: string): RegisterMediaItemCommand => ({
  requestId: `00000000-0000-4000-8000-${digit.repeat(12)}`,
  holder: { sessionId: session.id },
  purpose: "comment",
  kind: "static",
  qualityMode: "original",
  components: [{ role: "still", contentType: "image/png", byteSize: 10 }],
});
const setup = () => {
  type Client = Parameters<typeof createTemporaryUploadLease>[0]["client"];
  const client = {
    createSession: vi.fn<Client["createSession"]>(async () => session),
    heartbeatSession: vi.fn<Client["heartbeatSession"]>(async () => session),
    discardSession: vi.fn<Client["discardSession"]>(async () => ({
      discarded: true as const,
    })),
    registerItem: vi.fn<Client["registerItem"]>(async () => media("2")),
  };
  const lease = createTemporaryUploadLease({
    client,
    signal: new AbortController().signal,
    requireAccount: () => {},
    requestId: () => crypto.randomUUID(),
    onSession: () => {},
  });
  return { client, lease };
};

describe("temporary upload lease explicit removed registrations", () => {
  it("retires removed known A plus durably committed B without weakening the default", async () => {
    const { client, lease } = setup();
    const a = media("2"),
      b = media("3");
    client.registerItem.mockResolvedValueOnce(a).mockResolvedValueOnce(b);
    await lease.register(command("1"));
    await lease.register(command("2"));
    expect(await lease.retireCommitted(new Set([b.id]), () => true)).toBe(
      false,
    );
    expect(client.discardSession).not.toHaveBeenCalled();
    expect(
      await lease.retireCommitted(new Set([b.id]), () => true, new Set([a.id])),
    ).toBe(true);
    expect(client.discardSession).toHaveBeenCalledOnce();
    expect(client.discardSession.mock.calls[0]?.[0]).toBe(session.id);
  });

  it("keeps a lost registration response protected even if an alleged removed id is supplied", async () => {
    const { client, lease } = setup();
    const unknown = media("2"),
      b = media("3");
    client.registerItem
      .mockRejectedValueOnce(new Error("synthetic lost registration response"))
      .mockResolvedValueOnce(b);
    await expect(lease.register(command("1"))).rejects.toThrow(
      "lost registration",
    );
    await lease.register(command("2"));
    expect(
      await lease.retireCommitted(
        new Set([b.id]),
        () => true,
        new Set([unknown.id]),
      ),
    ).toBe(false);
    expect(client.discardSession).not.toHaveBeenCalled();
  });
});
