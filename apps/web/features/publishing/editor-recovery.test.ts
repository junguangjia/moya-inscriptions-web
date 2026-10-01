import { describe, expect, it, vi } from "vitest";
import { identifyFiles, addStaticPhotosToStaging } from "./import-grouping";
import { fileOf, jpeg } from "./parsers/synthetic-media.test-support";

import { RECOVERY_MAX_TOTAL_BYTES } from "./local-recovery";
import { EditorInterruptionRecovery, recoveryBytes } from "./editor-recovery";
import { contentOf, createEditorState } from "./ui/editor/editor-session-state";

import type { EditorRecoveryRecord } from "./editor-recovery";
import type { PublishingCheckpoint } from "./publishing-runtime";

const account = `user-${"a".repeat(32)}`;
const other = `user-${"b".repeat(32)}`;
const state = {
  ...createEditorState("session", account, { type: "new" }),
  title: "未保存的文字",
  body: "第二行\n🌿",
  editVersion: 1,
};
const checkpoint: PublishingCheckpoint = {
  view: {
    target: { type: "new" },
    threadId: null,
    saveMode: "saved",
    draftId: null,
    sessionId: null,
    workId: null,
    baseRevisionId: null,
    hasContent: true,
  },
  savedDraft: null,
  baseline: null,
  content: contentOf(state),
  uploads: [],
  staging: null,
  pendingFiles: [],
};

const storage = (): Storage => {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    key: (index) => [...values.keys()][index] ?? null,
  };
};
const setup = () => {
  const text = storage(),
    durable = storage();
  const disk = new Map<string, EditorRecoveryRecord>();
  const backend = {
    put: vi.fn(async (record: EditorRecoveryRecord) => {
      disk.set(record.id, record);
    }),
    get: vi.fn(async (id: string) => disk.get(id)),
    remove: vi.fn(async (id: string) => {
      disk.delete(id);
    }),
    bytes: async () => recoveryBytes([...disk.values()]),
  };
  const estimate = vi.fn(async () => ({ quota: 1024 ** 3, usage: 0 }));
  let identity = 0;
  const create = () =>
    new EditorInterruptionRecovery(
      backend,
      text,
      estimate,
      () => `local-edit-${++identity}`,
      durable,
    );
  return { create, disk, backend, text, durable, estimate };
};

describe("manual draft interruption recovery", () => {
  it("restores unsaved text locally after recreating the runtime and isolates another account", async () => {
    const test = setup();
    expect(await test.create().save(state, checkpoint)).toBe(true);
    const recovered = await test.create().load(account);
    expect(recovered?.state).toMatchObject({
      title: state.title,
      body: state.body,
    });
    expect(recovered?.runtime.savedDraft).toBeNull();
    expect(await test.create().load(other)).toBeNull();
  });

  it("recovers the last interrupted editor after the browser loses the tab session", async () => {
    const test = setup();
    await test.create().save(state, checkpoint);
    test.text.clear();
    expect((await test.create().load(account))?.state.body).toBe(state.body);
    const restored = test.create();
    await restored.load(account);
    await restored.save(state, checkpoint);
    expect(test.disk.size).toBe(1);
    restored.discard(account);
    expect(await restored.load(account)).toBeNull();
    expect(test.disk.size).toBe(0);
  });

  it("keeps the latest keystroke even when a blob write fails", async () => {
    const test = setup();
    const recovery = test.create();
    await recovery.save(state, checkpoint);
    test.backend.put.mockRejectedValueOnce(new Error("disk full"));
    expect(
      await recovery.save({ ...state, body: "更晚的输入" }, checkpoint),
    ).toBe(false);
    expect((await test.create().load(account))?.state.body).toBe("更晚的输入");
  });

  it("does not resurrect discarded edits when an earlier write completes late", async () => {
    const test = setup();
    let release!: () => void;
    const put = test.backend.put.getMockImplementation()!;
    test.backend.put.mockImplementationOnce(async (record) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await put(record);
    });
    const recovery = test.create();
    const saving = recovery.save(state, checkpoint);
    for (let turn = 0; turn < 10 && !release; turn++) await Promise.resolve();
    expect(release).toBeTypeOf("function");
    recovery.discard(account);
    release();
    await saving;
    expect(await recovery.load(account)).toBeNull();
    expect(test.disk.size).toBe(0);
  });

  it("removes an obsolete pending original even when the next optimized recovery write fails", async () => {
    const test = setup(),
      recovery = test.create();
    await recovery.save(state, {
      ...checkpoint,
      pendingFiles: [
        {
          id: "selected",
          files: [new File(["original-bytes"], "source.jpg")],
          origin: "picker",
          original: false,
        },
      ],
    });
    expect(test.disk.size).toBe(1);
    test.backend.put.mockRejectedValueOnce(new Error("quota"));
    expect(await recovery.save(state, checkpoint)).toBe(false);
    expect(test.disk.size).toBe(0);
    expect((await recovery.load(account))?.runtime.pendingFiles).toEqual([]);
  });

  it("removes an obsolete staged original if a following recovery write fails", async () => {
    const test = setup(),
      recovery = test.create();
    const staging = addStaticPhotosToStaging(
      null,
      await identifyFiles([fileOf(jpeg({}))]),
      "picker",
    );
    await recovery.save(state, { ...checkpoint, staging });
    expect(test.disk.size).toBe(1);
    test.backend.put.mockRejectedValueOnce(new Error("quota"));
    expect(await recovery.save(state, checkpoint)).toBe(false);
    expect(test.disk.size).toBe(0);
  });

  it("does not subtract an already removed record from the global byte cap", async () => {
    const test = setup(),
      recovery = test.create();
    const pending = (id: string, value: string) => ({
      ...checkpoint,
      pendingFiles: [
        {
          id,
          files: [new File([value], "source.jpg")],
          origin: "picker" as const,
          original: false,
        },
      ],
    });
    await recovery.save(state, pending("old", "old-original"));
    test.backend.bytes = async () => RECOVERY_MAX_TOTAL_BYTES;
    test.backend.put.mockClear();
    expect(await recovery.save(state, pending("new", "n"))).toBe(false);
    expect(test.backend.put).not.toHaveBeenCalled();
  });

  it("reports quota failure without claiming a complete file recovery", async () => {
    const test = setup();
    test.estimate.mockResolvedValue({ quota: 4, usage: 3 });
    const pending = {
      ...checkpoint,
      pendingFiles: [
        {
          id: "selection",
          files: [new File(["fixture"], "test.jpg")],
          origin: "picker" as const,
          original: false,
        },
      ],
    };
    expect(await test.create().save(state, pending)).toBe(false);
    expect(test.backend.put).not.toHaveBeenCalled();
    expect((await test.create().load(account))?.state.title).toBe(state.title);
  });
});
