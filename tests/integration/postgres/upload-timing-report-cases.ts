import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { currentRecipe } from "@moya/backend-production/internal/publishing-processing";
import { PostgresWorkPublishingAdapter } from "@moya/community-postgres";
import { afterEach, describe, expect, it } from "vitest";

import { requireSyntheticTestDatabaseUrl } from "./synthetic-test-database.js";

import type {
  PublishingMediaWriteResult,
  PublishingProcessedOutcome,
  PublishingRenditionRole,
  PublishingUploadTiming,
} from "@moya/api";
import type { createPostgresPool } from "@moya/catalog-postgres";
import type { PublishingMediaItem } from "@moya/contracts";

/**
 * The Owner-run upload timing report (infra/production/sql) against a
 * synthetic fixture built through the real adapter: hand-computed phases,
 * a read-only transaction and content-free output. Registered from
 * community-postgres.test.ts, which applies the community migrations first.
 */

const root = fileURLToPath(new URL("../../../", import.meta.url));
const MiB = 1024 * 1024;
// A window no other case uses, so the every-account mode sees only this fixture.
const t0 = new Date("2031-03-03T10:00:00.000Z");
const at = (seconds: number): Date => new Date(t0.getTime() + seconds * 1000);
const hex = (): string => randomUUID().replaceAll("-", "");

const blobOf = (byteSize: number): PublishingMediaWriteResult => {
  const key = hex();
  return {
    storageKey: `blobs/${key.slice(0, 2)}/${key.slice(2, 4)}/${key}`,
    byteSize,
    sha256: createHash("sha256").update(key).digest("hex"),
  };
};

const derivatives = (
  variants: readonly PublishingRenditionRole[],
): PublishingProcessedOutcome["derivatives"] =>
  variants.map((variant) => ({
    ...blobOf(1000),
    variant,
    editKey: "base",
    contentType:
      variant === "motion" ? ("video/mp4" as const) : ("image/webp" as const),
    width: 480,
    height: 360,
    durationMs: variant === "motion" ? 3000 : null,
    recipeVersion: currentRecipe(variant).version,
    recipeDigest: currentRecipe(variant).digest,
  }));

const processed = (): PublishingProcessedOutcome => ({
  status: "processed",
  detectedTypes: [{ role: "still", contentType: "image/jpeg" }],
  presentation: { width: 4000, height: 3000 },
  pairing: null,
  stillExifOrientation: 1,
  derivatives: derivatives(["thumb", "display", "cover"]),
  placeholderColor: null,
});

const pairSha = createHash("sha256").update("pair").digest("hex");

/** A Live item renders every role, `full` included, in its process job. */
const processedLive = (): PublishingProcessedOutcome => ({
  status: "processed",
  detectedTypes: [
    { role: "still", contentType: "image/jpeg" },
    { role: "motion", contentType: "video/mp4" },
  ],
  presentation: {
    width: 1440,
    height: 1920,
    durationMs: 3000,
    hasAudio: true,
    displayRotation: 90,
  },
  pairing: {
    method: "apple-content-identifier",
    verifiedBy: "server",
    identifierSha256: pairSha,
    stillTimeMs: 1500,
  },
  stillExifOrientation: 6,
  derivatives: derivatives(["thumb", "display", "full", "motion", "cover"]),
  placeholderColor: null,
});

/** Binds the report's psql variables as literals (the test runs it through pg). */
const bind = (sql: string, values: Record<string, string>): string =>
  sql.replaceAll(/:'([a-z_]+)'/gu, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`unbound ${name}`);
    return `'${value.replaceAll("'", "''")}'`;
  });

const SHARED_START = "WITH params AS (";
const SHARED_END = "-- END OF SHARED TIMING CTE";
const sharedCte = (sql: string): string =>
  sql.slice(sql.indexOf(SHARED_START), sql.indexOf(SHARED_END));

export const registerUploadTimingReportTests = (
  pool: ReturnType<typeof createPostgresPool>,
) => {
  requireSyntheticTestDatabaseUrl();

  describe("upload timing report on real PostgreSQL", () => {
    const adapter = new PostgresWorkPublishingAdapter(pool);
    const users: string[] = [];

    const createUser = async (): Promise<string> => {
      const id = `user-${hex()}`;
      await pool.query(
        "INSERT INTO community.public_users(id,handle,display_name) VALUES($1,$2,'计时测试')",
        [id, `ut-${id.slice(-24)}`],
      );
      users.push(id);
      return id;
    };

    afterEach(async () => {
      const owners = users.splice(0);
      await pool.query(
        `DELETE FROM community.publishing_jobs WHERE subject_id IN (
           SELECT id FROM community.media_items WHERE owner_id=ANY($1::text[])
           UNION SELECT id FROM community.media_blobs WHERE owner_id=ANY($1::text[]))`,
        [owners],
      );
      for (const statement of [
        "DELETE FROM community.media_item_refs WHERE item_id IN (SELECT id FROM community.media_items WHERE owner_id=ANY($1::text[]))",
        "DELETE FROM community.work_draft_snapshots WHERE owner_id=ANY($1::text[])",
        "DELETE FROM community.work_drafts WHERE owner_id=ANY($1::text[])",
        "DELETE FROM community.media_renditions WHERE item_id IN (SELECT id FROM community.media_items WHERE owner_id=ANY($1::text[]))",
        "DELETE FROM community.media_components WHERE owner_id=ANY($1::text[])",
        "DELETE FROM community.media_blobs WHERE owner_id=ANY($1::text[])",
        "DELETE FROM community.media_items WHERE owner_id=ANY($1::text[])",
        "DELETE FROM community.account_publishing_capacity WHERE account_id=ANY($1::text[])",
        "DELETE FROM community.author_command_receipts WHERE actor_id=ANY($1::text[])",
        "DELETE FROM community.author_events WHERE actor_id=ANY($1::text[])",
        "DELETE FROM community.public_users WHERE id=ANY($1::text[])",
      ])
        await pool.query(statement, [owners]);
    });

    const register = async (
      actor: string,
      draftId: string,
      bytes: number,
      now: Date,
    ) =>
      adapter.registerItem(
        actor,
        {
          requestId: randomUUID(),
          holder: { draftId },
          kind: "static",
          qualityMode: "standard",
          processingProfile: "standard-image-v1",
          components: [
            {
              role: "still",
              byteSize: bytes,
              contentType: "image/jpeg",
              standardOutcome: "optimized",
            },
          ],
        },
        now,
      );

    const upload = async (
      actor: string,
      item: PublishingMediaItem,
      startAt: Date,
      commitAt: Date,
      timing: PublishingUploadTiming | undefined,
    ) => {
      const component = item.components[0]!;
      const fence = await adapter.beginComponentUpload(
        actor,
        component.id,
        {
          attempt: randomUUID(),
          contentLength: component.byteSize,
          supersede: false,
        },
        startAt,
      );
      return adapter.commitComponentUpload(
        fence,
        blobOf(component.byteSize),
        commitAt,
        timing,
      );
    };

    /** Test-only: the worker's claim and completion, at fixed times. */
    const runJob = async (
      itemId: string,
      kind: "process_item" | "derive_edit",
      startedAt: Date,
      finishedAt: Date,
    ) => {
      const updated = await pool.query(
        `UPDATE community.publishing_jobs SET state='succeeded', attempts=1,
           started_at=$3::timestamptz, finished_at=$4::timestamptz, updated_at=$4::timestamptz
         WHERE subject_id=$1 AND kind=$2 AND state='queued'`,
        [itemId, kind, startedAt.toISOString(), finishedAt.toISOString()],
      );
      expect(updated.rowCount).toBe(1);
    };

    const report = async (
      file: "upload-timing.sql" | "upload-timing-summary.sql",
      userId: string,
    ) => {
      const sql = await readFile(`${root}infra/production/sql/${file}`, "utf8");
      const client = await pool.connect();
      try {
        await client.query("BEGIN READ ONLY");
        const result = await client.query(
          bind(sql, {
            window_start: "2031-03-03 09:59:00+00",
            window_end: "2031-03-03 11:00:00+00",
            user_id: userId,
          }),
        );
        await client.query("ROLLBACK");
        return result.rows as Record<string, unknown>[];
      } finally {
        client.release();
      }
    };

    const num = (value: unknown): number | null =>
      value === null ? null : Number(value);

    it("turns recorded timestamps into per-phase seconds without ids", async () => {
      const a = await createUser();
      const b = await createUser();
      const draft = await adapter.createDraft(
        a,
        {
          requestId: randomUUID(),
          content: {
            title: "",
            body: "计时",
            authorship: { kind: "original" },
            visibility: "public",
            items: [],
            coverKey: null,
            coverCrop: null,
          },
          deviceClass: "phone",
        },
        t0,
      );
      const first = await register(a, draft.id, 2 * MiB, t0);
      const second = await register(a, draft.id, MiB, at(1.5));
      // The first photo is interrupted once, then resent.
      const interrupted = await adapter.beginComponentUpload(
        a,
        first.components[0]!.id,
        {
          attempt: randomUUID(),
          contentLength: 2 * MiB,
          supersede: false,
        },
        at(2),
      );
      await adapter.abortComponentUpload(interrupted, at(3));
      expect(
        await upload(a, first, at(4), at(10), {
          firstByteAt: at(4.2),
          lastByteAt: at(9),
        }),
      ).toMatchObject({ status: "committed" });
      expect(
        await upload(a, second, at(5), at(12), {
          firstByteAt: at(5.1),
          lastByteAt: at(11.5),
        }),
      ).toMatchObject({ status: "committed" });
      // Its answer was lost: the resend after the commit is refused and noted.
      expect(
        await adapter.noteUploadRefusedAfterCommit(
          a,
          first.components[0]!.id,
          at(14),
        ),
      ).toEqual(at(10));
      await runJob(first.id, "process_item", at(12.5), at(15));
      await adapter.markItemReady(first.id, processed(), at(15));
      await runJob(second.id, "process_item", at(15), at(17));
      await adapter.markItemReady(second.id, processed(), at(17));
      for (const [item, recordedAt, startedAt, finishedAt] of [
        [first, at(59.9), at(45), at(60)],
        [second, at(69.9), at(60), at(70)],
      ] as const) {
        expect(
          await adapter.recordDerivatives(
            item.id,
            { status: "derived", derivatives: derivatives(["viewer", "full"]) },
            recordedAt,
          ),
        ).toEqual({ status: "recorded" });
        await runJob(item.id, "derive_edit", startedAt, finishedAt);
      }
      // Another account's upload from before the instrumentation: no times.
      const draftB = await adapter.createDraft(
        b,
        {
          requestId: randomUUID(),
          content: {
            title: "",
            body: "旧",
            authorship: { kind: "original" },
            visibility: "public",
            items: [],
            coverKey: null,
            coverCrop: null,
          },
          deviceClass: "phone",
        },
        at(100),
      );
      const other = await register(b, draftB.id, MiB, at(100));
      await upload(b, other, at(101), at(103), undefined);
      // A Live photo in a later batch of the first account.
      const liveDraft = await adapter.createDraft(
        a,
        {
          requestId: randomUUID(),
          content: {
            title: "",
            body: "实况",
            authorship: { kind: "original" },
            visibility: "public",
            items: [],
            coverKey: null,
            coverCrop: null,
          },
          deviceClass: "phone",
        },
        at(200),
      );
      const live = await adapter.registerItem(
        a,
        {
          requestId: randomUUID(),
          holder: { draftId: liveDraft.id },
          kind: "live",
          qualityMode: "standard",
          processingProfile: "standard-live-v1",
          components: [
            {
              role: "still",
              byteSize: MiB,
              contentType: "image/jpeg",
              standardOutcome: "optimized",
            },
            {
              role: "motion",
              byteSize: 2 * MiB,
              contentType: "video/mp4",
              standardOutcome: "optimized",
            },
          ],
          clientPairing: {
            method: "apple-content-identifier",
            identifierSha256: pairSha,
            stillTimeMs: 1500,
          },
        },
        at(200),
      );
      for (const [component, startAt, commitAt, firstByte, lastByte] of [
        [live.components[0]!, 201, 205, 201.1, 204],
        [live.components[1]!, 201.5, 208, 201.6, 207],
      ] as const) {
        const fence = await adapter.beginComponentUpload(
          a,
          component.id,
          {
            attempt: randomUUID(),
            contentLength: component.byteSize,
            supersede: false,
          },
          at(startAt),
        );
        await adapter.commitComponentUpload(
          fence,
          blobOf(component.byteSize),
          at(commitAt),
          { firstByteAt: at(firstByte), lastByteAt: at(lastByte) },
        );
      }
      await runJob(live.id, "process_item", at(209), at(230));
      await adapter.markItemReady(live.id, processedLive(), at(230));

      const rows = await report("upload-timing.sql", a);
      expect(rows).toHaveLength(4);
      const [one, two, liveStill, liveMotion] = rows;
      expect(one).toMatchObject({
        batch_no: "1",
        item_no: "1",
        component: "still",
        live: false,
        quality_mode: "standard",
        batch_start_minute_utc: "2031-03-03T10:00Z",
        upload_attempts: 2,
        refusals_after_commit: 1,
        process_attempts: 1,
        hd_attempts: 1,
        batch_items: "2",
        declared_mib: "2.0",
        received_mib: "2.0",
        batch_mib: "3.0",
      });
      // Sizes only as rounded MiB: no exact byte count leaves the report.
      for (const row of rows)
        for (const key of Object.keys(row)) expect(key).not.toMatch(/bytes/u);
      const seconds = (row: Record<string, unknown>, keys: string[]) =>
        Object.fromEntries(keys.map((key) => [key, num(row[key])]));
      expect(
        seconds(one!, [
          "registered_s",
          "first_start_s",
          "first_byte_s",
          "last_byte_s",
          "committed_s",
          "first_refusal_after_commit_s",
          "process_queued_s",
          "process_started_s",
          "process_finished_s",
          "ready_s",
          "hd_queued_s",
          "hd_started_s",
          "hd_finished_s",
          "full_s",
          "wait_before_transfer_s",
          "start_to_final_first_byte_s",
          "transfer_s",
          "store_commit_s",
          "transfer_mbps",
          "commit_to_refused_resend_s",
          "process_wait_s",
          "process_run_s",
          "commit_to_ready_s",
          "hd_wait_s",
          "hd_run_s",
          "ready_to_hd_s",
          "batch_first_byte_s",
          "batch_last_byte_s",
          "batch_last_commit_s",
          "batch_publish_ready_s",
          "batch_last_hd_s",
          "batch_transfer_mbps",
        ]),
      ).toEqual({
        registered_s: 0,
        first_start_s: 2,
        first_byte_s: 4.2,
        last_byte_s: 9,
        committed_s: 10,
        first_refusal_after_commit_s: 14,
        process_queued_s: 10,
        process_started_s: 12.5,
        process_finished_s: 15,
        ready_s: 15,
        hd_queued_s: 15,
        hd_started_s: 45,
        hd_finished_s: 60,
        full_s: 59.9,
        wait_before_transfer_s: 2,
        start_to_final_first_byte_s: 2.2,
        transfer_s: 4.8,
        store_commit_s: 1,
        // 8 × 2 MiB / 4.8 s
        transfer_mbps: 3.5,
        commit_to_refused_resend_s: 4,
        process_wait_s: 2.5,
        process_run_s: 2.5,
        commit_to_ready_s: 5,
        hd_wait_s: 30,
        hd_run_s: 15,
        ready_to_hd_s: 44.9,
        batch_first_byte_s: 4.2,
        batch_last_byte_s: 11.5,
        batch_last_commit_s: 12,
        batch_publish_ready_s: 17,
        batch_last_hd_s: 70,
        // 8 × 3 MiB / 7.3 s
        batch_transfer_mbps: 3.45,
      });
      expect(
        seconds(two!, [
          "registered_s",
          "wait_before_transfer_s",
          "transfer_s",
          "process_wait_s",
          "commit_to_ready_s",
        ]),
      ).toEqual({
        registered_s: 1.5,
        wait_before_transfer_s: 3.5,
        transfer_s: 6.4,
        process_wait_s: 3,
        commit_to_ready_s: 5,
      });
      expect(two).toMatchObject({
        upload_attempts: 1,
        refusals_after_commit: 0,
      });
      // Live: full comes with the previews, so there is no HD job and no
      // background HD lag to report.
      expect(liveStill).toMatchObject({
        batch_no: "2",
        component: "still",
        live: true,
        hd_queued_s: null,
        hd_wait_s: null,
        ready_to_hd_s: null,
        batch_items: "1",
        batch_mib: "3.0",
      });
      expect(liveMotion).toMatchObject({ batch_no: "2", component: "motion" });
      expect(
        seconds(liveStill!, [
          "ready_s",
          "full_s",
          "process_wait_s",
          "process_run_s",
          "commit_to_ready_s",
          "transfer_s",
          "batch_publish_ready_s",
        ]),
      ).toEqual({
        ready_s: 30,
        full_s: 30,
        process_wait_s: 1,
        process_run_s: 21,
        commit_to_ready_s: 22,
        transfer_s: 2.9,
        batch_publish_ready_s: 30,
      });

      // Every account: the old upload is a second batch whose added times
      // stay NULL (never estimated).
      const everyone = await report("upload-timing.sql", "");
      expect(everyone).toHaveLength(5);
      expect(everyone[2]).toMatchObject({
        batch_no: "2",
        upload_attempts: 1,
        first_byte_s: null,
        transfer_s: null,
        transfer_mbps: null,
        batch_transfer_mbps: null,
      });

      const summary = await report("upload-timing-summary.sql", a);
      const phase = (level: string, name: string) =>
        summary.find((row) => row.level === level && row.phase === name);
      // Transfers 4.8, 6.4, 2.9 and 5.4 s.
      expect(phase("component", "transfer_s")).toMatchObject({ n: "4" });
      expect(num(phase("component", "transfer_s")?.p50)).toBe(5.1);
      expect(num(phase("component", "transfer_s")?.max)).toBe(6.4);
      expect(num(phase("component", "resent_share")?.mean)).toBe(0.25);
      expect(num(phase("component", "refused_after_commit_share")?.mean)).toBe(
        0.25,
      );
      // Static items and Live items are summarised apart.
      expect(num(phase("item", "process_wait_s")?.p50)).toBe(2.75);
      expect(num(phase("item", "hd_run_s")?.max)).toBe(15);
      expect(phase("item", "ready_to_hd_s")).toMatchObject({ n: "2" });
      expect(num(phase("item", "ready_to_hd_s")?.max)).toBe(52.9);
      expect(phase("item_live", "process_run_s")).toMatchObject({ n: "1" });
      expect(num(phase("item_live", "process_run_s")?.max)).toBe(21);
      expect(phase("item_live", "ready_to_hd_s")).toMatchObject({ n: "0" });
      expect(num(phase("batch", "batch_publish_ready_s")?.p50)).toBe(23.5);
      expect(phase("batch", "batch_items")).toMatchObject({ n: "2" });

      // Content-free output: no ids, keys, hashes or names of any kind.
      for (const value of [...rows, ...everyone, ...summary].flatMap((row) =>
        Object.values(row),
      ))
        expect(String(value)).not.toMatch(
          /media-|user-|work-|blobs\/|计时|[0-9a-f]{32}/u,
        );
    });

    it("keeps one shared timing CTE in both report files", async () => {
      const [rows, summary] = await Promise.all(
        ["upload-timing.sql", "upload-timing-summary.sql"].map((file) =>
          readFile(`${root}infra/production/sql/${file}`, "utf8"),
        ),
      );
      expect(sharedCte(rows!).length).toBeGreaterThan(1000);
      expect(sharedCte(summary!)).toBe(sharedCte(rows!));
      // Read-only by construction: no statement writes or locks.
      for (const sql of [rows!, summary!])
        expect(sql.replaceAll(/--.*$/gmu, "")).not.toMatch(
          /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|GRANT|COPY|FOR UPDATE|FOR SHARE)\b/iu,
        );
    });
  });
};
