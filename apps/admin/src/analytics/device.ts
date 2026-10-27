let exclusion: Promise<boolean> | undefined;
/** Exclusion only: this marker never grants a role or authenticates a request.
 * One bounded attempt per document, shared by the shell and analytics entry.
 */
export const excludeOwnerAnalyticsDevice = async (
  signal: AbortSignal,
): Promise<boolean> => {
  try {
    localStorage.setItem("moya.analytics.disabled", "1");
  } catch {
    // HttpOnly cookie and Backend immutable-account rules still apply.
  }
  exclusion ??= (async () => {
    try {
      const response = await fetch("/api/analytics/exclude-device", {
        method: "POST",
        credentials: "same-origin",
        signal: AbortSignal.timeout(1_500),
      });
      return response.ok;
    } catch {
      return false;
    }
  })();
  if (signal.aborted) return false;
  return exclusion;
};
