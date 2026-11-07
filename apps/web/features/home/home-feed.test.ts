import { describe, expect, it } from "vitest";

import { homeFeeds, parseHomeFeed } from "./home-feed";

describe("Home feed identity", () => {
  it("accepts every bounded feed identity", () => {
    for (const feed of homeFeeds) expect(parseHomeFeed(feed)).toBe(feed);
  });

  it("opens the timeline from links shared before it replaced 附近", () => {
    expect(parseHomeFeed("nearby")).toBe("timeline");
  });

  it("keeps the timeline at index 1 of the four feeds", () => {
    expect(homeFeeds).toEqual([
      "discover",
      "timeline",
      "inscriptions",
      "calligraphy",
    ]);
  });

  it.each([undefined, null, "", "unknown", ["topics"]])(
    "falls back invalid input %o to Discover",
    (value) => {
      expect(parseHomeFeed(value)).toBe("discover");
    },
  );
});
