// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { cache, frames } = vi.hoisted(() => ({
  cache: {
    acquired: [] as Blob[],
    released: [] as Blob[],
  },
  frames: {
    fail: false,
    drawn: [] as string[],
    released: [] as string[],
  },
}));

// C1b's bounded local copies and edited-frame drawing need a real canvas.
vi.mock("../media/bounded-preview", () => ({
  sharedPreviewCache: () => ({
    acquire: (blob: Blob) => {
      cache.acquired.push(blob);
      let released = false;
      return {
        result: Promise.resolve({
          url: `bounded:${cache.acquired.length}`,
          size: { width: 640, height: 480 },
        }),
        release: () => {
          if (released) return;
          released = true;
          cache.released.push(blob);
        },
      };
    },
  }),
}));
vi.mock("../media/edited-frame", () => ({
  renderEditedFrame: async (
    src: string,
    edit: { rotation: number },
  ): Promise<unknown> => {
    frames.drawn.push(src);
    if (frames.fail) throw new Error("decode failed");
    const url = `edited:${src}:${edit.rotation}`;
    return {
      url,
      size: { width: 480, height: 640 },
      release: () => frames.released.push(url),
    };
  },
}));

import { createEditorSessionStore } from "./editor-session-state";
import { useEditorMediaSources } from "./preview";

import type {
  EditorSessionState,
  EditorSessionStore,
} from "./editor-session-state";
import type { EditorMediaScope, EditorMediaSources } from "./preview";
import type { PublishingMediaItem, WorkDraftItem } from "@moya/contracts";
import type { Root } from "react-dom/client";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ACCOUNT = `user-${"a".repeat(32)}`;
const ITEM_ID = `media-item-${"1".repeat(32)}`;

const serverItem: PublishingMediaItem = {
  id: ITEM_ID,
  kind: "live",
  qualityMode: "standard",
  state: "ready",
  failureCode: null,
  components: [],
  presentation: { width: 1200, height: 900, hasAudio: true },
  media: {
    thumbSrc: "/media/thumb",
    displaySrc: "/media/display",
    motionSrc: "/media/motion",
  },
};

const accountItem = (rotation: 0 | 90): WorkDraftItem => ({
  key: "account",
  itemId: ITEM_ID,
  kind: "live",
  qualityMode: "standard",
  edit: { rotation, crop: null },
});

const localItem = (key: string): WorkDraftItem => ({
  key,
  itemId: null,
  kind: "static",
  qualityMode: "standard",
  pendingLabel: "photo",
  edit: { rotation: 0, crop: null },
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const seen: { current: EditorMediaSources | null } = { current: null };

const Probe = ({
  state,
  scope,
  blobs,
}: {
  readonly state: EditorSessionState;
  readonly scope: EditorMediaScope;
  readonly blobs: ReadonlyMap<string, Blob>;
}) => {
  seen.current = useEditorMediaSources(
    state,
    null,
    (key) => blobs.get(key) ?? null,
    scope,
  );
  return null;
};

const draw = async (
  store: EditorSessionStore,
  scope: EditorMediaScope,
  blobs: ReadonlyMap<string, Blob> = new Map(),
) => {
  await act(async () => {
    root!.render(<Probe blobs={blobs} scope={scope} state={store.get()} />);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  cache.acquired = [];
  cache.released = [];
  frames.fail = false;
  frames.drawn = [];
  frames.released = [];
  seen.current = null;
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("editor preview media", () => {
  it("decodes and draws nothing while no preview or cover is shown", async () => {
    const store = createEditorSessionStore(ACCOUNT, { type: "new" });
    store.setMedia({
      items: [localItem("a"), accountItem(90)],
      coverKey: null,
      coverCrop: null,
    });
    store.mergeServerItems([serverItem]);
    await draw(store, "none", new Map([["a", new Blob(["a"])]]));
    expect(seen.current?.sources).toEqual([]);
    expect(cache.acquired).toEqual([]);
    expect(frames.drawn).toEqual([]);
  });

  it("shows an account item in its edited frame and without unedited motion", async () => {
    const store = createEditorSessionStore(ACCOUNT, { type: "new" });
    store.setMedia({
      items: [accountItem(90)],
      coverKey: null,
      coverCrop: null,
    });
    store.mergeServerItems([serverItem]);
    await draw(store, "all");
    expect(frames.drawn).toEqual(["/media/display"]);
    expect(seen.current).toEqual({
      sources: [
        {
          key: "account",
          src: "edited:/media/display:90",
          width: 480,
          height: 640,
        },
      ],
      unedited: 0,
    });

    // Back to the full frame: the drawn copy is released, motion returns.
    store.setItemEdit("account", { rotation: 0, crop: null });
    await draw(store, "all");
    expect(frames.released).toEqual(["edited:/media/display:90"]);
    expect(seen.current?.sources).toEqual([
      {
        key: "account",
        src: "/media/display",
        width: 1200,
        height: 900,
        live: { motionSrc: "/media/motion", hasAudio: true },
      },
    ]);
  });

  it("never redraws for a feed framing, which leaves the pixels alone (#341)", async () => {
    const store = createEditorSessionStore(ACCOUNT, { type: "new" });
    store.setMedia({
      items: [accountItem(90)],
      coverKey: null,
      coverCrop: null,
    });
    store.mergeServerItems([serverItem]);
    await draw(store, "all");
    expect(frames.drawn).toEqual(["/media/display"]);
    const shown = seen.current?.sources;

    store.setItemEdit("account", {
      rotation: 90,
      crop: null,
      feed: { fit: "cover", y: 0 },
    });
    await draw(store, "all");
    expect(frames.drawn).toEqual(["/media/display"]);
    expect(frames.released).toEqual([]);
    expect(seen.current?.sources).toEqual(shown);

    // An unturned, uncropped item stays the account's picture, motion too.
    store.setItemEdit("account", {
      rotation: 0,
      crop: null,
      feed: { fit: "contain" },
    });
    await draw(store, "all");
    expect(frames.drawn).toEqual(["/media/display"]);
    expect(seen.current?.sources[0]).toMatchObject({
      src: "/media/display",
      live: { motionSrc: "/media/motion", hasAudio: true },
    });
  });

  it("counts an edit that cannot be drawn and shows the unedited picture", async () => {
    frames.fail = true;
    const store = createEditorSessionStore(ACCOUNT, { type: "new" });
    store.setMedia({
      items: [accountItem(90)],
      coverKey: null,
      coverCrop: null,
    });
    store.mergeServerItems([serverItem]);
    await draw(store, "all");
    expect(seen.current?.unedited).toBe(1);
    expect(seen.current?.sources[0]?.src).toBe("/media/display");
  });

  it("uses bounded local copies of the cover only, released when no longer shown", async () => {
    const store = createEditorSessionStore(ACCOUNT, { type: "new" });
    store.setMedia({
      items: [localItem("a"), localItem("b")],
      coverKey: "b",
      coverCrop: null,
    });
    const blobs = new Map([
      ["a", new Blob(["a"])],
      ["b", new Blob(["b"])],
    ]);
    await draw(store, "cover", blobs);
    expect(cache.acquired).toEqual([blobs.get("b")]);
    expect(seen.current?.sources).toEqual([
      { key: "b", src: "bounded:1", width: 640, height: 480 },
    ]);
    const shown = seen.current;
    // Typing elsewhere does not produce a new media value.
    store.setTitle("标题");
    await draw(store, "cover", blobs);
    expect(seen.current).toBe(shown);

    await draw(store, "none", blobs);
    expect(cache.released).toEqual([blobs.get("b")]);
  });
});
