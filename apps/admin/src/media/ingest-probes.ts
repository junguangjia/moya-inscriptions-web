import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";
import {
  INGEST_URL_TTL_SECONDS,
  stagingKeyFor,
  stagingUploadHeaders,
  type IngestProbeStorage,
  type IngestUploadHeaders,
  type StoredObject,
} from "./ingest-storage";

/*
 * The staging dry run of Catalog ingest (catalog-scale-v1 increment 2,
 * decision D7), run by the Owner on the CVM with the Admin's own settings
 * before CMS_CATALOG_INGEST=on. Every request is shaped by the Admin's own
 * code: the staging PUT URL by signStagingPut with the start route's headers,
 * and the copy, HEAD and DELETE requests by the ingest storage. Each probe
 * adds one change to that request and records what COS answered. Synthetic
 * objects under catalog-ingest/v1/ only; nothing reads, copies to or deletes
 * an editorial/ key. The report holds probe ids, status codes and booleans:
 * never a URL, key, signature, header value or credential.
 */

export type ProbeLifecycle = "L1" | "L2";
/**
 * always: must pass before switch-on. md5-mode: also before
 * CMS_CATALOG_INGEST_SERVER_SHA256=off. l1: also before
 * CMS_CATALOG_INGEST_STAGING_TAG=on (lifecycle L1).
 */
export type ProbeGate = "always" | "md5-mode" | "l1";
export type ProbeOutcome = Readonly<{
  id: string;
  gate: ProbeGate;
  pass: boolean;
  /** Status codes and booleans only. */
  observed: Readonly<Record<string, number | boolean | null>>;
}>;
export type ProbeReport = Readonly<{
  version: 1;
  lifecycle: ProbeLifecycle;
  verdict: Readonly<
    Record<"always" | "md5Mode" | "l1", "pass" | "fail" | "not-run">
  >;
  failed: readonly string[];
  probes: readonly ProbeOutcome[];
  /** The checks this run cannot make with the Admin's identity. */
  ownerChecks: readonly string[];
}>;

export type ProbeRequest = Readonly<{
  method: "PUT" | "GET" | "HEAD" | "POST" | "DELETE";
  url: string;
  /** Exactly these headers; the transport adds only Host (and framing). */
  headers: Readonly<Record<string, string>>;
  body?: Uint8Array;
  /** Slow PUT: send half the body, wait this long, then the rest. */
  pauseMs?: number;
}>;
/** One request; the status, or 0 when no answer came. The body is discarded. */
export type ProbeTransport = (
  request: ProbeRequest,
  signal: AbortSignal,
) => Promise<number>;

const REQUEST_TIMEOUT_MS = 30_000;
const BODY_BYTES = 64 * 1024;
/** The slow PUT's URL lives this long; its body ends well after it. */
const SLOW_EXPIRES_SECONDS = 5;
const SLOW_PAUSE_MS = 9_000;
const ANYONE_COS = 'id="qcs::cam::anyone:anyone"';
const ANYONE_S3 = 'uri="http://acs.amazonaws.com/groups/global/AllUsers"';

/**
 * Unsigned COS and S3 headers added to an otherwise exact staging PUT, one
 * probe each: every one must be refused and leave nothing behind, since the
 * signing identity can read every original. A copy-source value names the
 * signed-put object; a grant names everyone.
 */
const UNSIGNED: readonly (readonly [
  string,
  (context: {
    bucket: string;
    host: string;
    source: string;
  }) => Record<string, string>,
])[] = [
  ["x-cos-storage-class", () => ({ "x-cos-storage-class": "ARCHIVE" })],
  ["x-amz-storage-class", () => ({ "x-amz-storage-class": "GLACIER" })],
  ["x-cos-meta", () => ({ "x-cos-meta-probe": "1" })],
  ["x-amz-meta", () => ({ "x-amz-meta-probe": "1" })],
  [
    "x-cos-copy-source",
    ({ host, source }) => ({ "x-cos-copy-source": `${host}/${source}` }),
  ],
  [
    "x-amz-copy-source",
    ({ bucket, source }) => ({ "x-amz-copy-source": `${bucket}/${source}` }),
  ],
  ["x-cos-acl", () => ({ "x-cos-acl": "public-read" })],
  ["x-amz-acl", () => ({ "x-amz-acl": "public-read" })],
  ["x-cos-grant-read", () => ({ "x-cos-grant-read": ANYONE_COS })],
  ["x-cos-grant-read-acp", () => ({ "x-cos-grant-read-acp": ANYONE_COS })],
  ["x-cos-grant-write-acp", () => ({ "x-cos-grant-write-acp": ANYONE_COS })],
  [
    "x-cos-grant-full-control",
    () => ({ "x-cos-grant-full-control": ANYONE_COS }),
  ],
  ["x-amz-grant-read", () => ({ "x-amz-grant-read": ANYONE_S3 })],
  ["x-amz-grant-read-acp", () => ({ "x-amz-grant-read-acp": ANYONE_S3 })],
  ["x-amz-grant-write-acp", () => ({ "x-amz-grant-write-acp": ANYONE_S3 })],
  [
    "x-amz-grant-full-control",
    () => ({ "x-amz-grant-full-control": ANYONE_S3 }),
  ],
  // Under L1 it replaces the signed value; under L2 it is simply unsigned.
  ["x-cos-tagging", () => ({ "x-cos-tagging": "probe=1" })],
  ["x-amz-tagging", () => ({ "x-amz-tagging": "probe=1" })],
  [
    "x-cos-metadata-directive",
    () => ({ "x-cos-metadata-directive": "Replaced" }),
  ],
  [
    "x-amz-metadata-directive",
    () => ({ "x-amz-metadata-directive": "REPLACE" }),
  ],
  ["x-cos-sse", () => ({ "x-cos-server-side-encryption": "AES256" })],
  ["x-cos-sse-kms", () => ({ "x-cos-server-side-encryption": "cos/kms" })],
  ["x-amz-sse", () => ({ "x-amz-server-side-encryption": "AES256" })],
  ["x-amz-sse-kms", () => ({ "x-amz-server-side-encryption": "aws:kms" })],
  ["x-cos-sse-c", () => customerKey("x-cos")],
  ["x-amz-sse-c", () => customerKey("x-amz")],
];
/**
 * Unsigned standard headers: refused, or not stored, or stored where the
 * Admin's HEAD shows it, so complete refuses that staging object
 * (INGEST_STAGING_INVALID) before any copy.
 */
const STANDARD: readonly (readonly [string, string])[] = [
  ["content-encoding", "gzip"],
  ["content-disposition", "attachment"],
  ["cache-control", "public, max-age=1"],
  ["content-language", "en"],
  ["expires", "Thu, 01 Jan 2099 00:00:00 GMT"],
];
const customerKey = (prefix: "x-cos" | "x-amz") => {
  const key = randomBytes(32);
  return {
    [`${prefix}-server-side-encryption-customer-algorithm`]: "AES256",
    [`${prefix}-server-side-encryption-customer-key`]: key.toString("base64"),
    [`${prefix}-server-side-encryption-customer-key-MD5`]: createHash("md5")
      .update(key)
      .digest("base64"),
  };
};

/** Every probe this runner makes, in order (the bucket plan lists them). */
export const INGEST_PROBE_IDS: readonly string[] = [
  "signed-put",
  "staging-attributes",
  "put-etag-md5",
  "head-missing",
  "second-put",
  "fetch-put",
  "wrong-length",
  "missing-forbid-overwrite",
  "missing-signed-header",
  "bad-md5",
  ...UNSIGNED.map(([name]) => `unsigned-${name}`),
  ...STANDARD.map(([name]) => `unsigned-${name}`),
  "query-acl",
  "query-tagging",
  "query-uploads",
  "other-key",
  "other-method",
  "anonymous-get",
  "slow-put",
  "copy-if-match-wrong",
  "copy-if-match",
  "copy-forbid-overwrite",
  "copy-keeps-checksums",
  "copy-keeps-etag",
  "copy-keeps-metadata",
  "anonymous-get-copy",
  "head-tag-count",
  "copy-strips-tags",
  "cleanup",
];
/** Made only under L1. */
const L1_ONLY = new Set(["head-tag-count", "copy-strips-tags"]);
/** What the Owner checks with the Owner's own identity (S0, or the COS web UI). */
export const INGEST_OWNER_CHECKS = {
  L1: ["signed-tagging", "lifecycle-and-filter", "versioning", "encryption"],
  L2: ["versioning", "encryption"],
} as const;

/**
 * Sub-resources added to a URL signed for an object that exists. A COS that
 * left one out of the signature check would run PutObjectAcl,
 * PutObjectTagging or a multipart start on that object, and would answer a
 * key never written with 404, which is why these probes need an object.
 * The ACL and tagging probes send the operation's own document as the body
 * and sign the URL for it, its MD5 and length declared the way an uploader
 * can declare any body's: an AccessControlPolicy that grants everyone READ,
 * and a Tagging document with two tags. No unsigned header goes with them, so
 * a COS that refuses unsigned headers before it routes a sub-resource still
 * gets the request; an honoured call makes the object anonymously readable or
 * changes the tag count HEAD shows.
 */
const SUB_RESOURCES = [
  ["query-acl", "acl", "PUT"],
  ["query-tagging", "tagging", "PUT"],
  ["query-uploads", "uploads", "POST"],
] as const;
const SUB_RESOURCE_BODIES: Readonly<Record<string, Uint8Array>> = {
  acl: new TextEncoder().encode(
    '<?xml version="1.0" encoding="UTF-8"?><AccessControlPolicy><AccessControlList><Grant><Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="Group"><URI>http://cam.qcloud.com/groups/global/AllUsers</URI></Grantee><Permission>READ</Permission></Grant></AccessControlList></AccessControlPolicy>',
  ),
  tagging: new TextEncoder().encode(
    '<?xml version="1.0" encoding="UTF-8"?><Tagging><TagSet><Tag><Key>probe</Key><Value>1</Value></Tag><Tag><Key>probe-two</Key><Value>2</Value></Tag></TagSet></Tagging>',
  ),
};

const refused = (status: number) => status >= 400 && status < 500;
const success = (status: number) => status >= 200 && status < 300;
const md5 = (bytes: Uint8Array) => createHash("md5").update(bytes);

/**
 * Runs every probe in order and reports. It never throws for what COS
 * answers; a probe whose request failed records status 0 and fails.
 */
export async function runIngestProbes(options: {
  lifecycle: ProbeLifecycle;
  storage: IngestProbeStorage;
  transport: ProbeTransport;
  /** Node's fetch: the transport of the Codex library's staging PUT. */
  fetchImpl: typeof fetch;
  /**
   * Leaves the signed-put object for the Owner's GetObjectTagging (L1), which
   * the Admin's identity is not granted; the Owner deletes it afterwards.
   */
  keepSource?: boolean;
  signal?: AbortSignal;
  now?: () => number;
}): Promise<ProbeReport> {
  const { lifecycle, storage, transport } = options;
  const now = options.now ?? Date.now;
  const tagged = lifecycle === "L1";
  const outcomes: ProbeOutcome[] = [];
  const created = new Set<string>();
  const signal = () =>
    options.signal
      ? AbortSignal.any([
          options.signal,
          AbortSignal.timeout(REQUEST_TIMEOUT_MS + SLOW_PAUSE_MS),
        ])
      : AbortSignal.timeout(REQUEST_TIMEOUT_MS + SLOW_PAUSE_MS);
  const record = (
    id: string,
    pass: boolean,
    observed: ProbeOutcome["observed"],
    gate: ProbeGate = "always",
  ) => outcomes.push({ id, gate, pass, observed });
  const freshKey = () => {
    const key = stagingKeyFor(randomBytes(32).toString("hex"));
    created.add(key);
    return key;
  };
  const head = async (key: string): Promise<StoredObject | null | "error"> => {
    try {
      return await storage.head(key, signal());
    } catch {
      return "error";
    }
  };
  /** Stored or not by the Admin's HEAD; null when HEAD itself failed. */
  const presence = async (key: string) => {
    const found = await head(key);
    return found === "error" ? null : found !== null;
  };
  const send = async (request: ProbeRequest) => {
    try {
      return await transport(request, signal());
    } catch {
      return 0;
    }
  };

  const body = new Uint8Array(randomBytes(BODY_BYTES));
  const object = {
    bytes: body.byteLength,
    mimeType: "image/jpeg" as const,
    md5Base64: md5(body).digest("base64"),
  };
  const headers: IngestUploadHeaders = stagingUploadHeaders(object, tagged);
  const sign = (
    key: string,
    expiresIn = INGEST_URL_TTL_SECONDS,
    signed: IngestUploadHeaders = headers,
  ) => storage.signPut(key, signed, new Date(now()), expiresIn);
  const put = async (
    key: string,
    change: {
      headers?: Record<string, string>;
      omit?: string;
      body?: Uint8Array;
    } = {},
  ) => {
    const sent: Record<string, string> = { ...headers, ...change.headers };
    if (change.omit) delete sent[change.omit];
    return send({
      method: "PUT",
      url: await sign(key),
      headers: sent,
      body: change.body ?? body,
    });
  };
  /** Refused, and nothing stored under the probe's key. */
  const refusedProbe = async (
    id: string,
    change: Parameters<typeof put>[1],
  ) => {
    const key = freshKey();
    const status = await put(key, change);
    const stored = await presence(key);
    record(id, refused(status) && stored === false, { status, stored });
  };

  // signed-put: the object every later probe reads, copies or names.
  const source = freshKey();
  const signedUrl = new URL(await sign(source));
  const bucket = signedUrl.hostname.split(".")[0]!;
  const bucketOrigin = signedUrl.origin;
  const putStatus = await send({
    method: "PUT",
    url: signedUrl.href,
    headers,
    body,
  });
  record("signed-put", success(putStatus), { status: putStatus });
  const staged = await head(source);
  const stagedObject = staged && staged !== "error" ? staged : null;
  record(
    "staging-attributes",
    stagedObject !== null &&
      stagedObject.bytes === body.byteLength &&
      stagedObject.contentType === object.mimeType &&
      !stagedObject.extraAttributes,
    {
      found: stagedObject !== null,
      contentType: stagedObject?.contentType === object.mimeType,
      extraAttributes: stagedObject?.extraAttributes ?? null,
    },
  );
  const etagMd5 =
    stagedObject !== null &&
    stagedObject.etag.replace(/^"(.*)"$/, "$1").toLowerCase() ===
      md5(body).digest("hex");
  record("put-etag-md5", etagMd5, { etagIsMd5: etagMd5 }, "md5-mode");
  {
    // complete reads a missing staging or final key as absent from a 404;
    // an identity that gets 403 instead would answer every complete 503.
    const found = await head(freshKey());
    record("head-missing", found === null, { absent: found === null });
  }
  const secondStatus = await send({
    method: "PUT",
    url: signedUrl.href,
    headers,
    body,
  });
  record("second-put", secondStatus === 409, { status: secondStatus });

  {
    const key = freshKey();
    let status: number;
    try {
      const response = await options.fetchImpl(await sign(key), {
        method: "PUT",
        headers: { ...headers },
        body,
        redirect: "error",
        credentials: "omit",
        signal: signal(),
      });
      await response.body?.cancel().catch(() => undefined);
      status = response.status;
    } catch {
      status = 0;
    }
    record("fetch-put", success(status), { status });
  }

  await refusedProbe("wrong-length", {
    headers: { "content-length": String(body.byteLength - 1) },
    body: body.subarray(0, body.byteLength - 1),
  });
  await refusedProbe("missing-forbid-overwrite", {
    omit: "x-cos-forbid-overwrite",
  });
  await refusedProbe("missing-signed-header", { omit: "content-md5" });
  {
    const other = new Uint8Array(body);
    other[0] = other[0]! ^ 0xff;
    await refusedProbe("bad-md5", { body: other });
  }
  for (const [name, make] of UNSIGNED)
    await refusedProbe(`unsigned-${name}`, {
      headers: make({ bucket, host: signedUrl.host, source }),
    });
  for (const [name, value] of STANDARD) {
    const key = freshKey();
    const status = await put(key, { headers: { [name]: value } });
    const found = await head(key);
    const stored = found === "error" ? null : found !== null;
    record(
      `unsigned-${name}`,
      refused(status)
        ? stored === false
        : success(status) &&
            found !== "error" &&
            found !== null &&
            found.contentType === object.mimeType,
      {
        status,
        stored,
        // Shown on HEAD: complete refuses it before any copy.
        shownOnHead:
          found !== null && found !== "error" ? found.extraAttributes : null,
      },
    );
  }
  for (const [id, parameter, method] of SUB_RESOURCES) {
    // Its own object, placed by the exact signed PUT; the sub-resource goes
    // on a URL signed for that key and for the body sent, every header
    // signed, so only the added parameter is outside the signature.
    const key = freshKey();
    const placed = await send({
      method: "PUT",
      url: await sign(key),
      headers,
      body,
    });
    const before = await head(key);
    const requestBody = SUB_RESOURCE_BODIES[parameter] ?? body;
    const requestHeaders =
      requestBody === body
        ? headers
        : stagingUploadHeaders(
            {
              bytes: requestBody.byteLength,
              mimeType: object.mimeType,
              md5Base64: md5(requestBody).digest("base64"),
            },
            tagged,
          );
    const url = new URL(await sign(key, undefined, requestHeaders));
    url.searchParams.set(parameter, "");
    const status = await send({
      method,
      url: url.href,
      headers: requestHeaders,
      body: requestBody,
    });
    const after = await head(key);
    const anonymous = await send({
      method: "GET",
      url: `${bucketOrigin}/${key}`,
      headers: {},
    });
    const found = (value: typeof before) =>
      value !== null && value !== "error" ? value : null;
    const was = found(before);
    const is = found(after);
    const unchanged =
      was !== null &&
      is !== null &&
      is.etag === was.etag &&
      is.bytes === was.bytes &&
      is.tagCount === was.tagCount &&
      is.extraAttributes === was.extraAttributes;
    record(
      id,
      success(placed) &&
        status === 403 &&
        unchanged &&
        refused(anonymous) &&
        anonymous !== 404,
      {
        put: placed,
        status,
        unchanged,
        tagCount: is?.tagCount ?? null,
        anonymous,
      },
    );
  }
  {
    const key = freshKey();
    const url = new URL(await sign(freshKey()));
    url.pathname = `/${key}`;
    const status = await send({ method: "PUT", url: url.href, headers, body });
    const stored = await presence(key);
    record("other-key", refused(status) && stored === false, {
      status,
      stored,
    });
  }
  {
    // Its own object, so an honoured DELETE takes nothing the rest needs.
    const key = freshKey();
    const url = await sign(key);
    const placed = await send({ method: "PUT", url, headers, body });
    const statuses: Record<string, number> = {};
    for (const method of ["GET", "HEAD", "POST", "DELETE"] as const)
      statuses[method] = await send({ method, url, headers: {} });
    const kept = success(placed) && (await presence(key)) === true;
    record("other-method", Object.values(statuses).every(refused) && kept, {
      put: placed,
      ...statuses,
      kept,
    });
  }
  {
    const target = `${bucketOrigin}/${source}`;
    const whole = await send({ method: "GET", url: target, headers: {} });
    const first = await send({
      method: "GET",
      url: target,
      headers: { range: "bytes=0-0" },
    });
    record("anonymous-get", refused(whole) && refused(first) && whole !== 404, {
      get: whole,
      range: first,
    });
  }
  {
    const key = freshKey();
    const url = await sign(key, SLOW_EXPIRES_SECONDS);
    const status = await send({
      method: "PUT",
      url,
      headers,
      body,
      pauseMs: SLOW_PAUSE_MS,
    });
    record("slow-put", success(status), { status });
  }

  // The Admin's copy, between staging keys.
  const copyTarget = freshKey();
  const copy = async (etag: string) => {
    try {
      return await storage.copy(source, copyTarget, etag, tagged, signal());
    } catch {
      return 0;
    }
  };
  {
    const status = await copy(`"${"0".repeat(32)}"`);
    const stored = await presence(copyTarget);
    record("copy-if-match-wrong", status === 412 && stored === false, {
      status,
      stored,
    });
  }
  const copied = stagedObject ? await copy(stagedObject.etag) : 0;
  record("copy-if-match", success(copied), { status: copied });
  const again = stagedObject ? await copy(stagedObject.etag) : 0;
  record("copy-forbid-overwrite", again === 409, { status: again });
  const copiedHead = await head(copyTarget);
  const copiedObject = copiedHead && copiedHead !== "error" ? copiedHead : null;
  const sameEtag =
    copiedObject !== null && copiedObject.etag === stagedObject?.etag;
  const sameCrc64 =
    copiedObject !== null &&
    copiedObject.crc64 !== null &&
    copiedObject.crc64 === stagedObject?.crc64;
  record(
    "copy-keeps-checksums",
    copiedObject !== null &&
      copiedObject.bytes === stagedObject?.bytes &&
      (sameEtag || sameCrc64),
    { found: copiedObject !== null, sameEtag, sameCrc64 },
  );
  record("copy-keeps-etag", sameEtag, { sameEtag }, "md5-mode");
  // Under L1 the source carries the staging tag, and a copy that keeps it is
  // copy-strips-tags' failure (gate l1: choose L2), not a rollout stop; under
  // L2 the source has no tag, so the copy must have none either.
  record(
    "copy-keeps-metadata",
    copiedObject !== null &&
      copiedObject.contentType === object.mimeType &&
      !copiedObject.extraAttributes &&
      (tagged || copiedObject.tagCount === 0),
    {
      found: copiedObject !== null,
      contentType: copiedObject?.contentType === object.mimeType,
      extraAttributes: copiedObject?.extraAttributes ?? null,
      tagCount: copiedObject?.tagCount ?? null,
    },
  );
  {
    const status = await send({
      method: "GET",
      url: `${bucketOrigin}/${copyTarget}`,
      headers: {},
    });
    record("anonymous-get-copy", refused(status) && status !== 404, {
      status,
    });
  }
  if (tagged) {
    record(
      "head-tag-count",
      stagedObject?.tagCount === 1,
      {
        tagCount: stagedObject?.tagCount ?? null,
      },
      "l1",
    );
    record(
      "copy-strips-tags",
      copiedObject?.tagCount === 0,
      {
        tagCount: copiedObject?.tagCount ?? null,
      },
      "l1",
    );
  }

  // cleanup: nothing of this run stays under the staging prefix.
  let removed = 0;
  let left = 0;
  for (const key of created) {
    if (options.keepSource === true && key === source) continue;
    try {
      await storage.remove(key, signal());
      removed++;
    } catch {
      /* counted below */
    }
    if ((await presence(key)) !== false) left++;
  }
  record("cleanup", left === 0, {
    removed,
    left,
    kept: options.keepSource === true,
  });

  const verdict = (gate: ProbeGate) => {
    const gated = outcomes.filter((outcome) => outcome.gate === gate);
    if (!gated.length) return "not-run" as const;
    return gated.every((outcome) => outcome.pass)
      ? ("pass" as const)
      : ("fail" as const);
  };
  return {
    version: 1,
    lifecycle,
    verdict: {
      always: verdict("always"),
      md5Mode: verdict("md5-mode"),
      l1: verdict("l1"),
    },
    failed: outcomes.filter((outcome) => !outcome.pass).map(({ id }) => id),
    probes: outcomes,
    ownerChecks: INGEST_OWNER_CHECKS[lifecycle],
  };
}

/** The probe ids a lifecycle runs, in order. */
export const ingestProbeIds = (lifecycle: ProbeLifecycle) =>
  INGEST_PROBE_IDS.filter((id) => lifecycle === "L1" || !L1_ONLY.has(id));

/**
 * The raw transport: one request with exactly the given headers (Node adds
 * Host and the framing), no agent reuse and no redirect, and the body
 * discarded. https only, except http for tests on loopback.
 */
export const createProbeTransport =
  (options: { allowLoopbackHttp?: boolean } = {}): ProbeTransport =>
  (request, signal) =>
    new Promise<number>((resolve) => {
      const url = new URL(request.url);
      const loopback =
        options.allowLoopbackHttp === true &&
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost"].includes(url.hostname);
      if (url.protocol !== "https:" && !loopback) return resolve(0);
      let settled = false;
      const done = (status: number) => {
        if (!settled) resolve(status);
        settled = true;
      };
      const outgoing = (loopback ? http : https).request(
        url,
        {
          method: request.method,
          headers: { ...request.headers },
          agent: false,
          signal,
        },
        (response) => {
          response.resume();
          response.on("end", () => done(response.statusCode ?? 0));
          response.on("error", () => done(response.statusCode ?? 0));
          response.on("close", () => done(response.statusCode ?? 0));
        },
      );
      outgoing.on("error", () => done(0));
      const body = request.body;
      if (!body) return void outgoing.end();
      if (request.pauseMs === undefined) return void outgoing.end(body);
      const half = Math.floor(body.byteLength / 2);
      outgoing.write(body.subarray(0, half));
      const timer = setTimeout(
        () => outgoing.end(body.subarray(half)),
        request.pauseMs,
      );
      signal.addEventListener("abort", () => clearTimeout(timer), {
        once: true,
      });
    });
