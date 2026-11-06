import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
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
  PostgresAiOperatorReader,
  PostgresArticleAuthoringAdapter,
  PostgresAuthorCommunityAdapter,
  PostgresCommunityCommentAdapter,
  PostgresCommunityContentOperatorAdapter,
  PostgresCommunityIdentityAdapter,
  PostgresCommunityReportingAdapter,
  PostgresDirectMessageAdapter,
  PostgresFeedbackAdapter,
  PostgresPublishingOperatorAdapter,
  PostgresThreadAdapter,
  runCommunityMigrations,
} from "@moya/community-postgres";
import {
  ADMIN_MCP_TEXT_CAP_BYTES,
  adminMcpEnvelopeSchema,
} from "@moya/contracts/internal/admin-mcp";
import { UnconfiguredStorageUrlResolver } from "@moya/image";
import { sql, type PostgresAdapter } from "@payloadcms/db-postgres";
import { getPayload, type Payload, type TypedUser } from "payload";
import { expect, vi } from "vitest";

import { connectClient, serveRoutes } from "./admin-mcp-wire.js";

// What the run engine's suites share (admin-mcp-completion-v1 S8): the real Admin
// behind a real socket with the official client, and the real Backend on a disposable
// community database of its own, as the App role, so a preview's stamps and a run's
// writes go the whole way. Each suite seeds what it touches and removes the runs its
// keys made, so it passes alone on an empty server and on a used one.

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Pool = ReturnType<typeof createPostgresPool>;

const root = fileURLToPath(new URL("../../", import.meta.url));
const poolFor = (url: string): Pool =>
  createPostgresPool(parsePostgresConfig({ DATABASE_URL: url }));
const syntheticToken = () => randomBytes(32).toString("base64url");

export const opaque = (prefix: string) =>
  `${prefix}-${randomUUID().replaceAll("-", "")}`;

export interface RunsHarness {
  readonly run: string;
  readonly payload: Payload;
  readonly owner: TypedUser;
  readonly clients: Readonly<Record<"read" | "operate" | "full", Client>>;
  readonly keyIds: Readonly<Record<"read" | "operate" | "full", number>>;
  readonly backendOrigin: string;
  readonly ownerToken: string;
  readonly contactCanary: string;
  /** The community database, as its owner: for seeding and reading back. */
  readonly setup: Pool;
  readonly reporting: PostgresCommunityReportingAdapter;
  /** The CMS database, as the Admin's own pool sees it. */
  readonly cms: (query: ReturnType<typeof sql>) => Promise<Json[]>;
  /** Every Backend credential in place, the Owner's never. */
  readonly stubEnv: () => void;
  readonly stop: () => Promise<void>;
}

/** One tool call, checked as every suite checks one: within the cap, isError true to ok. */
export const callTool = async (
  client: Client,
  name: string,
  args: Json,
): Promise<{ envelope: Json; text: string }> => {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { text: string }[])[0]!.text;
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(ADMIN_MCP_TEXT_CAP_BYTES);
  const envelope = adminMcpEnvelopeSchema.parse(result.structuredContent);
  expect(JSON.parse(text)).toEqual(envelope);
  expect(result.isError === true).toBe(!envelope.ok);
  return { envelope: envelope as Json, text };
};

export const startRunsHarness = async (name: string): Promise<RunsHarness> => {
  const target = process.env.CMS_TEST_DATABASE_URL!;
  const guard = await import(
    new URL("../../scripts/disposable-test-target.mjs", import.meta.url).href
  );
  const run = randomBytes(6).toString("hex");
  const database = `${name}_${run}_synthetic_test`;
  const role = `${name}_${run}`;
  const admin = poolFor(target);
  const ownerToken = syntheticToken();
  const communityToken = syntheticToken();
  const baseToken = syntheticToken();
  let setup: Pool | undefined;
  let app: Pool | undefined;
  let backend: Server | undefined;
  let createdDatabase = false;
  let createdRole = false;
  let payload: Payload | undefined;
  let routes: Awaited<ReturnType<typeof serveRoutes>> | undefined;
  const clients: Partial<Record<"read" | "operate" | "full", Client>> = {};
  const keyIds: Partial<Record<"read" | "operate" | "full", number>> = {};

  const stop = async () => {
    for (const client of Object.values(clients)) await client.close();
    await routes?.close();
    if (payload !== undefined && Object.keys(keyIds).length > 0) {
      const credentials = Object.values(keyIds).map((id) => `key:${id}`);
      const { drizzle } = payload.db as unknown as PostgresAdapter;
      // As the tables' owner: the runtime role may never delete a run.
      await drizzle.execute(sql`
        DELETE FROM mcp_run_targets WHERE run_id IN (
          SELECT run_id FROM mcp_runs WHERE credential IN (SELECT jsonb_array_elements_text(${JSON.stringify(credentials)}::jsonb)))`);
      await drizzle.execute(sql`
        DELETE FROM mcp_runs WHERE credential IN (SELECT jsonb_array_elements_text(${JSON.stringify(credentials)}::jsonb))`);
    }
    await payload?.db?.destroy?.();
    backend?.closeAllConnections();
    if (backend) await stopServer(backend);
    await app?.end();
    await setup?.end();
    try {
      if (createdDatabase) await admin.query(`DROP DATABASE ${database}`);
    } finally {
      try {
        if (createdRole) await admin.query(`DROP ROLE ${role}`);
      } finally {
        await admin.end();
      }
    }
  };

  try {
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
    createdDatabase = true;
    const url = new URL(target);
    url.pathname = `/${database}`;
    setup = poolFor(url.toString());
    await runCommunityMigrations(
      setup,
      `${root}/database/community-migrations`,
    );
    await setup.query(
      "CREATE TABLE public.catalog_entries(catalog_id text PRIMARY KEY,province text,province_state text); CREATE TABLE public.catalog_discovery(catalog_id text PRIMARY KEY,kind text,title text,aliases varchar[],first_published_at timestamptz,filter_metadata jsonb); CREATE TABLE public.catalog_media(catalog_id text,media_id text,object_key text,width integer,height integer,is_representative boolean,position integer NOT NULL DEFAULT 0); CREATE TABLE public.article_entries(article_id text PRIMARY KEY,title text)",
    );
    await setup.query(
      (
        await readFile(
          `${root}/infra/development/work-publishing/grant-runtime.sql`,
          "utf8",
        )
      ).replaceAll(':"app_role"', `"${role}"`),
    );
    url.username = role;
    url.password = password;
    app = poolFor(url.toString());
    const pool = app;
    backend = createBackendServer(
      createBackendApplication({
        nodeEnv: "development",
        communityIdentityPort: new PostgresCommunityIdentityAdapter(pool),
        communityCommentPort: new PostgresCommunityCommentAdapter(pool),
        discussionPort: new PostgresCommunityCommentAdapter(pool),
        authorCommunityPort: new PostgresAuthorCommunityAdapter(pool),
        contentOperatorPort: new PostgresCommunityContentOperatorAdapter(pool),
        reportingPort: new PostgresCommunityReportingAdapter(pool),
        publishingOperatorPort: new PostgresPublishingOperatorAdapter(pool),
        articlePublicationOperatorPort: new PostgresArticleAuthoringAdapter(
          pool,
        ),
        threadPort: new PostgresThreadAdapter(pool),
        feedbackPort: new PostgresFeedbackAdapter(pool),
        directMessagePort: new PostgresDirectMessageAdapter(pool),
        aiOperatorReader: new PostgresAiOperatorReader(pool),
        communityOperatorCredential: ownerToken,
        operatorAiBaseCredential: baseToken,
        operatorAiCommunityCredential: communityToken,
        catalogQueryPort: createDevelopmentCatalogFixtureQueryPort(),
        storageUrlResolver: new UnconfiguredStorageUrlResolver(),
      }),
    );
    const address = await startServer(backend, {
      host: "127.0.0.1",
      port: 0,
    });
    const backendOrigin = `http://127.0.0.1:${address.port}/`;
    const stubEnv = () => {
      vi.stubEnv("COMMUNITY_OPERATOR_BASE_URL", backendOrigin);
      vi.stubEnv("COMMUNITY_OPERATOR_AI_TOKEN", communityToken);
      vi.stubEnv("OPERATOR_AI_BASE_TOKEN", baseToken);
      // Never the Owner's: an AI write that fell back to it would be labelled owner.
      vi.stubEnv("COMMUNITY_OPERATOR_TOKEN", "");
    };
    stubEnv();

    const config = await (await import("admin/config")).default;
    payload = await getPayload({ config });
    routes = await serveRoutes(config);
    const account = (email: string, role: "owner" | "automation") =>
      payload!.create({
        collection: "users",
        overrideAccess: true,
        data: {
          email: `${name}-${email}-${run}@example.invalid`,
          password: randomBytes(24).toString("hex"),
          role,
          scopeCatalogIds: [],
        } as never,
      });
    const owner = (await account("owner", "owner")) as unknown as TypedUser;
    const created = await account("ai", "automation");
    const aiOperator = await payload.update({
      collection: "users",
      id: created.id,
      overrideAccess: true,
      data: { role: "ai_operator" },
    });
    for (const profile of ["read", "operate", "full"] as const) {
      const secret = randomBytes(32).toString("hex");
      const key = await payload.create({
        collection: "payload-mcp-api-keys",
        overrideAccess: true,
        data: {
          user: aiOperator.id,
          label: `${name}-${profile}-${run}`,
          enableAPIKey: true,
          apiKey: secret,
          toolProfile: profile,
        } as never,
      });
      keyIds[profile] = key.id as number;
      clients[profile] = (
        await connectClient(routes.endpoint, {
          authorization: `Bearer ${secret}`,
        })
      ).client;
    }
    const { drizzle } = payload.db as unknown as PostgresAdapter;
    return {
      run,
      payload,
      owner,
      clients: clients as RunsHarness["clients"],
      keyIds: keyIds as RunsHarness["keyIds"],
      backendOrigin,
      ownerToken,
      contactCanary: `contactcanary${run}`,
      setup,
      reporting: new PostgresCommunityReportingAdapter(setup),
      cms: async (query) => (await drizzle.execute(query)).rows as Json[],
      stubEnv,
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
};

/** Community rows a suite seeds, through the owner of its database. */
export const communitySeeds = (harness: RunsHarness) => {
  const { setup, run, reporting } = harness;
  let sequence = 0;
  const newUser = async () => {
    sequence += 1;
    const id = opaque("user");
    await setup.query(
      "INSERT INTO community.public_users(id,handle,display_name,bio) VALUES($1,$2,$3,'')",
      [id, `runs-${sequence}-${run}`, `Synthetic ${sequence}`],
    );
    return id;
  };
  const newWork = async (authorId: string) => {
    const id = opaque("work");
    await setup.query(
      "INSERT INTO community.works(id,author_id,title,text,first_published_at) VALUES($1,$2,$3,'Synthetic text',CURRENT_TIMESTAMP)",
      [id, authorId, `Work ${run}`],
    );
    return id;
  };
  const newComment = async (workId: string, authorId: string) => {
    const id = opaque("comment");
    await setup.query(
      "INSERT INTO community.catalog_comments(id,catalog_id,target_type,author_id,text,moderation) VALUES($1,$2,'work',$3,$4,'visible')",
      [id, workId, authorId, `Comment ${run}`],
    );
    return id;
  };
  const makeSelfOnly = (workId: string) =>
    setup.query("UPDATE community.works SET visibility='self' WHERE id=$1", [
      workId,
    ]);
  const newRightsNotice = async (workId: string, reporter: string) =>
    (
      await reporting.create(reporter, {
        kind: "rights_notice",
        target: { type: "work", id: workId },
        reason: "copyright",
        description: `Notice ${run}`,
        claimantName: "Synthetic claimant",
        contact: harness.contactCanary,
        rightsBasis: "Synthetic basis",
        requestId: randomUUID(),
      })
    ).id;
  const versionOfReport = async (id: string) =>
    Number(
      (
        await setup.query(
          "SELECT version FROM community.report_cases WHERE id=$1",
          [id],
        )
      ).rows[0].version,
    );
  return {
    newUser,
    newWork,
    newComment,
    makeSelfOnly,
    newRightsNotice,
    versionOfReport,
  };
};
