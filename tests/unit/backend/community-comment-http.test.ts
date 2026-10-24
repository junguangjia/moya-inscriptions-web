import {
  createBackendApplication,
  createBackendServer,
  startServer,
  stopServer,
} from "@moya/backend-runtime";
import {
  apiErrorSchema,
  catalogCommentPageSchema,
  catalogCommentSchema,
  developmentSessionSchema,
} from "@moya/contracts/schemas";
import { afterEach, describe, expect, it } from "vitest";

import {
  FixtureCatalogPublicationPort,
  InMemoryCommunityCommentPort,
  publishedCatalogId,
} from "./community-comment-fixture.js";
import { InMemoryCommunityIdentityPort } from "./community-identity-fixture.js";

import type { ApiErrorCode } from "@moya/contracts";
import type { Server } from "node:http";

const servers = new Set<Server>();
const operatorCredential = "synthetic-operator-credential-for-unit-tests";

const start = async (
  options: {
    readonly commentPort?: InMemoryCommunityCommentPort;
    readonly identityPort?: InMemoryCommunityIdentityPort;
    readonly credential?: string;
  } = {},
) => {
  const commentPort = options.commentPort ?? new InMemoryCommunityCommentPort();
  const identityPort =
    options.identityPort ??
    new InMemoryCommunityIdentityPort(undefined, undefined, commentPort.events);
  const server = createBackendServer(
    createBackendApplication({
      nodeEnv: "development",
      communityIdentityPort: identityPort,
      communityCommentPort: commentPort,
      catalogPublicationPort: new FixtureCatalogPublicationPort(),
      communityOperatorCredential: options.credential ?? operatorCredential,
    }),
  );
  servers.add(server);
  const address = await startServer(server, { host: "127.0.0.1", port: 0 });
  const baseUrl = `http://${address.address}:${address.port}`;
  const signIn = async (handle = "dev-user-01") => {
    const response = await fetch(`${baseUrl}/v1/development/sign-in`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle }),
    });
    return developmentSessionSchema.parse(await response.json()).token;
  };
  return { baseUrl, commentPort, identityPort, signIn };
};

afterEach(async () => {
  await Promise.all(
    [...servers].map(async (server) => {
      await stopServer(server);
      servers.delete(server);
    }),
  );
});

const expectApiError = async (
  response: Response,
  status: number,
  code: ApiErrorCode,
) => {
  expect(response.status).toBe(status);
  const body = apiErrorSchema.parse(await response.json());
  expect(body.error.code).toBe(code);
  return body;
};

const postComment = (
  baseUrl: string,
  token: string | undefined,
  body: unknown,
  catalogId: string = publishedCatalogId,
) =>
  fetch(`${baseUrl}/v1/catalog/${catalogId}/comments`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });

describe("Community V1 comment HTTP surface", () => {
  it("reads comments anonymously and creates them only with a session", async () => {
    const { baseUrl, commentPort, signIn } = await start();
    commentPort.policy = "DIRECT_PUBLICATION";

    const empty = await fetch(
      `${baseUrl}/v1/catalog/${publishedCatalogId}/comments`,
    );
    expect(empty.status).toBe(200);
    expect(catalogCommentPageSchema.parse(await empty.json())).toMatchObject({
      items: [],
      total: 0,
    });

    await expectApiError(
      await postComment(baseUrl, undefined, { text: "未登录" }),
      401,
      "UNAUTHENTICATED",
    );

    const token = await signIn();
    const created = await postComment(baseUrl, token, { text: "第一条评论" });
    expect(created.status).toBe(201);
    const comment = catalogCommentSchema.parse(await created.json());
    expect(comment.author.displayName).toBe("拓片爱好者");
    expect(JSON.stringify(comment)).not.toMatch(/moderation|handle|status/u);

    const page = await fetch(
      `${baseUrl}/v1/catalog/${publishedCatalogId}/comments`,
    );
    expect(
      catalogCommentPageSchema.parse(await page.json()).items,
    ).toHaveLength(1);
  });

  it("serves the hot section and honours a pinned load-more sequence", async () => {
    const { baseUrl, signIn } = await start();
    const token = await signIn();
    const older = catalogCommentSchema.parse(
      await (await postComment(baseUrl, token, { text: "较早的评论" })).json(),
    );
    const newer = catalogCommentSchema.parse(
      await (await postComment(baseUrl, token, { text: "较新的评论" })).json(),
    );
    const replied = await fetch(
      `${baseUrl}/v1/catalog/${publishedCatalogId}/comments/${older.id}/replies`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ text: "一条回复" }),
      },
    );
    expect(replied.status).toBe(201);

    const listing = catalogCommentPageSchema.parse(
      await (
        await fetch(`${baseUrl}/v1/catalog/${publishedCatalogId}/comments`)
      ).json(),
    );
    expect(listing.hot.map((item) => item.id)).toEqual([older.id]);
    expect(listing.hot[0]?.replyTotal).toBe(1);
    expect(listing.items.map((item) => item.id)).toEqual([newer.id]);

    const pinned = catalogCommentPageSchema.parse(
      await (
        await fetch(
          `${baseUrl}/v1/catalog/${publishedCatalogId}/comments?pinned=${older.id}&pageSize=1`,
        )
      ).json(),
    );
    expect(pinned.hot).toEqual([]);
    expect(pinned.items.map((item) => item.id)).toEqual([newer.id]);

    for (const query of ["?pinned=", "?pinned=a,a", "?pinned=a&pinned=b"])
      await expectApiError(
        await fetch(
          `${baseUrl}/v1/catalog/${publishedCatalogId}/comments${query}`,
        ),
        400,
        "INVALID_QUERY",
      );
    // The reply page never takes a pinned set.
    await expectApiError(
      await fetch(
        `${baseUrl}/v1/catalog/${publishedCatalogId}/comments/${older.id}/replies?pinned=${newer.id}`,
      ),
      400,
      "INVALID_QUERY",
    );
  });

  it("answers 202 while the submission awaits Owner approval", async () => {
    const { baseUrl, commentPort, signIn } = await start();
    commentPort.policy = "PRE_MODERATION";
    const token = await signIn();
    const created = await postComment(baseUrl, token, { text: "待审核评论" });
    expect(created.status).toBe(202);
    const comment = catalogCommentSchema.parse(await created.json());
    // The pending item is not readable yet.
    const page = await fetch(
      `${baseUrl}/v1/catalog/${publishedCatalogId}/comments`,
    );
    expect(catalogCommentPageSchema.parse(await page.json()).items).toEqual([]);
    expect(comment.text).toBe("待审核评论");
  });

  it("maps invalid bodies, unknown records and bad queries to their codes", async () => {
    const { baseUrl, signIn } = await start();
    const token = await signIn();

    for (const body of [{}, { text: "" }, { text: "x".repeat(1_001) }])
      await expectApiError(
        await postComment(baseUrl, token, body),
        422,
        "INVALID_INPUT",
      );

    await expectApiError(
      await fetch(`${baseUrl}/v1/catalog/catalog-unknown-99/comments`),
      404,
      "ITEM_NOT_FOUND",
    );
    await expectApiError(
      await postComment(
        baseUrl,
        token,
        { text: "未发布" },
        "catalog-unknown-99",
      ),
      404,
      "ITEM_NOT_FOUND",
    );
    await expectApiError(
      await fetch(
        `${baseUrl}/v1/catalog/${publishedCatalogId}/comments?pageSize=51`,
      ),
      400,
      "INVALID_QUERY",
    );
    await expectApiError(
      await fetch(
        `${baseUrl}/v1/catalog/${publishedCatalogId}/comments?unknown=1`,
      ),
      400,
      "INVALID_QUERY",
    );

    const wrongMethod = await fetch(
      `${baseUrl}/v1/catalog/${publishedCatalogId}/comments`,
      { method: "DELETE" },
    );
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("GET, POST");
  });

  it("keeps replies one level deep and behind a visible root", async () => {
    const { baseUrl, commentPort, signIn } = await start();
    commentPort.policy = "DIRECT_PUBLICATION";
    const token = await signIn();
    const root = catalogCommentSchema.parse(
      await (await postComment(baseUrl, token, { text: "根评论" })).json(),
    );
    const repliesUrl = `${baseUrl}/v1/catalog/${publishedCatalogId}/comments/${root.id}/replies`;

    const reply = await fetch(repliesUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ text: "一条回复" }),
    });
    expect(reply.status).toBe(201);

    const page = await fetch(repliesUrl);
    expect(page.status).toBe(200);
    expect((await page.json()).items).toHaveLength(1);

    await commentPort.applyCommentModeration(root.id, "hidden", ["visible"]);
    await expectApiError(await fetch(repliesUrl), 404, "ITEM_NOT_FOUND");
    await expectApiError(
      await fetch(repliesUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ text: "隐藏后的回复" }),
      }),
      404,
      "ITEM_NOT_FOUND",
    );
  });

  it("maps store unavailability to 503 without leaking the cause", async () => {
    const { baseUrl, commentPort, signIn } = await start();
    const token = await signIn();
    commentPort.unavailable = true;
    const body = await expectApiError(
      await fetch(`${baseUrl}/v1/catalog/${publishedCatalogId}/comments`),
      503,
      "SERVICE_UNAVAILABLE",
    );
    expect(JSON.stringify(body)).not.toMatch(/Community store|sql|pg/iu);
    await expectApiError(
      await postComment(baseUrl, token, { text: "后端不可用" }),
      503,
      "SERVICE_UNAVAILABLE",
    );
  });

  // A malformed percent escape makes decodeURIComponent throw. Anonymous
  // callers must get 404, never an unhandled URIError that ends the request.
  it("answers 404 for a malformed percent escape in either path segment", async () => {
    const { baseUrl, signIn } = await start();
    const token = await signIn();
    const malformed = "%E0%A4";
    const targets = [
      `${baseUrl}/v1/catalog/${malformed}/comments`,
      `${baseUrl}/v1/catalog/${publishedCatalogId}/comments/${malformed}/replies`,
      `${baseUrl}/v1/catalog/${malformed}/comments/${malformed}/replies`,
    ];
    for (const target of targets) {
      expect((await fetch(target)).status, `GET ${target}`).toBe(404);
      const written = await fetch(target, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ text: "格式错误的路径" }),
      });
      expect(written.status, `POST ${target}`).toBe(404);
    }
  });
});

describe("Community V1 operator boundary", () => {
  // `null` omits the header entirely; a string is sent verbatim.
  const operatorFetch = (
    baseUrl: string,
    path: string,
    init: RequestInit = {},
    credential: string | null = operatorCredential,
  ) =>
    fetch(`${baseUrl}/internal/community/${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        ...(credential === null
          ? {}
          : { authorization: `Bearer ${credential}` }),
      },
    });

  it("refuses every request without the exact operator credential", async () => {
    const { baseUrl } = await start();
    for (const credential of [
      null,
      "",
      "wrong-credential",
      `${operatorCredential}x`,
      operatorCredential.slice(0, -1),
      operatorCredential.toUpperCase(),
    ]) {
      const response = await operatorFetch(
        baseUrl,
        "publication-policy",
        {},
        credential,
      );
      expect(response.status).toBe(401);
      expect(JSON.stringify(await response.json())).not.toContain(
        operatorCredential,
      );
    }
    // The correct credential still works, so the check is not simply closed.
    expect((await operatorFetch(baseUrl, "publication-policy")).status).toBe(
      200,
    );
  });

  it("stays closed when no credential is configured", async () => {
    const { baseUrl } = await start({ credential: "" });
    for (const credential of [null, "", "anything"])
      expect(
        (await operatorFetch(baseUrl, "publication-policy", {}, credential))
          .status,
      ).toBe(401);
  });

  it("reads and switches the publication setting and records who and when", async () => {
    const { baseUrl, commentPort } = await start();
    const initial = await operatorFetch(baseUrl, "publication-policy");
    expect(initial.status).toBe(200);
    // DIRECT_PUBLICATION is the initial default (scope amendment 2026-09-12).
    expect(await initial.json()).toMatchObject({
      policy: "DIRECT_PUBLICATION",
    });

    const switched = await operatorFetch(baseUrl, "publication-policy", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ policy: "PRE_MODERATION" }),
    });
    expect(switched.status).toBe(200);
    expect(await switched.json()).toMatchObject({
      policy: "PRE_MODERATION",
      updatedBy: "owner",
    });
    expect(commentPort.events.at(-1)).toMatchObject({
      action: "set_publication_policy",
      subjectKind: "setting",
      operatorLabel: "owner",
      detail: "PRE_MODERATION",
    });

    const invalid = await operatorFetch(baseUrl, "publication-policy", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ policy: "SOMETHING_ELSE" }),
    });
    expect(invalid.status).toBe(400);
  });

  it("approves, hides and unhides a comment and audits each action", async () => {
    const { baseUrl, commentPort, signIn } = await start();
    commentPort.policy = "PRE_MODERATION";
    const token = await signIn();
    const created = catalogCommentSchema.parse(
      await (await postComment(baseUrl, token, { text: "待审核评论" })).json(),
    );

    const queue = await operatorFetch(baseUrl, "comments?moderation=pending");
    expect(queue.status).toBe(200);
    const queueBody = (await queue.json()) as {
      items: { id: string; moderation: string; author: { handle: string } }[];
    };
    expect(queueBody.items.map((item) => item.id)).toEqual([created.id]);
    expect(queueBody.items[0]?.moderation).toBe("pending");
    expect(queueBody.items[0]?.author.handle).toBe("dev-user-01");

    for (const [action, moderation] of [
      ["approve", "visible"],
      ["hide", "hidden"],
      ["unhide", "visible"],
    ] as const) {
      const response = await operatorFetch(
        baseUrl,
        `comments/${created.id}/moderation`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: "Synthetic human decision", action }),
        },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ id: created.id, moderation });
      expect(commentPort.events.at(-1)).toMatchObject({
        action,
        subjectKind: "comment",
        subjectId: created.id,
        operatorLabel: "owner",
      });
    }

    const page = await fetch(
      `${baseUrl}/v1/catalog/${publishedCatalogId}/comments`,
    );
    expect(
      catalogCommentPageSchema.parse(await page.json()).items,
    ).toHaveLength(1);

    const unknown = await operatorFetch(
      baseUrl,
      "comments/comment-ffffffffffffffffffffffffffffffff/moderation",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reason: "Synthetic human decision",
          action: "approve",
        }),
      },
    );
    expect(unknown.status).toBe(404);

    // The comment is visible again, so approving it is not an edge of the
    // machine: a stale-state conflict, refused rather than silently rewritten.
    const audited = commentPort.events.length;
    const outOfMachine = await operatorFetch(
      baseUrl,
      `comments/${created.id}/moderation`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reason: "Synthetic human decision",
          action: "approve",
        }),
      },
    );
    expect(outOfMachine.status).toBe(409);
    expect(await outOfMachine.json()).toEqual({
      error: { status: 409, code: "STATE_CONFLICT" },
    });
    expect(commentPort.comments.get(created.id)?.moderation).toBe("visible");
    expect(commentPort.events).toHaveLength(audited);
  });

  it("rejects a pending item, moderates a bounded selection and reports each outcome", async () => {
    const { baseUrl, commentPort, signIn } = await start();
    commentPort.policy = "PRE_MODERATION";
    const token = await signIn();
    const pending = catalogCommentSchema.parse(
      await (await postComment(baseUrl, token, { text: "待拒绝" })).json(),
    );
    const other = catalogCommentSchema.parse(
      await (await postComment(baseUrl, token, { text: "待通过" })).json(),
    );
    const json = (body: unknown) => ({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    const rejected = await operatorFetch(
      baseUrl,
      `comments/${pending.id}/moderation`,
      json({ reason: "Synthetic human decision", action: "reject" }),
    );
    expect(rejected.status).toBe(200);
    expect(await rejected.json()).toEqual({
      id: pending.id,
      moderation: "hidden",
    });
    expect(commentPort.events.at(-1)).toMatchObject({
      action: "reject",
      subjectId: pending.id,
    });

    const bulk = await operatorFetch(
      baseUrl,
      "comments/moderation",
      json({
        reason: "Synthetic human decision",
        action: "approve",
        ids: [other.id, pending.id, "comment-ffffffffffffffffffffffffffffffff"],
      }),
    );
    expect(bulk.status).toBe(200);
    expect(await bulk.json()).toEqual({
      action: "approve",
      results: [
        { id: other.id, outcome: "applied", moderation: "visible" },
        { id: pending.id, outcome: "conflict" },
        {
          id: "comment-ffffffffffffffffffffffffffffffff",
          outcome: "not_found",
        },
      ],
      applied: 1,
      conflicts: 1,
      notFound: 1,
      failed: 0,
    });
    const tooMany = await operatorFetch(
      baseUrl,
      "comments/moderation",
      json({
        reason: "Synthetic human decision",
        action: "approve",
        ids: Array.from(
          { length: 51 },
          (_value, index) => `comment-${index.toString(16).padStart(32, "0")}`,
        ),
      }),
    );
    expect(tooMany.status).toBe(400);
    // The body never carries an id or an actor label.
    const envelope = await operatorFetch(
      baseUrl,
      `comments/${other.id}/moderation`,
      json({
        reason: "Synthetic human decision",
        action: "hide",
        id: other.id,
      }),
    );
    expect(envelope.status).toBe(400);
  });

  it("serves item detail, the history, the summary and the analysis state", async () => {
    const { baseUrl, commentPort, signIn } = await start();
    const token = await signIn();
    const root = catalogCommentSchema.parse(
      await (await postComment(baseUrl, token, { text: "根评论" })).json(),
    );
    const replied = await fetch(
      `${baseUrl}/v1/catalog/${publishedCatalogId}/comments/${root.id}/replies`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ text: "一条回复" }),
      },
    );
    const reply = (await replied.json()) as { id: string };
    await operatorFetch(baseUrl, `comments/${root.id}/moderation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        reason: "Synthetic human decision",
        action: "hide",
      }),
    });

    const detail = await operatorFetch(baseUrl, `comments/${reply.id}`);
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as {
      item: { id: string; catalogTitle: string | null };
      root: { id: string } | null;
      parentRestriction: string;
      history: unknown[];
      analysis: { status: string };
    };
    expect(body.item.id).toBe(reply.id);
    expect(body.item.catalogTitle).toBe(`资料 ${publishedCatalogId}`);
    expect(body.root?.id).toBe(root.id);
    expect(body.parentRestriction).toBe("root_hidden");
    expect(body.history).toEqual([]);
    expect(body.analysis).toEqual({ status: "not_connected" });
    expect(
      (
        await operatorFetch(
          baseUrl,
          "comments/comment-ffffffffffffffffffffffffffffffff",
        )
      ).status,
    ).toBe(404);
    expect(
      await (
        await operatorFetch(baseUrl, `comments/${root.id}/analysis`)
      ).json(),
    ).toEqual({ status: "not_connected" });

    const listing = await operatorFetch(
      baseUrl,
      "comments?search=%E5%9B%9E%E5%A4%8D&kind=reply&order=oldest&pageSize=50",
    );
    expect(listing.status).toBe(200);
    const page = (await listing.json()) as {
      items: { id: string }[];
      counts: { all: number };
    };
    expect(page.items.map((item) => item.id)).toEqual([reply.id]);
    expect(page.counts.all).toBe(1);
    for (const query of [
      "comments?order=hot",
      "comments?pageSize=51",
      "comments?search=",
    ])
      expect((await operatorFetch(baseUrl, query)).status).toBe(400);

    const events = await operatorFetch(
      baseUrl,
      `moderation-events?subjectId=${root.id}`,
    );
    expect(events.status).toBe(200);
    expect(
      ((await events.json()) as { items: { action: string }[] }).items.map(
        (event) => event.action,
      ),
    ).toEqual(["hide"]);
    const summary = await operatorFetch(baseUrl, "summary?range=24h");
    expect(summary.status).toBe(200);
    expect(await summary.json()).toMatchObject({
      range: { key: "24h" },
      queue: { visible: 1, hidden: 1, all: 2 },
      actions: { hide: 1 },
      analysis: { connected: false },
    });
    expect((await operatorFetch(baseUrl, "summary?range=1y")).status).toBe(400);
    expect(commentPort.events).toHaveLength(1);
  });

  it("answers 404 for a malformed percent escape on either operator route", async () => {
    const { baseUrl } = await start();
    for (const path of ["comments/%E0%A4/moderation", "users/%E0%A4/status"]) {
      const response = await operatorFetch(baseUrl, path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reason: "Synthetic human decision",
          action: "approve",
        }),
      });
      expect(response.status, path).toBe(404);
    }
  });

  it("suspends and reinstates an author without touching comment state", async () => {
    const { baseUrl, commentPort, identityPort, signIn } = await start();
    commentPort.policy = "DIRECT_PUBLICATION";
    const token = await signIn();
    const created = catalogCommentSchema.parse(
      await (await postComment(baseUrl, token, { text: "公开评论" })).json(),
    );

    const suspended = await operatorFetch(
      baseUrl,
      `users/${created.author.id}/status`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reason: "Synthetic human decision",
          action: "suspend",
        }),
      },
    );
    expect(suspended.status).toBe(200);
    expect(await suspended.json()).toMatchObject({
      id: created.author.id,
      status: "suspended",
      revokedSessions: 1,
    });
    // The comment stays visible; suspension is not a takedown.
    expect(commentPort.comments.get(created.id)?.moderation).toBe("visible");
    // The revoked session can no longer write.
    const afterSuspension = await postComment(baseUrl, token, {
      text: "停用后的评论",
    });
    expect(afterSuspension.status).toBe(401);

    const reinstated = await operatorFetch(
      baseUrl,
      `users/${created.author.id}/status`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reason: "Synthetic human decision",
          action: "reinstate",
        }),
      },
    );
    expect(reinstated.status).toBe(200);
    expect(await reinstated.json()).toMatchObject({ status: "active" });
    expect(identityPort.users.get(created.author.id)?.status).toBe("active");
    expect(commentPort.events.map((event) => event.action)).toContain(
      "suspend",
    );
  });

  it("is not reachable through the versioned Public API surface", async () => {
    const { baseUrl } = await start();
    for (const path of [
      "/v1/internal/community/publication-policy",
      "/v1/community/publication-policy",
      "/v1/catalog/publication-policy/comments/x/replies/../../internal",
    ]) {
      const response = await fetch(`${baseUrl}${path}`, {
        headers: { authorization: `Bearer ${operatorCredential}` },
      });
      expect(response.status).not.toBe(200);
    }
  });
  it.each([
    { label: "missing", reason: undefined },
    { label: "blank", reason: "   " },
    { label: "too long", reason: "x".repeat(2001) },
  ])(
    "requires a bounded human reason before a moderation mutation ($label)",
    async ({ reason }) => {
      const { baseUrl, commentPort, identityPort, signIn } = await start();
      const token = await signIn();
      const item = catalogCommentSchema.parse(
        await (
          await postComment(baseUrl, token, {
            text: "Synthetic reason boundary",
          })
        ).json(),
      );
      const eventCount = commentPort.events.length;
      const initialModeration = commentPort.comments.get(item.id)?.moderation;
      for (const [path, fields] of [
        [`comments/${item.id}/moderation`, { action: "hide" }],
        ["comments/moderation", { action: "hide", ids: [item.id] }],
        [`users/${item.author.id}/status`, { action: "suspend" }],
      ] as const) {
        const response = await operatorFetch(baseUrl, path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...fields,
            ...(reason === undefined ? {} : { reason }),
          }),
        });
        expect(response.status).toBe(400);
      }
      expect(commentPort.events).toHaveLength(eventCount);
      expect(commentPort.comments.get(item.id)?.moderation).toBe(
        initialModeration,
      );
      expect(identityPort.users.get(item.author.id)?.status).toBe("active");
    },
  );
});
