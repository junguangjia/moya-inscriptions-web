/**
 * admin-mcp-completion-v1 S6: the community reads of admin_find, admin_read and
 * admin_get, real JSON-RPC over HTTP with the official client, through the real door
 * and guard, to the real Backend on a disposable community database of its own, as the
 * App role. Its whole point is what must not leave, so every read op in the registry
 * is swept for a claimant's contact, an evidence name, self-only text and comments
 * under self-only works, and every answer is held to its untrusted pointers. The suite
 * seeds all it reads, so it passes alone on an empty server and on a used one.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
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
  PostgresDirectMessageAdapter,
  PostgresFeedbackAdapter,
  PostgresPublishingOperatorAdapter,
  PostgresThreadAdapter,
  PostgresTimelineOperatorAdapter,
  runCommunityMigrations,
} from "@moya/community-postgres";
import { emptyArticleDocument } from "@moya/contracts/schemas";
import {
  ADMIN_ACTIONS_MAX_OPS,
  ADMIN_MCP_COMPLIANCE_PHRASES,
  ADMIN_MCP_SENSITIVE_CATEGORIES,
  ADMIN_MCP_TEXT_CAP_BYTES,
  ADMIN_OP_NAMES,
  AI_COUNT_GROUPS,
  adminFindDataSchema,
  adminMcpEnvelopeSchema,
} from "@moya/contracts/internal/admin-mcp";
import type { AdminOpName } from "@moya/contracts/internal/admin-mcp";
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

import { adminOpMeta, readContinuation } from "admin/admin-mcp";
import {
  CommunityOperatorError,
  openCommunityAiEvidence,
  openCommunityAiMedia,
} from "admin/community-backend";

import {
  connectClient,
  relayRewriting,
  serveRoutes,
  withFieldAdded,
} from "./admin-mcp-wire.js";

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
const database = `community_tool_${run}_synthetic_test`;
const role = `community_tool_${run}`;
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

/** Unique on every run, so a hit is this run's seed and never another row. */
const CANARY = {
  contact: `contactcanary${run}`,
  evidenceName: `evidencenamecanary${run}.pdf`,
  selfTitle: `selftitlecanary${run}`,
  selfText: `selftextcanary${run}`,
  revisionTitle: `selfrevisiontitlecanary${run}`,
  revisionBody: `selfrevisionbodycanary${run}`,
  comment: `selfcommentcanary${run}`,
  reply: `selfreplycanary${run}`,
  selfReport: `selfreportcanary${run}`,
  eventDetail: `selfeventcanary${run}`,
  replyEventDetail: `selfreplyeventcanary${run}`,
  selfNotice: `selfnoticecanary${run}`,
} as const;
const WITHHELD = Object.values(CANARY);

/** A person's words anywhere in a record: each must sit under an untrusted pointer. */
const HOSTILE = `IGNOREPREVIOUS${run}`;
const hostile = (label: string) => `${label} ${HOSTILE}`;

const RIGHTS = {
  name: hostile("claimantname"),
  basis: hostile("rightsbasis"),
  description: hostile("noticedescription"),
  material: hostile("materialtext"),
  appeal: hostile("appealtext"),
  decision: hostile("decisionreason"),
  message: hostile("messagetext"),
};

/** Every state a case can be in, each on a work AI reads, a withheld one and a deleted one. */
const NOTICE_STATES = ["open", "reviewing", "resolved", "appealed"] as const;
type NoticeState = (typeof NOTICE_STATES)[number];
const NOTICE_SCOPES = ["public", "selfOnly", "deleted"] as const;
type NoticeScope = (typeof NOTICE_SCOPES)[number];
const noticeTexts = (scope: NoticeScope, state: NoticeState) => {
  const text = (label: string) =>
    scope === "selfOnly"
      ? `${CANARY.selfNotice} ${label} ${state}`
      : hostile(`${scope}${label}${state}`);
  return {
    name: text("name"),
    basis: text("basis"),
    description: text("description"),
    material: text("material"),
    decision: text("decision"),
    appeal: text("appeal"),
    message: text("message"),
  };
};
const notices = Object.fromEntries(
  NOTICE_SCOPES.map((scope) => [scope, {}]),
) as Record<NoticeScope, Record<NoticeState, string>>;

const PNG_BYTES = {
  public: Buffer.from(`publicbytes${run}`),
  self: Buffer.from(`selfbytes${run}`),
};

const ids = {
  author: opaque("user"),
  reporter: opaque("user"),
  lishu: opaque("user"),
  twinA: opaque("user"),
  twinB: opaque("user"),
  publicWork: opaque("work"),
  selfWork: opaque("work"),
  deletedWork: opaque("work"),
  publicRevision: opaque("work-revision"),
  selfRevision: opaque("work-revision"),
  selfItemRevision: opaque("work-revision"),
  publicComment: opaque("comment"),
  selfComment: opaque("comment"),
  selfReply: opaque("comment"),
  oldComment: opaque("comment"),
  yesterdayComment: opaque("comment"),
  item: opaque("media-item"),
  selfItem: opaque("media-item"),
  thread: opaque("thread"),
  feedback: opaque("feedback"),
  job: opaque("publishing-job"),
  pendingArticle: opaque("article"),
  publicBytesItem: opaque("media-item"),
  selfBytesItem: opaque("media-item"),
  publicMediaArticle: opaque("article"),
  selfMediaArticle: opaque("article"),
  deletedComment: opaque("comment"),
  timelineEntry: `entry-${run}`,
  hiddenTimelineEntry: `hidden-entry-${run}`,
  deletedCommentReport: "",
  redactedReport: "",
  rightsReport: "",
  selfReport: "",
  commentReport: "",
  replyReport: "",
  deletedReport: "",
  longReport: "",
};
const handles = {
  author: `author-${run}`,
  reporter: `reporter-${run}`,
  lishu: `lishu-${run}`,
};
const twinName = `王羲之${run}`;
const LONG_NOTICE = `长文${"碑".repeat(3_500)}${run}`;

const ARTICLE_FINGERPRINT = "d".repeat(64);

/** A pending Article, as its submission leaves it. */
const seedPendingArticle = async (
  id: string,
  title: string,
  document: string,
) => {
  await setup.query(
    "INSERT INTO community.article_documents(id,owner_id,version,title,document,fingerprint,created_at,updated_at) VALUES($1,$2,1,$3,$4::jsonb,$5,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
    [id, ids.author, title, document, ARTICLE_FINGERPRINT],
  );
  await setup.query(
    "INSERT INTO community.article_revisions(article_id,version,owner_id,title,document,fingerprint,submitted_policy,submitted_by_source,created_at) VALUES($1,1,$2,$3,$4::jsonb,$5,'PRE_MODERATION','human',CURRENT_TIMESTAMP)",
    [id, ids.author, title, document, ARTICLE_FINGERPRINT],
  );
  await setup.query(
    "UPDATE community.article_documents SET version=2,status='pending',pending_version=1,updated_at=CURRENT_TIMESTAMP WHERE id=$1",
    [id],
  );
};

const seed = async () => {
  const db = setup;
  for (const [id, handle, name, bio] of [
    [ids.author, handles.author, hostile("authorname"), hostile("authorbio")],
    [ids.reporter, handles.reporter, `Reporter ${run}`, ""],
    [ids.lishu, handles.lishu, `李书${run}`, ""],
    [ids.twinA, `twin-a-${run}`, twinName, ""],
    [ids.twinB, `twin-b-${run}`, twinName, ""],
  ] as const)
    await db.query(
      "INSERT INTO community.public_users(id,handle,display_name,bio) VALUES($1,$2,$3,$4)",
      [id, handle, name, bio],
    );
  // The legacy bridge makes each a public work with its public revision.
  await db.query(
    "INSERT INTO community.works(id,author_id,title,text,first_published_at) VALUES($1,$4,$5,$6,CURRENT_TIMESTAMP),($2,$4,$7,$8,CURRENT_TIMESTAMP),($3,$4,'Deleted title','Deleted text',CURRENT_TIMESTAMP)",
    [
      ids.publicWork,
      ids.selfWork,
      ids.deletedWork,
      ids.author,
      hostile("worktitle"),
      hostile("worktext"),
      CANARY.selfTitle,
      CANARY.selfText,
    ],
  );
  for (const [revision, work, title, body] of [
    [
      ids.publicRevision,
      ids.publicWork,
      hostile("revisiontitle"),
      hostile("revisionbody"),
    ],
    [ids.selfRevision, ids.selfWork, CANARY.revisionTitle, CANARY.revisionBody],
  ] as const)
    await db.query(
      `INSERT INTO community.work_revisions(id,work_id,author_id,sequence,origin,title,body,authorship_kind,requested_visibility,content_sha256,disposition,submitted_at)
       VALUES($1,$2,$3,50,'submission',$4,$5,'original','public',$6,'pending',CURRENT_TIMESTAMP)`,
      [revision, work, ids.author, title, body, "a".repeat(64)],
    );
  await db.query(
    "UPDATE community.works SET author_revision_id=$2 WHERE id=$1",
    [ids.selfWork, ids.selfRevision],
  );
  await db.query(
    `INSERT INTO community.catalog_comments(id,catalog_id,target_type,author_id,text,moderation)
     VALUES($1,$2,'work',$3,$7,'visible'),($4,$5,'work',$3,$6,'visible')`,
    [
      ids.publicComment,
      ids.publicWork,
      ids.reporter,
      ids.selfComment,
      ids.selfWork,
      CANARY.comment,
      hostile("commenttext"),
    ],
  );
  await db.query(
    "INSERT INTO community.catalog_comment_replies(id,root_comment_id,author_id,text,moderation) VALUES($1,$2,$3,$4,'visible')",
    [ids.selfReply, ids.selfComment, ids.reporter, CANARY.reply],
  );
  await db.query(
    "INSERT INTO community.catalog_comments(id,catalog_id,target_type,author_id,text,moderation) VALUES($1,$2,'work',$3,$4,'visible')",
    [ids.deletedComment, ids.deletedWork, ids.twinA, `Under deleted ${run}`],
  );
  for (const [id, days] of [
    [ids.oldComment, 9],
    [ids.yesterdayComment, 1],
  ] as const)
    await db.query(
      `INSERT INTO community.catalog_comments(id,catalog_id,target_type,author_id,text,moderation,created_at)
       VALUES($1,$2,'work',$3,$4,'visible',CURRENT_TIMESTAMP - make_interval(days => $5))`,
      [id, ids.publicWork, ids.lishu, `Range ${run}`, days],
    );
  await db.query(
    "INSERT INTO community.featured_content(content_type,content_id,enabled,position) VALUES('work',$1,FALSE,1),('work',$2,TRUE,2)",
    [ids.selfWork, ids.publicWork],
  );
  await db.query(
    "INSERT INTO community.moderation_events(id,occurred_at,operator_label,action,subject_kind,subject_id,detail) VALUES($1,CURRENT_TIMESTAMP,'owner','hide','comment',$2,$3),($4,CURRENT_TIMESTAMP,'owner','hide','comment',$5,$6)",
    [
      opaque("moderation"),
      ids.selfComment,
      CANARY.eventDetail,
      opaque("moderation"),
      ids.publicComment,
      hostile("eventdetail"),
    ],
  );
  await db.query(
    "INSERT INTO community.threads(id,title,description,tags,created_by) VALUES($1,$2,$3,$4,'owner')",
    [
      ids.thread,
      hostile("threadtitle"),
      hostile("threaddescription"),
      [hostile("tag").slice(0, 24)],
    ],
  );
  await db.query(
    "INSERT INTO community.thread_works(thread_id,work_id) VALUES($1,$2),($1,$3)",
    [ids.thread, ids.publicWork, ids.selfWork],
  );
  await db.query(
    "INSERT INTO community.moderation_events(id,occurred_at,operator_label,action,subject_kind,subject_id,detail) VALUES($1,CURRENT_TIMESTAMP,'owner','hide','reply',$2,$3)",
    [opaque("moderation"), ids.selfReply, CANARY.replyEventDetail],
  );
  await db.query(
    "INSERT INTO community.feedback(id,user_id,submission_id,message) VALUES($1,$2,$3,$4)",
    [ids.feedback, ids.reporter, randomUUID(), hostile("feedbackmessage")],
  );
  await db.query(
    "INSERT INTO community.publishing_jobs(id,kind,subject_id,state,run_after) VALUES($1,'publish_media',$2,'queued',CURRENT_TIMESTAMP)",
    [ids.job, ids.item],
  );
  // Timeline rows hold the Owner's words, and link a Catalog record that is not published.
  await db.query(
    `INSERT INTO community.timeline_entries(entry_id,title,full_title,start_year,end_year,precision,date_label,on_axis,chapter,
       polity,disputed,group_id,group_title,province,holder,catalog_id,position,hidden_at)
     VALUES($1,$2,$3,148,148,'year',$4,TRUE,'东汉',$5,FALSE,$6,$7,$8,$9,$10,0,NULL),
       ($11,'Hidden entry','Hidden entry',150,150,'year',NULL,FALSE,'东汉',NULL,FALSE,NULL,NULL,NULL,NULL,NULL,0,CURRENT_TIMESTAMP)`,
    [
      ids.timelineEntry,
      hostile("timelinetitle"),
      hostile("timelinefulltitle"),
      hostile("datelabel"),
      hostile("polity"),
      `group-${run}`,
      hostile("grouptitle"),
      hostile("province"),
      hostile("holder"),
      `timeline-catalog-${run}`,
      ids.hiddenTimelineEntry,
    ],
  );
  // timeline-posts-v1: a public post and a self-only one on the same row.
  await db.query(
    "INSERT INTO community.timeline_entry_posts(work_id,entry_id,attached_by,updated_by) VALUES($1,$3,'author','author'),($2,$3,'author','author')",
    [ids.publicWork, ids.selfWork, ids.timelineEntry],
  );
  const reporting = new PostgresCommunityReportingAdapter(setup);
  const standard = (id: string, description: string) =>
    reporting.create(ids.reporter, {
      kind: "standard",
      target: { type: "work", id },
      reason: "other",
      description,
      requestId: randomUUID(),
    });
  ids.selfReport = (await standard(ids.selfWork, CANARY.selfReport)).id;
  ids.deletedReport = (
    await standard(ids.deletedWork, `On a deleted work ${run}`)
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
    reason: RIGHTS.decision,
  });
  await db.query(
    "UPDATE community.report_decisions SET appeal_text=$2,appeal_at=CURRENT_TIMESTAMP,appeal_status='pending' WHERE id=$1",
    [decided.decision!.id, RIGHTS.appeal],
  );
  await db.query(
    "INSERT INTO community.report_messages(id,case_id,recipient_id,kind,text) VALUES($1,$2,$3,'notice',$4)",
    [opaque("message"), notice.id, ids.reporter, RIGHTS.message],
  );
  ids.deletedCommentReport = (
    await reporting.create(ids.reporter, {
      kind: "quick_comment",
      target: { type: "comment", id: ids.deletedComment },
      requestId: randomUUID(),
    })
  ).id;
  const noticeOn = async (
    scope: NoticeScope,
    state: NoticeState,
    workId: string,
  ) => {
    const reporter = opaque("user");
    await db.query(
      "INSERT INTO community.public_users(id,handle,display_name) VALUES($1,$2,$3)",
      [
        reporter,
        `noticer-${randomBytes(4).toString("hex")}-${run}`,
        `Noticer ${run}`,
      ],
    );
    const texts = noticeTexts(scope, state);
    const { id } = await reporting.create(reporter, {
      kind: "rights_notice",
      target: { type: "work", id: workId },
      reason: "copyright",
      description: texts.description,
      claimantName: texts.name,
      contact: CANARY.contact,
      rightsBasis: texts.basis,
      requestId: randomUUID(),
    });
    await reporting.addMaterial(reporter, id, {
      text: texts.material,
      requestId: randomUUID(),
    });
    await db.query(
      "INSERT INTO community.report_evidence(id,case_id,owner_id,file_name,mime_type,byte_size,sensitive,sha256,state) VALUES($1,$2,$3,$4,'application/pdf',20,true,$5,'ready')",
      [opaque("evidence"), id, reporter, CANARY.evidenceName, "b".repeat(64)],
    );
    await db.query(
      "INSERT INTO community.report_messages(id,case_id,recipient_id,kind,text) VALUES($1,$2,$3,'notice',$4)",
      [opaque("message"), id, reporter, texts.message],
    );
    if (state === "open" || state === "reviewing") {
      await db.query(
        "UPDATE community.report_cases SET status=$2 WHERE id=$1",
        [id, state],
      );
      return id;
    }
    const decision = await reporting.decide("owner", id, {
      expectedVersion: (await reporting.operatorRead(id)).version,
      action: "retain",
      reason: texts.decision,
    });
    if (state === "appealed") {
      await db.query(
        "UPDATE community.report_decisions SET appeal_text=$2,appeal_at=CURRENT_TIMESTAMP,appeal_status='pending' WHERE id=$1",
        [decision.decision!.id, texts.appeal],
      );
      await db.query(
        "UPDATE community.report_cases SET status='appealed' WHERE id=$1",
        [id],
      );
    }
    return id;
  };
  const workOfScope = {
    public: ids.publicWork,
    selfOnly: ids.selfWork,
    deleted: ids.deletedWork,
  };
  for (const scope of NOTICE_SCOPES)
    for (const state of NOTICE_STATES)
      notices[scope][state] = await noticeOn(scope, state, workOfScope[scope]);
  // As retention leaves a closed case: the claimant's fields stay, and hold nothing.
  ids.redactedReport = await noticeOn("public", "resolved", ids.publicWork);
  await db.query(
    `UPDATE community.report_cases SET description='',snapshot='{"retentionRedacted":true}'::jsonb,
      claimant='{"name":"","contact":"","rightsBasis":""}'::jsonb WHERE id=$1`,
    [ids.redactedReport],
  );
  ids.longReport = (
    await reporting.create(ids.lishu, {
      kind: "standard",
      target: { type: "work", id: ids.publicWork },
      reason: "other",
      description: LONG_NOTICE,
      requestId: randomUUID(),
    })
  ).id;
  // Self-only pieces, flipped after the reports as an author would: the flip touches
  // nothing else.
  await db.query(
    `INSERT INTO community.work_revisions(id,work_id,author_id,sequence,origin,title,body,authorship_kind,requested_visibility,content_sha256,disposition,submitted_at)
     VALUES($1,$2,$3,51,'submission',$4,$5,'original','public',$6,'superseded',CURRENT_TIMESTAMP)`,
    [
      ids.selfItemRevision,
      ids.selfWork,
      ids.author,
      CANARY.revisionTitle,
      CANARY.revisionBody,
      "a".repeat(64),
    ],
  );
  await db.query(
    "INSERT INTO community.media_items(id,owner_id,kind,quality_mode,source,state,declared_total_bytes) VALUES($1,$3,'static','standard','upload','awaiting_upload',1000),($2,$3,'static','standard','upload','awaiting_upload',1000)",
    [ids.item, ids.selfItem, ids.author],
  );
  await db.query(
    "INSERT INTO community.work_revision_items(revision_id,item_id,position,edit) VALUES($1,$2,1,'{}'::jsonb)",
    [ids.selfItemRevision, ids.selfItem],
  );
  // Real bytes, the legacy way, which needs no media store: a public work's and a
  // self-only work's, each usable by an Article of the same author.
  for (const [item, revision, bytes, article, position] of [
    [
      ids.publicBytesItem,
      ids.publicRevision,
      PNG_BYTES.public,
      ids.publicMediaArticle,
      1,
    ],
    [
      ids.selfBytesItem,
      ids.selfItemRevision,
      PNG_BYTES.self,
      ids.selfMediaArticle,
      2,
    ],
  ] as const) {
    const media = opaque("user-media");
    await db.query(
      "INSERT INTO community.user_media(id,owner_id,mime_type,width,height,sha256,bytes) VALUES($1,$2,'image/png',1,1,$3,$4)",
      [
        media,
        ids.author,
        createHash("sha256").update(bytes).digest("hex"),
        bytes,
      ],
    );
    await db.query(
      "INSERT INTO community.media_items(id,owner_id,kind,quality_mode,source,legacy_media_id,state,declared_total_bytes,received_total_bytes,ready_at) VALUES($1,$2,'static','legacy','legacy_user_media',$3,'ready',$4,$4,CURRENT_TIMESTAMP)",
      [item, ids.author, media, bytes.length],
    );
    await db.query(
      `INSERT INTO community.work_revision_items(revision_id,item_id,position,edit) VALUES($1,$2,$3,'{"rotation":0,"crop":null}'::jsonb)`,
      [revision, item, position],
    );
    const blank = emptyArticleDocument();
    await seedPendingArticle(
      article,
      `Using an item ${run}`,
      JSON.stringify({
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
        references: { used: { type: "managed", itemId: item } },
      }),
    );
  }
  await db.query("UPDATE community.works SET visibility='self' WHERE id=$1", [
    ids.selfWork,
  ]);
  await db.query(
    "UPDATE community.works SET title='',text='',media_ids='{}',public_revision_id=NULL,author_revision_id=NULL,visibility='self',deleted_at=CURRENT_TIMESTAMP WHERE id=$1",
    [ids.deletedWork],
  );
  await db.query("DELETE FROM community.work_revisions WHERE work_id=$1", [
    ids.deletedWork,
  ]);
  await seedPendingArticle(
    ids.pendingArticle,
    hostile("articletitle"),
    JSON.stringify(emptyArticleDocument()),
  );
};

let payload: Payload;
let routes: Awaited<ReturnType<typeof serveRoutes>>;
let backend: Server;
let backendOrigin = "";
let client: Client;

const send = async (name: string, args: Json) => {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { text: string }[])[0]!.text;
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(ADMIN_MCP_TEXT_CAP_BYTES);
  const envelope = adminMcpEnvelopeSchema.parse(result.structuredContent);
  expect(JSON.parse(text)).toEqual(envelope);
  expect(result.isError === true).toBe(!envelope.ok);
  return { envelope: envelope as Json, text };
};
const call = async (name: string, args: Json): Promise<Json> =>
  (await send(name, args)).envelope;
const ok = async (name: string, args: Json): Promise<Json> => {
  const envelope = await call(name, args);
  expect(envelope.ok, JSON.stringify(envelope).slice(0, 400)).toBe(true);
  return envelope;
};
const read = (args: Json) => call("admin_read", args);
const get = (type: string, id: unknown, more: Json = {}) =>
  call("admin_get", { type, id, ...more });
const find = (query: string, more: Json = {}) =>
  call("admin_find", { query, ...more });

const expectNoCanary = (text: string, label: string) => {
  for (const canary of WITHHELD) expect(text, label).not.toContain(canary);
};

/** A withheld record's own id, in an answer that was not asked for it by id. */
const expectNoSelfOnlyId = (text: string, asked: unknown, label: string) => {
  const named = JSON.stringify(asked) ?? "";
  for (const id of [
    ids.selfWork,
    ids.selfComment,
    ids.selfReply,
    ids.selfRevision,
    ids.selfItemRevision,
  ])
    if (!named.includes(id)) expect(text, label).not.toContain(id);
};

/** What no report answer holds, whatever its state and whatever a call asks for. */
const expectNoContactOrEvidenceName = (text: string, label: string) => {
  expect(text, label).not.toContain(CANARY.contact);
  expect(text, label).not.toContain(CANARY.evidenceName);
  expect(text, label).not.toContain('"contact"');
  expect(text, label).not.toContain('"fileName"');
  expect(text, label).not.toContain('"downloadPath"');
  expect(text, label).not.toContain("/evidence/");
};

/**
 * The same, for a call that asks for a canary by name. The caller's own words may come
 * back as the filter it asked for, and nowhere else.
 */
const expectOnlyOwnEcho = (envelope: Json, asked: string, label: string) => {
  const beyond = [
    ...stringsOf(envelope.data, ["data"]).filter(
      ({ path }) => path[1] !== "filter",
    ),
    ...stringsOf(envelope.hint, ["hint"]),
  ];
  for (const canary of WITHHELD)
    expect(
      beyond.filter(({ text }) => text.includes(canary)),
      label,
    ).toEqual([]);
  expect(asked).toBeTypeOf("string");
};

/** Every string under a value, with its path. */
const stringsOf = (
  value: unknown,
  path: readonly string[] = [],
): readonly { path: readonly string[]; text: string }[] => {
  if (typeof value === "string") return [{ path, text: value }];
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, item]) =>
    stringsOf(item, [...path, key]),
  );
};

/** A person's words stay under a pointer, however deep, in every answer. */
const expectHostileMarked = (envelope: Json): number => {
  const hits = [
    ...stringsOf(envelope.data, ["data"]),
    ...stringsOf(envelope.next?.args, ["next", "args"]),
  ].filter(({ text }) => text.includes(HOSTILE));
  for (const { path } of hits) {
    if (path[0] === "next") continue; // A value echoed from the call's own arguments.
    const covered = (envelope.untrusted as string[]).some((pointer) => {
      const parts = pointer.split("/").slice(1);
      return (
        parts.length <= path.length &&
        parts.every((part, index) => part === "*" || part === path[index])
      );
    });
    expect(covered, path.join("/")).toBe(true);
  }
  return hits.length;
};

/** The real Backend, reading through this pool. */
const backendOn = (pool: Pool): Server =>
  createBackendServer(
    createBackendApplication({
      nodeEnv: "development",
      communityIdentityPort: new PostgresCommunityIdentityAdapter(pool),
      communityCommentPort: new PostgresCommunityCommentAdapter(pool),
      discussionPort: new PostgresCommunityCommentAdapter(pool),
      contentOperatorPort: new PostgresCommunityContentOperatorAdapter(pool),
      reportingPort: new PostgresCommunityReportingAdapter(pool),
      publishingOperatorPort: new PostgresPublishingOperatorAdapter(pool),
      articlePublicationOperatorPort: new PostgresArticleAuthoringAdapter(pool),
      threadPort: new PostgresThreadAdapter(pool),
      timelineOperatorPort: new PostgresTimelineOperatorAdapter(pool),
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

/** A stand-in Backend for this call only: what the door really sends it. */
const withStubBackend = async <T>(
  answer: (request: IncomingMessage, response: ServerResponse) => void,
  run: () => Promise<T>,
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
    return await run();
  } finally {
    stub.closeAllConnections();
    await new Promise((resolve) => stub.close(resolve));
  }
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
  backend = backendOn(app);
  const address = await startServer(backend, { host: "127.0.0.1", port: 0 });
  backendOrigin = `http://127.0.0.1:${address.port}/`;

  const config = await (await import("admin/config")).default;
  payload = await getPayload({ config });
  routes = await serveRoutes(config);
  const secret = randomBytes(32).toString("hex");
  const account = await payload.create({
    collection: "users",
    overrideAccess: true,
    data: {
      email: `community-${run}@example.invalid`,
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
  await payload.create({
    collection: "payload-mcp-api-keys",
    overrideAccess: true,
    data: {
      user: aiOperator.id,
      label: `community-${run}`,
      enableAPIKey: true,
      apiKey: secret,
      toolProfile: "read",
    } as never,
  });
  client = (
    await connectClient(routes.endpoint, { authorization: `Bearer ${secret}` })
  ).client;
}, 180_000);

beforeEach(() => {
  vi.stubEnv("COMMUNITY_OPERATOR_BASE_URL", backendOrigin);
  vi.stubEnv("COMMUNITY_OPERATOR_AI_TOKEN", communityToken);
  vi.stubEnv("OPERATOR_AI_BASE_TOKEN", baseToken);
  // Never the Owner's: an AI call that fell back to it would read everything.
  vi.stubEnv("COMMUNITY_OPERATOR_TOKEN", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await client?.close();
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

describe("the seed", () => {
  it("is not blind: the Owner's token reads back what the sweep looks for", async () => {
    const owner = async (route: string) =>
      (
        await fetch(`${backendOrigin}internal/community/${route}`, {
          headers: { authorization: `Bearer ${ownerToken}` },
        })
      ).text();
    expect(await owner(`reports/${ids.rightsReport}`)).toContain(
      CANARY.contact,
    );
    expect(await owner(`reports/${ids.rightsReport}`)).toContain(
      CANARY.evidenceName,
    );
    expect(await owner(`reports/${ids.selfReport}`)).toContain(
      CANARY.selfReport,
    );
    expect(await owner(`comments/${ids.selfComment}`)).toContain(
      CANARY.comment,
    );
    expect(await owner(`comments/${ids.selfReply}`)).toContain(CANARY.reply);
    expect(await owner(`works?workId=${ids.selfWork}`)).toContain(
      CANARY.selfTitle,
    );
    expect(
      await owner(`moderation-events?subjectId=${ids.selfComment}`),
    ).toContain(CANARY.eventDetail);
    expect(await owner(`publishing/submissions/${ids.selfRevision}`)).toContain(
      CANARY.revisionBody,
    );
    expect(
      await owner(`moderation-events?subjectId=${ids.selfReply}`),
    ).toContain(CANARY.replyEventDetail);
    for (const state of NOTICE_STATES) {
      const id = notices.selfOnly[state];
      expect(await owner(`reports/${id}`)).toContain(CANARY.selfNotice);
      expect(await owner(`reports/${id}`)).toContain(CANARY.contact);
      expect(await owner(`reports/${notices.public[state]}`)).toContain(
        `"status":"${state}"`,
      );
    }
  });
});

/** Inputs that reach each read, so a sweep is never an early refusal. */
const inputsOf = (op: string): readonly Json[] => {
  const route = op.replace(/^community\./u, "");
  const byOp: Readonly<Record<string, readonly Json[]>> = {
    "read-reports": [
      {},
      ...NOTICE_STATES.map((status) => ({ status, pageSize: 100 })),
      { targetType: "work", targetId: ids.selfWork },
      { targetType: "comment", targetId: ids.selfComment },
      { affectedUserId: ids.author, pageSize: 100 },
    ],
    "read-report": [
      { id: ids.rightsReport },
      { id: ids.selfReport },
      { id: ids.commentReport },
      { id: ids.replyReport },
      { id: ids.deletedReport },
      { id: ids.redactedReport },
      ...NOTICE_SCOPES.flatMap((scope) =>
        NOTICE_STATES.map((state) => ({ id: notices[scope][state] })),
      ),
    ],
    "read-feedback": [{}, { id: ids.feedback }],
    "read-works": [
      {},
      { search: CANARY.selfTitle },
      { workId: ids.selfWork },
      { authorId: ids.author },
    ],
    "read-users": [{}, { userId: ids.author }],
    "read-featured": [
      {},
      { filter: "all" },
      { filter: "all", search: CANARY.selfTitle },
    ],
    "read-threads": [{}, { id: ids.thread }],
    "read-feature-catalogs": [{}],
    "read-policy": [{}],
    "read-comments": [
      {},
      { search: CANARY.comment },
      { authorId: ids.reporter },
      { catalogId: ids.selfWork },
      { kind: "reply" },
    ],
    "read-comment": [
      { id: ids.publicComment },
      { id: ids.selfComment },
      { id: ids.selfReply },
    ],
    "read-events": [
      {},
      { subjectId: ids.selfComment },
      { subjectId: ids.selfReply },
    ],
    "read-summary": [{ range: "30d" }],
    "read-work-publishing-settings": [{}],
    "read-article-submissions": [{}],
    "read-article-submission": [
      { id: ids.pendingArticle },
      { id: ids.selfMediaArticle },
    ],
    "read-work-submissions": [
      {},
      { workId: ids.selfWork },
      { authorId: ids.author },
      { state: "superseded" },
    ],
    "read-work-submission": [
      { id: ids.publicRevision },
      { id: ids.selfRevision },
      { id: ids.selfItemRevision },
    ],
    "read-account-capacity": [{ accountId: ids.author }],
    "read-publishing-jobs": [{}],
    "read-timeline": [
      {},
      { id: ids.timelineEntry },
      { ids: [ids.timelineEntry, ids.hiddenTimelineEntry], hidden: "only" },
      { search: HOSTILE },
      { linked: "not_published", issue: "not_published" },
    ],
    "read-timeline-summary": [{}],
    "read-timeline-posts": [
      {},
      { entryId: ids.timelineEntry },
      { workId: ids.selfWork },
      { state: "attached", attachedBy: "author" },
    ],
  };
  const listed: Readonly<Record<string, string>> = {
    "list.comments": "read-comments",
    "list.works": "read-works",
    "list.users": "read-users",
    "list.threads": "read-threads",
    "list.featured": "read-featured",
    "list.feature_catalogs": "read-feature-catalogs",
    "list.reports": "read-reports",
    "list.appeals": "read-reports",
    "list.work_submissions": "read-work-submissions",
    "list.article_submissions": "read-article-submissions",
    "list.jobs": "read-publishing-jobs",
    "list.feedback": "read-feedback",
    "list.events": "read-events",
    "list.policy": "read-policy",
    "list.work_settings": "read-work-publishing-settings",
    "list.overview": "read-summary",
  };
  return byOp[listed[op] ?? route] ?? [{}];
};

/** What another slice builds, by name: a sweep cannot pass one by accident. */
const NOT_BUILT_HERE: ReadonlySet<string> = new Set([
  "list.invitations",
  "list.masters",
  "ops.invitation.status",
  "ops.master.candidates",
  "ops.master.status",
  "ops.master.guard",
  "ops.upload_gc.plan",
]);

/** A list on the CMS side, or on the worker's backlog: no community row is near it. */
const FROM_ELSEWHERE: ReadonlySet<string> = new Set(["list.render_backlog"]);

describe("the canary sweep", () => {
  const READ_OPS = ADMIN_OP_NAMES.filter(
    (name) => adminOpMeta[name].tool === "admin_read",
  );
  const COMMUNITY_READ = /^(?:community|list)\./u;

  it.each(READ_OPS)(
    "finds nothing withheld in %s, in any view, and every person's word is marked",
    async (op: AdminOpName) => {
      const entry = adminOpMeta[op];
      for (const input of inputsOf(op)) {
        const views: readonly Json[] =
          entry.readArgs === undefined
            ? [{}]
            : [{}, { view: "full" }, { view: "count" }];
        for (const view of views) {
          const { envelope, text } = await send("admin_read", {
            op,
            input,
            ...view,
          });
          const label = `${op} ${JSON.stringify({ input, view })}`;
          if (WITHHELD.some((canary) => JSON.stringify(input).includes(canary)))
            expectOnlyOwnEcho(envelope, JSON.stringify(input), label);
          else expectNoCanary(text, label);
          expectNoSelfOnlyId(text, input, label);
          expect(text).not.toContain('"contact"');
          expect(text).not.toContain('"fileName"');
          expect(text).not.toContain('"downloadPath"');
          expect(text).not.toContain("/evidence/");
          if (NOT_BUILT_HERE.has(op)) {
            expect(envelope.code, label).toBe("NOT_AVAILABLE");
            continue;
          }
          // Each community read really reads: a sweep of a refusal proves nothing. A
          // withheld subject is named, and a queue that cannot count says so. The CMS
          // ops take inputs of their own, and hold no community row.
          if (COMMUNITY_READ.test(op) && !FROM_ELSEWHERE.has(op))
            expect(
              [
                "OK",
                "SELF_ONLY_OWNER_REVIEW",
                ...(view.view === "count" ? ["INPUT_INVALID"] : []),
              ],
              label,
            ).toContain(envelope.code);
          expectHostileMarked(envelope);
        }
      }
    },
  );

  it("is not left to a refusal: every op it sweeps is named, built or not", () => {
    expect(READ_OPS.length).toBeGreaterThan(30);
    expect(READ_OPS).toEqual(
      expect.arrayContaining([
        "community.read-report",
        "community.read-comment",
        "list.reports",
        "list.overview",
      ]),
    );
  });

  // home-timeline-v1 (Issue #384 r3): so the sweep of the timeline reads its rows.
  it("reads the Home timeline's rows and counts, with every word of the Owner's marked", async () => {
    const rows = await ok("admin_read", {
      op: "community.read-timeline",
      view: "full",
      input: { ids: [ids.timelineEntry, ids.hiddenTimelineEntry] },
    });
    expect(rows.data.total).toBe(2);
    expect(
      rows.data.rows.map(({ id, state, linkState, version }: Json) => [
        id,
        state,
        linkState,
        version,
      ]),
    ).toEqual([
      [ids.timelineEntry, "visible", "not_published", 1],
      [ids.hiddenTimelineEntry, "hidden", "unlinked", 1],
    ]);
    expect(rows.data.rows[0].updatedBy).toBe("import");
    expect(expectHostileMarked(rows)).toBe(7);
    expect(
      await ok("admin_read", { op: "community.read-timeline-summary" }),
    ).toMatchObject({
      data: {
        entries: { total: 2, visible: 1, hidden: 1 },
        links: { unlinked: 1, published: 0, notPublished: 1 },
        groups: { total: 1, folding: 0 },
        issues: { notPublished: 1 },
      },
    });
    // No count in SQL: the summary is the timeline's count.
    expect(
      await read({ op: "community.read-timeline", view: "count" }),
    ).toMatchObject({ ok: false, code: "INPUT_INVALID" });
  });

  // timeline-posts-v1: the row holds a public post and a self-only one.
  it("reads a row's posts with no self-only one, names it withheld, and counts the public post alone", async () => {
    const posts = await ok("admin_read", {
      op: "community.read-timeline-posts",
      view: "full",
      input: { entryId: ids.timelineEntry },
    });
    expect(posts.data.total).toBe(1);
    expect(posts.data.rows).toEqual([
      {
        id: ids.publicWork,
        title: hostile("worktitle"),
        state: "attached",
        version: 1,
        entryId: ids.timelineEntry,
        publiclyVisible: true,
        authorId: ids.author,
        attachedBy: "author",
        updatedAt: expect.any(String),
        withheldEntryId: null,
        workState: "visible",
        attachedAt: expect.any(String),
        updatedBy: "author",
      },
    ]);
    expect(posts.meta.excluded).toEqual(["self_only"]);
    expect(expectHostileMarked(posts)).toBe(1);
    // Asked by its id, the self-only work is no row and no total.
    const asked = await ok("admin_read", {
      op: "community.read-timeline-posts",
      input: { workId: ids.selfWork },
    });
    expect(asked.data).toMatchObject({ rows: [], total: 0 });
    expect(asked.meta.excluded).toEqual(["self_only"]);
    const row = await ok("admin_read", {
      op: "community.read-timeline",
      input: { id: ids.timelineEntry },
    });
    expect(row.data.rows[0].postCount).toBe(1);
    expect(
      (
        await ok("admin_read", {
          op: "community.read-timeline",
          input: { posts: "without" },
        })
      ).data.rows.map(({ id }: Json) => id),
    ).toEqual([ids.hiddenTimelineEntry]);
    expect(
      await ok("admin_read", { op: "community.read-timeline-summary" }),
    ).toMatchObject({ data: { posts: { total: 1, entries: 1 } } });
    expect(
      await read({ op: "community.read-timeline-posts", view: "count" }),
    ).toMatchObject({ ok: false, code: "INPUT_INVALID" });
  });

  it("walks every queue to its end with next alone, and no page, cut or way on holds anything withheld", async () => {
    const QUEUES = READ_OPS.filter(
      (op) =>
        op.startsWith("list.") &&
        !NOT_BUILT_HERE.has(op) &&
        !FROM_ELSEWHERE.has(op),
    );
    expect(QUEUES).toEqual(
      expect.arrayContaining(["list.reports", "list.comments", "list.works"]),
    );
    for (const op of QUEUES)
      for (const view of adminOpMeta[op].readArgs === undefined
        ? [{}]
        : [{}, { view: "full" }]) {
        let args: Json | undefined = { op, ...view };
        let calls = 0;
        // The suite's files share one database, so a CMS queue's length depends
        // on which file ran first. This only stops a `next` that never ends.
        while (args !== undefined && calls < 1_000) {
          const { envelope, text } = await send("admin_read", args);
          expectNoCanary(text, op);
          expectNoSelfOnlyId(text, undefined, op);
          // A cut or paged answer has exactly one way on, and it holds no value.
          expect(envelope).not.toHaveProperty("data.nextCursor");
          expect(envelope).not.toHaveProperty("data.totalPages");
          calls += 1;
          args =
            envelope.next?.tool === "admin_read"
              ? (envelope.next.args as Json)
              : undefined;
        }
        expect(args, op).toBeUndefined();
      }
  }, 180_000);

  it("finds nothing withheld on any type of admin_find, by text or by id", async () => {
    for (const type of [
      "user",
      "work",
      "comment",
      "thread",
      "report",
      "work_revision",
      "feedback",
      "media_item",
    ]) {
      for (const canary of WITHHELD) {
        const { envelope, text } = await send("admin_find", {
          query: canary,
          type,
        });
        expect(envelope.ok, `${type} ${canary}`).toBe(true);
        expect(
          adminFindDataSchema.parse(envelope.data).items,
          `${type} ${canary}`,
        ).toEqual([]);
        expect(text.split(canary).length, type).toBeLessThanOrEqual(2);
      }
    }
    for (const [type, id] of [
      ["work", ids.selfWork],
      ["comment", ids.selfComment],
      ["comment", ids.selfReply],
      ["work_revision", ids.selfRevision],
      ["work_revision", ids.selfItemRevision],
      ["media_item", ids.selfItem],
      ["media_item", ids.selfBytesItem],
    ] as const) {
      const { envelope, text } = await send("admin_find", { query: id, type });
      expect(
        adminFindDataSchema.parse(envelope.data).resolution.status,
        id,
      ).toBe("none");
      expectNoCanary(text, id);
    }
  }, 60_000);

  it("reads current visibility on every call, so no answer outlives a flip", async () => {
    const work = opaque("work");
    const comment = opaque("comment");
    const title = `flipcanary${run}`;
    await setup.query(
      "INSERT INTO community.works(id,author_id,title,text,first_published_at) VALUES($1,$2,$3,'Flip text',CURRENT_TIMESTAMP)",
      [work, ids.author, title],
    );
    await setup.query(
      "INSERT INTO community.catalog_comments(id,catalog_id,target_type,author_id,text,moderation) VALUES($1,$2,'work',$3,$4,'visible')",
      [comment, work, ids.reporter, `${title} comment`],
    );
    const reads = () =>
      Promise.all([
        send("admin_read", { op: "list.works", input: { workId: work } }),
        send("admin_read", {
          op: "community.read-comment",
          input: { id: comment },
        }),
        send("admin_get", { type: "work", id: work }),
        send("admin_find", { query: title }),
      ]);
    const open = await reads();
    expect(open[0].envelope.data.total).toBe(1);
    expect(open[1].envelope.ok).toBe(true);
    expect(open[2].envelope.ok).toBe(true);
    expect(open[3].text).toContain(title);
    await setup.query(
      "UPDATE community.works SET visibility='self' WHERE id=$1",
      [work],
    );
    const [listed, read, got, found] = await reads();
    expect(listed.envelope.data.total).toBe(0);
    expect(read.envelope.code).toBe("SELF_ONLY_OWNER_REVIEW");
    expect(got.envelope.code).toBe("NOT_FOUND");
    expect(adminFindDataSchema.parse(found.envelope.data).items).toEqual([]);
    for (const { text } of [listed, read, got])
      expect(text).not.toContain(title);
  });

  it("counts a self-only work in no Thread", async () => {
    const thread = await ok("admin_read", {
      op: "list.threads",
      view: "full",
      input: { id: ids.thread },
    });
    expect(thread.data.rows[0].postCount).toBe(1);
  });

  it("reads no sensitive op through admin_read, and answers nothing it holds", async () => {
    const sensitive = ADMIN_OP_NAMES.filter(
      (name) => adminOpMeta[name].tool === "admin_sensitive_read",
    );
    expect(sensitive.length).toBeGreaterThan(0);
    for (const op of sensitive) {
      const { envelope, text } = await send("admin_read", {
        op,
        input: { id: notices.public.resolved },
      });
      expect(envelope.ok, op).toBe(false);
      expectNoCanary(text, op);
    }
  });

  it("offers no contact or evidence name in the shape of any read op", async () => {
    const ops = READ_OPS.filter((op) => COMMUNITY_READ.test(op));
    for (let at = 0; at < ops.length; at += ADMIN_ACTIONS_MAX_OPS) {
      const { text } = await send("admin_actions", {
        ops: ops.slice(at, at + ADMIN_ACTIONS_MAX_OPS),
      });
      expect(text).not.toContain('"contact"');
      expect(text).not.toContain('"fileName"');
      expect(text).not.toContain('"downloadPath"');
    }
  });

  it("finds nothing withheld through admin_get, on any type, view or field", async () => {
    const records = [
      ["work", ids.selfWork],
      ["comment", ids.selfComment],
      ["comment", ids.selfReply],
      ["work_revision", ids.selfRevision],
      ["report", ids.selfReport],
      ["report", ids.commentReport],
      ["report", ids.replyReport],
      ["report", ids.rightsReport],
      ["user", ids.author],
      ["user", ids.reporter],
      ["media_item", ids.selfItem],
    ] as const;
    for (const [type, id] of records)
      for (const more of [
        {},
        { view: "full" },
        { field: "text" },
        { field: "description" },
        { field: "snapshot" },
        { field: "root" },
      ]) {
        const { text } = await send("admin_get", { type, id, ...more });
        expectNoCanary(text, `${type} ${id} ${JSON.stringify(more)}`);
        expect(text).not.toContain('"contact"');
        expect(text).not.toContain('"fileName"');
      }
  });

  it("finds nothing withheld through admin_find, by text or by id", async () => {
    const queries = [
      ...WITHHELD,
      ids.selfWork,
      ids.selfComment,
      ids.selfReply,
      ids.selfRevision,
      ids.selfItem,
      `/?workId=${ids.selfWork}`,
      handles.author,
      `@${handles.author}`,
    ];
    for (const query of queries) {
      const { envelope, text } = await send("admin_find", { query });
      expectNoCanary(text, query);
      expect(envelope.meta.excluded).toContain("self_only");
    }
    // No search counts or returns what it withholds: nothing to reveal by counting.
    for (const canary of WITHHELD) {
      const { items } = adminFindDataSchema.parse(
        (await find(canary, { type: "work" })).data,
      );
      expect(items, canary).toEqual([]);
    }
  });

  it("reads back no withheld value through a filter, a count or a sort", async () => {
    const worksBy = await ok("admin_read", {
      op: "list.works",
      input: { authorId: ids.author },
    });
    const counted = await ok("admin_read", {
      op: "list.works",
      view: "count",
      input: { authorId: ids.author },
    });
    expect(counted.data.total).toBe(worksBy.data.total);
    expect(worksBy.data.rows.map(({ id }: Json) => id)).not.toContain(
      ids.selfWork,
    );
    for (const search of [CANARY.selfTitle, CANARY.revisionBody]) {
      const hit = await ok("admin_read", {
        op: "list.works",
        view: "count",
        input: { search },
      });
      expect(hit.data.total).toBe(0);
    }
    const comments = await ok("admin_read", {
      op: "list.comments",
      view: "count",
      input: { search: CANARY.comment },
    });
    expect(comments.data.total).toBe(0);
    // An owner-only case holds no people to count: the filter leaves it out.
    const byTarget = await ok("admin_read", {
      op: "list.reports",
      view: "count",
      input: { targetType: "work", targetId: ids.selfWork },
    });
    expect(byTarget.data.total).toBe(0);
    const reason = await ok("admin_read", {
      op: "list.reports",
      view: "count",
      groupBy: "reason",
      input: { reporterId: ids.author },
    });
    expect(reason.data.total).toBe(0);
  });
});

describe("a report, field by field", () => {
  it("reads rights-notice text and no contact or evidence name, on list and get", async () => {
    const listed = await ok("admin_read", {
      op: "list.reports",
      view: "full",
      input: { targetType: "work", targetId: ids.publicWork },
    });
    const row = listed.data.rows.find(
      ({ id }: Json) => id === ids.rightsReport,
    );
    expect(row).toMatchObject({
      kind: "rights_notice",
      claimantName: RIGHTS.name,
      evidenceCount: 1,
      evidenceTypes: ["application/pdf"],
      appeal: "pending",
    });
    // A row's long text is by state, length and hash, never as text.
    expect(row.description).toEqual({
      state: "VALUE",
      length: [...RIGHTS.description].length,
      hash: expect.any(String),
    });
    expect(listed.meta.redacted).toEqual([
      "claimant.contact",
      "evidence.id",
      "evidence.fileName",
      "evidence.downloadPath",
    ]);

    const whole = await ok("admin_read", {
      op: "community.read-report",
      input: { id: ids.rightsReport },
    });
    expect(whole.data).toMatchObject({
      claimant: { name: RIGHTS.name, rightsBasis: RIGHTS.basis },
      description: RIGHTS.description,
      materials: [{ text: RIGHTS.material }],
      appeal: { text: RIGHTS.appeal, status: "pending" },
      evidence: [
        {
          mimeType: "application/pdf",
          size: 20,
          sensitive: true,
        },
      ],
    });
    expect(whole.data.claimant).not.toHaveProperty("contact");
    expect(whole.data.evidence[0]).not.toHaveProperty("fileName");
    expect(whole.data.evidence[0]).not.toHaveProperty("downloadPath");
    expect(whole.data.history.map(({ reason }: Json) => reason)).toContain(
      RIGHTS.decision,
    );
    expect(whole.meta.redacted).toContain("claimant.contact");

    const outline = await ok("admin_get", {
      type: "report",
      id: ids.rightsReport,
    });
    const facts = Object.fromEntries(
      outline.data.fields.map((field: Json) => [field.name, field]),
    );
    expect(facts.claimantName.value).toBe(RIGHTS.name);
    expect(facts.description).toMatchObject({
      state: "VALUE",
      length: [...RIGHTS.description].length,
    });
    expect(facts.description).not.toHaveProperty("value");
    expect(facts.evidence.count).toBe(1);
    expect(facts).not.toHaveProperty("contact");
    expect(outline.meta.redacted).toContain("claimant.contact");
    expect(outline.meta.excluded).toEqual(["self_only"]);

    expect(facts.messages.count).toBe(2);
    for (const [field, expected] of [
      ["description", RIGHTS.description],
      ["rightsBasis", RIGHTS.basis],
      ["materials.0.text", RIGHTS.material],
      ["messages.1.text", RIGHTS.message],
    ] as const) {
      const window = await ok("admin_get", {
        type: "report",
        id: ids.rightsReport,
        field,
      });
      expect(window.data.text, field).toBe(expected);
      expect(window.untrusted).toContain("/data/text");
    }
    const appeal = await ok("admin_get", {
      type: "report",
      id: ids.rightsReport,
      field: "appeal",
    });
    expect(appeal.data.text).toContain(RIGHTS.appeal);
    const reasons = await ok("admin_get", {
      type: "report",
      id: ids.rightsReport,
      field: "history.0.reason",
    });
    expect(reasons.data.text).toBeTypeOf("string");
  });

  it("finds a rights notice by what AI may read, and never by contact or a file name", async () => {
    const found = adminFindDataSchema.parse(
      (await ok("admin_find", { query: RIGHTS.description, type: "report" }))
        .data,
    );
    expect(found.items.map(({ id }) => id)).toContain(ids.rightsReport);
    for (const query of [CANARY.contact, CANARY.evidenceName]) {
      const miss = await ok("admin_find", { query, type: "report" });
      expect(adminFindDataSchema.parse(miss.data).items).toEqual([]);
      expect(miss.meta.sources).toEqual({ reports: "ok" });
    }
  });

  it.each([
    ["a self-only work", () => ids.selfReport],
    ["a comment under one", () => ids.commentReport],
    ["a reply under one", () => ids.replyReport],
  ])("routes a report on %s to the Owner, with no text", async (_, id) => {
    const { envelope, text } = await send("admin_read", {
      op: "community.read-report",
      input: { id: id() },
    });
    expect(envelope).toMatchObject({
      ok: false,
      code: "SELF_ONLY_OWNER_REVIEW",
      data: {
        id: id(),
        status: "open",
        ownerOnly: true,
        code: "SELF_ONLY_OWNER_REVIEW",
      },
    });
    expect(Object.keys(envelope.data).sort()).toEqual([
      "code",
      "id",
      "kind",
      "ownerOnly",
      "status",
    ]);
    expectNoCanary(text, id());
    const got = await get("report", id());
    expect(got.code).toBe("SELF_ONLY_OWNER_REVIEW");
    expect(got.data.ownerOnly).toBe(true);
    const listed = await ok("admin_read", {
      op: "list.reports",
      view: "full",
      input: { status: "open", pageSize: 100 },
    });
    const row = listed.data.rows.find((item: Json) => item.id === id());
    expect(Object.keys(row).sort()).toEqual([
      "code",
      "id",
      "kind",
      "ownerOnly",
      "state",
    ]);
    const lookup = adminFindDataSchema.parse((await find(id())).data);
    expect(lookup.items[0]).toMatchObject({
      state: "open",
      disambiguators: { ownerOnly: true },
    });
    expect(lookup.items[0]).not.toHaveProperty("title");
  });

  it("keeps a report on a permanently deleted work with AI", async () => {
    const read = await ok("admin_read", {
      op: "community.read-report",
      input: { id: ids.deletedReport },
    });
    expect(read.data.description).toBe(`On a deleted work ${run}`);
    // The case keeps what the reporter saw when filing. It was public then.
    expect(read.data.snapshot).toMatchObject({ title: "Deleted title" });
    const got = await ok("admin_get", {
      type: "report",
      id: ids.deletedReport,
    });
    expect(got.data.state).toBe("open");
    const lookup = await ok("admin_find", { query: ids.deletedWork });
    expect(adminFindDataSchema.parse(lookup.data).items[0]).toMatchObject({
      id: ids.deletedWork,
      disambiguators: { authorDeleted: true },
    });
  });

  it("answers a report too long for one result with its way on, and reads the whole text there", async () => {
    const whole = await ok("admin_read", {
      op: "community.read-report",
      input: { id: ids.longReport },
    });
    expect(whole.meta.truncated).toBe(true);
    expect(whole.next).toEqual({
      tool: "admin_get",
      args: { type: "report", id: ids.longReport },
    });
    expect(whole.data.description).toMatchObject({
      state: "VALUE",
      windowed: true,
    });
    let text = "";
    let next: Json | undefined = {
      tool: "admin_get",
      args: { type: "report", id: ids.longReport, field: "description" },
    };
    while (next !== undefined) {
      const piece: Json = await ok(next.tool, next.args);
      text += piece.data.text;
      next = piece.next;
    }
    expect(text).toBe(LONG_NOTICE);
  });
});

describe("a rights notice, in every state of a case", () => {
  /** Every way to read one case, each answer in full for the caller to check. */
  const everyReadOf = async (id: string, status: string) => {
    const answers = [
      await send("admin_read", {
        op: "list.reports",
        view: "full",
        input: { status, pageSize: 100 },
      }),
      await send("admin_read", {
        op: "community.read-reports",
        input: { status, pageSize: 100 },
      }),
      await send("admin_read", {
        op: "community.read-report",
        input: { id },
      }),
      await send("admin_get", { type: "report", id }),
      await send("admin_get", { type: "report", id, view: "full" }),
      ...(await Promise.all(
        [
          "description",
          "rightsBasis",
          "snapshot",
          "materials",
          "messages",
          "history",
          "evidence",
          "evidence.0",
          "decision",
          "appeal",
        ].map((field) => send("admin_get", { type: "report", id, field })),
      )),
    ];
    return answers;
  };

  it.each(NOTICE_STATES)(
    "%s: reads every field AI may read, on list and get, and no contact or evidence name",
    async (state) => {
      const id = notices.public[state];
      const texts = noticeTexts("public", state);
      for (const { text } of await everyReadOf(id, state))
        expectNoContactOrEvidenceName(text, state);

      const listed = await ok("admin_read", {
        op: "list.reports",
        view: "full",
        input: { status: state, pageSize: 100 },
      });
      const row = listed.data.rows.find((item: Json) => item.id === id);
      expect(row, state).toMatchObject({
        kind: "rights_notice",
        state,
        claimantName: texts.name,
        evidenceCount: 1,
        evidenceTypes: ["application/pdf"],
      });
      expect(listed.meta.redacted).toContain("claimant.contact");
      expect(listed.meta.redacted).toContain("evidence.fileName");

      const { data } = await ok("admin_read", {
        op: "community.read-report",
        input: { id },
      });
      expect(data).toMatchObject({
        kind: "rights_notice",
        status: state,
        description: texts.description,
        claimant: { name: texts.name, rightsBasis: texts.basis },
        materials: [{ text: texts.material }],
        evidence: [{ mimeType: "application/pdf", size: 20, sensitive: true }],
      });
      expect(Object.keys(data.claimant).sort()).toEqual([
        "name",
        "rightsBasis",
      ]);
      expect(Object.keys(data.evidence[0]).sort()).toEqual([
        "createdAt",
        "mimeType",
        "sensitive",
        "size",
      ]);
      const messages = data.messages.map(({ text }: Json) => text);
      expect(messages).toContain(texts.message);
      const reasons = data.history.map(({ reason }: Json) => reason);
      if (state === "resolved" || state === "appealed")
        expect(reasons).toContain(texts.decision);
      if (state === "appealed") expect(data.appeal.text).toBe(texts.appeal);

      const message = await ok("admin_get", {
        type: "report",
        id,
        field: `messages.${messages.indexOf(texts.message)}.text`,
      });
      expect(message.data.text).toBe(texts.message);
      const material = await ok("admin_get", {
        type: "report",
        id,
        field: "materials.0.text",
      });
      expect(material.data.text).toBe(texts.material);
      if (state === "resolved" || state === "appealed") {
        const reason = await ok("admin_get", {
          type: "report",
          id,
          field: `history.${reasons.indexOf(texts.decision)}.reason`,
        });
        expect(reason.data.text).toBe(texts.decision);
      }
    },
  );

  it("names no contact or evidence field when a call asks for one by name", async () => {
    const id = notices.public.reviewing;
    for (const field of [
      "contact",
      "claimant",
      "claimant.contact",
      "evidence.0.id",
      "evidence.0.fileName",
      "evidence.0.downloadPath",
      "evidence.0.fileName.0",
    ]) {
      const { envelope, text } = await send("admin_get", {
        type: "report",
        id,
        field,
      });
      expect(envelope.code, field).toBe("INPUT_INVALID");
      expectNoContactOrEvidenceName(text, field);
    }
    for (const fields of [
      ["contact"],
      ["claimant"],
      ["claimant.contact"],
      ["fileName"],
      ["downloadPath"],
    ]) {
      for (const args of [
        { tool: "admin_get", more: { type: "report", id, fields } },
        { tool: "admin_read", more: { op: "list.reports", fields } },
      ]) {
        const { envelope, text } = await send(args.tool, args.more);
        expect(envelope.code, JSON.stringify(args)).toBe("INPUT_INVALID");
        expectNoContactOrEvidenceName(text, JSON.stringify(fields));
      }
    }
    // A contact is no text inside a field, and a search for it finds no case.
    const within = await ok("admin_get", {
      type: "report",
      id,
      field: "description",
      find: { text: CANARY.contact },
    });
    expect(within.data.count).toBe(0);
    expect(
      adminFindDataSchema.parse(
        (await ok("admin_find", { query: CANARY.contact })).data,
      ).items,
    ).toEqual([]);
  });

  it("finds a notice by every text AI may read", async () => {
    const texts = noticeTexts("public", "appealed");
    for (const [field, query] of Object.entries(texts)) {
      const found = adminFindDataSchema.parse(
        (await ok("admin_find", { query, type: "report" })).data,
      );
      expect(
        found.items.map(({ id }) => id),
        field,
      ).toContain(notices.public.appealed);
    }
  });

  it("keeps the fields of a case retention emptied, with no contact key among them", async () => {
    const { envelope, text } = await send("admin_read", {
      op: "community.read-report",
      input: { id: ids.redactedReport },
    });
    expect(envelope.data.claimant).toEqual({ name: "", rightsBasis: "" });
    expect(envelope.data.description).toBe("");
    expectNoContactOrEvidenceName(text, "redacted");
  });

  it.each(NOTICE_STATES)(
    "%s: a notice on a self-only work is the Owner's, whatever is asked of it",
    async (state) => {
      const id = notices.selfOnly[state];
      for (const { envelope, text } of await everyReadOf(id, state)) {
        expectNoCanary(text, state);
        expectNoContactOrEvidenceName(text, state);
        const answered =
          envelope.data?.rows?.find((item: Json) => item.id === id) ??
          envelope.data?.items?.find((item: Json) => item.id === id) ??
          envelope.data;
        if (
          envelope.data?.rows === undefined &&
          envelope.data?.items === undefined
        )
          expect(envelope.code, state).toBe("SELF_ONLY_OWNER_REVIEW");
        expect(answered.ownerOnly, state).toBe(true);
        expect(answered.code).toBe("SELF_ONLY_OWNER_REVIEW");
      }
      const asked = await ok("admin_read", {
        op: "list.reports",
        fields: ["description", "claimantName", "rightsBasis", "appeal"],
        input: { status: state, pageSize: 100 },
      });
      expect(
        Object.keys(
          asked.data.rows.find((item: Json) => item.id === id),
        ).sort(),
      ).toEqual(["code", "id", "kind", "ownerOnly", "state"]);
    },
  );

  it("shows an appeal on a self-only work as the Owner's in the appeal queue", async () => {
    const { envelope, text } = await send("admin_read", {
      op: "list.appeals",
      view: "full",
      input: { pageSize: 100 },
    });
    const row = envelope.data.rows.find(
      (item: Json) => item.id === notices.selfOnly.appealed,
    );
    expect(Object.keys(row).sort()).toEqual([
      "code",
      "id",
      "kind",
      "ownerOnly",
      "state",
    ]);
    expect(row).toMatchObject({ ownerOnly: true, state: "appealed" });
    expectNoCanary(text, "appeals");
  });

  it.each(NOTICE_STATES)(
    "%s: a notice on a permanently deleted work stays with AI, with no contact",
    async (state) => {
      const id = notices.deleted[state];
      const texts = noticeTexts("deleted", state);
      const { envelope, text } = await send("admin_read", {
        op: "community.read-report",
        input: { id },
      });
      expect(envelope.ok).toBe(true);
      expect(envelope.data).toMatchObject({
        status: state,
        description: texts.description,
        claimant: { name: texts.name, rightsBasis: texts.basis },
        materials: [{ text: texts.material }],
      });
      expect(envelope.data).not.toHaveProperty("ownerOnly");
      if (state === "appealed")
        expect(envelope.data.appeal.text).toBe(texts.appeal);
      expectNoContactOrEvidenceName(text, state);
      const row = (
        await ok("admin_read", {
          op: "list.reports",
          view: "full",
          input: {
            targetType: "work",
            targetId: ids.deletedWork,
            pageSize: 100,
          },
        })
      ).data.rows.find((item: Json) => item.id === id);
      expect(row).toMatchObject({ claimantName: texts.name });
      expect(row).not.toHaveProperty("ownerOnly");
    },
  );

  it("keeps a report on a comment under a permanently deleted work with AI", async () => {
    const report = await ok("admin_read", {
      op: "community.read-report",
      input: { id: ids.deletedCommentReport },
    });
    expect(report.data).not.toHaveProperty("ownerOnly");
    expect(report.data.snapshot.text).toBe(`Under deleted ${run}`);
    const comment = await ok("admin_read", {
      op: "community.read-comment",
      input: { id: ids.deletedComment },
    });
    expect(JSON.stringify(comment.data)).toContain(`Under deleted ${run}`);
  });

  it("carries no text or media on the deleted work itself", async () => {
    const work = await ok("admin_get", {
      type: "work",
      id: ids.deletedWork,
      view: "full",
    });
    expect(JSON.stringify(work.data)).not.toContain("Deleted text");
    expect(JSON.stringify(work.data)).not.toContain("Deleted title");
  });
});

describe("the audit ledger", () => {
  it("holds no withheld value, whatever a call asked for and whatever came back", async () => {
    await send("admin_find", { query: CANARY.selfText });
    await send("admin_find", { query: CANARY.contact, type: "report" });
    await send("admin_read", {
      op: "list.works",
      input: { search: CANARY.selfTitle },
    });
    await send("admin_get", { type: "report", id: ids.selfReport });
    const rowsOf = async () =>
      (
        await (payload.db as unknown as PostgresAdapter).drizzle.execute(
          sql`SELECT to_jsonb(e)::text AS row FROM mcp_audit_events e WHERE key_label = ${`community-${run}`}`,
        )
      ).rows as { row: string }[];
    await vi.waitFor(
      async () => expect((await rowsOf()).length).toBeGreaterThanOrEqual(4),
      { timeout: 5_000, interval: 50 },
    );
    for (const { row } of await rowsOf()) {
      expectNoCanary(row, "audit");
      expect(row).not.toContain(HOSTILE);
    }
  });
});

describe("admin_find", () => {
  it("puts a handle given whole ahead of what merely contains it", async () => {
    const data = adminFindDataSchema.parse(
      (await ok("admin_find", { query: handles.reporter })).data,
    );
    expect(data.items[0]).toMatchObject({
      id: ids.reporter,
      match: { kind: "identity", field: "handle" },
    });
  });

  it("resolves @handle and each kind of id exactly, with a stable ref", async () => {
    for (const [query, type, id, source] of [
      [`@${handles.lishu}`, "user", ids.lishu, "users"],
      [ids.lishu, "user", ids.lishu, "users"],
      [ids.publicWork, "work", ids.publicWork, "works"],
      [ids.publicComment, "comment", ids.publicComment, "comments"],
      [ids.thread, "thread", ids.thread, "threads"],
      [ids.rightsReport, "report", ids.rightsReport, "reports"],
      [ids.feedback, "feedback", ids.feedback, "feedback"],
      [ids.job, "publishing_job", ids.job, "publishing_jobs"],
      [
        ids.publicRevision,
        "work_revision",
        ids.publicRevision,
        "work_revisions",
      ],
      [ids.item, "media_item", ids.item, "media_items"],
      [
        `https://x.example/?authorId=${ids.lishu}#profile`,
        "user",
        ids.lishu,
        "users",
      ],
      [`/?workId=${ids.publicWork}`, "work", ids.publicWork, "works"],
      [`/?topic=${ids.thread}`, "thread", ids.thread, "threads"],
      [ids.pendingArticle, "article", ids.pendingArticle, "article_documents"],
      [
        `/?articleId=${ids.pendingArticle}`,
        "article",
        ids.pendingArticle,
        "article_documents",
      ],
    ] as const) {
      const envelope = await ok("admin_find", { query });
      const data = adminFindDataSchema.parse(envelope.data);
      expect({ query, resolution: data.resolution }).toEqual({
        query,
        resolution: {
          status: "exact",
          uniqueIdentity: true,
          ref: { type, id },
        },
      });
      expect(envelope.meta.sources[source]).toBe("ok");
      expect(data.items[0]!.actions?.[0]).toEqual({
        tool: "admin_get",
        args: { type, id },
      });
      // Every skeleton it offers really is callable as it stands.
      for (const action of data.items[0]!.actions ?? []) {
        expect(action.tool).toMatch(/^admin_(?:get|read)$/u);
        await ok(action.tool, action.args as Json);
      }
    }
  });

  it("still leaves a link naming an Article and a work unresolved", async () => {
    const envelope = await ok("admin_find", {
      query: `/?articleId=${ids.pendingArticle}&workId=${ids.publicWork}`,
    });
    expect(adminFindDataSchema.parse(envelope.data).resolution).toEqual({
      status: "candidates",
      uniqueIdentity: false,
    });
  });

  it("never calls a handle unique while a source that could hold the word did not answer", async () => {
    const handle = `solehandle${run}`;
    const user = opaque("user");
    await setup.query(
      "INSERT INTO community.public_users(id,handle,display_name) VALUES($1,$2,$3)",
      [user, handle, `Sole ${run}`],
    );
    await setup.query(
      "INSERT INTO community.threads(id,title,description,created_by) VALUES($1,$2,'x','owner')",
      [opaque("thread"), `On ${handle}`],
    );
    const healthy = adminFindDataSchema.parse(
      (await ok("admin_find", { query: handle })).data,
    );
    expect(healthy.resolution).toEqual({
      status: "candidates",
      uniqueIdentity: false,
    });
    expect(healthy.items.map(({ type }) => type)).toEqual(["user", "thread"]);
    const holder = await setup.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        "LOCK TABLE community.threads IN ACCESS EXCLUSIVE MODE",
      );
      const locked = await ok("admin_find", { query: handle });
      const data = adminFindDataSchema.parse(locked.data);
      expect(locked.meta.sources.threads).toBe("timed_out");
      expect(locked.meta.partial).toBe(true);
      expect(data.resolution).toEqual({
        status: "candidates",
        uniqueIdentity: false,
      });
      expect(data.items.map(({ id }) => id)).toEqual([user]);
      expect(data.items[0]!.actions).toEqual([
        { tool: "admin_get", args: { type: "user", id: user } },
      ]);
      // The way through: these ask one source, and it answered.
      for (const args of [
        { query: handle, type: "user" },
        { query: `@${handle}` },
      ]) {
        const exact = await ok("admin_find", args);
        expect(exact.meta.sources).toEqual({ users: "ok" });
        expect(adminFindDataSchema.parse(exact.data).resolution).toEqual({
          status: "exact",
          uniqueIdentity: true,
          ref: { type: "user", id: user },
        });
      }
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  });

  it("reads an id that can name no record as a miss, never as a failed branch", async () => {
    for (const query of [
      "/?workId=a%20b",
      "/?authorId=a%20b",
      "/?workId=constructor",
    ]) {
      const envelope = await ok("admin_find", { query });
      expect(adminFindDataSchema.parse(envelope.data).resolution.status).toBe(
        "none",
      );
      expect(Object.values(envelope.meta.sources)).toEqual(["ok"]);
    }
  });

  it("gives an unbuilt invitation id its name, and never reads it as a miss", async () => {
    const envelope = await find(opaque("invitation"));
    expect(envelope.meta.sources.invitations).toBe("not_available");
    expect(envelope.meta.partial).toBe(true);
  });

  it("answers a withheld record as none, named, with the same answer as no record at all", async () => {
    const withheld = await ok("admin_find", { query: ids.selfWork });
    const absent = await ok("admin_find", { query: opaque("work") });
    expect(withheld.data).toEqual(absent.data);
    expect(withheld.meta).toEqual(absent.meta);
    expect(withheld.meta.excluded).toEqual(["self_only"]);
    expect(withheld.meta.sources).toEqual({ works: "ok" });
  });

  it("gives candidates only an admin_get, and never a unique identity on a display name", async () => {
    const envelope = await ok("admin_find", {
      query: twinName,
      type: "user",
    });
    const data = adminFindDataSchema.parse(envelope.data);
    expect(data.resolution).toEqual({
      status: "candidates",
      uniqueIdentity: false,
    });
    expect(data.items.map(({ id }) => id).sort()).toEqual(
      [ids.twinA, ids.twinB].sort(),
    );
    for (const item of data.items) {
      expect(item.match.kind).toBe("raw");
      expect(item.actions).toEqual([
        { tool: "admin_get", args: { type: "user", id: item.id } },
      ]);
      expect(item.disambiguators).toHaveProperty("handle");
    }
    expect(envelope.meta.sources).toEqual({ users: "ok" });
    expect(envelope.meta.partial).toBeUndefined();
  });

  it("searches every community branch beside the CMS ones, and names each", async () => {
    const envelope = await ok("admin_find", { query: `Reporter ${run}` });
    expect(envelope.meta.sources).toMatchObject({
      users: "ok",
      works: "ok",
      comments: "ok",
      threads: "ok",
      reports: "ok",
      catalogs_published: "ok",
      catalogs_draft: "ok",
      articles: "ok",
      collections: "ok",
      media: "ok",
    });
    const data = adminFindDataSchema.parse(envelope.data);
    expect(data.items.map(({ id }) => id)).toContain(ids.reporter);
    expectHostileMarked(envelope);
    expect(envelope.meta.excluded).toContain("self_only");
  });

  it("marks what a person wrote in a found record", async () => {
    for (const query of [HOSTILE, `${HOSTILE} worktitle`]) {
      const envelope = await ok("admin_find", { query });
      expect(expectHostileMarked(envelope)).toBeGreaterThan(0);
    }
  });

  it("pages across community candidates with one way on, each once", async () => {
    const seen: string[] = [];
    let args: Json | undefined = { query: HOSTILE, limit: 2 };
    while (args !== undefined) {
      const page: Json = await ok("admin_find", args);
      seen.push(
        ...adminFindDataSchema.parse(page.data).items.map(({ id }) => `${id}`),
      );
      args = page.next?.args;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(
      expect.arrayContaining([ids.author, ids.publicWork, ids.thread]),
    );
  });

  it("reports a timed-out branch per branch, and its SQL is really gone", async () => {
    const holder = await setup.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        "LOCK TABLE community.threads IN ACCESS EXCLUSIVE MODE",
      );
      const started = Date.now();
      const envelope = await ok("admin_find", {
        query: `Reporter ${run}`,
      });
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(envelope.meta.sources).toMatchObject({
        threads: "timed_out",
        users: "ok",
        works: "ok",
        comments: "ok",
        reports: "ok",
      });
      expect(envelope.meta.partial).toBe(true);
      // The other branches still answered, and this is not a zero.
      expect(
        adminFindDataSchema.parse(envelope.data).items.map(({ id }) => id),
      ).toContain(ids.reporter);
      // With the lock still held, no statement is left waiting behind it.
      const { rows } = await setup.query(
        "SELECT count(*)::integer AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
      );
      expect(rows[0]!.n).toBe(0);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  });

  it("names every branch when the Backend cannot be reached, and answers what the CMS has", async () => {
    vi.stubEnv("COMMUNITY_OPERATOR_BASE_URL", "http://127.0.0.1:9/");
    const envelope = await ok("admin_find", { query: `Reporter ${run}` });
    expect(envelope.meta.sources).toMatchObject({
      users: "failed",
      works: "failed",
      comments: "failed",
      threads: "failed",
      reports: "failed",
      catalogs_draft: "ok",
    });
    expect(envelope.meta.partial).toBe(true);
    const exact = await find(ids.lishu);
    expect(exact.meta.sources).toEqual({ users: "failed" });
    expect(exact.meta.partial).toBe(true);
  });

  it("answers not_available while the community token is not placed", async () => {
    vi.stubEnv("COMMUNITY_OPERATOR_AI_TOKEN", "");
    const envelope = await ok("admin_find", { query: `Reporter ${run}` });
    expect(envelope.meta.sources).toMatchObject({
      users: "not_available",
      reports: "not_available",
      catalogs_draft: "ok",
    });
    const exact = await find(`@${handles.lishu}`);
    expect(exact.meta.sources).toEqual({ users: "not_available" });
    expect(exact.meta.partial).toBe(true);
    // No address is built, so a query too long for one has nothing to be refused for.
    const long = await ok("admin_find", { query: `长 ${"碑".repeat(2_000)}` });
    expect(long.meta.sources).toMatchObject({
      users: "not_available",
      reports: "not_available",
      catalogs_draft: "ok",
    });
    expect(long.meta.partial).toBe(true);
  });

  it("refuses a query too long for the Backend's address by name, and what fits still reads", async () => {
    const query = `长 ${"碑".repeat(2_000)}`;
    const refused = await find(query);
    expect(refused).toMatchObject({
      ok: false,
      code: "INPUT_INVALID",
      issues: [{ path: ["query"], code: "too_long_for_community_search" }],
    });
    expect(refused.retryable).toBeUndefined();
    // Asking the CMS alone needs no such address.
    const cms = await ok("admin_find", { query, type: "catalog" });
    expect(cms.meta.sources.catalogs_draft).toBe("ok");
    for (const fits of [
      `长 ${"碑".repeat(1_000)}`,
      "a".repeat(2_048),
      "!".repeat(2_048),
    ]) {
      const read = await ok("admin_find", { query: fits });
      expect(read.meta.sources).toMatchObject({
        users: "ok",
        works: "ok",
        comments: "ok",
        threads: "ok",
        reports: "ok",
      });
    }
  });
});

describe("admin_read on a queue", () => {
  it("answers compact rows with no long text, and a total with no page number", async () => {
    const works = await ok("admin_read", {
      op: "list.works",
      input: { workId: ids.publicWork },
    });
    expect(works.data).toMatchObject({
      total: 1,
      filter: { workId: ids.publicWork },
    });
    // `next` is the one way on, so no page number survives, under any name.
    expect(works.data).not.toHaveProperty("page");
    expect(works.data).not.toHaveProperty("pageSize");
    expect(works.data).not.toHaveProperty("totalPages");
    expect(works.data).not.toHaveProperty("about");
    const [row] = works.data.rows;
    expect(row).toMatchObject({
      id: ids.publicWork,
      title: hostile("worktitle"),
      state: "visible",
    });
    expect(row).not.toHaveProperty("text");
    const projected = await ok("admin_read", {
      op: "list.works",
      fields: ["text"],
      input: { workId: ids.publicWork },
    });
    expect(projected.data.rows[0].text).toEqual({
      state: "VALUE",
      length: [...hostile("worktext")].length,
      hash: expect.any(String),
    });
    expect(works.meta.excluded).toEqual(["self_only"]);
    const comments = await ok("admin_read", {
      op: "list.comments",
      fields: ["text"],
      input: { authorId: ids.reporter },
    });
    expect(comments.data.about).toEqual({
      counts: expect.objectContaining({ all: 1 }),
    });
    expect(comments.data.rows[0].text).toMatchObject({ state: "VALUE" });
    expect(JSON.stringify(comments.data.rows)).not.toContain("commenttext");
  });

  it("walks a queue with next alone, every row once, the total true throughout", async () => {
    const author = opaque("user");
    await setup.query(
      "INSERT INTO community.public_users(id,handle,display_name) VALUES($1,$2,$3)",
      [author, `paged-${run}`, `Paged ${run}`],
    );
    const seeded = Array.from({ length: 53 }, () => opaque("feedback"));
    for (const [index, id] of seeded.entries())
      await setup.query(
        "INSERT INTO community.feedback(id,user_id,submission_id,message,created_at) VALUES($1,$2,$3,$4,CURRENT_TIMESTAMP - make_interval(secs => $5))",
        [id, author, randomUUID(), `Paged ${index}`, index],
      );
    const seen: string[] = [];
    let args: Json | undefined = {
      op: "list.feedback",
      input: { userId: author },
    };
    let calls = 0;
    while (args !== undefined && calls < 10) {
      const page: Json = await ok("admin_read", args);
      expect(page.data.total).toBe(seeded.length);
      expect(page.data).not.toHaveProperty("page");
      seen.push(...page.data.rows.map(({ id }: Json) => id));
      args = page.next?.args;
      calls += 1;
    }
    expect(args).toBeUndefined();
    expect(seen).toEqual(seeded);
  });

  it("cuts a page too large for one answer at a whole row, with next and nothing lost", async () => {
    const seeded = Array.from({ length: 50 }, () => opaque("thread"));
    for (const [index, id] of seeded.entries())
      await setup.query(
        "INSERT INTO community.threads(id,title,description,created_by,position) VALUES($1,$2,'x','owner',$3)",
        [
          id,
          `${run}${String(index).padStart(3, "0")}${"帖".repeat(105)}`,
          1000 + index,
        ],
      );
    const seen: string[] = [];
    let args: Json | undefined = {
      op: "list.threads",
      input: { search: run, pageSize: 50 },
    };
    let cuts = 0;
    let calls = 0;
    while (args !== undefined && calls < 15) {
      const page: Json = await ok("admin_read", args);
      if (page.meta.truncated) cuts += 1;
      seen.push(...page.data.rows.map(({ id }: Json) => id));
      args = page.next?.args;
      calls += 1;
    }
    expect(args).toBeUndefined();
    expect(cuts).toBeGreaterThan(0);
    expect(new Set(seen).size).toBe(seen.length);
    // The first Thread of this run's seed has its own position, ahead of these.
    expect(seen.filter((id) => seeded.includes(id))).toEqual(seeded);
  });

  it("pages pending Articles on the Backend's cursor, in pages that always fit", async () => {
    const document = JSON.stringify(emptyArticleDocument());
    const seeded: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      const id = opaque("article");
      seeded.push(id);
      const title = `${String(index).padStart(2, "0")}${"\u{20000}".repeat(118)}`;
      await setup.query(
        "INSERT INTO community.article_documents(id,owner_id,version,title,document,fingerprint,created_at,updated_at) VALUES($1,$2,1,$3,$4::jsonb,$5,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
        [id, ids.lishu, title, document, "e".repeat(64)],
      );
      await setup.query(
        "INSERT INTO community.article_revisions(article_id,version,owner_id,title,document,fingerprint,submitted_policy,submitted_by_source,created_at) VALUES($1,1,$2,$3,$4::jsonb,$5,'PRE_MODERATION','human',CURRENT_TIMESTAMP)",
        [id, ids.lishu, title, document, "e".repeat(64)],
      );
      await setup.query(
        "UPDATE community.article_documents SET version=2,status='pending',pending_version=1,updated_at=CURRENT_TIMESTAMP WHERE id=$1",
        [id],
      );
    }
    // It takes neither a page number nor a cut's numbered way on, so none can be handed out.
    for (const op of [
      "list.article_submissions",
      "community.read-article-submissions",
    ] as const)
      expect(adminOpMeta[op].paging).toBeUndefined();
    const first = await ok("admin_read", {
      op: "list.article_submissions",
      input: { pageSize: 50 },
    });
    expect(first.data.rows).toHaveLength(10);
    expect(first.data.filter).toEqual({ pageSizeCappedAt: 10 });
    expect(first.next.args.input).toEqual({
      cursor: expect.any(String),
      pageSize: 10,
    });
    const seen: string[] = [];
    let args: Json | undefined = {
      op: "list.article_submissions",
      input: { pageSize: 50 },
    };
    while (args !== undefined) {
      const page: Json = await ok("admin_read", args);
      expect(page.meta.truncated).toBeUndefined();
      expect(page.data.rows.length).toBeLessThanOrEqual(10);
      expect(page.data).not.toHaveProperty("nextCursor");
      seen.push(...page.data.rows.map(({ id }: Json) => id));
      args = page.next?.args;
    }
    expect(seen).toEqual(expect.arrayContaining(seeded));
    expect(new Set(seen).size).toBe(seen.length);
    const forged = await read({
      op: "list.article_submissions",
      input: { cursor: "AAAA" },
    });
    expect(forged).toMatchObject({ ok: false, code: "INPUT_INVALID" });
    // A cursor of the right shape holds only what the Backend writes: any other time
    // cannot ever succeed, so it is never told to retry.
    const cursorAt = (time: string) =>
      Buffer.from(JSON.stringify([time, opaque("article")]), "utf8").toString(
        "base64url",
      );
    for (const time of [
      "2026-01-01T00:00:00+16:00",
      "2026-01-01T00:00:00.000+00:00",
      `2026-01-01T00:00:00.${"1".repeat(200)}Z`,
      "2026-02-30T00:00:00.000Z",
      "0000-01-01T00:00:00.000Z",
      "+010000-01-01T00:00:00.000Z",
      "-000001-01-01T00:00:00.000Z",
      "2026-01-01",
    ]) {
      const refused = await read({
        op: "list.article_submissions",
        input: { cursor: cursorAt(time) },
      });
      expect(refused, time).toMatchObject({
        ok: false,
        code: "INPUT_INVALID",
        issues: [{ path: ["input"], code: "refused" }],
      });
      expect(refused.retryable, time).toBeUndefined();
    }
    for (const time of [
      "2026-01-01T00:00:00.000Z",
      "0001-01-01T00:00:00.000Z",
      "9999-12-31T23:59:59.999Z",
    ])
      await ok("admin_read", {
        op: "list.article_submissions",
        input: { cursor: cursorAt(time) },
      });
  });

  it("reads at most the report page that can fit, says so in its filter, and goes on from what it read", async () => {
    const asked: URLSearchParams[] = [];
    const answers = await withStubBackend(
      (request, response) => {
        asked.push(new URL(request.url ?? "/", "http://stub").searchParams);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ items: [], total: 0, page: 1, pageSize: 30 }),
        );
      },
      async () => [
        await ok("admin_read", {
          op: "list.reports",
          input: { pageSize: 100 },
        }),
        await ok("admin_read", {
          op: "list.appeals",
          input: { pageSize: 100 },
        }),
        await ok("admin_read", { op: "list.reports", input: { pageSize: 30 } }),
        await ok("admin_read", { op: "list.reports" }),
      ],
    );
    expect(asked.map((params) => params.get("pageSize"))).toEqual([
      "30",
      "30",
      "30",
      "20",
    ]);
    expect(answers.map(({ data }) => data.filter)).toEqual([
      { pageSizeCappedAt: 30 },
      { status: "appealed", pageSizeCappedAt: 30 },
      {},
      {},
    ]);
    // Page 2 of an asked 100 read rows 31 to 60, so a cut there goes on from those.
    const next = readContinuation(
      { op: "list.reports", input: { page: 2, pageSize: 100 } },
      Array.from({ length: 5 }, () => ({})),
    )!.args as { input: { page: number; pageSize: number } };
    expect((next.input.page - 1) * next.input.pageSize).toBe(35);
  });

  it("says so when a count leaves out cases only the Owner reviews, and only then", async () => {
    const hinted = /only the Owner reviews are not in this total/u;
    for (const [groupBy, input] of [
      ["reason", {}],
      ["targetType", {}],
      ["kind", { urgent: "false" }],
      [undefined, { targetType: "work" }],
    ] as const)
      expect(
        (
          await ok("admin_read", {
            op: "list.reports",
            view: "count",
            ...(groupBy === undefined ? {} : { groupBy }),
            input,
          })
        ).hint,
      ).toMatch(hinted);
    for (const [op, groupBy] of [
      ["list.reports", "kind"],
      ["list.reports", "status"],
      ["list.reports", undefined],
      ["list.comments", "kind"],
    ] as const) {
      const counted = await ok("admin_read", {
        op,
        view: "count",
        ...(groupBy === undefined ? {} : { groupBy }),
      });
      expect(counted.hint).toBeUndefined();
      expect(counted.data).not.toHaveProperty("leavesOutOwnerOnly");
    }
  });

  it("says the same over rows, by the query alone, so it says nothing of any one case", async () => {
    const hinted = /only the Owner reviews are not in this total/u;
    const rowsOf = (op: string, input: Json) => ok("admin_read", { op, input });
    const plain = await rowsOf("list.reports", {});
    const onWorks = await rowsOf("list.reports", { targetType: "work" });
    expect(onWorks.hint).toMatch(hinted);
    expect(onWorks.data.total).toBeLessThan(plain.data.total);
    expect(onWorks.data).not.toHaveProperty("leavesOutOwnerOnly");
    expect(onWorks.data).not.toHaveProperty("about");
    expect(JSON.stringify(onWorks)).not.toContain("leavesOutOwnerOnly");
    for (const [op, input] of [
      ["list.reports", { urgent: "false" }],
      ["list.reports", { urgent: "true" }],
      ["list.reports", { targetType: "work", targetId: ids.publicWork }],
      ["list.reports", { reporterId: ids.reporter }],
      ["list.reports", { affectedUserId: ids.author }],
      ["list.appeals", { targetType: "work" }],
      // It holds nothing at all, and says so all the same.
      ["list.reports", { reporterId: opaque("user") }],
    ] as const)
      expect((await rowsOf(op, input)).hint, JSON.stringify(input)).toMatch(
        hinted,
      );
    // It stays beside the way on.
    const firstOfMany = await rowsOf("list.reports", {
      targetType: "work",
      pageSize: 1,
    });
    expect(firstOfMany.hint).toMatch(hinted);
    expect(firstOfMany.next).toBeDefined();
    for (const [op, input] of [
      ["list.reports", {}],
      ["list.reports", { status: "open" }],
      ["list.reports", { unresolved: "true" }],
      ["list.appeals", {}],
      ["list.comments", {}],
    ] as const)
      expect(
        (await rowsOf(op, input)).hint,
        JSON.stringify(input),
      ).toBeUndefined();
  });

  it("counts in SQL, equal to its list, with how long the oldest has waited", async () => {
    const unresolved = await ok("admin_read", {
      op: "list.reports",
      view: "count",
      groupBy: "kind",
      input: { unresolved: "true" },
    });
    const { rows } = await setup.query(
      `SELECT kind,count(*)::integer AS count,min(created_at) AS oldest FROM community.report_cases
       WHERE status IN ('open','reviewing','appealed') GROUP BY kind`,
    );
    expect(unresolved.data.total).toBe(
      rows.reduce((sum, row) => sum + Number(row.count), 0),
    );
    for (const row of rows)
      expect(
        unresolved.data.groups.find(({ value }: Json) => value === row.kind),
      ).toEqual({
        value: row.kind,
        count: row.count,
        oldestAt: (row.oldest as Date).toISOString(),
      });
    expect(unresolved.data.oldestAt).toBeTypeOf("string");
    expect(unresolved.data.filter).toEqual({ unresolved: "true" });
    expect(unresolved.meta.excluded).toEqual(["self_only"]);

    for (const [op, input] of [
      ["list.works", {}],
      ["list.users", {}],
      ["list.comments", { moderation: "visible", order: "oldest" }],
      ["list.work_submissions", {}],
      ["list.jobs", { state: "queued" }],
      ["list.reports", { status: "open" }],
    ] as const) {
      const counted = await ok("admin_read", { op, view: "count", input });
      const listed = await ok("admin_read", { op, input });
      expect(counted.data.total, op).toBe(listed.data.total);
    }
    const appeals = await ok("admin_read", {
      op: "list.appeals",
      view: "count",
    });
    expect(appeals.data.filter).toEqual({ status: "appealed" });
    expect(appeals.data.total).toBe(
      (
        await setup.query(
          "SELECT count(*)::integer AS n FROM community.report_cases WHERE status='appealed'",
        )
      ).rows[0]!.n,
    );
  });

  it("offers each source's groups by name, and refuses any other", async () => {
    for (const [op, source] of [
      ["list.reports", "reports"],
      ["list.comments", "comments"],
      ["list.works", "works"],
      ["list.users", "users"],
      ["list.work_submissions", "work_submissions"],
      ["list.jobs", "jobs"],
    ] as const) {
      const allowed = AI_COUNT_GROUPS[source];
      for (const groupBy of allowed)
        await ok("admin_read", { op, view: "count", groupBy });
      for (const groupBy of ["constructor", "__proto__", "contact"])
        expect(await read({ op, view: "count", groupBy })).toMatchObject({
          code: "INPUT_INVALID",
          issues: [
            {
              path: ["groupBy"],
              code: "unknown_group",
              allowedKeys: [...allowed],
            },
          ],
        });
    }
    expect(await read({ op: "list.threads", view: "count" })).toMatchObject({
      code: "INPUT_INVALID",
      issues: [{ path: ["view"], code: "not_for_this_op" }],
    });
  });

  it("answers no number when a count runs out of time, and a lock leaves nothing waiting", async () => {
    const holder = await setup.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        "LOCK TABLE community.publishing_jobs IN ACCESS EXCLUSIVE MODE",
      );
      const answer = await read({ op: "list.jobs", view: "count" });
      expect(answer).toMatchObject({
        ok: false,
        code: "READ_TIMED_OUT",
        retryable: true,
      });
      expect(answer).not.toHaveProperty("data");
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  });

  it("ends an AI comment read that turns slow, by name, where the Owner's read waits as it always has", async () => {
    let ownerAnswered = false;
    let ownerRead: Promise<Response> | undefined;
    const holder = await setup.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("LOCK TABLE community.works IN ACCESS EXCLUSIVE MODE");
      ownerRead = fetch(
        `${backendOrigin}internal/community/comments?pageSize=1`,
        { headers: { authorization: `Bearer ${ownerToken}` } },
      ).finally(() => {
        ownerAnswered = true;
      });
      for (const args of [
        { op: "list.comments" },
        { op: "community.read-summary", input: { range: "30d" } },
      ]) {
        const started = Date.now();
        const answer = await read(args);
        expect(answer, args.op).toMatchObject({
          ok: false,
          code: "READ_TIMED_OUT",
          retryable: true,
        });
        expect(answer, args.op).not.toHaveProperty("data");
        // Its own limit ended it, inside the 15 s call.
        expect(Date.now() - started, args.op).toBeGreaterThanOrEqual(3_500);
        expect(Date.now() - started, args.op).toBeLessThan(14_000);
      }
      expect(ownerAnswered).toBe(false);
      // Only the Owner's statement is left waiting behind the lock.
      const { rows } = await setup.query(
        "SELECT count(*)::integer AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
      );
      expect(rows[0]!.n).toBe(1);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    expect((await ownerRead)?.status).toBe(200);
  });

  it("resolves a named range in Asia/Shanghai, echoes the instants, and refuses both ways at once", async () => {
    const listed = await ok("admin_read", {
      op: "list.comments",
      input: { authorId: ids.lishu, range: "last_7_days" },
    });
    expect(listed.data.filter).toMatchObject({
      authorId: ids.lishu,
      range: "last_7_days",
      tz: "Asia/Shanghai",
      from: expect.any(String),
      to: expect.any(String),
    });
    const { from, to } = listed.data.filter as { from: string; to: string };
    // The finished days only, ending one instant before a Shanghai midnight.
    expect(
      new Date(new Date(to).getTime() + 1 + 8 * 3_600_000).toISOString(),
    ).toMatch(/T00:00:00\.000Z$/u);
    expect(Date.parse(to) + 1 - Date.parse(from)).toBe(7 * 86_400_000);
    expect(listed.data.rows.map(({ id }: Json) => id)).toEqual([
      ids.yesterdayComment,
    ]);
    const counted = await ok("admin_read", {
      op: "list.comments",
      view: "count",
      input: { authorId: ids.lishu, range: "last_7_days" },
    });
    expect(counted.data.total).toBe(1);
    expect(counted.data.filter).toMatchObject({ range: "last_7_days" });
    const all = await ok("admin_read", {
      op: "list.comments",
      input: { authorId: ids.lishu },
    });
    expect(all.data.total).toBe(2);
    expect(
      await read({
        op: "list.comments",
        input: { range: "today", from: new Date().toISOString() },
      }),
    ).toMatchObject({ code: "INPUT_INVALID" });
    const works = await ok("admin_read", {
      op: "list.works",
      input: { range: "last_30_days", authorId: ids.author },
    });
    expect(works.data.filter.range).toBe("last_30_days");
  });

  it("ends a named range on the last microsecond, so a row in its last millisecond is in it", async () => {
    const id = opaque("comment");
    await setup.query(
      `INSERT INTO community.catalog_comments(id,catalog_id,target_type,author_id,text,moderation,created_at)
       VALUES($1,$2,'work',$3,$4,'visible',
         date_trunc('day',CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai' - interval '500 microseconds')`,
      [id, ids.publicWork, ids.twinB, `Last millisecond ${run}`],
    );
    const input = { authorId: ids.twinB, range: "last_7_days" };
    const listed = await ok("admin_read", { op: "list.comments", input });
    expect(listed.data.filter.to).toMatch(/\.999999Z$/u);
    expect(listed.data.rows.map((row: Json) => row.id)).toEqual([id]);
    const counted = await ok("admin_read", {
      op: "list.comments",
      view: "count",
      input,
    });
    expect(counted.data.total).toBe(1);
  });

  it("names a bad input, never as an internal error", async () => {
    for (const [args, path] of [
      [{ op: "list.works", fields: ["constructor"] }, ["fields"]],
      [{ op: "list.works", fields: ["__proto__"] }, ["fields"]],
      [{ op: "list.works", groupBy: "state" }, ["groupBy"]],
      [{ op: "list.works", cursor: "1" }, ["cursor"]],
      [{ op: "list.works", pageSize: 5 }, ["pageSize"]],
      [{ op: "community.read-report", view: "full" }, ["view"]],
      [{ op: "list.works", input: { page: 0 } }, ["input", "page"]],
      [{ op: "list.works", input: { page: 1e12 } }, ["input", "page"]],
      [{ op: "list.works", input: { pageSize: 1000 } }, ["input", "pageSize"]],
      [{ op: "list.reports", input: { page: -1 } }, ["input", "page"]],
      [{ op: "list.works", input: { workId: "nope" } }, ["input", "workId"]],
      [{ op: "list.works", input: { search: "\u0000" } }, ["input", "search"]],
      [
        { op: "list.comments", input: { from: "2026-13-40T00:00:00Z" } },
        ["input", "from"],
      ],
      [
        { op: "list.comments", input: { from: "2026-01-01T00:00:00+23:00" } },
        ["input", "from"],
      ],
      [
        { op: "list.works", input: { to: "2026-01-01T00:00:00-16:00" } },
        ["input", "to"],
      ],
      [
        {
          op: "list.comments",
          view: "count",
          input: { from: "2026-01-01T00:00+23:00" },
        },
        ["input", "from"],
      ],
      [
        { op: "community.read-comment", input: { id: "nope" } },
        ["input", "id"],
      ],
      [
        { op: "community.read-report", input: { id: "\ud800" } },
        ["input", "id"],
      ],
      [{ op: "list.reports", input: { urgent: "maybe" } }, ["input", "urgent"]],
      [
        { op: "list.threads", input: { includeHidden: "yes" } },
        ["input", "includeHidden"],
      ],
    ] as const) {
      const answer = await read(args);
      expect(answer.code, JSON.stringify(args)).toBe("INPUT_INVALID");
      expect(answer.issues[0].path.slice(0, path.length)).toEqual(path);
      expect(JSON.stringify(answer)).not.toContain("nope");
    }
    // A key every object inherits is no field.
    const inherited = await client.callTool({
      name: "admin_read",
      arguments: JSON.parse(
        '{"op":"list.works","input":{"constructor":"x","__proto__":{"x":1}}}',
      ),
    });
    expect(inherited.structuredContent).toMatchObject({
      code: "INPUT_INVALID",
    });
    const unknown = await read({
      op: "community.read-report",
      input: { id: opaque("report") },
    });
    expect(unknown).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("narrows threads by whether they are hidden", async () => {
    const hidden = opaque("thread");
    await setup.query(
      "INSERT INTO community.threads(id,title,description,created_by,hidden_at) VALUES($1,$2,'x','owner',CURRENT_TIMESTAMP)",
      [hidden, `Hidden ${run}`],
    );
    const shown = await ok("admin_read", {
      op: "list.threads",
      input: { search: `Hidden ${run}`, includeHidden: false },
    });
    expect(shown.data.total).toBe(0);
    const all = await ok("admin_read", {
      op: "list.threads",
      input: { search: `Hidden ${run}` },
    });
    expect(all.data.rows[0]).toMatchObject({ id: hidden, state: "hidden" });
  });

  it("answers a named failure when the Backend is gone, and the token not being placed", async () => {
    vi.stubEnv("COMMUNITY_OPERATOR_BASE_URL", "http://127.0.0.1:9/");
    expect(await read({ op: "list.works" })).toMatchObject({
      ok: false,
      code: "COMMUNITY_UNAVAILABLE",
      retryable: true,
    });
    expect(await get("work", ids.publicWork)).toMatchObject({
      ok: false,
      code: "COMMUNITY_UNAVAILABLE",
    });
    vi.stubEnv("COMMUNITY_OPERATOR_BASE_URL", backendOrigin);
    vi.stubEnv("COMMUNITY_OPERATOR_AI_TOKEN", "");
    for (const op of ["list.works", "list.reports", "community.read-users"])
      expect(await read({ op })).toMatchObject({
        ok: false,
        code: "AI_CREDENTIAL_NOT_CONFIGURED",
      });
    expect(await get("work", ids.publicWork)).toMatchObject({
      ok: false,
      code: "AI_CREDENTIAL_NOT_CONFIGURED",
    });
    // A Payload read in Admin, so it needs no token at all.
    await ok("admin_read", { op: "list.feature_catalogs" });
  });

  it("refuses the Owner's credential standing in for AI's", async () => {
    vi.stubEnv("COMMUNITY_OPERATOR_AI_TOKEN", syntheticToken());
    vi.stubEnv("COMMUNITY_OPERATOR_TOKEN", ownerToken);
    expect(await read({ op: "list.works" })).toMatchObject({
      ok: false,
      code: "AI_ROUTE_FORBIDDEN",
    });
  });

  it("lists these ops as built, and each op's answer shape as rows", async () => {
    const details = await ok("admin_actions", {
      ops: ["list.reports", "community.read-report", "list.invitations"],
    });
    const [reports, report, invitations] = details.data.details;
    expect(reports.available).toBe(true);
    expect(reports.output.properties).toHaveProperty("rows");
    expect(report.available).toBe(true);
    expect(report.output).toBeTypeOf("object");
    expect(JSON.stringify(report.output)).not.toContain("contact");
    expect(invitations).toMatchObject({
      available: false,
      unavailable: "not_available",
    });
  });
});

describe("the AI's share of the App pool", () => {
  it("holds at most 2 calls at the Backend, across admin_read, admin_get and admin_find, and the rest wait their turn", async () => {
    let inFlight = 0;
    let peak = 0;
    let reached = 0;
    const held: ServerResponse[] = [];
    const answers = await withStubBackend(
      (_request, response) => {
        reached += 1;
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        response.on("close", () => {
          inFlight -= 1;
        });
        held.push(response);
      },
      async () => {
        const running = Promise.all([
          read({ op: "list.comments" }),
          read({ op: "list.reports", view: "count" }),
          read({ op: "community.read-summary", input: { range: "30d" } }),
          get("user", ids.lishu),
          find(`Reporter ${run}`),
          find(ids.lishu),
        ]);
        await vi.waitFor(() => expect(reached).toBe(2));
        // The door has had every call for a while, and the third waits for a slot.
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(reached).toBe(2);
        let settled = false;
        void running.finally(() => {
          settled = true;
        });
        while (!settled) {
          const next = held.shift();
          if (next === undefined) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            continue;
          }
          next.writeHead(503, { "content-type": "application/json" });
          next.end(
            JSON.stringify({
              error: { status: 503, code: "OPERATOR_UNAVAILABLE" },
            }),
          );
        }
        return running;
      },
    );
    expect(peak).toBe(2);
    expect(reached).toBeGreaterThanOrEqual(answers.length);
    // Each named what happened to it, and none read as a number or a miss.
    for (const answer of answers.slice(0, 4))
      expect(answer.code, JSON.stringify(answer)).toBe("COMMUNITY_UNAVAILABLE");
    for (const answer of answers.slice(4)) {
      expect(answer.meta.partial).toBe(true);
      expect(Object.values(answer.meta.sources)).toContain("failed");
    }
  });
});

describe("admin_get on a community record", () => {
  it("never reads a source that did not answer as a miss, on an Article or a media item", async () => {
    const lookups = [
      ["article", ids.pendingArticle, "article_documents"],
      ["media_item", ids.item, "media_items"],
    ] as const;
    for (const [type, id, table] of lookups) {
      await ok("admin_get", { type, id });
      const holder = await setup.connect();
      try {
        await holder.query("BEGIN");
        await holder.query(
          `LOCK TABLE community.${table} IN ACCESS EXCLUSIVE MODE`,
        );
        const locked = await get(type, id);
        expect(locked, type).toMatchObject({
          ok: false,
          code: "READ_TIMED_OUT",
          retryable: true,
        });
        expect(locked, type).not.toHaveProperty("data");
      } finally {
        await holder.query("ROLLBACK");
        holder.release();
      }
      await withStubBackend(
        (_request, response) => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              items: [],
              sources: { [table]: "failed" },
              excluded: [],
            }),
          );
        },
        async () => {
          expect(await get(type, id), type).toMatchObject({
            ok: false,
            code: "COMMUNITY_UNAVAILABLE",
            retryable: true,
          });
        },
      );
      vi.stubEnv("COMMUNITY_OPERATOR_BASE_URL", backendOrigin);
    }
    // A source that did answer still calls a miss a miss.
    for (const [type, id] of [
      ["article", opaque("article")],
      ["media_item", opaque("media-item")],
    ] as const)
      expect(await get(type, id), type).toMatchObject({
        ok: false,
        code: "NOT_FOUND",
      });
  });

  it("answers an outline with state, length and hash, and no long text", async () => {
    const work = await ok("admin_get", { type: "work", id: ids.publicWork });
    expect(work.data).toMatchObject({
      type: "work",
      id: ids.publicWork,
      view: "outline",
      readFrom: "live",
      state: "visible",
      title: hostile("worktitle"),
    });
    const fields = Object.fromEntries(
      work.data.fields.map((field: Json) => [field.name, field]),
    );
    expect(fields.text).toEqual({
      name: "text",
      state: "VALUE",
      length: [...hostile("worktext")].length,
      hash: expect.any(String),
    });
    expect(work.data.actions[0]).toEqual({
      tool: "admin_get",
      args: { type: "work", id: ids.publicWork },
    });
    expect(work.meta.excluded).toEqual(["self_only"]);
  });

  it("reads each type, in each view, with a person's words marked", async () => {
    for (const [type, id, field] of [
      ["user", ids.author, "bio"],
      ["work", ids.publicWork, "text"],
      ["comment", ids.publicComment, "text"],
      ["thread", ids.thread, "description"],
      ["report", ids.rightsReport, "description"],
      ["feedback", ids.feedback, "message"],
      ["work_revision", ids.publicRevision, "body"],
      ["article", ids.pendingArticle, "document"],
    ] as const) {
      const outline = await ok("admin_get", { type, id });
      expectHostileMarked(outline);
      const full = await ok("admin_get", { type, id, view: "full" });
      expectHostileMarked(full);
      const window = await ok("admin_get", { type, id, field });
      expect(window.data.fieldState, type).toBe("VALUE");
      expect(window.data.offsetUnit).toBe("codePoint");
      // Not blind: each of these fields really holds a person's words.
      if (type !== "article")
        expect(expectHostileMarked(window), type).toBeGreaterThan(0);
    }
    const job = await ok("admin_get", {
      type: "publishing_job",
      id: ids.job,
      view: "full",
    });
    expect(job.data.state).toBe("queued");
    const item = await ok("admin_get", { type: "media_item", id: ids.item });
    expect(item.data.state).toBe("awaiting_upload");
  });

  it("finds inside one field, and pages its matches", async () => {
    const found = await ok("admin_get", {
      type: "report",
      id: ids.longReport,
      field: "description",
      find: { text: run },
    });
    expect(found.data.count).toBe(1);
    expect(found.data.matches[0].offset).toBe(
      [...LONG_NOTICE].length - run.length,
    );
  });

  it("says which user a person asks about in the outline, with withheld works left out", async () => {
    const user = await ok("admin_get", { type: "user", id: ids.author });
    const facts = Object.fromEntries(
      user.data.fields.map(({ name, value }: Json) => [name, value]),
    );
    expect(facts).toMatchObject({
      handle: handles.author,
      status: "active",
      submittedWorks: 1,
    });
  });

  it("names a bad input, and an id that can name nothing is a miss", async () => {
    for (const [args, code] of [
      [{ type: "work", id: 7 }, "NOT_FOUND"],
      [{ type: "report", id: "report-a\u0000b" }, "NOT_FOUND"],
      [{ type: "report", id: "\ud800" }, "NOT_FOUND"],
      [{ type: "report", id: "report-\udc00" }, "NOT_FOUND"],
      [{ type: "user", id: "has space" }, "NOT_FOUND"],
      [{ type: "user", id: "nope" }, "NOT_FOUND"],
      [{ type: "comment", id: "nope" }, "NOT_FOUND"],
      [{ type: "work_revision", id: "nope" }, "NOT_FOUND"],
      [{ type: "work", id: opaque("work") }, "NOT_FOUND"],
      [{ type: "invitation", id: opaque("invitation") }, "NOT_AVAILABLE"],
      [{ type: "work", id: ids.publicWork, view: "diff" }, "INPUT_INVALID"],
      [
        { type: "work", id: ids.publicWork, fields: ["constructor"] },
        "INPUT_INVALID",
      ],
      [
        { type: "work", id: ids.publicWork, field: "__proto__" },
        "INPUT_INVALID",
      ],
      [
        { type: "report", id: ids.rightsReport, field: "materials.999.text" },
        "INPUT_INVALID",
      ],
    ] as const) {
      const answer = await call("admin_get", args);
      expect(answer.code, JSON.stringify(args)).toBe(code);
      expect(answer.ok).toBe(false);
    }
  });

  it("answers a self-only comment and revision by name, and a withheld work with the same miss as no work", async () => {
    for (const [type, id] of [
      ["comment", ids.selfComment],
      ["comment", ids.selfReply],
      ["work_revision", ids.selfRevision],
    ] as const) {
      const answer = await get(type, id);
      expect(answer).toMatchObject({
        ok: false,
        code: "SELF_ONLY_OWNER_REVIEW",
      });
      expect(answer).not.toHaveProperty("data");
    }
    const withheld = await get("work", ids.selfWork);
    const absent = await get("work", opaque("work"));
    expect(withheld).toEqual(absent);
    expect(withheld.meta.excluded).toEqual(["self_only"]);
  });

  it("reads a draft Article as nothing, and names why", async () => {
    const draft = opaque("article");
    await setup.query(
      `INSERT INTO community.article_documents(id,owner_id,version,title,document,fingerprint,status,created_at,updated_at)
       VALUES($1,$2,1,$3,$4::jsonb,$5,'draft',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
      [
        draft,
        ids.author,
        `draftcanary${run}`,
        JSON.stringify(emptyArticleDocument()),
        "f".repeat(64),
      ],
    );
    const { envelope, text } = await send("admin_get", {
      type: "article",
      id: draft,
    });
    expect(envelope).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(envelope.meta.excluded).toEqual(["private_draft"]);
    expect(text).not.toContain(`draftcanary${run}`);
  });
});

describe("what comes back from the Backend", () => {
  it("gives a pending Article's text with no media address", async () => {
    const pending = await ok("admin_read", {
      op: "community.read-article-submission",
      input: { id: ids.pendingArticle },
    });
    expect(pending.data).toMatchObject({
      articleId: ids.pendingArticle,
      title: hostile("articletitle"),
    });
    expect(pending.data).not.toHaveProperty("resolvedReferences");
    expect(pending.meta.redacted).toEqual(["resolvedReferences"]);
  });

  it("is checked against what AI may read: a contact in the answer leaves nothing", async () => {
    const stub = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: ids.rightsReport,
          claimant: { name: "x", contact: CANARY.contact, rightsBasis: "y" },
        }),
      );
    });
    await new Promise<void>((resolve) =>
      stub.listen(0, "127.0.0.1", () => resolve()),
    );
    try {
      vi.stubEnv(
        "COMMUNITY_OPERATOR_BASE_URL",
        `http://127.0.0.1:${(stub.address() as AddressInfo).port}/`,
      );
      for (const args of [
        { op: "community.read-report", input: { id: ids.rightsReport } },
        { op: "list.reports" },
      ]) {
        const { envelope, text } = await send("admin_read", args);
        expect(envelope).toMatchObject({
          ok: false,
          code: "BACKEND_CONTRACT_MISMATCH",
        });
        expect(text).not.toContain(CANARY.contact);
      }
      const got = await send("admin_get", {
        type: "report",
        id: ids.rightsReport,
      });
      expect(got.envelope.code).toBe("BACKEND_CONTRACT_MISMATCH");
      expect(got.text).not.toContain(CANARY.contact);
    } finally {
      stub.closeAllConnections();
      await new Promise((resolve) => stub.close(resolve));
    }
  });
});

describe("the byte routes", () => {
  const mediaRoute = (revision: string, item: string) =>
    `publishing/media/${revision}/${item}/display/base`;
  const bytesOf = async (route: string) => {
    const opened = await openCommunityAiMedia(route, null, undefined);
    return Buffer.from(await new Response(opened.body).arrayBuffer());
  };
  const raw = (
    route: string,
    token: string,
    init: { method?: string; headers?: Record<string, string> } = {},
  ) =>
    fetch(`${backendOrigin}internal/community/${route}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${token}`, ...init.headers },
    });
  const withheld = () => mediaRoute(ids.selfItemRevision, ids.selfBytesItem);

  it("serves real bytes of a public work's item to AI, so these refusals are not blind", async () => {
    expect(
      await bytesOf(mediaRoute(ids.publicRevision, ids.publicBytesItem)),
    ).toEqual(PNG_BYTES.public);
    const owner = await raw(withheld(), ownerToken);
    expect(owner.status).toBe(200);
    expect(Buffer.from(await owner.arrayBuffer())).toEqual(PNG_BYTES.self);
  });

  it("refuses an item of a self-only work on AI's media route, by name and with no byte", async () => {
    await expect(
      openCommunityAiMedia(withheld(), null, undefined),
    ).rejects.toMatchObject({ code: "SELF_ONLY_OWNER_REVIEW", status: 403 });
    for (const init of [
      {},
      { headers: { range: "bytes=0-1" } },
      { headers: { "x-ai-sensitive": "self_only" } },
    ]) {
      const answer = await raw(withheld(), communityToken, init);
      expect(answer.status).toBe(403);
      const body = await answer.text();
      expect(JSON.parse(body).error.code).toBe("SELF_ONLY_OWNER_REVIEW");
      expect(body).not.toContain(PNG_BYTES.self.toString());
    }
    // No other method on the row, and an id spelled another way is the same id.
    expect(
      (await raw(withheld(), communityToken, { method: "HEAD" })).status,
    ).toBe(403);
    const spelled = await raw(
      mediaRoute(ids.selfItemRevision.replace("-", "%2D"), ids.selfBytesItem),
      communityToken,
    );
    expect((await spelled.json()).error.code).toBe("SELF_ONLY_OWNER_REVIEW");
    // The item through a revision that does not hold it opens nothing.
    await expect(
      bytesOf(mediaRoute(ids.publicRevision, ids.selfBytesItem)),
    ).rejects.toBeInstanceOf(CommunityOperatorError);
  });

  it("follows the work's current visibility, with no answer kept", async () => {
    await setup.query(
      "UPDATE community.works SET visibility='public' WHERE id=$1",
      [ids.selfWork],
    );
    try {
      expect(await bytesOf(withheld())).toEqual(PNG_BYTES.self);
    } finally {
      await setup.query(
        "UPDATE community.works SET visibility='self' WHERE id=$1",
        [ids.selfWork],
      );
    }
    await expect(
      openCommunityAiMedia(withheld(), null, undefined),
    ).rejects.toMatchObject({ code: "SELF_ONLY_OWNER_REVIEW" });
  });

  it("refuses an Article's media while it uses an item of a self-only work", async () => {
    const articleMedia = (article: string) =>
      `articles/${article}/submission-media?${new URLSearchParams({
        expectedVersion: "2",
        candidateVersion: "1",
        fingerprint: ARTICLE_FINGERPRINT,
        refId: "used",
        variant: "display",
      })}`;
    await expect(
      openCommunityAiMedia(articleMedia(ids.selfMediaArticle), null, undefined),
    ).rejects.toMatchObject({ code: "SELF_ONLY_OWNER_REVIEW", status: 403 });
    // Not because of the route: another item, or the Owner, is not refused by name.
    const other = await raw(
      articleMedia(ids.publicMediaArticle),
      communityToken,
    );
    expect(((await other.json()) as Json).error?.code).not.toBe(
      "SELF_ONLY_OWNER_REVIEW",
    );
    const owner = await raw(articleMedia(ids.selfMediaArticle), ownerToken);
    expect(((await owner.json()) as Json).error?.code).not.toBe(
      "SELF_ONLY_OWNER_REVIEW",
    );
    // Its text stays AI's, and holds an item's id and nothing of the work.
    const { envelope, text } = await send("admin_read", {
      op: "community.read-article-submission",
      input: { id: ids.selfMediaArticle },
    });
    expect(envelope.ok).toBe(true);
    expectNoCanary(text, "article");
    expect(envelope.meta.redacted).toEqual(["resolvedReferences"]);
  });

  it("refuses evidence on AI's route with an empty env, for a case of any state", async () => {
    for (const state of NOTICE_STATES) {
      const answer = await raw(
        `reports/${notices.public[state]}/evidence/${opaque("evidence")}`,
        communityToken,
        { headers: { "x-ai-sensitive": "evidence" } },
      );
      expect(answer.status, state).toBe(403);
      expect((await answer.json()).error.code).toBe("SENSITIVE_SWITCH_OFF");
    }
    await expect(
      openCommunityAiEvidence(
        `reports/${ids.rightsReport}/evidence/${opaque("evidence")}`,
        null,
        undefined,
      ),
    ).rejects.toMatchObject({ code: "SENSITIVE_SWITCH_OFF", status: 403 });
  });
});

describe("the switches", () => {
  afterEach(async () => {
    await payload.updateGlobal({
      slug: "mcp-control",
      overrideAccess: true,
      data: { dm: false, evidence: false, rawIp: false, selfOnly: false },
    });
  });

  const openEverySwitch = async () => {
    for (const category of ADMIN_MCP_SENSITIVE_CATEGORIES)
      await payload.updateGlobal({
        slug: "mcp-control",
        overrideAccess: true,
        data: {
          [category]: true,
          complianceConfirmation: ADMIN_MCP_COMPLIANCE_PHRASES[category],
        } as never,
      });
  };

  it("opens no contact with every switch on, in any state, and what the Backend cannot yet open stays shut", async () => {
    await openEverySwitch();
    expect(
      await payload.findGlobal({ slug: "mcp-control", overrideAccess: true }),
    ).toMatchObject({ dm: true, evidence: true, rawIp: true, selfOnly: true });
    for (const state of NOTICE_STATES) {
      const id = notices.public[state];
      for (const args of [
        { op: "community.read-report", input: { id } },
        {
          op: "list.reports",
          view: "full",
          input: { status: state, pageSize: 100 },
        },
      ]) {
        const { envelope, text } = await send("admin_read", args);
        expect(envelope.ok, state).toBe(true);
        expect(text).not.toContain(CANARY.contact);
        expect(text).not.toContain('"contact"');
        // The slice that builds x-ai-sensitive changes these two, and no other test.
        expect(text).not.toContain(CANARY.evidenceName);
        expectNoCanary(text, state);
      }
      const got = await send("admin_get", { type: "report", id, view: "full" });
      expect(got.text).not.toContain(CANARY.contact);
    }
  });
});

describe("the release record's App-role preflight", () => {
  const preflightFor = async (name: string) => {
    const record = await readFile(
      `${root}/docs/development/admin-mcp-completion-v1.md`,
      "utf8",
    );
    const sql =
      /Release record, App-role preflight[\s\S]*?```sql\n([\s\S]*?)```/u.exec(
        record,
      )?.[1];
    expect(sql).toBeTypeOf("string");
    return (await setup.query(sql!.replaceAll(":'app_role'", `'${name}'`)))
      .rows as { rel: string; priv: string; granted: boolean }[];
  };

  it("runs as written, on the grants this repository holds, and every row is true", async () => {
    const rows = await preflightFor(role);
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.filter(({ granted }) => granted !== true)).toEqual([]);
  });

  it("is all these reads need: a role holding only its rows reads every op, branch and type", async () => {
    const narrow = `community_narrow_${run}`;
    const url = new URL(target);
    url.pathname = `/${database}`;
    url.username = narrow;
    url.password = randomBytes(32).toString("hex");
    await admin.query(
      `CREATE ROLE ${narrow} LOGIN PASSWORD '${url.password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`,
    );
    const pool = poolFor(url.toString());
    const server = backendOn(pool);
    try {
      await setup.query(`GRANT USAGE ON SCHEMA public, community TO ${narrow}`);
      for (const { rel, priv } of await preflightFor(narrow))
        await setup.query(
          `GRANT ${priv} ON ${priv === "EXECUTE" ? "FUNCTION" : "TABLE"} ${rel} TO ${narrow}`,
        );
      const address = await startServer(server, {
        host: "127.0.0.1",
        port: 0,
      });
      vi.stubEnv(
        "COMMUNITY_OPERATOR_BASE_URL",
        `http://127.0.0.1:${address.port}/`,
      );
      const unread: string[] = [];
      const reads = (label: string, envelope: Json) => {
        const sources = Object.entries(envelope.meta?.sources ?? {});
        if (
          ["COMMUNITY_UNAVAILABLE", "READ_TIMED_OUT"].includes(envelope.code) ||
          sources.some(([, status]) => status === "failed")
        )
          unread.push(label);
      };
      for (const op of ADMIN_OP_NAMES.filter(
        (name) =>
          adminOpMeta[name].tool === "admin_read" &&
          /^(?:community|list)\./u.test(name) &&
          !NOT_BUILT_HERE.has(name) &&
          !FROM_ELSEWHERE.has(name),
      ))
        for (const input of inputsOf(op))
          for (const view of adminOpMeta[op].readArgs === undefined
            ? [{}]
            : [{}, { view: "full" }, { view: "count" }])
            reads(
              `${op} ${JSON.stringify({ input, view })}`,
              await read({ op, input, ...view }),
            );
      for (const query of [
        `Reporter ${run}`,
        ids.lishu,
        ids.publicWork,
        ids.publicComment,
        ids.thread,
        ids.rightsReport,
        ids.feedback,
        ids.job,
        ids.publicRevision,
        ids.item,
        ids.pendingArticle,
      ])
        reads(`find ${query}`, await find(query));
      for (const [type, id] of [
        ["user", ids.author],
        ["work", ids.publicWork],
        ["comment", ids.publicComment],
        ["thread", ids.thread],
        ["report", ids.rightsReport],
        ["feedback", ids.feedback],
        ["publishing_job", ids.job],
        ["work_revision", ids.publicRevision],
        ["media_item", ids.item],
        ["article", ids.pendingArticle],
      ] as const)
        reads(`get ${type}`, await get(type, id));
      expect(unread).toEqual([]);
      const opened = await openCommunityAiMedia(
        `publishing/media/${ids.publicRevision}/${ids.publicBytesItem}/display/base`,
        null,
        undefined,
      );
      expect(
        Buffer.from(await new Response(opened.body).arrayBuffer()),
      ).toEqual(PNG_BYTES.public);
    } finally {
      server.closeAllConnections();
      if (server.listening) await stopServer(server);
      await pool.end();
      await setup.query(`DROP OWNED BY ${narrow}`);
      await admin.query(`DROP ROLE ${narrow}`);
    }
  });
});

describe("a Backend released first, with a field this Admin does not know", () => {
  const UNKNOWN = `unknownfield${run}`;

  /** Every read: as the real Backend answers it, then with the field in every object. */
  const sweep = async (relayed: boolean) => {
    const answers: { label: string; code: string; text: string }[] = [];
    const reads = (label: string, { envelope, text }: Json) =>
      answers.push({ label, code: envelope.code as string, text });
    for (const op of ADMIN_OP_NAMES.filter(
      (name) =>
        adminOpMeta[name].tool === "admin_read" &&
        /^(?:community|list)\./u.test(name) &&
        !NOT_BUILT_HERE.has(name) &&
        !FROM_ELSEWHERE.has(name),
    ))
      for (const input of inputsOf(op))
        for (const view of adminOpMeta[op].readArgs === undefined
          ? [{}]
          : [{}, { view: "full" }, { view: "count" }])
          reads(
            `${op} ${JSON.stringify({ input, view })}`,
            await send("admin_read", { op, input, ...view }),
          );
    for (const query of [`Reporter ${run}`, ids.publicWork, ids.rightsReport])
      reads(`find ${query}`, await send("admin_find", { query }));
    for (const [type, id] of [
      ["user", ids.author],
      ["work", ids.publicWork],
      ["comment", ids.publicComment],
      ["report", ids.rightsReport],
      ["work_revision", ids.publicRevision],
    ] as const)
      reads(`get ${type}`, await send("admin_get", { type, id }));
    reads(
      "job settlement",
      await send("admin_job", {
        kind: "settlement",
        refs: [{ type: "work", id: ids.publicWork, intent: "publish" }],
      }),
    );
    expect(relayed || answers.length > 40).toBe(true);
    return answers;
  };

  it("answers every read as it did, and the field reaches no answer", async () => {
    const before = await sweep(false);
    const relay = await relayRewriting(backendOrigin, (body) =>
      withFieldAdded(body, UNKNOWN),
    );
    try {
      vi.stubEnv("COMMUNITY_OPERATOR_BASE_URL", relay.origin);
      const after = await sweep(true);
      expect(after.map(({ label, code }) => ({ label, code }))).toEqual(
        before.map(({ label, code }) => ({ label, code })),
      );
      for (const { label, text } of after)
        expect(text, label).not.toContain(UNKNOWN);
      // Not a sweep of refusals: the field reached the Admin and was dropped there.
      expect(after.filter(({ code }) => code === "OK").length).toBeGreaterThan(
        40,
      );
    } finally {
      vi.stubEnv("COMMUNITY_OPERATOR_BASE_URL", backendOrigin);
      await relay.close();
    }
  });

  it("names an answer that breaks its contract, and says retrying cannot help", async () => {
    const relay = await relayRewriting(backendOrigin, (body) =>
      Array.isArray((body as Json).items)
        ? { ...(body as Json), total: "many" }
        : body,
    );
    try {
      vi.stubEnv("COMMUNITY_OPERATOR_BASE_URL", relay.origin);
      const { envelope } = await send("admin_read", { op: "list.reports" });
      expect(envelope).toMatchObject({
        ok: false,
        code: "BACKEND_CONTRACT_MISMATCH",
      });
      expect(envelope).not.toHaveProperty("retryable");
      expect(envelope).not.toHaveProperty("next");
    } finally {
      vi.stubEnv("COMMUNITY_OPERATOR_BASE_URL", backendOrigin);
      await relay.close();
    }
  });
});
