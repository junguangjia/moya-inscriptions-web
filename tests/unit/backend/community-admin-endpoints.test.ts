import {
  AUTHORSHIP_NOT_SET,
  CommunityOperatorError,
  OPERATOR_MEDIA_LIFETIME_MS,
  OPERATOR_MEDIA_MAXIMUM_BYTES,
  OPERATOR_MEDIA_TYPES,
  OPERATOR_MEDIA_WAIT_MS,
  OperatorFailure,
  WORK_PUBLISHING_LIMIT_FIELDS,
  authorshipLabel,
  capacityDesignationAllowed,
  coverPreview,
  createCommunityEndpoints,
  itemPreviewVariant,
  limitDisplayValue,
  openCommunityOperatorMedia,
  outcomeUnknown,
  publishingJobActions,
  readLimitInput,
  submissionDecidable,
  submissionUndecidableReason,
  submissionVariantKey,
} from "admin/community-endpoints";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  OperatorCall,
  OperatorMediaCall,
  OperatorMediaResponse,
} from "admin/community-endpoints";
import type { OperatorSubmissionMedia } from "@moya/contracts/internal/community-operator";
import type { Endpoint, PayloadRequest } from "payload";

/**
 * The real Payload endpoint handlers, with only the loopback transport
 * replaced by a recorder. This is the boundary the Owner's button reaches:
 * the complete request envelope is validated strictly, the id is mapped into
 * the Backend route, and only the validated command body is forwarded.
 */
const commentId = "comment-0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f01";
const userId = "user-0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f01";

const recorder = () => {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const call = vi.fn(
    async (method: string, path: string, body?: unknown): Promise<unknown> => {
      calls.push({ method, path, ...(body === undefined ? {} : { body }) });
      return { echoed: true };
    },
  ) as unknown as OperatorCall;
  return { call, calls };
};

const request = (
  body: unknown,
  role: "owner" | "automation" | null = "owner",
  options: { readonly withoutJson?: boolean } = {},
): PayloadRequest =>
  ({
    user: role === null ? null : { collection: "users", id: 1, role },
    ...(options.withoutJson ? {} : { json: async () => body }),
    payload: { logger: { error: vi.fn() } },
  }) as unknown as PayloadRequest;

const invoke = async (
  endpoints: Endpoint[],
  name: string,
  req: PayloadRequest,
) => {
  const endpoint = endpoints.find(
    (candidate) => candidate.path === `/community-moderation/${name}`,
  );
  if (endpoint === undefined) throw new Error(`no endpoint ${name}`);
  const response = await (
    endpoint.handler as (req: PayloadRequest) => Promise<Response>
  )(req);
  return { status: response.status, body: await response.json() };
};

describe("Admin community moderation endpoint boundary", () => {
  it("restricts the new user controls to Owner and rejects spoofed commands", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { call, calls } = recorder();
    const endpoints = createCommunityEndpoints(call);
    const command = {
      requestId: "00000000-0000-4000-8000-000000000004",
      id: userId,
      enabled: true,
      expectedVersion: 0,
    };
    for (const role of [null, "automation"] as const) {
      expect(
        (await invoke(endpoints, "read-users", request({}, role))).status,
      ).toBe(403);
      expect(
        (await invoke(endpoints, "recommend-user", request(command, role)))
          .status,
      ).toBe(403);
    }
    expect(
      (
        await invoke(
          endpoints,
          "recommend-user",
          request({ ...command, operator: "other" }),
        )
      ).status,
    ).toBe(400);
    expect(calls).toHaveLength(0);
    expect(
      (await invoke(endpoints, "recommend-user", request(command))).status,
    ).toBe(200);
    expect(calls).toEqual([
      { method: "PUT", path: "users/recommendation", body: command },
    ]);
  });

  it("approves through the complete envelope and forwards only the command body", async () => {
    const { call, calls } = recorder();
    const endpoints = createCommunityEndpoints(call);
    const result = await invoke(
      endpoints,
      "moderate-comment",
      request({ id: commentId, action: "approve" }),
    );
    expect(result).toEqual({
      status: 200,
      body: { ok: true, result: { echoed: true } },
    });
    expect(calls).toEqual([
      {
        method: "POST",
        path: `comments/${commentId}/moderation`,
        body: { action: "approve" },
      },
    ]);
  });

  it.each([
    ["extra field", { id: commentId, action: "approve", note: "x" }],
    ["missing id", { action: "approve" }],
    ["missing action", { id: commentId }],
    ["unknown action", { id: commentId, action: "delete" }],
    ["malformed id", { id: "comment-x", action: "approve" }],
    [
      "actor label",
      { id: commentId, action: "approve", operatorLabel: "owner" },
    ],
    ["non-object", "approve"],
  ])("rejects %s before any Backend call", async (_label, body) => {
    const { call, calls } = recorder();
    const endpoints = createCommunityEndpoints(call);
    const result = await invoke(endpoints, "moderate-comment", request(body));
    expect(result).toEqual({
      status: 400,
      body: { ok: false, error: { code: "COMMAND_INVALID" } },
    });
    expect(calls).toEqual([]);
  });

  it("covers hide, restore, reject and the user transitions the same way", async () => {
    const { call, calls } = recorder();
    const endpoints = createCommunityEndpoints(call);
    for (const action of ["reject", "hide", "unhide"] as const)
      await invoke(
        endpoints,
        "moderate-comment",
        request({ id: commentId, action }),
      );
    for (const action of ["suspend", "reinstate"] as const)
      await invoke(endpoints, "moderate-user", request({ id: userId, action }));
    expect(calls).toEqual([
      {
        method: "POST",
        path: `comments/${commentId}/moderation`,
        body: { action: "reject" },
      },
      {
        method: "POST",
        path: `comments/${commentId}/moderation`,
        body: { action: "hide" },
      },
      {
        method: "POST",
        path: `comments/${commentId}/moderation`,
        body: { action: "unhide" },
      },
      {
        method: "POST",
        path: `users/${userId}/status`,
        body: { action: "suspend" },
      },
      {
        method: "POST",
        path: `users/${userId}/status`,
        body: { action: "reinstate" },
      },
    ]);
    expect(
      (
        await invoke(
          endpoints,
          "moderate-user",
          request({ id: commentId, action: "suspend" }),
        )
      ).status,
    ).toBe(400);
  });

  it("bounds a selection to fifty distinct ids and forwards it as one command", async () => {
    const { call, calls } = recorder();
    const endpoints = createCommunityEndpoints(call);
    const ids = Array.from(
      { length: 50 },
      (_value, index) => `comment-${index.toString(16).padStart(32, "0")}`,
    );
    expect(
      (
        await invoke(
          endpoints,
          "moderate-comments",
          request({ action: "hide", ids }),
        )
      ).status,
    ).toBe(200);
    expect(calls).toEqual([
      {
        method: "POST",
        path: "comments/moderation",
        body: { action: "hide", ids },
      },
    ]);
    for (const body of [
      { action: "hide", ids: [...ids, `comment-${"f".repeat(32)}`] },
      { action: "hide", ids: [ids[0], ids[0]] },
      { action: "hide", ids: [] },
      { action: "hide", ids, all: true },
    ])
      expect(
        (await invoke(endpoints, "moderate-comments", request(body))).status,
      ).toBe(400);
    expect(calls).toHaveLength(1);
  });

  it("maps the queue, detail, history and summary queries onto the Backend routes", async () => {
    const { call, calls } = recorder();
    const endpoints = createCommunityEndpoints(call);
    await invoke(
      endpoints,
      "read-comments",
      request({
        moderation: "pending",
        search: "字口",
        order: "oldest",
        page: 2,
        pageSize: 50,
      }),
    );
    await invoke(endpoints, "read-comment", request({ id: commentId }));
    await invoke(
      endpoints,
      "read-events",
      request({ subjectId: commentId, page: 3 }),
    );
    await invoke(endpoints, "read-summary", request({ range: "30d" }));
    await invoke(endpoints, "read-summary", request({}));
    expect(calls).toEqual([
      {
        method: "GET",
        path: "comments?moderation=pending&search=%E5%AD%97%E5%8F%A3&order=oldest&page=2&pageSize=50",
      },
      { method: "GET", path: `comments/${commentId}` },
      {
        method: "GET",
        path: `moderation-events?subjectId=${commentId}&page=3`,
      },
      { method: "GET", path: "summary?range=30d" },
      { method: "GET", path: "summary" },
    ]);
    for (const [name, body] of [
      ["read-comments", { moderation: "spam" }],
      ["read-comments", { search: "x".repeat(101) }],
      ["read-comments", { pageSize: 51 }],
      ["read-comment", { id: "nope" }],
      ["read-summary", { range: "1y" }],
    ] as const)
      expect((await invoke(endpoints, name, request(body))).status).toBe(400);
  });

  it("refuses every non-Owner caller and a missing JSON body before calling the Backend", async () => {
    const { call, calls } = recorder();
    const endpoints = createCommunityEndpoints(call);
    for (const role of ["automation", null] as const)
      expect(
        await invoke(
          endpoints,
          "moderate-comment",
          request({ id: commentId, action: "approve" }, role),
        ),
      ).toEqual({
        status: 403,
        body: { ok: false, error: { code: "COMMUNITY_OWNER_ONLY" } },
      });
    expect(
      await invoke(
        endpoints,
        "moderate-comment",
        request(undefined, "owner", { withoutJson: true }),
      ),
    ).toEqual({
      status: 400,
      body: { ok: false, error: { code: "JSON_BODY_REQUIRED" } },
    });
    expect(calls).toEqual([]);
  });

  it("passes the Backend's conflict and not-found answers through as their own codes", async () => {
    const failing = vi.fn(async (_method: string, path: string) => {
      throw new CommunityOperatorError(
        path.endsWith("/moderation") ? "STATE_CONFLICT" : "NOT_FOUND",
        path.endsWith("/moderation") ? 409 : 404,
      );
    }) as unknown as OperatorCall;
    const endpoints = createCommunityEndpoints(failing);
    expect(
      await invoke(
        endpoints,
        "moderate-comment",
        request({ id: commentId, action: "hide" }),
      ),
    ).toEqual({
      status: 409,
      body: { ok: false, error: { code: "STATE_CONFLICT" } },
    });
    expect(
      await invoke(endpoints, "read-comment", request({ id: commentId })),
    ).toEqual({
      status: 404,
      body: { ok: false, error: { code: "NOT_FOUND" } },
    });
  });
});

describe("Phase 4 Owner command envelopes", () => {
  afterEach(() => vi.unstubAllEnvs());
  const receipt = "4155b8f6-88e1-49fa-8981-a204b9efc401";
  it.each([
    [
      "moderate-work",
      {
        id: "work-" + "1".repeat(32),
        requestId: receipt,
        state: "hidden",
        expectedVersion: 2,
      },
      "POST",
      "works/work-" + "1".repeat(32) + "/moderation",
    ],
    [
      "delete-body",
      { id: commentId, requestId: receipt },
      "POST",
      `comments/${commentId}/delete-body`,
    ],
    [
      "remove-thread",
      { id: commentId, requestId: receipt, expectedAffectedCount: 4 },
      "POST",
      `comments/${commentId}/remove-thread`,
    ],
    [
      "set-featured",
      {
        requestId: receipt,
        target: { type: "work", id: "work-" + "1".repeat(32) },
        enabled: true,
        position: 1000,
        expectedVersion: 0,
      },
      "PUT",
      "featured",
    ],
    [
      "set-featured-quantity",
      { requestId: receipt, enabledQuantity: null, expectedVersion: 1 },
      "PUT",
      "featured/settings",
    ],
  ])(
    "validates %s through Owner-only Development and Production transport",
    async (name, body, method, path) => {
      vi.stubEnv("NODE_ENV", "development");
      const { call, calls } = recorder();
      const endpoints = createCommunityEndpoints(call);
      expect(
        (await invoke(endpoints, String(name), request(body, "automation")))
          .status,
      ).toBe(403);
      expect(calls).toEqual([]);
      expect(
        (
          await invoke(
            endpoints,
            String(name),
            request({ ...(body as object), actor: "owner" }),
          )
        ).status,
      ).toBe(400);
      expect(calls).toEqual([]);
      expect(
        (await invoke(endpoints, String(name), request(body))).status,
      ).toBe(200);
      expect(calls[0]).toMatchObject({ method, path });
      expect(calls[0]?.body).not.toHaveProperty("id");
      vi.stubEnv("NODE_ENV", "production");
      for (const role of ["automation", null] as const)
        expect(
          (await invoke(endpoints, String(name), request(body, role))).status,
        ).toBe(403);
      expect(calls).toHaveLength(1);
      expect(
        (await invoke(endpoints, String(name), request(body))).status,
      ).toBe(200);
      expect(calls).toHaveLength(2);
      expect(calls[1]).toEqual(calls[0]);
    },
  );
  it("preserves unbounded business quantity and rejects invalid sequence/count controls", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { call, calls } = recorder();
    const endpoints = createCommunityEndpoints(call);
    for (const enabledQuantity of [-1, 1.5, "10"]) {
      expect(
        (
          await invoke(
            endpoints,
            "set-featured-quantity",
            request({
              requestId: receipt,
              enabledQuantity,
              expectedVersion: 1,
            }),
          )
        ).status,
      ).toBe(400);
    }
    expect(
      (
        await invoke(
          endpoints,
          "remove-thread",
          request({
            id: commentId,
            requestId: receipt,
            expectedAffectedCount: 0,
          }),
        )
      ).status,
    ).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe("Production Thread and direct-message administration", () => {
  afterEach(() => vi.unstubAllEnvs());
  const otherUserId = `user-${"b".repeat(32)}`;
  it.each([
    {
      name: "read-threads",
      input: {},
      method: "GET",
      path: "threads?page=1&pageSize=20&includeHidden=true",
      answer: { items: [], total: 0, page: 1, pageSize: 20 },
    },
    {
      name: "lookup-dm-conversation",
      input: { userIds: [userId, otherUserId], purpose: "Owner report review" },
      method: "POST",
      path: "messages/lookup",
      answer: {
        id: `dm-${"c".repeat(32)}`,
        participants: [
          { id: userId, displayName: "First author", status: "active" },
          { id: otherUserId, displayName: "Second author", status: "active" },
        ],
        initiatorId: userId,
        state: "active",
        messageCount: 0,
        createdAt: "2026-10-02T00:00:00.000Z",
        messages: [],
      },
    },
  ])(
    "forwards $name only for the Owner with a valid envelope",
    async ({ name, input, method, path, answer }) => {
      vi.stubEnv("NODE_ENV", "production");
      const call = vi.fn(async () => answer) as unknown as OperatorCall;
      const endpoints = createCommunityEndpoints(call);
      for (const role of ["automation", null] as const)
        expect(
          (await invoke(endpoints, name, request(input, role))).status,
        ).toBe(403);
      expect(
        (await invoke(endpoints, name, request({ ...input, actor: "owner" })))
          .status,
      ).toBe(400);
      expect(call).not.toHaveBeenCalled();
      expect(await invoke(endpoints, name, request(input))).toEqual({
        status: 200,
        body: { ok: true, result: answer },
      });
      if (method === "POST")
        expect(call).toHaveBeenCalledWith(method, path, input);
      else expect(call).toHaveBeenCalledWith(method, path);
    },
  );
});

describe("Work publishing Owner envelopes", () => {
  afterEach(() => vi.unstubAllEnvs());
  const receipt = "7c1d7f0e-5b8a-4a51-9d0c-2f3e4a5b6c7d";
  const timestamp = "2026-09-13T12:00:00.000Z";
  const revisionId = `work-revision-${"a".repeat(32)}`;
  const itemId = `media-item-${"b".repeat(32)}`;
  const workId = `work-${"1".repeat(32)}`;
  const jobId = `publishing-job-${"d".repeat(32)}`;
  const limits = {
    maxItemsPerWork: 50,
    originalItemMaxBytes: 134217728,
    standardComponentMaxBytes: 268435456,
    ordinaryAccountCapacityBytes: 10737418240,
    ownerAccountCapacityBytes: 21474836480,
    maxActiveDrafts: 100,
    dailyNewWorkLimit: 100,
    historyLimit: 20,
    trashRetentionDays: 30,
    orphanGraceDays: 7,
    unsavedSessionLeaseMinutes: 360,
  };
  const settings = {
    policy: "DIRECT_PUBLICATION",
    ...limits,
    version: 3,
    updatedAt: timestamp,
    updatedBy: "owner",
  };
  const submission = {
    revisionId,
    workId,
    sequence: 2,
    origin: "submission",
    author: {
      id: userId,
      handle: "dev-user-02",
      displayName: "测试作者",
      status: "active",
    },
    title: "临兰亭",
    body: "第一行\n第二行",
    authorship: { kind: "copy_practice", referenceTitle: "兰亭序" },
    coverItemId: itemId,
    coverCrop: { x: 0, y: 0.25, width: 1, height: 0.5 },
    items: [
      {
        position: 1,
        itemId,
        kind: "live",
        qualityMode: "original",
        state: "ready",
        edit: { rotation: 90, crop: null },
        editKey: "c".repeat(32),
        coverEditKey: "e".repeat(32),
        presentation: {
          width: 1920,
          height: 1440,
          durationMs: 3000,
          hasAudio: true,
        },
        variants: ["thumb", "display", "motion"],
      },
    ],
    disposition: "pending",
    latest: true,
    workState: "visible",
    workTrashed: false,
    submittedAt: timestamp,
    decidedAt: null,
    decidedBy: null,
    version: 4,
  };
  const capacity = {
    accountId: userId,
    capacityClass: "owner",
    capacityBytes: 21474836480,
    committedBytes: 1048576,
    reservedBytes: 0,
    version: 1,
    updatedAt: timestamp,
  };
  const job = {
    id: jobId,
    kind: "purge_blob",
    subjectId: `media-blob-${"e".repeat(32)}`,
    state: "failed",
    attempts: 5,
    maxAttempts: 5,
    runAfter: timestamp,
    leaseExpiresAt: null,
    lastErrorCode: "store_unavailable",
    createdAt: timestamp,
    updatedAt: timestamp,
    finishedAt: timestamp,
  };
  const page = <Item>(items: Item[]) => ({
    items,
    total: items.length,
    page: 1,
    pageSize: 20,
    totalPages: 1,
  });
  const answer = (_method: string, path: string): unknown =>
    path === "publishing/settings"
      ? settings
      : path.startsWith("publishing/submissions?")
        ? page([submission])
        : path.endsWith("/moderation")
          ? { revisionId, workId, disposition: "approved", version: 5 }
          : path.startsWith("publishing/submissions/")
            ? submission
            : path.endsWith("/capacity")
              ? capacity
              : path.startsWith("publishing/jobs?")
                ? page([job])
                : path.endsWith("/retry")
                  ? { ...job, state: "queued", attempts: 0, finishedAt: null }
                  : path.endsWith("/abandon")
                    ? { ...job, state: "abandoned" }
                    : { echoed: true };
  const answering = (reply: typeof answer = answer) => {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    const call = vi.fn(async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, ...(body === undefined ? {} : { body }) });
      return reply(method, path);
    }) as unknown as OperatorCall;
    return { call, calls };
  };
  const setSettings = {
    requestId: receipt,
    expectedVersion: 3,
    policy: "PRE_MODERATION",
    ...limits,
  };

  it.each([
    [
      "read-work-publishing-settings",
      {},
      "GET",
      "publishing/settings",
      undefined,
    ],
    [
      "set-work-publishing-settings",
      setSettings,
      "PUT",
      "publishing/settings",
      setSettings,
    ],
    [
      "read-work-submissions",
      { state: "pending", page: 2, pageSize: 50 },
      "GET",
      "publishing/submissions?state=pending&page=2&pageSize=50",
      undefined,
    ],
    [
      "read-work-submissions",
      {},
      "GET",
      "publishing/submissions?page=1&pageSize=20",
      undefined,
    ],
    [
      "read-work-submission",
      { id: revisionId },
      "GET",
      `publishing/submissions/${revisionId}`,
      undefined,
    ],
    [
      "moderate-work-submission",
      {
        id: revisionId,
        requestId: receipt,
        action: "approve",
        expectedVersion: 4,
      },
      "POST",
      `publishing/submissions/${revisionId}/moderation`,
      { requestId: receipt, action: "approve", expectedVersion: 4 },
    ],
    [
      "read-account-capacity",
      { accountId: userId },
      "GET",
      `publishing/accounts/${userId}/capacity`,
      undefined,
    ],
    [
      "set-account-capacity",
      {
        accountId: userId,
        requestId: receipt,
        capacityClass: "owner",
        expectedVersion: 0,
      },
      "PUT",
      `publishing/accounts/${userId}/capacity`,
      { requestId: receipt, capacityClass: "owner", expectedVersion: 0 },
    ],
    [
      "read-publishing-jobs",
      { state: "failed", kind: "purge_blob" },
      "GET",
      "publishing/jobs?state=failed&kind=purge_blob&page=1&pageSize=20",
      undefined,
    ],
    [
      "retry-publishing-job",
      { id: jobId, requestId: receipt },
      "POST",
      `publishing/jobs/${jobId}/retry`,
      { requestId: receipt },
    ],
    [
      "abandon-publishing-job",
      { id: jobId, requestId: receipt },
      "POST",
      `publishing/jobs/${jobId}/abandon`,
      { requestId: receipt },
    ],
  ])(
    "maps %s onto the Backend route, Owner-only in Development and Production",
    async (name, body, method, path, forwarded) => {
      vi.stubEnv("NODE_ENV", "development");
      const { call, calls } = answering();
      const endpoints = createCommunityEndpoints(call);
      for (const role of ["automation", null] as const)
        expect(await invoke(endpoints, name, request(body, role))).toEqual({
          status: 403,
          body: { ok: false, error: { code: "COMMUNITY_OWNER_ONLY" } },
        });
      expect(
        (
          await invoke(
            endpoints,
            name,
            request({ ...(body as object), actor: "owner" }),
          )
        ).status,
      ).toBe(400);
      expect(calls).toEqual([]);
      const result = await invoke(endpoints, name, request(body));
      expect(result.status).toBe(200);
      expect(result.body.ok).toBe(true);
      expect(calls).toEqual([
        {
          method,
          path,
          ...(forwarded === undefined ? {} : { body: forwarded }),
        },
      ]);
      expect(calls[0]?.body ?? {}).not.toHaveProperty("id");
      expect(calls[0]?.body ?? {}).not.toHaveProperty("accountId");
      vi.stubEnv("NODE_ENV", "production");
      for (const role of ["automation", null] as const)
        expect(await invoke(endpoints, name, request(body, role))).toEqual({
          status: 403,
          body: { ok: false, error: { code: "COMMUNITY_OWNER_ONLY" } },
        });
      expect(calls).toHaveLength(1);
      const production = await invoke(endpoints, name, request(body));
      expect(production.status).toBe(200);
      expect(production.body.ok).toBe(true);
      expect(calls).toHaveLength(2);
      expect(calls[1]).toEqual(calls[0]);
    },
  );

  it.each([
    ["read-work-publishing-settings", { page: 1 }],
    [
      "set-work-publishing-settings",
      { ...setSettings, expectedVersion: undefined },
    ],
    ["set-work-publishing-settings", { ...setSettings, policy: "HOLD" }],
    ["set-work-publishing-settings", { ...setSettings, requestId: "retry-1" }],
    ["set-work-publishing-settings", { ...setSettings, maxItemsPerWork: 0 }],
    ["set-work-publishing-settings", { ...setSettings, maxItemsPerWork: 101 }],
    [
      "set-work-publishing-settings",
      { ...setSettings, originalItemMaxBytes: 1048576.5 },
    ],
    ["set-work-publishing-settings", { ...setSettings, historyLimit: "20" }],
    ["set-work-publishing-settings", { ...setSettings, updatedBy: "owner" }],
    ["read-work-submissions", { state: "not_required" }],
    ["read-work-submissions", { pageSize: 51 }],
    ["read-work-submissions", { search: "兰亭" }],
    ["read-work-submission", { id: "work-revision-x" }],
    ["read-work-submission", { id: workId }],
    [
      "moderate-work-submission",
      {
        id: revisionId,
        requestId: receipt,
        action: "hide",
        expectedVersion: 4,
      },
    ],
    [
      "moderate-work-submission",
      { id: revisionId, action: "approve", expectedVersion: 4 },
    ],
    [
      "moderate-work-submission",
      { id: revisionId, requestId: receipt, action: "reject" },
    ],
    [
      "moderate-work-submission",
      {
        id: revisionId,
        requestId: receipt,
        action: "reject",
        expectedVersion: 4,
        note: "x",
      },
    ],
    ["read-account-capacity", { accountId: "dev-user-02" }],
    [
      "set-account-capacity",
      {
        accountId: userId,
        requestId: receipt,
        capacityClass: "admin",
        expectedVersion: 0,
      },
    ],
    [
      "set-account-capacity",
      {
        accountId: userId,
        requestId: receipt,
        capacityClass: "owner",
        expectedVersion: 0,
        capacityBytes: 1,
      },
    ],
    [
      "set-account-capacity",
      {
        handle: "owner",
        requestId: receipt,
        capacityClass: "owner",
        expectedVersion: 0,
      },
    ],
    ["read-publishing-jobs", { state: "lost" }],
    [
      "retry-publishing-job",
      { id: jobId, requestId: receipt, action: "abandon" },
    ],
    ["abandon-publishing-job", { id: "publishing-job-x", requestId: receipt }],
    ["abandon-publishing-job", { id: jobId }],
  ])(
    "rejects a malformed %s envelope before any Backend call",
    async (name, body) => {
      vi.stubEnv("NODE_ENV", "development");
      const { call, calls } = answering();
      const endpoints = createCommunityEndpoints(call);
      expect(await invoke(endpoints, name, request(body))).toEqual({
        status: 400,
        body: { ok: false, error: { code: "COMMAND_INVALID" } },
      });
      expect(calls).toEqual([]);
    },
  );

  it("relays a submission that declares no authorship and labels it as not set", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const legacy = {
      ...submission,
      origin: "legacy",
      disposition: "approved",
      authorship: null,
    };
    const { call } = answering((_method, path) =>
      path.startsWith("publishing/submissions?") ? page([legacy]) : legacy,
    );
    const endpoints = createCommunityEndpoints(call);
    for (const [name, body] of [
      ["read-work-submission", { id: revisionId }],
      ["read-work-submissions", {}],
    ] as const) {
      const result = await invoke(endpoints, name, request(body));
      expect(result.status, name).toBe(200);
      expect(JSON.stringify(result.body), name).toContain('"authorship":null');
    }
    expect(AUTHORSHIP_NOT_SET).toBe("未设置");
    expect(authorshipLabel(null)).toBe("未设置");
    expect(authorshipLabel({ kind: "original" })).toBe("原创");
    expect(
      authorshipLabel({ kind: "copy_practice", referenceTitle: "兰亭序" }),
    ).toBe("临摹或练习");
    // An absent authorship is outside the contract; nothing defaults to original.
    const withoutAuthorship: Partial<typeof submission> = { ...submission };
    delete withoutAuthorship.authorship;
    const refusing = createCommunityEndpoints(
      answering(() => withoutAuthorship).call,
    );
    expect(
      (
        await invoke(
          refusing,
          "read-work-submission",
          request({ id: revisionId }),
        )
      ).status,
    ).toBe(502);
  });

  it("refuses a Backend answer outside the operator contract without echoing or logging it", async () => {
    vi.stubEnv("NODE_ENV", "development");
    for (const [name, body, reply] of [
      [
        "read-work-submission",
        { id: revisionId },
        { ...submission, requestedVisibility: "public" },
      ],
      [
        "read-work-submissions",
        {},
        page([{ ...submission, disposition: "not_required" }]),
      ],
      [
        "read-work-submission",
        { id: revisionId },
        {
          ...submission,
          items: [{ ...submission.items[0], variants: ["original"] }],
        },
      ],
      ["read-work-publishing-settings", {}, { ...settings, version: -1 }],
      ["read-publishing-jobs", {}, page([{ ...job, payload: { path: "/x" } }])],
      [
        "retry-publishing-job",
        { id: jobId, requestId: receipt },
        { echoed: true },
      ],
      [
        "retry-publishing-job",
        { id: jobId, requestId: receipt },
        { ...job, state: "queued", message: "兰亭 /srv/media/x.heic" },
      ],
      [
        "abandon-publishing-job",
        { id: jobId, requestId: receipt },
        { ...job, state: "abandoned", lastErrorCode: "ENOENT: /srv/兰亭" },
      ],
    ] as const) {
      const { call } = answering(() => reply);
      const endpoints = createCommunityEndpoints(call);
      const req = request(body);
      const result = await invoke(endpoints, name, req);
      expect(result).toEqual({
        status: 502,
        body: { ok: false, error: { code: "OPERATOR_RESPONSE_INVALID" } },
      });
      expect(JSON.stringify(result.body)).not.toContain("兰亭");
      expect(
        (req.payload.logger.error as ReturnType<typeof vi.fn>).mock.calls,
      ).toEqual([]);
    }
  });

  it("passes stale versions and missing subjects through as conflict and not-found", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const failing = vi.fn(async (method: string) => {
      throw method === "GET"
        ? new CommunityOperatorError("NOT_FOUND", 404)
        : new CommunityOperatorError("STATE_CONFLICT", 409);
    }) as unknown as OperatorCall;
    const endpoints = createCommunityEndpoints(failing);
    const conflict = {
      status: 409,
      body: { ok: false, error: { code: "STATE_CONFLICT" } },
    };
    expect(
      await invoke(
        endpoints,
        "moderate-work-submission",
        request({
          id: revisionId,
          requestId: receipt,
          action: "approve",
          expectedVersion: 3,
        }),
      ),
    ).toEqual(conflict);
    expect(
      await invoke(
        endpoints,
        "set-work-publishing-settings",
        request(setSettings),
      ),
    ).toEqual(conflict);
    expect(
      await invoke(
        endpoints,
        "set-account-capacity",
        request({
          accountId: userId,
          requestId: receipt,
          capacityClass: "ordinary",
          expectedVersion: 2,
        }),
      ),
    ).toEqual(conflict);
    expect(
      await invoke(
        endpoints,
        "retry-publishing-job",
        request({ id: jobId, requestId: receipt }),
      ),
    ).toEqual(conflict);
    expect(
      await invoke(
        endpoints,
        "read-account-capacity",
        request({ accountId: userId }),
      ),
    ).toEqual({
      status: 404,
      body: { ok: false, error: { code: "NOT_FOUND" } },
    });
  });

  it("keeps every editable limit inside the settings contract at both edges", async () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(
      WORK_PUBLISHING_LIMIT_FIELDS.map((field) => field.name).sort(),
    ).toEqual(Object.keys(limits).sort());
    const { call, calls } = answering();
    const endpoints = createCommunityEndpoints(call);
    let accepted = 0;
    for (const field of WORK_PUBLISHING_LIMIT_FIELDS) {
      // The field bounds are the contract bounds, to the byte.
      for (const value of [field.minimum, field.maximum]) {
        const result = await invoke(
          endpoints,
          "set-work-publishing-settings",
          request({ ...setSettings, [field.name]: value }),
        );
        expect(result.status, `${field.name}=${value}`).toBe(200);
        accepted += 1;
      }
      for (const value of [field.minimum - 1, field.maximum + 1]) {
        const result = await invoke(
          endpoints,
          "set-work-publishing-settings",
          request({ ...setSettings, [field.name]: value }),
        );
        expect(result.status, `${field.name}=${value}`).toBe(400);
      }
      // Both edges are reachable by typing, and one step beyond is refused.
      const read = (value: number) =>
        readLimitInput(
          field,
          limitDisplayValue(field, value),
          limits[field.name],
          true,
        );
      expect(read(field.minimum), field.name).toEqual({
        ok: true,
        value: field.minimum,
      });
      expect(read(field.maximum), field.name).toEqual({
        ok: true,
        value: field.maximum,
      });
      expect(read(field.minimum - field.step).ok, field.name).toBe(false);
      expect(read(field.maximum + field.step).ok, field.name).toBe(false);
    }
    expect(calls).toHaveLength(accepted);
  });

  it("reads an untouched limit exactly and an edited one in whole steps", () => {
    const field = (name: string) =>
      WORK_PUBLISHING_LIMIT_FIELDS.find(
        (candidate) => candidate.name === name,
      )!;
    const original = field("originalItemMaxBytes");
    const capacity = field("ordinaryAccountCapacityBytes");
    const drafts = field("maxActiveDrafts");
    const mib = 1024 * 1024;
    // Untouched: the stored value is kept, however it displays.
    expect(readLimitInput(original, "128.5", 134742016, false)).toEqual({
      ok: true,
      value: 134742016,
    });
    expect(readLimitInput(original, "anything", 134217729, false)).toEqual({
      ok: true,
      value: 134217729,
    });
    // A stored value that displays as "128" can still be set to exactly 128 MiB.
    expect(limitDisplayValue(original, 134217729)).toBe("128");
    expect(readLimitInput(original, "128", 134217729, true)).toEqual({
      ok: true,
      value: 128 * mib,
    });
    expect(readLimitInput(original, "128.5", 134742016, true).ok).toBe(false);
    expect(readLimitInput(original, "8193", 134742016, true).ok).toBe(false);
    expect(readLimitInput(original, "-1", 134742016, true).ok).toBe(false);
    // Capacities: GiB with up to three decimals, stored in whole MiB.
    expect(limitDisplayValue(capacity, 512 * mib)).toBe("0.5");
    expect(readLimitInput(capacity, "0.25", 512 * mib, true)).toEqual({
      ok: true,
      value: 256 * mib,
    });
    expect(readLimitInput(capacity, "0.001", 512 * mib, true)).toEqual({
      ok: true,
      value: mib,
    });
    expect(readLimitInput(capacity, "0", 512 * mib, true).ok).toBe(false);
    expect(readLimitInput(capacity, "1.0001", 512 * mib, true).ok).toBe(false);
    expect(readLimitInput(capacity, "1e3", 512 * mib, true).ok).toBe(false);
    expect(readLimitInput(drafts, "10.5", 100, true).ok).toBe(false);
    expect(readLimitInput(drafts, " 250 ", 100, true)).toEqual({
      ok: true,
      value: 250,
    });
  });
});

describe("Work publishing view rules", () => {
  const itemId = (n: number) => `media-item-${String(n).repeat(32)}`;
  const media = (
    n: number,
    variants: OperatorSubmissionMedia["variants"],
  ): OperatorSubmissionMedia => ({
    position: n,
    itemId: itemId(n),
    kind: "static",
    qualityMode: "standard",
    state: "ready",
    edit: { rotation: 0, crop: null },
    editKey: "base",
    coverEditKey: null,
    presentation: { width: 100, height: 100 },
    variants,
  });

  it("offers a decision only on the latest pending submission of a work outside the recycle bin", () => {
    const pending = {
      disposition: "pending",
      latest: true,
      workTrashed: false,
    } as const;
    expect(submissionDecidable(pending)).toBe(true);
    expect(submissionUndecidableReason(pending)).toBeNull();
    for (const blocked of [
      { ...pending, latest: false },
      { ...pending, workTrashed: true },
    ]) {
      expect(submissionDecidable(blocked)).toBe(false);
      expect(submissionUndecidableReason(blocked)).not.toBeNull();
    }
    for (const disposition of [
      "approved",
      "rejected",
      "superseded",
      "withdrawn",
    ] as const) {
      expect(submissionDecidable({ ...pending, disposition })).toBe(false);
      expect(submissionUndecidableReason({ ...pending, disposition })).toBe(
        null,
      );
    }
  });

  it("offers job actions exactly where the operator port allows them", () => {
    expect(publishingJobActions("failed")).toEqual(["retry", "abandon"]);
    expect(publishingJobActions("abandoned")).toEqual(["retry"]);
    expect(publishingJobActions("queued")).toEqual(["abandon"]);
    expect(publishingJobActions("running")).toEqual([]);
    expect(publishingJobActions("succeeded")).toEqual([]);
  });

  it("designates capacity only for the loaded current account, verified for Owner", () => {
    const account = `user-${"a".repeat(32)}`;
    const ready = {
      account,
      capacity: { accountId: account, capacityClass: "ordinary" },
      choice: "owner",
      verified: true,
      loading: false,
      busy: false,
      retryPending: false,
    } as const;
    expect(capacityDesignationAllowed(ready)).toBe(true);
    expect(
      capacityDesignationAllowed({
        ...ready,
        capacity: { accountId: account, capacityClass: "owner" },
        choice: "ordinary",
        verified: false,
      }),
    ).toBe(true);
    for (const blocked of [
      { ...ready, verified: false },
      { ...ready, account: `user-${"b".repeat(32)}` },
      { ...ready, account: null },
      { ...ready, capacity: null },
      { ...ready, loading: true },
      { ...ready, busy: true },
      { ...ready, retryPending: true },
      { ...ready, choice: null },
      { ...ready, choice: "ordinary" },
    ] as const)
      expect(capacityDesignationAllowed(blocked), JSON.stringify(blocked)).toBe(
        false,
      );
  });

  it("requests thumb and cover of the cover item with its cover edit key, never the item's edit key", () => {
    const crop = { x: 0, y: 0.25, width: 1, height: 0.5 };
    const all: OperatorSubmissionMedia["variants"] = [
      "thumb",
      "display",
      "cover",
    ];
    const coverKey = "d".repeat(32);
    const cover = { ...media(1, all), coverEditKey: coverKey };
    const other = media(2, all);
    const cropped = { coverItemId: cover.itemId, coverCrop: crop };
    // Display, full and motion use the edit key; thumb and cover of the cover
    // item use the cover key; other items use their edit key throughout.
    for (const variant of ["display", "full", "motion"] as const)
      expect(submissionVariantKey(cropped, cover, variant)).toBe("base");
    expect(submissionVariantKey(cropped, cover, "thumb")).toBe(coverKey);
    expect(submissionVariantKey(cropped, cover, "cover")).toBe(coverKey);
    expect(submissionVariantKey(cropped, other, "thumb")).toBe("base");
    // A cropped cover item without a described cover key is never guessed.
    expect(
      submissionVariantKey(cropped, { ...cover, coverEditKey: null }, "cover"),
    ).toBeNull();
    // Tiles show the album image: the cropped cover item's thumb is the card crop.
    expect(itemPreviewVariant(cropped, cover, "tile")).toBe("display");
    expect(itemPreviewVariant(cropped, cover, "preview")).toBe("display");
    expect(itemPreviewVariant(cropped, other, "tile")).toBe("thumb");
    expect(itemPreviewVariant(cropped, media(1, ["thumb"]), "tile")).toBeNull();
    // The card cover: its own cover derivative under the cover key, no outline.
    expect(
      coverPreview({ ...cropped, items: [cover, other] })?.preview,
    ).toEqual({ variant: "cover", editKey: coverKey, outline: false });
    expect(
      coverPreview({
        ...cropped,
        items: [{ ...cover, variants: ["thumb", "display"] }],
      })?.preview,
    ).toEqual({ variant: "display", editKey: "base", outline: true });
    expect(
      coverPreview({ ...cropped, items: [{ ...cover, variants: ["thumb"] }] })
        ?.preview,
    ).toEqual({ variant: "thumb", editKey: coverKey, outline: false });
    expect(
      coverPreview({
        ...cropped,
        items: [{ ...cover, coverEditKey: null, variants: ["thumb", "cover"] }],
      })?.preview,
    ).toBeNull();
    // Without a crop the cover key equals the edit key.
    const uncropped = { coverItemId: cover.itemId, coverCrop: null };
    const plain = { ...media(1, all), coverEditKey: "base" };
    expect(itemPreviewVariant(uncropped, plain, "tile")).toBe("thumb");
    expect(coverPreview({ ...uncropped, items: [plain] })).toMatchObject({
      chosen: true,
      preview: { variant: "cover", editKey: "base", outline: false },
    });
    // No chosen cover: the card uses the first item.
    expect(
      coverPreview({
        coverItemId: null,
        coverCrop: null,
        items: [media(2, ["display"]), media(1, ["thumb"])],
      }),
    ).toMatchObject({
      item: { position: 1 },
      chosen: false,
      preview: { variant: "thumb", editKey: "base", outline: false },
    });
    expect(
      coverPreview({ coverItemId: itemId(9), coverCrop: null, items: [cover] }),
    ).toBeNull();
  });

  it("offers the same request again only when its outcome is unknown", () => {
    const failure = (code: string, status: number | null) =>
      new OperatorFailure(code, code, status);
    expect(outcomeUnknown(failure("OPERATOR_UNREACHABLE", null))).toBe(true);
    expect(outcomeUnknown(failure("OPERATOR_UNAVAILABLE", 503))).toBe(true);
    expect(outcomeUnknown(failure("OPERATION_FAILED", 502))).toBe(true);
    expect(outcomeUnknown(failure("OPERATION_FAILED", 500))).toBe(true);
    for (const [code, status] of [
      ["OPERATION_FAILED", 400],
      ["OPERATION_FAILED", 422],
      ["STATE_CONFLICT", 409],
      ["NOT_FOUND", 404],
      ["COMMAND_INVALID", 400],
      ["OPERATOR_RESPONSE_INVALID", 502],
      ["COMMUNITY_OWNER_ONLY", 403],
      ["OPERATOR_UNAUTHORIZED", 502],
      ["OPERATOR_NOT_CONFIGURED", 503],
    ] as const)
      expect(outcomeUnknown(failure(code, status)), code).toBe(false);
  });

  it("keeps a Backend refusal distinguishable from a lost answer", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("COMMUNITY_OPERATOR_BASE_URL", "http://127.0.0.1:3999");
    vi.stubEnv("COMMUNITY_OPERATOR_TOKEN", "t".repeat(40));
    try {
      for (const [status, relayed] of [
        [400, 400],
        [422, 422],
        [500, 502],
      ] as const) {
        vi.stubGlobal(
          "fetch",
          vi.fn(async () =>
            Response.json({ error: { status, code: "X" } }, { status }),
          ),
        );
        const result = await invoke(
          createCommunityEndpoints(),
          "retry-publishing-job",
          request({
            id: `publishing-job-${"d".repeat(32)}`,
            requestId: "7c1d7f0e-5b8a-4a51-9d0c-2f3e4a5b6c7d",
          }),
        );
        expect(result).toEqual({
          status: relayed,
          body: { ok: false, error: { code: "OPERATION_FAILED" } },
        });
      }
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });
});

describe("Work submission media relay", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  const revisionId = `work-revision-${"a".repeat(32)}`;
  const itemId = `media-item-${"b".repeat(32)}`;
  const editKey = "c".repeat(32);
  const token = "test-operator-token".padEnd(40, "0");
  const bytes = new Uint8Array([82, 73, 70, 70]);

  const mediaRequest = (
    params: Record<string, string>,
    role: "owner" | "automation" | null = "owner",
    headers: Record<string, string> = {},
    signal?: AbortSignal,
  ): PayloadRequest =>
    ({
      user: role === null ? null : { collection: "users", id: 1, role },
      routeParams: params,
      headers: new Headers(headers),
      ...(signal === undefined ? {} : { signal }),
      payload: { logger: { error: vi.fn() } },
    }) as unknown as PayloadRequest;

  const mediaEndpoint = (endpoints: Endpoint[]) => {
    const endpoint = endpoints.find((candidate) =>
      candidate.path.startsWith("/community-moderation/work-submission-media/"),
    );
    if (endpoint === undefined) throw new Error("no media endpoint");
    return endpoint;
  };

  const serve = (
    endpoints: Endpoint[],
    req: PayloadRequest,
  ): Promise<Response> =>
    (
      mediaEndpoint(endpoints).handler as (
        r: PayloadRequest,
      ) => Promise<Response>
    )(req);

  const params = { revisionId, itemId, variant: "thumb", editKey };

  const media = (
    overrides: Partial<OperatorMediaResponse> = {},
  ): OperatorMediaResponse => ({
    status: 200,
    contentType: "image/webp",
    contentLength: String(bytes.byteLength),
    contentRange: null,
    acceptsRanges: false,
    body: new Response(bytes).body!,
    ...overrides,
  });

  const opener = (answer: () => OperatorMediaResponse = () => media()) => {
    const calls: {
      path: string;
      range: string | null;
      signal?: AbortSignal | undefined;
    }[] = [];
    const openMedia: OperatorMediaCall = vi.fn(async (path, range, signal) => {
      calls.push({ path, range, ...(signal === undefined ? {} : { signal }) });
      return answer();
    });
    return { openMedia, calls };
  };

  it("registers one GET relay path under the moderation prefix", () => {
    const endpoint = mediaEndpoint(createCommunityEndpoints());
    expect(endpoint.method).toBe("get");
    expect(endpoint.path).toBe(
      "/community-moderation/work-submission-media/:revisionId/:itemId/:variant/:editKey",
    );
  });

  it.each(["development", "production"])(
    "streams an allow-listed derivative privately to the Owner in %s",
    async (nodeEnv) => {
      vi.stubEnv("NODE_ENV", nodeEnv);
      const { call } = recorder();
      const { openMedia, calls } = opener();
      const viewer = new AbortController();
      const response = await serve(
        createCommunityEndpoints(call, openMedia),
        mediaRequest(params, "owner", {}, viewer.signal),
      );
      expect(response.status).toBe(200);
      expect(Object.fromEntries(response.headers.entries())).toEqual({
        "cache-control": "private, no-store",
        "content-length": "4",
        "content-security-policy": "default-src 'none'; sandbox",
        "content-type": "image/webp",
        "cross-origin-resource-policy": "same-origin",
        "referrer-policy": "no-referrer",
        vary: "Cookie, Range",
        "x-content-type-options": "nosniff",
      });
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
      expect(calls).toEqual([
        {
          path: `publishing/media/${revisionId}/${itemId}/thumb/${editKey}`,
          range: null,
          signal: viewer.signal,
        },
      ]);
    },
  );

  it("relays one well-formed byte range and its partial answer", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { openMedia, calls } = opener(() =>
      media({
        status: 206,
        contentType: "video/mp4",
        contentRange: "bytes 0-3/1000",
        acceptsRanges: true,
      }),
    );
    const endpoints = createCommunityEndpoints(recorder().call, openMedia);
    const response = await serve(
      endpoints,
      mediaRequest({ ...params, variant: "motion" }, "owner", {
        range: "bytes=0-3",
      }),
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 0-3/1000");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    for (const range of ["bytes=5-1", "items=0-3", "bytes=0-1,4-5", "bytes=-"])
      await serve(endpoints, mediaRequest(params, "owner", { range }));
    expect(calls.map((entry) => entry.range)).toEqual([
      "bytes=0-3",
      null,
      null,
      null,
      null,
    ]);
  });

  it.each(["development", "production"])(
    "refuses non-Owners and malformed media subjects in %s before opening anything",
    async (nodeEnv) => {
      vi.stubEnv("NODE_ENV", nodeEnv);
      const { openMedia, calls } = opener();
      const endpoints = createCommunityEndpoints(recorder().call, openMedia);
      for (const role of ["automation", null] as const) {
        const response = await serve(endpoints, mediaRequest(params, role));
        expect(response.status).toBe(403);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.json()).toEqual({
          ok: false,
          error: { code: "COMMUNITY_OWNER_ONLY" },
        });
      }
      for (const invalid of [
        { variant: "original" },
        { variant: "standard_master" },
        { editKey: "../../blobs" },
        { editKey: "BASE" },
        { itemId: "media-item-x" },
        { revisionId: `work-${"a".repeat(32)}` },
      ]) {
        const response = await serve(
          endpoints,
          mediaRequest({ ...params, ...invalid }),
        );
        expect(response.status).toBe(400);
      }
      expect(calls).toEqual([]);
    },
  );

  it("passes the Backend's missing-subject answer through as JSON, never bytes", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const openMedia: OperatorMediaCall = vi.fn(async () => {
      throw new CommunityOperatorError("NOT_FOUND", 404);
    });
    const response = await serve(
      createCommunityEndpoints(recorder().call, openMedia),
      mediaRequest(params),
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
  });

  it("reaches the Backend operator media route over the configured loopback transport", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("COMMUNITY_OPERATOR_BASE_URL", "http://127.0.0.1:3999");
    vi.stubEnv("COMMUNITY_OPERATOR_TOKEN", token);
    const requests: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init: RequestInit) => {
        requests.push({ url: String(url), init });
        return new Response(bytes, {
          status: 206,
          headers: {
            "content-type": "image/webp; charset=binary",
            "content-length": "4",
            "content-range": "bytes 0-3/4",
            "accept-ranges": "bytes",
          },
        });
      }),
    );
    const response = await serve(
      createCommunityEndpoints(recorder().call),
      mediaRequest({ ...params, variant: "display" }, "owner", {
        range: "bytes=0-",
        cookie: "payload-token=secret",
      }),
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(
      `http://127.0.0.1:3999/internal/community/publishing/media/${revisionId}/${itemId}/display/${editKey}`,
    );
    expect(requests[0]!.init).toMatchObject({
      method: "GET",
      cache: "no-store",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${token}`,
        Range: "bytes=0-",
        "Accept-Encoding": "identity",
      },
    });
    // The Owner's Payload session never travels to the Backend.
    expect(JSON.stringify(requests[0]!.init.headers)).not.toContain(
      "payload-token",
    );
  });

  it.each([
    [
      "an HTML document",
      200,
      { "content-type": "text/html" },
      "OPERATOR_RESPONSE_INVALID",
      502,
    ],
    [
      "an SVG image",
      200,
      { "content-type": "image/svg+xml" },
      "OPERATOR_RESPONSE_INVALID",
      502,
    ],
    ["no content type", 200, {}, "OPERATOR_RESPONSE_INVALID", 502],
    [
      "an encoded body",
      200,
      { "content-type": "image/webp", "content-encoding": "gzip" },
      "OPERATOR_RESPONSE_INVALID",
      502,
    ],
    [
      "an oversized derivative",
      200,
      {
        "content-type": "video/mp4",
        "content-length": String(256 * 1024 * 1024 + 1),
      },
      "OPERATOR_RESPONSE_INVALID",
      502,
    ],
    [
      "a malformed partial answer",
      206,
      { "content-type": "video/mp4", "content-range": "bytes 9-3/4" },
      "OPERATOR_RESPONSE_INVALID",
      502,
    ],
    [
      "an unsatisfiable range",
      416,
      { "content-range": "bytes */4" },
      "RANGE_NOT_SATISFIABLE",
      416,
    ],
    [
      "a missing derivative",
      404,
      { "content-type": "application/json" },
      "NOT_FOUND",
      404,
    ],
    [
      "a rejected credential",
      401,
      { "content-type": "application/json" },
      "OPERATOR_UNAUTHORIZED",
      502,
    ],
  ])(
    "refuses %s from the Backend and cancels its body",
    async (_label, status, headers, code, relayed) => {
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("COMMUNITY_OPERATOR_BASE_URL", "http://127.0.0.1:3999");
      vi.stubEnv("COMMUNITY_OPERATOR_TOKEN", token);
      const cancel = vi.fn();
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              new ReadableStream({
                pull: (controller) => controller.enqueue(bytes),
                cancel,
              }),
              { status, headers },
            ),
        ),
      );
      const response = await serve(
        createCommunityEndpoints(recorder().call),
        mediaRequest(params),
      );
      expect(response.status).toBe(relayed);
      expect(await response.json()).toEqual({ ok: false, error: { code } });
      expect(cancel).toHaveBeenCalled();
    },
  );

  describe("transport bounds", () => {
    const path = `publishing/media/${revisionId}/${itemId}/motion/${editKey}`;
    const configure = () => {
      vi.stubEnv("COMMUNITY_OPERATOR_BASE_URL", "http://127.0.0.1:3999");
      vi.stubEnv("COMMUNITY_OPERATOR_TOKEN", token);
    };
    afterEach(() => {
      vi.useRealTimers();
    });

    /** A Backend body the test controls; records how far it was read and whether it was cancelled. */
    const backendBody = (
      chunk: (index: number) => Uint8Array | null | "hang",
    ) => {
      const state = { pulls: 0, cancelled: false };
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            const next = chunk(state.pulls);
            state.pulls += 1;
            if (next === "hang") return new Promise<void>(() => undefined);
            if (next === null) controller.close();
            else controller.enqueue(next);
            return undefined;
          },
          cancel() {
            state.cancelled = true;
          },
        },
        { highWaterMark: 0 },
      );
      return { body, state };
    };

    const backend = (
      body: ReadableStream<Uint8Array>,
      headers: Record<string, string> = { "content-type": "video/mp4" },
      status = 200,
    ) => {
      const signals: AbortSignal[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: URL, init: RequestInit) => {
          signals.push(init.signal!);
          return new Response(body, { status, headers });
        }),
      );
      return signals;
    };

    it("gives up on Backend headers after the wait and on a viewer that leaves first", async () => {
      configure();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const signals: AbortSignal[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_url: URL, init: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              signals.push(init.signal!);
              init.signal!.addEventListener("abort", () =>
                reject(new DOMException("aborted", "AbortError")),
              );
            }),
        ),
      );
      const waiting = openCommunityOperatorMedia(path, null);
      const outcome = waiting.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(OPERATOR_MEDIA_WAIT_MS - 1);
      expect(signals[0]!.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(signals[0]!.aborted).toBe(true);
      expect(await outcome).toMatchObject({ code: "OPERATOR_UNREACHABLE" });

      const viewer = new AbortController();
      const leaving = openCommunityOperatorMedia(
        path,
        null,
        viewer.signal,
      ).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      viewer.abort();
      expect(signals[1]!.aborted).toBe(true);
      expect(await leaving).toMatchObject({ code: "OPERATOR_UNREACHABLE" });
    });

    it("returns while an endless Backend body is still streaming, chunk by chunk", async () => {
      configure();
      const chunk = new Uint8Array(1024);
      const { body, state } = backendBody(() => chunk);
      const signals = backend(body);
      const relayed = await openCommunityOperatorMedia(path, null);
      expect(relayed.status).toBe(200);
      expect(relayed.contentLength).toBeNull();
      // Nothing was read ahead of the viewer.
      expect(state.pulls).toBeLessThanOrEqual(1);
      const reader = relayed.body.getReader();
      for (let index = 0; index < 3; index += 1)
        expect((await reader.read()).value?.byteLength).toBe(1024);
      expect(state.pulls).toBeLessThanOrEqual(4);
      // The viewer going away cancels the Backend request and its body.
      await reader.cancel();
      expect(state.cancelled).toBe(true);
      expect(signals[0]!.aborted).toBe(true);
    });

    it("cuts off a stalled Backend and a viewer that stopped reading", async () => {
      configure();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const stalled = backendBody((index) =>
        index === 0 ? new Uint8Array(8) : "hang",
      );
      const stalledSignals = backend(stalled.body);
      const reading = await openCommunityOperatorMedia(path, null);
      const reader = reading.body.getReader();
      expect((await reader.read()).value?.byteLength).toBe(8);
      const next = reader.read().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(OPERATOR_MEDIA_WAIT_MS - 1);
      expect(stalledSignals[0]!.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await next).toMatchObject({ code: "OPERATOR_UNREACHABLE" });
      expect(stalledSignals[0]!.aborted).toBe(true);
      expect(stalled.state.cancelled).toBe(true);

      // A paused player: the Backend keeps offering bytes, nobody reads them.
      const paused = backendBody(() => new Uint8Array(8));
      const pausedSignals = backend(paused.body);
      const idle = await openCommunityOperatorMedia(path, "bytes=0-");
      void idle;
      await vi.advanceTimersByTimeAsync(OPERATOR_MEDIA_WAIT_MS);
      expect(pausedSignals[0]!.aborted).toBe(true);
      expect(paused.state.cancelled).toBe(true);
    });

    it("ends a response that keeps moving past its lifetime", async () => {
      configure();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { body, state } = backendBody(() => new Uint8Array(1));
      const signals = backend(body);
      const relayed = await openCommunityOperatorMedia(path, null);
      const reader = relayed.body.getReader();
      let failure: unknown = null;
      let elapsed = 0;
      // Reading every half wait keeps the stall timer from ever firing.
      const step = OPERATOR_MEDIA_WAIT_MS / 2;
      while (failure === null && elapsed <= OPERATOR_MEDIA_LIFETIME_MS + step) {
        failure = await reader.read().then(
          () => null,
          (error: unknown) => error,
        );
        if (failure !== null) break;
        await vi.advanceTimersByTimeAsync(step);
        elapsed += step;
      }
      expect(failure).toMatchObject({ code: "OPERATOR_UNREACHABLE" });
      expect(elapsed).toBeGreaterThanOrEqual(OPERATOR_MEDIA_LIFETIME_MS);
      expect(signals[0]!.aborted).toBe(true);
      expect(state.cancelled).toBe(true);
    });

    it("refuses a body that grows past the derivative bound without a declared length", async () => {
      configure();
      const block = new Uint8Array(32 * 1024 * 1024);
      const { body, state } = backendBody(() => block);
      const signals = backend(body);
      const relayed = await openCommunityOperatorMedia(path, null);
      const reader = relayed.body.getReader();
      let delivered = 0;
      let failure: unknown = null;
      // Bounded so a relay that never refuses fails the test instead of spinning.
      for (let read = 0; failure === null && read < 16; read += 1) {
        const next = await reader.read().then(
          (result) => result,
          (error: unknown) => {
            failure = error;
            return null;
          },
        );
        if (next === null) break;
        if (next.done) break;
        delivered += next.value.byteLength;
      }
      expect(failure).toMatchObject({ code: "OPERATOR_RESPONSE_INVALID" });
      expect(delivered).toBeLessThanOrEqual(OPERATOR_MEDIA_MAXIMUM_BYTES);
      expect(delivered).toBe(OPERATOR_MEDIA_MAXIMUM_BYTES);
      expect(state.cancelled).toBe(true);
      expect(signals[0]!.aborted).toBe(true);

      // A declared length is a promise too.
      const over = backendBody((index) =>
        index < 2 ? new Uint8Array(4) : null,
      );
      backend(over.body, {
        "content-type": "image/webp",
        "content-length": "4",
      });
      const declared = await openCommunityOperatorMedia(path, null);
      const declaredReader = declared.body.getReader();
      expect((await declaredReader.read()).value?.byteLength).toBe(4);
      await expect(declaredReader.read()).rejects.toMatchObject({
        code: "OPERATOR_RESPONSE_INVALID",
      });
      expect(over.state.cancelled).toBe(true);
    });

    it.each([
      ["no range was requested", null, "bytes 0-3/100", "4"],
      ["another start", "bytes=0-3", "bytes 4-7/100", "4"],
      ["a shorter end", "bytes=0-9", "bytes 0-3/100", "4"],
      ["a length that is not the span", "bytes=0-3", "bytes 0-3/100", "5"],
      ["an open range cut short", "bytes=10-", "bytes 10-19/100", "10"],
      ["another suffix", "bytes=-10", "bytes 0-9/100", "10"],
      ["an end past the resource", "bytes=0-", "bytes 0-100/100", "101"],
      ["a malformed length", "bytes=0-3", "bytes 0-3/100", "4x"],
    ])(
      "refuses a partial answer with %s",
      async (_label, range, contentRange, contentLength) => {
        configure();
        const { body, state } = backendBody(() => new Uint8Array(4));
        backend(
          body,
          {
            "content-type": "video/mp4",
            "content-range": contentRange,
            "content-length": contentLength,
          },
          206,
        );
        await expect(
          openCommunityOperatorMedia(path, range),
        ).rejects.toMatchObject({ code: "OPERATOR_RESPONSE_INVALID" });
        expect(state.cancelled).toBe(true);
      },
    );

    it.each([
      ["bytes=0-3", "bytes 0-3/100", "4"],
      ["bytes=90-200", "bytes 90-99/100", "10"],
      ["bytes=10-", "bytes 10-99/100", "90"],
      ["bytes=-10", "bytes 90-99/100", "10"],
      ["bytes=-500", "bytes 0-99/100", "100"],
    ])(
      "relays the exact partial answer to %s",
      async (range, contentRange, contentLength) => {
        configure();
        const { body } = backendBody((index) =>
          index === 0 ? new Uint8Array(Number(contentLength)) : null,
        );
        backend(
          body,
          {
            "content-type": "video/mp4",
            "content-range": contentRange,
            "content-length": contentLength,
          },
          206,
        );
        const relayed = await openCommunityOperatorMedia(path, range);
        expect(relayed).toMatchObject({
          status: 206,
          contentRange,
          contentLength,
          acceptsRanges: true,
        });
        await relayed.body.cancel();
      },
    );
  });

  it("allows exactly the rendered derivative types", () => {
    expect([...OPERATOR_MEDIA_TYPES].sort()).toEqual([
      "image/jpeg",
      "image/png",
      "image/webp",
      "video/mp4",
    ]);
  });
});

describe("Agent administration Owner envelopes (Development)", () => {
  const principal = {
    label: "agent-reviewer",
    displayName: "评审代理",
    scopes: ["comments:read", "comments:moderate"],
    enabled: true,
    version: 1,
    createdAt: "2026-09-16T20:00:00.000Z",
    updatedAt: "2026-09-16T20:00:00.000Z",
    revokedAt: null,
  };
  const operation = {
    id: "10000000-0000-4000-8000-000000000001",
    principal: "agent-reviewer",
    requestId: "10000000-0000-4000-8000-000000000002",
    kind: "comments.moderate",
    action: "hide",
    state: "prepared",
    approval: null,
    undoOf: null,
    criteria: null,
    targetCount: 1,
    nextIndex: 0,
    results: [],
    tally: { applied: 0, conflicts: 0, notFound: 0, failed: 0, cancelled: 0 },
    version: 1,
    createdAt: "2026-09-16T20:00:00.000Z",
    expiresAt: "2026-09-17T20:00:00.000Z",
    approvedAt: null,
    startedAt: null,
    finishedAt: null,
    cancelRequestedAt: null,
    leaseHeld: false,
  };
  const answering = (answer: unknown) => {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    const call = vi.fn(
      async (
        method: string,
        path: string,
        body?: unknown,
      ): Promise<unknown> => {
        calls.push({ method, path, ...(body === undefined ? {} : { body }) });
        return answer;
      },
    ) as unknown as OperatorCall;
    return { call, calls };
  };

  it("keeps Agent administration Owner-only and Development-only", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { call, calls } = answering({ items: [principal] });
    const endpoints = createCommunityEndpoints(call);
    for (const role of [null, "automation"] as const)
      expect(
        (await invoke(endpoints, "agent-principals-read", request({}, role)))
          .status,
      ).toBe(403);
    expect(calls).toHaveLength(0);
    expect(
      (await invoke(endpoints, "agent-principals-read", request({}))).status,
    ).toBe(200);
    expect(calls).toEqual([{ method: "GET", path: "agent/principals" }]);
    vi.stubEnv("NODE_ENV", "production");
    expect(
      (await invoke(endpoints, "agent-principals-read", request({}))).status,
    ).toBe(404);
    expect(calls).toHaveLength(1);
  });

  it("validates the registry, delegation and operation envelopes strictly and maps them onto the agent routes", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { call, calls } = answering(operation);
    const endpoints = createCommunityEndpoints(call);
    const command = {
      requestId: "10000000-0000-4000-8000-000000000003",
      operationId: operation.id,
    };
    expect(
      (
        await invoke(
          endpoints,
          "agent-operation-approve",
          request({ ...command, principal: "agent-x" }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await invoke(
          endpoints,
          "agent-operation-approve",
          request({ ...command, operationId: "not-a-uuid" }),
        )
      ).status,
    ).toBe(400);
    expect(calls).toHaveLength(0);
    for (const [name, path] of [
      ["agent-operation-approve", "approve"],
      ["agent-operation-cancel", "cancel"],
    ] as const) {
      expect((await invoke(endpoints, name, request(command))).status).toBe(
        200,
      );
      expect(calls.at(-1)).toEqual({
        method: "POST",
        path: `agent/operations/${operation.id}/${path}`,
        body: { requestId: command.requestId },
      });
    }
    const { call: pageCall, calls: pageCalls } = answering({
      items: [operation],
      total: 1,
      page: 2,
      pageSize: 10,
    });
    const paged = createCommunityEndpoints(pageCall);
    expect(
      (
        await invoke(
          paged,
          "agent-operations-read",
          request({ state: "prepared", page: 2, pageSize: 10 }),
        )
      ).status,
    ).toBe(200);
    expect(pageCalls).toEqual([
      {
        method: "GET",
        path: "agent/operations?state=prepared&page=2&pageSize=10",
      },
    ]);
    const { call: delegationCall, calls: delegationCalls } = answering({
      id: "10000000-0000-4000-8000-000000000009",
      principal: "agent-reviewer",
      kind: "comments.moderate",
      maxTargets: 50,
      expiresAt: "2026-09-17T20:00:00.000Z",
      createdBy: "owner",
      createdAt: "2026-09-16T20:00:00.000Z",
      revokedAt: null,
      revokedBy: null,
    });
    const delegations = createCommunityEndpoints(delegationCall);
    const create = {
      requestId: "10000000-0000-4000-8000-000000000004",
      principal: "agent-reviewer",
      kind: "comments.moderate",
      maxTargets: 50,
      expiresAt: "2026-09-17T20:00:00.000Z",
    };
    expect(
      (
        await invoke(
          delegations,
          "agent-delegation-create",
          request({ ...create, maxTargets: 501 }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await invoke(delegations, "agent-delegation-create", request(create)))
        .status,
    ).toBe(200);
    expect(delegationCalls).toEqual([
      { method: "POST", path: "agent/delegations", body: create },
    ]);
  });

  it("passes the agent boundary's forbidden answer through as a final code", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const call = vi.fn(async () => {
      throw new CommunityOperatorError("AGENT_FORBIDDEN", 403);
    }) as unknown as OperatorCall;
    const endpoints = createCommunityEndpoints(call);
    const response = await invoke(
      endpoints,
      "agent-operation-execute",
      request({
        requestId: "10000000-0000-4000-8000-000000000005",
        operationId: operation.id,
      }),
    );
    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      ok: false,
      error: { code: "AGENT_FORBIDDEN" },
    });
    expect(
      outcomeUnknown(new OperatorFailure("AGENT_FORBIDDEN", "x", 403)),
    ).toBe(false);
  });
});
