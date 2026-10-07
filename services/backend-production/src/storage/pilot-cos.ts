import { createHash } from "node:crypto";
import { Writable } from "node:stream";

import { CosReadUrlSigner } from "./cos-read.js";

import type { CosSdkResponse } from "./cos-sdk.js";
import type { CosReadDependencies, CosReadOptions } from "./cos-read.js";

export type { CosCredentials } from "./cos-read.js";

export interface PilotCosObject {
  readonly mediaId: string;
  readonly objectKey: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface PilotCosOptions extends CosReadOptions {
  readonly objects: readonly PilotCosObject[];
}

export interface VerifiedPilotCosObject {
  readonly objectKey: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly verifiedAt: string;
  readonly outcome: "uploaded" | "reused";
}

const MAX_OBJECT_BYTES = 32 * 1024 * 1024;
const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

/** Backend-only storage infrastructure. Calling ensureObject still requires the
 * operation/target approval guard owned by the Pilot application entry point.
 */
export class PilotCosStorage {
  private readonly objects: ReadonlyMap<string, PilotCosObject>;
  private readonly signer: CosReadUrlSigner;
  private readonly now: () => number;

  constructor(
    private readonly options: PilotCosOptions,
    dependencies: CosReadDependencies = {},
  ) {
    this.signer = new CosReadUrlSigner(options, dependencies);
    if (options.objects.length === 0 || options.objects.length > 20) {
      throw new Error("COS Pilot manifest must contain 1 to 20 objects");
    }
    const ids = new Set<string>();
    const objects = new Map<string, PilotCosObject>();
    for (const item of options.objects) {
      if (
        !/^media_[a-f0-9]{32}$/.test(item.mediaId) ||
        !/^[a-f0-9]{64}$/.test(item.sha256) ||
        item.objectKey !== `display/v1/${item.mediaId}/${item.sha256}.webp` ||
        !Number.isSafeInteger(item.sizeBytes) ||
        item.sizeBytes < 1 ||
        item.sizeBytes > MAX_OBJECT_BYTES ||
        objects.has(item.objectKey) ||
        ids.has(item.mediaId)
      ) {
        throw new Error("COS Pilot manifest invalid or duplicated");
      }
      ids.add(item.mediaId);
      objects.set(item.objectKey, Object.freeze({ ...item }));
    }
    this.objects = objects;
    this.now = dependencies.now ?? Date.now;
  }

  private object(objectKey: string): PilotCosObject {
    const object = this.objects.get(objectKey);
    if (!object) throw new Error("COS object is outside the Pilot manifest");
    return object;
  }

  private async send(
    method: "GET" | "HEAD" | "PUT",
    pathname: string,
    maxResponseBytes: number,
    body?: Buffer,
    query: Record<string, string> = {},
  ): Promise<CosSdkResponse> {
    const sdk = await this.signer.sdk();
    const headers: Record<string, string> = { "accept-encoding": "identity" };
    if (sdk.securityToken) headers["x-cos-security-token"] = sdk.securityToken;
    const bucket = {
      Bucket: this.options.bucket,
      Region: this.options.region,
      Headers: headers,
    };
    const object = { ...bucket, Key: pathname.slice(1) };
    return sdk.request(maxResponseBytes, (callback) => {
      if (Object.hasOwn(query, "versioning")) {
        sdk.client.getBucketVersioning(bucket, callback);
      } else if (method === "HEAD") {
        sdk.client.headObject(object, callback);
      } else if (method === "PUT" && body !== undefined) {
        sdk.client.putObject(
          {
            ...object,
            Body: body,
            ContentType: "image/webp",
            ContentLength: body.length,
            Headers: {
              ...headers,
              "Content-MD5": createHash("md5").update(body).digest("base64"),
              "x-cos-forbid-overwrite": "true",
            },
          },
          callback,
        );
      } else {
        sdk.client.getObject(
          {
            ...object,
            // Raw bytes are captured under the transport byte limit. Stream the
            // SDK download so it does not also buffer a second 32 MB copy.
            Output: new Writable({
              write: (_chunk, _encoding, done) => done(),
            }),
          },
          callback,
        );
      }
    });
  }

  async verifyObject(objectKey: string): Promise<VerifiedPilotCosObject> {
    const expected = this.object(objectKey);
    const response = await this.send(
      "GET",
      `/${objectKey}`,
      expected.sizeBytes,
    );
    if (
      response.statusCode !== 200 ||
      response.body.length !== expected.sizeBytes ||
      sha256(response.body) !== expected.sha256
    ) {
      throw new Error("COS object content conflicts with the Pilot manifest");
    }
    return {
      objectKey,
      sha256: expected.sha256,
      sizeBytes: expected.sizeBytes,
      verifiedAt: new Date(this.now()).toISOString(),
      outcome: "reused",
    };
  }

  private async assertNeverVersioned(): Promise<void> {
    // COS forbid-overwrite does not protect a versioned or suspended bucket.
    // https://cloud.tencent.com/document/product/436/19888 and /436/7749
    const response = await this.send("GET", "/", 4096, undefined, {
      versioning: "",
    });
    const xml = response.body
      .toString("utf8")
      .trim()
      .replace(/^<\?xml[^?]*\?>\s*/, "");
    if (
      response.statusCode !== 200 ||
      !/^<VersioningConfiguration\s*(?:xmlns=["']http:\/\/cos\.myqcloud\.com\/doc\/2006-03-01\/["']\s*)?(?:\/>|>\s*<\/VersioningConfiguration>)$/.test(
        xml,
      )
    ) {
      throw new Error("COS upload requires a verified never-versioned bucket");
    }
  }

  async ensureObject(
    objectKey: string,
    bytes: Buffer,
  ): Promise<VerifiedPilotCosObject> {
    const expected = this.object(objectKey);
    // Copy before asynchronous work so callers cannot change bytes after hashing.
    if (bytes.length !== expected.sizeBytes)
      throw new Error("COS input size mismatch");
    const body = Buffer.from(bytes);
    if (sha256(body) !== expected.sha256)
      throw new Error("COS input SHA-256 mismatch");
    const head = await this.send("HEAD", `/${objectKey}`, 0);
    if (head.statusCode === 200) return this.verifyObject(objectKey);
    if (head.statusCode !== 404)
      throw new Error("COS object existence could not be verified");
    await this.assertNeverVersioned();
    const put = await this.send("PUT", `/${objectKey}`, 4096, body);
    if (![200, 201, 409, 412].includes(put.statusCode)) {
      throw new Error("COS upload failed; verify state before retrying");
    }
    // Actual GET bytes, not ETag or self-declared metadata, establish integrity.
    const verified = await this.verifyObject(objectKey);
    return {
      ...verified,
      outcome:
        put.statusCode === 200 || put.statusCode === 201
          ? "uploaded"
          : "reused",
    };
  }

  createStorageUrlResolver() {
    return {
      resolveMany: async <MediaIdentity extends string>(
        locators: readonly {
          readonly mediaId: MediaIdentity;
          readonly objectKey: string;
        }[],
      ): Promise<ReadonlyMap<MediaIdentity, string>> => {
        const result = new Map<MediaIdentity, string>();
        for (const locator of locators) {
          const expected = this.objects.get(locator.objectKey);
          if (!expected || expected.mediaId !== locator.mediaId) continue;
          result.set(
            locator.mediaId,
            await this.signer.sign(locator.objectKey),
          );
        }
        return result;
      },
      // The Pilot delivers its manifest objects only; no Catalog rendition
      // key ever resolves (unified media pipeline, increment 1).
      resolveKeys: async (
        keys: readonly string[],
      ): Promise<ReadonlyMap<string, string>> => {
        void keys;
        return new Map<string, string>();
      },
    };
  }
}
