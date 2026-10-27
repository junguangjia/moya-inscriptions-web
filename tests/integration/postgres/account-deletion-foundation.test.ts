import { randomUUID } from "node:crypto";
import { CommunityInputError } from "@moya/api";
import {
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import {
  PostgresCommunityCommentAdapter,
  PostgresCommunityIdentityAdapter,
  PostgresCommunityReportingAdapter,
} from "@moya/community-postgres";
import type {
  CatalogCommentId,
  CatalogId,
  PublicUserId,
} from "@moya/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCatalogScaleDatabase,
  type CatalogScaleDatabase,
} from "./catalog-scale-fixture.js";
import { requireSyntheticTestDatabaseUrl } from "./synthetic-test-database.js";

/*
 * account-deletion-v1 foundation (community migration 20261027010000 and its
 * runtime grants), exercised as the real non-owner App role: `deleted` is a
 * terminal status the database enforces, a deleted account may lose its last
 * login identity, the deletion record keeps its identity columns write-once,
 * and the erasure DELETEs exist on exactly the tables account deletion
 * empties. Every account, contact digest and token here is synthetic.
 */

const target = requireSyntheticTestDatabaseUrl();
let db: CatalogScaleDatabase;
const hex32 = () => randomUUID().replaceAll("-", "");
const hex64 = () => `${hex32()}${hex32()}`;
const userId = () => `user-${hex32()}` as PublicUserId;
const user = async (status: "active" | "suspended" = "active") => {
  const id = userId();
  await db.setup.query(
    "INSERT INTO community.public_users(id,handle,display_name,status) VALUES($1,$2,'Synthetic account',$3)",
    [id, `del-${id.slice(-24)}`, status],
  );
  return id;
};
const setStatus = (id: string, status: string) =>
  db.app.query(
    "UPDATE community.public_users SET status=$2,updated_at=CURRENT_TIMESTAMP WHERE id=$1",
    [id, status],
  );
const statusOf = async (id: string) =>
  (
    await db.setup.query<{ status: string; revision: string }>(
      "SELECT status,reporting_revision::text AS revision FROM community.public_users WHERE id=$1",
      [id],
    )
  ).rows[0]!;
const identity = async (owner: string, kind: "email" | "phone") =>
  db.setup.query(
    `INSERT INTO community.user_login_identities
      (id,user_id,kind,lookup_digest,ciphertext,lookup_key_version,verification_mode,environment,version,verified_at)
     VALUES($1,$2,$3,$4,'synthetic-envelope',1,'local_capture','development',1,CURRENT_TIMESTAMP)`,
    [`login-${hex32()}`, owner, kind, hex64()],
  );
const identities = async (owner: string) =>
  (
    await db.setup.query<{ n: number }>(
      "SELECT count(*)::integer AS n FROM community.user_login_identities WHERE user_id=$1",
      [owner],
    )
  ).rows[0]!.n;
const terminal = { code: "23514", constraint: "public_users_status_terminal" };

beforeAll(async () => {
  db = await createCatalogScaleDatabase({
    target,
    label: "acctdel",
    openPool: (url) =>
      createPostgresPool(parsePostgresConfig({ DATABASE_URL: url })),
  });
}, 60000);
afterAll(async () => {
  await db?.close();
});

describe("account deletion foundation under the real App role", () => {
  it("enters deleted only from active, then refuses every way out", async () => {
    const live = await user();
    const before = await statusOf(live);
    await setStatus(live, "deleted");
    const deleted = await statusOf(live);
    expect(deleted.status).toBe("deleted");
    // The status write still invalidates an earlier report restoration lease.
    expect(Number(deleted.revision)).toBe(Number(before.revision) + 1);
    for (const status of ["active", "suspended"])
      await expect(setStatus(live, status)).rejects.toMatchObject(terminal);
    // A refused write changes nothing, not even the reporting revision.
    expect(await statusOf(live)).toEqual(deleted);
    // Restating the terminal status is harmless (an exact retry's erasure).
    await setStatus(live, "deleted");
    expect((await statusOf(live)).status).toBe("deleted");

    const suspended = await user("suspended");
    await expect(setStatus(suspended, "deleted")).rejects.toMatchObject(
      terminal,
    );
    expect((await statusOf(suspended)).status).toBe("suspended");
    // Suspension and reinstatement of live accounts are unchanged.
    await setStatus(suspended, "active");
    await setStatus(suspended, "suspended");
    await expect(setStatus(await user(), "closed")).rejects.toMatchObject({
      code: "23514",
      constraint: "public_users_status_valid",
    });
  });

  it("lets only a deleted account lose its last login identity", async () => {
    const single = await user();
    await identity(single, "email");
    await expect(
      db.app.query(
        "DELETE FROM community.user_login_identities WHERE user_id=$1",
        [single],
      ),
    ).rejects.toMatchObject({ code: "23514", message: "last login identity" });
    expect(await identities(single)).toBe(1);

    const both = await user();
    await identity(both, "email");
    await identity(both, "phone");
    // A live account may drop one of two factors, never the second.
    await db.app.query(
      "DELETE FROM community.user_login_identities WHERE user_id=$1 AND kind='phone'",
      [both],
    );
    await expect(
      db.app.query(
        "DELETE FROM community.user_login_identities WHERE user_id=$1",
        [both],
      ),
    ).rejects.toMatchObject({ message: "last login identity" });
    await identity(both, "phone");

    for (const owner of [single, both]) {
      await setStatus(owner, "deleted");
      // One statement removes every identity, freeing each contact.
      await db.app.query(
        "DELETE FROM community.user_login_identities WHERE user_id=$1",
        [owner],
      );
      expect(await identities(owner)).toBe(0);
    }
  });

  it("keeps the deletion record write-once except for the purge completion", async () => {
    const owner = await user();
    await setStatus(owner, "deleted");
    const session = `session-${hex32()}`;
    await db.app.query(
      "INSERT INTO community.account_deletions(user_id,request_key_hash,session_id,deleted_at) VALUES($1,$2,$3,CURRENT_TIMESTAMP)",
      [owner, hex64(), session],
    );
    const row = (
      await db.app.query(
        "SELECT purge_state,purge_completed_at,session_id FROM community.account_deletions WHERE user_id=$1",
        [owner],
      )
    ).rows[0];
    expect(row).toEqual({
      purge_state: "pending",
      purge_completed_at: null,
      session_id: session,
    });
    // Completion needs its time, and the time needs the completed state.
    for (const [state, completed] of [
      ["completed", null],
      ["pending", new Date()],
    ] as const)
      await expect(
        db.app.query(
          "UPDATE community.account_deletions SET purge_state=$2,purge_completed_at=$3 WHERE user_id=$1",
          [owner, state, completed],
        ),
      ).rejects.toMatchObject({
        constraint: "account_deletions_purge_completion",
      });
    await db.app.query(
      "UPDATE community.account_deletions SET purge_state='completed',purge_completed_at=CURRENT_TIMESTAMP WHERE user_id=$1",
      [owner],
    );
    for (const sql of [
      "UPDATE community.account_deletions SET request_key_hash=request_key_hash WHERE user_id=$1",
      "UPDATE community.account_deletions SET session_id=session_id WHERE user_id=$1",
      "UPDATE community.account_deletions SET deleted_at=deleted_at WHERE user_id=$1",
      "UPDATE community.account_deletions SET user_id=user_id WHERE user_id=$1",
      "DELETE FROM community.account_deletions WHERE user_id=$1",
    ])
      await expect(db.app.query(sql, [owner])).rejects.toMatchObject({
        code: "42501",
      });
    // One record per account; identifiers keep their formats.
    await expect(
      db.app.query(
        "INSERT INTO community.account_deletions(user_id,request_key_hash,session_id,deleted_at) VALUES($1,$2,$3,CURRENT_TIMESTAMP)",
        [owner, hex64(), session],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    const other = await user();
    for (const [key, id, constraint] of [
      [
        "not-a-digest",
        `session-${hex32()}`,
        "account_deletions_request_key_sha256",
      ],
      [hex64(), "session-raw-token", "account_deletions_session_id_opaque"],
    ] as const)
      await expect(
        db.app.query(
          "INSERT INTO community.account_deletions(user_id,request_key_hash,session_id,deleted_at) VALUES($1,$2,$3,CURRENT_TIMESTAMP)",
          [other, key, id],
        ),
      ).rejects.toMatchObject({ code: "23514", constraint });
  });

  it("grants exactly the erasure DELETEs and executes them for one account", async () => {
    const deletable = async (table: string) =>
      (
        await db.app.query<{ allowed: boolean }>(
          "SELECT has_table_privilege(current_user,$1,'DELETE') AS allowed",
          [`community.${table}`],
        )
      ).rows[0]!.allowed;
    for (const table of [
      "user_password_credentials",
      "auth_challenges",
      "auth_handoffs",
      "profile_ip_locations",
      "user_login_identities",
    ])
      expect(await deletable(table), table).toBe(true);
    // The tombstone, its sessions, receipts and audit history stay.
    for (const table of [
      "public_users",
      "sessions",
      "auth_receipts",
      "auth_audit_events",
      "auth_password_reset_receipts",
      "account_deletions",
      "user_media",
    ])
      expect(await deletable(table), table).toBe(false);
    const record = (
      await db.app.query(
        "SELECT has_table_privilege(current_user,'community.account_deletions','SELECT') AS read,has_table_privilege(current_user,'community.account_deletions','INSERT') AS insert,has_table_privilege(current_user,'community.account_deletions','UPDATE') AS update",
      )
    ).rows[0];
    expect(record).toEqual({ read: true, insert: true, update: false });
    const mutable = (
      await db.app.query<{ name: string }>(
        "SELECT a.attname AS name FROM pg_attribute a WHERE a.attrelid='community.account_deletions'::regclass AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(current_user,a.attrelid,a.attnum,'UPDATE') ORDER BY a.attname",
      )
    ).rows.map((row) => row.name);
    expect(mutable).toEqual(["purge_completed_at", "purge_state"]);

    const owner = await user();
    const bystander = await user();
    for (const id of [owner, bystander]) {
      await db.setup.query(
        `INSERT INTO community.auth_challenges
          (id,channel,purpose,target_digest,ciphertext,code_verifier,verification_strategy,provider_mode,environment,
           user_id,continuation_hash,expires_at,attempts,resend_available_at,delivery_state,idempotency_hash,created_at)
         VALUES($1,'email','reauthenticate',$2,'synthetic-envelope',$3,'application_otp','local_capture','development',
           $4,$5,CURRENT_TIMESTAMP+interval '10 minutes',0,CURRENT_TIMESTAMP,'accepted',$6,CURRENT_TIMESTAMP)`,
        [`challenge-${hex32()}`, hex64(), hex64(), id, hex64(), hex64()],
      );
      await db.setup.query(
        `INSERT INTO community.auth_handoffs
          (id,token_hash,purpose,channel,target_digest,ciphertext,provider_mode,environment,user_id,expires_at)
         VALUES($1,$2,'reauth','email',$3,'synthetic-envelope','local_capture','development',$4,CURRENT_TIMESTAMP+interval '10 minutes')`,
        [`handoff-${hex32()}`, hex64(), hex64(), id],
      );
      await db.setup.query(
        "INSERT INTO community.user_password_credentials(user_id,verifier,version,updated_at) VALUES($1,$2,1,CURRENT_TIMESTAMP)",
        [id, `scrypt-v1$32768$8$3$${"A".repeat(22)}$${"B".repeat(43)}`],
      );
      await db.setup.query(
        "INSERT INTO community.profile_ip_locations(user_id,label) VALUES($1,'Synthetic region')",
        [id],
      );
    }
    for (const table of [
      "auth_challenges",
      "auth_handoffs",
      "user_password_credentials",
      "profile_ip_locations",
    ])
      await db.app.query(`DELETE FROM community.${table} WHERE user_id=$1`, [
        owner,
      ]);
    const left = async (id: string) =>
      (
        await db.setup.query<{ n: number }>(
          `SELECT (SELECT count(*) FROM community.auth_challenges WHERE user_id=$1)
             + (SELECT count(*) FROM community.auth_handoffs WHERE user_id=$1)
             + (SELECT count(*) FROM community.user_password_credentials WHERE user_id=$1)
             + (SELECT count(*) FROM community.profile_ip_locations WHERE user_id=$1) AS n`,
          [id],
        )
      ).rows[0]!.n;
    expect(Number(await left(owner))).toBe(0);
    expect(Number(await left(bystander))).toBe(4);
  });

  it("refuses Admin and report status changes of a deleted account without writing", async () => {
    const owner = await user();
    const reporter = await user();
    const reporting = new PostgresCommunityReportingAdapter(db.app);
    const report = await reporting.create(reporter, {
      kind: "standard",
      target: { type: "user", id: owner },
      reason: "harassment",
      description: "Synthetic report",
      requestId: randomUUID(),
    });
    // A session the deletion has not revoked yet still identifies, mapped
    // as `deleted` (signed out by the session service), never a mapper throw.
    const token = hex64();
    await db.setup.query(
      "INSERT INTO community.sessions(id,token_hash,user_id,issued_at,expires_at) VALUES($1,$2,$3,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+interval '1 day')",
      [`session-${hex32()}`, token, owner],
    );
    await setStatus(owner, "deleted");
    const identity = new PostgresCommunityIdentityAdapter(db.app);
    expect(await identity.findSessionUser(token, new Date())).toMatchObject({
      id: owner,
      status: "deleted",
    });
    const deleted = await statusOf(owner);
    for (const status of ["active", "suspended"] as const)
      expect(
        await identity.setUserStatus(owner, status, new Date(), {
          id: `moderation-${hex32()}`,
          occurredAt: new Date(),
          operatorLabel: "owner",
          action: status === "active" ? "reinstate" : "suspend",
        }),
      ).toMatchObject({ user: { status: "deleted" }, revokedSessions: 0 });
    expect(await statusOf(owner)).toEqual(deleted);
    expect(
      (
        await db.setup.query(
          "SELECT count(*)::integer AS n FROM community.moderation_events WHERE subject_id=$1",
          [owner],
        )
      ).rows[0].n,
    ).toBe(0);
    // The session the moderation path left alone is still unrevoked: nothing
    // was written at all.
    expect(
      (
        await db.setup.query(
          "SELECT revoked_at FROM community.sessions WHERE token_hash=$1",
          [token],
        )
      ).rows[0].revoked_at,
    ).toBeNull();

    const current = await reporting.operatorRead(report.id);
    expect(current.allowedActions).not.toContain("suspend");
    expect(current.allowedActions).toContain("retain");
    await expect(
      reporting.decide("owner", report.id, {
        expectedVersion: current.version,
        action: "suspend",
        reason: "Synthetic staff decision",
      }),
    ).rejects.toBeInstanceOf(CommunityInputError);
    expect(await statusOf(owner)).toEqual(deleted);
  });

  it("keeps a deleted author's comments and replies, marked and anonymized", async () => {
    const owner = await user();
    const reader = await user();
    const gone = await user();
    const work = `work-${hex32()}`;
    await db.setup.query(
      "INSERT INTO community.works(id,author_id,title,text,first_published_at) VALUES($1,$2,'Synthetic post','Synthetic body',CURRENT_TIMESTAMP)",
      [work, owner],
    );
    const comments = new PostgresCommunityCommentAdapter(db.app);
    const target = { type: "work" as const, id: work };
    const root = await comments.submitDiscussion(target, gone, "合成根评论");
    const first = await comments.submitDiscussion(
      target,
      gone,
      "合成回复",
      root.id,
    );
    const answer = await comments.submitDiscussion(
      target,
      reader,
      "合成追问",
      root.id,
      first.id,
    );
    const catalogId = "synthetic-deletion-catalog" as CatalogId;
    const legacyRoot = await comments.insertComment({
      id: `comment-${hex32()}` as CatalogCommentId,
      catalogId,
      authorId: gone,
      text: "合成图录评论",
      moderation: "visible",
      createdAt: new Date(),
    });
    const legacyFirst = await comments.insertReply({
      id: `comment-${hex32()}` as CatalogCommentId,
      rootCommentId: legacyRoot.id,
      authorId: gone,
      text: "合成图录回复",
      moderation: "visible",
      createdAt: new Date(),
    });
    const legacyAnswer = await comments.insertReply({
      id: `comment-${hex32()}` as CatalogCommentId,
      rootCommentId: legacyRoot.id,
      authorId: reader as PublicUserId,
      text: "合成图录追问",
      moderation: "visible",
      createdAt: new Date(),
      replyToReplyId: legacyFirst.id,
    });
    // Live authors carry no marker.
    expect(root.item.author).not.toHaveProperty("deleted");
    expect(legacyRoot.author).not.toHaveProperty("deleted");

    await db.setup.query(
      "UPDATE community.public_users SET status='deleted',display_name='已注销用户' WHERE id=$1",
      [gone],
    );
    const anonymized = { id: gone, displayName: "已注销用户", deleted: true };
    const query = { page: 1, pageSize: 20 };
    const page = await comments.readDiscussion(target, reader, query);
    const listed = [...page.hot, ...page.items].find(
      (item) => item.id === root.id,
    )!;
    expect(listed.author).toMatchObject(anonymized);
    expect(listed.text).toBe("合成根评论");
    const replies = (
      await comments.readDiscussionReplies(target, root.id, reader, query)
    ).items;
    expect(replies.find((item) => item.id === first.id)?.author).toMatchObject(
      anonymized,
    );
    const followUp = replies.find((item) => item.id === answer.id)!;
    expect(followUp.author).not.toHaveProperty("deleted");
    expect(followUp.replyTo).toMatchObject(anonymized);

    const catalog = await comments.readVisibleComments({
      catalogId,
      page: 1,
      pageSize: 20,
      embeddedReplyLimit: 3,
      hotLimit: 3,
      pinned: [],
    });
    const catalogRoot = [...catalog.hot, ...catalog.items].find(
      (item) => item.id === legacyRoot.id,
    )!;
    expect(catalogRoot.author).toMatchObject(anonymized);
    expect(
      catalogRoot.replies.find((item) => item.id === legacyAnswer.id)?.replyTo,
    ).toMatchObject(anonymized);
    const catalogReplies = (
      await comments.readVisibleReplies({
        rootCommentId: legacyRoot.id,
        page: 1,
        pageSize: 20,
      })
    ).items;
    expect(
      catalogReplies.find((item) => item.id === legacyFirst.id)?.author,
    ).toMatchObject(anonymized);
    expect((await comments.findReply(legacyAnswer.id))?.replyTo).toMatchObject(
      anonymized,
    );
  });

  it("queues the account purge kind and indexes user-wide auth scans", async () => {
    const owner = await user();
    await db.app.query(
      "INSERT INTO community.publishing_jobs(id,kind,subject_id) VALUES($1,'purge_deleted_account',$2)",
      [`publishing-job-${hex32()}`, owner],
    );
    expect(
      (
        await db.setup.query(
          "SELECT kind,state FROM community.publishing_jobs WHERE subject_id=$1",
          [owner],
        )
      ).rows,
    ).toEqual([{ kind: "purge_deleted_account", state: "queued" }]);
    expect(
      (
        await db.setup.query<{ indexname: string }>(
          "SELECT indexname FROM pg_indexes WHERE schemaname='community' AND indexname = ANY($1::text[]) ORDER BY indexname",
          [
            [
              "auth_challenges_user_idx",
              "auth_handoffs_user_idx",
              "auth_receipts_user_idx",
            ],
          ],
        )
      ).rows.map((row) => row.indexname),
    ).toEqual([
      "auth_challenges_user_idx",
      "auth_handoffs_user_idx",
      "auth_receipts_user_idx",
    ]);
  });
});
