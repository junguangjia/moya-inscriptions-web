import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import {
  createPublishingCosTransport,
  PublishingCosResponseError,
} from "../storage/publishing-cos-transport.js";
import { allowsPublication, hasPublicationProviderConfig } from "./config.js";
import { createEdgeWithdrawalVerifier } from "./edge-verify.js";
import {
  validatePublishedKey,
  validatePublishedOrigin,
  validatePublishedUnit,
  validatePurgeTarget,
} from "./keys.js";
import {
  MONTHLY_REQUEST_WARNING,
  PUBLICATION_CACHE_CONTROL,
  PublicationProviderError,
  assertPublicationSignal,
  publicationPlanMonth,
} from "./provider.js";
import {
  createPublisherRoleCredentials,
  createTencentPublicationApi,
} from "./tencent-api.js";

import type COS from "cos-nodejs-sdk-v5";
import type { CosCredentials } from "../storage/cos-read.js";
import type { PublishingCosTransport } from "../storage/publishing-cos-transport.js";
import type { PublicationConfig } from "./config.js";
import type {
  PublicationProvider,
  PublishedObjectEvidence,
} from "./provider.js";
import type { TencentPublicationApi } from "./tencent-api.js";

export interface TencentPublicationProviderDependencies {
  /** Synthetic server-only seams. Environment cannot replace these. */
  readonly cosTransport?: PublishingCosTransport;
  readonly api?: TencentPublicationApi;
  readonly verifyGone?: (
    target: string,
    signal?: AbortSignal,
  ) => Promise<boolean>;
}
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const header = (
  response: COS.GeneralResult,
  name: string,
): string | undefined => {
  const headers: unknown = response.headers;
  if (!object(headers)) return undefined;
  const entry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name,
  )?.[1];
  return typeof entry === "string" ? entry : undefined;
};
const etag = (value: string | undefined): string | undefined =>
  value && /^"?[0-9a-f]{32}"?$/iu.test(value)
    ? value.replaceAll('"', "").toLowerCase()
    : undefined;
const evidence = (response: COS.GeneralResult): PublishedObjectEvidence => {
  const size = header(response, "content-length");
  const byteSize =
    size && /^[1-9][0-9]{0,15}$/u.test(size) ? Number(size) : NaN;
  const checksum = etag(header(response, "etag"));
  const crc64 = header(response, "x-cos-hash-crc64ecma");
  if (
    !Number.isSafeInteger(byteSize) ||
    !checksum ||
    (crc64 !== undefined && !/^[0-9]{1,20}$/u.test(crc64))
  )
    throw new PublicationProviderError("integrity");
  return { byteSize, etag: checksum, ...(crc64 ? { crc64 } : {}) };
};

/** Dedicated published-bucket identity; no listing, versioning or private read.
 * Every upload is one immutable streaming PUT, whose MD5 is verified by HEAD.
 */
export function createTencentPublicationProvider(
  config: PublicationConfig,
  options: {
    readonly credentials: () => Promise<CosCredentials>;
    readonly timeoutMs?: number;
    readonly now?: () => number;
  },
  dependencies: TencentPublicationProviderDependencies = {},
): PublicationProvider {
  if (
    !hasPublicationProviderConfig(config) ||
    !config.bucket ||
    !config.region ||
    !config.roleArn ||
    !config.zoneId ||
    !config.origin
  )
    throw new PublicationProviderError("invalid");
  const origin = validatePublishedOrigin(config.origin);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const now = options.now ?? Date.now;
  const api =
    dependencies.api ??
    createTencentPublicationApi({ region: config.region, timeoutMs }, { now });
  const publisherCredentials = createPublisherRoleCredentials({
    roleArn: config.roleArn,
    ugcCredentials: options.credentials,
    api,
    now,
  });
  const transport =
    dependencies.cosTransport ??
    createPublishingCosTransport({
      credentials: publisherCredentials,
      requestTimeoutMs: timeoutMs,
    });
  const verifyGone =
    dependencies.verifyGone ??
    createEdgeWithdrawalVerifier({
      origin,
      timeoutMs,
      ...(config.verifyConnectHost
        ? { connectHost: config.verifyConnectHost }
        : {}),
    });
  const parameters = { Bucket: config.bucket, Region: config.region };
  const guarded = async <T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> => {
    assertPublicationSignal(signal);
    try {
      return await operation();
    } catch (error) {
      if (signal?.aborted) throw new PublicationProviderError("aborted");
      if (error instanceof PublicationProviderError) throw error;
      throw new PublicationProviderError("unavailable");
    }
  };
  const head: PublicationProvider["head"] = async (objectKey, signal) => {
    validatePublishedKey(objectKey);
    return guarded(async () => {
      try {
        return evidence(
          await transport.request(
            "headObject",
            { ...parameters, Key: objectKey },
            signal,
          ),
        );
      } catch (error) {
        if (
          error instanceof PublishingCosResponseError &&
          error.statusCode === 404
        )
          return undefined;
        throw error;
      }
    }, signal);
  };
  return {
    head,
    async write(unit, source, signal) {
      // The A gate precedes private stream iteration, STS and every public I/O.
      if (!allowsPublication(config))
        throw new PublicationProviderError("disabled");
      validatePublishedUnit(unit);
      return guarded(async () => {
        const md5 = createHash("md5");
        let bytes = 0;
        let completed = false;
        const stream = Readable.from(
          (async function* () {
            for await (const chunk of source) {
              assertPublicationSignal(signal);
              if (
                !(chunk instanceof Uint8Array) ||
                (bytes += chunk.byteLength) > unit.byteSize
              )
                throw new PublicationProviderError("integrity");
              md5.update(chunk);
              yield chunk;
            }
            if (bytes !== unit.byteSize)
              throw new PublicationProviderError("integrity");
            completed = true;
          })(),
        );
        // The SDK owns consumption; contain any source error while it tears
        // down its one native request. No retry or multipart permissions.
        let streamError: Error | undefined;
        stream.on("error", (error: Error) => {
          streamError = error;
        });
        try {
          const uploaded = await transport.request<COS.PutObjectResult>(
            "putObject",
            {
              ...parameters,
              Key: unit.objectKey,
              Body: stream,
              ContentLength: unit.byteSize,
              ContentType: unit.contentType,
              CacheControl: PUBLICATION_CACHE_CONTROL,
              Headers: { "x-cos-forbid-overwrite": "true" },
            },
            signal,
          );
          if (!completed || streamError)
            throw new PublicationProviderError("integrity");
          const expected = md5.digest("hex");
          if (etag(uploaded.ETag) !== expected)
            throw new PublicationProviderError("integrity");
          const actual = await head(unit.objectKey, signal);
          if (
            !actual ||
            actual.byteSize !== unit.byteSize ||
            actual.etag !== expected
          )
            throw new PublicationProviderError("integrity");
          return actual;
        } finally {
          stream.destroy();
        }
      }, signal);
    },
    async remove(objectKey, signal) {
      validatePublishedKey(objectKey);
      return guarded(async () => {
        try {
          await transport.request(
            "deleteObject",
            { ...parameters, Key: objectKey },
            signal,
          );
        } catch (error) {
          if (
            error instanceof PublishingCosResponseError &&
            error.statusCode === 404
          )
            return;
          throw error;
        }
      }, signal);
    },
    async purge(targets, type, signal) {
      if (
        !targets.length ||
        targets.length > 100 ||
        new Set(targets).size !== targets.length
      )
        throw new PublicationProviderError("invalid");
      for (const target of targets) validatePurgeTarget(origin, target, type);
      return guarded(async () => {
        const result = await api.call(
          "CreatePurgeTask",
          {
            ZoneId: config.zoneId,
            Type: type === "file" ? "purge_url" : "purge_prefix",
            Targets: targets,
            ...(type === "prefix" ? { Method: "delete" } : {}),
          },
          publisherCredentials,
          signal,
        );
        if (
          typeof result.JobId !== "string" ||
          !/^[A-Za-z0-9_-]{1,128}$/u.test(result.JobId) ||
          (result.FailedList !== undefined &&
            result.FailedList !== null &&
            (!Array.isArray(result.FailedList) || result.FailedList.length > 0))
        )
          throw new PublicationProviderError("unavailable");
        return result.JobId;
      }, signal);
    },
    async purgeStatus(jobId, signal) {
      if (!/^[A-Za-z0-9_-]{1,128}$/u.test(jobId))
        throw new PublicationProviderError("invalid");
      return guarded(async () => {
        const response = await api.call(
          "DescribePurgeTasks",
          {
            ZoneId: config.zoneId,
            Limit: 1000,
            Filters: [{ Name: "job-id", Values: [jobId], Fuzzy: false }],
          },
          publisherCredentials,
          signal,
        );
        if (
          !Array.isArray(response.Tasks) ||
          !Number.isSafeInteger(response.TotalCount) ||
          Number(response.TotalCount) !== response.Tasks.length
        )
          throw new PublicationProviderError("unavailable");
        if (!response.Tasks.length) return "pending";
        let pending = false;
        for (const task of response.Tasks) {
          if (
            !object(task) ||
            task.JobId !== jobId ||
            typeof task.Target !== "string"
          )
            throw new PublicationProviderError("unavailable");
          validatePurgeTarget(
            origin,
            task.Target,
            task.Type === "purge_prefix" ? "prefix" : "file",
          );
          if (["failed", "timeout", "canceled"].includes(String(task.Status)))
            return "failed";
          if (task.Status === "processing") pending = true;
          else if (task.Status !== "success")
            throw new PublicationProviderError("unavailable");
        }
        return pending ? "pending" : "succeeded";
      }, signal);
    },
    async verifyGone(target, signal) {
      validatePurgeTarget(origin, target, "file");
      return guarded(() => verifyGone(target, signal), signal);
    },
    async monthlyRequests(at, signal) {
      const start = publicationPlanMonth(at);
      return guarded(async () => {
        const response = await api.call(
          "DescribeTimingL7AnalysisData",
          {
            ZoneIds: [config.zoneId],
            StartTime: start.toISOString(),
            EndTime: at.toISOString(),
            Interval: "day",
            MetricNames: ["l7Flow_request"],
            Filters: [
              {
                Key: "domain",
                Operator: "equals",
                Value: [new URL(origin).hostname],
              },
            ],
          },
          publisherCredentials,
          signal,
        );
        if (
          !Array.isArray(response.Data) ||
          !Number.isSafeInteger(response.TotalCount) ||
          Number(response.TotalCount) !== response.Data.length
        )
          throw new PublicationProviderError("unavailable");
        let requests = 0;
        for (const row of response.Data) {
          if (!object(row) || !Array.isArray(row.TypeValue))
            throw new PublicationProviderError("unavailable");
          for (const metric of row.TypeValue) {
            if (
              !object(metric) ||
              metric.MetricName !== "l7Flow_request" ||
              typeof metric.Sum !== "number" ||
              !Number.isSafeInteger(metric.Sum) ||
              metric.Sum < 0
            )
              throw new PublicationProviderError("unavailable");
            requests += metric.Sum;
          }
        }
        if (!Number.isSafeInteger(requests))
          throw new PublicationProviderError("unavailable");
        return {
          start,
          end: at,
          requests,
          warning: requests >= MONTHLY_REQUEST_WARNING,
        };
      }, signal);
    },
  };
}
