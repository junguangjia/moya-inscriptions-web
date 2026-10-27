import { createHash, randomUUID } from "node:crypto";

import { createPublishingJobHandlers } from "@moya/backend-production/internal/publishing-job-handlers";
import { currentRecipe } from "@moya/backend-production/internal/publishing-processing";
import {
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import {
  PostgresArticleAuthoringAdapter,
  PostgresMediaPublicationAdapter,
  PostgresWorkPublishingAdapter,
} from "@moya/community-postgres";
import { emptyArticleDocument } from "@moya/contracts/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createCatalogScaleDatabase,
  type CatalogScaleDatabase,
} from "./catalog-scale-fixture.js";
import { requireSyntheticTestDatabaseUrl } from "./synthetic-test-database.js";

import type {
  ArticleAuthoringActor,
  MediaPublicationPlan,
  PublishingJobLease,
} from "@moya/api";
import type { PublicUserId } from "@moya/contracts";
import type {
  PublishingJobHandlerOptions,
  PublishingJobResult,
  PublishingWorkerJobClaim,
} from "@moya/backend-production/internal/publishing-job-handlers";

/*
 * account-deletion-v1 background purge (job `purge_deleted_account`), run
 * by the real job handler against the real adapter as the non-owner App
 * role: a deleted account's works (public, trashed, trash-purged, legacy),
 * drafts with conflict copies and snapshots, sessions, article drafts (live
 * ones, and ones the author had deleted, which kept their content), media,
 * profile images and receipts are erased with the existing purge
 * machinery queued for the bytes; feedback, comments and other accounts
 * stay untouched; a second run changes nothing; batches are bounded and an
 * interrupted batch rolls back whole and resumes; a follow another user
 * committed just after the deletion goes, while blocks other users set
 * against the account stay (r3). The deletion itself
 * (account-deletion.test.ts) is only mirrored here as its committed state:
 * status `deleted`, a pending deletion record and the queued job. Every
 * account, image and key is synthetic.
 */

type Pool = ReturnType<typeof createPostgresPool>;

const target = requireSyntheticTestDatabaseUrl();
let db: CatalogScaleDatabase;
let adapter: PostgresWorkPublishingAdapter;

const T0 = new Date("2126-10-27T12:00:00.000Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
const hex = () => randomUUID().replaceAll("-", "");
const opaque = (prefix: string) => `${prefix}-${hex()}`;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TOMBSTONE = { permanentlyDeleted: true };
const publicationOptions = { isPublic: () => true, allowPublish: () => true };
const silent = { info: () => undefined, error: () => undefined };
/** Key-sorted JSON, as the article fingerprint hashes its candidate. */
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [
              key,
              canonical((value as Record<string, unknown>)[key]),
            ]),
        )
      : value;
/** The fingerprint of an erased article draft (empty title, cover, body). */
const ERASED_FINGERPRINT = sha(
  JSON.stringify(
    canonical({
      title: "",
      coverRefId: null,
      document: emptyArticleDocument(),
    }),
  ),
);

const query = <T extends object = Record<string, unknown>>(
  sql: string,
  values: unknown[] = [],
) => db.setup.query<T>(sql, values).then((result) => result.rows);

const createUser = async (): Promise<string> => {
  const id = opaque("user");
  await db.setup.query(
    "INSERT INTO community.public_users(id,handle,display_name) VALUES($1,$2,'合成账号')",
    [id, `purge-${hex().slice(0, 20)}`],
  );
  return id;
};

/** A committed private blob; profile blobs have no owner. */
const createBlob = async (owner: string | null, purpose: string) => {
  const id = opaque("media-blob");
  const key = hex();
  const storageKey = `blobs/${key.slice(0, 2)}/${key.slice(2, 4)}/${key}`;
  await db.setup.query(
    "INSERT INTO community.media_blobs(id,owner_id,purpose,storage_key,byte_size,sha256,content_type,created_at) VALUES($1,$2,$3,$4,128,$5,'image/webp',$6)",
    [id, owner, purpose, storageKey, sha(id), at(-86_400)],
  );
  return { id, storageKey };
};

/** A ready uploaded item with one display rendition on a committed blob. */
const createItem = async (
  owner: string,
  purpose: "content" | "feedback" = "content",
) => {
  const id = opaque("media-item");
  await db.setup.query(
    `INSERT INTO community.media_items(id,owner_id,kind,quality_mode,source,state,presentation,ready_at,purpose)
     VALUES($1,$2,'static','standard','upload','ready','{"width":512,"height":384}',$3,$4)`,
    [id, owner, at(-86_400), purpose],
  );
  const blob = await createBlob(owner, "derivative");
  await db.setup.query(
    "INSERT INTO community.media_renditions(id,item_id,edit_key,role,recipe_version,recipe_digest,blob_id,width,height,content_type,created_at) VALUES($1,$2,'base','display',1,'1111111111111111',$3,512,384,'image/webp',$4)",
    [opaque("media-rendition"), id, blob.id, at(-86_400)],
  );
  return { id, storageKey: blob.storageKey };
};

/** A work with one approved public revision naming `items` (held by refs). */
const createWork = async (
  owner: string,
  items: readonly string[],
  visibility: "public" | "self" = "public",
) => {
  const work = opaque("work");
  const revision = opaque("work-revision");
  await db.setup.query(
    "INSERT INTO community.works(id,author_id,title,text,created_via,visibility,first_published_at) VALUES($1,$2,'合成作品','合成正文','publishing',$3,$4)",
    [work, owner, visibility, at(-86_400)],
  );
  await db.setup.query(
    `INSERT INTO community.work_revisions(id,work_id,author_id,sequence,origin,title,body,authorship_kind,requested_visibility,cover_item_id,content_sha256,disposition,submitted_at)
     VALUES($1,$2,$3,1,'submission','合成作品','合成正文','original',$4,$5,$6,'approved',$7)`,
    [
      revision,
      work,
      owner,
      visibility,
      items[0] ?? null,
      sha(revision),
      at(-86_400),
    ],
  );
  for (const [index, item] of items.entries()) {
    await db.setup.query(
      `INSERT INTO community.work_revision_items(revision_id,position,item_id,edit) VALUES($1,$2,$3,'{"rotation":0,"crop":null}')`,
      [revision, index + 1, item],
    );
    await db.setup.query(
      "INSERT INTO community.media_item_refs(item_id,holder_kind,holder_id) VALUES($1,'revision',$2)",
      [item, revision],
    );
  }
  await db.setup.query(
    "UPDATE community.works SET public_revision_id=$2,author_revision_id=$2,first_submitted_at=$3 WHERE id=$1",
    [work, revision, at(-86_400)],
  );
  return { work, revision };
};

/** A content-free self-only work (batch cases). */
const createBareWork = async (owner: string) => {
  const id = opaque("work");
  await db.setup.query(
    "INSERT INTO community.works(id,author_id,title,text,created_via,visibility) VALUES($1,$2,'合成批量','','publishing','self')",
    [id, owner],
  );
  return id;
};

const createUserMedia = async (owner: string) => {
  const id = opaque("user-media");
  const digest = sha(id);
  await db.setup.query(
    "INSERT INTO community.user_media(id,owner_id,mime_type,width,height,sha256,bytes) VALUES($1,$2,'image/png',1,1,$3,$4)",
    [id, owner, digest, PNG],
  );
  return { id, sha256: digest };
};

/** Records an avatar family for a profile image through the store. */
const renderAvatar = async (image: { id: string; sha256: string }) => {
  const rendition = (role: "avatar-128" | "avatar-512") => {
    const key = hex();
    return {
      storageKey: `blobs/${key.slice(0, 2)}/${key.slice(2, 4)}/${key}`,
      byteSize: 100,
      sha256: sha(key),
      role,
      recipeVersion: currentRecipe(role).version,
      recipeDigest: currentRecipe(role).digest,
      contentType: "image/webp" as const,
      width: role === "avatar-128" ? 128 : 512,
      height: role === "avatar-128" ? 128 : 512,
    };
  };
  expect(
    await adapter.recordProfileRenditions(
      image.id,
      {
        sourceSha256: image.sha256,
        renditions: [rendition("avatar-128"), rendition("avatar-512")],
      },
      at(-3_600),
    ),
  ).toEqual({ status: "recorded" });
};

/** A live public copy of a public work's item (the publication worker's commit). */
const publish = async (item: string) => {
  const publication = new PostgresMediaPublicationAdapter(
    db.setup,
    publicationOptions,
  );
  await db.setup.query(
    "INSERT INTO community.media_public_assets(id,item_id,desired_at,created_at,updated_at) VALUES($1,$2,$3,$3,$3)",
    [hex(), item, at(-7_200)],
  );
  const job = opaque("publishing-job");
  const lease: PublishingJobLease = { id: job, leaseOwner: hex() };
  await db.setup.query(
    "INSERT INTO community.publishing_jobs(id,kind,subject_id,max_attempts,run_after,created_at,updated_at) VALUES($1,'publish_media',$2,3,$3,$3,$3)",
    [job, item, at(-7_200)],
  );
  await db.setup.query(
    "UPDATE community.publishing_jobs SET state='running',attempts=1,lease_owner=$2,lease_expires_at=$3::timestamptz+interval '1 hour' WHERE id=$1",
    [job, lease.leaseOwner, at(-7_200)],
  );
  const plan: MediaPublicationPlan = await publication.planPublish(
    item,
    lease,
    at(-7_200),
  );
  if (plan.status !== "ready")
    throw new Error(`Unexpected plan ${plan.status}`);
  expect(plan.units).toHaveLength(1);
  expect(await publication.finishPublish(plan.fence, at(-7_200))).toBe(true);
  await publication.release(plan.fence, at(-7_200));
  await db.setup.query(
    "UPDATE community.publishing_jobs SET state='succeeded',lease_expires_at=NULL,finished_at=$2 WHERE id=$1",
    [job, at(-7_200)],
  );
};

/** The deletion transaction's committed state (account-deletion-v1 D2). */
const markDeleted = async (owner: string, deletedAt = T0) => {
  await db.setup.query(
    "UPDATE community.public_users SET status='deleted',display_name='已注销用户',bio='',updated_at=$2 WHERE id=$1",
    [owner, deletedAt],
  );
  await db.setup.query(
    "INSERT INTO community.account_deletions(user_id,request_key_hash,session_id,deleted_at) VALUES($1,$2,$3,$4)",
    [owner, sha(owner), `session-${hex()}`, deletedAt],
  );
};

const deletionOf = async (owner: string) =>
  (
    await query<{ purge_state: string; purge_completed_at: Date | null }>(
      "SELECT purge_state,purge_completed_at FROM community.account_deletions WHERE user_id=$1",
      [owner],
    )
  )[0];

const removedKeys: string[] = [];
const store = {
  remove: async (storageKey: string) => {
    removedKeys.push(storageKey);
  },
} as unknown as PublishingJobHandlerOptions["store"];
const cancelledTransfers: string[] = [];
const handlers = () =>
  createPublishingJobHandlers({
    port: adapter,
    store,
    logger: silent,
    clock: () => clock,
    onUploadsCancelled: (ids) => cancelledTransfers.push(...ids),
  });
let clock = T0;

/**
 * Claims and runs every due job of `kinds` as the worker records them
 * (complete, defer or fail). Deferred jobs wait past this `now`.
 */
const runQueued = async (
  kinds: readonly PublishingWorkerJobClaim["kind"][],
  now: Date,
): Promise<{ kind: string; result: PublishingJobResult }[]> => {
  clock = now;
  const run = handlers();
  const results: { kind: string; result: PublishingJobResult }[] = [];
  for (;;) {
    const claims = await adapter.claimJobs(
      {
        owner: `purge-it-${hex().slice(0, 8)}`,
        limit: 10,
        leaseMs: 300_000,
        kinds,
      },
      now,
    );
    if (claims.length === 0) return results;
    for (const claim of claims) {
      const result = await run.run(claim, new AbortController().signal);
      results.push({ kind: claim.kind, result });
      if (result.status === "completed") await adapter.completeJob(claim, now);
      else if (result.status === "deferred")
        await adapter.deferJob(claim, result.delayMs, now);
      else
        await adapter.failJob(claim, result.errorCode, now, {
          retryable: result.retryable,
        });
    }
  }
};

/** Everything the purge could still change for an account, for no-op checks. */
const accountState = async (owner: string) => ({
  works: await query(
    "SELECT id,version,updated_at,deleted_at,title,text FROM community.works WHERE author_id=$1 ORDER BY id",
    [owner],
  ),
  items: await query(
    "SELECT id,state,version,updated_at FROM community.media_items WHERE owner_id=$1 ORDER BY id",
    [owner],
  ),
  refs: await query(
    "SELECT r.item_id,r.holder_kind,r.holder_id FROM community.media_item_refs r JOIN community.media_items i ON i.id=r.item_id WHERE i.owner_id=$1 ORDER BY 1,2,3",
    [owner],
  ),
  images: await query(
    "SELECT id,deleted_at,octet_length(bytes) AS size FROM community.user_media WHERE owner_id=$1 ORDER BY id",
    [owner],
  ),
  renditions: await query(
    "SELECT r.id,r.state FROM community.media_renditions r JOIN community.user_media m ON m.id=r.user_media_id WHERE m.owner_id=$1 ORDER BY r.id",
    [owner],
  ),
  articles: await query(
    "SELECT id,version,deleted_at FROM community.article_documents WHERE owner_id=$1 ORDER BY id",
    [owner],
  ),
  sessions: await query(
    "SELECT id,state,ended_at,draft_id FROM community.publishing_sessions WHERE owner_id=$1 ORDER BY id",
    [owner],
  ),
  receipts: await query(
    "SELECT request_id,result FROM community.author_command_receipts WHERE actor_id=$1 ORDER BY request_id",
    [owner],
  ),
  jobs: await query(
    `SELECT kind,subject_id,state,run_after FROM community.publishing_jobs
     WHERE kind<>'purge_deleted_account' AND (subject_id=$1
       OR subject_id IN (SELECT id FROM community.media_items WHERE owner_id=$1))
     ORDER BY kind,subject_id,run_after`,
    [owner],
  ),
  deletion: await deletionOf(owner),
});

beforeAll(async () => {
  db = await createCatalogScaleDatabase({
    target,
    label: "acctpurge",
    openPool: (url) =>
      createPostgresPool(parsePostgresConfig({ DATABASE_URL: url })),
  });
  adapter = new PostgresWorkPublishingAdapter(db.app, {
    publication: publicationOptions,
  });
}, 120_000);
afterAll(async () => {
  await db?.close();
});

describe("deleted account purge under the real App role", () => {
  it("erases a deleted account's works, drafts, sessions, articles and media and queues their bytes", async () => {
    const subject = await createUser();
    const bystander = await createUser();

    // Works: public with a live public copy, trashed, trash-purged (title,
    // text and revision kept by the trash purge), legacy (bridge trigger).
    const shown = await createItem(subject);
    const publicWork = await createWork(subject, [shown.id]);
    await publish(shown.id);
    const trashedItem = await createItem(subject);
    const trashed = await createWork(subject, [trashedItem.id]);
    await db.setup.query(
      "UPDATE community.works SET trashed_at=$2,trash_purge_after=$3 WHERE id=$1",
      [trashed.work, at(-3_600), at(29 * 86_400)],
    );
    const formerItem = await createItem(subject);
    const former = await createWork(subject, [formerItem.id]);
    await db.setup.query(
      "DELETE FROM community.media_item_refs WHERE holder_id=$1",
      [former.revision],
    );
    await db.setup.query(
      "UPDATE community.works SET trashed_at=$2,trash_purge_after=$2,deleted_at=$3 WHERE id=$1",
      [former.work, at(-30 * 86_400), at(-86_400)],
    );
    const legacyImage = await createUserMedia(subject);
    const legacyWork = opaque("work");
    await db.setup.query(
      "INSERT INTO community.works(id,author_id,title,text,media_ids,first_published_at) VALUES($1,$2,'合成旧作','',ARRAY[$3],$4)",
      [legacyWork, subject, legacyImage.id, at(-86_400)],
    );

    // A draft with a conflict copy and a snapshot, all holding one item.
    const drafted = await createItem(subject);
    const draft = opaque("work-draft");
    const copy = opaque("work-draft");
    const snapshot = opaque("work-snapshot");
    const content = JSON.stringify({
      title: "合成草稿",
      items: [{ key: "k1", itemId: drafted.id }],
    });
    await db.setup.query(
      "INSERT INTO community.work_drafts(id,owner_id,content,content_sha256) VALUES($1,$2,$3::jsonb,$4)",
      [draft, subject, content, sha(content)],
    );
    await db.setup.query(
      "INSERT INTO community.work_drafts(id,owner_id,content,content_sha256,conflict_of) VALUES($1,$2,$3::jsonb,$4,$5)",
      [copy, subject, content, sha(content), draft],
    );
    await db.setup.query(
      "INSERT INTO community.work_draft_snapshots(id,owner_id,draft_id,kind,content) VALUES($1,$2,$3,'saved',$4::jsonb)",
      [snapshot, subject, draft, content],
    );
    for (const [kind, holder] of [
      ["draft", draft],
      ["draft", copy],
      ["snapshot", snapshot],
    ] as const)
      await db.setup.query(
        "INSERT INTO community.media_item_refs(item_id,holder_kind,holder_id) VALUES($1,$2,$3)",
        [drafted.id, kind, holder],
      );

    // An active unsaved session with an upload still streaming.
    const session = opaque("publishing-session");
    const streaming = opaque("media-item");
    const component = opaque("media-component");
    await db.setup.query(
      "INSERT INTO community.publishing_sessions(id,owner_id,save_mode,state,lease_expires_at) VALUES($1,$2,'unsaved','active',$3)",
      [session, subject, at(600)],
    );
    await db.setup.query(
      "INSERT INTO community.media_items(id,owner_id,kind,quality_mode,source,state,declared_total_bytes) VALUES($1,$2,'static','standard','upload','awaiting_upload',1000)",
      [streaming, subject],
    );
    await db.setup.query(
      "INSERT INTO community.media_components(id,item_id,owner_id,role,declared_bytes,declared_type,state,upload_attempt,received_bytes) VALUES($1,$2,$3,'still',1000,'image/jpeg','receiving',$4,10)",
      [component, streaming, subject, randomUUID()],
    );
    await db.setup.query(
      "INSERT INTO community.media_item_refs(item_id,holder_kind,holder_id) VALUES($1,'session',$2)",
      [streaming, session],
    );

    // An article draft with text and a cover image.
    const articleItem = await createItem(subject);
    const article = opaque("article");
    const coverRef = "cover";
    await db.setup.query(
      "INSERT INTO community.article_documents(id,owner_id,version,title,cover_ref_id,document,fingerprint,created_at,updated_at) VALUES($1,$2,1,'合成文章',$3,$4::jsonb,$5,$6,$6)",
      [
        article,
        subject,
        coverRef,
        JSON.stringify({
          ...emptyArticleDocument(),
          blocks: [
            {
              id: "start",
              type: "paragraph",
              props: {},
              content: [{ type: "text", text: "合成正文", styles: {} }],
              children: [],
            },
          ],
          references: {
            [coverRef]: { type: "managed", itemId: articleItem.id },
          },
        }),
        sha(article),
        at(-86_400),
      ],
    );
    await db.setup.query(
      "INSERT INTO community.media_item_refs(item_id,holder_kind,holder_id) VALUES($1,'article_draft',$2)",
      [articleItem.id, article],
    );

    // An article draft the author deleted while the account was live, through
    // the product's own command: that deletion keeps the stored title, text
    // and cover, and the draft-terminal trigger refuses its erasure as long
    // as the owner's account is not deleted.
    const authoring = new PostgresArticleAuthoringAdapter(db.app);
    const author: ArticleAuthoringActor = {
      source: "human",
      userId: subject as PublicUserId,
    };
    const endedItem = await createItem(subject);
    const ended = await authoring.create(
      author,
      {
        requestId: randomUUID(),
        title: "合成已删文章",
        coverRefId: coverRef,
        document: {
          ...emptyArticleDocument(),
          blocks: [
            {
              id: "start",
              type: "paragraph",
              props: {},
              content: [{ type: "text", text: "合成已删正文", styles: {} }],
              children: [],
            },
          ],
          references: {
            [coverRef]: { type: "managed", itemId: endedItem.id },
          },
        },
      },
      at(-7_200),
    );
    await authoring.deleteDraft(
      author,
      ended.id,
      { requestId: randomUUID(), expectedVersion: ended.version },
      at(-3_600),
    );
    const endedRow = () =>
      query(
        "SELECT owner_id,version,title,cover_ref_id,document,fingerprint,status,deleted_at FROM community.article_documents WHERE id=$1",
        [ended.id],
      );
    expect(await endedRow()).toMatchObject([
      {
        version: ended.version + 1,
        title: "合成已删文章",
        cover_ref_id: coverRef,
        deleted_at: at(-3_600),
      },
    ]);
    const eraseEnded = () =>
      db.app.query(
        "UPDATE community.article_documents SET version=version+1,updated_at=$2,title='',cover_ref_id=NULL,document=$3::jsonb,fingerprint=$4 WHERE id=$1",
        [
          ended.id,
          at(-1_800),
          JSON.stringify(emptyArticleDocument()),
          ERASED_FINGERPRINT,
        ],
      );
    await expect(eraseEnded()).rejects.toMatchObject({ code: "23000" });

    // Current and former avatars with renditions (the deletion clears the
    // pointer; the purge does not depend on it, so it stays set here).
    const avatar = await createUserMedia(subject);
    const formerAvatar = await createUserMedia(subject);
    await renderAvatar(avatar);
    await renderAvatar(formerAvatar);
    await db.setup.query(
      "UPDATE community.public_users SET avatar_media_id=$2 WHERE id=$1",
      [subject, avatar.id],
    );

    // Retained by decision: feedback with its image, and comments.
    const feedback = opaque("feedback");
    const feedbackItem = await createItem(subject, "feedback");
    await db.setup.query(
      "INSERT INTO community.feedback(id,user_id,submission_id,message) VALUES($1,$2,$3,'合成反馈')",
      [feedback, subject, randomUUID()],
    );
    await db.setup.query(
      "INSERT INTO community.feedback_images(feedback_id,item_id,position) VALUES($1,$2,0)",
      [feedback, feedbackItem.id],
    );
    await db.setup.query(
      "INSERT INTO community.media_item_refs(item_id,holder_kind,holder_id) VALUES($1,'feedback',$2)",
      [feedbackItem.id, feedback],
    );
    const comment = opaque("comment");
    const reply = opaque("comment");
    await db.setup.query(
      "INSERT INTO community.catalog_comments(id,catalog_id,author_id,text,moderation) VALUES($1,'purge-catalog',$2,'合成评论','visible'),($3,'purge-catalog',$4,'合成回应','visible')",
      [comment, subject, reply, bystander],
    );

    // Receipts that carried content.
    await db.setup.query(
      "INSERT INTO community.author_command_receipts(actor_id,request_id,fingerprint,result) VALUES($1,$2,$3,$4::jsonb),($1,$5,$6,$7::jsonb)",
      [
        subject,
        randomUUID(),
        sha("r1"),
        JSON.stringify({ workId: publicWork.work, title: "合成作品" }),
        randomUUID(),
        sha("r2"),
        JSON.stringify({ profile: { bio: "合成简介" } }),
      ],
    );

    // The bystander's public work, live copy, draft and image.
    const theirs = await createItem(bystander);
    const theirWork = await createWork(bystander, [theirs.id]);
    await publish(theirs.id);
    const theirImage = await createUserMedia(bystander);
    const theirDraft = opaque("work-draft");
    const theirContent = JSON.stringify({ title: "他人草稿", items: [] });
    await db.setup.query(
      "INSERT INTO community.work_drafts(id,owner_id,content,content_sha256) VALUES($1,$2,$3::jsonb,$4)",
      [theirDraft, bystander, theirContent, sha(theirContent)],
    );
    const bystanderBefore = await accountState(bystander);

    await markDeleted(subject);
    expect(
      (
        await adapter.enqueueJob(
          { kind: "purge_deleted_account", subjectId: subject },
          T0,
        )
      ).created,
    ).toBe(true);
    const ran = await runQueued(["purge_deleted_account"], at(1));
    expect(ran).toEqual([
      { kind: "purge_deleted_account", result: { status: "completed" } },
    ]);
    expect(await deletionOf(subject)).toEqual({
      purge_state: "completed",
      purge_completed_at: at(1),
    });
    // The streaming transfer was told to stop.
    expect(cancelledTransfers).toContain(component);

    // Every work is a content-free tombstone; the trash purge's deletion
    // time is kept.
    const works = await query<{
      id: string;
      title: string;
      text: string;
      media_ids: string[];
      public_revision_id: string | null;
      author_revision_id: string | null;
      deleted_at: Date | null;
      visibility: string;
    }>(
      "SELECT id,title,text,media_ids,public_revision_id,author_revision_id,deleted_at,visibility FROM community.works WHERE author_id=$1 ORDER BY id",
      [subject],
    );
    expect(works).toHaveLength(4);
    for (const work of works)
      expect(work).toMatchObject({
        title: "",
        text: "",
        media_ids: [],
        public_revision_id: null,
        author_revision_id: null,
        visibility: "self",
      });
    expect(works.find((work) => work.id === former.work)?.deleted_at).toEqual(
      at(-86_400),
    );
    expect(
      works.find((work) => work.id === publicWork.work)?.deleted_at,
    ).toEqual(at(1));
    expect(
      await query(
        "SELECT id FROM community.work_revisions WHERE author_id=$1",
        [subject],
      ),
    ).toEqual([]);
    for (const table of ["work_drafts", "work_draft_snapshots"])
      expect(
        await query(`SELECT id FROM community.${table} WHERE owner_id=$1`, [
          subject,
        ]),
      ).toEqual([]);
    expect(
      await query<{ state: string }>(
        "SELECT state FROM community.publishing_sessions WHERE id=$1",
        [session],
      ),
    ).toEqual([{ state: "discarded" }]);
    expect(
      await query("SELECT state FROM community.media_components WHERE id=$1", [
        component,
      ]),
    ).toEqual([{ state: "cancelled" }]);
    // The article draft ends, and its title, text and cover are emptied in
    // the same update (one version step; owner and identity unchanged).
    expect(
      await query(
        "SELECT owner_id,version,title,cover_ref_id,document,fingerprint,deleted_at FROM community.article_documents WHERE id=$1",
        [article],
      ),
    ).toEqual([
      {
        owner_id: subject,
        version: 2,
        title: "",
        cover_ref_id: null,
        document: emptyArticleDocument(),
        fingerprint: ERASED_FINGERPRINT,
        deleted_at: at(1),
      },
    ]);
    // The draft the author had deleted is emptied too: its deletion time,
    // owner and status stay, with one more version step.
    expect(await endedRow()).toEqual([
      {
        owner_id: subject,
        version: ended.version + 2,
        title: "",
        cover_ref_id: null,
        document: emptyArticleDocument(),
        fingerprint: ERASED_FINGERPRINT,
        status: "draft",
        deleted_at: at(-3_600),
      },
    ]);
    expect(
      JSON.stringify(
        await query(
          "SELECT * FROM community.article_documents WHERE owner_id=$1",
          [subject],
        ),
      ),
    ).not.toMatch(/合成文章|合成正文|合成已删文章|合成已删正文/u);
    // Nothing else may change a deleted draft, even of a deleted account.
    for (const [sql, values] of [
      [
        "UPDATE community.article_documents SET version=version+1,title='合成复活' WHERE id=$1",
        [ended.id],
      ],
      [
        "UPDATE community.article_documents SET version=version+1,deleted_at=NULL WHERE id=$1",
        [ended.id],
      ],
      [
        "UPDATE community.article_documents SET version=version+1,deleted_at=$2 WHERE id=$1",
        [ended.id, at(5)],
      ],
      [
        "UPDATE community.article_documents SET version=version+1,status='withdrawn' WHERE id=$1",
        [ended.id],
      ],
      [
        "UPDATE community.article_documents SET version=version+1,fingerprint=$2 WHERE id=$1",
        [ended.id, sha("synthetic")],
      ],
      [
        "UPDATE community.article_documents SET version=version+1,document=$2::jsonb WHERE id=$1",
        [
          ended.id,
          JSON.stringify({
            ...emptyArticleDocument(),
            references: { x: { type: "managed", itemId: endedItem.id } },
          }),
        ],
      ],
    ] as const)
      await expect(db.app.query(sql, [...values]), sql).rejects.toMatchObject({
        code: "23000",
      });

    // Media: everything but the feedback image is cancelled with its
    // purge due now; only the feedback ref is left.
    const legacyItem = (
      await query<{ id: string }>(
        "SELECT id FROM community.media_items WHERE legacy_media_id=$1",
        [legacyImage.id],
      )
    )[0]!.id;
    const erasedItems = [
      shown.id,
      trashedItem.id,
      formerItem.id,
      legacyItem,
      drafted.id,
      streaming,
      articleItem.id,
      endedItem.id,
    ].sort();
    expect(
      await query(
        "SELECT id,state FROM community.media_items WHERE owner_id=$1 ORDER BY id",
        [subject],
      ),
    ).toEqual(
      [...erasedItems, feedbackItem.id].sort().map((id) => ({
        id,
        state: id === feedbackItem.id ? "ready" : "cancelled",
      })),
    );
    expect(
      await query(
        "SELECT r.item_id,r.holder_kind FROM community.media_item_refs r JOIN community.media_items i ON i.id=r.item_id WHERE i.owner_id=$1",
        [subject],
      ),
    ).toEqual([{ item_id: feedbackItem.id, holder_kind: "feedback" }]);
    expect(
      (
        await query<{ subject_id: string }>(
          "SELECT subject_id FROM community.publishing_jobs WHERE kind='purge_item' AND state='queued' AND run_after<=$2 AND subject_id=ANY($1::text[]) ORDER BY subject_id",
          [erasedItems, at(1)],
        )
      ).map((row) => row.subject_id),
    ).toEqual(erasedItems);
    // The live public copy is withdrawn.
    expect(
      await query(
        "SELECT state FROM community.publishing_jobs WHERE kind='withdraw_media' AND subject_id=$1",
        [shown.id],
      ),
    ).toEqual([{ state: "queued" }]);

    // Every profile and legacy image keeps only its row; renditions go.
    const images = await query<{ size: number; deleted_at: Date | null }>(
      "SELECT octet_length(bytes) AS size,deleted_at FROM community.user_media WHERE owner_id=$1",
      [subject],
    );
    expect(images).toHaveLength(3);
    for (const image of images)
      expect(image).toEqual({ size: 0, deleted_at: at(1) });
    const renditions = await query<{ state: string }>(
      "SELECT r.state FROM community.media_renditions r JOIN community.user_media m ON m.id=r.user_media_id WHERE m.owner_id=$1",
      [subject],
    );
    expect(renditions).toHaveLength(4);
    expect(new Set(renditions.map((row) => row.state))).toEqual(
      new Set(["released"]),
    );
    expect(
      (
        await query<{ result: unknown }>(
          "SELECT result FROM community.author_command_receipts WHERE actor_id=$1",
          [subject],
        )
      ).map((row) => row.result),
      // The two seeded receipts and the deleted article's create and delete.
    ).toEqual([TOMBSTONE, TOMBSTONE, TOMBSTONE, TOMBSTONE]);

    // Retained: feedback, its image, both comments.
    expect(
      await query("SELECT message FROM community.feedback WHERE id=$1", [
        feedback,
      ]),
    ).toEqual([{ message: "合成反馈" }]);
    expect(
      await query(
        "SELECT author_id,text FROM community.catalog_comments WHERE id=ANY($1::text[]) ORDER BY id",
        [[comment, reply]],
      ),
    ).toEqual(
      [
        { id: comment, author_id: subject, text: "合成评论" },
        { id: reply, author_id: bystander, text: "合成回应" },
      ]
        .sort((left, right) => (left.id < right.id ? -1 : 1))
        .map(({ author_id, text }) => ({ author_id, text })),
    );

    // The bystander is untouched.
    expect(await accountState(bystander)).toEqual(bystanderBefore);
    expect(
      await query(
        "SELECT title,public_revision_id FROM community.works WHERE id=$1",
        [theirWork.work],
      ),
    ).toEqual([{ title: "合成作品", public_revision_id: theirWork.revision }]);
    expect(
      await query(
        "SELECT octet_length(bytes) AS size FROM community.user_media WHERE id=$1",
        [theirImage.id],
      ),
    ).toEqual([{ size: PNG.length }]);

    // The existing purge machinery deletes the private bytes.
    removedKeys.length = 0;
    // (Only this case queues purges of items: it runs first.)
    expect(await runQueued(["purge_item"], at(2))).toEqual(
      erasedItems.map(() => ({
        kind: "purge_item",
        result: { status: "completed" },
      })),
    );
    expect(new Set(removedKeys)).toEqual(
      new Set([
        shown.storageKey,
        trashedItem.storageKey,
        formerItem.storageKey,
        drafted.storageKey,
        articleItem.storageKey,
        endedItem.storageKey,
      ]),
    );
    expect(
      await query(
        "SELECT DISTINCT state FROM community.media_items WHERE id=ANY($1::text[])",
        [erasedItems],
      ),
    ).toEqual([{ state: "purged" }]);
    // Released profile renditions free their blobs for `purge_blob`.
    await adapter.scheduleCleanup(at(2 * 3_600), 100);
    expect(
      (
        await query<{ count: number }>(
          `SELECT count(*)::int AS count FROM community.publishing_jobs j
             JOIN community.media_renditions r ON r.blob_id=j.subject_id
             JOIN community.user_media m ON m.id=r.user_media_id
             WHERE j.kind='purge_blob' AND j.state='queued' AND m.owner_id=$1`,
          [subject],
        )
      )[0]!.count,
    ).toBe(4);

    // A second run changes nothing.
    const settled = await accountState(subject);
    await adapter.enqueueJob(
      { kind: "purge_deleted_account", subjectId: subject },
      at(3 * 3_600),
    );
    expect(await runQueued(["purge_deleted_account"], at(3 * 3_600))).toEqual([
      { kind: "purge_deleted_account", result: { status: "completed" } },
    ]);
    expect(await accountState(subject)).toEqual(settled);
    expect(await accountState(bystander)).toEqual(bystanderBefore);
  }, 120_000);

  it("does nothing for an account that is not deleted or has no deletion record", async () => {
    const live = await createUser();
    const work = await createBareWork(live);
    const unrecorded = await createUser();
    const theirWork = await createBareWork(unrecorded);
    await db.setup.query(
      "UPDATE community.public_users SET status='deleted' WHERE id=$1",
      [unrecorded],
    );
    const before = [await accountState(live), await accountState(unrecorded)];
    for (const owner of [live, unrecorded, opaque("user")])
      await adapter.enqueueJob(
        { kind: "purge_deleted_account", subjectId: owner },
        at(10),
      );
    expect(await runQueued(["purge_deleted_account"], at(10))).toEqual(
      Array.from({ length: 3 }, () => ({
        kind: "purge_deleted_account",
        result: { status: "completed" },
      })),
    );
    expect([await accountState(live), await accountState(unrecorded)]).toEqual(
      before,
    );
    expect(
      await query(
        "SELECT title FROM community.works WHERE id=ANY($1::text[])",
        [[work, theirWork]],
      ),
    ).toEqual([{ title: "合成批量" }, { title: "合成批量" }]);
  });

  it("bounds each batch and defers the rest with attempts kept", async () => {
    const subject = await createUser();
    for (let index = 0; index < 23; index += 1) await createBareWork(subject);
    await markDeleted(subject);
    const holding = async () =>
      (
        await query<{ count: number }>(
          "SELECT count(*)::int AS count FROM community.works WHERE author_id=$1 AND deleted_at IS NULL",
          [subject],
        )
      )[0]!.count;
    expect(await adapter.purgeDeletedAccount(subject, at(20))).toEqual({
      status: "partial",
      cancelledComponentIds: [],
    });
    expect(await holding()).toBe(3);
    expect((await deletionOf(subject))?.purge_state).toBe("pending");
    expect(await adapter.purgeDeletedAccount(subject, at(21))).toEqual({
      status: "purged",
      cancelledComponentIds: [],
    });
    expect(await holding()).toBe(0);
    expect(await deletionOf(subject)).toEqual({
      purge_state: "completed",
      purge_completed_at: at(21),
    });

    // Through the queue: a long purge yields after its batch bound, kept
    // queued with its attempt restored, and finishes on a later claim.
    const longer = await createUser();
    for (let index = 0; index < 20 * 5 + 1; index += 1)
      await createBareWork(longer);
    await markDeleted(longer, at(30));
    await adapter.enqueueJob(
      { kind: "purge_deleted_account", subjectId: longer },
      at(30),
    );
    expect(await runQueued(["purge_deleted_account"], at(30))).toEqual([
      {
        kind: "purge_deleted_account",
        result: { status: "deferred", delayMs: 1_000 },
      },
    ]);
    expect(
      await query(
        "SELECT state,attempts,run_after FROM community.publishing_jobs WHERE kind='purge_deleted_account' AND subject_id=$1",
        [longer],
      ),
    ).toEqual([{ state: "queued", attempts: 0, run_after: at(31) }]);
    expect(await runQueued(["purge_deleted_account"], at(31))).toEqual([
      { kind: "purge_deleted_account", result: { status: "completed" } },
    ]);
    expect((await deletionOf(longer))?.purge_state).toBe("completed");
  }, 120_000);

  it("rolls an interrupted batch back whole and resumes after it", async () => {
    const subject = await createUser();
    for (let index = 0; index < 22; index += 1) await createBareWork(subject);
    await markDeleted(subject, at(40));
    const holding = async () =>
      (
        await query<{ count: number }>(
          "SELECT count(*)::int AS count FROM community.works WHERE author_id=$1 AND (deleted_at IS NULL OR title<>'')",
          [subject],
        )
      )[0]!.count;
    /** The App pool, failing the statement that erases the nth work. */
    const crashing = (pool: Pool, failAt: number): Pool => {
      let erased = 0;
      return {
        connect: async () => {
          const client = await pool.connect();
          return new Proxy(client, {
            get(target, property) {
              if (property === "query")
                return (text: unknown, values?: unknown[]) => {
                  if (
                    typeof text === "string" &&
                    text.startsWith("UPDATE community.works SET title=''")
                  ) {
                    erased += 1;
                    if (erased === failAt)
                      return Promise.reject(
                        Object.assign(new Error("simulated crash"), {
                          code: "57P01",
                        }),
                      );
                  }
                  return target.query(text as string, values);
                };
              const value: unknown = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        },
      } as unknown as Pool;
    };
    const interrupted = (failAt: number) =>
      new PostgresWorkPublishingAdapter(crashing(db.app, failAt), {
        publication: publicationOptions,
      });

    // A crash after five works of the first batch: none of them stays erased.
    await expect(
      interrupted(6).purgeDeletedAccount(subject, at(41)),
    ).rejects.toThrow();
    expect(await holding()).toBe(22);
    expect((await deletionOf(subject))?.purge_state).toBe("pending");
    // The first batch commits; a crash in the second keeps it.
    expect((await adapter.purgeDeletedAccount(subject, at(42))).status).toBe(
      "partial",
    );
    expect(await holding()).toBe(2);
    await expect(
      interrupted(2).purgeDeletedAccount(subject, at(43)),
    ).rejects.toThrow();
    expect(await holding()).toBe(2);
    // The handler leaves the failure to the worker; the next run resumes.
    const failing = createPublishingJobHandlers({
      port: interrupted(1),
      store,
      logger: silent,
      clock: () => at(44),
    });
    await expect(
      failing.run(
        {
          id: opaque("publishing-job"),
          kind: "purge_deleted_account",
          subjectId: subject,
          payload: null,
          attempts: 1,
          maxAttempts: 5,
          leaseOwner: "purge-it",
          leaseExpiresAt: at(3_600),
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(await holding()).toBe(2);
    expect(await adapter.purgeDeletedAccount(subject, at(45))).toEqual({
      status: "purged",
      cancelledComponentIds: [],
    });
    expect(await holding()).toBe(0);
    expect(await deletionOf(subject)).toEqual({
      purge_state: "completed",
      purge_completed_at: at(45),
    });
  }, 120_000);

  it("never completes the record before the deletion it follows", async () => {
    const subject = await createUser();
    await markDeleted(subject, at(60));
    // A worker clock a moment behind the deletion's.
    expect((await adapter.purgeDeletedAccount(subject, at(59))).status).toBe(
      "purged",
    );
    expect(await deletionOf(subject)).toEqual({
      purge_state: "completed",
      purge_completed_at: at(60),
    });
  });

  it("removes a follow that committed after the deletion and keeps the blocks others set", async () => {
    const subject = await createUser();
    const follower = await createUser();
    const followed = await createUser();
    const blocker = await createUser();
    const relations = async () =>
      (
        await query(
          `SELECT
             (SELECT count(*)::int FROM community.follows WHERE follower_id=$1) AS following,
             (SELECT count(*)::int FROM community.follows WHERE followed_id=$1) AS followers,
             (SELECT count(*)::int FROM community.blocks WHERE blocker_id=$1) AS blocking,
             (SELECT count(*)::int FROM community.blocks WHERE blocked_id=$1) AS "blockedBy",
             (SELECT count(*)::int FROM community.follows WHERE follower_id=$2 AND followed_id=$3) AS "othersFollow",
             (SELECT count(*)::int FROM community.blocks WHERE blocker_id=$4 AND blocked_id=$2) AS "othersBlock"`,
          [subject, follower, followed, blocker],
        )
      )[0];
    await db.setup.query(
      "INSERT INTO community.follows(follower_id,followed_id) VALUES($1,$2)",
      [follower, followed],
    );
    for (const [from, to] of [
      [blocker, subject],
      [blocker, follower],
    ])
      await db.setup.query(
        "INSERT INTO community.blocks(blocker_id,blocked_id) VALUES($1,$2)",
        [from, to],
      );
    // Another user's follow as the App role runs it: the unlocked target
    // check still finds the account active, and the insert, which waited on
    // the deletion's row lock, commits after the deletion.
    const late = await db.app.connect();
    try {
      await late.query("BEGIN");
      expect(
        (
          await late.query(
            "SELECT id FROM community.public_users WHERE id=$1 AND status='active'",
            [subject],
          )
        ).rowCount,
      ).toBe(1);
      await markDeleted(subject, at(70));
      await late.query(
        "INSERT INTO community.follows(follower_id,followed_id) VALUES($1,$2)",
        [follower, subject],
      );
      await late.query("COMMIT");
    } catch (error) {
      await late.query("ROLLBACK");
      throw error;
    } finally {
      late.release();
    }
    // Stand-ins for the account's own rows, as if written after the deletion.
    await db.setup.query(
      "INSERT INTO community.follows(follower_id,followed_id) VALUES($1,$2)",
      [subject, followed],
    );
    await db.setup.query(
      "INSERT INTO community.blocks(blocker_id,blocked_id) VALUES($1,$2)",
      [subject, followed],
    );
    expect(await relations()).toEqual({
      following: 1,
      followers: 1,
      blocking: 1,
      blockedBy: 1,
      othersFollow: 1,
      othersBlock: 1,
    });

    expect(await adapter.purgeDeletedAccount(subject, at(71))).toEqual({
      status: "purged",
      cancelledComponentIds: [],
    });
    // r3: the block set against the account stays; other accounts' rows too.
    expect(await relations()).toEqual({
      following: 0,
      followers: 0,
      blocking: 0,
      blockedBy: 1,
      othersFollow: 1,
      othersBlock: 1,
    });
    expect((await deletionOf(subject))?.purge_state).toBe("completed");
  });
});
