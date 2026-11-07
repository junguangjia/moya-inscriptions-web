import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";

import {
  createBackendApplication,
  createBackendServer,
  startServer,
  stopServer,
} from "@moya/backend-runtime";
import { AI_OPERATOR_REQUEST_ID_HEADER } from "@moya/contracts/internal/admin-mcp";
import { MappedStorageUrlResolver } from "@moya/image";
import { handleOperatorRequest } from "@moya/backend-runtime/internal/community-operator";
import type { OperatorRouteDependencies } from "@moya/backend-runtime/internal/community-operator";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InMemoryCommunityCommentPort } from "./community-comment-fixture.js";
import { InMemoryCommunityIdentityPort } from "./community-identity-fixture.js";

// A later table: today's has no row reaching a labelled service, so nothing else
// could show which label those services are handed.
vi.mock("@moya/contracts/internal/admin-mcp", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@moya/contracts/internal/admin-mcp")
  >()),
  aiOperatorRouteFor: (method: string, path: string) => ({
    method,
    path,
    klass: "write",
    credentials: ["base", "community"],
  }),
}));

const ownerToken = randomBytes(32).toString("base64url");
const baseToken = randomBytes(32).toString("base64url");
const communityToken = randomBytes(32).toString("base64url");

const servers = new Set<Server>();
afterEach(async () => {
  await Promise.all(
    [...servers].map(async (server) => {
      await stopServer(server);
      servers.delete(server);
    }),
  );
});

const start = async () => {
  const threadService = {
    operatorCreate: vi.fn(async () => ({})),
  };
  const timelineService = {
    operatorCreate: vi.fn(async () => ({})),
  };
  const directMessageService = {
    operatorRead: vi.fn(async () => ({})),
  };
  const contentOperatorPort = {
    moderateWork: vi.fn(async () => ({})),
  };
  const dependencies = {
    moderationService: {},
    aiServices: { moderationService: {} },
    threadService,
    timelineService,
    directMessageService,
    contentOperatorPort,
    operatorCredential: ownerToken,
    aiCredentials: { base: baseToken },
  } as unknown as OperatorRouteDependencies;
  const server = createServer((request, response) => {
    void handleOperatorRequest(
      request,
      response,
      new URL(request.url!, "http://request.invalid").pathname,
      dependencies,
    );
  });
  servers.add(server);
  const address = await startServer(server, { host: "127.0.0.1", port: 0 });
  const post = async (token: string, route: string, body: unknown) => {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/internal/community/${route}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    expect(response.status, route).toBe(200);
  };
  return {
    post,
    threadService,
    timelineService,
    directMessageService,
    contentOperatorPort,
  };
};

describe("the label the operator services are handed", () => {
  it.each([
    ["ai-admin", baseToken],
    ["owner", ownerToken],
  ])("is %s for its own credential", async (label, token) => {
    const backend = await start();
    const command = { requestId: randomUUID() };
    await backend.post(token, "threads", command);
    expect(backend.threadService.operatorCreate).toHaveBeenCalledWith(
      label,
      command,
    );
    await backend.post(token, "timeline-entries", command);
    expect(backend.timelineService.operatorCreate).toHaveBeenCalledWith(
      label,
      command,
    );
    await backend.post(token, "messages/conversation", command);
    expect(backend.directMessageService.operatorRead).toHaveBeenCalledWith(
      label,
      command,
    );
    const work = `work-${"a".repeat(32)}`;
    await backend.post(token, `works/${work}/moderation`, {
      ...command,
      state: "hidden",
      expectedVersion: 1,
      reason: "Synthetic reason",
    });
    expect(backend.contentOperatorPort.moderateWork).toHaveBeenCalledWith(
      work,
      label,
      expect.objectContaining({ state: "hidden" }),
    );
  });
});

describe("the service factory per label", () => {
  const start = async () => {
    const report = {
      id: `report-${"a".repeat(32)}`,
      claimant: { name: "Synthetic", contact: "synthetic", rightsBasis: "x" },
      evidence: [],
    };
    const reportingPort = {
      decide: vi.fn<(...args: unknown[]) => Promise<typeof report>>(
        async () => report,
      ),
    };
    const publishingOperatorPort = {
      moderateSubmission: vi.fn<(...args: unknown[]) => Promise<object>>(
        async () => ({}),
      ),
    };
    const commentPort = new InMemoryCommunityCommentPort();
    const writePolicy = vi.spyOn(commentPort, "writePublicationPolicy");
    const server = createBackendServer(
      createBackendApplication({
        nodeEnv: "development",
        communityIdentityPort: new InMemoryCommunityIdentityPort(),
        storageUrlResolver: new MappedStorageUrlResolver(new Map()),
        communityCommentPort: commentPort,
        reportingPort: reportingPort as never,
        publishingOperatorPort: publishingOperatorPort as never,
        communityOperatorCredential: ownerToken,
        operatorAiCommunityCredential: communityToken,
      }),
    );
    servers.add(server);
    const address = await startServer(server, { host: "127.0.0.1", port: 0 });
    const send = (
      token: string,
      method: string,
      route: string,
      body: unknown,
    ) =>
      fetch(`http://127.0.0.1:${address.port}/internal/community/${route}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          // The Owner's routes read no key, and AI's keyed ones need one.
          [AI_OPERATOR_REQUEST_ID_HEADER]: randomUUID(),
        },
        body: JSON.stringify(body),
      });
    return { send, reportingPort, publishingOperatorPort, writePolicy };
  };

  it.each([
    ["ai-admin", communityToken],
    ["owner", ownerToken],
  ])("records %s on every service it builds", async (label, token) => {
    const backend = await start();
    const decided = await backend.send(
      token,
      "POST",
      `reports/report-${"a".repeat(32)}/decisions`,
      { expectedVersion: 1, action: "retain", reason: "Synthetic" },
    );
    expect(backend.reportingPort.decide.mock.calls[0]?.[0]).toBe(label);
    // The report here is a stub, so only the AI projection can refuse its shape.
    expect(decided.status).toBe(label === "owner" ? 200 : 500);
    await backend.send(
      token,
      "POST",
      `publishing/submissions/work-revision-${"a".repeat(32)}/moderation`,
      {
        requestId: randomUUID(),
        action: "approve",
        expectedVersion: 1,
        reason: "Synthetic",
      },
    );
    expect(
      backend.publishingOperatorPort.moderateSubmission.mock.calls[0]?.[1],
    ).toBe(label);
    await backend.send(token, "PUT", "publication-policy", {
      policy: "PRE_MODERATION",
    });
    expect(backend.writePolicy.mock.calls[0]?.[1]).toBe(label);
  });
});
