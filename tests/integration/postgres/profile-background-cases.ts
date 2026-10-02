import { randomUUID, createHash } from "node:crypto";
import { CommunityNotFoundError, CommunityConflictError } from "@moya/api";
import {
  createBackendApplication,
  createDevelopmentCatalogFixtureQueryPort,
  startBackendProcess,
} from "@moya/backend-runtime";
import type { BackendProcessHandle } from "@moya/backend-runtime";
import type { createPostgresPool } from "@moya/catalog-postgres";
import {
  PostgresAuthorCommunityAdapter,
  PostgresCommunityIdentityAdapter,
} from "@moya/community-postgres";
import { UnconfiguredStorageUrlResolver } from "@moya/image";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const opaque = (kind: string) => `${kind}-${randomUUID().replaceAll("-", "")}`;
export const registerProfileBackgroundTests = (
  pool: ReturnType<typeof createPostgresPool>,
) => {
  describe("persistent owned profile backgrounds", () => {
    const adapter = new PostgresAuthorCommunityAdapter(pool);
    let owner: string, other: string, media: string;
    let server: BackendProcessHandle | undefined;
    beforeEach(async () => {
      owner = opaque("user");
      other = opaque("user");
      media = opaque("user-media");
      for (const user of [owner, other]) {
        await pool.query(
          "INSERT INTO community.public_users(id,handle,display_name) VALUES($1,$2,'背景测试用户')",
          [user, `background-${user.slice(-16)}`],
        );
        await pool.query(
          "INSERT INTO community.development_accounts(user_id,label) VALUES($1,'Synthetic background test')",
          [user],
        );
      }
      const bytes = await sharp({
        create: { width: 16, height: 9, channels: 4, background: "#336699" },
      })
        .png()
        .toBuffer();
      await adapter.saveMedia({
        id: media,
        ownerId: owner,
        bytes,
        width: 16,
        height: 9,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    });
    afterEach(async () => {
      await server?.shutdown();
      server = undefined;
      const users = [owner, other];
      await pool.query(
        "DELETE FROM community.blocks WHERE blocker_id=ANY($1) OR blocked_id=ANY($1)",
        [users],
      );
      await pool.query(
        "DELETE FROM community.follows WHERE follower_id=ANY($1) OR followed_id=ANY($1)",
        [users],
      );
      await pool.query("DELETE FROM community.sessions WHERE user_id=ANY($1)", [
        users,
      ]);
      await pool.query(
        "DELETE FROM community.development_accounts WHERE user_id=ANY($1)",
        [users],
      );
      await pool.query(
        "DELETE FROM community.author_command_receipts WHERE actor_id=ANY($1)",
        [users],
      );
      await pool.query(
        "DELETE FROM community.author_events WHERE actor_id=ANY($1)",
        [users],
      );
      await pool.query(
        "UPDATE community.public_users SET background_media_id=NULL,avatar_media_id=NULL WHERE id=ANY($1)",
        [users],
      );
      await pool.query(
        "DELETE FROM community.user_media WHERE owner_id=ANY($1)",
        [users],
      );
      await pool.query("DELETE FROM community.public_users WHERE id=ANY($1)", [
        users,
      ]);
    });
    it("persists the cover across readers, makes only the selected cover public, and clears it explicitly", async () => {
      expect(await adapter.readMedia(media, null)).toBeNull();
      const command = { requestId: randomUUID(), mediaId: media };
      await adapter.updateBackground(owner, command);
      await adapter.updateBackground(owner, command);
      const reloaded = new PostgresAuthorCommunityAdapter(pool);
      expect((await reloaded.readProfile(owner, other)).background?.id).toBe(
        media,
      );
      expect((await reloaded.readProfile(owner, owner)).avatar).toBeNull();
      expect(await reloaded.readMedia(media, null)).not.toBeNull();
      await expect(
        adapter.updateBackground(owner, { ...command, mediaId: null }),
      ).rejects.toBeInstanceOf(CommunityConflictError);
      await adapter.updateBackground(owner, {
        requestId: randomUUID(),
        mediaId: null,
      });
      expect((await reloaded.readProfile(owner, owner)).background).toBeNull();
      expect(await reloaded.readMedia(media, null)).toBeNull();
    });
    it("rejects another owner's or permanently erased media and respects blocking", async () => {
      await expect(
        adapter.updateBackground(other, {
          requestId: randomUUID(),
          mediaId: media,
        }),
      ).rejects.toBeInstanceOf(CommunityNotFoundError);
      await adapter.updateBackground(owner, {
        requestId: randomUUID(),
        mediaId: media,
      });
      await adapter.block(owner, {
        requestId: randomUUID(),
        targetId: other,
        enabled: true,
      });
      expect(await adapter.readMedia(media, other)).toBeNull();
      await adapter.updateBackground(owner, {
        requestId: randomUUID(),
        mediaId: null,
      });
      await pool.query(
        "UPDATE community.user_media SET deleted_at=CURRENT_TIMESTAMP,bytes=''::bytea WHERE id=$1",
        [media],
      );
      expect(await adapter.readMedia(media, owner)).toBeNull();
      await expect(
        adapter.updateBackground(owner, {
          requestId: randomUUID(),
          mediaId: media,
        }),
      ).rejects.toBeInstanceOf(CommunityNotFoundError);
      await expect(
        adapter.updateAvatar(owner, {
          requestId: randomUUID(),
          mediaId: media,
        }),
      ).rejects.toBeInstanceOf(CommunityNotFoundError);
    });
    it("requires a real session and account assertion through HTTP, validates input, and preserves those checks in Production", async () => {
      const start = async (nodeEnv: "development" | "production") => {
        server = await startBackendProcess({
          listen: { host: "127.0.0.1", port: 0 },
          requestListener: createBackendApplication({
            nodeEnv,
            communityIdentityPort: new PostgresCommunityIdentityAdapter(pool),
            authorCommunityPort: adapter,
            catalogQueryPort: createDevelopmentCatalogFixtureQueryPort(),
            storageUrlResolver: new UnconfiguredStorageUrlResolver(),
          }),
        });
        return `http://127.0.0.1:${server.address.port}`;
      };
      const base = await start("development");
      const login = await fetch(`${base}/v1/development/sign-in`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle: `background-${owner.slice(-16)}` }),
      });
      const { token } = (await login.json()) as { token: string };
      const post = (
        body: unknown,
        account = owner,
        authenticated = true,
        target = base,
      ) =>
        fetch(`${target}/v1/community/me/background`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-author-account": account,
            ...(authenticated ? { authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(body),
        });
      const body = { requestId: randomUUID(), mediaId: media };
      expect((await post(body, owner, false)).status).toBe(401);
      expect((await post(body, other)).status).toBe(401);
      expect(
        (await post({ ...body, rawUrl: "https://example.invalid/image.png" }))
          .status,
      ).toBe(422);
      expect((await post(body)).status).toBe(200);
      await server!.shutdown();
      const production = await start("production");
      const productionBody = { requestId: randomUUID(), mediaId: null };
      expect(
        (await post(productionBody, owner, false, production)).status,
      ).toBe(401);
      expect((await post(productionBody, other, true, production)).status).toBe(
        401,
      );
      expect((await post(productionBody, owner, true, production)).status).toBe(
        200,
      );
      expect((await adapter.readProfile(owner, owner)).background).toBeNull();
      expect(
        (
          await fetch(`${production}/v1/development/sign-in`, {
            method: "POST",
          })
        ).status,
      ).toBe(404);
    });
  });
};
