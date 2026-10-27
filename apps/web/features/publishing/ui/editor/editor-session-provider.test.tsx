// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../authors/author-context", () => ({
  useAuthors: () => ({
    viewer: { id: `user-${"a".repeat(32)}` },
    notify: () => undefined,
  }),
}));

import { discardBrowserEditorRecovery } from "../../editor-recovery";
import { identifyFiles } from "../../import-grouping";
import {
  PublishingProvider,
  useUploadSession,
} from "../../publishing-provider";
import {
  ACCOUNT,
  absentMetadata,
  fakeClient,
  fakePreprocess,
  fakeTransfer,
  manualTimers,
  settle,
  uuid,
} from "../../upload-manager.test-support";
import {
  EditorSessionProvider,
  useEditorSessionRegistry,
  useEndAccountEditing,
} from "./editor-session-provider";

import type {
  PublishingClientPort,
  PublishingServices,
} from "../../publishing-runtime";
import type { EditorSessionStore } from "./editor-session-state";
import type { Root } from "react-dom/client";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * account-deletion-v1: once an account is deleted, a live composer of it in
 * this tab must not write its interruption recovery back after the clear.
 * The browser stores are real (jsdom storage and a minimal in-memory
 * IndexedDB); the account and its draft are synthetic.
 */

interface Row {
  readonly key: IDBValidKey;
  readonly value: unknown;
}

/** Just the IndexedDB surface the editor recovery uses, in memory. */
const memoryIndexedDb = () => {
  const databases = new Map<string, Map<string, Map<string, Row>>>();
  const soon = (run: () => void) => queueMicrotask(run);
  const answer = <T,>(produce: () => T) => {
    const request: {
      result?: T;
      onsuccess: (() => void) | null;
      onerror: (() => void) | null;
    } = { onsuccess: null, onerror: null };
    // Writes apply at once; their answer comes as a browser's would, later.
    const result = produce();
    soon(() => {
      request.result = result;
      request.onsuccess?.();
    });
    return request;
  };
  const objectStore = (rows: Map<string, Row>) => ({
    put: (value: unknown, key: IDBValidKey) =>
      answer(() => {
        rows.set(String(key), { key, value });
        return key;
      }),
    delete: (key: IDBValidKey) => answer(() => void rows.delete(String(key))),
    get: (key: IDBValidKey) => answer(() => rows.get(String(key))?.value),
    getAll: () => answer(() => [...rows.values()].map((row) => row.value)),
    openCursor: () => {
      const entries = [...rows.values()];
      let index = 0;
      const request: {
        result: unknown;
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
      } = { result: null, onsuccess: null, onerror: null };
      const step = () =>
        soon(() => {
          const entry = entries[index++];
          request.result = entry
            ? { key: entry.key, value: entry.value, continue: step }
            : null;
          request.onsuccess?.();
        });
      step();
      return request;
    },
  });
  const factory = {
    open: (name: string) => {
      const request: {
        result: unknown;
        onupgradeneeded: (() => void) | null;
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
      } = {
        result: null,
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
      };
      soon(() => {
        const fresh = !databases.has(name);
        const stores =
          databases.get(name) ?? new Map<string, Map<string, Row>>();
        databases.set(name, stores);
        request.result = {
          createObjectStore: (store: string) => stores.set(store, new Map()),
          transaction: (store: string) => {
            const transaction = {
              oncomplete: null as (() => void) | null,
              onerror: null as (() => void) | null,
              onabort: null as (() => void) | null,
              objectStore: () => objectStore(stores.get(store)!),
            };
            soon(() => transaction.oncomplete?.());
            return transaction;
          },
          close: () => undefined,
        };
        if (fresh) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
  const rows = () => [
    ...(databases
      .get("artvenn.publishing.editor.v1")
      ?.get("sessions")
      ?.values() ?? []),
  ];
  return { factory, rows };
};

const services = (): PublishingServices => {
  const uploads = fakeClient();
  return {
    client: {
      ...uploads.client,
      limits: vi.fn(async () => ({
        maxItems: 50,
        originalItemMaxBytes: 1_000_000,
        standardComponentMaxBytes: 1_000_000,
        titleMax: 200,
        bodyMax: 10_000,
      })),
    } as unknown as PublishingClientPort,
    currentAccount: () => ACCOUNT,
    requestId: uuid,
    createTransfer: () => fakeTransfer().transfer,
    createPreprocess: () => fakePreprocess(),
    createHasher: () => null,
    createRecovery: () => null,
    identifyFiles: (files) => identifyFiles(files),
    preprocessConcurrency: () => 1,
    transferConcurrency: 2,
    deviceClass: () => "phone",
    timers: manualTimers().timers,
    metadata: absentMetadata,
  };
};

const KEY = `artvenn.editor.interruption.${ACCOUNT}`;
const probe = {} as {
  registry: ReturnType<typeof useEditorSessionRegistry>;
  upload: ReturnType<typeof useUploadSession>;
  end: ReturnType<typeof useEndAccountEditing>;
};
const Probe = () => {
  probe.registry = useEditorSessionRegistry();
  probe.upload = useUploadSession();
  probe.end = useEndAccountEditing();
  return null;
};

let root: Root | null = null;
let idb: ReturnType<typeof memoryIndexedDb>;

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  idb = memoryIndexedDb();
  vi.stubGlobal("indexedDB", idb.factory);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

/** A live composer of the account with a typed, unsaved title. */
const composing = async (): Promise<EditorSessionStore> => {
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () =>
    root!.render(
      <PublishingProvider services={services()}>
        <EditorSessionProvider>
          <Probe />
        </EditorSessionProvider>
      </PublishingProvider>,
    ),
  );
  let store!: EditorSessionStore;
  await act(async () => {
    probe.upload.startSession({ target: { type: "new" }, saveMode: "unsaved" });
    store = probe.registry.create(ACCOUNT, { type: "new" });
  });
  await act(async () => {
    store.setTitle("合成私密草稿");
    await settle();
  });
  // The composer persists its interruption recovery, as in the product.
  expect(window.sessionStorage.getItem(KEY)).toContain("合成私密草稿");
  expect(window.localStorage.getItem(KEY)).toContain("合成私密草稿");
  expect(idb.rows()).toHaveLength(1);
  return store;
};
/** What made the composer persist again in the review scenario. */
const lateTriggers = async (store: EditorSessionStore) => {
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
  });
  await act(async () => {
    store.setTitle("合成私密草稿（续）");
    await settle();
  });
};

describe("a deleted account's live composer", () => {
  it("control: rewrites its recovery after a bare clear (the reviewed defect)", async () => {
    const store = await composing();
    await act(async () => {
      await discardBrowserEditorRecovery(ACCOUNT);
      await settle();
    });
    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(idb.rows()).toHaveLength(0);
    await lateTriggers(store);
    expect(window.localStorage.getItem(KEY)).toContain("合成私密草稿");
  });

  it("writes nothing more once its editing ended before the clear", async () => {
    const store = await composing();
    await act(async () => {
      probe.end(ACCOUNT);
      await discardBrowserEditorRecovery(ACCOUNT);
      await settle();
    });
    expect(probe.registry.current(ACCOUNT)).toBeNull();
    expect(probe.upload.accountId).toBeNull();
    await lateTriggers(store);
    // The runtime also refuses a new session for the ended account.
    await act(async () => {
      expect(
        probe.upload.startSession({
          target: { type: "new" },
          saveMode: "unsaved",
        }),
      ).toBeNull();
      await settle();
    });
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(idb.rows()).toHaveLength(0);
  });

  it("ends its editing and clears its data when another tab deleted the account", async () => {
    const store = await composing();
    const deletedElsewhere = (accountId: string) =>
      act(async () => {
        // What the deleting tab writes (account-local-data.ts); storage
        // events reach only the other tabs.
        window.dispatchEvent(
          new StorageEvent("storage", {
            key: "yoyi-account-deleted",
            newValue: JSON.stringify({
              accountId,
              at: "2026-10-27T01:00:00.000Z",
            }),
          }),
        );
        await settle();
      });
    // Another account's deletion leaves this composer and its recovery alone.
    await deletedElsewhere(`user-${"b".repeat(32)}`);
    expect(probe.registry.current(ACCOUNT)).toBe(store);
    expect(probe.upload.accountId).toBe(ACCOUNT);
    expect(window.localStorage.getItem(KEY)).toContain("合成私密草稿");
    await deletedElsewhere(ACCOUNT);
    expect(probe.registry.current(ACCOUNT)).toBeNull();
    expect(probe.upload.accountId).toBeNull();
    await lateTriggers(store);
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(idb.rows()).toHaveLength(0);
  });
});
