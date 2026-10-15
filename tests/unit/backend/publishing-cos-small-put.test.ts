import { createHash } from "node:crypto";

import {
  PUBLISHING_COS_PART_BYTES,
  PublishingMediaStoreError,
} from "@moya/backend-production/internal/publishing-media-store";
import { describe, expect, it } from "vitest";

import { cosFixture, cosOptions } from "./publishing-cos-fixture.js";

const owner = "synthetic-owner";
async function* chunks(...values: Uint8Array[]) {
  yield* values;
}
const write = (
  f: ReturnType<typeof cosFixture>,
  source: AsyncIterable<Uint8Array> = chunks(Buffer.from("abcdef")),
  maxBytes = 6,
  signal?: AbortSignal,
) =>
  f.store.writeStream(owner, "derivative", "image/webp", maxBytes, source, {
    requireExactSize: true,
    ...(signal ? { signal } : {}),
  });
const methods = (f: ReturnType<typeof cosFixture>) =>
  f.calls.map((call) => call.method);
const unavailable = () => new PublishingMediaStoreError("unavailable");

describe("COS exact small derivative PUT", () => {
  it("uses four operations and verifies exact bytes, hashes, privacy and ownership", async () => {
    const f = cosFixture();
    const result = await write(
      f,
      chunks(Buffer.from("ab"), Buffer.from("cdef")),
    );
    expect(methods(f)).toEqual([
      "getBucketVersioning",
      "headObject",
      "putObject",
      "headObject",
    ]);
    expect(result).toMatchObject({
      byteSize: 6,
      sha256: createHash("sha256").update("abcdef").digest("hex"),
    });
    const put = f.calls.find((call) => call.method === "putObject")!.input;
    expect(put).toMatchObject({
      Body: Buffer.from("abcdef"),
      ContentLength: 6,
      ContentType: "image/webp",
      ACL: "private",
      CacheControl: "private, no-store",
      Headers: {
        "Content-MD5": createHash("md5").update("abcdef").digest("base64"),
        "x-cos-forbid-overwrite": "true",
      },
    });
    const stored = f.objects.get(cosOptions.prefix + result.storageKey)!;
    expect(stored.bytes).toEqual(Buffer.from("abcdef"));
    expect(stored.headers["x-cos-meta-publishing-upload"]).toMatch(
      /^[a-f0-9]{32}$/,
    );
    expect(f.uploads.size).toBe(0);
  });

  it("copies producer chunks before they can be reused", async () => {
    const f = cosFixture();
    const buffer = Buffer.from("abc");
    const result = await write(
      f,
      (async function* () {
        yield buffer;
        buffer.fill(100);
        yield Buffer.from("def");
      })(),
    );
    expect(f.objects.get(cosOptions.prefix + result.storageKey)!.bytes).toEqual(
      Buffer.from("abcdef"),
    );
    expect(result.sha256).toBe(
      createHash("sha256").update("abcdef").digest("hex"),
    );
  });

  it.each([
    ["empty_content", []],
    ["size_mismatch", [Buffer.from("abc")]],
    ["size_limit_exceeded", [Buffer.from("abcdefg")]],
  ] as const)("rejects %s before PUT", async (code, bytes) => {
    const f = cosFixture();
    await expect(write(f, chunks(...bytes))).rejects.toMatchObject({ code });
    expect(methods(f)).not.toContain("putObject");
    expect(f.objects.size).toBe(0);
    expect(f.uploads.size).toBe(0);
  });

  it("contains a source error and rejects an invalid chunk before PUT", async () => {
    const f = cosFixture();
    await expect(
      write(
        f,
        (async function* () {
          yield Buffer.from("abc");
          throw new Error("synthetic private source diagnostic");
        })(),
      ),
    ).rejects.toMatchObject({
      code: "unavailable",
      message: "Publishing media store failure: unavailable",
    });
    await expect(
      write(
        f,
        (async function* () {
          yield "bad" as unknown as Uint8Array;
        })(),
      ),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    expect(methods(f)).not.toContain("putObject");
    expect(f.objects.size).toBe(0);
  });

  it("aborts a stalled producer and never PUTs a pre-aborted source", async () => {
    const f = cosFixture();
    const controller = new AbortController();
    let pulled!: () => void;
    const started = new Promise<void>((resolve) => {
      pulled = resolve;
    });
    const pending = write(
      f,
      {
        [Symbol.asyncIterator]: () => ({
          next: () => {
            pulled();
            return new Promise<IteratorResult<Uint8Array>>(() => {});
          },
        }),
      },
      6,
      controller.signal,
    );
    await started;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    await expect(
      write(f, chunks(Buffer.from("abcdef")), 6, controller.signal),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(methods(f)).not.toContain("putObject");
    expect(f.objects.size).toBe(0);
  });

  it.each([
    "<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>",
    "<VersioningConfiguration><Status>Suspended</Status></VersioningConfiguration>",
    "malformed",
  ])("keeps the fresh unversioned guard: %s", async (versioning) => {
    const f = cosFixture();
    await write(f);
    f.state.versioning = versioning;
    const before = f.calls.length;
    await expect(write(f)).rejects.toMatchObject({ code: "unavailable" });
    expect(methods(f).slice(before)).toEqual(["getBucketVersioning"]);
    expect(f.objects.size).toBe(1);
  });

  it("rejects a provider MD5 failure without retry or a committed object", async () => {
    const f = cosFixture();
    f.state.before = async (method, input) => {
      if (method === "putObject") {
        const body = input.Body as Buffer;
        body.writeUInt8(body.readUInt8(0) ^ 1, 0);
      }
    };
    await expect(write(f)).rejects.toMatchObject({ code: "unavailable" });
    expect(methods(f).filter((method) => method === "putObject")).toHaveLength(
      1,
    );
    expect(f.objects.size).toBe(0);
    expect(methods(f)).not.toContain("multipartInit");
  });

  it.each(["put-etag", "head-etag", "head-size"] as const)(
    "rejects %s and cleans only its committed object",
    async (fault) => {
      const f = cosFixture();
      f.state.after = (method, value) => {
        if (method === "putObject" && fault === "put-etag")
          value.ETag = '"bad"';
        if (method === "headObject") {
          const headers = value.headers as Record<string, string>;
          if (fault === "head-etag") headers.etag = '"bad"';
          if (fault === "head-size") headers["content-length"] = "7";
        }
      };
      await expect(write(f)).rejects.toMatchObject({ code: "unavailable" });
      expect(f.objects.size).toBe(0);
      expect(
        methods(f).filter((method) => method === "putObject"),
      ).toHaveLength(1);
      expect(methods(f)).toContain("deleteObject");
    },
  );

  it("refuses a final HEAD with a foreign ownership marker without deleting it", async () => {
    const f = cosFixture();
    f.state.after = (method) => {
      if (method === "putObject")
        for (const object of f.objects.values())
          object.headers["x-cos-meta-publishing-upload"] = "foreign-attempt";
    };
    await expect(write(f)).rejects.toMatchObject({ code: "unavailable" });
    expect(f.objects.size).toBe(1);
    expect(methods(f)).not.toContain("deleteObject");
  });

  it.each(["before-put", "during-put"] as const)(
    "preserves a colliding object %s",
    async (collision) => {
      const f = cosFixture();
      f.state.before = async (method, input) => {
        if (
          method === (collision === "before-put" ? "headObject" : "putObject")
        )
          f.objects.set(String(input.Key), {
            bytes: Buffer.from("foreign"),
            headers: { "x-cos-meta-publishing-upload": "foreign-attempt" },
            modified: new Date(),
          });
      };
      await expect(write(f)).rejects.toMatchObject({ code: "unavailable" });
      expect(
        [...f.objects.values()].map((object) => object.bytes.toString()),
      ).toEqual(["foreign"]);
      expect(methods(f)).not.toContain("deleteObject");
      expect(
        methods(f).filter((method) => method === "putObject"),
      ).toHaveLength(collision === "before-put" ? 0 : 1);
    },
  );

  it("cleans a lost PUT acknowledgement only when its own marker is present", async () => {
    const f = cosFixture();
    f.state.after = (method) => {
      if (method === "putObject") throw unavailable();
    };
    await expect(write(f)).rejects.toMatchObject({ code: "unavailable" });
    expect(f.objects.size).toBe(0);
    expect(methods(f).filter((method) => method === "putObject")).toHaveLength(
      1,
    );
    expect(methods(f)).toContain("deleteObject");
  });

  it("does not retry or delete when a PUT failed before committing", async () => {
    const f = cosFixture();
    f.state.before = async (method) => {
      if (method === "putObject") throw unavailable();
    };
    await expect(write(f)).rejects.toMatchObject({ code: "unavailable" });
    expect(f.objects.size).toBe(0);
    expect(methods(f).filter((method) => method === "putObject")).toHaveLength(
      1,
    );
    expect(methods(f)).not.toContain("deleteObject");
  });

  it("cleans its own committed object when cancellation follows PUT", async () => {
    const f = cosFixture();
    const controller = new AbortController();
    f.state.after = (method) => {
      if (method === "putObject") controller.abort();
    };
    await expect(
      write(f, chunks(Buffer.from("abcdef")), 6, controller.signal),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(f.objects.size).toBe(0);
    expect(methods(f)).toContain("deleteObject");
  });

  it("includes the exact 8 MiB boundary in the bounded PUT path", async () => {
    const f = cosFixture();
    await write(
      f,
      chunks(Buffer.alloc(PUBLISHING_COS_PART_BYTES, 42)),
      PUBLISHING_COS_PART_BYTES,
    );
    expect(methods(f)).toContain("putObject");
    expect(methods(f)).not.toContain("multipartInit");
  });

  it.each([
    ["original", 6, true],
    ["standard_master", 6, true],
    ["derivative", 6, false],
    ["derivative", PUBLISHING_COS_PART_BYTES + 1, true],
  ] as const)(
    "retains multipart for %s / %i bytes / exact=%s",
    async (purpose, bytes, exact) => {
      const f = cosFixture();
      const data = Buffer.alloc(bytes, 42);
      await f.store.writeStream(
        owner,
        purpose,
        "image/webp",
        bytes,
        chunks(data),
        {
          requireExactSize: exact,
        },
      );
      expect(methods(f)).toContain("multipartInit");
      expect(methods(f)).toContain("multipartComplete");
      expect(methods(f)).not.toContain("putObject");
      expect(f.objects.size).toBe(1);
      expect(f.uploads.size).toBe(0);
    },
  );
});
