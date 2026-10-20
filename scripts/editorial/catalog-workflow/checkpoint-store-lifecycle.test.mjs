import assert from "node:assert/strict";
import {
  mkdtemp,
  lstat,
  open,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { withOfflineCheckpointStore } from "./checkpoint-store.mjs";
import { fixture } from "./test-fixtures.mjs";

async function temporary(work) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "catalog-workflow-lifecycle-"),
  );
  try {
    await work(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
const id = "SYNTHETIC-001";

test("callback completion closes persist admission before draining queued snapshots", async () =>
  temporary(async (directory) => {
    let late;
    await withOfflineCheckpointStore(
      directory,
      fixture(),
      async ({ checkpoint, persist }) => {
        late = persist(checkpoint)
          .then(() => {
            checkpoint.records[id].state = "HOLD";
            checkpoint.records[id].code = "RIGHTS_HELD";
            return persist(checkpoint);
          })
          .catch((error) => error.code);
      },
    );
    assert.equal(await late, "CHECKPOINT_STORE_CLOSED");
    const saved = JSON.parse(
      await readFile(
        path.join(directory, "catalog-workflow-checkpoint.json"),
        "utf8",
      ),
    );
    assert.equal(saved.records[id].state, "FROZEN");
  }));

test("final lock replacement is reported even without a later persist", async () =>
  temporary(async (directory) => {
    const file = path.join(directory, ".catalog-workflow.lock");
    await assert.rejects(
      () =>
        withOfflineCheckpointStore(directory, fixture(), async () => {
          await unlink(file);
          await writeFile(file, "SYNTHETIC_FOREIGN_LOCK", {
            mode: 0o600,
            flag: "wx",
          });
        }),
      (e) => e.code === "CHECKPOINT_STORE_LOCK_CHANGED",
    );
    assert.equal(await readFile(file, "utf8"), "SYNTHETIC_FOREIGN_LOCK");
  }));

test("failed nonce initialization removes only its own newly created empty lock", async () =>
  temporary(async (directory) => {
    const probe = await open(path.join(directory, "probe"), "wx", 0o600),
      prototype = Object.getPrototypeOf(probe);
    await probe.close();
    const original = prototype.writeFile;
    let injected = false;
    prototype.writeFile = async function (data, ...args) {
      if (
        !injected &&
        typeof data === "string" &&
        /^[a-f0-9-]{36}$/.test(data)
      ) {
        injected = true;
        throw Object.assign(new Error("SYNTHETIC_NONCE_WRITE_FAILURE"), {
          code: "EIO",
        });
      }
      return original.call(this, data, ...args);
    };
    try {
      await assert.rejects(
        () =>
          withOfflineCheckpointStore(directory, fixture(), async () =>
            assert.fail("callback entered"),
          ),
        { code: "EIO" },
      );
    } finally {
      prototype.writeFile = original;
    }
    assert.equal(injected, true);
    await assert.rejects(
      () => lstat(path.join(directory, ".catalog-workflow.lock")),
      { code: "ENOENT" },
    );
  }));
