import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCommand } from "./cli.mjs";
import { fixture } from "./test-fixtures.mjs";

test("CLI freezes and inspects private input without loading credentials or a network adapter", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "catalog-workflow-cli-"),
  );
  try {
    const file = path.join(directory, "manifest.json"),
      stateDir = path.join(directory, "state"),
      manifest = fixture();
    await writeFile(file, JSON.stringify(manifest), { mode: 0o600 });
    const args = ["--manifest", file, "--state-dir", stateDir];
    const first = await runCommand(["freeze", ...args]);
    const checkpoint = await readFile(
      path.join(stateDir, "catalog-workflow-checkpoint.json"),
      "utf8",
    );
    const second = await runCommand(["inspect", ...args]);
    assert.equal(first.manifestSha256, second.manifestSha256);
    assert.equal(second.networkRequests, 0);
    assert.equal(second.binaryBodyBytes, 0);
    assert.equal(second.liveE2E, false);
    manifest.records[0].media[0].uploadedSha256 = "f".repeat(64);
    await writeFile(file, JSON.stringify(manifest), { mode: 0o600 });
    const changed = await runCommand(["freeze", ...args]);
    assert.equal(changed.code, "CHECKPOINT_INPUT_CHANGED");
    assert.equal(
      await readFile(
        path.join(stateDir, "catalog-workflow-checkpoint.json"),
        "utf8",
      ),
      checkpoint,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unbound live commands reject before attempting any file or credential reads", async () => {
  for (const command of ["run", "publish", "withdraw", "upload"])
    await assert.rejects(
      () => runCommand([command, "--manifest", "/SYNTHETIC_MISSING_INPUT"]),
      (e) => e.code === "LIVE_ADAPTER_NOT_BOUND",
    );
});

test("unknown commands, duplicate flags and relative input are rejected", async () => {
  for (const args of [
    ["inspect"],
    ["other"],
    ["inspect", "--manifest", "relative.json", "--state-dir", "/tmp/synthetic"],
    ["inspect", "--manifest", "/synthetic.json", "--manifest", "/other.json"],
  ])
    await assert.rejects(
      () => runCommand(args),
      (e) => e.code === "CLI_ARGUMENTS_INVALID",
    );
});
