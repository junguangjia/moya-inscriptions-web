/** Metadata-only integration of a frozen snapshot through the existing ledger.
 * No upload, image URL, configuration discovery or public operation exists here.
 */
import { createHash, randomUUID } from "node:crypto";
import { open, mkdir, readFile, rename, lstat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { runBatch, createTransport } from "../editorial/batch.mjs";

const { AbortController } = globalThis;

const fail = (code) => {
  throw new Error(code);
};
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const privateRead = async (file, maximum) => {
  const info = await lstat(file);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    info.mode & 0o077 ||
    info.size > maximum
  )
    fail("PRIVATE_INPUT_REQUIRED");
  return readFile(file);
};

/** All targets are supplied by the caller. Real Production application has a
 * separate Owner gate; offline dryRun needs no configuration or credentials. */
export async function metadataRoundtrip({
  metadataFile,
  configFile,
  stateDirectory,
  expectedPreviousSha256 = null,
  execute = false,
  signal,
  fetchImpl,
}) {
  const {
    MAX_CURATION_METADATA_BYTES,
    decodeCurationMetadata,
    deriveCurationMetadataCounts,
    deriveCurationMetadataWarnings,
  } = await import("../../packages/contracts/dist/internal/editorial/index.js");
  const file = path.resolve(metadataFile);
  const bytes = await privateRead(file, MAX_CURATION_METADATA_BYTES);
  const payload = decodeCurationMetadata(bytes.toString("utf8"));
  const snapshotSha256 = digest(bytes);
  if (
    expectedPreviousSha256 !== null &&
    !/^[a-f0-9]{64}$/.test(expectedPreviousSha256)
  )
    fail("PREVIOUS_METADATA_SHA_INVALID");
  const manifest = {
    version: 1,
    batchId: `metadata-${snapshotSha256}`,
    operation: "save-curation-metadata",
    items: [{ key: "snapshot", metadataFile: file, expectedPreviousSha256 }],
  };
  const config = execute
    ? JSON.parse(await privateRead(configFile, 64 * 1024))
    : {};
  const receiptFile = path.join(
    path.resolve(stateDirectory),
    `${snapshotSha256}.receipt.jsonl`,
  );
  const outcome = await runBatch({
    manifest,
    directory: path.dirname(file),
    receiptFile,
    transport: execute ? createTransport(config, fetchImpl) : undefined,
    dryRun: !execute,
    concurrency: 1,
    attempts: config.attempts ?? 3,
    budgetMs: config.budgetMs ?? 120_000,
    signal,
  });
  const summary = {
    version: "artvenn-curation-metadata-roundtrip/v1",
    snapshotSha256,
    counts: deriveCurationMetadataCounts(payload),
    warnings: deriveCurationMetadataWarnings(payload),
    ...outcome,
    status: !execute
      ? "OFFLINE_VALIDATED"
      : outcome.succeeded === 1
        ? "PERSISTED_AND_READBACK_VERIFIED"
        : outcome.pending
          ? "PENDING"
          : "FAILED",
    independentMediaByteVerification: "NOT_RUN",
  };
  // The batch owns the durable input-bound journal. This content-free summary
  // is replaceable presentation and is never treated as commit evidence alone.
  if (execute) {
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const target = path.join(stateDirectory, `${snapshotSha256}.summary.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(summary)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
  }
  return summary;
}

async function main() {
  const args = {};
  const controller = new AbortController();
  const stop = () => {
    controller.abort();
    process.exitCode = 130;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    for (let i = 2; i < process.argv.length; i += 1) {
      const flag = process.argv[i];
      if (flag === "--execute") args.execute = true;
      else if (
        ["--metadata", "--config", "--state", "--previous-sha"].includes(
          flag,
        ) &&
        process.argv[i + 1]
      )
        args[flag.slice(2)] = process.argv[++i];
      else fail("ARGUMENTS_INVALID");
    }
    if (!args.metadata || !args.state || (args.execute && !args.config))
      fail("INPUT_REQUIRED");
    const summary = await metadataRoundtrip({
      metadataFile: args.metadata,
      configFile: args.config,
      stateDirectory: args.state,
      expectedPreviousSha256: args["previous-sha"] ?? null,
      execute: args.execute,
      signal: controller.signal,
    });
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    if (summary.failed || (args.execute && summary.pending))
      process.exitCode = 1;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  main().catch((error) => {
    const category =
      error?.code === "RECEIPT_LOCKED"
        ? "RECEIPT_LOCKED"
        : "CURATION_METADATA_ROUNDTRIP_FAILED";
    process.stdout.write(`${JSON.stringify({ status: "FAILED", category })}\n`);
    process.stderr.write("CURATION_METADATA_ROUNDTRIP_FAILED\n");
    process.exitCode = 1;
  });
