import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCommunityEndpoints,
  openCommunityOperatorEvidence,
} from "admin/community-endpoints";
import type {
  OperatorCall,
  OperatorMediaCall,
} from "admin/community-endpoints";
import type { OperatorReport } from "@moya/contracts/internal/community-operator";
import type { Endpoint, PayloadRequest } from "payload";

const fixture = (): OperatorReport => ({
  id: "report-synthetic",
  target: { type: "comment", id: "comment-synthetic" },
  canonicalPath: "/work/work-synthetic",
  kind: "quick_comment",
  reason: null,
  description: "",
  status: "open",
  urgent: false,
  version: 1,
  createdAt: "2026-10-23T12:00:00.000Z",
  updatedAt: "2026-10-23T12:00:00.000Z",
  decision: null,
  appeal: null,
  messages: [],
  evidence: [],
  reporterId: "user-reporter",
  affectedUserId: "user-author",
  legalHold: false,
  snapshot: { text: "Synthetic comment" },
  claimant: null,
  materials: [],
  history: [],
  notificationFailures: 0,
  allowedActions: ["retain", "hide", "warn", "restrict_comments", "suspend"],
});
const request = (
  body: unknown,
  role: "owner" | "automation" | null = "owner",
): PayloadRequest =>
  ({
    user: role === null ? null : { collection: "users", id: 1, role },
    json: async () => body,
    payload: { logger: { error: vi.fn() } },
  }) as unknown as PayloadRequest;
const invoke = async (
  endpoints: Endpoint[],
  name: string,
  req: PayloadRequest,
) => {
  const route = endpoints.find(
    (endpoint) => endpoint.path === `/community-moderation/${name}`,
  );
  if (route === undefined) throw new Error("missing route");
  const response = await route.handler(req);
  return { status: response.status, body: await response.json() };
};
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Owner reporting proxy", () => {
  it("validates every envelope before forwarding and never accepts an acting identity", async () => {
    const call = vi.fn(async () => fixture()) as unknown as OperatorCall;
    const endpoints = createCommunityEndpoints(call);
    for (const name of [
      "read-reports",
      "read-report",
      "decide-report",
      "review-report",
      "set-report-metadata",
      "forward-report",
    ]) {
      for (const role of [null, "automation"] as const)
        expect((await invoke(endpoints, name, request({}, role))).status).toBe(
          403,
        );
    }
    const valid = {
      id: "report-synthetic",
      expectedVersion: 1,
      action: "hide",
      reason: "Synthetic review reason",
    };
    for (const invalid of [
      { ...valid, operator: "spoofed" },
      { ...valid, reason: " " },
      { ...valid, expectedVersion: 0 },
      { ...valid, action: "delete" },
    ])
      expect(
        (await invoke(endpoints, "decide-report", request(invalid))).status,
      ).toBe(400);
    expect(call).not.toHaveBeenCalled();
    expect(
      (await invoke(endpoints, "decide-report", request(valid))).status,
    ).toBe(200);
    expect(call).toHaveBeenCalledExactlyOnceWith(
      "POST",
      "reports/report-synthetic/decisions",
      { expectedVersion: 1, action: "hide", reason: "Synthetic review reason" },
    );
  });

  it("routes filtered lists, corrections and deliberate forwarding through Backend", async () => {
    const call = vi.fn(async (_method: string, path: string) =>
      path.startsWith("reports?")
        ? { items: [fixture()], total: 1, page: 2, pageSize: 20 }
        : fixture(),
    ) as unknown as OperatorCall;
    const endpoints = createCommunityEndpoints(call);
    expect(
      (
        await invoke(
          endpoints,
          "read-reports",
          request({ status: "appealed", urgent: "true", page: 2 }),
        )
      ).status,
    ).toBe(200);
    expect(call).toHaveBeenLastCalledWith(
      "GET",
      "reports?status=appealed&urgent=true&page=2&pageSize=20",
    );
    expect(
      (
        await invoke(
          endpoints,
          "review-report",
          request({
            id: "report-synthetic",
            expectedVersion: 1,
            outcome: "overturn",
            reason: "Correct the prior decision",
          }),
        )
      ).status,
    ).toBe(200);
    expect(call).toHaveBeenLastCalledWith(
      "POST",
      "reports/report-synthetic/review",
      {
        expectedVersion: 1,
        outcome: "overturn",
        reason: "Correct the prior decision",
      },
    );
    expect(
      (
        await invoke(
          endpoints,
          "forward-report",
          request({
            id: "report-synthetic",
            expectedVersion: 1,
            kind: "notice",
            text: "Necessary redacted copy",
          }),
        )
      ).status,
    ).toBe(200);
    expect(call).toHaveBeenLastCalledWith(
      "POST",
      "reports/report-synthetic/forward",
      { expectedVersion: 1, kind: "notice", text: "Necessary redacted copy" },
    );
    expect(
      (
        await invoke(
          endpoints,
          "forward-report",
          request({
            id: "report-synthetic",
            expectedVersion: 1,
            kind: "notice",
            text: " ",
          }),
        )
      ).status,
    ).toBe(400);
  });

  it("forwards the shared platform result command without adding actor or content-management commands", async () => {
    const call = vi.fn(async () => ({
      ...fixture(),
      target: { type: "catalog", id: "official-synthetic" },
      kind: "rights_notice",
      reason: "copyright",
      affectedUserId: null,
      snapshot: { source: "official" },
    })) as unknown as OperatorCall;
    const endpoints = createCommunityEndpoints(call);
    const command = {
      id: "report-synthetic",
      expectedVersion: 1,
      kind: "result",
      text: "Owner platform response",
    };
    expect(
      (await invoke(endpoints, "forward-report", request(command))).status,
    ).toBe(200);
    expect(call).toHaveBeenCalledExactlyOnceWith(
      "POST",
      "reports/report-synthetic/forward",
      { expectedVersion: 1, kind: "result", text: "Owner platform response" },
    );
    expect(
      (
        await invoke(
          endpoints,
          "forward-report",
          request({ ...command, operator: "spoofed" }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await invoke(
          endpoints,
          "forward-report",
          request({ ...command, kind: "publish" }),
        )
      ).status,
    ).toBe(400);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["moderate-comment", { id: `comment-${"a".repeat(32)}`, action: "hide" }],
    [
      "moderate-comments",
      { ids: [`comment-${"a".repeat(32)}`], action: "hide" },
    ],
    ["moderate-user", { id: `user-${"b".repeat(32)}`, action: "suspend" }],
    [
      "moderate-work",
      {
        id: `work-${"c".repeat(32)}`,
        requestId: "00000000-0000-4000-8000-000000000004",
        state: "hidden",
        expectedVersion: 2,
      },
    ],
    [
      "delete-body",
      {
        id: `comment-${"a".repeat(32)}`,
        requestId: "00000000-0000-4000-8000-000000000004",
      },
    ],
    [
      "remove-thread",
      {
        id: `comment-${"a".repeat(32)}`,
        requestId: "00000000-0000-4000-8000-000000000004",
        expectedAffectedCount: 3,
      },
    ],
    [
      "moderate-work-submission",
      {
        id: `work-revision-${"d".repeat(32)}`,
        requestId: "00000000-0000-4000-8000-000000000004",
        action: "reject",
        expectedVersion: 2,
      },
    ],
  ] as const)(
    "requires a valid human reason for %s before Backend receives a command",
    async (name, command) => {
      const call = vi.fn() as unknown as OperatorCall;
      const endpoints = createCommunityEndpoints(call);
      for (const reason of [undefined, " ", "x".repeat(2001)])
        expect(
          (await invoke(endpoints, name, request({ ...command, reason })))
            .status,
        ).toBe(400);
      expect(call).not.toHaveBeenCalled();
    },
  );

  it.each(["delete-body", "remove-thread"] as const)(
    "forwards the explicit reason with the unchanged %s receipt and count",
    async (name) => {
      const call = vi.fn(async () => ({
        applied: true,
      })) as unknown as OperatorCall;
      const command = {
        id: `comment-${"a".repeat(32)}`,
        requestId: "00000000-0000-4000-8000-000000000004",
        reason: "  Explicit deletion review reason  ",
        ...(name === "remove-thread" ? { expectedAffectedCount: 3 } : {}),
      };
      expect(
        (await invoke(createCommunityEndpoints(call), name, request(command)))
          .status,
      ).toBe(200);
      const { id, ...body } = command;
      expect(call).toHaveBeenCalledExactlyOnceWith(
        "POST",
        `comments/${id}/${name}`,
        { ...body, reason: "Explicit deletion review reason" },
      );
    },
  );

  it("refuses an invalid Backend DTO without echoing private material", async () => {
    const call = vi.fn(async () => ({
      ...fixture(),
      notificationFailures: -1,
    })) as unknown as OperatorCall;
    const response = await invoke(
      createCommunityEndpoints(call),
      "read-report",
      request({ id: "report-synthetic" }),
    );
    expect(response).toEqual({
      status: 502,
      body: { ok: false, error: { code: "OPERATOR_RESPONSE_INVALID" } },
    });
  });

  it("downloads evidence only after Owner authentication and forces a private attachment", async () => {
    const call = vi.fn() as unknown as OperatorCall;
    const open = vi.fn(async () => ({
      status: 200 as const,
      contentType: "application/pdf",
      contentLength: "3",
      contentRange: null,
      acceptsRanges: false,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.close();
        },
      }),
    })) satisfies OperatorMediaCall;
    const endpoints = createCommunityEndpoints(call, undefined, open);
    const req = request({}, "automation");
    req.routeParams = {
      id: "report-synthetic",
      evidenceId: "evidence-synthetic",
    };
    const endpoint = endpoints.find(
      (route) =>
        route.path === "/community-moderation/report-evidence/:id/:evidenceId",
    )!;
    expect((await endpoint.handler(req)).status).toBe(403);
    expect(open).not.toHaveBeenCalled();
    req.user = request({}).user;
    const response = await endpoint.handler(req);
    expect(open).toHaveBeenCalledWith(
      "reports/report-synthetic/evidence/evidence-synthetic",
      null,
      undefined,
    );
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="report-evidence"',
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; sandbox",
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it("accepts bounded PDFs for evidence while rejecting executable documents", async () => {
    vi.stubEnv("COMMUNITY_OPERATOR_BASE_URL", "http://127.0.0.1:3451");
    vi.stubEnv("COMMUNITY_OPERATOR_TOKEN", "REPLACE_ME_SYNTHETIC_OPERATOR");
    const fetch = vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "Content-Type": "application/pdf", "Content-Length": "3" },
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const result = await openCommunityOperatorEvidence(
      "reports/report-synthetic/evidence/evidence-synthetic",
      null,
    );
    expect(result.contentType).toBe("application/pdf");
    await new Response(result.body).arrayBuffer();
    fetch.mockResolvedValueOnce(
      new Response("<script>synthetic</script>", {
        headers: { "Content-Type": "text/html" },
      }),
    );
    await expect(
      openCommunityOperatorEvidence(
        "reports/report-synthetic/evidence/evidence-synthetic",
        null,
      ),
    ).rejects.toMatchObject({ code: "OPERATOR_RESPONSE_INVALID" });
    fetch.mockResolvedValueOnce(
      new Response(new Uint8Array([1]), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Length": String(8 * 1024 * 1024 + 1),
        },
      }),
    );
    await expect(
      openCommunityOperatorEvidence(
        "reports/report-synthetic/evidence/evidence-synthetic",
        null,
      ),
    ).rejects.toMatchObject({ code: "OPERATOR_RESPONSE_INVALID" });
  });
});
