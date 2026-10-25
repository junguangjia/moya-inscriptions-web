import { randomUUID } from "node:crypto";
import { createCommunityReportRequestSchema } from "@moya/contracts/schemas";
import { describe, expect, it } from "vitest";
describe("case-bound rights followup input", () => {
  it("accepts an opaque source only on a formal rights notice", () => {
    const target = { type: "comment", id: "comment-synthetic" },
      sourceCaseId = `report-${"a".repeat(32)}`;
    const formal = {
      kind: "rights_notice",
      target,
      sourceCaseId,
      reason: "copyright",
      description: "Synthetic followup",
      claimantName: "Synthetic claimant",
      contact: "synthetic@example.invalid",
      rightsBasis: "Synthetic basis",
      requestId: randomUUID(),
    };
    expect(createCommunityReportRequestSchema.safeParse(formal).success).toBe(
      true,
    );
    expect(
      createCommunityReportRequestSchema.safeParse({
        ...formal,
        sourceCaseId: "report-invalid",
      }).success,
    ).toBe(false);
    expect(
      createCommunityReportRequestSchema.safeParse({
        ...formal,
        sourceCaseId: "x".repeat(129),
      }).success,
    ).toBe(false);
    expect(
      createCommunityReportRequestSchema.safeParse({
        kind: "quick_comment",
        target,
        sourceCaseId,
        requestId: randomUUID(),
      }).success,
    ).toBe(false);
    expect(
      createCommunityReportRequestSchema.safeParse({
        kind: "standard",
        target: { type: "work", id: "work-synthetic" },
        sourceCaseId,
        reason: "other",
        requestId: randomUUID(),
      }).success,
    ).toBe(false);
  });
});
