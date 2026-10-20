import { createTrustedAnalyticsRequestSource } from "@moya/backend-runtime";
import type { BackendApplicationOptions } from "@moya/backend-runtime";

type Environment = Readonly<Record<string, string | undefined>>;
type Policy = NonNullable<BackendApplicationOptions["analytics"]>["policy"];
const protectedValue = /^[A-Za-z0-9_-]{43,128}$/u;
const ids = (value: string | undefined): Set<string> => {
  const entries = (value ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (entries.some((value) => !/^[A-Za-z0-9_-]{3,128}$/u.test(value)))
    throw new Error("Analytics exclusion ids are invalid");
  return new Set(entries);
};
export interface AnalyticsConfiguration {
  readonly policy: Policy;
  readonly source:
    ReturnType<typeof createTrustedAnalyticsRequestSource> | undefined;
  readonly umami:
    | {
        readonly origin: string;
        readonly websiteId: string;
        readonly hostname?: string;
      }
    | undefined;
}
/** Validate configuration before opening any database pool. No development override exists. */
export const parseAnalyticsConfiguration = (
  environment: Environment,
  nodeEnv: string,
): AnalyticsConfiguration => {
  const enabledFlag = environment.MOYA_ANALYTICS_ENABLED;
  if (
    enabledFlag !== undefined &&
    enabledFlag !== "true" &&
    enabledFlag !== "false"
  )
    throw new Error("MOYA_ANALYTICS_ENABLED must be true or false");
  const enabled = enabledFlag === "true" && nodeEnv === "production";
  const owners = ids(environment.ANALYTICS_OWNER_USER_IDS);
  const tests = ids(environment.ANALYTICS_TEST_USER_IDS);
  const retention = Number(environment.ANALYTICS_EVENT_RETENTION_DAYS ?? "180");
  if (!Number.isInteger(retention) || retention < 7 || retention > 730)
    throw new Error("ANALYTICS_EVENT_RETENTION_DAYS must be between 7 and 730");
  if (enabled && !owners.size)
    throw new Error("Analytics requires non-empty ANALYTICS_OWNER_USER_IDS");
  if (enabled && !protectedValue.test(environment.ANALYTICS_HMAC_KEY ?? ""))
    throw new Error("ANALYTICS_HMAC_KEY: invalid protected configuration");
  if (enabled) {
    const credentials = [
      environment.ANALYTICS_RELAY_TOKEN,
      environment.ANALYTICS_HMAC_KEY,
      environment.COMMUNITY_OPERATOR_TOKEN,
      environment.AUTH_SOURCE_RELAY_TOKEN,
    ].filter((value): value is string => Boolean(value));
    if (new Set(credentials).size !== credentials.length)
      throw new Error(
        "Analytics keys must be separate from each other and Owner/auth authority",
      );
  }
  const source = enabled
    ? createTrustedAnalyticsRequestSource(environment.ANALYTICS_RELAY_TOKEN)
    : undefined;
  let umami: AnalyticsConfiguration["umami"];
  if (enabled && (environment.UMAMI_ORIGIN || environment.UMAMI_WEBSITE_ID)) {
    let origin: URL;
    try {
      origin = new URL(environment.UMAMI_ORIGIN ?? "");
    } catch {
      throw new Error("UMAMI_ORIGIN is invalid");
    }
    if (
      origin.protocol !== "http:" ||
      !["127.0.0.1", "[::1]", "localhost"].includes(origin.hostname) ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    )
      throw new Error("UMAMI_ORIGIN must be a plain loopback HTTP origin");
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        environment.UMAMI_WEBSITE_ID ?? "",
      )
    )
      throw new Error("UMAMI_WEBSITE_ID is invalid");
    if (environment.DATABASE_POOL_MAX === "1")
      throw new Error(
        "Analytics forwarding requires DATABASE_POOL_MAX of at least 2",
      );
    const hostname = environment.ANALYTICS_SITE_HOSTNAME;
    if (
      hostname !== undefined &&
      !/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/u.test(hostname)
    )
      throw new Error(
        "ANALYTICS_SITE_HOSTNAME must be a hostname without a path or port",
      );
    umami = {
      origin: origin.origin,
      websiteId: environment.UMAMI_WEBSITE_ID!,
      ...(hostname ? { hostname: hostname.toLowerCase() } : {}),
    };
  }
  return {
    policy: {
      enabled,
      production: nodeEnv === "production",
      excludedUserIds: new Set([...owners, ...tests]),
      ownerExclusionConfigured: owners.size > 0,
      hmacKey: environment.ANALYTICS_HMAC_KEY ?? "",
      forwardingConfigured: umami !== undefined,
      eventRetentionDays: retention,
    },
    source,
    umami,
  };
};
