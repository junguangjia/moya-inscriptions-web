import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { readMasterHeader } from "./header.js";

/*
 * The Owner-reviewed approval document of the `catalog-master` command
 * (catalog-deep-zoom-v1), after the pilot-CLI precedent: one entry per
 * approved Catalog image, naming the SHA-256 of the approved image and of its
 * master file. `attach` refuses any byte that differs. `manifest` drafts the
 * document on the Owner's Mac from the curation lineage (approved image hash
 * → original hash) and the originals directory; the Owner may also write it
 * by hand (an `edited-export` master has no lineage pair).
 */

export const APPROVAL_KIND = "catalog-master-approval";

export interface ApprovalEntry {
  readonly mediaId: string;
  readonly approvedSha256: string;
  /** A plain file name inside the server inbox. */
  readonly masterFile: string;
  readonly masterSha256: string;
  readonly derivation: "submitted" | "edited-export";
  /** 1..8192; 8192 when absent. */
  readonly maxLongEdge?: number;
  /** Private basis of the rights declaration, at most 500 characters. */
  readonly note?: string;
}

export interface ApprovalDocument {
  readonly version: 1;
  readonly kind: typeof APPROVAL_KIND;
  readonly catalogId: string;
  readonly entries: readonly ApprovalEntry[];
}

const SHA256 = /^[0-9a-f]{64}$/u;
const MEDIA_ID = /^[^\s]{1,128}$/u;
const FILE_NAME = /^(?!\.{1,2}$)[^/\\\0]{1,255}$/u;
const ENTRY_KEYS = new Set([
  "mediaId",
  "approvedSha256",
  "masterFile",
  "masterSha256",
  "derivation",
  "maxLongEdge",
  "note",
]);

export class ApprovalDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalDocumentError";
  }
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Strict parse: unknown keys, duplicates and malformed values are refused. */
export function parseApprovalDocument(value: unknown): ApprovalDocument {
  if (
    !object(value) ||
    value.version !== 1 ||
    value.kind !== APPROVAL_KIND ||
    typeof value.catalogId !== "string" ||
    !MEDIA_ID.test(value.catalogId) ||
    !Array.isArray(value.entries) ||
    value.entries.length < 1 ||
    value.entries.length > 200 ||
    Object.keys(value).some(
      (key) => !["version", "kind", "catalogId", "entries"].includes(key),
    )
  )
    throw new ApprovalDocumentError("The approval document is malformed");
  const media = new Set<string>();
  const files = new Set<string>();
  const entries = value.entries.map((entry: unknown): ApprovalEntry => {
    if (
      !object(entry) ||
      Object.keys(entry).some((key) => !ENTRY_KEYS.has(key)) ||
      typeof entry.mediaId !== "string" ||
      !MEDIA_ID.test(entry.mediaId) ||
      typeof entry.approvedSha256 !== "string" ||
      !SHA256.test(entry.approvedSha256) ||
      typeof entry.masterFile !== "string" ||
      !FILE_NAME.test(entry.masterFile) ||
      typeof entry.masterSha256 !== "string" ||
      !SHA256.test(entry.masterSha256) ||
      (entry.derivation !== "submitted" &&
        entry.derivation !== "edited-export") ||
      (entry.maxLongEdge !== undefined &&
        (!Number.isSafeInteger(entry.maxLongEdge) ||
          (entry.maxLongEdge as number) < 1 ||
          (entry.maxLongEdge as number) > 8192)) ||
      (entry.note !== undefined &&
        (typeof entry.note !== "string" ||
          entry.note.length < 1 ||
          entry.note.length > 500 ||
          entry.note.trim() !== entry.note)) ||
      media.has(entry.mediaId) ||
      files.has(entry.masterFile)
    )
      throw new ApprovalDocumentError("An approval entry is malformed");
    media.add(entry.mediaId);
    files.add(entry.masterFile);
    return {
      mediaId: entry.mediaId,
      approvedSha256: entry.approvedSha256,
      masterFile: entry.masterFile,
      masterSha256: entry.masterSha256,
      derivation: entry.derivation,
      ...(entry.maxLongEdge === undefined
        ? {}
        : { maxLongEdge: entry.maxLongEdge as number }),
      ...(entry.note === undefined ? {} : { note: entry.note }),
    };
  });
  return {
    version: 1,
    kind: APPROVAL_KIND,
    catalogId: value.catalogId,
    entries,
  };
}

export async function readApprovalDocument(
  file: string,
): Promise<ApprovalDocument> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new ApprovalDocumentError("The approval document is not JSON");
  }
  return parseApprovalDocument(parsed);
}

/** SHA-256 of a whole file, streamed. */
export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file))
    hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Regular files under a directory (no symlinks), at most `limit`. */
async function regularFiles(root: string, limit: number): Promise<string[]> {
  const found: string[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 4) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(full, depth + 1);
      else if (entry.isFile()) {
        if (found.length >= limit)
          throw new ApprovalDocumentError("Too many files to pair");
        found.push(full);
      }
    }
  };
  await visit(root, 0);
  return found.sort();
}

export interface ManifestCandidate {
  readonly mediaId: string;
  readonly approvedSha256: string | null;
}

export interface ManifestResult {
  readonly document: ApprovalDocument | null;
  readonly paired: number;
  readonly unpaired: {
    readonly noApprovedHash: number;
    readonly noLineage: number;
    readonly noOriginal: number;
    readonly notJpegOrPng: number;
  };
}

/**
 * Pairs each candidate's approved-image hash with a curation lineage record
 * (`output_sha256` → `source_sha256`) and an original file of that hash, and
 * drafts the approval document (derivation `submitted`). Nothing is written.
 */
export async function draftApprovalDocument(options: {
  readonly catalogId: string;
  readonly candidates: readonly ManifestCandidate[];
  readonly lineageDirectory: string;
  readonly originalsDirectory: string;
}): Promise<ManifestResult> {
  const lineage = new Map<string, string>();
  for (const file of await regularFiles(options.lineageDirectory, 20_000)) {
    if (path.basename(file) !== "lineage.json") continue;
    try {
      const record = JSON.parse(await readFile(file, "utf8")) as unknown;
      if (
        object(record) &&
        typeof record.output_sha256 === "string" &&
        SHA256.test(record.output_sha256) &&
        typeof record.source_sha256 === "string" &&
        SHA256.test(record.source_sha256)
      )
        lineage.set(record.output_sha256, record.source_sha256);
    } catch {
      // An unreadable record pairs nothing.
    }
  }
  const originals = new Map<string, string>();
  for (const file of await regularFiles(options.originalsDirectory, 20_000)) {
    if ((await lstat(file)).isFile())
      originals.set(await sha256File(file), file);
  }
  const unpaired = {
    noApprovedHash: 0,
    noLineage: 0,
    noOriginal: 0,
    notJpegOrPng: 0,
  };
  const entries: ApprovalEntry[] = [];
  const names = new Set<string>();
  for (const candidate of options.candidates) {
    if (candidate.approvedSha256 === null) {
      unpaired.noApprovedHash += 1;
      continue;
    }
    const source = lineage.get(candidate.approvedSha256);
    if (source === undefined) {
      unpaired.noLineage += 1;
      continue;
    }
    const file = originals.get(source);
    if (file === undefined) {
      unpaired.noOriginal += 1;
      continue;
    }
    try {
      await readMasterHeader(file);
    } catch {
      unpaired.notJpegOrPng += 1;
      continue;
    }
    const name = path.basename(file);
    if (names.has(name))
      throw new ApprovalDocumentError(
        "Two paired originals share a file name; rename one first",
      );
    names.add(name);
    entries.push({
      mediaId: candidate.mediaId,
      approvedSha256: candidate.approvedSha256,
      masterFile: name,
      masterSha256: source,
      derivation: "submitted",
    });
  }
  return {
    document:
      entries.length === 0
        ? null
        : parseApprovalDocument({
            version: 1,
            kind: APPROVAL_KIND,
            catalogId: options.catalogId,
            entries,
          }),
    paired: entries.length,
    unpaired,
  };
}
