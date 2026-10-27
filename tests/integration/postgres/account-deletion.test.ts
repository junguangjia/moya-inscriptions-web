import { randomUUID } from "node:crypto";
import {
  CommunityAuthService,
  CommunityInputError,
  CommunityNotFoundError,
  CommunitySessionService,
  hashSessionToken,
} from "@moya/api";
import {
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import {
  PostgresAuthorCommunityAdapter,
  PostgresCommunityAuthAdapter,
  PostgresCommunityCommentAdapter,
  PostgresCommunityIdentityAdapter,
  PostgresDirectMessageAdapter,
} from "@moya/community-postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  createCatalogScaleDatabase,
  type CatalogScaleDatabase,
} from "./catalog-scale-fixture.js";
import { requireSyntheticTestDatabaseUrl } from "./synthetic-test-database.js";

import type {
  AuthDeliveryPorts,
  CommunityAuthPort,
  CommunityAuthServiceOptions,
} from "@moya/api";
import type { PublicUserId } from "@moya/contracts";

/*
 * account-deletion-v1 (Issue #351 r3) deletion core against PostgreSQL as
 * the real non-owner App role: CommunityAuthService.deleteAccount over
 * PostgresCommunityAuthAdapter ends the account in one transaction (every
 * Session of both scopes, receipts, proofs, login identities, the password
 * credential, the contact ciphertext of its auth history, its own relations,
 * the anonymized profile, the deletion record, the public-copy withdrawal and
 * the queued purge), replays an exact retry, deletes once under concurrency,
 * leaves an interrupted request untouched, keeps direct-message history and
 * comments for the other participants (still hidden from whoever blocked the
 * account: those blocks stay, r3), and frees the email and phone for an
 * unrelated registration. Every account, contact, code and token here is
 * synthetic; the codes stay in test memory.
 */

const target = requireSyntheticTestDatabaseUrl();
let db: CatalogScaleDatabase;
const keys = {
  version: 1,
  lookupKey: Buffer.alloc(32, 41),
  encryptionKey: Buffer.alloc(32, 42),
  otpKey: Buffer.alloc(32, 43),
};
const source = "synthetic-deletion-pg";
const codes: string[] = [];
const delivery = (): AuthDeliveryPorts => ({
  sendEmail: async (input) => {
    codes.push(input.code);
    return { state: "accepted", correlation: "synthetic-deletion-mail" };
  },
  sendPhone: async (input) => {
    if (input.code !== null) codes.push(input.code);
    return { state: "accepted", correlation: "synthetic-deletion-sms" };
  },
  checkPhone: async () => "fail",
});
const key = () => randomUUID();
const hex32 = () => randomUUID().replaceAll("-", "");
const latestCode = () => {
  const code = codes.at(-1);
  if (code === undefined) throw new Error("no synthetic code");
  return code;
};
const options = (): CommunityAuthServiceOptions => ({
  environment: "development",
  profile: "full-local",
  keys,
  emailMode: "local_capture",
  phoneMode: "simulated",
  delivery: delivery(),
});
const serviceOver = (port: CommunityAuthPort) =>
  new CommunityAuthService(port, options());
let service: CommunityAuthService;

type ChallengeInput = Parameters<CommunityAuthService["sendChallenge"]>[0];
const send = async (
  input: Omit<ChallengeInput, "idempotencyKey" | "source">,
) => {
  const sent = await service.sendChallenge({
    ...input,
    idempotencyKey: key(),
    source,
  } as ChallengeInput);
  if (!sent.ok || sent.value.continuationToken === undefined)
    throw new Error(sent.ok ? "missing continuation" : sent.reason);
  return {
    challengeId: sent.value.challengeId,
    continuationToken: sent.value.continuationToken,
    code: latestCode(),
  };
};
const prove = async (
  input: Omit<ChallengeInput, "idempotencyKey" | "source">,
) => {
  const verified = await service.verifyChallenge({
    ...(await send(input)),
    idempotencyKey: key(),
  });
  if (!verified.ok) throw new Error(verified.reason);
  return verified.value;
};
const register = async (identifier: string) => {
  const proof = await prove({
    channel: "email",
    purpose: "register",
    identifier,
  });
  if (proof.outcome !== "registration_required") throw new Error(proof.outcome);
  const registered = await service.confirmRegistration({
    handoffToken: proof.handoffToken,
    displayName: "Synthetic owner",
    studioName: "合成斋",
    agreement: true,
    idempotencyKey: key(),
  });
  if (!registered.ok) throw new Error(registered.reason);
  return registered.value;
};
const reauthenticate = async (sessionToken: string) => {
  const proof = await prove({
    channel: "email",
    purpose: "reauthenticate",
    sessionToken,
  });
  if (proof.outcome !== "reauthenticated") throw new Error(proof.outcome);
  return proof.reauthToken;
};
/** Links the synthetic phone; the factor change mints the Session to use. */
const linkPhone = async (sessionToken: string, identifier: string) => {
  const reauthToken = await reauthenticate(sessionToken);
  const linked = await service.completeFactor({
    ...(await send({
      channel: "phone",
      purpose: "link",
      identifier,
      sessionToken,
      reauthToken,
    })),
    reauthToken,
    expectedVersion: 0,
    idempotencyKey: key(),
    sessionToken,
  });
  if (!linked.ok) throw new Error(linked.reason);
  return linked.value.session.token;
};
const count = async (sql: string, values: readonly unknown[]) =>
  Number(
    (await db.setup.query<{ n: string }>(sql, [...values])).rows[0]?.n ?? 0,
  );
const userRow = async (id: string) =>
  (
    await db.setup.query(
      `SELECT handle, status, display_name, bio, studio_name, studio_name_suffix,
         avatar_media_id, background_media_id, following_privacy, followers_privacy,
         favorites_privacy, likes_privacy
       FROM community.public_users WHERE id=$1`,
      [id],
    )
  ).rows[0];

beforeAll(async () => {
  db = await createCatalogScaleDatabase({
    target,
    label: "acctera",
    openPool: (url) =>
      createPostgresPool(parsePostgresConfig({ DATABASE_URL: url })),
  });
  service = serviceOver(new PostgresCommunityAuthAdapter(db.app));
}, 60000);
afterAll(async () => {
  await db?.close();
});
afterEach(() => {
  codes.length = 0;
});

describe("account deletion under the real App role", () => {
  it("ends the account in one transaction and leaves every other account as it was", async () => {
    const ownerEmail = "erase-owner@example.invalid";
    // The placeholder number the auth suites already use; never a real one.
    const ownerPhone = "+86 138 0013 8000";
    const registered = await register(ownerEmail);
    const owner = registered.profile.id;
    const token = await linkPhone(registered.token, ownerPhone);
    const peerSession = await register("erase-peer@example.invalid");
    const blockerSession = await register("erase-blocker@example.invalid");
    // Blocked the owner and reads the peer's discussion (r3).
    const watcherSession = await register("erase-watcher@example.invalid");
    const peer = peerSession.profile.id;
    const blocker = blockerSession.profile.id;
    const watcher = watcherSession.profile.id;
    const digests = (
      await db.setup.query<{ lookup_digest: string }>(
        "SELECT lookup_digest FROM community.user_login_identities WHERE user_id=$1",
        [owner],
      )
    ).rows.map((row) => row.lookup_digest);
    expect(digests).toHaveLength(2);
    // Someone else's unfinished sign-in naming the owner's email holds its
    // ciphertext without any user id.
    await send({
      channel: "email",
      purpose: "sign_in",
      identifier: ownerEmail,
    });
    const appealHash = await hashSessionToken(`appeal-${hex32()}`);
    await db.setup.query(
      `INSERT INTO community.sessions(id,token_hash,user_id,issued_at,expires_at,issuer,auth_environment,auth_channel,scope)
       VALUES($1,$2,$3,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+interval '30 minutes','verified_login','development','email','appeal')`,
      [`session-${hex32()}`, appealHash, owner],
    );
    await db.setup.query(
      "INSERT INTO community.user_password_credentials(user_id,verifier,version,updated_at) VALUES($1,$2,1,CURRENT_TIMESTAMP)",
      [owner, `scrypt-v1$32768$8$3$${"A".repeat(22)}$${"B".repeat(43)}`],
    );
    // Relations in both directions, plus the bystanders' own rows.
    for (const [follower, followed] of [
      [owner, peer],
      [peer, owner],
      [peer, blocker],
    ])
      await db.setup.query(
        "INSERT INTO community.follows(follower_id,followed_id) VALUES($1,$2)",
        [follower, followed],
      );
    for (const [from, to] of [
      [owner, blocker],
      [blocker, owner],
      [watcher, owner],
      [watcher, blocker],
      [peer, blocker],
    ])
      await db.setup.query(
        "INSERT INTO community.blocks(blocker_id,blocked_id) VALUES($1,$2)",
        [from, to],
      );
    const peerWork = `work-${hex32()}`;
    await db.setup.query(
      "INSERT INTO community.works(id,author_id,title,text,first_published_at) VALUES($1,$2,'Synthetic post','Synthetic body',CURRENT_TIMESTAMP)",
      [peerWork, peer],
    );
    for (const [user, relation] of [
      [owner, "like"],
      [owner, "favorite"],
      [peer, "like"],
    ])
      await db.setup.query(
        "INSERT INTO community.content_relations(user_id,content_type,content_id,relation) VALUES($1,'work',$2,$3)",
        [user, peerWork, relation],
      );
    const comments = new PostgresCommunityCommentAdapter(db.app);
    const discussion = { type: "work" as const, id: peerWork };
    const ownerComment = await comments.submitDiscussion(
      discussion,
      owner,
      "合成评论正文",
    );
    // The peer's own comment, which the owner answered.
    const peerComment = await comments.submitDiscussion(
      discussion,
      peer,
      "合成同伴评论",
    );
    const ownerReply = await comments.submitDiscussion(
      discussion,
      owner,
      "合成回复正文",
      peerComment.id,
    );
    for (const user of [owner, peer])
      await db.setup.query(
        "INSERT INTO community.comment_likes(comment_id,user_id) VALUES($1,$2)",
        [ownerComment.id, user],
      );
    for (const user of [owner, peer])
      await db.setup.query(
        "INSERT INTO community.profile_ip_locations(user_id,label) VALUES($1,'Synthetic region')",
        [user],
      );
    await db.setup.query(
      "INSERT INTO community.featured_users(user_id,enabled) VALUES($1,TRUE)",
      [owner],
    );
    const avatar = `user-media-${hex32()}`;
    await db.setup.query(
      "INSERT INTO community.user_media(id,owner_id,mime_type,width,height,sha256,bytes) VALUES($1,$2,'image/png',1,1,$3,$4)",
      [avatar, owner, "a".repeat(64), Buffer.from([1])],
    );
    await db.setup.query(
      "UPDATE community.public_users SET avatar_media_id=$2, background_media_id=$2, bio='Synthetic bio', following_privacy='public' WHERE id=$1",
      [owner, avatar],
    );
    const items: Record<string, string> = {};
    for (const user of [owner, peer]) {
      const item = `media-item-${hex32()}`;
      items[user] = item;
      await db.setup.query(
        "INSERT INTO community.media_items(id,owner_id,kind,quality_mode,source,state,presentation,ready_at) VALUES($1,$2,'static','standard','upload','ready','{\"width\":10,\"height\":10}'::jsonb,CURRENT_TIMESTAMP)",
        [item, user],
      );
      await db.setup.query(
        "INSERT INTO community.media_public_assets(id,item_id,desired_at,created_at,updated_at) VALUES($1,$2,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
        [hex32(), item],
      );
    }
    const desiredSeq = async (user: string) =>
      count(
        "SELECT desired_seq AS n FROM community.media_public_assets WHERE item_id=$1",
        [items[user]],
      );
    const seqBefore = {
      owner: await desiredSeq(owner),
      peer: await desiredSeq(peer),
    };
    const messages = new PostgresDirectMessageAdapter(db.app);
    const opened = await messages.send(peer, {
      requestId: key(),
      recipientId: owner,
      text: "合成私信",
    });
    await messages.send(owner, {
      requestId: key(),
      conversationId: opened.conversationId,
      text: "合成回复",
    });
    expect(
      await count(
        "SELECT count(*) AS n FROM community.auth_receipts WHERE user_id=$1 AND closed_at IS NULL",
        [owner],
      ),
    ).toBeGreaterThan(0);

    const idempotencyKey = key();
    const command = {
      sessionToken: token,
      reauthToken: await reauthenticate(token),
      idempotencyKey,
      expectedAccountId: owner,
    };
    const deleted = await service.deleteAccount(command);
    expect(deleted).toMatchObject({ ok: true, value: { outcome: "deleted" } });
    if (!deleted.ok) return;

    // The anonymized tombstone keeps only its reserved handle.
    expect(await userRow(owner)).toEqual({
      handle: registered.profile.handle,
      status: "deleted",
      display_name: "已注销用户",
      bio: "",
      studio_name: "",
      studio_name_suffix: "",
      avatar_media_id: null,
      background_media_id: null,
      following_privacy: "private",
      followers_privacy: "private",
      favorites_privacy: "private",
      likes_privacy: "private",
    });
    for (const [sql, expected] of [
      [
        "SELECT count(*) AS n FROM community.sessions WHERE user_id=$1 AND revoked_at IS NULL",
        0,
      ],
      [
        "SELECT count(*) AS n FROM community.auth_receipts WHERE user_id=$1 AND closed_at IS NULL",
        0,
      ],
      [
        "SELECT count(*) AS n FROM community.user_login_identities WHERE user_id=$1",
        0,
      ],
      [
        "SELECT count(*) AS n FROM community.user_password_credentials WHERE user_id=$1",
        0,
      ],
      [
        "SELECT count(*) AS n FROM community.follows WHERE follower_id=$1 OR followed_id=$1",
        0,
      ],
      // r3: the blocks the owner set go; the blocks others set against the
      // owner (the blocker's and the watcher's) stay in force.
      ["SELECT count(*) AS n FROM community.blocks WHERE blocker_id=$1", 0],
      ["SELECT count(*) AS n FROM community.blocks WHERE blocked_id=$1", 2],
      [
        "SELECT count(*) AS n FROM community.content_relations WHERE user_id=$1",
        0,
      ],
      ["SELECT count(*) AS n FROM community.comment_likes WHERE user_id=$1", 0],
      [
        "SELECT count(*) AS n FROM community.profile_ip_locations WHERE user_id=$1",
        0,
      ],
      [
        "SELECT count(*) AS n FROM community.featured_users WHERE user_id=$1 AND enabled",
        0,
      ],
      [
        "SELECT count(*) AS n FROM community.auth_audit_events WHERE user_id=$1 AND action='account_delete'",
        1,
      ],
      [
        "SELECT count(*) AS n FROM community.publishing_jobs WHERE kind='purge_deleted_account' AND subject_id=$1 AND state='queued'",
        1,
      ],
    ] as const)
      expect(await count(sql, [owner]), sql).toBe(expected);
    // No challenge or handoff names the owner or holds its contacts.
    expect(
      await count(
        `SELECT (SELECT count(*) FROM community.auth_challenges WHERE user_id=$1 OR target_digest = ANY($2::text[]))
          + (SELECT count(*) FROM community.auth_handoffs WHERE user_id=$1 OR target_digest = ANY($2::text[])) AS n`,
        [owner, digests],
      ),
    ).toBe(0);
    const record = (
      await db.setup.query(
        "SELECT request_key_hash, session_id, deleted_at, purge_state, purge_completed_at FROM community.account_deletions WHERE user_id=$1",
        [owner],
      )
    ).rows[0];
    const observed = (
      await db.setup.query<{ id: string }>(
        "SELECT id FROM community.sessions WHERE token_hash=$1",
        [await hashSessionToken(token)],
      )
    ).rows[0]!;
    expect(record).toMatchObject({
      session_id: observed.id,
      purge_state: "pending",
      purge_completed_at: null,
    });
    expect(record.request_key_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(record.deleted_at.toISOString()).toBe(deleted.value.deletedAt);
    // Public copies are withdrawn for the owner's items only.
    expect(await desiredSeq(owner)).toBe(seqBefore.owner + 1);
    expect(await desiredSeq(peer)).toBe(seqBefore.peer);

    // Signed out everywhere, invisible to everyone else.
    const sessions = new CommunitySessionService(
      new PostgresCommunityIdentityAdapter(db.app),
    );
    expect(await sessions.identify(token)).toBeNull();
    expect(await service.readAccount(token)).toEqual({
      ok: false,
      reason: "AUTH_UNAUTHENTICATED",
    });
    const authors = new PostgresAuthorCommunityAdapter(db.app);
    await expect(authors.readProfile(owner, null)).rejects.toBeInstanceOf(
      CommunityNotFoundError,
    );
    const page = { page: 1, pageSize: 20, search: "", kind: "all" as const };
    const blocked = async (viewer: string) => {
      const listed = await authors.listPeople(viewer, viewer, "blocks", page);
      return { ids: listed.items.map((item) => item.id), total: listed.total };
    };
    // A block against the deleted account stays but is no longer listed or
    // counted in 已屏蔽账户.
    expect(await blocked(blocker)).toEqual({ ids: [], total: 0 });
    expect(await blocked(watcher)).toEqual({ ids: [blocker], total: 1 });
    expect(await blocked(peer)).toEqual({ ids: [blocker], total: 1 });

    // The comment keeps its text under the anonymized name.
    const thread = await comments.readDiscussion(discussion, peer, {
      page: 1,
      pageSize: 20,
    });
    expect(
      [...thread.hot, ...thread.items].find(
        (item) => item.id === ownerComment.id,
      ),
    ).toMatchObject({
      text: "合成评论正文",
      author: { id: owner, displayName: "已注销用户", deleted: true },
    });
    const answered = (read: typeof thread) =>
      [...read.hot, ...read.items].find((item) => item.id === peerComment.id);
    expect(answered(thread)).toMatchObject({
      replyTotal: 1,
      replies: [
        {
          id: ownerReply.id,
          text: "合成回复正文",
          author: { id: owner, displayName: "已注销用户", deleted: true },
        },
      ],
    });
    expect(thread.visibleTotal).toBe(3);
    // r3: whoever blocked the owner still sees none of its retained comments
    // or replies, and no count includes them.
    const shielded = await comments.readDiscussion(discussion, watcher, {
      page: 1,
      pageSize: 20,
    });
    expect([...shielded.hot, ...shielded.items].map((item) => item.id)).toEqual(
      [peerComment.id],
    );
    expect(answered(shielded)).toMatchObject({ replyTotal: 0, replies: [] });
    expect(shielded.visibleTotal).toBe(1);
    expect(
      [...shielded.hot, ...shielded.items].find(
        (item) => item.id === peerComment.id,
      )?.replyPageTotal,
    ).toBe(0);
    expect(
      (
        await comments.readDiscussionReplies(
          discussion,
          peerComment.id,
          watcher,
          { page: 1, pageSize: 20 },
        )
      ).items,
    ).toEqual([]);
    // The counterpart keeps the history and cannot write again.
    const conversation = (
      await messages.listConversations(peer, { pageSize: 20 })
    ).items.find((item) => item.participant.id === owner);
    expect(conversation).toMatchObject({
      participant: { displayName: "已注销用户", available: false },
      canSend: false,
      sendRefusal: "unavailable",
      lastMessage: { senderId: owner, text: "合成回复" },
    });
    expect(
      (
        await messages.readConversation(peer, opened.conversationId, {
          pageSize: 20,
        })
      ).items.map((item) => item.text),
    ).toEqual(["合成回复", "合成私信"]);
    await expect(
      messages.send(peer, {
        requestId: key(),
        conversationId: opened.conversationId,
        text: "合成追问",
      }),
    ).rejects.toBeInstanceOf(CommunityInputError);

    // An exact retry gets the same answer; nothing else does.
    expect(await service.deleteAccount(command)).toEqual(deleted);
    expect(
      await service.deleteAccount({ ...command, idempotencyKey: key() }),
    ).toEqual({ ok: false, reason: "AUTH_UNAUTHENTICATED" });
    expect(
      await count(
        "SELECT count(*) AS n FROM community.account_deletions WHERE user_id=$1",
        [owner],
      ),
    ).toBe(1);

    // Bystanders keep their accounts, contacts and relations.
    for (const [id, session] of [
      [peer, peerSession.token],
      [blocker, blockerSession.token],
    ] as const) {
      expect(await sessions.identify(session)).toMatchObject({ id });
      expect(
        await count(
          "SELECT count(*) AS n FROM community.user_login_identities WHERE user_id=$1",
          [id],
        ),
      ).toBe(1);
    }
    for (const [sql, values] of [
      [
        "SELECT count(*) AS n FROM community.follows WHERE follower_id=$1 AND followed_id=$2",
        [peer, blocker],
      ],
      [
        "SELECT count(*) AS n FROM community.blocks WHERE blocker_id=$1 AND blocked_id=$2",
        [peer, blocker],
      ],
      [
        "SELECT count(*) AS n FROM community.content_relations WHERE user_id=$1 AND content_id=$2",
        [peer, peerWork],
      ],
      [
        "SELECT count(*) AS n FROM community.comment_likes WHERE user_id=$1 AND comment_id=$2",
        [peer, ownerComment.id],
      ],
      [
        "SELECT count(*) AS n FROM community.profile_ip_locations WHERE user_id=$1",
        [peer],
      ],
    ] as const)
      expect(await count(sql, values), sql).toBe(1);
    // Only a deleted account leaves 已屏蔽账户: a suspended one stays listed.
    await db.setup.query(
      "UPDATE community.public_users SET status='suspended' WHERE id=$1",
      [blocker],
    );
    expect(await blocked(watcher)).toEqual({ ids: [blocker], total: 1 });

    // The freed email and phone start new, unrelated accounts.
    const reborn = await register(ownerEmail);
    expect(reborn.profile.id).not.toBe(owner);
    expect(reborn.profile.handle).not.toBe(registered.profile.handle);
    expect(
      await prove({
        channel: "phone",
        purpose: "sign_in",
        identifier: ownerPhone,
      }),
    ).toMatchObject({ outcome: "registration_required" });
  });

  it("deletes once when the same request arrives twice at the same time", async () => {
    const registered = await register("erase-double@example.invalid");
    const owner = registered.profile.id;
    const command = {
      sessionToken: registered.token,
      reauthToken: await reauthenticate(registered.token),
      idempotencyKey: key(),
      expectedAccountId: owner,
    };
    const [left, right] = await Promise.all([
      service.deleteAccount(command),
      service.deleteAccount(command),
    ]);
    expect(left).toMatchObject({ ok: true });
    expect(right).toEqual(left);
    for (const sql of [
      "SELECT count(*) AS n FROM community.account_deletions WHERE user_id=$1",
      "SELECT count(*) AS n FROM community.publishing_jobs WHERE kind='purge_deleted_account' AND subject_id=$1",
      "SELECT count(*) AS n FROM community.auth_audit_events WHERE user_id=$1 AND action='account_delete'",
    ])
      expect(await count(sql, [owner]), sql).toBe(1);
  });

  it("leaves an interrupted request untouched and retryable", async () => {
    const registered = await register("erase-interrupted@example.invalid");
    const owner = registered.profile.id as PublicUserId;
    const adapter = new PostgresCommunityAuthAdapter(db.app);
    // The last statement of the deletion fails, as a lost connection would.
    const interrupted = serviceOver({
      transaction: (work) =>
        adapter.transaction((tx) =>
          work({
            ...tx,
            insertAudit: async (row) => {
              if (row.action === "account_delete")
                throw new Error("synthetic interruption");
              await tx.insertAudit(row);
            },
          }),
        ),
    });
    const command = {
      sessionToken: registered.token,
      reauthToken: await reauthenticate(registered.token),
      idempotencyKey: key(),
      expectedAccountId: owner,
    };
    await expect(interrupted.deleteAccount(command)).rejects.toThrow(
      "synthetic interruption",
    );
    expect(await userRow(owner)).toMatchObject({
      status: "active",
      display_name: "Synthetic owner",
    });
    for (const [sql, expected] of [
      [
        "SELECT count(*) AS n FROM community.user_login_identities WHERE user_id=$1",
        1,
      ],
      [
        "SELECT count(*) AS n FROM community.sessions WHERE user_id=$1 AND revoked_at IS NULL",
        1,
      ],
      [
        "SELECT count(*) AS n FROM community.auth_handoffs WHERE user_id=$1 AND purpose='reauth' AND consumed_at IS NULL",
        1,
      ],
      [
        "SELECT count(*) AS n FROM community.account_deletions WHERE user_id=$1",
        0,
      ],
      [
        "SELECT count(*) AS n FROM community.publishing_jobs WHERE subject_id=$1",
        0,
      ],
    ] as const)
      expect(await count(sql, [owner]), sql).toBe(expected);
    expect(await service.readAccount(registered.token)).toMatchObject({
      ok: true,
    });
    expect(await service.deleteAccount(command)).toMatchObject({
      ok: true,
      value: { outcome: "deleted" },
    });
    expect((await userRow(owner)).status).toBe("deleted");
  });

  it("refuses a suspended account and a foreign confirmed account without writing", async () => {
    const registered = await register("erase-refused@example.invalid");
    const other = await register("erase-refused-other@example.invalid");
    const owner = registered.profile.id;
    const reauthToken = await reauthenticate(registered.token);
    expect(
      await service.deleteAccount({
        sessionToken: registered.token,
        reauthToken,
        idempotencyKey: key(),
        expectedAccountId: other.profile.id,
      }),
    ).toEqual({ ok: false, reason: "AUTH_UNAUTHENTICATED" });
    await db.setup.query(
      "UPDATE community.public_users SET status='suspended' WHERE id=$1",
      [owner],
    );
    expect(
      await service.deleteAccount({
        sessionToken: registered.token,
        reauthToken,
        idempotencyKey: key(),
        expectedAccountId: owner,
      }),
    ).toEqual({ ok: false, reason: "AUTH_ACCOUNT_SUSPENDED" });
    expect((await userRow(owner)).status).toBe("suspended");
    for (const [sql, expected] of [
      [
        "SELECT count(*) AS n FROM community.user_login_identities WHERE user_id=$1",
        1,
      ],
      [
        "SELECT count(*) AS n FROM community.auth_handoffs WHERE user_id=$1 AND purpose='reauth' AND consumed_at IS NULL",
        1,
      ],
      [
        "SELECT count(*) AS n FROM community.account_deletions WHERE user_id=$1",
        0,
      ],
    ] as const)
      expect(await count(sql, [owner]), sql).toBe(expected);
  });
});
