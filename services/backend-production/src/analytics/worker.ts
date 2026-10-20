import type { BackendApplicationOptions } from "@moya/backend-runtime";

type Port = NonNullable<BackendApplicationOptions["analytics"]>["port"];
export interface AnalyticsForwardingTarget {
  readonly origin: string;
  readonly websiteId: string;
  readonly hostname?: string;
}
/** Bounded, non-overlapping delivery and retention in the existing Backend process. */
export class AnalyticsWorker {
  private stopped = true;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private lastRetention = 0;
  constructor(
    private readonly port: Port,
    private readonly target: AnalyticsForwardingTarget | undefined,
    private readonly retentionDays: number,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }
  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.tick().finally(() => {
        this.running = undefined;
        this.schedule(5000);
      });
    }, delay);
    this.timer.unref();
  }
  /** Public for deterministic synthetic acceptance; start() never overlaps ticks. */
  async tick(): Promise<void> {
    const now = this.now();
    try {
      if (now.getTime() - this.lastRetention >= 5 * 60 * 1000) {
        await this.port.retain(now, this.retentionDays);
        this.lastRetention = now.getTime();
      }
      const target = this.target;
      if (!target) return;
      await this.port.withDeliveryLock(async (delivery) => {
        const deliveries = await delivery.pending(50, now);
        if (!deliveries.length) return;
        const eventIds = deliveries.map((event) => event.eventId);
        try {
          const response = await this.fetcher(
            new URL("/admin/analytics-workspace/api/batch", target.origin),
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "user-agent": "Moya analytics relay",
              },
              body: JSON.stringify(
                deliveries.map((event) => ({
                  type: "event",
                  payload: {
                    ...event.payload,
                    website: target.websiteId,
                    ...(target.hostname ? { hostname: target.hostname } : {}),
                  },
                })),
              ),
              signal: AbortSignal.timeout(3000),
              redirect: "error",
            },
          );
          if (!response.ok) throw new Error("Analytics forwarding unavailable");
          const body: unknown = await response.json();
          if (
            typeof body !== "object" ||
            body === null ||
            !("size" in body) ||
            body.size !== deliveries.length ||
            !("details" in body) ||
            !Array.isArray(body.details)
          )
            throw new Error("Analytics forwarding response invalid");
          const failures = new Set<number>();
          for (const detail of body.details) {
            if (
              typeof detail !== "object" ||
              detail === null ||
              !("index" in detail) ||
              !Number.isInteger(detail.index) ||
              Number(detail.index) < 0 ||
              Number(detail.index) >= deliveries.length
            )
              throw new Error("Analytics forwarding response invalid");
            failures.add(Number(detail.index));
          }
          if (
            !("errors" in body) ||
            body.errors !== failures.size ||
            !("processed" in body) ||
            body.processed !== deliveries.length - failures.size
          )
            throw new Error("Analytics forwarding response invalid");
          await delivery.delivered(
            eventIds.filter((_, index) => !failures.has(index)),
            this.now(),
          );
          await delivery.failed(
            eventIds.filter((_, index) => failures.has(index)),
            this.now(),
          );
        } catch {
          await delivery.failed(eventIds, this.now());
          console.error("[analytics-worker] forwarding_unavailable");
        }
      });
    } catch {
      console.error("[analytics-worker] pump_unavailable");
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }
}
