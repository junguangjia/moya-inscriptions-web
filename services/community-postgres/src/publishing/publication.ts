import { randomUUID } from "node:crypto";
import type {
  MediaPublicationFence,
  MediaPublicationPlan,
  MediaPublicationPort,
  MediaPublicationUnit,
  PublishingJobLease,
} from "@moya/api";
import type { Pool } from "pg";
import {
  nowParam,
  readTransaction,
  safeInteger,
  writeTransaction,
  type PublishingDb,
} from "./db.js";
import {
  catalogBlockListedSql,
  desiredRenditionsSql,
} from "./publication-eligibility.js";
import {
  refreshPublicationReferences,
  type PublicationSyncOptions,
} from "./publication-sync.js";
import { insertJob } from "./jobs.js";
import {
  lockCatalogPublicationDirty,
  markCatalogPublicationDirty,
  type CatalogPublicationDirtyMark,
} from "./catalog-publication-dirty.js";

const hex = (): string => randomUUID().replaceAll("-", "");
const take = (limit: number): number =>
  Math.max(1, Math.min(500, Math.trunc(limit)));
const errorCode = (code: string): string =>
  /^[a-z][a-z0-9_]{0,63}$/u.test(code) ? code : "publication_failure";
const LEASE = "interval '10 minutes'";
const CATALOG_CONTEXT_STALE = Symbol("catalog-context-stale");
interface Asset {
  id: string;
  item_id: string | null;
  catalog_asset_id: string | null;
  desired_seq: string;
  lease_job_id: string | null;
  lease_job_owner: string | null;
  lease_sequence: string | null;
  lease_expires_at: Date | null;
}
interface UnitRow {
  id: string;
  public_asset_id: string;
  rendition_id: string | null;
  object_key: string;
  storage_key: string;
  content_type: MediaPublicationUnit["contentType"];
  purpose: MediaPublicationUnit["purpose"];
  byte_size: string;
  sha256: string;
  role: string;
  edit_key: string;
  purge_task_ids: string[];
  withdraw_requested_at: Date | null;
  purge_attempts: number;
  sweep_task_ids: string[];
  sweep_started_at: Date | null;
  sweep_attempts: number;
  origin_deleted_at: Date | null;
  fallback_ttl_seconds: number | null;
}
interface Desired {
  rendition_id: string;
  item_id: string | null;
  catalog_asset_id: string | null;
  storage_key: string;
  content_type: MediaPublicationUnit["contentType"];
  purpose: MediaPublicationUnit["purpose"];
  byte_size: string;
  sha256: string;
  role: string;
  edit_key: string;
  recipe_version: number;
}
const unitOf = (p: UnitRow): MediaPublicationUnit => ({
  id: p.id,
  assetId: p.public_asset_id,
  renditionId: p.rendition_id,
  objectKey: p.object_key,
  storageKey: p.storage_key,
  contentType: p.content_type,
  purpose: p.purpose,
  byteSize: safeInteger(p.byte_size),
  sha256: p.sha256,
  role: p.role,
  editKey: p.edit_key,
  purgeTaskIds: p.purge_task_ids,
  withdrawRequestedAt: p.withdraw_requested_at,
  purgeAttempts: p.purge_attempts,
  sweepTaskIds: p.sweep_task_ids,
  sweepStartedAt: p.sweep_started_at,
  sweepAttempts: p.sweep_attempts,
  originDeletedAt: p.origin_deleted_at,
  fallbackTtlSeconds: p.fallback_ttl_seconds,
});
/** SQL: publication row alias is a Catalog block (catalog-deep-zoom-v1). */
const blockRowSql = (row: string): string => `${row}.role ~ '^block-[0-9]{2}$'`;
const subjects = "COALESCE(a.item_id,a.catalog_asset_id)";
/** SQL: subject expression `s` has a queued or running publication job. */
const activeJobSql = (s: string): string =>
  `EXISTS (SELECT 1 FROM community.publishing_jobs j WHERE j.subject_id=${s} AND j.kind IN ('publish_media','withdraw_media','verify_withdrawal') AND j.state IN ('queued','running'))`;

/**
 * catalog-scale-v1 (Issue #323) 1B W7: the Catalog assets one reconcile pass
 * plans at most (K). Its scope is the assets it must plan now (the priority
 * part: urgent marks first, then the assets with publications in flight the
 * pass acts on, then the other marks, each class oldest mark first), a tenth
 * of K (at least) from the rolling sweep over every Catalog asset, and the
 * rest of K from the sweep. While both wait, in flight and dirty each get at
 * least half of the room after the sweep's share. Planned in the order: the
 * priority part's first CATALOG_RECONCILE_RESERVED, the sweep's share, the
 * rest of the priority part, the rest of the sweep. So a pass costs about K,
 * never the Catalog, an urgent mark (a takedown) waits behind at most the
 * earlier urgent ones, any other behind the earlier marks and every urgent
 * one, and a whole round of the sweep bounds the time any asset waits.
 */
export const CATALOG_RECONCILE_SCOPE = 1_000;
/** The first assets of the priority part, and of the sweep's share, that a
 * pass attempts whatever its budget: one batch of the authority's planning
 * (CATALOG_SCOPE_BATCH) each. A slow batch, of either part, thus never keeps
 * a pass from planning the oldest urgent marks or from moving the sweep on;
 * the pass then ends at most about one batch past its budget (a failed
 * reserved batch is retried asset by asset only that far, planScope). */
export const CATALOG_RECONCILE_RESERVED = 100;
/** How long one pass plans its scope. With its reads before and its
 * transaction after, a pass ends within about 15 s: well inside the 120 s
 * lease of the withdraw lane it runs in, so takedown jobs never wait long
 * behind it. */
export const CATALOG_RECONCILE_BUDGET_MS = 14_000;
const RENDITION_ID = /^media-rendition-[a-f0-9]{32}$/u;

/** SQL: Catalog asset expression `s` has a pending mark. */
const pendingMarkSql = (s: string): string =>
  `EXISTS (SELECT 1 FROM community.catalog_publication_dirty d WHERE d.asset_id=${s} AND d.mark_seq>d.cleared_seq)`;
/** The scope's assets with publications in flight that the pass acts on
 * whatever their plan, through A1's partial index: a withdrawal with purge
 * attempts left (retried), and, while publication is not allowed (`$2`
 * false), a publishing generation (withdrawn). While it is allowed, a
 * publishing generation counts as present, as it always has: one whose job
 * ran out of attempts is never acted on again while desired, so it never
 * takes a slot here, and one no longer desired is marked or swept, as a
 * published one is. An asset with a pending mark waits in the queue instead,
 * so one a pass acted on (it keeps a mark, see settleCatalogScope) or could
 * not plan leaves this part, and a fixed run of ids never holds it. `$1` is
 * the limit. */
const CATALOG_IN_FLIGHT_SQL = `SELECT DISTINCT a.catalog_asset_id AS id FROM community.media_publications p JOIN community.media_public_assets a ON a.id=p.public_asset_id WHERE p.state IN ('publishing','withdrawing','purge_failed') AND ((p.state='publishing' AND NOT $2::boolean) OR (p.state<>'publishing' AND p.purge_attempts<3)) AND a.catalog_asset_id IS NOT NULL AND NOT ${pendingMarkSql("a.catalog_asset_id")} AND NOT ${activeJobSql("a.catalog_asset_id")} ORDER BY 1 LIMIT $1`;
/** The scope's dirty assets, urgent marks first and each class oldest mark
 * first, through A1's partial index; `$1` is the limit. None is in the
 * in-flight part, which leaves out every asset with a pending mark (the two
 * reads share a snapshot). */
const CATALOG_PENDING_SQL = `SELECT d.asset_id AS id,d.urgent FROM community.catalog_publication_dirty d WHERE d.mark_seq>d.cleared_seq AND NOT ${activeJobSql("d.asset_id")} ORDER BY d.urgent DESC,d.marked_at,d.asset_id LIMIT $1`;

/** One pass's Catalog scope, read before it is planned. */
interface CatalogScope {
  /** Planning order: the priority part's first CATALOG_RECONCILE_RESERVED
   * (urgent marks, in flight, other marks), the sweep's share, the rest of
   * the priority part, the sweep's rest. */
  readonly order: readonly string[];
  /** The leading assets of `order` planned whatever the budget: the
   * priority part's first and the sweep share's first
   * CATALOG_RECONCILE_RESERVED. */
  readonly reserved: number;
  /** The sweep's assets in its order, from the cursor (then from the start
   * when the end came first). */
  readonly sweep: readonly string[];
  /** The cursor the sweep started after (null: the start of a round). */
  readonly sweepFrom: string | null;
  /** Whether the sweep's read reached every asset (the round is done). */
  readonly sweepDone: boolean;
  /** The pending mark_seq of each asset in the scope that has one, as read
   * before planning. */
  readonly marks: ReadonlyMap<string, string>;
}

/**
 * The scoped reconcile's statement (catalog-scale-v1 W7). One aggregate pass
 * per relation instead of correlated EXISTS per subject: the subjects whose
 * desired renditions lack a live publication (`missing`), each subject's live
 * and in-flight publications folded once (`live`), then per subject whether
 * it needs a publish or a withdrawal and whether a job is already queued or
 * running for it. The decisions are those of the statement it replaces.
 * With `scope` (the SQL text of a text[] parameter), only the scope's Catalog
 * assets are subjects, next to every UGC subject as before: a Catalog asset
 * outside the scope is never a candidate, to publish or to withdraw. The UGC
 * candidates come first, at most `$1`; then every scoped Catalog asset, with
 * its flags, whether it needs work or not. Without `scope` every subject is a
 * candidate, at most `$1` in all, as before.
 */
const reconcileSql = (desired: string, scope: string | null): string => {
  const subjectsSql = scope
    ? `SELECT d.item_id AS subject_id,d.item_id,NULL::text AS catalog_asset_id FROM desired d WHERE d.item_id IS NOT NULL
      UNION SELECT a.item_id,a.item_id,NULL::text FROM community.media_public_assets a WHERE a.item_id IS NOT NULL
      UNION SELECT s.id,NULL::text,s.id FROM unnest(${scope}::text[]) AS s(id)`
    : `SELECT COALESCE(d.item_id,d.catalog_asset_id) AS subject_id,d.item_id,d.catalog_asset_id FROM desired d
      UNION SELECT ${subjects},a.item_id,a.catalog_asset_id FROM community.media_public_assets a`;
  const assetsSql = scope
    ? `SELECT a.id,a.item_id,a.catalog_asset_id FROM community.media_public_assets a WHERE a.item_id IS NOT NULL
      UNION ALL SELECT a.id,a.item_id,a.catalog_asset_id FROM community.media_public_assets a WHERE a.catalog_asset_id=ANY(${scope}::text[])`
    : `SELECT a.id,a.item_id,a.catalog_asset_id FROM community.media_public_assets a`;
  return `WITH desired AS (${desired}), subjects AS (
      ${subjectsSql}
    ), missing AS (
      SELECT DISTINCT COALESCE(d.item_id,d.catalog_asset_id) AS subject_id FROM desired d
      WHERE NOT EXISTS (SELECT 1 FROM community.media_publications p WHERE p.rendition_id=d.rendition_id AND p.state IN ('publishing','published'))
    ), live AS (
      SELECT ${subjects} AS subject_id,
        bool_or(p.state IN ('publishing','published') AND (w.rendition_id IS NULL OR (p.state='publishing' AND NOT $2::boolean))) AS fence_change,
        bool_or(p.state IN ('withdrawing','purge_failed') AND p.purge_attempts<3) AS retry
      FROM (${assetsSql}) a
      JOIN community.media_publications p ON p.public_asset_id=a.id AND p.state IN ('publishing','published','withdrawing','purge_failed')
      LEFT JOIN (SELECT DISTINCT d.rendition_id FROM desired d) w ON w.rendition_id=p.rendition_id
      GROUP BY 1
    ), candidates AS (
      SELECT s.subject_id,s.item_id,s.catalog_asset_id,m.subject_id IS NOT NULL AS publish,
        COALESCE(l.fence_change OR l.retry,false) AS withdraw,COALESCE(l.fence_change,false) AS fence_change,
        ${activeJobSql("s.subject_id")} AS active
      FROM subjects s LEFT JOIN missing m ON m.subject_id=s.subject_id LEFT JOIN live l ON l.subject_id=s.subject_id
    )
    SELECT * FROM (SELECT * FROM candidates WHERE NOT active AND (($2::boolean AND publish) OR withdraw)${scope ? " AND item_id IS NOT NULL" : ""} ORDER BY subject_id LIMIT $1) due${
      scope
        ? `
    UNION ALL SELECT * FROM candidates WHERE catalog_asset_id IS NOT NULL`
        : ""
    }`;
};

/** The App pool owns state. There are no object-store calls in this adapter. */
export class PostgresMediaPublicationAdapter implements MediaPublicationPort {
  constructor(
    private readonly pool: Pool,
    private readonly options: PublicationSyncOptions & {
      catalogAuthority?: NonNullable<MediaPublicationPort["catalogAuthority"]>;
      /** The scoped reconcile's K and planning budget (defaults
       * CATALOG_RECONCILE_SCOPE and CATALOG_RECONCILE_BUDGET_MS). */
      catalogScope?: { readonly max?: number; readonly budgetMs?: number };
    },
  ) {
    const scope = options.catalogScope;
    if (
      scope?.max !== undefined &&
      (!Number.isSafeInteger(scope.max) || scope.max < 2 || scope.max > 10_000)
    )
      throw new TypeError("A Catalog reconcile scope is 2..10000 assets");
    if (
      scope?.budgetMs !== undefined &&
      (!Number.isFinite(scope.budgetMs) || scope.budgetMs <= 0)
    )
      throw new TypeError("A Catalog reconcile budget is positive");
  }

  /** Each Catalog job's source fence (its asset's capture), by job lease,
   * with the subject it was acquired for. */
  private readonly catalogLeases = new Map<
    string,
    {
      readonly subject: string;
      readonly renditionIds: readonly string[];
      current(): Promise<boolean>;
      authorized(): Promise<boolean>;
      release(): Promise<void>;
    }
  >();
  private jobKey(job: PublishingJobLease) {
    return `${job.id}:${job.leaseOwner}`;
  }
  private async holdCatalog(subject: string, job: PublishingJobLease) {
    if (!this.options.catalogAuthority || !subject.startsWith("catalog-asset-"))
      return true;
    const key = this.jobKey(job);
    if (this.catalogLeases.has(key))
      throw new Error("Catalog job already holds a source fence");
    try {
      const lease = await this.options.catalogAuthority.acquire(subject);
      this.catalogLeases.set(key, {
        subject,
        renditionIds: lease.renditionIds,
        current: () => lease.current(),
        authorized: () => lease.authorized(),
        release: () => lease.release(),
      });
      return true;
    } catch (error) {
      if ((error as { code?: unknown })?.code === "55P03") return false;
      throw error;
    }
  }
  private async releaseCatalog(job: PublishingJobLease) {
    const key = this.jobKey(job);
    const lease = this.catalogLeases.get(key);
    this.catalogLeases.delete(key);
    await lease?.release();
  }
  private async catalogCurrent(
    subject: string | null,
    job: PublishingJobLease,
  ) {
    return !this.options.catalogAuthority ||
      !subject?.startsWith("catalog-asset-")
      ? true
      : (await this.catalogLeases.get(this.jobKey(job))?.current()) === true;
  }
  async hasRegisteredPublications(): Promise<boolean> {
    return readTransaction(this.pool, async (db) => {
      const result = await db.query<{ registered: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM community.media_publications) AS registered",
      );
      return result.rows[0]!.registered;
    });
  }

  private async liveJob(
    db: PublishingDb,
    job: PublishingJobLease,
    now: Date,
  ): Promise<boolean> {
    return (
      (
        await db.query(
          "SELECT id FROM community.publishing_jobs WHERE id=$1 AND state='running' AND lease_owner=$2 AND lease_expires_at>$3::timestamptz FOR SHARE",
          [job.id, job.leaseOwner, nowParam(now)],
        )
      ).rowCount === 1
    );
  }
  /** The desired set as SQL, and the values it binds after the caller's own
   * (`$${at}` on). With a Catalog authority its selected rendition IDs are
   * one text[] parameter: never spliced into the SQL as literals, so the
   * selector has no count ceiling (catalog-scale-v1 W1). The caller names
   * them (a job its own capture's, the reconcile its copy set); there is no
   * whole-Catalog fallback (W5). A malformed ID is still refused before any
   * query. */
  private async desiredSql(
    db: PublishingDb,
    at: number,
    catalogIds?: readonly string[],
  ): Promise<{ sql: string; values: unknown[] }> {
    if (this.options.catalogAuthority) {
      if (catalogIds === undefined)
        throw new Error("Catalog selection unavailable");
      if (catalogIds.some((id) => !/^media-rendition-[a-f0-9]{32}$/.test(id)))
        throw new Error("Catalog selector invalid");
      return {
        sql: desiredRenditionsSql(false, `r.id=ANY($${at}::text[])`),
        values: [[...catalogIds]],
      };
    }
    const exists = (
      await db.query<{ available: boolean }>(
        "SELECT to_regclass('public.catalog_media') IS NOT NULL AS available",
      )
    ).rows[0]!.available;
    return { sql: desiredRenditionsSql(exists), values: [] };
  }
  private async desired(
    db: PublishingDb,
    asset: Asset,
    allow: boolean,
    job: PublishingJobLease,
  ): Promise<Desired[]> {
    if (!allow) return [];
    let catalogIds: readonly string[] | undefined;
    if (this.options.catalogAuthority) {
      catalogIds = [];
      if (asset.catalog_asset_id) {
        // A Catalog subject's desired set is its own job's capture, bound to
        // its fence, and nothing else: no whole-Catalog plan stands in for a
        // missing one (catalog-scale-v1 W5). Without it the job fails this
        // attempt and retries. Reconcile uses its own copy set solely to
        // schedule jobs.
        const lease = this.catalogLeases.get(this.jobKey(job));
        if (lease?.subject !== asset.catalog_asset_id)
          throw new Error("Catalog subject holds no source fence");
        if (!(await lease.authorized())) return [];
        catalogIds = lease.renditionIds;
      }
    }
    const desired = await this.desiredSql(db, 3, catalogIds);
    return (
      await db.query<Desired>(
        `SELECT d.* FROM (${desired.sql}) d WHERE d.item_id=$1 OR d.catalog_asset_id=$2 ORDER BY d.rendition_id`,
        [asset.item_id, asset.catalog_asset_id, ...desired.values],
      )
    ).rows;
  }
  private async acquire(
    db: PublishingDb,
    subjectId: string,
    job: PublishingJobLease,
    now: Date,
    intent: "publish" | "withdraw",
  ): Promise<Asset | null | "busy"> {
    if (!(await this.liveJob(db, job, now))) return "busy";
    const asset = (
      await db.query<Asset>(
        `SELECT a.* FROM community.media_public_assets a WHERE ${subjects}=$1 FOR UPDATE OF a`,
        [subjectId],
      )
    ).rows[0];
    if (!asset) return null;
    if (
      asset.lease_job_id !== null &&
      !(
        asset.lease_job_id === job.id &&
        asset.lease_job_owner === job.leaseOwner
      )
    ) {
      const holderLive =
        (
          await db.query(
            "SELECT id FROM community.publishing_jobs WHERE id=$1 AND state='running' AND lease_owner=$2 AND lease_expires_at>$3::timestamptz",
            [asset.lease_job_id, asset.lease_job_owner, nowParam(now)],
          )
        ).rowCount === 1;
      const expired =
        asset.lease_expires_at === null ||
        asset.lease_expires_at.getTime() <= now.getTime();
      // A newer withdrawal preempts an old copy; the old worker fails every subsequent fence.
      const superseded =
        intent === "withdraw" && asset.lease_sequence !== asset.desired_seq;
      if (holderLive && !expired && !superseded) return "busy";
    }
    // The App row lock may have waited across a Native lifecycle/expiry change.
    // A stale captured context is busy, never an empty stable permission set.
    if (!(await this.catalogCurrent(asset.catalog_asset_id, job)))
      return "busy";
    await db.query(
      `UPDATE community.media_public_assets SET lease_job_id=$2,lease_job_owner=$3,lease_sequence=desired_seq,lease_expires_at=$4::timestamptz+${LEASE},updated_at=$4::timestamptz WHERE id=$1`,
      [asset.id, job.id, job.leaseOwner, nowParam(now)],
    );
    return asset;
  }
  private fence(
    asset: Asset,
    job: PublishingJobLease,
    intent: "publish" | "withdraw",
    ids: readonly string[],
  ): MediaPublicationFence {
    return {
      assetId: asset.id,
      sequence: asset.desired_seq,
      job,
      intent,
      unitIds: ids,
    };
  }
  private async current(
    db: PublishingDb,
    fence: MediaPublicationFence,
    now: Date,
  ): Promise<Asset | null> {
    if (
      fence.intent === "publish" &&
      (!this.options.isPublic() || !this.options.allowPublish())
    )
      return null;
    if (!(await this.liveJob(db, fence.job, now))) return null;
    const a = (
      await db.query<Asset>(
        `SELECT * FROM community.media_public_assets WHERE id=$1 AND desired_seq=$2::bigint AND lease_sequence=$2::bigint AND lease_job_id=$3 AND lease_job_owner=$4 AND lease_expires_at>$5::timestamptz FOR UPDATE`,
        [
          fence.assetId,
          fence.sequence,
          fence.job.id,
          fence.job.leaseOwner,
          nowParam(now),
        ],
      )
    ).rows[0];
    if (!a) return null;
    if (
      a.catalog_asset_id &&
      this.options.catalogAuthority &&
      !(await this.catalogLeases.get(this.jobKey(fence.job))?.current())
    )
      return null;
    if (fence.intent === "publish") {
      if (
        a.catalog_asset_id &&
        this.options.catalogAuthority &&
        !(await this.catalogLeases.get(this.jobKey(fence.job))?.authorized())
      )
        return null;
      const desired = await this.desired(
        db,
        a,
        this.options.isPublic(),
        fence.job,
      );
      const present = (
        await db.query<{ rendition_id: string }>(
          "SELECT rendition_id FROM community.media_publications WHERE id=ANY($1::text[]) AND public_asset_id=$2 AND state IN ('publishing','published')",
          [fence.unitIds, a.id],
        )
      ).rows;
      const wanted = new Set(desired.map((r) => r.rendition_id));
      if (
        present.length !== fence.unitIds.length ||
        present.some((r) => !wanted.has(r.rendition_id)) ||
        !this.options.isPublic() ||
        !this.options.allowPublish()
      )
        return null;
    }
    await db.query(
      `UPDATE community.media_public_assets SET lease_expires_at=$2::timestamptz+${LEASE} WHERE id=$1`,
      [a.id, nowParam(now)],
    );
    return a;
  }
  async planPublish(
    subjectId: string,
    job: PublishingJobLease,
    now: Date,
  ): Promise<MediaPublicationPlan> {
    if (!this.options.isPublic() || !this.options.allowPublish())
      return { status: "disabled" };
    if (!(await this.holdCatalog(subjectId, job))) return { status: "busy" };
    try {
      if (!(await this.catalogCurrent(subjectId, job))) {
        await this.releaseCatalog(job);
        return { status: "busy" };
      }
      const plan = await writeTransaction<MediaPublicationPlan>(
        this.pool,
        async (db) => {
          if (!this.options.isPublic() || !this.options.allowPublish())
            return { status: "disabled" };
          const a = await this.acquire(db, subjectId, job, now, "publish");
          if (a === "busy") return { status: "busy" };
          if (!a) return { status: "missing" };
          const desired = await this.desired(db, a, true, job);
          if (!(await this.catalogCurrent(a.catalog_asset_id, job)))
            throw CATALOG_CONTEXT_STALE;
          const token = hex();
          for (const r of desired) {
            const existing = await db.query(
              "SELECT id FROM community.media_publications WHERE rendition_id=$1 AND state IN ('publishing','published')",
              [r.rendition_id],
            );
            if (existing.rowCount) continue;
            const ext =
              r.content_type === "image/webp"
                ? "webp"
                : r.content_type === "image/jpeg"
                  ? "jpg"
                  : "mp4";
            const key = `v1/${a.id}/${token}/${r.edit_key}/${r.role}.r${r.recipe_version}.${ext}`;
            await db.query(
              `INSERT INTO community.media_publications(id,public_asset_id,rendition_id,generation_token,object_key,storage_key,content_type,purpose,byte_size,sha256,role,edit_key,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::bigint,$10,$11,$12,$13::timestamptz)`,
              [
                `media-publication-${hex()}`,
                a.id,
                r.rendition_id,
                token,
                key,
                r.storage_key,
                r.content_type,
                r.purpose,
                r.byte_size,
                r.sha256,
                r.role,
                r.edit_key,
                nowParam(now),
              ],
            );
          }
          const rows = (
            await db.query<UnitRow>(
              "SELECT * FROM community.media_publications WHERE public_asset_id=$1 AND state='publishing' AND rendition_id=ANY($2::text[]) ORDER BY id",
              [a.id, desired.map((r) => r.rendition_id)],
            )
          ).rows;
          // The gate is evaluated again immediately before committing the registered plan.
          if (!this.options.isPublic() || !this.options.allowPublish())
            throw new Error("Publication mode changed while planning");
          return {
            status: "ready",
            fence: this.fence(
              a,
              job,
              "publish",
              rows.map((r) => r.id),
            ),
            units: rows.map(unitOf),
          };
        },
      );
      if (plan.status !== "ready") await this.releaseCatalog(job);
      return plan;
    } catch (error) {
      await this.releaseCatalog(job);
      if (error === CATALOG_CONTEXT_STALE) return { status: "busy" };
      throw error;
    }
  }
  async planWithdrawal(
    subjectId: string,
    job: PublishingJobLease,
    now: Date,
  ): Promise<MediaPublicationPlan> {
    if (!(await this.holdCatalog(subjectId, job))) return { status: "busy" };
    try {
      if (!(await this.catalogCurrent(subjectId, job))) {
        await this.releaseCatalog(job);
        return { status: "busy" };
      }
      const plan = await writeTransaction<MediaPublicationPlan>(
        this.pool,
        async (db) => {
          const a = await this.acquire(db, subjectId, job, now, "withdraw");
          if (a === "busy") return { status: "busy" };
          if (!a) return { status: "missing" };
          const desired = await this.desired(
            db,
            a,
            this.options.isPublic(),
            job,
          );
          if (!(await this.catalogCurrent(a.catalog_asset_id, job)))
            throw CATALOG_CONTEXT_STALE;
          await db.query(
            `UPDATE community.media_publications SET state='withdrawing',withdraw_requested_at=COALESCE(withdraw_requested_at,$3::timestamptz),version=version+1 WHERE public_asset_id=$1 AND (state='purge_failed' OR (state IN ('publishing','published') AND (NOT (rendition_id=ANY($2::text[])) OR (state='publishing' AND NOT $4::boolean))))`,
            [
              a.id,
              desired.map((r) => r.rendition_id),
              nowParam(now),
              this.options.allowPublish(),
            ],
          );
          const rows = (
            await db.query<UnitRow>(
              "SELECT * FROM community.media_publications WHERE public_asset_id=$1 AND state='withdrawing' ORDER BY id",
              [a.id],
            )
          ).rows;
          return {
            status: "ready",
            fence: this.fence(
              a,
              job,
              "withdraw",
              rows.map((r) => r.id),
            ),
            units: rows.map(unitOf),
          };
        },
      );
      if (plan.status !== "ready") await this.releaseCatalog(job);
      return plan;
    } catch (error) {
      await this.releaseCatalog(job);
      if (error === CATALOG_CONTEXT_STALE) return { status: "busy" };
      throw error;
    }
  }
  async isCurrent(fence: MediaPublicationFence, now: Date): Promise<boolean> {
    return writeTransaction(
      this.pool,
      async (db) => (await this.current(db, fence, now)) !== null,
    );
  }
  async finishPublish(
    fence: MediaPublicationFence,
    now: Date,
  ): Promise<boolean> {
    return writeTransaction(this.pool, async (db) => {
      const a = await this.current(db, fence, now);
      if (!a || fence.intent !== "publish") return false;
      const desired = await this.desired(
        db,
        a,
        this.options.isPublic(),
        fence.job,
      );
      const rows = (
        await db.query<UnitRow>(
          "SELECT * FROM community.media_publications WHERE public_asset_id=$1 AND id=ANY($2::text[]) AND state='publishing' FOR UPDATE",
          [a.id, fence.unitIds],
        )
      ).rows;
      const wanted = new Map(desired.map((r) => [r.rendition_id, r]));
      if (
        rows.length !== fence.unitIds.length ||
        rows.some((p) => {
          const r =
            p.rendition_id === null ? undefined : wanted.get(p.rendition_id);
          return (
            !r ||
            p.storage_key !== r.storage_key ||
            p.sha256 !== r.sha256 ||
            p.byte_size !== r.byte_size ||
            p.purpose !== r.purpose ||
            p.content_type !== r.content_type
          );
        })
      )
        return false;
      if (!this.options.isPublic() || !this.options.allowPublish())
        return false;
      await db.query(
        "UPDATE community.media_publications SET state='published',published_at=$2::timestamptz,version=version+1 WHERE id=ANY($1::text[])",
        [fence.unitIds, nowParam(now)],
      );
      await db.query(
        "UPDATE community.media_public_assets SET synced_seq=desired_seq,updated_at=$2::timestamptz WHERE id=$1",
        [a.id, nowParam(now)],
      );
      return true;
    });
  }
  private async mutateWithdrawal(
    fence: MediaPublicationFence,
    ids: readonly string[],
    now: Date,
    sql: string,
    args: readonly unknown[],
  ): Promise<boolean> {
    if (
      fence.intent !== "withdraw" ||
      ids.some((id) => !fence.unitIds.includes(id))
    )
      return false;
    return writeTransaction(this.pool, async (db) => {
      if (!(await this.current(db, fence, now))) return false;
      await db.query("SAVEPOINT publication_units");
      const changed = await db.query(sql, [
        ids,
        nowParam(now),
        ...args,
        fence.assetId,
      ]);
      if (changed.rowCount !== ids.length) {
        await db.query("ROLLBACK TO SAVEPOINT publication_units");
        return false;
      }
      await db.query("RELEASE SAVEPOINT publication_units");
      return true;
    });
  }
  async recordOriginDeleted(
    fence: MediaPublicationFence,
    ids: readonly string[],
    now: Date,
  ): Promise<boolean> {
    return this.mutateWithdrawal(
      fence,
      ids,
      now,
      "UPDATE community.media_publications SET origin_deleted_at=COALESCE(origin_deleted_at,$2::timestamptz),version=version+1 WHERE id=ANY($1::text[]) AND public_asset_id=$3 AND state='withdrawing'",
      [],
    );
  }
  async recordPurge(
    fence: MediaPublicationFence,
    ids: readonly string[],
    taskIds: readonly string[],
    now: Date,
  ): Promise<boolean> {
    if (taskIds.length === 0) return false;
    return this.mutateWithdrawal(
      fence,
      ids,
      now,
      "UPDATE community.media_publications SET purge_task_ids=$3::text[],purge_attempts=purge_attempts+1,purge_submitted_at=$2::timestamptz,version=version+1 WHERE id=ANY($1::text[]) AND public_asset_id=$4 AND state='withdrawing' AND origin_deleted_at IS NOT NULL AND purge_attempts<3",
      [taskIds],
    );
  }
  async finishWithdrawal(
    fence: MediaPublicationFence,
    ids: readonly string[],
    now: Date,
  ): Promise<boolean> {
    return this.mutateWithdrawal(
      fence,
      ids,
      now,
      "UPDATE community.media_publications SET state='withdrawn',verified_at=$2::timestamptz,version=version+1 WHERE id=ANY($1::text[]) AND public_asset_id=$3 AND state='withdrawing' AND origin_deleted_at IS NOT NULL",
      [],
    );
  }
  async failPurge(
    fence: MediaPublicationFence,
    ids: readonly string[],
    code: string,
    now: Date,
  ): Promise<boolean> {
    return this.mutateWithdrawal(
      fence,
      ids,
      now,
      `UPDATE community.media_publications SET state='purge_failed',withdraw_requested_at=COALESCE(withdraw_requested_at,$2::timestamptz),purge_attempts=LEAST(3,purge_attempts+1),last_error_code=$3,fallback_ttl_seconds=CASE WHEN ${blockRowSql("media_publications")} THEN fallback_ttl_seconds ELSE COALESCE(fallback_ttl_seconds,3600) END,version=version+1 WHERE id=ANY($1::text[]) AND public_asset_id=$4 AND state='withdrawing'`,
      [errorCode(code)],
    );
  }
  async blockPurgesSince(since: Date): Promise<number> {
    return readTransaction(this.pool, async (db) => {
      const result = await db.query<{ submitted: string }>(
        `SELECT count(*) AS submitted FROM community.media_publications p
         WHERE ${blockRowSql("p")} AND p.purge_submitted_at IS NOT NULL
           AND p.purge_submitted_at >= $1::timestamptz`,
        [nowParam(since)],
      );
      return safeInteger(result.rows[0]!.submitted);
    });
  }
  async deferBlockWithdrawal(
    fence: MediaPublicationFence,
    ids: readonly string[],
    ttlSeconds: number,
    now: Date,
    code:
      | "block_budget_deferred"
      | "block_purge_unconfirmed" = "block_budget_deferred",
  ): Promise<boolean> {
    if (
      !Number.isSafeInteger(ttlSeconds) ||
      ttlSeconds < 60 ||
      ttlSeconds > 86_400
    )
      throw new TypeError("A forced edge TTL is 60..86400 seconds");
    if (code !== "block_budget_deferred" && code !== "block_purge_unconfirmed")
      throw new TypeError("Unknown block deferral code");
    return this.mutateWithdrawal(
      fence,
      ids,
      now,
      `UPDATE community.media_publications p SET purge_task_ids='{}',fallback_ttl_seconds=$3,last_error_code=$4,withdraw_requested_at=COALESCE(p.withdraw_requested_at,$2::timestamptz),version=version+1 WHERE p.id=ANY($1::text[]) AND p.public_asset_id=$5 AND p.state='withdrawing' AND p.origin_deleted_at IS NOT NULL AND ${blockRowSql("p")}`,
      [ttlSeconds, code],
    );
  }
  async release(fence: MediaPublicationFence, now: Date): Promise<void> {
    try {
      await writeTransaction(this.pool, async (db) => {
        await db.query(
          "UPDATE community.media_public_assets SET lease_job_id=NULL,lease_job_owner=NULL,lease_sequence=NULL,lease_expires_at=NULL,updated_at=$5::timestamptz WHERE id=$1 AND lease_sequence=$2::bigint AND lease_job_id=$3 AND lease_job_owner=$4",
          [
            fence.assetId,
            fence.sequence,
            fence.job.id,
            fence.job.leaseOwner,
            nowParam(now),
          ],
        );
      });
    } finally {
      await this.releaseCatalog(fence.job);
    }
  }
  /**
   * The Catalog scope of one reconcile pass (catalog-scale-v1 W7), read
   * before it is planned. Up to K assets: the priority part, which is the
   * urgent marks, then the assets with publications in flight the pass acts
   * on (`allow` is whether it may publish), then the other marks, each class
   * oldest mark first; the sweep's share (a tenth of K); and the rest of K
   * from the sweep. In flight and dirty share the room after the sweep's
   * share: each gets at least half of it while the other fills its own half,
   * and whatever one leaves unused. The planning order puts the priority
   * part's first CATALOG_RECONCILE_RESERVED first and the sweep's share
   * next; those and the share's first CATALOG_RECONCILE_RESERVED (the
   * reserved part) are attempted whatever the time budget, a failed batch
   * among them asset by asset until about one batch past it (planScope): a
   * slow batch never keeps a takedown waiting for the sweep to reach it, and
   * a priority backlog never starves the sweep. An asset whose publication
   * job is queued or running is left for after the job (in flight or dirty;
   * a dirty one keeps its mark and its place). The sweep reads asset ids
   * after its cursor, from the start again once it reaches the end, skipping
   * the assets already in the scope.
   */
  private async catalogScope(
    max: number,
    allow: boolean,
  ): Promise<CatalogScope> {
    return readTransaction(this.pool, async (db) => {
      const share = Math.ceil(max / 10);
      const state = await db.query<{ sweep_cursor: string | null }>(
        "SELECT sweep_cursor FROM community.catalog_reconcile_state WHERE id",
      );
      if (state.rowCount !== 1)
        throw new Error("Catalog reconcile state unavailable");
      const from = state.rows[0]!.sweep_cursor;
      const ids = async (sql: string, values: readonly unknown[]) =>
        (await db.query<{ id: string }>(sql, [...values])).rows.map(
          (row) => row.id,
        );
      const shared = max - share;
      const inFlight = await ids(CATALOG_IN_FLIGHT_SQL, [shared, allow]);
      const dirty = (
        await db.query<{ id: string; urgent: boolean }>(CATALOG_PENDING_SQL, [
          shared - Math.min(inFlight.length, Math.floor(shared / 2)),
        ])
      ).rows;
      const priority = [
        ...dirty.filter((row) => row.urgent).map((row) => row.id),
        ...inFlight.slice(0, shared - dirty.length),
        ...dirty.filter((row) => !row.urgent).map((row) => row.id),
      ];
      const room = max - priority.length;
      const first = await ids(
        from === null
          ? "SELECT a.id FROM community.catalog_media_assets a WHERE NOT (a.id=ANY($1::text[])) ORDER BY a.id LIMIT $2"
          : "SELECT a.id FROM community.catalog_media_assets a WHERE a.id>$3 AND NOT (a.id=ANY($1::text[])) ORDER BY a.id LIMIT $2",
        from === null ? [priority, room] : [priority, room, from],
      );
      const wrap =
        from !== null && first.length < room
          ? await ids(
              "SELECT a.id FROM community.catalog_media_assets a WHERE a.id<=$3 AND NOT (a.id=ANY($1::text[])) ORDER BY a.id LIMIT $2",
              [priority, room - first.length, from],
            )
          : [];
      const sweep = [...first, ...wrap];
      const head = priority.slice(0, CATALOG_RECONCILE_RESERVED);
      const order = [
        ...head,
        ...sweep.slice(0, share),
        ...priority.slice(head.length),
        ...sweep.slice(share),
      ];
      const marks = new Map(
        order.length
          ? (
              await db.query<{ asset_id: string; mark_seq: string }>(
                "SELECT asset_id,mark_seq FROM community.catalog_publication_dirty WHERE asset_id=ANY($1::text[]) AND mark_seq>cleared_seq",
                [order],
              )
            ).rows.map((row) => [row.asset_id, String(row.mark_seq)])
          : [],
      );
      return {
        order,
        reserved:
          head.length +
          Math.min(share, sweep.length, CATALOG_RECONCILE_RESERVED),
        sweep,
        sweepFrom: from,
        sweepDone:
          first.length < room &&
          (from === null || wrap.length < room - first.length),
        marks,
      };
    });
  }

  /**
   * What a scoped pass leaves for the next ones (catalog-scale-v1 W7), in its
   * own transaction after its publication writes. Of the assets it planned
   * completely, one that got a job, or whose job was already queued or
   * running, keeps or gets a mark, so the pass after the job plans it again
   * (the old set retired after a replacement is published (N3), its intents'
   * public generations recorded, a failed job tried again); every other one
   * has exactly the mark it had before planning cleared. An asset whose plan
   * failed stays marked. Every mark the pass leaves goes to the back of its
   * class, at the pass's time, behind every mark of that class made before
   * the pass: a re-plan after a job never runs ahead of a newer takedown, so
   * a queue of first marks drains at the dirty share of K a pass. A mark it
   * leaves is normal unless it was urgent: A1's mark never downgrades a
   * pending urgent mark. One the budget did not reach is left as it is. The
   * sweep cursor moves past the sweep assets attempted, to the start of a new
   * round once every asset was, and also when the recipe policy changed;
   * unless another pass moved it meanwhile.
   */
  private async settleCatalogScope(
    db: PublishingDb,
    scope: CatalogScope,
    planned: {
      readonly policy: string;
      readonly plans: ReadonlyMap<string, readonly string[]>;
      readonly failed: readonly string[];
    },
    flags: ReadonlyMap<string, { readonly active: boolean }>,
    scheduled: ReadonlySet<string>,
    state: {
      readonly sweep_cursor: string | null;
      readonly policy_digest: string | null;
    },
    now: Date,
  ): Promise<void> {
    const keep: string[] = [];
    const clear: [string, string][] = [];
    for (const id of planned.plans.keys()) {
      const flag = flags.get(id);
      if (!flag) throw new Error("Catalog reconcile scope incomplete");
      const seq = scope.marks.get(id);
      if (scheduled.has(id) || flag.active) keep.push(id);
      else if (seq !== undefined) clear.push([id, seq]);
    }
    const requeue = planned.failed.filter((id) => scope.marks.has(id));
    keep.push(...planned.failed.filter((id) => !scope.marks.has(id)));
    const touched = [
      ...new Set([...keep, ...requeue, ...clear.map(([id]) => id)]),
    ].sort();
    // Every row this pass writes, held by one statement in asset_id order
    // (step 3 of catalog-publication-dirty's lock order, after the state row
    // the pass already holds), including the rows of assets never marked,
    // which it creates cleared: the writes below wait for no other row.
    await lockCatalogPublicationDirty(db, touched, now);
    if (clear.length)
      await db.query(
        "UPDATE community.catalog_publication_dirty d SET cleared_seq=c.seq FROM unnest($1::text[],$2::bigint[]) AS c(id,seq) WHERE d.asset_id=c.id AND d.mark_seq=c.seq",
        [clear.map(([id]) => id), clear.map(([, seq]) => seq)],
      );
    await markCatalogPublicationDirty(
      db,
      new Map<string, CatalogPublicationDirtyMark>(
        keep.map((id) => [id, { reason: "publication", urgent: false }]),
      ),
      now,
    );
    // A mark that stays pending keeps its place and its class (A1's mark),
    // so the ones this pass leaves are moved to the back here.
    const back = [...keep, ...requeue].sort();
    if (back.length)
      await db.query(
        "UPDATE community.catalog_publication_dirty SET marked_at=$2::timestamptz WHERE asset_id=ANY($1::text[]) AND mark_seq>cleared_seq",
        [back, nowParam(now)],
      );
    if (state.sweep_cursor !== scope.sweepFrom) return;
    const attempted = new Set([...planned.plans.keys(), ...planned.failed]);
    let swept = 0;
    while (swept < scope.sweep.length && attempted.has(scope.sweep[swept]!))
      swept += 1;
    // A pass under a recipe policy other than the one recorded starts a new
    // round; the first pass records its policy and keeps its progress.
    const cursor =
      (state.policy_digest !== null &&
        state.policy_digest !== planned.policy) ||
      (swept === scope.sweep.length && scope.sweepDone)
        ? null
        : swept > 0
          ? scope.sweep[swept - 1]!
          : scope.sweepFrom;
    if (cursor === state.sweep_cursor && state.policy_digest === planned.policy)
      return;
    const updated = await db.query(
      "UPDATE community.catalog_reconcile_state SET sweep_cursor=$1,policy_digest=$2,updated_at=$3::timestamptz WHERE id",
      [cursor, planned.policy, nowParam(now)],
    );
    if (updated.rowCount !== 1)
      throw new Error("Catalog reconcile state unavailable");
  }

  async reconcile(
    now: Date,
    allowPublish: boolean,
    limit: number,
  ): Promise<{ publish: number; withdraw: number }> {
    // With a Catalog authority the pass plans a bounded scope of Catalog
    // assets before its transaction, each from its own facts
    // (catalog-scale-v1 W7); no whole-Catalog plan is read. While the
    // Catalog is not public nothing is desired, so nothing is planned and
    // every subject is a candidate, as before.
    const authority = this.options.catalogAuthority;
    let scoped:
      | {
          readonly scope: CatalogScope;
          readonly planned: Awaited<
            ReturnType<
              NonNullable<MediaPublicationPort["catalogAuthority"]>["planScope"]
            >
          >;
        }
      | undefined;
    if (authority && this.options.isPublic()) {
      // Whether the pass may publish, as its transaction reads it again
      // below: a change in between only defers an in-flight asset a pass.
      const scope = await this.catalogScope(
        this.options.catalogScope?.max ?? CATALOG_RECONCILE_SCOPE,
        allowPublish && this.options.allowPublish(),
      );
      const planned = await authority.planScope(scope.order, {
        budgetMs:
          this.options.catalogScope?.budgetMs ?? CATALOG_RECONCILE_BUDGET_MS,
        reserved: scope.reserved,
      });
      const ordered = new Set(scope.order);
      for (const [id, ids] of planned.plans)
        if (
          !ordered.has(id) ||
          ids.some((renditionId) => !RENDITION_ID.test(renditionId))
        )
          throw new Error("Catalog selector invalid");
      if (planned.failed.some((id) => !ordered.has(id)))
        throw new Error("Catalog selector invalid");
      scoped = { scope, planned };
    }
    return writeTransaction(this.pool, async (db) => {
      const isPublic = this.options.isPublic();
      const allow = allowPublish && isPublic && this.options.allowPublish();
      // A pass that planned while public is scoped; should the Catalog stop
      // being public meanwhile, it is a pass over every subject, as before.
      const scope = isPublic ? scoped : undefined;
      // Two scoped passes (a lease that lapsed under a slow one) write one
      // after the other, and the membership step's fingerprint write waits
      // for the pass: the state row is the first lock of every transaction
      // that writes it and the dirty queue (catalog-publication-dirty).
      const state = scope
        ? await db.query<{
            sweep_cursor: string | null;
            policy_digest: string | null;
          }>(
            "SELECT sweep_cursor,policy_digest FROM community.catalog_reconcile_state WHERE id FOR UPDATE",
          )
        : undefined;
      if (state && state.rowCount !== 1)
        throw new Error("Catalog reconcile state unavailable");
      const planned = scope ? [...scope.planned.plans.keys()].sort() : [];
      const desired = !isPublic
        ? {
            sql: `SELECT r.id AS rendition_id,r.item_id,r.catalog_asset_id FROM community.media_renditions r WHERE false`,
            values: [] as unknown[],
          }
        : scope
          ? {
              // Every UGC rendition as before, and the planned Catalog
              // renditions of the scope's own assets only.
              sql: `SELECT * FROM (${desiredRenditionsSql(false)}) u UNION ALL SELECT d.* FROM (${desiredRenditionsSql(false, "r.id=ANY($3::text[])")}) d WHERE d.rendition_id=ANY($3::text[]) AND d.catalog_asset_id=ANY($4::text[])`,
              values: [
                [...new Set([...scope.planned.plans.values()].flat())],
                planned,
              ] as unknown[],
            }
          : await this.desiredSql(db, 3);
      const rows = (
        await db.query<{
          subject_id: string;
          item_id: string | null;
          catalog_asset_id: string | null;
          publish: boolean;
          withdraw: boolean;
          fence_change: boolean;
          active: boolean;
        }>(reconcileSql(desired.sql, scope ? "$4" : null), [
          take(limit),
          allow,
          ...desired.values,
        ])
      ).rows;
      // Scoped, the Catalog rows are every planned asset with its flags;
      // those that need a job and have none are due, all of them (at most
      // K), next to the UGC ones within the limit.
      const due = rows.filter(
        (s) =>
          s.item_id !== null ||
          (!s.active && ((allow && s.publish) || s.withdraw)),
      );
      const publishing =
        allow && this.options.allowPublish()
          ? due.filter((s) => s.publish)
          : [];
      const changing = due.filter((s) => s.withdraw && s.fence_change);
      // Batched union locks cover the whole reconcile transaction, not per-subject subsets.
      await refreshPublicationReferences(
        db,
        {
          publishItemIds: publishing.flatMap((s) =>
            s.item_id ? [s.item_id] : [],
          ),
          publishCatalogIds: publishing.flatMap((s) =>
            s.catalog_asset_id ? [s.catalog_asset_id] : [],
          ),
          withdrawItemIds: changing.flatMap((s) =>
            s.item_id ? [s.item_id] : [],
          ),
          withdrawCatalogIds: changing.flatMap((s) =>
            s.catalog_asset_id ? [s.catalog_asset_id] : [],
          ),
        },
        now,
        this.options,
      );
      const touched = new Set(
        [...publishing, ...changing].map((s) => s.subject_id),
      );
      for (const s of due)
        if (s.withdraw && !touched.has(s.subject_id))
          await insertJob(
            db,
            { kind: "withdraw_media", subjectId: s.subject_id, maxAttempts: 3 },
            now,
          );
      if (scope && state)
        await this.settleCatalogScope(
          db,
          scope.scope,
          scope.planned,
          new Map(
            rows.flatMap((s) =>
              s.catalog_asset_id ? [[s.catalog_asset_id, s] as const] : [],
            ),
          ),
          new Set(
            due.flatMap((s) =>
              s.catalog_asset_id ? [s.catalog_asset_id] : [],
            ),
          ),
          state.rows[0]!,
          now,
        );
      const publish = publishing.length,
        withdraw = due.filter((s) => s.withdraw).length;
      return { publish, withdraw };
    });
  }
  async sweepCandidates(
    now: Date,
    limit: number,
  ): Promise<readonly MediaPublicationUnit[]> {
    return writeTransaction(this.pool, async (db) => {
      const rows = (
        await db.query<UnitRow>(
          // Catalog blocks are swept once; every other row hourly, as before.
          `SELECT * FROM community.media_publications p WHERE p.state='withdrawn' AND p.sweep_attempts<3 AND (p.sweep_started_at IS NOT NULL OR p.swept_at IS NULL OR (p.swept_at<$1::timestamptz-interval '1 hour' AND NOT ${blockRowSql("p")})) ORDER BY COALESCE(p.sweep_started_at,p.swept_at,p.created_at),p.id FOR UPDATE SKIP LOCKED LIMIT $2`,
          [nowParam(now), take(limit)],
        )
      ).rows;
      // Persist the need to verify/purge BEFORE HEAD/Delete; crash recovery cannot forget a deleted zombie.
      if (rows.length)
        await db.query(
          "UPDATE community.media_publications SET sweep_started_at=COALESCE(sweep_started_at,$2::timestamptz) WHERE id=ANY($1::text[])",
          [rows.map((r) => r.id), nowParam(now)],
        );
      return rows.map((r) =>
        unitOf({ ...r, sweep_started_at: r.sweep_started_at ?? now }),
      );
    });
  }
  async recordSweepPurge(
    ids: readonly string[],
    taskIds: readonly string[],
    now: Date,
  ): Promise<void> {
    if (taskIds.length === 0)
      throw new TypeError("Purge task ids are required");
    await writeTransaction(this.pool, async (db) => {
      await db.query(
        "UPDATE community.media_publications SET sweep_task_ids=$2::text[],sweep_attempts=sweep_attempts+1,sweep_started_at=COALESCE(sweep_started_at,$3::timestamptz) WHERE id=ANY($1::text[]) AND state='withdrawn' AND sweep_attempts<3",
        [ids, taskIds, nowParam(now)],
      );
    });
  }
  async recordSweepFailure(
    ids: readonly string[],
    code: string,
    now: Date,
  ): Promise<void> {
    await writeTransaction(this.pool, async (db) => {
      await db.query(
        "UPDATE community.media_publications SET sweep_task_ids='{}',sweep_attempts=LEAST(3,sweep_attempts+1),last_error_code=$2,fallback_ttl_seconds=3600,sweep_started_at=COALESCE(sweep_started_at,$3::timestamptz) WHERE id=ANY($1::text[]) AND state='withdrawn'",
        [ids, errorCode(code), nowParam(now)],
      );
    });
  }
  async recordSweep(ids: readonly string[], now: Date): Promise<void> {
    await writeTransaction(this.pool, async (db) => {
      await db.query(
        "UPDATE community.media_publications SET swept_at=$2::timestamptz,sweep_started_at=NULL,sweep_task_ids='{}',sweep_attempts=0 WHERE id=ANY($1::text[]) AND state='withdrawn'",
        [ids, nowParam(now)],
      );
    });
  }
  async recordRequestUsage(
    usage: { start: Date; end: Date; requests: number; warning: boolean },
    now: Date,
  ): Promise<void> {
    if (!Number.isSafeInteger(usage.requests) || usage.requests < 0)
      throw new TypeError("Invalid request usage");
    await writeTransaction(this.pool, async (db) => {
      await db.query(
        "INSERT INTO community.media_request_usage(id,month_start,period_end,requests,warning,observed_at) VALUES('published-media',$1::timestamptz,$2::timestamptz,$3::bigint,$4,$5::timestamptz) ON CONFLICT(id) DO UPDATE SET month_start=EXCLUDED.month_start,period_end=EXCLUDED.period_end,requests=EXCLUDED.requests,warning=EXCLUDED.warning,observed_at=EXCLUDED.observed_at",
        [
          nowParam(usage.start),
          nowParam(usage.end),
          usage.requests,
          usage.warning,
          nowParam(now),
        ],
      );
    });
  }
  async recordDayUsage(
    usage: { dayStart: Date; requests: number; bytes: number | null },
    now: Date,
  ): Promise<boolean> {
    if (
      !Number.isSafeInteger(usage.requests) ||
      usage.requests < 0 ||
      (usage.bytes !== null &&
        (!Number.isSafeInteger(usage.bytes) || usage.bytes < 0))
    )
      throw new TypeError("Invalid day usage");
    return writeTransaction(this.pool, async (db) => {
      const result = await db.query(
        "UPDATE community.media_request_usage SET day_start=$1::timestamptz,day_requests=$2::bigint,day_bytes=$3::bigint,day_observed_at=$4::timestamptz WHERE id='published-media'",
        [nowParam(usage.dayStart), usage.requests, usage.bytes, nowParam(now)],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }
  async readDayUsage(): Promise<{
    dayStart: Date;
    requests: number;
    bytes: number | null;
    observedAt: Date;
  } | null> {
    return readTransaction(this.pool, async (db) => {
      const row = (
        await db.query<{
          day_start: Date | null;
          day_requests: string | null;
          day_bytes: string | null;
          day_observed_at: Date | null;
        }>(
          "SELECT day_start,day_requests,day_bytes,day_observed_at FROM community.media_request_usage WHERE id='published-media'",
        )
      ).rows[0];
      if (
        row === undefined ||
        row.day_start === null ||
        row.day_requests === null ||
        row.day_observed_at === null
      )
        return null;
      return {
        dayStart: new Date(row.day_start),
        requests: safeInteger(row.day_requests),
        bytes: row.day_bytes === null ? null : safeInteger(row.day_bytes),
        observedAt: new Date(row.day_observed_at),
      };
    });
  }
  async lookupPublishedItems(
    itemIds: readonly string[],
    _now: Date,
  ): Promise<ReadonlyMap<string, string>> {
    void _now; // Eligibility is the current database projection.
    if (!this.options.isPublic() || !itemIds.length) return new Map();
    return readTransaction(this.pool, async (db) => {
      const desired = await this.desiredSql(db, 2, []);
      const rows = (
        await db.query<{
          item_id: string;
          role: string;
          edit_key: string;
          object_key: string;
        }>(
          `SELECT a.item_id,p.role,p.edit_key,p.object_key FROM community.media_publications p JOIN community.media_public_assets a ON a.id=p.public_asset_id JOIN (${desired.sql}) d ON d.rendition_id=p.rendition_id WHERE p.state='published' AND a.item_id=ANY($1::text[])`,
          [itemIds, ...desired.values],
        )
      ).rows;
      return this.options.isPublic()
        ? new Map(
            rows.map((p) => [
              `/api/community/publishing/media/${p.item_id}/${p.role}/${p.edit_key}`,
              p.object_key,
            ]),
          )
        : new Map();
    });
  }
  async lookupPublishedCatalog(
    renditionIds: readonly string[],
    _now: Date,
  ): Promise<ReadonlyMap<string, string>> {
    void _now;
    if (!this.options.isPublic() || !renditionIds.length) return new Map();
    if (!this.options.catalogAuthority)
      return readTransaction(this.pool, async (db) => {
        const desired = await this.desiredSql(db, 2);
        const rows = (
          await db.query<{ rendition_id: string; object_key: string }>(
            `SELECT p.rendition_id,p.object_key FROM community.media_publications p JOIN (${desired.sql}) d ON d.rendition_id=p.rendition_id WHERE p.state='published' AND p.rendition_id=ANY($1::text[]) AND d.catalog_asset_id IS NOT NULL`,
            [renditionIds, ...desired.values],
          )
        ).rows;
        return new Map(rows.map((row) => [row.rendition_id, row.object_key]));
      });
    const ids = this.options.catalogAuthority
      ? await this.options.catalogAuthority.publishedAssetIds(
          (
            await this.pool.query<{ catalog_asset_id: string }>(
              "SELECT DISTINCT catalog_asset_id FROM community.media_renditions WHERE id=ANY($1::text[]) AND catalog_asset_id IS NOT NULL",
              [renditionIds],
            )
          ).rows.map((r) => r.catalog_asset_id),
        )
      : undefined;
    // No live Catalog asset among them: nothing can resolve, so the App is
    // not read again (catalog-scale-v1 1A).
    if (ids?.length === 0) return new Map();
    return readTransaction(this.pool, async (db) => {
      const rows = (
        await db.query<{ rendition_id: string; object_key: string }>(
          `SELECT p.rendition_id,p.object_key FROM community.media_publications p
          JOIN community.media_renditions r ON r.id=p.rendition_id
          JOIN community.media_blobs b ON b.id=r.blob_id AND b.state='committed' AND b.sha256=p.sha256 AND b.byte_size=p.byte_size
          JOIN community.catalog_media_assets a ON a.id=r.catalog_asset_id AND a.state='ready'
          WHERE p.state='published' AND p.rendition_id=ANY($1::text[]) AND ($2::text[] IS NULL OR a.id=ANY($2::text[]))
          -- An editorial set a re-render released keeps resolving while it is
          -- still published: the projection serves it until its replacement is.
          AND (r.state='ready' OR EXISTS(SELECT 1 FROM community.catalog_delivery_rendition_pins pin WHERE pin.rendition_id=r.id AND pin.public_generation_id=p.id AND pin.public_generation_version=p.version)
            OR (a.source_object_key LIKE 'editorial/%' AND r.role IN ('thumb','cover','display','viewer')))
          AND ((r.catalog_master_id IS NULL AND NOT (${blockRowSql("r")}) AND (a.source_object_key NOT LIKE 'editorial/%' OR r.role IN ('thumb','cover','display','viewer')))
            OR (r.state='ready' AND r.catalog_master_id IS NOT NULL AND ${catalogBlockListedSql("r")}))`,
          [renditionIds, ids ?? null],
        )
      ).rows;
      return this.options.isPublic()
        ? new Map(rows.map((p) => [p.rendition_id, p.object_key]))
        : new Map();
    });
  }
}
