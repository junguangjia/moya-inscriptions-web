// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const sources = vi.hoisted(() => ({
  value: {
    sources: [] as {
      key: string;
      src: string;
      width: number;
      height: number;
      pending?: true;
    }[],
    unedited: 0,
  },
  scopes: [] as unknown[],
}));
vi.mock("../editor/preview", () => ({
  useEditorMediaSources: (
    _state: unknown,
    _uploads: unknown,
    _local: unknown,
    scope: unknown,
  ) => {
    sources.scopes.push(scope);
    return sources.value;
  },
}));

import { CARD_GALLERY_MAXIMUM } from "../../../authors/author-data";
import { FEED_GALLERY_MAXIMUM, useFeedStageSlides } from "./feed-stage-slides";

import type { FeedStageModel } from "./feed-stage-slides";
import type { EditorSessionState } from "../editor/editor-session-state";
import type { EditorMediaScope } from "../editor/preview";
import type { MediaCrop, MediaFeedFraming } from "@moya/contracts";
import type { Root } from "react-dom/client";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const item = (
  key: string,
  rotation: 0 | 90 = 0,
  feed?: MediaFeedFraming,
  crop: MediaCrop | null = null,
) => ({
  key,
  itemId: null,
  kind: "static" as const,
  qualityMode: "standard" as const,
  edit: { rotation, crop, ...(feed === undefined ? {} : { feed }) },
  pendingLabel: "photo" as const,
});

let root: Root | null = null;
let latest: FeedStageModel | null = null;
const Probe = ({
  state,
  scope,
  localStill,
}: {
  state: EditorSessionState;
  scope: EditorMediaScope;
  localStill: (key: string) => Blob | null;
}) => {
  latest = useFeedStageSlides(state, null, localStill, scope);
  return null;
};
const render = async (
  items: ReturnType<typeof item>[],
  scope: EditorMediaScope = { first: FEED_GALLERY_MAXIMUM },
  localStill: (key: string) => Blob | null = () => new Blob(["x"]),
) => {
  const state = {
    items,
    coverKey: null,
    coverCrop: null,
    serverItems: {},
  } as unknown as EditorSessionState;
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () =>
    root!.render(<Probe localStill={localStill} scope={scope} state={state} />),
  );
};

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  latest = null;
  sources.value = { sources: [], unedited: 0 };
  sources.scopes = [];
  document.body.replaceChildren();
});

describe("useFeedStageSlides", () => {
  it("caps the stage at the contract's gallery maximum and asks only for those pictures", async () => {
    expect(FEED_GALLERY_MAXIMUM).toBe(CARD_GALLERY_MAXIMUM);
    const items = Array.from({ length: 12 }, (_, index) => item(`k${index}`));
    await render(items);
    expect(latest!.slides).toHaveLength(10);
    expect(latest!.total).toBe(12);
    expect(sources.scopes.at(-1)).toEqual({ first: 10 });
    await render(items, "none");
    expect(sources.scopes.at(-1)).toBe("none");
  });

  it("decodes only the caller's scope and keeps the rest as placeholders", async () => {
    sources.value = {
      sources: [{ key: "k0", src: "blob:k0", width: 3000, height: 4000 }],
      unedited: 0,
    };
    const items = Array.from({ length: 3 }, (_, index) => item(`k${index}`));
    await render(items, { first: 1 });
    expect(sources.scopes.at(-1)).toEqual({ first: 1 });
    expect(latest!.slides.map((slide) => slide.status)).toEqual([
      "ready",
      "loading",
      "loading",
    ]);
    expect(latest!.stageRatio).toBe(1.25);
  });

  it("keeps the edited shape as a placeholder while the frame is drawn, then shows the picture", async () => {
    sources.value = {
      sources: [
        { key: "a", src: "blob:a", width: 4000, height: 3000, pending: true },
      ],
      unedited: 0,
    };
    await render([item("a", 90), item("b")]);
    // Uncropped and taller than a square, it is framed whole (#341 r3).
    expect(latest!.slides[0]).toEqual({
      key: "a",
      alt: "第 1 项",
      src: null,
      size: { width: 3000, height: 4000 },
      status: "loading",
      feed: { fit: "contain" },
    });
    // A turned 4:3 is 3:4: the stage is already 4:5 before the picture lands.
    expect(latest!.stageRatio).toBe(1.25);
    expect(latest!.slides[1]).toMatchObject({
      key: "b",
      src: null,
      size: null,
      status: "loading",
    });
    sources.value = {
      sources: [{ key: "a", src: "blob:a-edited", width: 3000, height: 4000 }],
      unedited: 0,
    };
    await render([item("a", 90), item("b")]);
    expect(latest!.slides[0]).toMatchObject({
      src: "blob:a-edited",
      size: { width: 3000, height: 4000 },
      status: "ready",
    });
  });

  // #341: 发布 and the desktop preview frame a taller picture as the feed will.
  it("carries each item's feed framing onto its slide in every state", async () => {
    sources.value = {
      sources: [
        { key: "ready", src: "blob:ready", width: 1000, height: 3000 },
        {
          key: "drawn",
          src: "blob:drawn",
          width: 1000,
          height: 3000,
          pending: true,
        },
      ],
      unedited: 0,
    };
    await render([
      item("ready", 0, { fit: "cover", y: 0 }),
      item("drawn", 0, { fit: "contain" }),
      item("waiting", 0, { fit: "cover", y: 0.8 }),
      item("plain"),
    ]);
    expect(latest!.slides.map((slide) => [slide.status, slide.feed])).toEqual([
      ["ready", { fit: "cover", y: 0 }],
      ["loading", { fit: "contain" }],
      ["loading", { fit: "cover", y: 0.8 }],
      ["loading", undefined],
    ]);
    expect(latest!.slides[3]).not.toHaveProperty("feed");
  });

  // #341 r3: the slides read as the server reads the work out.
  it("frames an uncropped taller picture whole by default, a cropped one centred", async () => {
    const cut = { x: 0, y: 0.25, width: 1, height: 0.5 };
    sources.value = {
      sources: [
        { key: "tall", src: "blob:tall", width: 1000, height: 3000 },
        { key: "square", src: "blob:square", width: 1000, height: 1000 },
        { key: "wide", src: "blob:wide", width: 3000, height: 1000 },
        { key: "centred", src: "blob:centred", width: 1000, height: 3000 },
        { key: "cut", src: "blob:cut", width: 1000, height: 3000 },
        { key: "cutWhole", src: "blob:cut-whole", width: 1000, height: 3000 },
      ],
      unedited: 0,
    };
    await render([
      item("tall"),
      item("square"),
      item("wide"),
      item("centred", 0, { fit: "cover", y: 0.5 }),
      item("cut", 0, undefined, cut),
      item("cutWhole", 0, { fit: "contain" }, cut),
    ]);
    expect(latest!.slides.map((slide) => [slide.key, slide.feed])).toEqual([
      ["tall", { fit: "contain" }],
      // Whole changes nothing for a frame no taller than a square.
      ["square", undefined],
      ["wide", undefined],
      // An explicit 局部 at the centre reads as the centred cover.
      ["centred", undefined],
      ["cut", undefined],
      ["cutWhole", { fit: "contain" }],
    ]);
    for (const index of [1, 2, 3, 4])
      expect(latest!.slides[index]).not.toHaveProperty("feed");
  });

  it("marks an item with neither a local file nor account media as unavailable", async () => {
    await render([item("gone")], undefined, () => null);
    expect(latest!.slides[0]!.status).toBe("unavailable");
    expect(latest!.stageRatio).toBe(1);
  });
});
