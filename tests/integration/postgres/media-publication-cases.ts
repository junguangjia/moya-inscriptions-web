import { createHash, randomUUID } from "node:crypto";
import {
  PostgresCommunityContentOperatorAdapter,
  PostgresMediaPublicationAdapter,
  PostgresWorkPublishingAdapter,
} from "@moya/community-postgres";
import type { createPostgresPool } from "@moya/catalog-postgres";
import type { MediaPublicationPlan, PublishingJobLease } from "@moya/api";
import { afterEach, describe, expect, it } from "vitest";
import { requireSyntheticTestDatabaseUrl } from "./synthetic-test-database.js";

const hex = () => randomUUID().replaceAll("-", "");
const id = (prefix: string) => `${prefix}-${hex()}`;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const at = new Date("2126-10-08T12:00:00Z");
const ready = (plan: MediaPublicationPlan) => {
  if (plan.status !== "ready")
    throw new Error(`Unexpected plan ${plan.status}`);
  return plan;
};
type Pool = ReturnType<typeof createPostgresPool>;

/** Real PG16 transitions, using only this suite's opaque users/items/jobs. No cloud/store I/O. */
export const registerMediaPublicationTests = (pool: Pool) => {
  requireSyntheticTestDatabaseUrl();
  describe("media publication persistence and fences", () => {
    const users: string[] = [];
    const operator = `publication-it-${hex()}`;
    let publicMode = true;
    let enabled = true;
    const options = { isPublic: () => publicMode, allowPublish: () => enabled };
    const publication = new PostgresMediaPublicationAdapter(pool, options);
    const works = new PostgresWorkPublishingAdapter(pool, {
      publication: options,
    });
    const moderation = new PostgresCommunityContentOperatorAdapter(pool, {
      publication: options,
    });
    const addWork = async (user: string, item: string) => {
      const work = id("work"),
        revision = id("work-revision");
      await pool.query(
        "INSERT INTO community.works(id,author_id,title,text,created_via,visibility,first_published_at) VALUES($1,$2,'Publication fixture','','publishing','public',$3)",
        [work, user, at],
      );
      await pool.query(
        `INSERT INTO community.work_revisions(id,work_id,author_id,sequence,origin,title,body,authorship_kind,requested_visibility,cover_item_id,content_sha256,disposition,submitted_at) VALUES($1,$2,$3,1,'submission','Publication fixture','','original','public',$4,$5,'approved',$6)`,
        [revision, work, user, item, sha(revision), at],
      );
      await pool.query(
        `INSERT INTO community.work_revision_items(revision_id,position,item_id,edit) VALUES($1,1,$2,'{"rotation":0,"crop":null}')`,
        [revision, item],
      );
      await pool.query(
        "UPDATE community.works SET public_revision_id=$2,author_revision_id=$2,first_submitted_at=$3 WHERE id=$1",
        [work, revision, at],
      );
      return work;
    };
    const fixture = async () => {
      publicMode = true;
      enabled = true;
      const user = id("user"),
        item = id("media-item"),
        blob = id("media-blob"),
        rendition = id("media-rendition"),
        asset = hex(),
        key = hex();
      users.push(user);
      const storageKey = `blobs/${key.slice(0, 2)}/${key.slice(2, 4)}/${key}`;
      await pool.query(
        "INSERT INTO community.public_users(id,handle,display_name) VALUES($1,$2,'Publication fixture')",
        [user, `pub-${hex().slice(0, 20)}`],
      );
      await pool.query(
        "INSERT INTO community.media_items(id,owner_id,kind,quality_mode,source,state,presentation,ready_at) VALUES($1,$2,'static','standard','upload','ready','{\"width\":512,\"height\":384}',$3)",
        [item, user, at],
      );
      await pool.query(
        "INSERT INTO community.media_blobs(id,owner_id,purpose,storage_key,byte_size,sha256,content_type,created_at) VALUES($1,$2,'derivative',$3,128,$4,'image/webp',$5)",
        [blob, user, storageKey, sha(blob), at],
      );
      await pool.query(
        "INSERT INTO community.media_renditions(id,item_id,edit_key,role,recipe_version,recipe_digest,blob_id,width,height,content_type,created_at) VALUES($1,$2,'base','display',1,'1111111111111111',$3,512,384,'image/webp',$4)",
        [rendition, item, blob, at],
      );
      const work = await addWork(user, item);
      await pool.query(
        "INSERT INTO community.media_public_assets(id,item_id,desired_at,created_at,updated_at) VALUES($1,$2,$3,$3,$3)",
        [asset, item, at],
      );
      return {
        user,
        item,
        blob,
        rendition,
        asset,
        work,
        storageKey,
        hash: sha(blob),
      };
    };
    const lease = async (
      subject: string,
      kind: "publish_media" | "withdraw_media" | "verify_withdrawal",
      owner = hex(),
    ): Promise<PublishingJobLease> => {
      let job = (
        await pool.query<{ id: string }>(
          "SELECT id FROM community.publishing_jobs WHERE subject_id=$1 AND kind=$2 AND state IN ('queued','running') ORDER BY id LIMIT 1",
          [subject, kind],
        )
      ).rows[0]?.id;
      if (!job) {
        job = id("publishing-job");
        await pool.query(
          "INSERT INTO community.publishing_jobs(id,kind,subject_id,max_attempts,run_after,created_at,updated_at) VALUES($1,$2,$3,3,$4,$4,$4)",
          [job, kind, subject, at],
        );
      }
      await pool.query(
        "UPDATE community.publishing_jobs SET state='running',attempts=GREATEST(1,attempts),lease_owner=$2,lease_expires_at=$3::timestamptz+interval '1 hour' WHERE id=$1",
        [job, owner, at],
      );
      return { id: job, leaseOwner: owner };
    };
    const published = async (f: Awaited<ReturnType<typeof fixture>>) => {
      const job = await lease(f.item, "publish_media");
      const plan = ready(await publication.planPublish(f.item, job, at));
      expect(plan.units).toHaveLength(1);
      expect(await publication.finishPublish(plan.fence, at)).toBe(true);
      await publication.release(plan.fence, at);
      await pool.query(
        "UPDATE community.publishing_jobs SET state='succeeded',lease_expires_at=NULL,finished_at=$2 WHERE id=$1",
        [job.id, at],
      );
      return plan;
    };
    afterEach(async () => {
      const ids = users.splice(0);
      // Administrative fixture cleanup of this suite only, in FK order.
      await pool.query(
        "DELETE FROM community.media_publications WHERE public_asset_id IN (SELECT id FROM community.media_public_assets WHERE item_id IN (SELECT id FROM community.media_items WHERE owner_id=ANY($1::text[])))",
        [ids],
      );
      await pool.query(
        "DELETE FROM community.media_public_assets WHERE item_id IN (SELECT id FROM community.media_items WHERE owner_id=ANY($1::text[]))",
        [ids],
      );
      await pool.query(
        "DELETE FROM community.media_item_holds WHERE item_id IN (SELECT id FROM community.media_items WHERE owner_id=ANY($1::text[]))",
        [ids],
      );
      await pool.query(
        "DELETE FROM community.publishing_jobs WHERE subject_id IN (SELECT id FROM community.media_items WHERE owner_id=ANY($1::text[]))",
        [ids],
      );
      for (const sql of [
        "UPDATE community.works SET public_revision_id=NULL,author_revision_id=NULL WHERE author_id=ANY($1::text[])",
        "DELETE FROM community.work_revision_items WHERE revision_id IN (SELECT id FROM community.work_revisions WHERE author_id=ANY($1::text[]))",
        "DELETE FROM community.work_revisions WHERE author_id=ANY($1::text[])",
        "DELETE FROM community.works WHERE author_id=ANY($1::text[])",
        "DELETE FROM community.media_renditions WHERE item_id IN (SELECT id FROM community.media_items WHERE owner_id=ANY($1::text[]))",
        "DELETE FROM community.media_blobs WHERE owner_id=ANY($1::text[])",
        "DELETE FROM community.media_items WHERE owner_id=ANY($1::text[])",
        "DELETE FROM community.author_command_receipts WHERE actor_id=ANY($1::text[])",
        "DELETE FROM community.author_events WHERE actor_id=ANY($1::text[])",
        "DELETE FROM community.public_users WHERE id=ANY($1::text[])",
      ])
        await pool.query(sql, [ids]);
      await pool.query(
        "DELETE FROM community.content_operator_receipts WHERE operator_label=$1",
        [operator],
      );
      await pool.query(
        "DELETE FROM community.content_operator_events WHERE operator_label=$1",
        [operator],
      );
    });
    it.each(["original", "standard_master"])(
      "rejects %s even when its ready rendition has an allowed MIME type",
      async (purpose) => {
        const f = await fixture();
        await pool.query(
          "UPDATE community.media_blobs SET purpose=$2 WHERE id=$1",
          [f.blob, purpose],
        );
        const plan = ready(
          await publication.planPublish(
            f.item,
            await lease(f.item, "publish_media"),
            at,
          ),
        );
        expect(plan.units).toEqual([]);
        const token = hex();
        await expect(
          pool.query(
            `INSERT INTO community.media_publications(id,public_asset_id,rendition_id,generation_token,object_key,storage_key,content_type,purpose,byte_size,sha256,role,edit_key,created_at) VALUES($1,$2,$3,$4,$5,$6,'image/webp','derivative',128,$7,'display','base',$8)`,
            [
              id("media-publication"),
              f.asset,
              f.rendition,
              token,
              `v1/${f.asset}/${token}/base/display.r1.webp`,
              f.storageKey,
              f.hash,
              at,
            ],
          ),
        ).rejects.toMatchObject({ code: "23000" });
      },
    );
    it("registers immutable rows before I/O and resumes the exact same keys", async () => {
      expect(await publication.hasRegisteredPublications()).toBe(false);
      const f = await fixture(),
        job = await lease(f.item, "publish_media");
      const a = ready(await publication.planPublish(f.item, job, at));
      expect(await publication.hasRegisteredPublications()).toBe(true);
      const b = ready(await publication.planPublish(f.item, job, at));
      expect(a.units).toEqual(b.units);
      expect(a.units[0]!.objectKey).toMatch(
        /^v1\/[0-9a-f]{32}\/[0-9a-f]{32}\/base\/display\.r1\.webp$/u,
      );
      expect(
        (
          await pool.query(
            "SELECT state FROM community.media_publications WHERE id=$1",
            [a.units[0]!.id],
          )
        ).rows,
      ).toEqual([{ state: "publishing" }]);
      await expect(
        pool.query(
          "UPDATE community.media_publications SET storage_key=$2 WHERE id=$1",
          [a.units[0]!.id, `blobs/00/00/${hex()}`],
        ),
      ).rejects.toMatchObject({ code: "23000" });
    });
    it("requires both public mode and publication on; public/off retains existing eligible bytes", async () => {
      const f = await fixture(),
        plan = await published(f);
      enabled = false;
      expect(
        await publication.planPublish(
          f.item,
          await lease(f.item, "publish_media"),
          at,
        ),
      ).toEqual({ status: "disabled" });
      expect(
        (await publication.lookupPublishedItems([f.item], at)).get(
          `/api/community/publishing/media/${f.item}/display/base`,
        ),
      ).toBe(plan.units[0]!.objectKey);
      const withdrawal = ready(
        await publication.planWithdrawal(
          f.item,
          await lease(f.item, "withdraw_media"),
          at,
        ),
      );
      expect(withdrawal.units).toEqual([]);
      await publication.release(withdrawal.fence, at);
      publicMode = false;
      enabled = true;
      expect(
        await publication.planPublish(
          f.item,
          await lease(f.item, "publish_media"),
          at,
        ),
      ).toEqual({ status: "disabled" });
      expect((await publication.lookupPublishedItems([f.item], at)).size).toBe(
        0,
      );
      const beta = ready(
        await publication.planWithdrawal(
          f.item,
          await lease(f.item, "withdraw_media"),
          at,
        ),
      );
      expect(beta.units.map((u) => u.id)).toEqual(plan.units.map((u) => u.id));
    });
    it("new visibility sequence preempts a live old publish lease and prevents final commit", async () => {
      const f = await fixture();
      const copy = ready(
        await publication.planPublish(
          f.item,
          await lease(f.item, "publish_media"),
          at,
        ),
      );
      await works.setVisibility(
        f.user,
        f.work,
        { requestId: randomUUID(), visibility: "self" },
        at,
      );
      expect(await publication.isCurrent(copy.fence, at)).toBe(false);
      expect(await publication.finishPublish(copy.fence, at)).toBe(false);
      const withdrawal = ready(
        await publication.planWithdrawal(
          f.item,
          await lease(f.item, "withdraw_media"),
          at,
        ),
      );
      expect(withdrawal.units.map((u) => u.id)).toEqual(
        copy.units.map((u) => u.id),
      );
      expect(
        (
          await pool.query(
            "SELECT kind FROM community.publishing_jobs WHERE subject_id=$1 AND kind='withdraw_media'",
            [f.item],
          )
        ).rowCount,
      ).toBe(1);
    });
    it("expired/replaced job ownership cannot copy or commit despite a live asset timestamp", async () => {
      const f = await fixture(),
        job = await lease(f.item, "publish_media");
      const plan = ready(await publication.planPublish(f.item, job, at));
      await pool.query(
        "UPDATE community.publishing_jobs SET lease_expires_at=$2::timestamptz-interval '1 second' WHERE id=$1",
        [job.id, at],
      );
      expect(await publication.isCurrent(plan.fence, at)).toBe(false);
      expect(await publication.finishPublish(plan.fence, at)).toBe(false);
      await lease(f.item, "publish_media", "new-owner");
      expect(await publication.isCurrent(plan.fence, at)).toBe(false);
    });
    it("removal hold vetoes shared public references until the removed work is restored", async () => {
      const f = await fixture();
      await published(f);
      const second = await addWork(f.user, f.item);
      await moderation.moderateWork(f.work, operator, {
        requestId: randomUUID(),
        expectedVersion: 1,
        state: "removed",
      });
      expect((await publication.lookupPublishedItems([f.item], at)).size).toBe(
        0,
      );
      expect(
        (
          await pool.query(
            "SELECT community.work_is_public(w) AS live FROM community.works w WHERE id=$1",
            [second],
          )
        ).rows,
      ).toEqual([{ live: true }]);
      expect(
        (
          await pool.query(
            "SELECT work_id FROM community.media_item_holds WHERE item_id=$1 AND released_at IS NULL",
            [f.item],
          )
        ).rows,
      ).toEqual([{ work_id: f.work }]);
      await moderation.moderateWork(f.work, operator, {
        requestId: randomUUID(),
        expectedVersion: 2,
        state: "visible",
      });
      expect((await publication.lookupPublishedItems([f.item], at)).size).toBe(
        1,
      );
    });
    it("final eligibility refuses a rendition released after planning; purge failure never means withdrawn", async () => {
      const f = await fixture(),
        plan = ready(
          await publication.planPublish(
            f.item,
            await lease(f.item, "publish_media"),
            at,
          ),
        );
      await pool.query(
        "UPDATE community.media_renditions SET state='released',released_at=$2 WHERE id=$1",
        [f.rendition, at],
      );
      expect(await publication.finishPublish(plan.fence, at)).toBe(false);
      await publication.release(plan.fence, at);
      const withdrawal = ready(
        await publication.planWithdrawal(
          f.item,
          await lease(f.item, "withdraw_media"),
          at,
        ),
      );
      expect(
        await publication.recordOriginDeleted(
          withdrawal.fence,
          withdrawal.fence.unitIds,
          at,
        ),
      ).toBe(true);
      expect(
        await publication.recordPurge(
          withdrawal.fence,
          withdrawal.fence.unitIds,
          ["fixture-task"],
          at,
        ),
      ).toBe(true);
      expect(
        await publication.failPurge(
          withdrawal.fence,
          withdrawal.fence.unitIds,
          "purge_timeout",
          at,
        ),
      ).toBe(true);
      expect(
        (
          await pool.query(
            "SELECT state,fallback_ttl_seconds,purge_attempts,verified_at FROM community.media_publications WHERE id=$1",
            [plan.units[0]!.id],
          )
        ).rows,
      ).toEqual([
        {
          state: "purge_failed",
          fallback_ttl_seconds: 3600,
          purge_attempts: 2,
          verified_at: null,
        },
      ]);
    });
    it("retains every purge task and pending historical sweep state across a new adapter", async () => {
      const f = await fixture(),
        original = await published(f);
      await works.setVisibility(
        f.user,
        f.work,
        { requestId: randomUUID(), visibility: "self" },
        at,
      );
      const withdrawal = ready(
        await publication.planWithdrawal(
          f.item,
          await lease(f.item, "withdraw_media"),
          at,
        ),
      );
      expect(
        await publication.recordOriginDeleted(
          withdrawal.fence,
          withdrawal.fence.unitIds,
          at,
        ),
      ).toBe(true);
      expect(
        await publication.recordPurge(
          withdrawal.fence,
          withdrawal.fence.unitIds,
          ["task-one", "task-two"],
          at,
        ),
      ).toBe(true);
      await publication.release(withdrawal.fence, at);
      const restarted = new PostgresMediaPublicationAdapter(pool, options);
      const verification = ready(
        await restarted.planWithdrawal(
          f.item,
          await lease(f.item, "verify_withdrawal"),
          at,
        ),
      );
      expect(verification.units[0]!.purgeTaskIds).toEqual([
        "task-one",
        "task-two",
      ]);
      expect(verification.units[0]!.purgeAttempts).toBe(1);
      expect(
        await restarted.finishWithdrawal(
          verification.fence,
          verification.fence.unitIds,
          at,
        ),
      ).toBe(true);
      await restarted.recordSweepPurge(
        original.fence.unitIds,
        ["sweep-one", "sweep-two"],
        at,
      );
      expect(
        (
          await pool.query(
            "SELECT state,sweep_started_at,sweep_task_ids,sweep_attempts FROM community.media_publications WHERE id=$1",
            [original.units[0]!.id],
          )
        ).rows,
      ).toEqual([
        {
          state: "withdrawn",
          sweep_started_at: at,
          sweep_task_ids: ["sweep-one", "sweep-two"],
          sweep_attempts: 1,
        },
      ]);
      await restarted.recordSweepFailure(
        original.fence.unitIds,
        "purge_timeout",
        at,
      );
      expect(
        (
          await pool.query(
            "SELECT state,sweep_started_at,sweep_task_ids,sweep_attempts FROM community.media_publications WHERE id=$1",
            [original.units[0]!.id],
          )
        ).rows,
      ).toEqual([
        {
          state: "withdrawn",
          sweep_started_at: at,
          sweep_task_ids: [],
          sweep_attempts: 2,
        },
      ]);
      await restarted.recordSweep(original.fence.unitIds, at);
      expect(
        (
          await pool.query(
            "SELECT swept_at,sweep_started_at,sweep_attempts FROM community.media_publications WHERE id=$1",
            [original.units[0]!.id],
          )
        ).rows,
      ).toEqual([{ swept_at: at, sweep_started_at: null, sweep_attempts: 0 }]);
    });
    it("never partially records a group purge when one unit has exhausted the durable budget", async () => {
      const f = await fixture(),
        blob = id("media-blob"),
        rendition = id("media-rendition"),
        key = hex();
      await pool.query(
        "INSERT INTO community.media_blobs(id,owner_id,purpose,storage_key,byte_size,sha256,content_type,created_at) VALUES($1,$2,'derivative',$3,128,$4,'image/webp',$5)",
        [
          blob,
          f.user,
          `blobs/${key.slice(0, 2)}/${key.slice(2, 4)}/${key}`,
          sha(blob),
          at,
        ],
      );
      await pool.query(
        "INSERT INTO community.media_renditions(id,item_id,edit_key,role,recipe_version,recipe_digest,blob_id,width,height,content_type,created_at) VALUES($1,$2,'base','cover',1,'1111111111111111',$3,512,384,'image/webp',$4)",
        [rendition, f.item, blob, at],
      );
      const publicationPlan = ready(
        await publication.planPublish(
          f.item,
          await lease(f.item, "publish_media"),
          at,
        ),
      );
      expect(publicationPlan.units).toHaveLength(2);
      expect(await publication.finishPublish(publicationPlan.fence, at)).toBe(
        true,
      );
      await publication.release(publicationPlan.fence, at);
      await works.setVisibility(
        f.user,
        f.work,
        { requestId: randomUUID(), visibility: "self" },
        at,
      );
      const withdrawal = ready(
        await publication.planWithdrawal(
          f.item,
          await lease(f.item, "withdraw_media"),
          at,
        ),
      );
      expect(
        await publication.recordOriginDeleted(
          withdrawal.fence,
          withdrawal.fence.unitIds,
          at,
        ),
      ).toBe(true);
      await pool.query(
        "UPDATE community.media_publications SET purge_attempts=3 WHERE id=$1",
        [withdrawal.units[0]!.id],
      );
      expect(
        await publication.recordPurge(
          withdrawal.fence,
          withdrawal.fence.unitIds,
          ["task-partial"],
          at,
        ),
      ).toBe(false);
      expect(
        (
          await pool.query(
            "SELECT purge_attempts,purge_task_ids FROM community.media_publications WHERE id=$1",
            [withdrawal.units[1]!.id],
          )
        ).rows,
      ).toEqual([{ purge_attempts: 0, purge_task_ids: [] }]);
    });
    it("rolls back publication sequence and queue together with a failed owning transaction", async () => {
      const f = await fixture();
      const suffix = hex(),
        fn = `publication_fixture_failure_${suffix}`,
        trigger = `publication_fixture_failure_${suffix}`;
      await pool.query(
        `CREATE FUNCTION community.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${f.asset}' THEN RAISE EXCEPTION 'synthetic publication failure'; END IF; RETURN NEW; END $$`,
      );
      await pool.query(
        `CREATE TRIGGER ${trigger} BEFORE UPDATE ON community.media_public_assets FOR EACH ROW EXECUTE FUNCTION community.${fn}()`,
      );
      try {
        await expect(
          works.setVisibility(
            f.user,
            f.work,
            { requestId: randomUUID(), visibility: "self" },
            at,
          ),
        ).rejects.toThrow();
      } finally {
        await pool.query(
          `DROP TRIGGER ${trigger} ON community.media_public_assets`,
        );
        await pool.query(`DROP FUNCTION community.${fn}()`);
      }
      expect(
        (
          await pool.query(
            "SELECT desired_seq FROM community.media_public_assets WHERE id=$1",
            [f.asset],
          )
        ).rows,
      ).toEqual([{ desired_seq: "1" }]);
      expect(
        (
          await pool.query(
            "SELECT id FROM community.publishing_jobs WHERE subject_id=$1",
            [f.item],
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await pool.query(
            "SELECT visibility FROM community.works WHERE id=$1",
            [f.work],
          )
        ).rows,
      ).toEqual([{ visibility: "public" }]);
    });
  });
};
