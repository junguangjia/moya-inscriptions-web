import { createHash, createHmac } from "node:crypto";
import { request } from "node:https";

import {
  PublicationProviderError,
  assertPublicationSignal,
} from "./provider.js";
import type { CosCredentials } from "../storage/cos-read.js";

type TencentApiAction =
  | "AssumeRole"
  | "CreatePurgeTask"
  | "DescribePurgeTasks"
  | "DescribeTimingL7AnalysisData";
export interface TencentPublicationApi {
  call(
    action: TencentApiAction,
    input: Readonly<Record<string, unknown>>,
    credentials: () => Promise<CosCredentials>,
    signal?: AbortSignal,
  ): Promise<Readonly<Record<string, unknown>>>;
}
export interface TencentApiDependencies {
  /** Deterministic server-only test seam; never configured through environment. */
  readonly nativeRequest?: typeof request;
  readonly now?: () => number;
}

const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const mac = (key: string | Buffer, value: string): Buffer =>
  createHmac("sha256", key).update(value).digest();
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Official Tencent API v3 signer. The action ceiling is fixed to this task.
 * https://cloud.tencent.com/document/api/213/30654
 * One request, verified TLS, bounded body/deadline, no redirects or diagnostics.
 */
export function createTencentPublicationApi(
  options: { readonly region: string; readonly timeoutMs: number },
  dependencies: TencentApiDependencies = {},
): TencentPublicationApi {
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > 120_000 ||
    !/^[a-z]{2}-[a-z]+(?:-[a-z]+)?$/u.test(options.region)
  )
    throw new PublicationProviderError("invalid");
  return {
    async call(action, input, credentials, signal) {
      if (
        ![
          "AssumeRole",
          "CreatePurgeTask",
          "DescribePurgeTasks",
          "DescribeTimingL7AnalysisData",
        ].includes(action)
      )
        throw new PublicationProviderError("invalid");
      assertPublicationSignal(signal);
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      const deadline = setTimeout(abort, options.timeoutMs);
      try {
        const identity = await new Promise<CosCredentials>(
          (resolve, reject) => {
            const failed = () =>
              reject(
                new PublicationProviderError(
                  signal?.aborted ? "aborted" : "unavailable",
                ),
              );
            controller.signal.addEventListener("abort", failed, { once: true });
            if (controller.signal.aborted) return failed();
            void Promise.resolve()
              .then(credentials)
              .then(resolve, failed)
              .finally(() =>
                controller.signal.removeEventListener("abort", failed),
              );
          },
        );
        const timestamp = Math.floor((dependencies.now ?? Date.now)() / 1000);
        if (
          !Number.isSafeInteger(timestamp) ||
          timestamp < 0 ||
          !/^[A-Za-z0-9_-]+$/u.test(identity.secretId) ||
          !identity.secretKey ||
          /[\r\n]/u.test(identity.secretKey) ||
          (identity.securityToken !== undefined &&
            (!identity.securityToken ||
              /[\r\n]/u.test(identity.securityToken) ||
              identity.expiresAt === undefined)) ||
          (identity.expiresAt !== undefined &&
            (!Number.isSafeInteger(identity.expiresAt) ||
              identity.expiresAt < timestamp + 30))
        )
          throw new PublicationProviderError("unavailable");
        const service = action === "AssumeRole" ? "sts" : "teo";
        const host = `${service}.tencentcloudapi.com`;
        const body = JSON.stringify(input);
        if (Buffer.byteLength(body) > 65_536)
          throw new PublicationProviderError("invalid");
        const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
        const scope = `${date}/${service}/tc3_request`;
        const signedHeaders = "content-type;host";
        const canonicalRequest = `POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:${host}\n\n${signedHeaders}\n${hash(body)}`;
        const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${hash(canonicalRequest)}`;
        const signingKey = mac(
          mac(mac(`TC3${identity.secretKey}`, date), service),
          "tc3_request",
        );
        const authorization = `TC3-HMAC-SHA256 Credential=${identity.secretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${mac(signingKey, stringToSign).toString("hex")}`;
        const response = await new Promise<Record<string, unknown>>(
          (resolve, reject) => {
            let settled = false;
            let outgoing: ReturnType<typeof request> | undefined;
            const failed = () =>
              finish(
                new PublicationProviderError(
                  signal?.aborted ? "aborted" : "unavailable",
                ),
              );
            const finish = (
              error?: PublicationProviderError,
              result?: Record<string, unknown>,
            ) => {
              if (settled) return;
              settled = true;
              controller.signal.removeEventListener("abort", failed);
              if (error) {
                outgoing?.destroy();
                reject(error);
              } else if (result) resolve(result);
            };
            controller.signal.addEventListener("abort", failed, { once: true });
            if (controller.signal.aborted) return failed();
            try {
              outgoing = (dependencies.nativeRequest ?? request)(
                {
                  protocol: "https:",
                  hostname: host,
                  port: 443,
                  method: "POST",
                  path: "/",
                  agent: false,
                  rejectUnauthorized: true,
                  headers: {
                    "Content-Type": "application/json; charset=utf-8",
                    "Content-Length": Buffer.byteLength(body),
                    Host: host,
                    Authorization: authorization,
                    "X-TC-Action": action,
                    "X-TC-Version":
                      service === "sts" ? "2018-08-13" : "2022-09-01",
                    "X-TC-Timestamp": String(timestamp),
                    ...(service === "sts"
                      ? { "X-TC-Region": options.region }
                      : {}),
                    ...(identity.securityToken
                      ? { "X-TC-Token": identity.securityToken }
                      : {}),
                  },
                },
                (incoming) => {
                  let used = 0;
                  const chunks: Buffer[] = [];
                  incoming.on("error", failed);
                  incoming.on("aborted", failed);
                  incoming.on("data", (chunk: Buffer) => {
                    if (
                      !Buffer.isBuffer(chunk) ||
                      (used += chunk.length) > 1024 * 1024
                    ) {
                      incoming.destroy();
                      failed();
                      return;
                    }
                    chunks.push(chunk);
                  });
                  incoming.on("end", () => {
                    if (incoming.statusCode !== 200) return failed();
                    let parsed: unknown;
                    try {
                      parsed = JSON.parse(
                        new TextDecoder("utf-8", { fatal: true }).decode(
                          Buffer.concat(chunks),
                        ),
                      );
                    } catch {
                      return failed();
                    }
                    if (!record(parsed) || !record(parsed.Response))
                      return failed();
                    if (parsed.Response.Error !== undefined) {
                      const remote = parsed.Response.Error;
                      // Only the category crosses the boundary; API diagnostic text,
                      // response bodies and signed headers never enter errors/logs.
                      finish(
                        new PublicationProviderError(
                          record(remote) &&
                            remote.Code === "LimitExceeded.DailyQuota"
                            ? "quota"
                            : "unavailable",
                        ),
                      );
                    } else finish(undefined, parsed.Response);
                  });
                },
              );
              outgoing.on("error", failed);
              outgoing.end(body);
            } catch {
              failed();
            }
          },
        );
        return response;
      } catch (error) {
        if (signal?.aborted) throw new PublicationProviderError("aborted");
        if (error instanceof PublicationProviderError) throw error;
        throw new PublicationProviderError("unavailable");
      } finally {
        clearTimeout(deadline);
        signal?.removeEventListener("abort", abort);
      }
    },
  };
}

/** Lazy refresh: construction and Closed Beta publication refusal read no keys. */
export function createPublisherRoleCredentials(options: {
  readonly roleArn: string;
  readonly ugcCredentials: () => Promise<CosCredentials>;
  readonly api: TencentPublicationApi;
  readonly now?: () => number;
}): () => Promise<CosCredentials> {
  if (
    !/^qcs::cam::uin\/[0-9]{5,20}:role(?:Name)?\/[A-Za-z0-9_-]{1,128}$/u.test(
      options.roleArn,
    )
  )
    throw new PublicationProviderError("invalid");
  let cached: CosCredentials | undefined;
  let acquiring: Promise<CosCredentials> | undefined;
  return async () => {
    const now = Math.floor((options.now ?? Date.now)() / 1000);
    // Publication PUT hard total <=240 s, plus30 s validity margin. Refresh
    // before entering that window; never repeatedly hand a caller a token
    // that is still live but too short for the bounded publication request.
    if (cached?.expiresAt !== undefined && cached.expiresAt > now + 300)
      return cached;
    if (acquiring) return acquiring;
    acquiring = (async () => {
      const response = await options.api.call(
        "AssumeRole",
        {
          RoleArn: options.roleArn,
          RoleSessionName: "media-publication-v1",
          DurationSeconds: 3600,
        },
        options.ugcCredentials,
      );
      const value = response.Credentials;
      const expiresAt = response.ExpiredTime;
      if (
        !record(value) ||
        typeof value.TmpSecretId !== "string" ||
        !/^[A-Za-z0-9_-]+$/u.test(value.TmpSecretId) ||
        typeof value.TmpSecretKey !== "string" ||
        !value.TmpSecretKey ||
        /[\r\n]/u.test(value.TmpSecretKey) ||
        typeof value.Token !== "string" ||
        !value.Token ||
        /[\r\n]/u.test(value.Token) ||
        typeof expiresAt !== "number" ||
        !Number.isSafeInteger(expiresAt) ||
        expiresAt <= now + 300 ||
        expiresAt > now + 3660
      )
        throw new PublicationProviderError("unavailable");
      return (cached = {
        secretId: value.TmpSecretId,
        secretKey: value.TmpSecretKey,
        securityToken: value.Token,
        expiresAt,
      });
    })();
    try {
      return await acquiring;
    } finally {
      acquiring = undefined;
    }
  };
}
