import { describe, expect, it, vi } from "vitest";

import {
  EDIT_READINESS_DEBOUNCE_MS,
  EDIT_READINESS_MAX_FAILURES,
  EDIT_READINESS_POLL_MS,
  createEditReadinessTracker,
  derivationSignature,
  itemDerivation,
  itemEditKey,
  needsDerivation,
  withEditKey,
} from "./edit-readiness";
import { manualTimers, settle } from "./upload-manager.test-support";

import type {
  PublishingReadiness,
  WorkDraftContent,
  WorkDraftItem,
} from "@moya/contracts";

const ITEM = `media-item-${"1".repeat(32)}`;
const KEY = "a".repeat(32);

const content = (change: Partial<WorkDraftContent> = {}): WorkDraftContent => ({
  title: "",
  body: "",
  authorship: null,
  visibility: "public",
  items: [
    {
      key: "a",
      itemId: ITEM,
      kind: "static",
      qualityMode: "standard",
      edit: { rotation: 90, crop: null },
    },
    {
      key: "b",
      itemId: `media-item-${"2".repeat(32)}`,
      kind: "static",
      qualityMode: "standard",
      edit: { rotation: 0, crop: null },
    },
  ],
  coverKey: null,
  coverCrop: null,
  ...change,
});

const answer = (
  pending: string[],
  failed: string[] = [],
  editKeys: Record<string, string> = {},
): PublishingReadiness => ({
  ready: pending.length === 0 && failed.length === 0,
  pendingItemKeys: pending,
  failedItemKeys: failed,
  editKeys,
});

const setup = (initial: WorkDraftContent | null = content()) => {
  const timers = manualTimers();
  let current = initial;
  const check =
    vi.fn<(c: WorkDraftContent) => Promise<PublishingReadiness | null>>();
  const tracker = createEditReadinessTracker({
    content: () => current,
    check,
    timers: timers.timers,
  });
  return {
    tracker,
    timers,
    check,
    setContent: (next: WorkDraftContent | null) => {
      current = next;
    },
    /** Fires the one pending timer and lets the answer land. */
    tick: async () => {
      timers.fireAll();
      await settle();
    },
    delays: () => [...timers.pending.values()].map((timer) => timer.ms),
  };
};

describe("derivation signatures", () => {
  it("names only edits beyond base, the cover crop for the cover item included", () => {
    const album = { coverKey: "b", coverCrop: null };
    const [a, b] = content().items;
    expect(derivationSignature(a!, album)).not.toBeNull();
    expect(derivationSignature(b!, album)).toBeNull();
    expect(
      derivationSignature(b!, {
        coverKey: "b",
        coverCrop: { x: 0, y: 0, width: 0.5, height: 0.5 },
      }),
    ).not.toBeNull();
    // The same crop on a non-cover item changes nothing.
    expect(
      derivationSignature(b!, {
        coverKey: "a",
        coverCrop: { x: 0, y: 0, width: 0.5, height: 0.5 },
      }),
    ).toBeNull();
    expect(needsDerivation(content())).toBe(true);
    expect(
      needsDerivation(
        content({ items: [content().items[1]!], coverKey: null }),
      ),
    ).toBe(false);
  });

  it("never derives for feed framing: it is presentation only (#341)", () => {
    const album = { coverKey: null, coverCrop: null };
    const [a, b] = content().items as [WorkDraftItem, WorkDraftItem];
    const framed = (entry: WorkDraftItem): WorkDraftItem => ({
      ...entry,
      edit: { ...entry.edit, feed: { fit: "contain" } },
    });
    expect(derivationSignature(framed(a), album)).toBe(
      derivationSignature(a, album),
    );
    expect(derivationSignature(framed(b), album)).toBeNull();
    expect(
      needsDerivation(content({ items: [framed(b)], coverKey: null })),
    ).toBe(false);
    // The answer that covered the unframed edit still covers it.
    const covered = {
      status: "ready" as const,
      answered: {
        ready: true,
        pendingItemKeys: new Set<string>(),
        failedItemKeys: new Set<string>(),
        editKeys: { a: KEY },
        signatures: { a: derivationSignature(a, album), b: null },
      },
    };
    expect(itemDerivation(framed(a), album, covered)).toBe("ready");
    expect(itemEditKey(framed(a), album, covered)).toBe(KEY);
  });

  it("derives an item's state from the answer that covers its current edit", () => {
    const album = { coverKey: null, coverCrop: null };
    const [a, b] = content().items;
    const covered = {
      status: "ready" as const,
      answered: {
        ready: true,
        pendingItemKeys: new Set<string>(),
        failedItemKeys: new Set<string>(),
        editKeys: { a: KEY },
        signatures: {
          a: derivationSignature(a!, album),
          b: null,
        },
      },
    };
    expect(itemDerivation(a!, album, null)).toBe("pending");
    expect(itemDerivation(b!, album, null)).toBe("none");
    expect(itemDerivation(a!, album, covered)).toBe("ready");
    expect(itemEditKey(a!, album, covered)).toBe(KEY);
    expect(itemEditKey(b!, album, covered)).toBeNull();
    // A newer edit is not covered; the account's pending word wins for base items too.
    const turned = { ...a!, edit: { rotation: 180 as const, crop: null } };
    expect(itemDerivation(turned, album, covered)).toBe("pending");
    expect(itemEditKey(turned, album, covered)).toBeNull();
    const pendingB = {
      ...covered,
      status: "not_ready" as const,
      answered: {
        ...covered.answered,
        ready: false,
        pendingItemKeys: new Set(["b"]),
      },
    };
    expect(itemDerivation(b!, album, pendingB)).toBe("pending");
    const failedA = {
      ...covered,
      answered: { ...covered.answered, failedItemKeys: new Set(["a"]) },
    };
    expect(itemDerivation(a!, album, failedA)).toBe("failed");
  });

  it("rewrites a derivative path to the edit key and leaves other paths alone", () => {
    expect(
      withEditKey(`/api/community/publishing/media/${ITEM}/thumb/base`, KEY),
    ).toBe(`/api/community/publishing/media/${ITEM}/thumb/${KEY}`);
    expect(
      withEditKey(`/api/community/media/user-media-${"3".repeat(32)}`, KEY),
    ).toBe(`/api/community/media/user-media-${"3".repeat(32)}`);
    expect(withEditKey("blob:local", KEY)).toBe("blob:local");
  });
});

describe("edit readiness tracker", () => {
  it("asks once an edit settles and polls with a bounded backoff until ready", async () => {
    const t = setup();
    t.check.mockResolvedValueOnce(answer(["a"]));
    t.tracker.schedule();
    expect(t.delays()).toEqual([EDIT_READINESS_DEBOUNCE_MS]);
    // Typing meanwhile changes nothing the account derives: no new timer.
    t.tracker.schedule();
    expect(t.delays()).toEqual([EDIT_READINESS_DEBOUNCE_MS]);
    await t.tick();
    expect(t.check).toHaveBeenCalledTimes(1);
    expect(t.tracker.store.get()).toMatchObject({
      status: "not_ready",
      answered: { ready: false, pendingItemKeys: new Set(["a"]) },
    });
    // Backoff 1 s, 2 s, 3 s, 5 s, 5 s … while the account still names pending items.
    const seen: number[] = [];
    for (let round = 0; round < 6; round += 1) {
      seen.push(t.delays()[0]!);
      t.check.mockResolvedValueOnce(answer(["a"]));
      await t.tick();
    }
    expect(seen).toEqual([1000, 2000, 3000, 5000, 5000, 5000]);
    expect(Math.max(...seen)).toBeLessThanOrEqual(5000);
    expect(seen).toEqual(
      seen.map((_, i) => EDIT_READINESS_POLL_MS[Math.min(i, 3)]),
    );
    t.check.mockResolvedValueOnce(answer([], [], { a: KEY }));
    await t.tick();
    expect(t.tracker.store.get()).toMatchObject({
      status: "ready",
      answered: { ready: true, editKeys: { a: KEY } },
    });
    // Ready: no more polling.
    expect(t.delays()).toEqual([]);
  });

  it("asks nothing again when only an item's feed framing changes (#341)", async () => {
    const t = setup();
    t.check.mockResolvedValueOnce(answer([], [], { a: KEY }));
    t.tracker.schedule();
    await t.tick();
    expect(t.tracker.store.get().status).toBe("ready");
    const [a, b] = content().items as [WorkDraftItem, WorkDraftItem];
    t.setContent(
      content({
        items: [
          { ...a, edit: { ...a.edit, feed: { fit: "cover", y: 0 } } },
          { ...b, edit: { ...b.edit, feed: { fit: "contain" } } },
        ],
      }),
    );
    t.tracker.schedule();
    expect(t.delays()).toEqual([]);
    expect(t.check).toHaveBeenCalledTimes(1);
    expect(t.tracker.store.get().status).toBe("ready");
  });

  it("stops when only failures remain, and asks again after the next edit", async () => {
    const t = setup();
    t.check.mockResolvedValueOnce(answer([], ["a"]));
    t.tracker.schedule();
    await t.tick();
    expect(t.tracker.store.get().status).toBe("not_ready");
    expect(t.delays()).toEqual([]);
    t.setContent(
      content({
        items: [
          { ...content().items[0]!, edit: { rotation: 270, crop: null } },
          content().items[1]!,
        ],
      }),
    );
    t.check.mockResolvedValueOnce(answer([]));
    t.tracker.schedule();
    expect(t.delays()).toEqual([EDIT_READINESS_DEBOUNCE_MS]);
    await t.tick();
    expect(t.check).toHaveBeenCalledTimes(2);
    expect(t.tracker.store.get().status).toBe("ready");
  });

  it("waits without asking while nothing needs derivatives or no holder exists", async () => {
    const plain = content({ items: [content().items[1]!] });
    const t = setup(plain);
    t.tracker.schedule();
    expect(t.delays()).toEqual([]);
    t.tracker.poke();
    expect(t.check).not.toHaveBeenCalled();
    // An edit while the session has no holder yet: the check answers null.
    t.setContent(content());
    t.check.mockResolvedValueOnce(null);
    t.tracker.schedule();
    await t.tick();
    expect(t.tracker.store.get()).toEqual({ status: "idle", answered: null });
    expect(t.delays()).toEqual([]);
    // The runtime pokes once the holder exists.
    t.check.mockResolvedValueOnce(answer([], [], { a: KEY }));
    t.tracker.poke();
    await settle();
    expect(t.tracker.store.get().status).toBe("ready");
  });

  it("drops the answer of a superseded request and gives up after repeated failures", async () => {
    const t = setup();
    let release: (value: PublishingReadiness) => void = () => undefined;
    t.check.mockImplementationOnce(
      () => new Promise<PublishingReadiness>((resolve) => (release = resolve)),
    );
    t.tracker.schedule();
    await t.tick();
    expect(t.tracker.store.get().status).toBe("checking");
    // A new edit while the first request is in flight: its answer is stale.
    t.setContent(
      content({
        items: [
          { ...content().items[0]!, edit: { rotation: 180, crop: null } },
          content().items[1]!,
        ],
      }),
    );
    t.tracker.schedule();
    release(answer([]));
    await settle();
    expect(t.tracker.store.get().answered).toBeNull();
    for (let round = 0; round < EDIT_READINESS_MAX_FAILURES; round += 1) {
      t.check.mockRejectedValueOnce(new Error("offline"));
      await t.tick();
      if (round < EDIT_READINESS_MAX_FAILURES - 1)
        expect(t.delays()).toEqual([5000]);
    }
    expect(t.tracker.store.get().status).toBe("unavailable");
    expect(t.delays()).toEqual([]);
  });

  it("shows a refused submission's keys as pending and keeps asking, even without edits", async () => {
    const plain = content({ items: [content().items[1]!] });
    const t = setup(plain);
    t.tracker.markPending(["b"]);
    expect(t.tracker.store.get()).toMatchObject({
      status: "not_ready",
      answered: { ready: false, pendingItemKeys: new Set(["b"]) },
    });
    expect(t.delays()).toEqual([EDIT_READINESS_POLL_MS[0]]);
    t.check.mockResolvedValueOnce(answer(["b"]));
    await t.tick();
    expect(t.check).toHaveBeenCalledTimes(1);
    expect(t.delays()).toEqual([EDIT_READINESS_POLL_MS[1]]);
    t.check.mockResolvedValueOnce(answer([]));
    await t.tick();
    expect(t.tracker.store.get().status).toBe("ready");
    expect(t.delays()).toEqual([]);
    t.tracker.dispose();
    t.tracker.schedule();
    expect(t.delays()).toEqual([]);
  });
});
