import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ArticleDraft,
  ArticleDocument,
  UpdateArticleDraftCommand,
} from "@moya/contracts";
import { createArticleAutosave } from "./article-autosave";

const document: ArticleDocument = {
  format: "blocknote",
  version: 1,
  references: {},
  galleries: {},
  blocks: [
    {
      id: "one",
      type: "paragraph",
      props: {},
      content: [{ type: "text", text: "繁體𠮷字\n保留", styles: {} }],
      children: [],
    },
  ],
};
const initial: ArticleDraft = {
  id: "article-00000000000000000000000000000001" as ArticleDraft["id"],
  ownerId: "user-00000000000000000000000000000001" as ArticleDraft["ownerId"],
  title: "专题",
  document,
  coverRefId: null,
  version: 1,
  status: "draft",
  publicVersion: null,
  updatedAt: "2026-09-30T00:00:00.000Z",
  fingerprint: "0".repeat(64),
};
const deferred = <Value>() => {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const result = (command: UpdateArticleDraftCommand): ArticleDraft => ({
  ...initial,
  ...command,
  version: command.expectedVersion + 1,
  fingerprint: String(command.expectedVersion).repeat(64),
});
const setup = (
  save = vi.fn(
    async (_id: ArticleDraft["id"], command: UpdateArticleDraftCommand) =>
      result(command),
  ),
) => {
  let account: string | null = initial.ownerId;
  let epoch = 1;
  let title = initial.title;
  let sequence = 1;
  const capture = vi.fn(() => ({ title, document, coverRefId: null }));
  const read = vi.fn(async () => ({
    ...initial,
    title: "Agent 第四版",
    version: 4,
    fingerprint: "4".repeat(64),
  }));
  const auto = createArticleAutosave({
    initial,
    client: { save, read },
    currentAccount: () => account,
    accountEpoch: () => epoch,
    capture,
    requestId: () =>
      `00000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`,
    classifyFailure: (error) =>
      typeof error === "object" && error !== null && "status" in error
        ? (error as {
            status: number;
            reason: string | null;
            outcomeUnknown: boolean;
          })
        : { status: 422, reason: "invalid", outcomeUnknown: false },
  });
  return {
    auto,
    save,
    read,
    capture,
    edit: (next: string) => {
      title = next;
      auto.changed();
    },
    account: (next: string | null) => {
      account = next;
      epoch++;
    },
  };
};
afterEach(() => vi.useRealTimers());
describe("Article autosave serialized committed revisions", () => {
  it("coalesces many edits and captures once at the save boundary", async () => {
    const state = setup();
    for (let index = 0; index < 100; index++) state.edit(`第${index}字`);
    expect(state.capture).not.toHaveBeenCalled();
    const saved = await state.auto.flush();
    expect(state.save).toHaveBeenCalledTimes(1);
    expect(state.capture).toHaveBeenCalledTimes(1);
    expect(saved.title).toBe("第99字");
    expect(state.auto.store.get()).toMatchObject({
      status: "saved",
      acknowledgedGeneration: 100,
    });
    state.auto.dispose();
  });
  it("preserves typing made while a prior save is in flight", async () => {
    const pending = deferred<ArticleDraft>();
    const save = vi.fn(
      async (_id: ArticleDraft["id"], command: UpdateArticleDraftCommand) =>
        save.mock.calls.length === 1 ? pending.promise : result(command),
    );
    const state = setup(save);
    state.edit("请求中第一版");
    const saving = state.auto.flush();
    await Promise.resolve();
    const first = save.mock.calls[0]![1];
    state.edit("后来输入𠮷");
    pending.resolve(result(first));
    await saving;
    expect(
      save.mock.calls.map(([, command]) => [
        command.expectedVersion,
        command.title,
      ]),
    ).toEqual([
      [1, "请求中第一版"],
      [2, "后来输入𠮷"],
    ]);
    expect(state.auto.store.get()).toMatchObject({
      status: "saved",
      draft: { version: 3, title: "后来输入𠮷" },
    });
    state.auto.dispose();
  });
  it("retries the exact frozen identity after an unconfirmed outcome", async () => {
    const save = vi.fn(
      async (_id: ArticleDraft["id"], command: UpdateArticleDraftCommand) => {
        if (save.mock.calls.length === 1)
          throw { status: 0, reason: null, outcomeUnknown: true };
        return result(command);
      },
    );
    const state = setup(save);
    state.edit("网络断开前");
    await expect(state.auto.flush()).rejects.toMatchObject({
      outcomeUnknown: true,
    });
    state.edit("断开后继续输入");
    await state.auto.retry();
    expect(save.mock.calls[1]![1]).toEqual(save.mock.calls[0]![1]);
    expect(save.mock.calls[2]![1]).toMatchObject({
      expectedVersion: 2,
      title: "断开后继续输入",
    });
    expect(save.mock.calls[2]![1].requestId).not.toBe(
      save.mock.calls[0]![1].requestId,
    );
    state.auto.dispose();
  });
  it("requires explicit comparison before keeping local input over an Agent revision", async () => {
    const save = vi.fn(
      async (_id: ArticleDraft["id"], command: UpdateArticleDraftCommand) => {
        if (save.mock.calls.length === 1)
          throw {
            status: 409,
            reason: "article_changed",
            outcomeUnknown: false,
          };
        return result(command);
      },
    );
    const state = setup(save);
    state.edit("浏览器输入保留");
    await expect(state.auto.flush()).rejects.toMatchObject({ status: 409 });
    await expect(state.auto.flush()).rejects.toThrow("article_changed");
    expect(save).toHaveBeenCalledTimes(1);
    await state.auto.inspectRemote();
    const kept = await state.auto.keepLocalAfterComparison();
    expect(kept).toMatchObject({ title: "浏览器输入保留", version: 5 });
    expect(save.mock.calls[1]![1].expectedVersion).toBe(4);
    state.auto.dispose();
  });
  it("rejects a late answer even when the account changed A to B to A", async () => {
    const pending = deferred<ArticleDraft>();
    const save = vi.fn(async () => pending.promise);
    const state = setup(save);
    state.edit("不可交给另一账号");
    const saving = state.auto.flush();
    await Promise.resolve();
    state.account("user-00000000000000000000000000000002");
    state.account(initial.ownerId);
    pending.resolve({ ...initial, version: 2 });
    await expect(saving).rejects.toThrow("article_account_changed");
    expect(state.auto.store.get().draft.version).toBe(1);
    state.auto.dispose();
  });
  it("waits for IME composition to finish and uses bounded debounce", async () => {
    vi.useFakeTimers();
    const state = setup();
    state.auto.composition(true);
    state.edit("输入法组字中");
    await vi.advanceTimersByTimeAsync(8_000);
    expect(state.save).not.toHaveBeenCalled();
    state.auto.composition(false);
    await vi.advanceTimersByTimeAsync(800);
    expect(state.save).toHaveBeenCalledTimes(1);
    state.auto.dispose();
  });
  it.each(["preview", "publish"])(
    "compares a stale %s candidate with no local edit instead of reusing the cached revision",
    async () => {
      const state = setup();
      expect(state.auto.isDirty()).toBe(false);
      state.auto.noteCandidateConflict();
      expect(state.auto.store.get().status).toBe("conflict");
      await expect(state.auto.flush()).rejects.toThrow("article_changed");
      expect(state.save).not.toHaveBeenCalled();
      const remote = await state.auto.inspectRemote();
      expect(remote.version).toBe(4);
      expect(state.capture).not.toHaveBeenCalled();
      const explicitLocal = await state.auto.keepLocalAfterComparison();
      expect(state.save.mock.calls[0]![1]).toMatchObject({
        expectedVersion: 4,
        title: initial.title,
        document: initial.document,
      });
      expect(explicitLocal.version).toBe(5);
      state.auto.dispose();
    },
  );
  it("uses the pending publication revision for the next edit", async () => {
    const state = setup();
    state.edit("待审核候选");
    const candidate = await state.auto.flush();
    const checkpoint = state.auto.publicationCheckpoint();
    state.auto.adoptPublicationResult(
      { ...candidate, version: 3, status: "pending" },
      checkpoint,
    );
    expect(state.auto.store.get()).toMatchObject({
      status: "saved",
      draft: { version: 3, status: "pending" },
    });
    state.edit("审核期间继续编辑");
    const revised = await state.auto.flush();
    expect(state.save.mock.calls[1]![1]).toMatchObject({
      expectedVersion: 3,
      title: "审核期间继续编辑",
    });
    expect(revised.version).toBe(4);
    state.auto.dispose();
  });
  it("never adopts an unrelated publication or replaces later input", async () => {
    const state = setup();
    state.edit("原候选");
    const candidate = await state.auto.flush();
    const checkpoint = state.auto.publicationCheckpoint();
    state.edit("后来输入");
    expect(() =>
      state.auto.adoptPublicationResult(
        {
          ...candidate,
          version: 3,
          status: "pending",
          fingerprint: "f".repeat(64),
        },
        checkpoint,
      ),
    ).toThrow("article_publication_result_changed");
    state.auto.adoptPublicationResult(
      { ...candidate, version: 3, status: "pending" },
      checkpoint,
    );
    expect(state.auto.isDirty()).toBe(true);
    await state.auto.flush();
    expect(state.save.mock.calls[1]![1]).toMatchObject({
      expectedVersion: 3,
      title: "后来输入",
    });
    state.auto.dispose();
  });
  it("stops automatic retries when a canonical capture is invalid", async () => {
    vi.useFakeTimers();
    const state = setup();
    state.capture.mockImplementation(() => {
      throw new Error("article_invalid_document");
    });
    state.edit("未知属性保留在输入中");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(state.capture).toHaveBeenCalledTimes(1);
    expect(state.save).not.toHaveBeenCalled();
    expect(state.auto.store.get().status).toBe("failed");
    state.auto.dispose();
  });
  it("cancels a dirty timer on identity failure and never silently rebinds after same-owner recovery", async () => {
    vi.useFakeTimers();
    const state = setup();
    state.edit("保留未保存输入");
    state.auto.checkIdentity();
    expect(state.auto.canMutate()).toBe(true);
    expect(state.auto.store.get().status).toBe("pending");
    state.account(null);
    expect(state.auto.canMutate()).toBe(false);
    state.auto.checkIdentity();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.save).not.toHaveBeenCalled();
    expect(state.auto.store.get().status).toBe("permission_lost");
    expect(state.auto.isDirty()).toBe(true);
    expect(state.capture().title).toBe("保留未保存输入");
    state.account(initial.ownerId);
    expect(state.auto.canMutate()).toBe(false);
    state.auto.checkIdentity();
    expect(() => state.auto.flush()).toThrow("article_account_changed");
    expect(state.save).not.toHaveBeenCalled();
    state.auto.dispose();
  });
});
