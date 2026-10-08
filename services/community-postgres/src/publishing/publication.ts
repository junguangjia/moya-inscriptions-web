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
import { desiredRenditionsSql } from "./publication-eligibility.js";
import {
  refreshPublicationReferences,
  type PublicationSyncOptions,
} from "./publication-sync.js";
import { insertJob } from "./jobs.js";

const hex = (): string => randomUUID().replaceAll("-", "");
const take = (limit: number): number =>
  Math.max(1, Math.min(500, Math.trunc(limit)));
const errorCode = (code: string): string =>
  /^[a-z][a-z0-9_]{0,63}$/u.test(code) ? code : "publication_failure";
const LEASE = "interval '10 minutes'";
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
});
const subjects = "COALESCE(a.item_id,a.catalog_asset_id)";

/** The App pool owns state. There are no object-store calls in this adapter. */
export class PostgresMediaPublicationAdapter implements MediaPublicationPort {
  constructor(
    private readonly pool: Pool,
    private readonly options: PublicationSyncOptions,
  ) {}

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
  private async desiredSql(db: PublishingDb): Promise<string> {
    const exists = (
      await db.query<{ available: boolean }>(
        "SELECT to_regclass('public.catalog_media') IS NOT NULL AS available",
      )
    ).rows[0]!.available;
    return desiredRenditionsSql(exists);
  }
  private async desired(
    db: PublishingDb,
    asset: Asset,
    allow: boolean,
  ): Promise<Desired[]> {
    if (!allow) return [];
    return (
      await db.query<Desired>(
        `SELECT d.* FROM (${await this.desiredSql(db)}) d WHERE d.item_id=$1 OR d.catalog_asset_id=$2 ORDER BY d.rendition_id`,
        [asset.item_id, asset.catalog_asset_id],
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
    if (fence.intent === "publish") {
      const desired = await this.desired(db, a, this.options.isPublic());
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
    return writeTransaction<MediaPublicationPlan>(this.pool, async (db) => {
      if (!this.options.isPublic() || !this.options.allowPublish())
        return { status: "disabled" };
      const a = await this.acquire(db, subjectId, job, now, "publish");
      if (a === "busy") return { status: "busy" };
      if (!a) return { status: "missing" };
      const desired = await this.desired(db, a, true);
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
    });
  }
  async planWithdrawal(
    subjectId: string,
    job: PublishingJobLease,
    now: Date,
  ): Promise<MediaPublicationPlan> {
    return writeTransaction<MediaPublicationPlan>(this.pool, async (db) => {
      const a = await this.acquire(db, subjectId, job, now, "withdraw");
      if (a === "busy") return { status: "busy" };
      if (!a) return { status: "missing" };
      const desired = await this.desired(db, a, this.options.isPublic());
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
    });
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
      const desired = await this.desired(db, a, this.options.isPublic());
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
      "UPDATE community.media_publications SET state='purge_failed',withdraw_requested_at=COALESCE(withdraw_requested_at,$2::timestamptz),purge_attempts=LEAST(3,purge_attempts+1),last_error_code=$3,fallback_ttl_seconds=3600,version=version+1 WHERE id=ANY($1::text[]) AND public_asset_id=$4 AND state='withdrawing'",
      [errorCode(code)],
    );
  }
  async release(fence: MediaPublicationFence, now: Date): Promise<void> {
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
  }
  async reconcile(
    now: Date,
    allowPublish: boolean,
    limit: number,
  ): Promise<{ publish: number; withdraw: number }> {
    return writeTransaction(this.pool, async (db) => {
      const allow =
        allowPublish && this.options.isPublic() && this.options.allowPublish();
      const desired = this.options.isPublic()
        ? await this.desiredSql(db)
        : `SELECT r.id AS rendition_id,r.item_id,r.catalog_asset_id FROM community.media_renditions r WHERE false`;
      const rows = (
        await db.query<{
          subject_id: string;
          item_id: string | null;
          catalog_asset_id: string | null;
          publish: boolean;
          withdraw: boolean;
          fence_change: boolean;
        }>(
          `WITH desired AS (${desired}), wanted AS (SELECT DISTINCT COALESCE(d.item_id,d.catalog_asset_id) AS subject_id,d.item_id,d.catalog_asset_id FROM desired d), subjects AS (
        SELECT w.subject_id,w.item_id,w.catalog_asset_id FROM wanted w UNION SELECT ${subjects},a.item_id,a.catalog_asset_id FROM community.media_public_assets a
      ) , candidates AS (SELECT s.*, EXISTS(SELECT 1 FROM desired d WHERE COALESCE(d.item_id,d.catalog_asset_id)=s.subject_id AND NOT EXISTS(SELECT 1 FROM community.media_publications p WHERE p.rendition_id=d.rendition_id AND p.state IN ('publishing','published'))) AS publish,
        EXISTS(SELECT 1 FROM community.media_public_assets a JOIN community.media_publications p ON p.public_asset_id=a.id WHERE ${subjects}=s.subject_id AND ((p.state IN ('publishing','published') AND (NOT EXISTS(SELECT 1 FROM desired d WHERE d.rendition_id=p.rendition_id) OR (p.state='publishing' AND NOT $2::boolean))) OR (p.state IN ('withdrawing','purge_failed') AND p.purge_attempts<3))) AS withdraw,
        EXISTS(SELECT 1 FROM community.media_public_assets a JOIN community.media_publications p ON p.public_asset_id=a.id WHERE ${subjects}=s.subject_id AND p.state IN ('publishing','published') AND (NOT EXISTS(SELECT 1 FROM desired d WHERE d.rendition_id=p.rendition_id) OR (p.state='publishing' AND NOT $2::boolean))) AS fence_change
      FROM subjects s WHERE NOT EXISTS(SELECT 1 FROM community.publishing_jobs j WHERE j.subject_id=s.subject_id AND j.kind IN ('publish_media','withdraw_media','verify_withdrawal') AND j.state IN ('queued','running'))) SELECT * FROM candidates WHERE ($2::boolean AND publish) OR withdraw ORDER BY subject_id LIMIT $1`,
          [take(limit), allow],
        )
      ).rows;
      const publishing =
        allow && this.options.allowPublish()
          ? rows.filter((s) => s.publish)
          : [];
      const changing = rows.filter((s) => s.withdraw && s.fence_change);
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
      for (const s of rows)
        if (s.withdraw && !touched.has(s.subject_id))
          await insertJob(
            db,
            { kind: "withdraw_media", subjectId: s.subject_id, maxAttempts: 3 },
            now,
          );
      const publish = publishing.length,
        withdraw = rows.filter((s) => s.withdraw).length;
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
          `SELECT * FROM community.media_publications WHERE state='withdrawn' AND sweep_attempts<3 AND (sweep_started_at IS NOT NULL OR swept_at IS NULL OR swept_at<$1::timestamptz-interval '1 hour') ORDER BY COALESCE(sweep_started_at,swept_at,created_at),id FOR UPDATE SKIP LOCKED LIMIT $2`,
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
  async lookupPublishedItems(
    itemIds: readonly string[],
    _now: Date,
  ): Promise<ReadonlyMap<string, string>> {
    if (!this.options.isPublic() || !itemIds.length) return new Map();
    return readTransaction(this.pool, async (db) => {
      const rows = (
        await db.query<{
          item_id: string;
          role: string;
          edit_key: string;
          object_key: string;
        }>(
          `SELECT a.item_id,p.role,p.edit_key,p.object_key FROM community.media_publications p JOIN community.media_public_assets a ON a.id=p.public_asset_id JOIN (${await this.desiredSql(db)}) d ON d.rendition_id=p.rendition_id WHERE p.state='published' AND a.item_id=ANY($1::text[])`,
          [itemIds],
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
    if (!this.options.isPublic() || !renditionIds.length) return new Map();
    return readTransaction(this.pool, async (db) => {
      const rows = (
        await db.query<{ rendition_id: string; object_key: string }>(
          `SELECT p.rendition_id,p.object_key FROM community.media_publications p JOIN (${await this.desiredSql(db)}) d ON d.rendition_id=p.rendition_id WHERE p.state='published' AND p.rendition_id=ANY($1::text[]) AND d.catalog_asset_id IS NOT NULL`,
          [renditionIds],
        )
      ).rows;
      return this.options.isPublic()
        ? new Map(rows.map((p) => [p.rendition_id, p.object_key]))
        : new Map();
    });
  }
}
