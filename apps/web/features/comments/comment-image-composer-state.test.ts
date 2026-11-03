import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublishingMediaItem } from "@moya/contracts";
import type {
  UploadItemView,
  UploadManagerSnapshot,
} from "../publishing/upload-manager";

const h = vi.hoisted(() => ({
  account: "user-00000000000000000000000000000001",
  epoch: 0,
  serial: 0,
  requests: 0,
  sessions: [] as MockSession[],
  pendingAdd: null as Promise<void> | null,
  pendingRemove: null as Promise<void> | null,
  rejectAdd: false,
  rejectCreate: false,
  rejectCleanup: false,
}));
vi.mock("../authors/author-data", () => ({
  authorClient: { account: () => h.account, accountEpoch: () => h.epoch },
}));
vi.mock("../shell/request-identity", () => ({
  requestIdentity: () =>
    `00000000-0000-4000-8000-${String(++h.requests).padStart(12, "0")}`,
}));
vi.mock("./comment-image-upload-session", () => ({
  CommentImageError: class extends Error {},
  createCommentUploadSession: (owner: string) => {
    if (h.rejectCreate) throw new Error("synthetic worker unavailable");
    const session = new MockSession(owner);
    h.sessions.push(session);
    return session;
  },
}));

const ready = (serial: number): PublishingMediaItem => ({
  id: `media-item-${serial.toString(16).padStart(32, "0")}`,
  kind: "static",
  qualityMode: "standard",
  state: "ready",
  failureCode: null,
  components: [],
  presentation: { width: 200, height: 100 },
  media: {
    thumbSrc: "/api/community/synthetic/thumb",
    displaySrc: "/api/community/synthetic/display",
    fullSrc: "/api/community/synthetic/full",
  },
});
class MockSession {
  listeners = new Set<() => void>();
  state: UploadManagerSnapshot;
  constructor(readonly owner: string) {
    this.state = {
      accountId: owner,
      status: "active",
      pauseReason: null,
      items: [],
    };
  }
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  snapshot = () => this.state;
  emit = () => {
    for (const fn of this.listeners) fn();
  };
  localStill = () => null;
  add = vi.fn(async (files: readonly File[]) => {
    const waiting = h.pendingAdd;
    h.pendingAdd = null;
    if (waiting !== null) await waiting;
    if (h.rejectAdd)
      throw new Error(
        "synthetic transport detail must not appear in product text",
      );
    const added: UploadItemView[] = files.map(() => {
      const serial = ++h.serial,
        item = ready(serial);
      return {
        key: `image-${serial}`,
        itemId: item.id,
        kind: "static",
        qualityMode: "standard",
        notCameraOriginal: false,
        phase: "ready",
        components: [],
        failure: null,
        choice: null,
        recoverable: false,
        serverItem: item,
      };
    });
    this.state = { ...this.state, items: [...this.state.items, ...added] };
    this.emit();
    return added.map(({ key }) => key);
  });
  remove = vi.fn(async (key: string) => {
    const waiting = h.pendingRemove;
    h.pendingRemove = null;
    if (waiting !== null) await waiting;
    this.state = {
      ...this.state,
      items: this.state.items.filter((item) => item.key !== key),
    };
    this.emit();
  });
  retry = vi.fn(async () => {});
  useOriginal = vi.fn();
  resumeConnection = vi.fn(async () => {
    this.state = { ...this.state, status: "active", pauseReason: null };
    this.emit();
  });
  abandon = vi.fn(async () => {});
  committed = vi.fn(async (_used: ReadonlySet<string>) => {
    void _used;
    if (h.rejectCleanup) throw new Error("synthetic retirement unavailable");
  });
}

import { createCommentImageComposerState } from "./comment-image-composer-state";
import type { CommentImageComposerState } from "./comment-image-composer-state";
const models: CommentImageComposerState[] = [];
const model = (text = "甲乙") => {
  const next = createCommentImageComposerState({
    accountId: h.account,
    scopeKey: "feed:work:synthetic",
    text,
  });
  models.push(next);
  return next;
};
const file = () =>
  new File(["synthetic still"], "synthetic.png", { type: "image/png" });

beforeEach(() => {
  h.account = "user-00000000000000000000000000000001";
  h.epoch = 0;
  h.serial = 0;
  h.requests = 0;
  h.sessions = [];
  h.pendingAdd = null;
  h.pendingRemove = null;
  h.rejectAdd = false;
  h.rejectCreate = false;
  h.rejectCleanup = false;
});
afterEach(() => {
  for (const next of models.splice(0)) next.dispose();
});

describe("comment image composer state", () => {
  it("retains a native picker selection across same-account revalidation and keeps its captured caret", async () => {
    const state = model("甲乙");
    state.captureSelection({ value: "甲乙", selectionEnd: 1 });
    const pick = state.beginFilePick()!;
    state.configure({
      accountId: h.account,
      scopeKey: "feed:work:synthetic",
      text: "甲乙",
      revalidating: true,
    });
    await state.finishFilePick([file()], pick);
    expect(h.sessions).toHaveLength(0);
    expect(state.snapshot().picking).toBe(true);
    expect(state.snapshot().ready).toBe(false);
    state.textChanged("甲乙", "前甲乙");
    state.configure({
      accountId: h.account,
      scopeKey: "feed:work:synthetic",
      text: "前甲乙",
      revalidating: false,
    });
    await vi.waitFor(() => expect(state.snapshot().items).toHaveLength(1));
    expect(state.snapshot().items[0]?.offset).toBe(2);
    expect(state.snapshot().adding).toBe(false);
    expect(state.snapshot().picking).toBe(false);
  });

  it.each(["account", "scope", "epoch"])(
    "rejects an old native picker after a real %s change",
    async (change) => {
      const state = model();
      const pick = state.beginFilePick()!;
      if (change === "account")
        h.account = "user-00000000000000000000000000000002";
      if (change !== "scope") h.epoch++;
      state.configure({
        accountId: h.account,
        scopeKey:
          change === "scope" ? "feed:work:other" : "feed:work:synthetic",
        text: "新草稿",
      });
      await state.finishFilePick([file()], pick);
      expect(h.sessions).toHaveLength(0);
      expect(state.snapshot().items).toHaveLength(0);
      expect(state.snapshot().picking).toBe(false);
    },
  );

  it("cancels a queued picker on actual business disable instead of uploading after revalidation", async () => {
    const state = model();
    const pick = state.beginFilePick()!;
    state.configure({
      accountId: h.account,
      scopeKey: "feed:work:synthetic",
      text: "甲乙",
      revalidating: true,
    });
    await state.finishFilePick([file()], pick);
    state.configure({
      accountId: h.account,
      scopeKey: "feed:work:synthetic",
      text: "甲乙",
      disabled: true,
    });
    state.configure({
      accountId: h.account,
      scopeKey: "feed:work:synthetic",
      text: "甲乙",
      disabled: false,
    });
    await Promise.resolve();
    expect(h.sessions).toHaveLength(0);
    expect(state.snapshot().picking).toBe(false);
  });

  it("bounds the retained local picker batch before session confirmation", async () => {
    const state = model();
    const pick = state.beginFilePick()!;
    state.configure({
      accountId: h.account,
      scopeKey: "feed:work:synthetic",
      text: "甲乙",
      revalidating: true,
    });
    await state.finishFilePick(
      Array.from({ length: 7 }, () => file()),
      pick,
    );
    expect(state.snapshot().picking).toBe(false);
    expect(state.snapshot().hasImages).toBe(false);
    expect(state.snapshot().notice).toContain("最多添加 6");
    expect(h.sessions).toHaveLength(0);
  });

  it("blocks Add during removal and allows a fresh Add once the last removal settles", async () => {
    const state = model();
    await state.addFiles([file()]);
    let finish!: () => void;
    h.pendingRemove = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const removing = state.remove(state.snapshot().items[0]!.key);
    expect(state.snapshot().mutating).toBe(true);
    await state.addFiles([file()]);
    expect(h.sessions[0]?.add).toHaveBeenCalledOnce();
    expect(state.snapshot().adding).toBe(false);
    expect(() => state.prepareSubmission("root")).toThrow("请等待图片");
    finish();
    await removing;
    expect(state.snapshot().mutating).toBe(false);
    await state.addFiles([file()]);
    expect(h.sessions).toHaveLength(2);
    expect(state.snapshot().items).toHaveLength(1);
    expect(state.snapshot().adding).toBe(false);
    expect(state.snapshot().ready).toBe(true);
  });
  it("recovers from an unavailable browser worker without locking the draft", async () => {
    const state = model();
    h.rejectCreate = true;
    await expect(state.addFiles([file()])).resolves.toBeUndefined();
    expect(state.snapshot().adding).toBe(false);
    expect(state.snapshot().text).toBe("甲乙");
    expect(state.snapshot().notice).toBe("图片暂时无法添加，请重试。");
    h.rejectCreate = false;
    await state.addFiles([file()]);
    expect(state.snapshot().items).toHaveLength(1);
    expect(state.snapshot().ready).toBe(true);
  });
  it("creates no upload worker/session for idle or text-only composers", () => {
    const state = model();
    expect(h.sessions).toHaveLength(0);
    expect(state.prepareSubmission("root")).toBeNull();
    expect(state.snapshot().hasImages).toBe(false);
  });

  it("keeps an image in the body when mention insertion also trims and normalizes newlines", async () => {
    const raw = "  甲😀\r\n乙  ";
    const state = model(raw);
    state.captureSelection({ value: raw, selectionEnd: 5 });
    await state.addFiles([file()]);
    state.normalizedTextChanged(raw, "甲😀\n乙 @foo");
    expect(state.snapshot().items[0]?.offset).toBe(3);
    expect(state.snapshot().previewText).toBe("甲😀\n乙 @foo");
    const packet = state.prepareSubmission("root-with-mention")!;
    expect(packet.images[0]?.offset).toBe(3);
    await packet.finish(false);
    await state.addFiles([file()]);
    expect(state.snapshot().items.map((item) => item.offset)).toEqual([3, 3]);
  });

  it("rebases a pending file pick through a normalized mention replacement", async () => {
    const raw = "  甲乙  ",
      state = model(raw);
    state.captureSelection({ value: raw, selectionEnd: 3 });
    let finish!: () => void;
    h.pendingAdd = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const adding = state.addFiles([file()]);
    state.normalizedTextChanged(raw, "甲乙 @foo");
    finish();
    await adding;
    expect(state.snapshot().items[0]?.offset).toBe(1);
    expect(state.snapshot().previewImages[0]?.offset).toBe(1);
  });

  it("rebases a captured file-pick anchor while identification is pending", async () => {
    const state = model();
    state.captureSelection({ value: "甲乙", selectionEnd: 1 });
    let finish!: () => void;
    h.pendingAdd = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const adding = state.addFiles([file()]);
    state.textChanged("甲乙", "前甲乙");
    finish();
    await adding;
    expect(state.snapshot().items[0]?.offset).toBe(2);
    expect(state.snapshot().text).toBe("前甲乙");
    expect(state.snapshot().previewImages[0]?.offset).toBe(2);
  });

  it("retains ready images and text when a later pick fails without exposing transport detail", async () => {
    const state = model();
    await state.addFiles([file()]);
    const first = state.snapshot().items[0]!.upload.itemId;
    h.rejectAdd = true;
    await state.addFiles([file()]);
    expect(state.snapshot().items).toHaveLength(1);
    expect(state.snapshot().items[0]?.upload.itemId).toBe(first);
    expect(state.snapshot().text).toBe("甲乙");
    expect(state.snapshot().notice).toBe("图片暂时无法添加，请重试。");
  });

  it("reuses unchanged submission identity after failure, but not a changed body or recipient intent", async () => {
    const state = model("甲😀乙");
    state.captureSelection({ value: "甲😀乙", selectionEnd: 3 });
    await state.addFiles([file(), file()]);
    const first = state.prepareSubmission("root/mentions-a")!;
    expect(first.images.map(({ offset }) => offset)).toEqual([3, 3]);
    await first.finish(false);
    const retry = state.prepareSubmission("root/mentions-a")!;
    expect(retry.requestId).toBe(first.requestId);
    await retry.finish(false);
    const differentTarget = state.prepareSubmission("reply/mentions-a")!;
    expect(differentTarget.requestId).not.toBe(first.requestId);
    await differentTarget.finish(false);
    state.textChanged("甲😀乙", "甲😀新乙");
    const changed = state.prepareSubmission("root/mentions-a")!;
    expect(changed.requestId).not.toBe(first.requestId);
    expect(changed.images.map(({ offset }) => offset)).toEqual([3, 3]);
  });

  it("locks selected-image topology during a send while preserving later host text", async () => {
    const state = model();
    await state.addFiles([file(), file()]);
    const ids = state.snapshot().items.map(({ key }) => key),
      ticket = state.prepareSubmission("root")!;
    await state.addFiles([file()]);
    await state.remove(ids[0]!);
    state.moveToCaret(ids[0]!);
    state.reorder(ids[0]!, 1);
    expect(state.snapshot().items.map(({ key }) => key)).toEqual(ids);
    state.textChanged("甲乙", "甲乙后来补充");
    await ticket.finish(true);
    expect(state.snapshot().text).toBe("甲乙后来补充");
    expect(state.snapshot().items).toHaveLength(0);
    await Promise.resolve();
    expect(h.sessions[0]?.committed).toHaveBeenCalledWith(
      new Set(ticket.images.map(({ itemId }) => itemId)),
    );
    expect(h.sessions[0]?.abandon).not.toHaveBeenCalled();
  });

  it("sends image-only canonical bodies and never treats cleanup failure as send failure", async () => {
    const state = model(" \r\n ");
    await state.addFiles([file()]);
    const ticket = state.prepareSubmission("root")!;
    h.rejectCleanup = true;
    expect(ticket.text).toBe("");
    expect(ticket.images[0]?.offset).toBe(0);
    await expect(ticket.finish(true)).resolves.toBeUndefined();
    await Promise.resolve();
    await Promise.resolve();
    expect(state.snapshot().notice).toBe("");
    expect(state.snapshot().hasImages).toBe(false);
  });

  it("requires upload readiness and connection recovery without replacing the original session", async () => {
    const state = model();
    await state.addFiles([file()]);
    const session = h.sessions[0]!,
      itemId = session.state.items[0]!.itemId;
    session.state = {
      ...session.state,
      status: "paused",
      pauseReason: "offline",
    };
    session.emit();
    expect(() => state.prepareSubmission("root")).toThrow("请等待图片");
    await state.retryConnection();
    expect(h.sessions).toHaveLength(1);
    expect(state.prepareSubmission("root")?.images[0]?.itemId).toBe(itemId);
  });

  it("retires the last removed image holder and creates a fresh session for a later pick", async () => {
    const state = model();
    await state.addFiles([file()]);
    await state.remove(state.snapshot().items[0]!.key);
    expect(state.snapshot().hasImages).toBe(false);
    expect(h.sessions[0]?.abandon).toHaveBeenCalledOnce();
    await state.addFiles([file()]);
    expect(h.sessions).toHaveLength(2);
  });

  it("fences a late pick on account/scope change and never restores its private previews", async () => {
    const state = model();
    let finish!: () => void;
    h.pendingAdd = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const adding = state.addFiles([file()]);
    h.account = "user-00000000000000000000000000000002";
    h.epoch++;
    state.configure({
      accountId: h.account,
      scopeKey: "feed:work:other",
      text: "新账户的正文",
    });
    finish();
    await adding;
    expect(state.snapshot().text).toBe("新账户的正文");
    expect(state.snapshot().items).toHaveLength(0);
    expect(state.snapshot().previewImages).toHaveLength(0);
    expect(h.sessions[0]?.abandon).toHaveBeenCalledOnce();
  });

  it("rebases externally restored host values and clears only on a real scope change", async () => {
    const state = model("甲乙");
    state.captureSelection({ value: "甲乙", selectionEnd: 1 });
    await state.addFiles([file()]);
    state.configure({
      accountId: h.account,
      scopeKey: "feed:work:synthetic",
      text: "前甲乙",
    });
    expect(state.snapshot().items[0]?.offset).toBe(2);
    state.configure({
      accountId: h.account,
      scopeKey: "detail-colophon:work:synthetic",
      text: "独立详情草稿",
    });
    expect(state.snapshot().items).toHaveLength(0);
    expect(h.sessions[0]?.abandon).toHaveBeenCalledOnce();
  });
});
