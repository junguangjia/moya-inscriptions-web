import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";
import {
  createLocalPublicationProvider,
  createLocalPublicationReadHandler,
  parsePublicationConfig,
  PUBLICATION_CACHE_CONTROL,
} from "@moya/backend-production/internal/publication";
import type { IncomingHttpHeaders, RequestListener } from "node:http";
import type { PublicationConfig } from "@moya/backend-production/internal/publication";

const key = `v1/${"a".repeat(32)}/${"b".repeat(32)}/base/display.r1.webp`;
const bytes = Buffer.from("synthetic-published-derivative");
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(overrides: Partial<PublicationConfig> = {}) {
  const root = await mkdtemp(join(tmpdir(), "local-publication-read-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  let listener: RequestListener = (_request, response) => {
    response.statusCode = 503;
    response.end();
  };
  const server = createServer((request, response) =>
    listener.call(server, request, response),
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  cleanups.unshift(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing synthetic fixture listener");
  const origin = `http://127.0.0.1:${address.port}`;
  const config = parsePublicationConfig(
    {
      PRODUCT_ACCESS_MODE: "public",
      MEDIA_PUBLICATION: "on",
      MEDIA_PUBLIC_DELIVERY: "relay",
      MEDIA_PUBLISHED_LOCAL_ROOT: root,
      MEDIA_PUBLISHED_ORIGIN: origin,
    },
    "development",
  );
  const provider = createLocalPublicationProvider(config);
  await provider.write(
    { objectKey: key, contentType: "image/webp", byteSize: bytes.length },
    Readable.from([bytes]),
  );
  let delegated = 0;
  const next: RequestListener = (_request, response) => {
    delegated++;
    response.statusCode = 418;
    response.end();
  };
  listener = createLocalPublicationReadHandler(
    { ...config, ...overrides },
    next,
  );
  const fetch = (
    path = `/${key}`,
    method = "GET",
    headers: IncomingHttpHeaders = {},
  ) =>
    new Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>(
      (resolve, reject) => {
        const request = httpRequest(
          `${origin}${path}`,
          { method, headers },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
            response.once("error", reject);
            response.once("end", () =>
              resolve({
                status: response.statusCode ?? 0,
                headers: response.headers,
                body: Buffer.concat(chunks),
              }),
            );
          },
        );
        request.once("error", reject);
        request.end();
      },
    );
  return { root, origin, config, provider, fetch, delegated: () => delegated };
}

describe("Development published origin on the existing Backend listener", () => {
  it("streams a public relay-preparation object with matching GET/HEAD/304 validators", async () => {
    const f = await fixture();
    const get = await f.fetch(`/${key}`, "GET", {
      origin: "http://localhost:3000",
    });
    expect(get).toMatchObject({
      status: 200,
      body: bytes,
      headers: {
        "content-type": "image/webp",
        "content-length": String(bytes.length),
        "cache-control": PUBLICATION_CACHE_CONTROL,
        "access-control-allow-origin": "*",
        "accept-ranges": "bytes",
        "x-content-type-options": "nosniff",
      },
    });
    expect(get.headers.etag).toMatch(/^W\/"[0-9a-f]{64}"$/u);
    const head = await f.fetch(`/${key}`, "HEAD");
    expect(head).toMatchObject({
      status: 200,
      body: Buffer.alloc(0),
      headers: {
        "content-length": String(bytes.length),
        etag: get.headers.etag,
      },
    });
    const cached = await f.fetch(`/${key}`, "GET", {
      "if-none-match": get.headers.etag,
      origin: "http://localhost:3000",
    });
    expect(cached).toMatchObject({
      status: 304,
      body: Buffer.alloc(0),
      headers: {
        "cache-control": PUBLICATION_CACHE_CONTROL,
        "access-control-allow-origin": "*",
        etag: get.headers.etag,
      },
    });
    expect(f.delegated()).toBe(0);
  });

  it("handles bounded ranges and ignores a weak If-Range validator", async () => {
    const f = await fixture();
    const get = await f.fetch();
    expect(
      await f.fetch(`/${key}`, "GET", { range: "bytes=2-5" }),
    ).toMatchObject({
      status: 206,
      body: bytes.subarray(2, 6),
      headers: {
        "content-range": `bytes 2-5/${bytes.length}`,
        "content-length": "4",
      },
    });
    expect(
      await f.fetch(`/${key}`, "GET", { range: "bytes=-3" }),
    ).toMatchObject({ status: 206, body: bytes.subarray(bytes.length - 3) });
    expect(
      await f.fetch(`/${key}`, "HEAD", { range: "bytes=2-5" }),
    ).toMatchObject({
      status: 200,
      body: Buffer.alloc(0),
      headers: { "content-length": String(bytes.length) },
    });
    expect(
      await f.fetch(`/${key}`, "GET", {
        range: "bytes=2-5",
        "if-range": get.headers.etag,
      }),
    ).toMatchObject({ status: 200, body: bytes });
    for (const range of [
      "bytes=999-",
      "bytes=2-1",
      "bytes=-0",
      "bytes=0-1,3-4",
      "bytes=9007199254740993-",
    ]) {
      expect(await f.fetch(`/${key}`, "GET", { range })).toMatchObject({
        status: 416,
        body: Buffer.alloc(0),
        headers: { "content-range": `bytes */${bytes.length}` },
      });
    }
  });

  it("denies Beta GET/HEAD/validators before serving an already copied file", async () => {
    const f = await fixture({ productMode: "closed-beta", delivery: "edge" });
    for (const method of ["GET", "HEAD"]) {
      expect(
        await f.fetch(`/${key}`, method, {
          "if-none-match": "*",
          range: "bytes=0-0",
        }),
      ).toMatchObject({
        status: 404,
        body: Buffer.alloc(0),
        headers: {
          "cache-control": "private, no-store",
          "content-length": "0",
        },
      });
    }
    expect(f.delegated()).toBe(0);
  });

  it("delegates Production and unrelated APIs and rejects a mismatched origin Host", async () => {
    const production = await fixture({ nodeEnv: "production" });
    expect(await production.fetch()).toMatchObject({
      status: 418,
      body: Buffer.alloc(0),
    });
    expect(production.delegated()).toBe(1);
    const development = await fixture();
    expect(await development.fetch("/v1/community/access")).toMatchObject({
      status: 418,
    });
    expect(development.delegated()).toBe(1);
    expect(
      await development.fetch(`/${key}`, "GET", {
        host: "foreign.synthetic.test",
      }),
    ).toMatchObject({
      status: 404,
      headers: { "cache-control": "private, no-store" },
    });
  });

  it("rejects mutation methods, queries, unsupported formats and decoded path tricks", async () => {
    const f = await fixture();
    expect(await f.fetch(`/${key}`, "POST")).toMatchObject({
      status: 405,
      headers: { allow: "GET, HEAD", "cache-control": "private, no-store" },
    });
    for (const path of [
      `/${key}?x=1`,
      `/${key.replace(".webp", ".heic")}`,
      `/${key.replace("/base/", "/%62ase/")}`,
      `/${key.replace("display", "original")}`,
    ]) {
      expect(await f.fetch(path)).toMatchObject({
        status: 404,
        body: Buffer.alloc(0),
        headers: { "cache-control": "private, no-store" },
      });
    }
  });

  it("never follows a derivative or parent symlink and returns 404 after withdrawal", async () => {
    const f = await fixture();
    await f.provider.remove(key);
    expect(await f.fetch()).toMatchObject({
      status: 404,
      headers: { "cache-control": "private, no-store" },
    });
    const external = join(f.root, "synthetic-private-source");
    await writeFile(external, "synthetic-private-original");
    await symlink(external, join(f.root, key));
    expect(await f.fetch()).toMatchObject({
      status: 404,
      body: Buffer.alloc(0),
    });
    await rm(dirname(join(f.root, key)), { recursive: true });
    const alternate = join(f.root, "synthetic-parent");
    await mkdir(alternate);
    await writeFile(
      join(alternate, "display.r1.webp"),
      "synthetic-private-original",
    );
    await symlink(alternate, dirname(join(f.root, key)));
    expect(await f.fetch()).toMatchObject({
      status: 404,
      body: Buffer.alloc(0),
    });
  });
});
