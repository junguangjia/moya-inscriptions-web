import { asCommunityOperationError } from "./availability.js";

import type {
  AuthChannelName,
  AuthPurposeName,
  AuthUnitOfWork,
  CommunityAuthPort,
  StoredChallenge,
  StoredHandoff,
  StoredIdentity,
  StoredSession,
  StoredUser,
  VerificationMode,
  AuthEnvironmentName,
  StoredPasswordCredential,
  StoredPasswordResetReceipt,
} from "@moya/api";
import type { Pool, PoolClient } from "pg";

const persistenceKind = (
  error: unknown,
): "conflict" | "last_factor" | "attempts" | null => {
  if (typeof error !== "object" || error === null || !("code" in error))
    return null;
  const code = String(error.code);
  const message = "message" in error ? String(error.message) : "";
  const constraint = "constraint" in error ? String(error.constraint) : "";
  if (
    code === "23514" &&
    (constraint === "auth_challenges_attempts_bounded" ||
      message.includes("auth_challenges_attempts_bounded"))
  )
    return "attempts";
  if (code === "23514" && message.includes("last login identity"))
    return "last_factor";
  if (
    code === "23505" ||
    (code === "23514" && message.includes("mixed login")) ||
    (code === "23P01" &&
      constraint === "user_login_identities_one_lookup_key_version")
  )
    return "conflict";
  return null;
};

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const nullableIso = (value: Date | string | null): string | null =>
  value === null ? null : iso(value);

interface IdentityRow {
  id: string;
  user_id: string;
  kind: AuthChannelName;
  lookup_digest: string;
  ciphertext: string;
  lookup_key_version: number;
  verification_mode: VerificationMode;
  environment: AuthEnvironmentName;
  version: number;
  verified_at: Date;
}

interface ChallengeRow {
  id: string;
  channel: AuthChannelName;
  purpose: AuthPurposeName;
  target_digest: string;
  ciphertext: string;
  code_verifier: string | null;
  verification_strategy: StoredChallenge["strategy"];
  provider_mode: VerificationMode;
  environment: AuthEnvironmentName;
  user_id: string | null;
  session_hash: string | null;
  continuation_hash: string;
  expected_version: number | null;
  identity_id: string | null;
  credential_version: number | null;
  reauth_hash: string | null;
  provider_correlation: string | null;
  expires_at: Date;
  attempts: number;
  resend_available_at: Date;
  superseded_at: Date | null;
  completed_at: Date | null;
  invalidated_at: Date | null;
  delivery_state: StoredChallenge["deliveryState"];
  idempotency_hash: string;
  created_at: Date;
}

const mapIdentity = (row: IdentityRow): StoredIdentity => ({
  id: row.id,
  userId: row.user_id,
  kind: row.kind,
  lookupDigest: row.lookup_digest,
  ciphertext: row.ciphertext,
  lookupKeyVersion: row.lookup_key_version,
  verificationMode: row.verification_mode,
  environment: row.environment,
  version: row.version,
  verifiedAt: iso(row.verified_at),
});

const mapChallenge = (row: ChallengeRow): StoredChallenge => ({
  id: row.id,
  channel: row.channel,
  purpose: row.purpose,
  targetDigest: row.target_digest,
  ciphertext: row.ciphertext,
  verifier: row.code_verifier,
  strategy: row.verification_strategy,
  providerMode: row.provider_mode,
  environment: row.environment,
  userId: row.user_id,
  sessionHash: row.session_hash,
  continuationHash: row.continuation_hash,
  expectedVersion: row.expected_version,
  identityId: row.identity_id,
  credentialVersion: row.credential_version,
  reauthHash: row.reauth_hash,
  providerCorrelation: row.provider_correlation,
  expiresAt: iso(row.expires_at),
  attempts: row.attempts,
  resendAvailableAt: iso(row.resend_available_at),
  supersededAt: nullableIso(row.superseded_at),
  completedAt: nullableIso(row.completed_at),
  invalidatedAt: nullableIso(row.invalidated_at),
  deliveryState: row.delivery_state,
  idempotencyHash: row.idempotency_hash,
  createdAt: iso(row.created_at),
});

interface ReceiptRow {
  key_hash: string;
  user_id: string;
  session_id: string;
  session_token_hash: string;
  purpose: string;
  origin_session_id: string;
  closed_at: Date | null;
  payload_hash: string | null;
  credential_version: number | null;
}

const receiptSelect =
  "SELECT key_hash, user_id, session_id, session_token_hash, purpose, origin_session_id, closed_at, payload_hash, credential_version FROM community.auth_receipts";

const mapReceipt = (row: ReceiptRow) => ({
  keyHash: row.key_hash,
  userId: row.user_id,
  sessionId: row.session_id,
  sessionTokenHash: row.session_token_hash,
  purpose: row.purpose,
  originSessionId: row.origin_session_id,
  closedAt: nullableIso(row.closed_at),
  payloadHash: row.payload_hash,
  credentialVersion: row.credential_version,
});

const mapHandoff = (row: {
  id: string;
  token_hash: string;
  purpose: StoredHandoff["purpose"];
  channel: AuthChannelName;
  target_digest: string;
  ciphertext: string;
  provider_mode: VerificationMode;
  environment: AuthEnvironmentName;
  user_id: string | null;
  session_hash: string | null;
  expected_version: number | null;
  identity_id: string | null;
  credential_version: number | null;
  expires_at: Date;
  consumed_at: Date | null;
}): StoredHandoff => ({
  id: row.id,
  tokenHash: row.token_hash,
  purpose: row.purpose,
  channel: row.channel,
  targetDigest: row.target_digest,
  ciphertext: row.ciphertext,
  providerMode: row.provider_mode,
  environment: row.environment,
  userId: row.user_id,
  sessionHash: row.session_hash,
  expectedVersion: row.expected_version,
  identityId: row.identity_id,
  credentialVersion: row.credential_version,
  expiresAt: iso(row.expires_at),
  consumedAt: nullableIso(row.consumed_at),
});

/** App-role adapter. Business rules stay in CommunityAuthService. */
export class PostgresCommunityAuthAdapter implements CommunityAuthPort {
  constructor(private readonly pool: Pool) {}

  async transaction<T>(work: (tx: AuthUnitOfWork) => Promise<T>): Promise<T> {
    const client = await this.connect();
    try {
      await client.query("BEGIN");
      const value = await work(this.unit(client));
      await client.query("COMMIT");
      return value;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original failure.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async connect(): Promise<PoolClient> {
    try {
      return await this.pool.connect();
    } catch (error) {
      throw asCommunityOperationError(error, "connect");
    }
  }

  private unit(client: PoolClient): AuthUnitOfWork {
    const query = async <Row>(
      sql: string,
      values: readonly unknown[] = [],
    ): Promise<Row[]> => {
      try {
        const result = await client.query(sql, [...values]);
        return result.rows as Row[];
      } catch (error) {
        const kind = persistenceKind(error);
        if (kind !== null) throw Object.assign(new Error(kind), { kind });
        throw asCommunityOperationError(error, "query");
      }
    };
    const catchKind = async <T>(
      run: () => Promise<T>,
    ): Promise<T | "conflict" | "last_factor"> => {
      try {
        return await run();
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "kind" in error &&
          (error.kind === "conflict" || error.kind === "last_factor")
        )
          return error.kind;
        throw error;
      }
    };
    return {
      findUser: async (id) => {
        const rows = await query<
          StoredUser & {
            display_name: string;
            studio_name: string;
            studio_name_suffix: string;
            status: StoredUser["status"];
          }
        >(
          "SELECT id, handle, display_name, studio_name, studio_name_suffix, status FROM community.public_users WHERE id=$1",
          [id],
        );
        const row = rows[0];
        return row === undefined
          ? null
          : {
              id: row.id,
              handle: row.handle,
              displayName: row.display_name,
              studioName: row.studio_name,
              studioNameSuffix: row.studio_name_suffix,
              status: row.status,
            };
      },
      findIdentity: async (kind, digest) => {
        const rows = await query<IdentityRow>(
          "SELECT * FROM community.user_login_identities WHERE kind=$1 AND lookup_digest=$2",
          [kind, digest],
        );
        const row = rows[0];
        return row === undefined ? null : mapIdentity(row);
      },
      listIdentities: async (userId) =>
        (
          await query<IdentityRow>(
            "SELECT * FROM community.user_login_identities WHERE user_id=$1",
            [userId],
          )
        ).map(mapIdentity),
      insertUser: async (user) => {
        const outcome = await catchKind(async () => {
          await query(
            "INSERT INTO community.public_users(id, handle, display_name, studio_name, studio_name_suffix) VALUES($1,$2,$3,$4,$5)",
            [
              user.id,
              user.handle,
              user.displayName,
              user.studioName ?? "",
              user.studioNameSuffix ?? "",
            ],
          );
          return "ok" as const;
        });
        return outcome === "ok" ? "ok" : "handle_conflict";
      },
      insertIdentity: async (row) => {
        const outcome = await catchKind(async () => {
          await query(
            `INSERT INTO community.user_login_identities(
              id, user_id, kind, lookup_digest, ciphertext, lookup_key_version,
              verification_mode, environment, version, verified_at
            ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [
              row.id,
              row.userId,
              row.kind,
              row.lookupDigest,
              row.ciphertext,
              row.lookupKeyVersion,
              row.verificationMode,
              row.environment,
              row.version,
              row.verifiedAt,
            ],
          );
          return "ok" as const;
        });
        return outcome === "last_factor" ? "conflict" : outcome;
      },
      replaceIdentity: async (row, expectedVersion) => {
        const outcome = await catchKind(async () => {
          const rows = await query<{ version: number }>(
            `UPDATE community.user_login_identities
             SET lookup_digest=$1, ciphertext=$2, lookup_key_version=$3,
                 version=version+1, verified_at=$4, updated_at=$5
             WHERE user_id=$6 AND kind=$7 AND version=$8
             RETURNING version`,
            [
              row.lookupDigest,
              row.ciphertext,
              row.lookupKeyVersion,
              row.verifiedAt,
              row.verifiedAt,
              row.userId,
              row.kind,
              expectedVersion,
            ],
          );
          return rows.length === 0 ? ("stale" as const) : ("ok" as const);
        });
        return outcome === "last_factor" ? "conflict" : outcome;
      },
      deleteIdentity: async (userId, kind, expectedVersion) => {
        const outcome = await catchKind(async () => {
          const rows = await query<{ id: string }>(
            `DELETE FROM community.user_login_identities
             WHERE user_id=$1 AND kind=$2 AND version=$3
             RETURNING id`,
            [userId, kind, expectedVersion],
          );
          if (rows.length > 0) return "ok" as const;
          const existing = await query<{ version: number }>(
            "SELECT version FROM community.user_login_identities WHERE user_id=$1 AND kind=$2",
            [userId, kind],
          );
          return existing.length === 0
            ? ("missing" as const)
            : ("stale" as const);
        });
        return outcome === "conflict" ? "stale" : outcome;
      },
      lockUser: async (userId) => {
        const rows = await query<{
          id: string;
          handle: string;
          display_name: string;
          studio_name: string;
          studio_name_suffix: string;
          status: StoredUser["status"];
        }>(
          "SELECT id, handle, display_name, studio_name, studio_name_suffix, status FROM community.public_users WHERE id=$1 FOR UPDATE",
          [userId],
        );
        const row = rows[0];
        return row === undefined
          ? null
          : {
              id: row.id,
              handle: row.handle,
              displayName: row.display_name,
              studioName: row.studio_name,
              studioNameSuffix: row.studio_name_suffix,
              status: row.status,
            };
      },
      lockDigest: async (digest) => {
        await query("SELECT pg_advisory_xact_lock(hashtext($1::text))", [
          digest,
        ]);
      },
      insertChallenge: async (row) => {
        const outcome = await catchKind(async () => {
          await query(
            `INSERT INTO community.auth_challenges(
              id, channel, purpose, target_digest, ciphertext, code_verifier,
              verification_strategy, provider_mode, environment, user_id, session_hash,
              continuation_hash, expected_version, reauth_hash, provider_correlation,
              expires_at, attempts, resend_available_at, superseded_at, completed_at,
              invalidated_at, delivery_state, idempotency_hash, created_at, identity_id, credential_version
            ) VALUES(
              $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26
            )`,
            [
              row.id,
              row.channel,
              row.purpose,
              row.targetDigest,
              row.ciphertext,
              row.verifier,
              row.strategy,
              row.providerMode,
              row.environment,
              row.userId,
              row.sessionHash,
              row.continuationHash,
              row.expectedVersion,
              row.reauthHash,
              row.providerCorrelation,
              row.expiresAt,
              row.attempts,
              row.resendAvailableAt,
              row.supersededAt,
              row.completedAt,
              row.invalidatedAt,
              row.deliveryState,
              row.idempotencyHash,
              row.createdAt,
              row.identityId ?? null,
              row.credentialVersion ?? null,
            ],
          );
          return "ok" as const;
        });
        return outcome === "ok" ? "ok" : "conflict";
      },
      findChallenge: async (id) => {
        const rows = await query<ChallengeRow>(
          "SELECT * FROM community.auth_challenges WHERE id=$1",
          [id],
        );
        const row = rows[0];
        return row === undefined ? null : mapChallenge(row);
      },
      findChallengeByIdempotency: async (hash) => {
        const rows = await query<ChallengeRow>(
          "SELECT * FROM community.auth_challenges WHERE idempotency_hash=$1",
          [hash],
        );
        const row = rows[0];
        return row === undefined ? null : mapChallenge(row);
      },
      saveChallenge: async (row) => {
        await query(
          `UPDATE community.auth_challenges SET
            attempts=$2, resend_available_at=$3, superseded_at=coalesce(superseded_at,$4), completed_at=coalesce(completed_at,$5),
            invalidated_at=coalesce(invalidated_at,$6), delivery_state=$7, provider_correlation=$8
           WHERE id=$1`,
          [
            row.id,
            row.attempts,
            row.resendAvailableAt,
            row.supersededAt,
            row.completedAt,
            row.invalidatedAt,
            row.deliveryState,
            row.providerCorrelation,
          ],
        );
      },
      openChallenge: async (filter) => {
        const rows = await query<ChallengeRow>(
          `SELECT * FROM community.auth_challenges
           WHERE channel=$1 AND purpose=$2 AND target_digest=$3
             AND superseded_at IS NULL AND completed_at IS NULL AND invalidated_at IS NULL
             AND delivery_state IN ('pending','accepted')
           ORDER BY created_at DESC LIMIT 1`,
          [filter.channel, filter.purpose, filter.targetDigest],
        );
        const row = rows[0];
        return row === undefined ? null : mapChallenge(row);
      },
      failureCount: async (digest, purpose, sinceIso) => {
        const rows = await query<{ count: string }>(
          `SELECT count(*)::text AS count FROM community.auth_target_failures
           WHERE target_digest=$1 AND purpose=$2 AND failed_at >= $3`,
          [digest, purpose, sinceIso],
        );
        return Number(rows[0]?.count ?? 0);
      },
      addFailure: async (digest, purpose, atIso) => {
        await query(
          "INSERT INTO community.auth_target_failures(target_digest, purpose, failed_at) VALUES($1,$2,$3)",
          [digest, purpose, atIso],
        );
        const rows = await query<{ count: string }>(
          "SELECT count(*)::text AS count FROM community.auth_target_failures WHERE target_digest=$1 AND purpose=$2",
          [digest, purpose],
        );
        return Number(rows[0]?.count ?? 0);
      },
      sendCount: async (scope, key, sinceIso) => {
        const rows = await query<{ count: string }>(
          `SELECT coalesce(sum(count),0)::text AS count FROM community.auth_send_counters
           WHERE scope=$1 AND bucket_key=$2 AND window_start >= $3`,
          [scope, key, sinceIso],
        );
        return Number(rows[0]?.count ?? 0);
      },
      addSend: async (scope, key, atIso) => {
        await query(
          `INSERT INTO community.auth_send_counters(scope, bucket_key, window_start, count)
           VALUES($1,$2,date_trunc('minute',$3::timestamptz),1)
           ON CONFLICT (scope, bucket_key, window_start)
           DO UPDATE SET count = community.auth_send_counters.count + 1`,
          [scope, key, atIso],
        );
      },
      insertHandoff: async (row) => {
        await query(
          `INSERT INTO community.auth_handoffs(
            id, token_hash, purpose, channel, target_digest, ciphertext, provider_mode,
            environment, user_id, session_hash, expected_version, expires_at, consumed_at, identity_id, credential_version
          ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [
            row.id,
            row.tokenHash,
            row.purpose,
            row.channel,
            row.targetDigest,
            row.ciphertext,
            row.providerMode,
            row.environment,
            row.userId,
            row.sessionHash,
            row.expectedVersion,
            row.expiresAt,
            row.consumedAt,
            row.identityId ?? null,
            row.credentialVersion ?? null,
          ],
        );
      },
      findHandoff: async (tokenHash) => {
        const rows = await query<Parameters<typeof mapHandoff>[0]>(
          "SELECT * FROM community.auth_handoffs WHERE token_hash=$1",
          [tokenHash],
        );
        const row = rows[0];
        return row === undefined ? null : mapHandoff(row);
      },
      consumeHandoff: async (id, atIso) => {
        const rows = await query<{ id: string }>(
          `UPDATE community.auth_handoffs SET consumed_at=$2
           WHERE id=$1 AND consumed_at IS NULL RETURNING id`,
          [id, atIso],
        );
        if (rows.length > 0) return "ok";
        const existing = await query<{ consumed_at: Date | null }>(
          "SELECT consumed_at FROM community.auth_handoffs WHERE id=$1",
          [id],
        );
        return existing.length === 0 ? "missing" : "consumed";
      },
      insertReceipt: async (row) => {
        const outcome = await catchKind(async () => {
          await query(
            `INSERT INTO community.auth_receipts(
              key_hash, user_id, session_id, session_token_hash, purpose,
              created_at, origin_session_id, payload_hash, credential_version
            ) VALUES($1,$2,$3,$4,$5,CURRENT_TIMESTAMP,$6,$7,$8)`,
            [
              row.keyHash,
              row.userId,
              row.sessionId,
              row.sessionTokenHash,
              row.purpose,
              row.originSessionId,
              row.payloadHash ?? null,
              row.credentialVersion ?? null,
            ],
          );
          return "ok" as const;
        });
        return outcome === "ok" ? "ok" : "conflict";
      },
      findReceipt: async (keyHash) => {
        const rows = await query<ReceiptRow>(
          `${receiptSelect} WHERE key_hash=$1`,
          [keyHash],
        );
        const row = rows[0];
        return row === undefined ? null : mapReceipt(row);
      },
      lockSession: async (tokenHash) => {
        const rows = await query<{
          id: string;
          token_hash: string;
          user_id: string;
          expires_at: Date;
          revoked_at: Date | null;
        }>(
          `SELECT id, token_hash, user_id, expires_at, revoked_at
           FROM community.sessions WHERE token_hash=$1 FOR UPDATE`,
          [tokenHash],
        );
        const row = rows[0];
        return row === undefined
          ? null
          : {
              id: row.id,
              tokenHash: row.token_hash,
              userId: row.user_id,
              expiresAt: iso(row.expires_at),
              revokedAt: nullableIso(row.revoked_at),
            };
      },
      lockReceipt: async (keyHash) => {
        const rows = await query<ReceiptRow>(
          `${receiptSelect} WHERE key_hash=$1 FOR UPDATE`,
          [keyHash],
        );
        const row = rows[0];
        return row === undefined ? null : mapReceipt(row);
      },
      lockReceiptsForSession: async (sessionId) =>
        (
          await query<ReceiptRow>(
            `${receiptSelect} WHERE origin_session_id=$1 OR session_id=$1 FOR UPDATE`,
            [sessionId],
          )
        ).map(mapReceipt),
      closeReceipt: async (keyHash, atIso) => {
        await query(
          `UPDATE community.auth_receipts SET closed_at=$2
           WHERE key_hash=$1 AND closed_at IS NULL`,
          [keyHash, atIso],
        );
      },
      updateReceiptSession: async (keyHash, sessionId, sessionTokenHash) => {
        await query(
          "UPDATE community.auth_receipts SET session_id=$2, session_token_hash=$3 WHERE key_hash=$1",
          [keyHash, sessionId, sessionTokenHash],
        );
      },
      insertSession: async (row: StoredSession) => {
        await query(
          `INSERT INTO community.sessions(
            id, token_hash, user_id, issued_at, expires_at, issuer, auth_environment, auth_channel
          ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            row.id,
            row.tokenHash,
            row.userId,
            row.issuedAt,
            row.expiresAt,
            row.issuer,
            row.authEnvironment,
            row.authChannel,
          ],
        );
      },
      revokeSession: async (tokenHash, atIso) => {
        const rows = await query<{ id: string }>(
          `UPDATE community.sessions SET revoked_at=$2
           WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at > $2
           RETURNING id`,
          [tokenHash, atIso],
        );
        return rows.length > 0;
      },
      revokeOtherSessions: async (userId, exceptTokenHash, atIso) => {
        await query(
          `UPDATE community.sessions SET revoked_at=$3
           WHERE user_id=$1 AND token_hash <> $2 AND revoked_at IS NULL`,
          [userId, exceptTokenHash, atIso],
        );
      },
      invalidateUserProofs: async (userId, atIso) => {
        await query(
          `UPDATE community.auth_challenges SET invalidated_at=$2
           WHERE user_id=$1 AND completed_at IS NULL AND invalidated_at IS NULL`,
          [userId, atIso],
        );
        await query(
          `UPDATE community.auth_handoffs SET consumed_at=$2
           WHERE user_id=$1 AND consumed_at IS NULL`,
          [userId, atIso],
        );
      },
      invalidatePasswordResetProofs: async (id, at) => {
        await query(
          `UPDATE community.auth_challenges SET invalidated_at=$2 WHERE
          (user_id=$1 OR target_digest IN (SELECT lookup_digest FROM community.user_login_identities WHERE user_id=$1))
          AND completed_at IS NULL AND invalidated_at IS NULL`,
          [id, at],
        );
        await query(
          `UPDATE community.auth_handoffs SET consumed_at=$2 WHERE
          (user_id=$1 OR target_digest IN (SELECT lookup_digest FROM community.user_login_identities WHERE user_id=$1))
          AND consumed_at IS NULL`,
          [id, at],
        );
      },
      insertAudit: async (row) => {
        await query(
          "INSERT INTO community.auth_audit_events(id, user_id, action, occurred_at) VALUES($1,$2,$3,$4)",
          [row.id, row.userId, row.action, row.atIso],
        );
      },
      findSessionUser: async (tokenHash, atIso) => {
        const rows = await query<{
          id: string;
          handle: string;
          display_name: string;
          studio_name: string;
          studio_name_suffix: string;
          status: StoredUser["status"];
        }>(
          `SELECT u.id, u.handle, u.display_name, u.studio_name, u.studio_name_suffix, u.status
           FROM community.sessions s
           JOIN community.public_users u ON u.id = s.user_id
           WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at > $2`,
          [tokenHash, atIso],
        );
        const row = rows[0];
        return row === undefined
          ? null
          : {
              id: row.id,
              handle: row.handle,
              displayName: row.display_name,
              studioName: row.studio_name,
              studioNameSuffix: row.studio_name_suffix,
              status: row.status,
            };
      },
      hasOpenFactorChange: async (userId, channel) => {
        const rows = await query<{ id: string }>(
          `SELECT id FROM community.auth_challenges
           WHERE user_id=$1 AND channel=$2 AND purpose IN ('link','replace')
             AND superseded_at IS NULL AND completed_at IS NULL AND invalidated_at IS NULL
             AND delivery_state IN ('pending','accepted')
           LIMIT 1`,
          [userId, channel],
        );
        return rows.length > 0;
      },
      findPasswordCredential: async (id) => {
        const [row] = await query<{
          user_id: string;
          verifier: string;
          version: number;
          updated_at: Date;
        }>(
          "SELECT user_id, verifier, version, updated_at FROM community.user_password_credentials WHERE user_id=$1",
          [id],
        );
        return row
          ? {
              userId: row.user_id,
              verifier: row.verifier,
              version: row.version,
              updatedAt: iso(row.updated_at),
            }
          : null;
      },
      savePasswordCredential: async (
        row: StoredPasswordCredential,
        expected,
      ) => {
        const rows =
          expected === null
            ? await query<{ user_id: string }>(
                "INSERT INTO community.user_password_credentials(user_id,verifier,version,updated_at) VALUES($1,$2,$3,$4) ON CONFLICT (user_id) DO NOTHING RETURNING user_id",
                [row.userId, row.verifier, row.version, row.updatedAt],
              )
            : await query<{ user_id: string }>(
                "UPDATE community.user_password_credentials SET verifier=$2,version=$3,updated_at=$4 WHERE user_id=$1 AND version=$5 RETURNING user_id",
                [
                  row.userId,
                  row.verifier,
                  row.version,
                  row.updatedAt,
                  expected,
                ],
              );
        return rows.length ? "ok" : "stale";
      },
      findPasswordResetReceipt: async (key) => {
        const [row] = await query<{
          key_hash: string;
          user_id: string;
          payload_hash: string;
          credential_version: number;
          closed_at: Date | null;
        }>(
          "SELECT key_hash,user_id,payload_hash,credential_version,closed_at FROM community.auth_password_reset_receipts WHERE key_hash=$1",
          [key],
        );
        return row
          ? {
              keyHash: row.key_hash,
              userId: row.user_id,
              payloadHash: row.payload_hash,
              credentialVersion: row.credential_version,
              closedAt: nullableIso(row.closed_at),
            }
          : null;
      },
      insertPasswordResetReceipt: async (row: StoredPasswordResetReceipt) => {
        const rows = await query<{ key_hash: string }>(
          "INSERT INTO community.auth_password_reset_receipts(key_hash,user_id,payload_hash,credential_version) VALUES($1,$2,$3,$4) ON CONFLICT (key_hash) DO NOTHING RETURNING key_hash",
          [row.keyHash, row.userId, row.payloadHash, row.credentialVersion],
        );
        return rows.length ? "ok" : "conflict";
      },
      revokeAllSessions: async (id, at) => {
        await query(
          "UPDATE community.sessions SET revoked_at=$2 WHERE user_id=$1 AND revoked_at IS NULL",
          [id, at],
        );
      },
      closeUserReceipts: async (id, at) => {
        await query(
          "UPDATE community.auth_receipts SET closed_at=$2 WHERE user_id=$1 AND closed_at IS NULL",
          [id, at],
        );
        await query(
          "UPDATE community.auth_password_reset_receipts SET closed_at=$2 WHERE user_id=$1 AND closed_at IS NULL",
          [id, at],
        );
      },
      countUsers: async () => {
        const rows = await query<{ count: string }>(
          "SELECT count(*)::text AS count FROM community.public_users",
        );
        return Number(rows[0]?.count ?? 0);
      },
    };
  }
}
