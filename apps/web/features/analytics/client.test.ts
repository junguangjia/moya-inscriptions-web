// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalyticsBatch } from "@moya/contracts/analytics";
import { createAnalyticsRuntime } from "./runtime";
import {
  createAnalyticsClientHintsReader,
  startAnalytics,
  stopAnalytics,
} from "./client";

const { send } = vi.hoisted(() => ({
  send: vi.fn<
    (batch: AnalyticsBatch) => Promise<{ accepted: number; excluded: boolean }>
  >(async () => ({ accepted: 1, excluded: false })),
}));
vi.mock("../../lib/public-api/analytics-client", () => ({
  sendAnalyticsBatch: send,
  beaconAnalyticsBatch: () => true,
}));

const originalWindow = window;
const id = "11111111-1111-4111-8111-111111111111";
beforeEach(() => {
  send.mockClear();
  originalWindow.localStorage.clear();
  originalWindow.sessionStorage.clear();
  vi.stubEnv("NODE_ENV", "production");
  vi.stubGlobal("window", {
    localStorage: originalWindow.localStorage,
    sessionStorage: originalWindow.sessionStorage,
    location: { pathname: "/", hostname: "product.example.test" },
  });
});
afterEach(() => {
  stopAnalytics();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("optional device hints", () => {
  it("delivers the first pageview before detailed hints settle and adds them to a later ordinary flush", async () => {
    let resolve!: (value: unknown) => void;
    const high = vi.fn(
      () => new Promise<unknown>((complete) => (resolve = complete)),
    );
    const read = createAnalyticsClientHintsReader({
      userAgentData: {
        brands: [{ brand: "Chromium", version: "130" }],
        platform: "Android",
        mobile: true,
        getHighEntropyValues: high,
      },
    });
    const deliver = vi.fn<
      (
        batch: AnalyticsBatch,
      ) => Promise<{ accepted: number; excluded: boolean }>
    >(async () => ({ accepted: 1, excluded: false }));
    const runtime = createAnalyticsRuntime({
      visitorId: id,
      sessionId: id,
      id: () => crypto.randomUUID(),
      now: () => 0,
      send: deliver,
      beacon: () => true,
      onExcluded: () => {},
      clientHints: read,
    });
    runtime.track({ name: "page_view", surface: "home" });
    await runtime.flush();
    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver.mock.calls[0]![0].clientHints).toEqual({
      brands: [{ brand: "Chromium", version: "130" }],
      platform: "Android",
      mobile: true,
    });
    expect(high).toHaveBeenCalledExactlyOnceWith(["model", "platformVersion"]);
    resolve({
      model: " Pixel 8 ",
      platformVersion: " 14.0.0 ",
      architecture: "ignored",
    });
    await Promise.resolve();
    runtime.track({ name: "content_open", surface: "browse" });
    await runtime.flush();
    expect(deliver.mock.calls[1]![0].clientHints).toEqual({
      brands: [{ brand: "Chromium", version: "130" }],
      platform: "Android",
      mobile: true,
      model: "Pixel 8",
      platformVersion: "14.0.0",
    });
    expect(high).toHaveBeenCalledOnce();
  });

  it("keeps ordinary tracking when hints are missing, denied, malformed or throw", async () => {
    const denied = createAnalyticsClientHintsReader({
      userAgentData: {
        platform: "Android",
        getHighEntropyValues: () => Promise.reject(new Error("denied")),
      },
    });
    expect(denied()).toEqual({ platform: "Android" });
    await Promise.resolve();
    await Promise.resolve();
    expect(denied()).toEqual({ platform: "Android" });
    const throwing = Object.defineProperty({}, "userAgentData", {
      get() {
        throw new Error("unavailable");
      },
    });
    for (const source of [
      {},
      throwing,
      { userAgentData: { model: "a".repeat(129) } },
    ])
      expect(createAnalyticsClientHintsReader(source)()).toBeUndefined();
    const runtime = startAnalytics(true)!;
    expect(runtime).not.toBeNull();
    runtime.track({ name: "page_view", surface: "home" });
    await runtime.flush();
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![0]).not.toHaveProperty("clientHints");
  });

  it("retains the same browser UUID across ordinary starts and a new tab session", async () => {
    const first = startAnalytics(true)!;
    first.track({ name: "page_view", surface: "home" });
    await first.flush();
    const before = send.mock.calls[0]![0] as AnalyticsBatch;
    stopAnalytics();
    originalWindow.sessionStorage.clear();
    const again = startAnalytics(true)!;
    again.track({ name: "page_view", surface: "home" });
    await again.flush();
    const after = send.mock.calls[1]![0] as AnalyticsBatch;
    expect(after.visitorId).toBe(before.visitorId);
    expect(after.sessionId).not.toBe(before.sessionId);
  });
});
