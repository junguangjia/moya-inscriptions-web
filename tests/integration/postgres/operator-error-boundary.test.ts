/**
 * content-community-completion-v1, integration finding C2: an unexpected error
 * in an operator route must stay a failure of that one request.
 *
 * Before the repair, the direct-message and Thread operator handlers rethrew
 * unmapped errors outside the operator boundary, and the router started the
 * handler without awaiting it, so a single Owner action terminated the Backend
 * for every user. This suite runs the real HTTP server, router and handlers
 * over the real PostgreSQL adapters under the runtime App role. The unexpected
 * errors are raised by the database itself (test-only triggers), not by a
 * mocked handler.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";

import {
  createBackendApplication,
  createBackendServer,
  createDevelopmentCatalogFixtureQueryPort,
  startServer,
  stopServer,
} from "@moya/backend-runtime";
import {
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import {
  PostgresAuthorCommunityAdapter,
  PostgresCommunityCommentAdapter,
  PostgresCommunityIdentityAdapter,
  PostgresDirectMessageAdapter,
  PostgresThreadAdapter,
  runCommunityMigrations,
} from "@moya/community-postgres";
import { developmentSessionSchema } from "@moya/contracts/schemas";
import { UnconfiguredStorageUrlResolver } from "@moya/image";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { requireSyntheticTestDatabaseUrl } from "./synthetic-test-database.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const target = requireSyntheticTestDatabaseUrl();
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(target).hostname))
  throw Error("Loopback synthetic database required");
type Pool = ReturnType<typeof createPostgresPool>;
const poolFor = (url: string): Pool =>
  createPostgresPool(parsePostgresConfig({ DATABASE_URL: url }));
const admin = poolFor(target);
const guard = await import(
  new URL("../../../scripts/disposable-test-target.mjs", import.meta.url).href
);

/** Synthetic operator credential for this disposable server only. */
const operatorCredential = `synthetic-operator-${randomBytes(16).toString("hex")}`;

describe("operator failures stay request failures on the real server", () => {
  const suffix = randomBytes(6).toString("hex"),
    database = `operator_boundary_${suffix}_synthetic_test`,
    role = `operator_boundary_${suffix}`;
  let setup: Pool | undefined,
    app: Pool | undefined,
    server: Server | undefined,
    base = "",
    createdDB = false,
    createdRole = false;
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);

  const operator = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${operatorCredential}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const signIn = async (handle: string) => {
    const response = await fetch(`${base}/v1/development/sign-in`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle }),
    });
    return developmentSessionSchema.parse(await response.json());
  };
  const withSession = (
    token: string,
    method: string,
    path: string,
    body?: unknown,
  ) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const stillServing = async (token: string) => {
    expect(server?.listening).toBe(true);
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/v1/community/threads`)).status).toBe(200);
    expect(
      (await withSession(token, "GET", "/v1/community/messages?pageSize=20"))
        .status,
    ).toBe(200);
  };
  const raising = async (table: string, when: string, event: string) => {
    const name = `operator_boundary_fail_${table}`;
    await setup!.query(`
      CREATE FUNCTION community.${name}() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected unexpected failure'; END $$;
      GRANT EXECUTE ON FUNCTION community.${name}() TO "${role}";
      CREATE TRIGGER ${name} BEFORE ${event} ON community.${table}
        FOR EACH ROW ${when} EXECUTE FUNCTION community.${name}();`);
    return async () =>
      setup!.query(`
        DROP TRIGGER ${name} ON community.${table};
        DROP FUNCTION community.${name}();`);
  };

  beforeAll(async () => {
    process.on("unhandledRejection", onRejection);
    const probe = await admin.query(guard.disposableTestTargetProbeSql);
    guard.assertDisposableTestTarget(
      probe.rows,
      decodeURI(new URL(target).pathname.slice(1)),
    );
    const password = randomBytes(32).toString("hex");
    await admin.query(
      `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`,
    );
    createdRole = true;
    await admin.query(`CREATE DATABASE ${database}`);
    createdDB = true;
    const url = new URL(target);
    url.pathname = `/${database}`;
    setup = poolFor(url.toString());
    await runCommunityMigrations(
      setup,
      `${root}/database/community-migrations`,
    );
    // parallel-community-integration-qa: grant-runtime.sql also names C's
    // published-only public.article_entries (the notification Article bridge);
    // Development creates it with the Payload migration
    // 20260922_015000_editorial_content_views before the runtime grants, so it is
    // stood in here like the Catalog views.
    await setup.query(
      "CREATE TABLE public.catalog_entries(catalog_id text PRIMARY KEY,province text,province_state text); CREATE TABLE public.catalog_discovery(catalog_id text PRIMARY KEY,kind text,title text,aliases varchar[],first_published_at timestamptz,filter_metadata jsonb); CREATE TABLE public.catalog_media(catalog_id text,media_id text,object_key text,width integer,height integer,is_representative boolean); CREATE TABLE public.article_entries(article_id text PRIMARY KEY,title text)",
    );
    await setup.query(
      (
        await readFile(
          `${root}/infra/development/work-publishing/grant-runtime.sql`,
          "utf8",
        )
      ).replaceAll(':"app_role"', `"${role}"`),
    );
    await setup.query(
      await readFile(
        `${root}/infra/development/community-development-accounts.sql`,
        "utf8",
      ),
    );
    url.username = role;
    url.password = password;
    app = poolFor(url.toString());
    server = createBackendServer(
      createBackendApplication({
        nodeEnv: "development",
        communityIdentityPort: new PostgresCommunityIdentityAdapter(app),
        communityCommentPort: new PostgresCommunityCommentAdapter(app),
        authorCommunityPort: new PostgresAuthorCommunityAdapter(app),
        directMessagePort: new PostgresDirectMessageAdapter(app),
        threadPort: new PostgresThreadAdapter(app),
        communityOperatorCredential: operatorCredential,
        catalogQueryPort: createDevelopmentCatalogFixtureQueryPort(),
        storageUrlResolver: new UnconfiguredStorageUrlResolver(),
      }),
    );
    const address = await startServer(server, { host: "127.0.0.1", port: 0 });
    base = `http://${address.address}:${address.port}`;
  }, 60_000);

  afterAll(async () => {
    process.off("unhandledRejection", onRejection);
    try {
      // A server that failed to answer (a negative control) must not keep the
      // teardown waiting on its open connections.
      server?.closeAllConnections();
      if (server) await stopServer(server);
      await app?.end();
      await setup?.end();
    } finally {
      try {
        if (createdDB) await admin.query(`DROP DATABASE ${database}`);
      } finally {
        try {
          if (createdRole) await admin.query(`DROP ROLE ${role}`);
        } finally {
          await admin.end();
        }
      }
    }
  });

  it("answers an unexpected direct-message removal failure with a bounded 500, keeps serving, and leaves no partial writes", async () => {
    const one = await signIn("dev-user-01"),
      two = await signIn("dev-user-02");
    const body = `运营失败时不得泄露的正文 ${randomUUID()}`;
    const sendRequest = randomUUID();
    const sent = await withSession(
      one.token,
      "POST",
      "/v1/community/messages",
      {
        requestId: sendRequest,
        recipientId: two.profile.id,
        text: body,
      },
    );
    expect(sent.status).toBe(201);
    const message = (await sent.json()) as {
      id: string;
      conversationId: string;
    };

    // A valid operator request succeeds first.
    const found = await operator(
      "POST",
      "/internal/community/messages/lookup",
      {
        userIds: [one.profile.id, two.profile.id],
        purpose: "验收：运营失败边界",
      },
    );
    expect(found.status).toBe(200);

    const restore = await raising(
      "dm_moderation_events",
      "WHEN (NEW.action = 'remove_message')",
      "INSERT",
    );
    const operatorRequest = randomUUID();
    let failed: Response;
    try {
      failed = await operator(
        "POST",
        `/internal/community/messages/${message.id}/remove`,
        { requestId: operatorRequest, purpose: "验收：运营失败边界" },
      );
    } finally {
      await restore();
    }
    expect(failed.status).toBe(500);
    const text = await failed.text();
    expect(JSON.parse(text)).toEqual({
      error: { status: 500, code: "INTERNAL_ERROR" },
    });
    expect(text).not.toContain("injected");
    expect(text).not.toContain(body);

    await stillServing(two.token);
    // The failed transaction left nothing behind.
    const row = (
      await setup!.query<{ removed_at: Date | null }>(
        "SELECT removed_at FROM community.dm_messages WHERE id=$1",
        [message.id],
      )
    ).rows[0]!;
    expect(row.removed_at).toBeNull();
    const receipt = (
      await setup!.query<{ result: { text: string | null; removed: boolean } }>(
        "SELECT result FROM community.dm_command_receipts WHERE actor_id=$1 AND request_id=$2",
        [one.profile.id, sendRequest],
      )
    ).rows[0]!.result;
    expect(receipt).toMatchObject({ text: body, removed: false });
    expect(
      (
        await setup!.query(
          "SELECT 1 FROM community.dm_moderation_events WHERE message_id=$1 AND action='remove_message'",
          [message.id],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await setup!.query(
          "SELECT 1 FROM community.content_operator_receipts WHERE request_id=$1",
          [operatorRequest],
        )
      ).rowCount,
    ).toBe(0);
    const history = await withSession(
      two.token,
      "GET",
      `/v1/community/messages/${message.conversationId}?pageSize=30`,
    );
    expect(JSON.stringify(await history.json())).toContain(body);

    // The same path works once the cause is gone.
    const removed = await operator(
      "POST",
      `/internal/community/messages/${message.id}/remove`,
      { requestId: randomUUID(), purpose: "验收：运营失败边界" },
    );
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ removed: true, text: null });
    expect(rejections).toEqual([]);
  });

  it("answers an unexpected Thread operator failure with a bounded 500 and keeps serving", async () => {
    const one = await signIn("dev-user-03");
    const created = await operator("POST", "/internal/community/threads", {
      requestId: randomUUID(),
      title: "运营失败边界话题",
    });
    expect(created.status).toBe(200);
    const thread = (await created.json()) as { id: string; version: number };
    const restore = await raising("threads", "", "UPDATE");
    let failed: Response;
    try {
      failed = await operator(
        "POST",
        `/internal/community/threads/${thread.id}`,
        {
          requestId: randomUUID(),
          expectedVersion: thread.version,
          title: "不应写入的标题",
        },
      );
    } finally {
      await restore();
    }
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({
      error: { status: 500, code: "INTERNAL_ERROR" },
    });
    await stillServing(one.token);
    const title = (
      await setup!.query<{ title: string }>(
        "SELECT title FROM community.threads WHERE id=$1",
        [thread.id],
      )
    ).rows[0]!.title;
    expect(title).toBe("运营失败边界话题");
    expect(rejections).toEqual([]);
  });

  it("refuses a malformed path segment as a client error instead of failing the server", async () => {
    const one = await signIn("dev-user-01");
    const malformed = "%E0%A4%A";
    const dmRemove = await operator(
      "POST",
      `/internal/community/messages/${malformed}/remove`,
      { requestId: randomUUID(), purpose: "验收：畸形路径" },
    );
    expect(dmRemove.status).toBe(404);
    const threadEdit = await operator(
      "POST",
      `/internal/community/threads/${malformed}`,
      { requestId: randomUUID(), expectedVersion: 1, title: "x" },
    );
    expect(threadEdit.status).toBe(404);
    const publicRead = await withSession(
      one.token,
      "GET",
      `/v1/community/messages/${malformed}?pageSize=30`,
    );
    expect(publicRead.status).toBe(404);
    // A malformed participant is refused, not looked up as a stranger.
    const pairLookup = await withSession(
      one.token,
      "GET",
      `/v1/community/messages/with/${malformed}`,
    );
    expect(pairLookup.status).toBe(400);
    const threadRead = await fetch(`${base}/v1/community/threads/${malformed}`);
    expect(threadRead.status).toBe(404);
    await stillServing(one.token);
    expect(rejections).toEqual([]);
  });

  it("answers a request target that is not a URL path with 400 and keeps serving", async () => {
    const one = await signIn("dev-user-01");
    const { hostname, port } = new URL(base);
    // Raw bytes: fetch would normalize the target before sending it.
    const statusLine = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(port), hostname, () =>
        socket.write(
          "GET //[ HTTP/1.1\r\nHost: backend.invalid\r\nConnection: close\r\n\r\n",
        ),
      );
      let received = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => (received += chunk));
      socket.on("end", () => resolve(received.split("\r\n")[0] ?? ""));
      socket.on("error", reject);
    });
    expect(statusLine).toBe("HTTP/1.1 400 Bad Request");
    await stillServing(one.token);
    expect(rejections).toEqual([]);
  });
});
