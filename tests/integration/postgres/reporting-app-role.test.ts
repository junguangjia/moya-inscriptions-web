/** Reporting uses a trusted Backend SQL role, never a public-user/Payload role.
 * SQL may read private rows to serve authorized requests; service actor checks
 * isolate people. Only migration/fixture setup uses the database owner.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { CommunityReportingService, CommunityNotFoundError } from "@moya/api";
import type {
  CommunityReportingEvidenceStore,
  ModerationEventDraft,
} from "@moya/api";
import { CosReportingEvidenceStore } from "@moya/backend-production/internal/reporting-evidence";
import type { PublishingCosTransport } from "@moya/backend-production/internal/publishing-media-store";
import type {
  PublicUserId,
  CatalogCommentId,
  ArticleId,
} from "@moya/contracts";
import {
  emptyArticleDocument,
  communityReportingInboxSchema,
} from "@moya/contracts/schemas";
import {
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import {
  PostgresCommunityReportingAdapter,
  PostgresCommunityCommentAdapter,
  PostgresCommunityContentOperatorAdapter,
  runCommunityMigrations,
} from "@moya/community-postgres";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  requireSyntheticTestDatabaseUrl,
  assertSyntheticTestDatabaseUrl,
} from "./synthetic-test-database.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const target = requireSyntheticTestDatabaseUrl(),
  endpoint = new URL(target);
if (
  !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
  endpoint.search ||
  endpoint.hash
)
  throw new Error(
    "Reporting App-role tests require a loopback synthetic target without overrides",
  );
const guard = (await import(
  new URL("../../../scripts/disposable-test-target.mjs", import.meta.url).href
)) as {
  disposableTestTargetProbeSql: string;
  markCurrentDatabaseDisposableSql: string;
  assertDisposableTestTarget(rows: unknown, database: string): string;
};
type Pool = ReturnType<typeof createPostgresPool>;
const poolFor = (url: string) =>
  createPostgresPool(parsePostgresConfig({ DATABASE_URL: url }));
const admin = poolFor(target),
  suffix = randomBytes(6).toString("hex"),
  database = `reporting_app_${suffix}_synthetic_test`,
  phaseDatabase = `reporting_phase_${suffix}_synthetic_test`,
  role = `reporting_app_${suffix}`;
const migrationDirectory = `${root}/database/community-migrations`;
let setup: Pool | undefined,
  phase: Pool | undefined,
  app: Pool | undefined,
  createdRole = false,
  createdDatabase = false,
  createdPhase = false,
  grantSql = "";
let adapter: PostgresCommunityReportingAdapter,
  service: CommunityReportingService,
  comments: PostgresCommunityCommentAdapter,
  works: PostgresCommunityContentOperatorAdapter;
const tables = [
  "report_cases",
  "report_decisions",
  "report_restriction_heads",
  "report_materials",
  "report_evidence",
  "report_messages",
  "report_audit",
  "report_receipts",
  "report_urgent_outbox",
  "profile_ip_locations",
] as const;
const mutable: Record<(typeof tables)[number], readonly string[]> = {
  report_cases: [
    "kind",
    "reason",
    "description",
    "snapshot",
    "claimant",
    "status",
    "urgent",
    "legal_hold",
    "version",
    "decision_id",
    "updated_at",
    "closed_at",
  ],
  report_decisions: [
    "reason",
    "reversed_at",
    "review_reason",
    "appeal_text",
    "appeal_at",
    "appeal_status",
  ],
  report_restriction_heads: ["applied_revision"],
  report_materials: ["text"],
  report_evidence: ["state", "upload_lease", "lease_until"],
  report_messages: ["text", "read_at"],
  report_audit: ["reason"],
  report_receipts: ["result"],
  report_urgent_outbox: [
    "attempts",
    "next_attempt_at",
    "lease_until",
    "delivered_at",
    "last_error",
  ],
  profile_ip_locations: ["label", "observed_at"],
};
const deletable = new Set([
  "report_cases",
  "report_evidence",
  "report_receipts",
  "report_restriction_heads",
]);
class EvidenceStore implements CommunityReportingEvidenceStore {
  readonly files = new Map<string, { bytes: Uint8Array; mimeType: string }>();
  failNext = false;
  reads = 0;
  async put(input: { id: string; bytes: Uint8Array; mimeType: string }) {
    this.files.set(input.id, { bytes: input.bytes, mimeType: input.mimeType });
    if (this.failNext) {
      this.failNext = false;
      throw new Error("synthetic private store failure");
    }
  }
  async read(id: string) {
    this.reads++;
    return this.files.get(id) ?? null;
  }
  async delete(id: string) {
    this.files.delete(id);
  }
}
const store = new EvidenceStore();
const opaque = (prefix: string) =>
  `${prefix}-${randomUUID().replaceAll("-", "")}`;
const seedUser = async () => {
  const id = opaque("user") as PublicUserId;
  await setup!.query(
    "INSERT INTO community.public_users(id,handle,display_name) VALUES($1,$2,'Synthetic reporting account')",
    [id, `rpt-${id.slice(-24)}`],
  );
  return id;
};
const seedWork = async (owner: string) => {
  const id = opaque("work");
  await setup!.query(
    "INSERT INTO community.works(id,author_id,title,text,first_published_at) VALUES($1,$2,'Synthetic public work','Synthetic public body',CURRENT_TIMESTAMP)",
    [id, owner],
  );
  return id;
};
const seedComment = async (owner: string, work: string) => {
  const id = opaque("comment") as CatalogCommentId;
  await setup!.query(
    "INSERT INTO community.catalog_comments(id,catalog_id,target_type,author_id,text,moderation) VALUES($1,$2,'work',$3,'Synthetic public comment','visible')",
    [id, work, owner],
  );
  return id;
};
const file = () => ({
  fileName: "synthetic-proof.pdf",
  mimeType: "application/pdf" as const,
  contentBase64: Buffer.from("%PDF-1.7 synthetic private evidence").toString(
    "base64",
  ),
  sensitive: false,
  requestId: randomUUID(),
});
const publicSubstrate = async (pool: Pool) => {
  await pool.query(
    "CREATE TABLE public.catalog_entries(catalog_id text PRIMARY KEY,province text,province_state text); CREATE TABLE public.catalog_discovery(catalog_id text PRIMARY KEY,kind text,title text,aliases varchar[],first_published_at timestamptz,filter_metadata jsonb); CREATE TABLE public.catalog_media(catalog_id text,media_id text,object_key text,width integer,height integer,is_representative boolean,position integer NOT NULL DEFAULT 0); CREATE TABLE public.article_entries(article_id text PRIMARY KEY,title text)",
  );
};
const apply = async (pool: Pool) => {
  await pool.query(grantSql.replaceAll(':"app_role"', `"${role}"`));
};
const ownCase = async (reporter: string, id: string) =>
  service.readOwn(reporter, id);
const requireDenied = async (query: Promise<unknown>) => {
  await expect(query).rejects.toMatchObject({ code: "42501" });
};

beforeAll(async () => {
  guard.assertDisposableTestTarget(
    (await admin.query(guard.disposableTestTargetProbeSql)).rows,
    assertSyntheticTestDatabaseUrl(target),
  );
  const password = randomBytes(32).toString("hex"); // Ephemeral process-only test credential: never logged or persisted in source.
  await admin.query(
    `CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`,
  );
  createdRole = true;
  await admin.query(`CREATE DATABASE "${database}"`);
  createdDatabase = true;
  const ownerUrl = new URL(target);
  ownerUrl.pathname = `/${database}`;
  setup = poolFor(ownerUrl.toString());
  await setup.query(guard.markCurrentDatabaseDisposableSql);
  guard.assertDisposableTestTarget(
    (await setup.query(guard.disposableTestTargetProbeSql)).rows,
    database,
  );
  await setup.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
  await publicSubstrate(setup);
  await runCommunityMigrations(setup, migrationDirectory);
  grantSql = await readFile(
    `${root}/infra/development/work-publishing/grant-runtime.sql`,
    "utf8",
  );
  await apply(setup);
  const appUrl = new URL(ownerUrl);
  appUrl.username = role;
  appUrl.password = password;
  app = poolFor(appUrl.toString());
  adapter = new PostgresCommunityReportingAdapter(app);
  service = new CommunityReportingService(adapter, {
    operatorLabel: "owner",
    evidenceStore: store,
  });
  comments = new PostgresCommunityCommentAdapter(app);
  works = new PostgresCommunityContentOperatorAdapter(app);
}, 60000);
afterAll(async () => {
  await app?.end();
  await phase?.end();
  await setup?.end();
  if (createdPhase) await admin.query(`DROP DATABASE "${phaseDatabase}"`);
  if (createdDatabase) await admin.query(`DROP DATABASE "${database}"`);
  if (createdRole) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
});

describe("complete reporting runtime through the canonical non-owner App role", () => {
  it("keeps a timed-out PUT tracked when it commits late, then purges it through the existing day-old sweep", async () => {
    const reporter = await seedUser();
    const author = await seedUser();
    const work = await seedWork(author);
    const report = await service.create(reporter, {
      kind: "standard",
      target: { type: "work", id: work },
      reason: "other",
      requestId: randomUUID(),
    });
    const objects = new Map<string, Buffer>();
    const methods: string[] = [];
    let releaseLate!: () => void;
    const lateGate = new Promise<void>((resolve) => {
      releaseLate = resolve;
    });
    let lateCommit: Promise<void> | undefined;
    const transport: PublishingCosTransport = {
      async request(method, input) {
        methods.push(method);
        if (method === "getBucketVersioning")
          return {
            rawBody: Buffer.from("<VersioningConfiguration/>"),
          } as never;
        const key = input.Key as string;
        if (method === "putObject") {
          const body = Buffer.from(input.Body as Buffer);
          // The request has failed while the provider still owns a pending
          // write. Its commit is deliberately released only after the failed
          // upload and its compensation path have both returned.
          lateCommit = lateGate.then(() => {
            objects.set(key, body);
          });
          throw new Error("synthetic PUT response timeout");
        }
        if (method === "deleteObject") objects.delete(key);
        return { rawBody: Buffer.alloc(0) } as never;
      },
    };
    const cos = new CosReportingEvidenceStore(
      {
        bucket: "synthetic-evidence-1250000000",
        region: "ap-guangzhou",
        prefix: "report-evidence/synthetic/",
        credentials: async () => ({
          secretId: "synthetic",
          secretKey: "synthetic-not-valid",
        }),
        requestTimeoutMs: 500,
      },
      transport,
    );
    const remoteService = new CommunityReportingService(adapter, {
      evidenceStore: cos,
    });
    const input = file();
    await expect(
      remoteService.uploadEvidence(reporter, report.id, input),
    ).rejects.toThrow("REPORT_EVIDENCE_WRITE_UNCERTAIN");
    const pending = (
      await app!.query(
        "SELECT id,state FROM community.report_evidence WHERE case_id=$1",
        [report.id],
      )
    ).rows;
    expect(pending).toHaveLength(1);
    expect(pending[0].state).toBe("pending");
    expect(objects.size).toBe(0);
    expect(methods).toEqual(["getBucketVersioning", "putObject"]);

    // A later failed retry must not erase the uncertainty of that older lease.
    await setup!.query(
      "UPDATE community.report_evidence SET lease_until=CURRENT_TIMESTAMP-interval '3 minutes' WHERE id=$1",
      [pending[0].id],
    );
    await expect(
      adapter.addEvidence(
        reporter,
        report.id,
        {
          id: pending[0].id,
          fileName: input.fileName,
          mimeType: input.mimeType,
          size: Buffer.from(input.contentBase64, "base64").length,
          sensitive: true,
          sha256: createHash("sha256")
            .update(Buffer.from(input.contentBase64, "base64"))
            .digest("hex"),
          createdAt: new Date().toISOString(),
          downloadPath: "/synthetic-private-evidence",
        },
        async () => {
          throw new Error("synthetic definite refusal before another write");
        },
        () => cos.delete(pending[0].id),
      ),
    ).rejects.toThrow("definite refusal");
    expect(methods).toEqual(["getBucketVersioning", "putObject"]);
    expect(
      (
        await app!.query(
          "SELECT state FROM community.report_evidence WHERE id=$1",
          [pending[0].id],
        )
      ).rows,
    ).toEqual([{ state: "pending" }]);

    releaseLate();
    await lateCommit;
    expect(objects.size).toBe(1);
    expect(
      await adapter.purgeExpiredEvidence((id) => cos.delete(id), 100),
    ).toBe(0);
    expect(objects.size).toBe(1);
    await setup!.query(
      "UPDATE community.report_evidence SET lease_until=CURRENT_TIMESTAMP-interval '2 days' WHERE id=$1",
      [pending[0].id],
    );
    expect(
      await adapter.purgeExpiredEvidence((id) => cos.delete(id), 100),
    ).toBe(1);
    expect(objects.size).toBe(0);
    expect(
      (
        await app!.query(
          "SELECT id FROM community.report_evidence WHERE id=$1",
          [pending[0].id],
        )
      ).rows,
    ).toEqual([]);
    expect(methods.filter((method) => method === "putObject")).toHaveLength(1);
    expect(methods.filter((method) => method === "deleteObject")).toHaveLength(
      1,
    );
  });

  it("pins the exact ten-table read/write plan, four DELETE permissions, role attributes and reapply stability", async () => {
    expect(
      (
        await app!.query(
          "SELECT current_user,rolsuper,rolbypassrls,rolinherit,rolcreatedb,rolcreaterole,rolreplication FROM pg_roles WHERE rolname=current_user",
        )
      ).rows,
    ).toEqual([
      {
        current_user: role,
        rolsuper: false,
        rolbypassrls: false,
        rolinherit: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
      },
    ]);
    const check = async () => {
      for (const table of tables) {
        const permissions = (
          await setup!.query<{
            read: boolean;
            insert: boolean;
            update: boolean;
            delete: boolean;
            truncate: boolean;
            references: boolean;
            trigger: boolean;
          }>(
            "SELECT has_table_privilege($1,$2,'SELECT') AS read,has_table_privilege($1,$2,'INSERT') AS insert,has_table_privilege($1,$2,'UPDATE') AS update,has_table_privilege($1,$2,'DELETE') AS delete,has_table_privilege($1,$2,'TRUNCATE') AS truncate,has_table_privilege($1,$2,'REFERENCES') AS references,has_table_privilege($1,$2,'TRIGGER') AS trigger",
            [role, `community.${table}`],
          )
        ).rows[0];
        expect(permissions).toEqual({
          read: true,
          insert: true,
          update: false,
          delete: deletable.has(table),
          truncate: false,
          references: false,
          trigger: false,
        });
        const columns = (
          await setup!.query<{ name: string }>(
            "SELECT a.attname AS name FROM pg_attribute a WHERE a.attrelid=$2::regclass AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege($1,a.attrelid,a.attnum,'UPDATE') ORDER BY a.attname",
            [role, `community.${table}`],
          )
        ).rows.map((row) => row.name);
        expect(columns).toEqual([...mutable[table]].sort());
      }
    };
    await check();
    await apply(setup!);
    await check();
    expect(
      (
        await app!.query(
          "SELECT has_schema_privilege(current_user,'community','CREATE') AS community,has_schema_privilege(current_user,'public','CREATE') AS public,has_database_privilege(current_user,current_database(),'CREATE') AS database",
        )
      ).rows,
    ).toEqual([{ community: false, public: false, database: false }]);
    await requireDenied(
      app!.query("CREATE TABLE community.reporting_forbidden_ddl(id integer)"),
    );
    await requireDenied(app!.query("CREATE SCHEMA reporting_forbidden_schema"));
  });
  it("refuses immutable identity, origin, actor, time and ledger UPDATEs without treating this Backend role as an end-user role", async () => {
    const immutable: Record<string, readonly string[]> = {
      report_cases: [
        "id",
        "reporter_id",
        "target_type",
        "target_id",
        "affected_user_id",
        "canonical_path",
        "created_at",
      ],
      report_decisions: [
        "id",
        "case_id",
        "action",
        "operator_label",
        "restriction_key",
        "created_at",
      ],
      report_materials: ["id", "case_id", "author_id", "kind", "created_at"],
      report_evidence: [
        "id",
        "case_id",
        "owner_id",
        "file_name",
        "mime_type",
        "sha256",
        "sensitive",
        "created_at",
      ],
      report_messages: ["id", "case_id", "recipient_id", "kind", "created_at"],
      report_audit: [
        "id",
        "case_id",
        "operator_label",
        "action",
        "occurred_at",
      ],
      report_receipts: ["actor_id", "request_id", "fingerprint", "created_at"],
      report_urgent_outbox: ["id", "case_id", "created_at"],
      report_restriction_heads: [
        "restriction_key",
        "subject_kind",
        "subject_id",
        "prior_state",
      ],
      profile_ip_locations: ["user_id"],
    };
    for (const [table, columns] of Object.entries(immutable))
      for (const column of columns)
        await requireDenied(
          app!.query(
            `UPDATE community.${table} SET ${column}=${column} WHERE false`,
          ),
        );
    await requireDenied(
      app!.query(
        "UPDATE community.schema_migrations SET checksum=checksum WHERE false",
      ),
    );
  });
  it("creates ordinary/quick reports, formal upgrades, staff notices and private appeal/evidence through real authorized services", async () => {
    const reporter = await seedUser(),
      author = await seedUser(),
      stranger = await seedUser(),
      work = await seedWork(author),
      comment = await seedComment(author, work);
    const quick = await service.create(reporter, {
      kind: "quick_comment",
      target: { type: "comment", id: comment },
      requestId: randomUUID(),
    });
    expect(quick.reason).toBeNull();
    const ordinary = await service.create(reporter, {
      kind: "standard",
      target: { type: "work", id: work },
      reason: "privacy",
      description: "private-report-original",
      requestId: randomUUID(),
    });
    await service.addMaterial(reporter, ordinary.id, {
      text: "private-supplement-marker",
      requestId: randomUUID(),
    });
    const formal = await service.create(reporter, {
      kind: "rights_notice",
      target: { type: "work", id: work },
      reason: "copyright",
      description: "private-formal-description",
      claimantName: "private-claimant-marker",
      contact: "private-contact-marker",
      rightsBasis: "private-rights-marker",
      requestId: randomUUID(),
    });
    expect(formal.id).toBe(ordinary.id);
    const reporterEvidence = await service.uploadEvidence(
      reporter,
      formal.id,
      file(),
    );
    expect(reporterEvidence.sensitive).toBe(true);
    // Forwarded prose may resemble a system result; its stored kind must
    // remain distinct so clients never rewrite a notice or statement body.
    const forwardedNotice = "处理措施：hide。Deliberately redacted notice";
    const forwardedStatement =
      "复核结果：overturn。Deliberately redacted statement";
    let staff = await service.operatorRead(formal.id);
    staff = await service.forward(formal.id, {
      expectedVersion: staff.version,
      kind: "notice",
      text: forwardedNotice,
    });
    staff = await service.decide(formal.id, {
      expectedVersion: staff.version,
      action: "hide",
      reason: "Staff reviewed reason",
    });
    expect(staff.decision?.reason).toBe("Staff reviewed reason");
    const initialReporterInbox = communityReportingInboxSchema
      .parse(await service.inbox(reporter))
      .items.filter((message) => message.caseId === formal.id);
    expect(
      initialReporterInbox.map(({ kind, text }) => ({ kind, text })),
    ).toEqual([
      { kind: "result", text: "举报已处理：hide。Staff reviewed reason" },
    ]);
    const initialAuthorInbox = communityReportingInboxSchema
      .parse(await service.inbox(author))
      .items.filter((message) => message.caseId === formal.id);
    expect(initialAuthorInbox).toHaveLength(2);
    expect(
      initialAuthorInbox.map(({ kind, text }) => ({ kind, text })),
    ).toEqual(
      expect.arrayContaining([
        { kind: "notice", text: forwardedNotice },
        {
          kind: "result",
          text: "处理措施：hide。理由：Staff reviewed reason。可在举报与申诉中申请复核。",
        },
      ]),
    );
    const affected = (await service.decisions(author)).items.find(
      (item) => item.caseId === formal.id,
    )!;
    expect(JSON.stringify(affected)).not.toMatch(
      /private-(claimant|contact|rights|formal|supplement|report)-/u,
    );
    await service.appeal(author, affected.decision.id, {
      text: "private-author-appeal",
      requestId: randomUUID(),
    });
    await service.statement(author, formal.id, {
      text: "private-counterstatement-marker",
      requestId: randomUUID(),
    });
    const authorEvidence = await service.uploadEvidence(
      author,
      formal.id,
      file(),
    );
    expect(
      (await ownCase(reporter, formal.id)).messages.some(
        (message) => message.text === "private-counterstatement-marker",
      ),
    ).toBe(false);
    staff = await service.operatorRead(formal.id);
    await service.forward(formal.id, {
      expectedVersion: staff.version,
      kind: "statement",
      text: forwardedStatement,
    });
    staff = await service.operatorRead(formal.id);
    staff = await service.review(formal.id, {
      expectedVersion: staff.version,
      outcome: "uphold",
      reason: "Review upheld reason",
    });
    await service.review(formal.id, {
      expectedVersion: staff.version,
      outcome: "overturn",
      reason: "Review overturned reason",
    });
    const reporterInbox = (await service.inbox(reporter)).items.filter(
      (message) => message.caseId === formal.id,
    );
    const authorInbox = (await service.inbox(author)).items.filter(
      (message) => message.caseId === formal.id,
    );
    expect(reporterInbox).toHaveLength(4);
    expect(authorInbox).toHaveLength(4);
    for (const inbox of [reporterInbox, authorInbox]) {
      expect(inbox.map(({ kind, text }) => ({ kind, text }))).toEqual(
        expect.arrayContaining([
          { kind: "result", text: "复核结果：uphold。Review upheld reason" },
          {
            kind: "result",
            text: "复核结果：overturn。Review overturned reason",
          },
        ]),
      );
    }
    expect(
      reporterInbox.find((message) => message.kind === "statement"),
    ).toMatchObject({
      kind: "statement",
      text: forwardedStatement,
    });
    expect(reporterInbox.some((message) => message.kind === "notice")).toBe(
      false,
    );
    expect(authorInbox.find((message) => message.kind === "notice")?.text).toBe(
      forwardedNotice,
    );
    expect(authorInbox.some((message) => message.kind === "statement")).toBe(
      false,
    );
    expect(JSON.stringify([reporterInbox, authorInbox])).not.toMatch(
      /private-(claimant|contact|rights|formal|supplement|report|author|counterstatement)-/u,
    );
    expect((await service.inbox(stranger)).items).toEqual([]);
    await expect(service.readOwn(stranger, formal.id)).rejects.toBeInstanceOf(
      CommunityNotFoundError,
    );
    await expect(service.readOwn(author, formal.id)).rejects.toBeInstanceOf(
      CommunityNotFoundError,
    );
    const reads = store.reads;
    await expect(
      service.evidence(author, formal.id, reporterEvidence.id),
    ).rejects.toBeInstanceOf(CommunityNotFoundError);
    await expect(
      service.evidence(reporter, formal.id, authorEvidence.id),
    ).rejects.toBeInstanceOf(CommunityNotFoundError);
    expect(store.reads).toBe(reads);
    expect(
      (await service.evidence(reporter, formal.id, reporterEvidence.id)).bytes
        .byteLength,
    ).toBeGreaterThan(0);
    expect(
      (await service.evidence(author, formal.id, authorEvidence.id)).bytes
        .byteLength,
    ).toBeGreaterThan(0);
    // Trusted Backend SQL legitimately reads private fields; actor isolation is above SQL.
    expect(
      (
        await app!.query<{ claimant: { contact: string } }>(
          "SELECT claimant FROM community.report_cases WHERE id=$1",
          [formal.id],
        )
      ).rows[0]!.claimant.contact,
    ).toBe("private-contact-marker");
    const notice = (await service.inbox(author)).items[0]!;
    await service.readInbox(author, notice.id);
    expect(
      (await service.inbox(author)).items.find((item) => item.id === notice.id)
        ?.readAt,
    ).not.toBeNull();
    await expect(service.readInbox(stranger, notice.id)).rejects.toBeInstanceOf(
      CommunityNotFoundError,
    );
    store.failNext = true;
    const failingCase = await service.create(reporter, {
      kind: "standard",
      target: { type: "user", id: stranger },
      reason: "other",
      requestId: randomUUID(),
    });
    const stored = store.files.size;
    await expect(
      service.uploadEvidence(reporter, failingCase.id, file()),
    ).rejects.toThrow("synthetic private store failure");
    expect(store.files.size).toBe(stored);
    expect(
      (
        await app!.query(
          "SELECT id FROM community.report_evidence WHERE case_id=$1",
          [failingCase.id],
        )
      ).rows,
    ).toEqual([]);
  });
  it("records native human decisions, advances shared restriction heads and preserves unrelated later state on correction", async () => {
    const reporter = await seedUser(),
      author = await seedUser(),
      work = await seedWork(author);
    const report = await service.create(reporter, {
      kind: "standard",
      target: { type: "work", id: work },
      reason: "harassment",
      requestId: randomUUID(),
    });
    let first = await service.decide(report.id, {
      expectedVersion: report.version,
      action: "hide",
      reason: "First protective reason",
    });
    const version = (
      await app!.query<{ version: number }>(
        "SELECT version FROM community.works WHERE id=$1",
        [work],
      )
    ).rows[0]!.version;
    await works.moderateWork(work, "owner", {
      requestId: randomUUID(),
      expectedVersion: version,
      state: "removed",
      reason: "Human staff reason",
    });
    const staff = (await service.decisions(author, 1, 100)).items.find(
      (item) => item.caseId !== first.id && item.target.id === work,
    )!;
    expect(staff.kind).toBe("moderation");
    expect((await service.operatorRead(staff.caseId)).reporterId).toBeNull();
    const post = (
      await app!.query<{ revision: string }>(
        "SELECT reporting_revision::text AS revision FROM community.works WHERE id=$1",
        [work],
      )
    ).rows[0]!.revision;
    expect(
      (
        await app!.query<{ applied_revision: string }>(
          "SELECT applied_revision::text FROM community.report_restriction_heads WHERE restriction_key=$1",
          [`work:${work}`],
        )
      ).rows[0]!.applied_revision,
    ).toBe(post);
    const latest = (
      await app!.query<{ version: number }>(
        "SELECT version FROM community.works WHERE id=$1",
        [work],
      )
    ).rows[0]!.version;
    await works.moderateWork(work, "automation", {
      requestId: randomUUID(),
      expectedVersion: latest,
      state: "hidden",
    });
    await service.appeal(author, first.decision!.id, {
      text: "First appeal",
      requestId: randomUUID(),
    });
    first = await service.operatorRead(first.id);
    await service.review(first.id, {
      expectedVersion: first.version,
      outcome: "overturn",
      reason: "Correct first case",
    });
    await service.appeal(author, staff.decision.id, {
      text: "Staff appeal",
      requestId: randomUUID(),
    });
    const second = await service.operatorRead(staff.caseId);
    await service.review(second.id, {
      expectedVersion: second.version,
      outcome: "overturn",
      reason: "Correct staff case",
    });
    expect(
      (
        await app!.query(
          "SELECT operator_state FROM community.works WHERE id=$1",
          [work],
        )
      ).rows[0].operator_state,
    ).toBe("hidden");
    expect(
      (
        await app!.query(
          "SELECT restriction_key FROM community.report_restriction_heads WHERE restriction_key=$1",
          [`work:${work}`],
        )
      ).rows,
    ).toEqual([]);
    const nativeComment = await seedComment(author, await seedWork(author));
    const event: ModerationEventDraft = {
      id: opaque("moderation"),
      operatorLabel: "owner",
      occurredAt: new Date(),
      action: "hide",
      reason: "Human comment reason",
    };
    await comments.applyCommentModeration(
      nativeComment,
      "hidden",
      ["visible"],
      "owner",
      new Date(),
      event,
    );
    expect(
      (await service.decisions(author, 1, 100)).items.some(
        (item) =>
          item.target.id === nativeComment &&
          item.decision.reason === "Human comment reason",
      ),
    ).toBe(true);
  });
  it("uses the two new native flags and the coarse-location upsert without identity rewrites", async () => {
    const reporter = await seedUser(),
      author = await seedUser();
    const report = await service.create(reporter, {
      kind: "standard",
      target: { type: "user", id: author },
      reason: "harassment",
      requestId: randomUUID(),
    });
    let row = await service.decide(report.id, {
      expectedVersion: report.version,
      action: "restrict_comments",
      reason: "Synthetic comment restriction",
    });
    expect(
      (
        await app!.query(
          "SELECT reporting_comments_restricted FROM community.public_users WHERE id=$1",
          [author],
        )
      ).rows[0].reporting_comments_restricted,
    ).toBe(true);
    await setup!.query(
      "UPDATE community.public_users SET status='suspended' WHERE id=$1",
      [author],
    );
    await service.appeal(author, row.decision!.id, {
      text: "Restricted author appeal",
      requestId: randomUUID(),
    });
    row = await service.operatorRead(row.id);
    await service.review(row.id, {
      expectedVersion: row.version,
      outcome: "overturn",
      reason: "Clear only comment restriction",
    });
    expect(
      (
        await app!.query(
          "SELECT status,reporting_comments_restricted FROM community.public_users WHERE id=$1",
          [author],
        )
      ).rows[0],
    ).toEqual({ status: "suspended", reporting_comments_restricted: false });
    const articleOwner = await seedUser(),
      article = opaque("article") as ArticleId,
      document = JSON.stringify(emptyArticleDocument());
    await setup!.query(
      "INSERT INTO community.article_documents(id,owner_id,version,title,document,fingerprint,created_at,updated_at) VALUES($1,$2,1,'Synthetic Article',$3::jsonb,$4,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
      [article, articleOwner, document, "a".repeat(64)],
    );
    await setup!.query(
      "INSERT INTO community.article_revisions(article_id,version,owner_id,title,document,fingerprint,submitted_policy,submitted_by_source,created_at) VALUES($1,1,$2,'Synthetic Article',$3::jsonb,$4,'DIRECT_PUBLICATION','human',CURRENT_TIMESTAMP)",
      [article, articleOwner, document, "a".repeat(64)],
    );
    await setup!.query(
      "UPDATE community.article_documents SET version=2,status='published',published_version=1,first_published_at=CURRENT_TIMESTAMP,published_at=CURRENT_TIMESTAMP WHERE id=$1",
      [article],
    );
    const articleReport = await service.create(reporter, {
      kind: "standard",
      target: { type: "article", id: article },
      reason: "other",
      requestId: randomUUID(),
    });
    const hidden = await service.decide(articleReport.id, {
      expectedVersion: articleReport.version,
      action: "hide",
      reason: "Synthetic Article removal",
    });
    expect(
      (
        await app!.query(
          "SELECT reporting_hidden FROM community.article_documents WHERE id=$1",
          [article],
        )
      ).rows[0].reporting_hidden,
    ).toBe(true);
    await service.review(hidden.id, {
      expectedVersion: hidden.version,
      outcome: "overturn",
      reason: "Synthetic Article correction",
    });
    expect(
      (
        await app!.query(
          "SELECT reporting_hidden,published_version,version FROM community.article_documents WHERE id=$1",
          [article],
        )
      ).rows[0],
    ).toEqual({ reporting_hidden: false, published_version: 1, version: 4 });
    const upsert =
      "INSERT INTO community.profile_ip_locations(user_id,label,observed_at) VALUES($1,$2,CURRENT_TIMESTAMP) ON CONFLICT(user_id) DO UPDATE SET label=EXCLUDED.label,observed_at=EXCLUDED.observed_at";
    await app!.query(upsert, [articleOwner, "河北"]);
    await app!.query(upsert, [articleOwner, "日本"]);
    expect(
      (
        await app!.query(
          "SELECT user_id,label FROM community.profile_ip_locations WHERE user_id=$1",
          [articleOwner],
        )
      ).rows,
    ).toEqual([{ user_id: articleOwner, label: "日本" }]);
    await app!.query(
      "UPDATE community.profile_ip_locations SET label=NULL,observed_at=CURRENT_TIMESTAMP WHERE user_id=$1",
      [articleOwner],
    );
    expect(
      (
        await app!.query(
          "SELECT label FROM community.profile_ip_locations WHERE user_id=$1",
          [articleOwner],
        )
      ).rows,
    ).toEqual([{ label: null }]);
  });
  it("applies legal hold, sensitive retention, active-case redaction and the four authorized cleanup paths", async () => {
    const reporter = await seedUser(),
      author = await seedUser(),
      work = await seedWork(author);
    const report = await service.create(reporter, {
      kind: "rights_notice",
      target: { type: "work", id: work },
      reason: "copyright",
      description: "private-retention-description",
      claimantName: "private-retention-name",
      contact: "private-retention-contact",
      rightsBasis: "private-retention-basis",
      requestId: randomUUID(),
    });
    await service.addMaterial(reporter, report.id, {
      text: "private-retention-material",
      requestId: randomUUID(),
    });
    const evidence = await service.uploadEvidence(reporter, report.id, file());
    let row = await service.operatorRead(report.id);
    row = await service.decide(row.id, {
      expectedVersion: row.version,
      action: "hide",
      reason: "private-retention-decision",
    });
    row = await service.metadata(row.id, {
      expectedVersion: row.version,
      legalHold: true,
    });
    await setup!.query(
      "UPDATE community.report_cases SET closed_at=CURRENT_TIMESTAMP-interval '3 years 1 day' WHERE id=$1",
      [row.id],
    );
    await adapter.purgeExpiredEvidence((id) => store.delete(id), 100);
    await adapter.purgeExpiredCases(100);
    expect(store.files.has(evidence.id)).toBe(true);
    expect((await service.operatorRead(row.id)).claimant?.contact).toBe(
      "private-retention-contact",
    );
    row = await service.metadata(row.id, {
      expectedVersion: row.version,
      legalHold: false,
    });
    await adapter.purgeExpiredEvidence((id) => store.delete(id), 100);
    expect(store.files.has(evidence.id)).toBe(false);
    await adapter.purgeExpiredCases(100);
    row = await service.operatorRead(row.id);
    expect(JSON.stringify(row)).not.toContain("private-retention-");
    expect(row.claimant).toEqual({ name: "", contact: "", rightsBasis: "" });
    expect(
      (
        await app!.query(
          "SELECT operator_state FROM community.works WHERE id=$1",
          [work],
        )
      ).rows[0].operator_state,
    ).toBe("hidden");
    await service.review(row.id, {
      expectedVersion: row.version,
      outcome: "overturn",
      reason: "Correction after lawful retention",
    });
    expect(
      (
        await app!.query(
          "SELECT restriction_key FROM community.report_restriction_heads WHERE restriction_key=$1",
          [`work:${work}`],
        )
      ).rows,
    ).toEqual([]);
    await setup!.query(
      "UPDATE community.report_cases SET closed_at=CURRENT_TIMESTAMP-interval '3 years 1 day' WHERE id=$1",
      [row.id],
    );
    await setup!.query(
      "UPDATE community.report_receipts SET created_at=CURRENT_TIMESTAMP-interval '3 years 1 day' WHERE actor_id=$1",
      [reporter],
    );
    await adapter.purgeExpiredCases(100);
    await expect(service.operatorRead(row.id)).rejects.toBeInstanceOf(
      CommunityNotFoundError,
    );
    expect(
      (
        await app!.query(
          "SELECT request_id FROM community.report_receipts WHERE actor_id=$1",
          [reporter],
        )
      ).rows,
    ).toEqual([]);
  });
  it("claims, retries and acknowledges urgent jobs through the App role", async () => {
    const reporter = await seedUser(),
      author = await seedUser();
    const report = await service.create(reporter, {
      kind: "standard",
      target: { type: "user", id: author },
      reason: "illegal_harmful",
      requestId: randomUUID(),
    });
    const claim = (await adapter.claimUrgent(100)).find(
      (job) => job.caseId === report.id,
    )!;
    expect(claim).toBeDefined();
    await adapter.failUrgent(claim.id, claim.attempt);
    expect((await service.operatorRead(report.id)).notificationFailures).toBe(
      1,
    );
    expect(
      (
        await app!.query(
          "SELECT attempts,last_error,lease_until FROM community.report_urgent_outbox WHERE id=$1",
          [claim.id],
        )
      ).rows[0],
    ).toMatchObject({
      attempts: 1,
      last_error: "delivery_failed",
      lease_until: null,
    });
    await setup!.query(
      "UPDATE community.report_urgent_outbox SET next_attempt_at=CURRENT_TIMESTAMP-interval '1 second' WHERE id=$1",
      [claim.id],
    );
    const retry = (await adapter.claimUrgent(100)).find(
      (job) => job.id === claim.id,
    )!;
    expect(retry.attempt).toBe(2);
    await adapter.completeUrgent(retry.id, retry.attempt);
    expect(
      (
        await app!.query(
          "SELECT delivered_at,last_error FROM community.report_urgent_outbox WHERE id=$1",
          [retry.id],
        )
      ).rows[0].delivered_at,
    ).not.toBeNull();
    expect((await service.operatorRead(report.id)).notificationFailures).toBe(
      0,
    );
  });
  it("skips absent families in older schema phases, refuses a partial family atomically, then grants a complete migration", async () => {
    await admin.query(`CREATE DATABASE "${phaseDatabase}"`);
    createdPhase = true;
    const url = new URL(target);
    url.pathname = `/${phaseDatabase}`;
    phase = poolFor(url.toString());
    await phase.query(guard.markCurrentDatabaseDisposableSql);
    guard.assertDisposableTestTarget(
      (await phase.query(guard.disposableTestTargetProbeSql)).rows,
      phaseDatabase,
    );
    await publicSubstrate(phase);
    await runCommunityMigrations(phase, migrationDirectory, {
      through: "20261024010000",
    });
    await apply(phase);
    expect(
      (
        await phase.query(
          "SELECT to_regclass('community.report_cases') AS reports,to_regclass('community.profile_ip_locations') AS locations",
        )
      ).rows,
    ).toEqual([{ reports: null, locations: null }]);
    await phase.query(
      "CREATE TABLE community.report_cases(id text PRIMARY KEY)",
    );
    await expect(apply(phase)).rejects.toThrow(
      "Reporting runtime grants require the complete relation family",
    );
    expect(
      (
        await phase.query(
          "SELECT has_table_privilege($1,'community.report_cases','SELECT') AS read,has_table_privilege($1,'community.report_cases','INSERT') AS insert",
          [role],
        )
      ).rows,
    ).toEqual([{ read: false, insert: false }]);
    await phase.query("DROP TABLE community.report_cases");
    await runCommunityMigrations(phase, migrationDirectory);
    await apply(phase);
    expect(
      (
        await phase.query(
          "SELECT has_table_privilege($1,'community.report_cases','SELECT') AS reports,has_table_privilege($1,'community.profile_ip_locations','INSERT') AS locations",
          [role],
        )
      ).rows,
    ).toEqual([{ reports: true, locations: true }]);
  });
});
