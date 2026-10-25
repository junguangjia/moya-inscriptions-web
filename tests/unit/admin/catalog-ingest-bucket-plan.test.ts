import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CATALOG_INGEST_STAGING_TAGGING } from "@moya/contracts/internal/editorial";
import { INGEST_OWNER_CHECKS, ingestProbeIds } from "admin/media-ingest-probes";
import {
  createCosIngestStorage,
  stagingKeyFor,
} from "admin/media-ingest-storage";
import { afterEach, describe, expect, it, vi } from "vitest";

// The Admin's ingest storage with only the SDK transport replaced, so the
// dry-run probes can be checked against the requests it really sends.
const sdk = await vi.hoisted(async () => {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const admin = createRequire(require.resolve("admin/config"));
  return {
    path: admin.resolve("@aws-sdk/client-s3"),
    sent: [] as { method: string; headers: Record<string, string> }[],
    /** Extra response headers of a HEAD. */
    headers: {} as Record<string, string>,
  };
});
vi.mock(sdk.path, async (importOriginal) => {
  const { Readable } = await import("node:stream");
  const actual = await importOriginal<{
    S3Client: new (config: Record<string, unknown>) => object;
  }>();
  const handle = async (request: {
    method: string;
    headers: Record<string, string>;
  }) => {
    sdk.sent.push({
      method: request.method,
      headers: Object.fromEntries(
        Object.entries(request.headers).map(([name, value]) => [
          name.toLowerCase(),
          String(value),
        ]),
      ),
    });
    return {
      response:
        request.method === "HEAD"
          ? {
              statusCode: 200,
              headers: {
                "content-length": "1024",
                etag: '"synthetic"',
                ...sdk.headers,
              },
              body: Readable.from([]),
            }
          : {
              statusCode: 200,
              headers: { "content-type": "application/xml" },
              body: Readable.from([
                Buffer.from(
                  '<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult><ETag>"synthetic"</ETag><LastModified>2026-10-23T00:00:00.000Z</LastModified></CopyObjectResult>',
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
const SDK_BUCKET = "synthetic-plan-1250000000";

/*
 * catalog-scale-v1 increment 2, slice S5: the no-network bucket plan the
 * Owner runs before switch-on. The CAM statement stays inside
 * catalog-ingest/v1/*, the L1 lifecycle rule can only expire tagged staging
 * objects, existing rules survive byte for byte, and any configuration that
 * could expire Catalog originals stops the plan. Synthetic values only.
 */

type Json = Record<string, unknown>;
type Plan = {
  configuration: Json;
  report: Json & { added: string[]; unchanged: boolean };
  diff: string[];
};
const SCRIPT = new URL(
  "../../../scripts/editorial/catalog-ingest-bucket-plan.mjs",
  import.meta.url,
);
const plan = (await import(SCRIPT.href)) as {
  STAGING_PREFIX: string;
  STAGING_RULE_ID: string;
  camStatement: (options: { lifecycle?: string; target?: unknown }) => {
    version: string;
    statement: { effect: string; action: string[]; resource: string[] }[];
  };
  planLifecycle: (options: { current: unknown; choice?: string }) => Plan;
  assertGeneratedRule: (rule: Json) => Json;
  stagingRule: () => Json;
  probeChecklist: (options: { lifecycle?: string }) => {
    id: string;
    by: "runner" | "owner";
    gate: "always" | "md5-mode" | "l1";
    request: string;
    expect: string;
  }[];
  runPlan: (argv: string[]) => Promise<Json>;
};

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const [tagKey, tagValue] = CATALOG_INGEST_STAGING_TAGGING.split("=");
const abortRule = {
  ID: "synthetic-ugc-staging-abort",
  Status: "Enabled",
  Filter: { Prefix: "ugc/publishing/synthetic/staging/" },
  AbortIncompleteMultipartUpload: { DaysAfterInitiation: 3 },
};
const otherRule = {
  Status: "Enabled",
  ID: "synthetic-logs-expire",
  Filter: { Prefix: "logs/" },
  Expiration: { Days: 30 },
  NoncurrentVersionExpiration: { NoncurrentDays: 7 },
};

describe("Catalog ingest CAM statement (option 1)", () => {
  it("allows only object reads and writes under the staging prefix", () => {
    const l1 = plan.camStatement({ lifecycle: "L1" });
    expect(l1.version).toBe("2.0");
    expect(l1.statement).toHaveLength(1);
    expect(l1.statement[0]).toEqual({
      effect: "allow",
      action: [
        "name/cos:PutObject",
        "name/cos:GetObject",
        "name/cos:HeadObject",
        "name/cos:DeleteObject",
        "name/cos:PutObjectTagging",
      ],
      resource: [
        "qcs::cos:<region>:uid/<appid>:<bucket>-<appid>/catalog-ingest/v1/*",
      ],
    });
    const l2 = plan.camStatement({ lifecycle: "L2" });
    expect(l2.statement[0]?.action).not.toContain("name/cos:PutObjectTagging");
    for (const statement of [l1, l2]) {
      const text = JSON.stringify(statement);
      for (const forbidden of [
        "List",
        "Multipart",
        "UploadPart",
        "Acl",
        "Bucket",
        "editorial",
        "ugc",
        "cos:*",
      ])
        expect(text).not.toContain(forbidden);
      for (const resource of statement.statement[0]?.resource ?? [])
        expect(resource.endsWith("/catalog-ingest/v1/*")).toBe(true);
    }
    expect(() => plan.camStatement({})).toThrow("LIFECYCLE_CHOICE_INVALID");
  });

  it("binds a validated target and refuses anything else", () => {
    const target = {
      region: "ap-synthetic",
      appId: "1000000001",
      bucket: "synthetic-bucket-1000000001",
    };
    expect(
      plan.camStatement({ lifecycle: "L2", target }).statement[0]?.resource,
    ).toEqual([
      "qcs::cos:ap-synthetic:uid/1000000001:synthetic-bucket-1000000001/catalog-ingest/v1/*",
    ]);
    for (const bad of [
      { ...target, bucket: "synthetic-bucket-1000000002" },
      { ...target, bucket: "synthetic-bucket-1000000001/editorial" },
      { ...target, region: "ap synthetic" },
      { ...target, appId: "*" },
      { ...target, extra: "x" },
      "synthetic",
    ])
      expect(() => plan.camStatement({ lifecycle: "L2", target: bad })).toThrow(
        "TARGET_INVALID",
      );
  });
});

describe("Catalog ingest staging lifecycle", () => {
  it("L1 adds one rule filtered by the staging prefix AND the staging tag", () => {
    const result = plan.planLifecycle({ current: {}, choice: "L1" });
    expect(result.configuration).toEqual({
      Rules: [
        {
          ID: plan.STAGING_RULE_ID,
          Status: "Enabled",
          Filter: {
            And: {
              Prefix: "catalog-ingest/v1/",
              Tags: [{ Key: tagKey, Value: tagValue }],
            },
          },
          Expiration: { Days: 1 },
        },
      ],
    });
    expect(result.report).toMatchObject({
      choice: "L1",
      existingRules: 0,
      added: [plan.STAGING_RULE_ID],
      unchanged: false,
    });
    expect(tagKey).toBe("moya-ingest-staging");
    expect(plan.STAGING_PREFIX.startsWith("editorial")).toBe(false);
  });

  it("keeps existing rules byte for byte and diffs only the added rule", () => {
    const current = { Rules: [abortRule, otherRule] };
    const before = JSON.stringify(current);
    const result = plan.planLifecycle({ current, choice: "L1" });
    expect(JSON.stringify(current)).toBe(before);
    const rules = result.configuration.Rules as Json[];
    expect(JSON.stringify(rules.slice(0, 2))).toBe(
      JSON.stringify(current.Rules),
    );
    expect(rules).toHaveLength(3);
    expect(result.report).toMatchObject({
      existingRules: 2,
      coveringUgc: ["synthetic-ugc-staging-abort"],
      coveringStaging: [],
    });
    expect(result.diff[0]).toMatch(/^@@ -\d+ \+\d+$/);
    expect(result.diff.slice(1).every((row) => row.startsWith("+ "))).toBe(
      true,
    );
    expect(result.diff.join("\n")).toContain(plan.STAGING_RULE_ID);
    expect(result.diff.join("\n")).not.toContain("logs/");
  });

  it("L2 changes nothing and still stops on a rule that could expire originals", () => {
    const current = { Rules: [abortRule] };
    const result = plan.planLifecycle({ current, choice: "L2" });
    expect(result.configuration).toBe(current);
    expect(result.report).toMatchObject({ added: [], unchanged: true });
    expect(result.diff).toEqual([]);
    expect(() =>
      plan.planLifecycle({
        current: { Rules: [{ ...otherRule, Filter: { Prefix: "" } }] },
        choice: "L2",
      }),
    ).toThrow("EXISTING_RULE_COVERS_ORIGINALS");
  });

  it("stops on an existing enabled rule that could expire editorial/ or display/ objects", () => {
    for (const filter of [
      {},
      { Prefix: "" },
      { Prefix: "edit" },
      { Prefix: "editorial/" },
      { Prefix: "editorial/abc/" },
      { Prefix: "display/" },
      { Tag: { Key: "synthetic", Value: "x" } },
      { And: { Tags: [{ Key: "synthetic", Value: "x" }] } },
      { ObjectSizeGreaterThan: 1 },
    ])
      expect(() =>
        plan.planLifecycle({
          current: { Rules: [{ ...otherRule, Filter: filter }] },
          choice: "L1",
        }),
      ).toThrow("EXISTING_RULE_COVERS_ORIGINALS");
    // A transition is as dangerous as an expiration.
    expect(() =>
      plan.planLifecycle({
        current: {
          Rules: [
            {
              ID: "synthetic-archive",
              Status: "Enabled",
              Filter: { Prefix: "" },
              Transitions: [{ Days: 30, StorageClass: "ARCHIVE" }],
            },
          ],
        },
        choice: "L1",
      }),
    ).toThrow("EXISTING_RULE_COVERS_ORIGINALS");
    // A disabled rule, or abort-only cleanup, deletes no original.
    expect(
      plan.planLifecycle({
        current: {
          Rules: [
            { ...otherRule, Status: "Disabled", Filter: { Prefix: "" } },
            { ...abortRule, Filter: { Prefix: "" } },
          ],
        },
        choice: "L1",
      }).report.added,
    ).toEqual([plan.STAGING_RULE_ID]);
  });

  it("refuses a rule without a Filter and an ID collision; an identical rule is unchanged", () => {
    const legacy = { ID: "legacy", Status: "Enabled", Prefix: "tmp/" };
    expect(() =>
      plan.planLifecycle({ current: { Rules: [legacy] }, choice: "L1" }),
    ).toThrow("EXISTING_RULE_WITHOUT_FILTER");
    expect(() =>
      plan.planLifecycle({
        current: {
          Rules: [{ ...plan.stagingRule(), Expiration: { Days: 2 } }],
        },
        choice: "L1",
      }),
    ).toThrow("RULE_ID_COLLISION");
    const again = plan.planLifecycle({
      current: { Rules: [plan.stagingRule()] },
      choice: "L1",
    });
    expect(again.report).toMatchObject({ added: [], unchanged: true });
    for (const current of [[], { Rules: {} }, { Rules: ["x"] }, null])
      expect(() => plan.planLifecycle({ current, choice: "L1" })).toThrow(
        "CURRENT_LIFECYCLE_INVALID",
      );
  });

  it("refuses any top-level key other than Rules, such as the XML/SDK Rule shape", () => {
    for (const choice of ["L1", "L2"])
      for (const current of [
        // Read as "no rules", this would skip every check and, merged, keep
        // a {Rule, Rules} pair an apply tool could drop the old rules from.
        { Rule: [{ ...otherRule, Filter: { Prefix: "" } }] },
        { Rule: [abortRule] },
        { Rules: [abortRule], Rule: [otherRule] },
      ])
        expect(() => plan.planLifecycle({ current, choice })).toThrow(
          "CURRENT_LIFECYCLE_INVALID",
        );
  });

  it("refuses a rule with both a rule-level Prefix and a Filter", () => {
    for (const choice of ["L1", "L2"])
      expect(() =>
        plan.planLifecycle({
          current: { Rules: [{ ...abortRule, Prefix: "" }] },
          choice,
        }),
      ).toThrow("EXISTING_RULE_FILTER_AMBIGUOUS");
  });

  it("checks the rule under the staging rule's ID like any other, under L1 and L2", () => {
    const wide = { ...plan.stagingRule(), Filter: { Prefix: "" } };
    for (const choice of ["L1", "L2"]) {
      expect(() =>
        plan.planLifecycle({ current: { Rules: [wide] }, choice }),
      ).toThrow("EXISTING_RULE_COVERS_ORIGINALS");
      expect(() =>
        plan.planLifecycle({
          current: {
            Rules: [{ ...plan.stagingRule(), Expiration: { Days: 2 } }],
          },
          choice,
        }),
      ).toThrow("RULE_ID_COLLISION");
      expect(() =>
        plan.planLifecycle({
          current: { Rules: [plan.stagingRule(), plan.stagingRule()] },
          choice,
        }),
      ).toThrow("RULE_ID_COLLISION");
      const same = plan.planLifecycle({
        current: { Rules: [abortRule, plan.stagingRule()] },
        choice,
      });
      expect(same.report).toMatchObject({
        added: [],
        unchanged: true,
        coveringStaging: [plan.STAGING_RULE_ID],
      });
      expect(same.diff).toEqual([]);
    }
  });

  it("treats a read-back of the staging rule in another key order as the same rule", () => {
    const readBack = {
      Expiration: { Days: 1 },
      ID: plan.STAGING_RULE_ID,
      Filter: {
        And: {
          Tags: [{ Value: tagValue, Key: tagKey }],
          Prefix: "catalog-ingest/v1/",
        },
      },
      Status: "Enabled",
    };
    const result = plan.planLifecycle({
      current: { Rules: [readBack] },
      choice: "L1",
    });
    expect(result.report).toMatchObject({ added: [], unchanged: true });
    expect(result.diff).toEqual([]);
  });

  it("counts a rule that is not plainly Disabled, or has an unknown action, as deleting", () => {
    const { Status, ...statusless } = otherRule;
    void Status;
    for (const rule of [
      { ...otherRule, Status: "enabled", Filter: { Prefix: "" } },
      { ...statusless, Filter: { Prefix: "" } },
      {
        ID: "synthetic-future-action",
        Status: "Enabled",
        Filter: { Prefix: "" },
        SyntheticFutureAction: { Days: 1 },
      },
    ])
      for (const choice of ["L1", "L2"])
        expect(() =>
          plan.planLifecycle({ current: { Rules: [rule] }, choice }),
        ).toThrow("EXISTING_RULE_COVERS_ORIGINALS");
  });

  it("never generates a rule that could match a protected or empty prefix", () => {
    const rule = plan.stagingRule();
    expect(plan.assertGeneratedRule(rule)).toBe(rule);
    const withPrefix = (prefix: string) => ({
      ...rule,
      Filter: {
        And: { Prefix: prefix, Tags: [{ Key: tagKey, Value: tagValue }] },
      },
    });
    expect(() => plan.assertGeneratedRule(withPrefix(""))).toThrow(
      "RULE_PREFIX_EMPTY",
    );
    for (const prefix of [
      "editorial/",
      "editorial/x/",
      "e",
      "display/",
      "ugc/",
      "ugc/publishing/",
      "u",
    ])
      expect(() => plan.assertGeneratedRule(withPrefix(prefix))).toThrow(
        "RULE_MATCHES_PROTECTED_PREFIX",
      );
    expect(() =>
      plan.assertGeneratedRule(withPrefix("catalog-ingest/")),
    ).toThrow("RULE_FILTER_NOT_STAGING");
    const { Filter, ...filterless } = rule;
    void Filter;
    expect(() => plan.assertGeneratedRule(filterless)).toThrow(
      "RULE_WITHOUT_FILTER",
    );
    expect(() =>
      plan.assertGeneratedRule({
        ...rule,
        Filter: { Prefix: "catalog-ingest/v1/" },
      }),
    ).toThrow("RULE_FILTER_NOT_STAGING");
    expect(() =>
      plan.assertGeneratedRule({ ...rule, Expiration: { Days: 30 } }),
    ).toThrow("RULE_ACTION_INVALID");
    expect(() =>
      plan.assertGeneratedRule({
        ...rule,
        Transitions: [{ Days: 1, StorageClass: "ARCHIVE" }],
      }),
    ).toThrow("RULE_ACTION_INVALID");
  });
});

describe("Catalog ingest dry-run probes", () => {
  it("lists exactly the probes the Admin's runner makes, then the Owner's checks", () => {
    for (const lifecycle of ["L1", "L2"] as const) {
      const listed = plan.probeChecklist({ lifecycle });
      expect(
        listed.filter(({ by }) => by === "runner").map(({ id }) => id),
      ).toEqual(ingestProbeIds(lifecycle));
      expect(
        listed.filter(({ by }) => by === "owner").map(({ id }) => id),
      ).toEqual([...INGEST_OWNER_CHECKS[lifecycle]]);
      expect(new Set(listed.map(({ id }) => id)).size).toBe(listed.length);
      // Probes stay on synthetic staging objects.
      expect(JSON.stringify(listed)).not.toContain("editorial/");
    }
    const l1 = plan.probeChecklist({ lifecycle: "L1" });
    const gate = (id: string) => l1.find((item) => item.id === id)?.gate;
    // One row per unsigned header: ACL by grant, tagging, encryption,
    // storage class and user metadata, in both spellings, and sub-resources.
    for (const id of [
      "unsigned-x-cos-acl",
      "unsigned-x-amz-acl",
      "unsigned-x-cos-grant-read",
      "unsigned-x-cos-grant-full-control",
      "unsigned-x-amz-grant-read",
      "unsigned-x-amz-grant-full-control",
      "unsigned-x-cos-tagging",
      "unsigned-x-amz-tagging",
      "unsigned-x-cos-sse",
      "unsigned-x-cos-sse-kms",
      "unsigned-x-cos-sse-c",
      "unsigned-x-amz-sse-c",
      "unsigned-x-cos-storage-class",
      "unsigned-x-cos-meta",
      "query-acl",
      "query-tagging",
      "query-uploads",
      "anonymous-get",
      "anonymous-get-copy",
    ])
      expect(gate(id), id).toBe("always");
    // MD5/ETag mode (D9) needs the PUT ETag to be the MD5 and the copy to
    // keep it; L1 needs the tag count on HEAD and a tag-stripping copy.
    expect(gate("put-etag-md5")).toBe("md5-mode");
    expect(gate("copy-keeps-etag")).toBe("md5-mode");
    expect(gate("head-tag-count")).toBe("l1");
    expect(gate("copy-strips-tags")).toBe("l1");
    const l2 = plan.probeChecklist({ lifecycle: "L2" }).map(({ id }) => id);
    for (const id of [
      "signed-tagging",
      "head-tag-count",
      "copy-strips-tags",
      "lifecycle-and-filter",
    ])
      expect(l2).not.toContain(id);
  });

  it("probe the URL, copy and HEAD exactly as the Admin's ingest storage sends and reads them", async () => {
    const storage = createCosIngestStorage({
      endpoint: new URL("https://cos.admin.example.test"),
      uploadEndpoint: new URL("https://cos.upload.example.test"),
      region: "synthetic-region",
      bucket: SDK_BUCKET,
      accessKeyId: "synthetic-access-key",
      secretAccessKey: "synthetic-secret-key",
      stagingTag: true,
    });
    const hex = (value: string) =>
      createHash("sha256").update(value).digest("hex");
    const staging = stagingKeyFor(hex("synthetic-probe-ingest"));
    const signal = new AbortController().signal;
    const probes = plan.probeChecklist({ lifecycle: "L1" });
    const probe = (id: string) => probes.find((item) => item.id === id)!;

    // The signed staging PUT: every query parameter beyond the SigV4 ones.
    const { url } = await storage.signUpload(
      staging,
      {
        "content-length": "1024",
        "content-type": "image/jpeg",
        "x-cos-forbid-overwrite": "true",
        "content-md5": createHash("md5").update("x").digest("base64"),
        "x-cos-tagging": CATALOG_INGEST_STAGING_TAGGING,
      },
      new Date(),
    );
    const extra = [...new URL(url).searchParams].filter(
      ([name]) => !name.startsWith("X-Amz-"),
    );
    expect(extra.length).toBeGreaterThan(0);
    for (const [name, value] of extra)
      expect(probe("signed-put").request).toContain(`${name}=${value}`);

    // The tag count the L1 positive control reads on HEAD.
    sdk.headers = { "x-cos-tagging-count": "1" };
    await expect(storage.head(staging, signal)).resolves.toMatchObject({
      tagCount: 1,
    });
    sdk.headers = {};
    await expect(storage.head(staging, signal)).resolves.toMatchObject({
      tagCount: 0,
    });
    expect(probe("head-tag-count").expect).toContain("x-cos-tagging-count");
    expect(probe("head-tag-count").expect).toContain(
      "INGEST_CONFIGURATION_INVALID",
    );

    // What HEAD shows that a signed PUT never sets, as complete refuses it.
    const attributes = async (headers: Record<string, string>) => {
      sdk.headers = headers;
      const object = await storage.head(staging, signal);
      sdk.headers = {};
      return [object?.contentType, object?.extraAttributes];
    };
    expect(await attributes({ "content-type": "image/jpeg" })).toEqual([
      "image/jpeg",
      false,
    ]);
    expect(await attributes({})).toEqual(["", false]);
    for (const harmless of [
      { "x-cos-storage-class": "STANDARD" },
      { "x-cos-server-side-encryption": "AES256" },
      { "x-cos-hash-crc64ecma": "42" },
      { "x-cos-request-id": "synthetic" },
    ])
      expect(await attributes(harmless), JSON.stringify(harmless)).toEqual([
        "",
        false,
      ]);
    for (const shown of [
      { "content-encoding": "gzip" },
      { "content-disposition": "attachment" },
      { "content-language": "en" },
      { "cache-control": "public" },
      { expires: "Thu, 01 Jan 2099 00:00:00 GMT" },
      { "x-cos-meta-probe": "1" },
      { "x-amz-meta-probe": "1" },
      { "x-cos-storage-class": "ARCHIVE" },
      { "x-amz-storage-class": "GLACIER" },
      { "x-cos-server-side-encryption": "cos/kms" },
      { "x-amz-server-side-encryption": "aws:kms" },
      { "x-cos-server-side-encryption-customer-algorithm": "AES256" },
    ])
      expect(await attributes(shown), JSON.stringify(shown)).toEqual([
        "",
        true,
      ]);

    // The copy: these headers and values, and no other COS or S3 one.
    sdk.sent.length = 0;
    await expect(
      storage.copy(
        staging,
        `editorial/${hex("catalog")}/${hex("media")}-${hex("bytes")}.jpg`,
        {
          bytes: 1024,
          etag: '"synthetic"',
          crc64: null,
          tagCount: 1,
          contentType: "image/jpeg",
          extraAttributes: false,
        },
        signal,
      ),
    ).resolves.toBe("copied");
    const copy = sdk.sent.find((request) => request.method === "PUT")!;
    const sent = Object.fromEntries(
      Object.entries(copy.headers).filter(
        ([name]) =>
          /^x-(?:amz|cos)-/.test(name) &&
          // The signature's own and the SDK's telemetry.
          !["x-amz-date", "x-amz-content-sha256", "x-amz-user-agent"].includes(
            name,
          ),
      ),
    );
    expect(sent).toEqual({
      "x-amz-copy-source": `${SDK_BUCKET}/${staging}`,
      "x-amz-copy-source-if-match": '"synthetic"',
      "x-amz-metadata-directive": "COPY",
      "x-amz-tagging-directive": "REPLACE",
      "x-cos-forbid-overwrite": "true",
    });
    for (const name of Object.keys(sent))
      expect(probe("copy-if-match-wrong").request).toContain(name);
    expect(probe("copy-if-match-wrong").request).toContain(
      "x-amz-copy-source <bucket>/<key> with x-amz-copy-source-if-match",
    );
    // COPY keeps the staging metadata: unsigned standard headers are probed.
    for (const name of [
      "content-encoding",
      "content-disposition",
      "cache-control",
      "content-language",
      "expires",
    ])
      expect(probe(`unsigned-${name}`).expect).toContain(
        "INGEST_STAGING_INVALID",
      );
  });
});

describe("catalog-ingest-bucket-plan CLI", () => {
  async function workspace() {
    const directory = await mkdtemp(join(tmpdir(), "ingest-bucket-plan-"));
    directories.push(directory);
    return directory;
  }

  it("writes real values only to a new private file and prints digests", async () => {
    const directory = await workspace();
    const targetFile = join(directory, "target.json");
    await writeFile(
      targetFile,
      JSON.stringify({
        region: "ap-synthetic",
        appId: "1000000001",
        bucket: "synthetic-bucket-1000000001",
      }),
      { mode: 0o600 },
    );
    const out = join(directory, "cam.json");
    const printed = await plan.runPlan([
      "cam",
      "--lifecycle",
      "L1",
      "--target",
      targetFile,
      "--out",
      out,
    ]);
    const written = await readFile(out, "utf8");
    expect(printed).toMatchObject({
      written: true,
      sha256: createHash("sha256").update(written).digest("hex"),
      resourcePrefix: "catalog-ingest/v1/*",
    });
    expect(JSON.stringify(printed)).not.toContain("synthetic-bucket");
    expect(JSON.stringify(printed)).not.toContain("1000000001");
    expect(written).toContain(
      "synthetic-bucket-1000000001/catalog-ingest/v1/*",
    );
    expect((await stat(out)).mode & 0o077).toBe(0);
    await expect(
      plan.runPlan([
        "cam",
        "--lifecycle",
        "L1",
        "--target",
        targetFile,
        "--out",
        out,
      ]),
    ).rejects.toThrow("OUTPUT_EXISTS_OR_UNWRITABLE");
    await expect(
      plan.runPlan(["cam", "--lifecycle", "L1", "--target", targetFile]),
    ).rejects.toThrow("ARGUMENTS_INVALID");
    // The target names the bucket and appId: a readable file is refused.
    await chmod(targetFile, 0o644);
    const refusedOut = join(directory, "cam-refused.json");
    await expect(
      plan.runPlan([
        "cam",
        "--lifecycle",
        "L1",
        "--target",
        targetFile,
        "--out",
        refusedOut,
      ]),
    ).rejects.toThrow("LOCAL_FILE_INVALID");
    await expect(stat(refusedOut)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("merges a captured lifecycle into a new file and leaves L2 unwritten", async () => {
    const directory = await workspace();
    const currentFile = join(directory, "current.json");
    const current = { Rules: [abortRule, otherRule] };
    await writeFile(currentFile, JSON.stringify(current), { mode: 0o600 });
    const out = join(directory, "lifecycle.json");
    const printed = await plan.runPlan([
      "lifecycle",
      "--lifecycle",
      "L1",
      "--current",
      currentFile,
      "--out",
      out,
    ]);
    expect(printed).toMatchObject({
      choice: "L1",
      added: [plan.STAGING_RULE_ID],
      written: true,
    });
    const merged = JSON.parse(await readFile(out, "utf8")) as { Rules: Json[] };
    expect(JSON.stringify(merged.Rules.slice(0, 2))).toBe(
      JSON.stringify(current.Rules),
    );
    const l2Out = join(directory, "l2.json");
    expect(
      await plan.runPlan([
        "lifecycle",
        "--lifecycle",
        "L2",
        "--current",
        currentFile,
        "--out",
        l2Out,
      ]),
    ).toMatchObject({ unchanged: true, written: false });
    await expect(stat(l2Out)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      plan.runPlan(["lifecycle", "--lifecycle", "L1"]),
    ).rejects.toThrow("ARGUMENTS_INVALID");
    await chmod(currentFile, 0o644);
    await expect(
      plan.runPlan([
        "lifecycle",
        "--lifecycle",
        "L2",
        "--current",
        currentFile,
      ]),
    ).rejects.toThrow("LOCAL_FILE_INVALID");
    await expect(plan.runPlan(["cors"])).rejects.toThrow("COMMAND_INVALID");
  });

  it("is a no-network module", async () => {
    const source = await readFile(SCRIPT, "utf8");
    for (const forbidden of [
      "node:http",
      "node:https",
      "node:net",
      "node:dns",
      "fetch(",
      "child_process",
    ])
      expect(source).not.toContain(forbidden);
  });
});
