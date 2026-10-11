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
import type { Root } from "react-dom/client";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const item = (key: string, rotation: 0 | 90 = 0) => ({
  key,
  itemId: null,
  kind: "static" as const,
  qualityMode: "standard" as const,
  edit: { rotation, crop: null },
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
    expect(latest!.slides[0]).toEqual({
      key: "a",
      alt: "第 1 项",
      src: null,
      size: { width: 3000, height: 4000 },
      status: "loading",
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

  it("marks an item with neither a local file nor account media as unavailable", async () => {
    await render([item("gone")], undefined, () => null);
    expect(latest!.slides[0]!.status).toBe("unavailable");
    expect(latest!.stageRatio).toBe(1);
  });
});
