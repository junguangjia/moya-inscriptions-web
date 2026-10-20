import { z } from "zod";

/** Dedicated first-party telemetry boundary; never accepts client identity or IP claims. */
export const analyticsEventSchema = z
  .strictObject({
    eventId: z.uuid(),
    name: z.enum([
      "page_view",
      "content_impression",
      "content_open",
      "content_dwell",
      "search",
      "search_click",
      "like",
      "favorite",
      "follow",
    ]),
    targetType: z.enum(["catalog", "work", "article", "profile"]).optional(),
    targetId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/u)
      .optional(),
    surface: z.enum([
      "home",
      "browse",
      "search",
      "detail",
      "profile",
      "thread",
      "other",
    ]),
    position: z.number().int().min(0).max(10000).optional(),
    sequenceId: z.string().min(1).max(128).optional(),
    requestId: z.string().min(1).max(128).optional(),
    rankingVersion: z.string().min(1).max(64).optional(),
    dwellMs: z.number().int().min(0).max(86400000).optional(),
    searchQuery: z.string().max(100).optional(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .superRefine((event, context) => {
    if ((event.targetType === undefined) !== (event.targetId === undefined))
      context.addIssue({
        code: "custom",
        message: "Target type and id must be supplied together",
      });
  });

export const analyticsBatchSchema = z.strictObject({
  visitorId: z.uuid(),
  sessionId: z.uuid(),
  events: z.array(analyticsEventSchema).min(1).max(20),
});
export const analyticsBatchResultSchema = z.strictObject({
  accepted: z.number().int().min(0).max(20),
  excluded: z.boolean(),
});
export const analyticsStatusSchema = z.strictObject({
  enabled: z.boolean(),
  forwardingConfigured: z.boolean(),
  ownerExclusionConfigured: z.boolean(),
  eventRetentionDays: z.number().int().positive(),
  ipRetentionDays: z.literal(7),
  last24Hours: z.strictObject({
    events: z.number().int().nonnegative(),
    visitors: z.number().int().nonnegative(),
    users: z.number().int().nonnegative(),
    sessions: z.number().int().nonnegative(),
  }),
  outbox: z.strictObject({
    pending: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
  lastEventAt: z.iso.datetime().nullable(),
  lastForwardedAt: z.iso.datetime().nullable(),
});
export const analyticsIpObservationsSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        id: z.uuid(),
        ip: z.string(),
        visitorId: z.uuid(),
        userId: z.string().nullable(),
        userAgent: z.string(),
        receivedAt: z.iso.datetime(),
        expiresAt: z.iso.datetime(),
      }),
    )
    .max(50),
});
export type AnalyticsEvent = z.infer<typeof analyticsEventSchema>;
export type AnalyticsBatch = z.infer<typeof analyticsBatchSchema>;
export type AnalyticsBatchResult = z.infer<typeof analyticsBatchResultSchema>;
export type AnalyticsStatus = z.infer<typeof analyticsStatusSchema>;
export type AnalyticsIpObservations = z.infer<
  typeof analyticsIpObservationsSchema
>;
