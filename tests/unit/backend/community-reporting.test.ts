import { createServer } from "node:http";
import { createBackendApplication } from "@moya/backend-runtime";
import type { CommunityIdentityPort } from "@moya/api";
import type { CommunityReportEvidenceUploadRequest } from "@moya/contracts";
import { randomUUID } from "node:crypto";
import { CommunityInputError, CommunityReportingService } from "@moya/api";
import type { CommunityReportingPort } from "@moya/api";
import {
  createCommunityReportRequestSchema,
  communityAppealLoginResultSchema,
} from "@moya/contracts/schemas";
import { describe, expect, it, vi } from "vitest";
const target = { type: "work", id: "work-synthetic" } as const;
describe("reporting contracts and evidence admission", () => {
  it("requires a reason for posts and accounts while comment click needs none", () => {
    for (const type of ["work", "user"] as const)
      expect(
        createCommunityReportRequestSchema.safeParse({
          kind: "standard",
          target: { type, id: "synthetic" },
          requestId: randomUUID(),
        }).success,
      ).toBe(false);
    expect(
      createCommunityReportRequestSchema.parse({
        kind: "quick_comment",
        target: { type: "comment", id: "comment-synthetic" },
        requestId: randomUUID(),
      }).kind,
    ).toBe("quick_comment");
    expect(
      createCommunityReportRequestSchema.safeParse({
        kind: "quick_comment",
        target,
        requestId: randomUUID(),
      }).success,
    ).toBe(false);
    expect(
      createCommunityReportRequestSchema.safeParse({
        kind: "quick_comment",
        target: { type: "comment", id: "comment-synthetic" },
        reason: "other",
        requestId: randomUUID(),
      }).success,
    ).toBe(false);
  });
  it("permits private formal rights notices for comments without enabling ordinary comment forms", () => {
    const formal = {
      kind: "rights_notice",
      target: { type: "comment", id: "comment-synthetic-reply" },
      reason: "copyright",
      description: "Formal notice about reply text",
      claimantName: "Synthetic claimant",
      contact: "synthetic@example.invalid",
      rightsBasis: "Synthetic ownership basis",
      requestId: randomUUID(),
    };
    expect(createCommunityReportRequestSchema.parse(formal).kind).toBe(
      "rights_notice",
    );
    expect(
      createCommunityReportRequestSchema.safeParse({
        ...formal,
        reason: "other",
      }).success,
    ).toBe(false);
    expect(
      createCommunityReportRequestSchema.safeParse({
        kind: "standard",
        target: formal.target,
        reason: "copyright",
        requestId: randomUUID(),
      }).success,
    ).toBe(false);
    expect(
      createCommunityReportRequestSchema.safeParse({
        kind: "quick_comment",
        target: formal.target,
        requestId: randomUUID(),
      }).success,
    ).toBe(true);
    expect(
      createCommunityReportRequestSchema.safeParse({
        ...formal,
        kind: "quick_comment",
      }).success,
    ).toBe(false);
  });
  it("keeps restricted appeal auth discriminated from ordinary authentication", () => {
    expect(
      communityAppealLoginResultSchema.safeParse({
        outcome: "signed_in",
        session: {},
      }).success,
    ).toBe(false);
  });
  it("rejects invalid HTTP report input before touching persistence", async () => {
    const create = vi.fn();
    const identity = {
      findSessionUser: vi.fn().mockResolvedValue({
        id: "user-" + "1".repeat(32),
        handle: "synthetic-reporter",
        displayName: "Synthetic reporter",
        status: "active",
      }),
    } as unknown as CommunityIdentityPort;
    const server = createServer(
      createBackendApplication({
        nodeEnv: "test",
        communityIdentityPort: identity,
        reportingPort: { create } as unknown as CommunityReportingPort,
      }),
    );
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Missing test listener");
      const response = await fetch(
        `http://127.0.0.1:${address.port}/v1/community/reports`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${"a".repeat(43)}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            kind: "standard",
            target,
            requestId: randomUUID(),
          }),
        },
      );
      expect(response.status).toBe(422);
      expect(create).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
  it("authorizes evidence before writing private storage and rejects MIME spoofing", async () => {
    const authorizeEvidence = vi.fn().mockResolvedValue(undefined),
      put = vi.fn(),
      addEvidence = vi.fn();
    const service = new CommunityReportingService(
      { authorizeEvidence, addEvidence } as unknown as CommunityReportingPort,
      { evidenceStore: { put, read: vi.fn(), delete: vi.fn() } },
    );
    const input: CommunityReportEvidenceUploadRequest = {
      fileName: "proof.pdf",
      mimeType: "application/pdf",
      sensitive: true,
      requestId: randomUUID(),
      contentBase64: Buffer.from("<html>private</html>").toString("base64"),
    };
    await expect(
      service.uploadEvidence("actor", "report-id", input),
    ).rejects.toBeInstanceOf(CommunityInputError);
    expect(authorizeEvidence).toHaveBeenCalledWith("actor", "report-id");
    expect(put).not.toHaveBeenCalled();
    expect(addEvidence).not.toHaveBeenCalled();
  });
  it("uses stable evidence identity for retries and keeps storage keys out of responses", async () => {
    const authorizeEvidence = vi.fn().mockResolvedValue(undefined),
      put = vi.fn().mockResolvedValue(undefined),
      addEvidence = vi.fn(async (_actor, _id, e, persist) => {
        await persist();
        return e;
      });
    const service = new CommunityReportingService(
      { authorizeEvidence, addEvidence } as unknown as CommunityReportingPort,
      { evidenceStore: { put, read: vi.fn(), delete: vi.fn() } },
    );
    const input: CommunityReportEvidenceUploadRequest = {
      fileName: "proof.pdf",
      mimeType: "application/pdf",
      sensitive: false,
      requestId: randomUUID(),
      contentBase64: Buffer.from("%PDF-1.7 synthetic proof").toString("base64"),
    };
    await service.uploadEvidence("actor", "report-id", input);
    await service.uploadEvidence("actor", "report-id", input);
    expect(addEvidence.mock.calls[0]![2].sensitive).toBe(true);
    expect(put.mock.calls[0]![0].id).toBe(put.mock.calls[1]![0].id);
    expect(put.mock.calls[0]![0].id).toMatch(/^evidence-[a-f0-9]{32}$/u);
  });
});
