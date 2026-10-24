import { describe, it, expect, vi } from "vitest";
import { mkdtemp, chmod, symlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PrivateReportingEvidenceStore,
  OfflineIpLocation,
  createUrgentReportSender,
  ReportingMaintenanceWorker,
} from "@moya/backend-production";
describe("reporting private evidence and coarse geography", () => {
  it("keeps private evidence immutable, bounded and refuses symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "reporting-synthetic-"));
    await chmod(root, 0o700);
    const store = new PrivateReportingEvidenceStore(root),
      id = "evidence-" + "1".repeat(32),
      bytes = Buffer.from("%PDF-synthetic");
    try {
      await store.put({ id, mimeType: "application/pdf", bytes });
      await store.put({ id, mimeType: "application/pdf", bytes });
      expect((await store.read(id))?.bytes).toEqual(bytes);
      await expect(
        store.put({
          id,
          mimeType: "application/pdf",
          bytes: Buffer.from("different"),
        }),
      ).rejects.toThrow("CONFLICT");
      const linked = "evidence-" + "2".repeat(32);
      const outside = join(root, "outside");
      await writeFile(outside, "synthetic");
      await symlink(outside, join(root, linked));
      await expect(store.read(linked)).rejects.toThrow();
      await store.delete(id);
      expect(await store.read(id)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("returns only provincial or country labels across IPv4/IPv6 and rejects overlapping data", () => {
    const db = new OfflineIpLocation([
      { start: "192.0.2.0", end: "192.0.2.255", country: "CN", region: "浙江" },
      { start: "2001:db8::", end: "2001:db8::ffff", country: "示例国家" },
    ]);
    expect(db.locate("192.0.2.1")).toBe("浙江");
    expect(db.locate("::ffff:192.0.2.1")).toBe("浙江");
    expect(db.locate("2001:db8::2")).toBe("示例国家");
    expect(db.locate("127.0.0.1")).toBeNull();
    expect(
      () =>
        new OfflineIpLocation([
          { start: "192.0.2.0", end: "192.0.2.255", country: "CN" },
        ]),
    ).toThrow();
  });
  it("fails closed when urgent mail configuration is absent", async () => {
    await expect(
      createUrgentReportSender(
        null,
        undefined,
        undefined,
      )("report-" + "3".repeat(32)),
    ).rejects.toThrow("NOT_CONFIGURED");
  });
});

describe("reporting maintenance lifecycle", () => {
  it("stops its own timer and drains the active pump", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-23T12:00:00Z"));
    const adapter = {
      claimUrgent: vi.fn(async () => []),
      purgeExpiredCases: vi.fn(async () => 0),
      purgeExpiredEvidence: vi.fn(async () => 0),
    };
    const worker = new ReportingMaintenanceWorker(
      adapter as unknown as ConstructorParameters<
        typeof ReportingMaintenanceWorker
      >[0],
      async () => {},
    );
    try {
      worker.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(adapter.claimUrgent).toHaveBeenCalledTimes(1);
      await worker.stop();
      await vi.advanceTimersByTimeAsync(20000);
      expect(adapter.claimUrgent).toHaveBeenCalledTimes(1);
    } finally {
      await worker.stop();
      vi.useRealTimers();
    }
  });
});
