import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { atomicPrivateJSON, privateJSON } from "../../curation/adapter.mjs";
import { openCheckpoint } from "./checkpoint.mjs";
import { fail } from "./identity.mjs";

const clone = (value) => JSON.parse(JSON.stringify(value));
async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Private local phase index only; existing binary/batch receipts remain separate. */
async function withCheckpointStore(directory, manifest, work, executionKind) {
  if (
    typeof directory !== "string" ||
    !path.isAbsolute(directory) ||
    typeof work !== "function"
  )
    fail("CHECKPOINT_STORE_ARGUMENTS_INVALID");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid() ||
    info.mode & 0o077
  )
    fail("CHECKPOINT_STORE_PRIVATE_DIRECTORY_REQUIRED");
  const checkpointFile = path.join(
    directory,
    "catalog-workflow-checkpoint.json",
  );
  const lockFile = path.join(directory, ".catalog-workflow.lock");
  let lock;
  try {
    lock = await open(
      lockFile,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (error.code === "EEXIST") fail("CHECKPOINT_STORE_LOCKED");
    throw error;
  }
  let lockInfo,
    initialized = false,
    accepting = true;
  const nonce = randomUUID();
  let queue = Promise.resolve();
  const sameCreatedFile = (current) =>
    lockInfo &&
    current.isFile() &&
    current.dev === lockInfo.dev &&
    current.ino === lockInfo.ino;
  const owned = async () => {
    let reader;
    try {
      reader = await open(lockFile, constants.O_RDONLY | constants.O_NOFOLLOW);
      const current = await reader.stat();
      return (
        sameCreatedFile(current) &&
        current.size === nonce.length &&
        (await reader.readFile("utf8")) === nonce
      );
    } catch {
      return false;
    } finally {
      await reader?.close();
    }
  };
  const removeOwn = async () => {
    let removable = false;
    try {
      removable = !initialized
        ? sameCreatedFile(await lstat(lockFile))
        : await owned();
    } catch {
      /* A foreign/missing lock is never removed. */
    }
    if (removable) {
      await unlink(lockFile);
      await syncDirectory(directory);
    }
  };
  try {
    lockInfo = await lock.stat();
    await lock.writeFile(nonce);
    await lock.sync();
    await syncDirectory(directory);
    initialized = true;
    let saved;
    try {
      saved = await privateJSON(checkpointFile, 16 * 1024 * 1024);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const opened = openCheckpoint(manifest, saved, executionKind);
    const assertOwned = async () => {
      if (!accepting) fail("CHECKPOINT_STORE_CLOSED");
      if (!(await owned())) fail("CHECKPOINT_STORE_LOCK_CHANGED");
    };
    const enqueueJSON = (file, value, validate) => {
      if (!accepting) fail("CHECKPOINT_STORE_CLOSED");
      const snapshot = clone(value);
      queue = queue.then(async () => {
        if (!(await owned())) fail("CHECKPOINT_STORE_LOCK_CHANGED");
        validate(snapshot);
        await atomicPrivateJSON(file, snapshot);
        await syncDirectory(directory);
        if (!(await owned())) fail("CHECKPOINT_STORE_LOCK_CHANGED");
      });
      return queue;
    };
    const persist = (checkpoint) =>
      enqueueJSON(checkpointFile, checkpoint, (snapshot) =>
        openCheckpoint(manifest, snapshot, executionKind),
      );
    const persistCompanion = (name, value) => {
      if (
        !["local-http", "native-https"].includes(executionKind) ||
        ![
          "local-native-journal.json",
          "payload-native-journal.json",
          "catalog-delivery-journal.json",
          ...(executionKind === "native-https"
            ? ["production-native-journal.json", "production-state.json"]
            : []),
        ].includes(name)
      )
        fail("CHECKPOINT_COMPANION_REJECTED");
      return enqueueJSON(path.join(directory, name), value, (snapshot) => {
        if (snapshot?.executionKind !== executionKind)
          fail("CHECKPOINT_COMPANION_REJECTED");
      });
    };
    return await work({
      checkpoint: opened.checkpoint,
      inputMatches: opened.inputMatches,
      persist,
      assertOwned,
      persistCompanion,
    });
  } finally {
    accepting = false;
    try {
      await queue;
      if (initialized && !(await owned()))
        fail("CHECKPOINT_STORE_LOCK_CHANGED");
    } finally {
      try {
        await removeOwn();
      } finally {
        await lock.close();
      }
    }
  }
}

export const withOfflineCheckpointStore = (directory, manifest, work) =>
  withCheckpointStore(directory, manifest, work, "offline-fake");
export const withLocalHTTPCheckpointStore = (directory, manifest, work) =>
  withCheckpointStore(directory, manifest, work, "local-http");
export const withNativeHTTPSCheckpointStore = (directory, manifest, work) =>
  withCheckpointStore(directory, manifest, work, "native-https");
