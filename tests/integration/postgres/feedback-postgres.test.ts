import { randomUUID } from "node:crypto";
import {
  emptyArticleDocument,
  publicUserIdSchema,
  registerMediaItemCommandSchema,
  submitFeedbackRequestSchema,
} from "@moya/contracts/schemas";
import type { WorkDraftContent } from "@moya/contracts";
import { FeedbackService } from "@moya/api";
import {
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import {
  PostgresFeedbackAdapter,
  PostgresWorkPublishingAdapter,
  PostgresArticleAuthoringAdapter,
} from "@moya/community-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCatalogScaleDatabase,
  type CatalogScaleDatabase,
} from "./catalog-scale-fixture.js";
import { requireSyntheticTestDatabaseUrl } from "./synthetic-test-database.js";

const target = requireSyntheticTestDatabaseUrl();
let db: CatalogScaleDatabase;
let feedback: FeedbackService;
let alice: string, bob: string;
const userId = () => `user-${randomUUID().replaceAll("-", "")}`;
const submit = (message: string) => ({ submissionId: randomUUID(), message });

beforeAll(async () => {
  db = await createCatalogScaleDatabase({
    target,
    label: "feedback",
    openPool: (url) =>
      createPostgresPool(parsePostgresConfig({ DATABASE_URL: url })),
  });
  feedback = new FeedbackService(new PostgresFeedbackAdapter(db.app));
  alice = userId();
  bob = userId();
  for (const [id, label] of [
    [alice, "Alice"],
    [bob, "Bob"],
  ])
    await db.setup.query(
      "INSERT INTO community.public_users(id,handle,display_name) VALUES($1,$2,$3)",
      [id, `feedback-${id!.slice(-20)}`, `Synthetic ${label}`],
    );
}, 60000);
afterAll(async () => {
  await db?.close();
});

describe("private feedback persistence under the real App role", () => {
  it("commits a trimmed message before returning its minimal receipt", async () => {
    const input = submit("  Synthetic saved feedback\n ");
    const receipt = await feedback.submit(alice, input);
    const saved = (
      await db.setup.query("SELECT * FROM community.feedback WHERE id=$1", [
        receipt.id,
      ])
    ).rows[0];
    expect(saved.message).toBe("Synthetic saved feedback");
    expect(saved.user_id).toBe(alice);
    expect(saved.created_at.toISOString()).toBe(receipt.createdAt);
    expect(Object.keys(receipt).sort()).toEqual(["createdAt", "id"]);
    expect(await feedback.submit(alice, input)).toEqual(receipt);
    await expect(
      feedback.submit(alice, { ...input, message: "Changed message" }),
    ).rejects.toMatchObject({ name: "CommunityConflictError" });
  });

  it("serializes concurrent retries and keeps submission keys scoped to the user", async () => {
    const input = submit("Synthetic concurrent feedback");
    const receipts = await Promise.all(
      Array.from({ length: 6 }, () => feedback.submit(alice, input)),
    );
    expect(new Set(receipts.map(({ id }) => id)).size).toBe(1);
    expect(
      (
        await db.setup.query(
          "SELECT count(*) AS n FROM community.feedback WHERE user_id=$1 AND submission_id=$2",
          [alice, input.submissionId],
        )
      ).rows[0]?.n,
    ).toBe("1");
    expect((await feedback.submit(bob, input)).id).not.toBe(receipts[0]!.id);
    const race = submit("First contender");
    const results = await Promise.allSettled([
      feedback.submit(alice, race),
      feedback.submit(alice, { ...race, message: "Second contender" }),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(
      1,
    );
  });

  it("pages feedback newest first with the submitter display name", async () => {
    const earlier = await feedback.submit(
      alice,
      submit("Synthetic page earlier"),
    );
    const later = await feedback.submit(bob, submit("Synthetic page later"));
    await db.setup.query(
      "UPDATE community.feedback SET created_at=$2 WHERE id=$1",
      [earlier.id, "2090-01-01T00:00:00Z"],
    );
    await db.setup.query(
      "UPDATE community.feedback SET created_at=$2 WHERE id=$1",
      [later.id, "2090-01-02T00:00:00Z"],
    );
    const first = await feedback.operatorList({ page: 1, pageSize: 1 });
    const second = await feedback.operatorList({ page: 2, pageSize: 1 });
    expect(first.items[0]).toMatchObject({
      id: later.id,
      user: { id: bob, displayName: "Synthetic Bob" },
    });
    expect(second.items[0]?.id).toBe(earlier.id);
    expect(first.total).toBeGreaterThanOrEqual(2);
    expect(second.total).toBe(first.total);
  });

  it("rejects invalid text and inactive accounts without creating rows", async () => {
    for (const message of ["", " \n\t", "a".repeat(5001)])
      await expect(async () =>
        feedback.submit(alice, submit(message)),
      ).rejects.toMatchObject({ name: "CommunityInputError" });
    await db.setup.query(
      "UPDATE community.public_users SET status='suspended' WHERE id=$1",
      [bob],
    );
    await expect(
      feedback.submit(bob, submit("Should not save")),
    ).rejects.toMatchObject({ name: "CommunityConflictError" });
    expect(
      (
        await db.setup.query(
          "SELECT count(*) AS n FROM community.feedback WHERE message='Should not save'",
        )
      ).rows[0]?.n,
    ).toBe("0");
  });

  it("keeps public database reads denied and runtime feedback append-only", async () => {
    const privileges = (
      await db.app.query(
        "SELECT has_table_privilege(current_user,'community.feedback','SELECT') AS read, has_table_privilege(current_user,'community.feedback','INSERT') AS insert, has_table_privilege(current_user,'community.feedback','UPDATE') AS update, has_table_privilege(current_user,'community.feedback','DELETE') AS delete",
      )
    ).rows[0];
    expect(privileges).toEqual({
      read: true,
      insert: true,
      update: false,
      delete: false,
    });
    const feedbackOid = (
      await db.setup.query("SELECT 'community.feedback'::regclass::oid AS id")
    ).rows[0]!.id;
    const publicPrivileges = (
      await db.publicRead.query(
        "SELECT has_table_privilege(current_user,$1::oid,'SELECT') AS read, has_table_privilege(current_user,$1::oid,'INSERT') AS insert",
        [feedbackOid],
      )
    ).rows[0];
    expect(publicPrivileges).toEqual({ read: false, insert: false });
    await expect(
      db.publicRead.query("SELECT message FROM community.feedback"),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      db.app.query("UPDATE community.feedback SET message='Changed'"),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      db.app.query("DELETE FROM community.feedback"),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

const opaque = (prefix: string) =>
  `${prefix}-${randomUUID().replaceAll("-", "")}`;
const readyImage = async (
  owner: string,
  purpose: "content" | "feedback" = "feedback",
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
const workContent = (itemId: string): WorkDraftContent => ({
  title: "Synthetic forbidden feedback",
  body: "",
  authorship: null,
  visibility: "public",
  items: [
    {
      key: itemId,
      itemId,
      kind: "static",
      qualityMode: "original",
      edit: { rotation: 0, crop: null },
    },
  ],
  coverKey: null,
  coverCrop: null,
});

describe("feedback image ownership, pins and content isolation", () => {
  it("saves ordered private images atomically and replays one immutable receipt", async () => {
    const first = await readyImage(alice),
      second = await readyImage(alice);
    const input = {
      ...submit("Synthetic image feedback"),
      imageIds: [second, first],
    };
    const receipts = await Promise.all(
      Array.from({ length: 4 }, () => feedback.submit(alice, input)),
    );
    expect(new Set(receipts.map((x) => x.id)).size).toBe(1);
    expect(
      (
        await db.setup.query(
          "SELECT item_id FROM community.feedback_images WHERE feedback_id=$1 ORDER BY position",
          [receipts[0]!.id],
        )
      ).rows.map((x) => x.item_id),
    ).toEqual([second, first]);
    expect(
      (
        await db.setup.query(
          "SELECT count(*) AS n FROM community.media_item_refs WHERE holder_kind='feedback' AND holder_id=$1",
          [receipts[0]!.id],
        )
      ).rows[0]!.n,
    ).toBe("2");
    await expect(
      feedback.submit(alice, { ...input, imageIds: [first, second] }),
    ).rejects.toMatchObject({ name: "CommunityConflictError" });
    const page = await feedback.operatorList({ page: 1, pageSize: 50 });
    expect(
      page.items.find((x) => x.id === receipts[0]!.id)?.images.map((x) => x.id),
    ).toEqual([second, first]);
    expect(
      page.items.find((x) => x.id === receipts[0]!.id)?.images[0],
    ).toMatchObject({
      width: 40,
      height: 20,
      thumbSrc: expect.stringContaining(
        `/feedback-media/${receipts[0]!.id}/${second}/thumb`,
      ),
      src: expect.stringContaining(
        `/feedback-media/${receipts[0]!.id}/${second}/display`,
      ),
    });
    const adapter = new PostgresFeedbackAdapter(db.app);
    expect(
      await adapter.resolveFeedbackImage(receipts[0]!.id, first, "full"),
    ).toMatchObject({ contentType: "image/webp", byteSize: 1 });
    expect(
      await adapter.resolveFeedbackImage(opaque("feedback"), first, "full"),
    ).toBeNull();
  });

  it("rejects foreign/content/not-ready images without leaving feedback or refs", async () => {
    const foreign = await readyImage(bob),
      content = await readyImage(alice, "content"),
      pending = await readyImage(alice);
    await db.setup.query(
      "UPDATE community.media_items SET state='processing' WHERE id=$1",
      [pending],
    );
    for (const id of [foreign, content, pending, opaque("media-item")]) {
      const input = { ...submit("Invalid image selection"), imageIds: [id] };
      await expect(feedback.submit(alice, input)).rejects.toMatchObject({
        name: "CommunityInputError",
      });
      expect(
        (
          await db.setup.query(
            "SELECT count(*) AS n FROM community.feedback WHERE user_id=$1 AND submission_id=$2",
            [alice, input.submissionId],
          )
        ).rows[0]!.n,
      ).toBe("0");
    }
    expect(
      submitFeedbackRequestSchema.safeParse({
        ...submit("Too many"),
        imageIds: Array.from({ length: 4 }, () => opaque("media-item")),
      }).success,
    ).toBe(false);
    expect(
      submitFeedbackRequestSchema.safeParse({
        ...submit("Duplicate"),
        imageIds: [content, content],
      }).success,
    ).toBe(false);
  });

  it("keeps submitted images after lease discard and denies public media reads", async () => {
    const publishing = new PostgresWorkPublishingAdapter(db.app),
      now = new Date();
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
    const receipt = await feedback.submit(alice, {
      ...submit("Pinned after discard"),
      imageIds: [image],
    });
    await publishing.discardSession(
      alice,
      session.id,
      { requestId: randomUUID() },
      now,
    );
    expect(
      (
        await db.setup.query(
          "SELECT state FROM community.media_items WHERE id=$1",
          [image],
        )
      ).rows[0]!.state,
    ).toBe("ready");
    expect(
      await publishing.resolveMediaRead(null, image, "display", "base"),
    ).toBeNull();
    expect(
      await publishing.resolveMediaRead(bob, image, "display", "base"),
    ).toBeNull();
    expect(
      await publishing.resolveMediaRead(alice, image, "display", "base"),
    ).toMatchObject({ contentType: "image/webp" });
    expect(
      await publishing.purgeItem(
        image,
        new Date(now.getTime() + 1000 * 86400 * 100),
      ),
    ).toMatchObject({ status: "referenced" });
    expect(
      await new PostgresFeedbackAdapter(db.app).resolveFeedbackImage(
        receipt.id,
        image,
        "display",
      ),
    ).not.toBeNull();
  });

  it("registers feedback only in no-work leases, strips metadata and fixes its purpose", async () => {
    const publishing = new PostgresWorkPublishingAdapter(db.app),
      now = new Date();
    const session = await publishing.createSession(
      alice,
      { requestId: randomUUID(), workId: null },
      now,
    );
    const command = registerMediaItemCommandSchema.parse({
      requestId: randomUUID(),
      purpose: "feedback",
      holder: { sessionId: session.id },
      kind: "static",
      qualityMode: "original",
      components: [{ role: "still", byteSize: 1, contentType: "image/png" }],
      metadata: {
        provenance: { source: "client", parser: "synthetic", status: "parsed" },
        values: { GPSLatitude: 1, GPSLongitude: 2 },
      },
    });
    const item = await publishing.registerItem(alice, command, now);
    expect(
      (
        await db.setup.query(
          "SELECT purpose,private_metadata FROM community.media_items WHERE id=$1",
          [item.id],
        )
      ).rows[0],
    ).toEqual({ purpose: "feedback", private_metadata: null });
    await expect(
      db.app.query(
        "UPDATE community.media_items SET purpose='content' WHERE id=$1",
        [item.id],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      db.setup.query(
        "UPDATE community.media_items SET purpose='content' WHERE id=$1",
        [item.id],
      ),
    ).rejects.toMatchObject({ code: "23000" });
    const work = opaque("work");
    await db.setup.query(
      "INSERT INTO community.works(id,author_id,title,text,first_published_at) VALUES($1,$2,'Synthetic linked Work','',CURRENT_TIMESTAMP)",
      [work, alice],
    );
    const linked = await publishing.createSession(
      alice,
      { requestId: randomUUID(), workId: work },
      now,
    );
    await expect(
      publishing.registerItem(
        alice,
        {
          ...command,
          requestId: randomUUID(),
          holder: { sessionId: linked.id },
        },
        now,
      ),
    ).rejects.toMatchObject({ name: "CommunityInputError" });
    const normal = await publishing.registerItem(
      alice,
      { ...command, requestId: randomUUID(), purpose: undefined },
      now,
    );
    expect(
      (
        await db.setup.query(
          "SELECT purpose FROM community.media_items WHERE id=$1",
          [normal.id],
        )
      ).rows[0]!.purpose,
    ).toBe("content");
    expect(
      registerMediaItemCommandSchema.safeParse({
        ...command,
        components: [
          {
            role: "still",
            byteSize: 10 * 1024 * 1024 + 1,
            contentType: "image/png",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      registerMediaItemCommandSchema.safeParse({
        ...command,
        holder: { draftId: opaque("work-draft") },
      }).success,
    ).toBe(false);
    expect(
      registerMediaItemCommandSchema.safeParse({ ...command, kind: "live" })
        .success,
    ).toBe(false);
  });

  it("cannot reuse feedback items in Work or Article content and hides them from the media chooser", async () => {
    const publishing = new PostgresWorkPublishingAdapter(db.app),
      image = await readyImage(alice),
      now = new Date();
    await expect(
      publishing.createDraft(
        alice,
        {
          requestId: randomUUID(),
          content: workContent(image),
          deviceClass: "desktop",
        },
        now,
      ),
    ).rejects.toMatchObject({ name: "CommunityNotFoundError" });
    const actor = {
      source: "human" as const,
      userId: publicUserIdSchema.parse(alice),
    };
    const articles = new PostgresArticleAuthoringAdapter(db.app);
    expect(
      (await articles.listOwnMedia(actor, { pageSize: 50 }, now)).items.some(
        (x) => x.id === image,
      ),
    ).toBe(false);
    const document = {
      ...emptyArticleDocument(),
      blocks: [
        {
          id: "synthetic-picture",
          type: "managedImage" as const,
          props: { refId: "image", caption: "", alt: "" },
          children: [],
        },
      ],
      references: { image: { type: "managed" as const, itemId: image } },
    };
    await expect(
      articles.create(
        actor,
        {
          requestId: randomUUID(),
          title: "Forbidden feedback image",
          coverRefId: null,
          document,
        },
        now,
      ),
    ).rejects.toMatchObject({
      code: "ARTICLE_REFERENCES_UNAVAILABLE",
      message: "article_references_unavailable",
    });
    const session = await publishing.createSession(
      alice,
      { requestId: randomUUID(), workId: null },
      now,
    );
    await expect(
      publishing.submit(
        alice,
        {
          requestId: randomUUID(),
          holder: { sessionId: session.id },
          content: { ...workContent(image), authorship: { kind: "original" } },
          baseRevisionId: null,
        },
        now,
      ),
    ).rejects.toMatchObject({ name: "CommunityNotFoundError" });
  });
});
