import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { summarizeTraffic } from "./summarize-traffic.mjs";

describe("request accounting separate from product analytics", () => {
  it("reports legacy requests without inventing visitors or Owner attribution", async () => {
    const result = await summarizeTraffic([
      "2026-10-18T01:01:00+00:00 200 0.010",
      "2026-10-18T01:01:01+00:00 404 0.001",
      "2026-10-18T01:01:02+00:00 400 0.000",
    ]);
    assert.equal(result.requests, 3);
    assert.equal(result.legacyUnattributedRequests, 3);
    assert.equal(result.classifiedRequests, 0);
    assert.deepEqual(result.routeFamilies, {});
    assert.equal(result.requestsWithKnownBytes, 0);
    assert.deepEqual(result.hours, { "2026-10-18T01": 3 });
  });

  it("aggregates new metadata while withholding raw identifiers and arbitrary text", async () => {
    const result = await summarizeTraffic([
      JSON.stringify({
        at: "2026-10-19T00:00:00Z",
        status: 200,
        bytes: 512,
        route: "notifications",
        client: "browser-like",
        device_excluded: 1,
        ip: "192.0.2.1",
        extra: "synthetic-private-text",
      }),
      JSON.stringify({
        at: "2026-10-19T00:00:01Z",
        status: 404,
        bytes: 10,
        route: "other",
        client: "script-like",
        device_excluded: 0,
      }),
    ]);
    assert.equal(result.requests, 2);
    assert.equal(result.knownResponseBytes, 522);
    assert.equal(result.deviceMarkedExcluded, 1);
    assert.deepEqual(result.routeFamilies, { notifications: 1, other: 1 });
    assert.equal(JSON.stringify(result).includes("192.0.2.1"), false);
    assert.equal(
      JSON.stringify(result).includes("synthetic-private-text"),
      false,
    );
  });

  it("keeps malformed and unknown-classification records visible as invalid", async () => {
    const result = await summarizeTraffic([
      "not a request",
      "",
      "2026-10-19T00:00:00Z 999 0.1",
      JSON.stringify({
        at: "2026-10-19T00:00:00Z",
        status: 200,
        route: "private-unbounded-value",
        client: "browser-like",
      }),
    ]);
    assert.equal(result.invalidLines, 3);
    assert.equal(result.requests, 0);
  });
});
