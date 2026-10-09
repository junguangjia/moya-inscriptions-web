import { createHash, randomUUID } from "node:crypto";
import type { createPostgresPool } from "@moya/catalog-postgres";
import type { ArticleAuthoringActor } from "@moya/api";
import type {
  ArticleAuthoringDocument,
  WorkDraftContent,
  PublicUserId,
} from "@moya/contracts";
import { emptyArticleDocument } from "@moya/contracts/schemas";
import {
  PostgresArticleAuthoringAdapter,
  PostgresMediaPublicationAdapter,
  resolvePublishedArticleManagedMedia,
} from "@moya/community-postgres";
import { mapPublishedMedia } from "@moya/backend-production/internal/publication";
import { describe, expect, it } from "vitest";

type Pool = ReturnType<typeof createPostgresPool>;
const hex = () => randomUUID().replaceAll("-", "");
const id = (prefix: string) => `${prefix}-${hex()}`;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const now = new Date("2026-09-30T12:10:00Z");
const options = { isPublic: () => true, allowPublish: () => true };

/** The caller owns an isolated database and drops it, including immutable Article history. */
export const registerArticleMediaPublicationCases = (pools: {
  setup: () => Pool;
  app: () => Pool;
}) => {
  describe("Article-only media publication", () => {
    it.each([
      { width: 6000, height: 4500, roles: ["display", "viewer", "full"] },
      { width: 9000, height: 6750, roles: ["display", "viewer"] },
    ])(
      "delivers the complete public group for $width × $height and withdraws it",
      async ({ width, height, roles }) => {
        const setup = pools.setup(),
          app = pools.app();
        const owner = id("user") as PublicUserId;
        const item = id("media-item") as NonNullable<
          WorkDraftContent["items"][number]["itemId"]
        >;
        const actor: ArticleAuthoringActor = { source: "human", userId: owner };
        const articles = new PostgresArticleAuthoringAdapter(app, {
          publication: options,
        });
        const publication = new PostgresMediaPublicationAdapter(app, options);
        await setup.query(
          "INSERT INTO community.public_users(id,handle,display_name) VALUES($1,$2,'Article publication fixture')",
          [owner, `article-pub-${hex().slice(0, 20)}`],
        );
        await setup.query(
          "INSERT INTO community.media_items(id,owner_id,kind,quality_mode,source,state,presentation,ready_at) VALUES($1,$2,'static','standard','upload','ready',$3::jsonb,$4)",
          [item, owner, JSON.stringify({ width, height }), now],
        );
        const original = id("media-blob"),
          originalKey = hex();
        await setup.query(
          "INSERT INTO community.media_blobs(id,owner_id,purpose,storage_key,byte_size,sha256,content_type,created_at) VALUES($1,$2,'original',$3,128,$4,'image/jpeg',$5)",
          [
            original,
            owner,
            `blobs/${originalKey.slice(0, 2)}/${originalKey.slice(2, 4)}/${originalKey}`,
            sha(original),
            now,
          ],
        );
        await setup.query(
          "INSERT INTO community.media_components(id,item_id,owner_id,role,declared_bytes,declared_type,state,received_bytes,sha256,blob_id) VALUES($1,$2,$3,'still',128,'image/jpeg','verified',128,$4,$5)",
          [id("media-component"), item, owner, sha(original), original],
        );
        for (const [role, w, h] of [
          ["display", 2048, 1536],
          ["viewer", 4096, 3072],
          ["full", width, height],
        ] as const) {
          const blob = id("media-blob"),
            key = hex();
          await setup.query(
            "INSERT INTO community.media_blobs(id,owner_id,purpose,storage_key,byte_size,sha256,content_type,created_at) VALUES($1,$2,'derivative',$3,128,$4,'image/webp',$5)",
            [
              blob,
              owner,
              `blobs/${key.slice(0, 2)}/${key.slice(2, 4)}/${key}`,
              sha(blob),
              now,
            ],
          );
          await setup.query(
            "INSERT INTO community.media_renditions(id,item_id,edit_key,role,recipe_version,recipe_digest,blob_id,width,height,content_type,created_at) VALUES($1,$2,'base',$3,1,'1111111111111111',$4,$5,$6,'image/webp',$7)",
            [id("media-rendition"), item, role, blob, w, h, now],
          );
        }
        const document: ArticleAuthoringDocument = {
          ...emptyArticleDocument(),
          blocks: [
            {
              id: "picture",
              type: "managedImage",
              props: { refId: "image", caption: "", alt: "" },
              children: [],
            },
          ],
          references: { image: { type: "managed", itemId: item } },
        };
        const draft = await articles.create(
          actor,
          {
            requestId: randomUUID(),
            title: "Article publication fixture",
            coverRefId: null,
            document,
          },
          now,
        );
        const candidate = (value: typeof draft) => ({
          requestId: randomUUID(),
          expectedVersion: value.version,
          fingerprint: value.fingerprint,
        });
        const article = await articles.publish(
          actor,
          draft.id,
          candidate(draft),
          now,
        );
        expect(article.status).toBe("published");
        expect(
          (
            await setup.query(
              "SELECT 1 FROM community.work_revision_items WHERE item_id=$1",
              [item],
            )
          ).rows,
        ).toEqual([]);
        const leaseOwner = hex();
        const jobs = await setup.query<{ id: string }>(
          "UPDATE community.publishing_jobs SET state='running',attempts=1,lease_owner=$2,lease_expires_at=$3 WHERE subject_id=$1 AND kind='publish_media' AND state='queued' RETURNING id",
          [item, leaseOwner, new Date(now.getTime() + 3600000)],
        );
        expect(jobs.rows).toHaveLength(1);
        const plan = await publication.planPublish(
          item,
          { id: jobs.rows[0]!.id, leaseOwner },
          now,
        );
        expect(plan.status).toBe("ready");
        if (plan.status !== "ready")
          throw new Error("Expected a ready Article publication plan");
        expect(plan.units.map((unit) => unit.role).sort()).toEqual(
          [...roles].sort(),
        );
        const relay = (
          await resolvePublishedArticleManagedMedia(app, owner, [item])
        ).get(item)!;
        expect(relay.renditions?.map((r) => r.width)).toEqual(
          width === 6000 ? [2048, 4096, 6000] : [2048, 4096],
        );
        const delivery = {
          enabled: () => true,
          origin: "https://images.example.test",
          lookup: publication.lookupPublishedItems.bind(publication),
        };
        expect(await mapPublishedMedia(relay, delivery)).toEqual(relay);
        expect(await publication.finishPublish(plan.fence, now)).toBe(true);
        await publication.release(plan.fence, now);
        const keys = await publication.lookupPublishedItems([item], now);
        expect([...keys.keys()].sort()).toEqual(
          roles
            .map(
              (role) => `/api/community/publishing/media/${item}/${role}/base`,
            )
            .sort(),
        );
        const mapped = await mapPublishedMedia(relay, delivery);
        expect(mapped.src).toBe(`${delivery.origin}/${keys.get(relay.src)}`);
        expect(mapped.renditions?.map((r) => r.src)).toEqual(
          relay.renditions!.map((r) => `${delivery.origin}/${keys.get(r.src)}`),
        );
        await articles.withdraw(actor, article.id, candidate(article), now);
        expect((await publication.lookupPublishedItems([item], now)).size).toBe(
          0,
        );
        expect(
          (await resolvePublishedArticleManagedMedia(app, owner, [item])).size,
        ).toBe(0);
        expect(
          (
            await setup.query(
              "SELECT role FROM community.media_renditions WHERE item_id=$1 AND state='ready' ORDER BY role",
              [item],
            )
          ).rows,
        ).toEqual([{ role: "display" }, { role: "full" }, { role: "viewer" }]);
        expect(
          (
            await setup.query(
              "SELECT count(*)::integer AS count FROM community.media_blobs WHERE owner_id=$1 AND state='committed'",
              [owner],
            )
          ).rows,
        ).toEqual([{ count: 4 }]);
      },
    );
  });
};
