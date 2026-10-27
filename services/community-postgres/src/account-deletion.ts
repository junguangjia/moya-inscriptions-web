import { insertJob } from "./publishing/jobs.js";
import { requestOwnerPublicationSync } from "./publishing/publication-sync.js";

import type { PoolClient } from "pg";

/*
 * account-deletion-v1 (Issue #351 r3): the erasure statements of one account
 * deletion, run by PostgresCommunityAuthAdapter inside the auth transaction
 * that already holds the account's row lock and has revoked its Sessions,
 * closed its receipts and invalidated its proofs. The public_users row stays
 * as an anonymized tombstone (migration 20261027010000 makes `deleted`
 * terminal); comments, replies and direct messages keep their text for the
 * other participants and show the anonymized name. Works, drafts and media
 * are erased later by the queued `purge_deleted_account` job, which resumes
 * after an interruption. Every statement is an App-role grant.
 */

/** The account's current contact digests: auth history naming them goes too. */
const contactDigestsSql =
  "SELECT lookup_digest FROM community.user_login_identities WHERE user_id=$1";

export const findAccountDeletionSql =
  "SELECT user_id, request_key_hash, session_id, deleted_at FROM community.account_deletions WHERE user_id=$1";

export interface AccountDeletionRow {
  readonly user_id: string;
  readonly request_key_hash: string;
  readonly session_id: string;
  readonly deleted_at: Date;
}

export interface AccountErasure {
  readonly userId: string;
  readonly atIso: string;
  readonly displayName: string;
  readonly requestKeyHash: string;
  readonly sessionId: string;
}

/**
 * Statement order matters: the status moves first, because only a deleted
 * account may lose its last login identity, and the contact digests are read
 * through the identities before those rows go.
 */
export const eraseAccount = async (
  client: PoolClient,
  input: AccountErasure,
): Promise<void> => {
  const { userId, atIso } = input;
  // Most private visibility for every list; the handle stays reserved and is
  // never shown again. Avatar and background bytes are tombstoned by the
  // background purge once nothing points at them.
  const ended = await client.query(
    `UPDATE community.public_users SET status='deleted', display_name=$2, bio='',
       studio_name='', studio_name_suffix='', avatar_media_id=NULL, background_media_id=NULL,
       following_privacy='private', followers_privacy='private',
       favorites_privacy='private', likes_privacy='private', updated_at=$3
     WHERE id=$1 AND status='active'`,
    [userId, input.displayName, atIso],
  );
  if (ended.rowCount !== 1) throw new Error("Account is not active");
  // Every phone and email is free for an unrelated registration, and no
  // ciphertext of them stays in this account's challenges or handoffs.
  for (const table of ["auth_challenges", "auth_handoffs"])
    await client.query(
      `DELETE FROM community.${table} WHERE user_id=$1 OR target_digest IN (${contactDigestsSql})`,
      [userId],
    );
  await client.query(
    "DELETE FROM community.user_login_identities WHERE user_id=$1",
    [userId],
  );
  await client.query(
    "DELETE FROM community.user_password_credentials WHERE user_id=$1",
    [userId],
  );
  // The account's own relations: follows in both directions and the blocks
  // it set. Blocks other users set against it stay in force (r3), so its
  // retained comments and replies stay hidden from them; their 已屏蔽账户
  // lists no longer show it. Other users' likes and favorites of its works
  // are theirs and resolve to nothing once the works are gone, as for any
  // deleted work. Another user's follow or block that waits on this row lock
  // reads the account again afterwards and is refused; the background purge
  // still removes these relations once more as a safeguard.
  await client.query(
    "DELETE FROM community.follows WHERE follower_id=$1 OR followed_id=$1",
    [userId],
  );
  await client.query("DELETE FROM community.blocks WHERE blocker_id=$1", [
    userId,
  ]);
  for (const table of [
    "content_relations",
    "comment_likes",
    "profile_ip_locations",
  ])
    await client.query(`DELETE FROM community.${table} WHERE user_id=$1`, [
      userId,
    ]);
  // An operator recommendation is withdrawn; Admin cannot renew it.
  await client.query(
    "UPDATE community.featured_users SET enabled=FALSE, version=version+1 WHERE user_id=$1 AND enabled",
    [userId],
  );
  await client.query(
    "INSERT INTO community.account_deletions(user_id, request_key_hash, session_id, deleted_at) VALUES($1,$2,$3,$4)",
    [userId, input.requestKeyHash, input.sessionId, atIso],
  );
  const at = new Date(atIso);
  // Public copies are withdrawn now, exactly as a suspension withdraws them;
  // a withdrawal needs neither publish gate.
  await requestOwnerPublicationSync(client, userId, "withdraw", at);
  await insertJob(
    client,
    { kind: "purge_deleted_account", subjectId: userId },
    at,
  );
};
