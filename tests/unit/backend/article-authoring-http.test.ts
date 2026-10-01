import { createServer, type Server } from "node:http";
import {
  ArticleAuthoringService,
  CommunityConflictError,
  CommunityNotFoundError,
  CommunitySessionService,
} from "@moya/api";
import type { ArticleAuthoringPort } from "@moya/api";
import {
  articleDraftSchema,
  emptyArticleDocument,
} from "@moya/contracts/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBackendApplication,
  createDevelopmentCatalogFixtureQueryPort,
} from "@moya/backend-runtime";
import { UnconfiguredStorageUrlResolver } from "@moya/image";
import { handleArticleAuthoringRequest } from "../../../services/backend-runtime/src/community/article-authoring-handler.ts";
import {
  fixtureUsers,
  InMemoryCommunityIdentityPort,
} from "./community-identity-fixture.js";

const id = `article-${"1".repeat(32)}`;
const requestId = "10000000-0000-4000-8000-000000000001";
const document = emptyArticleDocument();
const draft = articleDraftSchema.parse({
  id,
  ownerId: fixtureUsers.active.id,
  version: 1,
  title: "合成专题",
  coverRefId: null,
  document,
  status: "draft",
  publicVersion: null,
  updatedAt: "2026-09-30T00:00:00.000Z",
  fingerprint: "0".repeat(64),
});
const createCommand = {
  requestId,
  title: draft.title,
  coverRefId: null,
  document,
};
const candidate = {
  requestId,
  expectedVersion: 1,
  fingerprint: draft.fingerprint,
};
const servers = new Set<Server>();
afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          servers.delete(server);
        }),
    ),
  );
});
const start = async (nodeEnv?: "development" | "test" | "production") => {
  const identity = new InMemoryCommunityIdentityPort();
  const sessions = new CommunitySessionService(identity);
  const grant = await sessions.signInDevelopmentAccount(
    fixtureUsers.active.handle,
  );
  if (grant === null) throw new Error("Missing synthetic account");
  const port = {
    create: vi.fn<ArticleAuthoringPort["create"]>(async () => draft),
    read: vi.fn(async () => draft),
    listOwnMedia: vi.fn<ArticleAuthoringPort["listOwnMedia"]>(async () => ({
      items: [],
      nextCursor: null,
    })),
    list: vi.fn(async () => ({ items: [], nextCursor: null })),
    save: vi.fn(async () => draft),
    editBlocks: vi.fn(async () => draft),
    validate: vi.fn(async () => ({
      id: draft.id,
      version: 1,
      fingerprint: draft.fingerprint,
      valid: true,
      issues: [],
    })),
    preview: vi.fn(async () => ({
      draft,
      validation: {
        id: draft.id,
        version: 1,
        fingerprint: draft.fingerprint,
        valid: true,
        issues: [],
      },
    })),
    publish: vi.fn(async () => ({ ...draft, status: "pending" as const })),
    withdraw: vi.fn(async () => ({ ...draft, status: "withdrawn" as const })),
    readPublished: vi.fn(async () => null),
    listPublished: vi.fn(async () => ({ items: [], total: 0 })),
  } satisfies ArticleAuthoringPort;
  const service = new ArticleAuthoringService(port);
  const directListener = (
    request: Parameters<typeof handleArticleAuthoringRequest>[0],
    response: Parameters<typeof handleArticleAuthoringRequest>[1],
  ) => {
    const path = new URL(request.url ?? "/", "http://request.invalid").pathname
      .slice("/v1/community/article-authoring".length)
      .split("/")
      .filter(Boolean);
    void handleArticleAuthoringRequest(
      request,
      response,
      path,
      service,
      sessions,
    );
  };
  const server = createServer(
    nodeEnv === undefined
      ? directListener
      : createBackendApplication({
          nodeEnv,
          articleAuthoringPort: port,
          communityIdentityPort: identity,
          catalogQueryPort: createDevelopmentCatalogFixtureQueryPort(),
          storageUrlResolver: new UnconfiguredStorageUrlResolver(),
        }),
  );
  servers.add(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Missing test listener");
  const base = `http://127.0.0.1:${address.port}/v1/community/article-authoring`;
  const headers = {
    authorization: `Bearer ${grant.token}`,
    "x-author-account": grant.profile.id,
    "content-type": "application/json",
  };
  const send = (
    path = "",
    method = "GET",
    body?: unknown,
    suppliedHeaders = headers,
  ) =>
    fetch(base + path, {
      method,
      headers: suppliedHeaders,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { port, send, headers, sessions, grant };
};

describe("private human Article HTTP boundary", () => {
  it("mounts the authenticated route in Development and excludes it elsewhere", async () => {
    const development = await start("development");
    expect((await development.send("", "POST", createCommand)).status).toBe(
      201,
    );
    for (const nodeEnv of ["test", "production"] as const) {
      const isolated = await start(nodeEnv);
      expect((await isolated.send("", "POST", createCommand)).status).toBe(404);
      expect(isolated.port.create).not.toHaveBeenCalled();
    }
  });
  it("refuses anonymous requests before calling persistence", async () => {
    const { port, send } = await start();
    const response = await send("", "POST", createCommand, {} as never);
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(port.create).not.toHaveBeenCalled();
  });
  it("fences missing or stale account identity even on a private read", async () => {
    const { port, send, headers } = await start();
    for (const account of [undefined, fixtureUsers.second.id]) {
      const supplied = {
        authorization: headers.authorization,
        ...(account ? { "x-author-account": account } : {}),
      };
      expect(
        (await send(`/${id}`, "GET", undefined, supplied as never)).status,
      ).toBe(401);
    }
    expect(port.read).not.toHaveBeenCalled();
  });
  it("binds creation to the session and refuses forged ownership", async () => {
    const { port, send } = await start();
    expect(
      (
        await send("", "POST", {
          ...createCommand,
          authorId: fixtureUsers.second.id,
        })
      ).status,
    ).toBe(422);
    expect(port.create).not.toHaveBeenCalled();
    const response = await send("", "POST", createCommand);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(draft);
    expect(port.create.mock.calls[0]?.[0]).toEqual({
      source: "human",
      userId: fixtureUsers.active.id,
    });
  });
  it("allows a valid long document above the ordinary relay body limit", async () => {
    const { port, send } = await start();
    const longDocument = {
      ...document,
      blocks: Array.from({ length: 200 }, (_, i) => ({
        id: `p${i}`,
        type: "paragraph",
        props: {},
        children: [],
        content: [{ type: "text", text: "碑".repeat(200), styles: {} }],
      })),
    };
    const command = { ...createCommand, document: longDocument };
    expect(Buffer.byteLength(JSON.stringify(command))).toBeGreaterThan(100000);
    expect((await send("", "POST", command)).status).toBe(201);
    expect(port.create).toHaveBeenCalledOnce();
  });
  it("rejects duplicate/unknown list parameters and identity-bearing candidates", async () => {
    const { port, send } = await start();
    expect((await send("?pageSize=1&pageSize=2")).status).toBe(422);
    expect((await send("?authorId=other")).status).toBe(422);
    expect(
      (await send(`/${id}/publish`, "POST", { ...candidate, confirmed: true }))
        .status,
    ).toBe(422);
    expect(port.list).not.toHaveBeenCalled();
    expect(port.publish).not.toHaveBeenCalled();
  });
  it("keeps pending publication distinct from a live publication", async () => {
    const { send } = await start();
    const response = await send(`/${id}/publish`, "POST", candidate);
    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe("pending");
  });
  it("maps stale versions to conflict and hides other-owner drafts", async () => {
    const { port, send } = await start();
    port.save.mockRejectedValueOnce(
      new CommunityConflictError("article_revision_conflict"),
    );
    expect(
      (await send(`/${id}`, "PUT", { ...createCommand, expectedVersion: 1 }))
        .status,
    ).toBe(409);
    port.read.mockRejectedValueOnce(new CommunityNotFoundError());
    expect((await send(`/${id}`)).status).toBe(404);
  });
  it("rechecks revoked sessions and refuses oversized payloads", async () => {
    const { port, send, sessions, grant } = await start();
    expect(
      (
        await send("", "POST", {
          ...createCommand,
          extra: "x".repeat(2 * 1024 * 1024),
        })
      ).status,
    ).toBe(422);
    expect(port.create).not.toHaveBeenCalled();
    await sessions.signOut(grant.token);
    expect((await send(`/${id}`)).status).toBe(401);
    expect(port.read).not.toHaveBeenCalled();
  });
});

describe("Article own media HTTP page", () => {
  it("binds a bounded query to the current session with private cache headers", async () => {
    const { send, port } = await start();
    const response = await send("/media?pageSize=2");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ items: [], nextCursor: null });
    expect(port.listOwnMedia).toHaveBeenCalledWith(
      { source: "human", userId: fixtureUsers.active.id },
      { pageSize: 2 },
      expect.any(Date),
    );
  });
  it("rejects duplicate, unbounded or forged owner queries before persistence", async () => {
    const { send, port } = await start();
    for (const query of [
      "pageSize=51",
      "pageSize=1&pageSize=2",
      `ownerId=${fixtureUsers.second.id}`,
      "cursor=%3D",
    ]) {
      expect((await send(`/media?${query}`)).status).toBe(422);
    }
    expect(port.listOwnMedia).not.toHaveBeenCalled();
  });
  it("refuses an account switch even before browsing owned media", async () => {
    const { send, port, headers } = await start();
    expect(
      (
        await send("/media", "GET", undefined, {
          ...headers,
          "x-author-account": fixtureUsers.second.id,
        })
      ).status,
    ).toBe(401);
    expect(port.listOwnMedia).not.toHaveBeenCalled();
  });
});
