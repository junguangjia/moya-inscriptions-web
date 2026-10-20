import assert from "node:assert/strict";
import {
  mkdtemp,
  lstat,
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
    path.join(os.tmpdir(), "catalog-workflow-store-"),
  );
  try {
    await work(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
const id = "SYNTHETIC-001";

test("store reuses existing private atomic writer, reloads exact state and releases its lock", async () =>
  temporary(async (directory) => {
    const manifest = fixture();
    await withOfflineCheckpointStore(
      directory,
      manifest,
      async ({ checkpoint, persist }) => {
        checkpoint.records[id].state = "HOLD";
        checkpoint.records[id].code = "RIGHTS_HELD";
        checkpoint.records[id].protections.rightsHold = true;
        await persist(checkpoint);
      },
    );
    const file = path.join(directory, "catalog-workflow-checkpoint.json");
    assert.equal((await lstat(file)).mode & 0o777, 0o600);
    await assert.rejects(
      () => lstat(path.join(directory, ".catalog-workflow.lock")),
      { code: "ENOENT" },
    );
    await withOfflineCheckpointStore(
      directory,
      manifest,
      async ({ checkpoint }) => {
        assert.equal(checkpoint.records[id].protections.rightsHold, true);
        assert.equal(checkpoint.records[id].state, "HOLD");
      },
    );
  }));

test("concurrent writer is refused without stealing or deleting the active lock", async () =>
  temporary(async (directory) => {
    const manifest = fixture();
    await withOfflineCheckpointStore(directory, manifest, async () => {
      await assert.rejects(
        () =>
          withOfflineCheckpointStore(directory, manifest, async () =>
            assert.fail("second writer entered"),
          ),
        (e) => e.code === "CHECKPOINT_STORE_LOCKED",
      );
      assert.equal(
        (await lstat(path.join(directory, ".catalog-workflow.lock"))).isFile(),
        true,
      );
    });
  }));

test("queued snapshots are copied and serialized before the callback releases the lock", async () =>
  temporary(async (directory) => {
    const manifest = fixture();
    await withOfflineCheckpointStore(
      directory,
      manifest,
      async ({ checkpoint, persist }) => {
        const first = persist(checkpoint);
        checkpoint.records[id].state = "HOLD";
        checkpoint.records[id].code = "RIGHTS_HELD";
        const second = persist(checkpoint);
        await Promise.all([first, second]);
      },
    );
    const saved = JSON.parse(
      await readFile(
        path.join(directory, "catalog-workflow-checkpoint.json"),
        "utf8",
      ),
    );
    assert.equal(saved.records[id].state, "HOLD");
  }));

test("invalid checkpoint cannot replace the stored phase index", async () =>
  temporary(async (directory) => {
    const manifest = fixture();
    await assert.rejects(
      () =>
        withOfflineCheckpointStore(
          directory,
          manifest,
          async ({ checkpoint, persist }) => {
            checkpoint.records[id].sourceId = "source-unrelated";
            await persist(checkpoint);
          },
        ),
      (e) => e.code === "CHECKPOINT_INVALID",
    );
    await assert.rejects(
      () => lstat(path.join(directory, "catalog-workflow-checkpoint.json")),
      { code: "ENOENT" },
    );
    await assert.rejects(
      () => lstat(path.join(directory, ".catalog-workflow.lock")),
      { code: "ENOENT" },
    );
  }));

test("foreign replacement lock is preserved and the original writer stops", async () =>
  temporary(async (directory) => {
    const manifest = fixture(),
      file = path.join(directory, ".catalog-workflow.lock");
    await assert.rejects(
      () =>
        withOfflineCheckpointStore(
          directory,
          manifest,
          async ({ checkpoint, persist }) => {
            await unlink(file);
            await writeFile(file, "SYNTHETIC_FOREIGN_LOCK", {
              mode: 0o600,
              flag: "wx",
            });
            await persist(checkpoint);
          },
        ),
      (e) => e.code === "CHECKPOINT_STORE_LOCK_CHANGED",
    );
    assert.equal(await readFile(file, "utf8"), "SYNTHETIC_FOREIGN_LOCK");
  }));
