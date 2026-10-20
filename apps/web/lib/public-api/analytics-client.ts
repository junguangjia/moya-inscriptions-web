import { analyticsBatchResultSchema } from "@moya/contracts/analytics";
import type {
  AnalyticsBatch,
  AnalyticsBatchResult,
} from "@moya/contracts/analytics";

export const sendAnalyticsBatch = async (
  batch: AnalyticsBatch,
): Promise<AnalyticsBatchResult> => {
  const response = await fetch("/api/community/analytics", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(batch),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error("Analytics unavailable");
  return analyticsBatchResultSchema.parse(await response.json());
};

export const beaconAnalyticsBatch = (batch: AnalyticsBatch): boolean => {
  try {
    return navigator.sendBeacon(
      "/api/community/analytics",
      new Blob([JSON.stringify(batch)], { type: "application/json" }),
    );
  } catch {
    return false;
  }
};
