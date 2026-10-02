// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createExternalStore } from "../../publishing/upload-manager-store";
import type {
  UploadItemView,
  UploadManagerSnapshot,
} from "../../publishing/upload-manager";
import type { IdentifiedFile } from "../../publishing/import-grouping";
const identify = vi.hoisted(() =>
  vi.fn<(files: File[]) => Promise<IdentifiedFile[]>>(),
);
vi.mock("../../publishing/import-grouping", async (original) => ({
  ...(await original<typeof import("../../publishing/import-grouping")>()),
  identifyFiles: identify,
}));
import { importArticleFiles } from "./article-file-import";
afterEach(() => vi.clearAllMocks());
const setup = () => {
  const files = [
    new File(["synthetic"], "one.png", { type: "image/png" }),
    new File(["synthetic"], "two.png", { type: "image/png" }),
  ];
  identify.mockResolvedValue(
    files.map((file) => ({
      kind: "still",
      file,
      type: "image/png",
      orientation: 1,
      contentIdentifier: null,
      appleMakerNote: false,
      motionPhoto: null,
      motionPhotoInvalid: false,
    })),
  );
  const store = createExternalStore<UploadManagerSnapshot>({
    accountId: "synthetic",
    status: "active",
    pauseReason: null,
    items: [],
  });
  const addConfirmed = vi.fn((entries) =>
    store.set({
      ...store.get(),
      items: entries.map(
        (entry: { key: string }) =>
          ({
            key: entry.key,
            phase: "uploading",
            serverItem: null,
          }) as UploadItemView,
      ),
    }),
  );
  const manager = { store, getSnapshot: store.get, addConfirmed };
  const recover = vi.fn(async () => []);
  const abort = new AbortController();
  let permitted = true;
  const run = (maxItems = 20) =>
    importArticleFiles({
      files,
      manager,
      maxItems,
      signal: abort.signal,
      allowed: () => permitted,
      recover,
    });
  const ready = () =>
    store.set({
      ...store.get(),
      items: store.get().items.map(
        (item, index) =>
          ({
            ...item,
            phase: "ready",
            serverItem: {
              id: `media-item-${String(index + 1).repeat(32)}`,
              state: "ready",
              media: { displaySrc: "/synthetic" },
            },
          }) as UploadItemView,
      ),
    });
  return {
    files,
    store,
    manager,
    recover,
    abort,
    run,
    ready,
    deny: () => {
      permitted = false;
    },
  };
};
describe("Article drop uses the existing managed uploader", () => {
  it("waits for server readiness and preserves file order and drop provenance", async () => {
    const value = setup();
    const result = value.run();
    await Promise.resolve();
    expect(
      value.manager.addConfirmed.mock.calls[0]![0].map(
        (entry: { clientSource: string }) => entry.clientSource,
      ),
    ).toEqual(["drop", "drop"]);
    value.ready();
    expect(await result).toEqual(
      [1, 2].map((index) => ({
        type: "managed",
        itemId: `media-item-${String(index).repeat(32)}`,
      })),
    );
    expect(value.recover).not.toHaveBeenCalled();
  });
  it("enforces existing item limits before identification or registration", async () => {
    const value = setup();
    await expect(value.run(1)).rejects.toThrow("最多上传 1");
    expect(identify).not.toHaveBeenCalled();
    expect(value.manager.addConfirmed).not.toHaveBeenCalled();
  });
  it("does not register a late identification result after account permission changes", async () => {
    const value = setup();
    const result = value.run();
    value.deny();
    expect(await result).toEqual([]);
    expect(value.manager.addConfirmed).not.toHaveBeenCalled();
  });
  it("aborts waiting without inserting partially uploaded refs", async () => {
    const value = setup();
    const result = value.run();
    await Promise.resolve();
    value.abort.abort();
    expect(await result).toEqual([]);
    expect(value.recover).not.toHaveBeenCalled();
  });
  it("routes failed transfers to existing retry/choice UI", async () => {
    const value = setup();
    const result = value.run();
    await Promise.resolve();
    value.store.set({
      ...value.store.get(),
      items: value.store
        .get()
        .items.map((item) => ({ ...item, phase: "failed" })),
    });
    expect(await result).toEqual([]);
    expect(value.recover).toHaveBeenCalledExactlyOnceWith(null);
  });
});
