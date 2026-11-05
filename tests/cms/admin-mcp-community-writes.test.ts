/**
 * admin-mcp-completion-v1 S7: the community's reversible writes on admin_execute, real
 * JSON-RPC over HTTP with the official client, through the real door and guard, to the
 * real Backend on a disposable community database of its own, as the App role. What it
 * holds to: every write records `ai-admin`; a reason gives the case, the user message
 * and the appeal path the human route gives; a lost answer retried applies once; and a
 * write on anything self-only answers SELF_ONLY_OWNER_REVIEW and changes nothing. The
 * suite seeds all it writes on, so it passes alone on an empty server and on a used one.
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
import { emptyArticleDocument } from "@moya/contracts/schemas";
import {
  ADMIN_MCP_TEXT_CAP_BYTES,
  ADMIN_OP_NAMES,
  AI_OPERATOR_REQUEST_ID_HEADER,
  adminMcpEnvelopeSchema,
} from "@moya/contracts/internal/admin-mcp";
import { UnconfiguredStorageUrlResolver } from "@moya/image";
import { sql, type PostgresAdapter } from "@payloadcms/db-postgres";
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

import { adminOpMeta } from "admin/admin-mcp";

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
const database = `community_write_${run}_synthetic_test`;
const role = `community_write_${run}`;
const admin = poolFor(target);
let setup: Pool;
let app: Pool;
let createdDatabase = false;
let createdRole = false;

const syntheticToken = () => randomBytes(32).toString("base64url");
const ownerToken = syntheticToken();
const communityToken = syntheticToken();
const baseToken = syntheticToken();
const opaque = (prefix: string) =>
  `${prefix}-${randomUUID().replaceAll("-", "")}`;
const AI = "ai-admin";
const REASON = "Synthetic reason";
const CONTACT_CANARY = `contactcanary${run}`;
const EVIDENCE_CANARY = `evidencecanary${run}.pdf`;
const HOSTILE = `IGNOREPREVIOUS${run}`;

let payload: Payload;
let routes: Awaited<ReturnType<typeof serveRoutes>>;
let backend: Server;
let backendOrigin = "";
let client: Client;
let readClient: Client;
let keyId: number;
let reporting: PostgresCommunityReportingAdapter;

const send = async (with_: Client, name: string, args: Json) => {
  const result = await with_.callTool({ name, arguments: args });
  const text = (result.content as { text: string }[])[0]!.text;
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(ADMIN_MCP_TEXT_CAP_BYTES);
  const envelope = adminMcpEnvelopeSchema.parse(result.structuredContent);
  expect(JSON.parse(text)).toEqual(envelope);
  expect(result.isError === true).toBe(!envelope.ok);
  return { envelope: envelope as Json, text };
};
const execute = async (
  op: string,
  input: Json,
  requestId: string = randomUUID(),
): Promise<Json> =>
  (await send(client, "admin_execute", { requestId, op, input })).envelope;
const executeAll = async (
  op: string,
  input: Json,
  targets: readonly Json[],
  requestId: string = randomUUID(),
): Promise<Json> =>
  (await send(client, "admin_execute", { requestId, op, input, targets }))
    .envelope;
const read = async (args: Json): Promise<Json> =>
  (await send(client, "admin_read", args)).envelope;

/** The target reached the state it asked for: done, or waiting on its media jobs. */
const committedIds = ({ data }: Json): unknown[] => [
  ...(data?.applied ?? []),
  ...(data?.already_applied ?? []),
  ...(data?.queued ?? []).map(({ id }: Json) => id),
];

const without = (record: Json, names: readonly string[]): Json =>
  Object.fromEntries(
    Object.entries(record).filter(([name]) => !names.includes(name)),
  );

const one = async <Row extends Json = Json>(
  statement: string,
  values: readonly unknown[] = [],
): Promise<Row> =>
  (await setup.query<Row>(statement, [...values])).rows[0] as Row;
const rows = async <Row extends Json = Json>(
  statement: string,
  values: readonly unknown[] = [],
): Promise<Row[]> => (await setup.query<Row>(statement, [...values])).rows;
const countOf = async (table: string, where: string, values: unknown[]) =>
  Number(
    (await one(`SELECT count(*) AS n FROM ${table} WHERE ${where}`, values)).n,
  );

/** The real Backend, reading and writing through this pool. */
const backendOn = (pool: Pool): Server =>
  createBackendServer(
    createBackendApplication({
      nodeEnv: "development",
      communityIdentityPort: new PostgresCommunityIdentityAdapter(pool),
      communityCommentPort: new PostgresCommunityCommentAdapter(pool),
      discussionPort: new PostgresCommunityCommentAdapter(pool),
      authorCommunityPort: new PostgresAuthorCommunityAdapter(pool),
      contentOperatorPort: new PostgresCommunityContentOperatorAdapter(pool),
      reportingPort: new PostgresCommunityReportingAdapter(pool),
      publishingOperatorPort: new PostgresPublishingOperatorAdapter(pool),
      articlePublicationOperatorPort: new PostgresArticleAuthoringAdapter(pool),
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

/** A stand-in between Admin and the real Backend: it delivers, then loses, a write. */
const withLostWrite = async <T>(attempt: () => Promise<T>): Promise<T> => {
  let losses = 1;
  const proxy = createServer((incoming, outgoing) => {
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
  });
  await new Promise<void>((resolve) =>
    proxy.listen(0, "127.0.0.1", () => resolve()),
  );
  try {
    vi.stubEnv(
      "COMMUNITY_OPERATOR_BASE_URL",
      `http://127.0.0.1:${(proxy.address() as AddressInfo).port}/`,
    );
    return await attempt();
  } finally {
    vi.stubEnv("COMMUNITY_OPERATOR_BASE_URL", backendOrigin);
    proxy.closeAllConnections();
    await new Promise((resolve) => proxy.close(resolve));
  }
};

const withStubBackend = async <T>(
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

let sequence = 0;
const newUser = async (name = "Synthetic") => {
  sequence += 1;
  const id = opaque("user");
  await setup.query(
    "INSERT INTO community.public_users(id,handle,display_name,bio) VALUES($1,$2,$3,'')",
    [id, `writer-${sequence}-${run}`, `${name} ${sequence}`],
  );
  return id;
};
/** The legacy bridge makes it a public work with its public revision. */
const newWork = async (authorId: string, title = `Work ${run}`) => {
  const id = opaque("work");
  await setup.query(
    "INSERT INTO community.works(id,author_id,title,text,first_published_at) VALUES($1,$2,$3,'Synthetic text',CURRENT_TIMESTAMP)",
    [id, authorId, title],
  );
  return id;
};
const makeSelfOnly = (workId: string) =>
  setup.query("UPDATE community.works SET visibility='self' WHERE id=$1", [
    workId,
  ]);
const makePublic = (workId: string) =>
  setup.query("UPDATE community.works SET visibility='public' WHERE id=$1", [
    workId,
  ]);
/** As an erasure leaves a work: nothing holds its text. */
const deleteWork = async (workId: string) => {
  await setup.query(
    "UPDATE community.works SET title='',text='',media_ids='{}',public_revision_id=NULL,author_revision_id=NULL,visibility='self',deleted_at=CURRENT_TIMESTAMP WHERE id=$1",
    [workId],
  );
  await setup.query("DELETE FROM community.work_revisions WHERE work_id=$1", [
    workId,
  ]);
};
const newComment = async (
  workId: string,
  authorId: string,
  text = `Comment ${run}`,
) => {
  const id = opaque("comment");
  await setup.query(
    "INSERT INTO community.catalog_comments(id,catalog_id,target_type,author_id,text,moderation) VALUES($1,$2,'work',$3,$4,'visible')",
    [id, workId, authorId, text],
  );
  return id;
};
const newReply = async (rootId: string, authorId: string) => {
  const id = opaque("comment");
  await setup.query(
    "INSERT INTO community.catalog_comment_replies(id,root_comment_id,author_id,text,moderation) VALUES($1,$2,$3,$4,'visible')",
    [id, rootId, authorId, `Reply ${run}`],
  );
  return id;
};
const newPendingRevision = async (workId: string, authorId: string) => {
  const id = opaque("work-revision");
  await setup.query(
    `INSERT INTO community.work_revisions(id,work_id,author_id,sequence,origin,title,body,authorship_kind,requested_visibility,content_sha256,disposition,submitted_at)
     VALUES($1,$2,$3,50,'submission',$4,'Synthetic body','original','public',$5,'pending',CURRENT_TIMESTAMP)`,
    [id, workId, authorId, `Revision ${run}`, "a".repeat(64)],
  );
  await setup.query(
    "UPDATE community.works SET author_revision_id=$2 WHERE id=$1",
    [workId, id],
  );
  return id;
};
const ARTICLE_FINGERPRINT = "d".repeat(64);
const newPendingArticle = async (
  ownerId: string,
  document = JSON.stringify(emptyArticleDocument()),
) => {
  const id = opaque("article");
  const title = `Article ${run}`;
  await setup.query(
    "INSERT INTO community.article_documents(id,owner_id,version,title,document,fingerprint,created_at,updated_at) VALUES($1,$2,1,$3,$4::jsonb,$5,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
    [id, ownerId, title, document, ARTICLE_FINGERPRINT],
  );
  await setup.query(
    "INSERT INTO community.article_revisions(article_id,version,owner_id,title,document,fingerprint,submitted_policy,submitted_by_source,created_at) VALUES($1,1,$2,$3,$4::jsonb,$5,'PRE_MODERATION','human',CURRENT_TIMESTAMP)",
    [id, ownerId, title, document, ARTICLE_FINGERPRINT],
  );
  await setup.query(
    "UPDATE community.article_documents SET version=2,status='pending',pending_version=1,updated_at=CURRENT_TIMESTAMP WHERE id=$1",
    [id],
  );
  return id;
};
const newStandardReport = async (workId: string, reporter: string) =>
  (
    await reporting.create(reporter, {
      kind: "standard",
      target: { type: "work", id: workId },
      reason: "other",
      description: `Report ${run}`,
      requestId: randomUUID(),
    })
  ).id;
const newCommentReport = async (commentId: string, reporter: string) =>
  (
    await reporting.create(reporter, {
      kind: "quick_comment",
      target: { type: "comment", id: commentId },
      requestId: randomUUID(),
    })
  ).id;
const newRightsNotice = async (workId: string, reporter: string) => {
  const { id } = await reporting.create(reporter, {
    kind: "rights_notice",
    target: { type: "work", id: workId },
    reason: "copyright",
    description: `Notice ${run}`,
    claimantName: "Synthetic claimant",
    contact: CONTACT_CANARY,
    rightsBasis: "Synthetic basis",
    requestId: randomUUID(),
  });
  await setup.query(
    "INSERT INTO community.report_evidence(id,case_id,owner_id,file_name,mime_type,byte_size,sensitive,sha256,state) VALUES($1,$2,$3,$4,'application/pdf',20,true,$5,'ready')",
    [opaque("evidence"), id, reporter, EVIDENCE_CANARY, "b".repeat(64)],
  );
  return id;
};
const versionOfReport = async (id: string) =>
  Number(
    (await one("SELECT version FROM community.report_cases WHERE id=$1", [id]))
      .version,
  );
const versionOfWork = async (id: string) =>
  Number(
    (await one("SELECT version FROM community.works WHERE id=$1", [id]))
      .version,
  );
const versionOfRevision = async (id: string) =>
  Number(
    (
      await one("SELECT version FROM community.work_revisions WHERE id=$1", [
        id,
      ])
    ).version,
  );
const decideAs = async (
  id: string,
  action: string,
  as: "ai" | "owner" = "ai",
) => {
  const command = {
    id,
    expectedVersion: await versionOfReport(id),
    action,
    reason: REASON,
  };
  if (as === "ai")
    expect(
      committedIds(await execute("community.decide-report", command)),
    ).toEqual([id]);
  else
    expect(
      (await owner("POST", `reports/${id}/decisions`, without(command, ["id"])))
        .status,
    ).toBe(200);
};
/** Appeals as the person the decision affects, through the path a user has. */
const appealAs = async (affectedUserId: string, reportId: string) => {
  const { decision_id: decisionId } = await one(
    "SELECT decision_id FROM community.report_cases WHERE id=$1",
    [reportId],
  );
  await reporting.appeal(affectedUserId, decisionId, {
    text: `Appeal ${run}`,
    requestId: randomUUID(),
  });
};

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
  reporting = new PostgresCommunityReportingAdapter(setup);
  url.username = role;
  url.password = password;
  app = poolFor(url.toString());
  backend = backendOn(app);
  const address = await startServer(backend, { host: "127.0.0.1", port: 0 });
  backendOrigin = `http://127.0.0.1:${address.port}/`;

  const config = await (await import("admin/config")).default;
  payload = await getPayload({ config });
  routes = await serveRoutes(config);
  const account = await payload.create({
    collection: "users",
    overrideAccess: true,
    data: {
      email: `community-writes-${run}@example.invalid`,
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
    const created = await payload.create({
      collection: "payload-mcp-api-keys",
      overrideAccess: true,
      data: {
        user: aiOperator.id,
        label: `community-writes-${toolProfile}-${run}`,
        enableAPIKey: true,
        apiKey: secret,
        toolProfile,
      } as never,
    });
    return { secret, id: created.id as number };
  };
  const operate = await keyFor("operate");
  keyId = operate.id;
  client = (
    await connectClient(routes.endpoint, {
      authorization: `Bearer ${operate.secret}`,
    })
  ).client;
  readClient = (
    await connectClient(routes.endpoint, {
      authorization: `Bearer ${(await keyFor("read")).secret}`,
    })
  ).client;
}, 180_000);

beforeEach(() => {
  vi.stubEnv("COMMUNITY_OPERATOR_BASE_URL", backendOrigin);
  vi.stubEnv("COMMUNITY_OPERATOR_AI_TOKEN", communityToken);
  vi.stubEnv("OPERATOR_AI_BASE_TOKEN", baseToken);
  // Never the Owner's: an AI write that fell back to it would be labelled owner.
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

/** Every label a write left on the rows it touched, whichever table holds it. */
const labelsOf = async (
  statements: readonly (readonly [string, readonly unknown[]])[],
): Promise<string[]> => {
  const found: string[] = [];
  for (const [statement, values] of statements)
    for (const row of await rows<{ label: string }>(statement, values))
      found.push(row.label);
  return found;
};
const contentEvents = (id: string): readonly [string, readonly unknown[]] => [
  "SELECT operator_label AS label FROM community.content_operator_events WHERE content_id=$1",
  [id],
];
const moderationEvents = (
  id: string,
): readonly [string, readonly unknown[]] => [
  "SELECT operator_label AS label FROM community.moderation_events WHERE subject_id=$1",
  [id],
];
const staffDecisions = (id: string): readonly [string, readonly unknown[]] => [
  `SELECT d.operator_label AS label FROM community.report_decisions d
   JOIN community.report_cases c ON c.id=d.case_id WHERE c.target_id=$1 AND c.kind='moderation'
   UNION ALL
   SELECT a.operator_label FROM community.report_audit a
   JOIN community.report_cases c ON c.id=a.case_id WHERE c.target_id=$1 AND c.kind='moderation'`,
  [id],
];
const caseAudit = (id: string): readonly [string, readonly unknown[]] => [
  `SELECT operator_label AS label FROM community.report_audit WHERE case_id=$1
   UNION ALL SELECT operator_label FROM community.report_decisions WHERE case_id=$1`,
  [id],
];

/**
 * One case per registry write: the call, and where its label lands. The test below
 * walks the registry, so a new write with no row here fails it.
 */
const LABEL_CASES: Readonly<
  Record<
    string,
    () => Promise<{
      readonly answer: Json;
      readonly statements: readonly (readonly [string, readonly unknown[]])[];
      readonly minimum: number;
    }>
  >
> = {
  "community.moderate-comment": async () => {
    const author = await newUser();
    const work = await newWork(await newUser());
    const comment = await newComment(work, author);
    return {
      answer: await execute("community.moderate-comment", {
        id: comment,
        action: "hide",
        reason: REASON,
      }),
      statements: [
        moderationEvents(comment),
        staffDecisions(comment),
        [
          "SELECT moderated_by AS label FROM community.catalog_comments WHERE id=$1",
          [comment],
        ],
      ],
      minimum: 4,
    };
  },
  "community.moderate-user": async () => {
    const user = await newUser();
    return {
      answer: await execute("community.moderate-user", {
        id: user,
        action: "suspend",
        reason: REASON,
      }),
      statements: [moderationEvents(user), staffDecisions(user)],
      minimum: 3,
    };
  },
  "community.moderate-work": async () => {
    const work = await newWork(await newUser());
    return {
      answer: await execute("community.moderate-work", {
        id: work,
        state: "hidden",
        expectedVersion: await versionOfWork(work),
        reason: REASON,
      }),
      statements: [contentEvents(work), staffDecisions(work)],
      minimum: 3,
    };
  },
  "community.moderate-work-submission": async () => {
    const author = await newUser();
    const work = await newWork(author);
    const revision = await newPendingRevision(work, author);
    return {
      answer: await execute("community.moderate-work-submission", {
        id: revision,
        action: "reject",
        expectedVersion: await versionOfRevision(revision),
        reason: REASON,
      }),
      statements: [
        contentEvents(revision),
        staffDecisions(work),
        [
          "SELECT decided_by AS label FROM community.work_revisions WHERE id=$1",
          [revision],
        ],
      ],
      minimum: 4,
    };
  },
  "community.moderate-article-submission": async () => {
    const article = await newPendingArticle(await newUser());
    return {
      answer: await execute("community.moderate-article-submission", {
        id: article,
        expectedVersion: 2,
        candidateVersion: 1,
        fingerprint: ARTICLE_FINGERPRINT,
        action: "reject",
        reason: REASON,
      }),
      statements: [contentEvents(article), staffDecisions(article)],
      minimum: 3,
    };
  },
  "community.decide-report": async () => {
    const report = await newStandardReport(
      await newWork(await newUser()),
      await newUser(),
    );
    return {
      answer: await execute("community.decide-report", {
        id: report,
        expectedVersion: await versionOfReport(report),
        action: "retain",
        reason: REASON,
      }),
      statements: [caseAudit(report)],
      minimum: 2,
    };
  },
  "community.review-report": async () => {
    const author = await newUser();
    const report = await newStandardReport(
      await newWork(author),
      await newUser(),
    );
    await decideAs(report, "hide", "owner");
    await appealAs(author, report);
    return {
      answer: await execute("community.review-report", {
        id: report,
        expectedVersion: await versionOfReport(report),
        outcome: "uphold",
        reason: REASON,
      }),
      statements: [
        [
          "SELECT operator_label AS label FROM community.report_audit WHERE case_id=$1 AND action='uphold'",
          [report],
        ],
      ],
      minimum: 1,
    };
  },
  "community.set-report-metadata": async () => {
    const report = await newStandardReport(
      await newWork(await newUser()),
      await newUser(),
    );
    return {
      answer: await execute("community.set-report-metadata", {
        id: report,
        expectedVersion: await versionOfReport(report),
        status: "reviewing",
      }),
      statements: [caseAudit(report)],
      minimum: 1,
    };
  },
  "community.recommend-user": async () => {
    const user = await newUser();
    return {
      answer: await execute("community.recommend-user", {
        id: user,
        enabled: true,
        expectedVersion: 0,
      }),
      statements: [contentEvents(user)],
      minimum: 1,
    };
  },
  "community.set-featured": async () => {
    const work = await newWork(await newUser());
    return {
      answer: await execute("community.set-featured", {
        target: { type: "work", id: work },
        enabled: true,
        position: 1,
        expectedVersion: 0,
      }),
      statements: [contentEvents(work)],
      minimum: 1,
    };
  },
  "community.set-featured-quantity": async () => {
    const { version } = await one(
      "SELECT version FROM community.featured_settings WHERE id=TRUE",
    );
    return {
      answer: await execute("community.set-featured-quantity", {
        enabledQuantity: 5,
        expectedVersion: Number(version),
      }),
      statements: [
        [
          "SELECT operator_label AS label FROM community.content_operator_events WHERE action='featured.quantity'",
          [],
        ],
      ],
      minimum: 1,
    };
  },
  "community.create-thread": async () => {
    const answer = await execute("community.create-thread", {
      title: `Thread ${run}`,
    });
    const id = String(answer.data.applied[0]);
    return {
      answer,
      statements: [
        contentEvents(id),
        ["SELECT created_by AS label FROM community.threads WHERE id=$1", [id]],
      ],
      minimum: 2,
    };
  },
  "community.update-thread": async () => {
    const id = opaque("thread");
    await setup.query(
      "INSERT INTO community.threads(id,title,description,tags,created_by) VALUES($1,$2,'','{}','owner')",
      [id, `Thread ${run}`],
    );
    return {
      answer: await execute("community.update-thread", {
        id,
        expectedVersion: 1,
        status: "closed",
      }),
      statements: [contentEvents(id)],
      minimum: 1,
    };
  },
  "community.set-policy": async () => {
    const { policy } = await one(
      "SELECT policy FROM community.publication_setting",
    );
    return {
      answer: await execute("community.set-policy", {
        policy:
          policy === "PRE_MODERATION" ? "DIRECT_PUBLICATION" : "PRE_MODERATION",
      }),
      statements: [
        ["SELECT updated_by AS label FROM community.publication_setting", []],
        [
          "SELECT operator_label AS label FROM community.moderation_events WHERE action='set_publication_policy'",
          [],
        ],
      ],
      minimum: 2,
    };
  },
  "community.set-work-publishing-settings": async () => {
    const settings = (await read({ op: "list.work_settings" })).data as Json;
    return {
      answer: await execute("community.set-work-publishing-settings", {
        ...without(settings, ["updatedAt", "updatedBy", "version"]),
        expectedVersion: settings.version,
      }),
      statements: [
        [
          "SELECT updated_by AS label FROM community.work_publishing_settings",
          [],
        ],
      ],
      minimum: 1,
    };
  },
  "community.set-account-capacity": async () => {
    const user = await newUser();
    return {
      answer: await execute("community.set-account-capacity", {
        accountId: user,
        capacityClass: "owner",
        expectedVersion: 0,
      }),
      statements: [contentEvents(user)],
      minimum: 1,
    };
  },
  "community.retry-publishing-job": async () => {
    const job = opaque("publishing-job");
    await setup.query(
      "INSERT INTO community.publishing_jobs(id,kind,subject_id,state,run_after) VALUES($1,'publish_media',$2,'failed',CURRENT_TIMESTAMP)",
      [job, opaque("media-item")],
    );
    return {
      answer: await execute("community.retry-publishing-job", { id: job }),
      statements: [contentEvents(job)],
      minimum: 1,
    };
  },
};

describe("every registry write", () => {
  const WRITES = ADMIN_OP_NAMES.filter(
    (name) =>
      name.startsWith("community.") &&
      adminOpMeta[name].tool === "admin_execute",
  );

  it("has its case below: a new write with none fails here", () => {
    expect(Object.keys(LABEL_CASES).sort()).toEqual([...WRITES].sort());
  });

  it.each(WRITES)("%s records ai-admin on the real Backend", async (op) => {
    const { answer, statements, minimum } = await LABEL_CASES[op]!();
    expect(
      committedIds(answer),
      JSON.stringify(answer).slice(0, 400),
    ).toHaveLength(1);
    const labels = await labelsOf(statements);
    expect(labels.length, op).toBeGreaterThanOrEqual(minimum);
    expect(new Set(labels), op).toEqual(new Set([AI]));
  });

  it("answers each read key with the tool's absence, and takes no write from it", async () => {
    const { tools } = await readClient.listTools();
    expect(tools.map(({ name }) => name)).not.toContain("admin_execute");
    const user = await newUser();
    await expect(
      readClient.callTool({
        name: "admin_execute",
        arguments: {
          requestId: randomUUID(),
          op: "community.moderate-user",
          input: { id: user, action: "suspend", reason: REASON },
        },
      }),
    ).rejects.toThrow(/Tool not found/u);
    expect(
      (
        await one("SELECT status FROM community.public_users WHERE id=$1", [
          user,
        ])
      ).status,
    ).toBe("active");
  });

  it("answers AI_CREDENTIAL_NOT_CONFIGURED with its token absent, and never uses the Owner's", async () => {
    const user = await newUser();
    vi.stubEnv("COMMUNITY_OPERATOR_AI_TOKEN", "");
    vi.stubEnv("COMMUNITY_OPERATOR_TOKEN", ownerToken);
    expect(
      await execute("community.moderate-user", {
        id: user,
        action: "suspend",
        reason: REASON,
      }),
    ).toMatchObject({ ok: false, code: "AI_CREDENTIAL_NOT_CONFIGURED" });
    expect(
      (
        await one("SELECT status FROM community.public_users WHERE id=$1", [
          user,
        ])
      ).status,
    ).toBe("active");
  });

  it("refuses a client's own key: requestId is the call's, and the op leaves it out", async () => {
    const work = await newWork(await newUser());
    const answer = await execute("community.moderate-work", {
      id: work,
      requestId: randomUUID(),
      state: "hidden",
      expectedVersion: await versionOfWork(work),
      reason: REASON,
    });
    expect(answer).toMatchObject({ ok: false, code: "INPUT_INVALID" });
    expect(
      (
        await one("SELECT operator_state FROM community.works WHERE id=$1", [
          work,
        ])
      ).operator_state,
    ).toBe("visible");
  });

  it("names a refused reason before any call, on every moderation", async () => {
    for (const [op, input] of [
      ["community.moderate-comment", { id: opaque("comment"), action: "hide" }],
      ["community.moderate-user", { id: opaque("user"), action: "suspend" }],
      [
        "community.moderate-work",
        { id: opaque("work"), state: "hidden", expectedVersion: 1 },
      ],
    ] as const)
      expect(await execute(op, input), op).toMatchObject({
        ok: false,
        code: "INPUT_INVALID",
      });
  });

  it("marks a person's words, and leaves the audit ledger free of them", async () => {
    const work = await newWork(await newUser(), `Title ${HOSTILE}`);
    const requestId = randomUUID();
    const answer = await execute(
      "community.moderate-work",
      {
        id: work,
        state: "hidden",
        expectedVersion: await versionOfWork(work),
        reason: `Reason ${HOSTILE}`,
      },
      requestId,
    );
    expect(answer.data.results[0].title).toContain(HOSTILE);
    expect(answer.untrusted).toContain("/data/results/*/title");
    const { drizzle } = payload.db as unknown as Pick<
      PostgresAdapter,
      "drizzle"
    >;
    const { rows: audit } = await drizzle.execute(
      sql`SELECT * FROM mcp_audit_events WHERE request_id = ${requestId} AND key_id = ${String(keyId)}`,
    );
    expect(audit.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit)).not.toContain(HOSTILE);
    expect(audit.some((row) => row.target_id === work)).toBe(true);
  });
});

/**
 * What the Owner's own route leaves, beside what AI's leaves, with the ids taken out:
 * only the label may differ.
 */
const caseOf = async (subject: string) => {
  const found = await rows(
    `SELECT c.id AS case_id,c.kind,c.status,c.reason,c.description,c.reporter_id,c.target_type,c.affected_user_id,
       d.id AS decision_id,d.action,d.reason AS decision_reason,d.operator_label,d.reversed_at,
       a.action AS audit_action,a.reason AS audit_reason,a.operator_label AS audit_label
     FROM community.report_cases c
     JOIN community.report_decisions d ON d.id=c.decision_id
     JOIN community.report_audit a ON a.case_id=c.id
     WHERE c.target_id=$1 AND c.kind='moderation' ORDER BY c.created_at DESC`,
    [subject],
  );
  expect(found, subject).toHaveLength(1);
  const row = found[0]!;
  const messages = await rows(
    "SELECT recipient_id,kind,text FROM community.report_messages WHERE case_id=$1",
    [row.case_id],
  );
  return { row, messages };
};
const comparable = ({ row, messages }: Awaited<ReturnType<typeof caseOf>>) => ({
  ...without(row, [
    "case_id",
    "decision_id",
    "operator_label",
    "audit_label",
    "affected_user_id",
  ]),
  messages: messages.map(({ kind, text }) => ({ kind, text })),
});

describe("a reason on the AI path", () => {
  const SUBJECTS: Readonly<
    Record<
      string,
      () => Promise<{
        readonly ai: () => Promise<Json>;
        readonly human: () => Promise<{ status: number }>;
        readonly aiSubject: string;
        readonly humanSubject: string;
        readonly author: string;
      }>
    >
  > = {
    comment: async () => {
      const author = await newUser();
      const work = await newWork(await newUser());
      const [aiComment, humanComment] = [
        await newComment(work, author),
        await newComment(work, author),
      ];
      return {
        aiSubject: aiComment,
        humanSubject: humanComment,
        author,
        ai: () =>
          execute("community.moderate-comment", {
            id: aiComment,
            action: "hide",
            reason: REASON,
          }),
        human: () =>
          owner("POST", `comments/${humanComment}/moderation`, {
            action: "hide",
            reason: REASON,
          }),
      };
    },
    work: async () => {
      const author = await newUser();
      const [aiWork, humanWork] = [
        await newWork(author),
        await newWork(author),
      ];
      return {
        aiSubject: aiWork,
        humanSubject: humanWork,
        author,
        ai: async () =>
          execute("community.moderate-work", {
            id: aiWork,
            state: "hidden",
            expectedVersion: await versionOfWork(aiWork),
            reason: REASON,
          }),
        human: async () =>
          owner("POST", `works/${humanWork}/moderation`, {
            requestId: randomUUID(),
            state: "hidden",
            expectedVersion: await versionOfWork(humanWork),
            reason: REASON,
          }),
      };
    },
    user: async () => {
      const [aiUser, humanUser] = [await newUser(), await newUser()];
      return {
        aiSubject: aiUser,
        humanSubject: humanUser,
        author: aiUser,
        ai: () =>
          execute("community.moderate-user", {
            id: aiUser,
            action: "suspend",
            reason: REASON,
          }),
        human: () =>
          owner("POST", `users/${humanUser}/status`, {
            action: "suspend",
            reason: REASON,
          }),
      };
    },
    article: async () => {
      const author = await newUser();
      const [aiArticle, humanArticle] = [
        await newPendingArticle(author),
        await newPendingArticle(author),
      ];
      const command = {
        expectedVersion: 2,
        candidateVersion: 1,
        fingerprint: ARTICLE_FINGERPRINT,
        action: "reject",
        reason: REASON,
      };
      return {
        aiSubject: aiArticle,
        humanSubject: humanArticle,
        author,
        ai: () =>
          execute("community.moderate-article-submission", {
            id: aiArticle,
            ...command,
          }),
        human: () =>
          owner("POST", `articles/${humanArticle}/moderation`, {
            requestId: randomUUID(),
            ...command,
          }),
      };
    },
    submission: async () => {
      const author = await newUser();
      const [aiWork, humanWork] = [
        await newWork(author),
        await newWork(author),
      ];
      const [aiRevision, humanRevision] = [
        await newPendingRevision(aiWork, author),
        await newPendingRevision(humanWork, author),
      ];
      return {
        aiSubject: aiWork,
        humanSubject: humanWork,
        author,
        ai: async () =>
          execute("community.moderate-work-submission", {
            id: aiRevision,
            action: "reject",
            expectedVersion: await versionOfRevision(aiRevision),
            reason: REASON,
          }),
        human: async () =>
          owner("POST", `publishing/submissions/${humanRevision}/moderation`, {
            requestId: randomUUID(),
            action: "reject",
            expectedVersion: await versionOfRevision(humanRevision),
            reason: REASON,
          }),
      };
    },
  };

  it.each(Object.keys(SUBJECTS))(
    "gives a %s the case, message and appeal path the human route gives",
    async (kind) => {
      const { ai, human, aiSubject, humanSubject, author } =
        await SUBJECTS[kind]!();
      const answer = await ai();
      expect(answer.data.moderationCases).toBe(1);
      expect((await human()).status).toBe(200);
      const [aiCase, humanCase] = [
        await caseOf(aiSubject),
        await caseOf(humanSubject),
      ];
      expect(comparable(aiCase)).toEqual(comparable(humanCase));
      expect(aiCase.row).toMatchObject({
        kind: "moderation",
        status: "resolved",
        reporter_id: null,
        decision_reason: REASON,
        audit_reason: REASON,
        operator_label: AI,
        audit_label: AI,
      });
      expect(humanCase.row).toMatchObject({
        operator_label: "owner",
        audit_label: "owner",
      });
      // The person it affects is told, with the reason and where to appeal.
      expect(aiCase.messages).toHaveLength(1);
      expect(aiCase.messages[0]).toMatchObject({
        recipient_id: author,
        kind: "result",
      });
      expect(aiCase.messages[0]!.text).toContain(REASON);
      expect(aiCase.messages[0]!.text).toContain("可在举报与申诉中申请复核");
      const { items } = await reporting.decisions(author, 1, 20);
      expect(
        items.some(({ decision }) => decision?.id === aiCase.row.decision_id),
      ).toBe(true);
      await reporting.appeal(author, aiCase.row.decision_id, {
        text: `Appeal ${run}`,
        requestId: randomUUID(),
      });
      expect(
        (
          await one("SELECT status FROM community.report_cases WHERE id=$1", [
            aiCase.row.case_id,
          ])
        ).status,
      ).toBe("appealed");
    },
  );

  it("counts the cases it opened, and a replay opens none", async () => {
    const author = await newUser();
    const work = await newWork(await newUser());
    const targets = [
      { id: await newComment(work, author) },
      { id: await newComment(work, author) },
      { id: await newComment(work, author) },
    ];
    const requestId = randomUUID();
    const input = { action: "hide", reason: REASON };
    const first = await executeAll(
      "community.moderate-comment",
      input,
      targets,
      requestId,
    );
    expect(first).toMatchObject({ ok: true, code: "OK" });
    expect(first.data.moderationCases).toBe(3);
    const replay = await executeAll(
      "community.moderate-comment",
      input,
      targets,
      requestId,
    );
    expect(replay.ok).toBe(true);
    expect(replay.data.moderationCases).toBeUndefined();
    expect(replay.data.already_applied).toEqual(targets.map(({ id }) => id));
    expect(replay.meta.replayed).toBe(true);
    for (const { id } of targets)
      expect(
        await countOf("community.report_cases", "target_id=$1", [id]),
      ).toBe(1);
  });
});

describe("a lost answer, retried with the same requestId", () => {
  /** The first answer is lost after the Backend committed it. */
  const loseThenRetry = async (op: string, input: Json) => {
    const requestId = randomUUID();
    const lost = await withLostWrite(() => execute(op, input, requestId));
    expect(lost, op).toMatchObject({
      ok: false,
      code: "OUTCOME_UNKNOWN",
      retryable: true,
    });
    expect(lost.next.args.requestId).toBe(requestId);
    const retried = await execute(op, input, requestId);
    expect(
      committedIds(retried),
      JSON.stringify(retried).slice(0, 300),
    ).toEqual([input.id ?? input.accountId]);
    return retried;
  };

  it("applies a comment's moderation once, through its receipt header", async () => {
    const author = await newUser();
    const comment = await newComment(await newWork(await newUser()), author);
    const retried = await loseThenRetry("community.moderate-comment", {
      id: comment,
      action: "hide",
      reason: REASON,
    });
    expect(retried.data.already_applied).toEqual([comment]);
    expect(retried.meta.replayed).toBe(true);
    expect(
      await countOf(
        "community.moderation_events",
        "subject_id=$1 AND action='hide'",
        [comment],
      ),
    ).toBe(1);
    expect(
      await countOf("community.report_cases", "target_id=$1", [comment]),
    ).toBe(1);
  });

  it("applies a work's moderation once, through its receipt", async () => {
    const work = await newWork(await newUser());
    const retried = await loseThenRetry("community.moderate-work", {
      id: work,
      state: "hidden",
      expectedVersion: await versionOfWork(work),
      reason: REASON,
    });
    expect(retried.meta.replayed).toBe(true);
    expect(
      await countOf(
        "community.content_operator_events",
        "content_id=$1 AND action='work.moderate'",
        [work],
      ),
    ).toBe(1);
    expect(
      await countOf("community.report_cases", "target_id=$1", [work]),
    ).toBe(1);
  });

  it("applies a decision once: the version moved, and the record shows this one", async () => {
    const author = await newUser();
    const report = await newStandardReport(
      await newWork(author),
      await newUser(),
    );
    const messagesBefore = await countOf(
      "community.report_messages",
      "case_id=$1",
      [report],
    );
    const retried = await loseThenRetry("community.decide-report", {
      id: report,
      expectedVersion: await versionOfReport(report),
      action: "retain",
      reason: REASON,
    });
    expect(retried.data.results[0].decision.action).toBe("retain");
    expect(retried.meta.replayed).toBe(true);
    expect(
      await countOf("community.report_decisions", "case_id=$1", [report]),
    ).toBe(1);
    expect(
      await countOf(
        "community.report_audit",
        "case_id=$1 AND action='retain'",
        [report],
      ),
    ).toBe(1);
    expect(
      await countOf("community.report_messages", "case_id=$1", [report]),
    ).toBe(messagesBefore + 2);
  });

  it("applies a review once", async () => {
    const author = await newUser();
    const report = await newStandardReport(
      await newWork(author),
      await newUser(),
    );
    await decideAs(report, "hide");
    await appealAs(author, report);
    await loseThenRetry("community.review-report", {
      id: report,
      expectedVersion: await versionOfReport(report),
      outcome: "overturn",
      reason: REASON,
    });
    expect(
      await countOf(
        "community.report_audit",
        "case_id=$1 AND action='overturn'",
        [report],
      ),
    ).toBe(1);
  });

  it("applies metadata once, by the command its audit row holds", async () => {
    const report = await newStandardReport(
      await newWork(await newUser()),
      await newUser(),
    );
    await loseThenRetry("community.set-report-metadata", {
      id: report,
      expectedVersion: await versionOfReport(report),
      urgent: true,
    });
    expect(
      await countOf(
        "community.report_audit",
        "case_id=$1 AND action='metadata'",
        [report],
      ),
    ).toBe(1);
    expect(
      await countOf("community.report_urgent_outbox", "case_id=$1", [report]),
    ).toBe(1);
  });

  it("applies a suspension once, through its receipt", async () => {
    const user = await newUser();
    const retried = await loseThenRetry("community.moderate-user", {
      id: user,
      action: "suspend",
      reason: REASON,
    });
    expect(retried.meta.replayed).toBe(true);
    expect(retried.data.moderationCases).toBeUndefined();
    expect(
      await countOf("community.report_cases", "target_id=$1", [user]),
    ).toBe(1);
    expect(
      await countOf(
        "community.moderation_events",
        "subject_id=$1 AND action='suspend'",
        [user],
      ),
    ).toBe(1);
  });

  /** One command per write with a receipt, each on a subject of its own. */
  const RECEIPTED: Readonly<Record<string, () => Promise<Json>>> = {
    "community.recommend-user": async () => ({
      id: await newUser(),
      enabled: true,
      expectedVersion: 0,
    }),
    "community.set-featured": async () => ({
      target: { type: "work", id: await newWork(await newUser()) },
      enabled: true,
      position: 1,
      expectedVersion: 0,
    }),
    "community.set-featured-quantity": async () => ({
      enabledQuantity: 7,
      expectedVersion: Number(
        (
          await one(
            "SELECT version FROM community.featured_settings WHERE id=TRUE",
          )
        ).version,
      ),
    }),
    "community.create-thread": async () => ({ title: `Once ${run}` }),
    "community.update-thread": async () => {
      const id = opaque("thread");
      await setup.query(
        "INSERT INTO community.threads(id,title,description,tags,created_by) VALUES($1,$2,'','{}','owner')",
        [id, `Thread ${run}`],
      );
      return { id, expectedVersion: 1, status: "closed" };
    },
    "community.set-work-publishing-settings": async () => {
      const { data } = await read({ op: "list.work_settings" });
      return {
        ...without(data, ["updatedAt", "updatedBy", "version"]),
        expectedVersion: data.version,
      };
    },
    "community.set-account-capacity": async () => ({
      accountId: await newUser(),
      capacityClass: "owner",
      expectedVersion: 0,
    }),
    "community.retry-publishing-job": async () => {
      const id = opaque("publishing-job");
      await setup.query(
        "INSERT INTO community.publishing_jobs(id,kind,subject_id,state,run_after) VALUES($1,'publish_media',$2,'failed',CURRENT_TIMESTAMP)",
        [id, opaque("media-item")],
      );
      return { id };
    },
    "community.moderate-work-submission": async () => {
      const author = await newUser();
      const id = await newPendingRevision(await newWork(author), author);
      return {
        id,
        action: "reject",
        expectedVersion: await versionOfRevision(id),
        reason: REASON,
      };
    },
    "community.moderate-article-submission": async () => ({
      id: await newPendingArticle(await newUser()),
      expectedVersion: 2,
      candidateVersion: 1,
      fingerprint: ARTICLE_FINGERPRINT,
      action: "reject",
      reason: REASON,
    }),
  };

  it("has a case here for every write: a new one with none fails", () => {
    expect(
      [
        // Each of these has a test of its own above and below.
        "community.moderate-comment",
        "community.moderate-work",
        "community.decide-report",
        "community.review-report",
        "community.set-report-metadata",
        "community.moderate-user",
        "community.set-policy",
        ...Object.keys(RECEIPTED),
      ].sort(),
    ).toEqual(
      ADMIN_OP_NAMES.filter(
        (name) =>
          name.startsWith("community.") &&
          adminOpMeta[name].tool === "admin_execute",
      ).sort(),
    );
  });

  it.each(Object.keys(RECEIPTED))(
    "applies %s once, through its receipt, and reads its replay",
    async (op) => {
      const input = await RECEIPTED[op]!();
      const eventsBefore = await countOf(
        "community.content_operator_events",
        "TRUE",
        [],
      );
      const requestId = randomUUID();
      const lost = await withLostWrite(() => execute(op, input, requestId));
      expect(lost).toMatchObject({ ok: false, code: "OUTCOME_UNKNOWN" });
      const retried = await execute(op, input, requestId);
      expect(retried.meta.replayed, JSON.stringify(retried).slice(0, 300)).toBe(
        true,
      );
      expect(committedIds(retried)).toHaveLength(1);
      expect(
        await countOf("community.content_operator_events", "TRUE", []),
      ).toBe(eventsBefore + 1);
    },
  );

  const policyNow = async () =>
    String(
      (await one("SELECT policy FROM community.publication_setting")).policy,
    );
  const otherPolicy = (policy: string) =>
    policy === "PRE_MODERATION" ? "DIRECT_PUBLICATION" : "PRE_MODERATION";
  const policyEvents = () =>
    countOf(
      "community.moderation_events",
      "action='set_publication_policy'",
      [],
    );

  it("applies a policy change once, through its receipt", async () => {
    const eventsBefore = await policyEvents();
    const input = { policy: otherPolicy(await policyNow()) };
    const requestId = randomUUID();
    const lost = await withLostWrite(() =>
      execute("community.set-policy", input, requestId),
    );
    expect(lost).toMatchObject({ ok: false, code: "OUTCOME_UNKNOWN" });
    const retried = await execute("community.set-policy", input, requestId);
    expect(retried).toMatchObject({
      ok: true,
      code: "OK",
      meta: { replayed: true },
    });
    expect(retried.data.already_applied).toHaveLength(1);
    expect(retried.data.results[0]).toMatchObject({
      state: input.policy,
      updatedBy: AI,
    });
    expect(await policyEvents()).toBe(eventsBefore + 1);
  });

  it("keeps the Owner's mode when a lost policy change is retried", async () => {
    const before = await policyNow();
    const input = { policy: otherPolicy(before) };
    const requestId = randomUUID();
    await withLostWrite(() =>
      execute("community.set-policy", input, requestId),
    );
    expect(
      (await owner("PUT", "publication-policy", { policy: before })).status,
    ).toBe(200);
    const eventsBefore = await policyEvents();
    expect(
      await execute("community.set-policy", input, requestId),
    ).toMatchObject({ ok: true, meta: { replayed: true } });
    expect(await policyNow()).toBe(before);
    expect(await policyEvents()).toBe(eventsBefore);
  });

  it("keeps a receipt when the mode was already in force, so a repeat cannot move it later", async () => {
    const before = await policyNow();
    const requestId = randomUUID();
    const first = await execute(
      "community.set-policy",
      { policy: before },
      requestId,
    );
    expect(first).toMatchObject({ ok: true });
    expect(first.data.already_applied).toHaveLength(1);
    expect(first.meta.replayed).toBeUndefined();
    const other = otherPolicy(before);
    expect(
      (await owner("PUT", "publication-policy", { policy: other })).status,
    ).toBe(200);
    expect(
      await execute("community.set-policy", { policy: before }, requestId),
    ).toMatchObject({ ok: true, meta: { replayed: true } });
    expect(await policyNow()).toBe(other);
    expect(
      await execute("community.set-policy", { policy: other }, requestId),
    ).toMatchObject({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
    expect(
      (await owner("PUT", "publication-policy", { policy: before })).status,
    ).toBe(200);
  });

  it("answers another command on a suspension's key as IDEMPOTENCY_CONFLICT, with no second effect", async () => {
    const user = await newUser();
    const requestId = randomUUID();
    const input = { id: user, action: "suspend", reason: REASON };
    await execute("community.moderate-user", input, requestId);
    expect(
      await execute(
        "community.moderate-user",
        { ...input, reason: "Another reason" },
        requestId,
      ),
    ).toMatchObject({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
    expect(
      await execute(
        "community.moderate-user",
        { ...input, action: "reinstate" },
        requestId,
      ),
    ).toMatchObject({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
    expect(
      await execute(
        "community.moderate-user",
        { ...input, id: await newUser() },
        requestId,
      ),
    ).toMatchObject({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
    expect(
      (
        await one("SELECT status FROM community.public_users WHERE id=$1", [
          user,
        ])
      ).status,
    ).toBe("suspended");
  });

  it("refuses an AI suspension or policy change with no key at all, on the Backend itself", async () => {
    const user = await newUser();
    const before = await policyNow();
    const post = (method: string, route: string, body: Json) =>
      fetch(`${backendOrigin}internal/community/${route}`, {
        method,
        headers: {
          authorization: `Bearer ${communityToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    expect(
      (
        await post("POST", `users/${user}/status`, {
          action: "suspend",
          reason: REASON,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post("PUT", "publication-policy", {
          policy: otherPolicy(before),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await one("SELECT status FROM community.public_users WHERE id=$1", [
          user,
        ])
      ).status,
    ).toBe("active");
    expect(await policyNow()).toBe(before);
    // The Owner's routes have never taken one, and answer as they did.
    const { status, body } = await owner("POST", `users/${user}/status`, {
      action: "suspend",
      reason: REASON,
    });
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual([
      "id",
      "revokedSessions",
      "status",
    ]);
  });

  it("answers a stale decision someone else made as a conflict, and never as done", async () => {
    const report = await newStandardReport(
      await newWork(await newUser()),
      await newUser(),
    );
    const stale = await versionOfReport(report);
    await decideAs(report, "retain", "owner");
    const answer = await execute("community.decide-report", {
      id: report,
      expectedVersion: stale,
      action: "retain",
      reason: REASON,
    });
    expect(answer).toMatchObject({ ok: false, code: "STATE_CONFLICT" });
    expect(answer.data.conflict[0].id).toBe(report);
    expect(
      await countOf("community.report_decisions", "case_id=$1", [report]),
    ).toBe(1);
  });

  it("does not read a same-worded AI decision that was overturned as done", async () => {
    const author = await newUser();
    const report = await newStandardReport(
      await newWork(author),
      await newUser(),
    );
    const stale = await versionOfReport(report);
    await decideAs(report, "hide");
    await appealAs(author, report);
    expect(
      committedIds(
        await execute("community.review-report", {
          id: report,
          expectedVersion: await versionOfReport(report),
          outcome: "overturn",
          reason: "Corrected",
        }),
      ),
    ).toEqual([report]);
    expect(
      await execute("community.decide-report", {
        id: report,
        expectedVersion: stale,
        action: "hide",
        reason: REASON,
      }),
    ).toMatchObject({ ok: false, code: "STATE_CONFLICT" });
  });

  it("says unknown when the read that would tell cannot be read", async () => {
    const report = await newStandardReport(
      await newWork(await newUser()),
      await newUser(),
    );
    const answer = await withStubBackend(
      (request, response) => {
        if (request.method === "POST") {
          response.writeHead(409, { "content-type": "application/json" });
          response.end(
            JSON.stringify({ error: { status: 409, code: "STATE_CONFLICT" } }),
          );
          return;
        }
        response.destroy();
      },
      () =>
        execute("community.decide-report", {
          id: report,
          expectedVersion: 1,
          action: "retain",
          reason: REASON,
        }),
    );
    expect(answer).toMatchObject({ ok: false, code: "OUTCOME_UNKNOWN" });
  });

  it("answers the same key on another command as IDEMPOTENCY_CONFLICT, with no second effect", async () => {
    const author = await newUser();
    const comment = await newComment(await newWork(await newUser()), author);
    const requestId = randomUUID();
    const input = { id: comment, action: "hide", reason: REASON };
    expect(
      await execute("community.moderate-comment", input, requestId),
    ).toMatchObject({ ok: true });
    const changed = await execute(
      "community.moderate-comment",
      { ...input, reason: "Another reason" },
      requestId,
    );
    expect(changed).toMatchObject({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
    expect(
      await countOf("community.report_cases", "target_id=$1", [comment]),
    ).toBe(1);

    const work = await newWork(await newUser());
    const workRequest = randomUUID();
    const workInput = {
      id: work,
      state: "hidden",
      expectedVersion: await versionOfWork(work),
      reason: REASON,
    };
    expect(
      committedIds(
        await execute("community.moderate-work", workInput, workRequest),
      ),
    ).toEqual([work]);
    expect(
      await execute(
        "community.moderate-work",
        { ...workInput, state: "removed" },
        workRequest,
      ),
    ).toMatchObject({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
    expect(
      (
        await one("SELECT operator_state FROM community.works WHERE id=$1", [
          work,
        ])
      ).operator_state,
    ).toBe("hidden");
  });

  it("refuses an AI comment write with no key at all, on the Backend itself", async () => {
    const author = await newUser();
    const comment = await newComment(await newWork(await newUser()), author);
    const post = (headers: Record<string, string>) =>
      fetch(
        `${backendOrigin}internal/community/comments/${comment}/moderation`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${communityToken}`,
            "content-type": "application/json",
            ...headers,
          },
          body: JSON.stringify({ action: "hide", reason: REASON }),
        },
      );
    expect((await post({})).status).toBe(400);
    expect(
      (await post({ [AI_OPERATOR_REQUEST_ID_HEADER]: "not-a-uuid" })).status,
    ).toBe(400);
    expect(
      (
        await one(
          "SELECT moderation FROM community.catalog_comments WHERE id=$1",
          [comment],
        )
      ).moderation,
    ).toBe("visible");
    // The Owner's route has never taken one, and answers as it did.
    const { status, body } = await owner(
      "POST",
      `comments/${comment}/moderation`,
      { action: "hide", reason: REASON },
    );
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(["id", "moderation"]);
  });
});

describe("a self-only work, and everything under it", () => {
  const selfOnlyFixture = async () => {
    const author = await newUser();
    const reporter = await newUser();
    const work = await newWork(author);
    const revision = await newPendingRevision(work, author);
    const comment = await newComment(work, reporter);
    const reply = await newReply(comment, author);
    const workReport = await newStandardReport(work, reporter);
    const commentReport = await newCommentReport(comment, reporter);
    const replyReport = await newCommentReport(reply, author);
    const workVersion = await versionOfWork(work);
    const revisionVersion = await versionOfRevision(revision);
    const reportVersion = await versionOfReport(workReport);
    await makeSelfOnly(work);
    return {
      author,
      work,
      revision,
      comment,
      reply,
      workReport,
      commentReport,
      replyReport,
      workVersion,
      revisionVersion,
      reportVersion,
    };
  };

  it("answers SELF_ONLY_OWNER_REVIEW on every write, and changes nothing", async () => {
    const fixture = await selfOnlyFixture();
    const before = {
      events: await countOf("community.content_operator_events", "TRUE", []),
      moderation: await countOf("community.moderation_events", "TRUE", []),
      decisions: await countOf("community.report_decisions", "TRUE", []),
      audit: await countOf("community.report_audit", "TRUE", []),
    };
    const reported = async (id: string) => ({
      id,
      expectedVersion: await versionOfReport(id),
    });
    const calls: readonly (readonly [string, Json])[] = [
      [
        "community.moderate-work",
        {
          id: fixture.work,
          state: "hidden",
          expectedVersion: fixture.workVersion,
          reason: REASON,
        },
      ],
      [
        "community.moderate-work-submission",
        {
          id: fixture.revision,
          action: "reject",
          expectedVersion: fixture.revisionVersion,
          reason: REASON,
        },
      ],
      [
        "community.moderate-comment",
        { id: fixture.comment, action: "hide", reason: REASON },
      ],
      [
        "community.moderate-comment",
        { id: fixture.reply, action: "hide", reason: REASON },
      ],
      [
        "community.decide-report",
        {
          ...(await reported(fixture.workReport)),
          action: "retain",
          reason: REASON,
        },
      ],
      [
        "community.decide-report",
        {
          ...(await reported(fixture.commentReport)),
          action: "retain",
          reason: REASON,
        },
      ],
      [
        "community.decide-report",
        {
          ...(await reported(fixture.replyReport)),
          action: "retain",
          reason: REASON,
        },
      ],
      [
        "community.review-report",
        {
          ...(await reported(fixture.workReport)),
          outcome: "uphold",
          reason: REASON,
        },
      ],
      [
        "community.set-report-metadata",
        { ...(await reported(fixture.workReport)), urgent: true },
      ],
      [
        "community.set-featured",
        {
          target: { type: "work", id: fixture.work },
          enabled: false,
          position: 1,
          expectedVersion: 0,
        },
      ],
    ];
    for (const [op, input] of calls) {
      const answer = await execute(op, input);
      expect(answer, `${op} ${JSON.stringify(input)}`).toMatchObject({
        ok: false,
        code: "SELF_ONLY_OWNER_REVIEW",
      });
      expect(answer.next).toBeUndefined();
      expect(answer.retryable).toBeUndefined();
    }
    expect({
      events: await countOf("community.content_operator_events", "TRUE", []),
      moderation: await countOf("community.moderation_events", "TRUE", []),
      decisions: await countOf("community.report_decisions", "TRUE", []),
      audit: await countOf("community.report_audit", "TRUE", []),
    }).toEqual(before);
    expect(
      (
        await one("SELECT operator_state FROM community.works WHERE id=$1", [
          fixture.work,
        ])
      ).operator_state,
    ).toBe("visible");
    expect(
      (
        await one(
          "SELECT moderation FROM community.catalog_comments WHERE id=$1",
          [fixture.comment],
        )
      ).moderation,
    ).toBe("visible");
    expect(
      (
        await one(
          "SELECT disposition FROM community.work_revisions WHERE id=$1",
          [fixture.revision],
        )
      ).disposition,
    ).toBe("pending");
  });

  it("offers no write on a case it holds, and offers them on one it does not", async () => {
    const fixture = await selfOnlyFixture();
    const open = await newStandardReport(
      await newWork(await newUser()),
      await newUser(),
    );
    const actionsOf = async (query: string) =>
      (await send(client, "admin_find", { query })).envelope.data.items[0]
        .actions as Json[];
    const opsOf = (actions: readonly Json[]) =>
      actions.flatMap(({ tool, args }) =>
        tool === "admin_execute" ? [args.op] : [],
      );
    expect(opsOf(await actionsOf(open))).toEqual([
      "community.decide-report",
      "community.review-report",
      "community.set-report-metadata",
    ]);
    expect(opsOf(await actionsOf(fixture.workReport))).toEqual([]);
    const reads = await send(readClient, "admin_find", { query: open });
    expect(opsOf(reads.envelope.data.items[0].actions)).toEqual([]);
  });

  it("names the one refused target in a batch, and does the others", async () => {
    const fixture = await selfOnlyFixture();
    const open = await newComment(
      await newWork(await newUser()),
      await newUser(),
    );
    const answer = await executeAll(
      "community.moderate-comment",
      { action: "hide", reason: REASON },
      [{ id: open }, { id: fixture.comment }],
    );
    expect(answer).toMatchObject({ ok: false, code: "PARTIAL" });
    expect(answer.data.applied).toEqual([open]);
    expect(answer.data.failed).toEqual([
      { index: 1, id: fixture.comment, code: "SELF_ONLY_OWNER_REVIEW" },
    ]);
    expect(answer.next).toBeUndefined();
  });

  it("reads current visibility at write time: back to public, the same write goes through", async () => {
    const fixture = await selfOnlyFixture();
    await makePublic(fixture.work);
    const answer = await execute("community.moderate-comment", {
      id: fixture.comment,
      action: "hide",
      reason: REASON,
    });
    expect(answer).toMatchObject({ ok: true });
    await makeSelfOnly(fixture.work);
    expect(
      await execute("community.moderate-comment", {
        id: fixture.comment,
        action: "unhide",
        reason: REASON,
      }),
    ).toMatchObject({ ok: false, code: "SELF_ONLY_OWNER_REVIEW" });
  });

  it("leaves it with the Owner, who handles it as today", async () => {
    const fixture = await selfOnlyFixture();
    expect(
      (
        await owner("POST", `comments/${fixture.comment}/moderation`, {
          action: "hide",
          reason: REASON,
        })
      ).status,
    ).toBe(200);
    const { status, body } = await owner(
      "POST",
      `reports/${fixture.workReport}/decisions`,
      {
        expectedVersion: await versionOfReport(fixture.workReport),
        action: "retain",
        reason: REASON,
      },
    );
    expect(status).toBe(200);
    expect(body.history.at(-1).operator).toBe("owner");
  });

  it("does not hold a work its author deleted: its report and comment stay with AI", async () => {
    const author = await newUser();
    const reporter = await newUser();
    const work = await newWork(author);
    const comment = await newComment(work, reporter);
    const report = await newStandardReport(work, reporter);
    await deleteWork(work);
    expect(
      committedIds(
        await execute("community.decide-report", {
          id: report,
          expectedVersion: await versionOfReport(report),
          action: "retain",
          reason: REASON,
        }),
      ),
    ).toEqual([report]);
    expect(
      await execute("community.moderate-comment", {
        id: comment,
        action: "hide",
        reason: REASON,
      }),
    ).toMatchObject({ ok: true });
  });

  const stoppedPurgeJob = async (subject: string, state: string) => {
    const id = opaque("publishing-job");
    await setup.query(
      "INSERT INTO community.publishing_jobs(id,kind,subject_id,state,run_after) VALUES($1,'purge_trashed_work',$2,$3,CURRENT_TIMESTAMP)",
      [id, subject, state],
    );
    return id;
  };
  const stateOfJob = async (id: string) =>
    (await one("SELECT state FROM community.publishing_jobs WHERE id=$1", [id]))
      .state;

  it.each(["failed", "abandoned"])(
    "refuses a retry of a %s job whose subject is a self-only work, and says so",
    async (state) => {
      const work = await newWork(await newUser());
      const job = await stoppedPurgeJob(work, state);
      await makeSelfOnly(work);
      const answer = await execute("community.retry-publishing-job", {
        id: job,
      });
      expect(answer).toMatchObject({
        ok: false,
        code: "SELF_ONLY_OWNER_REVIEW",
        data: { failed: [{ id: job, code: "SELF_ONLY_OWNER_REVIEW" }] },
      });
      expect(await stateOfJob(job)).toBe(state);
      // Back to public, the same retry goes through: it asks each time.
      await makePublic(work);
      expect(
        await execute("community.retry-publishing-job", { id: job }),
      ).toMatchObject({ ok: false, code: "QUEUED" });
      expect(await stateOfJob(job)).toBe("queued");
    },
  );

  it("retries a job on a public work, and a job on a media item whatever the item's work", async () => {
    const work = await newWork(await newUser());
    const onWork = await stoppedPurgeJob(work, "failed");
    expect(
      await execute("community.retry-publishing-job", { id: onWork }),
    ).toMatchObject({ ok: false, code: "QUEUED" });
    const onItem = opaque("publishing-job");
    await setup.query(
      "INSERT INTO community.publishing_jobs(id,kind,subject_id,state,run_after) VALUES($1,'purge_item',$2,'failed',CURRENT_TIMESTAMP)",
      [onItem, opaque("media-item")],
    );
    expect(
      await execute("community.retry-publishing-job", { id: onItem }),
    ).toMatchObject({ ok: false, code: "QUEUED" });
    // The Owner's route asks nothing of the kind.
    const selfOnlyWork = await newWork(await newUser());
    const owners = await stoppedPurgeJob(selfOnlyWork, "failed");
    await makeSelfOnly(selfOnlyWork);
    expect(
      (
        await owner("POST", `publishing/jobs/${owners}/retry`, {
          requestId: randomUUID(),
        })
      ).status,
    ).toBe(200);
  });

  describe("a lost answer on a comment, then a flip", () => {
    const committedThenFlipped = async () => {
      const work = await newWork(await newUser());
      const comment = await newComment(work, await newUser());
      const requestId = randomUUID();
      const input = { id: comment, action: "hide", reason: REASON };
      expect(
        await withLostWrite(() =>
          execute("community.moderate-comment", input, requestId),
        ),
      ).toMatchObject({ code: "OUTCOME_UNKNOWN" });
      await makeSelfOnly(work);
      return { comment, requestId, input };
    };
    const casesOn = (comment: string) =>
      countOf("community.report_cases", "target_id=$1", [comment]);

    it("answers from the receipt, as what committed, and writes nothing", async () => {
      const { comment, requestId, input } = await committedThenFlipped();
      const before = await casesOn(comment);
      const retried = await execute(
        "community.moderate-comment",
        input,
        requestId,
      );
      expect(retried).toMatchObject({
        ok: true,
        data: { already_applied: [comment] },
        meta: { replayed: true },
      });
      expect(retried.data.results[0]).toEqual({
        index: 0,
        id: comment,
        state: "hidden",
      });
      expect(await casesOn(comment)).toBe(before);
    });

    it("still refuses a new key, and a key that committed anything else", async () => {
      const { requestId, input } = await committedThenFlipped();
      expect(await execute("community.moderate-comment", input)).toMatchObject({
        code: "SELF_ONLY_OWNER_REVIEW",
      });
      expect(
        await execute(
          "community.moderate-comment",
          { ...input, reason: "Another reason" },
          requestId,
        ),
      ).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      // A key another route's receipt holds lets no write through on this comment.
      const work = await newWork(await newUser());
      const other = await newComment(work, await newUser());
      await makeSelfOnly(work);
      const shared = randomUUID();
      expect(
        committedIds(
          await execute(
            "community.moderate-user",
            { id: await newUser(), action: "suspend", reason: REASON },
            shared,
          ),
        ),
      ).toHaveLength(1);
      expect(
        await execute(
          "community.moderate-comment",
          { id: other, action: "hide", reason: REASON },
          shared,
        ),
      ).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      expect(
        (
          await one(
            "SELECT moderation FROM community.catalog_comments WHERE id=$1",
            [other],
          )
        ).moderation,
      ).toBe("visible");
    });

    it("refuses a work's own receipt after a flip: its answer would hold the title", async () => {
      const work = await newWork(await newUser());
      const requestId = randomUUID();
      const input = {
        id: work,
        state: "hidden",
        expectedVersion: await versionOfWork(work),
        reason: REASON,
      };
      await withLostWrite(() =>
        execute("community.moderate-work", input, requestId),
      );
      await makeSelfOnly(work);
      expect(
        await execute("community.moderate-work", input, requestId),
      ).toMatchObject({ ok: false, code: "SELF_ONLY_OWNER_REVIEW" });
    });
  });

  it("keeps an Article using a self-only work's item with the Owner", async () => {
    const author = await newUser();
    const work = await newWork(author);
    const revision = await newPendingRevision(work, author);
    const item = opaque("media-item");
    await setup.query(
      "INSERT INTO community.media_items(id,owner_id,kind,quality_mode,source,state,declared_total_bytes) VALUES($1,$2,'static','standard','upload','awaiting_upload',1000)",
      [item, author],
    );
    await setup.query(
      "INSERT INTO community.work_revision_items(revision_id,item_id,position,edit) VALUES($1,$2,1,'{}'::jsonb)",
      [revision, item],
    );
    const article = await newPendingArticle(
      author,
      JSON.stringify({
        ...emptyArticleDocument(),
        references: { used: { type: "managed", itemId: item } },
      }),
    );
    await makeSelfOnly(work);
    expect(
      await execute("community.moderate-article-submission", {
        id: article,
        expectedVersion: 2,
        candidateVersion: 1,
        fingerprint: ARTICLE_FINGERPRINT,
        action: "reject",
        reason: REASON,
      }),
    ).toMatchObject({ ok: false, code: "SELF_ONLY_OWNER_REVIEW" });
  });
});

describe("a rights notice, with the evidence switch off", () => {
  const expectNoContact = (answer: Json) => {
    const text = JSON.stringify(answer);
    expect(text).not.toContain(CONTACT_CANARY);
    expect(text).not.toContain(EVIDENCE_CANARY);
    expect(text).not.toContain('"contact"');
    expect(text).not.toContain('"fileName"');
    expect(text).not.toContain('"downloadPath"');
  };

  it("takes a decision, a review and metadata, and no answer holds its contact", async () => {
    const author = await newUser();
    const reporter = await newUser();
    const notice = await newRightsNotice(await newWork(author), reporter);
    const metadata = await execute("community.set-report-metadata", {
      id: notice,
      expectedVersion: await versionOfReport(notice),
      status: "reviewing",
    });
    expect(metadata).toMatchObject({ ok: true });
    expect(metadata.data.results[0]).toMatchObject({
      state: "reviewing",
      kind: "rights_notice",
    });
    expectNoContact(metadata);
    const decided = await execute("community.decide-report", {
      id: notice,
      expectedVersion: await versionOfReport(notice),
      action: "hide",
      reason: REASON,
    });
    expect(committedIds(decided)).toEqual([notice]);
    expectNoContact(decided);
    await appealAs(author, notice);
    const reviewed = await execute("community.review-report", {
      id: notice,
      expectedVersion: await versionOfReport(notice),
      outcome: "overturn",
      reason: REASON,
    });
    expect(committedIds(reviewed)).toEqual([notice]);
    expectNoContact(reviewed);
    // The Owner's own read still holds what AI's never does.
    const { body } = await owner("GET", `reports/${notice}`);
    expect(JSON.stringify(body)).toContain(CONTACT_CANARY);
    expect(body.history.map(({ operator }: Json) => operator)).toEqual(
      expect.arrayContaining([AI]),
    );
    expect(body.history.every(({ operator }: Json) => operator === AI)).toBe(
      true,
    );
  });

  it("sends a forward and a legal hold's release through the preview, never here", async () => {
    const notice = await newRightsNotice(
      await newWork(await newUser()),
      await newUser(),
    );
    const expectedVersion = await versionOfReport(notice);
    expect(
      await execute("community.forward-report", {
        id: notice,
        expectedVersion,
        kind: "notice",
        text: "Synthetic notice",
      }),
    ).toMatchObject({ ok: false, code: "USE_EXECUTE_IRREVERSIBLE" });
    expect(
      await execute("community.set-report-metadata", {
        id: notice,
        expectedVersion,
        legalHold: false,
      }),
    ).toMatchObject({ ok: false, code: "PREVIEW_REQUIRED" });
    expect(await versionOfReport(notice)).toBe(expectedVersion);
    const direct = await fetch(
      `${backendOrigin}internal/community/reports/${notice}/metadata`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${communityToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ expectedVersion, legalHold: false }),
      },
    );
    expect(direct.status).toBe(403);
    expect(((await direct.json()) as Json).error.code).toBe("AI_RUN_REQUIRED");
    expect(await versionOfReport(notice)).toBe(expectedVersion);
    // A hold set, and any other metadata, runs as it always did for the Owner.
    expect(
      await execute("community.set-report-metadata", {
        id: notice,
        expectedVersion,
        legalHold: true,
      }),
    ).toMatchObject({ ok: true });
    const owners = await owner("POST", `reports/${notice}/metadata`, {
      expectedVersion: await versionOfReport(notice),
      legalHold: false,
    });
    expect(owners.status).toBe(200);
  });
});

describe("a person's own request about their personal information", () => {
  const ownRequest = async (description = `Delete my data ${run}`) => {
    const user = await newUser();
    const report = (
      await reporting.create(user, {
        kind: "standard",
        target: { type: "user", id: user },
        reason: "privacy",
        description,
        requestId: randomUUID(),
      })
    ).id;
    return { user, report, description };
  };
  const HINT = "stays in the Owner's queue";

  it("answers a named refusal to every AI write, with a fixed hint, and changes nothing", async () => {
    const { report } = await ownRequest();
    const expectedVersion = await versionOfReport(report);
    for (const [op, input] of [
      [
        "community.decide-report",
        { action: "retain", reason: REASON, expectedVersion },
      ],
      [
        "community.decide-report",
        { action: "suspend", reason: REASON, expectedVersion },
      ],
      [
        "community.review-report",
        { outcome: "overturn", reason: REASON, expectedVersion },
      ],
      ["community.set-report-metadata", { urgent: true, expectedVersion }],
      [
        "community.set-report-metadata",
        { status: "reviewing", expectedVersion },
      ],
    ] as const) {
      const answer = await execute(op, { id: report, ...input });
      expect(answer, op).toMatchObject({
        ok: false,
        code: "PERSONAL_INFO_OWNER_REVIEW",
        data: { failed: [{ id: report, code: "PERSONAL_INFO_OWNER_REVIEW" }] },
      });
      expect(answer.hint, op).toContain(HINT);
      expect(answer.retryable, op).toBeUndefined();
    }
    expect(await versionOfReport(report)).toBe(expectedVersion);
    expect(
      await countOf("community.report_decisions", "case_id=$1", [report]),
    ).toBe(0);
    expect(
      await countOf(
        "community.report_audit",
        "case_id=$1 AND operator_label=$2",
        [report, AI],
      ),
    ).toBe(0);
  });

  it("lets AI read it whole, offers it no write and no action, and leaves it in the Owner's queue", async () => {
    const { report, description, user } = await ownRequest();
    const read1 = await read({
      op: "community.read-report",
      input: { id: report },
    });
    expect(read1).toMatchObject({ ok: true });
    expect(read1.data).toMatchObject({
      description,
      reason: "privacy",
      allowedActions: [],
    });
    const listed = await read({
      op: "list.reports",
      input: { reporterId: user },
      fields: ["description", "allowedActions"],
    });
    expect(listed.data.rows).toHaveLength(1);
    expect(listed.data.rows[0]).toMatchObject({
      id: report,
      reason: "privacy",
      allowedActions: [],
    });
    const found = (await send(client, "admin_find", { query: report })).envelope
      .data.items[0];
    expect(
      found.actions.filter(({ tool }: Json) => tool === "admin_execute"),
    ).toEqual([]);
    expect(found.actions).toContainEqual({
      tool: "admin_get",
      args: { type: "report", id: report },
    });
    const got = (
      await send(client, "admin_get", { type: "report", id: report })
    ).envelope;
    expect(
      got.data.actions.filter(({ tool }: Json) => tool === "admin_execute"),
    ).toEqual([]);
    const { status, body } = await owner(
      "GET",
      "reports?status=open&pageSize=100",
    );
    expect(status).toBe(200);
    expect(body.items.map(({ id }: Json) => id)).toContain(report);
  });

  it("leaves the Owner's route as it was", async () => {
    const { report } = await ownRequest();
    const { status, body } = await owner(
      "POST",
      `reports/${report}/decisions`,
      {
        expectedVersion: await versionOfReport(report),
        action: "retain",
        reason: REASON,
      },
    );
    expect(status).toBe(200);
    expect(body.allowedActions.length).toBeGreaterThan(0);
    expect(body.history.at(-1).operator).toBe("owner");
  });

  it("treats a privacy report about someone else, or another reason on one's own profile, as any other case", async () => {
    const other = await newUser();
    const someoneElse = (
      await reporting.create(await newUser(), {
        kind: "standard",
        target: { type: "user", id: other },
        reason: "privacy",
        description: `Exposes me ${run}`,
        requestId: randomUUID(),
      })
    ).id;
    const self = await newUser();
    const anotherReason = (
      await reporting.create(self, {
        kind: "standard",
        target: { type: "user", id: self },
        reason: "other",
        description: `Something else ${run}`,
        requestId: randomUUID(),
      })
    ).id;
    for (const id of [someoneElse, anotherReason])
      expect(
        committedIds(
          await execute("community.decide-report", {
            id,
            expectedVersion: await versionOfReport(id),
            action: "retain",
            reason: REASON,
          }),
        ),
      ).toEqual([id]);
    const onWork = await newStandardReport(
      await newWork(await newUser()),
      await newUser(),
    );
    const found = (await send(client, "admin_find", { query: onWork })).envelope
      .data.items[0];
    expect(
      found.actions.filter(({ tool }: Json) => tool === "admin_execute"),
    ).toHaveLength(3);
    const got = (
      await send(client, "admin_get", { type: "report", id: onWork })
    ).envelope;
    expect(
      got.data.actions.filter(({ tool }: Json) => tool === "admin_execute"),
    ).toHaveLength(3);
  });
});

describe("urgent, from the AI credential", () => {
  it("refuses to clear it by name, and changes nothing", async () => {
    const report = (
      await reporting.create(await newUser(), {
        kind: "standard",
        target: { type: "work", id: await newWork(await newUser()) },
        reason: "illegal_harmful",
        description: `Urgent ${run}`,
        requestId: randomUUID(),
      })
    ).id;
    const urgent = async () =>
      (
        await one("SELECT urgent FROM community.report_cases WHERE id=$1", [
          report,
        ])
      ).urgent;
    expect(await urgent()).toBe(true);
    const expectedVersion = await versionOfReport(report);
    const answer = await execute("community.set-report-metadata", {
      id: report,
      expectedVersion,
      urgent: false,
    });
    expect(answer).toMatchObject({
      ok: false,
      code: "URGENT_OWNER_ONLY",
      data: { failed: [{ id: report, code: "URGENT_OWNER_ONLY" }] },
    });
    expect(answer.hint).toContain("only the Owner clears it");
    expect(await urgent()).toBe(true);
    expect(await versionOfReport(report)).toBe(expectedVersion);
    // The same refusal on the Backend itself, whatever a client calls it.
    const direct = await fetch(
      `${backendOrigin}internal/community/reports/${report}/metadata`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${communityToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ expectedVersion, urgent: false }),
      },
    );
    expect(direct.status).toBe(403);
    expect(((await direct.json()) as Json).error.code).toBe(
      "URGENT_OWNER_ONLY",
    );
    // The Owner clears it as ever.
    expect(
      (
        await owner("POST", `reports/${report}/metadata`, {
          expectedVersion,
          urgent: false,
        })
      ).status,
    ).toBe(200);
    expect(await urgent()).toBe(false);
    // And AI can raise it again.
    expect(
      committedIds(
        await execute("community.set-report-metadata", {
          id: report,
          expectedVersion: await versionOfReport(report),
          urgent: true,
        }),
      ),
    ).toEqual([report]);
    expect(await urgent()).toBe(true);
  });
});

describe("appeals, of any origin", () => {
  it("lets AI review an appeal against its own decision, and the history shows ai-admin", async () => {
    const author = await newUser();
    const report = await newStandardReport(
      await newWork(author),
      await newUser(),
    );
    await decideAs(report, "hide");
    await appealAs(author, report);
    const queue = await read({ op: "list.appeals", input: { pageSize: 100 } });
    expect(queue.data.rows.map(({ id }: Json) => id)).toContain(report);
    const answer = await execute("community.review-report", {
      id: report,
      expectedVersion: await versionOfReport(report),
      outcome: "uphold",
      reason: "Reviewed by AI",
    });
    expect(committedIds(answer)).toEqual([report]);
    const { body } = await owner("GET", `reports/${report}`);
    expect(body.status).toBe("resolved");
    expect(body.appeal.status).toBe("upheld");
    expect(
      body.history.map(({ action, operator }: Json) => [action, operator]),
    ).toEqual(
      expect.arrayContaining([
        ["hide", AI],
        ["uphold", AI],
      ]),
    );
    // The person who appealed is told how it ended, as on the human route.
    const inbox = await rows(
      "SELECT text FROM community.report_messages WHERE case_id=$1 AND recipient_id=$2",
      [report, author],
    );
    expect(inbox.some(({ text }) => text.includes("Reviewed by AI"))).toBe(
      true,
    );
  });

  it("lets AI overturn the Owner's decision, and the work comes back", async () => {
    const author = await newUser();
    const work = await newWork(author);
    const report = await newStandardReport(work, await newUser());
    await decideAs(report, "hide", "owner");
    expect(
      (
        await one("SELECT operator_state FROM community.works WHERE id=$1", [
          work,
        ])
      ).operator_state,
    ).toBe("hidden");
    await appealAs(author, report);
    const answer = await execute("community.review-report", {
      id: report,
      expectedVersion: await versionOfReport(report),
      outcome: "overturn",
      reason: REASON,
    });
    expect(committedIds(answer)).toEqual([report]);
    expect(answer.data.results[0].decision.reversedAt).toEqual(
      expect.any(String),
    );
    expect(
      (
        await one("SELECT operator_state FROM community.works WHERE id=$1", [
          work,
        ])
      ).operator_state,
    ).toBe("visible");
  });

  it("lets AI overturn a staff-origin hide of a comment, and labels the comment's own row", async () => {
    const author = await newUser();
    const comment = await newComment(await newWork(await newUser()), author);
    await owner("POST", `comments/${comment}/moderation`, {
      action: "hide",
      reason: REASON,
    });
    const { case_id: caseId } = (await caseOf(comment)).row;
    await appealAs(author, caseId);
    expect(
      committedIds(
        await execute("community.review-report", {
          id: caseId,
          expectedVersion: await versionOfReport(caseId),
          outcome: "overturn",
          reason: REASON,
        }),
      ),
    ).toEqual([caseId]);
    expect(
      await one(
        "SELECT moderation,moderated_by FROM community.catalog_comments WHERE id=$1",
        [comment],
      ),
    ).toEqual({ moderation: "visible", moderated_by: AI });
  });

  it("labels a comment a report's decision hides as ai-admin, not the Owner", async () => {
    const reporter = await newUser();
    const comment = await newComment(
      await newWork(await newUser()),
      await newUser(),
    );
    const report = await newCommentReport(comment, reporter);
    await decideAs(report, "hide");
    expect(
      await one(
        "SELECT moderation,moderated_by FROM community.catalog_comments WHERE id=$1",
        [comment],
      ),
    ).toEqual({ moderation: "hidden", moderated_by: AI });
  });
});

describe("the sample request: find a user's recent ad comments and hide them", () => {
  /** What an anonymous visitor reads of the work, over the public route. */
  const publicComments = async (work: string) => {
    const response = await fetch(
      `${backendOrigin}v1/community/discussion/work/${work}`,
    );
    expect(response.status).toBe(200);
    const { hot, items } = (await response.json()) as Record<string, Json[]>;
    return [...hot!, ...items!].map(({ id }) => id as string).sort();
  };
  const idsIn = ({ data }: Json): string[] =>
    data.rows.map(({ id }: Json) => id as string).sort();
  const RANGE_HINT =
    "This range holds finished days, so today is not in it. To reach now, send from with no to.";

  it("hides exactly those, and a replay changes nothing", async () => {
    const lishu = await newUser();
    const other = await newUser("Similar");
    const work = await newWork(await newUser());
    const ad = `加微信 ${run}`;
    const matching = [
      await newComment(work, lishu, `${ad} 一`),
      await newComment(work, lishu, `${ad} 二`),
    ];
    const plain = await newComment(work, lishu, `Plain ${run}`);
    const someoneElse = await newComment(work, other, `${ad} 三`);
    const old = await newComment(work, lishu, `${ad} 旧`);
    // A named range holds finished days, so none of these sits in today's.
    await setup.query(
      "UPDATE community.catalog_comments SET created_at=CURRENT_TIMESTAMP - make_interval(days => CASE WHEN id=$2 THEN 9 ELSE 2 END) WHERE id=ANY($1)",
      [[...matching, plain, someoneElse, old], old],
    );
    expect(await publicComments(work)).toEqual(
      [...matching, plain, someoneElse, old].sort(),
    );
    const { handle } = await one(
      "SELECT handle FROM community.public_users WHERE id=$1",
      [lishu],
    );
    const found = (await send(client, "admin_find", { query: `@${handle}` }))
      .envelope;
    expect(found.data.resolution).toEqual({
      status: "exact",
      uniqueIdentity: true,
      ref: { type: "user", id: lishu },
    });
    const request = {
      op: "list.comments",
      input: { authorId: lishu, search: ad, range: "last_7_days" },
    };
    const listed = await read(request);
    const targets = listed.data.rows.map(({ id }: Json) => ({ id }));
    expect(idsIn(listed)).toEqual([...matching].sort());
    const requestId = randomUUID();
    const reason = "批量广告";
    const input = { action: "hide", reason };
    const first = await executeAll(
      "community.moderate-comment",
      input,
      targets,
      requestId,
    );
    expect(first).toMatchObject({ ok: true, done: 2, total: 2 });
    expect(first.data.moderationCases).toBe(2);
    // A visitor no longer reads them, and still reads the rest.
    expect(await publicComments(work)).toEqual(
      [plain, someoneElse, old].sort(),
    );
    // Each is a decision of its own: its reason, who made it, the author told how to appeal.
    for (const id of matching) {
      const { row, messages } = await caseOf(id);
      expect(row).toMatchObject({
        kind: "moderation",
        status: "resolved",
        affected_user_id: lishu,
        decision_reason: reason,
        operator_label: AI,
        audit_label: AI,
      });
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        recipient_id: lishu,
        kind: "result",
      });
      expect(messages[0]!.text).toContain(reason);
      expect(messages[0]!.text).toContain("可在举报与申诉中申请复核");
    }
    // The same read tells the client what it did.
    const after = await read(request);
    expect(idsIn(after)).toEqual([...matching].sort());
    expect(after.data.rows.map(({ state }: Json) => state)).toEqual([
      "hidden",
      "hidden",
    ]);
    const states = async () =>
      Object.fromEntries(
        (
          await rows(
            "SELECT id,moderation FROM community.catalog_comments WHERE id=ANY($1)",
            [[...matching, plain, someoneElse, old]],
          )
        ).map(({ id, moderation }) => [id, moderation]),
      );
    expect(await states()).toEqual({
      [matching[0]!]: "hidden",
      [matching[1]!]: "hidden",
      [plain]: "visible",
      [someoneElse]: "visible",
      [old]: "visible",
    });
    const replay = await executeAll(
      "community.moderate-comment",
      input,
      targets,
      requestId,
    );
    expect(replay.ok).toBe(true);
    expect(replay.meta.replayed).toBe(true);
    expect(
      await countOf(
        "community.moderation_events",
        "subject_id=ANY($1) AND action='hide'",
        [matching],
      ),
    ).toBe(2);
    // The author's way back is the human route's.
    const { row } = await caseOf(matching[0]!);
    await appealAs(lishu, row.case_id);
    expect(
      (
        await one("SELECT status FROM community.report_cases WHERE id=$1", [
          row.case_id,
        ])
      ).status,
    ).toBe("appealed");
  });

  it("leaves today's out on a named range and says so, and an open `from` reaches it", async () => {
    const lishu = await newUser();
    const work = await newWork(await newUser());
    const ad = `加微信 ${run} 今天`;
    const earlier = await newComment(work, lishu, `${ad} 一`);
    const today = await newComment(work, lishu, `${ad} 二`);
    const old = await newComment(work, lishu, `${ad} 旧`);
    await setup.query(
      "UPDATE community.catalog_comments SET created_at=CURRENT_TIMESTAMP - make_interval(days => CASE WHEN id=$2 THEN 2 ELSE 9 END) WHERE id=ANY($1)",
      [[earlier, old], earlier],
    );
    const named = await read({
      op: "list.comments",
      input: { authorId: lishu, search: ad, range: "last_7_days" },
    });
    expect(idsIn(named)).toEqual([earlier]);
    // Its filter names both instants, and says outright what the range leaves out.
    const { from, to, range, tz, excludes } = named.data.filter;
    expect([range, tz, excludes]).toEqual([
      "last_7_days",
      "Asia/Shanghai",
      "today",
    ]);
    expect(named.hint).toBe(RANGE_HINT);
    const { created_at: posted } = await one(
      "SELECT created_at FROM community.catalog_comments WHERE id=$1",
      [today],
    );
    expect(Date.parse(to)).toBeLessThan((posted as Date).getTime());
    const open = await read({
      op: "list.comments",
      input: { authorId: lishu, search: ad, from },
    });
    expect(idsIn(open)).toEqual([earlier, today].sort());
    expect(open.data.filter).not.toHaveProperty("to");
    expect(open.data.filter).not.toHaveProperty("excludes");
    expect(open.hint).toBeUndefined();
    const counted = await read({
      op: "list.comments",
      view: "count",
      input: { authorId: lishu, search: ad, range: "last_7_days" },
    });
    expect(counted.data).toMatchObject({
      total: 1,
      filter: { range: "last_7_days", excludes: "today" },
    });
    expect(counted.hint).toBe(RANGE_HINT);
    // A range that reaches the present holds today, and says nothing of the kind.
    const reaching = await read({
      op: "list.comments",
      input: { authorId: lishu, search: ad, range: "today" },
    });
    expect(idsIn(reaching)).toEqual([today]);
    expect(reaching.data.filter).not.toHaveProperty("excludes");
    expect(reaching.hint).toBeUndefined();
    const works = await read({
      op: "list.works",
      input: { authorId: lishu, range: "yesterday" },
    });
    expect(works.data.filter.excludes).toBe("today");
    expect(works.hint).toBe(RANGE_HINT);
    // And a client that reads the op first is told before it asks.
    const { data } = (
      await send(client, "admin_actions", { ops: ["list.comments"] })
    ).envelope;
    expect(data.details[0].input.properties.range.description).toContain(
      "today is not in it",
    );
    const hidden = await executeAll(
      "community.moderate-comment",
      { action: "hide", reason: "批量广告" },
      open.data.rows.map(({ id }: Json) => ({ id })),
    );
    expect(hidden).toMatchObject({ ok: true, done: 2, total: 2 });
    expect(await publicComments(work)).toEqual([old]);
  });

  it("separates changed, skipped and missing on a bulk suspension", async () => {
    const changed = [await newUser(), await newUser()];
    const skipped = await newUser();
    await setup.query(
      "UPDATE community.public_users SET status='suspended' WHERE id=$1",
      [skipped],
    );
    const missing = opaque("user");
    const requestId = randomUUID();
    const targets = [...changed, skipped, missing].map((id) => ({ id }));
    const input = { action: "suspend", reason: "批量广告" };
    const first = await executeAll(
      "community.moderate-user",
      input,
      targets,
      requestId,
    );
    expect(first.ok).toBe(false);
    const { applied = [], already_applied = [], queued = [] } = first.data;
    const inPlace = [
      ...already_applied,
      ...queued
        .filter(({ alreadyApplied }: Json) => alreadyApplied === true)
        .map(({ id }: Json) => id),
    ];
    const moved = [
      ...applied,
      ...queued
        .filter(({ alreadyApplied }: Json) => alreadyApplied !== true)
        .map(({ id }: Json) => id),
    ];
    expect(moved.sort()).toEqual([...changed].sort());
    expect(inPlace).toEqual([skipped]);
    expect(first.data.failed).toEqual([
      { index: 3, id: missing, code: "NOT_FOUND" },
    ]);
    expect(first.data.moderationCases).toBe(2);
    expect(
      await countOf("community.report_cases", "target_id=$1", [skipped]),
    ).toBe(0);
    const eventsBefore = await countOf(
      "community.moderation_events",
      "subject_id=ANY($1)",
      [changed],
    );
    const replay = await executeAll(
      "community.moderate-user",
      input,
      targets,
      requestId,
    );
    expect(replay.data.moderationCases).toBeUndefined();
    expect(
      await countOf("community.moderation_events", "subject_id=ANY($1)", [
        changed,
      ]),
    ).toBe(eventsBefore);
  });
});

describe("a write's share of the App pool", () => {
  it("ends at its own limit behind a held lock, so retries cannot take the App pool", async () => {
    const work = await newWork(await newUser());
    const user = await newUser();
    const input = {
      id: work,
      state: "hidden",
      expectedVersion: await versionOfWork(work),
      reason: REASON,
    };
    const requestId = randomUUID();
    const waiting = async () =>
      Number(
        (
          await one(
            "SELECT count(*)::integer AS n FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock'",
            [role],
          )
        ).n,
      );
    const holder = await setup.connect();
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      await holder.query("ROLLBACK");
      holder.release();
    };
    let mostWaiting = 0;
    let mostConnections = 0;
    const sampling = setInterval(() => {
      void waiting().then((n) => {
        mostWaiting = Math.max(mostWaiting, n);
        mostConnections = Math.max(mostConnections, app.totalCount);
      });
    }, 250);
    try {
      await holder.query("BEGIN");
      await holder.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('phase4-content-operator',0))",
      );
      await holder.query(
        "SELECT 1 FROM community.public_users WHERE id=$1 FOR UPDATE",
        [user],
      );
      // One client following OUTCOME_UNKNOWN: its connection has gone by each answer.
      const started = performance.now();
      expect(
        await execute("community.moderate-work", input, requestId),
      ).toMatchObject({ ok: false, code: "OUTCOME_UNKNOWN", retryable: true });
      expect(performance.now() - started).toBeLessThan(15_000);
      expect(await waiting()).toBe(0);
      expect(mostWaiting).toBeLessThanOrEqual(1);

      // Then both of AI's slots at once, and the Owner's same route beside them.
      const owners = owner("POST", `users/${user}/status`, {
        action: "suspend",
        reason: REASON,
      });
      let ownerAnswered = false;
      void owners.then(() => {
        ownerAnswered = true;
      });
      const [work2, user2] = await Promise.all([
        execute("community.moderate-work", input, requestId),
        execute("community.moderate-user", {
          id: user,
          action: "suspend",
          reason: REASON,
        }),
      ]);
      expect(work2).toMatchObject({ code: "OUTCOME_UNKNOWN" });
      expect(user2).toMatchObject({ code: "OUTCOME_UNKNOWN" });
      expect(mostWaiting).toBeLessThanOrEqual(3);
      expect(mostConnections).toBeLessThanOrEqual(4);

      // Past the limit the Owner's write is still there and only it, and the pool
      // still serves a visitor.
      expect(await waiting()).toBe(1);
      expect(ownerAnswered).toBe(false);
      const visitor = await fetch(
        `${backendOrigin}v1/community/discussion/work/${work}`,
      );
      expect(visitor.status).toBe(200);

      await release();
      expect((await owners).status).toBe(200);
    } finally {
      clearInterval(sampling);
      await release();
    }
    // Nothing of the rolled-back writes stayed, and the same key now applies once.
    expect(
      committedIds(await execute("community.moderate-work", input, requestId)),
    ).toEqual([work]);
    expect(
      await countOf(
        "community.content_operator_events",
        "content_id=$1 AND action='work.moderate'",
        [work],
      ),
    ).toBe(1);
    expect(
      await execute("community.moderate-work", input, requestId),
    ).toMatchObject({ meta: { replayed: true } });
    expect(await labelsOf([moderationEvents(user)])).toEqual(["owner"]);
  }, 60_000);

  it("waits for the same two slots the reads hold, then runs", async () => {
    let reached = 0;
    const held: ServerResponse[] = [];
    const answers = await withStubBackend(
      (_request, response) => {
        reached += 1;
        held.push(response);
      },
      async () => {
        const reads = Promise.all([
          read({ op: "list.comments" }),
          read({ op: "list.reports", view: "count" }),
        ]);
        await vi.waitFor(() => expect(reached).toBe(2));
        const write = execute("community.moderate-user", {
          id: opaque("user"),
          action: "suspend",
          reason: REASON,
        });
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(reached).toBe(2);
        for (const response of held.splice(0)) {
          response.writeHead(503, { "content-type": "application/json" });
          response.end(
            JSON.stringify({ error: { status: 503, code: "READ_TIMED_OUT" } }),
          );
        }
        await vi.waitFor(() => expect(reached).toBe(3));
        for (const response of held.splice(0)) {
          response.writeHead(404, { "content-type": "application/json" });
          response.end(
            JSON.stringify({ error: { status: 404, code: "NOT_FOUND" } }),
          );
        }
        return { reads: await reads, write: await write };
      },
    );
    expect(answers.write).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("answers EXECUTE_BUSY when no slot came in time, and has run nothing", async () => {
    let reached = 0;
    const held: ServerResponse[] = [];
    const answer = await withStubBackend(
      (_request, response) => {
        reached += 1;
        held.push(response);
      },
      async () => {
        const reads = Promise.all([
          read({ op: "list.comments" }),
          read({ op: "list.reports", view: "count" }),
        ]);
        await vi.waitFor(() => expect(reached).toBe(2));
        const write = await execute("community.moderate-user", {
          id: opaque("user"),
          action: "suspend",
          reason: REASON,
        });
        for (const response of held.splice(0)) {
          response.writeHead(503, { "content-type": "application/json" });
          response.end(
            JSON.stringify({ error: { status: 503, code: "READ_TIMED_OUT" } }),
          );
        }
        await reads;
        return write;
      },
    );
    expect(answer).toMatchObject({
      ok: false,
      code: "EXECUTE_BUSY",
      retryable: true,
    });
    expect(reached).toBe(2);
  });
});
