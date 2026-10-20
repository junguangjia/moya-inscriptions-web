/** Exclusion only: this marker never grants a role or authenticates a request. */
export const excludeOwnerAnalyticsDevice = async (
  signal: AbortSignal,
): Promise<boolean> => {
  try {
    localStorage.setItem("moya.analytics.disabled", "1");
  } catch {
    // HttpOnly cookie and Backend immutable-account rules still apply.
  }
  try {
    const response = await fetch("/api/analytics/exclude-device", {
      method: "POST",
      credentials: "same-origin",
      signal,
    });
    return response.ok;
  } catch {
    return false;
  }
};
