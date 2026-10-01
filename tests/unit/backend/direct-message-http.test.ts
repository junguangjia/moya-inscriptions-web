import {
  createBackendApplication,
  createBackendServer,
  startServer,
  stopServer,
} from "@moya/backend-runtime";
import {
  apiErrorSchema,
  developmentSessionSchema,
  directConversationPageSchema,
  directMessageSchema,
  directMessageUnreadSchema,
} from "@moya/contracts/schemas";
import { MappedStorageUrlResolver } from "@moya/image";
import { afterEach, describe, expect, it } from "vitest";

import { InMemoryCommunityIdentityPort } from "./community-identity-fixture.js";

import type {
  AuthorCommunityPort,
  DirectMessagePort,
  DirectMessageSendInput,
} from "@moya/api";
import type { DirectConversation, DirectMessage } from "@moya/contracts";
import type { Server } from "node:http";

const servers = new Set<Server>();
const conversationId = `dm-${"c".repeat(32)}` as DirectConversation["id"];

class FixturePort implements DirectMessagePort {
  readonly sends: (DirectMessageSendInput & { actor: string })[] = [];
  readonly reads: { actor: string; sequence: number }[] = [];
  conversation(viewer: string): DirectConversation {
    return {
      id: conversationId,
      participant: {
        id: `user-${"9".repeat(32)}` as never,
        displayName: "对方",
        available: true,
      },
      state: "requested",
      canSend: false,
      sendRefusal: "request_pending",
      lastMessage: null,
      unreadCount: viewer === "x" ? 1 : 0,
      muted: false,
      hidden: false,
      readSequence: 0,
      createdAt: "2026-09-22T00:00:00.000Z",
    };
  }
  async send(
    actor: string,
    input: DirectMessageSendInput,
  ): Promise<DirectMessage> {
    this.sends.push({ ...input, actor });
    return {
      id: `dmsg-${"d".repeat(32)}` as never,
      conversationId,
      sequence: 1,
      senderId: actor as never,
      text: input.text,
      removed: false,
      createdAt: "2026-09-22T00:00:01.000Z",
    };
  }
  async listConversations(actor: string) {
    return { items: [this.conversation(actor)], nextCursor: null };
  }
  async readConversation(actor: string) {
    return {
      conversation: this.conversation(actor),
      items: [],
      nextBefore: null,
    };
  }
  async findConversationWith() {
    return null;
  }
  async setHidden(actor: string) {
    return { ...this.conversation(actor), hidden: true };
  }
  async setMuted(actor: string) {
    return { ...this.conversation(actor), muted: true };
  }
  async markRead(actor: string, _id: unknown, sequence: number) {
    this.reads.push({ actor, sequence });
    return this.conversation(actor);
  }
  async unread() {
    return { unreadConversations: 2 };
  }
  async operatorReadConversation(): Promise<never> {
    throw new Error("not exercised");
  }
  async operatorFindConversation() {
    return null;
  }
  async operatorRemoveMessage(): Promise<never> {
    throw new Error("not exercised");
  }
}

const start = async (
  nodeEnv: "development" | "production",
  port?: DirectMessagePort,
) => {
  const server = createBackendServer(
    createBackendApplication({
      nodeEnv,
      communityIdentityPort: new InMemoryCommunityIdentityPort(),
      authorCommunityPort: {} as unknown as AuthorCommunityPort,
      storageUrlResolver: new MappedStorageUrlResolver(new Map()),
      ...(port ? { directMessagePort: port } : {}),
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
  return `http://${address.address}:${address.port}`;
};
const signIn = async (base: string, handle: string) =>
  developmentSessionSchema.parse(
    await (
      await fetch(`${base}/v1/development/sign-in`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle }),
      })
    ).json(),
  );

afterEach(async () => {
  await Promise.all(
    [...servers].map(async (server) => {
      await stopServer(server);
      servers.delete(server);
    }),
  );
});

describe("direct message HTTP surface (content-community-completion-v1)", () => {
  it("requires a session everywhere and derives the sender from it, never from the body", async () => {
    const port = new FixturePort();
    const base = await start("development", port);
    expect((await fetch(`${base}/v1/community/messages`)).status).toBe(401);
    expect((await fetch(`${base}/v1/community/messages/unread`)).status).toBe(
      401,
    );
    const session = await signIn(base, "dev-user-01");
    const headers = {
      authorization: `Bearer ${session.token}`,
      "content-type": "application/json",
      "x-author-account": session.profile.id,
    };
    const sent = await fetch(`${base}/v1/community/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestId: "11111111-1111-4111-8111-111111111111",
        recipientId: `user-${"9".repeat(32)}`,
        text: "  你好  ",
        senderId: "user-forged",
      }),
    });
    // A forged senderId is not part of the contract: strict input refuses it.
    expect(sent.status).toBe(422);
    const ok = await fetch(`${base}/v1/community/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestId: "11111111-1111-4111-8111-111111111111",
        recipientId: `user-${"9".repeat(32)}`,
        text: "  你好  ",
      }),
    });
    expect(ok.status).toBe(201);
    const message = directMessageSchema.parse(await ok.json());
    expect(message.senderId).toBe(session.profile.id);
    expect(port.sends[0]?.actor).toBe(session.profile.id);
    const list = directConversationPageSchema.parse(
      await (await fetch(`${base}/v1/community/messages`, { headers })).json(),
    );
    expect(list.items[0]?.sendRefusal).toBe("request_pending");
    const unread = directMessageUnreadSchema.parse(
      await (
        await fetch(`${base}/v1/community/messages/unread`, { headers })
      ).json(),
    );
    expect(unread.unreadConversations).toBe(2);
    const read = await fetch(
      `${base}/v1/community/messages/${conversationId}/read`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          requestId: "22222222-2222-4222-8222-222222222222",
          sequence: 5,
        }),
      },
    );
    expect(read.status).toBe(200);
    expect(port.reads).toEqual([{ actor: session.profile.id, sequence: 5 }]);
    const both = await fetch(`${base}/v1/community/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestId: "33333333-3333-4333-8333-333333333333",
        recipientId: `user-${"9".repeat(32)}`,
        conversationId,
        text: "x",
      }),
    });
    expect(both.status).toBe(422);
    expect(apiErrorSchema.parse(await both.json()).error.code).toBe(
      "INVALID_INPUT",
    );
  });

  it("is absent without a port and outside Development, including the operator routes", async () => {
    const withoutPort = await start("development");
    const session = await signIn(withoutPort, "dev-user-01");
    expect(
      (
        await fetch(`${withoutPort}/v1/community/messages`, {
          headers: { authorization: `Bearer ${session.token}` },
        })
      ).status,
    ).toBe(404);
    const production = await start("production", new FixturePort());
    expect((await fetch(`${production}/v1/community/messages`)).status).toBe(
      404,
    );
  });
});
