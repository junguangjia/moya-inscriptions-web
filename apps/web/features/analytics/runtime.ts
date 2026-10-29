import type {
  AnalyticsBatch,
  AnalyticsBatchResult,
} from "@moya/contracts/analytics";

export type AnalyticsEvent = AnalyticsBatch["events"][number];
export type AnalyticsInput = Omit<AnalyticsEvent, "eventId" | "occurredAt">;
export const ANALYTICS_DISABLED_KEY = "moya.analytics.disabled";
export const ANALYTICS_EXCLUDED_COOKIE = "moya-analytics-excluded";
// Matches the trusted Web relay, Nginx and Backend UTF-8 body budget.
export const ANALYTICS_MAX_BYTES = 32_768;

interface RuntimeOptions {
  readonly visitorId: string;
  readonly sessionId: string;
  readonly id: () => string;
  readonly now: () => number;
  readonly send: (batch: AnalyticsBatch) => Promise<AnalyticsBatchResult>;
  readonly beacon: (batch: AnalyticsBatch) => boolean;
  readonly onExcluded: () => void;
  readonly shouldCollect?: () => boolean;
  readonly clientHints?: () => AnalyticsBatch["clientHints"];
}
interface Queued {
  event: AnalyticsEvent;
  attempts: number;
}

/** One bounded in-memory queue. No persistence, polling, or business-operation await. */
export const createAnalyticsRuntime = (options: RuntimeOptions) => {
  let queue: Queued[] = [];
  let sending = false;
  let stopped = false;
  let nextAttemptAt = 0;
  let generation = 0;
  const batchOf = (entries: Queued[]): AnalyticsBatch => {
    let clientHints: AnalyticsBatch["clientHints"];
    try {
      clientHints = options.clientHints?.();
    } catch {
      // Optional device information never disables ordinary event delivery.
    }
    return {
      visitorId: options.visitorId,
      sessionId: options.sessionId,
      events: entries.map(({ event }) => event),
      ...(clientHints === undefined ? {} : { clientHints }),
    };
  };
  const take = () => {
    const entries: Queued[] = [];
    while (queue.length && entries.length < 20) {
      const candidate = [...entries, queue[0]!];
      if (
        new TextEncoder().encode(JSON.stringify(batchOf(candidate))).length >
        ANALYTICS_MAX_BYTES
      )
        break;
      entries.push(queue.shift()!);
    }
    return entries;
  };
  const exclude = () => {
    stopped = true;
    queue = [];
    options.onExcluded();
  };
  const canCollect = () => {
    if (stopped) return false;
    if (options.shouldCollect && !options.shouldCollect()) {
      exclude();
      return false;
    }
    return true;
  };
  const flush = async () => {
    if (
      !canCollect() ||
      sending ||
      !queue.length ||
      options.now() < nextAttemptAt
    )
      return;
    sending = true;
    const run = generation;
    const entries = take();
    if (!entries.length) {
      sending = false;
      return;
    }
    try {
      const result = await options.send(batchOf(entries));
      if (result.excluded) exclude();
    } catch {
      // At most two attempts per event; retry only at the next regular flush.
      if (!stopped && run === generation)
        queue = [
          ...entries
            .map((entry) => ({ ...entry, attempts: entry.attempts + 1 }))
            .filter((entry) => entry.attempts < 2),
          ...queue,
        ].slice(0, 100);
      nextAttemptAt = options.now() + 30_000;
      sending = false;
      return;
    }
    sending = false;
    if (queue.length >= 20) void flush();
  };
  return {
    track(input: AnalyticsInput) {
      if (!canCollect() || queue.length >= 100) return;
      const event = {
        ...input,
        eventId: options.id(),
        occurredAt: new Date(options.now()).toISOString(),
      };
      // A malformed/oversized event must not wedge the head of the queue.
      if (
        new TextEncoder().encode(
          JSON.stringify(batchOf([{ event, attempts: 0 }])),
        ).length > ANALYTICS_MAX_BYTES
      )
        return;
      queue.push({ event, attempts: 0 });
      if (queue.length >= 20) void flush();
    },
    flush,
    beacon() {
      if (!canCollect() || !queue.length) return;
      const entries = take();
      if (!options.beacon(batchOf(entries)))
        queue = [...entries, ...queue].slice(0, 100);
    },
    exclude,
    clear() {
      generation++;
      queue = [];
    },
    stop() {
      stopped = true;
      queue = [];
    },
    pending: () => queue.length,
  };
};

export type AnalyticsRuntime = ReturnType<typeof createAnalyticsRuntime>;

/** Background time never counts, and a long-lived page uses no timer heartbeat. */
export const createForegroundClock = (now: () => number, visible: boolean) => {
  let since: number | null = visible ? now() : null;
  let elapsed = 0;
  return {
    visibility(next: boolean) {
      if (since !== null) elapsed += Math.max(0, now() - since);
      since = next ? now() : null;
    },
    read() {
      return Math.min(
        86_400_000,
        Math.round(elapsed + (since === null ? 0 : Math.max(0, now() - since))),
      );
    },
  };
};

export const productionAnalyticsAllowed = (
  enabled: boolean,
  nodeEnv: string | undefined,
  location: Pick<Location, "pathname" | "hostname">,
  webdriver = false,
) =>
  enabled &&
  nodeEnv === "production" &&
  location.pathname === "/" &&
  !webdriver &&
  !/^(localhost|127(?:\.\d+){3}|\[?::1\]?|.*\.localhost)$/u.test(
    location.hostname,
  );
