import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { CommunityConflictError, CommunityNotFoundError } from "@moya/api";
import {
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import {
  PostgresCommunityReportingAdapter,
  runCommunityMigrations,
} from "@moya/community-postgres";
import type {
  CommunityReport,
  CreateCommunityReportRequest,
} from "@moya/contracts";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { requireSyntheticTestDatabaseUrl } from "./synthetic-test-database.js";
const endpoint = requireSyntheticTestDatabaseUrl(),
  name = `reporting_${randomUUID().replaceAll("-", "")}_synthetic_test`;
const owner = createPostgresPool(
  parsePostgresConfig({ DATABASE_URL: endpoint }),
);
const url = new URL(endpoint);
url.pathname = `/${name}`;
const pool = createPostgresPool(
  parsePostgresConfig({ DATABASE_URL: url.toString() }),
);
const adapter = new PostgresCommunityReportingAdapter(pool, {
  resolveExternalTarget: async (target) =>
    target.type === "catalog"
      ? {
          canonicalPath: `/?catalogId=${target.id}#detail`,
          affectedUserId: null,
          snapshot: { title: "Synthetic catalog" },
        }
      : null,
});
const opaque = (kind: string) => `${kind}-${randomUUID().replaceAll("-", "")}`;
let created = false;
beforeAll(async () => {
  await owner.query(`CREATE DATABASE "${name}"`);
  created = true;
  await runCommunityMigrations(
    pool,
    fileURLToPath(
      new URL("../../../database/community-migrations", import.meta.url),
    ),
  );
}, 60000);
afterAll(async () => {
  await pool.end();
  if (created) await owner.query(`DROP DATABASE "${name}"`);
  await owner.end();
});
const user = async () => {
  const id = opaque("user");
  await pool.query(
    "INSERT INTO community.public_users(id,handle,display_name) VALUES($1,$2,$3)",
    [id, `report-${id.slice(-24)}`, "Synthetic report account"],
  );
  return id;
};
const work = async (author: string) => {
  const id = opaque("work");
  // The current legacy bridge creates the canonical public revision atomically.
  await pool.query(
    "INSERT INTO community.works(id,author_id,title,text,first_published_at) VALUES($1,$2,'Synthetic post','Synthetic body',CURRENT_TIMESTAMP)",
    [id, author],
  );
  return id;
};
const create = async (
  reporter: string,
  type: "user" | "work" | "catalog",
  id: string,
) =>
  adapter.create(reporter, {
    kind: "standard",
    target: { type, id },
    reason: "harassment",
    description: "Synthetic report",
    requestId: randomUUID(),
  });
const decide = (
  r: CommunityReport,
  action: "retain" | "hide" | "warn" | "suspend" | "restrict_comments",
) =>
  adapter.decide("owner", r.id, {
    expectedVersion: r.version,
    action,
    reason: "Synthetic staff decision",
  });
describe("persistent reports, decisions and appeals", () => {
  it("deduplicates concurrent reports and exact retries, but rejects reused request identity", async () => {
    const a = await user(),
      b = await user(),
      id = await work(b);
    const c: CreateCommunityReportRequest = {
      kind: "standard",
      target: { type: "work", id },
      reason: "spam_scam",
      requestId: randomUUID(),
    };
    const [one, two] = await Promise.all([
      adapter.create(a, c),
      adapter.create(a, c),
    ]);
    expect(two.id).toBe(one.id);
    expect((await create(a, "work", id)).id).toBe(one.id);
    await expect(
      adapter.create(a, { ...c, reason: "other" }),
    ).rejects.toBeInstanceOf(CommunityConflictError);
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer n FROM community.report_cases WHERE target_id=$1",
          [id],
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it("validates target visibility, block boundaries and backend-derived links", async () => {
    const a = await user(),
      b = await user(),
      id = await work(b);
    const report = await create(a, "work", id);
    expect(report.canonicalPath).toBe(`/?workId=${id}#detail`);
    await pool.query(
      "INSERT INTO community.blocks(blocker_id,blocked_id) VALUES($1,$2)",
      [b, a],
    );
    await expect(
      adapter.create(await user(), {
        kind: "standard",
        target: { type: "work", id: "missing" },
        reason: "other",
        requestId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(CommunityNotFoundError);
    const other = await user();
    await pool.query(
      "INSERT INTO community.blocks(blocker_id,blocked_id) VALUES($1,$2)",
      [b, other],
    );
    await expect(create(other, "work", id)).rejects.toBeInstanceOf(
      CommunityNotFoundError,
    );
    await expect(adapter.readOwn(b, report.id)).rejects.toBeInstanceOf(
      CommunityNotFoundError,
    );
  });
  it("creates a comment flag case with no invented reason and preserves context", async () => {
    const a = await user(),
      b = await user(),
      post = await work(b),
      comment = opaque("comment"),
      reply = opaque("comment");
    await pool.query(
      "INSERT INTO community.catalog_comments(id,catalog_id,target_type,author_id,text,moderation) VALUES($1,$2,'work',$3,'Root text','visible')",
      [comment, post, b],
    );
    await pool.query(
      "INSERT INTO community.catalog_comment_replies(id,root_comment_id,author_id,text,moderation) VALUES($1,$2,$3,'Reply text','visible')",
      [reply, comment, b],
    );
    const report = await adapter.create(a, {
      kind: "quick_comment",
      target: { type: "comment", id: reply },
      requestId: randomUUID(),
    });
    expect(report.reason).toBeNull();
    expect(report.description).toBe("");
    const staff = await adapter.operatorRead(report.id);
    expect(staff.snapshot["parent"]).toMatchObject({
      id: comment,
      text: "Root text",
    });
    const hidden = await decide(report, "hide");
    expect(
      (
        await pool.query(
          "SELECT moderation FROM community.catalog_comment_replies WHERE id=$1",
          [reply],
        )
      ).rows[0].moderation,
    ).toBe("hidden");
    await adapter.review("owner", report.id, {
      expectedVersion: hidden.version,
      outcome: "overturn",
      reason: "Synthetic correction",
    });
    expect(
      (
        await pool.query(
          "SELECT moderation FROM community.catalog_comment_replies WHERE id=$1",
          [reply],
        )
      ).rows[0].moderation,
    ).toBe("visible");
  });
  it("commits action, audit and both private notifications together and rejects stale commands", async () => {
    const a = await user(),
      b = await user(),
      id = await work(b),
      report = await create(a, "work", id);
    const result = await decide(report, "hide");
    expect(result.status).toBe("resolved");
    expect(result.history).toHaveLength(1);
    expect((await adapter.inbox(a)).items).toHaveLength(1);
    expect((await adapter.inbox(b)).items).toHaveLength(1);
    await expect(decide(report, "hide")).rejects.toBeInstanceOf(
      CommunityConflictError,
    );
    const affected = (await adapter.decisions(b, 1, 20)).items[0]!;
    expect(affected).not.toHaveProperty("reporterId");
    expect(affected).not.toHaveProperty("description");
    expect(affected.decision.reason).toBe("Synthetic staff decision");
  });
  it("rolls back a hide when durable notification insert fails", async () => {
    const a = await user(),
      b = await user(),
      id = await work(b),
      report = await create(a, "work", id);
    await pool.query(
      "CREATE FUNCTION community.synthetic_report_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic transaction failure'; END $$; CREATE TRIGGER synthetic_report_failure BEFORE INSERT ON community.report_messages FOR EACH ROW EXECUTE FUNCTION community.synthetic_report_failure()",
    );
    try {
      await expect(decide(report, "hide")).rejects.toThrow();
    } finally {
      await pool.query(
        "DROP TRIGGER synthetic_report_failure ON community.report_messages; DROP FUNCTION community.synthetic_report_failure()",
      );
    }
    expect((await adapter.readOwn(a, report.id)).status).toBe("open");
    expect(
      (
        await pool.query(
          "SELECT operator_state FROM community.works WHERE id=$1",
          [id],
        )
      ).rows[0].operator_state,
    ).toBe("visible");
    expect((await adapter.operatorRead(report.id)).history).toHaveLength(0);
  });
  it("keeps independent active hides and author deletion when correcting a decision", async () => {
    const a = await user(),
      b = await user(),
      c = await user(),
      id = await work(b);
    const first = await create(a, "work", id),
      second = await create(c, "work", id);
    const h1 = await decide(first, "hide"),
      h2 = await decide(second, "hide");
    await expect(
      pool.query(
        "UPDATE community.works SET operator_state='visible' WHERE id=$1",
        [id],
      ),
    ).rejects.toMatchObject({ constraint: "active_report_restriction" });
    await adapter.review("owner", first.id, {
      expectedVersion: h1.version,
      outcome: "overturn",
      reason: "Synthetic correction",
    });
    expect(
      (
        await pool.query(
          "SELECT operator_state FROM community.works WHERE id=$1",
          [id],
        )
      ).rows[0].operator_state,
    ).toBe("hidden");
    await pool.query(
      "UPDATE community.works SET deleted_at=CURRENT_TIMESTAMP WHERE id=$1",
      [id],
    );
    await adapter.review("owner", second.id, {
      expectedVersion: h2.version,
      outcome: "overturn",
      reason: "Synthetic correction",
    });
    const row = (
      await pool.query(
        "SELECT operator_state,deleted_at FROM community.works WHERE id=$1",
        [id],
      )
    ).rows[0];
    expect(row.operator_state).toBe("hidden");
    expect(row.deleted_at).not.toBeNull();
  });
  it("restores only after the last report restriction is overturned", async () => {
    const a = await user(),
      b = await user(),
      c = await user(),
      id = await work(b);
    const first = await create(a, "work", id),
      second = await create(c, "work", id);
    const h1 = await decide(first, "hide"),
      h2 = await decide(second, "hide");
    await adapter.review("owner", first.id, {
      expectedVersion: h1.version,
      outcome: "overturn",
      reason: "Synthetic correction",
    });
    await adapter.review("owner", second.id, {
      expectedVersion: h2.version,
      outcome: "overturn",
      reason: "Synthetic correction",
    });
    expect(
      (
        await pool.query(
          "SELECT operator_state FROM community.works WHERE id=$1",
          [id],
        )
      ).rows[0].operator_state,
    ).toBe("visible");
  });
  it("suspends and revokes sessions while affected user may appeal once", async () => {
    const a = await user(),
      b = await user();
    await pool.query(
      "INSERT INTO community.sessions(id,token_hash,user_id,issued_at,expires_at) VALUES($1,$2,$3,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+interval '1 day')",
      [opaque("session"), "b".repeat(64), b],
    );
    const report = await create(a, "user", b),
      result = await decide(report, "suspend");
    expect(
      (
        await pool.query(
          "SELECT status FROM community.public_users WHERE id=$1",
          [b],
        )
      ).rows[0].status,
    ).toBe("suspended");
    expect(
      (
        await pool.query(
          "SELECT revoked_at FROM community.sessions WHERE user_id=$1",
          [b],
        )
      ).rows[0].revoked_at,
    ).not.toBeNull();
    const appeal = await adapter.appeal(b, result.decision!.id, {
      text: "Synthetic appeal",
      requestId: randomUUID(),
    });
    expect(appeal.appeal?.status).toBe("pending");
    await expect(
      adapter.appeal(a, result.decision!.id, {
        text: "Unauthorized",
        requestId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(CommunityNotFoundError);
    const staff = await adapter.operatorRead(report.id);
    await adapter.review("owner", report.id, {
      expectedVersion: staff.version,
      outcome: "overturn",
      reason: "Synthetic correction",
    });
    expect(
      (
        await pool.query(
          "SELECT status FROM community.public_users WHERE id=$1",
          [b],
        )
      ).rows[0].status,
    ).toBe("active");
  });
  it("enforces comment restrictions for all insert paths and permits correction", async () => {
    const a = await user(),
      b = await user(),
      report = await create(a, "user", b),
      decision = await decide(report, "restrict_comments");
    await expect(
      pool.query(
        "INSERT INTO community.catalog_comments(id,catalog_id,author_id,text,moderation) VALUES($1,'synthetic',$2,'Synthetic comment','visible')",
        [opaque("comment"), b],
      ),
    ).rejects.toMatchObject({ constraint: "report_comments_restricted" });
    await adapter.review("owner", report.id, {
      expectedVersion: decision.version,
      outcome: "overturn",
      reason: "Synthetic correction",
    });
    await expect(
      pool.query(
        "INSERT INTO community.catalog_comments(id,catalog_id,author_id,text,moderation) VALUES($1,'synthetic',$2,'Synthetic comment','visible')",
        [opaque("comment"), b],
      ),
    ).resolves.toHaveProperty("rowCount", 1);
  });
  it("forwards only deliberate redacted rights text and keeps both parties evidence private", async () => {
    const a = await user(),
      b = await user(),
      other = await user(),
      id = await work(b);
    const report = await adapter.create(a, {
      kind: "rights_notice",
      target: { type: "work", id },
      reason: "copyright",
      description: "Private notice",
      claimantName: "Synthetic claimant",
      contact: "synthetic@example.invalid",
      rightsBasis: "Private basis",
      requestId: randomUUID(),
    });
    let staff = await adapter.operatorRead(report.id);
    staff = await adapter.forward("owner", report.id, {
      expectedVersion: staff.version,
      kind: "notice",
      text: "Deliberately redacted notice",
    });
    const result = await adapter.decide("owner", report.id, {
      expectedVersion: staff.version,
      action: "hide",
      reason: "Synthetic protective measure",
    });
    await adapter.statement(b, report.id, {
      text: "Private statement",
      requestId: randomUUID(),
    });
    const statementStaff = await adapter.operatorRead(report.id);
    await adapter.forward("owner", report.id, {
      expectedVersion: statementStaff.version,
      kind: "statement",
      text: "Deliberately redacted statement",
    });
    const evidence = {
      id: opaque("evidence"),
      fileName: "proof.pdf",
      mimeType: "application/pdf",
      size: 20,
      sensitive: true,
      sha256: "a".repeat(64),
      createdAt: new Date().toISOString(),
      downloadPath: "synthetic",
    };
    await adapter.addEvidence(
      b,
      report.id,
      evidence,
      async () => {},
      async () => {},
    );
    await expect(
      adapter.evidence(a, report.id, evidence.id),
    ).rejects.toBeInstanceOf(CommunityNotFoundError);
    await expect(
      adapter.evidence(other, report.id, evidence.id),
    ).rejects.toBeInstanceOf(CommunityNotFoundError);
    expect((await adapter.evidence(b, report.id, evidence.id)).id).toBe(
      evidence.id,
    );
    expect((await adapter.readOwn(a, report.id)).evidence).toEqual([]);
    expect(
      (await adapter.decisions(b, 1, 20)).items
        .find((c) => c.caseId === report.id)
        ?.messages.map((m) => m.text),
    ).toContain("Deliberately redacted notice");
    expect(result.claimant?.contact).toBe("synthetic@example.invalid");
  });
  it("retries urgent delivery and honors sensitive evidence retention and legal hold", async () => {
    const a = await user(),
      b = await user(),
      report = await create(a, "user", b);
    const evidence = {
      id: opaque("evidence"),
      fileName: "proof.pdf",
      mimeType: "application/pdf",
      size: 20,
      sensitive: true,
      sha256: "a".repeat(64),
      createdAt: new Date().toISOString(),
      downloadPath: "synthetic",
    };
    await adapter.addEvidence(
      a,
      report.id,
      evidence,
      async () => {},
      async () => {},
    );
    let staff = await adapter.operatorRead(report.id);
    staff = await adapter.metadata("owner", report.id, {
      expectedVersion: staff.version,
      urgent: true,
      legalHold: true,
    });
    const job = (await adapter.claimUrgent())[0]!;
    await adapter.failUrgent(job.id, job.attempt);
    expect((await adapter.operatorRead(report.id)).notificationFailures).toBe(
      1,
    );
    await adapter.completeUrgent(job.id, job.attempt);
    expect((await adapter.operatorRead(report.id)).notificationFailures).toBe(
      0,
    );
    staff = await adapter.decide("owner", report.id, {
      expectedVersion: staff.version,
      action: "retain",
      reason: "Synthetic close",
    });
    await pool.query(
      "UPDATE community.report_cases SET closed_at=CURRENT_TIMESTAMP-interval '181 days' WHERE id=$1",
      [report.id],
    );
    const removed: string[] = [];
    expect(
      await adapter.purgeExpiredEvidence(async (id) => {
        removed.push(id);
      }),
    ).toBe(0);
    await adapter.metadata("owner", report.id, {
      expectedVersion: staff.version,
      legalHold: false,
    });
    expect(
      await adapter.purgeExpiredEvidence(async (id) => {
        removed.push(id);
      }),
    ).toBe(1);
    expect(removed).toEqual([evidence.id]);
  });
  it("reserves the ten-file cap before bytes and cleans failed or revoked uploads safely", async () => {
    const a = await user(),
      b = await user(),
      report = await create(a, "user", b),
      files = new Set<string>();
    const evidence = (index: number) => ({
      id: opaque("evidence"),
      fileName: `proof-${index}.pdf`,
      mimeType: "application/pdf",
      size: 20,
      sensitive: true,
      sha256: "a".repeat(64),
      createdAt: new Date().toISOString(),
      downloadPath: "synthetic",
    });
    for (let i = 0; i < 10; i++) {
      const e = evidence(i);
      await adapter.addEvidence(
        a,
        report.id,
        e,
        async () => {
          files.add(e.id);
        },
        async () => {
          files.delete(e.id);
        },
      );
    }
    let touched = false;
    await expect(
      adapter.addEvidence(
        a,
        report.id,
        evidence(11),
        async () => {
          touched = true;
        },
        async () => {},
      ),
    ).rejects.toThrow("Evidence limit");
    expect(touched).toBe(false);
    expect(files.size).toBe(10);
    const owner = await user();
    const otherReport = await create(owner, "user", b);
    expect((await adapter.operatorRead(otherReport.id)).reporterId).toBe(owner);
    const failing = evidence(12);
    await expect(
      adapter.addEvidence(
        owner,
        otherReport.id,
        failing,
        async () => {
          files.add(failing.id);
          throw new Error("synthetic store failure");
        },
        async () => {
          files.delete(failing.id);
        },
      ),
    ).rejects.toThrow("synthetic store failure");
    expect(files.has(failing.id)).toBe(false);
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer n FROM community.report_evidence WHERE id=$1",
          [failing.id],
        )
      ).rows[0].n,
    ).toBe(0);
    const lost = evidence(13);
    await expect(
      adapter.addEvidence(
        owner,
        otherReport.id,
        lost,
        async () => {
          files.add(lost.id);
          await pool.query(
            "UPDATE community.public_users SET status='suspended' WHERE id=$1",
            [owner],
          );
        },
        async () => {
          files.delete(lost.id);
        },
      ),
    ).rejects.toBeInstanceOf(CommunityNotFoundError);
    expect(files.has(lost.id)).toBe(false);
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer n FROM community.report_evidence WHERE id=$1",
          [lost.id],
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it("reconciles abandoned pending uploads but preserves legal hold", async () => {
    const a = await user(),
      b = await user(),
      report = await create(a, "user", b),
      e = opaque("evidence");
    await pool.query(
      "INSERT INTO community.report_evidence(id,case_id,owner_id,file_name,mime_type,byte_size,sensitive,sha256,state,upload_lease,lease_until) VALUES($1,$2,$3,'stale.pdf','application/pdf',20,true,$4,'pending','synthetic-lease',CURRENT_TIMESTAMP-interval '2 days')",
      [e, report.id, a, "a".repeat(64)],
    );
    let staff = await adapter.operatorRead(report.id);
    staff = await adapter.metadata("owner", report.id, {
      expectedVersion: staff.version,
      legalHold: true,
    });
    const removed: string[] = [];
    expect(
      await adapter.purgeExpiredEvidence(async (id) => {
        removed.push(id);
      }),
    ).toBe(0);
    await adapter.metadata("owner", report.id, {
      expectedVersion: staff.version,
      legalHold: false,
    });
    expect(
      await adapter.purgeExpiredEvidence(async (id) => {
        removed.push(id);
      }),
    ).toBe(1);
    expect(removed).toEqual([e]);
  });
  it("reopens late rights statements and evidence, then restarts sensitive retention on reclosure", async () => {
    const reporter = await user(),
      affected = await user(),
      post = await work(affected);
    const report = await adapter.create(reporter, {
      kind: "rights_notice",
      target: { type: "work", id: post },
      reason: "copyright",
      description: "Synthetic notice",
      claimantName: "Synthetic claimant",
      contact: "synthetic@example.invalid",
      rightsBasis: "Synthetic basis",
      requestId: randomUUID(),
    });
    await decide(report, "hide");
    await pool.query(
      "UPDATE community.report_cases SET closed_at=CURRENT_TIMESTAMP-interval '181 days' WHERE id=$1",
      [report.id],
    );
    await adapter.statement(affected, report.id, {
      text: "Late synthetic statement",
      requestId: randomUUID(),
    });
    let row = (
      await pool.query(
        "SELECT status,closed_at FROM community.report_cases WHERE id=$1",
        [report.id],
      )
    ).rows[0];
    expect(row.status).toBe("reviewing");
    expect(row.closed_at).toBeNull();
    const evidence = {
      id: opaque("evidence"),
      fileName: "fresh.pdf",
      mimeType: "application/pdf",
      size: 20,
      sensitive: true,
      sha256: "a".repeat(64),
      createdAt: new Date().toISOString(),
      downloadPath: "synthetic",
    };
    const removed: string[] = [];
    await adapter.addEvidence(
      affected,
      report.id,
      evidence,
      async () => {},
      async () => {},
    );
    await adapter.purgeExpiredEvidence(async (id) => {
      removed.push(id);
    });
    expect(removed).not.toContain(evidence.id);
    let staff = await adapter.operatorRead(report.id);
    staff = await adapter.review("owner", report.id, {
      expectedVersion: staff.version,
      outcome: "uphold",
      reason: "Synthetic rights review",
    });
    expect(staff.status).toBe("resolved");
    expect(staff.appeal).toBeNull();
    row = (
      await pool.query(
        "SELECT closed_at FROM community.report_cases WHERE id=$1",
        [report.id],
      )
    ).rows[0];
    expect(row.closed_at.getTime()).toBeGreaterThan(Date.now() - 60000);
    await pool.query(
      "UPDATE community.report_cases SET closed_at=CURRENT_TIMESTAMP-interval '179 days' WHERE id=$1",
      [report.id],
    );
    await adapter.purgeExpiredEvidence(async (id) => {
      removed.push(id);
    });
    expect(removed).not.toContain(evidence.id);
    await pool.query(
      "UPDATE community.report_cases SET closed_at=CURRENT_TIMESTAMP-interval '181 days' WHERE id=$1",
      [report.id],
    );
    await adapter.purgeExpiredEvidence(async (id) => {
      removed.push(id);
    });
    expect(removed).toContain(evidence.id);
    const followup = {
      ...evidence,
      id: opaque("evidence"),
      fileName: "evidence-only.pdf",
    };
    await adapter.addEvidence(
      affected,
      report.id,
      followup,
      async () => {},
      async () => {},
    );
    row = (
      await pool.query(
        "SELECT status,closed_at FROM community.report_cases WHERE id=$1",
        [report.id],
      )
    ).rows[0];
    expect(row.status).toBe("reviewing");
    expect(row.closed_at).toBeNull();
    await adapter.purgeExpiredEvidence(async (id) => {
      removed.push(id);
    });
    expect(removed).not.toContain(followup.id);
  });
  it("redacts expired active-case private payloads while retaining effective restriction and correction authority", async () => {
    const reporter = await user(),
      affected = await user(),
      post = await work(affected);
    const command: CreateCommunityReportRequest = {
      kind: "rights_notice",
      target: { type: "work", id: post },
      reason: "copyright",
      description: "private-marker description",
      claimantName: "private-marker name",
      contact: "private-marker contact",
      rightsBasis: "private-marker basis",
      requestId: randomUUID(),
    };
    const report = await adapter.create(reporter, command);
    await adapter.addMaterial(reporter, report.id, {
      text: "private-marker supplement",
      requestId: randomUUID(),
    });
    let staff = await adapter.operatorRead(report.id);
    await adapter.decide("owner", report.id, {
      expectedVersion: staff.version,
      action: "hide",
      reason: "private-marker decision",
    });
    await adapter.statement(affected, report.id, {
      text: "private-marker counterstatement",
      requestId: randomUUID(),
    });
    staff = await adapter.operatorRead(report.id);
    staff = await adapter.forward("owner", report.id, {
      expectedVersion: staff.version,
      kind: "statement",
      text: "private-marker forwarded statement",
    });
    await adapter.appeal(affected, staff.decision!.id, {
      text: "private-marker appeal",
      requestId: randomUUID(),
    });
    staff = await adapter.operatorRead(report.id);
    await adapter.review("owner", report.id, {
      expectedVersion: staff.version,
      outcome: "uphold",
      reason: "private-marker review",
    });
    await pool.query(
      "UPDATE community.report_cases SET closed_at=CURRENT_TIMESTAMP-interval '3 years 1 day' WHERE id=$1",
      [report.id],
    );
    expect(await adapter.purgeExpiredCases()).toBe(1);
    staff = await adapter.operatorRead(report.id);
    expect(staff.description).toBe("");
    expect(staff.claimant).toEqual({ name: "", contact: "", rightsBasis: "" });
    expect(staff.snapshot).toEqual({ retentionRedacted: true });
    expect(staff.decision?.action).toBe("hide");
    expect(staff.decision?.reversedAt).toBeNull();
    const privatePayload = (
      await pool.query(
        `SELECT jsonb_build_object('case',(SELECT to_jsonb(c) FROM community.report_cases c WHERE id=$1),'materials',(SELECT jsonb_agg(to_jsonb(m)) FROM community.report_materials m WHERE case_id=$1),'messages',(SELECT jsonb_agg(to_jsonb(m)) FROM community.report_messages m WHERE case_id=$1),'history',(SELECT jsonb_agg(to_jsonb(a)) FROM community.report_audit a WHERE case_id=$1),'decision',(SELECT jsonb_agg(to_jsonb(d)) FROM community.report_decisions d WHERE case_id=$1),'receipts',(SELECT jsonb_agg(result) FROM community.report_receipts WHERE actor_id=ANY($2::text[]))) AS payload`,
        [report.id, [reporter, affected]],
      )
    ).rows[0].payload;
    expect(JSON.stringify(privatePayload)).not.toContain("private-marker");
    expect(
      (
        await pool.query(
          "SELECT operator_state FROM community.works WHERE id=$1",
          [post],
        )
      ).rows[0].operator_state,
    ).toBe("hidden");
    await expect(adapter.create(reporter, command)).rejects.toBeInstanceOf(
      CommunityConflictError,
    );
    expect(await adapter.purgeExpiredCases()).toBe(0);
    await adapter.review("owner", report.id, {
      expectedVersion: staff.version,
      outcome: "overturn",
      reason: "Synthetic correction after retention",
    });
    expect(
      (
        await pool.query(
          "SELECT operator_state FROM community.works WHERE id=$1",
          [post],
        )
      ).rows[0].operator_state,
    ).toBe("visible");
  });
  it("preserves held expired-case payloads and redacts a reopened active case again after its new retention period", async () => {
    const reporter = await user(),
      affected = await user(),
      post = await work(affected);
    const report = await adapter.create(reporter, {
      kind: "rights_notice",
      target: { type: "work", id: post },
      reason: "copyright",
      description: "Synthetic held notice",
      claimantName: "Held claimant",
      contact: "held@example.invalid",
      rightsBasis: "Held basis",
      requestId: randomUUID(),
    });
    let staff = await decide(report, "hide");
    staff = await adapter.metadata("owner", report.id, {
      expectedVersion: staff.version,
      legalHold: true,
    });
    await pool.query(
      "UPDATE community.report_cases SET closed_at=CURRENT_TIMESTAMP-interval '3 years 1 day' WHERE id=$1",
      [report.id],
    );
    expect(await adapter.purgeExpiredCases()).toBe(0);
    expect((await adapter.operatorRead(report.id)).claimant?.contact).toBe(
      "held@example.invalid",
    );
    await adapter.metadata("owner", report.id, {
      expectedVersion: staff.version,
      legalHold: false,
    });
    expect(await adapter.purgeExpiredCases()).toBe(1);
    await adapter.statement(affected, report.id, {
      text: "Fresh synthetic private material",
      requestId: randomUUID(),
    });
    staff = await adapter.operatorRead(report.id);
    expect(staff.snapshot["retentionRedacted"]).toBeUndefined();
    await adapter.review("owner", report.id, {
      expectedVersion: staff.version,
      outcome: "uphold",
      reason: "Fresh synthetic review",
    });
    await pool.query(
      "UPDATE community.report_cases SET closed_at=CURRENT_TIMESTAMP-interval '3 years 1 day' WHERE id=$1",
      [report.id],
    );
    expect(await adapter.purgeExpiredCases()).toBe(1);
    staff = await adapter.operatorRead(report.id);
    expect(staff.snapshot["retentionRedacted"]).toBe(true);
    expect(
      staff.materials.some(
        (m) => m.text === "Fresh synthetic private material",
      ),
    ).toBe(false);
    expect(staff.decision?.reversedAt).toBeNull();
  });
  it("upgrades an ordinary open case to a formal rights notice without dropping either submission", async () => {
    const reporter = await user(),
      affected = await user(),
      post = await work(affected);
    const original = await adapter.create(reporter, {
      kind: "standard",
      target: { type: "work", id: post },
      reason: "privacy",
      description: "Original ordinary explanation",
      requestId: randomUUID(),
    });
    const formal: CreateCommunityReportRequest = {
      kind: "rights_notice",
      target: { type: "work", id: post },
      reason: "copyright",
      description: "Formal rights description",
      claimantName: "Formal claimant",
      contact: "formal@example.invalid",
      rightsBasis: "Formal ownership basis",
      requestId: randomUUID(),
    };
    const upgraded = await adapter.create(reporter, formal);
    expect(upgraded.id).toBe(original.id);
    expect(upgraded.kind).toBe("rights_notice");
    expect(upgraded.reason).toBe("copyright");
    expect(upgraded.description).toBe("Formal rights description");
    const staff = await adapter.operatorRead(original.id);
    expect(staff.claimant).toEqual({
      name: "Formal claimant",
      contact: "formal@example.invalid",
      rightsBasis: "Formal ownership basis",
    });
    expect(staff.materials.map((m) => m.text)).toContain(
      "Original ordinary explanation",
    );
    expect(
      staff.history.some(
        (h) =>
          h.action === "rights_notice_submitted" && h.operator === "reporter",
      ),
    ).toBe(true);
    expect((await adapter.create(reporter, formal)).id).toBe(original.id);
    expect(
      (await adapter.operatorRead(original.id)).history.filter(
        (h) => h.action === "rights_notice_submitted",
      ),
    ).toHaveLength(1);
    await expect(
      adapter.create(reporter, {
        ...formal,
        requestId: randomUUID(),
        rightsBasis: "Different new basis",
      }),
    ).rejects.toBeInstanceOf(CommunityConflictError);
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer n FROM community.report_cases WHERE reporter_id=$1 AND target_id=$2",
          [reporter, post],
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it("allows an older decision appeal and rights followup while the same reporter has a newer open report", async () => {
    const reporter = await user(),
      affected = await user();
    const first = await create(reporter, "user", affected),
      decision = await decide(first, "warn");
    const second = await create(reporter, "user", affected);
    expect(second.id).not.toBe(first.id);
    const appeal = await adapter.appeal(affected, decision.decision!.id, {
      text: "Appeal of the earlier warning",
      requestId: randomUUID(),
    });
    expect(appeal.appeal?.status).toBe("pending");
    expect((await adapter.readOwn(reporter, first.id)).status).toBe("appealed");
    expect((await create(reporter, "user", affected)).id).toBe(second.id);
    const post = await work(affected);
    const rights = await adapter.create(reporter, {
      kind: "rights_notice",
      target: { type: "work", id: post },
      reason: "copyright",
      description: "Synthetic prior rights case",
      claimantName: "Synthetic claimant",
      contact: "synthetic@example.invalid",
      rightsBasis: "Synthetic basis",
      requestId: randomUUID(),
    });
    await decide(rights, "warn");
    const newer = await create(reporter, "work", post);
    expect(newer.id).not.toBe(rights.id);
    await adapter.statement(affected, rights.id, {
      text: "Late rights followup",
      requestId: randomUUID(),
    });
    expect((await adapter.operatorRead(rights.id)).status).toBe("reviewing");
    expect((await adapter.readOwn(reporter, newer.id)).status).toBe("open");
    expect((await create(reporter, "work", post)).id).toBe(newer.id);
  });
  it("immediately prioritizes illegal-harmful submissions and promotes duplicate cases without sanction", async () => {
    const reporter = await user(),
      affected = await user(),
      post = await work(affected);
    const urgent = await adapter.create(reporter, {
      kind: "standard",
      target: { type: "work", id: post },
      reason: "illegal_harmful",
      description: "Synthetic urgent assertion",
      requestId: randomUUID(),
    });
    expect(urgent.urgent).toBe(true);
    expect(urgent.decision).toBeNull();
    expect(
      (await adapter.claimUrgent(100)).some((job) => job.caseId === urgent.id),
    ).toBe(true);
    expect(
      (
        await pool.query(
          "SELECT operator_state FROM community.works WHERE id=$1",
          [post],
        )
      ).rows[0].operator_state,
    ).toBe("visible");
    const ordinary = await create(reporter, "user", affected);
    const command: CreateCommunityReportRequest = {
      kind: "standard",
      target: { type: "user", id: affected },
      reason: "illegal_harmful",
      requestId: randomUUID(),
    };
    const promoted = await adapter.create(reporter, command);
    expect(promoted.id).toBe(ordinary.id);
    expect(promoted.urgent).toBe(true);
    expect(promoted.reason).toBe("harassment");
    await adapter.create(reporter, { ...command, requestId: randomUUID() });
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer n FROM community.report_urgent_outbox WHERE case_id=$1",
          [ordinary.id],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await pool.query(
          "SELECT status FROM community.public_users WHERE id=$1",
          [affected],
        )
      ).rows[0].status,
    ).toBe("active");
    expect(
      (await adapter.operatorRead(ordinary.id)).history.filter(
        (h) => h.action === "urgent_report_submitted",
      ),
    ).toHaveLength(1);
  });
  it.each(["catalog", "article"] as const)(
    "records only verified native removal/restoration for official %s content",
    async (type) => {
      const reporter = await user(),
        targetId = opaque(type);
      let state: "public" | "unavailable" | "error" = "public";
      const reads: { type: string; id: string; actor: string }[] = [];
      const official = new PostgresCommunityReportingAdapter(pool, {
        resolveExternalTarget: async (target, actor) => {
          reads.push({ type: target.type, id: target.id, actor });
          if (state === "error")
            throw new Error("Synthetic native read unavailable");
          return state === "public"
            ? {
                canonicalPath: `/?topic=${targetId}`,
                affectedUserId: null,
                snapshot: {
                  title: "Synthetic official content",
                  ...(type === "article" ? { source: "official" } : {}),
                },
              }
            : null;
        },
      });
      const report = await official.create(reporter, {
        kind: "standard",
        target: { type, id: targetId },
        reason: "other",
        description: "Synthetic official report",
        requestId: randomUUID(),
      });
      let staff = await official.operatorRead(report.id);
      expect(staff.allowedActions).toContain("hide");
      await expect(
        official.decide("owner", report.id, {
          expectedVersion: staff.version,
          action: "hide",
          reason: "Native removal",
        }),
      ).rejects.toBeInstanceOf(CommunityConflictError);
      state = "error";
      await expect(
        official.decide("owner", report.id, {
          expectedVersion: staff.version,
          action: "hide",
          reason: "Native removal",
        }),
      ).rejects.toThrow("Synthetic native read unavailable");
      const missing = new PostgresCommunityReportingAdapter(pool);
      expect(
        (await missing.operatorRead(report.id)).allowedActions,
      ).not.toContain("hide");
      await expect(
        missing.decide("owner", report.id, {
          expectedVersion: staff.version,
          action: "hide",
          reason: "Native removal",
        }),
      ).rejects.toBeInstanceOf(CommunityConflictError);
      expect((await official.readOwn(reporter, report.id)).decision).toBeNull();
      state = "unavailable";
      staff = await official.decide("owner", report.id, {
        expectedVersion: staff.version,
        action: "hide",
        reason: "Owner used the native editorial removal workflow",
      });
      expect(state).toBe("unavailable");
      expect(staff.snapshot["source"]).toBe("official");
      expect(staff.snapshot["nativePublicationObservation"]).toMatchObject({
        status: "unavailable",
      });
      expect(staff.decision?.reason).toContain("已核验原编辑流程下架");
      const stored = (
        await pool.query(
          "SELECT restriction_key FROM community.report_decisions WHERE id=$1",
          [staff.decision!.id],
        )
      ).rows[0];
      expect(stored.restriction_key).toBeNull();
      expect(
        (
          await pool.query(
            "SELECT count(*)::integer n FROM community.report_restriction_heads WHERE subject_id=$1",
            [targetId],
          )
        ).rows[0].n,
      ).toBe(0);
      await expect(
        official.review("owner", report.id, {
          expectedVersion: staff.version,
          outcome: "overturn",
          reason: "Native restore",
        }),
      ).rejects.toBeInstanceOf(CommunityConflictError);
      await expect(
        missing.review("owner", report.id, {
          expectedVersion: staff.version,
          outcome: "overturn",
          reason: "Native restore",
        }),
      ).rejects.toBeInstanceOf(CommunityConflictError);
      state = "error";
      await expect(
        official.review("owner", report.id, {
          expectedVersion: staff.version,
          outcome: "overturn",
          reason: "Native restore",
        }),
      ).rejects.toThrow("Synthetic native read unavailable");
      state = "public";
      staff = await official.review("owner", report.id, {
        expectedVersion: staff.version,
        outcome: "overturn",
        reason: "Owner restored through the native editorial workflow",
      });
      expect(state).toBe("public");
      expect(staff.decision?.reversedAt).not.toBeNull();
      expect(staff.decision?.reviewReason).toContain(
        "已核验原编辑流程恢复公开",
      );
      expect(staff.snapshot["nativePublicationObservation"]).toMatchObject({
        status: "public",
      });
      expect(
        reads.every(
          (read) =>
            read.type === type &&
            read.id === targetId &&
            read.actor === reporter,
        ),
      ).toBe(true);
      const observation = staff.snapshot["nativePublicationObservation"] as {
        observedAt: string;
      };
      expect(Number.isNaN(Date.parse(observation.observedAt))).toBe(false);
    },
  );
  it("sends an Owner platform result only to the official rights reporter without inventing a user statement", async () => {
    const reporter = await user(),
      unrelated = await user(),
      targetId = opaque("catalog");
    const official = new PostgresCommunityReportingAdapter(pool, {
      resolveExternalTarget: async () => ({
        canonicalPath: `/?catalogId=${targetId}#detail`,
        affectedUserId: null,
        snapshot: { source: "official", title: "Official title" },
      }),
    });
    const report = await official.create(reporter, {
      kind: "rights_notice",
      target: { type: "catalog", id: targetId },
      reason: "copyright",
      description: "Synthetic rights notice",
      claimantName: "private-claimant-marker",
      contact: "private-contact-marker",
      rightsBasis: "private-rights-marker",
      requestId: randomUUID(),
    });
    let staff = await official.operatorRead(report.id);
    expect(staff.affectedUserId).toBeNull();
    await expect(
      official.forward("owner", report.id, {
        expectedVersion: staff.version,
        kind: "notice",
        text: "No invented recipient",
      }),
    ).rejects.toThrow("No recipient");
    await expect(
      official.forward("owner", report.id, {
        expectedVersion: staff.version,
        kind: "statement",
        text: "No invented user statement",
      }),
    ).rejects.toBeInstanceOf(CommunityConflictError);
    staff = await official.forward("owner", report.id, {
      expectedVersion: staff.version,
      kind: "result",
      text: "Owner platform response: native editorial review is complete.",
    });
    expect(
      staff.history.some(
        (h) => h.action === "forward_result" && h.operator === "owner",
      ),
    ).toBe(true);
    const own = await official.readOwn(reporter, report.id);
    expect(own.messages).toHaveLength(1);
    expect(own.messages[0]?.kind).toBe("result");
    expect(own.messages[0]?.text).toBe(
      "Owner platform response: native editorial review is complete.",
    );
    expect(JSON.stringify(own)).not.toMatch(
      /private-(claimant|contact|rights)-marker/u,
    );
    expect((await official.inbox(unrelated)).items).toHaveLength(0);
    expect(
      (await official.inbox(reporter)).items.filter(
        (item) => item.caseId === report.id,
      ),
    ).toHaveLength(1);
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer n FROM community.report_materials WHERE case_id=$1 AND kind='statement'",
          [report.id],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await pool.query(
          "SELECT DISTINCT recipient_id FROM community.report_messages WHERE case_id=$1",
          [report.id],
        )
      ).rows.map((row) => row.recipient_id),
    ).toEqual([reporter]);
  });
  it("upgrades a one-click reply flag into a private rights notice while preserving context and statement isolation", async () => {
    const reporter = await user(),
      affected = await user(),
      unrelated = await user(),
      post = await work(affected),
      root = opaque("comment"),
      reply = opaque("comment");
    await pool.query(
      "INSERT INTO community.catalog_comments(id,catalog_id,target_type,author_id,text,moderation) VALUES($1,$2,'work',$3,'Original root context','visible')",
      [root, post, affected],
    );
    await pool.query(
      "INSERT INTO community.catalog_comment_replies(id,root_comment_id,author_id,text,moderation) VALUES($1,$2,$3,'Original reply text','visible')",
      [reply, root, affected],
    );
    const quick = await adapter.create(reporter, {
      kind: "quick_comment",
      target: { type: "comment", id: reply },
      requestId: randomUUID(),
    });
    expect(quick.kind).toBe("quick_comment");
    expect(quick.reason).toBeNull();
    const originalContext = (await adapter.operatorRead(quick.id)).snapshot;
    const formal: CreateCommunityReportRequest = {
      kind: "rights_notice",
      target: { type: "comment", id: reply },
      reason: "copyright",
      description: "Private notice about reply text",
      claimantName: "private-reply-claimant",
      contact: "private-reply-contact",
      rightsBasis: "private-reply-basis",
      requestId: randomUUID(),
    };
    const upgraded = await adapter.create(reporter, formal);
    expect(upgraded.id).toBe(quick.id);
    expect(upgraded.kind).toBe("rights_notice");
    expect(upgraded.reason).toBe("copyright");
    let staff = await adapter.operatorRead(quick.id);
    expect(staff.snapshot).toEqual(originalContext);
    expect(staff.snapshot["parent"]).toMatchObject({
      id: root,
      text: "Original root context",
    });
    expect(staff.snapshot["post"]).toMatchObject({ type: "work", id: post });
    expect(
      staff.history.some(
        (h) =>
          h.action === "rights_notice_submitted" && h.operator === "reporter",
      ),
    ).toBe(true);
    expect(
      (
        await pool.query(
          "SELECT moderation FROM community.catalog_comment_replies WHERE id=$1",
          [reply],
        )
      ).rows[0].moderation,
    ).toBe("visible");
    await expect(
      pool.query(
        "UPDATE community.report_cases SET kind='standard' WHERE id=$1",
        [quick.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query("UPDATE community.report_cases SET reason=NULL WHERE id=$1", [
        quick.id,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(
        "UPDATE community.report_cases SET reason='other' WHERE id=$1",
        [quick.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    staff = await adapter.forward("owner", quick.id, {
      expectedVersion: staff.version,
      kind: "notice",
      text: "Deliberately redacted reply rights notice",
    });
    await adapter.decide("owner", quick.id, {
      expectedVersion: staff.version,
      action: "hide",
      reason: "Synthetic protective measure for reply",
    });
    const affectedDecision = (
      await adapter.decisions(affected, 1, 100)
    ).items.find((item) => item.caseId === quick.id)!;
    expect(affectedDecision.kind).toBe("rights_notice");
    expect(
      affectedDecision.messages.some(
        (message) =>
          message.text === "Deliberately redacted reply rights notice",
      ),
    ).toBe(true);
    expect(JSON.stringify(affectedDecision)).not.toMatch(
      /private-reply-(claimant|contact|basis)|Private notice about reply text/u,
    );
    await expect(adapter.readOwn(affected, quick.id)).rejects.toBeInstanceOf(
      CommunityNotFoundError,
    );
    await expect(adapter.readOwn(unrelated, quick.id)).rejects.toBeInstanceOf(
      CommunityNotFoundError,
    );
    await adapter.statement(affected, quick.id, {
      text: "Private reply counterstatement",
      requestId: randomUUID(),
    });
    expect(
      (await adapter.readOwn(reporter, quick.id)).messages.some(
        (message) => message.text === "Private reply counterstatement",
      ),
    ).toBe(false);
    await expect(
      adapter.statement(unrelated, quick.id, {
        text: "Unauthorized counterstatement",
        requestId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(CommunityNotFoundError);
    staff = await adapter.operatorRead(quick.id);
    expect(staff.status).toBe("reviewing");
    expect(
      staff.materials.some(
        (material) => material.text === "Private reply counterstatement",
      ),
    ).toBe(true);
    await adapter.forward("owner", quick.id, {
      expectedVersion: staff.version,
      kind: "statement",
      text: "Deliberately redacted reply counterstatement",
    });
    const own = await adapter.readOwn(reporter, quick.id);
    expect(
      own.messages.some(
        (message) =>
          message.text === "Deliberately redacted reply counterstatement",
      ),
    ).toBe(true);
    expect(
      own.messages.some(
        (message) => message.text === "Private reply counterstatement",
      ),
    ).toBe(false);
    expect((await adapter.inbox(unrelated)).items).toHaveLength(0);
  });
  it.each(["root", "reply"] as const)(
    "creates a distinct formal followup from an own resolved hidden %s case",
    async (kind) => {
      const reporter = await user(),
        affected = await user(),
        foreign = await user(),
        post = await work(affected),
        root = opaque("comment"),
        reply = opaque("comment");
      await pool.query(
        "INSERT INTO community.catalog_comments(id,catalog_id,target_type,author_id,text,moderation) VALUES($1,$2,'work',$3,'Retained root context','visible')",
        [root, post, affected],
      );
      await pool.query(
        "INSERT INTO community.catalog_comment_replies(id,root_comment_id,author_id,text,moderation) VALUES($1,$2,$3,'Retained reply context','visible')",
        [reply, root, affected],
      );
      const target = {
        type: "comment" as const,
        id: kind === "root" ? root : reply,
      };
      const original = await adapter.create(reporter, {
        kind: "quick_comment",
        target,
        requestId: randomUUID(),
      });
      const hidden = await decide(original, "hide");
      const before = (
        await pool.query(
          "SELECT to_jsonb(c) AS row FROM community.report_cases c WHERE id=$1",
          [original.id],
        )
      ).rows[0].row;
      const formal = {
        kind: "rights_notice" as const,
        target,
        reason: "copyright" as const,
        description: "Formal hidden-text followup",
        claimantName: "Synthetic claimant",
        contact: "synthetic@example.invalid",
        rightsBasis: "Synthetic basis",
        requestId: randomUUID(),
      };
      await expect(adapter.create(reporter, formal)).rejects.toBeInstanceOf(
        CommunityNotFoundError,
      );
      await expect(
        adapter.create(foreign, {
          ...formal,
          sourceCaseId: original.id,
          requestId: randomUUID(),
        }),
      ).rejects.toBeInstanceOf(CommunityNotFoundError);
      await expect(
        adapter.create(reporter, {
          ...formal,
          target: { type: "work", id: post },
          sourceCaseId: original.id,
          requestId: randomUUID(),
        }),
      ).rejects.toBeInstanceOf(CommunityNotFoundError);
      const command = { ...formal, sourceCaseId: original.id };
      const followup = await adapter.create(reporter, command);
      expect(followup.id).not.toBe(original.id);
      expect((await adapter.create(reporter, command)).id).toBe(followup.id);
      expect(
        (
          await adapter.create(reporter, {
            ...command,
            requestId: randomUUID(),
          })
        ).id,
      ).toBe(followup.id);
      expect(
        (
          await pool.query(
            "SELECT to_jsonb(c) AS row FROM community.report_cases c WHERE id=$1",
            [original.id],
          )
        ).rows[0].row,
      ).toEqual(before);
      const detail = await adapter.operatorRead(followup.id);
      expect(detail.snapshot).toEqual({
        ...hidden.snapshot,
        sourceCaseId: original.id,
      });
      expect(detail.affectedUserId).toBe(affected);
      expect(detail.canonicalPath).toBe(original.canonicalPath);
      expect(
        detail.history.filter(
          (event) => event.action === "rights_notice_followup",
        ),
      ).toHaveLength(1);
      const appeal = await adapter.appeal(affected, hidden.decision!.id, {
        text: "Original decision remains appealable",
        requestId: randomUUID(),
      });
      expect(appeal.appeal?.status).toBe("pending");
      expect(
        (
          await adapter.create(reporter, {
            ...command,
            requestId: randomUUID(),
          })
        ).id,
      ).toBe(followup.id);
      expect((await adapter.operatorRead(original.id)).kind).toBe(
        "quick_comment",
      );
      await pool.query(
        "UPDATE community.report_cases SET snapshot=snapshot||'{\"retentionRedacted\":true}'::jsonb WHERE id=$1",
        [original.id],
      );
      await expect(
        adapter.create(reporter, { ...command, requestId: randomUUID() }),
      ).rejects.toBeInstanceOf(CommunityConflictError);
      await pool.query(
        "UPDATE community.report_cases SET snapshot=$2::jsonb,closed_at=CURRENT_TIMESTAMP-interval '3 years 1 day',legal_hold=false WHERE id=$1",
        [original.id, JSON.stringify(hidden.snapshot)],
      );
      await expect(
        adapter.create(reporter, { ...command, requestId: randomUUID() }),
      ).rejects.toBeInstanceOf(CommunityConflictError);
      await pool.query(
        "UPDATE community.report_cases SET closed_at=NULL,snapshot='{}'::jsonb WHERE id=$1",
        [original.id],
      );
      await expect(
        adapter.create(reporter, { ...command, requestId: randomUUID() }),
      ).rejects.toBeInstanceOf(CommunityConflictError);
    },
  );
  it("advances authored Article versions on hide and restore without changing its published revision", async () => {
    const reporter = await user(),
      author = await user(),
      article = opaque("article"),
      document = JSON.stringify({
        format: "blocknote",
        version: 1,
        blocks: [],
        references: {},
      }),
      fingerprint = "a".repeat(64);
    await pool.query(
      "INSERT INTO community.article_documents(id,owner_id,version,title,document,fingerprint,created_at,updated_at) VALUES($1,$2,1,'Synthetic authored Article',$3::jsonb,$4,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
      [article, author, document, fingerprint],
    );
    await pool.query(
      "INSERT INTO community.article_revisions(article_id,version,owner_id,title,document,fingerprint,submitted_policy,submitted_by_source,created_at) VALUES($1,1,$2,'Synthetic authored Article',$3::jsonb,$4,'DIRECT_PUBLICATION','human',CURRENT_TIMESTAMP)",
      [article, author, document, fingerprint],
    );
    await pool.query(
      "UPDATE community.article_documents SET version=2,status='published',published_version=1,first_published_at=CURRENT_TIMESTAMP,published_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=$1",
      [article],
    );
    const before = (
      await pool.query(
        "SELECT to_jsonb(r) AS row FROM community.article_revisions r WHERE article_id=$1",
        [article],
      )
    ).rows[0].row;
    const report = await adapter.create(reporter, {
      kind: "standard",
      target: { type: "article", id: article },
      reason: "other",
      requestId: randomUUID(),
    });
    const hidden = await decide(report, "hide");
    expect(
      (
        await pool.query(
          "SELECT version,reporting_hidden,published_version FROM community.article_documents WHERE id=$1",
          [article],
        )
      ).rows[0],
    ).toEqual({ version: 3, reporting_hidden: true, published_version: 1 });
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer n FROM community.published_authored_articles WHERE article_id=$1",
          [article],
        )
      ).rows[0].n,
    ).toBe(0);
    await adapter.review("owner", report.id, {
      expectedVersion: hidden.version,
      outcome: "overturn",
      reason: "Synthetic Article correction",
    });
    expect(
      (
        await pool.query(
          "SELECT version,reporting_hidden,published_version FROM community.article_documents WHERE id=$1",
          [article],
        )
      ).rows[0],
    ).toEqual({ version: 4, reporting_hidden: false, published_version: 1 });
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer n FROM community.published_authored_articles WHERE article_id=$1",
          [article],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await pool.query(
          "SELECT to_jsonb(r) AS row FROM community.article_revisions r WHERE article_id=$1",
          [article],
        )
      ).rows[0].row,
    ).toEqual(before);
  });
  it.each(["appeal", "rights_statement"] as const)(
    "keeps separate ten-file uploader quotas for authorized %s evidence",
    async (flow) => {
      const reporter = await user(),
        author = await user(),
        target = { type: "user" as const, id: author };
      const report =
        flow === "appeal"
          ? await adapter.create(reporter, {
              kind: "standard",
              target,
              reason: "harassment",
              requestId: randomUUID(),
            })
          : await adapter.create(reporter, {
              kind: "rights_notice",
              target,
              reason: "copyright",
              description: "Synthetic rights notice",
              claimantName: "Synthetic claimant",
              contact: "synthetic@example.invalid",
              rightsBasis: "Synthetic ownership basis",
              requestId: randomUUID(),
            });
      const files = new Set<string>();
      const evidence = (owner: string, index: number) => ({
        id: opaque("evidence"),
        fileName: `${owner}-${index}.pdf`,
        mimeType: "application/pdf",
        size: 20,
        sensitive: true,
        sha256: "a".repeat(64),
        createdAt: new Date().toISOString(),
        downloadPath: "synthetic",
      });
      const reporterFiles = Array.from({ length: 10 }, (_, i) =>
        evidence("reporter", i),
      );
      for (const item of reporterFiles.slice(0, 9))
        await adapter.addEvidence(
          reporter,
          report.id,
          item,
          async () => {
            files.add(item.id);
          },
          async () => {
            files.delete(item.id);
          },
        );
      let reserved!: () => void, release!: () => void;
      const started = new Promise<void>((resolve) => {
          reserved = resolve;
        }),
        held = new Promise<void>((resolve) => {
          release = resolve;
        });
      const tenth = reporterFiles[9]!;
      const pending = adapter.addEvidence(
        reporter,
        report.id,
        tenth,
        async () => {
          reserved();
          await held;
          files.add(tenth.id);
        },
        async () => {
          files.delete(tenth.id);
        },
      );
      const rejectedBeforeStorage = async (
        actor: string,
        item: ReturnType<typeof evidence>,
      ) => {
        let touched = false;
        await expect(
          adapter.addEvidence(
            actor,
            report.id,
            item,
            async () => {
              touched = true;
              files.add(item.id);
            },
            async () => {
              files.delete(item.id);
            },
          ),
        ).rejects.toThrow("Evidence limit reached");
        expect(touched).toBe(false);
      };
      try {
        await started;
        expect(
          (
            await pool.query(
              "SELECT count(*)::integer n FROM community.report_evidence WHERE case_id=$1 AND owner_id=$2 AND state='pending'",
              [report.id, reporter],
            )
          ).rows[0].n,
        ).toBe(1);
        await rejectedBeforeStorage(reporter, evidence("reporter", 10));
      } finally {
        release();
        await pending;
      }
      let staff = await adapter.operatorRead(report.id);
      staff = await adapter.decide("owner", report.id, {
        expectedVersion: staff.version,
        action: "warn",
        reason: "Synthetic review outcome",
      });
      if (flow === "appeal")
        await adapter.appeal(author, staff.decision!.id, {
          text: "Synthetic author appeal",
          requestId: randomUUID(),
        });
      else
        await adapter.statement(author, report.id, {
          text: "Synthetic author rights statement",
          requestId: randomUUID(),
        });
      const authorFiles = Array.from({ length: 10 }, (_, i) =>
        evidence("author", i),
      );
      for (const item of authorFiles)
        await adapter.addEvidence(
          author,
          report.id,
          item,
          async () => {
            files.add(item.id);
          },
          async () => {
            files.delete(item.id);
          },
        );
      await rejectedBeforeStorage(author, evidence("author", 10));
      await rejectedBeforeStorage(reporter, evidence("reporter", 11));
      expect(files.size).toBe(20);
      const rows = (
        await pool.query(
          "SELECT owner_id,count(*)::integer n FROM community.report_evidence WHERE case_id=$1 GROUP BY owner_id",
          [report.id],
        )
      ).rows;
      expect(new Map(rows.map((row) => [row.owner_id, row.n]))).toEqual(
        new Map([
          [reporter, 10],
          [author, 10],
        ]),
      );
      await expect(
        adapter.evidence(author, report.id, reporterFiles[0]!.id),
      ).rejects.toBeInstanceOf(CommunityNotFoundError);
      await expect(
        adapter.evidence(reporter, report.id, authorFiles[0]!.id),
      ).rejects.toBeInstanceOf(CommunityNotFoundError);
      expect(
        (await adapter.evidence(reporter, report.id, reporterFiles[0]!.id)).id,
      ).toBe(reporterFiles[0]!.id);
      expect(
        (await adapter.evidence(author, report.id, authorFiles[0]!.id)).id,
      ).toBe(authorFiles[0]!.id);
      expect(
        (await adapter.readOwn(reporter, report.id)).evidence
          .map((item) => item.id)
          .sort(),
      ).toEqual(reporterFiles.map((item) => item.id).sort());
      const decision = (await adapter.decisions(author, 1, 100)).items.find(
        (item) => item.caseId === report.id,
      )!;
      expect(decision.evidence.map((item) => item.id).sort()).toEqual(
        authorFiles.map((item) => item.id).sort(),
      );
    },
  );
});
