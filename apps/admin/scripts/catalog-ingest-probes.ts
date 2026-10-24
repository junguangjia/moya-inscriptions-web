import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import path from "node:path";
import {
  createProbeTransport,
  runIngestProbes,
  type ProbeLifecycle,
} from "../src/media/ingest-probes";
import { createCosIngestProbeStorage } from "../src/media/ingest-storage";
import { catalogIngestSettings } from "../src/runtime-settings";

// The Catalog ingest staging dry run (catalog-scale-v1 increment 2), Owner-run
// on the CVM before CMS_CATALOG_INGEST=on, with the Admin's protected
// configuration in the environment (the COS settings and
// CMS_CATALOG_INGEST_UPLOAD_ENDPOINT; the switch may stay off):
//
//   pnpm --filter admin exec payload run scripts/catalog-ingest-probes.ts -- \
//     --lifecycle L1 --out <new private file> [--keep-source]
//
// --keep-source leaves the signed-put object for the Owner's GetObjectTagging
// (the L1 check the Admin's identity is not granted); delete it afterwards.
// It writes synthetic objects under catalog-ingest/v1/ only and deletes them.
// The full report goes only to the new owner-only (0600) file; standard output
// carries the verdicts, the failed probe ids and the report's SHA-256. No URL,
// key, header value or credential is printed or written.
const refused = (code: string): never => {
  throw Object.assign(new Error(code), { code });
};
async function main() {
  const argv = process.argv.slice(2);
  const flags: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]!;
    if (name === "--keep-source" && flags["keep-source"] === undefined) {
      flags["keep-source"] = "yes";
      continue;
    }
    const value = argv[++index];
    if (
      (name !== "--lifecycle" && name !== "--out") ||
      value === undefined ||
      flags[name.slice(2)] !== undefined
    )
      refused("ARGUMENTS_INVALID");
    flags[name.slice(2)] = value!;
  }
  const lifecycle = flags.lifecycle;
  if ((lifecycle !== "L1" && lifecycle !== "L2") || !flags.out)
    refused("ARGUMENTS_INVALID");
  let settings: ReturnType<typeof catalogIngestSettings>;
  try {
    settings = catalogIngestSettings(process.env);
  } catch {
    return refused("SETTINGS_INVALID");
  }
  const { storage } = settings;
  if (storage.mode !== "cos") return refused("COS_STORAGE_REQUIRED");
  // A new private file before any request, so a run never ends unrecorded.
  let output;
  try {
    output = await open(path.resolve(flags.out!), "wx", 0o600);
  } catch {
    return refused("OUTPUT_EXISTS_OR_UNWRITABLE");
  }
  try {
    const report = await runIngestProbes({
      lifecycle: lifecycle as ProbeLifecycle,
      storage: createCosIngestProbeStorage({
        endpoint: storage.endpoint,
        uploadEndpoint: settings.uploadEndpoint,
        region: storage.region,
        bucket: storage.bucket,
        accessKeyId: storage.accessKeyId,
        secretAccessKey: storage.secretAccessKey,
      }),
      transport: createProbeTransport(),
      fetchImpl: fetch,
      keepSource: flags["keep-source"] === "yes",
    });
    const text = `${JSON.stringify(report, null, 2)}\n`;
    await output.writeFile(text, "utf8");
    await output.sync();
    console.info(
      JSON.stringify(
        {
          lifecycle: report.lifecycle,
          verdict: report.verdict,
          failed: report.failed,
          ownerChecks: report.ownerChecks,
          written: true,
          sha256: createHash("sha256").update(text).digest("hex"),
        },
        null,
        2,
      ),
    );
    if (report.failed.length) refused("PROBES_FAILED");
  } finally {
    await output.close();
  }
}
// Provider and driver errors can carry request details; never print one or
// attach it as a cause. Payload run exits zero after a fulfilled module, so
// only the fixed category reaches its CLI error boundary.
let failure: string | undefined;
try {
  await main();
} catch (error) {
  const code = (error as { code?: unknown } | null)?.code;
  failure =
    typeof code === "string" && /^[A-Z][A-Z_]{2,40}$/.test(code)
      ? code
      : "PROBE_RUN_FAILED";
}
if (failure !== undefined)
  throw new Error(`CATALOG_INGEST_PROBES_REFUSED ${failure}`);
