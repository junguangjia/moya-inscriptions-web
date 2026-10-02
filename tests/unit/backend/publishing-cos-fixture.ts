import { createHash } from "node:crypto";

import {
  CosPublishingMediaStore,
  PublishingCosResponseError,
} from "@moya/backend-production/internal/publishing-media-store";

import type {
  PublishingCosMethod,
  PublishingCosTransport,
} from "@moya/backend-production/internal/publishing-media-store";

export const cosOptions = {
  bucket: "synthetic-media-1250000000",
  region: "ap-guangzhou",
  prefix: "ugc/publishing/synthetic/",
};
type ObjectValue = {
  bytes: Buffer;
  headers: Record<string, string>;
  modified: Date;
};
type Upload = {
  Key: string;
  UploadId: string;
  Initiated: string;
  headers: Record<string, string>;
  parts: Buffer[];
  modified: Date;
};

/** Offline object-service seam, not evidence of Tencent acceptance. */
export function cosFixture() {
  const objects = new Map<string, ObjectValue>();
  const uploads = new Map<string, Upload>();
  const calls: {
    method: PublishingCosMethod;
    input: Record<string, unknown>;
  }[] = [];
  let sequence = 0;
  const state = {
    versioning: "<VersioningConfiguration/>",
    before: undefined as
      | undefined
      | ((
          method: PublishingCosMethod,
          input: Record<string, unknown>,
          signal?: AbortSignal,
        ) => Promise<void>),
    after: undefined as
      | undefined
      | ((method: PublishingCosMethod, value: Record<string, unknown>) => void),
  };
  const transport: PublishingCosTransport = {
    async request(method, input, signal) {
      calls.push({ method, input });
      if (signal?.aborted)
        throw Object.assign(new Error("aborted"), { code: "aborted" });
      await state.before?.(method, input, signal);
      const Key = input.Key as string;
      const UploadId = input.UploadId as string;
      const object = objects.get(Key);
      const upload = uploads.get(UploadId);
      const headers = input.Headers as Record<string, string> | undefined;
      let result: Record<string, unknown> = {
        statusCode: 200,
        rawBody: Buffer.alloc(0),
      };
      switch (method) {
        case "getBucketVersioning":
          result.rawBody = Buffer.from(state.versioning);
          break;
        case "headObject":
          if (!object) throw new PublishingCosResponseError(404);
          result.headers = {
            ...object.headers,
            "content-length": String(object.bytes.length),
            etag: `"${createHash("md5").update(object.bytes).digest("hex")}"`,
          };
          break;
        case "getObject": {
          if (!object) throw new PublishingCosResponseError(404);
          if (
            input.IfMatch !==
            `"${createHash("md5").update(object.bytes).digest("hex")}"`
          )
            throw new PublishingCosResponseError(412);
          const match = /^bytes=(\d+)-(\d+)$/.exec(String(input.Range))!;
          const start = Number(match[1]);
          const end = Number(match[2]);
          result = {
            statusCode: 206,
            rawBody: object.bytes.subarray(start, end + 1),
            headers: {
              "content-range": `bytes ${start}-${end}/${object.bytes.length}`,
            },
          };
          break;
        }
        case "multipartInit": {
          const id = `upload-${++sequence}`;
          uploads.set(id, {
            Key,
            UploadId: id,
            Initiated: new Date().toISOString(),
            modified: new Date(),
            headers: headers ?? {},
            parts: [],
          });
          result.UploadId = id;
          break;
        }
        case "multipartUpload": {
          if (!upload) throw new PublishingCosResponseError(404);
          const bytes = Buffer.from(input.Body as Buffer);
          if (
            headers?.["Content-MD5"] !==
            createHash("md5").update(bytes).digest("base64")
          )
            throw new PublishingCosResponseError(400);
          upload.parts[Number(input.PartNumber) - 1] = bytes;
          upload.modified = new Date();
          result.ETag = `"${createHash("md5").update(bytes).digest("hex")}"`;
          break;
        }
        case "multipartComplete":
          if (objects.has(Key)) throw new PublishingCosResponseError(409);
          if (!upload) throw new PublishingCosResponseError(404);
          objects.set(Key, {
            bytes: Buffer.concat(upload.parts),
            headers: upload.headers,
            modified: new Date(),
          });
          uploads.delete(UploadId);
          break;
        case "multipartAbort":
          uploads.delete(UploadId);
          break;
        case "deleteObject":
          objects.delete(Key);
          break;
        case "getBucket": {
          const keys = [...objects.keys()]
            .sort()
            .filter(
              (key) =>
                key.startsWith(String(input.Prefix)) &&
                key > String(input.Marker ?? ""),
            );
          result.Contents = keys.slice(0, Number(input.MaxKeys)).map((key) => ({
            Key: key,
            Size: String(objects.get(key)!.bytes.length),
            LastModified: objects.get(key)!.modified.toISOString(),
          }));
          result.IsTruncated = String(keys.length > Number(input.MaxKeys));
          break;
        }
        case "multipartList": {
          const items = [...uploads.values()]
            .sort(
              (a, b) =>
                a.Key.localeCompare(b.Key) ||
                a.UploadId.localeCompare(b.UploadId),
            )
            .filter(
              (u) =>
                u.Key.startsWith(String(input.Prefix)) &&
                (u.Key > String(input.KeyMarker ?? "") ||
                  (u.Key === input.KeyMarker &&
                    u.UploadId > String(input.UploadIdMarker ?? ""))),
            );
          const page = items.slice(0, Number(input.MaxUploads));
          result.Upload = page;
          result.IsTruncated = String(items.length > page.length);
          result.NextKeyMarker = page.at(-1)?.Key;
          result.NextUploadIdMarker = page.at(-1)?.UploadId;
          break;
        }
        case "multipartListPart":
          if (!upload) throw new PublishingCosResponseError(404);
          result.Part = upload.parts.map(() => ({
            LastModified: upload.modified.toISOString(),
          }));
          result.IsTruncated = "false";
          break;
      }
      state.after?.(method, result);
      return result as never;
    },
  };
  return {
    objects,
    uploads,
    calls,
    state,
    transport,
    store: new CosPublishingMediaStore(cosOptions, transport),
  };
}
