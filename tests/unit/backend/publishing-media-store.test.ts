import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  FilesystemPublishingMediaStore,
  PUBLISHING_BLOB_KEY_PATTERN,
  PUBLISHING_MEDIA_TEMPORARY_ROOTS,
  PublishingMediaStoreError,
} from "@moya/backend-production/internal/publishing-media-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PublishingMediaStorePort } from "@moya/api";

const forcedRandom = vi.hoisted(() => ({ values: [] as Buffer[] }));

// Only key randomness is steerable, to prove collisions never overwrite.
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    randomBytes: ((size: number) =>
      forcedRandom.values.shift() ??
      actual.randomBytes(size)) as typeof actual.randomBytes,
  };
});

const OWNER = `user-${"1".repeat(32)}`;
let base: string;
let root: string;

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "publishing-store-"));
  root = path.join(base, "store");
  await mkdir(root, { mode: 0o700 });
  await chmod(root, 0o700);
  forcedRandom.values = [];
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const openStore = () =>
  FilesystemPublishingMediaStore.open(root, { temporaryRoots: [] });

async function* chunks(...parts: (string | Uint8Array)[]) {
  for (const part of parts) {
    yield typeof part === "string" ? Buffer.from(part) : part;
  }
}

const readAll = async (body: AsyncIterable<Uint8Array>) => {
  const parts: Uint8Array[] = [];
  for await (const part of body) parts.push(part);
  return Buffer.concat(parts).toString("utf8");
};

const filesUnder = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, {
    withFileTypes: true,
    recursive: true,
  });
  return entries
    .filter((entry) => !entry.isDirectory())
    .map((entry) =>
      path.relative(directory, path.join(entry.parentPath, entry.name)),
    )
    .sort();
};

const failure = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(PublishingMediaStoreError);
    return (error as PublishingMediaStoreError).code;
  }
  throw new Error("expected a store failure");
};

const blobPath = (key: string) => path.join(root, ...key.split("/"));

describe("publishing media store configuration", () => {
  it("defaults to rejecting temporary storage roots", () => {
    expect(PUBLISHING_MEDIA_TEMPORARY_ROOTS).toEqual([
      "/tmp",
      "/private/tmp",
      "/var/folders",
      "/private/var/folders",
    ]);
  });

  it("creates owner-only blobs and staging directories inside a valid root", async () => {
    await openStore();
    for (const name of ["blobs", "staging"]) {
      const info = await stat(path.join(root, name));
      expect(info.isDirectory()).toBe(true);
      expect(info.mode & 0o777).toBe(0o700);
    }
  });

  it.each([
    ["a relative path", () => "relative/store", "absolute normalized path"],
    [
      "a non-normalized path",
      () => `${root}/../store`,
      "absolute normalized path",
    ],
    ["a trailing separator", () => `${root}/`, "absolute normalized path"],
    ["a missing directory", () => path.join(base, "missing"), "must exist"],
  ])("rejects %s", async (_name, directory, message) => {
    await expect(
      FilesystemPublishingMediaStore.open(directory(), { temporaryRoots: [] }),
    ).rejects.toThrow(message);
  });

  it("rejects a symlinked or non-directory root", async () => {
    const link = path.join(base, "link");
    await symlink(root, link);
    await expect(
      FilesystemPublishingMediaStore.open(link, { temporaryRoots: [] }),
    ).rejects.toThrow("real directory");
    const file = path.join(base, "file");
    await writeFile(file, "x", { mode: 0o600 });
    await expect(
      FilesystemPublishingMediaStore.open(file, { temporaryRoots: [] }),
    ).rejects.toThrow("real directory");
  });

  it("rejects group or world permissions", async () => {
    await chmod(root, 0o750);
    await expect(openStore()).rejects.toThrow("owner-only permissions");
  });

  it("rejects roots under temporary storage", async () => {
    await expect(
      FilesystemPublishingMediaStore.open(root, { temporaryRoots: [base] }),
    ).rejects.toThrow("temporary storage");
  });

  it("rejects roots anywhere inside a tree with a .git entry", async () => {
    const repository = path.join(base, "repository");
    const nested = path.join(repository, "a", "media");
    await mkdir(nested, { recursive: true, mode: 0o700 });
    await writeFile(path.join(repository, ".git"), "gitdir: elsewhere\n");
    await expect(
      FilesystemPublishingMediaStore.open(nested, { temporaryRoots: [] }),
    ).rejects.toThrow("Git working tree");
  });
});

describe("publishing media store writes", () => {
  it("streams, hashes and commits a blob under a sanitized key", async () => {
    const store = await openStore();
    const port: PublishingMediaStorePort = store;
    const result = await port.writeStream(
      OWNER,
      "original",
      "image/jpeg",
      64,
      chunks("hello ", "private ", "bytes"),
    );
    expect(result.storageKey).toMatch(PUBLISHING_BLOB_KEY_PATTERN);
    const hex = result.storageKey.split("/")[3]!;
    expect(
      result.storageKey.startsWith(
        `blobs/${hex.slice(0, 2)}/${hex.slice(2, 4)}/`,
      ),
    ).toBe(true);
    expect(result.byteSize).toBe(19);
    expect(result.sha256).toBe(
      createHash("sha256").update("hello private bytes").digest("hex"),
    );
    expect((await stat(blobPath(result.storageKey))).mode & 0o777).toBe(0o600);
    expect(await filesUnder(path.join(root, "staging"))).toEqual([]);
    const read = await store.openRead(result.storageKey);
    expect(read?.status).toBe("ok");
    if (read?.status === "ok")
      expect(await readAll(read.body)).toBe("hello private bytes");
  });

  it("aborts on the first byte over the limit and leaves no blob or staging file", async () => {
    const store = await openStore();
    let released = false;
    async function* source() {
      try {
        yield Buffer.from("123456");
        yield Buffer.from("7890ab");
        yield Buffer.from("never");
      } finally {
        released = true;
      }
    }
    expect(
      await failure(() =>
        store.writeStream(OWNER, "original", "image/png", 10, source()),
      ),
    ).toBe("size_limit_exceeded");
    await new Promise((resolve) => setImmediate(resolve));
    expect(released).toBe(true);
    expect(await filesUnder(root)).toEqual([]);
  });

  it("accepts exactly the limit and enforces exact sizes when required", async () => {
    const store = await openStore();
    const exact = await store.writeStream(
      OWNER,
      "standard_master",
      "image/webp",
      10,
      chunks("0123456789"),
      { requireExactSize: true },
    );
    expect(exact.byteSize).toBe(10);
    expect(
      await failure(() =>
        store.writeStream(
          OWNER,
          "original",
          "image/png",
          10,
          chunks("012345678"),
          {
            requireExactSize: true,
          },
        ),
      ),
    ).toBe("size_mismatch");
    expect(
      await failure(() =>
        store.writeStream(OWNER, "original", "image/png", 10, chunks()),
      ),
    ).toBe("empty_content");
    expect(await filesUnder(root)).toEqual([exact.storageKey]);
  });

  it("stops promptly when the abort signal fires while the source stalls", async () => {
    const store = await openStore();
    const controller = new AbortController();
    async function* stalled() {
      yield Buffer.from("partial");
      await new Promise(() => undefined);
    }
    setTimeout(() => controller.abort(), 10);
    expect(
      await failure(() =>
        store.writeStream(
          OWNER,
          "original",
          "video/quicktime",
          1024,
          stalled(),
          {
            signal: controller.signal,
          },
        ),
      ),
    ).toBe("aborted");
    expect(await filesUnder(root)).toEqual([]);
    expect(
      await failure(() =>
        store.writeStream(
          OWNER,
          "original",
          "video/quicktime",
          1024,
          chunks("x"),
          {
            signal: controller.signal,
          },
        ),
      ),
    ).toBe("aborted");
    expect(await filesUnder(root)).toEqual([]);
  });

  it.each([
    ["an unknown purpose", ["public", "image/png", 10]],
    ["an unlisted content type", ["original", "text/html", 10]],
    ["a zero limit", ["original", "image/png", 0]],
    ["a fractional limit", ["original", "image/png", 1.5]],
  ] as const)("rejects %s", async (_name, [purpose, contentType, maxBytes]) => {
    const store = await openStore();
    expect(
      await failure(() =>
        store.writeStream(
          OWNER,
          purpose as "original",
          contentType as "image/png",
          maxBytes,
          chunks("x"),
        ),
      ),
    ).toBe("invalid_argument");
  });

  it("rejects non-byte chunks and whitespace owner identities", async () => {
    const store = await openStore();
    async function* strings() {
      yield "text" as unknown as Uint8Array;
    }
    expect(
      await failure(() =>
        store.writeStream(OWNER, "original", "image/png", 10, strings()),
      ),
    ).toBe("invalid_argument");
    expect(
      await failure(() =>
        store.writeStream("user 1", "original", "image/png", 10, chunks("x")),
      ),
    ).toBe("invalid_argument");
    expect(await filesUnder(root)).toEqual([]);
  });

  it("never overwrites an existing blob when a generated key collides", async () => {
    const store = await openStore();
    const fixed = Buffer.from("ab".repeat(16), "hex");
    forcedRandom.values = [fixed, fixed];
    const first = await store.writeStream(
      OWNER,
      "original",
      "image/png",
      64,
      chunks("first"),
    );
    const second = await store.writeStream(
      OWNER,
      "original",
      "image/png",
      64,
      chunks("second"),
    );
    expect(first.storageKey).toBe(`blobs/ab/ab/${"ab".repeat(16)}`);
    expect(second.storageKey).not.toBe(first.storageKey);
    const read = await store.openRead(first.storageKey);
    if (read?.status !== "ok") throw new Error("expected blob");
    expect(await readAll(read.body)).toBe("first");

    forcedRandom.values = [fixed, fixed, fixed, fixed];
    expect(
      await failure(() =>
        store.writeStream(OWNER, "original", "image/png", 64, chunks("third")),
      ),
    ).toBe("unavailable");
    expect(await filesUnder(path.join(root, "staging"))).toEqual([]);
    expect(await filesUnder(path.join(root, "blobs"))).toHaveLength(2);
  });
});

describe("publishing media store reads and removal", () => {
  const writeDigits = async (store: FilesystemPublishingMediaStore) =>
    (
      await store.writeStream(
        OWNER,
        "derivative",
        "video/mp4",
        10,
        chunks("0123456789"),
      )
    ).storageKey;

  it.each([
    [{ start: 2, end: 5 }, "2345", 2, 5],
    [{ start: 7 }, "789", 7, 9],
    [{ suffixLength: 3 }, "789", 7, 9],
    [{ suffixLength: 50 }, "0123456789", 0, 9],
    [{ start: 8, end: 100 }, "89", 8, 9],
    [undefined, "0123456789", 0, 9],
  ])("serves byte range %j", async (range, text, start, end) => {
    const store = await openStore();
    const key = await writeDigits(store);
    const read = await store.openRead(key, range);
    if (read?.status !== "ok") throw new Error("expected a satisfiable range");
    expect([read.byteSize, read.start, read.end, read.contentLength]).toEqual([
      10,
      start,
      end,
      end - start + 1,
    ]);
    expect(await readAll(read.body)).toBe(text);
  });

  it("reports unsatisfiable ranges and rejects malformed ones", async () => {
    const store = await openStore();
    const key = await writeDigits(store);
    expect(await store.openRead(key, { start: 10 })).toEqual({
      status: "range_not_satisfiable",
      byteSize: 10,
    });
    expect(await store.openRead(key, { suffixLength: 0 })).toEqual({
      status: "range_not_satisfiable",
      byteSize: 10,
    });
    for (const range of [
      { start: 5, end: 4 },
      { start: -1 },
      { start: 1.5 },
      { suffixLength: -2 },
    ]) {
      expect(await failure(() => store.openRead(key, range))).toBe(
        "invalid_argument",
      );
    }
  });

  it("releases an unconsumed read and removes idempotently", async () => {
    const store = await openStore();
    const key = await writeDigits(store);
    const read = await store.openRead(key);
    if (read?.status !== "ok") throw new Error("expected blob");
    await read.close();
    await read.close();
    await store.remove(key);
    await store.remove(key);
    expect(await store.openRead(key)).toBeNull();
    expect(
      await store.openRead(`blobs/00/11/0011${"f".repeat(28)}`),
    ).toBeNull();
  });

  it.each([
    "blobs/../../etc/passwd",
    `blobs/ab/cd/${"0".repeat(32)}`,
    `blobs/AB/CD/ABCD${"0".repeat(28)}`,
    `blobs/ab/cd/abcd${"0".repeat(27)}`,
    `/blobs/ab/cd/abcd${"0".repeat(28)}`,
    `staging/ab/cd/abcd${"0".repeat(28)}`,
    `blobs/ab/cd/abcd${"0".repeat(28)}.part`,
  ])("rejects invalid key %s before touching the filesystem", async (key) => {
    const store = await openStore();
    expect(await failure(() => store.openRead(key))).toBe("invalid_key");
    expect(await failure(() => store.remove(key))).toBe("invalid_key");
  });

  it("refuses symlinked blobs, symlinked key directories and non-regular files", async () => {
    const store = await openStore();
    // Keep the first blob out of the cd directory reserved for the symlink case.
    forcedRandom.values = [Buffer.alloc(16, 0x00)];
    const key = await writeDigits(store);
    const outside = path.join(base, "outside.txt");
    await writeFile(outside, "not a blob", { mode: 0o600 });
    await unlink(blobPath(key));
    await symlink(outside, blobPath(key));
    expect(await failure(() => store.openRead(key))).toBe("not_regular_file");

    const hex = `cdef${"1".repeat(28)}`;
    const elsewhere = path.join(base, "elsewhere");
    await mkdir(path.join(elsewhere, "ef"), { recursive: true });
    await writeFile(path.join(elsewhere, "ef", hex), "linked");
    await symlink(elsewhere, path.join(root, "blobs", "cd"));
    const linkedKey = `blobs/cd/ef/${hex}`;
    expect(await failure(() => store.openRead(linkedKey))).toBe(
      "not_regular_file",
    );
    expect(await failure(() => store.remove(linkedKey))).toBe(
      "not_regular_file",
    );
    expect(await readdir(path.join(elsewhere, "ef"))).toEqual([hex]);

    const directoryHex = `9876${"2".repeat(28)}`;
    await mkdir(path.join(root, "blobs", "98", "76", directoryHex), {
      recursive: true,
    });
    expect(
      await failure(() => store.openRead(`blobs/98/76/${directoryHex}`)),
    ).toBe("not_regular_file");
  });

  it("sweeps only abandoned staging files older than the cutoff", async () => {
    const store = await openStore();
    const staging = path.join(root, "staging");
    const old = path.join(staging, "0f0e0d0c-0b0a-4908-8706-050403020100.part");
    const recent = path.join(
      staging,
      "1f0e0d0c-0b0a-4908-8706-050403020100.part",
    );
    const unrelated = path.join(staging, "notes.txt");
    for (const file of [old, recent, unrelated]) await writeFile(file, "x");
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
    await utimes(old, twoHoursAgo, twoHoursAgo);
    await utimes(unrelated, twoHoursAgo, twoHoursAgo);
    expect(await store.sweepStaging(new Date(Date.now() - 3600_000))).toEqual({
      removed: 1,
    });
    expect((await readdir(staging)).sort()).toEqual([
      "1f0e0d0c-0b0a-4908-8706-050403020100.part",
      "notes.txt",
    ]);
  });

  const stagingName = (index: number, prefix: string) =>
    `${prefix}${index.toString(16).padStart(7, "0")}-0b0a-4908-8706-050403020100.part`;

  it("keeps sweeping old staging files behind many fresh ones and bounds removals per call", async () => {
    const store = await openStore();
    const staging = path.join(root, "staging");
    const old = new Date(Date.now() - 2 * 3600_000);
    for (let index = 0; index < 1100; index += 1) {
      await writeFile(path.join(staging, stagingName(index, "0")), "");
    }
    for (let index = 0; index < 1005; index += 1) {
      const file = path.join(staging, stagingName(index, "f"));
      await writeFile(file, "");
      await utimes(file, old, old);
    }
    const cutoff = new Date(Date.now() - 3600_000);
    expect(await store.sweepStaging(cutoff)).toEqual({ removed: 1000 });
    expect(await store.sweepStaging(cutoff)).toEqual({ removed: 5 });
    expect(await store.sweepStaging(cutoff)).toEqual({ removed: 0 });
    expect(await readdir(staging)).toHaveLength(1100);
  });

  it("never sweeps a write that is still in progress", async () => {
    const store = await openStore();
    const staging = path.join(root, "staging");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    async function* slow() {
      yield Buffer.from("part-");
      await gate;
      yield Buffer.from("rest");
    }
    const pending = store.writeStream(
      OWNER,
      "original",
      "image/png",
      64,
      slow(),
    );
    await vi.waitFor(async () =>
      expect(await readdir(staging)).toHaveLength(1),
    );
    const [name] = await readdir(staging);
    const old = new Date(Date.now() - 2 * 3600_000);
    await utimes(path.join(staging, name!), old, old);
    expect(await store.sweepStaging(new Date())).toEqual({ removed: 0 });
    release();
    expect((await pending).byteSize).toBe(9);
    expect(await readdir(staging)).toEqual([]);
  });

  it("reports raw filesystem failures as content-free unavailable errors", async () => {
    const store = await openStore();
    const staging = path.join(root, "staging");
    await chmod(staging, 0o500);
    try {
      const error = await store
        .writeStream(OWNER, "original", "image/png", 10, chunks("x"))
        .then(
          () => null,
          (caught: unknown) => caught,
        );
      expect(error).toBeInstanceOf(PublishingMediaStoreError);
      expect(error).toMatchObject({
        code: "unavailable",
        systemCode: "EACCES",
      });
      expect((error as Error).message).not.toContain(root);
      expect(JSON.stringify(error)).not.toContain(root);
    } finally {
      await chmod(staging, 0o700);
    }
    const key = await writeDigits(store);
    const first = path.join(root, "blobs", key.split("/")[1]!);
    await chmod(first, 0o000);
    try {
      const error = await store.openRead(key).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toMatchObject({
        code: "unavailable",
        systemCode: "EACCES",
      });
      expect(JSON.stringify(error)).not.toContain(root);
    } finally {
      await chmod(first, 0o700);
    }
  });
});

describe("publishing media store listing", () => {
  it("pages through committed blobs in key order and skips non-regular entries", async () => {
    const store = await openStore();
    const port: PublishingMediaStorePort = store;
    const keys: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      keys.push(
        (
          await store.writeStream(
            OWNER,
            "derivative",
            "image/webp",
            8,
            chunks(`blob-${index}`),
          )
        ).storageKey,
      );
    }
    keys.sort();
    const directoryHex = `9876${"2".repeat(28)}`;
    await mkdir(path.join(root, "blobs", "98", "76", directoryHex), {
      recursive: true,
    });
    const linkHex = `9877${"3".repeat(28)}`;
    await mkdir(path.join(root, "blobs", "98", "77"), { recursive: true });
    await symlink(
      path.join(base, "outside"),
      path.join(root, "blobs", "98", "77", linkHex),
    );
    await writeFile(path.join(root, "blobs", "98", "stray.txt"), "x");

    const seen: string[] = [];
    let after: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const listing = await port.listBlobs({ after, limit: 2 });
      for (const entry of listing.entries) {
        expect(entry.byteSize).toBe(6);
        expect(entry.modifiedAt).toBeInstanceOf(Date);
        expect(entry.modifiedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
        seen.push(entry.storageKey);
      }
      after = listing.nextAfter;
      if (after === null) break;
    }
    expect(after).toBeNull();
    expect(seen).toEqual(keys);
    expect((await store.listBlobs({ limit: 1000 })).entries).toHaveLength(5);
    expect(await store.listBlobs({ after: keys.at(-1)!, limit: 10 })).toEqual({
      entries: [],
      nextAfter: null,
    });
  });

  it("rejects malformed listing arguments", async () => {
    const store = await openStore();
    for (const limit of [0, 1001, 1.5]) {
      expect(await failure(() => store.listBlobs({ limit }))).toBe(
        "invalid_argument",
      );
    }
    expect(
      await failure(() =>
        store.listBlobs({ after: "blobs/../../etc", limit: 10 }),
      ),
    ).toBe("invalid_key");
  });
});
