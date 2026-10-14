import type { AuthorMedia } from "@moya/contracts";
import { describe, expect, it } from "vitest";

import { avatarImage, avatarThumbSrc, coverSrc } from "./profile-image";

/*
 * profile-media-renditions-v1: small avatars load `avatar-128`, the 80 px
 * header and 96 px registration avatars choose 128 or 512 by pixel density,
 * and the cover loads one URL, the largest background rendition. Without
 * renditions every surface keeps the original `src`.
 */
const id = `user-media-${"a".repeat(32)}`;
const original = `/api/community/media/${id}`;
const rendition = (role: string, width: number, height: number) => ({
  src: `${original}/${role}`,
  width,
  height,
  contentType: "image/webp" as const,
});
const avatar: AuthorMedia = {
  id,
  src: original,
  width: 512,
  height: 512,
  renditions: [
    rendition("avatar-128", 128, 128),
    rendition("avatar-512", 512, 512),
  ],
};
const background: AuthorMedia = {
  id,
  src: original,
  width: 1600,
  height: 1200,
  renditions: [
    rendition("background-960", 960, 720),
    rendition("background-1600", 1600, 1200),
  ],
};
const legacy = { id, src: original, width: 1600, height: 1200 };

describe("profile image selection", () => {
  it("draws a small avatar from the smallest rendition", () => {
    expect(avatarThumbSrc(avatar)).toBe(`${original}/avatar-128`);
    // Whatever order a list arrives in.
    expect(
      avatarThumbSrc({
        ...avatar,
        renditions: [...avatar.renditions!].reverse(),
      }),
    ).toBe(`${original}/avatar-128`);
  });

  it("offers 128 at 1x and 512 from 2x for the header and registration avatars", () => {
    expect(avatarImage(avatar, 80)).toEqual({
      src: `${original}/avatar-128`,
      srcSet: `${original}/avatar-128 128w, ${original}/avatar-512 512w`,
      sizes: "80px",
    });
    expect(avatarImage(avatar, 96).sizes).toBe("96px");
  });

  it("needs no srcset when the larger avatar was skipped as identical", () => {
    const small: AuthorMedia = {
      id,
      src: original,
      width: 120,
      height: 120,
      renditions: [rendition("avatar-128", 120, 120)],
    };
    expect(avatarImage(small, 80)).toEqual({ src: `${original}/avatar-128` });
    expect(avatarThumbSrc(small)).toBe(`${original}/avatar-128`);
  });

  it("draws the cover from its largest rendition, else the only one", () => {
    expect(coverSrc(background)).toBe(`${original}/background-1600`);
    const skipped: AuthorMedia = {
      id,
      src: original,
      width: 900,
      height: 675,
      renditions: [rendition("background-960", 900, 675)],
    };
    expect(coverSrc(skipped)).toBe(`${original}/background-960`);
  });

  it("keeps the original src without renditions", () => {
    expect(avatarThumbSrc(legacy)).toBe(original);
    expect(avatarImage(legacy, 80)).toEqual({ src: original });
    expect(coverSrc(legacy)).toBe(original);
  });

  it("answers null for an absent image", () => {
    expect(avatarThumbSrc(null)).toBeNull();
    expect(avatarThumbSrc(undefined)).toBeNull();
    expect(coverSrc(null)).toBeNull();
    expect(coverSrc(undefined)).toBeNull();
  });

  it("uses published URLs as given", () => {
    const published: AuthorMedia = {
      ...legacy,
      renditions: [
        {
          src: "https://media.example.invalid/p/960.webp",
          width: 960,
          height: 720,
          contentType: "image/webp" as const,
        },
        {
          src: "https://media.example.invalid/p/1600.webp",
          width: 1600,
          height: 1200,
          contentType: "image/webp" as const,
        },
      ],
    };
    expect(coverSrc(published)).toBe(
      "https://media.example.invalid/p/1600.webp",
    );
  });
});
