import { createHash, timingSafeEqual } from "node:crypto";
import type { BackendApplicationOptions } from "@moya/backend-runtime";
import {
  createPublishingCosTransport,
  PublishingCosResponseError,
} from "../storage/publishing-cos-transport.js";
import type { PublishingCosTransport } from "../storage/publishing-cos-transport.js";
import type { CosCredentials } from "../storage/cos-read.js";

const maximum = 8_388_608;
const types = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);
type EvidenceStore = NonNullable<
  BackendApplicationOptions["reportingEvidenceStore"]
>;

/** Private bytes behind the existing DB reservation and authorized read path.
 * No public URL, listing, local spool or retry is added. */
export class CosReportingEvidenceStore implements EvidenceStore {
  private readonly transport: PublishingCosTransport;

  constructor(
    private readonly options: {
      readonly bucket: string;
      readonly region: string;
      readonly prefix: string;
      readonly credentials: () => Promise<CosCredentials>;
      readonly requestTimeoutMs: number;
    },
    transport?: PublishingCosTransport,
  ) {
    if (
      !/^[a-z0-9][a-z0-9-]{1,49}-[0-9]{5,20}$/u.test(options.bucket) ||
      !/^[a-z]{2}-[a-z]+(?:-[a-z]+)?$/u.test(options.region) ||
      !/^report-evidence\/[a-z0-9][a-z0-9-]{0,63}\/$/u.test(options.prefix) ||
      !Number.isSafeInteger(options.requestTimeoutMs) ||
      options.requestTimeoutMs < 1 ||
      options.requestTimeoutMs > 30_000
    )
      throw new Error("REPORT_EVIDENCE_COS_CONFIGURATION_INVALID");
    this.transport =
      transport ??
      createPublishingCosTransport({
        credentials: options.credentials,
        requestTimeoutMs: options.requestTimeoutMs,
      });
  }

  private object(id: string) {
    if (!/^evidence-[0-9a-f]{32}$/u.test(id))
      throw new Error("REPORT_EVIDENCE_ID_INVALID");
    return {
      Bucket: this.options.bucket,
      Region: this.options.region,
      Key: this.options.prefix + id,
    };
  }

  /** Delete markers must never masquerade as the existing retention purge. */
  private async unversioned(): Promise<void> {
    const result = await this.transport.request(
      "getBucketVersioning",
      { Bucket: this.options.bucket, Region: this.options.region },
      undefined,
      16_384,
    );
    const xml = result.rawBody
      .toString("utf8")
      .replace(/^\s*<\?xml[^?]*\?>\s*/u, "")
      .trim();
    if (
      !/^<VersioningConfiguration\s*(?:xmlns=["']http:\/\/cos\.myqcloud\.com\/doc\/2006-03-01\/["']\s*)?(?:\/>|>\s*<\/VersioningConfiguration>)$/u.test(
        xml,
      )
    )
      throw new Error("REPORT_EVIDENCE_COS_UNVERSIONED_BUCKET_REQUIRED");
  }

  async put(
    input: Parameters<EvidenceStore["put"]>[0],
  ): ReturnType<EvidenceStore["put"]> {
    const object = this.object(input.id);
    if (
      !types.has(input.mimeType) ||
      !input.bytes.length ||
      input.bytes.length > maximum
    )
      throw new Error("REPORT_EVIDENCE_INVALID");
    const body = Buffer.concat([
      Buffer.from(input.mimeType + "\n", "ascii"),
      input.bytes,
    ]);
    try {
      await this.unversioned();
    } catch {
      throw new Error("REPORT_EVIDENCE_WRITE_FAILED");
    }
    try {
      await this.transport.request(
        "putObject",
        {
          ...object,
          Body: body,
          ContentLength: body.length,
          ContentType: "application/octet-stream",
          ACL: "private",
          CacheControl: "private, no-store",
          Headers: {
            "Content-MD5": createHash("md5").update(body).digest("base64"),
            "x-cos-forbid-overwrite": "true",
            "x-cos-server-side-encryption": "AES256",
          },
        },
        undefined,
        65_536,
      );
    } catch (error) {
      if (
        error instanceof PublishingCosResponseError &&
        (error.statusCode === 409 || error.statusCode === 412)
      ) {
        let existing;
        try {
          existing = await this.read(input.id);
        } catch {
          return { status: "uncertain" };
        }
        if (
          existing?.mimeType === input.mimeType &&
          existing.bytes.length === input.bytes.length &&
          timingSafeEqual(existing.bytes, input.bytes)
        )
          return;
        throw new Error("REPORT_EVIDENCE_CONFLICT", { cause: error });
      }
      // A timeout, transport failure or server error is not proof that PUT
      // never committed. Do not let compensation delete the reservation before
      // a late remote commit; the day-old pending sweep owns that cleanup.
      if (
        error instanceof PublishingCosResponseError &&
        [401, 403, 404, 405, 411, 413, 415].includes(error.statusCode)
      )
        throw new Error("REPORT_EVIDENCE_WRITE_FAILED", { cause: error });
      return { status: "uncertain" };
    }
  }

  async read(
    id: string,
  ): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
    const object = this.object(id);
    let body: Buffer;
    try {
      body = (
        await this.transport.request(
          "getObject",
          object,
          undefined,
          maximum + 32,
        )
      ).rawBody;
    } catch (error) {
      if (
        error instanceof PublishingCosResponseError &&
        error.statusCode === 404
      )
        return null;
      throw new Error("REPORT_EVIDENCE_READ_FAILED", { cause: error });
    }
    const boundary = body.indexOf(10);
    const mimeType = body.subarray(0, boundary).toString("ascii");
    const bytes = body.subarray(boundary + 1);
    if (
      boundary < 1 ||
      boundary > 31 ||
      !types.has(mimeType) ||
      !bytes.length ||
      bytes.length > maximum
    )
      throw new Error("REPORT_EVIDENCE_FILE_INVALID");
    return { bytes, mimeType };
  }

  async delete(id: string): Promise<void> {
    const object = this.object(id);
    try {
      await this.unversioned();
    } catch {
      throw new Error("REPORT_EVIDENCE_DELETE_FAILED");
    }
    try {
      await this.transport.request("deleteObject", object, undefined, 65_536);
    } catch (error) {
      if (
        error instanceof PublishingCosResponseError &&
        error.statusCode === 404
      )
        return;
      throw new Error("REPORT_EVIDENCE_DELETE_FAILED", { cause: error });
    }
  }
}
