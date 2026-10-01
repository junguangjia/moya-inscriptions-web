import { createHash, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import {
  CommunityMigrationStateError,
  PostgresAuthorCommunityAdapter,
  PostgresPublishingOperatorAdapter,
  PostgresWorkPublishingAdapter,
  requiredCommunityMigrations,
  runCommunityMigrations,
} from "@moya/community-postgres";
import { mediaMetadataSchema } from "@moya/contracts/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assertSyntheticTestDatabaseUrl,
  requireSyntheticTestDatabaseUrl,
} from "./synthetic-test-database.js";

type Pool = ReturnType<typeof createPostgresPool>;

const testDatabaseUrl = requireSyntheticTestDatabaseUrl();
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const disposableTarget = (await import(
  new URL("../../../scripts/disposable-test-target.mjs", import.meta.url).href
)) as {
  disposableTestTargetProbeSql: string;
  assertDisposableTestTarget: (rows: unknown, database: string) => string;
  isTargetCategory: (message: unknown) => boolean;
  remedyFor: (category: string) => string;
};
const migrationsDirectory = path.join(
  repositoryRoot,
  "database",
  "community-migrations",
);
const phase4LastMigration = "20260913120000";
const workPublishingMigrations = [
  "20260914090000",
  "20260914091000",
  "20260914092000",
  "20260914093000",
  "20260914094000",
  "20260915010000",
  // data-admin-hardening-v1 forward files (indexes, receipt timestamps,
  // agent administration, agent connections), plus main's profile
  // background migration, which claimed 20260920020000 first.
  "20260916010000",
  "20260916011000",
  "20260917010000",
  "20260917020000",
  "20260918010000",
  "20260918020000",
  "20260918030000",
  "20260918040000",
  "20260918050000",
  "20260920010000",
  "20260920020000",
  "20260920050000",
  "20260920060000",
  "20260920070000",
  "20260920080000",
  "20260921010000",
  "20260922010000",
  "20260922011000",
  "20260922020000",
  // content-community-completion-v1 forward files (Threads, the Article
  // discussion target, direct messages).
  "20260922030000",
  "20260922031000",
  "20260922032000",
  "20260930010000",
  "20260930020000",
  "20260930030000",
  "20260930040000",
  "20261001010000",
];
const backfillMigration = "20260914092000";
const bridgeMigration = "20260914093000";

const endpoint = new URL(testDatabaseUrl);
if (
  !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
  endpoint.search !== "" ||
  endpoint.hash !== ""
) {
  throw new Error(
    "Work publishing upgrade tests require a loopback TEST_DATABASE_URL without query overrides or fragments",
  );
}

// Only these unpredictable, test-owned databases are ever created or dropped.
const dedicatedDatabaseName =
  /^wp_(?:upgrade|guard|clean)_[0-9a-f]{12}_synthetic_test$/;
type DedicatedKind = "upgrade" | "guard" | "clean";
const dedicated = (kind: DedicatedKind) => {
  const name = `wp_${kind}_${randomBytes(6).toString("hex")}_synthetic_test`;
  if (!dedicatedDatabaseName.test(name)) throw new Error("Unexpected name");
  const url = new URL(testDatabaseUrl);
  url.pathname = `/${name}`;
  assertSyntheticTestDatabaseUrl(url.toString());
  return { name, url: url.toString() };
};

const administration = createPostgresPool(
  parsePostgresConfig({ DATABASE_URL: testDatabaseUrl }),
);
const created: string[] = [];
const pools: Pool[] = [];

// CREATE DATABASE needs authority the other suites never use. Fail closed,
// with a remedy, unless the connected database carries the disposable marker
// and the role may create databases on that server.
let administrationPreflight: Promise<void> | undefined;
const verifyAdministrationTarget = (): Promise<void> =>
  (administrationPreflight ??= (async () => {
    const probe = await administration.query(
      disposableTarget.disposableTestTargetProbeSql,
    );
    try {
      disposableTarget.assertDisposableTestTarget(
        probe.rows,
        assertSyntheticTestDatabaseUrl(testDatabaseUrl),
      );
    } catch (error) {
      const category = error instanceof Error ? error.message : "";
      throw new Error(
        `Work publishing upgrade tests create temporary databases only beside a marked disposable test database. ${
          disposableTarget.isTargetCategory(category)
            ? disposableTarget.remedyFor(category)
            : "The disposable target probe failed."
        }`,
        { cause: error },
      );
    }
    const role = await administration.query<{ allowed: boolean }>(
      "SELECT rolcreatedb OR rolsuper AS allowed FROM pg_roles WHERE rolname = current_user",
    );
    if (role.rows[0]?.allowed !== true)
      throw new Error(
        "Work publishing upgrade tests create and drop temporary databases, so the TEST_DATABASE_URL role needs CREATEDB on the disposable test server. Grant it there or use the disposable test container role.",
      );
  })());

const createDedicatedDatabase = async (kind: DedicatedKind): Promise<Pool> => {
  await verifyAdministrationTarget();
  const database = dedicated(kind);
  await administration.query(`CREATE DATABASE ${database.name}`);
  created.push(database.name);
  const pool = createPostgresPool(
    parsePostgresConfig({ DATABASE_URL: database.url }),
  );
  pools.push(pool);
  return pool;
};

afterAll(async () => {
  await Promise.all(pools.map((pool) => pool.end()));
  for (const name of created) {
    if (dedicatedDatabaseName.test(name))
      await administration.query(
        `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`,
      );
  }
  await administration.end();
});

const md5 = (value: string) => createHash("md5").update(value).digest("hex");
const sha256 = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");
// The canonical text community.work_content_sha256 hashes for a legacy
// baseline, rebuilt independently: jsonb array text with ", " separators and
// line breaks compared as LF. A legacy baseline declares no authorship, so
// its kind and reference fields are JSON null.
const legacyCanonicalContent = (
  title: string,
  body: string,
  itemIds: readonly string[],
) => {
  const text = (value: string) =>
    JSON.stringify(value.replace(/\r\n?/gu, "\n"));
  const items = itemIds.map((id) => `[${JSON.stringify(id)}, 0, null]`);
  const cover = itemIds[0] === undefined ? "null" : JSON.stringify(itemIds[0]);
  return `[${text(title)}, ${text(body)}, null, null, null, null, [${items.join(", ")}], ${cover}, null]`;
};
const opaque = (prefix: string) =>
  `${prefix}-${randomBytes(16).toString("hex")}`;
const legacyItem = (mediaId: string) =>
  `media-item-${md5(`legacy-media:${mediaId}`)}`;
const legacyRevision = (workId: string) =>
  `work-revision-${md5(`legacy-revision:${workId}`)}`;
const legacySnapshot = (draftId: string) =>
  `work-snapshot-${md5(`legacy-draft:${draftId}`)}`;
const firstOccurrences = (ids: readonly string[]) => [...new Set(ids)];
const noEdit = { rotation: 0, crop: null };

const phase4WorkColumns =
  "id, author_id, title, text, media_ids, first_published_at, updated_at, version, operator_state, deleted_at, synthetic_provenance";

const rows = async <Row extends Record<string, unknown>>(
  pool: Pool,
  sql: string,
  values: readonly unknown[] = [],
): Promise<Row[]> => (await pool.query<Row>(sql, [...values])).rows;

describe("work publishing migrations on dedicated synthetic databases", () => {
  it("refuses a migration prefix that is not an exact manifest ID", async () => {
    await expect(
      runCommunityMigrations(administration, migrationsDirectory, {
        through: "20260913999999",
      }),
    ).rejects.toBeInstanceOf(CommunityMigrationStateError);
  });

  describe("upgrade from representative Phase 4 data", () => {
    let pool: Pool;
    const author = opaque("user");
    const other = opaque("user");
    const media = {
      shared: opaque("user-media"),
      second: opaque("user-media"),
      third: opaque("user-media"),
      deletedOnly: opaque("user-media"),
      draftOnly: opaque("user-media"),
      otherAuthor: opaque("user-media"),
    };
    const works = {
      textOnly: opaque("work"),
      single: opaque("work"),
      triple: opaque("work"),
      duplicated: opaque("work"),
      deleted: opaque("work"),
      hidden: opaque("work"),
      otherAuthor: opaque("work"),
      lineBreaks: opaque("work"),
    };
    const drafts = {
      open: opaque("draft"),
      conflicted: opaque("draft"),
      applied: opaque("draft"),
      discarded: opaque("draft"),
      onDeleted: opaque("draft"),
    };
    const comment = opaque("comment");
    const reply = opaque("comment");
    const sequence = "8f0c1a52-6a1d-4c55-9a8e-2f9b4c3d7e10";
    let before: Record<string, Record<string, unknown>[]>;

    const snapshotPhase4Rows = async () => ({
      works: await rows(
        pool,
        `SELECT ${phase4WorkColumns} FROM community.works ORDER BY id`,
      ),
      drafts: await rows(
        pool,
        "SELECT * FROM community.work_edit_drafts ORDER BY id",
      ),
      relations: await rows(
        pool,
        "SELECT * FROM community.content_relations ORDER BY user_id, content_id, relation",
      ),
      comments: await rows(
        pool,
        "SELECT * FROM community.catalog_comments ORDER BY id",
      ),
      replies: await rows(
        pool,
        "SELECT * FROM community.catalog_comment_replies ORDER BY id",
      ),
      media: await rows(
        pool,
        "SELECT id, owner_id, width, height, sha256, octet_length(bytes) AS size, created_at FROM community.user_media ORDER BY id",
      ),
      users: await rows(
        pool,
        "SELECT * FROM community.public_users ORDER BY id",
      ),
      follows: await rows(
        pool,
        "SELECT * FROM community.follows ORDER BY follower_id, followed_id",
      ),
      commentLikes: await rows(
        pool,
        "SELECT * FROM community.comment_likes ORDER BY comment_id, user_id",
      ),
      featured: await rows(
        pool,
        "SELECT * FROM community.featured_content ORDER BY content_type, content_id",
      ),
      sequenceItems: await rows(
        pool,
        "SELECT * FROM community.discovery_sequence_items ORDER BY sequence_id, ordinal",
      ),
      authorEvents: await rows(
        pool,
        "SELECT * FROM community.author_events ORDER BY id",
      ),
      authorReceipts: await rows(
        pool,
        "SELECT * FROM community.author_command_receipts ORDER BY actor_id, request_id",
      ),
    });

    beforeAll(async () => {
      pool = await createDedicatedDatabase("upgrade");
      expect(
        await runCommunityMigrations(pool, migrationsDirectory, {
          through: phase4LastMigration,
        }),
      ).toEqual(
        requiredCommunityMigrations
          .map(({ migrationId }) => migrationId)
          .filter((id) => id <= phase4LastMigration),
      );

      for (const [user, handle] of [
        [author, `wp-author-${author.slice(-8)}`],
        [other, `wp-other-${other.slice(-8)}`],
      ] as const) {
        await pool.query(
          "INSERT INTO community.public_users(id, handle, display_name) VALUES($1, $2, '合成作者')",
          [user, handle],
        );
      }
      const png = (seed: number) =>
        Buffer.concat([
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          Buffer.from([seed, seed + 1, seed + 2]),
        ]);
      let seed = 1;
      for (const [id, owner] of [
        [media.shared, author],
        [media.second, author],
        [media.third, author],
        [media.deletedOnly, author],
        [media.draftOnly, author],
        [media.otherAuthor, other],
      ] as const) {
        const bytes = png(seed);
        await pool.query(
          "INSERT INTO community.user_media(id, owner_id, mime_type, width, height, sha256, bytes, created_at) VALUES($1, $2, 'image/png', $3, $4, $5, $6, '2026-02-01T00:00:00Z')",
          [id, owner, 100 + seed, 200 + seed, sha256(bytes), bytes],
        );
        seed += 3;
      }
      const insertWork = (
        id: string,
        authorId: string,
        title: string,
        text: string,
        mediaIds: readonly string[],
        extra: { operatorState?: string; deletedAt?: string } = {},
      ) =>
        pool.query(
          `INSERT INTO community.works(id, author_id, title, text, media_ids, first_published_at, updated_at, version, operator_state, deleted_at, synthetic_provenance)
           VALUES($1, $2, $3, $4, $5, '2026-03-01T08:00:00Z', '2026-03-02T08:00:00Z', 3, $6, $7, 'work-publishing-upgrade-test')`,
          [
            id,
            authorId,
            title,
            text,
            [...mediaIds],
            extra.operatorState ?? "visible",
            extra.deletedAt ?? null,
          ],
        );
      await insertWork(
        works.textOnly,
        author,
        "只有文字",
        "第一行\n第二行",
        [],
      );
      await insertWork(works.single, author, "单图", "", [media.shared]);
      await insertWork(works.triple, author, "三图", "正文", [
        media.second,
        media.shared,
        media.third,
      ]);
      await insertWork(works.duplicated, author, "重复", "", [
        media.third,
        media.second,
        media.third,
      ]);
      await insertWork(
        works.deleted,
        author,
        "已删除",
        "",
        [media.deletedOnly],
        { deletedAt: "2026-04-01T00:00:00Z" },
      );
      await insertWork(works.hidden, author, "已隐藏", "", [media.shared], {
        operatorState: "hidden",
      });
      await insertWork(works.otherAuthor, other, "他人作品", "", [
        media.otherAuthor,
      ]);
      // Phase 4 accepted CR and LF inside titles and bodies.
      await insertWork(
        works.lineBreaks,
        author,
        "上行\n下行",
        "甲\r\n乙\r丙",
        [],
      );

      await pool.query(
        "INSERT INTO community.content_relations(user_id, content_type, content_id, relation) VALUES($1, 'work', $2, 'like'), ($1, 'work', $3, 'favorite'), ($1, 'work', $4, 'like')",
        [other, works.single, works.triple, works.deleted],
      );
      await pool.query(
        "INSERT INTO community.catalog_comments(id, catalog_id, author_id, text, moderation, target_type) VALUES($1, $2, $3, '合成评论', 'visible', 'work')",
        [comment, works.single, other],
      );
      await pool.query(
        "INSERT INTO community.catalog_comment_replies(id, root_comment_id, author_id, text, moderation) VALUES($1, $2, $3, '合成回复', 'visible')",
        [reply, comment, author],
      );
      await pool.query(
        "INSERT INTO community.comment_likes(comment_id, user_id) VALUES($1, $2)",
        [comment, author],
      );
      await pool.query(
        "UPDATE community.public_users SET avatar_media_id = $1, avatar_changed_on = '2026-02-01' WHERE id = $2",
        [media.shared, author],
      );
      await pool.query(
        "INSERT INTO community.follows(follower_id, followed_id) VALUES($1, $2)",
        [other, author],
      );
      await pool.query(
        "INSERT INTO community.featured_content(content_type, content_id, position) VALUES('work', $1, 1), ('work', $2, 2)",
        [works.triple, works.hidden],
      );
      await pool.query(
        "INSERT INTO community.discovery_sequences(id, viewer_id, query) VALUES($1, $2, '{}')",
        [sequence, other],
      );
      await pool.query(
        "INSERT INTO community.discovery_sequence_items(sequence_id, ordinal, content_type, content_id) VALUES($1, 1, 'work', $2), ($1, 2, 'work', $3)",
        [sequence, works.single, works.deleted],
      );
      await pool.query(
        "INSERT INTO community.author_events(id, actor_id, action, subject_id) VALUES($1, $2, 'work.update', $3)",
        [opaque("author-event"), author, works.triple],
      );
      await pool.query(
        "INSERT INTO community.author_command_receipts(actor_id, request_id, fingerprint, result) VALUES($1, gen_random_uuid(), $2, $3)",
        [author, "c".repeat(64), { workId: works.triple, version: 3 }],
      );

      const insertDraft = (
        id: string,
        workId: string,
        version: number,
        mediaIds: readonly string[],
        state: {
          conflicted?: boolean;
          appliedAt?: string;
          discardedAt?: string;
        } = {},
      ) =>
        pool.query(
          `INSERT INTO community.work_edit_drafts(id, work_id, author_id, version, base_work_version, base_draft_version, title, text, media_ids, conflicted, created_at, applied_at, discarded_at)
           VALUES($1, $2, $3, $4, 3, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            id,
            workId,
            author,
            version,
            version - 1,
            ` 草稿 ${version} `,
            `草稿正文 ${version}`,
            [...mediaIds],
            state.conflicted ?? false,
            `2026-05-0${version}T00:00:00Z`,
            state.appliedAt ?? null,
            state.discardedAt ?? null,
          ],
        );
      await insertDraft(drafts.open, works.triple, 1, [
        media.third,
        media.draftOnly,
      ]);
      await insertDraft(drafts.conflicted, works.triple, 2, [], {
        conflicted: true,
      });
      await insertDraft(drafts.applied, works.triple, 3, [media.second], {
        appliedAt: "2026-05-10T00:00:00Z",
      });
      await insertDraft(drafts.discarded, works.triple, 4, [media.shared], {
        conflicted: true,
        discardedAt: "2026-05-10T00:00:00Z",
      });
      await insertDraft(drafts.onDeleted, works.deleted, 1, [
        media.deletedOnly,
      ]);

      before = await snapshotPhase4Rows();
      expect(await runCommunityMigrations(pool, migrationsDirectory)).toEqual(
        workPublishingMigrations,
      );
    });

    it("gives every retained work matching legacy public and author revisions", async () => {
      const upgraded = await rows<{
        id: string;
        author_id: string;
        title: string;
        text: string;
        media_ids: string[];
        first_published_at: Date;
        visibility: string;
        public_revision_id: string | null;
        author_revision_id: string | null;
        created_via: string;
        first_submitted_at: Date | null;
        trashed_at: Date | null;
        edited_at: Date | null;
      }>(
        pool,
        "SELECT id, author_id, title, text, media_ids, first_published_at, visibility, public_revision_id, author_revision_id, created_via, first_submitted_at, trashed_at, edited_at FROM community.works WHERE deleted_at IS NULL ORDER BY id",
      );
      expect(upgraded.map(({ id }) => id).sort()).toEqual(
        Object.entries(works)
          .filter(([key]) => key !== "deleted")
          .map(([, id]) => id)
          .sort(),
      );
      for (const work of upgraded) {
        const revisionId = legacyRevision(work.id);
        expect(work).toMatchObject({
          visibility: "public",
          public_revision_id: revisionId,
          author_revision_id: revisionId,
          created_via: "legacy",
          first_submitted_at: work.first_published_at,
          trashed_at: null,
          edited_at: null,
        });
        const [revision] = await rows<Record<string, unknown>>(
          pool,
          "SELECT * FROM community.work_revisions WHERE work_id = $1",
          [work.id],
        );
        const expectedItems = firstOccurrences(work.media_ids).map(legacyItem);
        expect(revision).toMatchObject({
          id: revisionId,
          author_id: work.author_id,
          sequence: 1,
          origin: "legacy",
          title: work.title,
          body: work.text,
          authorship_kind: null,
          reference_title: null,
          original_author: null,
          source_note: null,
          requested_visibility: "public",
          cover_item_id: expectedItems[0] ?? null,
          disposition: "approved",
          submitted_at: work.first_published_at,
          request_id: null,
        });
        expect(revision?.content_sha256).toBe(
          sha256(legacyCanonicalContent(work.title, work.text, expectedItems)),
        );
        const items = await rows<{
          position: number;
          item_id: string;
          edit: unknown;
        }>(
          pool,
          "SELECT position, item_id, edit FROM community.work_revision_items WHERE revision_id = $1 ORDER BY position",
          [revisionId],
        );
        expect(items).toEqual(
          expectedItems.map((itemId, index) => ({
            position: index + 1,
            item_id: itemId,
            edit: noEdit,
          })),
        );
        const refs = await rows<{ item_id: string }>(
          pool,
          "SELECT item_id FROM community.media_item_refs WHERE holder_kind = 'revision' AND holder_id = $1 ORDER BY item_id COLLATE \"C\"",
          [revisionId],
        );
        expect(refs.map(({ item_id }) => item_id)).toEqual(
          [...expectedItems].sort(),
        );
      }
      const triple = upgraded.find(({ id }) => id === works.triple);
      expect(firstOccurrences(triple?.media_ids ?? []).map(legacyItem)).toEqual(
        [
          legacyItem(media.second),
          legacyItem(media.shared),
          legacyItem(media.third),
        ],
      );
      const duplicated = await rows<{ item_id: string }>(
        pool,
        "SELECT item_id FROM community.work_revision_items WHERE revision_id = $1 ORDER BY position",
        [legacyRevision(works.duplicated)],
      );
      expect(duplicated.map(({ item_id }) => item_id)).toEqual([
        legacyItem(media.third),
        legacyItem(media.second),
      ]);
    });

    it("keeps legacy text as stored and defines content identity once in PostgreSQL", async () => {
      expect(
        await rows(
          pool,
          "SELECT w.title = r.title AND w.text = r.body AS verbatim FROM community.works w JOIN community.work_revisions r ON r.id = w.public_revision_id WHERE w.id = $1",
          [works.lineBreaks],
        ),
      ).toEqual([{ verbatim: true }]);
      // The adapter recipe: recompute from the stored revision and its items.
      expect(
        await rows(
          pool,
          `SELECT r.content_sha256 = community.work_content_sha256(
             r.title, r.body, r.authorship_kind, r.reference_title,
             r.original_author, r.source_note,
             COALESCE((SELECT jsonb_agg(jsonb_build_object('itemId', i.item_id, 'edit', i.edit) ORDER BY i.position)
                       FROM community.work_revision_items i WHERE i.revision_id = r.id), '[]'::jsonb),
             r.cover_item_id, r.cover_crop) AS matches
           FROM community.work_revisions r ORDER BY r.id`,
        ),
      ).toEqual(Array.from({ length: 7 }, () => ({ matches: true })));
      expect(
        await rows(
          pool,
          "SELECT pg_get_function_identity_arguments('community.work_content_sha256'::regproc) AS signature",
        ),
      ).toEqual([
        {
          signature:
            "title text, body text, authorship_kind text, reference_title text, original_author text, source_note text, items jsonb, cover_item_id text, cover_crop jsonb",
        },
      ]);

      const item = (suffix: string) => `media-item-${suffix.repeat(32)}`;
      const content = {
        title: "标题",
        body: "第一行\n第二行",
        kind: "copy_practice" as string | null,
        referenceTitle: "参考" as string | null,
        originalAuthor: null as string | null,
        sourceNote: "来源" as string | null,
        items: [
          {
            itemId: item("a"),
            edit: {
              rotation: 90,
              crop: { x: 0.1, y: 0, width: 0.5, height: 0.5 },
            },
          },
          { itemId: item("b"), edit: noEdit },
        ] as readonly Record<string, unknown>[],
        coverItemId: item("a") as string | null,
        coverCrop: { x: 0, y: 0, width: 1, height: 1 } as unknown,
      };
      type Content = typeof content;
      const hash = async (override: Partial<Content> = {}) => {
        const value = { ...content, ...override };
        const [row] = await rows<{ sha: string }>(
          pool,
          "SELECT community.work_content_sha256($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb) AS sha",
          [
            value.title,
            value.body,
            value.kind,
            value.referenceTitle,
            value.originalAuthor,
            value.sourceNote,
            JSON.stringify(value.items),
            value.coverItemId,
            JSON.stringify(value.coverCrop),
          ],
        );
        return row?.sha;
      };
      const base = await hash();
      expect(base).toBe(
        sha256(
          `["标题", "第一行\\n第二行", "copy_practice", "参考", null, "来源", [["${item("a")}", 90, {"x": 0.1, "y": 0, "width": 0.5, "height": 0.5}], ["${item("b")}", 0, null]], "${item("a")}", {"x": 0, "y": 0, "width": 1, "height": 1}]`,
        ),
      );
      // Same content: CR line breaks, draft-only item keys, input key order.
      expect(await hash({ title: "标题", body: "第一行\r\n第二行" })).toBe(
        base,
      );
      expect(await hash({ body: "第一行\r第二行" })).toBe(base);
      expect(
        await hash({
          items: content.items.map((entry, index) => ({
            key: `k${index}`,
            kind: "static",
            qualityMode: "standard",
            ...entry,
          })),
          coverCrop: { height: 1, width: 1, y: 0, x: 0 },
        }),
      ).toBe(base);
      // Real content updates.
      for (const override of [
        { title: "标题二" },
        { kind: "material_sharing" },
        { sourceNote: null },
        { items: [...content.items].reverse() },
        {
          items: [
            content.items[0]!,
            { itemId: item("b"), edit: { rotation: 180, crop: null } },
          ],
        },
        { coverItemId: item("b") },
        { coverCrop: null },
      ] satisfies Partial<Content>[]) {
        expect(await hash(override), JSON.stringify(override)).not.toBe(base);
      }
      // No declared authorship is its own content, distinct from a declared
      // original: the kind is the JSON null element.
      const undeclared = { kind: null, referenceTitle: null, sourceNote: null };
      const notSet = await hash(undeclared);
      expect(notSet).toBe(
        sha256(
          `["标题", "第一行\\n第二行", null, null, null, null, [["${item("a")}", 90, {"x": 0.1, "y": 0, "width": 0.5, "height": 0.5}], ["${item("b")}", 0, null]], "${item("a")}", {"x": 0, "y": 0, "width": 1, "height": 1}]`,
        ),
      );
      expect(await hash({ ...undeclared, kind: "original" })).not.toBe(notSet);
    });

    it("shows no authorship claim on upgraded Phase 4 works in any read", async () => {
      const authors = new PostgresAuthorCommunityAdapter(pool);
      for (const workId of [works.single, works.textOnly, works.triple])
        for (const viewer of [other, author, null])
          expect(
            await authors.readWork(workId, viewer),
            `${workId} ${viewer}`,
          ).not.toHaveProperty("authorship");
      const listed = await authors.listWorks(author, author, {
        page: 1,
        pageSize: 50,
        search: "",
        kind: "all",
      });
      expect(listed.items.length).toBeGreaterThan(0);
      for (const item of listed.items)
        expect(item).not.toHaveProperty("authorship");
      expect((await authors.readWork(works.triple, other)).coverSrc).toBe(
        `/api/community/media/${media.second}`,
      );
      expect(
        (
          await new PostgresWorkPublishingAdapter(pool).readEditableWork(
            author,
            works.triple,
          )
        ).content.authorship,
      ).toBeNull();
      expect(
        (
          await new PostgresPublishingOperatorAdapter(pool).readSubmission(
            legacyRevision(works.triple),
          )
        ).authorship,
      ).toBeNull();
    });

    it("maps each referenced user_media row to one ready legacy item in place", async () => {
      const items = await rows<Record<string, unknown>>(
        pool,
        'SELECT id, owner_id, kind, quality_mode, source, legacy_media_id, state, presentation, declared_total_bytes, received_total_bytes FROM community.media_items ORDER BY legacy_media_id COLLATE "C"',
      );
      const expected = [
        [media.shared, author, 101, 201],
        [media.second, author, 104, 204],
        [media.third, author, 107, 207],
        [media.draftOnly, author, 113, 213],
        [media.otherAuthor, other, 116, 216],
      ] as const;
      expect(items).toEqual(
        expected
          .map(([mediaId, owner, width, height]) => ({
            id: legacyItem(mediaId),
            owner_id: owner,
            kind: "static",
            quality_mode: "legacy",
            source: "legacy_user_media",
            legacy_media_id: mediaId,
            state: "ready",
            presentation: { width, height },
            declared_total_bytes: "11",
            received_total_bytes: "11",
          }))
          .sort((left, right) =>
            left.legacy_media_id < right.legacy_media_id ? -1 : 1,
          ),
      );
      // The shared id is one item although three works reference it.
      expect(
        await rows(
          pool,
          "SELECT count(*)::int AS n FROM community.media_items WHERE legacy_media_id = $1",
          [media.shared],
        ),
      ).toEqual([{ n: 1 }]);
      expect(
        await rows(
          pool,
          "SELECT holder_id FROM community.media_item_refs WHERE item_id = $1 AND holder_kind = 'revision' ORDER BY holder_id COLLATE \"C\"",
          [legacyItem(media.shared)],
        ),
      ).toEqual(
        [works.single, works.triple, works.hidden]
          .map(legacyRevision)
          .sort()
          .map((holder_id) => ({ holder_id })),
      );
      expect(
        await rows(
          pool,
          "SELECT count(*)::int AS n FROM community.media_blobs",
        ),
      ).toEqual([{ n: 0 }]);
    });

    it("leaves the deleted work, relations, comments, drafts and user media untouched", async () => {
      expect(await snapshotPhase4Rows()).toEqual({
        ...before,
        comments: before.comments!.map((comment) => ({
          ...comment,
          mentions: [],
        })),
        replies: before.replies!.map((reply) => ({ ...reply, mentions: [] })),
        users: before.users!.map((user) => ({
          ...user,
          background_media_id: null,
          studio_name: "",
        })),
      });
      expect(
        await rows(
          pool,
          "SELECT id FROM community.user_media WHERE deleted_at IS NOT NULL",
        ),
      ).toEqual([]);
      expect(
        await rows(
          pool,
          "SELECT public_revision_id, author_revision_id, first_submitted_at, visibility, created_via FROM community.works WHERE id = $1",
          [works.deleted],
        ),
      ).toEqual([
        {
          public_revision_id: null,
          author_revision_id: null,
          first_submitted_at: null,
          visibility: "public",
          created_via: "legacy",
        },
      ]);
      expect(
        await rows(
          pool,
          "SELECT id FROM community.work_revisions WHERE work_id = $1 UNION ALL SELECT id FROM community.work_draft_snapshots WHERE work_id = $1 UNION ALL SELECT id FROM community.media_items WHERE legacy_media_id = $2",
          [works.deleted, media.deletedOnly],
        ),
      ).toEqual([]);
    });

    it("turns unapplied legacy drafts into snapshots and pins the conflicted one", async () => {
      const snapshots = await rows<Record<string, unknown>>(
        pool,
        "SELECT id, owner_id, draft_id, work_id, kind, content, source_revision, pinned, created_at FROM community.work_draft_snapshots ORDER BY source_revision",
      );
      expect(snapshots).toEqual([
        {
          id: legacySnapshot(drafts.open),
          owner_id: author,
          draft_id: null,
          work_id: works.triple,
          kind: "legacy_draft",
          content: {
            title: " 草稿 1 ",
            body: "草稿正文 1",
            authorship: null,
            visibility: "public",
            items: [media.third, media.draftOnly].map((mediaId) => ({
              key: legacyItem(mediaId),
              itemId: legacyItem(mediaId),
              kind: "static",
              qualityMode: "legacy",
              edit: noEdit,
            })),
            coverKey: legacyItem(media.third),
            coverCrop: null,
          },
          source_revision: 1,
          pinned: false,
          created_at: new Date("2026-05-01T00:00:00Z"),
        },
        {
          id: legacySnapshot(drafts.conflicted),
          owner_id: author,
          draft_id: null,
          work_id: works.triple,
          kind: "legacy_draft",
          content: {
            title: " 草稿 2 ",
            body: "草稿正文 2",
            authorship: null,
            visibility: "public",
            items: [],
            coverKey: null,
            coverCrop: null,
          },
          source_revision: 2,
          pinned: true,
          created_at: new Date("2026-05-02T00:00:00Z"),
        },
      ]);
      expect(
        await rows(
          pool,
          "SELECT item_id FROM community.media_item_refs WHERE holder_kind = 'snapshot' AND holder_id = $1 ORDER BY item_id COLLATE \"C\"",
          [legacySnapshot(drafts.open)],
        ),
      ).toEqual(
        [legacyItem(media.third), legacyItem(media.draftOnly)]
          .sort()
          .map((item_id) => ({ item_id })),
      );
      expect(
        await rows(
          pool,
          "SELECT count(*)::int AS n FROM community.work_drafts",
        ),
      ).toEqual([{ n: 0 }]);
    });

    it("initializes the independent work publishing settings with the documented defaults", async () => {
      expect(
        await rows(
          pool,
          "SELECT id, publication_policy, max_items_per_work, original_item_max_bytes, standard_component_max_bytes, ordinary_account_capacity_bytes, owner_account_capacity_bytes, max_active_drafts, daily_new_work_limit, history_limit, trash_retention_days, orphan_grace_days, unsaved_session_lease_minutes, version, updated_by FROM community.work_publishing_settings",
        ),
      ).toEqual([
        {
          id: "settings",
          publication_policy: "DIRECT_PUBLICATION",
          max_items_per_work: 50,
          original_item_max_bytes: "134217728",
          standard_component_max_bytes: "268435456",
          ordinary_account_capacity_bytes: "10737418240",
          owner_account_capacity_bytes: "21474836480",
          max_active_drafts: 100,
          daily_new_work_limit: 100,
          history_limit: 20,
          trash_retention_days: 30,
          orphan_grace_days: 7,
          unsaved_session_lease_minutes: 360,
          version: 1,
          updated_by: "platform",
        },
      ]);
      expect(
        await rows(
          pool,
          "SELECT count(*)::int AS n FROM community.account_publishing_capacity",
        ),
      ).toEqual([{ n: 0 }]);
      // The comment publication setting is a separate row and unchanged.
      expect(
        await rows(
          pool,
          "SELECT policy FROM community.publication_setting WHERE id = 'publication'",
        ),
      ).toEqual([{ policy: "DIRECT_PUBLICATION" }]);
    });

    it("computes effective third-party visibility with one predicate", async () => {
      const client = await pool.connect();
      const isPublic = async (id: string) =>
        (
          await client.query<{ visible: boolean }>(
            "SELECT community.work_is_public(w) AS visible FROM community.works w WHERE w.id = $1",
            [id],
          )
        ).rows[0]?.visible;
      try {
        await client.query("BEGIN");
        expect(await isPublic(works.single)).toBe(true);
        expect(await isPublic(works.textOnly)).toBe(true);
        expect(await isPublic(works.hidden)).toBe(false);
        expect(await isPublic(works.deleted)).toBe(false);
        await client.query(
          "UPDATE community.works SET visibility = 'self' WHERE id = $1",
          [works.single],
        );
        expect(await isPublic(works.single)).toBe(false);
        await client.query(
          "UPDATE community.works SET trashed_at = CURRENT_TIMESTAMP, trash_purge_after = CURRENT_TIMESTAMP + interval '30 days' WHERE id = $1",
          [works.triple],
        );
        expect(await isPublic(works.triple)).toBe(false);
        await client.query(
          "UPDATE community.works SET operator_state = 'removed' WHERE id = $1",
          [works.otherAuthor],
        );
        expect(await isPublic(works.otherAuthor)).toBe(false);
        const unpublished = opaque("work");
        await client.query(
          "INSERT INTO community.works(id, author_id, title, text, created_via, first_submitted_at) VALUES($1, $2, '', '', 'publishing', CURRENT_TIMESTAMP)",
          [unpublished, author],
        );
        expect(await isPublic(unpublished)).toBe(false);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });

    it("replaces the Phase 4 title check so an empty title fits and 201 code points do not", async () => {
      expect(
        await rows(
          pool,
          "SELECT conname FROM pg_constraint WHERE conrelid = 'community.works'::regclass AND contype = 'c' AND conname LIKE 'works_title%' ORDER BY conname",
        ),
      ).toEqual([{ conname: "works_title_publishing_check" }]);
      const client = await pool.connect();
      const insert = (title: string) =>
        client.query(
          "INSERT INTO community.works(id, author_id, title, text, created_via) VALUES($1, $2, $3, '', 'publishing')",
          [opaque("work"), author, title],
        );
      try {
        await client.query("BEGIN");
        await insert("");
        await insert("𠀀".repeat(200));
        await client.query("SAVEPOINT too_long");
        await expect(insert("𠀀".repeat(201))).rejects.toMatchObject({
          code: "23514",
          constraint: "works_title_publishing_check",
        });
        await client.query("ROLLBACK TO SAVEPOINT too_long");
        await client.query("SAVEPOINT untrimmed");
        await expect(insert(" 标题")).rejects.toMatchObject({
          code: "23514",
          constraint: "works_title_publishing_check",
        });
        await client.query("ROLLBACK TO SAVEPOINT untrimmed");
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });

    it("records the full manifest once and treats a rerun as a no-op", async () => {
      expect(await runCommunityMigrations(pool, migrationsDirectory)).toEqual(
        [],
      );
      expect(
        await rows(
          pool,
          'SELECT migration_id AS "migrationId", filename, checksum FROM community.schema_migrations ORDER BY migration_id',
        ),
      ).toEqual(requiredCommunityMigrations);
      expect(
        await rows(
          pool,
          "SELECT count(*)::int AS n FROM community.work_revisions",
        ),
      ).toEqual([{ n: 7 }]);
    });
  });

  describe("legacy media ownership guard", () => {
    it("rolls the backfill back when a retained work references another author's media", async () => {
      const pool = await createDedicatedDatabase("guard");
      await runCommunityMigrations(pool, migrationsDirectory, {
        through: phase4LastMigration,
      });
      const [owner, stranger] = [opaque("user"), opaque("user")];
      const [ownMedia, foreignMedia] = [
        opaque("user-media"),
        opaque("user-media"),
      ];
      const work = opaque("work");
      await pool.query(
        "INSERT INTO community.public_users(id, handle, display_name) VALUES($1, $2, '合成作者'), ($3, $4, '合成作者')",
        [
          owner,
          `wp-guard-${owner.slice(-8)}`,
          stranger,
          `wp-guard-${stranger.slice(-8)}`,
        ],
      );
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      await pool.query(
        "INSERT INTO community.user_media(id, owner_id, mime_type, width, height, sha256, bytes) VALUES($1, $2, 'image/png', 1, 1, $5, $6), ($3, $4, 'image/png', 1, 1, $5, $6)",
        [ownMedia, owner, foreignMedia, stranger, sha256(bytes), bytes],
      );
      await pool.query(
        "INSERT INTO community.works(id, author_id, title, text, media_ids, first_published_at) VALUES($1, $2, '合成', '', $3, CURRENT_TIMESTAMP)",
        [work, owner, [ownMedia, foreignMedia]],
      );
      await expect(
        runCommunityMigrations(pool, migrationsDirectory),
      ).rejects.toBeInstanceOf(CommunityMigrationStateError);
      expect(
        await rows(
          pool,
          "SELECT migration_id FROM community.schema_migrations WHERE migration_id >= '20260914000000' ORDER BY migration_id",
        ),
      ).toEqual(
        workPublishingMigrations
          .slice(0, 2)
          .map((migration_id) => ({ migration_id })),
      );
      expect(
        await rows(
          pool,
          "SELECT (SELECT count(*)::int FROM community.work_revisions) AS revisions, (SELECT count(*)::int FROM community.media_items) AS items",
        ),
      ).toEqual([{ revisions: 0, items: 0 }]);
      await pool.query(
        "UPDATE community.works SET media_ids = $1 WHERE id = $2",
        [[ownMedia], work],
      );
      expect(await runCommunityMigrations(pool, migrationsDirectory)).toEqual(
        workPublishingMigrations.slice(2),
      );
      expect(
        await rows(
          pool,
          "SELECT public_revision_id FROM community.works WHERE id = $1",
          [work],
        ),
      ).toEqual([{ public_revision_id: legacyRevision(work) }]);
    });
  });

  describe("legacy bridge for Phase 4 style inserts after the backfill", () => {
    it("bridges works inserted between the backfill and the bridge, and every later direct insert", async () => {
      const pool = await createDedicatedDatabase("upgrade");
      expect(
        await runCommunityMigrations(pool, migrationsDirectory, {
          through: backfillMigration,
        }),
      ).toEqual(
        requiredCommunityMigrations
          .map(({ migrationId }) => migrationId)
          .filter((id) => id <= backfillMigration),
      );
      const author = opaque("user");
      await pool.query(
        "INSERT INTO community.public_users(id, handle, display_name) VALUES($1, $2, '合成作者')",
        [author, `wp-bridge-${author.slice(-8)}`],
      );
      const [firstMedia, secondMedia] = [
        opaque("user-media"),
        opaque("user-media"),
      ];
      for (const [mediaId, seed] of [
        [firstMedia, 1],
        [secondMedia, 2],
      ] as const) {
        const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, seed]);
        await pool.query(
          "INSERT INTO community.user_media(id, owner_id, mime_type, width, height, sha256, bytes, created_at) VALUES($1, $2, 'image/png', $3, $4, $5, $6, '2026-02-01T00:00:00Z')",
          [mediaId, author, 10 * seed, 20 * seed, sha256(bytes), bytes],
        );
      }
      // The acceptance seed's own statement shape (no created_via, no revision).
      const insertPhase4Work = (
        id: string,
        title: string,
        mediaIds: readonly string[],
        deletedAt: string | null = null,
      ) =>
        pool.query(
          "INSERT INTO community.works(id, author_id, title, text, media_ids, first_published_at, updated_at, version, operator_state, deleted_at, synthetic_provenance) VALUES($1, $2, $3, '正文', $4, '2026-03-01T08:00:00Z', '2026-03-02T08:00:00Z', 1, 'visible', $5, 'work-publishing-bridge-test')",
          [id, author, title, [...mediaIds], deletedAt],
        );
      const between = opaque("work");
      await insertPhase4Work(between, "迁移之间", [secondMedia, firstMedia]);
      const unbridged = await rows<{
        public_revision_id: string | null;
        visible: boolean;
      }>(
        pool,
        "SELECT w.public_revision_id, community.work_is_public(w) AS visible FROM community.works w WHERE id = $1",
        [between],
      );
      expect(unbridged).toEqual([{ public_revision_id: null, visible: false }]);

      expect(await runCommunityMigrations(pool, migrationsDirectory)).toEqual(
        workPublishingMigrations.filter((id) => id > backfillMigration),
      );
      const expectBridged = async (
        workId: string,
        title: string,
        mediaIds: readonly string[],
      ) => {
        const revisionId = legacyRevision(workId);
        expect(
          await rows(
            pool,
            "SELECT w.public_revision_id, w.author_revision_id, w.created_via, w.version, w.updated_at, w.first_published_at, w.first_submitted_at, community.work_is_public(w) AS visible FROM community.works w WHERE id = $1",
            [workId],
          ),
        ).toEqual([
          {
            public_revision_id: revisionId,
            author_revision_id: revisionId,
            created_via: "legacy",
            version: 1,
            updated_at: new Date("2026-03-02T08:00:00Z"),
            first_published_at: new Date("2026-03-01T08:00:00Z"),
            first_submitted_at: new Date("2026-03-01T08:00:00Z"),
            visible: true,
          },
        ]);
        const expectedItems = firstOccurrences(mediaIds).map(legacyItem);
        expect(
          await rows(
            pool,
            "SELECT r.origin, r.disposition, r.sequence, r.cover_item_id, r.authorship_kind, r.reference_title, r.original_author, r.source_note, r.content_sha256, (SELECT array_agg(i.item_id ORDER BY i.position) FROM community.work_revision_items i WHERE i.revision_id = r.id) AS items, (SELECT array_agg(f.item_id ORDER BY f.item_id) FROM community.media_item_refs f WHERE f.holder_kind = 'revision' AND f.holder_id = r.id) AS refs FROM community.work_revisions r WHERE r.work_id = $1",
            [workId],
          ),
        ).toEqual([
          {
            origin: "legacy",
            disposition: "approved",
            sequence: 1,
            cover_item_id: expectedItems[0] ?? null,
            authorship_kind: null,
            reference_title: null,
            original_author: null,
            source_note: null,
            content_sha256: sha256(
              legacyCanonicalContent(title, "正文", expectedItems),
            ),
            items: expectedItems.length === 0 ? null : expectedItems,
            refs: expectedItems.length === 0 ? null : [...expectedItems].sort(),
          },
        ]);
        // No read claims an authorship the Phase 4 author never declared.
        for (const viewer of [author, null])
          expect(
            await new PostgresAuthorCommunityAdapter(pool).readWork(
              workId,
              viewer,
            ),
          ).not.toHaveProperty("authorship");
      };
      // The bridge migration's one-time pass covers the work written between.
      await expectBridged(between, "迁移之间", [secondMedia, firstMedia]);

      // After the bridge, the trigger covers every later direct insert.
      const later = opaque("work");
      await insertPhase4Work(later, "迁移之后", [
        firstMedia,
        secondMedia,
        firstMedia,
      ]);
      await expectBridged(later, "迁移之后", [
        firstMedia,
        secondMedia,
        firstMedia,
      ]);
      const textOnly = opaque("work");
      await insertPhase4Work(textOnly, "只有文字", []);
      await expectBridged(textOnly, "只有文字", []);
      // Shared user media stays one legacy item per (owner, media).
      expect(
        await rows(
          pool,
          "SELECT id, legacy_media_id, state, quality_mode, source FROM community.media_items ORDER BY legacy_media_id",
        ),
      ).toEqual(
        [firstMedia, secondMedia].sort().map((mediaId) => ({
          id: legacyItem(mediaId),
          legacy_media_id: mediaId,
          state: "ready",
          quality_mode: "legacy",
          source: "legacy_user_media",
        })),
      );
      // Deleted and publishing-path rows are never bridged.
      const deleted = opaque("work");
      await insertPhase4Work(
        deleted,
        "已删除",
        [firstMedia],
        "2026-04-01T00:00:00Z",
      );
      const publishing = opaque("work");
      await pool.query(
        "INSERT INTO community.works(id, author_id, title, text, created_via, visibility, first_submitted_at) VALUES($1, $2, '', '正文', 'publishing', 'self', CURRENT_TIMESTAMP)",
        [publishing, author],
      );
      expect(
        await rows(
          pool,
          "SELECT id, public_revision_id FROM community.works WHERE id = ANY($1::text[]) ORDER BY id",
          [[deleted, publishing]],
        ),
      ).toEqual(
        [deleted, publishing]
          .sort()
          .map((id) => ({ id, public_revision_id: null })),
      );
      expect(await runCommunityMigrations(pool, migrationsDirectory)).toEqual(
        [],
      );
    });
  });

  describe("legacy authorship migration", () => {
    it("stops legacy baselines claiming original while every declared revision keeps its content identity", async () => {
      const pool = await createDedicatedDatabase("upgrade");
      expect(
        await runCommunityMigrations(pool, migrationsDirectory, {
          through: bridgeMigration,
        }),
      ).toEqual(
        requiredCommunityMigrations
          .map(({ migrationId }) => migrationId)
          .filter((id) => id <= bridgeMigration),
      );
      const author = opaque("user");
      await pool.query(
        "INSERT INTO community.public_users(id, handle, display_name) VALUES($1, $2, '合成作者')",
        [author, `wp-authorship-${author.slice(-8)}`],
      );
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 7]);
      const mediaId = opaque("user-media");
      await pool.query(
        "INSERT INTO community.user_media(id, owner_id, mime_type, width, height, sha256, bytes, created_at) VALUES($1, $2, 'image/png', 12, 34, $3, $4, '2026-02-01T00:00:00Z')",
        [mediaId, author, sha256(png), png],
      );
      // A Phase 4 style insert bridged by the previous function body.
      const legacyWork = opaque("work");
      await pool.query(
        "INSERT INTO community.works(id, author_id, title, text, media_ids, first_published_at, updated_at, synthetic_provenance) VALUES($1, $2, '旧作', '旧文', $3, '2026-03-01T08:00:00Z', '2026-03-02T08:00:00Z', 'work-publishing-authorship-test')",
        [legacyWork, author, [mediaId]],
      );
      const legacyItems = [legacyItem(mediaId)];
      const [bridged] = await rows<{
        authorship_kind: string | null;
        content_sha256: string;
      }>(
        pool,
        "SELECT authorship_kind, content_sha256 FROM community.work_revisions WHERE id = $1",
        [legacyRevision(legacyWork)],
      );
      expect(bridged?.authorship_kind).toBe("original");

      // Explicit submissions with every declared authorship shape, hashed by
      // the one definition before the migration.
      const work = opaque("work");
      await pool.query(
        "INSERT INTO community.works(id, author_id, title, text, created_via, visibility, first_submitted_at) VALUES($1, $2, '', '', 'publishing', 'public', '2026-04-01T00:00:00Z')",
        [work, author],
      );
      const item = opaque("media-item");
      await pool.query(
        "INSERT INTO community.media_items(id, owner_id, kind, quality_mode, source, state, presentation) VALUES($1, $2, 'static', 'standard', 'upload', 'ready', '{\"width\":640,\"height\":480}')",
        [item, author],
      );
      const submissions = [
        ["original", null, null, null, null, null],
        [
          "copy_practice",
          "兰亭序",
          "王羲之",
          "第一行\n第二行",
          item,
          { x: 0, y: 0.25, width: 1, height: 0.5 },
        ],
        ["material_sharing", null, "佚名", null, item, null],
      ] as const;
      const submitted: { id: string; sha: string }[] = [];
      for (const [index, entry] of submissions.entries()) {
        const [kind, reference, original, source, coverItem, coverCrop] = entry;
        const id = opaque("work-revision");
        const items = JSON.stringify(
          coverItem === null
            ? []
            : [{ itemId: coverItem, edit: { rotation: 90, crop: null } }],
        );
        await pool.query(
          `INSERT INTO community.work_revisions(id, work_id, author_id, sequence, origin, title, body, authorship_kind, reference_title, original_author, source_note, requested_visibility, cover_item_id, cover_crop, content_sha256, disposition, submitted_at, request_id)
           VALUES($1, $2, $3, $4, 'submission', $5, '正文', $6, $7, $8, $9, 'public', $10, $11::jsonb,
             community.work_content_sha256($5, '正文', $6, $7, $8, $9, $12::jsonb, $10, $11::jsonb),
             'superseded', '2026-04-01T00:00:00Z', gen_random_uuid())`,
          [
            id,
            work,
            author,
            index + 1,
            `提交 ${index + 1}`,
            kind,
            reference,
            original,
            source,
            coverItem,
            coverCrop === null ? null : JSON.stringify(coverCrop),
            items,
          ],
        );
        if (coverItem !== null)
          await pool.query(
            "INSERT INTO community.work_revision_items(revision_id, position, item_id, edit) VALUES($1, 1, $2, $3)",
            [id, coverItem, { rotation: 90, crop: null }],
          );
        const [row] = await rows<{ content_sha256: string }>(
          pool,
          "SELECT content_sha256 FROM community.work_revisions WHERE id = $1",
          [id],
        );
        submitted.push({ id, sha: row!.content_sha256 });
      }
      // Snapshots and drafts: only legacy draft snapshots lose the claim.
      const content = (kind: string) => ({
        title: "草稿",
        body: "",
        authorship: { kind },
        visibility: "public",
        items: [],
        coverKey: null,
        coverCrop: null,
      });
      const [legacyDraft, savedSnapshot] = [
        opaque("work-snapshot"),
        opaque("work-snapshot"),
      ];
      await pool.query(
        "INSERT INTO community.work_draft_snapshots(id, owner_id, work_id, kind, content, source_revision, pinned) VALUES($1, $3, $4, 'legacy_draft', $5, 1, TRUE), ($2, $3, $4, 'saved', $5, 1, FALSE)",
        [legacyDraft, savedSnapshot, author, legacyWork, content("original")],
      );
      const draft = opaque("work-draft");
      await pool.query(
        "INSERT INTO community.work_drafts(id, owner_id, content, content_sha256) VALUES($1, $2, $3, $4)",
        [draft, author, content("original"), "b".repeat(64)],
      );
      // Edit drafts of legacy baselines opened before the migration were
      // seeded with the old default. One stays untouched (Save now on
      // unchanged content keeps revision 1 and records a saved snapshot of
      // it); the other is saved with a change, so its later content is the
      // author's.
      const publishing = new PostgresWorkPublishingAdapter(pool);
      const editedWork = opaque("work");
      await pool.query(
        "INSERT INTO community.works(id, author_id, title, text, media_ids, first_published_at, updated_at, synthetic_provenance) VALUES($1, $2, '另一旧作', '', $3, '2026-03-03T08:00:00Z', '2026-03-03T08:00:00Z', 'work-publishing-authorship-test')",
        [editedWork, author, [mediaId]],
      );
      // Freeze pre-20260914094000 rows instead of calling a current adapter
      // against a historical schema. Real adapter coverage resumes after upgrade.
      const seedLegacyEditDraft = async (
        workId: string,
        changedTitle?: string,
      ) => {
        const id = opaque("work-draft");
        const [base] = await rows<{ content: Record<string, unknown> }>(
          pool,
          `SELECT jsonb_build_object(
             'title', r.title, 'body', r.body, 'authorship', jsonb_build_object('kind', r.authorship_kind),
             'visibility', 'public', 'items', COALESCE((
               SELECT jsonb_agg(jsonb_build_object('key', i.item_id, 'itemId', i.item_id,
                 'kind', m.kind, 'qualityMode', m.quality_mode, 'edit', i.edit) ORDER BY i.position)
               FROM community.work_revision_items i JOIN community.media_items m ON m.id=i.item_id
               WHERE i.revision_id=r.id), '[]'::jsonb),
             'coverKey', r.cover_item_id, 'coverCrop', r.cover_crop) AS content
           FROM community.work_revisions r WHERE r.id=$1`,
          [legacyRevision(workId)],
        );
        const original = base!.content;
        const current = changedTitle
          ? { ...original, title: changedTitle }
          : original;
        const revision = changedTitle ? 2 : 1;
        await pool.query(
          `INSERT INTO community.work_drafts(id,owner_id,work_id,base_revision_id,revision,content,content_sha256,device_class,created_at,updated_at)
           VALUES($1,$2,$3,$4,$5,$6::jsonb,encode(sha256(convert_to(($6::jsonb)::text,'UTF8')),'hex'),'phone',
             '2026-09-14T01:00:00Z',$7::timestamptz)`,
          [
            id,
            author,
            workId,
            legacyRevision(workId),
            revision,
            JSON.stringify(current),
            changedTitle ? "2026-09-14T01:02:00Z" : "2026-09-14T01:00:00Z",
          ],
        );
        for (const [index, saved] of (changedTitle
          ? [original, current]
          : [original]
        ).entries())
          await pool.query(
            `INSERT INTO community.work_draft_snapshots(id,owner_id,draft_id,work_id,kind,content,source_revision,created_at)
             VALUES($1,$2,$3,$4,'saved',$5::jsonb,$6,$7::timestamptz)`,
            [
              opaque("work-snapshot"),
              author,
              id,
              workId,
              JSON.stringify(saved),
              index + 1,
              index === 0 ? "2026-09-14T01:01:00Z" : "2026-09-14T01:02:00Z",
            ],
          );
        return { id };
      };
      const untouched = await seedLegacyEditDraft(legacyWork);
      const changed = await seedLegacyEditDraft(editedWork, "另一旧作（改）");
      const draftTimes = await rows<{ id: string; updated_at: Date }>(
        pool,
        "SELECT id, updated_at FROM community.work_drafts WHERE id = ANY($1::text[]) ORDER BY id",
        [[untouched.id, changed.id]],
      );

      expect(await runCommunityMigrations(pool, migrationsDirectory)).toEqual([
        "20260914094000",
        "20260915010000",
        "20260916010000",
        "20260916011000",
        "20260917010000",
        "20260917020000",
        "20260918010000",
        "20260918020000",
        "20260918030000",
        "20260918040000",
        "20260918050000",
        "20260920010000",
        "20260920020000",
        "20260920050000",
        "20260920060000",
        "20260920070000",
        "20260920080000",
        "20260921010000",
        "20260922010000",
        "20260922011000",
        "20260922020000",
        "20260922030000",
        "20260922031000",
        "20260922032000",
        "20260930010000",
        "20260930020000",
        "20260930030000",
        "20260930040000",
        "20261001010000",
      ]);

      // Declared submissions: stored hashes unchanged and still exactly what
      // the definition computes from the stored revision.
      const recomputed = await rows<{
        id: string;
        authorship_kind: string | null;
        content_sha256: string;
        matches: boolean;
      }>(
        pool,
        `SELECT r.id, r.authorship_kind, r.content_sha256, r.content_sha256 = community.work_content_sha256(
           r.title, r.body, r.authorship_kind, r.reference_title, r.original_author, r.source_note,
           COALESCE((SELECT jsonb_agg(jsonb_build_object('itemId', i.item_id, 'edit', i.edit) ORDER BY i.position)
                     FROM community.work_revision_items i WHERE i.revision_id = r.id), '[]'::jsonb),
           r.cover_item_id, r.cover_crop) AS matches
         FROM community.work_revisions r WHERE r.work_id = ANY($1::text[]) ORDER BY r.work_id = $2 DESC, r.sequence`,
        [[work, legacyWork], work],
      );
      expect(recomputed).toEqual([
        ...submitted.map(({ id, sha }, index) => ({
          id,
          authorship_kind: submissions[index]![0],
          content_sha256: sha,
          matches: true,
        })),
        {
          id: legacyRevision(legacyWork),
          authorship_kind: null,
          content_sha256: sha256(
            legacyCanonicalContent("旧作", "旧文", legacyItems),
          ),
          matches: true,
        },
      ]);
      // The legacy hash changed only by the authorship claim.
      expect(bridged?.content_sha256).not.toBe(recomputed[3]?.content_sha256);
      expect(bridged?.content_sha256).toBe(
        sha256(
          legacyCanonicalContent("旧作", "旧文", legacyItems).replace(
            "null, null, null, null",
            '"original", null, null, null',
          ),
        ),
      );
      expect(
        await rows(
          pool,
          "SELECT id, content -> 'authorship' AS authorship FROM community.work_draft_snapshots WHERE id = ANY($1::text[]) UNION ALL SELECT id, content -> 'authorship' FROM community.work_drafts WHERE id = $2 ORDER BY id",
          [[legacyDraft, savedSnapshot], draft],
        ),
      ).toEqual(
        [
          { id: legacyDraft, authorship: null },
          { id: savedSnapshot, authorship: { kind: "original" } },
          { id: draft, authorship: { kind: "original" } },
        ].sort((left, right) => (left.id < right.id ? -1 : 1)),
      );
      // The untouched seeded draft and every snapshot of its seeded content
      // lose the default, with the adapter's content hash; the draft keeps its
      // revision and time. The changed draft and its later snapshot keep what
      // the author saved.
      expect(
        await rows(
          pool,
          `SELECT id, revision, content -> 'authorship' AS authorship, updated_at,
             content_sha256 = encode(sha256(convert_to(content::text, 'UTF8')), 'hex') AS hashed
           FROM community.work_drafts WHERE id = ANY($1::text[]) ORDER BY id`,
          [[untouched.id, changed.id]],
        ),
      ).toEqual(
        draftTimes.map(({ id, updated_at }) => ({
          id,
          revision: id === untouched.id ? 1 : 2,
          authorship: id === untouched.id ? null : { kind: "original" },
          updated_at,
          hashed: true,
        })),
      );
      expect(
        await rows(
          pool,
          "SELECT draft_id, kind, source_revision, content -> 'authorship' AS authorship FROM community.work_draft_snapshots WHERE draft_id = ANY($1::text[]) ORDER BY draft_id = $2 DESC, source_revision",
          [[untouched.id, changed.id], untouched.id],
        ),
      ).toEqual([
        {
          draft_id: untouched.id,
          kind: "saved",
          source_revision: 1,
          authorship: null,
        },
        {
          draft_id: changed.id,
          kind: "saved",
          source_revision: 1,
          authorship: null,
        },
        {
          draft_id: changed.id,
          kind: "saved",
          source_revision: 2,
          authorship: { kind: "original" },
        },
      ]);
      // The same draft opens without a claim, the editable work points at it,
      // and saving what it shows is no change (its stored hash is the one the
      // adapter computes).
      const reopened = await publishing.openEditDraft(
        author,
        legacyWork,
        { requestId: randomUUID(), deviceClass: "desktop" },
        new Date("2026-09-14T02:00:00.000Z"),
      );
      expect(reopened).toMatchObject({
        created: false,
        draft: { id: untouched.id, revision: 1, content: { authorship: null } },
      });
      expect(
        await publishing.readEditableWork(author, legacyWork),
      ).toMatchObject({ draftId: untouched.id, content: { authorship: null } });
      expect(
        await publishing.saveDraft(
          author,
          untouched.id,
          {
            baseRevision: 1,
            content: reopened.draft.content,
            deviceClass: "desktop",
          },
          new Date("2026-09-14T02:01:00.000Z"),
        ),
      ).toMatchObject({
        status: "saved",
        draft: { revision: 1, content: { authorship: null } },
      });

      // Not set carries no references; a submission may declare nothing.
      const client = await pool.connect();
      const insert = (reference: string | null) =>
        client.query(
          `INSERT INTO community.work_revisions(id, work_id, author_id, sequence, origin, title, body, authorship_kind, reference_title, requested_visibility, content_sha256, disposition, submitted_at, request_id)
           VALUES($1, $2, $3, 9, 'submission', '', '正文', NULL, $4, 'self', $5, 'not_required', CURRENT_TIMESTAMP, gen_random_uuid())`,
          [opaque("work-revision"), work, author, reference, "a".repeat(64)],
        );
      try {
        await client.query("BEGIN");
        await client.query("SAVEPOINT reference_without_kind");
        await expect(insert("兰亭序")).rejects.toMatchObject({
          code: "23514",
          constraint: "work_revisions_authorship_references_need_kind",
        });
        await client.query("ROLLBACK TO SAVEPOINT reference_without_kind");
        await insert(null);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }

      // Later Phase 4 style inserts are bridged without a claim.
      const later = opaque("work");
      await pool.query(
        "INSERT INTO community.works(id, author_id, title, text, media_ids, first_published_at, updated_at, synthetic_provenance) VALUES($1, $2, '新旧作', '', $3, '2026-03-05T08:00:00Z', '2026-03-05T08:00:00Z', 'work-publishing-authorship-test')",
        [later, author, [mediaId]],
      );
      expect(
        await rows(
          pool,
          "SELECT authorship_kind, content_sha256 FROM community.work_revisions WHERE id = $1",
          [legacyRevision(later)],
        ),
      ).toEqual([
        {
          authorship_kind: null,
          content_sha256: sha256(
            legacyCanonicalContent("新旧作", "", legacyItems),
          ),
        },
      ]);
      const authors = new PostgresAuthorCommunityAdapter(pool);
      for (const workId of [legacyWork, later])
        expect(await authors.readWork(workId, null)).not.toHaveProperty(
          "authorship",
        );
      expect(await runCommunityMigrations(pool, migrationsDirectory)).toEqual(
        [],
      );
    });
  });

  describe("clean install", () => {
    let pool: Pool;

    beforeAll(async () => {
      pool = await createDedicatedDatabase("clean");
    });

    it("applies every community migration to an empty database and reruns as a no-op", async () => {
      expect(await runCommunityMigrations(pool, migrationsDirectory)).toEqual(
        requiredCommunityMigrations.map(({ migrationId }) => migrationId),
      );
      expect(await runCommunityMigrations(pool, migrationsDirectory)).toEqual(
        [],
      );
      expect(
        await rows(
          pool,
          "SELECT publication_policy, version FROM community.work_publishing_settings",
        ),
      ).toEqual([{ publication_policy: "DIRECT_PUBLICATION", version: 1 }]);
      expect(
        await rows(
          pool,
          "SELECT (SELECT count(*)::int FROM community.work_revisions) AS revisions, (SELECT count(*)::int FROM community.media_items) AS items, (SELECT count(*)::int FROM community.work_draft_snapshots) AS snapshots",
        ),
      ).toEqual([{ revisions: 0, items: 0, snapshots: 0 }]);
    });

    it("links a publishing work to revisions of that work only", async () => {
      const client = await pool.connect();
      const user = opaque("user");
      const work = opaque("work");
      const foreignWork = opaque("work");
      const revision = opaque("work-revision");
      const foreignRevision = opaque("work-revision");
      const item = opaque("media-item");
      const insertRevision = (id: string, workId: string) =>
        client.query(
          `INSERT INTO community.work_revisions(id, work_id, author_id, sequence, origin, title, body, authorship_kind, requested_visibility, cover_item_id, content_sha256, disposition, submitted_at, request_id)
           VALUES($1, $2, $3, 1, 'submission', '', '正文', 'copy_practice', 'public', $4, $5, 'approved', CURRENT_TIMESTAMP, gen_random_uuid())`,
          [id, workId, user, item, "a".repeat(64)],
        );
      try {
        await client.query("BEGIN");
        await client.query(
          "INSERT INTO community.public_users(id, handle, display_name) VALUES($1, $2, '合成作者')",
          [user, `wp-clean-${user.slice(-8)}`],
        );
        await client.query(
          "INSERT INTO community.works(id, author_id, title, text, created_via, visibility, first_submitted_at) VALUES($1, $3, '', '正文', 'publishing', 'public', CURRENT_TIMESTAMP), ($2, $3, '', '其他', 'publishing', 'self', CURRENT_TIMESTAMP)",
          [work, foreignWork, user],
        );
        await client.query(
          "INSERT INTO community.media_items(id, owner_id, kind, quality_mode, source, state) VALUES($1, $2, 'static', 'standard', 'upload', 'ready')",
          [item, user],
        );
        await insertRevision(revision, work);
        await insertRevision(foreignRevision, foreignWork);
        await client.query(
          "INSERT INTO community.work_revision_items(revision_id, position, item_id, edit) VALUES($1, 1, $2, $3)",
          [revision, item, { rotation: 90, crop: null }],
        );
        await client.query(
          "UPDATE community.works SET public_revision_id = $1, author_revision_id = $1, first_published_at = CURRENT_TIMESTAMP WHERE id = $2",
          [revision, work],
        );
        expect(
          (
            await client.query<{ visible: boolean }>(
              "SELECT community.work_is_public(w) AS visible FROM community.works w WHERE id = $1",
              [work],
            )
          ).rows,
        ).toEqual([{ visible: true }]);
        await client.query("SAVEPOINT foreign_revision");
        await expect(
          client.query(
            "UPDATE community.works SET public_revision_id = $1 WHERE id = $2",
            [foreignRevision, work],
          ),
        ).rejects.toMatchObject({
          code: "23503",
          constraint: "works_public_revision_of_work",
        });
        await client.query("ROLLBACK TO SAVEPOINT foreign_revision");
        await client.query(
          "INSERT INTO community.publishing_jobs(id, kind, subject_id) VALUES($1, 'process_item', $2)",
          [opaque("publishing-job"), item],
        );
        await client.query("SAVEPOINT duplicate_job");
        await expect(
          client.query(
            "INSERT INTO community.publishing_jobs(id, kind, subject_id) VALUES($1, 'process_item', $2)",
            [opaque("publishing-job"), item],
          ),
        ).rejects.toMatchObject({
          code: "23505",
          constraint: "publishing_jobs_active_unique",
        });
        await client.query("ROLLBACK TO SAVEPOINT duplicate_job");
        const content = { title: "", body: "", items: [] };
        await client.query(
          "INSERT INTO community.work_drafts(id, owner_id, work_id, base_revision_id, content, content_sha256) VALUES($1, $2, $3, $4, $5, $6)",
          [opaque("work-draft"), user, work, revision, content, "b".repeat(64)],
        );
        await client.query("SAVEPOINT second_primary");
        await expect(
          client.query(
            "INSERT INTO community.work_drafts(id, owner_id, work_id, content, content_sha256) VALUES($1, $2, $3, $4, $5)",
            [opaque("work-draft"), user, work, content, "b".repeat(64)],
          ),
        ).rejects.toMatchObject({
          code: "23505",
          constraint: "work_drafts_active_primary_per_work",
        });
        await client.query("ROLLBACK TO SAVEPOINT second_primary");
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });

    it("enforces ownership, publication, trash, text and job invariants", async () => {
      const client = await pool.connect();
      const [owner, stranger] = [opaque("user"), opaque("user")];
      const [work, revision, ownMedia] = [
        opaque("work"),
        opaque("work-revision"),
        opaque("user-media"),
      ];
      const rejects = async (
        name: string,
        sql: string,
        values: readonly unknown[],
        expected: { code: string; constraint: string },
      ) => {
        await client.query(`SAVEPOINT ${name}`);
        await expect(client.query(sql, [...values])).rejects.toMatchObject(
          expected,
        );
        await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      };
      const revisionSql = `INSERT INTO community.work_revisions(id, work_id, author_id, sequence, origin, title, body, authorship_kind, requested_visibility, content_sha256, disposition, submitted_at)
        VALUES($1, $2, $3, $4, $5, $6, $7, 'original', 'public', $8, 'approved', CURRENT_TIMESTAMP)`;
      try {
        await client.query("BEGIN");
        await client.query(
          "INSERT INTO community.public_users(id, handle, display_name) VALUES($1, $2, '合成作者'), ($3, $4, '合成作者')",
          [
            owner,
            `wp-owner-${owner.slice(-8)}`,
            stranger,
            `wp-stranger-${stranger.slice(-8)}`,
          ],
        );
        const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
        await client.query(
          "INSERT INTO community.user_media(id, owner_id, mime_type, width, height, sha256, bytes) VALUES($1, $2, 'image/png', 1, 1, $3, $4)",
          [ownMedia, owner, sha256(bytes), bytes],
        );
        await client.query(
          "INSERT INTO community.works(id, author_id, title, text, created_via, visibility, first_submitted_at) VALUES($1, $2, '', '正文', 'publishing', 'public', CURRENT_TIMESTAMP)",
          [work, owner],
        );

        // Legacy media and revisions stay with their owner and author.
        await rejects(
          "foreign_legacy_media",
          "INSERT INTO community.media_items(id, owner_id, kind, quality_mode, source, legacy_media_id, state) VALUES($1, $2, 'static', 'legacy', 'legacy_user_media', $3, 'ready')",
          [opaque("media-item"), stranger, ownMedia],
          { code: "23503", constraint: "media_items_legacy_media_owned" },
        );
        await rejects(
          "foreign_author",
          revisionSql,
          [
            opaque("work-revision"),
            work,
            stranger,
            1,
            "submission",
            "",
            "正文",
            "a".repeat(64),
          ],
          { code: "23503", constraint: "work_revisions_work_authored" },
        );

        // Submissions store normalized text; legacy baselines keep Phase 4 text.
        for (const [name, title, body] of [
          ["title_lf", "上\n下", ""],
          ["title_cr", "上\r下", ""],
          ["body_cr", "", "甲\r\n乙"],
        ] as const) {
          await rejects(
            name,
            revisionSql,
            [
              opaque("work-revision"),
              work,
              owner,
              1,
              "submission",
              title,
              body,
              "a".repeat(64),
            ],
            {
              code: "23514",
              constraint: "work_revisions_submission_text_normalized",
            },
          );
        }
        await client.query(revisionSql, [
          opaque("work-revision"),
          work,
          owner,
          2,
          "legacy",
          "上\n下",
          "甲\r\n乙",
          "a".repeat(64),
        ]);
        await client.query(revisionSql, [
          revision,
          work,
          owner,
          1,
          "submission",
          "",
          "甲\n乙",
          "a".repeat(64),
        ]);

        // A public revision needs the first public exposure time.
        await rejects(
          "unpublished_public_revision",
          "UPDATE community.works SET public_revision_id = $1 WHERE id = $2",
          [revision, work],
          { code: "23514", constraint: "works_public_revision_published" },
        );
        await rejects(
          "unscheduled_trash",
          "UPDATE community.works SET trashed_at = CURRENT_TIMESTAMP WHERE id = $1",
          [work],
          { code: "23514", constraint: "works_trash_purge_scheduled" },
        );

        // Jobs stay listable through the operator DTO; NULL and {} collide.
        await rejects(
          "subject_format",
          "INSERT INTO community.publishing_jobs(id, kind, subject_id) VALUES($1, 'sweep_staging', 'Staging Area')",
          [opaque("publishing-job")],
          { code: "23514", constraint: "publishing_jobs_subject_bounded" },
        );
        await rejects(
          "attempts_bounded",
          "INSERT INTO community.publishing_jobs(id, kind, subject_id, max_attempts) VALUES($1, 'sweep_staging', 'staging', 1001)",
          [opaque("publishing-job")],
          { code: "23514", constraint: "publishing_jobs_attempts_bounded" },
        );
        await client.query(
          "INSERT INTO community.publishing_jobs(id, kind, subject_id, payload) VALUES($1, 'reconcile_capacity', $2, NULL)",
          [opaque("publishing-job"), owner],
        );
        await rejects(
          "empty_payload_duplicate",
          "INSERT INTO community.publishing_jobs(id, kind, subject_id, payload) VALUES($1, 'reconcile_capacity', $2, '{}')",
          [opaque("publishing-job"), owner],
          { code: "23505", constraint: "publishing_jobs_active_unique" },
        );

        // Every contract-valid metadata value fits the coarse storage cap,
        // even when jsonb writes its exponent numbers out in full.
        const values: Record<string, number[]> = {};
        const metadata = {
          provenance: { source: "client", parser: "exifr", status: "parsed" },
          values,
        };
        const limit = 16 * 1024;
        const serializedBytes = () =>
          Buffer.byteLength(JSON.stringify(metadata));
        for (let key = 0; serializedBytes() <= limit; key += 1) {
          const list: number[] = [];
          values[`k${key}`] = list;
          while (list.length < 64 && serializedBytes() <= limit)
            list.push(5e-324);
        }
        // Undo the one step that crossed the contract bound.
        const lastKey = `k${Object.keys(values).length - 1}`;
        if (values[lastKey]!.length > 0) values[lastKey]!.pop();
        else delete values[lastKey];
        expect(serializedBytes()).toBeLessThanOrEqual(limit);
        expect(mediaMetadataSchema.safeParse(metadata).success).toBe(true);
        const item = opaque("media-item");
        await client.query(
          "INSERT INTO community.media_items(id, owner_id, kind, quality_mode, source, state, private_metadata) VALUES($1, $2, 'static', 'standard', 'upload', 'processing', $3)",
          [item, owner, metadata],
        );
        const [stored] = (
          await client.query<{ bytes: number }>(
            "SELECT octet_length(private_metadata::text) AS bytes FROM community.media_items WHERE id = $1",
            [item],
          )
        ).rows;
        expect(stored?.bytes).toBeGreaterThan(limit * 32);
        expect(stored?.bytes).toBeLessThan(1024 * 1024);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });
  });
});
