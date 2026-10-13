import { afterEach, describe, expect, it, vi } from "vitest";
import { installAbortSignalAny, linkAbortSignals } from "./abort-signals";

// Web code may not import node:events, so each test signal records its own
// abort listeners. A `once` listener is gone after the single abort event.
type Listener = EventListenerOrEventListenerObject;
const registered = new WeakMap<AbortSignal, Map<Listener, boolean>>();
const controller = (): AbortController => {
  const created = new AbortController();
  const { signal } = created;
  const live = new Map<Listener, boolean>();
  registered.set(signal, live);
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((
    type: string,
    listener: Listener,
    options?: boolean | AddEventListenerOptions,
  ) => {
    if (type === "abort")
      live.set(listener, typeof options === "object" && options.once === true);
    add(type, listener, options);
  }) as AbortSignal["addEventListener"];
  signal.removeEventListener = ((
    type: string,
    listener: Listener,
    options?: boolean | EventListenerOptions,
  ) => {
    if (type === "abort") live.delete(listener);
    remove(type, listener, options);
  }) as AbortSignal["removeEventListener"];
  return created;
};
const listeners = (signal: AbortSignal) =>
  [...registered.get(signal)!].filter(([, once]) => !(once && signal.aborted))
    .length;

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
    const live = controller();
    const done = controller();
    const reason = new Error("left");
    done.abort(reason);
    const linked = linkAbortSignals([live.signal, done.signal]);
    expect(linked.signal.aborted).toBe(true);
    expect(linked.signal.reason).toBe(reason);
    expect(listeners(live.signal)).toBe(0);
    expect(listeners(done.signal)).toBe(0);
  });

  it("follows the first abort with its reason identity and ignores later ones", () => {
    const first = controller();
    const second = controller();
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
    const sources = [controller(), controller()];
    linkAbortSignals(sources.map((source) => source.signal));
    expect(sources.map((source) => listeners(source.signal))).toEqual([1, 1]);
    sources[0]!.abort();
    expect(sources.map((source) => listeners(source.signal))).toEqual([0, 0]);
  });

  it("carries the TimeoutError of AbortSignal.timeout", async () => {
    const caller = controller();
    const linked = linkAbortSignals([caller.signal, AbortSignal.timeout(1)]);
    await new Promise((resolve) =>
      linked.signal.addEventListener("abort", resolve, { once: true }),
    );
    expect(linked.signal.reason).toBeInstanceOf(DOMException);
    expect(linked.signal.reason).toMatchObject({ name: "TimeoutError" });
    expect(listeners(caller.signal)).toBe(0);
  });

  it("throws the source reason from throwIfAborted", () => {
    const source = controller();
    const linked = linkAbortSignals([source.signal]);
    expect(() => linked.signal.throwIfAborted()).not.toThrow();
    source.abort();
    expect(() => linked.signal.throwIfAborted()).toThrow(
      expect.objectContaining({ name: "AbortError" }),
    );
  });

  it("composes linked signals", () => {
    const outer = controller();
    const inner = controller();
    const other = controller();
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
    const sources = [controller(), controller()];
    const linked = linkAbortSignals(sources.map((source) => source.signal));
    linked.dispose();
    expect(sources.map((source) => listeners(source.signal))).toEqual([0, 0]);
    sources[1]!.abort();
    expect(linked.signal.aborted).toBe(false);
    linked.dispose();
  });

  it("leaves a long-lived source without listeners after many finished links", () => {
    const document = controller();
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
    // The browsers' WebIDL shape: an enumerable, writable, configurable `any`.
    expect(Object.getOwnPropertyDescriptor(AbortSignal, "any")).toMatchObject({
      enumerable: true,
      writable: true,
      configurable: true,
    });
    expect(AbortSignal.any.name).toBe("any");
    const sources = [controller(), controller()];
    // Any iterable, including a one-shot generator, is read once.
    const signal = AbortSignal.any(
      (function* () {
        yield* sources.map((source) => source.signal);
      })() as unknown as AbortSignal[],
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
    const live = controller();
    expect(() =>
      AbortSignal.any([live.signal, {} as unknown as AbortSignal]),
    ).toThrow(TypeError);
    expect(listeners(live.signal)).toBe(0);
    for (const input of [{}, 5, null, undefined])
      expect(() => AbortSignal.any(input as unknown as AbortSignal[])).toThrow(
        TypeError,
      );
  });
});
