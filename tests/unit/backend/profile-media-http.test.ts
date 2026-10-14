import { createHash, randomBytes } from "node:crypto";

import {
  createBackendApplication,
  createBackendServer,
  startServer,
  stopServer,
} from "@moya/backend-runtime";
import {
  apiErrorSchema,
  developmentSessionSchema,
} from "@moya/contracts/schemas";
import { afterEach, describe, expect, it } from "vitest";

import {
  FixtureCatalogPublicationPort,
  InMemoryCommunityCommentPort,
} from "./community-comment-fixture.js";
import {
  fixtureUsers,
  InMemoryCommunityIdentityPort,
} from "./community-identity-fixture.js";

import type {
  AuthorCommunityPort,
  ProfileRenditionReadTarget,
  PublishingMediaByteRange,
  PublishingMediaReadResult,
  PublishingMediaStorePort,
  WorkPublishingPort,
} from "@moya/api";
import type { ApiErrorCode, ProfileMediaRenditionRole } from "@moya/contracts";
import type { Server } from "node:http";

const mediaId = `user-media-${"0f".repeat(16)}`;
const storageKey = `blobs/aa/bb/${"c".repeat(32)}`;
const bytes = randomBytes(1000);
const sha256 = createHash("sha256").update(bytes).digest("hex");
const tag = `"${sha256}"`;

const target = (revalidate: boolean): ProfileRenditionReadTarget => ({
  storageKey,
  contentType: "image/webp",
  byteSize: bytes.byteLength,
  sha256,
  revalidate,
});

type Lookup = [
  viewer: string | null,
  mediaId: string,
  role: ProfileMediaRenditionRole,
];

/** Answers only the profile rendition lookup and records each call. */
const fakePort = (
  resolve: (...args: Lookup) => ProfileRenditionReadTarget | null,
) => {
  const lookups: Lookup[] = [];
  const port = {
    resolveProfileRenditionRead: async (...args: Lookup) => {
      lookups.push(args);
      return resolve(...args);
    },
  } as unknown as WorkPublishingPort;
  return { port, lookups };
};

/** Read-only in-memory store that counts every opened read. */
class CountingMediaStore {
  readonly blobs = new Map<string, Buffer>([[storageKey, bytes]]);
  opened = 0;

  async openRead(
    key: string,
    range?: PublishingMediaByteRange,
  ): Promise<PublishingMediaReadResult | null> {
    this.opened += 1;
    const blob = this.blobs.get(key);
    if (blob === undefined) return null;
    const byteSize = blob.byteLength;
    let start = 0;
    let end = byteSize - 1;
    if (range !== undefined && "suffixLength" in range)
      start = Math.max(0, byteSize - range.suffixLength);
    else if (range !== undefined) {
      start = range.start;
      end = Math.min(range.end ?? byteSize - 1, byteSize - 1);
    }
    if (start >= byteSize || start > end)
      return { status: "range_not_satisfiable", byteSize };
    const slice = blob.subarray(start, end + 1);
    return {
      status: "ok",
      byteSize,
      start,
      end,
      contentLength: slice.byteLength,
      body: (async function* () {
        yield slice;
      })(),
      close: async () => undefined,
    };
  }
}

const servers = new Set<Server>();
afterEach(async () => {
  for (const server of servers) await stopServer(server);
  servers.clear();
});

const start = async ({
  port,
  store,
}: {
  readonly port?: WorkPublishingPort;
  readonly store?: CountingMediaStore;
}) => {
  const original = new Uint8Array([137, 80, 78, 71]);
  const server = createBackendServer(
    createBackendApplication({
      nodeEnv: "development",
      communityIdentityPort: new InMemoryCommunityIdentityPort(),
      communityCommentPort: new InMemoryCommunityCommentPort(),
      catalogPublicationPort: new FixtureCatalogPublicationPort(),
      communityOperatorCredential:
        "synthetic-operator-credential-for-unit-tests",
      authorCommunityPort: {
        readMedia: async (id: string) =>
          id === mediaId ? { bytes: original, width: 1, height: 1 } : null,
      } as unknown as AuthorCommunityPort,
      ...(port === undefined ? {} : { workPublishingPort: port }),
      ...(store === undefined
        ? {}
        : {
            publishingMediaStore: store as unknown as PublishingMediaStorePort,
          }),
    }),
  );
  servers.add(server);
  const address = await startServer(server, { host: "127.0.0.1", port: 0 });
  const base = `http://${address.address}:${address.port}`;
  const signIn = async (handle: string) => {
    const response = await fetch(`${base}/v1/development/sign-in`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle }),
    });
    return developmentSessionSchema.parse(await response.json()).token;
  };
  const url = (role = "avatar-128", id = mediaId) =>
    `${base}/v1/community/media/${id}/${role}`;
  return { base, url, signIn, original };
};

const expectApiError = async (
  response: Response,
  status: number,
  code: ApiErrorCode,
) => {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("etag")).toBeNull();
  expect(apiErrorSchema.parse(await response.json()).error.code).toBe(code);
};

describe("profile media rendition route", () => {
  it("streams a current rendition privately with a strong ETag", async () => {
    const store = new CountingMediaStore();
    const fake = fakePort(() => target(true));
    const { url } = await start({ port: fake.port, store });

    const answer = await fetch(url());
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toBe("image/webp");
    expect(answer.headers.get("content-length")).toBe("1000");
    expect(answer.headers.get("cache-control")).toBe("private, no-store");
    expect(answer.headers.get("vary")).toBe("Authorization");
    expect(answer.headers.get("etag")).toBe(tag);
    expect(answer.headers.get("accept-ranges")).toBe("bytes");
    expect(answer.headers.get("x-content-type-options")).toBe("nosniff");
    expect(answer.headers.get("cross-origin-resource-policy")).toBe(
      "same-origin",
    );
    expect(Buffer.from(await answer.arrayBuffer())).toEqual(bytes);
    expect(fake.lookups).toEqual([[null, mediaId, "avatar-128"]]);
    expect(store.opened).toBe(1);
  });

  it.each([
    ["an exact tag", tag],
    ["a weak tag", `W/${tag}`],
    ["any tag", "*"],
    ["a list", `"${"0".repeat(64)}", W/${tag}`],
  ])(
    "answers 304 from the stored hash for %s without opening the store",
    async (_name, ifNoneMatch) => {
      const store = new CountingMediaStore();
      const fake = fakePort(() => target(true));
      const { url } = await start({ port: fake.port, store });

      for (const init of [
        { headers: { "if-none-match": ifNoneMatch } },
        { method: "HEAD", headers: { "if-none-match": ifNoneMatch } },
        { headers: { "if-none-match": ifNoneMatch, range: "bytes=0-9" } },
      ]) {
        const answer = await fetch(url("background-960"), init);
        expect(answer.status).toBe(304);
        expect(answer.headers.get("etag")).toBe(tag);
        expect(answer.headers.get("cache-control")).toBe("private, no-store");
        expect(answer.headers.get("vary")).toBe("Authorization");
        expect(answer.headers.get("x-content-type-options")).toBe("nosniff");
        expect(answer.headers.get("content-type")).toBeNull();
        expect(await answer.text()).toBe("");
      }
      expect(fake.lookups).toHaveLength(3);
      expect(store.opened).toBe(0);
    },
  );

  it("sends the bytes when If-None-Match names no current tag", async () => {
    const store = new CountingMediaStore();
    const fake = fakePort(() => target(true));
    const { url } = await start({ port: fake.port, store });

    for (const ifNoneMatch of [
      `"${"0".repeat(64)}"`,
      sha256,
      `w/${tag}`,
      `"${sha256.toUpperCase()}"`,
    ]) {
      const answer = await fetch(url(), {
        headers: { "if-none-match": ifNoneMatch },
      });
      expect(answer.status).toBe(200);
      expect(answer.headers.get("etag")).toBe(tag);
      expect(Buffer.from(await answer.arrayBuffer())).toEqual(bytes);
    }
    expect(store.opened).toBe(4);
  });

  it("never validates an owner-only rendition and passes the viewer on", async () => {
    const store = new CountingMediaStore();
    // A replaced avatar: only its owner still resolves it, never as current.
    const fake = fakePort((viewer) =>
      viewer === fixtureUsers.active.id ? target(false) : null,
    );
    const { url, signIn } = await start({ port: fake.port, store });
    const owner = await signIn(fixtureUsers.active.handle);
    const other = await signIn(fixtureUsers.second.handle);

    for (const ifNoneMatch of [undefined, tag, `W/${tag}`, "*"]) {
      const answer = await fetch(url("avatar-512"), {
        headers: {
          authorization: `Bearer ${owner}`,
          ...(ifNoneMatch === undefined
            ? {}
            : { "if-none-match": ifNoneMatch }),
        },
      });
      expect(answer.status).toBe(200);
      expect(answer.headers.get("etag")).toBeNull();
      expect(answer.headers.get("cache-control")).toBe("private, no-store");
      expect(answer.headers.get("vary")).toBe("Authorization");
      expect(Buffer.from(await answer.arrayBuffer())).toEqual(bytes);
    }
    expect(store.opened).toBe(4);

    for (const token of [other, undefined])
      await expectApiError(
        await fetch(url("avatar-512"), {
          headers: {
            "if-none-match": "*",
            ...(token === undefined
              ? {}
              : { authorization: `Bearer ${token}` }),
          },
        }),
        404,
        "ITEM_NOT_FOUND",
      );
    expect(fake.lookups.map(([viewer]) => viewer)).toEqual([
      fixtureUsers.active.id,
      fixtureUsers.active.id,
      fixtureUsers.active.id,
      fixtureUsers.active.id,
      fixtureUsers.second.id,
      null,
    ]);
    expect(store.opened).toBe(4);
  });

  it("answers HEAD, single byte ranges and unsatisfiable ranges", async () => {
    const store = new CountingMediaStore();
    const fake = fakePort(() => target(true));
    const { url } = await start({ port: fake.port, store });

    const head = await fetch(url(), { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("1000");
    expect(head.headers.get("etag")).toBe(tag);
    expect(await head.text()).toBe("");

    const part = await fetch(url(), { headers: { range: "bytes=10-19" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 10-19/1000");
    expect(part.headers.get("etag")).toBe(tag);
    expect(Buffer.from(await part.arrayBuffer())).toEqual(
      bytes.subarray(10, 20),
    );

    const headPart = await fetch(url(), {
      method: "HEAD",
      headers: { range: "bytes=-5" },
    });
    expect(headPart.status).toBe(206);
    expect(headPart.headers.get("content-range")).toBe("bytes 995-999/1000");
    expect(headPart.headers.get("content-length")).toBe("5");

    for (const range of ["bytes=1000-", "bytes=20-10"]) {
      const refused = await fetch(url(), { headers: { range } });
      expect(refused.status).toBe(416);
      expect(refused.headers.get("content-range")).toBe("bytes */1000");
      expect(refused.headers.get("cache-control")).toBe("private, no-store");
      await refused.arrayBuffer();
    }
  });

  it("refuses a query string with 422 before any lookup", async () => {
    const store = new CountingMediaStore();
    const fake = fakePort(() => target(true));
    const { url } = await start({ port: fake.port, store });

    for (const query of ["?v=1", "?download=1&v=2"])
      await expectApiError(
        await fetch(`${url()}${query}`, { headers: { "if-none-match": "*" } }),
        422,
        "INVALID_INPUT",
      );
    expect(fake.lookups).toHaveLength(0);
    expect(store.opened).toBe(0);
  });

  it("answers 404 for a malformed id or role and for an unavailable rendition", async () => {
    const store = new CountingMediaStore();
    const fake = fakePort((_viewer, _id, role) =>
      role === "background-1600" ? null : target(true),
    );
    const { url } = await start({ port: fake.port, store });

    for (const [role, id] of [
      ["avatar-64", mediaId],
      ["display", mediaId],
      ["original", mediaId],
      ["AVATAR-128", mediaId],
      ["avatar-128", `user-media-${"0F".repeat(16)}`],
      ["avatar-128", `user-media-${"0".repeat(31)}`],
      ["avatar-128", `media-item-${"0".repeat(32)}`],
      ["avatar-128", ""],
    ] as const)
      await expectApiError(await fetch(url(role, id)), 404, "ITEM_NOT_FOUND");
    expect(fake.lookups).toHaveLength(0);

    // Nothing to read: neither a validator nor bytes.
    await expectApiError(
      await fetch(url("background-1600"), {
        headers: { "if-none-match": "*" },
      }),
      404,
      "ITEM_NOT_FOUND",
    );
    expect(store.opened).toBe(0);

    // The record names a blob the store no longer has.
    store.blobs.clear();
    await expectApiError(await fetch(url()), 404, "ITEM_NOT_FOUND");
    expect(store.opened).toBe(1);
  });

  it("reports a missing publishing service or media store as 503", async () => {
    const withoutService = await start({});
    await expectApiError(
      await fetch(withoutService.url()),
      503,
      "SERVICE_UNAVAILABLE",
    );

    const fake = fakePort(() => target(true));
    const withoutStore = await start({ port: fake.port });
    await expectApiError(
      await fetch(withoutStore.url(), { headers: { "if-none-match": "*" } }),
      503,
      "SERVICE_UNAVAILABLE",
    );
    expect(fake.lookups).toHaveLength(0);
  });

  it("refuses an invalid credential before any lookup", async () => {
    const store = new CountingMediaStore();
    const fake = fakePort(() => target(true));
    const { url } = await start({ port: fake.port, store });

    await expectApiError(
      await fetch(url(), { headers: { authorization: "Bearer invalid" } }),
      401,
      "UNAUTHENTICATED",
    );
    expect(fake.lookups).toHaveLength(0);
  });

  it("leaves the original image route and other methods unchanged", async () => {
    const store = new CountingMediaStore();
    const fake = fakePort(() => target(true));
    const { base, url, original } = await start({ port: fake.port, store });

    const image = await fetch(`${base}/v1/community/media/${mediaId}`, {
      headers: { "if-none-match": "*" },
    });
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("cache-control")).toBe("private, no-store");
    expect(image.headers.get("etag")).toBeNull();
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(original);

    for (const method of ["POST", "PUT", "DELETE"])
      await expectApiError(
        await fetch(url(), { method }),
        404,
        "ITEM_NOT_FOUND",
      );
    expect(fake.lookups).toHaveLength(0);
    expect(store.opened).toBe(0);
  });
});
