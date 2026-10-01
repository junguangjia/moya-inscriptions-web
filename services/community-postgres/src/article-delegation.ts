import {
  CommunityConflictError,
  CommunityInputError,
  CommunityNotFoundError,
  generateSessionToken,
  hashSessionToken,
  generateOpaqueId,
} from "@moya/api";
import { articleApprovalResultSchema } from "@moya/contracts/schemas";
import type {
  ArticleAuthoringScope,
  PublicUserId,
  ArticleApprovalCandidate,
  ArticleApprovalResult,
  ArticleCandidateApprovalSubmission,
} from "@moya/contracts";
import type { ArticleDelegationActor } from "@moya/api";
import type { Pool, PoolClient } from "pg";
import { actorTransaction } from "./publishing/db.js";

export type { ArticleDelegationActor } from "@moya/api";

export interface ArticleDelegationAuthority {
  readonly issuer: string;
  readonly resource: string;
  readonly environment: "development";
}

interface AuthorityRow {
  id: string;
  owner_id: PublicUserId;
  client_id: string;
  environment: "development";
  generation: string;
  status: "authorized" | "revoked";
  current_grant_id: string | null;
  grant_id: string;
  grant_generation: string;
  human_subject: PublicUserId;
  oauth_client_id: string;
  issuer: string;
  resource: string;
  scopes: ArticleAuthoringScope[];
  consented_at: Date;
  revoked_at: Date | null;
}

const authoritySelect = `SELECT c.id,c.owner_id,c.client_id,c.environment,c.generation,
  c.status,c.current_grant_id,c.revoked_at,g.grant_id,g.generation AS grant_generation,
  g.human_subject,g.oauth_client_id,g.issuer,g.resource,g.scopes,g.consented_at
  FROM community.article_authoring_connections c
  JOIN community.article_authoring_grants g ON g.grant_id=c.current_grant_id`;

function refused(): never {
  throw new CommunityNotFoundError();
}
const scopesEqual = (
  left: readonly string[],
  right: readonly string[],
): boolean =>
  left.length === right.length &&
  [...left].sort().every((scope, index) => scope === [...right].sort()[index]);

/**
 * Called inside EVERY Article transaction, including before idempotent receipt
 * replay. The actor lock is the existing per-public-user writer fence; revoke
 * takes the same lock and cannot race an already admitted operation.
 */
export const createArticleDelegationGuards = (
  authority: ArticleDelegationAuthority,
  options: { readonly clock?: () => Date } = {},
) => {
  const clock = options.clock ?? (() => new Date());
  const freshTime = (now: Date): number => {
    const current = clock().getTime();
    if (!Number.isFinite(current) || !Number.isFinite(now.getTime())) refused();
    return Math.max(current, now.getTime());
  };
  const assertActor = async (
    db: Pick<PoolClient, "query">,
    actor: ArticleDelegationActor,
    operation: "read" | "draft-write" | "publish",
    _resourceId: string | null,
    now: Date,
  ): Promise<void> => {
    const active = await db.query(
      "SELECT id FROM community.public_users WHERE id=$1 AND status='active' FOR NO KEY UPDATE",
      [actor.userId],
    );
    if (active.rowCount !== 1) refused();
    if (actor.source === "human") return;
    // Checked after a possibly queued actor lock. An admitted HTTP request may
    // have waited beyond token expiry; command-start time alone is stale.
    const expiresAt = Date.parse(actor.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= freshTime(now)) refused();
    const row = (
      await db.query<AuthorityRow>(
        `${authoritySelect} WHERE c.id=$1 AND c.owner_id=$2 FOR SHARE OF c`,
        [actor.connectionId, actor.userId],
      )
    ).rows[0];
    if (
      row === undefined ||
      row.status !== "authorized" ||
      row.revoked_at !== null ||
      row.current_grant_id !== actor.grantId ||
      row.grant_id !== actor.grantId ||
      Number(row.generation) !== actor.generation ||
      Number(row.grant_generation) !== actor.generation ||
      row.owner_id !== actor.userId ||
      row.human_subject !== actor.userId ||
      row.client_id !== row.oauth_client_id ||
      row.issuer !== authority.issuer ||
      row.resource !== authority.resource ||
      row.environment !== authority.environment ||
      !scopesEqual(row.scopes, actor.scopes) ||
      !row.scopes.includes("artvenn:article:draft") ||
      expiresAt <= freshTime(now)
    )
      refused();
    if (
      operation === "publish" &&
      !row.scopes.includes("artvenn:article:publish")
    )
      refused();
  };

  const assertPublication = async (
    db: Pick<PoolClient, "query">,
    candidate: {
      readonly articleId: string;
      readonly ownerId: PublicUserId;
      readonly version: number;
      readonly fingerprint: string;
    },
    actor: ArticleDelegationActor,
    requestId: string,
    now: Date,
  ): Promise<void> => {
    await assertActor(db, actor, "publish", candidate.articleId, now);
    if (candidate.ownerId !== actor.userId) refused();
    if (actor.source === "human") return;
    if (actor.approvalId === undefined)
      throw new CommunityConflictError("ARTICLE_HUMAN_APPROVAL_REQUIRED");
    const row = (
      await db.query<{
        consumed_at: Date | null;
        consumed_request_id: string | null;
        expires_at: Date;
      }>(
        `SELECT consumed_at,consumed_request_id,expires_at
      FROM community.article_publication_approvals
      WHERE id=$1 AND owner_id=$2 AND connection_id=$3 AND generation=$4
        AND article_id=$5 AND article_version=$6 AND fingerprint=$7
      FOR UPDATE`,
        [
          actor.approvalId,
          actor.userId,
          actor.connectionId,
          actor.generation,
          candidate.articleId,
          candidate.version,
          candidate.fingerprint,
        ],
      )
    ).rows[0];
    if (row === undefined)
      throw new CommunityConflictError("ARTICLE_APPROVAL_CANDIDATE_MISMATCH");
    // A receipt replay follows the actor guard; it never grants a new effect.
    if (row.consumed_at !== null) {
      if (row.consumed_request_id === requestId) return;
      throw new CommunityConflictError("ARTICLE_APPROVAL_ALREADY_USED");
    }
    if (row.expires_at.getTime() <= freshTime(now))
      throw new CommunityConflictError("ARTICLE_APPROVAL_EXPIRED");
    await db.query(
      `UPDATE community.article_publication_approvals
      SET consumed_at=$2,consumed_request_id=$3 WHERE id=$1`,
      [actor.approvalId, now.toISOString(), requestId],
    );
    // This update commits or rolls back WITH publication. A validation or
    // moderation failure cannot burn an approval outside the publish result.
  };
  return { assertActor, assertPublication };
};

export const createArticleDelegationStore = (
  pool: Pool,
  authority: ArticleDelegationAuthority,
  options: { readonly clock?: () => Date; readonly readPool?: Pool } = {},
) => {
  const clock = options.clock ?? (() => new Date());
  const at = (now: Date): Date => {
    const value = new Date(Math.max(now.getTime(), clock().getTime()));
    if (!Number.isFinite(value.getTime())) throw new CommunityNotFoundError();
    return value;
  };
  const guards = createArticleDelegationGuards(authority, { clock });
  const connection = async (
    db: Pick<PoolClient, "query">,
    ownerId: PublicUserId,
    id: string,
  ): Promise<AuthorityRow> => {
    const row = (
      await db.query<AuthorityRow>(
        `${authoritySelect} WHERE c.id=$1 AND c.owner_id=$2 FOR SHARE OF c`,
        [id, ownerId],
      )
    ).rows[0];
    if (
      row === undefined ||
      row.status !== "authorized" ||
      row.revoked_at !== null ||
      row.current_grant_id !== row.grant_id ||
      Number(row.generation) !== Number(row.grant_generation) ||
      row.human_subject !== ownerId ||
      row.client_id !== row.oauth_client_id ||
      !row.scopes.includes("artvenn:article:publish") ||
      row.issuer !== authority.issuer ||
      row.resource !== authority.resource ||
      row.environment !== authority.environment
    )
      refused();
    return row;
  };
  const exactCandidate = async (
    db: Pick<PoolClient, "query">,
    ownerId: PublicUserId,
    input: ArticleApprovalCandidate,
  ): Promise<void> => {
    const candidate = await db.query(
      `SELECT id FROM community.article_documents
      WHERE id=$1 AND owner_id=$2 AND version=$3 AND fingerprint=$4 FOR SHARE`,
      [input.articleId, ownerId, input.expectedVersion, input.fingerprint],
    );
    if (candidate.rowCount !== 1)
      throw new CommunityConflictError("ARTICLE_STALE_VERSION");
  };
  const metadata = (row: {
    id: string;
    connection_id: string;
    generation: string;
    article_id: string;
    article_version: number;
    fingerprint: string;
    expires_at: Date;
    consumed_at: Date | null;
  }): ArticleApprovalResult =>
    articleApprovalResultSchema.parse({
      id: row.id,
      connectionId: row.connection_id,
      generation: Number(row.generation),
      articleId: row.article_id,
      expectedVersion: Number(row.article_version),
      fingerprint: row.fingerprint,
      expiresAt: row.expires_at.toISOString(),
      consumedAt: row.consumed_at?.toISOString() ?? null,
    });
  return {
    ...guards,
    async list(ownerId: PublicUserId) {
      return actorTransaction(pool, ownerId, async (db) =>
        (
          await db.query(
            `${authoritySelect} WHERE c.owner_id=$1 ORDER BY c.consented_at DESC LIMIT 50`,
            [ownerId],
          )
        ).rows.map((row: AuthorityRow) => ({
          id: row.id,
          ownerId: row.owner_id,
          clientId: row.client_id,
          environment: row.environment,
          issuer: row.issuer,
          resource: row.resource,
          scopes: row.scopes,
          generation: Number(row.generation),
          status: row.status,
          consentedAt: row.consented_at.toISOString(),
          revokedAt: row.revoked_at?.toISOString() ?? null,
        })),
      );
    },
    async revoke(
      ownerId: PublicUserId,
      connectionId: string,
      expectedGeneration: number,
      now: Date,
    ) {
      return actorTransaction(pool, ownerId, async (db) => {
        const row = (
          await db.query<{ status: string; generation: string }>(
            "SELECT status,generation FROM community.article_authoring_connections WHERE id=$1 AND owner_id=$2 FOR UPDATE",
            [connectionId, ownerId],
          )
        ).rows[0];
        if (row === undefined) refused();
        if (
          row.status === "revoked" &&
          Number(row.generation) === expectedGeneration + 1
        )
          return;
        if (Number(row.generation) !== expectedGeneration)
          throw new CommunityConflictError("ARTICLE_CONNECTION_CHANGED");
        if (row.status === "revoked") return;
        await db.query(
          `UPDATE community.article_authoring_connections
          SET status='revoked',generation=generation+1,revoked_at=$3,updated_at=$3
          WHERE id=$1 AND owner_id=$2`,
          [connectionId, ownerId, now.toISOString()],
        );
        // Generation is the immediate deny. Provider cleanup may fail without
        // resurrecting access; wrappers are invalidated in the same commit.
        await db.query(
          `UPDATE community.article_authoring_wrappers
          SET invalidated_at=$2 WHERE connection_id=$1 AND invalidated_at IS NULL`,
          [connectionId, now.toISOString()],
        );
      });
    },
    /** The caller has already read this exact preview through ArticleAuthoringService. */
    async prepareApprovalReview(
      ownerId: PublicUserId,
      input: ArticleApprovalCandidate,
      now: Date,
    ) {
      const ticket = generateSessionToken();
      const digest = await hashSessionToken(ticket);
      return actorTransaction(pool, ownerId, async (db) => {
        const row = await connection(db, ownerId, input.connectionId);
        await exactCandidate(db, ownerId, input);
        const reviewedAt = at(now);
        await db.query(
          "DELETE FROM community.article_publication_reviews WHERE owner_id=$1 AND expires_at<=$2",
          [ownerId, reviewedAt.toISOString()],
        );
        const outstanding = (
          await db.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM community.article_publication_reviews WHERE owner_id=$1 AND approval_id IS NULL",
            [ownerId],
          )
        ).rows[0];
        if (Number(outstanding?.count ?? 0) >= 50)
          throw new CommunityConflictError("ARTICLE_REVIEW_LIMIT");
        await db.query(
          `INSERT INTO community.article_publication_reviews
          (ticket_digest,owner_id,connection_id,generation,article_id,article_version,fingerprint,expires_at,created_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            digest,
            ownerId,
            input.connectionId,
            row.generation,
            input.articleId,
            input.expectedVersion,
            input.fingerprint,
            new Date(reviewedAt.getTime() + 10 * 60_000).toISOString(),
            reviewedAt.toISOString(),
          ],
        );
        return { reviewTicket: ticket };
      });
    },
    async readApproval(
      actor: Extract<ArticleDelegationActor, { source: "delegated" }>,
      input: ArticleApprovalCandidate,
      now: Date,
    ) {
      return actorTransaction(
        options.readPool ?? pool,
        actor.userId,
        async (db) => {
          await guards.assertActor(db, actor, "publish", input.articleId, now);
          if (input.connectionId !== actor.connectionId) refused();
          await exactCandidate(db, actor.userId, input);
          const row = (
            await db.query(
              `SELECT id,connection_id,generation,article_id,article_version,fingerprint,expires_at,consumed_at
          FROM community.article_publication_approvals
          WHERE owner_id=$1 AND connection_id=$2 AND generation=$3 AND article_id=$4 AND article_version=$5
            AND fingerprint=$6 AND expires_at>$7 AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1`,
              [
                actor.userId,
                actor.connectionId,
                actor.generation,
                input.articleId,
                input.expectedVersion,
                input.fingerprint,
                at(now).toISOString(),
              ],
            )
          ).rows[0];
          return row === undefined ? null : metadata(row);
        },
      );
    },
    async approveCandidate(
      ownerId: PublicUserId,
      input: ArticleCandidateApprovalSubmission,
      now: Date,
    ) {
      const digest = await hashSessionToken(input.reviewTicket);
      return actorTransaction(pool, ownerId, async (db) => {
        const row = await connection(db, ownerId, input.connectionId);
        await exactCandidate(db, ownerId, input);
        const old = (
          await db.query(
            `SELECT id,connection_id,generation,article_id,article_version,fingerprint,expires_at,consumed_at
          FROM community.article_publication_approvals WHERE owner_id=$1 AND request_id=$2`,
            [ownerId, input.requestId],
          )
        ).rows[0];
        if (old !== undefined) {
          if (
            old.connection_id !== input.connectionId ||
            Number(old.generation) !== Number(row.generation) ||
            old.article_id !== input.articleId ||
            Number(old.article_version) !== input.expectedVersion ||
            old.fingerprint !== input.fingerprint
          )
            throw new CommunityConflictError("ARTICLE_REQUEST_ID_REUSED");
          // Even receipt replay remains tied to the reviewed exact candidate.
          const proof = await db.query(
            `SELECT ticket_digest FROM community.article_publication_reviews
            WHERE ticket_digest=$1 AND owner_id=$2 AND approval_id=$3`,
            [digest, ownerId, old.id],
          );
          if (proof.rowCount !== 1) refused();
          return metadata(old);
        }
        const proof = (
          await db.query<{ expires_at: Date; approval_id: string | null }>(
            `SELECT expires_at,approval_id
          FROM community.article_publication_reviews WHERE ticket_digest=$1 AND owner_id=$2 AND connection_id=$3
            AND generation=$4 AND article_id=$5 AND article_version=$6 AND fingerprint=$7 FOR UPDATE`,
            [
              digest,
              ownerId,
              input.connectionId,
              row.generation,
              input.articleId,
              input.expectedVersion,
              input.fingerprint,
            ],
          )
        ).rows[0];
        const approvedAt = at(now);
        if (
          proof === undefined ||
          proof.approval_id !== null ||
          proof.expires_at.getTime() <= approvedAt.getTime()
        )
          refused();
        const id = generateOpaqueId("article-approval");
        const expiresAt = new Date(approvedAt.getTime() + 10 * 60_000);
        const saved = (
          await db.query(
            `INSERT INTO community.article_publication_approvals
          (id,owner_id,request_id,connection_id,generation,article_id,article_version,fingerprint,expires_at,created_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          RETURNING id,connection_id,generation,article_id,article_version,fingerprint,expires_at,consumed_at`,
            [
              id,
              ownerId,
              input.requestId,
              input.connectionId,
              row.generation,
              input.articleId,
              input.expectedVersion,
              input.fingerprint,
              expiresAt.toISOString(),
              approvedAt.toISOString(),
            ],
          )
        ).rows[0]!;
        await db.query(
          "UPDATE community.article_publication_reviews SET approval_id=$2 WHERE ticket_digest=$1",
          [digest, id],
        );
        return metadata(saved);
      });
    },
  };
};

/** Dedicated opaque token admission; never a cookie or Payload API-key fallback. */
export const admitArticleOAuthGrant = async (input: {
  readonly presented: string;
  readonly wrappers: {
    resolve(value: string): Promise<
      | {
          grantId: string;
          connectionId: string;
          generation: number;
          expiresAt: string;
          invalidatedAt: string | null;
        }
      | undefined
    >;
  };
  readonly pool: Pick<Pool, "query">;
  readonly authority: ArticleDelegationAuthority;
  readonly now: Date;
}): Promise<Extract<ArticleDelegationActor, { source: "delegated" }>> => {
  if (!input.presented.startsWith("artvenn_article_ct_")) refused();
  const wrapper = await input.wrappers.resolve(input.presented);
  if (
    wrapper === undefined ||
    wrapper.invalidatedAt !== null ||
    !Number.isFinite(Date.parse(wrapper.expiresAt)) ||
    Date.parse(wrapper.expiresAt) <= input.now.getTime()
  )
    refused();
  const row = (
    await input.pool.query<AuthorityRow>(`${authoritySelect} WHERE c.id=$1`, [
      wrapper.connectionId,
    ])
  ).rows[0];
  if (
    row === undefined ||
    row.status !== "authorized" ||
    row.revoked_at !== null ||
    row.grant_id !== wrapper.grantId ||
    row.current_grant_id !== wrapper.grantId ||
    Number(row.generation) !== wrapper.generation ||
    Number(row.grant_generation) !== wrapper.generation ||
    row.owner_id !== row.human_subject ||
    row.client_id !== row.oauth_client_id ||
    row.issuer !== input.authority.issuer ||
    row.resource !== input.authority.resource ||
    row.environment !== input.authority.environment ||
    !row.scopes.includes("artvenn:article:draft") ||
    row.scopes.some(
      (scope) =>
        scope !== "artvenn:article:draft" &&
        scope !== "artvenn:article:publish",
    ) ||
    new Set(row.scopes).size !== row.scopes.length
  )
    refused();
  return {
    source: "delegated",
    userId: row.owner_id,
    connectionId: row.id,
    generation: wrapper.generation,
    grantId: wrapper.grantId,
    scopes: row.scopes,
    expiresAt: wrapper.expiresAt,
  };
};

/** Refuse model-chosen consent fields before storage. */
export const assertArticleScopes = (
  scopes: readonly string[],
): ArticleAuthoringScope[] => {
  if (
    !scopes.includes("artvenn:article:draft") ||
    new Set(scopes).size !== scopes.length ||
    scopes.some(
      (scope) =>
        scope !== "artvenn:article:draft" &&
        scope !== "artvenn:article:publish",
    )
  )
    throw new CommunityInputError();
  return [...scopes].sort() as ArticleAuthoringScope[];
};
