import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "node:http";
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("node:https", () => ({ request: mocks.request }));
import {
  sendProviderRequest,
  PROVIDER_TIMEOUT_MS,
} from "@moya/backend-production/internal/auth-transport";

const input = {
  url: "https://ses.tencentcloudapi.com/",
  method: "POST" as const,
  headers: { host: "ses.tencentcloudapi.com" },
  body: "{}",
};
let outgoing: EventEmitter & {
  end: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
};
let incoming: EventEmitter & {
  statusCode: number;
  headers: Record<string, string>;
  destroy: ReturnType<typeof vi.fn>;
};
beforeEach(() => {
  outgoing = Object.assign(new EventEmitter(), {
    end: vi.fn(),
    destroy: vi.fn(),
  });
  incoming = Object.assign(new EventEmitter(), {
    statusCode: 200,
    headers: {},
    destroy: vi.fn(),
  });
  mocks.request
    .mockReset()
    .mockImplementation(
      (_url, _options, callback: (response: IncomingMessage) => void) => {
        outgoing.end.mockImplementation(() =>
          queueMicrotask(() =>
            callback(incoming as unknown as IncomingMessage),
          ),
        );
        return outgoing;
      },
    );
});
afterEach(() => {
  vi.useRealTimers();
});

describe("bounded real provider HTTPS transport", () => {
  it("uses verified HTTPS and exactly one request", async () => {
    const pending = sendProviderRequest(input);
    await Promise.resolve();
    incoming.emit("data", Buffer.from('{"ok":true}'));
    incoming.emit("end");
    expect((await pending).status).toBe(200);
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.request.mock.calls[0]?.[1]?.rejectUnauthorized).toBe(true);
  });
  it("rejects destination changes before a network call", async () => {
    for (const url of [
      "http://ses.tencentcloudapi.com/",
      "https://example.invalid/",
      "https://ses.tencentcloudapi.com/path",
      "https://ses.tencentcloudapi.com/?query=value",
    ]) {
      await expect(
        sendProviderRequest({ ...input, url }),
      ).rejects.toMatchObject({ outcome: "failed" });
    }
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("does not follow a redirect or accept an oversized declared response", async () => {
    for (const scenario of [
      { status: 302, headers: { location: "https://example.invalid/" } },
      { status: 200, headers: { "content-length": "65537" } },
    ]) {
      incoming.statusCode = scenario.status;
      incoming.headers = scenario.headers;
      await expect(sendProviderRequest(input)).rejects.toMatchObject({
        outcome: "failed",
      });
    }
    expect(mocks.request).toHaveBeenCalledTimes(2);
  });
  it("bounds a streamed response independently of Content-Length", async () => {
    const pending = sendProviderRequest(input);
    const checked = expect(pending).rejects.toMatchObject({
      outcome: "failed",
    });
    await Promise.resolve();
    incoming.emit("data", Buffer.alloc(65537));
    await checked;
    expect(incoming.destroy).toHaveBeenCalledOnce();
  });
  it("classifies the total deadline and interrupted response as unknown without retry", async () => {
    vi.useFakeTimers();
    outgoing.end.mockImplementation(() => undefined);
    const pending = sendProviderRequest(input);
    const checked = expect(pending).rejects.toMatchObject({
      outcome: "unknown",
    });
    await vi.advanceTimersByTimeAsync(PROVIDER_TIMEOUT_MS);
    await checked;
    expect(outgoing.destroy).toHaveBeenCalledOnce();
    expect(mocks.request).toHaveBeenCalledOnce();
  });
});
