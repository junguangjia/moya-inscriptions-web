import { randomBytes, randomUUID } from "node:crypto";
import {
  CommunityAuthService,
  createMemoryCommunityAuthPort,
  CommunityConflictError,
  CommunitySessionService,
  CommunityStoreUnavailableError,
} from "@moya/api";
import type { FeedbackPort, PublishingMediaStorePort } from "@moya/api";
import type { FeedbackReceipt, SubmitFeedbackRequest } from "@moya/contracts";
import type { OperatorFeedbackQuery } from "@moya/contracts/internal/community-operator";
import { operatorFeedbackPageSchema } from "@moya/contracts/internal/community-operator";
import {
  apiErrorSchema,
  feedbackReceiptSchema,
  submitFeedbackRequestSchema,
} from "@moya/contracts/schemas";
import {
  createBackendApplication,
  createBackendServer,
  startServer,
  stopServer,
} from "@moya/backend-runtime";
import type { Server } from "node:http";
import { MappedStorageUrlResolver } from "@moya/image";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryCommunityCommentPort } from "./community-comment-fixture.js";
import {
  fixtureUsers,
  InMemoryCommunityIdentityPort,
} from "./community-identity-fixture.js";

const servers = new Set<Server>();
const operatorCredential = "synthetic-feedback-operator-0123456789";
class FixturePort implements FeedbackPort {
  readonly saved = new Map<
    string,
    { actor: string; input: SubmitFeedbackRequest; receipt: FeedbackReceipt }
  >();
  unavailable = false;
  async resolveFeedbackImage(feedbackId: string, itemId: string) {
    return [...this.saved.values()].some(
      (x) => x.receipt.id === feedbackId && x.input.imageIds?.includes(itemId),
    )
      ? {
          storageKey: "blobs/aa/bb/" + "a".repeat(32),
          contentType: "image/webp" as const,
          byteSize: 3,
          sha256: "a".repeat(64),
        }
      : null;
  }

  async submitFeedback(actor: string, input: SubmitFeedbackRequest) {
    if (this.unavailable) throw new CommunityStoreUnavailableError();
    const key = `${actor}:${input.submissionId}`;
    const previous = this.saved.get(key);
    if (previous) {
      if (
        previous.input.message !== input.message ||
        JSON.stringify(previous.input.imageIds ?? []) !==
          JSON.stringify(input.imageIds ?? [])
      )
        throw new CommunityConflictError();
      return previous.receipt;
    }
    const receipt = {
      id: `feedback-${randomUUID().replaceAll("-", "")}`,
      createdAt: new Date().toISOString(),
    };
    this.saved.set(key, { actor, input, receipt });
    return receipt;
  }
  async operatorListFeedback(query: OperatorFeedbackQuery) {
    if (this.unavailable) throw new CommunityStoreUnavailableError();
    return operatorFeedbackPageSchema.parse({
      items: [...this.saved.values()].map(({ actor, input, receipt }) => ({
        ...receipt,
        message: input.message,
        user: { id: actor, displayName: "Synthetic feedback user" },
      })),
      total: this.saved.size,
      ...query,
    });
  }
}
const mediaStore: PublishingMediaStorePort = {
  writeStream: async () => {
    throw Error("unused");
  },
  remove: async () => {},
  listBlobs: async () => ({ entries: [], nextAfter: null }),
  openRead: async () => ({
    status: "ok",
    byteSize: 3,
    start: 0,
    end: 2,
    contentLength: 3,
    body: (async function* () {
      yield Buffer.from("abc");
    })(),
    close: async () => {},
  }),
};
const start = async (nodeEnv: "development" | "production") => {
  const identity = new InMemoryCommunityIdentityPort();
  const sessions = new CommunitySessionService(identity);
  const port = new FixturePort();
  const server = createBackendServer(
    createBackendApplication({
      nodeEnv,
      communityIdentityPort: identity,
      storageUrlResolver: new MappedStorageUrlResolver(new Map()),
      feedbackPort: port,
      publishingMediaStore: mediaStore,
      communityCommentPort: new InMemoryCommunityCommentPort(),
      communityOperatorCredential: operatorCredential,
      authRequestSource: () => null,
      authService: new CommunityAuthService(createMemoryCommunityAuthPort(), {
        environment: nodeEnv,
        profile: "password-only",
        keys: {
          version: 1,
          lookupKey: randomBytes(32),
          encryptionKey: randomBytes(32),
          otpKey: randomBytes(32),
        },
        emailMode: "disabled",
        phoneMode: "disabled",
        delivery: {
          sendEmail: async () => ({ state: "failed" }),
          sendPhone: async () => ({ state: "failed" }),
          checkPhone: async () => "fail",
        },
      }),
      ...(nodeEnv === "production"
        ? {
            catalogQueryPort: {
              list: async () => ({
                items: [],
                total: 0,
                page: 1,
                pageSize: 1,
                totalPages: 0,
              }),
              getById: async () => null,
            },
          }
        : {}),
    }),
  );
  servers.add(server);
  const address = await startServer(server, { host: "127.0.0.1", port: 0 });
  const session = (await sessions.signInDevelopmentAccount("dev-user-01"))!;
  const headers = {
    authorization: `Bearer ${session.token}`,
    "content-type": "application/json",
    "x-author-account": fixtureUsers.active.id,
  };
  return {
    base: `http://${address.address}:${address.port}`,
    port,
    identity,
    headers,
  };
};
afterEach(async () => {
  await Promise.all(
    [...servers].map(async (server) => {
      await stopServer(server);
      servers.delete(server);
    }),
  );
});

describe("private settings feedback HTTP", () => {
  it.each(["development", "production"] as const)(
    "saves a trimmed request and retries its receipt in %s",
    async (nodeEnv) => {
      const { base, port, headers } = await start(nodeEnv);
      const body = JSON.stringify({
        submissionId: randomUUID(),
        message: "  改善设置体验\n  ",
      });
      const response = await fetch(`${base}/v1/community/feedback`, {
        method: "POST",
        headers,
        body,
      });
      expect(response.status).toBe(201);
      expect(response.headers.get("cache-control")).toContain("no-store");
      const receipt = feedbackReceiptSchema.parse(await response.json());
      expect(Object.keys(receipt).sort()).toEqual(["createdAt", "id"]);
      expect([...port.saved.values()][0]?.input.message).toBe("改善设置体验");
      const retry = await fetch(`${base}/v1/community/feedback`, {
        method: "POST",
        headers,
        body,
      });
      expect(await retry.json()).toEqual(receipt);
      expect(port.saved.size).toBe(1);
    },
  );

  it("rejects guests, missing or stale account identity and suspended sessions before saving", async () => {
    const { base, headers, port, identity } = await start("development");
    const url = `${base}/v1/community/feedback`;
    const body = JSON.stringify({
      submissionId: randomUUID(),
      message: "Synthetic feedback",
    });
    for (const requestHeaders of [
      {},
      {
        authorization: headers.authorization,
        "content-type": "application/json",
      },
      { ...headers, "x-author-account": fixtureUsers.second.id },
      { ...headers, authorization: "Bearer malformed" },
    ]) {
      expect(
        (await fetch(url, { method: "POST", headers: requestHeaders, body }))
          .status,
      ).toBe(401);
    }
    identity.setStatus(fixtureUsers.active.id, "suspended");
    expect((await fetch(url, { method: "POST", headers, body })).status).toBe(
      401,
    );
    expect(port.saved.size).toBe(0);
  });

  it("validates strict commands and gives bounded conflict/store errors", async () => {
    const { base, headers, port } = await start("development");
    const url = `${base}/v1/community/feedback`;
    const command = {
      submissionId: randomUUID(),
      message: "Synthetic feedback",
    };
    const post = (body: string, path = url) =>
      fetch(path, { method: "POST", headers, body });
    for (const input of [
      { ...command, message: " \n\t" },
      { ...command, message: "a".repeat(5001) },
      { ...command, userId: fixtureUsers.second.id },
      { ...command, submissionId: "bad" },
    ]) {
      const response = await post(JSON.stringify(input));
      expect(response.status).toBe(422);
      expect(apiErrorSchema.parse(await response.json()).error.code).toBe(
        "INVALID_INPUT",
      );
    }
    expect((await post("{")).status).toBe(422);
    expect(
      (await post(JSON.stringify(command), `${url}?unexpected=1`)).status,
    ).toBe(400);
    expect((await post(JSON.stringify(command))).status).toBe(201);
    expect(
      (await post(JSON.stringify({ ...command, message: "Changed" }))).status,
    ).toBe(409);
    port.unavailable = true;
    expect((await post(JSON.stringify(command))).status).toBe(503);
    const get = await fetch(url, { headers });
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    expect(port.saved.size).toBe(1);
  });

  it("exposes a read-only list only through the operator boundary", async () => {
    const { base, headers } = await start("development");
    await fetch(`${base}/v1/community/feedback`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        submissionId: randomUUID(),
        message: "Synthetic private feedback",
      }),
    });
    const url = `${base}/internal/community/feedback`;
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers })).status).toBe(401);
    const operator = { authorization: `Bearer ${operatorCredential}` };
    const response = await fetch(url, { headers: operator });
    expect(response.status).toBe(200);
    const page = operatorFeedbackPageSchema.parse(await response.json());
    expect(page.items[0]?.user.id).toBe(fixtureUsers.active.id);
    expect(page.items[0]?.message).toBe("Synthetic private feedback");
    for (const query of ["page=1&page=2", "pageSize=51", "search=private"])
      expect(
        (await fetch(`${url}?${query}`, { headers: operator })).status,
      ).toBe(400);
    expect(
      (await fetch(url, { method: "POST", headers: operator })).status,
    ).toBe(405);
    expect(
      (await fetch(`${base}/v1/community/feedback/private`, { headers }))
        .status,
    ).toBe(404);
  });

  it("contract preserves the exact 5000-character limit after trimming", () => {
    expect(
      submitFeedbackRequestSchema.parse({
        submissionId: randomUUID(),
        message: ` ${"文".repeat(5000)} `,
      }).message,
    ).toHaveLength(5000);
  });
});

describe("private feedback image HTTP", () => {
  it("streams only associated rendered variants after operator authentication", async () => {
    const { base, headers } = await start("development"),
      imageId = "media-item-" + "a".repeat(32);
    const saved = await fetch(`${base}/v1/community/feedback`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        submissionId: randomUUID(),
        message: "Synthetic feedback image",
        imageIds: [imageId],
      }),
    });
    const receipt = feedbackReceiptSchema.parse(await saved.json());
    const url = `${base}/internal/community/feedback/${receipt.id}/images/${imageId}/display`;
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers })).status).toBe(401);
    const operator = { authorization: `Bearer ${operatorCredential}` };
    const result = await fetch(url, { headers: operator });
    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toContain("image/webp");
    expect(result.headers.get("cache-control")).toContain("private");
    expect(result.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await result.text()).toBe("abc");
    expect(
      (await fetch(url, { headers: operator, method: "HEAD" })).status,
    ).toBe(200);
    expect(
      (await fetch(url, { headers: operator, method: "POST" })).status,
    ).toBe(405);
    expect(
      (await fetch(url + "?unexpected=1", { headers: operator })).status,
    ).toBe(400);
    expect(
      (await fetch(url.replace("/display", "/original"), { headers: operator }))
        .status,
    ).toBe(404);
    expect(
      (
        await fetch(url.replace(receipt.id, "feedback-" + "b".repeat(32)), {
          headers: operator,
        })
      ).status,
    ).toBe(404);
  });
  it("rejects too many and repeated image identities before a save", async () => {
    const { base, headers, port } = await start("development");
    for (const imageIds of [
      ["media-item-" + "a".repeat(32), "media-item-" + "a".repeat(32)],
      Array.from(
        { length: 4 },
        () => `media-item-${randomUUID().replaceAll("-", "")}`,
      ),
    ]) {
      expect(
        (
          await fetch(`${base}/v1/community/feedback`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              submissionId: randomUUID(),
              message: "Bad images",
              imageIds,
            }),
          })
        ).status,
      ).toBe(422);
    }
    expect(port.saved.size).toBe(0);
  });
});
