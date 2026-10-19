import { createReadStream } from "node:fs";
import { lstat, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";


import {
  ApprovalDocumentError,
  draftApprovalDocument,
  readApprovalDocument,
  sha256File,
} from "./approval.js";
import { MasterHeaderError, readMasterHeader } from "./header.js";

import type { ApprovalDocument, ApprovalEntry } from "./approval.js";

/*
 * The commands of `catalog-master` (catalog-deep-zoom-v1), run by the Owner
 * on the server with the media worker's environment (Development: by agents
 * against local data only). Output is one content-free JSON line per result:
 * ids, sizes, counts and codes, never a path, key, file name or title.
 */

/** Mirror of `CatalogMasterStorage` in `@moya/api`. */
export interface CatalogMasterStorage {
  readonly taskBytes: number;
  readonly sliceBytes: number;
  readonly attachBytes: number;
  readonly sliceCap: number;
  readonly taskCap: number;
}

type Refused = {
  readonly status: "refused";
  readonly code: string;
  readonly storage?: CatalogMasterStorage;
};
type Result<T> = ({ readonly status: "done" } & T) | Refused;
interface Attached {
  readonly masterId: string | null;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly cells: number;
  readonly storage: CatalogMasterStorage;
}

/**
 * Structural mirror of `CatalogDisplayMasterPort` in `@moya/api` (this
 * package depends on the store, not on the application package).
 */
export interface CatalogMasterPort {
  listCandidates(catalogId: string): Promise<readonly object[]>;
  attach(
    input: {
      readonly mediaId: string;
      readonly approvedSha256: string;
      readonly masterSha256: string;
      readonly header: {
        readonly contentType: "image/jpeg" | "image/png";
        readonly width: number;
        readonly height: number;
      };
      readonly derivation: "submitted" | "edited-export";
      readonly maxLongEdge: number;
      readonly note: string | null;
      readonly operator: string;
      readonly source:
        | {
            readonly kind: "upload";
            readonly storageKey: string;
            readonly byteSize: number;
          }
        | {
            readonly kind: "existing";
            readonly masterId: string;
            readonly dryRun?: boolean;
          }
        | { readonly kind: "dry_run"; readonly byteSize: number };
    },
    now: Date,
  ): Promise<Result<Attached>>;
  setLimit(
    mediaId: string,
    maxLongEdge: number,
    operator: string,
    now: Date,
  ): Promise<Result<Attached>>;
  detach(
    target: { readonly mediaId: string } | { readonly all: true },
    now: Date,
  ): Promise<Result<{ readonly ended: number }>>;
  erase(
    masterId: string,
    now: Date,
  ): Promise<Result<{ readonly byteSize: number }>>;
  requeue(mediaId: string, now: Date): Promise<Result<{ readonly jobs: number }>>;
  status(catalogId: string | null): Promise<{
    readonly masters: readonly object[];
    readonly heldWithoutActive: readonly object[];
    readonly storage: object;
  }>;
  guardCounts(): Promise<{
    readonly blockPublications: number;
    readonly blockRenditions: number;
    readonly blockJobs: number;
  }>;
}

/** A master file is at most this large and has at most this many pixels. */
export const CATALOG_MASTER_MAX_BYTES = 128 * 1024 ** 2;
export const CATALOG_MASTER_MAX_PIXELS = 120_000_000;
/** Owner label the publishing store sees for master writes (never recorded). */
export const CATALOG_MASTER_STORE_OWNER = "catalog";

/** The private store the master bytes go to (the UGC store in Production). */
export interface CatalogMasterStore {
  writeStream(
    ownerId: string,
    purpose: "original",
    contentType: "image/jpeg" | "image/png",
    maxBytes: number,
    source: AsyncIterable<Uint8Array>,
    options?: { readonly requireExactSize?: boolean },
  ): Promise<{ storageKey: string; byteSize: number; sha256: string }>;
  remove(storageKey: string): Promise<void>;
}

export interface CatalogMasterContext {
  readonly port: CatalogMasterPort;
  /** Opened only by commands that write master bytes. */
  readonly store: () => Promise<CatalogMasterStore>;
  readonly out: (line: Record<string, unknown>) => void;
  readonly now: () => Date;
}

export class CatalogMasterUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogMasterUsageError";
  }
}

export const CATALOG_MASTER_USAGE = `Usage: catalog-master <command> [options]
  candidates --catalog <id>
  manifest --catalog <id> --candidates <file> --lineage <dir> --originals <dir> --out <file>
  attach --media <id> --approval <file> (--inbox <dir> | --existing-master <id>) [--dry-run] [--operator <label>]
  attach-batch --approval <file> --inbox <dir> [--dry-run] [--operator <label>]
  status [--catalog <id>]
  requeue --media <id>
  set-limit --media <id> --max-long-edge <N> [--operator <label>]
  detach (--media <id> | --all)
  erase --master <id>
  guard`;

const FLAGS = new Set(["--dry-run", "--all"]);
const OPTIONS: Readonly<Record<string, readonly string[]>> = {
  candidates: ["--catalog"],
  manifest: ["--catalog", "--candidates", "--lineage", "--originals", "--out"],
  attach: [
    "--media",
    "--approval",
    "--inbox",
    "--existing-master",
    "--dry-run",
    "--operator",
  ],
  "attach-batch": ["--approval", "--inbox", "--dry-run", "--operator"],
  status: ["--catalog"],
  requeue: ["--media"],
  "set-limit": ["--media", "--max-long-edge", "--operator"],
  detach: ["--media", "--all"],
  erase: ["--master"],
  guard: [],
};

export interface ParsedCommand {
  readonly command: string;
  readonly options: ReadonlyMap<string, string | true>;
}

/** Strict argument parsing: unknown commands and options are usage errors. */
export function parseCatalogMasterArguments(
  argv: readonly string[],
): ParsedCommand {
  const [command, ...rest] = argv;
  const allowed = command === undefined ? undefined : OPTIONS[command];
  if (command === undefined || allowed === undefined)
    throw new CatalogMasterUsageError(CATALOG_MASTER_USAGE);
  const options = new Map<string, string | true>();
  for (let index = 0; index < rest.length; index += 1) {
    const name = rest[index]!;
    if (!allowed.includes(name) || options.has(name))
      throw new CatalogMasterUsageError(CATALOG_MASTER_USAGE);
    if (FLAGS.has(name)) {
      options.set(name, true);
      continue;
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw new CatalogMasterUsageError(CATALOG_MASTER_USAGE);
    options.set(name, value);
    index += 1;
  }
  return { command, options };
}

const required = (parsed: ParsedCommand, name: string): string => {
  const value = parsed.options.get(name);
  if (typeof value !== "string")
    throw new CatalogMasterUsageError(CATALOG_MASTER_USAGE);
  return value;
};
const optional = (parsed: ParsedCommand, name: string): string | undefined => {
  const value = parsed.options.get(name);
  return typeof value === "string" ? value : undefined;
};
const operatorOf = (parsed: ParsedCommand): string => {
  const value = optional(parsed, "--operator") ?? "owner";
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(value))
    throw new CatalogMasterUsageError("--operator is a lowercase label");
  return value;
};

const storageLine = (storage: CatalogMasterStorage | undefined) =>
  storage === undefined
    ? {}
    : {
        taskBytes: storage.taskBytes,
        sliceBytes: storage.sliceBytes,
        attachBytes: storage.attachBytes,
        sliceCap: storage.sliceCap,
        taskCap: storage.taskCap,
      };

/** The inbox must be a private directory (no group or other access). */
const assertPrivateInbox = async (inbox: string): Promise<void> => {
  const info = await stat(inbox).catch(() => null);
  if (info === null || !info.isDirectory() || (info.mode & 0o077) !== 0)
    throw new CatalogMasterUsageError(
      "--inbox must be an existing private (0700) directory",
    );
};

type EntryOutcome = "attached" | "dry_run" | "refused" | "storage_refused";

async function attachEntry(
  context: CatalogMasterContext,
  entry: ApprovalEntry,
  source: { readonly inbox: string } | { readonly masterId: string },
  dryRun: boolean,
  operator: string,
): Promise<EntryOutcome> {
  const base = { command: "attach", mediaId: entry.mediaId };
  const refuse = (code: string, storage?: CatalogMasterStorage) => {
    context.out({ ...base, status: "refused", code, ...storageLine(storage) });
    return code.startsWith("storage_") ? "storage_refused" : "refused";
  };
  const common = {
    mediaId: entry.mediaId,
    approvedSha256: entry.approvedSha256,
    masterSha256: entry.masterSha256,
    derivation: entry.derivation,
    maxLongEdge: entry.maxLongEdge ?? 8192,
    note: entry.note ?? null,
    operator,
  } as const;
  if ("masterId" in source) {
    const result = await context.port.attach(
      {
        ...common,
        // The store reads the oriented size and type of the held master.
        header: { contentType: "image/jpeg", width: 1, height: 1 },
        source: { kind: "existing", masterId: source.masterId, dryRun },
      },
      context.now(),
    );
    if (result.status === "refused") return refuse(result.code, result.storage);
    context.out({
      ...base,
      status: dryRun ? "dry_run" : "attached",
      masterId: result.masterId,
      reattached: true,
      frameWidth: result.frameWidth,
      frameHeight: result.frameHeight,
      cells: result.cells,
      ...storageLine(result.storage),
    });
    return dryRun ? "dry_run" : "attached";
  }
  const file = path.join(source.inbox, entry.masterFile);
  const info = await lstat(file).catch(() => null);
  if (info === null || !info.isFile()) return refuse("master_missing");
  if (info.size < 1 || info.size > CATALOG_MASTER_MAX_BYTES)
    return refuse("master_too_large");
  let header;
  try {
    header = await readMasterHeader(file);
  } catch (error) {
    if (error instanceof MasterHeaderError) return refuse(error.code);
    throw error;
  }
  if (header.width * header.height > CATALOG_MASTER_MAX_PIXELS)
    return refuse("master_too_large");
  if ((await sha256File(file)) !== entry.masterSha256)
    return refuse("master_mismatch");
  const checked = await context.port.attach(
    { ...common, header, source: { kind: "dry_run", byteSize: info.size } },
    context.now(),
  );
  if (checked.status === "refused") return refuse(checked.code, checked.storage);
  if (dryRun) {
    context.out({
      ...base,
      status: "dry_run",
      masterId: null,
      frameWidth: checked.frameWidth,
      frameHeight: checked.frameHeight,
      cells: checked.cells,
      ...storageLine(checked.storage),
    });
    return "dry_run";
  }
  const store = await context.store();
  const stored = await store.writeStream(
    CATALOG_MASTER_STORE_OWNER,
    "original",
    header.contentType,
    info.size,
    createReadStream(file),
    { requireExactSize: true },
  );
  if (stored.sha256 !== entry.masterSha256 || stored.byteSize !== info.size) {
    await store.remove(stored.storageKey).catch(() => undefined);
    return refuse("master_mismatch");
  }
  let result;
  try {
    result = await context.port.attach(
      {
        ...common,
        header,
        source: {
          kind: "upload",
          storageKey: stored.storageKey,
          byteSize: stored.byteSize,
        },
      },
      context.now(),
    );
  } catch (error) {
    await store.remove(stored.storageKey).catch(() => undefined);
    throw error;
  }
  if (result.status === "refused") {
    await store.remove(stored.storageKey).catch(() => undefined);
    return refuse(result.code, result.storage);
  }
  context.out({
    ...base,
    status: "attached",
    masterId: result.masterId,
    frameWidth: result.frameWidth,
    frameHeight: result.frameHeight,
    cells: result.cells,
    ...storageLine(result.storage),
  });
  return "attached";
}

const entryOf = (document: ApprovalDocument, mediaId: string): ApprovalEntry => {
  const entry = document.entries.find((item) => item.mediaId === mediaId);
  if (entry === undefined)
    throw new ApprovalDocumentError("The approval document has no such image");
  return entry;
};

/** Runs one command; returns false when any result was refused. */
export async function runCatalogMasterCommand(
  parsed: ParsedCommand,
  context: CatalogMasterContext,
): Promise<boolean> {
  switch (parsed.command) {
    case "candidates": {
      const rows = await context.port.listCandidates(required(parsed, "--catalog"));
      for (const row of rows) context.out({ command: "candidates", ...row });
      return true;
    }
    case "attach": {
      const document = await readApprovalDocument(required(parsed, "--approval"));
      const entry = entryOf(document, required(parsed, "--media"));
      const existing = optional(parsed, "--existing-master");
      const inbox = optional(parsed, "--inbox");
      if ((existing === undefined) === (inbox === undefined))
        throw new CatalogMasterUsageError(CATALOG_MASTER_USAGE);
      if (inbox !== undefined) await assertPrivateInbox(inbox);
      const outcome = await attachEntry(
        context,
        entry,
        existing !== undefined ? { masterId: existing } : { inbox: inbox! },
        parsed.options.has("--dry-run"),
        operatorOf(parsed),
      );
      return outcome === "attached" || outcome === "dry_run";
    }
    case "attach-batch": {
      const document = await readApprovalDocument(required(parsed, "--approval"));
      const inbox = required(parsed, "--inbox");
      await assertPrivateInbox(inbox);
      const operator = operatorOf(parsed);
      let ok = true;
      for (const entry of document.entries) {
        const outcome = await attachEntry(
          context,
          entry,
          { inbox },
          parsed.options.has("--dry-run"),
          operator,
        );
        if (outcome === "refused") ok = false;
        // A storage bound refuses every later attach too: stop here.
        if (outcome === "storage_refused") return false;
      }
      return ok;
    }
    case "status": {
      const status = await context.port.status(optional(parsed, "--catalog") ?? null);
      for (const row of status.masters) context.out({ command: "status", ...row });
      for (const row of status.heldWithoutActive)
        context.out({ command: "status", held: true, ...row });
      context.out({ command: "status", storage: status.storage });
      return true;
    }
    case "requeue": {
      const result = await context.port.requeue(required(parsed, "--media"), context.now());
      context.out(
        result.status === "done"
          ? { command: "requeue", status: "queued", jobs: result.jobs }
          : { command: "requeue", status: "refused", code: result.code },
      );
      return result.status === "done";
    }
    case "set-limit": {
      const limit = Number(required(parsed, "--max-long-edge"));
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8192)
        throw new CatalogMasterUsageError("--max-long-edge is 1..8192");
      const result = await context.port.setLimit(
        required(parsed, "--media"),
        limit,
        operatorOf(parsed),
        context.now(),
      );
      context.out(
        result.status === "done"
          ? {
              command: "set-limit",
              status: "limited",
              masterId: result.masterId,
              frameWidth: result.frameWidth,
              frameHeight: result.frameHeight,
              cells: result.cells,
              ...storageLine(result.storage),
            }
          : {
              command: "set-limit",
              status: "refused",
              code: result.code,
              ...storageLine(result.storage),
            },
      );
      return result.status === "done";
    }
    case "detach": {
      const media = optional(parsed, "--media");
      if ((media === undefined) === !parsed.options.has("--all"))
        throw new CatalogMasterUsageError(CATALOG_MASTER_USAGE);
      const result = await context.port.detach(
        media === undefined ? { all: true } : { mediaId: media },
        context.now(),
      );
      context.out(
        result.status === "done"
          ? { command: "detach", status: "detached", ended: result.ended }
          : { command: "detach", status: "refused", code: result.code },
      );
      return result.status === "done";
    }
    case "erase": {
      const result = await context.port.erase(required(parsed, "--master"), context.now());
      context.out(
        result.status === "done"
          ? { command: "erase", status: "erased", byteSize: result.byteSize }
          : { command: "erase", status: "refused", code: result.code },
      );
      return result.status === "done";
    }
    case "guard": {
      context.out({ command: "guard", ...(await context.port.guardCounts()) });
      return true;
    }
    default:
      throw new CatalogMasterUsageError(CATALOG_MASTER_USAGE);
  }
}

/**
 * `manifest`, on the Owner's Mac (no database): drafts the approval document
 * from the `candidates` output, the curation lineage and the originals, and
 * writes it (mode 0600) for the Owner's review.
 */
export async function runCatalogMasterManifest(
  parsed: ParsedCommand,
  out: (line: Record<string, unknown>) => void,
): Promise<boolean> {
  const candidates = (await readFile(required(parsed, "--candidates"), "utf8"))
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const row = JSON.parse(line) as Record<string, unknown>;
      if (
        typeof row.mediaId !== "string" ||
        !(row.approvedSha256 === null || typeof row.approvedSha256 === "string")
      )
        throw new ApprovalDocumentError("A candidates line is malformed");
      return {
        mediaId: row.mediaId,
        approvedSha256: row.approvedSha256 as string | null,
      };
    });
  const result = await draftApprovalDocument({
    catalogId: required(parsed, "--catalog"),
    candidates,
    lineageDirectory: required(parsed, "--lineage"),
    originalsDirectory: required(parsed, "--originals"),
  });
  // The document names the Owner's files: it goes to a private file only.
  const target = required(parsed, "--out");
  if (result.document !== null)
    await writeFile(target, JSON.stringify(result.document, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
  out({
    command: "manifest",
    paired: result.paired,
    ...result.unpaired,
    written: result.document !== null,
  });
  return result.document !== null;
}
