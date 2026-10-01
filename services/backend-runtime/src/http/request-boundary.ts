import type { ServerResponse } from "node:http";

/**
 * Decodes one URL path segment. A malformed percent-encoding is a client
 * error, not a server failure: it yields `undefined`, which the caller refuses
 * the way it refuses any unknown or invalid identifier.
 */
export const decodePathSegment = (segment: string): string | undefined => {
  try {
    return decodeURIComponent(segment);
  } catch (error) {
    if (error instanceof URIError) return undefined;
    throw error;
  }
};

/** The error class and code only: never the request, its body or the error text. */
export const failureLabel = (error: unknown): string => {
  const name = error instanceof Error ? error.name : typeof error;
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "none";
  return `${name}, code ${code}`;
};

/**
 * Route handlers answer their own failures. The router starts each handler
 * without awaiting it, so a handler that still rejects would become an
 * unhandled rejection and stop the whole process. This fails only that
 * request: a bounded error response when nothing was sent yet, a closed
 * connection when the answer had started, and nothing more when it had already
 * ended (a keep-alive connection may be serving the next request). The log line
 * names the error class and code, never the request, its body or the error
 * text.
 */
export const containRequest = (
  response: ServerResponse,
  handling: Promise<unknown>,
  fail: (response: ServerResponse) => void,
): void => {
  handling.catch((error: unknown) => {
    console.error(
      `[backend-runtime] route handler rejected (${failureLabel(error)}); the request failed`,
    );
    if (response.writableEnded) return;
    if (response.headersSent) {
      response.destroy();
      return;
    }
    try {
      fail(response);
    } catch {
      response.destroy();
    }
  });
};
