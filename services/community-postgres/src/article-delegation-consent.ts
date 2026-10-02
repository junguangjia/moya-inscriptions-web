import {
  CommunityConflictError,
  CommunityNotFoundError,
  generateSessionToken,
  hashSessionToken,
  generateOpaqueId,
} from "@moya/api";
import type { ArticleAuthoringScope, PublicUserId } from "@moya/contracts";
import type { Pool } from "pg";
import type { ArticleConsentInteraction } from "@moya/api";
import { actorTransaction, writeTransaction } from "./publishing/db.js";
import { assertArticleScopes } from "./article-delegation.js";
import type { ArticleDelegationAuthority } from "./article-delegation.js";

export type { ArticleConsentInteraction } from "@moya/api";

interface InteractionRow {
  interaction_uid: string;
  oauth_client_id: string;
  resource: string;
  scopes: ArticleAuthoringScope[];
  expires_at: Date;
  decision: "approved" | "denied" | null;
  owner_id: PublicUserId | null;
  connection_id: string | null;
  granted_generation: string | null;
  resumed_at: Date | null;
}
const toInteraction = (row: InteractionRow): ArticleConsentInteraction => ({
  interactionUid: row.interaction_uid,
  clientId: row.oauth_client_id,
  resource: row.resource,
  scopes: row.scopes,
  expiresAt: row.expires_at.toISOString(),
  decision: row.decision,
  ownerId: row.owner_id,
  connectionId: row.connection_id,
  generation:
    row.granted_generation === null ? null : Number(row.granted_generation),
  resumedAt: row.resumed_at?.toISOString() ?? null,
});
const select = `SELECT interaction_uid,oauth_client_id,resource,scopes,expires_at,
  decision,owner_id,connection_id,granted_generation,resumed_at
  FROM community.article_authoring_consents`;

/**
 * Provider INSERT/finalize and human review/decide use separately privileged
 * pools. The issuer never authenticates a human or writes decision columns.
 */
export const createArticleConsentStore = (
  pool: Pool,
  authority: ArticleDelegationAuthority,
  options: { readonly clock?: () => Date } = {},
) => {
  const clock = options.clock ?? (() => new Date());
  const fresh = (now: Date): Date => {
    const value = new Date(Math.max(now.getTime(), clock().getTime()));
    if (!Number.isFinite(value.getTime())) throw new CommunityNotFoundError();
    return value;
  };
  return {
    async open(input: {
      readonly interactionUid: string;
      readonly clientId: string;
      readonly scopes: readonly string[];
      readonly expiresAt: Date;
    }) {
      const scopes = assertArticleScopes(input.scopes);
      await pool.query(
        `INSERT INTO community.article_authoring_consents
      (interaction_uid,oauth_client_id,resource,scopes,expires_at)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(interaction_uid) DO NOTHING`,
        [
          input.interactionUid,
          input.clientId,
          authority.resource,
          scopes,
          input.expiresAt.toISOString(),
        ],
      );
      const row = (
        await pool.query<InteractionRow>(`${select} WHERE interaction_uid=$1`, [
          input.interactionUid,
        ])
      ).rows[0];
      if (
        row === undefined ||
        row.oauth_client_id !== input.clientId ||
        row.resource !== authority.resource ||
        row.scopes.join(" ") !== scopes.join(" ")
      )
        throw new CommunityConflictError("ARTICLE_INTERACTION_CHANGED");
      return toInteraction(row);
    },
    async read(uid: string) {
      const row = (
        await pool.query<InteractionRow>(`${select} WHERE interaction_uid=$1`, [
          uid,
        ])
      ).rows[0];
      return row === undefined ? null : toInteraction(row);
    },
    async prepareReview(ownerId: PublicUserId, uid: string, now: Date) {
      // This short-lived proof is returned only to the authenticated same-origin
      // consent page; no token-bearing URL is constructed or stored.
      const ticket = generateSessionToken();
      const digest = await hashSessionToken(ticket);
      return actorTransaction(pool, ownerId, async (db) => {
        const row = (
          await db.query<InteractionRow>(
            `${select} WHERE interaction_uid=$1 FOR UPDATE`,
            [uid],
          )
        ).rows[0];
        if (
          row === undefined ||
          row.expires_at.getTime() <= fresh(now).getTime() ||
          row.decision !== null
        )
          throw new CommunityNotFoundError();
        const assigned = await db.query(
          `UPDATE community.article_authoring_consents
        SET reviewed_owner_id=$2,review_ticket_digest=$3
        WHERE interaction_uid=$1 AND (reviewed_owner_id IS NULL OR reviewed_owner_id=$2)`,
          [uid, ownerId, digest],
        );
        if (assigned.rowCount !== 1) throw new CommunityNotFoundError();
        return { interaction: toInteraction(row), consentTicket: ticket };
      });
    },
    async decide(
      ownerId: PublicUserId,
      input: {
        readonly requestId: string;
        readonly interactionUid: string;
        readonly consentTicket: string;
        readonly decision: "approve" | "deny";
        readonly scopes: readonly ArticleAuthoringScope[];
      },
      now: Date,
    ) {
      const digest = await hashSessionToken(input.consentTicket);
      const scopes = assertArticleScopes(input.scopes);
      return actorTransaction(pool, ownerId, async (db) => {
        const row = (
          await db.query<
            InteractionRow & { decision_request_id: string | null }
          >(
            `SELECT interaction_uid,oauth_client_id,resource,scopes,expires_at,
          decision,owner_id,connection_id,granted_generation,resumed_at,decision_request_id
          FROM community.article_authoring_consents
          WHERE interaction_uid=$1 AND reviewed_owner_id=$2 AND review_ticket_digest=$3 FOR UPDATE`,
            [input.interactionUid, ownerId, digest],
          )
        ).rows[0];
        if (
          row === undefined ||
          row.expires_at.getTime() <= fresh(now).getTime()
        )
          throw new CommunityNotFoundError();
        const decision = input.decision === "approve" ? "approved" : "denied";
        if (row.decision !== null) {
          if (
            row.decision_request_id === input.requestId &&
            row.decision === decision &&
            row.owner_id === ownerId
          )
            return toInteraction(row);
          throw new CommunityConflictError("ARTICLE_CONSENT_ALREADY_DECIDED");
        }
        if (
          row.resource !== authority.resource ||
          row.scopes.join(" ") !== scopes.join(" ")
        )
          throw new CommunityConflictError("ARTICLE_CONSENT_SCOPE_MISMATCH");
        now = fresh(now);
        let connectionId: string | null = null;
        let generation: number | null = null;
        if (decision === "approved") {
          const connection = (
            await db.query<{ id: string; generation: string }>(
              `INSERT INTO community.article_authoring_connections
            (id,owner_id,client_id,environment,generation,status,consented_at,updated_at)
          VALUES($1,$2,$3,$4,1,'authorized',$5,$5)
          ON CONFLICT(owner_id,client_id,environment) DO UPDATE
            SET generation=community.article_authoring_connections.generation+1,
              status='authorized',current_grant_id=NULL,revoked_at=NULL,consented_at=$5,updated_at=$5
          RETURNING id,generation`,
              [
                generateOpaqueId("article-connection"),
                ownerId,
                row.oauth_client_id,
                authority.environment,
                now.toISOString(),
              ],
            )
          ).rows[0]!;
          connectionId = connection.id;
          generation = Number(connection.generation);
          await db.query(
            `UPDATE community.article_authoring_wrappers SET invalidated_at=$2
          WHERE connection_id=$1 AND invalidated_at IS NULL`,
            [connectionId, now.toISOString()],
          );
        }
        const updated = (
          await db.query<InteractionRow>(
            `UPDATE community.article_authoring_consents
        SET decision=$2,owner_id=$3,connection_id=$4,granted_generation=$5,
          decided_at=$6,decision_request_id=$7
        WHERE interaction_uid=$1 RETURNING interaction_uid,oauth_client_id,resource,scopes,
          expires_at,decision,owner_id,connection_id,granted_generation,resumed_at`,
            [
              input.interactionUid,
              decision,
              ownerId,
              connectionId,
              generation,
              now.toISOString(),
              input.requestId,
            ],
          )
        ).rows[0]!;
        return toInteraction(updated);
      });
    },
    async finalizeGrant(uid: string, grantId: string, now: Date) {
      return writeTransaction(pool, async (db) => {
        const row = (
          await db.query<InteractionRow>(
            `${select} WHERE interaction_uid=$1 FOR UPDATE`,
            [uid],
          )
        ).rows[0];
        if (
          row === undefined ||
          row.decision !== "approved" ||
          row.owner_id === null ||
          row.connection_id === null ||
          row.granted_generation === null ||
          row.resumed_at !== null ||
          row.expires_at.getTime() <= fresh(now).getTime()
        )
          throw new CommunityConflictError("ARTICLE_CONSENT_NOT_GRANTED");
        const connection = (
          await db.query<{ generation: string; status: string }>(
            "SELECT generation,status FROM community.article_authoring_connections WHERE id=$1 FOR UPDATE",
            [row.connection_id],
          )
        ).rows[0];
        if (
          connection === undefined ||
          connection.status !== "authorized" ||
          connection.generation !== row.granted_generation ||
          row.expires_at.getTime() <= fresh(now).getTime()
        )
          throw new CommunityConflictError("ARTICLE_CONNECTION_MOVED");
        now = fresh(now);
        await db.query(
          `INSERT INTO community.article_authoring_grants
        (grant_id,connection_id,generation,human_subject,oauth_client_id,issuer,resource,scopes,consented_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            grantId,
            row.connection_id,
            row.granted_generation,
            row.owner_id,
            row.oauth_client_id,
            authority.issuer,
            row.resource,
            row.scopes,
            now.toISOString(),
          ],
        );
        await db.query(
          "UPDATE community.article_authoring_connections SET current_grant_id=$2 WHERE id=$1",
          [row.connection_id, grantId],
        );
        await db.query(
          "UPDATE community.article_authoring_consents SET resumed_at=$2,provider_grant_id=$3 WHERE interaction_uid=$1",
          [uid, now.toISOString(), grantId],
        );
        return toInteraction(row);
      });
    },
  };
};
