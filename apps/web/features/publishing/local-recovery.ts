import type {
  MediaComponentRole,
  MediaContentType,
  MediaItemKind,
  MediaUploadQualityMode,
  PublishingMediaItem,
  StandardComponentOutcome,
  WorkDraftItem,
} from "@moya/contracts";

/**
 * Best-effort same-browser recovery for saved drafts only (U08, D05, §8.6):
 * a bounded, account-scoped IndexedDB store of prepared component bytes and
 * their registration, keyed by account + draft + item key. No service worker,
 * no API response caching, no file names, metadata or GPS. A record is
 * `recoverable` only after a successful put and read-back; it is deleted once
 * the Backend has acknowledged every component; never written in no-save
 * mode (the manager holds no store there). Capacity: at most half of the
 * remaining browser quota per write and at most 2 GiB in total.
 */

export const RECOVERY_DATABASE = "artvenn.publishing.recovery.v1";
export const RECOVERY_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
export const RECOVERY_QUOTA_FRACTION = 0.5;

const ACCOUNT_PATTERN = /^user-[0-9a-f]{32}$/u;
const DRAFT_PATTERN = /^work-draft-[0-9a-f]{32}$/u;
const ITEM_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const ITEM_ID_PATTERN = /^media-item-[0-9a-f]{32}$/u;
const COMPONENT_ID_PATTERN = /^media-component-[0-9a-f]{32}$/u;

export interface RecoveryComponent {
  readonly role: MediaComponentRole;
  readonly componentId: string;
  readonly contentType: MediaContentType;
  readonly byteSize: number;
  readonly standardOutcome?: StandardComponentOutcome;
  readonly blob: Blob;
}

export interface RecoveryRecord {
  readonly accountId: string;
  readonly draftId: string;
  readonly itemKey: string;
  readonly itemId: string;
  readonly kind: MediaItemKind;
  readonly qualityMode: MediaUploadQualityMode;
  readonly components: readonly RecoveryComponent[];
  readonly savedAt: number;
}

export interface LocalRecoveryStore {
  /** Resolves true only after the record was stored and read back intact. */
  save(record: RecoveryRecord): Promise<boolean>;
  remove(accountId: string, draftId: string, itemKey: string): Promise<void>;
  list(accountId: string, draftId: string): Promise<RecoveryRecord[]>;
  clearDraft(accountId: string, draftId: string): Promise<void>;
}

/** Storage primitives the store needs; IndexedDB in browsers, memory in tests. */
export interface RecoveryBackend {
  put(
    key: readonly string[],
    record: RecoveryRecord,
    bytes: number,
  ): Promise<void>;
  get(key: readonly string[]): Promise<unknown>;
  delete(key: readonly string[]): Promise<void>;
  /** Records whose key starts with `prefix`. */
  list(prefix: readonly string[]): Promise<unknown[]>;
  /** Total bytes of all stored records. */
  totalBytes(): Promise<number>;
}

export interface StorageEstimator {
  estimate(): Promise<{ quota?: number; usage?: number }>;
}

const recordBytes = (record: RecoveryRecord) =>
  record.components.reduce((sum, component) => sum + component.blob.size, 0);

const COMPONENT_ROLES = new Set(["still", "motion", "package"]);

/** Validates an untrusted stored value; anything else is ignored and removed. */
export const parseRecoveryRecord = (
  value: unknown,
  accountId: string,
  draftId: string,
): RecoveryRecord | null => {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Partial<RecoveryRecord>;
  if (
    record.accountId !== accountId ||
    record.draftId !== draftId ||
    typeof record.itemKey !== "string" ||
    !ITEM_KEY_PATTERN.test(record.itemKey) ||
    typeof record.itemId !== "string" ||
    !ITEM_ID_PATTERN.test(record.itemId) ||
    (record.kind !== "static" && record.kind !== "live") ||
    (record.qualityMode !== "standard" && record.qualityMode !== "original") ||
    typeof record.savedAt !== "number" ||
    !Array.isArray(record.components) ||
    record.components.length < 1 ||
    record.components.length > 2
  )
    return null;
  for (const component of record.components as unknown[]) {
    const c = component as Partial<RecoveryComponent>;
    if (
      typeof c !== "object" ||
      c === null ||
      !COMPONENT_ROLES.has(c.role as string) ||
      typeof c.componentId !== "string" ||
      !COMPONENT_ID_PATTERN.test(c.componentId) ||
      typeof c.contentType !== "string" ||
      typeof c.byteSize !== "number" ||
      !(c.blob instanceof Blob) ||
      c.blob.size !== c.byteSize
    )
      return null;
  }
  return record as RecoveryRecord;
};

const validIdentity = (accountId: string, draftId: string) =>
  ACCOUNT_PATTERN.test(accountId) && DRAFT_PATTERN.test(draftId);

export const createLocalRecoveryStore = (
  backend: RecoveryBackend,
  storage: StorageEstimator | null,
): LocalRecoveryStore => {
  const key = (accountId: string, draftId: string, itemKey: string) => [
    accountId,
    draftId,
    itemKey,
  ];
  const store: LocalRecoveryStore = {
    async save(record) {
      if (
        !validIdentity(record.accountId, record.draftId) ||
        parseRecoveryRecord(record, record.accountId, record.draftId) === null
      )
        return false;
      const bytes = recordBytes(record);
      try {
        if (storage === null) return false;
        const { quota, usage } = await storage.estimate();
        if (typeof quota !== "number" || typeof usage !== "number")
          return false;
        const remaining = Math.max(0, quota - usage);
        const existing = await backend.totalBytes();
        if (
          bytes > remaining * RECOVERY_QUOTA_FRACTION ||
          existing + bytes > RECOVERY_MAX_TOTAL_BYTES
        )
          return false;
        const recordKey = key(record.accountId, record.draftId, record.itemKey);
        await backend.put(recordKey, record, bytes);
        // Read back: a record counts only when every component is really there.
        const stored = parseRecoveryRecord(
          await backend.get(recordKey),
          record.accountId,
          record.draftId,
        );
        if (
          stored === null ||
          stored.itemId !== record.itemId ||
          stored.components.length !== record.components.length
        ) {
          await backend.delete(recordKey).catch(() => undefined);
          return false;
        }
        for (const component of stored.components) {
          if (component.blob.size === 0) continue;
          const tail = await component.blob
            .slice(component.blob.size - 1)
            .arrayBuffer();
          if (tail.byteLength !== 1) {
            await backend.delete(recordKey).catch(() => undefined);
            return false;
          }
        }
        return true;
      } catch {
        return false;
      }
    },
    async remove(accountId, draftId, itemKey) {
      if (!validIdentity(accountId, draftId)) return;
      await backend
        .delete(key(accountId, draftId, itemKey))
        .catch(() => undefined);
    },
    async list(accountId, draftId) {
      if (!validIdentity(accountId, draftId)) return [];
      let values: unknown[];
      try {
        values = await backend.list([accountId, draftId]);
      } catch {
        return [];
      }
      const records: RecoveryRecord[] = [];
      for (const value of values) {
        const record = parseRecoveryRecord(value, accountId, draftId);
        if (record) records.push(record);
        else {
          const itemKey = (value as { itemKey?: unknown } | null)?.itemKey;
          if (typeof itemKey === "string")
            await backend
              .delete(key(accountId, draftId, itemKey))
              .catch(() => undefined);
        }
      }
      return records;
    },
    async clearDraft(accountId, draftId) {
      for (const record of await store.list(accountId, draftId))
        await store.remove(accountId, draftId, record.itemKey);
    },
  };
  return store;
};

// ---------------------------------------------------------------------------
// IndexedDB backend

const ITEMS = "items";
const SIZES = "sizes";

const promisify = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("recovery_storage_failed"));
  });

const done = (transaction: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(new Error("recovery_storage_failed"));
    transaction.onabort = () => reject(new Error("recovery_storage_failed"));
  });

export const createIndexedDbBackend = (
  factory: IDBFactory,
): RecoveryBackend => {
  let opened: Promise<IDBDatabase> | null = null;
  const database = () =>
    (opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(RECOVERY_DATABASE, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(ITEMS);
        request.result.createObjectStore(SIZES);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        opened = null;
        reject(new Error("recovery_storage_unavailable"));
      };
    }));
  const range = (prefix: readonly string[]) =>
    IDBKeyRange.bound([...prefix, ""], [...prefix, "\uffff"]);
  return {
    async put(key, record, bytes) {
      const db = await database();
      const transaction = db.transaction([ITEMS, SIZES], "readwrite");
      transaction.objectStore(ITEMS).put(record, [...key]);
      transaction.objectStore(SIZES).put(bytes, [...key]);
      await done(transaction);
    },
    async get(key) {
      const db = await database();
      return promisify(
        db
          .transaction(ITEMS)
          .objectStore(ITEMS)
          .get([...key]),
      );
    },
    async delete(key) {
      const db = await database();
      const transaction = db.transaction([ITEMS, SIZES], "readwrite");
      transaction.objectStore(ITEMS).delete([...key]);
      transaction.objectStore(SIZES).delete([...key]);
      await done(transaction);
    },
    async list(prefix) {
      const db = await database();
      return promisify(
        db.transaction(ITEMS).objectStore(ITEMS).getAll(range(prefix)),
      );
    },
    async totalBytes() {
      const db = await database();
      const sizes = await promisify(
        db.transaction(SIZES).objectStore(SIZES).getAll(),
      );
      return sizes.reduce(
        (sum: number, size: unknown) =>
          sum + (typeof size === "number" ? size : 0),
        0,
      );
    },
  };
};

/**
 * account-deletion-v1: removes every record of an ended account from this
 * browser, whatever its draft. Other accounts' records are untouched.
 */
export const clearAccountRecovery = async (
  backend: RecoveryBackend,
  accountId: string,
): Promise<void> => {
  if (!ACCOUNT_PATTERN.test(accountId)) return;
  for (const value of await backend.list([accountId])) {
    const record = value as { draftId?: unknown; itemKey?: unknown } | null;
    if (
      typeof record?.draftId === "string" &&
      typeof record.itemKey === "string"
    )
      await backend.delete([accountId, record.draftId, record.itemKey]);
  }
};

/** The browser form of `clearAccountRecovery`; nothing to do without IndexedDB. */
export const clearBrowserAccountRecovery = async (
  accountId: string,
): Promise<void> => {
  if (typeof indexedDB === "undefined") return;
  await clearAccountRecovery(createIndexedDbBackend(indexedDB), accountId);
};

/** The browser store, or null where IndexedDB or storage estimates are missing. */
export const createBrowserRecoveryStore = (): LocalRecoveryStore | null => {
  if (typeof indexedDB === "undefined" || typeof navigator === "undefined")
    return null;
  const storage: StorageEstimator | null =
    "storage" in navigator && typeof navigator.storage?.estimate === "function"
      ? navigator.storage
      : null;
  return createLocalRecoveryStore(createIndexedDbBackend(indexedDB), storage);
};

// ---------------------------------------------------------------------------
// Restore planning

export type RestoreDisposition =
  /** Uploaded and ready (or processing) on the account: nothing local needed. */
  | "on_account"
  /** Local bytes exist for the missing components: an explicit Continue can finish it. */
  | "recoverable"
  /** Neither the account nor this browser has the bytes: the author re-selects. */
  | "must_reselect"
  /** The item was cancelled or removed on the account. */
  | "unavailable";

export interface RestorePlanEntry {
  readonly itemKey: string;
  readonly disposition: RestoreDisposition;
  readonly record: RecoveryRecord | null;
  readonly serverItem: PublishingMediaItem | null;
}

const RECEIVED = new Set(["received", "verified"]);

/**
 * Decides per draft item what reopening this draft on this browser can do:
 * server media wins; local bytes only count for components the account has
 * not received yet.
 */
export const planDraftRestore = (
  items: readonly Pick<WorkDraftItem, "key" | "itemId">[],
  serverItems: readonly PublishingMediaItem[],
  records: readonly RecoveryRecord[],
): RestorePlanEntry[] =>
  items.map((item) => {
    const serverItem =
      item.itemId === null
        ? null
        : (serverItems.find((candidate) => candidate.id === item.itemId) ??
          null);
    const record =
      records.find(
        (candidate) =>
          candidate.itemKey === item.key && candidate.itemId === item.itemId,
      ) ?? null;
    if (serverItem === null)
      return {
        itemKey: item.key,
        disposition: item.itemId === null ? "must_reselect" : "unavailable",
        record: null,
        serverItem: null,
      };
    if (serverItem.state === "cancelled" || serverItem.state === "purged")
      return {
        itemKey: item.key,
        disposition: "unavailable",
        record: null,
        serverItem,
      };
    if (
      serverItem.state === "ready" ||
      serverItem.state === "processing" ||
      serverItem.qualityMode === "legacy"
    )
      return {
        itemKey: item.key,
        disposition: "on_account",
        record: null,
        serverItem,
      };
    const missing = serverItem.components.filter(
      (component) => !RECEIVED.has(component.state),
    );
    const covered =
      record !== null &&
      missing.every((component) =>
        record.components.some(
          (local) =>
            local.componentId === component.id &&
            local.byteSize === component.byteSize,
        ),
      );
    return {
      itemKey: item.key,
      disposition: covered ? "recoverable" : "must_reselect",
      record: covered ? record : null,
      serverItem,
    };
  });
