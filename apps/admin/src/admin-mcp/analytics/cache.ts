const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

export const ANALYTICS_CACHE_TTL_MS = {
  realtime: 10_000,
  open: MINUTE_MS,
  unsettled: 5 * MINUTE_MS,
  settled: 6 * HOUR_MS,
} as const;

/**
 * A finished period keeps changing until its late events have arrived: the 24 h
 * client-clock window, then about 21 minutes of retry gaps, rounded up.
 */
export const ANALYTICS_SETTLED_AFTER_MS = 24.5 * HOUR_MS;

export const ANALYTICS_CACHE_MAX_BYTES = 16 * 1024 * 1024;

export const analyticsTtlMs = (
  period: "realtime" | "open" | { readonly end: number },
  now: number,
): number =>
  typeof period === "string"
    ? ANALYTICS_CACHE_TTL_MS[period]
    : now - period.end < ANALYTICS_SETTLED_AFTER_MS
      ? ANALYTICS_CACHE_TTL_MS.unsettled
      : ANALYTICS_CACHE_TTL_MS.settled;

/** The minute an open range is read up to, so calls in one minute ask the same thing. */
export const snappedOpenEnd = (start: number, now: number): number =>
  Math.max(Math.floor(now / MINUTE_MS) * MINUTE_MS, start + MINUTE_MS);

interface Stored<T = unknown> {
  readonly version: string;
  readonly value: T;
  readonly fetchedAt: number;
  readonly ttlMs: number;
  readonly bytes: number;
}

interface Flight {
  readonly promise: Promise<Stored>;
  waiters: number;
}

export type AnalyticsCacheRead<T> =
  | {
      readonly status: "answered";
      readonly hit: boolean;
      readonly fetchedAt: number;
      readonly value: T;
    }
  | { readonly status: "late" }
  | { readonly status: "failed"; readonly error: unknown };

/**
 * Answers by normalized query, one load per query however many ask at once. A family
 * is one question and holds one answer, the latest: `version` is the minute an open
 * range was read up to, so a new minute reads again, replaces the old answer, and the
 * old one can still stand in, marked stale, if the read fails.
 */
export const createAnalyticsCache = ({
  now = Date.now,
  maxBytes = ANALYTICS_CACHE_MAX_BYTES,
}: {
  readonly now?: () => number;
  readonly maxBytes?: number;
} = {}) => {
  // Insertion order is least-recently-used first.
  const entries = new Map<string, Stored>();
  const flights = new Map<string, Flight>();
  let bytes = 0;
  let generation = 0;

  const drop = (family: string) => {
    const entry = entries.get(family);
    if (entry === undefined) return;
    bytes -= entry.bytes;
    entries.delete(family);
  };

  const store = (family: string, entry: Stored) => {
    drop(family);
    if (entry.bytes > maxBytes) return;
    entries.set(family, entry);
    bytes += entry.bytes;
    for (const oldest of entries.keys()) {
      if (bytes <= maxBytes) break;
      drop(oldest);
    }
  };

  const startFlight = (
    id: string,
    family: string,
    version: string,
    ttlMs: number,
    load: (wanted: () => boolean) => Promise<unknown>,
  ): Flight => {
    const startedIn = generation;
    const flight: { promise?: Promise<Stored>; waiters: number } = {
      waiters: 0,
    };
    const promise = load(() => flight.waiters > 0).then((value) => {
      const entry = {
        version,
        value,
        fetchedAt: now(),
        ttlMs,
        bytes: Buffer.byteLength(JSON.stringify(value)),
      };
      // Purged while it ran: what it read may be what the purge was for.
      if (generation === startedIn) store(family, entry);
      return entry;
    });
    flight.promise = promise;
    void promise
      .catch(() => undefined)
      .finally(() => {
        if (flights.get(id) === flight) flights.delete(id);
      });
    flights.set(id, flight as Flight);
    return flight as Flight;
  };

  return {
    /**
     * An answer still good needs no time. Past `waitMs` the caller leaves with `late`
     * while the load runs on and fills the cache; with no time left none starts. The
     * load is told whether anyone still waits, so a queued one nobody wants never runs.
     */
    async read<T>({
      family,
      version,
      ttlMs,
      waitMs,
      load,
    }: {
      readonly family: string;
      readonly version: string;
      readonly ttlMs: number;
      readonly waitMs: number;
      readonly load: (wanted: () => boolean) => Promise<T>;
    }): Promise<AnalyticsCacheRead<T>> {
      const entry = entries.get(family);
      if (
        entry !== undefined &&
        entry.version === version &&
        now() - entry.fetchedAt < entry.ttlMs
      ) {
        entries.delete(family);
        entries.set(family, entry);
        return {
          status: "answered",
          hit: true,
          fetchedAt: entry.fetchedAt,
          value: entry.value as T,
        };
      }
      if (waitMs <= 0) return { status: "late" };
      const id = `${family}\n${version}`;
      const flight =
        flights.get(id) ?? startFlight(id, family, version, ttlMs, load);
      flight.waiters += 1;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const answered = await Promise.race([
          flight.promise,
          new Promise<"late">((resolve) => {
            timer = setTimeout(() => resolve("late"), waitMs);
          }),
        ]);
        return answered === "late"
          ? { status: "late" }
          : {
              status: "answered",
              hit: false,
              fetchedAt: answered.fetchedAt,
              value: answered.value as T,
            };
      } catch (error) {
        return { status: "failed", error };
      } finally {
        clearTimeout(timer);
        flight.waiters -= 1;
      }
    },

    /** The family's latest answer, however old, for a caller that says it is stale. */
    latest<T>(family: string) {
      return entries.get(family) as Stored<T> | undefined;
    },

    /** After a definition save or a prune. A read now running stores nothing. */
    purge() {
      generation += 1;
      entries.clear();
      flights.clear();
      bytes = 0;
    },
  };
};

export type AnalyticsCache = ReturnType<typeof createAnalyticsCache>;

/** One per process, for both read paths, so a purge and the byte limit cover both. */
export const analyticsCache = createAnalyticsCache();
