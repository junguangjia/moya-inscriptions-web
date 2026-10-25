import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CommunityReportingService } from "@moya/api";
import type { CommunityReportingPort } from "@moya/api";
import { ReportingMaintenanceWorker } from "@moya/backend-production";
import {
  CosReportingEvidenceStore,
  openReportingEvidenceStore,
} from "@moya/backend-production/internal/reporting-evidence";
import { PublishingCosResponseError } from "@moya/backend-production/internal/publishing-media-store";
import type {
  PublishingCosMethod,
  PublishingCosTransport,
} from "@moya/backend-production/internal/publishing-media-store";

const id = "evidence-" + "1".repeat(32);
const bytes = Buffer.from("%PDF-synthetic evidence");
const environment = {
  NODE_ENV: "production",
  MOYA_REPORT_EVIDENCE_STORE: "cos",
  REPORT_EVIDENCE_COS_BUCKET: "synthetic-evidence-1250000000",
  REPORT_EVIDENCE_COS_REGION: "ap-guangzhou",
  REPORT_EVIDENCE_COS_PREFIX: "report-evidence/synthetic/",
  REPORT_EVIDENCE_COS_SECRET_ID: "synthetic-evidence-id",
  REPORT_EVIDENCE_COS_SECRET_KEY: "synthetic-evidence-key-not-valid",
};

function fixture() {
  const objects = new Map<string, Buffer>();
  const calls: {
    method: PublishingCosMethod;
    input: Record<string, unknown>;
    bound?: number;
  }[] = [];
  const state = {
    versioning: '<?xml version="1.0"?><VersioningConfiguration/>',
    failure: undefined as Error | undefined,
    putFailure: undefined as Error | undefined,
    beforeDelete: undefined as (() => Promise<void>) | undefined,
  };
  const transport: PublishingCosTransport = {
    async request(method, input, _signal, bound) {
      calls.push({ method, input, ...(bound === undefined ? {} : { bound }) });
      if (state.failure) throw state.failure;
      if (method === "getBucketVersioning")
        return { rawBody: Buffer.from(state.versioning) } as never;
      const key = input.Key as string;
      if (method === "putObject") {
        if (state.putFailure) throw state.putFailure;
        if (objects.has(key)) throw new PublishingCosResponseError(409);
        objects.set(key, Buffer.from(input.Body as Buffer));
      } else if (method === "deleteObject") {
        await state.beforeDelete?.();
        objects.delete(key);
      } else if (method === "getObject") {
        const body = objects.get(key);
        if (!body) throw new PublishingCosResponseError(404);
        return { rawBody: body } as never;
      }
      return { rawBody: Buffer.alloc(0) } as never;
    },
  };
  const store = openReportingEvidenceStore(environment, transport)!;
  return { objects, calls, state, transport, store };
}

describe("explicit private COS reporting evidence", () => {
  it("classifies a timed-out PUT or server failure as uncertain, without retry or compensation", async () => {
    for (const error of [
      new Error("synthetic transport timeout"),
      new PublishingCosResponseError(408),
      new PublishingCosResponseError(503),
    ]) {
      const f = fixture();
      f.state.putFailure = error;
      await expect(
        f.store.put({ id, mimeType: "application/pdf", bytes }),
      ).resolves.toEqual({ status: "uncertain" });
      expect(f.calls.map((call) => call.method)).toEqual([
        "getBucketVersioning",
        "putObject",
      ]);
    }
    const denied = fixture();
    denied.state.putFailure = new PublishingCosResponseError(403);
    await expect(
      denied.store.put({ id, mimeType: "application/pdf", bytes }),
    ).rejects.toThrow("WRITE_FAILED");
  });

  it("drains only the current slow COS deletion when shutdown starts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-25T12:00:00Z"));
    const f = fixture();
    let finish!: () => void;
    const pendingDelete = new Promise<void>((resolve) => {
      finish = resolve;
    });
    f.state.beforeDelete = () => pendingDelete;
    const adapter = {
      claimUrgent: vi.fn(async () => []),
      purgeExpiredCases: vi.fn(async () => 0),
      purgeExpiredEvidence: vi.fn(
        async (remove: (value: string) => Promise<void>) => {
          await remove(id);
          await remove("evidence-" + "2".repeat(32));
          return 2;
        },
      ),
    };
    const worker = new ReportingMaintenanceWorker(
      adapter as unknown as ConstructorParameters<
        typeof ReportingMaintenanceWorker
      >[0],
      async () => {},
      f.store,
    );
    try {
      worker.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(
        f.calls.filter((call) => call.method === "deleteObject"),
      ).toHaveLength(1);
      const stopping = worker.stop();
      await vi.advanceTimersByTimeAsync(45_000);
      finish();
      await stopping;
      expect(
        f.calls.filter((call) => call.method === "deleteObject"),
      ).toHaveLength(1);
      expect(adapter.purgeExpiredCases).not.toHaveBeenCalled();
      expect(adapter.claimUrgent).toHaveBeenCalledTimes(1);
    } finally {
      finish();
      await worker.stop();
      vi.useRealTimers();
    }
  });
  it("does not confuse a missing bucket with a successfully purged object", async () => {
    const f = fixture();
    f.state.failure = new PublishingCosResponseError(404);
    await expect(f.store.delete(id)).rejects.toThrow("DELETE_FAILED");
    expect(f.calls.map((call) => call.method)).toEqual(["getBucketVersioning"]);
  });
  it("keeps immutable private objects, idempotent retries and existing byte reads", async () => {
    const f = fixture();
    await f.store.put({ id, mimeType: "application/pdf", bytes });
    await f.store.put({ id, mimeType: "application/pdf", bytes });
    const file = await f.store.read(id);
    expect(file).toEqual({ mimeType: "application/pdf", bytes });
    expect(
      f.calls.find((call) => call.method === "putObject")?.input,
    ).toMatchObject({
      Bucket: environment.REPORT_EVIDENCE_COS_BUCKET,
      Region: environment.REPORT_EVIDENCE_COS_REGION,
      Key: environment.REPORT_EVIDENCE_COS_PREFIX + id,
      ACL: "private",
      CacheControl: "private, no-store",
      ContentType: "application/octet-stream",
      Headers: {
        "x-cos-forbid-overwrite": "true",
        "x-cos-server-side-encryption": "AES256",
        "Content-MD5": createHash("md5")
          .update(Buffer.concat([Buffer.from("application/pdf\n"), bytes]))
          .digest("base64"),
      },
    });
    expect(
      f.calls
        .filter((call) => call.method === "getObject")
        .every((call) => call.bound === 8_388_640),
    ).toBe(true);
    await expect(
      f.store.put({
        id,
        mimeType: "application/pdf",
        bytes: Buffer.from("different"),
      }),
    ).rejects.toThrow("CONFLICT");
    expect((await f.store.read(id))?.bytes).toEqual(bytes);
    await f.store.delete(id);
    await f.store.delete(id);
    expect(await f.store.read(id)).toBeNull();
    expect(f.objects.size).toBe(0);
  });

  it.each(["../outside", "evidence-../outside", "evidence-" + "A".repeat(32)])(
    "rejects caller-controlled object identity %s before I/O",
    async (value) => {
      const f = fixture();
      await expect(f.store.read(value)).rejects.toThrow("ID_INVALID");
      await expect(f.store.delete(value)).rejects.toThrow("ID_INVALID");
      await expect(
        f.store.put({ id: value, mimeType: "application/pdf", bytes }),
      ).rejects.toThrow("ID_INVALID");
      expect(f.calls).toEqual([]);
    },
  );

  it.each([
    "<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>",
    "<VersioningConfiguration><Status>Suspended</Status></VersioningConfiguration>",
    "",
    "not xml",
  ])(
    "refuses unproved or versioned storage before changing objects",
    async (xml) => {
      const f = fixture();
      f.state.versioning = xml;
      await expect(
        f.store.put({ id, mimeType: "application/pdf", bytes }),
      ).rejects.toThrow("WRITE_FAILED");
      await expect(f.store.delete(id)).rejects.toThrow("DELETE_FAILED");
      expect(
        f.calls.every((call) => call.method === "getBucketVersioning"),
      ).toBe(true);
    },
  );

  it("contains provider errors and preserves response/input bounds", async () => {
    const f = fixture();
    f.state.failure = new Error(
      "synthetic private diagnostic must stay inside transport",
    );
    await expect(f.store.read(id)).rejects.toThrow(
      /^REPORT_EVIDENCE_READ_FAILED$/,
    );
    await expect(
      f.store.put({ id, mimeType: "application/pdf", bytes }),
    ).rejects.toThrow(/^REPORT_EVIDENCE_WRITE_FAILED$/);
    await expect(f.store.delete(id)).rejects.toThrow(
      /^REPORT_EVIDENCE_DELETE_FAILED$/,
    );
    const before = f.calls.length;
    for (const invalid of [Buffer.alloc(0), Buffer.alloc(8_388_609)])
      await expect(
        f.store.put({ id, mimeType: "application/pdf", bytes: invalid }),
      ).rejects.toThrow("INVALID");
    await expect(
      f.store.put({ id, mimeType: "text/plain", bytes }),
    ).rejects.toThrow("INVALID");
    expect(f.calls.length).toBe(before);
  });

  it.each([
    Buffer.from("unknown/type\nbytes"),
    Buffer.from("application/pdf\n"),
    Buffer.from("not-an-envelope"),
    Buffer.concat([Buffer.from("application/pdf\n"), Buffer.alloc(8_388_609)]),
  ])("refuses corrupt stored envelopes", async (body) => {
    const f = fixture();
    f.objects.set(environment.REPORT_EVIDENCE_COS_PREFIX + id, body);
    await expect(f.store.read(id)).rejects.toThrow("FILE_INVALID");
  });

  it("retains service authorization and DB hash verification before returning bytes", async () => {
    const f = fixture();
    await f.store.put({ id, mimeType: "application/pdf", bytes });
    const metadata = {
      id,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    let allowed = false;
    const service = new CommunityReportingService(
      {
        async evidence() {
          if (!allowed) throw new Error("synthetic authorization refusal");
          return metadata;
        },
      } as unknown as CommunityReportingPort,
      { evidenceStore: f.store },
    );
    const before = f.calls.length;
    await expect(
      service.evidence(null, "report-synthetic", id),
    ).rejects.toThrow("authorization refusal");
    expect(f.calls.length).toBe(before);
    allowed = true;
    expect(
      (await service.evidence("synthetic-user", "report-synthetic", id)).bytes,
    ).toEqual(bytes);
    f.objects.set(
      environment.REPORT_EVIDENCE_COS_PREFIX + id,
      Buffer.from("application/pdf\n%PDF-altered"),
    );
    await expect(
      service.evidence("synthetic-user", "report-synthetic", id),
    ).rejects.toThrow();
  });
});

describe("report evidence factory configuration", () => {
  it("keeps Development and legacy filesystem behavior without opening COS", () => {
    expect(
      openReportingEvidenceStore({ NODE_ENV: "development" }),
    ).toBeUndefined();
    expect(
      openReportingEvidenceStore({
        NODE_ENV: "development",
        MOYA_REPORT_EVIDENCE_DIRECTORY: "/synthetic/evidence",
      }),
    ).toBeDefined();
    expect(
      openReportingEvidenceStore({
        NODE_ENV: "production",
        MOYA_REPORT_EVIDENCE_DIRECTORY: "/synthetic/legacy",
      }),
    ).toBeDefined();
    expect(openReportingEvidenceStore(environment)).toBeInstanceOf(
      CosReportingEvidenceStore,
    );
  });
  it.each(["COS", "CMS_COS", "WORK_MEDIA_COS", "CATALOG_SOURCE_COS"])(
    "refuses %s credential reuse",
    (namespace) => {
      expect(() =>
        openReportingEvidenceStore({
          ...environment,
          [namespace + "_SECRET_ID"]: environment.REPORT_EVIDENCE_COS_SECRET_ID,
        }),
      ).toThrow("NOT_SEPARATE");
      expect(() =>
        openReportingEvidenceStore({
          ...environment,
          [namespace + "_SECRET_KEY"]:
            environment.REPORT_EVIDENCE_COS_SECRET_KEY,
        }),
      ).toThrow("NOT_SEPARATE");
    },
  );
  it.each([
    { MOYA_REPORT_EVIDENCE_STORE: "unknown" },
    { MOYA_REPORT_EVIDENCE_STORE: undefined },
    { NODE_ENV: "development" },
    { MOYA_REPORT_EVIDENCE_DIRECTORY: "/synthetic/evidence" },
    { REPORT_EVIDENCE_COS_SECRET_ID: undefined },
    { REPORT_EVIDENCE_COS_SECRET_KEY: "REPLACE_ME_KEY" },
    { REPORT_EVIDENCE_COS_BUCKET: "not-a-bucket" },
    { REPORT_EVIDENCE_COS_PREFIX: "ugc/publishing/synthetic/" },
    { REPORT_EVIDENCE_COS_PREFIX: "report-evidence/../" },
    { REPORT_EVIDENCE_COS_REQUEST_TIMEOUT_MS: "30001" },
    { REPORT_EVIDENCE_COS_SECURITY_TOKEN: "synthetic-token-not-valid" },
    { REPORT_EVIDENCE_COS_CREDENTIAL_EXPIRES_AT: "1" },
    {
      REPORT_EVIDENCE_COS_SECURITY_TOKEN: "synthetic-token-not-valid",
      REPORT_EVIDENCE_COS_CREDENTIAL_EXPIRES_AT: "1",
    },
  ])("fails closed for incomplete, mixed or invalid selection %#", (patch) => {
    expect(() =>
      openReportingEvidenceStore({ ...environment, ...patch }),
    ).toThrow();
  });
});
