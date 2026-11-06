import {
  adminJobRefSchema,
  aiCountResultSchema,
} from "@moya/contracts/internal/admin-mcp";
import { describe, expect, it } from "vitest";

import { readBackendAnswer } from "admin/admin-mcp";

// How the AI path reads a Backend answer (extensibility plan 2.4): what the strict
// schema does not name is dropped, never passed on, and anything else wrong is a real
// mismatch. The wire-level proof is in the CMS suites; this pins the reading itself.

const UNKNOWN = "addedByALaterBackend";

const count = {
  total: 2,
  oldestAt: "2026-11-01T00:00:00.000Z",
  groupBy: "kind",
  groups: [
    { value: "spam", count: 1, oldestAt: "2026-11-01T00:00:00.000Z" },
    { value: null, count: 1, oldestAt: null },
  ],
};

describe("a Backend answer on the AI path", () => {
  it("reads an answer that matches as it came", () => {
    const read = readBackendAnswer(aiCountResultSchema, count);
    expect(read?.kept).toBe(count);
    expect(read?.data).toEqual(count);
  });

  it("drops a key the schema does not name, at any depth, and reads the rest strictly", () => {
    const sent = {
      ...count,
      [UNKNOWN]: { nested: true },
      groups: count.groups.map((group) => ({ ...group, [UNKNOWN]: 1 })),
    };
    const read = readBackendAnswer(aiCountResultSchema, sent);
    expect(read?.data).toEqual(count);
    expect(read?.kept).toEqual(count);
    expect(JSON.stringify(read)).not.toContain(UNKNOWN);
    // What was sent stays as it was.
    expect(sent).toHaveProperty(UNKNOWN);
  });

  it("reads a union by the branch the answer matches once the key is dropped", () => {
    const job = {
      type: "publishing_job",
      id: `publishing-job-${"a".repeat(32)}`,
    };
    const subject = { type: "work", id: "work-1", intent: "publish" };
    expect(
      readBackendAnswer(adminJobRefSchema, { ...job, [UNKNOWN]: 1 })?.data,
    ).toEqual(job);
    expect(
      readBackendAnswer(adminJobRefSchema, { ...subject, [UNKNOWN]: 1 })?.data,
    ).toEqual(subject);
  });

  it("refuses a real mismatch, with or without a key it does not know", () => {
    for (const sent of [
      { ...count, total: "many" },
      { ...count, total: "many", [UNKNOWN]: 1 },
      { total: 2 },
      { ...count, groups: [{ value: "spam", count: 0, oldestAt: null }] },
      { type: "publishing_job", id: 7, [UNKNOWN]: 1 },
      null,
    ])
      expect(
        readBackendAnswer(aiCountResultSchema, sent) ??
          readBackendAnswer(adminJobRefSchema, sent),
        JSON.stringify(sent),
      ).toBeUndefined();
  });
});
