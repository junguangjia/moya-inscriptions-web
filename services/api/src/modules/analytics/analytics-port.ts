import type {
  AnalyticsBatch,
  AnalyticsIpObservations,
  AnalyticsStatus,
} from "@moya/contracts/analytics";

export interface AnalyticsWriteContext {
  readonly userId: string | null;
  readonly distinctId: string;
  readonly ip: string;
  readonly userAgent: string;
  readonly receivedAt: Date;
  readonly forward: boolean;
}
export interface AnalyticsDelivery {
  readonly eventId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly attempts: number;
}
export interface AnalyticsDeliveryPort {
  pending(limit: number, now: Date): Promise<readonly AnalyticsDelivery[]>;
  delivered(eventIds: readonly string[], now: Date): Promise<void>;
  failed(eventIds: readonly string[], now: Date): Promise<void>;
}
export interface AnalyticsPort {
  /** Dedupe and enqueue atomically; only newly inserted events get an outbox row. */
  append(
    batch: AnalyticsBatch,
    context: AnalyticsWriteContext,
  ): Promise<number>;
  status(
    now: Date,
  ): Promise<
    Pick<
      AnalyticsStatus,
      "last24Hours" | "outbox" | "lastEventAt" | "lastForwardedAt"
    >
  >;
  recentIps(now: Date): Promise<AnalyticsIpObservations>;
  /** One bounded pump under a database-wide lock, including its network call. */
  withDeliveryLock(
    run: (delivery: AnalyticsDeliveryPort) => Promise<void>,
  ): Promise<boolean>;
  /** Bounded deletes; expired IP is never returned by the read/delivery paths. */
  retain(now: Date, eventRetentionDays: number): Promise<void>;
}
