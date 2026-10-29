"use client";

import { analyticsClientHintsSchema } from "@moya/contracts/analytics";
import type { AnalyticsBatch } from "@moya/contracts/analytics";
import {
  beaconAnalyticsBatch,
  sendAnalyticsBatch,
} from "../../lib/public-api/analytics-client";
import {
  ANALYTICS_DISABLED_KEY,
  ANALYTICS_EXCLUDED_COOKIE,
  createAnalyticsRuntime,
  productionAnalyticsAllowed,
} from "./runtime";
import type { AnalyticsInput, AnalyticsRuntime } from "./runtime";

let runtime: AnalyticsRuntime | null = null;
const contexts = new Map<string, Partial<AnalyticsInput>>();
const key = (type: string, id: string) => `${type}:${id}`;

const clientHintValues = (value: unknown): AnalyticsBatch["clientHints"] => {
  if (value === null || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  const selected = Object.fromEntries(
    ["brands", "platform", "platformVersion", "mobile", "model"]
      .filter((field) => source[field] !== undefined)
      .map((field) => [field, source[field]]),
  );
  const result = analyticsClientHintsSchema.safeParse(selected);
  return result.success && Object.keys(result.data).length > 0
    ? result.data
    : undefined;
};

/** Read once without awaiting device hints before the first event or ordinary flush. */
export const createAnalyticsClientHintsReader = (source: unknown) => {
  let current: AnalyticsBatch["clientHints"];
  try {
    const data = (source as { userAgentData?: unknown } | null)?.userAgentData;
    current = clientHintValues(data);
    const method = (data as Record<string, unknown> | undefined)
      ?.getHighEntropyValues;
    if (typeof method === "function")
      void Promise.resolve(method.call(data, ["model", "platformVersion"]))
        .then((value: unknown) => {
          const detailed = clientHintValues(value);
          if (detailed) current = { ...current, ...detailed };
        })
        .catch(() => {
          /* Basic metadata and ordinary collection remain available. */
        });
  } catch {
    /* Missing, blocked or malformed platform APIs are optional. */
  }
  return () => current;
};

export const markAnalyticsExcluded = () => {
  try {
    window.localStorage.setItem(ANALYTICS_DISABLED_KEY, "1");
  } catch {
    /* Cookie still excludes. */
  }
  document.cookie = `${ANALYTICS_EXCLUDED_COOKIE}=1; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
};

export const startAnalytics = (enabled: boolean): AnalyticsRuntime | null => {
  if (
    !productionAnalyticsAllowed(
      enabled,
      process.env.NODE_ENV,
      window.location,
      navigator.webdriver,
    )
  )
    return null;
  try {
    if (
      window.localStorage.getItem(ANALYTICS_DISABLED_KEY) !== null ||
      document.cookie
        .split(";")
        .some((part) => part.trim() === `${ANALYTICS_EXCLUDED_COOKIE}=1`)
    )
      return null;
    const identity = (storage: Storage, name: string) => {
      const previous = storage.getItem(name);
      if (
        previous &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
          previous,
        )
      )
        return previous;
      const next = crypto.randomUUID();
      storage.setItem(name, next);
      return next;
    };
    runtime = createAnalyticsRuntime({
      visitorId: identity(window.localStorage, "moya.analytics.visitor"),
      sessionId: identity(window.sessionStorage, "moya.analytics.session"),
      id: () => crypto.randomUUID(),
      now: () => Date.now(),
      send: sendAnalyticsBatch,
      beacon: beaconAnalyticsBatch,
      onExcluded: markAnalyticsExcluded,
      clientHints: createAnalyticsClientHintsReader(navigator),
      shouldCollect: () => {
        try {
          return window.localStorage.getItem(ANALYTICS_DISABLED_KEY) === null;
        } catch {
          return false;
        }
      },
    });
    return runtime;
  } catch {
    return null;
  }
};

export const stopAnalytics = () => {
  runtime?.stop();
  runtime = null;
  contexts.clear();
};
export const clearAnalyticsQueue = () => {
  runtime?.clear();
  contexts.clear();
};
export const trackAnalytics = (event: AnalyticsInput) => {
  try {
    runtime?.track(event);
  } catch {
    /* Analytics never interrupts a business action. */
  }
};

export const readAnalyticsContext = (
  element: HTMLElement,
): Partial<AnalyticsInput> => {
  const sequence = element.closest<HTMLElement>("[data-analytics-sequence]")
    ?.dataset.analyticsSequence;
  const position = Number(
    element.closest<HTMLElement>("[data-analytics-position]")?.dataset
      .analyticsPosition,
  );
  const search = element.closest<HTMLElement>(
    "[data-analytics-search-request]",
  )?.dataset;
  return {
    ...(Number.isSafeInteger(position) && position > 0 && position <= 10_000
      ? { position }
      : {}),
    ...(sequence ? { sequenceId: sequence } : {}),
    ...(search?.analyticsSearchRequest
      ? { requestId: search.analyticsSearchRequest }
      : {}),
  };
};

export const rememberAnalyticsContent = (
  target: { type: string; id: string },
  opener: HTMLElement,
) => {
  if (!runtime) return;
  const home = opener.closest<HTMLElement>("[data-active-home-feed]")?.dataset
    .activeHomeFeed;
  const surface: AnalyticsInput["surface"] = opener.closest(
    "[data-search-results]",
  )
    ? "search"
    : home === "inscriptions" || home === "calligraphy"
      ? "browse"
      : "home";
  contexts.set(key(target.type, target.id), {
    ...readAnalyticsContext(opener),
    surface,
  });
  if (contexts.size > 100) contexts.delete(contexts.keys().next().value!);
};
export const analyticsContentContext = (target: {
  type: string;
  id: string;
}): Partial<AnalyticsInput> => contexts.get(key(target.type, target.id)) ?? {};

export const trackContentAction = (
  name: "like" | "favorite",
  target: { type: "catalog" | "work"; id: string },
) => {
  if (!runtime) return;
  const card = Array.from(
    document.querySelectorAll<HTMLElement>(
      "article[data-content-id], article[data-catalog-card][data-catalog-id]",
    ),
  ).find(
    (element) =>
      (element.dataset.contentId ?? element.dataset.catalogId) === target.id &&
      !element.closest('[inert], [hidden], [aria-hidden="true"]'),
  );
  trackAnalytics({
    ...analyticsContentContext(target),
    ...(card ? readAnalyticsContext(card) : {}),
    name,
    targetType: target.type,
    targetId: target.id,
    surface: document.querySelector('[data-detail-open="true"]')
      ? "detail"
      : card?.closest("[data-search-results]")
        ? "search"
        : ["inscriptions", "calligraphy"].includes(
              card?.closest<HTMLElement>("[data-active-home-feed]")?.dataset
                .activeHomeFeed ?? "",
            )
          ? "browse"
          : "home",
  });
};
