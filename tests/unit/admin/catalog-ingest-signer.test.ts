import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CATALOG_INGEST_STAGING_TAGGING,
  CATALOG_ORIGINAL_MAX_BYTES,
  editorialMediaIngestStartResultSchema,
} from "@moya/contracts/internal/editorial";
import {
  catalogIngestDevelopmentStore,
  catalogIngestEnabled,
  catalogIngestSettings,
  cmsRuntimeLogFields,
} from "admin/runtime-settings";
import {
  INGEST_URL_TTL_SECONDS,
  LocalIngestStorage,
  createCosIngestStorage,
  signStagingPut,
  stagingKeyFor,
  stagingSigner,
} from "admin/media-ingest-storage";

/*
 * catalog-scale-v1 increment 2: the Admin's only presigner. It signs one
 * staging PUT for at most 300 s with exactly the contract's header set, and
 * refuses any other key, method, header or lifetime. Every host is a .test
 * name and every credential synthetic; nothing here reaches a network.
 */

const SECRET = "synthetic-signer-secret";
const ACCESS = "SYNTHETICSIGNERKEY";
const REGION = "synthetic-region";
const BUCKET = "synthetic-ingest-1250000000";
const uploadEndpoint = new URL("https://cos.upload.example.test");
const signingDate = new Date(Date.UTC(2026, 9, 23, 12, 0, 0));
const ingestId = createHash("sha256").update("synthetic-ingest").digest("hex");
const key = stagingKeyFor(ingestId);
const md5 = createHash("md5").update("synthetic-bytes").digest("base64");
const headers = (extra: Record<string, string> = {}) => ({
  "content-length": "73400320",
  "content-type": "image/jpeg",
  "x-cos-forbid-overwrite": "true",
  "content-md5": md5,
  ...extra,
});
// Presigning is local: the signing client never sends a request.
const signer = () =>
  stagingSigner({
    endpoint: new URL("https://cos.admin-intranet.example.test"),
    uploadEndpoint,
    region: REGION,
    bucket: BUCKET,
    accessKeyId: ACCESS,
    secretAccessKey: SECRET,
  });
const sign = (
  request: Partial<Parameters<typeof signStagingPut>[1]> = {},
): Promise<string> =>
  signStagingPut(signer(), {
    method: "PUT",
    key,
    headers: headers(),
    expiresIn: INGEST_URL_TTL_SECONDS,
    signingDate,
    ...request,
  });

// An independent SigV4 query-signature computation (the AWS algorithm), so
// the signer's output is checked against the specification, not itself.
const rfc3986 = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
const expectedSignature = (url: URL, signed: Record<string, string>) => {
  const query = [...url.searchParams]
    .filter(([name]) => name !== "X-Amz-Signature")
    .map(([name, value]) => [rfc3986(name), rfc3986(value)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  const names = url.searchParams.get("X-Amz-SignedHeaders")!.split(";");
  const canonical = [
    "PUT",
    url.pathname,
    query,
    names.map((name) => `${name}:${signed[name]!.trim()}\n`).join(""),
    names.join(";"),
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const date = url.searchParams.get("X-Amz-Date")!;
  const scope = `${date.slice(0, 8)}/${REGION}/s3/aws4_request`;
  const hmac = (secret: string | Buffer, value: string) =>
    createHmac("sha256", secret).update(value).digest();
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${SECRET}`, date.slice(0, 8)), REGION), "s3"),
    "aws4_request",
  );
  return createHmac("sha256", signingKey)
    .update(
      [
        "AWS4-HMAC-SHA256",
        date,
        scope,
        createHash("sha256").update(canonical).digest("hex"),
      ].join("\n"),
    )
    .digest("hex");
};

describe("the staging PUT signer", () => {
  it("signs exactly host, content-length, content-md5, content-type and x-cos-forbid-overwrite", async () => {
    const url = new URL(await sign());
    expect(url.protocol).toBe("https:");
    expect(url.host).toBe(`${BUCKET}.${uploadEndpoint.host}`);
    expect(url.pathname).toMatch(
      /^\/catalog-ingest\/v1\/[a-f0-9]{2}\/[a-f0-9]{64}$/,
    );
    expect(url.pathname).toBe(`/${key}`);
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe(
      "content-length;content-md5;content-type;host;x-cos-forbid-overwrite",
    );
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(url.searchParams.get("X-Amz-Date")).toBe("20261023T120000Z");
    expect(url.searchParams.get("X-Amz-Credential")).toBe(
      `${ACCESS}/20261023/${REGION}/s3/aws4_request`,
    );
    expect(url.searchParams.get("X-Amz-Signature")).toBe(
      expectedSignature(url, {
        ...headers(),
        host: `${BUCKET}.${uploadEndpoint.host}`,
      }),
    );
  });

  it("binds x-cos-tagging under the tag lifecycle (L1)", async () => {
    const tagged = headers({ "x-cos-tagging": CATALOG_INGEST_STAGING_TAGGING });
    const url = new URL(await sign({ headers: tagged }));
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe(
      "content-length;content-md5;content-type;host;x-cos-forbid-overwrite;x-cos-tagging",
    );
    expect(url.searchParams.get("X-Amz-Signature")).toBe(
      expectedSignature(url, {
        ...tagged,
        host: `${BUCKET}.${uploadEndpoint.host}`,
      }),
    );
    // A different value for any signed header gives a different signature.
    expect(
      expectedSignature(url, {
        ...tagged,
        "content-length": "73400321",
        host: `${BUCKET}.${uploadEndpoint.host}`,
      }),
    ).not.toBe(url.searchParams.get("X-Amz-Signature"));
  });

  it("carries no checksum, copy-source, ACL, metadata or token parameter", async () => {
    const url = new URL(await sign());
    expect([...url.searchParams.keys()].sort()).toEqual([
      "X-Amz-Algorithm",
      "X-Amz-Content-Sha256",
      "X-Amz-Credential",
      "X-Amz-Date",
      "X-Amz-Expires",
      "X-Amz-Signature",
      "X-Amz-SignedHeaders",
      "x-id",
    ]);
    expect(url.searchParams.get("X-Amz-Content-Sha256")).toBe(
      "UNSIGNED-PAYLOAD",
    );
    expect(url.href).not.toMatch(
      /checksum|copy-source|acl|metadata|security-token/i,
    );
  });

  it("refuses any key but a staging key", async () => {
    for (const other of [
      `editorial/${"a".repeat(64)}/${"b".repeat(64)}-${"c".repeat(64)}.jpg`,
      `catalog-ingest/v1/zz/${ingestId}`,
      `catalog-ingest/v1/${ingestId.slice(0, 2)}/${ingestId}/extra`,
      `catalog-ingest/v2/${ingestId.slice(0, 2)}/${ingestId}`,
      `catalog-ingest/v1/${ingestId.slice(0, 2)}/${ingestId.toUpperCase()}`,
      `/catalog-ingest/v1/${ingestId.slice(0, 2)}/${ingestId}`,
      "",
    ])
      await expect(sign({ key: other })).rejects.toThrow(
        "INGEST_SIGNER_REFUSED",
      );
  });

  it("refuses any other method and any lifetime over 300 s", async () => {
    for (const method of ["GET", "HEAD", "POST", "DELETE", "put"])
      await expect(sign({ method })).rejects.toThrow("INGEST_SIGNER_REFUSED");
    for (const expiresIn of [301, 0, -1, 299.5, 3600])
      await expect(sign({ expiresIn })).rejects.toThrow(
        "INGEST_SIGNER_REFUSED",
      );
    await expect(sign({ signingDate: new Date(Number.NaN) })).rejects.toThrow(
      "INGEST_SIGNER_REFUSED",
    );
  });

  it("refuses an unsigned extra header, a missing one and a malformed value", async () => {
    for (const extra of [
      "x-cos-copy-source",
      "x-amz-copy-source",
      "x-cos-acl",
      "x-amz-acl",
      "x-cos-metadata-directive",
      "x-amz-metadata-directive",
      "x-amz-checksum-crc32",
      "authorization",
      "cache-control",
    ])
      await expect(
        sign({ headers: headers({ [extra]: "anything" }) }),
      ).rejects.toThrow("INGEST_SIGNER_REFUSED");
    for (const name of [
      "content-length",
      "content-type",
      "x-cos-forbid-overwrite",
      "content-md5",
    ]) {
      const partial: Record<string, string> = headers();
      delete partial[name];
      await expect(sign({ headers: partial })).rejects.toThrow(
        "INGEST_SIGNER_REFUSED",
      );
    }
    for (const [name, value] of [
      ["content-length", "0"],
      ["content-length", String(CATALOG_ORIGINAL_MAX_BYTES + 1)],
      ["content-length", "1e6"],
      ["content-type", "image/gif"],
      ["x-cos-forbid-overwrite", "false"],
      ["content-md5", "not-a-digest"],
      ["x-cos-tagging", "moya-ingest-staging=v2"],
    ] as const)
      await expect(
        sign({ headers: { ...headers(), [name]: value } }),
      ).rejects.toThrow("INGEST_SIGNER_REFUSED");
  });

  it("signs for the configured upload endpoint and expires 300 s ahead (COS store)", async () => {
    const storage = createCosIngestStorage({
      endpoint: new URL("https://cos.admin-intranet.example.test"),
      uploadEndpoint,
      region: REGION,
      bucket: BUCKET,
      accessKeyId: ACCESS,
      secretAccessKey: SECRET,
      stagingTag: false,
    });
    const now = new Date(Date.now() + 750);
    const { url, expiresAt } = await storage.signUpload(
      key,
      headers() as never,
      now,
    );
    const parsed = new URL(url);
    expect(parsed.host).toBe(`${BUCKET}.${uploadEndpoint.host}`);
    expect(parsed.searchParams.get("X-Amz-Expires")).toBe("300");
    const seconds = Math.floor(now.getTime() / 1000);
    expect(expiresAt.getTime()).toBe((seconds + 300) * 1000);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(expiresAt.getTime() - now.getTime()).toBeLessThanOrEqual(300_000);
    // The start result accepts exactly this upload description.
    expect(
      editorialMediaIngestStartResultSchema.safeParse({
        state: "upload",
        ingestId,
        upload: {
          method: "PUT",
          url,
          headers: headers(),
          expiresAt: expiresAt.toISOString(),
        },
      }).success,
    ).toBe(true);
  });
});

describe("the Development store's dev PUT", () => {
  let parent: string;
  let storage: LocalIngestStorage;
  const bytes = randomBytes(4096);
  const digest = createHash("md5").update(bytes).digest("base64");
  const devHeaders = (extra: Record<string, string> = {}) => ({
    "content-length": String(bytes.length),
    "content-type": "image/png" as const,
    "x-cos-forbid-overwrite": "true" as const,
    "content-md5": digest,
    ...extra,
  });
  const put = (
    url: string,
    requestHeaders: Record<string, string>,
    body: Uint8Array = bytes,
  ) =>
    storage.acceptUpload(
      new URL(url).pathname.split("/").at(-1),
      new Request(url, {
        method: "PUT",
        headers: requestHeaders,
        body: new Uint8Array(body),
      }),
    );

  beforeAll(async () => {
    parent = await mkdtemp(path.join(tmpdir(), "moya-ingest-signer-"));
    storage = new LocalIngestStorage({
      stagingDirectory: path.join(parent, "editorial-ingest-staging"),
      mediaDirectory: path.join(parent, "media"),
      uploadEndpoint: new URL("http://127.0.0.1:3002"),
      tokenKey: randomBytes(32),
      stagingTag: false,
    });
  });
  afterAll(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  it("accepts one PUT with the signed headers and never a second one", async () => {
    const id = createHash("sha256").update("dev-accept").digest("hex");
    const { url, expiresAt } = await storage.signUpload(
      stagingKeyFor(id),
      devHeaders(),
      new Date(),
    );
    expect(new URL(url).pathname).toBe(
      `/api/editorial/media-ingest/dev-put/${id}`,
    );
    expect([...new URL(url).searchParams.keys()]).toEqual([
      "expires",
      "length",
      "token",
    ]);
    expect(new URL(url).searchParams.get("length")).toBe(String(bytes.length));
    expect(expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(300_000);
    expect(await put(url, devHeaders())).toEqual({
      status: 200,
      etag: `"${createHash("md5").update(bytes).digest("hex")}"`,
    });
    const file = path.join(parent, "editorial-ingest-staging", id);
    expect(await readFile(file)).toEqual(bytes);
    expect(
      (await stat(path.join(parent, "editorial-ingest-staging"))).mode & 0o777,
    ).toBe(0o700);
    expect(await put(url, devHeaders())).toMatchObject({ status: 409 });
    expect(await readFile(file)).toEqual(bytes);
  });

  it("refuses a missing, extra, changed or unsigned header, a wrong body and an expired URL", async () => {
    const id = createHash("sha256").update("dev-refuse").digest("hex");
    const { url } = await storage.signUpload(
      stagingKeyFor(id),
      devHeaders(),
      new Date(),
    );
    const without = (name: string) => {
      const value: Record<string, string> = devHeaders();
      delete value[name];
      return value;
    };
    for (const requestHeaders of [
      without("x-cos-forbid-overwrite"),
      without("content-md5"),
      devHeaders({ "content-type": "image/jpeg" }),
      devHeaders({ "x-cos-tagging": CATALOG_INGEST_STAGING_TAGGING }),
      devHeaders({ "x-cos-copy-source": `${BUCKET}/editorial/x` }),
      devHeaders({ "x-amz-copy-source": `${BUCKET}/editorial/x` }),
      devHeaders({ "x-cos-acl": "public-read" }),
      devHeaders({ "x-amz-acl": "public-read" }),
      devHeaders({ "x-cos-metadata-directive": "Replaced" }),
    ])
      expect(await put(url, requestHeaders)).toMatchObject({ status: 403 });
    expect(
      await put(url, devHeaders({ authorization: "Bearer synthetic" })),
    ).toMatchObject({ status: 400 });
    const corrupt = Buffer.from(bytes);
    corrupt[0] = corrupt[0]! ^ 1;
    expect(await put(url, devHeaders(), corrupt)).toMatchObject({
      status: 400,
    });
    const tampered = new URL(url);
    tampered.searchParams.set(
      "expires",
      String(Number(tampered.searchParams.get("expires")) + 1),
    );
    expect(await put(tampered.href, devHeaders())).toMatchObject({
      status: 403,
    });
    const longer = new URL(url);
    longer.searchParams.set("length", String(bytes.length + 1));
    expect(
      await put(
        longer.href,
        devHeaders({ "content-length": String(bytes.length + 1) }),
        Buffer.concat([bytes, Buffer.from([0])]),
      ),
    ).toMatchObject({ status: 403 });
    const late = await storage.signUpload(
      stagingKeyFor(id),
      devHeaders(),
      new Date(Date.now() - 301_000),
    );
    expect(await put(late.url, devHeaders())).toMatchObject({ status: 403 });
    await expect(
      stat(path.join(parent, "editorial-ingest-staging", id)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a staging directory inside, or around, the served media directory", () => {
    for (const [stagingDirectory, mediaDirectory] of [
      [path.join(parent, "media", "staging"), path.join(parent, "media")],
      [path.join(parent, "media"), path.join(parent, "media")],
      [parent, path.join(parent, "media")],
    ] as const)
      expect(
        () =>
          new LocalIngestStorage({
            stagingDirectory,
            mediaDirectory,
            uploadEndpoint: new URL("http://127.0.0.1:3002"),
            tokenKey: randomBytes(32),
            stagingTag: false,
          }),
      ).toThrow();
  });
});

describe("ingest settings", () => {
  const cos = {
    CMS_STORAGE_MODE: "cos",
    CMS_COS_ENDPOINT: "https://cos.admin.example.test",
    CMS_COS_REGION: REGION,
    CMS_COS_BUCKET: BUCKET,
    CMS_COS_ACCESS_KEY_ID: ACCESS,
    CMS_COS_SECRET_ACCESS_KEY: SECRET,
    CMS_CATALOG_INGEST_UPLOAD_ENDPOINT: uploadEndpoint.origin,
  };

  it("gates on CMS_CATALOG_INGEST and refuses an unknown value", () => {
    expect(catalogIngestEnabled({})).toBe(false);
    expect(catalogIngestEnabled({ CMS_CATALOG_INGEST: "off" })).toBe(false);
    // A blanked switch (`CMS_CATALOG_INGEST=` in admin.env) is off.
    expect(catalogIngestEnabled({ CMS_CATALOG_INGEST: "" })).toBe(false);
    expect(catalogIngestEnabled({ CMS_CATALOG_INGEST: "on" })).toBe(true);
    for (const value of ["ON", "true", "1", " ", "off "])
      expect(() => catalogIngestEnabled({ CMS_CATALOG_INGEST: value })).toThrow(
        "CMS_CATALOG_INGEST_INVALID",
      );
  });

  it("reads the upload endpoint, the server SHA-256 mode and the staging tag", () => {
    const settings = catalogIngestSettings(cos);
    expect(settings.uploadEndpoint.origin).toBe(uploadEndpoint.origin);
    expect(settings.serverSha256).toBe(true);
    expect(settings.stagingTag).toBe(false);
    expect(settings.storage).toMatchObject({ mode: "cos", bucket: BUCKET });
    expect(
      catalogIngestSettings({
        ...cos,
        CMS_CATALOG_INGEST_SERVER_SHA256: "off",
        CMS_CATALOG_INGEST_STAGING_TAG: "on",
      }),
    ).toMatchObject({ serverSha256: false, stagingTag: true });
  });

  it("refuses a malformed endpoint or toggle, naming the setting and never the value", () => {
    const standIn = "x".repeat(8);
    const withUserinfo = new URL("https://cos.example.test");
    withUserinfo.username = standIn;
    withUserinfo.password = standIn;
    for (const [name, value] of [
      ["CMS_CATALOG_INGEST_UPLOAD_ENDPOINT", "http://cos.upload.example.test"],
      [
        "CMS_CATALOG_INGEST_UPLOAD_ENDPOINT",
        "https://cos.upload.example.test/path",
      ],
      ["CMS_CATALOG_INGEST_UPLOAD_ENDPOINT", withUserinfo.href],
      ["CMS_CATALOG_INGEST_UPLOAD_ENDPOINT", "https://cos.example.test/?q=1"],
      ["CMS_CATALOG_INGEST_SERVER_SHA256", "yes"],
      ["CMS_CATALOG_INGEST_STAGING_TAG", "L1"],
      ["CMS_COS_ENDPOINT", "http://cos.admin.example.test"],
      ["CMS_COS_SECRET_ACCESS_KEY", ""],
    ] as const) {
      let message = "";
      try {
        catalogIngestSettings({ ...cos, [name]: value });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toBe(`CMS_CATALOG_INGEST_SETTING_INVALID:${name}`);
      if (value) expect(message).not.toContain(value);
    }
    expect(() =>
      catalogIngestSettings({
        ...cos,
        CMS_CATALOG_INGEST_UPLOAD_ENDPOINT: undefined,
      }),
    ).toThrow(
      "CMS_CATALOG_INGEST_SETTING_INVALID:CMS_CATALOG_INGEST_UPLOAD_ENDPOINT",
    );
  });

  it("serves the Development store only with local storage outside production", () => {
    const local = {
      CMS_STORAGE_MODE: "local",
      CMS_ENVIRONMENT: "synthetic",
      CMS_CATALOG_INGEST_UPLOAD_ENDPOINT: "http://127.0.0.1:3002",
    };
    expect(catalogIngestDevelopmentStore(local)).toBe(true);
    expect(catalogIngestSettings(local).storage).toEqual({ mode: "local" });
    expect(
      catalogIngestDevelopmentStore({
        ...local,
        CMS_ENVIRONMENT: "production",
      }),
    ).toBe(false);
    expect(() =>
      catalogIngestSettings({ ...local, CMS_ENVIRONMENT: "production" }),
    ).toThrow("CMS_CATALOG_INGEST_SETTING_INVALID:CMS_STORAGE_MODE");
    expect(catalogIngestDevelopmentStore(cos)).toBe(false);
    // A plain-http upload origin is a loopback Development origin only.
    expect(() =>
      catalogIngestSettings({
        ...local,
        CMS_CATALOG_INGEST_UPLOAD_ENDPOINT: "http://admin.example.test",
      }),
    ).toThrow(
      "CMS_CATALOG_INGEST_SETTING_INVALID:CMS_CATALOG_INGEST_UPLOAD_ENDPOINT",
    );
  });

  it("logs only fixed ingest categories and drops every other field", () => {
    const url = `https://${BUCKET}.${uploadEndpoint.host}/${key}?X-Amz-Signature=abc`;
    expect(
      cmsRuntimeLogFields([
        { category: "EDITORIAL_MEDIA_INGEST_ORPHAN", url, key, secret: SECRET },
      ]),
    ).toEqual({ category: "EDITORIAL_MEDIA_INGEST_ORPHAN" });
    expect(cmsRuntimeLogFields([{ category: url }])).toEqual({
      category: "CMS_RUNTIME_EVENT",
    });
    expect(
      cmsRuntimeLogFields([{ category: "EDITORIAL_MEDIA_UPLOAD_FAILED" }]),
    ).toEqual({ category: "CMS_RUNTIME_EVENT" });
  });
});
