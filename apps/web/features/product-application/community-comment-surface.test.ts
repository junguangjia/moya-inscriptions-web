import { describe, expect, it } from "vitest";

import {
  developmentSignInPath,
  resolveCommunityCommentSurface,
} from "./community-comment-surface";

describe("resolveCommunityCommentSurface", () => {
  it("composes comments with the Development sign-in path in the Development runtime", () => {
    expect(resolveCommunityCommentSurface("development")).toEqual({
      signInHref: developmentSignInPath,
    });
    expect(developmentSignInPath).toBe("/login");
  });

  it.each(["production", "test", undefined])(
    "composes no comment section and no sign-in link under %s",
    (nodeEnv) => {
      expect(resolveCommunityCommentSurface(nodeEnv)).toBeNull();
    },
  );

  it("reads NODE_ENV when no value is passed", () => {
    // vitest runs under NODE_ENV=test: nothing is composed by default.
    expect(resolveCommunityCommentSurface()).toBeNull();
  });
});
