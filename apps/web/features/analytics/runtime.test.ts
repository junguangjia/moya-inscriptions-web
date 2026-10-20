import { describe, expect, it, vi } from "vitest";
import type { AnalyticsBatch } from "@moya/contracts/analytics";
import {
  createAnalyticsRuntime,
  createForegroundClock,
  productionAnalyticsAllowed,
} from "./runtime";

const id = "11111111-1111-4111-8111-111111111111";
const setup = () => {
  let time = 0;
  const send = vi.fn<
    (batch: AnalyticsBatch) => Promise<{ accepted: number; excluded: boolean }>
  >(async () => ({ accepted: 20, excluded: false }));
  const beacon = vi.fn<(batch: AnalyticsBatch) => boolean>(() => true);
  const onExcluded = vi.fn();
  const runtime = createAnalyticsRuntime({
    visitorId: id,
    sessionId: id,
    id: () => crypto.randomUUID(),
    now: () => time,
    send,
    beacon,
    onExcluded,
  });
  return {
    runtime,
    send,
    beacon,
    onExcluded,
    advance: (value: number) => {
      time += value;
    },
  };
};

describe("bounded product event queue", () => {
  it("splits valid Unicode-rich events within the actual ingress byte budget", async () => {
    const { runtime, send } = setup();
    for (let i = 0; i < 20; i++)
      runtime.track({
        name: "content_impression",
        surface: "browse",
        targetType: "catalog",
        targetId: "a".repeat(128),
        sequenceId: "碑".repeat(128),
        requestId: "帖".repeat(128),
        rankingVersion: "字".repeat(64),
        searchQuery: "文".repeat(100),
        position: 10000,
        dwellMs: 86400000,
      });
    await Promise.resolve();
    await runtime.flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.flatMap(([batch]) => batch.events)).toHaveLength(20);
    for (const [batch] of send.mock.calls)
      expect(
        new TextEncoder().encode(JSON.stringify(batch)).length,
      ).toBeLessThanOrEqual(32768);
  });
  it("makes no empty request and batches only when twenty events or the flush arrive", async () => {
    const { runtime, send } = setup();
    await runtime.flush();
    expect(send).not.toHaveBeenCalled();
    for (let i = 0; i < 19; i++)
      runtime.track({ name: "page_view", surface: "home" });
    expect(send).not.toHaveBeenCalled();
    runtime.track({
      name: "content_impression",
      surface: "browse",
      targetType: "catalog",
      targetId: "synthetic-1",
      position: 7,
      sequenceId: "sequence-1",
    });
    await runtime.flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0].events).toHaveLength(20);
    expect(send.mock.calls[0]?.[0].events[19]).toMatchObject({
      position: 7,
      sequenceId: "sequence-1",
      targetId: "synthetic-1",
    });
  });
  it("caps at one hundred while offline, waits thirty seconds, and drops after two attempts", async () => {
    const { runtime, send, advance } = setup();
    send.mockRejectedValue(new Error("offline"));
    for (let i = 0; i < 150; i++)
      runtime.track({ name: "page_view", surface: "home" });
    await Promise.resolve();
    expect(runtime.pending()).toBeLessThanOrEqual(100);
    for (let i = 0; i < 100; i++)
      runtime.track({ name: "page_view", surface: "home" });
    await runtime.flush();
    expect(send).toHaveBeenCalledTimes(1);
    advance(30_000);
    await runtime.flush();
    expect(send).toHaveBeenCalledTimes(2);
    // Those twenty twice-failed events are removed; no immediate retry loop.
    expect(runtime.pending()).toBe(80);
  });
  it("accepts server exclusion, clears pending work and prevents later sends", async () => {
    const { runtime, send, beacon, onExcluded } = setup();
    send.mockResolvedValue({ accepted: 0, excluded: true });
    runtime.track({ name: "page_view", surface: "home" });
    await runtime.flush();
    runtime.track({ name: "like", surface: "detail" });
    runtime.beacon();
    await runtime.flush();
    expect(runtime.pending()).toBe(0);
    expect(onExcluded).toHaveBeenCalledOnce();
    expect(beacon).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
  });
  it("uses a bounded beacon without waiting for a network answer", () => {
    const { runtime, beacon } = setup();
    runtime.track({ name: "content_dwell", surface: "detail", dwellMs: 4_000 });
    runtime.beacon();
    runtime.beacon();
    expect(beacon).toHaveBeenCalledOnce();
    expect(
      new TextEncoder().encode(JSON.stringify(beacon.mock.calls[0]?.[0]))
        .length,
    ).toBeLessThan(64_000);
    expect(runtime.pending()).toBe(0);
  });
  it("rechecks device exclusion before any later flush or beacon", async () => {
    let allowed = true;
    const send = vi.fn();
    const beacon = vi.fn();
    const excluded = vi.fn();
    const runtime = createAnalyticsRuntime({
      visitorId: id,
      sessionId: id,
      id: () => id,
      now: () => 0,
      send,
      beacon,
      onExcluded: excluded,
      shouldCollect: () => allowed,
    });
    runtime.track({ name: "page_view", surface: "home" });
    allowed = false;
    await runtime.flush();
    runtime.beacon();
    expect(runtime.pending()).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(beacon).not.toHaveBeenCalled();
    expect(excluded).toHaveBeenCalledOnce();
  });
  it("does not restore an earlier account's failed batch after identity changes", async () => {
    let reject!: (error: Error) => void;
    const send = vi.fn(
      () =>
        new Promise<never>((_resolve, fail) => {
          reject = fail;
        }),
    );
    const runtime = createAnalyticsRuntime({
      visitorId: id,
      sessionId: id,
      id: () => id,
      now: () => 0,
      send,
      beacon: () => true,
      onExcluded: () => {},
    });
    runtime.track({ name: "page_view", surface: "home" });
    const pending = runtime.flush();
    runtime.clear();
    reject(new Error("interrupted"));
    await pending;
    expect(runtime.pending()).toBe(0);
  });
});

it("counts only foreground dwell without heartbeat timers", () => {
  let now = 0;
  const clock = createForegroundClock(() => now, true);
  now = 1_200;
  clock.visibility(false);
  now = 61_200;
  expect(clock.read()).toBe(1_200);
  clock.visibility(true);
  now = 62_000;
  expect(clock.read()).toBe(2_000);
});

it("requires explicit production enablement and excludes QA, auth and automated traffic", () => {
  const allowed = (
    enabled = true,
    env = "production",
    pathname = "/",
    hostname = "example.test",
    webdriver = false,
  ) =>
    productionAnalyticsAllowed(enabled, env, { pathname, hostname }, webdriver);
  expect(allowed()).toBe(true);
  expect(allowed(false)).toBe(false);
  expect(allowed(true, "development")).toBe(false);
  expect(allowed(true, "test")).toBe(false);
  for (const path of [
    "/dev/t02p/qa",
    "/login",
    "/article-authoring/approval",
    "/account",
  ])
    expect(allowed(true, "production", path)).toBe(false);
  expect(allowed(true, "production", "/", "127.0.0.1")).toBe(false);
  expect(allowed(true, "production", "/", "example.test", true)).toBe(false);
});
