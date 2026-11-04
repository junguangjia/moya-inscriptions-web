import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";

import { startServer, stopServer } from "@moya/backend-runtime";
import { handleOperatorRequest } from "@moya/backend-runtime/internal/community-operator";
import type { OperatorRouteDependencies } from "@moya/backend-runtime/internal/community-operator";
import { afterEach, describe, expect, it, vi } from "vitest";

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
    credentials: ["base"],
  }),
}));

const ownerToken = randomBytes(32).toString("base64url");
const baseToken = randomBytes(32).toString("base64url");

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
  const directMessageService = {
    operatorRead: vi.fn(async () => ({})),
  };
  const contentOperatorPort = {
    moderateWork: vi.fn(async () => ({})),
  };
  const dependencies = {
    moderationService: {},
    threadService,
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
  return { post, threadService, directMessageService, contentOperatorPort };
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
