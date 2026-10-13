/**
 * `AbortSignal.any` arrived in Chrome 116, Firefox 124 and Safari 17.4, after
 * the supported browser floors (docs/development/browser-support.md). First
 * party code links signals here instead; `dispose()` removes the link once a
 * request has finished, so a long-lived source (the per-document read signal)
 * keeps no listener per completed request.
 */
export interface LinkedAbortSignal {
  readonly signal: AbortSignal;
  /** Removes every listener this link added. Does not abort the signal. */
  dispose(): void;
}

export const linkAbortSignals = (
  signals: readonly AbortSignal[],
): LinkedAbortSignal => {
  const controller = new AbortController();
  const links: (readonly [AbortSignal, () => void])[] = [];
  const dispose = () => {
    for (const [source, listener] of links)
      source.removeEventListener("abort", listener);
    links.length = 0;
  };
  for (const source of signals) {
    if (source.aborted) {
      controller.abort(source.reason);
      return { signal: controller.signal, dispose };
    }
  }
  for (const source of signals) {
    const onAbort = () => {
      dispose();
      controller.abort(source.reason);
    };
    source.addEventListener("abort", onAbort, { once: true });
    links.push([source, onAbort]);
  }
  return { signal: controller.signal, dispose };
};

/**
 * For third-party code that calls the standard API directly (Uppy's XHR
 * upload). Installed from `instrumentation-client.ts`; an engine with the
 * native API keeps it. Remove once the floors reach Chrome 116, Firefox 124
 * and Safari 17.4.
 */
export const installAbortSignalAny = (): boolean => {
  if (typeof AbortSignal === "undefined") return false;
  if (typeof AbortSignal.any === "function") return false;
  Object.defineProperty(AbortSignal, "any", {
    configurable: true,
    writable: true,
    value: (signals: Iterable<AbortSignal>): AbortSignal => {
      const list = Array.from(signals);
      for (const signal of list)
        if (!(signal instanceof AbortSignal))
          throw new TypeError("AbortSignal.any: not an AbortSignal");
      return linkAbortSignals(list).signal;
    },
  });
  return true;
};
