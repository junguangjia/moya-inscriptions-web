/**
 * Admin MCP's community reads on the Backend (admin-mcp-completion-v1 sections 2, 6
 * and 12), over the real HTTP server, router and handlers, and the real adapters
 * under the runtime App role. Its whole point is what must not leave: a claimant's
 * contact in any state, evidence names while off, and everything self-only, by any
 * carrier, including a total or a filter that would reveal a value by counting.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
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
  PostgresAiOperatorReader,
  PostgresArticleAuthoringAdapter,
  PostgresCommunityCommentAdapter,
  PostgresCommunityContentOperatorAdapter,
  PostgresCommunityIdentityAdapter,
  PostgresCommunityReportingAdapter,
  PostgresDirectMessageAdapter,
  PostgresFeedbackAdapter,
  PostgresPublishingOperatorAdapter,
  PostgresThreadAdapter,
  PostgresWorkPublishingAdapter,
  runCommunityMigrations,
} from "@moya/community-postgres";
import {
  AI_OPERATOR_ROUTES,
  aiCountResultSchema,
  aiFindResultSchema,
} from "@moya/contracts/internal/admin-mcp";
import {
  articlePendingCandidateSchema,
  moderationSummarySchema,
  operatorReportAiPageSchema,
  operatorReportAiSchema,
  operatorReportSchema,
  operatorUserAiPageSchema,
  operatorUserPageSchema,
} from "@moya/contracts/internal/community-operator";
import { emptyArticleDocument } from "@moya/contracts/schemas";
import type { PublicUserId } from "@moya/contracts";
import { UnconfiguredStorageUrlResolver } from "@moya/image";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { requireSyntheticTestDatabaseUrl } from "./synthetic-test-database.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const target = requireSyntheticTestDatabaseUrl();
const guard = await import(
  new URL("../../../scripts/disposable-test-target.mjs", import.meta.url).href
);

type Pool = ReturnType<typeof createPostgresPool>;
const poolFor = (url: string): Pool =>
  createPostgresPool(parsePostgresConfig({ DATABASE_URL: url }));

const synthetic = () => randomBytes(32).toString("base64url");
const ownerToken = synthetic();
const communityToken = synthetic();
const baseToken = synthetic();

const opaque = (prefix: string) =>
  `${prefix}-${randomUUID().replaceAll("-", "")}`;

/** Unique on every run, so a hit is this run's seed and never another row. */
const run = randomBytes(6).toString("hex");
const CANARY = {
  selfTitle: `selftitlecanary${run}`,
  selfText: `selftextcanary${run}`,
  revisionTitle: `selfrevisiontitlecanary${run}`,
  revisionBody: `selfrevisionbodycanary${run}`,
  comment: `selfcommentcanary${run}`,
  reply: `selfreplycanary${run}`,
  selfReport: `selfreportcanary${run}`,
  commentReport: `selfcommentreportcanary${run}`,
  eventDetail: `selfeventcanary${run}`,
  contact: `contactcanary${run}`,
  evidenceName: `evidencenamecanary${run}.pdf`,
} as const;
const WITHHELD = Object.values(CANARY);

const RIGHTS = {
  name: `claimantname${run}`,
  basis: `rightsbasis${run}`,
  description: `noticedescription${run}`,
  material: `materialtext${run}`,
  appeal: `appealtext${run}`,
};

const admin = poolFor(target);
const database = `ai_reads_${run}_synthetic_test`;
const role = `ai_reads_${run}`;
let setup: Pool;
let app: Pool;
let server: Server;
let base = "";
let createdDatabase = false;
let createdRole = false;

const ids = {
  mediaArticle: opaque("article"),
  author: opaque("user"),
  reporter: opaque("user"),
  publicWork: opaque("work"),
  selfWork: opaque("work"),
  deletedWork: opaque("work"),
  publicRevision: opaque("work-revision"),
  selfRevision: opaque("work-revision"),
  publicComment: opaque("comment"),
  selfComment: opaque("comment"),
  selfReply: opaque("comment"),
  item: opaque("media-item"),
  articleItem: opaque("media-item"),
  thread: opaque("thread"),
  feedback: opaque("feedback"),
  job: opaque("publishing-job"),
  rightsReport: "",
  selfReport: "",
  commentReport: "",
  replyReport: "",
  deletedReport: "",
};

const get = async (token: string, route: string) => {
  const response = await fetch(`${base}/internal/community/${route}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return {
    status: response.status,
    text,
    json,
    code: (json as { error?: { code?: string } } | undefined)?.error?.code,
  };
};
const ai = (route: string) => get(communityToken, route);
const owner = (route: string) => get(ownerToken, route);
const query = (values: Record<string, string>) =>
  new URLSearchParams(values).toString();

const expectNoCanary = (text: string, label: string) => {
  for (const canary of WITHHELD) expect(text, label).not.toContain(canary);
};

const seed = async () => {
  const db = setup;
  for (const [id, handle] of [
    [ids.author, `author-${run}`],
    [ids.reporter, `reporter-${run}`],
  ] as const)
    await db.query(
      "INSERT INTO community.public_users(id,handle,display_name) VALUES($1,$2,$3)",
      [id, handle, `Name ${handle}`],
    );
  // The legacy bridge makes each a public work with its public revision.
  await db.query(
    "INSERT INTO community.works(id,author_id,title,text,first_published_at) VALUES($1,$4,'Public title','Public text',CURRENT_TIMESTAMP),($2,$4,$5,$6,CURRENT_TIMESTAMP),($3,$4,'Deleted title','Deleted text',CURRENT_TIMESTAMP)",
    [
      ids.publicWork,
      ids.selfWork,
      ids.deletedWork,
      ids.author,
      CANARY.selfTitle,
      CANARY.selfText,
    ],
  );
  for (const [revision, work, title, body] of [
    [ids.publicRevision, ids.publicWork, "Public revision", "Public body"],
    [ids.selfRevision, ids.selfWork, CANARY.revisionTitle, CANARY.revisionBody],
  ] as const)
    await db.query(
      `INSERT INTO community.work_revisions(id,work_id,author_id,sequence,origin,title,body,authorship_kind,requested_visibility,content_sha256,disposition,submitted_at)
       VALUES($1,$2,$3,50,'submission',$4,$5,'original','public',$6,'approved',CURRENT_TIMESTAMP)`,
      [revision, work, ids.author, title, body, "a".repeat(64)],
    );
  await db.query(
    "UPDATE community.works SET author_revision_id=$2 WHERE id=$1",
    [ids.selfWork, ids.selfRevision],
  );
  await db.query(
    `INSERT INTO community.catalog_comments(id,catalog_id,target_type,author_id,text,moderation)
     VALUES($1,$2,'work',$3,'Public comment','visible'),($4,$5,'work',$3,$6,'visible')`,
    [
      ids.publicComment,
      ids.publicWork,
      ids.reporter,
      ids.selfComment,
      ids.selfWork,
      CANARY.comment,
    ],
  );
  await db.query(
    "INSERT INTO community.catalog_comment_replies(id,root_comment_id,author_id,text,moderation) VALUES($1,$2,$3,$4,'visible')",
    [ids.selfReply, ids.selfComment, ids.reporter, CANARY.reply],
  );
  await db.query(
    "INSERT INTO community.featured_content(content_type,content_id,enabled,position) VALUES('work',$1,FALSE,1)",
    [ids.selfWork],
  );
  await db.query(
    "INSERT INTO community.moderation_events(id,occurred_at,operator_label,action,subject_kind,subject_id,detail) VALUES($1,CURRENT_TIMESTAMP,'owner','hide','comment',$2,$3)",
    [
      `moderation-${randomUUID().replaceAll("-", "")}`,
      ids.selfComment,
      CANARY.eventDetail,
    ],
  );
  await db.query(
    "INSERT INTO community.threads(id,title,description,created_by) VALUES($1,$2,'A synthetic thread','owner')",
    [ids.thread, `Thread ${run}`],
  );
  await db.query(
    "INSERT INTO community.feedback(id,user_id,submission_id,message) VALUES($1,$2,$3,$4)",
    [ids.feedback, ids.reporter, randomUUID(), `Feedback ${run}`],
  );
  await db.query(
    "INSERT INTO community.publishing_jobs(id,kind,subject_id,state,run_after) VALUES($1,'publish_media',$2,'queued',CURRENT_TIMESTAMP)",
    [ids.job, ids.item],
  );
  const reporting = new PostgresCommunityReportingAdapter(setup);
  const standard = (type: "work", id: string, description: string) =>
    reporting.create(ids.reporter, {
      kind: "standard",
      target: { type, id },
      reason: "other",
      description,
      requestId: randomUUID(),
    });
  ids.selfReport = (await standard("work", ids.selfWork, CANARY.selfReport)).id;
  ids.deletedReport = (
    await standard("work", ids.deletedWork, `On a deleted work ${run}`)
  ).id;
  ids.commentReport = (
    await reporting.create(ids.reporter, {
      kind: "quick_comment",
      target: { type: "comment", id: ids.selfComment },
      requestId: randomUUID(),
    })
  ).id;
  ids.replyReport = (
    await reporting.create(ids.author, {
      kind: "quick_comment",
      target: { type: "comment", id: ids.selfReply },
      requestId: randomUUID(),
    })
  ).id;
  const notice = await reporting.create(ids.reporter, {
    kind: "rights_notice",
    target: { type: "work", id: ids.publicWork },
    reason: "copyright",
    description: RIGHTS.description,
    claimantName: RIGHTS.name,
    contact: CANARY.contact,
    rightsBasis: RIGHTS.basis,
    requestId: randomUUID(),
  });
  ids.rightsReport = notice.id;
  await reporting.addMaterial(ids.reporter, notice.id, {
    text: RIGHTS.material,
    requestId: randomUUID(),
  });
  await db.query(
    "INSERT INTO community.report_evidence(id,case_id,owner_id,file_name,mime_type,byte_size,sensitive,sha256,state) VALUES($1,$2,$3,$4,'application/pdf',20,true,$5,'ready')",
    [
      opaque("evidence"),
      notice.id,
      ids.reporter,
      CANARY.evidenceName,
      "b".repeat(64),
    ],
  );
  const decided = await reporting.decide("owner", notice.id, {
    expectedVersion: (await reporting.operatorRead(notice.id)).version,
    action: "retain",
    reason: `Decision ${run}`,
  });
  await db.query(
    "UPDATE community.report_decisions SET appeal_text=$2,appeal_at=CURRENT_TIMESTAMP,appeal_status='pending' WHERE id=$1",
    [decided.decision!.id, RIGHTS.appeal],
  );
  // An Article by the same author, using an item its self-only work also holds.
  await db.query(
    "INSERT INTO community.media_items(id,owner_id,kind,quality_mode,source,state,declared_total_bytes) VALUES($1,$2,'static','standard','upload','awaiting_upload',1000)",
    [ids.articleItem, ids.author],
  );
  await db.query(
    `INSERT INTO community.work_revision_items(revision_id,item_id,position,edit) VALUES($1,$2,9,'{"rotation":0,"crop":null}'::jsonb)`,
    [ids.selfRevision, ids.articleItem],
  );
  const document = JSON.stringify({
    format: "blocknote",
    version: 1,
    blocks: [],
    references: { used: { type: "managed", itemId: ids.articleItem } },
    galleries: {},
  });
  await db.query(
    "INSERT INTO community.article_documents(id,owner_id,version,title,document,fingerprint,created_at,updated_at) VALUES($1,$2,1,'Article',$3::jsonb,$4,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
    [ids.mediaArticle, ids.author, document, "d".repeat(64)],
  );
  await db.query(
    "INSERT INTO community.article_revisions(article_id,version,owner_id,title,document,fingerprint,submitted_policy,submitted_by_source,created_at) VALUES($1,1,$2,'Article',$3::jsonb,$4,'PRE_MODERATION','human',CURRENT_TIMESTAMP)",
    [ids.mediaArticle, ids.author, document, "d".repeat(64)],
  );
  await db.query(
    "UPDATE community.article_documents SET version=2,status='pending',pending_version=1,updated_at=CURRENT_TIMESTAMP WHERE id=$1",
    [ids.mediaArticle],
  );
  // Flipped after the reports, as an author would: the flip touches nothing else.
  await db.query("UPDATE community.works SET visibility='self' WHERE id=$1", [
    ids.selfWork,
  ]);
  await db.query(
    "UPDATE community.works SET title='',text='',media_ids='{}',public_revision_id=NULL,author_revision_id=NULL,visibility='self',deleted_at=CURRENT_TIMESTAMP WHERE id=$1",
    [ids.deletedWork],
  );
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
  await seed();
  url.username = role;
  url.password = password;
  app = poolFor(url.toString());
  server = createBackendServer(
    createBackendApplication({
      nodeEnv: "development",
      communityIdentityPort: new PostgresCommunityIdentityAdapter(app),
      communityCommentPort: new PostgresCommunityCommentAdapter(app),
      discussionPort: new PostgresCommunityCommentAdapter(app),
      contentOperatorPort: new PostgresCommunityContentOperatorAdapter(app),
      reportingPort: new PostgresCommunityReportingAdapter(app),
      publishingOperatorPort: new PostgresPublishingOperatorAdapter(app),
      articlePublicationOperatorPort: new PostgresArticleAuthoringAdapter(app),
      threadPort: new PostgresThreadAdapter(app),
      feedbackPort: new PostgresFeedbackAdapter(app),
      directMessagePort: new PostgresDirectMessageAdapter(app),
      aiOperatorReader: new PostgresAiOperatorReader(app),
      communityOperatorCredential: ownerToken,
      operatorAiBaseCredential: baseToken,
      operatorAiCommunityCredential: communityToken,
      catalogQueryPort: createDevelopmentCatalogFixtureQueryPort(),
      storageUrlResolver: new UnconfiguredStorageUrlResolver(),
    }),
  );
  const address = await startServer(server, { host: "127.0.0.1", port: 0 });
  base = `http://${address.address}:${address.port}`;
}, 120_000);

afterAll(async () => {
  server?.closeAllConnections();
  if (server) await stopServer(server);
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

describe("a report as AI reads it", () => {
  it("shows the Owner everything, so these canaries are really there to find", async () => {
    const read = await owner(`reports/${ids.rightsReport}`);
    const report = operatorReportSchema.parse(read.json);
    expect(report.claimant?.contact).toBe(CANARY.contact);
    expect(report.evidence[0]?.fileName).toBe(CANARY.evidenceName);
    expect(report.evidence[0]?.downloadPath).toContain("/evidence/");
    expect((await owner(`reports/${ids.selfReport}`)).text).toContain(
      CANARY.selfReport,
    );
    expect(read.text).not.toContain("redacted");
  });

  it.each(["list", "get"])(
    "keeps rights-notice text and removes contact and evidence names on %s",
    async (how) => {
      const read =
        how === "get"
          ? await ai(`reports/${ids.rightsReport}`)
          : await ai(
              `reports?${query({ targetId: ids.publicWork, targetType: "work" })}`,
            );
      expect(read.status).toBe(200);
      const report = operatorReportAiSchema.parse(
        how === "get"
          ? read.json
          : operatorReportAiPageSchema
              .parse(read.json)
              .items.find(({ id }) => id === ids.rightsReport),
      );
      expect(report.claimant).toEqual({
        name: RIGHTS.name,
        rightsBasis: RIGHTS.basis,
      });
      expect(report.description).toBe(RIGHTS.description);
      expect(report.materials[0]?.text).toBe(RIGHTS.material);
      expect(report.appeal?.text).toBe(RIGHTS.appeal);
      expect(report.history.map(({ reason }) => reason).join(" ")).toContain(
        `Decision ${run}`,
      );
      // Count and type stay; the id, the name and the path do not.
      expect(report.evidence).toEqual([
        {
          mimeType: "application/pdf",
          size: 20,
          sensitive: true,
          createdAt: expect.any(String),
        },
      ]);
      expect(report.redacted).toEqual([
        "claimant.contact",
        "evidence.id",
        "evidence.fileName",
        "evidence.downloadPath",
      ]);
      expect(read.text).not.toContain(CANARY.contact);
      expect(read.text).not.toContain(CANARY.evidenceName);
      expect(read.text).not.toContain('"contact"');
      expect(read.text).not.toContain('"fileName"');
      expect(read.text).not.toContain('"downloadPath"');
      expect(read.text).not.toContain("/evidence/");
    },
  );

  it.each([
    ["a self-only work", () => ids.selfReport],
    ["a comment under one", () => ids.commentReport],
    ["a reply under one", () => ids.replyReport],
  ])("routes a report on %s to the Owner, with no text", async (_, id) => {
    const read = await ai(`reports/${id()}`);
    expect(read.status).toBe(200);
    expect(read.json).toEqual({
      id: id(),
      kind: expect.any(String),
      status: "open",
      ownerOnly: true,
      code: "SELF_ONLY_OWNER_REVIEW",
    });
    const listed = operatorReportAiPageSchema.parse(
      (await ai("reports?status=open&pageSize=100")).json,
    );
    expect(listed.items.find((item) => item.id === id())).toEqual(read.json);
    // The Owner's queue is as it was.
    expect((await owner(`reports/${id()}`)).json).toMatchObject({
      target: { id: expect.any(String) },
      snapshot: expect.any(Object),
    });
  });

  it("still routes a comment's case to the Owner once a purge took the comment's row", async () => {
    const purged = opaque("report");
    await setup.query(
      `INSERT INTO community.report_cases(id,reporter_id,target_type,target_id,canonical_path,snapshot,kind)
       VALUES($1,$2,'comment',$3,'/',$4::jsonb,'quick_comment')`,
      [
        purged,
        ids.reporter,
        opaque("comment"),
        JSON.stringify({
          text: "Synthetic",
          post: { type: "work", id: ids.selfWork, title: CANARY.selfTitle },
        }),
      ],
    );
    try {
      const read = await ai(`reports/${purged}`);
      expect(read.json).toMatchObject({ ownerOnly: true });
      expectNoCanary(read.text, "purged comment");
    } finally {
      await setup.query("DELETE FROM community.report_cases WHERE id=$1", [
        purged,
      ]);
    }
  });

  it("keeps a report on a permanently deleted work with AI", async () => {
    const read = await ai(`reports/${ids.deletedReport}`);
    const report = operatorReportAiSchema.parse(read.json);
    expect(report.description).toBe(`On a deleted work ${run}`);
    expect(report.target.id).toBe(ids.deletedWork);
  });

  it("reads back no withheld case's people, target or urgency by counting", async () => {
    const totalOf = async (filter: Record<string, string>) =>
      operatorReportAiPageSchema.parse(
        (await ai(`reports?${query(filter)}`)).json,
      );
    for (const filter of [
      { targetType: "work", targetId: ids.selfWork },
      { targetType: "comment", targetId: ids.selfComment },
      { reporterId: ids.reporter, targetId: ids.selfWork },
    ]) {
      const page = await totalOf(filter);
      expect(page.total, JSON.stringify(filter)).toBe(0);
      expect(page.items).toEqual([]);
    }
    const byAffected = await totalOf({ affectedUserId: ids.author });
    expect(byAffected.items.map(({ id }) => id).sort()).toEqual(
      [ids.rightsReport, ids.deletedReport].sort(),
    );
    const owners = (await totalOf({ urgent: "false", pageSize: "100" })).items;
    expect(owners.some((item) => "ownerOnly" in item)).toBe(false);
    // The same filter still finds them for the Owner.
    expect(
      (await owner(`reports?${query({ targetId: ids.selfWork })}`)).json,
    ).toMatchObject({ total: 1 });
  });

  it("follows current visibility: back to public, the case is AI's again", async () => {
    await setup.query(
      "UPDATE community.works SET visibility='public' WHERE id=$1",
      [ids.selfWork],
    );
    try {
      const report = operatorReportAiSchema.parse(
        (await ai(`reports/${ids.selfReport}`)).json,
      );
      expect(report.description).toBe(CANARY.selfReport);
    } finally {
      await setup.query(
        "UPDATE community.works SET visibility='self' WHERE id=$1",
        [ids.selfWork],
      );
    }
    expect((await ai(`reports/${ids.selfReport}`)).json).toMatchObject({
      ownerOnly: true,
    });
  });
});

/**
 * Every read row the community credential has, each with what would hit a withheld
 * row. A row added to the table with no entry here fails, so a new read path cannot
 * leak unnoticed. The Admin-side sweep repeats this through the registry.
 */
const readSweep = (): Readonly<Record<string, readonly string[]>> => {
  const canary = CANARY.selfTitle;
  return {
    "ai/find": [
      `ai/find?${query({ text: canary })}`,
      `ai/find?${query({ text: CANARY.comment })}`,
      `ai/find?${query({ text: CANARY.contact })}`,
      `ai/find?${query({ text: CANARY.evidenceName })}`,
      `ai/find?${query({ type: "work", id: ids.selfWork })}`,
      `ai/find?${query({ type: "comment", id: ids.selfComment })}`,
      `ai/find?${query({ type: "comment", id: ids.selfReply })}`,
      `ai/find?${query({ type: "work_revision", id: ids.selfRevision })}`,
      `ai/find?${query({ type: "report", id: ids.selfReport })}`,
    ],
    "ai/count": [
      `ai/count?${query({ source: "reports", groupBy: "kind" })}`,
      `ai/count?${query({ source: "comments", search: CANARY.comment })}`,
      `ai/count?${query({ source: "works", search: canary })}`,
      `ai/count?${query({ source: "work_submissions" })}`,
    ],
    reports: ["reports?pageSize=100", "reports?status=open&pageSize=100"],
    "reports/:id": [
      `reports/${ids.selfReport}`,
      `reports/${ids.commentReport}`,
      `reports/${ids.replyReport}`,
      `reports/${ids.rightsReport}`,
    ],
    feedback: ["feedback?pageSize=50"],
    "feedback/:id/images/:itemId/:variant": [
      `feedback/${ids.feedback}/images/${ids.item}/thumb`,
    ],
    works: [
      "works?pageSize=50",
      `works?${query({ search: canary })}`,
      `works?${query({ workId: ids.selfWork })}`,
      `works?${query({ authorId: ids.author })}`,
    ],
    users: [
      `users?${query({ userId: ids.author })}`,
      `users?${query({ search: run })}`,
    ],
    featured: [
      "featured?filter=all&pageSize=50",
      `featured?${query({ search: canary })}`,
    ],
    threads: ["threads?pageSize=50"],
    "publication-policy": ["publication-policy"],
    comments: [
      "comments?pageSize=50",
      `comments?${query({ search: CANARY.comment })}`,
      `comments?${query({ search: CANARY.reply })}`,
      `comments?${query({ authorId: ids.reporter })}`,
      `comments?${query({ catalogId: ids.selfWork })}`,
    ],
    "comments/:id": [
      `comments/${ids.selfComment}`,
      `comments/${ids.selfReply}`,
    ],
    "comments/:id/images/:itemId/:variant": [
      `comments/${ids.selfComment}/images/${ids.item}/thumb`,
    ],
    "moderation-events": [
      "moderation-events?pageSize=50",
      `moderation-events?${query({ subjectId: ids.selfComment })}`,
    ],
    summary: ["summary?range=30d"],
    "publishing/settings": ["publishing/settings"],
    "publishing/submissions": [
      "publishing/submissions?pageSize=50",
      "publishing/submissions?state=approved&pageSize=50",
      `publishing/submissions?${query({ workId: ids.selfWork })}`,
      `publishing/submissions?${query({ authorId: ids.author })}`,
    ],
    "publishing/submissions/:id": [
      `publishing/submissions/${ids.selfRevision}`,
    ],
    "publishing/media/:id/:itemId/:variant/:editKey": [
      `publishing/media/${ids.selfRevision}/${ids.item}/display/base`,
    ],
    "publishing/accounts/:id/capacity": [
      `publishing/accounts/${ids.author}/capacity`,
    ],
    "publishing/jobs": ["publishing/jobs?pageSize=50"],
    "ai/settlement": [
      `ai/settlement?${query({ type: "work", id: ids.selfWork, intent: "withdraw" })}`,
      `ai/settlement?${query({ type: "item", id: ids.item, intent: "withdraw" })}`,
      `ai/settlement?${query({ type: "user", id: ids.author, intent: "withdraw" })}`,
      `ai/settlement?${query({ type: "article", id: `article-${"0".repeat(32)}`, intent: "publish" })}`,
    ],
    "articles/submissions": ["articles/submissions"],
    "articles/:id/submission": [
      `articles/article-${"0".repeat(32)}/submission`,
    ],
    "articles/:id/submission-media": [
      `articles/article-${"0".repeat(32)}/submission-media?variant=display`,
    ],
  };
};

describe("the canary sweep", () => {
  it("covers every community read row, and none of them answers a withheld value", async () => {
    const sweep = readSweep();
    const rows = AI_OPERATOR_ROUTES.filter(
      ({ klass, credentials }) =>
        klass === "read" && credentials.includes("community"),
    ).map(({ path }) => path.replace("/internal/community/", ""));
    // A route with a row per query value is one route here.
    expect(Object.keys(sweep).sort()).toEqual([...new Set(rows)].sort());
    for (const routes of Object.values(sweep))
      for (const route of routes) {
        const read = await ai(route);
        // No media store here, so a byte route that gets that far answers 503.
        expect(read.status, route).not.toBe(500);
        expectNoCanary(read.text, route);
      }
  }, 60_000);

  it("is not blind: the Owner's token gets the same canaries back", async () => {
    const seen = new Set<string>();
    for (const route of [
      "works?pageSize=50",
      "comments?pageSize=50",
      `reports/${ids.selfReport}`,
      `reports/${ids.rightsReport}`,
      "publishing/submissions?pageSize=50",
      "moderation-events?pageSize=50",
    ]) {
      const { text } = await owner(route);
      for (const canary of WITHHELD)
        if (text.includes(canary)) seen.add(canary);
    }
    expect([...seen].sort()).toEqual(
      WITHHELD.filter((canary) => canary !== CANARY.commentReport).sort(),
    );
  }, 30_000);

  it("reveals nothing by a total: a search for withheld text counts zero", async () => {
    for (const [route, read] of [
      [
        `works?${query({ search: CANARY.selfText })}`,
        (body: { total: number }) => body.total,
      ],
      [
        `works?${query({ search: CANARY.revisionBody })}`,
        (body: { total: number }) => body.total,
      ],
      [
        `comments?${query({ search: CANARY.comment })}`,
        (body: { total: number }) => body.total,
      ],
      [
        `comments?${query({ search: CANARY.reply })}`,
        (body: { counts: { all: number } }) => body.counts.all,
      ],
      [
        `featured?${query({ search: CANARY.selfTitle })}`,
        (body: { total: number }) => body.total,
      ],
      [
        `ai/count?${query({ source: "works", search: CANARY.selfText })}`,
        (body: { total: number }) => body.total,
      ],
      [
        `ai/count?${query({ source: "comments", search: CANARY.comment })}`,
        (body: { total: number }) => body.total,
      ],
    ] as const) {
      const answer = await ai(route);
      expect(answer.status, route).toBe(200);
      expect((read as (body: unknown) => number)(answer.json), route).toBe(0);
    }
    expect(
      (await owner(`works?${query({ search: CANARY.selfText })}`)).json,
    ).toMatchObject({ total: 1 });
  });

  it("counts no withheld comment or event in the summary, and the Owner's stay as they were", async () => {
    const summaryOf = async (token: string) =>
      moderationSummarySchema.parse(
        (await get(token, "summary?range=30d")).json,
      );
    const [seen, whole] = await Promise.all([
      summaryOf(communityToken),
      summaryOf(ownerToken),
    ]);
    // The comment and its reply, both visible, and the one event on the comment.
    expect(whole.queue.visible - seen.queue.visible).toBe(2);
    expect(whole.actions.hide - seen.actions.hide).toBe(1);
    const events = (summary: typeof seen) =>
      summary.recentEvents.map(({ subjectId }) => subjectId);
    expect(events(whole)).toContain(ids.selfComment);
    expect(events(seen)).not.toContain(ids.selfComment);
  });

  it("keeps a contact out whatever header a caller sends", async () => {
    for (const route of [
      `reports/${ids.rightsReport}`,
      `reports?${query({ targetId: ids.publicWork, targetType: "work" })}`,
    ])
      for (const category of ["evidence", "self_only", "dm", "raw_ip"]) {
        const response = await fetch(`${base}/internal/community/${route}`, {
          headers: {
            authorization: `Bearer ${communityToken}`,
            "x-ai-sensitive": category,
          },
        });
        const text = await response.text();
        expect(response.status, route).toBe(200);
        expect(text).not.toContain(CANARY.contact);
        expect(text).not.toContain('"contact"');
      }
  });

  it("counts no withheld row in a user's own numbers", async () => {
    const page = operatorUserAiPageSchema.parse(
      (await ai(`users?${query({ userId: ids.author })}`)).json,
    );
    expect(page.items[0]).toMatchObject({
      id: ids.author,
      submittedWorks: 1,
      commentCount: 0,
      reportCount: 2,
    });
    const reporter = operatorUserAiPageSchema.parse(
      (await ai(`users?${query({ userId: ids.reporter })}`)).json,
    );
    expect(reporter.items[0]?.commentCount).toBe(1);
    // The Owner's shape is strict and has neither count.
    const seen = operatorUserPageSchema.parse(
      (await owner(`users?${query({ userId: ids.author })}`)).json,
    );
    expect(seen.items[0]?.submittedWorks).toBe(2);
  });
});

describe("a route naming a self-only record", () => {
  it.each([
    ["the comment", () => `comments/${ids.selfComment}`],
    ["the reply", () => `comments/${ids.selfReply}`],
    [
      "a comment image",
      () => `comments/${ids.selfComment}/images/${ids.item}/display`,
    ],
    [
      "a reply image",
      () => `comments/${ids.selfReply}/images/${ids.item}/thumb`,
    ],
    ["the submission", () => `publishing/submissions/${ids.selfRevision}`],
    [
      "submission bytes",
      () => `publishing/media/${ids.selfRevision}/${ids.item}/display/base`,
    ],
  ])(
    "refuses %s by name, and withheld never reads as not found",
    async (_, route) => {
      const read = await ai(route());
      expect(read.status).toBe(403);
      expect(read.code).toBe("SELF_ONLY_OWNER_REVIEW");
      expect(read.text).not.toContain(run);
      expect((await owner(route())).code).not.toBe("SELF_ONLY_OWNER_REVIEW");
    },
  );

  it("is the same id however a route spells it", async () => {
    const spelled = (id: string) => id.replace("-", "%2D");
    for (const route of [
      `comments/${spelled(ids.selfComment)}`,
      `comments/${spelled(ids.selfReply)}`,
      `publishing/submissions/${spelled(ids.selfRevision)}`,
      `publishing/media/${spelled(ids.selfRevision)}/${ids.item}/display/base`,
    ]) {
      const read = await ai(route);
      expect(read.status, route).toBe(403);
      expect(read.code, route).toBe("SELF_ONLY_OWNER_REVIEW");
    }
    const report = await ai(`reports/${spelled(ids.selfReport)}`);
    expect(report.json).toMatchObject({ ownerOnly: true });
    expectNoCanary(report.text, "spelled report");
    // Encoded twice it names no record, and reads nothing.
    const twice = await ai(`comments/${ids.selfComment.replace("-", "%252D")}`);
    expect(twice.status).toBe(404);
    expectNoCanary(twice.text, "twice");
  });

  it("refuses an Article's media while it uses an item of a self-only work, and follows the flip", async () => {
    const route = `articles/${ids.mediaArticle}/submission-media?${query({
      expectedVersion: "2",
      candidateVersion: "1",
      fingerprint: "d".repeat(64),
      refId: "used",
      variant: "display",
    })}`;
    const refused = await ai(route);
    expect(refused.status).toBe(403);
    expect(refused.code).toBe("SELF_ONLY_OWNER_REVIEW");
    expect((await owner(route)).code).not.toBe("SELF_ONLY_OWNER_REVIEW");
    await setup.query(
      "UPDATE community.works SET visibility='public' WHERE id=$1",
      [ids.selfWork],
    );
    try {
      expect((await ai(route)).code).not.toBe("SELF_ONLY_OWNER_REVIEW");
    } finally {
      await setup.query(
        "UPDATE community.works SET visibility='self' WHERE id=$1",
        [ids.selfWork],
      );
    }
  });

  it("does not refuse the same route on a public work", async () => {
    const comment = await ai(`comments/${ids.publicComment}`);
    expect(comment.status).toBe(200);
    expect(comment.text).toContain("Public comment");
    expect(
      (await ai(`publishing/submissions/${ids.publicRevision}`)).status,
    ).toBe(200);
    expect(
      (
        await ai(
          `publishing/media/${ids.publicRevision}/${ids.item}/display/base`,
        )
      ).code,
    ).not.toBe("SELF_ONLY_OWNER_REVIEW");
  });
});

describe("a pending Article's submission", () => {
  it("answers no resolved reference on a direct call with the AI token, and the Owner's keeps them", async () => {
    const article = opaque("article");
    const blank = emptyArticleDocument();
    const document = JSON.stringify({
      ...blank,
      blocks: [
        ...blank.blocks,
        {
          id: "used",
          type: "managedImage",
          props: { refId: "used", caption: "", alt: "Synthetic" },
          children: [],
        },
      ],
      references: { used: { type: "managed", itemId: ids.articleItem } },
    });
    await setup.query(
      "INSERT INTO community.article_documents(id,owner_id,version,title,document,fingerprint,created_at,updated_at) VALUES($1,$2,1,'Article',$3::jsonb,$4,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
      [article, ids.author, document, "d".repeat(64)],
    );
    await setup.query(
      "INSERT INTO community.article_revisions(article_id,version,owner_id,title,document,fingerprint,submitted_policy,submitted_by_source,created_at) VALUES($1,1,$2,'Article',$3::jsonb,$4,'PRE_MODERATION','human',CURRENT_TIMESTAMP)",
      [article, ids.author, document, "d".repeat(64)],
    );
    await setup.query(
      "UPDATE community.article_documents SET version=2,status='pending',pending_version=1,updated_at=CURRENT_TIMESTAMP WHERE id=$1",
      [article],
    );
    const route = `articles/${article}/submission`;
    const read = await ai(route);
    expect(read.status).toBe(200);
    expect(read.json).not.toHaveProperty("resolvedReferences");
    expect(articlePendingCandidateSchema.parse(read.json).articleId).toBe(
      article,
    );
    const seen = await owner(route);
    expect(seen.status).toBe(200);
    expect(seen.json).toHaveProperty("resolvedReferences.used");
  });
});

describe("a report on an Article retitled in private", () => {
  it("keeps the title its reporter saw, so the draft's reaches no read or search, and that title finds the case", async () => {
    const authoring = new PostgresArticleAuthoringAdapter(setup);
    const reporting = new PostgresCommunityReportingAdapter(setup);
    const actor = {
      source: "human" as const,
      userId: ids.author as PublicUserId,
    };
    const publicTitle = `publictitle${run}`;
    const draftTitle = `draftretitlecanary${run}`;
    const created = await authoring.create(
      actor,
      {
        requestId: randomUUID(),
        title: publicTitle,
        coverRefId: null,
        document: emptyArticleDocument(),
      },
      new Date(),
    );
    const published = await authoring.publish(
      actor,
      created.id,
      {
        requestId: randomUUID(),
        expectedVersion: created.version,
        fingerprint: created.fingerprint,
      },
      new Date(),
    );
    expect(published.status).toBe("published");
    await authoring.save(
      actor,
      created.id,
      {
        requestId: randomUUID(),
        expectedVersion: published.version,
        title: draftTitle,
        coverRefId: null,
        document: published.document,
      },
      new Date(),
    );
    const comment = opaque("comment");
    await setup.query(
      "INSERT INTO community.catalog_comments(id,catalog_id,target_type,author_id,text,moderation) VALUES($1,$2,'article',$3,'On an Article','visible')",
      [comment, created.id, ids.author],
    );
    const onArticle = await reporting.create(ids.reporter, {
      kind: "standard",
      target: { type: "article", id: created.id },
      reason: "other",
      requestId: randomUUID(),
    });
    const onComment = await reporting.create(ids.reporter, {
      kind: "quick_comment",
      target: { type: "comment", id: comment },
      requestId: randomUUID(),
    });
    try {
      for (const route of [
        `reports/${onArticle.id}`,
        `reports/${onComment.id}`,
        `reports?${query({ targetId: created.id, targetType: "article" })}`,
        `reports?${query({ targetId: comment, targetType: "comment" })}`,
        `ai/find?${query({ text: draftTitle, source: "reports" })}`,
      ]) {
        const read = await ai(route);
        expect(read.status, route).toBe(200);
        expect(read.text, route).not.toContain(draftTitle);
      }
      expect((await ai(`reports/${onArticle.id}`)).json).toMatchObject({
        snapshot: { title: publicTitle },
      });
      expect((await ai(`reports/${onComment.id}`)).json).toMatchObject({
        snapshot: { post: { title: publicTitle } },
      });
      expect((await owner(`reports/${onArticle.id}`)).json).toMatchObject({
        snapshot: { title: publicTitle },
      });
      expect(
        aiFindResultSchema
          .parse(
            (
              await ai(
                `ai/find?${query({ text: publicTitle, source: "reports" })}`,
              )
            ).json,
          )
          .items.map(({ id }) => id),
      ).toEqual([onArticle.id]);
    } finally {
      await setup.query(
        "DELETE FROM community.report_cases WHERE id=ANY($1::text[])",
        [[onArticle.id, onComment.id]],
      );
      await setup.query("DELETE FROM community.catalog_comments WHERE id=$1", [
        comment,
      ]);
    }
  });
});

describe("ai/find", () => {
  const find = async (values: Record<string, string>) => {
    const read = await ai(`ai/find?${query(values)}`);
    expect(read.status, JSON.stringify(values)).toBe(200);
    return aiFindResultSchema.parse(read.json);
  };

  it("resolves each kind of id exactly, in one branch, and says what it left out", async () => {
    for (const [type, id] of [
      ["user", ids.author],
      ["work", ids.publicWork],
      ["comment", ids.publicComment],
      ["thread", ids.thread],
      ["report", ids.rightsReport],
      ["feedback", ids.feedback],
      ["publishing_job", ids.job],
      ["work_revision", ids.publicRevision],
    ] as const) {
      const found = await find({ type, id });
      expect(found.items.map((item) => [item.type, item.id])).toEqual([
        [type, id],
      ]);
      expect(found.items[0]?.match).toEqual({ field: "id", kind: "identity" });
      expect(found.excluded).toEqual(["self_only"]);
      expect(Object.values(found.sources)).toEqual(["ok"]);
    }
    const handle = await find({ handle: `@author-${run}` });
    expect(handle.items[0]).toMatchObject({
      type: "user",
      id: ids.author,
      match: { field: "handle", kind: "identity" },
      disambiguators: { handle: `author-${run}` },
    });
  });

  it("answers a withheld record as none, with the same exclusion any answer has", async () => {
    for (const [type, id] of [
      ["work", ids.selfWork],
      ["comment", ids.selfComment],
      ["comment", ids.selfReply],
      ["work_revision", ids.selfRevision],
    ] as const) {
      const found = await find({ type, id });
      expect(found.items, id).toEqual([]);
      expect(found.excluded).toEqual(["self_only"]);
    }
    const report = await find({ type: "report", id: ids.selfReport });
    expect(report.items).toEqual([
      {
        type: "report",
        id: ids.selfReport,
        state: "open",
        disambiguators: {
          kind: "standard",
          ownerOnly: true,
          code: "SELF_ONLY_OWNER_REVIEW",
        },
        match: { field: "id", kind: "identity" },
      },
    ]);
  });

  it("keeps a private draft Article off this path, on the App role's own grants", async () => {
    const article = opaque("article");
    const withdrawn = opaque("article");
    const draftTitle = `draftarticlecanary${run}`;
    for (const [id, status] of [
      [article, "draft"],
      [withdrawn, "withdrawn"],
    ] as const)
      await setup.query(
        `INSERT INTO community.article_documents(id,owner_id,version,title,document,fingerprint,status,created_at,updated_at)
         VALUES($1,$2,2,$3,'{"format":"blocknote","version":"1"}'::jsonb,$4,$5,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
        [id, ids.author, draftTitle, "c".repeat(64), status],
      );
    const draft = await ai(
      `ai/find?${query({ type: "article", id: article })}`,
    );
    expect(draft.json).toEqual({
      items: [],
      sources: { article_documents: "ok" },
      excluded: ["private_draft"],
    });
    expect(draft.text).not.toContain(draftTitle);
    // Its working title may be a draft's, so a document past pending shows none.
    const found = await ai(
      `ai/find?${query({ type: "article", id: withdrawn })}`,
    );
    expect(found.json).toMatchObject({
      items: [{ id: withdrawn, state: "withdrawn" }],
    });
    expect(found.text).not.toContain(draftTitle);
    await setup.query(
      "DELETE FROM community.article_documents WHERE id=ANY($1::text[])",
      [[article, withdrawn]],
    );
  });

  it("reads a media item as content-free facts, and refuses one in a self-only work", async () => {
    const free = opaque("media-item");
    const held = opaque("media-item");
    for (const id of [free, held])
      await setup.query(
        "INSERT INTO community.media_items(id,owner_id,kind,quality_mode,source,state,declared_total_bytes) VALUES($1,$2,'static','standard','upload','awaiting_upload',1000)",
        [id, ids.author],
      );
    await setup.query(
      "INSERT INTO community.work_revision_items(revision_id,item_id,position,edit) VALUES($1,$2,1,'{}'::jsonb)",
      [ids.selfRevision, held],
    );
    const found = await find({ type: "media_item", id: free });
    expect(found.items).toEqual([
      {
        type: "media_item",
        id: free,
        state: "awaiting_upload",
        updatedAt: expect.any(String),
        disambiguators: { kind: "static", ownerId: ids.author },
        match: { field: "id", kind: "identity" },
      },
    ]);
    expect(found.sources).toEqual({ media_items: "ok" });
    expect((await find({ type: "media_item", id: held })).items).toEqual([]);
    await setup.query(
      "DELETE FROM community.work_revision_items WHERE item_id=$1",
      [held],
    );
    await setup.query(
      "DELETE FROM community.media_items WHERE id=ANY($1::text[])",
      [[free, held]],
    );
  });

  it("names a permanently deleted work, which holds no text", async () => {
    const found = await find({ type: "work", id: ids.deletedWork });
    expect(found.items[0]).toMatchObject({
      id: ids.deletedWork,
      disambiguators: { authorDeleted: true },
    });
    expect(found.items[0]?.title).toBeUndefined();
  });

  it("reads each branch and reports it, and searches rights notices but never contact or evidence names", async () => {
    const hit = await find({ text: RIGHTS.description });
    expect(hit.sources).toEqual({
      users: "ok",
      works: "ok",
      comments: "ok",
      threads: "ok",
      reports: "ok",
    });
    expect(hit.items.map(({ type, id }) => [type, id])).toEqual([
      ["report", ids.rightsReport],
    ]);
    for (const text of [
      RIGHTS.name,
      RIGHTS.basis,
      RIGHTS.material,
      RIGHTS.appeal,
    ])
      expect(
        (await find({ text, source: "reports" })).items.map(({ id }) => id),
        text,
      ).toEqual([ids.rightsReport]);
    for (const text of [CANARY.contact, CANARY.evidenceName])
      expect((await find({ text })).items, text).toEqual([]);
    for (const text of WITHHELD)
      expect((await find({ text })).items, text).toEqual([]);
  });

  it("takes whitespace as words in any order, and a percent or underscore as itself", async () => {
    const [first, second] = [RIGHTS.basis, RIGHTS.material];
    expect(
      (await find({ text: `${second}  ${first}`, source: "reports" })).items,
    ).toHaveLength(1);
    expect(
      (await find({ text: `${first} nosuchword${run}`, source: "reports" }))
        .items,
    ).toEqual([]);
    expect((await find({ text: "%", source: "threads" })).items).toEqual([]);
    expect(
      (await find({ text: `author-${run}`, source: "users" })).items[0]?.match,
    ).toEqual({ field: "handle", kind: "identity" });
  });

  it("bounds every branch where the SQL runs: a blocked one times out alone, and its statement is gone", async () => {
    const blocker = await setup.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "LOCK TABLE community.threads IN ACCESS EXCLUSIVE MODE",
      );
      const started = Date.now();
      const found = await find({ text: RIGHTS.description });
      expect(found.sources).toEqual({
        users: "ok",
        works: "ok",
        comments: "ok",
        threads: "timed_out",
        reports: "ok",
      });
      expect(found.items.map(({ id }) => id)).toEqual([ids.rightsReport]);
      expect(Date.now() - started).toBeLessThan(10_000);
      // Still holding the lock: nothing of that branch is waiting on it any more.
      const waiting = await setup.query(
        "SELECT count(*)::integer AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
      );
      expect(waiting.rows[0].n).toBe(0);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
  }, 30_000);
});

describe("ai/count", () => {
  const count = async (values: Record<string, string>) => {
    const read = await ai(`ai/count?${query(values)}`);
    expect(read.status, JSON.stringify(values)).toBe(200);
    return aiCountResultSchema.parse(read.json);
  };

  it("answers M1 in one read: unresolved cases by kind, and how long the oldest has waited", async () => {
    const answer = await count({
      source: "reports",
      unresolved: "true",
      groupBy: "kind",
    });
    const sql = await setup.query(
      "SELECT kind,count(*)::integer AS n,min(created_at) AS oldest FROM community.report_cases WHERE status<>'resolved' GROUP BY kind",
    );
    expect(answer.total).toBe(
      sql.rows.reduce((sum, row) => sum + Number(row.n), 0),
    );
    expect(
      Object.fromEntries(answer.groups!.map((g) => [g.value, g.count])),
    ).toEqual(Object.fromEntries(sql.rows.map((row) => [row.kind, row.n])));
    expect(answer.oldestAt).toBe(
      new Date(
        Math.min(...sql.rows.map((row) => row.oldest.getTime())),
      ).toISOString(),
    );
  });

  it.each([
    ["reports", "reports?pageSize=1", {}],
    ["reports", "reports?pageSize=1&status=open", { status: "open" }],
    ["comments", "comments?pageSize=1", {}],
    ["works", "works?pageSize=1", {}],
    ["users", "users?pageSize=1", {}],
    ["work_submissions", "publishing/submissions?pageSize=1", {}],
    ["jobs", "publishing/jobs?pageSize=1", {}],
  ] as const)(
    "answers %s with its list's own total",
    async (source, list, filter) => {
      const page = (await ai(list)).json as { total: number };
      expect((await count({ source, ...filter })).total, list).toBe(page.total);
    },
  );

  it("reads no withheld case's reason or target back through a group", async () => {
    const byReason = await count({ source: "reports", groupBy: "reason" });
    const groups = Object.fromEntries(
      byReason.groups!.map(({ value, count: n }) => [value, n]),
    );
    expect(groups).toEqual({ copyright: 1, other: 1 });
    const byTarget = await count({ source: "reports", groupBy: "targetType" });
    expect(byTarget.groups!.map(({ value }) => value)).toEqual(["work"]);
    expect((await count({ source: "reports", groupBy: "kind" })).total).toBe(5);
    // Each says so, whatever the rows hold, because the query alone decides it.
    expect(byReason.leavesOutOwnerOnly).toBe(true);
    expect(byTarget.leavesOutOwnerOnly).toBe(true);
    for (const asked of [
      { source: "reports", groupBy: "kind" },
      { source: "reports", groupBy: "status" },
      { source: "reports" },
      { source: "comments", groupBy: "kind" },
    ] as const)
      expect(await count(asked)).not.toHaveProperty("leavesOutOwnerOnly");
    expect(
      await count({ source: "reports", groupBy: "kind", urgent: "false" }),
    ).toMatchObject({ leavesOutOwnerOnly: true });
  });

  it("says on the report list what it says on a count, by the query alone", async () => {
    const listed = async (query: string) =>
      operatorReportAiPageSchema.parse((await ai(`reports?${query}`)).json);
    for (const query of [
      "targetType=work",
      "urgent=false",
      `reporterId=user-${"0".repeat(32)}`,
    ])
      expect(await listed(query), query).toMatchObject({
        leavesOutOwnerOnly: true,
      });
    for (const query of ["pageSize=5", "status=open", "unresolved=true"])
      expect(await listed(query), query).not.toHaveProperty(
        "leavesOutOwnerOnly",
      );
  });

  it("answers no number when it runs out of time", async () => {
    const blocker = await setup.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "LOCK TABLE community.publishing_jobs IN ACCESS EXCLUSIVE MODE",
      );
      const read = await ai("ai/count?source=jobs");
      expect(read.status).toBe(503);
      expect(read.code).toBe("READ_TIMED_OUT");
      expect(read.text).not.toContain("total");
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
  }, 30_000);
});

describe("additive filters", () => {
  const itemsOf = async (route: string) => {
    const read = await ai(route);
    expect(read.status, route).toBe(200);
    return (read.json as { items: { id?: string; revisionId?: string }[] })
      .items;
  };

  it("narrow works by id and time", async () => {
    expect(
      (await itemsOf(`works?${query({ workId: ids.publicWork })}`)).map(
        ({ id }) => id,
      ),
    ).toEqual([ids.publicWork]);
    expect(
      await itemsOf(
        `works?${query({ workId: ids.publicWork, to: "2001-01-01T00:00:00+08:00" })}`,
      ),
    ).toEqual([]);
    expect(
      await itemsOf(
        `works?${query({ workId: ids.publicWork, from: "2001-01-01T00:00:00Z" })}`,
      ),
    ).toHaveLength(1);
  });

  it("narrow comments by author and time", async () => {
    const mine = await itemsOf(`comments?${query({ authorId: ids.reporter })}`);
    expect(mine.map(({ id }) => id)).toEqual([ids.publicComment]);
    expect(
      await itemsOf(`comments?${query({ authorId: ids.author })}`),
    ).toEqual([]);
    expect(
      await itemsOf(
        `comments?${query({ authorId: ids.reporter, to: "2001-01-01T00:00:00Z" })}`,
      ),
    ).toEqual([]);
  });

  it("narrow threads, feedback, submissions and jobs", async () => {
    expect(
      (await itemsOf(`threads?${query({ search: `thread ${run}` })}`)).map(
        ({ id }) => id,
      ),
    ).toEqual([ids.thread]);
    expect(
      await itemsOf(`threads?${query({ search: `nosuch${run}` })}`),
    ).toEqual([]);
    expect(
      (await itemsOf(`feedback?${query({ userId: ids.reporter })}`)).map(
        ({ id }) => id,
      ),
    ).toEqual([ids.feedback]);
    expect(await itemsOf(`feedback?${query({ userId: ids.author })}`)).toEqual(
      [],
    );
    expect(
      (
        await itemsOf(
          `publishing/submissions?${query({ workId: ids.publicWork })}`,
        )
      ).map(({ revisionId }) => revisionId),
    ).toEqual([ids.publicRevision]);
    expect(
      (
        await itemsOf(
          `publishing/submissions?${query({ authorId: ids.author })}`,
        )
      ).map(({ revisionId }) => revisionId),
    ).toEqual([ids.publicRevision]);
    expect(
      (await itemsOf(`publishing/jobs?${query({ subjectId: ids.item })}`)).map(
        ({ id }) => id,
      ),
    ).toEqual([ids.job]);
    expect(
      await itemsOf(`publishing/jobs?${query({ subjectId: `none${run}` })}`),
    ).toEqual([]);
  });

  it("use the new indexes for a target, an affected user and a feedback author", async () => {
    const plan = async (sql: string, value: string) => {
      const db = await setup.connect();
      try {
        await db.query("BEGIN");
        await db.query("SET LOCAL enable_seqscan=off");
        const rows = await db.query(`EXPLAIN ${sql}`, [value]);
        await db.query("ROLLBACK");
        return rows.rows.map((row) => row["QUERY PLAN"]).join("\n");
      } finally {
        db.release();
      }
    };
    expect(
      await plan(
        "SELECT id FROM community.report_cases WHERE target_type='work' AND target_id=$1 ORDER BY created_at DESC",
        ids.publicWork,
      ),
    ).toContain("report_cases_target_created");
    expect(
      await plan(
        "SELECT id FROM community.report_cases WHERE affected_user_id=$1 ORDER BY created_at DESC",
        ids.author,
      ),
    ).toContain("report_cases_affected_created");
    expect(
      await plan(
        "SELECT id FROM community.feedback WHERE user_id=$1 ORDER BY created_at DESC",
        ids.reporter,
      ),
    ).toContain("feedback_user_created");
  });
});

describe("the comment queue's withholding", () => {
  it("reads one set per statement, not one lookup per row, on its list and its search", async () => {
    const statements: string[] = [];
    const watched = <Target extends object>(target: Target) =>
      new Proxy(target, {
        get: (held, name) => {
          const value = Reflect.get(held, name) as unknown;
          if (name !== "query") return value;
          return (...args: unknown[]) => {
            statements.push(String(args[0]));
            return (value as (...call: unknown[]) => unknown).apply(held, args);
          };
        },
      });
    const pool = {
      query: (...args: unknown[]) =>
        (watched(setup).query as (...call: unknown[]) => unknown)(...args),
      connect: async () => watched(await setup.connect()),
    } as unknown as Pool;
    const scope = { withholdSelfOnly: true };
    const listed = await new PostgresCommunityCommentAdapter(
      pool,
    ).readOperatorComments({ page: 1, pageSize: 20, order: "newest" }, scope);
    await new PostgresAiOperatorReader(pool).find({
      text: "Public comment",
      source: "comments",
      limit: 5,
    });
    const scans = statements.filter((text) => text.includes("so_w"));
    // The page, its total and its tab counts, and the search's one branch.
    expect(scans.length).toBeGreaterThanOrEqual(4);
    for (const text of scans) {
      expect(text).toContain("IN (SELECT so_w.id FROM community.works so_w");
      expect(text).not.toContain("so_w.id=");
    }
    // The same total as before: every comment and reply but what the work withholds.
    const { rows } = await setup.query(
      `SELECT count(*)::integer AS n FROM (
         SELECT c.catalog_id,c.target_type FROM community.catalog_comments c
         UNION ALL SELECT c.catalog_id,c.target_type FROM community.catalog_comment_replies r
           JOIN community.catalog_comments c ON c.id=r.root_comment_id) e
       LEFT JOIN community.works w ON w.id=e.catalog_id AND e.target_type='work'
       WHERE w.id IS NULL OR NOT (w.visibility='self' AND w.deleted_at IS NULL)`,
    );
    expect(listed.total).toBe(rows[0]!.n);
    expect(listed.items.map(({ id }) => id)).not.toContain(ids.selfComment);
  });
});

describe("a bad input on the AI path", () => {
  it.each([
    ["a NUL in a search", "works?search=%00"],
    ["a NUL in find", "ai/find?text=a%00b"],
    ["a NUL in an id", `reports/report-%00`],
    ["a NUL in a comment id", "comments/comment-%00"],
    [
      "a range ending before it starts",
      "works?from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z",
    ],
    ["an impossible date", "works?from=2026-02-30T00:00:00Z"],
    ["year zero", "comments?from=0000-01-01T00:00:00Z"],
    ["an offset past 15:59", "comments?from=2026-01-01T00:00:00%2B16:00"],
    ["a negative offset past 15:59", "works?to=2026-01-01T00:00:00-23:00"],
    ["no seconds and such an offset", "comments?from=2026-01-01T00:00%2B23:00"],
    [
      "such an offset on a count",
      "ai/count?source=comments&from=2026-01-01T00:00:00%2B23:00",
    ],
    [
      "a time longer than PostgreSQL's field buffer",
      `comments?from=2026-01-01T00:00:00.${"1".repeat(200)}Z`,
    ],
    ["an unknown filter", "reports?nosuch=1"],
    ["a page out of range", "works?page=9999999"],
    ["an unknown count source", "ai/count?source=nosuch"],
    ["a count group from elsewhere", "ai/count?source=jobs&groupBy=visibility"],
    ["find with no query", "ai/find"],
    ["find with a doubled text", "ai/find?text=a&text=b"],
    [
      "find with more than 32 words",
      `ai/find?${query({ text: Array.from({ length: 33 }, (_, i) => `w${i}`).join(" ") })}`,
    ],
    ["a find limit out of range", "ai/find?text=a&limit=227"],
    ["an inherited key on reports", "reports?constructor=1"],
    ["an inherited key on works", "works?constructor=1"],
    ["a prototype key on comments", "comments?__proto__=1"],
    ["an inherited key on find", "ai/find?toString=1"],
    ["a forged cursor", "articles/submissions?cursor=forged"],
    ["a forged job state", "publishing/jobs?state=nosuch"],
    ["an impossible page size", "comments?pageSize=51"],
  ])("answers a named refusal for %s", async (_, route) => {
    const read = await ai(route);
    expect(read.status, route).toBe(400);
    expect(read.code, route).toMatch(/^[A-Z_]+$/u);
  });

  it("still reads the offsets PostgreSQL holds", async () => {
    for (const route of [
      "comments?from=2026-01-01T00:00:00%2B15:59",
      "works?to=2026-01-01T00:00:00-15:59",
      "ai/count?source=comments&from=2026-01-01T00:00:00%2B15:59",
    ])
      expect((await ai(route)).status, route).toBe(200);
  });

  it("answers a malformed escape and an unknown id as a missing subject", async () => {
    expect((await ai("reports/%E0%A4%A")).status).toBe(404);
    expect((await ai(`reports/report-${"0".repeat(32)}`)).code).toBe(
      "NOT_FOUND",
    );
    expect((await ai(`comments/comment-${"0".repeat(32)}`)).code).toBe(
      "NOT_FOUND",
    );
    expect((await ai("publishing/submissions/nosuch")).code).toBe("NOT_FOUND");
  });
});

// Last, because its rows stay: the totals above count this database's comments and cases.
describe("a deleted work that still holds its text", () => {
  /** A work its author made self-only or not, then trashed, then the trash purge ran. */
  const trashPurged = async (visibility: "self" | "public") => {
    const canary = `purged${visibility}canary${randomBytes(4).toString("hex")}`;
    const work = opaque("work");
    const revision = opaque("work-revision");
    const comment = opaque("comment");
    await setup.query(
      "INSERT INTO community.works(id,author_id,title,text,first_published_at) VALUES($1,$2,$3,$3,CURRENT_TIMESTAMP)",
      [work, ids.author, canary],
    );
    await setup.query(
      `INSERT INTO community.work_revisions(id,work_id,author_id,sequence,origin,title,body,authorship_kind,requested_visibility,content_sha256,disposition,submitted_at)
       VALUES($1,$2,$3,50,'submission',$4,$4,'original','public',$5,'pending',CURRENT_TIMESTAMP)`,
      [revision, work, ids.author, canary, "a".repeat(64)],
    );
    await setup.query(
      "INSERT INTO community.catalog_comments(id,catalog_id,target_type,author_id,text,moderation) VALUES($1,$2,'work',$3,$4,'visible')",
      [comment, work, ids.reporter, canary],
    );
    const { id: report } = await new PostgresCommunityReportingAdapter(
      setup,
    ).create(ids.reporter, {
      kind: "standard",
      target: { type: "work", id: work },
      reason: "other",
      description: canary,
      requestId: randomUUID(),
    });
    await setup.query(
      "UPDATE community.works SET visibility=$2,trashed_at=CURRENT_TIMESTAMP-interval '31 days',trash_purge_after=CURRENT_TIMESTAMP-interval '1 day' WHERE id=$1",
      [work, visibility],
    );
    expect(
      await new PostgresWorkPublishingAdapter(app).purgeTrashedWork(
        work,
        new Date(),
      ),
    ).toBe("purged");
    return { canary, work, revision, comment, report };
  };

  it.each(["self", "public"] as const)(
    "withholds a work trashed and purged as %s, which still holds its text, on every read",
    async (visibility) => {
      const { canary, work, revision, comment, report } =
        await trashPurged(visibility);
      const { rows } = await setup.query(
        "SELECT title,text,deleted_at FROM community.works WHERE id=$1",
        [work],
      );
      expect(rows[0]!.title).toBe(canary);
      expect(rows[0]!.deleted_at).not.toBeNull();
      for (const route of [
        `ai/find?${query({ text: canary })}`,
        `ai/find?${query({ text: canary, source: "works" })}`,
        `ai/find?${query({ text: canary, source: "comments" })}`,
        `ai/find?${query({ text: canary, source: "reports" })}`,
        `ai/find?${query({ type: "work", id: work })}`,
        `ai/find?${query({ type: "comment", id: comment })}`,
        `ai/find?${query({ type: "work_revision", id: revision })}`,
        `ai/find?${query({ type: "report", id: report })}`,
        `ai/count?${query({ source: "works", search: canary })}`,
        `ai/count?${query({ source: "comments", search: canary })}`,
        `works?${query({ search: canary })}`,
        `works?${query({ workId: work })}`,
        `featured?${query({ search: canary })}`,
        `comments?${query({ search: canary })}`,
        `comments?${query({ catalogId: work })}`,
        `comments/${comment}`,
        `reports/${report}`,
        "reports?pageSize=100",
        `publishing/submissions/${revision}`,
        `publishing/submissions?${query({ workId: work })}`,
      ]) {
        const read = await ai(route);
        expect(read.status, route).not.toBe(500);
        expect(read.text, route).not.toContain(canary);
      }
      expect((await ai(`comments/${comment}`)).code).toBe(
        "SELF_ONLY_OWNER_REVIEW",
      );
      expect((await ai(`reports/${report}`)).json).toMatchObject({
        ownerOnly: true,
      });
      // Not blind: the row is there, and the Owner reads it as ever.
      expect((await owner(`works?${query({ workId: work })}`)).text).toContain(
        canary,
      );
    },
  );
});
