import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  APPROVAL_KIND,
  ApprovalDocumentError,
  CatalogMasterUsageError,
  MasterHeaderError,
  draftApprovalDocument,
  openCatalogMasterSource,
  parseApprovalDocument,
  parseCatalogMasterArguments,
  parseMasterHeader,
  runCatalogMasterCommand,
  runCatalogMasterManifest,
} from "@moya/backend-production/internal/catalog-master";
import {
  CatalogSourceError,
  CosCatalogSourceReader,
  LocalCatalogSourceReader,
} from "@moya/backend-production/internal/catalog-source";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CatalogMasterContext,
  CatalogMasterPort,
  CatalogMasterStore,
} from "@moya/backend-production/internal/catalog-master";
import type { CatalogSourceReader } from "@moya/backend-production/internal/catalog-source";

/*
 * catalog-deep-zoom-v1 (Issue #295) criterion 1, command side: the header
 * probe of a master file (format, bit depth, alpha, EXIF orientation), the
 * strict approval document, the manifest draft from lineage and originals,
 * and the attach flow (dry-run first, SHA-256 against the approval document,
 * upload only after the store's checks, the upload removed on a refusal,
 * content-free output). Synthetic header bytes; no database or cloud.
 */

const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const be16 = (value: number) => [(value >> 8) & 0xff, value & 0xff];
const be32 = (value: number) => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
];

/** A JPEG header: SOI, optional EXIF orientation, SOFn, SOS and a few bytes. */
const jpeg = (
  width: number,
  height: number,
  options: {
    readonly sof?: number;
    readonly precision?: number;
    readonly components?: number;
    readonly orientation?: number;
  } = {},
): Uint8Array => {
  const parts: number[] = [0xff, 0xd8];
  if (options.orientation !== undefined) {
    // Big-endian TIFF with one IFD0 entry: Orientation (SHORT).
    const tiff = [
      0x4d,
      0x4d,
      0x00,
      0x2a,
      ...be32(8),
      ...be16(1),
      ...be16(0x0112),
      ...be16(3),
      ...be32(1),
      ...be16(options.orientation),
      0,
      0,
      ...be32(0),
    ];
    const payload = [...Buffer.from("Exif\0\0", "binary"), ...tiff];
    parts.push(0xff, 0xe1, ...be16(payload.length + 2), ...payload);
  }
  const components = options.components ?? 3;
  const sof = [
    options.precision ?? 8,
    ...be16(height),
    ...be16(width),
    components,
    ...Array.from({ length: components * 3 }, () => 0x11),
  ];
  parts.push(0xff, options.sof ?? 0xc0, ...be16(sof.length + 2), ...sof);
  parts.push(0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0, 1, 2, 3);
  return Uint8Array.from(parts);
};

/** A PNG header: signature, IHDR, optional chunks, then IDAT and IEND. */
const png = (
  width: number,
  height: number,
  options: {
    readonly bitDepth?: number;
    readonly colorType?: number;
    readonly chunks?: readonly [string, number[]][];
  } = {},
): Uint8Array => {
  const chunk = (type: string, data: number[]) => [
    ...be32(data.length),
    ...Buffer.from(type, "ascii"),
    ...data,
    0,
    0,
    0,
    0,
  ];
  return Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...chunk("IHDR", [
      ...be32(width),
      ...be32(height),
      options.bitDepth ?? 8,
      options.colorType ?? 2,
      0,
      0,
      0,
    ]),
    ...(options.chunks ?? []).flatMap(([type, data]) => chunk(type, data)),
    ...chunk("IDAT", [1, 2, 3]),
    ...chunk("IEND", []),
  ]);
};

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
const temporary = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "catalog-master-"));
  directories.push(directory);
  return directory;
};

describe("catalog-master header probe", () => {
  it("reads 8-bit JPEG and PNG sizes, swapping sides for EXIF orientation 5..8", () => {
    expect(parseMasterHeader(jpeg(6000, 4000))).toEqual({
      contentType: "image/jpeg",
      width: 6000,
      height: 4000,
    });
    expect(parseMasterHeader(jpeg(6000, 4000, { sof: 0xc2 }))).toMatchObject({
      width: 6000,
    });
    expect(parseMasterHeader(jpeg(6000, 4000, { orientation: 6 }))).toEqual({
      contentType: "image/jpeg",
      width: 4000,
      height: 6000,
    });
    expect(
      parseMasterHeader(jpeg(6000, 4000, { orientation: 3 })),
    ).toMatchObject({
      width: 6000,
      height: 4000,
    });
    expect(parseMasterHeader(png(4947, 9504))).toEqual({
      contentType: "image/png",
      width: 4947,
      height: 9504,
    });
  });

  it.each([
    [
      "a 12-bit JPEG",
      () => jpeg(10, 10, { precision: 12 }),
      "master_bit_depth",
    ],
    ["a CMYK JPEG", () => jpeg(10, 10, { components: 4 }), "master_format"],
    ["a lossless JPEG", () => jpeg(10, 10, { sof: 0xc3 }), "master_format"],
    ["a 16-bit PNG", () => png(10, 10, { bitDepth: 16 }), "master_bit_depth"],
    ["an RGBA PNG", () => png(10, 10, { colorType: 6 }), "master_has_alpha"],
    [
      "a grey-alpha PNG",
      () => png(10, 10, { colorType: 4 }),
      "master_has_alpha",
    ],
    ["a palette PNG", () => png(10, 10, { colorType: 3 }), "master_format"],
    [
      "a PNG with transparency",
      () => png(10, 10, { chunks: [["tRNS", [0, 0, 0, 0, 0, 0]]] }),
      "master_has_alpha",
    ],
    [
      "a TIFF",
      () => Uint8Array.from([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0]),
      "master_format",
    ],
    [
      "a truncated JPEG",
      () => jpeg(10, 10).subarray(0, 8),
      "master_unreadable",
    ],
  ])("refuses %s", (_label, bytes, code) => {
    expect(() => parseMasterHeader(bytes())).toThrow(MasterHeaderError);
    try {
      parseMasterHeader(bytes());
    } catch (error) {
      expect((error as MasterHeaderError).code).toBe(code);
    }
  });
});

const approved = "a".repeat(64);
const document = (
  masterSha256: string,
  extra: Record<string, unknown> = {},
) => ({
  version: 1,
  kind: APPROVAL_KIND,
  catalogId: "catalog-example",
  entries: [
    {
      mediaId: "media-1",
      approvedSha256: approved,
      masterFile: "master.jpg",
      masterSha256,
      derivation: "submitted",
      ...extra,
    },
  ],
});

describe("catalog-master approval document", () => {
  it("parses strictly", () => {
    expect(
      parseApprovalDocument(document("b".repeat(64), { maxLongEdge: 6000 }))
        .entries[0],
    ).toMatchObject({
      maxLongEdge: 6000,
    });
    for (const bad of [
      { ...document("b".repeat(64)), extra: true },
      document("B".repeat(64)),
      document("b".repeat(64), { masterFile: "../master.jpg" }),
      document("b".repeat(64), { masterFile: ".." }),
      document("b".repeat(64), { derivation: "raw" }),
      document("b".repeat(64), { maxLongEdge: 9000 }),
      document("b".repeat(64), { note: " padded " }),
      document("b".repeat(64), { unknown: 1 }),
      { ...document("b".repeat(64)), version: 2 },
    ])
      expect(() => parseApprovalDocument(bad)).toThrow(ApprovalDocumentError);
  });

  it("drafts entries from curation lineage and originals, counting what does not pair", async () => {
    const root = await temporary();
    const lineage = path.join(root, "lineage");
    const originals = path.join(root, "originals");
    await mkdir(path.join(lineage, "asset-1"), { recursive: true });
    await mkdir(path.join(originals, "sub"), { recursive: true });
    const master = jpeg(6000, 4000);
    const tiff = Uint8Array.from([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0]);
    await writeFile(path.join(originals, "sub", "IMG_1.jpg"), master);
    await writeFile(path.join(originals, "raw.tif"), tiff);
    await writeFile(
      path.join(lineage, "asset-1", "lineage.json"),
      JSON.stringify({ output_sha256: approved, source_sha256: sha(master) }),
    );
    await mkdir(path.join(lineage, "asset-2"));
    await writeFile(
      path.join(lineage, "asset-2", "lineage.json"),
      JSON.stringify({
        output_sha256: "c".repeat(64),
        source_sha256: sha(tiff),
      }),
    );
    const result = await draftApprovalDocument({
      catalogId: "catalog-example",
      candidates: [
        { mediaId: "media-1", approvedSha256: approved },
        { mediaId: "media-2", approvedSha256: "c".repeat(64) },
        { mediaId: "media-3", approvedSha256: "d".repeat(64) },
        { mediaId: "media-4", approvedSha256: null },
      ],
      lineageDirectory: lineage,
      originalsDirectory: originals,
    });
    expect(result.paired).toBe(1);
    expect(result.unpaired).toEqual({
      noApprovedHash: 1,
      noLineage: 1,
      noOriginal: 0,
      notJpegOrPng: 1,
    });
    expect(result.document?.entries).toEqual([
      {
        mediaId: "media-1",
        approvedSha256: approved,
        masterFile: "IMG_1.jpg",
        masterSha256: sha(master),
        derivation: "submitted",
      },
    ]);
  });

  it("writes the manifest only to a new private file and prints counts only", async () => {
    const root = await temporary();
    await mkdir(path.join(root, "lineage", "a"), { recursive: true });
    await mkdir(path.join(root, "originals"));
    const master = jpeg(6000, 4000);
    await writeFile(path.join(root, "originals", "IMG_1.jpg"), master);
    await writeFile(
      path.join(root, "lineage", "a", "lineage.json"),
      JSON.stringify({ output_sha256: approved, source_sha256: sha(master) }),
    );
    await writeFile(
      path.join(root, "candidates.jsonl"),
      `${JSON.stringify({ command: "candidates", mediaId: "media-1", approvedSha256: approved })}\n`,
    );
    const lines: Record<string, unknown>[] = [];
    const out = path.join(root, "approval.json");
    const ok = await runCatalogMasterManifest(
      parseCatalogMasterArguments([
        "manifest",
        "--catalog",
        "catalog-example",
        "--candidates",
        path.join(root, "candidates.jsonl"),
        "--lineage",
        path.join(root, "lineage"),
        "--originals",
        path.join(root, "originals"),
        "--out",
        out,
      ]),
      (line) => lines.push(line),
    );
    expect(ok).toBe(true);
    expect((await stat(out)).mode & 0o777).toBe(0o600);
    expect(
      parseApprovalDocument(JSON.parse(await readFile(out, "utf8"))).entries,
    ).toHaveLength(1);
    expect(JSON.stringify(lines)).not.toContain("IMG_1");
  });
});

describe("catalog-master arguments", () => {
  it("refuses unknown commands, unknown or repeated options and missing values", () => {
    for (const argv of [
      [],
      ["unknown"],
      ["status", "--media", "x"],
      ["attach", "--media"],
      ["detach", "--all", "--all"],
      ["erase", "--master", "--dry-run"],
    ])
      expect(() => parseCatalogMasterArguments(argv)).toThrow(
        CatalogMasterUsageError,
      );
    expect(
      parseCatalogMasterArguments(["detach", "--all"]).options.get("--all"),
    ).toBe(true);
  });
});

const storage = {
  taskBytes: 1,
  sliceBytes: 2,
  attachBytes: 3,
  sliceCap: 10,
  taskCap: 20,
};

const context = (
  port: Partial<CatalogMasterPort>,
  store?: Partial<CatalogMasterStore>,
  source?: CatalogSourceReader,
) => {
  const lines: Record<string, unknown>[] = [];
  const written: string[] = [];
  const removed: string[] = [];
  const fullStore: CatalogMasterStore = {
    writeStream: vi.fn(async (_owner, _purpose, _type, maxBytes, source) => {
      const hash = createHash("sha256");
      let size = 0;
      for await (const chunk of source) {
        hash.update(chunk);
        size += chunk.byteLength;
      }
      expect(size).toBe(maxBytes);
      const key = `blobs/00/00/${"f".repeat(32)}`;
      written.push(key);
      return { storageKey: key, byteSize: size, sha256: hash.digest("hex") };
    }),
    remove: vi.fn(async (key: string) => {
      removed.push(key);
    }),
    ...store,
  };
  const value: CatalogMasterContext = {
    port: port as CatalogMasterPort,
    store: async () => fullStore,
    ...(source === undefined ? {} : { source: async () => source }),
    out: (line) => lines.push(line),
    now: () => new Date("2026-10-20T00:00:00Z"),
  };
  return { value, lines, written, removed, store: fullStore };
};

const inboxWith = async (bytes: Uint8Array, masterSha256 = sha(bytes)) => {
  const root = await temporary();
  const inbox = path.join(root, "inbox");
  await mkdir(inbox, { mode: 0o700 });
  await chmod(inbox, 0o700);
  await writeFile(path.join(inbox, "master.jpg"), bytes);
  const approval = path.join(root, "approval.json");
  await writeFile(approval, JSON.stringify(document(masterSha256)));
  return { inbox, approval, root };
};

const attachArgs = (approval: string, inbox: string, ...extra: string[]) =>
  parseCatalogMasterArguments([
    "attach",
    "--media",
    "media-1",
    "--approval",
    approval,
    "--inbox",
    inbox,
    ...extra,
  ]);

describe("catalog-master attach", () => {
  it("checks with a dry run, uploads, then records; output is content-free", async () => {
    const bytes = jpeg(6000, 4000);
    const { inbox, approval } = await inboxWith(bytes);
    const attach = vi.fn(
      async (input: Parameters<CatalogMasterPort["attach"]>[0]) => ({
        status: "done" as const,
        masterId:
          input.source.kind === "upload"
            ? `catalog-master-${"1".repeat(32)}`
            : null,
        frameWidth: 6000,
        frameHeight: 4000,
        cells: 24,
        storage,
      }),
    );
    const c = context({ attach });
    expect(
      await runCatalogMasterCommand(attachArgs(approval, inbox), c.value),
    ).toBe(true);
    expect(attach.mock.calls.map(([input]) => input.source.kind)).toEqual([
      "dry_run",
      "upload",
    ]);
    expect(attach.mock.calls[1]![0]).toMatchObject({
      header: { contentType: "image/jpeg", width: 6000, height: 4000 },
      maxLongEdge: 8192,
      operator: "owner",
      masterSha256: sha(bytes),
    });
    expect(c.lines).toEqual([
      expect.objectContaining({
        command: "attach",
        mediaId: "media-1",
        status: "attached",
        cells: 24,
      }),
    ]);
    expect(JSON.stringify(c.lines)).not.toMatch(/master\.jpg|blobs\/|inbox/u);
  });

  it("writes nothing on --dry-run", async () => {
    const bytes = jpeg(6000, 4000);
    const { inbox, approval } = await inboxWith(bytes);
    const attach = vi.fn(async () => ({
      status: "done" as const,
      masterId: null,
      frameWidth: 6000,
      frameHeight: 4000,
      cells: 24,
      storage,
    }));
    const c = context({ attach });
    expect(
      await runCatalogMasterCommand(
        attachArgs(approval, inbox, "--dry-run"),
        c.value,
      ),
    ).toBe(true);
    expect(attach).toHaveBeenCalledTimes(1);
    expect(c.written).toEqual([]);
    expect(c.lines[0]).toMatchObject({ status: "dry_run" });
  });

  it("refuses a master whose SHA-256 differs from the approval document before any store call", async () => {
    const bytes = jpeg(6000, 4000);
    const { inbox, approval } = await inboxWith(bytes, "b".repeat(64));
    const attach = vi.fn();
    const c = context({ attach });
    expect(
      await runCatalogMasterCommand(attachArgs(approval, inbox), c.value),
    ).toBe(false);
    expect(attach).not.toHaveBeenCalled();
    expect(c.lines[0]).toMatchObject({
      status: "refused",
      code: "master_mismatch",
    });
  });

  it("refuses an alpha PNG and a non-private inbox", async () => {
    const alpha = png(6000, 4000, { colorType: 6 });
    const { inbox, approval } = await inboxWith(alpha);
    const c = context({ attach: vi.fn() });
    expect(
      await runCatalogMasterCommand(attachArgs(approval, inbox), c.value),
    ).toBe(false);
    expect(c.lines[0]).toMatchObject({ code: "master_has_alpha" });
    await chmod(inbox, 0o755);
    await expect(
      runCatalogMasterCommand(attachArgs(approval, inbox), c.value),
    ).rejects.toThrow(CatalogMasterUsageError);
  });

  it("removes the uploaded object when the store refuses after the upload", async () => {
    const bytes = jpeg(6000, 4000);
    const { inbox, approval } = await inboxWith(bytes);
    let call = 0;
    const attach = vi.fn(async () =>
      (call += 1) === 1
        ? {
            status: "done" as const,
            masterId: null,
            frameWidth: 6000,
            frameHeight: 4000,
            cells: 24,
            storage,
          }
        : { status: "refused" as const, code: "storage_task_cap", storage },
    );
    const c = context({ attach });
    expect(
      await runCatalogMasterCommand(attachArgs(approval, inbox), c.value),
    ).toBe(false);
    expect(c.removed).toEqual(c.written);
    expect(c.lines[0]).toMatchObject({
      status: "refused",
      code: "storage_task_cap",
      taskCap: 20,
    });
  });

  it("re-attaches a held master without a file or upload", async () => {
    const { approval } = await inboxWith(jpeg(6000, 4000), "b".repeat(64));
    const attach = vi.fn(
      async (input: Parameters<CatalogMasterPort["attach"]>[0]) => ({
        status: "done" as const,
        masterId:
          input.source.kind === "existing"
            ? `catalog-master-${"2".repeat(32)}`
            : null,
        frameWidth: 6000,
        frameHeight: 4000,
        cells: 24,
        storage,
      }),
    );
    const c = context({ attach });
    const parsed = parseCatalogMasterArguments([
      "attach",
      "--media",
      "media-1",
      "--approval",
      approval,
      "--existing-master",
      `catalog-master-${"9".repeat(32)}`,
    ]);
    expect(await runCatalogMasterCommand(parsed, c.value)).toBe(true);
    expect(attach.mock.calls[0]![0].source).toEqual({
      kind: "existing",
      masterId: `catalog-master-${"9".repeat(32)}`,
      dryRun: false,
    });
    expect(c.written).toEqual([]);
    expect(c.lines[0]).toMatchObject({ status: "attached", reattached: true });
  });

  it("stops a batch at the first storage refusal", async () => {
    const bytes = jpeg(6000, 4000);
    const root = await temporary();
    const inbox = path.join(root, "inbox");
    await mkdir(inbox, { mode: 0o700 });
    await chmod(inbox, 0o700);
    const entries = [1, 2, 3].map((n) => ({
      mediaId: `media-${n}`,
      approvedSha256: approved,
      masterFile: `m${n}.jpg`,
      masterSha256: sha(bytes),
      derivation: "submitted",
    }));
    for (const entry of entries)
      await writeFile(path.join(inbox, entry.masterFile), bytes);
    const approval = path.join(root, "approval.json");
    await writeFile(
      approval,
      JSON.stringify({ ...document(sha(bytes)), entries }),
    );
    const attach = vi.fn(
      async (input: Parameters<CatalogMasterPort["attach"]>[0]) =>
        input.mediaId === "media-2"
          ? { status: "refused" as const, code: "storage_slice_cap", storage }
          : {
              status: "done" as const,
              masterId: null,
              frameWidth: 6000,
              frameHeight: 4000,
              cells: 24,
              storage,
            },
    );
    const c = context({ attach });
    const parsed = parseCatalogMasterArguments([
      "attach-batch",
      "--approval",
      approval,
      "--inbox",
      inbox,
      "--dry-run",
    ]);
    expect(await runCatalogMasterCommand(parsed, c.value)).toBe(false);
    expect(c.lines.map((line) => line.mediaId)).toEqual(["media-1", "media-2"]);
  });
});

/*
 * catalog-deep-zoom-self-master-v1 (Issue #321) criterion 3: `attach` and
 * `attach-batch --from-source`. The published `editorial/` original is read
 * through the worker's source reader (here the Development reader over a
 * temporary media directory) into the empty private inbox, verified against
 * the approved SHA-256 while it is copied, and attached exactly like an
 * Owner's file. The copy never outlives its entry; output names no key, path
 * or file name.
 */
const SOURCE_DIRECTORY = "e".repeat(64);
const editorialKey = (approvedSha256: string, extension = "jpg") =>
  `editorial/${SOURCE_DIRECTORY}/${"1".repeat(64)}-${approvedSha256}.${extension}`;

const selfMasterEntry = (
  mediaId: string,
  approvedSha256: string,
  extra: Record<string, unknown> = {},
) => ({
  mediaId,
  approvedSha256,
  masterFile: `${mediaId}.original`,
  masterSha256: approvedSha256,
  derivation: "submitted",
  ...extra,
});

/** Originals in a media directory, an empty 0700 inbox and their approval document. */
const fromSource = async (
  originals: readonly {
    readonly mediaId: string;
    readonly bytes: Uint8Array;
    readonly extension?: string;
    /** What the source actually holds, when it differs from the approved bytes. */
    readonly stored?: Uint8Array | null;
    readonly entry?: Record<string, unknown>;
  }[],
) => {
  const root = await temporary();
  const media = path.join(root, "media");
  const inbox = path.join(root, "inbox");
  await mkdir(media);
  await mkdir(inbox, { mode: 0o700 });
  await chmod(inbox, 0o700);
  const keys = new Map<string, string>();
  for (const original of originals) {
    const key = editorialKey(sha(original.bytes), original.extension);
    keys.set(original.mediaId, key);
    if (original.stored !== null)
      await writeFile(
        path.join(media, key.split("/").at(-1)!),
        original.stored ?? original.bytes,
      );
  }
  const approval = path.join(root, "approval.json");
  await writeFile(
    approval,
    JSON.stringify({
      version: 1,
      kind: APPROVAL_KIND,
      catalogId: "catalog-example",
      entries: originals.map((original) =>
        selfMasterEntry(original.mediaId, sha(original.bytes), original.entry),
      ),
    }),
  );
  const local = new LocalCatalogSourceReader(media);
  const reads: {
    readonly key: string;
    readonly target: string;
    readonly expectedSha256: string;
    readonly maxBytes: number;
    readonly inboxFiles: number;
  }[] = [];
  const reader: CatalogSourceReader = {
    async read(key, target, options) {
      try {
        return await local.read(key, target, options);
      } finally {
        reads.push({
          key,
          target,
          expectedSha256: options.expectedSha256,
          maxBytes: options.maxBytes,
          inboxFiles: (await readdir(inbox)).length,
        });
      }
    },
  };
  const sourceOf = vi.fn(async (mediaId: string) => ({
    status: "done" as const,
    objectKey: keys.get(mediaId)!,
    approvedSha256: sha(originals.find((o) => o.mediaId === mediaId)!.bytes),
  }));
  return { root, inbox, approval, reader, reads, sourceOf, keys };
};

const done = (input: Parameters<CatalogMasterPort["attach"]>[0]) => ({
  status: "done" as const,
  masterId:
    input.source.kind === "upload" ? `catalog-master-${"1".repeat(32)}` : null,
  frameWidth: 8192,
  frameHeight: 5461,
  cells: 48,
  storage,
});

const fromSourceArgs = (
  approval: string,
  inbox: string,
  mediaId = "media-1",
  ...extra: string[]
) =>
  parseCatalogMasterArguments([
    "attach",
    "--media",
    mediaId,
    "--approval",
    approval,
    "--inbox",
    inbox,
    "--from-source",
    ...extra,
  ]);

describe("catalog-master attach --from-source (self-masters)", () => {
  it("reads the original through the source reader into the empty inbox, then checks, uploads and attaches it", async () => {
    const bytes = jpeg(9504, 6336);
    const f = await fromSource([{ mediaId: "media-1", bytes }]);
    const attach = vi.fn(
      async (input: Parameters<CatalogMasterPort["attach"]>[0]) => done(input),
    );
    const c = context({ attach, sourceOf: f.sourceOf }, undefined, f.reader);
    expect(
      await runCatalogMasterCommand(
        fromSourceArgs(f.approval, f.inbox),
        c.value,
      ),
    ).toBe(true);
    expect(f.sourceOf).toHaveBeenCalledWith("media-1");
    expect(f.reads).toEqual([
      {
        key: f.keys.get("media-1"),
        target: path.join(f.inbox, "media-1.original"),
        expectedSha256: sha(bytes),
        maxBytes: 128 * 1024 ** 2,
        inboxFiles: 1,
      },
    ]);
    expect(attach.mock.calls.map(([input]) => input.source.kind)).toEqual([
      "dry_run",
      "upload",
    ]);
    expect(attach.mock.calls[1]![0]).toMatchObject({
      approvedSha256: sha(bytes),
      masterSha256: sha(bytes),
      derivation: "submitted",
      header: { contentType: "image/jpeg", width: 9504, height: 6336 },
    });
    expect(c.written).toHaveLength(1);
    expect(c.lines).toEqual([
      expect.objectContaining({
        command: "attach",
        mediaId: "media-1",
        status: "attached",
        cells: 48,
      }),
    ]);
    expect(JSON.stringify(c.lines)).not.toMatch(
      /editorial\/|\.original|blobs\/|inbox/u,
    );
    expect(await readdir(f.inbox)).toEqual([]);
  });

  it("reads and checks on --dry-run but never writes the store", async () => {
    const bytes = jpeg(9504, 6336);
    const f = await fromSource([{ mediaId: "media-1", bytes }]);
    const attach = vi.fn(
      async (input: Parameters<CatalogMasterPort["attach"]>[0]) => done(input),
    );
    const c = context({ attach, sourceOf: f.sourceOf }, undefined, f.reader);
    expect(
      await runCatalogMasterCommand(
        fromSourceArgs(f.approval, f.inbox, "media-1", "--dry-run"),
        c.value,
      ),
    ).toBe(true);
    expect(f.reads).toHaveLength(1);
    expect(attach).toHaveBeenCalledTimes(1);
    expect(c.store.writeStream).not.toHaveBeenCalled();
    expect(c.lines[0]).toMatchObject({ status: "dry_run", cells: 48 });
    expect(await readdir(f.inbox)).toEqual([]);
  });

  it.each([
    [
      "a source whose bytes differ from the approved SHA-256",
      jpeg(9504, 6336, { sof: 0xc2 }),
      "source_hash_mismatch",
    ],
    ["a missing source", null, "source_unreadable"],
  ] as const)(
    "refuses %s with no attach or store call and an empty inbox",
    async (_label, stored, code) => {
      const bytes = jpeg(9504, 6336);
      const f = await fromSource([{ mediaId: "media-1", bytes, stored }]);
      const attach = vi.fn();
      const c = context({ attach, sourceOf: f.sourceOf }, undefined, f.reader);
      expect(
        await runCatalogMasterCommand(
          fromSourceArgs(f.approval, f.inbox),
          c.value,
        ),
      ).toBe(false);
      expect(f.reads).toHaveLength(1);
      expect(attach).not.toHaveBeenCalled();
      expect(c.store.writeStream).not.toHaveBeenCalled();
      expect(c.lines).toEqual([
        { command: "attach", mediaId: "media-1", status: "refused", code },
      ]);
      expect(await readdir(f.inbox)).toEqual([]);
    },
  );

  it("passes on a reader's transient failure as source_unavailable", async () => {
    const bytes = jpeg(9504, 6336);
    const f = await fromSource([{ mediaId: "media-1", bytes }]);
    const reader: CatalogSourceReader = {
      read: vi.fn(async () => {
        throw new CatalogSourceError("unavailable");
      }),
    };
    const c = context(
      { attach: vi.fn(), sourceOf: f.sourceOf },
      undefined,
      reader,
    );
    expect(
      await runCatalogMasterCommand(
        fromSourceArgs(f.approval, f.inbox),
        c.value,
      ),
    ).toBe(false);
    expect(c.lines[0]).toMatchObject({ code: "source_unavailable" });
  });

  it("refuses non-editorial and WebP sources before any read, and alpha or 16-bit sources after it", async () => {
    const bytes = jpeg(9504, 6336);
    const notEditorial = await fromSource([{ mediaId: "media-1", bytes }]);
    const c1 = context(
      {
        attach: vi.fn(),
        sourceOf: vi.fn(async () => ({
          status: "refused" as const,
          code: "not_editorial",
        })),
      },
      undefined,
      notEditorial.reader,
    );
    expect(
      await runCatalogMasterCommand(
        fromSourceArgs(notEditorial.approval, notEditorial.inbox),
        c1.value,
      ),
    ).toBe(false);
    expect(c1.lines[0]).toMatchObject({ code: "not_editorial" });
    expect(notEditorial.reads).toEqual([]);

    const webp = await fromSource([
      { mediaId: "media-1", bytes, extension: "webp" },
    ]);
    const c2 = context(
      { attach: vi.fn(), sourceOf: webp.sourceOf },
      undefined,
      webp.reader,
    );
    expect(
      await runCatalogMasterCommand(
        fromSourceArgs(webp.approval, webp.inbox),
        c2.value,
      ),
    ).toBe(false);
    expect(c2.lines[0]).toMatchObject({ code: "master_format" });
    expect(webp.reads).toEqual([]);

    for (const [original, code] of [
      [png(9504, 6336, { colorType: 6 }), "master_has_alpha"],
      [png(9504, 6336, { bitDepth: 16 }), "master_bit_depth"],
    ] as const) {
      const f = await fromSource([
        { mediaId: "media-1", bytes: original, extension: "png" },
      ]);
      const attach = vi.fn();
      const c = context({ attach, sourceOf: f.sourceOf }, undefined, f.reader);
      expect(
        await runCatalogMasterCommand(
          fromSourceArgs(f.approval, f.inbox),
          c.value,
        ),
      ).toBe(false);
      expect(f.reads).toHaveLength(1);
      expect(attach).not.toHaveBeenCalled();
      expect(c.lines[0]).toMatchObject({ status: "refused", code });
      expect(await readdir(f.inbox)).toEqual([]);
    }
  });

  it("refuses an entry that is not the approved bytes themselves, or names another approved image, before any read", async () => {
    const bytes = jpeg(9504, 6336);
    for (const entry of [
      { masterSha256: "b".repeat(64) },
      { derivation: "edited-export" },
    ]) {
      const f = await fromSource([{ mediaId: "media-1", bytes, entry }]);
      const c = context(
        { attach: vi.fn(), sourceOf: f.sourceOf },
        undefined,
        f.reader,
      );
      expect(
        await runCatalogMasterCommand(
          fromSourceArgs(f.approval, f.inbox),
          c.value,
        ),
      ).toBe(false);
      expect(c.lines[0]).toMatchObject({ code: "not_self_master" });
      expect(f.sourceOf).not.toHaveBeenCalled();
      expect(f.reads).toEqual([]);
    }
    const f = await fromSource([{ mediaId: "media-1", bytes }]);
    const c = context(
      {
        attach: vi.fn(),
        sourceOf: vi.fn(async () => ({
          status: "done" as const,
          objectKey: editorialKey("c".repeat(64)),
          approvedSha256: "c".repeat(64),
        })),
      },
      undefined,
      f.reader,
    );
    expect(
      await runCatalogMasterCommand(
        fromSourceArgs(f.approval, f.inbox),
        c.value,
      ),
    ).toBe(false);
    expect(c.lines[0]).toMatchObject({ code: "approved_mismatch" });
    expect(f.reads).toEqual([]);
  });

  it("removes the upload when attach refuses after it, and the copy on every path, a thrown error included", async () => {
    const bytes = jpeg(9504, 6336);
    const refusedAfter = await fromSource([{ mediaId: "media-1", bytes }]);
    const c1 = context(
      {
        attach: vi.fn(
          async (input: Parameters<CatalogMasterPort["attach"]>[0]) =>
            input.source.kind === "upload"
              ? {
                  status: "refused" as const,
                  code: "storage_task_cap",
                  storage,
                }
              : done(input),
        ),
        sourceOf: refusedAfter.sourceOf,
      },
      undefined,
      refusedAfter.reader,
    );
    expect(
      await runCatalogMasterCommand(
        fromSourceArgs(refusedAfter.approval, refusedAfter.inbox),
        c1.value,
      ),
    ).toBe(false);
    expect(c1.written).toHaveLength(1);
    expect(c1.removed).toEqual(c1.written);
    expect(await readdir(refusedAfter.inbox)).toEqual([]);

    const thrown = await fromSource([{ mediaId: "media-1", bytes }]);
    const c2 = context(
      {
        attach: vi.fn(
          async (input: Parameters<CatalogMasterPort["attach"]>[0]) => {
            if (input.source.kind === "upload") throw new Error("pool lost");
            return done(input);
          },
        ),
        sourceOf: thrown.sourceOf,
      },
      undefined,
      thrown.reader,
    );
    await expect(
      runCatalogMasterCommand(
        fromSourceArgs(thrown.approval, thrown.inbox),
        c2.value,
      ),
    ).rejects.toThrow("pool lost");
    expect(c2.removed).toEqual(c2.written);
    expect(await readdir(thrown.inbox)).toEqual([]);
  });

  it("copies one original at a time in a batch and stops at a storage refusal", async () => {
    const originals = [1, 2, 3].map((n) => ({
      mediaId: `media-${n}`,
      bytes: jpeg(9504, 6336 + n),
    }));
    const f = await fromSource(originals);
    const attach = vi.fn(
      async (input: Parameters<CatalogMasterPort["attach"]>[0]) =>
        input.mediaId === "media-2"
          ? { status: "refused" as const, code: "storage_slice_cap", storage }
          : done(input),
    );
    const c = context({ attach, sourceOf: f.sourceOf }, undefined, f.reader);
    const parsed = parseCatalogMasterArguments([
      "attach-batch",
      "--approval",
      f.approval,
      "--inbox",
      f.inbox,
      "--from-source",
    ]);
    expect(await runCatalogMasterCommand(parsed, c.value)).toBe(false);
    expect(c.lines.map((line) => [line.mediaId, line.status])).toEqual([
      ["media-1", "attached"],
      ["media-2", "refused"],
    ]);
    expect(f.reads.map((read) => read.inboxFiles)).toEqual([1, 1]);
    expect(await readdir(f.inbox)).toEqual([]);
  });

  it("needs --approval and an empty private --inbox, never --existing-master, and the source reader", async () => {
    const bytes = jpeg(9504, 6336);
    const f = await fromSource([{ mediaId: "media-1", bytes }]);
    const c = context(
      { attach: vi.fn(), sourceOf: f.sourceOf },
      undefined,
      f.reader,
    );
    for (const argv of [
      ["status", "--from-source"],
      ["attach-batch", "--inbox", f.inbox, "--from-source"],
    ])
      await expect(
        (async () =>
          runCatalogMasterCommand(
            parseCatalogMasterArguments(argv),
            c.value,
          ))(),
      ).rejects.toThrow(CatalogMasterUsageError);
    await expect(
      runCatalogMasterCommand(
        parseCatalogMasterArguments([
          "attach",
          "--media",
          "media-1",
          "--approval",
          f.approval,
          "--existing-master",
          `catalog-master-${"9".repeat(32)}`,
          "--from-source",
        ]),
        c.value,
      ),
    ).rejects.toThrow(CatalogMasterUsageError);
    await writeFile(path.join(f.inbox, "left-over.jpg"), bytes);
    await expect(
      runCatalogMasterCommand(fromSourceArgs(f.approval, f.inbox), c.value),
    ).rejects.toThrow(/empty/u);
    expect(f.sourceOf).not.toHaveBeenCalled();
    await rm(path.join(f.inbox, "left-over.jpg"));
    const withoutReader = context({ attach: vi.fn(), sourceOf: f.sourceOf });
    await expect(
      runCatalogMasterCommand(
        fromSourceArgs(f.approval, f.inbox),
        withoutReader.value,
      ),
    ).rejects.toThrow(CatalogMasterUsageError);
  });
});

/*
 * The CLI opens `--from-source`'s reader exactly as the media worker opens
 * its Catalog source: the `CATALOG_SOURCE_COS_*` identity whenever any of
 * that namespace is set, else only in Development the local Payload media
 * directory. Synthetic settings; no cloud request.
 */
describe("catalog-master --from-source reader identity", () => {
  const cos = {
    CATALOG_SOURCE_COS_BUCKET: "synthetic-source-1250000000",
    CATALOG_SOURCE_COS_REGION: "ap-guangzhou",
    CATALOG_SOURCE_COS_SECRET_ID: "synthetic-source-id",
    CATALOG_SOURCE_COS_SECRET_KEY: "synthetic-source-secret",
  } as const;
  const media = path.join(tmpdir(), "synthetic-payload-media");

  it("takes the CATALOG_SOURCE_COS_* identity in Production and over a Development media directory", async () => {
    for (const environment of [
      { NODE_ENV: "production", ...cos },
      { NODE_ENV: "production", CMS_MEDIA_DIR: media, ...cos },
      { NODE_ENV: "development", CMS_MEDIA_DIR: media, ...cos },
    ])
      expect(await openCatalogMasterSource(environment)).toBeInstanceOf(
        CosCatalogSourceReader,
      );
  });

  it("uses the local media directory only in Development without the COS identity", async () => {
    expect(
      await openCatalogMasterSource({
        NODE_ENV: "development",
        CMS_MEDIA_DIR: media,
      }),
    ).toBeInstanceOf(LocalCatalogSourceReader);
    await expect(
      openCatalogMasterSource({ NODE_ENV: "production", CMS_MEDIA_DIR: media }),
    ).rejects.toThrow(
      new CatalogMasterUsageError("--from-source needs CATALOG_SOURCE_COS_*"),
    );
    await expect(
      openCatalogMasterSource({ NODE_ENV: "development" }),
    ).rejects.toThrow(
      new CatalogMasterUsageError(
        "--from-source needs CATALOG_SOURCE_COS_* or CMS_MEDIA_DIR",
      ),
    );
  });

  it("refuses a partial or malformed COS identity as a usage error, naming the setting and never a value, even beside a media directory", async () => {
    for (const [environment, setting] of [
      [
        {
          NODE_ENV: "development",
          CMS_MEDIA_DIR: media,
          ...cos,
          CATALOG_SOURCE_COS_SECRET_KEY: undefined,
        },
        "CATALOG_SOURCE_COS_SECRET_KEY",
      ],
      [
        {
          NODE_ENV: "production",
          CATALOG_SOURCE_COS_SECRET_ID: cos.CATALOG_SOURCE_COS_SECRET_ID,
        },
        "CATALOG_SOURCE_COS_BUCKET",
      ],
      [
        {
          NODE_ENV: "production",
          ...cos,
          CATALOG_SOURCE_COS_BUCKET: "Synthetic_Bucket",
        },
        "CATALOG_SOURCE_COS_BUCKET",
      ],
    ] as const) {
      const error = await openCatalogMasterSource(environment).then(
        () => null,
        (thrown: unknown) => thrown,
      );
      // A usage error, so the command prints it instead of its generic line.
      expect(error).toBeInstanceOf(CatalogMasterUsageError);
      const message = (error as Error).message;
      expect(message).toContain(setting);
      for (const value of [
        cos.CATALOG_SOURCE_COS_SECRET_ID,
        cos.CATALOG_SOURCE_COS_SECRET_KEY,
        "Synthetic_Bucket",
        media,
      ])
        expect(message).not.toContain(value);
    }
  });
});
