import console from "node:console";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

// These are the exact presentation differences accepted for #360. Every other
// source byte and every additional file must match the live pre-365 recipe.
export const presentationPaths = Object.freeze([
  "src/app/(main)/ArchiveShell.module.css",
  "src/app/(main)/ArchiveShell.test.tsx",
  "src/app/(main)/ArchiveShell.tsx",
  "src/app/Providers.tsx",
  "src/app/layout.tsx",
  "src/data/archive-navigation.json",
  "src/lib/archive-admin.ts",
  "src/lib/archive-theme.test.ts",
]);
const installRoots = new Set([
  "node_modules",
  "packages/api-client/node_modules",
  "packages/mcp/node_modules",
]);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = (code) => {
  throw new Error(code);
};
const safePath = (name) => {
  if (
    typeof name !== "string" ||
    !name ||
    name.includes("\\") ||
    name.includes("\0") ||
    path.posix.isAbsolute(name) ||
    path.posix.normalize(name) !== name ||
    name.split("/").some((part) => part === "." || part === ".." || !part)
  )
    fail("COMPAT_INVENTORY_PATH_INVALID");
  return name;
};
export function parseProtectedInventory(text) {
  const files = new Map();
  for (const line of text.split("\n")) {
    if (!line) continue;
    const match = /^([a-f0-9]{64}) {2}(.+)$/u.exec(line);
    if (!match) fail("COMPAT_INVENTORY_FORMAT_INVALID");
    const name = safePath(match[2]);
    if (files.has(name)) fail("COMPAT_INVENTORY_DUPLICATE");
    if (
      presentationPaths.includes(name) ||
      [...installRoots].some(
        (root) => name === root || name.startsWith(`${root}/`),
      )
    )
      fail("COMPAT_INVENTORY_SCOPE_INVALID");
    files.set(name, match[1]);
  }
  if (!files.size) fail("COMPAT_INVENTORY_EMPTY");
  return files;
}
export async function verifyProtectedSource({ root, inventoryText, metadata }) {
  if (
    metadata?.version !== 1 ||
    metadata.id !== "ui-pre365-v1" ||
    digest(inventoryText) !== metadata.protectedInventorySha256
  )
    fail("COMPAT_INVENTORY_IDENTITY_INVALID");
  const expected = parseProtectedInventory(inventoryText);
  if (expected.size !== metadata.protectedFileCount)
    fail("COMPAT_INVENTORY_COUNT_INVALID");
  const presentation = metadata.presentationFiles ?? {};
  if (
    JSON.stringify(Object.keys(presentation).sort()) !==
    JSON.stringify([...presentationPaths].sort())
  )
    fail("COMPAT_PRESENTATION_SCOPE_INVALID");
  for (const [name, hash] of Object.entries(presentation)) {
    if (!/^[a-f0-9]{64}$/u.test(hash)) fail("COMPAT_PRESENTATION_HASH_INVALID");
    expected.set(name, hash);
  }
  const rootState = await lstat(root);
  if (!rootState.isDirectory() || rootState.isSymbolicLink())
    fail("COMPAT_SOURCE_ROOT_INVALID");
  const actual = new Set();
  const visit = async (directory, relative = "") => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) fail("COMPAT_SOURCE_SYMLINK_REJECTED");
      if (installRoots.has(name)) {
        if (!entry.isDirectory()) fail("COMPAT_INSTALL_ROOT_INVALID");
        continue;
      }
      if (entry.isDirectory()) await visit(file, name);
      else if (entry.isFile()) {
        if (!expected.has(name)) fail("COMPAT_SOURCE_EXTRA_FILE");
        if (digest(await readFile(file)) !== expected.get(name))
          fail("COMPAT_SOURCE_HASH_MISMATCH");
        actual.add(name);
      } else fail("COMPAT_SOURCE_SPECIAL_FILE_REJECTED");
    }
  };
  await visit(root);
  if (actual.size !== expected.size) fail("COMPAT_SOURCE_MISSING_FILE");
  const dependencies = metadata.dependencyFiles ?? {};
  if (!Object.keys(dependencies).length)
    fail("COMPAT_DEPENDENCY_PROOF_REQUIRED");
  for (const [name, hash] of Object.entries(dependencies)) {
    safePath(name);
    if (
      !name.startsWith("node_modules/.pnpm/") ||
      !/^[a-f0-9]{64}$/u.test(hash)
    )
      fail("COMPAT_DEPENDENCY_SCOPE_INVALID");
    const parts = name.split("/");
    let ancestor = root;
    for (const part of parts.slice(0, -1)) {
      ancestor = path.join(ancestor, part);
      const state = await lstat(ancestor);
      if (!state.isDirectory() || state.isSymbolicLink())
        fail("COMPAT_DEPENDENCY_SYMLINK_REJECTED");
    }
    const file = path.join(root, name);
    const state = await lstat(file);
    if (
      !state.isFile() ||
      state.isSymbolicLink() ||
      digest(await readFile(file)) !== hash
    )
      fail("COMPAT_DEPENDENCY_HASH_MISMATCH");
  }
  return {
    status: "PASS",
    policy: metadata.id,
    protectedFiles: metadata.protectedFileCount,
    presentationFiles: Object.keys(presentation).length,
    dependencyFiles: Object.keys(dependencies).length,
    protectedInventorySha256: metadata.protectedInventorySha256,
    phase: "before-build",
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const { values } = parseArgs({
      options: {
        root: { type: "string" },
        metadata: { type: "string" },
        inventory: { type: "string" },
      },
      allowPositionals: false,
    });
    if (
      ![values.root, values.metadata, values.inventory].every(
        (value) => typeof value === "string" && path.isAbsolute(value),
      )
    )
      fail("COMPAT_EXPLICIT_PATHS_REQUIRED");
    const metadata = JSON.parse(await readFile(values.metadata, "utf8"));
    const inventoryText = await readFile(values.inventory, "utf8");
    console.info(
      JSON.stringify(
        await verifyProtectedSource({
          root: values.root,
          inventoryText,
          metadata,
        }),
      ),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        ok: false,
        code: /^COMPAT_[A-Z_]+$/u.test(error.message)
          ? error.message
          : "COMPAT_SOURCE_VERIFICATION_FAILED",
      }),
    );
    process.exitCode = 1;
  }
}
