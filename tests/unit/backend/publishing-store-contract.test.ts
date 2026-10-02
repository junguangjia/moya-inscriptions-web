import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CosPublishingMediaStore,
  FilesystemPublishingMediaStore,
  PUBLISHING_COS_PART_BYTES,
} from "@moya/backend-production/internal/publishing-media-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cosFixture, cosOptions } from "./publishing-cos-fixture.js";
import type { PublishingMediaStorePort } from "@moya/api";
import type { PublishingWorkerStore } from "@moya/backend-production/internal/publishing-job-handlers";

export async function* byteChunks(...values: (string | Uint8Array)[]) {
  for (const value of values)
    yield typeof value === "string" ? Buffer.from(value) : value;
}
const owner = "synthetic-owner";
const key = `blobs/aa/aa/${"a".repeat(32)}`;
const read = async (
  store: PublishingMediaStorePort,
  storageKey: string,
  range?: Parameters<PublishingMediaStorePort["openRead"]>[1],
) => {
  const result = await store.openRead(storageKey, range);
  if (result?.status !== "ok") throw new Error("expected readable");
  const chunks = [];
  for await (const chunk of result.body) chunks.push(chunk);
  await result.close();
  return Buffer.concat(chunks);
};

describe.each(["filesystem", "cos"] as const)(
  "shared publishing store contract: %s",
  (kind) => {
    let directory: string;
    let store: PublishingMediaStorePort & PublishingWorkerStore;
    beforeEach(async () => {
      directory = await mkdtemp(path.join(tmpdir(), "publishing-contract-"));
      await mkdir(path.join(directory, "store"), { mode: 0o700 });
      store =
        kind === "filesystem"
          ? await FilesystemPublishingMediaStore.open(
              path.join(directory, "store"),
              { temporaryRoots: [] },
            )
          : cosFixture().store;
    });
    afterEach(async () => {
      await rm(directory, { recursive: true, force: true });
    });
    const write = (bytes: AsyncIterable<Uint8Array>, max = 6, options = {}) =>
      store.writeStream(owner, "original", "image/jpeg", max, bytes, options);

    it("hashes actual bytes, reads inclusive/open/suffix ranges, removes idempotently", async () => {
      const written = await write(byteChunks("ab", "cdef"), 6, {
        requireExactSize: true,
      });
      expect(written).toMatchObject({
        byteSize: 6,
        sha256: createHash("sha256").update("abcdef").digest("hex"),
      });
      expect((await read(store, written.storageKey)).toString()).toBe("abcdef");
      expect(
        (
          await read(store, written.storageKey, { start: 1, end: 3 })
        ).toString(),
      ).toBe("bcd");
      expect(
        (await read(store, written.storageKey, { start: 4 })).toString(),
      ).toBe("ef");
      expect(
        (await read(store, written.storageKey, { suffixLength: 3 })).toString(),
      ).toBe("def");
      expect(await store.openRead(written.storageKey, { start: 6 })).toEqual({
        status: "range_not_satisfiable",
        byteSize: 6,
      });
      expect(
        await store.openRead(written.storageKey, { suffixLength: 0 }),
      ).toEqual({ status: "range_not_satisfiable", byteSize: 6 });
      await expect(
        store.openRead(written.storageKey, { start: -1 }),
      ).rejects.toMatchObject({ code: "invalid_argument" });
      await store.remove(written.storageKey);
      await store.remove(written.storageKey);
      expect(await store.openRead(written.storageKey)).toBeNull();
    });
    it("retains committed bytes when listing or removal is pre-aborted", async () => {
      const written = await write(byteChunks("abcdef"));
      const controller = new AbortController();
      controller.abort();
      await expect(
        store.listBlobs({ limit: 10, signal: controller.signal }),
      ).rejects.toMatchObject({ code: "aborted" });
      await expect(
        store.remove(written.storageKey, controller.signal),
      ).rejects.toMatchObject({ code: "aborted" });
      expect((await read(store, written.storageKey)).toString()).toBe("abcdef");
    });
    it.each([
      ["empty_content", [], 6, false],
      ["size_mismatch", ["abc"], 6, true],
      ["size_limit_exceeded", ["abcdefg"], 6, true],
    ] as const)(
      "rejects %s without committed blobs",
      async (code, chunks, max, requireExactSize) => {
        await expect(
          write(byteChunks(...chunks), max, { requireExactSize }),
        ).rejects.toMatchObject({ code });
        expect((await store.listBlobs({ limit: 10 })).entries).toEqual([]);
      },
    );
    it("cancels a stalled producer promptly and rejects pre-aborted writes", async () => {
      const controller = new AbortController();
      const pending = write(
        {
          [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
        },
        6,
        { signal: controller.signal },
      );
      setTimeout(() => controller.abort(), 20);
      await expect(pending).rejects.toMatchObject({ code: "aborted" });
      await expect(
        write(byteChunks("a"), 6, { signal: controller.signal }),
      ).rejects.toMatchObject({ code: "aborted" });
      expect((await store.listBlobs({ limit: 1 })).entries).toEqual([]);
    });
    it("cleans an interrupted source and never surfaces its message", async () => {
      await expect(
        write(
          (async function* () {
            yield Buffer.from("abc");
            throw new Error("private upstream path");
          })(),
        ),
      ).rejects.toMatchObject({
        code: "unavailable",
        message: "Publishing media store failure: unavailable",
      });
      expect((await store.listBlobs({ limit: 1 })).entries).toEqual([]);
    });
    it("returns unique immutable keys and resumes ordered bounded pages", async () => {
      const written = await Promise.all([
        write(byteChunks("a")),
        write(byteChunks("b")),
        write(byteChunks("c")),
      ]);
      expect(new Set(written.map((w) => w.storageKey)).size).toBe(3);
      const all: string[] = [];
      let after: string | null = null;
      do {
        const page: Awaited<ReturnType<PublishingMediaStorePort["listBlobs"]>> =
          await store.listBlobs({ limit: 1, after });
        expect(page.entries.length).toBeLessThanOrEqual(1);
        all.push(...page.entries.map((e) => e.storageKey));
        after = page.nextAfter;
      } while (after);
      expect(all).toEqual(written.map((w) => w.storageKey).sort());
      await expect(store.listBlobs({ limit: 0 })).rejects.toMatchObject({
        code: "invalid_argument",
      });
      await expect(
        store.listBlobs({ limit: 1, after: "editorial/foreign" }),
      ).rejects.toMatchObject({ code: "invalid_key" });
    });
    it("rejects foreign or mismatched shard keys and reports missing objects", async () => {
      for (const bad of [
        "../secret",
        "editorial/foreign",
        `blobs/bb/aa/${"a".repeat(32)}`,
      ]) {
        await expect(store.openRead(bad)).rejects.toMatchObject({
          code: "invalid_key",
        });
        await expect(store.remove(bad)).rejects.toMatchObject({
          code: "invalid_key",
        });
      }
      expect(await store.openRead(key)).toBeNull();
    });
  },
);

describe("COS multipart failure and namespace boundaries", () => {
  it("commits sequential bounded parts only after validation, with private ACL and integrity headers", async () => {
    const f = cosFixture();
    const bytes = Buffer.alloc(PUBLISHING_COS_PART_BYTES + 7, 42);
    const result = await f.store.writeStream(
      owner,
      "original",
      "image/jpeg",
      bytes.length,
      byteChunks(bytes),
      { requireExactSize: true },
    );
    expect((await read(f.store, result.storageKey)).equals(bytes)).toBe(true);
    const parts = f.calls.filter((c) => c.method === "multipartUpload");
    expect(parts.map((p) => p.input.ContentLength)).toEqual([
      PUBLISHING_COS_PART_BYTES,
      7,
    ]);
    expect(
      f.calls.find((c) => c.method === "multipartInit")!.input,
    ).toMatchObject({
      ACL: "private",
      Headers: { "x-cos-forbid-overwrite": "true" },
    });
    expect(f.uploads.size).toBe(0);
  });
  it("aborts partial uploads, including prior successful parts", async () => {
    const f = cosFixture();
    await expect(
      f.store.writeStream(
        owner,
        "original",
        "image/jpeg",
        PUBLISHING_COS_PART_BYTES + 1,
        (async function* () {
          yield Buffer.alloc(PUBLISHING_COS_PART_BYTES);
          throw new Error("interrupted");
        })(),
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(f.uploads.size).toBe(0);
    expect(f.objects.size).toBe(0);
    expect(f.calls.some((c) => c.method === "multipartComplete")).toBe(false);
  });
  it("compensates an ambiguous successful completion only when its identity matches", async () => {
    const f = cosFixture();
    f.state.after = (method) => {
      if (method === "multipartComplete") throw new Error("response lost");
    };
    await expect(
      f.store.writeStream(
        owner,
        "original",
        "image/jpeg",
        3,
        byteChunks("abc"),
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(f.objects.size).toBe(0);
    expect(f.uploads.size).toBe(0);
  });
  it("never deletes or overwrites a colliding committed key", async () => {
    const f = cosFixture();
    f.state.before = async (method, input) => {
      if (method === "multipartComplete")
        f.objects.set(String(input.Key), {
          bytes: Buffer.from("retained"),
          headers: { "x-cos-meta-publishing-upload": "different-operation" },
          modified: new Date(),
        });
    };
    await expect(
      f.store.writeStream(
        owner,
        "original",
        "image/jpeg",
        3,
        byteChunks("abc"),
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect([...f.objects.values()][0]!.bytes.toString()).toBe("retained");
    expect(f.calls.some((c) => c.method === "deleteObject")).toBe(false);
  });
  it.each([
    "",
    "<invalid/>",
    "<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>",
    "<VersioningConfiguration><Status>Suspended</Status></VersioningConfiguration>",
  ])("refuses unverified versioning state %s", async (xml) => {
    const f = cosFixture();
    f.state.versioning = xml;
    await expect(
      f.store.writeStream(
        owner,
        "original",
        "image/jpeg",
        3,
        byteChunks("abc"),
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(f.uploads.size).toBe(0);
  });
  it("rejects mixed provider listings before exposing any key to reconciliation", async () => {
    const f = cosFixture();
    f.state.after = (method, result) => {
      if (method === "getBucket")
        result.Contents = [
          {
            Key: "editorial/foreign",
            Size: "2",
            LastModified: new Date().toISOString(),
          },
        ];
    };
    await expect(f.store.listBlobs({ limit: 1 })).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(f.calls.some((c) => c.method === "deleteObject")).toBe(false);
    expect(
      () =>
        new CosPublishingMediaStore(
          { ...cosOptions, prefix: "editorial/" },
          f.transport,
        ),
    ).toThrow("WORK_MEDIA_COS_PREFIX");
  });
  it("sweeps restart leftovers but retains uploads with recent parts and foreign uploads", async () => {
    const f = cosFixture();
    const old = new Date("2020-01-01T00:00:00Z");
    for (const [id, Key, modified] of [
      ["old", cosOptions.prefix + key, old],
      ["active", cosOptions.prefix + key, new Date()],
      ["foreign", "editorial/foreign", old],
    ] as const)
      f.uploads.set(id, {
        Key,
        UploadId: id,
        Initiated: old.toISOString(),
        modified,
        headers: {},
        parts: [Buffer.from("part")],
      });
    expect(
      await new CosPublishingMediaStore(cosOptions, f.transport).sweepStaging(
        new Date(Date.now() - 3600000),
      ),
    ).toEqual({ removed: 1 });
    expect([...f.uploads.keys()].sort()).toEqual(["active", "foreign"]);
    expect(await f.store.sweepStaging(new Date(Date.now() - 3600000))).toEqual({
      removed: 0,
    });
  });
});
