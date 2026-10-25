/**
 * Catalog ingest bucket plan (catalog-scale-v1 increment 2, Owner-run). No
 * network and no credentials: it prints or writes the option-1 CAM statement
 * for the Admin's COS write identity, limited to catalog-ingest/v1/*, merges
 * the staging lifecycle choice (L1: 1-day Expiration filtered by the staging
 * prefix AND the staging tag; L2: none) into a captured configuration, and
 * lists the dry-run probes that must pass before switch-on (the Admin's
 * Owner-run probe runner makes them; this CLI holds no credential to). There
 * is no CORS rule (no browser path). Real bucket values are read only from owner-only
 * (0600) input files and only ever go to a new private file given by --out;
 * standard output carries placeholders, digests and fixed codes.
 */
import { createHash } from "node:crypto";
import { open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import * as contracts from "../../packages/contracts/dist/internal/editorial/index.js";

const { CATALOG_INGEST_STAGING_TAGGING } = contracts;

export const STAGING_PREFIX = "catalog-ingest/v1/";
export const STAGING_RULE_ID = "moya-catalog-ingest-staging-expire";
/** Prefixes whose objects no generated rule may ever match. */
export const PROTECTED_PREFIXES = Object.freeze([
  "editorial/",
  "display/",
  "ugc/",
]);
// Catalog originals: an existing deleting rule over these stops the plan.
const ORIGINAL_PREFIXES = ["editorial/", "display/"];
// Rule keys that delete or move no object. Any other key (Expiration,
// Transitions, the noncurrent-version actions, or one this plan does not
// know) counts as deleting.
const KEEPING_KEYS = new Set([
  "ID",
  "Status",
  "Filter",
  "AbortIncompleteMultipartUpload",
]);
const MAX_INPUT_BYTES = 1024 * 1024;

const digest = (value) => createHash("sha256").update(value).digest("hex");
const plainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
/** Key-sorted JSON, so a read-back in another key order compares equal. */
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (plainObject(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
const throwCode = (code) => {
  const error = new Error(code);
  error.code = code;
  throw error;
};

/** {Key, Value} of the only tag a staging PUT carries (contracts). */
export function stagingTag() {
  const [Key, Value, extra] = String(CATALOG_INGEST_STAGING_TAGGING).split("=");
  if (!Key || !Value || extra !== undefined) throwCode("STAGING_TAG_INVALID");
  return { Key, Value };
}

const TARGET = {
  region: /^[a-z]{2,}(?:-[a-z0-9]+){1,3}$/,
  appId: /^[1-9][0-9]{4,11}$/,
  bucket: /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/,
};

/**
 * Option 1 (I2): one statement on the Admin's COS write identity, allowing
 * only object Put, Get, Head and Delete (and PutObjectTagging for L1) under
 * catalog-ingest/v1/*: no list, multipart, ACL or bucket configuration. The
 * final editorial/ write stays the existing Put grant. Without a target the
 * resource carries placeholders.
 */
export function camStatement({ lifecycle, target } = {}) {
  if (!["L1", "L2"].includes(lifecycle)) throwCode("LIFECYCLE_CHOICE_INVALID");
  let resource = `qcs::cos:<region>:uid/<appid>:<bucket>-<appid>/${STAGING_PREFIX}*`;
  if (target !== undefined) {
    if (
      !plainObject(target) ||
      Object.keys(target).some((key) => !(key in TARGET)) ||
      Object.entries(TARGET).some(
        ([key, pattern]) =>
          typeof target[key] !== "string" || !pattern.test(target[key]),
      ) ||
      !target.bucket.endsWith(`-${target.appId}`)
    )
      throwCode("TARGET_INVALID");
    resource = `qcs::cos:${target.region}:uid/${target.appId}:${target.bucket}/${STAGING_PREFIX}*`;
  }
  return {
    version: "2.0",
    statement: [
      {
        effect: "allow",
        action: [
          "name/cos:PutObject",
          "name/cos:GetObject",
          "name/cos:HeadObject",
          "name/cos:DeleteObject",
          ...(lifecycle === "L1" ? ["name/cos:PutObjectTagging"] : []),
        ],
        resource: [resource],
      },
    ],
  };
}

const tagList = (value) =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

/**
 * A rule's filter as {prefix, tags}, or null for a rule without a Filter. A
 * filter the plan does not understand counts as prefix-less (it could match
 * anything), never as narrower.
 */
export function ruleFilter(rule) {
  if (!plainObject(rule?.Filter)) return null;
  const filter = rule.Filter;
  const keys = Object.keys(filter);
  if (keys.length === 0) return { prefix: "", tags: [], known: true };
  if (keys.length === 1 && typeof filter.Prefix === "string")
    return { prefix: filter.Prefix, tags: [], known: true };
  if (keys.length === 1 && plainObject(filter.Tag))
    return { prefix: "", tags: [filter.Tag], known: true };
  if (keys.length === 1 && plainObject(filter.And)) {
    const and = filter.And;
    const andKeys = Object.keys(and);
    if (
      andKeys.every((key) => ["Prefix", "Tags", "Tag"].includes(key)) &&
      (and.Prefix === undefined || typeof and.Prefix === "string")
    )
      return {
        prefix: and.Prefix ?? "",
        tags: [...tagList(and.Tags), ...tagList(and.Tag)],
        known: true,
      };
  }
  return { prefix: "", tags: [], known: false };
}

/** Whether a filter prefix could match any object under the given prefix. */
export const overlaps = (prefix, protectedPrefix) =>
  protectedPrefix.startsWith(prefix) || prefix.startsWith(protectedPrefix);

const removes = (rule) =>
  Object.keys(rule).some((key) => !KEEPING_KEYS.has(key));

/** The L1 rule: 1-day Expiration of tagged staging objects only. */
export function stagingRule() {
  return {
    ID: STAGING_RULE_ID,
    Status: "Enabled",
    Filter: { And: { Prefix: STAGING_PREFIX, Tags: [stagingTag()] } },
    Expiration: { Days: 1 },
  };
}

/**
 * Refuses a rule the plan would add unless its Filter has a non-empty prefix
 * that matches nothing under a protected prefix, and (L1) exactly the staging
 * prefix AND the staging tag, with only a 1-day Expiration.
 */
export function assertGeneratedRule(rule) {
  const filter = ruleFilter(rule);
  if (!filter) throwCode("RULE_WITHOUT_FILTER");
  if (!filter.known || filter.prefix === "") throwCode("RULE_PREFIX_EMPTY");
  if (PROTECTED_PREFIXES.some((prefix) => overlaps(filter.prefix, prefix)))
    throwCode("RULE_MATCHES_PROTECTED_PREFIX");
  const tag = stagingTag();
  if (
    filter.prefix !== STAGING_PREFIX ||
    filter.tags.length !== 1 ||
    filter.tags[0]?.Key !== tag.Key ||
    filter.tags[0]?.Value !== tag.Value ||
    Object.keys(filter.tags[0]).length !== 2
  )
    throwCode("RULE_FILTER_NOT_STAGING");
  if (
    rule.Status !== "Enabled" ||
    JSON.stringify(rule.Expiration) !== JSON.stringify({ Days: 1 }) ||
    Object.keys(rule).some(
      (key) => !["ID", "Status", "Filter", "Expiration"].includes(key),
    )
  )
    throwCode("RULE_ACTION_INVALID");
  return rule;
}

/**
 * The captured rules. Only the S3 API JSON shape is read: any other top-level
 * key (the XML or SDK {Rule: [...]} shape among them) refuses, so a
 * configuration is never mistaken for an empty one.
 */
function lifecycleRules(current) {
  if (
    !plainObject(current) ||
    Object.keys(current).some((key) => key !== "Rules") ||
    (current.Rules !== undefined && !Array.isArray(current.Rules)) ||
    (current.Rules ?? []).some((rule) => !plainObject(rule))
  )
    throwCode("CURRENT_LIFECYCLE_INVALID");
  return current.Rules ?? [];
}

const ruleId = (rule, index) =>
  typeof rule.ID === "string" && rule.ID ? rule.ID : `#${index + 1}`;

/**
 * Merges the lifecycle choice into the captured configuration (the S3 API
 * JSON shape, {Rules: [...]}, or {} when the bucket has none). Existing rules
 * are kept byte for byte. Every rule, the one under the staging rule's ID
 * included, is checked: it stops on a rule without a Filter or with a
 * rule-level Prefix beside one, on a rule that is not Disabled and deletes,
 * transitions or does anything unknown under a filter that could match
 * editorial/ or display/, and, under L1 and L2 alike, on any rule under the
 * staging rule's ID other than the generated one (compared key-sorted). Rules
 * over the staging or UGC prefixes are reported by ID.
 */
export function planLifecycle({ current, choice }) {
  if (!["L1", "L2"].includes(choice)) throwCode("LIFECYCLE_CHOICE_INVALID");
  const rules = lifecycleRules(current);
  const covering = { originals: [], staging: [], ugc: [] };
  rules.forEach((rule, index) => {
    if (rule.Prefix !== undefined && rule.Filter !== undefined)
      throwCode("EXISTING_RULE_FILTER_AMBIGUOUS");
    const filter = ruleFilter(rule);
    if (!filter) throwCode("EXISTING_RULE_WITHOUT_FILTER");
    const id = ruleId(rule, index);
    if (
      rule.Status !== "Disabled" &&
      removes(rule) &&
      ORIGINAL_PREFIXES.some((prefix) => overlaps(filter.prefix, prefix))
    )
      covering.originals.push(id);
    if (overlaps(filter.prefix, STAGING_PREFIX)) covering.staging.push(id);
    if (overlaps(filter.prefix, "ugc/")) covering.ugc.push(id);
  });
  if (covering.originals.length) throwCode("EXISTING_RULE_COVERS_ORIGINALS");
  const rule = assertGeneratedRule(stagingRule());
  const named = rules.filter((existing) => existing.ID === STAGING_RULE_ID);
  if (
    named.length > 1 ||
    (named.length === 1 && canonical(named[0]) !== canonical(rule))
  )
    throwCode("RULE_ID_COLLISION");
  let added = [];
  let configuration = current;
  if (choice === "L1" && named.length === 0) {
    configuration = { ...current, Rules: [...rules, rule] };
    added = [rule.ID];
  }
  if (
    JSON.stringify(lifecycleRules(configuration).slice(0, rules.length)) !==
    JSON.stringify(rules)
  )
    throwCode("MERGE_CHANGED_EXISTING");
  return {
    configuration,
    report: {
      choice,
      existingRules: rules.length,
      added,
      unchanged: added.length === 0,
      coveringStaging: covering.staging,
      coveringUgc: covering.ugc,
    },
    diff: lineDiff(
      JSON.stringify(current, null, 2),
      JSON.stringify(configuration, null, 2),
    ),
  };
}

/** Changed lines only, as "+ " / "- " rows after an "@@ -a +b" header. */
export function lineDiff(before, after) {
  const a = before.split("\n"),
    b = after.split("\n");
  const lcs = Array.from({ length: a.length + 1 }, () =>
    new Array(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i -= 1)
    for (let j = b.length - 1; j >= 0; j -= 1)
      lcs[i][j] =
        a[i] === b[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const rows = [];
  let i = 0,
    j = 0,
    hunk = null;
  const flush = () => {
    if (hunk) rows.push(`@@ -${hunk.a} +${hunk.b}`, ...hunk.rows);
    hunk = null;
  };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      flush();
      i++;
      j++;
    } else {
      hunk ??= { a: i + 1, b: j + 1, rows: [] };
      if (j < b.length && (i === a.length || lcs[i][j + 1] >= lcs[i + 1][j]))
        hunk.rows.push(`+ ${b[j++]}`);
      else hunk.rows.push(`- ${a[i++]}`);
    }
  }
  flush();
  return rows;
}

/**
 * Unsigned COS and S3 headers the dry run adds to an exact staging PUT, one
 * probe each (apps/admin/src/media/ingest-probes.ts runs them).
 */
const UNSIGNED_PROBES = [
  ["x-cos-storage-class", "x-cos-storage-class: ARCHIVE"],
  ["x-amz-storage-class", "x-amz-storage-class: GLACIER"],
  ["x-cos-meta", "x-cos-meta-probe: 1"],
  ["x-amz-meta", "x-amz-meta-probe: 1"],
  ["x-cos-copy-source", "x-cos-copy-source naming the signed-put object"],
  ["x-amz-copy-source", "x-amz-copy-source: <bucket>/<signed-put key>"],
  ["x-cos-acl", "x-cos-acl: public-read"],
  ["x-amz-acl", "x-amz-acl: public-read"],
  ["x-cos-grant-read", "x-cos-grant-read for anyone"],
  ["x-cos-grant-read-acp", "x-cos-grant-read-acp for anyone"],
  ["x-cos-grant-write-acp", "x-cos-grant-write-acp for anyone"],
  ["x-cos-grant-full-control", "x-cos-grant-full-control for anyone"],
  ["x-amz-grant-read", "x-amz-grant-read for AllUsers"],
  ["x-amz-grant-read-acp", "x-amz-grant-read-acp for AllUsers"],
  ["x-amz-grant-write-acp", "x-amz-grant-write-acp for AllUsers"],
  ["x-amz-grant-full-control", "x-amz-grant-full-control for AllUsers"],
  [
    "x-cos-tagging",
    "x-cos-tagging: probe=1 (under L1 in place of the signed value)",
  ],
  ["x-amz-tagging", "x-amz-tagging: probe=1"],
  ["x-cos-metadata-directive", "x-cos-metadata-directive: Replaced"],
  ["x-amz-metadata-directive", "x-amz-metadata-directive: REPLACE"],
  ["x-cos-sse", "x-cos-server-side-encryption: AES256"],
  ["x-cos-sse-kms", "x-cos-server-side-encryption: cos/kms"],
  ["x-amz-sse", "x-amz-server-side-encryption: AES256"],
  ["x-amz-sse-kms", "x-amz-server-side-encryption: aws:kms"],
  ["x-cos-sse-c", "the x-cos-server-side-encryption-customer-* headers"],
  ["x-amz-sse-c", "the x-amz-server-side-encryption-customer-* headers"],
];
const STANDARD_PROBES = [
  "content-encoding",
  "content-disposition",
  "cache-control",
  "content-language",
  "expires",
];

/**
 * The staging dry run, in the order the Owner-run probe runner makes it
 * (`pnpm --filter admin exec payload run scripts/catalog-ingest-probes.ts`),
 * then the checks the Owner makes with the Owner's own identity. The runner
 * shapes every request with the Admin's own code: the staging PUT URL by its
 * signer (a SigV4 query signature with the SDK's x-id parameter) and the
 * copy, HEAD and DELETE by its ingest storage, in the S3 API spellings COS's
 * S3-compatible layer must honour. Synthetic objects under the staging prefix
 * only (never editorial/). gate "always" must hold before
 * CMS_CATALOG_INGEST=on (a failure stops the rollout), "md5-mode" also before
 * CMS_CATALOG_INGEST_SERVER_SHA256=off and "l1" also before
 * CMS_CATALOG_INGEST_STAGING_TAG=on (a failure of "l1" alone chooses L2).
 */
export function probeChecklist({ lifecycle } = {}) {
  if (!["L1", "L2"].includes(lifecycle)) throwCode("LIFECYCLE_CHOICE_INVALID");
  const tagged = lifecycle === "L1";
  const nothing = "refused (4xx), nothing stored";
  // A sub-resource COS left out of the signature check would answer a key
  // never written with 404, so these probes need an object and only a 403.
  const subResource =
    "403 exactly; then HEAD shows the object unchanged (ETag, length and tag count) and an anonymous GET of it is still 403";
  const runner = [
    [
      "signed-put",
      "PUT a synthetic object with exactly the signed headers to the URL the Admin's signer makes (X-Amz-* and x-id=PutObject)",
      "2xx",
    ],
    [
      "staging-attributes",
      "HEAD it with the Admin's own parser",
      "the signed Content-Type and nothing a signed PUT never sets (encoding, disposition, language, cache control, expiry, user metadata, a storage class, encryption other than SSE-COS)",
    ],
    [
      "put-etag-md5",
      "compare its ETag with the hex MD5 of the body",
      "equal (required for CMS_CATALOG_INGEST_SERVER_SHA256=off)",
      "md5-mode",
    ],
    [
      "head-missing",
      "HEAD a staging key never written, with the Admin's parser",
      "absent (404): complete reads a missing staging or final object from it, and a 403 would answer every complete 503",
    ],
    ["second-put", "repeat the same PUT", "409 (forbid-overwrite)"],
    [
      "fetch-put",
      "the same PUT through Node's fetch, as the Codex library sends it (fetch adds its own accept, user-agent and similar headers)",
      "2xx",
    ],
    [
      "wrong-length",
      "PUT with a Content-Length one byte short of the signed one, and that body",
      nothing,
    ],
    ["missing-forbid-overwrite", "PUT without x-cos-forbid-overwrite", nothing],
    ["missing-signed-header", "PUT without Content-MD5 (signed)", nothing],
    [
      "bad-md5",
      "PUT a body whose MD5 differs from the signed Content-MD5",
      nothing,
    ],
    ...UNSIGNED_PROBES.map(([name, header]) => [
      `unsigned-${name}`,
      `PUT adding an unsigned ${header}`,
      nothing,
    ]),
    ...STANDARD_PROBES.map((name) => [
      `unsigned-${name}`,
      `PUT adding an unsigned ${name}, then HEAD with the Admin's parser`,
      "refused, or not stored, or stored and shown on HEAD: complete then refuses that staging object (INGEST_STAGING_INVALID) before any copy",
    ]),
    [
      "query-acl",
      "PUT an object with the exact signed headers, then send a URL signed for that key and for an AccessControlPolicy body that grants everyone READ (its MD5 and length signed, no unsigned header) with ?acl added",
      subResource,
    ],
    [
      "query-tagging",
      "the same on its own object, with a URL signed for a Tagging document of two tags and ?tagging added",
      subResource,
    ],
    [
      "query-uploads",
      "the same on its own object, a POST with ?uploads added (a multipart start)",
      subResource,
    ],
    [
      "other-key",
      "PUT the signed URL with another staging key in the path",
      nothing,
    ],
    [
      "other-method",
      "GET, HEAD, POST and DELETE with a used PUT URL",
      "refused (4xx) each; the object stays",
    ],
    [
      "anonymous-get",
      "anonymous GET and Range 0-0 of the signed-put object",
      "403 each",
    ],
    [
      "slow-put",
      "a PUT whose URL lives 5 s, started in time and finished 9 s later",
      "2xx",
    ],
    [
      "copy-if-match-wrong",
      `the Admin's copy to a second staging key (x-amz-copy-source <bucket>/<key> with x-amz-copy-source-if-match, x-cos-forbid-overwrite: true and x-amz-metadata-directive: COPY${tagged ? ", x-amz-tagging-directive: REPLACE" : ""}) with another ETag`,
      "412, nothing stored",
    ],
    ["copy-if-match", "the same copy with the source ETag", "2xx"],
    ["copy-forbid-overwrite", "repeat that copy", "409"],
    [
      "copy-keeps-checksums",
      "HEAD source and copy",
      "the same length, and the same ETag or x-cos-hash-crc64ecma",
    ],
    [
      "copy-keeps-etag",
      "compare their ETags",
      "equal (required for CMS_CATALOG_INGEST_SERVER_SHA256=off: CRC64 alone is not enough)",
      "md5-mode",
    ],
    [
      "copy-keeps-metadata",
      "HEAD the copy with the Admin's parser",
      tagged
        ? "the signed Content-Type and nothing else (its tag is copy-strips-tags')"
        : "the signed Content-Type, nothing else and no tag",
    ],
    ["anonymous-get-copy", "anonymous GET of the copy", "403"],
    ...(tagged
      ? [
          [
            "head-tag-count",
            "HEAD the signed-put object",
            "x-cos-tagging-count (or x-amz-tagging-count): 1. Without it every L1 complete answers 503 INGEST_CONFIGURATION_INVALID: choose L2",
            "l1",
          ],
          [
            "copy-strips-tags",
            "HEAD the copy (x-amz-tagging-directive: REPLACE, no tags)",
            "a tag count of 0 or none. A copy that keeps the tag fails only this gate: choose L2",
            "l1",
          ],
        ]
      : []),
    [
      "cleanup",
      "DeleteObject on every probe key, then HEAD each",
      "nothing of the run left under the staging prefix (but the signed-put object with --keep-source)",
    ],
  ].map(([id, request, expect, gate = "always"]) => ({
    id,
    by: "runner",
    gate,
    request,
    expect,
  }));
  const owner = [
    ...(tagged
      ? [
          [
            "signed-tagging",
            "with --keep-source, GetObjectTagging of the kept signed-put object (the Owner's identity: the Admin's has no GetObjectTagging), then delete it",
            `exactly ${CATALOG_INGEST_STAGING_TAGGING}`,
            "l1",
          ],
          [
            "lifecycle-and-filter",
            "apply the L1 configuration, then read it back",
            "accepted; the plan run on the 0600 read-back answers unchanged: true",
            "l1",
          ],
        ]
      : []),
    ["versioning", "GetBucketVersioning (S0)", "not Enabled"],
    [
      "encryption",
      "GetBucketEncryption (S0)",
      "none, or SSE-COS (AES256): the Admin refuses staging with any other encryption",
    ],
  ].map(([id, request, expect, gate = "always"]) => ({
    id,
    by: "owner",
    gate,
    request,
    expect,
  }));
  return [...runner, ...owner];
}

/** A bounded JSON input that only its owner can read (0600 or narrower). */
async function readPrivateJSON(file) {
  const info = await stat(file);
  if (!info.isFile() || info.size > MAX_INPUT_BYTES || info.mode & 0o077)
    throwCode("LOCAL_FILE_INVALID");
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    throwCode("JSON_INVALID");
  }
}

/** Writes a new private file; never overwrites. Returns its SHA-256. */
async function writePrivate(file, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  let handle;
  try {
    handle = await open(file, "wx", 0o600);
  } catch {
    throwCode("OUTPUT_EXISTS_OR_UNWRITABLE");
  }
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return digest(text);
}

/** The CLI body, for tests; returns the object printed to standard output. */
export async function runPlan(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let index = 0; index < rest.length; index += 1) {
    const name = rest[index];
    if (
      ["--lifecycle", "--current", "--target", "--out"].includes(name) &&
      rest[index + 1] !== undefined
    )
      flags[name.slice(2)] = rest[++index];
    else throwCode("ARGUMENTS_INVALID");
  }
  if (command === "probes") {
    if (flags.current || flags.target || flags.out)
      throwCode("ARGUMENTS_INVALID");
    return { probes: probeChecklist({ lifecycle: flags.lifecycle }) };
  }
  if (command === "cam") {
    if (flags.current || Boolean(flags.target) !== Boolean(flags.out))
      throwCode("ARGUMENTS_INVALID");
    if (!flags.target)
      return { statement: camStatement({ lifecycle: flags.lifecycle }) };
    const statement = camStatement({
      lifecycle: flags.lifecycle,
      target: await readPrivateJSON(flags.target),
    });
    return {
      written: true,
      sha256: await writePrivate(path.resolve(flags.out), statement),
      action: statement.statement[0].action,
      resourcePrefix: `${STAGING_PREFIX}*`,
    };
  }
  if (command === "lifecycle") {
    if (flags.target || !flags.current) throwCode("ARGUMENTS_INVALID");
    const plan = planLifecycle({
      current: await readPrivateJSON(flags.current),
      choice: flags.lifecycle,
    });
    return {
      ...plan.report,
      diff: plan.diff,
      ...(flags.out && !plan.report.unchanged
        ? {
            written: true,
            sha256: await writePrivate(
              path.resolve(flags.out),
              plan.configuration,
            ),
          }
        : { written: false }),
    };
  }
  throwCode("COMMAND_INVALID");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  runPlan(process.argv.slice(2)).then(
    (result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`),
    (error) => {
      const code =
        typeof error?.code === "string" &&
        /^[A-Z][A-Z0-9_]{2,63}$/.test(error.code)
          ? error.code
          : "PLAN_FAILED";
      process.stderr.write(
        `CATALOG_INGEST_BUCKET_PLAN_REFUSED ${code}: nothing was written.\n`,
      );
      process.exitCode = 1;
    },
  );
