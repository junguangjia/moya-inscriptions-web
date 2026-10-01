import type { ContentIdentity } from "@moya/contracts";
import { requestIdentity } from "../shell/request-identity";
export const contentKey = (target: {
  readonly type: string;
  readonly id: string;
}) => `${target.type}:${target.id}`;
const validTarget = (value: unknown): value is ContentIdentity => {
  const t = value as ContentIdentity;
  return (
    !!t &&
    typeof t.id === "string" &&
    t.id.length > 0 &&
    t.id.length <= 128 &&
    (t.type === "catalog" ||
      (t.type === "work" && /^work-[0-9a-f]{32}$/u.test(t.id)))
  );
};
const targets = (value: unknown): ContentIdentity[] =>
  Array.isArray(value)
    ? value
        .filter(validTarget)
        .filter(
          (t, i, a) =>
            a.findIndex((x) => contentKey(x) === contentKey(t)) === i,
        )
        .slice(0, 500)
    : [];
interface GuestEntry {
  target: ContentIdentity;
  revision: string;
}
export interface GuestBatch {
  accountId: string;
  requestId: string;
  entries: GuestEntry[];
}
interface GuestState {
  items: GuestEntry[];
  batches: GuestBatch[];
  /** Read once to upgrade the earlier single-batch envelope in place. */
  batch?: GuestBatch | null;
}
let database: Promise<IDBDatabase> | undefined;
const db = () =>
  (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open("artvenn.phase4.local.v1", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("guest");
    open.onerror = () => {
      database = undefined;
      reject(Error("本机存储不可用，收藏尚未保存"));
    };
    open.onsuccess = () => resolve(open.result);
  }));
const transaction = async <T>(mutate: (state: GuestState) => T): Promise<T> => {
  const database = await db();
  return new Promise<T>((resolve, reject) => {
    const tx = database.transaction("guest", "readwrite"),
      store = tx.objectStore("guest"),
      request = store.get("state");
    let result: T;
    request.onsuccess = () => {
      const state: GuestState = request.result ?? { items: [], batches: [] };
      state.batches ??= state.batch ? [state.batch] : [];
      delete state.batch;
      try {
        result = mutate(state);
        store.put(state, "state");
      } catch (error) {
        tx.abort();
        reject(error);
      }
    };
    tx.oncomplete = () => resolve(result!);
    tx.onerror = () => reject(Error("本机存储未完成，请重试"));
    tx.onabort = () => reject(Error("本机存储未完成，请重试"));
  });
};
export const readGuestFavorites = () =>
  transaction((state) => state.items.map((i) => i.target));
export const setGuestFavorite = (target: ContentIdentity, enabled: boolean) =>
  transaction((state) => {
    const key = contentKey(target);
    if (enabled) {
      if (!state.items.some((i) => contentKey(i.target) === key))
        state.items.unshift({ target, revision: requestIdentity() });
    } else
      state.items = state.items.filter((i) => contentKey(i.target) !== key);
    state.items = state.items.slice(0, 500);
    return state.items.map((i) => i.target);
  });
export const pendingGuestBatch = (accountId: string) =>
  transaction((state) => {
    const existing = state.batches.find(
      (batch) => batch.accountId === accountId,
    );
    if (existing) return existing;
    const reserved = new Set(
      state.batches.flatMap((batch) =>
        batch.entries.map((entry) => entry.revision),
      ),
    );
    const entries = state.items
      .filter((entry) => !reserved.has(entry.revision))
      .slice(0, 100);
    if (!entries.length) return null;
    const batch = {
      accountId,
      requestId: requestIdentity(),
      entries,
    };
    state.batches.push(batch);
    return batch;
  });
export const hasOtherGuestBatch = (accountId: string) =>
  transaction((state) =>
    state.batches.some(
      (batch) => batch.accountId !== accountId && batch.entries.length > 0,
    ),
  );
export const acknowledgeGuestBatch = (
  batch: GuestBatch,
  acknowledged: ContentIdentity[],
) =>
  transaction((state) => {
    const index = state.batches.findIndex(
      (current) =>
        current.requestId === batch.requestId &&
        current.accountId === batch.accountId,
    );
    if (index < 0) return;
    const keys = new Set(acknowledged.map(contentKey));
    const consumed = batch.entries.filter((e) =>
      keys.has(contentKey(e.target)),
    );
    const versions = new Set(consumed.map((e) => e.revision));
    state.items = state.items.filter((i) => !versions.has(i.revision));
    const remaining = batch.entries.filter((e) => !versions.has(e.revision));
    if (remaining.length)
      state.batches[index] = {
        ...batch,
        requestId: requestIdentity(),
        entries: remaining,
      };
    else state.batches.splice(index, 1);
  });
export const readLocalHistory = (userId: string | null) => {
  try {
    return targets(
      JSON.parse(
        localStorage.getItem(
          `artvenn.phase4.history.${userId ?? "guest"}.v1`,
        ) ?? "null",
      ),
    );
  } catch {
    return [];
  }
};
export const recordLocalHistory = (
  userId: string | null,
  target: ContentIdentity,
) =>
  localStorage.setItem(
    `artvenn.phase4.history.${userId ?? "guest"}.v1`,
    JSON.stringify(
      [
        target,
        ...readLocalHistory(userId).filter(
          (i) => contentKey(i) !== contentKey(target),
        ),
      ].slice(0, 200),
    ),
  );
