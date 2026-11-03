import { randomBytes, randomUUID } from "node:crypto";

import { sql, type PostgresAdapter } from "@payloadcms/db-postgres";
import {
  createLocalReq,
  Forbidden,
  getPayload,
  handleEndpoints,
  NotFound,
  ValidationError,
  type Payload,
  type SanitizedConfig,
  type TypedUser,
} from "payload";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  approveBatch,
  prepareCatalogDelivery,
  publishApproved,
  readCatalogDelivery,
  readDraft,
  restoreDraft,
  saveDraft,
} from "admin/editorial";
import {
  approveArticleBatch,
  publishApprovedArticle,
  saveArticleDraft,
} from "admin/editorial-content";
import { selectedMediaSnapshot } from "admin/media-snapshot";

import {
  connectClient,
  serveRoutes,
  syntheticCatalogDraft,
} from "./admin-mcp-wire.js";

// Behavior Matrix rows "Failed COMMIT", "Lost answer or timeout", "Document open by
// the Owner", "Approval duplicate, bulk edit of accounts or keys" and "Automation
// key", and the hardening list in section 10 of
// docs/development/admin-mcp-completion-v1.md. Protocol answers go over real
// JSON-RPC with the official client, and REST over a real socket.

if (process.env.CMS_ENVIRONMENT !== "synthetic")
  throw new Error("SYNTHETIC_CMS_TARGET_REQUIRED");

const run = randomUUID();
const password = randomBytes(24).toString("hex");
const SCOPE_NAMES = [
  "commit",
  "commit-wire",
  "commit-rest",
  "commit-approve",
  "status-lost",
  "busy",
  "lock-failure",
  "preparation",
  "readiness",
  "read-failure",
  "delivery-read",
  "receipt-write",
  "read-missing",
  "durable",
  "locked",
  "unclassified",
  "already",
  "superseded",
  "superseded-media",
  "no-approval",
  "duplicate",
  "fields",
];
const catalogId = (name: string) => `hardening-${name}-${run}`;
const draftFor = (name: string) =>
  syntheticCatalogDraft(catalogId(name), `source-${name}-${run}`);
const articleDraft = (title: string) => ({
  presentation: "news" as const,
  title,
  summary: `${title} 摘要`,
  section: "田野观察",
  byline: "由艺编辑室",
  sections: [{ body: "第一段。" }],
  citations: [],
});

let config: SanitizedConfig;
let payload: Payload;
let server: Awaited<ReturnType<typeof serveRoutes>>;
let owner: TypedUser;
let automation: TypedUser;
let automationSecret: string;
let automationKeyId: number;
let ownerToken: string;
let automationToken: string;

const adapter = () => payload.db as unknown as PostgresAdapter;
const reqFor = (user: TypedUser) => createLocalReq({ user }, payload);
const rowsOf = async (query: ReturnType<typeof sql>) =>
  (await adapter().drizzle.execute(query)).rows;
const receiptsOfCatalog = (id: number) =>
  rowsOf(
    sql`SELECT status, error_code FROM editorial_receipts WHERE catalog_id = ${id}`,
  );
const catalogRows = (name: string) =>
  rowsOf(sql`SELECT id FROM catalogs WHERE catalog_id = ${catalogId(name)}`);
const receiptCount = async () =>
  Number(
    (await rowsOf(sql`SELECT count(*) AS total FROM editorial_receipts`))[0]!
      .total,
  );

const replyOf = (result: unknown) =>
  JSON.parse(
    (result as { content: { text: string }[] }).content[0]!.text,
  ) as Record<string, unknown>;

const withClient = async <T>(
  work: (
    call: (
      name: string,
      args: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>,
  ) => Promise<T>,
): Promise<T> => {
  const { client } = await connectClient(server.endpoint, {
    authorization: ["Bearer", automationSecret].join(" "),
  });
  try {
    return await work(async (name, args) =>
      replyOf(await client.callTool({ name, arguments: args })),
    );
  } finally {
    await client.close();
  }
};

const restPost = (
  route: string,
  body: unknown,
  headers: Record<string, string>,
) =>
  fetch(new URL(`/api/${route}`, server.origin), {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const jwtHeader = (token: string) => ({
  authorization: ["JWT", token].join(" "),
});

/**
 * A real failed COMMIT: PostgreSQL runs a deferred constraint trigger at COMMIT,
 * answers with the error and rolls the transaction back. It trips only a transaction
 * that wrote to that table, and the suite runs one file at a time.
 */
const withCommitFailure = async <T>(
  work: () => Promise<T>,
  table = "editorial_receipts",
): Promise<T> => {
  const db = adapter().drizzle;
  const target = sql.identifier(table);
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION hardening_refuse_commit() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic commit failure'; END $$`);
  await db.execute(sql`
    CREATE CONSTRAINT TRIGGER hardening_refuse_commit
    AFTER INSERT OR UPDATE ON ${target}
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION hardening_refuse_commit()`);
  try {
    return await work();
  } finally {
    await db.execute(sql`DROP TRIGGER hardening_refuse_commit ON ${target}`);
    await db.execute(sql`DROP FUNCTION hardening_refuse_commit()`);
  }
};

/** One failure of one Local API method on one collection; the key door reads keys. */
const failingOnce = (
  method: "find" | "update",
  collection: string,
  failure: () => Error,
) => {
  const real = payload[method].bind(payload) as (options: never) => unknown;
  let spent = false;
  return vi.spyOn(payload, method).mockImplementation(((options: never) => {
    if ((options as { collection: string }).collection !== collection || spent)
      return real(options);
    spent = true;
    return Promise.reject(failure());
  }) as never);
};

/** Holds one editorial lock on a connection of its own, as a concurrent write would. */
const holdingLock = async <T>(key: string, work: () => Promise<T>) => {
  const client = await adapter().pool.connect();
  const lock = `moya-editorial:${key}`;
  try {
    await client.query(
      "SELECT pg_advisory_lock(hashtextextended($1::text, 0))",
      [lock],
    );
    return await work();
  } finally {
    await client.query(
      "SELECT pg_advisory_unlock(hashtextextended($1::text, 0))",
      [lock],
    );
    client.release();
  }
};

const syntheticPng = () =>
  sharp({
    create: { width: 3, height: 2, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();

/** A saved draft holding one registered editorial original. */
const draftWithMedia = async (name: string) => {
  const bytes = await syntheticPng();
  const media = await payload.create({
    collection: "media",
    req: await reqFor(owner),
    overrideAccess: false,
    data: {
      mediaId: `hardening-media-${name}-${run}`,
      catalogId: catalogId(name),
      origin: "upload",
      objectKey: "",
      sha256: "",
      alt: "Synthetic original",
      rights: "Synthetic fixture",
      orderConfidence: "HIGH",
    },
    file: {
      name: "synthetic.png",
      data: bytes,
      mimetype: "image/png",
      size: bytes.length,
    },
  });
  return saveDraft(await reqFor(automation), {
    idempotencyKey: `${run}:${name}:create`,
    content: {
      ...draftFor(name),
      media: [selectedMediaSnapshot({ ...media }, catalogId(name), [])!],
    },
  });
};

beforeAll(async () => {
  vi.stubEnv("COMMUNITY_OPERATOR_BASE_URL", "");
  vi.stubEnv("COMMUNITY_OPERATOR_TOKEN", "");
  config = await (await import("admin/config")).default;
  payload = await getPayload({ config });
  const emailOf = (name: string) => `hardening-${name}-${run}@example.invalid`;
  const account = (
    name: string,
    role: "owner" | "automation",
    scopeCatalogIds: string[],
  ) =>
    payload.create({
      collection: "users",
      overrideAccess: true,
      data: {
        email: emailOf(name),
        password,
        role,
        scopeCatalogIds,
      },
    });
  owner = await account("owner", "owner", []);
  automation = await account(
    "automation",
    "automation",
    SCOPE_NAMES.map(catalogId),
  );
  automationSecret = randomBytes(32).toString("hex");
  automationKeyId = (
    await payload.create({
      collection: "payload-mcp-api-keys",
      overrideAccess: true,
      data: {
        user: automation.id,
        label: "synthetic-hardening",
        enableAPIKey: true,
        apiKey: automationSecret,
        "payload-mcp-tool": {
          editorialQuery: true,
          editorialRead: true,
          editorialSaveDraft: true,
          editorialPublishApproved: true,
          editorialBatchResults: true,
        },
      } as never,
    })
  ).id;
  const login = async (name: string) => {
    const answer = await handleEndpoints({
      config,
      request: new Request("http://localhost/api/users/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: emailOf(name), password }),
      }),
    });
    return ((await answer.json()) as { token: string }).token;
  };
  ownerToken = await login("owner");
  automationToken = await login("automation");
  server = await serveRoutes(config);
}, 60_000);

afterAll(async () => {
  await server?.close();
  await payload?.destroy();
  vi.unstubAllEnvs();
});

describe.sequential("commit truth in withEditorialTransaction", () => {
  it("answers OUTCOME_UNKNOWN to a failed COMMIT, keeps nothing, and lets the same key succeed", async () => {
    const command = {
      idempotencyKey: `${run}:commit`,
      content: draftFor("commit"),
    };
    await withCommitFailure(async () => {
      await expect(
        saveDraft(await reqFor(automation), command),
      ).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN", status: 503 });
    });
    expect(await catalogRows("commit")).toEqual([]);
    const saved = await saveDraft(await reqFor(automation), command);
    expect(saved.replayed).toBe(false);
    expect(await receiptsOfCatalog(saved.id)).toEqual([
      { status: "completed", error_code: null },
    ]);
  });

  it("answers OUTCOME_UNKNOWN when the status read fails, and the same key then replays what did commit", async () => {
    const command = {
      idempotencyKey: `${run}:status-lost`,
      content: draftFor("status-lost"),
    };
    const statusRead = vi
      .spyOn(adapter().drizzle, "execute")
      .mockRejectedValueOnce(new Error("synthetic lost connection"));
    try {
      await expect(
        saveDraft(await reqFor(automation), command),
      ).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    } finally {
      statusRead.mockRestore();
    }
    const [row] = await catalogRows("status-lost");
    expect(row).toBeDefined();
    expect(await saveDraft(await reqFor(automation), command)).toMatchObject({
      id: Number(row!.id),
      replayed: true,
    });
  });

  it("says so over JSON-RPC, with no success and no rejection, and audits it", async () => {
    await withClient(async (call) => {
      const args = {
        idempotencyKey: `${run}:commit-wire`,
        content: draftFor("commit-wire"),
      };
      const failed = await withCommitFailure(() =>
        call("editorial_save_draft", args),
      );
      expect(failed).toEqual({ ok: false, code: "OUTCOME_UNKNOWN" });
      expect(await catalogRows("commit-wire")).toEqual([]);
      const [finish] = await rowsOf(
        sql`SELECT ok, code FROM mcp_audit_events
            WHERE key_id = ${automationKeyId} AND phase = 'finish'
            ORDER BY id DESC LIMIT 1`,
      );
      expect(finish).toEqual({ ok: false, code: "OUTCOME_UNKNOWN" });
      expect(await call("editorial_save_draft", args)).toMatchObject({
        revision: 1,
        replayed: false,
      });
    });
  });

  it("answers OUTCOME_UNKNOWN on the approvals and the restore, which had Payload's own commit", async () => {
    const saved = await saveDraft(await reqFor(automation), {
      idempotencyKey: `${run}:commit-approve:create`,
      content: draftFor("commit-approve"),
    });
    const article = await saveArticleDraft(await reqFor(automation), {
      idempotencyKey: `${run}:commit-approve:article`,
      content: articleDraft(`提交 ${run}`),
    });
    await withCommitFailure(async () => {
      await expect(
        approveBatch(await reqFor(owner), {
          automationUserId: automation.id,
          items: [{ id: saved.id, revision: saved.revision }],
        }),
      ).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    }, "editorial_approvals");
    await withCommitFailure(async () => {
      await expect(
        approveArticleBatch(await reqFor(owner), {
          automationUserId: automation.id,
          items: [{ id: article.id, revision: article.revision }],
        }),
      ).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    }, "editorial_article_approvals");
    const edited = await saveDraft(await reqFor(automation), {
      id: saved.id,
      expectedRevision: saved.revision,
      idempotencyKey: `${run}:commit-approve:edit`,
      content: { ...draftFor("commit-approve"), title: "Second revision" },
    });
    const { docs } = await payload.findVersions({
      collection: "catalogs",
      where: { parent: { equals: saved.id } },
      sort: "createdAt",
      limit: 1,
      overrideAccess: true,
    });
    const restore = {
      versionId: docs[0]!.id,
      expectedRevision: edited.revision,
    };
    await withCommitFailure(async () => {
      await expect(
        restoreDraft(await reqFor(owner), restore),
      ).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    }, "_catalogs_v");
    expect(await restoreDraft(await reqFor(owner), restore)).toMatchObject({
      id: saved.id,
      revision: edited.revision + 1,
    });
  });

  it("answers 503 OUTCOME_UNKNOWN over REST, which the batch client retries", async () => {
    const body = {
      idempotencyKey: `${run}:commit-rest`,
      content: draftFor("commit-rest"),
    };
    const failed = await withCommitFailure(() =>
      restPost("editorial/save-draft", body, jwtHeader(automationToken)),
    );
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({
      ok: false,
      error: { code: "OUTCOME_UNKNOWN", fields: [] },
    });
    const retried = await restPost(
      "editorial/save-draft",
      body,
      jwtHeader(automationToken),
    );
    expect(retried.status).toBe(200);
  });
});

describe.sequential("failures a retry can get past write no receipt", () => {
  it("lets the same key succeed after a busy lock on a Catalog", async () => {
    const created = await saveDraft(await reqFor(automation), {
      idempotencyKey: `${run}:busy:create`,
      content: draftFor("busy"),
    });
    const command = {
      id: created.id,
      expectedRevision: created.revision,
      idempotencyKey: `${run}:busy:edit`,
      content: { ...draftFor("busy"), title: "Edited after a busy lock" },
    };
    const before = await receiptCount();
    await holdingLock(`document:${created.id}`, async () => {
      await expect(
        saveDraft(await reqFor(automation), command),
      ).rejects.toMatchObject({ code: "CONCURRENT_OPERATION_BUSY" });
    });
    expect(await receiptCount()).toBe(before);
    const retried = await saveDraft(await reqFor(automation), command);
    expect(retried).toMatchObject({
      revision: created.revision + 1,
      replayed: false,
    });
  });

  it("lets the same key succeed after a busy lock on an Article", async () => {
    const created = await saveArticleDraft(await reqFor(automation), {
      idempotencyKey: `${run}:busy-article:create`,
      content: articleDraft(`忙碌 ${run}`),
    });
    const command = {
      id: created.id,
      expectedRevision: created.revision,
      idempotencyKey: `${run}:busy-article:edit`,
      content: { ...articleDraft(`忙碌 ${run}`), summary: "忙碌之后的摘要" },
    };
    const before = await receiptCount();
    await holdingLock(`document:${created.id}`, async () => {
      await expect(
        saveArticleDraft(await reqFor(automation), command),
      ).rejects.toMatchObject({ code: "CONCURRENT_OPERATION_BUSY" });
    });
    expect(await receiptCount()).toBe(before);
    expect(
      await saveArticleDraft(await reqFor(automation), command),
    ).toMatchObject({ revision: created.revision + 1, replayed: false });
  });

  it("does not call another lock failure busy", async () => {
    const created = await saveDraft(await reqFor(automation), {
      idempotencyKey: `${run}:lock-failure:create`,
      content: draftFor("lock-failure"),
    });
    const command = {
      id: created.id,
      expectedRevision: created.revision,
      idempotencyKey: `${run}:lock-failure:edit`,
      content: { ...draftFor("lock-failure"), title: "After a lost lock" },
    };
    const begin = adapter().beginTransaction.bind(adapter());
    const spy = vi
      .spyOn(adapter(), "beginTransaction")
      .mockImplementationOnce(async () => {
        const id = await begin();
        const { db } = adapter().sessions[String(id)]!;
        const execute = db.execute.bind(db);
        let statements = 0;
        vi.spyOn(db, "execute").mockImplementation(((query: never) => {
          // The xid read, then the lock's SET LOCAL.
          statements += 1;
          if (statements === 2)
            throw Object.assign(new Error("Failed query"), {
              cause: { code: "08006" },
            });
          return execute(query);
        }) as never);
        return id;
      });
    try {
      const failure = await saveDraft(await reqFor(automation), command).catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe("Failed query");
    } finally {
      spy.mockRestore();
    }
    expect(await saveDraft(await reqFor(automation), command)).toMatchObject({
      replayed: false,
    });
  });

  it("lets the same key publish once the images are ready, after CATALOG_DELIVERY_PREPARATION_REQUIRED", async () => {
    const draft = await draftWithMedia("preparation");
    const { approvalId } = await approveBatch(await reqFor(owner), {
      automationUserId: automation.id,
      items: [{ id: draft.id, revision: draft.revision }],
    });
    const command = {
      approvalId,
      id: draft.id,
      idempotencyKey: `${run}:preparation:publish`,
    };
    const before = await receiptCount();
    await expect(
      publishApproved(await reqFor(automation), command),
    ).rejects.toMatchObject({ code: "CATALOG_DELIVERY_PREPARATION_REQUIRED" });
    expect(await receiptCount()).toBe(before);
    vi.stubEnv("CMS_CATALOG_DIRECT_PUBLISH", "on");
    try {
      expect(
        await publishApproved(await reqFor(automation), command),
      ).toMatchObject({ id: draft.id, replayed: false });
    } finally {
      vi.stubEnv("CMS_CATALOG_DIRECT_PUBLISH", "");
    }
  });

  it("writes no receipt for a server failure either, here a readiness proof nobody could read", async () => {
    const draft = await draftWithMedia("readiness");
    const { approvalId } = await approveBatch(await reqFor(owner), {
      automationUserId: automation.id,
      items: [{ id: draft.id, revision: draft.revision }],
    });
    const command = {
      approvalId,
      id: draft.id,
      idempotencyKey: `${run}:readiness:publish`,
    };
    // A loopback port nothing listens on: the operator call fails, it is not absent.
    vi.stubEnv("COMMUNITY_OPERATOR_BASE_URL", "http://127.0.0.1:9");
    vi.stubEnv("COMMUNITY_OPERATOR_TOKEN", randomUUID());
    const before = await receiptCount();
    try {
      await expect(
        publishApproved(await reqFor(automation), command),
      ).rejects.toMatchObject({
        code: "CATALOG_DELIVERY_READINESS_UNAVAILABLE",
        status: 503,
      });
    } finally {
      vi.stubEnv("COMMUNITY_OPERATOR_BASE_URL", "");
      vi.stubEnv("COMMUNITY_OPERATOR_TOKEN", "");
    }
    expect(await receiptCount()).toBe(before);
    vi.stubEnv("CMS_CATALOG_DIRECT_PUBLISH", "on");
    try {
      expect(
        await publishApproved(await reqFor(automation), command),
      ).toMatchObject({ id: draft.id, replayed: false });
    } finally {
      vi.stubEnv("CMS_CATALOG_DIRECT_PUBLISH", "");
    }
  });

  it("does not read a failed read as a missing record on an Article or a delivery prepare", async () => {
    const article = await saveArticleDraft(await reqFor(automation), {
      idempotencyKey: `${run}:read-failure-article:create`,
      content: articleDraft(`读取失败 ${run}`),
    });
    const { approvalId } = await approveArticleBatch(await reqFor(owner), {
      automationUserId: automation.id,
      items: [{ id: article.id, revision: article.revision }],
    });
    const command = {
      approvalId,
      id: article.id,
      idempotencyKey: `${run}:read-failure-article:publish`,
    };
    const draft = await saveDraft(await reqFor(automation), {
      idempotencyKey: `${run}:delivery-read:create`,
      content: draftFor("delivery-read"),
    });
    const findByID = payload.findByID.bind(payload);
    const read = vi
      .spyOn(payload, "findByID")
      .mockImplementation(((options: { collection: string }) =>
        ["articles", "catalogs"].includes(options.collection)
          ? Promise.reject(new Error("synthetic read failure"))
          : findByID(options as never)) as never);
    try {
      await expect(
        publishApprovedArticle(await reqFor(automation), command),
      ).rejects.toThrow("synthetic read failure");
      await expect(
        prepareCatalogDelivery(await reqFor(owner), {
          id: draft.id,
          expectedRevision: draft.revision,
          expectedFingerprint: draft.fingerprint,
          idempotencyKey: `${run}:delivery-read:prepare`,
        }),
      ).rejects.toThrow("synthetic read failure");
    } finally {
      read.mockRestore();
    }
    expect(
      await publishApprovedArticle(await reqFor(automation), command),
    ).toMatchObject({ id: article.id, replayed: false });
  });

  it("does not read a failed read as a missing record, and the same key succeeds", async () => {
    const saved = await saveDraft(await reqFor(automation), {
      idempotencyKey: `${run}:read-failure:create`,
      content: draftFor("read-failure"),
    });
    const { approvalId } = await approveBatch(await reqFor(owner), {
      automationUserId: automation.id,
      items: [{ id: saved.id, revision: saved.revision }],
    });
    const command = {
      approvalId,
      id: saved.id,
      idempotencyKey: `${run}:read-failure:publish`,
    };
    const findByID = payload.findByID.bind(payload);
    const read = vi.spyOn(payload, "findByID").mockImplementation(((options: {
      collection: string;
    }) => {
      if (options.collection === "catalogs")
        return Promise.reject(new Error("synthetic read failure"));
      return findByID(options as never);
    }) as never);
    const before = await receiptCount();
    try {
      await expect(
        publishApproved(await reqFor(automation), command),
      ).rejects.toThrow("synthetic read failure");
      await expect(
        readDraft(await reqFor(automation), { id: saved.id }),
      ).rejects.toThrow("synthetic read failure");
    } finally {
      read.mockRestore();
    }
    expect(await receiptCount()).toBe(before);
    expect(
      await publishApproved(await reqFor(automation), command),
    ).toMatchObject({ id: saved.id, replayed: false });
  });

  it("leaves a real miss as RECORD_UNAVAILABLE, also with no receipt", async () => {
    const saved = await saveDraft(await reqFor(automation), {
      idempotencyKey: `${run}:read-missing:create`,
      content: draftFor("read-missing"),
    });
    const { approvalId } = await approveBatch(await reqFor(owner), {
      automationUserId: automation.id,
      items: [{ id: saved.id, revision: saved.revision }],
    });
    const command = {
      approvalId,
      id: saved.id,
      idempotencyKey: `${run}:read-missing:publish`,
    };
    const findByID = payload.findByID.bind(payload);
    const read = vi.spyOn(payload, "findByID").mockImplementation(((options: {
      collection: string;
    }) => {
      if (options.collection === "catalogs")
        return Promise.reject(new NotFound());
      return findByID(options as never);
    }) as never);
    const before = await receiptCount();
    try {
      await expect(
        publishApproved(await reqFor(automation), command),
      ).rejects.toMatchObject({ code: "RECORD_UNAVAILABLE", status: 404 });
    } finally {
      read.mockRestore();
    }
    expect(await receiptCount()).toBe(before);
    expect(
      await publishApproved(await reqFor(automation), command),
    ).toMatchObject({ replayed: false });
  });
});

describe.sequential("a rejection that stands", () => {
  it("keeps its receipt, and a replay of it is marked on Local, REST and JSON-RPC", async () => {
    const created = await saveDraft(await reqFor(automation), {
      idempotencyKey: `${run}:durable:create`,
      content: draftFor("durable"),
    });
    const stale = {
      id: created.id,
      expectedRevision: created.revision + 5,
      idempotencyKey: `${run}:durable:stale`,
      content: { ...draftFor("durable"), title: "Stale edit" },
    };
    const first = (await saveDraft(await reqFor(automation), stale).catch(
      (error: unknown) => error,
    )) as { code: string; replayed?: boolean };
    expect(first.code).toBe("REVISION_CONFLICT");
    expect(first.replayed).toBeUndefined();
    const again = (await saveDraft(await reqFor(automation), stale).catch(
      (error: unknown) => error,
    )) as { code: string; replayed?: boolean };
    expect(again).toMatchObject({
      code: "REVISION_CONFLICT",
      replayed: true,
    });
    const rest = await restPost(
      "editorial/save-draft",
      stale,
      jwtHeader(automationToken),
    );
    expect(rest.status).toBe(409);
    expect(await rest.json()).toEqual({
      ok: false,
      error: { code: "REVISION_CONFLICT", fields: [], replayed: true },
    });
    await withClient(async (call) => {
      const fresh = {
        ...stale,
        idempotencyKey: `${run}:durable:wire`,
      };
      expect(await call("editorial_save_draft", fresh)).toEqual({
        ok: false,
        code: "REVISION_CONFLICT",
      });
      expect(await call("editorial_save_draft", fresh)).toEqual({
        ok: false,
        code: "REVISION_CONFLICT",
        replayed: true,
      });
    });
    // One receipt per key, however many times it was asked.
    expect(
      await rowsOf(
        sql`SELECT status, error_code FROM editorial_receipts
            WHERE error_code = 'REVISION_CONFLICT' AND actor_id = ${automation.id}`,
      ),
    ).toEqual([
      { status: "rejected", error_code: "REVISION_CONFLICT" },
      { status: "rejected", error_code: "REVISION_CONFLICT" },
    ]);
  });

  it("still answers the rejection when its own receipt could not be written", async () => {
    const created = await saveDraft(await reqFor(automation), {
      idempotencyKey: `${run}:receipt-write:create`,
      content: draftFor("receipt-write"),
    });
    const stale = {
      id: created.id,
      expectedRevision: created.revision + 5,
      idempotencyKey: `${run}:receipt-write:stale`,
      content: draftFor("receipt-write"),
    };
    await withCommitFailure(async () => {
      await expect(
        saveDraft(await reqFor(automation), stale),
      ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    });
    // No receipt landed, so this is a first answer and not a replay.
    const again = (await saveDraft(await reqFor(automation), stale).catch(
      (error: unknown) => error,
    )) as { code: string; replayed?: boolean };
    expect(again.code).toBe("REVISION_CONFLICT");
    expect(again.replayed).toBeUndefined();
  });

  it("marks a replayed Article failure too", async () => {
    const created = await saveArticleDraft(await reqFor(automation), {
      idempotencyKey: `${run}:durable-article:create`,
      content: articleDraft(`拒绝 ${run}`),
    });
    const stale = {
      id: created.id,
      expectedRevision: created.revision + 5,
      idempotencyKey: `${run}:durable-article:stale`,
      content: articleDraft(`拒绝 ${run}`),
    };
    await expect(
      saveArticleDraft(await reqFor(automation), stale),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await expect(
      saveArticleDraft(await reqFor(automation), stale),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT", replayed: true });
  });
});

describe.sequential("truthful codes on the plugin path", () => {
  const lockAsOwner = (documentId: number) =>
    payload.create({
      collection: "payload-locked-documents",
      overrideAccess: true,
      data: {
        document: { relationTo: "catalogs", value: documentId },
        user: { relationTo: "users", value: owner.id },
      } as never,
    });

  it("answers DOCUMENT_LOCKED while the Owner holds the document, writes no receipt, and the same key succeeds after", async () => {
    const created = await saveDraft(await reqFor(automation), {
      idempotencyKey: `${run}:locked:create`,
      content: draftFor("locked"),
    });
    const args = {
      id: created.id,
      expectedRevision: created.revision,
      idempotencyKey: `${run}:locked:edit`,
      content: { ...draftFor("locked"), title: "Edited after the lock" },
    };
    const lock = await lockAsOwner(created.id);
    const before = await receiptCount();
    await withClient(async (call) => {
      expect(await call("editorial_save_draft", args)).toEqual({
        ok: false,
        code: "DOCUMENT_LOCKED",
      });
      const rest = await restPost(
        "editorial/save-draft",
        args,
        jwtHeader(automationToken),
      );
      expect(rest.status).toBe(423);
      expect(await rest.json()).toEqual({
        ok: false,
        error: { code: "DOCUMENT_LOCKED", fields: [] },
      });
      expect(await receiptCount()).toBe(before);
      await payload.delete({
        collection: "payload-locked-documents",
        id: lock.id,
        overrideAccess: true,
      });
      expect(await call("editorial_save_draft", args)).toMatchObject({
        revision: created.revision + 1,
        replayed: false,
      });
    });
  });

  it("says the outcome is unknown for an unclassified failure, never REJECTED, on a read and on a write", async () => {
    const created = await saveDraft(await reqFor(automation), {
      idempotencyKey: `${run}:unclassified:create`,
      content: draftFor("unclassified"),
    });
    await withClient(async (call) => {
      const find = failingOnce(
        "find",
        "catalogs",
        () => new Error("synthetic failure"),
      );
      try {
        expect(await call("editorial_query", { page: 1 })).toEqual({
          ok: false,
          code: "OUTCOME_UNKNOWN",
        });
      } finally {
        find.mockRestore();
      }
      const args = {
        id: created.id,
        expectedRevision: created.revision,
        idempotencyKey: `${run}:unclassified:edit`,
        content: draftFor("unclassified"),
      };
      const update = failingOnce(
        "update",
        "catalogs",
        () => new Error("synthetic failure"),
      );
      try {
        expect(await call("editorial_save_draft", args)).toEqual({
          ok: false,
          code: "OUTCOME_UNKNOWN",
        });
      } finally {
        update.mockRestore();
      }
      const [finish] = await rowsOf(
        sql`SELECT ok, code FROM mcp_audit_events
            WHERE key_id = ${automationKeyId} AND phase = 'finish'
            ORDER BY id DESC LIMIT 1`,
      );
      expect(finish).toEqual({ ok: false, code: "OUTCOME_UNKNOWN" });
      // No receipt pinned it, so the same key still does the work.
      expect(await call("editorial_save_draft", args)).toMatchObject({
        replayed: false,
      });
    });
  });

  it.each([
    ["a missing record", () => new NotFound(), "RECORD_UNAVAILABLE"],
    ["an access refusal", () => new Forbidden(), "FORBIDDEN"],
    [
      "a field refusal",
      () =>
        new ValidationError({
          errors: [{ path: "title", message: "invalid" }],
        }),
      "CONTENT_INVALID",
    ],
  ])("names %s rather than calling it unknown", async (_label, error, code) => {
    await withClient(async (call) => {
      const find = failingOnce("find", "catalogs", error);
      try {
        expect(await call("editorial_query", { page: 1 })).toEqual({
          ok: false,
          code,
        });
      } finally {
        find.mockRestore();
      }
    });
  });

  it("answers RECORD_UNAVAILABLE for an approval that does not exist", async () => {
    const created = await saveDraft(await reqFor(automation), {
      idempotencyKey: `${run}:no-approval:create`,
      content: draftFor("no-approval"),
    });
    await withClient(async (call) => {
      expect(
        await call("editorial_publish_approved", {
          approvalId: 2_000_000_000,
          id: created.id,
          idempotencyKey: `${run}:no-approval`,
        }),
      ).toEqual({ ok: false, code: "RECORD_UNAVAILABLE" });
    });
  });
});

describe.sequential("receipts name their document", () => {
  it("replays an Article save and publish with its document id and public id", async () => {
    const save = {
      idempotencyKey: `${run}:article-replay:save`,
      content: articleDraft(`回放 ${run}`),
    };
    const saved = await saveArticleDraft(await reqFor(automation), save);
    expect(saved.id).toBeGreaterThan(0);
    expect(saved.articleId).toMatch(/^article-/u);
    expect(await saveArticleDraft(await reqFor(automation), save)).toEqual({
      ...saved,
      replayed: true,
    });
    const { approvalId } = await approveArticleBatch(await reqFor(owner), {
      automationUserId: automation.id,
      items: [{ id: saved.id, revision: saved.revision }],
    });
    const publish = {
      approvalId,
      id: saved.id,
      idempotencyKey: `${run}:article-replay:publish`,
    };
    const published = await publishApprovedArticle(
      await reqFor(automation),
      publish,
    );
    expect(
      await publishApprovedArticle(await reqFor(automation), publish),
    ).toEqual({ ...published, replayed: true });
    expect(
      await rowsOf(
        sql`SELECT article_id, catalog_id FROM editorial_receipts
            WHERE article_id = ${saved.id} ORDER BY id`,
      ),
    ).toEqual([
      { article_id: saved.id, catalog_id: null },
      { article_id: saved.id, catalog_id: null },
    ]);
  });

  it("replays a receipt from before the column as far as the command can say", async () => {
    const save = {
      idempotencyKey: `${run}:article-old:save`,
      content: articleDraft(`旧回执 ${run}`),
    };
    const saved = await saveArticleDraft(await reqFor(automation), save);
    const { approvalId } = await approveArticleBatch(await reqFor(owner), {
      automationUserId: automation.id,
      items: [{ id: saved.id, revision: saved.revision }],
    });
    const publish = {
      approvalId,
      id: saved.id,
      idempotencyKey: `${run}:article-old:publish`,
    };
    const published = await publishApprovedArticle(
      await reqFor(automation),
      publish,
    );
    await adapter().drizzle.execute(
      sql`UPDATE editorial_receipts SET article_id = NULL WHERE article_id = ${saved.id}`,
    );
    expect(await saveArticleDraft(await reqFor(automation), save)).toEqual({
      ...saved,
      id: 0,
      articleId: "",
      replayed: true,
    });
    expect(
      await publishApprovedArticle(await reqFor(automation), publish),
    ).toEqual({ ...published, replayed: true });
  });

  it("keeps an Article collection on a receipt and answers it from editorial_batch_results", async () => {
    const collection = await payload.create({
      collection: "article-collections",
      req: await reqFor(owner),
      overrideAccess: false,
      draft: true,
      data: { title: `合集 ${run}`, _status: "draft" } as never,
    });
    const key = randomBytes(16).toString("hex");
    await adapter().drizzle.execute(sql`
      INSERT INTO editorial_receipts
        (deduplication_key, request_fingerprint, actor_id, operation, status, article_collection_id, revision, fingerprint)
      VALUES (${key}, ${key}, ${automation.id}, 'publish-approved', 'completed', ${collection.id}, 1, ${key})`);
    const { docs } = await payload.find({
      collection: "editorial-receipts",
      where: { deduplicationKey: { equals: key } },
      depth: 0,
      overrideAccess: false,
      req: await reqFor(automation),
      user: automation,
    });
    expect(docs[0]).toMatchObject({ articleCollection: collection.id });
    expect(docs[0]?.catalog ?? null).toBeNull();
    expect(docs[0]?.article ?? null).toBeNull();
    await withClient(async (call) => {
      const results = (await call("editorial_batch_results", {
        page: 1,
      })) as unknown as { docs: Record<string, unknown>[] };
      expect(results.docs).toContainEqual(
        expect.objectContaining({ articleCollection: collection.id }),
      );
    });
  });
});

describe.sequential("a publish retried under a new key", () => {
  it("answers ALREADY_PUBLISHED on a Catalog, and APPROVED_REVISION_CHANGED once the draft moves on", async () => {
    const saved = await saveDraft(await reqFor(automation), {
      idempotencyKey: `${run}:already:create`,
      content: draftFor("already"),
    });
    const { approvalId } = await approveBatch(await reqFor(owner), {
      automationUserId: automation.id,
      items: [{ id: saved.id, revision: saved.revision }],
    });
    const command = {
      approvalId,
      id: saved.id,
      idempotencyKey: `${run}:already:publish`,
    };
    const published = await publishApproved(await reqFor(automation), command);
    const retried = {
      ...command,
      idempotencyKey: `${run}:already:publish-2`,
    };
    const before = await receiptCount();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const answer = (await publishApproved(
        await reqFor(automation),
        retried,
      ).catch((error: unknown) => error)) as {
        code: string;
        replayed?: boolean;
      };
      expect(answer.code).toBe("ALREADY_PUBLISHED");
      expect(answer.replayed).toBeUndefined();
    }
    expect(await receiptCount()).toBe(before);
    // The original key still replays its success.
    expect(await publishApproved(await reqFor(automation), command)).toEqual({
      ...published,
      replayed: true,
    });
    await withClient(async (call) => {
      expect(
        await call("editorial_publish_approved", {
          ...retried,
          idempotencyKey: `${run}:already:publish-3`,
        }),
      ).toEqual({ ok: false, code: "ALREADY_PUBLISHED" });
    });
    await saveDraft(await reqFor(automation), {
      id: saved.id,
      expectedRevision: published.revision,
      idempotencyKey: `${run}:already:edit`,
      content: { ...draftFor("already"), title: "Moved on after publication" },
    });
    await expect(
      publishApproved(await reqFor(automation), {
        ...command,
        idempotencyKey: `${run}:already:publish-4`,
      }),
    ).rejects.toMatchObject({ code: "APPROVED_REVISION_CHANGED" });
  });

  it("answers ALREADY_PUBLISHED on an Article, and APPROVED_REVISION_CHANGED once the draft moves on", async () => {
    const content = articleDraft(`已发布 ${run}`);
    const saved = await saveArticleDraft(await reqFor(automation), {
      idempotencyKey: `${run}:article-already:create`,
      content,
    });
    const { approvalId } = await approveArticleBatch(await reqFor(owner), {
      automationUserId: automation.id,
      items: [{ id: saved.id, revision: saved.revision }],
    });
    const command = {
      approvalId,
      id: saved.id,
      idempotencyKey: `${run}:article-already:publish`,
    };
    const published = await publishApprovedArticle(
      await reqFor(automation),
      command,
    );
    await expect(
      publishApprovedArticle(await reqFor(automation), {
        ...command,
        idempotencyKey: `${run}:article-already:publish-2`,
      }),
    ).rejects.toMatchObject({ code: "ALREADY_PUBLISHED" });
    await saveArticleDraft(await reqFor(automation), {
      id: saved.id,
      expectedRevision: published.revision,
      idempotencyKey: `${run}:article-already:edit`,
      content: { ...content, summary: "发布之后的修改" },
    });
    await expect(
      publishApprovedArticle(await reqFor(automation), {
        ...command,
        idempotencyKey: `${run}:article-already:publish-3`,
      }),
    ).rejects.toMatchObject({ code: "APPROVED_REVISION_CHANGED" });
  });
});

describe.sequential("a draft save reports what it superseded", () => {
  it("names the prepared intent it ended, over JSON-RPC, and only that save does", async () => {
    const draft = await draftWithMedia("superseded");
    const { intentId } = await prepareCatalogDelivery(await reqFor(owner), {
      id: draft.id,
      expectedRevision: draft.revision,
      expectedFingerprint: draft.fingerprint,
      idempotencyKey: `${run}:superseded:prepare`,
    });
    const content = {
      ...(await readDraft(await reqFor(automation), { id: draft.id })).content,
      title: "Edited after prepare",
    };
    await withClient(async (call) => {
      const args = {
        id: draft.id,
        expectedRevision: draft.revision,
        idempotencyKey: `${run}:superseded:edit`,
        content,
      };
      const saved = await call("editorial_save_draft", args);
      expect(saved).toMatchObject({
        revision: draft.revision + 1,
        replayed: false,
        supersededIntents: [intentId],
      });
      expect(
        (await readCatalogDelivery(await reqFor(owner), { intentId })).state,
      ).toBe("superseded");
      // A receipt does not keep them, so a replay does not claim any.
      const replayed = await call("editorial_save_draft", args);
      expect(replayed).toMatchObject({ replayed: true });
      expect(replayed).not.toHaveProperty("supersededIntents");
      const next = await call("editorial_save_draft", {
        id: draft.id,
        expectedRevision: draft.revision + 1,
        idempotencyKey: `${run}:superseded:edit-2`,
        content: { ...content, title: "Edited again" },
      });
      expect(next).toMatchObject({ replayed: false });
      expect(next).not.toHaveProperty("supersededIntents");
    });
  });
});

describe.sequential("duplicate over REST", () => {
  const session = () => ({
    cookie: `payload-token=${ownerToken}`,
    origin: server.origin,
  });

  const mediaCount = async () =>
    (await payload.count({ collection: "media", overrideAccess: true }))
      .totalDocs;

  it("refuses POST /:id/duplicate on both approval collections, for every Owner credential, and adds nothing", async () => {
    const saved = await saveDraft(await reqFor(owner), {
      idempotencyKey: `${run}:duplicate:catalog`,
      content: draftFor("duplicate"),
    });
    const article = await saveArticleDraft(await reqFor(owner), {
      idempotencyKey: `${run}:duplicate:article`,
      content: articleDraft(`副本 ${run}`),
    });
    const catalogApproval = await approveBatch(await reqFor(owner), {
      automationUserId: automation.id,
      items: [{ id: saved.id, revision: saved.revision }],
    });
    const articleApproval = await approveArticleBatch(await reqFor(owner), {
      automationUserId: automation.id,
      items: [{ id: article.id, revision: article.revision }],
    });
    for (const [collection, id] of [
      ["editorial-approvals", catalogApproval.approvalId],
      ["editorial-article-approvals", articleApproval.approvalId],
    ] as const) {
      const before = (await payload.count({ collection, overrideAccess: true }))
        .totalDocs;
      for (const [label, headers] of [
        ["a cookie session", session()],
        ["a JWT in a header", jwtHeader(ownerToken)],
      ] as const) {
        const answer = await restPost(
          `${collection}/${id}/duplicate`,
          {},
          headers,
        );
        expect([collection, label, answer.status]).toEqual([
          collection,
          label,
          403,
        ]);
        expect(await answer.text()).toContain("APPROVAL_DUPLICATE_DISABLED");
      }
      expect(
        (await payload.count({ collection, overrideAccess: true })).totalDocs,
      ).toBe(before);
    }
    // Single edits by the Owner still work: an approval can still be revoked.
    const revoked = await fetch(
      new URL(
        `/api/editorial-approvals/${catalogApproval.approvalId}`,
        server.origin,
      ),
      {
        method: "PATCH",
        headers: { "content-type": "application/json", ...session() },
        body: JSON.stringify({ status: "revoked" }),
      },
    );
    expect(revoked.status).toBe(200);
  });

  it("refuses POST /:id/duplicate on media too, for every Owner credential, and adds nothing", async () => {
    const draft = await draftWithMedia("superseded-media");
    expect(draft.id).toBeGreaterThan(0);
    const { docs } = await payload.find({
      collection: "media",
      where: { catalogId: { equals: catalogId("superseded-media") } },
      depth: 0,
      overrideAccess: true,
    });
    const before = await mediaCount();
    for (const [label, headers] of [
      ["a cookie session", session()],
      ["a JWT in a header", jwtHeader(ownerToken)],
    ] as const) {
      const answer = await restPost(
        `media/${docs[0]!.id}/duplicate`,
        {},
        headers,
      );
      expect([label, answer.status]).toEqual([label, 400]);
      expect(await answer.text()).toContain("MEDIA_TRANSFORM_DISABLED");
    }
    expect(await mediaCount()).toBe(before);
  });
});

describe.sequential("editorial_* keep their field names", () => {
  it("answers the same fields on every tool, over JSON-RPC, with additions only on the receipts list", async () => {
    await withClient(async (call) => {
      const saved = await call("editorial_save_draft", {
        idempotencyKey: `${run}:fields:create`,
        content: draftFor("fields"),
      });
      expect(Object.keys(saved).sort()).toEqual([
        "fingerprint",
        "id",
        "replayed",
        "revision",
      ]);
      const documentId = saved.id as number;
      const { docs } = (await call("editorial_query", {
        page: 1,
        catalogId: catalogId("fields"),
      })) as unknown as { docs: Record<string, unknown>[] };
      expect(Object.keys(docs[0]!).sort()).toEqual([
        "catalogId",
        "id",
        "kind",
        "mediaCount",
        "revision",
        "sourceId",
        "status",
        "title",
      ]);
      // A draft read has never carried a status: its value is absent, not renamed.
      const read = await call("editorial_read", { id: documentId });
      expect(Object.keys(read).sort()).toEqual([
        "catalogId",
        "id",
        "kind",
        "mediaCount",
        "revision",
        "sourceId",
        "title",
      ]);
      const field = await call("editorial_read", {
        id: documentId,
        field: "transcription",
      });
      expect(Object.keys(field).sort()).toEqual(
        [...Object.keys(read), "field", "offset", "text", "totalLength"].sort(),
      );
      const { approvalId } = await approveBatch(await reqFor(owner), {
        automationUserId: automation.id,
        items: [{ id: documentId, revision: Number(read.revision) }],
      });
      const published = await call("editorial_publish_approved", {
        approvalId,
        id: documentId,
        idempotencyKey: `${run}:fields:publish`,
      });
      expect(Object.keys(published).sort()).toEqual([
        "fingerprint",
        "id",
        "replayed",
        "revision",
      ]);
      const results = (await call("editorial_batch_results", {
        page: 1,
      })) as unknown as { totalDocs: number; docs: Record<string, unknown>[] };
      expect(results.totalDocs).toBeGreaterThan(0);
      expect(Object.keys(results.docs[0]!).sort()).toEqual([
        "article",
        "articleCollection",
        "catalog",
        "id",
        "operation",
        "outcome",
        "revision",
      ]);
    });
  });
});
