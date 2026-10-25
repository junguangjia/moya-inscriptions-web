import { Buffer } from "node:buffer";
import process from "node:process";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const { values } = parseArgs({
  options: { output: { type: "string" } },
  allowPositionals: false,
});
if (!values.output || !isAbsolute(values.output))
  throw new Error("An absolute new output directory is required");
const output = resolve(values.output);
const within = relative(root, output);
if (
  existsSync(output) ||
  !within.startsWith("../") ||
  realpathSync(dirname(output)) !== dirname(output)
)
  throw new Error(
    "Output must be new, outside the worktree, with an existing real parent",
  );

const sourceFiles = [
  [
    "runtime-bundle/cos-signature.mjs",
    "services/backend-production/dist/storage/cos-signature.js",
  ],
  [
    "runtime-bundle/cos-https.mjs",
    "services/backend-production/dist/storage/cos-https.js",
  ],
  [
    "runtime-bundle/summarize-traffic.mjs",
    "scripts/analytics/summarize-traffic.mjs",
  ],
];
const files = new Map();
let entry = readFileSync(
  join(root, "scripts/operations/archive-runtime-data.mjs"),
  "utf8",
);
for (const [original, replacement] of [
  [
    "../../services/backend-production/dist/storage/cos-signature.js",
    "./runtime-bundle/cos-signature.mjs",
  ],
  [
    "../../services/backend-production/dist/storage/cos-https.js",
    "./runtime-bundle/cos-https.mjs",
  ],
  [
    "../analytics/summarize-traffic.mjs",
    "./runtime-bundle/summarize-traffic.mjs",
  ],
]) {
  const pattern = new RegExp(
    "([\"'])" + original.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\1",
    "g",
  );
  if ([...entry.matchAll(pattern)].length !== 1)
    throw new Error("Runtime import layout changed; review before packaging");
  entry = entry.replace(pattern, JSON.stringify(replacement));
}
files.set("ops_archive.mjs", Buffer.from(entry));
const provenance = [];
for (const [name, source] of sourceFiles) {
  const body = readFileSync(join(root, source));
  if (body.length > 1024 * 1024)
    throw new Error("Unexpected runtime helper size");
  files.set(name, body);
  provenance.push({
    source,
    runtime: name,
    bytes: body.length,
    sha256: sha(body),
  });
}
const baseHead = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
  timeout: 3000,
}).trim();
files.set(
  "runtime-bundle/provenance.json",
  Buffer.from(
    JSON.stringify(
      {
        baseHead,
        scope: "exact working-tree bytes; not a deployment authorization",
        files: provenance,
      },
      null,
      2,
    ) + "\n",
  ),
);
for (const name of ["yoyi-ops-archive.service", "yoyi-ops-archive.timer"])
  files.set(
    "deployment/" + name,
    readFileSync(join(root, "infra/production/systemd", name)),
  );
files.set(
  "OPS-ARCHIVE.md",
  readFileSync(join(root, "docs/deployment/runtime-data-storage.md")),
);
const manifest = {
  format: "artvenn-ops-archive-source-bundle-v1",
  baseHead,
  sourceDeletion: false,
  files: Object.fromEntries(
    [...files].map(([name, body]) => [
      name,
      { bytes: body.length, sha256: sha(body) },
    ]),
  ),
};
mkdirSync(output, { mode: 0o700 });
for (const [name, body] of files) {
  const path = join(output, name);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, body, { flag: "wx", mode: 0o600 });
}
writeFileSync(
  join(output, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
  { flag: "wx", mode: 0o600 },
);
process.stdout.write(
  JSON.stringify({
    status: "BUNDLE_READY",
    output,
    files: files.size,
    manifestSha256: sha(readFileSync(join(output, "manifest.json"))),
    sourceDeletion: false,
  }) + "\n",
);
