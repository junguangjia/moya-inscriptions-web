import { createHash, randomUUID } from "node:crypto";

import {
  PostgresPublishingOperatorAdapter,
  PostgresWorkPublishingAdapter,
} from "@moya/community-postgres";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cleanupNotificationData } from "./notification-fixture-cleanup.js";
import { requireSyntheticTestDatabaseUrl } from "./synthetic-test-database.js";

import type {
  PublishingDerivativeVariant,
  PublishingDerivedOutcome,
  PublishingMediaWriteResult,
  PublishingProcessedOutcome,
  PublishingUploadCommit,
} from "@moya/api";
import type { createPostgresPool } from "@moya/catalog-postgres";
import type {
  MediaCrop,
  PublishingDraft,
  PublishingHolder,
  PublishingMediaItem,
  RegisterMediaItemCommand,
  WorkDraftContent,
  WorkDraftItem,
} from "@moya/contracts";

/**
 * Real PostgreSQL cases for work publishing sessions, drafts, media items,
 * uploads and jobs (PostgresWorkPublishingAdapter). Registered from
 * community-postgres.test.ts, which guards TEST_DATABASE_URL first; every
 * time comes from a virtual clock, never the database clock.
 */

const MiB = 1024 * 1024;
const second = 1_000;
const minute = 60 * second;
const day = 24 * 60 * minute;
const t0 = new Date("2026-09-14T12:00:00.000Z");
const at = (offsetMs: number): Date => new Date(t0.getTime() + offsetMs);

const hex = (): string => randomUUID().replaceAll("-", "");
const sha = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const allowance = (declared: number): number =>
  Math.min(Math.floor(declared / 2), 64 * MiB) + 4 * MiB;

const blobOf = (byteSize: number): PublishingMediaWriteResult => {
  const key = hex();
  return {
    storageKey: `blobs/${key.slice(0, 2)}/${key.slice(2, 4)}/${key}`,
    byteSize,
    sha256: sha(key),
  };
};

const text = (body: string, items: WorkDraftItem[] = []): WorkDraftContent => ({
  title: "",
  body,
  authorship: { kind: "original" },
  visibility: "public",
  items,
  coverKey: null,
  coverCrop: null,
});

const entry = (
  item: Pick<PublishingMediaItem, "id" | "kind"> | null,
  edit: { rotation?: 0 | 90 | 180 | 270; crop?: MediaCrop | null } = {},
): WorkDraftItem => ({
  key: item?.id ?? `pending-${hex().slice(0, 12)}`,
  itemId: item?.id ?? null,
  kind: item?.kind ?? "static",
  qualityMode: "standard",
  edit: { rotation: edit.rotation ?? 0, crop: edit.crop ?? null },
});

const staticCommand = (
  holder: PublishingHolder,
  byteSize = MiB,
  quality: "standard" | "original" = "standard",
): RegisterMediaItemCommand =>
  quality === "standard"
    ? {
        requestId: randomUUID(),
        holder,
        kind: "static",
        qualityMode: "standard",
        processingProfile: "standard-image-v1",
        components: [
          {
            role: "still",
            byteSize,
            contentType: "image/jpeg",
            standardOutcome: "optimized",
          },
        ],
      }
    : {
        requestId: randomUUID(),
        holder,
        kind: "static",
        qualityMode: "original",
        components: [{ role: "still", byteSize, contentType: "image/heic" }],
      };

const liveCommand = (
  holder: PublishingHolder,
  still = MiB,
  motion = 2 * MiB,
  quality: "standard" | "original" = "standard",
): RegisterMediaItemCommand =>
  quality === "standard"
    ? {
        requestId: randomUUID(),
        holder,
        kind: "live",
        qualityMode: "standard",
        processingProfile: "standard-live-v1",
        components: [
          {
            role: "still",
            byteSize: still,
            contentType: "image/jpeg",
            standardOutcome: "optimized",
          },
          {
            role: "motion",
            byteSize: motion,
            contentType: "video/mp4",
            standardOutcome: "optimized",
          },
        ],
        clientPairing: {
          method: "apple-content-identifier",
          identifierSha256: sha("pair"),
          stillTimeMs: 1500,
        },
      }
    : {
        requestId: randomUUID(),
        holder,
        kind: "live",
        qualityMode: "original",
        components: [
          { role: "still", byteSize: still, contentType: "image/heic" },
          { role: "motion", byteSize: motion, contentType: "video/quicktime" },
        ],
        clientPairing: {
          method: "apple-content-identifier",
          identifierSha256: sha("pair"),
        },
      };

const derivativesOf = (
  variants: readonly PublishingDerivativeVariant[],
  editKey: string,
) =>
  variants.map((variant) => ({
    ...blobOf(1000),
    variant,
    editKey,
    contentType:
      variant === "motion" ? ("video/mp4" as const) : ("image/webp" as const),
    width: 480,
    height: 360,
    durationMs: variant === "motion" ? 3000 : null,
  }));

const processedOutcome = (
  item: PublishingMediaItem,
): PublishingProcessedOutcome => ({
  status: "processed",
  detectedTypes: item.components.map((component) => ({
    role: component.role,
    contentType: component.role === "motion" ? "video/mp4" : "image/jpeg",
  })),
  presentation:
    item.kind === "live"
      ? {
          width: 1440,
          height: 1920,
          durationMs: 3000,
          hasAudio: true,
          displayRotation: 90,
        }
      : { width: 4000, height: 3000 },
  pairing:
    item.kind === "live"
      ? {
          method: "apple-content-identifier",
          verifiedBy: "server",
          identifierSha256: sha("pair"),
          stillTimeMs: 1500,
        }
      : null,
  stillExifOrientation: 6,
  derivatives: derivativesOf(
    item.kind === "live"
      ? ["thumb", "display", "full", "motion", "cover"]
      : ["thumb", "display", "full", "cover"],
    "base",
  ),
});

export const registerWorkPublishingMediaTests = (
  pool: ReturnType<typeof createPostgresPool>,
) => {
  // The registering suite already guards the target; stay safe if moved.
  requireSyntheticTestDatabaseUrl();

  describe("work publishing media, drafts and jobs on real PostgreSQL", () => {
    const adapter = new PostgresWorkPublishingAdapter(pool);
    const operators = new PostgresPublishingOperatorAdapter(pool);
    const operator = `wp-media-${hex().slice(0, 12)}`;
    const users: string[] = [];
    const jobSubjects: string[] = [];
    let a: string;
    let b: string;

    const createUser = async (): Promise<string> => {
      const id = `user-${hex()}`;
      await pool.query(
        "INSERT INTO community.public_users(id,handle,display_name) VALUES($1,$2,'发布测试')",
        [id, `wp-${id.slice(-24)}`],
      );
      users.push(id);
      return id;
    };

    beforeEach(async () => {
      a = await createUser();
      b = await createUser();
    });

    afterEach(async () => {
      const owners = users.splice(0);
      const subjects = jobSubjects.splice(0);
      await cleanupNotificationData(pool, owners);
      await pool.query(
        `DELETE FROM community.publishing_jobs WHERE subject_id=ANY($2::text[]) OR subject_id IN (
           SELECT id FROM community.media_items WHERE owner_id=ANY($1::text[])
           UNION SELECT id FROM community.media_blobs WHERE owner_id=ANY($1::text[])
           UNION SELECT id FROM community.publishing_sessions WHERE owner_id=ANY($1::text[])
           UNION SELECT id FROM community.works WHERE author_id=ANY($1::text[]))`,
        [owners, subjects],
      );
      for (const statement of [
        "DELETE FROM community.media_item_refs WHERE item_id IN (SELECT id FROM community.media_items WHERE owner_id=ANY($1::text[]))",
        "DELETE FROM community.publishing_sessions WHERE owner_id=ANY($1::text[])",
        "DELETE FROM community.work_draft_snapshots WHERE owner_id=ANY($1::text[])",
        "DELETE FROM community.work_drafts WHERE owner_id=ANY($1::text[]) AND conflict_of IS NOT NULL",
        "DELETE FROM community.work_drafts WHERE owner_id=ANY($1::text[])",
        "UPDATE community.works SET public_revision_id=NULL, author_revision_id=NULL WHERE author_id=ANY($1::text[])",
        "DELETE FROM community.work_revision_items WHERE revision_id IN (SELECT id FROM community.work_revisions WHERE author_id=ANY($1::text[]))",
        "DELETE FROM community.work_revisions WHERE author_id=ANY($1::text[])",
        "DELETE FROM community.works WHERE author_id=ANY($1::text[])",
        "DELETE FROM community.media_derivatives WHERE item_id IN (SELECT id FROM community.media_items WHERE owner_id=ANY($1::text[]))",
        "DELETE FROM community.media_components WHERE owner_id=ANY($1::text[])",
        "DELETE FROM community.media_blobs WHERE owner_id=ANY($1::text[])",
        "DELETE FROM community.media_items WHERE owner_id=ANY($1::text[])",
        "DELETE FROM community.user_media WHERE owner_id=ANY($1::text[])",
        "DELETE FROM community.account_publishing_capacity WHERE account_id=ANY($1::text[])",
        "DELETE FROM community.daily_new_work_submissions WHERE account_id=ANY($1::text[])",
        "DELETE FROM community.author_command_receipts WHERE actor_id=ANY($1::text[])",
        "DELETE FROM community.author_events WHERE actor_id=ANY($1::text[])",
        "DELETE FROM community.public_users WHERE id=ANY($1::text[])",
      ])
        await pool.query(statement, [owners]);
      for (const statement of [
        "DELETE FROM community.content_operator_receipts WHERE operator_label=$1",
        "DELETE FROM community.content_operator_events WHERE operator_label=$1",
      ])
        await pool.query(statement, [operator]);
    });

    /** Changes settings through the operator port; returns the restore step. */
    const changeSettings = async (
      change: { readonly unsavedSessionLeaseMinutes?: number },
      now: Date,
    ): Promise<() => Promise<void>> => {
      const set = async (values: typeof change) => {
        const current = await operators.readSettings();
        await operators.setSettings(
          operator,
          {
            requestId: randomUUID(),
            expectedVersion: current.version,
            policy: current.policy,
            maxItemsPerWork: current.maxItemsPerWork,
            originalItemMaxBytes: current.originalItemMaxBytes,
            standardComponentMaxBytes: current.standardComponentMaxBytes,
            ordinaryAccountCapacityBytes: current.ordinaryAccountCapacityBytes,
            ownerAccountCapacityBytes: current.ownerAccountCapacityBytes,
            maxActiveDrafts: current.maxActiveDrafts,
            dailyNewWorkLimit: current.dailyNewWorkLimit,
            historyLimit: current.historyLimit,
            trashRetentionDays: current.trashRetentionDays,
            orphanGraceDays: current.orphanGraceDays,
            unsavedSessionLeaseMinutes:
              values.unsavedSessionLeaseMinutes ??
              current.unsavedSessionLeaseMinutes,
          },
          now,
        );
      };
      const before = await operators.readSettings();
      await set(change);
      return () =>
        set({ unsavedSessionLeaseMinutes: before.unsavedSessionLeaseMinutes });
    };

    const newDraft = (
      actor: string,
      content: WorkDraftContent = text("草稿"),
      now = t0,
    ): Promise<PublishingDraft> =>
      adapter.createDraft(
        actor,
        { requestId: randomUUID(), content, deviceClass: "desktop" },
        now,
      );

    const uploadAll = async (
      actor: string,
      item: PublishingMediaItem,
      now = t0,
    ): Promise<PublishingUploadCommit[]> => {
      const commits: PublishingUploadCommit[] = [];
      for (const component of item.components) {
        const fence = await adapter.beginComponentUpload(
          actor,
          component.id,
          {
            attempt: randomUUID(),
            contentLength: component.byteSize,
            supersede: false,
          },
          now,
        );
        commits.push(
          await adapter.commitComponentUpload(
            fence,
            blobOf(component.byteSize),
            now,
          ),
        );
      }
      return commits;
    };

    const capacity = async (actor: string) => adapter.readCapacity(actor);

    const jobsFor = async (subject: string) =>
      (
        await pool.query<{
          id: string;
          kind: string;
          state: string;
          attempts: number;
          payload: {
            editKey: string;
            coverCrop: MediaCrop | null;
            variants: string[];
          } | null;
          run_after: Date;
          last_error_code: string | null;
        }>(
          "SELECT id,kind,state,attempts,payload,run_after,last_error_code FROM community.publishing_jobs WHERE subject_id=$1 ORDER BY created_at, id",
          [subject],
        )
      ).rows;

    const refsOf = async (itemId: string) =>
      (
        await pool.query<{ holder_kind: string; holder_id: string }>(
          "SELECT holder_kind,holder_id FROM community.media_item_refs WHERE item_id=$1 ORDER BY holder_kind, holder_id",
          [itemId],
        )
      ).rows;

    const itemState = async (itemId: string) =>
      (
        await pool.query<{ state: string }>(
          "SELECT state FROM community.media_items WHERE id=$1",
          [itemId],
        )
      ).rows[0]?.state;

    it("counts logical items per holder at 0, 1, 50 and 51 with a Live pair counting once", async () => {
      const draft = await newDraft(a);
      const holder = { draftId: draft.id };
      const first = await adapter.registerItem(a, liveCommand(holder), t0);
      expect(first).toMatchObject({
        kind: "live",
        state: "awaiting_upload",
        media: null,
      });
      expect(first.components.map((component) => component.role)).toEqual([
        "still",
        "motion",
      ]);
      const second = await adapter.registerItem(a, staticCommand(holder), t0);
      for (let index = 2; index < 49; index += 1)
        await adapter.registerItem(a, staticCommand(holder), t0);
      const fiftieth = await adapter.registerItem(a, liveCommand(holder), t0);
      const held = await pool.query<{ items: string; components: string }>(
        `SELECT count(DISTINCT r.item_id)::text AS items, count(c.id)::text AS components
         FROM community.media_item_refs r JOIN community.media_components c ON c.item_id=r.item_id
         WHERE r.holder_kind='draft' AND r.holder_id=$1`,
        [draft.id],
      );
      expect(held.rows[0]).toEqual({ items: "50", components: "52" });
      await expect(
        adapter.registerItem(a, staticCommand(holder), t0),
      ).rejects.toMatchObject({
        name: "CommunityInputError",
        message: "items_limit",
      });
      await expect(
        adapter.registerItem(a, liveCommand(holder), t0),
      ).rejects.toMatchObject({ message: "items_limit" });
      const stored = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM community.media_items WHERE owner_id=$1",
        [a],
      );
      expect(stored.rows[0]?.count).toBe("50");
      // A cancelled item no longer counts; the same holder accepts one more.
      await adapter.cancelItem(a, second.id, { requestId: randomUUID() }, t0);
      await adapter.registerItem(a, staticCommand(holder), t0);
      await expect(
        adapter.registerItem(a, staticCommand(holder), t0),
      ).rejects.toMatchObject({ message: "items_limit" });
      // Another holder of the same account starts from zero.
      const other = await newDraft(a);
      await adapter.registerItem(a, staticCommand({ draftId: other.id }), t0);
      expect(fiftieth.kind).toBe("live");
    }, 30_000);

    it("bounds an Original item at 128 MiB across its components with no whole-work cap", async () => {
      const draft = await newDraft(a);
      const holder = { draftId: draft.id };
      const limit = 128 * MiB;
      await adapter.registerItem(
        a,
        staticCommand(holder, limit, "original"),
        t0,
      );
      await expect(
        adapter.registerItem(
          a,
          staticCommand(holder, limit + 1, "original"),
          t0,
        ),
      ).rejects.toMatchObject({ message: "original_item_too_large" });
      await adapter.registerItem(
        a,
        liveCommand(holder, 100 * MiB, 28 * MiB, "original"),
        t0,
      );
      await expect(
        adapter.registerItem(
          a,
          liveCommand(holder, 100 * MiB, 28 * MiB + 1, "original"),
          t0,
        ),
      ).rejects.toMatchObject({ message: "original_item_too_large" });
      // The work already holds 256 MiB of Originals; more are still allowed.
      await adapter.registerItem(
        a,
        staticCommand(holder, 64 * MiB, "original"),
        t0,
      );
      // Standard bounds each component, not the item total.
      await adapter.registerItem(
        a,
        liveCommand(holder, 256 * MiB, 256 * MiB, "standard"),
        t0,
      );
      await expect(
        adapter.registerItem(a, staticCommand(holder, 256 * MiB + 1), t0),
      ).rejects.toMatchObject({ message: "component_too_large" });
      const reserved = [limit, limit, 64 * MiB, 512 * MiB].reduce(
        (total, declared) => total + declared + allowance(declared),
        0,
      );
      expect(await capacity(a)).toMatchObject({
        capacityClass: "ordinary",
        capacityBytes: 10 * 1024 * MiB,
        committedBytes: 0,
        reservedBytes: reserved,
      });
    });

    it("never overspends capacity with concurrent registrations", async () => {
      const first = await newDraft(a);
      const second = await newDraft(a);
      const capacityBytes = (await capacity(a)).capacityBytes;
      await pool.query(
        "INSERT INTO community.account_publishing_capacity(account_id,committed_bytes,updated_at) VALUES($1,$2,$3)",
        [a, capacityBytes - 30 * MiB, t0],
      );
      // Each needs 10 MiB + 5 MiB + 4 MiB = 19 MiB; only one fits in 30 MiB.
      const results = await Promise.allSettled([
        adapter.registerItem(
          a,
          staticCommand({ draftId: first.id }, 10 * MiB),
          t0,
        ),
        adapter.registerItem(
          a,
          staticCommand({ draftId: second.id }, 10 * MiB),
          t0,
        ),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      const refused = results.find((result) => result.status === "rejected");
      expect(refused?.status === "rejected" && refused.reason).toMatchObject({
        message: "capacity_exceeded",
      });
      const after = await capacity(a);
      expect(after.reservedBytes).toBe(19 * MiB);
      expect(after.committedBytes + after.reservedBytes).toBeLessThanOrEqual(
        after.capacityBytes,
      );
      const items = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM community.media_items WHERE owner_id=$1",
        [a],
      );
      expect(items.rows[0]?.count).toBe("1");
    });

    it("refuses a late commit after cancel with no blob row and a released reservation", async () => {
      const draft = await newDraft(a);
      const item = await adapter.registerItem(
        a,
        staticCommand({ draftId: draft.id }, 2 * MiB),
        t0,
      );
      expect((await capacity(a)).reservedBytes).toBe(
        2 * MiB + allowance(2 * MiB),
      );
      const component = item.components[0];
      if (component === undefined) throw new Error("component missing");
      const fence = await adapter.beginComponentUpload(
        a,
        component.id,
        { attempt: randomUUID(), contentLength: 2 * MiB, supersede: false },
        t0,
      );
      expect(fence).toMatchObject({
        itemId: item.id,
        ownerId: a,
        role: "still",
        contentType: "image/jpeg",
        byteSize: 2 * MiB,
        purpose: "standard_master",
      });
      const request = { requestId: randomUUID() };
      const cancelled = await adapter.cancelItem(
        a,
        item.id,
        request,
        at(second),
      );
      expect(cancelled.cancelledComponentIds).toEqual([component.id]);
      expect(cancelled.item.state).toBe("cancelled");
      expect(
        await adapter.cancelItem(a, item.id, request, at(2 * second)),
      ).toEqual(cancelled);
      const late = blobOf(2 * MiB);
      expect(
        await adapter.commitComponentUpload(fence, late, at(3 * second)),
      ).toEqual({
        status: "cancelled",
      });
      const blobs = await pool.query(
        "SELECT 1 FROM community.media_blobs WHERE storage_key=$1 OR owner_id=$2",
        [late.storageKey, a],
      );
      expect(blobs.rowCount).toBe(0);
      expect(await capacity(a)).toMatchObject({
        committedBytes: 0,
        reservedBytes: 0,
      });
      expect(await refsOf(item.id)).toEqual([]);
      expect(await jobsFor(item.id)).toMatchObject([
        { kind: "purge_item", state: "queued" },
      ]);
      await expect(
        adapter.beginComponentUpload(
          a,
          component.id,
          { attempt: randomUUID(), contentLength: 2 * MiB, supersede: false },
          at(4 * second),
        ),
      ).rejects.toMatchObject({ name: "CommunityConflictError" });
      await expect(adapter.readItem(b, item.id)).rejects.toMatchObject({
        name: "CommunityNotFoundError",
      });
    });

    it("supersedes an older attempt, refuses size mismatches and commits the current attempt", async () => {
      const draft = await newDraft(a);
      const item = await adapter.registerItem(
        a,
        staticCommand({ draftId: draft.id }, 3 * MiB),
        t0,
      );
      const component = item.components[0];
      if (component === undefined) throw new Error("component missing");
      const start = (supersede: boolean, contentLength = 3 * MiB) => ({
        attempt: randomUUID(),
        contentLength,
        supersede,
      });
      await expect(
        adapter.beginComponentUpload(
          a,
          component.id,
          start(false, 3 * MiB + 1),
          t0,
        ),
      ).rejects.toMatchObject({ message: "component_too_large" });
      await expect(
        adapter.beginComponentUpload(
          a,
          component.id,
          start(false, 3 * MiB - 1),
          t0,
        ),
      ).rejects.toMatchObject({ name: "CommunityInputError" });
      await expect(
        adapter.beginComponentUpload(b, component.id, start(false), t0),
      ).rejects.toMatchObject({ name: "CommunityNotFoundError" });
      const older = await adapter.beginComponentUpload(
        a,
        component.id,
        start(false),
        t0,
      );
      await expect(
        adapter.beginComponentUpload(a, component.id, start(false), t0),
      ).rejects.toMatchObject({ name: "CommunityConflictError" });
      const current = await adapter.beginComponentUpload(
        a,
        component.id,
        start(true),
        at(second),
      );
      expect(
        await adapter.commitComponentUpload(
          older,
          blobOf(3 * MiB),
          at(2 * second),
        ),
      ).toEqual({ status: "superseded" });
      // The superseded transfer's abort leaves the current attempt alone.
      await adapter.abortComponentUpload(older, at(2 * second));
      expect(
        await adapter.commitComponentUpload(
          current,
          blobOf(3 * MiB - 1),
          at(3 * second),
        ),
      ).toEqual({ status: "size_mismatch" });
      const retry = await adapter.beginComponentUpload(
        a,
        component.id,
        start(false),
        at(4 * second),
      );
      await adapter.abortComponentUpload(retry, at(5 * second));
      await adapter.abortComponentUpload(retry, at(5 * second));
      const final = await adapter.beginComponentUpload(
        a,
        component.id,
        start(false),
        at(6 * second),
      );
      const stored = blobOf(3 * MiB);
      const commit = await adapter.commitComponentUpload(
        final,
        stored,
        at(7 * second),
      );
      expect(commit).toMatchObject({
        status: "committed",
        result: {
          componentId: component.id,
          sha256: stored.sha256,
          receivedBytes: 3 * MiB,
          item: { id: item.id, state: "processing" },
        },
      });
      expect(
        await adapter.commitComponentUpload(
          final,
          blobOf(3 * MiB),
          at(8 * second),
        ),
      ).toEqual({ status: "superseded" });
      // A replayed commit of the recorded blob answers committed again, so
      // the caller never removes stored bytes.
      expect(
        await adapter.commitComponentUpload(final, stored, at(9 * second)),
      ).toEqual(commit);
      const blobs = await pool.query<{ purpose: string; storage_key: string }>(
        "SELECT purpose,storage_key FROM community.media_blobs WHERE owner_id=$1",
        [a],
      );
      expect(blobs.rows).toEqual([
        { purpose: "standard_master", storage_key: stored.storageKey },
      ]);
      expect(await capacity(a)).toMatchObject({
        committedBytes: 3 * MiB,
        reservedBytes: allowance(3 * MiB),
      });
      expect(await jobsFor(item.id)).toMatchObject([
        { kind: "process_item", state: "queued" },
      ]);
    });

    it("keeps both versions on an autosave conflict, replays saves idempotently and never clears newer content", async () => {
      const draft = await newDraft(a, text("第一版"));
      expect(draft).toMatchObject({ kind: "new", revision: 1, conflict: null });
      const saved = await adapter.saveDraft(
        a,
        draft.id,
        { baseRevision: 1, content: text("第二版"), deviceClass: "desktop" },
        at(minute),
      );
      expect(saved).toMatchObject({ status: "saved", draft: { revision: 2 } });
      const replay = await adapter.saveDraft(
        a,
        draft.id,
        { baseRevision: 1, content: text("第二版"), deviceClass: "desktop" },
        at(2 * minute),
      );
      expect(replay).toEqual(saved);
      const stale = await adapter.saveDraft(
        a,
        draft.id,
        { baseRevision: 1, content: text("手机版本"), deviceClass: "phone" },
        at(3 * minute),
      );
      if (stale.status !== "conflict") throw new Error("expected a conflict");
      expect(stale.draft).toMatchObject({
        revision: 2,
        content: { body: "第二版" },
      });
      expect(stale.conflict).toMatchObject({
        device: {
          content: { body: "手机版本" },
          baseRevision: 1,
          deviceClass: "phone",
        },
        account: { content: { body: "第二版" }, revision: 2 },
      });
      const staleReplay = await adapter.saveDraft(
        a,
        draft.id,
        { baseRevision: 1, content: text("手机版本"), deviceClass: "phone" },
        at(4 * minute),
      );
      expect(staleReplay.status === "conflict" && staleReplay.conflict.id).toBe(
        stale.conflict.id,
      );
      const copies = await pool.query(
        "SELECT 1 FROM community.work_drafts WHERE conflict_of=$1",
        [draft.id],
      );
      expect(copies.rowCount).toBe(1);
      const newer = await adapter.saveDraft(
        a,
        draft.id,
        { baseRevision: 2, content: text("第三版"), deviceClass: "desktop" },
        at(5 * minute),
      );
      expect(newer).toMatchObject({
        status: "saved",
        draft: {
          revision: 3,
          content: { body: "第三版" },
          conflict: {
            id: stale.conflict.id,
            account: { content: { body: "第三版" } },
          },
        },
      });
      expect(
        (await adapter.listDrafts(a, { page: 1, pageSize: 20 })).total,
      ).toBe(1);
      const history = await adapter.listHistory(a, draft.id, {
        page: 1,
        pageSize: 20,
      });
      expect(history.items).toMatchObject([
        { kind: "conflict", pinned: true, content: { body: "手机版本" } },
      ]);
      const resolved = await adapter.resolveConflict(
        a,
        draft.id,
        {
          requestId: randomUUID(),
          conflictId: stale.conflict.id,
          choice: "device",
        },
        at(6 * minute),
      );
      expect(resolved).toMatchObject({
        revision: 4,
        content: { body: "手机版本" },
        conflict: null,
        deviceClass: "phone",
      });
      // The chosen device content is the draft's saved content now (its
      // former conflict snapshot, re-kinded at the new revision); only the
      // unchosen account content remains a pinned conflict copy.
      const kept = await adapter.listHistory(a, draft.id, {
        page: 1,
        pageSize: 20,
      });
      expect(
        kept.items.map((snapshot) => [
          snapshot.kind,
          snapshot.pinned,
          snapshot.sourceRevision,
          snapshot.createdAt,
          snapshot.content.body,
        ]),
      ).toEqual([
        ["saved", false, 4, at(6 * minute).toISOString(), "手机版本"],
        [
          "conflict",
          true,
          3,
          new Date(at(6 * minute).getTime() - 1).toISOString(),
          "第三版",
        ],
      ]);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM community.work_draft_snapshots WHERE owner_id=$1 AND kind='conflict'",
            [a],
          )
        ).rows[0],
      ).toEqual({ n: 1 });
      await expect(
        adapter.resolveConflict(
          a,
          draft.id,
          {
            requestId: randomUUID(),
            conflictId: stale.conflict.id,
            choice: "account",
          },
          at(7 * minute),
        ),
      ).rejects.toMatchObject({ name: "CommunityConflictError" });
      await expect(
        adapter.saveDraft(
          b,
          draft.id,
          { baseRevision: 4, content: text("他人"), deviceClass: null },
          at(8 * minute),
        ),
      ).rejects.toMatchObject({ name: "CommunityNotFoundError" });
    });

    it("evicts unpinned history beyond the limit and keeps pinned conflict copies", async () => {
      const draft = await newDraft(a, text("开始"));
      await adapter.saveDraft(
        a,
        draft.id,
        { baseRevision: 5, content: text("冲突"), deviceClass: "tablet" },
        at(second),
      );
      let revision = 1;
      for (let index = 0; index < 23; index += 1) {
        const result = await adapter.snapshotDraft(
          a,
          draft.id,
          {
            baseRevision: revision,
            content: text(`保存 ${index}`),
            deviceClass: "desktop",
          },
          at((index + 2) * minute),
        );
        if (result.status !== "saved") throw new Error("expected a save");
        revision = result.draft.revision;
      }
      // Save now of unchanged content records nothing new.
      await adapter.snapshotDraft(
        a,
        draft.id,
        {
          baseRevision: revision,
          content: text("保存 22"),
          deviceClass: "desktop",
        },
        at(40 * minute),
      );
      const history = await adapter.listHistory(a, draft.id, {
        page: 1,
        pageSize: 50,
      });
      const unpinned = history.items.filter((snapshot) => !snapshot.pinned);
      expect(unpinned).toHaveLength(20);
      expect(unpinned[0]?.content.body).toBe("保存 22");
      expect(unpinned.at(-1)?.content.body).toBe("保存 3");
      expect(history.items.filter((snapshot) => snapshot.pinned)).toMatchObject(
        [{ kind: "conflict", content: { body: "冲突" }, sourceRevision: 5 }],
      );
      expect(history.total).toBe(21);
      // Restore makes an older snapshot the current private edit again.
      const target = unpinned.at(-1);
      if (target === undefined) throw new Error("snapshot missing");
      const restored = await adapter.restoreSnapshot(
        a,
        draft.id,
        { requestId: randomUUID(), snapshotId: target.id },
        at(50 * minute),
      );
      expect(restored).toMatchObject({
        revision: revision + 1,
        content: { body: "保存 3" },
      });
      const after = await adapter.listHistory(a, draft.id, {
        page: 1,
        pageSize: 3,
      });
      expect(after.items[0]).toMatchObject({
        kind: "restored",
        sourceRevision: revision + 1,
      });
      expect(after.total).toBe(21);
    }, 30_000);

    it("deletes a draft with its history, conflict copies and exclusive media only", async () => {
      const kept = await newDraft(b, text("别人的草稿"));
      const draftA = await newDraft(a, text("草稿甲"));
      const draftB = await newDraft(a, text("草稿乙"));
      const holder = { draftId: draftA.id };
      const shared = await adapter.registerItem(a, staticCommand(holder), t0);
      const exclusive = await adapter.registerItem(
        a,
        staticCommand(holder),
        t0,
      );
      const published = await adapter.registerItem(
        a,
        staticCommand(holder),
        t0,
      );
      const pending = await adapter.registerItem(a, staticCommand(holder), t0);
      const work = `work-${hex()}`;
      const revisionId = `work-revision-${hex()}`;
      await pool.query(
        "INSERT INTO community.works(id,author_id,title,text,created_via,visibility) VALUES($1,$2,'','','publishing','self')",
        [work, a],
      );
      await pool.query(
        `INSERT INTO community.work_revisions(id,work_id,author_id,sequence,origin,title,body,authorship_kind,requested_visibility,cover_item_id,content_sha256,disposition,submitted_at)
         VALUES($1,$2,$3,1,'submission','修订','正文','original','self',$4,$5,'not_required',$6)`,
        [revisionId, work, a, published.id, sha("revision"), t0],
      );
      await pool.query(
        `INSERT INTO community.work_revision_items(revision_id,position,item_id,edit) VALUES($1,1,$2,'{"rotation":0,"crop":null}')`,
        [revisionId, published.id],
      );
      await pool.query(
        "INSERT INTO community.media_item_refs(item_id,holder_kind,holder_id) VALUES($1,'revision',$2)",
        [published.id, revisionId],
      );
      await pool.query(
        "UPDATE community.works SET author_revision_id=$1, first_submitted_at=$2 WHERE id=$3",
        [revisionId, t0, work],
      );
      await adapter.snapshotDraft(
        a,
        draftA.id,
        {
          baseRevision: 1,
          content: text("草稿甲", [
            entry(shared),
            entry(exclusive),
            entry(published),
          ]),
          deviceClass: "desktop",
        },
        at(minute),
      );
      await adapter.saveDraft(
        a,
        draftA.id,
        {
          baseRevision: 1,
          content: text("冲突甲", [entry(exclusive)]),
          deviceClass: "phone",
        },
        at(2 * minute),
      );
      await adapter.saveDraft(
        a,
        draftB.id,
        {
          baseRevision: 1,
          content: text("草稿乙", [entry(shared)]),
          deviceClass: null,
        },
        at(2 * minute),
      );
      const request = { requestId: randomUUID() };
      const deletion = await adapter.deleteDraft(
        a,
        draftA.id,
        request,
        at(3 * minute),
      );
      expect(deletion).toEqual({
        result: {
          deleted: true,
          snapshots: 2,
          conflictCopies: 1,
          mediaItems: 2,
        },
        cancelledComponentIds: [],
      });
      expect(
        await adapter.deleteDraft(a, draftA.id, request, at(4 * minute)),
      ).toEqual(deletion);
      await expect(adapter.readDraft(a, draftA.id)).rejects.toMatchObject({
        name: "CommunityNotFoundError",
      });
      await expect(
        adapter.saveDraft(
          a,
          draftA.id,
          { baseRevision: 2, content: text("迟到"), deviceClass: null },
          at(5 * minute),
        ),
      ).rejects.toMatchObject({ name: "CommunityNotFoundError" });
      const leftovers = await pool.query(
        "SELECT 1 FROM community.work_drafts WHERE id=$1 OR conflict_of=$1 UNION ALL SELECT 1 FROM community.work_draft_snapshots WHERE draft_id=$1",
        [draftA.id],
      );
      expect(leftovers.rowCount).toBe(0);
      expect(await itemState(exclusive.id)).toBe("cancelled");
      expect(await itemState(pending.id)).toBe("cancelled");
      expect(await jobsFor(exclusive.id)).toMatchObject([
        { kind: "purge_item" },
      ]);
      expect(await itemState(shared.id)).toBe("awaiting_upload");
      expect(await refsOf(shared.id)).toEqual([
        { holder_kind: "draft", holder_id: draftB.id },
      ]);
      expect(await itemState(published.id)).toBe("awaiting_upload");
      expect(await refsOf(published.id)).toEqual([
        { holder_kind: "revision", holder_id: revisionId },
      ]);
      const revision = await pool.query(
        "SELECT r.id FROM community.work_revisions r JOIN community.work_revision_items i ON i.revision_id=r.id JOIN community.works w ON w.author_revision_id=r.id WHERE r.id=$1",
        [revisionId],
      );
      expect(revision.rowCount).toBe(1);
      expect(await adapter.readDraft(a, draftB.id)).toMatchObject({
        content: { body: "草稿乙" },
      });
      expect(await adapter.readDraft(b, kept.id)).toMatchObject({
        id: kept.id,
      });
      expect((await capacity(a)).reservedBytes).toBe(
        2 * (MiB + allowance(MiB)),
      );
    });

    it("refuses a draft deletion confirmed against an older revision and removes nothing", async () => {
      const draft = await newDraft(a, text("草稿"));
      const item = await adapter.registerItem(
        a,
        staticCommand({ draftId: draft.id }),
        t0,
      );
      // Another device saved after this one showed the deletion scope.
      expect(
        await adapter.saveDraft(
          a,
          draft.id,
          {
            baseRevision: 1,
            content: text("另一台设备", [entry(item)]),
            deviceClass: "phone",
          },
          at(minute),
        ),
      ).toMatchObject({ status: "saved", draft: { revision: 2 } });
      const stale = { requestId: randomUUID(), expectedRevision: 1 };
      await expect(
        adapter.deleteDraft(a, draft.id, stale, at(2 * minute)),
      ).rejects.toMatchObject({
        name: "CommunityConflictError",
        message: "draft_changed",
      });
      expect(await adapter.readDraft(a, draft.id)).toMatchObject({
        revision: 2,
        content: { body: "另一台设备" },
      });
      expect(await itemState(item.id)).toBe("awaiting_upload");
      expect(await refsOf(item.id)).toEqual([
        { holder_kind: "draft", holder_id: draft.id },
      ]);
      const recorded = async (requestId: string) =>
        (
          await pool.query(
            "SELECT 1 FROM community.author_command_receipts WHERE actor_id=$1 AND request_id=$2",
            [a, requestId],
          )
        ).rowCount;
      expect(await recorded(stale.requestId)).toBe(0);

      // Confirmed against the current revision: the targeted deletion runs,
      // and a replay answers from its receipt.
      const current = { requestId: randomUUID(), expectedRevision: 2 };
      const deletion = await adapter.deleteDraft(
        a,
        draft.id,
        current,
        at(3 * minute),
      );
      expect(deletion.result).toEqual({
        deleted: true,
        snapshots: 0,
        conflictCopies: 0,
        mediaItems: 1,
      });
      expect(
        await adapter.deleteDraft(a, draft.id, current, at(4 * minute)),
      ).toEqual(deletion);
      expect(await recorded(current.requestId)).toBe(1);
      expect(await itemState(item.id)).toBe("cancelled");
      await expect(
        adapter.deleteDraft(
          a,
          draft.id,
          { requestId: randomUUID(), expectedRevision: 2 },
          at(5 * minute),
        ),
      ).rejects.toMatchObject({ name: "CommunityNotFoundError" });
      // Without an expected revision the current draft is deleted.
      const other = await newDraft(a, text("无条件删除"));
      await adapter.saveDraft(
        a,
        other.id,
        { baseRevision: 1, content: text("已更新"), deviceClass: null },
        at(minute),
      );
      expect(
        (
          await adapter.deleteDraft(
            a,
            other.id,
            { requestId: randomUUID() },
            at(2 * minute),
          )
        ).result.deleted,
      ).toBe(true);
    });

    it("refuses a confirmed draft deletion while an unresolved conflict copy exists", async () => {
      const draft = await newDraft(a, text("本机草稿"));
      const item = await adapter.registerItem(
        a,
        staticCommand({ draftId: draft.id }),
        t0,
      );
      // Another device saved on an outdated base: its content is kept as a
      // conflict copy and the draft revision stays 1.
      const conflicted = await adapter.saveDraft(
        a,
        draft.id,
        {
          baseRevision: 9,
          content: text("另一台设备", [entry(item)]),
          deviceClass: "phone",
        },
        at(minute),
      );
      if (conflicted.status !== "conflict") throw new Error("no conflict");
      expect(conflicted.draft.revision).toBe(1);
      const copyId = conflicted.conflict.id;
      const recorded = async (requestId: string) =>
        (
          await pool.query(
            "SELECT 1 FROM community.author_command_receipts WHERE actor_id=$1 AND request_id=$2",
            [a, requestId],
          )
        ).rowCount;
      const rows = async () =>
        (
          await pool.query<{ drafts: string; snapshots: string }>(
            "SELECT (SELECT count(*) FROM community.work_drafts WHERE id=$1 OR conflict_of=$1) AS drafts, (SELECT count(*) FROM community.work_draft_snapshots WHERE draft_id=$1) AS snapshots",
            [draft.id],
          )
        ).rows[0];
      const before = await rows();
      expect(before).toEqual({ drafts: "2", snapshots: "1" });
      const confirmedAtCurrent = {
        requestId: randomUUID(),
        expectedRevision: 1,
      };
      await expect(
        adapter.deleteDraft(a, draft.id, confirmedAtCurrent, at(2 * minute)),
      ).rejects.toMatchObject({
        name: "CommunityConflictError",
        message: "draft_changed",
      });
      expect(await rows()).toEqual(before);
      expect(await adapter.readDraft(a, draft.id)).toMatchObject({
        revision: 1,
        conflict: { id: copyId, device: { content: { body: "另一台设备" } } },
      });
      expect(await itemState(item.id)).toBe("awaiting_upload");
      expect(await recorded(confirmedAtCurrent.requestId)).toBe(0);

      // Once the author has seen and resolved the conflict, a deletion
      // confirmed at the current revision removes the draft, the resolved
      // copy and the history.
      const resolved = await adapter.resolveConflict(
        a,
        draft.id,
        { requestId: randomUUID(), conflictId: copyId, choice: "account" },
        at(3 * minute),
      );
      expect(resolved.conflict).toBeNull();
      const current = {
        requestId: randomUUID(),
        expectedRevision: resolved.revision,
      };
      expect(
        (await adapter.deleteDraft(a, draft.id, current, at(4 * minute)))
          .result,
      ).toMatchObject({ deleted: true, conflictCopies: 1, snapshots: 2 });
      expect(await rows()).toEqual({ drafts: "0", snapshots: "0" });

      // Without an expected revision the draft goes with its unresolved copy.
      const other = await newDraft(a, text("无条件删除"));
      expect(
        await adapter.saveDraft(
          a,
          other.id,
          { baseRevision: 5, content: text("旧基础"), deviceClass: null },
          at(minute),
        ),
      ).toMatchObject({ status: "conflict" });
      expect(
        (
          await adapter.deleteDraft(
            a,
            other.id,
            { requestId: randomUUID() },
            at(2 * minute),
          )
        ).result,
      ).toMatchObject({ deleted: true, conflictCopies: 1 });
    });

    it("expires a no-save session on virtual time while protecting a streaming transfer", async () => {
      const session = await adapter.createSession(
        a,
        { requestId: randomUUID(), workId: null },
        t0,
      );
      expect(session).toMatchObject({
        state: "active",
        workId: null,
        leaseExpiresAt: at(360 * minute).toISOString(),
      });
      const holder = { sessionId: session.id };
      const idle = await adapter.registerItem(
        a,
        staticCommand(holder),
        at(minute),
      );
      expect(await adapter.expireSession(session.id, at(359 * minute))).toEqual(
        {
          status: "active",
          cancelledComponentIds: [],
        },
      );
      expect(
        (await adapter.heartbeatSession(a, session.id, at(300 * minute)))
          .leaseExpiresAt,
      ).toBe(at(660 * minute).toISOString());
      await expect(
        adapter.heartbeatSession(b, session.id, at(300 * minute)),
      ).rejects.toMatchObject({ name: "CommunityNotFoundError" });
      const streaming = await adapter.registerItem(
        a,
        staticCommand(holder, 4 * MiB),
        at(400 * minute),
      );
      const component = streaming.components[0];
      if (component === undefined) throw new Error("component missing");
      const fence = await adapter.beginComponentUpload(
        a,
        component.id,
        { attempt: randomUUID(), contentLength: 4 * MiB, supersede: false },
        at(400 * minute),
      );
      // An operator lengthens the lease setting while the transfer streams;
      // the lease granted at the start still lapses at 760 minutes, but the
      // transfer protects the session for 720 minutes from its start.
      const restore = await changeSettings(
        { unsavedSessionLeaseMinutes: 720 },
        at(401 * minute),
      );
      try {
        expect(
          await adapter.expireSession(session.id, at(761 * minute)),
        ).toEqual({ status: "active", cancelledComponentIds: [] });
        // A heartbeat follows the same rule and renews the protected session.
        expect(
          (await adapter.heartbeatSession(a, session.id, at(761 * minute)))
            .leaseExpiresAt,
        ).toBe(at((761 + 720) * minute).toISOString());
        await expect(
          adapter.heartbeatSession(b, session.id, at(761 * minute)),
        ).rejects.toMatchObject({ name: "CommunityNotFoundError" });
      } finally {
        await restore();
      }
      // Lapsed again with the transfer started more than one lease ago: both
      // the heartbeat and the expiry treat it as gone.
      expect(
        await adapter.expireSession(session.id, at(1481 * minute)),
      ).toEqual({ status: "active", cancelledComponentIds: [] });
      await expect(
        adapter.heartbeatSession(a, session.id, at(1482 * minute)),
      ).rejects.toMatchObject({ name: "CommunityNotFoundError" });
      const expired = await adapter.expireSession(
        session.id,
        at(1482 * minute),
      );
      expect(expired).toEqual({
        status: "expired",
        cancelledComponentIds: [component.id],
      });
      expect(await itemState(idle.id)).toBe("cancelled");
      expect(await itemState(streaming.id)).toBe("cancelled");
      expect(await refsOf(idle.id)).toEqual([]);
      expect(await jobsFor(streaming.id)).toMatchObject([
        { kind: "purge_item", state: "queued" },
      ]);
      expect(await capacity(a)).toMatchObject({ reservedBytes: 0 });
      expect(
        await adapter.expireSession(session.id, at(1483 * minute)),
      ).toEqual({
        status: "ended",
        cancelledComponentIds: [],
      });
      expect(
        await adapter.commitComponentUpload(
          fence,
          blobOf(4 * MiB),
          at(1484 * minute),
        ),
      ).toEqual({ status: "cancelled" });
      await expect(
        adapter.registerItem(a, staticCommand(holder), at(1485 * minute)),
      ).rejects.toMatchObject({ name: "CommunityConflictError" });
      expect(
        await adapter.expireSession(`publishing-session-${hex()}`, t0),
      ).toEqual({ status: "missing", cancelledComponentIds: [] });
      const state = await pool.query<{ state: string; ended_at: Date }>(
        "SELECT state,ended_at FROM community.publishing_sessions WHERE id=$1",
        [session.id],
      );
      expect(state.rows[0]).toEqual({
        state: "expired",
        ended_at: at(1482 * minute),
      });
    });

    it("discards a session immediately and keeps media another holder references", async () => {
      const session = await adapter.createSession(
        a,
        { requestId: randomUUID(), workId: null },
        t0,
      );
      const draft = await newDraft(a);
      const temporary = await adapter.registerItem(
        a,
        staticCommand({ sessionId: session.id }),
        t0,
      );
      const alsoInDraft = await adapter.registerItem(
        a,
        staticCommand({ sessionId: session.id }),
        t0,
      );
      await adapter.saveDraft(
        a,
        draft.id,
        {
          baseRevision: 1,
          content: text("草稿", [entry(alsoInDraft)]),
          deviceClass: null,
        },
        t0,
      );
      const request = { requestId: randomUUID() };
      const discarded = await adapter.discardSession(
        a,
        session.id,
        request,
        at(minute),
      );
      expect(discarded).toEqual({
        result: { discarded: true },
        cancelledComponentIds: [],
      });
      expect(
        await adapter.discardSession(a, session.id, request, at(2 * minute)),
      ).toEqual(discarded);
      expect(await itemState(temporary.id)).toBe("cancelled");
      expect(await itemState(alsoInDraft.id)).toBe("awaiting_upload");
      expect(await refsOf(alsoInDraft.id)).toEqual([
        { holder_kind: "draft", holder_id: draft.id },
      ]);
      await expect(
        adapter.heartbeatSession(a, session.id, at(3 * minute)),
      ).rejects.toMatchObject({ name: "CommunityNotFoundError" });
      await expect(
        adapter.createSession(
          a,
          { requestId: randomUUID(), workId: `work-${hex()}` },
          t0,
        ),
      ).rejects.toMatchObject({ name: "CommunityNotFoundError" });
    });

    it("leases, renews, backs off and requeues jobs by the injected clock", async () => {
      const subject = `test-${hex()}`;
      jobSubjects.push(subject, `${subject}-once`, `${subject}-lease`);
      const kinds = ["sweep_staging"] as const;
      const queued = await adapter.enqueueJob(
        { kind: "sweep_staging", subjectId: subject, maxAttempts: 3 },
        t0,
      );
      expect(queued.created).toBe(true);
      expect(
        await adapter.enqueueJob(
          { kind: "sweep_staging", subjectId: subject },
          t0,
        ),
      ).toEqual({ id: queued.id, created: false });
      const claim = (owner: string, now: Date, leaseMs = minute) =>
        adapter
          .claimJobs({ owner, limit: 100, leaseMs, kinds }, now)
          .then((claims) =>
            claims.filter((job) => job.subjectId.startsWith(subject)),
          );
      expect(await claim("worker-a", at(-second))).toEqual([]);
      const [first] = await claim("worker-a", t0);
      expect(first).toMatchObject({
        id: queued.id,
        attempts: 1,
        maxAttempts: 3,
        leaseOwner: "worker-a",
        leaseExpiresAt: at(minute),
        payload: null,
      });
      if (first === undefined) throw new Error("claim missing");
      expect(await adapter.renewJobLease(first, minute, at(30 * second))).toBe(
        true,
      );
      expect(
        await adapter.renewJobLease(
          { id: first.id, leaseOwner: "worker-b" },
          minute,
          at(30 * second),
        ),
      ).toBe(false);
      await adapter.requeueExpiredJobs(at(89 * second), 100);
      expect((await jobsFor(subject))[0]?.state).toBe("running");
      expect(
        await adapter.requeueExpiredJobs(at(91 * second), 100),
      ).toBeGreaterThanOrEqual(1);
      expect((await jobsFor(subject))[0]).toMatchObject({
        state: "queued",
        attempts: 1,
        last_error_code: "lease_expired",
        run_after: at(91 * second),
      });
      expect(await adapter.completeJob(first, at(92 * second))).toBe(false);
      const [second2] = await claim("worker-b", at(92 * second));
      if (second2 === undefined) throw new Error("claim missing");
      expect(second2.attempts).toBe(2);
      expect(
        await adapter.failJob(second2, "store_unavailable", at(100 * second)),
      ).toBe("retry_scheduled");
      expect((await jobsFor(subject))[0]).toMatchObject({
        state: "queued",
        run_after: at(160 * second),
        last_error_code: "store_unavailable",
      });
      expect(await claim("worker-b", at(159 * second))).toEqual([]);
      const [third] = await claim("worker-c", at(160 * second));
      if (third === undefined) throw new Error("claim missing");
      expect(third.attempts).toBe(3);
      expect(
        await adapter.failJob(third, "store_unavailable", at(170 * second)),
      ).toBe("failed");
      expect(
        await adapter.failJob(third, "store_unavailable", at(171 * second)),
      ).toBe("lease_lost");
      expect(await claim("worker-c", at(day))).toEqual([]);
      // A deterministic failure is final at once.
      await adapter.enqueueJob(
        { kind: "sweep_staging", subjectId: `${subject}-once` },
        t0,
      );
      const [once] = await claim("worker-d", t0);
      if (once === undefined) throw new Error("claim missing");
      expect(
        await adapter.failJob(once, "decode_failed", at(second), {
          retryable: false,
        }),
      ).toBe("failed");
      // The last allowed attempt losing its lease fails with lease_expired.
      await adapter.enqueueJob(
        {
          kind: "sweep_staging",
          subjectId: `${subject}-lease`,
          maxAttempts: 1,
        },
        t0,
      );
      const [leased] = await claim("worker-e", t0, 10 * second);
      if (leased === undefined) throw new Error("claim missing");
      await adapter.requeueExpiredJobs(at(11 * second), 100);
      expect((await jobsFor(`${subject}-lease`))[0]).toMatchObject({
        state: "failed",
        last_error_code: "lease_expired",
      });
      // Completion needs the held lease.
      const fresh = await adapter.enqueueJob(
        { kind: "sweep_staging", subjectId: subject },
        at(day),
      );
      expect(fresh.created).toBe(true);
      const [done] = await claim("worker-f", at(day));
      if (done === undefined) throw new Error("claim missing");
      expect(
        await adapter.completeJob(
          { id: done.id, leaseOwner: "worker-x" },
          at(day),
        ),
      ).toBe(false);
      expect(await adapter.completeJob(done, at(day + second))).toBe(true);
      expect((await jobsFor(subject)).map((job) => job.state)).toEqual([
        "failed",
        "succeeded",
      ]);
    });

    it("records processing results, derives edit keys and reports readiness", async () => {
      const draft = await newDraft(a);
      const holder = { draftId: draft.id };
      const live = await adapter.registerItem(a, liveCommand(holder), t0);
      const still = await adapter.registerItem(
        a,
        staticCommand(holder, 2 * MiB),
        t0,
      );
      await uploadAll(a, live);
      await uploadAll(a, still);
      const [processJob] = await jobsFor(live.id);
      expect(processJob).toMatchObject({
        kind: "process_item",
        state: "queued",
      });
      const input = await adapter.readProcessing({
        kind: "process_item",
        subjectId: live.id,
        payload: null,
      });
      expect(input).toMatchObject({
        mode: "process",
        itemId: live.id,
        ownerId: a,
        kind: "live",
        qualityMode: "standard",
        editKey: "base",
        edit: { rotation: 0, crop: null },
        coverCrop: null,
        variants: ["thumb", "display", "full", "motion", "cover"],
        clientPairing: {
          method: "apple-content-identifier",
          identifierSha256: sha("pair"),
          stillTimeMs: 1500,
        },
      });
      expect(input?.components.map((component) => component.role)).toEqual([
        "still",
        "motion",
      ]);
      const outcome = processedOutcome(live);
      expect(await adapter.markItemReady(live.id, outcome, at(minute))).toEqual(
        {
          status: "recorded",
        },
      );
      // A replayed result keeps its recorded blobs; a second run's new
      // derivatives are handed back for removal.
      expect(await adapter.markItemReady(live.id, outcome, at(minute))).toEqual(
        { status: "recorded" },
      );
      const rerun = processedOutcome(live);
      expect(await adapter.markItemReady(live.id, rerun, at(minute))).toEqual({
        status: "discarded",
        storageKeys: rerun.derivatives.map((record) => record.storageKey),
      });
      const ready = await adapter.readItem(a, live.id);
      expect(ready).toMatchObject({
        state: "ready",
        presentation: {
          width: 1440,
          height: 1920,
          durationMs: 3000,
          hasAudio: true,
        },
        media: {
          thumbSrc: `/api/community/publishing/media/${live.id}/thumb/base`,
          motionSrc: `/api/community/publishing/media/${live.id}/motion/base`,
        },
      });
      expect(ready.presentation).not.toHaveProperty("displayRotation");
      const privateFacts = await pool.query<{
        metadata: { server: unknown };
        states: string[];
      }>(
        "SELECT i.private_metadata AS metadata, array_agg(c.state ORDER BY c.role) AS states FROM community.media_items i JOIN community.media_components c ON c.item_id=i.id WHERE i.id=$1 GROUP BY i.private_metadata",
        [live.id],
      );
      expect(privateFacts.rows[0]).toEqual({
        metadata: {
          standardOutcomes: { still: "optimized", motion: "optimized" },
          server: { stillExifOrientation: 6, displayRotation: 90 },
        },
        states: ["verified", "verified"],
      });
      expect(await capacity(a)).toMatchObject({
        committedBytes: 3 * MiB + 2 * MiB + 5 * 1000,
        reservedBytes: allowance(2 * MiB),
      });
      // The still fails processing; its allowance is released, blobs stay.
      await adapter.markItemFailed(still.id, "decode_failed", at(minute));
      expect(await adapter.readItem(a, still.id)).toMatchObject({
        state: "failed",
        failureCode: "decode_failed",
      });
      expect((await capacity(a)).reservedBytes).toBe(0);
      const cropped: MediaCrop = { x: 0.1, y: 0.2, width: 0.5, height: 0.5 };
      const content: WorkDraftContent = {
        ...text("编辑", [entry(live, { rotation: 90 }), entry(still)]),
        coverKey: live.id,
        coverCrop: cropped,
      };
      const saved = await adapter.saveDraft(
        a,
        draft.id,
        { baseRevision: 1, content, deviceClass: "phone" },
        at(2 * minute),
      );
      expect(saved.status).toBe("saved");
      const keys = await pool.query<{ edit_key: string; cover_key: string }>(
        `SELECT payload->>'editKey' AS edit_key, payload->'coverCrop' AS cover_key
         FROM community.publishing_jobs WHERE subject_id=$1 AND kind='derive_edit' ORDER BY payload->>'editKey'`,
        [live.id],
      );
      expect(keys.rows).toHaveLength(2);
      const rotationKey = sha('[{"crop": null, "rotation": 90}, null]').slice(
        0,
        32,
      );
      const coverKey = sha(
        '[{"crop": null, "rotation": 90}, {"x": 0.1, "y": 0.2, "width": 0.5, "height": 0.5}]',
      ).slice(0, 32);
      const deriveJobs = (await jobsFor(live.id)).filter(
        (job) => job.kind === "derive_edit",
      );
      expect(
        deriveJobs
          .map((job) => job.payload)
          .sort((left, right) =>
            (left?.editKey ?? "") < (right?.editKey ?? "") ? -1 : 1,
          ),
      ).toEqual(
        [
          {
            editKey: rotationKey,
            edit: { rotation: 90, crop: null },
            coverCrop: null,
            variants: ["display", "full", "motion"],
          },
          {
            editKey: coverKey,
            edit: { rotation: 90, crop: null },
            coverCrop: cropped,
            variants: ["thumb", "cover"],
          },
        ].sort((left, right) => (left.editKey < right.editKey ? -1 : 1)),
      );
      expect(
        await adapter.ensureEditDerivatives(
          a,
          {
            items: [
              ...content.items,
              entry(null),
              {
                ...entry(still),
                key: "foreign",
                itemId: `media-item-${hex()}`,
              },
            ],
            coverKey: content.coverKey,
            coverCrop: content.coverCrop,
          },
          at(3 * minute),
        ),
      ).toEqual({
        ready: false,
        items: [
          { key: live.id, itemId: live.id, state: "deriving", editKey: null },
          { key: still.id, itemId: still.id, state: "failed", editKey: null },
          {
            key: expect.stringMatching(/^pending-/u),
            itemId: null,
            state: "pending",
            editKey: null,
          },
          {
            key: "foreign",
            itemId: expect.stringMatching(/^media-item-/u),
            state: "unavailable",
            editKey: null,
          },
        ],
      });
      // The user retries the failed still: new attempt, reservation taken again.
      const blobBefore = await pool.query<{ blob_id: string }>(
        "SELECT blob_id FROM community.media_components WHERE item_id=$1",
        [still.id],
      );
      const retried = await adapter.resetComponent(
        a,
        still.id,
        "still",
        { requestId: randomUUID() },
        at(4 * minute),
      );
      expect(retried).toMatchObject({
        item: { state: "awaiting_upload", failureCode: null },
        cancelledComponentIds: [],
      });
      expect((await capacity(a)).reservedBytes).toBe(
        2 * MiB + allowance(2 * MiB),
      );
      const releasedBlob = blobBefore.rows[0]?.blob_id ?? "";
      jobSubjects.push(releasedBlob);
      expect(await jobsFor(releasedBlob)).toMatchObject([
        { kind: "purge_blob" },
      ]);
      expect(
        await adapter.purgeBlob(releasedBlob, at(5 * minute)),
      ).toMatchObject({
        status: "tombstoned",
      });
      const committedBefore = (await capacity(a)).committedBytes;
      await adapter.confirmPurged([releasedBlob], at(5 * minute));
      expect((await capacity(a)).committedBytes).toBe(
        committedBefore - 2 * MiB,
      );
      // The derive jobs run and record their edit derivatives.
      const claims = await adapter.claimJobs(
        {
          owner: `worker-${hex()}`,
          limit: 100,
          leaseMs: minute,
          kinds: ["derive_edit"],
        },
        at(6 * minute),
      );
      const mine = claims.filter((claim) => claim.subjectId === live.id);
      expect(mine).toHaveLength(2);
      for (const claim of mine) {
        const derive = await adapter.readProcessing(claim);
        expect(derive).toMatchObject({
          mode: "derive",
          editKey: claim.payload?.editKey,
          variants: claim.payload?.variants,
        });
        const derived: PublishingDerivedOutcome = {
          status: "derived",
          derivatives: derivativesOf(
            (claim.payload?.variants ?? []) as PublishingDerivativeVariant[],
            claim.payload?.editKey ?? "",
          ),
        };
        expect(
          await adapter.recordDerivatives(live.id, derived, at(7 * minute)),
        ).toEqual({
          status: "recorded",
        });
        expect(await adapter.completeJob(claim, at(7 * minute))).toBe(true);
      }
      expect(
        await adapter.ensureEditDerivatives(
          a,
          {
            items: [content.items[0] as WorkDraftItem],
            coverKey: live.id,
            coverCrop: cropped,
          },
          at(8 * minute),
        ),
      ).toEqual({
        ready: true,
        // The cover item's thumb key carries its cover crop.
        items: [
          { key: live.id, itemId: live.id, state: "ready", editKey: coverKey },
        ],
      });
      const page = await adapter.listDrafts(a, { page: 1, pageSize: 20 });
      expect(page.items[0]).toMatchObject({
        id: draft.id,
        coverSrc: `/api/community/publishing/media/${live.id}/thumb/${coverKey}`,
        itemCount: 2,
        missingLocalCount: 0,
      });
      expect(
        await adapter.readProcessing({
          kind: "process_item",
          subjectId: live.id,
          payload: null,
        }),
      ).toBeNull();
      const counters = await capacity(a);
      await pool.query(
        "UPDATE community.account_publishing_capacity SET committed_bytes=0, reserved_bytes=0 WHERE account_id=$1",
        [a],
      );
      expect(await adapter.reconcileCapacity(a, at(9 * minute))).toEqual(
        counters,
      );
      expect(counters).toMatchObject({
        committedBytes: 3 * MiB + 10 * 1000,
        reservedBytes: 2 * MiB + allowance(2 * MiB),
      });
      const unknownKey = blobOf(1).storageKey;
      expect(
        await adapter.unrecordedStorageKeys([
          unknownKey,
          outcome.derivatives[0]?.storageKey ?? "",
        ]),
      ).toEqual([unknownKey]);
    }, 30_000);

    it("purges only unreferenced items, tombstoning blobs before confirmation", async () => {
      const draft = await newDraft(a);
      const item = await adapter.registerItem(
        a,
        staticCommand({ draftId: draft.id }, MiB),
        t0,
      );
      await uploadAll(a, item);
      await adapter.markItemReady(item.id, processedOutcome(item), t0);
      await adapter.snapshotDraft(
        a,
        draft.id,
        {
          baseRevision: 1,
          content: text("有图", [entry(item)]),
          deviceClass: null,
        },
        at(minute),
      );
      expect(await adapter.purgeItem(item.id, at(2 * minute))).toEqual({
        status: "referenced",
      });
      const source = await pool.query<{ blob_id: string }>(
        "SELECT blob_id FROM community.media_components WHERE item_id=$1",
        [item.id],
      );
      const sourceBlob = source.rows[0]?.blob_id ?? "";
      expect(await adapter.purgeBlob(sourceBlob, at(2 * minute))).toEqual({
        status: "referenced",
      });
      // Dropping the item from the draft leaves the snapshot's ref.
      await adapter.saveDraft(
        a,
        draft.id,
        { baseRevision: 2, content: text("无图"), deviceClass: null },
        at(3 * minute),
      );
      expect(await refsOf(item.id)).toMatchObject([
        { holder_kind: "snapshot" },
      ]);
      expect(await adapter.purgeItem(item.id, at(4 * minute))).toEqual({
        status: "referenced",
      });
      const deletion = await adapter.deleteDraft(
        a,
        draft.id,
        { requestId: randomUUID() },
        at(5 * minute),
      );
      expect(deletion.result.mediaItems).toBe(1);
      const committed = (await capacity(a)).committedBytes;
      expect(committed).toBe(MiB + 4 * 1000);
      const plan = await adapter.purgeItem(item.id, at(6 * minute));
      if (plan.status !== "tombstoned") throw new Error("expected tombstones");
      expect(plan.blobs).toHaveLength(5);
      const states = await pool.query<{ state: string; count: string }>(
        "SELECT state, count(*)::text AS count FROM community.media_blobs WHERE owner_id=$1 GROUP BY state",
        [a],
      );
      expect(states.rows).toEqual([{ state: "tombstoned", count: "5" }]);
      expect((await capacity(a)).committedBytes).toBe(committed);
      expect(await itemState(item.id)).toBe("purged");
      const blobIds = plan.blobs.map((blob) => blob.blobId);
      await adapter.confirmPurged(blobIds, at(7 * minute));
      await adapter.confirmPurged(blobIds, at(8 * minute));
      expect(await capacity(a)).toMatchObject({
        committedBytes: 0,
        reservedBytes: 0,
      });
      expect(await adapter.purgeItem(item.id, at(9 * minute))).toEqual({
        status: "missing",
      });
      expect(await adapter.purgeBlob(sourceBlob, at(9 * minute))).toEqual({
        status: "missing",
      });
    });

    it("schedules cleanup for lapsed sessions, orphans past their grace and old tombstones", async () => {
      const session = await adapter.createSession(
        a,
        { requestId: randomUUID(), workId: null },
        t0,
      );
      const draft = await newDraft(a);
      const orphan = await adapter.registerItem(
        a,
        staticCommand({ draftId: draft.id }),
        t0,
      );
      const current = await adapter.registerItem(
        a,
        staticCommand({ draftId: draft.id }),
        t0,
      );
      await adapter.saveDraft(
        a,
        draft.id,
        {
          baseRevision: 1,
          content: text("两张", [entry(orphan), entry(current)]),
          deviceClass: null,
        },
        t0,
      );
      await adapter.saveDraft(
        a,
        draft.id,
        {
          baseRevision: 2,
          content: text("一张", [entry(current)]),
          deviceClass: null,
        },
        t0,
      );
      expect(await refsOf(orphan.id)).toEqual([]);
      const sweep = (now: Date) => adapter.scheduleCleanup(now, 1000);
      await sweep(at(minute));
      expect(await jobsFor(session.id)).toEqual([]);
      expect(await jobsFor(orphan.id)).toEqual([]);
      const lapsed = await sweep(at(361 * minute));
      expect(lapsed.expireSession).toBeGreaterThanOrEqual(1);
      expect(await jobsFor(session.id)).toMatchObject([
        { kind: "expire_session", state: "queued" },
      ]);
      await sweep(at(6 * day));
      expect(await jobsFor(orphan.id)).toEqual([]);
      const graced = await sweep(at(7 * day + second));
      expect(graced.purgeItem).toBeGreaterThanOrEqual(1);
      expect(await jobsFor(orphan.id)).toMatchObject([{ kind: "purge_item" }]);
      expect(await jobsFor(current.id)).toEqual([]);
      await sweep(at(8 * day));
      expect(await jobsFor(orphan.id)).toHaveLength(1);
      expect(await jobsFor(session.id)).toHaveLength(1);
      const plan = await adapter.purgeItem(orphan.id, at(8 * day));
      expect(plan).toEqual({ status: "tombstoned", blobs: [] });
      // An uploaded blob released by a component retry waits one hour.
      const retried = await adapter.registerItem(
        a,
        staticCommand({ draftId: draft.id }),
        at(8 * day),
      );
      await uploadAll(a, retried, at(8 * day));
      await adapter.markItemFailed(retried.id, "decode_failed", at(8 * day));
      await adapter.resetComponent(
        a,
        retried.id,
        "still",
        { requestId: randomUUID() },
        at(8 * day),
      );
      const released = await pool.query<{ id: string }>(
        "SELECT id FROM community.media_blobs WHERE owner_id=$1",
        [a],
      );
      const blobId = released.rows[0]?.id ?? "";
      await pool.query(
        "DELETE FROM community.publishing_jobs WHERE subject_id=$1",
        [blobId],
      );
      await sweep(at(8 * day + 30 * minute));
      expect(await jobsFor(blobId)).toEqual([]);
      await sweep(at(8 * day + 61 * minute));
      expect(await jobsFor(blobId)).toMatchObject([{ kind: "purge_blob" }]);
    });

    it("opens one edit draft per work from its author revision and enforces the draft limit", async () => {
      const draft = await newDraft(a);
      const item = await adapter.registerItem(
        a,
        staticCommand({ draftId: draft.id }),
        t0,
      );
      await uploadAll(a, item);
      await adapter.markItemReady(item.id, processedOutcome(item), t0);
      const work = `work-${hex()}`;
      const revisionId = `work-revision-${hex()}`;
      const coverCrop = { x: 0, y: 0, width: 0.5, height: 0.5 };
      await pool.query(
        "INSERT INTO community.works(id,author_id,title,text,created_via,visibility) VALUES($1,$2,'','','publishing','self')",
        [work, a],
      );
      await pool.query(
        `INSERT INTO community.work_revisions(id,work_id,author_id,sequence,origin,title,body,authorship_kind,reference_title,requested_visibility,cover_item_id,cover_crop,content_sha256,disposition,submitted_at)
         VALUES($1,$2,$3,1,'submission','临摹','正文','copy_practice','兰亭序','self',$4,$5::jsonb,$6,'not_required',$7)`,
        [revisionId, work, a, item.id, JSON.stringify(coverCrop), sha("r"), t0],
      );
      await pool.query(
        `INSERT INTO community.work_revision_items(revision_id,position,item_id,edit) VALUES($1,1,$2,'{"rotation":180,"crop":null}')`,
        [revisionId, item.id],
      );
      await pool.query(
        "INSERT INTO community.media_item_refs(item_id,holder_kind,holder_id) VALUES($1,'revision',$2)",
        [item.id, revisionId],
      );
      await pool.query(
        "UPDATE community.works SET author_revision_id=$1 WHERE id=$2",
        [revisionId, work],
      );
      const openRequest = {
        requestId: randomUUID(),
        deviceClass: "tablet",
      } as const;
      const { draft: opened, created } = await adapter.openEditDraft(
        a,
        work,
        openRequest,
        at(minute),
      );
      expect(created).toBe(true);
      expect(opened).toMatchObject({
        kind: "edit",
        workId: work,
        baseRevisionId: revisionId,
        revision: 1,
        content: {
          title: "临摹",
          body: "正文",
          authorship: { kind: "copy_practice", referenceTitle: "兰亭序" },
          visibility: "self",
          items: [
            {
              key: item.id,
              itemId: item.id,
              kind: "static",
              qualityMode: "standard",
              edit: { rotation: 180, crop: null },
            },
          ],
          coverKey: item.id,
          coverCrop,
        },
        mediaItems: [{ id: item.id, state: "ready" }],
      });
      // Another request returns the same draft without claiming to create it;
      // a retry of the creating request answers as that request did.
      expect(
        await adapter.openEditDraft(
          a,
          work,
          { requestId: randomUUID(), deviceClass: null },
          at(2 * minute),
        ),
      ).toMatchObject({ created: false, draft: { id: opened.id } });
      expect(
        await adapter.openEditDraft(a, work, openRequest, at(2 * minute)),
      ).toMatchObject({ created: true, draft: { id: opened.id, revision: 1 } });
      expect(await refsOf(item.id)).toEqual([
        ...[draft.id, opened.id]
          .sort()
          .map((holder) => ({ holder_kind: "draft", holder_id: holder })),
        { holder_kind: "revision", holder_id: revisionId },
      ]);
      expect(
        (await jobsFor(item.id)).filter((job) => job.kind === "derive_edit"),
      ).toHaveLength(2);
      await pool.query(
        "UPDATE community.works SET trashed_at=$2, trash_purge_after=$3 WHERE id=$1",
        [work, at(3 * minute), at(30 * day)],
      );
      await expect(
        adapter.openEditDraft(
          a,
          work,
          { requestId: randomUUID(), deviceClass: null },
          at(4 * minute),
        ),
      ).rejects.toMatchObject({ message: "work_unavailable" });
      await expect(
        adapter.createSession(
          a,
          { requestId: randomUUID(), workId: work },
          at(4 * minute),
        ),
      ).rejects.toMatchObject({ message: "work_unavailable" });
      // 2 active drafts exist; conflict copies never count toward the limit.
      await adapter.saveDraft(
        a,
        draft.id,
        { baseRevision: 9, content: text("冲突"), deviceClass: null },
        at(5 * minute),
      );
      for (let index = 2; index < 100; index += 1)
        await newDraft(a, text(`草稿 ${index}`));
      await expect(newDraft(a, text("第一百零一"))).rejects.toMatchObject({
        name: "CommunityInputError",
        message: "draft_limit",
      });
      const page = await adapter.listDrafts(a, { page: 5, pageSize: 20 });
      expect(page).toMatchObject({ total: 100, totalPages: 5, page: 5 });
      expect(page.items).toHaveLength(20);
    }, 60_000);
    const firstComponent = (item: PublishingMediaItem) => {
      const component = item.components[0];
      if (component === undefined) throw new Error("component missing");
      return component;
    };

    const purgeJobs = async (itemId: string) =>
      (await jobsFor(itemId)).filter((job) => job.kind === "purge_item");

    it("keeps an old item an autosave dropped through the orphan grace and rechecks every holder before purging", async () => {
      const draft = await newDraft(a, text("有图"));
      const holder = { draftId: draft.id };
      const old = await adapter.registerItem(a, staticCommand(holder), t0);
      await uploadAll(a, old);
      await adapter.markItemReady(old.id, processedOutcome(old), t0);
      await adapter.saveDraft(
        a,
        draft.id,
        {
          baseRevision: 1,
          content: text("有图", [entry(old)]),
          deviceClass: null,
        },
        at(day),
      );
      // Registered to the draft but not yet in its content: its ref stays.
      const incoming = await adapter.registerItem(
        a,
        staticCommand(holder),
        at(10 * day),
      );
      expect(
        await adapter.saveDraft(
          a,
          draft.id,
          { baseRevision: 2, content: text("无图"), deviceClass: null },
          at(10 * day),
        ),
      ).toMatchObject({ status: "saved", draft: { revision: 3 } });
      expect(await refsOf(old.id)).toEqual([]);
      expect(await refsOf(incoming.id)).toEqual([
        { holder_kind: "draft", holder_id: draft.id },
      ]);
      await adapter.scheduleCleanup(at(10 * day + second), 1000);
      expect(await purgeJobs(old.id)).toEqual([]);
      expect(await adapter.purgeItem(old.id, at(10 * day + second))).toEqual({
        status: "referenced",
      });
      // Re-added seconds later, the item is still there and ready.
      const readded = await adapter.saveDraft(
        a,
        draft.id,
        {
          baseRevision: 3,
          content: text("有图", [entry(old)]),
          deviceClass: null,
        },
        at(10 * day + 2 * second),
      );
      expect(readded.draft.mediaItems).toMatchObject([
        { id: old.id, state: "ready" },
        { id: incoming.id, state: "awaiting_upload" },
      ]);
      // Dropped again: the grace restarts at this drop.
      await adapter.saveDraft(
        a,
        draft.id,
        { baseRevision: 4, content: text("无图"), deviceClass: null },
        at(11 * day),
      );
      await adapter.scheduleCleanup(at(18 * day - second), 1000);
      expect(await purgeJobs(old.id)).toEqual([]);
      expect(await adapter.purgeItem(old.id, at(18 * day - second))).toEqual({
        status: "referenced",
      });
      await adapter.scheduleCleanup(at(18 * day + second), 1000);
      expect(await purgeJobs(old.id)).toMatchObject([{ state: "queued" }]);
      // Safeguards beyond refs: a revision of a live work naming the item.
      const work = `work-${hex()}`;
      const revisionId = `work-revision-${hex()}`;
      await pool.query(
        "INSERT INTO community.works(id,author_id,title,text,created_via,visibility) VALUES($1,$2,'','','publishing','self')",
        [work, a],
      );
      await pool.query(
        `INSERT INTO community.work_revisions(id,work_id,author_id,sequence,origin,title,body,authorship_kind,requested_visibility,content_sha256,disposition,submitted_at)
         VALUES($1,$2,$3,1,'submission','','正文','original','self',$4,'not_required',$5)`,
        [revisionId, work, a, sha("guard"), t0],
      );
      await pool.query(
        `INSERT INTO community.work_revision_items(revision_id,position,item_id,edit) VALUES($1,1,$2,'{"rotation":0,"crop":null}')`,
        [revisionId, old.id],
      );
      expect(await adapter.purgeItem(old.id, at(18 * day + second))).toEqual({
        status: "referenced",
      });
      await pool.query("UPDATE community.works SET deleted_at=$2 WHERE id=$1", [
        work,
        at(18 * day),
      ]);
      // Draft content naming the item without its ref.
      const other = await newDraft(
        a,
        text("另一稿", [entry(old)]),
        at(18 * day),
      );
      await pool.query(
        "DELETE FROM community.media_item_refs WHERE item_id=$1 AND holder_id=$2",
        [old.id, other.id],
      );
      await pool.query(
        "UPDATE community.media_items SET updated_at=$2 WHERE id=$1",
        [old.id, at(11 * day)],
      );
      expect(await adapter.purgeItem(old.id, at(18 * day + second))).toEqual({
        status: "referenced",
      });
      await pool.query(
        `UPDATE community.work_drafts SET content=jsonb_set(content,'{items}','[]'::jsonb) WHERE id=$1`,
        [other.id],
      );
      const plan = await adapter.purgeItem(old.id, at(18 * day + second));
      expect(plan).toMatchObject({ status: "tombstoned" });
      expect(plan.status === "tombstoned" && plan.blobs).toHaveLength(5);
      expect(await itemState(incoming.id)).toBe("awaiting_upload");
    });

    it("stores content-free draft receipts, reads replays again and resolves a conflict for the account version", async () => {
      const secret = "只属于这份草稿的正文";
      const createRequest = {
        requestId: randomUUID(),
        content: text(secret),
        deviceClass: "phone" as const,
      };
      const created = await adapter.createDraft(a, createRequest, t0);
      expect(await adapter.createDraft(a, createRequest, at(second))).toEqual(
        created,
      );
      // Another account's subjects are not found, never touched.
      const foreignDraft = await newDraft(b);
      const foreign = await adapter.registerItem(
        b,
        staticCommand({ draftId: foreignDraft.id }),
        t0,
      );
      for (const refused of [
        () =>
          adapter.cancelItem(a, foreign.id, { requestId: randomUUID() }, t0),
        () =>
          adapter.resetComponent(
            a,
            foreign.id,
            "still",
            { requestId: randomUUID() },
            t0,
          ),
        () =>
          adapter.saveDraft(
            a,
            created.id,
            {
              baseRevision: 1,
              content: text("借用", [entry(foreign)]),
              deviceClass: null,
            },
            t0,
          ),
        () => newDraft(a, text("借用", [entry(foreign)])),
        () =>
          adapter.registerItem(
            a,
            staticCommand({ draftId: foreignDraft.id }),
            t0,
          ),
      ])
        await expect(refused()).rejects.toMatchObject({
          name: "CommunityNotFoundError",
        });
      expect(await itemState(foreign.id)).toBe("awaiting_upload");
      expect(await refsOf(foreign.id)).toEqual([
        { holder_kind: "draft", holder_id: foreignDraft.id },
      ]);
      await adapter.snapshotDraft(
        a,
        created.id,
        {
          baseRevision: 1,
          content: text(`${secret} 2`),
          deviceClass: "phone",
        },
        at(minute),
      );
      const [target] = (
        await adapter.listHistory(a, created.id, { page: 1, pageSize: 10 })
      ).items;
      if (target === undefined) throw new Error("snapshot missing");
      await adapter.saveDraft(
        a,
        created.id,
        { baseRevision: 2, content: text("第三版"), deviceClass: "phone" },
        at(2 * minute),
      );
      const restoreRequest = { requestId: randomUUID(), snapshotId: target.id };
      expect(
        await adapter.restoreSnapshot(
          a,
          created.id,
          restoreRequest,
          at(3 * minute),
        ),
      ).toMatchObject({ revision: 4, content: { body: `${secret} 2` } });
      // Restoring keeps the replaced content in history.
      expect(
        (
          await adapter.listHistory(a, created.id, { page: 1, pageSize: 10 })
        ).items.map((snapshot) => [snapshot.kind, snapshot.content.body]),
      ).toEqual([
        ["restored", `${secret} 2`],
        ["saved", "第三版"],
        ["saved", `${secret} 2`],
      ]);
      await adapter.saveDraft(
        a,
        created.id,
        { baseRevision: 4, content: text("第五版"), deviceClass: "phone" },
        at(4 * minute),
      );
      // A replay answers with the current draft; nothing is applied again.
      expect(
        await adapter.restoreSnapshot(
          a,
          created.id,
          restoreRequest,
          at(5 * minute),
        ),
      ).toMatchObject({ revision: 5, content: { body: "第五版" } });
      const item = await adapter.registerItem(
        a,
        staticCommand({ draftId: created.id }),
        at(5 * minute),
      );
      const stale = await adapter.saveDraft(
        a,
        created.id,
        {
          baseRevision: 1,
          content: text("旧设备", [entry(item)]),
          deviceClass: "tablet",
        },
        at(6 * minute),
      );
      if (stale.status !== "conflict") throw new Error("expected a conflict");
      const resolveRequest = {
        requestId: randomUUID(),
        conflictId: stale.conflict.id,
        choice: "account" as const,
      };
      const kept = await adapter.resolveConflict(
        a,
        created.id,
        resolveRequest,
        at(7 * minute),
      );
      expect(kept).toMatchObject({
        revision: 5,
        content: { body: "第五版" },
        conflict: null,
      });
      expect(
        await adapter.resolveConflict(
          a,
          created.id,
          resolveRequest,
          at(8 * minute),
        ),
      ).toEqual(kept);
      const snapshots = await adapter.listHistory(a, created.id, {
        page: 1,
        pageSize: 10,
      });
      // Both choices survive: the selected account version is an important
      // snapshot before newer in-flight typing can autosave over it.
      expect(snapshots.items[0]).toMatchObject({
        kind: "saved",
        pinned: false,
        content: { body: "第五版" },
      });
      const conflictSnapshot = snapshots.items.find(
        (snapshot) => snapshot.kind === "conflict",
      );
      expect(conflictSnapshot).toMatchObject({
        kind: "conflict",
        pinned: true,
        content: { body: "旧设备" },
      });
      expect(await refsOf(item.id)).toEqual(
        [
          { holder_kind: "draft", holder_id: created.id },
          { holder_kind: "snapshot", holder_id: conflictSnapshot?.id ?? "" },
        ].sort((left, right) =>
          left.holder_kind < right.holder_kind ? -1 : 1,
        ),
      );
      const copy = await pool.query<{ resolved_at: Date | null }>(
        "SELECT resolved_at FROM community.work_drafts WHERE id=$1",
        [stale.conflict.id],
      );
      expect(copy.rows[0]?.resolved_at).toEqual(at(7 * minute));
      const receipts = await pool.query<{ result: unknown }>(
        "SELECT result FROM community.author_command_receipts WHERE actor_id=$1",
        [a],
      );
      expect(receipts.rows.map((row) => row.result)).toContainEqual({
        draftId: created.id,
      });
      for (const row of receipts.rows)
        expect(JSON.stringify(row.result)).not.toMatch(
          /正文|第三版|第五版|旧设备/u,
        );
      await adapter.deleteDraft(
        a,
        created.id,
        { requestId: randomUUID() },
        at(9 * minute),
      );
      await expect(
        adapter.restoreSnapshot(a, created.id, restoreRequest, at(10 * minute)),
      ).rejects.toMatchObject({ name: "CommunityNotFoundError" });
      await expect(
        adapter.createDraft(a, createRequest, at(10 * minute)),
      ).rejects.toMatchObject({ name: "CommunityNotFoundError" });
      await expect(
        adapter.resolveConflict(a, created.id, resolveRequest, at(10 * minute)),
      ).rejects.toMatchObject({ name: "CommunityNotFoundError" });
    });

    it("replaces a device's own conflict copy on the same stale base instead of adding copies", async () => {
      const draft = await newDraft(a, text("账户"));
      await adapter.saveDraft(
        a,
        draft.id,
        { baseRevision: 1, content: text("账户 2"), deviceClass: "desktop" },
        at(minute),
      );
      const item = await adapter.registerItem(
        a,
        staticCommand({ draftId: draft.id }),
        at(minute),
      );
      const first = await adapter.saveDraft(
        a,
        draft.id,
        {
          baseRevision: 1,
          content: text("手机 1", [entry(item)]),
          deviceClass: "phone",
        },
        at(2 * minute),
      );
      const second2 = await adapter.saveDraft(
        a,
        draft.id,
        { baseRevision: 1, content: text("手机 2"), deviceClass: "phone" },
        at(3 * minute),
      );
      if (first.status !== "conflict" || second2.status !== "conflict")
        throw new Error("expected conflicts");
      expect(second2.conflict).toMatchObject({
        id: first.conflict.id,
        device: {
          content: { body: "手机 2" },
          deviceClass: "phone",
          savedAt: at(3 * minute).toISOString(),
        },
        account: { content: { body: "账户 2" }, revision: 2 },
      });
      const pinned = async () =>
        (
          await adapter.listHistory(a, draft.id, { page: 1, pageSize: 20 })
        ).items
          .filter((snapshot) => snapshot.pinned)
          .map((snapshot) => snapshot.content.body)
          .sort();
      const copies = async () =>
        (
          await pool.query(
            "SELECT 1 FROM community.work_drafts WHERE conflict_of=$1",
            [draft.id],
          )
        ).rowCount;
      expect(await copies()).toBe(1);
      expect(await pinned()).toEqual(["手机 2"]);
      // The copy and its snapshot no longer hold the item the device dropped.
      expect(await refsOf(item.id)).toEqual([
        { holder_kind: "draft", holder_id: draft.id },
      ]);
      const tablet = await adapter.saveDraft(
        a,
        draft.id,
        { baseRevision: 1, content: text("平板"), deviceClass: "tablet" },
        at(4 * minute),
      );
      if (tablet.status !== "conflict") throw new Error("expected a conflict");
      expect(tablet.conflict.id).not.toBe(first.conflict.id);
      const retried = await adapter.saveDraft(
        a,
        draft.id,
        { baseRevision: 1, content: text("手机 2"), deviceClass: "phone" },
        at(5 * minute),
      );
      expect(retried.status === "conflict" && retried.conflict.id).toBe(
        first.conflict.id,
      );
      expect(await copies()).toBe(2);
      expect(await pinned()).toEqual(["平板", "手机 2"].sort());
    });

    it("settles derive jobs for draft edits, covers missing variants and releases edit derivatives nothing needs", async () => {
      const draft = await newDraft(a);
      const item = await adapter.registerItem(
        a,
        staticCommand({ draftId: draft.id }),
        t0,
      );
      await uploadAll(a, item);
      await adapter.markItemReady(item.id, processedOutcome(item), t0);
      const keyOf = (rotation: number) =>
        sha(`[{"crop": null, "rotation": ${rotation}}, null]`).slice(0, 32);
      const rotated = (rotation: 0 | 90 | 180 | 270) =>
        text("旋转", [entry(item, { rotation })]);
      const derives = async () =>
        (await jobsFor(item.id))
          .filter((job) => job.kind === "derive_edit")
          .map((job) => ({
            key: job.payload?.editKey,
            variants: job.payload?.variants,
            state: job.state,
            runAfter: job.run_after,
          }));
      await adapter.saveDraft(
        a,
        draft.id,
        { baseRevision: 1, content: rotated(90), deviceClass: "phone" },
        at(minute),
      );
      expect(await derives()).toEqual([
        {
          key: keyOf(90),
          variants: ["thumb", "display", "full"],
          state: "queued",
          runAfter: at(minute + 30 * second),
        },
      ]);
      // A newer rotation replaces the settling job instead of adding one.
      await adapter.saveDraft(
        a,
        draft.id,
        { baseRevision: 2, content: rotated(180), deviceClass: "phone" },
        at(minute + 5 * second),
      );
      expect(await derives()).toEqual([
        {
          key: keyOf(180),
          variants: ["thumb", "display", "full"],
          state: "queued",
          runAfter: at(minute + 35 * second),
        },
      ]);
      // Explicit readiness (before a submission) lets it run now; an active
      // job covering some variants gets a sibling job for the others.
      await adapter.enqueueJob(
        {
          kind: "derive_edit",
          subjectId: item.id,
          payload: {
            editKey: keyOf(270),
            edit: { rotation: 270, crop: null },
            coverCrop: null,
            variants: ["display"],
          },
        },
        at(minute + 9 * second),
      );
      expect(
        await adapter.ensureEditDerivatives(
          a,
          {
            items: [
              entry(item, { rotation: 180 }),
              {
                ...entry(item, { rotation: 270 }),
                key: "second-use",
              },
            ],
            coverKey: null,
            coverCrop: null,
          },
          at(minute + 10 * second),
        ),
      ).toMatchObject({
        ready: false,
        items: [{ state: "deriving" }, { state: "deriving" }],
      });
      expect(await derives()).toEqual([
        {
          key: keyOf(180),
          variants: ["thumb", "display", "full"],
          state: "queued",
          runAfter: at(minute + 10 * second),
        },
        {
          key: keyOf(270),
          variants: ["display"],
          state: "queued",
          runAfter: at(minute + 9 * second),
        },
        {
          key: keyOf(270),
          variants: ["thumb", "full"],
          state: "queued",
          runAfter: at(minute + 10 * second),
        },
      ]);
      const runDerives = async (
        now: Date,
        record: (key: string) => boolean,
      ) => {
        const claims = (
          await adapter.claimJobs(
            {
              owner: `worker-${hex()}`,
              limit: 100,
              leaseMs: minute,
              kinds: ["derive_edit"],
            },
            now,
          )
        ).filter((claim) => claim.subjectId === item.id);
        for (const claim of claims) {
          const key = claim.payload?.editKey ?? "";
          if (!record(key)) {
            await adapter.failJob(claim, "decode_failed", now, {
              retryable: false,
            });
            continue;
          }
          await adapter.recordDerivatives(
            item.id,
            {
              status: "derived",
              derivatives: derivativesOf(claim.payload?.variants ?? [], key),
            },
            now,
          );
          await adapter.completeJob(claim, now);
        }
      };
      await runDerives(at(2 * minute), (key) => key === keyOf(180));
      // A variant whose job failed for that key reads as failed.
      expect(
        await adapter.ensureEditDerivatives(
          a,
          {
            items: [entry(item, { rotation: 270 })],
            coverKey: null,
            coverCrop: null,
          },
          at(2 * minute),
        ),
      ).toMatchObject({ ready: false, items: [{ state: "failed" }] });
      // Save now keeps 180 in history; the draft moves to 90, then to none.
      await adapter.snapshotDraft(
        a,
        draft.id,
        { baseRevision: 3, content: rotated(180), deviceClass: "phone" },
        at(3 * minute),
      );
      await adapter.saveDraft(
        a,
        draft.id,
        { baseRevision: 3, content: rotated(90), deviceClass: "phone" },
        at(4 * minute),
      );
      await runDerives(at(5 * minute), (key) => key === keyOf(90));
      await adapter.saveDraft(
        a,
        draft.id,
        { baseRevision: 4, content: rotated(0), deviceClass: "phone" },
        at(6 * minute),
      );
      const derivativeKeys = async () =>
        (
          await pool.query<{ edit_key: string; count: string }>(
            "SELECT edit_key, count(*)::text AS count FROM community.media_derivatives WHERE item_id=$1 GROUP BY edit_key ORDER BY edit_key",
            [item.id],
          )
        ).rows;
      const expectedKeys = (withNinety: boolean) =>
        [
          { edit_key: "base", count: "4" },
          { edit_key: keyOf(180), count: "3" },
          ...(withNinety ? [{ edit_key: keyOf(90), count: "3" }] : []),
        ].sort((left, right) => (left.edit_key < right.edit_key ? -1 : 1));
      await adapter.scheduleCleanup(at(64 * minute), 1000);
      expect(await derivativeKeys()).toEqual(expectedKeys(true));
      const counts = await adapter.scheduleCleanup(at(66 * minute), 1000);
      expect(await derivativeKeys()).toEqual(expectedKeys(false));
      const released = await pool.query<{ id: string }>(
        `SELECT b.id FROM community.media_blobs b
         WHERE b.owner_id=$1 AND b.purpose='derivative'
           AND NOT EXISTS (SELECT 1 FROM community.media_derivatives d WHERE d.blob_id=b.id)`,
        [a],
      );
      expect(released.rows).toHaveLength(3);
      expect(counts.purgeBlob).toBeGreaterThanOrEqual(3);
      for (const blob of released.rows)
        expect(await jobsFor(blob.id)).toMatchObject([
          { kind: "purge_blob", state: "queued" },
        ]);
    });

    it("commits into a lapsed session without reviving it, resets attempts of ended holders and cancels uploads history still names", async () => {
      const session = await adapter.createSession(
        a,
        { requestId: randomUUID(), workId: null },
        t0,
      );
      const item = await adapter.registerItem(
        a,
        staticCommand({ sessionId: session.id }, 2 * MiB),
        t0,
      );
      const fence = await adapter.beginComponentUpload(
        a,
        firstComponent(item).id,
        { attempt: randomUUID(), contentLength: 2 * MiB, supersede: false },
        at(10 * minute),
      );
      expect(
        await adapter.commitComponentUpload(
          fence,
          blobOf(2 * MiB),
          at(400 * minute),
        ),
      ).toMatchObject({
        status: "committed",
        result: { item: { state: "processing" } },
      });
      await expect(
        adapter.heartbeatSession(a, session.id, at(401 * minute)),
      ).rejects.toMatchObject({ name: "CommunityNotFoundError" });
      const lease = await pool.query<{ lease_expires_at: Date }>(
        "SELECT lease_expires_at FROM community.publishing_sessions WHERE id=$1",
        [session.id],
      );
      expect(lease.rows[0]?.lease_expires_at).toEqual(at(370 * minute));
      expect(await adapter.expireSession(session.id, at(401 * minute))).toEqual(
        { status: "expired", cancelledComponentIds: [] },
      );
      expect(await itemState(item.id)).toBe("cancelled");

      const draft = await newDraft(a, text("草稿"), at(500 * minute));
      const temporary = await adapter.createSession(
        a,
        { requestId: randomUUID(), workId: null },
        at(500 * minute),
      );
      const shared = await adapter.registerItem(
        a,
        staticCommand({ sessionId: temporary.id }),
        at(500 * minute),
      );
      // Save now names it in history; the draft itself then drops it.
      await adapter.snapshotDraft(
        a,
        draft.id,
        {
          baseRevision: 1,
          content: text("历史", [entry(shared)]),
          deviceClass: null,
        },
        at(501 * minute),
      );
      await adapter.saveDraft(
        a,
        draft.id,
        { baseRevision: 2, content: text("无图"), deviceClass: null },
        at(502 * minute),
      );
      const sharedFence = await adapter.beginComponentUpload(
        a,
        firstComponent(shared).id,
        { attempt: randomUUID(), contentLength: MiB, supersede: false },
        at(503 * minute),
      );
      expect(
        await adapter.discardSession(
          a,
          temporary.id,
          { requestId: randomUUID() },
          at(504 * minute),
        ),
      ).toEqual({ result: { discarded: true }, cancelledComponentIds: [] });
      expect(
        await adapter.commitComponentUpload(
          sharedFence,
          blobOf(MiB),
          at(505 * minute),
        ),
      ).toEqual({ status: "cancelled" });
      const component = await pool.query<{
        state: string;
        upload_attempt: string | null;
      }>(
        "SELECT state, upload_attempt FROM community.media_components WHERE id=$1",
        [firstComponent(shared).id],
      );
      expect(component.rows[0]).toEqual({
        state: "awaiting",
        upload_attempt: null,
      });

      const uploading = await adapter.registerItem(
        a,
        staticCommand({ draftId: draft.id }),
        at(506 * minute),
      );
      await adapter.snapshotDraft(
        a,
        draft.id,
        {
          baseRevision: 3,
          content: text("正在上传", [entry(uploading)]),
          deviceClass: null,
        },
        at(507 * minute),
      );
      const uploadingFence = await adapter.beginComponentUpload(
        a,
        firstComponent(uploading).id,
        { attempt: randomUUID(), contentLength: MiB, supersede: false },
        at(508 * minute),
      );
      expect(
        await adapter.cancelItem(
          a,
          uploading.id,
          { requestId: randomUUID() },
          at(509 * minute),
        ),
      ).toMatchObject({
        item: { state: "cancelled" },
        cancelledComponentIds: [firstComponent(uploading).id],
      });
      expect(await refsOf(uploading.id)).toMatchObject([
        { holder_kind: "snapshot" },
      ]);
      expect(await adapter.purgeItem(uploading.id, at(510 * minute))).toEqual({
        status: "referenced",
      });
      expect(
        await adapter.commitComponentUpload(
          uploadingFence,
          blobOf(MiB),
          at(510 * minute),
        ),
      ).toEqual({ status: "cancelled" });
      // Deleting the draft takes its history along; the cancelled item purges at once.
      await adapter.deleteDraft(
        a,
        draft.id,
        { requestId: randomUUID() },
        at(511 * minute),
      );
      expect(await adapter.purgeItem(uploading.id, at(512 * minute))).toEqual({
        status: "tombstoned",
        blobs: [],
      });
      expect(await capacity(a)).toMatchObject({ reservedBytes: 0 });
    });

    it("keeps capacity counters exact when registrations race worker releases and reconciliation", async () => {
      const draft = await newDraft(a);
      const holder = { draftId: draft.id };
      const processing: PublishingMediaItem[] = [];
      for (let index = 0; index < 4; index += 1) {
        const item = await adapter.registerItem(
          a,
          staticCommand(holder, 8 * MiB),
          t0,
        );
        await uploadAll(a, item);
        processing.push(item);
      }
      // 31 × (256 + 64 + 4) MiB of reservations fill the account.
      for (let index = 0; index < 31; index += 1)
        await adapter.registerItem(a, staticCommand(holder, 256 * MiB), t0);
      const before = await capacity(a);
      const free =
        before.capacityBytes - before.committedBytes - before.reservedBytes;
      // Two 64 MiB registrations fit with or without the 32 MiB released
      // meanwhile; a third never does.
      expect(free).toBe(132 * MiB);
      const settled = await Promise.allSettled([
        ...[0, 1, 2].map((index) =>
          adapter.registerItem(a, staticCommand(holder, 40 * MiB), at(index)),
        ),
        ...processing.map((item) =>
          adapter.markItemFailed(item.id, "decode_failed", at(second)),
        ),
        adapter.reconcileCapacity(a, at(second)),
      ]);
      expect(
        settled.slice(0, 3).filter((result) => result.status === "fulfilled"),
      ).toHaveLength(2);
      expect(
        settled.slice(3).every((result) => result.status === "fulfilled"),
      ).toBe(true);
      const counters = await capacity(a);
      expect(
        counters.committedBytes + counters.reservedBytes,
      ).toBeLessThanOrEqual(counters.capacityBytes);
      expect(counters).toMatchObject({
        committedBytes: 32 * MiB,
        reservedBytes: 31 * 324 * MiB + 2 * 64 * MiB,
      });
      expect(await adapter.reconcileCapacity(a, at(minute))).toEqual(counters);
    }, 60_000);

    /** A registered, fully uploaded static item: `processing` with its queued `process_item` job. */
    const processingItem = async (actor: string, now = t0) => {
      const draft = await newDraft(actor, text("处理中"), now);
      const item = await adapter.registerItem(
        actor,
        staticCommand({ draftId: draft.id }, 2 * MiB),
        now,
      );
      await uploadAll(actor, item, now);
      expect(await itemState(item.id)).toBe("processing");
      const job = (await jobsFor(item.id)).find(
        (row) => row.kind === "process_item",
      );
      if (job === undefined) throw new Error("process_item job missing");
      return { item, jobId: job.id };
    };

    it("releases a held claim without spending an attempt and only while the lease is held", async () => {
      const subject = `test-${hex()}`;
      jobSubjects.push(subject);
      const kinds = ["sweep_staging"] as const;
      const queued = await adapter.enqueueJob(
        { kind: "sweep_staging", subjectId: subject, maxAttempts: 2 },
        t0,
      );
      const claim = (owner: string, now: Date) =>
        adapter
          .claimJobs({ owner, limit: 100, leaseMs: minute, kinds }, now)
          .then((claims) => claims.filter((job) => job.subjectId === subject));
      const [first] = await claim("release-a.1", t0);
      if (first === undefined) throw new Error("claim missing");
      expect(
        await adapter.failJob(first, "store_unavailable", at(second)),
      ).toBe("retry_scheduled");
      const [second2] = await claim("release-a.2", at(31 * second));
      if (second2 === undefined) throw new Error("claim missing");
      expect(second2.attempts).toBe(2);
      // Another label never releases this claim.
      expect(
        await adapter.releaseJob(
          { id: second2.id, leaseOwner: "release-a.1" },
          at(32 * second),
        ),
      ).toBe(false);
      expect(await adapter.releaseJob(second2, at(40 * second))).toBe(true);
      expect(
        (
          await pool.query(
            "SELECT state,attempts,run_after,lease_owner,lease_expires_at,last_error_code,finished_at FROM community.publishing_jobs WHERE id=$1",
            [queued.id],
          )
        ).rows[0],
      ).toEqual({
        state: "queued",
        attempts: 1,
        run_after: at(40 * second),
        lease_owner: null,
        lease_expires_at: null,
        last_error_code: "store_unavailable",
        finished_at: null,
      });
      // Released: the same lease is gone, and the released attempt is usable.
      expect(await adapter.releaseJob(second2, at(41 * second))).toBe(false);
      expect(await adapter.completeJob(second2, at(41 * second))).toBe(false);
      const [third] = await claim("release-a.3", at(40 * second));
      if (third === undefined) throw new Error("claim missing");
      expect(third.attempts).toBe(2);
      // Attempts never drop below zero (an operator retry resets them).
      await pool.query(
        "UPDATE community.publishing_jobs SET attempts=0 WHERE id=$1",
        [third.id],
      );
      expect(await adapter.releaseJob(third, at(50 * second))).toBe(true);
      expect((await jobsFor(subject))[0]).toMatchObject({
        state: "queued",
        attempts: 0,
      });
    });

    it("fails a processing item and releases its reservation when its process_item job ends without a worker", async () => {
      const lease = async (jobId: string, attempts: number, max: number) =>
        pool.query(
          "UPDATE community.publishing_jobs SET state='running',attempts=$2,max_attempts=$3,lease_owner='gone.1',lease_expires_at=$4 WHERE id=$1",
          [jobId, attempts, max, at(minute)],
        );
      const exhausted = await processingItem(a);
      const retrying = await processingItem(b);
      const reserved = allowance(2 * MiB);
      expect(await capacity(a)).toMatchObject({
        committedBytes: 2 * MiB,
        reservedBytes: reserved,
      });
      await lease(exhausted.jobId, 1, 1);
      await lease(retrying.jobId, 1, 3);
      await adapter.requeueExpiredJobs(at(minute - second), 100);
      expect(await itemState(exhausted.item.id)).toBe("processing");
      expect(await adapter.requeueExpiredJobs(at(minute + second), 100)).toBe(
        2,
      );
      expect(await jobsFor(exhausted.item.id)).toMatchObject([
        {
          kind: "process_item",
          state: "failed",
          last_error_code: "lease_expired",
        },
      ]);
      expect(await adapter.readItem(a, exhausted.item.id)).toMatchObject({
        state: "failed",
        failureCode: "processing_failed",
      });
      expect(await capacity(a)).toMatchObject({
        committedBytes: 2 * MiB,
        reservedBytes: 0,
      });
      // A job with attempts left is queued again; its item keeps processing.
      expect(await jobsFor(retrying.item.id)).toMatchObject([
        {
          kind: "process_item",
          state: "queued",
          last_error_code: "lease_expired",
        },
      ]);
      expect(await itemState(retrying.item.id)).toBe("processing");
      expect((await capacity(b)).reservedBytes).toBe(reserved);

      // The operator abandoning a process_item job fails its item the same way.
      expect(
        await operators.abandonJob(
          retrying.jobId,
          operator,
          { requestId: randomUUID() },
          at(2 * minute),
        ),
      ).toMatchObject({ state: "abandoned" });
      expect(await adapter.readItem(b, retrying.item.id)).toMatchObject({
        state: "failed",
        failureCode: "processing_failed",
      });
      expect((await capacity(b)).reservedBytes).toBe(0);
      // A later operator retry finds nothing to process; the author resets a
      // component instead.
      await operators.retryJob(
        retrying.jobId,
        operator,
        { requestId: randomUUID() },
        at(3 * minute),
      );
      expect(
        await adapter.readProcessing({
          kind: "process_item",
          subjectId: retrying.item.id,
          payload: null,
        }),
      ).toBeNull();
      // Abandoning a job of any other kind leaves items alone.
      const other = await processingItem(a, at(4 * minute));
      const sweep = `test-${hex()}`;
      jobSubjects.push(sweep);
      const sweepJob = await adapter.enqueueJob(
        { kind: "sweep_staging", subjectId: sweep },
        at(4 * minute),
      );
      await operators.abandonJob(
        sweepJob.id,
        operator,
        { requestId: randomUUID() },
        at(4 * minute),
      );
      expect(await itemState(other.item.id)).toBe("processing");

      // A worker's final failJob fails the item in the same transaction, so a
      // crash before its own markItemFailed leaves nothing processing; a
      // retryable failure with attempts left keeps the item processing.
      const failing = await processingItem(b, at(5 * minute));
      const failingLease = { id: failing.jobId, leaseOwner: "gone.1" };
      await lease(failing.jobId, 1, 2);
      expect(
        await adapter.failJob(
          failingLease,
          "media_tool_failed",
          at(5 * minute),
        ),
      ).toBe("retry_scheduled");
      expect(await itemState(failing.item.id)).toBe("processing");
      expect((await capacity(b)).reservedBytes).toBe(reserved);
      await lease(failing.jobId, 2, 2);
      expect(
        await adapter.failJob(
          failingLease,
          "media_tool_failed",
          at(6 * minute),
        ),
      ).toBe("failed");
      expect(await adapter.readItem(b, failing.item.id)).toMatchObject({
        state: "failed",
        failureCode: "processing_failed",
      });
      expect((await capacity(b)).reservedBytes).toBe(0);
      // The worker's follow-up and a lost lease change nothing.
      await adapter.markItemFailed(
        failing.item.id,
        "processing_failed",
        at(6 * minute),
      );
      expect(
        await adapter.failJob(
          failingLease,
          "media_tool_failed",
          at(7 * minute),
        ),
      ).toBe("lease_lost");
      expect(await jobsFor(failing.item.id)).toMatchObject([
        {
          kind: "process_item",
          state: "failed",
          last_error_code: "media_tool_failed",
        },
      ]);
      // A final failure of another kind leaves its subject item alone.
      const deriving = await processingItem(a, at(8 * minute));
      const derive = await adapter.enqueueJob(
        {
          kind: "derive_edit",
          subjectId: deriving.item.id,
          payload: {
            editKey: "0".repeat(32),
            edit: { rotation: 90, crop: null },
            coverCrop: null,
            variants: ["display"],
          },
        },
        at(8 * minute),
      );
      await lease(derive.id, 1, 1);
      expect(
        await adapter.failJob(
          { id: derive.id, leaseOwner: "gone.1" },
          "media_tool_failed",
          at(8 * minute),
          { retryable: false },
        ),
      ).toBe("failed");
      expect(await itemState(deriving.item.id)).toBe("processing");
    });

    it("keeps succeeded job rows for seven days and deletes them in bounded batches", async () => {
      const subjects = [0, 1, 2].map(() => `test-${hex()}`);
      jobSubjects.push(...subjects);
      const finished = new Date("2000-01-01T00:00:00.000Z");
      const ids: string[] = [];
      for (const [index, subject] of subjects.entries()) {
        const job = await adapter.enqueueJob(
          { kind: "sweep_staging", subjectId: subject },
          t0,
        );
        ids.push(job.id);
        await pool.query(
          "UPDATE community.publishing_jobs SET state='succeeded',finished_at=$2 WHERE id=$1",
          [job.id, new Date(finished.getTime() + index * second)],
        );
      }
      const kept = `test-${hex()}`;
      jobSubjects.push(kept);
      const failed = await adapter.enqueueJob(
        { kind: "sweep_staging", subjectId: kept },
        t0,
      );
      await pool.query(
        "UPDATE community.publishing_jobs SET state='failed',finished_at=$2 WHERE id=$1",
        [failed.id, finished],
      );
      const remaining = async () =>
        (
          await pool.query<{ id: string }>(
            "SELECT id FROM community.publishing_jobs WHERE id=ANY($1::text[]) ORDER BY id",
            [[...ids, failed.id]],
          )
        ).rows.map((row) => row.id);
      const sevenDays = 7 * day;
      await adapter.scheduleCleanup(
        new Date(finished.getTime() + sevenDays),
        1000,
      );
      expect(await remaining()).toEqual([...ids, failed.id].sort());
      await adapter.scheduleCleanup(
        new Date(finished.getTime() + 2 * second + sevenDays + 1),
        2,
      );
      expect(await remaining()).toEqual([ids[2]!, failed.id].sort());
      await adapter.scheduleCleanup(
        new Date(finished.getTime() + 2 * second + sevenDays + 1),
        2,
      );
      expect(await remaining()).toEqual([failed.id]);
    });

    it("schedules derive jobs for edits of legacy items and completes their readiness", async () => {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
      const mediaId = `user-media-${hex()}`;
      await pool.query(
        "INSERT INTO community.user_media(id,owner_id,mime_type,width,height,sha256,bytes) VALUES($1,$2,'image/png',40,30,$3,$4)",
        [mediaId, a, sha("legacy"), png],
      );
      const workId = `work-${hex()}`;
      await pool.query(
        "INSERT INTO community.works(id,author_id,title,text,media_ids,first_published_at) VALUES($1,$2,'旧作','',$3,'2026-01-01T00:00:00Z')",
        [workId, a, [mediaId]],
      );
      const { draft, created } = await adapter.openEditDraft(
        a,
        workId,
        { requestId: randomUUID(), deviceClass: "desktop" },
        t0,
      );
      expect(created).toBe(true);
      // A Phase 4 work opens without an authorship claim.
      expect(draft.content.authorship).toBeNull();
      const legacy = draft.content.items[0];
      if (legacy?.itemId == null) throw new Error("legacy item missing");
      expect(legacy.qualityMode).toBe("legacy");
      expect(await jobsFor(legacy.itemId)).toEqual([]);
      // An autosave with a rotation settles like any draft edit.
      const rotated = {
        ...draft.content,
        items: [{ ...legacy, edit: { rotation: 180 as const, crop: null } }],
      };
      expect(
        await adapter.saveDraft(
          a,
          draft.id,
          {
            baseRevision: draft.revision,
            content: rotated,
            deviceClass: "desktop",
          },
          at(second),
        ),
      ).toMatchObject({ status: "saved" });
      const key = (
        await pool.query<{ key: string }>(
          "SELECT community.media_edit_key($1::jsonb,NULL) AS key",
          [JSON.stringify({ rotation: 180, crop: null })],
        )
      ).rows[0]!.key;
      expect(await jobsFor(legacy.itemId)).toMatchObject([
        {
          kind: "derive_edit",
          state: "queued",
          run_after: at(second + 30 * second),
          payload: {
            editKey: key,
            coverCrop: null,
            variants: ["thumb", "display", "full", "cover"],
          },
        },
      ]);
      const readiness = await adapter.ensureEditDerivatives(
        a,
        { items: rotated.items, coverKey: legacy.key, coverCrop: null },
        at(2 * second),
      );
      expect(readiness).toEqual({
        ready: false,
        items: [
          {
            key: legacy.key,
            itemId: legacy.itemId,
            state: "deriving",
            editKey: null,
          },
        ],
      });
      const [job] = await jobsFor(legacy.itemId);
      expect(job?.run_after).toEqual(at(2 * second));
      expect(
        Buffer.from((await adapter.readLegacyMediaBytes(legacy.itemId)) ?? []),
      ).toEqual(png);
      expect(
        await adapter.recordDerivatives(
          legacy.itemId,
          {
            status: "derived",
            derivatives: derivativesOf(
              ["thumb", "display", "full", "cover"],
              key,
            ),
          },
          at(3 * second),
        ),
      ).toEqual({ status: "recorded" });
      expect(
        await adapter.ensureEditDerivatives(
          a,
          { items: rotated.items, coverKey: legacy.key, coverCrop: null },
          at(4 * second),
        ),
      ).toEqual({
        ready: true,
        items: [
          {
            key: legacy.key,
            itemId: legacy.itemId,
            state: "ready",
            editKey: key,
          },
        ],
      });
      // The unedited legacy form needs nothing derived (its thumb is the
      // user media PNG, reported as the base key).
      expect(
        await adapter.ensureEditDerivatives(
          a,
          { items: [legacy], coverKey: legacy.key, coverCrop: null },
          at(5 * second),
        ),
      ).toEqual({
        ready: true,
        items: [
          {
            key: legacy.key,
            itemId: legacy.itemId,
            state: "ready",
            editKey: "base",
          },
        ],
      });
      expect((await capacity(a)).committedBytes).toBe(4000);
    });

    it("checks readiness for a named holder like a registration and names the thumb edit key of ready edited items", async () => {
      const draft = await newDraft(a);
      const item = await adapter.registerItem(
        a,
        staticCommand({ draftId: draft.id }),
        t0,
      );
      await uploadAll(a, item);
      await adapter.markItemReady(item.id, processedOutcome(item), t0);
      const cropped: MediaCrop = { x: 0.1, y: 0.2, width: 0.5, height: 0.5 };
      const placeholder = entry(null);
      const content: WorkDraftContent = {
        ...text("就绪", [entry(item, { rotation: 90 }), placeholder]),
        coverKey: item.id,
        coverCrop: cropped,
      };
      const coverKey = sha(
        '[{"crop": null, "rotation": 90}, {"x": 0.1, "y": 0.2, "width": 0.5, "height": 0.5}]',
      ).slice(0, 32);
      const derives = async () =>
        (await jobsFor(item.id))
          .filter((job) => job.kind === "derive_edit")
          .map((job) => job.run_after);
      await adapter.saveDraft(
        a,
        draft.id,
        { baseRevision: 1, content, deviceClass: "phone" },
        at(minute),
      );
      expect(await derives()).toEqual([
        at(minute + 30 * second),
        at(minute + 30 * second),
      ]);

      // A foreign or unknown holder is unavailable and moves nothing.
      for (const holder of [
        { draftId: draft.id },
        { sessionId: `publishing-session-${hex()}` },
      ] as const)
        await expect(
          adapter.ensureEditDerivatives(b, content, at(minute + second), {
            holder,
          }),
        ).rejects.toMatchObject({ name: "CommunityNotFoundError" });
      await expect(
        adapter.ensureEditDerivatives(a, content, at(minute + second), {
          holder: { draftId: `work-draft-${hex()}` },
        }),
      ).rejects.toMatchObject({ name: "CommunityNotFoundError" });
      expect(await derives()).toEqual([
        at(minute + 30 * second),
        at(minute + 30 * second),
      ]);

      // The owner's check moves the settling jobs up to now.
      expect(
        await adapter.ensureEditDerivatives(
          a,
          content,
          at(minute + 2 * second),
          {
            holder: { draftId: draft.id },
          },
        ),
      ).toEqual({
        ready: false,
        items: [
          { key: item.id, itemId: item.id, state: "deriving", editKey: null },
          {
            key: placeholder.key,
            itemId: null,
            state: "pending",
            editKey: null,
          },
        ],
      });
      expect(await derives()).toEqual([
        at(minute + 2 * second),
        at(minute + 2 * second),
      ]);
      const claims = (
        await adapter.claimJobs(
          {
            owner: `worker-${hex()}`,
            limit: 100,
            leaseMs: minute,
            kinds: ["derive_edit"],
          },
          at(minute + 3 * second),
        )
      ).filter((claim) => claim.subjectId === item.id);
      expect(claims).toHaveLength(2);
      for (const claim of claims) {
        await adapter.recordDerivatives(
          item.id,
          {
            status: "derived",
            derivatives: derivativesOf(
              claim.payload?.variants ?? [],
              claim.payload?.editKey ?? "",
            ),
          },
          at(minute + 4 * second),
        );
        await adapter.completeJob(claim, at(minute + 4 * second));
      }

      // Ready: the cover item's thumb key includes its cover crop; an
      // unedited item reports the base key. A session holder answers alike.
      const readyContent: WorkDraftContent = {
        ...content,
        items: [content.items[0] as WorkDraftItem],
      };
      expect(
        await adapter.ensureEditDerivatives(a, readyContent, at(2 * minute), {
          holder: { draftId: draft.id },
        }),
      ).toEqual({
        ready: true,
        items: [
          { key: item.id, itemId: item.id, state: "ready", editKey: coverKey },
        ],
      });
      const session = await adapter.createSession(
        a,
        { requestId: randomUUID(), workId: null },
        at(2 * minute),
      );
      expect(
        await adapter.ensureEditDerivatives(
          a,
          { items: [entry(item)], coverKey: null, coverCrop: null },
          at(2 * minute),
          { holder: { sessionId: session.id } },
        ),
      ).toEqual({
        ready: true,
        items: [
          { key: item.id, itemId: item.id, state: "ready", editKey: "base" },
        ],
      });

      // A lapsed session is unavailable; an ended holder conflicts.
      await expect(
        adapter.ensureEditDerivatives(a, readyContent, at(day), {
          holder: { sessionId: session.id },
        }),
      ).rejects.toMatchObject({ name: "CommunityNotFoundError" });
      await adapter.discardSession(
        a,
        session.id,
        { requestId: randomUUID() },
        at(3 * minute),
      );
      await expect(
        adapter.ensureEditDerivatives(a, readyContent, at(3 * minute), {
          holder: { sessionId: session.id },
        }),
      ).rejects.toMatchObject({ name: "CommunityConflictError" });
      const submitted = await adapter.submit(
        a,
        {
          requestId: randomUUID(),
          holder: { draftId: draft.id },
          content: readyContent,
          baseRevisionId: null,
        },
        at(3 * minute),
      );
      expect(submitted.state).toBe("confirmed");
      await expect(
        adapter.ensureEditDerivatives(a, readyContent, at(3 * minute), {
          holder: { draftId: draft.id },
        }),
      ).rejects.toMatchObject({ name: "CommunityConflictError" });
      // Without a holder (a submission retry) the same content is just checked.
      expect(
        (await adapter.ensureEditDerivatives(a, readyContent, at(3 * minute)))
          .ready,
      ).toBe(true);
    });
  });
};
