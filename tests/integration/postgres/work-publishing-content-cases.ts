import { randomUUID } from "node:crypto";
import {
  AuthorCommunityService,
  CommunityConflictError,
  CommunityInputError,
  CommunityNotFoundError,
} from "@moya/api";
import type { CatalogPublicationPort } from "@moya/api";
import {
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import {
  PostgresAuthorCommunityAdapter,
  PostgresCommunityCommentAdapter,
  PostgresCommunityContentOperatorAdapter,
  PostgresCommunityDiscoveryAdapter,
  PostgresPublishingOperatorAdapter,
  PostgresWorkPublishingAdapter,
} from "@moya/community-postgres";
import {
  contentCardSchema,
  discoveryQuerySchema,
  workSubmissionCommandSchema,
} from "@moya/contracts/schemas";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import type {
  AuthorListQuery,
  MediaCrop,
  MediaEdit,
  PublishingHolder,
  WorkSubmissionCommand,
  WorkSubmissionContent,
  WorkSubmissionReceipt,
  WorkSubmissionResult,
} from "@moya/contracts";

import { requireSyntheticTestDatabaseUrl } from "./synthetic-test-database.js";

import { cleanupNotificationData } from "./notification-fixture-cleanup.js";

type Pool = ReturnType<typeof createPostgresPool>;
type ErrorClass = abstract new (...args: never[]) => Error;

const id = (prefix: string) => `${prefix}-${randomUUID().replaceAll("-", "")}`;
const hex = () => randomUUID().replaceAll("-", "");
const identity: MediaEdit = { rotation: 0, crop: null };
const at = (iso: string) => new Date(iso);

/**
 * FK-ordered removal of every work publishing row owned by the given accounts
 * (jobs, refs, revisions, sessions, drafts, snapshots, derivatives, blobs,
 * items, counters, capacity) so a suite can delete works and public users
 * afterwards. Safe to call when nothing exists.
 */
export const cleanupPublishingData = async (
  pool: Pool,
  users: readonly string[],
): Promise<void> => {
  await cleanupNotificationData(pool, users);
  const ids = [...users];
  const run = (sql: string) => pool.query(sql, [ids]);
  await run(
    `DELETE FROM community.publishing_jobs WHERE subject_id IN (
      SELECT id FROM community.media_items WHERE owner_id=ANY($1::text[])
      UNION SELECT id FROM community.media_blobs WHERE owner_id=ANY($1::text[])
      UNION SELECT id FROM community.publishing_sessions WHERE owner_id=ANY($1::text[])
      UNION SELECT id FROM community.works WHERE author_id=ANY($1::text[])
      UNION SELECT unnest($1::text[]))`,
  );
  await run(
    "DELETE FROM community.featured_content WHERE content_type='work' AND content_id IN (SELECT id FROM community.works WHERE author_id=ANY($1::text[]))",
  );
  await run(
    "DELETE FROM community.media_item_refs r USING community.media_items i WHERE r.item_id=i.id AND i.owner_id=ANY($1::text[])",
  );
  await run(
    "UPDATE community.works SET public_revision_id=NULL,author_revision_id=NULL WHERE author_id=ANY($1::text[])",
  );
  await run(
    "DELETE FROM community.work_revision_items ri USING community.work_revisions r WHERE ri.revision_id=r.id AND r.author_id=ANY($1::text[])",
  );
  await run(
    "DELETE FROM community.publishing_sessions WHERE owner_id=ANY($1::text[])",
  );
  await run(
    "DELETE FROM community.work_draft_snapshots WHERE owner_id=ANY($1::text[])",
  );
  await run(
    "UPDATE community.work_drafts SET conflict_of=NULL WHERE owner_id=ANY($1::text[])",
  );
  await run("DELETE FROM community.work_drafts WHERE owner_id=ANY($1::text[])");
  await run(
    "DELETE FROM community.work_revisions WHERE author_id=ANY($1::text[])",
  );
  await run(
    "DELETE FROM community.media_derivatives d USING community.media_items i WHERE d.item_id=i.id AND i.owner_id=ANY($1::text[])",
  );
  await run(
    "DELETE FROM community.media_components WHERE owner_id=ANY($1::text[])",
  );
  await run("DELETE FROM community.media_blobs WHERE owner_id=ANY($1::text[])");
  await run("DELETE FROM community.media_items WHERE owner_id=ANY($1::text[])");
  await run(
    "DELETE FROM community.daily_new_work_submissions WHERE account_id=ANY($1::text[])",
  );
  await run(
    "DELETE FROM community.account_publishing_capacity WHERE account_id=ANY($1::text[])",
  );
};

/** Back to the defaults the storage migration establishes. */
const resetSettings = (pool: Pool) =>
  pool.query(
    `UPDATE community.work_publishing_settings SET publication_policy='DIRECT_PUBLICATION',max_items_per_work=50,
      original_item_max_bytes=134217728,standard_component_max_bytes=268435456,
      ordinary_account_capacity_bytes=10737418240,owner_account_capacity_bytes=21474836480,max_active_drafts=100,
      daily_new_work_limit=100,history_limit=20,trash_retention_days=30,orphan_grace_days=7,
      unsaved_session_lease_minutes=360,version=1,updated_by='platform'
    WHERE id='settings'`,
  );

const expectRejection = async (
  promise: Promise<unknown>,
  type: ErrorClass,
  message?: string,
): Promise<void> => {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(type);
  if (message !== undefined) expect((error as Error).message).toBe(message);
};

const confirmed = (result: WorkSubmissionResult): WorkSubmissionReceipt => {
  if (result.state !== "confirmed")
    throw new Error(`expected a confirmed submission, got ${result.state}`);
  return result;
};

const listQuery: AuthorListQuery = {
  page: 1,
  pageSize: 20,
  search: "",
  kind: "all",
};
const allPublic = {
  following: "public",
  followers: "public",
  favorites: "public",
  likes: "public",
} as const;

/**
 * Real PostgreSQL cases for work publishing submissions, works, the recycle
 * bin, media read authorization and operator commands
 * (PostgresWorkPublishingAdapter, PostgresPublishingOperatorAdapter), and the
 * effective visibility they impose on the Phase 4 author, discovery and
 * discussion adapters. Registered from community-postgres.test.ts, which
 * guards TEST_DATABASE_URL first. Media fixtures are the rows processing
 * records (ready items with committed derivative blob rows); no bytes exist.
 */
export const registerWorkPublishingContentTests = (pool: Pool) => {
  describe("work publishing submissions, works and operator commands on real PostgreSQL", () => {
    const schema = `wp_content_${hex()}`;
    const reads = createPostgresPool(
      parsePostgresConfig({ DATABASE_URL: requireSyntheticTestDatabaseUrl() }),
    );
    reads.options.options = `-c search_path=${schema},public`;
    const adapter = new PostgresWorkPublishingAdapter(pool);
    const legacyTrashFixture = async (
      actor: string,
      workId: string,
      _command: { requestId: string },
      now: Date,
    ) => {
      await pool.query(
        "UPDATE community.works SET trashed_at=$3::timestamptz,trash_purge_after=$3::timestamptz+interval '30 days' WHERE id=$1 AND author_id=$2",
        [workId, actor, now.toISOString()],
      );
    };
    const operators = new PostgresPublishingOperatorAdapter(pool);
    const authors = new PostgresAuthorCommunityAdapter(reads);
    const comments = new PostgresCommunityCommentAdapter(pool);
    const discovery = new PostgresCommunityDiscoveryAdapter(reads);
    const contentOperator = new PostgresCommunityContentOperatorAdapter(reads);
    const users: string[] = [];
    let a: string, b: string, operator: string;

    beforeAll(async () => {
      await pool.query(`CREATE SCHEMA ${schema}`);
      await pool.query(
        `CREATE TABLE ${schema}.catalog_entries(catalog_id text PRIMARY KEY,province text,province_state text);CREATE TABLE ${schema}.catalog_discovery(catalog_id text PRIMARY KEY,kind text,title text,aliases varchar[],first_published_at timestamptz,filter_metadata jsonb);CREATE TABLE ${schema}.catalog_media(catalog_id text,media_id text,object_key text,width integer,height integer,is_representative boolean)`,
      );
    });
    afterAll(async () => {
      await reads.end();
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    });

    const user = async (label: string): Promise<string> => {
      const created = id("user");
      await pool.query(
        "INSERT INTO community.public_users(id,handle,display_name) VALUES($1,$2,$3)",
        [created, `wp-${created.slice(-24)}`, label],
      );
      users.push(created);
      return created;
    };

    beforeEach(async () => {
      users.length = 0;
      a = await user("发布作者");
      b = await user("访客");
      operator = `wp-op-${hex().slice(0, 12)}`;
      await resetSettings(pool);
    });

    afterEach(async () => {
      const run = (sql: string, values: unknown[]) => pool.query(sql, values);
      await run(
        "DELETE FROM community.discovery_sequences WHERE viewer_id=ANY($1::text[])",
        [users],
      );
      await run(
        "DELETE FROM community.content_operator_receipts WHERE operator_label=$1",
        [operator],
      );
      await run(
        "DELETE FROM community.content_operator_events WHERE operator_label=$1",
        [operator],
      );
      await run(
        "DELETE FROM community.comment_likes WHERE user_id=ANY($1::text[])",
        [users],
      );
      await run(
        "DELETE FROM community.catalog_comment_replies WHERE author_id=ANY($1::text[])",
        [users],
      );
      await run(
        "DELETE FROM community.catalog_comments WHERE author_id=ANY($1::text[])",
        [users],
      );
      await run(
        "DELETE FROM community.author_command_receipts WHERE actor_id=ANY($1::text[])",
        [users],
      );
      await run(
        "DELETE FROM community.author_events WHERE actor_id=ANY($1::text[])",
        [users],
      );
      await run(
        "DELETE FROM community.content_relations WHERE user_id=ANY($1::text[])",
        [users],
      );
      await run(
        "DELETE FROM community.blocks WHERE blocker_id=ANY($1::text[]) OR blocked_id=ANY($1::text[])",
        [users],
      );
      await cleanupPublishingData(pool, users);
      await run("DELETE FROM community.works WHERE author_id=ANY($1::text[])", [
        users,
      ]);
      await run(
        "UPDATE community.public_users SET avatar_media_id=NULL,background_media_id=NULL WHERE id=ANY($1::text[])",
        [users],
      );
      await run(
        "DELETE FROM community.user_media WHERE owner_id=ANY($1::text[])",
        [users],
      );
      await run("DELETE FROM community.public_users WHERE id=ANY($1::text[])", [
        users,
      ]);
      await resetSettings(pool);
    });

    const blob = async (
      owner: string,
      purpose: "standard_master" | "derivative",
      contentType: string,
    ) => {
      const digest = hex();
      const blobId = id("media-blob");
      const storageKey = `blobs/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}`;
      await pool.query(
        "INSERT INTO community.media_blobs(id,owner_id,purpose,storage_key,byte_size,sha256,content_type) VALUES($1,$2,$3,$4,1024,$5,$6)",
        [blobId, owner, purpose, storageKey, digest + digest, contentType],
      );
      return { blobId, storageKey };
    };

    /** Records the derivatives one edit needs, as a finished derive job would; returns their keys. */
    const derive = async (
      itemId: string,
      owner: string,
      kind: "static" | "live",
      edit: MediaEdit,
      isCover = false,
      coverCrop: MediaCrop | null = null,
    ): Promise<Record<string, string>> => {
      const required = (
        await pool.query<{ variant: string; edit_key: string }>(
          "SELECT variant,edit_key FROM community.media_required_derivatives($1,$2::jsonb,$3,$4::jsonb)",
          [
            kind,
            JSON.stringify(edit),
            isCover,
            coverCrop === null ? null : JSON.stringify(coverCrop),
          ],
        )
      ).rows;
      const keys: Record<string, string> = {};
      for (const row of required) {
        keys[row.variant] = row.edit_key;
        const existing = await pool.query(
          "SELECT 1 FROM community.media_derivatives WHERE item_id=$1 AND variant=$2 AND edit_key=$3",
          [itemId, row.variant, row.edit_key],
        );
        if (existing.rowCount !== 0) continue;
        const contentType =
          row.variant === "motion" ? "video/mp4" : "image/webp";
        const stored = await blob(owner, "derivative", contentType);
        await pool.query(
          "INSERT INTO community.media_derivatives(item_id,variant,edit_key,blob_id,width,height,content_type) VALUES($1,$2,$3,$4,640,480,$5)",
          [itemId, row.variant, row.edit_key, stored.blobId, contentType],
        );
      }
      return keys;
    };

    /** An uploaded item as processing leaves it (every base derivative when ready). */
    const mediaItem = async (
      owner: string,
      options: {
        readonly kind?: "static" | "live";
        readonly state?: "ready" | "processing";
      } = {},
    ) => {
      const kind = options.kind ?? "static";
      const state = options.state ?? "ready";
      const itemId = id("media-item");
      await pool.query(
        `INSERT INTO community.media_items(id,owner_id,kind,quality_mode,source,state,declared_total_bytes,received_total_bytes,presentation,processing_profile)
        VALUES($1,$2,$3,'standard','upload',$4,2048,2048,$5::jsonb,$6)`,
        [
          itemId,
          owner,
          kind,
          state,
          JSON.stringify(
            kind === "live"
              ? { width: 640, height: 480, durationMs: 1500, hasAudio: true }
              : { width: 640, height: 480, displayRotation: 0 },
          ),
          kind === "live" ? "standard-live-v1" : "standard-image-v1",
        ],
      );
      const master = await blob(owner, "standard_master", "image/jpeg");
      const roles: [string, string, string][] = [
        ["still", "image/jpeg", master.blobId],
      ];
      if (kind === "live")
        roles.push([
          "motion",
          "video/mp4",
          (await blob(owner, "standard_master", "video/mp4")).blobId,
        ]);
      for (const [role, type, blobId] of roles)
        await pool.query(
          "INSERT INTO community.media_components(id,item_id,owner_id,role,declared_bytes,declared_type,state,received_bytes,sha256,blob_id) VALUES($1,$2,$3,$4,1024,$5,$6,1024,$7,$8)",
          [
            id("media-component"),
            itemId,
            owner,
            role,
            type,
            state === "ready" ? "verified" : "received",
            "a".repeat(64),
            blobId,
          ],
        );
      if (state === "ready") await derive(itemId, owner, kind, identity, true);
      return { itemId, masterKey: master.storageKey };
    };

    const holdSession = async (
      owner: string,
      workId: string | null = null,
      itemIds: readonly string[] = [],
    ): Promise<string> => {
      const sessionId = id("publishing-session");
      await pool.query(
        "INSERT INTO community.publishing_sessions(id,owner_id,save_mode,work_id,state,lease_expires_at) VALUES($1,$2,'unsaved',$3,'active','2100-01-01T00:00:00Z')",
        [sessionId, owner, workId],
      );
      for (const itemId of itemIds)
        await pool.query(
          "INSERT INTO community.media_item_refs(item_id,holder_kind,holder_id) VALUES($1,'session',$2)",
          [itemId, sessionId],
        );
      return sessionId;
    };

    const contentOf = (
      over: Partial<WorkSubmissionContent> = {},
    ): WorkSubmissionContent => ({
      title: "",
      body: "",
      authorship: { kind: "original" },
      visibility: "public",
      items: [],
      coverKey: null,
      coverCrop: null,
      ...over,
    });

    const holdDraft = async (
      owner: string,
      workId: string | null,
      baseRevisionId: string | null,
      itemIds: readonly string[] = [],
    ): Promise<string> => {
      const draftId = id("work-draft");
      await pool.query(
        `INSERT INTO community.work_drafts(id,owner_id,work_id,base_revision_id,state,revision,content,content_sha256)
        VALUES($1,$2,$3,$4,'active',3,$5::jsonb,encode(sha256(convert_to($5::jsonb::text,'UTF8')),'hex'))`,
        [
          draftId,
          owner,
          workId,
          baseRevisionId,
          JSON.stringify(contentOf({ title: "草稿" })),
        ],
      );
      for (const itemId of itemIds)
        await pool.query(
          "INSERT INTO community.media_item_refs(item_id,holder_kind,holder_id) VALUES($1,'draft',$2)",
          [itemId, draftId],
        );
      return draftId;
    };

    const entry = (
      itemId: string,
      edit: MediaEdit = identity,
      kind: "static" | "live" = "static",
    ) => ({
      key: `k-${itemId.slice(-20)}`,
      itemId,
      kind,
      qualityMode: "standard" as const,
      edit,
    });

    const command = (
      holder: PublishingHolder,
      over: Partial<WorkSubmissionContent>,
      baseRevisionId: string | null = null,
      requestId: string = randomUUID(),
    ): WorkSubmissionCommand =>
      workSubmissionCommandSchema.parse({
        requestId,
        holder,
        content: contentOf(over),
        baseRevisionId,
      });

    const authorRevision = async (workId: string): Promise<string> =>
      (
        await pool.query<{ author_revision_id: string }>(
          "SELECT author_revision_id FROM community.works WHERE id=$1",
          [workId],
        )
      ).rows[0]!.author_revision_id;

    const publish = async (
      author: string,
      over: Partial<WorkSubmissionContent>,
      now: Date,
    ): Promise<WorkSubmissionReceipt> =>
      confirmed(
        await adapter.submit(
          author,
          command({ sessionId: await holdSession(author) }, over),
          now,
        ),
      );

    const editWork = async (
      author: string,
      workId: string,
      over: Partial<WorkSubmissionContent>,
      now: Date,
    ): Promise<WorkSubmissionResult> =>
      adapter.submit(
        author,
        command(
          { sessionId: await holdSession(author, workId) },
          over,
          await authorRevision(workId),
        ),
        now,
      );

    const workRow = async (workId: string) =>
      (
        await pool.query<{
          visibility: string;
          public_revision_id: string | null;
          author_revision_id: string | null;
          first_published_at: Date | null;
          edited_at: Date | null;
          trashed_at: Date | null;
          trash_purge_after: Date | null;
          deleted_at: Date | null;
          title: string;
          text: string;
          version: number;
        }>(
          "SELECT visibility,public_revision_id,author_revision_id,first_published_at,edited_at,trashed_at,trash_purge_after,deleted_at,title,text,version FROM community.works WHERE id=$1",
          [workId],
        )
      ).rows[0]!;

    const revisionRow = async (revisionId: string) =>
      (
        await pool.query<{
          disposition: string;
          version: number;
          title: string;
          body: string;
          content_sha256: string;
          sequence: number;
        }>(
          "SELECT disposition,version,title,body,content_sha256,sequence FROM community.work_revisions WHERE id=$1",
          [revisionId],
        )
      ).rows[0]!;

    const count = async (sql: string, values: unknown[]): Promise<number> =>
      Number((await pool.query<{ n: string }>(sql, values)).rows[0]?.n ?? 0);

    const setPolicy = (policy: "DIRECT_PUBLICATION" | "PRE_MODERATION") =>
      pool.query(
        "UPDATE community.work_publishing_settings SET publication_policy=$1 WHERE id='settings'",
        [policy],
      );

    const browseIds = async (viewer: string | null) =>
      (
        await discovery.browse(viewer, discoveryQuerySchema.parse({}))
      ).items.map((card) => card.target.id);

    it("accepts text-only, title-only and media-only works, stores normalized text and refuses whitespace-empty content", async () => {
      const now = at("2026-06-01T12:00:00.000Z");
      const text = await publish(
        a,
        { body: "  只有正文\r\n第二行\r第三行  " },
        now,
      );
      expect(await revisionRow(text.revisionId)).toMatchObject({
        title: "",
        body: "只有正文\n第二行\n第三行",
        disposition: "approved",
        sequence: 1,
      });
      const textView = await authors.readWork(text.workId, b);
      expect(textView).toMatchObject({
        title: "",
        text: "只有正文\n第二行\n第三行",
        media: [],
        available: true,
        canEdit: false,
        firstPublishedAt: now.toISOString(),
        editedAt: null,
        authorship: { kind: "original" },
      });
      expect(textView).not.toHaveProperty("visibility");
      expect(
        await discovery.card({ type: "work", id: text.workId }, b),
      ).toMatchObject({
        title: "",
        excerpt: "只有正文\n第二行\n第三行",
        live: false,
        media: null,
      });

      const title = await publish(a, { title: "  只有标题  " }, now);
      expect((await authors.readWork(title.workId, null)).title).toBe(
        "只有标题",
      );

      const { itemId } = await mediaItem(a);
      const media = await publish(
        a,
        {
          items: [entry(itemId)],
          authorship: {
            kind: "copy_practice",
            referenceTitle: " 兰亭序 ",
            originalAuthor: "",
          },
        },
        now,
      );
      const mediaView = await authors.readWork(media.workId, null);
      expect(mediaView.media).toEqual([
        {
          id: itemId,
          src: `/api/community/publishing/media/${itemId}/display/base`,
          width: 640,
          height: 480,
          kind: "static",
        },
      ]);
      expect(mediaView.authorship).toEqual({
        kind: "copy_practice",
        referenceTitle: "兰亭序",
      });
      const mediaCard = await discovery.card(
        { type: "work", id: media.workId },
        null,
      );
      expect(mediaCard.excerpt).toBeUndefined();
      expect(mediaCard.media).toEqual({
        type: "work",
        id: itemId,
        width: 640,
        height: 480,
        src: `/api/community/publishing/media/${itemId}/cover/base`,
      });
      expect(
        (
          await pool.query(
            "SELECT holder_kind,holder_id FROM community.media_item_refs WHERE item_id=$1",
            [itemId],
          )
        ).rows,
      ).toEqual([{ holder_kind: "revision", holder_id: media.revisionId }]);

      const empty = await holdSession(a);
      const rejected: [Partial<WorkSubmissionContent>, string][] = [
        [{ title: "   ", body: " \n\t\r\n " }, "empty_work"],
        [{ title: "第一行\n第二行" }, "title_line_break"],
        [{ body: "字".repeat(10_001) }, "body_too_long"],
        [
          {
            title: "作品",
            authorship: {
              kind: "material_sharing",
              originalAuthor: "名".repeat(101),
            },
          },
          "original_author_too_long",
        ],
      ];
      for (const [over, code] of rejected)
        await expectRejection(
          adapter.submit(
            a,
            {
              requestId: randomUUID(),
              holder: { sessionId: empty },
              content: contentOf(over),
              baseRevisionId: null,
            },
            now,
          ),
          CommunityInputError,
          code,
        );
      expect(
        await count(
          "SELECT count(*) AS n FROM community.works WHERE author_id=$1",
          [a],
        ),
      ).toBe(3);
      expect(
        await count(
          "SELECT count(*) AS n FROM community.author_events WHERE actor_id=$1 AND action='publishing.submit'",
          [a],
        ),
      ).toBe(3);
    });

    it("answers not_ready with placeholder, unprocessed and underived item keys without writing anything", async () => {
      const now = at("2026-06-02T12:00:00.000Z");
      const ready = await mediaItem(a);
      const processing = await mediaItem(a, { state: "processing" });
      const rotated = await mediaItem(a);
      const live = await mediaItem(a, { kind: "live" });
      const sessionId = await holdSession(a, null, [
        ready.itemId,
        processing.itemId,
        rotated.itemId,
      ]);
      const rotation: MediaEdit = { rotation: 90, crop: null };
      const crop: MediaCrop = { x: 0, y: 0, width: 0.5, height: 1 };
      const placeholder = {
        key: "pending-1",
        itemId: null,
        kind: "static" as const,
        qualityMode: "standard" as const,
        edit: identity,
        pendingLabel: "photo" as const,
      };
      const request = command(
        { sessionId },
        {
          title: "未就绪",
          items: [
            entry(ready.itemId),
            placeholder,
            entry(processing.itemId),
            entry(rotated.itemId, rotation),
            entry(live.itemId, identity, "live"),
          ],
          coverKey: entry(live.itemId).key,
          coverCrop: crop,
        },
      );
      expect(await adapter.submit(a, request, now)).toEqual({
        state: "not_ready",
        itemKeys: [
          "pending-1",
          entry(processing.itemId).key,
          entry(rotated.itemId).key,
          entry(live.itemId).key,
        ],
      });
      for (const table of [
        "community.works WHERE author_id=$1",
        "community.author_command_receipts WHERE actor_id=$1",
        "community.author_events WHERE actor_id=$1",
        "community.daily_new_work_submissions WHERE account_id=$1",
        "community.publishing_jobs WHERE subject_id=$1",
      ])
        expect(await count(`SELECT count(*) AS n FROM ${table}`, [a])).toBe(0);
      expect(
        (
          await pool.query(
            "SELECT state FROM community.publishing_sessions WHERE id=$1",
            [sessionId],
          )
        ).rows,
      ).toEqual([{ state: "active" }]);

      // Once each edit and the cover crop have their derivatives, it succeeds.
      await pool.query(
        "UPDATE community.media_items SET state='ready' WHERE id=$1",
        [processing.itemId],
      );
      await derive(processing.itemId, a, "static", identity);
      await derive(rotated.itemId, a, "static", rotation);
      await derive(live.itemId, a, "live", identity, true, crop);
      const done = confirmed(
        await adapter.submit(
          a,
          {
            ...request,
            content: {
              ...request.content,
              items: request.content.items.filter(
                (item) => item.itemId !== null,
              ),
            },
          },
          now,
        ),
      );
      const view = await authors.readWork(done.workId, b);
      expect(view.media.map((item) => item.id)).toEqual([
        ready.itemId,
        processing.itemId,
        rotated.itemId,
        live.itemId,
      ]);
      expect(view.media[2]?.src).toMatch(
        new RegExp(`/${rotated.itemId}/display/[0-9a-f]{32}$`, "u"),
      );
      expect(view.media[3]).toMatchObject({
        kind: "live",
        motionSrc: `/api/community/publishing/media/${live.itemId}/motion/base`,
        hasAudio: true,
      });
      const card = await discovery.card({ type: "work", id: done.workId }, b);
      expect(card.live).toBe(true);
      expect((card.media as { src?: string } | null)?.src).toMatch(
        new RegExp(`/${live.itemId}/cover/[0-9a-f]{32}$`, "u"),
      );

      const foreign = await mediaItem(b);
      await expectRejection(
        adapter.submit(
          a,
          command(
            { sessionId: await holdSession(a) },
            { items: [entry(foreign.itemId)] },
          ),
          now,
        ),
        CommunityNotFoundError,
      );
    });

    it("is idempotent by request id, answers lost responses from the receipt and refuses a reused id with other content", async () => {
      const now = at("2026-06-03T12:00:00.000Z");
      const sessionId = await holdSession(a);
      const request = command({ sessionId }, { title: "一次提交" });
      const [first, second] = await Promise.all([
        adapter.submit(a, request, now),
        adapter.submit(a, request, now),
      ]);
      expect(second).toEqual(first);
      const receipt = confirmed(first!);
      expect(receipt).toEqual({
        state: "confirmed",
        requestId: request.requestId,
        workId: receipt.workId,
        revisionId: receipt.revisionId,
        visibility: "public",
        submittedAt: now.toISOString(),
      });
      expect(
        await adapter.submit(a, request, at("2026-06-03T13:00:00.000Z")),
      ).toEqual(receipt);
      expect(await adapter.readSubmissionReceipt(a, request.requestId)).toEqual(
        receipt,
      );
      expect(await adapter.readSubmissionReceipt(a, randomUUID())).toBeNull();
      expect(
        await adapter.readSubmissionReceipt(b, request.requestId),
      ).toBeNull();
      await expectRejection(
        adapter.submit(
          a,
          { ...request, content: { ...request.content, title: "别的内容" } },
          now,
        ),
        CommunityConflictError,
      );
      const other = randomUUID();
      await adapter.setVisibility(
        a,
        receipt.workId,
        { requestId: other, visibility: "self" },
        now,
      );
      expect(await adapter.readSubmissionReceipt(a, other)).toBeNull();
      expect(
        await count(
          "SELECT count(*) AS n FROM community.works WHERE author_id=$1",
          [a],
        ),
      ).toBe(1);
      expect(
        await count(
          "SELECT count AS n FROM community.daily_new_work_submissions WHERE account_id=$1",
          [a],
        ),
      ).toBe(1);
      expect(
        await count(
          "SELECT count(*) AS n FROM community.author_events WHERE actor_id=$1 AND action='publishing.submit' AND subject_id=$2",
          [a, receipt.workId],
        ),
      ).toBe(1);
      await expectRejection(
        adapter.submit(a, { ...request, requestId: randomUUID() }, now),
        CommunityConflictError,
      );
    });

    it("counts the 100th first submission and refuses the 101st on one America/New_York date", async () => {
      const now = at("2026-06-15T16:00:00.000Z");
      // 99 earlier successful first submissions on New York date 2026-06-15.
      await pool.query(
        "INSERT INTO community.daily_new_work_submissions(account_id,ny_date,count) VALUES($1,'2026-06-15',99)",
        [a],
      );
      await publish(a, { title: "第一百件" }, now);
      await expectRejection(
        adapter.submit(
          a,
          command(
            { sessionId: await holdSession(a) },
            { title: "第一百零一件" },
          ),
          now,
        ),
        CommunityInputError,
        "daily_limit",
      );
      expect(
        (
          await pool.query(
            "SELECT ny_date::text AS date,count FROM community.daily_new_work_submissions WHERE account_id=$1",
            [a],
          )
        ).rows,
      ).toEqual([{ date: "2026-06-15", count: 100 }]);
      expect(
        await count(
          "SELECT count(*) AS n FROM community.works WHERE author_id=$1",
          [a],
        ),
      ).toBe(1);
      await publish(a, { title: "次日" }, at("2026-06-16T04:00:00.000Z"));
    });

    it("uses the America/New_York date of the injected clock across midnight on both DST change dates", async () => {
      await pool.query(
        "UPDATE community.work_publishing_settings SET daily_new_work_limit=1 WHERE id='settings'",
      );
      const attempt = async (iso: string) =>
        adapter.submit(
          a,
          command({ sessionId: await holdSession(a) }, { body: iso }),
          at(iso),
        );
      // 2026-03-08 is 23 hours long; the next New York midnight is 04:00Z (EDT).
      confirmed(await attempt("2026-03-09T03:59:59.000Z"));
      await expectRejection(
        attempt("2026-03-09T03:59:59.900Z"),
        CommunityInputError,
        "daily_limit",
      );
      confirmed(await attempt("2026-03-09T04:00:00.000Z"));
      // 2026-11-01 is 25 hours long; the next New York midnight is 05:00Z (EST).
      confirmed(await attempt("2026-11-02T04:30:00.000Z"));
      await expectRejection(
        attempt("2026-11-02T04:59:59.999Z"),
        CommunityInputError,
        "daily_limit",
      );
      confirmed(await attempt("2026-11-02T05:00:00.000Z"));
      expect(
        (
          await pool.query(
            "SELECT ny_date::text AS date,count FROM community.daily_new_work_submissions WHERE account_id=$1 ORDER BY ny_date",
            [a],
          )
        ).rows,
      ).toEqual([
        { date: "2026-03-08", count: 1 },
        { date: "2026-03-09", count: 1 },
        { date: "2026-11-01", count: 1 },
        { date: "2026-11-02", count: 1 },
      ]);
    });

    it("never counts edits, visibility changes or retries, and never refunds a permanently deleted work", async () => {
      await pool.query(
        "UPDATE community.work_publishing_settings SET daily_new_work_limit=1 WHERE id='settings'",
      );
      const now = at("2026-07-01T15:00:00.000Z");
      const request = command(
        { sessionId: await holdSession(a) },
        { title: "当天唯一新作" },
      );
      const work = confirmed(await adapter.submit(a, request, now));
      expect(await adapter.submit(a, request, now)).toEqual(work);
      confirmed(await editWork(a, work.workId, { title: "编辑一次" }, now));
      for (const visibility of ["self", "public"] as const)
        await adapter.setVisibility(
          a,
          work.workId,
          { requestId: randomUUID(), visibility },
          now,
        );
      await adapter.deleteWork(
        a,
        work.workId,
        { requestId: randomUUID() },
        now,
      );
      await expectRejection(
        adapter.submit(
          a,
          command({ sessionId: await holdSession(a) }, { title: "第二件" }),
          now,
        ),
        CommunityInputError,
        "daily_limit",
      );
      expect(
        (
          await pool.query(
            "SELECT count FROM community.daily_new_work_submissions WHERE account_id=$1",
            [a],
          )
        ).rows,
      ).toEqual([{ count: 1 }]);
    });

    it("publishes directly or holds the first submission for moderation, and keeps self-only submissions out of the queue", async () => {
      const now = at("2026-07-02T10:00:00.000Z");
      const direct = await publish(a, { title: "直接发布" }, now);
      expect(await workRow(direct.workId)).toMatchObject({
        visibility: "public",
        public_revision_id: direct.revisionId,
        author_revision_id: direct.revisionId,
        first_published_at: now,
        title: "直接发布",
      });
      expect(await browseIds(b)).toContain(direct.workId);

      await setPolicy("PRE_MODERATION");
      const held = await publish(a, { title: "等待审核", body: "正文" }, now);
      expect(await revisionRow(held.revisionId)).toMatchObject({
        disposition: "pending",
        version: 1,
      });
      expect(await workRow(held.workId)).toMatchObject({
        visibility: "public",
        public_revision_id: null,
        first_published_at: null,
        title: "",
      });
      await expectRejection(
        authors.readWork(held.workId, b),
        CommunityNotFoundError,
      );
      await expectRejection(
        discovery.card({ type: "work", id: held.workId }, null),
        CommunityNotFoundError,
      );
      expect(await browseIds(a)).not.toContain(held.workId);
      const own = await authors.readWork(held.workId, a);
      // The author's own view never implies a pending state: its surfaces
      // stay open to the author (writes still need an effectively public work).
      expect(own).toMatchObject({
        title: "等待审核",
        text: "正文",
        available: true,
        canEdit: true,
        visibility: "public",
        firstPublishedAt: null,
      });
      expect(JSON.stringify(own)).not.toMatch(/pending|review|moderat/u);
      expect((await authors.readProfile(a, b)).totals.works).toBe(1);
      expect((await authors.readProfile(a, a)).totals.works).toBe(2);

      const self = await publish(
        a,
        { title: "仅自己可见", visibility: "self" },
        now,
      );
      expect(await revisionRow(self.revisionId)).toMatchObject({
        disposition: "not_required",
      });
      const mine = async (state?: "pending") =>
        (
          await operators.listSubmissions({
            ...(state === undefined ? {} : { state }),
            page: 1,
            pageSize: 50,
          })
        ).items.filter((item) => item.author.id === a);
      expect((await mine()).map((item) => item.revisionId).sort()).toEqual(
        [direct.revisionId, held.revisionId].sort(),
      );
      await expectRejection(
        operators.readSubmission(self.revisionId),
        CommunityNotFoundError,
      );
      const pending = await mine("pending");
      expect(pending.map((item) => item.revisionId)).toEqual([held.revisionId]);
      expect(pending[0]).toMatchObject({
        workId: held.workId,
        origin: "submission",
        sequence: 1,
        title: "等待审核",
        body: "正文",
        disposition: "pending",
        latest: true,
        workState: "visible",
        workTrashed: false,
        author: { id: a, displayName: "发布作者", status: "active" },
      });

      const approvedAt = at("2026-07-02T11:30:00.000Z");
      expect(
        await operators.moderateSubmission(
          held.revisionId,
          operator,
          { requestId: randomUUID(), action: "approve", expectedVersion: 1 },
          approvedAt,
        ),
      ).toEqual({
        revisionId: held.revisionId,
        workId: held.workId,
        disposition: "approved",
        version: 2,
      });
      expect(await workRow(held.workId)).toMatchObject({
        public_revision_id: held.revisionId,
        first_published_at: approvedAt,
        edited_at: null,
        title: "等待审核",
      });
      expect((await authors.readWork(held.workId, b)).available).toBe(true);
      expect(await operators.readSubmission(held.revisionId)).toMatchObject({
        decidedBy: operator,
        decidedAt: approvedAt.toISOString(),
      });
    });

    it("keeps the previous public revision for others while an edit awaits approval, shows the author the latest and denies stale edits", async () => {
      const published = at("2026-07-03T09:00:00.000Z");
      const work = await publish(
        a,
        { title: "原来的标题", body: "原来的正文" },
        published,
      );
      await setPolicy("PRE_MODERATION");
      const draftId = await holdDraft(a, work.workId, work.revisionId);
      const staleSession = await holdSession(a, work.workId);
      const editedAt = at("2026-07-03T10:00:00.000Z");
      const edit = confirmed(
        await adapter.submit(
          a,
          command(
            { draftId },
            { title: "新的标题", body: "新的正文" },
            work.revisionId,
          ),
          editedAt,
        ),
      );
      expect(await revisionRow(edit.revisionId)).toMatchObject({
        disposition: "pending",
        sequence: 2,
      });
      const managed = (
        await contentOperator.readWorks({
          page: 1,
          pageSize: 20,
          search: work.workId,
        })
      ).items[0];
      expect(managed).toMatchObject({
        latestSubmission: {
          revisionId: edit.revisionId,
          title: "新的标题",
          disposition: "pending",
        },
        publicRevisionId: work.revisionId,
        publiclyVisible: true,
      });
      expect(await authors.readWork(work.workId, b)).toMatchObject({
        title: "原来的标题",
        text: "原来的正文",
        firstPublishedAt: published.toISOString(),
        editedAt: null,
      });
      expect(
        (await discovery.card({ type: "work", id: work.workId }, b)).title,
      ).toBe("原来的标题");
      expect(await authors.readWork(work.workId, a)).toMatchObject({
        title: "新的标题",
        text: "新的正文",
        visibility: "public",
      });
      expect(await adapter.readEditableWork(a, work.workId)).toMatchObject({
        workId: work.workId,
        revisionId: edit.revisionId,
        content: { title: "新的标题", body: "新的正文", items: [] },
        visibility: "public",
        firstPublishedAt: published.toISOString(),
        editedAt: null,
        draftId: null,
      });
      expect(
        (
          await pool.query(
            "SELECT state,submitted_at FROM community.work_drafts WHERE id=$1",
            [draftId],
          )
        ).rows,
      ).toEqual([{ state: "submitted", submitted_at: editedAt }]);
      expect(
        (
          await pool.query(
            "SELECT kind,work_id,source_revision,pinned,content->>'title' AS title FROM community.work_draft_snapshots WHERE draft_id=$1 ORDER BY kind",
            [draftId],
          )
        ).rows,
      ).toEqual([
        // The draft held other saved content than was submitted.
        {
          kind: "conflict",
          work_id: work.workId,
          source_revision: 3,
          pinned: true,
          title: "草稿",
        },
        {
          kind: "submitted",
          work_id: work.workId,
          source_revision: 3,
          pinned: false,
          title: "新的标题",
        },
      ]);
      await expectRejection(
        adapter.submit(
          a,
          command(
            { sessionId: staleSession },
            { title: "过期的编辑" },
            work.revisionId,
          ),
          editedAt,
        ),
        CommunityConflictError,
      );
      await expectRejection(
        adapter.submit(
          a,
          command(
            { sessionId: await holdSession(a, work.workId) },
            { title: "缺少基础版本" },
            null,
          ),
          editedAt,
        ),
        CommunityConflictError,
      );
      await expectRejection(
        adapter.submit(
          a,
          command({ draftId }, { title: "再次提交" }, edit.revisionId),
          editedAt,
        ),
        CommunityConflictError,
      );
      await expectRejection(
        adapter.readEditableWork(b, work.workId),
        CommunityNotFoundError,
      );
    });

    it("approves only the latest pending submission at its current version and marks Edited only after a real content change", async () => {
      await setPolicy("PRE_MODERATION");
      const t0 = at("2026-07-04T08:00:00.000Z");
      const first = await publish(a, { title: "第一版" }, t0);
      const second = confirmed(
        await editWork(a, first.workId, { title: "第二版" }, t0),
      );
      expect(await revisionRow(first.revisionId)).toMatchObject({
        disposition: "superseded",
        version: 2,
      });
      const moderate = (
        revisionId: string,
        expectedVersion: number,
        action: "approve" | "reject" = "approve",
        now = at("2026-07-04T09:00:00.000Z"),
        requestId: string = randomUUID(),
      ) =>
        operators.moderateSubmission(
          revisionId,
          operator,
          { requestId, action, expectedVersion },
          now,
        );
      await expectRejection(
        moderate(first.revisionId, 2),
        CommunityConflictError,
      );
      await expectRejection(
        moderate(second.revisionId, 0),
        CommunityConflictError,
      );
      const requestId = randomUUID();
      const approvedAt = at("2026-07-04T09:00:00.000Z");
      const approved = await moderate(
        second.revisionId,
        1,
        "approve",
        approvedAt,
        requestId,
      );
      expect(
        await moderate(second.revisionId, 1, "approve", approvedAt, requestId),
      ).toEqual(approved);
      expect(
        await count(
          "SELECT count(*) AS n FROM community.content_operator_events WHERE operator_label=$1 AND action='publishing.submission.moderate'",
          [operator],
        ),
      ).toBe(1);
      await expectRejection(
        moderate(second.revisionId, 2),
        CommunityConflictError,
      );
      expect(await workRow(first.workId)).toMatchObject({
        public_revision_id: second.revisionId,
        first_published_at: approvedAt,
        edited_at: null,
      });

      const third = confirmed(
        await editWork(a, first.workId, { title: "第三版" }, approvedAt),
      );
      const thirdAt = at("2026-07-04T10:00:00.000Z");
      await moderate(third.revisionId, 1, "approve", thirdAt);
      expect(await workRow(first.workId)).toMatchObject({
        first_published_at: approvedAt,
        edited_at: thirdAt,
        title: "第三版",
      });
      const fourth = confirmed(
        await editWork(a, first.workId, { title: "第三版" }, thirdAt),
      );
      expect((await revisionRow(fourth.revisionId)).content_sha256).toBe(
        (await revisionRow(third.revisionId)).content_sha256,
      );
      await moderate(
        fourth.revisionId,
        1,
        "approve",
        at("2026-07-04T11:00:00.000Z"),
      );
      expect((await workRow(first.workId)).edited_at).toEqual(thirdAt);

      const fifth = confirmed(
        await editWork(a, first.workId, { title: "被拒绝的版本" }, thirdAt),
      );
      expect(
        await moderate(
          fifth.revisionId,
          1,
          "reject",
          at("2026-07-04T12:00:00.000Z"),
        ),
      ).toMatchObject({ disposition: "rejected", version: 2 });
      await expectRejection(
        moderate(fifth.revisionId, 2),
        CommunityConflictError,
      );
      expect(await workRow(first.workId)).toMatchObject({
        public_revision_id: fourth.revisionId,
        title: "第三版",
      });
      expect((await authors.readWork(first.workId, b)).title).toBe("第三版");
      expect((await authors.readWork(first.workId, a)).title).toBe(
        "被拒绝的版本",
      );
    });

    it("hides a work from every third-party surface as soon as it becomes self-only and withdraws pending public intent", async () => {
      const now = at("2026-07-05T08:00:00.000Z");
      const { itemId, masterKey } = await mediaItem(a);
      const work = await publish(
        a,
        { title: "公开后私密", items: [entry(itemId)] },
        now,
      );
      const target = { type: "work" as const, id: work.workId };
      for (const account of [a, b])
        await authors.updatePrivacy(account, {
          requestId: randomUUID(),
          privacy: allPublic,
        });
      await authors.changeRelation(b, "favorite", {
        requestId: randomUUID(),
        target,
        enabled: true,
      });
      const comment = await comments.submitDiscussion(
        target,
        b,
        "公开时的评论",
      );
      const displayTarget = await adapter.resolveMediaRead(
        b,
        itemId,
        "display",
        "base",
      );
      expect(displayTarget).toMatchObject({
        contentType: "image/webp",
        byteSize: 1024,
      });
      expect(displayTarget?.storageKey).not.toBe(masterKey);
      expect(
        await adapter.resolveMediaRead(null, itemId, "cover", "base"),
      ).not.toBeNull();
      expect(await browseIds(b)).toContain(work.workId);
      expect(
        (await discovery.collection(b, null, "favorite", listQuery)).items.map(
          (card) => card.target.id,
        ),
      ).toEqual([work.workId]);
      expect((await authors.readProfile(a, b)).totals.works).toBe(1);

      await setPolicy("PRE_MODERATION");
      const pending = confirmed(
        await editWork(
          a,
          work.workId,
          { title: "待审核的修改", items: [entry(itemId)] },
          now,
        ),
      );
      expect(
        await adapter.setVisibility(
          a,
          work.workId,
          { requestId: randomUUID(), visibility: "self" },
          at("2026-07-05T09:00:00.000Z"),
        ),
      ).toEqual({ workId: work.workId, visibility: "self" });
      expect((await revisionRow(pending.revisionId)).disposition).toBe(
        "withdrawn",
      );
      expect(
        (
          await operators.listSubmissions({
            state: "pending",
            page: 1,
            pageSize: 50,
          })
        ).items.filter((item) => item.author.id === a),
      ).toEqual([]);

      expect(await browseIds(b)).not.toContain(work.workId);
      await expectRejection(discovery.card(target, b), CommunityNotFoundError);
      expect(
        (await discovery.collection(b, null, "favorite", listQuery)).items,
      ).toEqual([]);
      expect((await authors.readProfile(a, b)).totals.works).toBe(0);
      expect((await authors.readProfile(a, null)).totals.works).toBe(0);
      expect((await authors.readProfile(a, a)).totals.works).toBe(1);
      expect((await authors.listWorks(a, b, listQuery)).items).toEqual([]);
      expect(
        (await authors.listWorks(a, a, listQuery)).items.map((w) => w.id),
      ).toEqual([work.workId]);
      await expectRejection(
        authors.readWork(work.workId, b),
        CommunityNotFoundError,
      );
      await expectRejection(
        comments.readDiscussion(target, b, { page: 1, pageSize: 10 }),
        CommunityNotFoundError,
      );
      await expectRejection(
        comments.submitDiscussion(target, b, "私密后的评论"),
        CommunityNotFoundError,
      );
      await expectRejection(
        authors.changeRelation(b, "like", {
          requestId: randomUUID(),
          target,
          enabled: true,
        }),
        CommunityNotFoundError,
      );
      expect(
        await adapter.resolveMediaRead(b, itemId, "display", "base"),
      ).toBeNull();
      expect(
        await adapter.resolveMediaRead(null, itemId, "cover", "base"),
      ).toBeNull();
      expect(await authors.readWork(work.workId, a)).toMatchObject({
        title: "待审核的修改",
        visibility: "self",
        available: true,
      });
      expect(
        (
          await comments.readDiscussion(target, a, { page: 1, pageSize: 10 })
        ).items.map((item) => item.id),
      ).toEqual([comment.id]);
      expect(
        await adapter.resolveMediaRead(a, itemId, "display", "base"),
      ).not.toBeNull();
      expect(
        await count(
          "SELECT count(*) AS n FROM community.content_relations WHERE user_id=$1 AND content_id=$2",
          [b, work.workId],
        ),
      ).toBe(1);
      expect(
        await count(
          "SELECT count(*) AS n FROM community.catalog_comments WHERE id=$1 AND moderation='visible' AND body_deleted_at IS NULL",
          [comment.id],
        ),
      ).toBe(1);
    });

    it("makes a self-only work public under the current policy with its actual first publication time", async () => {
      const created = at("2026-07-06T08:00:00.000Z");
      const direct = await publish(
        a,
        { title: "先私密后公开", visibility: "self" },
        created,
      );
      expect(await workRow(direct.workId)).toMatchObject({
        visibility: "self",
        first_published_at: null,
        public_revision_id: null,
      });
      await expectRejection(
        authors.readWork(direct.workId, b),
        CommunityNotFoundError,
      );
      const publicAt = at("2026-07-06T09:00:00.000Z");
      expect(
        await adapter.setVisibility(
          a,
          direct.workId,
          { requestId: randomUUID(), visibility: "public" },
          publicAt,
        ),
      ).toEqual({ workId: direct.workId, visibility: "public" });
      expect((await revisionRow(direct.revisionId)).disposition).toBe(
        "approved",
      );
      expect(await workRow(direct.workId)).toMatchObject({
        visibility: "public",
        public_revision_id: direct.revisionId,
        first_published_at: publicAt,
        edited_at: null,
      });
      expect((await authors.readWork(direct.workId, b)).title).toBe(
        "先私密后公开",
      );
      for (const visibility of ["self", "public"] as const)
        await adapter.setVisibility(
          a,
          direct.workId,
          { requestId: randomUUID(), visibility },
          at("2026-07-06T10:00:00.000Z"),
        );
      expect(await workRow(direct.workId)).toMatchObject({
        visibility: "public",
        first_published_at: publicAt,
        edited_at: null,
      });

      await setPolicy("PRE_MODERATION");
      const held = await publish(
        a,
        { title: "审核后公开", visibility: "self" },
        created,
      );
      await adapter.setVisibility(
        a,
        held.workId,
        { requestId: randomUUID(), visibility: "public" },
        publicAt,
      );
      expect(await revisionRow(held.revisionId)).toMatchObject({
        disposition: "pending",
        version: 2,
      });
      await expectRejection(
        authors.readWork(held.workId, b),
        CommunityNotFoundError,
      );
      const approvedAt = at("2026-07-06T12:00:00.000Z");
      await operators.moderateSubmission(
        held.revisionId,
        operator,
        { requestId: randomUUID(), action: "approve", expectedVersion: 2 },
        approvedAt,
      );
      expect(await workRow(held.workId)).toMatchObject({
        visibility: "public",
        first_published_at: approvedAt,
      });
      expect((await authors.readWork(held.workId, b)).title).toBe("审核后公开");
    });

    it("never lets edits undo an Admin hide or removal, and refuses a self-restore of a removed work", async () => {
      const now = at("2026-07-07T08:00:00.000Z");
      const hidden = await publish(a, { title: "被隐藏" }, now);
      await contentOperator.moderateWork(hidden.workId, operator, {
        requestId: randomUUID(),
        state: "hidden",
        expectedVersion: (await authors.readWork(hidden.workId, a)).version,
      });
      confirmed(
        await editWork(a, hidden.workId, { title: "隐藏期间的编辑" }, now),
      );
      await adapter.setVisibility(
        a,
        hidden.workId,
        { requestId: randomUUID(), visibility: "public" },
        now,
      );
      await expectRejection(
        authors.readWork(hidden.workId, b),
        CommunityNotFoundError,
      );
      expect((await authors.readWork(hidden.workId, a)).title).toBe(
        "隐藏期间的编辑",
      );
      // The author's own discussion read never reaches a hidden work.
      await adapter.setVisibility(
        a,
        hidden.workId,
        { requestId: randomUUID(), visibility: "self" },
        now,
      );
      await expectRejection(
        comments.readDiscussion({ type: "work", id: hidden.workId }, a, {
          page: 1,
          pageSize: 10,
        }),
        CommunityNotFoundError,
      );
      await expectRejection(
        contentOperator.setFeatured(operator, {
          requestId: randomUUID(),
          target: { type: "work", id: hidden.workId },
          enabled: true,
          position: 0,
          expectedVersion: 0,
        }),
        CommunityConflictError,
      );

      const removed = await publish(a, { title: "被移除" }, now);
      await contentOperator.moderateWork(removed.workId, operator, {
        requestId: randomUUID(),
        state: "removed",
        expectedVersion: (await authors.readWork(removed.workId, a)).version,
      });
      await expectRejection(
        editWork(a, removed.workId, { title: "试图恢复" }, now),
        CommunityInputError,
        "work_unavailable",
      );
      await expectRejection(
        adapter.setVisibility(
          a,
          removed.workId,
          { requestId: randomUUID(), visibility: "self" },
          now,
        ),
        CommunityInputError,
        "work_unavailable",
      );
      await adapter.deleteWork(
        a,
        removed.workId,
        { requestId: randomUUID() },
        now,
      );
      await expectRejection(
        editWork(a, removed.workId, { title: "删除后的编辑" }, now),
        CommunityInputError,
        "work_unavailable",
      );
      await expectRejection(
        authors.readWork(removed.workId, b),
        CommunityNotFoundError,
      );
    });

    it("permanently erases owned content and history, preserves others' replies and replays deletion", async () => {
      const { itemId } = await mediaItem(a);
      const exclusive = await mediaItem(a);
      const now = at("2026-07-08T08:00:00.000Z");
      const work = await publish(
        a,
        {
          title: "待删除标题",
          body: "待删除正文",
          items: [entry(itemId), entry(exclusive.itemId)],
        },
        now,
      );
      const kept = await publish(
        a,
        { title: "共享图片保留", items: [entry(itemId)] },
        now,
      );
      const edit = await adapter.openEditDraft(
        a,
        work.workId,
        { requestId: randomUUID(), deviceClass: "phone" },
        now,
      );
      const target = { type: "work" as const, id: work.workId };
      const comment = await comments.submitDiscussion(
        target,
        b,
        "他人评论保留",
      );
      await pool.query(
        "INSERT INTO community.author_command_receipts(actor_id,request_id,fingerprint,result) VALUES($1,$2,$3,$4::jsonb)",
        [
          a,
          randomUUID(),
          "a".repeat(64),
          JSON.stringify({
            workId: work.workId,
            title: "历史标题",
            text: "历史原文",
          }),
        ],
      );
      const moderationRequest = {
        requestId: randomUUID(),
        state: "hidden" as const,
        expectedVersion: (await authors.readWork(work.workId, a)).version,
      };
      await contentOperator.moderateWork(
        work.workId,
        operator,
        moderationRequest,
      );
      const request = { requestId: randomUUID() };
      await expectRejection(
        adapter.deleteWork(b, work.workId, request, now),
        CommunityNotFoundError,
      );
      expect((await workRow(work.workId)).title).toBe("待删除标题");
      expect(await adapter.deleteWork(a, work.workId, request, now)).toEqual({
        deleted: true,
      });
      expect(await adapter.deleteWork(a, work.workId, request, now)).toEqual({
        deleted: true,
      });
      expect(await workRow(work.workId)).toMatchObject({
        title: "",
        text: "",
        deleted_at: now,
        public_revision_id: null,
        author_revision_id: null,
        trashed_at: null,
        trash_purge_after: null,
      });
      for (const table of [
        "work_revisions",
        "work_drafts",
        "work_draft_snapshots",
        "work_edit_drafts",
      ])
        expect(
          await count(
            `SELECT count(*) AS n FROM community.${table} WHERE work_id=$1`,
            [work.workId],
          ),
        ).toBe(0);
      for (const viewer of [a, b])
        await expectRejection(
          authors.readWork(work.workId, viewer),
          CommunityNotFoundError,
        );
      await expectRejection(
        adapter.readEditableWork(a, work.workId),
        CommunityNotFoundError,
      );
      await expectRejection(
        adapter.readDraft(a, edit.draft.id),
        CommunityNotFoundError,
      );
      await expectRejection(
        adapter.deleteWork(a, work.workId, { requestId: randomUUID() }, now),
        CommunityNotFoundError,
      );
      expect((await authors.readWork(kept.workId, b)).title).toBe(
        "共享图片保留",
      );
      await expectRejection(
        contentOperator.moderateWork(work.workId, operator, moderationRequest),
        CommunityNotFoundError,
      );
      expect(
        JSON.stringify(
          (
            await pool.query(
              "SELECT result FROM community.content_operator_receipts WHERE operator_label=$1",
              [operator],
            )
          ).rows,
        ),
      ).not.toMatch(/待删除标题|待删除正文/);
      expect(
        JSON.stringify(
          (
            await pool.query(
              "SELECT detail FROM community.content_operator_events WHERE content_type='work' AND content_id=$1",
              [work.workId],
            )
          ).rows,
        ),
      ).not.toMatch(/待删除标题|待删除正文/);
      expect((await adapter.readItem(a, itemId)).state).toBe("ready");
      expect((await adapter.readItem(a, exclusive.itemId)).state).toBe(
        "cancelled",
      );
      // Cancellation revokes the deleted work's bytes before the purge worker runs.
      expect(
        await adapter.resolveMediaRead(a, exclusive.itemId, "display", "base"),
      ).toBeNull();
      expect(
        await adapter.resolveMediaRead(a, itemId, "display", "base"),
      ).not.toBeNull();
      expect(
        (
          await pool.query(
            "SELECT run_after FROM community.publishing_jobs WHERE kind='purge_item' AND subject_id=$1",
            [exclusive.itemId],
          )
        ).rows,
      ).toEqual([{ run_after: now }]);
      expect(
        JSON.stringify(
          (
            await pool.query(
              "SELECT result FROM community.author_command_receipts WHERE actor_id=$1",
              [a],
            )
          ).rows,
        ),
      ).not.toMatch(/待删除标题|待删除正文|历史标题|历史原文/);
      expect(
        (
          await pool.query(
            "SELECT text,body_deleted_at FROM community.catalog_comments WHERE id=$1",
            [comment.id],
          )
        ).rows,
      ).toEqual([{ text: "他人评论保留", body_deleted_at: null }]);
    });

    it("erases exclusive legacy work and finished draft bytes while preserving other work and profile images", async () => {
      const media = [
        id("user-media"),
        id("user-media"),
        id("user-media"),
        id("user-media"),
      ];
      for (const mediaId of media)
        await pool.query(
          "INSERT INTO community.user_media(id,owner_id,mime_type,width,height,sha256,bytes) VALUES($1,$2,'image/png',1,1,$3,$4)",
          [mediaId, a, "b".repeat(64), Buffer.from([0x89, 0x50, 0x4e, 0x47])],
        );
      const workId = id("work"),
        keptId = id("work");
      await pool.query(
        "INSERT INTO community.works(id,author_id,title,text,media_ids,first_published_at) VALUES($1,$2,'待删除','原文',$3,CURRENT_TIMESTAMP),($4,$2,'保留','共享',$5,CURRENT_TIMESTAMP)",
        [workId, a, media, keptId, [media[1]]],
      );
      await pool.query(
        "UPDATE community.public_users SET avatar_media_id=$2,background_media_id=$3 WHERE id=$1",
        [a, media[2], media[3]],
      );
      const now = at("2026-09-20T12:00:00.000Z");
      const finishedDraftMedia = [id("user-media"), id("user-media")];
      for (const [index, mediaId] of finishedDraftMedia.entries()) {
        await pool.query(
          "INSERT INTO community.user_media(id,owner_id,mime_type,width,height,sha256,bytes) VALUES($1,$2,'image/png',1,1,$3,$4)",
          [mediaId, a, "c".repeat(64), Buffer.from([0x89, 0x50, 0x4e, 0x47])],
        );
        await pool.query(
          `INSERT INTO community.work_edit_drafts
           (id,work_id,author_id,version,base_work_version,base_draft_version,title,text,media_ids,applied_at,discarded_at)
           VALUES($1,$2,$3,$4,1,0,'旧草稿','待删除的旧正文',$5,$6,$7)`,
          [
            id("draft"),
            workId,
            a,
            index + 1,
            [mediaId],
            index === 0 ? now : null,
            index === 1 ? now : null,
          ],
        );
      }
      await adapter.deleteWork(a, workId, { requestId: randomUUID() }, now);
      const rows = (
        await pool.query<{ id: string; size: number; deleted_at: Date | null }>(
          "SELECT id,octet_length(bytes) AS size,deleted_at FROM community.user_media WHERE id=ANY($1::text[])",
          [[...media, ...finishedDraftMedia]],
        )
      ).rows;
      expect(rows.find((row) => row.id === media[0])).toMatchObject({
        size: 0,
        deleted_at: now,
      });
      for (const mediaId of finishedDraftMedia) {
        expect(rows.find((row) => row.id === mediaId)).toMatchObject({
          size: 0,
          deleted_at: now,
        });
        expect(await authors.readMedia(mediaId, a)).toBeNull();
      }
      for (const mediaId of media.slice(1))
        expect(rows.find((row) => row.id === mediaId)).toMatchObject({
          size: 4,
          deleted_at: null,
        });
    });

    it("purges a trashed work only after retention and keeps media another work still references", async () => {
      const shared = await mediaItem(a);
      const exclusive = await mediaItem(a);
      const now = at("2026-07-10T08:00:00.000Z");
      const trashed = await publish(
        a,
        {
          title: "将被清除",
          items: [entry(shared.itemId), entry(exclusive.itemId)],
        },
        now,
      );
      const kept = await publish(
        a,
        { title: "共享媒体", items: [entry(shared.itemId)] },
        now,
      );
      // Every other holder of the trashed work: an edit draft (with a
      // conflict copy and media never submitted), a history snapshot and a
      // no-save edit session (with media never submitted).
      const draftOnly = await mediaItem(a);
      const sessionOnly = await mediaItem(a, { state: "processing" });
      const editDraft = await holdDraft(a, trashed.workId, trashed.revisionId, [
        exclusive.itemId,
        draftOnly.itemId,
      ]);
      const conflictCopy = id("work-draft");
      await pool.query(
        `INSERT INTO community.work_drafts(id,owner_id,work_id,base_revision_id,state,conflict_of,revision,content,content_sha256)
        VALUES($1,$2,$3,$4,'active',$5,1,$6::jsonb,encode(sha256(convert_to($6::jsonb::text,'UTF8')),'hex'))`,
        [
          conflictCopy,
          a,
          trashed.workId,
          trashed.revisionId,
          editDraft,
          JSON.stringify(contentOf({ title: "冲突副本" })),
        ],
      );
      const snapshotId = id("work-snapshot");
      await pool.query(
        "INSERT INTO community.work_draft_snapshots(id,owner_id,draft_id,work_id,kind,content,pinned) VALUES($1,$2,$3,$4,'saved',$5::jsonb,FALSE)",
        [
          snapshotId,
          a,
          editDraft,
          trashed.workId,
          JSON.stringify(contentOf({ items: [entry(exclusive.itemId)] })),
        ],
      );
      await pool.query(
        "INSERT INTO community.media_item_refs(item_id,holder_kind,holder_id) VALUES($1,'snapshot',$2)",
        [exclusive.itemId, snapshotId],
      );
      const editSession = await holdSession(a, trashed.workId, [
        exclusive.itemId,
        sessionOnly.itemId,
      ]);
      await legacyTrashFixture(
        a,
        trashed.workId,
        { requestId: randomUUID() },
        now,
      );
      expect(
        await adapter.purgeTrashedWork(
          trashed.workId,
          at("2026-08-09T07:59:59.999Z"),
        ),
      ).toBe("not_due");
      const purgedAt = at("2026-08-09T08:00:00.000Z");
      expect(await adapter.purgeTrashedWork(trashed.workId, purgedAt)).toBe(
        "purged",
      );
      expect(await adapter.purgeTrashedWork(trashed.workId, purgedAt)).toBe(
        "missing",
      );
      expect(await adapter.purgeTrashedWork(id("work"), purgedAt)).toBe(
        "missing",
      );
      expect((await workRow(trashed.workId)).deleted_at).toEqual(purgedAt);
      // Draft rows and conflict copies go with their content.
      expect(
        await count(
          "SELECT count(*) AS n FROM community.work_drafts WHERE id=ANY($1::text[]) OR work_id=$2",
          [[editDraft, conflictCopy], trashed.workId],
        ),
      ).toBe(0);
      expect(
        (
          await pool.query(
            "SELECT state,ended_at FROM community.publishing_sessions WHERE id=$1",
            [editSession],
          )
        ).rows,
      ).toEqual([{ state: "discarded", ended_at: purgedAt }]);
      // Media only the drafts and the session held is cancelled at once.
      for (const item of [draftOnly, sessionOnly]) {
        expect(
          (
            await pool.query(
              "SELECT state FROM community.media_items WHERE id=$1",
              [item.itemId],
            )
          ).rows,
        ).toEqual([{ state: "cancelled" }]);
        expect(
          (
            await pool.query(
              "SELECT run_after FROM community.publishing_jobs WHERE kind='purge_item' AND subject_id=$1 AND state='queued'",
              [item.itemId],
            )
          ).rows,
        ).toEqual([{ run_after: purgedAt }]);
      }
      expect(
        await count(
          "SELECT count(*) AS n FROM community.work_draft_snapshots WHERE work_id=$1",
          [trashed.workId],
        ),
      ).toBe(0);
      expect(
        (
          await pool.query(
            "SELECT item_id,holder_kind,holder_id FROM community.media_item_refs WHERE item_id=ANY($1::text[]) ORDER BY item_id",
            [[shared.itemId, exclusive.itemId]],
          )
        ).rows,
      ).toEqual([
        {
          item_id: shared.itemId,
          holder_kind: "revision",
          holder_id: kept.revisionId,
        },
      ]);
      expect(
        (
          await pool.query(
            "SELECT subject_id FROM community.publishing_jobs WHERE kind='purge_item' AND subject_id=ANY($1::text[])",
            [[shared.itemId, exclusive.itemId]],
          )
        ).rows,
      ).toEqual([{ subject_id: exclusive.itemId }]);
      expect(
        await adapter.resolveMediaRead(null, shared.itemId, "display", "base"),
      ).not.toBeNull();
      expect(
        (await authors.readWork(kept.workId, b)).media.map((m) => m.id),
      ).toEqual([shared.itemId]);
    });

    it("authorizes derivative reads for owners in any state and for others only through an effectively public revision", async () => {
      const now = at("2026-07-11T08:00:00.000Z");
      const draftOnly = await mediaItem(a);
      await holdDraft(a, null, null, [draftOnly.itemId]);
      expect(
        await adapter.resolveMediaRead(a, draftOnly.itemId, "display", "base"),
      ).toMatchObject({ contentType: "image/webp", byteSize: 1024 });
      for (const viewer of [b, null])
        expect(
          await adapter.resolveMediaRead(
            viewer,
            draftOnly.itemId,
            "display",
            "base",
          ),
        ).toBeNull();

      const cover = await mediaItem(a);
      const crop: MediaCrop = { x: 0.25, y: 0, width: 0.5, height: 1 };
      const keys = await derive(
        cover.itemId,
        a,
        "static",
        identity,
        true,
        crop,
      );
      const live = await mediaItem(a, { kind: "live" });
      const work = await publish(
        a,
        {
          title: "媒体授权",
          items: [entry(cover.itemId), entry(live.itemId, identity, "live")],
          coverKey: entry(cover.itemId).key,
          coverCrop: crop,
        },
        now,
      );
      expect(keys.cover).toMatch(/^[0-9a-f]{32}$/u);
      expect(
        await adapter.resolveMediaRead(b, cover.itemId, "cover", keys.cover!),
      ).not.toBeNull();
      // Every work read names the card cover under the cover crop's key.
      for (const viewer of [a, b, null])
        expect((await authors.readWork(work.workId, viewer)).coverSrc).toBe(
          `/api/community/publishing/media/${cover.itemId}/cover/${keys.cover!}`,
        );
      // The uncropped cover is not what the public revision shows.
      expect(
        await adapter.resolveMediaRead(b, cover.itemId, "cover", "base"),
      ).toBeNull();
      expect(
        await adapter.resolveMediaRead(a, cover.itemId, "cover", "base"),
      ).not.toBeNull();
      expect(
        await adapter.resolveMediaRead(b, live.itemId, "motion", "base"),
      ).toMatchObject({ contentType: "video/mp4" });
      expect(
        await adapter.resolveMediaRead(b, live.itemId, "display", keys.cover!),
      ).toBeNull();

      await authors.block(a, {
        requestId: randomUUID(),
        targetId: b,
        enabled: true,
      });
      expect(
        await adapter.resolveMediaRead(b, live.itemId, "motion", "base"),
      ).toBeNull();
      expect(
        await adapter.resolveMediaRead(null, live.itemId, "motion", "base"),
      ).not.toBeNull();
      await pool.query(
        "UPDATE community.public_users SET status='suspended' WHERE id=$1",
        [a],
      );
      for (const viewer of [null, a])
        expect(
          await adapter.resolveMediaRead(viewer, live.itemId, "motion", "base"),
        ).toBeNull();
      await pool.query(
        "UPDATE community.public_users SET status='active' WHERE id=$1",
        [a],
      );

      expect(
        await operators.resolveMediaRead(
          work.revisionId,
          cover.itemId,
          "display",
          "base",
        ),
      ).not.toBeNull();
      expect(
        await operators.resolveMediaRead(
          work.revisionId,
          draftOnly.itemId,
          "display",
          "base",
        ),
      ).toBeNull();
      const self = await publish(
        a,
        {
          title: "私密",
          visibility: "self",
          items: [entry(draftOnly.itemId)],
        },
        now,
      );
      expect(
        await operators.resolveMediaRead(
          self.revisionId,
          draftOnly.itemId,
          "display",
          "base",
        ),
      ).toBeNull();
      const submission = await operators.readSubmission(work.revisionId);
      const coverEditKey = await editKeyOf(identity, crop);
      expect(coverEditKey).toBe(keys.cover);
      expect(submission.items).toEqual([
        // The cropped cover's thumb and cover are listed with their own
        // cover edit key (media_edit_key(edit, cover_crop)); display, full
        // and motion keep the item edit key.
        expect.objectContaining({
          position: 1,
          itemId: cover.itemId,
          editKey: "base",
          coverEditKey,
          variants: ["thumb", "display", "full", "cover"],
          presentation: { width: 640, height: 480 },
        }),
        expect.objectContaining({
          position: 2,
          itemId: live.itemId,
          kind: "live",
          editKey: "base",
          coverEditKey: null,
          variants: ["thumb", "display", "full", "cover", "motion"],
        }),
      ]);
      expect(submission.coverCrop).toEqual(crop);
      const croppedThumb = (
        await pool.query<{ storage_key: string }>(
          "SELECT b.storage_key FROM community.media_derivatives d JOIN community.media_blobs b ON b.id=d.blob_id WHERE d.item_id=$1 AND d.variant='thumb' AND d.edit_key=$2",
          [cover.itemId, coverEditKey],
        )
      ).rows[0]!.storage_key;
      expect(
        await operators.resolveMediaRead(
          work.revisionId,
          cover.itemId,
          "thumb",
          coverEditKey,
        ),
      ).toMatchObject({ storageKey: croppedThumb });
      // Without a cover crop the cover item's cover key equals its edit key.
      const plain = await publish(
        a,
        {
          title: "无裁切封面",
          items: [entry(live.itemId, identity, "live")],
          coverKey: entry(live.itemId).key,
        },
        now,
      );
      expect(
        (await operators.readSubmission(plain.revisionId)).items,
      ).toMatchObject([{ itemId: live.itemId, coverEditKey: "base" }]);
      const croppedCover = (
        await pool.query<{ storage_key: string }>(
          "SELECT b.storage_key FROM community.media_derivatives d JOIN community.media_blobs b ON b.id=d.blob_id WHERE d.item_id=$1 AND d.variant='cover' AND d.edit_key=$2",
          [cover.itemId, keys.cover],
        )
      ).rows[0]!.storage_key;
      for (const editKey of ["base", keys.cover!])
        expect(
          await operators.resolveMediaRead(
            work.revisionId,
            cover.itemId,
            "cover",
            editKey,
          ),
        ).toMatchObject({ storageKey: croppedCover });
      expect(
        await operators.resolveMediaRead(
          work.revisionId,
          cover.itemId,
          "display",
          keys.cover!,
        ),
      ).toBeNull();
    });

    it("bridges Phase 4 style work inserts into legacy revisions served from user media", async () => {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      const first = id("user-media");
      const second = id("user-media");
      await pool.query(
        "INSERT INTO community.user_media(id,owner_id,mime_type,width,height,sha256,bytes) VALUES($1,$3,'image/png',30,40,$4,$5),($2,$3,'image/png',50,60,$4,$5)",
        [first, second, a, "b".repeat(64), png],
      );
      const work = id("work");
      await pool.query(
        "INSERT INTO community.works(id,author_id,title,text,media_ids,first_published_at,synthetic_provenance) VALUES($1,$2,'旧式作品','旧式正文',$3,'2026-01-05T00:00:00Z','work-publishing-bridge-test')",
        [work, a, [second, first, second]],
      );
      const revision = (
        await pool.query<{ id: string }>(
          "SELECT 'work-revision-'||md5('legacy-revision:'||$1::text) AS id",
          [work],
        )
      ).rows[0]!.id;
      expect(await workRow(work)).toMatchObject({
        public_revision_id: revision,
        author_revision_id: revision,
        first_published_at: at("2026-01-05T00:00:00.000Z"),
        version: 1,
      });
      expect(await revisionRow(revision)).toMatchObject({
        disposition: "approved",
        sequence: 1,
        title: "旧式作品",
      });
      expect((await authors.readWork(work, b)).media).toEqual([
        {
          id: second,
          src: `/api/community/media/${second}`,
          width: 50,
          height: 60,
        },
        {
          id: first,
          src: `/api/community/media/${first}`,
          width: 30,
          height: 40,
        },
      ]);
      expect(
        (await discovery.card({ type: "work", id: work }, b)).media,
      ).toEqual({
        type: "work",
        id: second,
        width: 50,
        height: 60,
        src: `/api/community/media/${second}`,
      });
      expect(await authors.readMedia(first, b)).not.toBeNull();
      // Phase 4 authors never declared authorship: nothing claims one.
      expect(
        (
          await pool.query(
            "SELECT authorship_kind,reference_title,original_author,source_note FROM community.work_revisions WHERE id=$1",
            [revision],
          )
        ).rows,
      ).toEqual([
        {
          authorship_kind: null,
          reference_title: null,
          original_author: null,
          source_note: null,
        },
      ]);
      for (const viewer of [a, b, null]) {
        const read = await authors.readWork(work, viewer);
        expect(read).not.toHaveProperty("authorship");
        expect(read.coverSrc).toBe(`/api/community/media/${second}`);
      }
      expect((await operators.readSubmission(revision)).authorship).toBeNull();
      const oldImages = (await operators.readSubmission(revision)).items;
      expect(oldImages.map((item) => item.variants)).toEqual([
        ["display"],
        ["display"],
      ]);
      const oldItem = oldImages[0]!.itemId;
      // Admin inspects the submitted representation even after it is hidden.
      await pool.query(
        "UPDATE community.works SET operator_state='hidden' WHERE id=$1",
        [work],
      );
      expect(await authors.readMedia(second, b)).toBeNull();
      expect(
        await operators.resolveMediaRead(revision, oldItem, "display", "base"),
      ).toEqual({ legacyPng: png, sha256: "b".repeat(64) });
      for (const [r, i, variant, key] of [
        [id("work-revision"), oldItem, "display", "base"],
        [revision, id("media-item"), "display", "base"],
        [revision, oldItem, "motion", "base"],
        [revision, oldItem, "display", "not-the-submitted-edit"],
      ] as const)
        expect(await operators.resolveMediaRead(r, i, variant, key)).toBeNull();
      await pool.query(
        "UPDATE community.work_revisions SET disposition='not_required' WHERE id=$1",
        [revision],
      );
      expect(
        await operators.resolveMediaRead(revision, oldItem, "display", "base"),
      ).toBeNull();
      await pool.query(
        "UPDATE community.work_revisions SET disposition='approved' WHERE id=$1",
        [revision],
      );
      await pool.query(
        "UPDATE community.works SET deleted_at=now() WHERE id=$1",
        [work],
      );
      expect(
        await operators.resolveMediaRead(revision, oldItem, "display", "base"),
      ).toBeNull();
      await pool.query(
        "UPDATE community.works SET deleted_at=NULL WHERE id=$1",
        [work],
      );
      await pool.query(
        "UPDATE community.works SET operator_state='visible' WHERE id=$1",
        [work],
      );
      const editable = await adapter.readEditableWork(a, work);
      expect(editable.content.authorship).toBeNull();
      expect(editable.content.items.map((item) => item.qualityMode)).toEqual([
        "legacy",
        "legacy",
      ]);
      expect(editable.mediaItems[0]?.media?.displaySrc).toBe(
        `/api/community/media/${second}`,
      );
      expect(
        (
          await pool.query<{ id: string }>(
            "SELECT community.ensure_legacy_work_revision($1) AS id",
            [work],
          )
        ).rows[0]!.id,
      ).toBe(revision);
      // Resubmitting the unchanged legacy content keeps its content identity.
      const legacyItems = editable.content.items;
      const resubmitted = confirmed(
        await editWork(
          a,
          work,
          {
            title: "旧式作品",
            body: "旧式正文",
            authorship: editable.content.authorship,
            items: legacyItems,
            coverKey: editable.content.coverKey,
          },
          at("2026-07-12T08:00:00.000Z"),
        ),
      );
      expect((await revisionRow(resubmitted.revisionId)).content_sha256).toBe(
        (await revisionRow(revision)).content_sha256,
      );
      expect((await workRow(work)).edited_at).toBeNull();
      // A rotation or a cover crop of a legacy PNG derives from its user media
      // bytes like any other edit: not ready until those derivatives exist,
      // while its unedited form keeps the user media route.
      const [secondItem, firstItem] = legacyItems;
      if (secondItem === undefined || firstItem === undefined)
        throw new Error("legacy items missing");
      const legacyCrop = { x: 0, y: 0, width: 0.5, height: 0.5 };
      const edited = {
        title: "旋转旧图",
        body: "旧式正文",
        items: [
          secondItem,
          { ...firstItem, edit: { rotation: 90 as const, crop: null } },
        ],
        coverKey: secondItem.key,
        coverCrop: legacyCrop,
      };
      const editedAt = at("2026-07-12T09:00:00.000Z");
      expect(await editWork(a, work, edited, editedAt)).toEqual({
        state: "not_ready",
        itemKeys: [secondItem.key, firstItem.key],
      });
      expect(
        await adapter.ensureEditDerivatives(
          a,
          {
            items: edited.items,
            coverKey: edited.coverKey,
            coverCrop: edited.coverCrop,
          },
          editedAt,
        ),
      ).toEqual({
        ready: false,
        items: [
          {
            key: secondItem.key,
            itemId: secondItem.itemId,
            state: "deriving",
            editKey: null,
          },
          {
            key: firstItem.key,
            itemId: firstItem.itemId,
            state: "deriving",
            editKey: null,
          },
        ],
      });
      const rotatedKey = (
        await pool.query<{ key: string }>(
          "SELECT community.media_edit_key($1::jsonb,NULL) AS key",
          [JSON.stringify({ rotation: 90, crop: null })],
        )
      ).rows[0]!.key;
      const croppedKey = (
        await pool.query<{ key: string }>(
          "SELECT community.media_edit_key($1::jsonb,$2::jsonb) AS key",
          [JSON.stringify(identity), JSON.stringify(legacyCrop)],
        )
      ).rows[0]!.key;
      const legacyJobs = (
        await pool.query<{
          id: string;
          subject_id: string;
          payload: {
            editKey: string;
            edit: MediaEdit;
            coverCrop: MediaCrop | null;
            variants: ("thumb" | "display" | "full" | "cover")[];
          };
          run_after: Date;
        }>(
          "SELECT id,subject_id,payload,run_after FROM community.publishing_jobs WHERE kind='derive_edit' AND subject_id=ANY($1::text[]) AND state='queued' ORDER BY subject_id=$2 DESC",
          [[secondItem.itemId, firstItem.itemId], secondItem.itemId],
        )
      ).rows;
      expect(
        legacyJobs.map(({ subject_id, payload, run_after }) => ({
          subject_id,
          payload,
          run_after,
        })),
      ).toEqual([
        {
          subject_id: secondItem.itemId,
          payload: {
            editKey: croppedKey,
            edit: identity,
            coverCrop: legacyCrop,
            variants: ["thumb", "cover"],
          },
          run_after: editedAt,
        },
        {
          subject_id: firstItem.itemId,
          payload: {
            editKey: rotatedKey,
            edit: { rotation: 90, crop: null },
            coverCrop: null,
            variants: ["thumb", "display", "full"],
          },
          run_after: editedAt,
        },
      ]);
      // The worker reads the legacy PNG through the port, never a store key.
      for (const [job, mediaId] of [
        [legacyJobs[0]!, second],
        [legacyJobs[1]!, first],
      ] as const) {
        expect(
          await adapter.readProcessing({
            kind: "derive_edit",
            subjectId: job.subject_id,
            payload: job.payload,
          }),
        ).toEqual({
          mode: "derive",
          itemId: job.subject_id,
          ownerId: a,
          kind: "static",
          qualityMode: "standard",
          components: [],
          clientPairing: null,
          editKey: job.payload.editKey,
          edit: job.payload.edit,
          coverCrop: job.payload.coverCrop,
          variants: job.payload.variants,
          source: {
            kind: "legacy_user_media",
            legacyMediaId: mediaId,
            byteSize: png.length,
            contentType: "image/png",
          },
        });
        expect(
          Buffer.from(
            (await adapter.readLegacyMediaBytes(job.subject_id)) ?? [],
          ),
        ).toEqual(png);
      }
      expect(
        await adapter.readProcessing({
          kind: "process_item",
          subjectId: firstItem.itemId!,
          payload: null,
        }),
      ).toBeNull();
      expect(await adapter.readLegacyMediaBytes(id("media-item"))).toBeNull();
      const uploaded = await mediaItem(a);
      expect(await adapter.readLegacyMediaBytes(uploaded.itemId)).toBeNull();
      for (const job of legacyJobs) {
        const recorded = await adapter.recordDerivatives(
          job.subject_id,
          {
            status: "derived",
            derivatives: job.payload.variants.map((variant) => {
              const digest = hex();
              return {
                variant,
                editKey: job.payload.editKey,
                contentType: "image/webp" as const,
                width: 60,
                height: 50,
                durationMs: null,
                storageKey: `blobs/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}`,
                byteSize: 512,
                sha256: digest + digest,
              };
            }),
          },
          editedAt,
        );
        expect(recorded).toEqual({ status: "recorded" });
      }
      const derivedEdit = confirmed(await editWork(a, work, edited, editedAt));
      // Others see the edited PNG through derivatives and the unedited one
      // through user media; the card cover honors the cover crop key.
      expect((await authors.readWork(work, b)).media).toEqual([
        {
          id: second,
          src: `/api/community/media/${second}`,
          width: 50,
          height: 60,
        },
        {
          id: firstItem.itemId,
          src: `/api/community/publishing/media/${firstItem.itemId}/display/${rotatedKey}`,
          width: 60,
          height: 50,
          kind: "static",
        },
      ]);
      expect(await discovery.card({ type: "work", id: work }, b)).toMatchObject(
        {
          title: "旋转旧图",
          excerpt: "旧式正文",
          live: false,
          media: {
            type: "work",
            id: secondItem.itemId,
            src: `/api/community/publishing/media/${secondItem.itemId}/cover/${croppedKey}`,
            width: 60,
            height: 50,
          },
        },
      );
      // Work reads name the same cropped legacy cover as the card.
      for (const viewer of [a, b, null])
        expect((await authors.readWork(work, viewer)).coverSrc).toBe(
          `/api/community/publishing/media/${secondItem.itemId}/cover/${croppedKey}`,
        );
      expect(
        await adapter.resolveMediaRead(
          b,
          firstItem.itemId!,
          "display",
          rotatedKey,
        ),
      ).not.toBeNull();
      expect(
        await adapter.resolveMediaRead(
          null,
          secondItem.itemId!,
          "cover",
          croppedKey,
        ),
      ).not.toBeNull();
      // The rotated PNG is no longer public under its user media id (its
      // uncut bytes were public before the edit); only its owner reads it.
      // A cover crop alone keeps the PNG the work itself shows.
      for (const viewer of [b, null])
        expect(await authors.readMedia(first, viewer)).toBeNull();
      expect(await authors.readMedia(first, a)).not.toBeNull();
      expect(await authors.readMedia(second, b)).not.toBeNull();
      expect((await revisionRow(derivedEdit.revisionId)).title).toBe(
        "旋转旧图",
      );

      await adapter.setVisibility(
        a,
        work,
        { requestId: randomUUID(), visibility: "self" },
        at("2026-07-12T10:00:00.000Z"),
      );
      for (const viewer of [b, null])
        expect(await authors.readMedia(first, viewer)).toBeNull();
      expect(await authors.readMedia(first, a)).not.toBeNull();

      const deleted = id("work");
      await pool.query(
        "INSERT INTO community.works(id,author_id,title,text,first_published_at,deleted_at) VALUES($1,$2,'已删除','','2026-01-01T00:00:00Z','2026-01-02T00:00:00Z')",
        [deleted, a],
      );
      expect((await workRow(deleted)).public_revision_id).toBeNull();
      const foreignMedia = id("user-media");
      await pool.query(
        "INSERT INTO community.user_media(id,owner_id,mime_type,width,height,sha256,bytes) VALUES($1,$2,'image/png',1,1,$3,$4)",
        [foreignMedia, b, "c".repeat(64), png],
      );
      const foreignWork = id("work");
      await expect(
        pool.query(
          "INSERT INTO community.works(id,author_id,title,text,media_ids,first_published_at) VALUES($1,$2,'他人媒体','',$3,'2026-01-01T00:00:00Z')",
          [foreignWork, a, [foreignMedia]],
        ),
      ).rejects.toThrow(/not owned by the work author/u);
      expect(
        await count("SELECT count(*) AS n FROM community.works WHERE id=$1", [
          foreignWork,
        ]),
      ).toBe(0);

      // A legacy item purged with its earlier work is revived (ready, stale
      // derivative rows gone) when a new direct insert names its PNG again.
      const reused = id("user-media");
      await pool.query(
        "INSERT INTO community.user_media(id,owner_id,mime_type,width,height,sha256,bytes) VALUES($1,$2,'image/png',20,10,$3,$4)",
        [reused, a, "d".repeat(64), png],
      );
      const earlier = id("work");
      await pool.query(
        "INSERT INTO community.works(id,author_id,title,text,media_ids,first_published_at) VALUES($1,$2,'早先作品','',$3,'2026-01-03T00:00:00Z')",
        [earlier, a, [reused]],
      );
      const reusedItem = (
        await pool.query<{ id: string }>(
          "SELECT 'media-item-'||md5('legacy-media:'||$1::text) AS id",
          [reused],
        )
      ).rows[0]!.id;
      const stale = await blob(a, "derivative", "image/webp");
      await pool.query(
        "INSERT INTO community.media_derivatives(item_id,variant,edit_key,blob_id,width,height,content_type) VALUES($1,'display',$2,$3,20,10,'image/webp')",
        [reusedItem, rotatedKey, stale.blobId],
      );
      const kept = await blob(a, "derivative", "image/webp");
      await pool.query(
        "INSERT INTO community.media_derivatives(item_id,variant,edit_key,blob_id,width,height,content_type) VALUES($1,'thumb',$2,$3,20,10,'image/webp')",
        [reusedItem, rotatedKey, kept.blobId],
      );
      // What the retention purge and purge_item leave behind.
      await pool.query(
        "UPDATE community.works SET trashed_at='2026-02-01T00:00:00Z',trash_purge_after='2026-03-03T00:00:00Z',deleted_at='2026-03-03T00:00:00Z' WHERE id=$1",
        [earlier],
      );
      await pool.query(
        "DELETE FROM community.media_item_refs WHERE item_id=$1",
        [reusedItem],
      );
      await pool.query(
        "UPDATE community.media_items SET state='purged',purged_at='2026-03-11T00:00:00Z',updated_at='2026-03-11T00:00:00Z' WHERE id=$1",
        [reusedItem],
      );
      await pool.query(
        "UPDATE community.media_blobs SET state='tombstoned',tombstoned_at='2026-03-11T00:00:00Z' WHERE id=$1",
        [stale.blobId],
      );
      const again = id("work");
      await pool.query(
        "INSERT INTO community.works(id,author_id,title,text,media_ids,first_published_at) VALUES($1,$2,'再次使用','',$3,'2026-03-20T00:00:00Z')",
        [again, a, [reused]],
      );
      expect(
        (
          await pool.query(
            "SELECT state,purged_at,cancelled_at FROM community.media_items WHERE id=$1",
            [reusedItem],
          )
        ).rows,
      ).toEqual([{ state: "ready", purged_at: null, cancelled_at: null }]);
      expect(
        (
          await pool.query(
            "SELECT variant FROM community.media_derivatives WHERE item_id=$1 ORDER BY variant",
            [reusedItem],
          )
        ).rows,
      ).toEqual([{ variant: "thumb" }]);
      expect(
        (
          await pool.query(
            "SELECT holder_kind,holder_id FROM community.media_item_refs WHERE item_id=$1",
            [reusedItem],
          )
        ).rows,
      ).toEqual([
        {
          holder_kind: "revision",
          holder_id: (await workRow(again)).public_revision_id,
        },
      ]);
      expect((await authors.readWork(again, b)).media).toEqual([
        {
          id: reused,
          src: `/api/community/media/${reused}`,
          width: 20,
          height: 10,
        },
      ]);
      expect(await authors.readMedia(reused, b)).not.toBeNull();
    });

    it("gives a concurrent discard and submit of one session exactly one outcome", async () => {
      const now = at("2026-07-13T08:00:00.000Z");
      let outcomes = 0;
      for (let round = 0; round < 8; round += 1) {
        const { itemId } = await mediaItem(a);
        const sessionId = await holdSession(a, null, [itemId]);
        const [submitted, discarded] = await Promise.allSettled([
          adapter.submit(
            a,
            command(
              { sessionId },
              { title: `竞争 ${round}`, items: [entry(itemId)] },
            ),
            now,
          ),
          adapter.discardSession(
            a,
            sessionId,
            { requestId: randomUUID() },
            now,
          ),
        ]);
        const state = (
          await pool.query<{ state: string }>(
            "SELECT state FROM community.publishing_sessions WHERE id=$1",
            [sessionId],
          )
        ).rows[0]!.state;
        const revisions = await count(
          "SELECT count(*) AS n FROM community.work_revision_items WHERE item_id=$1",
          [itemId],
        );
        if (submitted.status === "fulfilled") {
          expect(submitted.value.state).toBe("confirmed");
          expect(discarded.status).toBe("rejected");
          expect((discarded as PromiseRejectedResult).reason).toBeInstanceOf(
            CommunityConflictError,
          );
          expect([state, revisions]).toEqual(["submitted", 1]);
        } else {
          expect(submitted.reason).toBeInstanceOf(CommunityConflictError);
          expect(discarded.status).toBe("fulfilled");
          expect([state, revisions]).toEqual(["discarded", 0]);
        }
        outcomes += 1;
        await expectRejection(
          adapter.submit(
            a,
            command({ sessionId }, { title: `迟到 ${round}` }),
            now,
          ),
          CommunityConflictError,
        );
      }
      expect(outcomes).toBe(8);
    });

    it("gives discard and submit of one session exactly one outcome in both forced orders", async () => {
      const now = at("2026-07-13T09:00:00.000Z");
      /** The pid of a backend waiting on one of `blockers`, other than `exclude`. */
      const waiter = async (
        blockers: readonly number[],
        exclude: readonly number[],
      ): Promise<number> => {
        for (let attempt = 0; attempt < 500; attempt += 1) {
          const found = (
            await pool.query<{ pid: number }>(
              "SELECT pid FROM pg_stat_activity WHERE pg_blocking_pids(pid) && $1::integer[] AND NOT pid=ANY($2::integer[]) LIMIT 1",
              [blockers, exclude],
            )
          ).rows[0];
          if (found !== undefined) return found.pid;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error("the command did not queue behind the actor lock");
      };
      for (const first of ["submit", "discard"] as const) {
        const { itemId } = await mediaItem(a);
        const sessionId = await holdSession(a, null, [itemId]);
        const submitting = () =>
          adapter.submit(
            a,
            command(
              { sessionId },
              { title: `顺序 ${first}`, items: [entry(itemId)] },
            ),
            now,
          );
        const discarding = () =>
          adapter.discardSession(
            a,
            sessionId,
            { requestId: randomUUID() },
            now,
          );
        // Both commands queue behind a held actor lock in a known order.
        const blocker = await pool.connect();
        let outcomes: [
          PromiseSettledResult<unknown>,
          PromiseSettledResult<unknown>,
        ];
        try {
          await blocker.query("BEGIN");
          await blocker.query(
            "SELECT id FROM community.public_users WHERE id=$1 FOR NO KEY UPDATE",
            [a],
          );
          const blockerPid = (
            await blocker.query<{ pid: number }>(
              "SELECT pg_backend_pid() AS pid",
            )
          ).rows[0]!.pid;
          const one = (first === "submit" ? submitting : discarding)();
          const onePid = await waiter([blockerPid], [blockerPid]);
          const two = (first === "submit" ? discarding : submitting)();
          await waiter([blockerPid, onePid], [blockerPid, onePid]);
          await blocker.query("COMMIT");
          outcomes = await Promise.all([
            Promise.allSettled([one]).then(([result]) => result!),
            Promise.allSettled([two]).then(([result]) => result!),
          ]);
        } finally {
          blocker.release();
        }
        const [winner, loser] = outcomes;
        expect(winner.status).toBe("fulfilled");
        expect(loser.status).toBe("rejected");
        expect((loser as PromiseRejectedResult).reason).toBeInstanceOf(
          CommunityConflictError,
        );
        expect(
          (
            await pool.query<{ state: string }>(
              "SELECT state FROM community.publishing_sessions WHERE id=$1",
              [sessionId],
            )
          ).rows[0]!.state,
        ).toBe(first === "submit" ? "submitted" : "discarded");
        expect(
          await count(
            "SELECT count(*) AS n FROM community.work_revision_items WHERE item_id=$1",
            [itemId],
          ),
        ).toBe(first === "submit" ? 1 : 0);
        expect(
          (
            await pool.query<{ state: string }>(
              "SELECT state FROM community.media_items WHERE id=$1",
              [itemId],
            )
          ).rows[0]!.state,
        ).toBe(first === "submit" ? "ready" : "cancelled");
      }
    });

    it("keeps other saved draft content as a pinned conflict snapshot on submission, reachable from the work history", async () => {
      const now = at("2026-07-15T08:00:00.000Z");
      const kept = await mediaItem(a);
      const other = await mediaItem(a);
      const setDraftContent = (
        draftId: string,
        content: WorkSubmissionContent,
      ) =>
        pool.query(
          "UPDATE community.work_drafts SET content=$2::jsonb,content_sha256=encode(sha256(convert_to($2::jsonb::text,'UTF8')),'hex') WHERE id=$1",
          [draftId, JSON.stringify(content)],
        );
      const snapshots = async (draftId: string) =>
        (
          await pool.query<{ kind: string; pinned: boolean; title: string }>(
            "SELECT kind,pinned,content->>'title' AS title FROM community.work_draft_snapshots WHERE draft_id=$1 ORDER BY kind",
            [draftId],
          )
        ).rows;

      // The saved content, only in its un-normalized form, was submitted.
      const same = await holdDraft(a, null, null, [kept.itemId]);
      await setDraftContent(
        same,
        contentOf({
          title: "  同一内容 ",
          body: "第一行\r\n第二行",
          authorship: { kind: "copy_practice", referenceTitle: " " },
          items: [entry(kept.itemId)],
        }),
      );
      const sameWork = confirmed(
        await adapter.submit(
          a,
          command(
            { draftId: same },
            {
              title: "同一内容",
              body: "第一行\n第二行",
              authorship: { kind: "copy_practice" },
              items: [entry(kept.itemId)],
            },
          ),
          now,
        ),
      );
      expect(await snapshots(same)).toEqual([
        { kind: "submitted", pinned: false, title: "同一内容" },
      ]);

      // Another device saved newer content the submitting device never saw.
      const changed = await holdDraft(a, null, null, [
        kept.itemId,
        other.itemId,
      ]);
      await setDraftContent(
        changed,
        contentOf({
          title: "另一台设备的内容",
          items: [entry(kept.itemId), entry(other.itemId)],
        }),
      );
      const work = confirmed(
        await adapter.submit(
          a,
          command(
            { draftId: changed },
            { title: "本机提交", items: [entry(kept.itemId)] },
          ),
          now,
        ),
      );
      expect(await snapshots(changed)).toEqual([
        { kind: "conflict", pinned: true, title: "另一台设备的内容" },
        { kind: "submitted", pinned: false, title: "本机提交" },
      ]);
      expect(
        (
          await pool.query(
            "SELECT DISTINCT holder_kind FROM community.media_item_refs WHERE item_id=$1 ORDER BY holder_kind",
            [other.itemId],
          )
        ).rows,
      ).toEqual([{ holder_kind: "snapshot" }]);
      expect(
        await count(
          "SELECT count(*) AS n FROM community.media_item_refs WHERE holder_kind='draft' AND holder_id=ANY($1::text[])",
          [[same, changed]],
        ),
      ).toBe(0);
      const { draft: editDraft } = await adapter.openEditDraft(
        a,
        work.workId,
        { requestId: randomUUID(), deviceClass: null },
        now,
      );
      expect(
        (
          await adapter.listHistory(a, editDraft.id, { page: 1, pageSize: 20 })
        ).items.map((item) => [item.kind, item.pinned, item.content.title]),
      ).toEqual(
        expect.arrayContaining([
          ["conflict", true, "另一台设备的内容"],
          ["submitted", false, "本机提交"],
        ]),
      );
      expect(sameWork.workId).not.toBe(work.workId);
    });

    it("cancels the items a submitted session holds but the work does not keep", async () => {
      const now = at("2026-07-15T09:00:00.000Z");
      const kept = await mediaItem(a);
      const uploading = await mediaItem(a, { state: "processing" });
      await pool.query(
        "UPDATE community.media_items SET state='awaiting_upload' WHERE id=$1",
        [uploading.itemId],
      );
      const component = (
        await pool.query<{ id: string }>(
          "UPDATE community.media_components SET state='receiving',upload_attempt=$2,blob_id=NULL,received_bytes=0,sha256=NULL,updated_at=$3 WHERE item_id=$1 RETURNING id",
          [uploading.itemId, randomUUID(), now],
        )
      ).rows[0]!.id;
      const drafted = await mediaItem(a);
      await holdDraft(a, null, null, [drafted.itemId]);
      const sessionId = await holdSession(a, null, [
        kept.itemId,
        uploading.itemId,
        drafted.itemId,
      ]);
      confirmed(
        await adapter.submit(
          a,
          command(
            { sessionId },
            { title: "只保留一张", items: [entry(kept.itemId)] },
          ),
          now,
        ),
      );
      expect(
        (
          await pool.query(
            "SELECT id,state FROM community.media_items WHERE id=ANY($1::text[]) ORDER BY array_position($1::text[],id)",
            [[kept.itemId, uploading.itemId, drafted.itemId]],
          )
        ).rows,
      ).toEqual([
        { id: kept.itemId, state: "ready" },
        { id: uploading.itemId, state: "cancelled" },
        { id: drafted.itemId, state: "ready" },
      ]);
      expect(
        (
          await pool.query(
            "SELECT state,upload_attempt FROM community.media_components WHERE id=$1",
            [component],
          )
        ).rows,
      ).toEqual([{ state: "cancelled", upload_attempt: null }]);
      expect(
        (
          await pool.query(
            "SELECT subject_id FROM community.publishing_jobs WHERE kind='purge_item' AND subject_id=ANY($1::text[])",
            [[kept.itemId, uploading.itemId, drafted.itemId]],
          )
        ).rows,
      ).toEqual([{ subject_id: uploading.itemId }]);
      expect(
        await count(
          "SELECT count(*) AS n FROM community.media_item_refs WHERE holder_kind='session' AND holder_id=$1",
          [sessionId],
        ),
      ).toBe(0);
    });

    it("submits a session under the expiry rule: an unlapsed lease or a transfer still progressing", async () => {
      const now = at("2026-07-15T10:00:00.000Z");
      const lease = (sessionId: string, expires: Date) =>
        pool.query(
          "UPDATE community.publishing_sessions SET lease_expires_at=$2 WHERE id=$1",
          [sessionId, expires],
        );
      const atLease = await holdSession(a);
      await lease(atLease, now);
      confirmed(
        await adapter.submit(
          a,
          command({ sessionId: atLease }, { title: "租约恰好到期" }),
          now,
        ),
      );

      const lapsed = await holdSession(a);
      await lease(lapsed, at("2026-07-15T09:59:59.999Z"));
      await expectRejection(
        adapter.submit(
          a,
          command({ sessionId: lapsed }, { title: "租约已过期" }),
          now,
        ),
        CommunityConflictError,
      );
      expect(await adapter.expireSession(lapsed, now)).toMatchObject({
        status: "expired",
      });

      const { itemId } = await mediaItem(a);
      const streaming = await mediaItem(a, { state: "processing" });
      await pool.query(
        "UPDATE community.media_components SET state='receiving',upload_attempt=$2,blob_id=NULL,updated_at=$3 WHERE item_id=$1",
        [streaming.itemId, randomUUID(), at("2026-07-15T09:00:00.000Z")],
      );
      const protectedSession = await holdSession(a, null, [
        itemId,
        streaming.itemId,
      ]);
      await lease(protectedSession, at("2026-07-15T09:30:00.000Z"));
      expect(await adapter.expireSession(protectedSession, now)).toMatchObject({
        status: "active",
      });
      confirmed(
        await adapter.submit(
          a,
          command(
            { sessionId: protectedSession },
            { title: "传输仍在进行", items: [entry(itemId)] },
          ),
          now,
        ),
      );
    });

    it("never re-exposes an older public revision replaced while self-only, and makes a rejected revision public again only under the current policy", async () => {
      const t0 = at("2026-07-16T08:00:00.000Z");
      const { itemId } = await mediaItem(a);
      const firstPublic = await publish(
        a,
        { title: "带图的公开版本", items: [entry(itemId)] },
        t0,
      );
      await setPolicy("PRE_MODERATION");
      const pendingPublic = confirmed(
        await editWork(a, firstPublic.workId, { title: "待审的修改" }, t0),
      );
      const privateEdit = confirmed(
        await editWork(
          a,
          firstPublic.workId,
          { title: "私密期间删掉了图片", visibility: "self" },
          at("2026-07-16T09:00:00.000Z"),
        ),
      );
      // A self-only submission withdraws the pending public intent.
      expect((await revisionRow(pendingPublic.revisionId)).disposition).toBe(
        "withdrawn",
      );
      await adapter.setVisibility(
        a,
        firstPublic.workId,
        { requestId: randomUUID(), visibility: "public" },
        at("2026-07-16T10:00:00.000Z"),
      );
      expect(await revisionRow(privateEdit.revisionId)).toMatchObject({
        disposition: "pending",
      });
      expect(await workRow(firstPublic.workId)).toMatchObject({
        visibility: "public",
        public_revision_id: null,
        first_published_at: t0,
        title: "",
      });
      await expectRejection(
        authors.readWork(firstPublic.workId, b),
        CommunityNotFoundError,
      );
      expect(
        await adapter.resolveMediaRead(b, itemId, "display", "base"),
      ).toBeNull();
      expect(await authors.readWork(firstPublic.workId, a)).toMatchObject({
        title: "私密期间删掉了图片",
        visibility: "public",
      });
      const approvedAt = at("2026-07-16T11:00:00.000Z");
      await operators.moderateSubmission(
        privateEdit.revisionId,
        operator,
        {
          requestId: randomUUID(),
          action: "approve",
          expectedVersion: (await revisionRow(privateEdit.revisionId)).version,
        },
        approvedAt,
      );
      expect(await workRow(firstPublic.workId)).toMatchObject({
        public_revision_id: privateEdit.revisionId,
        first_published_at: t0,
        edited_at: approvedAt,
        title: "私密期间删掉了图片",
      });
      expect((await authors.readWork(firstPublic.workId, b)).media).toEqual([]);

      // A public submission on a self-only work follows current policy even
      // when its content matches an earlier approved revision (Owner r2).
      await setPolicy("DIRECT_PUBLICATION");
      const unchanged = await publish(a, { title: "内容未变" }, t0);
      const replaced = await publish(a, { title: "内容已变" }, t0);
      for (const workId of [unchanged.workId, replaced.workId])
        confirmed(
          await editWork(
            a,
            workId,
            { title: "内容已变", visibility: "self" },
            t0,
          ),
        );
      await setPolicy("PRE_MODERATION");
      confirmed(await editWork(a, unchanged.workId, { title: "内容未变" }, t0));
      confirmed(
        await editWork(a, replaced.workId, { title: "内容再次改变" }, t0),
      );
      await expectRejection(
        authors.readWork(unchanged.workId, b),
        CommunityNotFoundError,
      );
      expect((await workRow(unchanged.workId)).public_revision_id).toBeNull();
      await expectRejection(
        authors.readWork(replaced.workId, b),
        CommunityNotFoundError,
      );

      // A rejected latest revision: re-queued under pre-moderation, public
      // under direct publication.
      const rejectedAt = at("2026-07-16T12:00:00.000Z");
      const rejectedWorks: string[] = [];
      for (const title of ["再次送审", "直接公开"]) {
        const held = await publish(a, { title }, rejectedAt);
        await operators.moderateSubmission(
          held.revisionId,
          operator,
          { requestId: randomUUID(), action: "reject", expectedVersion: 1 },
          rejectedAt,
        );
        await adapter.setVisibility(
          a,
          held.workId,
          { requestId: randomUUID(), visibility: "self" },
          rejectedAt,
        );
        rejectedWorks.push(held.revisionId, held.workId);
      }
      const [requeuedRevision, requeuedWork, directRevision, directWork] =
        rejectedWorks as [string, string, string, string];
      await adapter.setVisibility(
        a,
        requeuedWork,
        { requestId: randomUUID(), visibility: "public" },
        rejectedAt,
      );
      expect(await revisionRow(requeuedRevision)).toMatchObject({
        disposition: "pending",
        version: 3,
      });
      expect(
        (
          await operators.listSubmissions({
            state: "pending",
            page: 1,
            pageSize: 50,
          })
        ).items.map((item) => item.revisionId),
      ).toContain(requeuedRevision);
      await expectRejection(
        authors.readWork(requeuedWork, b),
        CommunityNotFoundError,
      );
      await setPolicy("DIRECT_PUBLICATION");
      const publicAt = at("2026-07-16T13:00:00.000Z");
      await adapter.setVisibility(
        a,
        directWork,
        { requestId: randomUUID(), visibility: "public" },
        publicAt,
      );
      expect((await revisionRow(directRevision)).disposition).toBe("approved");
      expect(await workRow(directWork)).toMatchObject({
        visibility: "public",
        public_revision_id: directRevision,
        first_published_at: publicAt,
      });
      expect((await authors.readWork(directWork, b)).title).toBe("直接公开");
    });

    it("lists never-public works by first submission in Admin and searches only content requested for public view", async () => {
      const handle = (
        await pool.query<{ handle: string }>(
          "SELECT handle FROM community.public_users WHERE id=$1",
          [a],
        )
      ).rows[0]!.handle;
      const older = await publish(
        a,
        { title: "早已公开" },
        at("2026-07-17T08:00:00.000Z"),
      );
      await setPolicy("PRE_MODERATION");
      const pending = await publish(
        a,
        { title: "等待审核的标题" },
        at("2026-07-17T09:00:00.000Z"),
      );
      const self = await publish(
        a,
        { title: "只给自己看的标题", visibility: "self" },
        at("2026-07-17T10:00:00.000Z"),
      );
      const page = await contentOperator.readWorks({
        page: 1,
        pageSize: 20,
        search: handle,
      });
      expect(page.items.map((work) => work.id)).toEqual([
        self.workId,
        pending.workId,
        older.workId,
      ]);
      expect(page.items[0]).toMatchObject({
        latestSubmission: null,
        publicRevisionId: null,
        publiclyVisible: false,
      });
      expect(page.items[1]).toMatchObject({
        latestSubmission: {
          revisionId: pending.revisionId,
          title: "等待审核的标题",
          disposition: "pending",
        },
        publicRevisionId: null,
        publiclyVisible: false,
      });
      expect(page.items[2]).toMatchObject({
        latestSubmission: {
          revisionId: older.revisionId,
          title: "早已公开",
          disposition: "approved",
        },
        publicRevisionId: older.revisionId,
        publiclyVisible: true,
      });
      expect(JSON.stringify(page)).not.toContain("只给自己看的标题");
      expect(
        (
          await contentOperator.readWorks({
            page: 1,
            pageSize: 20,
            search: "等待审核的标题",
          })
        ).items.map((work) => work.id),
      ).toEqual([pending.workId]);
      expect(
        await contentOperator.readWorks({
          page: 1,
          pageSize: 20,
          search: "只给自己看的标题",
        }),
      ).toMatchObject({ items: [], total: 0 });
    });

    it("sets versioned settings and account capacity with audit, and retries or abandons content-free jobs", async () => {
      const now = at("2026-07-14T08:00:00.000Z");
      const settings = await operators.readSettings();
      expect(settings).toMatchObject({
        policy: "DIRECT_PUBLICATION",
        maxItemsPerWork: 50,
        dailyNewWorkLimit: 100,
        version: 1,
        updatedBy: "platform",
      });
      const { version, updatedAt, updatedBy, ...limits } = settings;
      void [updatedAt, updatedBy];
      const change = {
        ...limits,
        policy: "PRE_MODERATION" as const,
        historyLimit: 25,
        requestId: randomUUID(),
        expectedVersion: version,
      };
      const saved = await operators.setSettings(operator, change, now);
      expect(saved).toMatchObject({
        policy: "PRE_MODERATION",
        historyLimit: 25,
        version: 2,
        updatedBy: operator,
        updatedAt: now.toISOString(),
      });
      expect(await operators.setSettings(operator, change, now)).toEqual(saved);
      await expectRejection(
        operators.setSettings(
          operator,
          { ...change, requestId: randomUUID() },
          now,
        ),
        CommunityConflictError,
      );
      const held = await publish(a, { title: "设置之后" }, now);
      expect((await revisionRow(held.revisionId)).disposition).toBe("pending");

      expect(await operators.readCapacity(a)).toEqual({
        accountId: a,
        capacityClass: "ordinary",
        capacityBytes: 10737418240,
        committedBytes: 0,
        reservedBytes: 0,
        version: 0,
        updatedAt: null,
      });
      const owner = await operators.setCapacity(
        a,
        operator,
        { requestId: randomUUID(), capacityClass: "owner", expectedVersion: 0 },
        now,
      );
      expect(owner).toEqual({
        accountId: a,
        capacityClass: "owner",
        capacityBytes: 21474836480,
        committedBytes: 0,
        reservedBytes: 0,
        version: 1,
        updatedAt: now.toISOString(),
      });
      expect(await adapter.readCapacity(a)).toEqual(owner);
      await expectRejection(
        operators.setCapacity(
          a,
          operator,
          {
            requestId: randomUUID(),
            capacityClass: "ordinary",
            expectedVersion: 0,
          },
          now,
        ),
        CommunityConflictError,
      );
      await expectRejection(
        operators.setCapacity(
          id("user"),
          operator,
          {
            requestId: randomUUID(),
            capacityClass: "owner",
            expectedVersion: 0,
          },
          now,
        ),
        CommunityNotFoundError,
      );
      expect(
        (
          await pool.query(
            "SELECT action,content_type,content_id FROM community.content_operator_events WHERE operator_label=$1 ORDER BY action",
            [operator],
          )
        ).rows,
      ).toEqual([
        {
          action: "publishing.capacity.set",
          content_type: "account",
          content_id: a,
        },
        {
          action: "publishing.settings.set",
          content_type: "work_publishing_settings",
          content_id: "settings",
        },
      ]);

      const { itemId } = await mediaItem(a);
      const failed = id("publishing-job");
      const running = id("publishing-job");
      await pool.query(
        `INSERT INTO community.publishing_jobs(id,kind,subject_id,payload,state,attempts,max_attempts,run_after,last_error_code,lease_owner,lease_expires_at,created_at,updated_at,finished_at)
        VALUES($1,'derive_edit',$3,'{"editKey":"base"}','failed',5,5,$4,'processing_failed',NULL,NULL,$4,$4,$4),
          ($2,'purge_item',$3,NULL,'running',1,5,$4,NULL,'worker-1',$5,$4,$4,NULL)`,
        [
          failed,
          running,
          itemId,
          "2026-07-14T07:00:00Z",
          "2026-07-14T09:00:00Z",
        ],
      );
      const page = await operators.listJobs({
        state: "failed",
        kind: "derive_edit",
        page: 1,
        pageSize: 50,
      });
      expect(page.items.find((job) => job.id === failed)).toEqual({
        id: failed,
        kind: "derive_edit",
        subjectId: itemId,
        state: "failed",
        attempts: 5,
        maxAttempts: 5,
        runAfter: "2026-07-14T07:00:00.000Z",
        leaseExpiresAt: null,
        lastErrorCode: "processing_failed",
        createdAt: "2026-07-14T07:00:00.000Z",
        updatedAt: "2026-07-14T07:00:00.000Z",
        finishedAt: "2026-07-14T07:00:00.000Z",
      });
      expect(JSON.stringify(page)).not.toMatch(/editKey|worker-1|payload/u);
      const retryRequest = { requestId: randomUUID() };
      const retried = await operators.retryJob(
        failed,
        operator,
        retryRequest,
        now,
      );
      expect(retried).toMatchObject({
        state: "queued",
        attempts: 0,
        runAfter: now.toISOString(),
        lastErrorCode: null,
        finishedAt: null,
      });
      expect(
        await operators.retryJob(failed, operator, retryRequest, now),
      ).toEqual(retried);
      await expectRejection(
        operators.retryJob(failed, operator, { requestId: randomUUID() }, now),
        CommunityConflictError,
      );
      await expectRejection(
        operators.abandonJob(
          running,
          operator,
          { requestId: randomUUID() },
          now,
        ),
        CommunityConflictError,
      );
      expect(
        await operators.abandonJob(
          failed,
          operator,
          { requestId: randomUUID() },
          now,
        ),
      ).toMatchObject({ state: "abandoned", finishedAt: now.toISOString() });
      await expectRejection(
        operators.abandonJob(
          id("publishing-job"),
          operator,
          { requestId: randomUUID() },
          now,
        ),
        CommunityNotFoundError,
      );
    });

    it("names the cover of each viewer's revision and tells only the author whether the work is public now", async () => {
      const now = at("2026-07-22T08:00:00.000Z");
      const [first, second, third, fourth, fifth] = await Promise.all(
        Array.from({ length: 5 }, () => mediaItem(a)),
      );
      const entries = [first!, second!, third!].map((item) =>
        entry(item.itemId),
      );
      const [e1, e2, e3] = entries as [
        ReturnType<typeof entry>,
        ReturnType<typeof entry>,
        ReturnType<typeof entry>,
      ];
      const album = await publish(
        a,
        { title: "封面", items: [e1, e2, e3], coverKey: e2.key },
        now,
      );
      const coverSrc = (itemId: string) =>
        `/api/community/publishing/media/${itemId}/cover/base`;
      for (const viewer of [b, null]) {
        const read = await authors.readWork(album.workId, viewer);
        expect(read.coverMediaId).toBe(second!.itemId);
        expect(read.coverSrc).toBe(coverSrc(second!.itemId));
        expect(read).not.toHaveProperty("publiclyVisible");
        expect(read).not.toHaveProperty("visibility");
      }
      expect(await authors.readWork(album.workId, a)).toMatchObject({
        coverMediaId: second!.itemId,
        visibility: "public",
        publiclyVisible: true,
      });

      // An edit awaiting approval: others keep the public revision's cover,
      // the author sees the latest revision's cover.
      await setPolicy("PRE_MODERATION");
      const pending = confirmed(
        await editWork(
          a,
          album.workId,
          { title: "新封面", items: [e3, e1], coverKey: e3.key },
          now,
        ),
      );
      expect(await revisionRow(pending.revisionId)).toMatchObject({
        disposition: "pending",
      });
      expect(await authors.readWork(album.workId, b)).toMatchObject({
        coverMediaId: second!.itemId,
        coverSrc: coverSrc(second!.itemId),
      });
      expect(await authors.readWork(album.workId, a)).toMatchObject({
        media: [{ id: third!.itemId }, { id: first!.itemId }],
        coverMediaId: third!.itemId,
        coverSrc: coverSrc(third!.itemId),
        publiclyVisible: true,
      });
      // Lists read the same revision as the single read.
      expect(
        (await authors.listWorks(a, b, listQuery)).items.find(
          (item) => item.id === album.workId,
        )?.coverSrc,
      ).toBe(coverSrc(second!.itemId));
      expect(
        (await authors.listWorks(a, a, listQuery)).items.find(
          (item) => item.id === album.workId,
        )?.coverSrc,
      ).toBe(coverSrc(third!.itemId));
      await setPolicy("DIRECT_PUBLICATION");

      // No chosen cover: the first entry; no media: none.
      const uncovered = await publish(
        a,
        {
          title: "无封面",
          items: [entry(fourth!.itemId), entry(fifth!.itemId)],
        },
        now,
      );
      expect(await authors.readWork(uncovered.workId, b)).toMatchObject({
        coverMediaId: fourth!.itemId,
        coverSrc: coverSrc(fourth!.itemId),
      });
      const textOnly = await publish(a, { body: "只有文字" }, now);
      expect(await authors.readWork(textOnly.workId, a)).toMatchObject({
        media: [],
        coverMediaId: null,
        coverSrc: null,
        publiclyVisible: true,
      });

      // A legacy work names no cover: its first Phase 4 PNG.
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      const [legacyFirst, legacySecond] = [id("user-media"), id("user-media")];
      await pool.query(
        "INSERT INTO community.user_media(id,owner_id,mime_type,width,height,sha256,bytes) VALUES($1,$3,'image/png',30,40,$4,$5),($2,$3,'image/png',50,60,$4,$5)",
        [legacyFirst, legacySecond, a, "c".repeat(64), png],
      );
      const legacy = id("work");
      await pool.query(
        "INSERT INTO community.works(id,author_id,title,text,media_ids,first_published_at,synthetic_provenance) VALUES($1,$2,'旧式封面','',$3,'2026-01-05T00:00:00Z','work-publishing-bridge-test')",
        [legacy, a, [legacySecond, legacyFirst]],
      );
      expect(await authors.readWork(legacy, b)).toMatchObject({
        coverMediaId: legacySecond,
        coverSrc: `/api/community/media/${legacySecond}`,
      });
      expect(await authors.readWork(legacy, a)).toMatchObject({
        coverMediaId: legacySecond,
        coverSrc: `/api/community/media/${legacySecond}`,
        publiclyVisible: true,
      });

      // Not public to third parties right now: self-only, operator-hidden
      // and a first submission awaiting approval.
      await adapter.setVisibility(
        a,
        uncovered.workId,
        { requestId: randomUUID(), visibility: "self" },
        now,
      );
      expect(await authors.readWork(uncovered.workId, a)).toMatchObject({
        visibility: "self",
        publiclyVisible: false,
        coverMediaId: fourth!.itemId,
      });
      await contentOperator.moderateWork(textOnly.workId, operator, {
        requestId: randomUUID(),
        state: "hidden",
        expectedVersion: (await authors.readWork(textOnly.workId, a)).version,
      });
      expect(await authors.readWork(textOnly.workId, a)).toMatchObject({
        visibility: "public",
        publiclyVisible: false,
      });
      await setPolicy("PRE_MODERATION");
      const pendingFirst = await publish(a, { title: "首次待审" }, now);
      expect(await authors.readWork(pendingFirst.workId, a)).toMatchObject({
        firstPublishedAt: null,
        visibility: "public",
        publiclyVisible: false,
      });

      // Lists: the author's own list says it for every work, others never.
      const own = await authors.listWorks(a, a, listQuery);
      expect(
        Object.fromEntries(
          own.items.map((work) => [work.id, work.publiclyVisible]),
        ),
      ).toEqual({
        [album.workId]: true,
        [uncovered.workId]: false,
        [textOnly.workId]: false,
        [legacy]: true,
        [pendingFirst.workId]: false,
      });
      const visitor = await authors.listWorks(a, b, listQuery);
      expect(visitor.items.map((work) => work.id).sort()).toEqual(
        [album.workId, legacy].sort(),
      );
      for (const work of visitor.items)
        expect(work).not.toHaveProperty("publiclyVisible");
    });

    it("refuses an item maximum above 100 and enforces a larger stored maximum as 100", async () => {
      const now = at("2026-07-23T08:00:00.000Z");
      const settings = await operators.readSettings();
      const { version, updatedAt, updatedBy, ...limits } = settings;
      void [updatedAt, updatedBy];
      const change = (maxItemsPerWork: number) => ({
        ...limits,
        maxItemsPerWork,
        requestId: randomUUID(),
        expectedVersion: version,
      });
      for (const maxItemsPerWork of [101, 500, 0])
        await expectRejection(
          operators.setSettings(operator, change(maxItemsPerWork), now),
          CommunityInputError,
        );
      expect(await operators.readSettings()).toEqual(settings);
      expect(
        await count(
          "SELECT count(*) AS n FROM community.content_operator_receipts WHERE operator_label=$1",
          [operator],
        ),
      ).toBe(0);
      const accepted = change(100);
      expect(
        (await operators.setSettings(operator, accepted, now)).maxItemsPerWork,
      ).toBe(100);
      // A receipt from before the bound may hold a larger value: its replay
      // is enforced as 100 too.
      await pool.query(
        "UPDATE community.content_operator_receipts SET result=jsonb_set(result,'{maxItemsPerWork}','500') WHERE operator_label=$1 AND request_id=$2",
        [operator, accepted.requestId],
      );
      expect(
        (await operators.setSettings(operator, accepted, now)).maxItemsPerWork,
      ).toBe(100);

      // Storage alone still admits up to 500: a larger stored value (written
      // outside the operator command) is read and enforced as 100.
      await pool.query(
        "UPDATE community.work_publishing_settings SET max_items_per_work=200 WHERE id='settings'",
      );
      expect((await operators.readSettings()).maxItemsPerWork).toBe(100);
      expect((await adapter.readSettings()).maxItemsPerWork).toBe(100);
      const placeholders = (length: number) =>
        Array.from({ length }, (_, index) => ({
          key: `pending-${index}`,
          itemId: null,
          kind: "static" as const,
          qualityMode: "standard" as const,
          edit: identity,
        }));
      await expectRejection(
        adapter.submit(
          a,
          command(
            { sessionId: await holdSession(a) },
            { title: "超过上限", items: placeholders(101) },
          ),
          now,
        ),
        CommunityInputError,
        "items_limit",
      );
      expect(
        await adapter.submit(
          a,
          command(
            { sessionId: await holdSession(a) },
            { title: "上限以内", items: placeholders(100) },
          ),
          now,
        ),
      ).toMatchObject({ state: "not_ready" });
    });

    it("keeps clipboard provenance private and carries it into editable content without making submissions differ", async () => {
      const now = at("2026-07-24T08:00:00.000Z");
      const clipboardMetadata = (clientSource: string) => ({
        provenance: {
          source: "client",
          parser: "exifr@7.1.3",
          status: "absent",
          clientSource,
        },
        values: {},
      });

      // Registration: the client source is stored privately only.
      const draft = await adapter.createDraft(
        a,
        {
          requestId: randomUUID(),
          content: contentOf({ title: "粘贴的图" }),
          deviceClass: "desktop",
        },
        now,
      );
      const registered = await adapter.registerItem(
        a,
        {
          requestId: randomUUID(),
          holder: { draftId: draft.id },
          kind: "static",
          qualityMode: "standard",
          processingProfile: "standard-image-v1",
          components: [
            {
              role: "still",
              byteSize: 2048,
              contentType: "image/jpeg",
              standardOutcome: "optimized",
            },
          ],
          metadata: {
            provenance: {
              source: "client",
              parser: "exifr@7.1.3",
              status: "absent",
              clientSource: "clipboard",
            },
            values: {},
          },
        },
        now,
      );
      expect(JSON.stringify(registered)).not.toContain("clipboard");
      expect(
        (
          await pool.query<{ metadata: unknown }>(
            "SELECT private_metadata AS metadata FROM community.media_items WHERE id=$1",
            [registered.id],
          )
        ).rows[0]!.metadata,
      ).toMatchObject({ provenance: { clientSource: "clipboard" } });

      // Draft content keeps an item's origin through a save, a read and history.
      const pasted = { ...entry(registered.id), origin: "clipboard" as const };
      const saved = await adapter.snapshotDraft(
        a,
        draft.id,
        {
          baseRevision: draft.revision,
          content: contentOf({ title: "粘贴的图", items: [pasted] }),
          deviceClass: "desktop",
        },
        now,
      );
      expect(saved.status).toBe("saved");
      expect((await adapter.readDraft(a, draft.id)).content.items).toEqual([
        pasted,
      ]);
      expect(
        (await adapter.listHistory(a, draft.id, { page: 1, pageSize: 20 }))
          .items[0]?.content.items,
      ).toEqual([pasted]);

      // A published item pasted from the clipboard reopens with its origin.
      const clip = await mediaItem(a);
      const picked = await mediaItem(a);
      for (const [itemId, source] of [
        [clip.itemId, "clipboard"],
        [picked.itemId, "picker"],
      ] as const)
        await pool.query(
          "UPDATE community.media_items SET private_metadata=$2::jsonb WHERE id=$1",
          [itemId, JSON.stringify(clipboardMetadata(source))],
        );
      const work = await publish(
        a,
        {
          title: "带粘贴图",
          items: [
            { ...entry(clip.itemId), origin: "clipboard" },
            entry(picked.itemId),
          ],
        },
        now,
      );
      const editable = await adapter.readEditableWork(a, work.workId);
      expect(editable.content.items.map((item) => item.origin)).toEqual([
        "clipboard",
        undefined,
      ]);
      const { draft: editDraft } = await adapter.openEditDraft(
        a,
        work.workId,
        { requestId: randomUUID(), deviceClass: "phone" },
        now,
      );
      expect(editDraft.content.items.map((item) => item.origin)).toEqual([
        "clipboard",
        undefined,
      ]);
      // Public reads, cards and the operator view never carry it.
      expect(
        JSON.stringify(await authors.readWork(work.workId, b)),
      ).not.toMatch(/clipboard|picker|clientSource|"origin"/u);
      expect(
        JSON.stringify(await operators.readSubmission(work.revisionId)),
      ).not.toMatch(/clipboard|picker|clientSource/u);

      // Submitting the edit draft's content without origins is the same
      // content: no conflict copy is kept.
      const withoutOrigin = editDraft.content.items.map((item) => {
        const copy: Partial<typeof item> = { ...item };
        delete copy.origin;
        return copy as typeof item;
      });
      confirmed(
        await adapter.submit(
          a,
          command(
            { draftId: editDraft.id },
            { title: "带粘贴图", items: withoutOrigin },
            editable.revisionId,
          ),
          now,
        ),
      );
      expect(
        (
          await pool.query<{ kind: string }>(
            "SELECT kind FROM community.work_draft_snapshots WHERE draft_id=$1 ORDER BY kind",
            [editDraft.id],
          )
        ).rows,
      ).toEqual([{ kind: "submitted" }]);
    });

    /** The key community.media_edit_key gives an edit and optional cover crop. */
    const editKeyOf = async (edit: MediaEdit, coverCrop: MediaCrop | null) =>
      (
        await pool.query<{ key: string }>(
          "SELECT community.media_edit_key($1::jsonb,$2::jsonb) AS key",
          [
            JSON.stringify(edit),
            coverCrop === null ? null : JSON.stringify(coverCrop),
          ],
        )
      ).rows[0]!.key;

    /** The Public application service over the real adapters (work cards need no Catalog resolver). */
    const service = () =>
      new AuthorCommunityService(
        authors,
        { isPublished: async () => false } as unknown as CatalogPublicationPort,
        comments,
        discovery,
      );

    it("carries the real derivative src, excerpt and live flag on cards and shows the author their own latest revision", async () => {
      const now = at("2026-07-20T08:00:00.000Z");
      for (const account of [a, b])
        await authors.updatePrivacy(account, {
          requestId: randomUUID(),
          privacy: allPublic,
        });
      const still = await mediaItem(a);
      const live = await mediaItem(a, { kind: "live" });
      const crop: MediaCrop = { x: 0.1, y: 0.1, width: 0.5, height: 0.5 };
      await derive(live.itemId, a, "live", identity, true, crop);
      const coverKey = await editKeyOf(identity, crop);
      expect(coverKey).not.toBe("base");
      // 10 astral code points, 149 BMP ones and a space at code point 160:
      // the excerpt counts code points (not UTF-16 units) and trims after the cut.
      const body = `${"𠮷".repeat(10)}${"甲".repeat(149)} 乙丙`;
      const stillEntry = entry(still.itemId);
      const liveEntry = entry(live.itemId, identity, "live");
      const album = await publish(
        a,
        {
          title: "相册封面",
          body,
          items: [stillEntry, liveEntry],
          coverKey: liveEntry.key,
          coverCrop: crop,
        },
        now,
      );
      const textOnly = await publish(a, { body: "  只有文字  " }, now);
      const albumTarget = { type: "work" as const, id: album.workId };
      const expectedExcerpt = `${"𠮷".repeat(10)}${"甲".repeat(149)}`;
      const coverSrc = `/api/community/publishing/media/${live.itemId}/cover/${coverKey}`;

      const albumCard = await discovery.card(albumTarget, b);
      expect(albumCard).toMatchObject({
        title: "相册封面",
        excerpt: expectedExcerpt,
        live: true,
        media: {
          type: "work",
          id: live.itemId,
          src: coverSrc,
          width: 640,
          height: 480,
        },
      });
      expect(
        await discovery.card({ type: "work", id: textOnly.workId }, null),
      ).toMatchObject({ excerpt: "只有文字", live: false, media: null });

      // The Public service maps exactly the adapter path (never a user media
      // path for a media item) and the result satisfies the card contract.
      const publicCard = await service().card(albumTarget, b);
      expect(contentCardSchema.parse(publicCard)).toEqual(publicCard);
      expect(publicCard.media).toEqual({
        id: live.itemId,
        src: coverSrc,
        width: 640,
        height: 480,
      });
      const feed = await service().browse(b, discoveryQuerySchema.parse({}));
      expect(
        feed.items.find((card) => card.target.id === album.workId)?.media?.src,
      ).toBe(coverSrc);
      await authors.changeRelation(b, "favorite", {
        requestId: randomUUID(),
        target: albumTarget,
        enabled: true,
      });
      const favorites = await service().collection(b, a, "favorite", listQuery);
      expect(favorites.items.map((card) => card.media?.src)).toEqual([
        coverSrc,
      ]);
      expect((await service().profile(b, a)).totals.favorites).toBe(1);
      expect((await authors.readProfile(b, a)).totals.favorites).toBe(1);

      // An edit awaiting approval: others keep the public revision's card, the
      // author sees their own latest title, excerpt and cover.
      await setPolicy("PRE_MODERATION");
      confirmed(
        await editWork(
          a,
          album.workId,
          {
            title: "作者的新标题",
            body: "作者的新正文",
            items: [stillEntry, liveEntry],
            coverKey: stillEntry.key,
          },
          at("2026-07-20T09:00:00.000Z"),
        ),
      );
      expect(await discovery.card(albumTarget, b)).toEqual(albumCard);
      expect(await discovery.card(albumTarget, null)).toMatchObject({
        title: "相册封面",
        media: { src: coverSrc },
      });
      const ownCard = await discovery.card(albumTarget, a);
      expect(ownCard).toMatchObject({
        title: "作者的新标题",
        excerpt: "作者的新正文",
        live: false,
        media: {
          id: still.itemId,
          src: `/api/community/publishing/media/${still.itemId}/cover/base`,
        },
      });
      expect(
        (await discovery.browse(a, discoveryQuerySchema.parse({}))).items.find(
          (card) => card.target.id === album.workId,
        ),
      ).toEqual(ownCard);
      expect(
        (await discovery.browse(b, discoveryQuerySchema.parse({}))).items.find(
          (card) => card.target.id === album.workId,
        )?.title,
      ).toBe("相册封面");
    });

    it("applies effective visibility to every surface for self-only, pending first, trashed, hidden and removed works", async () => {
      const now = at("2026-07-21T08:00:00.000Z");
      for (const account of [a, b])
        await authors.updatePrivacy(account, {
          requestId: randomUUID(),
          privacy: allPublic,
        });
      const media = await mediaItem(a);
      const visible = await publish(
        a,
        { title: "公开", items: [entry(media.itemId)] },
        now,
      );
      const selfOnly = await publish(a, { title: "仅自己" }, now);
      const trashed = await publish(a, { title: "回收站" }, now);
      const hidden = await publish(a, { title: "隐藏" }, now);
      const removed = await publish(a, { title: "移除" }, now);
      const works = { visible, selfOnly, trashed, hidden, removed };
      for (const work of Object.values(works)) {
        const target = { type: "work" as const, id: work.workId };
        await authors.changeRelation(b, "favorite", {
          requestId: randomUUID(),
          target,
          enabled: true,
        });
        await comments.submitDiscussion(target, b, "公开时的评论");
      }
      await adapter.setVisibility(
        a,
        selfOnly.workId,
        { requestId: randomUUID(), visibility: "self" },
        now,
      );
      await legacyTrashFixture(
        a,
        trashed.workId,
        { requestId: randomUUID() },
        now,
      );
      for (const [work, state] of [
        [hidden, "hidden"],
        [removed, "removed"],
      ] as const)
        await contentOperator.moderateWork(work.workId, operator, {
          requestId: randomUUID(),
          state,
          expectedVersion: (await authors.readWork(work.workId, a)).version,
        });
      await setPolicy("PRE_MODERATION");
      const pendingFirst = await publish(a, { title: "首次待审" }, now);
      // A guest favorite merged later keeps its relation without making the
      // work visible (the merge never checks availability).
      await authors.mergeGuestFavorites(b, {
        requestId: randomUUID(),
        expectedAccountId: b,
        items: [{ type: "work", id: pendingFirst.workId }],
      });
      const restricted = {
        selfOnly,
        pendingFirst,
        trashed,
        hidden,
        removed,
      };
      const publicService = service();
      const page = { page: 1, pageSize: 10 };

      // Third parties: nothing but the public work, on every surface.
      for (const viewer of [b, null]) {
        const feed = await browseIds(viewer);
        expect(feed).toContain(visible.workId);
        for (const work of Object.values(restricted)) {
          const target = { type: "work" as const, id: work.workId };
          expect(feed).not.toContain(work.workId);
          await expectRejection(
            discovery.card(target, viewer),
            CommunityNotFoundError,
          );
          await expectRejection(
            authors.readWork(work.workId, viewer),
            CommunityNotFoundError,
          );
          await expectRejection(
            comments.readDiscussion(target, viewer, page),
            CommunityNotFoundError,
          );
          await expectRejection(
            publicService.assertTarget(target, viewer),
            CommunityNotFoundError,
          );
        }
        expect(
          (
            await discovery.collection(b, viewer, "favorite", listQuery)
          ).items.map((card) => card.target.id),
        ).toEqual([visible.workId]);
        expect(
          (await discovery.collection(b, viewer, "favorite", listQuery)).total,
        ).toBe(1);
        expect((await authors.readProfile(a, viewer)).totals.works).toBe(1);
        expect((await authors.readProfile(b, viewer)).totals.favorites).toBe(1);
        expect((await publicService.profile(b, viewer)).totals.favorites).toBe(
          1,
        );
        expect(
          (await authors.listWorks(a, viewer, listQuery)).items.map(
            (work) => work.id,
          ),
        ).toEqual([visible.workId]);
      }
      for (const work of Object.values(restricted)) {
        const target = { type: "work" as const, id: work.workId };
        await expectRejection(
          authors.changeRelation(b, "like", {
            requestId: randomUUID(),
            target,
            enabled: true,
          }),
          CommunityNotFoundError,
        );
        await expectRejection(
          comments.submitDiscussion(target, b, "看不见的作品"),
          CommunityNotFoundError,
        );
        // Removing a relation never needs the work to be visible.
        await authors.changeRelation(b, "favorite", {
          requestId: randomUUID(),
          target,
          enabled: false,
        });
      }
      expect(
        (await publicService.card({ type: "work", id: visible.workId }, b))
          .media?.src,
      ).toBe(`/api/community/publishing/media/${media.itemId}/cover/base`);

      // The author: own works outside the recycle bin, discussions only where
      // no operator restriction applies, and no public interaction on works
      // others cannot see.
      const own = async (workId: string) => authors.readWork(workId, a);
      expect(await own(selfOnly.workId)).toMatchObject({
        available: true,
        visibility: "self",
      });
      expect(await own(pendingFirst.workId)).toMatchObject({
        available: true,
        visibility: "public",
        firstPublishedAt: null,
      });
      expect(await own(hidden.workId)).toMatchObject({ available: false });
      expect(await own(removed.workId)).toMatchObject({ available: false });
      await expectRejection(own(trashed.workId), CommunityNotFoundError);
      for (const work of [selfOnly, pendingFirst]) {
        const target = { type: "work" as const, id: work.workId };
        await publicService.assertTarget(target, a);
        await comments.readDiscussion(target, a, page);
        await expectRejection(
          comments.submitDiscussion(target, a, "作者自己的评论"),
          CommunityNotFoundError,
        );
        await expectRejection(
          authors.changeRelation(a, "like", {
            requestId: randomUUID(),
            target,
            enabled: true,
          }),
          CommunityNotFoundError,
        );
      }
      // A single card follows the work read rule: the author's own works
      // outside the recycle bin, from the author revision (feeds stay public).
      for (const [work, title, firstPublished] of [
        [selfOnly, "仅自己", true],
        [pendingFirst, "首次待审", false],
        [hidden, "隐藏", true],
        [removed, "移除", true],
      ] as const) {
        const target = { type: "work" as const, id: work.workId };
        const card = await discovery.card(target, a);
        expect(card).toMatchObject({ target, title, authorId: a, media: null });
        expect(card.firstPublishedAt !== null).toBe(firstPublished);
        expect((await publicService.card(target, a)).target).toEqual(target);
      }
      await expectRejection(
        discovery.card({ type: "work", id: trashed.workId }, a),
        CommunityNotFoundError,
      );
      for (const work of [hidden, removed, trashed]) {
        const target = { type: "work" as const, id: work.workId };
        await expectRejection(
          publicService.assertTarget(target, a),
          CommunityNotFoundError,
        );
        await expectRejection(
          comments.readDiscussion(target, a, page),
          CommunityNotFoundError,
        );
      }
      expect(await browseIds(a)).not.toContain(selfOnly.workId);
      expect((await authors.readProfile(a, a)).totals.works).toBe(5);
      expect(
        (await authors.listWorks(a, a, listQuery)).items
          .map((work) => work.id)
          .sort(),
      ).toEqual(
        [visible, selfOnly, pendingFirst, hidden, removed]
          .map((work) => work.workId)
          .sort(),
      );
      // Relation and comment rows are never rewritten by visibility changes.
      expect(
        await count(
          "SELECT count(*) AS n FROM community.catalog_comments WHERE author_id=$1 AND body_deleted_at IS NULL",
          [b],
        ),
      ).toBe(5);
    });

    it("starts the orphan grace when a submission or a trash purge releases an item", async () => {
      const grace = 7 * 24 * 60 * 60 * 1000;
      const old = at("2026-01-01T00:00:00.000Z");
      const makeOld = async (itemId: string) => {
        await pool.query(
          "UPDATE community.media_items SET created_at=$2,updated_at=$2 WHERE id=$1",
          [itemId, old],
        );
        await pool.query(
          "UPDATE community.media_components SET created_at=$2,updated_at=$2 WHERE item_id=$1",
          [itemId, old],
        );
      };
      const purgeJobsOf = async (itemId: string) =>
        (
          await pool.query<{ state: string; run_after: Date }>(
            "SELECT state,run_after FROM community.publishing_jobs WHERE kind='purge_item' AND subject_id=$1 ORDER BY created_at",
            [itemId],
          )
        ).rows;

      // A draft holds an item its submission drops.
      const kept = await mediaItem(a);
      const dropped = await mediaItem(a);
      await makeOld(dropped.itemId);
      const draftId = await holdDraft(a, null, null, [
        kept.itemId,
        dropped.itemId,
      ]);
      // An old history snapshot is the only holder of another item; the
      // submission's history trim (limit 1) evicts it in the same pass.
      const historyOnly = await mediaItem(a);
      await makeOld(historyOnly.itemId);
      const oldSnapshot = id("work-snapshot");
      await pool.query(
        "INSERT INTO community.work_draft_snapshots(id,owner_id,draft_id,kind,content,pinned,created_at) VALUES($1,$2,$3,'saved',$4::jsonb,FALSE,$5)",
        [
          oldSnapshot,
          a,
          draftId,
          JSON.stringify(contentOf({ items: [entry(historyOnly.itemId)] })),
          old,
        ],
      );
      await pool.query(
        "INSERT INTO community.media_item_refs(item_id,holder_kind,holder_id) VALUES($1,'snapshot',$2)",
        [historyOnly.itemId, oldSnapshot],
      );
      await pool.query(
        "UPDATE community.work_publishing_settings SET history_limit=1 WHERE id='settings'",
      );
      const submittedAt = at("2026-07-23T08:00:00.000Z");
      confirmed(
        await adapter.submit(
          a,
          command(
            { draftId },
            { title: "只保留一张", items: [entry(kept.itemId)] },
          ),
          submittedAt,
        ),
      );
      expect(
        await count(
          "SELECT count(*) AS n FROM community.media_item_refs WHERE item_id=$1",
          [dropped.itemId],
        ),
      ).toBe(0);
      expect(
        (
          await pool.query<{ updated_at: Date }>(
            "SELECT updated_at FROM community.media_items WHERE id=$1",
            [dropped.itemId],
          )
        ).rows[0]!.updated_at,
      ).toEqual(submittedAt);
      expect(
        await adapter.purgeItem(
          dropped.itemId,
          new Date(submittedAt.getTime() + 1000),
        ),
      ).toEqual({
        status: "referenced",
      });
      expect(
        await count(
          "SELECT count(*) AS n FROM community.work_draft_snapshots WHERE id=$1",
          [oldSnapshot],
        ),
      ).toBe(0);
      expect(
        await count(
          "SELECT count(*) AS n FROM community.media_item_refs WHERE item_id=$1",
          [historyOnly.itemId],
        ),
      ).toBe(0);
      expect(
        (
          await pool.query<{ updated_at: Date }>(
            "SELECT updated_at FROM community.media_items WHERE id=$1",
            [historyOnly.itemId],
          )
        ).rows[0]!.updated_at,
      ).toEqual(submittedAt);
      expect(
        await adapter.purgeItem(
          historyOnly.itemId,
          new Date(submittedAt.getTime() + grace - 1000),
        ),
      ).toEqual({ status: "referenced" });
      await adapter.scheduleCleanup(
        new Date(submittedAt.getTime() + 1000),
        1000,
      );
      expect(await purgeJobsOf(dropped.itemId)).toEqual([]);
      expect(
        await adapter.purgeItem(
          dropped.itemId,
          new Date(submittedAt.getTime() + grace + 1000),
        ),
      ).toMatchObject({ status: "tombstoned" });
      expect(
        await adapter.purgeItem(
          historyOnly.itemId,
          new Date(submittedAt.getTime() + grace + 1000),
        ),
      ).toMatchObject({ status: "tombstoned" });
      await pool.query(
        "UPDATE community.work_publishing_settings SET history_limit=20 WHERE id='settings'",
      );

      // A trashed work's purge releases its exclusive item and a cancelled one
      // a snapshot still named.
      const exclusive = await mediaItem(a);
      await makeOld(exclusive.itemId);
      const work = await publish(
        a,
        { title: "清除", items: [entry(exclusive.itemId)] },
        submittedAt,
      );
      const cancelled = await mediaItem(a, { state: "processing" });
      await pool.query(
        "UPDATE community.media_items SET state='cancelled' WHERE id=$1",
        [cancelled.itemId],
      );
      const snapshotId = id("work-snapshot");
      await pool.query(
        "INSERT INTO community.work_draft_snapshots(id,owner_id,work_id,kind,content,pinned) VALUES($1,$2,$3,'saved',$4::jsonb,FALSE)",
        [
          snapshotId,
          a,
          work.workId,
          JSON.stringify(contentOf({ items: [entry(cancelled.itemId)] })),
        ],
      );
      await pool.query(
        "INSERT INTO community.media_item_refs(item_id,holder_kind,holder_id) VALUES($1,'snapshot',$2)",
        [cancelled.itemId, snapshotId],
      );
      await makeOld(exclusive.itemId);
      await legacyTrashFixture(
        a,
        work.workId,
        { requestId: randomUUID() },
        submittedAt,
      );
      const purgedAt = at("2026-08-22T08:00:00.000Z");
      expect(await adapter.purgeTrashedWork(work.workId, purgedAt)).toBe(
        "purged",
      );
      expect(await purgeJobsOf(exclusive.itemId)).toEqual([
        {
          state: "queued",
          run_after: new Date(purgedAt.getTime() + grace + 1000),
        },
      ]);
      expect(await purgeJobsOf(cancelled.itemId)).toEqual([
        { state: "queued", run_after: purgedAt },
      ]);
      expect(
        await adapter.purgeItem(
          exclusive.itemId,
          new Date(purgedAt.getTime() + 1000),
        ),
      ).toEqual({ status: "referenced" });
      expect(
        await adapter.purgeItem(
          exclusive.itemId,
          new Date(purgedAt.getTime() + grace + 1000),
        ),
      ).toMatchObject({ status: "tombstoned" });
      expect(await adapter.purgeItem(cancelled.itemId, purgedAt)).toMatchObject(
        {
          status: "tombstoned",
        },
      );
    });

    it("re-parents unresolved conflict copies of a new work's draft on submission so a recycle-bin purge releases their media references", async () => {
      // data-admin-hardening-v1 (E-1): before the fix the copy kept work_id
      // NULL, purgeTrashedWork deleted it with the primary's copies but never
      // treated it as a holder, and its media_item_refs row outlived it.
      const now = at("2026-07-16T08:00:00.000Z");
      const kept = await mediaItem(a);
      const stale = await mediaItem(a);
      const draft = await holdDraft(a, null, null, [kept.itemId]);
      const copy = id("work-draft");
      await pool.query(
        `INSERT INTO community.work_drafts(id,owner_id,work_id,base_revision_id,state,conflict_of,revision,content,content_sha256)
        VALUES($1,$2,NULL,NULL,'active',$3,3,$4::jsonb,encode(sha256(convert_to($4::jsonb::text,'UTF8')),'hex'))`,
        [
          copy,
          a,
          draft,
          JSON.stringify(
            contentOf({ title: "设备副本", items: [entry(stale.itemId)] }),
          ),
        ],
      );
      await pool.query(
        "INSERT INTO community.media_item_refs(item_id,holder_kind,holder_id) VALUES($1,'draft',$2)",
        [stale.itemId, copy],
      );
      const work = confirmed(
        await adapter.submit(
          a,
          command(
            { draftId: draft },
            { title: "提交", items: [entry(kept.itemId)] },
          ),
          now,
        ),
      );
      expect(
        (
          await pool.query<{ work_id: string | null; state: string }>(
            "SELECT work_id,state FROM community.work_drafts WHERE id=$1",
            [copy],
          )
        ).rows,
      ).toEqual([{ work_id: work.workId, state: "active" }]);
      // Merge resolution, not a behaviour change: main removed
      // `adapter.trashWork` and replaced every call with this fixture helper
      // (three other sites in this file already use it). This one call site
      // survived the merge because the two sides edited different regions.
      await legacyTrashFixture(
        a,
        work.workId,
        { requestId: randomUUID() },
        now,
      );
      const due = new Date(now.getTime() + 31 * 24 * 60 * 60 * 1000);
      expect(await adapter.purgeTrashedWork(work.workId, due)).toBe("purged");
      expect(
        await count(
          "SELECT count(*) AS n FROM community.media_item_refs r WHERE r.holder_kind='draft' AND NOT EXISTS (SELECT 1 FROM community.work_drafts d WHERE d.id=r.holder_id)",
          [],
        ),
      ).toBe(0);
      expect(
        await count(
          "SELECT count(*) AS n FROM community.media_item_refs WHERE item_id=$1",
          [stale.itemId],
        ),
      ).toBe(0);
      expect(
        await count(
          "SELECT count(*) AS n FROM community.work_drafts WHERE id=$1",
          [copy],
        ),
      ).toBe(0);
    });

    it("reads an author's works page with a bounded number of statements whatever the page size", async () => {
      // data-admin-hardening-v1 (D3): revisions and media of a page are read
      // in two statements instead of two per work; DTOs are unchanged.
      const now = at("2026-07-17T08:00:00.000Z");
      const works = [];
      for (const title of ["作品一", "作品二", "作品三"]) {
        const item = await mediaItem(a);
        const draft = await holdDraft(a, null, null, [item.itemId]);
        works.push(
          confirmed(
            await adapter.submit(
              a,
              command(
                { draftId: draft },
                { title, items: [entry(item.itemId)] },
              ),
              now,
            ),
          ),
        );
      }
      let statements = 0;
      const patched = Symbol("counted");
      const counting = new Proxy(reads, {
        get(target, prop, receiver) {
          if (prop === "connect")
            return async () => {
              const client = await target.connect();
              const record = client as unknown as Record<symbol, boolean>;
              if (!record[patched]) {
                record[patched] = true;
                const original = client.query.bind(client);
                (client as unknown as { query: unknown }).query = (
                  ...args: unknown[]
                ) => {
                  statements += 1;
                  return (original as (...a: unknown[]) => unknown)(...args);
                };
              }
              return client;
            };
          return Reflect.get(target, prop, receiver);
        },
      }) as typeof reads;
      const counted = new PostgresAuthorCommunityAdapter(counting);
      const page = { search: "", kind: "all" as const };
      statements = 0;
      const one = await counted.listWorks(a, null, {
        ...page,
        page: 1,
        pageSize: 1,
      });
      const forOne = statements;
      statements = 0;
      const all = await counted.listWorks(a, null, {
        ...page,
        page: 1,
        pageSize: 50,
      });
      const forAll = statements;
      expect(one.items).toHaveLength(1);
      expect(all.items.length).toBeGreaterThanOrEqual(3);
      expect(forAll).toBe(forOne);
      expect(all.items).toEqual(
        (await authors.listWorks(a, null, { ...page, page: 1, pageSize: 50 }))
          .items,
      );
      for (const item of all.items.slice(0, 3)) {
        expect(item.media).toHaveLength(1);
        expect(item.coverMediaId).toBe(item.media[0]?.id ?? null);
      }
      expect(works.map((w) => w.workId)).toEqual(
        expect.arrayContaining(all.items.slice(0, 3).map((w) => w.id)),
      );
    });
  });
};
