import { describe, expect, it, vi } from "vitest";
import type { PayloadRequest } from "payload";

import { createLocalStorageUrlResolver } from "@moya/backend-production/internal/local-media";
import { parseRuntimeConfig } from "@moya/backend-runtime";
import { createLocalPublishedMediaReadAccess } from "admin/local-media-read";

const environment = {
  NODE_ENV: "development",
  CMS_ENVIRONMENT: "synthetic",
  CMS_STORAGE_MODE: "local",
  PUBLIC_MEDIA_BASE_URL: "http://127.0.0.1:3002",
};
const filename = `${"b".repeat(64)}-${"c".repeat(64)}.webp`;
const objectKey = `editorial/${"a".repeat(64)}/${filename}`;

describe("existing local Payload media delivery", () => {
  it("maps a published upload locator to the loopback native file URL without COS or local paths", async () => {
    const resolver = createLocalStorageUrlResolver(environment);
    const result = await resolver.resolveMany([
      { mediaId: "synthetic-local-media", objectKey },
    ]);
    expect(result.get("synthetic-local-media")).toBe(
      `http://127.0.0.1:3002/api/media/file/${filename}`,
    );
    expect(result.get("synthetic-local-media")).not.toContain(objectKey);
  });

  it.each([
    { NODE_ENV: "production" },
    { NODE_ENV: "test" },
    { CMS_ENVIRONMENT: "staging" },
    { CMS_STORAGE_MODE: "cos" },
    { PUBLIC_MEDIA_BASE_URL: "" },
    { PUBLIC_MEDIA_BASE_URL: "https://media.example.invalid" },
    { PUBLIC_MEDIA_BASE_URL: "http://example.invalid" },
    { PUBLIC_MEDIA_BASE_URL: "http://127.0.0.1:3002/api" },
    { PUBLIC_MEDIA_BASE_URL: "http://127.0.0.1:3002/?secret=synthetic" },
    { PUBLIC_MEDIA_BASE_URL: "http://127.0.0.1:3002/#fragment" },
    { PUBLIC_MEDIA_BASE_URL: "http://synthetic@127.0.0.1:3002" },
  ])("fails closed for invalid local configuration %j", (invalid) => {
    expect(() =>
      createLocalStorageUrlResolver({ ...environment, ...invalid }),
    ).toThrow();
  });

  const renditionId = `media-rendition-${"0123456789abcdef".repeat(2)}`;

  it("names a Catalog rendition id on the Backend's own loopback Development route", async () => {
    // Without HOST and PORT the Development listener is 127.0.0.1:3001.
    const resolver = createLocalStorageUrlResolver(environment);
    expect([...(await resolver.resolveKeys([renditionId]))]).toEqual([
      [
        renditionId,
        `http://127.0.0.1:3001/v1/development/catalog-renditions/${renditionId}`,
      ],
    ]);
    // The listen configuration names the port; the URL shape stays fixed.
    for (const listen of [
      { HOST: "127.0.0.1", PORT: "4310" },
      { HOST: "localhost", PORT: "4311" },
      { HOST: "::1", PORT: "4312" },
    ]) {
      const configured = { ...environment, ...listen };
      expect(
        (
          await createLocalStorageUrlResolver(
            configured,
            parseRuntimeConfig(configured),
          ).resolveKeys([renditionId])
        ).get(renditionId),
      ).toBe(
        `http://127.0.0.1:${listen.PORT}/v1/development/catalog-renditions/${renditionId}`,
      );
    }
  });

  it.each([
    `blobs/aa/bb/${"c".repeat(32)}`,
    objectKey,
    `media-rendition-${"A".repeat(32)}`,
    `media-rendition-${"0".repeat(31)}`,
    `${renditionId}/../file`,
    `media-item-${"0".repeat(32)}`,
    "",
  ])("leaves out a key that is not a rendition id: %j", async (key) => {
    expect(
      (await createLocalStorageUrlResolver(environment).resolveKeys([key]))
        .size,
    ).toBe(0);
  });

  it.each(["0.0.0.0", "192.0.2.10", "media.example.invalid"])(
    "refuses a Backend listener that is not loopback: %s",
    (host) => {
      expect(() =>
        createLocalStorageUrlResolver({ ...environment, HOST: host }),
      ).toThrow("Local media requires a loopback Backend listener");
      expect(() =>
        createLocalStorageUrlResolver(
          environment,
          parseRuntimeConfig({ ...environment, HOST: host }),
        ),
      ).toThrow("Local media requires a loopback Backend listener");
    },
  );

  it.each([
    "/private/synthetic/file.webp",
    "editorial/../../private.webp",
    "https://example.invalid/arbitrary.webp",
    `editorial/private-user/${filename}`,
    `${objectKey}?arbitrary=value`,
    `editorial/${"a".repeat(64)}/private-title.webp`,
  ])("rejects non-upload keys instead of deriving paths: %s", async (key) => {
    await expect(
      createLocalStorageUrlResolver(environment).resolveMany([
        { mediaId: "synthetic-local-media", objectKey: key },
      ]),
    ).rejects.toThrow("Invalid local media object key");
  });

  const request = (find = vi.fn(), method = "GET") =>
    ({ method, payload: { find } }) as unknown as PayloadRequest;

  it("requires the native static-file marker, GET and all development guards before a query", async () => {
    for (const patch of [
      {},
      { NODE_ENV: "production" },
      { NODE_ENV: "test" },
      { CMS_ENVIRONMENT: "staging" },
      { CMS_STORAGE_MODE: "cos" },
    ]) {
      const find = vi.fn();
      const access = createLocalPublishedMediaReadAccess(() => false, {
        ...environment,
        ...patch,
      });
      const req = request(find);
      expect(await access({ req, data: { filename } })).toBe(false);
      if (Object.keys(patch).length > 0)
        expect(
          await access({ req, data: { filename }, isReadingStaticFile: true }),
        ).toBe(false);
      expect(find).not.toHaveBeenCalled();
    }
    const find = vi.fn();
    const access = createLocalPublishedMediaReadAccess(
      () => false,
      environment,
    );
    const req = request(find, "POST");
    expect(
      await access({ req, data: { filename }, isReadingStaticFile: true }),
    ).toBe(false);
    expect(find).not.toHaveBeenCalled();
  });

  it("keeps owner and scoped automation authorization unchanged", async () => {
    const find = vi.fn();
    for (const result of [true, { catalogId: { in: ["synthetic-catalog"] } }]) {
      const access = createLocalPublishedMediaReadAccess(
        () => result,
        environment,
      );
      expect(await access({ req: request(find) })).toEqual(result);
    }
    expect(find).not.toHaveBeenCalled();
  });

  it("authorizes only an exact uploaded key in a committed published snapshot", async () => {
    const find = vi
      .fn()
      .mockResolvedValueOnce({ docs: [{ id: 7, objectKey }] })
      .mockResolvedValueOnce({ docs: [{ id: 9 }] });
    const req = request(find);
    const access = createLocalPublishedMediaReadAccess(
      () => false,
      environment,
    );
    expect(
      await access({ req, data: { filename }, isReadingStaticFile: true }),
    ).toEqual({ id: { equals: 7 } });
    expect(find).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        collection: "media",
        where: {
          and: [
            { filename: { equals: filename } },
            { origin: { equals: "upload" } },
          ],
        },
      }),
    );
    expect(find).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        collection: "catalogs",
        draft: false,
        where: {
          and: [
            { _status: { equals: "published" } },
            { "media.objectKey": { equals: objectKey } },
          ],
        },
      }),
    );
  });

  it("denies unpublished, withdrawn or missing local media", async () => {
    for (const documents of [[], [{ id: 7, objectKey }]]) {
      const find = vi
        .fn()
        .mockResolvedValueOnce({ docs: documents })
        .mockResolvedValueOnce({ docs: [] });
      const access = createLocalPublishedMediaReadAccess(
        () => false,
        environment,
      );
      expect(
        await access({
          req: request(find),
          data: { filename },
          isReadingStaticFile: true,
        }),
      ).toBe(false);
    }
  });
});
