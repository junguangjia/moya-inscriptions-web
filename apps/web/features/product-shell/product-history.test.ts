import { describe, expect, it } from "vitest";

import {
  PRODUCT_SHELL_HISTORY_VERSION,
  detailHistoryState,
  detailLocation,
  directCatalogIdFromLocation,
  directEditorTargetFromLocation,
  directMediaIdFromLocation,
  editorHistoryState,
  editorLocation,
  feedViewerHistoryState,
  isPrimaryDestination,
  mergeProductHistoryState,
  parseProductHistoryState,
  primaryHistoryState,
  primaryLocation,
  sameEditorLink,
  settingsHistoryState,
  topicHistoryState,
  topicLocation,
  viewerHistoryState,
  viewerLocation,
} from "./product-history";

describe("Product Shell history", () => {
  it.each(["home", "discussion", "user"] as const)(
    "accepts the bounded %s primary destination",
    (destination) => {
      expect(isPrimaryDestination(destination)).toBe(true);
      expect(
        parseProductHistoryState(primaryHistoryState(destination)),
      ).toEqual(primaryHistoryState(destination));
    },
  );

  it.each(["inscriptions", "calligraphy"])(
    "rejects the retired %s primary destination",
    (destination) => {
      expect(isPrimaryDestination(destination)).toBe(false);
      expect(
        parseProductHistoryState({
          destination,
          kind: "primary",
          version: PRODUCT_SHELL_HISTORY_VERSION,
        }),
      ).toBeNull();
    },
  );

  it("parses the explicit Settings layer", () => {
    expect(
      parseProductHistoryState(settingsHistoryState("discussion")),
    ).toEqual(settingsHistoryState("discussion"));
  });

  it("parses the bounded Detail layer and preserves source/detail scroll", () => {
    const state = detailHistoryState("catalog-one", "discussion", 147, 63);
    expect(parseProductHistoryState(state)).toEqual(state);
    expect(detailHistoryState("catalog-one", "home", -1, -2)).toMatchObject({
      detailScrollTop: 0,
      sourceScrollTop: 0,
    });
    expect(
      detailLocation(
        {
          pathname: "/dev/t02p",
          search: "?cb=exact-head&catalogId=old",
        } as Location,
        "catalog one",
      ),
    ).toBe("/dev/t02p?cb=exact-head&catalogId=catalog+one#detail");
  });

  it("parses the feed viewer layer and reuses the viewer link", () => {
    const work = { type: "work", id: `work-${"a".repeat(32)}` } as const;
    const state = feedViewerHistoryState(work, "media-2", "user", 312);
    expect(state).toEqual({
      kind: "feed-viewer",
      version: PRODUCT_SHELL_HISTORY_VERSION,
      target: work,
      mediaId: "media-2",
      sourceDestination: "user",
      sourceScrollTop: 312,
    });
    expect(parseProductHistoryState(state)).toEqual(state);
    expect(
      parseProductHistoryState(mergeProductHistoryState({ __NA: true }, state)),
    ).toEqual(state);
    expect(
      feedViewerHistoryState(work, "media-2", "home", -4).sourceScrollTop,
    ).toBe(0);
    expect(
      viewerLocation(
        { pathname: "/", search: "?catalogId=old" } as Location,
        work,
        state.mediaId,
      ),
    ).toBe(`/?workId=${work.id}&image=media-2#viewer`);
  });

  it.each([
    ["an empty media id", { mediaId: "" }],
    ["a media id with whitespace", { mediaId: "media 2" }],
    ["an oversized media id", { mediaId: "m".repeat(129) }],
    ["a missing media id", { mediaId: undefined }],
    ["a negative source scroll", { sourceScrollTop: -1 }],
    ["a non-finite source scroll", { sourceScrollTop: Infinity }],
    ["an unknown source destination", { sourceDestination: "inscriptions" }],
    ["an invalid work target", { target: { type: "work", id: "work-1" } }],
    ["a retired version", { version: 1 }],
  ])("rejects a feed viewer state with %s", (_label, override) => {
    expect(
      parseProductHistoryState({
        ...feedViewerHistoryState(
          { type: "catalog", id: "catalog-one" },
          "media-1",
          "home",
          10,
        ),
        ...override,
      }),
    ).toBeNull();
  });

  it("reads only a bounded direct Development CatalogId", () => {
    expect(
      directCatalogIdFromLocation({ search: "?catalogId=catalog-one" }),
    ).toBe("catalog-one");
    expect(
      directCatalogIdFromLocation({ search: "?catalogId=invalid+id" }),
    ).toBeNull();
    expect(directCatalogIdFromLocation({ search: "" })).toBeNull();
  });

  it("parses the Viewer layer and keeps media navigation on one URL layer", () => {
    const state = viewerHistoryState(
      "catalog-one",
      "media-two",
      "discussion",
      147,
      63,
    );
    expect(parseProductHistoryState(state)).toEqual(state);
    expect(
      viewerLocation(
        {
          pathname: "/dev/t02p",
          search: "?cb=exact-head&catalogId=old&image=old-media",
        } as Location,
        "catalog-one",
        "media-two",
      ),
    ).toBe(
      "/dev/t02p?cb=exact-head&catalogId=catalog-one&image=media-two#viewer",
    );
    expect(
      detailLocation(
        {
          pathname: "/dev/t02p",
          search: "?catalogId=catalog-one&image=media-two",
        } as Location,
        "catalog-one",
      ),
    ).toBe("/dev/t02p?catalogId=catalog-one#detail");
    expect(directMediaIdFromLocation({ search: "?image=media-two" })).toBe(
      "media-two",
    );
    expect(
      directMediaIdFromLocation({ search: "?image=invalid+media" }),
    ).toBeNull();
  });

  it("preserves router history fields without retaining stale Product fields", () => {
    const merged = mergeProductHistoryState(
      {
        __NA: true,
        __PRIVATE_NEXTJS_INTERNALS_TREE: ["existing"],
        destination: "discussion",
        kind: "primary",
        scrollTop: 44,
        version: PRODUCT_SHELL_HISTORY_VERSION,
      },
      topicHistoryState("topic-one", 147),
    );
    expect(merged).toMatchObject({
      __NA: true,
      __PRIVATE_NEXTJS_INTERNALS_TREE: ["existing"],
      ...topicHistoryState("topic-one", 147),
    });
    expect(merged).not.toHaveProperty("destination");
    expect(merged).not.toHaveProperty("scrollTop");
    expect(parseProductHistoryState(merged)).toEqual(
      topicHistoryState("topic-one", 147),
    );
  });

  it("preserves a bounded primary scroll checkpoint for an overlay source entry", () => {
    expect(
      parseProductHistoryState(
        primaryHistoryState("discussion", 147, "topic-one"),
      ),
    ).toEqual(primaryHistoryState("discussion", 147, "topic-one"));
    expect(primaryHistoryState("home", -10).scrollTop).toBe(0);
  });

  it("parses the bounded Topic layer and clamps its source scroll", () => {
    expect(
      parseProductHistoryState(topicHistoryState("topic-one", 147)),
    ).toEqual(topicHistoryState("topic-one", 147));
    expect(topicHistoryState("topic-one", -10)).toMatchObject({
      sourceDestination: "discussion",
      sourceHomeFeed: "topics",
      sourceScrollTop: 0,
    });
    expect(
      topicLocation(
        { pathname: "/dev/t02p", search: "?cb=exact-head" } as Location,
        "专题 一",
      ),
    ).toBe("/dev/t02p?cb=exact-head#topic-%E4%B8%93%E9%A2%98%20%E4%B8%80");
  });

  it("parses the bounded Editor layer, its URL and exact direct links", () => {
    const draftId = `work-draft-${"c".repeat(32)}`;
    const workId = `work-${"b".repeat(32)}`;
    for (const target of [
      { type: "new" },
      { type: "draft", id: draftId },
      { type: "work", id: workId },
    ] as const) {
      const state = editorHistoryState(target, "user", 147);
      expect(parseProductHistoryState(state)).toEqual(state);
    }
    expect(
      editorHistoryState({ type: "new" }, "home", -10).sourceScrollTop,
    ).toBe(0);
    const location = {
      origin: "https://example.test",
      pathname: "/dev/t02p",
      search: `?feed=nearby&workId=${workId}&authorId=user-a&image=m`,
    } as Location;
    expect(editorLocation(location, { type: "new" })).toBe(
      "/dev/t02p?feed=nearby#editor",
    );
    // A private draft is never addressable by link.
    expect(editorLocation(location, { type: "draft", id: draftId })).toBe(
      "/dev/t02p?feed=nearby#editor",
    );
    expect(editorLocation(location, { type: "work", id: workId })).toBe(
      `/dev/t02p?feed=nearby&workId=${workId}#editor`,
    );
    const stale = {
      origin: "https://example.test",
      pathname: "/dev/t02p",
      search: `?feed=nearby&draftId=${draftId}`,
    } as Location;
    expect(primaryLocation(stale)).toBe("/dev/t02p?feed=nearby");
    expect(editorLocation(stale, { type: "draft", id: draftId })).toBe(
      "/dev/t02p?feed=nearby#editor",
    );
    expect(detailLocation(stale, { type: "work", id: workId })).toBe(
      `/dev/t02p?feed=nearby&workId=${workId}#detail`,
    );
    expect(
      sameEditorLink({ type: "new" }, { type: "draft", id: draftId }),
    ).toBe(true);
    expect(
      sameEditorLink(
        { type: "work", id: workId },
        { type: "work", id: workId },
      ),
    ).toBe(true);
    expect(sameEditorLink({ type: "new" }, { type: "work", id: workId })).toBe(
      false,
    );
    expect(
      directEditorTargetFromLocation({ hash: "#editor", search: "?feed=x" }),
    ).toEqual({ type: "new" });
    expect(
      directEditorTargetFromLocation({
        hash: "#editor",
        search: `?workId=${workId}`,
      }),
    ).toEqual({ type: "work", id: workId });
    for (const [hash, search] of [
      ["#detail", `?workId=${workId}`],
      ["#editor", `?draftId=${draftId}`],
      ["#editor", "?draftId=work-draft-short"],
      ["#editor", `?draftId=${draftId}&workId=${workId}`],
      ["#editor", `?workId=${workId}&workId=${workId}`],
      ["#editor", "?workId=work-short"],
      ["#editor", `?catalogId=catalog-one`],
      ["#editor", `?workId=${workId}&image=media-one`],
    ] as const)
      expect(directEditorTargetFromLocation({ hash, search })).toBeNull();
  });

  it.each([
    null,
    {},
    { kind: "primary", version: PRODUCT_SHELL_HISTORY_VERSION },
    {
      editorTarget: { type: "draft", id: "work-draft-invalid" },
      kind: "editor",
      sourceDestination: "home",
      sourceScrollTop: 0,
      version: PRODUCT_SHELL_HISTORY_VERSION,
    },
    {
      editorTarget: { type: "new" },
      kind: "editor",
      sourceDestination: "home",
      sourceScrollTop: -1,
      version: PRODUCT_SHELL_HISTORY_VERSION,
    },
    {
      editorTarget: { type: "catalog", id: "catalog-one" },
      kind: "editor",
      sourceDestination: "home",
      sourceScrollTop: 0,
      version: PRODUCT_SHELL_HISTORY_VERSION,
    },
    {
      destination: "unknown",
      kind: "primary",
      version: PRODUCT_SHELL_HISTORY_VERSION,
    },
    {
      destination: "home",
      focusTopicId: "",
      kind: "primary",
      version: PRODUCT_SHELL_HISTORY_VERSION,
    },
    {
      destination: "user",
      focusTopicId: "topic-one",
      kind: "primary",
      version: PRODUCT_SHELL_HISTORY_VERSION,
    },
    {
      destination: "home",
      kind: "primary",
      scrollTop: -1,
      version: PRODUCT_SHELL_HISTORY_VERSION,
    },
    {
      catalogId: "catalog-one",
      detailScrollTop: -1,
      kind: "detail",
      sourceDestination: "home",
      sourceScrollTop: 0,
      version: PRODUCT_SHELL_HISTORY_VERSION,
    },
    {
      catalogId: "",
      detailScrollTop: 0,
      kind: "detail",
      sourceDestination: "home",
      sourceScrollTop: 0,
      version: PRODUCT_SHELL_HISTORY_VERSION,
    },
    {
      catalogId: "catalog-one",
      detailScrollTop: 0,
      kind: "viewer",
      mediaId: "",
      sourceDestination: "home",
      sourceScrollTop: 0,
      version: PRODUCT_SHELL_HISTORY_VERSION,
    },
    {
      catalogId: "catalog-one",
      detailScrollTop: -1,
      kind: "viewer",
      mediaId: "media-one",
      sourceDestination: "home",
      sourceScrollTop: 0,
      version: PRODUCT_SHELL_HISTORY_VERSION,
    },
    {
      kind: "settings",
      sourceDestination: "viewer",
      version: PRODUCT_SHELL_HISTORY_VERSION,
    },
    {
      kind: "topic",
      sourceDestination: "discussion",
      sourceHomeFeed: "topics",
      sourceScrollTop: -1,
      topicId: "topic-invalid-scroll",
      version: PRODUCT_SHELL_HISTORY_VERSION,
    },
    {
      kind: "topic",
      sourceDestination: "discussion",
      sourceHomeFeed: "topics",
      sourceScrollTop: 0,
      topicId: "",
      version: PRODUCT_SHELL_HISTORY_VERSION,
    },
    { destination: "home", kind: "primary", version: 999 },
  ])("rejects invalid or future state %#", (value) => {
    expect(parseProductHistoryState(value)).toBeNull();
  });
});
