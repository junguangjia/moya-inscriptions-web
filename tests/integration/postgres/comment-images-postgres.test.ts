import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CatalogCommentService,
  CommunityModerationService,
  WorkPublishingService,
} from "@moya/api";
import type { PublishingOperatorService } from "@moya/api";
import { createPublishingJobHandlers } from "@moya/backend-production/internal/publishing-job-handlers";
import { FilesystemPublishingMediaStore } from "@moya/backend-production/internal/publishing-media-store";
import { createPublishingMediaProcessor } from "@moya/backend-production/internal/publishing-processing";
import {
  createSandboxRunner,
  defaultSandboxAppDist,
} from "@moya/backend-production/internal/publishing-sandbox";
import { handleOperatorRequest } from "@moya/backend-runtime/internal/community-operator";
import { commentImagePayloadFor } from "@moya/contracts/comment-images-protocol";
import {
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import {
  PostgresCommunityCommentAdapter,
  PostgresWorkPublishingAdapter,
  PostgresArticleAuthoringAdapter,
  PostgresCommunityReportingAdapter,
} from "@moya/community-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { inProcessSandbox } from "../../unit/backend/publishing-sandbox-fixture.js";
import {
  createCatalogScaleDatabase,
  type CatalogScaleDatabase,
} from "./catalog-scale-fixture.js";
import { requireSyntheticTestDatabaseUrl } from "./synthetic-test-database.js";
import {
  emptyArticleDocument,
  catalogIdSchema,
  publicUserIdSchema,
  registerMediaItemCommandSchema,
} from "@moya/contracts/schemas";
import type { CatalogCommentId, DiscussionTarget } from "@moya/contracts";
let db: CatalogScaleDatabase;
let discussion: PostgresCommunityCommentAdapter;
let publishing: PostgresWorkPublishingAdapter;
let alice: string, bob: string, charlie: string, work: string;
beforeAll(async () => {
  db = await createCatalogScaleDatabase({
    target: requireSyntheticTestDatabaseUrl(),
    label: "comm358",
    openPool: (url) =>
      createPostgresPool(parsePostgresConfig({ DATABASE_URL: url })),
  });
  discussion = new PostgresCommunityCommentAdapter(db.app);
  publishing = new PostgresWorkPublishingAdapter(db.app);
  alice = opaque("user");
  bob = opaque("user");
  charlie = opaque("user");
  work = opaque("work");
  for (const id of [alice, bob, charlie])
    await db.setup.query(
      "INSERT INTO community.public_users(id,handle,display_name) VALUES($1,$2,'Synthetic Comment Author')",
      [id, `images-${id.slice(-20)}`],
    );
  await db.setup.query(
    "INSERT INTO community.works(id,author_id,title,text,first_published_at,synthetic_provenance) VALUES($1,$2,'Synthetic image target','Synthetic text',CURRENT_TIMESTAMP,'comment-images-358')",
    [work, alice],
  );
  await db.setup.query(
    "UPDATE community.publication_setting SET policy='DIRECT_PUBLICATION' WHERE id='publication'",
  );
}, 60000);
beforeEach(async () => {
  await db.setup.query("DELETE FROM community.blocks");
  await db.setup.query(
    "UPDATE community.publication_setting SET policy='DIRECT_PUBLICATION' WHERE id='publication'",
  );
  await db.setup.query(
    "UPDATE community.works SET visibility='public' WHERE id=$1",
    [work],
  );
});
afterAll(async () => {
  await db?.close();
});
const target = () => ({ type: "work" as const, id: work });
const opaque = (prefix: string) =>
  `${prefix}-${randomUUID().replaceAll("-", "")}`;
const readyImage = async (
  owner: string,
  purpose: "content" | "comment" = "comment",
) => {
  const id = opaque("media-item");
  await db.setup.query(
    "INSERT INTO community.media_items(id,owner_id,kind,quality_mode,source,state,declared_total_bytes,received_total_bytes,presentation,purpose) VALUES($1,$2,'static','original','upload','ready',1,1,'{\"width\":40,\"height\":20}'::jsonb,$3)",
    [id, owner, purpose],
  );
  const sourceBlob = opaque("media-blob"),
    sourceHex = randomUUID().replaceAll("-", "");
  await db.setup.query(
    "INSERT INTO community.media_blobs(id,owner_id,purpose,storage_key,byte_size,sha256,content_type) VALUES($1,$2,'original',$3,1,$4,'image/png')",
    [
      sourceBlob,
      owner,
      `blobs/${sourceHex.slice(0, 2)}/${sourceHex.slice(2, 4)}/${sourceHex}`,
      "b".repeat(64),
    ],
  );
  await db.setup.query(
    "INSERT INTO community.media_components(id,item_id,owner_id,role,declared_bytes,declared_type,state,received_bytes,sha256,detected_type,blob_id) VALUES($1,$2,$3,'still',1,'image/png','verified',1,$4,'image/png',$5)",
    [opaque("media-component"), id, owner, "b".repeat(64), sourceBlob],
  );
  for (const role of ["thumb", "display", "full"]) {
    const blob = opaque("media-blob"),
      hex = randomUUID().replaceAll("-", "");
    await db.setup.query(
      "INSERT INTO community.media_blobs(id,owner_id,purpose,storage_key,byte_size,sha256,content_type) VALUES($1,$2,'derivative',$3,1,$4,'image/webp')",
      [
        blob,
        owner,
        `blobs/${hex.slice(0, 2)}/${hex.slice(2, 4)}/${hex}`,
        "a".repeat(64),
      ],
    );
    await db.setup.query(
      "INSERT INTO community.media_renditions(id,item_id,edit_key,role,recipe_version,recipe_digest,blob_id,width,height,content_type) VALUES($1,$2,'base',$3,1,$4,$5,40,20,'image/webp')",
      [opaque("media-rendition"), id, role, "a".repeat(16), blob],
    );
  }
  return id;
};

const moderationReview = () =>
  new CommunityModerationService(
    discussion,
    {} as ConstructorParameters<typeof CommunityModerationService>[1],
    { isPublished: async () => true, readTitle: async () => null },
  );

/** Real Operator admission and PostgreSQL authorization; only blob IO is synthetic. */
const ownerImageReader = async () => {
  const credential = "EXPLICIT_SYNTHETIC_PLACEHOLDER";
  const dependencies: Parameters<typeof handleOperatorRequest>[3] = {
    operatorCredential: credential,
    moderationService: moderationReview(),
    discussionPort: discussion,
    publishingOperatorService: {
      openAuthorizedMedia: async () => ({
        contentType: "image/webp",
        sha256: "a".repeat(64),
        read: {
          status: "ok",
          byteSize: 1,
          start: 0,
          end: 0,
          contentLength: 1,
          body: (async function* () {
            yield Uint8Array.from([1]);
          })(),
          close: async () => {},
        },
      }),
    } as unknown as PublishingOperatorService,
  };
  const server = createServer((request, response) => {
    void handleOperatorRequest(
      request,
      response,
      new URL(request.url ?? "/", "http://synthetic.invalid").pathname,
      dependencies,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Synthetic Operator listener absent");
  return {
    read: async (id: string, image: string, authorized = true) => {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/internal/community/comments/${id}/images/${image}/display`,
        {
          headers: authorized ? { authorization: `Bearer ${credential}` } : {},
        },
      );
      return {
        status: response.status,
        cacheControl: response.headers.get("cache-control"),
        body: new Uint8Array(await response.arrayBuffer()),
      };
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
};

const imageOnlyThread = async (post: DiscussionTarget = target()) => {
  const rootImage = await readyImage(alice),
    replyImage = await readyImage(bob);
  const root = await discussion.submitDiscussion(
    post,
    alice,
    "",
    undefined,
    undefined,
    [],
    [{ itemId: rootImage, offset: 0 }],
    randomUUID(),
  );
  const reply = await discussion.submitDiscussion(
    post,
    bob,
    "",
    root.id,
    undefined,
    [],
    [{ itemId: replyImage, offset: 0 }],
    randomUUID(),
  );
  return [
    { id: root.id, image: rootImage },
    { id: reply.id, image: replyImage },
  ];
};

describe("#358 retained Operator image review", () => {
  it("keeps canonical image-only PostgreSQL text empty when projecting the legacy display hint", async () => {
    const entries = await imageOnlyThread();
    const stored = async () =>
      (
        await db.setup.query(
          "SELECT id,text,image_refs FROM community.catalog_comments WHERE id=$1 UNION ALL SELECT id,text,image_refs FROM community.catalog_comment_replies WHERE id=$2 ORDER BY id",
          [entries[0]!.id, entries[1]!.id],
        )
      ).rows;
    const before = await stored();
    const canonical = await discussion.readDiscussion(target(), null, {
      page: 1,
      pageSize: 50,
    });
    const root = [...canonical.hot, ...canonical.items].find(
      (item) => item.id === entries[0]!.id,
    )!;
    expect(root.text).toBe("");
    expect(root.replies[0]?.text).toBe("");
    const projected = commentImagePayloadFor(undefined, root) as typeof root;
    expect(projected.text).toBe("【此条含附图，请刷新页面查看】");
    expect(projected.replies[0]?.text).toBe("【此条含附图，请刷新页面查看】");
    expect(projected).not.toHaveProperty("images");
    expect(commentImagePayloadFor("1", root)).toBe(root);
    expect(
      (
        await moderationReview().readCommentDetail(
          entries[0]!.id as CatalogCommentId,
        )
      ).item.text,
    ).toBe("");
    expect(await stored()).toEqual(before);
    expect(
      before.every((item) => item.text === "" && item.image_refs.length === 1),
    ).toBe(true);
  });
  it.each(["visible", "hidden", "removed", "private"] as const)(
    "reviews image-only roots and replies in %s state without opening public images",
    async (state) => {
      const entries = await imageOnlyThread(),
        root = entries[0]!;
      if (state === "hidden") {
        await db.setup.query(
          "UPDATE community.catalog_comments SET moderation='hidden' WHERE id=$1",
          [root.id],
        );
        await db.setup.query(
          "UPDATE community.catalog_comment_replies SET moderation='hidden' WHERE root_comment_id=$1",
          [root.id],
        );
      } else if (state === "removed")
        await discussion.removeDiscussionThread(
          "owner",
          root.id,
          randomUUID(),
          2,
          "Synthetic retained image review",
        );
      else if (state === "private")
        await db.setup.query(
          "UPDATE community.works SET visibility='self' WHERE id=$1",
          [work],
        );
      const review = moderationReview(),
        page = await review.readComments({ page: 1, pageSize: 50 }),
        reader = await ownerImageReader();
      try {
        expect((await reader.read(root.id, root.image, false)).status).toBe(
          401,
        );
        for (const entry of entries) {
          expect(page.items.find((item) => item.id === entry.id)).toMatchObject(
            { text: "", images: [{ id: entry.image, offset: 0 }] },
          );
          expect(
            (await review.readCommentDetail(entry.id as CatalogCommentId)).item,
          ).toMatchObject({ text: "", images: [{ id: entry.image }] });
          const image = await reader.read(entry.id, entry.image);
          expect(image.status).toBe(200);
          expect(image.cacheControl).toBe("private, no-store");
          expect(image.body).toEqual(Uint8Array.from([1]));
          if (state === "private")
            await expect(
              discussion.resolveDiscussionImage(
                entry.id,
                entry.image,
                "display",
                alice,
              ),
            ).rejects.toMatchObject({ name: "CommunityNotFoundError" });
          else if (state === "visible")
            expect(
              await discussion.resolveDiscussionImage(
                entry.id,
                entry.image,
                "display",
                null,
              ),
            ).not.toBeNull();
          else
            expect(
              await discussion.resolveDiscussionImage(
                entry.id,
                entry.image,
                "display",
                null,
              ),
            ).toBeNull();
        }
        expect((await reader.read(root.id, entries[1]!.image)).status).toBe(
          404,
        );
      } finally {
        await reader.close();
      }
    },
  );

  it("keeps deleted image-only queue/detail tombstones while denying every image byte", async () => {
    const entries = await imageOnlyThread();
    await discussion.deleteDiscussionBody(alice, entries[0]!.id, randomUUID());
    await discussion.operatorDeleteBody(
      "owner",
      entries[1]!.id,
      randomUUID(),
      "Synthetic irreversible image deletion",
    );
    const review = moderationReview(),
      page = await review.readComments({ page: 1, pageSize: 50 }),
      reader = await ownerImageReader();
    try {
      for (const [index, entry] of entries.entries()) {
        expect(page.items.find((item) => item.id === entry.id)).toMatchObject({
          text: "This comment has been deleted",
          bodyDeleted: true,
          images: [],
        });
        expect(
          (await review.readCommentDetail(entry.id as CatalogCommentId)).item,
        ).toMatchObject({
          text: "This comment has been deleted",
          bodyDeleted: true,
          images: [],
        });
        // The retained canonical image fact also permits an empty deleted
        // body. It remains a tombstone, never an invalid live image-only row.
        await db.setup.query(
          `UPDATE community.${index === 0 ? "catalog_comments" : "catalog_comment_replies"} SET text='' WHERE id=$1 AND body_deleted_at IS NOT NULL`,
          [entry.id],
        );
        expect(
          (await review.readComments({ page: 1, pageSize: 50 })).items.find(
            (item) => item.id === entry.id,
          ),
        ).toMatchObject({ text: "", bodyDeleted: true, images: [] });
        expect(
          (await review.readCommentDetail(entry.id as CatalogCommentId)).item,
        ).toMatchObject({ text: "", bodyDeleted: true, images: [] });
        expect((await reader.read(entry.id, entry.image)).status).toBe(404);
        expect(
          await discussion.resolveDiscussionImage(
            entry.id,
            entry.image,
            "display",
            null,
          ),
        ).toBeNull();
      }
    } finally {
      await reader.close();
    }
  });

  it("fails closed when an empty live body has no validated ready attachment", async () => {
    const entries = await imageOnlyThread(),
      root = entries[0]!;
    await db.setup.query(
      "UPDATE community.media_items SET state='processing' WHERE id=$1",
      [root.image],
    );
    try {
      await expect(
        discussion.findOperatorComment(root.id as CatalogCommentId),
      ).rejects.toThrow("Invalid PostgreSQL community comment row");
      await expect(
        moderationReview().readComments({ page: 1, pageSize: 50 }),
      ).rejects.toThrow("Invalid PostgreSQL community comment row");
    } finally {
      await db.setup.query(
        "UPDATE community.media_items SET state='ready' WHERE id=$1",
        [root.image],
      );
    }
  });

  it("retains Owner review of root/reply images after actual authored Article withdrawal", async () => {
    const articles = new PostgresArticleAuthoringAdapter(db.app),
      actor = {
        source: "human" as const,
        userId: publicUserIdSchema.parse(alice),
      };
    const draft = await articles.create(
      actor,
      {
        requestId: randomUUID(),
        title: "Synthetic retained review",
        coverRefId: null,
        document: {
          ...emptyArticleDocument(),
          blocks: [
            {
              id: "retained-paragraph",
              type: "paragraph",
              props: {
                textAlignment: "left",
                textColor: "default",
                backgroundColor: "default",
              },
              content: [
                {
                  type: "text",
                  text: "Synthetic retained Article",
                  styles: {},
                },
              ],
              children: [],
            },
          ],
        },
      },
      new Date(),
    );
    const published = await articles.publish(
      actor,
      draft.id,
      {
        requestId: randomUUID(),
        expectedVersion: draft.version,
        fingerprint: draft.fingerprint,
      },
      new Date(),
    );
    const post = { type: "article" as const, id: draft.id },
      entries = await imageOnlyThread(post);
    await articles.withdraw(
      actor,
      draft.id,
      {
        requestId: randomUUID(),
        expectedVersion: published.version,
        fingerprint: published.fingerprint,
      },
      new Date(),
    );
    await expect(
      discussion.readDiscussion(post, alice, { page: 1, pageSize: 50 }),
    ).rejects.toMatchObject({ name: "CommunityNotFoundError" });
    const review = moderationReview(),
      page = await review.readComments({ page: 1, pageSize: 50 }),
      reader = await ownerImageReader();
    try {
      for (const entry of entries) {
        expect(
          page.items.find((item) => item.id === entry.id)?.images?.[0]?.id,
        ).toBe(entry.image);
        expect(
          (await review.readCommentDetail(entry.id as CatalogCommentId)).item
            .images?.[0]?.id,
        ).toBe(entry.image);
        expect((await reader.read(entry.id, entry.image)).status).toBe(200);
        await expect(
          discussion.resolveDiscussionImage(
            entry.id,
            entry.image,
            "display",
            alice,
          ),
        ).rejects.toMatchObject({ name: "CommunityNotFoundError" });
      }
    } finally {
      await reader.close();
    }
  });

  it("preserves image-only Catalog root/reply submission and reads through the configured canonical legacy service", async () => {
    const catalogId = catalogIdSchema.parse(opaque("catalog")),
      service = new CatalogCommentService(
        discussion,
        {
          isPublished: async () => true,
          readTitle: async () => "Synthetic Catalog",
        },
        { discussionPort: discussion },
      ),
      first = await readyImage(alice),
      second = await readyImage(bob);
    const root = await service.createComment(
      catalogId,
      publicUserIdSchema.parse(alice),
      {
        text: "",
        images: [{ itemId: first, offset: 0 }],
        requestId: randomUUID(),
      },
    );
    const reply = await service.createReply(
      catalogId,
      root.item.id,
      publicUserIdSchema.parse(bob),
      {
        text: "",
        images: [{ itemId: second, offset: 0 }],
        requestId: randomUUID(),
      },
    );
    expect(root.item).toMatchObject({ text: "", images: [{ id: first }] });
    expect(reply.item).toMatchObject({ text: "", images: [{ id: second }] });
    const page = await service.readComments(catalogId, {
      page: 1,
      pageSize: 50,
    });
    expect(
      [...page.hot, ...page.items].find((item) => item.id === root.item.id),
    ).toMatchObject({
      text: "",
      images: [{ id: first }],
      replies: [{ id: reply.item.id, text: "", images: [{ id: second }] }],
    });
    expect(
      (
        await service.readReplies(catalogId, root.item.id, {
          page: 1,
          pageSize: 50,
        })
      ).items,
    ).toMatchObject([
      { id: reply.item.id, text: "", images: [{ id: second }] },
    ]);
  });
});

describe("#358 real comment media persistence and authorization", () => {
  it("commits immutable ordered positions, replies and image-only text; concurrent retries are one submission", async () => {
    const first = await readyImage(alice),
      second = await readyImage(alice);
    const refs = [
        { itemId: first, offset: 0 },
        { itemId: second, offset: 3 },
      ],
      request = randomUUID();
    const sent = await Promise.all(
      Array.from({ length: 4 }, () =>
        discussion.submitDiscussion(
          target(),
          alice,
          "甲😀乙",
          undefined,
          undefined,
          [],
          refs,
          request,
        ),
      ),
    );
    expect(new Set(sent.map((x) => x.id)).size).toBe(1);
    expect(sent[0]!.item.images?.map((x) => [x.id, x.offset])).toEqual([
      [first, 0],
      [second, 3],
    ]);
    expect(sent[0]!.item.images?.[0]?.fullSrc).toMatch(/\/full$/u);
    await expect(
      discussion.submitDiscussion(
        target(),
        alice,
        "changed",
        undefined,
        undefined,
        [],
        [{ itemId: first, offset: 0 }],
        request,
      ),
    ).rejects.toMatchObject({ name: "CommunityConflictError" });
    const replyImage = await readyImage(bob);
    const reply = await discussion.submitDiscussion(
      target(),
      bob,
      "",
      sent[0]!.id,
      undefined,
      [],
      [{ itemId: replyImage, offset: 0 }],
      randomUUID(),
    );
    expect(reply.item.text).toBe("");
    expect(
      (
        await discussion.readDiscussion(target(), null, {
          page: 1,
          pageSize: 50,
        })
      ).items.find((x) => x.id === sent[0]!.id)?.replies[0]?.images?.[0]?.id,
    ).toBe(replyImage);
    expect(
      (
        await discussion.readDiscussionReplies(target(), sent[0]!.id, null, {
          page: 1,
          pageSize: 50,
        })
      ).items[0]?.images?.[0]?.id,
    ).toBe(replyImage);
    expect(
      (
        await discussion.ownComments(alice, { page: 1, pageSize: 50 })
      ).items.find((x) => x.id === sent[0]!.id)?.images,
    ).toHaveLength(2);
  });
  it("rejects foreign, wrong-purpose, unready or missing uploads without comment rows or durable pins", async () => {
    const foreign = await readyImage(bob),
      content = await readyImage(alice, "content"),
      pending = await readyImage(alice);
    await db.setup.query(
      "UPDATE community.media_items SET state='processing' WHERE id=$1",
      [pending],
    );
    const before = (
      await db.setup.query(
        "SELECT count(*) AS n FROM community.catalog_comments",
      )
    ).rows[0]!.n;
    for (const itemId of [foreign, content, pending, opaque("media-item")])
      await expect(
        discussion.submitDiscussion(
          target(),
          alice,
          "Rejected",
          undefined,
          undefined,
          [],
          [{ itemId, offset: 0 }],
          randomUUID(),
        ),
      ).rejects.toMatchObject({ name: "CommunityInputError" });
    expect(
      (
        await db.setup.query(
          "SELECT count(*) AS n FROM community.catalog_comments",
        )
      ).rows[0]!.n,
    ).toBe(before);
    expect(
      (
        await db.setup.query(
          "SELECT count(*) AS n FROM community.media_item_refs WHERE item_id=ANY($1::text[]) AND holder_kind='comment'",
          [[foreign, content, pending]],
        )
      ).rows[0]!.n,
    ).toBe("0");
  });
  it("pins survive session discard/cancel/purge and generic media URLs cannot bypass comment authorization", async () => {
    const now = new Date();
    const session = await publishing.createSession(
      alice,
      { requestId: randomUUID(), workId: null },
      now,
    );
    const image = await readyImage(alice);
    await db.setup.query(
      "INSERT INTO community.media_item_refs(item_id,holder_kind,holder_id) VALUES($1,'session',$2)",
      [image, session.id],
    );
    expect(
      await publishing.resolveMediaRead(alice, image, "display", "base"),
    ).not.toBeNull();
    const sent = await discussion.submitDiscussion(
      target(),
      alice,
      "pin",
      undefined,
      undefined,
      [],
      [{ itemId: image, offset: 1 }],
      randomUUID(),
    );
    await publishing.discardSession(
      alice,
      session.id,
      { requestId: randomUUID() },
      now,
    );
    await publishing.cancelItem(alice, image, { requestId: randomUUID() }, now);
    expect(
      (
        await db.setup.query(
          "SELECT state FROM community.media_items WHERE id=$1",
          [image],
        )
      ).rows[0]!.state,
    ).toBe("ready");
    expect(
      await publishing.resolveMediaRead(alice, image, "display", "base"),
    ).toBeNull();
    expect(
      await publishing.resolveMediaRead(null, image, "display", "base"),
    ).toBeNull();
    expect(
      await discussion.resolveDiscussionImage(sent.id, image, "display", null),
    ).not.toBeNull();
    expect(
      await publishing.purgeItem(image, new Date(now.getTime() + 864000000)),
    ).toMatchObject({ status: "referenced" });
  });
  it("revalidates pending, hidden, block, target privacy and body deletion; deleting a root body preserves other replies", async () => {
    await db.setup.query(
      "UPDATE community.publication_setting SET policy='PRE_MODERATION' WHERE id='publication'",
    );
    const image = await readyImage(alice);
    const sent = await discussion.submitDiscussion(
      target(),
      alice,
      "pending",
      undefined,
      undefined,
      [],
      [{ itemId: image, offset: 0 }],
      randomUUID(),
    );
    expect(sent.awaitingApproval).toBe(true);
    expect(
      await discussion.resolveDiscussionImage(sent.id, image, "display", null),
    ).toBeNull();
    expect(
      await discussion.resolveDiscussionImage(sent.id, image, "display", alice),
    ).not.toBeNull();
    expect(
      await discussion.resolveDiscussionImage(
        sent.id,
        image,
        "display",
        null,
        true,
      ),
    ).not.toBeNull();
    const review = await discussion.findOperatorComment(
      sent.id as CatalogCommentId,
    );
    expect(review?.images?.[0]?.src).toContain(
      `/api/community-moderation/comment-media/${sent.id}/${image}/display`,
    );
    await db.setup.query(
      "UPDATE community.catalog_comments SET moderation='hidden' WHERE id=$1",
      [sent.id],
    );
    expect(
      await discussion.resolveDiscussionImage(sent.id, image, "display", alice),
    ).toBeNull();
    await db.setup.query(
      "UPDATE community.catalog_comments SET moderation='visible' WHERE id=$1",
      [sent.id],
    );
    await db.setup.query(
      "INSERT INTO community.blocks(blocker_id,blocked_id) VALUES($1,$2)",
      [alice, bob],
    );
    await expect(
      discussion.resolveDiscussionImage(sent.id, image, "display", bob),
    ).rejects.toMatchObject({ name: "CommunityNotFoundError" });
    await db.setup.query(
      "DELETE FROM community.blocks WHERE blocker_id=$1 AND blocked_id=$2",
      [alice, bob],
    );
    await db.setup.query(
      "UPDATE community.works SET visibility='self' WHERE id=$1",
      [work],
    );
    await expect(
      discussion.resolveDiscussionImage(sent.id, image, "display", alice),
    ).rejects.toMatchObject({ name: "CommunityNotFoundError" });
    await db.setup.query(
      "UPDATE community.works SET visibility='public' WHERE id=$1",
      [work],
    );
    await db.setup.query(
      "UPDATE community.publication_setting SET policy='DIRECT_PUBLICATION' WHERE id='publication'",
    );
    const replyImage = await readyImage(bob);
    const reply = await discussion.submitDiscussion(
      target(),
      bob,
      "reply",
      sent.id,
      undefined,
      [],
      [{ itemId: replyImage, offset: 0 }],
      randomUUID(),
    );
    await discussion.deleteDiscussionBody(alice, sent.id, randomUUID());
    expect(
      await discussion.resolveDiscussionImage(sent.id, image, "display", alice),
    ).toBeNull();
    expect(
      await discussion.resolveDiscussionImage(
        reply.id,
        replyImage,
        "display",
        null,
      ),
    ).not.toBeNull();
    await discussion.removeDiscussionThread(
      "owner",
      sent.id,
      randomUUID(),
      2,
      "Synthetic removal",
    );
    expect(
      await discussion.resolveDiscussionImage(
        reply.id,
        replyImage,
        "display",
        null,
      ),
    ).toBeNull();
  });
  it("registers static comment purpose through ordinary leased upload and cannot mutate it", async () => {
    const now = new Date(),
      session = await publishing.createSession(
        alice,
        { requestId: randomUUID(), workId: null },
        now,
      );
    const item = await publishing.registerItem(
      alice,
      {
        requestId: randomUUID(),
        purpose: "comment",
        holder: { sessionId: session.id },
        kind: "static",
        qualityMode: "original",
        components: [{ role: "still", byteSize: 1, contentType: "image/png" }],
      },
      now,
    );
    expect(
      (
        await db.setup.query(
          "SELECT purpose,private_metadata FROM community.media_items WHERE id=$1",
          [item.id],
        )
      ).rows[0],
    ).toEqual({ purpose: "comment", private_metadata: null });
    await expect(
      db.setup.query(
        "UPDATE community.media_items SET purpose='content' WHERE id=$1",
        [item.id],
      ),
    ).rejects.toMatchObject({ code: "23000" });
  });
});

describe("#358 review regressions: current authority and attachment lifetime", () => {
  it("rebuilds a receipt from current canonical author/likes instead of its original response snapshot", async () => {
    const image = await readyImage(alice),
      request = randomUUID(),
      refs = [{ itemId: image, offset: 0 }];
    const sent = await discussion.submitDiscussion(
      target(),
      alice,
      "Canonical replay",
      undefined,
      undefined,
      [],
      refs,
      request,
    );
    await db.setup.query(
      "UPDATE community.public_users SET display_name='Synthetic current name' WHERE id=$1",
      [alice],
    );
    await discussion.setDiscussionLike(bob, sent.id, true, randomUUID());
    const replay = await discussion.submitDiscussion(
      target(),
      alice,
      "Canonical replay",
      undefined,
      undefined,
      [],
      refs,
      request,
    );
    expect(replay.id).toBe(sent.id);
    expect(replay.item.author.displayName).toBe("Synthetic current name");
    expect(replay.item.likeCount).toBe(1);
    await db.setup.query(
      "UPDATE community.public_users SET display_name='Synthetic Comment Author' WHERE id=$1",
      [alice],
    );
  });
  it.each(["root-user", "reply-user", "root-operator", "reply-operator"])(
    "never returns deleted original text/images from receipt replay (%s)",
    async (kind) => {
      const rootId = kind.startsWith("reply")
        ? (
            await discussion.submitDiscussion(
              target(),
              alice,
              "Retained parent",
            )
          ).id
        : undefined;
      const image = await readyImage(alice),
        request = randomUUID(),
        text = "Original private body",
        refs = [{ itemId: image, offset: 0 }];
      const sent = await discussion.submitDiscussion(
        target(),
        alice,
        text,
        rootId,
        undefined,
        [],
        refs,
        request,
      );
      if (kind.endsWith("operator"))
        await discussion.operatorDeleteBody(
          "owner",
          sent.id,
          randomUUID(),
          "Synthetic deletion",
        );
      else await discussion.deleteDiscussionBody(alice, sent.id, randomUUID());
      const count = async () =>
        Number(
          (
            await db.setup.query(
              "SELECT (SELECT count(*) FROM community.catalog_comments)+(SELECT count(*) FROM community.catalog_comment_replies) AS n",
            )
          ).rows[0]!.n,
        );
      const before = await count();
      await expect(
        discussion.submitDiscussion(
          target(),
          alice,
          text,
          rootId,
          undefined,
          [],
          refs,
          request,
        ),
      ).rejects.toMatchObject({ name: "CommunityNotFoundError" });
      expect(await count()).toBe(before);
      if (kind === "root-user") {
        const delayed = (
          await db.setup.query(
            `SELECT j.run_after>=i.cancelled_at+make_interval(days=>s.orphan_grace_days) AS delayed FROM community.publishing_jobs j JOIN community.media_items i ON i.id=j.subject_id CROSS JOIN community.work_publishing_settings s WHERE j.kind='purge_item' AND j.subject_id=$1 AND s.id='settings'`,
            [image],
          )
        ).rows[0];
        expect(delayed?.delayed).toBe(true);
      }
    },
  );
  it.each(["root", "reply"])(
    "refuses a hidden current body on retry without creating another %s",
    async (kind) => {
      const rootId =
        kind === "reply"
          ? (
              await discussion.submitDiscussion(
                target(),
                alice,
                "Public parent",
              )
            ).id
          : undefined;
      const image = await readyImage(alice),
        request = randomUUID(),
        refs = [{ itemId: image, offset: 0 }];
      const sent = await discussion.submitDiscussion(
        target(),
        alice,
        "Hide after acceptance",
        rootId,
        undefined,
        [],
        refs,
        request,
      );
      const table = rootId ? "catalog_comment_replies" : "catalog_comments";
      await db.setup.query(
        `UPDATE community.${table} SET moderation='hidden' WHERE id=$1`,
        [sent.id],
      );
      await expect(
        discussion.submitDiscussion(
          target(),
          alice,
          "Hide after acceptance",
          rootId,
          undefined,
          [],
          refs,
          request,
        ),
      ).rejects.toMatchObject({ name: "CommunityNotFoundError" });
      expect(
        (
          await db.setup.query(
            "SELECT count(*) AS n FROM community.media_item_refs WHERE holder_kind='comment' AND holder_id=$1",
            [sent.id],
          )
        ).rows[0]!.n,
      ).toBe("1");
      await db.setup.query(
        `UPDATE community.${table} SET moderation='visible' WHERE id=$1`,
        [sent.id],
      );
      expect(
        (
          await discussion.submitDiscussion(
            target(),
            alice,
            "Hide after acceptance",
            rootId,
            undefined,
            [],
            refs,
            request,
          )
        ).id,
      ).toBe(sent.id);
    },
  );
  it("checks target-owner blocks as well as comment-owner blocks for Work and authored Article images", async () => {
    const articles = new PostgresArticleAuthoringAdapter(db.app),
      actor = {
        source: "human" as const,
        userId: publicUserIdSchema.parse(alice),
      };
    const document = {
      ...emptyArticleDocument(),
      blocks: [
        {
          id: "target-paragraph",
          type: "paragraph" as const,
          props: {
            textAlignment: "left" as const,
            textColor: "default" as const,
            backgroundColor: "default" as const,
          },
          content: [
            {
              type: "text" as const,
              text: "Synthetic target body",
              styles: {},
            },
          ],
          children: [],
        },
      ],
    };
    const draft = await articles.create(
      actor,
      {
        requestId: randomUUID(),
        title: "Synthetic authored target",
        coverRefId: null,
        document,
      },
      new Date(),
    );
    await articles.publish(
      actor,
      draft.id,
      {
        requestId: randomUUID(),
        expectedVersion: draft.version,
        fingerprint: draft.fingerprint,
      },
      new Date(),
    );
    const targets: DiscussionTarget[] = [
      target(),
      { type: "article", id: draft.id },
    ];
    for (const post of targets) {
      const image = await readyImage(bob),
        sent = await discussion.submitDiscussion(
          post,
          bob,
          "Other comment author",
          undefined,
          undefined,
          [],
          [{ itemId: image, offset: 0 }],
          randomUUID(),
        );
      expect(
        await discussion.resolveDiscussionImage(
          sent.id,
          image,
          "display",
          charlie,
        ),
      ).not.toBeNull();
      for (const [blocker, blocked] of [
        [alice, charlie],
        [charlie, alice],
      ]) {
        await db.setup.query(
          "INSERT INTO community.blocks(blocker_id,blocked_id) VALUES($1,$2)",
          [blocker, blocked],
        );
        await expect(
          discussion.readDiscussion(post, charlie, { page: 1, pageSize: 50 }),
        ).rejects.toMatchObject({ name: "CommunityNotFoundError" });
        await expect(
          discussion.resolveDiscussionImage(sent.id, image, "display", charlie),
        ).rejects.toMatchObject({ name: "CommunityNotFoundError" });
        expect(
          await discussion.resolveDiscussionImage(
            sent.id,
            image,
            "display",
            null,
            true,
          ),
        ).not.toBeNull();
        await db.setup.query(
          "DELETE FROM community.blocks WHERE blocker_id=$1 AND blocked_id=$2",
          [blocker, blocked],
        );
      }
    }
  });
  it("preserves other durable holders without reopening the generic owner preview after body deletion", async () => {
    const image = await readyImage(alice),
      sent = await discussion.submitDiscussion(
        target(),
        alice,
        "Other holder",
        undefined,
        undefined,
        [],
        [{ itemId: image, offset: 0 }],
        randomUUID(),
      );
    const holder = opaque("work-snapshot");
    await db.setup.query(
      "INSERT INTO community.media_item_refs(item_id,holder_kind,holder_id) VALUES($1,'snapshot',$2)",
      [image, holder],
    );
    await discussion.deleteDiscussionBody(alice, sent.id, randomUUID());
    expect(
      (
        await db.setup.query(
          "SELECT state FROM community.media_items WHERE id=$1",
          [image],
        )
      ).rows[0]!.state,
    ).toBe("ready");
    expect(
      (
        await db.setup.query(
          "SELECT holder_id FROM community.media_item_refs WHERE item_id=$1",
          [image],
        )
      ).rows.map((r) => r.holder_id),
    ).toEqual([holder]);
    expect(
      await publishing.resolveMediaRead(alice, image, "display", "base"),
    ).toBeNull();
  });
  it("releases only the deleted body, revokes the final orphan immediately, respects claimed-job grace and eventually frees quota", async () => {
    const image = await readyImage(alice),
      refs = [{ itemId: image, offset: 0 }];
    const before = Number(
      (
        await db.setup.query(
          "SELECT committed_bytes FROM community.account_publishing_capacity WHERE account_id=$1",
          [alice],
        )
      ).rows[0]?.committed_bytes ?? 0,
    );
    // The fixture's four one-byte committed blobs represent the ordinary worker's accounting.
    await db.setup.query(
      "UPDATE community.account_publishing_capacity SET committed_bytes=committed_bytes+4 WHERE account_id=$1",
      [alice],
    );
    const first = await discussion.submitDiscussion(
      target(),
      alice,
      "Shared first",
      undefined,
      undefined,
      [],
      refs,
      randomUUID(),
    );
    const second = await discussion.submitDiscussion(
      target(),
      alice,
      "Shared second",
      undefined,
      undefined,
      [],
      refs,
      randomUUID(),
    );
    const session = await publishing.createSession(
      alice,
      { requestId: randomUUID(), workId: null },
      new Date(),
    );
    await db.setup.query(
      "INSERT INTO community.media_item_refs(item_id,holder_kind,holder_id) VALUES($1,'session',$2)",
      [image, session.id],
    );
    // A purge job can already have been claimed while refs still protected the item.
    await db.setup.query(
      "INSERT INTO community.publishing_jobs(id,kind,subject_id,state,run_after) VALUES($1,'purge_item',$2,'queued',CURRENT_TIMESTAMP - interval '1 minute')",
      [opaque("publishing-job"), image],
    );
    await publishing.claimJobs(
      {
        owner: "comment358-deletion",
        limit: 100,
        leaseMs: 60000,
        kinds: ["purge_item"],
      },
      new Date(),
    );
    // Files share this queue in parallel, so another file's claim can win it.
    expect(
      (
        await db.setup.query(
          "SELECT state FROM community.publishing_jobs WHERE subject_id=$1 AND kind='purge_item'",
          [image],
        )
      ).rows[0]!.state,
    ).not.toBe("queued");
    await discussion.deleteDiscussionBody(alice, first.id, randomUUID());
    expect(
      (
        await db.setup.query(
          "SELECT state FROM community.media_items WHERE id=$1",
          [image],
        )
      ).rows[0]!.state,
    ).toBe("ready");
    expect(
      await discussion.resolveDiscussionImage(
        second.id,
        image,
        "display",
        null,
      ),
    ).not.toBeNull();
    await discussion.operatorDeleteBody(
      "owner",
      second.id,
      randomUUID(),
      "Synthetic final deletion",
    );
    expect(
      (
        await db.setup.query(
          "SELECT state FROM community.media_items WHERE id=$1",
          [image],
        )
      ).rows[0]!.state,
    ).toBe("cancelled");
    expect(
      (
        await db.setup.query(
          "SELECT count(*) AS n FROM community.media_item_refs WHERE item_id=$1",
          [image],
        )
      ).rows[0]!.n,
    ).toBe("0");
    expect(
      await publishing.resolveMediaRead(alice, image, "display", "base"),
    ).toBeNull();
    expect(await publishing.purgeItem(image, new Date())).toMatchObject({
      status: "referenced",
    });
    const cancelledAt = (
      await db.setup.query(
        "SELECT cancelled_at FROM community.media_items WHERE id=$1",
        [image],
      )
    ).rows[0]!.cancelled_at;
    await discussion.deleteDiscussionBody(alice, first.id, randomUUID());
    expect(
      (
        await db.setup.query(
          "SELECT cancelled_at FROM community.media_items WHERE id=$1",
          [image],
        )
      ).rows[0]!.cancelled_at,
    ).toEqual(cancelledAt);
    const grace = Number(
      (
        await db.setup.query(
          "SELECT orphan_grace_days FROM community.work_publishing_settings WHERE id='settings'",
        )
      ).rows[0]!.orphan_grace_days,
    );
    const future = new Date(Date.now() + grace * 86400000 + 1000),
      plan = await publishing.purgeItem(image, future);
    expect(plan.status).toBe("tombstoned");
    if (plan.status !== "tombstoned")
      throw new Error("Synthetic purge was not planned");
    await publishing.confirmPurged(
      plan.blobs.map((b) => b.blobId),
      future,
    );
    expect(
      Number(
        (
          await db.setup.query(
            "SELECT committed_bytes FROM community.account_publishing_capacity WHERE account_id=$1",
            [alice],
          )
        ).rows[0]!.committed_bytes,
      ),
    ).toBe(before);
  });
});

it("keeps ordinary unsubmitted comment upload cancellation on its existing immediate cleanup path", async () => {
  const image = await readyImage(alice),
    now = new Date(),
    session = await publishing.createSession(
      alice,
      { requestId: randomUUID(), workId: null },
      now,
    );
  await db.setup.query(
    "INSERT INTO community.media_item_refs(item_id,holder_kind,holder_id) VALUES($1,'session',$2)",
    [image, session.id],
  );
  await publishing.discardSession(
    alice,
    session.id,
    { requestId: randomUUID() },
    new Date(),
  );
  expect((await publishing.purgeItem(image, new Date())).status).toBe(
    "tombstoned",
  );
});

it("preserves root/reply image pins across reversible Staff thread removal and restores bytes only after every decision is overturned", async () => {
  const rootImage = await readyImage(alice),
    replyImage = await readyImage(bob);
  const root = await discussion.submitDiscussion(
    target(),
    alice,
    "Reversible root",
    undefined,
    undefined,
    [],
    [{ itemId: rootImage, offset: 0 }],
    randomUUID(),
  );
  const reply = await discussion.submitDiscussion(
    target(),
    bob,
    "Reversible reply",
    root.id,
    undefined,
    [],
    [{ itemId: replyImage, offset: 0 }],
    randomUUID(),
  );
  const images = [rootImage, replyImage];
  const checkReady = async () => {
    const states = (
      await db.setup.query(
        "SELECT id,state,cancelled_at FROM community.media_items WHERE id=ANY($1::text[]) ORDER BY id",
        [images],
      )
    ).rows;
    expect(states).toHaveLength(2);
    expect(
      states.every((row) => row.state === "ready" && row.cancelled_at === null),
    ).toBe(true);
    expect(
      (
        await db.setup.query(
          "SELECT count(*) AS n FROM community.media_item_refs WHERE holder_kind='comment' AND holder_id=ANY($1::text[])",
          [[root.id, reply.id]],
        )
      ).rows[0]!.n,
    ).toBe("2");
  };
  const visible = async () => {
    expect(
      await discussion.resolveDiscussionImage(
        root.id,
        rootImage,
        "display",
        null,
      ),
    ).not.toBeNull();
    expect(
      await discussion.resolveDiscussionImage(
        reply.id,
        replyImage,
        "display",
        null,
      ),
    ).not.toBeNull();
  };
  await visible();
  await discussion.removeDiscussionThread(
    "owner",
    root.id,
    randomUUID(),
    2,
    "Synthetic reversible removal",
  );
  await checkReady();
  expect(
    await discussion.resolveDiscussionImage(
      root.id,
      rootImage,
      "display",
      null,
    ),
  ).toBeNull();
  expect(
    await discussion.resolveDiscussionImage(
      reply.id,
      replyImage,
      "display",
      null,
    ),
  ).toBeNull();
  const grace = Number(
    (
      await db.setup.query(
        "SELECT orphan_grace_days FROM community.work_publishing_settings WHERE id='settings'",
      )
    ).rows[0]!.orphan_grace_days,
  );
  const afterGrace = new Date(Date.now() + (grace + 1) * 86400000);
  for (const image of images)
    expect(await publishing.purgeItem(image, afterGrace)).toMatchObject({
      status: "referenced",
    });
  const reports = new PostgresCommunityReportingAdapter(db.app);
  const cases = await Promise.all(
    [alice, bob].map(async (author) => {
      const decision = (await reports.decisions(author, 1, 100)).items.find(
        (item) => item.target.id === root.id,
      );
      if (!decision) throw new Error("Synthetic thread decision absent");
      return reports.operatorRead(decision.caseId);
    }),
  );
  for (const [index, author] of [alice, bob].entries()) {
    const original = cases[index]!;
    await reports.appeal(author, original.decision!.id, {
      text: "Synthetic image restoration appeal",
      requestId: randomUUID(),
    });
    const current = await reports.operatorRead(original.id);
    await reports.review("owner", current.id, {
      expectedVersion: current.version,
      outcome: "overturn",
      reason: "Synthetic reversible correction",
    });
    await checkReady();
    if (index === 0) {
      expect(
        (
          await db.setup.query(
            "SELECT thread_removed_at FROM community.catalog_comments WHERE id=$1",
            [root.id],
          )
        ).rows[0]!.thread_removed_at,
      ).not.toBeNull();
      expect(
        await discussion.resolveDiscussionImage(
          root.id,
          rootImage,
          "display",
          null,
        ),
      ).toBeNull();
      expect(
        await discussion.resolveDiscussionImage(
          reply.id,
          replyImage,
          "display",
          null,
        ),
      ).toBeNull();
    }
  }
  expect(
    (
      await db.setup.query(
        "SELECT thread_removed_at FROM community.catalog_comments WHERE id=$1",
        [root.id],
      )
    ).rows[0]!.thread_removed_at,
  ).toBeNull();
  await visible();
  for (const image of images)
    expect(await publishing.purgeItem(image, afterGrace)).toMatchObject({
      status: "referenced",
    });
});

it.each(["standard", "original"] as const)(
  "processes a real %s comment PNG from transfer to an image-only durable association",
  { timeout: 30_000 },
  async (qualityMode) => {
    const directory = await mkdtemp(path.join(tmpdir(), "moya-comment-png-"));
    try {
      await mkdir(path.join(directory, "store"), { mode: 0o700 });
      await mkdir(path.join(directory, "jobs"), { mode: 0o700 });
      const store = await FilesystemPublishingMediaStore.open(
        path.join(directory, "store"),
        { temporaryRoots: [] },
      );
      // Only Docker transport/isolation are synthetic. This fixture runs the
      // production renderer, Sharp decoder/encoder and framed-stream protocol.
      const sandbox = inProcessSandbox();
      const silent = { info: () => undefined, error: () => undefined };
      const runner = await createSandboxRunner({
        image: "yoyi-work-publishing-media-tools:v2",
        workDirectory: path.join(directory, "jobs"),
        appDist: defaultSandboxAppDist().appDist,
        temporaryRoots: [],
        environment: { PATH: "/usr/bin" },
        spawn: sandbox.spawn,
        logger: silent,
      });
      const processor = createPublishingMediaProcessor({
        store,
        sandbox: runner,
        logger: silent,
      });
      const service = new WorkPublishingService(publishing, {
        store,
        processor,
        logger: silent,
      });
      const png = await sharp({
        create: {
          width: 64,
          height: 32,
          channels: 4,
          background: { r: 20, g: 40, b: 60, alpha: 0.5 },
        },
      })
        .png()
        .toBuffer();
      const session = await service.createSession(alice, {
        requestId: randomUUID(),
        workId: null,
      });
      const item = await service.registerItem(
        alice,
        registerMediaItemCommandSchema.parse({
          requestId: randomUUID(),
          purpose: "comment",
          holder: { sessionId: session.id },
          kind: "static",
          qualityMode,
          ...(qualityMode === "standard"
            ? { processingProfile: "standard-image-v1" }
            : {}),
          components: [
            {
              role: "still",
              byteSize: png.byteLength,
              contentType: "image/png",
              ...(qualityMode === "standard"
                ? { standardOutcome: "retained" }
                : {}),
            },
          ],
        }),
      );
      expect(item.state).toBe("awaiting_upload");
      const transferred = await service.uploadComponent(
        alice,
        item.components[0]!.id,
        {
          attempt: randomUUID(),
          contentLength: png.byteLength,
          signal: new AbortController().signal,
          source: (async function* () {
            yield png.subarray(0, 32);
            yield png.subarray(32);
          })(),
        },
      );
      expect(transferred.status).toBe("committed");
      expect((await service.readItem(alice, item.id)).state).toBe("processing");

      const handlers = createPublishingJobHandlers({
        port: publishing,
        store,
        processor,
        logger: silent,
      });
      const runJob = async (kind: "process_item" | "derive_edit") => {
        // This file owns a fresh disposable database. Claim the real queued
        // job rather than inserting a ready item or fabricating its result.
        const claims = await publishing.claimJobs(
          {
            owner: "comment-png-test",
            limit: 1,
            leaseMs: 60_000,
            kinds: [kind],
          },
          new Date(),
        );
        expect(claims).toHaveLength(1);
        const claim = claims[0]!;
        expect(claim.subjectId).toBe(item.id);
        expect(await handlers.run(claim, new AbortController().signal)).toEqual(
          {
            status: "completed",
          },
        );
        expect(await publishing.completeJob(claim, new Date())).toBe(true);
      };
      await runJob("process_item");
      const ready = await service.readItem(alice, item.id);
      expect(ready).toMatchObject({
        state: "ready",
        qualityMode,
        presentation: { width: 64, height: 32 },
        components: [{ state: "verified" }],
        media: {
          thumbSrc: `/api/community/publishing/media/${item.id}/thumb/base`,
          displaySrc: `/api/community/publishing/media/${item.id}/display/base`,
        },
      });
      expect(
        (
          await db.setup.query(
            "SELECT purpose,private_metadata,declared_total_bytes::int AS declared,received_total_bytes::int AS received FROM community.media_items WHERE id=$1",
            [item.id],
          )
        ).rows,
      ).toEqual([
        {
          purpose: "comment",
          private_metadata: null,
          declared: png.byteLength,
          received: png.byteLength,
        },
      ]);

      const decoded = async (
        delivery: Awaited<ReturnType<typeof service.openMedia>>,
      ) => {
        expect(delivery.contentType).toBe("image/webp");
        const read = delivery.read;
        if (read.status !== "ok") throw new Error("Expected rendition bytes");
        const chunks: Buffer[] = [];
        try {
          for await (const chunk of read.body) chunks.push(Buffer.from(chunk));
        } finally {
          await read.close();
        }
        const bytes = Buffer.concat(chunks);
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(
          delivery.sha256,
        );
        const metadata = await sharp(bytes).metadata();
        expect(metadata).toMatchObject({
          format: "webp",
          width: 64,
          height: 32,
          hasAlpha: true,
        });
        expect(metadata.exif).toBeUndefined();
        expect(bytes.equals(png)).toBe(false);
        return bytes;
      };
      const previewBytes = await decoded(
        await service.openMedia(alice, item.id, "display", "base"),
      );
      await expect(
        service.openMedia(null, item.id, "display", "base"),
      ).rejects.toMatchObject({ name: "CommunityNotFoundError" });

      const sent = await discussion.submitDiscussion(
        target(),
        alice,
        "",
        undefined,
        undefined,
        [],
        [{ itemId: item.id, offset: 0 }],
        randomUUID(),
      );
      expect(sent.item).toMatchObject({
        text: "",
        images: [
          {
            id: item.id,
            offset: 0,
            width: 64,
            height: 32,
            thumbSrc: `/api/community/discussion/images/${sent.id}/${item.id}/thumb`,
            src: `/api/community/discussion/images/${sent.id}/${item.id}/display`,
          },
        ],
      });
      await service.discardSession(alice, session.id, {
        requestId: randomUUID(),
      });
      expect(
        (
          await db.setup.query(
            "SELECT holder_kind,holder_id FROM community.media_item_refs WHERE item_id=$1",
            [item.id],
          )
        ).rows,
      ).toEqual([{ holder_kind: "comment", holder_id: sent.id }]);
      expect(
        await publishing.resolveMediaRead(alice, item.id, "display", "base"),
      ).toBeNull();
      const association = await discussion.resolveDiscussionImage(
        sent.id,
        item.id,
        "display",
        null,
      );
      expect(association).not.toBeNull();
      expect(
        await decoded(await service.openAuthorizedMedia(association!)),
      ).toEqual(previewBytes);

      // The background full rendition also survives removal of the temporary
      // session: the actual comment pin is sufficient, without a Work draft.
      await runJob("derive_edit");
      const full = await discussion.resolveDiscussionImage(
        sent.id,
        item.id,
        "full",
        null,
      );
      expect(full).not.toBeNull();
      await decoded(await service.openAuthorizedMedia(full!));
      const page = await discussion.readDiscussion(target(), null, {
        page: 1,
        pageSize: 50,
      });
      expect(
        [...page.hot, ...page.items].find((comment) => comment.id === sent.id),
      ).toMatchObject({
        text: "",
        images: [
          {
            id: item.id,
            fullSrc: `/api/community/discussion/images/${sent.id}/${item.id}/full`,
          },
        ],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
