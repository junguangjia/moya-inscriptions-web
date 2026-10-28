import { createHmac } from "node:crypto";
import { ANALYTICS_IP_RETENTION_DAYS } from "@moya/contracts/analytics";
import type {
  AnalyticsBatch,
  AnalyticsBatchResult,
  AnalyticsIpObservations,
  AnalyticsStatus,
} from "@moya/contracts/analytics";
import type { AnalyticsPort } from "./analytics-port.js";

export interface AnalyticsPolicy {
  readonly enabled: boolean;
  readonly production: boolean;
  readonly excludedUserIds: ReadonlySet<string>;
  readonly ownerExclusionConfigured: boolean;
  readonly hmacKey: string;
  readonly forwardingConfigured: boolean;
  readonly eventRetentionDays: number;
}
export interface AnalyticsRequestContext {
  readonly userId: string | null;
  readonly ip: string;
  readonly userAgent: string;
  readonly excluded: boolean;
}
const explicitAutomation =
  /(?:HeadlessChrome|Playwright|Puppeteer|Cypress|Selenium|moya[-_ ](?:test|synthetic)|(?:bot|crawler|spider)(?:[ /;]|$)|ChatGPT-User|Claude-User|Perplexity-User|facebookexternalhit)/iu;

/** Product analytics never participates in a business command's transaction. */
export class AnalyticsService {
  constructor(
    private readonly port: AnalyticsPort,
    readonly policy: AnalyticsPolicy,
    private readonly now: () => Date = () => new Date(),
  ) {}
  async collect(
    batch: AnalyticsBatch,
    context: AnalyticsRequestContext,
  ): Promise<AnalyticsBatchResult> {
    if (!this.policy.enabled || !this.policy.production)
      return { accepted: 0, excluded: false };
    if (
      context.excluded ||
      explicitAutomation.test(context.userAgent) ||
      (context.userId !== null &&
        this.policy.excludedUserIds.has(context.userId))
    )
      return { accepted: 0, excluded: true };
    const at = this.now();
    // Bound client clock skew and backfill; server receipt time remains authoritative.
    if (
      batch.events.some(
        (event) =>
          Math.abs(new Date(event.occurredAt).getTime() - at.getTime()) >
          24 * 60 * 60 * 1000,
      )
    )
      throw new RangeError(
        "Analytics event time is outside the accepted window",
      );
    const distinctId = createHmac("sha256", this.policy.hmacKey)
      .update(
        context.userId === null
          ? `visitor:${batch.visitorId}`
          : `user:${context.userId}`,
      )
      .digest("hex")
      .slice(0, 40);
    const accepted = await this.port.append(batch, {
      ...context,
      distinctId,
      receivedAt: at,
      forward: this.policy.forwardingConfigured,
    });
    return { accepted, excluded: false };
  }
  async status(): Promise<AnalyticsStatus> {
    return {
      enabled: this.policy.enabled && this.policy.production,
      forwardingConfigured: this.policy.forwardingConfigured,
      ownerExclusionConfigured: this.policy.ownerExclusionConfigured,
      eventRetentionDays: this.policy.eventRetentionDays,
      ipRetentionDays: ANALYTICS_IP_RETENTION_DAYS,
      ...(await this.port.status(this.now())),
    };
  }
  recentIps(): Promise<AnalyticsIpObservations> {
    return this.port.recentIps(this.now());
  }
}
