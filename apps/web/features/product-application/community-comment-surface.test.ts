import { describe, expect, it } from "vitest";

import {
  developmentSignInPath,
  resolveCommunityCommentSurface,
} from "./community-comment-surface";

describe("resolveCommunityCommentSurface", () => {
  it.each(["development", "production"])(
    "composes the real comments and sign-in entry in %s",
    (environment) => {
      expect(resolveCommunityCommentSurface(environment)).toEqual({
        signInHref: developmentSignInPath,
      });
      expect(developmentSignInPath).toBe("/login");
    },
  );

  it.each(["test", undefined])(
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
