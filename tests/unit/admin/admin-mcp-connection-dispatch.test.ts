import type { PayloadRequest } from "payload";
import { describe, expect, it, vi } from "vitest";

import { adminMcpDispatch } from "admin/admin-mcp";

// What a request looks like past the login door, which the socket suite cannot see:
// the same shape the key door gives the native handler, on the one AI row.

const door = vi.hoisted(() => ({
  runtime: {
    clients: new Map([["artvenn-synthetic-tool", { label: "Synthetic tool" }]]),
    verifyAccessToken: () =>
      Promise.resolve({
        connectionId: "conn-synthetic",
        subject: "payload-user-7",
        clientId: "artvenn-synthetic-tool",
        resource: "https://admin.artvenn.invalid/api/mcp",
        issuer: "https://auth.artvenn.invalid",
        scopes: ["artvenn:admin"],
        generation: 1,
        expiresAt: "2099-01-01T00:00:00Z",
      }),
    readConnection: () =>
      Promise.resolve({
        connection: {
          id: "conn-synthetic",
          principalLabel: "agent-synthetic-tool",
          humanAccountId: "payload-user-7",
          client: "synthetic",
          environment: "synthetic",
          oauthClientId: "artvenn-synthetic-tool",
          consentedAt: new Date().toISOString(),
          preset: "operator",
          status: "authorized",
          generation: 1,
          revokedAt: null,
        },
        grant: {
          grantId: "grant-synthetic",
          connectionId: "conn-synthetic",
          generationAtConsent: 1,
          oauthClientId: "artvenn-synthetic-tool",
          humanSubject: "payload-user-7",
          issuer: "https://auth.artvenn.invalid",
          resource: "https://admin.artvenn.invalid/api/mcp",
          presetAtConsent: "operator",
          capabilityScopes: ["artvenn:admin"],
          consentedAt: new Date().toISOString(),
        },
      }),
    issuer: "https://auth.artvenn.invalid",
    resource: "https://admin.artvenn.invalid/api/mcp",
    environment: "synthetic",
    close: () => Promise.resolve(),
  },
}));

vi.mock(
  "../../../apps/admin/src/agent-connections/resource",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    resourceRuntime: () => door.runtime,
  }),
);

describe("dispatch of an operator connection", () => {
  it("sends it to the native handler, with the MCP request shape, as the AI row", async () => {
    const plugin = vi.fn(() => Promise.resolve(new Response("plugin")));
    const req = {
      method: "GET",
      url: "http://synthetic/api/mcp",
      headers: new Headers({
        authorization: [
          "Bearer",
          ["artvenn", "ct", "synthetic"].join("_"),
        ].join(" "),
      }),
      payload: {
        config: { routes: { api: "/api" } },
        find: vi.fn(() =>
          Promise.resolve({
            docs: [
              { id: 7, role: "owner", email: "owner@example.invalid" },
              {
                id: 3,
                role: "ai_operator",
                email: "ai-connection@operator.invalid",
              },
            ],
          }),
        ),
        db: {
          drizzle: {
            execute: vi.fn(() =>
              Promise.resolve({
                rows: [
                  {
                    pause: false,
                    threshold: "20",
                    dm: false,
                    evidence: false,
                    raw_ip: false,
                    self_only: false,
                  },
                ],
              }),
            ),
          },
        },
        logger: { warn: vi.fn(), error: vi.fn() },
      },
    } as unknown as PayloadRequest;
    const answer = await adminMcpDispatch(plugin)(req);
    expect(answer.status).toBe(405);
    expect(answer.headers.get("allow")).toBe("POST");
    expect(plugin).not.toHaveBeenCalled();
    expect(req.payloadAPI).toBe("MCP");
    expect(req.user).toMatchObject({
      id: 3,
      role: "ai_operator",
      collection: "users",
      _strategy: "mcp-connection",
    });
  });
});
