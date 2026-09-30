import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { CommunityAuthService, createMemoryCommunityAuthPort } from "@moya/api";
import {
  createBackendApplication,
  createBackendServer,
  startServer,
  stopServer,
} from "@moya/backend-runtime";
import { serializeOpenApiDocument } from "@moya/public-api";
import { afterEach, describe, expect, it } from "vitest";

describe("Development password HTTP and OpenAPI", () => {
  const servers = new Set<Server>();
  afterEach(async () => {
    await Promise.all([...servers].map((server) => stopServer(server)));
    servers.clear();
  });
  it("keeps password Session grants on the server boundary and reset free of Session creation", async () => {
    let code = "";
    const port = createMemoryCommunityAuthPort();
    const service = new CommunityAuthService(port, {
      environment: "development",
      profile: "full-local",
      keys: {
        version: 1,
        lookupKey: Buffer.alloc(32, 21),
        encryptionKey: Buffer.alloc(32, 22),
        otpKey: Buffer.alloc(32, 23),
      },
      emailMode: "local_capture",
      phoneMode: "disabled",
      delivery: {
        sendEmail: async (input) => {
          code = input.code;
          return { state: "accepted", correlation: "synthetic-http" };
        },
        sendPhone: async () => ({ state: "failed" }),
        checkPhone: async () => "fail",
      },
    });
    const server = createBackendServer(
      createBackendApplication({
        nodeEnv: "development",
        authService: service,
        communityIdentityPort: {
          findDevelopmentAccountByHandle: async () => null,
          createSession: async () => undefined,
          findSessionUser: async () => null,
          revokeSession: async () => false,
          setUserStatus: async () => null,
        },
      }),
    );
    servers.add(server);
    const address = await startServer(server, { host: "127.0.0.1", port: 0 });
    const url = `http://127.0.0.1:${address.port}/v1/community/auth/`;
    const post = (path: string, body: unknown) =>
      fetch(url + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const identifier = "synthetic-http@example.invalid";
    // Challenge response fields are selected explicitly, never logged.
    const sent = await post("challenges", {
      channel: "email",
      purpose: "register",
      identifier,
      idempotencyKey: randomUUID(),
    });
    const accepted = (await sent.json()) as {
      challengeId: string;
      continuationToken: string;
    };
    const verified = await post("challenges/verify", {
      challengeId: accepted.challengeId,
      continuationToken: accepted.continuationToken,
      code,
      idempotencyKey: randomUUID(),
    });
    const handoff = (await verified.json()) as { handoffToken: string };
    const unicodeSample = "SYNTHETIC_A1雪";
    const replacementSample = "SYNTHETIC_B2雪";
    const registered = await post("registrations", {
      handoffToken: handoff.handoffToken,
      displayName: "HTTP owner",
      studioName: "接口斋",
      password: unicodeSample,
      agreement: true,
      idempotencyKey: randomUUID(),
    });
    expect(registered.status).toBe(201);
    const missing = await post("passwords/login", {
      channel: "email",
      identifier: "missing-http@example.invalid",
      password: unicodeSample,
      idempotencyKey: randomUUID(),
    });
    expect(missing.status).toBe(401);
    const signed = await post("passwords/login", {
      channel: "email",
      identifier,
      password: unicodeSample,
      idempotencyKey: randomUUID(),
    });
    expect(signed.status).toBe(200);
    const session = (await signed.json()) as {
      outcome: string;
      session?: { token?: unknown };
    };
    expect(session.outcome).toBe("signed_in");
    expect(typeof session.session?.token).toBe("string");
    const resetSent = await post("challenges", {
      channel: "email",
      purpose: "password_reset",
      identifier,
      idempotencyKey: randomUUID(),
    });
    const resetAccepted = (await resetSent.json()) as {
      challengeId: string;
      continuationToken: string;
    };
    const resetVerified = await post("challenges/verify", {
      challengeId: resetAccepted.challengeId,
      continuationToken: resetAccepted.continuationToken,
      code,
      idempotencyKey: randomUUID(),
    });
    const resetProof = (await resetVerified.json()) as {
      outcome: string;
      handoffToken: string;
    };
    expect(resetProof.outcome).toBe("password_reset_required");
    const malformed = await post("passwords/reset", {
      handoffToken: resetProof.handoffToken,
      password: "TEST_ONLY",
      idempotencyKey: randomUUID(),
    });
    expect(malformed.status).toBe(422);
    const reset = await post("passwords/reset", {
      handoffToken: resetProof.handoffToken,
      password: replacementSample,
      idempotencyKey: randomUUID(),
    });
    expect(reset.status).toBe(200);
    const result = (await reset.json()) as { reset?: unknown };
    expect(result.reset).toBe(true);
    expect(Object.keys(result).sort()).toEqual(["reset"]);
  });
  it("documents reset's actual validation status and write-only Unicode password policy", () => {
    const document = JSON.parse(serializeOpenApiDocument());
    const reset = document.paths["/v1/community/auth/passwords/reset"].post;
    expect(reset.responses["422"] !== undefined).toBe(true);
    const policy =
      document.components.schemas.AuthPasswordResetRequest.properties.password;
    expect(policy.writeOnly).toBe(true);
    expect(policy.description.includes("Unicode code points")).toBe(true);
  });
});
