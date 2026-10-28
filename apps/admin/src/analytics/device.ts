let exclusion: Promise<boolean> | undefined;
let confirmed = false;
/** Exclusion only: this marker never grants a role or authenticates a request.
 * Concurrent callers share a bounded attempt; only success is remembered.
 */
export const excludeOwnerAnalyticsDevice = async (
  signal: AbortSignal,
): Promise<boolean> => {
  if (signal.aborted) return false;
  try {
    localStorage.setItem("moya.analytics.disabled", "1");
  } catch {
    /* HttpOnly cookie and immutable-account rules still apply. */
  }
  if (confirmed) return true;
  exclusion ??= (async () => {
    try {
      const response = await fetch("/api/analytics/exclude-device", {
        method: "POST",
        credentials: "same-origin",
        signal: AbortSignal.timeout(1_500),
      });
      confirmed = response.ok;
      return confirmed;
    } catch {
      return false;
    }
  })().finally(() => {
    exclusion = undefined;
  });
  return exclusion;
};

/** At most one fresh retry before the analytics document boundary (3s total). */
export const prepareOwnerAnalyticsEntry = async (
  signal: AbortSignal,
): Promise<boolean> => {
  if (await excludeOwnerAnalyticsDevice(signal)) return true;
  return signal.aborted ? false : excludeOwnerAnalyticsDevice(signal);
};
