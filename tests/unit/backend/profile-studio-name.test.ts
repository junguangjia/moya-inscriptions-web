import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  authRegistrationRequestSchema,
  profileUpdateSchema,
  studioNameInputSchema,
  publicUserProfileSchema,
  commentAuthorSchema,
  authorPersonSchema,
  dmParticipantSchema,
} from "@moya/contracts/schemas";
import {
  CommunitySessionService,
  mapPublicUserProfile,
  normalizeStudioNameInput,
} from "@moya/api";
import {
  mapCommentRow,
  mapReplyRow,
  mapPublicUserRow,
} from "@moya/community-postgres";
import {
  fixtureUsers,
  InMemoryCommunityIdentityPort,
} from "./community-identity-fixture.js";

const profile = { requestId: randomUUID(), displayName: "同名读者", bio: "" };
const registration = {
  handoffToken: "S".repeat(43),
  displayName: "同名读者",
  agreement: true,
  idempotencyKey: randomUUID(),
};

describe("profile studio name composition", () => {
  it("accepts 5+2 Unicode code points, trims inputs, and clears explicitly", () => {
    for (const input of [
      { studioName: " 山水斋 ", studioNameSuffix: " 斋 " },
      { studioName: "🌿".repeat(5) + "书斋", studioNameSuffix: "书斋" },
      { studioName: "山e\u0301斋", studioNameSuffix: "斋" },
      { studioName: "", studioNameSuffix: "" },
      { studioName: "  ", studioNameSuffix: "  " },
    ]) {
      const parsed = studioNameInputSchema.parse(input);
      expect(
        normalizeStudioNameInput(input.studioName, input.studioNameSuffix),
      ).toEqual(parsed);
      expect(profileUpdateSchema.parse({ ...profile, ...input })).toMatchObject(
        parsed,
      );
      expect(
        authRegistrationRequestSchema.parse({ ...registration, ...input }),
      ).toMatchObject(parsed);
    }
  });
  it("rejects incomplete, mismatched, overlong and invalid scalar pairs at all write boundaries", () => {
    for (const input of [
      { studioName: "斋", studioNameSuffix: "斋" },
      { studioName: "", studioNameSuffix: "斋" },
      { studioName: "山斋", studioNameSuffix: "" },
      { studioName: "山阁", studioNameSuffix: "斋" },
      { studioName: "山 斋", studioNameSuffix: "斋" },
      { studioName: "🌿".repeat(6) + "斋", studioNameSuffix: "斋" },
      { studioName: "山藏书楼", studioNameSuffix: "藏书楼" },
      { studioName: "山\u0000斋", studioNameSuffix: "斋" },
      { studioName: "山\ud800斋", studioNameSuffix: "斋" },
      { studioName: "山\udfff", studioNameSuffix: "\udfff" },
    ]) {
      expect(studioNameInputSchema.safeParse(input).success).toBe(false);
      expect(
        normalizeStudioNameInput(input.studioName, input.studioNameSuffix),
      ).toBeNull();
      expect(
        profileUpdateSchema.safeParse({ ...profile, ...input }).success,
      ).toBe(false);
      expect(
        authRegistrationRequestSchema.safeParse({ ...registration, ...input })
          .success,
      ).toBe(false);
    }
    expect(
      profileUpdateSchema.safeParse({ ...profile, studioNameSuffix: "斋" })
        .success,
    ).toBe(false);
    expect(
      authRegistrationRequestSchema.safeParse({
        ...registration,
        studioNameSuffix: "斋",
      }).success,
    ).toBe(false);
  });
  it("retains unpaired legacy writes and omission without allowing a seven-point unpaired write", () => {
    expect(profileUpdateSchema.parse(profile)).not.toHaveProperty("studioName");
    for (const studioName of ["", "旧六字无后缀", "🌿".repeat(6)]) {
      expect(
        profileUpdateSchema.parse({ ...profile, studioName }).studioName,
      ).toBe(studioName);
      expect(
        authRegistrationRequestSchema.parse({ ...registration, studioName })
          .studioName,
      ).toBe(studioName);
      expect(normalizeStudioNameInput(studioName, undefined)).toEqual({
        studioName,
        studioNameSuffix: "",
      });
    }
    expect(
      profileUpdateSchema.safeParse({ ...profile, studioName: "🌿".repeat(7) })
        .success,
    ).toBe(false);
    expect(
      authRegistrationRequestSchema.safeParse({
        ...registration,
        studioName: "🌿".repeat(7),
      }).success,
    ).toBe(false);
  });
  it("carries the combined label through public identity projections without changing identity or status visibility", async () => {
    const studioName = "🌿".repeat(5) + "书斋";
    const user = { ...fixtureUsers.active, studioName };
    const projected = mapPublicUserProfile(user);
    expect(projected).toEqual({
      id: user.id,
      handle: user.handle,
      displayName: user.displayName,
      studioName,
    });
    expect(publicUserProfileSchema.parse(projected)).toEqual(projected);
    expect(
      commentAuthorSchema.parse({
        id: user.id,
        displayName: user.displayName,
        studioName,
      }).studioName,
    ).toBe(studioName);
    expect(
      authorPersonSchema.parse({ ...projected, avatar: null }).studioName,
    ).toBe(studioName);
    expect(
      dmParticipantSchema.parse({
        id: user.id,
        displayName: user.displayName,
        studioName,
        available: true,
      }).studioName,
    ).toBe(studioName);
    const service = new CommunitySessionService(
      new InMemoryCommunityIdentityPort([user]),
    );
    const session = await service.signInDevelopmentAccount(user.handle);
    expect(session?.profile).toEqual(projected);
    expect(await service.identify(session!.token)).toEqual(projected);
    expect(
      mapPublicUserRow({
        id: user.id,
        handle: user.handle,
        display_name: user.displayName,
        studio_name: studioName,
        status: "active",
      }),
    ).toEqual(user);
    const row = {
      id: "comment-" + "1".repeat(32),
      catalog_id: "synthetic-studio",
      root_comment_id: "comment-" + "2".repeat(32),
      text: "合成评论",
      created_at: new Date(),
      moderation: "visible",
      author_id: user.id,
      author_display_name: user.displayName,
      author_studio_name: studioName,
      reply_to_author_id: fixtureUsers.second.id,
      reply_to_display_name: fixtureUsers.second.displayName,
      reply_to_studio_name: "问石斋",
    };
    expect(mapCommentRow(row).author.studioName).toBe(studioName);
    expect(mapReplyRow(row).author.studioName).toBe(studioName);
    expect(mapReplyRow(row).replyTo?.studioName).toBe("问石斋");
    expect(() =>
      mapPublicUserRow({
        id: user.id,
        handle: user.handle,
        display_name: user.displayName,
        studio_name: "山\u0000",
        status: "active",
      }),
    ).toThrow();
    expect(() =>
      mapCommentRow({ ...row, author_studio_name: "山\ud800" }),
    ).toThrow();
  });
});
