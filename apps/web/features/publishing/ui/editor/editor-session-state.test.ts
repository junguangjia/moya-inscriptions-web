import { describe, expect, it } from "vitest";

import { derivationSignatures } from "../../edit-readiness";
import {
  contentOf,
  createEditorSessionStore,
  failureField,
  isEmptyWork,
  localIssues,
  mergeManagedItems,
  readinessOf,
  resolveSession,
  sameAuthorContent,
  preserveLaterConflictEdits,
} from "./editor-session-state";

import type {
  UploadItemView,
  UploadManagerSnapshot,
} from "../../upload-manager";
import type { WorkDraftItem } from "@moya/contracts";

const ACCOUNT = `user-${"a".repeat(32)}`;
const itemId = (n: number) => `media-item-${String(n).padStart(32, "0")}`;

const item = (key: string, id: string | null): WorkDraftItem =>
  id === null
    ? {
        key,
        itemId: null,
        kind: "static",
        qualityMode: "standard",
        edit: { rotation: 0, crop: null },
        pendingLabel: "photo",
      }
    : {
        key,
        itemId: id,
        kind: "static",
        qualityMode: "standard",
        edit: { rotation: 0, crop: null },
      };

const view = (key: string, phase: UploadItemView["phase"]): UploadItemView => ({
  key,
  kind: "static",
  qualityMode: "standard",
  notCameraOriginal: false,
  phase,
  itemId: null,
  components: [],
  failure: null,
  choice: null,
  recoverable: false,
  serverItem: null,
});

const snapshot = (items: UploadItemView[]): UploadManagerSnapshot => ({
  accountId: ACCOUNT,
  status: "active",
  pauseReason: null,
  items,
});

describe("editor session store", () => {
  it("starts a new work public, text-free and at the media step", () => {
    const store = createEditorSessionStore(ACCOUNT, { type: "new" });
    expect(store.get()).toMatchObject({
      phase: "ready",
      kind: "new",
      visibility: "public",
      step: "media",
      originalNext: false,
      editVersion: 0,
    });
    expect(isEmptyWork(store.get())).toBe(true);
  });

  it("counts author changes as edits and never step or identity changes", () => {
    const store = createEditorSessionStore(ACCOUNT, { type: "new" });
    store.setTitle("临兰亭");
    store.setStep("text");
    store.syncManagedItems([
      { key: "k1", itemId: null, kind: "static", qualityMode: "standard" },
    ]);
    expect(store.get().editVersion).toBe(1);
    expect(store.get().items.map((entry) => entry.key)).toEqual(["k1"]);
    store.moveItem("k1", 0);
    expect(store.get().editVersion).toBe(2);
  });

  it("claims no authorship until the author chooses one, and lets them clear it", () => {
    const store = createEditorSessionStore(ACCOUNT, { type: "new" });
    expect(store.get().authorshipKind).toBeNull();
    expect(contentOf(store.get()).authorship).toBeNull();
    store.setAuthorshipKind("copy_practice");
    store.setReference("referenceTitle", "兰亭序");
    expect(contentOf(store.get()).authorship).toEqual({
      kind: "copy_practice",
      referenceTitle: "兰亭序",
    });
    // Clearing is an author change and drops the reference from the content
    // while what was typed stays for a later choice.
    const before = store.get().editVersion;
    store.setAuthorshipKind(null);
    expect(store.get().editVersion).toBe(before + 1);
    expect(contentOf(store.get()).authorship).toBeNull();
    expect(localIssues(store.get())).toEqual([]);
    expect(store.get().reference.referenceTitle).toBe("兰亭序");
    store.setAuthorshipKind("material_sharing");
    expect(contentOf(store.get()).authorship).toEqual({
      kind: "material_sharing",
      referenceTitle: "兰亭序",
    });
  });

  it("adopts an undeclared authorship as undeclared and never as 原创", () => {
    const store = createEditorSessionStore(ACCOUNT, { type: "new" });
    store.setAuthorshipKind("original");
    const loaded = {
      ...contentOf(store.get()),
      authorship: null,
    };
    store.adoptContent(loaded);
    expect(store.get().authorshipKind).toBeNull();
    expect(contentOf(store.get()).authorship).toBeNull();
    // An undeclared work is not the same author input as an 原创 one.
    expect(
      sameAuthorContent(loaded, {
        ...loaded,
        authorship: { kind: "original" },
      }),
    ).toBe(false);
    expect(sameAuthorContent(loaded, { ...loaded })).toBe(true);
  });

  it("keeps reference fields while switching authorship and omits empty ones", () => {
    const store = createEditorSessionStore(ACCOUNT, { type: "new" });
    store.setAuthorshipKind("copy_practice");
    store.setReference("referenceTitle", "兰亭序");
    store.setReference("originalAuthor", "  ");
    expect(contentOf(store.get()).authorship).toEqual({
      kind: "copy_practice",
      referenceTitle: "兰亭序",
    });
    store.setAuthorshipKind("original");
    expect(contentOf(store.get()).authorship).toEqual({ kind: "original" });
    store.setAuthorshipKind("material_sharing");
    expect(contentOf(store.get()).authorship).toEqual({
      kind: "material_sharing",
      referenceTitle: "兰亭序",
    });
  });

  it("falls back from a removed cover and tells the author", () => {
    const store = createEditorSessionStore(ACCOUNT, { type: "new" });
    store.setMedia({
      items: [item("a", itemId(1)), item("b", itemId(2))],
      coverKey: "b",
      coverCrop: { x: 0, y: 0, width: 0.5, height: 0.5 },
    });
    store.removeItem("b");
    expect(store.get()).toMatchObject({
      coverKey: null,
      coverCrop: null,
      notice: "封面已移除，将以第一项作为封面",
    });
  });

  it("follows manager identities and appends new items in order", () => {
    const items = [item("a", null)];
    const merged = mergeManagedItems(items, [
      { key: "a", itemId: itemId(1), kind: "static", qualityMode: "standard" },
      {
        key: "b",
        itemId: null,
        kind: "live",
        qualityMode: "original",
        pendingLabel: "live",
      },
    ]);
    expect(merged).toEqual([
      item("a", itemId(1)),
      {
        key: "b",
        itemId: null,
        kind: "live",
        qualityMode: "original",
        pendingLabel: "live",
        edit: { rotation: 0, crop: null },
      },
    ]);
    expect(mergeManagedItems(merged, [])).toBe(merged);
  });

  it("keeps the clipboard provenance of a key from either side", () => {
    const pasted = { ...item("a", null), origin: "clipboard" as const };
    // The content says so (a restored draft); the manager's entry does not.
    const fromContent = mergeManagedItems(
      [pasted],
      [
        {
          key: "a",
          itemId: itemId(1),
          kind: "static",
          qualityMode: "standard",
        },
      ],
    );
    expect(fromContent).toEqual([
      { ...item("a", itemId(1)), origin: "clipboard" },
    ]);
    // The manager says so (pasted here); the content item does not yet.
    const fromManager = mergeManagedItems(
      [item("a", itemId(1))],
      [
        {
          key: "a",
          itemId: itemId(1),
          kind: "static",
          qualityMode: "standard",
          origin: "clipboard",
        },
        {
          key: "b",
          itemId: null,
          kind: "static",
          qualityMode: "standard",
          pendingLabel: "photo",
          origin: "clipboard",
        },
      ],
    );
    expect(fromManager.map((entry) => [entry.key, entry.origin])).toEqual([
      ["a", "clipboard"],
      ["b", "clipboard"],
    ]);
    expect(
      mergeManagedItems(fromManager, [
        {
          key: "a",
          itemId: itemId(1),
          kind: "static",
          qualityMode: "standard",
        },
      ]),
    ).toBe(fromManager);
  });

  it("reports exact readiness counts of retained items only", () => {
    const store = createEditorSessionStore(ACCOUNT, { type: "new" });
    store.setMedia({
      items: [
        item("a", null),
        item("b", null),
        item("c", null),
        item("d", itemId(4)),
      ],
      coverKey: null,
      coverCrop: null,
    });
    store.mergeServerItems([
      {
        id: itemId(4),
        kind: "static",
        qualityMode: "standard",
        state: "ready",
        failureCode: null,
        components: [],
        presentation: null,
        media: null,
      },
    ]);
    const readiness = readinessOf(
      store.get(),
      snapshot([
        view("a", "uploading"),
        view("b", "queued"),
        view("c", "failed"),
        view("gone", "cancelled"),
      ]),
    );
    // "d" is an existing account item the manager does not track, known ready.
    expect(readiness).toEqual({
      total: 4,
      ready: 1,
      blocking: 3,
      text: "2 项仍在上传，1 项失败",
      confirmed: false,
      unknownItemIds: [],
    });
  });

  it("counts a ready item as processing until the account confirms its edit derivatives (D1)", () => {
    const store = createEditorSessionStore(ACCOUNT, { type: "new" });
    store.setMedia({
      items: [item("a", itemId(1)), item("b", itemId(2)), item("c", itemId(3))],
      coverKey: "c",
      coverCrop: null,
    });
    store.setItemEdit("a", { rotation: 90, crop: null });
    const uploads = snapshot([
      view("a", "ready"),
      view("b", "ready"),
      view("c", "ready"),
    ]);
    // No answer yet: the turned item waits; the untouched ones are ready.
    expect(readinessOf(store.get(), uploads, null)).toMatchObject({
      ready: 2,
      blocking: 1,
      text: "1 项正在处理",
      confirmed: false,
    });
    const album = () => ({
      coverKey: store.get().coverKey,
      coverCrop: store.get().coverCrop,
    });
    const answered = (
      ready: boolean,
      pending: string[],
      failed: string[] = [],
    ) => ({
      status: ready ? ("ready" as const) : ("not_ready" as const),
      answered: {
        ready,
        pendingItemKeys: new Set(pending),
        failedItemKeys: new Set(failed),
        editKeys: { a: "f".repeat(32) },
        signatures: derivationSignatures({
          items: store.get().items,
          ...album(),
        }),
      },
    });
    expect(
      readinessOf(store.get(), uploads, answered(false, ["a"])),
    ).toMatchObject({
      ready: 2,
      blocking: 1,
      text: "1 项正在处理",
      confirmed: false,
    });
    expect(readinessOf(store.get(), uploads, answered(true, []))).toEqual({
      total: 3,
      ready: 3,
      blocking: 0,
      text: null,
      confirmed: true,
      unknownItemIds: [],
    });
    expect(
      readinessOf(store.get(), uploads, answered(false, [], ["a"])),
    ).toMatchObject({
      ready: 2,
      blocking: 1,
      text: "1 项失败",
      confirmed: false,
    });
    // A cover crop on the cover item is an edit of its own; an answer for the
    // earlier content does not cover it.
    const confirmedBefore = answered(true, []);
    store.setCoverCrop({ x: 0, y: 0, width: 0.5, height: 0.5 });
    expect(readinessOf(store.get(), uploads, confirmedBefore)).toMatchObject({
      ready: 2,
      blocking: 1,
      text: "1 项正在处理",
      confirmed: false,
    });
    // Everything ready locally while the account's last word is "not ready":
    // never 全部已就绪.
    store.setCoverCrop(null);
    expect(
      readinessOf(store.get(), uploads, {
        ...answered(false, []),
        answered: null,
      }),
    ).toMatchObject({ blocking: 1, confirmed: false });
  });

  it("never counts an account item of unknown state as ready", () => {
    const store = createEditorSessionStore(ACCOUNT, { type: "new" });
    store.setMedia({
      items: [item("a", itemId(1)), item("b", itemId(2))],
      coverKey: null,
      coverCrop: null,
    });
    store.mergeServerItems([
      {
        id: itemId(1),
        kind: "static",
        qualityMode: "standard",
        state: "ready",
        failureCode: null,
        components: [],
        presentation: null,
        media: null,
      },
    ]);
    expect(readinessOf(store.get(), null)).toEqual({
      total: 2,
      ready: 1,
      blocking: 1,
      text: "1 项正在确认状态",
      confirmed: false,
      unknownItemIds: [itemId(2)],
    });
  });

  it("compares author input without upload identities", () => {
    const base = contentOf(
      createEditorSessionStore(ACCOUNT, { type: "new" }).get(),
    );
    const pending = { ...base, items: [item("a", null)] };
    const registered = { ...base, items: [item("a", itemId(1))] };
    expect(sameAuthorContent(pending, registered)).toBe(true);
    expect(sameAuthorContent(pending, { ...registered, title: "新" })).toBe(
      false,
    );
    expect(
      sameAuthorContent(registered, {
        ...registered,
        items: [
          { ...item("a", itemId(1)), edit: { rotation: 90, crop: null } },
        ],
      }),
    ).toBe(false);
  });

  it("lists local text issues in reading order and maps Backend codes to fields", () => {
    const store = createEditorSessionStore(ACCOUNT, { type: "new" });
    store.setTitle("一\n二");
    store.setBody("字".repeat(10_001));
    expect(localIssues(store.get()).map((issue) => issue.message)).toEqual([
      "标题不能换行",
      "正文最多 10000 字",
    ]);
    expect(failureField("title_too_long")).toBe("title");
    expect(failureField("source_note_too_long")).toBe("sourceNote");
    expect(failureField("not_ready")).toBe("media");
    expect(failureField("daily_limit")).toBe("general");
  });

  it("answers the same draft or work, one new work, and nothing else", () => {
    const store = createEditorSessionStore(ACCOUNT, { type: "new" });
    const view = {
      target: { type: "new" } as const,
      threadId: null,
      saveMode: "saved" as const,
      draftId: `work-draft-${"d".repeat(32)}`,
      sessionId: null,
      workId: null,
      baseRevisionId: null,
      hasContent: true,
    };
    expect(resolveSession(store, { type: "new" }, view).kind).toBe("store");
    expect(
      resolveSession(store, { type: "draft", id: view.draftId }, view).kind,
    ).toBe("store");
    expect(
      resolveSession(
        store,
        { type: "work", id: `work-${"1".repeat(32)}` },
        view,
      ).kind,
    ).toBe("other");
    expect(resolveSession(null, { type: "new" }, null).kind).toBe("create");
    expect(resolveSession(null, { type: "new" }, view).kind).toBe("other");
  });
});

describe("conflict edits made after the recorded device version", () => {
  const base = contentOf(
    createEditorSessionStore(ACCOUNT, { type: "new" }).get(),
  );
  it("keeps later text and settings while taking untouched fields from the chosen version", () => {
    const device = { ...base, title: "设备", body: "原文" };
    const selected = { ...base, title: "账号", body: "账号正文" };
    expect(
      preserveLaterConflictEdits(selected, device, {
        ...device,
        title: "",
        visibility: "self",
      }),
    ).toEqual({ ...selected, title: "", visibility: "self" });
  });
  it("keeps a later album and its cover together without resurrecting removed items", () => {
    const device = {
      ...base,
      items: [item("old", itemId(1))],
      coverKey: "old",
    };
    const selected = {
      ...base,
      items: [item("account", itemId(2))],
      coverKey: "account",
    };
    const screen = {
      ...base,
      items: [item("new", itemId(3))],
      coverKey: "new",
    };
    expect(preserveLaterConflictEdits(selected, device, screen)).toEqual(
      screen,
    );
  });
  it("does not treat a completed upload as a later author edit", () => {
    const device = { ...base, items: [item("a", null)] };
    const selected = { ...base, title: "账号", items: [item("b", itemId(2))] };
    expect(
      preserveLaterConflictEdits(selected, device, {
        ...device,
        items: [item("a", itemId(1))],
      }),
    ).toEqual(selected);
  });
});
