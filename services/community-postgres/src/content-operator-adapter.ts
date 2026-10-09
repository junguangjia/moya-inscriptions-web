import {
  beginWorkPublicationSync,
  syncWorkHolds,
  type PublicationSyncOptions,
} from "./publishing/publication-sync.js";
import {
  effectiveFeatured,
  INHERITED_FEATURED_POSITION,
} from "./featured-content.js";
import { asCommunityOperationError } from "./availability.js";
import { assertExecutionFence } from "./execution-fence.js";
import { createHash, randomUUID } from "node:crypto";
import { CommunityConflictError, CommunityNotFoundError } from "@moya/api";
import type { CommunityContentOperatorPort, ExecutionFence } from "@moya/api";
import {
  operatorWorkSchema,
  operatorWorkPageSchema,
  featuredOrderResultSchema,
  featuredPageSchema,
  operatorUserPageSchema,
} from "@moya/contracts/internal/community-operator";
import type {
  OperatorWorksQuery,
  OperatorFeaturedQuery,
  OperatorUsersQuery,
  OperatorUserPage,
  RecommendUserCommand,
  OperatorWork,
  OperatorWorkPage,
  ModerateWorkCommand,
  FeaturedMutation,
  FeaturedOrderCommand,
  FeaturedOrderEntry,
  FeaturedOrderResult,
  FeaturedSettingsMutation,
  FeaturedPage,
} from "@moya/contracts/internal/community-operator";
import type { Pool, PoolClient, QueryResultRow } from "pg";
interface WorkRow extends QueryResultRow {
  id: string;
  title: string;
  text: string;
  author_id: string;
  display_name: string;
  author_status: "active" | "suspended";
  operator_state: "visible" | "hidden" | "removed";
  deleted_at: Date | null;
  version: number;
  first_published_at: Date | null;
  public_revision_id: string | null;
  latest_submission: OperatorWork["latestSubmission"];
  publicly_visible: boolean;
  recommendation: OperatorWork["recommendation"];
}
const workProjection = `SELECT w.*,u.display_name,u.status AS author_status,
  json_build_object('enabled',COALESCE(f.enabled,fu.enabled,FALSE),
    'version',COALESCE(f.version,0),'position',COALESCE(f.position,${INHERITED_FEATURED_POSITION}::bigint),
    'source',CASE WHEN f.content_id IS NOT NULL THEN 'work' WHEN fu.enabled THEN 'user' ELSE 'none' END) AS recommendation,
  community.work_is_public(w) AND u.status='active' AS publicly_visible,
  (SELECT json_build_object('revisionId',r.id,'title',r.title,'disposition',r.disposition)
   FROM community.work_revisions r WHERE r.work_id=w.id
   AND r.disposition<>'not_required' AND w.deleted_at IS NULL
   ORDER BY r.sequence DESC LIMIT 1) AS latest_submission
  FROM community.works w JOIN community.public_users u ON u.id=w.author_id
  LEFT JOIN community.featured_content f ON f.content_type='work' AND f.content_id=w.id
  LEFT JOIN community.featured_users fu ON fu.user_id=w.author_id`;
const workDto = (w: WorkRow): OperatorWork =>
  operatorWorkSchema.parse({
    id: w.id,
    title: w.title,
    text: w.text,
    authorId: w.author_id,
    authorName: w.display_name,
    authorStatus: w.author_status,
    state: w.operator_state,
    authorDeleted: w.deleted_at !== null,
    version: w.version,
    firstPublishedAt: w.first_published_at?.toISOString() ?? null,
    latestSubmission: w.latest_submission,
    publicRevisionId: w.deleted_at === null ? w.public_revision_id : null,
    publiclyVisible: w.publicly_visible,
    recommendation: w.recommendation,
  });
/** The canonical fingerprint of one operator command; the receipt is keyed by it. */
const commandFingerprint = (
  action: string,
  target: { type: string; id: string } | null,
  input: unknown,
): string =>
  createHash("sha256")
    .update(JSON.stringify([action, target, input]))
    .digest("hex");

export class PostgresCommunityContentOperatorAdapter implements CommunityContentOperatorPort {
  constructor(
    private readonly pool: Pool,
    private readonly options: {
      readonly publication?: PublicationSyncOptions;
    } = {},
  ) {}
  private async transaction<T>(
    run: (db: PoolClient) => Promise<T>,
    read = false,
  ): Promise<T> {
    const db = await this.pool.connect().catch((error) => {
      throw asCommunityOperationError(error, "connect");
    });
    try {
      await db.query(
        read ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN",
      );
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
  private mutate<T>(
    operator: string,
    requestId: string,
    action: string,
    target: { type: string; id: string } | null,
    input: unknown,
    /** `unchanged()` tells the audit that the command found nothing to change; the receipt is still kept. */
    change: (db: PoolClient, unchanged: () => void) => Promise<T>,
    /**
     * The execution attempt this mutation belongs to, when it belongs to one.
     * It is deliberately not part of `input`, so it never reaches the
     * fingerprint and a legitimate retry keeps its own business identity.
     */
    fence?: ExecutionFence,
  ): Promise<T> {
    return this.transaction(async (db) => {
      await db.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('phase4-content-operator',0))",
      );
      const fingerprint = commandFingerprint(action, target, input);
      const old = await db.query(
        "SELECT fingerprint,result FROM community.content_operator_receipts WHERE operator_label=$1 AND request_id=$2",
        [operator, requestId],
      );
      // The replay comes first, and deliberately before the fence: returning a
      // receipt creates no effect, so losing the right to execute must not stop
      // a caller reading back what it already committed. Refusing here would
      // turn a committed command into a reported conflict, which is the very
      // confusion this work exists to remove.
      if (old.rows[0]) {
        if (old.rows[0].fingerprint !== fingerprint)
          throw new CommunityConflictError("Request identity already used");
        if (old.rows[0].result?.permanentlyDeleted === true)
          throw new CommunityNotFoundError();
        return old.rows[0].result as T;
      }
      // Only a NEW effect needs the right to execute, and it is checked after
      // the lock wait, never before it: whoever waited here may have lost that
      // right while waiting. The operation row stays locked until this
      // transaction ends, so a cancellation or a take-over arriving now waits
      // for the outcome instead of concluding there is none.
      if (fence !== undefined)
        await assertExecutionFence(
          async (sql, values) => (await db.query(sql, [...values])).rows,
          fence,
        );
      let audit = true;
      const result = await change(db, () => {
        audit = false;
      });
      if (audit)
        await db.query(
          "INSERT INTO community.content_operator_events(id,operator_label,action,content_type,content_id,detail) VALUES($1,$2,$3,$4,$5,$6)",
          [
            randomUUID(),
            operator,
            action,
            target?.type ?? null,
            target?.id ?? null,
            JSON.stringify({ command: input, result }),
          ],
        );
      await db.query(
        "INSERT INTO community.content_operator_receipts(operator_label,request_id,fingerprint,result) VALUES($1,$2,$3,$4)",
        [operator, requestId, fingerprint, JSON.stringify(result)],
      );
      return result;
    });
  }
  async readWorkTitle(id: string): Promise<string | null> {
    return (
      (
        await this.pool
          .query("SELECT title FROM community.works WHERE id=$1", [id])
          .catch((error) => {
            throw asCommunityOperationError(error, "query");
          })
      ).rows[0]?.title ?? null
    );
  }
  /**
   * Works newest first by first publication, else first submission. Search
   * covers the public text and, for a pending or never-public work, the text
   * of the author's current revision when it requested public visibility
   * (content operators already see in the submission queue); self-only
   * content stays unsearchable.
   */
  async readWorks(query: OperatorWorksQuery): Promise<OperatorWorkPage> {
    return this.transaction(async (db) => {
      const where = ` LEFT JOIN community.work_revisions ar ON ar.id=w.author_revision_id AND ar.requested_visibility='public'
        WHERE ($1='' OR position(lower($1) in lower(w.id||' '||w.title||' '||w.text||' '||COALESCE(ar.title,'')||' '||COALESCE(ar.body,'')||' '||u.display_name||' '||u.handle))>0)
        AND ($2::text IS NULL OR (w.author_id=$2 AND w.deleted_at IS NULL AND EXISTS(SELECT 1 FROM community.work_revisions r WHERE r.work_id=w.id AND r.disposition<>'not_required')))`;
      const total = await db.query(
        `SELECT COUNT(*)::integer AS total FROM community.works w JOIN community.public_users u ON u.id=w.author_id${where}`,
        [query.search, query.authorId ?? null],
      );
      const rows = await db.query<WorkRow>(
        `${workProjection}${where} ORDER BY COALESCE(w.first_published_at,w.first_submitted_at,w.updated_at) DESC,w.id LIMIT $3 OFFSET $4`,
        [
          query.search,
          query.authorId ?? null,
          query.pageSize,
          (query.page - 1) * query.pageSize,
        ],
      );
      return operatorWorkPageSchema.parse({
        items: rows.rows.map(workDto),
        total: total.rows[0].total,
        page: query.page,
        pageSize: query.pageSize,
      });
    }, true);
  }
  async readUsers(query: OperatorUsersQuery): Promise<OperatorUserPage> {
    return this.transaction(async (db) => {
      const where = `WHERE ($1='' OR position(lower($1) in lower(u.id||' '||u.handle||' '||u.display_name))>0)
        AND ($2::text IS NULL OR u.id=$2)`;
      const args = [query.search, query.userId ?? null];
      const total = (
        await db.query(
          `SELECT COUNT(*)::integer AS total FROM community.public_users u ${where}`,
          args,
        )
      ).rows[0].total;
      const rows = await db.query(
        `SELECT u.id,u.handle,u.display_name,u.bio,u.status,u.created_at,
        COALESCE(f.enabled,FALSE) AS recommended,COALESCE(f.version,0) AS recommendation_version,
        (SELECT COUNT(*)::integer FROM community.works w WHERE w.author_id=u.id AND w.deleted_at IS NULL
          AND EXISTS(SELECT 1 FROM community.work_revisions r WHERE r.work_id=w.id AND r.disposition<>'not_required')) AS submitted_works
        FROM community.public_users u LEFT JOIN community.featured_users f ON f.user_id=u.id ${where}
        ORDER BY u.created_at DESC,u.id LIMIT $3 OFFSET $4`,
        [...args, query.pageSize, (query.page - 1) * query.pageSize],
      );
      return operatorUserPageSchema.parse({
        items: rows.rows.map((r) => ({
          id: r.id,
          handle: r.handle,
          displayName: r.display_name,
          bio: r.bio,
          status: r.status,
          createdAt: r.created_at.toISOString(),
          submittedWorks: r.submitted_works,
          recommended: r.recommended,
          recommendationVersion: r.recommendation_version,
        })),
        total,
        page: query.page,
        pageSize: query.pageSize,
      });
    }, true);
  }
  recommendUser(
    operator: string,
    input: RecommendUserCommand,
  ): Promise<{ version: number }> {
    return this.mutate(
      operator,
      input.requestId,
      "user.recommendation",
      { type: "user", id: input.id },
      input,
      async (db) => {
        if (
          !(
            await db.query("SELECT 1 FROM community.public_users WHERE id=$1", [
              input.id,
            ])
          ).rowCount
        )
          throw new CommunityNotFoundError();
        const row = (
          await db.query(
            "SELECT version FROM community.featured_users WHERE user_id=$1 FOR UPDATE",
            [input.id],
          )
        ).rows[0];
        if ((row?.version ?? 0) !== input.expectedVersion)
          throw new CommunityConflictError("User recommendation changed");
        const updated = await db.query(
          `INSERT INTO community.featured_users(user_id,enabled) VALUES($1,$2)
        ON CONFLICT(user_id) DO UPDATE SET enabled=EXCLUDED.enabled,version=community.featured_users.version+1 RETURNING version`,
          [input.id, input.enabled],
        );
        return { version: updated.rows[0].version };
      },
    );
  }
  async moderateWork(
    id: string,
    operator: string,
    input: ModerateWorkCommand,
  ): Promise<OperatorWork> {
    return this.mutate(
      operator,
      input.requestId,
      "work.moderate",
      { type: "work", id },
      input,
      async (db, unchanged) => {
        const before = (
          await db.query<WorkRow>(
            `${workProjection} WHERE w.id=$1 FOR UPDATE OF w`,
            [id],
          )
        ).rows[0];
        if (!before) throw new CommunityNotFoundError();
        if (before.deleted_at || before.version !== input.expectedVersion)
          throw new CommunityConflictError("Work changed or author deleted it");
        // Already in the requested state: no version bump and no audit event.
        if (before.operator_state === input.state) {
          unchanged();
          return workDto(before);
        }
        const at = (
          await db.query<{ at: Date }>("SELECT statement_timestamp() AS at")
        ).rows[0]!.at;
        const publicationSync = await beginWorkPublicationSync(
          db,
          id,
          this.options.publication,
        );
        const heldItems = await syncWorkHolds(
          db,
          id,
          input.state === "removed",
          at,
        );
        await db.query(
          "UPDATE community.works SET operator_state=$2,version=version+1,updated_at=statement_timestamp() WHERE id=$1",
          [id, input.state],
        );
        await publicationSync.finish(
          at,
          heldItems,
          input.state === "removed" ? "withdraw" : "publish",
        );
        return workDto(
          (await db.query<WorkRow>(`${workProjection} WHERE w.id=$1`, [id]))
            .rows[0]!,
        );
      },
    );
  }
  async readFeatured(query: OperatorFeaturedQuery): Promise<FeaturedPage> {
    return this.transaction(async (db) => {
      const from = `FROM effective_featured f LEFT JOIN catalog_discovery c ON f.content_type='catalog' AND c.catalog_id=f.content_id LEFT JOIN community.works w ON f.content_type='work' AND w.id=f.content_id LEFT JOIN community.public_users u ON u.id=w.author_id`;
      const eligible =
        "CASE WHEN f.content_type='catalog' THEN c.catalog_id IS NOT NULL ELSE w.id IS NOT NULL AND community.work_is_public(w) AND u.status='active' END";
      const where =
        " WHERE ($1='' OR position(lower($1) in lower(COALESCE(c.title,w.title,f.content_id)))>0)" +
        ` AND ($2::text='all' OR (f.enabled AND ${eligible}))`;
      const total = (
        await db.query(
          `WITH ${effectiveFeatured} SELECT COUNT(*)::integer AS total ${from}${where}`,
          [query.search, query.filter ?? "all"],
        )
      ).rows[0].total;
      const rows = await db.query(
        `WITH ${effectiveFeatured} SELECT f.*,COALESCE(c.title,w.title) AS title,${eligible} AS eligible ${from}${where} ORDER BY f.position,f.content_type,f.content_id LIMIT $3 OFFSET $4`,
        [
          query.search,
          query.filter ?? "all",
          query.pageSize,
          (query.page - 1) * query.pageSize,
        ],
      );
      const settings = (
        await db.query(
          "SELECT enabled_quantity,version FROM community.featured_settings WHERE id=TRUE",
        )
      ).rows[0];
      return featuredPageSchema.parse({
        items: rows.rows.map((r) => ({
          target: { type: r.content_type, id: r.content_id },
          title: r.title,
          eligible: r.eligible,
          enabled: r.enabled,
          position: Number(r.position),
          version: r.version,
        })),
        total,
        page: query.page,
        pageSize: query.pageSize,
        enabledQuantity:
          settings.enabled_quantity === null
            ? null
            : Number(settings.enabled_quantity),
        settingsVersion: settings.version,
      });
    }, true);
  }
  async setFeatured(
    operator: string,
    input: FeaturedMutation,
  ): Promise<{ version: number }> {
    return this.mutate(
      operator,
      input.requestId,
      "featured.set",
      input.target,
      input,
      async (db) => {
        const row = (
          await db.query(
            "SELECT version FROM community.featured_content WHERE content_type=$1 AND content_id=$2 FOR UPDATE",
            [input.target.type, input.target.id],
          )
        ).rows[0];
        if ((row?.version ?? 0) !== input.expectedVersion)
          throw new CommunityConflictError("Featured membership changed");
        if (!row) {
          const exists = await db.query(
            input.target.type === "catalog"
              ? "SELECT catalog_id FROM catalog_discovery WHERE catalog_id=$1"
              : "SELECT id FROM community.works WHERE id=$1",
            [input.target.id],
          );
          if (!exists.rows.length) throw new CommunityNotFoundError();
        }
        // Featuring is a public exposure: a work that is not effectively
        // public (self-only, pending first submission, trashed, hidden,
        // removed or by an inactive author) cannot be enabled.
        if (
          input.target.type === "work" &&
          input.enabled &&
          (
            await db.query(
              "SELECT 1 FROM community.works w JOIN community.public_users u ON u.id=w.author_id WHERE w.id=$1 AND community.work_is_public(w) AND u.status='active' FOR SHARE OF w",
              [input.target.id],
            )
          ).rowCount !== 1
        )
          throw new CommunityConflictError(
            "Only a public work can be featured",
          );
        const updated = await db.query(
          "INSERT INTO community.featured_content(content_type,content_id,enabled,position) VALUES($1,$2,$3,$4) ON CONFLICT(content_type,content_id) DO UPDATE SET enabled=EXCLUDED.enabled,position=EXCLUDED.position,version=community.featured_content.version+1 RETURNING version",
          [input.target.type, input.target.id, input.enabled, input.position],
        );
        return { version: updated.rows[0].version };
      },
    );
  }
  /**
   * One ordered recommendation command. `mutate` already gives this the only
   * three things atomicity needs: one pooled connection, one transaction, and
   * the content-operator advisory lock that every other command on this
   * surface also takes — so two overlapping ordered commands serialize against
   * each other instead of interleaving, and the loser sees the winner's
   * versions and refuses whole. Inside it every requested row is re-checked
   * against the version the caller froze and against the same eligibility rule
   * a single write uses, then written; one audit event per target keeps the
   * existing per-target trail, and `mutate` adds the command's own
   * `featured.order` event and its authoritative receipt. Any refusal throws
   * before COMMIT, so a partial order cannot survive.
   */
  async setFeaturedOrder(
    operator: string,
    input: FeaturedOrderCommand,
    fence?: ExecutionFence,
  ): Promise<FeaturedOrderResult> {
    return this.mutate(
      operator,
      input.requestId,
      "featured.order",
      null,
      input,
      async (db) => {
        const items: FeaturedOrderEntry[] = [];
        for (const item of input.items) {
          const row = (
            await db.query<{
              enabled: boolean;
              position: string;
              version: number;
            }>(
              "SELECT enabled,position,version FROM community.featured_content WHERE content_type=$1 AND content_id=$2 FOR UPDATE",
              [item.target.type, item.target.id],
            )
          ).rows[0];
          if ((row?.version ?? 0) !== item.expectedVersion)
            throw new CommunityConflictError(
              `Featured membership changed for ${item.target.type} ${item.target.id}`,
            );
          if (!row) {
            const exists = await db.query(
              item.target.type === "catalog"
                ? "SELECT catalog_id FROM catalog_discovery WHERE catalog_id=$1"
                : "SELECT id FROM community.works WHERE id=$1",
              [item.target.id],
            );
            if (!exists.rows.length) throw new CommunityNotFoundError();
          }
          // Recommending is a public exposure and never a way to gain one: a
          // work that is not effectively public cannot be enabled, and nothing
          // here changes a work's publication or visibility to make it so.
          if (
            item.target.type === "work" &&
            item.enabled &&
            (
              await db.query(
                "SELECT 1 FROM community.works w JOIN community.public_users u ON u.id=w.author_id WHERE w.id=$1 AND community.work_is_public(w) AND u.status='active' FOR SHARE OF w",
                [item.target.id],
              )
            ).rowCount !== 1
          )
            throw new CommunityConflictError(
              `Only a public work can be featured: ${item.target.id}`,
            );
          const updated = await db.query<{ version: number }>(
            "INSERT INTO community.featured_content(content_type,content_id,enabled,position) VALUES($1,$2,$3,$4) ON CONFLICT(content_type,content_id) DO UPDATE SET enabled=EXCLUDED.enabled,position=EXCLUDED.position,version=community.featured_content.version+1 RETURNING version",
            [item.target.type, item.target.id, item.enabled, item.position],
          );
          await db.query(
            "INSERT INTO community.content_operator_events(id,operator_label,action,content_type,content_id,detail) VALUES($1,$2,$3,$4,$5,$6)",
            [
              randomUUID(),
              operator,
              "featured.set",
              item.target.type,
              item.target.id,
              JSON.stringify({
                command: { ...item, requestId: input.requestId },
                result: { version: updated.rows[0]!.version },
              }),
            ],
          );
          items.push({
            target: item.target,
            enabled: item.enabled,
            position: item.position,
            version: updated.rows[0]!.version,
            prior:
              row === undefined
                ? null
                : {
                    enabled: row.enabled,
                    position: Number(row.position),
                    version: row.version,
                  },
          });
        }
        return { kind: "featured.order" as const, items };
      },
      fence,
    );
  }

  /**
   * The exact command's own receipt. It writes nothing, but it takes the same
   * advisory lock the command takes, because the answer is only meaningful
   * once no command is in flight: an unfenced read of an uncommitted
   * transaction returns nothing, and a caller that treats nothing as proof
   * that nothing committed would call a live command cancelled. Blocking here
   * is the point.
   */
  async findFeaturedOrder(
    operator: string,
    input: FeaturedOrderCommand,
  ): Promise<FeaturedOrderResult | null> {
    const fingerprint = commandFingerprint("featured.order", null, input);
    // READ COMMITTED on purpose: `transaction(..., true)` would open the
    // snapshot before `pg_advisory_xact_lock` is granted, so the receipt SELECT
    // would read the moment the reader arrived rather than the moment the
    // command finished, and the fence below would be silently defeated.
    return this.transaction(async (db) => {
      await db.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('phase4-content-operator',0))",
      );
      const row = (
        await db.query<{ fingerprint: string; result: unknown }>(
          "SELECT fingerprint,result FROM community.content_operator_receipts WHERE operator_label=$1 AND request_id=$2",
          [operator, input.requestId],
        )
      ).rows[0];
      return row === undefined || row.fingerprint !== fingerprint
        ? null
        : featuredOrderResultSchema.parse(row.result);
    });
  }

  async setFeaturedQuantity(
    operator: string,
    input: FeaturedSettingsMutation,
  ): Promise<{ version: number }> {
    return this.mutate(
      operator,
      input.requestId,
      "featured.quantity",
      null,
      input,
      async (db) => {
        const row = (
          await db.query(
            "SELECT version FROM community.featured_settings WHERE id=TRUE FOR UPDATE",
          )
        ).rows[0];
        if (row.version !== input.expectedVersion)
          throw new CommunityConflictError("Featured settings changed");
        const updated = await db.query(
          "UPDATE community.featured_settings SET enabled_quantity=$1,version=version+1 WHERE id=TRUE RETURNING version",
          [input.enabledQuantity],
        );
        return { version: updated.rows[0].version };
      },
    );
  }
}
