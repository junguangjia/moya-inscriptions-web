/**
 * Admin MCP's community writes on the Backend (admin-mcp-completion-v1 sections 2, 7
 * and 12), over the real HTTP server, router and handlers, and the real adapters under
 * the runtime App role. It holds to what the Admin cannot see from its side: only
 * `ai-admin` is told a receipt answered, no receipt stores that word, a row a report's
 * decision moves names who moved it, and nothing a claimant or a user reads of a case
 * says the Owner wrote it.
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
import { CommunityReportingService } from "@moya/api";
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
  runCommunityMigrations,
} from "@moya/community-postgres";
import { AI_OPERATOR_REQUEST_ID_HEADER } from "@moya/contracts/internal/admin-mcp";
import { UnconfiguredStorageUrlResolver } from "@moya/image";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { requireSyntheticTestDatabaseUrl } from "./synthetic-test-database.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const target = requireSyntheticTestDatabaseUrl();
const guard = await import(
  new URL("../../../scripts/disposable-test-target.mjs", import.meta.url).href
);

type Pool = ReturnType<typeof createPostgresPool>;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const poolFor = (url: string): Pool =>
  createPostgresPool(parsePostgresConfig({ DATABASE_URL: url }));

const synthetic = () => randomBytes(32).toString("base64url");
const ownerToken = synthetic();
const communityToken = synthetic();
const opaque = (prefix: string) =>
  `${prefix}-${randomUUID().replaceAll("-", "")}`;

const run = randomBytes(6).toString("hex");
const CONTACT = `contactcanary${run}`;
const EVIDENCE = `evidencecanary${run}.pdf`;
const REASON = "Synthetic reason";
const AI = "ai-admin";

const admin = poolFor(target);
const database = `ai_writes_${run}_synthetic_test`;
const role = `ai_writes_${run}`;
let setup: Pool;
let app: Pool;
let server: Server;
let base = "";
let createdDatabase = false;
let createdRole = false;
let reader: PostgresAiOperatorReader;
let reporting: PostgresCommunityReportingAdapter;

const send = async (
  token: string,
  method: string,
  route: string,
  body?: unknown,
  headers: Record<string, string> = {},
) => {
  const response = await fetch(`${base}/internal/community/${route}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await response.json()) as Json;
  return { status: response.status, json, code: json.error?.code as string };
};

let sequence = 0;
const newUser = async () => {
  sequence += 1;
  const id = opaque("user");
  await setup.query(
    "INSERT INTO community.public_users(id,handle,display_name) VALUES($1,$2,$3)",
    [id, `writes-${sequence}-${run}`, `Synthetic ${sequence}`],
  );
  return id;
};
const newWork = async (authorId: string) => {
  const id = opaque("work");
  await setup.query(
    "INSERT INTO community.works(id,author_id,title,text,first_published_at) VALUES($1,$2,'Title','Text',CURRENT_TIMESTAMP)",
    [id, authorId],
  );
  return id;
};
const newComment = async (workId: string, authorId: string) => {
  const id = opaque("comment");
  await setup.query(
    "INSERT INTO community.catalog_comments(id,catalog_id,target_type,author_id,text,moderation) VALUES($1,$2,'work',$3,'Comment','visible')",
    [id, workId, authorId],
  );
  return id;
};
const newReply = async (rootId: string, authorId: string) => {
  const id = opaque("comment");
  await setup.query(
    "INSERT INTO community.catalog_comment_replies(id,root_comment_id,author_id,text,moderation) VALUES($1,$2,$3,'Reply','visible')",
    [id, rootId, authorId],
  );
  return id;
};
const workVersion = async (id: string) =>
  Number(
    (await setup.query("SELECT version FROM community.works WHERE id=$1", [id]))
      .rows[0]!.version,
  );
const reportVersion = async (id: string) =>
  Number(
    (
      await setup.query(
        "SELECT version FROM community.report_cases WHERE id=$1",
        [id],
      )
    ).rows[0]!.version,
  );
const makeSelfOnly = (id: string) =>
  setup.query("UPDATE community.works SET visibility='self' WHERE id=$1", [id]);
const makePublic = (id: string) =>
  setup.query("UPDATE community.works SET visibility='public' WHERE id=$1", [
    id,
  ]);
const commentReport = async (comment: string, reporter: string) =>
  (
    await reporting.create(reporter, {
      kind: "quick_comment",
      target: { type: "comment", id: comment },
      requestId: randomUUID(),
    })
  ).id;
const workReport = async (work: string, reporter: string) =>
  (
    await reporting.create(reporter, {
      kind: "standard",
      target: { type: "work", id: work },
      reason: "other",
      description: "Synthetic",
      requestId: randomUUID(),
    })
  ).id;

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
  reader = new PostgresAiOperatorReader(app);
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
      aiOperatorReader: reader,
      communityOperatorCredential: ownerToken,
      operatorAiCommunityCredential: communityToken,
      catalogQueryPort: createDevelopmentCatalogFixtureQueryPort(),
      storageUrlResolver: new UnconfiguredStorageUrlResolver(),
    }),
  );
  const address = await startServer(server, { host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${address.port}`;
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

describe("a case's self-only question", () => {
  it("is true of a case on the work, on a comment and on a reply under it, and sees a flip", async () => {
    const author = await newUser();
    const reporter = await newUser();
    const work = await newWork(author);
    const comment = await newComment(work, reporter);
    const reply = await newReply(comment, author);
    const cases = [
      await workReport(work, reporter),
      await commentReport(comment, reporter),
      await commentReport(reply, reporter),
    ];
    for (const id of cases)
      expect(await reader.isSelfOnly("report", id), id).toBe(false);
    await makeSelfOnly(work);
    for (const id of cases)
      expect(await reader.isSelfOnly("report", id), id).toBe(true);
    await makePublic(work);
    for (const id of cases)
      expect(await reader.isSelfOnly("report", id), id).toBe(false);
  });

  it("holds through the snapshot once a purge has taken the comment's row", async () => {
    const reporter = await newUser();
    const work = await newWork(await newUser());
    const comment = await newComment(work, reporter);
    const id = await commentReport(comment, reporter);
    await makeSelfOnly(work);
    await setup.query(
      `UPDATE community.report_cases SET target_id=$2,snapshot=jsonb_set(snapshot,'{post}',$3::jsonb) WHERE id=$1`,
      [
        id,
        opaque("comment"),
        JSON.stringify({ type: "work", id: work, title: "Purged" }),
      ],
    );
    expect(await reader.isSelfOnly("report", id)).toBe(true);
  });

  it("is false of a work its author deleted, and of a case that does not exist", async () => {
    const reporter = await newUser();
    const work = await newWork(await newUser());
    const id = await workReport(work, reporter);
    await setup.query(
      "UPDATE community.works SET title='',text='',media_ids='{}',public_revision_id=NULL,author_revision_id=NULL,visibility='self',deleted_at=CURRENT_TIMESTAMP WHERE id=$1",
      [work],
    );
    expect(await reader.isSelfOnly("report", id)).toBe(false);
    expect(await reader.isSelfOnly("report", opaque("report"))).toBe(false);
  });
});

describe("what only ai-admin is told of a write", () => {
  it("says a receipt answered, and the Owner's same call answers as it always did", async () => {
    const work = await newWork(await newUser());
    const command = {
      requestId: randomUUID(),
      state: "hidden",
      expectedVersion: await workVersion(work),
      reason: REASON,
    };
    const route = `works/${work}/moderation`;
    const first = await send(communityToken, "POST", route, command);
    expect(first.status).toBe(200);
    expect(first.json).not.toHaveProperty("replayed");
    const replay = await send(communityToken, "POST", route, command);
    expect(replay.json).toMatchObject({ replayed: true });
    const { rows } = await setup.query(
      "SELECT result FROM community.content_operator_receipts WHERE request_id=$1",
      [command.requestId],
    );
    expect(rows[0]!.result).not.toHaveProperty("replayed");

    const other = await newWork(await newUser());
    const owners = {
      requestId: randomUUID(),
      state: "hidden",
      expectedVersion: await workVersion(other),
      reason: REASON,
    };
    const ownerRoute = `works/${other}/moderation`;
    const once = await send(ownerToken, "POST", ownerRoute, owners);
    const twice = await send(ownerToken, "POST", ownerRoute, owners);
    expect(twice.json).toEqual(once.json);
    expect(twice.json).not.toHaveProperty("replayed");
  });

  it("says when nothing was left to change, keeps the receipt, and opens no case", async () => {
    const work = await newWork(await newUser());
    const command = {
      requestId: randomUUID(),
      state: "visible",
      expectedVersion: await workVersion(work),
      reason: REASON,
    };
    const answer = await send(
      communityToken,
      "POST",
      `works/${work}/moderation`,
      command,
    );
    expect(answer.json).toMatchObject({ alreadyInPlace: true });
    const { rows } = await setup.query(
      "SELECT result FROM community.content_operator_receipts WHERE request_id=$1",
      [command.requestId],
    );
    expect(rows[0]!.result).not.toHaveProperty("alreadyInPlace");
    const owners = await send(ownerToken, "POST", `works/${work}/moderation`, {
      ...command,
      requestId: randomUUID(),
    });
    expect(owners.json).not.toHaveProperty("alreadyInPlace");

    const user = await newUser();
    const body = { action: "suspend", reason: REASON };
    const route = `users/${user}/status`;
    expect(
      (await send(communityToken, "POST", route, body)).json,
    ).not.toHaveProperty("alreadyInPlace");
    expect(
      (await send(communityToken, "POST", route, body)).json,
    ).toMatchObject({ alreadyInPlace: true });
    expect(
      (await send(ownerToken, "POST", route, body)).json,
    ).not.toHaveProperty("alreadyInPlace");
    const { rows: cases } = await setup.query(
      "SELECT id FROM community.report_cases WHERE target_id=$1",
      [user],
    );
    expect(cases).toHaveLength(1);
  });

  it("turns the comment header into a receipt on the AI path alone", async () => {
    const comment = await newComment(
      await newWork(await newUser()),
      await newUser(),
    );
    const key = randomUUID();
    const route = `comments/${comment}/moderation`;
    const body = { action: "hide", reason: REASON };
    const header = { [AI_OPERATOR_REQUEST_ID_HEADER]: key };
    const first = await send(communityToken, "POST", route, body, header);
    expect(first.json).toEqual({ id: comment, moderation: "hidden" });
    const replay = await send(communityToken, "POST", route, body, header);
    expect(replay.json).toEqual({
      id: comment,
      moderation: "hidden",
      replayed: true,
    });
    const { rows } = await setup.query(
      "SELECT actor_label,result FROM community.discussion_command_receipts WHERE request_id=$1",
      [key],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_label).toBe(AI);
    expect(rows[0]!.result).not.toHaveProperty("replayed");
    // Another command on the same key says so by name.
    expect(
      await send(
        communityToken,
        "POST",
        route,
        { action: "hide", reason: "Another reason" },
        header,
      ),
    ).toMatchObject({ status: 409, code: "IDEMPOTENCY_CONFLICT" });

    // The Owner's route reads no header: a repeat of the same key is two commands.
    const other = await newComment(
      await newWork(await newUser()),
      await newUser(),
    );
    const owners = await send(
      ownerToken,
      "POST",
      `comments/${other}/moderation`,
      body,
      header,
    );
    expect(owners.json).toEqual({ id: other, moderation: "hidden" });
    expect(
      await send(
        ownerToken,
        "POST",
        `comments/${other}/moderation`,
        body,
        header,
      ),
    ).toMatchObject({ status: 409, code: "STATE_CONFLICT" });
  });

  it("names a reused key on every receipt the writes keep", async () => {
    const user = await newUser();
    const key = randomUUID();
    const recommend = {
      requestId: key,
      id: user,
      enabled: true,
      expectedVersion: 0,
    };
    expect(
      (await send(communityToken, "PUT", "users/recommendation", recommend))
        .status,
    ).toBe(200);
    expect(
      await send(communityToken, "PUT", "users/recommendation", {
        ...recommend,
        enabled: false,
      }),
    ).toMatchObject({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
    const thread = { requestId: randomUUID(), title: `Thread ${run}` };
    expect((await send(communityToken, "POST", "threads", thread)).status).toBe(
      200,
    );
    expect(
      await send(communityToken, "POST", "threads", {
        ...thread,
        title: "Another title",
      }),
    ).toMatchObject({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
    const job = opaque("publishing-job");
    await setup.query(
      "INSERT INTO community.publishing_jobs(id,kind,subject_id,state,run_after) VALUES($1,'publish_media',$2,'failed',CURRENT_TIMESTAMP)",
      [job, opaque("media-item")],
    );
    const retry = { requestId: randomUUID() };
    const route = `publishing/jobs/${job}/retry`;
    expect((await send(communityToken, "POST", route, retry)).status).toBe(200);
    expect(
      (await send(communityToken, "POST", route, retry)).json,
    ).toMatchObject({ replayed: true });
    const otherJob = opaque("publishing-job");
    await setup.query(
      "INSERT INTO community.publishing_jobs(id,kind,subject_id,state,run_after) VALUES($1,'publish_media',$2,'failed',CURRENT_TIMESTAMP)",
      [otherJob, opaque("media-item")],
    );
    expect(
      await send(
        communityToken,
        "POST",
        `publishing/jobs/${otherJob}/retry`,
        retry,
      ),
    ).toMatchObject({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
  });
});

describe("the label on a row a report's decision moves", () => {
  it("names ai-admin on a comment and on a reply, hidden and restored", async () => {
    const reporter = await newUser();
    const author = await newUser();
    const comment = await newComment(await newWork(await newUser()), author);
    const reply = await newReply(comment, reporter);
    const label = async (table: string, id: string) =>
      (
        await setup.query(
          `SELECT moderation,moderated_by FROM community.${table} WHERE id=$1`,
          [id],
        )
      ).rows[0];
    for (const [table, subject, affected] of [
      ["catalog_comments", comment, author],
      ["catalog_comment_replies", reply, reporter],
    ] as const) {
      const report = await commentReport(subject, await newUser());
      const decided = await send(
        communityToken,
        "POST",
        `reports/${report}/decisions`,
        {
          expectedVersion: await reportVersion(report),
          action: "hide",
          reason: REASON,
        },
      );
      expect(decided.status).toBe(200);
      expect(await label(table, subject)).toEqual({
        moderation: "hidden",
        moderated_by: AI,
      });
      const { decision_id: decisionId } = (
        await setup.query(
          "SELECT decision_id FROM community.report_cases WHERE id=$1",
          [report],
        )
      ).rows[0]!;
      await reporting.appeal(affected, decisionId, {
        text: "Synthetic appeal",
        requestId: randomUUID(),
      });
      // The Owner corrects it, and the row then says the Owner did.
      expect(
        (
          await send(ownerToken, "POST", `reports/${report}/review`, {
            expectedVersion: await reportVersion(report),
            outcome: "overturn",
            reason: REASON,
          })
        ).status,
      ).toBe(200);
      expect(await label(table, subject)).toEqual({
        moderation: "visible",
        moderated_by: "owner",
      });
    }
  });

  it("stays the Owner's on the Owner's decision", async () => {
    const reporter = await newUser();
    const comment = await newComment(
      await newWork(await newUser()),
      await newUser(),
    );
    const report = await commentReport(comment, reporter);
    await send(ownerToken, "POST", `reports/${report}/decisions`, {
      expectedVersion: await reportVersion(report),
      action: "hide",
      reason: REASON,
    });
    const { rows } = await setup.query(
      "SELECT moderated_by FROM community.catalog_comments WHERE id=$1",
      [comment],
    );
    expect(rows[0]!.moderated_by).toBe("owner");
  });
});

describe("a decision's answer on the AI path", () => {
  it("holds no contact and no evidence name, and the Owner's holds both", async () => {
    const reporter = await newUser();
    const work = await newWork(await newUser());
    const notice = await reporting.create(reporter, {
      kind: "rights_notice",
      target: { type: "work", id: work },
      reason: "copyright",
      description: "Synthetic notice",
      claimantName: "Synthetic claimant",
      contact: CONTACT,
      rightsBasis: "Synthetic basis",
      requestId: randomUUID(),
    });
    await setup.query(
      "INSERT INTO community.report_evidence(id,case_id,owner_id,file_name,mime_type,byte_size,sensitive,sha256,state) VALUES($1,$2,$3,$4,'application/pdf',20,true,$5,'ready')",
      [opaque("evidence"), notice.id, reporter, EVIDENCE, "b".repeat(64)],
    );
    for (const [route, body] of [
      [
        `reports/${notice.id}/metadata`,
        {
          expectedVersion: await reportVersion(notice.id),
          status: "reviewing",
        },
      ],
      [
        `reports/${notice.id}/decisions`,
        {
          expectedVersion: (await reportVersion(notice.id)) + 1,
          action: "retain",
          reason: REASON,
        },
      ],
    ] as const) {
      const answer = await send(communityToken, "POST", route, body);
      expect(answer.status, route).toBe(200);
      const text = JSON.stringify(answer.json);
      expect(text).not.toContain(CONTACT);
      expect(text).not.toContain(EVIDENCE);
      expect(answer.json.claimant.name).toBe("Synthetic claimant");
      expect(answer.json.redacted).toEqual(
        expect.arrayContaining(["claimant.contact", "evidence.fileName"]),
      );
    }
    const owners = await send(ownerToken, "GET", `reports/${notice.id}`);
    expect(JSON.stringify(owners.json)).toContain(CONTACT);
    expect(JSON.stringify(owners.json)).toContain(EVIDENCE);
  });
});

describe("what a claimant or a user reads of an AI forward", () => {
  const OWNER_LABEL = /Owner|站长|管理员|所有者/u;

  it("is the text as sent, of its kind, with the operator only in the record", async () => {
    const reporter = await newUser();
    const author = await newUser();
    const work = await newWork(author);
    const service = new CommunityReportingService(
      new PostgresCommunityReportingAdapter(app),
      { operatorLabel: AI },
    ).forAiOperator();
    const notice = await reporting.create(reporter, {
      kind: "rights_notice",
      target: { type: "work", id: work },
      reason: "copyright",
      description: "Synthetic notice",
      claimantName: "Synthetic claimant",
      contact: CONTACT,
      rightsBasis: "Synthetic basis",
      requestId: randomUUID(),
    });
    const sent = `转送通知 ${run}`;
    const answer = await service.forward(notice.id, {
      expectedVersion: await reportVersion(notice.id),
      kind: "notice",
      text: sent,
    });
    expect(JSON.stringify(answer)).not.toContain(CONTACT);
    const { items } = await reporting.inbox(author);
    const message = items.find(({ caseId }) => caseId === notice.id)!;
    expect(message).toMatchObject({ kind: "notice", text: sent });
    expect(JSON.stringify(message)).not.toMatch(/operator|ai-admin/u);
    const { rows: audit } = await setup.query(
      "SELECT operator_label,action FROM community.report_audit WHERE case_id=$1 AND action='forward_notice'",
      [notice.id],
    );
    expect(audit).toEqual([{ operator_label: AI, action: "forward_notice" }]);
  });

  it("is a platform handling result on an official record's case, never signed", async () => {
    const reporter = await newUser();
    const report = opaque("report");
    await setup.query(
      `INSERT INTO community.report_cases(id,reporter_id,target_type,target_id,canonical_path,affected_user_id,snapshot,kind,reason,claimant,description,status)
       VALUES($1,$2,'catalog',$3,'/',NULL,'{}'::jsonb,'rights_notice','copyright',$4::jsonb,'Synthetic notice','open')`,
      [
        report,
        reporter,
        opaque("catalog"),
        JSON.stringify({
          name: "Synthetic claimant",
          contact: CONTACT,
          rightsBasis: "Synthetic basis",
        }),
      ],
    );
    const service = new CommunityReportingService(
      new PostgresCommunityReportingAdapter(app),
      { operatorLabel: AI },
    ).forAiOperator();
    const sent = `平台处理说明 ${run}`;
    await service.forward(report, {
      expectedVersion: await reportVersion(report),
      kind: "result",
      text: sent,
    });
    const { rows: messages } = await setup.query(
      "SELECT recipient_id,kind,text FROM community.report_messages WHERE case_id=$1",
      [report],
    );
    expect(messages).toEqual([
      { recipient_id: reporter, kind: "result", text: sent },
    ]);
    const { rows: audit } = await setup.query(
      "SELECT operator_label FROM community.report_audit WHERE case_id=$1 AND action='forward_result'",
      [report],
    );
    expect(audit).toEqual([{ operator_label: AI }]);
  });

  it("adds no Owner label to any message a decision or a review writes", async () => {
    const author = await newUser();
    const reporter = await newUser();
    const report = await workReport(await newWork(author), reporter);
    await send(communityToken, "POST", `reports/${report}/decisions`, {
      expectedVersion: await reportVersion(report),
      action: "hide",
      reason: REASON,
    });
    const { decision_id: decisionId } = (
      await setup.query(
        "SELECT decision_id FROM community.report_cases WHERE id=$1",
        [report],
      )
    ).rows[0]!;
    await reporting.appeal(author, decisionId, {
      text: "Synthetic appeal",
      requestId: randomUUID(),
    });
    await send(communityToken, "POST", `reports/${report}/review`, {
      expectedVersion: await reportVersion(report),
      outcome: "uphold",
      reason: REASON,
    });
    const { rows } = await setup.query(
      "SELECT text FROM community.report_messages WHERE case_id=$1",
      [report],
    );
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const { text } of rows) expect(text).not.toMatch(OWNER_LABEL);
  });

  it("finds no Owner label in the strings a person reads of a case", async () => {
    const sources = await Promise.all(
      [
        "apps/web/features/reporting/reporting-cases.tsx",
        "apps/web/features/reporting/report-actions.tsx",
        "apps/web/features/reporting/appeal-login.tsx",
      ].map((file) => readFile(`${root}/${file}`, "utf8")),
    );
    for (const source of sources) {
      const strings = [...source.matchAll(/[一-鿿][^"'`<>{}\n]*/gu)].map(
        ([text]) => text,
      );
      expect(strings.length).toBeGreaterThan(0);
      for (const text of strings) expect(text).not.toMatch(OWNER_LABEL);
    }
    // The server's own fixed sentences to a person.
    const adapter = await readFile(
      `${root}/services/community-postgres/src/reporting-adapter.ts`,
      "utf8",
    );
    const staff = await readFile(
      `${root}/services/community-postgres/src/staff-moderation-reporting.ts`,
      "utf8",
    );
    for (const source of [adapter, staff])
      for (const [text] of source.matchAll(/[一-鿿][^"'`\n]*/gu))
        expect(text).not.toMatch(OWNER_LABEL);
  });
});
