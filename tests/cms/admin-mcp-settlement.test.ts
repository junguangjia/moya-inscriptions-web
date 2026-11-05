/**
 * admin-mcp-completion-v1 S7: whether the media work an op queued has finished. Real
 * JSON-RPC over HTTP with the official client, through the real door and guard, to the
 * real Backend on a disposable community database of its own, as the App role, with the
 * jobs moved through the real job port. What it holds to is the Matrix's row: the state
 * commits, the answer is QUEUED while a publish or withdraw job is open, `ok:true` when
 * none is, MEDIA_JOB_FAILED once one has stopped. A source that does not answer is never
 * a miss. The suite seeds all it reads, so it passes alone on an empty server and on a
 * used one.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
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
  PostgresCommunityCommentAdapter,
  PostgresCommunityContentOperatorAdapter,
  PostgresCommunityIdentityAdapter,
  PostgresCommunityReportingAdapter,
  PostgresPublishingOperatorAdapter,
  PostgresThreadAdapter,
  PostgresWorkPublishingAdapter,
  runCommunityMigrations,
} from "@moya/community-postgres";
import {
  ADMIN_JOB_MAX_REFS,
  ADMIN_MCP_TEXT_CAP_BYTES,
  adminJobDataSchema,
  adminMcpEnvelopeSchema,
} from "@moya/contracts/internal/admin-mcp";
import { emptyArticleDocument } from "@moya/contracts/schemas";
import { UnconfiguredStorageUrlResolver } from "@moya/image";
import { getPayload, type Payload } from "payload";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { connectClient, serveRoutes } from "./admin-mcp-wire.js";

if (process.env.CMS_ENVIRONMENT !== "synthetic")
  throw new Error("SYNTHETIC_CMS_TARGET_REQUIRED");

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const root = fileURLToPath(new URL("../../", import.meta.url));
const guard = await import(
  new URL("../../scripts/disposable-test-target.mjs", import.meta.url).href
);
const target = process.env.CMS_TEST_DATABASE_URL!;
type Pool = ReturnType<typeof createPostgresPool>;
const poolFor = (url: string): Pool =>
  createPostgresPool(parsePostgresConfig({ DATABASE_URL: url }));

const run = randomBytes(6).toString("hex");
const database = `settlement_${run}_synthetic_test`;
const role = `settlement_${run}`;
const admin = poolFor(target);
let setup: Pool;
let app: Pool;
let createdDatabase = false;
let createdRole = false;

const syntheticToken = () => randomBytes(32).toString("base64url");
const ownerToken = syntheticToken();
const communityToken = syntheticToken();
const baseToken = syntheticToken();
const hex = () => randomUUID().replaceAll("-", "");
const opaque = (prefix: string) => `${prefix}-${hex()}`;
const sha = () => randomBytes(32).toString("hex");
const REASON = "Synthetic reason";
const SETTLEMENT = "/internal/community/ai/settlement";

let payload: Payload;
let routes: Awaited<ReturnType<typeof serveRoutes>>;
let backend: Server;
let backendOrigin = "";
let client: Client;
let readClient: Client;
let reporting: PostgresCommunityReportingAdapter;
let worker: PostgresWorkPublishingAdapter;
/** What the official record's own read finds: present, or taken down natively. */
let officialRecord: { canonicalPath: string; snapshot: Json } | null = null;

/** The two gates publishing asks, shut unless a test opens them. */
const gates = { open: false };
const publication = {
  isPublic: () => gates.open,
  allowPublish: () => gates.open,
};

const send = async (with_: Client, name: string, args: Json) => {
  const result = await with_.callTool({ name, arguments: args });
  const text = (result.content as { text: string }[])[0]!.text;
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(ADMIN_MCP_TEXT_CAP_BYTES);
  const envelope = adminMcpEnvelopeSchema.parse(result.structuredContent);
  expect(JSON.parse(text)).toEqual(envelope);
  expect(result.isError === true).toBe(!envelope.ok);
  return envelope as Json;
};
const execute = (op: string, input: Json, requestId: string = randomUUID()) =>
  send(client, "admin_execute", { requestId, op, input });
const executeAll = (
  op: string,
  input: Json,
  targets: readonly Json[],
  requestId: string = randomUUID(),
) => send(client, "admin_execute", { requestId, op, input, targets });
const job = async (refs: readonly Json[], from: Client = client) => {
  const envelope = await send(from, "admin_job", { kind: "settlement", refs });
  adminJobDataSchema.parse(envelope.data);
  return envelope;
};
/** Follows a `next` exactly as it reads: the client is told nothing more. */
const follow = ({ next }: Json) => {
  expect(next.tool).toBe("admin_job");
  return send(client, next.tool as string, next.args as Json);
};

const one = async <Row extends Json = Json>(
  statement: string,
  values: readonly unknown[] = [],
): Promise<Row> =>
  (await setup.query<Row>(statement, [...values])).rows[0] as Row;
const rows = async <Row extends Json = Json>(
  statement: string,
  values: readonly unknown[] = [],
): Promise<Row[]> => (await setup.query<Row>(statement, [...values])).rows;

const owner = async (method: string, route: string, body?: unknown) => {
  const response = await fetch(`${backendOrigin}internal/community/${route}`, {
    method,
    headers: {
      authorization: `Bearer ${ownerToken}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as Json };
};

/** A stand-in for the Backend, for what the real one cannot be made to answer. */
const withStandIn = async <T>(
  answer: (request: IncomingMessage, response: ServerResponse) => void,
  attempt: () => Promise<T>,
): Promise<T> => {
  const stub = createServer(answer);
  await new Promise<void>((resolve) =>
    stub.listen(0, "127.0.0.1", () => resolve()),
  );
  try {
    vi.stubEnv(
      "COMMUNITY_OPERATOR_BASE_URL",
      `http://127.0.0.1:${(stub.address() as AddressInfo).port}/`,
    );
    return await attempt();
  } finally {
    vi.stubEnv("COMMUNITY_OPERATOR_BASE_URL", backendOrigin);
    stub.closeAllConnections();
    await new Promise((resolve) => stub.close(resolve));
  }
};

/** The real Backend, but for what `answer` takes: settlement that does not answer. */
const withBackendFailing = async <T>(
  fails: (url: string, method: string) => boolean,
  attempt: () => Promise<T>,
): Promise<T> =>
  withStandIn((incoming, outgoing) => {
    void (async () => {
      if (fails(incoming.url ?? "", incoming.method ?? "GET")) {
        outgoing.writeHead(503, { "content-type": "application/json" });
        outgoing.end(
          JSON.stringify({
            error: { status: 503, code: "STORE_UNAVAILABLE" },
          }),
        );
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(chunk as Buffer);
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers))
        if (typeof value === "string" && name !== "host")
          headers.set(name, value);
      const upstream = await fetch(
        new URL((incoming.url ?? "/").slice(1), backendOrigin),
        {
          method: incoming.method ?? "GET",
          headers,
          ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }),
        },
      );
      outgoing.writeHead(upstream.status, {
        "content-type": "application/json",
      });
      outgoing.end(await upstream.text());
    })().catch(() => outgoing.destroy());
  }, attempt);

let sequence = 0;
const newUser = async () => {
  sequence += 1;
  const id = opaque("user");
  await setup.query(
    "INSERT INTO community.public_users(id,handle,display_name,bio) VALUES($1,$2,$3,'')",
    [id, `settling-${sequence}-${run}`, `Synthetic ${sequence}`],
  );
  return id;
};
const newItem = async (ownerId: string) => {
  const item = opaque("media-item");
  await setup.query(
    "INSERT INTO community.media_items(id,owner_id,kind,quality_mode,source,state,presentation,ready_at) VALUES($1,$2,'static','standard','upload','ready','{\"width\":512,\"height\":384}',CURRENT_TIMESTAMP)",
    [item, ownerId],
  );
  return item;
};
/** The asset row a job's operation fences, on an item with one rendition ready. */
const publicCopyOf = async (item: string, ownerId: string, asset: string) => {
  const blob = opaque("media-blob");
  const rendition = opaque("media-rendition");
  const key = hex();
  const storageKey = `blobs/${key.slice(0, 2)}/${key.slice(2, 4)}/${key}`;
  const hash = sha();
  const token = hex();
  await setup.query(
    "INSERT INTO community.media_blobs(id,owner_id,purpose,storage_key,byte_size,sha256,content_type,created_at) VALUES($1,$2,'derivative',$3,128,$4,'image/webp',CURRENT_TIMESTAMP)",
    [blob, ownerId, storageKey, hash],
  );
  await setup.query(
    "INSERT INTO community.media_renditions(id,item_id,edit_key,role,recipe_version,recipe_digest,blob_id,width,height,content_type,created_at) VALUES($1,$2,'base','display',1,'1111111111111111',$3,512,384,'image/webp',CURRENT_TIMESTAMP)",
    [rendition, item, blob],
  );
  await setup.query(
    `INSERT INTO community.media_publications(id,public_asset_id,rendition_id,generation_token,object_key,storage_key,content_type,purpose,byte_size,sha256,role,edit_key,state,created_at,published_at)
     VALUES($1,$2,$3,$4,$5,$6,'image/webp','derivative',128,$7,'display','base','published',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    [
      opaque("media-publication"),
      asset,
      rendition,
      token,
      `v1/${asset}/${token}/base/display.r1.webp`,
      storageKey,
      hash,
    ],
  );
};
const newAsset = async (subject: { item?: string; asset?: string }) => {
  const asset = hex();
  await setup.query(
    "INSERT INTO community.media_public_assets(id,item_id,catalog_asset_id,desired_at,created_at,updated_at) VALUES($1,$2,$3,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
    [asset, subject.item ?? null, subject.asset ?? null],
  );
  return asset;
};
/** A copy on the public store: what makes moving the item queue a withdrawal. */
const publishCopy = async (item: string, ownerId: string) =>
  publicCopyOf(item, ownerId, await newAsset({ item }));
const newRevision = async (
  work: string,
  authorId: string,
  item: string,
  sequenceNumber: number,
  disposition: string,
) => {
  const id = opaque("work-revision");
  await setup.query(
    `INSERT INTO community.work_revisions(id,work_id,author_id,sequence,origin,title,body,authorship_kind,requested_visibility,cover_item_id,content_sha256,disposition,submitted_at)
     VALUES($1,$2,$3,$4,'submission','Settling','','original','public',$5,$6,$7,CURRENT_TIMESTAMP)`,
    [id, work, authorId, sequenceNumber, item, sha(), disposition],
  );
  await setup.query(
    `INSERT INTO community.work_revision_items(revision_id,position,item_id,edit) VALUES($1,1,$2,'{"rotation":0,"crop":null}')`,
    [id, item],
  );
  return id;
};
/** A public work whose one item has a copy on the public store. */
const publicWork = async (authorId?: string) => {
  const author = authorId ?? (await newUser());
  const item = await newItem(author);
  await publishCopy(item, author);
  const work = opaque("work");
  await setup.query(
    "INSERT INTO community.works(id,author_id,title,text,created_via,visibility,first_published_at) VALUES($1,$2,'Settling','','publishing','public',CURRENT_TIMESTAMP)",
    [work, author],
  );
  const revision = await newRevision(work, author, item, 1, "approved");
  await setup.query(
    "UPDATE community.works SET public_revision_id=$2,author_revision_id=$2,first_submitted_at=CURRENT_TIMESTAMP WHERE id=$1",
    [work, revision],
  );
  return { work, item, author, revision };
};
const makeSelfOnly = (work: string) =>
  setup.query("UPDATE community.works SET visibility='self' WHERE id=$1", [
    work,
  ]);
const versionOfWork = async (id: string) =>
  Number(
    (await one("SELECT version FROM community.works WHERE id=$1", [id]))
      .version,
  );
const versionOfReport = async (id: string) =>
  Number(
    (await one("SELECT version FROM community.report_cases WHERE id=$1", [id]))
      .version,
  );
/** The same command again: its version is the one the first call read. */
const hideInput = async (work: string) => ({
  id: work,
  state: "hidden",
  expectedVersion: await versionOfWork(work),
  reason: REASON,
});
const hide = async (work: string) =>
  execute("community.moderate-work", await hideInput(work));
const workRef = (id: string, intent = "withdraw") => ({
  type: "work",
  id,
  intent,
});

const jobsOf = (subject: string) =>
  rows<{ id: string; kind: string; state: string }>(
    "SELECT id,kind,state FROM community.publishing_jobs WHERE subject_id=$1 ORDER BY created_at,id",
    [subject],
  );
/** Claimed as the worker claims it, so the real port can finish it. */
const leased = async (subject: string, kind: string) => {
  const found = (await jobsOf(subject)).find(
    (row) =>
      row.kind === kind && (row.state === "queued" || row.state === "running"),
  );
  expect(found, `${kind} open on ${subject}`).toBeDefined();
  const leaseOwner = hex();
  await setup.query(
    "UPDATE community.publishing_jobs SET state='running',attempts=GREATEST(1,attempts),lease_owner=$2,lease_expires_at=CURRENT_TIMESTAMP+interval '1 hour' WHERE id=$1",
    [found!.id, leaseOwner],
  );
  return { id: found!.id, leaseOwner };
};
const succeed = async (subject: string, kind: string) => {
  const lease = await leased(subject, kind);
  expect(await worker.completeJob(lease, new Date())).toBe(true);
  return lease.id;
};
/** Finishes every job still open on a subject, of whatever kind. */
const succeedAll = async (subject: string) => {
  for (const { kind, state } of await jobsOf(subject))
    if (state === "queued" || state === "running") await succeed(subject, kind);
};
/** Stopped for good, as the last attempt does. */
const stop = async (subject: string, kind: string) => {
  const lease = await leased(subject, kind);
  expect(
    await worker.failJob(lease, "synthetic_failure", new Date(), {
      retryable: false,
    }),
  ).toBe("failed");
  return lease.id;
};
const enqueue = (subject: string, kind: string) =>
  worker.enqueueJob({ kind: kind as never, subjectId: subject }, new Date());

beforeAll(async () => {
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
  await runCommunityMigrations(setup, `${root}/database/community-migrations`);
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
  const resolveExternalTarget = async () => officialRecord as never;
  reporting = new PostgresCommunityReportingAdapter(setup, {
    resolveExternalTarget,
  });
  url.username = role;
  url.password = password;
  app = poolFor(url.toString());
  worker = new PostgresWorkPublishingAdapter(app, { publication });
  backend = createBackendServer(
    createBackendApplication({
      nodeEnv: "development",
      communityIdentityPort: new PostgresCommunityIdentityAdapter(app, {
        publication,
      }),
      communityCommentPort: new PostgresCommunityCommentAdapter(app),
      discussionPort: new PostgresCommunityCommentAdapter(app),
      contentOperatorPort: new PostgresCommunityContentOperatorAdapter(app, {
        publication,
      }),
      reportingPort: new PostgresCommunityReportingAdapter(app, {
        publication,
        resolveExternalTarget,
      }),
      publishingOperatorPort: new PostgresPublishingOperatorAdapter(app, {
        publication,
      }),
      articlePublicationOperatorPort: new PostgresArticleAuthoringAdapter(app, {
        publication,
      }),
      threadPort: new PostgresThreadAdapter(app),
      aiOperatorReader: new PostgresAiOperatorReader(app, publication),
      communityOperatorCredential: ownerToken,
      operatorAiBaseCredential: baseToken,
      operatorAiCommunityCredential: communityToken,
      catalogQueryPort: createDevelopmentCatalogFixtureQueryPort(),
      storageUrlResolver: new UnconfiguredStorageUrlResolver(),
    }),
  );
  const address = await startServer(backend, { host: "127.0.0.1", port: 0 });
  backendOrigin = `http://127.0.0.1:${address.port}/`;

  const config = await (await import("admin/config")).default;
  payload = await getPayload({ config });
  routes = await serveRoutes(config);
  const account = await payload.create({
    collection: "users",
    overrideAccess: true,
    data: {
      email: `settlement-${run}@example.invalid`,
      password: randomBytes(24).toString("hex"),
      role: "automation",
      scopeCatalogIds: [],
    },
  });
  const aiOperator = await payload.update({
    collection: "users",
    id: account.id,
    overrideAccess: true,
    data: { role: "ai_operator" },
  });
  const keyFor = async (toolProfile: string) => {
    const secret = randomBytes(32).toString("hex");
    await payload.create({
      collection: "payload-mcp-api-keys",
      overrideAccess: true,
      data: {
        user: aiOperator.id,
        label: `settlement-${toolProfile}-${run}`,
        enableAPIKey: true,
        apiKey: secret,
        toolProfile,
      } as never,
    });
    return secret;
  };
  client = (
    await connectClient(routes.endpoint, {
      authorization: `Bearer ${await keyFor("operate")}`,
    })
  ).client;
  readClient = (
    await connectClient(routes.endpoint, {
      authorization: `Bearer ${await keyFor("read")}`,
    })
  ).client;
}, 180_000);

beforeEach(() => {
  gates.open = false;
  officialRecord = null;
  vi.stubEnv("COMMUNITY_OPERATOR_BASE_URL", backendOrigin);
  vi.stubEnv("COMMUNITY_OPERATOR_AI_TOKEN", communityToken);
  vi.stubEnv("OPERATOR_AI_BASE_TOKEN", baseToken);
  // Never the Owner's: an AI read that fell back to it would pass unlabelled.
  vi.stubEnv("COMMUNITY_OPERATOR_TOKEN", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await client?.close();
  await readClient?.close();
  await routes?.close();
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
});

describe("hide a work with public media", () => {
  it("answers QUEUED while the withdraw job is open, and ok:true once it has finished", async () => {
    const { work, item } = await publicWork();
    const requestId = randomUUID();
    const input = await hideInput(work);
    const first = await execute("community.moderate-work", input, requestId);
    // The state committed, and the media has not left yet.
    expect(
      (
        await one("SELECT operator_state FROM community.works WHERE id=$1", [
          work,
        ])
      ).operator_state,
    ).toBe("hidden");
    expect(first).toMatchObject({
      ok: false,
      code: "QUEUED",
      state: "media_jobs_open",
      retryable: true,
      data: {
        queued: [{ index: 0, id: work, state: "media_jobs_open" }],
        moderationCases: 1,
      },
    });
    expect(first.data.applied).toBeUndefined();
    expect(first.data.results[0]).toMatchObject({ id: work, state: "hidden" });
    expect(first.next).toEqual({
      tool: "admin_job",
      args: { kind: "settlement", refs: [workRef(work)] },
      afterMs: 2_000,
    });
    expect((await jobsOf(item)).map(({ kind }) => kind)).toEqual([
      "withdraw_media",
    ]);

    const open = await follow(first);
    expect(open).toMatchObject({
      ok: false,
      code: "QUEUED",
      state: "media_jobs_open",
      data: { refs: [{ type: "work", id: work, state: "open", open: 1 }] },
    });
    expect(open.next).toEqual(first.next);

    // Running is still open.
    const lease = await leased(item, "withdraw_media");
    expect((await follow(first)).code).toBe("QUEUED");

    expect(await worker.completeJob(lease, new Date())).toBe(true);
    const done = await follow(first);
    expect(done).toMatchObject({
      ok: true,
      code: "OK",
      data: { refs: [{ type: "work", id: work, state: "settled" }] },
    });
    expect(done.next).toBeUndefined();

    // The same call now says the same, and repeats nothing.
    const replay = await execute("community.moderate-work", input, requestId);
    expect(replay).toMatchObject({
      ok: true,
      code: "OK",
      data: { already_applied: [work] },
      meta: { replayed: true },
    });
    expect(replay.data.moderationCases).toBeUndefined();
    expect(await jobsOf(item)).toHaveLength(1);
    expect(
      (
        await one(
          "SELECT count(*)::integer AS n FROM community.report_cases WHERE target_id=$1",
          [work],
        )
      ).n,
    ).toBe(1);
  });

  it("answers ok:true at once with no copy on the public store, since nothing queued", async () => {
    const author = await newUser();
    const item = await newItem(author);
    const work = opaque("work");
    await setup.query(
      "INSERT INTO community.works(id,author_id,title,text,created_via,visibility,first_published_at) VALUES($1,$2,'Settling','','publishing','public',CURRENT_TIMESTAMP)",
      [work, author],
    );
    const revision = await newRevision(work, author, item, 1, "approved");
    await setup.query(
      "UPDATE community.works SET public_revision_id=$2,author_revision_id=$2 WHERE id=$1",
      [work, revision],
    );
    expect(await hide(work)).toMatchObject({
      ok: true,
      code: "OK",
      data: { applied: [work], moderationCases: 1 },
    });
    expect(await jobsOf(item)).toEqual([]);
  });

  it("answers MEDIA_JOB_FAILED once the job has stopped, and names it", async () => {
    const { work, item } = await publicWork();
    const requestId = randomUUID();
    const input = await hideInput(work);
    const first = await execute("community.moderate-work", input, requestId);
    const failedJob = await stop(item, "withdraw_media");
    const read = await follow(first);
    expect(read).toMatchObject({
      ok: false,
      code: "MEDIA_JOB_FAILED",
      data: {
        refs: [
          {
            type: "work",
            id: work,
            state: "failed",
            failed: 1,
            jobs: [failedJob],
          },
        ],
      },
    });
    expect(read.retryable).toBeUndefined();
    expect(read.next).toBeUndefined();
    const replay = await execute("community.moderate-work", input, requestId);
    expect(replay).toMatchObject({
      ok: false,
      code: "MEDIA_JOB_FAILED",
      data: { failed: [{ index: 0, id: work, jobs: [failedJob] }] },
      meta: { replayed: true },
    });
    // The state stays committed: it is the media that did not leave.
    expect(
      (
        await one("SELECT operator_state FROM community.works WHERE id=$1", [
          work,
        ])
      ).operator_state,
    ).toBe("hidden");
  });

  it("reads an abandoned job as failed", async () => {
    const { work, item } = await publicWork();
    await hide(work);
    const [queued] = await jobsOf(item);
    const abandoned = await owner(
      "POST",
      `publishing/jobs/${queued!.id}/abandon`,
      { requestId: randomUUID() },
    );
    expect(abandoned.status).toBe(200);
    expect(await job([workRef(work)])).toMatchObject({
      code: "MEDIA_JOB_FAILED",
      data: { refs: [{ state: "failed", jobs: [queued!.id] }] },
    });
  });

  it("waits for a withdrawal's verification, which the withdrawal's success leaves open", async () => {
    const { work, item } = await publicWork();
    const first = await hide(work);
    await enqueue(item, "verify_withdrawal");
    await succeed(item, "withdraw_media");
    expect((await follow(first)).code).toBe("QUEUED");
    await succeed(item, "verify_withdrawal");
    expect((await follow(first)).code).toBe("OK");
  });

  it("waits for a publish job as well, which a hide also queues with the gates open", async () => {
    gates.open = true;
    const { work, item } = await publicWork();
    const first = await hide(work);
    expect((await jobsOf(item)).map(({ kind }) => kind).sort()).toEqual([
      "publish_media",
      "withdraw_media",
    ]);
    await succeed(item, "withdraw_media");
    expect(await follow(first)).toMatchObject({
      code: "QUEUED",
      data: { refs: [{ open: 1 }] },
    });
    await succeed(item, "publish_media");
    expect((await follow(first)).code).toBe("OK");
  });

  it("holds an open job above a stopped one: the worker may yet get past it", async () => {
    const { work, item } = await publicWork();
    const requestId = randomUUID();
    const input = await hideInput(work);
    const first = await execute("community.moderate-work", input, requestId);
    const failedJob = await stop(item, "withdraw_media");
    await enqueue(item, "withdraw_media");
    expect(await follow(first)).toMatchObject({
      code: "QUEUED",
      data: {
        refs: [{ state: "open", open: 1, failed: 1, jobs: [failedJob] }],
      },
    });
    expect(
      await execute("community.moderate-work", input, requestId),
    ).toMatchObject({ code: "QUEUED", state: "media_jobs_open" });
    // The worker's next pass went through: the stop no longer says anything.
    await succeed(item, "withdraw_media");
    expect((await follow(first)).code).toBe("OK");
    expect(await hide(work)).toMatchObject({ code: "OK" });
  });

  it("does not read a verification's success after a stopped withdrawal as failed", async () => {
    const { work, item } = await publicWork();
    const first = await hide(work);
    await stop(item, "withdraw_media");
    expect((await follow(first)).code).toBe("MEDIA_JOB_FAILED");
    await enqueue(item, "verify_withdrawal");
    await succeed(item, "verify_withdrawal");
    expect((await follow(first)).code).toBe("OK");
  });

  it("keeps a publish job's stop from being cleared by a withdrawal's success", async () => {
    gates.open = true;
    const { work, item } = await publicWork();
    const first = await hide(work);
    await stop(item, "publish_media");
    await succeed(item, "withdraw_media");
    expect((await follow(first)).code).toBe("MEDIA_JOB_FAILED");
  });

  it("reads only a stop newer than the operation", async () => {
    const { work, item } = await publicWork();
    const old = opaque("publishing-job");
    await setup.query(
      "INSERT INTO community.publishing_jobs(id,kind,subject_id,state,run_after,created_at,updated_at,finished_at) VALUES($1,'withdraw_media',$2,'failed',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP-interval '2 hours',CURRENT_TIMESTAMP-interval '2 hours',CURRENT_TIMESTAMP-interval '2 hours')",
      [old, item],
    );
    const first = await hide(work);
    expect(first.code).toBe("QUEUED");
    await succeed(item, "withdraw_media");
    expect((await follow(first)).code).toBe("OK");
  });

  it("reads an old stop as no part of this operation, with nothing queued to clear it", async () => {
    const author = await newUser();
    const item = await newItem(author);
    await newAsset({ item });
    const work = opaque("work");
    await setup.query(
      "INSERT INTO community.works(id,author_id,title,text,created_via,visibility,first_published_at) VALUES($1,$2,'Settling','','publishing','public',CURRENT_TIMESTAMP)",
      [work, author],
    );
    const revision = await newRevision(work, author, item, 1, "approved");
    await setup.query(
      "UPDATE community.works SET public_revision_id=$2,author_revision_id=$2 WHERE id=$1",
      [work, revision],
    );
    await setup.query(
      "INSERT INTO community.publishing_jobs(id,kind,subject_id,state,run_after,created_at,updated_at,finished_at) VALUES($1,'withdraw_media',$2,'failed',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP-interval '2 hours',CURRENT_TIMESTAMP-interval '2 hours',CURRENT_TIMESTAMP-interval '2 hours')",
      [opaque("publishing-job"), item],
    );
    expect(await hide(work)).toMatchObject({
      ok: true,
      data: { applied: [work] },
    });
  });

  it("reads as failed a job running through the operation whose clock runs behind it", async () => {
    const { work, item } = await publicWork();
    const lease = await (async () => {
      await enqueue(item, "withdraw_media");
      return leased(item, "withdraw_media");
    })();
    // The running job took the place of the one this operation would have queued.
    const first = await hide(work);
    expect(await jobsOf(item)).toHaveLength(1);
    expect(first.code).toBe("QUEUED");
    const { desired_at: desiredAt } = await one<{ desired_at: Date }>(
      "SELECT desired_at FROM community.media_public_assets WHERE item_id=$1",
      [item],
    );
    expect(
      await worker.failJob(
        lease,
        "synthetic_failure",
        new Date(desiredAt.getTime() - 1_000),
        { retryable: false },
      ),
    ).toBe("failed");
    expect((await follow(first)).code).toBe("MEDIA_JOB_FAILED");
  });
});

describe("the other operations that move media", () => {
  it("settles an approved submission on the item it publishes and the item it withdraws", async () => {
    gates.open = true;
    const { work, item: before, author } = await publicWork();
    const item = await newItem(author);
    const revision = await newRevision(work, author, item, 2, "pending");
    await setup.query(
      "UPDATE community.works SET author_revision_id=$2 WHERE id=$1",
      [work, revision],
    );
    const { version } = await one(
      "SELECT version FROM community.work_revisions WHERE id=$1",
      [revision],
    );
    const requestId = randomUUID();
    const input = {
      id: revision,
      action: "approve",
      expectedVersion: Number(version),
      reason: REASON,
    };
    const first = await execute(
      "community.moderate-work-submission",
      input,
      requestId,
    );
    expect(first).toMatchObject({
      code: "QUEUED",
      data: { queued: [{ id: revision, state: "media_jobs_open" }] },
    });
    // The command names the revision, and the media hangs on the work.
    expect(first.next.args.refs).toEqual([workRef(work, "publish")]);
    await succeed(item, "publish_media");
    // The old item's withdrawal is what is left: it is no longer in the public revision.
    expect((await jobsOf(before)).map(({ kind }) => kind)).toContain(
      "withdraw_media",
    );
    expect((await follow(first)).code).toBe("QUEUED");
    await succeedAll(before);
    expect((await follow(first)).code).toBe("OK");
    expect(
      await execute("community.moderate-work-submission", input, requestId),
    ).toMatchObject({
      ok: true,
      data: { already_applied: [revision] },
      meta: { replayed: true },
    });
  });

  it("settles a suspension on every item of the user", async () => {
    const { item: one_, author } = await publicWork();
    const { item: two } = await publicWork(author);
    const requestId = randomUUID();
    const input = { id: author, action: "suspend", reason: REASON };
    const first = await execute("community.moderate-user", input, requestId);
    expect(first).toMatchObject({ code: "QUEUED" });
    expect(first.next.args.refs).toEqual([
      { type: "user", id: author, intent: "withdraw" },
    ]);
    await succeed(one_, "withdraw_media");
    expect(await follow(first)).toMatchObject({
      code: "QUEUED",
      data: { refs: [{ open: 1 }] },
    });
    await succeed(two, "withdraw_media");
    expect((await follow(first)).code).toBe("OK");

    // The state is already there, so this is the first call's own answer again.
    expect(
      await execute("community.moderate-user", input, requestId),
    ).toMatchObject({ ok: true, data: { already_applied: [author] } });
  });

  it("settles a decision on what it acts on, and a decision that moves nothing at once", async () => {
    const { work, item, author } = await publicWork();
    const report = (
      await reporting.create(await newUser(), {
        kind: "standard",
        target: { type: "work", id: work },
        reason: "other",
        description: "Synthetic",
        requestId: randomUUID(),
      })
    ).id;
    const input = {
      id: report,
      expectedVersion: await versionOfReport(report),
      action: "hide",
      reason: REASON,
    };
    const requestId = randomUUID();
    const first = await execute("community.decide-report", input, requestId);
    expect(first).toMatchObject({
      code: "QUEUED",
      data: { queued: [{ id: report }] },
    });
    expect(first.next.args.refs).toEqual([workRef(work)]);
    expect(first.data.results[0]).toMatchObject({
      target: { type: "work", id: work },
      affectedUserId: author,
    });
    await succeed(item, "withdraw_media");
    // The case's version has moved, and the record shows this decision.
    expect(
      await execute("community.decide-report", input, requestId),
    ).toMatchObject({ ok: true, data: { already_applied: [report] } });

    const retained = (
      await reporting.create(await newUser(), {
        kind: "standard",
        target: { type: "work", id: (await publicWork()).work },
        reason: "other",
        description: "Synthetic",
        requestId: randomUUID(),
      })
    ).id;
    await withBackendFailing(
      (url) => url.startsWith(SETTLEMENT),
      async () =>
        expect(
          await execute("community.decide-report", {
            id: retained,
            expectedVersion: await versionOfReport(retained),
            action: "retain",
            reason: REASON,
          }),
        ).toMatchObject({ ok: true, data: { applied: [retained] } }),
    );
  });

  it("settles a suspension by decision on the affected user, and its overturn the way back", async () => {
    gates.open = true;
    const { work, item, author } = await publicWork();
    const report = (
      await reporting.create(await newUser(), {
        kind: "standard",
        target: { type: "work", id: work },
        reason: "other",
        description: "Synthetic",
        requestId: randomUUID(),
      })
    ).id;
    const decided = await execute("community.decide-report", {
      id: report,
      expectedVersion: await versionOfReport(report),
      action: "suspend",
      reason: REASON,
    });
    expect(decided.next.args.refs).toEqual([
      { type: "user", id: author, intent: "withdraw" },
    ]);
    await succeed(item, "withdraw_media");
    expect((await follow(decided)).code).toBe("OK");

    const { decision_id: decisionId } = await one(
      "SELECT decision_id FROM community.report_cases WHERE id=$1",
      [report],
    );
    await reporting.appeal(author, decisionId as string, {
      text: "Synthetic appeal",
      requestId: randomUUID(),
    });
    const overturned = await execute("community.review-report", {
      id: report,
      expectedVersion: await versionOfReport(report),
      outcome: "overturn",
      reason: REASON,
    });
    expect(overturned).toMatchObject({ code: "QUEUED" });
    expect(overturned.next.args.refs).toEqual([
      { type: "user", id: author, intent: "publish" },
    ]);
    // Its copy is still live in this fixture, so that is reconsidered beside the publish.
    expect((await jobsOf(item)).map(({ kind }) => kind)).toContain(
      "publish_media",
    );
    await succeedAll(item);
    expect((await follow(overturned)).code).toBe("OK");
  });

  it("settles an upheld review on what its decision queued", async () => {
    const { work, item, author } = await publicWork();
    const report = (
      await reporting.create(await newUser(), {
        kind: "standard",
        target: { type: "work", id: work },
        reason: "other",
        description: "Synthetic",
        requestId: randomUUID(),
      })
    ).id;
    await execute("community.decide-report", {
      id: report,
      expectedVersion: await versionOfReport(report),
      action: "hide",
      reason: REASON,
    });
    const { decision_id: decisionId } = await one(
      "SELECT decision_id FROM community.report_cases WHERE id=$1",
      [report],
    );
    await reporting.appeal(author, decisionId as string, {
      text: "Synthetic appeal",
      requestId: randomUUID(),
    });
    const upheld = await execute("community.review-report", {
      id: report,
      expectedVersion: await versionOfReport(report),
      outcome: "uphold",
      reason: REASON,
    });
    expect(upheld.code).toBe("QUEUED");
    expect(upheld.next.args.refs).toEqual([workRef(work)]);
    await succeed(item, "withdraw_media");
    expect((await follow(upheld)).code).toBe("OK");
  });

  const pendingArticle = async (ownerId: string, item: string) => {
    const id = opaque("article");
    const fingerprint = "d".repeat(64);
    const document = JSON.stringify(emptyArticleDocument());
    await setup.query(
      "INSERT INTO community.article_documents(id,owner_id,version,title,document,fingerprint,created_at,updated_at) VALUES($1,$2,1,'Settling',$3::jsonb,$4,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
      [id, ownerId, document, fingerprint],
    );
    await setup.query(
      "INSERT INTO community.article_revisions(article_id,version,owner_id,title,document,fingerprint,submitted_policy,submitted_by_source,created_at) VALUES($1,1,$2,'Settling',$3::jsonb,$4,'PRE_MODERATION','human',CURRENT_TIMESTAMP)",
      [id, ownerId, document, fingerprint],
    );
    await setup.query(
      "UPDATE community.article_documents SET version=2,status='pending',pending_version=1,updated_at=CURRENT_TIMESTAMP WHERE id=$1",
      [id],
    );
    await setup.query(
      `INSERT INTO community.media_item_refs(item_id,holder_kind,holder_id)
       VALUES($1,'article_revision','article-revision-'||substr(encode(sha256(convert_to($2||':1','UTF8')),'hex'),1,32))`,
      [item, id],
    );
    return { id, fingerprint };
  };

  it("settles an Article's approval on the item its revision holds, and its report's hide", async () => {
    gates.open = true;
    const author = await newUser();
    const item = await newItem(author);
    const { id, fingerprint } = await pendingArticle(author, item);
    const approved = await execute("community.moderate-article-submission", {
      id,
      expectedVersion: 2,
      candidateVersion: 1,
      fingerprint,
      action: "approve",
      reason: REASON,
    });
    expect(approved).toMatchObject({ code: "QUEUED" });
    expect(approved.next.args.refs).toEqual([
      { type: "article", id, intent: "publish" },
    ]);
    await succeed(item, "publish_media");
    expect((await follow(approved)).code).toBe("OK");

    // A community Article is the Backend's own record: its report's hide moves media.
    const { id: asset } = await one<{ id: string }>(
      "SELECT id FROM community.media_public_assets WHERE item_id=$1",
      [item],
    );
    await publicCopyOf(item, author, asset);
    const report = (
      await reporting.create(await newUser(), {
        kind: "standard",
        target: { type: "article", id },
        reason: "other",
        description: "Synthetic",
        requestId: randomUUID(),
      })
    ).id;
    const hidden = await execute("community.decide-report", {
      id: report,
      expectedVersion: await versionOfReport(report),
      action: "hide",
      reason: REASON,
    });
    expect(hidden).toMatchObject({ code: "QUEUED" });
    expect(hidden.next.args.refs).toEqual([
      { type: "article", id, intent: "withdraw" },
    ]);
    await succeed(item, "withdraw_media");
    await succeed(item, "publish_media");
    expect((await follow(hidden)).code).toBe("OK");
  });

  it.each(["catalog", "article"] as const)(
    "asks nothing of an official %s's hide, verified before its decision",
    async (type) => {
      officialRecord = {
        canonicalPath: "/official/synthetic",
        snapshot: { title: "Official" },
      };
      const report = (
        await reporting.create(await newUser(), {
          kind: "standard",
          target: { type, id: opaque(type) },
          reason: "other",
          description: "Synthetic",
          requestId: randomUUID(),
        })
      ).id;
      officialRecord = null;
      await withBackendFailing(
        (url) => url.startsWith(SETTLEMENT),
        async () =>
          expect(
            await execute("community.decide-report", {
              id: report,
              expectedVersion: await versionOfReport(report),
              action: "hide",
              reason: REASON,
            }),
          ).toMatchObject({ ok: true, data: { applied: [report] } }),
      );
    },
  );
});

describe("a retried job", () => {
  const failedJob = async () => {
    const id = opaque("publishing-job");
    const subject = opaque("media-item");
    await setup.query(
      "INSERT INTO community.publishing_jobs(id,kind,subject_id,state,run_after) VALUES($1,'purge_item',$2,'failed',CURRENT_TIMESTAMP)",
      [id, subject],
    );
    return { id, subject };
  };

  it("answers QUEUED until its real success, and a replay changes nothing", async () => {
    const { id, subject } = await failedJob();
    const requestId = randomUUID();
    const first = await execute(
      "community.retry-publishing-job",
      { id },
      requestId,
    );
    expect(first).toMatchObject({
      ok: false,
      code: "QUEUED",
      data: { queued: [{ id, state: "media_jobs_open" }] },
    });
    expect(first.next.args.refs).toEqual([{ type: "publishing_job", id }]);
    expect(first.data.results[0]).toEqual({
      index: 0,
      id,
      kind: "purge_item",
      subjectId: subject,
    });
    expect((await follow(first)).code).toBe("QUEUED");
    await succeed(subject, "purge_item");
    expect(await follow(first)).toMatchObject({
      ok: true,
      data: { refs: [{ type: "publishing_job", id, state: "settled" }] },
    });
    expect(
      await execute("community.retry-publishing-job", { id }, requestId),
    ).toMatchObject({
      ok: true,
      data: { already_applied: [id] },
      meta: { replayed: true },
    });
    expect((await jobsOf(subject))[0]!.state).toBe("succeeded");
  });

  it("answers MEDIA_JOB_FAILED when it stops again", async () => {
    const { id, subject } = await failedJob();
    const requestId = randomUUID();
    const first = await execute(
      "community.retry-publishing-job",
      { id },
      requestId,
    );
    await stop(subject, "purge_item");
    expect(await follow(first)).toMatchObject({
      code: "MEDIA_JOB_FAILED",
      data: { refs: [{ state: "failed", failed: 1, jobs: [id] }] },
    });
    expect(
      await execute("community.retry-publishing-job", { id }, requestId),
    ).toMatchObject({
      code: "MEDIA_JOB_FAILED",
      data: { failed: [{ id, jobs: [id] }] },
    });
  });

  it("clears a work's failure, through the job its answer named", async () => {
    const { work, item } = await publicWork();
    await hide(work);
    const failed = await stop(item, "withdraw_media");
    const retried = await execute("community.retry-publishing-job", {
      id: failed,
    });
    expect(retried.code).toBe("QUEUED");
    expect((await job([workRef(work)])).code).toBe("QUEUED");
    await succeed(item, "withdraw_media");
    expect((await follow(retried)).code).toBe("OK");
    expect((await job([workRef(work)])).code).toBe("OK");
  });
});

describe("a lost answer, on an op with media work", () => {
  it("applies the state once, queues once, and reads as QUEUED and then as done", async () => {
    const { work, item } = await publicWork();
    const requestId = randomUUID();
    const input = {
      id: work,
      state: "hidden",
      expectedVersion: await versionOfWork(work),
      reason: REASON,
    };
    let losses = 1;
    const lost = await withStandIn(
      (incoming, outgoing) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of incoming) chunks.push(chunk as Buffer);
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers))
            if (typeof value === "string" && name !== "host")
              headers.set(name, value);
          const upstream = await fetch(
            new URL((incoming.url ?? "/").slice(1), backendOrigin),
            {
              method: incoming.method ?? "GET",
              headers,
              ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }),
            },
          );
          const text = await upstream.text();
          if (incoming.method !== "GET" && losses > 0) {
            losses -= 1;
            outgoing.destroy();
            return;
          }
          outgoing.writeHead(upstream.status, {
            "content-type": "application/json",
          });
          outgoing.end(text);
        })().catch(() => outgoing.destroy());
      },
      () => execute("community.moderate-work", input, requestId),
    );
    expect(lost).toMatchObject({ ok: false, code: "OUTCOME_UNKNOWN" });
    const retried = await execute("community.moderate-work", input, requestId);
    expect(retried).toMatchObject({
      ok: false,
      code: "QUEUED",
      data: { queued: [{ id: work, alreadyApplied: true }] },
      meta: { replayed: true },
    });
    expect(retried.data.moderationCases).toBeUndefined();
    expect(await jobsOf(item)).toHaveLength(1);
    await succeed(item, "withdraw_media");
    expect(
      await execute("community.moderate-work", input, requestId),
    ).toMatchObject({
      ok: true,
      code: "OK",
      data: { already_applied: [work] },
    });
    expect(
      (
        await one(
          "SELECT count(*)::integer AS n FROM community.content_operator_events WHERE content_id=$1 AND action='work.moderate'",
          [work],
        )
      ).n,
    ).toBe(1);
    expect(await jobsOf(item)).toHaveLength(1);
  });
});

describe("a lost answer, on the ops with no receipt", () => {
  /** Delivers the one write and loses its answer, as the first call's way of ending. */
  const losing = async <T>(attempt: () => Promise<T>): Promise<T> => {
    let losses = 1;
    return withStandIn((incoming, outgoing) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(chunk as Buffer);
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers))
          if (typeof value === "string" && name !== "host")
            headers.set(name, value);
        const upstream = await fetch(
          new URL((incoming.url ?? "/").slice(1), backendOrigin),
          {
            method: incoming.method ?? "GET",
            headers,
            ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }),
          },
        );
        const text = await upstream.text();
        if (incoming.method !== "GET" && losses > 0) {
          losses -= 1;
          outgoing.destroy();
          return;
        }
        outgoing.writeHead(upstream.status, {
          "content-type": "application/json",
        });
        outgoing.end(text);
      })().catch(() => outgoing.destroy());
    }, attempt);
  };

  it("applies a suspension once, by the state it finds, and waits on what it queued", async () => {
    const { item, author } = await publicWork();
    const requestId = randomUUID();
    const input = { id: author, action: "suspend", reason: REASON };
    expect(
      await losing(() => execute("community.moderate-user", input, requestId)),
    ).toMatchObject({ code: "OUTCOME_UNKNOWN" });
    const retried = await execute("community.moderate-user", input, requestId);
    expect(retried).toMatchObject({
      code: "QUEUED",
      data: { queued: [{ id: author, alreadyApplied: true }] },
    });
    expect(retried.data.moderationCases).toBeUndefined();
    expect(await jobsOf(item)).toHaveLength(1);
    await succeed(item, "withdraw_media");
    expect(
      await execute("community.moderate-user", input, requestId),
    ).toMatchObject({ ok: true, data: { already_applied: [author] } });
    expect(await jobsOf(item)).toHaveLength(1);
  });

  it("applies a decision once, by the record it reads, and waits on what it queued", async () => {
    const { work, item } = await publicWork();
    const report = (
      await reporting.create(await newUser(), {
        kind: "standard",
        target: { type: "work", id: work },
        reason: "other",
        description: "Synthetic",
        requestId: randomUUID(),
      })
    ).id;
    const requestId = randomUUID();
    const input = {
      id: report,
      expectedVersion: await versionOfReport(report),
      action: "hide",
      reason: REASON,
    };
    expect(
      await losing(() => execute("community.decide-report", input, requestId)),
    ).toMatchObject({ code: "OUTCOME_UNKNOWN" });
    const retried = await execute("community.decide-report", input, requestId);
    expect(retried).toMatchObject({
      code: "QUEUED",
      data: { queued: [{ id: report, alreadyApplied: true }] },
      meta: { replayed: true },
    });
    expect(retried.next.args.refs).toEqual([workRef(work)]);
    expect(await jobsOf(item)).toHaveLength(1);
    await succeed(item, "withdraw_media");
    expect(
      await execute("community.decide-report", input, requestId),
    ).toMatchObject({ ok: true, data: { already_applied: [report] } });
    expect(
      (
        await one(
          "SELECT count(*)::integer AS n FROM community.report_decisions WHERE case_id=$1",
          [report],
        )
      ).n,
    ).toBe(1);
  });
});

describe("a publish gate that is shut", () => {
  /** Suspended by nothing a decision holds, with an item never yet public. */
  const suspendedUser = async () => {
    const id = await newUser();
    const item = await newItem(id);
    await setup.query(
      "UPDATE community.public_users SET status='suspended' WHERE id=$1",
      [id],
    );
    return { id, item };
  };
  const reinstate = (id: string) =>
    execute("community.moderate-user", {
      id,
      action: "reinstate",
      reason: REASON,
    });

  it("says so on ok:true, because no job exists to wait for", async () => {
    const { id, item } = await suspendedUser();
    expect(await reinstate(id)).toMatchObject({
      ok: true,
      data: { applied: [id] },
      meta: { mediaGate: "off" },
    });
    expect(await jobsOf(item)).toEqual([]);
    expect(await job([{ type: "user", id, intent: "publish" }])).toMatchObject({
      ok: true,
      meta: { mediaGate: "off" },
    });
  });

  it("says nothing on a withdrawal, which runs whatever the gates say", async () => {
    const { work, item } = await publicWork();
    const hidden = await hide(work);
    expect(hidden.meta.mediaGate).toBeUndefined();
    await succeed(item, "withdraw_media");
    const read = await follow(hidden);
    expect(read.code).toBe("OK");
    expect(read.meta.mediaGate).toBeUndefined();
  });

  it("queues and says nothing with the gates open", async () => {
    gates.open = true;
    const { id, item } = await suspendedUser();
    const reinstated = await reinstate(id);
    expect(reinstated.code).toBe("QUEUED");
    expect(reinstated.meta.mediaGate).toBeUndefined();
    await succeed(item, "publish_media");
    const read = await follow(reinstated);
    expect(read.code).toBe("OK");
    expect(read.meta.mediaGate).toBeUndefined();
  });

  it("shuts when the access mode leaves public, whichever gate it is", async () => {
    const { id } = await suspendedUser();
    gates.open = true;
    vi.spyOn(publication, "isPublic").mockReturnValueOnce(false);
    expect(await job([{ type: "user", id, intent: "publish" }])).toMatchObject({
      ok: true,
      meta: { mediaGate: "off" },
    });
    vi.spyOn(publication, "allowPublish").mockReturnValueOnce(false);
    expect(await job([{ type: "user", id, intent: "publish" }])).toMatchObject({
      ok: true,
      meta: { mediaGate: "off" },
    });
    vi.restoreAllMocks();
    const read = await job([{ type: "user", id, intent: "publish" }]);
    expect(read.meta.mediaGate).toBeUndefined();
  });
});

describe("a source that does not answer is never a miss", () => {
  it("reads as QUEUED and unread on the write, and its next asks again", async () => {
    const { work, item } = await publicWork();
    const requestId = randomUUID();
    const input = {
      id: work,
      state: "hidden",
      expectedVersion: await versionOfWork(work),
      reason: REASON,
    };
    const first = await withBackendFailing(
      (url) => url.startsWith(SETTLEMENT),
      () => execute("community.moderate-work", input, requestId),
    );
    expect(first).toMatchObject({
      ok: false,
      code: "QUEUED",
      state: "settlement_unread",
      data: { queued: [{ id: work, state: "settlement_unread" }] },
    });
    // No read says which jobs are left, so the way on is the call itself, which replays.
    expect(first.next).toMatchObject({
      tool: "admin_execute",
      args: { requestId, op: "community.moderate-work" },
    });
    const second = await send(client, "admin_execute", first.next.args as Json);
    expect(second).toMatchObject({
      code: "QUEUED",
      state: "media_jobs_open",
      meta: { replayed: true },
    });
    await succeed(item, "withdraw_media");
    expect((await follow(second)).code).toBe("OK");
  });

  it("reads as QUEUED and unread on admin_job, and never as settled", async () => {
    const { work } = await publicWork();
    await withBackendFailing(
      (url) => url.startsWith(SETTLEMENT),
      async () => {
        const read = await job([workRef(work)]);
        expect(read).toMatchObject({
          ok: false,
          code: "QUEUED",
          state: "settlement_unread",
          data: { refs: [{ type: "work", id: work, state: "unread" }] },
        });
        expect(read.next.args.refs).toEqual([workRef(work)]);
      },
    );
  });

  it("reads a Backend that has gone as unread, and a garbled answer too", async () => {
    const { work } = await publicWork();
    await withStandIn(
      (_incoming, outgoing) => outgoing.destroy(),
      async () =>
        expect(await job([workRef(work)])).toMatchObject({
          code: "QUEUED",
          state: "settlement_unread",
        }),
    );
    await withStandIn(
      (_incoming, outgoing) => {
        outgoing.writeHead(200, { "content-type": "application/json" });
        outgoing.end(JSON.stringify({ open: "none" }));
      },
      async () =>
        expect(await job([workRef(work)])).toMatchObject({
          code: "QUEUED",
          state: "settlement_unread",
        }),
    );
  });

  it("answers a job read that fails the same way, on a retried job", async () => {
    const id = opaque("publishing-job");
    await withBackendFailing(
      (url) => url.includes("/publishing/jobs"),
      async () =>
        expect(await job([{ type: "publishing_job", id }])).toMatchObject({
          code: "QUEUED",
          state: "settlement_unread",
          data: { refs: [{ state: "unread" }] },
        }),
    );
  });
});

describe("what admin_job refuses", () => {
  it("answers NOT_FOUND for a subject that is not there, and never ok:true", async () => {
    for (const ref of [
      workRef(opaque("work")),
      { type: "article", id: opaque("article"), intent: "publish" },
      { type: "user", id: opaque("user"), intent: "withdraw" },
      { type: "item", id: opaque("media-item"), intent: "withdraw" },
      { type: "publishing_job", id: opaque("publishing-job") },
    ])
      expect(await job([ref]), ref.type).toMatchObject({
        ok: false,
        code: "NOT_FOUND",
        data: { refs: [{ state: "refused", code: "NOT_FOUND" }] },
      });
  });

  it("names a bad input and never reads it as anything else", async () => {
    const work = workRef(opaque("work"));
    for (const args of [
      { kind: "settlement", refs: [] },
      { kind: "settlement" },
      { kind: "run", refs: [work] },
      { kind: "settlement", refs: [{ ...work, type: "comment" }] },
      { kind: "settlement", refs: [{ ...work, intent: "erase" }] },
      { kind: "settlement", refs: [{ ...work, extra: 1 }] },
      { kind: "settlement", refs: [{ type: "work", id: work.id }] },
      {
        kind: "settlement",
        refs: Array.from({ length: ADMIN_JOB_MAX_REFS + 1 }, () => work),
      },
      { kind: "settlement", refs: [work], since: "now" },
    ])
      expect(
        await send(client, "admin_job", args),
        JSON.stringify(args).slice(0, 80),
      ).toMatchObject({ ok: false, code: "INPUT_INVALID" });
  });

  it("names a mixed batch PARTIAL, with each ref's own state", async () => {
    const { work } = await publicWork();
    const missing = workRef(opaque("work"));
    const read = await job([workRef(work), missing]);
    expect(read).toMatchObject({
      ok: false,
      code: "PARTIAL",
      data: {
        refs: [
          { id: work, state: "settled" },
          { id: missing.id, state: "refused", code: "NOT_FOUND" },
        ],
      },
    });
  });
});

describe("self-only", () => {
  it("answers SELF_ONLY_OWNER_REVIEW on a self-only work or its item, with no count", async () => {
    const { work, item } = await publicWork();
    await enqueue(item, "withdraw_media");
    await makeSelfOnly(work);
    for (const ref of [
      workRef(work),
      { type: "item", id: item, intent: "withdraw" },
    ]) {
      const read = await job([ref]);
      expect(read, ref.type).toMatchObject({
        ok: false,
        code: "SELF_ONLY_OWNER_REVIEW",
        data: {
          refs: [{ state: "refused", code: "SELF_ONLY_OWNER_REVIEW" }],
        },
      });
      expect(read.data.refs[0].open).toBeUndefined();
    }
    await setup.query(
      "UPDATE community.works SET visibility='public' WHERE id=$1",
      [work],
    );
    expect((await job([workRef(work)])).code).toBe("QUEUED");
  });

  it("reads a work its author flipped after the write as unread, and never as done", async () => {
    const { work, item } = await publicWork();
    const requestId = randomUUID();
    const input = {
      id: work,
      state: "hidden",
      expectedVersion: await versionOfWork(work),
      reason: REASON,
    };
    // The flip lands between the commit and the settlement read.
    const first = await withStandIn(
      (incoming, outgoing) => {
        void (async () => {
          if ((incoming.url ?? "").startsWith(SETTLEMENT))
            await makeSelfOnly(work);
          const chunks: Buffer[] = [];
          for await (const chunk of incoming) chunks.push(chunk as Buffer);
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers))
            if (typeof value === "string" && name !== "host")
              headers.set(name, value);
          const upstream = await fetch(
            new URL((incoming.url ?? "/").slice(1), backendOrigin),
            {
              method: incoming.method ?? "GET",
              headers,
              ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }),
            },
          );
          outgoing.writeHead(upstream.status, {
            "content-type": "application/json",
          });
          outgoing.end(await upstream.text());
        })().catch(() => outgoing.destroy());
      },
      () => execute("community.moderate-work", input, requestId),
    );
    expect(first).toMatchObject({
      code: "QUEUED",
      state: "settlement_unread",
      data: { queued: [{ id: work }] },
    });
    expect(await jobsOf(item)).toHaveLength(1);
  });

  it("counts a user's items without saying which, whatever they hold", async () => {
    const { work, author, item } = await publicWork();
    await enqueue(item, "withdraw_media");
    await makeSelfOnly(work);
    expect(
      await job([{ type: "user", id: author, intent: "withdraw" }]),
    ).toMatchObject({
      code: "QUEUED",
      data: { refs: [{ type: "user", id: author, state: "open", open: 1 }] },
    });
  });
});

describe("who may read it", () => {
  const catalogAsset = async () => {
    const mediaId = `media_${hex()}`;
    const key = `display/v1/media_${hex()}/${sha()}.webp`;
    const { id } = await one<{ id: string }>(
      `INSERT INTO community.catalog_media_assets(id,media_id,source_object_key)
       VALUES('catalog-asset-'||md5($1||':'||$2),$1,$2) RETURNING id`,
      [mediaId, key],
    );
    return id;
  };

  it("settles an item and a Catalog asset with the community token absent", async () => {
    const author = await newUser();
    const item = await newItem(author);
    const asset = await catalogAsset();
    await newAsset({ asset });
    await enqueue(item, "withdraw_media");
    await enqueue(asset, "publish_media");
    vi.stubEnv("COMMUNITY_OPERATOR_AI_TOKEN", "");
    expect(
      await job([{ type: "item", id: item, intent: "withdraw" }]),
    ).toMatchObject({ code: "QUEUED", data: { refs: [{ open: 1 }] } });
    expect(
      await job([{ type: "item", id: asset, intent: "withdraw" }]),
    ).toMatchObject({ code: "QUEUED", data: { refs: [{ open: 1 }] } });
    await succeed(asset, "publish_media");
    expect(
      await job([{ type: "item", id: asset, intent: "withdraw" }]),
    ).toMatchObject({ ok: true });
    // A record's settlement reads community state, so it stays on the token it needs.
    expect(await job([workRef((await publicWork()).work)])).toMatchObject({
      ok: false,
      code: "AI_CREDENTIAL_NOT_CONFIGURED",
    });
  });

  it("answers AI_CREDENTIAL_NOT_CONFIGURED with its own token absent, and never settled", async () => {
    const item = await newItem(await newUser());
    vi.stubEnv("OPERATOR_AI_BASE_TOKEN", "");
    expect(
      await job([{ type: "item", id: item, intent: "withdraw" }]),
    ).toMatchObject({ ok: false, code: "AI_CREDENTIAL_NOT_CONFIGURED" });
  });

  it("is a read: a read key lists it and may call it", async () => {
    const { tools } = await readClient.listTools();
    const listed = tools.find(({ name }) => name === "admin_job");
    expect(listed?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(tools.map(({ name }) => name)).not.toContain("admin_execute");
    const { work } = await publicWork();
    expect((await job([workRef(work)], readClient)).code).toBe("OK");
  });
});

describe("a batch", () => {
  it("answers per target, and its next reads only what is still open", async () => {
    const [queued, stopped, settled] = await Promise.all([
      publicWork(),
      publicWork(),
      publicWork(),
    ]);
    const targets = [];
    for (const { work } of [queued!, stopped!, settled!])
      targets.push({ id: work, expectedVersion: await versionOfWork(work) });
    const requestId = randomUUID();
    const input = { state: "hidden", reason: REASON };
    const first = await executeAll(
      "community.moderate-work",
      input,
      targets,
      requestId,
    );
    expect(first).toMatchObject({
      code: "QUEUED",
      data: { moderationCases: 3 },
    });
    expect(first.data.queued.map(({ id }: Json) => id)).toEqual([
      queued!.work,
      stopped!.work,
      settled!.work,
    ]);
    // The refs of every waiting target join into one read.
    expect(first.next).toEqual({
      tool: "admin_job",
      args: {
        kind: "settlement",
        refs: [
          workRef(queued!.work),
          workRef(stopped!.work),
          workRef(settled!.work),
        ],
      },
      afterMs: 2_000,
    });

    const failedJob = await stop(stopped!.item, "withdraw_media");
    await succeed(settled!.item, "withdraw_media");
    const replay = await executeAll(
      "community.moderate-work",
      input,
      targets,
      requestId,
    );
    expect(replay).toMatchObject({
      ok: false,
      code: "PARTIAL",
      meta: { partial: true, replayed: true },
      data: {
        already_applied: [settled!.work],
        queued: [{ id: queued!.work, alreadyApplied: true }],
        failed: [
          { id: stopped!.work, code: "MEDIA_JOB_FAILED", jobs: [failedJob] },
        ],
      },
    });
    // What stopped has no way on, and what is waiting still does.
    expect(replay.next.args.refs).toEqual([workRef(queued!.work)]);
  });

  it("replays when one target's jobs could not be read, and reads the rest as it found them", async () => {
    const [read, unread] = [await publicWork(), await publicWork()];
    const targets: Json[] = [];
    for (const { work } of [read, unread])
      targets.push({ id: work, expectedVersion: await versionOfWork(work) });
    const requestId = randomUUID();
    const input = { state: "hidden", reason: REASON };
    const first = await withBackendFailing(
      (url) => url.startsWith(SETTLEMENT) && url.includes(unread.work),
      () => executeAll("community.moderate-work", input, targets, requestId),
    );
    expect(first).toMatchObject({
      code: "QUEUED",
      data: {
        queued: [
          { id: read.work, state: "media_jobs_open" },
          { id: unread.work, state: "settlement_unread" },
        ],
      },
    });
    // A read of the first alone would leave the other unasked.
    expect(first.next).toMatchObject({
      tool: "admin_execute",
      args: { requestId, op: "community.moderate-work" },
    });
    expect(
      await executeAll("community.moderate-work", input, targets, requestId),
    ).toMatchObject({
      code: "QUEUED",
      next: { tool: "admin_job" },
      meta: { replayed: true },
    });
  });

  it("falls back to the call itself past what one next can hold", async () => {
    const works = [];
    for (let index = 0; index < 25; index += 1) works.push(await publicWork());
    const targets = [];
    for (const { work } of works)
      targets.push({ id: work, expectedVersion: await versionOfWork(work) });
    const requestId = randomUUID();
    const first = await executeAll(
      "community.moderate-work",
      { state: "hidden", reason: REASON },
      targets,
      requestId,
    );
    expect(first.code).toBe("QUEUED");
    expect(first.data.queued).toHaveLength(25);
    expect(first.next).toMatchObject({
      tool: "admin_execute",
      args: { requestId, op: "community.moderate-work" },
    });
    for (const { item } of works) await succeed(item, "withdraw_media");
    const again = await executeAll(
      "community.moderate-work",
      { state: "hidden", reason: REASON },
      targets,
      requestId,
    );
    expect(again).toMatchObject({ ok: true, meta: { replayed: true } });
    expect(again.data.already_applied).toHaveLength(25);
  });
});

describe("its size and its budget", () => {
  const answering =
    (answer: Json) =>
    (_incoming: IncomingMessage, outgoing: ServerResponse) => {
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(JSON.stringify(answer));
    };
  const refs = Array.from({ length: ADMIN_JOB_MAX_REFS }, () =>
    workRef(opaque("work")),
  );

  it("fits the largest answer under the cap with its whole next", async () => {
    await withStandIn(
      answering({ open: 2, failed: 0, failedJobs: [] }),
      async () => {
        const read = await job(refs);
        expect(read.code).toBe("QUEUED");
        expect(read.meta.truncated).toBeUndefined();
        expect(read.data.refs).toHaveLength(ADMIN_JOB_MAX_REFS);
        expect(read.next.args.refs).toEqual(refs);
      },
    );
  });

  it("goes on from the first ref a cut left out", async () => {
    const jobs = Array.from({ length: 3 }, () => opaque("publishing-job"));
    await withStandIn(
      answering({ open: 0, failed: 3, failedJobs: jobs }),
      async () => {
        const read = await job(refs);
        expect(read.code).toBe("MEDIA_JOB_FAILED");
        expect(read.meta.truncated).toBe(true);
        const kept = read.data.refs.length;
        expect(kept).toBeGreaterThan(0);
        expect(read.remaining).toBe(ADMIN_JOB_MAX_REFS - kept);
        expect(read.next.args.refs).toEqual(refs.slice(kept));
      },
    );
  });

  it("stops at the budget and goes on with the rest, naming nothing it did not read", async () => {
    const { work, item } = await publicWork();
    await hide(work);
    const other = (await publicWork()).work;
    const started = Date.now();
    let offset = 0;
    const clock = vi
      .spyOn(performance, "now")
      .mockImplementation(() => Date.now() - started + offset);
    let read: Json;
    try {
      read = await withStandIn(
        (incoming, outgoing) => {
          // The first read uses the whole budget.
          offset = 11_000;
          void (async () => {
            const upstream = await fetch(
              new URL((incoming.url ?? "/").slice(1), backendOrigin),
              { headers: { authorization: `Bearer ${communityToken}` } },
            );
            outgoing.writeHead(upstream.status, {
              "content-type": "application/json",
            });
            outgoing.end(await upstream.text());
          })().catch(() => outgoing.destroy());
        },
        () => job([workRef(work), workRef(other)]),
      );
    } finally {
      clock.mockRestore();
    }
    expect(read).toMatchObject({
      ok: false,
      code: "IN_PROGRESS",
      remaining: 1,
      data: { refs: [{ id: work, state: "open" }] },
    });
    expect(read.data.refs).toHaveLength(1);
    expect(read.next.args.refs).toEqual([workRef(work), workRef(other)]);
    await succeed(item, "withdraw_media");
    expect((await send(client, "admin_job", read.next.args as Json)).code).toBe(
      "OK",
    );
  });
});
