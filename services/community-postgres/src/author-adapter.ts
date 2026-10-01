import { enqueueNotification } from "./notifications/source.js";
import { asCommunityOperationError } from "./availability.js";
import { createHash, randomUUID } from "node:crypto";
import { CommunityConflictError, CommunityNotFoundError } from "@moya/api";
import { authorProfileSchema } from "@moya/contracts/schemas";
import type {
  AuthorCommunityPort,
  AuthorListItem,
  AuthorPage,
  OwnedMediaInput,
  OwnedMediaRead,
} from "@moya/api";
import type {
  AuthorListQuery,
  AuthorMedia,
  AuthorProfile,
  AvatarUpdate,
  BackgroundUpdate,
  ContentIdentity,
  ContentRelationUpdate,
  GuestFavoriteMerge,
  PrivacyUpdate,
  ProfileUpdate,
  RelationshipUpdate,
  UserWork,
} from "@moya/contracts";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import { workColumns, workDtos, workVisibleTo } from "./work-dto.js";
import type { WorkRow } from "./work-dto.js";

interface UserRow extends QueryResultRow {
  id: string;
  handle: string;
  display_name: string;
  studio_name: string;
  bio: string;
  following_privacy: "public" | "private";
  followers_privacy: "public" | "private";
  favorites_privacy: "public" | "private";
  likes_privacy: "public" | "private";
  avatar_media_id: string | null;
  background_media_id: string | null;
  next_avatar_at: Date | null;
}
const offset = (q: AuthorListQuery) => (q.page - 1) * q.pageSize;
const opaque = (prefix: string) =>
  `${prefix}-${randomUUID().replaceAll("-", "")}`;
const mediaDto = (r: {
  id: string;
  width: number;
  height: number;
}): AuthorMedia => ({
  id: r.id,
  width: r.width,
  height: r.height,
  src: `/api/community/media/${r.id}`,
});

export class PostgresAuthorCommunityAdapter implements AuthorCommunityPort {
  constructor(private readonly pool: Pool) {}

  private async read<T>(run: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect().catch((error) => {
      throw asCommunityOperationError(error, "connect");
    });
    try {
      await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const result = await run(db);
      await db.query("COMMIT");
      return result;
    } catch (error) {
      await db.query("ROLLBACK").catch(() => undefined);
      throw asCommunityOperationError(error, "query");
    } finally {
      db.release();
    }
  }

  /** Lock the actor before the receipt: retries and device concurrency serialize. */
  private async mutate<T>(
    actor: string,
    request: string,
    action: string,
    subject: string,
    input: unknown,
    run: (db: PoolClient) => Promise<T>,
  ): Promise<T> {
    const db = await this.pool.connect().catch((error) => {
      throw asCommunityOperationError(error, "connect");
    });
    try {
      await db.query("BEGIN");
      await this.active(db, actor, true);
      const fingerprint = createHash("sha256")
        .update(JSON.stringify([action, subject, input]))
        .digest("hex");
      const receipt = (
        await db.query<{ fingerprint: string; result: T }>(
          "SELECT fingerprint,result FROM community.author_command_receipts WHERE actor_id=$1 AND request_id=$2",
          [actor, request],
        )
      ).rows[0];
      if (receipt !== undefined) {
        if (receipt.fingerprint !== fingerprint)
          throw new CommunityConflictError(
            "Request identity was already used for different content",
          );
        await db.query("COMMIT");
        return receipt.result;
      }
      const result = await run(db);
      await db.query(
        "INSERT INTO community.author_events(id,actor_id,action,subject_id) VALUES($1,$2,$3,$4)",
        [opaque("author-event"), actor, action, subject],
      );
      await db.query(
        "INSERT INTO community.author_command_receipts(actor_id,request_id,fingerprint,result) VALUES($1,$2,$3,$4::jsonb)",
        [actor, request, fingerprint, JSON.stringify(result ?? null)],
      );
      await db.query("COMMIT");
      return result;
    } catch (error) {
      await db.query("ROLLBACK").catch(() => undefined);
      throw asCommunityOperationError(error, "query");
    } finally {
      db.release();
    }
  }

  private async active(
    db: PoolClient,
    id: string,
    lock = false,
  ): Promise<void> {
    const r = await db.query(
      `SELECT id FROM community.public_users WHERE id=$1 AND status='active'${lock ? " FOR NO KEY UPDATE" : ""}`,
      [id],
    );
    if (r.rowCount !== 1) throw new CommunityNotFoundError();
  }
  private async accessible(
    db: PoolClient,
    viewer: string | null,
    target: string,
  ): Promise<UserRow> {
    const row = (
      await db.query<UserRow>(
        `SELECT u.*, CASE WHEN avatar_changed_on IS NULL THEN NULL ELSE
      ((avatar_changed_on + 1)::timestamp AT TIME ZONE 'America/New_York') END AS next_avatar_at
      FROM community.public_users u WHERE id=$1 AND status='active' AND community.accounts_can_interact($2,id)`,
        [target, viewer],
      )
    ).rows[0];
    if (!row) throw new CommunityNotFoundError();
    return row;
  }
  private async media(db: PoolClient, ids: string[]): Promise<AuthorMedia[]> {
    const r = await db.query<{ id: string; width: number; height: number }>(
      "SELECT m.id,m.width,m.height FROM unnest($1::text[]) WITH ORDINALITY a(id,n) JOIN community.user_media m ON m.id=a.id WHERE m.deleted_at IS NULL ORDER BY a.n",
      [ids],
    );
    return r.rows.map(mediaDto);
  }
  private async ownedMedia(
    db: PoolClient,
    actor: string,
    ids: string[],
  ): Promise<void> {
    const r = await db.query(
      "SELECT id FROM community.user_media WHERE owner_id=$1 AND id=ANY($2::text[]) AND deleted_at IS NULL FOR SHARE",
      [actor, ids],
    );
    if (r.rowCount !== ids.length || new Set(ids).size !== ids.length)
      throw new CommunityNotFoundError("Media is unavailable to this author");
  }
  private async work(
    db: PoolClient,
    id: string,
    viewer: string | null,
    lock = false,
  ): Promise<WorkRow> {
    const row = (
      await db.query<WorkRow>(
        `SELECT ${workColumns} FROM community.works w JOIN community.public_users u ON u.id=w.author_id
      WHERE w.id=$1 AND ${workVisibleTo("$2")}${lock ? " FOR SHARE OF w" : ""}`,
        [id, viewer],
      )
    ).rows[0];
    if (!row) throw new CommunityNotFoundError();
    return row;
  }
  /**
   * Third parties read the public revision; the author reads the author
   * revision. `available` says whether this viewer may open the work's
   * discussion and interaction surfaces (the rule the discussion store reads
   * with): third parties only while the work is effectively public; the
   * author on their own work outside the recycle bin unless an operator hid
   * or removed it (self-only and pending works included, so no pending state
   * is implied). Comments, likes and favorites are still only written on
   * effectively public works. `coverMediaId` names the cover entry of the
   * same revision and `coverSrc` its card cover still (the rule Home cards
   * use); `authorship` is present only when that revision declares one. Only
   * the author learns `publiclyVisible` (whether third parties can see the
   * work now, community.work_is_public).
   */
  private async workDto(
    db: PoolClient,
    row: WorkRow,
    viewer: string | null,
  ): Promise<UserWork> {
    return (await workDtos(db, [row], viewer))[0]!;
  }
  /**
   * A page of works in row order: the per-row revision choice (author
   * revision for the owner, public revision for others) is kept, while the
   * revisions and their media are read in two statements for the whole page.
   */
  async readProfile(id: string, viewer: string | null): Promise<AuthorProfile> {
    return this.read(async (db) => {
      const u = await this.accessible(db, viewer, id);
      const owner = viewer === id;
      const count = async (sql: string) =>
        Number(
          (await db.query<{ total: string }>(sql, [id])).rows[0]?.total ?? 0,
        );
      // Every total counts exactly what the corresponding list shows this
      // viewer, in this one snapshot. People: active accounts the viewer may
      // interact with (the listPeople rule; a suspended follower or one the
      // viewer blocked is neither listed nor counted). Relations: the
      // discovery collection rule; a Catalog relation counts only while the
      // record is still published, a work relation only while the work is
      // effectively public for this viewer. The relation rows themselves are
      // kept whatever their target's state.
      const peopleCount = async (list: "following" | "followers") =>
        Number(
          (
            await db.query<{ total: string }>(
              list === "following"
                ? "SELECT count(*) AS total FROM community.follows r JOIN community.public_users u ON u.id=r.followed_id WHERE r.follower_id=$1 AND u.status='active' AND community.accounts_can_interact($2,u.id)"
                : "SELECT count(*) AS total FROM community.follows r JOIN community.public_users u ON u.id=r.follower_id WHERE r.followed_id=$1 AND u.status='active' AND community.accounts_can_interact($2,u.id)",
              [id, viewer],
            )
          ).rows[0]?.total ?? 0,
        );
      const relationCount = async (relation: "favorite" | "like") =>
        Number(
          (
            await db.query<{ total: string }>(
              `SELECT count(*) AS total FROM community.content_relations r
              WHERE r.user_id=$1 AND r.relation=$2 AND (
                (r.content_type='catalog' AND EXISTS (SELECT 1 FROM catalog_discovery c WHERE c.catalog_id=r.content_id))
                OR (r.content_type='work' AND EXISTS (
                SELECT 1 FROM community.works w JOIN community.public_users wu ON wu.id=w.author_id
                WHERE w.id=r.content_id AND community.work_is_public(w) AND wu.status='active'
                  AND community.accounts_can_interact($3::text,w.author_id))))`,
              [id, relation, viewer],
            )
          ).rows[0]?.total ?? 0,
        );
      const following =
        viewer === null
          ? false
          : (
              await db.query(
                "SELECT 1 FROM community.follows WHERE follower_id=$1 AND followed_id=$2",
                [viewer, id],
              )
            ).rowCount === 1;
      return authorProfileSchema.parse({
        id,
        handle: u.handle,
        displayName: u.display_name,
        studioName: u.studio_name,
        bio: u.bio,
        avatar: u.avatar_media_id
          ? ((await this.media(db, [u.avatar_media_id]))[0] ?? null)
          : null,
        background: u.background_media_id
          ? ((await this.media(db, [u.background_media_id]))[0] ?? null)
          : null,
        isOwner: owner,
        following,
        privacy: {
          following: u.following_privacy,
          followers: u.followers_privacy,
          favorites: u.favorites_privacy,
          likes: u.likes_privacy,
        },
        totals: {
          works: await count(
            owner
              ? "SELECT count(*) AS total FROM community.works w WHERE w.author_id=$1 AND w.deleted_at IS NULL AND w.trashed_at IS NULL"
              : "SELECT count(*) AS total FROM community.works w WHERE w.author_id=$1 AND community.work_is_public(w)",
          ),
          following:
            owner || u.following_privacy === "public"
              ? await peopleCount("following")
              : null,
          followers:
            owner || u.followers_privacy === "public"
              ? await peopleCount("followers")
              : null,
          favorites:
            owner || u.favorites_privacy === "public"
              ? await relationCount("favorite")
              : null,
          likes:
            owner || u.likes_privacy === "public"
              ? await relationCount("like")
              : null,
        },
        nextAvatarChangeAt: owner
          ? (u.next_avatar_at?.toISOString() ?? null)
          : null,
      });
    });
  }
  async updateProfile(actor: string, input: ProfileUpdate): Promise<void> {
    await this.mutate(
      actor,
      input.requestId,
      "profile.update",
      actor,
      input,
      async (db) => {
        await db.query(
          "UPDATE community.public_users SET display_name=$2,bio=$3,studio_name=CASE WHEN $4::text IS NULL THEN studio_name ELSE $4 END,updated_at=CURRENT_TIMESTAMP WHERE id=$1",
          [actor, input.displayName, input.bio, input.studioName ?? null],
        );
      },
    );
  }
  async updatePrivacy(actor: string, input: PrivacyUpdate): Promise<void> {
    await this.mutate(
      actor,
      input.requestId,
      "privacy.update",
      actor,
      input,
      async (db) => {
        const p = input.privacy;
        await db.query(
          "UPDATE community.public_users SET following_privacy=$2,followers_privacy=$3,favorites_privacy=$4,likes_privacy=$5,updated_at=CURRENT_TIMESTAMP WHERE id=$1",
          [actor, p.following, p.followers, p.favorites, p.likes],
        );
      },
    );
  }
  async updateBackground(
    actor: string,
    input: BackgroundUpdate,
  ): Promise<void> {
    await this.mutate(
      actor,
      input.requestId,
      "background.update",
      actor,
      input,
      async (db) => {
        if (input.mediaId !== null)
          await this.ownedMedia(db, actor, [input.mediaId]);
        await db.query(
          "UPDATE community.public_users SET background_media_id=$2,updated_at=CURRENT_TIMESTAMP WHERE id=$1",
          [actor, input.mediaId],
        );
      },
    );
  }
  async updateAvatar(
    actor: string,
    input: AvatarUpdate,
  ): Promise<{ nextChangeAt: string }> {
    return this.mutate(
      actor,
      input.requestId,
      "avatar.update",
      actor,
      input,
      async (db) => {
        await this.ownedMedia(db, actor, [input.mediaId]);
        const row = (
          await db.query<{ next_change: Date }>(
            `UPDATE community.public_users SET avatar_media_id=$2,
        avatar_changed_on=(statement_timestamp() AT TIME ZONE 'America/New_York')::date,updated_at=CURRENT_TIMESTAMP
        WHERE id=$1 AND (avatar_changed_on IS NULL OR avatar_changed_on < (statement_timestamp() AT TIME ZONE 'America/New_York')::date)
        RETURNING ((avatar_changed_on + 1)::timestamp AT TIME ZONE 'America/New_York') AS next_change`,
            [actor, input.mediaId],
          )
        ).rows[0];
        if (!row)
          throw new CommunityConflictError(
            "Avatar has already changed on this New York calendar date",
          );
        return { nextChangeAt: row.next_change.toISOString() };
      },
    );
  }
  async saveMedia(input: OwnedMediaInput): Promise<AuthorMedia> {
    return this.mutate(
      input.ownerId,
      input.requestId ?? randomUUID(),
      "media.upload",
      input.ownerId,
      { sha256: input.sha256, width: input.width, height: input.height },
      async (db) => {
        await db.query(
          "INSERT INTO community.user_media(id,owner_id,mime_type,width,height,sha256,bytes) VALUES($1,$2,'image/png',$3,$4,$5,$6)",
          [
            input.id,
            input.ownerId,
            input.width,
            input.height,
            input.sha256,
            input.bytes,
          ],
        );
        return mediaDto(input);
      },
    );
  }
  /**
   * A user media PNG: the owner always; others for an avatar, or while a
   * legacy item of it is in the public revision of an effectively public work
   * with its unedited form (edit key `base` without the cover crop). An edited
   * legacy item is shown only through its derivatives, so a rotation or crop
   * never leaves the uncut PNG readable under its old id; a cover crop alone
   * keeps it (the card uses the cover derivative, the work its PNG).
   */
  async readMedia(
    id: string,
    viewer: string | null,
  ): Promise<OwnedMediaRead | null> {
    return this.read(async (db) => {
      const row = (
        await db.query<{ bytes: Buffer; width: number; height: number }>(
          `SELECT m.bytes,m.width,m.height FROM community.user_media m
        JOIN community.public_users u ON u.id=m.owner_id WHERE m.id=$1 AND u.status='active' AND m.deleted_at IS NULL
        AND community.accounts_can_interact($2,m.owner_id) AND (m.owner_id=$2 OR u.avatar_media_id=m.id OR u.background_media_id=m.id OR EXISTS (
          SELECT 1 FROM community.media_items i
          JOIN community.work_revision_items ri ON ri.item_id=i.id
          JOIN community.work_revisions r ON r.id=ri.revision_id
          JOIN community.works w ON w.id=r.work_id AND w.public_revision_id=r.id AND w.author_id=m.owner_id
          WHERE i.legacy_media_id=m.id AND i.owner_id=m.owner_id AND community.work_is_public(w)
            AND community.media_edit_key(ri.edit,NULL)='base'))`,
          [id, viewer],
        )
      ).rows[0];
      return row ?? null;
    });
  }

  async follow(actor: string, input: RelationshipUpdate): Promise<void> {
    if (actor === input.targetId)
      throw new CommunityConflictError("Cannot follow yourself");
    await this.mutate(
      actor,
      input.requestId,
      "follow",
      input.targetId,
      input,
      async (db) => {
        // Pair advisory lock prevents a concurrent block from racing a new follow.
        await this.lockPair(db, actor, input.targetId);
        await this.accessible(db, actor, input.targetId);
        if (input.enabled)
          await db.query(
            "INSERT INTO community.follows(follower_id,followed_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
            [actor, input.targetId],
          );
        else
          await db.query(
            "DELETE FROM community.follows WHERE follower_id=$1 AND followed_id=$2",
            [actor, input.targetId],
          );
      },
    );
  }
  private async lockPair(db: PoolClient, a: string, b: string): Promise<void> {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      [a, b].sort().join(":"),
    ]);
  }
  async block(actor: string, input: RelationshipUpdate): Promise<void> {
    if (actor === input.targetId)
      throw new CommunityConflictError("Cannot block yourself");
    await this.mutate(
      actor,
      input.requestId,
      "block",
      input.targetId,
      input,
      async (db) => {
        await this.lockPair(db, actor, input.targetId);
        if (input.enabled) await this.active(db, input.targetId);
        if (input.enabled) {
          await db.query(
            "INSERT INTO community.blocks(blocker_id,blocked_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
            [actor, input.targetId],
          );
          await db.query(
            "DELETE FROM community.follows WHERE (follower_id=$1 AND followed_id=$2) OR (follower_id=$2 AND followed_id=$1)",
            [actor, input.targetId],
          );
        } else
          await db.query(
            "DELETE FROM community.blocks WHERE blocker_id=$1 AND blocked_id=$2",
            [actor, input.targetId],
          );
      },
    );
  }
  async listPeople(
    id: string,
    viewer: string | null,
    list: "following" | "followers" | "blocks",
    q: AuthorListQuery,
  ): Promise<AuthorPage<AuthorListItem>> {
    return this.read(async (db) => {
      const u = await this.accessible(db, viewer, id);
      if (
        viewer !== id &&
        (list === "blocks" ||
          u[
            list === "following" ? "following_privacy" : "followers_privacy"
          ] !== "public")
      )
        throw new CommunityNotFoundError();
      const from =
        list === "blocks"
          ? "community.blocks r JOIN community.public_users u ON u.id=r.blocked_id WHERE r.blocker_id=$1"
          : list === "following"
            ? "community.follows r JOIN community.public_users u ON u.id=r.followed_id WHERE r.follower_id=$1"
            : "community.follows r JOIN community.public_users u ON u.id=r.follower_id WHERE r.followed_id=$1";
      const eligible = `${from}${list === "blocks" ? "" : " AND u.status='active' AND community.accounts_can_interact($2,u.id)"}`;
      const values = list === "blocks" ? [id] : [id, viewer];
      const total = Number(
        (
          await db.query<{ total: string }>(
            `SELECT count(*) AS total FROM ${eligible}`,
            values,
          )
        ).rows[0]?.total ?? 0,
      );
      const rows = (
        await db.query<UserRow>(
          `SELECT u.* FROM ${eligible} ORDER BY r.created_at DESC,u.id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
          [...values, q.pageSize, offset(q)],
        )
      ).rows;
      // One statement resolves every avatar of the page; rows keep their order.
      const avatars = new Map(
        (
          await this.media(
            db,
            rows.flatMap((row) =>
              row.avatar_media_id ? [row.avatar_media_id] : [],
            ),
          )
        ).map((m) => [m.id, m] as const),
      );
      const items = rows.map((row) => ({
        id: row.id,
        handle: row.handle,
        displayName: row.display_name,
        avatar: row.avatar_media_id
          ? (avatars.get(row.avatar_media_id) ?? null)
          : null,
      }));
      return { items, total, page: q.page, pageSize: q.pageSize };
    });
  }
  async readWork(id: string, viewer: string | null): Promise<UserWork> {
    return this.read(async (db) =>
      this.workDto(db, await this.work(db, id, viewer), viewer),
    );
  }
  async listWorks(
    id: string,
    viewer: string | null,
    q: AuthorListQuery,
  ): Promise<AuthorPage<UserWork>> {
    return this.read(async (db) => {
      await this.accessible(db, viewer, id);
      const where = `w.author_id=$1 AND ${workVisibleTo("$2")}`;
      const from =
        "FROM community.works w JOIN community.public_users u ON u.id=w.author_id";
      const total = Number(
        (
          await db.query<{ total: string }>(
            `SELECT count(*) AS total ${from} WHERE ${where}`,
            [id, viewer],
          )
        ).rows[0]?.total ?? 0,
      );
      const rows = (
        await db.query<WorkRow>(
          `SELECT ${workColumns} ${from} WHERE ${where} ORDER BY COALESCE(w.first_published_at,w.first_submitted_at) DESC NULLS LAST,w.id DESC LIMIT $3 OFFSET $4`,
          [id, viewer, q.pageSize, offset(q)],
        )
      ).rows;
      const items = await workDtos(db, rows, viewer);
      return {
        items,
        total,
        page: q.page,
        pageSize: q.pageSize,
      };
    });
  }
  async changeRelation(
    actor: string,
    relation: "favorite" | "like",
    input: ContentRelationUpdate,
  ): Promise<void> {
    await this.mutate(
      actor,
      input.requestId,
      relation,
      input.target.id,
      input,
      async (db) => {
        if (input.target.type === "work" && input.enabled) {
          // Relations are public interactions: never on a work others cannot see.
          const work = await this.work(db, input.target.id, actor, true);
          if (!work.is_public) throw new CommunityNotFoundError();
          await this.lockPair(db, actor, work.author_id);
          await this.accessible(db, actor, work.author_id);
        }
        const changed = input.enabled
          ? await db.query(
              "INSERT INTO community.content_relations(user_id,content_type,content_id,relation) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
              [actor, input.target.type, input.target.id, relation],
            )
          : await db.query(
              "DELETE FROM community.content_relations WHERE user_id=$1 AND content_type=$2 AND content_id=$3 AND relation=$4",
              [actor, input.target.type, input.target.id, relation],
            );
        if (
          changed.rowCount &&
          relation === "like" &&
          input.target.type === "work"
        )
          await enqueueNotification(db, "work_like", input.target.id, actor);
      },
    );
  }
  async mergeGuestFavorites(
    actor: string,
    input: GuestFavoriteMerge,
  ): Promise<{ acknowledged: readonly ContentIdentity[] }> {
    if (input.expectedAccountId !== actor)
      throw new CommunityConflictError("账户已变化，请重新确认收藏导入账户");
    return this.mutate(
      actor,
      input.requestId,
      "guest-favorites.merge",
      actor,
      input,
      async (db) => {
        const acknowledged: ContentIdentity[] = [];
        for (const target of input.items) {
          // Unavailable relations are retained without claiming public availability.
          await db.query(
            "INSERT INTO community.content_relations(user_id,content_type,content_id,relation) VALUES($1,$2,$3,'favorite') ON CONFLICT DO NOTHING",
            [actor, target.type, target.id],
          );
          acknowledged.push(target);
        }
        return { acknowledged };
      },
    );
  }
}
