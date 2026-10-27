import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("localStorage", { setItem: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());
describe("bounded owner exclusion", () => {
  it("shares concurrent attempts and remembers successful exclusion", async () => {
    let finish!: (value: Response) => void;
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    const { excludeOwnerAnalyticsDevice: exclude } =
      await import("admin/analytics-device");
    const signal = new AbortController().signal;
    const first = exclude(signal),
      second = exclude(signal);
    expect(fetcher).toHaveBeenCalledOnce();
    finish(new Response(null, { status: 200 }));
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(await exclude(signal)).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("does not retain a refused or failed attempt", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("synthetic network interruption"))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const { excludeOwnerAnalyticsDevice: exclude } =
      await import("admin/analytics-device");
    const signal = new AbortController().signal;
    expect(await exclude(signal)).toBe(false);
    expect(await exclude(signal)).toBe(false);
    expect(await exclude(signal)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("retries a failed shell attempt once before entering analytics", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const { prepareOwnerAnalyticsEntry: prepare } =
      await import("admin/analytics-device");
    expect(await prepare(new AbortController().signal)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("stops after two failures and does not start work for an aborted caller", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetcher);
    const { prepareOwnerAnalyticsEntry: prepare } =
      await import("admin/analytics-device");
    expect(await prepare(new AbortController().signal)).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const controller = new AbortController();
    controller.abort();
    expect(await prepare(controller.signal)).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

it("joins a pending shell failure then retries once for analytics entry", async () => {
  let finish!: (value: Response) => void;
  const fetcher = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", fetcher);
  const {
    excludeOwnerAnalyticsDevice: exclude,
    prepareOwnerAnalyticsEntry: prepare,
  } = await import("admin/analytics-device");
  const signal = new AbortController().signal;
  const shell = exclude(signal);
  const entry = prepare(signal);
  expect(fetcher).toHaveBeenCalledOnce();
  finish(new Response(null, { status: 503 }));
  expect(await shell).toBe(false);
  expect(await entry).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
