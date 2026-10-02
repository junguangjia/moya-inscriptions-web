import * as https from "node:https";
import { TLSSocket } from "node:tls";

import COS from "cos-nodejs-sdk-v5";

import type { ClientRequest } from "node:http";
import type { RequestOptions } from "node:https";
import type { Socket } from "node:net";

export type CosSdkClient = Pick<
  COS,
  | "headObject"
  | "getObject"
  | "putObject"
  | "getBucketVersioning"
  | "getObjectUrl"
  | "on"
  | "off"
>;

/** Test seams are never selected by environment or production configuration. */
export interface CosSdkDependencies {
  readonly sdkFactory?: (options: COS.COSOptions) => CosSdkClient;
  readonly nativeRequest?: typeof https.request;
}

export interface CosSdkResponse {
  readonly statusCode: number;
  /** Raw bytes are required because the SDK defaults missing versioning XML to {}. */
  readonly body: Buffer;
}

const requestFailure = () =>
  new Error("COS request failed; verify state before retrying");

/** Tencent owns signing and all five COS APIs. The transport hook preserves the
 * Pilot's stricter byte/deadline bounds, TLS verification and single attempt.
 * SDK v3.0.0 base.js otherwise retries basic requests up to four times.
 */
export const createCosSdk = (
  options: {
    readonly secretId: string;
    readonly secretKey: string;
    readonly startsAt: number;
    readonly expiresAt: number;
    readonly timeoutMs: number;
    /** Only publishing multipart body uploads may progress beyond a total deadline. */
    readonly timeoutMode?: "upload-idle";
  },
  dependencies: CosSdkDependencies = {},
) => {
  let authorized = false;
  const client = (dependencies.sdkFactory ?? ((config) => new COS(config)))({
    Protocol: "https:",
    StrictSsl: true,
    FollowRedirect: false,
    AutoSwitchHost: false,
    CorrectClockSkew: false,
    KeepAlive: false,
    Timeout: options.timeoutMs,
    ChunkRetryTimes: 0,
    ForceSignHost: true,
    getAuthorization: (request, callback) => {
      // No network retries or hidden credential refresh after an ambiguous write.
      if (authorized) return callback("retry-disabled");
      authorized = true;
      callback(
        COS.getAuthorization({
          SecretId: options.secretId,
          SecretKey: options.secretKey,
          Method: request.Method,
          Pathname: request.Pathname,
          Headers: request.Headers,
          Query: request.Query,
          KeyTime: `${options.startsAt};${options.expiresAt}`,
        }),
      );
    },
  });

  return {
    client,
    request: (
      maxResponseBytes: number,
      invoke: (
        callback: (error: COS.CosError, data?: COS.GeneralResult) => void,
      ) => void,
      signal?: AbortSignal,
    ): Promise<CosSdkResponse> =>
      new Promise((resolve, reject) => {
        let settled = false;
        let outgoing: ClientRequest | undefined;
        let socket: Socket | undefined;
        let responseDeadline: ReturnType<typeof setTimeout> | undefined;
        let received = 0;
        const chunks: Buffer[] = [];
        const connected = () => {
          if (socket instanceof TLSSocket && !socket.authorized) {
            finish(requestFailure());
            return;
          }
          clearTimeout(deadline);
        };
        const finish = (error?: Error, statusCode?: number) => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          clearTimeout(responseDeadline);
          socket?.removeListener("connect", connected);
          socket?.removeListener("secureConnect", connected);
          signal?.removeEventListener("abort", onAbort);
          client.off("before-send", beforeSend);
          if (error) {
            reject(requestFailure());
            outgoing?.destroy();
          } else {
            resolve({
              statusCode: statusCode ?? 0,
              body: Buffer.concat(chunks),
            });
          }
        };
        const startResponseDeadline = () => {
          if (settled || responseDeadline !== undefined) return;
          // Start at the first flushed upload or early final response. Headers,
          // body bytes and a later upload finish must never renew this bound.
          responseDeadline = setTimeout(
            () => finish(requestFailure()),
            options.timeoutMs,
          );
        };
        const nativeRequest = ((requestOptions: RequestOptions) => {
          if (outgoing || settled) throw requestFailure();
          outgoing = (dependencies.nativeRequest ?? https.request)({
            ...requestOptions,
            rejectUnauthorized: true,
          });
          outgoing.on("error", () => finish(requestFailure()));
          if (options.timeoutMode === "upload-idle") {
            outgoing.on("socket", (assigned) => {
              socket = assigned;
              // The finite setup timer includes DNS/TCP and TLS. Plain sockets
              // occur only through the native loopback test seam.
              if (assigned instanceof TLSSocket) {
                // A verified pooled socket emits no second secureConnect.
                if (assigned.authorized) connected();
                else assigned.once("secureConnect", connected);
              } else if (assigned.connecting)
                assigned.once("connect", connected);
              else connected();
            });
            // Keep the SDK's native socket inactivity timeout. Node observes
            // pending native write-queue progress even for one buffered part;
            // SDK onProgress/body consumption does not establish that progress.
            outgoing.on("timeout", () => finish(requestFailure()));
            outgoing.on("finish", startResponseDeadline);
          }
          outgoing.on("response", (incoming) => {
            if (options.timeoutMode === "upload-idle") startResponseDeadline();
            incoming.on("error", () => finish(requestFailure()));
            incoming.on("aborted", () => finish(requestFailure()));
            const emit = incoming.emit;
            // Observe before cos-request sees a chunk: its listeners would
            // otherwise still buffer an oversized chunk during the same emit.
            // Also contain SDK parser exceptions on malformed remote XML.
            incoming.emit = (
              event: string | symbol,
              ...arguments_: unknown[]
            ): boolean => {
              if (event === "data") {
                const chunk: unknown = arguments_[0];
                if (
                  !Buffer.isBuffer(chunk) ||
                  received + chunk.length > maxResponseBytes
                ) {
                  finish(requestFailure());
                  incoming.destroy();
                  return false;
                }
                received += chunk.length;
                chunks.push(chunk);
              }
              try {
                return emit.call(incoming, event, ...arguments_);
              } catch {
                finish(requestFailure());
                incoming.destroy();
                return false;
              }
            };
          });
          return outgoing;
        }) as typeof https.request;
        const beforeSend = (requestOptions: Record<string, unknown>) => {
          // cos-request supports httpModules. Keep the real SDK request path,
          // observing native HTTPS before its response is buffered or parsed.
          requestOptions.httpModules = {
            "https:": { ...https, request: nativeRequest },
          };
          requestOptions.proxy = null;
          requestOptions.gzip = false;
          requestOptions.strictSSL = true;
          requestOptions.followRedirect = false;
          requestOptions.followAllRedirects = false;
        };
        const deadline = setTimeout(
          () => finish(requestFailure()),
          options.timeoutMs,
        );
        const onAbort = () => finish(requestFailure());
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) {
          finish(requestFailure());
          return;
        }
        client.on("before-send", beforeSend);
        try {
          invoke((error, data) => {
            const statusCode = error?.statusCode ?? data?.statusCode;
            // Only explicit HTTP responses establish absence/conflict. Transport
            // errors and SDK retry/auth errors must never be treated as absence.
            if (!statusCode) finish(requestFailure());
            else finish(undefined, statusCode);
          });
        } catch {
          finish(requestFailure());
        }
      }),
  };
};

// Compatibility for the guarded Pilot uploader; shared reads use provider names.
export type PilotCosSdkClient = CosSdkClient;
export type PilotCosSdkDependencies = CosSdkDependencies;
export const createPilotCosSdk = createCosSdk;
