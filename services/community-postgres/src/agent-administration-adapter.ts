import type {
  AgentAdministrationPort,
  AgentFeaturedState,
  AgentManifestQuery,
  AgentManifestSelection,
  AgentOperationDraft,
  PublicUserStatus,
} from "@moya/api";
import type { ContentIdentity } from "@moya/contracts";
import type {
  AgentCommentTarget,
  AgentManifestSample,
  AgentOperationTargetPage,
  AgentUserLookupPage,
  AgentUserLookupQuery,
  AgentUserMatchKind,
  AgentDelegation,
  AgentDelegationQuery,
  AgentOperation,
  AgentOperationApproval,
  AgentOperationDetail,
  AgentOperationKind,
  AgentOperationPage,
  AgentOperationQuery,
  AgentOperationResult,
  AgentOperationTarget,
  AgentPrincipal,
} from "@moya/contracts/internal/community-operator";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import { AgentManifestError } from "@moya/api";

import { asCommunityOperationError } from "./availability.js";

interface PrincipalRow {
  label: string;
  display_name: string;
  scopes: string[];
  enabled: boolean;
  version: string | number;
  created_at: Date;
  updated_at: Date;
  revoked_at: Date | null;
}

interface DelegationRow {
  id: string;
  principal_label: string;
  kind: AgentOperationKind;
  max_targets: number;
  expires_at: Date;
  created_by: string;
  created_at: Date;
  revoked_at: Date | null;
  revoked_by: string | null;
}

interface OperationRow {
  id: string;
  principal_label: string;
  request_id: string;
  kind: AgentOperationKind;
  action: AgentOperation["action"];
  state: AgentOperation["state"];
  targets: AgentOperationTarget[];
  target_count: number;
  fingerprint: string;
  approval: AgentOperationApproval | null;
  undo_of: string | null;
  criteria: Record<string, unknown> | null;
  next_index: number;
  results: AgentOperationResult[];
  lease_owner: string | null;
  lease_expires_at: Date | null;
  version: string | number;
  created_at: Date;
  expires_at: Date;
  approved_at: Date | null;
  started_at: Date | null;
  finished_at: Date | null;
  cancel_requested_at: Date | null;
  lease_live?: boolean;
}

const iso = (value: Date): string => value.toISOString();
const isoOrNull = (value: Date | null): string | null =>
  value === null ? null : value.toISOString();

const principal = (row: PrincipalRow): AgentPrincipal => ({
  label: row.label,
  displayName: row.display_name,
  scopes: row.scopes as AgentPrincipal["scopes"],
  enabled: row.enabled,
  version: Number(row.version),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
  revokedAt: isoOrNull(row.revoked_at),
});

const delegation = (row: DelegationRow): AgentDelegation => ({
  id: row.id,
  principal: row.principal_label,
  kind: row.kind,
  maxTargets: row.max_targets,
  expiresAt: iso(row.expires_at),
  createdBy: row.created_by,
  createdAt: iso(row.created_at),
  revokedAt: isoOrNull(row.revoked_at),
  revokedBy: row.revoked_by,
});

const tally = (results: readonly AgentOperationResult[]) => {
  const counts = {
    applied: 0,
    conflicts: 0,
    notFound: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const result of results) {
    if (result.outcome === "applied") counts.applied += 1;
    else if (result.outcome === "conflict") counts.conflicts += 1;
    else if (result.outcome === "not_found") counts.notFound += 1;
    else if (result.outcome === "failed") counts.failed += 1;
    else counts.cancelled += 1;
  }
  return counts;
};

const operation = (row: OperationRow, at: Date): AgentOperation => ({
  id: row.id,
  principal: row.principal_label,
  requestId: row.request_id,
  kind: row.kind,
  action: row.action,
  state: row.state,
  approval: row.approval,
  undoOf: row.undo_of,
  criteria: (row.criteria ?? null) as AgentOperation["criteria"],
  targetCount: row.target_count,
  nextIndex: row.next_index,
  results: row.results,
  tally: tally(row.results),
  version: Number(row.version),
  createdAt: iso(row.created_at),
  expiresAt: iso(row.expires_at),
  approvedAt: isoOrNull(row.approved_at),
  startedAt: isoOrNull(row.started_at),
  finishedAt: isoOrNull(row.finished_at),
  cancelRequestedAt: isoOrNull(row.cancel_requested_at),
  leaseHeld:
    row.lease_owner !== null &&
    row.lease_expires_at !== null &&
    row.lease_expires_at.getTime() > at.getTime(),
});

const detail = (row: OperationRow, at: Date): AgentOperationDetail => ({
  ...operation(row, at),
  fingerprint: row.fingerprint,
  targets: row.targets,
});

const operationColumns =
  "id,principal_label,request_id,kind,action,state,targets,target_count,fingerprint,approval,undo_of,criteria,next_index,results,lease_owner,lease_expires_at,version,created_at,expires_at,approved_at,started_at,finished_at,cancel_requested_at";

/**
 * PostgreSQL persistence for Agent Administration V1. Every lifecycle write
 * is one fenced statement: it names the state it leaves or the lease it
 * holds, so a stale executor or a repeated command finds zero rows and gets
 * null instead of a second effect. Targets, kind, action, fingerprint and the
 * request identity are never updated (the App role holds no UPDATE on them).
 */
export class PostgresAgentAdministrationAdapter implements AgentAdministrationPort {
  constructor(private readonly pool: Pool) {}

  private async query<Row extends QueryResultRow>(
    sql: string,
    values: readonly unknown[],
    db: Pool | PoolClient = this.pool,
  ): Promise<Row[]> {
    try {
      return (await db.query<Row>(sql, values as unknown[])).rows;
    } catch (error) {
      throw asCommunityOperationError(error, "query");
    }
  }

  private async transaction<T>(
    run: (db: PoolClient) => Promise<T>,
  ): Promise<T> {
    const db = await this.pool.connect().catch((error) => {
      throw asCommunityOperationError(error, "connect");
    });
    try {
      await db.query("BEGIN");
      const result = await run(db);
      await db.query("COMMIT");
      return result;
    } catch (error) {
      await db.query("ROLLBACK").catch(() => undefined);
      throw asCommunityOperationError(error, "query");
    } finally {
      db.release();
    }
  }

  async readPrincipals(): Promise<readonly AgentPrincipal[]> {
    return (
      await this.query<PrincipalRow>(
        "SELECT * FROM community.agent_principals ORDER BY created_at, label",
        [],
      )
    ).map(principal);
  }

  async findPrincipal(label: string): Promise<AgentPrincipal | null> {
    const row = (
      await this.query<PrincipalRow>(
        "SELECT * FROM community.agent_principals WHERE label=$1",
        [label],
      )
    )[0];
    return row === undefined ? null : principal(row);
  }

  async writePrincipal(
    input: {
      readonly label: string;
      readonly displayName: string;
      readonly scopes: readonly string[];
      readonly enabled: boolean;
      readonly expectedVersion: number;
    },
    at: Date,
  ): Promise<AgentPrincipal | null> {
    return this.transaction(async (db) => {
      const existing = (
        await this.query<PrincipalRow>(
          "SELECT * FROM community.agent_principals WHERE label=$1 FOR UPDATE",
          [input.label],
          db,
        )
      )[0];
      if (existing === undefined) {
        if (input.expectedVersion !== 0) return null;
        const row = (
          await this.query<PrincipalRow>(
            "INSERT INTO community.agent_principals(label,display_name,scopes,enabled,created_at,updated_at) VALUES($1,$2,$3::text[],$4,$5,$5) RETURNING *",
            [input.label, input.displayName, input.scopes, input.enabled, at],
            db,
          )
        )[0]!;
        return principal(row);
      }
      if (
        Number(existing.version) !== input.expectedVersion ||
        existing.revoked_at !== null
      )
        return null;
      const row = (
        await this.query<PrincipalRow>(
          "UPDATE community.agent_principals SET display_name=$2,scopes=$3::text[],enabled=$4,version=version+1,updated_at=$5 WHERE label=$1 AND version=$6 AND revoked_at IS NULL RETURNING *",
          [
            input.label,
            input.displayName,
            input.scopes,
            input.enabled,
            at,
            input.expectedVersion,
          ],
          db,
        )
      )[0];
      return row === undefined ? null : principal(row);
    });
  }

  async revokePrincipal(
    label: string,
    expectedVersion: number,
    at: Date,
  ): Promise<AgentPrincipal | null> {
    const row = (
      await this.query<PrincipalRow>(
        "UPDATE community.agent_principals SET enabled=FALSE,revoked_at=$3,version=version+1,updated_at=$3 WHERE label=$1 AND version=$2 AND revoked_at IS NULL RETURNING *",
        [label, expectedVersion, at],
      )
    )[0];
    return row === undefined ? null : principal(row);
  }

  async readDelegations(
    query: AgentDelegationQuery,
    at: Date,
  ): Promise<readonly AgentDelegation[]> {
    return (
      await this.query<DelegationRow>(
        `SELECT * FROM community.agent_delegations
          WHERE ($1::text IS NULL OR principal_label=$1)
            AND ($2::boolean OR (revoked_at IS NULL AND expires_at>$3))
          ORDER BY created_at DESC, id DESC`,
        [query.principal ?? null, query.includeInactive, at],
      )
    ).map(delegation);
  }

  async createDelegation(
    input: {
      readonly id: string;
      readonly principal: string;
      readonly kind: AgentOperationKind;
      readonly maxTargets: number;
      readonly expiresAt: Date;
      readonly createdBy: string;
    },
    at: Date,
  ): Promise<AgentDelegation> {
    const row = (
      await this.query<DelegationRow>(
        "INSERT INTO community.agent_delegations(id,principal_label,kind,max_targets,expires_at,created_by,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
        [
          input.id,
          input.principal,
          input.kind,
          input.maxTargets,
          input.expiresAt,
          input.createdBy,
          at,
        ],
      )
    )[0]!;
    return delegation(row);
  }

  async revokeDelegation(
    id: string,
    by: string,
    at: Date,
  ): Promise<AgentDelegation | null> {
    const row = (
      await this.query<DelegationRow>(
        "UPDATE community.agent_delegations SET revoked_at=$2,revoked_by=$3 WHERE id=$1 AND revoked_at IS NULL RETURNING *",
        [id, at, by],
      )
    )[0];
    if (row !== undefined) return delegation(row);
    const already = (
      await this.query<DelegationRow>(
        "SELECT * FROM community.agent_delegations WHERE id=$1",
        [id],
      )
    )[0];
    return already === undefined ? null : delegation(already);
  }

  async findActiveDelegation(
    principalLabel: string,
    kind: AgentOperationKind,
    targetCount: number,
    at: Date,
  ): Promise<AgentDelegation | null> {
    const row = (
      await this.query<DelegationRow>(
        `SELECT * FROM community.agent_delegations
          WHERE principal_label=$1 AND kind=$2 AND max_targets>=$3
            AND revoked_at IS NULL AND expires_at>$4
          ORDER BY expires_at DESC, id LIMIT 1`,
        [principalLabel, kind, targetCount, at],
      )
    )[0];
    return row === undefined ? null : delegation(row);
  }

  async resolveUsers(
    query: AgentUserLookupQuery,
  ): Promise<AgentUserLookupPage> {
    // One statement: the ranking CTE decides the order, and the aggregate
    // columns describe the WHOLE ranked set, so resolution never depends on
    // which page the caller asked for.
    const search = query.search ?? "";
    const rows = await this.query<{
      id: string;
      handle: string;
      display_name: string;
      status: string;
      match_rank: number;
    }>(
      `WITH ranked AS (
         SELECT u.id,u.handle,u.display_name,u.status,u.created_at,
           CASE
             WHEN $2::text IS NOT NULL THEN 0
             WHEN $3::text IS NOT NULL THEN 1
             WHEN $1 <> '' AND u.id = $1 THEN 0
             WHEN $1 <> '' AND lower(u.handle) = lower(ltrim($1,'@')) THEN 1
             WHEN $1 <> '' AND lower(u.display_name) = lower($1) THEN 2
             ELSE 3
           END AS match_rank
         FROM community.public_users u
         WHERE ($2::text IS NULL OR u.id = $2)
           AND ($3::text IS NULL OR lower(u.handle) = lower(ltrim($3,'@')))
           AND ($2::text IS NOT NULL OR $3::text IS NOT NULL OR $1 = '' OR
                u.id = $1 OR lower(u.handle) = lower(ltrim($1,'@'))
                OR lower(u.display_name) = lower($1)
                OR position(lower($1) in lower(u.id||' '||u.handle||' '||u.display_name)) > 0)
       )
       SELECT r.id,r.handle,r.display_name,r.status,r.match_rank
       FROM ranked r
       ORDER BY r.match_rank, r.created_at DESC, r.id
       LIMIT $4 OFFSET $5`,
      [
        search,
        query.userId ?? null,
        query.handle ?? null,
        query.pageSize,
        (query.page - 1) * query.pageSize,
      ],
    );
    // The resolution describes the WHOLE ranked set, so it is computed
    // separately: a page past the last row must not read as "no such user".
    const totals = (
      await this.query<{
        best: number | null;
        total: string | number;
        best_count: string | number;
        best_id: string | null;
      }>(
        `WITH ranked AS (
           SELECT u.id,
             CASE
               WHEN $2::text IS NOT NULL THEN 0
               WHEN $3::text IS NOT NULL THEN 1
               WHEN $1 <> '' AND u.id = $1 THEN 0
               WHEN $1 <> '' AND lower(u.handle) = lower(ltrim($1,'@')) THEN 1
               WHEN $1 <> '' AND lower(u.display_name) = lower($1) THEN 2
               ELSE 3
             END AS match_rank
           FROM community.public_users u
           WHERE ($2::text IS NULL OR u.id = $2)
             AND ($3::text IS NULL OR lower(u.handle) = lower(ltrim($3,'@')))
             AND ($2::text IS NOT NULL OR $3::text IS NOT NULL OR $1 = '' OR
                  u.id = $1 OR lower(u.handle) = lower(ltrim($1,'@'))
                  OR lower(u.display_name) = lower($1)
                  OR position(lower($1) in lower(u.id||' '||u.handle||' '||u.display_name)) > 0)
         )
         SELECT min(match_rank) AS best, count(*) AS total,
                count(*) FILTER (WHERE match_rank = (SELECT min(match_rank) FROM ranked)) AS best_count,
                (SELECT id FROM ranked WHERE match_rank = (SELECT min(match_rank) FROM ranked) LIMIT 1) AS best_id
         FROM ranked`,
        [search, query.userId ?? null, query.handle ?? null],
      )
    )[0];
    const kinds: readonly AgentUserMatchKind[] = [
      "id",
      "handle",
      "display_name",
      "substring",
    ];
    const items = rows.map((row) => ({
      id: row.id,
      handle: row.handle,
      displayName: row.display_name,
      status: row.status as PublicUserStatus,
      matchKind: kinds[row.match_rank] ?? "substring",
    }));
    const total = totals === undefined ? 0 : Number(totals.total);
    const best =
      totals === undefined || totals.best === null ? null : Number(totals.best);
    const bestCount = totals === undefined ? 0 : Number(totals.best_count);
    const bestKind = best === null ? null : (kinds[best] ?? "substring");
    // Only a unique id or handle hit is identity evidence. A single
    // display-name hit stays a candidate, because display names repeat.
    const uniqueIdentity =
      bestCount === 1 && (bestKind === "id" || bestKind === "handle");
    return {
      items,
      total,
      page: query.page,
      pageSize: query.pageSize,
      resolution: {
        status: total === 0 ? "none" : uniqueIdentity ? "exact" : "candidates",
        uniqueIdentity,
        matchKind: bestKind,
        // Taken from the whole ranked set, not from the requested page: a
        // unique exact identity must not become null just because the caller
        // asked for a later page.
        userId: uniqueIdentity ? (totals?.best_id ?? null) : null,
        ambiguous: total > 1 && !uniqueIdentity,
      },
    } as AgentUserLookupPage;
  }

  async selectCommentManifest(
    query: AgentManifestQuery,
    limit: number,
    sampleSize: number,
  ): Promise<AgentManifestSelection> {
    // Body-only literal matching. The terms travel as a text[] parameter and
    // are compared with position(), so %, _ and backslash carry no meaning and
    // no value is ever concatenated into SQL. One UNION ALL statement inside a
    // read-only repeatable-read transaction is the consistent snapshot: comment
    // and reply membership cannot drift apart.
    const anyTerm = (column: string) =>
      `EXISTS (SELECT 1 FROM unnest($1::text[]) t WHERE position(lower(t) in lower(${column})) > 0)`;
    const allTerms = (column: string) =>
      `NOT EXISTS (SELECT 1 FROM unnest($1::text[]) t WHERE position(lower(t) in lower(${column})) = 0)`;
    const match = query.match === "all" ? allTerms : anyTerm;
    const filters = (text: string, created: string, author: string) =>
      `${match(text)}
         AND ($4::text IS NULL OR c.target_type = $4)
         AND ($5::text IS NULL OR c.catalog_id = $5)
         AND ($6::text IS NULL OR ${author} = $6)
         AND ($7::text IS NULL OR ${text.replace(/\.text$/, ".moderation")} = $7)
         AND ($8::timestamptz IS NULL OR ${created} >= $8)
         AND ($9::timestamptz IS NULL OR ${created} < $9)`;
    const comments = `SELECT c.id, 'comment' AS kind, c.moderation AS prior, c.created_at,
         substr(encode(sha256(convert_to(c.text,'UTF8')),'hex'),1,16) AS text_sha,
         left(c.text,160) AS excerpt
       FROM community.catalog_comments c
       WHERE ${filters("c.text", "c.created_at", "c.author_id")}`;
    const replies = `SELECT r.id, 'reply' AS kind, r.moderation AS prior, r.created_at,
         substr(encode(sha256(convert_to(r.text,'UTF8')),'hex'),1,16) AS text_sha,
         left(r.text,160) AS excerpt
       FROM community.catalog_comment_replies r
       JOIN community.catalog_comments c ON c.id = r.root_comment_id
       WHERE ${match("r.text")}
         AND ($4::text IS NULL OR c.target_type = $4)
         AND ($5::text IS NULL OR c.catalog_id = $5)
         AND ($6::text IS NULL OR r.author_id = $6)
         AND ($7::text IS NULL OR r.moderation = $7)
         AND ($8::timestamptz IS NULL OR r.created_at >= $8)
         AND ($9::timestamptz IS NULL OR r.created_at < $9)`;
    const parts: string[] = [];
    if (query.scope !== "replies") parts.push(comments);
    if (query.scope !== "comments") parts.push(replies);
    const sql = `${parts.join(" UNION ALL ")}
       ORDER BY created_at ASC, id ASC
       LIMIT $2 OFFSET $3`;
    const db = await this.pool.connect().catch((error) => {
      throw asCommunityOperationError(error, "connect");
    });
    let committed = false;
    try {
      await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      // A finite planning/execution budget: an exceedance is an explicit
      // failure below, never a partial list.
      await db.query("SET LOCAL statement_timeout = '5000ms'");
      const rows = (
        await db.query<{
          id: string;
          kind: "comment" | "reply";
          prior: "pending" | "visible" | "hidden";
          text_sha: string;
          excerpt: string;
        }>(sql, [
          [...query.terms],
          limit + 1,
          0,
          query.target?.type ?? null,
          query.target?.id ?? null,
          query.authorId,
          query.moderation,
          query.createdFrom,
          query.createdTo,
        ])
      ).rows;
      await db.query("COMMIT");
      committed = true;
      if (rows.length > limit)
        throw new AgentManifestError("MANIFEST_LIMIT_EXCEEDED", limit);
      const targets = rows.map(
        (row) =>
          ({
            id: row.id,
            prior: row.prior,
            kind: row.kind,
            textSha: row.text_sha,
          }) as AgentCommentTarget,
      );
      const sample = rows.slice(0, sampleSize).map(
        (row) =>
          ({
            id: row.id,
            kind: row.kind,
            excerpt: row.excerpt,
          }) as AgentManifestSample,
      );
      return { targets, total: targets.length, sample };
    } catch (error) {
      if (!committed) await db.query("ROLLBACK").catch(() => undefined);
      if (error instanceof AgentManifestError) throw error;
      // 57014 is statement_timeout: the planner or the scan ran out of budget.
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "57014"
      )
        throw new AgentManifestError("MANIFEST_PLANNING_TIMEOUT");
      throw asCommunityOperationError(error, "query");
    } finally {
      db.release();
    }
  }

  async readOperationTargets(
    id: string,
    page: number,
    pageSize: number,
  ): Promise<AgentOperationTargetPage | null> {
    const row = (
      await this.query<{ targets: AgentCommentTarget[]; target_count: number }>(
        "SELECT targets,target_count FROM community.agent_operations WHERE id=$1",
        [id],
      )
    )[0];
    if (row === undefined) return null;
    const start = (page - 1) * pageSize;
    return {
      operationId: id,
      items: row.targets.slice(start, start + pageSize),
      total: row.target_count,
      page,
      pageSize,
    } as AgentOperationTargetPage;
  }

  async readFeaturedStates(
    targets: readonly ContentIdentity[],
  ): Promise<ReadonlyMap<string, AgentFeaturedState>> {
    const states = new Map<string, AgentFeaturedState>();
    if (targets.length === 0) return states;
    const rows = await this.query<{
      content_type: string;
      content_id: string;
      enabled: boolean;
      position: string | number;
      version: string | number;
    }>(
      `SELECT f.content_type,f.content_id,f.enabled,f.position,f.version
         FROM community.featured_content f
         JOIN unnest($1::text[],$2::text[]) AS t(content_type,content_id)
           ON t.content_type=f.content_type AND t.content_id=f.content_id`,
      [targets.map((t) => t.type), targets.map((t) => t.id)],
    );
    for (const row of rows)
      states.set(`${row.content_type}:${row.content_id}`, {
        enabled: row.enabled,
        position: Number(row.position),
        version: Number(row.version),
      });
    return states;
  }

  async createOperation(
    draft: AgentOperationDraft,
  ): Promise<{ operation: AgentOperationDetail; created: boolean } | null> {
    return this.transaction(async (db) => {
      const existing = (
        await this.query<OperationRow>(
          `SELECT ${operationColumns} FROM community.agent_operations WHERE principal_label=$1 AND request_id=$2`,
          [draft.principal, draft.requestId],
          db,
        )
      )[0];
      if (existing !== undefined)
        return existing.fingerprint === draft.fingerprint
          ? { operation: detail(existing, draft.createdAt), created: false }
          : null;
      const row = (
        await this.query<OperationRow>(
          `INSERT INTO community.agent_operations
             (id,principal_label,request_id,kind,action,state,targets,target_count,fingerprint,approval,undo_of,created_at,expires_at,approved_at,criteria)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10::jsonb,$11,$12,$13,$14,$15::jsonb)
           RETURNING ${operationColumns}`,
          [
            draft.id,
            draft.principal,
            draft.requestId,
            draft.kind,
            draft.action,
            draft.approval === null ? "prepared" : "approved",
            JSON.stringify(draft.targets),
            draft.targets.length,
            draft.fingerprint,
            draft.approval === null ? null : JSON.stringify(draft.approval),
            draft.undoOf,
            draft.createdAt,
            draft.expiresAt,
            draft.approval === null ? null : draft.createdAt,
            draft.criteria === null ? null : JSON.stringify(draft.criteria),
          ],
          db,
        )
      )[0]!;
      return { operation: detail(row, draft.createdAt), created: true };
    });
  }

  async findOperationByRequest(
    principalLabel: string,
    requestId: string,
  ): Promise<{
    readonly operation: AgentOperationDetail;
    readonly fingerprint: string;
  } | null> {
    const row = (
      await this.query<OperationRow>(
        `SELECT ${operationColumns} FROM community.agent_operations WHERE principal_label=$1 AND request_id=$2`,
        [principalLabel, requestId],
      )
    )[0];
    return row === undefined
      ? null
      : { operation: detail(row, new Date()), fingerprint: row.fingerprint };
  }

  async findOperation(id: string): Promise<AgentOperationDetail | null> {
    const row = (
      await this.query<OperationRow>(
        `SELECT ${operationColumns} FROM community.agent_operations WHERE id=$1`,
        [id],
      )
    )[0];
    return row === undefined ? null : detail(row, new Date());
  }

  async readOperations(
    query: AgentOperationQuery,
  ): Promise<AgentOperationPage> {
    const at = new Date();
    const filters = [
      "($1::text IS NULL OR state=$1)",
      "($2::text IS NULL OR principal_label=$2)",
    ].join(" AND ");
    const total = Number(
      (
        await this.query<{ n: string }>(
          `SELECT count(*) AS n FROM community.agent_operations WHERE ${filters}`,
          [query.state ?? null, query.principal ?? null],
        )
      )[0]!.n,
    );
    const rows = await this.query<OperationRow>(
      `SELECT ${operationColumns} FROM community.agent_operations WHERE ${filters}
        ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4`,
      [
        query.state ?? null,
        query.principal ?? null,
        query.pageSize,
        (query.page - 1) * query.pageSize,
      ],
    );
    return {
      items: rows.map((row) => operation(row, at)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async approveOperation(
    id: string,
    approval: AgentOperationApproval,
    at: Date,
  ): Promise<AgentOperation | null> {
    const row = (
      await this.query<OperationRow>(
        `UPDATE community.agent_operations SET state='approved',approval=$2::jsonb,approved_at=$3,version=version+1
          WHERE id=$1 AND state='prepared' AND expires_at>$3 RETURNING ${operationColumns}`,
        [id, JSON.stringify(approval), at],
      )
    )[0];
    return row === undefined ? null : operation(row, at);
  }

  async cancelOperation(id: string, at: Date): Promise<AgentOperation | null> {
    const row = (
      await this.query<OperationRow>(
        `UPDATE community.agent_operations SET
            cancel_requested_at=COALESCE(cancel_requested_at,$2),
            state=CASE WHEN state IN ('prepared','approved') THEN 'cancelled' ELSE state END,
            finished_at=CASE WHEN state IN ('prepared','approved') THEN $2 ELSE finished_at END,
            version=version+1
          WHERE id=$1 AND state IN ('prepared','approved','executing') RETURNING ${operationColumns}`,
        [id, at],
      )
    )[0];
    return row === undefined ? null : operation(row, at);
  }

  async claimExecution(
    id: string,
    leaseOwner: string,
    at: Date,
    leaseMs: number,
  ): Promise<{ operation: AgentOperationDetail; claimed: boolean } | null> {
    const until = new Date(at.getTime() + leaseMs);
    const row = (
      await this.query<OperationRow>(
        `UPDATE community.agent_operations SET
            state='executing', lease_owner=$2, lease_expires_at=$3,
            started_at=COALESCE(started_at,$4), version=version+1
          WHERE id=$1 AND state IN ('approved','executing')
            AND (lease_owner IS NULL OR lease_expires_at<=$4)
          RETURNING ${operationColumns}`,
        [id, leaseOwner, until, at],
      )
    )[0];
    if (row !== undefined) return { operation: detail(row, at), claimed: true };
    const current = (
      await this.query<OperationRow>(
        `SELECT ${operationColumns} FROM community.agent_operations WHERE id=$1 AND state='executing'`,
        [id],
      )
    )[0];
    return current === undefined
      ? null
      : { operation: detail(current, at), claimed: false };
  }

  async recordChunk(
    id: string,
    leaseOwner: string,
    results: readonly AgentOperationResult[],
    nextIndex: number,
    at: Date,
    options: {
      readonly finalState?: "completed" | "cancelled" | "failed";
      readonly release: boolean;
      readonly leaseMs: number;
    },
  ): Promise<AgentOperationDetail | null> {
    const release = options.release || options.finalState !== undefined;
    const row = (
      await this.query<OperationRow>(
        `UPDATE community.agent_operations SET
            results=results||$3::jsonb,
            next_index=$4::integer,
            state=COALESCE($5::text,state),
            finished_at=CASE WHEN $5::text IS NULL THEN finished_at ELSE $6::timestamptz END,
            lease_owner=CASE WHEN $7::boolean THEN NULL ELSE lease_owner END,
            lease_expires_at=CASE WHEN $7::boolean THEN NULL ELSE $8::timestamptz END,
            version=version+1
          WHERE id=$1 AND state='executing' AND lease_owner=$2 AND lease_expires_at>$6::timestamptz
          RETURNING ${operationColumns}`,
        [
          id,
          leaseOwner,
          JSON.stringify(results),
          nextIndex,
          options.finalState ?? null,
          at,
          release,
          new Date(at.getTime() + options.leaseMs),
        ],
      )
    )[0];
    return row === undefined ? null : detail(row, at);
  }
}
