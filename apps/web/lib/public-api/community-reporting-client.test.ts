import { afterEach, describe, expect, it, vi } from "vitest";
import { appealClient } from "./community-appeal-client";
import {
  reportingClient,
  appealReportingClient,
  downloadReportEvidence,
  ReportingRequestError,
} from "./community-reporting-client";
const report = {
  id: "report-synthetic",
  target: { type: "comment", id: "comment-synthetic" },
  canonicalPath: "/?workId=work-synthetic#detail",
  kind: "quick_comment",
  reason: null,
  description: "",
  status: "open",
  urgent: false,
  version: 1,
  createdAt: "2026-10-23T00:00:00.000Z",
  updatedAt: "2026-10-23T00:00:00.000Z",
  decision: null,
  appeal: null,
  messages: [],
  evidence: [],
};
const requestId = "00000000-0000-4000-8000-000000000001";
afterEach(() => vi.unstubAllGlobals());
describe("community reporting client", () => {
  it("uses only same-origin private transport bound to the confirmed account", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json(report, { status: 201 }),
    );
    vi.stubGlobal("fetch", fetcher);
    expect(
      await reportingClient.create("user-synthetic", {
        kind: "quick_comment",
        target: { type: "comment", id: "comment-synthetic" },
        requestId,
      }),
    ).toEqual(report);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/community/reports",
      expect.objectContaining({
        credentials: "same-origin",
        cache: "no-store",
        headers: expect.objectContaining({
          "x-author-account": "user-synthetic",
        }),
      }),
    );
    expect(
      JSON.parse(fetcher.mock.calls[0]![1]!.body as string),
    ).not.toHaveProperty("reason");
  });
  it("selects the restricted credential only for the explicit appeal transport", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ items: [], total: 0, page: 1, pageSize: 20 }),
    );
    vi.stubGlobal("fetch", fetcher);
    await reportingClient.decisions("normal-user");
    await appealReportingClient.decisions("restricted-user");
    expect(fetcher.mock.calls[0]![1]?.headers).not.toHaveProperty(
      "x-reporting-session",
    );
    expect(fetcher.mock.calls[1]![1]?.headers).toMatchObject({
      "x-reporting-session": "appeal",
      "x-author-account": "restricted-user",
    });
  });
  it("downloads evidence with the matching explicit account/session and never a token link", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "application/pdf" },
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    const blob = await downloadReportEvidence(
      "restricted-user",
      "case-synthetic",
      "evidence-synthetic",
      true,
    );
    expect(blob.size).toBe(3);
    expect(fetcher.mock.calls[0]![0]).toBe(
      "/api/community/reports/case-synthetic/evidence/evidence-synthetic",
    );
    expect(fetcher.mock.calls[0]![1]?.headers).toEqual({
      "x-author-account": "restricted-user",
      "x-reporting-session": "appeal",
    });
  });
  it("rejects malformed responses and missing full-form reasons", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ id: "report-synthetic" }),
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(
      reportingClient.create("user-synthetic", {
        kind: "quick_comment",
        target: { type: "comment", id: "comment-synthetic" },
        requestId,
      }),
    ).rejects.toThrow();
    expect(() =>
      reportingClient.create("user-synthetic", {
        kind: "standard",
        target: { type: "work", id: "work-synthetic" },
        requestId,
      } as never),
    ).toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("returns a clear authentication failure without retrying a mutation", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 401 }),
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(
      reportingClient.material("user-synthetic", "case", {
        text: "合成补充材料",
        requestId,
      }),
    ).rejects.toBeInstanceOf(ReportingRequestError);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe("appeal capability transport", () => {
  it("fails closed when the auth relay refuses capabilities", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 503 }),
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(appealClient.capabilities()).rejects.toThrow(
      "登录服务暂不可用，请重试",
    );
    expect(fetcher).toHaveBeenCalledWith(
      "/api/community/auth/capabilities",
      expect.objectContaining({
        credentials: "same-origin",
        cache: "no-store",
      }),
    );
  });
  it("rejects a malformed successful capability response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => Response.json({ available: true })),
    );
    await expect(appealClient.capabilities()).rejects.toThrow(
      "登录服务暂不可用，请重试",
    );
  });
});
