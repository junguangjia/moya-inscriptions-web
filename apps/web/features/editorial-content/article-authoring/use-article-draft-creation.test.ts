// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ArticleDraft, CreateArticleDraftCommand } from "@moya/contracts";
import type { Root } from "react-dom/client";

const state = vi.hoisted(() => ({
  viewer: null as { id: string } | null,
  checking: false,
  sessionError: false,
  clientAccount: undefined as string | null | undefined,
  epoch: 1,
  notify: vi.fn<(text: string) => void>(),
}));
vi.mock("../../authors/author-context", () => ({
  useAuthors: () => ({
    viewer: state.viewer,
    checking: state.checking,
    sessionError: state.sessionError,
    notify: state.notify,
  }),
}));
vi.mock("../../../lib/public-api/author-community-client", () => ({
  AuthorRequestError: class extends Error {},
  authorClient: {
    account: () =>
      state.clientAccount === undefined
        ? (state.viewer?.id ?? null)
        : state.clientAccount,
    accountEpoch: () => state.epoch,
  },
}));
const client = vi.hoisted(() => ({
  create:
    vi.fn<(command: CreateArticleDraftCommand) => Promise<ArticleDraft>>(),
}));
vi.mock(
  "../../../lib/public-api/article-authoring-client",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../lib/public-api/article-authoring-client")
    >()),
    articleAuthoringClient: client,
  }),
);

import { ArticleRequestError } from "../../../lib/public-api/article-authoring-client";
import { ArticleAvailability } from "./article-availability";
import {
  ARTICLE_DRAFT_ACCOUNT_CHANGED_NOTICE,
  ARTICLE_DRAFT_ACCOUNT_NOTICE,
  ARTICLE_DRAFT_FAILED_NOTICE,
  ARTICLE_DRAFT_ORPHAN_NOTICE,
  ARTICLE_DRAFT_UNKNOWN_NOTICE,
  openArticleDraftBox,
  openArticleDraftInPlace,
  useArticleDraftCreation,
} from "./use-article-draft-creation";

import type { ArticleDraftCreation } from "./use-article-draft-creation";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const OWNER = `user-${"1".repeat(32)}`;
const OTHER = `user-${"2".repeat(32)}`;
const DRAFT_ID = `article-${"3".repeat(32)}`;

const draft = (ownerId = OWNER): ArticleDraft => ({
  id: DRAFT_ID as ArticleDraft["id"],
  ownerId: ownerId as ArticleDraft["ownerId"],
  title: "",
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
  updatedAt: "2026-10-10T00:00:00Z",
  fingerprint: "a".repeat(64),
});

const deferred = <Value>() => {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

const probe: { current: ArticleDraftCreation | null } = { current: null };
const Probe = () => {
  probe.current = useArticleDraftCreation();
  return null;
};

let root: Root | null = null;
const render = (enabled = true) => {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const tree = () =>
    createElement(ArticleAvailability, {
      enabled,
      children: createElement(Probe),
    });
  act(() => root!.render(tree()));
  return {
    rerender: () => act(() => root!.render(tree())),
    unmount: () => {
      act(() => root!.unmount());
      root = null;
    },
  };
};
const hook = () => {
  if (probe.current === null) throw new Error("Missing hook");
  return probe.current;
};
/** Starts a create and returns its result promise, inside act. */
const start = () => {
  let result!: Promise<string | null>;
  act(() => {
    result = hook().create();
  });
  return result;
};
const settle = async <Value>(promise: Promise<Value>) => {
  let value!: Value;
  await act(async () => {
    value = await promise;
  });
  return value;
};
const requestIds = () =>
  client.create.mock.calls.map(([command]) => command.requestId);

beforeEach(() => {
  state.viewer = { id: OWNER };
  state.checking = false;
  state.sessionError = false;
  state.clientAccount = undefined;
  state.epoch = 1;
  probe.current = null;
});
afterEach(() => {
  if (root !== null) act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe("useArticleDraftCreation", () => {
  it("creates an empty draft and returns its confirmed id", async () => {
    render();
    expect(hook()).toMatchObject({
      creating: false,
      retrying: false,
      notice: null,
    });
    const pending = deferred<ArticleDraft>();
    client.create.mockReturnValueOnce(pending.promise);
    const result = start();
    expect(hook().creating).toBe(true);
    // A second tap while in flight sends nothing more.
    let second!: Promise<string | null>;
    act(() => {
      second = hook().create();
    });
    expect(await second).toBeNull();
    expect(client.create).toHaveBeenCalledOnce();
    const [command] = client.create.mock.calls[0]!;
    expect(command).toMatchObject({ title: "", coverRefId: null });
    expect(command.requestId).toMatch(/^[0-9a-f-]{36}$/);
    pending.resolve(draft());
    expect(await settle(result)).toBe(DRAFT_ID);
    expect(hook()).toMatchObject({
      creating: false,
      retrying: false,
      notice: null,
    });
    expect(state.notify).not.toHaveBeenCalled();
  });

  it("re-sends the same requestId after an unknown outcome, and reads as retrying", async () => {
    render();
    client.create.mockRejectedValueOnce(new TypeError("network"));
    expect(await settle(start())).toBeNull();
    expect(hook()).toMatchObject({
      creating: false,
      retrying: true,
      notice: ARTICLE_DRAFT_UNKNOWN_NOTICE,
    });
    client.create.mockRejectedValueOnce(
      new ArticleRequestError(504, null, true),
    );
    expect(await settle(start())).toBeNull();
    expect(hook().retrying).toBe(true);
    client.create.mockResolvedValueOnce(draft());
    expect(await settle(start())).toBe(DRAFT_ID);
    const ids = requestIds();
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(1);
    expect(hook()).toMatchObject({ retrying: false, notice: null });

    // A confirmed draft ends that command: the next creation is new.
    client.create.mockResolvedValueOnce(draft());
    await settle(start());
    expect(requestIds()[3]).not.toBe(ids[0]);
  });

  it("starts a new command after a known refusal", async () => {
    render();
    client.create.mockRejectedValueOnce(
      new ArticleRequestError(422, "article_invalid", false),
    );
    expect(await settle(start())).toBeNull();
    expect(hook()).toMatchObject({
      retrying: false,
      notice: ARTICLE_DRAFT_FAILED_NOTICE,
    });
    client.create.mockResolvedValueOnce(draft());
    await settle(start());
    const [first, second] = requestIds();
    expect(second).not.toBe(first);
  });

  it("treats an answer for another owner as unconfirmed", async () => {
    render();
    client.create.mockResolvedValueOnce(draft(OTHER));
    expect(await settle(start())).toBeNull();
    expect(hook()).toMatchObject({
      retrying: true,
      notice: ARTICLE_DRAFT_UNKNOWN_NOTICE,
    });
  });

  it("gives the unconfirmed notice and no id when the account fence moved mid-flight", async () => {
    render();
    const pending = deferred<ArticleDraft>();
    client.create.mockReturnValueOnce(pending.promise);
    const result = start();
    // A→B→A: the same account, a new epoch.
    state.epoch = 2;
    pending.resolve(draft());
    expect(await settle(result)).toBeNull();
    expect(hook()).toMatchObject({
      creating: false,
      retrying: true,
      notice: ARTICLE_DRAFT_ACCOUNT_CHANGED_NOTICE,
    });
    expect(state.notify).not.toHaveBeenCalled();
    // The retry confirms the same creation.
    client.create.mockResolvedValueOnce(draft());
    expect(await settle(start())).toBe(DRAFT_ID);
    const [first, second] = requestIds();
    expect(second).toBe(first);
  });

  it("drops a pending command and a late answer when the signed-in account changes", async () => {
    const view = render();
    const pending = deferred<ArticleDraft>();
    client.create.mockReturnValueOnce(pending.promise);
    const result = start();
    state.viewer = { id: OTHER };
    view.rerender();
    expect(hook()).toMatchObject({ creating: false, notice: null });
    pending.resolve(draft());
    expect(await settle(result)).toBeNull();
    expect(hook()).toMatchObject({
      creating: false,
      retrying: false,
      notice: null,
    });
    expect(state.notify).not.toHaveBeenCalled();
  });

  it("refuses while the account is checked, failed or mismatched", async () => {
    state.checking = true;
    const view = render();
    expect(await settle(start())).toBeNull();
    expect(hook().notice).toBe(ARTICLE_DRAFT_ACCOUNT_NOTICE);

    state.checking = false;
    state.sessionError = true;
    view.rerender();
    act(() => hook().clearNotice());
    expect(hook().notice).toBeNull();
    expect(await settle(start())).toBeNull();
    expect(hook().notice).toBe(ARTICLE_DRAFT_ACCOUNT_NOTICE);

    state.sessionError = false;
    state.clientAccount = OTHER;
    view.rerender();
    expect(await settle(start())).toBeNull();
    expect(hook().notice).toBe(ARTICLE_DRAFT_ACCOUNT_NOTICE);

    state.clientAccount = undefined;
    state.viewer = null;
    view.rerender();
    expect(await settle(start())).toBeNull();
    expect(hook().notice).toBe(ARTICLE_DRAFT_ACCOUNT_NOTICE);
    expect(client.create).not.toHaveBeenCalled();
  });

  it("refuses while articles are off", async () => {
    render(false);
    expect(await settle(start())).toBeNull();
    expect(hook().notice).toBe(ARTICLE_DRAFT_ACCOUNT_NOTICE);
    expect(client.create).not.toHaveBeenCalled();
  });

  it("tells the author where a draft confirmed after unmount is, once", async () => {
    const view = render();
    const pending = deferred<ArticleDraft>();
    client.create.mockReturnValueOnce(pending.promise);
    const result = start();
    view.unmount();
    pending.resolve(draft());
    expect(await settle(result)).toBeNull();
    expect(state.notify).toHaveBeenCalledExactlyOnceWith(
      ARTICLE_DRAFT_ORPHAN_NOTICE,
    );
  });

  it("says nothing for a late answer after unmount and an account change", async () => {
    const view = render();
    const pending = deferred<ArticleDraft>();
    client.create.mockReturnValueOnce(pending.promise);
    const result = start();
    view.unmount();
    state.clientAccount = OTHER;
    state.epoch = 2;
    pending.resolve(draft());
    expect(await settle(result)).toBeNull();
    expect(state.notify).not.toHaveBeenCalled();
  });

  it("says nothing for a failure after unmount", async () => {
    const view = render();
    const pending = deferred<ArticleDraft>();
    client.create.mockReturnValueOnce(pending.promise);
    const result = start();
    view.unmount();
    pending.reject(new ArticleRequestError(500, null, true));
    expect(await settle(result)).toBeNull();
    expect(state.notify).not.toHaveBeenCalled();
  });
});

describe("the start screen's 专题 routes", () => {
  it("opens the draft in place, or the draft box by the article editor's route", () => {
    const controls = { replaceTarget: vi.fn() };
    openArticleDraftInPlace(controls, DRAFT_ID);
    expect(controls.replaceTarget).toHaveBeenLastCalledWith({
      type: "article-draft",
      id: DRAFT_ID,
    });
    openArticleDraftBox(controls);
    expect(controls.replaceTarget).toHaveBeenLastCalledWith({
      type: "article-list",
    });
  });
});
