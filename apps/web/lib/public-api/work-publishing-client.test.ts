import * as contracts from "@moya/contracts/schemas";
import type { ArticleDraft, WorkDraftContent } from "@moya/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as publishingData from "../../features/publishing/publishing-data";
import {
  ArticleRequestError,
  articleAuthoringClient,
} from "./article-authoring-client";
import { AuthorRequestError, authorClient } from "./author-community-client";
import * as client from "./work-publishing-client";
import {
  PublishingRequestError,
  publishingClient,
} from "./work-publishing-client";

const account = `user-${"a".repeat(32)}`;
const otherAccount = `user-${"b".repeat(32)}`;
const draftId = `work-draft-${"1".repeat(32)}`;
const workId = `work-${"2".repeat(32)}`;
const itemId = `media-item-${"3".repeat(32)}`;
const componentId = `media-component-${"4".repeat(32)}`;
const sessionId = `publishing-session-${"5".repeat(32)}`;
const revisionId = `work-revision-${"6".repeat(32)}`;
const requestId = "0f8e2f4c-3b1a-4d6e-9c2b-7a5d4e3f2a10";
const attempt = "6d1b0c8e-2f3a-4b5c-8d7e-9f0a1b2c3d4e";
const at = "2026-09-13T10:00:00.000Z";

const content: WorkDraftContent = {
  title: "春日临帖",
  body: "第一行\n第二行",
  authorship: { kind: "original" },
  visibility: "public",
  items: [],
  coverKey: null,
  coverCrop: null,
};

const draft = {
  id: draftId,
  kind: "new",
  workId: null,
  baseRevisionId: null,
  revision: 3,
  content,
  mediaItems: [],
  conflict: null,
  deviceClass: "phone",
  createdAt: at,
  updatedAt: at,
} as const;

const awaitingItem = {
  id: itemId,
  kind: "static",
  qualityMode: "standard",
  state: "awaiting_upload",
  failureCode: null,
  components: [
    {
      id: componentId,
      role: "still",
      state: "awaiting",
      byteSize: 2048,
      receivedBytes: 0,
    },
  ],
  presentation: null,
  media: null,
} as const;

const receipt = {
  state: "confirmed",
  requestId,
  workId,
  revisionId,
  visibility: "public",
  submittedAt: at,
} as const;

const refusalBody = (message: string, code = "INVALID_INPUT") => ({
  error: { code, message, requestId: "backend-request-1" },
});

const upstream = vi.fn<typeof fetch>();

const answer = (body: unknown, status = 200) =>
  upstream.mockResolvedValueOnce(Response.json(body, { status }));

const refused = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => {
      throw new Error("expected a refusal");
    },
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(PublishingRequestError);
  return error as PublishingRequestError;
};

beforeEach(() => {
  upstream.mockReset();
  vi.stubGlobal("fetch", upstream);
  authorClient.setAccount(account);
});

afterEach(() => {
  authorClient.setAccount(null);
  vi.unstubAllGlobals();
});

describe("work publishing client", () => {
  it("reads privately through the same-origin relay and parses the contract", async () => {
    const limits = {
      maxItems: 50,
      originalItemMaxBytes: 134217728,
      standardComponentMaxBytes: 268435456,
      titleMax: 200,
      bodyMax: 10000,
    };
    answer(limits);
    await expect(publishingClient.limits()).resolves.toEqual(limits);
    const [path, init] = upstream.mock.calls[0]!;
    expect(path).toBe("/api/community/publishing/limits");
    expect(init).toMatchObject({
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      headers: { accept: "application/json" },
    });
    expect(init?.body).toBeUndefined();
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("sends a validated write with the confirmed account", async () => {
    answer(draft, 201);
    const command = { requestId, content, deviceClass: "phone" } as const;
    await expect(publishingClient.createDraft(command)).resolves.toEqual(draft);
    const [path, init] = upstream.mock.calls[0]!;
    expect(path).toBe("/api/community/publishing/drafts");
    expect(init).toMatchObject({
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-author-account": account,
      },
    });
    expect(JSON.parse(String(init?.body))).toEqual(command);
  });

  it("refuses a write before any account is confirmed", async () => {
    authorClient.setAccount(null);
    const error = await refused(
      publishingClient.saveDraft(draftId, {
        baseRevision: 3,
        content,
        deviceClass: null,
      }),
    );
    expect(error.status).toBe(401);
    expect(error).toBeInstanceOf(AuthorRequestError);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("keeps the field code of an invalid command without sending it", async () => {
    const error = await refused(
      publishingClient.createDraft({
        requestId,
        content: { ...content, title: " ", body: "\n" },
        deviceClass: null,
      }),
    );
    expect(error).toMatchObject({ status: 422, code: "empty_work" });
    expect(error.message).toBe("标题、正文和图片不能都为空");
    const tooLong = await refused(
      publishingClient.submit({
        requestId,
        holder: { draftId },
        content: { ...content, title: "字".repeat(201) },
        baseRevisionId: null,
      }),
    );
    expect(tooLong).toMatchObject({ status: 422, code: "title_too_long" });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("parses a conditional save that reports a conflict", async () => {
    const conflict = {
      id: `work-draft-${"7".repeat(32)}`,
      device: {
        content: { ...content, title: "本机版本" },
        baseRevision: 3,
        deviceClass: "phone",
        savedAt: at,
      },
      account: {
        content,
        revision: 4,
        deviceClass: "desktop",
        updatedAt: at,
      },
      createdAt: at,
    };
    answer({
      status: "conflict",
      draft: { ...draft, revision: 4, conflict },
      conflict,
    });
    const result = await publishingClient.saveDraftNow(draftId, {
      baseRevision: 3,
      content: { ...content, title: "本机版本" },
      deviceClass: "phone",
    });
    expect(result.status).toBe("conflict");
    expect(upstream.mock.calls[0]?.[0]).toBe(
      `/api/community/publishing/drafts/${draftId}/snapshot`,
    );
  });

  it.each([
    ["capacity_exceeded", "存储空间不足，文字仍可保存"],
    ["daily_limit", "今日新发布作品数量已达上限"],
    ["not_ready", "仍有图片未处理完成"],
  ])("maps the 422 failure code %s", async (code, message) => {
    answer(refusalBody(code), 422);
    const error = await refused(
      publishingClient.registerItem({
        requestId,
        holder: { draftId },
        kind: "static",
        qualityMode: "original",
        components: [
          { role: "still", byteSize: 2048, contentType: "image/heic" },
        ],
      }),
    );
    expect(error).toMatchObject({ status: 422, code, message });
  });

  it("keeps a generic 422 without inventing a field code", async () => {
    answer(refusalBody("Invalid community input"), 422);
    const error = await refused(
      publishingClient.setVisibility(workId, { requestId, visibility: "self" }),
    );
    expect(error).toMatchObject({
      status: 422,
      code: null,
      message: "内容不符合要求，请检查后修改",
    });
  });

  it.each([
    [
      "Request identity was already used for different content",
      null,
      "状态已变化，请检查后重试",
    ],
    ["Another transfer is still in progress", null, "状态已变化，请检查后重试"],
    ["work_unavailable", "work_unavailable", "作品不可用"],
  ] as const)(
    "shows product text instead of the Backend conflict message %s",
    async (backendMessage, code, message) => {
      answer(refusalBody(backendMessage, "CONFLICT"), 409);
      const error = await refused(
        publishingClient.resolveConflict(draftId, {
          requestId,
          conflictId: `work-draft-${"7".repeat(32)}`,
          choice: "device",
        }),
      );
      expect(error).toMatchObject({
        status: 409,
        code,
        message,
        outcomeUnknown: false,
      });
    },
  );

  it.each([
    [401, "请先登录"],
    [404, "内容不可用"],
    [413, "内容超过允许的大小"],
    [503, "暂时无法完成，请重试"],
    [502, "暂时无法完成，请重试"],
  ])("maps status %i of a read", async (status, message) => {
    upstream.mockResolvedValueOnce(new Response(null, { status }));
    const error = await refused(publishingClient.draft(draftId));
    expect(error).toMatchObject({
      status,
      code: null,
      message,
      outcomeUnknown: false,
    });
  });

  it("refuses an answer that breaks the contract", async () => {
    answer({ ...draft, workId });
    const error = await refused(publishingClient.draft(draftId));
    expect(error).toMatchObject({ status: 502, outcomeUnknown: false });
  });

  it("discards an answer that arrives after the account changed", async () => {
    upstream.mockImplementationOnce(async () => {
      authorClient.setAccount(otherAccount);
      return Response.json(awaitingItem);
    });
    const error = await refused(publishingClient.item(itemId));
    expect(error).toMatchObject({
      status: 401,
      message: "账户状态已变化，请重试读取",
      outcomeUnknown: false,
    });
  });

  it("discards an answer when the account switched away and back (A→B→A)", async () => {
    upstream.mockImplementationOnce(async () => {
      authorClient.setAccount(otherAccount);
      authorClient.setAccount(account);
      return Response.json(awaitingItem);
    });
    const error = await refused(publishingClient.item(itemId));
    expect(error.status).toBe(401);
    expect(authorClient.account()).toBe(account);
  });

  it("discards an answer when the account changes while its body is read", async () => {
    upstream.mockImplementationOnce(async () => {
      const text = new TextEncoder().encode(JSON.stringify(awaitingItem));
      let sent = false;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (sent) {
            // The account changes after the headers, before the last byte.
            authorClient.setAccount(otherAccount);
            controller.close();
            return;
          }
          sent = true;
          controller.enqueue(text);
        },
      });
      return new Response(body, {
        headers: { "content-type": "application/json" },
      });
    });
    const error = await refused(publishingClient.item(itemId));
    expect(error.status).toBe(401);
  });

  it("reports a network failure as status 0 and rethrows a caller abort", async () => {
    upstream.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const error = await refused(publishingClient.listDrafts());
    expect(error).toMatchObject({
      status: 0,
      code: null,
      message: "网络连接中断，请检查后重试",
      outcomeUnknown: false,
    });

    const controller = new AbortController();
    controller.abort();
    upstream.mockRejectedValueOnce(
      new DOMException("The operation was aborted.", "AbortError"),
    );
    await expect(
      publishingClient.editableWork(workId, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  describe("write outcomes", () => {
    const save = () =>
      publishingClient.saveDraft(draftId, {
        baseRevision: 3,
        content,
        deviceClass: "phone",
      });

    it.each([
      [
        "a lost connection",
        () => upstream.mockRejectedValueOnce(new TypeError("Failed to fetch")),
        0,
      ],
      [
        "the client's own request timeout",
        () =>
          upstream.mockRejectedValueOnce(
            new DOMException("The operation timed out.", "TimeoutError"),
          ),
        0,
      ],
      [
        "an unreadable success answer",
        () =>
          upstream.mockResolvedValueOnce(
            new Response("{", {
              headers: { "content-type": "application/json" },
            }),
          ),
        502,
      ],
      [
        "a success answer that breaks the contract",
        () => answer({ status: "saved" }),
        502,
      ],
      [
        "the relay's empty 503 (upstream timeout or network failure)",
        () =>
          upstream.mockResolvedValueOnce(new Response(null, { status: 503 })),
        503,
      ],
      [
        "an empty 502",
        () =>
          upstream.mockResolvedValueOnce(new Response(null, { status: 502 })),
        502,
      ],
      [
        "a Backend internal error",
        () => answer(refusalBody("Unexpected failure", "INTERNAL_ERROR"), 500),
        500,
      ],
    ] as const)(
      "leaves the outcome unknown after %s",
      async (_label, arrange, status) => {
        arrange();
        const error = await refused(save());
        expect(error).toMatchObject({
          status,
          code: null,
          outcomeUnknown: true,
        });
        expect(error.message).not.toMatch(/重试/u);
      },
    );

    it.each([
      [
        "the Backend's declared unavailability",
        () =>
          answer(
            refusalBody(
              "Media is temporarily unavailable",
              "SERVICE_UNAVAILABLE",
            ),
            503,
          ),
        503,
      ],
      [
        "a conflict",
        () => answer(refusalBody("Draft revision changed", "CONFLICT"), 409),
        409,
      ],
      [
        "a relay size refusal",
        () =>
          upstream.mockResolvedValueOnce(new Response(null, { status: 413 })),
        413,
      ],
      [
        "a field refusal",
        () => answer(refusalBody("capacity_exceeded"), 422),
        422,
      ],
    ] as const)("keeps %s a known refusal", async (_label, arrange, status) => {
      arrange();
      const error = await refused(save());
      expect(error).toMatchObject({ status, outcomeUnknown: false });
    });

    it("does not tell the next account to retry a write that may have committed", async () => {
      upstream.mockImplementationOnce(async () => {
        authorClient.setAccount(otherAccount);
        return Response.json({
          status: "saved",
          draft: { ...draft, revision: 4 },
        });
      });
      const error = await refused(save());
      expect(error).toMatchObject({
        status: 401,
        outcomeUnknown: true,
        message: "账户状态已变化，请刷新后检查操作结果",
      });

      upstream.mockImplementationOnce(async () => {
        authorClient.setAccount(account);
        return Response.json(
          refusalBody("Draft revision changed", "CONFLICT"),
          {
            status: 409,
          },
        );
      });
      const refusedWrite = await refused(save());
      expect(refusedWrite).toMatchObject({
        status: 401,
        outcomeUnknown: false,
      });
    });

    it("sends a write with the account that was confirmed when it started", async () => {
      upstream.mockResolvedValueOnce(new Response(null, { status: 503 }));
      await refused(save());
      expect(upstream.mock.calls[0]?.[1]?.headers).toMatchObject({
        "x-author-account": account,
      });
    });
  });

  it("answers null when a lost submission has no receipt", async () => {
    upstream.mockResolvedValueOnce(
      Response.json(refusalBody("Not found", "ITEM_NOT_FOUND"), {
        status: 404,
      }),
    );
    await expect(publishingClient.submissionReceipt(requestId)).resolves.toBe(
      null,
    );
    expect(upstream.mock.calls[0]?.[0]).toBe(
      `/api/community/publishing/submissions/${requestId}`,
    );
    answer(receipt);
    await expect(
      publishingClient.submissionReceipt(requestId),
    ).resolves.toEqual(receipt);
    upstream.mockResolvedValueOnce(new Response(null, { status: 503 }));
    expect(
      await refused(publishingClient.submissionReceipt(requestId)),
    ).toMatchObject({ status: 503, outcomeUnknown: false });
    upstream.mockImplementationOnce(async () => {
      authorClient.setAccount(otherAccount);
      return Response.json(refusalBody("Not found", "ITEM_NOT_FOUND"), {
        status: 404,
      });
    });
    expect(
      (await refused(publishingClient.submissionReceipt(requestId))).status,
    ).toBe(401);
  });

  it("checks readiness for a draft or session holder and parses the answer", async () => {
    const editKey = "0123456789abcdef0123456789abcdef";
    const readiness = {
      ready: false,
      pendingItemKeys: ["item-1"],
      failedItemKeys: [],
      editKeys: { "item-2": editKey },
    };
    answer(readiness);
    await expect(
      publishingClient.readiness({ draftId }, content),
    ).resolves.toEqual(readiness);
    const [draftTarget, draftInit] = upstream.mock.calls[0]!;
    expect(draftTarget).toBe(
      `/api/community/publishing/drafts/${draftId}/readiness`,
    );
    expect(draftInit?.method).toBe("POST");
    expect(JSON.parse(String(draftInit?.body))).toEqual({ content });
    expect(new Headers(draftInit?.headers).get("x-author-account")).toBe(
      account,
    );

    answer({ ...readiness, ready: true, pendingItemKeys: [] });
    await expect(
      publishingClient.readiness({ sessionId }, content),
    ).resolves.toEqual({ ...readiness, ready: true, pendingItemKeys: [] });
    expect(upstream.mock.calls[1]![0]).toBe(
      `/api/community/publishing/sessions/${sessionId}/readiness`,
    );

    // A contradictory answer breaks the contract and is never handed over.
    answer({ ...readiness, ready: true });
    expect(
      (await refused(publishingClient.readiness({ draftId }, content))).status,
    ).toBe(502);
    // Invalid content never leaves the browser.
    expect(
      (
        await refused(
          publishingClient.readiness(
            { draftId },
            { ...content, coverKey: "missing" },
          ),
        )
      ).status,
    ).toBe(422);
    expect(upstream).toHaveBeenCalledTimes(3);
  });

  it("parses both submission outcomes", async () => {
    const command = {
      requestId,
      holder: { sessionId },
      content,
      baseRevisionId: revisionId,
    } as const;
    answer({ state: "not_ready", itemKeys: ["item-1"] });
    await expect(publishingClient.submit(command)).resolves.toEqual({
      state: "not_ready",
      itemKeys: ["item-1"],
    });
    answer(receipt);
    await expect(publishingClient.submit(command)).resolves.toEqual(receipt);
  });

  it.each([
    [
      "deleteDraft",
      () => publishingClient.deleteDraft(draftId, { requestId }),
      `publishing/drafts/${draftId}`,
      "DELETE",
      { deleted: true, snapshots: 2, conflictCopies: 0, mediaItems: 1 },
    ],
    [
      "deleteWork",
      () => publishingClient.deleteWork(workId, { requestId }),
      `works/${workId}`,
      "DELETE",
      { deleted: true },
    ],
    [
      "discardSession",
      () => publishingClient.discardSession(sessionId, { requestId }),
      `publishing/sessions/${sessionId}/discard`,
      "POST",
      { discarded: true },
    ],
    [
      "resetComponent",
      () => publishingClient.resetComponent(itemId, "motion", { requestId }),
      `publishing/items/${itemId}/components/motion/reset`,
      "POST",
      awaitingItem,
    ],
    [
      "cancelItem",
      () => publishingClient.cancelItem(itemId, { requestId }),
      `publishing/items/${itemId}/cancel`,
      "POST",
      awaitingItem,
    ],
    [
      "openWorkEditDraft",
      () =>
        publishingClient.openWorkEditDraft(workId, {
          requestId,
          deviceClass: "desktop",
        }),
      `publishing/works/${workId}/draft`,
      "POST",
      {
        draft: { ...draft, kind: "edit", workId, baseRevisionId: revisionId },
        created: true,
      },
    ],
    [
      "restoreSnapshot",
      () =>
        publishingClient.restoreSnapshot(draftId, {
          requestId,
          snapshotId: `work-snapshot-${"8".repeat(32)}`,
        }),
      `publishing/drafts/${draftId}/restore`,
      "POST",
      draft,
    ],
    [
      "createSession",
      () => publishingClient.createSession({ requestId, workId: null }),
      "publishing/sessions",
      "POST",
      {
        id: sessionId,
        state: "active",
        workId: null,
        leaseExpiresAt: at,
        createdAt: at,
      },
    ],
    [
      "heartbeatSession",
      () => publishingClient.heartbeatSession(sessionId),
      `publishing/sessions/${sessionId}/heartbeat`,
      "POST",
      {
        id: sessionId,
        state: "active",
        workId: null,
        leaseExpiresAt: at,
        createdAt: at,
      },
    ],
  ] as const)(
    "%s uses its exact route and method",
    async (_name, call, path, method, body) => {
      answer(body);
      await expect(call()).resolves.toEqual(body);
      const [target, init] = upstream.mock.calls[0]!;
      expect(target).toBe(`/api/community/${path}`);
      expect(init?.method).toBe(method);
      expect(init?.body).toBeTypeOf("string");
    },
  );

  describe("opening a work's edit draft", () => {
    const editDraft = {
      ...draft,
      kind: "edit",
      workId,
      baseRevisionId: revisionId,
      revision: 1,
    } as const;

    it("keeps the account's own answer about who created the draft", async () => {
      for (const created of [true, false]) {
        answer({ draft: editDraft, created });
        await expect(
          publishingClient.openWorkEditDraft(workId, {
            requestId,
            deviceClass: "desktop",
          }),
        ).resolves.toEqual({ draft: editDraft, created });
      }
    });

    it("refuses an answer that is only a draft, or names no creator", async () => {
      answer(editDraft);
      await refused(
        publishingClient.openWorkEditDraft(workId, {
          requestId,
          deviceClass: null,
        }),
      );
      answer({ draft: editDraft });
      await refused(
        publishingClient.openWorkEditDraft(workId, {
          requestId,
          deviceClass: null,
        }),
      );
    });

    it("refuses an opened draft that is not an edit draft", async () => {
      answer({ draft, created: true });
      await refused(
        publishingClient.openWorkEditDraft(workId, {
          requestId,
          deviceClass: null,
        }),
      );
    });
  });

  describe("conditional draft deletion", () => {
    const deletion = {
      deleted: true,
      snapshots: 1,
      conflictCopies: 1,
      mediaItems: 0,
    } as const;

    it("sends the revision the deletion was confirmed against, and nothing extra without one", async () => {
      answer(deletion);
      await expect(
        publishingClient.deleteDraft(draftId, {
          requestId,
          expectedRevision: 3,
        }),
      ).resolves.toEqual(deletion);
      expect(JSON.parse(String(upstream.mock.calls[0]![1]?.body))).toEqual({
        requestId,
        expectedRevision: 3,
      });
      answer(deletion);
      await publishingClient.deleteDraft(draftId, { requestId });
      expect(JSON.parse(String(upstream.mock.calls[1]![1]?.body))).toEqual({
        requestId,
      });
    });

    it("maps a 409 draft_changed to its own code with product text", async () => {
      answer(refusalBody("draft_changed", "CONFLICT"), 409);
      const error = await refused(
        publishingClient.deleteDraft(draftId, {
          requestId,
          expectedRevision: 3,
        }),
      );
      expect(error).toMatchObject({
        status: 409,
        code: "draft_changed",
        message: "草稿已在别处更改，未删除",
        outcomeUnknown: false,
      });
      // Another conflict keeps the generic wording and no code.
      answer(refusalBody("Request identity was already used", "CONFLICT"), 409);
      expect(
        await refused(publishingClient.deleteDraft(draftId, { requestId })),
      ).toMatchObject({ status: 409, code: null });
      // draft_changed is only a deletion conflict, never a field code of a 422.
      answer(refusalBody("draft_changed"), 422);
      expect(
        await refused(publishingClient.deleteDraft(draftId, { requestId })),
      ).toMatchObject({ status: 422, code: null });
    });

    it("refuses an invalid expected revision without sending it", async () => {
      for (const expectedRevision of [0, -1, 1.5]) {
        const error = await refused(
          publishingClient.deleteDraft(draftId, {
            requestId,
            expectedRevision,
          }),
        );
        expect(error).toMatchObject({ status: 422 });
      }
      expect(upstream).not.toHaveBeenCalled();
    });
  });

  it("re-exports the shared text rule and limits for Web counters", () => {
    for (const name of [
      "codePointLength",
      "normalizePublishingTitle",
      "normalizePublishingBody",
      "publishingContentIssues",
      "checkPublishingText",
      "publishingTitleRule",
      "publishingBodyRule",
      "WORK_TITLE_MAXIMUM",
      "WORK_BODY_MAXIMUM",
      "WORK_ITEMS_HARD_MAXIMUM",
      "WORK_ITEMS_CONFIGURABLE_MAXIMUM",
      "DRAFT_TEXT_RAW_ALLOWANCE",
      "AUTHORSHIP_REFERENCE_TITLE_MAXIMUM",
      "AUTHORSHIP_ORIGINAL_AUTHOR_MAXIMUM",
      "AUTHORSHIP_SOURCE_NOTE_MAXIMUM",
    ] as const) {
      expect(client[name]).toBe(contracts[name]);
      expect(publishingData[name]).toBe(contracts[name]);
    }
    expect(client.codePointLength("𠀀字")).toBe(2);
    expect(
      client.publishingContentIssues(
        { title: " \r\n ", body: "", itemCount: 0 },
        { maxItems: 50 },
      ),
    ).toEqual(["empty_work"]);
  });

  it("builds bounded page queries for drafts and history", async () => {
    const empty = { items: [], total: 0, page: 2, pageSize: 10, totalPages: 0 };
    answer(empty);
    answer(empty);
    await publishingClient.listDrafts({ page: 2, pageSize: 10 });
    await publishingClient.draftHistory(draftId, { page: 2, pageSize: 10 });
    expect(upstream.mock.calls.map(([path]) => path)).toEqual([
      "/api/community/publishing/drafts?page=2&pageSize=10",
      `/api/community/publishing/drafts/${draftId}/history?page=2&pageSize=10`,
    ]);
    const error = await refused(publishingClient.listDrafts({ pageSize: 51 }));
    expect(error.status).toBe(422);
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it.each<() => Promise<unknown>>([
    () => publishingClient.draft("../limits"),
    () => publishingClient.editableWork(`work-${"2".repeat(31)}`),
    () => publishingClient.item(componentId),
    () =>
      publishingClient.resetComponent(itemId, "../../x" as "still", {
        requestId,
      }),
    () => publishingClient.submissionReceipt("not-a-request"),
    () => publishingClient.heartbeatSession(draftId),
    () => publishingClient.readiness({ draftId: sessionId }, content),
    () => publishingClient.readiness({ sessionId: "../x" }, content),
  ])("never builds a path from an invalid id (%#)", async (call) => {
    const error = await refused(Promise.resolve().then(call));
    expect(error.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  describe("component uploads (Uppy XHR)", () => {
    it("names the streaming relay endpoint for a valid component only", () => {
      expect(publishingClient.uploadEndpoint(componentId)).toBe(
        `/api/community/publishing/uploads/${componentId}`,
      );
      expect(() =>
        publishingClient.uploadEndpoint("media-component-1"),
      ).toThrow(PublishingRequestError);
    });

    it("sends raw bytes with the confirmed account and the attempt fence", () => {
      expect(publishingClient.uploadHeaders(attempt)).toEqual({
        "content-type": "application/octet-stream",
        "x-author-account": account,
        "x-upload-attempt": attempt,
      });
      expect(() => publishingClient.uploadHeaders("attempt-1")).toThrow(
        PublishingRequestError,
      );
      authorClient.setAccount(null);
      expect(() => publishingClient.uploadHeaders(attempt)).toThrow(
        expect.objectContaining({ status: 401 }),
      );
    });

    const uploaded = {
      componentId,
      sha256: "e".repeat(64),
      receivedBytes: 2048,
      item: {
        ...awaitingItem,
        state: "processing",
        components: [
          {
            ...awaitingItem.components[0],
            state: "received",
            receivedBytes: 2048,
          },
        ],
      },
    };

    it("parses the upload answer for the account it was sent with", () => {
      expect(
        publishingClient.uploadResult(200, JSON.stringify(uploaded), account),
      ).toEqual(uploaded);
    });

    it("maps upload refusals to product text with known outcomes", () => {
      expect(() =>
        publishingClient.uploadResult(
          409,
          JSON.stringify(
            refusalBody("The transfer was superseded", "CONFLICT"),
          ),
          account,
        ),
      ).toThrow(
        expect.objectContaining({
          status: 409,
          code: null,
          message: "状态已变化，请检查后重试",
          outcomeUnknown: false,
        }),
      );
      expect(() =>
        publishingClient.uploadResult(
          413,
          JSON.stringify(refusalBody("original_item_too_large")),
          account,
        ),
      ).toThrow(
        expect.objectContaining({
          status: 413,
          code: "original_item_too_large",
          message: "原图超过单项大小上限",
          outcomeUnknown: false,
        }),
      );
      expect(() =>
        publishingClient.uploadResult(
          503,
          JSON.stringify(
            refusalBody(
              "Media uploads are not available",
              "SERVICE_UNAVAILABLE",
            ),
          ),
          account,
        ),
      ).toThrow(
        expect.objectContaining({ status: 503, outcomeUnknown: false }),
      );
    });

    it.each([
      ["a browser network failure", 0, ""],
      ["the relay's interrupted Backend connection", 502, ""],
      ["the relay's answer timeout", 504, ""],
      ["an empty 503", 503, ""],
      ["an unreadable success", 200, "{"],
      [
        "a success that breaks the contract",
        200,
        JSON.stringify({ receivedBytes: 1 }),
      ],
    ] as const)(
      "leaves the upload outcome unknown after %s",
      (_label, status, text) => {
        expect(() =>
          publishingClient.uploadResult(status, text, account),
        ).toThrow(expect.objectContaining({ outcomeUnknown: true }));
      },
    );

    it("never hands an upload answer to another account", () => {
      authorClient.setAccount(otherAccount);
      expect(() =>
        publishingClient.uploadResult(200, JSON.stringify(uploaded), account),
      ).toThrow(
        expect.objectContaining({
          status: 401,
          outcomeUnknown: true,
          message: "账户状态已变化，请刷新后检查操作结果",
        }),
      );
      expect(() =>
        publishingClient.uploadResult(
          409,
          JSON.stringify(refusalBody("The transfer was cancelled", "CONFLICT")),
          account,
        ),
      ).toThrow(
        expect.objectContaining({ status: 401, outcomeUnknown: false }),
      );
      authorClient.setAccount(null);
      expect(() =>
        publishingClient.uploadResult(200, JSON.stringify(uploaded), account),
      ).toThrow(expect.objectContaining({ status: 401 }));
    });
  });
});

// Chromium 111-115, Firefox 121-123 and Safari 16.4-17.3 lack AbortSignal.any
// (docs/development/browser-support.md). The Article authoring client has no
// test file of its own and shares this relay harness, so it is covered here.
describe("relay clients without AbortSignal.any", () => {
  beforeEach(() => {
    vi.spyOn(AbortSignal, "any").mockImplementation(() => {
      throw new TypeError("AbortSignal.any is not a function");
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  const hanging = () =>
    upstream.mockImplementationOnce(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) =>
          init!.signal!.addEventListener("abort", () =>
            reject(init!.signal!.reason),
          ),
        ),
    );
  const expiring = () => {
    const expiry = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(expiry.signal);
    return {
      timeout,
      expire: () =>
        expiry.abort(
          new DOMException("The operation timed out.", "TimeoutError"),
        ),
    };
  };
  const command = { requestId, content, deviceClass: "phone" } as const;

  describe("work publishing", () => {
    it("still sends a read and a write with a caller's signal", async () => {
      const caller = new AbortController();
      answer(awaitingItem);
      await expect(
        publishingClient.item(itemId, caller.signal),
      ).resolves.toEqual(awaitingItem);
      answer(draft, 201);
      await expect(
        publishingClient.createDraft(command, caller.signal),
      ).resolves.toEqual(draft);
      const [[readPath, read], [writePath, write]] = upstream.mock.calls as [
        [string, RequestInit],
        [string, RequestInit],
      ];
      expect(readPath).toBe(`/api/community/publishing/items/${itemId}`);
      expect(read).toMatchObject({
        method: "GET",
        headers: { accept: "application/json" },
      });
      expect(writePath).toBe("/api/community/publishing/drafts");
      expect(write).toMatchObject({
        method: "POST",
        headers: { "x-author-account": account },
      });
      expect(read.signal!.aborted).toBe(false);
      expect(write.signal!.aborted).toBe(false);
      // Finished requests are no longer linked to the caller's signal.
      caller.abort();
      expect(read.signal!.aborted).toBe(false);
      expect(write.signal!.aborted).toBe(false);
    });

    it("releases the caller's signal after a refused or failed request", async () => {
      const caller = new AbortController();
      answer(refusalBody("Synthetic refusal"), 500);
      await refused(publishingClient.item(itemId, caller.signal));
      upstream.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      await refused(publishingClient.createDraft(command, caller.signal));
      expect(upstream).toHaveBeenCalledTimes(2);
      caller.abort();
      for (const [, init] of upstream.mock.calls)
        expect(init!.signal!.aborted).toBe(false);
    });

    it("rethrows a caller's own abort as is, for a write too", async () => {
      const caller = new AbortController();
      hanging();
      const pending = publishingClient.createDraft(command, caller.signal);
      const reason = new DOMException("Synthetic departure", "AbortError");
      caller.abort(reason);
      await expect(pending).rejects.toBe(reason);
    });

    it("still leaves a write's outcome unknown after the request timeout", async () => {
      const { timeout, expire } = expiring();
      hanging();
      const pending = refused(
        publishingClient.createDraft(command, new AbortController().signal),
      );
      expect(upstream).toHaveBeenCalledOnce();
      expire();
      expect(await pending).toMatchObject({ status: 0, outcomeUnknown: true });
      expect(timeout).toHaveBeenCalledWith(15_000);
      expect(upstream.mock.calls[0]![1]!.signal!.reason).toMatchObject({
        name: "TimeoutError",
      });
    });

    it("discards an answer when the account switched away and back (A→B→A)", async () => {
      upstream.mockImplementationOnce(async () => {
        authorClient.setAccount(otherAccount);
        authorClient.setAccount(account);
        return Response.json(awaitingItem);
      });
      const error = await refused(
        publishingClient.item(itemId, new AbortController().signal),
      );
      expect(error.status).toBe(401);
    });
  });

  describe("article authoring", () => {
    const articleId = `article-${"7".repeat(32)}` as ArticleDraft["id"];
    const deletion = { requestId, expectedVersion: 3 };
    const failure = async (promise: Promise<unknown>) => {
      const error = await promise.then(
        () => {
          throw new Error("expected a failure");
        },
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(ArticleRequestError);
      return error as ArticleRequestError;
    };

    it("still sends a read and a write with a caller's signal", async () => {
      const caller = new AbortController();
      const page = { items: [], nextCursor: null };
      const deleted = { id: articleId, deleted: true, publicVersion: null };
      answer(page);
      await expect(
        articleAuthoringClient.list({ pageSize: 20 }, caller.signal),
      ).resolves.toEqual(page);
      answer(deleted);
      await expect(
        articleAuthoringClient.deleteDraft(articleId, deletion, caller.signal),
      ).resolves.toEqual(deleted);
      const [[readPath, read], [writePath, write]] = upstream.mock.calls as [
        [string, RequestInit],
        [string, RequestInit],
      ];
      expect(readPath).toBe("/api/community/article-authoring?pageSize=20");
      expect(read).toMatchObject({
        method: "GET",
        headers: { "x-author-account": account, accept: "application/json" },
      });
      expect(writePath).toBe(`/api/community/article-authoring/${articleId}`);
      expect(write).toMatchObject({
        method: "DELETE",
        headers: {
          "x-author-account": account,
          "content-type": "application/json",
        },
      });
      expect(read.signal!.aborted).toBe(false);
      expect(write.signal!.aborted).toBe(false);
      // Finished requests are no longer linked to the caller's signal.
      caller.abort();
      expect(read.signal!.aborted).toBe(false);
      expect(write.signal!.aborted).toBe(false);
    });

    it("releases the caller's signal after a refused or failed request", async () => {
      const caller = new AbortController();
      answer({ error: { code: "article_not_found" } }, 404);
      await failure(
        articleAuthoringClient.list({ pageSize: 20 }, caller.signal),
      );
      upstream.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      await failure(
        articleAuthoringClient.deleteDraft(articleId, deletion, caller.signal),
      );
      expect(upstream).toHaveBeenCalledTimes(2);
      caller.abort();
      for (const [, init] of upstream.mock.calls)
        expect(init!.signal!.aborted).toBe(false);
    });

    it("still ends on a caller's abort and on the request timeout", async () => {
      const caller = new AbortController();
      hanging();
      const aborted = failure(
        articleAuthoringClient.deleteDraft(articleId, deletion, caller.signal),
      );
      caller.abort();
      expect(await aborted).toMatchObject({ status: 0, outcomeUnknown: true });
      expect(upstream.mock.calls[0]![1]!.signal!.aborted).toBe(true);

      const { timeout, expire } = expiring();
      hanging();
      const expired = failure(
        articleAuthoringClient.list(
          { pageSize: 20 },
          new AbortController().signal,
        ),
      );
      expire();
      expect(await expired).toMatchObject({ status: 0, outcomeUnknown: false });
      expect(timeout).toHaveBeenCalledWith(15_000);
    });

    it("discards an answer when the account switched away and back (A→B→A)", async () => {
      upstream.mockImplementationOnce(async () => {
        authorClient.setAccount(otherAccount);
        authorClient.setAccount(account);
        return Response.json({ items: [], nextCursor: null });
      });
      const error = await failure(
        articleAuthoringClient.list(
          { pageSize: 20 },
          new AbortController().signal,
        ),
      );
      expect(error).toMatchObject({
        status: 401,
        reason: "article_account_changed",
      });
    });
  });
});
