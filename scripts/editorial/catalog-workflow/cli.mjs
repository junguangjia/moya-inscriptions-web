import process from "node:process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { privateJSON } from "../../curation/adapter.mjs";
import { withOfflineCheckpointStore } from "./checkpoint-store.mjs";
import { digest, fail, targetIdentity, validateManifest } from "./identity.mjs";

/** Offline inspection and an explicitly authorized, separately bound CMS HTTPS entry. */
export async function runCommand(argv) {
  const [command, ...args] = argv;
  if (["run", "publish", "withdraw", "upload"].includes(command)) {
    // Incomplete old invocations still fail before any file/provider read.
    if (!args.includes("--authority") || !args.includes("--credential-file"))
      fail("LIVE_ADAPTER_NOT_BOUND");
    const { runProductionCommand } = await import("./production-cli.mjs");
    return runProductionCommand(command, args);
  }
  if (!["freeze", "inspect"].includes(command) || args.length !== 4)
    fail("CLI_ARGUMENTS_INVALID");
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (
      !["--manifest", "--state-dir"].includes(args[i]) ||
      Object.hasOwn(options, args[i]) ||
      !path.isAbsolute(args[i + 1])
    )
      fail("CLI_ARGUMENTS_INVALID");
    options[args[i]] = args[i + 1];
  }
  if (!options["--manifest"] || !options["--state-dir"])
    fail("CLI_ARGUMENTS_INVALID");
  const manifest = validateManifest(
    await privateJSON(options["--manifest"], 16 * 1024 * 1024),
  );
  return withOfflineCheckpointStore(
    options["--state-dir"],
    manifest,
    async ({ checkpoint, inputMatches, persist }) => {
      if (command === "freeze" && inputMatches) await persist(checkpoint);
      return {
        executionKind: "offline-fake",
        liveE2E: false,
        command,
        status: inputMatches ? "OFFLINE_INPUT_VALIDATED" : "HOLD",
        code: inputMatches ? null : "CHECKPOINT_INPUT_CHANGED",
        manifestSha256: digest(manifest),
        targetIdentity: targetIdentity(manifest),
        networkRequests: 0,
        binaryBodyBytes: 0,
        records: Object.entries(checkpoint.records).map(
          ([recordId, state]) => ({
            recordId,
            state: state.state,
            code: state.code,
          }),
        ),
      };
    },
  );
}

export function commandFailure(command, error) {
  const code = new Set([
    "LIVE_ADAPTER_NOT_BOUND",
    "CLI_ARGUMENTS_INVALID",
    "CHECKPOINT_STORE_LOCKED",
    "CHECKPOINT_STORE_LOCK_CHANGED",
    "CHECKPOINT_SCOPE_MISMATCH",
    "CHECKPOINT_INVALID",
    "CHECKPOINT_ACTION_INVALID",
  ]).has(error.code)
    ? error.code
    : /^[A-Z0-9_]{1,100}$/.test(error.code ?? "")
      ? error.code
      : "WORKFLOW_INPUT_REJECTED";
  return {
    status: "HOLD",
    code,
    liveE2E: false,
    networkRequests: ["run", "upload", "publish", "withdraw"].includes(command)
      ? null
      : 0,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    const result = await runCommand(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status === "HOLD") process.exitCode = 1;
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify(commandFailure(process.argv[2], error))}\n`,
    );
    process.exitCode = 1;
  }
}
