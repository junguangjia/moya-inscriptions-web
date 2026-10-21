// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UserWork } from "@moya/contracts";
import type { Root } from "react-dom/client";

const client = vi.hoisted(() => {
  const identity = { account: null as string | null, epoch: 0 };
  return {
    identity,
    account: vi.fn(() => identity.account),
    accountEpoch: vi.fn(() => identity.epoch),
    // As the client does: every account change starts a new epoch.
    setAccount: (id: string | null) => {
      if (identity.account !== id) identity.epoch++;
      identity.account = id;
    },
  };
});
vi.mock("./author-data", () => ({
  authorClient: { account: client.account, accountEpoch: client.accountEpoch },
}));
// The store's own subscription, as React receives it from useWorkSnapshot,
// so a test can count what the store tells its readers.
const store = vi.hoisted(() => ({
  subscribe: null as null | ((listener: () => void) => () => void),
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const useSyncExternalStore: typeof actual.useSyncExternalStore = (
    subscribe,
    getSnapshot,
    getServerSnapshot,
  ) => {
    store.subscribe = subscribe;
    return actual.useSyncExternalStore(
      subscribe,
      getSnapshot,
      getServerSnapshot,
    );
  };
  return { ...actual, useSyncExternalStore };
});

import {
  readOwnWorkAudience,
  resetOwnWorkAudiences,
  setOwnWorkAudience,
} from "./own-work-audience";
import {
  forgetAuthorWorkSnapshots,
  forgetWorkSnapshot,
  readWorkSnapshot,
  recordWorkSnapshots,
  resetWorkSnapshots,
  useWorkSnapshot,
  workSnapshotToken,
} from "./work-snapshots";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const AUTHOR = `user-${"a".repeat(32)}`;
const OTHER = `user-${"b".repeat(32)}`;
const WORK = `work-${"c".repeat(32)}`;
const workId = (n: number) => `work-${n.toString(16).padStart(32, "0")}`;

const work = (overrides: Partial<UserWork> = {}): UserWork => ({
  id: WORK,
  authorId: AUTHOR,
  authorName: "临帖人",
  title: "春日临帖",
  text: "正文",
  media: [],
  firstPublishedAt: "2026-09-10T08:00:00.000Z",
  editedAt: null,
  version: 1,
  canEdit: false,
  available: true,
  ...overrides,
});

/** The author's own view: it carries the author-only fields. */
const ownWork = (overrides: Partial<UserWork> = {}): UserWork =>
  work({
    canEdit: true,
    visibility: "public",
    trashedAt: null,
    publiclyVisible: true,
    ...overrides,
  });

let renders = 0;
const Probe = ({ id }: { id: string }) => {
  renders++;
  return createElement("output", null, useWorkSnapshot(id)?.text ?? "无");
};

const roots: Root[] = [];
const stops: (() => void)[] = [];
/** A reader of the store, subscribed as React subscribes one. */
const listen = () => {
  renderToString(createElement(Probe, { id: WORK }));
  const listener = vi.fn();
  stops.push(store.subscribe!(listener));
  return listener;
};
const mount = (id: string) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(createElement(Probe, { id })));
  return container;
};

beforeEach(() => {
  client.identity.account = AUTHOR;
  client.identity.epoch = 1;
  client.account.mockClear();
  client.accountEpoch.mockClear();
  renders = 0;
});
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  for (const stop of stops.splice(0)) stop();
  resetWorkSnapshots();
  resetOwnWorkAudiences();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("work snapshots", () => {
  it("reads a recorded work back for the account and epoch that read it", () => {
    const token = workSnapshotToken();
    expect(token).toEqual({ account: AUTHOR, epoch: 1, generation: 0 });
    const first = work();
    recordWorkSnapshots([first], token);
    expect(readWorkSnapshot(WORK)).toBe(first);

    // A later read replaces it.
    const edited = work({ text: "改后正文", version: 2 });
    recordWorkSnapshots([edited], workSnapshotToken());
    expect(readWorkSnapshot(WORK)).toBe(edited);
    expect(readWorkSnapshot(workId(1))).toBeNull();
  });

  it("shows nothing read for another account, even after A→B→A or signing out", () => {
    recordWorkSnapshots([work()], workSnapshotToken());
    client.setAccount(OTHER);
    expect(readWorkSnapshot(WORK)).toBeNull();
    client.setAccount(AUTHOR);
    expect(readWorkSnapshot(WORK)).toBeNull();

    const again = work({ text: "再读" });
    recordWorkSnapshots([again], workSnapshotToken());
    expect(readWorkSnapshot(WORK)).toBe(again);
    client.setAccount(null);
    expect(readWorkSnapshot(WORK)).toBeNull();
  });

  it("records nothing from a read started for another account or epoch", () => {
    const token = workSnapshotToken();
    client.setAccount(OTHER);
    recordWorkSnapshots([ownWork()], token);
    expect(readWorkSnapshot(WORK)).toBeNull();

    // Back to the same account: the epoch still differs.
    client.setAccount(AUTHOR);
    recordWorkSnapshots([ownWork()], token);
    expect(readWorkSnapshot(WORK)).toBeNull();
    expect(readOwnWorkAudience(AUTHOR, WORK)).toBeNull();
  });

  it("records nothing during a server render", () => {
    const token = workSnapshotToken();
    vi.stubGlobal("window", undefined);
    recordWorkSnapshots([ownWork()], token);
    vi.unstubAllGlobals();
    expect(readWorkSnapshot(WORK)).toBeNull();
    expect(readOwnWorkAudience(AUTHOR, WORK)).toBeNull();
  });

  it("drops only the forgotten work from a read in progress", () => {
    recordWorkSnapshots([work()], workSnapshotToken());
    const token = workSnapshotToken();
    forgetWorkSnapshot(WORK);
    expect(readWorkSnapshot(WORK)).toBeNull();

    const kept = work({ id: workId(2), title: "另一件" });
    recordWorkSnapshots([work(), kept], token);
    expect(readWorkSnapshot(WORK)).toBeNull();
    expect(readWorkSnapshot(kept.id)).toBe(kept);

    // A read started after the forget records the work again.
    const later = work({ text: "新读" });
    recordWorkSnapshots([later], workSnapshotToken());
    expect(readWorkSnapshot(WORK)).toBe(later);
  });

  it("forgets every work of an author, including reads in progress", () => {
    const blocked = [
      work({ id: workId(1), authorId: OTHER }),
      work({ id: workId(2), authorId: OTHER }),
    ];
    const kept = work();
    recordWorkSnapshots([...blocked, kept], workSnapshotToken());
    const token = workSnapshotToken();
    forgetAuthorWorkSnapshots(OTHER);
    expect(blocked.map(({ id }) => readWorkSnapshot(id))).toEqual([null, null]);
    expect(readWorkSnapshot(WORK)).toBe(kept);

    const fresh = work({ id: workId(3) });
    recordWorkSnapshots([...blocked, fresh], token);
    expect(blocked.map(({ id }) => readWorkSnapshot(id))).toEqual([null, null]);
    expect(readWorkSnapshot(fresh.id)).toBe(fresh);

    recordWorkSnapshots(blocked, workSnapshotToken());
    expect(readWorkSnapshot(workId(1))).toBe(blocked[0]);
  });

  it("keeps the 200 most recently recorded works", () => {
    const token = workSnapshotToken();
    const works = Array.from({ length: 200 }, (_, n) =>
      work({ id: workId(n) }),
    );
    recordWorkSnapshots(works, token);
    // Recording a work again makes it the most recent.
    recordWorkSnapshots(works.slice(0, 1), token);
    const newest = work({ id: workId(200) });
    recordWorkSnapshots([newest], token);

    expect(readWorkSnapshot(workId(0))).toBe(works[0]);
    expect(readWorkSnapshot(workId(1))).toBeNull();
    expect(readWorkSnapshot(workId(2))).toBe(works[2]);
    expect(readWorkSnapshot(newest.id)).toBe(newest);
  });

  it("bounds what it keeps of forgotten works", () => {
    const token = workSnapshotToken();
    const works = Array.from({ length: 201 }, (_, n) =>
      work({ id: workId(n) }),
    );
    for (const { id } of works) forgetWorkSnapshot(id);
    recordWorkSnapshots(works, token);
    // Only the oldest mark no longer fences the read.
    expect(readWorkSnapshot(workId(0))).toBe(works[0]);
    expect(readWorkSnapshot(workId(1))).toBeNull();
    expect(readWorkSnapshot(workId(200))).toBeNull();
  });

  it("never writes when it reads: a stale record is back once its account and epoch are current again", () => {
    const listener = listen();
    const first = work();
    recordWorkSnapshots([first], workSnapshotToken());
    listener.mockClear();
    client.setAccount(OTHER);
    // Read twice for another account: nothing shown, nothing removed.
    expect(readWorkSnapshot(WORK)).toBeNull();
    expect(readWorkSnapshot(WORK)).toBeNull();
    expect(listener).not.toHaveBeenCalled();

    // Before any write, the recorded account and epoch again (the client
    // never repeats an epoch; only this mock can): the very same record.
    client.identity.account = AUTHOR;
    client.identity.epoch = 1;
    expect(readWorkSnapshot(WORK)).toBe(first);
    expect(listener).not.toHaveBeenCalled();
  });

  it("notifies its readers once per recording call that changes something, and never otherwise", () => {
    const listener = listen();
    // Several works in one call: one notification.
    recordWorkSnapshots(
      [work(), work({ id: workId(1) }), work({ id: workId(2) })],
      workSnapshotToken(),
    );
    expect(listener).toHaveBeenCalledOnce();

    // Nothing to record: none.
    recordWorkSnapshots([], workSnapshotToken());
    expect(listener).toHaveBeenCalledOnce();

    // Only a work forgotten since its read started: none.
    const token = workSnapshotToken();
    forgetWorkSnapshot(workId(3));
    listener.mockClear();
    recordWorkSnapshots([work({ id: workId(3) })], token);
    expect(readWorkSnapshot(workId(3))).toBeNull();
    expect(listener).not.toHaveBeenCalled();

    // A read started for another account: none.
    const earlier = workSnapshotToken();
    client.setAccount(OTHER);
    recordWorkSnapshots([work({ id: workId(4) })], earlier);
    expect(listener).not.toHaveBeenCalled();

    // Dropping the earlier account's records and recording one: one.
    recordWorkSnapshots(
      [work({ id: workId(5), authorId: OTHER })],
      workSnapshotToken(),
    );
    expect(listener).toHaveBeenCalledOnce();

    // Dropping records alone changes the store: one; then nothing is left
    // to drop: none.
    client.setAccount(AUTHOR);
    recordWorkSnapshots([], workSnapshotToken());
    expect(listener).toHaveBeenCalledTimes(2);
    recordWorkSnapshots([], workSnapshotToken());
    expect(listener).toHaveBeenCalledTimes(2);

    // Reading never notifies.
    expect(readWorkSnapshot(workId(5))).toBeNull();
    expect(readWorkSnapshot(WORK)).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("prunes records of another account or epoch on the next write", () => {
    recordWorkSnapshots([work()], workSnapshotToken());
    client.setAccount(OTHER);
    client.account.mockClear();
    expect(readWorkSnapshot(WORK)).toBeNull();
    // Still held until a write: the read had to compare it with the account.
    expect(client.account).toHaveBeenCalled();

    const theirs = work({ id: workId(5), authorId: OTHER });
    recordWorkSnapshots([theirs], workSnapshotToken());
    client.account.mockClear();
    client.accountEpoch.mockClear();
    expect(readWorkSnapshot(WORK)).toBeNull();
    expect(client.account).not.toHaveBeenCalled();
    expect(client.accountEpoch).not.toHaveBeenCalled();
    expect(readWorkSnapshot(theirs.id)).toBe(theirs);
  });

  it("records the audience only of the author's own works, never of forgotten ones", () => {
    recordWorkSnapshots(
      [
        ownWork({ visibility: "self", publiclyVisible: false }),
        // Without canEdit the author-only fields are not the author's own view.
        work({
          id: workId(6),
          visibility: "public",
          publiclyVisible: true,
        }),
      ],
      workSnapshotToken(),
    );
    expect(readOwnWorkAudience(AUTHOR, WORK)).toEqual({
      publiclyVisible: false,
      visibility: "self",
    });
    expect(readOwnWorkAudience(AUTHOR, workId(6))).toBeNull();

    // A visibility change forgets the work before it records the pending
    // audience, so a late read cannot overwrite it.
    const token = workSnapshotToken();
    forgetWorkSnapshot(WORK);
    const pending = { publiclyVisible: null, visibility: "public" } as const;
    setOwnWorkAudience(AUTHOR, WORK, pending);
    recordWorkSnapshots(
      [ownWork({ visibility: "self", publiclyVisible: false })],
      token,
    );
    expect(readOwnWorkAudience(AUTHOR, WORK)).toEqual(pending);

    // Nor of a forgotten author's works.
    const authorToken = workSnapshotToken();
    forgetAuthorWorkSnapshots(AUTHOR);
    recordWorkSnapshots([ownWork({ id: workId(7) })], authorToken);
    expect(readOwnWorkAudience(AUTHOR, workId(7))).toBeNull();
  });

  it("re-renders a reader on record and forget", () => {
    const shown = mount(WORK);
    expect(shown.textContent).toBe("无");

    act(() =>
      recordWorkSnapshots(
        [work(), work({ id: workId(8) })],
        workSnapshotToken(),
      ),
    );
    expect(shown.textContent).toBe("正文");

    act(() => forgetWorkSnapshot(WORK));
    expect(shown.textContent).toBe("无");

    act(() =>
      recordWorkSnapshots([work({ text: "再读" })], workSnapshotToken()),
    );
    expect(shown.textContent).toBe("再读");

    act(() => forgetAuthorWorkSnapshots(AUTHOR));
    expect(shown.textContent).toBe("无");

    // Another work's record leaves this reader as it was.
    const before = renders;
    act(() =>
      recordWorkSnapshots([work({ id: workId(9) })], workSnapshotToken()),
    );
    expect(renders).toBe(before);
  });

  it("shows nothing on the server", () => {
    recordWorkSnapshots([work()], workSnapshotToken());
    expect(readWorkSnapshot(WORK)).not.toBeNull();
    expect(renderToString(createElement(Probe, { id: WORK }))).toBe(
      "<output>无</output>",
    );
  });

  it("never asks for the account while it holds nothing", () => {
    expect(readWorkSnapshot(WORK)).toBeNull();
    expect(mount(WORK).textContent).toBe("无");
    forgetWorkSnapshot(WORK);
    forgetAuthorWorkSnapshots(AUTHOR);
    expect(readWorkSnapshot(WORK)).toBeNull();
    expect(client.account).not.toHaveBeenCalled();
    expect(client.accountEpoch).not.toHaveBeenCalled();
  });
});
