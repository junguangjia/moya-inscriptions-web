import { request } from "node:https";
import { checkServerIdentity } from "node:tls";
import { validatePublishedOrigin, validatePurgeTarget } from "./keys.js";
import {
  PublicationProviderError,
  assertPublicationSignal,
} from "./provider.js";

/** Fetch one byte at most and never follow a redirect. The optional CNAME is
 * only the TCP destination: Host, SNI and certificate checks stay on the origin.
 */
export function createEdgeWithdrawalVerifier(
  options: {
    readonly origin: string;
    readonly connectHost?: string;
    readonly timeoutMs: number;
  },
  dependencies: { readonly nativeRequest?: typeof request } = {},
): (target: string, signal?: AbortSignal) => Promise<boolean> {
  const origin = validatePublishedOrigin(options.origin);
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > 120_000 ||
    (options.connectHost !== undefined &&
      !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/iu.test(
        options.connectHost,
      ))
  )
    throw new PublicationProviderError("invalid");
  return async (target, signal) => {
    validatePurgeTarget(origin, target, "file");
    assertPublicationSignal(signal);
    const url = new URL(target);
    return new Promise<boolean>((resolve, reject) => {
      let settled = false;
      let outgoing: ReturnType<typeof request> | undefined;
      const finish = (error?: PublicationProviderError, result?: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        signal?.removeEventListener("abort", abort);
        outgoing?.destroy();
        if (error) reject(error);
        else resolve(result ?? false);
      };
      const abort = () =>
        finish(
          new PublicationProviderError(
            signal?.aborted ? "aborted" : "unavailable",
          ),
        );
      const deadline = setTimeout(abort, options.timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      try {
        outgoing = (dependencies.nativeRequest ?? request)(
          {
            protocol: "https:",
            hostname: options.connectHost ?? url.hostname,
            port: 443,
            servername: url.hostname,
            path: url.pathname,
            method: "GET",
            headers: {
              Host: url.host,
              Range: "bytes=0-0",
              "Accept-Encoding": "identity",
            },
            rejectUnauthorized: true,
            checkServerIdentity: (_host, certificate) =>
              checkServerIdentity(url.hostname, certificate),
            agent: false,
          },
          (incoming) => {
            const status = incoming.statusCode ?? 0;
            // Denied/absent status is enough; cancel even a large error body at
            // headers so a bucket diagnostic can never be buffered or emitted.
            if (status === 403 || status === 404) {
              finish(undefined, true);
              incoming.destroy();
              return;
            }
            if (status === 200 || status === 206) {
              finish(undefined, false);
              incoming.destroy();
              return;
            }
            incoming.destroy();
            abort();
          },
        );
        outgoing.on("error", abort);
        outgoing.end();
      } catch {
        abort();
      }
    });
  };
}
