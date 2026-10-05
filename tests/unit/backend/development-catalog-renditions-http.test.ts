import { request as httpRequest } from "node:http";

import { createLocalStorageUrlResolver } from "@moya/backend-production/internal/local-media";
import {
  createBackendApplication,
  createDevelopmentCatalogFixtureQueryPort,
  parseRuntimeConfig,
  startBackendProcess,
} from "@moya/backend-runtime";
import { UnconfiguredStorageUrlResolver } from "@moya/image";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InMemoryCommunityIdentityPort } from "./community-identity-fixture.js";

import type {
  PublishingMediaReadResult,
  PublishingMediaReadTarget,
  PublishingMediaStorePort,
} from "@moya/api";
import type {
  BackendProcessHandle,
  NodeEnvironment,
} from "@moya/backend-runtime";

/*
 * The Development-only Catalog rendition route (unified media pipeline,
 * PR 1b): GET /v1/development/catalog-renditions/<rendition id>, composed
 * only under NODE_ENV=development with its delivery port, streams the
 * committed blob of a listed rendition, private and never cached; every
 * other request answers 404 without detail.
 */

const renditionId = `media-rendition-${"0123456789abcdef".repeat(2)}`;
const storageKey = `blobs/aa/bb/${"c".repeat(32)}`;
const bytes = Buffer.from("RIFF\u0010\u0000\u0000\u0000WEBPsynthetic");
const target: PublishingMediaReadTarget = {
  storageKey,
  contentType: "image/webp",
  byteSize: bytes.length,
  sha256: "d".repeat(64),
};

const handles = new Set<BackendProcessHandle>();
afterEach(async () => {
  for (const handle of handles) await handle.shutdown();
  handles.clear();
  vi.restoreAllMocks();
});

const opened = (size = bytes.length): PublishingMediaReadResult => ({
  status: "ok",
  byteSize: size,
  start: 0,
  end: size - 1,
  contentLength: size,
  body: (async function* () {
    yield bytes;
  })(),
  close: vi.fn(async () => undefined),
});

const delivery = (
  options: {
    readonly target?: PublishingMediaReadTarget | null;
    readonly read?: PublishingMediaReadResult | null;
  } = {},
) => {
  const resolve = vi.fn(async (id: string) =>
    id === renditionId
      ? options.target === undefined
        ? target
        : options.target
      : null,
  );
  const openRead = vi.fn(async () =>
    options.read === undefined ? opened() : options.read,
  );
  const store = { openRead } as unknown as PublishingMediaStorePort;
  return { resolve, openRead, store };
};

const start = async (
  nodeEnv: NodeEnvironment,
  renditions?: ReturnType<typeof delivery>,
) => {
  const handle = await startBackendProcess({
    listen: { host: "127.0.0.1", port: 0 },
    requestListener: createBackendApplication({
      nodeEnv,
      catalogQueryPort: createDevelopmentCatalogFixtureQueryPort(),
      storageUrlResolver: new UnconfiguredStorageUrlResolver(),
      communityIdentityPort: new InMemoryCommunityIdentityPort(),
      ...(renditions === undefined
        ? {}
        : {
            developmentCatalogRenditions: {
              resolve: renditions.resolve,
              store: renditions.store,
            },
          }),
    }),
  });
  handles.add(handle);
  return handle.address.port;
};

/** One raw request (the target is sent exactly as given). */
const raw = (port: number, path: string, method = "GET") =>
  new Promise<{
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: Buffer;
  }>((resolve, reject) => {
    const outgoing = httpRequest(
      { host: "127.0.0.1", port, path, method },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () =>
          resolve({
            status: incoming.statusCode ?? 0,
            headers: incoming.headers,
            body: Buffer.concat(chunks),
          }),
        );
        incoming.on("error", reject);
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });

const path = `/v1/development/catalog-renditions/${renditionId}`;

describe("Development Catalog rendition route", () => {
  it("streams the committed blob with its recorded type and length, private and never cached", async () => {
    const renditions = delivery();
    const port = await start("development", renditions);
    const response = await raw(port, path);
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("image/webp");
    expect(response.headers["content-length"]).toBe(String(bytes.length));
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.body.equals(bytes)).toBe(true);
    expect(renditions.resolve).toHaveBeenCalledWith(renditionId);
    expect(renditions.openRead).toHaveBeenCalledWith(storageKey);
  });

  it("serves exactly the URL the Development resolver names", async () => {
    const renditions = delivery();
    const port = await start("development", renditions);
    const environment = {
      NODE_ENV: "development",
      CMS_ENVIRONMENT: "synthetic",
      CMS_STORAGE_MODE: "local",
      PUBLIC_MEDIA_BASE_URL: "http://127.0.0.1:3002",
      HOST: "127.0.0.1",
      PORT: String(port),
    };
    const named = (
      await createLocalStorageUrlResolver(
        environment,
        parseRuntimeConfig(environment),
      ).resolveKeys([renditionId])
    ).get(renditionId)!;
    expect(named).toBe(`http://127.0.0.1:${port}${path}`);
    const response = await fetch(named);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
  });

  it.each([
    ["Production", "production" as const, true],
    ["Development without a delivery port", "development" as const, false],
  ])("is absent in %s", async (_label, nodeEnv, composed) => {
    const renditions = delivery();
    const port = await start(nodeEnv, composed ? renditions : undefined);
    const response = await raw(port, path);
    expect(response.status).toBe(404);
    expect(renditions.resolve).not.toHaveBeenCalled();
    expect(renditions.openRead).not.toHaveBeenCalled();
  });

  it.each([
    ["a query", `${path}?size=large`, "GET"],
    ["an empty query", `${path}?`, "GET"],
    ["a trailing slash", `${path}/`, "GET"],
    [
      "a dot segment",
      `/v1/development/x/../catalog-renditions/${renditionId}`,
      "GET",
    ],
    ["an encoded id", path.replace("media-", "media%2D"), "GET"],
    [
      "another id form",
      `/v1/development/catalog-renditions/media-item-${"0".repeat(32)}`,
      "GET",
    ],
    [
      "an uppercase id",
      `/v1/development/catalog-renditions/media-rendition-${"0123456789ABCDEF".repeat(2)}`,
      "GET",
    ],
    ["HEAD", path, "HEAD"],
    ["POST", path, "POST"],
  ])("answers 404 for %s", async (_label, target, method) => {
    const renditions = delivery();
    const port = await start("development", renditions);
    const response = await raw(port, target, method);
    expect(response.status).toBe(404);
    expect(renditions.openRead).not.toHaveBeenCalled();
    if (method === "GET") {
      expect(response.body.toString("utf8")).not.toContain("media-rendition");
      expect(response.body.toString("utf8")).not.toContain("blobs/");
    }
  });

  it.each([
    ["a rendition the delivery view does not list", { target: null }],
    [
      "a blob the store does not hold",
      { read: null } as { readonly read: null },
    ],
    ["a blob of another length", { read: opened(bytes.length + 1) }],
    [
      "a type the route never sends",
      { target: { ...target, contentType: "video/mp4" as const } },
    ],
    [
      "a JPEG before the shared read target supports it",
      {
        target: {
          ...target,
          contentType: "image/jpeg",
        } as unknown as PublishingMediaReadTarget,
      },
    ],
  ])("answers 404 without detail for %s", async (_label, options) => {
    const renditions = delivery(options);
    const port = await start("development", renditions);
    const response = await raw(port, path);
    expect(response.status).toBe(404);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(JSON.parse(response.body.toString("utf8"))).toEqual({
      error: { status: 404, message: "Not Found" },
    });
  });
});
