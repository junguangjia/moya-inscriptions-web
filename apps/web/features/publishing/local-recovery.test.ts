import { describe, expect, it, vi } from "vitest";

import {
  RECOVERY_MAX_TOTAL_BYTES,
  clearAccountRecovery,
  createLocalRecoveryStore,
  planDraftRestore,
} from "./local-recovery";

import type { RecoveryBackend, RecoveryRecord } from "./local-recovery";
import type { PublishingMediaItem } from "@moya/contracts";

const account = `user-${"a".repeat(32)}`;
const otherAccount = `user-${"b".repeat(32)}`;
const draftId = `work-draft-${"c".repeat(32)}`;
const itemId = `media-item-${"d".repeat(32)}`;
const stillId = `media-component-${"e".repeat(32)}`;
const motionId = `media-component-${"f".repeat(32)}`;

const memoryBackend = (
  options: { dropBlobs?: boolean; failPut?: boolean } = {},
) => {
  const records = new Map<string, { record: unknown; bytes: number }>();
  const backend: RecoveryBackend = {
    put: vi.fn(
      async (key: readonly string[], record: RecoveryRecord, bytes: number) => {
        if (options.failPut)
          throw new Error("UnknownError: Error preparing Blob/File data");
        records.set(key.join("|"), {
          record: options.dropBlobs
            ? {
                ...record,
                components: record.components.map((c) => ({
                  ...c,
                  blob: null,
                })),
              }
            : record,
          bytes,
        });
      },
    ),
    get: vi.fn(
      async (key: readonly string[]) => records.get(key.join("|"))?.record,
    ),
    delete: vi.fn(async (key: readonly string[]) => {
      records.delete(key.join("|"));
    }),
    list: vi.fn(async (prefix: readonly string[]) =>
      [...records.entries()]
        .filter(([key]) => key.startsWith(`${prefix.join("|")}|`))
        .map(([, value]) => value.record),
    ),
    totalBytes: vi.fn(async () =>
      [...records.values()].reduce((sum, value) => sum + value.bytes, 0),
    ),
  };
  return { backend, records };
};

const record = (overrides: Partial<RecoveryRecord> = {}): RecoveryRecord => ({
  accountId: account,
  draftId,
  itemKey: "k1",
  itemId,
  kind: "static",
  qualityMode: "standard",
  components: [
    {
      role: "still",
      componentId: stillId,
      contentType: "image/webp",
      byteSize: 5,
      standardOutcome: "optimized",
      blob: new Blob([new Uint8Array(5)]),
    },
  ],
  savedAt: 1,
  ...overrides,
});

const plenty = { estimate: async () => ({ quota: 10_000_000, usage: 0 }) };

describe("saved-draft local recovery store", () => {
  it("marks a record recoverable only after put and read-back", async () => {
    const { backend } = memoryBackend();
    const store = createLocalRecoveryStore(backend, plenty);
    expect(await store.save(record())).toBe(true);
    expect(backend.get).toHaveBeenCalled();
    expect(await store.list(account, draftId)).toHaveLength(1);
    // Isolated by account.
    expect(await store.list(otherAccount, draftId)).toEqual([]);
  });

  it("reports false when the browser refuses Blob storage or loses the bytes", async () => {
    expect(
      await createLocalRecoveryStore(
        memoryBackend({ failPut: true }).backend,
        plenty,
      ).save(record()),
    ).toBe(false);
    const dropped = memoryBackend({ dropBlobs: true });
    expect(
      await createLocalRecoveryStore(dropped.backend, plenty).save(record()),
    ).toBe(false);
    expect(dropped.records.size).toBe(0);
    expect(
      await createLocalRecoveryStore(memoryBackend().backend, null).save(
        record(),
      ),
    ).toBe(false);
  });

  it("is bounded by half the remaining quota and 2 GiB in total", async () => {
    const tight = { estimate: async () => ({ quota: 9, usage: 0 }) };
    expect(
      await createLocalRecoveryStore(memoryBackend().backend, tight).save(
        record(),
      ),
    ).toBe(false);
    const { backend } = memoryBackend();
    (backend.totalBytes as ReturnType<typeof vi.fn>).mockResolvedValue(
      RECOVERY_MAX_TOTAL_BYTES - 2,
    );
    expect(await createLocalRecoveryStore(backend, plenty).save(record())).toBe(
      false,
    );
  });

  it("refuses records without a saved draft identity and removes records on acknowledgement", async () => {
    const { backend, records } = memoryBackend();
    const store = createLocalRecoveryStore(backend, plenty);
    expect(await store.save(record({ draftId: "unsaved" }))).toBe(false);
    await store.save(record());
    await store.remove(account, draftId, "k1");
    expect(records.size).toBe(0);
  });
});

const serverItem = (
  states: ("awaiting" | "received")[],
): PublishingMediaItem => ({
  id: itemId,
  kind: "live",
  qualityMode: "original",
  state: "awaiting_upload",
  failureCode: null,
  components: [
    {
      id: stillId,
      role: "still",
      state: states[0]!,
      byteSize: 5,
      receivedBytes: states[0] === "received" ? 5 : 0,
    },
    {
      id: motionId,
      role: "motion",
      state: states[1]!,
      byteSize: 7,
      receivedBytes: 0,
    },
  ],
  presentation: null,
  media: null,
});

describe("account deletion (account-deletion-v1)", () => {
  it("removes every record of the deleted account and nothing else", async () => {
    const { backend, records } = memoryBackend();
    const store = createLocalRecoveryStore(backend, plenty);
    const secondDraft = `work-draft-${"9".repeat(32)}`;
    await store.save(record());
    await store.save(record({ itemKey: "k2" }));
    await store.save(record({ draftId: secondDraft }));
    await store.save(record({ accountId: otherAccount }));
    expect(records.size).toBe(4);
    await clearAccountRecovery(backend, account);
    expect([...records.keys()]).toEqual([`${otherAccount}|${draftId}|k1`]);
    await clearAccountRecovery(backend, "guest");
    expect(records.size).toBe(1);
  });
});

describe("restore planning", () => {
  const liveRecord = record({
    kind: "live",
    qualityMode: "original",
    components: [
      {
        role: "motion",
        componentId: motionId,
        contentType: "video/quicktime",
        byteSize: 7,
        blob: new Blob([new Uint8Array(7)]),
      },
    ],
  });

  it("lists what is recoverable versus what must be re-selected", () => {
    const plan = planDraftRestore(
      [
        { key: "k1", itemId },
        { key: "pending", itemId: null },
      ],
      [serverItem(["received", "awaiting"])],
      [liveRecord],
    );
    expect(plan.map((entry) => [entry.itemKey, entry.disposition])).toEqual([
      ["k1", "recoverable"],
      ["pending", "must_reselect"],
    ]);
    const missing = planDraftRestore(
      [{ key: "k1", itemId }],
      [serverItem(["awaiting", "awaiting"])],
      [liveRecord],
    );
    expect(missing[0]!.disposition).toBe("must_reselect");
    const ready = planDraftRestore(
      [{ key: "k1", itemId }],
      [{ ...serverItem(["received", "received"]), state: "processing" }],
      [],
    );
    expect(ready[0]!.disposition).toBe("on_account");
  });
});
