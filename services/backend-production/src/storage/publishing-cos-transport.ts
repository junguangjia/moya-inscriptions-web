import COS from "cos-nodejs-sdk-v5";

import { createCosSdk } from "./cos-sdk.js";
import { PublishingMediaStoreError } from "./publishing-media-error.js";

import type { CosCredentials } from "./cos-read.js";
import type { CosSdkDependencies } from "./cos-sdk.js";

export type PublishingCosMethod =
  | "getBucketVersioning"
  | "headObject"
  | "putObject"
  | "getObject"
  | "deleteObject"
  | "getBucket"
  | "multipartInit"
  | "multipartUpload"
  | "multipartComplete"
  | "multipartAbort"
  | "multipartList"
  | "multipartListPart";

export type PublishingCosResult = COS.GeneralResult;
export type PublishingCosPutResult = COS.PutObjectResult;

/** Server-only deterministic I/O seam. Never selected from environment. */
export interface PublishingCosTransport {
  request<T extends COS.GeneralResult>(
    method: PublishingCosMethod,
    parameters: Record<string, unknown>,
    signal?: AbortSignal,
    maxResponseBytes?: number,
  ): Promise<T & { readonly rawBody: Buffer }>;
}

export class PublishingCosResponseError extends PublishingMediaStoreError {
  constructor(readonly statusCode: number) {
    super("unavailable");
  }
}

/** Reuses the official SDK signer and bounded, single-attempt HTTPS transport.
 * Each operation has its own SDK instance: cancellation cannot affect another
 * request. SDK error bodies, URLs and authorization never escape this seam.
 */
export function createPublishingCosTransport(
  options: {
    readonly credentials: () => Promise<CosCredentials>;
    readonly requestTimeoutMs: number;
  },
  dependencies: CosSdkDependencies = {},
): PublishingCosTransport {
  return {
    async request<T extends COS.GeneralResult>(
      method: PublishingCosMethod,
      parameters: Record<string, unknown>,
      signal?: AbortSignal,
      maxResponseBytes = 2 * 1024 * 1024,
    ) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) controller.abort();
      const deadline = setTimeout(abort, options.requestTimeoutMs);
      try {
        const credentials = await new Promise<CosCredentials>(
          (resolve, reject) => {
            const failed = () =>
              reject(new PublishingMediaStoreError("unavailable"));
            if (controller.signal.aborted) return failed();
            controller.signal.addEventListener("abort", failed, { once: true });
            void Promise.resolve()
              .then(options.credentials)
              .then(resolve, failed)
              .finally(() =>
                controller.signal.removeEventListener("abort", failed),
              );
          },
        );
        // Credential acquisition remains bounded. Multipart body transmission
        // uses the SDK's socket inactivity bound plus setup/response deadlines;
        // it must not be cancelled merely because a part is still progressing.
        if (method === "multipartUpload") clearTimeout(deadline);
        const now = Math.floor(Date.now() / 1000);
        const expiresAt = Math.min(
          now + 300,
          credentials.expiresAt ?? Infinity,
        );
        if (
          !/^[A-Za-z0-9_-]+$/.test(credentials.secretId) ||
          !credentials.secretKey ||
          /[\r\n]/.test(credentials.secretKey) ||
          !Number.isSafeInteger(expiresAt) ||
          expiresAt - now < 30 ||
          (credentials.expiresAt !== undefined &&
            !Number.isSafeInteger(credentials.expiresAt)) ||
          (credentials.securityToken !== undefined &&
            (!credentials.securityToken ||
              /[\r\n]/.test(credentials.securityToken) ||
              credentials.expiresAt === undefined))
        )
          throw new PublishingMediaStoreError("unavailable");
        const sdk = createCosSdk(
          {
            secretId: credentials.secretId,
            secretKey: credentials.secretKey,
            startsAt: now,
            expiresAt,
            timeoutMs: options.requestTimeoutMs,
            ...(method === "multipartUpload"
              ? { timeoutMode: "upload-idle" as const }
              : {}),
          },
          dependencies,
        );
        // createCosSdk constructs the full official COS instance. Its public
        // narrowed type exists for the Catalog reader's smaller test seam.
        const client = sdk.client as COS;
        let parsed: T | undefined;
        let sdkFailed = false;
        const response = await sdk.request(
          maxResponseBytes,
          (callback) => {
            const invoke = client[method] as unknown as (
              input: Record<string, unknown>,
              callback: (error: COS.CosError, data?: T) => void,
            ) => void;
            invoke.call(
              client,
              {
                ...parameters,
                Headers: {
                  ...(parameters.Headers as Record<string, string> | undefined),
                  ...(credentials.securityToken
                    ? { "x-cos-security-token": credentials.securityToken }
                    : {}),
                },
              },
              (error, data) => {
                parsed = data;
                sdkFailed = Boolean(error);
                callback(error, data);
              },
            );
          },
          controller.signal,
        );
        if (
          sdkFailed ||
          response.statusCode < 200 ||
          response.statusCode >= 300 ||
          !parsed
        ) {
          throw new PublishingCosResponseError(response.statusCode);
        }
        return { ...parsed, rawBody: response.body };
      } catch (error) {
        if (signal?.aborted) throw new PublishingMediaStoreError("aborted");
        if (error instanceof PublishingMediaStoreError) throw error;
        throw new PublishingMediaStoreError("unavailable");
      } finally {
        clearTimeout(deadline);
        signal?.removeEventListener("abort", abort);
      }
    },
  };
}
