import { createHash, createHmac } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { CATALOG_INGEST_STAGING_TAGGING } from "@moya/contracts/internal/editorial";
import {
  INGEST_PROBE_IDS,
  createProbeTransport,
  ingestProbeIds,
  runIngestProbes,
  type ProbeLifecycle,
  type ProbeReport,
  type ProbeRequest,
} from "admin/media-ingest-probes";
import {
  createCosIngestProbeStorage,
  stagingKeyFor,
  type IngestProbeStorage,
  type IngestUploadHeaders,
  type StoredObject,
} from "admin/media-ingest-storage";
import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * catalog-scale-v1 increment 2: the Owner-run staging dry run. The runner is
 * driven against a synthetic COS that honours exactly the signed request
 * (and, per case, one unsigned header, a sub-resource, a changed ETag or a
 * missing tag count), so every probe is shown to pass on a well-behaved
 * bucket and to fail on the misbehaviour it exists for. The probe storage is
 * the Admin's own SDK code with only the transport replaced. Synthetic
 * credentials and .test hosts only; nothing reaches a network.
 */

const sdk = await vi.hoisted(async () => {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const admin = createRequire(require.resolve("admin/config"));
  return {
    path: admin.resolve("@aws-sdk/client-s3"),
    sent: [] as {
      method: string;
      path: string;
      headers: Record<string, string>;
    }[],
    status: 200,
  };
});
vi.mock(sdk.path, async (importOriginal) => {
  const { Readable } = await import("node:stream");
  const actual = await importOriginal<{
    S3Client: new (config: Record<string, unknown>) => object;
  }>();
  const handle = async (request: {
    method: string;
    path: string;
    headers: Record<string, string>;
  }) => {
    sdk.sent.push({
      method: request.method,
      path: request.path,
      headers: Object.fromEntries(
        Object.entries(request.headers).map(([name, value]) => [
          name.toLowerCase(),
          String(value),
        ]),
      ),
    });
    return {
      response:
        sdk.status === 200
          ? {
              statusCode: 200,
              headers: { "content-type": "application/xml" },
              body: Readable.from([
                Buffer.from(
                  '<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult><ETag>"synthetic"</ETag><LastModified>2026-10-23T00:00:00.000Z</LastModified></CopyObjectResult>',
                ),
              ]),
            }
          : {
              statusCode: sdk.status,
              headers: { "content-type": "application/xml" },
              body: Readable.from([
                Buffer.from(
                  '<?xml version="1.0" encoding="UTF-8"?><Error><Code>Synthetic</Code><Message>synthetic</Message></Error>',
                ),
              ]),
            },
    };
  };
  class S3Client extends actual.S3Client {
    constructor(config: Record<string, unknown>) {
      super({ ...config, requestHandler: { handle } });
    }
  }
  return { ...actual, S3Client };
});

afterEach(() => {
  sdk.sent.length = 0;
  sdk.status = 200;
});

const BUCKET = "synthetic-ingest-1250000000";
const HOST = `${BUCKET}.cos.upload.example.test`;
const SECRET = "synthetic-probe-secret";
const SIGNED_QUERY = [
  "X-Amz-Algorithm",
  "X-Amz-Content-Sha256",
  "X-Amz-Credential",
  "X-Amz-Date",
  "X-Amz-Expires",
  "X-Amz-SignedHeaders",
  "X-Amz-Signature",
  "x-id",
];

type Stored = {
  bytes: number;
  etag: string;
  crc64: string | null;
  tags: number;
  contentType: string;
  extra: boolean;
  public: boolean;
};
type Behaviour = {
  /** Unsigned headers this COS honours instead of refusing ("x-…-": a prefix). */
  honoured?: readonly string[];
  /** Unsigned standard headers: refused, ignored or stored. */
  standard?: "refuse" | "ignore" | "store";
  /**
   * A sub-resource parameter added to a signed URL is left out of the
   * signature check and runs its own operation on the signed key
   * (PutObjectAcl, PutObjectTagging): 404 for a key never written, 200 and a
   * changed object for one that exists.
   */
  ignoreQuery?: boolean;
  /** Runs the sub-resource's operation, yet answers 403 as if refused. */
  queryRunsAnyway?: boolean;
  /** The status a refused sub-resource gets (403 by default). */
  queryRefusal?: number;
  /** The copy keeps the source's tags despite the REPLACE directive. */
  copyKeepsTags?: boolean;
  /** What a PUT's and a copy's ETag is. */
  putEtag?: "md5" | "other";
  copyEtag?: "same" | "new";
  /** The tag count on HEAD (L1). */
  reportTagCount?: boolean;
  /** The URL's expiry is checked when the body ends, not when it starts. */
  expiryAtEnd?: boolean;
  /** HEAD of a missing key answers 403 (no list right), not 404. */
  headMissingForbidden?: boolean;
  /**
   * Refuses an unsigned COS or S3 header in its auth layer, before it routes
   * a sub-resource (S3's "headers present in the request which were not
   * signed"), so such a header alone gets a sub-resource request its 403.
   */
  unsignedFirst?: boolean;
};

/**
 * A synthetic COS for the runner: a query signature (an HMAC over method,
 * key, the signed headers' values, date and lifetime) binds exactly what the
 * Admin signs; unsigned COS and S3 headers are refused unless honoured.
 */
const syntheticCos = (behaviour: Behaviour = {}) => {
  let clock = Date.UTC(2026, 9, 23, 12, 0, 0);
  const objects = new Map<string, Stored>();
  const signature = (
    key: string,
    headers: Readonly<Record<string, string>>,
    names: string[],
    date: string,
    expires: string,
  ) =>
    createHmac("sha256", SECRET)
      .update(
        JSON.stringify([
          "PUT",
          key,
          names.map((name) => headers[name] ?? null),
          date,
          expires,
        ]),
      )
      .digest("hex");
  const head = (key: string): StoredObject | null => {
    const object = objects.get(key);
    return object
      ? {
          bytes: object.bytes,
          etag: object.etag,
          crc64: object.crc64,
          tagCount: behaviour.reportTagCount === false ? 0 : object.tags,
          contentType: object.contentType,
          extraAttributes: object.extra,
        }
      : null;
  };
  const storage: IngestProbeStorage = {
    async signPut(key, headers, now, expiresIn) {
      const names = [...Object.keys(headers), "host"].sort();
      const date = String(Math.floor(now.getTime() / 1000));
      const url = new URL(`https://${HOST}/${key}`);
      url.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
      url.searchParams.set("X-Amz-Content-Sha256", "UNSIGNED-PAYLOAD");
      url.searchParams.set("X-Amz-Credential", "SYNTHETIC/scope");
      url.searchParams.set("X-Amz-Date", date);
      url.searchParams.set("X-Amz-Expires", String(expiresIn));
      url.searchParams.set("X-Amz-SignedHeaders", names.join(";"));
      url.searchParams.set(
        "X-Amz-Signature",
        signature(
          key,
          { ...headers, host: HOST },
          names,
          date,
          String(expiresIn),
        ),
      );
      url.searchParams.set("x-id", "PutObject");
      return url.href;
    },
    async head(key) {
      const found = head(key);
      if (!found && behaviour.headMissingForbidden)
        throw new Error("synthetic 403");
      return found;
    },
    async copy(source, target, etag, stagingTag) {
      const from = objects.get(source);
      if (!from) return 404;
      if (from.etag !== etag) return 412;
      if (objects.has(target)) return 409;
      objects.set(target, {
        ...from,
        etag: behaviour.copyEtag === "new" ? `"${"c".repeat(32)}"` : from.etag,
        tags: stagingTag && !behaviour.copyKeepsTags ? 0 : from.tags,
      });
      return 200;
    },
    async remove(key) {
      objects.delete(key);
    },
  };
  const transport = async (request: ProbeRequest) => {
    const url = new URL(request.url);
    if (url.protocol !== "https:" || url.host !== HOST) return 0;
    const key = url.pathname.slice(1);
    const headers = Object.fromEntries(
      Object.entries(request.headers).map(([name, value]) => [
        name.toLowerCase(),
        value,
      ]),
    );
    if (!url.searchParams.has("X-Amz-Signature"))
      // Anonymous: the bucket is private.
      return request.method === "GET" && objects.get(key)?.public ? 200 : 403;
    const extra = [...url.searchParams.keys()].filter(
      (name) => !SIGNED_QUERY.includes(name),
    );
    if (extra.length && !behaviour.ignoreQuery && !behaviour.queryRunsAnyway)
      return behaviour.queryRefusal ?? 403;
    if (request.method !== "PUT") return 403;
    const names = url.searchParams.get("X-Amz-SignedHeaders")!.split(";");
    const date = url.searchParams.get("X-Amz-Date")!;
    const expires = url.searchParams.get("X-Amz-Expires")!;
    const expired = () => clock > (Number(date) + Number(expires)) * 1000 + 999;
    if (!behaviour.expiryAtEnd && expired()) return 403;
    if (request.pauseMs !== undefined) clock += request.pauseMs;
    if (behaviour.expiryAtEnd && expired()) return 403;
    if (
      url.searchParams.get("X-Amz-Signature") !==
      signature(key, { ...headers, host: url.host }, names, date, expires)
    )
      return 403;
    const honours = (name: string) =>
      (behaviour.honoured ?? []).some((honoured) =>
        honoured.endsWith("-") ? name.startsWith(honoured) : name === honoured,
      );
    if (
      behaviour.unsignedFirst &&
      Object.keys(headers).some(
        (name) =>
          !names.includes(name) &&
          /^x-(?:cos|amz)-/.test(name) &&
          !honours(name),
      )
    )
      return 403;
    if (extra.length) {
      // The sub-resource's own operation on the signed key, its body checked
      // against the signed Content-MD5.
      const target = objects.get(key);
      const sent = request.body ?? new Uint8Array();
      if (
        createHash("md5").update(sent).digest("base64") !==
        headers["content-md5"]
      )
        return 400;
      if (!target) return 404;
      const answered = behaviour.queryRunsAnyway ? 403 : 200;
      const document = Buffer.from(sent).toString("utf8");
      if (extra.includes("acl")) {
        // PutObjectAcl reads its grants from the body.
        if (!document.includes("<AccessControlPolicy>")) return 400;
        if (
          /<URI>http:\/\/cam\.qcloud\.com\/groups\/global\/AllUsers<\/URI><\/Grantee><Permission>READ<\/Permission>/.test(
            document,
          )
        )
          target.public = true;
        return answered;
      }
      if (extra.includes("tagging")) {
        if (!document.includes("<Tagging>")) return 400;
        target.tags = document.split("<Tag>").length - 1;
        return answered;
      }
      return 400;
    }
    let tags = names.includes("x-cos-tagging") ? 1 : 0;
    let extraStored = false;
    let isPublic = false;
    for (const name of Object.keys(headers)) {
      if (names.includes(name)) continue;
      if (/^x-(?:cos|amz)-/.test(name)) {
        if (!honours(name)) return 403;
        if (/tagging$/.test(name)) tags++;
        else if (/acl|grant/.test(name)) isPublic = true;
        else extraStored = true;
        continue;
      }
      if (behaviour.standard === "refuse") return 400;
      if (behaviour.standard === "store") extraStored = true;
    }
    const body = request.body ?? new Uint8Array();
    const digest = createHash("md5").update(body);
    if (
      Number(headers["content-length"]) !== body.byteLength ||
      digest.copy().digest("base64") !== headers["content-md5"]
    )
      return 400;
    if (objects.has(key)) return 409;
    objects.set(key, {
      bytes: body.byteLength,
      etag:
        behaviour.putEtag === "other"
          ? `"${"e".repeat(32)}-1"`
          : `"${digest.digest("hex")}"`,
      crc64: "4242",
      tags,
      contentType: headers["content-type"]!,
      extra: extraStored,
      public: isPublic,
    });
    return 200;
  };
  // Node's fetch, over the same model.
  const fetchImpl = (async (url: string, init: RequestInit) =>
    new Response(null, {
      status: await transport({
        method: "PUT",
        url,
        headers: init.headers as Record<string, string>,
        body: init.body as Uint8Array,
      }),
    })) as unknown as typeof fetch;
  return { objects, storage, transport, fetchImpl, now: () => clock };
};

const run = (
  lifecycle: ProbeLifecycle,
  behaviour: Behaviour = {},
  options: { keepSource?: boolean } = {},
) => {
  const cos = syntheticCos(behaviour);
  return runIngestProbes({
    lifecycle,
    storage: cos.storage,
    transport: cos.transport,
    fetchImpl: cos.fetchImpl,
    now: cos.now,
    ...options,
  }).then((report) => ({ report, objects: cos.objects }));
};
const outcome = (report: ProbeReport, id: string) =>
  report.probes.find((probe) => probe.id === id)!;

describe("the staging dry run", () => {
  it("passes every probe on storage that honours exactly the signed request, and leaves nothing", async () => {
    for (const lifecycle of ["L1", "L2"] as const) {
      const { report, objects } = await run(lifecycle);
      expect(report.failed).toEqual([]);
      expect(report.verdict).toEqual({
        always: "pass",
        md5Mode: "pass",
        l1: lifecycle === "L1" ? "pass" : "not-run",
      });
      expect(report.probes.map(({ id }) => id)).toEqual(
        ingestProbeIds(lifecycle),
      );
      expect(objects.size).toBe(0);
      // Content-free: no URL, host, key, signature or header value.
      const text = JSON.stringify(report);
      for (const secret of [
        HOST,
        "catalog-ingest",
        "X-Amz",
        "https:",
        CATALOG_INGEST_STAGING_TAGGING,
        "public-read",
      ])
        expect(text).not.toContain(secret);
      expect(text).not.toMatch(/[a-f0-9]{32}/);
    }
    expect(ingestProbeIds("L1")).toEqual(INGEST_PROBE_IDS);
    expect(ingestProbeIds("L2")).toEqual(
      INGEST_PROBE_IDS.filter(
        (id) => !["head-tag-count", "copy-strips-tags"].includes(id),
      ),
    );
  });

  it("fails the gate for any unsigned COS or S3 header the bucket honours", async () => {
    for (const [header, probes] of [
      ["x-cos-acl", ["unsigned-x-cos-acl"]],
      ["x-amz-grant-read", ["unsigned-x-amz-grant-read"]],
      ["x-cos-grant-full-control", ["unsigned-x-cos-grant-full-control"]],
      ["x-amz-tagging", ["unsigned-x-amz-tagging"]],
      [
        "x-cos-server-side-encryption",
        ["unsigned-x-cos-sse", "unsigned-x-cos-sse-kms"],
      ],
      ["x-amz-server-side-encryption-customer-", ["unsigned-x-amz-sse-c"]],
      ["x-cos-storage-class", ["unsigned-x-cos-storage-class"]],
      ["x-cos-meta-", ["unsigned-x-cos-meta"]],
      ["x-amz-copy-source", ["unsigned-x-amz-copy-source"]],
      ["x-cos-metadata-directive", ["unsigned-x-cos-metadata-directive"]],
    ] as const) {
      const { report } = await run("L2", { honoured: [header] });
      expect(report.failed, header).toEqual(probes);
      for (const probe of probes)
        expect(outcome(report, probe).observed).toEqual({
          status: 200,
          stored: true,
        });
      expect(report.verdict.always).toBe("fail");
    }
    // Under L2 x-cos-tagging is unsigned; under L1 a changed value breaks
    // the signature either way.
    const tagging = await run("L2", { honoured: ["x-cos-tagging"] });
    expect(tagging.report.failed).toEqual(["unsigned-x-cos-tagging"]);
  });

  it("fails the gate when a sub-resource added to the signed URL runs its operation on an existing object", async () => {
    for (const lifecycle of ["L1", "L2"] as const) {
      const { report, objects } = await run(lifecycle, { ignoreQuery: true });
      // The method is signed, so the multipart start stays refused.
      expect(report.failed, lifecycle).toEqual(["query-acl", "query-tagging"]);
      const tags = lifecycle === "L1" ? 1 : 0;
      // ACL: answered, and the object became anonymously readable.
      expect(outcome(report, "query-acl").observed).toEqual({
        put: 200,
        status: 200,
        unchanged: true,
        tagCount: tags,
        anonymous: 200,
      });
      // Tagging: answered, and the tag count HEAD shows changed.
      expect(outcome(report, "query-tagging").observed).toEqual({
        put: 200,
        status: 200,
        unchanged: false,
        tagCount: 2,
        anonymous: 403,
      });
      expect(report.verdict.always).toBe("fail");
      expect(objects.size).toBe(0);
    }
  });

  it("still reaches the sub-resource on a COS that refuses unsigned headers before routing it", async () => {
    // The ACL leg sends its grants as the signed body, with no unsigned
    // header for such a COS to refuse first: an unsigned x-cos-acl would get
    // its 403 from the header alone, and the ?acl leak would pass unseen.
    for (const lifecycle of ["L1", "L2"] as const) {
      const { report } = await run(lifecycle, {
        ignoreQuery: true,
        unsignedFirst: true,
      });
      expect(report.failed, lifecycle).toEqual(["query-acl", "query-tagging"]);
      expect(outcome(report, "query-acl").observed).toMatchObject({
        status: 200,
        anonymous: 200,
      });
      expect(outcome(report, "query-tagging").observed).toMatchObject({
        status: 200,
        unchanged: false,
      });
    }
    // The same COS that checks the whole URL passes every probe.
    expect((await run("L2", { unsignedFirst: true })).report.failed).toEqual(
      [],
    );
  });

  it("fails a sub-resource probe that got a 403 when the object changed or became readable", async () => {
    const { report } = await run("L1", { queryRunsAnyway: true });
    expect(report.failed).toEqual(["query-acl", "query-tagging"]);
    expect(outcome(report, "query-acl").observed).toEqual({
      put: 200,
      status: 403,
      unchanged: true,
      tagCount: 1,
      anonymous: 200,
    });
    expect(outcome(report, "query-tagging").observed).toEqual({
      put: 200,
      status: 403,
      unchanged: false,
      tagCount: 2,
      anonymous: 403,
    });
  });

  it("passes a sub-resource probe only on a 403, which a key never written could not show", async () => {
    const passing = await run("L2");
    for (const id of ["query-acl", "query-tagging", "query-uploads"])
      expect(outcome(passing.report, id).observed, id).toEqual({
        put: 200,
        status: 403,
        unchanged: true,
        tagCount: 0,
        anonymous: 403,
      });
    // Another refusal says nothing about the signature check: a 404 is what
    // the operation answers for a missing key, a 400 what it answers for a
    // body it cannot parse.
    for (const queryRefusal of [400, 404]) {
      const { report } = await run("L2", { queryRefusal });
      expect(report.failed, String(queryRefusal)).toEqual([
        "query-acl",
        "query-tagging",
        "query-uploads",
      ]);
      expect(outcome(report, "query-tagging").observed).toMatchObject({
        status: queryRefusal,
        unchanged: true,
      });
    }
  });

  it("accepts an unsigned standard header refused, not stored, or stored where the Admin's HEAD shows it", async () => {
    for (const standard of ["refuse", "ignore", "store"] as const) {
      const { report } = await run("L2", { standard });
      expect(report.failed, standard).toEqual([]);
      expect(outcome(report, "unsigned-content-encoding").observed).toEqual(
        standard === "refuse"
          ? { status: 400, stored: false, shownOnHead: null }
          : { status: 200, stored: true, shownOnHead: standard === "store" },
      );
    }
  });

  it("reports MD5/ETag mode unsafe when the PUT ETag is not the MD5 or the copy changes it", async () => {
    const copied = await run("L2", { copyEtag: "new" });
    // CRC64 still proves the copy for the default server-hash mode.
    expect(copied.report.failed).toEqual(["copy-keeps-etag"]);
    expect(copied.report.verdict).toMatchObject({
      always: "pass",
      md5Mode: "fail",
    });
    const put = await run("L2", { putEtag: "other" });
    expect(put.report.failed).toEqual(["put-etag-md5"]);
    expect(put.report.verdict.md5Mode).toBe("fail");
  });

  it("reports L1 unusable when HEAD shows no tag count", async () => {
    const { report } = await run("L1", { reportTagCount: false });
    expect(report.failed).toEqual(["head-tag-count"]);
    expect(report.verdict).toEqual({
      always: "pass",
      md5Mode: "pass",
      l1: "fail",
    });
  });

  it("reports only L1 unusable, not a rollout stop, when the copy keeps the staging tag", async () => {
    const l1 = await run("L1", { copyKeepsTags: true });
    expect(l1.report.failed).toEqual(["copy-strips-tags"]);
    expect(outcome(l1.report, "copy-keeps-metadata")).toMatchObject({
      gate: "always",
      pass: true,
      observed: { tagCount: 1 },
    });
    expect(l1.report.verdict).toEqual({
      always: "pass",
      md5Mode: "pass",
      l1: "fail",
    });
    // Under L2 the source has no tag to keep.
    expect((await run("L2", { copyKeepsTags: true })).report.failed).toEqual(
      [],
    );
  });

  it("fails the slow PUT where a URL's expiry is checked when the body ends", async () => {
    const { report } = await run("L2", { expiryAtEnd: true });
    expect(report.failed).toEqual(["slow-put"]);
  });

  it("fails when HEAD of a missing key is not a 404, which complete relies on", async () => {
    const { report } = await run("L2", { headMissingForbidden: true });
    expect(report.failed).toContain("head-missing");
    expect(outcome(report, "head-missing").observed).toEqual({
      absent: false,
    });
    // Presence it cannot read is reported as unknown, never as absent.
    expect(outcome(report, "unsigned-x-cos-acl")).toMatchObject({
      pass: false,
      observed: { status: 403, stored: null },
    });
    expect(report.verdict.always).toBe("fail");
  });

  it("keeps only the signed-put object for the Owner's GetObjectTagging when asked", async () => {
    const { report, objects } = await run("L1", {}, { keepSource: true });
    expect(report.failed).toEqual([]);
    expect(outcome(report, "cleanup").observed).toMatchObject({
      left: 0,
      kept: true,
    });
    expect([...objects.values()]).toEqual([
      expect.objectContaining({ tags: 1, contentType: "image/jpeg" }),
    ]);
  });

  it("records a request that got no answer as a failure, never as a crash", async () => {
    const cos = syntheticCos();
    const report = await runIngestProbes({
      lifecycle: "L2",
      storage: cos.storage,
      transport: async () => {
        throw new Error("synthetic network failure https://example.test/");
      },
      fetchImpl: (async () => {
        throw new Error("synthetic");
      }) as unknown as typeof fetch,
      now: cos.now,
    });
    expect(report.verdict.always).toBe("fail");
    expect(outcome(report, "signed-put").observed).toEqual({ status: 0 });
    expect(JSON.stringify(report)).not.toContain("example.test");
  });
});

describe("the probe storage", () => {
  const storage = () =>
    createCosIngestProbeStorage({
      endpoint: new URL("https://cos.admin.example.test"),
      uploadEndpoint: new URL("https://cos.upload.example.test"),
      region: "synthetic-region",
      bucket: BUCKET,
      accessKeyId: "synthetic-access-key",
      secretAccessKey: "synthetic-secret-key",
    });
  const key = (label: string) =>
    stagingKeyFor(createHash("sha256").update(label).digest("hex"));
  const signal = () => new AbortController().signal;
  const headers: IngestUploadHeaders = {
    "content-length": "1024",
    "content-type": "image/jpeg",
    "x-cos-forbid-overwrite": "true",
    "content-md5": createHash("md5").update("x").digest("base64"),
  };

  it("copies between staging keys with exactly the Admin's copy headers and returns the status", async () => {
    for (const stagingTag of [false, true]) {
      sdk.sent.length = 0;
      await expect(
        storage().copy(
          key("source"),
          key("target"),
          '"synthetic"',
          stagingTag,
          signal(),
        ),
      ).resolves.toBe(200);
      const [copy] = sdk.sent;
      expect(copy!.path).toBe(`/${key("target")}`);
      expect(
        Object.fromEntries(
          Object.entries(copy!.headers).filter(
            ([name]) =>
              /^x-(?:amz|cos)-/.test(name) &&
              ![
                "x-amz-date",
                "x-amz-content-sha256",
                "x-amz-user-agent",
              ].includes(name),
          ),
        ),
      ).toEqual({
        "x-amz-copy-source": `${BUCKET}/${key("source")}`,
        "x-amz-copy-source-if-match": '"synthetic"',
        "x-amz-metadata-directive": "COPY",
        ...(stagingTag ? { "x-amz-tagging-directive": "REPLACE" } : {}),
        "x-cos-forbid-overwrite": "true",
      });
    }
    for (const status of [409, 412, 403]) {
      sdk.status = status;
      await expect(
        storage().copy(
          key("source"),
          key("target"),
          '"synthetic"',
          false,
          signal(),
        ),
      ).resolves.toBe(status);
    }
    // One request per probe: no SDK retry hides a 5xx.
    sdk.sent.length = 0;
    sdk.status = 503;
    await expect(
      storage().copy(key("source"), key("target"), '"x"', false, signal()),
    ).resolves.toBe(503);
    expect(sdk.sent).toHaveLength(1);
  });

  it("never touches an editorial key and signs with the given lifetime", async () => {
    const editorial = `editorial/${"a".repeat(64)}/${"b".repeat(64)}-${"c".repeat(64)}.jpg`;
    await expect(
      storage().copy(key("source"), editorial, '"x"', false, signal()),
    ).rejects.toThrow();
    await expect(
      storage().copy(editorial, key("target"), '"x"', false, signal()),
    ).rejects.toThrow();
    await expect(storage().head(editorial, signal())).rejects.toThrow();
    await expect(storage().remove(editorial, signal())).rejects.toThrow();
    expect(sdk.sent).toEqual([]);
    const url = new URL(
      await storage().signPut(key("slow"), headers, new Date(), 5),
    );
    expect(url.host).toBe(`${BUCKET}.cos.upload.example.test`);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("5");
    await expect(
      storage().signPut(key("slow"), headers, new Date(), 301),
    ).rejects.toThrow("INGEST_SIGNER_REFUSED");
  });
});

describe("the probe transport", () => {
  it("sends exactly the given headers and body, and a slow PUT ends after its pause", async () => {
    const seen: {
      headers: IncomingHttpHeaders;
      bytes: number;
      at: number[];
    }[] = [];
    const server = createServer((request, response) => {
      const at = [Date.now()];
      let bytes = 0;
      request.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        at.push(Date.now());
      });
      request.on("end", () => {
        seen.push({ headers: request.headers, bytes, at });
        response.statusCode = 403;
        response.end("<Error>synthetic</Error>");
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const { port } = server.address() as AddressInfo;
      const transport = createProbeTransport({ allowLoopbackHttp: true });
      const body = new Uint8Array(4096).fill(7);
      const status = await transport(
        {
          method: "PUT",
          url: `http://127.0.0.1:${port}/key?x=1`,
          headers: {
            "content-length": "4096",
            "content-type": "image/jpeg",
            "x-cos-acl": "public-read",
          },
          body,
          pauseMs: 300,
        },
        AbortSignal.timeout(5_000),
      );
      expect(status).toBe(403);
      const [request] = seen;
      expect(
        Object.keys(request!.headers)
          .filter((name) => !["host", "connection"].includes(name))
          .sort(),
      ).toEqual(["content-length", "content-type", "x-cos-acl"]);
      expect(request!.bytes).toBe(4096);
      expect(request!.at.at(-1)! - request!.at[0]!).toBeGreaterThanOrEqual(250);
      // https only outside loopback tests.
      expect(
        await createProbeTransport()(
          { method: "GET", url: `http://127.0.0.1:${port}/`, headers: {} },
          AbortSignal.timeout(1_000),
        ),
      ).toBe(0);
    } finally {
      server.close();
    }
  });
});

describe("the Owner-run probe CLI", () => {
  const script = new URL(
    "../../../apps/admin/scripts/catalog-ingest-probes.ts",
    import.meta.url,
  ).href;
  const cos = {
    CMS_STORAGE_MODE: "cos",
    CMS_COS_ENDPOINT: "https://cos.admin.example.invalid",
    CMS_COS_REGION: "synthetic-region",
    CMS_COS_BUCKET: BUCKET,
    CMS_COS_ACCESS_KEY_ID: "SYNTHETICPROBEKEY",
    CMS_COS_SECRET_ACCESS_KEY: "synthetic-probe-secret-key",
    CMS_CATALOG_INGEST_UPLOAD_ENDPOINT: "https://cos.upload.example.invalid",
  };
  const directories: string[] = [];
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });
  /** One run as payload run makes it: argv after the script, module import. */
  const cli = async (args: string[], environment: Record<string, string>) => {
    for (const [name, value] of Object.entries(environment))
      vi.stubEnv(name, value);
    const printed: string[] = [];
    vi.spyOn(console, "info").mockImplementation((...values) => {
      printed.push(values.map(String).join(" "));
    });
    const argv = process.argv;
    process.argv = [argv[0]!, "payload", ...args];
    vi.resetModules();
    try {
      await import(/* @vite-ignore */ script);
      return { error: null, printed };
    } catch (error) {
      return { error: (error as Error).message, printed };
    } finally {
      process.argv = argv;
    }
  };
  const workspace = async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ingest-probes-"));
    directories.push(directory);
    return directory;
  };

  it("refuses bad arguments, settings and an existing output before any request", async () => {
    const out = path.join(await workspace(), "report.json");
    for (const [args, environment, code] of [
      [["--lifecycle", "L3", "--out", out], cos, "ARGUMENTS_INVALID"],
      [["--lifecycle", "L1"], cos, "ARGUMENTS_INVALID"],
      [
        ["--lifecycle", "L1", "--out", out, "--url", "x"],
        cos,
        "ARGUMENTS_INVALID",
      ],
      [
        ["--lifecycle", "L1", "--out", out],
        {
          ...cos,
          CMS_CATALOG_INGEST_UPLOAD_ENDPOINT: "http://cos.example.invalid",
        },
        "SETTINGS_INVALID",
      ],
      [
        ["--lifecycle", "L1", "--out", out],
        {
          CMS_STORAGE_MODE: "local",
          CMS_ENVIRONMENT: "synthetic",
          CMS_CATALOG_INGEST_UPLOAD_ENDPOINT: "http://127.0.0.1:3002",
        },
        "COS_STORAGE_REQUIRED",
      ],
    ] as const) {
      const { error, printed } = await cli([...args], { ...environment });
      expect(error, code).toBe(`CATALOG_INGEST_PROBES_REFUSED ${code}`);
      expect(printed).toEqual([]);
    }
    await writeFile(out, "kept", { mode: 0o600 });
    const existing = await cli(["--lifecycle", "L1", "--out", out], cos);
    expect(existing.error).toBe(
      "CATALOG_INGEST_PROBES_REFUSED OUTPUT_EXISTS_OR_UNWRITABLE",
    );
    expect(await readFile(out, "utf8")).toBe("kept");
    expect(sdk.sent).toEqual([]);
  });

  it("writes the report only to a new 0600 file and prints verdicts and its digest, never a URL, key or credential", async () => {
    const out = path.join(await workspace(), "report.json");
    // Nothing answers: every probe records status 0 and the run fails.
    sdk.status = 503;
    const { error, printed } = await cli(
      ["--lifecycle", "L2", "--out", out],
      cos,
    );
    expect(error).toBe("CATALOG_INGEST_PROBES_REFUSED PROBES_FAILED");
    const report = await readFile(out, "utf8");
    expect((await stat(out)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(report)).toMatchObject({
      version: 1,
      lifecycle: "L2",
      verdict: { always: "fail" },
    });
    expect(printed).toHaveLength(1);
    expect(JSON.parse(printed[0]!)).toMatchObject({
      lifecycle: "L2",
      written: true,
      sha256: createHash("sha256").update(report).digest("hex"),
      ownerChecks: ["versioning", "encryption"],
    });
    for (const text of [report, printed[0]!])
      for (const secret of [
        "example.invalid",
        BUCKET,
        "SYNTHETICPROBEKEY",
        "synthetic-probe-secret-key",
        "catalog-ingest",
        "X-Amz",
      ])
        expect(text).not.toContain(secret);
  }, 60_000);
});
