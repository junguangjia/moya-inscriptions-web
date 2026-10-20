import process from "node:process";
import console from "node:console";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { bootstrapPlan, createUmamiClient } from "./bootstrap-umami.mjs";
import {
  AnalyticsToolError,
  readPrivateConfig,
  requireSetting,
  uuid,
} from "./common.mjs";

const browserAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

/** Public resolver addresses are synthetic GeoIP fixtures, never actual visitors. */
export function syntheticEvents(environment, now = Date.now()) {
  const plan = bootstrapPlan(environment, "synthetic");
  if (!/(?:^localhost(?::\d+)?$|\.invalid$)/u.test(plan.domain))
    throw new AnalyticsToolError("SYNTHETIC_DOMAIN_REQUIRED");
  const runId = uuid(requireSetting(environment, "UMAMI_SYNTHETIC_RUN_ID"));
  const events = [];
  for (let day = 1; day >= 0; day--) {
    ["223.5.5.5", "1.12.12.12", "114.114.114.114"].forEach((ip, visitor) => {
      const base =
        Math.floor((now - day * 86400000 - 3600000) / 1000) + visitor * 60;
      const payload = {
        website: plan.websiteId,
        hostname: plan.domain,
        language: "zh-CN",
        url: "/works/synthetic-preview",
        title: "Synthetic analytics acceptance",
        screen: "390x844",
        ip,
        userAgent: browserAgent,
        id: `fixture-${runId.slice(0, 8)}-${visitor}`,
        timestamp: base,
      };
      events.push({ type: "event", payload });
      plan.events.slice(0, 3 - visitor).forEach((name, step) => {
        events.push({
          type: "event",
          payload: {
            ...payload,
            name,
            timestamp: base + step + 1,
            data: {
              synthetic: true,
              run_id: runId,
              target_id: "fixture-work-1",
              card_position: visitor + 1,
              algorithm_version: "synthetic-v1",
            },
          },
        });
      });
    });
  }
  return events;
}

export async function seedSyntheticUmami(environment, options = {}) {
  const plan = bootstrapPlan(environment, "synthetic");
  const events = syntheticEvents(environment, options.now);
  if (!options.execute)
    return {
      ok: true,
      status: "PLAN_ONLY",
      websiteId: plan.websiteId,
      syntheticEvents: events.length,
    };
  const api = createUmamiClient(plan.origin, options.fetchImpl);
  const viewer = await api.login(
    requireSetting(environment, "UMAMI_VIEWER_USERNAME"),
    requireSetting(environment, "UMAMI_VIEWER_PASSWORD"),
  );
  if (viewer.isAdmin || viewer.role !== "view-only")
    throw new AnalyticsToolError("SYNTHETIC_READ_ONLY_VIEWER_REQUIRED");
  const website = await api.request("GET", `/websites/${plan.websiteId}`);
  if (
    website.domain !== plan.domain ||
    website.id !== plan.websiteId ||
    website.shareId
  )
    throw new AnalyticsToolError("SYNTHETIC_WEBSITE_MISMATCH");
  // Native collection is not idempotent. Execute once per fresh disposable DB.
  const result = await api.request("POST", "/batch", events);
  if (result.processed !== events.length || result.errors !== 0)
    throw new AnalyticsToolError("SYNTHETIC_BATCH_INCOMPLETE");
  const until = options.now ?? Date.now();
  const stats = await api.request(
    "GET",
    `/websites/${plan.websiteId}/stats?startAt=${until - 3 * 86400000}&endAt=${until}`,
  );
  if (typeof stats !== "object" || stats === null)
    throw new AnalyticsToolError("SYNTHETIC_STATS_UNAVAILABLE");
  return {
    ok: true,
    status: "SYNTHETIC_SEEDED",
    websiteId: plan.websiteId,
    acceptedEvents: result.processed,
    stats: "NATIVE_READ_VERIFIED",
    idempotent: false,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const { values } = parseArgs({
      options: {
        config: { type: "string" },
        environment: { type: "string" },
        execute: { type: "boolean", default: false },
      },
      allowPositionals: false,
    });
    if (values.environment !== "synthetic")
      throw new AnalyticsToolError("SYNTHETIC_ONLY");
    const environment = await readPrivateConfig(values.config, "synthetic");
    console.info(
      JSON.stringify(
        await seedSyntheticUmami(environment, { execute: values.execute }),
      ),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        ok: false,
        code:
          error instanceof AnalyticsToolError
            ? error.code
            : "UMAMI_SYNTHETIC_SEED_FAILED",
      }),
    );
    process.exitCode = 1;
  }
}
