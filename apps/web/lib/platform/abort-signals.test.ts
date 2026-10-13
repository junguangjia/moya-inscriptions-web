import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installAbortSignalAny, linkAbortSignals } from "./abort-signals";

const listeners = (signal: AbortSignal) =>
  getEventListeners(signal, "abort").length;

const nativeAny = Object.getOwnPropertyDescriptor(AbortSignal, "any");
const removeNativeAny = () => {
  Reflect.deleteProperty(AbortSignal, "any");
  expect(AbortSignal.any).toBeUndefined();
};

afterEach(() => {
  vi.unstubAllGlobals();
  if (nativeAny) Object.defineProperty(AbortSignal, "any", nativeAny);
});

describe("linkAbortSignals", () => {
  it("starts aborted with the same reason object and adds no listener when a source is already aborted", () => {
    const live = new AbortController();
    const done = new AbortController();
    const reason = new Error("left");
    done.abort(reason);
    const linked = linkAbortSignals([live.signal, done.signal]);
    expect(linked.signal.aborted).toBe(true);
    expect(linked.signal.reason).toBe(reason);
    expect(listeners(live.signal)).toBe(0);
    expect(listeners(done.signal)).toBe(0);
  });

  it("follows the first abort with its reason identity and ignores later ones", () => {
    const first = new AbortController();
    const second = new AbortController();
    const linked = linkAbortSignals([first.signal, second.signal]);
    const seen = vi.fn();
    linked.signal.addEventListener("abort", seen);
    expect(linked.signal.aborted).toBe(false);
    const reason = { why: "second" };
    second.abort(reason);
    first.abort(new Error("first, but later"));
    expect(linked.signal.aborted).toBe(true);
    expect(linked.signal.reason).toBe(reason);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("removes its listeners from every source once one aborts", () => {
    const sources = [new AbortController(), new AbortController()];
    linkAbortSignals(sources.map((source) => source.signal));
    expect(sources.map((source) => listeners(source.signal))).toEqual([1, 1]);
    sources[0]!.abort();
    expect(sources.map((source) => listeners(source.signal))).toEqual([0, 0]);
  });

  it("carries the TimeoutError of AbortSignal.timeout", async () => {
    const caller = new AbortController();
    const linked = linkAbortSignals([caller.signal, AbortSignal.timeout(1)]);
    await new Promise((resolve) =>
      linked.signal.addEventListener("abort", resolve, { once: true }),
    );
    expect(linked.signal.reason).toBeInstanceOf(DOMException);
    expect(linked.signal.reason).toMatchObject({ name: "TimeoutError" });
    expect(listeners(caller.signal)).toBe(0);
  });

  it("throws the source reason from throwIfAborted", () => {
    const source = new AbortController();
    const linked = linkAbortSignals([source.signal]);
    expect(() => linked.signal.throwIfAborted()).not.toThrow();
    source.abort();
    expect(() => linked.signal.throwIfAborted()).toThrow(
      expect.objectContaining({ name: "AbortError" }),
    );
  });

  it("composes linked signals", () => {
    const outer = new AbortController();
    const inner = new AbortController();
    const other = new AbortController();
    const first = linkAbortSignals([inner.signal]);
    const nested = linkAbortSignals([first.signal, other.signal]);
    const sibling = linkAbortSignals([outer.signal, nested.signal]);
    const reason = new Error("inner");
    inner.abort(reason);
    expect(first.signal.reason).toBe(reason);
    expect(nested.signal.reason).toBe(reason);
    expect(sibling.signal.reason).toBe(reason);
    expect(listeners(other.signal)).toBe(0);
    expect(listeners(outer.signal)).toBe(0);
  });

  it("never aborts an empty link", () => {
    const linked = linkAbortSignals([]);
    expect(linked.signal.aborted).toBe(false);
    expect(() => linked.dispose()).not.toThrow();
    expect(linked.signal.aborted).toBe(false);
  });

  it("stops propagation and leaves no listener after dispose", () => {
    const sources = [new AbortController(), new AbortController()];
    const linked = linkAbortSignals(sources.map((source) => source.signal));
    linked.dispose();
    expect(sources.map((source) => listeners(source.signal))).toEqual([0, 0]);
    sources[1]!.abort();
    expect(linked.signal.aborted).toBe(false);
    linked.dispose();
  });

  it("leaves a long-lived source without listeners after many finished links", () => {
    const document = new AbortController();
    for (let request = 0; request < 50; request++) {
      const linked = linkAbortSignals([
        AbortSignal.timeout(15_000),
        document.signal,
      ]);
      linked.dispose();
    }
    expect(listeners(document.signal)).toBe(0);
  });
});

describe("installAbortSignalAny", () => {
  it("keeps the native API where the engine has one", () => {
    if (!nativeAny) throw new Error("This runtime lacks AbortSignal.any");
    const native = AbortSignal.any;
    expect(installAbortSignalAny()).toBe(false);
    expect(AbortSignal.any).toBe(native);
  });

  it("does nothing without AbortSignal", () => {
    vi.stubGlobal("AbortSignal", undefined);
    expect(installAbortSignalAny()).toBe(false);
  });

  it("installs a standard-shaped AbortSignal.any where it is missing", () => {
    removeNativeAny();
    expect(installAbortSignalAny()).toBe(true);
    expect(installAbortSignalAny()).toBe(false);
    const sources = [new AbortController(), new AbortController()];
    // The standard accepts any iterable, as Uppy's caller may pass one.
    const signal = AbortSignal.any(
      new Set(
        sources.map((source) => source.signal),
      ) as unknown as AbortSignal[],
    );
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
    const reason = new Error("second");
    sources[1]!.abort(reason);
    expect(signal.reason).toBe(reason);
    expect(listeners(sources[0]!.signal)).toBe(0);
  });

  it("rejects anything that is not an AbortSignal with a TypeError", () => {
    removeNativeAny();
    installAbortSignalAny();
    const live = new AbortController();
    expect(() =>
      AbortSignal.any([live.signal, {} as unknown as AbortSignal]),
    ).toThrow(TypeError);
    expect(listeners(live.signal)).toBe(0);
  });
});
