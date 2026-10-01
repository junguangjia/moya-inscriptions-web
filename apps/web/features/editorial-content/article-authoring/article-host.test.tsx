// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ArticleDraft,
  ArticleDraftPage,
  CreateArticleDraftCommand,
} from "@moya/contracts";
import {
  parseArticleCreateCommand,
  createEmptyArticleDocument,
} from "../../../lib/public-api/article-authoring-client";
const state = vi.hoisted(() => ({
  account: `user-${"1".repeat(32)}`,
  epoch: 1,
  clientAccount: null as string | null | undefined,
  checking: false,
  refresh: vi.fn(async () => undefined),
  workspaceTitle: "",
}));
vi.mock("next/dynamic", () => ({
  default: () => (props: { initial: ArticleDraft }) => {
    state.workspaceTitle = props.initial.title;
    return <p data-workspace="">{props.initial.title}</p>;
  },
}));
vi.mock("../../authors/author-context", () => ({
  useAuthors: () => ({
    viewer: { id: state.account },
    checking: state.checking,
    refresh: state.refresh,
    signInHref: "/synthetic-sign-in",
  }),
}));
vi.mock("../../product-shell/product-shell", () => ({
  useProductShell: () => ({ platform: "phone" }),
}));
vi.mock("../../../lib/public-api/author-community-client", () => ({
  AuthorRequestError: class extends Error {},
  authorClient: {
    account: () =>
      state.clientAccount === undefined ? state.account : state.clientAccount,
    accountEpoch: () => state.epoch,
  },
}));
const client = vi.hoisted(() => ({
  list: vi.fn<(...args: unknown[]) => Promise<ArticleDraftPage>>(),
  create:
    vi.fn<(command: CreateArticleDraftCommand) => Promise<ArticleDraft>>(),
  read: vi.fn<(id: ArticleDraft["id"]) => Promise<ArticleDraft>>(),
}));
const errors = vi.hoisted(() => ({
  ArticleRequestError: class extends Error {
    constructor(
      readonly status: number,
      readonly reason: string | null,
      readonly outcomeUnknown: boolean,
    ) {
      super("synthetic");
    }
  },
}));
vi.mock(
  "../../../lib/public-api/article-authoring-client",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../lib/public-api/article-authoring-client")
    >()),
    ArticleRequestError: errors.ArticleRequestError,
    articleAuthoringClient: {
      ...client,
      ownMedia: async () => ({ items: [], nextCursor: null }),
    },
  }),
);
import { ArticleAuthoringHost } from "./article-host";
import type { ArticleEditorTarget } from "../../product-shell/product-history";
const draft = (ownerId = state.account): ArticleDraft => ({
  id: `article-${"2".repeat(32)}` as ArticleDraft["id"],
  ownerId: ownerId as ArticleDraft["ownerId"],
  title: "当前账号专题",
  coverRefId: null,
  document: {
    format: "blocknote",
    version: 1,
    blocks: [],
    references: {},
    galleries: {},
  },
  version: 1,
  status: "draft",
  publicVersion: null,
  updatedAt: "2026-09-30T00:00:00Z",
  fingerprint: "a".repeat(64),
});
const deferred = <Value,>() => {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
let root: Root | null = null,
  node: HTMLDivElement;
const controls = {
  backButtonRef: { current: null },
  close: vi.fn(),
  completeWith: vi.fn(),
  replaceTarget: vi.fn(),
  registerLeaveGuard: vi.fn(() => () => undefined),
};
const render = async (
  target: ArticleEditorTarget = { type: "article-list" },
) => {
  await act(async () =>
    root!.render(<ArticleAuthoringHost target={target} controls={controls} />),
  );
};
beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  state.account = `user-${"1".repeat(32)}`;
  state.epoch = 1;
  state.clientAccount = undefined;
  state.checking = false;
  state.workspaceTitle = "";
  vi.clearAllMocks();
  client.list.mockReset();
  client.create.mockReset();
  client.read.mockReset();
  client.list.mockResolvedValue({ items: [], nextCursor: null });
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
});
describe("Owned Article host transport lifecycle", () => {
  it("retries an unknown draft creation with the same exact identity before entering its owned editor", async () => {
    client.create
      .mockRejectedValueOnce(new errors.ArticleRequestError(0, null, true))
      .mockResolvedValueOnce(draft());
    await render();
    const clickCreate = async () => {
      await act(async () =>
        [...node.querySelectorAll<HTMLButtonElement>("button")]
          .find(
            (entry) =>
              entry.textContent?.includes("创建") ||
              entry.textContent === "新建专题文章",
          )!
          .click(),
      );
    };
    await clickCreate();
    expect(
      parseArticleCreateCommand(client.create.mock.calls[0]![0]).document,
    ).toEqual(createEmptyArticleDocument());
    expect(node.textContent).toContain("创建结果尚未确认");
    await clickCreate();
    expect(client.create.mock.calls[1]?.[0]).toEqual(
      client.create.mock.calls[0]?.[0],
    );
    expect(controls.replaceTarget).toHaveBeenCalledWith({
      type: "article-draft",
      id: draft().id,
    });
  });
  it("does not show the old account's draft list after account and epoch changed during the read", async () => {
    const oldAccount = state.account;
    const pending = deferred<ArticleDraftPage>();
    client.list.mockReturnValueOnce(pending.promise);
    await render();
    state.account = `user-${"3".repeat(32)}`;
    state.epoch++;
    await render();
    await act(async () =>
      pending.resolve({ items: [draft(oldAccount)], nextCursor: null }),
    );
    expect(node.textContent).not.toContain("当前账号专题");
    expect(node.textContent).toContain("还没有专题草稿");
  });
  it("does not mount the lazy editor when the read is not owned by the active account", async () => {
    client.read.mockResolvedValue(draft(`user-${"4".repeat(32)}`));
    await render({ type: "article-draft", id: draft().id });
    expect(node.querySelector("[data-workspace]")).toBeNull();
    expect(node.textContent).toContain("不属于当前账号");
  });
  it("settles an unconfirmed retained-viewer read and retries after same-owner confirmation", async () => {
    state.clientAccount = null;
    await render({ type: "article-draft", id: draft().id });
    expect(client.read).not.toHaveBeenCalled();
    expect(node.textContent).not.toContain("正在读取专题草稿");
    expect(node.textContent).toContain("重新确认账号");
    client.read.mockResolvedValueOnce(draft());
    state.clientAccount = state.account;
    state.epoch++;
    await render({ type: "article-draft", id: draft().id });
    expect(node.querySelector("[data-workspace]")).not.toBeNull();
  });
  it("preserves the mounted draft through same-owner verification failure without rereading or rebinding its epoch", async () => {
    client.read.mockResolvedValueOnce(draft());
    await render({ type: "article-draft", id: draft().id });
    const loaded = node.querySelector("[data-workspace]");
    state.clientAccount = null;
    state.epoch++;
    await render({ type: "article-draft", id: draft().id });
    expect(node.querySelector("[data-workspace]")).toBe(loaded);
    expect(client.read).toHaveBeenCalledOnce();
    expect(node.textContent).toContain("当前输入仍保留");
    state.clientAccount = state.account;
    state.epoch++;
    await render({ type: "article-draft", id: draft().id });
    expect(node.querySelector("[data-workspace]")).toBe(loaded);
    expect(client.read).toHaveBeenCalledOnce();
    state.account = `user-${"3".repeat(32)}`;
    state.clientAccount = state.account;
    state.epoch++;
    client.read.mockRejectedValueOnce(new Error("not owned"));
    await render({ type: "article-draft", id: draft().id });
    expect(node.querySelector("[data-workspace]")).toBeNull();
  });
});
